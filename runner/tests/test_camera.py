import math
import unittest

import torch

from runner.video import camera

FLAT = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def axis(pose):
    """Where a camera looks: its third axis."""
    return [pose[row][2] for row in range(3)]


def centre(pose):
    return [pose[row][3] for row in range(3)]


class PoseTests(unittest.TestCase):
    def test_every_movement_starts_where_the_start_image_was_taken(self):
        for move in camera.MOVES:
            found = camera.poses(move, 81)
            self.assertEqual(tuple(found.shape), (81, 4, 4), move)
            self.assertEqual(found[0].tolist(), FLAT, move)
            # Each pose is a camera: three axes of length one, at right angles, none mirrored.
            axes = found[:, :3, :3].double()
            self.assertLess((axes @ axes.transpose(1, 2) - torch.eye(3).double()).abs().max().item(), 1e-6, move)
            self.assertLess((torch.linalg.det(axes) - 1).abs().max().item(), 1e-6, move)
            self.assertEqual(found[:, 3].tolist(), [[0.0, 0.0, 0.0, 1.0]] * 81, move)
        with self.assertRaisesRegex(ValueError, 'Unknown camera movement: spin'):
            camera.poses('spin', 81)
        for speed in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError, msg=speed):
                camera.poses('dolly_in', 81, speed)

    def test_the_published_movements_are_videox_funs_number_for_number(self):
        # Its files hold 81 poses, the i-th at i / 81 of the way; the camera never turns. What it
        # calls « Pan Left » moves the camera 1.5 to the left (asset/Pan_Left.txt: 1.5 i / 81 in
        # the first row of « world to camera », whose centre is the opposite), « Pan Up » 1.5
        # upwards (y points down), « Zoom In » 3 forwards (asset/Zoom_In.txt: -0.037037037 a frame).
        for move, column, step in (
            ('truck_left', 0, -1.5 / 81),
            ('truck_right', 0, 1.5 / 81),
            ('crane_up', 1, -1.5 / 81),
            ('crane_down', 1, 1.5 / 81),
            ('dolly_in', 2, 0.037037037037037035),
            ('dolly_out', 2, -0.037037037037037035),
        ):
            found = camera.poses(move, 81)
            for index in (0, 1, 40, 80):
                pose = found[index].tolist()
                self.assertEqual([row[:3] for row in pose[:3]], [row[:3] for row in FLAT[:3]], (move, index))
                wanted = [0.0, 0.0, 0.0]
                wanted[column] = step * index
                for got, value in zip(centre(pose), wanted):
                    self.assertAlmostEqual(got, value, places=6, msg=(move, index))
        self.assertEqual(camera.poses('static', 81).tolist(), [FLAT] * 81)
        published = ['crane_down', 'crane_up', 'dolly_in', 'dolly_out', 'static', 'truck_left', 'truck_right']
        self.assertEqual(sorted(camera.PUBLISHED), published)
        self.assertEqual(camera.PUBLISHED['truck_left'], 'Pan Left')
        # (The others are written here: nothing published says how the model follows them.)
        unpublished = sorted(set(camera.MOVES) - set(camera.PUBLISHED))
        self.assertEqual(unpublished, ['orbit_left', 'orbit_right', 'pan_left', 'pan_right', 'tilt_down', 'tilt_up'])

    def test_a_speed_goes_further_in_the_same_time_and_a_shorter_clip_stops_earlier(self):
        usual, fast, slow = (camera.poses('truck_right', 81, speed) for speed in (1.0, 2.0, 0.5))
        self.assertAlmostEqual(fast[80, 0, 3].item(), 2 * usual[80, 0, 3].item(), places=6)
        self.assertAlmostEqual(slow[80, 0, 3].item(), usual[40, 0, 3].item(), places=6)
        # Two seconds of a movement are the first two of its five: the same camera frame for frame.
        self.assertTrue(torch.equal(camera.poses('orbit_left', 33), camera.poses('orbit_left', 81)[:33]))

    def test_a_pan_turns_the_camera_where_it_stands(self):
        last = 80 / 81
        left, right = camera.pose('pan_left', last), camera.pose('pan_right', last)
        up, down = camera.pose('tilt_up', last), camera.pose('tilt_down', last)
        for pose in (left, right, up, down):
            self.assertEqual(centre(pose), [0.0, 0.0, 0.0])
        # To the left is towards the negative x; upwards towards the negative y (y points down).
        turned = math.radians(30 * last)
        for got, value in zip(axis(left), (-math.sin(turned), 0.0, math.cos(turned))):
            self.assertAlmostEqual(got, value, places=9)
        self.assertAlmostEqual(axis(right)[0], math.sin(turned), places=9)
        lifted = math.radians(20 * last)
        for got, value in zip(axis(up), (0.0, -math.sin(lifted), math.cos(lifted))):
            self.assertAlmostEqual(got, value, places=9)
        self.assertAlmostEqual(axis(down)[1], math.sin(lifted), places=9)
        # A pan keeps the horizon level: the axis to the right stays horizontal.
        self.assertEqual(left[1][0], 0.0)

    def test_an_orbit_goes_round_the_point_ahead_and_keeps_looking_at_it(self):
        pivot = (0.0, 0.0, camera.PIVOT)
        for move, side in (('orbit_left', -1), ('orbit_right', 1)):
            for done in (0.25, 0.5, 1.0, 2.0):
                pose = camera.pose(move, done)
                where, looks = centre(pose), axis(pose)
                away = [pivot[index] - where[index] for index in range(3)]
                # As far from it all the way, and it stays on the axis of the camera.
                self.assertAlmostEqual(math.hypot(*away), camera.PIVOT, places=9, msg=(move, done))
                for got, value in zip(looks, away):
                    self.assertAlmostEqual(got, value / camera.PIVOT, places=9, msg=(move, done))
                self.assertGreater(side * where[0], 0, (move, done))
                self.assertEqual(where[1], 0.0)
            # At a speed of 1 it has gone as far to the side as a truck does, turned 30 degrees.
            whole = camera.pose(move, 1.0)
            self.assertAlmostEqual(centre(whole)[0], side * camera.SIDE, places=9)
            self.assertAlmostEqual(math.degrees(math.atan2(-side * axis(whole)[0], axis(whole)[2])), 30, places=9)


class RayTests(unittest.TestCase):
    def test_the_focal_length_is_the_one_videox_fun_reads_its_poses_with(self):
        # Its files give 0.532139961 of the width and 0.946026558 of the height of a 1280 x 720
        # picture, which is made to cover the one drawn: the height decides for a picture less wide
        # than 16:9, the width for a wider one.
        self.assertAlmostEqual(camera.focal(768, 448), 448 * (1280 / 720) * 0.532139961, places=3)
        self.assertAlmostEqual(camera.focal(768, 448), 448 * 0.946026558, places=6)
        self.assertAlmostEqual(camera.focal(1280, 720), 720 * 0.946026558, places=6)
        self.assertAlmostEqual(camera.focal(448, 768), 768 * 0.946026558, places=6)
        self.assertAlmostEqual(camera.focal(1024, 448), 1024 * 0.532139961, places=3)
        self.assertAlmostEqual(camera.focal(1024, 448), (1024 / (1280 / 720)) * 0.946026558, places=6)

    def test_a_pixel_is_given_its_line_of_sight_as_a_moment_and_a_direction(self):
        width, height = 48, 32
        still = camera.rays(torch.tensor([FLAT]), width, height)
        self.assertEqual((tuple(still.shape), still.dtype), ((1, 6, height, width), torch.float32))
        # A camera that has not moved: every line goes through the origin (no moment), each of
        # length one, the middle of the picture straight ahead.
        self.assertEqual(still[0, :3].abs().max().item(), 0)
        self.assertLess((still[0, 3:].norm(dim=0) - 1).abs().max().item(), 1e-6)
        middle = still[0, 3:, height // 2 - 1 : height // 2 + 1, width // 2 - 1 : width // 2 + 1].mean(dim=(1, 2))
        self.assertLess((middle / middle.norm() - torch.tensor([0.0, 0.0, 1.0])).abs().max().item(), 1e-6)
        # The first pixel is seen through its centre, half a pixel in from the corner.
        length = camera.focal(width, height)
        corner = torch.tensor([(0.5 - width / 2) / length, (0.5 - height / 2) / length, 1.0])
        self.assertLess((still[0, 3:, 0, 0] - corner / corner.norm()).abs().max().item(), 1e-6)
        # To the right and down in the picture are the positive x and y.
        self.assertGreater(still[0, 3, 0, -1].item(), 0)
        self.assertGreater(still[0, 4, -1, 0].item(), 0)

    def test_a_camera_that_moved_sees_along_its_own_axes_from_its_own_centre(self):
        width, height = 32, 16
        still = camera.rays(torch.tensor([FLAT]), width, height)[0]
        for move in ('truck_left', 'crane_up', 'dolly_in', 'pan_left', 'tilt_up', 'orbit_right'):
            pose = torch.tensor(camera.pose(move, 0.7), dtype=torch.float64)
            got = camera.rays(pose[None].float(), width, height)[0].double()
            # Each direction is the one of the camera that did not move, turned as the camera is…
            turned = torch.einsum('ij,jhw->ihw', pose[:3, :3], still[3:].double())
            self.assertLess((got[3:] - turned).abs().max().item(), 1e-6, move)
            # … and the moment is centre x direction: zero when the camera only turned.
            where = pose[:3, 3]
            moment = torch.stack(
                [
                    where[1] * turned[2] - where[2] * turned[1],
                    where[2] * turned[0] - where[0] * turned[2],
                    where[0] * turned[1] - where[1] * turned[0],
                ]
            )
            self.assertLess((got[:3] - moment).abs().max().item(), 1e-6, move)
            self.assertEqual(got[:3].abs().max().item() == 0, move in ('pan_left', 'tilt_up'), move)
        with self.assertRaisesRegex(ValueError, '4 x 4'):
            camera.rays(torch.zeros(2, 3, 4), width, height)


class GroupTests(unittest.TestCase):
    def test_the_first_frame_stands_alone_and_the_others_go_four_by_four(self):
        found = camera.places(81)
        self.assertEqual(len(found), 21)
        self.assertEqual(found[:3], [[0, 0, 0, 0], [1, 2, 3, 4], [5, 6, 7, 8]])
        self.assertEqual(found[-1], [77, 78, 79, 80])
        self.assertEqual([len(camera.places(frames)) for frames in (5, 33, 49, 65)], [2, 9, 13, 17])
        for wrong in (80, 82, 4):
            with self.assertRaisesRegex(ValueError, '4n \\+ 1'):
                camera.places(wrong)

    def test_the_adapter_reads_twenty_four_channels_a_latent_frame(self):
        width, height, frames = 32, 16, 13
        cameras = camera.poses('orbit_left', frames, 2.0)
        whole = camera.rays(cameras, width, height)
        found = camera.grouped(cameras, width, height)
        self.assertEqual((tuple(found.shape), found.dtype), ((4, 24, height, width), torch.float32))
        # For each of the six numbers, its four frames one after the other (VideoX-Fun's pipeline:
        # the first frame repeated four times, then frames gathered by four beside each number).
        order = camera.places(frames)
        for latent in range(4):
            for number in range(6):
                for place in range(4):
                    got = found[latent, number * 4 + place]
                    self.assertTrue(torch.equal(got, whole[order[latent][place], number]), (latent, number, place))
        # Asked a few latent frames at a time, in the precision the adapter computes in.
        part = camera.grouped(cameras, width, height, first=1, count=2, dtype=torch.bfloat16)
        self.assertEqual((tuple(part.shape), part.dtype), ((2, 24, height, width), torch.bfloat16))
        self.assertTrue(torch.equal(part, found[1:3].to(torch.bfloat16)))
        self.assertEqual(tuple(camera.grouped(cameras, width, height, first=3, count=5).shape), (1, 24, height, width))
        self.assertEqual(tuple(camera.grouped(cameras, width, height, first=4, count=5).shape), (0, 24, height, width))


if __name__ == '__main__':
    unittest.main()
