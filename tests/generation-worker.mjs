import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GenerationWorker } from '../lib/generation-worker.mjs';
const fixture = fileURLToPath(new URL('./fixtures/fake-generation-worker.mjs', import.meta.url));
function worker(mode) {
  return new GenerationWorker({
    root: process.cwd(),
    // (0.6.416) Half a second only for the engine that never answers, which a test waits out. One that answers
    // is a program to start: on a busy computer it took longer than that, and its test failed (« Le moteur
    // Python ne répond pas au démarrage. ») once in a while.
    handshakeMs: mode === 'silent' ? 500 : 20000,
    stopMs: 200,
    spawnProcess: (_command, _args, options) =>
      spawn(process.execPath, [fixture], { ...options, env: { ...options.env, TEST_RUNNER_MODE: mode } }),
  });
}
test('worker handshake, typed protocol, progress, release and owned process close', async () => {
  const w = worker();
  try {
    await w.start({ pythonPath: process.execPath, configPath: 'unused' });
    assert.equal(w.status().state, 'ready');
    const progress = [];
    assert.deepEqual(await w.request('generate', { seed: 3 }, { onProgress: p => progress.push(p) }), {
      method: 'generate',
      params: { seed: 3 },
    });
    assert.deepEqual(progress, [{ step: 1, total: 8 }]);
    assert.equal((await w.release()).released, true);
  } finally {
    await w.close();
  }
  assert.equal(w.status().state, 'stopped');
  assert.equal(w.child, null);
});
test('abort kills and reaps only the owned child, and a new worker starts by itself', async () => {
  const w = worker();
  try {
    await w.start({ pythonPath: process.execPath, configPath: 'unused' });
    const old = w.child;
    const controller = new AbortController();
    const request = w.request('hang', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, /arrêt|abort/i);
    assert.ok(old.exitCode !== null || old.signalCode !== null, 'the busy worker is gone');
    // Cancelling was the user's choice, not a failure: generation stays available meanwhile.
    assert.equal(w.status().recovering, true);
    assert.notEqual(w.child, old);
    assert.equal((await w.release()).released, true, 'a starting worker holds no GPU memory');
    await w.start({ pythonPath: process.execPath, configPath: 'unused' });
    await new Promise(setImmediate);
    assert.deepEqual([w.status().state, w.status().recovering], ['ready', false]);
    assert.deepEqual(await w.request('generate', { seed: 1 }), { method: 'generate', params: { seed: 1 } });
  } finally {
    await w.close();
  }
});
test('invalid JSON and startup failures leave diagnostics instead of hanging', async () => {
  for (const mode of ['silent', 'crash']) {
    const w = worker(mode);
    await assert.rejects(w.start({ pythonPath: process.execPath, configPath: 'unused' }));
    await w.close();
    assert.equal(w.child, null);
  }
  const w = worker();
  try {
    await w.start({ pythonPath: process.execPath, configPath: 'unused' });
    await assert.rejects(w.request('bad'), /JSON|protocole/i);
  } finally {
    await w.close();
  }
});

test('closing during handshake cancels startup without a late worker or fallback', async () => {
  const w = worker('silent');
  const starting = w.start({ pythonPath: process.execPath, configPath: 'unused' });
  const rejected = assert.rejects(starting, /fermé|arrêté/);
  await w.close();
  await rejected;
  assert.equal(w.child, null);
  assert.equal(w.status().state, 'stopped');
});

test('a library the worker could not import is said to the application (0.6.110)', async () => {
  const w = worker('libraries'),
    said = [];
  w.onLibrariesFailed = message => said.push(message);
  try {
    await w.start({ pythonPath: process.execPath, configPath: 'unused' });
    // (Said by itself once ready: read before the answer to the next request.)
    await assert.rejects(w.request('refused'), /Invalid job/);
    assert.deepEqual(said, ['torch: DLL load failed'], 'a request refused for another reason says nothing');
    await assert.rejects(w.request('broken'), /No module named/);
    assert.deepEqual(said, ['torch: DLL load failed', "No module named 'diffusers'"]);
    // What the application makes of it never stops the worker from being read.
    w.onLibrariesFailed = () => {
      throw Error('the application failed');
    };
    await assert.rejects(w.request('broken'), /No module named/);
    assert.deepEqual(await w.request('generate', { seed: 1 }), { method: 'generate', params: { seed: 1 } });
  } finally {
    await w.close();
  }
});


// (0.6.429) The line of requests. The fake engine answers one request after the other, as the real one does.
const started = async (mode, more = {}) => {
  const w = Object.assign(worker(mode), more);
  await w.start({ pythonPath: process.execPath, configPath: 'unused' });
  return w;
};
// An answer that must come: a request left in the line for ever would hold the test until its own delay.
const soon = (promise, ms = 8000) => {
  let timer;
  const late = new Promise((_, no) => (timer = setTimeout(() => no(new Error('never answered')), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a request behind a long one waits for its turn: its delay runs from the moment the engine has it (0.6.429)', async () => {
  const w = await started();
  try {
    const child = w.child,
      order = [];
    // A film that takes 700 ms to assemble, then a release that has 250 ms (in the application: 60 s, behind a
    // film of two minutes). Written at once, the release ran out in the pipe and the engine was stopped for
    // it: « Le moteur Python s’est arrêté (SIGTERM) » for the film, « a dépassé le délai » for the release.
    const film = w.request('assemble', { wait: 700 }, { timeoutMs: 5000 }).then(result => (order.push('film'), result));
    const released = w.release({ timeoutMs: 250 }).then(result => (order.push('release'), result));
    assert.equal((await released).released, true);
    assert.equal((await film).method, 'assemble');
    assert.deepEqual(order, ['film', 'release']);
    assert.equal(w.child, child, 'the engine was not stopped');
    // Once it is its turn its delay holds: out of time, the engine is stopped as before.
    await assert.rejects(w.request('preflight', { wait: 2000 }, { timeoutMs: 100 }), /dépassé le délai/);
    assert.notEqual(w.child, child);
  } finally {
    await w.close();
  }
});

test('a film being assembled is a task of the engine: no creation starts behind it (0.6.429)', async () => {
  const w = await started();
  try {
    assert.equal(w.status().busy, false);
    const film = w.request('assemble', { wait: 300 }, { timeoutMs: 5000 });
    // What the Studio and the Chat ask before a creation (tool-runtime: « Le moteur de génération exécute
    // déjà une tâche »): « free » was answered during a film, and the creation went behind it.
    assert.equal(w.status().busy, true);
    await assert.rejects(w.request('generate', {}), /exécute déjà une tâche/);
    await film;
    assert.equal(w.status().busy, false);
    assert.equal((await w.request('generate', { seed: 2 })).method, 'generate');
  } finally {
    await w.close();
  }
});

test('a request cancelled while it waits in the line leaves it: the engine goes on, and never hears of it (0.6.429)', async () => {
  const w = await started();
  try {
    const child = w.child,
      film = w.request('assemble', { wait: 500 }, { timeoutMs: 5000 }),
      controller = new AbortController(),
      check = w.request('preflight', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    // (« Arrêter » during « Vérification du moteur de génération… » behind a film: the film was lost.)
    await assert.rejects(check, /arrêtée/);
    assert.equal((await film).method, 'assemble');
    assert.equal(w.child, child, 'the engine was not stopped');
    assert.deepEqual((await w.request('seen')).seen, ['assemble', 'seen']);
    assert.equal(w.idle(), true);
  } finally {
    await w.close();
  }
});

test('what waited behind a request stopped on purpose is asked of the engine that comes back (0.6.429)', async () => {
  const w = await started();
  try {
    const old = w.child,
      controller = new AbortController(),
      creation = w.request('generate', { wait: 60000 }, { signal: controller.signal }),
      // A film asked while a creation is being made is assembled after it (generation-service, assembleFilm).
      film = w.request('assemble', { wait: 10 }, { timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(creation, /arrêtée/);
    // The creation stopped by the user took the engine with it, and the film was lost with it before.
    assert.equal((await soon(film)).method, 'assemble');
    assert.notEqual(w.child, old);
    // The new engine was asked the film, and never the creation.
    assert.deepEqual((await w.request('seen')).seen, ['assemble', 'seen']);
  } finally {
    await w.close();
  }
});

test('closing answers everything that waited, in the line too (0.6.429)', async () => {
  const w = await started();
  const film = w.request('assemble', { wait: 60000 }, { timeoutMs: 120000 }),
    behind = w.release(),
    answers = Promise.allSettled([film, behind]);
  await w.close();
  assert.deepEqual((await answers).map(answer => answer.status), ['rejected', 'rejected']);
  assert.equal(w.status().busy, false);
  // No engine comes back for them either when the one stopped on purpose cannot start again.
  const lost = await started();
  const controller = new AbortController(),
    creation = lost.request('generate', { wait: 60000 }, { signal: controller.signal }),
    waiting = lost.release();
  lost.spawnProcess = () => {
    throw new Error('python gone');
  };
  controller.abort();
  await assert.rejects(creation, /arrêtée/);
  await assert.rejects(soon(waiting), /python gone|introuvable|indisponible/i);
  await lost.close();
  // Nor when the engine stops by itself: nothing asks the line of an engine nobody is bringing back.
  const dead = await started();
  const dying = dead.request('die'),
    after = dead.release();
  await assert.rejects(soon(dying), /s’est arrêté/);
  await assert.rejects(soon(after), /s’est arrêté/);
  assert.equal(dead.status().recovering, false);
  await dead.close();
});

test(
  'stopping the engine ends the programs it started, as the ffmpeg of a film being assembled (0.6.429)',
  { skip: process.platform !== 'win32' && 'Windows only: elsewhere the engine is ended as before' },
  async () => {
    // (Its stop waits long enough for taskkill here: the 200 ms of the other tests are for an engine alone.)
    const w = await started(undefined, { stopMs: 5000 });
    let pid;
    try {
      const controller = new AbortController(),
        film = w.request('child', { wait: 60000 }, { signal: controller.signal, onProgress: data => (pid = data.pid) });
      for (let tries = 0; !pid && tries < 200; tries++) await new Promise(done => setTimeout(done, 25));
      assert.equal(alive(pid), true, 'the program the engine started is running');
      controller.abort();
      await assert.rejects(film, /arrêtée/);
      for (let tries = 0; alive(pid) && tries < 80; tries++) await new Promise(done => setTimeout(done, 25));
      assert.equal(alive(pid), false, 'ended with the engine');
    } finally {
      if (pid && alive(pid)) process.kill(pid);
      await w.close();
    }
  },
);
