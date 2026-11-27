/**
 * (21/11; wired in 0.6.477, public/layout-editor.mjs) The boxes of a MOSS Image layout as the Studio holds them,
 * and the layout prompt the model reads in place of a plain prompt. A layout is JSON (user guide of MOSS-Image,
 * « Layout Prompts (Experimental) »): a summary caption of the whole picture, then items, each with a label (object,
 * character or text), a caption, the exact words to write for a text item, an optional palette, and a bbox in whole
 * pixels counted from the centre of the picture, [y_min, x_min, y_max, x_max] (bbox_coord_space "abs_centralized",
 * bbox_format "yxyx"). Written from the official guide, the official prompt enhancer skill and what its compiler
 * is documented to do (Apache-2.0), and from what ComfyUI's node was seen to write; no ComfyUI code is in here.
 *
 * A box is kept as fractions of the picture (0 to 1) so that it stays where it was drawn when the size changes:
 * x and w are fractions of the width, y and h of the height, from the top left corner. Pixels are only counted
 * when the prompt is built, for the size the picture will have. Nothing here throws on what a hand, a file or a
 * model sends: what cannot be used is left out, and a reader is told what was.
 */

/** What a box may hold: a thing, a character (a person, an animal, a creature), or words to write. */
export const LAYOUT_LABELS = Object.freeze(['object', 'character', 'text']);
/**
 * The limits of a layout. The official guide and compiler set none (no count, no smallest box, no length); these
 * are Moodix's, for the Studio: `boxes` at most; `caption` and `text`, the characters of a box's description and
 * of its words; `palette`, the colours of a box (ComfyUI's box editor keeps 5); `smallest`, the shortest side of
 * a box as a fraction of the picture (about 20 pixels at 1024, where a cell of the model is 16); `prompt`, the
 * characters the engine takes for a whole prompt (runner/families/moss.json), which a built layout must not pass.
 * (0.6.477) `drawn`: the shortest side of a box drawn by a hand in the frame of the Studio, in pixels of the screen
 * (drawnBox); what comes from a file or from the chat keeps `smallest`.
 */
export const LAYOUT_LIMITS = Object.freeze({
  boxes: 12,
  caption: 800,
  text: 500,
  palette: 5,
  smallest: 0.02,
  prompt: 8000,
  drawn: 12,
});

const LABELS = new Set(LAYOUT_LABELS);
/** The keys of a layout this module writes and reads; readLayoutPrompt names any other it finds. */
const LAYOUT_KEYS = new Set(['summary', 'items', 'bbox_coord_space', 'bbox_format']);
const ITEM_KEYS = new Set(['label', 'caption', 'text', 'palette', 'bbox']);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The characters Python's str.strip() takes away (those of str.isspace()), so that the caption is the one ComfyUI's
 * node and the engine use. JavaScript's trim() is not the same: it takes the byte order mark, and leaves 0x1c to
 * 0x1f and 0x85.
 */
const PYTHON_SPACES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
function strip(text) {
  let start = 0,
    end = text.length;
  while (start < end && PYTHON_SPACES.has(text.charCodeAt(start))) start++;
  while (end > start && PYTHON_SPACES.has(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}
/** A text cut to `limit` characters, never in the middle of a character written with two UTF-16 units. */
const cut = (text, limit) => (text.length <= limit ? text : Array.from(text).slice(0, limit).join(''));
/** What a hand wrote, as it wrote it, cut to its limit; what is not text is no text. */
const written = (value, limit) => (typeof value === 'string' ? cut(value, limit) : '');

/** Colours as "#RRGGBB" in capitals (the technical report writes them so); "#abc" is "#AABBCC"; others go. */
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function paletteOf(list) {
  const colours = [];
  for (const value of Array.isArray(list) ? list : []) {
    const found = typeof value === 'string' ? HEX.exec(value.trim()) : null;
    if (!found) continue;
    const digits = found[1].length === 3 ? Array.from(found[1], digit => digit + digit).join('') : found[1];
    const colour = `#${digits.toUpperCase()}`;
    if (!colours.includes(colour)) colours.push(colour);
    if (colours.length === LAYOUT_LIMITS.palette) break;
  }
  return colours;
}

const labelOf = value => {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LABELS.has(name) ? name : 'object';
};

/**
 * One side of a box from its start and its size: turned the right way if it was drawn backwards, inside the
 * picture, and not under the smallest side (a box too small grows around its middle). A side already right is
 * given back as it came, so that a box read again stays the same to the last digit.
 */
function sideOf(start, size) {
  const small = LAYOUT_LIMITS.smallest;
  if (start >= 0 && start + size <= 1 && size >= small - 1e-9) return [start, size];
  let low = clamp(Math.min(start, start + size), 0, 1),
    high = clamp(Math.max(start, start + size), 0, 1);
  if (high - low < small) {
    const middle = clamp((low + high) / 2, small / 2, 1 - small / 2);
    [low, high] = [middle - small / 2, middle + small / 2];
  }
  return [low, high - low];
}

/** A box as the Studio holds it, or null when there is no place to put it (no numbers for where it is). */
function boxOf(value) {
  try {
    if (!isObject(value)) return null;
    const { x, y, w, h } = value;
    if (![x, y, w, h].every(finite)) return null;
    const [left, width] = sideOf(x, w),
      [top, height] = sideOf(y, h),
      label = labelOf(value.label);
    return {
      x: left,
      y: top,
      w: width,
      h: height,
      label,
      caption: written(value.caption, LAYOUT_LIMITS.caption),
      // The words are only for a text box: a thing or a character writes nothing, so it keeps nothing.
      text: label === 'text' ? written(value.text, LAYOUT_LIMITS.text) : '',
      palette: paletteOf(value.palette),
    };
  } catch {
    return null; // a value that throws when it is read (a getter, a proxy) is no box
  }
}

/**
 * The boxes of a list, each within the limits: `{ x, y, w, h, label, caption, text, palette }`, in the order of
 * the list (which is the order of the items in the prompt), no more than LAYOUT_LIMITS.boxes. What is not a box
 * is left out; nothing given is changed in place. Boxes given back again come back the same.
 */
export function layoutBoxes(list) {
  const boxes = [];
  try {
    for (const value of Array.isArray(list) ? list : []) {
      const box = boxOf(value);
      if (box) boxes.push(box);
      if (boxes.length === LAYOUT_LIMITS.boxes) break;
    }
  } catch {
    // a list that throws while it is read keeps the boxes read before
  }
  return boxes;
}

/**
 * The boxes that cannot go to the model yet, with what each lacks: a description (`caption`), and for a text box
 * the words to write (`text`). The official compiler refuses an item without them, and the model was not taught
 * with any. Indices are those of the list layoutBoxes gives back.
 */
export function unfinishedBoxes(list) {
  const unfinished = [];
  layoutBoxes(list).forEach((box, index) => {
    const missing = [];
    if (!strip(box.caption)) missing.push('caption');
    if (box.label === 'text' && !strip(box.text)) missing.push('text');
    if (missing.length) unfinished.push({ index, missing });
  });
  return unfinished;
}

const wholeSide = value => Number.isInteger(value) && value > 0;
/** A size the model takes: whole pixels, multiples of 16 (guide and pipeline), at most 16384 like ComfyUI's node. */
const modelSize = size =>
  isObject(size) && [size.width, size.height].every(side => wholeSide(side) && side % 16 === 0 && side <= 16384);

/**
 * Whole pixels from a fraction of a side. The official compiler rounds each edge to nine decimals before it takes
 * the whole pixel, so that float noise (0.1 + 0.2) does not push an edge one pixel out: an edge within half a
 * billionth of a pixel of a whole one is that one.
 */
function pixelOf(fraction, side) {
  const value = fraction * side,
    whole = Math.round(value);
  return Math.abs(value - whole) <= 5e-10 ? whole : value;
}
/** [y_min, x_min, y_max, x_max]: the whole pixels around the box (start down, end up), from the centre. */
function edgesOf(box, width, height) {
  const halfX = Math.floor(width / 2),
    halfY = Math.floor(height / 2);
  return [
    Math.floor(pixelOf(box.y, height)) - halfY,
    Math.floor(pixelOf(box.x, width)) - halfX,
    Math.ceil(pixelOf(box.y + box.h, height)) - halfY,
    Math.ceil(pixelOf(box.x + box.w, width)) - halfX,
  ];
}

/**
 * The bbox the model reads for one box in a picture of `size` ({ width, height }, whole pixels): the pixel edges
 * that hold the box, counted from the centre (Python's width // 2, so 500 for 1001), in the order y_min, x_min,
 * y_max, x_max. Null when the box or the size cannot be used.
 */
export function pixelBox(box, size) {
  if (!isObject(size) || !wholeSide(size.width) || !wholeSide(size.height)) return null;
  const [found] = layoutBoxes([box]);
  return found ? edgesOf(found, size.width, size.height) : null;
}

/**
 * The prompt the model reads: without a box, the prompt as it was written; with boxes, the layout in one line of
 * JSON, keys in the order of the official examples, no spaces, letters other than English kept as they are (like
 * Python's json.dumps with ensure_ascii=False and separators "," and ":"). The caption of the summary is the
 * prompt without the spaces around it. Null when a layout cannot be made: a size the model does not take, no
 * prompt, or a box unfinished (unfinishedBoxes says which). The engine takes LAYOUT_LIMITS.prompt characters: the
 * Studio checks the length of what comes back before it sends it.
 */
export function layoutPrompt(prompt, boxes, size) {
  const text = typeof prompt === 'string' ? prompt : '',
    list = layoutBoxes(boxes);
  if (!list.length) return text;
  if (!modelSize(size)) return null;
  const caption = strip(text);
  if (!caption || unfinishedBoxes(list).length) return null;
  const items = list.map(box => ({
    label: box.label,
    caption: box.caption,
    ...(box.label === 'text' ? { text: box.text } : {}),
    ...(box.palette.length ? { palette: box.palette } : {}),
    bbox: edgesOf(box, size.width, size.height),
  }));
  return JSON.stringify({ summary: { caption }, items, bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx' });
}

/**
 * Where a bbox of a layout is, as fractions of the picture, and whether it went out of it; null when it is not
 * four numbers around some room.
 */
function placeOf(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finite)) return null;
  const halfX = Math.floor(width / 2),
    halfY = Math.floor(height / 2);
  const [top, left, bottom, right] = [bbox[0] + halfY, bbox[1] + halfX, bbox[2] + halfY, bbox[3] + halfX];
  if (!(top < bottom && left < right)) return null;
  const x = left / width,
    y = top / height;
  const outside = top < 0 || left < 0 || bottom > height || right > width;
  return { x, y, w: right / width - x, h: bottom / height - y, outside };
}

/**
 * A layout prompt read back for the Studio (to open a take again): `{ prompt, boxes, left }`, where `prompt` is
 * the caption of the summary, `boxes` are as layoutBoxes gives them, and `left` names what was in the layout but
 * is not kept as it was (fields the Studio does not hold, such as summary.meta or an item's tags, an unknown
 * label, a box out of the picture or too small, a text cut, items over the limit). `size` is the size of the
 * picture the layout was made for. Null for anything that is not such a layout: not JSON, not in pixels from the
 * centre in the order y x y x, or without a single box that can be placed. A layout this module wrote, read and
 * written again for the same size, is the same prompt to the last character.
 */
export function readLayoutPrompt(text, size) {
  if (typeof text !== 'string' || !modelSize(size)) return null;
  const body = text.trim();
  if (!body.startsWith('{')) return null;
  let layout;
  try {
    layout = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(layout) || !Array.isArray(layout.items)) return null;
  if (layout.bbox_coord_space !== 'abs_centralized' || layout.bbox_format !== 'yxyx') return null;
  const left = new Set(),
    boxes = [];
  for (const key of Object.keys(layout)) if (!LAYOUT_KEYS.has(key)) left.add(key);
  let prompt = '';
  if (isObject(layout.summary)) {
    for (const key of Object.keys(layout.summary)) if (key !== 'caption') left.add(`summary.${key}`);
    if (typeof layout.summary.caption === 'string') prompt = layout.summary.caption;
    else if ('caption' in layout.summary) left.add('summary.caption');
  } else if ('summary' in layout) left.add('summary');
  for (const [index, item] of layout.items.entries()) {
    const path = `items[${index}]`;
    if (boxes.length === LAYOUT_LIMITS.boxes) {
      left.add(`items[${index}...]`); // this item and every one after it: the Studio holds no more boxes
      break;
    }
    const place = isObject(item) ? placeOf(item.bbox, size.width, size.height) : null;
    const [box] = place ? layoutBoxes([{ ...item, ...place }]) : [];
    if (!box) {
      left.add(path);
      continue;
    }
    for (const key of Object.keys(item)) if (!ITEM_KEYS.has(key)) left.add(`${path}.${key}`);
    if (box.label !== item.label) left.add(`${path}.label`);
    if (box.caption !== item.caption) left.add(`${path}.caption`);
    if (box.label === 'text' ? box.text !== item.text : 'text' in item) left.add(`${path}.text`);
    if ('palette' in item && (!Array.isArray(item.palette) || box.palette.length !== item.palette.length)) {
      left.add(`${path}.palette`);
    }
    if (place.outside || box.w > place.w + 1e-9 || box.h > place.h + 1e-9) left.add(`${path}.bbox`);
    boxes.push(box);
  }
  return boxes.length ? { prompt, boxes, left: [...left] } : null;
}

/** (0.6.477) The names of the labels in the words of the Studio: its window, its lines, the page of a take. */
export const LAYOUT_NAMES = Object.freeze({ object: 'Objet', character: 'Personnage', text: 'Texte' });

/**
 * (0.6.477) What the Studio says of boxes, the same words in the page and in its tests: the limit, under the piece and
 * at the head of its window (`full`); a thirteenth tried by hand (`refused`); a box drawn too small (`small`); boxes
 * the model in hand does not read (`unread`, with its name and their count: layoutUnread).
 */
export const LAYOUT_SAYS = Object.freeze({
  full: 'Douze boîtes au plus : retirez-en une pour en placer une autre.',
  refused: 'Douze boîtes au plus.',
  small: 'Trop petite : glissez un peu plus loin.',
  long: 'Boîtes trop longues pour MOSS Image : raccourcissez des descriptions',
});

/** A count as the French write it, its thousands apart by a narrow space that does not break: « 8 535 ». */
const NARROW = String.fromCharCode(0x202f);
const figures = count => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, NARROW);
/** (0.6.477) « 1 boîte », « 3 boîtes ». */
export const layoutWords = count => `${figures(count)} ${count > 1 ? 'boîtes' : 'boîte'}`;

/**
 * (0.6.477) A box drawn by a hand in the frame of the Studio: `from` and `to`, where the pointer was pressed and
 * released, in pixels of the screen ({ x, y }); `frame`, where the picture is on the screen ({ left, top, width,
 * height }). The box in fractions of the picture, held inside it ({ x, y, w, h }), or null when a side is shorter
 * than LAYOUT_LIMITS.drawn pixels on the screen once held inside: a click, a slip of the hand, a gesture along an edge.
 */
export function drawnBox(from, to, frame) {
  try {
    if (!isObject(from) || !isObject(to) || !isObject(frame)) return null;
    const { left, top, width, height } = frame;
    if (![from.x, from.y, to.x, to.y, left, top].every(finite) || !(width > 0 && height > 0)) return null;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    const x0 = clamp(Math.min(from.x, to.x), left, left + width),
      x1 = clamp(Math.max(from.x, to.x), left, left + width),
      y0 = clamp(Math.min(from.y, to.y), top, top + height),
      y1 = clamp(Math.max(from.y, to.y), top, top + height);
    if (x1 - x0 < LAYOUT_LIMITS.drawn || y1 - y0 < LAYOUT_LIMITS.drawn) return null;
    return { x: (x0 - left) / width, y: (y0 - top) / height, w: (x1 - x0) / width, h: (y1 - y0) / height };
  } catch {
    return null; // a point that throws when it is read is no gesture
  }
}

/**
 * (0.6.477) Whether boxes can go to the model, and as what: `{ prompt, length, reason }`. Without a box, the prompt as
 * it is written, no reason. With boxes, the layout layoutPrompt makes and its length in UTF-16 units, as the server
 * counts it (lib/native-workflows.mjs, valueMatches: the Studio never sends what the server refuses); or, with
 * `prompt` null, why it cannot go: the first box unfinished (its words before its description, as its window asks
 * them), no prompt, a size the model does not take, or a layout longer than LAYOUT_LIMITS.prompt (its `length` then
 * says by how much: layoutTooLong).
 */
export function layoutReady(prompt, boxes, size) {
  const text = typeof prompt === 'string' ? prompt : '',
    list = layoutBoxes(boxes);
  if (!list.length) return { prompt: text, length: text.length, reason: '' };
  const [first] = unfinishedBoxes(list);
  if (first) {
    const number = first.index + 1,
      lacks = first.missing.includes('text') ? `Écrivez le texte de la boîte ${number}` : `Décrivez la boîte ${number}`;
    return { prompt: null, length: 0, reason: `${lacks} pour générer` };
  }
  if (!strip(text)) return { prompt: null, length: 0, reason: 'Écrivez un prompt.' };
  const made = layoutPrompt(text, list, size);
  if (made === null) return { prompt: null, length: 0, reason: 'Choisissez une taille de la liste pour les boîtes.' };
  if (made.length > LAYOUT_LIMITS.prompt) return { prompt: null, length: made.length, reason: LAYOUT_SAYS.long };
  return { prompt: made, length: made.length, reason: '' };
}

/** (0.6.477) What the window of the piece says of a layout too long (`length` from layoutReady), in amber. */
export const layoutTooLong = length =>
  `Avec le prompt, les boîtes font ${figures(length)} caractères : MOSS Image en lit ` +
  `${figures(LAYOUT_LIMITS.prompt)} au plus. Raccourcissez des descriptions.`;

/**
 * (0.6.477) What the Studio says of boxes a model does not read (Krea 2, `name`): under its plateau, and in the window
 * of the piece (`window`), which says where to choose the one that reads them.
 */
export function layoutUnread(name, count, { window = false } = {}) {
  const head = `${name} ne lit pas les boîtes`;
  if (!count) return window ? `${head} : choisissez MOSS Image dans Modèle pour en placer.` : `${head}.`;
  const many = count > 1,
    these = many
      ? `${window ? 'ces' : 'les'} ${figures(count)} boîtes ne partiront pas`
      : `${window ? 'cette' : 'la'} boîte ne partira pas`,
    kept = `${many ? 'Elles restent prêtes' : 'Elle reste prête'} pour MOSS Image`;
  return window
    ? `${head} : ${these}. ${kept} : choisissez-le dans Modèle pour ${many ? 'les envoyer' : 'l’envoyer'}.`
    : `${head} : ${these}. ${kept}.`;
}

// The last layouts read by layoutOf: a prompt is shown many times while the page is drawn (a card, a title, the
// Archives), and a layout can be read from 8 000 characters of JSON. The last few, by their text.
const READ = new Map();
const READ_KEPT = 32;
/**
 * (0.6.477) A layout prompt read without the size of its picture: `{ caption, items }`, the caption of its summary
 * ('' when it has none) and its items as they are written (label, caption and text as strings), or null for any
 * other text. What shows a prompt reads it so (layoutCaption, layoutCount); readLayoutPrompt places its boxes.
 */
export function layoutOf(text) {
  if (typeof text !== 'string' || !text.includes('"bbox_format"')) return null;
  if (READ.has(text)) return READ.get(text);
  let found = null;
  const body = text.trim();
  if (body.startsWith('{'))
    try {
      const layout = JSON.parse(body),
        placed = layout?.bbox_coord_space === 'abs_centralized' && layout?.bbox_format === 'yxyx';
      if (isObject(layout) && Array.isArray(layout.items) && placed) {
        const summary = isObject(layout.summary) ? layout.summary : {},
          caption = typeof summary.caption === 'string' ? summary.caption : '';
        const items = layout.items.filter(isObject).map(item => ({
          label: labelOf(item.label),
          caption: typeof item.caption === 'string' ? item.caption : '',
          text: typeof item.text === 'string' ? item.text : '',
          palette: paletteOf(item.palette),
          bbox: Array.isArray(item.bbox) ? item.bbox.slice(0, 4) : null,
        }));
        found = Object.freeze({ caption, items: Object.freeze(items) });
      }
    } catch {
      found = null;
    }
  READ.set(text, found);
  if (READ.size > READ_KEPT) READ.delete(READ.keys().next().value);
  return found;
}

/**
 * (0.6.477) The words of a prompt as a person reads them: of a layout, the caption of its summary (what the user
 * wrote in the prompt of the Studio), whatever the size of its picture; any other value as it is. Everything that
 * shows a prompt shows it so (the name of a conversation, the cards, the Archives, the page of a take): never the
 * JSON the model read.
 */
export function layoutCaption(text) {
  const layout = layoutOf(text);
  return layout ? layout.caption : text;
}

/** (0.6.477) How many boxes a prompt has: the items of a layout, 0 for any other text. */
export const layoutCount = text => layoutOf(text)?.items.length ?? 0;

/**
 * (0.6.477, his decision N11 of 21/11) A prompt as the chat model is told of it, in a line of the conversation
 * (« Studio · Image : … »): of a layout, its caption and how many boxes it had, « Une affiche (3 boîtes) »; any other
 * text as it is. Never the JSON: the chat model would copy it, and it is long.
 */
export function layoutSaid(text) {
  const count = layoutCount(text);
  return count ? `${layoutCaption(text)} (${layoutWords(count)})` : text;
}
// « (3 boîtes) » at the end of a prompt said so.
const SAID_COUNT = new RegExp(` \\(\\d[\\d${NARROW}]* boîtes?\\)$`);
/**
 * (0.6.477) A prompt said to the chat model (layoutSaid) as the name of its conversation: the caption alone, without
 * how many boxes it had (transcript.mjs, conversationTitle).
 */
export function layoutTitle(text) {
  const value = layoutCaption(text);
  return typeof value === 'string' ? value.replace(SAID_COUNT, '') : value;
}

/**
 * (0.6.477, N11) The call of a creation of the Studio as the chat model reads it again in its conversation: its
 * prompt of boxes said by its caption and how many boxes (layoutSaid). Any other call as it is; the call itself (its
 * identifier, what the server made) is never changed.
 */
export function layoutCall(call) {
  const text = call?.function?.arguments;
  if (typeof text !== 'string' || !text.includes('bbox_format')) return call;
  try {
    const args = JSON.parse(text);
    if (!layoutOf(args?.prompt)) return call;
    const said = JSON.stringify({ ...args, prompt: layoutSaid(args.prompt) });
    return { ...call, function: { ...call.function, arguments: said } };
  } catch {
    return call; // arguments that are not JSON stay as they are
  }
}

/**
 * (0.6.477, N11) A take as the chat model is told of it (generation-runtime.mjs, takeContent): its prompt and that of
 * what the user changed on its proposal (`user_overrides`) by their caption. Any other take as it is.
 */
export function layoutRecord(record) {
  const own = record?.parameters?.user_overrides,
    changed = Boolean(layoutOf(own?.prompt));
  if (!layoutOf(record?.prompt) && !changed) return record;
  return {
    ...record,
    prompt: layoutCaption(record.prompt),
    ...(changed
      ? { parameters: { ...record.parameters, user_overrides: { ...own, prompt: layoutCaption(own.prompt) } } }
      : {}),
  };
}
