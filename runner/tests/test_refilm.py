"""« Changer la caméra » (runner.video.refilm): its rules, said as the Studio and the server say them, the
clip it reads, the cuts it finds, and the job it makes for LTX 2.5. Without the card: the depth is given."""

from fractions import Fraction
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
from unittest import mock

import numpy as np

from runner.registry import family, validate_job
from runner.video import camera_warp as cw
from runner.video import refilm as rf

ROOT = Path(__file__).resolve().parents[2]
BOUNDS = family(rf.FAMILY)['refilm']
LONG = 'Vidéo trop longue pour changer sa caméra : {} s au plus.'


def texture(seed, height, width):
    """A scene of soft shapes [H, W, 3], from 25 to 225: six waves of each colour."""
    rng = np.random.default_rng(seed)
    rows, columns = np.mgrid[0:height, 0:width].astype(np.float32)
    channels = []
    for _ in range(3):
        picture = np.zeros((height, width), np.float32)
        for _ in range(6):
            down, across = rng.uniform(0.004, 0.04, 2)
            picture += np.sin(2 * np.pi * (across * columns + down * rows) + rng.uniform(0, 2 * np.pi))
        channels.append((picture - picture.min()) / np.ptp(picture) * 200 + 25)
    return np.stack(channels, -1)


def pan(seed, step, count, height=144, width=256):
    """`count` frames of a camera that pans `step` pixels a frame over a scene."""
    scene = texture(seed, height, width + step * count)
    return [scene[:, index * step : index * step + width] for index in range(count)]


def cut_of(frames, seed=1):
    """Where cut_at finds the second shot of frames as a file gives them: with a grain of their own."""
    grain = np.random.default_rng(seed)
    held = [np.clip(frame + grain.normal(0, 2, frame.shape), 0, 255).astype(np.uint8) for frame in frames]
    return rf.cut_at([rf.small(frame) for frame in held])


def write(path, frames, fps):
    """A clip whose frames come back as they were written (H.264 in RGB, without loss): its path, and
    the frames as it holds them."""
    held = [np.ascontiguousarray(np.clip(frame, 0, 255).astype(np.uint8)) for frame in frames]
    height, width = held[0].shape[:2]
    writer = cw.lossless(path, width, height, fps)
    try:
        for frame in held:
            writer.send(frame)
    finally:
        writer.close()
    return str(path), held


def with_sound(path, target, seconds):
    """The clip with a tone of `seconds` beside its frames, copied as they are."""
    import imageio_ffmpeg

    tone = f'sine=frequency=440:duration={seconds}'
    command = [imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-i', str(path)]
    command += ['-f', 'lavfi', '-i', tone, '-c:v', 'copy', '-c:a', 'pcm_s16le', str(target)]
    subprocess.run(command, check=True, capture_output=True)
    return str(target)


def job_of(folder, source, **parameters):
    """A job as the application resolves it for this family (its files named, never read here)."""
    files = ('model', 'textEncoder', 'vae', 'audioVae', 'guideLora', 'depth')
    values = dict(prompt='crossview', seed=7, width=160, height=96, steps=8, frames=33, fps=24, hfov=50)
    values.update(lora_strength=1, azimuth=30, elevation=10, distance=1)
    values.update(parameters)
    return dict(
        schemaVersion=1,
        id='refilm-test',
        pipeline=rf.FAMILY,
        mediaType='video',
        workflowId='e33b1ff7-519a-4678-83ff-db6ae4b0459e',
        workflowDigest='0' * 64,
        parameters=values,
        components={role: str(Path(folder) / f'{role}.safetensors') for role in files},
        loras=[],
        references=[dict(input='source', role=rf.ROLE, path=str(source))],
        outputName='2026-11-22_12-00-00_changer-la-camera_ab12',
    )


class Folder(unittest.TestCase):
    def setUp(self):
        held = tempfile.TemporaryDirectory()
        self.addCleanup(held.cleanup)
        self.folder = Path(held.name).resolve()
        rf._SEEN.clear()
        self.addCleanup(rf._SEEN.clear)


class WordsTests(unittest.TestCase):
    def test_the_refusals_are_said_as_the_studio_and_the_server_say_them(self):
        studio = (ROOT / 'public' / 'camera-orbit.mjs').read_text(encoding='utf-8')
        server = (ROOT / 'lib' / 'refilm.mjs').read_text(encoding='utf-8')
        for key in ('out', 'near'):
            with self.subTest(key=key):
                self.assertIn(f"'{rf.SAID[key]}'", studio)
        for key in ('small', 'short', 'invalid'):
            with self.subTest(key=key):
                self.assertIn(f"'{rf.SAID[key]}'", server)
        # (The words with a number: what is around it, as the template of the page writes it.)
        def template(text, start):
            found = re.search('`' + re.escape(start) + '[^`]*`', text)
            return re.split(r'\$\{[^}]*\}', found.group(0)[1:-1])

        with mock.patch.object(rf, 'decimal', lambda value, digits=1: '\0'):
            self.assertEqual(rf.long_said(5).split('\0'), template(server, 'Vidéo trop longue'))
            self.assertEqual(rf.fps_said(8, BOUNDS).split('\0'), template(server, 'Cette vidéo est à'))
            self.assertEqual(rf.size_said('\0', '\0').split('\0'), template(server, 'Taille : au plus'))
            self.assertEqual(rf.shape_said(0.1).split('\0'), template(server, 'Taille : elle garde'))

    def test_numbers_are_written_as_a_french_sentence_writes_them(self):
        for value, digits, said in (
            (5, 1, '5'),
            (5.5, 1, '5,5'),
            (5.25, 1, '5,3'),
            (0.04, 1, '0'),
            (120, 1, '120'),
            (29.97, 2, '29,97'),
            (Fraction(30000, 1001), 2, '29,97'),
            (Fraction(15, 2), 2, '7,5'),
        ):
            with self.subTest(value=value):
                self.assertEqual(rf.decimal(value, digits), said)
        self.assertEqual(rf.long_said(20), LONG.format(20))
        self.assertEqual(
            rf.cut_said(30 / 24),
            'Cette vidéo change de plan à 1,3 s : la caméra ne se change que sur une vidéo d’un seul plan.',
        )
        self.assertEqual(rf.size_said(1600, 896), 'Taille : au plus 1600 × 896, la taille de la vidéo.')
        self.assertEqual(rf.shape_said(0.1), 'Taille : elle garde le format de la vidéo, à 10 % près.')


class CameraTests(unittest.TestCase):
    def refusal(self, end, start=None):
        return rf.camera_refusal(end, start, BOUNDS)

    def test_the_zones_are_ellipses_higher_above_than_below(self):
        for pose, said in (
            ((0, 0), 'safe'),
            ((45, 0), 'safe'),
            ((0, 30), 'safe'),
            ((0, -20), 'safe'),
            ((32, 21), 'safe'),
            ((0, -25), 'maybe'),
            ((40, 20), 'maybe'),
            ((-90, 0), 'maybe'),
            ((0, 45), 'maybe'),
            ((0, -35), 'maybe'),
            ((91, 0), 'out'),
            ((0, -36), 'out'),
            ((70, 30), 'out'),
        ):
            with self.subTest(pose=pose):
                self.assertEqual(rf.zone(pose, BOUNDS['zones']), said)

    def test_what_is_refused_of_a_camera_and_in_which_order(self):
        self.assertEqual(self.refusal((30, 10, 1)), '')
        self.assertEqual(self.refusal((85, 0, 1)), '')
        self.assertEqual(self.refusal((5, 0, 1)), '')
        self.assertEqual(self.refusal((80, 40, 1)), rf.SAID['out'])
        self.assertEqual(self.refusal((3, 2, 1)), rf.SAID['near'])
        # A camera that moves: from the camera of the clip is its ordinary case; both ends near are not.
        self.assertEqual(self.refusal((30, 10, 1), (0, 0, 1)), '')
        self.assertEqual(self.refusal((3, 0, 1), (2, 1, 1)), rf.SAID['near'])
        self.assertEqual(self.refusal((30, 0, 1), (80, 40, 1)), rf.SAID['out'])
        # The distance, which its author says does not work yet; then what is out; then what is near.
        unavailable = BOUNDS['distance']['unavailable']
        self.assertEqual(self.refusal((30, 10, 1.5)), unavailable)
        self.assertEqual(self.refusal((80, 40, 1.5)), unavailable)
        self.assertEqual(self.refusal((3, 0, 1), (80, 40, 1)), rf.SAID['out'])
        for wrong in (True, float('nan'), float('inf'), '30', None):
            with self.subTest(wrong=wrong):
                self.assertEqual(self.refusal((wrong, 0, 1.5)), rf.SAID['invalid'])
                self.assertEqual(self.refusal((30, 0, 1), (0, wrong, 1)), rf.SAID['invalid'])

    def test_a_moving_camera_names_its_whole_start(self):
        held = dict(azimuth=30, elevation=10, distance=1)
        self.assertEqual(rf.poses_of(held), ((30, 10, 1), None))
        moving = dict(held, start_azimuth=0, start_elevation=-5, start_distance=1)
        self.assertEqual(rf.poses_of(moving), ((30, 10, 1), (0, -5, 1)))
        with self.assertRaises(ValueError):
            rf.poses_of(dict(held, start_azimuth=0))


class FormatTests(unittest.TestCase):
    def test_no_limit_for_the_time_it_takes_and_no_time_measured_elsewhere(self):
        # (0.6.248, the user's choice) No size nor length is refused for the time it takes: the Studio warns. (0.6.249)
        # From what this computer took (the history of times of the application), never from times measured on
        # another one: the family only says the size advised (1024 × 576) and the patience.
        for key in ('limits', 'times', 'seconds'):
            with self.subTest(key=key):
                self.assertNotIn(key, BOUNDS)
        self.assertEqual((BOUNDS['advised'], BOUNDS['patience'], BOUNDS['shape']), (1024 * 576, 60, 0.1))
        for width, height in ((1024, 576), (1280, 704), (704, 1280), (1600, 896), (896, 1600), (4096, 2304)):
            with self.subTest(width=width, height=height):
                self.assertEqual(rf.output_format(width, height, 121, 24, BOUNDS)['frames'], 121)
        # What the model films at most, 20 s at 24 a second: as many frames at 120 a second are read, no more.
        self.assertEqual(rf.most_frames(), 481)
        self.assertEqual((rf.most_frames() - 1) / rf.FPS * BOUNDS['sourceFps']['max'], rf.MOST_FRAMES)
        self.assertEqual(rf.output_format(1600, 896, 488, 24, BOUNDS)['frames'], 481)
        self.assertEqual(rf.output_format(768, 448, 2400, Fraction(120), BOUNDS)['frames'], 473)
        with self.assertRaises(rf.Refused) as refused:
            rf.output_format(768, 448, 489, 24, BOUNDS)
        self.assertEqual(str(refused.exception), LONG.format(20))

    def test_the_size_a_clip_is_filmed_at(self):
        def said(width, height, source_width=1600, source_height=896):
            return rf.size_refusal(width, height, source_width, source_height, BOUNDS)

        # At most its own (cut down to multiples of 32), of its shape within 10 %: as large as it is is no refusal.
        for width, height in ((1600, 896), (1280, 704), (1024, 576), (768, 448), (640, 352), (1600, 864)):
            with self.subTest(width=width, height=height):
                self.assertEqual(said(width, height), '')
        for width, height in ((1632, 896), (1600, 928), (2048, 1152)):
            with self.subTest(width=width, height=height):
                self.assertEqual(said(width, height), rf.size_said(1600, 896))
        for width, height in ((896, 896), (1024, 640), (896, 576)):
            with self.subTest(width=width, height=height):
                self.assertEqual(said(width, height), rf.shape_said(0.1))
        # Standing; a size cut down to multiples of 32 is always its own, whatever its shape; the edge of the shape.
        self.assertEqual(said(576, 1024, 1080, 1920), '')
        self.assertEqual(said(1056, 1920, 1080, 1920), '')
        self.assertEqual(said(1088, 1920, 1080, 1920), rf.size_said(1056, 1920))
        self.assertEqual(said(64, 64, 95, 64), '')
        self.assertEqual(said(96, 64, 160, 96), '')
        self.assertEqual(said(352, 320, 1000, 1000), rf.shape_said(0.1))

    def test_the_size_a_clip_is_brought_to_before_it_is_cut(self):
        self.assertEqual(rf.covering(1600, 896, 1024, 576), (1029, 576))
        self.assertEqual(rf.covering(1600, 896, 768, 448), (800, 448))
        self.assertEqual(rf.covering(1080, 1920, 576, 1024), (576, 1024))
        self.assertEqual(rf.covering(1600, 896, 1600, 864), (1600, 896))
        # Its own size cut down to multiples of 32: nothing is shrunk, it is only cut.
        self.assertEqual(rf.covering(1600, 896, 1600, 896), (1600, 896))
        self.assertEqual(rf.covering(170, 100, 160, 96), (170, 100))

    def test_a_frame_is_shrunk_with_every_pixel_counted_then_cut_in_its_middle(self):
        # A gradient across: each pixel shrunk by half is the mean of the two it stands for.
        gradient = np.repeat(np.linspace(0, 255, 160)[None, :, None], 96, axis=0).repeat(3, axis=2).astype(np.uint8)
        half = rf.fitted(gradient, 80, 48)
        self.assertEqual((half.shape, half.dtype, half.flags['C_CONTIGUOUS']), ((48, 80, 3), np.uint8, True))
        expected = (gradient[0, 0::2, 0].astype(np.float32) + gradient[0, 1::2, 0]) / 2
        self.assertLessEqual(float(np.abs(half[24, 4:-4, 0] - expected[4:-4]).max()), 2)
        # Stripes of one pixel are grey once shrunk by half, never stripes again.
        stripes = np.zeros((96, 160, 3), np.uint8)
        stripes[:, ::2] = 255
        grey = rf.fitted(stripes, 80, 48).astype(np.float32)
        self.assertLess(float(np.abs(grey[4:-4, 4:-4] - 127.5).max()), 3)
        # Of another shape: shrunk to cover it (64 × 38), then cut in its middle.
        np.testing.assert_array_equal(rf.fitted(gradient, 64, 32), rf.fitted(gradient, 64, 38)[3:35])
        # Its own size cut down to multiples of 32: the frame cut in its middle, as it is.
        frame = texture(3, 100, 170).astype(np.uint8)
        np.testing.assert_array_equal(rf.fitted(frame, 160, 96), frame[2:98, 5:165])

    def test_the_format_a_clip_is_filmed_again_at(self):
        self.assertEqual(
            rf.output_format(768, 448, 121, Fraction(24), BOUNDS), dict(width=768, height=448, frames=121, covered=121)
        )
        # Cut down to multiples of 32, its frames to 8n + 1 at 24 a second.
        self.assertEqual(
            rf.output_format(800, 450, 100, 24, BOUNDS), dict(width=800, height=448, frames=97, covered=100)
        )
        # At another rate, the frames at 24 a second its length covers: never slowed down.
        self.assertEqual(rf.output_format(768, 448, 81, Fraction(16), BOUNDS)['frames'], 121)
        self.assertEqual(rf.output_format(768, 448, 241, Fraction(48), BOUNDS)['frames'], 121)
        ntsc = rf.output_format(768, 448, 150, Fraction(30000, 1001), BOUNDS)
        self.assertEqual((ntsc['covered'], ntsc['frames']), (120, 113))

    def test_what_is_refused_of_a_clip_and_in_which_order(self):
        rate = (
            'Cette vidéo est à {} images par seconde : la caméra se change sur une vidéo de 12 à 120 images '
            'par seconde.'
        )
        for given, said in (
            ((768, 448, 121, Fraction(8)), rate.format('8')),
            ((768, 448, 121, Fraction(15, 2)), rate.format('7,5')),
            ((768, 448, 121, Fraction(240)), rate.format('240')),
            ((60, 448, 121, Fraction(24)), rf.SAID['small']),
            ((768, 448, 8, Fraction(24)), rf.SAID['short']),
            ((60, 448, 8, Fraction(8)), rate.format('8')),
            ((60, 448, 8, Fraction(24)), rf.SAID['small']),
        ):
            with self.subTest(given=given), self.assertRaises(rf.Refused) as refused:
                rf.output_format(*given, BOUNDS)
            self.assertEqual(str(refused.exception), said)


class PictureTests(unittest.TestCase):
    def test_a_frame_as_a_small_grey_picture_of_its_blocks(self):
        frame = np.zeros((72, 128, 3), np.uint8)
        frame[:36, :, 1] = 200
        picture = rf.small(frame)
        self.assertEqual(picture.shape, (36, 64))
        np.testing.assert_allclose(picture[:18], 0.587 * 200, rtol=1e-5)
        np.testing.assert_array_equal(picture[18:], 0)
        # A frame of LTX: blocks of 12 pixels, the rows left over left out.
        self.assertEqual(rf.small(np.zeros((448, 768, 3), np.uint8)).shape, (37, 64))
        self.assertEqual(rf.small(np.zeros((20, 30, 3), np.uint8)).shape, (20, 30))

    def test_a_picture_almost_even_is_not_compared(self):
        rng = np.random.default_rng(0)
        self.assertIsNone(rf.normal(np.full((36, 64), 128.0)))
        self.assertIsNone(rf.normal(rng.normal(128, 1, (36, 64))))
        seen = rf.normal(rng.normal(128, 30, (36, 64)))
        self.assertAlmostEqual(float(seen.mean()), 0, places=5)
        self.assertAlmostEqual(float(seen.std()), 1, places=5)


class CutTests(unittest.TestCase):
    def test_a_cut_is_found_on_the_first_frame_of_the_second_shot(self):
        for step in (0, 1, 2):
            with self.subTest(step=step):
                self.assertEqual(cut_of(pan(6, step, 30) + pan(7, step, 31)), 30)
        # A frame that mixes both shots, as a file squeezed may hold: the cut is where it starts.
        for step in (0, 1):
            with self.subTest(mixed=step):
                before, after = pan(6, step, 30), pan(7, step, 31)
                after[0] = (before[-1] + after[1]) / 2
                self.assertEqual(cut_of(before + after), 30)

    def test_one_shot_is_not_cut(self):
        clips = {f'a pan of {step} pixels a frame': pan(5, step, 61) for step in (0, 1, 2, 4, 12)}
        clips['from black'] = [frame * min(1.0, index / 20) for index, frame in enumerate(pan(5, 1, 61))]
        clips['the whole picture darker'] = [
            frame * (0.5 if index >= 30 else 1) for index, frame in enumerate(pan(5, 1, 61))
        ]
        clips['a white flash'] = pan(5, 1, 61)
        clips['a white flash'][30] = np.full((144, 256, 3), 255.0)
        steps = [0]
        for index in range(1, 61):
            steps.append(steps[-1] + (40 if 30 <= index < 33 else 1))
        scene = texture(5, 144, 256 + steps[-1])
        clips['a camera whipped round'] = [scene[:, step : step + 256] for step in steps]
        for name, frames in clips.items():
            with self.subTest(name):
                self.assertIsNone(cut_of(frames))

    def test_what_comes_back_is_no_cut(self):
        for step in (0, 1, 2):
            shot = pan(5, step, 61)
            odd, two = list(shot), list(shot)
            odd[30] = texture(99, 144, 256)
            two[30], two[31] = texture(98, 144, 256), texture(97, 144, 256)
            for name, frames in (('a frame that went wrong', odd), ('two', two)):
                with self.subTest(name, step=step):
                    self.assertIsNone(cut_of(frames))
        # Something dark that passes before a camera still or slow, for three frames.
        for step in (0, 1):
            passing = [frame.copy() for frame in pan(5, step, 61)]
            for shift, at in enumerate(range(30, 33)):
                passing[at][:, 40 + 20 * shift : 140 + 20 * shift] = 15
            with self.subTest(passing=step):
                self.assertIsNone(cut_of(passing))

    def test_what_is_not_found(self):
        # A cut within a camera that moves fast, whose every frame changes nearly as much.
        self.assertIsNone(cut_of(pan(6, 12, 30) + pan(7, 12, 31)))
        # A shot that fades into the next.
        first, second = pan(6, 1, 61), pan(7, 1, 61)
        share = [min(1.0, max(0.0, (index - 25) / 11)) for index in range(61)]
        self.assertIsNone(cut_of([a * (1 - part) + b * part for a, b, part in zip(first, second, share)]))
        # A cut in the last frames, or a first frame of another shot: a shot of a few frames, or one.
        self.assertIsNone(cut_of(pan(6, 1, 58) + pan(7, 1, 3)))
        self.assertIsNone(cut_of(pan(6, 1, 1) + pan(7, 1, 60)))


class ClipTests(Folder):
    def test_a_clip_is_read_once_as_it_will_be_filmed(self):
        path, held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 96, 160), 24)
        found = rf.examine(path, BOUNDS)
        expected = dict(width=160, height=96, frames=33, covered=33, sourceWidth=160, sourceHeight=96)
        self.assertEqual(found, dict(expected, sourceFrames=33, fps=Fraction(24), seconds=1.375, audio=False))
        # Asked again (by the application, then by the worker): the file is not read again.
        with mock.patch('runner.video.stream.frames', side_effect=AssertionError('read again')):
            self.assertIs(rf.examine(path, BOUNDS), found)
        clip, exact = rf.frames_of(path, found, 33)
        self.assertTrue(exact)
        self.assertEqual(len(clip), 33)
        np.testing.assert_array_equal(clip[7], held[7])

    def test_a_clip_larger_and_faster_is_cut_in_its_middle_and_timed_again(self):
        path, held = write(self.folder / 'clip.mkv', pan(5, 1, 41, 100, 170), 30)
        found = rf.examine(path, BOUNDS)
        self.assertEqual((found['width'], found['height'], found['covered'], found['frames']), (160, 96, 33, 33))
        self.assertEqual((found['sourceWidth'], found['sourceHeight'], found['fps']), (170, 100, Fraction(30)))
        wanted = rf.picked(found, 33)
        self.assertEqual((wanted[:8], wanted[-1]), ([0, 1, 3, 4, 5, 6, 8, 9], 40))
        clip, exact = rf.frames_of(path, found, 33)
        self.assertFalse(exact)
        np.testing.assert_array_equal(clip[2], held[3][2:98, 5:165])
        np.testing.assert_array_equal(clip[32], held[40][2:98, 5:165])

    def test_a_clip_at_a_smaller_size_is_shrunk_to_cover_it_then_cut_in_its_middle(self):
        path, held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 128, 224), 24)
        found = rf.examine(path, BOUNDS)
        self.assertEqual((found['width'], found['height']), (224, 128))
        clip, exact = rf.frames_of(path, found, 33, (160, 96))
        self.assertFalse(exact)
        self.assertEqual(clip[0].shape, (96, 160, 3))
        for index in (0, 17, 32):
            np.testing.assert_array_equal(clip[index], rf.fitted(held[index], 160, 96))
        # (Brought to 168 × 96, which covers it, then cut by 4 columns on each side.)
        self.assertEqual(rf.covering(224, 128, 160, 96), (168, 96))
        # At its own size and rate, the file is read as it is.
        self.assertTrue(rf.frames_of(path, found, 33, (224, 128))[1])

    def test_a_slower_clip_shows_each_frame_for_its_time(self):
        path, _held = write(self.folder / 'clip.mkv', pan(5, 1, 21, 96, 160), 16)
        found = rf.examine(path, BOUNDS)
        self.assertEqual((found['covered'], found['frames']), (31, 25))
        self.assertEqual(rf.picked(found, 25)[:9], [0, 1, 1, 2, 3, 3, 4, 5, 5])

    def test_what_the_file_says_is_refused_in_words_and_once(self):
        slow, _held = write(self.folder / 'slow.mkv', pan(5, 1, 9, 96, 160), 8)
        with self.assertRaises(rf.Refused) as refused:
            rf.examine(slow, BOUNDS)
        self.assertEqual(str(refused.exception), rf.fps_said(Fraction(8), BOUNDS))
        cut, _held = write(self.folder / 'cut.mkv', pan(6, 1, 16, 96, 160) + pan(7, 1, 17, 96, 160), 24)
        with self.assertRaises(rf.Refused) as refused:
            rf.examine(cut, BOUNDS)
        self.assertEqual(str(refused.exception), rf.cut_said(16 / 24))
        with mock.patch('runner.video.stream.frames', side_effect=AssertionError('read again')):
            with self.assertRaises(rf.Refused):
                rf.examine(cut, BOUNDS)
        # Longer than the model films: once its frames are more than it films (here 25, 1 s), or than are read at
        # most (here 20: longer than 20 s at 120 a second, whatever its rate).
        clip, _held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 96, 160), 24)
        for patch, said in (
            (mock.patch.object(rf, 'most_frames', return_value=25), LONG.format(1)),
            (mock.patch.object(rf, 'MOST_FRAMES', 20), LONG.format(20)),
        ):
            rf._SEEN.clear()
            with self.subTest(said=said), patch, self.assertRaises(rf.Refused) as refused:
                rf.examine(clip, BOUNDS)
            self.assertEqual(str(refused.exception), said)

    def test_a_clip_replaced_since_its_check_is_refused(self):
        path, _held = write(self.folder / 'clip.mkv', pan(5, 1, 17, 96, 160), 24)
        found = dict(rf.examine(path, BOUNDS), sourceFrames=33, covered=33, frames=33)
        with self.assertRaises(rf.Refused) as refused:
            rf.frames_of(path, found, 33)
        self.assertEqual(str(refused.exception), rf.SAID['changed'])


class JobTests(Folder):
    def test_a_job_of_the_application_passes_with_a_camera_held_moving_or_turning_round_a_point(self):
        source = self.folder / 'clip.mkv'
        for extra in (
            {},
            dict(start_azimuth=0, start_elevation=0, start_distance=1),
            dict(pivot_x=0.3, pivot_y=0.6),
            dict(source_width=224, source_height=128),
        ):
            with self.subTest(**extra):
                job = job_of(self.folder, source, **extra)
                self.assertIs(validate_job(job), job)

    def test_what_the_job_must_hold(self):
        source = self.folder / 'clip.mkv'
        manifest = family(rf.FAMILY)
        twice = job_of(self.folder, source)
        twice['references'] *= 2
        unnamed = job_of(self.folder, source)
        del unnamed['parameters']['azimuth']
        half = (
            job_of(self.folder, source, pivot_x=0.5),
            job_of(self.folder, source, start_azimuth=0),
            job_of(self.folder, source, source_width=224),
        )
        for job in (twice, unnamed, *half):
            with self.subTest(job=job['parameters']), self.assertRaises(ValueError) as failed:
                rf.check(job, manifest)
            self.assertNotIsInstance(failed.exception, rf.Refused)
        for parameters, said in (
            (dict(azimuth=80, elevation=40), rf.SAID['out']),
            (dict(azimuth=3, elevation=2), rf.SAID['near']),
            (dict(distance=1.5), BOUNDS['distance']['unavailable']),
            (dict(width=256, height=128, source_width=224, source_height=128), rf.size_said(224, 128)),
            (dict(width=192, height=96, source_width=224, source_height=128), rf.shape_said(0.1)),
        ):
            with self.subTest(**parameters), self.assertRaises(rf.Refused) as refused:
                rf.check(job_of(self.folder, source, **parameters), manifest)
            self.assertEqual(str(refused.exception), said)
        # (0.6.248) Large or long, nothing is refused for the time it takes: the Studio says it before.
        for parameters in (
            dict(width=1600, height=896, frames=481),
            dict(width=1024, height=576, source_width=1600, source_height=896, frames=241),
        ):
            with self.subTest(**parameters):
                self.assertIsNone(rf.check(job_of(self.folder, source, **parameters), manifest))
        # Beyond the bars of the Studio, the manifest refuses it first.
        with self.assertRaises(ValueError):
            validate_job(job_of(self.folder, source, azimuth=120))

    def test_the_job_ltx_25_makes_of_it(self):
        refilm = job_of(self.folder, self.folder / 'clip.mkv', seed=11, lora_strength=0.8)
        guide, source = self.folder / 'guide.mkv', self.folder / 'source.mkv'
        made = validate_job(rf.ltx_job(refilm, guide, source))
        self.assertEqual(made['pipeline'], 'ltx25')
        self.assertEqual(
            made['parameters'],
            dict(prompt='crossview', seed=11, width=160, height=96, steps=8, frames=33, fps=24, stage='final')
            | dict(audio=False),
        )
        lora = dict(id='crossview-warp', path=refilm['components']['guideLora'], strength=0.8)
        self.assertEqual(made['loras'], [lora])
        # The guide first, then the clip: the order the IC-LoRA was taught.
        self.assertEqual(
            [(ref['input'], ref['role'], ref['path']) for ref in made['references']],
            [('guide', 'reference_video', str(guide)), ('source', 'reference_video', str(source))],
        )
        self.assertEqual(set(made['components']), {'model', 'textEncoder', 'vae', 'audioVae'})
        self.assertEqual(made['outputName'], refilm['outputName'])

    def test_the_checks_before_the_card_read_the_clip_and_the_depth_file(self):
        path, _held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 96, 160), 24)
        refilm, given = job_of(self.folder, path), []
        with (
            mock.patch('runner.models.headers.header', return_value={'__metadata__': {}}) as header,
            mock.patch('runner.models.moge2.validate_layout') as layout,
        ):
            rf.preflight(refilm, {}, lambda job, config: given.append(job))
        header.assert_called_once_with(refilm['components']['depth'])
        layout.assert_called_once_with({'__metadata__': {}})
        references = [(ref['role'], ref['path']) for ref in given[0]['references']]
        self.assertEqual(references, [('reference_video', path)] * 2)
        # A record that says another size, or more frames than the file holds: the clip changed since.
        for wrong in (dict(width=128), dict(frames=41)):
            with self.subTest(**wrong), self.assertRaises(rf.Refused) as refused:
                rf.preflight(job_of(self.folder, path, **wrong), {}, lambda job, config: None)
            self.assertEqual(str(refused.exception), rf.SAID['changed'])

    def test_the_checks_before_the_card_compare_the_size_of_the_clip_not_the_size_chosen(self):
        path, _held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 128, 224), 24)
        given = []
        with (
            mock.patch('runner.models.headers.header', return_value={'__metadata__': {}}),
            mock.patch('runner.models.moge2.validate_layout'),
        ):
            chosen = job_of(self.folder, path, width=160, height=96, source_width=224, source_height=128)
            rf.preflight(chosen, {}, lambda job, config: given.append(job))
            # The job LTX 2.5 makes of it is at the size chosen.
            self.assertEqual((given[0]['parameters']['width'], given[0]['parameters']['height']), (160, 96))
            for wrong, said in (
                (dict(source_width=256), rf.SAID['changed']),
                (dict(width=224, height=128, source_width=None, source_height=None), None),
                (dict(width=192, height=96), rf.shape_said(0.1)),
            ):
                parameters = dict(chosen['parameters'], **wrong)
                for key in [key for key, value in parameters.items() if value is None]:
                    del parameters[key]
                job = dict(chosen, parameters=parameters)
                with self.subTest(**wrong):
                    if said is None:
                        rf.preflight(job, {}, lambda job, config: None)
                        continue
                    with self.assertRaises(rf.Refused) as refused:
                        rf.preflight(job, {}, lambda job, config: None)
                    self.assertEqual(str(refused.exception), said)


class DispatchTests(unittest.TestCase):
    def test_ltx_25_hands_a_refilm_to_its_module(self):
        from runner.pipelines import ltx25

        job, manifest = dict(pipeline=rf.FAMILY), dict(refilm={})
        with (
            mock.patch.object(rf, 'check') as check,
            mock.patch.object(rf, 'preflight') as preflight,
            mock.patch.object(rf, 'generate', return_value='video') as generate,
        ):
            ltx25.check(job, manifest)
            ltx25.preflight(job, {})
            self.assertEqual(ltx25.generate(job, {}, None), 'video')
        check.assert_called_once_with(job, manifest)
        preflight.assert_called_once_with(job, {}, ltx25._preflight)
        generate.assert_called_once_with(job, {}, None, ltx25._run)

    def test_the_model_is_kept_under_the_name_of_the_family_and_the_video_written_by_its_finish(self):
        from types import SimpleNamespace

        from runner.models import kept
        from runner.pipelines import ltx25

        parameters = dict(width=160, height=96, frames=33)
        job = dict(components={'model': 'model'}, loras=[], references=[], parameters=parameters)
        given = []

        def run(_job, _config, _progress, key, holder, finish=None, read=None):
            given.append(finish)
            holder[0] = SimpleNamespace(key=key, locked=True, allocated=0, drop=lambda: None)
            return 'video'

        finish = object()
        with (
            mock.patch('runner.models.conditioning.stamp', side_effect=lambda path: [path, 1, 1]),
            mock.patch.object(ltx25, '_generate', run),
        ):
            try:
                self.assertEqual(ltx25._run(job, {}, None, name=rf.FAMILY, finish=finish), 'video')
                self.assertEqual((set(kept._kept), given), ({rf.FAMILY}, [finish]))
            finally:
                kept._kept.clear()


def depth_of(frames, moge_path, told):
    """The depths MoGe-2 would give, without it: a floor that goes away up the frame."""
    told(len(frames), len(frames))
    height, width = frames[0].shape[:2]
    floor = np.linspace(4.0, 2.0, height)[:, None] * np.ones((1, width))
    return [floor.copy() for _ in frames], [50.0] * len(frames), [1.0] * len(frames)


class PrepareTests(Folder):
    def prepare(self, job, free_gib=8.0):
        told, work = [], self.folder / 'work'
        work.mkdir()
        with (
            mock.patch.object(cw, 'depths', side_effect=depth_of) as depths,
            mock.patch('runner.hardware.free_bytes', return_value=free_gib * 1024**3),
            mock.patch('runner.models.kept.drop', return_value=True) as drop,
            mock.patch('torch.cuda.empty_cache'),
            mock.patch('torch.cuda.reset_peak_memory_stats'),
            mock.patch('torch.cuda.max_memory_allocated', return_value=int(1.6 * 1024**3)),
        ):
            converted, finish = rf.prepare(job, {}, lambda **said: told.append(said), work)
        self.assertEqual(depths.call_args.args[1], job['components']['depth'])
        with mock.patch('runner.video.export.save_video', return_value='saved') as save:
            self.assertEqual(finish('pixels', dict(seed=7, stage='final')), 'saved')
        return converted, told, drop, save.call_args

    def test_a_clip_of_ltx_is_read_as_it_is_and_keeps_its_sound(self):
        from runner.video.stream import frames as decode, probe

        silent, _held = write(self.folder / 'silent.mkv', pan(5, 1, 33, 96, 160), 24)
        path = with_sound(silent, self.folder / 'clip.mkv', 2)
        job = job_of(self.folder, path, start_azimuth=0, start_elevation=0, start_distance=1)
        converted, told, drop, saved = self.prepare(job)
        guide = self.folder / 'work' / 'guide.mkv'
        self.assertEqual([ref['path'] for ref in converted['references']], [str(guide), path])
        self.assertEqual(probe(guide)['fps'], Fraction(24))
        drawn = list(decode(guide))
        self.assertEqual((len(drawn), drawn[0].shape), (33, (96, 160, 3)))
        drop.assert_not_called()
        stages = [(said['stage'], said.get('frame')) for said in told]
        self.assertEqual(
            stages,
            [('reading video to refilm', None), ('estimating depth', 0), ('estimating depth', 33)]
            + [('drawing new camera', frame) for frame in (1, 16, 31, 33)],
        )
        pixels, config, made_for, metadata = saved.args
        self.assertEqual((pixels, config, made_for), ('pixels', {}, job))
        self.assertNotIn('stage', metadata)
        self.assertEqual((metadata['seed'], metadata['job'], metadata['audio']), (7, job, True))
        summary = metadata['refilm']
        self.assertEqual(summary['camera'], dict(azimuth=30, elevation=10, distance=1))
        self.assertEqual(summary['start'], dict(azimuth=0, elevation=0, distance=1))
        self.assertEqual(len(summary['pivot']), 3)
        self.assertNotIn('pivotNamed', summary)
        self.assertEqual(summary['depth']['peakGiB'], 1.6)
        self.assertEqual(
            summary['source'],
            dict(width=160, height=96, frames=33, fps=24.0, timedAgain=False, shrunk=False, cut=False, sound=True),
        )
        self.assertTrue(all(0 <= value <= 1 for value in summary['holes'].values()))
        sound, rate = saved.kwargs['audio']
        self.assertEqual((sound.shape, rate), ((66000, 2), 48000))
        self.assertGreater(float(np.abs(sound).max()), 0.05)

    def test_another_clip_is_timed_again_and_cut_and_the_card_freed_for_the_depth(self):
        from runner.video.stream import frames as decode

        path, held = write(self.folder / 'clip.mkv', pan(5, 1, 41, 100, 170), 30)
        job = job_of(self.folder, path, pivot_x=0.3, pivot_y=0.6)
        converted, _told, drop, saved = self.prepare(job, free_gib=1.0)
        drop.assert_called_once_with()
        source = self.folder / 'work' / 'source.mkv'
        self.assertEqual(converted['references'][1]['path'], str(source))
        timed = list(decode(source))
        self.assertEqual(len(timed), 33)
        np.testing.assert_array_equal(timed[2], held[3][2:98, 5:165])
        metadata = saved.args[3]
        self.assertEqual(metadata['refilm']['pivotNamed'], [0.3, 0.6])
        self.assertEqual(
            metadata['refilm']['source'],
            dict(width=170, height=100, frames=41, fps=30.0, timedAgain=True, shrunk=False, cut=True, sound=False),
        )
        self.assertFalse(metadata['audio'])
        self.assertIsNone(saved.kwargs['audio'])

    def test_a_clip_filmed_at_a_smaller_size_is_shrunk_first_and_all_is_made_at_that_size(self):
        from runner.video.stream import frames as decode

        path, held = write(self.folder / 'clip.mkv', pan(5, 1, 33, 128, 224), 24)
        job = job_of(self.folder, path, width=160, height=96, source_width=224, source_height=128)
        converted, _told, _drop, saved = self.prepare(job)
        # The depth of the clip shrunk, its guide and LTX 2.5 at the size chosen; the clip as LTX reads it, shrunk.
        source = self.folder / 'work' / 'source.mkv'
        self.assertEqual(converted['references'][1]['path'], str(source))
        self.assertEqual((converted['parameters']['width'], converted['parameters']['height']), (160, 96))
        guide = list(decode(self.folder / 'work' / 'guide.mkv'))
        self.assertEqual((len(guide), guide[0].shape), (33, (96, 160, 3)))
        shrunk = list(decode(source))
        np.testing.assert_array_equal(shrunk[9], rf.fitted(held[9], 160, 96))
        self.assertEqual(
            saved.args[3]['refilm']['source'],
            dict(width=224, height=128, frames=33, fps=24.0, timedAgain=False, shrunk=True, cut=True, sound=False),
        )
        # What the video is written with: the job, its size the one chosen.
        self.assertEqual((saved.args[3]['parameters']['width'], saved.args[3]['parameters']['height']), (160, 96))

    def test_the_work_is_removed_after_the_video_and_after_a_failure(self):
        made = []

        def prepare(job, config, progress, folder):
            made.append(Path(folder))
            (Path(folder) / 'guide.mkv').write_bytes(b'guide')
            return dict(converted=True), 'finish'

        def run(converted, config, progress, name, finish):
            self.assertEqual((converted, name, finish), (dict(converted=True), rf.FAMILY, 'finish'))
            self.assertTrue((made[-1] / 'guide.mkv').exists())
            return 'video'

        old, fresh = self.folder / (rf.WORK + 'old'), self.folder / (rf.WORK + 'fresh')
        old.mkdir()
        fresh.mkdir()
        hour_ago = time.time() - rf.STALE_SECONDS - 60
        os.utime(old, (hour_ago, hour_ago))
        with (
            mock.patch('tempfile.gettempdir', return_value=str(self.folder)),
            mock.patch.object(rf, 'prepare', prepare),
        ):
            self.assertEqual(rf.generate({}, {}, None, run), 'video')
            self.assertFalse(made[-1].exists())
            with self.assertRaises(RuntimeError):
                rf.generate({}, {}, None, mock.Mock(side_effect=RuntimeError('out of memory')))
            self.assertFalse(made[-1].exists())
        self.assertEqual((old.exists(), fresh.exists()), (False, True))
        self.assertEqual(made[0].parent, self.folder)


if __name__ == '__main__':
    unittest.main()
