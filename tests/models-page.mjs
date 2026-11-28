import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS, licenseSentence, lineOf, linesOf, progressShare, progressText, sizeText, speedOf, versionData } from '../public/models-page.mjs';
import { preparationBytes } from '../lib/python-environment.mjs';

const GIB = 1024 ** 3;
// (0.6.506) The engine of a new installation as the server says it on Windows (measured on 27/11): « 2,1 Go ».
const ENGINE = preparationBytes('win32');
const record = (id, more = {}) => ({ id, name: id, pipeline: 'ltx25', mediaType: 'video', enabled: true, ready: true, ...more });
const model = (...workflows) => ({ name: 'LTX 2.5', does: 'Vidéos et prolongations.', group: 'video', order: 1, workflows });
const offer = (bytes, more = {}) => ({ files: [], bytes, left: bytes, complete: true, ...more });
const idle = { offers: {}, job: { state: 'idle' } };

test('the page « Modèles » has four groups, in its order (0.6.119)', () => {
  assert.deepEqual(GROUPS, [['image', 'Image'], ['video', 'Vidéo'], ['audio', 'Son'], ['retouch', 'Retouches']]);
});

test('a line says the version its model uses; what is in its way decides the rest, the first thing first', () => {
  const versions = [
    { name: 'Distillé', format: 'INT8', used: false },
    { name: 'Uncensored v1.1', format: 'FP8', used: true },
  ];
  // Ready: the version used, by its name and its format; a model with one version, the name it is given.
  const ready = lineOf(model({ id: 'a', versions }), [record('a')], idle);
  assert.deepEqual([ready.state, ready.label, ready.note, ready.offer, ready.bytes], ['ready', ['Uncensored v1.1', 'FP8'], '', null, 0]);
  assert.deepEqual(ready.records.map(([entry, workflow]) => [entry.id, workflow.id]), [['a', 'a']]);
  assert.deepEqual(lineOf(model({ id: 'a', version: 'XL' }), [record('a')], idle).label, ['XL']);
  assert.deepEqual(lineOf(model({ id: 'a', versions: [{ name: 'Sans format', used: true }] }), [record('a')], idle).label, ['Sans format']);
  // None of its files here, or none used: nothing to name.
  assert.deepEqual(lineOf(model({ id: 'a', versions: [] }), [record('a')], idle).label, []);
  assert.deepEqual(lineOf(model({ id: 'a', versions: versions.map(item => ({ ...item, used: false })) }), [record('a')], idle).label, []);
  // A workflow that is not listed is no part of the line; a model with none is ready of nothing.
  assert.deepEqual(lineOf(model({ id: 'a' }, { id: 'gone' }), [record('a')], idle).records.length, 1);
  assert.deepEqual([lineOf(model(), [], idle).state, lineOf({ name: 'x' }, undefined, undefined).state], ['ready', 'ready']);

  // To download: every workflow of the model that lacks files Moodix can fetch, their sizes together.
  const lacking = [record('a', { ready: false }), record('b', { ready: false }), record('c')],
    two = model({ id: 'a' }, { id: 'b' }, { id: 'c' }),
    wanted = lineOf(two, lacking, { offers: { a: offer(3 * GIB, { left: GIB }), b: offer(2 * GIB), c: offer(GIB) }, job: { state: 'idle' } });
  assert.deepEqual([wanted.state, wanted.bytes, wanted.offer[0].id, wanted.offer[1].left], ['download', 3 * GIB, 'a', GIB]);
  // (What a ready workflow could fetch is not asked; a file with no known source is no download.)
  assert.equal(lineOf(two, lacking, { offers: { b: offer(2 * GIB) }, job: {} }).offer[0].id, 'b');
  const unknown = lineOf(model({ id: 'a' }), [record('a', { ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' })], { offers: { a: offer(GIB, { complete: false }) }, job: {} });
  assert.deepEqual([unknown.state, unknown.note, unknown.offer], ['problem', 'Fichier introuvable pour « Modèle ».', null]);
  // Under way: said so, whatever else it lacks; another model's download is not this one's.
  const job = { state: 'running', workflowId: 'b', received: 1, total: 2 };
  assert.equal(lineOf(two, lacking, { offers: { a: offer(GIB) }, job }).state, 'downloading');
  assert.equal(lineOf(model({ id: 'a' }), [record('a', { ready: false })], { offers: { a: offer(GIB) }, job }).state, 'download');
  assert.equal(lineOf(two, lacking, { offers: {}, job: { ...job, state: 'done' } }).state, 'waiting');

  // Why it cannot run, under its description: its engine (not its fault), a file, this computer.
  const why = (more, downloads = idle) => lineOf(model({ id: 'a', version: 'XL' }), [record('a', { ready: false, ...more })], downloads);
  assert.deepEqual([why({ unavailableReason: 'Le moteur de génération démarre…' }).state, why({ unavailableReason: 'Le moteur de génération démarre…' }).note], ['waiting', 'Le moteur de génération démarre…']);
  assert.deepEqual([why({}).state, why({}).note], ['waiting', 'Indisponible.']);
  for (const reason of ['Fichier incompatible pour « VAE » : mauvais modèle.', 'Aucun fichier dans le dossier.', 'Choisissez un tokenizer.'])
    assert.deepEqual([why({ unavailableReason: reason }).state, why({ unavailableReason: reason }).note], ['problem', reason]);
  const hardware = why({ unavailableReason: 'Carte NVIDIA requise.', unavailableKind: 'hardware' }, { offers: {}, job: {} });
  assert.deepEqual([hardware.state, hardware.note, hardware.label], ['unavailable', 'Carte NVIDIA requise.', ['XL']]);
  // Not offered to the assistant (« Proposé à Moodix AI » off): said, the version still named.
  const off = lineOf(model({ id: 'a', version: 'XL' }), [record('a', { enabled: false })], idle);
  assert.deepEqual([off.state, off.note, off.label], ['off', 'Pas proposé à Moodix AI : il reste dans le Studio.', ['XL']]);
  assert.equal(why({ enabled: false, unavailableReason: 'Moteur arrêté.' }).note, 'Pas proposé à Moodix AI. Moteur arrêté.');
  assert.equal(why({ enabled: false }).note, 'Pas proposé à Moodix AI. Indisponible.');
  assert.equal(lineOf(model({ id: 'a' }), [record('a', { enabled: false })], { offers: {}, job: { state: 'running', workflowId: 'a' } }).state, 'downloading');
  // (0.6.270) Not offered and its files to fetch: « Télécharger » all the same, the switch says it is off.
  // Qwen-Image-Edit and Wan 2.2 Caméra are shipped off: said « off » first, they could never be downloaded.
  const fetched = lineOf(model({ id: 'a' }), [record('a', { enabled: false, ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' })], { offers: { a: offer(31 * GIB) }, job: { state: 'idle' } });
  assert.deepEqual([fetched.state, fetched.offer?.[0].id, fetched.bytes], ['download', 'a', 31 * GIB]);
  // Off, its files missing and nowhere to fetch them from: said why, as before.
  assert.equal(why({ enabled: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' }).note, 'Pas proposé à Moodix AI. Fichier introuvable pour « Modèle ».');
});

test('(0.6.479) on a new installation, the engine its click prepares is in its size once, and said meanwhile', () => {
  // The user's choice of 27/11 (« Oui, d'un seul clic »): the total on the button.
  const engine = { engine: { bytes: ENGINE } },
    lacking = [record('a', { ready: false }), record('b', { ready: false })],
    line = lineOf(model({ id: 'a' }, { id: 'b' }), lacking, {
      offers: { a: offer(20 * GIB, engine), b: offer(GIB, engine) },
      job: { state: 'idle' },
    });
  assert.deepEqual([line.state, line.bytes], ['download', 21 * GIB + ENGINE]);
  // Its files all here: the engine alone (the friend's Qwen-Image-Edit, downloaded before this version).
  const alone = lineOf(model({ id: 'a' }), [record('a', { ready: false, unavailableReason: 'Moteur arrêté.' })], {
    offers: { a: offer(0, engine) },
    job: {},
  });
  assert.deepEqual([alone.state, alone.bytes], ['download', ENGINE]);
  // Prepared after the files: what it does, in the place of the figures (uv does not tell its bytes).
  const job = {
    state: 'running',
    engine: 'preparing',
    current: 'Démarrage du moteur',
    received: 20 * GIB,
    total: 20 * GIB + ENGINE,
  };
  assert.equal(progressText(job, 5e6), 'Démarrage du moteur');
  assert.equal(progressText({ ...job, current: '' }), 'Préparation du moteur');
  assert.equal(progressText({ ...job, engine: 'waiting', current: 'ltx.safetensors' }), '20,0 / 22,1 Go');
});

test('without lines from the server, a line a workflow, in the group of what it makes', () => {
  const served = [model({ id: 'a' })];
  assert.equal(linesOf(served, [record('a')]), served);
  assert.deepEqual(
    linesOf([], [
      { id: 'k', name: 'Portrait', description: 'Portraits in studio. Avec une image de référence.', pipeline: 'krea2', mediaType: 'image' },
      { id: 'v', name: 'Clip', description: '', pipeline: 'ltx25', mediaType: 'video' },
      { id: 's', name: 'Bruit', pipeline: 'moss_sfx', mediaType: 'audio' },
    ]),
    [
      { name: 'Portrait', does: 'Portraits in studio.', group: 'image', order: 0, workflows: [{ id: 'k', family: 'krea2' }] },
      { name: 'Clip', does: '', group: 'video', order: 0, workflows: [{ id: 'v', family: 'ltx25' }] },
      { name: 'Bruit', does: '', group: 'audio', order: 0, workflows: [{ id: 's', family: 'moss_sfx' }] },
    ],
  );
  assert.deepEqual([linesOf(undefined, undefined), linesOf(null, [])], [[], []]);
});

test('a version says its format and its steps; a size and the advance of a download, as the application writes them', () => {
  assert.deepEqual(versionData({ format: 'INT8', parameters: { steps: 8 } }), ['INT8', '8 étapes']);
  assert.deepEqual(versionData({ format: 'GGUF Q8' }), ['GGUF Q8']);
  assert.deepEqual(versionData({ parameters: { steps: 20 } }), ['20 étapes']);
  assert.deepEqual([versionData({ format: 'FP8', parameters: { steps: '8' } }), versionData(undefined)], [['FP8'], []]);
  // (0.6.479) Always with its decimal, as the Studio and the Bobine write it (« 3,0 Go »).
  assert.deepEqual(
    [sizeText(27.3 * GIB), sizeText(GIB), sizeText(640 * 1024 ** 2), sizeText(1000)],
    ['27,3 Go', '1,0 Go', '640 Mo', '1 Mo'],
  );
  // « 3,4 / 27,3 Go · 14 min » (capture 68): the time left once the speed is known.
  const job = { received: 3.4 * GIB, total: 27.3 * GIB };
  assert.equal(progressText(job), '3,4 / 27,3 Go');
  assert.equal(progressText(job, (23.9 * GIB) / (13.5 * 60)), '3,4 / 27,3 Go · 14 min');
  assert.equal(progressText(job, (23.9 * GIB) / 30), '3,4 / 27,3 Go · 1 min');
  assert.equal(progressText(job, (23.9 * GIB) / (118.5 * 60)), '3,4 / 27,3 Go · 119 min');
  assert.equal(progressText(job, (23.9 * GIB) / (170 * 60)), '3,4 / 27,3 Go · 3 h');
  assert.equal(progressText({ received: 64 * 1024 ** 2, total: 128 * 1024 ** 2 }, 1024 ** 2 * 0.6), '64 / 128 Mo · 2 min');
  // Done, or more than its size: no time left to say; nothing known of its size: nothing said.
  assert.equal(progressText({ received: 2 * GIB, total: GIB }, 5), '1,0 / 1,0 Go');
  assert.deepEqual(
    [progressText({ received: 5 }, 9), progressText(undefined), progressText({ total: GIB }, -1)],
    ['', '', '0 / 1,0 Go'],
  );
  assert.deepEqual([progressShare(job).toFixed(2), progressShare({ received: 5, total: 2 }), progressShare({ received: -1, total: 2 }), progressShare({}), progressShare(undefined)], ['12.45', 100, 0, 0, 0]);
  // The speed: what came since the last look, smoothed with what was known.
  assert.equal(speedOf(null, { at: 1000, received: 50 }), 0);
  assert.equal(speedOf({ at: 0, received: 0 }, { at: 2000, received: 400 }), 200);
  assert.equal(speedOf({ at: 0, received: 0 }, { at: 2000, received: 400 }, 100), 130);
  // (A clock that did not move, a download started again from less: the speed known stays.)
  assert.equal(speedOf({ at: 5, received: 0 }, { at: 5, received: 400 }, 70), 70);
  assert.equal(speedOf({ at: 0, received: 900 }, { at: 1000, received: 400 }, 70), 70);
});

test('the licences of a download in one sentence, for the pointer over « Télécharger »', () => {
  const file = (name, restricted = false, limits = '') => ({ file: name + '.safetensors', license: { name, restricted, limits } });
  assert.equal(licenseSentence([file('Apache-2.0')]), 'Licence : Apache-2.0. En téléchargeant, vous l’acceptez.');
  // (Those with conditions first, as everywhere they are shown: maquette, capture 65.)
  assert.equal(
    licenseSentence([file('Apache-2.0'), file('MIT'), file('SAM License', true)]),
    'Licences : SAM License (à conditions), Apache-2.0 et MIT. En téléchargeant, vous les acceptez.',
  );
  assert.equal(licenseSentence([file('Apache-2.0'), file('MIT')]), 'Licences : Apache-2.0 et MIT. En téléchargeant, vous les acceptez.');
  // The same licence for two files, with a remark of its own for one: named once, with conditions if either has.
  assert.equal(licenseSentence([file('Krea 2 License', false), file('Krea 2 License', true, 'Fichier converti.')]), 'Licence : Krea 2 License (à conditions). En téléchargeant, vous l’acceptez.');
  assert.deepEqual([licenseSentence([]), licenseSentence(undefined), licenseSentence([{ file: 'x' }])], ['', '', '']);
});
