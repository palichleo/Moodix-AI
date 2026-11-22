import math
import unittest

import numpy as np

from runner.video import camera_warp as cw


def colours(height, width, seed=0):
    return np.random.default_rng(seed).integers(0, 255, (height, width, 3), dtype=np.uint8)


def landing(depth, camera, fx):
    """Where the single point of `depth` is drawn (row, column), splat 0."""
    picture, holes = cw.warp(colours(*depth.shape), depth, camera, fx, splat=0)
    found = np.argwhere(~holes)
    if len(found) != 1:
        raise AssertionError(f'{len(found)} places drawn')
    return tuple(found[0])


class CameraTests(unittest.TestCase):
    def test_the_lens_and_its_bounds(self):
        self.assertAlmostEqual(cw.focal(64, 50), 32 / math.tan(math.radians(25)))
        for hfov in (10, 180, 200):
            with self.subTest(hfov=hfov), self.assertRaises(ValueError):
                cw.focal(64, hfov)

    def test_an_orbit_goes_right_for_an_azimuth_and_up_for_an_elevation(self):
        pivot = (0.0, 0.0, 3.0)
        np.testing.assert_allclose(cw.orbit(0, 0, 1, pivot), np.eye(4), atol=1e-9)
        right = cw.orbit(30, 0, 1, pivot)
        self.assertGreater(right[0, 3], 0)
        turn = math.radians(30)
        np.testing.assert_allclose(right[:3, 3], [3 * math.sin(turn), 0, 3 - 3 * math.cos(turn)])
        # (y points down: a camera that rises has a smaller y.)
        up = cw.orbit(0, 20, 1, pivot)
        self.assertLess(up[1, 3], 0)
        self.assertAlmostEqual(up[0, 3], 0)
        np.testing.assert_allclose(cw.orbit(0, 0, 2, pivot)[:3, 3], [0, 0, -3], atol=1e-9)
        for camera in (right, up, cw.orbit(-50, -15, 0.7, pivot)):
            rotation = camera[:3, :3]
            np.testing.assert_allclose(rotation.T @ rotation, np.eye(3), atol=1e-9)
            self.assertAlmostEqual(np.linalg.det(rotation), 1.0)
            # Upright: its right axis stays level, and it looks at the pivot.
            self.assertAlmostEqual(camera[1, 0], 0.0)
            ahead = np.asarray(pivot) - camera[:3, 3]
            np.testing.assert_allclose(camera[:3, 2], ahead / np.linalg.norm(ahead), atol=1e-9)

    def test_the_new_camera_keeps_the_aim_of_the_first(self):
        pivot = np.array([0.4, -0.2, 3.0])
        aim = cw.source_aim(pivot)
        np.testing.assert_allclose(aim, [0, 0, np.linalg.norm(pivot)])
        camera = cw.cameras([(25.0, 10.0, 1.0)], pivot)[0]
        ahead = aim - camera[:3, 3]
        np.testing.assert_allclose(camera[:3, 2], ahead / np.linalg.norm(ahead), atol=1e-9)
        np.testing.assert_allclose(cw.cameras([(0.0, 0.0, 1.0)], (0.0, 0.0, 2.0))[0], np.eye(4), atol=1e-9)

    def test_looking_straight_down_still_gives_a_camera(self):
        camera = cw.look_at((0, -5, 3), (0, 0, 3))
        rotation = camera[:3, :3]
        self.assertTrue(np.isfinite(camera).all())
        np.testing.assert_allclose(rotation.T @ rotation, np.eye(3), atol=1e-9)
        np.testing.assert_allclose(camera[:3, 2], [0, 1, 0], atol=1e-9)


class WarpTests(unittest.TestCase):
    def test_the_same_camera_without_squares_copies_the_frame_but_its_farthest_points(self):
        rgb = colours(48, 64)
        depth = np.random.default_rng(1).uniform(1.0, 9.0, (48, 64))
        fx = cw.focal(64)
        picture, holes = cw.warp(rgb, depth, np.eye(4), fx, splat=0)
        far = depth > np.percentile(depth, cw.FAR)
        self.assertGreater(far.sum(), 0)
        np.testing.assert_array_equal(holes, far)
        np.testing.assert_array_equal(picture[~holes], rgb[~holes])
        self.assertTrue((picture[holes] == cw.MAGENTA).all())

    def test_squares_of_five_move_the_picture_two_pixels_right_and_down(self):
        rgb = colours(32, 40)
        picture, holes = cw.warp(rgb, np.full((32, 40), 2.0), np.eye(4), cw.focal(40))
        self.assertFalse(holes.any())
        np.testing.assert_array_equal(picture[2:, 2:], rgb[:-2, :-2])
        # Where no point lies two above, the last pass that reached it is drawn: two to the left.
        np.testing.assert_array_equal(picture[0, 2:], rgb[0, :-2])

    def test_the_nearest_point_hides_the_others_and_the_unseen_is_magenta(self):
        height = width = 32
        rgb = np.zeros((height, width, 3), dtype=np.uint8)
        rgb[:] = (0, 0, 200)
        depth = np.full((height, width), 4.0)
        rgb[12:20, 12:20] = (200, 0, 0)
        depth[12:20, 12:20] = 2.0
        fx = cw.focal(width)
        camera = np.eye(4)
        camera[0, 3] = 0.5
        picture, holes = cw.warp(rgb, depth, camera, fx, splat=0)
        # The near square moves 9 pixels left, the far wall 4: in front, the square is drawn ...
        np.testing.assert_array_equal(picture[15, 5], (200, 0, 0))
        np.testing.assert_array_equal(picture[15, 2], (0, 0, 200))
        # ... behind it, what the first camera did not see stays magenta.
        self.assertTrue(holes[12:20, 11:16].all())
        np.testing.assert_array_equal(picture[15, 13], cw.MAGENTA)
        self.assertFalse(holes[12:20, 16:28].any())
        # The wall's right edge had nothing beyond it.
        self.assertTrue(holes[:, 28:].all())
        self.assertFalse(holes[:12, :28].any())

    def test_an_orbit_draws_the_near_to_the_left_and_the_far_to_the_right(self):
        height = width = 64
        fx = cw.focal(width)
        pivot = (0.0, 0.0, 3.0)
        camera = cw.cameras([(20.0, 0.0, 1.0)], pivot)[0]
        found = {}
        for distance in (1.5, 3.0, 6.0):
            depth = np.full((height, width), np.nan)
            depth[32, 32] = distance
            found[distance] = landing(depth, camera, fx)
        self.assertEqual(found[3.0], (32, 32))
        self.assertLess(found[1.5][1], 32)
        self.assertGreater(found[6.0][1], 32)
        self.assertEqual({place[0] for place in found.values()}, {32})
        # Up, the near goes down.
        depth = np.full((height, width), np.nan)
        depth[32, 32] = 1.5
        row, column = landing(depth, cw.cameras([(0.0, 20.0, 1.0)], pivot)[0], fx)
        self.assertGreater(row, 32)
        self.assertEqual(column, 32)

    def test_points_without_depth_or_behind_the_camera_are_left_out(self):
        rgb = colours(16, 16)
        depth = np.full((16, 16), 3.0)
        depth[:4] = np.nan
        depth[4:6] = 0.0
        picture, holes = cw.warp(rgb, depth, np.eye(4), cw.focal(16), splat=0)
        self.assertTrue(holes[:6].all())
        self.assertFalse(holes[6:].any())
        turned = np.eye(4)
        turned[:3, :3] = cw.rot_y(math.pi)
        picture, holes = cw.warp(rgb, np.full((16, 16), 3.0), turned, cw.focal(16))
        self.assertTrue(holes.all())
        self.assertTrue((picture == cw.MAGENTA).all())
        picture, holes = cw.warp(rgb, np.full((16, 16), np.nan), np.eye(4), cw.focal(16))
        self.assertTrue(holes.all())

    def test_a_point_just_outside_the_frame_reaches_into_it_by_its_square(self):
        width = 32
        fx = cw.focal(width)
        depth = np.full((16, width), np.nan)
        depth[8, 1] = 2.0
        camera = np.eye(4)
        # Three pixels to the right of the camera: the point lands at column -2.
        camera[0, 3] = 3 * 2.0 / fx
        rgb = colours(16, width)
        picture, holes = cw.warp(rgb, depth, camera, fx)
        self.assertEqual(int((~holes).sum()), 5)
        self.assertTrue((~holes[6:11, 0]).all())
        np.testing.assert_array_equal(picture[8, 0], rgb[8, 1])


class PivotTests(unittest.TestCase):
    def test_the_pivot_is_the_median_point_of_the_middle(self):
        fx = cw.focal(64)
        depth = np.full((64, 64), 3.0)
        # Rows 8 to 50, columns 12 to 50: the middle ones are row 29 and column 31.
        np.testing.assert_allclose(cw.pivot_of(depth, fx), [(31 - 32) / fx * 3, (29 - 32) / fx * 3, 3.0])
        # Far mountains on its left (column 12: under 5 % of the middle) are left out: the middle
        # is then columns 13 to 50, between 31 and 32. (Kept, they would pull it to column 31.)
        depth[:, 12] = 100.0
        depth[0, 0] = np.nan
        np.testing.assert_allclose(cw.pivot_of(depth, fx), [(31.5 - 32) / fx * 3, (29 - 32) / fx * 3, 3.0])
        with self.assertRaises(ValueError):
            cw.pivot_of(np.full((64, 64), np.nan), fx)

    def test_a_pivot_named_on_the_first_frame_is_the_median_point_around_it(self):
        fx = cw.focal(100)
        depth = np.full((50, 100), 5.0)
        # Someone near, on the right of the frame, whom the middle of the frame would miss.
        depth[10:30, 70:90] = 2.0
        self.assertGreater(cw.pivot_of(depth, fx)[2], 4.0)
        # Named on them, a tenth of the frame each side: rows 15 to 24, columns 70 to 89.
        np.testing.assert_allclose(
            cw.pivot_at(depth, fx, 0.8, 0.4), [(79.5 - 50) / fx * 2, (19.5 - 25) / fx * 2, 2.0], atol=1e-12
        )
        # In a corner, what is within the frame.
        np.testing.assert_allclose(cw.pivot_at(depth, fx, 0.0, 0.0)[2], 5.0)
        for x, y in ((1.2, 0.5), (0.5, -0.1)):
            with self.subTest(x=x, y=y), self.assertRaises(ValueError):
                cw.pivot_at(depth, fx, x, y)
        depth[:20, :20] = np.nan
        with self.assertRaises(ValueError):
            cw.pivot_at(depth, fx, 0.05, 0.1)

    def test_the_depth_of_each_frame_is_told_every_fifteen_frames_and_at_the_last(self):
        from unittest import mock

        from runner.models import moge2

        told = []
        frames = [colours(4, 6, seed) for seed in range(31)]
        result = dict(depth=np.ones((4, 6)), hfov=50.0, scale=1.0)
        with (
            mock.patch.object(moge2, 'load', return_value='model') as load,
            mock.patch.object(moge2, 'estimate', return_value=result),
            mock.patch('torch.cuda.empty_cache'),
        ):
            report = lambda done, total: told.append((done, total))  # noqa: E731
            found, lenses, scales = cw.depths(frames, 'moge.safetensors', report)
        load.assert_called_once_with('moge.safetensors', 'cuda')
        self.assertEqual((len(found), lenses[0], scales[0]), (31, 50.0, 1.0))
        self.assertEqual(told, [(1, 31), (16, 31), (31, 31)])

    def test_points_of_a_frame(self):
        fx = cw.focal(8)
        found = cw.points(np.full((4, 8), 2.0), fx)
        np.testing.assert_allclose(found[2, 4], [0, 0, 2])
        np.testing.assert_allclose(found[0, 0], [-4 / fx * 2, -2 / fx * 2, 2])


class PathTests(unittest.TestCase):
    def test_one_key_holds(self):
        self.assertEqual(cw.path([(0, 30, 0, 1)], 4), [(30.0, 0.0, 1.0)] * 4)

    def test_between_two_keys_the_camera_moves_and_holds_beyond(self):
        moves = cw.path([(0, 0, 0, 1), (120, 40, 0, 1)], 121)
        self.assertEqual(len(moves), 121)
        self.assertEqual(moves[0], (0.0, 0.0, 1.0))
        self.assertAlmostEqual(moves[60][0], 20.0)
        self.assertAlmostEqual(moves[120][0], 40.0)
        self.assertTrue(all(b[0] > a[0] for a, b in zip(moves, moves[1:])))
        held = cw.path([(10, 0, 0, 1), (20, 0, 30, 2)], 30)
        self.assertEqual(held[:11], [(0.0, 0.0, 1.0)] * 11)
        self.assertEqual(held[20:], [(0.0, 30.0, 2.0)] * 10)
        self.assertAlmostEqual(held[15][1], 15.0)
        self.assertAlmostEqual(held[15][2], 1.5)
        # Keys out of order are sorted.
        self.assertEqual(cw.path([(20, 0, 30, 2), (10, 0, 0, 1)], 30), held)

    def test_easing_is_slow_at_the_keys(self):
        linear = cw.path([(0, 0, 0, 1), (100, 40, 0, 1)], 101)
        eased = cw.path([(0, 0, 0, 1), (100, 40, 0, 1)], 101, 'ease')
        self.assertAlmostEqual(eased[50][0], 20.0)
        self.assertLess(eased[25][0], linear[25][0])
        self.assertGreater(eased[75][0], linear[75][0])
        self.assertLess(eased[1][0] - eased[0][0], linear[1][0] - linear[0][0])

    def test_azimuths_go_the_short_way_round(self):
        moves = cw.path([(0, 170, 0, 1), (10, -170, 0, 1)], 11)
        self.assertAlmostEqual(abs(moves[5][0]), 180.0)
        self.assertTrue(all(abs(move[0]) >= 170 - 1e-9 for move in moves))

    def test_bounds_and_mistakes(self):
        self.assertEqual(cw.path([(0, 0, 120, 5)], 1), [(0.0, 90.0, 3.0)])
        self.assertEqual(cw.path([(0, 0, -120, 0)], 1), [(0.0, -90.0, 0.1)])
        for keys, easing in (([], 'linear'), ([(0, 0, 0, 1), (0, 10, 0, 1)], 'linear'), ([(0, 0, 0, 1)], 'bounce')):
            with self.subTest(keys=keys, easing=easing), self.assertRaises(ValueError):
                cw.path(keys, 3, easing)


class CommandTests(unittest.TestCase):
    def test_the_guide_of_a_video_from_depths_already_made(self):
        import contextlib
        import io
        import json
        from pathlib import Path
        import tempfile

        from runner.video.ic_reference import read_frames

        frames = np.stack([colours(32, 48, seed) for seed in range(5)])
        depth = np.full((5, 32, 48), 3.0, dtype=np.float32)
        depth[:, :, :8] = 1.5
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            writer = cw.lossless(folder / 'clip.mkv', 48, 32, 24)
            for frame in frames:
                writer.send(frame)
            writer.close()
            saved = dict(depth=depth, hfov=np.full(5, 45.0), scale=np.ones(5), seconds=12.5, peak=1.25)
            np.savez(folder / 'depths.npz', **saved)
            arguments = ['--video', str(folder / 'clip.mkv'), '--moge', str(folder / 'never-read.safetensors')]
            arguments += ['--out', str(folder / 'out'), '--path', '0:0:0:1,4:20:0:1']
            arguments += ['--depths', str(folder / 'depths.npz')]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(cw.main(arguments), 0)
            report = json.loads((folder / 'out' / 'guide.json').read_text(encoding='utf-8'))
            self.assertTrue(report['depths_read'])
            self.assertEqual((report['seconds']['depth'], report['peak_vram_gib']), (12.5, 1.25))
            self.assertEqual(report['cameras'], [[0, 0, 1], [5, 0, 1], [10, 0, 1], [15, 0, 1], [20, 0, 1]])
            # Frame by frame, the frame drawn again from its camera, exactly.
            fx = cw.focal(48)
            moves = cw.cameras(cw.path([(0, 0, 0, 1), (4, 20, 0, 1)], 5), cw.pivot_of(depth[0], fx))
            guide = read_frames(folder / 'out' / 'guide.mkv', 5)
            for frame, its_depth, camera, drawn in zip(frames, depth, moves, guide):
                np.testing.assert_array_equal(drawn, cw.warp(frame, its_depth, camera, fx)[0])
            self.assertEqual(report['holes'][0], 0.0)
            self.assertGreater(report['holes'][-1], 0.01)
            self.assertTrue((folder / 'out' / 'guide.mp4').stat().st_size > 0)
            # Depths of another video are refused.
            np.savez(folder / 'other.npz', depth=depth[:3], hfov=np.ones(3), scale=np.ones(3), seconds=1.0, peak=1.0)
            arguments[-1] = str(folder / 'other.npz')
            with self.assertRaises(SystemExit):
                cw.main(arguments)


class SteadyTests(unittest.TestCase):
    def test_a_flickering_scale_is_steadied_and_a_slow_change_kept(self):
        base = np.random.default_rng(2).uniform(1, 5, (8, 8))
        scales = [1.0, 1.0, 1.06, 1.0, 1.0, 0.95, 1.0, 1.0, 1.0]
        steadied = cw.steady([base * scale for scale in scales], radius=2)
        for depth in steadied:
            np.testing.assert_allclose(depth, base, rtol=1e-12)
        ramp = [base * (1 + 0.01 * index) for index in range(9)]
        kept = cw.steady(ramp, radius=2)
        for index in range(2, 7):
            np.testing.assert_allclose(kept[index], ramp[index], rtol=1e-12)
        withsky = base.copy()
        withsky[0] = np.nan
        self.assertTrue(np.isnan(cw.steady([withsky, withsky * 1.05], radius=1)[1][0]).all())


if __name__ == '__main__':
    unittest.main()
