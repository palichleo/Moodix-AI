import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { LlamaBuilds } from '../lib/llama-builds.mjs';

const fakeEngine = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));

/**
 * An application whose installation of llama.cpp is in the hands of the test: `install()` ends when
 * `finish()` is called, with the build of `enginePath`. `spawnProcess`: what the engine of the chat model is.
 */
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'llama-busy-')),
    folder = join(root, 'engines', 'llama.cpp', 'b12110-cuda-13.4'),
    enginePath = join(folder, 'llama-server.exe'),
    fake = new LlamaBuilds({ root: join(root, 'engines', 'llama.cpp') }),
    started = [],
    prepared = [];
  await mkdir(folder, { recursive: true });
  await writeFile(enginePath, 'exe');
  let finish;
  fake.install = () => {
    fake.job = { state: 'downloading', step: 'Téléchargement de llama.cpp b12110 (CUDA 13.4)…', tried: [] };
    return new Promise(resolve => {
      finish = () => {
        const result = { enginePath, tag: 'b12110', id: 'cuda-13.4', label: 'CUDA 13.4', devices: [] };
        fake.job = { state: 'done', step: '', tried: [], result };
        resolve(result);
      };
    });
  };
  const app = await createApplication({
    port: 0,
    dataDir: root,
    llamaBuilds: fake,
    launcher: target => started.push(target),
    updateChecker: async () => ({ available: true, version: '9.9.9' }),
    updateInstaller: {
      prepare: async () => {
        prepared.push(true);
        throw new Error('The test never installs an update.');
      },
      launch: async () => ({ commit: async () => {}, abort() {} }),
    },
    ...options,
  });
  const boot = await (await fetch(app.url + '/api/bootstrap')).json(),
    api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + boot.token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    until = async (check, label = 'nothing came in time') => {
      for (let turn = 0; turn < 240; turn++) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail(label);
    },
    // (No file of the settings: nothing was ever written.)
    setting = async () => JSON.parse(await readFile(join(root, 'config.json'), 'utf8').catch(() => '{}')).enginePath;
  return { root, app, boot, api, until, setting, enginePath, started, prepared, finish: () => finish?.() };
}

const session = { messages: [], conversationId: null, prompt: '', images: [], thinking: true, title: 'Essai' };

test('an installation of llama.cpp under way refuses a relaunch, a closing « if idle » and an update, by its name (0.6.389)', async () => {
  // Left to go on, the instance closed by an update went on downloading, then wrote its copy of the settings
  // over those of the new version.
  const { root, app, boot, api, until, started, prepared, finish } = await fixture();
  try {
    assert.equal((await api('llama/install', {})).status, 202);
    const refused = async (route, body) => {
      const response = await api(route, body);
      return [response.status, await response.json()];
    };
    const named = /^Attendez la fin de l’installation de llama\.cpp avant /;
    let [status, said] = await refused('relaunch', { always: true });
    assert.equal(status, 409);
    assert.match(said.error, named);
    assert.match(said.error, /avant de relancer l’application\.$/);
    assert.deepEqual(started, []);
    const idle = { onlyIfIdle: true, installationId: boot.installationId, sourceRevision: boot.sourceRevision };
    [status, said] = await refused('shutdown', idle);
    assert.equal(status, 409);
    assert.match(said.error, named);
    // Still there, and still answering.
    assert.equal((await (await fetch(app.url + '/api/bootstrap?brief=1')).json()).token, boot.token);
    // The update: the page keeps the click and asks again (`busy`), as for anything that ends by itself.
    [status, said] = await refused('updates/install', { session });
    assert.equal(status, 409);
    assert.equal(said.error, 'Attendez la fin de l’installation de llama.cpp avant la mise à jour.');
    assert.equal(said.busy, true);
    assert.deepEqual(prepared, []);
    // Once it is installed and in service, nothing is refused any more.
    finish();
    await until(async () => (await (await api('llama')).json()).used, 'the build was never put in service');
    assert.equal((await api('relaunch', { always: true })).status, 202);
    assert.equal(started.length, 1);
  } finally {
    // (Whatever failed: the installation ends, or the closing would wait for it.)
    finish();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('stopping the application does not wait for a build of llama.cpp that waits for the model (0.6.389)', async () => {
  // Installed while the model was busy, the build waits for it to be free (15 minutes at most) to be put in
  // service: « Arrêter l'application » waited with it, the port still held, the page saying « arrêtée ».
  const engines = [];
  // A model that never ends loading: the engine stays busy as long as the test wants.
  const spawnProcess = (command, args, options) => {
    if (args[0] === '--version') return spawn(process.execPath, [fakeEngine, ...args], options);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    engines.push(child);
    return child;
  };
  const { root, app, api, until, setting, enginePath, finish } = await fixture({ spawnProcess });
  let closed;
  try {
    const modelPath = join(root, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    const settings = { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 4096 };
    assert.equal((await api('config', { ...settings, maxOutputTokens: 1024, gpuLayers: 0 })).status, 200);
    assert.equal((await api('start', {})).status, 202);
    await until(async () => (await (await api('status')).json()).state === 'loading');
    assert.equal((await api('llama/install', {})).status, 202);
    finish();
    await until(async () => (await (await api('llama')).json()).state === 'switching', 'never waited for the model');
    const before = Date.now();
    closed = app.close();
    const done = await Promise.race([
      closed.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 6000)),
    ]);
    assert.equal(done, true, 'the application was still waiting after 6 s');
    assert.ok(Date.now() - before < 6000);
    // Nothing put in service, nothing written: the engine of the settings is the one of before.
    assert.equal(await setting(), process.execPath);
    assert.notEqual(await setting(), enginePath);
  } finally {
    // (Whatever failed: the model « freed », the application ends.)
    for (const child of engines) child.kill();
    finish();
    await (closed ?? app.close());
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('a build of llama.cpp installed while the application stops is not put in service (0.6.389)', async () => {
  // Stopped, the model is free: the build just installed was put in service all the same, the settings
  // written by an application that was closing.
  const { root, app, api, until, setting, enginePath, finish } = await fixture();
  let closed;
  try {
    assert.equal((await api('llama/install', {})).status, 202);
    await until(async () => (await (await api('llama')).json()).state === 'downloading');
    closed = app.close();
    // The installation ends while the stop waits for it.
    await new Promise(resolve => setTimeout(resolve, 100));
    finish();
    await closed;
    assert.notEqual(await setting(), enginePath);
  } finally {
    finish();
    await (closed ?? app.close());
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});


test('closing while the model loads on a build just installed says nothing against that build (0.6.390)', async () => {
  // Counted as a failure of the build, the engine of before was put back in the settings, and the stop
  // waited for a load that never ended.
  const engines = [];
  let enginePath;
  // The engine of before loads the model; on the build just installed, it never ends loading.
  const spawnProcess = (command, args, options) => {
    if (args[0] === '--version' || command !== enginePath)
      return spawn(process.execPath, [fakeEngine, ...args], options);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
    engines.push(child);
    return child;
  };
  const made = await fixture({ spawnProcess }),
    { root, app, api, until, setting, finish } = made;
  enginePath = made.enginePath;
  let closed;
  try {
    const modelPath = join(root, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    const settings = { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 4096 };
    assert.equal((await api('config', { ...settings, maxOutputTokens: 1024, gpuLayers: 0 })).status, 200);
    assert.equal((await api('start', {})).status, 202);
    await until(async () => (await (await api('status')).json()).state === 'ready', 'the model never loaded');
    assert.equal((await api('llama/install', {})).status, 202);
    finish();
    await until(async () => engines.length && (await (await api('status')).json()).state === 'loading');
    assert.match((await (await api('llama')).json()).step, /^Chargement du modèle sur llama\.cpp b12110/);
    closed = app.close();
    const done = await Promise.race([
      closed.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 6000)),
    ]);
    assert.equal(done, true, 'the application was still waiting for the load after 6 s');
    // The build stays the engine of the settings: it is tried at the next start.
    assert.equal(await setting(), enginePath);
  } finally {
    for (const child of engines) child.kill();
    finish();
    await (closed ?? app.close());
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
