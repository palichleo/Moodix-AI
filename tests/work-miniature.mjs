import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { FOLDED_KEY, setupMiniature } from '../public/work-miniature.mjs';

/**
 * The miniature of the chat (0.6.81, public/work-miniature.mjs): while a work goes on and the user
 * looks elsewhere, a small window shows it as the conversation does, brings back to it in one click,
 * and says how it ended. A page of elements enough for it: their classes, their words, their parent.
 */
class Element {
  constructor(tag = '', className = '', text = '') {
    const names = new Set(String(className).split(' ').filter(Boolean));
    Object.assign(this, { tag, className, textContent: text ?? '', children: [], parentNode: null, hidden: false, dataset: {}, attributes: {} });
    this.style = {
      values: {},
      setProperty(name, value) {
        this.values[name] = value;
      },
    };
    this.classList = {
      add: (...added) => added.forEach(name => names.add(name)),
      remove: (...removed) => removed.forEach(name => names.delete(name)),
      toggle: (name, on = !names.has(name)) => (on ? names.add(name) : names.delete(name), on),
      contains: name => names.has(name),
    };
  }
  append(...items) {
    for (const item of items) {
      if (item?.parentNode) item.parentNode.children = item.parentNode.children.filter(child => child !== item);
      if (item && typeof item === 'object') item.parentNode = this;
      this.children.push(item);
    }
  }
  prepend(item) {
    if (item.parentNode) item.parentNode.children = item.parentNode.children.filter(child => child !== item);
    item.parentNode = this;
    this.children.unshift(item);
  }
  replaceChildren(...items) {
    for (const child of this.children) if (child && typeof child === 'object') child.parentNode = null;
    this.children = [];
    this.append(...items);
  }
  /** (0.6.478) Every element under it of that class. */
  findAll(name) {
    return this.children
      .filter(child => child instanceof Element)
      .flatMap(child => [...(child.classList.contains(name) ? [child] : []), ...child.findAll(name)]);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  /** The first element under it of that class. */
  find(name) {
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (child.classList.contains(name)) return child;
      const found = child.find(name);
      if (found) return found;
    }
    return null;
  }
}
const node = (tag, className, text) => new Element(tag, className, text);

/** A miniature on a page, with what its Flux and its picture so far were told. */
function miniature({ storage = null, mayClose, onClosed } = {}) {
  const drawn = { fluxes: [], shown: [] },
    opened = [],
    // (0.6.478) What the gestures of its list of the queue asked the page.
    asked = [];
  const page = node('body');
  const mini = setupMiniature({
    node,
    icon: name => node('svg', 'icon-' + name),
    mark: () => node('svg', 'mark'),
    open: work => opened.push(work),
    ...(mayClose ? { mayClose } : {}),
    ...(onClosed ? { onClosed } : {}),
    ...Object.fromEntries(
      ['onRemove', 'onResume', 'onClear', 'onTakeBack', 'onOpenQueue', 'onRecover'].map(name => [
        name,
        (...args) => asked.push([name, ...args]),
      ]),
    ),
    storage,
    makeFlux: () => {
      const flux = { told: [], stopped: false, visible: null };
      for (const name of ['source', 'neutral', 'progress']) flux[name] = value => flux.told.push([name, value]);
      flux.visible = value => (flux.seen = value);
      flux.stop = () => (flux.stopped = true);
      drawn.fluxes.push(flux);
      return flux;
    },
    makePreview: () => ({ show: url => drawn.shown.push(url), clear() {} }),
  });
  page.append(mini.element);
  const part = name => mini.element.find(name);
  // (The words of its stage, beside its time since 0.6.93.)
  return { mini, page, drawn, opened, asked, part, said: () => part('work-mini-said').textContent };
}
const WORK = { conversationId: 'a1111111-1111-4111-8111-111111111111', title: 'Renard dans la neige', kind: 'turn' };
const video = { mediaType: 'video', workflowName: 'LTX 2.5', requestId: 'r1' };

test('the miniature shows the take in progress as the conversation does, and brings back to it in one click', () => {
  const { mini, drawn, opened, part, said } = miniature();
  // Nothing to show before a work.
  mini.place('corner');
  assert.equal(mini.element.hidden, true);
  mini.begin(WORK);
  mini.place('corner');
  assert.equal(mini.element.hidden, false);
  assert.equal(part('work-mini-title').textContent, 'Renard dans la neige');
  // Signed by the Éclipse of Moodix, beside the name of the conversation.
  assert.ok(part('work-mini-mark').find('mark'));
  // Moodix answers: its words, no take yet.
  assert.equal(said(), 'Moodix répond…');
  assert.equal(mini.element.classList.contains('has-take'), false);
  mini.answer('Le modèle se charge…');
  assert.equal(said(), 'Le modèle se charge…');
  // A video waits for the user on its card.
  mini.take({ type: 'start', request: video });
  assert.equal(mini.phase, 'waiting');
  assert.equal(said(), 'En attente de votre accord');
  assert.equal(part('work-mini-kind').textContent, 'Vidéo · LTX 2.5');
  // Made: its stage, its percentage, its line, the Flux of the picture so far.
  mini.take({ type: 'progress', request: video, text: 'Génération · 5/8', fraction: 0.42, preview: '/media/job-preview/j/3' });
  assert.equal(mini.phase, 'making');
  assert.equal(said(), 'Génération · 5/8');
  assert.equal(part('work-mini-percent').textContent, '42 %');
  assert.equal(part('work-mini-fill').style.values['--mini-progress'], '0.42');
  assert.equal(part('work-mini-bar').classList.contains('is-determinate'), true);
  assert.deepEqual(drawn.shown, ['/media/job-preview/j/3']);
  const flux = drawn.fluxes.at(-1);
  assert.deepEqual(flux.told.at(-1), ['progress', 0.42]);
  assert.equal(flux.seen, true, 'it draws while it is in sight');
  assert.match(part('work-mini-back').getAttribute('aria-label'), /^Revenir à la conversation « Renard dans la neige » : Vidéo · LTX 2\.5 · Génération · 5\/8 · 42/);
  // The take is there: its picture, its number.
  const record = { mediaType: 'video', outputs: [{ thumbUrl: '/media/thumbs/a/b/0', take: 14 }] };
  mini.take({ type: 'image', request: video, record, index: 0 });
  mini.take({ type: 'done', request: video, record, failed: false });
  assert.equal(mini.phase, 'done');
  assert.equal(said(), 'Prise 14 prête');
  assert.equal(part('work-mini-still').src, '/media/thumbs/a/b/0');
  assert.equal(part('work-mini-still').hidden, false);
  assert.equal(flux.stopped, true, 'its Flux ends with the take');
  // No × while the work goes on (Moodix may still answer); once it is over, the ×.
  assert.equal(part('work-mini-close').hidden, true);
  mini.end();
  assert.equal(mini.running, false);
  assert.equal(part('work-mini-close').hidden, false);
  // One click: back to its conversation.
  part('work-mini-back').onclick();
  assert.deepEqual(opened.map(work => work.conversationId), [WORK.conversationId]);
  // Closed: nothing left of it.
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, true);
  assert.equal(mini.work, null);
});

test('the miniature says how long the take has been in the making, as its card does, then how long it took (0.6.93)', () => {
  const { mini, part, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  const time = () => part('work-mini-time');
  // Waiting for the user: nothing counted yet.
  mini.take({ type: 'start', request: video });
  assert.equal(time().textContent, '');
  // Its card heard the server: the same count, at the right of its stage.
  mini.take({ type: 'progress', request: video, text: 'Génération · 5/8', fraction: 0.42 });
  mini.take({ type: 'time', text: '1 min 12 s' });
  assert.deepEqual([said(), time().textContent], ['Génération · 5/8', '1 min 12 s']);
  assert.equal(time().parentNode, part('work-mini-stage'), 'on the line of its stage');
  assert.match(part('work-mini-back').getAttribute('aria-label'), /Génération · 5\/8 · 42 % · 1 min 12 s$/);
  // Made: how long it took, as its record says it.
  const record = { mediaType: 'video', parameters: { generation_time: { total_ms: 73400 } }, outputs: [{ take: 14 }] };
  mini.take({ type: 'image', request: video, record, index: 0 });
  mini.take({ type: 'done', request: video, record, failed: false });
  assert.deepEqual([said(), time().textContent], ['Prise 14 prête', '1 min 13 s']);
  // Made before 0.6.93 (the engine's time alone), or failed: no time.
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'time', text: '12 s' });
  mini.take({ type: 'done', request: video, record: { ...record, parameters: { generation_duration_ms: 70000 } } });
  assert.equal(time().textContent, '');
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'progress', request: video, text: 'Génération · 1/8', fraction: 0.1 });
  mini.take({ type: 'time', text: '12 s' });
  mini.take({ type: 'failed', message: 'La mémoire a manqué.' });
  assert.equal(time().textContent, '');
});

test('the miniature says a failure, a cancellation, and an answer made of words alone', () => {
  const { mini, part, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  // An image is made at once (no card).
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  assert.equal(mini.phase, 'making');
  assert.equal(part('work-mini-kind').textContent, 'Image · Krea 2');
  mini.take({ type: 'failed', message: 'La carte graphique manque de mémoire.' });
  assert.equal(mini.phase, 'failed');
  assert.equal(said(), 'Échec · La carte graphique manque de mémoire.');
  assert.equal(mini.element.dataset.phase, 'failed');

  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'progress', request: video, text: 'Génération · 1/8', fraction: 0.1 });
  mini.take({ type: 'stopped' });
  // (0.6.198) With its full stop, as the Studio, the Chat and the server say it.
  assert.equal(said(), 'Génération arrêtée.');

  // A turn of words alone, over while the user was away.
  mini.begin(WORK);
  mini.end();
  assert.equal(mini.phase, 'answered');
  assert.equal(said(), 'Moodix a répondu');
  assert.equal(mini.taking, false);
  // A card answered (declined) where it was shown leaves nothing to say of a take.
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.end();
  assert.equal(mini.phase, 'answered');
  // Over, it hears nothing more of takes.
  mini.take({ type: 'start', request: video });
  assert.equal(mini.phase, 'answered');
});

test('the miniature folds into a pill the browser keeps; in the foot of the Paramètres it is that pill, then back in its corner', () => {
  const kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const { mini, page, drawn, part } = miniature({ storage });
  mini.begin(WORK);
  mini.place('corner');
  assert.equal(mini.folded, false);
  part('work-mini-fold').onclick();
  assert.equal(mini.element.classList.contains('is-folded'), true);
  assert.equal(kept.get(FOLDED_KEY), 'pill');
  assert.equal(part('work-mini-fold').getAttribute('aria-label'), 'Agrandir la miniature');
  // The next page opens it folded, as it was left.
  assert.equal(miniature({ storage }).mini.folded, true);
  // In the foot of the Paramètres (a window above the page), then back in the page.
  const foot = node('footer', 'settings-footer');
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.place(foot);
  assert.equal(mini.element.parentNode, foot);
  assert.equal(foot.children[0], mini.element, 'at the left of « Annuler » and « Enregistrer »');
  assert.equal(mini.element.classList.contains('is-foot'), true);
  mini.place('corner');
  assert.equal(mini.element.parentNode, page);
  assert.equal(mini.element.classList.contains('is-foot'), false);
  // Out of sight, its Flux does not draw.
  mini.place(null);
  assert.equal(mini.element.hidden, true);
  assert.equal(drawn.fluxes.at(-1).seen, false);
});

test('(0.6.200) on the page of the Bobine it comes as its pill, opened there by its chevron; the choice kept for the other pages is left as it was', () => {
  // (Check of 21/11, overload, problem 7: open in its corner, 232 × 224, it covered the end of the timeline.)
  const kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) };
  const { mini, part } = miniature({ storage }),
    folded = () => mini.element.classList.contains('is-folded');
  mini.begin(WORK);
  mini.place('corner', { pill: true });
  assert.deepEqual([folded(), part('work-mini-fold').getAttribute('aria-label')], [true, 'Agrandir la miniature']);
  // Opened there as anywhere; put again there (the page follows its work), it stays open.
  part('work-mini-fold').onclick();
  mini.place('corner', { pill: true });
  assert.deepEqual([folded(), part('work-mini-fold').getAttribute('aria-label'), kept.get(FOLDED_KEY)], [false, 'Réduire la miniature', undefined]);
  // Another page, left open: as the user keeps it (open). Back on the Bobine: its pill again.
  mini.place('corner');
  assert.equal(folded(), false);
  mini.place('corner', { pill: true });
  assert.equal(folded(), true);
  // Opened and folded again there by its chevron: nothing kept.
  part('work-mini-fold').onclick();
  part('work-mini-fold').onclick();
  assert.deepEqual([folded(), kept.get(FOLDED_KEY)], [true, undefined]);
  // Folded by the user on another page: kept, and folded on the Bobine too.
  mini.place('corner');
  part('work-mini-fold').onclick();
  mini.place('corner', { pill: true });
  assert.deepEqual([kept.get(FOLDED_KEY), folded(), mini.folded], ['pill', true, true]);
});

test('« × » asks the page first: kept when it says no, and the page told what went with it (0.6.87)', () => {
  // Without the history, the conversation it leads back to can be opened from nowhere else: the page
  // asks before, and lets it go with it.
  let allowed = false;
  const closed = [];
  const { mini, part } = miniature({ mayClose: () => allowed, onClosed: work => closed.push(work) });
  mini.begin(WORK);
  mini.take({ type: 'start', request: video });
  mini.take({ type: 'done', record: { id: 'r', outputs: [{ take: 3 }] } });
  mini.end();
  mini.place('corner');
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, false, 'kept');
  assert.equal(mini.work?.conversationId, WORK.conversationId);
  assert.deepEqual(closed, []);
  allowed = true;
  part('work-mini-close').onclick();
  assert.equal(mini.element.hidden, true);
  assert.deepEqual(closed.map(work => work.conversationId), [WORK.conversationId]);
});

test('a take waiting for the user in the Studio of its conversation says so, without a Flux, until it begins (0.6.88)', () => {
  // « Préparation… » over a Flux that moved for nothing while Moodix AI waited there.
  const { mini, drawn, said } = miniature();
  mini.begin(WORK);
  mini.place('corner');
  mini.take({ type: 'start', request: { mediaType: 'image', workflowName: 'Krea 2', requestId: 'r2' } });
  assert.equal([mini.phase, said()].join(' · '), 'making · Préparation…');
  const flux = drawn.fluxes.at(-1);
  mini.waitFor('Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal([mini.phase, said()].join(' · '), 'waiting · Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(flux.stopped, true, 'no Flux for nothing');
  // It begins: made as any take.
  mini.take({ type: 'progress', text: 'Génération · 1/8', fraction: 0.1 });
  assert.equal([mini.phase, said()].join(' · '), 'making · Génération · 1/8');
  mini.waitFor('Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(mini.phase, 'making', 'once begun, nothing to wait for');
  // A video waiting on its card says what it always said.
  mini.take({ type: 'start', request: video });
  assert.equal(said(), 'En attente de votre accord');
  // (0.6.180) One of the Studio or of the Bobine (a compact card) was accepted by its click: it is being
  // prepared, nothing waits for the user. It said « En attente de votre accord » until its first step.
  mini.take({ type: 'start', compact: true, request: video });
  assert.deepEqual([mini.phase, said()], ['making', 'Préparation…']);
});

/**
 * The page's side (app.js): where it puts the miniature (syncMiniature), and what it keeps of the take
 * of the Chat for the Studio of its conversation (chatTake), cut out of app.js and run on a page of
 * its own.
 */
const appSource = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function appPart(from, to) {
  const start = appSource.indexOf(from),
    end = appSource.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `slice not found: ${from} … ${to}`);
  return appSource.slice(start, end);
}
// (0.6.478) `studio`: more of the Studio (its queue); `elements`: more of the page, by their id; `page`: its document.
function shownPage({ studio = {}, elements = {}, page = { body: { dataset: {} } } } = {}) {
  const { mini, part } = miniature(),
    foot = node('footer', 'settings-footer'),
    settings = { open: false, querySelector: selector => (selector === '.settings-footer' ? foot : null) },
    watched = [],
    // A proposal of Moodix AI waiting in the Studio of the work's conversation.
    held = { waiting: false };
  const state = {
    view: 'chat',
    conversationId: WORK.conversationId,
    miniature: mini,
    work: null,
    waitingForModel: false,
    studio: {
      proposing: () => held.waiting,
      heldFor: () => (held.waiting ? WORK.conversationId : null),
      holds: () => held.waiting,
      watch: () => watched.push(structuredClone(state.work?.take ?? null)),
      ...studio,
    },
  };
  const context = {
    state,
    $: id => (id === 'settings' ? settings : (elements[id] ?? null)),
    shownHere: id => !id || state.conversationId === id,
    document: page,
  };
  runInNewContext(
    appPart('function syncMiniature(', '/** Whether `version`') +
      appPart('function chatTake(', '/** The name a work gives') +
      '\nthis.syncMiniature = syncMiniature;\nthis.chatTake = chatTake;',
    context,
  );
  return { mini, part, foot, settings, state, held, watched, sync: context.syncMiniature, chatTake: context.chatTake };
}

test('in the conversation of its work, its Chat as its Studio, the miniature never shows; elsewhere it does (0.6.96)', () => {
  // Chat and Studio are two views of one conversation: it showed in the Studio whenever the Studio did
  // not hold the take (one asked in the Chat, a video waiting on its card there), as for another one.
  const { mini, part, foot, settings, state, held, sync } = shownPage();
  state.work = { ...WORK };
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.take({ type: 'progress', text: 'Génération · 2/8', fraction: 0.25 });
  for (const view of ['chat', 'studio']) {
    state.view = view;
    sync();
    assert.equal(mini.element.hidden, true, 'in its ' + view);
  }
  // A proposal of Moodix AI waiting in its Studio, a video waiting on its card in its Chat: the same.
  held.waiting = true;
  sync();
  assert.equal(mini.element.hidden, true);
  held.waiting = false;
  mini.take({ type: 'start', request: video });
  sync();
  assert.equal(mini.element.hidden, true);
  // The Pellicule, another conversation in its Chat or its Studio: it shows, in its corner.
  mini.take({ type: 'progress', request: video, text: 'Génération · 3/8', fraction: 0.4 });
  state.view = 'library';
  sync();
  assert.equal(mini.element.hidden, false);
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  for (const view of ['chat', 'studio']) {
    state.view = view;
    sync();
    assert.equal(mini.element.hidden, false, 'in the ' + view + ' of another');
    assert.equal(part('work-mini-said').textContent, 'Génération · 3/8');
  }
  // The Paramètres, over its conversation: the pill in their foot.
  state.conversationId = WORK.conversationId;
  settings.open = true;
  sync();
  assert.equal(mini.element.parentNode, foot);
  settings.open = false;
  sync();
  assert.equal(mini.element.hidden, true);
  // A proposal waiting in its Studio, seen from another conversation: said so (0.6.88), as before.
  mini.begin(WORK);
  mini.take({ type: 'start', request: { mediaType: 'image', workflowName: 'Krea 2', requestId: 'r3' } });
  held.waiting = true;
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  sync();
  assert.equal(part('work-mini-said').textContent, 'Moodix AI vous attend dans le Studio de cette conversation');
  assert.equal(mini.element.hidden, false);
  // Back in its conversation once it is over (in its Studio too): nothing more to say.
  held.waiting = false;
  mini.end();
  state.conversationId = WORK.conversationId;
  state.view = 'studio';
  sync();
  assert.equal(mini.work, null);
});

test('(0.6.200) the page puts the miniature as its pill on the Bobine, as the user keeps it everywhere else', () => {
  const { mini, state, sync } = shownPage(),
    folded = () => mini.element.classList.contains('is-folded');
  state.work = { ...WORK };
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  state.view = 'bobine';
  sync();
  assert.deepEqual([mini.element.hidden, folded()], [false, true]);
  for (const view of ['library', 'chat', 'studio']) {
    state.view = view;
    sync();
    assert.deepEqual([mini.element.hidden, folded()], [false, false], view);
  }
});

test('the page keeps the take of the Chat being made for the Studio of its conversation, not one of the Studio (0.6.96)', () => {
  const { state, watched, chatTake } = shownPage();
  const asked = { requestId: 'r1', workflowName: 'Krea 2', plan: { prompt: 'un phare' } };
  // No work: nothing to keep.
  chatTake({ type: 'start', request: asked });
  assert.deepEqual(watched, []);
  state.work = { ...WORK };
  chatTake({ type: 'start', request: asked });
  assert.equal(state.work.take.request, asked);
  assert.equal(state.work.take.running, false, 'not begun: a card may wait for the user');
  chatTake({ type: 'progress', request: asked, text: 'Génération · 2/8', fraction: 0.25, preview: '/p/2', time: { ms: 3000, running: true } });
  chatTake({ type: 'progress', request: asked, text: '', fraction: null, preview: null, time: null });
  assert.deepEqual(
    [state.work.take.running, state.work.take.label, state.work.take.fraction, state.work.take.preview, state.work.take.time?.ms],
    [true, 'Génération · 2/8', 0.25, '/p/2', 3000],
    'what is not said again stays as it was (its time from its go too, 0.6.93)',
  );
  // Its picture, its card's count each second, and the progress of another card, change nothing.
  chatTake({ type: 'image', request: asked, record: { id: 'x' }, index: 0 });
  chatTake({ type: 'time', request: asked, text: '4 s' });
  chatTake({ type: 'progress', request: { requestId: 'other' }, text: 'Génération · 7/8', fraction: 0.9 });
  assert.equal(state.work.take.label, 'Génération · 2/8');
  const record = { id: 'run', outputs: [{ take: 4 }] };
  chatTake({ type: 'done', request: asked, record, failed: false, error: '' });
  // (Made in the page's realm: read field by field.)
  const ended = () => [state.work.take.running, state.work.take.ended?.type, state.work.take.ended?.record, state.work.take.ended?.message];
  assert.deepEqual(ended(), [false, 'done', record, '']);
  chatTake({ type: 'start', request: { requestId: 'r2' } });
  chatTake({ type: 'failed', request: state.work.take.request, message: 'La mémoire a manqué.' });
  assert.deepEqual(ended(), [false, 'failed', null, 'La mémoire a manqué.']);
  // The Studio heard each step (it follows the take from it).
  assert.deepEqual(
    watched.map(take => [take.running, take.label, take.ended?.type ?? null]),
    [
      [false, '', null],
      [true, 'Génération · 2/8', null],
      [true, 'Génération · 2/8', null],
      [false, 'Génération · 2/8', 'done'],
      [false, '', null],
      [false, '', 'failed'],
    ],
  );
  // A creation of the Studio (its card compact) is followed by the Studio itself: nothing kept.
  const before = state.work.take;
  chatTake({ type: 'start', compact: true, request: { requestId: 'studio' } });
  chatTake({ type: 'progress', compact: true, request: { requestId: 'studio' }, text: 'Génération · 1/8', fraction: 0.1 });
  assert.equal(state.work.take, before);
  assert.equal(watched.length, 6);
});

// (0.6.478) The queue of the Studio, as studio.mjs (queueView) gives it: a part per conversation.
const row = (id, prompt, extra = {}) => ({
  id,
  kind: 'image',
  icon: 'image',
  prompt,
  what: 'Krea 2 · 16:9',
  tries: 1,
  reason: '',
  tip: `Image · Krea 2 · 16:9\n${prompt}`,
  ...extra,
});
const RESUME = {
  label: 'Reprendre · 2',
  icon: 'go',
  held: false,
  tip: 'Reprendre la file : les 2 demandes en attente, dans l’ordre',
  clear: 'Vider la file : retirer les 2 demandes en attente',
};
function queuePart(extra = {}) {
  return {
    conversation: WORK.conversationId,
    title: 'Renard dans la neige',
    groups: [
      { word: 'En attente', state: 'waiting', rows: [row('q1', 'un bateau', { tries: 3 }), row('q2', 'une île')] },
    ],
    why: '',
    card: false,
    stopped: false,
    note: '',
    held: '',
    foot: null,
    ...extra,
  };
}
/** All the words under an element, in their order. */
const textOf = element =>
  [element.textContent, ...element.children.filter(child => child instanceof Element).map(textOf)]
    .filter(Boolean)
    .join('');

test('(0.6.478) under the take, what waits in its order: a line each, its cross; folded, « 2 en attente »', () => {
  const { mini, asked, part } = miniature(),
    lines = () => mini.element.findAll('work-mini-row');
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.take({ type: 'progress', text: 'Génération · 5/8', fraction: 0.46 });
  mini.queue([queuePart()]);
  mini.place('corner');
  assert.deepEqual(
    [mini.element.hidden, part('work-mini-file').hidden, mini.element.classList.contains('has-queue')],
    [false, false, true],
  );
  // The take is its conversation's: its name is not said twice. Its title, then a line per request, the next first.
  assert.equal(part('work-mini-queue-back'), null);
  assert.equal(textOf(part('work-mini-queue-title')), 'En attente · 2');
  assert.deepEqual(
    lines().map(line => [
      line.find('work-mini-row-text').textContent,
      line.find('work-mini-row-model').textContent,
      line.find('work-mini-row-tries')?.textContent ?? '',
      line.find('work-mini-row-words').title,
      line.find('work-mini-row-words').dataset.tipSide,
      line.find('work-mini-row-del').title,
    ]),
    [
      ['un bateau', 'Krea 2 · 16:9', '× 3', 'Image · Krea 2 · 16:9\nun bateau', 'left', 'Retirer de la file'],
      ['une île', 'Krea 2 · 16:9', '', 'Image · Krea 2 · 16:9\nune île', 'left', 'Retirer de la file'],
    ],
  );
  lines()[1].find('work-mini-row-del').onclick();
  assert.deepEqual(asked, [['onRemove', 'q2', WORK.conversationId]]);
  // The take draws the window each second: the list is drawn again only when what it says changes.
  const drawnLine = lines()[0];
  mini.take({ type: 'progress', text: 'Génération · 6/8', fraction: 0.6 });
  assert.equal(lines()[0], drawnLine);
  // Folded, the pill says what waits beside the percentage (moodix.css hides its list).
  part('work-mini-fold').onclick();
  const kind = part('work-mini-kind');
  assert.deepEqual(
    [kind.textContent, kind.classList.contains('is-count'), part('work-mini-percent').textContent],
    ['2 en attente', true, '60 %'],
  );
  part('work-mini-fold').onclick();
  assert.deepEqual([kind.textContent, kind.classList.contains('is-count')], ['Image · Krea 2', false]);
  // In the foot of the Paramètres it is the pill too (the maquette's 6d): it says so there, its corner left open.
  mini.place(node('footer', 'settings-footer'));
  assert.deepEqual([kind.textContent, mini.element.classList.contains('has-count')], ['2 en attente', true]);
  mini.place('corner');
  assert.deepEqual([kind.textContent, mini.folded], ['Image · Krea 2', false]);
});

test('(0.6.478) a queue paused stays, no ×: why, « Reprendre · 2 », « Vider la file »; a failure given back', () => {
  const { mini, asked, part } = miniature();
  const paused = queuePart({
    groups: [
      { word: 'En pause', state: 'paused', rows: [row('q1', 'un bateau'), row('q2', 'une île')] },
      { word: '', state: 'failed', rows: [row('q3', 'le phare', { reason: 'Mémoire vidéo insuffisante.' })] },
    ],
    why: 'Génération arrêtée.',
    stopped: true,
    foot: RESUME,
  });
  // No work: the list alone, under the name of its conversation (a click on it opens its Studio).
  mini.queue([paused]);
  mini.place('corner', { alone: true });
  assert.deepEqual(
    [
      mini.element.hidden,
      part('work-mini-back').hidden,
      part('work-mini-close').hidden,
      mini.element.classList.contains('has-now'),
    ],
    [false, true, true, false],
  );
  assert.equal(part('work-mini-queue-name').textContent, 'Renard dans la neige');
  part('work-mini-queue-back').onclick();
  assert.equal(part('work-mini-queue-why').textContent, 'Génération arrêtée.');
  assert.equal(textOf(part('work-mini-queue-head')), 'En pause · 2');
  assert.equal(mini.element.findAll('work-mini-queue-head').length, 1);
  // The failure: in red, why in place of its model; a click gives its settings back to the Studio.
  const failed = mini.element.findAll('work-mini-row').find(line => line.classList.contains('is-failed'));
  assert.deepEqual(
    [failed.tag, failed.find('work-mini-row-why').textContent, failed.find('work-mini-row-del').title],
    ['li', 'Échec · Mémoire vidéo insuffisante.', 'Retirer cette demande'],
  );
  failed.find('work-mini-row-words').onclick();
  const go = part('work-mini-resume');
  assert.deepEqual([textOf(go), go.title, part('work-mini-clear').title], ['Reprendre · 2', RESUME.tip, RESUME.clear]);
  go.onclick();
  part('work-mini-clear').onclick();
  assert.deepEqual(asked, [
    ['onOpenQueue', WORK.conversationId],
    ['onTakeBack', 'q3', WORK.conversationId],
    ['onResume', WORK.conversationId],
    ['onClear', WORK.conversationId],
  ]);
  // Greyed (a take of the Bobine): why above it, and it does nothing. The card held: « Libérer le GPU ».
  const held = 'Attendez la fin de la prise de la Bobine.';
  mini.queue([{ ...paused, held, foot: { ...RESUME, held: true, tip: held } }]);
  mini.place('corner', { alone: true });
  assert.deepEqual(
    [part('work-mini-held').textContent, part('work-mini-resume').getAttribute('aria-disabled')],
    [held, 'true'],
  );
  part('work-mini-resume').onclick();
  mini.queue([{ ...paused, foot: { ...RESUME, label: 'Libérer le GPU', icon: 'chip', recover: true } }]);
  mini.place('corner', { alone: true });
  assert.ok(part('work-mini-resume').find('icon-chip'));
  part('work-mini-resume').onclick();
  assert.deepEqual(asked.slice(4), [['onRecover', WORK.conversationId]]);
  // In the Chat or the Studio of its conversation, its name is not said; « Génération arrêtée. » is not said twice,
  // under the take of its conversation that says it.
  mini.place('corner', { alone: true, home: WORK.conversationId });
  assert.equal(part('work-mini-queue-back'), null);
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  mini.take({ type: 'stopped' });
  mini.end();
  mini.place('corner');
  assert.deepEqual([part('work-mini-said').textContent, part('work-mini-queue-why')], ['Génération arrêtée.', null]);
  // Folded with nothing else, the pill is its title alone; under a work (Moodix answers), « 2 en pause ».
  mini.forget();
  part('work-mini-fold').onclick();
  mini.place('corner', { alone: true });
  assert.deepEqual(
    [mini.element.hidden, mini.folded, mini.element.classList.contains('has-count')],
    [false, true, false],
  );
  mini.begin({ ...WORK, conversationId: 'b2222222-2222-4222-8222-222222222222', title: 'Affiche du festival' });
  mini.place('corner');
  const kind = part('work-mini-kind');
  assert.deepEqual(
    [kind.textContent, kind.classList.contains('is-paused'), mini.element.classList.contains('has-count')],
    ['2 en pause', true, true],
  );
  // Nothing waits any more: the window goes with the queue.
  mini.forget();
  mini.queue([]);
  mini.place('corner', { alone: true });
  assert.equal(mini.element.hidden, true);
});

test('(0.6.478) in its Studio the list lies under the settings; no room: its title until its chevron opens it', () => {
  const kept = new Map(),
    storage = { getItem: key => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, value) },
    { mini, part } = miniature({ storage }),
    classes = () => ['is-docked', 'is-folded', 'is-over'].filter(name => mini.element.classList.contains(name));
  mini.queue([queuePart()]);
  const dock = { left: 1148, width: 268, bottom: 200, room: 240, over: 380 };
  mini.place('corner', { alone: true, home: WORK.conversationId, dock });
  assert.deepEqual(classes(), ['is-docked']);
  assert.deepEqual(mini.element.style.values, {
    '--work-mini-left': '1148px',
    '--work-mini-width': '268px',
    '--work-mini-bottom': '200px',
    '--work-mini-room': '240px',
    '--work-mini-over': '380px',
  });
  // Its chevron folds it there alone: nothing kept for the other pages.
  part('work-mini-fold').onclick();
  assert.deepEqual([classes(), kept.size], [['is-docked', 'is-folded'], 0]);
  mini.place('corner', { alone: true });
  assert.deepEqual(classes(), []);
  // 1280 × 720: 60 px under the settings, its title alone; its chevron opens it over them, a new drawing keeps it.
  mini.place('corner', { alone: true, dock: { ...dock, room: 60 } });
  assert.deepEqual(classes(), ['is-docked', 'is-folded']);
  part('work-mini-fold').onclick();
  mini.place('corner', { alone: true, dock: { ...dock, room: 60 } });
  assert.deepEqual(classes(), ['is-docked', 'is-over']);
  // In a Chat of 1168 px, its pill rises over the input; the user's choice for the other pages is left as it was.
  mini.place('corner', { alone: true, pill: true, raise: 213 });
  assert.deepEqual(
    [mini.element.classList.contains('is-raised'), mini.folded, mini.element.style.values['--work-mini-raise']],
    [true, true, '213px'],
  );
  mini.place('corner', { alone: true });
  assert.deepEqual([mini.element.classList.contains('is-raised'), mini.folded, kept.size], [false, false, 0]);
});

// (0.6.501) Its line in the Studio, when the button of the Studio does not say « Reprendre » (a model not on this
// computer: « Télécharger »): « Reprendre · 2 » in it, not behind its chevron (1280 × 720, 1168 × 788). With less room
// under the settings than its height (1280 × 720, the settings of a model not on this computer 45 px taller), it lies
// lower, 4 px under them, never nearer the Sortie than 4 px: it covered 6 px of them.
test('(0.6.501) its line in the Studio: « Reprendre » in it, never over the settings nor on the Sortie', async () => {
  const { mini, part } = miniature(),
    has = name => mini.element.classList.contains(name),
    bottom = () => mini.element.style.values['--work-mini-bottom'],
    groups = [{ word: 'En pause', state: 'paused', rows: [row('q1', 'un bateau')] }],
    paused = queuePart({ groups, foot: RESUME }),
    // 1280 × 720, a model not on this computer: the foot of the settings 230 px from that of the page, the screen's
    // 193, the top of the Sortie 179 (studio.mjs, queueDock): 22 px under the settings.
    dock = { left: 988, width: 268, bottom: 193, room: 22, over: 407, under: 230, floor: 179 };
  mini.queue([paused]);
  mini.place('corner', { alone: true, home: WORK.conversationId, dock });
  assert.deepEqual([mini.folded, has('has-pill-foot'), bottom()], [true, true, '183px']);
  assert.equal(textOf(part('work-mini-resume')), 'Reprendre · 2');
  // Shown there by its style: its title without the count its button says, « Vider la file » once opened.
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8'),
    rule = selector => css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}'))?.[1],
    pill = '.work-mini.is-docked.has-pill-foot ';
  assert.match(rule(pill + '.work-mini-queue:first-child > .work-mini-foot'), /display: flex;/);
  for (const hidden of ['.work-mini-queue:first-child .work-mini-queue-count', '.work-mini-foot > .work-mini-clear'])
    assert.match(rule(pill + hidden), /display: none;/);
  // Opened by its chevron: over the settings, its foot at its bottom; the same foot of the window, nothing jumps.
  part('work-mini-fold').onclick();
  assert.deepEqual([has('is-over'), has('has-pill-foot'), bottom()], [true, false, '183px']);
  part('work-mini-fold').onclick();
  // 1168 × 788: room enough for its line, on the foot of the screen; « Reprendre » in it too.
  mini.place('corner', { alone: true, home: WORK.conversationId, dock: { ...dock, room: 90, under: 299 } });
  assert.deepEqual([mini.folded, has('has-pill-foot'), bottom()], [true, true, '193px']);
  // Its list (1440 × 900): on the foot of the screen, as it was.
  mini.place('corner', { alone: true, home: WORK.conversationId, dock: { ...dock, room: 200, under: 409 } });
  assert.deepEqual([mini.folded, has('has-pill-foot'), bottom()], [false, false, '193px']);
  // The button of the Studio says « Reprendre » (no foot), or the queue is another conversation's: its title alone.
  const elsewhere = { ...paused, conversation: 'b2222222-2222-4222-8222-222222222222' };
  for (const given of [{ ...paused, foot: null }, elsewhere]) {
    mini.queue([given]);
    mini.place('corner', { alone: true, home: WORK.conversationId, dock });
    assert.deepEqual([mini.folded, has('has-pill-foot')], [true, false]);
  }
  // A dock measured without the settings nor the Sortie (as before): on the foot of the screen.
  const unmeasured = { ...dock, under: undefined, floor: undefined };
  mini.place('corner', { alone: true, home: WORK.conversationId, dock: unmeasured });
  assert.equal(bottom(), '193px');
});

test('(0.6.478) the page puts the queue under the settings of its Studio, over the input of a narrow Chat', () => {
  const docked = { left: 1148, width: 268, bottom: 200, room: 240, over: 380 },
    form = { getBoundingClientRect: () => ({ width: 760, right: 964, top: 575 }) },
    screen = { clientWidth: 1168, clientHeight: 788 },
    told = [];
  let parts = [queuePart()];
  const { mini, part, state, sync } = shownPage({
    studio: {
      queueView: options => (told.push(options.docked), parts),
      queueDock: () => docked,
    },
    elements: { 'chat-form': form },
    page: { body: { dataset: {} }, documentElement: screen },
  });
  const where = () => [
    mini.element.hidden,
    ...['has-now', 'is-docked', 'is-raised', 'is-folded'].filter(name => mini.element.classList.contains(name)),
  ];
  // Its Studio: the list alone, under the settings (and told so: « Reprendre » is its button's there).
  state.view = 'studio';
  sync();
  assert.deepEqual([where(), told.at(-1), part('work-mini-queue-back')], [[false, 'is-docked'], true, null]);
  // Its Chat at 1168 px: its pill over the input (open, it covered its end); at 1440 px, in its corner.
  state.view = 'chat';
  sync();
  assert.deepEqual([where(), told.at(-1)], [[false, 'is-raised', 'is-folded'], false]);
  assert.equal(mini.element.style.values['--work-mini-raise'], '225px');
  Object.assign(screen, { clientWidth: 1440, clientHeight: 900 });
  form.getBoundingClientRect = () => ({ width: 760, right: 1100, top: 799 });
  sync();
  assert.deepEqual(where(), [false]);
  // Elsewhere, the name of its conversation above it.
  state.view = 'library';
  sync();
  assert.deepEqual([where(), part('work-mini-queue-name').textContent], [[false], 'Renard dans la neige']);
  // A take of its conversation, seen from another one: the take, then the list.
  state.work = { ...WORK };
  mini.begin(WORK);
  mini.take({ type: 'start', request: { workflowName: 'Krea 2', autoAllow: true } });
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  state.view = 'chat';
  sync();
  assert.deepEqual([where(), part('work-mini-back').hidden], [[false, 'has-now'], false]);
  // Nothing waits, the take over and seen: nothing.
  parts = [];
  mini.end();
  state.conversationId = WORK.conversationId;
  state.view = 'studio';
  sync();
  assert.deepEqual([mini.element.hidden, mini.work], [true, null]);
});

// ---- (0.6.505) Petits défauts du 27/11
// The queue of another conversation lying in the Studio, 1168 × 788: 135 px under the settings, more than ROOM (102),
// but its name, why it is paused and its foot stuck at its bottom (« Reprendre · 3 », « Vider la file ») left no room
// for its first line, whole under that foot (46 px of 46). Its title alone then, as at 1280 × 720, opened over the
// settings by its chevron.
test('(0.6.505) in the Studio, a queue of another conversation counts its name, why, its foot: its title alone', () => {
  const { mini, part } = miniature(),
    has = name => mini.element.classList.contains(name),
    shown = 'b2222222-2222-4222-8222-222222222222',
    groups = [{ word: 'En pause', state: 'paused', rows: [row('q1', 'un bateau'), row('q2', 'une île')] }],
    stopped = queuePart({ groups, why: 'Génération arrêtée.', stopped: true, foot: RESUME }),
    // 1168 × 788, Krea 2 here (studio.mjs, queueDock).
    dock = { left: 876, width: 268, bottom: 193, room: 135, over: 475, under: 343, floor: 179 },
    at = (given, room) => {
      mini.queue([given]);
      mini.place('corner', { alone: true, home: shown, dock: { ...dock, room } });
      return [mini.folded, has('is-docked'), has('has-pill-foot')];
    };
  // Its name, « Génération arrêtée. », its foot: 102 + 28 + 25 + 45 = 200 px needed. Its title alone, on the foot of
  // the screen; « Reprendre » behind its chevron (its line has no room for the name of another conversation).
  assert.deepEqual(at(stopped, 135), [true, true, false]);
  assert.equal(mini.element.style.values['--work-mini-bottom'], '193px');
  part('work-mini-fold').onclick();
  assert.deepEqual([mini.folded, has('is-over')], [false, true]);
  part('work-mini-fold').onclick();
  // 1440 × 900 (247 px), and with a model not on this computer (202): its list, as it was.
  assert.deepEqual(at(stopped, 247), [false, true, false]);
  assert.deepEqual(at(stopped, 202), [false, true, false]);
  // « Page rechargée : … » takes two lines (41,8 px): with a model not on this computer at 1440 × 900, its title alone
  // (it covered 2 px of the first line); at 1912 × 948 (250 px), its list.
  const reloaded = { ...stopped, why: 'Page rechargée : les 2 demandes attendent « Reprendre ».', stopped: false };
  assert.deepEqual(at(reloaded, 202), [true, true, false]);
  assert.deepEqual(at(reloaded, 250), [false, true, false]);
  // Only waiting (no why, no foot): its name alone, 130 px, room enough at 1168 × 788.
  assert.deepEqual(at(queuePart(), 135), [false, true, false]);
  // The queue of the conversation shown, its button saying « Reprendre »: no name, no why, no foot, as before.
  mini.queue([{ ...stopped, why: '', foot: null }]);
  mini.place('corner', { alone: true, home: WORK.conversationId, dock });
  assert.deepEqual([mini.folded, has('has-pill-foot')], [false, false]);
  // Its button saying « Télécharger » (a model not on this computer, the settings 45 px taller at 1440 × 900): why and
  // its foot, room enough; at 1168 × 788 its line with « Reprendre · 2 » (0.6.501).
  mini.queue([stopped]);
  mini.place('corner', { alone: true, home: WORK.conversationId, dock: { ...dock, room: 202 } });
  assert.deepEqual([mini.folded, has('has-pill-foot')], [false, false]);
  mini.place('corner', { alone: true, home: WORK.conversationId, dock: { ...dock, room: 90 } });
  assert.deepEqual([mini.folded, has('has-pill-foot')], [true, true]);
});

// In the Chat of a new conversation at 1168 × 788, the pill rose 12 px over the input, at the end of « Racontez-moi
// votre idée. »: opened by its chevron, it covered the end of that title (16 × 79 px). It rises over the welcome too;
// opened, never above the foot of the top bar, its foot in sight.
test('(0.6.505) a new conversation: its pill rises over the welcome, opened on neither title nor input', async () => {
  const form = { getBoundingClientRect: () => ({ width: 760, right: 964, top: 404.1, bottom: 536.1, height: 132 }) },
    welcome = { hidden: false, getBoundingClientRect: () => ({ top: 284.8, bottom: 404.1, height: 119.3 }) },
    card = { hidden: true, getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }) },
    screen = { clientWidth: 1168, clientHeight: 788 };
  const { mini, state, sync } = shownPage({
    studio: { queueView: () => [queuePart({ why: 'Génération arrêtée.', foot: RESUME })], queueDock: () => null },
    elements: { 'chat-form': form, welcome, 'setup-card': card },
    page: { body: { dataset: {} }, documentElement: screen },
  });
  const raised = () => [
    mini.element.classList.contains('is-raised'),
    mini.folded,
    mini.element.style.values['--work-mini-raise'],
  ];
  state.view = 'chat';
  state.conversationId = 'b2222222-2222-4222-8222-222222222222';
  sync();
  // 12 px over the welcome (788 - 284,8 + 12): its foot 272 px from the top of the page, above the title.
  assert.deepEqual(raised(), [true, true, '516px']);
  // The card before the first message, shown above the input with no welcome: over it.
  Object.assign(welcome, { hidden: true });
  Object.assign(card, { hidden: false, getBoundingClientRect: () => ({ top: 300, bottom: 390, height: 90 }) });
  sync();
  assert.deepEqual(raised(), [true, true, '500px']);
  // A conversation with its messages (no welcome, the input at the foot of the page): over the input, as before.
  card.hidden = true;
  form.getBoundingClientRect = () => ({ width: 760, right: 964, top: 644, bottom: 766, height: 122 });
  sync();
  assert.deepEqual(raised(), [true, true, '156px']);
  // Opened there, never above the foot of the top bar (72 px): its list scrolls in it, its foot at its bottom.
  const css = await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8'),
    rules = selector =>
      [...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))].map(
        found => found[1],
      );
  const highest = /max-height: calc\(100vh - var\(--work-mini-raise\) - 72px\);/;
  assert.ok(rules('.work-mini.is-raised').some(rule => highest.test(rule)));
  assert.ok(rules('.work-mini.is-raised .work-mini-foot').some(rule => /position: sticky;/.test(rule)));
});
