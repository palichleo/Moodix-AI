import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_WORDS,
  Dictation,
  MAX_SECONDS,
  MODEL,
  PROJECTOR,
  UNAVAILABLE,
  batchThreads,
  defaultThreads,
  dictationSettings,
  vocabulary,
  wavSeconds,
} from '../lib/dictation.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-dictation-engine.mjs', import.meta.url));
const PROGRAM = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const GGUF = Buffer.from('GGUF\x03\0\0\0');
/** llama-server, as the fake engine plays it; `command` says which build was launched. */
const playing = (env = {}) => (command, args, options) =>
  spawn(process.execPath, [fixture, ...args], { ...options, env: { ...options.env, ...env, FAKE_COMMAND: command } });

/** A WAV as the page makes it: PCM 16 bits, mono, 16 kHz, `seconds` of silence. */
function wav(seconds, { rate = 16000, channels = 1, bits = 16 } = {}) {
  const data = Math.round(seconds * rate) * channels * (bits / 8),
    bytes = Buffer.alloc(44 + data);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(36 + data, 4);
  bytes.write('WAVE', 8, 'latin1');
  bytes.write('fmt ', 12, 'latin1');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * (bits / 8), 28);
  bytes.writeUInt16LE(channels * (bits / 8), 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write('data', 36, 'latin1');
  bytes.writeUInt32LE(data, 40);
  return bytes;
}

async function program(folder) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, PROGRAM), 'engine', { mode: 0o700 });
}

/** A dictation in a folder of its own: its model and its build here unless told otherwise. */
async function setup(t, { model = true, own = true, card = false, env = {}, ...options } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodix-dictation-'));
  const dataDir = join(root, 'data'),
    modelsDir = join(root, 'models');
  if (model) {
    await mkdir(join(modelsDir, 'dictation'), { recursive: true });
    for (const file of [MODEL, PROJECTOR]) await writeFile(join(modelsDir, 'dictation', file), GGUF);
  }
  if (own) await program(join(dataDir, 'engines', 'dictation', 'b200-cpu'));
  if (card) await program(join(dataDir, 'engines', 'llama.cpp', 'b150-cuda-13.4'));
  const dictation = await new Dictation({
    dataDir,
    modelsDir,
    catalogPath: join(root, 'no-catalog.json'),
    chatBuilds: { root: join(dataDir, 'engines', 'llama.cpp') },
    spawnProcess: playing(env),
    threads: 6,
    threadsBatch: 10,
    ...options,
  }).load();
  t.after(async () => {
    await dictation.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, modelsDir, dictation };
}

const said = (dictation, what) =>
  dictation.engine.logs.filter(line => line.startsWith(what + ' : ')).map(line => JSON.parse(line.slice(what.length + 3)));

test('the words to expect: the user’s first, then the names of the models and of the LoRAs, each once', () => {
  assert.equal(
    vocabulary('Moodix, Moodix AI,  LoRA ;prompt\n4K', [
      'LTX 2.5',
      'moodix',
      'styles/pixel_art_v2.safetensors',
      'a3f9c2e1b4d5e6f7.safetensors',
      '1234.safetensors',
      'Wan 2.2',
    ]),
    'Moodix, Moodix AI, LoRA, prompt, 4K, LTX 2.5, pixel art v2, Wan 2.2',
  );
  // A few dozen words, read again at every dictation: what passes 400 characters is left out.
  const many = Array.from({ length: 80 }, (_, index) => `Modèle ${index}`);
  const text = vocabulary('', many);
  assert.ok(text.length <= 400 && text.startsWith('Modèle 0, Modèle 1'), text.length);
  assert.equal(vocabulary(DEFAULT_WORDS), 'Moodix, Moodix AI, LoRA, prompt, 4K');
});

test('a WAV is taken only as the page makes it, and its length is read from it', () => {
  assert.equal(wavSeconds(wav(1.5)), 1.5);
  for (const other of [wav(1, { rate: 44100 }), wav(1, { channels: 2 }), wav(1, { bits: 8 }), Buffer.from('pas un son')])
    assert.throws(() => wavSeconds(other), error => error.status === 415 && /WAV PCM 16 bits, mono, 16 kHz/.test(error.message));
});

test('the settings keep what is valid, and the threads are those of the measures', () => {
  assert.deepEqual(dictationSettings({ language: 'de', place: 'cloud', words: 7 }), {
    language: 'fr',
    place: 'cpu',
    words: DEFAULT_WORDS,
  });
  assert.deepEqual(dictationSettings({ language: 'auto', place: 'gpu', words: 'a\r\nb' }).words, 'a\nb');
  assert.equal(dictationSettings({ words: 'x'.repeat(5000) }).words.length, 2000);
  assert.deepEqual([defaultThreads(32), defaultThreads(8), defaultThreads(1)], [8, 4, 1]);
  // Those that read: 14 of the 20 of the processor measured, never fewer than those that write.
  assert.deepEqual([batchThreads(20), batchThreads(32), batchThreads(8), batchThreads(2), batchThreads(1)], [14, 22, 6, 1, 1]);
});

test('a dictation is written by its own engine on the processor, told the words to expect', async t => {
  const { dictation } = await setup(t, { names: async () => ['LTX 2.5', 'styles/pixel_art.safetensors'] });
  await dictation.save({ language: 'fr', words: 'Moodix, Bobine' });
  const first = await dictation.transcribe(wav(1.5));
  // The marks of Qwen3-ASR and the spaces around are left out.
  assert.equal(first.text, 'Un chat roux sur un toit.');
  assert.equal(first.seconds, 1.5);
  const [launched] = said(dictation, 'Lancé');
  assert.match(launched.command, /b200-cpu/);
  assert.deepEqual(
    {
      threads: launched.threads,
      threadsBatch: launched.threadsBatch,
      layers: launched.layers,
      context: launched.context,
      offload: launched.offload,
      cacheRam: launched.cacheRam,
    },
    // No cache of the prompts already read (0.6.453): every sound is new.
    { threads: '6', threadsBatch: '10', layers: '0', context: '4096', offload: false, cacheRam: '0' },
  );
  assert.equal(basename(launched.projector), PROJECTOR);
  assert.deepEqual(said(dictation, 'Reçu')[0], {
    model: 'dictation',
    format: 'json',
    language: 'fr',
    prompt: 'Moodix, Bobine, LTX 2.5, pixel art',
    bytes: 44 + 48000,
    type: 'audio/wav',
  });
  // The next one: the same engine, already started.
  await dictation.save({ language: 'auto' });
  await dictation.transcribe(wav(1));
  assert.equal(said(dictation, 'Lancé').length, 1);
  assert.equal(said(dictation, 'Reçu')[1].language, null, 'Automatique: the model finds the language');
});

test('nothing said, too long or not a sound: answered without the engine', async t => {
  const { dictation } = await setup(t);
  assert.deepEqual(await dictation.transcribe(wav(0.2)), { text: '', seconds: 0.2 });
  await assert.rejects(dictation.transcribe(wav(MAX_SECONDS + 2)), error => error.status === 413);
  await assert.rejects(dictation.transcribe(Buffer.from('RIFF')), error => error.status === 415);
  assert.equal(dictation.engine.state, 'stopped');
});

test('without its model, the dictation says where to install it', async t => {
  const { dictation } = await setup(t, { model: false });
  const status = await dictation.status();
  assert.equal(status.installed, false);
  await assert.rejects(dictation.transcribe(wav(1)), error => error.status === 409 && error.message === UNAVAILABLE);
  assert.equal(dictation.engine.state, 'stopped');
});

test('on the card: the build of the chat made for it, left to a generation, the processor meanwhile', async t => {
  let busy = false;
  const { dictation } = await setup(t, { card: true, cardBusy: () => busy });
  assert.deepEqual((await dictation.status()).card, { available: true, label: 'CUDA 13.4' });
  await dictation.save({ place: 'gpu' });
  await dictation.transcribe(wav(1));
  let [launched] = said(dictation, 'Lancé');
  assert.match(launched.command, /b150-cuda-13\.4/);
  assert.equal(launched.layers, '999');
  assert.equal(launched.offload, true);
  assert.equal(launched.cacheRam, '0', 'on the card too, no prompt kept in memory');
  assert.equal((await dictation.status()).engine.place, 'gpu');
  // A generation starts: the card is given back.
  busy = true;
  assert.equal(await dictation.release(), true);
  assert.equal(dictation.engine.state, 'stopped');
  // Meanwhile, the processor, said in the settings.
  await dictation.transcribe(wav(1));
  [launched] = said(dictation, 'Lancé');
  assert.match(launched.command, /b200-cpu/);
  assert.equal(launched.layers, '0');
  const status = await dictation.status();
  assert.equal(status.engine.place, 'cpu');
  assert.match(status.engine.note, /génération occupe la carte graphique/);
  assert.equal(await dictation.release(), false, 'nothing to give back from the processor');
});

test('a card that refuses the model: the processor takes the dictation, and the card is not asked again at once', async t => {
  const { dictation } = await setup(t, { card: true, env: { FAKE_REFUSE: '1' } });
  await dictation.save({ place: 'gpu' });
  assert.equal((await dictation.transcribe(wav(1))).text, 'Un chat roux sur un toit.');
  const status = await dictation.status();
  assert.equal(status.engine.place, 'cpu');
  assert.equal(
    status.engine.note,
    'La carte graphique n’a pas pu prendre la dictée (error loading model: cudaMalloc failed: out of memory) : elle tourne sur le processeur.',
  );
  await dictation.transcribe(wav(1));
  assert.equal(said(dictation, 'Lancé').length, 1, 'the next dictation stays on the processor');
});

test('without a build for the card, « Carte graphique » says where to install one', async t => {
  const { dictation } = await setup(t);
  const { card } = await dictation.status();
  assert.equal(card.available, false);
  assert.match(card.reason, /Paramètres › Mise à jour › Composants/);
  await dictation.save({ place: 'gpu' });
  await dictation.transcribe(wav(1));
  assert.match(said(dictation, 'Lancé')[0].command, /b200-cpu/);
});

test('the settings are kept; asked elsewhere, the engine stops; five minutes after, it stops', async t => {
  const { dictation, dataDir } = await setup(t, { card: true, idleMs: 150 });
  await dictation.transcribe(wav(1));
  assert.equal(dictation.engine.state, 'ready');
  await dictation.save({ place: 'gpu', words: 'Moodix' });
  assert.equal(dictation.engine.state, 'stopped', 'started on the processor, it stops for the card');
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'dictation.json'), 'utf8')), {
    language: 'fr',
    place: 'gpu',
    words: 'Moodix',
  });
  await dictation.save({ language: 'xx' });
  assert.equal(dictation.settings.language, 'fr', 'what is not valid leaves the setting as it was');
  const again = await new Dictation({ dataDir, modelsDir: join(dataDir, '..', 'models'), catalogPath: '' }).load();
  assert.deepEqual(again.settings, { language: 'fr', place: 'gpu', words: 'Moodix' });
  await dictation.transcribe(wav(1));
  assert.equal(dictation.engine.state, 'ready');
  await delay(600);
  assert.equal(dictation.engine.state, 'stopped', 'rested, the engine gives its memory back');
});

test('a click on the microphone starts the engine while the user speaks', async t => {
  const { dictation } = await setup(t);
  dictation.warm();
  for (let turn = 0; turn < 100 && dictation.engine.state !== 'ready'; turn++) await delay(20);
  assert.equal(dictation.engine.state, 'ready');
  await dictation.transcribe(wav(1));
  assert.equal(said(dictation, 'Lancé').length, 1, 'the dictation finds it started');
});

test('a dictation given up by the page stops there', async t => {
  const { dictation } = await setup(t, { env: { FAKE_DELAY: '2000' } });
  dictation.warm();
  for (let turn = 0; turn < 100 && dictation.engine.state !== 'ready'; turn++) await delay(20);
  const controller = new AbortController();
  const asked = dictation.transcribe(wav(1), { signal: controller.signal });
  await delay(100);
  controller.abort();
  await assert.rejects(asked, error => error.status === 499);
});

test('« Télécharger » fetches its build of llama.cpp then the two files of its model; « Retirer » takes them away', async t => {
  const content = { [MODEL]: Buffer.from('GGUF model of the dictation'), [PROJECTOR]: Buffer.from('GGUF projector') };
  const root = await mkdtemp(join(tmpdir(), 'moodix-dictation-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'),
    modelsDir = join(root, 'models'),
    catalogPath = join(root, 'downloads.json');
  const source = file => ({
    repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF',
    revision: 'abc',
    path: file,
    size: content[file].length,
    sha256: createHash('sha256').update(content[file]).digest('hex'),
    license: { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html' },
  });
  await writeFile(catalogPath, JSON.stringify({ [MODEL]: source(MODEL), [PROJECTOR]: source(PROJECTOR) }));
  const fetched = [];
  const builds = {
    root: join(dataDir, 'engines', 'dictation'),
    job: { state: 'idle' },
    status() {
      return this.job;
    },
    cancel() {},
    async install({ inUse }) {
      assert.equal(inUse, '');
      await program(join(this.root, 'b300-cpu'));
      this.job = { state: 'done', total: 25, received: 25 };
      return { enginePath: join(this.root, 'b300-cpu', PROGRAM), tag: 'b300', id: 'cpu' };
    },
  };
  const dictation = await new Dictation({
    dataDir,
    modelsDir,
    catalogPath,
    builds,
    fetchImpl: async url => {
      fetched.push(new URL(url).pathname);
      return new Response(content[basename(new URL(url).pathname)]);
    },
  }).load();
  t.after(() => dictation.close());
  let status = await dictation.status();
  assert.equal(status.installed, false);
  assert.deepEqual(status.model, {
    name: 'Qwen3-ASR 1.7B',
    bytes: content[MODEL].length + content[PROJECTOR].length,
    left: content[MODEL].length + content[PROJECTOR].length,
    license: { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html' },
  });
  assert.equal((await dictation.download()).job.state, 'running');
  await assert.rejects(dictation.download(), error => error.status === 409);
  await dictation.task;
  status = await dictation.status();
  assert.equal(status.job.state, 'done');
  assert.equal(status.installed, true);
  assert.deepEqual(fetched.sort(), [
    `/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/abc/${MODEL}`,
    `/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/abc/${PROJECTOR}`,
  ]);
  assert.deepEqual(await readFile(join(modelsDir, 'dictation', MODEL)), content[MODEL]);
  // « Retirer »: its files and its build go, its settings stay.
  await dictation.save({ language: 'en' });
  status = await dictation.remove();
  assert.equal(status.installed, false);
  await assert.rejects(stat(join(modelsDir, 'dictation', MODEL)), { code: 'ENOENT' });
  await assert.rejects(stat(builds.root), { code: 'ENOENT' });
  assert.equal(status.settings.language, 'en');
});

test('the server takes the sound as the page sends it, and its settings', async t => {
  const { createApplication } = await import('../server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'moodix-dictation-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'),
    modelsDir = join(root, 'models');
  await mkdir(join(modelsDir, 'dictation'), { recursive: true });
  for (const file of [MODEL, PROJECTOR]) await writeFile(join(modelsDir, 'dictation', file), GGUF);
  await program(join(dataDir, 'engines', 'dictation', 'b200-cpu'));
  const app = await createApplication({ port: 0, dataDir, modelsDir, spawnProcess: playing() });
  t.after(() => app.close());
  const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
  const headers = { Authorization: 'Bearer ' + token };
  const json = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const status = await (await fetch(app.url + '/api/dictation', { headers })).json();
  assert.equal(status.installed, true);
  assert.equal(status.maxSeconds, MAX_SECONDS);
  assert.equal((await (await json('dictation/settings', { language: 'en' })).json()).settings.language, 'en');
  assert.equal((await json('dictation/warm', {})).status, 202);
  const answer = await fetch(app.url + '/api/dictation/transcribe', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'audio/wav' },
    body: wav(1),
  });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).text, 'Un chat roux sur un toit.');
  const refused = await fetch(app.url + '/api/dictation/transcribe', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'audio/wav' },
    body: wav(1, { rate: 48000 }),
  });
  assert.equal(refused.status, 415);
});
