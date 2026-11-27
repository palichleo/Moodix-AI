// (0.6.452) The dictation in the page (public/dictation.mjs, public/dictation-settings.mjs), on a page made here: just
// what the dictation asks of one (elements in a tree, a few selectors, the microphone and Web Audio of a browser).
// The real browser goes through it in scripts/check-ui.mjs; here, what it cannot be made to do (a microphone cut, a
// box closed or full meanwhile, two minutes, Firefox).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCKED,
  DICTATING,
  LISTEN_PLACEHOLDER,
  NO_MIC,
  UNAVAILABLE,
  WORKLET,
  barHeight,
  clock,
  insertion,
  setupDictation,
  wavOf,
} from '../public/dictation.mjs';
import { CARD_TIP, meterSegments, modelLine, setupDictationSettings } from '../public/dictation-settings.mjs';
import { UNAVAILABLE as SERVER_UNAVAILABLE, wavSeconds } from '../lib/dictation.mjs';

const GIB = 1024 ** 3;

// ------------------------------------------------------------------ a page made here
/** `#id`, `.class`, `tag[attribute]`, and the descendants of each other: all the dictation asks for. */
function one(element, part) {
  const [, tag = '', id = '', classes = '', attribute = ''] =
    part.match(/^([a-z]*)(?:#([\w-]+))?((?:\.[\w-]+)*)(?:\[([\w-]+)\])?$/) ?? [];
  return (
    (!tag || element.localName === tag) &&
    (!id || element.id === id) &&
    classes
      .split('.')
      .filter(Boolean)
      .every(name => element.classList.contains(name)) &&
    (!attribute || attribute in element.attributes || element[attribute] === true)
  );
}
class Element {
  constructor(document, tag, { id = '', className = '' } = {}) {
    Object.assign(this, { ownerDocument: document, localName: tag, id, className, childNodes: [], parentNode: null });
    Object.assign(this, { attributes: {}, dataset: {}, style: {}, hidden: false, title: '', textContent: '' });
  }
  get children() {
    return this.childNodes.filter(child => child instanceof Element);
  }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean),
      set = list => (this.className = [...new Set(list)].join(' '));
    return {
      contains: name => names().includes(name),
      add: (...added) => set([...names(), ...added]),
      remove: (...gone) => set(names().filter(name => !gone.includes(name))),
      toggle: (name, on = !names().includes(name)) => {
        set(on ? [...names(), name] : names().filter(other => other !== name));
        return on;
      },
    };
  }
  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.remove();
    this.childNodes = [];
    this.append(...nodes);
  }
  insertBefore(node, before) {
    if (typeof node !== 'string') {
      node.remove();
      node.parentNode = this;
    }
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }
  remove() {
    const list = this.parentNode?.childNodes;
    if (list) list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
  get nextSibling() {
    const list = this.parentNode?.childNodes ?? [];
    return list[list.indexOf(this) + 1] ?? null;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.body;
  }
  getClientRects() {
    for (let node = this; node; node = node.parentNode) if (node.hidden) return [];
    return this.isConnected ? [{}] : [];
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    if (!one(this, parts.at(-1))) return false;
    let index = parts.length - 2;
    for (let node = this.parentNode; node && index >= 0; node = node.parentNode) if (one(node, parts[index])) index--;
    return index < 0;
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(selector) {
    for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  dispatchEvent(event) {
    (this.events ??= []).push(event.type);
    return true;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
}
class Field extends Element {
  constructor(document, options) {
    super(document, 'textarea', options);
    Object.assign(this, { value: '', placeholder: '', disabled: false, readOnly: false, maxLength: -1 });
    Object.assign(this, { selectionStart: 0, selectionEnd: 0 });
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + text.length;
  }
}
function fakeDocument() {
  // execCommand refuses: the words go in as a page that cannot type them does (setRangeText and « input »).
  const document = { activeElement: null, execCommand: () => false };
  document.body = new Element(document, 'body');
  document.createElement = tag => new Element(document, tag);
  document.querySelector = selector => document.body.querySelector(selector);
  return document;
}

/**
 * A browser: its microphones (`devices`), one that refuses (`refuse`: the name of its error), a page not served safely
 * (`secure`), Firefox, which does not bring the microphone to a context at another rate (`brings16k`).
 */
function fakePage({ devices = [{ kind: 'audioinput', deviceId: 'micro-1', label: '' }], refuse = '', secure = true, brings16k = true } = {}) {
  const document = fakeDocument(),
    keys = [],
    contexts = [],
    nodes = [],
    renders = [],
    tracks = [],
    // What listens to the microphones plugged in or out (devicechange).
    plugged = [];
  class AudioContext {
    constructor(options = {}) {
      Object.assign(this, { sampleRate: options.sampleRate ?? 48000, state: 'running', destination: {} });
      this.audioWorklet = { addModule: async url => (this.module = url) };
      contexts.push(this);
    }
    createMediaStreamSource() {
      if (!brings16k && this.sampleRate === 16000)
        throw Object.assign(new Error('different sample-rate is currently not supported'), { name: 'NotSupportedError' });
      return { connect: node => node };
    }
    createGain() {
      return { gain: { value: 1 }, connect: node => node };
    }
    async resume() {
      this.state = 'running';
    }
    async close() {
      this.state = 'closed';
    }
  }
  class AudioWorkletNode {
    constructor(context, name, options) {
      Object.assign(this, { context, name, options });
      // « flush »: the worklet says at once that all of it went.
      this.port = {
        onmessage: null,
        postMessage: message => message === 'flush' && queueMicrotask(() => this.port.onmessage?.({ data: { done: true } })),
      };
      nodes.push(this);
    }
    connect(node) {
      return node;
    }
    disconnect() {}
  }
  class OfflineAudioContext {
    constructor(channels, length, rate) {
      Object.assign(this, { channels, length, rate, destination: {} });
      renders.push(this);
    }
    createBuffer(channels, length, rate) {
      return { channels, length, rate, copyToChannel: () => {} };
    }
    createBufferSource() {
      return { connect() {}, start() {} };
    }
    async startRendering() {
      return { getChannelData: () => new Float32Array(this.length).fill(0.25) };
    }
  }
  const page = {
    document,
    isSecureContext: secure,
    AudioContext,
    AudioWorkletNode,
    OfflineAudioContext,
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      mediaDevices: {
        async getUserMedia(constraints) {
          if (refuse) throw Object.assign(new Error(refuse), { name: refuse });
          // `end()`: the microphone stops by itself (unplugged), as the browser says it.
          const track = {
            stopped: false,
            ended: [],
            stop: () => (track.stopped = true),
            addEventListener: (type, run) => type === 'ended' && track.ended.push(run),
            end: () => track.ended.forEach(run => run()),
          };
          tracks.push(track);
          return { constraints, getTracks: () => [track], getAudioTracks: () => [track] };
        },
        enumerateDevices: async () => devices,
        addEventListener: (type, run) => type === 'devicechange' && plugged.push(run),
      },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (run, ms) => setTimeout(run, ms).unref(),
    setInterval: (run, ms) => setInterval(run, ms).unref(),
    clearInterval: timer => clearInterval(timer),
    addEventListener: (type, listener) => type === 'keydown' && keys.push(listener),
  };
  return { page, document, keys, contexts, nodes, renders, tracks, plugged, devices };
}

/** The three places, as the page draws them: the bar of the chat, the prompt of the Studio, the field of the Bobine. */
function places(document) {
  const make = (tag, options) => new Element(document, tag, options),
    form = make('form', { id: 'chat-form' }),
    options = make('div', { className: 'composer-options' }),
    prompt = new Field(document, { id: 'prompt' }),
    chatMic = make('button', { id: 'dictate' }),
    studioField = make('div', { className: 'studio-prompt-field' }),
    studioPrompt = new Field(document, { id: 'studio-prompt' }),
    ask = make('div', { className: 'bobine-ask-field' }),
    words = new Field(document, { className: 'bobine-ask-words' });
  prompt.placeholder = 'Une image, un plan, un son… quelques mots suffisent.';
  options.append(make('button', { id: 'attach' }));
  form.append(prompt, options, chatMic);
  studioField.append(studioPrompt);
  ask.append(words);
  document.body.append(form, studioField, ask);
  return { form, options, prompt, chatMic, studioField, studioPrompt, ask, words };
}

/** The dictation on that page; the server says `status`, and writes `text`. */
function dictationOn({ status = { installed: true, maxSeconds: 120 }, text = 'un chat roux', ...browser } = {}) {
  const fake = fakePage(browser),
    shown = places(fake.document),
    notices = [],
    calls = [],
    said = { status, text };
  const api = async (route, body, options = {}) => {
    calls.push({ route, body, options });
    if (route === 'dictation') return { json: async () => said.status };
    // `said.wait`: the words come once it is resolved (« Transcription… » meanwhile).
    if (route === 'dictation/transcribe') {
      await said.wait;
      return { json: async () => ({ text: said.text }) };
    }
    return { json: async () => ({}) };
  };
  const dictation = setupDictation({
    api,
    icon: () => fake.document.createElement('svg'),
    notice: message => notices.push(message),
    page: fake.page,
  });
  dictation.adopt(shown.chatMic, 'chat');
  const asked = route => calls.filter(call => call.route === route);
  return { ...fake, ...shown, dictation, notices, calls, said, asked };
}
/** What the microphone hears for `seconds`, in pieces of 40 ms, as the worklet hands it. */
function hear(fake, seconds, level = 0.05) {
  const node = fake.nodes.at(-1),
    rate = node.context.sampleRate,
    piece = Math.round(rate * 0.04);
  for (let heard = 0; heard < seconds * rate; heard += piece)
    node.port.onmessage?.({ data: { samples: new Float32Array(piece).fill(level), level } });
}
const settled = async condition => {
  for (let tries = 0; tries < 200 && !condition(); tries++) await new Promise(resolve => setTimeout(resolve, 5));
};
const press = (fake, key, target, more = {}) => {
  let prevented = false;
  const event = { key, target, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false };
  for (const listener of fake.keys)
    listener({ ...event, ...more, preventDefault: () => (prevented = true), stopPropagation() {} });
  return prevented;
};

// ------------------------------------------------------------------ the tests
test('the words go at the cursor, a space between them and the text, none before a punctuation', () => {
  assert.equal(insertion('abc', 3, 3, '   '), null);
  assert.deepEqual(insertion('', 0, 0, ' un chat '), { piece: 'un chat', from: 0, to: 0 });
  assert.deepEqual(insertion('Un vieux pêcheur, ', 18, 18, 'il répare'), { piece: 'il répare', from: 18, to: 18 });
  assert.deepEqual(insertion('Un vieux pêcheur,', 17, 17, 'il répare'), { piece: ' il répare', from: 17, to: 17 });
  assert.deepEqual(insertion('Un chat, sur un toit', 7, 7, 'roux'), { piece: ' roux', from: 7, to: 7 });
  assert.deepEqual(insertion('Un toit', 3, 3, 'chat sur un'), { piece: 'chat sur un ', from: 3, to: 3 });
  // What is selected is replaced; a cursor unknown or beyond the text: its end.
  assert.deepEqual(insertion('Un chien roux', 3, 8, 'chat'), { piece: 'chat', from: 3, to: 8 });
  assert.deepEqual(insertion('Un phare', undefined, undefined, 'la nuit'), { piece: ' la nuit', from: 8, to: 8 });
  assert.deepEqual(insertion('Un phare', 99, 120, 'la nuit'), { piece: ' la nuit', from: 8, to: 8 });
});

test('the strip: its bars from the level heard, its time; the segments of « Essayer » alike', () => {
  for (const silent of [0, -1, Number.NaN, 0.000001]) assert.equal(barHeight(silent, 20), 3);
  assert.equal(barHeight(0.001, 20), 3);
  assert.equal(barHeight(10 ** (-30 / 20), 20), 8);
  assert.equal(barHeight(10 ** (-15 / 20), 16), 11);
  assert.equal(barHeight(1, 16), 16);
  // A voice heard in Chromium, its gain control on (measured on 26/11): −17 dB in the median, −8 dB in its loudest
  // tenth, its peaks near −4 dB. Its bars move under their top: the scale that stopped at −15 dB stood them all there.
  assert.equal(barHeight(10 ** (-17 / 20), 20), 13);
  assert.equal(barHeight(10 ** (-8 / 20), 20), 16);
  assert.ok(barHeight(10 ** (-4 / 20), 20) < 20);
  assert.deepEqual([0, 6.9, 59.99, 61, 119.5, 120, -3].map(clock), ['0:00', '0:06', '0:59', '1:01', '1:59', '2:00', '0:00']);
  assert.deepEqual([0, 0.001, 10 ** (-30 / 20), 10 ** (-15 / 20), 10 ** (-17 / 20), 1].map(meterSegments), [0, 0, 3, 6, 6, 10]);
});

test('the sound posted is a WAV the server takes, at 16 kHz, and the page says the server’s words', async () => {
  const samples = Float32Array.from({ length: 16000 * 1.5 }, (_, index) => Math.sin(index / 10) * 1.2),
    sound = wavOf(samples),
    bytes = Buffer.from(await sound.arrayBuffer());
  assert.equal(sound.type, 'audio/wav');
  assert.equal(bytes.length, 44 + samples.length * 2);
  assert.equal(wavSeconds(bytes), 1.5);
  // Louder than the most a sample holds: kept at the most, not turned round.
  assert.equal(Math.max(...new Int16Array(bytes.buffer, bytes.byteOffset + 44, samples.length)), 32767);
  assert.equal(Math.min(...new Int16Array(bytes.buffer, bytes.byteOffset + 44, samples.length)), -32768);
  assert.equal(UNAVAILABLE, SERVER_UNAVAILABLE);
});

test('the line « Modèle »: to download with its licence, downloading, installed', () => {
  const model = { name: 'Qwen3-ASR 1.7B', bytes: 2.614 * GIB, left: 2.614 * GIB, license: { name: 'Apache-2.0', url: '' } };
  assert.equal(modelLine({ installed: false, model, job: { state: 'idle' } }), 'Qwen3-ASR 1.7B, d’Alibaba · 2,6 Go à télécharger · Apache 2.0');
  assert.equal(
    modelLine({ installed: false, model, job: { state: 'running', received: 1.3 * GIB, total: 2.6 * GIB } }),
    'Téléchargement : 50 % · 1,3 Go sur 2,6 Go',
  );
  assert.equal(modelLine({ installed: true, model: { ...model, left: 0 }, job: { state: 'done' } }), 'Qwen3-ASR 1.7B · installé · 2,6 Go');
  // The server not read: its name and its licence all the same, no size made up.
  assert.equal(modelLine(null), 'Qwen3-ASR 1.7B, d’Alibaba · Apache 2.0');
});

test('greyed, never hidden, and a click says why: no model, no microphone, one blocked, a page not served safely', async () => {
  let fake = dictationOn({ status: { installed: false } });
  await fake.dictation.refresh();
  assert.equal(fake.chatMic.getAttribute('aria-disabled'), 'true');
  assert.equal(fake.chatMic.title, UNAVAILABLE);
  await fake.dictation.toggle('chat');
  assert.deepEqual(fake.notices, [UNAVAILABLE]);
  assert.equal(fake.contexts.length, 0);
  // Installed meanwhile (another tab, Paramètres): read again at the click, it listens.
  fake.said.status = { installed: true };
  await fake.dictation.toggle('chat');
  assert.equal(fake.dictation.busy('chat'), true);
  fake.dictation.cancel();

  // No microphone in the list: greyed; a click still asks the browser, whose list can be empty before it is allowed.
  fake = dictationOn({ devices: [], refuse: 'NotFoundError' });
  await fake.dictation.refresh();
  await settled(() => fake.chatMic.title === NO_MIC);
  assert.equal(fake.chatMic.getAttribute('aria-disabled'), 'true');
  await fake.dictation.toggle('chat');
  assert.deepEqual(fake.notices, [NO_MIC]);
  assert.equal(fake.contexts[0].state, 'closed');
  assert.equal(fake.dictation.busy(), false);

  fake = dictationOn({ refuse: 'NotAllowedError' });
  await fake.dictation.refresh();
  await fake.dictation.toggle('chat');
  assert.deepEqual(fake.notices, [BLOCKED]);

  fake = dictationOn({ secure: false });
  await fake.dictation.refresh();
  assert.equal(fake.chatMic.title, 'Ce navigateur ne donne pas le micro à cette page.');
  await fake.dictation.toggle('chat');
  assert.deepEqual(fake.notices, ['Ce navigateur ne donne pas le micro à cette page.']);
});

test('a click listens at 16 kHz, its strip in the place of the choices; another writes the words at the cursor', async () => {
  const fake = dictationOn({ text: 'il répare son filet' });
  await fake.dictation.refresh();
  await settled(() => fake.chatMic.title === 'Dicter (Ctrl+M)');
  assert.equal(fake.chatMic.getAttribute('aria-disabled'), null);
  assert.equal(fake.chatMic.getAttribute('aria-keyshortcuts'), 'Control+M');
  fake.prompt.value = 'Un vieux pêcheur, au port.';
  fake.prompt.setSelectionRange(18, 18);
  const seen = [];
  fake.dictation.watch(() => seen.push(fake.dictation.busy('chat')));
  await fake.dictation.toggle('chat');
  // Listening: at 16 kHz, what the worklet hears is what is posted (nothing read back from Web Audio).
  assert.deepEqual(
    fake.contexts.map(context => [context.sampleRate, context.module]),
    [[16000, WORKLET]],
  );
  assert.equal(fake.nodes[0].name, 'moodix-dictation');
  assert.ok(fake.asked('dictation/warm').length === 1, 'the engine starts while one speaks');
  const strip = fake.options.querySelector('.dictation-strip');
  assert.ok(fake.options.classList.contains('is-dictating') && strip.parentNode === fake.options);
  assert.equal(fake.prompt.placeholder, LISTEN_PLACEHOLDER);
  assert.ok(fake.chatMic.classList.contains('is-listening'));
  assert.equal(fake.chatMic.getAttribute('aria-pressed'), 'true');
  assert.equal(fake.chatMic.title, 'Terminer la dictée (Ctrl+M)');
  assert.ok(strip.querySelector('.dictation-hint'), '« Échap annule » in the chat');
  hear(fake, 1.2);
  const bars = strip.querySelector('.dictation-bars').children;
  assert.equal(bars.length, 34);
  assert.ok(bars.some(bar => Number.parseInt(bar.style.height, 10) > 3));
  assert.equal(strip.querySelector('.dictation-time').textContent, '0:01');
  await fake.dictation.toggle('chat');
  const [posted] = fake.asked('dictation/transcribe');
  assert.equal(posted.options.raw, true);
  assert.equal(posted.options.headers['Content-Type'], 'audio/wav');
  assert.ok(Math.abs(wavSeconds(Buffer.from(await posted.body.arrayBuffer())) - 1.2) < 0.05);
  assert.equal(fake.renders.length, 0);
  // Written where the cursor was, a space before what follows; everything as it was around it.
  assert.equal(fake.prompt.value, 'Un vieux pêcheur, il répare son filet au port.');
  assert.deepEqual(fake.prompt.events, ['input']);
  assert.equal(fake.prompt.placeholder, 'Une image, un plan, un son… quelques mots suffisent.');
  assert.ok(!fake.options.classList.contains('is-dictating') && !fake.options.querySelector('.dictation-strip'));
  assert.ok(fake.tracks.every(track => track.stopped) && fake.contexts[0].state === 'closed');
  assert.equal(fake.dictation.busy(), false);
  // Followed from its first instant to its end (« Envoyer » waited all along).
  assert.equal(seen[0], true);
  assert.equal(seen.at(-1), false);
  assert.ok(DICTATING.length > 0);
});

test('a browser that does not bring the microphone to 16 kHz: heard at its own rate, brought there at the end', async () => {
  const fake = dictationOn({ brings16k: false });
  await fake.dictation.refresh();
  await fake.dictation.toggle('chat');
  assert.deepEqual(
    fake.contexts.map(context => [context.sampleRate, context.state]),
    [
      [16000, 'closed'],
      [48000, 'running'],
    ],
  );
  hear(fake, 1);
  await fake.dictation.toggle('chat');
  assert.deepEqual(
    fake.renders.map(render => [render.length, render.rate]),
    [[16000, 16000]],
  );
  const [posted] = fake.asked('dictation/transcribe');
  assert.equal(wavSeconds(Buffer.from(await posted.body.arrayBuffer())), 1);
  assert.equal(fake.prompt.value, 'un chat roux');
});

test('a microphone cut, a click and its second click, a box closed or full meanwhile', async () => {
  const fake = dictationOn();
  await fake.dictation.refresh();
  const once = async (seconds, level) => {
    await fake.dictation.toggle('chat');
    hear(fake, seconds, level);
    await fake.dictation.toggle('chat');
  };
  // Nothing heard all along: nothing asked, and it says where to look.
  await once(1, 0.0005);
  assert.equal(fake.asked('dictation/transcribe').length, 0);
  assert.match(fake.notices.at(-1), /^Le micro n’a rien entendu/);
  // Nothing said (under 0,3 s): nothing asked, nothing said either.
  fake.notices.length = 0;
  await once(0.1);
  assert.deepEqual(fake.notices, []);
  assert.equal(fake.asked('dictation/transcribe').length, 0);
  // The box closed while it wrote: what was said, in the notice.
  fake.said.text = 'un phare';
  await fake.dictation.toggle('chat');
  hear(fake, 1);
  fake.prompt.disabled = true;
  await fake.dictation.toggle('chat');
  assert.equal(fake.notices.at(-1), 'La case de la dictée n’est plus ouverte. Ce qui a été dit : « un phare »');
  fake.prompt.disabled = false;
  // The box full: what fits, and it says so.
  Object.assign(fake.prompt, { value: 'abc', maxLength: 8 });
  fake.prompt.setSelectionRange(3, 3);
  await once(1);
  assert.equal(fake.prompt.value, 'abc un p');
  assert.equal(fake.notices.at(-1), 'La case est pleine : la fin de la dictée n’y tient pas.');
  // Nothing recognised.
  fake.said.text = '  ';
  await once(1);
  assert.equal(fake.notices.at(-1), 'La dictée n’a reconnu aucun mot.');
});

test('two minutes at most: the dictation ends by itself, and writes what was said', async () => {
  const fake = dictationOn({ status: { installed: true, maxSeconds: 1 } });
  await fake.dictation.refresh();
  await fake.dictation.toggle('chat');
  hear(fake, 1.1);
  await settled(() => !fake.dictation.busy());
  assert.equal(fake.asked('dictation/transcribe').length, 1);
  assert.equal(fake.prompt.value, 'un chat roux');
});

test('Ctrl+M dictates where one writes, or in the place on screen; Échap lets it go; one place at a time', async () => {
  const fake = dictationOn(),
    studioMic = fake.dictation.mic('studio'),
    bobineMic = fake.dictation.mic('bobine', { held: () => (fake.ask.dataset.working ? 'La Bobine travaille.' : '') });
  fake.studioField.append(studioMic);
  fake.ask.append(bobineMic);
  await fake.dictation.refresh();
  assert.equal(studioMic.title, 'Dicter le prompt (Ctrl+M)');
  assert.equal(bobineMic.title, 'Dicter la demande (Ctrl+M)');
  // In the box of the Studio.
  assert.equal(press(fake, 'm', fake.studioPrompt, { ctrlKey: true }), true);
  await settled(() => fake.studioField.classList.contains('is-dictating'));
  assert.equal(fake.dictation.busy('studio'), true);
  assert.ok(fake.studioField.querySelector('.dictation-strip'));
  // The Bobine meanwhile: one dictation at a time.
  assert.equal(bobineMic.getAttribute('aria-disabled'), 'true');
  assert.equal(bobineMic.title, 'Une dictée est déjà en cours.');
  await fake.dictation.toggle('bobine');
  assert.equal(fake.notices.at(-1), 'Une dictée est déjà en cours.');
  // Échap: nothing written, nothing asked, the box as it was.
  assert.equal(press(fake, 'Escape', fake.studioPrompt), true);
  assert.equal(fake.dictation.busy(), false);
  assert.equal(fake.asked('dictation/transcribe').length, 0);
  assert.ok(!fake.studioField.classList.contains('is-dictating') && !fake.studioField.querySelector('.dictation-strip'));
  assert.equal(fake.studioPrompt.placeholder, '');
  assert.equal(bobineMic.getAttribute('aria-disabled'), null);
  // Out of any box: the place on screen, the Studio first; hidden, the Bobine. Its strip at the left of its microphone.
  fake.studioField.hidden = true;
  press(fake, 'm', fake.document.body, { ctrlKey: true });
  // (Its strip once the microphone is open.)
  await settled(() => Boolean(fake.ask.querySelector('.dictation-strip')));
  assert.equal(fake.dictation.busy('bobine'), true);
  assert.equal(fake.ask.querySelector('.dictation-strip').nextSibling, bobineMic);
  press(fake, 'Escape', fake.document.body);
  // Held by its place (the Bobine at work): greyed with its reason.
  fake.ask.dataset.working = 'true';
  fake.dictation.repaint();
  assert.equal(bobineMic.title, 'La Bobine travaille.');
  // Ctrl+Maj+M, Alt+Ctrl+M, a key held down: not the dictation's.
  for (const more of [{ shiftKey: true }, { altKey: true }, { repeat: true }])
    assert.equal(press(fake, 'm', fake.prompt, { ctrlKey: true, ...more }), false);
  assert.equal(fake.dictation.busy(), false);
});

test('a place drawn again while it listens gets its strip back; gone from the screen, what was said is written', async () => {
  const fake = dictationOn({ text: 'la mer se lève' });
  let mic = fake.dictation.mic('studio');
  fake.studioField.append(mic);
  await fake.dictation.refresh();
  await fake.dictation.toggle('studio');
  hear(fake, 0.6);
  // The Studio drawn again (render): a new field, a new microphone; the strip goes back in it.
  const field = new Element(fake.document, 'div', { className: 'studio-prompt-field' }),
    prompt = new Field(fake.document, { id: 'studio-prompt' });
  fake.studioField.remove();
  mic = fake.dictation.mic('studio');
  field.append(prompt, mic);
  fake.document.body.append(field);
  await settled(() => Boolean(field.querySelector('.dictation-strip')));
  assert.ok(field.classList.contains('is-dictating') && mic.classList.contains('is-listening'));
  assert.equal(prompt.placeholder, LISTEN_PLACEHOLDER);
  // Another page opened (the Studio hidden): the listening ends there, its words in that box.
  field.hidden = true;
  await settled(() => !fake.dictation.busy());
  assert.equal(prompt.value, 'la mer se lève');
  assert.equal(prompt.placeholder, '');
});

test('(0.6.455) Ctrl+M with the chat open over the Studio dictates in the chat; a box made inert is passed over', async () => {
  const fake = dictationOn(),
    studioMic = fake.dictation.mic('studio');
  fake.studioField.append(studioMic);
  await fake.dictation.refresh();
  // The chat open over the Studio, which is only blurred behind it: the box of the chat, not the prompt of the Studio.
  fake.document.body.dataset.chat = 'open';
  press(fake, 'm', fake.document.body, { ctrlKey: true });
  await settled(() => Boolean(fake.options.querySelector('.dictation-strip')));
  assert.equal(fake.dictation.busy('chat'), true);
  press(fake, 'Escape', fake.document.body);
  assert.equal(fake.dictation.busy(), false);
  // The Studio set by Moodix AI (inert): out of a box, the Bobine; a click on its microphone says why.
  delete fake.document.body.dataset.chat;
  fake.studioField.setAttribute('inert', '');
  press(fake, 'm', fake.document.body, { ctrlKey: true });
  await settled(() => Boolean(fake.ask.querySelector('.dictation-strip')));
  assert.equal(fake.dictation.busy('bobine'), true);
  press(fake, 'Escape', fake.document.body);
  await fake.dictation.toggle('studio');
  assert.equal(fake.notices.at(-1), 'Cette case est fermée pour le moment : la dictée ne peut pas y écrire.');
  assert.equal(fake.dictation.busy(), false);
});

test('(0.6.455) during « Transcription… »: Échap is not taken where the strip is gone, the focus stays where it went', async () => {
  const fake = dictationOn({ text: 'une vague' });
  await fake.dictation.refresh();
  let answer;
  fake.said.wait = new Promise(done => (answer = done));
  await fake.dictation.toggle('chat');
  hear(fake, 1);
  const finishing = fake.dictation.finish();
  await settled(() => fake.asked('dictation/transcribe').length === 1);
  // The bar of the chat out of sight (another page): Échap is for what is on screen, a menu, a list.
  fake.form.hidden = true;
  assert.equal(press(fake, 'Escape', fake.document.body), false);
  assert.equal(fake.dictation.busy('chat'), true);
  fake.form.hidden = false;
  // Another box clicked meanwhile: the words go in their box, the next keys in the one clicked.
  const other = new Field(fake.document, { id: 'negative' });
  fake.document.body.append(other);
  other.focus();
  answer();
  await finishing;
  assert.equal(fake.prompt.value, 'une vague');
  assert.equal(fake.document.activeElement, other);
  assert.deepEqual(fake.prompt.events, ['input']);
});

test('(0.6.455) another mode or conversation shown during « Transcription… »: the words are said, not written in it', async () => {
  const fake = dictationOn({ text: 'une vague qui se brise' });
  let scope = 'image';
  fake.studioField.append(fake.dictation.mic('studio', { scope: () => scope }));
  await fake.dictation.refresh();
  let answer;
  fake.said.wait = new Promise(done => (answer = done));
  await fake.dictation.toggle('studio');
  hear(fake, 1);
  const finishing = fake.dictation.finish();
  await settled(() => fake.asked('dictation/transcribe').length === 1);
  // « Vidéo » clicked: the same box, the prompt of Vidéo in it.
  scope = 'video';
  fake.studioPrompt.value = 'Un phare dans la nuit';
  fake.studioPrompt.setSelectionRange(21, 21);
  answer();
  await finishing;
  assert.equal(fake.studioPrompt.value, 'Un phare dans la nuit');
  assert.equal(fake.notices.at(-1), 'La case de la dictée n’est plus ouverte. Ce qui a été dit : « une vague qui se brise »');
  // In the same mode from end to end: written.
  fake.said.wait = undefined;
  await fake.dictation.toggle('studio');
  hear(fake, 1);
  await fake.dictation.toggle('studio');
  assert.equal(fake.studioPrompt.value, 'Un phare dans la nuit une vague qui se brise');
});

test('(0.6.455) a microphone that stops while it listens: what was said until then is written, and it is said', async () => {
  const fake = dictationOn({ text: 'un chat' });
  await fake.dictation.refresh();
  await fake.dictation.toggle('chat');
  hear(fake, 1);
  fake.tracks.at(-1).end();
  await settled(() => !fake.dictation.busy());
  assert.equal(fake.prompt.value, 'un chat');
  assert.equal(fake.notices.at(-1), 'Le micro s’est arrêté : ce qui a été dit jusque-là est écrit.');
});

// ------------------------------------------------------------------ Paramètres › Moodix AI › Dictée
function settingsOn({
  status,
  confirm = true,
  devices = [
    { kind: 'audioinput', deviceId: 'default' },
    { kind: 'audioinput', deviceId: 'usb', label: 'Micro USB' },
  ],
  mic = null,
} = {}) {
  const document = fakeDocument(),
    make = (tag, id) => new Element(document, tag, { id }),
    ids = ['dictation-settings', 'dictation-language', 'dictation-place', 'dictation-model', 'dictation-get'];
  ids.push('dictation-try', 'dictation-meter', 'dictation-state', 'settings');
  const elements = Object.fromEntries(ids.map(id => [id, make('div', id)]));
  elements['dictation-words'] = new Field(document, { id: 'dictation-words' });
  elements['dictation-mic'] = Object.assign(make('select', 'dictation-mic'), { value: '' });
  elements.settings.open = true;
  for (let index = 0; index < 10; index++) elements['dictation-meter'].append(make('i', ''));
  document.body.append(...Object.values(elements));
  const calls = [],
    asked = [],
    said = { status },
    api = async (route, body) => {
      calls.push({ route, body });
      if (route === 'dictation/settings') said.status = { ...said.status, settings: { ...body } };
      return { json: async () => said.status };
    },
    fake = fakePage({ devices }),
    { page } = fake,
    node = (tag, className = '', text = '') => Object.assign(new Element(document, tag, { className }), { textContent: text });
  // The microphone this browser keeps (`mic`).
  page.localStorage.getItem = () => mic;
  const ui = setupDictationSettings({
    $: id => elements[id] ?? null,
    node,
    api,
    dictation: { refresh: async () => calls.push({ route: 'refresh' }) },
    confirmFn: question => (asked.push(question), confirm),
    page,
  });
  return { ui, elements, calls, asked, said, fake };
}
const STATUS = {
  installed: false,
  model: { name: 'Qwen3-ASR 1.7B', bytes: 2.614 * GIB, left: 2.614 * GIB, license: { name: 'Apache-2.0', url: '' } },
  job: { state: 'idle', error: '' },
  engine: { state: 'stopped', place: null, error: '', note: '' },
  settings: { language: 'fr', place: 'cpu', words: '' },
  card: { available: false, reason: 'Pour la carte graphique, installez la version officielle de llama.cpp faite pour elle.' },
  maxSeconds: 120,
};

test('Paramètres › Dictée: its model with its licence, « Carte graphique » greyed with why, kept at « Enregistrer »', async t => {
  const previous = globalThis.Option;
  globalThis.Option = class extends Element {
    constructor(text, value) {
      super(null, 'option');
      Object.assign(this, { textContent: text, value });
    }
  };
  t.after(() => (globalThis.Option = previous));
  const { ui, elements, calls } = settingsOn({ status: STATUS });
  await ui.load();
  assert.equal(elements['dictation-model'].textContent, 'Qwen3-ASR 1.7B, d’Alibaba · 2,6 Go à télécharger · Apache 2.0');
  assert.equal(elements['dictation-get'].textContent, 'Télécharger');
  assert.equal(elements['dictation-get'].title, 'Licence Apache 2.0 : usage personnel et commercial permis.');
  assert.equal(elements['dictation-try'].disabled, true);
  assert.equal(elements['dictation-try'].title, 'Installez d’abord le modèle.');
  const [french, english] = elements['dictation-language'].children,
    [processor, card] = elements['dictation-place'].children;
  assert.deepEqual([french, english].map(choice => choice.getAttribute('aria-checked')), ['true', 'false']);
  assert.equal(processor.getAttribute('aria-checked'), 'true');
  assert.equal(card.getAttribute('aria-disabled'), 'true');
  assert.equal(card.title, STATUS.card.reason);
  // Greyed: a click does nothing.
  card.onclick();
  assert.equal(processor.getAttribute('aria-checked'), 'true');
  // The microphones of the browser, the system's first (its « default » and « communications » are that one).
  await settled(() => elements['dictation-mic'].children.length === 2);
  assert.deepEqual(
    elements['dictation-mic'].children.map(option => [option.textContent, option.value]),
    [
      ['Micro par défaut de Windows', ''],
      ['Micro USB', 'usb'],
    ],
  );
  // Nothing kept until « Enregistrer »; « Annuler » goes back.
  english.onclick();
  elements['dictation-words'].value = 'Moodix, Krea';
  elements['dictation-words'].oninput();
  assert.equal(ui.dirty(), true);
  assert.deepEqual(ui.draft(), { language: 'en', place: 'cpu', words: 'Moodix, Krea', mic: '' });
  ui.revert();
  assert.equal(ui.dirty(), false);
  assert.equal(french.getAttribute('aria-checked'), 'true');
  english.onclick();
  await ui.save();
  assert.deepEqual(calls.filter(call => call.route === 'dictation/settings').map(call => call.body), [{ language: 'en', place: 'cpu', words: '' }]);
  assert.equal(ui.dirty(), false);
  // Saved again unchanged: nothing asked of the server.
  await ui.save();
  assert.equal(calls.filter(call => call.route === 'dictation/settings').length, 1);
  assert.equal(CARD_TIP.length > 0, true);
});

test('Paramètres › Dictée: « Retirer » asks first, and « Carte graphique » is offered once a build for it is there', async t => {
  const previous = globalThis.Option;
  globalThis.Option = class extends Element {
    constructor(text, value) {
      super(null, 'option');
      Object.assign(this, { textContent: text, value });
    }
  };
  t.after(() => (globalThis.Option = previous));
  const installed = { ...STATUS, installed: true, model: { ...STATUS.model, left: 0 }, card: { available: true, label: 'CUDA 13.4' } };
  let { ui, elements, calls, asked } = settingsOn({ status: installed, confirm: false });
  await ui.load();
  assert.equal(elements['dictation-model'].textContent, 'Qwen3-ASR 1.7B · installé · 2,6 Go');
  assert.equal(elements['dictation-get'].textContent, 'Retirer');
  assert.equal(elements['dictation-try'].disabled, false);
  const card = elements['dictation-place'].children[1];
  assert.equal(card.getAttribute('aria-disabled'), null);
  assert.equal(card.title, CARD_TIP);
  elements['dictation-get'].onclick();
  await settled(() => asked.length === 1);
  assert.match(asked[0], /^Retirer la dictée de cet ordinateur \? Son modèle \(2,6 Go\)/);
  assert.equal(calls.some(call => call.route === 'dictation/remove'), false);
  ({ ui, elements, calls, asked } = settingsOn({ status: installed, confirm: true }));
  await ui.load();
  elements['dictation-get'].onclick();
  await settled(() => calls.some(call => call.route === 'refresh'));
  assert.equal(calls.some(call => call.route === 'dictation/remove'), true);
});

test('(0.6.455) Paramètres › Dictée: tips, microphones plugged in, « Essayer » let go out of sight', async t => {
  const previous = globalThis.Option;
  globalThis.Option = class extends Element {
    constructor(text, value) {
      super(null, 'option');
      Object.assign(this, { textContent: text, value });
    }
  };
  t.after(() => (globalThis.Option = previous));
  const { ui, elements, said, fake } = settingsOn({ status: STATUS });
  await ui.load();
  // As public/help-tips.mjs makes them: the title taken into the bubble. The model come, they go.
  for (const id of ['dictation-get', 'dictation-try']) elements[id].dataset.tip = elements[id].title;
  said.status = { ...STATUS, installed: true, model: { ...STATUS.model, left: 0 } };
  await ui.load();
  assert.equal(elements['dictation-try'].disabled, false);
  assert.deepEqual([elements['dictation-try'].dataset.tip, elements['dictation-get'].dataset.tip], [undefined, undefined]);
  // A microphone plugged in while the settings are open: in the list at once.
  await settled(() => elements['dictation-mic'].children.length === 2);
  fake.devices.push({ kind: 'audioinput', deviceId: 'casque', label: 'Casque' });
  for (const run of fake.plugged) run();
  await settled(() => elements['dictation-mic'].children.length === 3);
  assert.equal(elements['dictation-mic'].children[2].textContent, 'Casque');
  // « Essayer », then another tab of the settings: the microphone is let go.
  elements['dictation-try'].onclick();
  await settled(() => Boolean(fake.nodes[0]?.port.onmessage));
  fake.nodes[0].port.onmessage({ data: { level: 0.1 } });
  assert.ok(elements['dictation-meter'].children.some(segment => segment.classList.contains('is-on')));
  elements['dictation-settings'].hidden = true;
  fake.nodes[0].port.onmessage({ data: { level: 0.1 } });
  assert.equal(fake.tracks.at(-1).stopped, true);
  assert.equal(elements['dictation-try'].textContent, 'Essayer');
});

test('(0.6.455) the microphone chosen is said unplugged only where the browser says which are there', async t => {
  const previous = globalThis.Option;
  globalThis.Option = class extends Element {
    constructor(text, value) {
      super(null, 'option');
      Object.assign(this, { textContent: text, value });
    }
  };
  t.after(() => (globalThis.Option = previous));
  const listed = async devices => {
    const { ui, elements } = settingsOn({ status: STATUS, devices, mic: 'usb' });
    await ui.load();
    await settled(() => elements['dictation-mic'].children.length > 1);
    return elements['dictation-mic'].children.map(option => option.textContent);
  };
  // Before a microphone is allowed, the browser lists them without their identifiers: it may be there.
  assert.deepEqual(await listed([{ kind: 'audioinput', deviceId: '', label: '' }]), ['Micro par défaut de Windows', 'Micro choisi']);
  assert.deepEqual(await listed([{ kind: 'audioinput', deviceId: 'casque', label: 'Casque' }]), [
    'Micro par défaut de Windows',
    'Casque',
    'Micro choisi (débranché)',
  ]);
});
