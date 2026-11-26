import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';
import { NativeWorkflowCatalog } from '../lib/native-workflows.mjs';
import { History } from '../lib/history.mjs';

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-settings-validation-'));
  let app;
  try {
    app = await createApplication({
      port: 0,
      dataDir,
      filePicker: async () => null,
      ...options,
    });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
  const api = (route, body) =>
    fetch(`${app.url}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { dataDir, app, initial, api };
}
function pauseMethod(t, prototype, method) {
  const original = prototype[method];
  const arrived = Promise.withResolvers(),
    gate = Promise.withResolvers();
  let paused = false;
  prototype[method] = async function (...args) {
    if (!paused) {
      paused = true;
      arrived.resolve();
      await gate.promise;
    }
    return original.apply(this, args);
  };
  t.after(() => {
    gate.resolve();
    prototype[method] = original;
  });
  return { arrived: arrived.promise, release: gate.resolve };
}

test('settings reject non-object payloads without writes', async t => {
  const { api, dataDir } = await fixture(t);
  for (const body of [null, [], true, 'settings']) {
    await t.test(JSON.stringify(body), async () => {
      const response = await api('settings', body);
      assert.equal(response.status, 400, await response.text());
    });
  }
  await assert.rejects(readFile(join(dataDir, 'generation.json')), { code: 'ENOENT' });
});

// (0.6.277) The descriptions of the former tab Workflows are no longer edited: a page that still
// sends them saves its settings as any other.
test('workflow descriptions sent with the settings are left out', async t => {
  const { initial, api } = await fixture(t);
  const response = await api('settings', {
    config: { ...initial.config, gpuLayers: 7 },
    generation: initial.generation,
    workflowDescriptions: [{ id: 'large', description: 'd'.repeat(2001) }],
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal((await (await api('bootstrap')).json()).config.gpuLayers, 7);
});

test('a pending workflow write excludes concurrent settings, model start and workflow writes', async t => {
  const { initial, api } = await fixture(t);
  // Showing the hidden shipped workflows again, held inside the catalog.
  const barrier = pauseMethod(t, NativeWorkflowCatalog.prototype, 'unhide');
  const pending = api('generation/unhide', {});
  try {
    await barrier.arrived;
    for (const [route, body] of [
      ['settings', { config: initial.config, generation: initial.generation }],
      ['start', {}],
      ['generation/config', initial.generation],
      ['generation/reset', { id: 'other' }],
      ['files/choose', { kind: 'model' }],
    ]) {
      await t.test(route, async () => {
        const response = await api(route, body);
        assert.equal(response.status, 409, await response.text());
      });
    }
  } finally {
    barrier.release();
    assert.equal((await pending).status, 200);
  }
  assert.equal((await api('settings', { config: initial.config, generation: initial.generation })).status, 200);
});

for (const method of ['clear', 'remove'])
  test(`history ${method} excludes changes to history preference until deletion ends`, async t => {
    const { api, dataDir } = await fixture(t);
    const barrier = pauseMethod(t, History.prototype, method);
    const pending = api(`history/${method === 'remove' ? 'delete' : method}`, {
      confirm: true,
      id: '11111111-1111-4111-8111-111111111111',
    });
    try {
      await barrier.arrived;
      const response = await api('preferences', { saveHistory: false });
      assert.equal(response.status, 409, await response.text());
      await assert.rejects(readFile(join(dataDir, 'preferences.json')), { code: 'ENOENT' });
    } finally {
      barrier.release();
      assert.equal((await pending).status, 200);
    }
    assert.equal((await api('preferences', { saveHistory: false })).status, 200);
  });
