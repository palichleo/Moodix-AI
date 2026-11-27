import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  LAYOUT_LABELS,
  LAYOUT_LIMITS,
  LAYOUT_NAMES,
  LAYOUT_SAYS,
  drawnBox,
  layoutBoxes,
  layoutCall,
  layoutCaption,
  layoutCount,
  layoutOf,
  layoutPrompt,
  layoutReady,
  layoutRecord,
  layoutSaid,
  layoutTitle,
  layoutTooLong,
  layoutUnread,
  layoutWords,
  pixelBox,
  readLayoutPrompt,
  unfinishedBoxes,
} from '../public/layout-boxes.mjs';

// (21/11) The boxes of a MOSS Image layout (public/layout-boxes.mjs): the numbers the model reads, checked against
// the examples of the official guide and README, and the boxes the Studio gets back when it opens a take again.
const box = (x, y, w, h, more = {}) => ({ x, y, w, h, label: 'object', caption: 'a thing', ...more });
const size = (width, height) => ({ width, height });
const SQUARE = size(1024, 1024);
/** A list of numbers that is always the same (mulberry32), so that a failure can be found again. */
function numbers(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Boxes as a hand would draw them: anywhere, of any size from the smallest, every label, words of every kind. */
function drawn(count, seed) {
  const next = numbers(seed);
  return Array.from({ length: count }, (_, index) => {
    const x = next() * 0.9,
      y = next() * 0.9,
      small = LAYOUT_LIMITS.smallest;
    return {
      x,
      y,
      w: small + next() * (1 - x - small),
      h: small + next() * (1 - y - small),
      label: LAYOUT_LABELS[index % 3],
      caption: `Box ${index} « é 東京 » "quoted" \\ ${'😀'.repeat(index)}\nsecond line`,
      text: index % 3 === 2 ? `WORD ${index}\nLINE` : '',
      palette: index % 2 ? ['#a1b2c3', '#FFF'] : [],
    };
  });
}

test('labels and limits are frozen; the prompt limit is what the engine takes (runner/families/moss.json)', () => {
  assert.deepEqual(LAYOUT_LABELS, ['object', 'character', 'text']);
  assert.ok(Object.isFrozen(LAYOUT_LABELS) && Object.isFrozen(LAYOUT_LIMITS));
  const moss = JSON.parse(readFileSync(new URL('../runner/families/moss.json', import.meta.url), 'utf8'));
  assert.equal(moss.parameters.prompt.maxLength, LAYOUT_LIMITS.prompt);
});

test('the official guide: on 1536 x 1024, the draft box [176, 224, 800, 864] is [-288, -592, 352, 32]', () => {
  // The draft box is in pixels from the top left; the Studio holds it as fractions of the picture.
  const drawnBox = box(176 / 1536, 224 / 1024, 624 / 1536, 640 / 1024);
  assert.deepEqual(pixelBox(drawnBox, size(1536, 1024)), [-288, -592, 352, 32]);
});

test('the example of the README, written again from its boxes on 1024 x 1024, is its layout in one line', () => {
  const prompt =
    'A minimalist travel poster with a cream background, a blue mountain illustration, ' +
    'and the title EXPLORE at the top.';
  const boxes = [
    box(128 / 1024, 96 / 1024, 768 / 1024, 128 / 1024, {
      label: 'text',
      caption: 'Large dark-blue uppercase title centered at the top.',
      text: 'EXPLORE',
    }),
    box(224 / 1024, 320 / 1024, 576 / 1024, 576 / 1024, {
      caption: 'A flat blue mountain illustration in the lower center.',
    }),
  ];
  assert.equal(
    layoutPrompt(prompt, boxes, SQUARE),
    '{"summary":{"caption":"A minimalist travel poster with a cream background, a blue mountain illustration, ' +
      'and the title EXPLORE at the top."},"items":[{"label":"text","caption":"Large dark-blue uppercase title ' +
      'centered at the top.","text":"EXPLORE","bbox":[-416,-384,-288,384]},{"label":"object","caption":"A flat ' +
      'blue mountain ' +
      'illustration in the lower center.","bbox":[-192,-288,384,288]}],"bbox_coord_space":"abs_centralized",' +
      '"bbox_format":"yxyx"}',
  );
});

test('pictures that are not square: the start goes down to a whole pixel, the end up, both from the centre', () => {
  const wide = box(0.1, 0.25, 0.3333, 0.5);
  // 0.1 x 1344 = 134.4 → 134 - 672; 0.4333 x 1344 = 582.36 → 583 - 672; 0.25 x 768 = 192 → 192 - 384.
  assert.deepEqual(pixelBox(wide, size(1344, 768)), [-192, -538, 192, -89]);
  // The same box on the same picture turned: 0.1 x 768 = 76.8 → 76 - 384; 0.4333 x 768 = 332.77 → 333 - 384.
  assert.deepEqual(pixelBox(wide, size(768, 1344)), [-336, -308, 336, -51]);
  // A box of the user's MOSS workflow in ComfyUI, drawn at 288, 1344, 448 x 592 pixels on 1088 x 1936. ComfyUI's
  // Create Bounding Boxes first keeps a thousandth of the side (694 / 1000 x 1936 = 1343.58) and writes 375 for the
  // top; the box as drawn is at 1344, so 376 here.
  const comfy = box(288 / 1088, 1344 / 1936, 448 / 1088, 592 / 1936);
  assert.deepEqual(pixelBox(comfy, size(1088, 1936)), [376, -256, 968, 192]);
});

test('float noise does not push an edge one pixel out: edges are rounded to nine decimals first, as officially', () => {
  assert.equal(Math.ceil((0.1 + 0.2) * 1280), 385, 'the noise this test is about');
  assert.deepEqual(pixelBox(box(0.1, 0.1, 0.2, 0.2), size(1280, 1280)), [-512, -512, -256, -256]);
  // An edge a real tenth of a pixel past a whole one still goes to the next pixel.
  assert.deepEqual(pixelBox(box(0, 0, 0.30008, 0.30008), size(1280, 1280)), [-640, -640, -255, -255]);
});

test('the centre of an odd side is counted like Python\'s // (500 for 1001)', () => {
  assert.deepEqual(pixelBox(box(0, 0, 1, 1), size(1001, 1001)), [-500, -500, 501, 501]);
  assert.deepEqual(pixelBox(box(0.5, 0.5, 0.25, 0.25), size(1001, 1001)), [0, 0, 251, 251]);
  assert.equal(pixelBox(box(0, 0, 1, 1), size(0, 1001)), null);
  assert.equal(pixelBox(box(0, 0, 1, 1), size(10.5, 1001)), null);
  assert.equal(pixelBox('a box', SQUARE), null);
});

test('boxes, prompt, boxes again: every edge within a pixel; prompt, boxes, prompt again: the same characters', () => {
  const sizes = [size(1024, 1024), size(1344, 768), size(768, 1344), size(1088, 1936), size(1536, 1024)];
  sizes.push(size(1456, 1456), size(256, 256), size(4096, 2304), size(16, 16));
  sizes.forEach((picture, turn) => {
    const boxes = layoutBoxes(drawn(LAYOUT_LIMITS.boxes, 11 + turn));
    const prompt = layoutPrompt(`A poster, take ${turn}`, boxes, picture);
    assert.equal(typeof prompt, 'string', `${picture.width} x ${picture.height}`);
    const read = readLayoutPrompt(prompt, picture);
    assert.equal(read.prompt, `A poster, take ${turn}`);
    assert.deepEqual(read.left, []);
    assert.equal(read.boxes.length, boxes.length);
    const pixelX = 1 / picture.width + 1e-12,
      pixelY = 1 / picture.height + 1e-12;
    read.boxes.forEach((again, index) => {
      const first = boxes[index],
        where = `${picture.width} x ${picture.height}, box ${index}`;
      const words = each => [each.label, each.caption, each.text, each.palette];
      assert.deepEqual(words(again), words(first));
      // The box read again holds the one drawn, and is at most a pixel larger on each side.
      assert.ok(again.x <= first.x + 1e-12 && first.x - again.x <= pixelX, `${where}: left`);
      assert.ok(again.y <= first.y + 1e-12 && first.y - again.y <= pixelY, `${where}: top`);
      const right = again.x + again.w - (first.x + first.w),
        bottom = again.y + again.h - (first.y + first.h);
      assert.ok(right >= -1e-12 && right <= pixelX, `${where}: right`);
      assert.ok(bottom >= -1e-12 && bottom <= pixelY, `${where}: bottom`);
    });
    assert.equal(layoutPrompt(read.prompt, read.boxes, picture), prompt, `${picture.width} x ${picture.height}`);
    assert.deepEqual(readLayoutPrompt(layoutPrompt(read.prompt, read.boxes, picture), picture), read);
  });
});

test('a text box writes its words and the others none; a palette goes only where there is one', () => {
  const boxes = [
    box(0, 0, 0.5, 0.5, { label: 'object', text: 'NOT WRITTEN', palette: ['#ff0000'] }),
    box(0.5, 0, 0.5, 0.5, { label: 'character', caption: 'a fox in a red coat', text: 'NOT WRITTEN' }),
    box(0, 0.5, 1, 0.5, { label: 'text', caption: 'bold white letters', text: 'HELLO\nWORLD' }),
  ];
  const items = JSON.parse(layoutPrompt('A poster', boxes, SQUARE)).items;
  assert.deepEqual(items, [
    { label: 'object', caption: 'a thing', palette: ['#FF0000'], bbox: [-512, -512, 0, 0] },
    { label: 'character', caption: 'a fox in a red coat', bbox: [-512, 0, 0, 512] },
    { label: 'text', caption: 'bold white letters', text: 'HELLO\nWORLD', bbox: [0, -512, 512, 512] },
  ]);
  assert.deepEqual(Object.keys(items[2]), ['label', 'caption', 'text', 'bbox']);
  // The Studio does not keep words a box does not write either: what it holds is what goes to the model.
  assert.deepEqual(layoutBoxes(boxes).map(each => each.text), ['', '', 'HELLO\nWORLD']);
});

test('the JSON is the one Python writes with ensure_ascii=False and separators "," and ":"', () => {
  const [control, separator] = [String.fromCharCode(0x01), String.fromCharCode(0x2028)];
  const caption = `Un café « 東京 » "quoted" \\ back${control} ${separator} end`;
  const prompt = layoutPrompt(' A poster ', [box(0, 0, 1, 1, { caption })], SQUARE);
  // Python writes a control character as a backslash, u and four small hex digits, and the line separator as it is.
  assert.equal(
    prompt,
    '{"summary":{"caption":"A poster"},"items":[{"label":"object","caption":"Un café « 東京 » \\"quoted\\" \\\\ back' +
      '\\' +
      `u0001 ${separator} end","bbox":[-512,-512,512,512]}],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}`,
  );
});

test('the caption is the prompt without the spaces Python\'s strip() takes away, as ComfyUI\'s node does', () => {
  const caption = prompt => JSON.parse(layoutPrompt(prompt, [box(0, 0, 1, 1)], SQUARE)).summary.caption;
  const [ideographic, mark] = [String.fromCharCode(0x3000), String.fromCharCode(0xfeff)];
  assert.equal(caption(`${ideographic}\x1c a poster \x85\n\t`), 'a poster');
  assert.equal(caption(`${mark}a poster`), `${mark}a poster`, 'Python does not take the byte order mark away');
  assert.equal(caption('a\n\nposter'), 'a\n\nposter');
});

test('without a box the prompt goes as it was written; a layout that cannot be made is null', () => {
  assert.equal(layoutPrompt('  a poster \n', [], SQUARE), '  a poster \n');
  assert.equal(layoutPrompt('a poster', [{}, null, 'box'], SQUARE), 'a poster');
  assert.equal(layoutPrompt(42, [], SQUARE), '');
  const one = [box(0, 0, 1, 1)];
  assert.equal(layoutPrompt(' \n ', one, SQUARE), null, 'no caption');
  assert.equal(layoutPrompt('a poster', one, size(1000, 1000)), null, 'not a multiple of 16');
  assert.equal(layoutPrompt('a poster', one, size(32768, 1024)), null, 'too large');
  for (const wrong of [null, undefined, {}, size('1024', '1024'), size(-1024, 1024), size(1024.5, 1024)]) {
    assert.equal(layoutPrompt('a poster', one, wrong), null);
  }
});

test('unfinished boxes are named with what they lack, and no layout is made with them', () => {
  const boxes = [
    box(0, 0, 0.5, 0.5, { caption: ' \n ' }),
    box(0.5, 0, 0.5, 0.5, { label: 'text', caption: 'big letters', text: '' }),
    box(0, 0.5, 0.5, 0.5, { label: 'text', caption: '', text: ' ' }),
    box(0.5, 0.5, 0.5, 0.5),
  ];
  assert.deepEqual(unfinishedBoxes(boxes), [
    { index: 0, missing: ['caption'] },
    { index: 1, missing: ['text'] },
    { index: 2, missing: ['caption', 'text'] },
  ]);
  assert.equal(layoutPrompt('a poster', boxes, SQUARE), null);
  assert.equal(typeof layoutPrompt('a poster', boxes.slice(3), SQUARE), 'string');
  assert.deepEqual(unfinishedBoxes('not a list'), []);
});

test('damaged lists give the boxes that can be used and never throw; nothing given is changed', () => {
  const throwing = { get x() { throw new Error('read'); }, y: 0, w: 1, h: 1 };
  const trap = new Proxy({}, { get() { throw new Error('trap'); } });
  const kept = Object.freeze(box(0.1, 0.1, 0.2, 0.2, { palette: Object.freeze(['#abc']) }));
  for (const list of [null, undefined, 'boxes', 42, {}, { length: 2, 0: kept }]) {
    assert.deepEqual(layoutBoxes(list), []);
  }
  const list = [null, 3, 'a', [], {}, box(NaN, 0, 1, 1), box('0', 0, 1, 1), box(0, Infinity, 1, 1), throwing, trap];
  list.push(kept);
  assert.deepEqual(layoutBoxes(list), [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: 'object', caption: 'a thing', text: '', palette: ['#AABBCC'] },
  ]);
  assert.deepEqual(kept, box(0.1, 0.1, 0.2, 0.2, { palette: ['#abc'] }));
  for (const wrong of [null, 'a', {}, []]) {
    assert.equal(readLayoutPrompt(wrong, SQUARE), null);
    assert.equal(layoutPrompt(wrong, wrong, wrong), wrong === 'a' ? 'a' : '');
    assert.deepEqual(unfinishedBoxes(wrong), []);
  }
});

test('a box drawn backwards is turned, one out of the picture comes in, one too small grows around its middle', () => {
  const [backwards, outside, small, corner] = layoutBoxes([
    box(0.5, 0.75, -0.25, -0.5),
    box(-0.5, 0.9, 2, 0.5),
    box(0.5, 0.5, 0.001, 0),
    box(0.999, 0.999, 0.001, 0.001),
  ]);
  assert.deepEqual([backwards.x, backwards.y, backwards.w, backwards.h], [0.25, 0.25, 0.25, 0.5]);
  assert.deepEqual([outside.x, outside.w, outside.y], [0, 1, 0.9]);
  assert.ok(Math.abs(outside.h - 0.1) < 1e-12);
  assert.ok(Math.abs(small.x - 0.4905) < 1e-12 && Math.abs(small.w - 0.02) < 1e-12);
  assert.ok(Math.abs(small.y - 0.49) < 1e-12 && Math.abs(small.h - 0.02) < 1e-12);
  assert.ok(Math.abs(corner.x - 0.98) < 1e-12 && corner.x + corner.w <= 1 && corner.w >= 0.02 - 1e-12);
});

test('labels: the three known ones in any case, anything else is an object', () => {
  const labels = ['TEXT ', 'Character', 'obj', 'panel', 7, undefined].map(
    label => layoutBoxes([box(0, 0, 1, 1, { label })])[0].label,
  );
  assert.deepEqual(labels, ['text', 'character', 'object', 'object', 'object', 'object']);
});

test('the limits: twelve boxes, words cut without breaking a character, five colours, the smallest side', () => {
  assert.equal(layoutBoxes(drawn(20, 3)).length, LAYOUT_LIMITS.boxes);
  assert.deepEqual(layoutBoxes(drawn(20, 3)), layoutBoxes(drawn(12, 3)));
  const [long] = layoutBoxes([box(0, 0, 1, 1, { label: 'text', caption: '😀'.repeat(900), text: 'é'.repeat(600) })]);
  assert.equal(Array.from(long.caption).length, LAYOUT_LIMITS.caption);
  assert.equal(long.caption, '😀'.repeat(LAYOUT_LIMITS.caption), 'no half of a character at the end');
  assert.equal(long.text.length, LAYOUT_LIMITS.text);
  const palette = ['#ff0000', 'f00', ' #00FF00 ', 'red', 12, '#0000ff', '#0000FF', '#123', '#abcdef', '#fedcba'];
  const [coloured] = layoutBoxes([box(0, 0, 1, 1, { palette })]);
  assert.deepEqual(coloured.palette, ['#FF0000', '#00FF00', '#0000FF', '#112233', '#ABCDEF']);
  for (const each of layoutBoxes(drawn(12, 5).map(one => ({ ...one, w: one.w / 100, h: -one.h / 100 })))) {
    assert.ok(each.w >= LAYOUT_LIMITS.smallest - 1e-12 && each.h >= LAYOUT_LIMITS.smallest - 1e-12);
    assert.ok(each.x >= 0 && each.y >= 0 && each.x + each.w <= 1 + 1e-12 && each.y + each.h <= 1 + 1e-12);
  }
});

test('boxes given back again come back the same, to the last digit, whatever came first', () => {
  const next = numbers(7);
  const wild = Array.from({ length: 200 }, () => {
    const pick = () => (next() - 0.25) * 1.5;
    return box(pick(), pick(), pick() / 3, pick() / 3, { label: LAYOUT_LABELS[Math.floor(next() * 3)], text: 'W' });
  });
  for (let start = 0; start < wild.length; start += 12) {
    const once = layoutBoxes(wild.slice(start, start + 12));
    assert.deepEqual(layoutBoxes(once), once);
  }
});

test('the limits of each box do not bound the whole prompt: the Studio checks its length against the engine', () => {
  const full = Array.from({ length: LAYOUT_LIMITS.boxes }, (_, index) =>
    box((index % 4) / 4, Math.floor(index / 4) / 3, 0.25, 1 / 3, {
      label: 'text',
      caption: 'd'.repeat(LAYOUT_LIMITS.caption),
      text: 'T'.repeat(LAYOUT_LIMITS.text),
    }),
  );
  assert.ok(layoutPrompt('a poster', full, SQUARE).length > LAYOUT_LIMITS.prompt);
});

test('what is not a layout is not read', () => {
  const layout = (more = {}) =>
    JSON.stringify({
      summary: { caption: 'a poster' },
      items: [{ label: 'object', caption: 'a cup', bbox: [-100, -100, 100, 100] }],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
      ...more,
    });
  assert.ok(readLayoutPrompt(layout(), SQUARE));
  const refused = [
    'a cat on a mat',
    '{not json',
    '[]',
    '{}',
    '{"items":[]}',
    layout({ items: [] }),
    layout({ bbox_coord_space: undefined }),
    layout({ bbox_format: 'xyxy' }),
    layout({ bbox_coord_space: 'abs' }),
    layout({ items: [{ label: 'object', caption: 'a cup', bbox: [-100, -100, 100] }] }),
    layout({ items: [{ label: 'object', caption: 'a cup', bbox: ['-100', -100, 100, 100] }] }),
    layout({ items: [{ label: 'object', caption: 'a cup', bbox: [100, -100, -100, 100] }] }),
    layout({ items: ['a cup', null, 3] }),
    `{"items":${'['.repeat(200000)}`,
  ];
  for (const text of refused) assert.equal(readLayoutPrompt(text, SQUARE), null, text.slice(0, 60));
  assert.equal(readLayoutPrompt(layout(), size(1000, 1000)), null, 'a size the model does not take');
  assert.equal(readLayoutPrompt(layout(), null), null);
});

test('a layout from elsewhere is read with what the Studio does not hold named', () => {
  // The example of the README, as it is printed there (with spaces and indents), meta and canvas included.
  const readme = JSON.stringify(
    {
      summary: {
        meta: ['poster'],
        canvas: 'single',
        caption:
          'A minimalist travel poster with a cream background, a blue mountain illustration, ' +
          'and the title EXPLORE at the top.',
      },
      items: [
        {
          label: 'text',
          caption: 'Large dark-blue uppercase title centered at the top.',
          text: 'EXPLORE',
          bbox: [-416, -384, -288, 384],
        },
        {
          label: 'object',
          caption: 'A flat blue mountain illustration in the lower center.',
          bbox: [-192, -288, 384, 288],
        },
      ],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    },
    null,
    2,
  );
  const read = readLayoutPrompt(`\n${readme}\n`, SQUARE);
  assert.deepEqual(read.left, ['summary.meta', 'summary.canvas']);
  assert.equal(read.prompt.slice(0, 26), 'A minimalist travel poster');
  assert.deepEqual(read.boxes[0], {
    x: 128 / 1024,
    y: 96 / 1024,
    w: 768 / 1024,
    h: 128 / 1024,
    label: 'text',
    caption: 'Large dark-blue uppercase title centered at the top.',
    text: 'EXPLORE',
    palette: [],
  });
  assert.deepEqual(pixelBox(read.boxes[1], SQUARE), [-192, -288, 384, 288]);

  const item = (bbox, more = {}) => ({ label: 'object', caption: 'a cup', bbox, ...more });
  const items = [
    item([-512, -512, 0, 0], { tags: ['ceramic'] }),
    item([-512, 0, 0, 512], { label: 'panel' }),
    item([0, -512, 512, 0], { text: 'NOT WRITTEN' }),
    item([0, 0, 600, 600]),
    item([10, 10, 12, 12], { palette: ['#ff0000', 'red'] }),
    item([0, 0, 512, 512], { label: 'text', caption: 'x'.repeat(900), text: 'HELLO' }),
    'not an item',
    ...Array.from({ length: 10 }, () => item([-100, -100, 100, 100])),
  ];
  const foreign = readLayoutPrompt(
    JSON.stringify({ summary: 'a poster', items, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx', seed: 1 }),
    SQUARE,
  );
  assert.equal(foreign.prompt, '');
  assert.deepEqual(foreign.left, [
    'seed',
    'summary',
    'items[0].tags',
    'items[1].label',
    'items[2].text',
    'items[3].bbox',
    'items[4].palette',
    'items[4].bbox',
    'items[5].caption',
    'items[6]',
    'items[13...]',
  ]);
  assert.equal(foreign.boxes.length, LAYOUT_LIMITS.boxes);
  assert.deepEqual(pixelBox(foreign.boxes[3], SQUARE), [0, 0, 512, 512], 'a box out of the picture comes in');
  assert.deepEqual(foreign.boxes[4].palette, ['#FF0000']);
  assert.ok(foreign.boxes[4].w >= LAYOUT_LIMITS.smallest - 1e-12, 'a box too small grows');
});

// (0.6.477) What the Studio adds to the module once it is wired: the box a hand draws, the count of the characters
// the engine takes, the words it says, and the caption every place shows in place of the JSON.
const frame = { left: 100, top: 50, width: 400, height: 300 };

test('a box drawn by hand: 12 pixels of the screen at least on each side, held inside the picture', () => {
  assert.equal(LAYOUT_LIMITS.drawn, 12);
  const at = (x, y, w, h) => ({ x: x / 400, y: y / 300, w: w / 400, h: h / 300 });
  assert.equal(drawnBox({ x: 110, y: 60 }, { x: 118, y: 66 }, frame), null, '8 x 6 pixels: a click');
  assert.deepEqual(drawnBox({ x: 110, y: 60 }, { x: 122, y: 72 }, frame), at(10, 10, 12, 12));
  // Drawn backwards, from the bottom right: the same box.
  assert.deepEqual(drawnBox({ x: 140, y: 80 }, { x: 100, y: 50 }, frame), at(0, 0, 40, 30));
  // Out of the picture: held at its edge; what is left along an edge is too thin.
  assert.deepEqual(drawnBox({ x: 450, y: 300 }, { x: 900, y: 999 }, frame), at(350, 250, 50, 50));
  assert.equal(drawnBox({ x: 495, y: 60 }, { x: 900, y: 200 }, frame), null, '5 pixels inside the right edge');
  for (const wrong of [
    [null, { x: 0, y: 0 }, frame],
    [{ x: 'a', y: 0 }, { x: 50, y: 50 }, frame],
    [{ x: 110, y: 60 }, { x: 150, y: 90 }, { ...frame, width: 0 }],
    [{ x: 110, y: 60 }, { x: 150, y: 90 }, { ...frame, height: Infinity }],
    [{ get x() { throw new Error('read'); }, y: 0 }, { x: 150, y: 90 }, frame],
  ]) {
    assert.equal(drawnBox(...wrong), null);
  }
  // The box goes through layoutBoxes as it is: within the limits already.
  const box = drawnBox({ x: 110, y: 60 }, { x: 250, y: 160 }, frame);
  const held = { ...box, label: 'object', caption: '', text: '', palette: [] };
  assert.deepEqual(layoutBoxes([{ ...box, label: 'object' }])[0], held);
});

/** Twelve boxes whose layout makes `length` characters: the last description is what is left. */
function filled(length) {
  const boxes = last =>
    Array.from({ length: LAYOUT_LIMITS.boxes }, (_, index) =>
      box((index % 4) / 4, Math.floor(index / 4) / 3, 0.25, 1 / 3, {
        caption: 'd'.repeat(index === LAYOUT_LIMITS.boxes - 1 ? last : 600),
      }),
    );
  const need = length - layoutPrompt('A poster', boxes(1), SQUARE).length + 1;
  assert.ok(need >= 1 && need <= LAYOUT_LIMITS.caption, `${need} characters for the last description`);
  return boxes(need);
}

test('layoutReady: the prompt as it is without a box; the layout up to what the engine takes, why not beyond', () => {
  // The limit the engine reads (runner/families/moss.json), as the server counts it: UTF-16 units.
  const moss = JSON.parse(readFileSync(new URL('../runner/families/moss.json', import.meta.url), 'utf8'));
  const limit = moss.parameters.prompt.maxLength;
  assert.deepEqual(layoutReady(' a poster ', [], SQUARE), { prompt: ' a poster ', length: 10, reason: '' });
  const at = layoutReady('A poster', filled(limit), SQUARE);
  assert.deepEqual([at.length, at.reason], [limit, '']);
  assert.equal(at.prompt, layoutPrompt('A poster', filled(limit), SQUARE));
  const over = layoutReady('A poster', filled(limit + 1), SQUARE);
  assert.deepEqual(over, { prompt: null, length: limit + 1, reason: LAYOUT_SAYS.long });
  assert.equal(LAYOUT_SAYS.long, 'Boîtes trop longues pour MOSS Image : raccourcissez des descriptions');
  const narrow = String.fromCharCode(0x202f);
  assert.equal(
    layoutTooLong(8535),
    `Avec le prompt, les boîtes font 8${narrow}535 caractères : MOSS Image en lit 8${narrow}000 au plus. ` +
      'Raccourcissez des descriptions.',
  );
  // An emoji counts two, as the server counts it (len() of the engine counts it one: the safe side).
  const emoji = filled(limit).map((each, index) =>
    index ? each : { ...each, caption: '😀' + each.caption.slice(2) },
  );
  assert.equal(layoutReady('A poster', emoji, SQUARE).length, limit);
});

test('layoutReady says the first box unfinished, its words first, then the prompt and the size', () => {
  const boxes = [
    box(0, 0, 0.5, 0.5),
    box(0.5, 0, 0.5, 0.5, { caption: '' }),
    box(0, 0.5, 0.5, 0.5, { label: 'text', caption: '', text: '' }),
  ];
  assert.deepEqual(layoutReady('A poster', boxes, SQUARE), {
    prompt: null,
    length: 0,
    reason: 'Décrivez la boîte 2 pour générer',
  });
  const why = (prompt, list, picture = SQUARE) => layoutReady(prompt, list, picture).reason;
  assert.equal(why('A poster', [boxes[0], boxes[2]]), 'Écrivez le texte de la boîte 2 pour générer');
  assert.equal(why('  ', [boxes[0]]), 'Écrivez un prompt.');
  assert.equal(why('A poster', [boxes[0]], size(1000, 1000)), 'Choisissez une taille de la liste pour les boîtes.');
});

test('the words of the Studio for boxes', () => {
  assert.deepEqual(LAYOUT_SAYS, {
    full: 'Douze boîtes au plus : retirez-en une pour en placer une autre.',
    refused: 'Douze boîtes au plus.',
    small: 'Trop petite : glissez un peu plus loin.',
    long: 'Boîtes trop longues pour MOSS Image : raccourcissez des descriptions',
  });
  assert.ok(Object.isFrozen(LAYOUT_SAYS) && Object.isFrozen(LAYOUT_NAMES));
  assert.deepEqual(LAYOUT_NAMES, { object: 'Objet', character: 'Personnage', text: 'Texte' });
  assert.deepEqual([layoutWords(1), layoutWords(3), layoutWords(12)], ['1 boîte', '3 boîtes', '12 boîtes']);
  assert.equal(
    layoutUnread('Krea 2', 3),
    'Krea 2 ne lit pas les boîtes : les 3 boîtes ne partiront pas. Elles restent prêtes pour MOSS Image.',
  );
  assert.equal(
    layoutUnread('Krea 2', 3, { window: true }),
    'Krea 2 ne lit pas les boîtes : ces 3 boîtes ne partiront pas. Elles restent prêtes pour MOSS Image : ' +
      'choisissez-le dans Modèle pour les envoyer.',
  );
  assert.equal(
    layoutUnread('Krea 2', 1),
    'Krea 2 ne lit pas les boîtes : la boîte ne partira pas. Elle reste prête pour MOSS Image.',
  );
  assert.equal(layoutUnread('Krea 2', 0), 'Krea 2 ne lit pas les boîtes.');
});

test('a layout prompt is shown by its caption, without its size; any other text as it is', () => {
  const boxes = [box(0, 0, 0.5, 0.5, { label: 'text', caption: 'bold', text: 'EXPLORE' }), box(0.5, 0.5, 0.5, 0.5)];
  const prompt = layoutPrompt(' A poster ', boxes, size(1344, 768));
  assert.equal(layoutCaption(prompt), 'A poster');
  assert.equal(layoutCount(prompt), 2);
  assert.deepEqual(layoutOf(prompt).items.map(item => [item.label, item.caption, item.text]), [
    ['text', 'bold', 'EXPLORE'],
    ['object', 'a thing', ''],
  ]);
  // The same answer read again (kept), and for the README as it is printed.
  assert.equal(layoutOf(prompt), layoutOf(prompt));
  const readme = JSON.stringify(
    {
      summary: { meta: ['poster'], caption: 'A travel poster.' },
      items: [{ label: 'text', caption: 'Title.', text: 'EXPLORE', bbox: [-416, -384, -288, 384] }],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    },
    null,
    2,
  );
  assert.equal(layoutCaption(`\n${readme}`), 'A travel poster.');
  for (const text of ['a cat', '{"bbox_format":"yxyx"', '{"items":[],"bbox_format":"xyxy"}', '', 'x'.repeat(9000)])
    assert.equal(layoutCaption(text), text);
  for (const value of [undefined, null, 42]) assert.equal(layoutCaption(value), value);
  assert.equal(layoutCount('a cat'), 0);
  const empty = '{"summary":{},"items":[],"bbox_coord_space":"abs_centralized","bbox_format":"yxyx"}';
  assert.equal(layoutCaption(empty), '');
});

test('(N11) the chat model reads a prompt of boxes as its caption and count; a conversation, as its caption', () => {
  const three = [box(0, 0, 0.5, 0.5), box(0.5, 0.5, 0.5, 0.5), box(0, 0.5, 0.5, 0.5, { label: 'character' })];
  const prompt = layoutPrompt('A poster', three, SQUARE);
  assert.equal(layoutSaid(prompt), 'A poster (3 boîtes)');
  assert.equal(layoutSaid(layoutPrompt('One', [box(0, 0, 0.5, 0.5)], SQUARE)), 'One (1 boîte)');
  for (const text of ['a cat', 'Un plan (3 boîtes) de plus', '', undefined, null]) assert.equal(layoutSaid(text), text);
  // Named by its caption alone, whether the line holds the JSON or the caption said so.
  assert.equal(layoutTitle(prompt), 'A poster');
  assert.equal(layoutTitle(layoutSaid(prompt)), 'A poster');
  assert.equal(layoutTitle('a cat'), 'a cat');
  assert.equal(layoutTitle(undefined), undefined);
});

test('the call of a creation with boxes is read again by the chat model, its prompt said, nothing else changed', () => {
  const prompt = layoutPrompt('A poster', [box(0, 0, 0.5, 0.5)], SQUARE),
    args = { prompt, workflow: 'moss', width: 1024 },
    call = { id: 'action-1', type: 'function', function: { name: 'create_image', arguments: JSON.stringify(args) } };
  const said = layoutCall(call);
  assert.deepEqual(JSON.parse(said.function.arguments), { ...args, prompt: 'A poster (1 boîte)' });
  assert.deepEqual([said.id, said.type, said.function.name], ['action-1', 'function', 'create_image']);
  // The call itself is not changed: the server keeps what it made.
  assert.equal(JSON.parse(call.function.arguments).prompt, prompt);
  // Any other call as it is, the same object: words, arguments that are not JSON, nothing.
  const plain = { id: 'x', function: { name: 'create_image', arguments: '{"prompt":"a cat"}' } },
    broken = { id: 'y', function: { name: 'create_image', arguments: '{"prompt": "bbox_format' } },
    named = { id: 'z', function: { name: 'create_image', arguments: '{"prompt":"bbox_format, a word"}' } };
  for (const other of [plain, broken, named, undefined, null, {}]) assert.equal(layoutCall(other), other);
});

test('a take made with boxes is told to the chat model by its caption, and so is what the user changed on it', () => {
  const prompt = layoutPrompt('A poster', [box(0, 0, 0.5, 0.5)], SQUARE),
    record = { id: 'r', prompt, parameters: { seed: 4, user_overrides: { prompt, seed: 4 } } };
  const told = layoutRecord(record);
  assert.equal(told.prompt, 'A poster');
  assert.deepEqual(told.parameters, { seed: 4, user_overrides: { prompt: 'A poster', seed: 4 } });
  // The take itself is not changed.
  assert.deepEqual([record.prompt, record.parameters.user_overrides.prompt], [prompt, prompt]);
  const plain = { id: 'p', prompt: 'a cat', parameters: { user_overrides: { prompt: 'a dog' } } };
  assert.equal(layoutRecord(plain), plain);
  const changed = layoutRecord({ id: 'o', prompt: 'a cat', parameters: { user_overrides: { prompt } } });
  assert.deepEqual([changed.prompt, changed.parameters.user_overrides.prompt], ['a cat', 'A poster']);
  for (const value of [undefined, null]) assert.equal(layoutRecord(value), value);
});

test('no screen shows the JSON of a prompt of boxes: a prompt read raw in the page is one of these', () => {
  // (LOTS.md, lot 6) Any other line that reads the prompt of a take, of a plan or of arguments shows it through a
  // helper of public/layout-boxes.mjs (or reads its boxes: take-eye.mjs).
  const allowed = [
    // On purpose: the JSON whole in « Plus de détails », the same JSON left out of « Paramètres ».
    ['assets-ui.mjs', "row('Prompt des boîtes (lu par le modèle)', record.prompt"],
    ['assets-ui.mjs', 'other[key]?.prompt !== record.prompt'],
    // takeContent: the take is told by its caption on the line before (layoutRecord).
    ['generation-runtime.mjs', 'prompt: record.prompt,'],
    // Sounds: never made with boxes.
    ['library.mjs', "String(record.prompt || 'Son')"],
    ['montage.mjs', "if (id !== 'plans' && record?.prompt)"],
    // « Chercher une prise »: the words of its boxes when it has some (layoutOf, the line before).
    ['montage-model.mjs', ': record?.prompt,'],
    // Opened again in the Studio: boxes.adopt, on the next line, puts the caption in the field.
    ['studio.mjs', "prompt: String(record.prompt ?? ''), before: null"],
    // A proposal: read on its next line (readLayoutPrompt), its caption put in the field and its boxes on the piece.
    ['studio.mjs', "prompt: String(plan.prompt ?? request.args?.prompt ?? ''),"],
    // What the Studio sends and changes, not what it shows.
    ['studio.mjs', 'delete args.prompt;'],
    ['studio.mjs', 'if (laid) args.prompt = laid;'],
    // The name of the conversation: conversationTitle (transcript.mjs) reads its caption.
    ['studio.mjs', "onWork(conversationId, wanted.args?.prompt ?? '')"],
    // The card of a proposal shows what Moodix AI wrote, which is never a layout: it is told of none (N11).
    ['video-plan.mjs', 'plan.prompt'],
  ];
  const helpers = /\blayout(?:Caption|Said|Title|Count|Of|Record|Call)\(|\breadLayoutPrompt\(|\btakeBoxes\(/,
    folder = new URL('../public/', import.meta.url),
    raw = [];
  for (const name of readdirSync(folder).filter(file => /\.(mjs|js)$/.test(file)))
    readFileSync(new URL(name, folder), 'utf8')
      .split(/\r?\n/)
      .forEach((line, at) => {
        const read = /\b(?:record|plan|args)\??\.prompt\b/.test(line);
        if (!read || helpers.test(line) || /^\s*(?:\/\/|\*)/.test(line)) return;
        if (!allowed.some(([file, part]) => file === name && line.includes(part)))
          raw.push(`${name}:${at + 1}: ${line.trim().slice(0, 90)}`);
      });
  assert.deepEqual(raw, []);
});

test('the page is served the module, and the editor and the eye that use it', async () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  for (const name of ['layout-boxes', 'layout-editor', 'take-eye'])
    assert.match(server, new RegExp(`\\['/${name}\\.mjs', \\['${name}\\.mjs',`), name);
});
