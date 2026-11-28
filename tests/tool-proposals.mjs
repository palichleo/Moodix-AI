import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Resources } from '../lib/resources.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { ToolRuntime, takesStyles } from '../lib/tool-runtime.mjs';
import { preparationBytes } from '../lib/python-environment.mjs';
import { resolveNativeWorkflow, validateNativeWorkflow } from '../lib/native-workflows.mjs';
import { SUITE_NOTE } from '../lib/unasked-suite.mjs';

/**
 * Proposals as the application makes them, with the workflows it ships (their real slots, lengths
 * and profiles) and everything else in memory: the creations, the references of the project, the
 * chat model and the generator.
 */
const folder = fileURLToPath(new URL('../runner/workflows/', import.meta.url));
const shipped = () =>
  readdirSync(folder)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ ...validateNativeWorkflow(JSON.parse(readFileSync(join(folder, name), 'utf8'))), ready: true }));
const of = (list, pipeline) => list.find(workflow => workflow.pipeline === pipeline);
const assets = { resolve: async id => ({ id, path: join(tmpdir(), `${id}.safetensors`) }) };
// Identifiers that read at a glance: uid(3) is 33333333-3333-4333-8333-333333333333.
const uid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/**
 * `library`: the references of the project kept for real (a Resources of lib/resources.mjs) in place
 * of those in memory; `extractStill`: what reads the first or last picture of a video file.
 */
function world({
  workflows = shipped(),
  records = {},
  resources = {},
  client = null,
  library = null,
  extractStill = null,
  projectOf,
  missing = [],
  savedStyles,
  offerOf,
} = {}) {
  const saved = [],
    closing = { close: async () => {} };
  client ??= {
    status: async () => ({ idle: true }),
    stage: async () => ({ path: join(tmpdir(), 'staged') }),
    upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    run: async job => ({
      outputs: [{ filename: 'made.mp4', subfolder: '', type: 'output' }],
      metadata: { parameters: job.parameters },
    }),
    free: async () => ({}),
  };
  const gallery = {
    get: async (conversation, id) => {
      const record = records[`${conversation}/${id}`];
      if (!record) throw Object.assign(Error('Entrée ou copie d’analyse introuvable.'), { status: 404 });
      return structuredClone(record);
    },
    put: async record => {
      saved.push(record);
      records[`${record.conversationId}/${record.id}`] = record;
      return record;
    },
  };
  library ??= {
    activeRecord: async id => {
      if (!resources[id]) throw Object.assign(Error('Ressource introuvable.'), { status: 404 });
      return { id, ready: true, enabled: true, ...resources[id] };
    },
    readActive: async id => ({
      ...(await library.activeRecord(id)),
      frames: [{ time: 0, url: 'data:image/png;base64,AAAA' }],
    }),
    used: async () => {},
  };
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => void (engine.state = 'stopped'),
    start: async () => void (engine.state = 'ready'),
  };
  const runtime = new ToolRuntime({
    engine,
    catalog: {
      kind: 'native',
      list: async () => workflows,
      read: async id => workflows.find(workflow => workflow.id === id),
      prepare: async (id, args, options) => {
        const workflow = workflows.find(item => item.id === id);
        return { workflow, job: await resolveNativeWorkflow(workflow, args, assets, options), outputNodes: [] };
      },
    },
    gallery,
    resources: library,
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => client,
    extractStill,
    ...(projectOf ? { projectOf } : {}),
    ...(savedStyles ? { savedStyles } : {}),
    // (0.6.476) What a shipped workflow lacks, to download from the card of a proposal.
    ...(offerOf ? { offerOf } : {}),
    // (`path`: where the file is, as the application says it; `missing`: files gone from the disk.)
    sourceMedia: async (ref, conversationId) => {
      if (ref.resource_id) {
        const record = await library.activeRecord(ref.resource_id);
        return { mime: record.mime, name: record.name, handle: closing, path: join('references', ref.resource_id) };
      }
      const record = await gallery.get(ref.output_conversation ?? conversationId, ref.output_id);
      const filename = record.outputs?.[ref.output_index ?? 0]?.source?.filename ?? '';
      if (missing.includes(filename)) throw Object.assign(Error('ENOENT: no such file'), { code: 'ENOENT' });
      return {
        mime: record.mediaType === 'video' ? 'video/mp4' : 'image/png',
        name: record.workflowName,
        handle: closing,
        path: join('output', filename),
      };
    },
  });
  return { runtime, saved, records, workflows };
}

const A = uid(1),
  turn = uid(2);
/** A clip as its record keeps it. */
const clip = (conversationId, id, workflow, parameters = {}, size = [768, 448]) => ({
  provider: 'native',
  mediaType: 'video',
  id,
  conversationId,
  workflowId: workflow.id,
  workflowName: workflow.name,
  parameters: { pipeline: workflow.pipeline, width: size[0], height: size[1], fps: 24, stage: 'draft', ...parameters },
  outputs: [{ source: { filename: id + '.mp4', subfolder: '', type: 'output' }, width: size[0], height: size[1] }],
});
const picture = (name, width = 1024, height = 1024) => ({ mime: 'image/png', width, height, name, label: name });
// A MiniMax H3 workflow with every slot of its family (the shipped « Omni » has no start nor end):
// reference images do not combine with a first or a last frame.
const minimaxFull = () => {
  const omni = of(shipped(), 'minimax_h3'),
    { ready, digest, ...stored } = omni;
  return {
    ...validateNativeWorkflow({
      ...stored,
      id: 'minimax-full',
      name: 'MiniMax H3',
      references: [
        { id: 'source', role: 'source_video', required: false, name: 'Vidéo à prolonger' },
        { id: 'start', role: 'start_image', required: false, name: 'Image de début' },
        { id: 'end', role: 'end_image', required: false, name: 'Image de fin' },
        { id: 'subject-1', role: 'reference_image', required: false, name: 'Référence 1' },
        { id: 'subject-2', role: 'reference_image', required: false, name: 'Référence 2' },
      ],
    }),
    ready: true,
  };
};
const revise = (runtime, request, edits) =>
  runtime.revise({ requestId: request.requestId, approvalToken: request.approvalToken, edits });
const rolesOf = request => request.plan.references.map(ref => ref.role);

test('the call the schema of create_video demands promotes a draft: its prompt and its duration are left aside', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    { runtime, saved } = world({ workflows: list });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat crosses the bay at dawn.', intention: 'Brouillon', duration: 5, workflow: ltx.id })],
    place,
  );
  assert.equal(first.plan.stage, 'draft');
  await runtime.execute({ requestId: first.requestId, permission: 'once', approvalToken: first.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const draft = saved[0];
  // What the model is offered next: prompt and duration are required in every call.
  const schema = (
    await new ToolCatalog({ list: async () => list }).definitions({
      images: 0,
      resources: [],
      takes: [],
      outputs: [{ id: draft.id, mediaType: 'video', count: 1, workflowId: draft.workflowId, draft: true }],
    })
  ).find(item => item.function.name === 'create_video').function.parameters;
  assert.deepEqual(schema.properties.reuse_output.enum, [draft.id]);
  for (const key of ['prompt', 'duration', 'intention']) assert.ok(schema.required.includes(key), key);
  assert.match(schema.properties.reuse_output.description, /prompt and duration say is then not used/);
  // The smallest call that satisfies it (what a constrained decoder writes).
  const conforming = { reuse_output: draft.id, stage: 'final', intention: 'Version finale', prompt: draft.prompt, duration: null };
  assert.ok(schema.required.every(key => key in conforming));
  const final = await runtime.request([call('create_video', conforming, 'call-2')], { ...place, turnId: uid(3) });
  assert.equal(final.plan.stage, 'final');
  assert.equal(final.plan.prompt, draft.prompt);
  assert.equal(final.plan.parameters.frames, draft.parameters.frames, 'the length of the draft');
  assert.equal(final.plan.parameters.seed, draft.parameters.seed, 'its seed');
  assert.equal(final.notes, undefined);
  // A length and other words made up for it: the draft's are kept, and the user is told for the prompt.
  const reworded = await runtime.request(
    [call('create_video', { ...conforming, prompt: 'A blue boat.', duration: 10 }, 'call-3')],
    { ...place, turnId: uid(4) },
  );
  assert.equal(reworded.plan.prompt, draft.prompt);
  assert.equal(reworded.plan.parameters.frames, draft.parameters.frames);
  assert.deepEqual(reworded.notes, ['Version finale du brouillon : son prompt est repris tel quel.']);
  // An image the user names with that request cannot go in the call: the model is not sent back
  // to pass it (no `cited`, which makes the chat route refuse the call), the proposal says why.
  const named = await runtime.request([call('create_video', conforming, 'call-4')], {
    ...place,
    turnId: uid(5),
    cited: [{ id: uid(6), label: '#ref1' }],
  });
  assert.equal(named.cited, undefined);
  assert.deepEqual(named.notes, ['#ref1 n’est pas transmise : la version finale reprend les entrées du brouillon.']);
  // The same image named for a new video is still asked for where the workflow has a place for it.
  const fresh = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', duration: 5, workflow: ltx.id }, 'call-5')],
    { ...place, turnId: uid(7), cited: [{ id: uid(6), label: '#ref1' }] },
  );
  assert.deepEqual(fresh.cited.left, [{ id: uid(6), label: '#ref1' }]);
  assert.ok(fresh.cited.roles.length);
});

test('the card of a continuation by LTX 2.5 shows and takes what the model may pass: its clip, nothing else', async () => {
  const list = shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    CLIP = uid(3),
    IMAGE = uid(4);
  const { runtime } = world({
    workflows: list,
    records: { [`${A}/${CLIP}`]: clip(A, CLIP, ltx) },
    resources: { [IMAGE]: picture('escalier.png') },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  // (0.6.493) An image the model passes beside the clip is no longer refused to it (« no free image slot », relecture,
  // M1): the suite is proposed with its clip alone, the image stays greyed in its card with why, and its line says to
  // remove it. It is not sent…
  const suite = { prompt: 'x', intention: 'Suite', source: { output: CLIP }, reference: [{ resource: IMAGE }] },
    kept = await runtime.request([call('extend_video', suite)], place);
  assert.deepEqual(rolesOf(kept), ['source_video']);
  assert.deepEqual(kept.held.map(item => [item.as, item.label]), [['reference', 'escalier.png']]);
  assert.equal(kept.held[0].why, 'LTX 2.5 ne prend pas de sujet dans une suite. Il reste là, mais n’est pas envoyé.');
  assert.equal(kept.warning, 'Le sujet 1 n’est pas envoyé à LTX 2.5 : retirez-le.');
  // …so the card has no case for one (it had DÉBUT, FIN and RÉF., and revise took an image in each)…
  const proposal = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', duration: 5, source: { output: CLIP } })],
    place,
  );
  assert.deepEqual(proposal.inputRoles, ['source_video']);
  assert.deepEqual(proposal.plan.editable.references, [[]]);
  // …and an image sent there all the same is refused in the user's words, under either name of its role.
  for (const [role, said] of [
    ['start_image', /LTX 2\.5 ne prend pas d’image de début pour la suite d’une vidéo\./],
    ['end_image', /LTX 2\.5 ne prend pas d’image de fin pour la suite d’une vidéo\./],
    ['msr_image', /LTX 2\.5 ne prend pas de sujet pour la suite d’une vidéo\./],
    ['reference', /LTX 2\.5 ne prend pas de sujet pour la suite d’une vidéo\./],
    ['nowhere', /LTX 2\.5 ne prend pas d’image à cet endroit\./],
  ])
    await assert.rejects(revise(runtime, proposal, { add: { role, source: { resource: IMAGE } } }), said, role);
  // A refusal changes nothing: the proposal is still the one to confirm.
  assert.ok(runtime.pending.has(proposal.requestId));
  assert.deepEqual(rolesOf(await revise(runtime, proposal, {})), ['source_video']);
});

test('inputs a family does not combine are refused on the card, and held greyed when the model passes them (MiniMax: references, or a first and last frame)', async () => {
  const minimax = minimaxFull(),
    CLIP = uid(3),
    [ONE, TWO, THREE] = [uid(4), uid(5), uid(6)];
  const { runtime } = world({
    workflows: [minimax],
    records: { [`${A}/${CLIP}`]: clip(A, CLIP, minimax) },
    resources: { [ONE]: picture('un.png'), [TWO]: picture('deux.png'), [THREE]: picture('trois.png') },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const video = (args, id) => runtime.request([call('create_video', { prompt: 'x', intention: 'x', ...args }, id)], place);
  // (0.6.493) Both passed by the model: no longer refused (« do not combine », relecture, M1). The start goes, the
  // subject stays greyed in the card with why, and its line says which of them to remove.
  const both = await video({ reference: [{ resource: ONE }], start_image: { resource: TWO } });
  assert.deepEqual(rolesOf(both), ['start_image']);
  assert.deepEqual(both.held.map(item => item.as), ['reference']);
  assert.equal(
    both.held[0].why,
    'MiniMax H3 prend des sujets ou un début et une fin, pas les deux : celui-ci reste là, mais n’est pas envoyé.',
  );
  assert.equal(
    both.warning,
    'MiniMax H3 prend des sujets ou un début et une fin, pas les deux : retirez l’image de début ou le sujet.',
  );

  // One reference: the cases left are those of references; alone, it may still become a frame.
  const one = await video({ reference: [{ resource: ONE }] });
  assert.deepEqual(one.inputRoles, ['reference_image', 'reference_image']);
  assert.deepEqual(
    one.plan.editable.references[0].map(option => option.role),
    ['start_image', 'end_image', 'reference_image'],
  );
  // (0.6.190) Named « Sujet » in the list « Rôle » of the card.
  assert.equal(one.plan.editable.references[0].find(option => option.role === 'reference_image').label, 'Sujet');
  await assert.rejects(
    revise(runtime, one, { add: { role: 'start_image', source: { resource: TWO } } }),
    /MiniMax H3 ne prend pas ces entrées ensemble : sujet et image de début\./,
  );
  const two = await revise(runtime, one, { add: { role: 'reference_image', source: { resource: TWO } } });
  assert.deepEqual(rolesOf(two), ['reference_image', 'reference_image']);
  // Two references: one of them alone cannot become the first frame, both can become first and last.
  assert.deepEqual(two.plan.editable.references.map(options => options.map(option => option.role)), [
    ['reference_image'],
    ['reference_image'],
  ]);
  await assert.rejects(
    revise(runtime, two, { references: [{ index: 0, role: 'start_image' }] }),
    /MiniMax H3 ne prend pas ces entrées ensemble : sujet et image de début\./,
  );
  const framed = await revise(runtime, two, {
    references: [
      { index: 0, role: 'start_image' },
      { index: 1, role: 'end_image' },
    ],
  });
  assert.deepEqual(rolesOf(framed), ['start_image', 'end_image']);
  // A first and a last frame: no case for a reference any more.
  assert.deepEqual(framed.inputRoles, ['start_image', 'end_image']);
  await assert.rejects(
    revise(runtime, framed, { add: { role: 'reference_image', source: { resource: THREE } } }),
    /MiniMax H3 ne prend pas ces entrées ensemble : sujet, image de début et image de fin\./,
  );

  // A continuation: references go with its clip, never a first or a last frame.
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', source: { output: CLIP } }, 'call-9')],
    place,
  );
  assert.deepEqual(next.inputRoles, ['source_video', 'reference_image', 'reference_image']);
  await assert.rejects(
    revise(runtime, next, { add: { role: 'end_image', source: { resource: ONE } } }),
    /MiniMax H3 ne prend pas d’image de fin pour la suite d’une vidéo\./,
  );
  const withSubject = await revise(runtime, next, { add: { role: 'reference_image', source: { resource: ONE } } });
  assert.deepEqual(rolesOf(withSubject), ['source_video', 'reference_image']);
});

test('an input changes role under the name of the slot (msr_image) or the name of the verb’s role (reference)', async () => {
  const list = shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    IMAGE = uid(4);
  const { runtime } = world({ workflows: list, resources: { [IMAGE]: picture('plage.png', 1024, 576) } });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const proposal = () =>
    runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image: { resource: IMAGE } })],
      place,
    );
  // The Studio names its cases as the verb names its roles; a proposal lists the slots of the family.
  for (const role of ['reference', 'msr_image']) {
    const moved = await revise(runtime, await proposal(), { references: [{ index: 0, role }] });
    assert.deepEqual(
      moved.plan.references.map(ref => [ref.role, ref.as, ref.input]),
      [['msr_image', 'reference', 'subject-1']],
      role,
    );
    assert.deepEqual(moved.plan.loras.map(lora => lora.id), ['reference-slots'], 'a subject reference brings its LoRA');
    // And back, under the name both sides share.
    assert.deepEqual(rolesOf(await revise(runtime, moved, { references: [{ index: 0, role: 'start_image' }] })), ['start_image']);
  }
  for (const role of ['source', 'source_video', 'nowhere'])
    await assert.rejects(
      revise(runtime, await proposal(), { references: [{ index: 0, role }] }),
      /« plage\.png » ne peut pas prendre ce rôle dans LTX 2\.5\./,
      role,
    );
});

test('a clip upscaled or smoothed in its own conversation is traced back to its original from another conversation of the project', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    esrgan = of(list, 'realesrgan_video'),
    rife = of(list, 'rife'),
    B = uid(5),
    C = uid(6),
    [CLIP, BIG, SMOOTH, BOTH, FAST, SLOW, HERE] = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map(uid);
  // What a transform keeps of its source: no conversation when it was made in the same one.
  const made = (conversationId, id, workflow, source, parameters = {}, size = [768, 448]) => ({
    ...clip(conversationId, id, workflow, {}, size),
    parameters: {
      pipeline: workflow.pipeline,
      ...parameters,
      references: [{ input: 'source', original: true, role: 'source_video', ...source }],
    },
  });
  const { runtime } = world({
    workflows: list,
    records: {
      // In B: an LTX clip, its upscale, its smoothing (48 fps), and the upscale smoothed.
      [`${B}/${CLIP}`]: clip(B, CLIP, ltx),
      [`${B}/${BIG}`]: made(B, BIG, esrgan, { output_id: CLIP }, {}, [1536, 896]),
      [`${B}/${SMOOTH}`]: made(B, SMOOTH, rife, { output_id: CLIP }, { multiplier: 2, mode: 'smooth' }),
      [`${B}/${BOTH}`]: made(B, BOTH, rife, { output_id: BIG }, { multiplier: 2, mode: 'smooth' }, [1536, 896]),
      // In B: a clip at 30 images a second, and its slow motion (its own source, still 30).
      [`${B}/${FAST}`]: clip(B, FAST, ltx, { fps: 30 }),
      [`${B}/${SLOW}`]: made(B, SLOW, rife, { output_id: FAST }, { multiplier: 2, mode: 'slow_motion' }),
      // In A: an upscale of the clip of B, which names that conversation.
      [`${A}/${HERE}`]: made(A, HERE, esrgan, { output_id: CLIP, output_conversation: B }, {}, [1536, 896]),
    },
  });
  const extend = (conversationId, source) =>
    runtime.request([call('extend_video', { prompt: 'x', intention: 'Suite', source })], {
      conversationId,
      turnId: turn,
      messages: [],
    });
  const origin = request => request.plan.references.map(ref => [ref.output_id, ref.output_conversation]);
  // From B itself, as before: the clip, with no conversation to name.
  const own = await extend(B, { output: BIG });
  assert.deepEqual(origin(own), [[CLIP, undefined]]);
  // From A, the Sortie of the Studio lists the takes of B (« Prolonger » sends their conversation):
  // the same clip, at its own size, by the model that made it. It was the upscaled file itself,
  // 1536 × 896, handed to whatever workflow the ranking fell on.
  for (const output of [BIG, SMOOTH, BOTH]) {
    const request = await extend(A, { output, conversation: B });
    assert.deepEqual(origin(request), [[CLIP, B]], output);
    assert.deepEqual(request.resolution, { width: 768, height: 448 });
    assert.equal(request.workflowName, ltx.name, 'the family that made the footage continues it');
    assert.match(request.notes.join(' '), /vidéo d’origine/);
  }
  // A result of A whose source is in B, continued from A then from a third conversation.
  assert.deepEqual(origin(await extend(A, { output: HERE })), [[CLIP, B]]);
  assert.deepEqual(origin(await extend(C, { output: HERE, conversation: A })), [[CLIP, B]]);
  // The frame rate is read through the chain too: refused before the user confirms.
  await assert.rejects(extend(B, { output: SLOW }), /30 images\/s.*24 images\/s/);
  await assert.rejects(extend(A, { output: SLOW, conversation: B }), /30 images\/s.*24 images\/s/);
});

test('a length the model made up is dropped when the only numbers of the request name a reference, a take or a format', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    IMAGE = uid(4);
  const { runtime } = world({ workflows: list, resources: { [IMAGE]: picture('plage.png', 1024, 576) } });
  // The model must answer « duration » (a number or null): it writes ten seconds nobody asked for.
  const frames = async said =>
    (
      await runtime.request(
        [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, duration: 10, start_image: { resource: IMAGE } })],
        { conversationId: A, turnId: turn, messages: [{ role: 'user', content: said }] },
      )
    ).plan.parameters.frames;
  const standard = ltx.parameters.frames.default;
  assert.equal(await frames('Anime cette image, la caméra avance lentement'), standard);
  assert.equal(await frames('Anime #ref1, la caméra avance lentement'), standard, 'a label is no length');
  assert.equal(await frames('Anime #ref1 en 9:16, comme la prise 12'), standard);
  // A length the user gave stays the one generated.
  assert.equal(await frames('Anime #ref1 pendant 10 secondes'), 241);
});

test('the format of a clip follows the image it starts from when the user puts it there, as when the model passes it', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [WIDE, TALL] = [uid(4), uid(5)],
    size = request => [request.resolution.width, request.resolution.height];
  const { runtime } = world({
    workflows: list,
    resources: { [WIDE]: picture('paysage.png', 1920, 1080), [TALL]: picture('portrait.png', 1080, 1920) },
  });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const video = args =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, ...args })], place);
  const start = resource => ({ add: { role: 'start_image', source: { resource } } });
  // The profile of the shipped LTX 2.5 draft is a portrait; the image is a landscape.
  assert.deepEqual(size(await video({})), [288, 512]);
  assert.deepEqual(size(await video({ start_image: { resource: WIDE } })), [512, 288], 'passed by the model');
  // Put in DÉBUT on the card: the same. (It stayed 288 × 512: a landscape animated in portrait.)
  const added = await revise(runtime, await video({}), start(WIDE));
  assert.deepEqual(size(added), [512, 288]);
  assert.equal(added.plan.edited, undefined, 'a format that follows the image is not an edit');
  // Another image in its place, of another format: followed too; and in the final version.
  assert.deepEqual(size(await revise(runtime, added, start(TALL))), [288, 512]);
  assert.deepEqual(size(await revise(runtime, await video({}), { ...start(WIDE), stage: 'final' })), [1600, 896]);
  // A reference given the role of first frame, then given back: the format follows, then leaves.
  const subject = await video({ reference: [{ resource: WIDE }] });
  assert.deepEqual(size(subject), [288, 512]);
  const first = await revise(runtime, subject, { references: [{ index: 0, role: 'start_image' }] });
  assert.deepEqual(size(first), [512, 288]);
  assert.deepEqual(size(await revise(runtime, first, { references: [{ index: 0, role: 'reference' }] })), [288, 512]);
  // A format asked for stays, and so does a size the user set.
  assert.deepEqual(size(await revise(runtime, await video({ format: '1:1' }), start(WIDE))), [384, 384]);
  const sized = await revise(runtime, await video({}), { width: 384, height: 256 });
  assert.deepEqual(size(await revise(runtime, sized, start(TALL))), [384, 256]);
});

test('an image joined to the message, given the role of first frame on the proposal, gives the clip its format', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    // A PNG of one pixel: a square.
    png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
  const { runtime } = world({ workflows: list });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'avec elle' }, { type: 'image_url', image_url: { url: png } }] }];
  const subject = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, reference: [{ image: 0 }] })],
    { conversationId: A, turnId: turn, messages },
  );
  assert.deepEqual(subject.resolution, { width: 288, height: 512 });
  // revise() has the proposal, not the conversation: the image is measured from what the proposal kept of it.
  const first = await revise(runtime, subject, { references: [{ index: 0, role: 'start_image' }] });
  assert.deepEqual(first.resolution, { width: 384, height: 384 });
});

test('the lengths told to the model before a continuation are those a continuation adds, the overlap counted', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    tools = new ToolCatalog({ list: async () => list });
  const told = async name => Object.fromEntries((await tools.lengths(name)).map(item => [item.name, item]));
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);
  // A new clip: every frame is new footage.
  const created = await told('create_video');
  near(created[ltx.name].min, 9 / 24, 'LTX shortest');
  near(created[ltx.name].max, 241 / 24, 'LTX longest');
  near(created[ltx.name].standard, 121 / 24, 'LTX usual');
  near(created[minimax.name].max, 345 / 24, 'MiniMax longest');
  // A continuation renders the end of its source again: 9 frames with LTX 2.5, 22 with MiniMax H3.
  const continued = await told('extend_video');
  near(continued[ltx.name].min, (17 - 9) / 24, 'LTX shortest continuation');
  near(continued[ltx.name].max, (241 - 9) / 24, 'LTX longest continuation');
  near(continued[ltx.name].standard, (129 - 9) / 24, 'LTX usual continuation');
  near(continued[minimax.name].min, (124 - 22) / 24, 'MiniMax shortest continuation');
  near(continued[minimax.name].max, (345 - 22) / 24, 'MiniMax longest continuation');
  near(continued[minimax.name].standard, (141 - 22) / 24, 'MiniMax usual continuation');
  // What is told is what the router gives: asked for, each of these lengths is met without a note.
  const media = { mediaOf: async () => 'video' };
  for (const workflow of [ltx, minimax])
    for (const key of ['min', 'max', 'standard']) {
      const duration = continued[workflow.name][key],
        routed = await tools.route(
          'extend_video',
          { prompt: 'x', intention: 'y', workflow: workflow.id, duration, source: { output: uid(3) } },
          media,
        );
      assert.deepEqual(routed.notes, [], `${workflow.name} ${key}`);
      near((routed.args.frames - (workflow.pipeline === 'ltx25' ? 9 : 22)) / 24, duration, `${workflow.name} ${key}`);
    }
});

test('a frame only means something for a video: an image reference named with one is passed as its file', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [IMAGE, VIDEO] = [uid(4), uid(5)],
    how = [];
  // The generator: an original is staged from its file, a copy made for the model is uploaded.
  const client = {
    status: async () => ({ idle: true }),
    stage: async () => (how.push('file'), { path: join(tmpdir(), 'staged') }),
    upload: async () => (how.push('copy'), { path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    run: async job => ({ outputs: [{ filename: 'made.mp4', subfolder: '', type: 'output' }], metadata: { parameters: job.parameters } }),
    free: async () => ({}),
  };
  const { runtime, saved } = world({
    workflows: list,
    client,
    resources: { [IMAGE]: picture('plage.png', 1024, 576), [VIDEO]: { mime: 'video/mp4', width: 768, height: 448, name: 'clip.mp4' } },
  });
  // The tool offers `frame` on an image role as soon as the project holds a video.
  const schema = (
    await new ToolCatalog({ list: async () => list }).definitions({
      images: 0,
      resources: [
        { id: IMAGE, type: 'image' },
        { id: VIDEO, type: 'video' },
      ],
      outputs: [],
      takes: [],
    })
  ).find(item => item.function.name === 'create_video').function.parameters.properties.start_image;
  assert.ok(schema.properties.frame, 'a frame may be named');
  const made = async (start_image, id) => {
    how.length = 0;
    const request = await runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)],
      { conversationId: A, turnId: uid(6), messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return request;
  };
  // Named on an image, the frame is left out: the generator gets the file, not the reduced copy.
  const still = await made({ resource: IMAGE, frame: 0 }, 'call-1');
  assert.deepEqual(still.args.references, [{ input: 'start', resource_id: IMAGE }]);
  assert.equal(still.plan.references[0].original, true);
  assert.deepEqual(how, ['file']);
  // A frame of a video is still the copy of that frame.
  const moving = await made({ resource: VIDEO, frame: 0 }, 'call-2');
  assert.deepEqual(moving.args.references, [{ input: 'start', resource_id: VIDEO, frame: 0 }]);
  assert.equal(moving.plan.references[0].original, undefined);
  assert.deepEqual(how, ['copy']);
  // A request kept from before, replayed with its frame on an image (a draft promoted): the file too.
  const draft = saved[0];
  draft.parameters.replay_args.references[0].frame = 0;
  const final = await runtime.request(
    [call('create_video', { reuse_output: draft.id, stage: 'final', intention: 'Version finale' }, 'call-3')],
    { conversationId: A, turnId: uid(7), messages: [] },
  );
  assert.equal(final.plan.references[0].original, true);
  assert.equal(final.plan.references[0].frame, undefined);
});

test('the record of an upscale or a smoothing keeps the size, the rate and the frame count the engine reports', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    CLIP = uid(3),
    PHOTO = uid(4);
  // The engine, answering as its pipelines do (runner/pipelines): a transform has no parameter for
  // its size or its rate, it says them with the file it wrote.
  const client = {
    status: async () => ({ idle: true }),
    stage: async () => ({ path: join(tmpdir(), 'staged') }),
    upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
    preflight: async () => {},
    free: async () => ({}),
    run: async job =>
      job.pipeline === 'rife'
        ? {
            outputs: [{ filename: 'slow.mp4', subfolder: '', type: 'output', width: 768, height: 448 }],
            metadata: { job, backend: 'pytorch-rife', frames: 241, fps: 24, source_fps: 24, mode: job.parameters.mode },
          }
        : job.mediaType === 'video'
          ? {
              outputs: [{ filename: 'big.mp4', subfolder: '', type: 'output', width: 1536, height: 896 }],
              metadata: { job, backend: 'pytorch-rrdbnet', scale: 2, frames: 121, fps: 24, source: [768, 448] },
            }
          : {
              outputs: [{ filename: 'big.png', subfolder: '', type: 'output', width: 2048, height: 2048 }],
              metadata: { job, backend: 'pytorch-seedvr2-7b', source: [1024, 1024] },
            },
  };
  // The real gallery: what it keeps of a record is what the next request reads.
  const { Gallery } = await import('../lib/gallery.mjs');
  const gallery = new Gallery({ historyDir: join(tmpdir(), 'moodix-test-no-history-' + uid(7)) });
  const kept = { prompt: 'A red boat.', createdAt: new Date().toISOString() };
  await gallery.put({ ...clip(A, CLIP, ltx, { frames: 121 }), ...kept });
  await gallery.put({
    ...clip(A, PHOTO, of(list, 'krea2'), {}, [1024, 1024]),
    ...kept,
    mediaType: 'image',
    outputs: [{ source: { filename: 'photo.png', subfolder: '', type: 'output' }, width: 1024, height: 1024 }],
  });
  const { runtime } = world({ workflows: list, client });
  runtime.gallery = gallery;
  runtime.sourceMedia = async ref => ({
    mime: ref.output_id === PHOTO ? 'image/png' : 'video/mp4',
    name: 'Prise',
    handle: { close: async () => {} },
  });
  const make = async (verb, args, id) => {
    const request = await runtime.request([call(verb, args, id)], { conversationId: A, turnId: uid(8), messages: [] });
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return gallery.get(A, runtime.status().record.id, { includeImages: false });
  };
  const big = await make('upscale', { source: { output: CLIP } }, 'call-1');
  assert.deepEqual([big.outputs[0].width, big.outputs[0].height], [1536, 896], 'the size of the file made');
  assert.deepEqual([big.parameters.fps, big.parameters.frames], [24, 121]);
  const still = await make('upscale', { source: { output: PHOTO } }, 'call-2');
  assert.deepEqual([still.outputs[0].width, still.outputs[0].height], [2048, 2048]);
  assert.equal(still.parameters.fps, undefined, 'an image has no rate');
  const slow = await make('interpolate', { source: { output: CLIP }, mode: 'slow_motion' }, 'call-3');
  assert.deepEqual([slow.outputs[0].width, slow.outputs[0].height], [768, 448]);
  assert.deepEqual([slow.parameters.fps, slow.parameters.frames], [24, 241]);
  // What reads it next: a slow motion is its own source, continued at the size its record says
  // (without it, the profile's 288 × 512, which the engine then refused against the file).
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'Suite', workflow: ltx.id, source: { output: slow.id } }, 'call-4')],
    { conversationId: A, turnId: uid(9), messages: [] },
  );
  assert.equal(next.plan.references[0].output_id, slow.id);
  assert.deepEqual(next.resolution, { width: 768, height: 448 });
});

test('a seed typed on a proposal stays the user’s through the changes that follow', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    { runtime, saved } = world({ workflows: list });
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  const typed = await revise(runtime, first, { seed: 5 });
  assert.deepEqual(typed.plan.edited, ['seed']);
  // Anything else changed afterwards (the card only sends what differs from what it shows).
  const reworded = await revise(runtime, typed, { prompt: 'A blue boat.' });
  assert.equal(reworded.plan.parameters.seed, 5);
  assert.deepEqual(reworded.plan.edited, ['seed'], 'it was no longer an edit after a second change');
  await runtime.execute({ requestId: reworded.requestId, permission: 'once', approvalToken: reworded.approvalToken });
  await runtime.finished;
  const record = saved.at(-1);
  assert.equal(record.parameters.seed, 5);
  assert.equal(record.parameters.seed_given, true, 'the take says its seed was named');
  assert.deepEqual(record.parameters.user_overrides, { seed: 5 });
  // Set back to the seed the proposal came with, it is no edit any more.
  const again = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id }, 'call-2')],
    { conversationId: A, turnId: uid(3), messages: [] },
  );
  const back = await revise(runtime, await revise(runtime, again, { seed: 7 }), { seed: again.plan.parameters.seed });
  assert.equal(back.plan.edited, undefined);
  assert.equal(back.plan.parameters.seed, again.plan.parameters.seed);
});

test('the LoRAs of the user shown with a proposal go with it: kept through later changes, said by the take, none where the family takes none', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    { runtime, saved } = world({ workflows: list });
  const boat = (id, workflow = ltx) =>
    runtime.request([call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: workflow.id }, id)], {
      conversationId: A,
      turnId: uid(4 + saved.length),
      messages: [],
    });
  // A proposal of Moodix AI comes without any.
  const first = await boat('call-1');
  assert.equal(first.styles, undefined);
  // Those the Studio shows for its family, sent with « Générer ».
  const styles = [{ name: 'sub\\grain.safetensors', strength: 0.8 }];
  const styled = await revise(runtime, first, { styles });
  assert.deepEqual(styled.styles, styles);
  // Another change afterwards says nothing of them: they stay.
  const reworded = await revise(runtime, styled, { prompt: 'A blue boat.' });
  assert.deepEqual(reworded.styles, styles);
  await runtime.execute({ requestId: reworded.requestId, permission: 'once', approvalToken: reworded.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, styles, 'the take says what it was made with');
  // Taken out on the proposal: none goes, and the take names none.
  const second = await revise(runtime, await revise(runtime, await boat('call-2'), { styles }), { styles: [] });
  assert.equal(second.styles, undefined);
  await runtime.execute({ requestId: second.requestId, permission: 'once', approvalToken: second.approvalToken });
  await runtime.finished;
  assert.equal(saved.at(-1).parameters.styles, undefined);
  // Checked as those of a creation by hand.
  const third = await boat('call-3');
  await assert.rejects(
    revise(runtime, third, { styles: [1, 2, 3, 4].map(n => ({ name: n + '.safetensors', strength: 1 })) }),
    /trois LoRA au plus/,
  );
  // A family whose engine takes none (MiniMax H3): never kept, by hand or on a proposal, so that
  // no take says it was made with a LoRA that was left out.
  assert.equal(takesStyles(minimax), false);
  assert.equal(takesStyles(ltx), true);
  const plain = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', workflow: minimax.id }, 'call-4')],
    { conversationId: A, turnId: uid(9), messages: [], styles },
  );
  assert.equal(plain.styles, undefined);
  assert.equal((await revise(runtime, plain, { styles })).styles, undefined);
});

test('an image made from another keeps its format: a portrait is not fitted into the square of the profile', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    PORTRAIT = uid(7),
    { runtime } = world({ workflows: list, resources: { [PORTRAIT]: picture('escalier.png', 1536, 2728) } });
  const edit = (args, id) =>
    runtime.request([call('create_image', { prompt: 'The same staircase at night.', workflow: krea.id, ...args }, id)], {
      conversationId: A,
      turnId: turn,
      messages: [],
    });
  // No size asked: the format of the source, at the number of pixels of the profile.
  const followed = await edit({ source: { resource: PORTRAIT } }, 'call-1');
  const { width, height } = followed.resolution;
  assert.ok(height > width, `${width}x${height}`);
  assert.ok(Math.abs(width / height - 9 / 16) < 0.02, `${width}x${height}`);
  assert.ok(Math.abs(width * height - 1024 * 1024) / (1024 * 1024) < 0.1, `${width}x${height}`);
  // A size asked for is kept, and an image without a source keeps the size of its profile.
  const asked = await edit({ source: { resource: PORTRAIT }, width: 1024, height: 1024 }, 'call-2');
  assert.deepEqual(asked.resolution, { width: 1024, height: 1024 });
  const alone = await edit({}, 'call-3');
  assert.deepEqual(alone.resolution, { width: 1024, height: 1024 });
});

/**
 * The first or last image of a video where an image is taken (`frame`: "first" or "last"): the
 * references of the project kept for real, in a folder of their own, and the reading of the video
 * replaced by a function that says what it was asked and gives a picture of 1280 × 720.
 */
const PROJECT = uid(9);
const DOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6rLkAAAAASUVORK5CYII=';
// A PNG as far as its header goes (its size is read there), each `tag` its own file.
const pngOf = (width, height, tag = '') => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return Buffer.concat([bytes, Buffer.from(tag)]);
};
async function stillsWorld(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-stills-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const library = new Resources(join(root, 'resources')),
    asked = [];
  const made = world({
    library,
    projectOf: async () => PROJECT,
    extractStill: async (path, at) => {
      asked.push([path, at]);
      return { bytes: pngOf(1280, 720, path + at), preview: DOT, width: 1280, height: 720 };
    },
    ...options,
  });
  return { ...made, library, asked };
}
// A video take of the project, « PRISE n »: its record, with its number.
const take = (conversationId, id, workflow, number) => {
  const record = clip(conversationId, id, workflow);
  if (number) record.outputs[0].take = number;
  return record;
};
const place = { conversationId: A, turnId: turn, messages: [] };

test('the last image of a video take starts a new clip: read once, kept as a reference of the project, then an ordinary image', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    [CLIP, OTHER] = [uid(3), uid(4)];
  const { runtime, library, asked, saved } = await stillsWorld(t, {
    workflows: list,
    records: { [`${A}/${CLIP}`]: take(A, CLIP, ltx, 25), [`${A}/${OTHER}`]: take(A, OTHER, ltx) },
  });
  const video = (start_image, id = 'call-1') =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)], place);
  // The profile of the draft is a portrait (288 × 512, see above): the clip takes the format of the frame.
  const first = await video({ output: CLIP, frame: 'last' });
  assert.deepEqual(asked, [[join('output', CLIP + '.mp4'), 'last']], 'the file of the take, its last picture');
  const [kept] = await library.list(PROJECT);
  assert.deepEqual(
    [kept.name, kept.label, kept.mime, kept.width, kept.height, kept.ready, kept.enabled],
    ['Dernière image · PRISE 25', '#ref1', 'image/png', 1280, 720, true, true],
  );
  assert.equal((await library.list('inbox')).length, 0, 'a reference of the project of the conversation');
  // Before the routing: the call, the card and the format see an image reference like another.
  assert.deepEqual(first.args.references, [{ input: 'start', resource_id: kept.id }]);
  assert.deepEqual(rolesOf(first), ['start_image']);
  assert.deepEqual(
    [first.plan.references[0].resource_id, first.plan.references[0].original, first.plan.references[0].label],
    [kept.id, true, 'Dernière image · PRISE 25'],
  );
  assert.equal(first.plan.references[0].frame, undefined);
  assert.deepEqual(first.resolution, { width: 512, height: 288 });
  assert.deepEqual(first.notes, ['Dernière image de la prise 25 gardée comme #ref1.']);
  assert.deepEqual(first.stills, [{ id: kept.id, label: '#ref1', name: 'Dernière image · PRISE 25', existing: false }]);
  // The same image asked again: the reference already kept, the video not read again.
  const again = await video({ output: CLIP, frame: 'last' }, 'call-2');
  assert.equal(asked.length, 1);
  assert.deepEqual(again.args.references, [{ input: 'start', resource_id: kept.id }]);
  assert.deepEqual(again.notes, ['Dernière image de la prise 25 : #ref1, déjà dans les références du projet.']);
  assert.equal(again.stills[0].existing, true);
  assert.equal((await library.list(PROJECT)).length, 1);
  // Its first image is another reference; a video without a number is named by what made it.
  const opening = await video({ output: CLIP, frame: 'first' }, 'call-3');
  assert.deepEqual(asked[1], [join('output', CLIP + '.mp4'), 'first']);
  assert.deepEqual(opening.notes, ['Première image de la prise 25 gardée comme #ref2.']);
  const unnumbered = await video({ output: OTHER, frame: 'last' }, 'call-4');
  assert.deepEqual(unnumbered.notes, ['Dernière image de cette vidéo gardée comme #ref3.']);
  assert.deepEqual(
    (await library.list(PROJECT)).map(item => item.name),
    ['Dernière image · PRISE 25', 'Première image · PRISE 25', 'Dernière image · LTX 2.5'],
  );
  // Removed from the references since: read and kept again, under a new number.
  await library.remove(kept.id);
  const back = await video({ output: CLIP, frame: 'last' }, 'call-5');
  assert.equal(asked.length, 4);
  assert.deepEqual(back.notes, ['Dernière image de la prise 25 gardée comme #ref4.']);
  // The take made from it keeps an image reference in its record, which the Studio gives back as any other.
  await runtime.execute({ requestId: back.requestId, permission: 'once', approvalToken: back.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const reference = saved[0].parameters.references[0];
  assert.deepEqual(
    [reference.role, reference.resource_id, reference.frame, reference.output_id],
    ['start_image', back.args.references[0].resource_id, undefined, undefined],
  );
  assert.deepEqual(saved[0].parameters.routing_notes, ['Dernière image de la prise 25 gardée comme #ref4.']);
  // Switched off by the user in the references: said, never put back on behind their back.
  await library.update(back.args.references[0].resource_id, { enabled: false });
  await assert.rejects(video({ output: CLIP, frame: 'last' }, 'call-6'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 25 : cette image est déjà la référence #ref4, désactivée.',
  });
});

test('a first or last image in every role that takes an image, of a take of another conversation and of a video reference', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    krea = of(list, 'krea2'),
    [CLIP, FAR] = [uid(3), uid(4)],
    B = uid(5);
  const { runtime, library, asked } = await stillsWorld(t, {
    workflows: list,
    records: { [`${A}/${CLIP}`]: take(A, CLIP, ltx, 7), [`${B}/${FAR}`]: take(B, FAR, ltx, 8) },
  });
  // A video among the references of the project (#ref1), as the page adds one.
  const file = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
  const added = await library.add(Readable.from([file]), { name: 'plage.mp4', mime: 'video/mp4', length: file.length, project: PROJECT });
  const clipRef = await library.update(added.id, {
    prepared: { width: 768, height: 448, duration: 2, frames: [0.2, 1, 1.8].map(time => ({ url: DOT, time })) },
  });
  const video = (args, id) =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, ...args }, id)], place);
  // The last image of a video reference, as the first frame.
  const fromRef = await video({ start_image: { resource: clipRef.id, frame: 'last' } }, 'call-1');
  assert.deepEqual(asked, [[join('references', clipRef.id), 'last']]);
  const still = (await library.list(PROJECT)).find(item => item.name === 'Dernière image · #ref1');
  assert.ok(still, 'named after the reference it comes from');
  assert.deepEqual(fromRef.args.references, [{ input: 'start', resource_id: still.id }]);
  assert.deepEqual(fromRef.notes, ['Dernière image de #ref1 gardée comme #ref2.']);
  assert.deepEqual(fromRef.resolution, { width: 512, height: 288 });
  // A sample of it (0, 1 or 2) stays the small copy made when it was added: nothing is read.
  const sample = await video({ start_image: { resource: clipRef.id, frame: 1 } }, 'call-2');
  assert.equal(asked.length, 1);
  assert.deepEqual(sample.args.references, [{ input: 'start', resource_id: clipRef.id, frame: 1 }]);
  assert.equal(sample.notes, undefined);
  assert.equal(sample.stills, undefined);
  // The last frame, and a subject reference, from takes: one of them of another conversation of
  // the project. The same image in two roles is one reference.
  const both = await video(
    {
      start_image: { output: CLIP, frame: 'first' },
      end_image: { output: FAR, conversation: B, frame: 'last' },
      reference: [{ output: CLIP, frame: 'first' }],
    },
    'call-3',
  );
  assert.deepEqual(asked.slice(1), [
    [join('output', CLIP + '.mp4'), 'first'],
    [join('output', FAR + '.mp4'), 'last'],
  ]);
  const names = Object.fromEntries((await library.list(PROJECT)).map(item => [item.name, item.id]));
  assert.deepEqual(both.args.references, [
    { input: 'start', resource_id: names['Première image · PRISE 7'] },
    { input: 'end', resource_id: names['Dernière image · PRISE 8'] },
    { input: 'subject-1', resource_id: names['Première image · PRISE 7'] },
  ]);
  assert.deepEqual(both.notes.slice(0, 2), [
    'Première image de la prise 7 gardée comme #ref3.',
    'Dernière image de la prise 8 gardée comme #ref4.',
  ]);
  // The image an image is made from: the last picture of a clip, whose format the image keeps.
  const edited = await runtime.request(
    [call('create_image', { prompt: 'The same shot at night.', workflow: krea.id, source: { output: CLIP, frame: 'last' } }, 'call-4')],
    place,
  );
  const ending = (await library.list(PROJECT)).find(item => item.name === 'Dernière image · PRISE 7');
  assert.deepEqual(edited.args.references, [{ input: 'source', resource_id: ending.id }]);
  assert.ok(edited.resolution.width > edited.resolution.height, 'the landscape of the frame');
  // The clip a continuation starts from is taken whole: a frame named there says nothing, as before.
  const before = asked.length;
  const next = await runtime.request(
    [call('extend_video', { prompt: 'x', intention: 'x', duration: null, source: { output: CLIP, frame: 'last' } }, 'call-5')],
    place,
  );
  assert.equal(asked.length, before);
  assert.deepEqual(rolesOf(next), ['source_video']);
  assert.deepEqual(next.plan.references[0].output_id, CLIP);
  assert.equal(next.stills, undefined);
});

test('a frame named on an image is the image itself, and a picture that cannot be read is said before anything is made', async t => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    krea = of(list, 'krea2'),
    [CLIP, STILL, GONE] = [uid(3), uid(4), uid(5)];
  let failure = 'Ce fichier n’est pas une vidéo lisible.';
  const asked = [];
  const records = {
    [`${A}/${CLIP}`]: take(A, CLIP, ltx, 25),
    [`${A}/${GONE}`]: take(A, GONE, ltx, 26),
    [`${A}/${STILL}`]: { ...take(A, STILL, krea, 12), mediaType: 'image' },
  };
  const { runtime, library } = await stillsWorld(t, {
    workflows: list,
    records,
    missing: [GONE + '.mp4'],
    extractStill: async (path, at) => {
      asked.push([path, at]);
      throw Error(failure);
    },
  });
  const video = (start_image, id) =>
    runtime.request([call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image }, id)], place);
  // An image take, an image reference: themselves, nothing read, no reference made.
  const image = await video({ output: STILL, frame: 'last' }, 'call-1');
  assert.deepEqual(image.args.references, [{ input: 'start', output_id: STILL }]);
  assert.equal(image.notes, undefined);
  const file = pngOf(640, 360, 'plage');
  const added = await library.add(Readable.from([file]), { name: 'plage.png', mime: 'image/png', length: file.length, project: PROJECT });
  await library.update(added.id, { prepared: { width: 640, height: 360, frames: [{ url: DOT, time: null }] } });
  const picture = await video({ resource: added.id, frame: 'first' }, 'call-2');
  assert.deepEqual(picture.args.references, [{ input: 'start', resource_id: added.id }]);
  assert.deepEqual(asked, []);
  // A file of the user's is named in the card as they name it in the chat, not by its file name
  // (17/11: « Rôle de 297e3b9ff713460… »).
  assert.equal(picture.plan.references[0].label, (await library.list(PROJECT)).find(item => item.id === added.id).label);
  assert.match(picture.plan.references[0].label, /^#ref\d+$/);
  // The video cannot be read: said in the user's words, as a call the model can correct (400).
  await assert.rejects(video({ output: CLIP, frame: 'last' }, 'call-3'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 25 : ce fichier n’est pas une vidéo lisible.',
  });
  failure = 'l’environnement de génération n’est pas installé (Paramètres › Génération)';
  await assert.rejects(video({ output: CLIP, frame: 'first' }, 'call-4'), {
    status: 400,
    message:
      'Impossible de lire la première image de la prise 25 : l’environnement de génération n’est pas installé (Paramètres › Génération).',
  });
  assert.equal(asked.length, 2);
  // Its file is gone from the disk: said so, the video not even opened.
  await assert.rejects(video({ output: GONE, frame: 'last' }, 'call-5'), {
    status: 400,
    message: 'Impossible de lire la dernière image de la prise 26 : le fichier de cette vidéo est introuvable.',
  });
  assert.equal(asked.length, 2);
  // Nothing is kept of a picture that was not read, and nothing was proposed.
  assert.deepEqual((await library.list(PROJECT)).map(item => item.name), ['plage.png']);
  // Another word than first or last, a take that is none: refused too.
  await assert.rejects(video({ output: CLIP, frame: 'middle' }, 'call-6'), { status: 400, message: /^frame : "first" ou "last"/ });
  await assert.rejects(video({ output: uid(8), frame: 'last' }, 'call-7'), { status: 404 });
  // Where nothing reads a video (no engine): said, not an error of the application.
  const bare = world({ workflows: list, records });
  await assert.rejects(
    bare.runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', workflow: ltx.id, start_image: { output: CLIP, frame: 'last' } })],
      place,
    ),
    { status: 400, message: /^Impossible de lire la dernière image de la prise 25 : cette lecture n’est pas disponible ici\.$/ },
  );
});

test('a creation asked in the Chat is made with the LoRAs saved for its model, and says so; never one asked in the Studio', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    ltx = of(list, 'ltx25'),
    minimax = of(list, 'minimax_h3'),
    CLIP = uid(3),
    kept = {
      [krea.id]: [{ name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 }, { name: 'detail.safetensors', strength: 1 }],
      [ltx.id]: [{ name: 'grain.safetensors', strength: 0.5 }],
      [minimax.id]: [{ name: 'grain.safetensors', strength: 0.5 }],
    },
    asked = [],
    { runtime, saved } = world({
      workflows: list,
      records: { [`${A}/${CLIP}`]: clip(A, CLIP, ltx) },
      savedStyles: async id => (asked.push(id), kept[id] ?? []),
    });
  let turns = 3;
  const ask = (name, args, options = {}) =>
    runtime.request([call(name, args, 'call-' + turns)], { conversationId: A, turnId: uid(turns++), messages: [], ...options });
  const image = { prompt: 'A lighthouse at night.', workflow: krea.id };
  // In the Chat (`saved`): those of the model, named on the proposal.
  const chat = await ask('create_image', image, { saved: true });
  assert.deepEqual(chat.styles, kept[krea.id]);
  assert.deepEqual(chat.notes, ['LoRA enregistrés pour Krea 2 : 70sSCiFiKrea2Raw · 0,8, detail · 1.']);
  await runtime.execute({ requestId: chat.requestId, permission: 'once', approvalToken: chat.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, kept[krea.id], 'the take says what it was made with');
  // From the Studio (no `saved`): none taken; those the Studio shows come with « Générer » (revise).
  const studio = await ask('create_image', image);
  assert.equal(studio.styles, undefined);
  assert.equal(studio.notes, undefined);
  // Given with the request (by hand): they are the ones, and nothing is said of the saved ones.
  const given = await ask('create_image', image, { saved: true, styles: [{ name: 'other.safetensors', strength: 1 }] });
  assert.deepEqual(given.styles, [{ name: 'other.safetensors', strength: 1 }]);
  assert.equal(given.notes, undefined);
  // Changed on the proposal, they are the user's: no longer said « enregistrés » ; another change keeps the line.
  const again = await ask('create_image', image, { saved: true });
  const reworded = await revise(runtime, again, { prompt: 'A lighthouse at dawn.' });
  assert.deepEqual(reworded.notes, chat.notes);
  const chosen = await revise(runtime, reworded, { styles: [{ name: 'detail.safetensors', strength: 0.4 }] });
  assert.deepEqual(chosen.styles, [{ name: 'detail.safetensors', strength: 0.4 }]);
  assert.equal(chosen.notes, undefined);
  // One LoRA: said in the singular. The continuation of a clip takes none, nor a family whose engine takes none.
  const video = await ask('create_video', { prompt: 'A red boat.', intention: 'x', workflow: ltx.id }, { saved: true });
  assert.deepEqual(video.notes, ['LoRA enregistré pour LTX 2.5 : grain · 0,5.']);
  const next = await ask(
    'extend_video',
    { source: { output: CLIP }, prompt: 'It sails on.', intention: 'x', workflow: ltx.id },
    { saved: true },
  );
  assert.equal(next.styles, undefined);
  const plain = await ask('create_video', { prompt: 'A red boat.', intention: 'x', workflow: minimax.id }, { saved: true });
  assert.equal(plain.styles, undefined);
  assert.equal(asked.includes(minimax.id), false);
  // The saved ones cannot be read: the creation is made without, not refused.
  const { runtime: broken } = world({
    workflows: list,
    savedStyles: async () => {
      throw Error('lecture impossible');
    },
  });
  const made = await broken.request([call('create_image', image)], { conversationId: A, turnId: turn, messages: [], saved: true });
  assert.equal(made.styles, undefined);
});

test('every image of a series asked in the Chat has the LoRAs saved for its model', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    styles = [{ name: 'detail.safetensors', strength: 1 }],
    { runtime } = world({ workflows: list, savedStyles: async () => styles });
  const first = await runtime.request(
    [call('create_image', { prompt: 'A fox.', series: ['A whale.', 'An owl.'], workflow: krea.id })],
    { conversationId: A, turnId: turn, messages: [], saved: true },
  );
  assert.deepEqual(first.styles, styles);
  const second = await runtime.next({ series: first.series.id });
  assert.deepEqual(second.styles, styles);
  assert.deepEqual(second.notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
});

test('a LoRA saved for a model whose file is gone is left out, and the proposal says which', async () => {
  const list = shipped(),
    krea = of(list, 'krea2'),
    detail = { name: 'detail.safetensors', strength: 1 },
    gone = { name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 },
    other = { name: 'old/Grain_v2.SAFETENSORS', strength: 0.5 };
  let found = { kept: [detail], missing: [gone] };
  const { runtime, saved } = world({ workflows: list, savedStyles: async () => found });
  let turns = 3;
  const ask = (options = {}) =>
    runtime.request([call('create_image', { prompt: 'A lighthouse at night.', workflow: krea.id }, 'call-' + turns)], {
      conversationId: A,
      turnId: uid(turns++),
      messages: [],
      saved: true,
      ...options,
    });
  // One kept, one gone: made with the first, the second named beside it, by its file alone.
  const mixed = await ask();
  assert.deepEqual(mixed.styles, [detail]);
  assert.deepEqual(mixed.notes, [
    'LoRA enregistré pour Krea 2 : detail · 1.',
    'LoRA enregistré introuvable dans le dossier loras : 70sSCiFiKrea2Raw.',
  ]);
  await runtime.execute({ requestId: mixed.requestId, permission: 'once', approvalToken: mixed.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.styles, [detail], 'the take is made with those found only');
  // Every one gone: made without any, said in the plural.
  found = { kept: [], missing: [gone, other] };
  const none = await ask();
  assert.equal(none.styles, undefined);
  assert.deepEqual(none.notes, ['LoRA enregistrés introuvables dans le dossier loras : 70sSCiFiKrea2Raw, Grain_v2.']);
  // The note stays through a change of the proposal; styles chosen on it are the user's: no note.
  assert.deepEqual((await revise(runtime, none, { prompt: 'A lighthouse at dawn.' })).notes, none.notes);
  assert.equal((await revise(runtime, await ask(), { styles: [detail] })).notes, undefined);
  // Nothing gone, in either form the application may answer: nothing more is said.
  found = { kept: [detail], missing: [] };
  assert.deepEqual((await ask()).notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
  found = [detail];
  assert.deepEqual((await ask()).notes, ['LoRA enregistré pour Krea 2 : detail · 1.']);
  // From the Studio (no `saved`), the saved ones are not read: nothing is said of them.
  found = { kept: [], missing: [gone] };
  assert.equal((await ask({ saved: false })).notes, undefined);
  // Each image of a series says it, as it says those it is made with.
  const first = await runtime.request(
    [call('create_image', { prompt: 'A fox.', series: ['A whale.'], workflow: krea.id })],
    { conversationId: A, turnId: uid(turns++), messages: [], saved: true },
  );
  const second = await runtime.next({ series: first.series.id });
  const said = ['LoRA enregistré introuvable dans le dossier loras : 70sSCiFiKrea2Raw.'];
  assert.deepEqual([first.notes, second.notes], [said, said]);
});

test('a draft promoted to its final keeps the LoRAs of the user it was made with', async () => {
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    styles = [{ name: 'grain.safetensors', strength: 0.5 }],
    { runtime, saved } = world({ workflows: list, savedStyles: async () => [{ name: 'other.safetensors', strength: 1 }] });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'A red boat crosses the bay at dawn.', intention: 'Brouillon', duration: 5, workflow: ltx.id })],
    { ...place, styles },
  );
  await runtime.execute({ requestId: first.requestId, permission: 'once', approvalToken: first.approvalToken });
  await runtime.finished;
  const draft = saved[0];
  assert.deepEqual(draft.parameters.styles, styles);
  // Its final, asked in the Chat: the draft's own, not those saved for the model, and no line about them.
  const final = await runtime.request(
    [call('create_video', { reuse_output: draft.id, stage: 'final', intention: 'Version finale', prompt: draft.prompt, duration: null }, 'call-2')],
    { ...place, turnId: uid(3), saved: true },
  );
  assert.equal(final.plan.stage, 'final');
  assert.deepEqual(final.styles, styles);
  assert.equal(final.notes, undefined);
});

test('a length asked in seconds is counted at the rate of the profile the clip is made with, not at the value it replaces', async () => {
  const list = shipped(),
    stored = of(list, 'ltx25');
  // Its two profiles set to 30 images a second; the value of the workflow, which they replace, left at 24.
  const ltx = structuredClone(stored);
  for (const profile of Object.values(ltx.profiles)) profile.parameters.fps = 30;
  assert.equal(ltx.parameters.fps?.value ?? ltx.parameters.fps?.default ?? 24, 24);
  const { runtime } = world({ workflows: list.map(workflow => (workflow.id === ltx.id ? ltx : workflow)) });
  const asked = await runtime.request(
    [call('create_video', { prompt: 'A red boat.', intention: 'x', duration: 5, workflow: ltx.id })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  const { frames, fps } = asked.plan.parameters;
  assert.equal(fps, 30);
  // Five seconds asked: five seconds made (counted at 24, they were 121 images: 4 s at 30).
  assert.ok(Math.abs(frames / fps - 5) < 0.2, `${frames} images à ${fps}/s`);
});

test('Krea 2: the denoise the assistant passes with an image to modify stays from 0.6 to 0.7, may be changed there, and is in the record of the take', async () => {
  // (0.6.476) Without Qwen-Image-Edit on this computer: with it, an image given goes to it (route, chatFirst).
  const list = shipped().filter(workflow => workflow.pipeline !== 'qwen_image_edit'),
    krea = of(list, 'krea2'),
    SOURCE = uid(7),
    OTHER = uid(8),
    { runtime, saved } = world({
      workflows: list,
      resources: { [SOURCE]: picture('escalier.png'), [OTHER]: picture('plage.png') },
    });
  let calls = 0;
  const ask = args =>
    runtime.request([call('create_image', { prompt: 'The same staircase at night.', ...args }, 'call-' + ++calls)], {
      conversationId: A,
      turnId: randomUUID(),
      messages: [],
    });
  const made = async request => {
    await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
    await runtime.finished;
    assert.equal(runtime.status().state, 'done', runtime.status().error);
    return saved.at(-1).parameters;
  };
  const source = () => ({ resource: SOURCE }),
    setting = request => request.plan.editable.parameters.find(item => item.key === 'denoise');

  // 0.7 asked with an image to modify: proposed, listed with its bounds, made and recorded at 0.7.
  let proposal = await ask({ source: source(), denoise: 0.7 });
  assert.equal(proposal.workflowName, krea.name);
  assert.equal(proposal.plan.parameters.denoise, 0.7);
  assert.deepEqual(
    [setting(proposal).value, setting(proposal).min, setting(proposal).max, setting(proposal).locked],
    [0.7, 0.6, 0.7, undefined],
  );
  assert.deepEqual([proposal.notes, proposal.plan.edited], [undefined, undefined], 'the choice of the assistant, no change of the user');
  let record = await made(proposal);
  assert.equal(record.denoise, 0.7);
  assert.equal(record.replay_args.denoise, 0.7, 'made again, it keeps it');
  assert.equal(record.user_overrides, undefined);
  // Nothing asked: 0.6.
  proposal = await ask({ source: source() });
  assert.deepEqual([proposal.plan.parameters.denoise, setting(proposal).value], [0.6, 0.6]);
  assert.equal((await made(proposal)).denoise, 0.6);
  // Beyond the bounds: brought to the nearest one (as the router does for every number left to the
  // model), said on the proposal, never refused.
  proposal = await ask({ source: source(), denoise: 0.9 });
  assert.equal(proposal.plan.parameters.denoise, 0.7);
  assert.deepEqual(proposal.notes, ['Débruitage : 0,9 → 0,7, la limite de Krea 2.']);
  assert.equal(proposal.plan.edited, undefined);
  assert.equal((await made(proposal)).denoise, 0.7);
  proposal = await ask({ source: source(), denoise: 0.3 });
  assert.equal(proposal.plan.parameters.denoise, 0.6);
  assert.deepEqual(proposal.notes, ['Débruitage : 0,3 → 0,6, la limite de Krea 2.']);
  assert.equal((await made(proposal)).denoise, 0.6);

  // Passed without an image to modify: no error, nothing said, the picture made from nothing (1),
  // and no setting to change there.
  for (const denoise of [0.7, 0.9]) {
    proposal = await ask({ denoise });
    assert.equal(proposal.plan.parameters.denoise, 1);
    assert.equal(setting(proposal), undefined);
    assert.ok(proposal.plan.editable.parameters.some(item => item.key === 'width'));
    assert.deepEqual([proposal.notes, proposal.plan.edited, proposal.args.denoise], [undefined, undefined, undefined]);
    record = await made(proposal);
    assert.deepEqual([record.denoise, record.user_overrides, record.replay_args.denoise], [1, undefined, undefined]);
  }
  // An edit of it there is left aside: not made with it, not said « modifié par vous ».
  proposal = await ask({});
  let revised = await revise(runtime, proposal, { denoise: 0.65 });
  assert.equal(revised.plan.parameters.denoise, 1);
  assert.equal(revised.plan.edited, undefined);
  assert.equal((await made(revised)).user_overrides, undefined);
  // An image put in its case on the card: the setting is there, at the value of the workflow.
  proposal = await ask({});
  revised = await revise(runtime, proposal, { add: { role: 'source', source: { resource: OTHER } } });
  assert.deepEqual(rolesOf(revised), ['img2img']);
  assert.deepEqual([revised.plan.parameters.denoise, setting(revised).value, setting(revised).max], [0.6, 0.6, 0.7]);
  revised = await revise(runtime, revised, { denoise: 0.68 });
  assert.equal((await made(revised)).denoise, 0.68);

  // On a proposal with its image, the user sets it within the bounds: said as their change, made
  // with it, and kept in the record of the take.
  proposal = await ask({ source: source() });
  revised = await revise(runtime, proposal, { denoise: 0.65 });
  assert.equal(revised.plan.parameters.denoise, 0.65);
  assert.deepEqual(revised.plan.edited, ['denoise']);
  assert.equal(setting(revised).value, 0.65);
  // Outside them: refused in plain words, and the proposal is still the one to confirm.
  for (const denoise of [0.75, 0.5, 1])
    await assert.rejects(revise(runtime, revised, { denoise }), { status: 400, message: 'Débruitage : entre 0,6 et 0,7.' });
  await assert.rejects(revise(runtime, revised, { denoise: '0.65' }), { status: 400, message: 'Débruitage : un nombre.' });
  // Both ends are values like the others.
  revised = await revise(runtime, revised, { denoise: 0.7 });
  assert.equal(revised.plan.parameters.denoise, 0.7);
  record = await made(revised);
  assert.equal(record.denoise, 0.7);
  assert.deepEqual(record.user_overrides, { denoise: 0.7 });
  // Set back to what the assistant gave, it is no change any more.
  proposal = await ask({ source: source(), denoise: 0.7 });
  revised = await revise(runtime, proposal, { denoise: 0.65 });
  revised = await revise(runtime, revised, { denoise: 0.7 });
  assert.deepEqual([revised.plan.parameters.denoise, revised.plan.edited], [0.7, undefined]);

  // A workflow of the user's that fixes it: the argument is said ignored, and the user may still
  // type any denoise the family takes (the policies restrict the model, not the owner).
  const { ready, digest, ...stored } = krea,
    fixed = { ...validateNativeWorkflow({ ...stored, parameters: { ...stored.parameters, denoise: { policy: 'fixed', value: 0.5 } } }), ready: true },
    own = world({ workflows: [fixed], resources: { [SOURCE]: picture('escalier.png') } });
  const held = await own.runtime.request([call('create_image', { prompt: 'x', source: source(), denoise: 0.7 })], {
    conversationId: A,
    turnId: randomUUID(),
    messages: [],
  });
  assert.equal(held.plan.parameters.denoise, 0.5);
  assert.deepEqual(held.notes, ['Débruitage : valeur ignorée, fixée par le workflow Krea 2.']);
  assert.deepEqual([setting(held).min, setting(held).max], [0, 1]);
  assert.equal((await revise(own.runtime, held, { denoise: 0.4 })).plan.parameters.denoise, 0.4);
});

test('a continuation the user did not ask for, of a take that cannot be made again as a new video, is sent back to the model (0.6.113)', async () => {
  // « Modifie cette prise, je veux un dézoom lent » (19/11): the local model called extend_video with
  // the take as its source, and the Studio showed « Suite du clip », its size not to be changed.
  // (0.6.114) Here the take continued another clip itself: no new video can be made of what it was
  // made with, and the model is told, as every such continuation was in 0.6.113.
  const list = shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    [CLIP, FIRST] = [uid(3), uid(5)];
  const { runtime } = world({
    workflows: list,
    records: {
      [`${A}/${FIRST}`]: clip(A, FIRST, ltx),
      [`${A}/${CLIP}`]: clip(A, CLIP, ltx, { references: [{ input: 'source', output_id: FIRST, role: 'source_video' }] }),
    },
  });
  const suite = () => [call('extend_video', { prompt: 'x', intention: 'Suite', duration: 5, source: { output: CLIP } })],
    said = (...messages) => ({ conversationId: A, turnId: turn, messages }),
    changed = { role: 'user', content: 'modifie cette prise, je veux un dézoom lent' };
  const back = await runtime.request(suite(), said(changed));
  assert.deepEqual([back.kind, back.message, back.call.function.name], ['retry', SUITE_NOTE, 'extend_video']);
  assert.equal(back.requestId, undefined, 'nothing is proposed, nothing waits for the user');
  // The model was told and asks again in the same turn: made (the user may mean it).
  const again = await runtime.request(
    suite(),
    said(
      changed,
      { role: 'assistant', content: '', tool_calls: suite() },
      { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ status: 'nothing_generated', message: SUITE_NOTE }) },
    ),
  );
  assert.ok(again.requestId);
  assert.deepEqual(again.inputRoles, ['source_video']);
  // The user's words ask for it: proposed at once.
  assert.ok((await runtime.request(suite(), said({ role: 'user', content: 'prolonge ce clip de 5 secondes' }))).requestId);
  // Their own hand does (« Prolonger » under a take, the Studio): never sent back, whatever was written.
  assert.ok((await runtime.request(suite(), { ...said(changed), byHand: true })).requestId);
  // Another verb on the same words is the model's answer to them.
  assert.equal((await runtime.request([call('create_video', { prompt: 'x', intention: 'Vidéo', duration: null })], said(changed))).kind, undefined);
});

test('a continuation nobody asked for is proposed as the new video it stands for, with what its take was made with (0.6.114)', async () => {
  // 19/11, on the user's card: sent back with what to call instead (0.6.113), the local model made
  // the right call three times out of eight, and three times wrote « j'ai créé… » with nothing made.
  // The call below is the one it made most (its prompt shortened): no image named, five seconds.
  const list = shipped(),
    omni = of(list, 'minimax_h3'),
    ltx = of(list, 'ltx25'),
    krea = of(list, 'krea2'),
    [CLIP, IMAGE, START, SENT, LOST, NEXT, OLD] = [uid(3), uid(4), uid(5), uid(6), uid(7), uid(8), uid(9)];
  const numbered = (record, take) => ({ ...record, outputs: [{ ...record.outputs[0], take }] }),
    galaxy = { input: 'subject-1', output_id: IMAGE, output_index: 0, original: true, label: 'Prise 50', role: 'reference_image' };
  const records = {
    [`${A}/${IMAGE}`]: { ...numbered(clip(A, IMAGE, krea, {}, [1024, 1024]), 50), mediaType: 'image' },
    // Made upright by the user: the new video keeps that format, which no image of it says.
    [`${A}/${CLIP}`]: numbered(clip(A, CLIP, omni, { frames: 141, stage: 'final', references: [galaxy] }, [448, 768]), 59),
    [`${A}/${START}`]: numbered(clip(A, START, ltx, { frames: 97, references: [{ input: 'start', output_id: IMAGE, role: 'start_image' }] }), 60),
    [`${A}/${SENT}`]: numbered(clip(A, SENT, omni, { frames: 124, references: [{ input: 'subject-1', image: 0, role: 'reference_image' }] }), 61),
    [`${A}/${LOST}`]: numbered(clip(A, LOST, omni, { frames: 124, references: [{ ...galaxy, output_id: uid(0) }] }), 62),
    [`${A}/${OLD}`]: numbered(clip(A, OLD, { id: 'removed', name: 'Ancien workflow', pipeline: 'ltx25' }, { frames: 121 }), 64),
    [`${A}/${NEXT}`]: numbered(clip(A, NEXT, omni, { frames: 124, references: [{ input: 'source', output_id: CLIP, role: 'source_video' }] }), 63),
  };
  const { runtime, saved } = world({ workflows: list, records });
  const prompt = 'A breathtaking view of a spiral galaxy. The camera slowly pulls back, revealing deep space.',
    intention = 'Troisième plan modifié : dézoom lent de la galaxie.',
    suite = (output = CLIP, more = {}) => [call('extend_video', { prompt, source: { output, index: 0 }, duration: 5, intention, ...more })],
    said = (...messages) => ({ conversationId: A, turnId: randomUUID(), messages }),
    changed = { role: 'user', content: 'modifie cette prise, je veux un dézoom lent' };

  const fresh = await runtime.request(suite(), said(changed));
  assert.ok(fresh.requestId, 'proposed at once: nothing the model has to do again');
  assert.deepEqual([fresh.kind, fresh.tool, fresh.workflowName], [undefined, 'create_video', omni.name]);
  // The call the conversation keeps is the one of the new video: what the take was made with.
  assert.equal(fresh.call.function.name, 'create_video');
  assert.equal(fresh.call.id, 'call-1');
  assert.deepEqual(JSON.parse(fresh.call.function.arguments), {
    prompt,
    duration: 5.88,
    intention,
    workflow: omni.id,
    stage: 'final',
    reference: [{ output: IMAGE, index: 0 }],
  });
  assert.deepEqual(fresh.args.references, [{ input: 'subject-1', output_id: IMAGE, output_index: 0 }]);
  assert.deepEqual(rolesOf(fresh), ['reference_image']);
  assert.ok(!fresh.inputRoles.includes('source_video'), 'no clip to go on from');
  assert.deepEqual([fresh.plan.prompt, fresh.plan.intention], [prompt, intention]);
  // Its length (141 images, not the five seconds of the call nor the 124 of the workflow), its
  // profile, and its upright format.
  assert.deepEqual([fresh.plan.parameters.frames, fresh.plan.stage], [141, 'final']);
  assert.ok(fresh.resolution.height > fresh.resolution.width, JSON.stringify(fresh.resolution));
  assert.deepEqual(fresh.notes, [
    'Votre message ne demande pas de suite : au lieu de prolonger la prise 59, une nouvelle vidéo est proposée, avec ses images, sa longueur et son format. Pour une suite, utilisez « Prolonger ».',
  ]);
  // Made, it is a take of its own.
  await runtime.execute({ requestId: fresh.requestId, permission: 'once', approvalToken: fresh.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  assert.deepEqual(saved.at(-1).parameters.references.map(ref => ref.role), ['reference_image']);
  assert.deepEqual([saved.at(-1).parameters.continuation, saved.at(-1).callId], [undefined, 'call-1']);

  // The images the call names itself are the model's choice: kept, and not said the take's.
  const named = await runtime.request(suite(CLIP, { reference: [{ output: IMAGE }] }), said(changed));
  assert.deepEqual(named.args.references, [{ input: 'subject-1', output_id: IMAGE }]);
  assert.match(named.notes[0], /une nouvelle vidéo est proposée, avec sa longueur et son format\. Pour/);
  // A length the user's message speaks of is theirs: the one of the call, not the take's.
  const timed = await runtime.request(
    suite(CLIP, { duration: 8 }),
    said({ role: 'user', content: 'refais cette prise en 8 secondes avec un dézoom' }),
  );
  assert.equal(timed.plan.parameters.frames, 192);
  assert.match(timed.notes[0], /avec ses images et son format\. Pour/);
  // The number of a take is no length (inventedLength): « la prise 59 » keeps its own.
  const byNumber = await runtime.request(suite(), said({ role: 'user', content: 'refais la prise 59 avec un dézoom' }));
  assert.equal(byNumber.plan.parameters.frames, 141);
  assert.match(byNumber.notes[0], /avec ses images, sa longueur et son format\. Pour/);
  // An image the take started from goes where it was: the first image of the new video.
  const started = await runtime.request(suite(START), said(changed));
  assert.deepEqual([started.workflowName, started.plan.parameters.frames], [ltx.name, 97]);
  assert.deepEqual(started.args.references, [{ input: 'start', output_id: IMAGE }]);
  assert.deepEqual(JSON.parse(started.call.function.arguments).start_image, { output: IMAGE });
  assert.match(started.notes[0], /au lieu de prolonger la prise 60, /);

  // What cannot be made again so is sent back to the model, its call as it was: a take made from a
  // file sent with a message, one whose image is gone, one that continued a clip, one whose workflow
  // was removed, a clip unknown.
  for (const output of [SENT, LOST, NEXT, OLD, uid(0)]) {
    const back = await runtime.request(suite(output), said(changed));
    assert.deepEqual([back.kind, back.message, back.call.function.name], ['retry', SUITE_NOTE, 'extend_video'], output);
    assert.deepEqual(JSON.parse(back.call.function.arguments).source, { output, index: 0 });
  }
  // A continuation the user asks for, or asks by hand, is the continuation.
  const wanted = await runtime.request(suite(), said({ role: 'user', content: 'prolonge la prise 59' }));
  assert.deepEqual([wanted.tool, rolesOf(wanted)], ['extend_video', ['source_video']]);
  assert.equal(wanted.notes, undefined);
  assert.equal((await runtime.request(suite(), { ...said(changed), byHand: true })).tool, 'extend_video');
  // A fault that is no refusal is not hidden behind « the model is told ».
  const prepare = runtime.catalog.prepare;
  runtime.catalog.prepare = async () => {
    throw new Error('disque illisible');
  };
  await assert.rejects(runtime.request(suite(), said(changed)), /disque illisible/);
  runtime.catalog.prepare = prepare;
});

test('(0.6.211) the camera chosen in the Studio: its sentence after the prompt of the job, the prompt kept as written, the choice and the sentence beside it', async () => {
  // (LOTS.md, lot 14) A movement of a closed list and its speed, by the user's own hand: no setting of a workflow.
  const { describe } = await import('../lib/media-info.mjs');
  const list = shipped(),
    ltx = of(list, 'ltx25'),
    wan = of(list, 'wan22'),
    minimax = of(list, 'minimax_h3'),
    jobs = [],
    client = {
      status: async () => ({ idle: true }),
      stage: async () => ({ path: join(tmpdir(), 'staged') }),
      upload: async () => ({ path: join(tmpdir(), 'uploaded.png') }),
      preflight: async job => void jobs.push(['preflight', job.parameters.prompt]),
      run: async job => {
        jobs.push(['run', job.parameters.prompt]);
        return { outputs: [{ filename: 'made.mp4', subfolder: '', type: 'output' }], metadata: { parameters: job.parameters } };
      },
      free: async () => ({}),
    },
    { runtime, saved } = world({
      workflows: list,
      client,
      resources: { [uid(8)]: picture('départ', 1344, 768) },
      records: { [`${A}/${uid(5)}`]: clip(A, uid(5), ltx, { frames: 121 }) },
    });
  const place = { conversationId: A, turnId: turn, messages: [], byHand: true },
    asked = { prompt: 'Le pêcheur lève les yeux', intention: 'Création demandée dans le Studio.', duration: 5, workflow: ltx.id, camera: 'dolly_in', camera_speed: 'slow' },
    made = async request => {
      await runtime.execute({ requestId: request.requestId, permission: 'once', approvalToken: request.approvalToken });
      await runtime.finished;
      assert.equal(runtime.status().state, 'done', runtime.status().error);
      return saved.at(-1);
    };
  // The proposal: the prompt as it was written, the camera and its sentence beside it; nothing to say of it,
  // and it is no argument of the workflow.
  const first = await runtime.request([call('create_video', asked)], place);
  assert.equal(first.plan.prompt, 'Le pêcheur lève les yeux');
  assert.equal(first.plan.parameters.prompt, 'Le pêcheur lève les yeux');
  assert.deepEqual(first.camera, { move: 'dolly_in', speed: 'slow', sentence: 'The camera slowly dollies in.' });
  assert.deepEqual([first.notes, first.args.camera, first.args.camera_speed], [undefined, undefined, undefined]);
  // Revised (its prompt): the camera stays with it.
  const reworded = await revise(runtime, first, { prompt: 'Le pêcheur lève lentement les yeux.' });
  assert.deepEqual(reworded.camera, first.camera);
  // The engine is given the prompt with the sentence after it, checked and run alike.
  const record = await made(reworded),
    given = 'Le pêcheur lève lentement les yeux. The camera slowly dollies in.';
  assert.deepEqual(jobs, [['preflight', given], ['run', given]]);
  // The take keeps the prompt as it was written, the choice and the sentence beside it: made again from its
  // record, it never has the sentence twice.
  assert.equal(record.prompt, 'Le pêcheur lève lentement les yeux.');
  assert.deepEqual([record.parameters.camera, record.parameters.camera_prompt], [{ move: 'dolly_in', speed: 'slow' }, 'The camera slowly dollies in.']);
  assert.deepEqual([record.parameters.replay_args.prompt, record.parameters.replay_args.camera, record.parameters.prompt], ['Le pêcheur lève lentement les yeux.', undefined, undefined]);
  // Its file keeps both (the sheet written in it).
  const sheet = describe(record);
  assert.deepEqual([sheet.prompt, sheet.parameters.camera, sheet.parameters.camera_prompt], ['Le pêcheur lève lentement les yeux.', { move: 'dolly_in', speed: 'slow' }, 'The camera slowly dollies in.']);
  // « Relancer »: proposed again with the same camera.
  const again = await runtime.again({ requestId: reworded.requestId });
  assert.deepEqual([again.camera, again.plan.prompt], [first.camera, 'Le pêcheur lève lentement les yeux.']);
  // Its draft promoted to its final, by a call that names no camera: the same shot, the draft's camera.
  const final = await runtime.request(
    [call('create_video', { reuse_output: record.id, stage: 'final', intention: 'Version finale', prompt: record.prompt, duration: null }, 'call-2')],
    { ...place, byHand: false, turnId: uid(3) },
  );
  assert.deepEqual([final.plan.stage, final.camera, final.plan.prompt], ['final', first.camera, 'Le pêcheur lève lentement les yeux.']);
  jobs.length = 0;
  const finished = await made(final);
  assert.deepEqual([jobs.at(-1), finished.prompt, finished.parameters.camera], [['run', given], 'Le pêcheur lève lentement les yeux.', { move: 'dolly_in', speed: 'slow' }]);

  // No speed named: the normal one. A movement without speed says its sentence whatever speed is named.
  const next = (args, more = {}, id = 'call-' + (jobs.length + saved.length + Math.floor(Math.random() * 1e6))) =>
    runtime.request([call('create_video', args, id)], { ...place, turnId: randomUUID(), ...more });
  const { camera_speed: _slow, ...noSpeed } = asked;
  assert.deepEqual((await next({ ...noSpeed, camera: 'pan_left' })).camera, { move: 'pan_left', speed: 'normal', sentence: 'The camera pans to the left.' });
  assert.deepEqual((await next({ ...asked, camera: 'pan_left', camera_speed: null })).camera, { move: 'pan_left', speed: 'normal', sentence: 'The camera pans to the left.' });
  assert.deepEqual((await next({ ...asked, camera: 'static', camera_speed: 'fast' })).camera, {
    move: 'static',
    speed: 'normal',
    sentence: 'The camera stays perfectly still, a locked-off static shot.',
  });
  // None chosen: nothing of it, in the proposal, in the job nor in the take.
  const { camera: _move, ...bare } = noSpeed;
  for (const none of [bare, { ...bare, camera: null }, { ...bare, camera_speed: 'slow' }]) assert.equal((await next(none)).camera, undefined);
  jobs.length = 0;
  const plain = await made(await next(bare));
  assert.deepEqual([jobs.at(-1), plain.prompt, plain.parameters.camera, plain.parameters.camera_prompt], [['run', 'Le pêcheur lève les yeux'], 'Le pêcheur lève les yeux', undefined, undefined]);
  // A movement or a speed that is none of the list: refused in words, nothing made.
  await assert.rejects(next({ ...asked, camera: 'spin' }), { message: 'Caméra : mouvement inconnu.' });
  await assert.rejects(next({ ...asked, camera: 3 }), { message: 'Caméra : mouvement inconnu.' });
  await assert.rejects(next({ ...asked, camera_speed: 'warp' }), { message: 'Caméra : vitesse inconnue.' });
  // (0.6.212) A movement the list greys (an orbit, a crane: the words alone do not hold them, real videos of 22/11):
  // refused with the reason the list gives, whatever its speed; nothing is given to the engine.
  jobs.length = 0;
  await assert.rejects(next({ ...asked, camera: 'orbit_left' }), {
    message: 'Caméra : « Orbite gauche » n’est pas proposé. Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.',
  });
  await assert.rejects(next({ ...noSpeed, camera: 'crane_down' }), {
    message: 'Caméra : « Grue descendante » n’est pas proposé. Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.',
  });
  for (const move of ['crane_up', 'orbit_right']) await assert.rejects(next({ ...asked, camera: move }), /n’est pas proposé\. Pas fiable par les mots seuls : /, move);
  assert.deepEqual(jobs, []);
  // A draft made with one of them before, promoted: the same shot still, its camera and its sentence kept.
  record.parameters.camera = { move: 'orbit_left', speed: 'slow' };
  const old = await runtime.request(
    [call('create_video', { reuse_output: record.id, stage: 'final', intention: 'Version finale', prompt: record.prompt, duration: null }, 'call-old')],
    { ...place, byHand: false, turnId: randomUUID() },
  );
  assert.deepEqual(old.camera, { move: 'orbit_left', speed: 'slow', sentence: 'The camera slowly orbits around the subject to the left.' });
  record.parameters.camera = { move: 'dolly_in', speed: 'slow' };
  // Wan 2.2 takes it too, from its start image.
  const animated = await next({ ...asked, workflow: wan.id, start_image: { resource: uid(8) }, camera: 'tilt_up' });
  assert.deepEqual([animated.workflowName, animated.camera], ['Wan 2.2', { move: 'tilt_up', speed: 'slow', sentence: 'The camera slowly tilts up.' }]);
  // (0.6.221) MiniMax H3 too: it is a sentence of the prompt, nothing of the model. Proposed with it, nothing
  // said of it; the engine is given the prompt with the sentence, the take keeps the prompt as written.
  const other = await next({ ...asked, workflow: minimax.id });
  assert.deepEqual([other.workflowName, other.camera], ['MiniMax H3 Omni', { move: 'dolly_in', speed: 'slow', sentence: 'The camera slowly dollies in.' }]);
  assert.equal((other.notes ?? []).some(note => /Caméra/.test(note)), false, JSON.stringify(other.notes));
  jobs.length = 0;
  const filmed = await made(other);
  assert.deepEqual(
    [jobs.at(-1), filmed.prompt, filmed.parameters.camera, filmed.parameters.camera_prompt],
    [['run', 'Le pêcheur lève les yeux. The camera slowly dollies in.'], 'Le pêcheur lève les yeux', { move: 'dolly_in', speed: 'slow' }, 'The camera slowly dollies in.'],
  );
  // Nor a continuation, for now: its clip is all it starts from.
  const suite = await runtime.request(
    [call('extend_video', { prompt: 'Il se lève.', intention: 'Suite demandée dans le Studio.', source: { output: uid(5) }, duration: 5, camera: 'dolly_in' }, 'call-suite')],
    { ...place, turnId: randomUUID() },
  );
  assert.equal(suite.camera, undefined);
  assert.ok(suite.notes.includes('Caméra : valeur ignorée, LTX 2.5 ne prend pas ce réglage.'), JSON.stringify(suite.notes));
  // A prompt so long that the sentence would take it past what the engine reads (8000 characters): refused in
  // words while it is proposed, and when it is made longer on the proposal; without the camera it goes.
  const long = 'a'.repeat(7980),
    sentence = 'The camera slowly dollies in.';
  await assert.rejects(next({ ...asked, prompt: long }), {
    message: `Le prompt est trop long pour la phrase de la caméra : raccourcissez-le de ${long.length + 2 + sentence.length - 8000} caractères, ou retirez la caméra.`,
  });
  await assert.rejects(next({ ...asked, prompt: 'a'.repeat(8000 - sentence.length - 1) }), /raccourcissez-le de 1 caractère, ou retirez la caméra\.$/);
  const fits = await next({ ...asked, prompt: 'a'.repeat(8000 - sentence.length - 2) });
  assert.equal(fits.camera.sentence, sentence);
  await assert.rejects(revise(runtime, fits, { prompt: long }), /Le prompt est trop long pour la phrase de la caméra/);
  assert.equal((await next({ ...bare, prompt: long })).plan.prompt, long);
  // Passed by a chat model, which is not offered it yet: refused as any argument its tool does not have.
  await assert.rejects(next(asked, { byHand: false }), /create_video n’accepte pas l’argument camera/);

  // What the Studio is told of each model: the camera for a new video of LTX 2.5, MiniMax H3 and Wan 2.2, a
  // sentence of their prompt (`true`); and of Wan 2.2 Caméra (0.6.223), which reads it itself: its own movements
  // and a speed. Nowhere else: (0.6.242) the camera of a clip filmed again is placed with its own bounds (`refilm`).
  const tools = await new ToolCatalog({ list: async () => list }).studio();
  assert.deepEqual(
    Object.fromEntries(Object.entries(tools).map(([verb, items]) => [verb, (Array.isArray(items) ? items : []).filter(item => item.camera).map(item => item.name).sort()])),
    {
      create_image: [],
      create_video: ['LTX 2.5', 'MiniMax H3 Omni', 'Wan 2.2', 'Wan 2.2 Caméra', 'pi H3'],
      extend_video: [],
      replace_character: [],
      create_audio: [],
      refilm_video: [],
      // (0.6.256) Agrandir and Interpoler, their pages in the Studio: no camera either.
      upscale: [],
      interpolate: [],
    },
  );
  assert.deepEqual(
    tools.create_video.map(item => [item.name, item.camera === true ? 'par les mots' : `${item.camera.moves.length} mouvements, vitesse ${item.camera.speed}`]).sort(),
    [
      ['LTX 2.5', 'par les mots'],
      ['MiniMax H3 Omni', 'par les mots'],
      ['Wan 2.2 Caméra', '13 mouvements, vitesse true'],
      ['Wan 2.2', 'par les mots'],
      // (0.6.423) MiniMax's own model with its step adapter: a sentence of the prompt, as MiniMax H3.
      ['pi H3', 'par les mots'],
    ],
  );
  // (A workflow whose prompt is fixed has none to add a sentence to: no camera.)
  const { ready: _ready, digest: _digest, ...stored } = ltx,
    fixed = { ...validateNativeWorkflow({ ...stored, id: 'ltx-fixe', name: 'LTX fixe', parameters: { ...stored.parameters, prompt: { policy: 'fixed', value: 'A boat.' } } }), ready: true };
  const fixedTools = await new ToolCatalog({ list: async () => [fixed] }).studio();
  assert.deepEqual(fixedTools.create_video.map(item => [item.name, item.camera ?? false]), [['LTX fixe', false]]);
  // Passed by hand all the same: left aside and said, the prompt it fixes is what the engine is given.
  const held = world({ workflows: [fixed], client }),
    kept = await held.runtime.request([call('create_video', { intention: 'x', duration: 5, camera: 'dolly_in' }, 'call-fixe')], { ...place, turnId: randomUUID() });
  assert.equal(kept.camera, undefined);
  assert.ok(kept.notes.includes('Caméra : valeur ignorée, LTX fixe ne prend pas ce réglage.'), JSON.stringify(kept.notes));
  jobs.length = 0;
  await held.runtime.execute({ requestId: kept.requestId, permission: 'once', approvalToken: kept.approvalToken });
  await held.runtime.finished;
  assert.deepEqual([held.runtime.status().state, jobs.at(-1)], ['done', ['run', 'A boat.']]);
});

// (0.6.476) The card of a video of Moodix AI chooses its model: LTX 2.5, MiniMax H3 Omni, pi H3 and Wan 2.2.
const [START, END, SUBJECT, SUBJECT_2, SUBJECT_3] = [uid(4), uid(5), uid(6), uid(7), uid(8)];
const framed = () => ({
  [START]: picture('debut.png', 1280, 720),
  [END]: picture('fin.png', 1280, 720),
  [SUBJECT]: picture('sujet.png'),
  [SUBJECT_2]: picture('sujet2.png'),
  [SUBJECT_3]: picture('sujet3.png'),
});
const everything = () => ({
  start_image: { resource: START },
  end_image: { resource: END },
  reference: [{ resource: SUBJECT }],
});
const heldOf = request => (request.held ?? []).map(item => [item.as, item.label, item.why]);
const sentOf = request => request.plan.references.map(ref => [ref.role, ref.label]);

test('the model of a video of Moodix AI chosen in its card: what it does not take stays greyed, why said, LTX 2.5 again takes it all (0.6.476)', async () => {
  const { runtime, saved } = world({ resources: framed() });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'Un phare sous la pluie.', intention: 'x', duration: 30, ...everything() })],
    place,
  );
  // LTX 2.5 by default: it takes the start, the end and the subject. Its list, in the order of the Bobine.
  assert.equal(first.workflowName, 'LTX 2.5');
  assert.equal(first.family, 'ltx25');
  assert.deepEqual(sentOf(first), [
    ['start_image', 'debut.png'],
    ['end_image', 'fin.png'],
    ['msr_image', 'sujet.png'],
  ]);
  assert.deepEqual(
    first.models.map(model => [model.name, model.all, model.off ?? '', model.missing ?? false]),
    [
      ['LTX 2.5', true, '', false],
      ['MiniMax H3 Omni', false, '', false],
      ['pi H3', false, '', false],
      ['Wan 2.2', false, '', false],
    ],
  );
  assert.deepEqual([first.held, first.warning], [undefined, undefined]);
  assert.ok(
    first.notes.includes('Durée : 30 s → 10,04 s, la plus proche que LTX 2.5 permet.'),
    JSON.stringify(first.notes),
  );
  const id = name => first.models.find(model => model.name === name).workflowId;

  // MiniMax H3 Omni, with the prompt typed on the card: the subject goes, the start and the end stay greyed.
  const minimax = await revise(runtime, first, { workflow: id('MiniMax H3 Omni'), prompt: 'Un phare sous la neige.' });
  assert.equal(minimax.workflowName, 'MiniMax H3 Omni');
  assert.equal(minimax.plan.prompt, 'Un phare sous la neige.');
  assert.equal(minimax.plan.parameters.seed, first.plan.parameters.seed, 'the seed of the proposal');
  assert.deepEqual(sentOf(minimax), [['reference_image', 'sujet.png']]);
  assert.deepEqual(minimax.args.references, [{ input: 'subject-1', resource_id: SUBJECT }]);
  assert.deepEqual(heldOf(minimax), [
    [
      'start_image',
      'debut.png',
      'MiniMax H3 Omni ne prend pas d’image de début : elle reste là, mais n’est pas envoyée.',
    ],
    ['end_image', 'fin.png', 'MiniMax H3 Omni ne prend pas d’image de fin : elle reste là, mais n’est pas envoyée.'],
  ]);
  assert.equal(
    minimax.warning,
    'L’image de début et l’image de fin ne sont pas envoyées à MiniMax H3 Omni : retirez-les, ou choisissez LTX 2.5.',
  );
  // Its length brought to what it makes, said as the router says it.
  assert.ok(minimax.notes.includes('Durée : 30 s → 14,38 s, la plus proche que MiniMax H3 Omni permet.'));
  assert.equal(runtime.pending.has(first.requestId), false, 'the proposal before it is given up');

  // pi H3: the start and the end go, the subject is greyed.
  const pi = await revise(runtime, minimax, { workflow: id('pi H3') });
  assert.equal(pi.plan.prompt, 'Un phare sous la neige.', 'the prompt typed stays');
  assert.deepEqual(sentOf(pi), [
    ['start_image', 'debut.png'],
    ['end_image', 'fin.png'],
  ]);
  assert.deepEqual(heldOf(pi), [
    [
      'reference',
      'sujet.png',
      'pi H3 ne prend pas de sujet : choisissez LTX 2.5 ou MiniMax H3 Omni. Il reste là, mais n’est pas envoyé.',
    ],
  ]);
  assert.equal(pi.warning, 'Le sujet 1 n’est pas envoyé à pi H3 : retirez-le, ou choisissez LTX 2.5.');

  // Wan 2.2: its start image only, which its card does not take out (it cannot do without).
  const wan = await revise(runtime, pi, { workflow: id('Wan 2.2') });
  assert.deepEqual(sentOf(wan), [['start_image', 'debut.png']]);
  assert.deepEqual(wan.fixedInputs, [0]);
  assert.deepEqual(
    heldOf(wan).map(([as, label]) => [as, label]),
    [
      ['end_image', 'fin.png'],
      ['reference', 'sujet.png'],
    ],
  );
  assert.equal(
    wan.warning,
    'L’image de fin et le sujet 1 ne sont pas envoyés à Wan 2.2 : retirez-les, ou choisissez LTX 2.5.',
  );
  assert.ok(wan.notes.includes('Durée : 30 s → 5,06 s, la plus proche que Wan 2.2 permet.'));

  // Back to LTX 2.5: everything goes again.
  const back = await revise(runtime, wan, { workflow: id('LTX 2.5') });
  assert.deepEqual(sentOf(back), sentOf(first));
  assert.deepEqual([back.held, back.warning], [undefined, undefined]);
  assert.equal(back.plan.parameters.frames, first.plan.parameters.frames);

  // What runs is what the card shows: the take of MiniMax H3 Omni is made with its subject alone, and keeps what was
  // not sent, by name, with the notes of its routing (its model is told so with its result).
  const chosen = await revise(runtime, back, { workflow: id('MiniMax H3 Omni') });
  await runtime.execute({ requestId: chosen.requestId, permission: 'once', approvalToken: chosen.approvalToken });
  await runtime.finished;
  assert.equal(runtime.status().state, 'done', runtime.status().error);
  const record = saved.at(-1);
  assert.equal(record.workflowName, 'MiniMax H3 Omni');
  assert.deepEqual(record.parameters.references.map(ref => [ref.input, ref.resource_id]), [['subject-1', SUBJECT]]);
  assert.ok(
    record.parameters.routing_notes.includes('debut.png et fin.png ne sont pas envoyées à MiniMax H3 Omni.'),
    JSON.stringify(record.parameters.routing_notes),
  );
});

test('the × of the card takes an image out of it: what was greyed beside it goes when its model takes it now (0.6.476)', async () => {
  const minimax = minimaxFull(),
    list = [...shipped().filter(workflow => workflow.pipeline !== 'minimax_h3'), minimax],
    { runtime } = world({ workflows: list, resources: framed() });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', duration: 5, ...everything() })],
    place,
  );
  assert.equal(first.workflowName, 'LTX 2.5');
  // A MiniMax H3 that takes a start and an end, or subjects: the start and the end go, the subject is greyed, and the
  // line says which to take out.
  const both = await revise(runtime, first, { workflow: 'minimax-full' });
  assert.deepEqual(sentOf(both), [
    ['start_image', 'debut.png'],
    ['end_image', 'fin.png'],
  ]);
  assert.deepEqual(heldOf(both), [
    [
      'reference',
      'sujet.png',
      'MiniMax H3 prend des sujets ou un début et une fin, pas les deux : celui-ci reste là, mais n’est pas envoyé.',
    ],
  ]);
  assert.equal(
    both.warning,
    'MiniMax H3 prend des sujets ou un début et une fin, pas les deux : retirez les images de début et de fin ou le sujet.',
  );
  // The start taken out: the subject is still not sent beside the end…
  const noStart = await revise(runtime, both, { remove: { input: 0 } });
  assert.deepEqual(sentOf(noStart), [['end_image', 'fin.png']]);
  assert.deepEqual(heldOf(noStart).map(([as]) => as), ['reference']);
  assert.equal(noStart.workflowName, 'MiniMax H3', 'the same model');
  // …the end too: now it goes.
  const subjectOnly = await revise(runtime, noStart, { remove: { input: 0 } });
  assert.deepEqual(sentOf(subjectOnly), [['reference_image', 'sujet.png']]);
  assert.deepEqual([subjectOnly.held, subjectOnly.warning], [undefined, undefined]);
  assert.deepEqual(subjectOnly.args.references, [{ input: 'subject-1', resource_id: SUBJECT }]);
  // An image greyed is taken out by its × as well.
  const own = world({ resources: framed() }),
    asked = await own.runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', duration: 5, ...everything() })],
      place,
    ),
    named = name => asked.models.find(model => model.name === name).workflowId,
    omni = await revise(own.runtime, asked, { workflow: named('MiniMax H3 Omni') }),
    lighter = await revise(own.runtime, omni, { remove: { held: 0 } });
  assert.deepEqual(heldOf(lighter).map(([as, label]) => [as, label]), [['end_image', 'fin.png']]);
  assert.equal(
    lighter.warning,
    'L’image de fin n’est pas envoyée à MiniMax H3 Omni : retirez-la, ou choisissez LTX 2.5.',
  );
  // Taken out, it is no longer in the card: a model that cannot do without it is greyed with its reason.
  assert.equal(
    lighter.models.find(model => model.name === 'Wan 2.2').off,
    'Wan 2.2 part d’une image de début : ajoutez-en une à la carte, puis choisissez-le.',
  );
  // Never what its model cannot do without, nor anything that is not there.
  const again = await own.runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', duration: 5, ...everything() }, 'call-2')],
      place,
    ),
    wan = await revise(own.runtime, again, { workflow: named('Wan 2.2') });
  assert.equal(sentOf(wan)[0][0], 'start_image');
  await assert.rejects(revise(own.runtime, wan, { remove: { input: 0 } }), {
    message: 'Wan 2.2 ne se fait pas sans « Image de début ».',
  });
  for (const remove of [{ input: 5 }, { held: 9 }, { input: 0, held: 0 }, 'start', {}])
    await assert.rejects(revise(own.runtime, wan, { remove }), { message: 'Entrée invalide.' }, JSON.stringify(remove));
  assert.ok(own.runtime.pending.has(wan.requestId), 'a refusal changes nothing');
});

test('a model of the card that is not on this computer: its download offered with the proposal as it is, then the proposal made for it (0.6.476)', async () => {
  const fetched = [],
    workflows = shipped().map(workflow =>
      workflow.pipeline === 'minimax_h3'
        ? { ...workflow, ready: false, builtin: true, unavailableKind: 'files' }
        : workflow,
    ),
    files = [{ file: 'minimax_h3_omni.safetensors', size: 21e9 }],
    { runtime } = world({
      workflows,
      resources: framed(),
      offerOf: async workflow => {
        fetched.push(workflow.id);
        return { complete: true, files, bytes: 21e9, left: 21e9, convert: true, room: 42e9 };
      },
    });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [
      call('create_video', {
        prompt: 'x',
        intention: 'x',
        duration: 5,
        start_image: { resource: START },
        reference: [{ resource: SUBJECT }],
      }),
    ],
    place,
  );
  const minimax = first.models.find(model => model.name === 'MiniMax H3 Omni');
  assert.deepEqual([first.workflowName, minimax.missing, minimax.off], ['LTX 2.5', true, undefined]);
  const offered = await revise(runtime, first, { workflow: minimax.workflowId });
  // The proposal stays the one of LTX 2.5 (a new token), its download beside it.
  assert.equal(offered.workflowName, 'LTX 2.5');
  assert.deepEqual(sentOf(offered), sentOf(first));
  assert.deepEqual(offered.offer, {
    workflowId: minimax.workflowId,
    workflowName: 'MiniMax H3 Omni',
    family: 'minimax_h3',
    files,
    bytes: 21e9,
    left: 21e9,
    needsToken: false,
    page: '',
    convert: true,
    room: 42e9,
  });
  assert.deepEqual(fetched, [minimax.workflowId]);
  assert.equal(runtime.pending.has(offered.requestId), true);
  // The files there: the proposal made for it.
  const there = workflows.find(workflow => workflow.pipeline === 'minimax_h3');
  there.ready = true;
  delete there.unavailableKind;
  const made = await revise(runtime, offered, { workflow: minimax.workflowId });
  assert.deepEqual([made.workflowName, made.offer], ['MiniMax H3 Omni', undefined]);
  assert.deepEqual(heldOf(made).map(([as]) => as), ['start_image']);
});

test('(0.6.479) a model of the card lacking only the engine: offered as one lacking its files, with it', async () => {
  // (Greyed with its reason before, its download nowhere to press.) (0.6.506) The engine as measured on 27/11.
  const engine = { bytes: preparationBytes('win32') },
    workflows = shipped().map(workflow =>
      workflow.pipeline === 'minimax_h3'
        ? { ...workflow, ready: false, builtin: true, unavailableKind: 'engine' }
        : workflow,
    ),
    { runtime } = world({
      workflows,
      resources: framed(),
      offerOf: async () => ({ complete: true, files: [], bytes: 0, left: 0, needsToken: false, page: '', engine }),
    });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const first = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', duration: 5, reference: [{ resource: SUBJECT }] })],
    place,
  );
  const minimax = first.models.find(model => model.name === 'MiniMax H3 Omni');
  assert.deepEqual([minimax.missing, minimax.off], [true, undefined]);
  const offered = await revise(runtime, first, { workflow: minimax.workflowId });
  const { files, bytes, left, engine: prepared } = offered.offer;
  assert.deepEqual([files, bytes, left, prepared], [[], 0, 0, engine]);
});

test('a model the card cannot take is refused in its words, the proposal kept; by hand, or for an image, no list (0.6.476)', async () => {
  const { runtime } = world({ resources: framed() });
  const place = { conversationId: A, turnId: turn, messages: [] };
  const text = await runtime.request([call('create_video', { prompt: 'x', intention: 'x', duration: 5 })], place);
  const wan = text.models.find(model => model.name === 'Wan 2.2');
  assert.equal(wan.off, 'Wan 2.2 part d’une image de début : ajoutez-en une à la carte, puis choisissez-le.');
  await assert.rejects(revise(runtime, text, { workflow: wan.workflowId }), { status: 400, message: wan.off });
  await assert.rejects(revise(runtime, text, { workflow: of(shipped(), 'krea2').id }), {
    message: 'Ce modèle ne se choisit pas pour cette proposition.',
  });
  assert.ok(runtime.pending.has(text.requestId), 'still the one to confirm');
  // By the user's own hand (the Studio names its model), and for an image: no list, no model changed there.
  const hand = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', duration: 5, start_image: { resource: START } }, 'call-2')],
    { ...place, byHand: true },
  );
  assert.equal(hand.models, undefined);
  await assert.rejects(revise(runtime, hand, { workflow: text.models[1].workflowId }), {
    message: 'Le modèle de cette proposition ne se change pas ici.',
  });
  const image = await runtime.request([call('create_image', { prompt: 'x' }, 'call-3')], place);
  assert.equal(image.models, undefined);
});

test('an image of Moodix AI whose model does not take every image given: said by name in its notes and its record (0.6.476)', async () => {
  const list = shipped().filter(workflow => workflow.pipeline !== 'qwen_image_edit'),
    { runtime, saved } = world({ workflows: list, resources: framed() });
  const asked = await runtime.request(
    [call('create_image', { prompt: 'x', reference: [{ resource: SUBJECT }, { resource: SUBJECT_2 }] })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  assert.equal(asked.workflowName, 'Krea 2');
  assert.deepEqual(sentOf(asked), [['img2img', 'sujet.png']]);
  assert.deepEqual(heldOf(asked), [
    ['reference', 'sujet2.png', 'Krea 2 ne prend pas d’autre image : elle reste là, mais n’est pas envoyée.'],
  ]);
  assert.equal(asked.warning, undefined, 'no card shows it: a note says it');
  assert.deepEqual(asked.notes, [
    'La première référence est prise comme image à modifier : Krea 2 part d’elle.',
    'sujet2.png n’est pas envoyée à Krea 2.',
  ]);
  await runtime.execute({ requestId: asked.requestId, permission: 'once', approvalToken: asked.approvalToken });
  await runtime.finished;
  assert.deepEqual(saved.at(-1).parameters.routing_notes, asked.notes);
});

// (0.6.493) The defects the review of 0.6.476 found (claude_design/chantier-27-11/relecture-chat-routage.md), each
// with its proof that failed before (relecture-chat-routage/preuves.test.mjs: B, C, D, E, F, X, Y).
const subjects = () => [SUBJECT, SUBJECT_2, SUBJECT_3].map(resource => ({ resource }));
const modelId = (request, name) => request.models.find(model => model.name === name).workflowId;

test('a video of Moodix AI is made by LTX 2.5, what it does not take greyed, never by MiniMax H3 Omni in its place (0.6.493)', async () => {
  const list = shipped(),
    [LTX_CLIP, OMNI_CLIP] = [uid(9), uid('a')],
    { runtime } = world({
      workflows: list,
      resources: framed(),
      records: {
        [`${A}/${LTX_CLIP}`]: clip(A, LTX_CLIP, of(list, 'ltx25')),
        [`${A}/${OMNI_CLIP}`]: clip(A, OMNI_CLIP, of(list, 'minimax_h3')),
      },
    });
  const place = { conversationId: A, turnId: turn, messages: [] },
    ask = (name, args, id) => runtime.request([call(name, { prompt: 'x', intention: 'x', ...args }, id)], place);
  // Three subjects, LTX 2.5 named or not (relecture, B): it takes two, the third stays greyed with why, and the line
  // says to remove it or to choose the model that takes it (« on grisera et on mettra un message d'avertissement »).
  for (const [more, id] of [
    [{}, 'b-1'],
    [{ workflow: 'LTX 2.5' }, 'b-2'],
  ]) {
    const three = await ask('create_video', { duration: 5, reference: subjects(), ...more }, id);
    assert.equal(three.workflowName, 'LTX 2.5', id);
    assert.deepEqual(sentOf(three), [
      ['msr_image', 'sujet.png'],
      ['msr_image', 'sujet2.png'],
    ]);
    assert.deepEqual(heldOf(three), [
      ['reference', 'sujet3.png', 'LTX 2.5 prend 2 sujets au plus : celui-ci reste là, mais n’est pas envoyé.'],
    ]);
    assert.equal(three.warning, 'Le sujet 3 n’est pas envoyé à LTX 2.5 : retirez-le, ou choisissez MiniMax H3 Omni.');
    // Said by name in its notes too, for the Studio, which draws neither what is greyed nor the line (G1); the card
    // leaves that note to them (`heldNote`).
    assert.equal(three.heldNote, 'sujet3.png n’est pas envoyée à LTX 2.5.');
    assert.ok(three.notes.includes(three.heldNote), JSON.stringify(three.notes));
  }
  // The suite of a clip of LTX 2.5 with a subject: LTX 2.5, its clip sent, the subject greyed.
  const suite = await ask('extend_video', { source: { output: LTX_CLIP }, reference: [{ resource: SUBJECT }] }, 'b-3');
  assert.equal(suite.workflowName, 'LTX 2.5');
  assert.deepEqual(rolesOf(suite), ['source_video']);
  assert.deepEqual(heldOf(suite), [
    [
      'reference',
      'sujet.png',
      'LTX 2.5 ne prend pas de sujet dans une suite. Pour une suite avec des sujets : MiniMax H3 Omni. ' +
        'Il reste là, mais n’est pas envoyé.',
    ],
  ]);
  // A clip of MiniMax H3 Omni brings its model, which takes the subject; named, MiniMax H3 Omni is the one.
  const own = await ask('extend_video', { source: { output: OMNI_CLIP }, reference: [{ resource: SUBJECT }] }, 'b-4');
  assert.deepEqual([own.workflowName, own.held, rolesOf(own)], [
    'MiniMax H3 Omni',
    undefined,
    ['source_video', 'reference_image'],
  ]);
  const named = await ask('create_video', { duration: 5, reference: subjects(), workflow: 'MiniMax H3 Omni' }, 'b-5');
  assert.deepEqual([named.workflowName, named.held], ['MiniMax H3 Omni', undefined]);
});

test('what no model here takes whole is proposed, not refused in the words of the router: LTX 2.5 to download, or the model that takes most (0.6.493)', async () => {
  const files = [{ file: 'ltx-2.5.safetensors', size: 27e9 }],
    offerOf = async () => ({ complete: true, files, bytes: 27e9, left: 27e9 }),
    lacking = shipped().map(workflow =>
      workflow.pipeline === 'ltx25' ? { ...workflow, ready: false, builtin: true, unavailableKind: 'files' } : workflow,
    ),
    { runtime } = world({ workflows: lacking, resources: framed(), offerOf });
  const place = { conversationId: A, turnId: turn, messages: [] },
    both = {
      prompt: 'x',
      intention: 'x',
      duration: 5,
      start_image: { resource: START },
      reference: [{ resource: SUBJECT }],
    };
  // LTX 2.5 not downloaded, a start and a subject (relecture, X): LTX 2.5, which takes both, its download offered (53);
  // never « no free image slot » sent back to the chat model (M1), nor another model taken without a word (S2).
  const made = await runtime.request([call('create_video', both)], place);
  assert.equal(made.workflowName, 'LTX 2.5');
  assert.deepEqual([made.missing.workflowId, made.missing.files], [of(lacking, 'ltx25').id, files]);
  // Without LTX 2.5 on this computer: the model that takes most, the rest greyed, the line saying to remove it.
  const without = world({
    workflows: shipped().filter(workflow => workflow.pipeline !== 'ltx25'),
    resources: framed(),
  });
  const partial = await without.runtime.request([call('create_video', both, 'call-2')], place);
  assert.equal(partial.workflowName, 'MiniMax H3 Omni');
  assert.deepEqual(sentOf(partial), [['reference_image', 'sujet.png']]);
  assert.deepEqual(heldOf(partial).map(([as, label]) => [as, label]), [['start_image', 'debut.png']]);
  assert.equal(partial.warning, 'L’image de début n’est pas envoyée à MiniMax H3 Omni : retirez-la.');
});

test('a proposal whose card downloads a model waits for its files, then is made for it; else it expires and says so (0.6.493)', async () => {
  const workflows = shipped().map(workflow =>
      workflow.pipeline === 'minimax_h3'
        ? { ...workflow, ready: false, builtin: true, unavailableKind: 'files' }
        : workflow,
    ),
    files = [{ file: 'minimax_h3_omni.safetensors', size: 40.7e9 }],
    { runtime } = world({
      workflows,
      resources: framed(),
      offerOf: async () => ({ complete: true, files, bytes: 40.7e9, left: 40.7e9 }),
    });
  const place = { conversationId: A, turnId: turn, messages: [] },
    QUARTER = 15 * 60 * 1000,
    first = await runtime.request(
      [call('create_video', { prompt: 'x', intention: 'x', duration: 5, reference: [{ resource: SUBJECT }] })],
      place,
    );
  // The time the server keeps it, which its card counts to grey « Générer » (relecture, M3).
  assert.equal(first.expiresIn, QUARTER);
  const offered = await revise(runtime, first, { workflow: modelId(first, 'MiniMax H3 Omni') });
  assert.equal(offered.offer.workflowId, modelId(first, 'MiniMax H3 Omni'));
  // 40,7 Go: about 55 minutes at 100 Mbit/s (relecture, Y). The proposal waits for them, a day at most.
  assert.equal(offered.expiresIn, 24 * 60 * 60 * 1000);
  runtime.pending.get(offered.requestId).created -= 55 * 60 * 1000;
  const there = workflows.find(workflow => workflow.pipeline === 'minimax_h3');
  there.ready = true;
  delete there.unavailableKind;
  const made = await revise(runtime, offered, { workflow: offered.offer.workflowId });
  assert.deepEqual([made.workflowName, made.offer, made.expiresIn], ['MiniMax H3 Omni', undefined, QUARTER]);
  // Made for its model, it is kept the usual quarter of an hour: past it, revise and « Générer » say it is gone, in
  // the words its card greys « Générer » with.
  runtime.pending.get(made.requestId).created -= QUARTER + 1000;
  const gone = { status: 409, message: 'Cet appel a expiré. Relancez la demande.' };
  await assert.rejects(revise(runtime, made, {}), gone);
  await assert.rejects(
    runtime.execute({ requestId: made.requestId, permission: 'once', approvalToken: made.approvalToken }),
    gone,
  );
});

test('the length, the seed and the version chosen on the card stay through the changes of its model (0.6.493)', async () => {
  const { runtime } = world({ resources: framed() });
  const place = { conversationId: A, turnId: turn, messages: [] },
    ask = (args, id) =>
      runtime.request([call('create_video', { prompt: 'Un phare.', intention: 'x', duration: 5, ...args }, id)], place);
  // The length (relecture, C): 10 s on the card, MiniMax H3 Omni, then LTX 2.5 again without touching it: 10 s.
  const ten = (await ask({ duration: 10 }, 'c-10')).plan.parameters.frames,
    first = await ask({}, 'c-5');
  assert.notEqual(first.plan.parameters.frames, ten);
  const minimax = await revise(runtime, first, { frames: ten, workflow: modelId(first, 'MiniMax H3 Omni') });
  assert.equal(minimax.workflowName, 'MiniMax H3 Omni');
  const back = await revise(runtime, minimax, { workflow: modelId(minimax, 'LTX 2.5') });
  assert.equal(back.plan.parameters.frames, ten);
  // The seed typed (D), sent with the model chosen or before it.
  const typed = 123456789,
    same = await revise(runtime, back, { seed: typed, workflow: modelId(back, 'pi H3') });
  assert.equal(same.plan.parameters.seed, typed);
  const other = await ask({}, 'd-2'),
    seeded = await revise(runtime, other, { seed: typed }),
    changed = await revise(runtime, seeded, { workflow: modelId(seeded, 'MiniMax H3 Omni') });
  assert.equal(changed.plan.parameters.seed, typed);
  assert.equal(
    (await revise(runtime, changed, { workflow: modelId(changed, 'LTX 2.5') })).plan.parameters.seed,
    typed,
  );
  // The final version (E), through Wan 2.2, which has none.
  const framedShot = await ask({ start_image: { resource: START } }, 'e-1'),
    final = await revise(runtime, framedShot, { stage: 'final' });
  assert.equal(final.plan.stage, 'final');
  const wan = await revise(runtime, final, { workflow: modelId(final, 'Wan 2.2') });
  assert.equal(wan.workflowName, 'Wan 2.2');
  assert.equal((await revise(runtime, wan, { workflow: modelId(wan, 'LTX 2.5') })).plan.stage, 'final');
});

test('a model greyed in the list of the card is never the one the bubble of an input says to choose (0.6.493)', async () => {
  // MiniMax H3 Omni not offered to Moodix AI (relecture, F): greyed in the list, so not named in the bubble.
  const workflows = shipped().map(workflow =>
      workflow.pipeline === 'minimax_h3' ? { ...workflow, enabled: false } : workflow,
    ),
    { runtime } = world({ workflows, resources: framed() });
  const first = await runtime.request(
    [call('create_video', { prompt: 'x', intention: 'x', duration: 5, ...everything() })],
    { conversationId: A, turnId: turn, messages: [] },
  );
  const pi = await revise(runtime, first, { workflow: modelId(first, 'pi H3') });
  assert.match(pi.models.find(model => model.name === 'MiniMax H3 Omni').off, /n’est pas proposé à Moodix AI/);
  assert.deepEqual(heldOf(pi), [
    ['reference', 'sujet.png', 'pi H3 ne prend pas de sujet : choisissez LTX 2.5. Il reste là, mais n’est pas envoyé.'],
  ]);
  assert.equal(pi.warning, 'Le sujet 1 n’est pas envoyé à pi H3 : retirez-le, ou choisissez LTX 2.5.');
  // The model changed alone: an input or a LoRA sent with it is refused in words, never left aside without one (S5).
  for (const more of [{ remove: { held: 0 } }, { add: { role: 'reference', source: { resource: SUBJECT_2 } } }])
    await assert.rejects(revise(runtime, pi, { ...more, workflow: modelId(pi, 'LTX 2.5') }), {
      status: 400,
      message: 'Le modèle se change seul : les images et les LoRA se changent ensuite, sur sa carte.',
    });
  assert.ok(runtime.pending.has(pi.requestId), 'a refusal changes nothing');
});
