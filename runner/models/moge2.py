"""MoGe-2 (ViT-L): the metric depth of a picture, for the guides of runner.video.camera_warp.

Written after the architecture and the inference of [MoGe](https://github.com/microsoft/MoGe)
(`moge/model/v2.py`, `moge/model/modules/*.py`, `moge/utils/geometry_torch.py`,
`moge/utils/geometry_numpy.py`) — MIT License, Copyright (c) Microsoft Corporation — and of its
DINOv2 ViT-L/14 encoder (`dinov2/models/vision_transformer.py`, `dinov2/layers/*.py`) — Apache
License 2.0, Copyright (c) Meta Platforms, Inc. and affiliates. Changes: only what gives the depth
is kept (no normals); the encoder computes in half precision on the GPU, the rest in single; the
focal length and the shift of the point map are found by a one-dimensional least squares of our own
(scipy is not part of the engine), carried to convergence where MoGe stops at a relative change of
1e-3.

The weights: `geometry_estimation/moge_2_vitl_normal_fp16.safetensors` of `Comfy-Org/MoGe`, the
tensors of `Ruicheng/moge-2-vitl-normal` under their own names.
"""

import math

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

# MoGe's default: its resolution level 9 of 0 to 9, from 1 200 to 3 600 tokens.
TOKENS = 3600
WIDTHS = (1024, 256, 128, 64, 32)
RESAMPLERS = ('conv_transpose', 'conv_transpose', 'conv_transpose', 'bilinear')
VIT_L = dict(dim=1024, depth=24, heads=16, layers=(5, 11, 17, 23), widths=WIDTHS)
PATCH = 14
# The grid DINOv2's positions were learned on (518 pixels / 14).
GRID = 37


class Attention(nn.Module):
    def __init__(self, dim, heads):
        super().__init__()
        self.heads = heads
        self.qkv = nn.Linear(dim, dim * 3)
        self.proj = nn.Linear(dim, dim)

    def forward(self, x):
        batch, tokens, dim = x.shape
        q, k, v = self.qkv(x).reshape(batch, tokens, 3, self.heads, dim // self.heads).permute(2, 0, 3, 1, 4)
        x = F.scaled_dot_product_attention(q, k, v)
        return self.proj(x.transpose(1, 2).reshape(batch, tokens, dim))


class Mlp(nn.Module):
    def __init__(self, dim, hidden):
        super().__init__()
        self.fc1 = nn.Linear(dim, hidden)
        self.fc2 = nn.Linear(hidden, dim)

    def forward(self, x):
        return self.fc2(F.gelu(self.fc1(x)))


class LayerScale(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return x * self.gamma


class Block(nn.Module):
    def __init__(self, dim, heads):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim, eps=1e-6)
        self.attn = Attention(dim, heads)
        self.ls1 = LayerScale(dim)
        self.norm2 = nn.LayerNorm(dim, eps=1e-6)
        self.mlp = Mlp(dim, dim * 4)
        self.ls2 = LayerScale(dim)

    def forward(self, x):
        x = x + self.ls1(self.attn(self.norm1(x)))
        return x + self.ls2(self.mlp(self.norm2(x)))


class PatchEmbed(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.proj = nn.Conv2d(3, dim, PATCH, PATCH)

    def forward(self, x):
        return self.proj(x).flatten(2).transpose(1, 2)


class Backbone(nn.Module):
    """DINOv2's ViT with its LayerScale, without registers."""

    def __init__(self, dim, depth, heads):
        super().__init__()
        self.patch_embed = PatchEmbed(dim)
        self.cls_token = nn.Parameter(torch.zeros(1, 1, dim))
        self.pos_embed = nn.Parameter(torch.zeros(1, GRID * GRID + 1, dim))
        self.blocks = nn.ModuleList(Block(dim, heads) for _ in range(depth))
        self.norm = nn.LayerNorm(dim, eps=1e-6)

    def positions(self, rows, columns, dtype):
        """The learned positions for a grid of rows × columns patches, the class token's first."""
        if rows == columns == GRID:
            return self.pos_embed.to(dtype)
        embed = self.pos_embed.float()
        grid = embed[:, 1:].reshape(1, GRID, GRID, -1).permute(0, 3, 1, 2)
        # As DINOv2 does: bicubic, with a scale a tenth of a patch larger than the grid asks
        # (its `interpolate_offset`), so that the size it gives is the one asked.
        scale = ((rows + 0.1) / GRID, (columns + 0.1) / GRID)
        grid = F.interpolate(grid, scale_factor=scale, mode='bicubic', antialias=False)
        if tuple(grid.shape[-2:]) != (rows, columns):
            raise ValueError('Unexpected size of the interpolated positions')
        grid = grid.permute(0, 2, 3, 1).flatten(1, 2)
        return torch.cat((embed[:, :1], grid), dim=1).to(dtype)

    def layers(self, image, wanted):
        """The tokens after each block of `wanted`, normalized as the last block's are."""
        rows, columns = image.shape[-2] // PATCH, image.shape[-1] // PATCH
        x = self.patch_embed(image)
        x = torch.cat((self.cls_token.to(x.dtype).expand(x.shape[0], -1, -1), x), dim=1)
        x = x + self.positions(rows, columns, x.dtype)
        found = []
        for index, block in enumerate(self.blocks):
            x = block(x)
            if index in wanted:
                found.append(self.norm(x))
        return found


class Encoder(nn.Module):
    def __init__(self, dim, depth, heads, layers, out):
        super().__init__()
        self.wanted = tuple(layers)
        self.backbone = Backbone(dim, depth, heads)
        self.output_projections = nn.ModuleList(nn.Conv2d(dim, out, 1) for _ in layers)
        self.register_buffer('image_mean', torch.zeros(1, 3, 1, 1))
        self.register_buffer('image_std', torch.ones(1, 3, 1, 1))

    def forward(self, image, rows, columns):
        """`image` [B, 3, H, W] in [0, 1]: its features [B, out, rows, columns] and class token."""
        size = (rows * PATCH, columns * PATCH)
        image = F.interpolate(image, size, mode='bilinear', align_corners=False, antialias=True)
        image = (image - self.image_mean.float()) / self.image_std.float()
        found = self.backbone.layers(image.to(self.backbone.pos_embed.dtype), self.wanted)
        dtype = self.output_projections[0].weight.dtype
        features = sum(
            projection(layer[:, 1:].transpose(1, 2).unflatten(2, (rows, columns)).to(dtype))
            for projection, layer in zip(self.output_projections, found)
        )
        return features, found[-1][:, 0].to(dtype)


class ResidualBlock(nn.Module):
    """Two (ReLU, 3 × 3 convolution), added to the input: MoGe-2's residual blocks have no norm."""

    def __init__(self, channels):
        super().__init__()
        self.layers = nn.Sequential(
            nn.Identity(),
            nn.ReLU(),
            nn.Conv2d(channels, channels, 3, padding=1, padding_mode='replicate'),
            nn.Identity(),
            nn.ReLU(),
            nn.Conv2d(channels, channels, 3, padding=1, padding_mode='replicate'),
        )

    def forward(self, x):
        return x + self.layers(x)


def resampler(kind, channels, following):
    """Twice the size: a 2 × 2 transposed convolution or a bilinear scaling, then a 3 × 3 one."""
    if kind == 'conv_transpose':
        return nn.Sequential(
            nn.ConvTranspose2d(channels, following, 2, stride=2),
            nn.Conv2d(following, following, 3, padding=1, padding_mode='replicate'),
        )
    return nn.Sequential(
        nn.Upsample(scale_factor=2, mode='bilinear', align_corners=False),
        nn.Conv2d(channels, following, 3, padding=1, padding_mode='replicate'),
    )


class ConvStack(nn.Module):
    """Five levels, each twice the size of the one before: what comes in at a level is added to
    what the level before gave, goes through its residual blocks and out (a 1 × 1 projection, or
    as it is)."""

    def __init__(self, inputs, outputs, blocks, widths):
        super().__init__()
        self.input_blocks = nn.ModuleList(nn.Conv2d(given, width, 1) for given, width in zip(inputs, widths))
        self.resamplers = nn.ModuleList(
            resampler(kind, width, following) for kind, width, following in zip(RESAMPLERS, widths[:-1], widths[1:])
        )
        self.res_blocks = nn.ModuleList(
            nn.Sequential(*(ResidualBlock(width) for _ in range(count))) for width, count in zip(widths, blocks)
        )
        self.output_blocks = nn.ModuleList(
            nn.Conv2d(width, out, 1) if out else nn.Identity() for width, out in zip(widths, outputs)
        )

    def forward(self, features):
        found = []
        for level, given in enumerate(features):
            feature = self.input_blocks[level](given)
            x = feature if level == 0 else x + feature
            x = self.res_blocks[level](x)
            found.append(self.output_blocks[level](x))
            if level < len(features) - 1:
                x = self.resamplers[level](x)
        return found


def view_plane(width, height, aspect, device=None):
    """The coordinates of a grid of width × height cells on the view plane, [height, width, 2]:
    its corners at ± (W, H) / diagonal of a picture of this `aspect`, cell centres."""
    span_x = aspect / (1 + aspect**2) ** 0.5
    span_y = 1 / (1 + aspect**2) ** 0.5
    u = torch.linspace(-span_x * (width - 1) / width, span_x * (width - 1) / width, width, device=device)
    v = torch.linspace(-span_y * (height - 1) / height, span_y * (height - 1) / height, height, device=device)
    u, v = torch.meshgrid(u, v, indexing='xy')
    return torch.stack((u, v), dim=-1)


class MoGe2(nn.Module):
    def __init__(self, dim=1024, depth=24, heads=16, layers=VIT_L['layers'], widths=WIDTHS):
        super().__init__()
        heads_blocks = (0, 1, 1, 1, 0)
        self.encoder = Encoder(dim, depth, heads, layers, widths[0])
        self.neck = ConvStack((widths[0] + 2, 2, 2, 2, 2), (None,) * 5, (0, 2, 2, 2, 0), widths)
        self.points_head = ConvStack(widths, (None, None, None, None, 3), heads_blocks, widths)
        self.mask_head = ConvStack(widths, (None, None, None, None, 1), heads_blocks, widths)
        self.scale_head = nn.Sequential(
            nn.Linear(widths[0], widths[0]),
            nn.ReLU(),
            nn.Linear(widths[0], widths[0]),
            nn.ReLU(),
            nn.Linear(widths[0], 1),
        )

    def forward(self, image, tokens=TOKENS):
        """`image` [B, 3, H, W] in [0, 1]: its point map [B, H, W, 3] up to a shift of z, the mask
        of what has a depth [B, H, W] (0 to 1) and the metric scale [B]."""
        batch, _, height, width = image.shape
        aspect = width / height
        rows, columns = round((tokens / aspect) ** 0.5), round((tokens * aspect) ** 0.5)
        features, token = self.encoder(image, rows, columns)
        levels = []
        for level in range(5):
            uv = view_plane(columns * 2**level, rows * 2**level, aspect, image.device)
            uv = uv.permute(2, 0, 1).unsqueeze(0).expand(batch, -1, -1, -1).to(features.dtype)
            levels.append(torch.cat((features, uv), dim=1) if level == 0 else uv)
        levels = self.neck(levels)
        points = self.points_head(levels)[-1]
        mask = self.mask_head(levels)[-1]
        scale = self.scale_head(token).squeeze(1).exp()
        points = F.interpolate(points, (height, width), mode='bilinear', align_corners=False)
        mask = F.interpolate(mask, (height, width), mode='bilinear', align_corners=False)
        xy, z = points.permute(0, 2, 3, 1).split((2, 1), dim=-1)
        z = z.exp()
        return torch.cat((xy * z, z), dim=-1), mask.squeeze(1).sigmoid(), scale


def load(path, device='cuda', config=None):
    """The model of a MoGe-2 file, its encoder in half precision on the GPU (single elsewhere)."""
    from safetensors.torch import load_file

    weights = load_file(str(path))
    # Its normals and the mask token of DINOv2's training are not used.
    weights = {
        key: value
        for key, value in weights.items()
        if not key.startswith('normal_head.') and key != 'encoder.backbone.mask_token'
    }
    with torch.device('meta'):
        model = MoGe2(**(config or {}))
    expected = {key: list(value.shape) for key, value in model.state_dict().items()}
    found = {key: list(value.shape) for key, value in weights.items()}
    missing = sorted(expected.keys() - found.keys())
    unexpected = sorted(found.keys() - expected.keys())
    wrong = sorted(key for key in expected.keys() & found.keys() if expected[key] != found[key])
    if missing or wrong or unexpected:
        raise ValueError('Not a MoGe-2 checkpoint of this layout: ' + (missing + wrong + unexpected)[0])
    model.load_state_dict(weights, strict=True, assign=True)
    encoder = torch.float16 if torch.device(device).type == 'cuda' else torch.float32
    model.float()
    model.encoder.backbone.to(encoder)
    return model.to(device).eval()


def focal_shift(points, mask, size=(64, 64)):
    """MoGe's recovery of the lens and of the shift of z from a point map [H, W, 3] and the mask
    of its valid points [H, W]: (focal relative to half the diagonal, shift). Both read on a grid
    of `size`, the nearest points kept."""
    height, width = points.shape[:2]
    uv = view_plane(width, height, width / height, points.device)
    small = F.interpolate(points.permute(2, 0, 1)[None].float(), size, mode='nearest')[0].permute(1, 2, 0)
    grid = F.interpolate(uv.permute(2, 0, 1)[None], size, mode='nearest')[0].permute(1, 2, 0)
    kept = F.interpolate(mask[None, None].float(), size, mode='nearest')[0, 0] > 0
    small, grid = small[kept].cpu().double().numpy(), grid[kept].cpu().double().numpy()
    if small.shape[0] < 2:
        return 1.0, 0.0
    shift, focal = solve(grid, small)
    return focal, shift


def solve(uv, xyz, focal=None, steps=200):
    """The shift s (and the focal f, unless given) that make f · xy / (z + s) closest to `uv`, in
    the least squares: (s, f). For a given shift the best focal is found directly, so the search is
    on the shift alone: Gauss-Newton steps from 0, halved while they would not lower the error or
    would put a point behind the camera."""
    uv = uv.reshape(-1, 2)
    xy, z = xyz[..., :2].reshape(-1, 2), xyz[..., 2].reshape(-1)

    def state(shift):
        projected = xy / (z + shift)[:, None]
        best = focal if focal is not None else (projected * uv).sum() / np.square(projected).sum()
        residual = best * projected - uv
        return best, projected, residual, float(np.square(residual).sum())

    shift = 0.0
    best, projected, residual, error = state(shift)
    for _ in range(steps):
        moved = -projected / (z + shift)[:, None]
        change = 0.0
        if focal is None:
            along, norm = (projected * uv).sum(), np.square(projected).sum()
            change = ((moved * uv).sum() * norm - along * 2 * (projected * moved).sum()) / norm**2
        slope = change * projected + best * moved
        curvature = float(np.square(slope).sum())
        if curvature <= 0:
            break
        step = -float((slope * residual).sum()) / curvature
        for _ in range(60):
            candidate = shift + step
            if np.all(z + candidate > 0):
                found = state(candidate)
                if found[3] <= error:
                    break
            step /= 2
        else:
            break
        done = abs(step) <= 1e-12 * (1 + abs(shift)) or error - found[3] <= 1e-15 * max(error, 1e-300)
        shift = candidate
        best, projected, residual, error = found
        if done:
            break
    return shift, best


def hfov_of(focal, aspect):
    """The width of the lens, in degrees across, of a focal relative to half the diagonal on a
    picture of this `aspect` (width / height): MoGe's own intrinsics."""
    fx = focal / 2 * (1 + aspect**2) ** 0.5 / aspect
    return math.degrees(2 * math.atan(1 / (2 * fx)))


@torch.inference_mode()
def estimate(model, frame, tokens=TOKENS):
    """The metric depth of `frame` [H, W, 3] uint8: depth [H, W] float32 (NaN where MoGe sees
    none: the sky), MoGe's own estimate of the lens (`hfov`, degrees across), the metric scale,
    focal (relative to half the diagonal) and shift."""
    device = next(model.parameters()).device
    height, width = frame.shape[:2]
    image = torch.from_numpy(np.ascontiguousarray(frame)).to(device).permute(2, 0, 1)[None].float() / 255
    points, mask, scale = model(image, tokens)
    points, mask = points[0].float(), mask[0] > 0.5
    focal, shift = focal_shift(points, mask)
    depth = points[..., 2] + shift
    mask &= depth > 0
    depth = torch.where(mask, depth * scale[0].float(), torch.full_like(depth, float('nan')))
    return dict(
        depth=depth.cpu().numpy().astype(np.float32),
        hfov=hfov_of(focal, width / height),
        scale=float(scale[0]),
        focal=float(focal),
        shift=float(shift),
    )
