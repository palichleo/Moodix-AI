import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalCard } from '../public/proposal-card.mjs';

// The proposal of Moodix in its message (direction-artistique.md, « La proposition vidéo »).
class Element {
  constructor(tag = '', className = '', text = '') {
    const classes = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, className, textContent: text, children: [], parent: null, dataset: {}, attributes: {}, listeners: {} });
    this.classList = {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    };
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    };
  }
  // (0.6.476) Its words replace what it held, as in the page: a title drawn again holds its new model alone.
  get textContent() {
    return this.text;
  }
  set textContent(value) {
    this.text = value;
    this.children = [];
  }
  append(...items) {
    for (const item of items) {
      if (typeof item !== 'object') continue;
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, listener) {
    (this.listeners[type] ??= new Set()).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners[type]?.delete(listener);
  }
  fire(type, event = {}) {
    for (const listener of [...(this.listeners[type] ?? [])]) listener({ target: this, ...event });
  }
  contains(other) {
    return other === this || this.children.some(child => child.contains?.(other));
  }
}
const node = (...args) => new Element(...args);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const video = () => ({ mediaType: 'video', workflowName: 'LTX 2.5', requestId: 'r', approvalToken: 't', plan: { intention: 'Un plan fixe.' } });
function setup(
  request = video(),
  { delay = 60, takes = null, importImage = null, answer = () => ({}), onFetched } = {},
) {
  const host = new Element('div', 'generation-grid'),
    composer = new Element('textarea'),
    controller = new AbortController(),
    revised = [];
  composer.value = '';
  const api = async (route, body) => {
    revised.push([route, body]);
    return Response.json(answer(route, body));
  };
  const pending = proposalCard({
    host,
    request,
    signal: controller.signal,
    node,
    api,
    delay,
    composer,
    takes,
    importImage,
    ...(onFetched ? { onFetched } : {}),
  });
  const [head] = pending.card.children,
    [title, status] = head.children,
    foot = pending.card.children[2],
    [, cancel, go] = foot.children;
  return { ...pending, host, composer, controller, title, status, cancel, go, revised };
}

test('a video proposal starts by itself after its count: « Départ dans … s », the glass of Générer filling', async () => {
  const card = setup();
  assert.equal(card.title.textContent, 'Proposition · Vidéo · LTX 2.5');
  assert.equal(card.status.textContent, 'Départ dans 1 s');
  assert.equal(card.go.classList.contains('is-counting'), true);
  assert.equal(card.go.style.values['--left'], '60ms');
  assert.equal(card.host.children.includes(card.card), true);
  assert.equal(await card.answer, 'once');
  assert.equal(card.host.children.includes(card.card), false, 'the card becomes the take: it goes');
});

test('the count pauses under the pointer and while something is written, then goes on', async () => {
  const card = setup(video(), { delay: 80 });
  card.card.fire('pointerenter');
  assert.equal(card.status.textContent, 'En pause');
  assert.equal(card.go.classList.contains('is-held'), true);
  await wait(120);
  assert.equal(card.card.parent, card.host, 'held: nothing starts');
  card.card.fire('pointerleave');
  assert.match(card.status.textContent, /^Départ dans \d s$/);
  // Something written in the message box holds it too, until the box is empty again.
  card.composer.value = 'Ciel gris';
  card.composer.fire('input');
  assert.equal(card.status.textContent, 'En pause');
  card.composer.value = '';
  card.composer.fire('input');
  assert.equal(await card.answer, 'once');
});

test('a click in the card stops the count for good: only Générer starts it', async () => {
  const card = setup(video(), { delay: 50 });
  card.card.fire('pointerdown', { target: card.title });
  assert.equal(card.status.textContent, 'En attente de votre accord');
  assert.equal(card.go.classList.contains('is-counting'), false);
  await wait(90);
  assert.equal(card.card.parent, card.host, 'nothing started by itself');
  card.go.onclick();
  assert.equal(await card.answer, 'once');
});

test('Annuler leaves « Proposition annulée. »; a new message declines it and the card goes', async () => {
  const cancelled = setup();
  cancelled.cancel.onclick();
  assert.equal(await cancelled.answer, 'cancel', 'the line stays: the conversation knows it, opened again');
  assert.deepEqual(
    cancelled.host.children.map(child => [child.className, child.textContent]),
    [['proposal-cancelled', 'Proposition annulée.']],
  );
  const declined = setup();
  declined.decline();
  assert.equal(await declined.answer, 'deny');
  assert.deepEqual(declined.host.children, [], 'Moodix answers with another card');
});

test('a sound waits for Générer, without a count; stopped, the proposal is abandoned', async () => {
  const sound = setup({ mediaType: 'audio', workflowName: 'MOSS-SFX', plan: { intention: 'Un orage.' } });
  assert.equal(sound.title.textContent, 'Proposition · Son · MOSS-SFX');
  assert.equal(sound.status.textContent, '');
  assert.equal(sound.go.classList.contains('is-counting'), false);
  sound.controller.abort(new DOMException('Arrêté', 'AbortError'));
  await assert.rejects(sound.answer, { name: 'AbortError' });
  assert.deepEqual(sound.host.children, []);
});

/** Every element under `root` (the fake document has no querySelector). */
const under = root => [root, ...root.children.flatMap(child => under(child))];
const withInputs = () => ({
  ...video(),
  inputRoles: ['start_image', 'end_image', 'reference', 'reference'],
  plan: {
    intention: 'Un plan fixe.',
    prompt: 'Un phare sous la pluie.',
    references: [{ role: 'start_image', preview: '/d.png', label: 'Prise 3' }],
    editable: { prompt: true },
  },
});

test('« + » opens « Créations du projet » in the card; the image taken goes in its case, no message', async () => {
  const takes = async () => [
    { id: 'run-image', conversationId: 'other', prompt: 'Une falaise', outputs: [{ take: 7, thumbUrl: '/t7.webp' }] },
    { id: 'run-video', mediaType: 'video', outputs: [{ take: 8 }] },
  ];
  const card = setup(withInputs(), {
    delay: 5000,
    takes,
    answer: route => (route === 'tools/revise' ? { approvalToken: 't2' } : {}),
  });
  const [, body] = card.card.children,
    media = body.children.find(child => child.className === 'proposal-media'),
    shelf = body.children.find(child => child.className === 'proposal-shelf');
  assert.equal(shelf.hidden, true, 'closed until a « + » is clicked');
  const empty = under(media).filter(item => item.className.startsWith('proposal-input is-empty'));
  assert.deepEqual(empty.map(item => item.attributes['data-role']), ['end_image', 'reference']);
  const [plusEnd] = empty[0].children;
  assert.equal(plusEnd.disabled, false);
  assert.equal(plusEnd.attributes['aria-label'], 'Ajouter une image de fin');
  plusEnd.onclick();
  await wait(0);
  assert.equal(shelf.hidden, false);
  assert.match(card.status.textContent, /^Départ dans 5/, 'opening it is not an answer');
  const [head, row] = shelf.children;
  assert.equal(head.textContent, 'Créations du projet');
  const picks = row.children.filter(item => item.className === 'proposal-shelf-pick');
  assert.equal(picks.length, 1, 'the images only');
  assert.equal(picks[0].title, 'Prise 7');
  assert.equal(picks[0].children[0].src, '/t7.webp');
  // The prompt changed in the card goes with the image: the card is drawn again from the answer.
  const prompt = under(card.card).find(item => item.className === 'proposal-prompt');
  prompt.value = 'Un phare sous la neige.';
  picks[0].onclick();
  await wait(0);
  const [route, sent] = card.revised.at(-1);
  assert.equal(route, 'tools/revise');
  assert.deepEqual(sent.edits.add, { role: 'end_image', source: { output: 'run-image', conversation: 'other' } });
  assert.equal(sent.edits.prompt, 'Un phare sous la neige.');
  assert.equal(card.status.textContent, 'En attente de votre accord', 'an image put in a case stops the count');
  assert.equal(card.card.parent, card.host, 'no message: the card stays');
  card.cancel.onclick();
  assert.equal(await card.answer, 'cancel');
});

test('« Créations du projet » of the card has no ×: Échap or a click beside it closes it', async () => {
  const page = new Element('document');
  globalThis.document = page;
  try {
    const card = setup(withInputs(), { delay: 5000, takes: async () => [] });
    const [, body] = card.card.children,
      media = body.children.find(child => child.className === 'proposal-media'),
      shelf = body.children.find(child => child.className === 'proposal-shelf'),
      [plus] = under(media).filter(item => item.className.startsWith('proposal-input is-empty'))[0].children;
    plus.onclick();
    await wait(0);
    assert.equal(shelf.hidden, false);
    assert.equal(under(shelf).some(item => String(item.className).includes('close')), false, 'no ×');
    card.card.fire('keydown', { key: 'Escape', preventDefault() {} });
    assert.equal(shelf.hidden, true, 'Échap closes it');
    plus.onclick();
    await wait(0);
    assert.equal(shelf.hidden, false);
    // A click in it leaves it open; a click beside it (elsewhere on the page) closes it.
    page.fire('pointerdown', { target: shelf });
    assert.equal(shelf.hidden, false);
    page.fire('pointerdown', { target: new Element('main') });
    assert.equal(shelf.hidden, true, 'a click beside it closes it');
    assert.equal(page.listeners.pointerdown?.size ?? 0, 0, 'nothing left listening');
    card.cancel.onclick();
    assert.equal(await card.answer, 'cancel');
  } finally {
    delete globalThis.document;
  }
});

test('an image dropped or pasted on the card is kept in the project, then goes in its case', async () => {
  const kept = [];
  const card = setup(withInputs(), {
    delay: 5000,
    importImage: async file => {
      kept.push(file.name);
      return { id: 'res-' + kept.length };
    },
  });
  const file = { name: 'falaise.png', type: 'image/png' };
  card.card.fire('dragover', { dataTransfer: { types: ['Files'] }, preventDefault() {} });
  assert.equal(card.card.classList.contains('is-dropping'), true, 'the empty cases light up');
  card.card.fire('drop', { dataTransfer: { files: [file] }, preventDefault() {} });
  assert.equal(card.card.classList.contains('is-dropping'), false);
  await wait(0);
  assert.deepEqual(kept, ['falaise.png']);
  assert.deepEqual(card.revised.at(-1)[1].edits.add, { role: 'end_image', source: { resource: 'res-1' } });
  // Pasted: the same way; a text pasted is left to the field.
  card.card.fire('paste', { clipboardData: { files: [] }, preventDefault: () => assert.fail('a text is not taken') });
  // (0.6.331) Nor the picture that comes with a text (cells of Excel): the text is what is pasted.
  card.card.fire('paste', {
    clipboardData: { files: [{ name: 'cells.png', type: 'image/png' }], getData: type => (type === 'text/plain' ? 'a\tb' : '') },
    preventDefault: () => assert.fail('a text that comes with its picture is not taken'),
  });
  await wait(0);
  assert.deepEqual(kept, ['falaise.png']);
  card.card.fire('paste', { clipboardData: { files: [{ name: 'image.webp', type: 'image/webp' }] }, preventDefault() {} });
  await wait(0);
  assert.deepEqual(kept, ['falaise.png', 'image.webp']);
  // Neither a video nor a GIF goes in a case of images.
  card.card.fire('drop', { dataTransfer: { files: [{ name: 'clip.mp4', type: 'video/mp4' }] }, preventDefault() {} });
  await wait(0);
  assert.equal(kept.length, 2);
  card.cancel.onclick();
  assert.equal(await card.answer, 'cancel');
});

test('in the Chat a video waits for the user on its card: no count, « En attente de votre accord » from the start', async () => {
  const shown = setup(video(), { delay: 0 });
  assert.equal(shown.status.textContent, 'En attente de votre accord');
  assert.equal(shown.card.dataset.phase, 'waiting');
  assert.equal(shown.go.classList.contains('is-counting'), false);
  let settled = false;
  void shown.answer.then(() => (settled = true));
  await wait(120);
  assert.equal(settled, false, 'nothing starts by itself');
  shown.go.onclick();
  assert.equal(await shown.answer, 'once');
});

test('« Paramètres avancés » and « Prompt » unfold softly where the page can animate, at once elsewhere', async () => {
  // A proposal whose prompt may be changed: « Prompt » folds at the foot of its card.
  const request = { ...video(), plan: { prompt: 'Un renard court.', parameters: { prompt: 'Un renard court.' }, editable: { prompt: true } } };
  const { card } = setup(request, { delay: 0 });
  const [toggle] = card.children.find(child => child.className === 'proposal-foot').children[0].children,
    [panel] = card.children.find(child => child.className === 'proposal-panels').children;
  assert.ok(toggle && panel, 'a fold and its panel');
  // Nothing to animate with (these nodes): open and closed at once.
  toggle.onclick();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  toggle.onclick();
  assert.equal(panel.hidden, true);
  // A page that animates: its height and its margin from nothing to their own, hidden once folded back.
  const moves = [];
  panel.getBoundingClientRect = () => ({ height: 148 });
  panel.animate = (frames, options) => {
    const move = { frames, options, cancel() {} };
    moves.push(move);
    return move;
  };
  toggle.onclick();
  assert.equal(panel.hidden, false);
  assert.deepEqual(moves[0].frames.map(frame => frame.height), ['0px', '148px']);
  assert.equal(moves[0].options.duration, 220);
  assert.equal(panel.style.overflow, 'hidden');
  moves[0].onfinish();
  assert.equal(panel.style.overflow, '');
  toggle.onclick();
  assert.equal(panel.hidden, false, 'still there while it folds back');
  assert.deepEqual(moves[1].frames.map(frame => frame.height), ['148px', '0px']);
  moves[1].onfinish();
  assert.equal(panel.hidden, true);
});

// (0.6.476) The models of a video of Moodix AI, as the server lists them (ToolCatalog.choices).
const roles = (start, end, subjects) => ({
  start_image: { count: start },
  end_image: { count: end },
  reference: { count: subjects },
});
const MODELS = [
  {
    family: 'ltx25',
    name: 'LTX 2.5',
    sound: true,
    create_video: { roles: roles(1, 1, 2) },
    workflowId: 'ltx',
    all: true,
  },
  {
    family: 'minimax_h3',
    name: 'MiniMax H3 Omni',
    sound: true,
    create_video: { roles: roles(0, 0, 3) },
    workflowId: 'mm',
    missing: true,
    all: false,
  },
  {
    family: 'pi_h3',
    name: 'pi H3',
    sound: true,
    create_video: { roles: roles(1, 1, 0) },
    workflowId: 'pi',
    all: false,
  },
  {
    family: 'wan22',
    name: 'Wan 2.2',
    sound: false,
    create_video: { roles: roles(1, 0, 0) },
    workflowId: 'wan',
    off: 'Wan 2.2 : il lui faut une carte NVIDIA.',
    all: false,
  },
];
const chosenOf = (family, name, extra = {}) => ({
  ...video(),
  workflowName: name,
  family,
  models: MODELS,
  inputRoles: ['start_image', 'end_image', 'reference', 'reference'],
  plan: {
    intention: 'Un plan fixe.',
    prompt: 'Un phare sous la pluie.',
    references: [{ role: 'start_image', preview: '/d.png', label: 'debut.png' }],
    editable: { prompt: true },
  },
  ...extra,
});
const menuOf = card => card.children.find(child => String(child.className).includes('bobine-model-menu'));

test('(0.6.476) the model of a video of Moodix AI is chosen in its title, in a list of glass as in the Bobine', async () => {
  const PI = {
    ...chosenOf('pi_h3', 'pi H3'),
    requestId: 'r2',
    approvalToken: 't2',
    held: [{ as: 'reference', label: 'sujet.png', why: 'pi H3 ne prend pas de sujet.' }],
    warning: 'Le sujet 1 n’est pas envoyé à pi H3 : retirez-le, ou choisissez LTX 2.5.',
  };
  const answers = [PI, { ...chosenOf('ltx25', 'LTX 2.5'), requestId: 'r3', approvalToken: 't3' }],
    told = 'Durée : 30 s → 10,04 s, la plus proche que LTX 2.5 permet.';
  const card = setup(chosenOf('ltx25', 'LTX 2.5', { notes: [told] }), {
    delay: 0,
    answer: route => (route === 'tools/revise' ? answers.shift() : {}),
  });
  // « PROPOSITION · VIDÉO · » then its model, a button: « LTX 2.5 ⌄ ».
  assert.equal(card.title.textContent, 'Proposition · Vidéo');
  const [chooser] = card.title.children;
  assert.equal(chooser.className, 'proposal-model');
  assert.deepEqual(
    chooser.children.map(child => [child.tag, child.className, child.textContent]),
    [
      ['span', 'proposal-model-name', 'LTX 2.5'],
      ['svg', '', ''],
    ],
  );
  assert.equal(chooser.children[1].children[0].attributes.href, '#i-chevron');
  assert.deepEqual(
    [chooser.attributes['aria-haspopup'], chooser.attributes['aria-expanded'], chooser.attributes['aria-label']],
    ['menu', 'false', 'Modèle de la vidéo : LTX 2.5'],
  );
  assert.equal(chooser.dataset.tip, 'Choisir le modèle de cette vidéo');
  assert.equal(chooser.dataset.missing, undefined);
  // Its list: the classes of the list of the Bobine, what each takes under its name, its own checked.
  chooser.onclick({ stopPropagation() {} });
  let menu = menuOf(card.card);
  assert.equal(menu.className, 'glass-menu bobine-piece-menu bobine-model-menu');
  assert.deepEqual(
    [menu.attributes.role, menu.attributes['aria-label'], menu.hidden],
    ['menu', 'Modèle de la vidéo', false],
  );
  assert.equal(chooser.attributes['aria-expanded'], 'true');
  const said = item => {
    const [text, check] = item.children;
    return [
      item.className,
      item.attributes['aria-checked'],
      text.children.map(child => child.textContent).join(' · '),
      Boolean(check),
      item.dataset.missing ?? '',
      item.dataset.tip ?? '',
    ];
  };
  assert.deepEqual(menu.children.map(said), [
    ['glass-menu-item bobine-model-item', 'true', 'LTX 2.5 · Début, fin, 2 sujets, son', true, '', ''],
    ['glass-menu-item bobine-model-item', 'false', 'MiniMax H3 Omni · 3 sujets, son', false, 'true', ''],
    ['glass-menu-item bobine-model-item', 'false', 'pi H3 · Début, fin, son', false, '', ''],
    [
      'glass-menu-item bobine-model-item is-off',
      'false',
      'Wan 2.2 · Début seulement, sans son',
      false,
      '',
      'Wan 2.2 : il lui faut une carte NVIDIA.',
    ],
  ]);
  const wan = menu.children[3];
  assert.equal(wan.attributes['aria-disabled'], 'true');
  assert.equal(wan.dataset.tipSide, 'right', 'its bubble beside the list, not over the models under it');
  // Greyed: chosen, nothing happens; Échap closes the list.
  wan.onclick();
  assert.equal(card.revised.length, 0);
  menu.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(menuOf(card.card), undefined);
  assert.equal(chooser.attributes['aria-expanded'], 'false');
  // Another one: the server makes the proposal again for it; the card is drawn again from its answer, what the one
  // before said only when it was so gone with it.
  chooser.onclick({ stopPropagation() {} });
  menuOf(card.card).children[2].onclick();
  await wait(0);
  assert.deepEqual(card.revised.at(-1), [
    'tools/revise',
    { requestId: 'r', approvalToken: 't', edits: { workflow: 'pi' } },
  ]);
  const [again] = card.title.children;
  assert.equal(again.children[0].textContent, 'pi H3');
  assert.equal(menuOf(card.card), undefined);
  const [, body] = card.card.children,
    texts = () => under(body).map(item => item.textContent);
  assert.ok(texts().includes(PI.warning), 'the line of what its model does not send');
  assert.equal(texts().includes(told), false, 'no longer said');
  // The subject it holds stays in its place, greyed, why in its bubble; its × takes it out.
  const kept = under(body).find(item => String(item.className).includes('is-held')),
    [frame, caption] = kept.children;
  assert.deepEqual([caption.textContent, frame.attributes['data-tip']], ['Sujet 1', 'pi H3 ne prend pas de sujet.']);
  const cross = under(kept).find(item => item.className === 'proposal-input-remove');
  assert.equal(cross.attributes['aria-label'], 'Retirer le sujet 1');
  // Back to LTX 2.5: its line and what it held go with the answer that does not say them.
  again.onclick({ stopPropagation() {} });
  menuOf(card.card).children[0].onclick();
  await wait(0);
  assert.deepEqual(card.revised.at(-1)[1].edits, { workflow: 'ltx' });
  assert.deepEqual(card.title.children.map(child => child.children[0].textContent), ['LTX 2.5']);
  assert.equal(texts().includes(PI.warning), false);
  assert.equal(under(body).some(item => String(item.className).includes('is-held')), false);
  card.cancel.onclick();
  assert.equal(await card.answer, 'cancel');
});

test('(0.6.476) the list of the models closes at a press beside it, and leaves nothing listening', async () => {
  const page = new Element('document');
  globalThis.document = page;
  try {
    const card = setup(chosenOf('ltx25', 'LTX 2.5'), { delay: 0 });
    const [chooser] = card.title.children;
    chooser.onclick({ stopPropagation() {} });
    const menu = menuOf(card.card);
    page.fire('pointerdown', { target: menu.children[1] });
    assert.equal(menuOf(card.card), menu, 'a press in it leaves it open');
    page.fire('pointerdown', { target: new Element('main') });
    assert.equal(menuOf(card.card), undefined, 'a press beside it closes it');
    // Open when the card goes: closed with it.
    chooser.onclick({ stopPropagation() {} });
    card.cancel.onclick();
    assert.equal(await card.answer, 'cancel');
    assert.equal(page.listeners.pointerdown?.size ?? 0, 0, 'nothing left listening');
  } finally {
    delete globalThis.document;
  }
});

test('(0.6.476) the × of an image of the card sends what was changed with it; a proposal without models has no list', async () => {
  const request = chosenOf('ltx25', 'LTX 2.5');
  const card = setup(request, {
    delay: 0,
    answer: route => (route === 'tools/revise' ? { ...request, requestId: 'r2' } : {}),
  });
  const [, body] = card.card.children;
  const prompt = under(card.card).find(item => item.className === 'proposal-prompt');
  prompt.value = 'Un phare sous la neige.';
  const cross = under(body).find(item => item.className === 'proposal-input-remove');
  assert.equal(cross.attributes['aria-label'], 'Retirer l’image de début');
  cross.onclick({ stopPropagation() {} });
  await wait(0);
  assert.deepEqual(card.revised.at(-1)[1].edits, { prompt: 'Un phare sous la neige.', remove: { input: 0 } });
  card.cancel.onclick();
  assert.equal(await card.answer, 'cancel');
  // A sound, a proposal by hand: its model in words, as before.
  const sound = setup({ mediaType: 'audio', workflowName: 'MOSS-SFX', plan: { intention: 'Un orage.' } });
  assert.deepEqual([sound.title.textContent, sound.title.children], ['Proposition · Son · MOSS-SFX', []]);
  sound.cancel.onclick();
  assert.equal(await sound.answer, 'cancel');
});

test('(0.6.476) a model that is not on this computer: its download offered in the card, its « Annuler » back to the proposal', async () => {
  const offer = {
      workflowId: 'mm',
      workflowName: 'MiniMax H3 Omni',
      family: 'minimax_h3',
      files: [{ file: 'minimax_h3_omni.safetensors', size: 21 * 1024 ** 3 }],
      bytes: 21 * 1024 ** 3,
      left: 21 * 1024 ** 3,
      needsToken: false,
      page: '',
    },
    MINIMAX = { ...chosenOf('minimax_h3', 'MiniMax H3 Omni'), requestId: 'r4', approvalToken: 't4' };
  let downloaded = false,
    fetched = 0;
  const card = setup(chosenOf('ltx25', 'LTX 2.5'), {
    delay: 0,
    // (0.6.493) The page then reads its models again (the Studio, the Bobine: relecture, m5).
    onFetched: () => fetched++,
    answer: route => {
      if (route === 'tools/revise')
        return downloaded
          ? MINIMAX
          : { ...chosenOf('ltx25', 'LTX 2.5'), requestId: 'r' + card.revised.length, approvalToken: 't', offer };
      if (route === 'downloads/start') return { received: 0, total: offer.bytes };
      if (route === 'downloads') return { job: downloaded ? { state: 'done', workflowId: 'mm' } : { state: 'idle' } };
      return {};
    },
  });
  const [, body, foot, panels, offered] = card.card.children,
    revisions = () => card.revised.filter(([route]) => route === 'tools/revise'),
    choose = async name => {
      card.title.children[0].onclick({ stopPropagation() {} });
      menuOf(card.card).children.find(item => item.children[0].children[0].textContent === name).onclick();
      await wait(0);
    };
  await choose('MiniMax H3 Omni');
  assert.deepEqual(revisions().at(-1)[1].edits, { workflow: 'mm' });
  // In place of its settings, of « Annuler » and of « Générer »: the card « Il manque un fichier », its name in amber.
  assert.deepEqual([body.hidden, foot.hidden, panels.hidden, offered.hidden], [true, true, true, false]);
  const [missing] = offered.children;
  assert.equal(missing.className, 'missing-card');
  assert.equal(missing.children[0].textContent, 'Il manque un fichier · Vidéo · MiniMax H3 Omni');
  // (0.6.493) Said by the head of the card, whose title stays in view at 1280 × 720 (the head of the offer is not
  // drawn there: public/moodix.css, relecture m6).
  assert.equal(card.status.textContent, 'Il manque un fichier');
  const [chooser] = card.title.children;
  assert.deepEqual([chooser.children[0].textContent, chooser.dataset.missing], ['MiniMax H3 Omni', 'true']);
  // In its list, the one checked is the one offered.
  chooser.onclick({ stopPropagation() {} });
  assert.deepEqual(
    menuOf(card.card).children.map(item => item.attributes['aria-checked']),
    ['false', 'true', 'false', 'false'],
  );
  menuOf(card.card).onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  // Its « Annuler »: the proposal again, as it was; nothing cancelled.
  const buttons = under(missing).filter(item => item.tag === 'button');
  assert.deepEqual(buttons.map(item => item.children.at(-1).textContent), ['Annuler', 'Télécharger · 21,0 Go']);
  buttons[0].onclick();
  assert.deepEqual([body.hidden, foot.hidden, offered.hidden, offered.children.length], [false, false, true, 0]);
  assert.equal(card.status.textContent, 'En attente de votre accord');
  const [back] = card.title.children;
  assert.deepEqual([back.children[0].textContent, back.dataset.missing], ['LTX 2.5', undefined]);
  assert.equal(card.host.children.some(child => child.className === 'proposal-cancelled'), false);
  assert.equal(card.card.parent, card.host);
  // Chosen again, then the model of the proposal chosen in the list: the offer goes too, nothing asked of the server.
  await choose('MiniMax H3 Omni');
  assert.equal(offered.hidden, false);
  const sent = revisions().length;
  await choose('LTX 2.5');
  assert.deepEqual([offered.hidden, body.hidden, revisions().length], [true, false, sent]);
  // Downloaded: the proposal is made for it, and the card shows it.
  await choose('MiniMax H3 Omni');
  assert.equal(fetched, 0);
  downloaded = true;
  under(offered).filter(item => item.tag === 'button')[1].onclick();
  await wait(10);
  assert.equal(fetched, 1, 'the files there, said to the page once');
  assert.deepEqual(revisions().at(-1)[1].edits, { workflow: 'mm' });
  const shown = [offered.hidden, body.hidden, foot.hidden, card.title.children[0].children[0].textContent];
  assert.deepEqual(shown, [true, false, false, 'MiniMax H3 Omni']);
  card.go.onclick();
  assert.equal(await card.answer, 'once');
});

test('(0.6.493) a proposal gone greys « Générer » with why: its time over, or the server saying so; never left on', async () => {
  const greyed = card => [
    card.go.attributes['aria-disabled'],
    card.go.dataset.tip,
    card.go.disabled,
    card.status.textContent,
  ];
  // Its time over (`expiresIn`: what the server keeps it): greyed, its reason in its bubble, nothing made.
  const late = setup({ ...video(), expiresIn: 20 }, { delay: 0 });
  assert.equal(late.status.textContent, 'En attente de votre accord');
  assert.equal(late.go.attributes['aria-disabled'], undefined);
  await wait(50);
  assert.deepEqual(greyed(late), ['true', 'Cet appel a expiré. Relancez la demande.', false, 'Expirée']);
  late.go.onclick();
  await wait(0);
  assert.equal(late.card.parent, late.host, 'nothing made: the card stays, its « Annuler » with it');
  late.cancel.onclick();
  assert.equal(await late.answer, 'cancel');
  // Its count stops with it where it has one: nothing starts by itself.
  const counted = setup({ ...video(), expiresIn: 10 }, { delay: 80 });
  await wait(120);
  assert.deepEqual(
    [counted.card.parent === counted.host, counted.go.classList.contains('is-counting'), counted.status.textContent],
    [true, false, 'Expirée'],
  );
  counted.cancel.onclick();
  assert.equal(await counted.answer, 'cancel');
  // Each answer of the server counts its own time: the download offered keeps it a day (lib/tool-runtime.mjs).
  const waiting = setup(chosenOf('ltx25', 'LTX 2.5', { expiresIn: 30 }), {
    delay: 0,
    answer: () => ({ ...chosenOf('pi_h3', 'pi H3'), requestId: 'r2', approvalToken: 't2', expiresIn: 60000 }),
  });
  waiting.title.children[0].onclick({ stopPropagation() {} });
  menuOf(waiting.card).children[2].onclick();
  await wait(60);
  assert.equal(waiting.go.attributes['aria-disabled'], undefined, 'the time of the new proposal');
  waiting.cancel.onclick();
  assert.equal(await waiting.answer, 'cancel');
  // Refused by the server (the files of a model came after the proposal expired; another tab used it): the same,
  // the reason in red under the card as before.
  for (const [said, word] of [
    ['Cet appel a expiré. Relancez la demande.', 'Expirée'],
    ['Cette proposition ne peut plus être modifiée.', 'Plus valable'],
  ]) {
    const refused = setup(chosenOf('ltx25', 'LTX 2.5'), {
      delay: 0,
      answer: route => {
        if (route === 'tools/revise') throw new Error(said);
        return {};
      },
    });
    refused.title.children[0].onclick({ stopPropagation() {} });
    menuOf(refused.card).children[2].onclick();
    await wait(10);
    assert.deepEqual(greyed(refused), ['true', said, false, word]);
    assert.ok(under(refused.card).some(item => item.textContent === said), 'said under the card');
    refused.go.onclick();
    await wait(0);
    assert.equal(refused.revised.filter(([route]) => route !== 'tools/revise').length, 0);
    assert.equal(refused.card.parent, refused.host);
    refused.cancel.onclick();
    assert.equal(await refused.answer, 'cancel');
  }
  // Any other refusal leaves it on: the proposal is still the one to confirm.
  const kept = setup(chosenOf('ltx25', 'LTX 2.5'), {
    delay: 0,
    answer: route => {
      if (route === 'tools/revise') throw new Error('Wan 2.2 part d’une image de début.');
      return {};
    },
  });
  kept.title.children[0].onclick({ stopPropagation() {} });
  menuOf(kept.card).children[2].onclick();
  await wait(10);
  assert.deepEqual([kept.go.attributes['aria-disabled'], kept.go.disabled], [undefined, false]);
  kept.go.onclick();
  assert.equal(await kept.answer, 'once');
  // Greyed, it reads so: the grey of what cannot be chosen, no accent (public/moodix.css).
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(css, /\.proposal-card \.proposal-go\[aria-disabled='true'\][^{]*\{[^}]*color: var\(--text-4\);/);
  assert.match(css, /\n#messages \.proposal-card \.proposal-offer \.missing-head \{\s*display: none;/);
  // (0.6.493) And the offer tighter in the card, every licence still read before « Télécharger » (relecture, m6: at
  // 1280 × 720, its title and the button of the model under the top of the conversation).
  assert.match(css, /\n#messages \.proposal-card \.proposal-offer \.missing-file \{\s*padding: 1px 0;/);
  assert.match(css, /\n#messages \.proposal-card \.proposal-offer \.missing-foot \{\s*margin-top: 10px;/);
  assert.doesNotMatch(css, /\.proposal-offer \.license-[a-z]+ \{\s*display: none;/);
});

test('(0.6.493) for a suite, the list of the card says what each model takes beside its clip, not for a new shot', async () => {
  const suite = { source: { count: 1, required: true } },
    models = [
      { ...MODELS[0], extend_video: { roles: { ...suite, reference: { count: 0 } } } },
      { ...MODELS[1], extend_video: { roles: { ...suite, reference: { count: 3 } } } },
      { ...MODELS[2], off: 'pi H3 ne prolonge pas une vidéo. Pour une suite : LTX 2.5 ou MiniMax H3 Omni.' },
      MODELS[3],
    ];
  const words = async verb => {
    const card = setup(chosenOf('ltx25', 'LTX 2.5', { models, ...(verb ? { verb } : {}) }), { delay: 0 });
    card.title.children[0].onclick({ stopPropagation() {} });
    const said = menuOf(card.card).children.map(item => [
      item.children[0].children[1].textContent,
      item.attributes['aria-label'],
    ]);
    card.cancel.onclick();
    await card.answer;
    return said;
  };
  assert.deepEqual(await words('extend_video'), [
    ['Vidéo, son', 'LTX 2.5, Vidéo, son'],
    ['Vidéo, 3 sujets, son', 'MiniMax H3 Omni, Vidéo, 3 sujets, son'],
    ['Début, fin, son', 'pi H3, Début, fin, son'],
    ['Début seulement, sans son', 'Wan 2.2, Début seulement, sans son'],
  ]);
  // A new shot, as before.
  for (const verb of ['create_video', undefined])
    assert.deepEqual(
      (await words(verb)).map(([said]) => said),
      ['Début, fin, 2 sujets, son', '3 sujets, son', 'Début, fin, son', 'Début seulement, sans son'],
    );
});
