import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server.mjs';

test('install requires authentication and available version, then reserves mutations and closes only after preparation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-api-'));
  let app,
    release,
    committed = false,
    prepared = false;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: {
        prepare: async ({ version, port }) => {
          assert.equal(version, '0.3.0');
          assert.ok(port > 0);
          prepared = true;
          await gate;
          return {};
        },
        launch: async () => ({
          commit: async () => {
            committed = true;
          },
          abort() {},
        }),
      },
    });
    const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body, token = bootstrap.token) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const session = {
      messages: [
        { role: 'user', content: 'Local conversation' },
        { role: 'assistant', content: 'Reply' },
      ],
      conversationId: 'a1111111-1111-4111-8111-111111111111',
      prompt: 'draft',
      images: [],
      thinking: true,
      title: 'Local conversation',
    };
    assert.equal((await call('updates/install', { session }, '')).status, 401);
    const accepted = await call('updates/install', { session });
    assert.equal(accepted.status, 202);
    assert.equal(committed, false);
    const status = await (await call('updates/install')).json();
    assert.equal(status.state, 'preparing');
    for (let i = 0; !prepared && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(prepared, true);
    for (const route of ['start', 'history/clear', 'updates/install'])
      assert.equal((await call(route, {})).status, 409);
    const stored = JSON.parse(await readFile(join(dataDir, 'update-session.json'), 'utf8'));
    assert.equal(stored.prompt, 'draft');
    assert.deepEqual(stored.messages, session.messages);
    release();
    const deadline = Date.now() + 5000;
    while (!committed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(committed, true);
    await app.close();
    app = null;
    app = await createApplication({ port: 0, dataDir });
    const next = await (await fetch(app.url + '/api/bootstrap')).json();
    const headers = { Authorization: `Bearer ${next.token}`, 'Content-Type': 'application/json' };
    assert.equal((await (await fetch(app.url + '/api/updates/session', { headers })).json()).prompt, 'draft');
    assert.equal(
      (await fetch(app.url + '/api/updates/session/clear', { method: 'POST', headers, body: '{}' })).status,
      200,
    );
    assert.equal(await (await fetch(app.url + '/api/updates/session', { headers })).json(), null);
  } finally {
    release();
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a failed download keeps the old app available and can be retried, without deleting history', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-api-'));
  let app;
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      updateChecker: async () => ({ available: true, version: '0.3.0' }),
      updateInstaller: {
        prepare: async () => {
          throw new Error('Network unavailable');
        },
      },
    });
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const call = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal(
      (
        await call('updates/install', {
          session: { messages: [], prompt: '', images: [], conversationId: null, title: '', thinking: false },
        })
      ).status,
      202,
    );
    let state;
    for (let i = 0; i < 50; i++) {
      state = await (await call('updates/install')).json();
      if (state.state === 'error') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(state.state, 'error');
    assert.match(state.error, /Network/);
    assert.equal((await call('status')).status, 200);
    assert.equal((await call('preferences', { theme: 'light' })).status, 200);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  'a valid near-limit conversation plus an image draft fits the bounded update checkpoint',
  { timeout: 15000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-large-'));
    let app, release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    try {
      app = await createApplication({
        port: 0,
        dataDir,
        updateChecker: async () => ({ available: true, version: '0.3.0' }),
        updateInstaller: {
          prepare: async () => {
            await gate;
            throw Error('Fixture download stopped');
          },
        },
      });
      const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
      const messages = Array.from({ length: 90 }, () => ({ role: 'user', content: 'x'.repeat(200000) }));
      const session = {
        messages,
        conversationId: null,
        prompt: 'Image draft',
        images: [{ name: 'draft.jpg', url: 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024) }],
        title: 'Large',
        thinking: false,
      };
      const body = JSON.stringify({ session });
      assert.ok(Buffer.byteLength(body) > 20 * 1024 * 1024);
      const response = await fetch(app.url + '/api/updates/install', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(response.status, 202);
    } finally {
      release();
      await app?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test('a copy kept for the page that this version refuses stops neither the launch nor the page (0.6.287)', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-refused-'));
  const file = join(dataDir, 'update-session.json'),
    aside = join(dataDir, 'update-session.rejected.json'),
    good = {
      messages: [{ role: 'user', content: 'un renard' }],
      conversationId: null,
      prompt: 'brouillon',
      images: [],
      title: 'Renard',
      thinking: false,
    };
  let app;
  const session = async () => {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const answer = await fetch(app.url + '/api/updates/session', { headers: { Authorization: 'Bearer ' + token } });
    return [answer.status, await answer.json()];
  };
  const errors = console.error;
  console.error = () => {};
  try {
    // Takes this version refuses among those kept, or no list at all: the launch itself stopped there.
    for (const gallery of [[{ take: 0 }, 'x'], { 0: 'x' }]) {
      await writeFile(file, JSON.stringify({ ...good, gallery }));
      app = await createApplication({ port: 0, dataDir });
      const [status, kept] = await session();
      assert.deepEqual([status, kept.prompt], [200, 'brouillon']);
      await app.close();
      app = null;
    }
    // The copy itself refused: put aside at the launch, and the page that asks is answered.
    const refused = JSON.stringify({ ...good, messages: [{ role: 'system', content: 'x' }] });
    await writeFile(file, refused);
    app = await createApplication({ port: 0, dataDir });
    assert.deepEqual(await session(), [200, null]);
    assert.equal(await readFile(aside, 'utf8'), refused);
    // One that comes while the application runs: answered the same, never a 500 at every page.
    await writeFile(file, '{"messages": [');
    assert.deepEqual(await session(), [200, null]);
    assert.deepEqual(await session(), [200, null]);
    assert.equal(await readFile(aside, 'utf8'), '{"messages": [');
  } finally {
    console.error = errors;
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('the application removes the folders of the updates before when it starts (0.6.392)', async () => {
  const { mkdir, readdir, utimes } = await import('node:fs/promises');
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-folders-')),
    updates = join(dataDir, 'updates');
  for (const [name, age] of [
    ['install-old111', 2000],
    ['install-new222', 1000],
  ]) {
    await mkdir(join(updates, name, 'backup'), { recursive: true });
    await writeFile(join(updates, name, 'restart.log'), 'journal');
    const at = new Date(Date.now() - age * 1000);
    await utimes(join(updates, name), at, at);
  }
  const app = await createApplication({ port: 0, dataDir });
  try {
    // Not waited for by the start: it comes a moment later.
    const deadline = Date.now() + 5000;
    while ((await readdir(updates)).length > 1 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(await readdir(updates), ['install-new222']);
    assert.equal(await readFile(join(updates, 'install-new222', 'restart.log'), 'utf8'), 'journal');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});


test('a request too large is refused with the limit of its own route (0.6.399)', async () => {
  // « La requête dépasse 20 Mo » was said of the session kept for an update too, whose limit is 40.
  const http = await import('node:http');
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-update-size-')),
    app = await createApplication({ port: 0, dataDir });
  try {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json(),
      { hostname, port } = new URL(app.url);
    // Refused on what it announces, before a byte of it is read.
    const refused = (route, megabytes) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            hostname,
            port,
            path: '/api/' + route,
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + token,
              'Content-Type': 'application/json',
              'Content-Length': megabytes * 1024 * 1024 + 1,
            },
          },
          response => {
            let text = '';
            response.on('data', chunk => (text += chunk));
            response.on('end', () => (request.destroy(), resolve([response.statusCode, JSON.parse(text).error])));
          },
        );
        request.on('error', reject);
        request.write('{');
      });
    const [status, said] = await refused('updates/install', 40);
    assert.equal(status, 413);
    assert.match(said, /^La requête dépasse 40 Mo\. /);
    assert.deepEqual(await refused('history/save', 20), [
      413,
      'La requête dépasse 20 Mo. Réduisez le nombre d’images ou commencez une nouvelle conversation.',
    ]);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
