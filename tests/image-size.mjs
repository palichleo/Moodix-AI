import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from '../lib/image-size.mjs';

// (0.6.303) A photo of a phone taken upright is kept lying in its file, with a note of how to turn it. The
// browser and the engine turn it; its size read here was that of a picture in landscape.
const short = (value, little) => (little ? [value & 255, value >> 8] : [value >> 8, value & 255]),
  long = (value, little) => (little ? [...short(value & 65535, true), ...short(value >>> 16, true)] : [...short(value >>> 16, false), ...short(value & 65535, false)]),
  /** The segment « Exif » of a JPEG whose note says `orientation` (as a number of `type`, `count` times). */
  exif = (orientation, { little = false, type = 3, count = 1, magic = 42 } = {}) => {
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...short(magic, little),
      ...long(8, little),
      // Two entries: the maker (a text elsewhere), then the orientation.
      ...short(2, little),
      ...[...short(0x010f, little), ...short(2, little), ...long(1, little), ...long(0, little)],
      ...[...short(0x0112, little), ...short(type, little), ...long(count, little), ...short(orientation, little), 0, 0],
      ...long(0, little),
    ];
    const body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
    return [0xff, 0xe1, ...short(body.length + 2, false), ...body];
  },
  jfif = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0],
  frame = (width, height) => [0xff, 0xc0, 0x00, 0x11, 8, ...short(height, false), ...short(width, false), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  jpeg = (...segments) => Buffer.from([0xff, 0xd8, ...segments.flat(), ...Array(16).fill(0)]);

test('the size of an image is the one it is seen with: a photo kept lying is said upright (0.6.303)', () => {
  const kept = { width: 4032, height: 3024 },
    upright = { width: 3024, height: 4032 };
  // Without a note, or kept as it is seen (1), mirrored or upside down (2, 3, 4): as it is kept.
  assert.deepEqual(imageSize(jpeg(jfif, frame(4032, 3024))), kept);
  for (const orientation of [1, 2, 3, 4]) assert.deepEqual(imageSize(jpeg(exif(orientation), frame(4032, 3024))), kept, `orientation ${orientation}`);
  // A quarter turn (5 to 8): its width and its height change places, whatever the order of its bytes.
  for (const orientation of [5, 6, 7, 8])
    for (const little of [false, true])
      assert.deepEqual(imageSize(jpeg(jfif, exif(orientation, { little }), frame(4032, 3024))), upright, `orientation ${orientation}`);
  // A real one, written by Pillow: 8 × 4 kept, to turn by a quarter (6).
  const real = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL',
    'base64',
  );
  assert.deepEqual(imageSize(real), { width: 4, height: 8 });
});

test('a note that cannot be read says nothing, and nothing is refused for it (0.6.303)', () => {
  const kept = { width: 640, height: 480 },
    read = (...segments) => imageSize(jpeg(...segments, frame(640, 480)));
  // Not a note of a picture (another magic number, another kind of number, several of them, a value out of its range).
  assert.deepEqual(read(exif(6, { magic: 43 })), kept);
  assert.deepEqual(read(exif(6, { type: 2 })), kept);
  assert.deepEqual(read(exif(6, { count: 2 })), kept);
  assert.deepEqual(read(exif(9)), kept);
  assert.deepEqual(read(exif(0)), kept);
  // Cut short, or of another name: read as far as it goes, without a fault. (Its orientation ends at its 44th
  // byte: cut after it, the note still says it.)
  const whole = exif(6);
  for (let length = 4; length < whole.length; length++) {
    const cut = [...whole.slice(0, 2), ...short(length - 2, false), ...whole.slice(4, length)];
    assert.deepEqual(read(cut), length < 44 ? kept : { width: 480, height: 640 }, `a note of ${length} bytes`);
  }
  const named = [...whole];
  named[4] = 0x58;
  assert.deepEqual(read(named), kept);
  // A note after the frame comes too late to be read; a PNG has its size in its first bytes, as before.
  assert.deepEqual(imageSize(jpeg(frame(640, 480), exif(6))), kept);
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(1024, 16);
  png.writeUInt32BE(768, 20);
  assert.deepEqual(imageSize(png), { width: 1024, height: 768 });
  assert.equal(imageSize(Buffer.alloc(8)), null);
  assert.equal(imageSize(null), null);
});
