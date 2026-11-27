import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

from runner.video import film

ROOT = Path(__file__).resolve().parents[2]


def write_video(path, count=10, fps=24, size=(64, 96), sound=None, hertz=12000):
    """A clip whose frames grow brighter, from black to white: each one is told by its brightness.
    `sound`: its samples (mono, -1 to 1), written beside its pictures."""
    import av

    with av.open(str(path), 'w') as target:
        stream = target.add_stream('mpeg4', rate=fps)
        stream.height, stream.width = size
        stream.pix_fmt = 'yuv420p'
        audio = None
        if sound is not None:
            # (PCM goes in a Matroska file, not in an MP4.)
            audio = target.add_stream('pcm_s16le', rate=hertz)
            audio.layout = 'mono'
        for index in range(count):
            pixels = np.full((size[0], size[1], 3), round(255 * index / (count - 1)), dtype=np.uint8)
            for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format='rgb24')):
                target.mux(packet)
        for packet in stream.encode():
            target.mux(packet)
        if audio is not None:
            write_samples(target, audio, sound, hertz)


def write_samples(target, stream, sound, hertz):
    import av

    samples = np.round(np.clip(np.asarray(sound), -1, 1) * 32767).astype(np.int16)
    for start in range(0, samples.size, 1024):
        frame = av.AudioFrame.from_ndarray(samples[start : start + 1024].reshape(1, -1), format='s16', layout='mono')
        frame.sample_rate = hertz
        for packet in stream.encode(frame):
            target.mux(packet)
    for packet in stream.encode():
        target.mux(packet)


def write_sound(path, sound, hertz=12000):
    import av

    with av.open(str(path), 'w') as target:
        stream = target.add_stream('pcm_s16le', rate=hertz)
        stream.layout = 'mono'
        write_samples(target, stream, sound, hertz)


def tone(seconds, amplitude, hertz=12000):
    """A sine at 440 Hz: its power is amplitude / √2."""
    time = np.arange(round(seconds * hertz)) / hertz
    return amplitude * np.sin(2 * np.pi * 440 * time)


class FilmTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_the_pictures_are_taken_at_regular_intervals_square_and_side_by_side(self):
        from PIL import Image

        video = self.root / 'clip.mp4'
        # 50 pictures at 24 a second: the middles of its six shares fall between two pictures, never on one.
        write_video(video, count=50, size=(64, 128))
        strip, seconds = film.pictures(video, count=6, side=40)
        self.assertAlmostEqual(seconds, 50 / 24, places=2)
        self.assertIsInstance(strip, Image.Image)
        self.assertEqual(strip.size, (240, 40))
        # Each share: the picture shown at its middle (the last one that starts before it), cut square.
        levels = [np.asarray(strip.crop((index * 40, 0, index * 40 + 40, 40)).convert('L')).mean() for index in range(6)]
        shown = [int((index + 0.5) * seconds / 6 * 24) for index in range(6)]
        self.assertEqual(shown, [4, 12, 20, 29, 37, 45])
        for level, index in zip(levels, shown):
            self.assertAlmostEqual(level, 255 * index / 49, delta=3)
        # Two a second by default, four at least: a short clip has four, five seconds ten.
        self.assertEqual(film.pictures(video)[0].size, (5 * film.SIDE, film.SIDE))
        short = self.root / 'short.mp4'
        write_video(short)
        self.assertEqual(film.pictures(short)[0].size, (4 * film.SIDE, film.SIDE))
        long = self.root / 'long.mp4'
        write_video(long, count=24 * 5)
        self.assertEqual(film.pictures(long, side=32)[0].size, (10 * 32, 32))

    def test_more_shares_than_pictures_take_the_same_picture_and_the_last_ones_the_last(self):
        video = self.root / 'clip.mp4'
        write_video(video, count=3, fps=3)
        strip, _ = film.pictures(video, count=9, side=16)
        levels = [round(np.asarray(strip.crop((index * 16, 0, index * 16 + 16, 16)).convert('L')).mean()) for index in range(9)]
        self.assertEqual(len(set(levels[0:3])), 1)
        self.assertEqual(len(set(levels[6:9])), 1)
        self.assertGreater(levels[8], 245)
        self.assertLess(levels[0], 10)
        self.assertTrue(levels[0] < levels[3] < levels[8])

    def test_the_sound_twelve_values_a_second_on_a_scale_of_decibels(self):
        sound = self.root / 'sound.wav'
        # One second at full height, one silent, one at a tenth (-20 dB under the first).
        write_sound(sound, np.concatenate([tone(1, 1.0), np.zeros(12000), tone(1, 0.1)]))
        wave = film.loudness(sound)
        self.assertEqual((wave['rate'], wave['sound'], len(wave['levels'])), (12, True, 36))
        full = round((20 * np.log10(1 / np.sqrt(2)) - film.FLOOR) / -film.FLOOR * 100)
        self.assertEqual(set(wave['levels'][0:12]), {full})
        self.assertEqual(set(wave['levels'][12:24]), {0})
        self.assertEqual(set(wave['levels'][24:36]), {round(full - 20 / -film.FLOOR * 100)})

    def test_a_clip_without_sound_or_with_a_silent_one_has_none(self):
        quiet = self.root / 'quiet.mp4'
        write_video(quiet)
        self.assertEqual(film.loudness(quiet), dict(rate=12, sound=False, levels=[]))
        silent = self.root / 'silent.wav'
        write_sound(silent, np.zeros(6000))
        self.assertEqual(film.loudness(silent), dict(rate=12, sound=False, levels=[0] * 6))

    def test_a_video_with_its_sound_gives_both(self):
        video = self.root / 'clip.mkv'
        write_video(video, count=24, sound=tone(1, 0.5))
        wave, strip = self.root / 'wave.json', self.root / 'strip.jpg'
        result = film.read(video, wave, strip, side=32)
        self.assertEqual((result['sound'], result['frames'], result['side']), (True, 4, 32))
        kept = json.loads(wave.read_text(encoding='utf-8'))
        self.assertEqual((kept['rate'], kept['sound'], len(kept['levels'])), (12, True, 12))
        from PIL import Image

        with Image.open(strip) as image:
            self.assertEqual((image.size, image.format), ((128, 32), 'JPEG'))
        self.assertEqual(sorted(path.name for path in self.root.iterdir() if path.suffix == '.tmp'), [])

    def test_what_is_neither_a_video_nor_a_sound_is_refused_and_a_sound_has_no_pictures(self):
        text = self.root / 'notes.mp4'
        text.write_bytes(b'not a video')
        image = self.root / 'picture.png'
        image.write_bytes(b'not a video')
        for wrong in (text, image, self.root / 'missing.mp4'):
            with self.subTest(path=wrong.name), self.assertRaises(Exception):
                film.read(wrong, self.root / 'wave.json')
        sound = self.root / 'sound.wav'
        write_sound(sound, tone(0.5, 0.5))
        with self.assertRaisesRegex(ValueError, 'images'):
            film.read(sound, self.root / 'wave.json', self.root / 'strip.jpg')
        self.assertEqual(film.read(sound, self.root / 'wave.json'), dict(sound=True, seconds=0.5))

    def test_the_command_runs_apart_from_the_worker_without_loading_a_model(self):
        video = self.root / 'clip.mp4'
        write_video(video)
        wave, strip = self.root / 'wave.json', self.root / 'strip.jpg'
        code = (
            'import json,runpy,sys\n'
            'try:\n'
            "    runpy.run_module('runner', run_name='__main__')\n"
            'except SystemExit as stop:\n'
            '    code = stop.code\n'
            "models = ('torch', 'diffusers', 'transformers', 'runner.engine')\n"
            'heavy = [name for name in models if name in sys.modules]\n'
            'print(json.dumps(dict(code=code, heavy=heavy)), file=sys.stderr)\n'
        )
        command = ['film', '--input', str(video), '--wave', str(wave), '--strip', str(strip), '--count', '5']
        done = subprocess.run([sys.executable, '-s', '-c', code, *command], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(json.loads(done.stderr.splitlines()[-1]), dict(code=0, heavy=[]), done.stderr)
        self.assertEqual(json.loads(done.stdout)['frames'], 5)
        self.assertEqual(json.loads(wave.read_text(encoding='utf-8'))['sound'], False)
        failed = subprocess.run(
            [sys.executable, '-s', '-m', 'runner', 'film', '--input', str(self.root / 'missing.mp4'), '--wave', str(wave)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding='utf-8',
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(len(failed.stderr.strip().splitlines()), 1)
        self.assertIn('vidéo', failed.stderr)


if __name__ == '__main__':
    unittest.main()
