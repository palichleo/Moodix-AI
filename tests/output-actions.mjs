import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { outputActions } from '../public/output-actions.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';

class Element {
  constructor(tag, className = '', text) {
    this.tag = tag;
    this.className = className;
    this.textContent = text ?? '';
    this.children = [];
    this.attributes = {};
  }
  append(...children) {
    this.children.push(...children);
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(type, listener) {
    (this.listeners ??= {})[type] = listener;
  }
}
const node = (tag, className, text) => new Element(tag, className, text);
globalThis.document ??= { createElementNS: (_ns, tag) => new Element(tag) };
const label = button => button.children.find(child => child.tag === 'span').textContent;

test('the same actions on a take everywhere: icons only, their name and help under the pointer (reference-maquettes.md)', async () => {
  const calls = [];
  const actions = outputActions({
    api: async route => {
      assert.equal(route, 'tools/actions');
      return Response.json({ upscale: ['video'], interpolate: ['video'], extend_video: [], refilm_video: ['video'], animate: ['image'] });
    },
    node,
    onDetails: (...args) => calls.push(['details', ...args]),
    onAction: (...args) => calls.push(args.slice(1)),
    onShow: (...args) => calls.push(['studio', ...args]),
  });
  const video = { id: 'run', mediaType: 'video' },
    image = { id: 'still' },
    sound = { id: 'sound', mediaType: 'audio' };
  const videoRow = actions(video, 0),
    imageRow = actions(image, 0);
  // Video: Ouvrir · Prolonger · Changer la caméra (0.6.240) · Interpoler · Agrandir et affiner · Afficher dans le Studio.
  assert.deepEqual(videoRow.children.map(label), ['Ouvrir', 'Prolonger', 'Changer la caméra', 'Interpoler', 'Agrandir et affiner', 'Afficher dans le Studio']);
  // Image: Ouvrir · Agrandir et affiner · Animer · Afficher dans le Studio; a sound: Ouvrir and the Studio.
  assert.deepEqual(imageRow.children.map(label), ['Ouvrir', 'Agrandir et affiner', 'Animer', 'Afficher dans le Studio']);
  assert.deepEqual(actions(sound, 0).children.map(label), ['Ouvrir', 'Afficher dans le Studio']);
  // Icons only (claude_design/icones-actions): their words under the pointer are their name too.
  assert.deepEqual(videoRow.children.map(button => button.attributes['aria-label']), [
    'Ouvrir : l’original, ses paramètres, Télécharger',
    'Prolonger : la suite de cette vidéo',
    'Changer la caméra : la même vidéo, filmée d’un autre angle',
    'Interpoler : des images en plus, un mouvement plus fluide',
    'Agrandir et affiner ce résultat',
    'Afficher dans le Studio : votre prompt et vos réglages ne changent pas',
  ]);
  assert.equal(imageRow.children[3].title, 'Afficher dans le Studio : votre prompt et vos réglages ne changent pas');
  assert.ok(
    videoRow.children.slice(1, 5).every(button => button.disabled),
    'disabled until the server answers',
  );
  await new Promise(setImmediate);
  const [details, extend, refilm, interpolate, upscale, studio] = videoRow.children;
  // (0.6.240) « Changer la caméra »: lit when a model can film a video again, and it tells its own name.
  assert.deepEqual([refilm.disabled, refilm.title], [false, 'Changer la caméra : la même vidéo, filmée d’un autre angle']);
  assert.equal(upscale.disabled, false);
  assert.equal(interpolate.disabled, false);
  assert.equal(extend.disabled, true);
  assert.match(extend.title, /^Prolonger : la suite de cette vidéo\nAucun modèle ne sait prolonger une vidéo\.$/);
  assert.equal(imageRow.children[1].disabled, true, 'no image upscaler is active');
  assert.match(imageRow.children[1].title, /agrandir une image/);
  assert.equal(imageRow.children[2].disabled, false, 'a video workflow starts from an image');
  details.onclick();
  interpolate.onclick();
  studio.onclick();
  refilm.onclick();
  imageRow.children[2].onclick();
  assert.deepEqual(calls, [
    ['details', video, 0],
    [0, 'interpolate'],
    ['studio', video, 0],
    [0, 'refilm'],
    [0, 'animate'],
  ]);
  // Without a way to show it in the Studio (in the Studio itself), that action is not offered.
  const plain = outputActions({ api: async () => Response.json({}), node, onDetails() {}, onAction() {} });
  assert.deepEqual(plain(image, 0).children.map(label), ['Ouvrir', 'Agrandir et affiner', 'Animer']);
});

test('(0.6.198) a greyed action says why in the words of the application: « modèle », « agrandir », never « workflow » nor « upscale »', async () => {
  // The application says « modèle » everywhere else (Paramètres › Modèles), and the button « Agrandir et affiner ».
  const actions = outputActions({ api: async () => Response.json({}), node, onDetails() {}, onAction() {} });
  const video = actions({ id: 'run', mediaType: 'video' }, 0),
    image = actions({ id: 'still' }, 0);
  await new Promise(setImmediate);
  const reasons = row => row.children.filter(button => button.disabled).map(button => [label(button), button.title.split('\n')[1]]);
  assert.deepEqual(reasons(video), [
    ['Prolonger', 'Aucun modèle ne sait prolonger une vidéo.'],
    ['Changer la caméra', 'Aucun modèle ne sait changer la caméra d’une vidéo.'],
    ['Interpoler', 'Aucun modèle d’interpolation actif.'],
    ['Agrandir et affiner', 'Aucun modèle ne sait agrandir une vidéo.'],
  ]);
  assert.deepEqual(reasons(image), [
    ['Agrandir et affiner', 'Aucun modèle ne sait agrandir une image.'],
    ['Animer', 'Aucun modèle vidéo ne part d’une image.'],
  ]);
});

test('a row drawn before a workflow became ready enables its button when the pointer comes back', async () => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  try {
    let image = [];
    const actions = outputActions({
      api: async () => Response.json({ upscale: image }),
      node,
      onDetails() {},
      onAction() {},
    });
    const row = actions({ id: 'still' }, 0);
    await new Promise(setImmediate);
    assert.equal(row.children[1].disabled, true);
    image = ['image'];
    mock.timers.tick(6000);
    await row.listeners.pointerenter();
    assert.equal(row.children[1].disabled, false);
    assert.doesNotMatch(row.children[1].title, /Aucun/);
  } finally {
    mock.timers.reset();
  }
});

test('the server lists which media each output button can act on', async () => {
  const workflow = (id, pipeline, mediaType, role) => ({
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType,
    parameters: {},
    components: {},
    loras: [],
    references: [{ id: 'source', role, required: true }],
  });
  const tools = new ToolCatalog({
    list: async () => [
      workflow('esrgan-video', 'realesrgan_video', 'video', 'source_video'),
      workflow('rife', 'rife', 'video', 'source_video'),
    ],
  });
  // « Animer »: none here, no video workflow starts from an image. (0.6.244) « Changer la caméra »: none either
  // without a model that films a video again.
  assert.deepEqual(await tools.actions(), { upscale: ['video'], interpolate: ['video'], extend_video: [], refilm_video: [], animate: [] });
  // With the model of « Changer la caméra » ready: its button is lit on a video.
  const filming = new ToolCatalog({ list: async () => [workflow('refilm', 'ltx25_refilm', 'video', 'refilm_source')] });
  assert.deepEqual(await filming.actions(), { upscale: [], interpolate: [], extend_video: [], refilm_video: ['video'], animate: [] });
});

test('an image upscale goes to SeedVR2 before Real-ESRGAN unless the model names a workflow', async () => {
  const workflow = (id, pipeline) => ({
    id,
    name: id,
    description: id,
    enabled: true,
    ready: true,
    pipeline,
    mediaType: 'image',
    parameters: {},
    components: {},
    loras: [],
    references: [{ id: 'source', role: 'source_image', required: true }],
  });
  const tools = new ToolCatalog({
    list: async () => [workflow('esrgan', 'realesrgan_image'), workflow('seedvr2', 'seedvr2')],
  });
  const media = { mediaOf: async () => 'image' };
  const route = args => tools.route('upscale', { source: { image: 0 }, ...args }, media);
  assert.equal((await route({})).workflow.id, 'seedvr2');
  assert.equal((await route({ workflow: 'esrgan' })).workflow.id, 'esrgan');
});

test('an image upscale proposal drops the intention a video would show', async () => {
  const tools = new ToolCatalog({
    list: async () => [
      {
        id: 'seedvr2',
        name: 'seedvr2',
        description: 'seedvr2',
        enabled: true,
        ready: true,
        pipeline: 'seedvr2',
        mediaType: 'image',
        parameters: {},
        components: {},
        loras: [],
        references: [{ id: 'source', role: 'source_image', required: true }],
      },
    ],
  });
  const routed = await tools.route(
    'upscale',
    { source: { image: 0 }, intention: 'Agrandir l’image.' },
    { mediaOf: async () => 'image' },
  );
  assert.equal(routed.args.intention, undefined);
});
