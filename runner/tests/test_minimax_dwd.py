"""pi H3's pixel head (runner.models.minimax_h3_dwd), on the processor: where its rows and windows are, where its
pixels go, its input norm, its layers run window by window two blocks at a time against the same layers computed
over every row under a mask written from the rules, and which files it reads."""

import json
import math
import re
import unittest
from pathlib import Path

import numpy
import torch
import torch.nn.functional as F

from runner.models import minimax_h3_dwd as dwd

FOLDER = Path('D:/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI/models')
REAL = FOLDER / 'loras' / 'pi_h3_4step_dwd_adapter_int8_convrot.safetensors'
# A head of the same make, small enough to be computed whole: heads of 32 channels, 24 of them turned.
SMALL = dwd.Dims(width=64, heads=2, ffn=96, layers=3, features=24, time=8)


def layout(grid):
    """{(latent, row, column): row of the head} and the block of each row, the rows laid out as the rules say:
    block after block of five latents, its tokens in (time, row, column) order, then its five global rows."""
    latents, height, width = grid
    where, blocks, kinds = {}, [], []
    for block, start in enumerate(range(0, latents, 5)):
        for latent in range(start, min(start + 5, latents)):
            for y in range(2 * height):
                for x in range(2 * width):
                    where[latent, y, x] = len(blocks)
                    blocks.append(block)
                    kinds.append((latent, y, x))
        for number in range(5):
            blocks.append(block)
            kinds.append(None)
    return where, blocks, kinds


def windows_of(kinds, parity, window, latents):
    """For each row, the window it is in for a layer of that parity (an id, -1 for a global row) and the first
    and last blocks that window touches: windows of 5 latents x `window` x `window`, starting 2 latents and half a
    window earlier on odd layers. A token's window along an axis is (place + shift) // size."""
    shift_t, shift = (2, window // 2) if parity else (0, 0)
    ids, firsts, lasts = [], [], []
    for kind in kinds:
        if kind is None:
            ids.append(-1)
            firsts.append(-1)
            lasts.append(-1)
            continue
        latent, y, x = kind
        number = (latent + shift_t) // 5
        ids.append((number * 1000 + (y + shift) // window) * 1000 + (x + shift) // window)
        firsts.append(max(number * 5 - shift_t, 0) // 5)
        lasts.append((min(number * 5 + 5 - shift_t, latents) - 1) // 5)
    return torch.tensor(ids), torch.tensor(firsts), torch.tensor(lasts)


def tiny(dims=SMALL, seed=0):
    """A head of those widths with random weights of moderate size: each branch moves the rows."""
    generator = torch.Generator().manual_seed(seed)

    def normal(shape, std):
        return torch.randn(shape, generator=generator) * std

    head = dwd.Head(dims)
    with torch.no_grad():
        for name, parameter in head.named_parameters():
            if name.endswith(('norm1.weight', 'norm2.weight', 'norm_out.weight')):
                value = 1 + normal(parameter.shape, 0.1)
            elif name.endswith(('scale1', 'scale2')):
                value = 0.3 + 0.7 * torch.rand(parameter.shape, generator=generator)
            elif name.endswith('.bias'):
                value = normal(parameter.shape, 0.05)
            elif name == 'register_tokens':
                value = normal(parameter.shape, 1.0)
            elif name == 'modulation.weight':
                value = normal(parameter.shape, 0.3)
            else:
                value = normal(parameter.shape, parameter.shape[1] ** -0.5)
            parameter.copy_(value)
    return head.eval()


def inputs(dims, grid, seed=1):
    """DiT rows, two time embeddings, and the time of each row: the first latent kept by a continuation (time 1),
    the others generated (time 0)."""
    generator = torch.Generator().manual_seed(seed)
    latents, height, width = grid
    count = latents * height * width
    hidden = torch.randn(count, dims.features, generator=generator) * 2 + 0.5
    temb = torch.randn(2, dims.time, generator=generator)
    index = torch.zeros(count, dtype=torch.long)
    index[: height * width] = 1
    return hidden, temb, index


def reference(head, hidden, temb, index, grid, window):
    """The head computed over all its rows at once in float64, each attention dense under a mask written from the
    rules: a token attends to the tokens of its window and to the global rows of the blocks its window touches, a
    global row to its whole block; positions within the window, 0 for the global rows. The frames of the whole
    video, [frames, 32 · height, 32 · width, 3], in the video's colours."""
    dims = head.dims
    weights = {name: value.detach().double() for name, value in head.named_parameters()}
    latents, height, width = grid
    where, blocks, kinds = layout(grid)
    count = len(kinds)
    eps = 1e-5
    # The rows the layers start from.
    modulation = F.linear(F.silu(temb.double()), weights['modulation.weight'], weights['modulation.bias'])
    scale, shift = modulation[:, : dims.features], modulation[:, dims.features :]
    rows = hidden.double()
    rows = (rows - rows.mean(-1, keepdim=True)) / torch.sqrt(rows.var(-1, unbiased=False, keepdim=True) + eps)
    rows = rows * (1 + scale[index]) + shift[index]
    tokens = F.linear(rows, weights['feature_expand.weight'], weights['feature_expand.bias'])
    x = torch.zeros(count, dims.width, dtype=torch.float64)
    for number, token in enumerate(tokens):
        latent, rest = divmod(number, height * width)
        y, column = divmod(rest, width)
        for a in range(2):
            for b in range(2):
                part = a * 2 + b
                x[where[latent, 2 * y + a, 2 * column + b]] = token[part * dims.width : (part + 1) * dims.width]
    globals_seen = 0
    for row, kind in enumerate(kinds):
        if kind is None:
            if globals_seen % 5 < 4:
                x[row] = weights['register_tokens'][globals_seen % 5]
            globals_seen += 1
    blocks = torch.tensor(blocks)
    is_global = torch.tensor([kind is None for kind in kinds])
    rotary = dims.rotary
    frequencies = 100.0 ** (-torch.arange(rotary // 6, dtype=torch.float64) / (rotary // 6))

    def rms(value, weight=None):
        value = value / torch.sqrt(value.pow(2).mean(-1, keepdim=True) + eps)
        return value if weight is None else value * weight

    for layer in range(dims.layers):
        parity = layer % 2
        prefix = f'blocks.{layer}.'
        shift_t, shift_s = (2, window // 2) if parity else (0, 0)
        ids, firsts, lasts = windows_of(kinds, parity, window, latents)
        token = ~is_global
        touched = (blocks[None, :] == firsts[:, None]) | (blocks[None, :] == lasts[:, None])
        mask = (token[:, None] & token[None, :] & (ids[:, None] == ids[None, :])) | (
            token[:, None] & is_global[None, :] & touched
        )
        mask |= is_global[:, None] & (blocks[None, :] == blocks[:, None])
        positions = torch.zeros(count, 3, dtype=torch.float64)
        for i, kind in enumerate(kinds):
            if kind is not None:
                latent, y, column = kind
                for axis, (value, moved, size) in enumerate(
                    ((latent, shift_t, 5), (y, shift_s, window), (column, shift_s, window))
                ):
                    positions[i, axis] = ((value + moved) % size + 0.5) / size * 2 - 1
        angles = (2 * math.pi * positions[:, :, None] * frequencies).flatten(1)
        cos, sin = angles.cos()[:, None], angles.sin()[:, None]

        def turn(value):
            half = rotary // 2
            first, second, kept = value[..., :half], value[..., half:rotary], value[..., rotary:]
            return torch.cat([first * cos - second * sin, first * sin + second * cos, kept], dim=-1)

        normed = rms(x, weights[prefix + 'norm1.weight'])
        qkv = F.linear(normed, weights[prefix + 'attn.to_qkv.weight'], weights[prefix + 'attn.to_qkv.bias'])
        qkv = qkv.view(count, dims.heads, 3, dims.head)
        query, key, value = turn(rms(qkv[:, :, 0])), turn(rms(qkv[:, :, 1])), qkv[:, :, 2]
        scores = torch.einsum('ihd,jhd->hij', query, key) / math.sqrt(dims.head)
        attention = scores.masked_fill(~mask, float('-inf')).softmax(-1)
        out = torch.einsum('hij,jhd->ihd', attention, value).reshape(count, dims.width)
        out = F.linear(out, weights[prefix + 'attn.to_out.weight'], weights[prefix + 'attn.to_out.bias'])
        x = x + weights[prefix + 'scale1'] * out
        normed = rms(x, weights[prefix + 'norm2.weight'])
        up = F.linear(normed, weights[prefix + 'ff.w1.weight'], weights[prefix + 'ff.w1.bias'])
        gate, up = up[:, : dims.ffn], up[:, dims.ffn :]
        out = F.linear(F.silu(gate) * up, weights[prefix + 'ff.w2.weight'], weights[prefix + 'ff.w2.bias'])
        x = x + weights[prefix + 'scale2'] * out
    y = F.layer_norm(x, (dims.width,), weights['norm_out.weight'], weights['norm_out.bias'], eps)
    starts, frames = [], 0
    for start in range(0, latents, 5):
        starts.append(frames)
        frames += 1 + 4 * (min(start + 5, latents) - start - 1)
    video = torch.zeros(frames, 32 * height, 32 * width, 3, dtype=torch.float64)
    for row, kind in enumerate(kinds):
        if kind is None:
            continue
        latent, ty, tx = kind
        within, first = latent % 5, starts[latent // 5]
        rows, columns = slice(16 * ty, 16 * ty + 16), slice(16 * tx, 16 * tx + 16)
        if within == 0:
            pixels = F.linear(y[row], weights['first_frame_proj_out.weight'], weights['first_frame_proj_out.bias'])
            video[first, rows, columns] = pixels.view(3, 16, 16).permute(1, 2, 0)
        else:
            pixels = F.linear(y[row], weights['proj_out.weight'], weights['proj_out.bias']).view(3, 4, 16, 16)
            for frame in range(4):
                video[first + 1 + 4 * (within - 1) + frame, rows, columns] = pixels[:, frame].permute(1, 2, 0)
    return video * torch.tensor((0.229, 0.224, 0.225), dtype=torch.float64) + torch.tensor((0.485, 0.456, 0.406))


class GeometryTests(unittest.TestCase):
    """Where the rows and the windows of the head are."""

    def check(self, geometry):
        """Each token in exactly one window of each layer, a window as the rules make it, its keys its tokens and
        the global rows of the blocks its time span touches; at most 5 x window x window tokens."""
        latents = geometry.grid[0]
        where, blocks, kinds = layout(geometry.grid)
        self.assertEqual(geometry.rows, len(kinds))
        self.assertEqual(
            [geometry.span(block) for block in range(len(geometry.blocks))],
            [(blocks.index(block), len(blocks) - blocks[::-1].index(block)) for block in sorted(set(blocks))],
        )
        tokens = torch.tensor([row for row, kind in enumerate(kinds) if kind is not None])
        ends = [geometry.span(block)[1] for block in range(len(geometry.blocks))]
        for parity, windows in enumerate(geometry.windows):
            with self.subTest(parity=parity):
                self.assertLessEqual(max(len(window.queries) for window in windows), 5 * geometry.window**2)
                self.assertTrue(torch.equal(torch.cat([window.queries for window in windows]).sort().values, tokens))
                ids, firsts, lasts = windows_of(kinds, parity, geometry.window, latents)
                self.assertEqual(len(windows), len(set(ids[tokens].tolist())))
                for window in windows:
                    self.assertEqual(len(set(ids[window.queries].tolist())), 1, 'a window is one window of the rules')
                    one = window.queries[0].item()
                    touched = tuple(sorted({firsts[one].item(), lasts[one].item()}))
                    self.assertEqual(window.blocks, touched)
                    extra = torch.cat([torch.arange(ends[block] - 5, ends[block]) for block in touched])
                    self.assertTrue(torch.equal(window.keys, torch.cat([window.queries, extra])))
                    # Its tokens in (time, row, column) order, those of its spans.
                    self.assertEqual(window.queries.tolist(), sorted(window.queries.tolist()))
                    spans = [kinds[row] for row in window.queries.tolist()]
                    for axis, span in enumerate((window.time, window.y, window.x)):
                        self.assertEqual({kind[axis] for kind in spans}, set(range(*span)))
                dwd.plan(geometry, parity)

    def test_the_sizes_the_model_makes(self):
        # 5 s at 768 x 448 and at 1344 x 768: 37 latents, blocks of 5 and one of 2, 124 frames.
        for grid, rows, windows in (((37, 14, 24), 49_768, (48, 96)), ((37, 24, 42), 149_224, (144, 192))):
            with self.subTest(grid=grid):
                geometry = dwd.Geometry(*grid)
                self.assertEqual(geometry.rows, rows)
                self.assertEqual(tuple(len(found) for found in geometry.windows), windows)
                self.assertEqual(max(len(window.queries) for found in geometry.windows for window in found), 1280)
                self.assertEqual(geometry.frames, [17] * 7 + [5])
                self.assertEqual(sum(geometry.frames), 124)
                self.check(geometry)

    def test_a_short_last_block_and_a_grid_smaller_than_a_window(self):
        for grid, window, frames in (
            ((12, 3, 5), 4, [17, 17, 5]),
            ((11, 3, 5), 4, [17, 17, 1]),
            ((17, 3, 5), 4, [17, 17, 17, 5]),
            ((3, 2, 3), 16, [9]),
        ):
            with self.subTest(grid=grid, window=window):
                geometry = dwd.Geometry(*grid, window=window)
                self.assertEqual(geometry.frames, frames)
                self.check(geometry)
        # Smaller than a window: one window a layer, every token and the block's global rows.
        small = dwd.Geometry(3, 2, 3)
        self.assertEqual([len(found) for found in small.windows], [1, 1])
        self.assertEqual(len(small.windows[1][0].keys), small.rows)

    def test_the_positions_are_counted_within_the_window(self):
        geometry = dwd.Geometry(37, 24, 42)
        plane, width = geometry.plane, 84
        even, odd = geometry.positions(0, 0), geometry.positions(1, 0)
        row = lambda latent, y, x: latent * plane + y * width + x  # noqa: E731

        def at(positions, place, expected):
            found = positions[row(*place)]
            self.assertTrue(torch.allclose(found, torch.tensor(expected)), (place, found))

        # Within a window of 5 latents of 16 x 16 tokens: (k + 0.5) / size * 2 - 1 for its k-th place.
        at(even, (0, 0, 0), [-0.8, -0.9375, -0.9375])
        at(even, (4, 15, 15), [0.8, 0.9375, 0.9375])
        at(even, (2, 16, 31), [0.0, -0.9375, 0.9375])
        # Odd layers: the windows start 2 latents and 8 tokens earlier.
        at(odd, (0, 0, 0), [0.0, 0.0625, 0.0625])
        at(odd, (3, 8, 7), [-0.8, -0.9375, 0.9375])
        # The global rows at 0; the same positions for every block of a length.
        self.assertEqual(even[-5:].abs().sum().item(), 0)
        self.assertTrue(torch.equal(geometry.positions(1, 3), odd))
        last = geometry.positions(1, 7)
        self.assertTrue(torch.equal(last[:-5], odd[: 2 * plane]))


class PixelTests(unittest.TestCase):
    def test_each_projection_lands_on_its_frame_and_pixel(self):
        # A block of three latents of 2 x 3 decoder tokens: each value says where it comes from.
        height, width, latents = 2, 3, 3
        code = lambda latent, y, x, colour, frame, py, px: (  # noqa: E731
            ((((latent * height + y) * width + x) * 3 + colour) * 4 + frame) * 256 + py * 16 + px
        )
        first = torch.zeros(height * width, 3 * 16 * 16)
        rest = torch.zeros((latents - 1) * height * width, 3 * 4 * 16 * 16)
        for y in range(height):
            for x in range(width):
                for colour in range(3):
                    for py in range(16):
                        for px in range(16):
                            first[y * width + x, (colour * 16 + py) * 16 + px] = code(0, y, x, colour, 0, py, px)
                            for latent in range(1, latents):
                                for frame in range(4):
                                    row = ((latent - 1) * height + y) * width + x
                                    column = ((colour * 4 + frame) * 16 + py) * 16 + px
                                    rest[row, column] = code(latent, y, x, colour, frame, py, px)
        made = dwd.frames(first, rest, height, width)
        self.assertEqual(tuple(made.shape), (1 + 4 * (latents - 1), 32, 48, 3))
        said = ((made - torch.tensor(dwd.MEAN)) / torch.tensor(dwd.STD)).round().long()
        frame, row, column, colour = torch.meshgrid(*(torch.arange(n) for n in made.shape), indexing='ij')
        # The first latent gives the first frame; each other latent four.
        latent = torch.where(frame == 0, 0, 1 + (frame - 1) // 4)
        within = torch.where(frame == 0, 0, (frame - 1) % 4)
        expected = code(latent, row // 16, column // 16, colour, within, row % 16, column % 16)
        self.assertTrue(torch.equal(said, expected))
        # A block of one latent: its frame alone.
        self.assertEqual(tuple(dwd.frames(first, None, height, width).shape), (1, 32, 48, 3))


class InputNormTests(unittest.TestCase):
    def test_the_rows_are_scaled_then_shifted_by_the_time_of_each(self):
        head = tiny()
        generator = torch.Generator().manual_seed(3)
        rows = torch.randn(6, SMALL.features, generator=generator) * 3 + 1
        temb = torch.randn(2, SMALL.time, generator=generator)
        index = torch.tensor([0, 1, 1, 0, 1, 0])
        with torch.inference_mode():
            made = dwd.modulate(rows, dwd.modulation(head, temb), index)
            # (scale, shift) = linear(silu(t)), the scale first; a LayerNorm without weights.
            out = F.linear(F.silu(temb), head.modulation.weight, head.modulation.bias)
            scale, shift = out[:, : SMALL.features], out[:, SMALL.features :]
            variance = rows.var(-1, unbiased=False, keepdim=True)
            normed = (rows - rows.mean(-1, keepdim=True)) / torch.sqrt(variance + 1e-5)
            expected = normed * (1 + scale[index]) + shift[index]
            self.assertLess((made - expected).abs().max().item(), 1e-5)
            # Each row has its own time: one time for all would give other rows where the index is 1.
            alone = dwd.modulate(rows, dwd.modulation(head, temb), torch.zeros_like(index))
            moved = (alone - made).abs().amax(-1)
            self.assertTrue(bool((moved[index == 1] > 1e-2).all()) and bool((moved[index == 0] == 0).all()))


class HeadTests(unittest.TestCase):
    """The layers run window by window, two blocks at a time, against the same computed over every row."""

    def compare(self, grid, layers, window=4):
        dims = SMALL._replace(layers=layers)
        head = tiny(dims)
        hidden, temb, index = inputs(dims, grid)
        geometry = dwd.Geometry(*grid, window=window)
        with torch.inference_mode():
            made = list(dwd.refine(head, hidden.clone(), temb, index, grid, window))
            expected = reference(head, hidden, temb, index, grid, window)
        self.assertEqual([len(block) for block in made], geometry.frames)
        made = torch.cat(made)
        self.assertEqual(made.shape, expected.shape)
        self.assertGreater(expected.std().item(), 0.05)
        self.assertLess((made.double() - expected).abs().max().item(), 1e-4)
        return head, hidden, temb, index, expected

    def test_four_blocks_spread_over_several_windows_and_an_even_last_layer(self):
        # 17 latents (5, 5, 5, 2) of 6 x 10 decoder tokens, windows of 4: two to three windows along each axis.
        self.compare((17, 3, 5), layers=3)

    def test_a_block_of_one_latent_and_an_odd_last_layer(self):
        # The last layer odd: a block ends it once the next one is in.
        self.compare((11, 2, 3), layers=2)

    def test_the_video_in_bytes_block_after_block(self):
        grid = (12, 3, 5)
        head, hidden, temb, index, expected = self.compare(grid, layers=3)
        with torch.inference_mode():
            made = list(dwd.decode(head, hidden, temb, index, grid, window=4))
        self.assertEqual([block.shape for block in made], [(17, 96, 160, 3), (17, 96, 160, 3), (5, 96, 160, 3)])
        self.assertTrue(all(block.dtype == numpy.uint8 for block in made))
        bytes_ = (expected.clamp(0, 1) * 255).round().numpy()
        self.assertLessEqual(numpy.abs(numpy.concatenate(made).astype(float) - bytes_).max(), 1)
        # A head that gives no number does not give a video.
        with torch.no_grad():
            head.blocks[1].ff.w2.weight[0, 0] = float('nan')
        with torch.inference_mode(), self.assertRaisesRegex(RuntimeError, 'non finies'):
            list(dwd.decode(head, hidden, temb, index, grid, window=4))

    def test_the_rows_given_are_checked(self):
        head = tiny()
        hidden, temb, index = inputs(SMALL, (6, 2, 2))
        with torch.inference_mode():
            with self.assertRaises(ValueError):
                next(dwd.refine(head, hidden[:-1], temb, index, (6, 2, 2), 4))
            with self.assertRaises(ValueError):
                next(dwd.refine(head, hidden, temb, index + 1, (6, 2, 2), 4))


class StoreTests(unittest.TestCase):
    def test_the_head_is_named_as_the_file_names_it(self):
        # What load reads for each module of the head.
        with torch.device('meta'):
            head = dwd.Head()
        wanted = dwd.expected()
        for name, parameter in head.blocks.named_parameters():
            key = f'{dwd.PREFIX}blocks.{name}'
            self.assertIn(key, wanted)
            self.assertEqual(list(parameter.shape), wanted[key][1])
        for name in ('feature_expand', 'norm_out', 'first_frame_proj_out', 'proj_out'):
            for part in ('weight', 'bias'):
                shape = list(getattr(getattr(head, name), part).shape)
                self.assertEqual(shape, wanted[f'{dwd.PREFIX}{name}.{part}'][1])
        self.assertEqual(list(head.modulation.weight.shape), wanted['dwd_norm_out.linear.weight'][1])
        self.assertEqual([1, *head.register_tokens.shape], wanted[dwd.PREFIX + 'register_tokens'][1])

    def test_the_memory_of_the_decode_grows_with_the_video_by_its_rows(self):
        short, long = dwd.gib((37, 24, 42)), dwd.gib((102, 24, 42))
        self.assertAlmostEqual(short, 2.54, places=2)
        self.assertAlmostEqual(long, 3.55, places=2)
        self.assertAlmostEqual(dwd.gib((37, 14, 24)), 1.60, places=2)
        # What a longer video adds is its rows: 2 bytes for each of 2048 channels, and where each goes in the
        # windows and in the answers of each parity (two int64).
        rows = dwd.Geometry(102, 24, 42).rows - dwd.Geometry(37, 24, 42).rows
        self.assertAlmostEqual(long - short, rows * (2048 * 2 + 2 * 2 * 8) / dwd.GiB, places=6)
        self.assertAlmostEqual((dwd.quantised_bytes() + dwd.plain_bytes()) / dwd.GiB, 0.6, places=1)


def fabricated():
    """The header of an adapter with the head as the study reads it, beside one layer of the DiT."""
    header = {'__metadata__': {}, 'blocks.0.adaln_proj.linear.weight': dict(dtype='F16', shape=[96768, 8])}
    for key, (dtypes, shape) in dwd.expected().items():
        header[key] = dict(dtype=dtypes[0], shape=shape if shape is not None else [72], data_offsets=[0, 0])
    return header


class Notes:
    """A store that gives the note of each INT8 layer (`.comfy_quant`), another for those of `changed`."""

    def __init__(self, changed=()):
        self.changed = changed

    def get_tensor(self, key):
        note = dict(dwd.NOTE, convrot=False) if key in self.changed else dwd.NOTE
        return torch.frombuffer(bytearray(json.dumps(note).encode()), dtype=torch.uint8)


class ValidateTests(unittest.TestCase):
    wrong = 'n’est pas celle de pi H3 que Moodix sait lire : '

    def refused(self, header, said, store=None):
        with self.assertRaisesRegex(ValueError, re.escape(said)):
            dwd.validate(header, store)

    def test_the_real_adapter_is_read(self):
        if not REAL.exists():
            self.skipTest('the pi H3 adapter is not on this computer')
        from safetensors import safe_open

        from runner.models.headers import header

        found = header(REAL)
        dwd.validate(found)
        with safe_open(str(REAL), framework='pt') as store:
            dwd.validate(found, store)
        # The same adapter without its head, as « pi_h3_4step_adapter » is.
        headless = {key: entry for key, entry in found.items() if not key.startswith(dwd.HEAD)}
        self.refused(headless, 'n’a pas de tête DWD')

    def test_a_head_that_is_not_the_one_read_here_is_refused_in_the_users_words(self):
        dwd.validate(fabricated(), Notes())
        prefix = dwd.PREFIX + 'blocks.'
        header = fabricated()
        header.pop(prefix + '3.ff.w2.weight_scale')
        self.refused(header, self.wrong + prefix + '3.ff.w2.weight_scale manque')
        header = fabricated()
        header[prefix + '0.ff.w1.weight']['shape'] = [8192, 2048]
        self.refused(header, self.wrong + prefix + '0.ff.w1.weight a la forme [8192, 2048] au lieu de [16384, 2048]')
        header = fabricated()
        header[prefix + '0.attn.to_qkv.weight']['dtype'] = 'F16'
        self.refused(header, self.wrong + prefix + '0.attn.to_qkv.weight est en F16 au lieu de I8')
        header = fabricated()
        header[prefix + '8.norm1.weight'] = dict(dtype='F16', shape=[2048])
        self.refused(header, self.wrong + prefix + '8.norm1.weight est en trop')
        header = fabricated()
        header['dwd_norm_out.linear.weight']['shape'] = [10752, 16]
        self.refused(header, self.wrong + 'dwd_norm_out.linear.weight a la forme [10752, 16] au lieu de [10752, 8]')
        # An INT8 layer quantized otherwise than the kernel is asked to compute it.
        self.refused(
            fabricated(),
            self.wrong + prefix + '5.attn.to_out n’est pas en INT8 ConvRot par groupes de 256',
            Notes({prefix + '5.attn.to_out.comfy_quant'}),
        )
        # No head at all (the adapters that leave the picture to the video VAE), or LakonLab's linear one.
        self.refused({'blocks.0.adaln_proj.linear.weight': dict(dtype='F16', shape=[96768, 8])}, 'n’a pas de tête DWD')
        header = fabricated()
        header['dwd_linear_head.weight'] = dict(dtype='F16', shape=[3072, 5376])
        self.refused(header, 'tête linéaire')


if __name__ == '__main__':
    unittest.main()
