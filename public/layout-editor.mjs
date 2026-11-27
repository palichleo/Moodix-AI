/**
 * (0.6.477) The editor of the boxes of MOSS Image, in the Studio (claude_design/bbox/maquettes, captures B20 to B30;
 * LOTS.md, lots 3 to 5 and 7). A piece of the plateau, « Boîtes », the count of its boxes in its corner, and its small
 * window, the list of the boxes; the boxes over the frame of the preview, drawn there with the pointer, chosen, moved,
 * made larger by their handles, taken away; the small window of a box, hung beside it: what it holds. The Studio calls
 * it in a few places (public/studio.mjs): the piece and its line on the plateau, its choice in « Ajouter », its layer
 * over the frame, why « Générer » is greyed, the prompt sent. The boxes are those of the draft (`draft.boxes`,
 * fractions of the picture: public/layout-boxes.mjs); `draft.layout` says whether their piece is on the plateau. Taken
 * back, they stay in the draft for when it comes again (N8 of 21/11).
 */
import { closePopup, openPopup } from './glass-menu.mjs';
import {
  LAYOUT_LABELS,
  LAYOUT_LIMITS,
  LAYOUT_NAMES,
  LAYOUT_SAYS,
  drawnBox,
  layoutBoxes,
  layoutCaption,
  layoutCount,
  layoutReady,
  layoutTooLong,
  layoutUnread,
  layoutWords,
  pixelBox,
  readLayoutPrompt,
  unfinishedBoxes,
} from './layout-boxes.mjs';
import { placeChips, takeBoxes, takeEye } from './take-eye.mjs';

const NBSP = String.fromCharCode(0xa0);

/** The « ? » of « Expérimental »: what the guide of MOSS Image says of its boxes, and what the eye is for. */
export const LAYOUT_HELP =
  'Expérimental, comme le dit le guide de MOSS Image : dans les essais publiés, environ un objet demandé sur quatre ' +
  'n’apparaît pas.\nAprès la prise, l’œil en haut à droite de l’image montre les boîtes : vous voyez ce qui manque.';
/** What the window of the piece says while it has no box (B20). */
export const LAYOUT_HINT =
  'Tracez une boîte dans le cadre, puis dites ce qu’elle contient : un objet, un personnage ou un texte.';
/** The words of the empty frame while the piece is on the plateau (B20), above its format and its size. */
export const LAYOUT_BLANK = { title: 'Tracez une boîte.', text: 'Appuyez, glissez, relâchez.' };
const LINE_HELP = 'Une ligne ouvre sa boîte.';
// (His decision 3 of 21/11) What a box holds is written in English for the model; what helps, in French.
const HINTS = {
  text: 'Les mots exacts',
  style: 'Leur allure : la police, la taille, la couleur',
  thing: 'Ce qu’on voit dans cette boîte : la chose, sa matière, ses couleurs',
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const overlap = (r, s) =>
  Math.max(0, Math.min(r.right, s.right) - Math.max(r.left, s.left)) *
  Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
/** (0.6.477) The smallest rectangle that holds both, either of them missing. */
const union = (r, s) =>
  r && s
    ? {
        left: Math.min(r.left, s.left),
        top: Math.min(r.top, s.top),
        right: Math.max(r.right, s.right),
        bottom: Math.max(r.bottom, s.bottom),
      }
    : (r ?? s ?? null);
/** Where a point of the screen is in the picture, as fractions of it, held inside it. */
const fractionOf = (at, rect) => ({
  x: clamp((at.x - rect.left) / rect.width, 0, 1),
  y: clamp((at.y - rect.top) / rect.height, 0, 1),
});
/** A box at its place in the picture, in hundredths of it: it follows the frame when its size changes. */
function placeElement(element, box) {
  Object.assign(element.style, {
    left: box.x * 100 + '%',
    top: box.y * 100 + '%',
    width: box.w * 100 + '%',
    height: box.h * 100 + '%',
  });
}
/** What a line of the list says of its box: the words of a text, else the start of its description. */
function excerpt(box) {
  const words = String(box.label === 'text' ? box.text : box.caption)
    .replace(/\s+/g, ' ')
    .trim();
  return box.label === 'text' && words ? `«${NBSP}${words}${NBSP}»` : words;
}
/** What a box lacks to go to the model, by its place: ['text', 'caption'], [] when nothing. */
const lacksOf = (boxes, index) => unfinishedBoxes(boxes).find(item => item.index === index)?.missing ?? [];

/**
 * (0.6.477, lot 5) Where the small window of a box goes on the screen: at the right of the box, else at its left, under
 * it, above it, the first place that covers neither the box nor « Générer », else the one that covers least of them.
 * Over « Générer », it rises above it as far as it can: beside the box up to the top of the preview, (0.6.477) under it
 * as long as it stays under the box (B23 at 1168 × 788: 2.7 px of « Générer » were covered, and 8 px kept free above
 * it would have put the window 0.7 px over the box; it goes 7.3 px above « Générer »). `target`, the box, and `go`,
 * « Générer » (or null), are rectangles of the screen; `size`, the window's; `bounds`, where it may be (between the
 * Entrée and the Réglages, from the top of the preview to the foot of the window). Its place, and what it covers of
 * the box (`covers`, in square pixels: B23 at 1280 × 720 covers the right end of the box, his decision N12).
 */
export function boxWindowPlace({ target, size, bounds, go = null, gap = 12 }) {
  const area = (left, top) => ({ left, top, right: left + size.width, bottom: top + size.height }),
    across = x => Math.max(bounds.left, Math.min(x, bounds.right - size.width)),
    down = y => Math.max(bounds.top, Math.min(y, bounds.bottom - size.height)),
    // Above « Générer » (8 px over it) rather than on it, but never higher than `lowest` (the preview, the box).
    lift = (left, top, lowest) =>
      go && overlap(area(left, top), go) > 0 ? Math.min(top, Math.max(lowest, go.top - 8 - size.height)) : top;
  const places = [
    [target.right + gap, target.top - 6, 'side'],
    [target.left - gap - size.width, target.top - 6, 'side'],
    [target.left, target.bottom + gap, 'under'],
    [target.left, target.top - gap - size.height, 'over'],
  ].map(([x, y, kind]) => {
    const left = across(x),
      top =
        kind === 'side'
          ? lift(left, down(y), bounds.top)
          : kind === 'under'
            ? lift(left, down(y), Math.max(bounds.top, target.bottom + 2))
            : down(y),
      shown = area(left, top),
      covers = overlap(shown, target);
    return { left, top, covers, cost: covers + (go ? overlap(shown, go) : 0) };
  });
  const best = places.find(place => place.cost === 0) ?? places.reduce((a, b) => (b.cost < a.cost ? b : a));
  return { left: Math.round(best.left), top: Math.round(best.top), covers: Math.round(best.covers) };
}
/**
 * (0.6.477) What the window of a box keeps in sight with « Générer » (`go`, its group): what is said in the line above
 * the buttons (`line`, .studio-under of studio.mjs, its `words` centred in it), when something is said there: a
 * failure, the model not on this computer. Beside box 2 at 1280 × 720, the window hid the end of « MOSS Image n’est
 * pas sur cet ordinateur. ». The line is as wide as the screen: its words only, never wider than it.
 */
export function keptInSight({ go = null, line = null, words = null }) {
  if (!line?.width) return go;
  const said = words?.width
    ? {
        left: Math.max(line.left, words.left),
        top: words.top,
        right: Math.min(line.right, words.right),
        bottom: words.bottom,
      }
    : line;
  return union(go, said);
}

/** (Under a proposal of Moodix AI, as its images: AI_INPUTS of studio.mjs.) */
export const LAYOUT_PROPOSED =
  'Les boîtes de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.';

/**
 * The editor, for one Studio. `draft()` and `workflow()`: the draft and the model in hand; `render()` draws the Studio
 * again, `goable()` greys « Générer » in place as it follows the prompt being typed; `busy()`: why nothing can be
 * changed now ('' when it can: a take being made); `proposed()`: a proposal of Moodix AI is answered, its boxes are
 * its own (shown as it has them, they go with it: studio.mjs, edits); `closeOthers()` and `othersOpen()`: the other
 * windows of the Studio, one thing open at a time.
 */
export function setupLayoutEditor({
  node,
  icon,
  notice = () => {},
  draft,
  workflow,
  render,
  goable = () => {},
  busy = () => '',
  proposed = () => false,
  closeOthers = () => {},
  othersOpen = () => false,
  document: page = globalThis.document,
  view = globalThis,
}) {
  let open = false, // the window of the piece is open
    focusIn = false, // it was opened by a hand (its case, « Ajouter »): the focus goes into it once it is shown
    chosen = -1, // the box whose window is open, by its place in the list
    chosenFocus = '', // what takes the focus in that window once it is shown: 'text', 'caption', 'kind', or nothing
    kept = null, // { field, start, end }: the field being written in, found again once the Studio is drawn again
    told = null, // { text, x, y }: what was said at the hand (x, y: fractions of the picture), until the next gesture
    gesture = null, // the gesture under way in the frame
    refocus = null, // the place of a box taken away with the keyboard: the focus goes to the one there now
    openFor = null, // the draft those windows were opened for (another mode, another draft: they are closed)
    shown = {}; // what was drawn last, changed in place: { piece, pane, layer, canvas, boxWindow, eye, blank, editing }

  const list = () => {
    const own = draft();
    if (!Array.isArray(own.boxes)) own.boxes = [];
    return own.boxes;
  };
  const present = () => draft()?.layout === true;
  const reads = model => model?.layout === true;
  /** Why the boxes cannot be changed now, '' when they can. */
  const held = () => (proposed() ? LAYOUT_PROPOSED : busy());
  const press = (className, text, run, glyph) => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = run;
    return control;
  };
  /** The « ? » of « Expérimental », in a window: its help at once under the pointer or on the focus (help-tips.mjs). */
  function ask() {
    const help = node('span', 'help-tip studio-tip', '?');
    help.tabIndex = 0;
    help.setAttribute('role', 'img');
    help.setAttribute('aria-label', 'Aide : ' + LAYOUT_HELP);
    help.dataset.help = LAYOUT_HELP;
    help.onclick = event => event.preventDefault();
    return help;
  }
  /** The size of the picture to make, in whole pixels: the one chosen in Réglages, else the model's own. */
  function sizeOf(model = workflow(), own = draft()) {
    const [width, height] = /^\d+x\d+$/.test(own?.size ?? '') ? own.size.split('x').map(Number) : [];
    if (width > 0 && height > 0) return { width, height };
    const size = model?.size;
    if (size?.width > 0 && size?.height > 0) return { width: size.width, height: size.height };
    return { width: 1024, height: 1024 };
  }

  // ------------------------------------------------------------------ what goes to the model
  /**
   * Why « Générer » is greyed by the boxes, '' when it is not (B24, B27): a box to describe, its words to write, the
   * layout too long for MOSS Image. Only with their piece, under a model that reads them; never under a proposal of
   * Moodix AI, answered as it is.
   */
  function reason(model = workflow()) {
    if (!present() || !reads(model) || !list().length || proposed()) return '';
    return layoutReady(draft().prompt, list(), sizeOf(model)).reason;
  }
  /** « Générer » greyed in place by the boxes, as the form greys it (goable, as the prompt is typed). */
  function grey(go, model = workflow()) {
    const why = go ? reason(model) : '';
    if (!why) return;
    go.disabled = true;
    go.title = why;
  }
  /**
   * The prompt the model receives with the boxes (request, edits): the layout, at the size the picture is made at
   * (`size`, else the one of the draft); null without boxes, the prompt going as it is written. Refused with its reason
   * while a box lacks something or the layout is too long: the Studio never sends what the server would refuse.
   */
  function prompt(model, own = draft(), text = own?.prompt, size = null) {
    if (own?.layout !== true || !reads(model) || !layoutBoxes(own.boxes).length) return null;
    const made = size?.width > 0 && size?.height > 0 ? { width: size.width, height: size.height } : sizeOf(model, own);
    const ready = layoutReady(String(text ?? '').trim(), own.boxes, made);
    if (ready.reason) throw Error(ready.reason);
    return ready.prompt;
  }
  /**
   * A take opened again in the Studio (adopt, its prompt already in the draft): made with boxes, its prompt is their
   * caption and they come back on their piece; without, the piece is taken back, the boxes of the draft kept for when
   * it comes again (N8). What could not be kept as it was is said, once.
   */
  function adopt(own, record) {
    const made = record?.parameters ?? {},
      output = record?.outputs?.[0] ?? {},
      size = { width: made.width ?? output.width, height: made.height ?? output.height },
      read = readLayoutPrompt(record?.prompt, size),
      count = layoutCount(record?.prompt);
    if (own === draft()) opened({});
    own.layout = Boolean(read);
    if (read) Object.assign(own, { prompt: read.prompt, boxes: read.boxes });
    // (Never the JSON in the prompt: of a size not known, the caption alone.)
    else if (count) own.prompt = layoutCaption(own.prompt);
    if (read?.left.length) notice('Les boîtes de cette prise ne sont pas toutes reprises telles qu’elles étaient.');
    else if (!read && count)
      notice('Les boîtes de cette prise n’ont pas pu être reprises : sa taille n’est pas connue.');
  }

  // ------------------------------------------------------------------ the piece and its window
  /**
   * The line « Boîtes » of the list « Ajouter », for a model that reads them (another model's list greys it with the
   * name of MOSS Image, as any piece: addChoices). Once on the plateau, « déjà posées »; taken back with boxes, they
   * come back with it (« 3 boîtes gardées »).
   */
  function choice(name, given) {
    if (present())
      return { name, note: given, off: 'Les boîtes sont déjà posées : cliquez sur leur case pour les changer.' };
    const count = list().length,
      note = count ? layoutWords(count) + (count > 1 ? ' gardées' : ' gardée') : '';
    return { name, ...(note ? { note } : {}), run: add };
  }
  /** The piece put on the plateau, its window open: the empty frame is ready to be drawn in (B20). */
  function add() {
    closeOthers();
    draft().layout = true;
    opened({ list: true, box: -1, focus: true });
    render();
  }
  /** Which of its windows is open, for the draft in hand (those of another draft are closed: piece). */
  function opened({ list = false, box = -1, focus = false }) {
    told = null;
    openFor = draft();
    open = list;
    chosen = box;
    focusIn = focus;
  }
  /** Its window opened, closed if it was open: one thing open at a time. */
  function toggle() {
    const opening = !open;
    if (opening) closeOthers();
    opened({ list: opening, focus: opening });
    render();
  }
  /** « Retirer » the piece (its × and its window): its boxes stay in the draft, for when it comes again (N8). */
  function takeBack() {
    draft().layout = false;
    opened({});
    render();
  }
  /** What is said in amber at the head of the window: the limit of twelve (B26), the layout too long (B27). */
  function alerts(model) {
    const boxes = list(),
      said = [];
    if (boxes.length >= LAYOUT_LIMITS.boxes) said.push(LAYOUT_SAYS.full);
    const ready = boxes.length ? layoutReady(draft().prompt, boxes, sizeOf(model)) : null;
    if (ready?.reason === LAYOUT_SAYS.long) said.push(layoutTooLong(ready.length));
    return said;
  }
  /**
   * The piece on the plateau, its window hung under it when it is open (B20, B26); null when it is not there. Under a
   * model that does not read the boxes, greyed, its window folded on why (B28, B28b, his decision 5).
   */
  function piece(model = workflow()) {
    if (!present() || openFor !== draft() || held() || othersOpen()) {
      open = false;
      chosen = -1;
    }
    if (!present()) return (shown.piece = null);
    const count = list().length,
      off = reads(model) ? '' : `Boîtes gardées : ${model?.name ?? 'ce modèle'} ne les lit pas.`,
      still = held(),
      element = node('div', 'studio-piece studio-boxes' + (off ? ' is-off' : '') + (open ? ' is-open' : '')),
      tile = node('div', 'studio-slot is-filled' + (off ? ' is-off' : '')),
      pick = press('studio-slot-pick', '', toggle, 'boxes'),
      mark = node('span', 'studio-boxes-count' + (count >= LAYOUT_LIMITS.boxes ? ' is-full' : ''), String(count)),
      remove = press('studio-slot-remove', '', takeBack, 'close'),
      word = node('span', 'studio-piece-word', 'Boîtes'),
      said = 'Boîtes · ' + count;
    // (Its case is what « Générer » greyed by a box lights up: pressGo, `boxes-0`.)
    tile.dataset.slot = 'boxes-0';
    mark.setAttribute('aria-hidden', 'true');
    pick.append(mark);
    pick.title = still || off || said;
    pick.setAttribute('aria-label', off || said);
    pick.setAttribute('aria-haspopup', 'dialog');
    pick.setAttribute('aria-expanded', String(open));
    pick.disabled = remove.disabled = Boolean(still);
    remove.setAttribute('aria-label', 'Retirer les boîtes');
    remove.title = 'Retirer';
    word.setAttribute('aria-hidden', 'true');
    tile.append(pick, remove);
    element.append(tile, word);
    shown.piece = { element, pick };
    shown.pane = null;
    if (open) {
      const pane = pieceWindow(model, off);
      element.append(pane);
      shown.pane = pane;
      // Shown once it is on the page, above it (as every window of a piece).
      globalThis.queueMicrotask?.(() => show(pane, pick));
    }
    return element;
  }
  /** Its window: « Boîtes », « 3 / 12 », « Expérimental » and its « ? »; what blocks; the list, else what to do. */
  function pieceWindow(model, off) {
    const boxes = list(),
      count = boxes.length,
      full = count >= LAYOUT_LIMITS.boxes,
      pane = node('div', 'glass-menu studio-piece-window studio-boxes-window' + (off ? ' is-greyed' : '')),
      head = node('div', 'studio-boxes-head'),
      foot = node('div', 'studio-window-foot'),
      remove = press('studio-window-button', 'Retirer', takeBack);
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', 'Boîtes');
    pane.tabIndex = -1;
    pane.hidden = true;
    head.append(
      node('p', 'studio-window-title', 'Boîtes'),
      node('span', 'studio-boxes-of' + (full ? ' is-full' : ''), `${count} / ${LAYOUT_LIMITS.boxes}`),
    );
    if (!off) head.append(node('span', 'studio-boxes-tag', 'Expérimental'), ask());
    pane.append(head);
    if (off) {
      const said = layoutUnread(model?.name ?? 'Ce modèle', count, { window: true });
      pane.append(node('p', 'studio-boxes-said', said));
    } else {
      for (const text of alerts(model)) {
        const said = node('p', 'studio-boxes-said is-alert', text);
        said.setAttribute('role', 'alert');
        pane.append(said);
      }
      pane.append(count ? lines(boxes) : node('p', 'studio-boxes-said', LAYOUT_HINT));
      if (count) foot.append(node('span', 'studio-window-said', LINE_HELP));
    }
    // (N8) Taken back, its boxes are kept: « Ajouter » puts them back with it.
    remove.title = !count
      ? 'Retirer la pièce'
      : count > 1
        ? `Retirer la pièce : ses ${layoutWords(count)} restent gardées, « Ajouter » les remet.`
        : 'Retirer la pièce : sa boîte reste gardée, « Ajouter » la remet.';
    remove.disabled = Boolean(held());
    foot.append(remove);
    pane.append(foot);
    return pane;
  }
  /** The list: a line a box, its number, its type, what it says (in amber what it lacks); its × takes it away. */
  function lines(boxes) {
    const shownList = node('ol', 'studio-boxes-lines');
    shownList.setAttribute('aria-label', 'Les boîtes');
    boxes.forEach((box, index) => {
      const lack = lacksOf(boxes, index),
        // (Decision 4: the words of a text before its description, as its window asks them.)
        words = lack.includes('text') ? 'Texte à écrire' : lack.includes('caption') ? 'À décrire' : excerpt(box),
        name = LAYOUT_NAMES[box.label],
        line = node('li', 'studio-boxes-line' + (lack.length ? ' is-missing' : '')),
        pick = press('studio-boxes-pick', '', () => choose(index)),
        remove = press('studio-boxes-remove', '', () => removeBox(index), 'close');
      pick.append(
        node('span', 'studio-boxes-num', String(index + 1)),
        node('span', 'studio-boxes-type', name),
        node('span', 'studio-boxes-excerpt', words),
      );
      pick.setAttribute('aria-label', `Boîte ${index + 1} · ${name}` + (words ? ' · ' + words : ''));
      remove.setAttribute('aria-label', 'Retirer la boîte ' + (index + 1));
      remove.title = 'Retirer la boîte ' + (index + 1);
      line.append(pick, remove);
      shownList.append(line);
    });
    return shownList;
  }
  /**
   * The window shown under its case (above when there is no room under it): a list taller than the room left under the
   * case scrolls in itself, the page never does (his decision N10: seven lines at 1280 × 720).
   */
  function show(pane, pick) {
    if (!pane.isConnected || !open) return;
    const listed = pane.querySelector?.('.studio-boxes-lines');
    openPopup(pane, pick, { align: 'start', view });
    const tile = pick.getBoundingClientRect?.(),
      box = pane.getBoundingClientRect?.(),
      height = view.innerHeight ?? 800;
    if (listed && tile && box) {
      const below = height - 8 - (tile.bottom + 6),
        above = tile.top - 6 - 8,
        over = box.height - below;
      if (over > 0 && box.height > above) {
        listed.style.maxHeight = Math.max(90, Math.floor(listed.getBoundingClientRect().height - over)) + 'px';
        listed.classList.add('is-scrolled');
        openPopup(pane, pick, { align: 'start', view });
      }
    }
    if (focusIn) {
      focusIn = false;
      pane.focus?.({ preventScroll: true });
    }
  }
  /** A box chosen (its line, a click on it in the frame): its window, hung beside it; the list closes for it. */
  function choose(index, field = '') {
    const boxes = list();
    if (!boxes[index]) return;
    closeOthers();
    const lack = lacksOf(boxes, index);
    opened({ box: index });
    chosenFocus = field || (lack.includes('text') ? 'text' : 'caption');
    render();
  }
  /** A box taken away (its ×, « Retirer » in its window, Suppr): the others keep their order, their numbers follow. */
  function removeBox(index) {
    const boxes = list();
    if (!boxes[index]) return;
    boxes.splice(index, 1);
    opened({ list: open, focus: open });
    render();
  }
  /** Another type for a box: its words stay in the draft, for a text it comes back to. */
  function setKind(index, label) {
    const boxes = list();
    if (!boxes[index] || boxes[index].label === label) return;
    boxes[index] = { ...boxes[index], label };
    chosenFocus = 'kind';
    render();
  }

  // ------------------------------------------------------------------ the frame
  /** The words of the empty frame while the piece waits for its first box (B20); none otherwise. */
  function blank(model = workflow()) {
    if (!present() || !reads(model) || held() || list().length) return [];
    return [node('p', 'studio-blank-title', LAYOUT_BLANK.title), node('p', 'studio-blank-text', LAYOUT_BLANK.text)];
  }
  /**
   * Over the frame (`over`, at its size): the boxes while they can be drawn (the piece on the plateau, a model that
   * reads them, the frame empty or one of their windows open: N9), greyed under a model that does not read them (B28);
   * the eye of a take made with boxes otherwise (public/take-eye.mjs, B31). `blank`: the frame is empty, the boxes fill
   * it; `record`: the take it shows, whose picture is the frame less 8 px all around.
   */
  function layer(over, { blank: empty = false, record = null } = {}) {
    const model = workflow(),
      boxes = list(),
      can = present() && reads(model) && !held();
    if (!can || chosen >= boxes.length) chosen = -1;
    const editing = can && (empty || open || chosen >= 0),
      greyed = present() && !reads(model) && boxes.length > 0 && (empty || open);
    // What was said at the hand goes with the drawing: greyed under another model, it would still say it.
    if (!editing) told = null;
    // Written in when the Studio is drawn again: found again in the new window.
    const active = page?.activeElement;
    if (active?.closest?.('.studio-box-window') && active.dataset?.field && chosen >= 0) {
      kept = { field: active.dataset.field, start: active.selectionStart, end: active.selectionEnd };
      chosenFocus = active.dataset.field;
    }
    shown = { piece: shown.piece, pane: shown.pane, blank: empty, editing };
    if (!empty && record) eyeOver(over, record, editing || greyed);
    if (!editing && !greyed) return;
    const size = sizeOf(model),
      root = node('div', 'studio-layout' + (editing ? ' is-drawing' : ' is-greyed') + (empty ? ' is-blank' : '')),
      canvas = node('div', 'studio-layout-canvas');
    root.style.setProperty?.('--layout-ratio', (size.width / size.height).toFixed(4));
    if (editing) {
      canvas.setAttribute('role', 'group');
      canvas.setAttribute('aria-label', 'Les boîtes dans l’image : appuyez, glissez, relâchez pour en tracer une');
      listen(canvas);
    }
    root.append(canvas);
    over.append(root);
    Object.assign(shown, { layer: root, canvas });
    paint();
    if (editing && chosen >= 0) {
      const pane = boxWindow(chosen);
      root.append(pane);
      shown.boxWindow = pane;
      globalThis.queueMicrotask?.(() => placeBox(pane));
    }
    if (refocus !== null) {
      const at = Math.min(refocus, boxes.length - 1);
      refocus = null;
      const back = () => canvas.querySelector?.(`[data-index="${at}"]`) ?? shown.piece?.pick;
      globalThis.queueMicrotask?.(() => back()?.focus?.({ preventScroll: true }));
    }
  }
  /** The eye of the take shown, made with boxes: kept hidden while the boxes of the draft are drawn over it. */
  function eyeOver(over, record, hidden) {
    const read = takeBoxes(record);
    if (!read) return;
    const root = node('div', 'studio-layout is-eye'),
      canvas = node('div', 'studio-layout-canvas'),
      eye = takeEye({ node, icon, boxes: read.boxes });
    root.style.setProperty?.('--layout-ratio', (read.size.width / read.size.height).toFixed(4));
    root.hidden = hidden;
    canvas.append(eye.element);
    root.append(canvas);
    over.append(root);
    shown.eye = { root, eye };
    if (!hidden) view.requestAnimationFrame?.(() => eye.tidy());
  }
  /** The boxes in the frame as the draft has them, and what was said at the hand: drawn again in place. */
  function paint() {
    const canvas = shown.canvas;
    if (!canvas) return;
    const boxes = list(),
      missing = unfinishedBoxes(boxes);
    canvas.replaceChildren(...boxes.map((box, index) => boxElement(box, index, missing)));
    if (told) canvas.append(toldElement());
    view.requestAnimationFrame?.(tidy);
  }
  /**
   * A box in the frame: its number and its type in its corner (the type where it has the room: moodix.css), what it
   * holds where it has the room; chosen, its four handles. A box of 2 % read from a file is 5 px at 1280 × 720: it is
   * taken by 12 px around it all the same (moodix.css).
   */
  function boxElement(box, index, missing) {
    const editing = shown.editing,
      lack = missing.some(item => item.index === index),
      picked = editing && index === chosen,
      name = LAYOUT_NAMES[box.label],
      element = node(
        'div',
        'studio-layout-box' + (!editing ? ' is-greyed' : picked ? ' is-chosen' : lack ? ' is-missing' : ''),
      ),
      chip = node('span', 'studio-layout-chip'),
      words = String(box.label === 'text' ? box.text : box.caption)
        .replace(/\s+/g, ' ')
        .trim();
    element.dataset.index = String(index);
    placeElement(element, box);
    chip.append(node('b', '', String(index + 1)), node('span', 'studio-layout-type', name));
    element.append(chip);
    if (words) {
      const said = node('span', 'studio-layout-words' + (box.label === 'text' ? ' is-text' : ''));
      said.setAttribute('aria-hidden', 'true');
      said.append(node('span', '', words));
      element.append(said);
    }
    if (!editing) return element;
    element.tabIndex = 0;
    element.setAttribute('role', 'button');
    const about = lack ? ' · à compléter' : words ? ' · ' + words : '';
    element.setAttribute('aria-label', `Boîte ${index + 1} · ${name}` + about);
    if (picked)
      for (const corner of ['tl', 'tr', 'bl', 'br']) {
        const handle = node('span', 'studio-layout-handle is-' + corner);
        handle.dataset.corner = corner;
        handle.setAttribute('aria-hidden', 'true');
        element.append(handle);
      }
    return element;
  }
  /** The numbers where they are read: in the corner of their box, else above it or under it (never on « PRISE n »). */
  function tidy() {
    const canvas = shown.canvas,
      picture = canvas?.getBoundingClientRect?.();
    if (!canvas?.isConnected || !picture?.width) return;
    const marks = [...(page?.querySelectorAll?.('#studio-view .studio-frame-label.is-take') ?? [])]
      .filter(mark => mark.getClientRects().length)
      .map(mark => mark.getBoundingClientRect());
    // (A box narrower or lower than its number has no corner for it: above it, else under it. In its corner, the
    // number is held to the width of the box, and its words go past it.)
    const order = chip => {
      chip.classList.remove('is-outside', 'is-below');
      const low = chip.offsetHeight > chip.parentElement.clientHeight - 4,
        cramped = chip.scrollWidth > chip.clientWidth + 1 || low;
      return cramped ? ['is-outside', 'is-below'] : ['', 'is-outside', 'is-below'];
    };
    placeChips([...canvas.querySelectorAll('.studio-layout-chip')], { picture, marks, order });
    const said = canvas.querySelector('.studio-layout-said');
    if (said) keepInside(said);
  }
  /** What is said at the hand stays in the preview: near an edge, it goes to the other side of the hand. */
  function keepInside(said) {
    const block = said.closest?.('.studio-block') ?? said.closest?.('.studio-stage'),
      room = block?.getBoundingClientRect?.(),
      r = said.getBoundingClientRect?.();
    if (!told || !room || !r?.width) return;
    const shift =
      r.right > room.right - 10 ? room.right - 10 - r.right : r.left < room.left + 10 ? room.left + 10 - r.left : 0;
    if (shift) said.style.left = `calc(${told.x * 100}% - 12px + ${Math.round(shift)}px)`;
    if (r.bottom > room.bottom - 10) said.style.top = `calc(${told.y * 100}% - 16px - ${Math.round(r.height)}px)`;
  }
  const toldElement = () => {
    const said = node('span', 'studio-layout-said', told.text);
    said.setAttribute('role', 'status');
    said.style.left = `calc(${told.x * 100}% - 12px)`;
    said.style.top = `calc(${told.y * 100}% + 16px)`;
    return said;
  };
  /** Said in amber at the hand, where the gesture ended (B25, B30), until the next one. */
  function say(canvas, text, at, rect) {
    told = { text, ...fractionOf(at, rect) };
    canvas.querySelector?.('.studio-layout-said')?.remove();
    const said = toldElement();
    canvas.append(said);
    keepInside(said);
  }

  // ------------------------------------------------------------------ the gestures
  /**
   * Pressed in the frame: on a handle of the box chosen, it is made larger or smaller; on a box, it is moved (a click
   * chooses it); beside, a box is drawn, from where the pointer was pressed to where it is released (drawnBox: 12 px at
   * least, twelve boxes at most). On the keyboard, a box in hand: Entrée opens it, the arrows move it (Maj: by more),
   * Suppr takes it away; Échap closes its window.
   */
  function listen(canvas) {
    canvas.onpointerdown = event => {
      if (event.button !== 0 || gesture || held()) return;
      const rect = canvas.getBoundingClientRect?.();
      if (!rect?.width || !rect?.height) return;
      const at = { x: event.clientX, y: event.clientY },
        handle = event.target?.closest?.('.studio-layout-handle'),
        hit = event.target?.closest?.('.studio-layout-box'),
        index = hit ? Number(hit.dataset.index) : -1,
        boxes = list();
      event.preventDefault();
      told = null;
      canvas.querySelector?.('.studio-layout-said')?.remove();
      if (handle && index === chosen && boxes[index])
        gesture = { kind: 'size', index, corner: handle.dataset.corner, box: { ...boxes[index] }, element: hit };
      else if (hit && boxes[index]) gesture = { kind: 'move', index, box: { ...boxes[index] }, element: hit };
      else if (boxes.length >= LAYOUT_LIMITS.boxes) return say(canvas, LAYOUT_SAYS.refused, at, rect);
      else gesture = { kind: 'draw', element: null };
      Object.assign(gesture, { from: at, rect, pointer: event.pointerId, moved: false });
      canvas.setPointerCapture?.(event.pointerId);
    };
    canvas.onpointermove = event => {
      if (!gesture || event.pointerId !== gesture.pointer) return;
      const at = { x: event.clientX, y: event.clientY };
      gesture.moved ||= Math.hypot(at.x - gesture.from.x, at.y - gesture.from.y) > 3;
      if (gesture.kind === 'draw') return drawing(canvas, at);
      if (!gesture.moved) return;
      gesture.now = gesture.kind === 'move' ? moved(gesture, at) : sized(gesture, at);
      placeElement(gesture.element, gesture.now);
    };
    canvas.onpointerup = event => {
      if (!gesture || event.pointerId !== gesture.pointer) return;
      const done = gesture,
        at = { x: event.clientX, y: event.clientY },
        boxes = list();
      gesture = null;
      canvas.releasePointerCapture?.(event.pointerId);
      if (done.kind === 'draw') {
        done.element?.remove();
        const made = drawnBox(done.from, at, done.rect);
        if (!made) {
          // A click beside the box chosen lets it go; a gesture too short says why.
          if (!done.moved && chosen >= 0) return closeBox();
          return say(canvas, LAYOUT_SAYS.small, at, done.rect);
        }
        const [box] = layoutBoxes([{ ...made, label: 'object', caption: '', text: '' }]);
        if (!box || boxes.length >= LAYOUT_LIMITS.boxes) return say(canvas, LAYOUT_SAYS.refused, at, done.rect);
        boxes.push(box);
        opened({ box: boxes.length - 1 });
        chosenFocus = 'caption';
        return render();
      }
      if (!done.moved) return choose(done.index);
      const [box] = layoutBoxes([done.now ?? done.box]),
        own = boxes[done.index];
      if (box && own) boxes[done.index] = { ...own, x: box.x, y: box.y, w: box.w, h: box.h };
      opened({ box: done.index });
      chosenFocus = '';
      render();
    };
    canvas.onpointercancel = () => cancel();
    canvas.onkeydown = event => {
      const hit = event.target?.closest?.('.studio-layout-box'),
        index = hit ? Number(hit.dataset.index) : -1,
        boxes = list(),
        box = boxes[index];
      if (!box || gesture) return;
      const step = event.shiftKey ? 0.05 : 0.01,
        by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        return choose(index);
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        refocus = index;
        return removeBox(index);
      }
      if (!by) return;
      event.preventDefault();
      boxes[index] = { ...box, x: clamp(box.x + by[0], 0, 1 - box.w), y: clamp(box.y + by[1], 0, 1 - box.h) };
      placeElement(hit, boxes[index]);
      if (index === chosen && shown.boxWindow) placeBox(shown.boxWindow);
    };
  }
  /** The box being drawn, dashed, with its size in pixels of the picture (B21); in amber under 12 px (B30). */
  function drawing(canvas, at) {
    const { from, rect } = gesture,
      a = fractionOf(from, rect),
      b = fractionOf(at, rect),
      box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) },
      small = box.w * rect.width < LAYOUT_LIMITS.drawn || box.h * rect.height < LAYOUT_LIMITS.drawn;
    if (!gesture.element) {
      gesture.element = node('div', 'studio-layout-box is-drawn');
      gesture.readout = node('span', 'studio-layout-readout');
      gesture.element.append(gesture.readout);
      canvas.append(gesture.element);
    }
    gesture.element.classList.toggle('is-small', small);
    placeElement(gesture.element, box);
    const [top, left, bottom, right] = pixelBox(box, sizeOf()) ?? [0, 0, 0, 0];
    gesture.readout.textContent = `${right - left} × ${bottom - top}`;
    gesture.readout.classList.toggle('is-outside', box.w * rect.width < 90 || box.h * rect.height < 26);
  }
  /** A box moved by the hand, held in the picture. */
  function moved({ box, from, rect }, at) {
    return {
      ...box,
      x: clamp(box.x + (at.x - from.x) / rect.width, 0, 1 - box.w),
      y: clamp(box.y + (at.y - from.y) / rect.height, 0, 1 - box.h),
    };
  }
  /** A box made larger or smaller by a corner: the corner across stays, its sides never under 12 px on the screen. */
  function sized({ box, corner, rect }, at) {
    const point = fractionOf(at, rect),
      least = { w: LAYOUT_LIMITS.drawn / rect.width, h: LAYOUT_LIMITS.drawn / rect.height },
      left = corner.endsWith('l'),
      top = corner.startsWith('t'),
      right = box.x + box.w,
      bottom = box.y + box.h,
      x0 = left ? Math.min(point.x, right - least.w) : box.x,
      x1 = left ? right : Math.max(point.x, box.x + least.w),
      y0 = top ? Math.min(point.y, bottom - least.h) : box.y,
      y1 = top ? bottom : Math.max(point.y, box.y + least.h);
    return { ...box, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** A gesture given up (Échap, the pointer lost): nothing changes. */
  function cancel() {
    const done = gesture;
    gesture = null;
    if (!done) return;
    if (done.kind === 'draw') done.element?.remove();
    else if (done.element) placeElement(done.element, done.box);
  }

  // ------------------------------------------------------------------ the window of a box
  /**
   * The small window of the box chosen (B22 to B24): its number, its type (Objet, Personnage, Texte), for a text the
   * words to write first (decision 4), its description; what it lacks in amber; at its foot « Expérimental », its « ? »
   * and « Retirer ». Hung beside the box (boxWindowPlace).
   */
  function boxWindow(index) {
    const boxes = list(),
      box = boxes[index],
      number = index + 1,
      lack = lacksOf(boxes, index),
      pane = node('div', 'glass-menu studio-piece-window studio-box-window'),
      head = node('div', 'studio-boxes-head'),
      kinds = node('div', 'studio-box-kinds'),
      foot = node('div', 'studio-window-foot studio-box-foot'),
      remove = press('studio-window-button', 'Retirer', () => removeBox(index));
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', 'Boîte ' + number);
    pane.tabIndex = -1;
    pane.hidden = true;
    head.append(
      node('span', 'studio-boxes-num is-chosen', String(number)),
      node('p', 'studio-window-title', 'Boîte ' + number),
    );
    kinds.setAttribute('role', 'radiogroup');
    kinds.setAttribute('aria-label', 'Type de la boîte');
    for (const label of LAYOUT_LABELS) {
      const kind = press('studio-box-kind', LAYOUT_NAMES[label], () => setKind(index, label));
      kind.setAttribute('role', 'radio');
      kind.setAttribute('aria-checked', String(box.label === label));
      kind.tabIndex = box.label === label ? 0 : -1;
      kind.dataset.kind = label;
      kinds.append(kind);
    }
    // The arrows go from one type to the next, as in any group of choices.
    kinds.onkeydown = event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const at = LAYOUT_LABELS.indexOf(box.label);
      setKind(index, LAYOUT_LABELS[(at + step + LAYOUT_LABELS.length) % LAYOUT_LABELS.length]);
    };
    pane.append(head, kinds);
    if (box.label === 'text')
      pane.append(field(index, 'text', { name: 'Texte à écrire', hint: HINTS.text, rows: 1, inline: true, lack }));
    const hint = box.label === 'text' ? HINTS.style : HINTS.thing;
    pane.append(field(index, 'caption', { name: 'Description', hint, rows: 2, lack }));
    remove.title = 'Retirer la boîte ' + number;
    foot.append(node('span', 'studio-boxes-tag', 'Expérimental'), ask(), remove);
    pane.append(foot);
    return pane;
  }
  /** One of its fields: what it holds is the draft's as it is typed, the box in the frame and « Générer » follow. */
  function field(index, key, { name, hint, rows, inline = false, lack }) {
    const box = list()[index],
      wrap = node('label', 'studio-box-field' + (inline ? ' is-inline' : '')),
      control = node('textarea');
    wrap.classList.toggle('is-missing', lack.includes(key));
    control.rows = rows;
    control.value = String(box[key] ?? '');
    control.placeholder = hint;
    control.maxLength = key === 'text' ? LAYOUT_LIMITS.text : LAYOUT_LIMITS.caption;
    control.dataset.field = key;
    control.oninput = () => {
      const own = list()[index];
      if (!own) return;
      own[key] = control.value;
      wrap.classList.toggle('is-missing', lacksOf(list(), index).includes(key));
      paint();
      goable();
    };
    wrap.append(node('span', 'studio-label', name), control);
    return wrap;
  }
  /** The window of the box shown beside it, on the page (its place: boxWindowPlace); the focus where it was asked. */
  function placeBox(pane) {
    const target = shown.canvas?.querySelector?.(`.studio-layout-box[data-index="${chosen}"]`);
    if (!pane?.isConnected || chosen < 0 || !target?.getBoundingClientRect) return;
    pane.hidden = false;
    try {
      if (!pane.hasAttribute('popover')) pane.setAttribute('popover', 'manual');
      if (!pane.matches(':popover-open')) pane.showPopover();
    } catch {
      return; // not on the page any more, or a browser without popovers: the window stays where it is
    }
    Object.assign(pane.style, { position: 'fixed', inset: 'auto', margin: '0' });
    const rect = target.getBoundingClientRect(),
      size = pane.getBoundingClientRect(),
      edge = selector => page.querySelector?.('#studio-view ' + selector)?.getBoundingClientRect?.(),
      entry = edge('.studio-block.is-input'),
      settings = edge('.studio-block.is-settings'),
      preview = edge('.studio-block.is-preview'),
      width = view.innerWidth ?? 1280,
      height = view.innerHeight ?? 800,
      bounds = {
        left: (entry?.right ?? 0) + 4,
        right: (settings?.left ?? width) - 4,
        top: preview?.top ?? 8,
        bottom: height - 8,
      };
    // (A Studio in one column has no room between its blocks: the whole width of the window, then.)
    if (bounds.right - bounds.left < size.width) Object.assign(bounds, { left: 8, right: width - 8 });
    // (0.6.477) What is said above the buttons stays in sight as « Générer » does (keptInSight), its words measured.
    const said = page.querySelector?.('#studio-view .studio-under > *'),
      line = said?.textContent?.trim() ? said.getBoundingClientRect?.() : null,
      range = line ? page.createRange?.() : null;
    range?.selectNodeContents?.(said);
    const go = keptInSight({ go: edge('.studio-go-group'), line, words: range?.getBoundingClientRect?.() }),
      at = boxWindowPlace({ target: rect, size, bounds, go });
    pane.style.left = at.left + 'px';
    pane.style.top = at.top + 'px';
    const wanted = chosenFocus,
      again = kept;
    chosenFocus = '';
    kept = null;
    const focused =
      wanted === 'kind'
        ? pane.querySelector('.studio-box-kind[aria-checked="true"]')
        : wanted
          ? pane.querySelector(`textarea[data-field="${wanted}"]`)
          : null;
    if (!focused) return;
    focused.focus({ preventScroll: true });
    if (focused.tagName !== 'TEXTAREA') return;
    const end = focused.value.length;
    focused.setSelectionRange?.(again?.field === wanted ? again.start : end, again?.field === wanted ? again.end : end);
  }
  /** The window of the box closed, in place: over a take, the boxes leave the frame and its eye comes back. */
  function closeBox() {
    chosen = -1;
    if (shown.boxWindow) closePopup(shown.boxWindow);
    shown.boxWindow = null;
    settleInPlace();
  }
  /**
   * The windows closed without drawing the Studio again (a press beside them, Échap): a press on another control is
   * also its click, which a control drawn again meanwhile would lose (as the windows of the other pieces, studio.mjs).
   */
  function close({ refocus: back = false } = {}) {
    const was = open || chosen >= 0;
    open = false;
    chosen = -1;
    told = null;
    cancel();
    if (shown.pane) closePopup(shown.pane);
    if (shown.boxWindow) closePopup(shown.boxWindow);
    shown.pane = shown.boxWindow = null;
    shown.piece?.element?.classList?.remove?.('is-open');
    shown.piece?.pick?.setAttribute?.('aria-expanded', 'false');
    if (was) settleInPlace();
    if (back) shown.piece?.pick?.focus?.();
  }
  function settleInPlace() {
    if (open || chosen >= 0 || shown.blank) return paint();
    // Over a take: the frame is the take's again, a click on it opens its page (N9); its eye, if it has one.
    if (shown.layer) shown.layer.hidden = true;
    if (shown.eye) {
      shown.eye.root.hidden = false;
      view.requestAnimationFrame?.(() => shown.eye?.eye.tidy());
    }
  }
  page?.addEventListener?.(
    'pointerdown',
    event => {
      if (!open && chosen < 0) return;
      const target = event.target;
      // (The bubble of the « ? » goes into the window it is in: a press on it is in the window.)
      if (shown.piece?.element?.contains?.(target) || shown.layer?.contains?.(target)) return;
      close();
    },
    true,
  );
  // Échap: a gesture under way first, then the window of a box, then that of the piece, the focus back on its case.
  // Before the other windows of the Studio hear it (they take only an Échap nobody took).
  page?.addEventListener?.(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || page.querySelector?.('dialog[open]')) return;
      if (gesture) {
        event.preventDefault();
        return cancel();
      }
      if (!open && chosen < 0) return;
      event.preventDefault();
      close({ refocus: true });
    },
    true,
  );

  // ------------------------------------------------------------------ under the plateau
  /**
   * The line under the plateau (B25, B28): the boxes a model does not read and that will not go; the limit of twelve,
   * in amber. Null when there is nothing to say.
   */
  function note(model = workflow()) {
    if (!present()) return null;
    const count = list().length,
      full = reads(model) && !proposed() && count >= LAYOUT_LIMITS.boxes,
      text = !reads(model) ? layoutUnread(model?.name ?? 'Ce modèle', count) : full ? LAYOUT_SAYS.full : '';
    if (!text) return null;
    const line = node('p', 'studio-plateau-note' + (full ? ' is-alert' : ''));
    line.setAttribute('role', full ? 'status' : 'note');
    line.append(icon('info'), node('span', '', text));
    return line;
  }

  return {
    piece,
    note,
    choice,
    layer,
    blank,
    reason,
    grey,
    prompt,
    adopt,
    close,
    /** Whether one of its windows is open. */
    isOpen: () => open || chosen >= 0,
  };
}
