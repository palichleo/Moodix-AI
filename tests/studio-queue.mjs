import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { QUEUE_KEY, QUEUE_MOST, createQueue } from '../public/studio-queue.mjs';

/** A sessionStorage of the page: what it holds, and whether it refuses. */
function tabStorage(held = {}) {
  const items = new Map(Object.entries(held));
  return {
    items,
    refuse: false,
    getItem(key) {
      if (this.refuse) throw Error('refused');
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      if (this.refuse) throw Error('refused');
      items.set(key, String(value));
    },
    removeItem(key) {
      items.delete(key);
    },
  };
}
const asked = (prompt, conversation = 'c1') => ({ mode: 'image', prompt, conversation, project: 'p1', tries: 1 });

test('(0.6.466) the requests go in the order they were asked, one at a time', () => {
  const queue = createQueue();
  const first = queue.begin(asked('A'));
  assert.equal(first.state, 'running');
  assert.equal(first.at, 1);
  const [b, c] = [queue.add(asked('B')), queue.add(asked('C'))];
  assert.deepEqual(queue.waiting().map(entry => entry.prompt), ['B', 'C']);
  // The one being made is not the next.
  assert.equal(queue.next().id, b.id);
  queue.done(first.id);
  queue.start(b.id);
  assert.equal(queue.running().id, b.id);
  assert.equal(queue.next().id, c.id);
  queue.done(b.id);
  queue.start(c.id);
  queue.done(c.id);
  assert.equal(queue.next(), null);
  assert.deepEqual(queue.entries(), []);
});

test('(0.6.466) 20 requests wait at most: the 21st is refused (D6)', () => {
  const queue = createQueue();
  queue.begin(asked('en cours'));
  for (let at = 0; at < QUEUE_MOST; at++) assert.ok(queue.add(asked('n' + at)));
  assert.equal(queue.full(), true);
  assert.equal(queue.add(asked('de trop')), null);
  assert.equal(queue.waits(), QUEUE_MOST);
  // One taken away: there is room again. A failure does not count.
  queue.remove(queue.waiting()[0].id);
  queue.fail(queue.waiting()[0].id, 'raté');
  assert.equal(queue.full(), false);
  assert.ok(queue.add(asked('encore')));
  assert.ok(queue.add(asked('et encore')));
  assert.equal(queue.add(asked('trop')), null);
});

test('(0.6.466) its cross takes one away, « Vider la file » those that wait in the conversation', () => {
  const queue = createQueue();
  const running = queue.begin(asked('en cours'));
  const [b, c] = [queue.add(asked('B')), queue.add(asked('C'))];
  const elsewhere = queue.add(asked('D', 'c2'));
  // Never the one being made: « Arrêter » stops it.
  assert.equal(queue.remove(running.id), false);
  assert.equal(queue.remove(b.id), true);
  assert.deepEqual(queue.waiting().map(entry => entry.prompt), ['C', 'D']);
  queue.fail(c.id, 'raté');
  queue.add(asked('E'));
  queue.pause('stopped');
  queue.clear('c1');
  // The failure stays, with its own cross; another conversation keeps its own.
  assert.deepEqual(queue.entries().map(entry => [entry.prompt, entry.state]), [
    ['en cours', 'running'],
    ['C', 'failed'],
    ['D', 'paused'],
  ]);
  assert.equal(queue.get(elsewhere.id).state, 'paused');
  queue.forget('c2');
  assert.equal(queue.get(elsewhere.id), null);
});

test('(0.6.466) a request that fails is kept with its reason, and the next one goes', () => {
  const queue = createQueue();
  const b = queue.add(asked('B')),
    c = queue.add(asked('C'));
  queue.start(b.id);
  queue.fail(b.id, 'L’image de départ a été retirée du projet.');
  assert.equal(queue.next().id, c.id);
  assert.deepEqual(
    queue.failed().map(entry => [entry.prompt, entry.reason]),
    [['B', 'L’image de départ a été retirée du projet.']],
  );
  assert.equal(queue.waits(), 1);
});

test('(0.6.466) paused, nothing goes until « Reprendre », in their order', () => {
  const queue = createQueue();
  const b = queue.add(asked('B')),
    c = queue.add(asked('C')),
    d = queue.add(asked('D', 'c2'));
  queue.pause('stopped');
  assert.equal(queue.next(), null);
  assert.deepEqual(queue.paused('c1').map(entry => [entry.prompt, entry.reason]), [['B', 'stopped'], ['C', 'stopped']]);
  // A request asked once the queue is paused goes in its turn: it is not paused.
  const e = queue.add(asked('E'));
  assert.equal(queue.next().id, e.id);
  queue.done(e.id);
  queue.resume('c1');
  assert.deepEqual(queue.waiting().map(entry => entry.id), [b.id, c.id]);
  assert.equal(queue.get(d.id).state, 'paused');
  // The card held while one was about to be made: it goes back at its place, paused, with the tries it has left.
  queue.start(b.id);
  queue.tried(b.id, 2);
  queue.hold(b.id, 'card', 3);
  queue.pause('card');
  assert.deepEqual(
    queue.paused('c1').map(entry => [entry.prompt, entry.reason, entry.tries, Boolean(entry.later)]),
    [
      ['B', 'card', 3, false],
      ['C', 'card', 1, false],
    ],
  );
  // Held between two of its tries: the next one draws a seed of its own when it goes (`later`).
  queue.resume('c1');
  queue.start(b.id);
  queue.hold(b.id, 'card', 2, true);
  assert.deepEqual([queue.get(b.id).state, queue.get(b.id).tries, queue.get(b.id).later], ['paused', 2, true]);
});

test('(0.6.466) kept in its tab: a reload of that tab finds it paused, with the tries not begun (B1)', () => {
  const storage = tabStorage(),
    queue = createQueue({ storage, tab: 'onglet-1' });
  const running = queue.begin({ ...asked('A'), tries: 3 });
  queue.tried(running.id, 2);
  queue.add(asked('B'));
  const c = queue.add(asked('C'));
  queue.fail(c.id, 'raté');
  queue.add({ ...asked('D'), tries: 1 });
  const kept = JSON.parse(storage.items.get(QUEUE_KEY));
  assert.equal(kept.tab, 'onglet-1');
  assert.equal(kept.entries.length, 4);
  const again = createQueue({ storage, tab: 'onglet-1' });
  // The try being made is followed by the page; the third one waits, with B and D. Nothing goes by itself (D3).
  // (The third one of A, `later`: its seed its own, as in a series.)
  const found = again
    .entries()
    .map(entry => [entry.prompt, entry.state, entry.tries, entry.reason, Boolean(entry.later)]);
  assert.deepEqual(found, [
    ['A', 'paused', 1, 'reload', true],
    ['B', 'paused', 1, 'reload', false],
    ['C', 'failed', 1, 'raté', false],
    ['D', 'paused', 1, 'reload', false],
  ]);
  assert.equal(again.next(), null);
  again.resume('c1');
  assert.equal(again.next().prompt, 'A');
  // Emptied, nothing is kept.
  for (const entry of again.entries()) again.done(entry.id);
  assert.equal(storage.items.has(QUEUE_KEY), false);
});

test('(0.6.466) a take of one try made when the page was reloaded leaves nothing to make', () => {
  const storage = tabStorage(),
    queue = createQueue({ storage, tab: 'onglet-1' });
  queue.begin(asked('A'));
  assert.deepEqual(createQueue({ storage, tab: 'onglet-1' }).entries(), []);
});

test('(0.6.466) a tab duplicated from it (another identity, navigation « navigate ») takes nothing', () => {
  const storage = tabStorage(),
    queue = createQueue({ storage, tab: 'onglet-1' });
  queue.add(asked('B'));
  // The copy has the storage of the first, and an identity of its own (app.js, TAB).
  const copy = createQueue({ storage: tabStorage(Object.fromEntries(storage.items)), tab: 'onglet-2' });
  assert.deepEqual(copy.entries(), []);
  assert.deepEqual(createQueue({ storage, tab: '' }).entries(), []);
});

test('(0.6.466) a storage unreadable or refused is ignored: the queue goes on in the page', () => {
  for (const held of ['{pas du json', JSON.stringify({ tab: 'onglet-1', entries: 'rien' }), JSON.stringify([1, 2])]) {
    const queue = createQueue({ storage: tabStorage({ [QUEUE_KEY]: held }), tab: 'onglet-1' });
    assert.deepEqual(queue.entries(), []);
  }
  const odd = tabStorage({
    [QUEUE_KEY]: JSON.stringify({
      tab: 'onglet-1',
      entries: [null, 3, { state: 'waiting' }, { id: 'x', state: 'waiting' }],
    }),
  });
  assert.deepEqual(createQueue({ storage: odd, tab: 'onglet-1' }).entries().map(entry => entry.id), ['x']);
  const refused = tabStorage();
  refused.refuse = true;
  const queue = createQueue({ storage: refused, tab: 'onglet-1' });
  queue.add(asked('B'));
  assert.equal(queue.next().prompt, 'B');
});

/**
 * (0.6.466) The Chat of the page (public/app.js) while the queue of the Studio goes on, run as the page runs it: what
 * decides whether a message leaves (updateControls), Entrée (sendMessage), ■ (its click), the work said held
 * elsewhere (workHeld), the question of the browser before the tab is closed (beforeunload). `studio`: what the
 * Studio says of its queue.
 */
async function chatOfPage() {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  // From `from` to `end` (a match of it kept: the end of a function, its closing brace).
  const piece = (from, end) => {
    const rest = source.slice(source.indexOf(from)),
      found = rest.match(end);
    assert.ok(source.includes(from) && found, from);
    return rest.slice(0, found.index + found[0].length);
  };
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id))
      nodes.set(id, {
        id,
        disabled: false,
        hidden: false,
        value: '',
        textContent: '',
        title: '',
        dataset: {},
        attributes: {},
        classList: { toggle() {} },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        replaceChildren() {},
      });
    return nodes.get(id);
  };
  const notices = [],
    stops = [],
    calls = [],
    listeners = {},
    studio = { holds: true, queued: 2, waits: 2 };
  const state = {
    status: { state: 'ready', busy: false, logs: [], toolJob: { id: 'j', state: 'generating', fraction: 0.46 } },
    connected: true,
    config: {},
    messages: [],
    images: [],
    videos: [],
    saveHistory: true,
    conversationId: 'c1',
    work: { kind: 'studio', conversationId: 'c1' },
    studio: {
      queueHolds: () => studio.holds,
      queued: () => studio.queued,
      queueReason: () => (studio.queued ? 'Le chat attend la fin de la file du Studio.' : ''),
      queueWaits: () => studio.waits,
      stopQueue: () => stops.push('stop'),
      proposing: () => false,
    },
  };
  const context = {
    state,
    $: get,
    notice: text => notices.push(text),
    shownHere: id => !id || id === state.conversationId,
    titleOf: id => (id === 'c1' ? 'Un phare' : ''),
    api: async (...args) => (calls.push(args), {}),
    window: { addEventListener: (type, listener) => (listeners[type] = listener) },
    assetsUI: { hasDraft: () => false, setBusy() {} },
    settingsGuard: { isDirty: () => false },
    projectUI: { sync() {} },
    workflowsUI: { setBusy() {} },
    generationUI: { held() {} },
    labels: { ready: 'Prêt' },
    icon: () => ({}),
    document: { documentElement: { dataset: {} }, body: { dataset: {} }, querySelectorAll: () => [] },
    queueMicrotask,
  };
  runInNewContext(
    [
      piece('function updateControls()', /(?=\nasync function checkUpdates\()/),
      piece('function workHeld(', /(?=\nfunction beginWork\()/),
      piece('async function sendMessage(event) {', /\n\}\r?\n/),
      piece("$('cancel').onclick = () => {", /\n\};\r?\n/),
      piece("window.addEventListener('beforeunload', event => {", /\n\}\);\r?\n/),
      'this.updateControls = updateControls; this.workHeld = workHeld; this.sendMessage = sendMessage;',
    ].join('\n'),
    context,
  );
  return { ...context, get, state, studio, notices, stops, calls, listeners };
}

// « 46 % · 2 en attente », ■ says what it does, Entrée says why it waits (B3).
test('(0.6.466) the Chat during the queue of the Studio (app.js): held from one request to the next', async () => {
  const page = await chatOfPage();
  const { get, state, studio, notices, stops, calls } = page;
  const chat = () => [
      state.sendHeld,
      get('send').hidden,
      get('cancel').hidden,
      get('cancel').title,
      get('compose-state').textContent,
    ],
    halt = 'Arrêter la génération : la file du Studio se met en pause';
  // A take of the Studio, two requests after it.
  page.updateControls();
  assert.deepEqual(chat(), [true, true, false, halt, '46 % · 2 en attente']);
  // Between two requests no take is on the server: the Chat is held all the same (a message would take the card).
  state.status.toolJob = null;
  studio.queued = 1;
  page.updateControls();
  assert.deepEqual(chat(), [true, true, false, halt, 'Génération en cours… · 1 en attente']);
  // ■ then: the Studio pauses its queue, there is no take on the server to cancel.
  get('cancel').onclick();
  assert.deepEqual([stops, calls], [['stop'], []]);
  // Entrée with a message written: it waits, and the page says why (it said nothing); the box empty, nothing.
  get('prompt').value = 'Bonjour';
  page.updateControls();
  await page.sendMessage({ preventDefault() {} });
  get('prompt').value = '';
  page.updateControls();
  await page.sendMessage({ preventDefault() {} });
  assert.deepEqual(notices, ['Le chat attend la fin de la file du Studio.']);
  // Another conversation shown meanwhile: the work said held there, as for a take being made.
  state.conversationId = 'c2';
  page.updateControls();
  const said = page.workHeld().replace(/ /g, ' ');
  assert.deepEqual(
    [state.sendHeld, get('cancel').hidden, get('compose-state').textContent, said],
    [true, true, 'Génération en cours ailleurs', 'Génération en cours dans « Un phare » : attendez sa fin.'],
  );
  // Paused: it holds nothing.
  Object.assign(state, { conversationId: 'c1', work: null });
  Object.assign(studio, { holds: false, queued: 0 });
  page.updateControls();
  assert.deepEqual(chat(), [false, false, true, 'Interrompre la réponse', '']);
});

test('(0.6.466, B1) the tab closed while requests of the Studio wait, paused too: the browser asks first', async () => {
  const { state, studio, listeners } = await chatOfPage();
  const asks = () => {
    const event = {
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
    };
    listeners.beforeunload(event);
    return event.prevented;
  };
  state.work = null;
  assert.equal(asks(), true);
  studio.waits = 0;
  assert.equal(asks(), false);
  // A take of the Studio alone, as before: reloaded, the page follows it again.
  state.work = { kind: 'studio', conversationId: 'c1' };
  assert.equal(asks(), false);
});

// A conversation deleted takes its requests.
test('(0.6.466) the page gives the Studio the storage and the identity of its tab (app.js)', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const call = source.slice(
    source.indexOf('const studioUI = setupStudio({'),
    source.indexOf('state.studio = studioUI;'),
  );
  assert.match(call, /queueStorage: \(\(\) => \{\s+try \{\s+return sessionStorage;/);
  assert.match(call, /\n {2}tab: TAB,\r?\n\}\);/);
  // In clearHistory: what its queue had to make goes with the conversation, after its copies.
  const forget = source.slice(source.indexOf('async function clearHistory()'));
  assert.match(forget, /forgetCopies\(target\?\.id \?\? null\);\r?\n[^\n]*\r?\n\s+state\.studio\?\.forgetQueue\?\./);
  assert.match(forget, /state\.studio\?\.forgetQueue\?\.\(target\?\.id \?\? null\);/);
});
