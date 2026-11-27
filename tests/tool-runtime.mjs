import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime, collectToolCalls } from '../lib/tool-runtime.mjs';
import { heldCause } from '../public/generation-ui.mjs';
const id = 'a1111111-1111-4111-8111-111111111111';
// Minimal native catalog: a resolved job plus the workflow it came from.
const nativeWorkflow = (fields = {}) => ({
  schemaVersion: 1,
  id: 'wf',
  pipeline: 'krea2',
  mediaType: 'image',
  enabled: true,
  ready: true,
  parameters: { prompt: { policy: 'model', type: 'string' } },
  references: [],
  ...fields,
});
const nativePrepared = (workflow, references = []) => ({
  workflow,
  job: {
    pipeline: 'krea2',
    parameters: { prompt: 'portrait', seed: 7, width: 512, height: 512 },
    components: {},
    loras: [],
    references,
  },
});

test('native deltas assemble tool arguments; text never becomes a tool', () => {
  const calls = [];
  collectToolCalls(calls, {
    tool_calls: [{ index: 0, id: 'call_1', function: { name: 'create_image', arguments: '{"prompt":' } }],
  });
  collectToolCalls(calls, { tool_calls: [{ index: 0, function: { arguments: '"cat"}' } }] });
  assert.equal(calls[0].function.arguments, '{"prompt":"cat"}');
  collectToolCalls(calls, { content: '{"tool":"create_image"}' });
  assert.equal(calls.length, 1);
});
test('approval pins workflow, is consumed once, and enforces a turn limit', async () => {
  let digest = 'one',
    runs = 0;
  const order = [];
  const workflow = nativeWorkflow({ id: 'wf', name: 'test', digest });
  const catalog = {
    list: async () => [{ ...workflow, digest }],
    read: async () => ({ ...workflow, digest }),
    prepare: async () => nativePrepared(workflow),
  };
  const engine = {
    state: 'ready',
    busy: false,
    stop: async () => {
      order.push('stop');
      engine.state = 'stopped';
    },
    start: async () => {
      order.push('start');
      engine.state = 'ready';
    },
  };
  const client = {
    status: async () => ({ idle: true }),
    preflight: async () => {},
    run: async () => {
      runs++;
      order.push('run');
      return {
        outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }],
        // The engine made another size than asked (a video in the shape of the one it follows).
        metadata: { parameters: { width: 384, height: 640, frames: 29, fps: 30, seed: 99 } },
      };
    },
    free: async () => {
      order.push('free');
    },
  };
  const gallery = { put: async r => r };
  const rt = new ToolRuntime({
    engine,
    catalog,
    gallery,
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 1 }),
    engineConfig: () => ({}),
    clientFactory: () => client,
  });
  const calls = [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'create_image', arguments: '{"prompt":"cat"}' },
    },
  ];
  const pending = await rt.request(calls, { conversationId: id, turnId: id, messages: [] });
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'none' }), /autorisation/i);
  digest = 'changed';
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), /modifié/i);
  digest = 'one';
  const p = await rt.request(calls, { conversationId: id, turnId: id, messages: [] });
  const job = await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.job.state, 'done');
  assert.equal(job.id, rt.job.id);
  assert.equal(rt.job.record.parameters.reference_count, 0);
  assert.equal(rt.job.record.parameters.reference_capacity, 0);
  // The record says what was made: the size, the length and the rate come from the engine.
  const kept = rt.job.record.parameters;
  assert.deepEqual([kept.width, kept.height, kept.frames, kept.fps, kept.seed], [384, 640, 29, 30, 7]);
  assert.equal(rt.job.record.parameters.reference_mode, 'not_provided');
  assert.deepEqual(order, ['stop', 'run', 'free', 'start']);
  assert.equal(runs, 1);
  await assert.rejects(rt.execute({ requestId: p.requestId, permission: 'once' }), /expiré/i);
  await assert.rejects(rt.request(calls, { conversationId: id, turnId: id, messages: [] }), /limite/i);
});
test('a failed GPU release keeps the LLM stopped and records the error', async () => {
  let starts = 0;
  const engine = {
    state: 'ready',
    stop: async () => {},
    start: async () => {
      starts++;
    },
  };
  const rt = new ToolRuntime({
    engine,
    catalog: {
      list: async () => [nativeWorkflow({ digest: '1', name: 'wf' })],
      read: async () => nativeWorkflow({ digest: '1', name: 'wf' }),
      prepare: async () => nativePrepared(nativeWorkflow({ name: 'wf', digest: '1' })),
    },
    gallery: { put: async r => r },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 3 }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async () => {
        throw Error('failed');
      },
      free: async () => {
        throw Error('VRAM');
      },
    }),
  });
  const p = await rt.request(
    [
      {
        id: 'c',
        type: 'function',
        function: { name: 'create_image', arguments: '{"prompt":"cat"}' },
      },
    ],
    { conversationId: id, turnId: id, messages: [] },
  );
  await rt.execute({ requestId: p.requestId });
  await rt.finished;
  assert.equal(rt.active, true);
  assert.equal(starts, 0);
  assert.equal(rt.job.state, 'error');
  assert.match(rt.job.error, /VRAM/);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeFixture() {
  const seen = { runs: 0, stops: 0, starts: 0, references: [] };
  const workflow = nativeWorkflow({
    id: 'wf',
    name: 'Portrait',
    digest: 'approved',
    references: [{ id: 'source', name: 'Source', role: 'img2img', description: 'Image to edit', required: false }],
  });
  const engine = {
    state: 'ready',
    busy: false,
    async stop() {
      seen.stops++;
      engine.state = 'stopped';
    },
    async start() {
      seen.starts++;
      engine.state = 'ready';
    },
  };
  const catalog = {
    async list() {
      return [{ ...workflow }];
    },
    async read() {
      return { ...workflow };
    },
    async prepare() {
      return nativePrepared({ ...workflow });
    },
  };
  const client = {
    async status() {
      return { idle: true };
    },
    async preflight() {},
    async run(job) {
      seen.runs++;
      seen.references.push(job.references);
      return { outputs: [{ filename: 'portrait.png', subfolder: '', type: 'output' }] };
    },
    async free() {
      return { idle: true, memory: { torchAllocated: 0 } };
    },
  };
  const rt = new ToolRuntime({
    engine,
    catalog,
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 1 }),
    engineConfig: () => ({}),
    clientFactory: () => client,
  });
  const request = (args = {}, messages = []) =>
    rt.request(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'create_image',
            arguments: JSON.stringify({ prompt: 'portrait', ...args }),
          },
        },
      ],
      { conversationId: id, turnId: id, messages },
    );
  return { rt, seen, workflow, catalog, client, request };
}

test('concurrent execute claims one approval before asynchronous preflight', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const gate = deferred();
  client.status = async () => {
    await gate.promise;
    return { idle: true };
  };
  const pending = await request();
  const first = rt.execute({ requestId: pending.requestId, permission: 'once' });
  assert.equal(rt.active, true, 'preflight owns the GPU before the first await');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  gate.resolve();
  const job = await first;
  await rt.finished;
  assert.equal(seen.runs, 1);
  assert.equal(rt.status().id, job.id);
  assert.equal(rt.status().state, 'done');
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), /expiré/i);
});

test('a workflow changed during the engine status check never reaches execution', async () => {
  const { rt, seen, workflow, client, request } = runtimeFixture();
  const pending = await request();
  client.status = async () => {
    workflow.digest = 'replaced';
    return { idle: true };
  };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(seen.runs, 0);
  assert.equal(rt.status().state, 'error');
  assert.match(rt.status().error, /workflow.*modifié/i);
});

test('a chat image reference is uploaded once and reaches the job as a staged path', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  let uploads = 0;
  client.upload = async bytes => {
    uploads++;
    assert.deepEqual(bytes, Buffer.from('89504e470d0a1a0a', 'hex'));
    return { path: '/staged/reference.png' };
  };
  const pending = await request({ source: { image: 0 } }, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
  ]);
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(uploads, 1);
  assert.deepEqual(seen.references.at(-1), [{ input: 'source', role: 'img2img', path: '/staged/reference.png' }]);
  assert.equal(rt.status().state, 'done');
});

test('unconfirmed cleanup blocks execution until explicit recovery succeeds', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const pending = await request();
  client.free = async () => {
    throw new Error('allocation still unknown');
  };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  assert.equal(rt.status().state, 'error');
  assert.equal(seen.starts, 0);
  await assert.rejects(rt.execute({ requestId: pending.requestId, permission: 'once' }), { status: 409 });
  await assert.rejects(rt.recover(), /allocation still unknown/);
  assert.equal(rt.active, true);
  assert.equal(rt.status().blocked, true);
  const gate = deferred();
  client.free = async () => {
    await gate.promise;
    return { idle: true, memory: { torchAllocated: 0 } };
  };
  const recovery = rt.recover();
  assert.equal(rt.active, true, 'recovery owns the GPU until release confirmation');
  gate.resolve();
  const recovered = await recovery;
  assert.equal(recovered.blocked, false);
  assert.equal(rt.active, false);
  assert.equal(recovered.state, 'done');
  await assert.rejects(rt.recover(), { status: 409 });
});

test('(0.6.456) the card held after a take that failed: the page finds why it failed in what the server says', async () => {
  const { rt, client, request } = runtimeFixture();
  const pending = await request();
  client.run = async () => {
    throw new Error('CUDA out of memory. Tried to allocate 2.00 GiB');
  };
  client.free = async () => {
    throw new Error('GPU cleanup incomplete: 3.2 GiB still allocated');
  };
  await rt.execute({ requestId: pending.requestId, permission: 'once' });
  await rt.finished;
  const { blocked, error } = rt.status();
  assert.equal(blocked, true);
  assert.match(error, /non confirmée : GPU cleanup incomplete/);
  // What the Chat and the Studio say beside « Échec » (generation-ui.mjs): the take's own failure, in the user's words.
  assert.match(heldCause(error), /^La carte graphique n’a pas assez de mémoire pour cette image\b/);
  assert.doesNotMatch(heldCause(error), /Libération|GPU cleanup/);
  // Free again, the server says the same (recover).
  client.free = async () => ({ idle: true, memory: { torchAllocated: 0 } });
  const recovered = await rt.recover();
  assert.deepEqual([recovered.blocked, recovered.state, recovered.error], [false, 'error', heldCause(error)]);
});

test('forgetting one conversation invalidates only its pending calls and completed job', async () => {
  const { rt, request, seen } = runtimeFixture();
  const first = await request();
  const other = 'b2222222-2222-4222-8222-222222222222';
  const second = await rt.request(
    [
      {
        id: 'other_call',
        type: 'function',
        function: {
          name: 'create_image',
          arguments: JSON.stringify({ prompt: 'Another portrait' }),
        },
      },
    ],
    { conversationId: other, turnId: other, messages: [] },
  );
  rt.forgetConversation(id);
  await assert.rejects(rt.execute({ requestId: first.requestId, permission: 'once' }), /expiré/i);
  await rt.execute({ requestId: second.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(seen.runs, 1);
  rt.forgetConversation(id);
  assert.equal(rt.job.record.conversationId, other);
  rt.forgetConversation(other);
  assert.equal(rt.job, null);
});

test('cancel targets the owned request and cannot abort another job', async () => {
  const { rt, client, request } = runtimeFixture(),
    gate = deferred();
  client.status = async () => {
    await gate.promise;
    return { idle: true };
  };
  const p = await request();
  const executing = rt.execute({ requestId: p.requestId, permission: 'once' });
  try {
    assert.throws(() => rt.cancel({ requestId: 'different-request' }), { status: 409 });
    assert.equal(rt.job.controller.signal.aborted, false);
    rt.cancel({ requestId: p.requestId });
    assert.equal(rt.job.controller.signal.aborted, true);
  } finally {
    gate.resolve();
    await assert.rejects(executing, { name: 'AbortError' });
    await rt.close();
  }
});

test('closing waits for explicit GPU recovery and rejects any later execution', async () => {
  const { rt, client, request } = runtimeFixture(),
    p = await request();
  client.free = async () => {
    throw Error('not released');
  };
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  const gate = deferred();
  client.free = async () => gate.promise;
  const recovery = rt.recover();
  let closed = false;
  const closing = rt.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false);
  gate.resolve();
  await recovery;
  await closing;
  await assert.rejects(request(), { status: 409 });
});

test('GPU recovery cannot turn a failed generation into a successful image', async () => {
  const { rt, client, request } = runtimeFixture(),
    p = await request();
  client.run = async () => {
    throw Error('workflow rejected');
  };
  client.free = async () => {
    throw Error('memory unknown');
  };
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  client.free = async () => {};
  await rt.recover();
  assert.equal(rt.active, false);
  assert.equal(rt.status().state, 'error');
  assert.match(rt.status().error, /workflow rejected/);
});

test('a gallery disk write failure keeps generated originals linked in session memory', async () => {
  const { rt, request } = runtimeFixture();
  const writes = [];
  rt.persist = () => true;
  rt.gallery.put = async (record, { persist }) => {
    writes.push(persist);
    if (persist) throw Error('disk full');
    return record;
  };
  const p = await request();
  await rt.execute({ requestId: p.requestId, permission: 'once' });
  await rt.finished;
  assert.equal(rt.status().state, 'done');
  assert.equal(rt.status().record?.outputs[0].source.filename, 'portrait.png');
  assert.match(rt.status().warning, /disk full/);
  assert.deepEqual(writes, [true, false]);
});

test('cancelling while global approval is saved never unloads the language model', async () => {
  const { rt, request, seen } = runtimeFixture(),
    entered = deferred(),
    gate = deferred();
  rt.saveConfig = async () => {
    entered.resolve();
    await gate.promise;
  };
  const p = await request(),
    execution = rt.execute({ requestId: p.requestId, permission: 'always' });
  await entered.promise;
  rt.cancel({ requestId: p.requestId });
  gate.resolve();
  await assert.rejects(execution, { name: 'AbortError' });
  await rt.finished;
  assert.equal(seen.stops, 0);
  assert.equal(seen.runs, 0);
});

test('cancelling a pending approval releases its reference copies and prevents later execution', async () => {
  const { rt, request, seen } = runtimeFixture(),
    approval = await request();
  rt.cancel({ requestId: approval.requestId });
  assert.equal(rt.pending.size, 0);
  await assert.rejects(rt.execute({ requestId: approval.requestId, permission: 'once' }), /expiré/i);
  assert.equal(seen.runs, 0);
});

test('an active resource is passed as its original file, and deactivating it before execution keeps the model loaded', async () => {
  const { rt, seen, client, request } = runtimeFixture();
  const resource = 'c3333333-3333-4333-8333-333333333333';
  let active = true;
  rt.resources = {
    activeRecord: async id => {
      assert.equal(id, resource);
      if (!active) throw Object.assign(Error('Ressource désactivée.'), { status: 409 });
      return { mime: 'image/png' };
    },
  };
  rt.sourceMedia = async ref => {
    assert.equal(ref.resource_id, resource);
    return { mime: 'image/png', name: 'chair.png', handle: { close: async () => {} } };
  };
  client.stage = async () => ({ path: '/staged/chair.png' });
  const approved = await request({ source: { resource } });
  await rt.execute({ requestId: approved.requestId, permission: 'once' });
  await rt.finished;
  assert.deepEqual(seen.references.at(-1), [{ input: 'source', role: 'img2img', path: '/staged/chair.png' }]);
  const again = await request({ source: { resource } }).catch(error => error);
  // The turn limit is one in this fixture; a fresh runtime checks deactivation.
  assert.match(again.message, /limite/i);
  const second = runtimeFixture();
  second.rt.resources = rt.resources;
  second.rt.sourceMedia = rt.sourceMedia;
  const pending = await second.request({ source: { resource } });
  active = false;
  await assert.rejects(second.rt.execute({ requestId: pending.requestId, permission: 'once' }), /désactivée/);
  assert.equal(second.seen.stops, 0);
  assert.equal(second.seen.runs, 0);
});

test('a verb with no matching workflow explains which inputs are available', async () => {
  const { rt } = runtimeFixture();
  await assert.rejects(
    rt.request(
      [{ id: 'c', type: 'function', function: { name: 'create_video', arguments: '{"prompt":"x","intention":"y"}' } }],
      { conversationId: id, turnId: id, messages: [] },
    ),
    /Aucun workflow/,
  );
  await assert.rejects(
    rt.request(
      [
        {
          id: 'c',
          type: 'function',
          function: { name: 'create_image', arguments: '{"prompt":"x","start_image":{"image":0}}' },
        },
      ],
      { conversationId: id, turnId: id, messages: [] },
    ),
    /Aucun workflow|start_image/,
  );
});

test('an image the user named and a proposal leaves out is said on it, until it is given', async () => {
  const stairs = { id: 'c3333333-3333-4333-8333-333333333333', label: '#ref2' },
    chair = { id: 'd4444444-4444-4444-8444-444444444444', label: '#ref3' };
  const fixture = runtimeFixture(),
    { rt } = fixture;
  rt.resources = { activeRecord: async () => ({ mime: 'image/png' }) };
  rt.sourceMedia = async ref => ({ mime: 'image/png', name: ref.resource_id + '.png', handle: { close: async () => {} } });
  const ask = (args, options = {}) =>
    rt.request(
      [{ id: 'call_1', type: 'function', function: { name: 'create_image', arguments: JSON.stringify({ prompt: 'portrait', ...args }) } }],
      { conversationId: id, turnId: id, messages: [], ...options },
    );
  // Nothing named, or the image named given: nothing to say.
  assert.equal((await ask({})).cited, undefined);
  const given = await ask({ source: { resource: stairs.id } }, { cited: [stairs] });
  assert.deepEqual([given.cited, given.notes], [undefined, undefined]);
  // Named and left out, a place free in its workflow: the roles it could take (the model is told).
  const left = await ask({}, { cited: [stairs] });
  assert.deepEqual(left.cited, { left: [stairs], roles: ['source'] });
  assert.deepEqual(left.notes, ['#ref2 n’est pas transmise. Le générateur ne la verra pas, seul le prompt peut la décrire.']);
  // Its only place taken by another image: no role left, the reason said to the user.
  const taken = await ask({ source: { resource: chair.id } }, { cited: [stairs, chair] });
  assert.deepEqual(taken.cited, { left: [stairs], roles: [] });
  assert.deepEqual(taken.notes, [
    '#ref2 n’est pas transmise : Portrait n’a pas de place pour elle avec les autres entrées. ' +
      'Le générateur ne la verra pas, seul le prompt peut la décrire.',
  ]);
  // An image passed by its position among those attached may be the one named: nothing is claimed.
  const attached = await ask({ source: { image: 0 } }, {
    cited: [stairs],
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
  });
  assert.deepEqual([attached.cited, attached.notes], [undefined, undefined]);
  // A verb that makes nothing from images (an upscale) says nothing of them.
  assert.equal(rt.pending.size > 0, true);
});

test('a workflow that takes no image says so of the image the user named', async () => {
  const stairs = { id: 'c3333333-3333-4333-8333-333333333333', label: '#ref2' };
  const workflow = nativeWorkflow({ id: 'wf', name: 'Affiche', digest: 'one' });
  const rt = new ToolRuntime({
    engine: { state: 'ready', busy: false, stop: async () => {}, start: async () => {} },
    catalog: { list: async () => [workflow], read: async () => workflow, prepare: async () => nativePrepared(workflow) },
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 3 }),
    engineConfig: () => ({}),
    clientFactory: () => ({}),
  });
  const proposal = await rt.request(
    [{ id: 'call_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"une affiche"}' } }],
    { conversationId: id, turnId: id, messages: [], cited: [stairs] },
  );
  assert.deepEqual(proposal.cited, { left: [stairs], roles: [] });
  assert.deepEqual(proposal.notes, [
    '#ref2 n’est pas transmise : Affiche ne prend pas d’image. Le générateur ne la verra pas, seul le prompt peut la décrire.',
  ]);
  // The proposal revised by the user (its prompt): the note is worked out again, said once.
  const revised = await rt.revise({ requestId: proposal.requestId, approvalToken: proposal.approvalToken, edits: { prompt: 'une autre affiche' } });
  assert.deepEqual(revised.notes, proposal.notes);
  assert.deepEqual(revised.cited, proposal.cited);
});

test('(0.6.208) an image named and left out keeps its number: a capable model is told « {"ref": 2} », not « undefined »', async () => {
  // The application tells the model once which image it left out (server.mjs, citedMessage), from what the
  // proposal says of it (`cited.left`). A capable model names a reference by its number (lib/model-wording.mjs):
  // the proposal kept the id and the label alone, and that model read « #ref2 ({"ref": undefined}) ».
  const { citedMessage } = await import('../lib/cited-resources.mjs');
  const stairs = { id: 'c3333333-3333-4333-8333-333333333333', label: '#ref2', reference: 2, type: 'image', name: 'escalier.png' };
  const { rt } = runtimeFixture();
  rt.resources = { activeRecord: async () => ({ mime: 'image/png' }) };
  rt.sourceMedia = async ref => ({ mime: 'image/png', name: ref.resource_id + '.png', handle: { close: async () => {} } });
  const left = await rt.request(
    [{ id: 'call_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"portrait"}' } }],
    { conversationId: id, turnId: id, messages: [], cited: [stairs] },
  );
  // Its id, its label and its number: nothing else of the catalogue of the project (its file name).
  assert.deepEqual(left.cited, { left: [{ id: stairs.id, label: '#ref2', reference: 2 }], roles: ['source'] });
  assert.match(citedMessage(left.cited.left, left.cited.roles, { byNumber: true }), /#ref2 \(\{"ref": 2\}\)/);
  assert.match(citedMessage(left.cited.left, left.cited.roles), /#ref2 \(\{"resource": "c3333333-3333-4333-8333-333333333333"\}\)/);
  // Revised by the user, the proposal still knows it.
  const revised = await rt.revise({ requestId: left.requestId, approvalToken: left.approvalToken, edits: { prompt: 'un autre portrait' } });
  assert.deepEqual(revised.cited, left.cited);
});

test('(0.6.209) an image named and left out comes with a picture of it the card may show, as an input does', async () => {
  // The card of the Chat keeps it in view, greyed (public/video-plan.mjs): it needs its picture, which the
  // proposal gave for its inputs alone.
  const stairs = { id: 'c3333333-3333-4333-8333-333333333333', label: '#ref2', reference: 2 },
    chair = { id: 'd4444444-4444-4444-8444-444444444444', label: '#ref3', reference: 3 };
  const { rt } = runtimeFixture();
  rt.resources = { activeRecord: async () => ({ mime: 'image/png' }) };
  rt.sourceMedia = async ref => ({ mime: 'image/png', name: ref.resource_id + '.png', handle: { close: async () => {} } });
  const seen = [];
  rt.previewOf = (ref, conversationId, media) => {
    seen.push([ref.resource_id, conversationId, media]);
    return '/media/resources/' + ref.resource_id + '/preview';
  };
  const taken = await rt.request(
    [{ id: 'call_1', type: 'function', function: { name: 'create_image', arguments: JSON.stringify({ prompt: 'portrait', source: { resource: chair.id } }) } }],
    { conversationId: id, turnId: id, messages: [], cited: [stairs, chair] },
  );
  assert.deepEqual(taken.cited, {
    left: [{ id: stairs.id, label: '#ref2', reference: 2, preview: '/media/resources/' + stairs.id + '/preview' }],
    roles: [],
  });
  assert.ok(seen.some(([resource, conversation, media]) => resource === stairs.id && conversation === id && media === 'image'));
  // Revised, the proposal still shows it; what the model is told of it reads its label, its id and its number alone.
  const revised = await rt.revise({ requestId: taken.requestId, approvalToken: taken.approvalToken, edits: { prompt: 'un autre portrait' } });
  assert.deepEqual(revised.cited, taken.cited);
  // A page that cannot be given a picture (no `previewOf`): the image as before, by its name.
  rt.previewOf = () => null;
  const plain = await rt.request(
    [{ id: 'call_2', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"portrait"}' } }],
    { conversationId: id, turnId: id, messages: [], cited: [stairs] },
  );
  assert.deepEqual(plain.cited.left, [{ id: stairs.id, label: '#ref2', reference: 2 }]);
});

/**
 * A series of images asked in the Chat (one call of create_image with `series`) with the local chat
 * model: what the chat engine and the generator are asked, in their order (`order`: stop and start
 * of the model; run, keep — its models left loaded — and free of the generator). `idle`: how long
 * the runtime waits for a next image; `run`: what the generator answers to a job.
 */
function seriesFixture({ idle = 60000, local, runs = [], run = async () => ({ outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] }) } = {}) {
  const order = [];
  const workflow = nativeWorkflow({ id: 'wf', name: 'Images', digest: 'one' });
  const engine = {
    state: 'ready',
    busy: false,
    ...(local === undefined ? {} : { local }),
    async stop() {
      order.push('stop');
      engine.state = 'stopped';
    },
    async start() {
      order.push('start');
      engine.state = 'ready';
    },
  };
  const client = {
    status: async () => ({ idle: true }),
    preflight: async () => {},
    run: async job => {
      order.push('run');
      return run(job);
    },
    free: async options => {
      order.push(options?.keep ? 'keep' : 'free');
      return { kept: options?.keep === true };
    },
  };
  const rt = new ToolRuntime({
    engine,
    catalog: { list: async () => [workflow], read: async () => workflow, prepare: async () => nativePrepared(workflow) },
    gallery: { put: async record => record, list: async () => ({ runs }) },
    getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 50 }),
    engineConfig: () => ({}),
    clientFactory: () => client,
    seriesIdleMs: idle,
  });
  const ask = (count = 3, options = {}) =>
    rt.request(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'create_image',
            arguments: JSON.stringify({ prompt: 'image 1', series: Array.from({ length: count - 1 }, (_, at) => 'image ' + (at + 2)) }),
          },
        },
      ],
      { conversationId: id, turnId: id, messages: [], ...options },
    );
  /** An image run to its end, as the page does: its job. */
  const make = async (proposal, options = {}) => {
    await rt.execute({ requestId: proposal.requestId, permission: 'once', ...options });
    await rt.finished;
    return rt.job;
  };
  const until = async check => {
    for (let tries = 0; tries < 200 && !check(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), 'attendu en vain');
  };
  return { rt, engine, order, ask, make, until };
}

test('between two images of a series the chat model stays out and the generator keeps its models: loaded again once, after the last', async () => {
  const { rt, engine, order, ask, make } = seriesFixture();
  const first = await ask(3);
  assert.equal((await make(first)).state, 'done');
  // Not loaded to be unloaded at once for the next image; the generator was told to keep its models.
  assert.deepEqual(order, ['stop', 'run', 'keep']);
  assert.deepEqual([engine.state, rt.active], ['stopped', false]);
  const second = await rt.next({ series: first.series.id });
  assert.equal((await make(second)).state, 'done');
  assert.deepEqual(order.slice(3), ['stop', 'run', 'keep']);
  assert.equal(engine.state, 'stopped');
  // The last image hands the card back as any creation: the generator freed, the model started.
  const third = await rt.next({ series: first.series.id });
  const job = await make(third);
  assert.deepEqual([job.state, job.progress], ['done', 'Image prête pour vérification.']);
  assert.deepEqual(order.slice(6), ['stop', 'run', 'free', 'free', 'start']);
  assert.equal(order.filter(step => step === 'start').length, 1, 'one reload for three images');
  assert.deepEqual([engine.state, rt.owed, rt.series.size], ['ready', null, 0]);
  // (A single image, as before: unloaded, made, freed, loaded again.)
  const single = seriesFixture();
  const alone = await single.rt.request(
    [{ id: 'call_2', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"seule"}' } }],
    { conversationId: id, turnId: id, messages: [] },
  );
  await single.make(alone);
  assert.deepEqual(single.order, ['stop', 'run', 'free', 'start']);
});

test('a series that stops before its last image gives the chat model back at once: an image failed, the page’s word, a proposal let go', async () => {
  // An image that fails hands the card back itself, as any creation that failed.
  let runs = 0;
  const failing = seriesFixture({
    run: async () => {
      if (++runs === 2) throw Error('Mémoire vidéo insuffisante');
      return { outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] };
    },
  });
  const first = await failing.ask(3);
  await failing.make(first);
  const failed = await failing.make(await failing.rt.next({ series: first.series.id }));
  assert.equal(failed.state, 'error');
  assert.deepEqual(failing.order.slice(3), ['stop', 'run', 'free', 'free', 'start']);
  assert.deepEqual([failing.engine.state, failing.rt.owed], ['ready', null]);
  // The page then says the series is over: its prompts are let go, nothing is started twice.
  assert.deepEqual(await failing.rt.endSeries({ series: first.series.id }), { ended: true });
  assert.equal(failing.rt.series.size, 0);
  assert.equal(failing.order.filter(step => step === 'start').length, 1);
  await assert.rejects(failing.rt.next({ series: first.series.id }), /terminée/);

  // Stopped between two images (the user's stop, an image refused): the page says so, and its
  // answer comes once the model is back.
  const stopped = seriesFixture();
  const begun = await stopped.ask(4);
  await stopped.make(begun);
  assert.equal(stopped.engine.state, 'stopped');
  assert.deepEqual(await stopped.rt.endSeries({ series: begun.series.id }), { ended: true });
  assert.deepEqual(stopped.order.slice(3), ['free', 'start']);
  assert.deepEqual([stopped.engine.state, stopped.rt.owed, stopped.rt.series.size], ['ready', null, 0]);
  // Said twice, or of a series that is not known: nothing more.
  assert.deepEqual(await stopped.rt.endSeries({ series: begun.series.id }), { ended: false });
  assert.deepEqual(await stopped.rt.endSeries({}), { ended: false });
  assert.equal(stopped.order.filter(step => step === 'start').length, 1);

  // The proposal of its next image let go (refused in the Studio): the same.
  const refused = seriesFixture();
  const opened = await refused.ask(3);
  await refused.make(opened);
  const next = await refused.rt.next({ series: opened.series.id });
  refused.rt.cancel({ requestId: next.requestId });
  await refused.until(() => refused.engine.state === 'ready');
  assert.deepEqual([refused.rt.owed, refused.rt.series.size], [null, 0]);

  // The first proposal let go before anything ran (left out for an image the user named): its
  // prompts and the conversation kept with them are not held for hours.
  const unused = seriesFixture();
  const proposed = await unused.ask(3);
  assert.equal(unused.rt.series.size, 1);
  unused.rt.cancel({ requestId: proposed.requestId });
  assert.equal(unused.rt.series.size, 0);
  assert.deepEqual(unused.order, []);
});

test('a page gone in the middle of a series does not leave the application without its chat model', async () => {
  const { rt, engine, order, ask, make, until } = seriesFixture({ idle: 30 });
  const first = await ask(3);
  await make(first);
  assert.equal(engine.state, 'stopped');
  // No next image, no word of the page: after a while the model comes back by itself.
  await until(() => engine.state === 'ready');
  assert.deepEqual(order.slice(3), ['free', 'start']);
  assert.equal(rt.owed, null);
  // The page was only slow: its series goes on, each image an ordinary creation again.
  const second = await rt.next({ series: first.series.id });
  assert.equal((await make(second)).state, 'done');
  assert.deepEqual(order.slice(5), ['stop', 'run', 'keep']);
  // The model started meanwhile by a message of the user is not started a second time.
  engine.state = 'ready';
  await until(() => rt.owed === null);
  assert.equal(order.filter(step => step === 'start').length, 1);
  // Closing with a series left midway: nothing is started behind the application.
  const closing = seriesFixture({ idle: 20 });
  const begun = await closing.ask(3);
  await closing.make(begun);
  await closing.rt.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(closing.order.includes('start'), false);
});

test('a take asked in the Bobine keeps its place there: with its job, for a page that follows it again, and with the take made (0.6.181)', async () => {
  // (Audit of 21/11, A5: the page reloaded while a take of the Bobine is made; the take stayed « à créer ».)
  const place = { id: '0a0a0a0a-0000-4000-8000-000000000001', plan: '0a0a0a0a-0000-4000-8000-000000000002', from: 5.042 };
  const made = async options => {
    let running = null;
    const fixture = seriesFixture({
      run: async () => {
        running = fixture.rt.status({ view: true });
        return { outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] };
      },
    });
    const job = await fixture.make(await fixture.ask(2), options);
    return [job.state, running.proposal.bobine, job.record.bobine];
  };
  // Said with the go of the Studio: on what a page draws its card with, and in the record of the take.
  assert.deepEqual(await made({ studio: true, bobine: { ...place, other: 'x' } }), ['done', place, place]);
  // Not for a creation of the Chat, nor a place that cannot be read: its take is made all the same.
  for (const options of [{ bobine: place }, { studio: true }, { studio: true, bobine: { ...place, id: 'm1' } }])
    assert.deepEqual(await made(options), ['done', undefined, undefined]);
});

test('a series made in the Studio or with a remote chat model keeps its hand-back: nothing is owed', async () => {
  // From the Studio the chat model stays unloaded anyway, and comes back with the next message.
  const studio = seriesFixture({ idle: 20 });
  const first = await studio.ask(2);
  await studio.make(first, { studio: true });
  assert.deepEqual([studio.order, studio.rt.owed], [['stop', 'run', 'keep'], null]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(studio.order.includes('start'), false);
  // A remote model holds nothing on the card: never stopped, never started.
  const remote = seriesFixture({ idle: 20, local: false });
  const begun = await remote.ask(2);
  await remote.make(begun);
  await remote.make(await remote.rt.next({ series: begun.series.id }));
  assert.deepEqual([remote.order, remote.rt.owed], [['run', 'keep', 'run', 'keep'], null]);
});

test('a failed creation made again by itself is no longer an image of its series', async () => {
  let runs = 0;
  const { rt, order, ask, make } = seriesFixture({
    run: async () => {
      if (++runs === 1) throw Error('échec');
      return { outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] };
    },
  });
  const first = await ask(3);
  assert.equal((await make(first)).state, 'error');
  // « Relancer » on the first image, its series still known to the server: an ordinary creation,
  // the chat model loaded again after it (it was left out, with no next image to bring it back).
  const again = await rt.again({ requestId: first.requestId });
  assert.equal(again.series, undefined);
  // A call of its own (0.6.86): the conversation keeps both, each with its result; one identifier
  // for both gave the take of a reload to the call that failed (take-recovery.mjs).
  assert.notEqual(again.call.id, first.call.id);
  assert.match(again.call.id, /^call_[0-9a-f]{24}$/);
  // Its call no longer names the other images either (0.6.87): reloaded during it, a page waited
  // for as many takes as the series had.
  assert.equal(again.call.function.name, first.call.function.name);
  const { series: others, ...rest } = JSON.parse(first.call.function.arguments);
  assert.ok(others?.length, 'the first image named the others');
  assert.deepEqual(JSON.parse(again.call.function.arguments), rest);
  assert.equal((await make(again)).state, 'done');
  assert.deepEqual(order.slice(-4), ['stop', 'run', 'free', 'start']);
  assert.equal(rt.owed, null);
});

test('a call gets an identifier of its own in its conversation when a service gives each the same one (0.6.87)', async () => {
  // « functions.create_image:0 » in each answer (made « functions_create_image_0 » by the chat): the
  // take of a page reloaded meanwhile went to the first call of that identifier, and Claude refuses
  // two calls of one identifier.
  const { rt, ask, make } = seriesFixture();
  const before = [
    { role: 'user', content: 'Un phare' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"un phare"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '{"status":"success"}' },
    { role: 'user', content: 'Un autre' },
  ];
  const again = await ask(2, { messages: before });
  assert.notEqual(again.call.id, 'call_1');
  assert.match(again.call.id, /^call_[0-9a-f]{24}$/);
  // Made, its take and its job say the call the conversation keeps.
  const job = await make(again);
  assert.equal(job.callId, again.call.id);
  // A first call keeps the one it came with.
  const fresh = await ask(2, { messages: [{ role: 'user', content: 'Un phare' }] });
  assert.equal(fresh.call.id, 'call_1');
  assert.equal(rt.job.callId, again.call.id);
});

test('a call gets an identifier of its own against the takes of its conversation too, its call taken back meanwhile (0.6.88)', async () => {
  // « Régénérer » or « Modifier » takes the call out of the messages, not its takes out of the
  // Pellicule: the identifier given again went to those takes.
  const { ask } = seriesFixture({ runs: [{ id: 'run-1', callId: 'call_1' }] });
  const again = await ask(2, { messages: [{ role: 'user', content: 'Un phare' }] });
  assert.match(again.call.id, /^call_[0-9a-f]{24}$/);
  // A take of another call: it keeps its own.
  const other = seriesFixture({ runs: [{ id: 'run-2', callId: 'call_9' }] });
  assert.equal((await other.ask(2, { messages: [{ role: 'user', content: 'Un phare' }] })).call.id, 'call_1');
});

test('a proposal changed on its card is kept when what it says of a named image cannot be read (0.6.310)', async () => {
  const workflow = { id: 'w', name: 'LTX 2.5', digest: 'd', pipeline: 'ltx25', mediaType: 'video', references: [], parameters: { prompt: { policy: 'model' } }, profiles: {} },
    job = () => ({ workflow, job: { parameters: { prompt: 'p', width: 768, height: 432 } } });
  // The list of the workflows refused for a moment (Windows, a file being written), then read again.
  let refused = true;
  const catalog = {
    read: async () => workflow,
    prepare: async () => job(),
    list: async () => {
      if (refused) throw Object.assign(new Error('EPERM: operation not permitted, open workflow.json'), { code: 'EPERM' });
      return [workflow];
    },
  };
  const runtime = new ToolRuntime({ engine: {}, catalog, gallery: {}, resources: {}, getConfig: () => ({ enabled: true }), clientFactory: () => ({}) });
  const requestId = crypto.randomUUID(),
    approvalToken = crypto.randomUUID();
  runtime.pending.set(requestId, {
    created: Date.now(),
    approvalToken,
    digest: 'd',
    media: 'video',
    conversationId: crypto.randomUUID(),
    args: { workflow_id: 'w', prompt: 'p' },
    approvalArgs: { prompt: 'p' },
    call: { id: 'call_1', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    references: [],
    prepared: job(),
    overrides: {},
    notes: [],
    // The user named #ref2, which the proposal leaves out: what it says of it reads the list of the workflows.
    cited: [{ id: crypto.randomUUID(), label: '#ref2', reference: 2 }],
  });
  await assert.rejects(runtime.revise({ requestId, approvalToken, edits: { prompt: 'p, plus lent' } }), /EPERM/);
  // The proposal was given up before that reading: « Générer » then said « Cet appel a expiré. Relancez la
  // demande. », and the user had to ask again.
  assert.equal(runtime.pending.has(requestId), true);
  assert.equal(runtime.pending.get(requestId).approvalToken, approvalToken);
  // The same change, the list read again: the proposal is replaced by its new one, once.
  refused = false;
  const revised = await runtime.revise({ requestId, approvalToken, edits: { prompt: 'p, plus lent' } });
  assert.equal(runtime.pending.has(requestId), false);
  assert.equal(runtime.pending.size, 1);
  assert.equal(runtime.pending.has(revised.requestId), true);
});

test('a creation stopped while the engine is checked is said stopped, not failed in the words of the runtime (0.6.314)', async () => {
  const { rt, client, request } = runtimeFixture();
  // The generation engine that starts (cold, some sixteen seconds): it waits, and lets go when stopped.
  client.status = ({ signal }) => new Promise((_yes, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }));
  const proposal = await request(),
    executing = rt.execute({ requestId: proposal.requestId, permission: 'once' });
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(rt.status().state, 'checking');
    rt.cancel({ requestId: proposal.requestId });
    // The page that stopped it is answered as before (it says the stop itself).
    await assert.rejects(executing, { name: 'AbortError' });
    // Another tab, or the page reloaded, reads the take here: it read « error » and « This operation was
    // aborted ». As a creation stopped once it runs (run()).
    const after = rt.status();
    assert.deepEqual([after.state, after.error], ['cancelled', 'Génération arrêtée.']);
    // What fails there without being stopped is still an error, in its own words.
    client.status = async () => ({ idle: false });
    const second = await request();
    await assert.rejects(rt.execute({ requestId: second.requestId, permission: 'once' }), { status: 409 });
    const failed = rt.status();
    assert.deepEqual([failed.state, failed.error], ['error', 'Le moteur de génération exécute déjà une tâche. Attendez sa fin.']);
  } finally {
    await rt.close();
  }
});


test('a take the history could not keep is said by what it is: an image, a video, a sound (0.6.402)', async () => {
  // « Historique de l'image non enregistré » was said of a video and of a sound too.
  const said = { image: 'de l’image', video: 'de la vidéo', audio: 'du son' };
  for (const [media, words] of Object.entries(said)) {
    const workflow = nativeWorkflow({ digest: '1', name: 'wf' }),
      // The chat model, stopped for the creation and loaded again after it.
      engine = {
        state: 'ready',
        busy: false,
        stop: async () => void (engine.state = 'stopped'),
        start: async () => void (engine.state = 'ready'),
      },
      rt = new ToolRuntime({
        engine,
        catalog: {
          list: async () => [workflow],
          read: async () => workflow,
          prepare: async () => nativePrepared(workflow),
        },
        // The disk refuses the history; the take is kept for this session all the same.
        gallery: {
          put: async (record, { persist }) => {
            if (persist) throw Error('Disque plein.');
            return record;
          },
        },
        persist: () => true,
        getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 3 }),
        engineConfig: () => ({}),
        clientFactory: () => ({
          status: async () => ({ idle: true }),
          preflight: async () => {},
          run: async () => ({ outputs: [{ filename: 'x.bin', subfolder: '', type: 'output' }] }),
          free: async () => {},
        }),
      });
    const call = { name: 'create_image', arguments: JSON.stringify({ prompt: 'a fox' }) },
      pending = await rt.request([{ id: 'c', type: 'function', function: call }], {
        conversationId: id,
        turnId: id,
        messages: [],
      });
    // (What the proposal makes, as its workflow says it: the families of the videos and of the sounds ask
    // for more than this test gives.)
    const proposal = rt.pending.get(pending.requestId);
    proposal.media = media;
    // (A video or a sound starts only on the user's own go to that proposal.)
    await rt.execute({ requestId: pending.requestId, permission: 'once', approvalToken: proposal.approvalToken });
    await rt.finished;
    assert.equal(rt.job.state, 'done', rt.job.error);
    assert.equal(
      rt.job.warning,
      `Historique ${words} non enregistré : Disque plein. Les liens restent disponibles dans cette session.`,
    );
  }
});


test('a creation of a conversation erased cannot be made again from a page left open (0.6.403)', async () => {
  // « Relancer », left in another tab on a conversation erased since, made a take in a folder no conversation
  // owns any more.
  const other = 'b2222222-2222-4222-8222-222222222222',
    failing = () => seriesFixture({ run: async () => Promise.reject(Error('échec')) });
  // Its conversation erased: no longer made again. That of another conversation still is.
  let { rt, ask, make } = failing();
  const mine = await ask(2),
    theirs = await ask(2, { conversationId: other, turnId: other });
  assert.equal((await make(mine)).state, 'error');
  assert.equal((await make(theirs)).state, 'error');
  rt.forgetConversation(id);
  await assert.rejects(rt.again({ requestId: mine.requestId }), /ne peut plus être relancée/);
  assert.equal((await rt.again({ requestId: theirs.requestId })).call.function.name, 'create_image');
  // The whole history erased: none of them.
  ({ rt, ask, make } = failing());
  const last = await ask(2);
  assert.equal((await make(last)).state, 'error');
  rt.clear();
  await assert.rejects(rt.again({ requestId: last.requestId }), /ne peut plus être relancée/);
});


test('the model of an enlargement or of an interpolation that loads is said so (0.6.412)', async () => {
  // Real-ESRGAN and RIFE said « state: 'loading' », which nothing reads: « Génération de l'image… » stayed
  // while their model loaded. SeedVR2 said its stage, which had no words.
  const workflow = nativeWorkflow({ digest: '1', name: 'wf' }),
    labels = [],
    engine = {
      state: 'ready',
      busy: false,
      stop: async () => void (engine.state = 'stopped'),
      start: async () => void (engine.state = 'ready'),
    },
    rt = new ToolRuntime({
      engine,
      catalog: { list: async () => [workflow], read: async () => workflow, prepare: async () => nativePrepared(workflow) },
      gallery: { put: async record => record },
      getConfig: () => ({ enabled: true, autoAllow: true, maxIterations: 3 }),
      engineConfig: () => ({}),
      clientFactory: () => ({
        status: async () => ({ idle: true }),
        preflight: async () => {},
        run: async (_job, { onProgress }) => {
          for (const stage of ['loading upscaler', 'loading interpolator']) {
            onProgress({ stage });
            labels.push(rt.job.progress);
          }
          return { outputs: [{ filename: 'x.png', subfolder: '', type: 'output' }] };
        },
        free: async () => {},
      }),
    });
  const call = { name: 'create_image', arguments: JSON.stringify({ prompt: 'a fox' }) },
    pending = await rt.request([{ id: 'c', type: 'function', function: call }], {
      conversationId: id,
      turnId: id,
      messages: [],
    });
  await rt.execute({ requestId: pending.requestId });
  await rt.finished;
  assert.deepEqual(labels, ['Chargement du modèle d’agrandissement…', 'Chargement du modèle d’interpolation…']);
});
