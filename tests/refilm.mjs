import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { family } from '../lib/families.mjs';
import { ownSettings, resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { REFILM_SAID, clipOf, refilmBounds, refilmCamera, refilmFormat, refilmParameters, refilmSheet } from '../lib/refilm.mjs';
import { STUDIO_VERBS } from '../lib/studio.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ModelDownloads } from '../lib/model-downloads.mjs';
import { clipSeconds } from '../public/take-length.mjs';
import { ToolRuntime } from '../lib/tool-runtime.mjs';
import { ORBIT_WARNS, orbitArgs, orbitBounds, orbitDraft, orbitOf } from '../public/camera-orbit.mjs';

// (0.6.242) « Changer la caméra » of a video made (refilm_video): the clip filmed again by LTX 2.5 and the
// CrossView-Warp IC-LoRA from a camera the user places by hand in the Studio (public/camera-orbit.mjs).
const TASKS = JSON.parse(readFileSync(new URL('../lib/tasks.json', import.meta.url), 'utf8'));
const folder = new URL('../runner/workflows/', import.meta.url);
const shipped = readdirSync(folder)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(new URL(name, folder), 'utf8')));
const REFILM_ID = 'e33b1ff7-519a-4678-83ff-db6ae4b0459e';
const plain = shipped.find(workflow => workflow.id === REFILM_ID);
const manifest = family('ltx25_refilm');
const bounds = refilmBounds(manifest);
const id = 'a1111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const INTENTION = 'Caméra changée, demandée dans le Studio.';
const LONG = 'Vidéo trop longue : à cette taille, la caméra se change jusqu’à 5 s.';

/** The workflows as the catalog lists them: all ready, or « Changer la caméra » with `own` (its files missing). */
const listed = (own = {}) =>
  shipped.map(workflow => ({ ...workflow, ready: true, builtin: true, ...(workflow.id === REFILM_ID ? own : {}) }));
const lacking = {
  ready: false,
  unavailableKind: 'files',
  unavailableReason: 'Fichier manquant : LTX2.3-22B_IC-LoRA-CrossView-Warp_v2_6000.safetensors.',
};
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));
const call = args => ({ id: 'refilm-call', type: 'function', function: { name: 'refilm_video', arguments: JSON.stringify(args) } });
/** What the Studio sends (public/studio.mjs): the take, the camera of its tool, the intention. */
const asked = camera => ({ source: { output: SOURCE }, ...camera, intention: INTENTION });
const held = pose => asked({ camera: pose });

/**
 * A runtime over the shipped workflows, whose jobs are resolved as the catalog of Moodix resolves them, and a
 * take of LTX 2.5 to film again (`clip`: what its record says otherwise). What the engine is given is in `jobs`,
 * the takes kept in `saved`, the progress shown while it runs in `shown`.
 */
function runtimeFor({ clip = {}, own = {}, offerOf, jobs = [], saved = [], shown = [] } = {}) {
  const valid = validateNativeWorkflow(plain),
    list = listed(own),
    assets = { resolve: async asset => ({ path: join(tmpdir(), asset) }), read: async () => null };
  const record = {
    provider: 'native',
    mediaType: 'video',
    prompt: 'A fisherman casts his line at dawn.',
    workflowName: 'LTX 2.5',
    outputs: [{ source: { filename: 'pecheur.mp4' }, width: 768, height: 448 }],
    parameters: { pipeline: 'ltx25', width: 768, height: 448, frames: 121, fps: 24 },
    ...clip,
  };
  const runtime = new ToolRuntime({
    engine: { state: 'ready', stop: async () => {}, start: async () => {} },
    catalog: {
      list: async () => list,
      read: async workflowId => (workflowId === REFILM_ID ? valid : list.find(workflow => workflow.id === workflowId)),
      prepare: async (_id, args, options) => ({
        workflow: valid,
        job: await resolveNativeWorkflow(plain, args, assets, options),
        outputNodes: [],
      }),
    },
    gallery: {
      get: async () => structuredClone(record),
      put: async take => {
        saved.push(take);
        return take;
      },
    },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 9, baseUrl: 'native' }),
    engineConfig: () => ({}),
    sourceMedia: async () => ({ mime: 'video/mp4', name: 'pecheur.mp4', handle: { close: async () => {} } }),
    ...(offerOf ? { offerOf } : {}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      stage: async media => {
        await media.handle.close();
        return { path: join(tmpdir(), 'pecheur.mp4') };
      },
      preflight: async job => {
        jobs.push(structuredClone(job));
      },
      run: async (_job, { onProgress }) => {
        onProgress({ stage: 'estimating depth', frame: 30, frames: 121 });
        shown.push(runtime.status().progress);
        onProgress({ stage: 'drawing new camera', frame: 0, frames: 121 });
        shown.push(runtime.status().progress);
        return { outputs: [{ filename: 'refilmed.mp4', subfolder: '', type: 'output' }] };
      },
      free: async () => {},
    }),
  });
  const ask = (args, options = {}) =>
    runtime.request([call(args)], { conversationId: id, turnId: id, messages: [], byHand: true, ...options });
  return { runtime, ask };
}

test('« Changer la caméra » is a verb of the user’s hand, shipped as a model of its own (0.6.242)', () => {
  const task = TASKS.refilm_video;
  assert.deepEqual([task.output, task.hand, task.prompt], ['video', true, undefined]);
  assert.deepEqual(Object.keys(task.roles), ['source']);
  assert.deepEqual(task.roles.source.media, ['video']);
  assert.ok(STUDIO_VERBS.includes('refilm_video'));
  const { digest, ...valid } = validateNativeWorkflow(plain);
  assert.deepEqual(valid, plain);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(ownSettings(plain), plain);
  assert.equal(plain.name, 'Changer la caméra (LTX 2.5)');
  assert.deepEqual(plain.references, [{ id: 'source', role: 'refilm_source', required: true, name: 'Vidéo à refilmer' }]);
  // Its size and its length are the clip's (set by the server); its prompt is the word its LoRA was taught;
  // the rest is fixed, and its camera is no setting of the model: it is placed in the Studio.
  const p = plain.parameters;
  assert.deepEqual(
    Object.keys(p).filter(key => p[key].policy === 'model'),
    ['width', 'height', 'frames'],
  );
  assert.equal(p.prompt.value, 'crossview');
  assert.ok(Object.values(plain.components).every(component => component.policy === 'fixed'));
  for (const key of ['azimuth', 'elevation', 'distance', 'start_azimuth', 'pivot_x']) assert.equal(p[key], undefined, key);
  // The bounds of its camera are those the Studio draws, and the clips it takes are of 12 to 120 frames a second.
  assert.deepEqual(bounds, { ...orbitBounds(manifest.refilm), sourceFps: { min: 12, max: 120 } });
  assert.equal(bounds.distance.unavailable, 'La distance ne marche pas encore avec ce modèle : son auteur le dit.');
  assert.equal(refilmBounds(family('ltx25')), null);
});

test('the Studio shows it with the bounds of its camera, greyed without its files, and Moodix AI never has it (0.6.242)', async () => {
  const catalog = new ToolCatalog({ list: async () => listed() });
  const tools = await catalog.studio();
  assert.equal(tools.refilm_video.length, 1);
  const [tool] = tools.refilm_video;
  assert.equal(tool.id, REFILM_ID);
  assert.deepEqual(tool.refilm, manifest.refilm);
  // No setting: those of its model are on the page of the model; no size and no length: the clip's.
  assert.deepEqual(tool.settings, []);
  assert.equal(tool.follows, true);
  for (const key of ['lengths', 'limits', 'size', 'unavailable']) assert.equal(tool[key], undefined, key);
  assert.ok(tools.create_video.every(entry => entry.refilm === undefined));
  // The button of a take: a video.
  assert.deepEqual((await catalog.actions()).refilm_video, ['video']);
  const offered = (await catalog.definitions()).map(definition => definition.function.name);
  assert.ok(offered.includes('create_video'));
  assert.ok(!offered.includes('refilm_video'));
  // Without its files: shown greyed with its reason (its download is on the page of the model), no button on a
  // take, and still never offered to Moodix AI, not even to fetch them.
  const missing = new ToolCatalog({ list: async () => listed(lacking) });
  const [greyed] = (await missing.studio()).refilm_video;
  assert.deepEqual([greyed.id, greyed.unavailable], [REFILM_ID, lacking.unavailableReason]);
  assert.deepEqual((await missing.actions()).refilm_video, []);
  assert.ok(!(await missing.definitions()).some(definition => definition.function.name === 'refilm_video'));
});

test('Moodix AI cannot ask for it: the catalog routes it for the user’s hand only (0.6.242)', async () => {
  const catalog = new ToolCatalog({ list: async () => listed() });
  const media = { mediaOf: async () => 'video', originOf: async () => null };
  const args = { source: { output: SOURCE }, intention: INTENTION };
  await assert.rejects(catalog.route('refilm_video', args, media), {
    status: 400,
    message: 'refilm_video se demande à la main, dans le Studio.',
  });
  const routed = await catalog.route('refilm_video', args, { ...media, byHand: true });
  assert.equal(routed.workflow.id, REFILM_ID);
  assert.deepEqual(routed.args.references, [{ input: 'source', output_id: SOURCE }]);
});

test('a clip is filmed again from the camera placed in the Studio, and its take keeps that camera (0.6.242)', async () => {
  const jobs = [],
    saved = [],
    shown = [];
  const { runtime, ask } = runtimeFor({ jobs, saved, shown });
  const draft = orbitDraft(
    { mode: 'move', start: { azimuth: 0, elevation: 0, distance: 1 }, end: { azimuth: 30, elevation: 10, distance: 1 } },
    bounds,
  );
  const request = await ask(asked(orbitArgs(draft)));
  await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const [job] = jobs;
  assert.equal(job.pipeline, 'ltx25_refilm');
  assert.deepEqual(pick(job.parameters, ['prompt', 'width', 'height', 'frames', 'fps', 'steps', 'hfov', 'lora_strength']), {
    prompt: 'crossview',
    width: 768,
    height: 448,
    frames: 121,
    fps: 24,
    steps: 8,
    hfov: 50,
    lora_strength: 1,
  });
  assert.deepEqual(
    pick(job.parameters, ['azimuth', 'elevation', 'distance', 'start_azimuth', 'start_elevation', 'start_distance']),
    { azimuth: 30, elevation: 10, distance: 1, start_azimuth: 0, start_elevation: 0, start_distance: 1 },
  );
  assert.equal(job.parameters.pivot_x, undefined);
  assert.deepEqual(
    job.references.map(ref => [ref.role, ref.path]),
    [['refilm_source', join(tmpdir(), 'pecheur.mp4')]],
  );
  // While it is made: its stages with the frames done.
  assert.deepEqual(shown, ['Profondeur de la vidéo · 30/121', 'Dessin de la vidéo vue de la nouvelle caméra…']);
  // The take: the same scene (the prompt of its clip), its camera kept for the Studio to put back in its tool.
  const [take] = saved;
  assert.equal(take.prompt, 'A fisherman casts his line at dawn.');
  assert.deepEqual(take.parameters.refilm, {
    camera: { azimuth: 30, elevation: 10, distance: 1 },
    camera_start: { azimuth: 0, elevation: 0, distance: 1 },
  });
  assert.deepEqual(pick(orbitOf(take.parameters, bounds), ['mode', 'start', 'end']), pick(draft, ['mode', 'start', 'end']));
});

test('what is not made is said in words before anything is proposed (0.6.242)', async () => {
  const { ask } = runtimeFor();
  const fine = { azimuth: 30, elevation: 10, distance: 1 };
  await assert.rejects(ask(held(fine), { byHand: false }), { message: REFILM_SAID.hand });
  await assert.rejects(ask({ ...held(fine), source: { resource: 'r1' } }), { message: REFILM_SAID.taken });
  await assert.rejects(ask({ ...held(fine), source: { output: SOURCE, frame: 3 } }), { message: REFILM_SAID.taken });
  await assert.rejects(ask(held({ azimuth: 80, elevation: 40, distance: 1 })), { message: ORBIT_WARNS.out });
  await assert.rejects(ask(held({ azimuth: 3, elevation: 2, distance: 1 })), { message: ORBIT_WARNS.near });
  await assert.rejects(ask(asked({ camera: { azimuth: 3, elevation: 0 }, camera_start: { azimuth: 2, elevation: 1 } })), {
    message: ORBIT_WARNS.near,
  });
  await assert.rejects(ask(held({ ...fine, distance: 1.5 })), { message: bounds.distance.unavailable });
  await assert.rejects(ask(held({ ...fine, azimuth: '30' })), { message: REFILM_SAID.invalid });
  await assert.rejects(ask(held({ ...fine, roll: 5 })), { message: REFILM_SAID.invalid });
  await assert.rejects(ask(asked({})), { message: 'Caméra : la position de la caméra manque.' });
  await assert.rejects(ask({ ...held(fine), pivot: { x: 1.5, y: 0.5 } }), { message: REFILM_SAID.pivot });
  // The prompt is the clip's: none is taken.
  await assert.rejects(ask({ ...held(fine), prompt: 'A heron takes off.' }));
  // What its record says of the clip: too large, too long, at a rate the model does not take, or unknown.
  for (const [clip, said] of [
    [{ outputs: [{ width: 1088, height: 1920 }], parameters: { width: 1088, height: 1920, frames: 121, fps: 24 } }, 'Vidéo trop grande pour changer sa caméra.'],
    [{ parameters: { width: 768, height: 448, frames: 241, fps: 24 } }, LONG],
    [
      { parameters: { width: 768, height: 448, frames: 41, fps: 8 } },
      'Cette vidéo est à 8 images par seconde : la caméra se change sur une vidéo de 12 à 120 images par seconde.',
    ],
    [{ outputs: [{}], parameters: { frames: 121, fps: 24 } }, REFILM_SAID.unknown],
    [{ mediaType: 'image' }, null],
    // (0.6.243) A continuation of 4 s after a clip of 4 s: its file plays 7 s, though its job made 3,4 s.
    [{ parameters: { width: 768, height: 448, frames: 81, fps: 24, continuation: { overlapFrames: 9, sourceFrames: 97, newFrames: 72 } } }, LONG],
  ]) {
    const { ask: asking } = runtimeFor({ clip });
    await assert.rejects(asking(held(fine)), said ? { message: said } : Error, JSON.stringify(clip));
  }
  // A continuation within the limits is filmed again whole: the clip it continues, then what it adds.
  const jobs = [],
    { runtime, ask: asking } = runtimeFor({
      clip: { parameters: { width: 768, height: 448, frames: 33, fps: 24, continuation: { overlapFrames: 9, sourceFrames: 97, newFrames: 24 } } },
      jobs,
    });
  const proposal = await asking(held(fine));
  await runtime.execute({ requestId: proposal.requestId, permission: 'once', approvalToken: proposal.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.equal(jobs[0].parameters.frames, 121);
});

test('without its two files, a request offers to fetch them, with their sizes and licences (0.6.242)', async () => {
  // The files of LTX 2.5 are here; those of the LoRA and of the depth are not. The list of downloads is the one
  // Moodix ships (runner/downloads.json).
  const absent = new Set([plain.components.guideLora.asset, plain.components.depth.asset]),
    nowhere = join(tmpdir(), 'moodix-refilm-test-absent');
  const downloads = new ModelDownloads({
    catalogPath: new URL('../runner/downloads.json', import.meta.url),
    dataDir: nowhere,
    assets: {
      resolve: async asset => {
        if (absent.has(asset)) throw new Error(`Asset ${asset} not found`);
        return { path: join(nowhere, asset) };
      },
    },
    folderOf: (_family, role) => join(nowhere, role),
  });
  const offerOf = async workflow => (await downloads.offers([workflow]))[workflow.id] ?? null;
  const { ask } = runtimeFor({ own: lacking, offerOf });
  const answer = await ask(held({ azimuth: 30, elevation: 10, distance: 1 }));
  assert.deepEqual(pick(answer, ['tool', 'workflowName', 'mediaType', 'approvalToken']), {
    tool: 'refilm_video',
    workflowName: 'Changer la caméra (LTX 2.5)',
    mediaType: 'video',
    approvalToken: undefined,
  });
  const { missing } = answer;
  assert.equal(missing.workflowId, REFILM_ID);
  assert.deepEqual(
    missing.files.map(file => [file.role, file.file, file.size, file.license.name, file.license.restricted]),
    [
      ['guideLora', 'LTX2.3-22B_IC-LoRA-CrossView-Warp_v2_6000.safetensors', 327287384, 'Apache-2.0', false],
      ['depth', 'moge_2_vitl_normal_fp16.safetensors', 661859924, 'MIT', false],
    ],
  );
  assert.deepEqual([missing.bytes, missing.left, missing.needsToken], [989147308, 989147308, false]);
  // Its attribution goes with the LoRA, as its licence asks.
  assert.match(missing.files[0].license.url, /ATTRIBUTION\.md$/);
  // Without any of its files, all have a source: the files of LTX 2.5 are those of its own models.
  absent.clear();
  for (const component of Object.values(plain.components)) absent.add(component.asset);
  const whole = await offerOf({ ...listed(lacking).find(workflow => workflow.id === REFILM_ID) });
  assert.equal(whole.complete, true);
  assert.equal(whole.files.length, 6);
});

test('on its proposal its camera may change, never its clip, its size or its length (0.6.242)', async () => {
  const jobs = [];
  const { runtime, ask } = runtimeFor({ jobs });
  const first = await ask(held({ azimuth: 30, elevation: 10, distance: 1 }));
  const edit = (proposal, edits) =>
    runtime.revise({ requestId: proposal.requestId, approvalToken: proposal.approvalToken, edits });
  for (const edits of [{ width: 640 }, { frames: 81 }, { references: [] }]) await assert.rejects(edit(first, edits), { message: REFILM_SAID.edited });
  await assert.rejects(edit(first, { camera: { azimuth: 80, elevation: 40, distance: 1 } }), { message: ORBIT_WARNS.out });
  const run = async proposal => {
    await runtime.execute({ requestId: proposal.requestId, permission: 'once', approvalToken: proposal.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
  };
  const turned = await edit(first, { camera: { azimuth: -40, elevation: 5, distance: 1 } });
  // A proposal changed is another one: the one before is gone.
  await assert.rejects(edit(first, { camera: { azimuth: 20, elevation: 0, distance: 1 } }), {
    message: 'Cet appel a expiré. Relancez la demande.',
  });
  await run(await edit(turned, { camera_start: { azimuth: 0, elevation: 0, distance: 1 }, pivot: { x: 0.3, y: 0.6 } }));
  // `camera_start: null`: held again, around the same point.
  const again = await ask({
    ...asked({ camera: { azimuth: -40, elevation: 5, distance: 1 }, camera_start: { azimuth: 0, elevation: 0, distance: 1 } }),
    pivot: { x: 0.3, y: 0.6 },
  });
  await run(await edit(again, { camera_start: null }));
  assert.deepEqual(pick(jobs[0].parameters, ['azimuth', 'elevation', 'start_azimuth', 'pivot_x', 'pivot_y', 'frames']), {
    azimuth: -40,
    elevation: 5,
    start_azimuth: 0,
    pivot_x: 0.3,
    pivot_y: 0.6,
    frames: 121,
  });
  assert.deepEqual(pick(jobs[1].parameters, ['azimuth', 'start_azimuth', 'pivot_x']), {
    azimuth: -40,
    start_azimuth: undefined,
    pivot_x: 0.3,
  });
});

test('the camera, the format and the sheet of a clip, as the engine reads them (lib/refilm.mjs, 0.6.242)', () => {
  // Held, moving, or around a point of the first frame; a pose without its distance is as far as the clip's.
  assert.deepEqual(refilmCamera({ camera: { azimuth: 30, elevation: 10 } }, bounds), {
    camera: { azimuth: 30, elevation: 10, distance: 1 },
  });
  const moving = refilmCamera(
    { camera: { azimuth: 30, elevation: 10, distance: 1 }, camera_start: { azimuth: 0, elevation: 0, distance: 1 }, pivot: { x: 0.25, y: 0.5 } },
    bounds,
  );
  assert.deepEqual(refilmParameters(moving), {
    azimuth: 30,
    elevation: 10,
    distance: 1,
    start_azimuth: 0,
    start_elevation: 0,
    start_distance: 1,
    pivot_x: 0.25,
    pivot_y: 0.5,
  });
  assert.deepEqual(refilmSheet(moving), moving);
  assert.throws(() => refilmCamera({ camera: { azimuth: 91, elevation: 0 } }, bounds), { message: ORBIT_WARNS.out });
  // The format: the frames at 24 a second its length covers (8n + 1), its size cut to multiples of 32 (as
  // output_format of runner/video/refilm.py, whose tests hold the same numbers).
  assert.deepEqual(refilmFormat({ width: 768, height: 448, frames: 121, fps: 24 }, bounds), { width: 768, height: 448, frames: 121 });
  assert.deepEqual(refilmFormat({ width: 790, height: 435, frames: 100, fps: 24 }, bounds), { width: 768, height: 416, frames: 97 });
  assert.equal(refilmFormat({ width: 768, height: 448, frames: 81, fps: 16 }, bounds).frames, 121);
  assert.equal(refilmFormat({ width: 768, height: 448, frames: 150, fps: 30000 / 1001 }, bounds).frames, 113);
  for (const [width, height] of [[832, 480], [1024, 576], [576, 1024], [1280, 704], [704, 1280]])
    assert.deepEqual(refilmFormat({ width, height, frames: 121, fps: 24 }, bounds), { width, height, frames: 121 });
  for (const [clip, said] of [
    [{ width: 768, height: 448, frames: 121, fps: 7.5 }, 'Cette vidéo est à 7,5 images par seconde : la caméra se change sur une vidéo de 12 à 120 images par seconde.'],
    [{ width: 60, height: 448, frames: 121, fps: 24 }, REFILM_SAID.small],
    [{ width: 768, height: 448, frames: 8, fps: 24 }, REFILM_SAID.short],
    // (0.6.246) Measured up to 1280 × 704 for 5 s (as many pixels standing too): beyond, not given.
    [{ width: 1600, height: 896, frames: 121, fps: 24 }, 'Vidéo trop grande pour changer sa caméra.'],
    [{ width: 1312, height: 704, frames: 57, fps: 24 }, 'Vidéo trop grande pour changer sa caméra.'],
    [{ width: 1280, height: 704, frames: 133, fps: 24 }, LONG],
    [{ width: 768, height: 448, frames: 133, fps: 24 }, LONG],
    [{ width: 768, height: 448, frames: 121, fps: null }, REFILM_SAID.unknown],
  ])
    assert.throws(() => refilmFormat(clip, bounds), { message: said }, JSON.stringify(clip));
  // What a record says of its clip: its file first, then its parameters; the rate of a chain of smoothings.
  const record = { outputs: [{ width: 1536, height: 896 }], parameters: { width: 768, height: 448, frames: 121, fps: 24 } };
  assert.deepEqual(clipOf(record), { width: 1536, height: 896, frames: 121, fps: 24 });
  assert.deepEqual(clipOf({ ...record, parameters: { frames: 241 } }, 0, { width: 768, height: 448, fps: 48 }), {
    width: 768,
    height: 448,
    frames: 241,
    fps: 48,
  });
  // (0.6.243) The length the Studio refuses with (clipSeconds): a continuation counts the clip it continues, as
  // its file does (a record of 21/11: 241 frames made, 241 + 232 in the file).
  const continued = { frames: 241, fps: 24, continuation: { overlapFrames: 9, sourceFrames: 241, newFrames: 232 } };
  assert.equal(clipOf({ outputs: [{ width: 1024, height: 1024 }], parameters: continued }).frames, 473);
  for (const parameters of [continued, record.parameters, { frames: 81, fps: 16 }, { ...continued, continuation: { overlapFrames: 9 } }]) {
    const clip = clipOf({ parameters });
    assert.equal(clip.frames / clip.fps, clipSeconds(parameters), JSON.stringify(parameters));
  }
});
