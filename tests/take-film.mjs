import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFilm, waveOf, WAVE_RATE } from '../lib/take-film.mjs';
import { Thumbnails } from '../lib/thumbnails.mjs';
import { Gallery } from '../lib/gallery.mjs';
import { GenerationService } from '../lib/generation-service.mjs';
import { runEnvironmentCommand } from '../lib/python-environment.mjs';
import { imageSize } from '../lib/image-size.mjs';
import { createApplication } from '../server.mjs';

/**
 * (0.6.459, Bobine Pro, B01) The film of a take on the timeline of the Bobine: the loudness of its sound, twelve values
 * a second, and pictures taken along a video, read once from its file by the Python of the engine and kept with its
 * thumbnail (runner/tests/test_film.py has the command itself).
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const conversation = 'a1111111-1111-4111-8111-111111111111',
  video = 'c3333333-3333-4333-8333-333333333333',
  sound = 'd4444444-4444-4444-8444-444444444444',
  picture = 'e5555555-5555-4555-8555-555555555555';
// A JPEG of 3 × 1 pictures of 1 pixel: enough for what is checked of it (its first bytes and its size).
const STRIP = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDk6KKKAP/Z',
  'base64',
);
async function folder(t) {
  const path = await mkdtemp(join(tmpdir(), 'atelier-film-'));
  assert.equal(dirname(path), tmpdir());
  t.after(() => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return path;
}

test('(0.6.459) the film of a take is read by a command of the engine’s Python that ends: its arguments, its files, its failures', async t => {
  assert.deepEqual(imageSize(STRIP), { width: 3, height: 1 });
  const work = join(await folder(t), 'runtime', 'tmp'),
    calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    const value = name => args[args.indexOf(name) + 1];
    await writeFile(value('--wave'), JSON.stringify({ rate: 12, sound: true, levels: [0, 50, 100] }));
    if (args.includes('--strip')) await writeFile(value('--strip'), STRIP);
    return { stdout: '{}', stderr: '' };
  };
  const film = await readFilm({ python: 'python-of-the-engine', root, input: 'clip.mp4', workDir: work, env: { A: '1' }, run });
  assert.deepEqual(film, { wave: { rate: 12, sound: true, levels: [0, 50, 100] }, strip: STRIP, frames: 3 });
  const [{ command, args, options }] = calls;
  assert.equal(command, 'python-of-the-engine');
  assert.deepEqual(args.slice(0, 2), ['-s', '-c']);
  assert.match(args[2], /run_module\('runner'/);
  assert.equal(args[3], resolve(root));
  assert.deepEqual(args.slice(4, 7), ['film', '--input', 'clip.mp4']);
  assert.equal(dirname(dirname(args[args.indexOf('--wave') + 1])), work, 'written in a folder of the application');
  assert.deepEqual([options.env.A, options.env.PYTHONIOENCODING], ['1', 'utf-8']);
  // (0.6.463) One thread for NumPy's OpenBLAS: 32 MiB committed when it loads instead of 643 on a 20-thread processor.
  assert.equal(options.env.OPENBLAS_NUM_THREADS, '1');
  assert.ok(options.signal instanceof AbortSignal, 'never waits for ever');
  assert.deepEqual(await readdir(work), [], 'nothing left behind');
  // A sound: no pictures asked.
  assert.deepEqual(await readFilm({ python: 'python', root, input: 'son.wav', pictures: false, workDir: work, run }), {
    wave: { rate: 12, sound: true, levels: [0, 50, 100] },
    strip: null,
    frames: 0,
  });
  assert.equal(calls[1].args.includes('--strip'), false);
  // Its failure: the last line it wrote, in the user's words; nothing left either.
  const failing = async () => {
    throw Error('Traceback (most recent call last):\n  …\nCe fichier n’est ni une vidéo ni un son lisible.');
  };
  await assert.rejects(readFilm({ python: 'python', root, input: 'clip.mp4', workDir: work, run: failing }), {
    message: 'Ce fichier n’est ni une vidéo ni un son lisible.',
  });
  // What it wrote, when it is not what it says: refused.
  const wrong = async (command, args) => {
    await writeFile(args[args.indexOf('--wave') + 1], JSON.stringify({ rate: 12, sound: true, levels: [101] }));
  };
  await assert.rejects(readFilm({ python: 'python', root, input: 'clip.mp4', pictures: false, workDir: work, run: wrong }), /illisible/);
  assert.deepEqual(await readdir(work), []);
  await assert.rejects(readFilm({ python: '', root, input: 'clip.mp4', workDir: work, run }), /n’est pas installé/);
  // The application without its environment: said, nothing installed nor downloaded for it.
  const data = await folder(t);
  const service = new GenerationService({ root, dataDir: data, workflowDir: join(data, 'workflow'), outputDir: join(data, 'output') });
  await assert.rejects(service.takeFilm('clip.mp4'), /l’environnement de génération n’est pas installé/);
  assert.deepEqual(await readdir(data), []);
});

test('(0.6.459) a wave is twelve whole values a second from 0 to 100, said with or without a sound', () => {
  assert.equal(WAVE_RATE, 12);
  assert.deepEqual(waveOf({ rate: 12, sound: false, levels: [], other: 1 }), { rate: 12, sound: false, levels: [] });
  for (const wrong of [null, {}, { rate: 24, sound: true, levels: [] }, { rate: 12, sound: 'oui', levels: [] }, { rate: 12, sound: true, levels: [1.5] }, { rate: 12, sound: true, levels: [-1] }])
    assert.equal(waveOf(wrong), null, JSON.stringify(wrong));
});

test('(0.6.459) the film of a take is kept beside its thumbnail, found again at the next start, and forgotten with it', async t => {
  const directory = join(await folder(t), 'thumbnails'),
    thumbs = await new Thumbnails(directory).load(),
    key = Thumbnails.key(conversation, video, 0),
    heard = Thumbnails.key(conversation, sound, 0),
    wave = { rate: 12, sound: true, levels: [3, 60] };
  assert.equal(await thumbs.film(key), null);
  await thumbs.keepFilm(key, { wave, strip: STRIP, frames: 3 });
  await thumbs.keepFilm(heard, { wave: { ...wave, sound: false, levels: [] } });
  assert.deepEqual(await thumbs.film(key), { wave, frames: 3 });
  assert.deepEqual(await thumbs.strip(key), STRIP);
  assert.deepEqual(await thumbs.film(heard), { wave: { rate: 12, sound: false, levels: [] }, frames: 0 });
  await assert.rejects(thumbs.strip(Thumbnails.key(conversation, picture, 0)), { status: 404 });
  // Not a thumbnail: the page still sends its own.
  assert.equal(thumbs.has(key), false);
  await assert.rejects(thumbs.keepFilm(key, { wave: { ...wave, levels: [200] } }), /Onde invalide/);
  await assert.rejects(thumbs.keepFilm(key, { wave, strip: Buffer.from('<svg/>'), frames: 1 }), /JPEG/);
  await assert.rejects(thumbs.keepFilm(key, { wave, strip: STRIP, frames: 0 }), /invalide/);
  const again = await new Thumbnails(directory).load();
  assert.deepEqual(await again.film(key), { wave, frames: 3 });
  assert.equal(again.known.size, 0, 'a strip is not taken for a thumbnail');
  // A thumbnail and a film, then the conversation forgotten: nothing of either left.
  await again.write(key, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]));
  await again.forget(conversation, video);
  assert.equal(await again.film(key), null);
  assert.deepEqual(await again.film(heard), { wave: { rate: 12, sound: false, levels: [] }, frames: 0 });
  await again.forget(conversation);
  assert.deepEqual(await readdir(directory), []);
});

test('(0.6.459, Bobine Pro, B01) the server reads the film of a take once, when first asked, and gives the strip of a video at its own address', async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'), { recursive: true });
  for (const name of ['clip.mp4', 'son.wav', 'photo.png']) await writeFile(join(data, 'output', name), 'media');
  const gallery = new Gallery({ historyDir: join(data, 'history') });
  for (const [id, mediaType, filename] of [
    [video, 'video', 'clip.mp4'],
    [sound, 'audio', 'son.wav'],
    [picture, 'image', 'photo.png'],
  ])
    await gallery.put(
      {
        id,
        conversationId: conversation,
        provider: 'native',
        mediaType,
        workflowId: 'basic',
        workflowName: 'Basic',
        prompt: 'Un renard',
        parameters: {},
        createdAt: '2026-11-27T10:00:00.000Z',
        outputs: [{ source: { filename, subfolder: '', type: 'output' } }],
      },
      { persist: true },
    );
  const reads = [];
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const takeFilm = async (path, options) => {
    reads.push([path, options]);
    await gate;
    return options.pictures
      ? { wave: { rate: 12, sound: true, levels: [10, 90] }, strip: STRIP, frames: 3 }
      : { wave: { rate: 12, sound: true, levels: [40] }, strip: null, frames: 0 };
  };
  const app = await createApplication({ port: 0, dataDir: data, takeFilm });
  t.after(async () => {
    await app.close();
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const listed = await (await fetch(app.url + '/api/gallery/' + conversation + '?images=0', { headers: { Authorization: 'Bearer ' + token } })).json();
  const urlOf = id => listed.runs.find(run => run.id === id).outputs[0].filmUrl;
  assert.match(urlOf(video), /^\/media\/films\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/0\?key=[0-9a-f]{64}$/);
  assert.match(urlOf(sound), /^\/media\/films\//);
  assert.equal(urlOf(picture), undefined, 'an image has no film');
  assert.equal(reads.length, 0, 'nothing is read before it is asked');
  // Asked twice at once: read once.
  const [one, two] = await Promise.all([fetch(app.url + urlOf(video)), fetch(app.url + urlOf(video)), Promise.resolve().then(() => setTimeout(release, 50))]);
  assert.deepEqual([one.status, two.status, reads.length], [200, 200, 1]);
  assert.deepEqual(reads[0], [join(data, 'output', 'clip.mp4'), { pictures: true }]);
  assert.equal(one.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  const film = await one.json();
  assert.deepEqual({ ...film, stripUrl: undefined }, { rate: 12, sound: true, levels: [10, 90], frames: 3, stripUrl: undefined });
  assert.match(film.stripUrl, /^\/media\/strips\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/0\?key=[0-9a-f]{64}$/);
  const strip = await fetch(app.url + film.stripUrl);
  assert.deepEqual([strip.status, strip.headers.get('content-type')], [200, 'image/jpeg']);
  assert.deepEqual(Buffer.from(await strip.arrayBuffer()), STRIP);
  // Kept: asked again, nothing is read; a sound has its wave and no pictures.
  assert.equal((await fetch(app.url + urlOf(video))).status, 200);
  const heard = await (await fetch(app.url + urlOf(sound))).json();
  assert.deepEqual(heard, { rate: 12, sound: true, levels: [40], frames: 0 });
  assert.deepEqual(reads.map(([path, options]) => [path.endsWith('son.wav'), options.pictures]), [[false, true], [true, false]]);
  // Its key is its own: another take's, or none, is refused.
  const other = urlOf(sound).split('?')[1];
  assert.equal((await fetch(app.url + urlOf(video).split('?')[0] + '?' + other)).status, 401);
  assert.equal((await fetch(app.url + film.stripUrl.split('?')[0])).status, 401);
  assert.equal((await fetch(app.url + urlOf(video), { method: 'POST' })).status, 405);
  // Kept beside the thumbnails, under its name.
  assert.deepEqual((await readdir(join(data, 'thumbnails'))).sort(), [
    `${conversation}.${video}.0.strip.jpg`,
    `${conversation}.${video}.0.wave.json`,
    `${conversation}.${sound}.0.wave.json`,
  ]);
});

test('(0.6.459) a take whose film cannot be read says so, and the next one is read all the same', async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'), { recursive: true });
  await writeFile(join(data, 'output', 'clip.mp4'), 'media');
  const gallery = new Gallery({ historyDir: join(data, 'history') });
  for (const [id, filename] of [
    [video, 'absent.mp4'],
    [sound, 'clip.mp4'],
  ])
    await gallery.put(
      {
        id,
        conversationId: conversation,
        provider: 'native',
        mediaType: 'video',
        workflowId: 'basic',
        workflowName: 'Basic',
        prompt: 'p',
        parameters: {},
        createdAt: '2026-11-27T10:00:00.000Z',
        outputs: [{ source: { filename, subfolder: '', type: 'output' } }],
      },
      { persist: true },
    );
  let reads = 0;
  const app = await createApplication({
    port: 0,
    dataDir: data,
    takeFilm: async () => {
      reads++;
      return { wave: { rate: 12, sound: false, levels: [] }, strip: STRIP, frames: 3 };
    },
  });
  t.after(() => app.close());
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const listed = await (await fetch(app.url + '/api/gallery/' + conversation + '?images=0', { headers: { Authorization: 'Bearer ' + token } })).json();
  const urlOf = id => listed.runs.find(run => run.id === id).outputs[0].filmUrl;
  const gone = await fetch(app.url + urlOf(video));
  assert.ok(gone.status >= 400, String(gone.status));
  assert.equal(reads, 0, 'its file is not there: nothing to read');
  assert.equal((await fetch(app.url + urlOf(sound))).status, 200);
  assert.equal(reads, 1);
});

test('(0.6.463) a take removed while its film is read leaves no film behind; closing, the application reads no other', async t => {
  const data = await folder(t);
  await mkdir(join(data, 'output'), { recursive: true });
  await writeFile(join(data, 'output', 'clip.mp4'), 'media');
  await writeFile(join(data, 'output', 'son.wav'), 'media');
  const gallery = new Gallery({ historyDir: join(data, 'history') });
  for (const [id, mediaType, filename] of [
    [video, 'video', 'clip.mp4'],
    [sound, 'audio', 'son.wav'],
    [picture, 'video', 'clip.mp4'],
  ])
    await gallery.put(
      {
        id,
        conversationId: conversation,
        provider: 'native',
        mediaType,
        workflowId: 'basic',
        workflowName: 'Basic',
        prompt: 'p',
        parameters: {},
        createdAt: '2026-11-27T10:00:00.000Z',
        outputs: [{ source: { filename, subfolder: '', type: 'output' } }],
      },
      { persist: true },
    );
  const reads = [];
  let release;
  const takeFilm = async (path, options) => {
    reads.push(path);
    await new Promise(resolve => (release = resolve));
    return options.pictures
      ? { wave: { rate: 12, sound: true, levels: [10, 90] }, strip: STRIP, frames: 3 }
      : { wave: { rate: 12, sound: true, levels: [40] }, strip: null, frames: 0 };
  };
  const app = await createApplication({ port: 0, dataDir: data, takeFilm });
  t.after(() => app.close());
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json(),
    auth = { Authorization: 'Bearer ' + token };
  const listed = await (await fetch(app.url + '/api/gallery/' + conversation + '?images=0', { headers: auth })).json();
  const urlOf = id => listed.runs.find(run => run.id === id).outputs[0].filmUrl;
  const until = async (seen, what) => {
    for (const deadline = Date.now() + 5000; !seen(); ) {
      assert.ok(Date.now() < deadline, what);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  // Its film being read, the take is removed: the removal waits for the reading, then its film goes with it.
  const asked = fetch(app.url + urlOf(video));
  await until(() => reads.length === 1, 'its film is being read');
  let removed = false;
  const removal = fetch(app.url + '/api/studio/delete', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: conversation, id: video }),
  }).then(response => ((removed = true), response));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(removed, false, 'the removal waits for the reading');
  release();
  assert.equal((await removal).status, 200);
  assert.equal((await asked).status, 200, 'asked before, it had its film');
  assert.deepEqual(await readdir(join(data, 'thumbnails')), [], 'nothing of the take left');
  assert.ok((await fetch(app.url + urlOf(video))).status >= 400, 'and nothing served');
  assert.equal(reads.length, 1, 'nor read again');
  // Two films asked, the application stops while the first is read: it waits for it, the second is not read.
  const both = [fetch(app.url + urlOf(sound)).catch(() => null)];
  await until(() => reads.length === 2, 'the first is being read');
  both.push(fetch(app.url + urlOf(picture)).catch(() => null));
  await new Promise(resolve => setTimeout(resolve, 100));
  let closed = false;
  const closing = app.close().then(() => (closed = true));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, false, 'the closing waits for the film being read');
  release();
  await closing;
  await Promise.all(both);
  assert.equal(reads.length, 2, 'the one waiting its turn is not read');
  assert.deepEqual((await readdir(join(data, 'thumbnails'))).sort(), [`${conversation}.${sound}.0.wave.json`]);
});

// The Python of the generation engine, when this machine has it (as tests/video-still.mjs).
const python = [
  process.env.ATELIER_PYTHON,
  join(root, 'data', 'runtime', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
].find(path => path && existsSync(path));

test(
  '(0.6.459) a real clip: its wave and its pictures come out through the function the server uses',
  { skip: python ? false : 'the Python environment of the generation engine is not installed here', timeout: 120000 },
  async t => {
    const work = await folder(t),
      clip = join(work, 'clip.mkv'),
      env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', CUDA_VISIBLE_DEVICES: '-1' };
    // 48 frames of 96 × 64 from black to white (two seconds), encoded on the processor. (0.6.463) With its sound: two
    // seconds of a 440 Hz sine, in PCM (a Matroska file, as runner/tests/test_film.py): without it, the only wave that
    // came out was { sound: false, levels: [] }, which waveOf takes without looking at any value.
    const code = [
      'import sys, av, numpy as np',
      "target = av.open(sys.argv[1], 'w')",
      "stream = target.add_stream('mpeg4', rate=24)",
      "stream.width, stream.height, stream.pix_fmt = 96, 64, 'yuv420p'",
      "audio = target.add_stream('pcm_s16le', rate=12000)",
      "audio.layout = 'mono'",
      'for index in range(48):',
      '    pixels = np.full((64, 96, 3), round(255 * index / 47), dtype=np.uint8)',
      "    for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format='rgb24')):",
      '        target.mux(packet)',
      'for packet in stream.encode():',
      '    target.mux(packet)',
      'samples = np.round(0.5 * np.sin(2 * np.pi * 440 * np.arange(24000) / 12000) * 32767).astype(np.int16)',
      'for start in range(0, samples.size, 1024):',
      "    frame = av.AudioFrame.from_ndarray(samples[start : start + 1024].reshape(1, -1), format='s16', layout='mono')",
      '    frame.sample_rate = 12000',
      '    for packet in audio.encode(frame):',
      '        target.mux(packet)',
      'for packet in audio.encode():',
      '    target.mux(packet)',
      'target.close()',
    ].join('\n');
    await runEnvironmentCommand(python, ['-s', '-c', code, clip], { cwd: root, env });
    const data = join(work, 'data'),
      service = new GenerationService({ root, dataDir: data, workflowDir: join(data, 'workflow'), outputDir: join(data, 'output') });
    service.config.pythonPath = python;
    const started = performance.now();
    const film = await service.takeFilm(clip);
    t.diagnostic(`film read in ${Math.round(performance.now() - started)} ms`);
    // Twelve values a second for its two seconds, none silent: its sound heard through Python, its JSON and waveOf.
    assert.deepEqual([film.wave.rate, film.wave.sound, film.wave.levels.length], [12, true, 24]);
    assert.ok(film.wave.levels.every(level => level > 0), film.wave.levels.join(' '));
    assert.equal(film.frames, 4);
    assert.deepEqual(imageSize(film.strip), { width: 4 * 124, height: 124 });
    assert.deepEqual(await readdir(join(data, 'runtime', 'tmp')), []);
    const text = join(work, 'notes.mp4');
    await writeFile(text, 'not a video');
    await assert.rejects(service.takeFilm(text), error => {
      assert.doesNotMatch(error.message, /Traceback|File "/);
      assert.ok(error.message.length > 3 && !error.message.includes('\n'));
      return true;
    });
  },
);
