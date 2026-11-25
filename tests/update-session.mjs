import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { keptUpdateSession, REJECTED, updateSession } from '../lib/update-session.mjs';

test('restart session retains the pending user turn and incomplete marker even when it is restored as a draft', () => {
  const snapshot = {
    messages: [
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Pending message' },
    ],
    incomplete: true,
  };
  const saved = updateSession({
    messages: snapshot.messages.slice(0, -1),
    archiveSnapshot: snapshot,
    conversationId: 'a1111111-1111-4111-8111-111111111111',
    prompt: 'Pending message',
    images: [],
    title: 'Question',
    thinking: true,
  });
  assert.deepEqual(saved.archiveSnapshot, snapshot);
  assert.equal(saved.prompt, 'Pending message');
  assert.equal(saved.messages.length, 2);
});
test('session checkpoint refuses remote images, unsupported roles and invalid pending records', () => {
  const base = { messages: [], conversationId: null, prompt: '', images: [], title: '', thinking: true };
  assert.throws(() => updateSession({ ...base, images: [{ name: 'x', url: 'https://example.org/x.png' }] }));
  assert.throws(() => updateSession({ ...base, messages: [{ role: 'system', content: 'Not permitted' }] }));
  assert.throws(() => updateSession({ ...base, archiveSnapshot: { messages: [], incomplete: 'no' } }));
});

test('a large valid transcript is transferred and checkpointed once while retaining a pending tail', async () => {
  const { compactSession } = await import('../public/update-ui.mjs');
  assert.equal(typeof compactSession, 'function');
  const messages = Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'x'.repeat(150000),
  }));
  const pending = { role: 'user', content: 'Draft waiting for an answer' };
  const input = {
    messages,
    archiveSnapshot: { messages: [...messages, pending], incomplete: true },
    conversationId: null,
    prompt: pending.content,
    images: [],
    title: 'Large conversation',
    thinking: true,
  };
  const wire = compactSession(input);
  assert.ok(Buffer.byteLength(JSON.stringify(wire)) < 20 * 1024 * 1024);
  const restored = updateSession(wire);
  assert.equal(restored.messages.length, 80);
  assert.equal(restored.archiveSnapshot.messages.length, 81);
  assert.equal(restored.archiveSnapshot.messages.at(-1).content, pending.content);
  assert.ok(Buffer.byteLength(JSON.stringify(compactSession(restored))) < 20 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(compactSession(JSON.parse(JSON.stringify(restored))))) < 20 * 1024 * 1024);
});

test('a conversation taken back keeps the file of its attached images: it can be saved and gone on with', () => {
  const pixels = 'data:image/png;base64,iVBORw0KGgo=',
    file = 'original-' + 'a'.repeat(64) + '.png',
    base = { conversationId: 'a1111111-1111-4111-8111-111111111111', prompt: '', images: [], title: '', thinking: true };
  const saved = updateSession({
    ...base,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Regarde' },
          // As the page holds it: the model's copy, its file, the address it is shown by.
          { type: 'image_url', image_url: { url: pixels }, file, view: '/media/attachments/x?key=1' },
          // Just reopened: no copy made yet.
          { type: 'image_url', file },
        ],
      },
    ],
    // The draft: one joined now, one taken back from an interrupted message, one that is a reference.
    images: [
      { name: 'a.png', url: pixels },
      { name: 'b.png', file },
      { name: 'c.png', url: pixels, file, resource: 'c3333333-3333-4333-8333-333333333333', view: '/x', source: {} },
    ],
  });
  assert.deepEqual(saved.messages[0].content, [
    { type: 'text', text: 'Regarde' },
    { type: 'image_url', image_url: { url: pixels }, file },
    { type: 'image_url', file },
  ]);
  assert.deepEqual(saved.images, [
    { name: 'a.png', url: pixels },
    { name: 'b.png', file },
    { name: 'c.png', url: pixels, file, resource: 'c3333333-3333-4333-8333-333333333333' },
  ]);
  // A name that is no file of the history is not taken on trust; without pixels it is nothing.
  const odd = updateSession({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: pixels }, file: '../secret.png' }] }] });
  assert.deepEqual(odd.messages[0].content, [{ type: 'image_url', image_url: { url: pixels } }]);
  assert.throws(() => updateSession({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', file: '../secret.png' }] }] }));
  assert.throws(() => updateSession({ ...base, images: [{ name: 'x', file: 'C:\\x.png' }] }));
});

test('a conversation of more than a hundred messages goes through an update or a restart', () => {
  const base = { conversationId: 'a1111111-1111-4111-8111-111111111111', prompt: '', images: [], title: '', thinking: true },
    many = count => Array.from({ length: count }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'm' + index }));
  // Thirty creations made from the chat are a hundred and twenty messages.
  assert.equal(updateSession({ ...base, messages: many(120) }).messages.length, 120);
  assert.equal(updateSession({ ...base, messages: many(1000) }).messages.length, 1000);
  assert.throws(() => updateSession({ ...base, messages: many(1001) }));
  const snapshot = { messages: many(121), incomplete: true };
  assert.equal(updateSession({ ...base, messages: snapshot.messages.slice(0, 120), archiveSnapshot: snapshot }).archiveSnapshot.messages.length, 121);
});

test('the draft goes through a restart whole: the videos joined, the numbers of its images, its project (0.6.293)', () => {
  const PIXELS = 'data:image/png;base64,iVBORw0KGgo=',
    base = { messages: [], conversationId: null, prompt: 'Anime #ref4 comme #ref3', images: [], title: '', thinking: true },
    video = { id: 'e5555555-5555-4555-8555-555555555555', label: '#ref3', name: 'plage.mp4' },
    // As the page holds it: the file chosen is not sent, its size is not kept.
    image = { name: 'chat.png', url: PIXELS, resource: 'c3333333-3333-4333-8333-333333333333', ref: '#ref4', width: 64, source: {} };
  const kept = updateSession({ ...base, images: [image], videos: [video], projectId: 'voyage-2' });
  assert.deepEqual(kept.images, [{ name: 'chat.png', url: PIXELS, resource: image.resource, ref: '#ref4' }]);
  assert.deepEqual([kept.videos, kept.projectId], [[video], 'voyage-2']);
  assert.equal(updateSession({ ...base, projectId: 'inbox' }).projectId, 'inbox');

  // What is not what the page makes of them is left out, the rest stays: a draft never refuses a restart.
  const odd = updateSession({
    ...base,
    images: [{ ...image, ref: '<b>' }, { ...image, ref: 4 }, { ...image, ref: '#ref0' }],
    videos: [video, { ...video, id: '../x' }, { ...video, label: 'ref3' }, null, 'x', { ...video, name: 7 }, { id: video.id }],
    projectId: '../autre',
  });
  assert.deepEqual(odd.images.map(item => 'ref' in item), [false, false, false]);
  assert.deepEqual(odd.videos, [video, { ...video, name: '' }]);
  assert.equal('projectId' in odd, false);
  // A page of a version before sends none of this; what is no list is none; a message holds 64 at most.
  assert.deepEqual([updateSession(base).videos, 'projectId' in updateSession(base)], [[], false]);
  assert.deepEqual(updateSession({ ...base, videos: 'plage.mp4' }).videos, []);
  assert.equal(updateSession({ ...base, videos: Array(70).fill(video) }).videos.length, 64);

  // The conversation set aside (kept without the history) the same.
  const ASIDE = 'b2222222-2222-4222-8222-222222222222',
    aside = updateSession({ ...base, aside: { ...base, conversationId: ASIDE, images: [image], videos: [video], projectId: 'voyage-2' } }).aside;
  assert.deepEqual([aside.videos, aside.projectId, aside.images[0].ref], [[video], 'voyage-2', '#ref4']);
  assert.equal(updateSession({ ...base, aside: { ...base, conversationId: ASIDE, projectId: '../x' } }).aside.projectId, 'inbox');
});

test('a copy this version refuses is put aside, once; one the disk does not give for now stays (0.6.287)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-session-'));
  try {
    const file = join(dir, 'update-session.json'),
      aside = join(dir, REJECTED),
      good = {
        messages: [{ role: 'user', content: 'un renard' }],
        conversationId: null,
        prompt: 'brouillon',
        images: [],
        title: 'Renard',
        thinking: false,
      },
      said = [],
      take = options => keptUpdateSession(dir, { log: (...words) => said.push(words.join(' ')), ...options });
    // Nothing kept: nothing said.
    assert.equal(await take(), null);
    assert.deepEqual(said, []);
    // Read as it is: its takes are a list, or none.
    await writeFile(file, JSON.stringify({ ...good, gallery: { 0: 'x' } }));
    assert.deepEqual([(await take()).prompt, (await take()).gallery], ['brouillon', []]);
    await writeFile(file, JSON.stringify({ ...good, gallery: 'x' }));
    assert.deepEqual((await take()).gallery, []);
    await writeFile(file, JSON.stringify({ ...good, gallery: [{ id: 'a' }], restarted: true }));
    assert.deepEqual([(await take()).gallery, (await take()).restarted], [[{ id: 'a' }], true]);
    assert.deepEqual(said, []);
    // Refused by the rules of this version (a role it does not know): put aside whole, nothing left to read.
    const refused = JSON.stringify({ ...good, messages: [{ role: 'system', content: 'x' }] });
    await writeFile(file, refused);
    assert.equal(await take(), null);
    assert.deepEqual(said.splice(0), ['Copie de reprise illisible : Message de session invalide.']);
    assert.equal(await readFile(aside, 'utf8'), refused);
    await assert.rejects(access(file), { code: 'ENOENT' });
    assert.equal(await take(), null);
    assert.deepEqual(said, []);
    // Not JSON at all: the same, in the place of the one put aside before.
    await writeFile(file, '{"messages": [');
    assert.equal(await take(), null);
    assert.equal(await readFile(aside, 'utf8'), '{"messages": [');
    assert.equal(said.splice(0).length, 1);
    // The disk does not give it for now: said, and left where it is for the reading that follows.
    await writeFile(file, JSON.stringify(good));
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    const refusing = async () => {
      throw busy;
    };
    assert.equal(await take({ read: refusing }), null);
    assert.deepEqual(said.splice(0), ['Copie de reprise illisible : EBUSY: resource busy or locked']);
    assert.equal((await take()).prompt, 'brouillon');
    assert.equal(await readFile(aside, 'utf8'), '{"messages": [');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the page goes on when the conversation of before cannot be taken back, and says so (0.6.287)', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    from = source.indexOf('async function restoreUpdate()'),
    body = source.slice(from, source.indexOf('/**', from));
  assert.ok(from > 0 && body.length > 200 && body.length < 2000, 'restoreUpdate is found whole in the page');
  const page = routes => {
    const seen = { notices: [], calls: [], restored: [], band: 0, live: { textContent: '' } };
    const context = {
      api: async route => {
        seen.calls.push(route);
        if (routes[route] instanceof Error) throw routes[route];
        return { json: async () => routes[route] };
      },
      restoreAside: aside => seen.restored.push('aside ' + aside.prompt),
      restoreSession: saved => seen.restored.push('session ' + saved.prompt),
      notice: text => seen.notices.push(text),
      returnBand: () => seen.band++,
      $: () => seen.live,
    };
    runInNewContext(body, context);
    return { seen, restore: () => context.restoreUpdate() };
  };
  const kept = { prompt: 'brouillon', aside: { prompt: 'de côté' } };

  // The server could not answer: said, and the start of the page is not cut short (nothing thrown).
  const failing = page({ 'updates/session': new Error('Erreur locale inattendue.') });
  await failing.restore();
  assert.deepEqual(failing.seen.notices, ['Reprise de la conversation interrompue : Erreur locale inattendue.']);
  assert.deepEqual([failing.seen.restored, failing.seen.calls], [[], ['updates/session']]);

  // Taken back, but the copy could not be let go: the conversation is on the page, and it is said.
  const stuck = page({ 'updates/session': kept, 'updates/session/clear': new Error('Disque plein.') });
  await stuck.restore();
  assert.deepEqual(stuck.seen.restored, ['aside de côté', 'session brouillon']);
  assert.deepEqual(stuck.seen.notices, ['Reprise de la conversation interrompue : Disque plein.']);

  // And as before: nothing kept, « Redémarrer », an update that succeeded, one that did not.
  const none = page({ 'updates/session': null });
  await none.restore();
  assert.deepEqual([none.seen.calls, none.seen.notices, none.seen.restored], [['updates/session'], [], []]);
  const restarted = page({ 'updates/session': { ...kept, restarted: true }, 'updates/session/clear': {} });
  await restarted.restore();
  assert.equal(restarted.seen.live.textContent, 'Application redémarrée. Conversation restaurée.');
  assert.deepEqual(restarted.seen.calls, ['updates/session', 'updates/session/clear']);
  const updated = page({ 'updates/session': kept, 'updates/session/clear': {}, 'updates/install': { state: 'done' } });
  await updated.restore();
  assert.deepEqual([updated.seen.band, updated.seen.notices], [1, []]);
  const back = page({
    'updates/session': kept,
    'updates/session/clear': {},
    'updates/install': { state: 'rolled-back', error: 'La version précédente a été restaurée.' },
  });
  await back.restore();
  assert.deepEqual([back.seen.band, back.seen.notices], [0, ['La version précédente a été restaurée.']]);
});

test('a restart that never happened gives up the copy it kept for the page (0.6.357)', async () => {
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    from = source.indexOf('async function restartApplication('),
    body = source.slice(from, source.indexOf('\n}\n', from) + 3);
  assert.ok(from > 0 && body.length > 800 && body.length < 4000, 'restartApplication is found whole in the page');
  // `answers`: what /api/bootstrap says at each look (a token, or nothing: no instance answers then).
  const page = answers => {
    const seen = { calls: [], notices: [], reloaded: 0, looks: 0 },
      node = { textContent: '', hidden: false, dataset: {}, disabled: false, close() {}, showModal() {} };
    let now = 0;
    const context = {
      state: { token: 'jeton-a', closingApp: false },
      $: () => node,
      settingsGuard: { isDirty: () => false },
      updateControls() {},
      persistConversation: async () => true,
      historyWrite: Promise.resolve(),
      compactSession: value => value,
      sessionOfPage: () => ({ prompt: 'brouillon' }),
      api: async route => {
        seen.calls.push(route);
        return { json: async () => ({}) };
      },
      notice: text => seen.notices.push(text),
      location: { reload: () => seen.reloaded++ },
      // Each wait of the page is 30 s of its clock: four looks before its two minutes are over.
      setTimeout: done => {
        now += 30000;
        done();
      },
      Date: { now: () => now },
      AbortSignal,
      fetch: async () => {
        const token = answers[Math.min(seen.looks++, answers.length - 1)];
        if (!token) throw new TypeError('fetch failed');
        return { json: async () => ({ token }) };
      },
    };
    runInNewContext(body, context);
    return { seen, restart: () => context.restartApplication() };
  };
  // The launcher was refused, or gave up: the same instance answers to the end. Its copy stayed, and the next
  // loading of the page took back an older conversation, « Application redémarrée. Conversation restaurée. ».
  const stayed = page(['jeton-a']);
  await stayed.restart();
  assert.deepEqual(stayed.seen.calls, ['relaunch', 'updates/session/clear']);
  assert.deepEqual([stayed.seen.reloaded, stayed.seen.notices.length], [0, 1]);
  assert.match(stayed.seen.notices[0], /^Redémarrage non confirmé/);
  // It left and nothing came back: no instance to ask, and its copy is what the next one gives the page.
  const gone = page(['jeton-a', null]);
  await gone.restart();
  assert.deepEqual(gone.seen.calls, ['relaunch']);
  assert.match(gone.seen.notices[0], /^Redémarrage non confirmé/);
  // Started again: the page loads again from the new instance, which holds the copy.
  const back = page(['jeton-a', null, 'jeton-b']);
  await back.restart();
  assert.deepEqual([back.seen.calls, back.seen.reloaded, back.seen.notices], [['relaunch'], 1, []]);
});
