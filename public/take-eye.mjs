/**
 * (0.6.477) The eye of a take made with boxes (MOSS Image, public/layout-editor.mjs; captures B31 to B33 of
 * claude_design/bbox/maquettes, LOTS.md, lot 8): an icon alone at the top right of its picture (his decision of
 * 21/11: a video has its controls at the bottom), in the Studio and on the page of the take. Pressed, the boxes the
 * model received are drawn over the picture in thin lines, their numbers outside them so that nothing the model drew
 * is hidden; released, the picture alone. It shows, the user judges: nothing here says whether a box was followed.
 */
import { LAYOUT_NAMES, layoutWords, readLayoutPrompt } from './layout-boxes.mjs';

// Pressed or released, the same in the Studio and on the page of a take, for as long as the page is open.
let pressed = true;

/** What the eye says under the pointer, pressed (`on`) or not. */
export function eyeTip(count, on = pressed) {
  const what = count > 1 ? 'les ' + layoutWords(count) : 'la boîte';
  return on
    ? `Ce que le modèle a reçu : ${what}. Cliquez pour voir l’image seule.`
    : `Voir ce que le modèle a reçu : ${what}.`;
}

/**
 * The boxes a take was made with, as fractions of its picture, and the size they were counted for: `{ boxes, size }`.
 * Null for a take made without boxes, or whose size is not known (its prompt is read at the size it was made at,
 * readLayoutPrompt: the pixels of a layout are counted from the centre of its picture).
 */
export function takeBoxes(record) {
  try {
    const made = record?.parameters ?? {},
      output = record?.outputs?.[0] ?? {},
      size = { width: made.width ?? output.width, height: made.height ?? output.height },
      read = readLayoutPrompt(record?.prompt, size);
    return read ? { boxes: read.boxes, size } : null;
  } catch {
    return null; // a record that throws when it is read shows no boxes
  }
}

const touches = (r, s) => r.left < s.right + 2 && s.left < r.right + 2 && r.top < s.bottom + 2 && s.top < r.bottom + 2;
/**
 * Each number of a box at the first place of `order` where it can be read: in the picture (`picture`, a rectangle of
 * the screen), on nothing else that is read (`marks`: « PRISE n », the eye, a number put before; two pixels of air
 * between them, or two numbers read as one), else at the first place of its order. A place is a class of the number:
 * 'is-outside' (above its box), 'is-below' (under it), '' (in its corner). `order` is a list, or a function of the
 * number that gives one. Only on the page: without a layout to measure, the numbers stay in their corners.
 */
export function placeChips(chips, { picture, marks = [], order = ['is-outside', 'is-below', ''] }) {
  if (!picture?.width) return;
  const taken = [...marks],
    inside = r =>
      r.top >= picture.top - 0.5 &&
      r.bottom <= picture.bottom + 0.5 &&
      r.left >= picture.left - 0.5 &&
      r.right <= picture.right + 0.5;
  for (const chip of chips) {
    if (!chip?.getBoundingClientRect || !chip.getClientRects?.().length) continue;
    const places = typeof order === 'function' ? order(chip) : order,
      put = place => {
        chip.classList.remove('is-outside', 'is-below');
        if (place) chip.classList.add(place);
      },
      free = places.find(place => {
        put(place);
        const r = chip.getBoundingClientRect();
        return inside(r) && !taken.some(mark => touches(r, mark));
      });
    put(free ?? places[0]);
    taken.push(chip.getBoundingClientRect());
  }
}

/** An icon of the sprite of the page (public/index.html); a plain mark on a page without SVG (the tests). */
function spriteIcon(node, name) {
  const page = globalThis.document;
  if (typeof page?.createElementNS !== 'function') return node('span', 'icon-' + name);
  const svg = page.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    use = page.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

/**
 * The eye and the thin boxes, to lay over a picture: `element` fills what it is put in, which the caller places over
 * the picture at its size (the frame of the Studio, the stage of the page of a take). `tidy` puts the numbers where
 * they are read: once it is on the page, and again after a change of size. `icon` draws an icon of the page (the
 * Studio has its own); the page of a take uses the sprite.
 */
export function takeEye({ node, icon = name => spriteIcon(node, name), boxes }) {
  const layer = node('div', 'take-eye'),
    eye = node('button', 'take-eye-button'),
    lines = boxes.map((box, index) => {
      const line = node('div', 'take-eye-box'),
        chip = node('span', 'take-eye-chip');
      Object.assign(line.style, {
        left: box.x * 100 + '%',
        top: box.y * 100 + '%',
        width: box.w * 100 + '%',
        height: box.h * 100 + '%',
      });
      // Its type only where the box has the room for it (moodix.css: a box narrower than 78 px shows its number).
      chip.append(node('b', '', String(index + 1)), node('span', 'take-eye-type', LAYOUT_NAMES[box.label] ?? ''));
      line.setAttribute('aria-hidden', 'true');
      line.append(chip);
      return line;
    });
  eye.type = 'button';
  eye.append(icon('eye'));
  eye.setAttribute('aria-label', 'Ce que le modèle a reçu');
  const say = () => {
    eye.setAttribute('aria-pressed', String(pressed));
    eye.title = eyeTip(boxes.length);
    for (const line of lines) line.hidden = !pressed;
  };
  function tidy() {
    const page = layer.ownerDocument,
      picture = layer.getBoundingClientRect?.();
    if (!page?.querySelectorAll || !picture?.width) return;
    // (« PRISE n » of the Studio and of the page of a take, at their top left; the eye at the top right.) Those of
    // its own stage only: the page of a take opens over the Studio, whose « PRISE n » stays laid out under it.
    const room = layer.closest?.('#media-stage') ?? layer.closest?.('.studio-frame-over')?.parentElement ?? page,
      marks = [...room.querySelectorAll('.studio-frame-label.is-take, #media-take')]
      .filter(mark => !mark.hidden && mark.getClientRects().length)
      .map(mark => mark.getBoundingClientRect());
    marks.push(eye.getBoundingClientRect());
    // Never in its box: it would hide what the model drew there (the first letter of a title). Its corner comes last.
    placeChips(
      lines.filter(line => !line.hidden).map(line => line.firstChild),
      { picture, marks, order: ['is-outside', 'is-below', ''] },
    );
  }
  // A click on the eye is never a click on the picture under it (the page of the take, in the Studio).
  eye.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
    pressed = !pressed;
    say();
    if (pressed) tidy();
  };
  say();
  layer.append(...lines, eye);
  return { element: layer, eye, tidy };
}
