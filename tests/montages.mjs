import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MONTAGE_LIMITS,
  Montages,
  assemblyOf,
  montageSeconds,
  montageSizes,
  newMontage,
  planStarts,
  validateMontage,
} from '../lib/montages.mjs';

// (0.6.136) The first step of the montage (the user's request of 19/11, « une timeline, une vraie
// cette fois »): takes of a project laid by hand, kept as a file of the project.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const take = n => ({ conversationId: C, runId: id(n), output: 0 });
const film = (changes = {}) => ({
  ...newMontage({ name: 'Le pêcheur à l’aube', id: id(900), now: '2026-11-20T03:00:00.000Z' }),
  plans: [
    { id: id(1), source: take(12), kind: 'video', from: 0, to: 5 },
    { id: id(2), source: take(14), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
    { id: id(3), source: take(9), kind: 'image', to: 2 },
  ],
  sounds: [{ id: id(4), source: take(16), track: 'music', at: 0, from: 0, to: 30, volume: 0.4 }],
  ...changes,
});

test('a new montage is empty, at the usual size of its format, 24 frames a second (0.6.136)', () => {
  const fresh = newMontage({ now: '2026-11-20T03:00:00.000Z' });
  assert.deepEqual(
    [fresh.name, fresh.format, fresh.width, fresh.height, fresh.fps, fresh.plans, fresh.sounds, fresh.createdAt],
    ['Sans titre', '16:9', 1344, 768, 24, [], [], '2026-11-20T03:00:00.000Z'],
  );
  assert.match(fresh.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    ['9:16', '1:1'].map(format => [newMontage({ format }).width, newMontage({ format }).height]),
    [
      [768, 1344],
      [1024, 1024],
    ],
  );
  // The sizes offered are those of the format the other pages know, without the smallest drafts.
  assert.deepEqual(montageSizes('16:9').map(size => size.width), [512, 768, 1024, 1344, 1600, 1920]);
  assert.deepEqual(montageSizes('7:5'), []);
  assert.throws(() => newMontage({ format: '7:5' }), /Format de bobine inconnu/);
});

test('a montage is kept as it is said, plans end to end: nothing else is carried over (0.6.136)', () => {
  const kept = validateMontage({ ...film(), extra: 'x', plans: film().plans.map(plan => ({ ...plan, note: 'x' })) });
  assert.equal(kept.extra, undefined);
  // (0.6.149) Without instants (a file of before), each is given its own, end to end.
  assert.deepEqual(kept.plans[0], { id: id(1), at: 0, source: take(12), kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 });
  assert.deepEqual(kept.plans[1], { id: id(2), at: 5, source: take(14), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 });
  // An image starts at 0 and has no sound of its own.
  assert.deepEqual(kept.plans[2], { id: id(3), at: 8, source: take(9), kind: 'image', from: 0, to: 2, frame: 'fit' });
  assert.equal(montageSeconds(kept), 10);
  assert.deepEqual(planStarts(kept), [0, 5, 8]);
  // (0.6.149) With them, each where it is said, a hole between two; one over the plan before it goes after it.
  const holed = validateMontage(film({ plans: film().plans.map((plan, at) => ({ ...plan, at: [0, 7, 8.2][at] })) }));
  assert.deepEqual([planStarts(holed), montageSeconds(holed)], [[0, 7, 10], 12]);
  // A plan to make keeps the mark of a suite; anything else than yes or no is refused.
  const todo = { id: id(6), at: 12, kind: 'video', todo: { prompt: 'Il se lève.', suite: true }, from: 0, to: 2, frame: 'fit', volume: 1 };
  assert.deepEqual(validateMontage(film({ plans: [...film().plans, todo] })).plans[3], todo);
  assert.equal('suite' in validateMontage(film({ plans: [...film().plans, { ...todo, todo: { prompt: '', suite: false } }] })).plans[3].todo, false);
  assert.throws(() => validateMontage(film({ plans: [{ ...todo, todo: { prompt: '', suite: 'oui' } }] })), /Prise 1 : suite invalide/);
  // What the page computes by dragging is rounded to the millisecond: no 0.30000000000000004.
  const dragged = validateMontage(film({ plans: [{ id: id(1), source: take(1), kind: 'video', from: 0.1 + 0.2, to: 1.3004 }] }));
  assert.deepEqual([dragged.plans[0].from, dragged.plans[0].to, montageSeconds(dragged)], [0.3, 1.3, 1]);
});

test('a take or a sound brought to its shortest, a tenth of a second, is kept: the bobine is not refused (relecture du 21/11)', () => {
  // As far as the page lets an edge go (withItemChanged: from + 0.1). In floating point 1.083 − 0.983 is
  // 0.0999…: the whole bobine could not be kept any more, « Prise 1 : sa durée va de 0.1 à 600 secondes ».
  for (const [from, to] of [
    [0.983, 1.083],
    [7.65, 7.75],
    [11.271, 11.371],
  ]) {
    const kept = validateMontage(
      film({
        plans: [{ id: id(1), source: take(1), kind: 'video', from, to }],
        sounds: [{ id: id(4), source: take(16), track: 'effects', at: 0, from, to, volume: 1 }],
      }),
    );
    assert.deepEqual([kept.plans[0].from, kept.plans[0].to, kept.sounds[0].from, kept.sounds[0].to], [from, to, from, to]);
  }
  // Shorter is still refused, to the millisecond.
  assert.throws(() => validateMontage(film({ plans: [{ id: id(1), source: take(1), kind: 'video', from: 7.65, to: 7.749 }] })), /Prise 1 : sa durée/);
  assert.throws(() => validateMontage(film({ sounds: [{ ...film().sounds[0], from: 7.65, to: 7.749 }] })), /Son 1 : trop court/);
});

test('what cannot be a montage is refused in the user’s words (0.6.136)', () => {
  const plan = film().plans[0],
    sound = film().sounds[0];
  for (const [changes, said] of [
    [{ name: '  ' }, /nom de la bobine/],
    [{ name: 'x'.repeat(81) }, /nom de la bobine/],
    [{ format: '7:5' }, /Format de bobine inconnu/],
    [{ width: 1000 }, /n’est pas une taille du format 16:9/],
    [{ fps: 16 }, /Cadence/],
    [{ schemaVersion: 2 }, /Version de bobine inconnue/],
    [{ plans: [{ ...plan, to: 0.05 }] }, /Prise 1 : sa durée va de 0.1 à 600 secondes/],
    [{ plans: [{ ...plan, from: 3, to: 2 }] }, /Prise 1 : sa durée/],
    [{ plans: [{ ...plan, kind: 'audio' }] }, /Prise 1 : ni vidéo ni image/],
    [{ plans: [{ ...plan, kind: 'image', from: 1, to: 3 }] }, /une image commence à 0/],
    [{ plans: [{ ...plan, frame: 'stretch' }] }, /cadre invalide/],
    [{ plans: [{ ...plan, volume: 3 }] }, /volume invalide/],
    [{ plans: [{ ...plan, source: { conversationId: C, runId: '../x' } }] }, /Prise 1 : prise invalide/],
    [{ plans: [{ ...plan, at: -1 }] }, /Prise 1 : durée invalide/],
    [{ plans: [{ ...plan, at: '5' }] }, /Prise 1 : durée invalide/],
    [{ plans: [plan, { ...film().plans[1], id: plan.id }] }, /même identifiant/],
    [{ plans: Array.from({ length: MONTAGE_LIMITS.plans + 1 }, (_, n) => ({ ...plan, id: id(n + 1) })) }, /au plus 200 prises/],
    [{ sounds: [{ ...sound, track: 'voice' }] }, /Son 1 : piste inconnue/],
    [{ sounds: [{ ...sound, at: -1 }] }, /Son 1 : durée invalide/],
    [{ sounds: [{ ...sound, to: 0 }] }, /Son 1 : trop court/],
  ])
    assert.throws(() => validateMontage(film(changes)), said, JSON.stringify(changes).slice(0, 80));
  for (const wrong of [null, [], 'x']) assert.throws(() => validateMontage(wrong), /Bobine invalide/);
});

test('the montages of a project are files of it: kept, listed, read, and set aside rather than destroyed (0.6.136)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(await montages.list(project), []);
  const first = await montages.save(project, film());
  assert.deepEqual(JSON.parse(await readFile(join(dir, project, id(900) + '.json'), 'utf8')), first);
  // Saved again: the date it was made stays, the date it was changed moves, whatever the page sends.
  await new Promise(done => setTimeout(done, 15));
  const again = await montages.save(project, { ...film({ name: 'Autre nom' }), createdAt: '2001-01-01T00:00:00.000Z', updatedAt: '2001-01-01T00:00:00.000Z' });
  assert.equal(again.createdAt, first.createdAt);
  assert.ok(again.updatedAt > first.updatedAt);
  await montages.save(project, newMontage({ id: id(901) }));
  const listed = await montages.list(project);
  assert.deepEqual(listed.map(item => item.id), [id(901), id(900)], 'the last changed first');
  assert.deepEqual(
    { ...listed[1], updatedAt: '' },
    { id: id(900), name: 'Autre nom', format: '16:9', plans: 3, sounds: 1, seconds: 10, updatedAt: '' },
  );
  assert.deepEqual(await montages.read(project, id(900)), again);
  // A file that is no montage (left by a copy, a hand) hides nothing of the others.
  // (0.6.352) One of a bobine that cannot be read is said as such; a file of another name is no bobine.
  await writeFile(join(dir, project, id(902) + '.json'), '{ not json');
  await writeFile(join(dir, project, 'notes.json'), '{}');
  assert.deepEqual(
    (await montages.list(project)).map(item => item.name).sort(),
    ['Autre nom', 'Bobine illisible', 'Sans titre'],
  );
  // Another project sees none of them; « inbox » is a project as the others.
  assert.deepEqual(await montages.list('inbox'), []);
  await assert.rejects(montages.read('inbox', id(900)), { status: 404 });
  await assert.rejects(montages.list('../autre'), /Projet invalide/);
  await assert.rejects(montages.read(project, '../' + id(900)), /identifiant invalide/);
  // Removed: out of the list, its file set aside, never deleted.
  assert.deepEqual(await montages.remove(project, id(900)), { removed: id(900) });
  assert.deepEqual((await montages.list(project)).filter(item => !item.unreadable).map(item => item.id), [id(901)]);
  await assert.rejects(montages.read(project, id(900)), { status: 404 });
  const aside = await readdir(join(dir, project, 'corbeille'));
  assert.equal(aside.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, project, 'corbeille', aside[0]), 'utf8')).name, 'Autre nom');
  await assert.rejects(montages.remove(project, id(900)), { status: 404 });
});

test('the montages of a project that goes follow its takes, as they are, and write over nothing (0.6.289)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222',
    names = async where => (await montages.list(where)).map(item => item.name).sort(),
    files = async (...parts) => (await readdir(join(dir, ...parts)).catch(() => null))?.sort() ?? null;
  // A bobine put in the Archives, one that is not, one set aside, a file nobody reads, a note left by a hand.
  await montages.save(project, film(), { archive: true });
  await montages.save(project, film({ name: 'Le pêcheur, changé depuis', plans: film().plans.slice(0, 1) }));
  await montages.save(project, newMontage({ id: id(901), name: 'La seconde' }));
  await montages.save(project, newMontage({ id: id(903), name: 'Mise de côté' }));
  await montages.remove(project, id(903));
  await writeFile(join(dir, project, id(902) + '.json'), '{ not json');
  await writeFile(join(dir, project, 'notes.json'), '{}');
  // Where they arrive: a bobine of the same identifier as the second, and a file of the same name set aside.
  await montages.save('inbox', newMontage({ id: id(901), name: 'Déjà là' }));
  const [asideName] = await files(project, 'corbeille');
  await montages.save('inbox', newMontage({ id: id(903), name: 'Autre, mise de côté' }));
  await montages.remove('inbox', id(903));
  const there = join(dir, 'inbox', 'corbeille');
  await rename(join(there, (await files('inbox', 'corbeille'))[0]), join(there, asideName));
  const archived = await readFile(join(dir, project, id(900) + '.json'), 'utf8'),
    card = (await montages.list(project)).find(item => item.id === id(900)).archived;
  assert.deepEqual([card.plans, card.seconds], [3, 10], 'the card of the Archives is the bobine as it was put there');
  assert.deepEqual(await montages.uses('inbox'), new Map());

  assert.deepEqual(await montages.moveProject(project, 'inbox'), { moved: 3 });
  // The bobine of the Archives: the same file, byte for byte, its card with it.
  assert.equal(await readFile(join(dir, 'inbox', id(900) + '.json'), 'utf8'), archived);
  assert.deepEqual((await montages.list('inbox')).find(item => item.id === id(900)).archived, card);
  // The one whose identifier was taken: both are there, the one that came under another identifier.
  assert.deepEqual(await names('inbox'), ['Bobine illisible', 'Déjà là', 'La seconde', 'Le pêcheur, changé depuis']);
  assert.equal((await montages.read('inbox', id(901))).name, 'Déjà là');
  const came = (await montages.list('inbox')).find(item => item.name === 'La seconde');
  assert.notEqual(came.id, id(901));
  assert.equal((await montages.read('inbox', came.id)).id, came.id, 'its file says its new identifier');
  // The file nobody reads came as it was; those set aside too, none over another.
  assert.equal(await readFile(join(dir, 'inbox', id(902) + '.json'), 'utf8'), '{ not json');
  assert.deepEqual(await files('inbox', 'corbeille'), [asideName.replace('.json', '-2.json'), asideName].sort());
  const aside = await Promise.all(
    (await files('inbox', 'corbeille')).map(async name => JSON.parse(await readFile(join(there, name), 'utf8')).name),
  );
  assert.deepEqual(aside.sort(), ['Autre, mise de côté', 'Mise de côté']);
  // What uses a take is known again where its takes are now (« Supprimer la prise 12 ? »).
  assert.deepEqual((await montages.uses('inbox')).get(C + '/' + id(12)), ['Le pêcheur, changé depuis']);
  // Of the project, only what was not a bobine is left; nothing of it is listed any more.
  assert.deepEqual([await files(project), await montages.list(project)], [['notes.json'], []]);

  // Asked again (a deletion stopped, then asked anew), for the same place, or for a project that has none: nothing.
  assert.deepEqual(await montages.moveProject(project, 'inbox'), { moved: 0 });
  assert.deepEqual(await montages.moveProject('inbox', 'inbox'), { moved: 0 });
  assert.deepEqual(await montages.moveProject('33333333-3333-4333-8333-333333333333', 'inbox'), { moved: 0 });
  assert.equal((await montages.list('inbox')).length, 4);
  await assert.rejects(montages.moveProject('../autre', 'inbox'), /Projet invalide/);
  // A project that held bobines only leaves no folder behind.
  const other = '44444444-4444-4444-8444-444444444444';
  await montages.save(other, newMontage({ id: id(904), name: 'Seule' }));
  await montages.remove(other, id(904));
  await montages.save(other, newMontage({ id: id(905), name: 'Dernière' }));
  assert.deepEqual(await montages.moveProject(other, 'inbox'), { moved: 1 });
  assert.equal(await files(other), null);
  // An unreadable file whose identifier is taken comes under another name, as it is.
  const third = '55555555-5555-4555-8555-555555555555';
  await mkdir(join(dir, third));
  await writeFile(join(dir, third, id(905) + '.json'), '{ not json either');
  assert.deepEqual(await montages.moveProject(third, 'inbox'), { moved: 1 });
  assert.equal((await montages.read('inbox', id(905))).name, 'Dernière');
  const kept = (await files('inbox')).filter(name => name.endsWith('.json')),
    raw = await Promise.all(kept.map(name => readFile(join(dir, 'inbox', name), 'utf8')));
  assert.equal(raw.filter(text => text === '{ not json either').length, 1);
});

test('what the engine assembles is the montage with the file of each take (0.6.136)', async () => {
  const asked = [];
  const fileOf = async (source, label) => {
    asked.push(label);
    return `D:\\sorties\\${source.runId.slice(0, 8)}.mp4`;
  };
  const late = { id: id(5), source: take(17), track: 'effects', at: 12, from: 0, to: 3, volume: 1 };
  const made = await assemblyOf(validateMontage(film({ sounds: [...film().sounds, late] })), fileOf);
  assert.deepEqual(made, {
    width: 1344,
    height: 768,
    fps: 24,
    plans: [
      { path: 'D:\\sorties\\00000012.mp4', at: 0, kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
      { path: 'D:\\sorties\\00000014.mp4', at: 5, kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
      { path: 'D:\\sorties\\00000009.mp4', at: 8, kind: 'image', from: 0, to: 2, frame: 'fit', volume: 1 },
    ],
    // (A sound that starts after the end of the film, 10 s, is not part of it.)
    sounds: [{ path: 'D:\\sorties\\00000016.mp4', at: 0, from: 0, to: 30, volume: 0.4 }],
  });
  // (0.6.345) Each plan named by its instants, as the page shows them.
  assert.deepEqual(asked, ['Prise de 00.00 à 05.00', 'Prise de 05.00 à 08.00', 'Prise de 08.00 à 10.00', 'Son 1']);
  // (0.6.149) With holes, each plan says its instant to the engine (runner/video/montage.py makes the
  // holes black and silent); a sound in a hole is part of the film.
  const holed = validateMontage(film({ plans: film().plans.map((plan, at) => ({ ...plan, at: [1, 7, 12][at] })), sounds: [late] }));
  const withHoles = await assemblyOf(holed, fileOf);
  assert.deepEqual([withHoles.plans.map(plan => plan.at), withHoles.sounds.map(sound => sound.at)], [[1, 7, 12], [12]]);
  await assert.rejects(assemblyOf(newMontage(), fileOf), /aucune prise/);
  // A take that is gone stops the export with the plan that names it.
  const gone = async (source, label) => {
    throw new Error(`${label} : cette prise n’existe plus.`);
  };
  await assert.rejects(assemblyOf(validateMontage(film()), gone), /Prise de 00.00 à 05.00 : cette prise n’existe plus/);
});

test('the film of a montage is assembled from the files of its takes and kept as a take of the conversation (0.6.136)', async () => {
  const { exportMontage, takeFiles } = await import('../lib/montage-export.mjs');
  const project = '22222222-2222-4222-8222-222222222222',
    runs = new Map([12, 14, 9, 16].map(n => [id(n), { id: id(n), outputs: [{ source: { filename: `prise-${n}.mp4`, subfolder: 'video', type: 'output' } }] }])),
    kept = [];
  const gallery = {
    get: async (conversationId, runId) => runs.get(runId) ?? Promise.reject(Object.assign(new Error('gone'), { status: 404 })),
    put: async (record, options) => (kept.push([record, options]), { ...record, outputs: record.outputs.map(output => ({ ...output, take: 18 })) }),
  };
  const fileOf = takeFiles({ project, gallery, pathOf: async source => `D:/sorties/${source.subfolder}/${source.filename}`, projectOf: async () => project });
  const asked = [];
  const assemble = async (request, options) => {
    asked.push(request);
    options.onProgress({ stage: 'assembling film' });
    return { jobId: request.id, outputs: [{ filename: request.outputName + '.mp4', subfolder: 'video', type: 'output', width: 1344, height: 768 }], metadata: {} };
  };
  const told = [],
    times = [new Date('2026-11-20T03:00:00.000Z'), new Date('2026-11-20T03:00:02.500Z')];
  const saved = await exportMontage({
    montage: validateMontage(film()),
    conversationId: C,
    fileOf,
    assemble,
    gallery,
    persist: true,
    onProgress: value => told.push(value.stage),
    id: id(500),
    name: '2026-11-20_03-00-00_bobine_ab12',
    now: () => times.shift(),
  });
  // The engine is asked for the film of the montage, each plan by its file.
  assert.deepEqual(asked[0].plans.map(plan => plan.path), ['D:/sorties/video/prise-12.mp4', 'D:/sorties/video/prise-14.mp4', 'D:/sorties/video/prise-9.mp4']);
  assert.deepEqual([asked[0].id, asked[0].outputName, asked[0].width, asked[0].fps, asked[0].sounds.length], [id(500), '2026-11-20_03-00-00_bobine_ab12', 1344, 24, 1]);
  assert.deepEqual(told, ['assembling film']);
  // The film is a video of the conversation, named by its montage, with what tells its length.
  const [[record, options]] = kept;
  assert.deepEqual(options, { persist: true });
  assert.deepEqual(
    { ...record, parameters: undefined },
    {
      mediaType: 'video',
      provider: 'native',
      id: id(500),
      conversationId: C,
      workflowId: 'montage',
      workflowName: 'Bobine',
      prompt: 'Le pêcheur à l’aube',
      parameters: undefined,
      createdAt: '2026-11-20T03:00:02.500Z',
      outputs: [{ source: { filename: '2026-11-20_03-00-00_bobine_ab12.mp4', subfolder: 'video', type: 'output', width: 1344, height: 768 }, width: 1344, height: 768 }],
    },
  );
  assert.deepEqual(record.parameters, { montage: id(900), plans: 3, sounds: 1, seconds: 10, width: 1344, height: 768, fps: 24, frames: 240, generation_duration_ms: 2500 });
  assert.equal(saved.outputs[0].take, 18);
  // A take that is gone, or of another project, stops the export by the plan that names it; nothing is kept.
  const lacking = validateMontage(film({ plans: [{ id: id(1), source: take(77), kind: 'video', from: 0, to: 2 }], sounds: [] }));
  await assert.rejects(exportMontage({ montage: lacking, conversationId: C, fileOf, assemble, gallery }), /Prise de 00.00 à 02.00 : cette prise n’existe plus/);
  const elsewhere = takeFiles({ project, gallery, pathOf: async () => 'x', projectOf: async () => 'inbox' });
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf: elsewhere, assemble, gallery }), /Prise de 00.00 à 05.00 : cette prise est d’un autre projet/);
  const unreadable = takeFiles({ project, gallery, pathOf: async () => Promise.reject(new Error('no file')), projectOf: async () => project });
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf: unreadable, assemble, gallery }), /Prise de 00.00 à 05.00 : cette prise n’existe plus/);
  await assert.rejects(exportMontage({ montage: validateMontage(film()), conversationId: C, fileOf, assemble: async () => ({ outputs: [] }), gallery }), /n’a pas rendu de film/);
  assert.equal(kept.length, 1);
});

// ---- 0.6.154, lot 5 de la Bobine -----------------------------------------------------------------------

test('« Enregistrer » puts the bobine in the Archives as it is then; what changes after it leaves that version as it was (0.6.154)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222';
  // Kept on its own: not in the Archives.
  await montages.save(project, film());
  assert.equal('archived' in (await montages.read(project, id(900))), false);
  assert.equal('archived' in (await montages.list(project))[0], false);
  // « Enregistrer »: the bobine as it is now, and when.
  const put = await montages.save(project, film(), { archive: true });
  const { name, format, width, height, fps, plans, sounds } = put;
  assert.deepEqual(put.archived, { at: put.updatedAt, name, format, width, height, fps, plans, sounds });
  // Changed after it, kept on its own: what is in the Archives stays as it was, whatever the page sends of it.
  const changed = await montages.save(project, { ...film({ name: 'Autre nom', plans: [] }), archived: { at: '2001-01-01T00:00:00.000Z', name: 'Faux', plans: [] } });
  assert.deepEqual([changed.name, changed.plans.length, changed.archived], ['Autre nom', 0, put.archived]);
  assert.deepEqual((await montages.read(project, id(900))).archived, put.archived);
  // Nor for a bobine never put there: what the page sends of a version is never taken.
  const { name: _, ...content } = put.archived;
  await montages.save(project, { ...newMontage({ id: id(901) }), archived: { ...content, name: 'Faux', at: '2001-01-01T00:00:00.000Z' } });
  assert.equal('archived' in (await montages.read(project, id(901))), false);
  // Listed with what the Archives show of it: when, how long, how many takes, the first two made.
  const listed = (await montages.list(project)).find(item => item.id === id(900));
  assert.deepEqual(listed.archived, { at: put.archived.at, seconds: 10, plans: 3, pictures: [take(12), take(14)] });
  assert.equal(listed.name, 'Autre nom');
  // A version that cannot be read any more is left out; the bobine itself stays.
  const kept = JSON.parse(await readFile(join(dir, project, id(900) + '.json'), 'utf8'));
  await writeFile(join(dir, project, id(900) + '.json'), JSON.stringify({ ...kept, archived: { ...kept.archived, fps: 7 } }));
  const read = await montages.read(project, id(900));
  assert.deepEqual([read.name, 'archived' in read], ['Autre nom', false]);
});

test('« Un seul fichier »: the film is named after its bobine (0.6.154)', async () => {
  const { exportMontage } = await import('../lib/montage-export.mjs');
  const asked = [];
  await exportMontage({
    montage: validateMontage(film()),
    conversationId: C,
    fileOf: async source => `D:/sorties/video/${source.runId}.mp4`,
    assemble: async request => (asked.push(request), { outputs: [{ filename: request.outputName + '.mp4', subfolder: 'video', type: 'output' }] }),
    gallery: { put: async record => record },
  });
  assert.match(asked[0].outputName, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_le-pecheur-a-l-aube_[0-9a-f]{4}$/);
});

test('« Un fichier par prise »: the takes made, each alone, numbered in a folder of their own under BOBINES; none written over (0.6.154)', async t => {
  const { exportTakes } = await import('../lib/montage-export.mjs');
  const { folderName } = await import('../public/montage-model.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'moodix-bobines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const asked = [],
    labels = [];
  const assemble = async (request, options) => {
    asked.push({ request, options });
    return { outputs: [{ filename: request.exportTo.split('/').pop(), subfolder: request.exportTo.split('/').slice(0, 2).join('/'), type: 'export' }] };
  };
  const fileOf = async (source, label) => (labels.push(label), `D:/sorties/video/${source.runId}.mp4`);
  // A take to create between two made, a hole before the last: they are left out, and each is alone in its file.
  const montage = validateMontage(
    film({
      plans: [
        { id: id(1), source: take(12), kind: 'video', from: 1, to: 4, frame: 'fill', volume: 0.5 },
        { id: id(2), kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 2 },
        { id: id(3), at: 8, source: take(9), kind: 'image', to: 2 },
      ],
    }),
  );
  let count = 0;
  const done = await exportTakes({ montage, fileOf, assemble, outputDir: dir, id: () => id(600 + count), name: () => `2026-11-20_03-00-0${count++}_bobine_ab12` });
  assert.deepEqual(done, { folder: 'bobines/Le pêcheur à l’aube', files: ['01.mp4', '02.mp4'] });
  assert.deepEqual(labels, ['Prise de 00.00 à 03.00', 'Prise de 08.00 à 10.00']);
  assert.deepEqual(asked.map(({ request }) => [request.id, request.outputName, request.exportTo, request.width, request.fps, request.sounds, request.plans.map(plan => [plan.at, plan.kind, plan.from, plan.to, plan.frame, plan.volume])]), [
    [id(600), '2026-11-20_03-00-00_bobine_ab12', 'bobines/Le pêcheur à l’aube/01.mp4', 1344, 24, [], [[0, 'video', 1, 4, 'fill', 0.5]]],
    [id(601), '2026-11-20_03-00-01_bobine_ab12', 'bobines/Le pêcheur à l’aube/02.mp4', 1344, 24, [], [[0, 'image', 0, 2, 'fit', 1]]],
  ]);
  // Its folder there already: the next free one.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'bobines', 'Le pêcheur à l’aube'), { recursive: true });
  await mkdir(join(dir, 'bobines', 'Le pêcheur à l’aube 2'));
  assert.equal((await exportTakes({ montage, fileOf, assemble, outputDir: dir })).folder, 'bobines/Le pêcheur à l’aube 3');
  assert.match(asked.at(-1).request.outputName, /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_bobine_[0-9a-f]{4}$/);
  // Ten takes and more: two figures; a hundred: three.
  const many = validateMontage(film({ plans: Array.from({ length: 100 }, (_, at) => ({ id: id(1000 + at), source: take(12), kind: 'video', from: 0, to: 1 })), sounds: [] }));
  const hundred = await exportTakes({ montage: many, fileOf, assemble, outputDir: dir });
  assert.deepEqual([hundred.files[0], hundred.files.at(-1)], ['001.mp4', '100.mp4']);
  // Nothing made yet: refused in the user's words.
  const none = validateMontage(film({ plans: [{ id: id(2), kind: 'video', todo: { prompt: '' }, from: 0, to: 2 }], sounds: [] }));
  await assert.rejects(exportTakes({ montage: none, fileOf, assemble, outputDir: dir }), /Aucune prise de cette bobine n’est encore créée/);
  // The folder, as Windows takes it.
  assert.deepEqual(['Le renard / l’hiver ?', 'CON', '  ', 'Fin…  .'].map(folderName), ['Le renard l’hiver', 'Bobine CON', 'Bobine', 'Fin…']);
});

test('« Un fichier par prise » that cannot be done leaves no folder half filled (0.6.344)', async t => {
  const { exportTakes } = await import('../lib/montage-export.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'moodix-bobines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The engine writes each file where it is asked, and stops on the `broken`-th (none at 0).
  const asked = [];
  let broken = 0;
  const assemble = async request => {
    asked.push(request.exportTo);
    // (Its folder is made before it encodes, as the engine does.)
    const path = join(dir, ...request.exportTo.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    if (asked.length === broken) throw new Error('Film assembly failed: disque plein');
    await writeFile(path, 'mp4');
    return { outputs: [{ filename: path.split(/[\\/]/).pop(), subfolder: 'bobines', type: 'export' }] };
  };
  const gone = new Set();
  const fileOf = async (source, label) => {
    if (gone.has(source.runId)) throw new Error(`${label} : cette prise n’existe plus.`);
    return `D:/sorties/video/${source.runId}.mp4`;
  };
  const montage = validateMontage(film()),
    folder = join(dir, 'bobines', 'Le pêcheur à l’aube'),
    there = path => readdir(path).then(names => names.sort(), () => null);
  // The third take gone: refused before the first file is encoded, and no folder.
  gone.add(id(9));
  await assert.rejects(exportTakes({ montage, fileOf, assemble, outputDir: dir }), /cette prise n’existe plus/);
  assert.deepEqual([asked, await there(join(dir, 'bobines'))], [[], null]);
  gone.clear();
  // The engine stops on the second file: the first goes with its folder; the next export takes its name.
  broken = 2;
  await assert.rejects(exportTakes({ montage, fileOf, assemble, outputDir: dir }), /disque plein/);
  assert.deepEqual([asked.length, await there(folder)], [2, null]);
  // On the very first one, its folder made and nothing in it: that folder goes too.
  broken = 1;
  asked.length = 0;
  await assert.rejects(exportTakes({ montage, fileOf, assemble, outputDir: dir }), /disque plein/);
  assert.deepEqual([asked.length, await there(folder)], [1, null]);
  broken = asked.length = 0;
  const done = await exportTakes({ montage, fileOf, assemble, outputDir: dir });
  assert.deepEqual(done, { folder: 'bobines/Le pêcheur à l’aube', files: ['01.mp4', '02.mp4', '03.mp4'] });
  // A folder there before is never touched: the export goes to the next one, and only that one goes.
  broken = 3;
  asked.length = 0;
  await assert.rejects(exportTakes({ montage, fileOf, assemble, outputDir: dir }), /disque plein/);
  assert.deepEqual([await there(folder), await there(folder + ' 2')], [['01.mp4', '02.mp4', '03.mp4'], null]);
});

test('a take not found is named by its instants, as the page shows them, not by its place (0.6.345)', async t => {
  const { exportMontage, exportTakes, takeFiles } = await import('../lib/montage-export.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'moodix-bobines-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The 13th take of the project is gone; the page shows it « Prise introuvable », from 12 to 17 s, after a
  // take to create: « Prise 4 », its place, is the name the page gives to the 4th take of the project.
  const takes = [11, 12, 13].map(n => ({ id: id(n), source: take(n), kind: 'video', from: 0, to: 5 })),
    todo = { id: id(20), kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 2 },
    found = runId => (runId === id(13) ? Promise.reject(new Error('gone')) : { outputs: [{ source: runId }] }),
    gallery = { get: async (_, runId) => found(runId) },
    pathOf = async source => `D:/sorties/${source}.mp4`,
    fileOf = takeFiles({ project: 'inbox', gallery, pathOf, projectOf: async () => 'inbox' }),
    assemble = async () => ({ outputs: [{ filename: 'x.mp4' }] });
  const montage = validateMontage(film({ plans: [todo, ...takes], sounds: [] }));
  await assert.rejects(exportTakes({ montage, fileOf, assemble, outputDir: dir }), {
    message: 'Prise de 12.00 à 17.00 : cette prise n’existe plus.',
  });
  // The film, its takes made: from 10 to 15 s.
  const made = validateMontage(film({ plans: takes, sounds: [] }));
  await assert.rejects(exportMontage({ montage: made, conversationId: C, fileOf, assemble, gallery }), {
    message: 'Prise de 10.00 à 15.00 : cette prise n’existe plus.',
  });
});

test('an unreadable bobine is not written over, and goes to the corbeille as it is when asked (0.6.351)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222',
    path = n => join(dir, project, id(n) + '.json'),
    bytes = () => Promise.all([900, 901].map(n => readFile(path(n), 'utf8')));
  // A file damaged (a hand, a disk) and one a rule of today refuses, while the page holds what it read before.
  await mkdir(join(dir, project));
  await writeFile(path(900), `{"schemaVersion": 1, "id": "${id(900)}", "name": `);
  await writeFile(path(901), JSON.stringify({ ...film({ id: id(901) }), format: '2.39:1' }));
  const before = await bytes();
  for (const [n, said] of [
    [900, /abîmé/],
    [901, /Format de bobine inconnu/],
  ]) {
    await assert.rejects(montages.save(project, film({ id: id(n) })), { status: 409, message: /ne se lit plus/ });
    await assert.rejects(montages.save(project, film({ id: id(n) }), { archive: true }), { status: 409 });
    await assert.rejects(montages.read(project, id(n)), { status: 400, message: said });
  }
  assert.deepEqual(await bytes(), before, 'nothing written over them');
  // Asked to go: each set aside as it is, as any bobine.
  for (const n of [900, 901]) assert.deepEqual(await montages.remove(project, id(n)), { removed: id(n) });
  const aside = join(dir, project, 'corbeille'),
    names = (await readdir(aside)).sort();
  assert.deepEqual(
    names.map(name => name.slice(0, 36)),
    [id(900), id(901)],
  );
  assert.deepEqual(await Promise.all(names.map(name => readFile(join(aside, name), 'utf8'))), before);
  await assert.rejects(montages.remove(project, id(900)), { status: 404 });
  await assert.rejects(montages.remove(project, '../' + id(900)), { status: 400, message: /identifiant invalide/ });
  // Its place free, the bobine the page holds is kept there anew.
  assert.equal((await montages.save(project, film())).name, 'Le pêcheur à l’aube');
});

test('an unreadable bobine is listed as such, by its name, not gone without a word (0.6.352)', async t => {
  const { stat } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'moodix-montages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const montages = new Montages({ dir }),
    project = '22222222-2222-4222-8222-222222222222',
    path = n => join(dir, project, id(n) + '.json'),
    bytes = () => Promise.all([901, 902, 903].map(n => readFile(path(n), 'utf8')));
  await montages.save(project, film(), { archive: true });
  // Cut short (a disk), refused by a rule of today, without a name it still says; then a file of no bobine.
  await writeFile(path(901), `{"schemaVersion": 1, "id": "${id(901)}", "name": "L\\u2019aube", "plans": [`);
  await writeFile(path(902), JSON.stringify({ ...film({ id: id(902), name: 'Ancienne règle' }), format: '2.39:1' }));
  await writeFile(path(903), '{ not json');
  await writeFile(join(dir, project, 'notes.json'), '{}');
  const before = await bytes(),
    listed = await montages.list(project);
  assert.deepEqual(listed.map(({ id, name, unreadable = false }) => [id, name, unreadable]).sort(), [
    [id(900), 'Le pêcheur à l’aube', false],
    [id(901), 'L’aube (illisible)', true],
    [id(902), 'Ancienne règle (illisible)', true],
    [id(903), 'Bobine illisible', true],
  ]);
  // Said with the date of its file; no card of the Archives; nothing of it touched.
  assert.equal(listed.find(item => item.id === id(903)).updatedAt, (await stat(path(903))).mtime.toISOString());
  assert.deepEqual(
    listed.filter(item => item.archived).map(item => item.id),
    [id(900)],
  );
  assert.deepEqual(await bytes(), before);
});
