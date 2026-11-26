"""pi H3's pixel head (« DWD »): the rows of the generated video, as the 50 blocks of MiniMax-H3 leave them at the
last step, turned into pixels without the video VAE.

The pi H3 adapters « …_dwd_adapter… » (pi-Flow, Hansheng Chen) carry this head beside their step weights: eight
layers of the Sol-H3 video VAE's ViT decoder, fed with each DiT token projected onto 2 x 2 tokens of that decoder,
then the decoder's own norm and pixel projections. Written after ComfyUI-piFlow
(`modules/architectures/minimax_h3_dwd.py`, `dwd_head.py`, `sol_h3.py`) — Apache License 2.0, Copyright (c)
2025-2026 Hansheng Chen — for what comes from it: the norm the rows go through first (a LayerNorm without weights,
modulated by linear(silu(t)), the scale before the shift: the reverse of the DiT's own final norm), the expansion
of a DiT token into its 2 x 2 decoder tokens, and where the pixels of each decoder token go (one frame for the
first latent of a block, four for each of the others). A layer is diffusers' MiniMaxH3VideoTransformerBlock
(Apache-2.0): RMS norms, the queries, keys and values of each head side by side in one projection, queries and
keys of unit RMS turned on 48 of their 64 channels, a SwiGLU feed-forward, each branch scaled channel by channel.
Its attention is the decoder's windowed one, written from its rules, set down as formulas beforehand:
- the rows go by blocks of five latents: each block's tokens in (time, row, column) order, then its five global
  rows (the four register tokens and a row of zeros), which attend to their whole block;
- a token attends to the tokens of its window, 5 latents x 16 x 16 tokens, and to the global rows of the one or
  two blocks that window touches; on every other layer the windows start 2 latents and 8 tokens earlier;
- positions are counted within the window; the global rows are at 0.

On the card the layers go through the blocks in order, two at a time: the queries, keys and values of a block are
written straight to the windows they belong to, and a window is computed as soon as its last block is, with
PyTorch's exact attention, the windows of one shape together. Beside the head's 0.6 GiB, the decode then holds
the rows of the video (4 KiB a decoder token) and what two blocks need: 2.5 GiB in all for 5 s at 1344 x 768,
3.6 GiB for 15 s (gib). The whole video at once would hold 3.8 and 8.5 GiB (the study's estimates).
"""

import json
import math
from functools import cached_property
from typing import NamedTuple

import torch
import torch.nn.functional as F
from torch import nn

GiB = 1024**3
PREFIX = 'dwd_pixel_refiner.'
# The tensors of the head in an adapter's file: its input norm, then the rest.
HEAD = ('dwd_norm_out.', PREFIX)
# LakonLab's other kind of pixel head, a linear one (ComfyUI-piFlow does not read it either).
LINEAR_HEAD = ('dwd_linear_head.', 'first_frame_dwd_linear_head.')
# Decoder tokens a DiT token gives along each axis (32 pixels, 16 each); pixels of a decoder token a side, frames
# of a latent, colours.
EXPAND = 2
PATCH, PATCH_T, CHANNELS = 16, 4, 3
# Latents of a block; decoder tokens of a window a side; latents the windows of every other layer start before
# the video (their tokens: half a window).
BLOCK = 5
WINDOW = 16
SHIFT_T = 2
# A block's global rows: its register tokens, then a row of zeros.
REGISTERS = 4
GLOBALS = REGISTERS + 1
THETA = 100.0
EPS = 1e-5
# Rows of a feed-forward at a time: its intermediate (16 384 wide) of a whole block is 0.6 GiB at 1344 x 768.
CHUNK = 8192
# The decoder's pixels are in ImageNet's normalisation (runner.pipelines.minimax_h3, PIXEL_MEAN).
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
# What each INT8 layer says of itself beside its weight (runner.convert writes the same).
NOTE = {'format': 'int8_tensorwise', 'convrot': True, 'convrot_groupsize': 256}
FLOATS = ('F16', 'BF16', 'F32')
# Beside the tensors `gib` counts: the kernels' own buffers and the allocator's rounding.
SLACK_GIB = 0.25


class Dims(NamedTuple):
    """The widths of the head: those of pi H3's file, smaller in the tests."""

    width: int = 2048
    heads: int = 32
    # The feed-forward's inner width: its first layer gives twice that (gate, then value).
    ffn: int = 8192
    layers: int = 8
    # A row of the DiT, and its time embedding (the AdaLN curve of runner.models.minimax_h3).
    features: int = 5376
    time: int = 8

    @property
    def head(self):
        return self.width // self.heads

    @property
    def rotary(self):
        """The channels of a head that turn: three quarters, an even count of frequencies for each axis."""
        return self.head * 3 // 4


DIMS = Dims()


def quantised(dims=DIMS):
    """[(name, rows, columns)] of the four INT8 layers of a layer."""
    width, ffn = dims.width, dims.ffn
    return [
        ('attn.to_qkv', 3 * width, width),
        ('attn.to_out', width, width),
        ('ff.w1', 2 * ffn, width),
        ('ff.w2', width, ffn),
    ]


def expected(dims=DIMS):
    """{key: (dtypes, shape)} of the head's tensors in an adapter's file; the shape None for a note."""
    width, features, pixels = dims.width, dims.features, CHANNELS * PATCH * PATCH
    found = {
        'dwd_norm_out.linear.weight': (FLOATS, [2 * features, dims.time]),
        'dwd_norm_out.linear.bias': (FLOATS, [2 * features]),
        PREFIX + 'feature_expand.weight': (FLOATS, [EXPAND * EXPAND * width, features]),
        PREFIX + 'feature_expand.bias': (FLOATS, [EXPAND * EXPAND * width]),
        PREFIX + 'register_tokens': (FLOATS, [1, REGISTERS, width]),
        PREFIX + 'norm_out.weight': (FLOATS, [width]),
        PREFIX + 'norm_out.bias': (FLOATS, [width]),
        PREFIX + 'first_frame_proj_out.weight': (FLOATS, [pixels, width]),
        PREFIX + 'first_frame_proj_out.bias': (FLOATS, [pixels]),
        PREFIX + 'proj_out.weight': (FLOATS, [PATCH_T * pixels, width]),
        PREFIX + 'proj_out.bias': (FLOATS, [PATCH_T * pixels]),
    }
    for index in range(dims.layers):
        stem = f'{PREFIX}blocks.{index}.'
        for name in ('norm1.weight', 'norm2.weight', 'scale1', 'scale2'):
            found[stem + name] = (FLOATS, [width])
        for name, rows, columns in quantised(dims):
            found[stem + name + '.weight'] = (('I8',), [rows, columns])
            found[stem + name + '.weight_scale'] = (('F32',), [rows, 1])
            found[stem + name + '.bias'] = (FLOATS, [rows])
            found[stem + name + '.comfy_quant'] = (('U8',), None)
    return found


def validate(header, store=None):
    """Raise, in the user's words, unless the adapter whose header this is (runner.models.headers.header) has the
    pixel head read here: every tensor of § 1.1 of the study, of its shape and type, and nothing else under its
    names. With `store` (the file open), what each INT8 layer says of its quantization is read too (72 bytes
    each; the header gives only their size): ConvRot by groups of 256, as the kernel is asked to compute.

    The pi H3 adapters without the head (« pi_h3_4step_adapter… ») give latents for the video VAE: they are not
    read."""
    ours = [key for key in header if key.startswith(HEAD)]
    if any(key.startswith(LINEAR_HEAD) for key in header):
        raise ValueError(
            'La tête DWD de cet adaptateur est une tête linéaire (« dwd_linear_head ») : Moodix ne lit que celle '
            'de pi H3, « dwd_pixel_refiner ».'
        )
    if not ours:
        raise ValueError(
            'Cet adaptateur pi H3 n’a pas de tête DWD : Moodix ne lit que les adaptateurs qui en ont une '
            '(« pi_h3_4step_dwd_adapter… »), pas ceux qui laissent l’image au décodeur vidéo '
            '(« pi_h3_4step_adapter… »).'
        )

    def wrong(why):
        return ValueError('La tête DWD de cet adaptateur n’est pas celle de pi H3 que Moodix sait lire : ' + why + '.')

    wanted = expected()
    extra = sorted(set(ours) - set(wanted))
    if extra:
        raise wrong(f'{extra[0]} est en trop')
    for key, (dtypes, shape) in wanted.items():
        entry = header.get(key)
        if entry is None:
            raise wrong(f'{key} manque')
        if entry['dtype'] not in dtypes:
            raise wrong(f'{key} est en {entry["dtype"]} au lieu de {" ou ".join(dtypes)}')
        found = list(entry['shape'])
        if (found != shape) if shape is not None else (len(found) != 1 or not found[0]):
            raise wrong(f'{key} a la forme {found} au lieu de {shape if shape is not None else "[n]"}')
    if store is None:
        return
    for key in wanted:
        if key.endswith('.comfy_quant'):
            try:
                note = json.loads(store.get_tensor(key).numpy().tobytes())
            except ValueError:
                note = None
            if not isinstance(note, dict) or any(note.get(name) != value for name, value in NOTE.items()):
                raise wrong(f'{key.removesuffix(".comfy_quant")} n’est pas en INT8 ConvRot par groupes de 256')


def spans(length, shift, size):
    """The windows along one axis of `length`, [(start, stop)]: `size` long, the first starting `shift` before 0,
    each cut where it passes either end."""
    found = []
    for index in range(-(-(length + shift) // size)):
        start, stop = max(index * size - shift, 0), min((index + 1) * size - shift, length)
        if stop > start:
            found.append((start, stop))
    return found


def place(position, shift, size):
    """Where a token is along one axis as its layer sees it, in [-1, 1]: its place within its window (`size`
    long, starting `shift` before 0), as diffusers places a token on an axis of that length."""
    return ((position + shift) % size + 0.5) / size * 2 - 1


class Window(NamedTuple):
    """One window of a layer: its spans in time (latents), rows and columns (decoder tokens), the blocks it
    touches (one or two), its queries (rows of the head, in time, row, column order) and its keys (its queries,
    then the global rows of the blocks it touches, block after block)."""

    time: tuple
    y: tuple
    x: tuple
    blocks: tuple
    queries: torch.Tensor
    keys: torch.Tensor


class Geometry:
    """Where the rows of the head are, for a video of `latents` latent frames of `height` x `width` DiT tokens
    (pixels / 32): its blocks of BLOCK latents, the rows of each (tokens, then global rows), the windows of each
    parity of layer and the positions of the rows. `window` is the side of a window in decoder tokens (smaller
    in the tests)."""

    def __init__(self, latents, height, width, window=WINDOW):
        if min(latents, height, width) < 1 or window < 2 or window % 2:
            raise ValueError(f'No pixel head geometry for {latents} x {height} x {width}, window {window}')
        self.grid = (latents, height, width)
        self.window = window
        # (time, rows, columns) of the decoder's tokens.
        self.size = (latents, EXPAND * height, EXPAND * width)
        self.plane = self.size[1] * self.size[2]
        self.blocks = [(start, min(start + BLOCK, latents)) for start in range(0, latents, BLOCK)]
        self.starts = [start * self.plane + GLOBALS * index for index, (start, _stop) in enumerate(self.blocks)]
        self.rows = latents * self.plane + GLOBALS * len(self.blocks)
        # The rows of the longest block: what each of the two blocks on the card may hold.
        self.slot = BLOCK * self.plane + GLOBALS
        # Frames of each block: one for its first latent, PATCH_T for each other.
        self.frames = [1 + PATCH_T * (stop - start - 1) for start, stop in self.blocks]

    def span(self, block):
        """(first, end) of the rows of a block: its tokens, then its GLOBALS global rows."""
        start, stop = self.blocks[block]
        return self.starts[block], self.starts[block] + (stop - start) * self.plane + GLOBALS

    def shifts(self, parity):
        """How far before the video the windows of a layer of that parity start: (latents, tokens)."""
        return (SHIFT_T, self.window // 2) if parity else (0, 0)

    def axes(self, parity):
        """The spans of the windows of that parity: (time, rows, columns)."""
        shift_t, shift = self.shifts(parity)
        _latents, height, width = self.size
        return spans(self.size[0], shift_t, BLOCK), spans(height, shift, self.window), spans(width, shift, self.window)

    def touched(self, time):
        """The blocks a window of that time span has tokens in."""
        first, last = time[0] // BLOCK, (time[1] - 1) // BLOCK
        return (first,) if first == last else (first, last)

    @cached_property
    def windows(self):
        """The windows of each parity of layer: (even, odd), each a list of Window. Built when first asked."""
        return tuple(self._windows(parity) for parity in (0, 1))

    def _windows(self, parity):
        times, rows, columns = self.axes(parity)
        width = self.size[2]
        starts = torch.tensor(self.starts)
        found = []
        for time in times:
            latents = torch.arange(*time)
            blocks = latents // BLOCK
            base = starts[blocks] + (latents - blocks * BLOCK) * self.plane
            touched = self.touched(time)
            extra = torch.cat([torch.arange(self.span(block)[1] - GLOBALS, self.span(block)[1]) for block in touched])
            for y in rows:
                for x in columns:
                    queries = (
                        base[:, None, None] + torch.arange(*y)[None, :, None] * width + torch.arange(*x)[None, None, :]
                    ).flatten()
                    found.append(Window(time, y, x, touched, queries, torch.cat([queries, extra])))
        return found

    def region(self, parity):
        """Rows of the windows whose last block is the same, at the most over the blocks: what each of the two
        sets of windows on the card holds (their keys, one window after the other)."""
        times, rows, columns = self.axes(parity)
        count = len(rows) * len(columns)
        held = {}
        for time in times:
            touched = self.touched(time)
            rows = (time[1] - time[0]) * self.plane + GLOBALS * len(touched) * count
            held[touched[-1]] = held.get(touched[-1], 0) + rows
        return max(held.values())

    def positions(self, parity, block):
        """The (time, row, column) position of each row of a block for the layers of that parity, float32
        [rows, 3]: each token's place in its window; the global rows at 0. The same for every block of that
        length, which starts on a multiple of BLOCK."""
        start, stop = self.blocks[block]
        shift_t, shift = self.shifts(parity)
        _latents, height, width = self.size
        grids = torch.meshgrid(
            place(torch.arange(start, stop), shift_t, BLOCK),
            place(torch.arange(height), shift, self.window),
            place(torch.arange(width), shift, self.window),
            indexing='ij',
        )
        tokens = torch.stack(grids, dim=-1).reshape(-1, 3).float()
        return torch.cat([tokens, tokens.new_zeros(GLOBALS, 3)])


def rotation(positions, rotary):
    """comfy-kitchen's split-half rotation table, (1, rows, 1, rotary / 2, 2, 2) float32 [[cos, -sin], [sin, cos]],
    for `positions` [rows, 3]: the angles of diffusers' MiniMaxH3VideoRotaryPosEmbed, 2 pi · position · THETA^(-k/n)
    for k < n = rotary / 6, axis after axis (the same table as runner.models.minimax_h3.rotation_table)."""
    count = rotary // 6
    inverse = THETA ** (-torch.arange(count, dtype=torch.float32, device=positions.device) / count)
    angles = (2 * math.pi * positions.float()[:, :, None] * inverse).flatten(1)
    cos, sin = angles.cos(), angles.sin()
    return torch.stack([torch.stack([cos, -sin], dim=-1), torch.stack([sin, cos], dim=-1)], dim=-2)[None, :, None]


class Plan(NamedTuple):
    """How the windows of one parity run, block after block (see refine): the rows of each set of windows
    (`region`); for each block, where its tokens go (`tokens`, a row of the regions each) and its global rows (its
    `copies` windows, `globals`), the windows it completes (`groups`: (first row, windows, queries, keys,
    where their answers go)) and the blocks whose every window is computed after it (`finished`)."""

    region: int
    tokens: list
    copies: list
    globals: list
    groups: list
    finished: list


def plan(geometry, parity, device='cpu'):
    """The Plan of the windows of one parity (Geometry.windows): those of one last block in a set of rows of
    their own (the even and odd blocks have one each), grouped by shape, each window's keys one after the other,
    its queries first; the answers in the rows of two blocks, a block's at the place its parity gives it."""
    count = len(geometry.blocks)
    size = geometry.region(parity)
    by_last = [[] for _ in range(count)]
    for window in geometry.windows[parity]:
        by_last[window.blocks[-1]].append(window)
    ring = torch.empty(geometry.rows, dtype=torch.long)
    for block in range(count):
        first, end = geometry.span(block)
        ring[first:end] = (block % 2) * geometry.slot + torch.arange(end - first)
    target = torch.full((geometry.rows,), -1, dtype=torch.long)
    copies, spread, groups, done = [0] * count, [[] for _ in range(count)], [[] for _ in range(count)], [0] * count
    for last, windows in enumerate(by_last):
        shapes = {}
        for window in windows:
            shapes.setdefault((len(window.queries), len(window.keys)), []).append(window)
        offset = (last % 2) * size
        for (queries, keys), members in shapes.items():
            answers = []
            for index, window in enumerate(members):
                first = offset + index * keys
                target[window.queries] = first + torch.arange(queries)
                for order, block in enumerate(window.blocks):
                    spread[block].append(first + queries + order * GLOBALS + torch.arange(GLOBALS))
                    copies[block] += 1
                    done[block] = max(done[block], last)
                answers.append(ring[window.queries])
            groups[last].append((offset, len(members), queries, keys, torch.cat(answers).to(device)))
            offset += len(members) * keys
        if offset > (last % 2) * size + size:
            raise AssertionError('pixel head windows past their rows')
    tokens = []
    for block in range(count):
        first, end = geometry.span(block)
        found = target[first : end - GLOBALS]
        if bool((found < 0).any()):
            raise AssertionError('a token of the pixel head in no window')
        tokens.append(found.to(device))
    return Plan(
        size,
        tokens,
        copies,
        [torch.cat(found).to(device) for found in spread],
        groups,
        [[block for block in range(count) if done[block] == step] for step in range(count)],
    )


class Attention(nn.Module):
    def __init__(self, dims):
        super().__init__()
        self.to_qkv = nn.Linear(dims.width, 3 * dims.width)
        self.to_out = nn.Linear(dims.width, dims.width)


class FeedForward(nn.Module):
    def __init__(self, dims):
        super().__init__()
        # [gate; value] rows, as the file stores them.
        self.w1 = nn.Linear(dims.width, 2 * dims.ffn)
        self.w2 = nn.Linear(dims.ffn, dims.width)


class Block(nn.Module):
    def __init__(self, dims):
        super().__init__()
        self.norm1 = nn.RMSNorm(dims.width, eps=EPS)
        self.attn = Attention(dims)
        self.scale1 = nn.Parameter(torch.zeros(dims.width))
        self.norm2 = nn.RMSNorm(dims.width, eps=EPS)
        self.ff = FeedForward(dims)
        self.scale2 = nn.Parameter(torch.zeros(dims.width))


class Head(nn.Module):
    """The head, its modules named as the file names them below PREFIX. Its compute precision is that of
    `feature_expand` (bfloat16 once loaded); its linear layers in `blocks` are those of the pool once loaded,
    plain ones in the tests."""

    def __init__(self, dims=DIMS):
        super().__init__()
        self.dims = dims
        # The input norm's modulation (`dwd_norm_out.linear`), kept in float32: it reads a few times only.
        self.modulation = nn.Linear(dims.time, 2 * dims.features)
        self.feature_expand = nn.Linear(dims.features, EXPAND * EXPAND * dims.width)
        self.register_tokens = nn.Parameter(torch.zeros(REGISTERS, dims.width))
        self.blocks = nn.ModuleList(Block(dims) for _ in range(dims.layers))
        self.norm_out = nn.LayerNorm(dims.width, eps=EPS)
        self.first_frame_proj_out = nn.Linear(dims.width, CHANNELS * PATCH * PATCH)
        self.proj_out = nn.Linear(dims.width, CHANNELS * PATCH_T * PATCH * PATCH)
        self.pool = None

    def release(self):
        """Take the head off the card: its INT8 layers (its pool), then the rest of its weights."""
        if self.pool is not None:
            self.pool.clear()
            self.pool = None
        self.to_empty(device='meta')


def quantised_bytes(dims=DIMS):
    """Bytes of the INT8 layers on the card: each weight, its scale (float32) and its bias (16-bit in the file,
    counted as 32 at the most)."""
    return dims.layers * sum(rows * columns + rows * 8 for _name, rows, columns in quantised(dims))


def plain_bytes(dims=DIMS):
    """Bytes of the head's other weights on the card, in bfloat16 (the input norm's in float32)."""
    width, pixels = dims.width, CHANNELS * PATCH * PATCH
    expand = EXPAND * EXPAND * width * (dims.features + 1)
    projections = (1 + PATCH_T) * pixels * (width + 1)
    small = (2 + REGISTERS + 4 * dims.layers) * width
    return 2 * (expand + projections + small) + 4 * 2 * dims.features * (dims.time + 1)


def load(store):
    """The head on the card, read from `store`: the adapter's file as the engine opened it for the DiT (its
    store under runner.models.minimax_h3.ADAPTER). The four INT8 layers of each layer stay in the format of the
    file, in a pool of their own whose share holds them all (runner.models.pool, load_streamed: comfy-kitchen's
    INT8 ConvRot kernel); the rest is turned into bfloat16 on the card. All of it stays there until
    Head.release."""
    from runner.models.pool import WeightPool, load_streamed

    with torch.device('meta'):
        head = Head()
    source = 'head'
    pool = WeightPool({source: store}, quantised_bytes() / GiB)
    head.pool = pool
    try:
        names = {name: (source, f'{PREFIX}blocks.{name}', None) for name, _ in head.blocks.named_parameters()}
        head.blocks = load_streamed(head.blocks, names, pool)
        pool.preload()
        if len(pool.gpu) != len(pool.order):
            raise RuntimeError('The pixel head did not fit its own share')

        def tensor(key, dtype=torch.bfloat16):
            # Turned into bfloat16 on the card (minimax_h3_vae._fill: 1.5 s on the processor for the decoder's).
            value = store.get_tensor(key).to('cuda', non_blocking=True).to(dtype)
            return nn.Parameter(value, requires_grad=False)

        head.modulation.weight = tensor('dwd_norm_out.linear.weight', torch.float32)
        head.modulation.bias = tensor('dwd_norm_out.linear.bias', torch.float32)
        for name in ('feature_expand', 'norm_out', 'first_frame_proj_out', 'proj_out'):
            module = getattr(head, name)
            module.weight, module.bias = tensor(f'{PREFIX}{name}.weight'), tensor(f'{PREFIX}{name}.bias')
        head.register_tokens = nn.Parameter(tensor(PREFIX + 'register_tokens')[0], requires_grad=False)
    except BaseException:
        head.release()
        raise
    return head.eval()


def _apply(layer, rows, act=None, residual=None, gate=None):
    """layer(act(rows)), or residual + gate * layer(act(rows)) with `residual`: inside comfy-kitchen's INT8 kernel
    for a layer of the pool (runner.models.pool, load_streamed), in separate steps for a plain one. 'swiglu' takes
    [gate | value] rows."""
    if not isinstance(layer, nn.Linear):
        return layer(rows, act=act, residual=residual, gate=gate)
    if act == 'swiglu':
        opening, value = rows.chunk(2, dim=-1)
        rows = F.silu(opening) * value
    elif act is not None:
        raise ValueError('Unknown activation ' + act)
    result = layer(rows)
    return result if residual is None else torch.addcmul(residual, result, gate)


def modulation(head, temb):
    """(1 + scale, shift) of each time of the input norm, [times, 5376] each, with (scale, shift) =
    linear(silu(temb)) in that order (ComfyUI-piFlow's MiniMaxH3DWDNormOut; the DiT's own final norm reads
    (shift, scale), without SiLU). In float32, float64 for float64 weights."""
    exact = torch.promote_types(head.feature_expand.weight.dtype, torch.float32)
    weight, bias = head.modulation.weight.to(exact), head.modulation.bias.to(exact)
    scale, shift = F.linear(F.silu(temb.to(exact)), weight, bias).chunk(2, dim=-1)
    return 1 + scale, shift


def modulate(rows, modulated, index):
    """The input norm of a few DiT rows: each through a LayerNorm without weights, then times 1 + scale and plus
    shift of its own time (`modulated`, from modulation; `index`, one a row: the rows a continuation keeps carry
    the time of what is kept). In the precision of `modulated`: a few rows at a time, it costs nothing beside the
    layers."""
    scale, shift = modulated
    normed = F.layer_norm(rows.to(scale.dtype), (rows.shape[-1],), eps=EPS)
    return normed.mul_(scale.index_select(0, index)).add_(shift.index_select(0, index))


def expand(head, geometry, hidden, temb, index):
    """The rows the layers start from, [rows, width]: each latent frame of `hidden` through the input norm
    (modulate) and onto its decoder tokens, in its block (a DiT token at (y, x) gives the tokens (2y + a, 2x + b),
    its outputs grouped (a, b, channel)); then each block's global rows, its register tokens and a row of zeros."""
    dims, (latents, height, width) = head.dims, geometry.grid
    weight, bias = head.feature_expand.weight, head.feature_expand.bias
    plane = height * width
    modulated = modulation(head, temb)
    x = torch.empty(geometry.rows, dims.width, device=weight.device, dtype=weight.dtype)
    for latent in range(latents):
        rows = slice(latent * plane, (latent + 1) * plane)
        normed = modulate(hidden[rows], modulated, index[rows]).to(weight.dtype)
        tokens = F.linear(normed, weight, bias)
        del normed
        block, within = divmod(latent, BLOCK)
        first = geometry.starts[block] + within * geometry.plane
        x[first : first + geometry.plane].view(height, EXPAND, width, EXPAND, dims.width).copy_(
            tokens.view(height, width, EXPAND, EXPAND, dims.width).transpose(1, 2)
        )
        del tokens
    for block in range(len(geometry.blocks)):
        end = geometry.span(block)[1]
        x[end - GLOBALS : end - 1] = head.register_tokens
        x[end - 1] = 0
    return x


def frames(first, rest, height, width):
    """The frames of a block, float32 [frames, PATCH · height, PATCH · width, 3], in the colours of the video
    (ImageNet's normalisation undone, not yet held to [0, 1]): from what the projections give for its first latent
    (`first`, [height · width, 3 · 16 · 16]: one frame) and for its others (`rest`, [height · width · latents,
    3 · 4 · 16 · 16]: four frames each; None without), a token's channels laid out (colour, frame, row, column),
    a latent's tokens (row, column)."""
    plane = height * width
    latents = 0 if rest is None else rest.shape[0] // plane
    shape = (1 + PATCH_T * latents, height * PATCH, width * PATCH, CHANNELS)
    out = torch.empty(shape, device=first.device, dtype=torch.float32)
    out[:1].view(1, height, PATCH, width, PATCH, CHANNELS).copy_(
        first.view(height, width, CHANNELS, 1, PATCH, PATCH).permute(3, 0, 4, 1, 5, 2)
    )
    if latents:
        out[1:].view(latents, PATCH_T, height, PATCH, width, PATCH, CHANNELS).copy_(
            rest.view(latents, height, width, CHANNELS, PATCH_T, PATCH, PATCH).permute(0, 4, 1, 5, 2, 6, 3)
        )
    return out.mul_(torch.tensor(STD, device=out.device)).add_(torch.tensor(MEAN, device=out.device))


def _pixels(head, x, geometry, block):
    """The frames of one block once the last layer is done with it (frames)."""
    start, stop = geometry.blocks[block]
    first, plane = geometry.starts[block], geometry.plane
    norm = head.norm_out
    y = F.layer_norm(x[first : first + (stop - start) * plane], (x.shape[-1],), norm.weight, norm.bias, EPS)
    opening = F.linear(y[:plane], head.first_frame_proj_out.weight, head.first_frame_proj_out.bias)
    rest = F.linear(y[plane:], head.proj_out.weight, head.proj_out.bias) if stop - start > 1 else None
    del y
    return frames(opening, rest, *geometry.size[1:])


def _finish(block, x, answers, geometry, number):
    """The end of a layer for one block, once each of its rows has its answer: the output projection and the
    feed-forward, each added to the rows by its scale, CHUNK rows of the feed-forward at a time."""
    first, end = geometry.span(number)
    rows = x[first:end]
    slot = (number % 2) * geometry.slot
    hidden = _apply(block.attn.to_out, answers[slot : slot + end - first], residual=rows, gate=block.scale1)
    for at in range(0, end - first, CHUNK):
        part = hidden[at : at + CHUNK]
        normed = F.rms_norm(part, (part.shape[-1],), block.norm2.weight, EPS)
        up = _apply(block.ff.w1, normed)
        del normed
        rows[at : at + CHUNK] = _apply(block.ff.w2, up, act='swiglu', residual=part, gate=block.scale2)
        del up


def refine(head, hidden, temb, index, grid, window=WINDOW):
    """The frames of each block of the video as the head gives them, float32 [frames, 32 · height, 32 · width, 3]
    on the card (frames: not yet held to [0, 1]), one block after the other. `hidden`, `temb`, `index` and `grid`
    as `decode` takes them; `window` smaller in the tests.

    Each layer goes through the blocks in order. A block's rows are normed and projected; its queries and keys are
    normed and turned in place (comfy-kitchen's kernel, in float32 as the reference); its global rows attend to the
    whole block; then its rows are copied to the windows they are in, its global rows to every window that touches
    it. A window is computed once its last block is there, with PyTorch's exact attention, the windows of one shape
    together; a block ends its layer once every window it is in is done. The windows of two last blocks and the
    answers of two blocks are all that is on the card beside the rows."""
    import comfy_kitchen

    dims = head.dims
    geometry = Geometry(*grid, window=window)
    weight = head.feature_expand.weight
    device, dtype = weight.device, weight.dtype
    latents, height, width = grid
    if tuple(hidden.shape) != (latents * height * width, dims.features) or index.shape != hidden.shape[:1]:
        raise ValueError(f'Pixel head rows {tuple(hidden.shape)} and times {tuple(index.shape)} for a grid {grid}')
    temb = temb.to(device)
    index = index.to(device=device, dtype=torch.long)
    low, high = (int(value) for value in torch.aminmax(index))
    if low < 0 or high >= temb.shape[0]:
        raise ValueError(f'Pixel head times {low} to {high} for {temb.shape[0]} embeddings')
    x = expand(head, geometry, hidden, temb, index)
    del hidden
    plans = [plan(geometry, parity, device) for parity in (0, 1)]
    region = torch.empty(2 * max(found.region for found in plans), 3 * dims.width, device=device, dtype=dtype)
    answers = torch.empty(2 * geometry.slot, dims.width, device=device, dtype=dtype)
    unit = torch.ones(dims.head, device=device, dtype=dtype)
    tables = {}
    last = len(head.blocks) - 1
    for layer, block in enumerate(head.blocks):
        parity = layer % 2
        steps = plans[parity]
        for number in range(len(geometry.blocks)):
            first, end = geometry.span(number)
            rows, tokens, slot = end - first, end - first - GLOBALS, (number % 2) * geometry.slot
            normed = F.rms_norm(x[first:end], (dims.width,), block.norm1.weight, EPS)
            qkv = _apply(block.attn.to_qkv, normed)
            del normed
            query, key, value = qkv.view(rows, dims.heads, 3, dims.head).unbind(2)
            table = tables.get((parity, rows))
            if table is None:
                table = tables[(parity, rows)] = rotation(geometry.positions(parity, number).to(device), dims.rotary)
            comfy_kitchen.rms_rope_split_half_(query[None], key[None], table, unit, unit, EPS, rot_dim=dims.rotary)
            # The global rows attend to their whole block.
            answers[slot + tokens : slot + rows] = (
                F.scaled_dot_product_attention(
                    query[None, tokens:].transpose(1, 2), key[None].transpose(1, 2), value[None].transpose(1, 2)
                )[0]
                .transpose(0, 1)
                .reshape(GLOBALS, dims.width)
            )
            region.index_copy_(0, steps.tokens[number], qkv[:tokens])
            region.index_copy_(0, steps.globals[number], qkv[tokens:].repeat(steps.copies[number], 1))
            del qkv, query, key, value
            for start, count, queries, keys, where in steps.groups[number]:
                held = region[start : start + count * keys].view(count, keys, dims.heads, 3, dims.head)
                answer = F.scaled_dot_product_attention(
                    held[:, :queries, :, 0].transpose(1, 2), held[:, :, :, 1].transpose(1, 2),
                    held[:, :, :, 2].transpose(1, 2),
                )
                answers.index_copy_(0, where, answer.transpose(1, 2).reshape(count * queries, dims.width))
                del held, answer
            for done in steps.finished[number]:
                _finish(block, x, answers, geometry, done)
                if layer == last:
                    yield _pixels(head, x, geometry, done)


def decode(head, hidden, temb, index, grid, window=WINDOW):
    """The video as the head gives it: uint8 [frames, 32 · height, 32 · width, 3] in RAM, a block of five latents
    at a time (17 frames; fewer for the last block), as runner.models.minimax_h3_vae.decode_chunks gives the
    VAE's. 124 frames for the 37 latents of 5 s.

    `hidden`: the rows of the generated video as the 50 blocks leave them at the last step, before the final norm,
    [latents · height · width, 5376] in the order of the video's tokens (time, row, column), on the card; given
    without keeping a reference to it, it is let go once the layers have their rows. `temb`: the time embedding
    of that step, [times, 8] (the DiT's AdaLN curve at each time); `index`: the time of each row, [rows]. `grid`:
    (latents, height, width), height and width in DiT tokens (pixels / 32). Run inside torch.inference_mode."""
    for pixels in refine(head, hidden, temb, index, grid, window):
        if not bool(torch.isfinite(pixels).all()):
            raise RuntimeError('La tête DWD de pi H3 a rendu des valeurs non finies : aucune vidéo n’est enregistrée.')
        yield pixels.clamp_(0, 1).mul_(255).round_().to(torch.uint8).cpu().numpy()
        del pixels


def gib(grid, window=WINDOW, dims=DIMS):
    """Video memory the decode of a video of that grid holds at its peak beside its inputs, in GiB: what
    `pool.lend` is to give back for it. The head's weights; the rows of the video; the windows of two last blocks
    (their queries, keys and values) and the answers of two blocks; the tables of positions and the plans; and the
    largest of what passes: a block's projection, a feed-forward of CHUNK rows, the frames of a block. Then
    SLACK_GIB. 2.54 GiB for 5 s at 1344 x 768 (37 x 24 x 42), 3.62 for 15 s (107 x 24 x 42), 1.60 for 5 s at
    768 x 448 (37 x 14 x 24). The rows given to `decode` are the caller's, beside that (1.1 GiB for 15 s)."""
    geometry = Geometry(*grid, window=window)
    width, slot, plane = dims.width, geometry.slot, geometry.plane
    region = max(geometry.region(parity) for parity in (0, 1))
    weights = quantised_bytes(dims) + plain_bytes(dims)
    rows = 2 * geometry.rows * width
    # The windows of two last blocks, the answers of two blocks.
    ring = 2 * 2 * region * 3 * width + 2 * 2 * slot * width
    # A table for each length of block and parity; the plans' rows (int64: two for each row of the head).
    tables = 2 * len({stop - start for start, stop in geometry.blocks}) * slot * dims.rotary // 2 * 16
    plans = 2 * 8 * 2 * geometry.rows
    # A block's normed rows, their INT8 copy in the kernel and its projection.
    projection = slot * (2 * width + width + 2 * 3 * width)
    # The rows of a block after the attention, and one chunk of its feed-forward: normed, INT8, its wide
    # intermediate, that activated in INT8, its result.
    chunk = min(CHUNK, slot)
    feed = 2 * slot * width + chunk * (2 * width + width + 2 * 2 * dims.ffn + dims.ffn + 2 * width)
    # A block's normed rows and projections, its frames in float32, then held to [0, 1] in 8 bits.
    count = max(geometry.frames)
    pixels = 2 * BLOCK * plane * width + (count * plane * PATCH * PATCH * CHANNELS) * (4 + 1 + 1)
    # The input norm of one latent: two rows of float32 at once, then its projection.
    entry = (2 * 4 * dims.features + 2 * dims.features + 2 * EXPAND * EXPAND * width) * plane // 4
    passing = max(projection, feed, pixels, entry)
    return (weights + rows + ring + tables + plans + passing) / GiB + SLACK_GIB
