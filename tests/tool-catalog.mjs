import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ToolCatalog, serves } from '../lib/tool-catalog.mjs';
import { CAPABLE } from '../lib/model-wording.mjs';

const video = (id, references, extra = {}) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'ltx25',
  mediaType: 'video',
  parameters: {
    prompt: { policy: 'model', type: 'string' },
    stage: { policy: 'model', type: 'string', choices: ['draft', 'final'], default: 'draft' },
    fps: { policy: 'fixed', value: 24 },
  },
  components: {},
  loras: [],
  references,
  ...extra,
});
const image = (id, references = []) => ({
  schemaVersion: 1,
  id,
  name: id,
  description: `Workflow ${id}`,
  enabled: true,
  ready: true,
  pipeline: 'krea2',
  mediaType: 'image',
  parameters: { prompt: { policy: 'model', type: 'string' }, width: { policy: 'fixed', value: 512 } },
  components: {},
  loras: [],
  references,
});
const slot = (id, role, required = false) => ({ id, role, required });
const catalogOf = workflows => new ToolCatalog({ list: async () => workflows });
const media = { mediaOf: async source => (source.output === 'video-run' ? 'video' : 'image') };

const workflows = [
  image('portrait'),
  image('edit', [slot('source', 'img2img', true)]),
  video('t2v', []),
  video('keyframes', [slot('first', 'start_image'), slot('last', 'end_image')]),
  video('subject', [slot('a', 'msr_image'), slot('b', 'msr_image')]),
  video('continue', [slot('clip', 'source_video', true)]),
];

test('the model sees one tool per verb with only the roles some workflow accepts', async () => {
  const tools = Object.fromEntries((await catalogOf(workflows).definitions()).map(t => [t.function.name, t.function]));
  assert.deepEqual(Object.keys(tools).sort(), ['create_image', 'create_video', 'extend_video']);
  const create = tools.create_video.parameters;
  assert.deepEqual(Object.keys(create.properties).sort(), [
    'end_image',
    'intention',
    'prompt',
    'reference',
    'stage',
    'start_image',
    'workflow',
  ]);
  assert.equal(create.properties.reference.maxItems, 2);
  assert.deepEqual(create.required.sort(), ['intention', 'prompt']);
  assert.equal(create.properties.fps, undefined, 'fixed parameters are never exposed');
  assert.deepEqual(tools.extend_video.parameters.required.sort(), ['intention', 'prompt', 'source']);
  assert.match(tools.create_video.description, /keyframes.*accepts: start_image, end_image/);
  assert.equal(serves(workflows[5], 'create_video'), false, 'a required source video excludes plain creation');
});

test('roles choose the most specific workflow, and forcing one is still checked', async () => {
  const tools = catalogOf(workflows);
  const route = (name, args) => tools.route(name, { prompt: 'x', intention: 'y', ...args }, media);
  assert.equal((await route('create_video', {})).workflow.id, 't2v');
  assert.equal((await route('create_video', { start_image: { image: 0 } })).workflow.id, 'keyframes');
  const fl = await route('create_video', { start_image: { image: 0 }, end_image: { resource: 'r1' } });
  assert.deepEqual(fl.args.references, [
    { input: 'first', image: 0 },
    { input: 'last', resource_id: 'r1' },
  ]);
  const refs = await route('create_video', { reference: [{ image: 0 }, { output: 'run', index: 1 }] });
  assert.equal(refs.workflow.id, 'subject');
  assert.deepEqual(refs.args.references[1], { input: 'b', output_id: 'run', output_index: 1 });
  await assert.rejects(
    route('create_video', { reference: [{ image: 0 }, { image: 1 }, { image: 2 }] }),
    /Aucun workflow/,
  );
  // A named workflow that cannot take the images gives way to one that can, and says so.
  const moved = await route('create_video', { workflow: 'subject', start_image: { image: 0 } });
  assert.equal(moved.workflow.id, 'keyframes');
  assert.match(moved.notes.join(), /subject ne prend pas ces entrées ensemble : keyframes/);
  assert.equal((await route('create_video', { workflow: 'keyframes' })).workflow.id, 'keyframes', 'named and able');
  await assert.rejects(route('create_video', { workflow: 'nowhere' }), /ne peut pas exécuter/);
  assert.equal((await route('extend_video', { source: { output: 'video-run' } })).workflow.id, 'continue');
  await assert.rejects(route('extend_video', { source: { image: 0 } }), /Aucun workflow/);
  await assert.rejects(route('extend_video', {}), /needs a source/);
  assert.equal((await tools.route('create_image', { prompt: 'x', source: { image: 0 } }, media)).workflow.id, 'edit');
});

test('a plain image request goes to Krea 2; MOSS Image runs when the model asks for it', async () => {
  // MOSS takes no image at all, so it would win as the "most specific" workflow for a text-only
  // request: the Krea family is preferred instead, as the everyday image model.
  const tools = catalogOf([{ ...image('moss-image'), pipeline: 'moss' }, image('krea', [slot('source', 'img2img')])]);
  assert.equal((await tools.route('create_image', { prompt: 'un chat' }, media)).workflow.id, 'krea');
  // Only a family that says what it is the one for is put forward to the model.
  const choice = (await tools.definitions())[0].function.parameters.properties.workflow.description;
  assert.match(choice, /Omit it to let the application pick.* Pass moss-image for a poster/);
  const videos = await catalogOf(workflows).definitions();
  const video = videos.find(tool => tool.function.name === 'create_video').function.parameters.properties.workflow;
  assert.doesNotMatch(video.description, / Pass /);
  assert.equal(
    (await tools.route('create_image', { prompt: 'une affiche', workflow: 'moss-image' }, media)).workflow.id,
    'moss-image',
  );
});

test('Moodix AI is told to write an instruction for Qwen-Image-Edit only, when it is offered (0.6.282)', async () => {
  const { readFile } = await import('node:fs/promises');
  const qwen = {
    ...JSON.parse(
      await readFile(new URL('../runner/workflows/a7601a5d-e43b-4f4e-8871-2d9dc7138bd9.json', import.meta.url), 'utf8'),
    ),
    ready: true,
  };
  const prompt = async (list, options) =>
    (await catalogOf(list).definitions(undefined, options)).find(tool => tool.function.name === 'create_image').function
      .parameters.properties.prompt.description;
  const whole = await prompt([image('krea')]);
  assert.match(whole, /^The whole image/);
  // (0.6.431) Shipped « Proposé à Moodix AI » on, at the user's word of 26/11. Switched off: not offered,
  // nothing said of it.
  assert.equal(qwen.enabled, true);
  assert.equal(await prompt([image('krea'), { ...qwen, enabled: false }]), whole);
  // Offered beside another model: the whole picture, then its own words, for it alone.
  const offered = qwen;
  const both = await prompt([image('krea'), offered]);
  assert.ok(both.startsWith(whole + ' For a7601a5d-e43b-4f4e-8871-2d9dc7138bd9: An editing instruction in English'), both);
  assert.match(both, /Picture 1 is the image to modify/);
  // Twice (a copy of it): said once, for both.
  assert.match(await prompt([image('krea'), offered, { ...offered, id: 'copy' }]), /For a7601a5d-[^:]+, copy: An editing/);
  // The only model of the verb: its own words alone.
  assert.match(await prompt([offered]), /^An editing instruction in English/);
  // In the words of a capable model, named by its name.
  assert.match(await prompt([image('krea'), offered], { wording: CAPABLE }), / For Qwen-Image-Edit: An editing instruction/);
});

test('MiniMax does not get a start image together with references, even when the model names it', async () => {
  const minimax = {
    ...video('minimax', [slot('s', 'start_image'), slot('e', 'end_image'), slot('r1', 'reference_image')]),
    pipeline: 'minimax_h3',
  };
  const ltx = video('ltx', [slot('first', 'start_image'), slot('a', 'msr_image')]);
  const tools = catalogOf([minimax, ltx]);
  const both = () => ({ prompt: 'x', intention: 'y', start_image: { image: 0 }, reference: [{ image: 1 }] });
  assert.equal((await tools.route('create_video', both(), media)).workflow.id, 'ltx');
  const named = await tools.route('create_video', { ...both(), workflow: 'minimax' }, media);
  assert.equal(named.workflow.id, 'ltx');
  assert.match(named.notes.join(), /minimax ne prend pas ces entrées ensemble/);
  // Alone, MiniMax refuses with the reason instead of failing later in its engine.
  await assert.rejects(catalogOf([minimax]).route('create_video', both(), media), /do not combine/);
  const refs = { prompt: 'x', intention: 'y', reference: [{ image: 1 }], workflow: 'minimax' };
  assert.equal((await tools.route('create_video', refs, media)).workflow.id, 'minimax');
});

test('a MiniMax continuation takes subject references; an LTX one does not yet', async () => {
  const minimax = {
    ...video('minimax-next', [
      slot('clip', 'source_video', true),
      slot('s', 'start_image'),
      slot('r1', 'reference_image'),
      slot('r2', 'reference_image'),
    ]),
    pipeline: 'minimax_h3',
  };
  const ltx = video('ltx-next', [slot('clip', 'source_video', true), slot('a', 'msr_image')]);
  const extendTool = async list =>
    (await catalogOf(list).definitions()).find(tool => tool.function.name === 'extend_video').function.parameters;
  const both = await extendTool([minimax, ltx]);
  assert.equal(both.properties.reference.maxItems, 2);
  assert.equal(both.properties.start_image, undefined, 'a continuation starts on its clip, not on an image');
  const args = () => ({ prompt: 'x', intention: 'y', source: { output: 'video-run' }, reference: [{ image: 0 }] });
  const routed = await catalogOf([minimax, ltx]).route('extend_video', args(), media);
  assert.equal(routed.workflow.id, 'minimax-next');
  assert.deepEqual(routed.args.references, [
    { input: 'clip', output_id: 'video-run' },
    { input: 'r1', image: 0 },
  ]);
  // LTX 2.5 alone: its subject references are not offered beside a continuation, nor accepted.
  assert.equal((await extendTool([ltx])).properties.reference, undefined);
  await assert.rejects(catalogOf([ltx]).route('extend_video', args(), media), /Aucun workflow/);
  // The Studio shows the reference slots of the MiniMax continuation only.
  const studio = (await catalogOf([minimax, ltx]).studio()).extend_video;
  const roles = Object.fromEntries(studio.map(item => [item.id, item.roles.reference.count]));
  assert.deepEqual(roles, { 'minimax-next': 2, 'ltx-next': 0 });
  // Creating a video with LTX still takes its subject references.
  const subject = video('subject', [slot('a', 'msr_image'), slot('b', 'msr_image')]);
  const create = (await catalogOf([subject]).definitions()).find(tool => tool.function.name === 'create_video');
  assert.equal(create.function.parameters.properties.reference.maxItems, 2);
});

test('the Studio offers its style LoRAs where the engine that creates applies them', async () => {
  const minimax = { ...video('minimax', []), pipeline: 'minimax_h3' },
    moss = { ...image('moss-image'), pipeline: 'moss' };
  const studio = await catalogOf([image('krea'), moss, video('ltx', []), minimax]).studio();
  const styled = Object.fromEntries(
    [...studio.create_image, ...studio.create_video].map(item => [item.id, item.styled]),
  );
  // Moodix's engine applies them to Krea 2 and LTX 2.5; MiniMax H3 takes none yet, nor MOSS
  // Image since it left ComfyUI for that engine (0.6.124: its styles are to be carried over).
  assert.deepEqual(styled, { krea: true, 'moss-image': false, ltx: true, minimax: false });
});

test('the LoRA of the subject references is no setting: neither the Studio nor the model sees it (16/11)', async () => {
  const lora = (id, enabled) => ({ id, asset: id, description: id, enabled, strength: { policy: 'fixed', value: 1 } });
  const subject = video('subject', [slot('a', 'msr_image')], {
      loras: [lora('reference-slots', { policy: 'model', default: false }), lora('grain', { policy: 'model', default: true })],
    }),
    // Without subject references, a LoRA left to the model stays the user's to switch.
    plain = video('plain', [], { loras: [lora('grain', { policy: 'model', default: true })] });
  const studio = Object.fromEntries((await catalogOf([subject, plain]).studio()).create_video.map(item => [item.id, item]));
  assert.deepEqual(studio.subject.loras.map(item => item.id), ['grain']);
  assert.deepEqual(studio.plain.loras.map(item => item.id), ['grain']);
  const create = (await catalogOf([subject]).definitions()).find(tool => tool.function.name === 'create_video');
  assert.deepEqual(Object.keys(create.function.parameters.properties.loras.properties), ['grain']);
});

test('arguments are checked against the chosen workflow, never forwarded blindly', async () => {
  const tools = catalogOf(workflows);
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', fps: 12, stage: 'final' }, media);
  assert.equal(routed.args.stage, 'final');
  assert.equal(routed.args.fps, undefined);
  // (0.6.102: under the name Paramètres › Workflows gives it, as every note of the router.)
  assert.match(routed.notes[0], /^Images par seconde : valeur ignorée, fixée par le workflow /);
  await assert.rejects(tools.route('create_image', { prompt: 'x', colour: 'red' }, media), /argument colour/);
  await assert.rejects(
    tools.route('create_image', { prompt: 'x', source: { image: 0, resource: 'r' } }, media),
    /exactly one/,
  );
});

test('the seed the user names is passed on, only to a workflow that draws its seed', async () => {
  const drawn = video('drawn', [], {});
  drawn.parameters.seed = { policy: 'random', type: 'integer' };
  const tools = catalogOf([drawn]);
  const definition = (await tools.definitions()).find(tool => tool.function.name === 'create_video').function;
  assert.equal(definition.parameters.properties.seed.type, 'integer');
  assert.ok(!definition.parameters.required.includes('seed'));
  const routed = await tools.route('create_video', { prompt: 'x', intention: 'y', seed: 7704106376826763 }, media);
  assert.equal(routed.seed, 7704106376826763);
  assert.equal(routed.args.seed, undefined, 'the seed is not a workflow argument: the application sets it');
  assert.equal((await tools.route('create_video', { prompt: 'x', intention: 'y' }, media)).seed, undefined);
  assert.equal((await tools.route('create_video', { prompt: 'x', intention: 'y', seed: null }, media)).seed, undefined);
  for (const seed of [-1, 1.5, '12', 2 ** 60])
    await assert.rejects(tools.route('create_video', { prompt: 'x', intention: 'y', seed }, media), /seed doit être/);
  // A workflow with its own seed keeps it, and says so.
  const fixed = await catalogOf(workflows).route('create_video', { prompt: 'x', intention: 'y', seed: 5 }, media);
  assert.equal(fixed.seed, undefined);
  assert.match(fixed.notes.join(), /Seed : valeur ignorée, fixée par le workflow/);
});

test('upscale follows the media of its source and interpolate only takes videos', async () => {
  const transform = (id, pipeline, mediaType, role, parameters = {}) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType,
    parameters,
    components: {},
    loras: [],
    references: [slot('source', role, true)],
  });
  const tools = catalogOf([
    image('portrait'),
    transform('bigger-image', 'realesrgan_image', 'image', 'source_image'),
    transform('bigger-video', 'realesrgan_video', 'video', 'source_video'),
    transform('smooth', 'rife', 'video', 'source_video', {
      multiplier: { policy: 'model', type: 'integer', choices: [2, 4], default: 2 },
    }),
  ]);
  const names = (await tools.definitions()).map(tool => tool.function.name).sort();
  assert.deepEqual(names, ['create_image', 'interpolate', 'upscale']);
  const upscale = (await tools.definitions()).find(tool => tool.function.name === 'upscale').function.parameters;
  assert.equal(upscale.properties.prompt, undefined, 'upscaling has no prompt');
  assert.deepEqual(upscale.required, ['source']);
  assert.equal((await tools.route('upscale', { source: { image: 0 } }, media)).workflow.id, 'bigger-image');
  const video = await tools.route('upscale', { source: { output: 'video-run' } }, media);
  assert.equal(video.workflow.id, 'bigger-video');
  assert.ok(video.args.intention, 'a video upscale still carries an intention for its confirmation');
  const smooth = await tools.route('interpolate', { source: { output: 'video-run' }, multiplier: 4 }, media);
  assert.deepEqual([smooth.workflow.id, smooth.args.multiplier], ['smooth', 4]);
  await assert.rejects(tools.route('interpolate', { source: { image: 0 } }, media), /Aucun workflow/);
});

test('with a conversation context, sources list only what exists and never accept an empty object', async () => {
  const run = (id, mediaType, extra = {}) => ({ id, mediaType, count: 2, workflowId: 't2v', ...extra });
  const tools = catalogOf([...workflows, video('final', [], { profiles: { final: {} } })]);
  const named = async available =>
    Object.fromEntries((await tools.definitions(available)).map(tool => [tool.function.name, tool.function]));

  const empty = await named({ images: 0, resources: [], outputs: [] });
  assert.equal(empty.extend_video, undefined, 'a verb whose required source cannot exist is not offered');
  assert.equal(empty.create_image.parameters.properties.source, undefined);
  assert.equal(empty.create_video.parameters.properties.reference, undefined);
  assert.equal(empty.create_video.parameters.properties.reuse_output, undefined);
  assert.doesNotMatch(empty.create_image.description, /Sources:/);

  const rich = await named({
    images: 2,
    resources: [{ id: 'r-image', type: 'image' }],
    outputs: [run('img-run', 'image'), run('clip-run', 'video', { draft: true }), { id: 'broken', count: 0 }],
  });
  const source = rich.create_image.parameters.properties.source;
  assert.equal(source.anyOf.length, 3);
  for (const variant of source.anyOf) {
    assert.equal(variant.required.length, 1, 'each variant names exactly one kind of source');
    assert.equal(variant.additionalProperties, false);
  }
  assert.equal(source.anyOf[0].properties.image.maximum, 1);
  assert.deepEqual(source.anyOf[1].properties.resource.enum, ['r-image']);
  assert.deepEqual(source.anyOf[2].properties.output.enum, ['img-run'], 'a video result cannot be an image source');
  assert.equal(source.anyOf[2].properties.index.maximum, 1);
  assert.deepEqual(rich.extend_video.parameters.properties.source.properties.output.enum, ['clip-run']);
  assert.equal(
    rich.create_video.parameters.properties.reuse_output,
    undefined,
    'only drafts of a final-capable workflow',
  );
  assert.match(rich.create_image.description, /Sources: \{"image": n\}.*\{"resource": "id"\}.*\{"output": "run_id"\}/);

  const drafts = await named({
    images: 0,
    resources: [],
    outputs: [run('draft-run', 'video', { workflowId: 'final', draft: true })],
  });
  assert.deepEqual(drafts.create_video.parameters.properties.reuse_output.enum, ['draft-run']);
  const legacy = (await tools.definitions()).find(tool => tool.function.name === 'create_image').function;
  assert.ok(legacy.parameters.properties.source.properties.output, 'without context the generic schema is kept');
});

test('the shipped music workflow gives create_audio its lyrics, length and language, and routes them', async () => {
  const { readFile } = await import('node:fs/promises');
  const music = {
    ...JSON.parse(
      await readFile(new URL('../runner/workflows/8a2e5baf-0c02-4077-b36c-482b4e54bb13.json', import.meta.url), 'utf8'),
    ),
    ready: true,
  };
  const catalog = catalogOf([...workflows, music]);
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_audio').function;
  const { properties, required } = tool.parameters;
  assert.deepEqual(Object.keys(properties).sort(), ['language', 'lyrics', 'prompt', 'seconds', 'seed']);
  assert.deepEqual(required, ['prompt']);
  assert.match(properties.prompt.description, /BPM/);
  assert.match(properties.lyrics.description, /\[Chorus\]/);
  assert.equal(properties.seconds.maximum, 600);
  assert.ok(properties.language.enum.includes('fr'));
  assert.doesNotMatch(tool.description, /intention/);
  const routed = await catalog.route(
    'create_audio',
    { prompt: 'synth-pop, 110 BPM', lyrics: '[Verse]\nLa nuit', seconds: 30, language: 'fr' },
    media,
  );
  assert.equal(routed.workflow.id, music.id);
  assert.deepEqual(
    { lyrics: routed.args.lyrics, seconds: routed.args.seconds, language: routed.args.language },
    { lyrics: '[Verse]\nLa nuit', seconds: 30, language: 'fr' },
  );
});

// (0.6.476) Every workflow shipped, ready (`builtin`: shipped, as the list of the application says it), and the same
// list with some families made otherwise: their files to download, not offered to Moodix AI, impossible here.
const everyShipped = () =>
  readdirSync(new URL('../runner/workflows/', import.meta.url))
    .filter(name => name.endsWith('.json'))
    .map(name => ({
      ...JSON.parse(readFileSync(new URL(`../runner/workflows/${name}`, import.meta.url), 'utf8')),
      ready: true,
      builtin: true,
    }));
const otherwise = (list, pipelines, patch) =>
  list.map(workflow => (pipelines.includes(workflow.pipeline) ? { ...workflow, ...patch } : workflow));
const of = (list, pipeline) => list.find(workflow => workflow.pipeline === pipeline);
const TO_FETCH = { ready: false, unavailableKind: 'files' },
  NOT_HERE = { ready: false, unavailableKind: 'hardware', unavailableReason: 'il lui faut une carte NVIDIA.' };
const MOSS_ID = '3d6f1a8c-2b7e-4f59-9c41-8e0a5d2b7c36',
  LTX_ID = 'eaec4e2f-0649-4e56-9bd9-809dc9390452',
  MINIMAX_ID = 'e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f';
// The sources of the tables: images of the project, a video of the project (`v`), a take of each video model.
const projectSources = {
  mediaOf: async source => (source.resource === 'v' || source.output?.endsWith('clip') ? 'video' : 'image'),
  originOf: async source =>
    ({
      'minimax-clip': { workflowId: MINIMAX_ID, pipeline: 'minimax_h3' },
      'ltx-clip': { workflowId: LTX_ID, pipeline: 'ltx25' },
    })[source.output] ?? null,
};
// What the card says of a routing: its model (« à télécharger »: its files are), its notes, why each input is not sent.
const said = routed => ({
  model: routed.workflow.name + (routed.workflow.ready === false ? ' (à télécharger)' : ''),
  notes: routed.notes,
  left: (routed.left ?? []).map(item => item.why),
});
const sayRouted = (list, name, args, options = {}) =>
  catalogOf(list)
    .route(name, { prompt: 'x', ...structuredClone(args) }, { ...projectSources, ...options })
    .then(said);

test('an image given to create_image: Qwen-Image-Edit when it is ready here, else Krea 2 from it; nothing refused, nothing left out without a word (0.6.476)', async () => {
  const all = everyShipped(),
    // Not downloaded, not offered to Moodix AI, impossible on this computer: never a download proposed for it.
    absent = [
      otherwise(all, ['qwen_image_edit'], TO_FETCH),
      otherwise(all, ['qwen_image_edit'], { enabled: false }),
      otherwise(all, ['qwen_image_edit'], NOT_HERE),
    ];
  const [a, b, c, s] = ['a', 'b', 'c', 's'].map(resource => ({ resource })),
    QWEN = 'Qwen-Image-Edit',
    KREA = 'Krea 2',
    another = model => `${model} ne prend pas d’autre image : elle reste là, mais n’est pas envoyée.`;
  // What the chat passes; what is made with Qwen-Image-Edit ready; what is made without it.
  const table = [
    [{}, { model: KREA }, { model: KREA }],
    [{ workflow: MOSS_ID }, { model: 'MOSS Image' }, { model: 'MOSS Image' }],
    // A model named keeps its priority where it takes what is passed; MOSS Image takes no image.
    [
      { workflow: MOSS_ID, source: a },
      { model: QWEN, notes: [`MOSS Image ne prend pas ces entrées ensemble : ${QWEN} est utilisé à la place.`] },
      { model: KREA, notes: [`MOSS Image ne prend pas ces entrées ensemble : ${KREA} est utilisé à la place.`] },
    ],
    [{ source: a }, { model: QWEN }, { model: KREA }],
    // « Le même personnage » (source + 0,7): Qwen-Image-Edit has no denoise, which is said.
    [
      { source: a, denoise: 0.7 },
      { model: QWEN, notes: [`Débruitage : valeur ignorée, ${QWEN} ne prend pas ce réglage.`] },
      { model: KREA },
    ],
    // A reference alone: the image modified, said; it was refused (0.6.460).
    [
      { reference: [a] },
      { model: QWEN, notes: [`La référence est prise comme image à modifier : ${QWEN} part d’elle.`] },
      { model: KREA, notes: [`La référence est prise comme image à modifier : ${KREA} part d’elle.`] },
    ],
    [
      { reference: [a, b] },
      { model: QWEN, notes: [`La première référence est prise comme image à modifier : ${QWEN} part d’elle.`] },
      {
        model: KREA,
        notes: [`La première référence est prise comme image à modifier : ${KREA} part d’elle.`],
        left: [another(KREA)],
      },
    ],
    [{ source: s, reference: [a] }, { model: QWEN }, { model: KREA, left: [another(KREA)] }],
    // More than its two other images: the third stays in the card, greyed, said.
    [
      { source: s, reference: [a, b, c] },
      { model: QWEN, left: [`${QWEN} prend 2 autres images au plus : celle-ci reste là, mais n’est pas envoyée.`] },
      { model: KREA, left: [another(KREA), another(KREA), another(KREA)] },
    ],
    // A size asked: Qwen-Image-Edit keeps the size of its image, which is said.
    [
      { source: s, width: 1024, height: 1536 },
      {
        model: QWEN,
        notes: [
          `Largeur : valeur ignorée, ${QWEN} ne prend pas ce réglage.`,
          `Hauteur : valeur ignorée, ${QWEN} ne prend pas ce réglage.`,
        ],
      },
      { model: KREA },
    ],
  ];
  for (const [args, ready, without] of table) {
    assert.deepEqual(
      await sayRouted(all, 'create_image', args),
      { notes: [], left: [], ...ready },
      JSON.stringify(args),
    );
    for (const list of absent)
      assert.deepEqual(
        await sayRouted(list, 'create_image', args),
        { notes: [], left: [], ...without },
        JSON.stringify(args),
      );
  }
  // What is not sent is kept with what it is (the card shows it, greyed, with why).
  const { left } = await catalogOf(absent[0]).route(
    'create_image',
    { prompt: 'x', source: { ...s }, reference: [{ ...a }] },
    projectSources,
  );
  assert.deepEqual(
    left.map(({ role, index, kind, source }) => ({ role, index, kind, source })),
    [{ role: 'reference', index: 0, kind: 'none', source: { resource: 'a', media: 'image' } }],
  );
  // Nothing ready: the download of the one that does it all, Krea 2 for an image to modify.
  const none = all.map(workflow => ({ ...workflow, ...TO_FETCH }));
  assert.equal((await sayRouted(none, 'create_image', { source: a })).model, 'Krea 2 (à télécharger)');
  assert.equal((await sayRouted(none, 'create_image', { reference: [a, b] })).model, 'Qwen-Image-Edit (à télécharger)');
  // No model here starts from an image (MOSS Image alone): said in words.
  await assert.rejects(sayRouted([of(all, 'moss')], 'create_image', { source: a }), {
    status: 400,
    message:
      'Aucun modèle d’image de cet ordinateur ne part d’une image : ' +
      'décrivez dans le prompt ce qu’il faut en garder.',
  });
  // By the user's own hand nothing changes: Krea 2 for an image to modify, a reference alone refused as before.
  assert.equal((await sayRouted(all, 'create_image', { source: a }, { byHand: true })).model, 'Krea 2');
  await assert.rejects(sayRouted(all, 'create_image', { reference: [a] }, { byHand: true }), {
    status: 400,
    message:
      'Aucun modèle d’image ne prend une référence seule : il faut la donner comme image à modifier (source) ' +
      'pour partir d’elle, ou décrire dans le prompt ce qu’il faut en garder.',
  });
  // A model of the user's that takes a reference alone, given more than it has places for: the rest greyed, said.
  const qwen = of(all, 'qwen_image_edit'),
    others = { ...qwen, id: 'others', references: qwen.references.filter(item => item.role === 'reference_image') };
  assert.deepEqual(await sayRouted([of(all, 'krea2'), others], 'create_image', { reference: [a, b, c] }), {
    model: QWEN,
    notes: [],
    left: [`${QWEN} prend 2 autres images au plus : celle-ci reste là, mais n’est pas envoyée.`],
  });
});

test('a video of Moodix AI: LTX 2.5 as soon as it is ready and takes what is passed; MiniMax H3 Omni named, for its own clip, or without LTX 2.5 (0.6.476)', async () => {
  const all = everyShipped(),
    absent = [
      otherwise(all, ['ltx25'], TO_FETCH),
      otherwise(all, ['ltx25'], { enabled: false }),
      otherwise(all, ['ltx25'], NOT_HERE),
    ];
  const [a, b, c] = ['a', 'b', 'c'].map(resource => ({ resource })),
    v = { resource: 'v' },
    LTX = 'LTX 2.5',
    MINIMAX = 'MiniMax H3 Omni';
  // What the chat passes; what is made with LTX 2.5 ready; what is made without it.
  const table = [
    [
      'create_video',
      { duration: 5 },
      { model: LTX },
      { model: MINIMAX, notes: [`Durée : 5 s → 5,17 s, la plus proche que ${MINIMAX} permet.`] },
    ],
    ['create_video', { start_image: a }, { model: LTX }, { model: 'Wan 2.2' }],
    ['create_video', { start_image: a, end_image: b }, { model: LTX }, { model: 'pi H3' }],
    ['create_video', { reference: [a, b] }, { model: LTX }, { model: MINIMAX }],
    // Three subjects: LTX 2.5 takes two, MiniMax H3 Omni three.
    ['create_video', { reference: [a, b, c] }, { model: MINIMAX }, { model: MINIMAX }],
    ['create_video', { workflow: MINIMAX_ID }, { model: MINIMAX }, { model: MINIMAX }],
    // A suite: the model of its clip, else LTX 2.5; with a subject, MiniMax H3 Omni (LTX 2.5 takes none in a suite).
    ['extend_video', { source: v }, { model: LTX }, { model: MINIMAX }],
    ['extend_video', { source: { output: 'minimax-clip' } }, { model: MINIMAX }, { model: MINIMAX }],
    ['extend_video', { source: { output: 'ltx-clip' } }, { model: LTX }, { model: MINIMAX }],
    ['extend_video', { source: v, reference: [a] }, { model: MINIMAX }, { model: MINIMAX }],
  ];
  for (const [name, args, ready, without] of table) {
    const asked = { intention: 'x', ...args };
    assert.deepEqual(await sayRouted(all, name, asked), { notes: [], left: [], ...ready }, JSON.stringify(args));
    for (const list of absent)
      assert.deepEqual(await sayRouted(list, name, asked), { notes: [], left: [], ...without }, JSON.stringify(args));
  }
  // A start image and a subject: LTX 2.5 takes both; without it no model here does, refused as before.
  assert.equal((await sayRouted(all, 'create_video', { intention: 'x', start_image: a, reference: [b] })).model, LTX);
  await assert.rejects(
    sayRouted(absent[0], 'create_video', { intention: 'x', start_image: a, reference: [b] }),
    /^Error: Aucun workflow ne correspond/,
  );
  // Nothing ready: the download of LTX 2.5, a video from words.
  const none = all.map(workflow => ({ ...workflow, ...TO_FETCH }));
  assert.equal((await sayRouted(none, 'create_video', { intention: 'x' })).model, 'LTX 2.5 (à télécharger)');
  // The other lines of the table of the study (27/11) do not move.
  for (const list of [all, ...absent]) {
    assert.equal(
      (await sayRouted(list, 'replace_character', { intention: 'x', source: v, reference: a })).model,
      'Wan 2.1 SCAIL-2',
    );
    assert.equal((await sayRouted(list, 'upscale', { source: a })).model, 'Upscale SeedVR2');
    assert.equal((await sayRouted(list, 'upscale', { source: v })).model, 'Upscale vidéo (Real-ESRGAN ×2)');
    assert.equal((await sayRouted(list, 'interpolate', { source: v })).model, 'Interpoler (RIFE 4.26)');
  }
  // By the user's own hand (the buttons of a take), as before: the model with the fewest empty slots.
  assert.equal((await sayRouted(all, 'create_video', { intention: 'x' }, { byHand: true })).model, MINIMAX);
  assert.equal((await sayRouted(all, 'extend_video', { intention: 'x', source: v }, { byHand: true })).model, MINIMAX);
  // The Studio and the Bobine name their model: it is the one made, LTX 2.5 ready or not.
  for (const list of [all, ...absent])
    assert.equal(
      (await sayRouted(list, 'create_video', { intention: 'x', workflow: MINIMAX_ID }, { byHand: true })).model,
      MINIMAX,
    );
  // The Studio lists its models in the order of their families (`preference`), which is not the chat's.
  const families = name =>
    JSON.parse(readFileSync(new URL(`../runner/families/${name}.json`, import.meta.url), 'utf8'));
  assert.deepEqual(
    [families('ltx25').preference, families('minimax_h3').preference, families('qwen_image_edit').preference],
    [undefined, undefined, -1],
  );
  assert.deepEqual(
    [families('ltx25').chatFirst, families('qwen_image_edit').chatFirst],
    [['create_video', 'extend_video'], ['create_image']],
  );
});

test('the models of the card of a video proposal: what each takes of its inputs, why one cannot be chosen, the one to download (0.6.476)', async () => {
  const all = everyShipped(),
    a = { resource: 'a', media: 'image' },
    b = { resource: 'b', media: 'image' },
    v = { resource: 'v', media: 'video' };
  const listed = await catalogOf(all).choices('create_video', { start_image: [a], end_image: [b], reference: [a] });
  // The models of the Bobine, in its order; never Wan 2.2 Caméra nor SCAIL-2.
  assert.deepEqual(
    listed.map(model => [model.family, model.name, model.all, model.off ?? '', model.missing ?? false]),
    [
      ['ltx25', 'LTX 2.5', true, '', false],
      ['minimax_h3', 'MiniMax H3 Omni', false, '', false],
      ['pi_h3', 'pi H3', false, '', false],
      ['wan22', 'Wan 2.2', false, '', false],
    ],
  );
  assert.equal(listed[0].workflowId, LTX_ID);
  // Without a start image, Wan 2.2 cannot be made: greyed, with what to do.
  const words = await catalogOf(all).choices('create_video', { reference: [a] });
  assert.equal(
    words.find(model => model.family === 'wan22').off,
    'Wan 2.2 part d’une image de début : ajoutez-en une à la carte, puis choisissez-le.',
  );
  // A suite: the models that make none are greyed, saying which do.
  const suite = await catalogOf(all).choices('extend_video', { source: [v] });
  assert.deepEqual(
    suite.map(model => [model.name, model.off ?? '']),
    [
      ['LTX 2.5', ''],
      ['MiniMax H3 Omni', ''],
      ['pi H3', 'pi H3 ne prolonge pas une vidéo. Pour une suite : LTX 2.5 ou MiniMax H3 Omni.'],
      ['Wan 2.2', 'Wan 2.2 ne prolonge pas une vidéo. Pour une suite : LTX 2.5 ou MiniMax H3 Omni.'],
    ],
  );
  // Its files to download: in the list all the same (`missing`), its download offered once chosen; impossible here,
  // not offered to Moodix AI: greyed with the reason.
  const other = await catalogOf(
    otherwise(otherwise(otherwise(all, ['minimax_h3'], TO_FETCH), ['pi_h3'], NOT_HERE), ['wan22'], { enabled: false }),
  ).choices('create_video', { start_image: [a] });
  assert.deepEqual(
    other.map(model => [model.name, model.missing ?? false, model.off ?? '']),
    [
      ['LTX 2.5', false, ''],
      ['MiniMax H3 Omni', true, ''],
      ['pi H3', false, 'pi H3 : il lui faut une carte NVIDIA.'],
      [
        'Wan 2.2',
        false,
        'Wan 2.2 n’est pas proposé à Moodix AI : activez « Proposé à Moodix AI » dans ses réglages (Paramètres › Modèles).',
      ],
    ],
  );
  assert.equal(await catalogOf(all).choices('create_image', {}), null);
});

test('what a model does not take of the inputs of a card, in the words of the Bobine, and the line that says what to do (0.6.476)', async () => {
  const { fitInputs, leftWhy, heldWarning } = await import('../lib/tool-catalog.mjs');
  const all = everyShipped(),
    ltx = of(all, 'ltx25'),
    minimax = of(all, 'minimax_h3'),
    pi = of(all, 'pi_h3'),
    image = resource => ({ resource, media: 'image' }),
    inputs = { start_image: [image('s')], end_image: [image('e')], reference: [image('r')] };
  // LTX 2.5 takes them all; MiniMax H3 Omni the subject; pi H3 the start and the end.
  assert.deepEqual(fitInputs(ltx, inputs, 'create_video').left, []);
  assert.deepEqual(
    fitInputs(minimax, inputs, 'create_video').left.map(({ role, kind }) => [role, kind]),
    [
      ['start_image', 'none'],
      ['end_image', 'none'],
    ],
  );
  assert.deepEqual(
    fitInputs(pi, inputs, 'create_video').left.map(({ role, kind }) => [role, kind]),
    [['reference', 'none']],
  );
  assert.equal(
    leftWhy(minimax, 'create_video', { role: 'start_image', kind: 'none' }),
    'MiniMax H3 Omni ne prend pas d’image de début : elle reste là, mais n’est pas envoyée.',
  );
  assert.equal(
    leftWhy(pi, 'create_video', { role: 'reference', kind: 'none' }, { others: 'LTX 2.5 ou MiniMax H3 Omni' }),
    'pi H3 ne prend pas de sujet : choisissez LTX 2.5 ou MiniMax H3 Omni. Il reste là, mais n’est pas envoyé.',
  );
  assert.equal(
    leftWhy(ltx, 'extend_video', { role: 'reference', kind: 'none' }, { others: 'MiniMax H3 Omni' }),
    'LTX 2.5 ne prend pas de sujet dans une suite. Pour une suite avec des sujets : MiniMax H3 Omni. ' +
      'Il reste là, mais n’est pas envoyé.',
  );
  assert.equal(
    leftWhy(ltx, 'create_video', { role: 'reference', kind: 'full', count: 2 }),
    'LTX 2.5 prend 2 sujets au plus : celui-ci reste là, mais n’est pas envoyé.',
  );
  // The line of the card: what is not sent, and what to do.
  const sent = [{ role: 'reference_image' }],
    frames = [
      { as: 'start_image', kind: 'none' },
      { as: 'end_image', kind: 'none' },
    ];
  assert.equal(
    heldWarning(minimax, 'create_video', sent, frames, ['LTX 2.5']),
    'L’image de début et l’image de fin ne sont pas envoyées à MiniMax H3 Omni : retirez-les, ou choisissez LTX 2.5.',
  );
  assert.equal(
    heldWarning(pi, 'create_video', [{ role: 'start_image' }], [{ as: 'reference', kind: 'none' }], []),
    'Le sujet 1 n’est pas envoyé à pi H3 : retirez-le.',
  );
  assert.equal(heldWarning(ltx, 'create_video', sent, [], ['pi H3']), '');
  // A MiniMax H3 of the user's with a start and an end: subjects, or a start and an end, not both.
  const full = {
    ...minimax,
    references: [
      { id: 'start', role: 'start_image', required: false, name: 'Image de début' },
      { id: 'end', role: 'end_image', required: false, name: 'Image de fin' },
      { id: 'subject-1', role: 'reference_image', required: false, name: 'Référence 1' },
    ],
  };
  const fit = fitInputs(full, inputs, 'create_video');
  assert.deepEqual(fit.left.map(({ role, kind }) => [role, kind]), [['reference', 'apart']]);
  assert.equal(
    leftWhy(full, 'create_video', fit.left[0]),
    'MiniMax H3 Omni prend des sujets ou un début et une fin, pas les deux : celui-ci reste là, mais n’est pas envoyé.',
  );
  const both = [{ role: 'start_image' }, { role: 'end_image' }];
  assert.equal(
    heldWarning(full, 'create_video', both, [{ as: 'reference', kind: 'apart' }]),
    'MiniMax H3 Omni prend des sujets ou un début et une fin, pas les deux : retirez les images de début et de fin ' +
      'ou le sujet.',
  );
});

test('music and sound effects: the model names the workflow, and each keeps its own limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const shipped = async id => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
  });
  const music = await shipped('8a2e5baf-0c02-4077-b36c-482b4e54bb13'),
    effects = await shipped('84390db5-e4b9-413c-9352-bbac225fe79c');
  const catalog = catalogOf([music, effects]);
  const tool = (await catalog.definitions()).find(item => item.function.name === 'create_audio').function;
  const { properties, required } = tool.parameters;
  assert.deepEqual(required.sort(), ['prompt', 'workflow']);
  assert.match(properties.workflow.description, /sound effects/);
  assert.match(properties.workflow.description, /music/);
  assert.equal(properties.seconds.minimum, 1);
  assert.equal(properties.seconds.maximum, 600);
  assert.match(properties.seconds.description, /30 at most/);
  assert.match(properties.lyrics.description, /Only for: 8a2e5baf/);
  const routed = await catalog.route(
    'create_audio',
    { workflow: effects.id, prompt: 'Rain on a tin roof', seconds: 60, lyrics: '' },
    media,
  );
  assert.equal(routed.workflow.id, effects.id);
  assert.equal(routed.args.seconds, 30);
  assert.equal(routed.args.lyrics, undefined);
  assert.ok(routed.notes.some(note => /^Durée \(secondes\) : 60 → 30, la limite de /.test(note)), routed.notes.join(' | '));
  assert.ok(routed.notes.some(note => /^Paroles : valeur ignorée, .* ne prend pas ce réglage\.$/.test(note)));
  const song = await catalog.route('create_audio', { workflow: music.id, prompt: 'synth-pop', seconds: 200 }, media);
  assert.equal(song.args.seconds, 200);
  assert.deepEqual(song.notes, []);
});

test('(0.6.460) music asked for with the music model not downloaded: it is offered to download, never the sound-effect model in its place', async () => {
  // (27/11, a real request to his chat model: « Fais-moi une musique douce au piano » was proposed with
  // « Bruitages (MOSS-SoundEffect v2) », the only audio workflow ready there: the model was told of no other.)
  const { readFile } = await import('node:fs/promises');
  const shipped = async (id, more) => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ...more,
  });
  const lacks = { ready: false, builtin: true, unavailableKind: 'files', unavailableReason: 'Il manque un fichier.' };
  const music = await shipped('8a2e5baf-0c02-4077-b36c-482b4e54bb13', lacks),
    effects = await shipped('84390db5-e4b9-413c-9352-bbac225fe79c', { ready: true });
  for (const wording of [undefined, CAPABLE]) {
    const catalog = catalogOf([music, effects]);
    const tool = (await catalog.definitions(undefined, wording ? { wording } : {})).find(item => item.function.name === 'create_audio').function;
    // Both are told, each with what it is the one for, and the model must name one.
    assert.ok(tool.parameters.required.includes('workflow'), String(wording));
    assert.equal(tool.parameters.properties.workflow.enum.length, 2);
    assert.match(tool.parameters.properties.workflow.description, /music/);
    assert.match(tool.parameters.properties.workflow.description, /sound effects/);
    // Named, the music workflow is the one routed, though it lacks a file: its download is offered (53).
    const named = tool.parameters.properties.workflow.enum.find(value => value === music.id || value === music.name);
    const song = await catalog.route('create_audio', { workflow: named, prompt: 'Solo piano, gentle' }, media);
    assert.deepEqual([song.workflow.id, song.workflow.ready], [music.id, false]);
    // Unnamed (a model that leaves it out): the ready one, never a download for what a ready workflow makes.
    const noise = await catalog.route('create_audio', { prompt: 'A door slams' }, media);
    assert.deepEqual([noise.workflow.id, noise.workflow.ready], [effects.id, true]);
  }
  // A workflow that makes anything answers alone: MOSS Image not downloaded is not offered beside Krea 2.
  const poster = { ...image('moss', []), pipeline: 'moss', ...lacks },
    plain = { ...image('krea', []), pipeline: 'krea2', ready: true };
  const pictures = (await catalogOf([plain, poster]).definitions()).find(item => item.function.name === 'create_image').function;
  assert.equal(pictures.parameters.properties.workflow, undefined);
  // By hand (the Studio), only what can be made here: nothing that lacks a file is routed.
  const byHand = await catalogOf([music, effects]).route('create_audio', { prompt: 'A door slams' }, { ...media, byHand: true });
  assert.equal(byHand.workflow.id, effects.id);
});

test('a character is replaced in a video by a verb of its own: the video, the image, who is who', async () => {
  const scail = {
    ...JSON.parse(readFileSync(new URL('../runner/families/wan_scail2.json', import.meta.url), 'utf8')).template,
    schemaVersion: 1,
    id: 'scail',
    enabled: true,
    ready: true,
    pipeline: 'wan_scail2',
    mediaType: 'video',
  };
  const catalog = catalogOf([...workflows, scail]);
  assert.equal(serves(scail, 'replace_character'), true);
  // Neither a video made from a description nor the continuation of one.
  assert.equal(serves(scail, 'create_video'), false);
  assert.equal(serves(scail, 'extend_video'), false);
  const tools = Object.fromEntries((await catalog.definitions()).map(t => [t.function.name, t.function]));
  const replace = tools.replace_character.parameters;
  assert.deepEqual(Object.keys(replace.properties).sort(), [
    'character',
    'intention',
    'prompt',
    'reference',
    'reference_subject',
    'seed',
    'source',
    'subject',
  ]);
  // The length and the format are the source video's: the model is asked neither. The character
  // is its image, or its description when there is none (the application makes the image).
  assert.deepEqual(replace.required.sort(), ['intention', 'prompt', 'source']);
  assert.match(replace.properties.character.description, /no image of the character/);
  assert.match(tools.replace_character.description, /never make one\s+with create_image/);
  assert.match(replace.properties.subject.description, /girl, handkerchief/);
  // Without a video in the conversation there is nothing to follow: the verb is not offered.
  const none = await catalog.definitions({ images: 1, resources: [], outputs: [] });
  assert.ok(!none.some(tool => tool.function.name === 'replace_character'));
  const some = await catalog.definitions({
    images: 1,
    resources: [{ id: 'clip', type: 'video' }],
    outputs: [],
  });
  const offered = some.find(tool => tool.function.name === 'replace_character').function.parameters.properties;
  // The video is taken whole: no frame of it is offered for the source, one is for an image role.
  assert.deepEqual(Object.keys(offered.source.properties), ['resource']);
  assert.ok(
    offered.reference.anyOf.some(variant => variant.properties.frame),
    'a frame of a video can still stand for the image of the character',
  );
  // A model that names a frame all the same means the video: the call is not refused for it.
  const framed = await catalog.route(
    'replace_character',
    {
      prompt: 'x',
      intention: 'y',
      source: { resource: 'clip', frame: 1 },
      reference: { image: 0 },
    },
    { mediaOf: async source => (source.resource === 'clip' && source.frame === undefined ? 'video' : 'image') },
  );
  assert.deepEqual(framed.args.references[0], { input: 'video', resource_id: 'clip' });
  const routed = await catalog.route(
    'replace_character',
    {
      prompt: 'A woman in a white top eats an apple in an orchard.',
      intention: 'Remplacer la fille.',
      source: { output: 'video-run' },
      reference: { image: 0 },
      subject: 'girl, handkerchief',
    },
    media,
  );
  assert.equal(routed.workflow.id, 'scail');
  assert.equal(routed.args.subject, 'girl, handkerchief');
  assert.deepEqual(
    routed.args.references.map(ref => ref.input),
    ['video', 'character'],
  );
  await assert.rejects(
    catalog.route('replace_character', { prompt: 'x', intention: 'y', reference: { image: 0 } }, media),
    /needs a source/,
  );
  // A description given beside an image: the image is the character, the words go no further.
  const both = await catalog.route(
    'replace_character',
    {
      prompt: 'x',
      intention: 'y',
      source: { output: 'video-run' },
      reference: { image: 0 },
      character: 'a volleyball player',
    },
    media,
  );
  assert.equal(both.args.character, undefined);
  assert.equal(both.args.references.length, 2);
});

test('an output of another conversation of the project keeps its conversation; a conversation alone is refused', async () => {
  const tools = catalogOf([
    image('portrait'),
    {
      schemaVersion: 1,
      id: 'bigger-video',
      name: 'bigger-video',
      description: 'bigger-video',
      enabled: true,
      ready: true,
      pipeline: 'realesrgan_video',
      mediaType: 'video',
      parameters: {},
      components: {},
      loras: [],
      references: [slot('source', 'source_video', true)],
    },
  ]);
  const other = 'b2222222-2222-4222-8222-222222222222';
  const routed = await tools.route('upscale', { source: { output: 'video-run', conversation: other } }, media);
  assert.deepEqual(routed.args.references, [{ input: 'source', output_id: 'video-run', output_conversation: other }]);
  await assert.rejects(
    tools.route('upscale', { source: { resource: 'clip', conversation: other } }, media),
    /conversation goes only with an output/,
  );
  await assert.rejects(
    tools.route('upscale', { source: { output: 'video-run', conversation: 'not-an-id' } }, media),
    /conversation goes only with an output/,
  );
});

test('one more image: where a proposal still has a place for it, and which other workflow would', async () => {
  const minimax = {
      ...video('minimax-next', [
        slot('clip', 'source_video', true),
        slot('r1', 'reference_image'),
        slot('r2', 'reference_image'),
      ]),
      pipeline: 'minimax_h3',
    },
    ltx = video('ltx-next', [slot('clip', 'source_video', true), slot('a', 'msr_image')]),
    clip = [{ input: 'clip' }];
  // LTX 2.5 continues a clip without any image; MiniMax H3 takes subject references with it.
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', ltx, clip), {
    here: [],
    none: true,
    other: 'minimax-next',
  });
  assert.deepEqual(await catalogOf([ltx]).room('extend_video', ltx, clip), { here: [], none: true, other: null });
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', minimax, clip), {
    here: ['reference'],
    none: false,
    other: null,
  });
  // Its two references given: no place left, and LTX would not take them either.
  const full = [{ input: 'clip' }, { input: 'r1' }, { input: 'r2' }];
  assert.deepEqual(await catalogOf([minimax, ltx]).room('extend_video', minimax, full), {
    here: [],
    none: false,
    other: null,
  });
  // A new video: the roles left free, those the family does not combine with the ones given left out.
  const keys = video('keyframes', [slot('first', 'start_image'), slot('last', 'end_image')]),
    subject = video('subject', [slot('first', 'start_image'), slot('a', 'msr_image')]),
    omni = {
      ...video('omni', [slot('s', 'start_image'), slot('e', 'end_image'), slot('r1', 'reference_image')]),
      pipeline: 'minimax_h3',
    };
  const tools = catalogOf([keys, subject, omni]);
  assert.deepEqual((await tools.room('create_video', keys, [])).here, ['start_image', 'end_image']);
  assert.deepEqual((await tools.room('create_video', keys, [{ input: 'first' }])).here, ['end_image']);
  const taken = await tools.room('create_video', keys, [{ input: 'first' }, { input: 'last' }]);
  assert.deepEqual(taken, { here: [], none: false, other: null }, 'two key images and a third: no workflow here');
  // MiniMax H3: a reference does not go with a start image; an end image does.
  assert.deepEqual((await tools.room('create_video', omni, [{ input: 's' }])).here, ['end_image']);
  assert.deepEqual((await tools.room('create_video', omni, [{ input: 'r1' }])).here, []);
  // … which LTX 2.5 takes together: a reference, and the image as the one the clip starts on.
  assert.equal((await tools.room('create_video', omni, [{ input: 'r1' }])).other, 'subject');
  // A workflow without any image, beside one that takes a start image.
  const plain = video('t2v', []);
  assert.deepEqual(await catalogOf([plain, keys]).room('create_video', plain, []), {
    here: [],
    none: true,
    other: 'keyframes',
  });
  assert.deepEqual(await tools.room('nothing', keys, []), { here: [], none: true, other: null });
});

test('Krea 2: the denoise is the assistant’s with an image to modify, from 0.6 to 0.7, and said in its tool only', async () => {
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async id => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
  });
  const krea = await shippedOf('fefb88eb-8311-4409-b636-6efbb42e952c'),
    moss = await shippedOf('3d6f1a8c-2b7e-4f59-9c41-8e0a5d2b7c36'),
    catalog = catalogOf([moss, krea]);
  const toolOf = async (tools, available, options) =>
    (await tools.definitions(available, options)).find(item => item.function.name === 'create_image').function
      .parameters;
  // Offered with its bounds, both included, and what each end does: the model is told there, and
  // nowhere else (lib/model-wording.mjs and lib/tasks.json say nothing of it).
  const generic = await toolOf(catalog);
  assert.deepEqual(Object.keys(generic.properties), [
    'prompt',
    'source',
    'workflow',
    'seed',
    'width',
    'height',
    'denoise',
    'series',
  ]);
  assert.deepEqual(generic.required, ['prompt']);
  const { description, ...schema } = generic.properties.denoise;
  assert.deepEqual(schema, { type: 'number', minimum: 0.6, maximum: 0.7, default: 0.6 });
  assert.equal(
    description,
    'Only with an image to modify (source): how much of that image is redone. 0.6 keeps its composition and changes its mood, light or colours; 0.7 also lets the composition change (another framing, a farther view). Omit it otherwise: 0.6 is used. Only for: fefb88eb-8311-4409-b636-6efbb42e952c.',
  );
  assert.equal(description, `${krea.parameters.denoise.description} Only for: ${krea.id}.`);
  for (const file of ['../lib/model-wording.mjs', '../lib/tasks.json', '../lib/tasks-capable.json'])
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /denoise/i, file);
  // A conversation that holds nothing to modify: no source to pass, and not a word of the denoise.
  const empty = { images: 0, resources: [], takes: [], outputs: [] };
  const fresh = (await toolOf(catalog, empty)).properties;
  assert.deepEqual([fresh.source, fresh.denoise], [undefined, undefined]);
  const attached = (await toolOf(catalog, { ...empty, images: 1 })).properties;
  assert.ok(attached.source && attached.denoise);
  // A capable model: the same words, the workflow by its name.
  const capable = (await toolOf(catalog, undefined, { wording: CAPABLE })).properties.denoise;
  assert.equal(capable.description, `${krea.parameters.denoise.description} Only for: Krea 2.`);
  assert.deepEqual([capable.minimum, capable.maximum], [0.6, 0.7]);
  // A workflow that fixes its denoise offers no such argument.
  const fixed = structuredClone(krea);
  fixed.parameters.denoise = { policy: 'fixed', value: 0.6 };
  const held = catalogOf([moss, fixed]);
  assert.equal((await toolOf(held)).properties.denoise, undefined);
  // Nor does one that takes no image to modify, whatever it says of its denoise.
  const slotless = { ...structuredClone(krea), id: 'krea-sans-image', name: 'Krea sans image', references: [] };
  assert.equal((await toolOf(catalogOf([moss, slotless]))).properties.denoise, undefined);
  assert.ok((await toolOf(catalogOf([slotless, krea]))).properties.denoise.description.endsWith(`Only for: ${krea.id}.`));

  // Routed: kept within the bounds, brought back to the nearest one beyond them, and said.
  // (The router writes the media of a source on it: a new one for each call.)
  const route = (args, tools = catalog) => tools.route('create_image', { prompt: 'x', ...structuredClone(args) }, media),
    source = { image: 0 };
  let routed = await route({ source, denoise: 0.7 });
  assert.equal(routed.workflow.id, krea.id);
  assert.deepEqual([routed.args.denoise, routed.notes], [0.7, []]);
  routed = await route({ source, denoise: 0.65 });
  assert.deepEqual([routed.args.denoise, routed.notes], [0.65, []]);
  routed = await route({ source, denoise: 0.9 });
  // (0.6.102: under the name the editor shows.)
  assert.deepEqual([routed.args.denoise, routed.notes], [0.7, ['Débruitage : 0,9 → 0,7, la limite de Krea 2.']]);
  routed = await route({ source, denoise: 0.3 });
  assert.deepEqual([routed.args.denoise, routed.notes], [0.6, ['Débruitage : 0,3 → 0,6, la limite de Krea 2.']]);
  // Without an image to modify: left aside without a word, whatever its value.
  for (const denoise of [0.7, 0.9, 0.3]) {
    routed = await route({ denoise });
    assert.equal(routed.workflow.id, krea.id);
    assert.deepEqual([Object.hasOwn(routed.args, 'denoise'), routed.notes], [false, []], String(denoise));
  }
  // The workflow that fixes it: ignored and said, never an error.
  routed = await route({ source, denoise: 0.7 }, held);
  assert.equal(Object.hasOwn(routed.args, 'denoise'), false);
  assert.match(routed.notes.join(), /Débruitage : valeur ignorée, fixée par le workflow Krea 2\./);

  // The Studio: a setting of the model, with its bounds and the input it is only read with.
  // (0.6.102) Those it fixes too (its steps), at their value: « Fixe » holds Moodix AI, the user
  // may change it for a creation.
  const shown = (await catalog.studio()).create_image.find(item => item.id === krea.id);
  assert.deepEqual(shown.settings, [
    { key: 'steps', type: 'integer', min: 1, max: 1000, default: 8, fixed: true },
    { key: 'denoise', type: 'number', min: 0.6, max: 0.7, default: 0.6, onlyWith: { role: 'img2img', otherwise: 1 } },
  ]);
  assert.equal(shown.inputs.img2img, 'source');
  assert.deepEqual(
    (await held.studio()).create_image
      .find(item => item.id === krea.id)
      .settings.map(setting => [setting.key, setting.default, setting.fixed, setting.min, setting.max]),
    [
      ['steps', 8, true, 1, 1000],
      ['denoise', 0.6, true, 0, 1],
    ],
  );
});

test('the Bobine is told the models that make videos, one by family, what each takes and the longest it makes (0.6.461)', async () => {
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async (id, more = {}) => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
    builtin: true,
    ...more,
  });
  const ids = { ltx: 'eaec4e2f-0649-4e56-9bd9-809dc9390452', minimax: 'e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f', pi: 'ef3a7c52-9a63-4d58-8e17-3b5d0c6a2f94', wan: 'f70c4029-0bb2-4eee-98f4-305204229fe1', camera: 'f9daa76d-243b-4f8e-bb78-18dbc02bf8e2' };
  const said = models =>
    models.map(model => [
      model.family,
      model.name,
      model.sound,
      ...['create_video', 'extend_video'].map(verb => {
        const entry = model[verb];
        return entry && [entry.id, Object.fromEntries(Object.entries(entry.roles).map(([role, spec]) => [role, spec.count + (spec.required ? '!' : '')])), Math.round(entry.longest * 1000) / 1000, Math.round(entry.shortest * 1000) / 1000, entry.missing ?? entry.unavailable ?? ''];
      }),
    ]);
  // All here: the four families in the order the router prefers them, then by name; not Wan 2.2 Caméra, which reads a
  // camera of its own (the Bobine does not set one). MiniMax H3 Omni takes subjects only; an LTX 2.5 suite none.
  // (0.6.464) The shortest each makes, as the server makes a take shorter: MiniMax H3 and pi H3 5,17 s (124 images).
  const all = await Promise.all(Object.values(ids).map(id => shippedOf(id)));
  assert.deepEqual(said(await catalogOf(all).videoModels()), [
    ['ltx25', 'LTX 2.5', true, [ids.ltx, { start_image: '1', end_image: '1', reference: '2' }, 10.042, 0.375, ''], [ids.ltx, { source: '1!', reference: '0', end_image: '1' }, 9.667, 0.333, '']],
    ['minimax_h3', 'MiniMax H3', true, [ids.minimax, { start_image: '0', end_image: '0', reference: '3' }, 14.375, 5.167, ''], [ids.minimax, { source: '1!', reference: '3', end_image: '0' }, 13.458, 4.25, '']],
    ['pi_h3', 'pi H3', true, [ids.pi, { start_image: '1', end_image: '1', reference: '0' }, 14.375, 5.167, ''], null],
    ['wan22', 'Wan 2.2', false, [ids.wan, { start_image: '1!', end_image: '0', reference: '0' }, 5.063, 2.063, ''], null],
  ]);
  // LTX 2.5 without its files (offered to download: `missing`), MiniMax H3 that this computer cannot run (its reason),
  // Wan 2.2 the user's own and without its files (nothing to download): greyed with its reason, never left out.
  const some = await Promise.all([
    shippedOf(ids.ltx, { ready: false, unavailableKind: 'files', unavailableReason: 'Fichier manquant.' }),
    shippedOf(ids.minimax, { ready: false, unavailableKind: 'hardware', unavailableReason: 'demande une carte NVIDIA.' }),
    shippedOf(ids.pi),
    shippedOf(ids.wan, { ready: false, builtin: false, unavailableKind: 'files', unavailableReason: 'Fichier manquant.' }),
  ]);
  assert.deepEqual(
    (await catalogOf(some).videoModels()).map(model => [model.family, model.create_video.missing ?? model.create_video.unavailable ?? '']),
    [['ltx25', true], ['minimax_h3', 'demande une carte NVIDIA.'], ['pi_h3', ''], ['wan22', 'Fichier manquant.']],
  );
});

test('a take of the Bobine named to a model that lacks its files goes to it, its download offered, never to another (0.6.461)', async () => {
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async (id, more = {}) => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
    builtin: true,
    ...more,
  });
  const ltx = await shippedOf('eaec4e2f-0649-4e56-9bd9-809dc9390452'),
    minimax = await shippedOf('e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f', { ready: false, unavailableKind: 'files', unavailableReason: 'Fichier manquant.' }),
    catalog = catalogOf([ltx, minimax]),
    asked = { prompt: 'Un renard dans la neige.', workflow: minimax.id };
  // By the user's own hand (the Bobine): MiniMax H3, not ready (the runtime offers its files, tool-runtime.mjs #missing).
  const routed = await catalog.route('create_video', asked, { ...media, byHand: true });
  assert.deepEqual([routed.workflow.id, routed.workflow.ready], [minimax.id, false]);
  // Named by Moodix AI, as before: refused, LTX 2.5 being here.
  await assert.rejects(catalog.route('create_video', asked, media), /ne peut pas exécuter create_video/);
});

test('the subjects of a take of the Bobine go to its model under their role; LTX 2.5 without its LoRA takes none (0.6.462)', async () => {
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async (id, more = {}) => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
    builtin: true,
    ...more,
  });
  const ltx = await shippedOf('eaec4e2f-0649-4e56-9bd9-809dc9390452'),
    minimax = await shippedOf('e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f'),
    conversation = 'c3333333-3333-4333-8333-333333333333',
    // (A list of its own each time: the router writes on the sources it is given.)
    asked = workflow => ({ prompt: 'Un astronaute marche.', workflow, reference: ['run-a', 'run-b'].map(output => ({ output, index: 0, conversation })) });
  // LTX 2.5: its two subject slots (msr_image), its LoRA switched on by them (native-workflows.mjs).
  const byLtx = await catalogOf([ltx, minimax]).route('create_video', asked(ltx.id), { ...media, byHand: true });
  assert.deepEqual(
    byLtx.args.references.map(reference => [reference.input, reference.output_id, reference.output_conversation]),
    [['subject-1', 'run-a', conversation], ['subject-2', 'run-b', conversation]],
  );
  // MiniMax H3 Omni: its slots of reference images.
  const byMinimax = await catalogOf([ltx, minimax]).route('create_video', asked(minimax.id), { ...media, byHand: true });
  const roles = Object.fromEntries(minimax.references.map(slot => [slot.id, slot.role]));
  assert.deepEqual(byMinimax.args.references.map(reference => roles[reference.input]), ['reference_image', 'reference_image']);
  // The Bobine is told the subjects of a model whose workflow lacks their LoRA: none taken, said so.
  const lacking = { ...ltx, loras: [] },
    told = async list => (await catalogOf(list).videoModels()).find(model => model.family === 'ltx25').create_video.roles.reference;
  assert.deepEqual([await told([ltx]), await told([lacking])], [{ count: 2 }, { count: 2, lora: false }]);
});

test('the Studio is told the models of an image, a video and a sound this computer lacks, with what to download (0.6.480)', async () => {
  // (27/11: on a first launch, the Studio of his friend showed one grey sentence, « Aucun modèle prêt ».)
  const { readFile } = await import('node:fs/promises');
  const shippedOf = async (id, more = {}) => ({
    ...JSON.parse(await readFile(new URL(`../runner/workflows/${id}.json`, import.meta.url), 'utf8')),
    ready: true,
    builtin: true,
    ...more,
  });
  const lacks = { ready: false, unavailableKind: 'files', unavailableReason: 'Fichier manquant.' },
    ids = {
      krea: 'fefb88eb-8311-4409-b636-6efbb42e952c',
      moss: '3d6f1a8c-2b7e-4f59-9c41-8e0a5d2b7c36',
      ltx: 'eaec4e2f-0649-4e56-9bd9-809dc9390452',
      omni: 'e06b6ac9-0d3f-4538-b9ff-bf41cf3ef38f',
      effects: '84390db5-e4b9-413c-9352-bbac225fe79c',
      music: '8a2e5baf-0c02-4077-b36c-482b4e54bb13',
      seedvr: '6b0f2e5c-7d1a-4c8e-9a3f-5e2d1c0b9a87',
    };
  const workflows = await Promise.all([
    shippedOf(ids.krea, lacks),
    shippedOf(ids.moss),
    shippedOf(ids.omni, lacks),
    shippedOf(ids.ltx, lacks),
    shippedOf(ids.effects, lacks),
    shippedOf(ids.music, lacks),
    shippedOf(ids.seedvr, lacks),
  ]);
  const license = { name: 'Apache-2.0', restricted: false },
    offer = (bytes, more = {}) => ({
      files: [{ role: 'model', file: 'model.safetensors', size: bytes, license }],
      bytes,
      left: bytes,
      complete: true,
      needsToken: false,
      page: '',
      ...more,
    }),
    asked = [];
  // As ModelDownloads.offers answers: the music model has a file of no known source (nothing to download from here).
  const offers = list => {
    asked.push(list.map(workflow => workflow.id).sort());
    return {
      [ids.krea]: offer(19e9),
      [ids.omni]: offer(40e9),
      [ids.ltx]: offer(41e9, { needsToken: true, page: 'https://huggingface.co/Lightricks/LTX-2' }),
      [ids.effects]: offer(3e9, { left: 1e9 }),
      [ids.music]: offer(9e9, { complete: false }),
      [ids.seedvr]: offer(7e9),
    };
  };
  const studio = await catalogOf(workflows).studio({ offers });
  // Asked once, for the shipped models that lack their files.
  assert.deepEqual(asked, [[ids.krea, ids.omni, ids.ltx, ids.effects, ids.music, ids.seedvr].sort()]);
  // (0.6.491) Of the videos to download, LTX 2.5 leads (the one the chat takes first), whatever the order they come in.
  assert.deepEqual(
    studio.create_video.map(item => item.id),
    [ids.ltx, ids.omni],
  );
  const told = verb =>
    studio[verb].map(item => [
      item.id,
      item.missing ? [item.missing.bytes, item.missing.left] : null,
      item.unavailable,
    ]);
  // A ready model first (the one in hand), then those to download, greyed for the router with their reason.
  assert.deepEqual(told('create_image'), [
    [ids.moss, null, undefined],
    [ids.krea, [19e9, 19e9], 'Fichier manquant.'],
  ]);
  const krea = studio.create_image[1];
  assert.deepEqual(krea.missing, {
    workflowId: ids.krea,
    files: [{ role: 'model', file: 'model.safetensors', size: 19e9, license }],
    bytes: 19e9,
    left: 19e9,
    needsToken: false,
    page: '',
  });
  assert.equal(krea.does, 'Photos, illustrations, retouche d’une image.');
  // An account asked by its source: said, with the page of its licence.
  assert.deepEqual(
    [told('create_video')[0], studio.create_video[0].missing.needsToken, studio.create_video[0].missing.page],
    [[ids.ltx, [41e9, 41e9], 'Fichier manquant.'], true, 'https://huggingface.co/Lightricks/LTX-2'],
  );
  // What a stopped download left to fetch; the music model, which cannot be downloaded from here, left out as before.
  assert.deepEqual(told('create_audio'), [[ids.effects, [3e9, 1e9], 'Fichier manquant.']]);
  // A take made larger or a clip continued: only what is here, never a download from those pages.
  assert.deepEqual([studio.upscale, studio.extend_video], [[], []]);
  // Without `offers` (the chat, the Bobine), as before: nothing lacking its files is listed.
  const before = await catalogOf(workflows).studio();
  assert.deepEqual(
    ['create_image', 'create_video', 'create_audio'].map(verb => before[verb].map(item => item.id)),
    [[ids.moss], [], []],
  );
  // Nothing lacks its files: nothing is asked.
  asked.length = 0;
  await catalogOf([await shippedOf(ids.moss)]).studio({ offers });
  assert.deepEqual(asked, []);
});
