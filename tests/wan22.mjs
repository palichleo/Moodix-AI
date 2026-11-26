import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { ToolCatalog, serves } from '../lib/tool-catalog.mjs';
import { families } from '../lib/families.mjs';
import { matches } from '../lib/generation-assets.mjs';
import { fits, modelsOf, versionComponent } from '../lib/model-files.mjs';
import { isCompanion, recipeOf, versionName } from '../lib/model-versions.mjs';
import { ownSettings, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { isSetting } from '../public/setting-names.mjs';

// (0.6.134) Wan 2.2, image to video, as Moodix ships it: the user's request of 19/11 (« intègre wan2.2 »).
const folder = new URL('../runner/workflows/', import.meta.url);
const shipped = readdirSync(folder)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => ({ ...JSON.parse(readFileSync(new URL(name, folder), 'utf8')), ready: true, builtin: true }));
const wan = shipped.find(workflow => workflow.pipeline === 'wan22');
const catalog = new ToolCatalog({ list: async () => shipped });
const media = { mediaOf: async () => 'image' };
const asked = { prompt: 'The fox turns its head and runs off.', intention: 'Le renard part en courant.' };

test('Wan 2.2 is shipped as a model that animates an image, its settings the user’s own (0.6.134)', () => {
  assert.equal(shipped.filter(workflow => workflow.pipeline === 'wan22').length, 1);
  const { ready, builtin, ...plain } = wan,
    { digest, ...valid } = validateNativeWorkflow(plain);
  assert.deepEqual(valid, plain);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(serves(wan, 'create_video'), true);
  for (const verb of ['extend_video', 'replace_character', 'create_image']) assert.equal(serves(wan, verb), false, verb);
  // An image to start from, and nothing else: the model draws from it.
  assert.deepEqual(wan.references, [{ id: 'start', role: 'start_image', required: true, name: 'Image de début' }]);
  // What Moodix AI may choose: the prompt and the length (the seed is drawn). Every setting has a
  // value of Moodix, which the user alone changes (the rule of 19/11).
  const p = wan.parameters;
  assert.deepEqual(
    Object.keys(p).filter(name => p[name].policy !== 'fixed'),
    ['prompt', 'seed', 'frames'],
  );
  for (const name of Object.keys(p)) if (isSetting(name)) assert.equal(p[name].policy, 'fixed', name);
  assert.deepEqual(ownSettings(plain), plain);
  // (0.6.139) With its step LoRAs (« Lightning », one for each of its two models): four steps and no
  // guidance, where the official configuration takes forty steps at 3.5; its shift and its rate stay.
  assert.deepEqual([p.steps.value, p.cfg.value, p.step_lora_strength.value, p.shift.value, p.fps.value, p.frames.default], [4, 1, 1, 5, 16, 81]);
  assert.deepEqual(Object.keys(wan.components), ['model', 'modelLow', 'textEncoder', 'vae', 'stepLora', 'stepLoraLow']);
  assert.deepEqual([wan.components.stepLora.file, wan.components.stepLoraLow.file].map(file => /high|low/.exec(file)[0]), ['high', 'low']);
  assert.match(p.negative_prompt.value, /^色调艳丽，过曝，静态/);
  // Every length is 4n + 1 frames, as the model draws them.
  assert.ok(p.frames.choices.every(count => count % 4 === 1));
  assert.deepEqual(p.frames.choices, families().wan22.parameters.frames.choices);
});

test('a video that starts on an image still goes to LTX 2.5; Wan 2.2 makes it when it is named (0.6.134)', async () => {
  // (Its only input filled, Wan 2.2 would be « the most specific workflow »: a clip without sound,
  // minutes long to make, in the place of the one the user always had.)
  const usual = await catalog.route('create_video', { ...asked, duration: null, start_image: { image: 0 } }, media);
  assert.equal(usual.workflow.pipeline, 'ltx25');
  assert.ok(families().wan22.preference < 0);
  const named = await catalog.route(
    'create_video',
    { ...asked, duration: 3, workflow: wan.id, start_image: { image: 0 } },
    media,
  );
  assert.equal(named.workflow.id, wan.id);
  // Three seconds at 16 frames a second: 49 frames, the closest length the model draws.
  assert.equal(named.args.frames, 49);
  assert.deepEqual(named.args.references, [{ input: 'start', image: 0 }]);
  // No length asked: its usual five seconds.
  const plain = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 } },
    media,
  );
  assert.equal(plain.args.frames, 81);
  // What it does not take is said, never passed on: a stage (it has one size), steps (a setting).
  const staged = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 }, stage: 'final', steps: 40 },
    media,
  );
  assert.deepEqual([staged.args.stage, staged.args.steps], [undefined, undefined]);
  assert.equal(staged.notes.length, 2, staged.notes.join(' | '));
  // Without an image it cannot draw: another model makes the video, and the user is told.
  const bare = await catalog.route('create_video', { ...asked, duration: null, workflow: wan.id }, media);
  assert.notEqual(bare.workflow.pipeline, 'wan22');
  // (It was said « ne prend pas ces entrées ensemble », of a request that passed none.)
  assert.deepEqual(bare.notes, [`Wan 2.2 ne se fait pas sans « Image de début » : ${bare.workflow.name} est utilisé à la place.`]);
  // With an end image beside the start one, which it does not take: the usual words.
  const framed = await catalog.route(
    'create_video',
    { ...asked, duration: null, workflow: wan.id, start_image: { image: 0 }, end_image: { image: 1 } },
    media,
  );
  assert.deepEqual(framed.notes, ['Wan 2.2 ne prend pas ces entrées ensemble : LTX 2.5 est utilisé à la place.']);
});

test('a chat model reads Wan 2.2 after the models that make a video from words, and none of its settings (0.6.134)', async () => {
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_video').function;
  const at = name => tool.description.indexOf(`: ${name}. `);
  assert.ok(at('Wan 2.2') > at('LTX 2.5') && at('LTX 2.5') > 0 && at('Wan 2.2') > at('MiniMax H3 Omni'));
  assert.match(tool.description, /Wan 2\.2\. Animer une image : .* \(accepts: start_image\)/);
  for (const setting of ['steps', 'cfg', 'shift', 'negative_prompt', 'fps', 'width', 'height'])
    assert.equal(Object.hasOwn(tool.parameters.properties, setting), false, setting);
  // The Studio: after the two others, an image to start from it cannot do without, its lengths.
  // (0.6.223) Wan 2.2 Caméra comes after it, for the user's own hand (see the last test).
  const studio = (await catalog.studio()).create_video;
  assert.deepEqual(studio.map(item => item.family).sort(), ['ltx25', 'minimax_h3', 'pi_h3', 'wan22', 'wan22_camera']);
  assert.deepEqual(studio.slice(-2).map(item => item.family), ['wan22', 'wan22_camera']);
  // (0.6.423) pi H3 behind the usual two as well, before them: it makes a video from words.
  assert.deepEqual(studio.slice(0, 3).map(item => item.family).sort(), ['ltx25', 'minimax_h3', 'pi_h3']);
  assert.equal(studio[2].family, 'pi_h3');
  const own = studio.at(-2);
  assert.equal(own.roles.start_image.required, true);
  assert.deepEqual([own.roles.end_image.count, own.roles.reference.count], [0, 0]);
  assert.deepEqual(own.size, { width: 768, height: 448 });
  assert.deepEqual(own.lengths.seconds, [33, 49, 65, 81].map(count => count / 16));
  assert.equal(own.lengths.standard, 81 / 16);
});

test('the two files of Wan 2.2 are one version: the « low noise » file goes with the « high noise » one (0.6.134)', () => {
  const manifest = families().wan22,
    { role, spec } = versionComponent(manifest);
  assert.equal(role, 'model');
  // What the user's files hold (19/11): 36 channels in, forty blocks, no image encoder.
  const shapes = { 'patch_embedding.weight': [5120, 36, 1, 2, 2], 'blocks.39.self_attn.q.weight': [5120, 5120] };
  assert.equal(fits(shapes, spec.fingerprint), true);
  assert.deepEqual(modelsOf({ shapes }), ['wan22']);
  // Wan 2.1 image to video has an image encoder; text to video takes 16 channels; the 5B model 48.
  assert.deepEqual(modelsOf({ shapes: { ...shapes, 'img_emb.proj.0.weight': [1280] } }), []);
  for (const channels of [16, 48])
    assert.deepEqual(modelsOf({ shapes: { ...shapes, 'patch_embedding.weight': [5120, channels, 1, 2, 2] } }), []);
  const recipe = recipeOf(spec, { shapes });
  assert.equal(recipe.companion.role, 'modelLow');
  const second = file => isCompanion(recipe, { metadata: {} }, file);
  assert.equal(second('wan2.2_i2v_low_int8_convrot.safetensors'), true);
  assert.equal(second('Wan2_2-I2V-A14B-LOW_bf16.safetensors'), true);
  assert.equal(second('wan2.2_i2v_high_int8_convrot.safetensors'), false);
  // (« low » inside another word says nothing.)
  assert.equal(second('wan2.2_i2v_high_noise_slow_motion.safetensors'), false);
  assert.equal(versionName('wan2.2_i2v_high_int8_convrot.safetensors', manifest), 'Image vers vidéo');
  // The formats tried: no FP8 file of Wan 2.2 was, none is promised.
  assert.deepEqual(spec.reads, ['INT8', 'BF16', 'FP16', 'FP32']);
});

test('a file of a shipped model has an identifier of its own family: none is shared between two (0.6.134)', () => {
  // (The registry of the files keeps one family an identifier: Wan 2.2 written with the identifiers
  // of the encoder and the VAE of SCAIL-2, the same files, was « Fichier incompatible » on the
  // first real try.)
  const owners = new Map();
  for (const workflow of shipped)
    for (const entry of [...Object.values(workflow.components ?? {}), ...(workflow.loras ?? [])])
      if (entry.asset) owners.set(entry.asset, (owners.get(entry.asset) ?? new Set()).add(workflow.pipeline));
  const sharedIds = [...owners].filter(([, families]) => families.size > 1).map(([id, families]) => [id, [...families]]);
  assert.deepEqual(sharedIds, []);
  assert.equal(new Set(Object.values(wan.components).map(component => component.asset)).size, 6);
});

test('a file of Wan 2.2 Fun Camera is never taken for Wan 2.2, nor Wan 2.2 for it (0.6.213)', () => {
  // The two files of Fun Camera have every tensor of Wan 2.2's and an adapter that reads the camera
  // (`control_adapter`); converted, they sit in the same folder. Until 0.6.211 each was a version of
  // Wan 2.2 for the page « Modèles », and the file its chooser could pick when Wan 2.2's own was
  // not found (a file is found by its layout, whatever its name): the engine then refused the video.
  const plain = families().wan22,
    fun = families().wan22_camera,
    header = shapes => Object.fromEntries(Object.entries(shapes).map(([name, shape]) => [name, { shape }])),
    wan = { 'patch_embedding.weight': [5120, 36, 1, 2, 2], 'head.head.weight': [64, 5120], 'blocks.39.self_attn.q.weight': [5120, 5120] },
    camera = { ...wan, 'control_adapter.conv.weight': [5120, 1536, 2, 2], 'control_adapter.conv.bias': [5120] };
  for (const role of ['model', 'modelLow']) {
    assert.equal(matches(header(wan), plain.components[role].signature), true, role);
    assert.equal(matches(header(camera), plain.components[role].signature), false, role);
    assert.equal(matches(header(camera), fun.components[role].signature), true, role);
    assert.equal(matches(header(wan), fun.components[role].signature), false, role);
  }
  assert.deepEqual([modelsOf({ shapes: wan }), modelsOf({ shapes: camera })], [['wan22'], ['wan22_camera']]);
  // (An entry marked absent is met by no tensor; without one, a signature reads as before.)
  assert.equal(matches(header(wan), [{ key: '^img_emb\\.', absent: true }]), true);
  assert.equal(matches(header({ ...wan, 'img_emb.proj.0.weight': [1280] }), [{ key: '^img_emb\\.', absent: true }]), false);
  assert.equal(matches(header(wan), []), true);
  // The same engine code runs both (`module`), with the same files beside the two models; the camera
  // is two settings more, a movement the engine knows and a speed.
  assert.equal(fun.module, 'wan22');
  assert.deepEqual(Object.keys(fun.components), Object.keys(plain.components));
  const { camera: move, camera_speed: speed, ...own } = fun.parameters,
    limits = specs => Object.fromEntries(Object.entries(specs).map(([name, { note, ...spec }]) => [name, spec]));
  assert.deepEqual(limits(own), limits(plain.parameters));
  // (0.6.214) Shipped at eight steps where Wan 2.2 takes four (at four a subject the camera moves away
  // from is drawn twice, seen on the real videos of 22/11), and twenty for a video found hard, his
  // words: « on doit pouvoir switch à 20 étapes pour les vidéos difficiles ». Both with the step LoRAs.
  assert.deepEqual([fun.template.parameters.steps.value, plain.template.parameters.steps.value], [8, 4]);
  assert.deepEqual([fun.template.parameters.cfg.value, fun.template.parameters.step_lora_strength.value], [1, 1]);
  assert.deepEqual([own.steps.min, own.steps.max], [4, 50]);
  assert.match(own.steps.note, /^8 avec les LoRA d’étapes .* 20 pour une vidéo difficile/);
  assert.equal(move.choices[0], 'none');
  assert.ok(move.choices.includes('orbit_left') && move.choices.includes('crane_up') && move.choices.includes('pan_left'));
  assert.deepEqual([speed.min, speed.max], [0.25, 4]);
  const { role, spec } = versionComponent(fun);
  assert.deepEqual([role, spec.reads], ['model', ['INT8', 'BF16', 'FP16', 'FP32']]);
  assert.equal(recipeOf(spec, { shapes: camera }).companion.role, 'modelLow');
});

test('Wan 2.2 Caméra is shipped for the Studio: eight steps or twenty, its camera a fixed setting the Studio changes (0.6.223)', async () => {
  // His words of 22/11, on the real videos: « Oui, branche » (the window of the camera on this model),
  // after « ok pas mal, mais on doit pouvoir switch à 20 étapes pour les vidéos difficiles ».
  const made = shipped.filter(workflow => workflow.pipeline === 'wan22_camera');
  assert.equal(made.length, 1);
  const camera = made[0],
    { ready, builtin, ...plain } = camera,
    { digest, ...valid } = validateNativeWorkflow(plain);
  assert.deepEqual(valid, plain);
  assert.equal(camera.name, 'Wan 2.2 Caméra');
  assert.equal(serves(camera, 'create_video'), true);
  assert.deepEqual(camera.references, wan.references);
  // The files of Wan 2.2 beside its two models, each under an identifier of its own (see above).
  assert.deepEqual(Object.keys(camera.components), Object.keys(wan.components));
  for (const role of ['textEncoder', 'vae', 'stepLora', 'stepLoraLow']) {
    assert.equal(camera.components[role].file, wan.components[role].file, role);
    assert.notEqual(camera.components[role].asset, wan.components[role].asset, role);
  }
  assert.deepEqual(
    [camera.components.model.file, camera.components.modelLow.file],
    ['wan2.2_fun_camera_high_noise_14B_int8_convrot.safetensors', 'wan2.2_fun_camera_low_noise_14B_int8_convrot.safetensors'],
  );
  // Every setting has a value of Moodix (the rule of 19/11); the steps are 8, and 20 the only other
  // choice; the camera reads none until the Studio says one, at the speed of the published movements.
  const p = camera.parameters;
  for (const name of Object.keys(p)) if (isSetting(name)) assert.equal(p[name].policy, 'fixed', name);
  assert.deepEqual(p.steps, { policy: 'fixed', value: 8, choices: [8, 20] });
  assert.deepEqual([p.camera, p.camera_speed], [{ policy: 'fixed', value: 'none' }, { policy: 'fixed', value: 1 }]);
  assert.deepEqual([p.cfg.value, p.step_lora_strength.value, p.shift.value, p.fps.value], [1, 1, 5, 16]);
  assert.deepEqual(p.frames, wan.parameters.frames);
  assert.equal(p.negative_prompt.value, wan.parameters.negative_prompt.value);
  // Not offered to Moodix AI as shipped (« Proposé à Moodix AI » off): in the chat its camera would
  // stay at « none », a Wan 2.2 that takes longer. The Studio has it all the same.
  assert.equal(camera.enabled, false);
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_video').function;
  assert.equal(tool.description.includes('Wan 2.2 Caméra'), false);
  const studio = (await catalog.studio()).create_video.find(item => item.family === 'wan22_camera');
  assert.equal(studio.roles.start_image.required, true);
  assert.deepEqual(studio.size, { width: 768, height: 448 });
  assert.equal(studio.lengths.standard, 81 / 16);
  // Its two models are the files a download converts on this computer (lib/model-downloads.mjs).
  const sources = JSON.parse(readFileSync(new URL('../runner/downloads.json', import.meta.url), 'utf8'));
  for (const [role, kind] of [['model', 'high'], ['modelLow', 'low']]) {
    const source = sources[camera.components[role].file];
    assert.equal(source.convert, 'int8', role);
    assert.equal(source.path, `split_files/diffusion_models/wan2.2_fun_camera_${kind}_noise_14B_fp8_scaled.safetensors`);
    assert.deepEqual([source.repo, source.size, source.license.name], ['Comfy-Org/Wan-2.2', 15301408048, 'Apache-2.0']);
    assert.match(source.sha256, /^[0-9a-f]{64}$/);
    assert.match(source.revision, /^[0-9a-f]{40}$/);
  }
  // No other source of the shipped models is one to convert.
  assert.deepEqual(Object.keys(sources).filter(file => sources[file].convert), Object.values(made[0].components).slice(0, 2).map(item => item.file));
});
