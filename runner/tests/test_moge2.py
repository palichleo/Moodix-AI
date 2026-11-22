import math
from pathlib import Path
import tempfile
import unittest

import numpy as np
import torch

from runner.models import moge2

TINY = dict(dim=32, depth=4, heads=2, layers=(0, 1, 2, 3), widths=(32, 16, 8, 8, 4))


def pinhole(height, width, hfov, shift, seed=0):
    """The point map [H, W, 3] MoGe would give of a picture taken with a lens `hfov` wide: x and y
    exact, z up to `shift` (what the network leaves to find), and the true depth."""
    rng = np.random.default_rng(seed)
    depth = rng.uniform(2.0, 5.0, (height, width))
    half = math.tan(math.radians(hfov) / 2)
    columns = (2 * (np.arange(width) + 0.5) / width - 1) * half
    rows = (2 * (np.arange(height) + 0.5) / height - 1) * half * height / width
    x = columns[None, :] * depth
    y = rows[:, None] * depth
    return np.stack((x, y, depth - shift), -1), depth


class LayoutTests(unittest.TestCase):
    def test_the_vit_l_layout_of_the_checkpoint(self):
        with torch.device('meta'):
            model = moge2.MoGe2()
        found = {key: list(value.shape) for key, value in model.state_dict().items()}
        self.assertEqual(len(found), 482)
        for key, shape in {
            'encoder.backbone.patch_embed.proj.weight': [1024, 3, 14, 14],
            'encoder.backbone.pos_embed': [1, 1370, 1024],
            'encoder.backbone.blocks.23.ls2.gamma': [1024],
            'encoder.output_projections.3.weight': [1024, 1024, 1, 1],
            'neck.input_blocks.0.weight': [1024, 1026, 1, 1],
            'neck.input_blocks.4.weight': [32, 2, 1, 1],
            'neck.res_blocks.1.0.layers.2.weight': [256, 256, 3, 3],
            'points_head.resamplers.3.1.weight': [32, 64, 3, 3],
            'points_head.output_blocks.4.weight': [3, 32, 1, 1],
            'mask_head.output_blocks.4.weight': [1, 32, 1, 1],
            'scale_head.4.weight': [1, 1024],
        }.items():
            with self.subTest(key=key):
                self.assertEqual(found[key], shape)
        self.assertNotIn('encoder.backbone.blocks.24.norm1.weight', found)
        self.assertEqual(sum(math.prod(shape) for shape in found.values()), 326_208_203)

    def test_a_file_is_checked_from_its_header_alone(self):
        with torch.device('meta'):
            model = moge2.MoGe2()
        entry = lambda shape: dict(dtype='F16', shape=shape, data_offsets=[0, 0])  # noqa: E731
        entries = {key: entry(list(value.shape)) for key, value in model.state_dict().items()}
        # What the depth does not read, which the file of Comfy-Org holds: the normals, the mask token of
        # DINOv2's training.
        entries.update({'normal_head.output_blocks.4.weight': entry([3, 32, 1, 1]), '__metadata__': {}})
        entries['encoder.backbone.mask_token'] = entry([1, 1024])
        moge2.validate_layout(entries)
        missing, wrong, other = dict(entries), dict(entries), dict(entries)
        del missing['scale_head.4.weight']
        wrong['scale_head.4.weight'] = entry([1, 768])
        other['encoder.backbone.blocks.24.attn.qkv.weight'] = entry([3072, 1024])
        for name, broken in (('missing', missing), ('wrong', wrong), ('other', other)):
            with self.subTest(name), self.assertRaises(ValueError) as refused:
                moge2.validate_layout(broken)
            self.assertIn('Not a MoGe-2 checkpoint', str(refused.exception))

    def test_the_learned_positions_follow_the_grid(self):
        backbone = moge2.Backbone(8, 1, 2)
        torch.nn.init.normal_(backbone.pos_embed)
        torch.testing.assert_close(backbone.positions(37, 37, torch.float32), backbone.pos_embed)
        grown = backbone.positions(44, 62, torch.float32)
        self.assertEqual(tuple(grown.shape), (1, 1 + 44 * 62, 8))
        torch.testing.assert_close(grown[:, :1], backbone.pos_embed[:, :1])
        self.assertEqual(backbone.positions(20, 30, torch.float16).dtype, torch.float16)
        # Read where DINOv2 reads them: output k at (k + 0.5) · 37 / (n + 0.1) - 0.5 of the grid.
        grid = backbone.pos_embed[0, 1:].reshape(1, 37, 37, 8).permute(0, 3, 1, 2)

        def places(count):
            at = (torch.arange(count) + 0.5) * 37 / (count + 0.1) - 0.5
            return (2 * at + 1) / 37 - 1

        rows, columns = torch.meshgrid(places(44), places(62), indexing='ij')
        read = torch.nn.functional.grid_sample(
            grid, torch.stack((columns, rows), -1)[None], mode='bicubic', padding_mode='border', align_corners=False
        )
        torch.testing.assert_close(grown[0, 1:], read[0].permute(1, 2, 0).reshape(-1, 8), atol=1e-4, rtol=0)

    def test_the_view_plane(self):
        uv = moge2.view_plane(4, 2, 2.0)
        self.assertEqual(tuple(uv.shape), (2, 4, 2))
        x, y = 2 / 5**0.5, 1 / 5**0.5
        torch.testing.assert_close(uv[0, 0], torch.tensor([-x * 3 / 4, -y / 2]))
        torch.testing.assert_close(uv[1, 3], torch.tensor([x * 3 / 4, y / 2]))
        torch.testing.assert_close(uv[0, 1, 0] - uv[0, 0, 0], torch.tensor(2 * x / 4))


class LensTests(unittest.TestCase):
    def test_the_shift_and_the_focal_are_found(self):
        uv = moge2.view_plane(48, 32, 1.5).numpy().astype(np.float64)
        rng = np.random.default_rng(3)
        depth = rng.uniform(1.0, 6.0, (32, 48))
        xy = uv * depth[..., None] / 1.3
        xyz = np.concatenate((xy, (depth - 0.7)[..., None]), -1)
        shift, focal = moge2.solve(uv, xyz)
        self.assertAlmostEqual(shift, 0.7, places=6)
        self.assertAlmostEqual(focal, 1.3, places=6)
        shift, focal = moge2.solve(uv, xyz, focal=1.3)
        self.assertAlmostEqual(shift, 0.7, places=6)
        self.assertEqual(focal, 1.3)
        # A shift that would put a point behind the camera is never taken.
        flat = np.concatenate((xy, np.full((32, 48, 1), 0.05)), -1)
        shift, _ = moge2.solve(uv, flat)
        self.assertGreater(0.05 + shift, 0)

    def test_the_width_of_the_lens_comes_back_from_a_point_map(self):
        for hfov, shift in ((50.0, 0.3), (70.0, -0.5), (35.0, 1.2)):
            points, _ = pinhole(36, 64, hfov, shift)
            focal, found = moge2.focal_shift(torch.from_numpy(points).float(), torch.ones(36, 64, dtype=torch.bool))
            with self.subTest(hfov=hfov):
                self.assertAlmostEqual(found, shift, places=3)
                self.assertAlmostEqual(moge2.hfov_of(focal, 64 / 36), hfov, places=2)
        points, _ = pinhole(36, 64, 50.0, 0.0)
        mask = torch.zeros(36, 64, dtype=torch.bool)
        self.assertEqual(moge2.focal_shift(torch.from_numpy(points).float(), mask), (1.0, 0.0))


class ModelTests(unittest.TestCase):
    def test_a_file_is_loaded_and_gives_a_depth(self):
        from safetensors.torch import save_file

        torch.manual_seed(0)
        model = moge2.MoGe2(**TINY)
        with torch.no_grad():
            # Sure of every point: the mask is not what is tried here.
            model.mask_head.output_blocks[4].bias.fill_(10.0)
        weights = {key: value.contiguous() for key, value in model.state_dict().items()}
        # What the depth does not use is in the file too.
        weights['normal_head.output_blocks.4.weight'] = torch.zeros(3, 4, 1, 1)
        weights['encoder.backbone.mask_token'] = torch.zeros(1, 32)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'moge.safetensors'
            save_file(weights, str(path))
            loaded = moge2.load(path, 'cpu', TINY)
            self.assertEqual(loaded.encoder.backbone.pos_embed.dtype, torch.float32)
            frame = np.random.default_rng(4).integers(0, 255, (30, 52, 3), dtype=np.uint8)
            found = moge2.estimate(loaded, frame, tokens=64)
            self.assertEqual(found['depth'].shape, (30, 52))
            self.assertEqual(found['depth'].dtype, np.float32)
            self.assertTrue(np.isfinite(found['depth']).all())
            self.assertGreater(found['depth'].min(), 0)
            self.assertTrue(0 < found['hfov'] < 180)
            self.assertGreater(found['scale'], 0)
            # The same as the model itself gives.
            with torch.inference_mode():
                image = torch.from_numpy(frame).permute(2, 0, 1)[None].float() / 255
                points, mask, scale = model(image, 64)
            self.assertAlmostEqual(found['scale'], float(scale[0]), places=5)
            expected = (points[0, ..., 2] + found['shift']) * scale[0]
            np.testing.assert_allclose(found['depth'], expected.numpy(), rtol=1e-4)
            # Where the model sees nothing (the sky), there is no depth.
            with torch.no_grad():
                loaded.mask_head.output_blocks[4].bias.fill_(-10.0)
            self.assertTrue(np.isnan(moge2.estimate(loaded, frame, tokens=64)['depth']).all())
            del weights['scale_head.4.weight']
            save_file(weights, str(path))
            with self.assertRaisesRegex(ValueError, 'scale_head.4.weight'):
                moge2.load(path, 'cpu', TINY)


if __name__ == '__main__':
    unittest.main()
