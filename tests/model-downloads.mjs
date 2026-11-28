import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDownloads, formatBytes } from '../lib/model-downloads.mjs';
import { GenerationAssets } from '../lib/generation-assets.mjs';
import { held, twice } from './fixtures/held-renames.mjs';

const MODEL = Buffer.from('model weights '.repeat(200)),
  VOCAB = Buffer.from('{"a":1}'),
  sha = data => createHash('sha256').update(data).digest('hex');

// (0.6.506) `statfs` and `deviceOf`: the disks as a test sets them, one disk of `free` bytes otherwise.
async function fixture(t, { catalog, free = 1024 ** 4, onDone = null, engine = null, statfs, deviceOf } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-downloads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const models = join(root, 'models');
  const catalogPath = join(root, 'downloads.json');
  await writeFile(
    catalogPath,
    JSON.stringify(
      catalog ?? {
        'krea2Turbo.safetensors': {
          repo: 'Org/Krea',
          revision: 'abc',
          path: 'diffusion_models/krea2_turbo.safetensors',
          size: MODEL.length,
          sha256: sha(MODEL),
        },
        tokenizer: {
          repo: 'Org/Tokenizer',
          revision: 'def',
          folder: true,
          size: VOCAB.length,
          files: [{ path: 'vocab.json', size: VOCAB.length }],
        },
      },
    ),
  );
  const registered = new Map(),
    requests = [];
  const assets = {
    async resolve(id) {
      if (registered.has(id)) return { path: registered.get(id).path };
      throw new Error(`Asset ${id} not found`);
    },
    async register(asset) {
      registered.set(asset.id, asset);
      return asset;
    },
  };
  const bodies = { 'krea2_turbo.safetensors': MODEL, 'vocab.json': VOCAB };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, headers: options.headers || {} });
    const name = decodeURIComponent(url.split('/').at(-1));
    const body = bodies[name];
    if (!body) return new Response('missing', { status: 404 });
    const range = options.headers?.Range?.match(/^bytes=(\d+)-$/);
    const part = range ? body.subarray(Number(range[1])) : body;
    return new Response(part, { status: range ? 206 : 200 });
  };
  const downloads = new ModelDownloads({
    catalogPath,
    dataDir: root,
    assets,
    folderOf: (family, role) => join(models, role === 'model' ? 'diffusion_models' : 'text_encoders'),
    fetchImpl,
    statfs: statfs ?? (async () => ({ bavail: free, bsize: 1 })),
    ...(deviceOf ? { deviceOf } : {}),
    onDone,
    engine,
  });
  const workflow = {
    id: 'krea',
    name: 'Krea 2',
    pipeline: 'krea2',
    builtin: true,
    ready: false,
    components: {
      model: { policy: 'fixed', asset: 'model-asset', file: 'krea2Turbo.safetensors' },
      tokenizer: { policy: 'fixed', asset: 'tokenizer-asset', file: 'tokenizer' },
    },
  };
  const finish = async () => {
    await downloads.task;
    return downloads.status();
  };
  return { root, models, downloads, workflow, registered, requests, bodies, finish };
}

/**
 * (0.6.479) The engine of a new installation as lib/generation-service.mjs gives it to the downloads, simulated: to
 * prepare until it is, held while `hold` waits (« Arrêter » ends that wait), failing with `fail`.
 */
function engineOf({ bytes = 3000 } = {}) {
  const engine = {
    bytes,
    ready: false,
    hold: null,
    fail: null,
    signals: [],
    needed: async () => !engine.ready,
    prepare: async signal => {
      engine.signals.push(signal);
      if (engine.hold)
        await Promise.race([
          engine.hold,
          new Promise((_, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true })),
        ]);
      if (engine.fail) throw engine.fail;
      engine.ready = true;
    },
    progress: () => 'Préparation du moteur',
  };
  return engine;
}
const preparing = async downloads => {
  for (let tries = 0; tries < 400 && downloads.status().engine !== 'preparing'; tries++)
    await new Promise(next => setTimeout(next, 5));
  return downloads.status();
};

test('(0.6.479) a new installation: one click brings the files, then prepares the engine, its size said', async t => {
  // (27/11) Qwen-Image-Edit downloaded on a new installation, its engine never came: the user chose « Oui, d'un
  // seul clic », the engine prepared by the same « Télécharger », its size said on the button.
  const engine = engineOf(),
    f = await fixture(t, { engine }),
    // Its files all here: the engine is all it lacks.
    whole = { id: 'whole', name: 'Real-ESRGAN', pipeline: 'krea2', builtin: true, ready: false, components: {} };
  const offers = await f.downloads.offers([f.workflow, whole]);
  // `bytes` and `left` stay those of the files (what the Bobine, the chat and the Studio read); the engine beside.
  assert.equal(offers.krea.bytes, MODEL.length + VOCAB.length);
  assert.equal(offers.krea.left, MODEL.length + VOCAB.length);
  assert.deepEqual(offers.krea.engine, { bytes: 3000 });
  assert.deepEqual(
    [offers.whole.files, offers.whole.bytes, offers.whole.left, offers.whole.complete, offers.whole.engine],
    [[], 0, 0, true, { bytes: 3000 }],
  );
  let release;
  engine.hold = new Promise(done => (release = done));
  await f.downloads.start(f.workflow);
  const during = await preparing(f.downloads);
  // The files there and registered first; the bar at their end while the engine is prepared, which says what it does.
  assert.deepEqual(
    [during.state, during.engine, during.current, during.received, during.total],
    ['running', 'preparing', 'Préparation du moteur', MODEL.length + VOCAB.length, MODEL.length + VOCAB.length + 3000],
  );
  assert.deepEqual([...f.registered.keys()].sort(), ['model-asset', 'tokenizer-asset']);
  release();
  const done = await f.finish();
  assert.deepEqual(
    [done.state, done.engine, done.received, done.total],
    ['done', 'ready', done.total, MODEL.length + VOCAB.length + 3000],
  );
  assert.equal(engine.signals.length, 1);
  // Prepared: nothing left to offer, to this model or to the other.
  assert.deepEqual(await f.downloads.offers([f.workflow, whole]), {});
});

test('(0.6.479) an engine already prepared: a download brings its files, and nothing more', async t => {
  const engine = engineOf(),
    f = await fixture(t, { engine });
  engine.ready = true;
  const offers = await f.downloads.offers([f.workflow, { ...f.workflow, id: 'whole', components: {} }]);
  assert.deepEqual(Object.keys(offers), ['krea']);
  assert.equal('engine' in offers.krea, false);
  await f.downloads.start(f.workflow);
  const done = await f.finish();
  assert.deepEqual([done.state, 'engine' in done, done.total], ['done', false, MODEL.length + VOCAB.length]);
  assert.equal(engine.signals.length, 0);
  await assert.rejects(f.downloads.start(f.workflow), /Rien à télécharger/);
});

test('(0.6.479) « Arrêter » stops the engine being prepared; the files stay, the next click prepares it', async t => {
  const engine = engineOf(),
    f = await fixture(t, { engine });
  engine.hold = new Promise(() => {});
  await f.downloads.start(f.workflow);
  await preparing(f.downloads);
  f.downloads.cancel();
  const stopped = await f.finish();
  assert.equal(stopped.state, 'cancelled');
  assert.equal(engine.signals[0].aborted, true, 'the preparation was told to stop');
  assert.deepEqual([...f.registered.keys()].sort(), ['model-asset', 'tokenizer-asset']);
  // What is left: the engine alone, which the same « Télécharger » takes up; no file is fetched again.
  const offer = (await f.downloads.offers([f.workflow])).krea;
  assert.deepEqual([offer.files, offer.bytes, offer.left, offer.engine], [[], 0, 0, { bytes: 3000 }]);
  const fetched = f.requests.length;
  engine.hold = null;
  await f.downloads.start(f.workflow);
  const done = await f.finish();
  assert.deepEqual([done.state, done.engine, done.total], ['done', 'ready', 3000]);
  assert.equal(f.requests.length, fetched);
  assert.equal(engine.signals.length, 2);
});

test('(0.6.479) a preparation of the engine that fails says why, its files kept, and is offered again', async t => {
  const told = [],
    engine = engineOf(),
    f = await fixture(t, { engine, onDone: workflow => told.push(workflow.id) });
  // What uv says: many lines, the first and the last kept.
  engine.fail = new Error(
    'error: Failed to fetch: `https://download.pytorch.org/whl/cu130/torch`\n  x\n  Caused by: reset',
  );
  await f.downloads.start(f.workflow);
  const failed = await f.finish();
  assert.equal(failed.state, 'error');
  assert.equal(
    failed.error,
    'Les fichiers sont là, mais le moteur de génération n’a pas pu être préparé : ' +
      'error: Failed to fetch: `https://download.pytorch.org/whl/cu130/torch` … Caused by: reset',
  );
  assert.deepEqual([...f.registered.keys()].sort(), ['model-asset', 'tokenizer-asset']);
  assert.deepEqual(told, [], 'not told as done: the model cannot be used yet');
  assert.deepEqual((await f.downloads.offers([f.workflow])).krea.engine, { bytes: 3000 });
});

test('(0.6.479) a download over, its files there and registered, is told once; failed or stopped, never', async t => {
  // What the engine of the model starts on (lib/generation-service.mjs): it stayed stopped on a new installation.
  const told = [],
    f = await fixture(t, {
      onDone: workflow => told.push([workflow.id, [...f.registered.keys()].sort().join(' ')]),
    });
  f.bodies['krea2_turbo.safetensors'] = undefined;
  await f.downloads.start(f.workflow);
  assert.equal((await f.finish()).state, 'error');
  f.bodies['krea2_turbo.safetensors'] = MODEL;
  await f.downloads.start(f.workflow);
  assert.equal((await f.finish()).state, 'done');
  assert.deepEqual(told, [['krea', 'model-asset tokenizer-asset']]);
});

test('(0.6.503) the engine being prepared by a download is still offered: its model never left out', async t => {
  // The service says no engine is to prepare while one is (its environment installs, then it starts): the model just
  // downloaded, its files all here, had no offer then, and the Studio read again meanwhile left it out.
  const engine = engineOf(),
    f = await fixture(t, { engine }),
    whole = { id: 'whole', name: 'Real-ESRGAN', pipeline: 'krea2', builtin: true, ready: false, components: {} },
    prepare = engine.prepare;
  let busy = false;
  engine.needed = async () => !engine.ready && !busy;
  engine.prepare = async signal => {
    busy = true;
    try {
      await prepare(signal);
    } finally {
      busy = false;
    }
  };
  let release;
  engine.hold = new Promise(done => (release = done));
  await f.downloads.start(f.workflow);
  await preparing(f.downloads);
  assert.equal(await engine.needed(), false, 'as the service says it meanwhile');
  const during = await f.downloads.offers([f.workflow, whole]);
  // Its files there: the engine alone, as before the click for the other one.
  assert.deepEqual(
    [during.krea.files, during.krea.bytes, during.krea.left, during.krea.complete, during.krea.engine],
    [[], 0, 0, true, { bytes: 3000 }],
  );
  assert.deepEqual(during.whole.engine, { bytes: 3000 });
  // A second click meanwhile waits for it, as any download.
  await assert.rejects(f.downloads.start(whole), /déjà en cours/);
  release();
  assert.equal((await f.finish()).state, 'done');
  assert.deepEqual(await f.downloads.offers([f.workflow, whole]), {});
});

test('(0.6.506) the room the engine takes once prepared is read first, with the files on the same disk', async t => {
  // 27/11: 3,9 Gio in its folder (the cache of uv included) for 2,1 downloaded, which no download read before.
  const GIB = 1024 ** 3,
    room = Math.round(3.9 * GIB),
    // What every download leaves free on a disk.
    margin = 2 * GIB,
    engine = Object.assign(engineOf(), { room }),
    free = { bytes: room + margin + MODEL.length - 1 },
    f = await fixture(t, { engine, statfs: async () => ({ bavail: free.bytes, bsize: 1 }), deviceOf: async () => 7 });
  engine.folder = join(f.root, 'runtime');
  // One disk: the engine counted with the files of the first folder, in the sentence of any lack of room.
  await assert.rejects(f.downloads.start(f.workflow), {
    status: 507,
    message:
      `Pas assez de place dans ${join(f.models, 'diffusion_models')} : 1 Mo à télécharger et 3,9 Go pour ` +
      'installer le moteur de génération, 5,9 Go libres.',
  });
  assert.deepEqual([f.requests, f.downloads.status().state, engine.signals], [[], 'idle', []]);
  free.bytes += 1;
  await f.downloads.start(f.workflow);
  assert.deepEqual([(await f.finish()).state, engine.ready], ['done', true]);
});

test('(0.6.506) the engine on a disk of its own: its room read there, the files of a model here or not', async t => {
  const GIB = 1024 ** 3,
    room = Math.round(3.9 * GIB),
    engine = Object.assign(engineOf(), { room }),
    spare = { bytes: room + 2 * GIB - 1 },
    read = [],
    disks = {
      statfs: async path => {
        read.push(path);
        return { bavail: path.startsWith(f.models) ? 1024 ** 4 : spare.bytes, bsize: 1 };
      },
      deviceOf: async path => (path.startsWith(f.models) ? 'D:' : 'C:'),
    },
    f = await fixture(t, { engine, ...disks }),
    whole = { id: 'whole', name: 'Real-ESRGAN', pipeline: 'krea2', builtin: true, ready: false, components: {} };
  engine.folder = join(f.root, 'runtime');
  // Not there yet on a new installation: its disk read through the folder above it, which nothing makes meanwhile.
  const refused = {
    status: 507,
    message: `Pas assez de place dans ${engine.folder} : 3,9 Go pour installer le moteur de génération, 5,9 Go libres.`,
  };
  await assert.rejects(f.downloads.start(f.workflow), refused);
  await assert.rejects(f.downloads.start(whole), refused);
  assert.deepEqual([f.requests, read.at(-1), engine.signals], [[], f.root, []]);
  await assert.rejects(stat(engine.folder), { code: 'ENOENT' });
  spare.bytes += 1;
  await f.downloads.start(f.workflow);
  assert.deepEqual([(await f.finish()).state, engine.ready], ['done', true]);
  // An engine prepared asks nothing of its disk any more.
  const ready = Object.assign(engineOf(), { room, ready: true }),
    other = await fixture(t, { engine: ready, statfs: async () => ({ bavail: 3 * GIB, bsize: 1 }) });
  ready.folder = join(other.root, 'runtime');
  await other.downloads.start(other.workflow);
  assert.equal((await other.finish()).state, 'done');
});

test('a shipped workflow offers what it lacks, and the files land in their folders, registered for it', async t => {
  const f = await fixture(t);
  const offers = await f.downloads.offers([f.workflow, { ...f.workflow, id: 'mine', builtin: false }]);
  assert.deepEqual(Object.keys(offers), ['krea']);
  assert.equal(offers.krea.bytes, MODEL.length + VOCAB.length);
  assert.equal(offers.krea.complete, true);
  assert.equal(offers.krea.needsToken, false);
  await f.downloads.start(f.workflow);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.equal(done.received, done.total);
  // Under the name of its source, in the folder of its kind; a folder takes its name once complete.
  const model = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors');
  assert.deepEqual(await readFile(model), MODEL);
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'vocab.json')), VOCAB);
  assert.equal(f.registered.get('model-asset').path, model);
  assert.equal(f.registered.get('model-asset').kind, 'model');
  assert.equal(f.registered.get('tokenizer-asset').path, join(f.models, 'text_encoders', 'tokenizer'));
  assert.equal(f.requests[0].url, 'https://huggingface.co/Org/Krea/resolve/abc/diffusion_models/krea2_turbo.safetensors');
  assert.deepEqual(await f.downloads.offers([f.workflow]), {}, 'nothing left to offer');
});

test('a file or a folder just downloaded that Windows holds a moment (an antivirus reading it) takes its name once let go', async t => {
  const f = await fixture(t);
  const model = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors'),
    staged = join(f.models, 'text_encoders', 'tokenizer.download', 'vocab.json'),
    tokenizer = join(f.models, 'text_encoders', 'tokenizer');
  // What the download says while it waits (0.6.87: « 100 % » for that minute, without a word).
  const said = new Set();
  const refused = await held(
    [model, staged, tokenizer],
    async () => {
      await f.downloads.start(f.workflow);
      const done = await f.finish();
      // Before 0.6.85: « error » at the very end, and the whole file read again at the next try.
      assert.equal(done.state, 'done', done.error);
    },
    { onRefused: () => said.add(f.downloads.job.current) },
  );
  assert.deepEqual(refused, twice([model, staged, tokenizer]));
  assert.ok(said.has('krea2_turbo.safetensors : en attente que Windows libère le fichier'), [...said].join(' | '));
  assert.ok(said.has('tokenizer : en attente que Windows libère le dossier'), [...said].join(' | '));
  assert.deepEqual(await readFile(model), MODEL);
  assert.deepEqual(await readFile(join(tokenizer, 'vocab.json')), VOCAB);
  await assert.rejects(stat(model + '.part'));
});

test('a download resumes from its .part file and checks the whole file', async t => {
  const f = await fixture(t);
  const folder = join(f.models, 'diffusion_models');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'krea2_turbo.safetensors.part'), MODEL.subarray(0, 1000));
  await f.downloads.start({ ...f.workflow, components: { model: f.workflow.components.model } });
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.equal(f.requests[0].headers.Range, 'bytes=1000-');
  assert.deepEqual(await readFile(join(folder, 'krea2_turbo.safetensors')), MODEL);
});

test('a folder stopped after one of its files fetches only the others when it starts again', async t => {
  const f = await fixture(t, {
    catalog: {
      tokenizer: {
        repo: 'Org/Tokenizer',
        revision: 'def',
        folder: true,
        size: MODEL.length + VOCAB.length,
        files: [
          { path: 'krea2_turbo.safetensors', size: MODEL.length, sha256: sha(MODEL) },
          { path: 'vocab.json', size: VOCAB.length },
        ],
      },
    },
  });
  const staging = join(f.models, 'text_encoders', 'tokenizer.download');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'krea2_turbo.safetensors'), MODEL);
  await writeFile(join(staging, 'vocab.json.part'), VOCAB.subarray(0, 3));
  const workflow = { ...f.workflow, components: { tokenizer: f.workflow.components.tokenizer } };
  const offer = (await f.downloads.offers([workflow])).krea;
  assert.equal(offer.bytes, MODEL.length + VOCAB.length);
  assert.equal(offer.left, VOCAB.length - 3, 'what a stopped download holds is not counted again');
  const started = await f.downloads.start({ ...f.workflow, components: { tokenizer: f.workflow.components.tokenizer } });
  assert.equal(started.received, MODEL.length + 3);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(
    f.requests.map(request => [request.url.split('/').at(-1), request.headers.Range]),
    [['vocab.json', 'bytes=3-']],
  );
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'krea2_turbo.safetensors')), MODEL);
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'vocab.json')), VOCAB);
});

test('a folder fetched whole but left without its name asks no room for what it already holds', async t => {
  const f = await fixture(t, {
    // Room for a few bytes above the margin kept free: not for the folder again.
    free: 2 * 1024 ** 3 + 100,
    catalog: {
      tokenizer: {
        repo: 'Org/Tokenizer',
        revision: 'def',
        folder: true,
        size: MODEL.length + VOCAB.length,
        files: [
          { path: 'krea2_turbo.safetensors', size: MODEL.length, sha256: sha(MODEL) },
          { path: 'vocab.json', size: VOCAB.length },
        ],
      },
    },
  });
  // Every file fetched and named; the folder not yet (its rename refused a minute, or stopped then).
  const staging = join(f.models, 'text_encoders', 'tokenizer.download');
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, 'krea2_turbo.safetensors'), MODEL);
  await writeFile(join(staging, 'vocab.json'), VOCAB);
  // Before 0.6.86: « Pas assez de place » (the whole folder counted again), never finished.
  await f.downloads.start({ ...f.workflow, components: { tokenizer: f.workflow.components.tokenizer } });
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(f.requests, [], 'nothing fetched again');
  assert.deepEqual(await readFile(join(f.models, 'text_encoders', 'tokenizer', 'vocab.json')), VOCAB);
});

test('a file that is not the original is deleted, and the download says so', async t => {
  const f = await fixture(t);
  f.bodies['krea2_turbo.safetensors'] = Buffer.from('x'.repeat(MODEL.length));
  await f.downloads.start({ ...f.workflow, components: { model: f.workflow.components.model } });
  const done = await f.finish();
  assert.equal(done.state, 'error');
  assert.match(done.error, /ne correspond pas/);
  const folder = join(f.models, 'diffusion_models');
  await assert.rejects(stat(join(folder, 'krea2_turbo.safetensors')));
  await assert.rejects(stat(join(folder, 'krea2_turbo.safetensors.part')));
  assert.equal(f.registered.size, 0);
});

test('a gated source needs the Hugging Face token, sent to Hugging Face only', async t => {
  const f = await fixture(t, {
    catalog: {
      'krea2Turbo.safetensors': {
        repo: 'Org/Krea',
        revision: 'abc',
        path: 'diffusion_models/krea2_turbo.safetensors',
        size: MODEL.length,
        gated: true,
        page: 'https://huggingface.co/Org/Krea',
      },
    },
  });
  const workflow = { ...f.workflow, components: { model: f.workflow.components.model } };
  assert.equal((await f.downloads.offers([workflow])).krea.needsToken, true);
  await assert.rejects(f.downloads.start(workflow), /compte Hugging Face/);
  await assert.rejects(f.downloads.setToken('a b'), /invalide/);
  assert.equal(await f.downloads.setToken(' hf_abcdefghijklmnop '), true);
  assert.equal(await f.downloads.hasToken(), true);
  assert.equal((await f.downloads.offers([workflow])).krea.needsToken, false);
  await f.downloads.start(workflow);
  assert.equal((await f.finish()).state, 'done');
  const download = f.requests.find(request => request.url.includes('/resolve/'));
  assert.equal(download.headers.Authorization, 'Bearer hf_abcdefghijklmnop');
  assert.equal(await f.downloads.setToken(''), false);
  assert.equal(await f.downloads.hasToken(), false);
});

test('each file to download comes with its licence; one with conditions starts only once confirmed', async t => {
  const krea = {
      name: 'Krea 2 Community License Agreement v.1',
      url: 'https://huggingface.co/Comfy-Org/Krea-2/blob/main/LICENSE.pdf',
      limits: 'Usage commercial seulement sous 1 million de dollars de chiffre d’affaires annuel.',
      restricted: true,
    },
    apache = { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html' };
  const f = await fixture(t, {
    catalog: {
      'krea2Turbo.safetensors': {
        repo: 'Org/Krea',
        revision: 'abc',
        path: 'diffusion_models/krea2_turbo.safetensors',
        size: MODEL.length,
        sha256: sha(MODEL),
        license: krea,
      },
      tokenizer: {
        repo: 'Org/Tokenizer',
        revision: 'def',
        folder: true,
        size: VOCAB.length,
        license: { ...apache, url: 'javascript:alert(1)' },
        files: [{ path: 'vocab.json', size: VOCAB.length }],
      },
    },
  });
  // As the page shows it: name, link, limits, and whether it is to confirm; a link that is not https is left out.
  assert.deepEqual(
    (await f.downloads.missing(f.workflow)).map(item => [item.file, item.license]),
    [
      ['krea2Turbo.safetensors', krea],
      ['tokenizer', { name: 'Apache-2.0', url: '', limits: '', restricted: false }],
    ],
  );
  const offer = (await f.downloads.offers([f.workflow])).krea;
  assert.equal(offer.restricted, true);
  assert.deepEqual(
    offer.files.map(file => [file.file, file.license.name, file.license.restricted]),
    [
      ['krea2Turbo.safetensors', 'Krea 2 Community License Agreement v.1', true],
      ['tokenizer', 'Apache-2.0', false],
    ],
  );
  // Not confirmed: nothing is fetched, and the licence to read is named. Confirmed: it goes.
  await assert.rejects(
    f.downloads.start(f.workflow),
    /Licence à conditions \(Krea 2 Community License Agreement v\.1\) : lisez-la et confirmez/,
  );
  assert.deepEqual(f.requests, []);
  assert.equal(f.downloads.status().state, 'idle');
  await f.downloads.start(f.workflow, { accepted: true });
  assert.equal((await f.finish()).state, 'done');
  // Under free licences alone, no confirmation is asked.
  const free = await fixture(t, {
    catalog: {
      tokenizer: {
        repo: 'Org/Tokenizer',
        revision: 'def',
        folder: true,
        size: VOCAB.length,
        license: apache,
        files: [{ path: 'vocab.json', size: VOCAB.length }],
      },
    },
  });
  const workflow = { ...free.workflow, components: { tokenizer: free.workflow.components.tokenizer } };
  const open = (await free.downloads.offers([workflow])).krea;
  assert.equal(open.restricted, false);
  assert.deepEqual(open.files[0].license, { ...apache, limits: '', restricted: false });
  await free.downloads.start(workflow);
  assert.equal((await free.finish()).state, 'done');
});

test('nothing starts without room on the disk, for a workflow of the user, or twice at once', async t => {
  const small = await fixture(t, { free: 1000 });
  await assert.rejects(small.downloads.start(small.workflow), /Pas assez de place/);
  const f = await fixture(t);
  // (0.6.198) Said to the user: « modèles », « Moodix » (« Seuls les workflows fournis avec Atelier » before).
  await assert.rejects(f.downloads.start({ ...f.workflow, builtin: false }), { message: 'Seuls les modèles fournis avec Moodix se téléchargent.' });
  await f.downloads.start(f.workflow);
  await assert.rejects(f.downloads.start(f.workflow), /déjà en cours/);
  await f.finish();
  await assert.rejects(f.downloads.start(f.workflow), { message: 'Rien à télécharger : tous les fichiers de ce modèle sont là.' });
  assert.equal(formatBytes(43.7 * 1024 ** 3), '43,7 Go');
  assert.equal(formatBytes(67061725), '64 Mo');
});

test('two starts asked at the same instant are one download: the file is whole, the other is refused (0.6.288)', async t => {
  const f = await fixture(t);
  // A double click, or two tabs: both asked before the first has read the files and the disk.
  const asked = await Promise.allSettled([f.downloads.start(f.workflow), f.downloads.start(f.workflow)]);
  assert.deepEqual(
    asked.map(answer => answer.status),
    ['fulfilled', 'rejected'],
  );
  assert.deepEqual([asked[1].reason.message, asked[1].reason.status], ['Un téléchargement est déjà en cours.', 409]);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  // Each file asked for once, and the model as it was published (it was written twice in its .part, then erased).
  assert.deepEqual(f.requests.map(request => request.url.split('/').at(-1)).sort(), ['krea2_turbo.safetensors', 'vocab.json']);
  assert.deepEqual(await readFile(join(f.models, 'diffusion_models', 'krea2_turbo.safetensors')), MODEL);
  assert.equal(done.received, MODEL.length + VOCAB.length);

  // A start that is refused lets the next one begin: nothing stays held.
  const again = await fixture(t);
  await assert.rejects(again.downloads.start({ ...again.workflow, builtin: false }), /Seuls les modèles fournis/);
  await again.downloads.start(again.workflow);
  assert.equal((await again.finish()).state, 'done');
});

// (0.6.223) Wan 2.2 Fun Camera is published as 8-bit floats only, which the engine does not read: its
// two files are downloaded, then written again in the engine's format on this computer.
async function converting(t, { free = 1024 ** 4, convert, engine = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'moodix-convert-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'models', 'diffusion_models'),
    catalogPath = join(root, 'downloads.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      'camera_high_int8_convrot.safetensors': {
        repo: 'Org/Camera',
        revision: 'abc',
        path: 'split_files/diffusion_models/camera_high_fp8_scaled.safetensors',
        size: MODEL.length,
        sha256: sha(MODEL),
        convert: 'int8',
        license: { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html' },
      },
    }),
  );
  const registered = new Map(),
    converted = [],
    requests = [];
  const downloads = new ModelDownloads({
    catalogPath,
    dataDir: root,
    assets: {
      resolve: async id => (registered.has(id) ? { path: registered.get(id).path } : Promise.reject(new Error(`Asset ${id} not found`))),
      register: async asset => void registered.set(asset.id, asset),
    },
    folderOf: () => folder,
    fetchImpl: async (url, options = {}) => {
      requests.push(url);
      const range = options.headers?.Range?.match(/^bytes=(\d+)-$/);
      return new Response(range ? MODEL.subarray(Number(range[1])) : MODEL, { status: range ? 206 : 200 });
    },
    statfs: async () => ({ bavail: free, bsize: 1 }),
    engine,
    ...(convert === null
      ? {}
      : {
          convert:
            convert ??
            (async (from, to) => {
              converted.push([from, to, downloads.job.current]);
              await writeFile(to, 'int8 ' + (await readFile(from)).length);
            }),
        }),
  });
  const workflow = {
    id: 'camera',
    name: 'Wan 2.2 Caméra',
    pipeline: 'wan22_camera',
    builtin: true,
    ready: false,
    components: { model: { policy: 'fixed', asset: 'camera-high', file: 'camera_high_int8_convrot.safetensors' } },
  };
  return { folder, downloads, workflow, registered, converted, requests, source: join(folder, 'camera_high_fp8_scaled.safetensors'), target: join(folder, 'camera_high_int8_convrot.safetensors') };
}

test('a file the engine does not read as published is downloaded, converted here, and registered under the name the model asks (0.6.223)', async t => {
  const f = await converting(t);
  const offer = (await f.downloads.offers([f.workflow])).camera;
  // What is downloaded is the published file; that it is then converted is said, with the room the
  // disk needs meanwhile: both files, the published one and the converted one beside it (0.6.224).
  assert.deepEqual([offer.bytes, offer.left, offer.complete, offer.convert], [MODEL.length, MODEL.length, true, true]);
  assert.equal(offer.room, 2 * MODEL.length);
  await f.downloads.start(f.workflow);
  await f.downloads.task;
  assert.equal(f.downloads.status().state, 'done', f.downloads.status().error);
  assert.deepEqual(f.requests, ['https://huggingface.co/Org/Camera/resolve/abc/split_files/diffusion_models/camera_high_fp8_scaled.safetensors']);
  // Converted once the download is whole and checked, from the published file to the model's own;
  // said while it lasts (the bar is at its end, and minutes pass).
  assert.deepEqual(f.converted, [[f.source, f.target, 'camera_high_int8_convrot.safetensors : conversion pour le moteur de Moodix']]);
  assert.equal(await readFile(f.target, 'utf8'), 'int8 ' + MODEL.length);
  // The published file served only for that: it does not stay (15 Go the engine never reads).
  await assert.rejects(stat(f.source));
  assert.deepEqual(f.registered.get('camera-high'), { id: 'camera-high', path: f.target, kind: 'model', family: 'wan22_camera' });
  assert.deepEqual(await f.downloads.offers([f.workflow]), {}, 'nothing left to offer');
});

test('a conversion that fails leaves the downloaded file for the next try, and registers nothing (0.6.223)', async t => {
  let fails = true;
  const calls = [];
  const f = await converting(t, {
    convert: async (from, to) => {
      calls.push(from);
      if (fails) throw new Error('le moteur de génération n’est pas encore installé');
      await writeFile(to, 'int8');
    },
  });
  await f.downloads.start(f.workflow);
  await f.downloads.task;
  assert.deepEqual([f.downloads.status().state, f.downloads.status().error], ['error', 'le moteur de génération n’est pas encore installé']);
  assert.deepEqual(await readFile(f.source), MODEL, 'the download is kept');
  assert.equal(f.registered.size, 0);
  // Tried again: nothing is fetched a second time, the conversion alone runs.
  fails = false;
  const offer = (await f.downloads.offers([f.workflow])).camera;
  // (Nothing left to fetch: the room is the converted file's alone.)
  assert.deepEqual([offer.bytes, offer.left, offer.room], [MODEL.length, 0, MODEL.length]);
  await f.downloads.start(f.workflow);
  await f.downloads.task;
  assert.equal(f.downloads.status().state, 'done', f.downloads.status().error);
  assert.equal(f.requests.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(f.registered.get('camera-high').path, f.target);
  await assert.rejects(stat(f.source));
});

test('a file to convert asks for the room of both files, is never written over another, and needs the engine (0.6.223)', async t => {
  // The converted file is written beside the published one before that one leaves.
  const tight = await converting(t, { free: MODEL.length + 2 * 1024 ** 3 + 10 });
  await assert.rejects(tight.downloads.start(tight.workflow), /Pas assez de place/);
  const wide = await converting(t, { free: 2 * MODEL.length + 2 * 1024 ** 3 + 10 });
  await wide.downloads.start(wide.workflow);
  await wide.downloads.task;
  assert.equal(wide.downloads.status().state, 'done', wide.downloads.status().error);
  // A file that has the name of the converted one, or of the published one, without being it.
  const taken = await converting(t);
  await mkdir(taken.folder, { recursive: true });
  await writeFile(taken.target, 'another file');
  await assert.rejects(taken.downloads.start(taken.workflow), /camera_high_int8_convrot\.safetensors existe déjà .* sans convenir à ce modèle/);
  const other = await converting(t);
  await mkdir(other.folder, { recursive: true });
  await writeFile(other.source, 'not the published file');
  await assert.rejects(other.downloads.start(other.workflow), /camera_high_fp8_scaled\.safetensors existe déjà .* sans être le fichier attendu/);
  assert.equal(await readFile(other.source, 'utf8'), 'not the published file');
  // Without what converts (the engine is not there), nothing is downloaded for nothing.
  const bare = await converting(t, { convert: null });
  await assert.rejects(bare.downloads.start(bare.workflow), /se convertissent après le téléchargement/);
  assert.equal(bare.requests.length, 0);
});

test('(0.6.479) a file the engine converts, on a new installation: the engine first, then the files', async t => {
  // Wan 2.2 Fun Camera, written again by the Python of the engine (runner/convert.py). Its engine prepared after its
  // files came too late: the conversion failed (« … n’est pas encore installé »), and the engine never came.
  const engine = engineOf(),
    order = [],
    f = await converting(t, {
      engine,
      convert: async (from, to) => {
        if (!engine.ready) throw new Error('le moteur de génération n’est pas encore installé');
        order.push('conversion');
        await writeFile(to, 'int8');
      },
    });
  const prepare = engine.prepare;
  engine.prepare = async signal => {
    order.push('moteur');
    await prepare(signal);
  };
  let release;
  engine.hold = new Promise(done => (release = done));
  await f.downloads.start(f.workflow);
  const during = await preparing(f.downloads);
  // Nothing fetched yet: the engine first, said as being prepared.
  assert.deepEqual(
    [during.engine, during.received, during.total, f.requests.length],
    ['preparing', 0, MODEL.length + 3000, 0],
  );
  release();
  await f.downloads.task;
  const done = f.downloads.status();
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(
    [order, done.engine, done.received, done.total],
    [['moteur', 'conversion'], 'ready', MODEL.length + 3000, MODEL.length + 3000],
  );
  assert.equal(f.registered.get('camera-high').path, f.target);
  // Its preparation failing, nothing is fetched for nothing, and no file is said to be there.
  const failing = engineOf(),
    g = await converting(t, { engine: failing });
  failing.fail = new Error('error: Failed to fetch');
  await g.downloads.start(g.workflow);
  await g.downloads.task;
  assert.deepEqual(
    [g.downloads.status().state, g.downloads.status().error, g.requests.length],
    ['error', 'Le moteur de génération n’a pas pu être préparé : error: Failed to fetch', 0],
  );
});


test('a LoRA a shipped workflow names and lacks is offered and fetched with its other files (0.6.421)', async t => {
  const LORA = Buffer.from('lora weights '.repeat(50));
  const f = await fixture(t, {
    catalog: {
      'krea2Turbo.safetensors': { repo: 'Org/Krea', revision: 'abc', path: 'diffusion_models/krea2_turbo.safetensors', size: MODEL.length, sha256: sha(MODEL) },
      'subjects.safetensors': { repo: 'Org/Subjects', revision: 'v1', path: 'subjects.safetensors', size: LORA.length, sha256: sha(LORA), license: { name: 'Apache-2.0', url: 'https://example.org/licence' } },
    },
  });
  f.bodies['subjects.safetensors'] = LORA;
  f.downloads.folderOf = (family, role) => join(f.models, role === 'lora' ? 'loras' : 'diffusion_models');
  const workflow = {
    ...f.workflow,
    components: { model: f.workflow.components.model },
    loras: [
      { id: 'subjects', asset: 'lora-asset', file: 'subjects.safetensors' },
      // One of the user's, registered by its id alone: nothing to fetch for it.
      { id: 'theirs', asset: 'their-asset' },
    ],
  };
  assert.deepEqual((await f.downloads.missing(workflow)).map(item => [item.role, item.file, item.asset, item.license?.name]), [
    ['model', 'krea2Turbo.safetensors', 'model-asset', undefined],
    ['lora', 'subjects.safetensors', 'lora-asset', 'Apache-2.0'],
  ]);
  const offer = (await f.downloads.offers([workflow])).krea;
  assert.deepEqual([offer.bytes, offer.complete, offer.files.map(file => file.file)], [MODEL.length + LORA.length, true, ['krea2Turbo.safetensors', 'subjects.safetensors']]);
  await f.downloads.start(workflow);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  // In the folder of the LoRAs, registered under the id the workflow gives it, as a LoRA of its model.
  const lora = join(f.models, 'loras', 'subjects.safetensors');
  assert.deepEqual(await readFile(lora), LORA);
  assert.deepEqual([f.registered.get('lora-asset').path, f.registered.get('lora-asset').kind, f.registered.get('lora-asset').family], [lora, 'lora', 'krea2']);
  assert.deepEqual(await f.downloads.missing(workflow), []);
  // The model there and the LoRA alone missing: it alone is offered.
  f.registered.delete('lora-asset');
  assert.deepEqual((await f.downloads.missing(workflow)).map(item => item.file), ['subjects.safetensors']);
});

/**
 * (0.6.432) A Hugging Face whose connection drops, request after request of the model, as `plan` says: `half`
 * sends half of what is asked, then drops once that is on the disk (a Wi-Fi that goes minutes in, as Node says it:
 * « terminated »); `lost` the same, a quarter of it never reached the disk; `disk` the same, failed as a full disk
 * fails (with `syscall`); `short` sends half and ends as if all was sent; `down` finds no network (« fetch
 * failed »); `whole` answers a resumed request from the start; `other` and `shifted` send what is not the rest of
 * this file; `refused` answers 503. Past the plan, the rest comes from where it is asked. Only the model is asked
 * for: `only(f)` is the workflow without its tokenizer.
 */
function dropping(f, plan) {
  const part = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors.part'),
    asked = [],
    range = (start, total) => ({ 'Content-Range': `bytes ${start}-${total - 1}/${total}` });
  f.downloads.pauses = [1, 1, 1];
  f.downloads.fetchImpl = async (url, options = {}) => {
    const from = Number(/^bytes=(\d+)-$/.exec(options.headers?.Range ?? '')?.[1] ?? 0),
      kind = plan[asked.length],
      rest = MODEL.subarray(from),
      init = from ? { status: 206, headers: range(from, MODEL.length) } : { status: 200 };
    asked.push(from);
    if (kind === 'down') throw new TypeError('fetch failed');
    if (kind === 'refused') return new Response('', { status: 503 });
    if (kind === 'whole') return new Response(MODEL, { status: 200 });
    const larger = MODEL.length + 10;
    if (kind === 'other')
      return new Response(Buffer.alloc(larger - from, 7), { status: 206, headers: range(from, larger) });
    if (kind === 'shifted') return new Response(MODEL, { status: 206, headers: range(0, MODEL.length) });
    if (!kind) return new Response(rest, init);
    const half = rest.subarray(0, rest.length >> 1);
    if (kind === 'short') return new Response(half, init);
    let sent = false;
    const body = new ReadableStream({
      async pull(controller) {
        if (!sent) return void ((sent = true), controller.enqueue(half));
        for (let turn = 0; turn < 500 && (await stat(part).catch(() => null))?.size !== from + half.length; turn++)
          await new Promise(resolve => setTimeout(resolve, 2));
        if (kind === 'lost') await (await import('node:fs/promises')).truncate(part, from + (half.length >> 1));
        const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { syscall: 'write' });
        controller.error(kind === 'disk' ? full : new TypeError('terminated'));
      },
    });
    return new Response(body, init);
  };
  return asked;
}
const only = f => ({ ...f.workflow, components: { model: f.workflow.components.model } });

test('a download cut on the way goes on by itself from where it stopped, checked whole (0.6.432)', async t => {
  for (const [plan, asks] of [
    // Cut once: the rest is asked for. Before, « error », said « terminated », to start again by hand.
    [['half'], [0, 1400]],
    // Cut while a quarter of what came was still on its way to the disk: asked, counted and fingerprinted from
    // what reached it.
    [['lost'], [0, 700]],
    // Asked from where it stopped, the source sends it all from the start: so does the file.
    [['half', 'whole'], [0, 1400]],
    // Come short without an error (the connection closed as if all was sent): a cut too.
    [['short'], [0, 1400]],
  ]) {
    const f = await fixture(t),
      asked = dropping(f, plan);
    await f.downloads.start(only(f));
    const done = await f.finish();
    assert.equal(done.state, 'done', `${plan} : ${done.error}`);
    assert.deepEqual(asked, asks, String(plan));
    const model = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors');
    assert.deepEqual(await readFile(model), MODEL, String(plan));
    // What came before the cut is counted once: the page never says more than the whole.
    assert.equal(done.received, done.total, String(plan));
  }
  // While it waits to try again, the page is told so where it shows the file being fetched.
  const waiting = await fixture(t);
  dropping(waiting, ['half']);
  waiting.downloads.pauses = [400];
  await waiting.downloads.start(only(waiting));
  let said = '';
  for (let turn = 0; turn < 500 && !/connexion coupée/.test((said = waiting.downloads.status().current)); turn++)
    await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(said, 'krea2_turbo.safetensors : connexion coupée, nouvel essai dans 1 s');
  assert.equal((await waiting.finish()).state, 'done');
  // No network when the download is started (the source has answered nothing yet): said at once, in French,
  // without a pause; started again once the network is back, it goes to its end. The same when the first
  // thing asked is the fingerprint of a protected file.
  const offline = await fixture(t),
    never = dropping(offline, ['down']);
  offline.downloads.pauses = [60000];
  await offline.downloads.start(only(offline));
  const refused = await offline.finish();
  assert.deepEqual([refused.state, never], ['error', [0]]);
  assert.match(refused.error, /^La connexion a été coupée pendant le téléchargement de krea2_turbo\.safetensors/);
  await offline.downloads.start(only(offline));
  assert.equal((await offline.finish()).state, 'done');
  const f = await fixture(t, {
      catalog: {
        'krea2Turbo.safetensors': {
          repo: 'Org/Krea',
          revision: 'abc',
          path: 'diffusion_models/krea2_turbo.safetensors',
          size: MODEL.length,
          gated: true,
          page: 'https://huggingface.co/Org/Krea',
        },
      },
    }),
    served = f.downloads.fetchImpl,
    hub = [];
  await f.downloads.setToken('hf_abcdefghijklmnop');
  f.downloads.pauses = [60000];
  f.downloads.fetchImpl = async (url, options) => {
    if (!url.includes('/paths-info/')) return served(url, options);
    hub.push(url);
    if (hub.length === 1) throw new TypeError('fetch failed');
    return Response.json([{ lfs: { oid: sha(MODEL) } }]);
  };
  await f.downloads.start(only(f));
  const cut = await f.finish();
  assert.deepEqual([cut.state, hub.length], ['error', 1]);
  assert.match(cut.error, /^La connexion a été coupée pendant le téléchargement de krea2_turbo\.safetensors/);
  await f.downloads.start(only(f));
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.equal(hub.length, 2);
  assert.deepEqual(await readFile(join(f.models, 'diffusion_models', 'krea2_turbo.safetensors')), MODEL);
});

test('cut with nothing coming, it gives up after a few tries, says so, goes on when started (0.6.432)', async t => {
  const f = await fixture(t),
    asked = dropping(f, ['half', 'down', 'down', 'down']);
  await f.downloads.start(only(f));
  const stopped = await f.finish();
  // One try after each pause, then it stops, in French and with what to do.
  assert.deepEqual(
    [stopped.state, stopped.error],
    [
      'error',
      'La connexion a été coupée pendant le téléchargement de krea2_turbo.safetensors : relancez-le, il reprendra ' +
        'où il en était.',
    ],
  );
  assert.deepEqual(asked, [0, 1400, 1400, 1400]);
  const folder = join(f.models, 'diffusion_models');
  assert.equal((await stat(join(folder, 'krea2_turbo.safetensors.part'))).size, 1400, 'what came stays');
  // Started again, the network back: from there.
  assert.equal((await f.downloads.start(only(f))).received, 1400);
  const done = await f.finish();
  assert.equal(done.state, 'done', done.error);
  assert.deepEqual(asked.slice(4), [1400]);
  assert.deepEqual(await readFile(join(folder, 'krea2_turbo.safetensors')), MODEL);
  // A connection that drops again and again while bytes come goes on: only tries in a row that bring nothing count.
  const g = await fixture(t),
    again = dropping(g, ['half', 'half', 'half', 'half', 'half']);
  g.downloads.pauses = [1];
  await g.downloads.start(only(g));
  assert.equal((await g.finish()).state, 'done');
  assert.deepEqual(again, [0, 1400, 2100, 2450, 2625, 2712]);
});

test(
  '« Arrêter » while it waits to try again stops it there, and no other download starts (0.6.432)',
  { timeout: 30000 },
  async t => {
    const f = await fixture(t),
      asked = dropping(f, ['half']),
      part = join(f.models, 'diffusion_models', 'krea2_turbo.safetensors.part');
    f.downloads.pauses = [60000];
    await f.downloads.start(only(f));
    // The cut has come; a minute before the next try.
    for (let turn = 0; turn < 500 && (await stat(part).catch(() => null))?.size !== 1400; turn++)
      await new Promise(resolve => setTimeout(resolve, 2));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.downloads.status().state, 'running');
    await assert.rejects(f.downloads.start(only(f)), /Un téléchargement est déjà en cours/);
    f.downloads.cancel();
    const stopped = await f.finish();
    assert.equal(stopped.state, 'cancelled');
    assert.deepEqual(asked, [0], 'nothing asked after');
    assert.equal((await stat(part)).size, 1400, 'what came stays');
  },
);

test('no cut, no new try: what is not the rest of this file, a source in error, a full disk (0.6.432)', async t => {
  for (const [kind, said] of [
    // Asked from where it stopped, the source sends the rest of a larger file, or the file from its start, as a
    // rest: nothing is added to what came. Before, it was, and the file was refused at its end.
    ['other', 'La source de krea2_turbo.safetensors ne correspond plus au fichier attendu.'],
    ['shifted', 'La source de krea2_turbo.safetensors ne correspond plus au fichier attendu.'],
    // Said as before, and asked once.
    ['refused', 'La source de krea2_turbo.safetensors répond 503.'],
    ['disk', 'ENOSPC: no space left on device, write'],
  ]) {
    const f = await fixture(t),
      asked = dropping(f, [kind, kind, kind, kind]),
      folder = join(f.models, 'diffusion_models');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'krea2_turbo.safetensors.part'), MODEL.subarray(0, 1000));
    await f.downloads.start(only(f));
    const done = await f.finish();
    assert.deepEqual([done.state, done.error, asked], ['error', said, [1000]], kind);
    const kept = await readFile(join(folder, 'krea2_turbo.safetensors.part'));
    assert.deepEqual(kept.subarray(0, 1000), MODEL.subarray(0, 1000), kind);
    if (kind !== 'disk') assert.equal(kept.length, 1000, kind);
  }
});

test('(0.6.506) a tokenizer in a folder of its repository lands at the root of its own, and registers', async t => {
  // MOSS Image on a new installation: its tokenizer is in tokenizer/ of its repository. Its files landed in
  // qwen35_tokenizer/tokenizer/, the registry refused the folder (« tokenizer_config.json est absent »), the download
  // ended in an error after the 15 Go before it, and nothing was offered again: the folder was there.
  const root = await mkdtemp(join(tmpdir(), 'atelier-downloads-tokenizer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shipped = JSON.parse(await readFile(new URL('../runner/downloads.json', import.meta.url), 'utf8')),
    bodies = {
      'tokenizer.json': Buffer.from('{"model":{"vocab":{"a":0,"b":1}},"added_tokens":[{"id":2}]}'),
      'tokenizer_config.json': Buffer.from('{"added_tokens_decoder":{}}'),
    };
  // Its source as Moodix ships it, with files of a few bytes in the place of its 20 Mo.
  const source = shipped.qwen35_tokenizer,
    files = source.files.map(file => ({ ...file, size: bodies[file.path.split('/').pop()].length })),
    catalogPath = join(root, 'downloads.json');
  await writeFile(
    catalogPath,
    JSON.stringify({ qwen35_tokenizer: { ...source, size: files.reduce((sum, file) => sum + file.size, 0), files } }),
  );
  const assets = new GenerationAssets(join(root, 'generation-assets.json')),
    folder = join(root, 'models', 'text_encoders'),
    requests = [];
  const downloads = new ModelDownloads({
    catalogPath,
    dataDir: root,
    assets,
    folderOf: () => folder,
    fetchImpl: async url => {
      requests.push(url);
      return new Response(bodies[decodeURIComponent(url.split('/').at(-1))], { status: 200 });
    },
    statfs: async () => ({ bavail: 1024 ** 4, bsize: 1 }),
  });
  const workflow = {
    id: 'moss',
    name: 'MOSS Image',
    pipeline: 'moss',
    builtin: true,
    ready: false,
    components: { tokenizer: { policy: 'fixed', asset: 'tokenizer-asset', file: 'qwen35_tokenizer' } },
  };
  await downloads.start(workflow);
  await downloads.task;
  const status = downloads.status();
  assert.deepEqual([status.state, status.error], ['done', '']);
  // Fetched from tokenizer/ of the repository; at the root of its folder here, where the engine reads it (moss.py).
  const from = `https://huggingface.co/${source.repo}/resolve/${source.revision}/tokenizer/`;
  assert.deepEqual(requests.sort(), [from + 'tokenizer.json', from + 'tokenizer_config.json']);
  const landed = (await readdir(join(folder, 'qwen35_tokenizer'))).sort();
  assert.deepEqual(landed, ['tokenizer.json', 'tokenizer_config.json']);
  const [registered] = await assets.list();
  assert.equal(registered.path, await realpath(join(folder, 'qwen35_tokenizer')));
  assert.equal(registered.inspection.format, 'tokenizer');
  assert.deepEqual(await downloads.missing(workflow), []);
});

/**
 * (0.6.506) The tokenizer of MOSS Image where a download of before left it, its catalog as Moodix ships it with files
 * of a few bytes in the place of its 20 Mo; the folder of a source without `subfolder` beside (clip_tokenizer). `lay`
 * writes files in a folder; `tree` lists a folder whole, each file with its size.
 */
async function nested(t) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-downloads-nested-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shipped = JSON.parse(await readFile(new URL('../runner/downloads.json', import.meta.url), 'utf8')),
    bodies = {
      'tokenizer.json': Buffer.from('{"model":{"vocab":{"a":0,"b":1}},"added_tokens":[{"id":2}]}'),
      'tokenizer_config.json': Buffer.from('{"added_tokens_decoder":{}}'),
    },
    files = shipped.qwen35_tokenizer.files.map(file => ({ ...file, size: bodies[file.path].length })),
    clip = { ...shipped.clip_tokenizer, files },
    catalogPath = join(root, 'downloads.json'),
    folder = join(root, 'models', 'text_encoders');
  await writeFile(catalogPath, JSON.stringify({ qwen35_tokenizer: { ...shipped.qwen35_tokenizer, files }, clip }));
  const assets = new GenerationAssets(join(root, 'generation-assets.json'), { roots: () => [folder] }),
    downloads = new ModelDownloads({ catalogPath, dataDir: root, assets, folderOf: () => folder }),
    owners = new Map([
      ['qwen35_tokenizer', new Set(['moss|tokenizer'])],
      ['clip', new Set(['moss|tokenizer'])],
    ]),
    lay = async (place, names = Object.keys(bodies)) => {
      await mkdir(place, { recursive: true });
      for (const name of names) await writeFile(join(place, name), bodies[name] ?? Buffer.from('autre'));
    },
    tree = async (place, prefix = '') => {
      const found = [],
        entries = await readdir(place, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = join(place, entry.name),
          name = prefix + entry.name;
        if (entry.isDirectory()) found.push(name + '/', ...(await tree(path, name + '/')));
        else found.push(`${name} ${(await stat(path)).size}`);
      }
      return found;
    },
    tokenizer = () =>
      assets.resolve('tokenizer-asset', { kind: 'tokenizer', family: 'moss', file: 'qwen35_tokenizer' });
  return { root, folder, target: join(folder, 'qwen35_tokenizer'), downloads, owners, bodies, lay, tree, tokenizer };
}

test('(0.6.506) a tokenizer a download of before put one level too deep is mended: its files moved up', async t => {
  // Its files in qwen35_tokenizer/tokenizer/: refused (« tokenizer_config.json est absent »), never offered again.
  const f = await nested(t);
  await f.lay(join(f.target, 'tokenizer'));
  await assert.rejects(f.tokenizer(), /tokenizer_config\.json/);
  assert.deepEqual(await f.downloads.repairNested(f.owners), { mended: [f.target], failed: [] });
  // Moved in the same folder, the level they were in gone once empty: nothing else removed.
  assert.deepEqual(await f.tree(f.folder), [
    'qwen35_tokenizer/',
    `qwen35_tokenizer/tokenizer.json ${f.bodies['tokenizer.json'].length}`,
    `qwen35_tokenizer/tokenizer_config.json ${f.bodies['tokenizer_config.json'].length}`,
  ]);
  // Found, and registered, as the engine reads it.
  const found = await f.tokenizer();
  assert.deepEqual([found.path, found.inspection.format], [await realpath(f.target), 'tokenizer']);
  // Once: read again, nothing more to do.
  assert.deepEqual(await f.downloads.repairNested(f.owners), { mended: [], failed: [] });
});

test('(0.6.506) a tokenizer already at its root, or a folder of another content, is left as it is', async t => {
  const f = await nested(t),
    level = join(f.target, 'tokenizer');
  // Its files at its root (a copy one level down beside them, as the user may have made it): nothing.
  await f.lay(f.target);
  await f.lay(level);
  const whole = await f.tree(f.folder);
  assert.deepEqual(await f.downloads.repairNested(f.owners), { mended: [], failed: [] });
  assert.deepEqual(await f.tree(f.folder), whole);
  // Something else at the root, beside that level; a file of more in it; a file of another size; nothing.
  for (const lay of [
    async () => f.lay(f.target, ['notes.txt']),
    async () => f.lay(level, ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json']),
    async () => {
      await f.lay(level);
      await writeFile(join(level, 'tokenizer.json'), '{}');
    },
  ]) {
    await rm(f.target, { recursive: true, force: true });
    await f.lay(level);
    await lay();
    const before = await f.tree(f.folder);
    assert.deepEqual(await f.downloads.repairNested(f.owners), { mended: [], failed: [] });
    assert.deepEqual(await f.tree(f.folder), before);
  }
  // A source without `subfolder` (its files never one level down), nor a folder elsewhere than where Moodix
  // downloads it, is ever looked at.
  await rm(f.target, { recursive: true, force: true });
  const elsewhere = join(f.root, 'ComfyUI', 'models', 'text_encoders', 'qwen35_tokenizer', 'tokenizer');
  await f.lay(join(f.folder, 'clip', 'tokenizer'));
  await f.lay(elsewhere);
  const [here, there] = [await f.tree(f.folder), await f.tree(join(f.root, 'ComfyUI'))];
  assert.deepEqual(await f.downloads.repairNested(f.owners), { mended: [], failed: [] });
  assert.deepEqual([await f.tree(f.folder), await f.tree(join(f.root, 'ComfyUI'))], [here, there]);
});
