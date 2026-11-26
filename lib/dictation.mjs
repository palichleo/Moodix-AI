import { availableParallelism } from 'node:os';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine, problem } from './engine.mjs';
import { LlamaBuilds, serverIn } from './llama-builds.mjs';
import { ModelDownloads } from './model-downloads.mjs';
import { atomicJson } from './update-files.mjs';

/**
 * La dictée (0.6.451): what is said into the microphone, written into the field by Qwen3-ASR 1.7B (Alibaba,
 * Apache-2.0), which a second llama-server runs apart from the chat's. Measured on this kind of computer (26/11,
 * claude_design/chat-vocal/ETUDE.md, 100 French sentences): 4 % of the words wrong, a sentence of 9 s written in
 * 1.7 s on the processor (8 threads) and in 0.3 s on the card, which then holds 3.6 GB.
 *
 * - On the processor, it runs on an official build of llama.cpp of its own (data/engines/dictation), downloaded
 *   with the model: the engine of the chat is never changed for it. On the card, on the newest official build
 *   installed for the chat (data/engines/llama.cpp) that is made for a card; with none, « Carte graphique » says
 *   where to install one.
 * - The two files of the model go to models/dictation, from runner/downloads.json (resumed, checked).
 * - Started at the click on the microphone (`warm`), while the user speaks; stopped five minutes after the last
 *   dictation. On the card, it leaves it to a generation as the chat model does (`release`), and a dictation made
 *   meanwhile runs on the processor.
 * - The sound never leaves this computer and is not kept: the WAV goes from the page to the engine in memory.
 */
export const MODEL = 'Qwen3-ASR-1.7B-Q8_0.gguf';
export const PROJECTOR = 'mmproj-Qwen3-ASR-1.7B-BF16.gguf';
export const LANGUAGES = ['fr', 'en', 'auto'];
export const PLACES = ['cpu', 'gpu'];
// The names of the models and of the LoRAs are added to these by themselves (vocabulary).
export const DEFAULT_WORDS = 'Moodix, Moodix AI, LoRA, prompt, 4K';
export const MAX_SECONDS = 120;
// PCM 16 bits, mono, 16 kHz: 32 000 bytes a second, with room for the header and a second more.
export const MAX_BYTES = 4096 + 32000 * (MAX_SECONDS + 1);
const RATE = 16000;
// Two minutes of speech are some 1 500 tokens of sound and 600 of text (measured, 26/11: 9.4 s of French are
// 150 tokens read and 47 written). The 64 K that llama.cpp takes by default kept 7 GB for nothing.
const CONTEXT = 4096;
const IDLE_MS = 5 * 60000;
// The words are read again at every dictation: a few dozen, not a dictionary.
const VOCABULARY_LENGTH = 400;
const DEFAULTS = Object.freeze({ language: 'fr', place: 'cpu', words: DEFAULT_WORDS });
export const UNAVAILABLE =
  'Dictée indisponible : son modèle n’est pas installé. Installez-le dans Paramètres › Moodix AI › Dictée.';
const NO_CARD =
  'Pour la carte graphique, installez la version officielle de llama.cpp faite pour elle : Paramètres › Mise à jour › Composants.';
/** What the downloads see of the dictation: a workflow shipped with Moodix, whose two files are fixed. */
const WORKFLOW = {
  id: 'dictation',
  name: 'Dictée',
  builtin: true,
  pipeline: 'dictation',
  components: {
    model: { policy: 'fixed', file: MODEL, asset: 'dictation-model' },
    projector: { policy: 'fixed', file: PROJECTOR, asset: 'dictation-projector' },
  },
};

/** The threads of the measures: 8, or half of what this processor runs at once when that is fewer. */
export const defaultThreads = (count = availableParallelism()) => Math.max(1, Math.min(8, Math.floor(count / 2)));

/** The settings of the dictation, what is not one of them taken from `base`. */
export function dictationSettings(input, base = DEFAULTS) {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    language: LANGUAGES.includes(given.language) ? given.language : base.language,
    place: PLACES.includes(given.place) ? given.place : base.place,
    words: typeof given.words === 'string' ? given.words.replace(/[\0\r]/g, '').slice(0, 2000) : base.words,
  };
}

/** A name as it is said: a LoRA's file name without its folders nor its extension, its « _ » as spaces. */
const spoken = name =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '')
    .replace(/_+/g, ' ');

/**
 * The words the model is told to expect: the user's first, then the names given (models, LoRAs), each once
 * whatever its case, within VOCABULARY_LENGTH characters. Measured on twelve requests to Moodix (26/11): 4.28 %
 * of the words wrong without them, 2.33 % with them.
 */
export function vocabulary(words = '', names = []) {
  const seen = new Set(),
    kept = [];
  let length = 0;
  for (const raw of [...String(words).split(/[,;\n]/), ...names.map(spoken)]) {
    const word = raw.replace(/\s+/g, ' ').trim();
    // A file named by a hash or a number says nothing to listen for.
    if (!word || word.length > 40 || !/\p{L}/u.test(word) || /^[0-9a-f]{12,}$/i.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    const added = (kept.length ? 2 : 0) + word.length;
    if (length + added > VOCABULARY_LENGTH) break;
    seen.add(key);
    kept.push(word);
    length += added;
  }
  return kept.join(', ');
}

/** The length in seconds of a WAV, once checked to be what the page sends: PCM 16 bits, mono, 16 kHz. */
export function wavSeconds(bytes) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const wrong = () => problem('Le son reçu n’est pas celui de la dictée (WAV PCM 16 bits, mono, 16 kHz).', 415);
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE')
    throw wrong();
  let format = null;
  for (let offset = 12; offset + 8 <= data.length; ) {
    const id = data.toString('latin1', offset, offset + 4),
      size = data.readUInt32LE(offset + 4),
      body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= data.length)
      format = {
        code: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        rate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      };
    else if (id === 'data') {
      if (format?.code !== 1 || format.channels !== 1 || format.rate !== RATE || format.bits !== 16) throw wrong();
      return Math.min(size, data.length - body) / (RATE * 2);
    }
    offset = body + size + (size % 2);
  }
  throw wrong();
}

/** What the engine wrote, as the field takes it (the marks of Qwen3-ASR, if any came through, left out). */
const cleanText = text =>
  String(text ?? '')
    .replace(/^\s*language\s+[a-z]+\s*<asr_text>/i, '')
    .replace(/<\/?asr_text>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

export class Dictation {
  constructor({
    dataDir,
    modelsDir,
    catalogPath,
    // The official builds of the chat (its LlamaBuilds): one made for a card runs the dictation there.
    chatBuilds = null,
    // Tests give their own builds, downloads and engine.
    builds = null,
    downloads = null,
    engine = null,
    spawnProcess,
    fetchImpl = fetch,
    // The names of the models and of the LoRAs, added to the words of the user.
    names = async () => [],
    // Whether a generation holds the card: a dictation started meanwhile runs on the processor.
    cardBusy = () => false,
    threads = defaultThreads(),
    idleMs = IDLE_MS,
    platform = process.platform,
    arch = process.arch,
  }) {
    this.folder = join(modelsDir, 'dictation');
    this.settingsPath = join(dataDir, 'dictation.json');
    this.program = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
    this.builds =
      builds ??
      new LlamaBuilds({
        root: join(dataDir, 'engines', 'dictation'),
        fetchImpl,
        platform,
        arch,
        // The processor build alone: the card, when it is chosen, takes the chat's (#cardEngine).
        detect: async () => ({ platform, arch, gpus: [] }),
      });
    this.downloads =
      downloads ??
      new ModelDownloads({
        catalogPath,
        dataDir,
        fetchImpl,
        families: () => ({ dictation: true }),
        folderOf: () => this.folder,
        assets: {
          // Found by their names in their folder, where the downloads leave them.
          resolve: async (_asset, { file }) => {
            const path = join(this.folder, file);
            if (!(await stat(path)).isFile()) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
            return { path };
          },
          register: async () => {},
        },
      });
    this.engine = engine ?? new Engine({ spawnProcess, cacheDir: join(dataDir, 'model-cache') });
    Object.assign(this, { chatBuilds, names, cardBusy, threads, idleMs, platform, arch });
    this.settings = { ...DEFAULTS };
    this.job = { state: 'idle' };
    this.chain = Promise.resolve();
    // Where the engine runs once started: { place, enginePath }.
    this.running = null;
    this.failure = '';
    this.note = '';
    this.cardFailed = false;
    this.timer = null;
    this.namesCache = null;
  }

  async load() {
    try {
      this.settings = dictationSettings(JSON.parse(await readFile(this.settingsPath, 'utf8')));
    } catch {
      this.settings = { ...DEFAULTS };
    }
    return this;
  }

  /** One thing at a time: the engine starts once, the dictations are written one after the other. */
  #queue(task) {
    const run = this.chain.then(task);
    this.chain = run.catch(() => {});
    return run;
  }

  /** The two files of the model, each with its size and whether it is here whole. */
  async #files() {
    const catalog = await this.downloads.catalog();
    const files = [];
    for (const file of [MODEL, PROJECTOR]) {
      const size = catalog[file]?.size ?? 0;
      const info = await stat(join(this.folder, file)).catch(() => null);
      files.push({ file, size, present: Boolean(info?.isFile() && (!size || info.size === size)) });
    }
    return files;
  }

  /** The newest build of `root` whose kind (`cpu`, `cuda-13.4`, `vulkan`…) matches, with its program. */
  async #buildIn(root, kinds) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    const builds = entries
      .map(entry => entry.isDirectory() && /^b(\d+)-(.+)$/i.exec(entry.name))
      .filter(match => match && kinds.test(match[2]))
      // The newest first; at the same number, CUDA before Vulkan.
      .sort((a, b) => Number(b[1]) - Number(a[1]) || /^cuda/i.test(b[2]) - /^cuda/i.test(a[2]));
    for (const [name, number, kind] of builds) {
      const path = await serverIn(join(root, name), this.program);
      if (path) return { path, tag: 'b' + number, kind };
    }
    return null;
  }

  #ownEngine() {
    return this.#buildIn(this.builds.root, /^(?:cpu|metal)$/i);
  }

  #cardEngine() {
    // A Mac has one build, which runs on its card as well.
    if (this.platform === 'darwin')
      return this.arch === 'arm64' ? this.#buildIn(this.builds.root, /^metal$/i) : Promise.resolve(null);
    return this.chatBuilds
      ? this.#buildIn(this.chatBuilds.root, /^(?:cuda-[\d.]+|vulkan|rocm[\d.-]*)$/i)
      : Promise.resolve(null);
  }

  async status() {
    const [files, own, card, catalog] = await Promise.all([
      this.#files(),
      this.#ownEngine(),
      this.#cardEngine(),
      this.downloads.catalog(),
    ]);
    const license = catalog[MODEL]?.license;
    return {
      installed: files.every(file => file.present) && Boolean(own),
      model: {
        name: 'Qwen3-ASR 1.7B',
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        left: files.reduce((sum, file) => sum + (file.present ? 0 : file.size), 0),
        license: license?.name ? { name: license.name, url: license.url || '' } : null,
      },
      job: this.#jobView(),
      engine: { state: this.engine.state, place: this.running?.place ?? null, error: this.failure, note: this.note },
      settings: { ...this.settings },
      card: card
        ? { available: true, label: card.kind.replace(/^cuda-/i, 'CUDA ').replace(/^vulkan$/i, 'Vulkan') }
        : { available: false, reason: NO_CARD },
      maxSeconds: MAX_SECONDS,
    };
  }

  /** The download as the page shows it: one bar, the engine of the dictation and its model together. */
  #jobView() {
    const job = this.job;
    if (job.state !== 'running') return { state: job.state, error: job.error ?? '' };
    if (job.step === 'engine') {
      const build = this.builds.status(),
        total = build.total ?? 0,
        received = build.state === 'downloading' ? (build.received ?? 0) : build.state === 'checking' ? 0 : total;
      return { state: 'running', received, total: total + job.modelBytes, current: build.step || '' };
    }
    const model = this.downloads.status();
    return {
      state: 'running',
      received: job.engineBytes + (model.received ?? 0),
      total: job.engineBytes + (model.total || job.modelBytes),
      current: model.current || '',
    };
  }

  /** Downloads what the dictation lacks: its build of llama.cpp, then the files of its model. */
  async download() {
    if (this.job.state === 'running') throw problem('La dictée se télécharge déjà.', 409);
    const files = await this.#files();
    const job = {
      state: 'running',
      step: 'engine',
      engineBytes: 0,
      modelBytes: files.reduce((sum, file) => sum + (file.present ? 0 : file.size), 0),
    };
    this.job = job;
    this.cancelled = false;
    this.task = this.#download(job).then(
      () => {
        if (this.job === job) this.job = { state: 'done' };
      },
      error => {
        if (this.job === job) this.job = this.cancelled ? { state: 'cancelled' } : { state: 'error', error: error.message };
      },
    );
    return this.status();
  }

  async #download(job) {
    if (!(await this.#ownEngine())) {
      await this.builds.install({ inUse: this.running?.enginePath ?? '' });
      job.engineBytes = this.builds.status().total ?? 0;
    }
    if (this.cancelled) throw problem('Téléchargement arrêté.');
    job.step = 'model';
    if (!(await this.downloads.missing(WORKFLOW)).length) return;
    await this.downloads.start(WORKFLOW);
    await this.downloads.task;
    const { state, error } = this.downloads.status();
    if (state !== 'done') throw problem(error || 'Téléchargement arrêté.', 502);
  }

  cancel() {
    if (this.job.state !== 'running') return;
    this.cancelled = true;
    this.builds.cancel();
    this.downloads.cancel();
  }

  /** « Retirer »: the files of the model and the build of the dictation leave this computer (its settings stay). */
  async remove() {
    if (this.job.state === 'running') throw problem('Arrêtez d’abord le téléchargement de la dictée.', 409);
    await this.#queue(() => this.stop());
    // (Windows lets go of a program a moment after it ended: tried again a second.)
    const gone = { force: true, maxRetries: 5, retryDelay: 200 };
    for (const file of [MODEL, PROJECTOR]) {
      await rm(join(this.folder, file), gone);
      await rm(join(this.folder, file) + '.part', gone);
    }
    await rm(this.builds.root, { ...gone, recursive: true });
    this.job = { state: 'idle' };
    this.failure = '';
    this.cardFailed = false;
    return this.status();
  }

  /** The settings of Paramètres › Moodix AI › Dictée; asked elsewhere, the engine starts again there. */
  async save(input) {
    const next = dictationSettings(input, this.settings),
      moved = next.place !== this.settings.place;
    await atomicJson(this.settingsPath, next);
    this.settings = next;
    if (moved) {
      this.cardFailed = false;
      await this.#queue(() => this.stop());
    }
    return this.status();
  }

  /** The microphone is clicked: the engine starts while the user speaks. */
  warm() {
    void this.#queue(() => this.#ensure()).catch(() => {});
  }

  /** Where this dictation runs: the card when it is chosen, has its build and no generation holds it. */
  async #placeNow() {
    if (this.settings.place !== 'gpu') {
      this.note = '';
      return 'cpu';
    }
    // Refused by the card a moment ago: not asked again at every dictation, until the engine has rested.
    if (this.cardFailed) return 'cpu';
    if (this.cardBusy()) {
      this.note = 'Une génération occupe la carte graphique : la dictée tourne sur le processeur jusqu’à sa fin.';
      return 'cpu';
    }
    if (!(await this.#cardEngine())) {
      this.note = NO_CARD;
      return 'cpu';
    }
    this.note = '';
    return 'gpu';
  }

  async #ensure() {
    const place = await this.#placeNow();
    if (this.engine.state === 'ready' && this.running?.place === place) return this.#touch();
    if (this.engine.state !== 'stopped') await this.engine.stop();
    this.running = null;
    this.failure = '';
    try {
      await this.#start(place);
    } catch (error) {
      if (place !== 'gpu' || error.status === 409) throw this.#failed(error);
      // The card refused it (no room left, a build that does not read this model): the processor takes it.
      this.cardFailed = true;
      this.note = `La carte graphique n’a pas pu prendre la dictée (${this.#said() || error.message}) : elle tourne sur le processeur.`;
      await this.engine.stop().catch(() => {});
      try {
        await this.#start('cpu');
      } catch (second) {
        throw this.#failed(second);
      }
    }
    this.#touch();
  }

  async #start(place) {
    const own = await this.#ownEngine();
    if (!own || !(await this.#files()).every(file => file.present)) throw problem(UNAVAILABLE, 409);
    const card = place === 'gpu' ? await this.#cardEngine() : null,
      running = { place: card ? 'gpu' : 'cpu', enginePath: card?.path ?? own.path };
    // Known from the launch on: a generation that starts while it loads on the card has it stopped (release).
    this.running = running;
    try {
      await this.engine.start({
        enginePath: running.enginePath,
        modelPath: join(this.folder, MODEL),
        projectorPath: join(this.folder, PROJECTOR),
        contextSize: CONTEXT,
        gpuLayers: card ? 999 : 0,
        threads: this.threads,
      });
      // start() returns once the program is launched: the model is waited for, loaded or failed.
      while (this.engine.state === 'loading') await delay(50);
      if (this.engine.state !== 'ready') throw problem(this.engine.error || 'Le moteur de la dictée s’est arrêté.', 502);
    } catch (error) {
      if (this.running === running) this.running = null;
      throw error;
    }
  }

  /**
   * What llama.cpp said of its stop, when it said something (its time, level and function left out): the reason,
   * where the engine only knows that it stopped.
   */
  #said() {
    const line = [...this.engine.logs].reverse().find(text => /\b(?:error|failed|unknown|unable|cannot)\b/i.test(text));
    return (line ?? '')
      .replace(/^[\d.]+\s+[A-Z]\s+/, '')
      .replace(/^\w+:\s+/, '')
      .trim()
      .slice(0, 200);
  }

  /** Why the engine did not start, in the words of llama.cpp when it gave some. */
  #failed(error) {
    if (error.status === 409) return error;
    const said = this.#said();
    this.failure = `Le moteur de la dictée n’a pas démarré : ${said ? `llama.cpp dit « ${said} »` : error.message}`;
    return problem(this.failure, 502);
  }

  /** Five minutes after the last dictation, the engine stops and gives its memory back. */
  #touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      // Rested, the card is asked again next time: what held it may have let it go.
      this.cardFailed = false;
      void this.#queue(() => this.stop()).catch(() => {});
    }, this.idleMs);
    this.timer.unref?.();
  }

  async #names() {
    if (!this.namesCache || Date.now() - this.namesCache.at > 60000) {
      let names = [];
      try {
        names = await this.names();
      } catch {
        /* Without the names, the words of the user alone. */
      }
      this.namesCache = { at: Date.now(), names };
    }
    return this.namesCache.names;
  }

  /** The text of what the WAV says, written by the engine; `signal`: the page gave up (Échap, closed). */
  async transcribe(wav, { signal } = {}) {
    const seconds = wavSeconds(wav);
    if (seconds > MAX_SECONDS + 1) throw problem('La dictée dure deux minutes au plus.', 413);
    // Under a third of a second, nothing was said.
    if (seconds < 0.3) return { text: '', seconds };
    return this.#queue(async () => {
      signal?.throwIfAborted();
      await this.#ensure();
      signal?.throwIfAborted();
      const form = new FormData();
      form.set('model', 'dictation');
      form.set('response_format', 'json');
      if (this.settings.language !== 'auto') form.set('language', this.settings.language);
      const prompt = vocabulary(this.settings.words, await this.#names());
      if (prompt) form.set('prompt', prompt);
      form.set('file', new Blob([wav], { type: 'audio/wav' }), 'dictee.wav');
      const began = performance.now();
      let response;
      try {
        response = await fetch(`${this.engine.base}/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.engine.apiKey}` },
          body: form,
          signal: AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]),
        });
      } catch (error) {
        if (signal?.aborted) throw problem('Dictée annulée.', 499);
        throw problem(`Le moteur de la dictée ne répond pas : ${error.message}`, 502);
      } finally {
        this.#touch();
      }
      if (!response.ok) throw problem(`Le moteur de la dictée n’a pas pu écrire ce son (${response.status}).`, 502);
      const body = await response.json();
      return { text: cleanText(body.text), seconds, spent: Math.round(performance.now() - began) / 1000 };
    });
  }

  async stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.running = null;
    await this.engine.stop();
  }

  /** A generation wants the card: the dictation that runs there stops, once the one being written is done. */
  async release() {
    if (this.running?.place !== 'gpu') return false;
    await this.#queue(() => (this.running?.place === 'gpu' ? this.stop() : null));
    return true;
  }

  async close() {
    this.cancel();
    await this.task?.catch(() => {});
    await this.downloads.close?.();
    clearTimeout(this.timer);
    await this.engine.stop().catch(() => {});
  }
}
