"""(0.6.303) Every image the engine reads is opened as the user sees it (runner.media.open_image)."""

import re
import tempfile
import unittest
from pathlib import Path

from runner import media

ROOT = Path(__file__).resolve().parents[1]


def picture(path, orientation=None, size=(8, 4)):
    """A small picture, red at its left and blue at its right, kept with a note of how to turn it (or none)."""
    from PIL import Image

    image = Image.new('RGB', size, (200, 30, 30))
    for x in range(size[0] // 2, size[0]):
        for y in range(size[1]):
            image.putpixel((x, y), (30, 30, 200))
    exif = Image.Exif()
    if orientation is not None:
        exif[media.ORIENTATION] = orientation
    image.save(path, exif=exif, quality=95)
    return path


class OpenImageTest(unittest.TestCase):
    def setUp(self):
        held = tempfile.TemporaryDirectory()
        self.addCleanup(held.cleanup)
        self.folder = Path(held.name)

    def test_a_photo_kept_lying_is_read_upright(self):
        from PIL import Image

        # A phone held upright keeps its photo lying, with « turn it a quarter »: 6 (or 8, the other way).
        lying = picture(self.folder / 'phone.jpg', orientation=6)
        with Image.open(lying) as kept:
            self.assertEqual(kept.size, (8, 4), 'as its file keeps it')
            wanted = kept.transpose(Image.Transpose.ROTATE_270).convert('RGB')
        with media.open_image(lying) as image:
            self.assertEqual(image.size, (4, 8), 'as it is seen')
            turned = image.convert('RGB')
        self.assertEqual(turned.tobytes(), wanted.tobytes())
        # Red was at its left: it is at its top once upright.
        top, bottom = turned.getpixel((1, 1)), turned.getpixel((1, 6))
        self.assertGreater(top[0], top[2])
        self.assertGreater(bottom[2], bottom[0])
        with media.open_image(picture(self.folder / 'other.jpg', orientation=8)) as image:
            self.assertEqual(image.size, (4, 8))
            self.assertGreater(image.convert('RGB').getpixel((1, 6))[0], 150, 'the other way: red at its bottom')
        # Upside down (3): its size is the same, its picture is not.
        with media.open_image(picture(self.folder / 'down.jpg', orientation=3)) as image:
            self.assertEqual(image.size, (8, 4))
            self.assertGreater(image.convert('RGB').getpixel((6, 1))[0], 150, 'red at its right')

    def test_an_image_kept_upright_is_read_as_it_is(self):
        from PIL import Image

        for name, orientation in (('plain.jpg', None), ('one.jpg', 1), ('made.png', None)):
            path = picture(self.folder / name, orientation)
            with Image.open(path) as kept:
                wanted = kept.convert('RGB').tobytes()
            with media.open_image(path) as image:
                self.assertEqual(image.size, (8, 4))
                self.assertEqual(image.convert('RGB').tobytes(), wanted)
            self.assertEqual((media.orientation(path), media.turned(path)), (1, []))
        # What cannot be read is refused as before, by the same error.
        broken = self.folder / 'broken.png'
        broken.write_bytes(b'not an image')
        with self.assertRaises(OSError):
            media.open_image(broken)

    def test_what_is_kept_of_an_image_to_turn_is_told_apart(self):
        # (Its latents kept on the disk are told by what its file holds: those read lying before are not its own.)
        lying = picture(self.folder / 'phone.jpg', orientation=6)
        self.assertEqual((media.orientation(lying), media.turned(lying)), (6, ['orientation 6']))
        self.assertEqual(media.turned(picture(self.folder / 'down.jpg', orientation=3)), ['orientation 3'])

    def test_every_picture_the_engine_reads_goes_through_it(self):
        # Opened by PIL itself only here, and where a file is only checked to be an image (never read).
        opened = {}
        for path in sorted(ROOT.rglob('*.py')):
            if 'tests' in path.parts:
                continue
            found = len(re.findall(r'\bImage\.open\(', path.read_text(encoding='utf-8')))
            if found:
                opened[path.relative_to(ROOT).as_posix()] = found
        self.assertEqual(opened, {'engine.py': 1, 'media.py': 2, 'pipelines/wan22.py': 1})
        for name in ('engine.py', 'pipelines/wan22.py'):
            source = (ROOT / name).read_text(encoding='utf-8')
            self.assertRegex(source, r'with Image\.open\([^\n]+\) as image:\s+image\.verify\(\)')

    def test_the_size_scail2_reads_is_the_one_seen(self):
        # (No model is loaded for it: the function reads the header of the file.)
        from runner.pipelines import wan_scail2

        self.assertEqual(wan_scail2.image_size(picture(self.folder / 'phone.jpg', orientation=6)), (4, 8))
        self.assertEqual(wan_scail2.image_size(picture(self.folder / 'plain.jpg')), (8, 4))


if __name__ == '__main__':
    unittest.main()
