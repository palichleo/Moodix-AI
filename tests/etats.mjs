import assert from 'node:assert/strict';
import test from 'node:test';
import { setupFirstLaunch } from '../public/first-launch.mjs';
import { missingFileCard, roomText, sizeText } from '../public/missing-file.mjs';
import { ToolCatalog } from '../lib/tool-catalog.mjs';
import { preparationBytes } from '../lib/python-environment.mjs';

// (0.6.506) The engine of a new installation as the server says it on Windows (measured on 27/11): « 2,1 Go ».
const ENGINE = preparationBytes('win32');

// The states of etats-maquette.md (16/11): the first launch (50), a missing file (53).
class Element {
  constructor(tag = '', className = '', text = '') {
    Object.assign(this, { tag, className, textContent: text, children: [], parent: null, attributes: {}, style: {} });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  append(...items) {
    for (const item of items) {
      if (typeof item !== 'object') continue;
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  get isConnected() {
    return Boolean(this.parent);
  }
}
const node = (...args) => new Element(...args);
const icon = glyph => Object.assign(new Element('svg'), { glyph });
const under = root => [root, ...root.children.flatMap(child => under(child))];
const find = (root, name) => under(root).filter(item => String(item.className).split(' ').includes(name));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('50 · before the first message: the engine, then the LLM; both done, the message box comes back', async () => {
  let config = { enginePath: '', modelPath: '' };
  const host = new Element('section'),
    asked = [],
    jobs = [
      { state: 'idle' },
      { state: 'downloading', received: 64, total: 100 },
      { state: 'done', result: { enginePath: 'C:/llama/llama-server.exe' } },
    ];
  let done = 0;
  const answers = {
    llama: () => jobs.shift() ?? { state: 'done', result: { enginePath: 'C:/llama/llama-server.exe' } },
    'llama/check': () => ({ tag: 'b12359', candidates: [{ label: 'CUDA 13.5', size: 578 * 1048576 }] }),
    'llama/install': () => ({}),
    'files/choose': () => ({ path: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf' }),
    'models/add': body => ({ profile: { id: 'q', ...body }, models: [{ id: 'q' }] }),
    'models/select': () => ({ config: { ...config, modelPath: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf' } }),
  };
  const card = setupFirstLaunch({
    api: async (route, body) => {
      asked.push([route, body]);
      return { json: async () => answers[route](body) };
    },
    node,
    icon,
    host,
    config: () => config,
    onConfig: next => {
      config = next;
      card.sync(!(config.enginePath && config.modelPath));
    },
    onDone: () => done++,
  });
  card.sync(true);
  await settle();
  await settle();
  assert.equal(find(host, 'setup-kicker')[0].textContent, 'Avant le premier message');
  assert.equal(find(host, 'setup-count')[0].textContent, '0 / 2');
  const [engine, llm] = find(host, 'setup-text').map(item => item.textContent);
  assert.equal(
    engine,
    'llama-server fait tourner Moodix AI sur cet ordinateur. La version officielle pour votre carte : b12359 · CUDA 13.5 · 578 Mo.',
  );
  assert.match(llm, /^Un fichier GGUF sur cet ordinateur/);
  assert.equal(find(host, 'setup-foot')[0].textContent, 'Les images, les vidéos et les sons se règlent ensuite, dans Paramètres › Modèles.');
  // « Installer »: « TÉLÉCHARGEMENT · 64 % », the step ringed, then done.
  const install = find(host, 'setup-install')[0];
  const installing = install.onclick();
  await settle();
  await settle();
  await settle();
  assert.deepEqual(
    find(host, 'setup-progress-head')[0].children.map(item => item.textContent),
    ['Téléchargement', '64 %'],
  );
  assert.equal(find(host, 'is-current').length, 1);
  await new Promise(resolve => setTimeout(resolve, 900));
  await installing;
  assert.equal(config.enginePath, 'C:/llama/llama-server.exe');
  assert.equal(find(host, 'setup-count')[0].textContent, '1 / 2');
  assert.equal(done, 0, 'the LLM is still to choose');
  // The LLM: a file of this computer, registered and chosen; both done, the card goes.
  await find(host, 'setup-model')[0].onclick();
  await settle();
  assert.deepEqual(
    asked.find(([route]) => route === 'models/add')[1],
    { name: 'Qwen3.5-9B-Instruct-Q5_K_M', modelPath: 'D:/Modeles/Qwen3.5-9B-Instruct-Q5_K_M.gguf', projectorPath: '' },
  );
  assert.equal(host.hidden, true);
  assert.equal(done, 1, 'the model loads');
});

test('53 · a missing file: its card, the download as it goes, « Arrêter », and the request again once it is there', async () => {
  const host = new Element('div'),
    asked = [];
  let ready = 0;
  const jobs = [
    { job: { state: 'idle' } },
    { job: { state: 'running', workflowId: 'wan-scail2', received: 3.4 * 1024 ** 3, total: 28.6 * 1024 ** 3 } },
    { job: { state: 'done', workflowId: 'wan-scail2', received: 28.6 * 1024 ** 3, total: 28.6 * 1024 ** 3 } },
  ];
  const request = {
    requestId: 'r',
    tool: 'replace_character',
    workflowName: 'Wan SCAIL 2',
    mediaType: 'video',
    missing: {
      workflowId: 'wan-scail2',
      files: [{ file: 'wan2.2_scail_14B.safetensors', size: 28.6 * 1024 ** 3 }],
      bytes: 28.6 * 1024 ** 3,
      left: 28.6 * 1024 ** 3,
    },
  };
  const card = missingFileCard({
    host,
    request,
    node,
    icon,
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'downloads/start'
            ? { state: 'running', workflowId: 'wan-scail2', received: 0, total: 28.6 * 1024 ** 3 }
            : route === 'downloads'
              ? (jobs.shift() ?? jobs.at(-1))
              : {},
      };
    },
    onReady: () => ++ready > 0,
    wait: () => settle(),
  });
  await settle();
  assert.equal(find(host, 'missing-head')[0].textContent, 'Il manque un fichier · Vidéo · Wan SCAIL 2');
  assert.deepEqual(
    find(host, 'missing-file')[0].children.map(item => item.textContent),
    ['', 'wan2.2_scail_14B.safetensors', '28,6 Go'],
  );
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 28,6 Go');
  await card.start();
  assert.deepEqual(asked.find(([route]) => route === 'downloads/start')[1], { id: 'wan-scail2' });
  assert.equal(ready, 1, 'the request goes again');
  assert.equal(find(host, 'missing-done')[0].textContent, 'Le fichier est là. Je reprends votre demande…');
  assert.equal(sizeText(3.4 * 1024 ** 3), '3,4 Go');
  // Written in the conversation meanwhile: not sent on its own; « Reprendre la demande ».
  const later = new Element('div'),
    resumed = [];
  let polls = 0;
  const waiting = missingFileCard({
    host: later,
    request,
    node,
    icon,
    api: async route => ({
      json: async () =>
        route === 'downloads'
          ? { job: ++polls > 1 ? { state: 'done', workflowId: 'wan-scail2' } : { state: 'idle' } }
          : { state: 'running', workflowId: 'wan-scail2', received: 0, total: 1 },
    }),
    onReady: () => false,
    onResume: () => resumed.push(true),
    wait: () => settle(),
  });
  await settle();
  await waiting.start();
  assert.equal(find(later, 'missing-done')[0].textContent, 'Wan SCAIL 2 est prêt');
  const resume = find(later, 'missing-go')[0];
  assert.equal(resume.children.at(-1).textContent, 'Reprendre la demande');
  resume.onclick();
  assert.deepEqual(resumed, [true]);
  // « Annuler » leaves its line, as a proposal does.
  card.cancel();
  assert.deepEqual(
    host.children.map(child => [child.className, child.textContent]),
    [['proposal-cancelled', 'Proposition annulée.']],
  );
});

test('(0.6.479) 53 · a new installation: the engine comes with the file, in its size, said as prepared', async () => {
  const GIB = 1024 ** 3,
    total = 20 * GIB + ENGINE,
    host = new Element('div'),
    jobs = [
      { job: { state: 'idle' } },
      { job: { state: 'running', workflowId: 'qwen', engine: 'preparing', current: 'Préparation du moteur' } },
      { job: { state: 'cancelled', workflowId: 'qwen', engine: 'preparing', received: 20 * GIB, total } },
    ];
  Object.assign(jobs[1].job, { received: 20 * GIB, total });
  const card = missingFileCard({
    host,
    request: {
      requestId: 'r',
      tool: 'edit_image',
      workflowName: 'Qwen-Image-Edit',
      missing: {
        workflowId: 'qwen',
        files: [{ file: 'qwen_image_edit_2511.safetensors', size: 20 * GIB }],
        bytes: 20 * GIB,
        left: 20 * GIB,
        engine: { bytes: ENGINE },
      },
    },
    node,
    icon,
    api: async route => ({
      json: async () =>
        route === 'downloads/start'
          ? { state: 'running', workflowId: 'qwen', engine: 'waiting', received: 0, total }
          : (jobs.shift() ?? jobs.at(-1)),
    }),
    wait: async () => {
      await settle();
      // What it says while the engine is prepared, under its line.
      said.push(find(host, 'missing-wait')[0]?.textContent ?? '');
    },
  });
  const said = [];
  await settle();
  // The size of the whole on its button; the engine said under the files.
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 22,1 Go');
  assert.match(
    find(host, 'missing-note')[0].textContent,
    / Le moteur de génération de Moodix se télécharge avec : environ 2,1 Go, une seule fois pour tous les modèles\.$/,
  );
  await card.start();
  assert.ok(said.includes('Préparation du moteur de génération : quelques minutes, une seule fois.'), said.join(' | '));
  // Stopped while the engine was prepared: its files are there, the engine is what is left.
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 2,1 Go');
});

test('(0.6.479) 53 · its files all here, on a new installation: the engine alone, said as such', async () => {
  // Qwen-Image-Edit downloaded on a new installation (27/11): the chat answered « Moteur de génération arrêté. ».
  const GIB = 1024 ** 3,
    host = new Element('div'),
    asked = [];
  const card = missingFileCard({
    host,
    request: {
      requestId: 'r',
      tool: 'edit_image',
      workflowName: 'Qwen-Image-Edit',
      missing: { workflowId: 'qwen', files: [], bytes: 0, left: 0, engine: { bytes: ENGINE } },
    },
    node,
    icon,
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'downloads/start'
            ? { state: 'running', workflowId: 'qwen', engine: 'preparing', received: 0, total: ENGINE }
            : { job: asked.length > 2 ? { state: 'done', workflowId: 'qwen', engine: 'ready' } : { state: 'idle' } },
      };
    },
    onReady: () => true,
    wait: () => settle(),
  });
  await settle();
  assert.equal(card.card.attributes['aria-label'], 'Il manque le moteur de génération');
  assert.equal(
    find(host, 'missing-head')[0].textContent,
    'Il manque le moteur de génération · Image · Qwen-Image-Edit',
  );
  assert.deepEqual(
    find(host, 'missing-file').map(item => item.children.map(part => part.textContent)),
    [['', 'Moteur de génération de Moodix', '2,1 Go']],
  );
  assert.equal(
    find(host, 'missing-note')[0].textContent,
    'Les fichiers sont là : il manque le moteur de génération de Moodix, environ 2,1 Go, ' +
      'installé une seule fois pour tous les modèles.',
  );
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 2,1 Go');
  await card.start();
  assert.deepEqual(asked.find(([route]) => route === 'downloads/start')[1], { id: 'qwen' });
  assert.equal(find(host, 'missing-done')[0].textContent, 'Le moteur est prêt. Je reprends votre demande…');
});

test('(0.6.479) 53 · behind a Hugging Face account: the model named, its token, its engine', async () => {
  // LTX 2.5 on a new installation: « Ce fichier demande un compte » under six files, and « Télécharger · 41,2 Go »
  // where its files made 38,2 Go, the engine said nowhere.
  const GIB = 1024 ** 3,
    host = new Element('div');
  missingFileCard({
    host,
    request: {
      requestId: 'r',
      tool: 'create_video',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      missing: {
        workflowId: 'ltx',
        files: [{ file: 'ltx-2.5.safetensors', size: 20 * GIB }],
        bytes: 20 * GIB,
        left: 20 * GIB,
        needsToken: true,
        page: 'huggingface.co/Lightricks/LTX-2.5',
        engine: { bytes: ENGINE },
      },
    },
    node,
    icon,
    api: async () => ({ json: async () => ({ job: { state: 'idle' } }) }),
    wait: () => settle(),
  });
  await settle();
  assert.equal(
    find(host, 'missing-note')[0].textContent,
    'LTX 2.5 demande un compte Hugging Face : acceptez la licence sur huggingface.co/Lightricks/LTX-2.5 avec ce ' +
      'compte, créez un jeton de lecture sur huggingface.co/settings/tokens, puis enregistrez votre jeton dans ' +
      'Paramètres › Modèles › Fichiers. Le moteur de génération de Moodix se télécharge avec : environ 2,1 Go, ' +
      'une seule fois pour tous les modèles.',
  );
  assert.equal(find(host, 'missing-go')[0].children.at(-1).textContent, 'Télécharger · 22,1 Go');
});

test('(0.6.479) 53 · no token yet: « Télécharger » greyed, why in its bubble, back once one is saved', async () => {
  // (Decision of 27/11: pressed, the server refused it, and said so in red under the card.)
  const GIB = 1024 ** 3,
    before = globalThis.document,
    events = new EventTarget(),
    account =
      'LTX 2.5 demande un compte Hugging Face : acceptez la licence sur huggingface.co/Lightricks/LTX-2.5 avec ce ' +
      'compte, créez un jeton de lecture sur huggingface.co/settings/tokens, puis enregistrez votre jeton dans ' +
      'Paramètres › Modèles › Fichiers.',
    request = () => ({
      requestId: 'r',
      tool: 'create_video',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      missing: {
        workflowId: 'ltx',
        files: [{ file: 'ltx-2.5.safetensors', size: 20 * GIB }],
        bytes: 20 * GIB,
        left: 20 * GIB,
        needsToken: true,
        page: 'huggingface.co/Lightricks/LTX-2.5',
      },
    });
  globalThis.document = events;
  try {
    const host = new Element('div'),
      asked = [];
    const card = missingFileCard({
      host,
      request: request(),
      node,
      icon,
      api: async route => {
        asked.push(route);
        return { json: async () => ({ job: { state: 'idle' }, hasToken: false }) };
      },
      wait: () => settle(),
    });
    await settle();
    const go = () => find(host, 'missing-go')[0];
    assert.deepEqual([go().disabled, go().title, find(host, 'missing-note')[0].textContent], [true, account, account]);
    await card.start();
    assert.equal(asked.includes('downloads/start'), false);
    // Saved in Paramètres › Modèles › Fichiers (app.js): « Télécharger » again, the note of a download.
    events.dispatchEvent(new CustomEvent('moodix:token', { detail: { hasToken: true } }));
    assert.deepEqual([go().disabled, go().title], [undefined, undefined]);
    assert.match(find(host, 'missing-note')[0].textContent, /^Il va dans votre dossier des modèles/);
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
  // Saved before the card is drawn (a conversation opened again later): never greyed.
  const later = new Element('div');
  missingFileCard({
    host: later,
    request: request(),
    node,
    icon,
    api: async () => ({ json: async () => ({ job: { state: 'idle' }, hasToken: true }) }),
    wait: () => settle(),
  });
  await settle();
  assert.equal(find(later, 'missing-go')[0].disabled, undefined);
});

test('(0.6.479) 53 · several files: « Il manque des fichiers », and they are there once downloaded', async () => {
  const host = new Element('div');
  const card = missingFileCard({
    host,
    request: {
      requestId: 'r',
      tool: 'create_video',
      workflowName: 'LTX 2.5',
      mediaType: 'video',
      missing: {
        workflowId: 'ltx',
        files: [
          { file: 'a.safetensors', size: 5 },
          { file: 'b.safetensors', size: 5 },
        ],
        bytes: 10,
        left: 10,
      },
    },
    node,
    icon,
    api: async route => ({
      json: async () =>
        route === 'downloads/start'
          ? { state: 'running', workflowId: 'ltx', received: 0, total: 10 }
          : { job: { state: 'done', workflowId: 'ltx' } },
    }),
    onReady: () => true,
    wait: () => settle(),
  });
  await settle();
  assert.equal(card.card.attributes['aria-label'], 'Il manque des fichiers');
  assert.equal(find(host, 'missing-head')[0].textContent, 'Il manque des fichiers · Vidéo · LTX 2.5');
  assert.match(
    find(host, 'missing-note')[0].textContent,
    /^Ils vont dans votre dossier des modèles, depuis Hugging Face\. /,
  );
  await card.start();
  assert.equal(find(host, 'missing-done')[0].textContent, 'Les fichiers sont là. Je reprends votre demande…');
});

test('53 · the licences of the files are shown before the download; one with conditions is read and confirmed first', async () => {
  const minimax = {
      name: 'MiniMax H3 Community License Agreement',
      url: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE',
      limits:
        'Non licencié dans l’Union européenne, au Royaume-Uni, en Corée du Sud ni aux États-Unis, pour le modèle comme pour ses sorties.',
      restricted: true,
    },
    apache = { name: 'Apache-2.0', url: 'https://spdx.org/licenses/Apache-2.0.html', limits: '', restricted: false };
  const cardOf = (files, answer = async () => ({ state: 'running', workflowId: 'h3', received: 0, total: 10 })) => {
    const host = new Element('div'),
      asked = [];
    const card = missingFileCard({
      host,
      request: {
        requestId: 'r',
        tool: 'create_video',
        workflowName: 'MiniMax H3 Omni',
        mediaType: 'video',
        missing: { workflowId: 'h3', files, bytes: 10, left: 10 },
      },
      node,
      icon,
      api: async (route, body) => {
        asked.push([route, body]);
        if (route === 'downloads/start') return { json: async () => answer(body) };
        return { json: async () => ({ job: { state: 'done', workflowId: 'h3' } }) };
      },
      onReady: () => true,
      wait: () => settle(),
    });
    return { host, card, starts: () => asked.filter(([route]) => route === 'downloads/start').map(([, body]) => body) };
  };
  const lines = host =>
    find(host, 'license-item').map(item =>
      under(item)
        .map(part => part.textContent)
        .filter(Boolean),
    );
  const buttons = host =>
    find(host, 'missing-foot')[0]
      .children.filter(item => item.tag === 'button')
      .map(item => item.children.at(-1).textContent);

  // Two licences: the one with conditions first, each with its link, its files and its limits.
  const f = cardOf([
    { file: 'qwen25_tokenizer', size: 5, license: apache },
    { file: 'fasth3.safetensors', size: 3, license: minimax },
    { file: 'h3_vae.safetensors', size: 2, license: minimax },
  ]);
  await settle();
  assert.equal(find(f.host, 'license-head')[0].textContent, 'Licences');
  assert.deepEqual(lines(f.host), [
    [
      'MiniMax H3 Community License Agreement',
      'à conditions',
      'fasth3.safetensors, h3_vae.safetensors',
      minimax.limits,
    ],
    ['Apache-2.0', 'qwen25_tokenizer'],
  ]);
  const [link] = find(f.host, 'license-name');
  assert.deepEqual([link.tag, link.href, link.target, link.rel], ['a', minimax.url, '_blank', 'noopener noreferrer']);
  assert.deepEqual(buttons(f.host), ['Annuler', 'Télécharger · 1 Mo']);
  // « Télécharger »: nothing leaves; the licence with conditions alone, to read, and the question.
  await f.card.start();
  assert.deepEqual(f.starts(), []);
  assert.equal(find(f.host, 'license-block')[0].attributes['data-confirm'], 'true');
  assert.equal(find(f.host, 'license-head')[0].textContent, 'À lire avant de télécharger');
  assert.deepEqual(
    lines(f.host).map(line => line[0]),
    ['MiniMax H3 Community License Agreement'],
  );
  assert.match(
    find(f.host, 'license-limits')[0].textContent,
    /Union européenne, au Royaume-Uni, en Corée du Sud ni aux États-Unis/,
  );
  assert.equal(
    find(f.host, 'missing-ask')[0].textContent,
    'Vous avez lu cette licence et vous en acceptez les conditions ?',
  );
  assert.deepEqual(buttons(f.host), ['Retour', 'J’ai lu, télécharger · 1 Mo']);
  // « Retour »: as before, nothing sent. Confirmed: the request says so.
  f.card.back();
  assert.deepEqual(buttons(f.host), ['Annuler', 'Télécharger · 1 Mo']);
  assert.equal(find(f.host, 'license-block')[0].attributes['data-confirm'], undefined);
  await f.card.start();
  await f.card.confirm();
  assert.deepEqual(f.starts(), [{ id: 'h3', accepted: true }]);

  // Free licences alone: named, one licence for all the files (no list of files), and no step more.
  const free = cardOf([
    { file: 'a.safetensors', size: 5, license: apache },
    { file: 'b.safetensors', size: 5, license: apache },
  ]);
  await settle();
  assert.equal(find(free.host, 'license-head')[0].textContent, 'Licence');
  assert.deepEqual(lines(free.host), [['Apache-2.0']]);
  await free.card.start();
  assert.deepEqual(free.starts(), [{ id: 'h3' }]);

  // A refusal of the server (no token, say) is said on the card, back to its first state.
  const refused = cardOf([{ file: 'fasth3.safetensors', size: 3, license: minimax }], async () => {
    throw new Error('Ces fichiers demandent un compte Hugging Face.');
  });
  await settle();
  await refused.card.start();
  await refused.card.confirm();
  assert.equal(find(refused.host, 'missing-error')[0].textContent, 'Ces fichiers demandent un compte Hugging Face.');
  assert.deepEqual(buttons(refused.host), ['Annuler', 'Télécharger · 1 Mo']);

  // (0.6.288) Two clicks before the answer: one request. The server refuses a second start (« déjà en cours »),
  // and that refusal put the card back to « Télécharger », an error written over a download that went on.
  let started = 0;
  const twice = cardOf([{ file: 'a.safetensors', size: 5, license: apache }], async () => {
    if (started++) throw new Error('Un téléchargement est déjà en cours.');
    await settle();
    return { state: 'running', workflowId: 'h3', received: 0, total: 10 };
  });
  await settle();
  await Promise.all([twice.card.start(), twice.card.start()]);
  assert.deepEqual(twice.starts(), [{ id: 'h3' }]);
  assert.deepEqual(find(twice.host, 'missing-error'), []);
  // And a start that failed lets the next click try again.
  started = 1;
  const retried = cardOf([{ file: 'a.safetensors', size: 5, license: apache }], async () => {
    if (started++ === 1) throw new Error('Pas assez de place.');
    return { state: 'running', workflowId: 'h3', received: 0, total: 10 };
  });
  await settle();
  await retried.card.start();
  assert.equal(find(retried.host, 'missing-error')[0].textContent, 'Pas assez de place.');
  await retried.card.start();
  assert.deepEqual([retried.starts().length, find(retried.host, 'missing-error')], [2, []]);
});

test('53 · a verb no ready workflow makes reaches the shipped one that lacks a file; a ready one comes first', async () => {
  const video = (id, extra = {}) => ({
    schemaVersion: 1,
    id,
    name: id,
    description: `Workflow ${id}`,
    enabled: true,
    ready: true,
    pipeline: 'ltx25',
    mediaType: 'video',
    parameters: { prompt: { policy: 'model', type: 'string' } },
    components: {},
    loras: [],
    references: [],
    ...extra,
  });
  const lacking = video('lacking', { ready: false, builtin: true, unavailableKind: 'files' }),
    broken = video('broken', { ready: false, builtin: true, unavailableReason: 'Fichier incompatible' });
  const alone = new ToolCatalog({ list: async () => [lacking, broken] });
  assert.ok((await alone.definitions()).some(tool => tool.function.name === 'create_video'));
  assert.equal((await alone.lacking('create_video'))?.id, 'lacking');
  const routed = await alone.route('create_video', { prompt: 'un phare', intention: 'x' }, { mediaOf: async () => 'image' });
  assert.equal(routed.workflow.id, 'lacking');
  // A workflow that is ready makes it: nothing is offered to download.
  const both = new ToolCatalog({ list: async () => [lacking, video('ready')] });
  assert.equal(await both.lacking('create_video'), null);
  assert.equal((await both.route('create_video', { prompt: 'un phare', intention: 'x' }, { mediaOf: async () => 'image' })).workflow.id, 'ready');
});

test('53 · while Windows holds a file just downloaded, the card says it waits, under its line; then nothing more (0.6.90)', async () => {
  // The line stood full, « 28,6 Go / 28,6 Go », for a minute without a word.
  const host = new Element('div'),
    said = [],
    full = 28.6 * 1024 ** 3,
    jobs = [
      { job: { state: 'idle' } },
      { job: { state: 'running', workflowId: 'wan-scail2', received: full, total: full, current: 'wan2.2_scail_14B.safetensors : en attente que Windows libère le fichier' } },
      { job: { state: 'running', workflowId: 'wan-scail2', received: full, total: full, current: 'wan2.2_scail_14B.safetensors' } },
      { job: { state: 'done', workflowId: 'wan-scail2', received: full, total: full } },
    ];
  const card = missingFileCard({
    host,
    request: {
      requestId: 'r',
      tool: 'replace_character',
      workflowName: 'Wan SCAIL 2',
      mediaType: 'video',
      missing: { workflowId: 'wan-scail2', files: [{ file: 'wan2.2_scail_14B.safetensors', size: full }], bytes: full, left: full },
    },
    node,
    icon,
    api: async route => ({
      json: async () =>
        route === 'downloads/start'
          ? { state: 'running', workflowId: 'wan-scail2', received: 0, total: full }
          : route === 'downloads'
            ? (jobs.shift() ?? { job: { state: 'done', workflowId: 'wan-scail2' } })
            : {},
    }),
    onReady: () => true,
    wait: () => (said.push(find(host, 'missing-wait').map(item => item.textContent)), settle()),
  });
  await settle();
  await card.start();
  assert.deepEqual(said, [['wan2.2_scail_14B.safetensors : en attente que Windows libère le fichier'], []]);
});

test('50 · while Windows holds a file of llama.cpp it just wrote, the first launch says it waits, under its line (0.6.90)', async () => {
  const host = new Element('section'),
    waiting = 'llama-b12359-bin-win-cuda-13.5-x64.zip : en attente que Windows libère le fichier…',
    done = { state: 'done', result: { enginePath: 'C:/llama/llama-server.exe' } },
    jobs = [
      { state: 'idle' },
      { state: 'downloading', received: 100, total: 100, step: waiting },
      { state: 'downloading', received: 100, total: 100, step: 'Téléchargement de llama.cpp b12359 (CUDA 13.5)…' },
      done,
    ];
  const card = setupFirstLaunch({
    api: async route => ({
      json: async () =>
        route === 'llama'
          ? (jobs.shift() ?? done)
          : route === 'llama/check'
            ? { tag: 'b12359', candidates: [{ label: 'CUDA 13.5', size: 578 * 1048576 }] }
            : {},
    }),
    node,
    icon,
    host,
    config: () => ({ enginePath: '', modelPath: '' }),
    onConfig: () => {},
  });
  card.sync(true);
  await settle();
  await settle();
  const installing = find(host, 'setup-install')[0].onclick();
  await settle();
  await settle();
  await settle();
  assert.deepEqual(find(host, 'setup-progress-note').map(item => item.textContent), [waiting]);
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.deepEqual(find(host, 'setup-progress-note'), [], 'let go: its line alone again');
  await installing;
});

test('(0.6.225) a model converted after its download says the room it needs, on the card of the missing file', async () => {
  const giga = 1024 ** 3,
    sentence = 'Il faut 61,2 Go de place libre : après le téléchargement, les fichiers sont convertis pour le moteur de Moodix, puis les originaux sont effacés.';
  // The offer of the server: `convert`, and `room` (what is left to fetch and the converted files beside them).
  assert.equal(roomText({ convert: true, room: 61.2 * giga, left: 30.6 * giga, bytes: 30.6 * giga }), sentence);
  for (const none of [null, undefined, {}, { convert: false, room: 61.2 * giga }, { convert: true }, { convert: true, room: 0 }, { room: 5 * giga }]) assert.equal(roomText(none), '', JSON.stringify(none));
  const draw = missing => {
    const host = node('div');
    missingFileCard({
      host,
      request: { workflowId: 'cam', workflowName: 'Wan 2.2 Caméra', mediaType: 'video', missing },
      node,
      icon,
      api: async () => ({ json: async () => ({}) }),
      wait: () => settle(),
    });
    return find(host, 'missing-note')[0].textContent;
  };
  const files = [{ role: 'model', file: 'wan2.2_fun_camera_high.safetensors', size: 15.3 * giga, license: null }],
    plain = 'Il va dans votre dossier des modèles, depuis Hugging Face. Le téléchargement reprend où il en était si vous l’arrêtez.';
  assert.equal(draw({ files, bytes: 30.6 * giga, left: 30.6 * giga, convert: true, room: 61.2 * giga }), plain + ' ' + sentence);
  assert.equal(draw({ files, bytes: 30.6 * giga, left: 30.6 * giga }), plain);
  await settle();
});

test('(0.6.493) a card taller than the conversation keeps its head in view; in a proposal card, the head of that card', async () => {
  // (relecture-chat-routage.md, m6: at 1280 × 720 the offer of LTX 2.5 in a proposal card, 490 px, had the title of
  // the card and the button of its model under the top of the conversation, which the page keeps at its end as it
  // grows: its ResizeObserver, answered before the one of the card.)
  class Box extends Element {
    closest(selector) {
      const name = selector.slice(1);
      for (let at = this; at; at = at.parent) if (String(at.className).split(' ').includes(name)) return at;
      return null;
    }
    getBoundingClientRect() {
      return { top: this.top ?? 0 };
    }
  }
  const watchers = [],
    moves = [],
    before = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(answer) {
      Object.assign(this, { answer, watched: [], off: false });
      watchers.push(this);
    }
    observe(target) {
      this.watched.push(target);
    }
    disconnect() {
      this.off = true;
    }
  };
  const giga = 1024 ** 3,
    files = [{ file: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', size: 20 * giga }],
    missing = { workflowId: 'ltx25', files, bytes: 20 * giga },
    area = Object.assign(new Box('main', 'chat-area'), { top: 114, scrollBy: move => moves.push(move) }),
    message = new Box('div', 'message'),
    proposal = Object.assign(new Box('section', 'proposal-card'), { top: 32 }),
    offered = new Box('div', 'proposal-offer');
  area.append(message, proposal);
  proposal.append(offered);
  const draw = host =>
    missingFileCard({
      host,
      request: { workflowName: 'LTX 2.5', mediaType: 'video', missing },
      node: (...args) => new Box(...args),
      icon,
      api: async () => ({ json: async () => ({ job: { state: 'idle' } }) }),
      wait: () => settle(),
    }).card;
  try {
    draw(offered);
    assert.equal(watchers.length, 1);
    assert.equal(watchers[0].watched[0].className, 'missing-card');
    watchers[0].answer();
    // Up to the head of the proposal card (32), under the mask of the top of the conversation (114 + 14), 8 px more.
    assert.deepEqual(moves, [{ top: -104, behavior: 'instant' }]);
    assert.equal(watchers[0].off, true, 'once, as it comes');
    // Alone in a message, its own head; one that fits in the conversation moves nothing.
    draw(message).top = -5;
    watchers[1].answer();
    assert.deepEqual(moves.at(-1), { top: -141, behavior: 'instant' });
    draw(message).top = 300;
    watchers[2].answer();
    assert.equal(moves.length, 2);
  } finally {
    globalThis.ResizeObserver = before;
  }
  await settle();
});
