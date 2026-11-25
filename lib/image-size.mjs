/**
 * Width and height of a PNG or JPEG from its first bytes, or null: enough to know the format
 * of an image a video starts from without decoding it.
 *
 * (0.6.303) As the image is seen: a photo of a phone taken upright is kept lying in its file, with a note
 * of how to turn it (EXIF). The browser turns it, the engine too (runner.media.open_image); read as it is
 * kept, its width and its height were those of a picture in landscape, and the video made from it took
 * that format when the image was joined to the chat (a reference of the project, measured by the page,
 * gave the right one).
 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('latin1', 12, 16) === 'IHDR')
    return size(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2,
    lying = false;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Start-of-frame markers carry the size; C4, C8 and CC are tables, not frames.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const width = bytes.readUInt16BE(offset + 7),
        height = bytes.readUInt16BE(offset + 5);
      return lying ? size(height, width) : size(width, height);
    }
    const length = bytes.readUInt16BE(offset + 2);
    // Its note, when it has one: before the frame, in a segment of its own (APP1).
    if (marker === 0xe1) lying ||= turnedSideways(bytes.subarray(offset + 4, offset + 2 + length));
    offset += 2 + length;
  }
  return null;
}

/**
 * Whether the note of a JPEG (the bytes of its segment « Exif ») says to turn the picture by a quarter turn:
 * orientations 5 to 8, which swap its width and its height. A note cut short or written otherwise says nothing.
 */
function turnedSideways(exif) {
  if (exif.length < 14 || exif.toString('latin1', 0, 6) !== 'Exif\0\0') return false;
  const tiff = exif.subarray(6),
    order = tiff.toString('latin1', 0, 2),
    little = order === 'II';
  if (!little && order !== 'MM') return false;
  const u16 = at => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at)),
    u32 = at => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return false;
  const first = u32(4);
  if (first + 2 > tiff.length) return false;
  const entries = u16(first);
  for (let index = 0; index < entries; index++) {
    const at = first + 2 + index * 12;
    if (at + 12 > tiff.length) return false;
    // Orientation: one short number.
    if (u16(at) === 0x0112) return u16(at + 2) === 3 && u32(at + 4) === 1 && u16(at + 8) >= 5 && u16(at + 8) <= 8;
  }
  return false;
}

function size(width, height) {
  return width > 0 && height > 0 && width <= 131072 && height <= 131072 ? { width, height } : null;
}
