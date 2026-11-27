import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_BLANK,
  LAYOUT_HELP,
  LAYOUT_HINT,
  LAYOUT_PROPOSED,
  boxWindowPlace,
  setupLayoutEditor,
} from '../public/layout-editor.mjs';
import { LAYOUT_LIMITS, LAYOUT_SAYS, layoutBoxes, layoutPrompt, pixelBox } from '../public/layout-boxes.mjs';
import { eyeTip, placeChips, takeBoxes, takeEye } from '../public/take-eye.mjs';

// (0.6.477) The editor of the boxes of MOSS Image (public/layout-editor.mjs) and its eye (public/take-eye.mjs), in a
// small page of their own: the piece and its window, the gestures in the frame, the window of a box, what goes to the
// model. The Studio that calls them is tested in tests/studio.mjs; the real page, by scripts/check-ui.mjs.

/** An element as the editor uses it: classes, children, attributes, a parent; no layout (no size, no place). */
class Element {
  constructor(tag = 'div', className = '', textContent = '') {
    Object.assign(this, { tag, className: className ?? '', textContent: textContent ?? '', children: [] });
    Object.assign(this, { dataset: {}, attributes: {}, hidden: false, parent: null });
    this.style = { setProperty: (name, value) => (this.style[name] = value) };
    const names = () => this.className.split(' ').filter(Boolean);
    this.classList = {
      contains: name => names().includes(name),
      add: (...added) => (this.className = [...new Set([...names(), ...added])].join(' ')),
      remove: (...gone) => (this.className = names().filter(name => !gone.includes(name)).join(' ')),
      toggle: (name, on = !names().includes(name)) => (on ? this.classList.add(name) : this.classList.remove(name), on),
    };
  }
  append(...nodes) {
    for (const child of nodes) if (child instanceof Element) child.parent = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }
  /** The nearest element up from this one with one of the classes of `selector` (« .a, .b »). */
  closest(selector) {
    const wanted = selector.split(',').map(part => part.trim().replace(/^\./, ''));
    for (let at = this; at; at = at.parent) if (wanted.some(name => at.classList.contains(name))) return at;
    return null;
  }
  /** Every element under this one that has the class `name`. */
  find(name) {
    return this.children.flatMap(child =>
      child instanceof Element ? [...(child.classList.contains(name) ? [child] : []), ...child.find(name)] : [],
    );
  }
  /** Its words and those of everything under it. */
  text() {
    return [this.textContent, ...this.children.map(child => (child instanceof Element ? child.text() : ''))].join('');
  }
}

const MOSS = { id: 'm', name: 'MOSS Image', layout: true, size: { width: 1024, height: 1024 } },
  KREA = { id: 'k', name: 'Krea 2', layout: false, size: { width: 1024, height: 1024 } },
  SQUARE = { width: 1024, height: 1024 },
  // Where the picture is on the screen: 512 px for 1024 (B20 at 1280 × 720 has about that).
  RECT = { left: 100, top: 50, width: 512, height: 512, right: 612, bottom: 562 },
  // Three boxes on whole pixels of 1024 (B22): read back from their layout, they are the same to the last digit.
  POSTER = layoutBoxes([
    { x: 0.25, y: 0.0625, w: 0.5, h: 0.125, label: 'text', caption: 'A title.', text: 'EXPLORE' },
    { x: 0.3125, y: 0.3125, w: 0.375, h: 0.5, caption: 'A mountain.' },
    { x: 0.0625, y: 0.625, w: 0.125, h: 0.1875, label: 'character', caption: 'A hiker.' },
  ]);

/** A Studio reduced to what the editor asks of it: a draft, a model, drawing again, the page. */
function editorPage({ model = MOSS, prompt = '', boxes = [], layout = false } = {}) {
  const state = { draft: { prompt, boxes, layout, size: '1024x1024' }, model, busy: '', proposed: false };
  Object.assign(state, { renders: 0, notices: [], closed: 0, record: null });
  const listeners = { pointerdown: [], keydown: [] },
    page = { addEventListener: (type, listener) => listeners[type]?.push(listener), querySelector: () => null },
    shown = {};
  const editor = setupLayoutEditor({
    node: (tag, className, text) => new Element(tag, className, text),
    icon: name => new Element('svg', 'icon-' + name),
    notice: text => state.notices.push(text),
    draft: () => state.draft,
    workflow: () => state.model,
    render: () => {
      state.renders++;
      draw();
    },
    busy: () => state.busy,
    proposed: () => state.proposed,
    closeOthers: () => state.closed++,
    document: page,
    view: { innerWidth: 1280, innerHeight: 720 },
  });
  // As the Studio draws: the plateau (the piece, its line under it), then the frame and what is over it.
  function draw() {
    shown.piece = editor.piece(state.model);
    shown.note = editor.note(state.model);
    shown.blank = editor.blank(state.model);
    shown.over = new Element('div', 'studio-frame-over');
    editor.layer(shown.over, { blank: !state.record, record: state.record });
  }
  draw();
  /** The canvas of the boxes of the draft as it is on the screen now (drawn again at each change; not the eye's). */
  const canvas = () => {
    const [root] = shown.over.find('studio-layout').filter(layer => !layer.classList.contains('is-eye')),
      [found] = root?.find('studio-layout-canvas') ?? [];
    if (found) found.getBoundingClientRect = () => RECT;
    return found;
  };
  const beside = new Element('div', 'studio-frame');
  const event = (at, more = {}) => ({
    button: 0,
    pointerId: 1,
    clientX: at[0],
    clientY: at[1],
    target: beside,
    ...more,
  });
  /** A press, a move and a release in the frame, as a hand: what the readout said while the box was drawn. */
  function drag(from, to, { target = beside, between = null } = {}) {
    const frame = canvas(),
      prevented = [];
    frame.onpointerdown(event(from, { target, preventDefault: () => prevented.push(true) }));
    if (between) frame.onpointermove(event(between));
    frame.onpointermove(event(to));
    const readout = frame.find('studio-layout-readout')[0]?.textContent ?? null,
      small = frame.find('is-drawn')[0]?.classList.contains('is-small') ?? null;
    frame.onpointerup(event(to));
    return { readout, small, frame, prevented: prevented.length };
  }
  const key = (name, target, more = {}) => {
    let prevented = false;
    canvas().onkeydown({ key: name, target, preventDefault: () => (prevented = true), ...more });
    return prevented;
  };
  const boxesShown = () => canvas()?.find('studio-layout-box') ?? [];
  return { state, editor, shown, listeners, canvas, drag, key, boxesShown, draw, event };
}

test('the window of a box goes beside it, never on it nor on « Générer » when it has the room (B22, B23)', () => {
  const size = { width: 248, height: 264 },
    // Between the Entrée and the Réglages, from the top of the preview to the foot of the window (1280 × 720).
    bounds = { left: 340, top: 150, right: 984, bottom: 712 },
    go = { left: 523, top: 466, right: 790, bottom: 510 };
  // At the right of the box, risen above « Générer » rather than over it.
  assert.deepEqual(boxWindowPlace({ target: { left: 400, top: 300, right: 500, bottom: 380 }, size, bounds, go }), {
    left: 512,
    top: 194,
    covers: 0,
  });
  // No room at its right: at its left.
  assert.deepEqual(boxWindowPlace({ target: { left: 800, top: 300, right: 900, bottom: 380 }, size, bounds, go }), {
    left: 540,
    top: 194,
    covers: 0,
  });
  // B23: a title as wide as the poster has no free side; the right covers the least of it, 21 px of its end (N12).
  const title = { left: 556, top: 212, right: 757, bottom: 245 };
  assert.deepEqual(boxWindowPlace({ target: title, size, bounds, go }), { left: 736, top: 194, covers: 21 * 33 });
  // Without « Générer » to keep free: where it is beside the box, at the height of the box.
  assert.deepEqual(boxWindowPlace({ target: { left: 400, top: 300, right: 500, bottom: 380 }, size, bounds }), {
    left: 512,
    top: 294,
    covers: 0,
  });
  // B23 at 1168 × 788: no side has the room; under the title, risen above « Générer » (it covered 2 px of it).
  const narrow = { left: 327, top: 121, right: 872, bottom: 780 },
    below = { left: 435, top: 534, right: 765, bottom: 580 };
  assert.deepEqual(
    boxWindowPlace({ target: { left: 474, top: 219, right: 726, bottom: 260 }, size, bounds: narrow, go: below }),
    { left: 474, top: 262, covers: 0 },
  );
  // As the page measured it: 8 px kept above « Générer » would put it 0.7 px over the title; 2 px under the title.
  const page = {
    target: { left: 474, top: 218, right: 725.98, bottom: 260 },
    size: { width: 248, height: 264.16 },
    bounds: { left: 328, top: 120, right: 872, bottom: 780 },
    go: { left: 435.05, top: 533.5, right: 764.95, bottom: 579.5 },
  };
  assert.deepEqual(boxWindowPlace(page), { left: 474, top: 262, covers: 0 });
  // Too tall to go above « Générer » beside a box: risen as far as the top of the preview, it covers less of it.
  const tall = { width: 248, height: 330 };
  assert.deepEqual(
    boxWindowPlace({ target: { left: 400, top: 300, right: 500, bottom: 380 }, size: tall, bounds, go }),
    { left: 512, top: 150, covers: 0 },
  );
  // A tall box low in the frame: the window under it is held in its bounds, never put lower to be under the box.
  const deep = { left: 350, top: 160, right: 970, bottom: 600 },
    foot = { ...go, top: 690, bottom: 720 };
  assert.deepEqual(boxWindowPlace({ target: deep, size, bounds: { ...bounds, bottom: 700 }, go: foot }), {
    left: 350,
    top: 436,
    covers: 248 * 164,
  });
});

test('(B20) « Boîtes » put on the plateau from « Ajouter », its window open, the empty frame ready', () => {
  const { state, editor, shown, canvas } = editorPage();
  // Not there yet: no piece, nothing over the frame, its line in « Ajouter » puts it.
  assert.equal(shown.piece, null);
  assert.deepEqual(shown.over.children, []);
  const choice = editor.choice('Boîtes', 'déjà posées');
  assert.deepEqual(Object.keys(choice), ['name', 'run']);
  choice.run();
  assert.deepEqual([state.draft.layout, state.closed, state.renders], [true, 1, 1]);
  // The piece: its case and its count (0), its ×, its word; its window under it.
  const piece = shown.piece,
    [tile, word, pane] = piece.children,
    [pick, remove] = tile.children;
  assert.equal(piece.className, 'studio-piece studio-boxes is-open');
  assert.deepEqual(
    [tile.className, tile.dataset.slot, word.textContent],
    ['studio-slot is-filled', 'boxes-0', 'Boîtes'],
  );
  assert.deepEqual([pick.children[0].className, pick.find('studio-boxes-count')[0].textContent], ['icon-boxes', '0']);
  assert.deepEqual(
    [pick.title, pick.attributes['aria-label'], pick.attributes['aria-haspopup'], pick.attributes['aria-expanded']],
    ['Boîtes · 0', 'Boîtes · 0', 'dialog', 'true'],
  );
  assert.deepEqual([remove.attributes['aria-label'], remove.title], ['Retirer les boîtes', 'Retirer']);
  assert.equal(pane.className, 'glass-menu studio-piece-window studio-boxes-window');
  assert.deepEqual([pane.attributes.role, pane.attributes['aria-label']], ['dialog', 'Boîtes']);
  const [head, hint, foot] = pane.children;
  assert.deepEqual(head.children.map(part => part.textContent), ['Boîtes', '0 / 12', 'Expérimental', '?']);
  assert.equal(head.children[3].dataset.help, LAYOUT_HELP);
  assert.match(LAYOUT_HELP, /un objet demandé sur quatre/);
  assert.equal(hint.textContent, LAYOUT_HINT);
  assert.deepEqual(foot.children.map(part => [part.text(), part.title]), [['Retirer', 'Retirer la pièce']]);
  // The empty frame says how to draw, and can be drawn in.
  assert.deepEqual(shown.blank.map(line => line.textContent), [LAYOUT_BLANK.title, LAYOUT_BLANK.text]);
  assert.deepEqual(shown.blank.map(line => line.className), ['studio-blank-title', 'studio-blank-text']);
  const [root] = shown.over.children;
  assert.equal(root.className, 'studio-layout is-drawing is-blank');
  assert.equal(root.style['--layout-ratio'], '1.0000');
  assert.equal(typeof canvas().onpointerdown, 'function');
  // Once there: « déjà posées », greyed with why.
  assert.deepEqual(editor.choice('Boîtes', 'déjà posées'), {
    name: 'Boîtes',
    note: 'déjà posées',
    off: 'Les boîtes sont déjà posées : cliquez sur leur case pour les changer.',
  });
});

test('a box is drawn by a press, a slide and a release; too small or a thirteenth, nothing, said at the hand', () => {
  const page = editorPage({ layout: true });
  const { state, drag } = page;
  // 8 × 6 px on the screen (B30): no box, said in amber where the hand is; the readout was in amber too.
  const tiny = drag([150, 100], [158, 106], { between: [154, 103] });
  assert.equal(tiny.small, true);
  assert.equal(tiny.prevented, 1, 'a press in the frame selects nothing of the page');
  assert.deepEqual(state.draft.boxes, []);
  const [said] = tiny.frame.find('studio-layout-said');
  assert.deepEqual([said.textContent, said.attributes.role], [LAYOUT_SAYS.small, 'status']);
  assert.deepEqual([said.style.left, said.style.top], ['calc(11.328125% - 12px)', 'calc(10.9375% + 16px)']);
  // 40 × 30 px on the screen: a box, its size in pixels of the picture said while it was drawn (B21).
  const made = drag([164, 114], [204, 144]);
  assert.equal(made.readout, '80 × 60');
  assert.equal(made.small, false);
  assert.equal(state.draft.boxes.length, 1);
  const [box] = state.draft.boxes;
  assert.deepEqual(box, {
    x: 0.125,
    y: 0.125,
    w: 40 / 512,
    h: 30 / 512,
    label: 'object',
    caption: '',
    text: '',
    palette: [],
  });
  assert.deepEqual(pixelBox(box, SQUARE), [-384, -384, -324, -304]);
  // Its window opens beside it, on its description; the window of the piece closed for it.
  assert.equal(page.shown.piece.find('studio-boxes-window').length, 0);
  const [win] = page.shown.over.find('studio-box-window');
  assert.deepEqual([win.attributes.role, win.attributes['aria-label']], ['dialog', 'Boîte 1']);
  assert.equal(page.boxesShown()[0].className, 'studio-layout-box is-chosen');
  // Twelve at most: a thirteenth is refused at the hand, nothing is drawn.
  state.draft.boxes = layoutBoxes(
    Array.from({ length: 12 }, (_, at) => ({ x: (at % 4) / 4, y: Math.floor(at / 4) / 4, w: 0.2, h: 0.2 })),
  );
  page.draw();
  const full = drag([110, 540], [160, 560]);
  assert.equal(state.draft.boxes.length, 12);
  assert.deepEqual(full.frame.find('studio-layout-said').map(line => line.textContent), [LAYOUT_SAYS.refused]);
  // Its line under the plateau says it in amber, and the window of the piece at its head.
  assert.deepEqual(
    [page.shown.note.className, page.shown.note.attributes.role, page.shown.note.text()],
    ['studio-plateau-note is-alert', 'status', LAYOUT_SAYS.full],
  );
  assert.equal(page.shown.piece.find('studio-boxes-count')[0].className, 'studio-boxes-count is-full');
});

test('a box is moved, made larger or smaller by a corner (12 px at least), moved by the keys, taken away', () => {
  const page = editorPage({ layout: true });
  const { state, drag, key } = page;
  drag([164, 114], [264, 214]); // 100 × 100 px: x 0.125, y 0.125, w and h 100/512
  // Moved: pressed on it and slid 64 px to the right, 32 down.
  drag([200, 150], [264, 182], { target: page.boxesShown()[0] });
  assert.deepEqual([state.draft.boxes[0].x, state.draft.boxes[0].y], [0.25, 0.1875]);
  // A click on it without moving chooses it (its window opens on its description).
  drag([200, 150], [201, 150], { target: page.boxesShown()[0] });
  const handles = page.boxesShown()[0].find('studio-layout-handle').map(handle => handle.dataset.corner);
  assert.deepEqual(handles, ['tl', 'tr', 'bl', 'br']);
  // Its corner at the bottom right pulled past the top left: its sides stay 12 px on the screen.
  const corner = page.boxesShown()[0].find('studio-layout-handle').find(handle => handle.dataset.corner === 'br');
  drag([328, 246], [120, 60], { target: corner });
  assert.deepEqual([state.draft.boxes[0].w, state.draft.boxes[0].h], [12 / 512, 12 / 512]);
  assert.deepEqual([state.draft.boxes[0].x, state.draft.boxes[0].y], [0.25, 0.1875], 'the corner across stayed');
  // The keys: an arrow moves it by 1 %, with Maj by 5 %, held in the picture.
  const at = () => [state.draft.boxes[0].x, state.draft.boxes[0].y];
  assert.equal(key('ArrowRight', page.boxesShown()[0]), true);
  assert.deepEqual(at(), [0.26, 0.1875]);
  key('ArrowDown', page.boxesShown()[0], { shiftKey: true });
  assert.deepEqual(at(), [0.26, 0.2375]);
  for (let step = 0; step < 30; step++) key('ArrowLeft', page.boxesShown()[0], { shiftKey: true });
  assert.equal(state.draft.boxes[0].x, 0);
  // Entrée opens it; Suppr takes it away, the others keep their order.
  drag([400, 400], [460, 460]);
  assert.equal(state.draft.boxes.length, 2);
  assert.equal(key('Delete', page.boxesShown()[0]), true);
  assert.equal(state.draft.boxes.length, 1);
  assert.equal(state.draft.boxes[0].x, 300 / 512);
  // A key on nothing that is a box does nothing.
  assert.equal(key('Delete', new Element('div', 'studio-layout-canvas')), false);
  assert.equal(state.draft.boxes.length, 1);
});

test('the window of a box: its type, the words of a text before its description, their limits; Générer follows', () => {
  const page = editorPage({ layout: true, prompt: 'A minimalist travel poster.' });
  const { state, editor, drag } = page;
  drag([164, 114], [404, 174]);
  const win = () => page.shown.over.find('studio-box-window')[0],
    fields = () => win().find('studio-box-field').map(field => [field.children[0].textContent, field.children[1]]);
  // An object: its description alone, two lines, 800 characters; its hint in French.
  assert.deepEqual(
    fields().map(([name, area]) => [name, area.rows, area.maxLength, area.placeholder, area.dataset.field]),
    [
      [
        'Description',
        2,
        LAYOUT_LIMITS.caption,
        'Ce qu’on voit dans cette boîte : la chose, sa matière, ses couleurs',
        'caption',
      ],
    ],
  );
  const kinds = win().find('studio-box-kind');
  assert.deepEqual(
    kinds.map(kind => [kind.text(), kind.attributes.role, kind.attributes['aria-checked'], kind.tabIndex]),
    [
      ['Objet', 'radio', 'true', 0],
      ['Personnage', 'radio', 'false', -1],
      ['Texte', 'radio', 'false', -1],
    ],
  );
  assert.equal(editor.reason(), 'Décrivez la boîte 1 pour générer');
  // A text: « Texte à écrire » first, on one line, 500 characters; then its description, of its look.
  kinds[2].onclick();
  assert.equal(state.draft.boxes[0].label, 'text');
  assert.deepEqual(
    fields().map(([name, area]) => [name, area.rows, area.maxLength, area.placeholder]),
    [
      ['Texte à écrire', 1, LAYOUT_LIMITS.text, 'Les mots exacts'],
      ['Description', 2, LAYOUT_LIMITS.caption, 'Leur allure : la police, la taille, la couleur'],
    ],
  );
  assert.equal(win().find('studio-box-field')[0].className, 'studio-box-field is-inline is-missing');
  assert.equal(editor.reason(), 'Écrivez le texte de la boîte 1 pour générer');
  // The arrows go from one type to the next.
  let prevented = false;
  win().find('studio-box-kinds')[0].onkeydown({ key: 'ArrowRight', preventDefault: () => (prevented = true) });
  assert.deepEqual([state.draft.boxes[0].label, prevented], ['object', true]);
  win().find('studio-box-kinds')[0].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(state.draft.boxes[0].label, 'text');
  // Written as it is typed; the box in the frame shows it, « Générer » follows.
  const type = (index, value) => {
    const [, area] = fields()[index];
    area.value = value;
    area.oninput();
  };
  type(0, 'EXPLORE');
  assert.equal(editor.reason(), 'Décrivez la boîte 1 pour générer');
  type(1, 'Large dark-blue uppercase title centered at the top.');
  assert.equal(editor.reason(), '');
  assert.deepEqual(page.boxesShown()[0].find('studio-layout-words').map(words => words.text()), ['EXPLORE']);
  // « Générer » greyed in place by what a box lacks, as the form greys it.
  const go = { disabled: false, title: 'Générer' };
  editor.grey(go);
  assert.deepEqual(go, { disabled: false, title: 'Générer' });
  type(1, '');
  editor.grey(go);
  assert.deepEqual(go, { disabled: true, title: 'Décrivez la boîte 1 pour générer' });
  // Its « Retirer », and its foot: « Expérimental » and its « ? ».
  const foot = win().find('studio-box-foot')[0];
  assert.deepEqual(foot.children.map(part => part.text()), ['Expérimental', '?', 'Retirer']);
  assert.equal(foot.children[2].title, 'Retirer la boîte 1');
  foot.children[2].onclick();
  assert.deepEqual(state.draft.boxes, []);
});

test('what goes to the model: the layout at the size made, never what the server refuses', () => {
  const boxes = layoutBoxes([
    { x: 0.25, y: 0.06, w: 0.5, h: 0.12, label: 'text', caption: 'A title.', text: 'EXPLORE' },
    { x: 0.3, y: 0.3, w: 0.4, h: 0.5, label: 'object', caption: 'A mountain.' },
  ]);
  const page = editorPage({ layout: true, prompt: '  A poster  ', boxes });
  const { state, editor } = page;
  assert.equal(editor.prompt(MOSS), layoutPrompt('A poster', boxes, SQUARE));
  // At the size of the picture made (another one chosen in Réglages, a proposal resized).
  state.draft.size = '1344x768';
  assert.equal(editor.prompt(MOSS), layoutPrompt('A poster', boxes, { width: 1344, height: 768 }));
  assert.equal(editor.prompt(MOSS, state.draft, 'Another', SQUARE), layoutPrompt('Another', boxes, SQUARE));
  // A model that does not read them, the piece taken back, no box: the prompt goes as it is written.
  assert.equal(editor.prompt(KREA), null);
  state.draft.layout = false;
  assert.equal(editor.prompt(MOSS), null);
  state.draft.layout = true;
  assert.equal(editor.prompt(MOSS, { ...state.draft, boxes: [] }), null);
  // A box unfinished, a layout over 8 000 characters: refused, with the reason « Générer » says.
  state.draft.boxes[1].caption = '';
  assert.throws(() => editor.prompt(MOSS), { message: 'Décrivez la boîte 2 pour générer' });
  state.draft.boxes[1].caption = 'd'.repeat(800);
  // (Eleven boxes: twelve would be said at the head of the window too.)
  const nine = Array.from({ length: 9 }, (_, at) => ({ x: at / 10, y: 0.9, w: 0.1, h: 0.1, caption: 'e'.repeat(800) }));
  state.draft.boxes.push(...layoutBoxes(nine));
  assert.equal(editor.reason(MOSS), LAYOUT_SAYS.long);
  assert.throws(() => editor.prompt(MOSS), { message: LAYOUT_SAYS.long });
  // Said in amber at the head of its window, with the length.
  page.draw();
  editor.choice('Boîtes', 'déjà posées');
  page.shown.piece.find('studio-slot-pick')[0].onclick();
  const said = page.shown.piece.find('studio-boxes-said').map(line => [line.attributes.role, line.textContent]);
  assert.equal(said.length, 1);
  assert.match(said[0][1], /^Avec le prompt, les boîtes font 8.\d{3} caractères : MOSS Image en lit 8.000 au plus\./);
  // Under a proposal of Moodix AI, its boxes are its own: they grey nothing, they cannot be changed here.
  state.proposed = true;
  assert.equal(editor.reason(MOSS), '');
  page.draw();
  const pick = page.shown.piece.find('studio-slot-pick')[0];
  assert.deepEqual([pick.disabled, pick.title], [true, LAYOUT_PROPOSED]);
});

test('under a model that does not read them, the boxes are kept, greyed, and said not to go (B28)', () => {
  const boxes = layoutBoxes([
    { x: 0.1, y: 0.1, w: 0.3, h: 0.3, caption: 'A thing.' },
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  ]);
  const page = editorPage({ layout: true, boxes, model: KREA });
  const { shown } = page;
  assert.equal(shown.piece.className, 'studio-piece studio-boxes is-off');
  const pick = shown.piece.find('studio-slot-pick')[0];
  assert.equal(pick.title, 'Boîtes gardées : Krea 2 ne les lit pas.');
  assert.equal(
    shown.note.text(),
    'Krea 2 ne lit pas les boîtes : les 2 boîtes ne partiront pas. Elles restent prêtes pour MOSS Image.',
  );
  assert.deepEqual([shown.note.className, shown.note.attributes.role], ['studio-plateau-note', 'note']);
  // Its window folded on why; the frame shows them greyed, not to be drawn in.
  pick.onclick();
  const pane = page.shown.piece.find('studio-boxes-window')[0];
  assert.equal(pane.className, 'glass-menu studio-piece-window studio-boxes-window is-greyed');
  assert.deepEqual(pane.find('studio-boxes-said').map(line => line.textContent), [
    'Krea 2 ne lit pas les boîtes : ces 2 boîtes ne partiront pas. Elles restent prêtes pour MOSS Image : ' +
      'choisissez-le dans Modèle pour les envoyer.',
  ]);
  const [root] = page.shown.over.children;
  assert.equal(root.className, 'studio-layout is-greyed is-blank');
  assert.equal(page.canvas().onpointerdown, undefined);
  assert.deepEqual(
    page.boxesShown().map(box => box.className),
    ['studio-layout-box is-greyed', 'studio-layout-box is-greyed'],
  );
  assert.equal(page.editor.reason(), '');
  assert.equal(page.editor.prompt(KREA), null);
});

test('what was said at the hand goes once the frame is not drawn in: never over the boxes greyed (B28)', () => {
  const page = editorPage({ layout: true, boxes: layoutBoxes([{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, caption: 'A.' }]) });
  const tiny = page.drag([500, 400], [508, 406]);
  assert.deepEqual(tiny.frame.find('studio-layout-said').map(line => line.textContent), [LAYOUT_SAYS.small]);
  // Krea 2 chosen in Modèle: the boxes greyed, nothing said over them; MOSS Image again, nothing either.
  page.state.model = KREA;
  page.draw();
  assert.equal(page.canvas().parent.className, 'studio-layout is-greyed is-blank');
  assert.deepEqual(page.canvas().find('studio-layout-said'), []);
  page.state.model = MOSS;
  page.draw();
  assert.deepEqual(page.canvas().find('studio-layout-said'), []);
});

test('« Retirer » takes the piece back and keeps its boxes in the draft; « Ajouter » puts them back (N8)', () => {
  const boxes = layoutBoxes([
    { x: 0.1, y: 0.1, w: 0.3, h: 0.3, caption: 'A thing.' },
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  ]);
  const page = editorPage({ layout: true, boxes });
  const { state, editor } = page;
  page.shown.piece.find('studio-slot-pick')[0].onclick();
  const foot = page.shown.piece.find('studio-window-foot')[0];
  assert.deepEqual(foot.children.map(part => part.text()), ['Une ligne ouvre sa boîte.', 'Retirer']);
  assert.equal(foot.children[1].title, 'Retirer la pièce : ses 2 boîtes restent gardées, « Ajouter » les remet.');
  foot.children[1].onclick();
  assert.deepEqual([state.draft.layout, state.draft.boxes.length, page.shown.piece], [false, 2, null]);
  assert.deepEqual(page.shown.over.children, []);
  assert.equal(editor.prompt(MOSS), null, 'taken back, they do not go');
  const choice = editor.choice('Boîtes', 'déjà posées');
  assert.equal(choice.note, '2 boîtes gardées');
  choice.run();
  assert.deepEqual([state.draft.layout, state.draft.boxes.length], [true, 2]);
  // The × of its case does the same.
  page.shown.piece.find('studio-slot-remove')[0].onclick();
  assert.deepEqual([state.draft.layout, state.draft.boxes.length], [false, 2]);
});

test('the list of the window: a line a box, the words of a text first, what it lacks in amber; a line opens it', () => {
  const boxes = layoutBoxes([
    { x: 0.1, y: 0.1, w: 0.3, h: 0.1, label: 'text', caption: 'Bold.', text: 'EXPLORE' },
    { x: 0.5, y: 0.5, w: 0.2, h: 0.2, caption: 'A   blue\nmountain.' },
    { x: 0.1, y: 0.6, w: 0.1, h: 0.2, label: 'character' },
    { x: 0.7, y: 0.1, w: 0.2, h: 0.1, label: 'text', caption: 'Small.' },
  ]);
  const page = editorPage({ layout: true, boxes });
  page.shown.piece.find('studio-slot-pick')[0].onclick();
  const nbsp = String.fromCharCode(0xa0);
  const lines = () => page.shown.piece.find('studio-boxes-line');
  assert.deepEqual(
    lines().map(line => [line.className, line.children[0].attributes['aria-label']]),
    [
      ['studio-boxes-line', `Boîte 1 · Texte · «${nbsp}EXPLORE${nbsp}»`],
      ['studio-boxes-line', 'Boîte 2 · Objet · A blue mountain.'],
      ['studio-boxes-line is-missing', 'Boîte 3 · Personnage · À décrire'],
      ['studio-boxes-line is-missing', 'Boîte 4 · Texte · Texte à écrire'],
    ],
  );
  assert.deepEqual(page.shown.piece.find('studio-boxes-of')[0].textContent, '4 / 12');
  // A line opens its box (the list closes for it); its × takes it away.
  lines()[1].children[0].onclick();
  assert.equal(page.shown.piece.find('studio-boxes-window').length, 0);
  assert.equal(page.shown.over.find('studio-box-window')[0].attributes['aria-label'], 'Boîte 2');
  page.shown.piece.find('studio-slot-pick')[0].onclick();
  lines()[0].children[1].onclick();
  assert.deepEqual(page.state.draft.boxes.map(box => box.label), ['object', 'character', 'text']);
});

test('a press beside the windows closes them in place, Échap too; the frame over a take is its own again (N9)', () => {
  const boxes = layoutBoxes([{ x: 0.1, y: 0.1, w: 0.3, h: 0.3, caption: 'A thing.' }]);
  const page = editorPage({ layout: true, boxes });
  const { state, listeners, editor } = page;
  // A take on the screen, made with boxes: its eye; the frame is the take's while no window is open.
  state.record = {
    prompt: layoutPrompt('A poster', boxes, SQUARE),
    parameters: { width: 1024, height: 1024 },
    outputs: [{ take: 6 }],
  };
  page.draw();
  const eyes = () => page.shown.over.find('is-eye');
  assert.deepEqual([eyes().length, eyes()[0].hidden, page.shown.over.find('is-drawing').length], [1, false, 0]);
  // The window of the piece open: the boxes of the draft are drawn over the take, its eye hidden meanwhile.
  page.shown.piece.find('studio-slot-pick')[0].onclick();
  assert.equal(editor.isOpen(), true);
  assert.deepEqual([eyes()[0].hidden, page.shown.over.find('is-drawing').length], [true, 1]);
  // A press on the window or in the frame leaves it open; beside them, it closes, without drawing the Studio again.
  const renders = state.renders;
  listeners.pointerdown.forEach(listener => listener({ target: page.shown.piece.find('studio-boxes-window')[0] }));
  listeners.pointerdown.forEach(listener => listener({ target: page.canvas() }));
  assert.equal(editor.isOpen(), true);
  listeners.pointerdown.forEach(listener => listener({ target: new Element('button', 'studio-go') }));
  assert.deepEqual([editor.isOpen(), state.renders], [false, renders]);
  assert.deepEqual(
    [page.shown.piece.className, page.shown.piece.find('studio-slot-pick')[0].attributes['aria-expanded']],
    ['studio-piece studio-boxes', 'false'],
  );
  assert.deepEqual([page.shown.over.find('is-drawing')[0].hidden, eyes()[0].hidden], [true, false]);
  // Échap closes the window of a box, then nothing more is taken.
  page.drag([400, 400], [460, 460]);
  assert.equal(editor.isOpen(), true);
  let taken = 0;
  const escape = () =>
    listeners.keydown.forEach(listener => listener({ key: 'Escape', preventDefault: () => taken++ }));
  escape();
  assert.deepEqual([editor.isOpen(), taken], [false, 1]);
  escape();
  assert.equal(taken, 1, 'an Échap nobody needs is left to the others');
});

test('a take opened again gives its caption to the prompt, its boxes to the piece; another, the piece goes', () => {
  const three = POSTER;
  const page = editorPage({ layout: true, boxes: [three[0]] });
  const { state, editor } = page;
  const made = (prompt, parameters = { width: 1024, height: 1024 }) => ({ prompt, parameters, outputs: [{}] });
  const own = state.draft;
  own.prompt = layoutPrompt('A poster', three, SQUARE);
  editor.adopt(own, made(own.prompt));
  assert.deepEqual([own.prompt, own.layout, own.boxes], ['A poster', true, three]);
  assert.deepEqual(state.notices, []);
  // A take without boxes: the piece goes, the boxes stay in the draft (N8).
  own.prompt = 'a cat';
  editor.adopt(own, made('a cat'));
  assert.deepEqual([own.prompt, own.layout, own.boxes.length], ['a cat', false, 3]);
  // Its size not known: its caption all the same, never the JSON, and why its boxes are not back.
  own.prompt = layoutPrompt('A poster', three, SQUARE);
  editor.adopt(own, made(own.prompt, {}));
  assert.deepEqual([own.prompt, own.layout], ['A poster', false]);
  assert.deepEqual(state.notices, [
    'Les boîtes de cette prise n’ont pas pu être reprises : sa taille n’est pas connue.',
  ]);
  // Something of it the Studio does not hold (a tag, a meta): said once.
  const tagged = JSON.parse(layoutPrompt('A poster', three, SQUARE));
  tagged.summary.meta = ['poster'];
  own.prompt = JSON.stringify(tagged);
  editor.adopt(own, made(own.prompt));
  assert.deepEqual([own.prompt, own.layout, own.boxes.length], ['A poster', true, 3]);
  assert.equal(state.notices.at(-1), 'Les boîtes de cette prise ne sont pas toutes reprises telles qu’elles étaient.');
});

test('the eye shows the boxes the model received in thin lines, their numbers outside; clicked, the picture', () => {
  const boxes = POSTER;
  const record = {
    prompt: layoutPrompt('A poster', boxes, SQUARE),
    parameters: { width: 1024, height: 1024 },
    outputs: [{}],
  };
  assert.deepEqual(takeBoxes(record), { boxes, size: SQUARE });
  // Made without boxes, of a size not known, or that throws when it is read: no eye.
  assert.equal(takeBoxes({ prompt: 'a cat', parameters: SQUARE }), null);
  assert.equal(takeBoxes({ prompt: record.prompt, parameters: {}, outputs: [{}] }), null);
  assert.equal(takeBoxes({ get prompt() { throw Error('no'); } }), null);
  // Its size from its file when its settings have none.
  assert.deepEqual(takeBoxes({ prompt: record.prompt, outputs: [SQUARE] }).size, SQUARE);
  const eye = takeEye({ node: (tag, className, text) => new Element(tag, className, text), boxes });
  const lines = eye.element.find('take-eye-box');
  assert.deepEqual(
    lines.map(line => [line.style.left, line.style.top, line.style.width, line.style.height, line.text()]),
    [
      ['25%', '6.25%', '50%', '12.5%', '1Texte'],
      ['31.25%', '31.25%', '37.5%', '50%', '2Objet'],
      ['6.25%', '62.5%', '12.5%', '18.75%', '3Personnage'],
    ],
  );
  // Without the icons of the Studio, those of the page (a plain mark in a page without SVG).
  assert.equal(eye.eye.children[0].className, 'icon-eye');
  const state = () => [eye.eye.attributes['aria-pressed'], eye.eye.title, lines.map(line => line.hidden)];
  assert.deepEqual(state(), ['true', eyeTip(3, true), [false, false, false]]);
  assert.equal(eyeTip(3, true), 'Ce que le modèle a reçu : les 3 boîtes. Cliquez pour voir l’image seule.');
  assert.equal(eyeTip(1, false), 'Voir ce que le modèle a reçu : la boîte.');
  // A click on it is never one on the picture under it.
  const stopped = [];
  eye.eye.onclick({ preventDefault: () => stopped.push('default'), stopPropagation: () => stopped.push('up') });
  assert.deepEqual(stopped, ['default', 'up']);
  assert.deepEqual(state(), ['false', eyeTip(3, false), [true, true, true]]);
  // The same for the next take, in the Studio or on its page: pressed again here.
  eye.eye.onclick({ preventDefault() {}, stopPropagation() {} });
  assert.equal(eye.eye.attributes['aria-pressed'], 'true');
});

test('the numbers of the boxes go where they are read: never on « PRISE n » nor on another number', () => {
  const chip = (place = '') => {
    const element = new Element('span', 'take-eye-chip ' + place);
    // Its place on the screen by its class: in its corner, above its box, under it (a box at 100, 100).
    element.getClientRects = () => [1];
    element.getBoundingClientRect = () =>
      element.classList.contains('is-outside')
        ? { left: 100, top: 80, right: 150, bottom: 98 }
        : element.classList.contains('is-below')
          ? { left: 100, top: 202, right: 150, bottom: 220 }
          : { left: 103, top: 103, right: 153, bottom: 121 };
    return element;
  };
  const picture = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 };
  // Above its box when it is free there.
  const free = chip();
  placeChips([free], { picture });
  assert.equal(free.className, 'take-eye-chip is-outside');
  // « PRISE n » above it: under its box.
  const taken = chip();
  placeChips([taken], { picture, marks: [{ left: 90, top: 70, right: 160, bottom: 96 }] });
  assert.equal(taken.className, 'take-eye-chip is-below');
  // Above and under taken, or out of the picture: in its corner.
  const cornered = chip();
  placeChips([cornered], { picture: { ...picture, top: 90, bottom: 210 } });
  assert.equal(cornered.className, 'take-eye-chip');
  // A second number at the same place goes where the first is not.
  const [one, two] = [chip(), chip()];
  placeChips([one, two], { picture });
  assert.deepEqual([one.className, two.className], ['take-eye-chip is-outside', 'take-eye-chip is-below']);
  // Not on the page (no size): nothing is moved.
  const unseen = chip('is-below');
  placeChips([unseen], { picture: { width: 0 } });
  assert.equal(unseen.className, 'take-eye-chip is-below');
});
