import { moveManifests } from './output-manifests.mjs';
import { outputName } from './output-names.mjs';
import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { GenerationWorker } from './generation-worker.mjs';
import { PythonEnvironment, environmentVariables } from './python-environment.mjs';
// (0.6.479) By its namespace: a stand-in of the environment (tests/update-e2e.mjs) need not say what it weighs.
import * as pythonEnvironment from './python-environment.mjs';
import { GenerationAssets, shippedFiles, suggestTokenizer } from './generation-assets.mjs';
import { NativeWorkflowCatalog } from './native-workflows.mjs';
import { ModelVersions, versionName, withSettings, withVersion } from './model-versions.mjs';
import { versionComponent } from './model-files.mjs';
import { ModelDownloads } from './model-downloads.mjs';
import { generatedMedia } from './generated-media.mjs';
import { extractStill } from './video-still.mjs';
import { readFilm } from './take-film.mjs';
import { problem } from './engine.mjs';
import { atomicFile, plainFolder } from './update-files.mjs';
import { families, family, familyCatalog } from './families.mjs';
import { MODEL_TREE, namesFor } from './model-tree.mjs';

// The picture so far, as the built-in engine sends it at every step: a JPEG of a few kilobytes
// in base64 (runner/preview.py). Larger, or anything but a JPEG, it is dropped.
const PREVIEW_LIMIT = 2 * 1024 * 1024;
/**
 * A progress message of the built-in engine as the generation expects it: its preview turned
 * into { preview: { bytes, mime } }; null for a preview that is not one.
 */
export function nativeProgress(data) {
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'preview')) return data;
  const { mime, data: text } = data.preview ?? {};
  if (mime !== 'image/jpeg' || typeof text !== 'string' || text.length > (PREVIEW_LIMIT / 3) * 4) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return { preview: { bytes, mime } };
}

// The files the engine writes a creation in before it puts it in its place (runner/media.py,
// runner/video/): under the name of the creation, in the folder of the outputs itself.
const TEMPORARY_ENDINGS = ['.tmp.mp4', '.tmp.wav', '.tmp.mux.mp4', '.mux.mp4', '.png.tmp', '.wav.tmp'];
/** Removes what a creation that did not end left half-written; only files of that very name. */
export async function leftTemporaries(outputDir, name) {
  if (!outputDir || !outputName(name)) return;
  for (const ending of TEMPORARY_ENDINGS) await rm(join(outputDir, name + ending), { force: true }).catch(() => {});
}
// The same for the model files the built-in engine keeps in RAM between generations. Measured on
// 32 GiB after a Krea 2 image (13.5 + 4.9 GiB kept), the chat model then loaded and the next image
// made: with nothing given back, the chat ready in 4.8 to 7.1 s (once 26.9 s) and 0.7 GiB left
// beside it; with everything given back (5 GiB here), 3.5 s but the next image 22 s instead of
// 12; with 2 GiB, the text encoder leaves, the model stays: 4.9 s, 5 GiB left, next image 14 s.
const NATIVE_KEEP_ABOVE = 2 * 1024 ** 3;
const STAGED_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
/** Generations a message at most, for every conversation. */
export const MAX_GENERATIONS = 100;
const defaults = {
  enabled: true,
  autoAllow: false,
  // A video agreed on in the conversation starts by itself: Moodix AI clicks « Générer ».
  autoAllowVideos: true,
  // A character replaced in a video is asked for again before it runs (its image, when Moodix AI
  // made it, is always shown to be kept or made again).
  confirmReplacements: false,
  // 100 generations a message at most: imposed by the server, written nowhere in the interface.
  maxIterations: 100,
  // After a video, the chat model reloads and comments a storyboard of it: about a minute.
  // Off, the video ends the turn and the model looks at it when the user asks.
  reviewVideos: false,
  // The same for an image: the model reloads and looks at the picture it made.
  reviewImages: false,
  // The engine imports its libraries as it starts (runner/warm.py, 0.6.105): the first creation
  // of a session begins about five seconds sooner (21.5 s to 16.2 s for a Krea 2 picture, in the
  // application), for 0.7 GiB of RAM held from the launch. On unless the user turns it off.
  warmEngine: true,
  pythonPath: '',
  // The models directory, sorted as ComfyUI sorts its own: ComfyUI's, or Atelier's when empty.
  modelsDir: '',
  modelRoot: '',
  vaeRoot: '',
  loraRoot: '',
  textEncoderRoot: '',
  tokenizerRoot: '',
  upscaleRoot: '',
  latentUpscaleRoot: '',
};
// A folder apart for one kind of file, when it is not where the models directory has it;
// absent from settings saved before they existed.
const ROOTS = [
  'modelRoot',
  'vaeRoot',
  'loraRoot',
  'textEncoderRoot',
  'tokenizerRoot',
  'upscaleRoot',
  'latentUpscaleRoot',
];
// Which of them holds the files a family manifest sorts under `folder`.
const ROOT_OF = {
  diffusion_models: 'modelRoot',
  vae: 'vaeRoot',
  text_encoders: 'textEncoderRoot',
  loras: 'loraRoot',
  upscale_models: 'upscaleRoot',
  latent_upscale_models: 'latentUpscaleRoot',
};
/** Every folder setting: the models directory, then the folders apart. */
export const FOLDER_KEYS = ['modelsDir', ...ROOTS];
// (0.6.481) The file of a version of a model downloaded on its own, from its row in « Modèles » (versionWorkflow).
const VERSION_ASSET = /^version-[0-9a-f]{24}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const sameFile = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/**
 * (0.6.481) The registry of the files as ModelDownloads reads it: the file of a version downloaded on its own is
 * found by its name only. Any other file of its model stands in for one that is not here (GenerationAssets.pick):
 * with one there, that version was never offered (De base with Omni, Omni with De base).
 */
function exactVersions(assets) {
  return new Proxy(assets, {
    get(target, key) {
      if (key === 'resolve')
        return async (id, options = {}) => {
          if (!VERSION_ASSET.test(String(id))) return target.resolve(id, options);
          const path = options.file ? await target.locate(options.file) : null;
          if (!path) throw Object.assign(new Error(`Asset ${id} not found`), { status: 400 });
          return { id, path, kind: options.kind, family: options.family };
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
/**
 * (0.6.481) The versions of a model Moodix can download that this computer lacks: the one it ships it with, and
 * those its family names (`model.downloads`, runner/families). Each with its name and what downloads it
 * (`download`): the workflow itself when that is the file it reads and nothing stands in for it (`used`), else
 * that version on its own.
 */
function absentVersions(workflow, listed, about) {
  const manifest = families()[workflow.pipeline],
    wanted = workflow.components?.[listed.role]?.file;
  return [...new Set([listed.provided, ...(about.downloads ?? [])].filter(file => typeof file === 'string' && file))]
    .filter(file => !listed.versions.some(version => sameFile(version.file, file)))
    .map(file => ({
      file,
      name: versionName(file, manifest),
      download:
        sameFile(file, wanted) && !listed.used
          ? workflow.id
          : `${workflow.id}_v${digest(file.toLowerCase()).slice(0, 16)}`,
    }));
}
export function generationConfig(value) {
  if (
    !value ||
    typeof value.enabled !== 'boolean' ||
    typeof value.autoAllow !== 'boolean' ||
    (value.maxIterations !== undefined &&
      (!Number.isInteger(value.maxIterations) || value.maxIterations < 1 || value.maxIterations > 10000)) ||
    !['boolean', 'undefined'].includes(typeof value.reviewVideos) ||
    !['boolean', 'undefined'].includes(typeof value.reviewImages) ||
    !['boolean', 'undefined'].includes(typeof value.autoAllowVideos) ||
    !['boolean', 'undefined'].includes(typeof value.confirmReplacements) ||
    !['boolean', 'undefined'].includes(typeof value.warmEngine)
  )
    throw problem('Paramètres de génération invalides.');
  const result = {
    enabled: value.enabled,
    autoAllow: value.autoAllow,
    // Whatever a configuration of before kept: 100 (parametres-maquette.md).
    maxIterations: MAX_GENERATIONS,
    // Absent from settings saved before the choice existed: videos allowed, nothing looked at.
    reviewVideos: value.reviewVideos === true,
    reviewImages: value.reviewImages === true,
    autoAllowVideos: value.autoAllowVideos !== false,
    confirmReplacements: value.confirmReplacements === true,
    // Absent from settings saved before it existed: on.
    warmEngine: value.warmEngine !== false,
  };
  // The tokenizer belongs to each workflow now; an older saved tokenizerPath is ignored here
  // and moved into the workflows once (GenerationService.init).
  for (const key of ['pythonPath', ...FOLDER_KEYS]) {
    if (FOLDER_KEYS.includes(key) && value[key] === undefined) {
      result[key] = '';
      continue;
    }
    if (typeof value[key] !== 'string' || value[key].length > 4096 || /[\x00\r\n]/.test(value[key]))
      throw problem('Chemin de génération invalide.');
    result[key] = value[key].trim().replace(/^"(.*)"$/, '$1');
    if (result[key] && !isAbsolute(result[key])) throw problem('Un chemin absolu est requis.');
  }
  return result;
}
export class GenerationService {
  constructor({
    root,
    dataDir,
    workflowDir,
    builtinWorkflowDir = null,
    outputDir,
    worker,
    environment,
  } = {}) {
    Object.assign(this, { root, dataDir, outputDir });
    this.path = join(dataDir, 'generation.json');
    this.workerPath = join(dataDir, 'runner-config.json');
    this.config = { ...defaults };
    this.worker = worker || new GenerationWorker({ root });
    this.environment = environment || new PythonEnvironment({ root, dataDir });
    this.worker.onLibrariesFailed = () => void this.#librariesFailed();
    this.assets = new GenerationAssets(join(dataDir, 'generation-assets.json'), {
      // A shared workflow's files: every folder a kind of file may be in, the models directory
      // itself (its other folders, one level down), and what is next to a folder set apart.
      roots: () => [
        ...this.searchFolders(),
        this.modelsDir(),
        join(root, 'models'),
        ...ROOTS.map(key => this.config[key])
          .filter(Boolean)
          .map(dirname),
      ],
      // Where a component no workflow fixes takes its file.
      folder: (family, kind) => this.foldersOf(family, kind),
      // (0.6.479) The files Moodix ships and what for, read once: one of another model never stands
      // for a file of these (GenerationAssets.pick).
      shipped: () => (this.shippedNames ??= shippedFiles(builtinWorkflowDir, this.catalogPath).catch(() => null)),
    });
    this.catalogPath = builtinWorkflowDir
      ? join(builtinWorkflowDir, '..', 'downloads.json')
      : join(dataDir, 'no-downloads');
    const engineBytes = pythonEnvironment.preparationBytes?.(this.environment.platform) ?? 0;
    // The files of the shipped workflows, downloadable from runner/downloads.json (next to them).
    this.downloads = new ModelDownloads({
      catalogPath: this.catalogPath,
      dataDir,
      // (0.6.481) A version downloaded on its own is found by its name only (exactVersions).
      assets: exactVersions(this.assets),
      folderOf: (family, role) => this.folderOf(family, role),
      convert: (from, to, options) => this.convertModel(from, to, options),
      // (0.6.479) A model whose files just came is one to use: its engine starts for it.
      onDone: () => this.#downloaded(),
      // (0.6.479) The engine of a new installation, prepared by the « Télécharger » of a model (the user's choice of
      // 27/11, « Oui, d'un seul clic »): about what it downloads, whether it is to prepare, its preparation. None
      // where it does not run (preparationBytes 0: neither Windows nor Linux).
      engine:
        engineBytes > 0
          ? {
              bytes: engineBytes,
              needed: () => this.#engineNeeded(),
              prepare: signal => this.#prepareEngine(signal),
              progress: () =>
                this.environment.status?.().state === 'installing' ? 'Préparation du moteur' : 'Démarrage du moteur',
            }
          : null,
    });
    // Shipped workflows come with the application (an update replaces them); the user's own and
    // their edits of shipped ones stay in workflowDir, which updates never touch.
    // (0.6.117) The version of each model the user keeps (the page « Modèles »): none kept, the
    // shipped workflows are made as shipped.
    this.versions = new ModelVersions({
      statePath: join(dataDir, 'model-versions.json'),
      assets: this.assets,
    });
    this.catalog = new NativeWorkflowCatalog(workflowDir, {
      assets: this.assets,
      versions: this.versions,
      builtin: builtinWorkflowDir,
      statePath: join(dataDir, 'workflow-natives.json'),
      historyPath: builtinWorkflowDir ? join(builtinWorkflowDir, '..', 'workflow-history.json') : null,
    });
    this.inputDir = join(dataDir, 'runner-input');
  }
  /**
   * A few small pictures of a video of the outputs (runner.video.frames): [{ time, url }], or []
   * when the engine is busy or cannot read it. Never waits behind a generation.
   */
  async videoFrames(path, count = 3) {
    if (!this.worker?.idle?.()) return [];
    try {
      const result = await this.worker.request('frames', { path, count, side: 512 }, { timeoutMs: 30000 });
      return Array.isArray(result?.frames) ? result.frames.filter(frame => typeof frame?.url === 'string') : [];
    } catch {
      return [];
    }
  }
  /**
   * (0.6.136) A film assembled by the engine from creations of the outputs (runner/video/montage.py):
   * what a generation returns, { jobId, outputs, metadata }. Asked while a creation is being made, it
   * is assembled after it. No model is loaded for it, and none leaves the card.
   * (0.6.429) Its 30 minutes run from the moment the engine starts on it, and while it is asked for the
   * engine is busy (generation-worker.mjs). Stopped before its end, what it was writing goes.
   */
  async assembleFilm(request, { onProgress, signal } = {}) {
    if (this.worker.status().state !== 'ready') await this.start();
    try {
      return await this.worker.request('assemble', request, { onProgress, signal, timeoutMs: 1800000 });
    } catch (error) {
      await leftTemporaries(this.outputDir, request?.outputName);
      throw error;
    }
  }
  /**
   * The first or the last picture of a video file, at its own size (lib/video-still.mjs): { bytes,
   * width, height, preview }. Read by the Python of the engine in a command of its own, on the
   * processor: it needs neither the worker nor the card, and waits behind nothing. The environment
   * is used as it is: never installed nor updated for this.
   */
  async videoStill(path, at) {
    const { python, env } = await this.#enginePython();
    return extractStill({
      python,
      root: this.root,
      input: path,
      at,
      workDir: join(this.dataDir, 'runtime', 'tmp'),
      env,
      run: this.environment.run,
    });
  }
  /**
   * (0.6.459, Bobine Pro) What the piece of a take shows on the timeline of the Bobine (lib/take-film.mjs): the
   * loudness of its sound and, for a video (`pictures`), pictures taken in it at regular intervals. As
   * `videoStill`: a command of its own on the processor, the environment used as it is.
   */
  async takeFilm(path, { pictures = true } = {}) {
    const { python, env } = await this.#enginePython();
    return readFilm({
      python,
      root: this.root,
      input: path,
      pictures,
      workDir: join(this.dataDir, 'runtime', 'tmp'),
      env,
      run: this.environment.run,
    });
  }
  /** The engine's Python as it is ('' without one: never installed for this), and its variables. */
  async #enginePython() {
    const python =
      this.config.pythonPath || ((await this.environment.exists()) ? (this.environment.interpreter?.() ?? '') : '');
    return { python, env: environmentVariables(join(this.dataDir, 'runtime')) };
  }
  /**
   * (0.6.223) A model file written again in the engine's own format (runner/convert.py, INT8 ConvRot):
   * what a download does of a file published in a format the engine does not read (the two of Wan 2.2
   * Fun Camera). By the Python of the engine in a command of its own, on the processor: a minute and
   * a half for 14 GiB, and neither the worker nor the card is asked. The environment is used as it
   * is, as for `videoStill`: without it, the file cannot be converted here, and that is said.
   */
  async convertModel(from, to, { signal } = {}) {
    const { python, env } = await this.#enginePython();
    if (!python || typeof this.environment.run !== 'function')
      throw problem(
        'Ce fichier se convertit avec le moteur de génération, qui n’est pas encore installé : lancez une première création, puis reprenez le téléchargement.',
        409,
      );
    await this.environment.run(python, ['-s', '-m', 'runner.convert', from, to, '--device', 'cpu'], {
      cwd: this.root,
      env,
      signal,
    });
  }
  async init() {
    let stored;
    try {
      stored = JSON.parse(await readFile(this.path, 'utf8'));
      this.config = generationConfig(stored);
    } catch (error) {
      if (error.code !== 'ENOENT') this.warning = 'Configuration de génération illisible.';
    }
    if (typeof stored?.tokenizerPath === 'string') await this.#migrateTokenizer(stored.tokenizerPath.trim());
    // Atelier's own models directory is sorted as ComfyUI's: its folders are there to be filled.
    for (const name of MODEL_TREE) await mkdir(join(this.root, 'models', name), { recursive: true }).catch(() => {});
    try {
      await this.catalog.adoptShipped();
    } catch (error) {
      this.warning = 'Workflows fournis non vérifiés : ' + error.message;
    }
    return this;
  }
  /**
   * Older versions kept one tokenizer folder for the whole application. It moves into every
   * workflow whose family needs one and has none yet, then leaves the configuration file.
   */
  async #migrateTokenizer(path) {
    const failures = [];
    if (path) {
      const workflows = await this.catalog.list().catch(() => []);
      for (const listed of workflows) {
        if (listed.importDraft) continue;
        const roles = Object.entries(families()[listed.pipeline]?.components || {}).filter(
          ([role, spec]) => spec.format === 'tokenizer' && !listed.components[role],
        );
        if (!roles.length) continue;
        try {
          const workflow = await this.catalog.read(listed.id);
          for (const [role] of roles) {
            const asset = await this.assets.register({ path, kind: role, family: workflow.pipeline });
            workflow.components[role] = { policy: 'fixed', asset: asset.id };
          }
          await this.catalog.save(workflow);
        } catch (error) {
          failures.push(`${listed.name} : ${error.message}`);
        }
      }
    }
    if (failures.length) {
      this.warning = 'Tokenizer à choisir dans les workflows : ' + failures.join(' · ');
      return;
    }
    await atomicFile(this.path, JSON.stringify(this.config, null, 2));
  }
  /** The tokenizer folder that matches a registered text encoder, registered for that family, or null. */
  async suggestTokenizer(encoderId, family) {
    const manifest = families()[family];
    const entry = Object.entries(manifest?.components || {}).find(([, spec]) => spec.format === 'tokenizer');
    if (!entry) throw problem('Cette famille n’utilise pas de tokenizer séparé.');
    const [role, spec] = entry;
    const encoder = await this.assets.resolve(encoderId, { kind: spec.vocabularyOf, family });
    const known = (await this.assets.list()).filter(asset => asset.kind === role).map(asset => asset.path);
    const found = await suggestTokenizer(encoder.path, known);
    if (!found) return { asset: null };
    return { asset: await this.assets.register({ path: found.path, kind: role, family }) };
  }
  async save(value) {
    const next = generationConfig(value);
    const changed = next.pythonPath !== this.config.pythonPath,
      enabling = !this.config.enabled && next.enabled,
      disabling = this.config.enabled && !next.enabled;
    await mkdir(this.dataDir, { recursive: true });
    await atomicFile(this.path, JSON.stringify(next, null, 2));
    this.config = next;
    if (changed || disabling) {
      await this.environment.cancel();
      await this.worker.close();
      await this.starting?.catch(() => {});
    }
    // Started when generation was just switched on or its Python changed, or again once its
    // environment is there: saving other settings never downloads it.
    if (
      next.enabled &&
      (changed ||
        enabling ||
        (this.worker.status().state !== 'ready' && (next.pythonPath || (await this.environment.exists()))))
    )
      void this.start().catch(() => {});
    return this.snapshot();
  }
  start() {
    if (this.closing) return Promise.reject(problem('Le moteur de génération est fermé.', 503));
    return (this.starting ||= this.#start().finally(() => {
      this.starting = null;
    }));
  }
  async prepareOnLaunch() {
    if (this.closing) return;
    // Its environment is there, or a Python of the user's: nothing to download.
    const prepared = Boolean(this.config.pythonPath) || (await this.environment.exists());
    // On (the default), the engine starts with the application once its environment is there;
    // a new installation downloads it only when asked (« Tester », switching generation on, and
    // (0.6.479) the « Télécharger » of a model, which prepares it with the files).
    if (this.config.enabled) return prepared && !this.closing ? this.start() : undefined;
    if (!this.config.pythonPath && prepared && !this.closing) await this.environment.ensure();
  }
  /**
   * (0.6.479) Whether « Télécharger » of a model prepares the engine as well: no Python of the user's, none
   * being prepared, and no preparation of its own gone to its end here (a new installation, or one stopped
   * on the way). It stayed « arrêté » on a new installation, the model just downloaded unable to make
   * anything (27/11), until « Vérifier l’environnement » (Paramètres › Mise à jour › Composants).
   */
  async #engineNeeded() {
    const environment = this.environment;
    if (this.config.pythonPath || this.closing || this.worker.status().state === 'ready') return false;
    if (environment.status?.().state === 'installing') return false;
    const prepared =
      typeof environment.prepared === 'function' ? await environment.prepared() : await environment.exists?.();
    return (this.unprepared = prepared === false);
  }
  /**
   * (0.6.479) The engine of a download: its environment prepared, then started (generation on). « Arrêter »
   * stops it: what uv brought in full stays in its cache, and the next « Télécharger » goes on from there.
   */
  async #prepareEngine(signal) {
    const stop = () => void this.environment.cancel?.();
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      if (this.config.enabled) await this.start();
      else await this.environment.ensure({ engineReads: this.config.warmEngine !== false });
      this.unprepared = false;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  /**
   * (0.6.479) The files of a model just came: its engine starts for it when its environment is there and it
   * is stopped (on a new installation, the download prepared and started it already).
   */
  #downloaded() {
    const { state, recovering } = this.worker.status();
    if (this.config.enabled && !this.closing && state !== 'ready' && !recovering && !this.unprepared)
      void this.start().catch(() => {});
  }
  async #start() {
    const config = { ...this.config };
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.outputDir, { recursive: true });
    await plainFolder(join(this.dataDir, 'runtime', 'tmp'), true);
    await writeFile(
      this.workerPath,
      JSON.stringify({
        cacheRoot: join(this.dataDir, 'generation-cache'),
        outputRoot: this.outputDir,
        // The manifest of each creation (its whole job, to make it again) apart: the folder of
        // the creations holds only them.
        manifestRoot: join(this.dataDir, 'output-manifests'),
        // Its libraries imported as it starts, not at its first creation (runner/warm.py).
        warm: config.warmEngine !== false,
      }),
      { mode: 0o600 },
    );
    // Those an earlier version left beside the creations join them, once.
    void moveManifests(this.outputDir, join(this.dataDir, 'output-manifests')).catch(() => {});
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    // (0.6.110) An engine that imports its libraries as it starts is their check: the one made in a
    // process of its own before it is skipped while nothing changed (lib/python-environment.mjs).
    const pythonPath =
      config.pythonPath || (await this.environment.ensure({ engineReads: config.warmEngine !== false }));
    // (0.6.479) Prepared now, whoever asked (a creation of the chat, « Vérifier l’environnement »).
    this.unprepared = false;
    if (this.closing) throw problem('Le moteur de génération est fermé.', 503);
    await this.worker.start({
      pythonPath,
      configPath: this.workerPath,
      env: environmentVariables(join(this.dataDir, 'runtime')),
    });
    this.syncCapabilities();
    return this.worker.status();
  }
  /**
   * (0.6.110) The engine could not import one of its libraries. When its environment was taken as
   * checked at this start (the check skipped), that trust is withdrawn and the engine started again:
   * the start then checks the environment as every start did, and says what it finds where a
   * failed start says it. An environment checked at this start is left alone: the failure is the
   * creation's own, and is said there.
   */
  async #librariesFailed() {
    if (this.closing || this.config.pythonPath || !(await this.environment.distrust?.())) return;
    // (A start still on its way ends first: the one below must be a new one, which checks.)
    await this.starting?.catch(() => {});
    await this.worker.close();
    await this.start().catch(() => {});
    this.syncCapabilities();
  }
  /**
   * (0.6.118) The lines of the page « Modèles », in its order (Image, Vidéo, Son, Retouches): one a
   * model, { name, does, group, order, workflows: [{ id, family, version?, used?, provided?,
   * versions? }] }. A model is what its family says it is (`model`, runner/families); the workflows
   * Moodix ships for it are its `workflows` (Real-ESRGAN has two: images, videos), each with its
   * versions when its file is one to choose (lib/model-versions.mjs), else the name of the one
   * version it has (`version`). A workflow created or imported by the user is no line.
   * (0.6.481) A line says the section it is shown in when it is not its own (`section`: pi H3 in MiniMax H3),
   * and a model with versions those Moodix can download that are not here (`absent`: absentVersions).
   */
  async models(workflows) {
    const lines = new Map();
    for (const workflow of workflows ?? (await this.catalog.list())) {
      if (!workflow.builtin) continue;
      const about = families()[workflow.pipeline]?.model;
      if (!about) continue;
      const shipped = await this.catalog.shippedOf(workflow.id),
        listed = shipped ? await this.versions.list(shipped, { effective: workflow }) : null,
        { name, does, group, order, section } = about,
        line = lines.get(name) ?? { name, does, group, order, ...(section ? { section } : {}), workflows: [] };
      line.workflows.push({
        id: workflow.id,
        family: workflow.pipeline,
        ...(about.version ? { version: about.version } : {}),
        ...(listed
          ? {
              used: listed.used,
              provided: listed.provided,
              versions: listed.versions,
              absent: absentVersions(workflow, listed, about),
            }
          : {}),
      });
      lines.set(about.name, line);
    }
    const rank = line => ['image', 'video', 'audio', 'retouch'].indexOf(line.group),
      // (A model in several workflows: the one of the images first, its version is the one the line says.)
      media = entry => ['image', 'video', 'audio'].indexOf(families()[entry.family]?.mediaType);
    for (const line of lines.values()) line.workflows.sort((a, b) => media(a) - media(b));
    return [...lines.values()].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  }
  /**
   * (0.6.118) Keeps the version at `path` for the model of the shipped workflow `workflowId`. A
   * workflow the user edited is theirs: the version is written into it, as the editor would.
   * (0.6.420) Each version has its own settings: those of the version left are kept, and those kept for
   * the version taken come back with it (the settings of the one left stay where none were kept).
   */
  async useVersion(workflowId, path) {
    if (typeof workflowId !== 'string' || typeof path !== 'string' || !path)
      throw problem('Version invalide.');
    const shipped = await this.catalog.shippedOf(workflowId);
    if (!shipped) throw problem('Ce modèle n’est pas fourni avec Moodix.', 404);
    const listed = (await this.catalog.list()).find(workflow => workflow.id === workflowId);
    if (listed?.customized) {
      // (What the catalog says of a workflow beside what is written in it.)
      const { ready, unavailableReason, unavailableKind, automatic, ...own } = listed;
      const made = await this.versions.made(shipped, path),
        left = own.components?.[made.role]?.file,
        other = typeof left === 'string' && left.toLowerCase() !== made.file.toLowerCase();
      if (other) await this.versions.keep(workflowId, left, own);
      const kept = other ? await this.versions.keptOf(workflowId, made.file) : null;
      await this.catalog.save(withSettings(withVersion(own, made), kept));
    } else await this.versions.use(shipped, path);
  }
  /** (0.6.420) A workflow taken back as shipped: the settings kept for its versions go with the user's copy. */
  async resetWorkflow(id) {
    await this.catalog.reset(id);
    await this.versions.forget(id);
  }
  /**
   * (0.6.481) A version of a model on its own, as ModelDownloads fetches it from its row in « Modèles » (`absent`
   * of models): the workflow Moodix ships, made with that file under an asset id of its own (exactVersions), and
   * without the second file of a recipe (Ref2VA, which MiniMax H3 reads for subjects only, and that Moodix has no
   * source of). Null for an id that is no such version.
   */
  async versionWorkflow(id) {
    if (typeof id !== 'string' || !/_v[0-9a-f]{16}$/.test(id)) return null;
    const workflows = await this.catalog.list();
    for (const entry of (await this.models(workflows)).flatMap(line => line.workflows)) {
      const item = entry.absent?.find(version => version.download === id && id !== entry.id);
      if (item) return this.#versionOf(workflows.find(workflow => workflow.id === entry.id), item);
    }
    return null;
  }
  async #versionOf(listed, item) {
    const shipped = await this.catalog.shippedOf(listed.id),
      manifest = families()[listed.pipeline],
      { role, spec } = versionComponent(manifest),
      companions = (spec.recipes ?? []).map(recipe => recipe.companion?.role).filter(Boolean),
      made = withVersion(
        { ...shipped, builtin: true },
        {
          role,
          asset: 'version-' + digest([listed.pipeline, role, item.file.toLowerCase()].join('\n')).slice(0, 24),
          file: item.file,
          // (The version Moodix ships keeps the second file it ships it with: Wan 2.2's of the low noise.)
          companions: sameFile(item.file, shipped.components?.[role]?.file) ? [] : companions,
        },
      );
    return { ...made, id: item.download, name: `${manifest.model.name} · ${item.name}`, builtin: true, ready: false };
  }
  /** (0.6.481) What each version of a model downloaded on its own lacks, by what downloads it (offers). */
  async #versionOffers(workflows, models) {
    try {
      const made = [];
      for (const entry of models.flatMap(line => line.workflows))
        for (const item of entry.absent ?? [])
          if (item.download !== entry.id)
            made.push(await this.#versionOf(workflows.find(workflow => workflow.id === entry.id), item));
      return made.length ? await this.downloads.offers(made) : {};
    } catch {
      // Never what keeps the page from opening: those versions are then not offered.
      return {};
    }
  }
  async snapshot() {
    // (0.6.479) Whether its engine was ever prepared here, for what a model waiting for it says.
    await this.#engineNeeded().catch(() => {});
    this.syncCapabilities();
    const workflows = await this.catalog.list(),
      models = await this.models(workflows);
    return {
      config: this.config,
      folders: this.folders(),
      defaultFolders: this.defaultFolders(),
      families: familyCatalog(),
      runner: this.status(),
      workflows,
      models,
      hiddenWorkflows: await this.catalog.hiddenCount(),
      assets: await this.assets.list(),
      // What the shipped workflows lack and can download, the download in progress, and whether a
      // Hugging Face token is kept (never the token itself).
      downloads: {
        offers: await this.downloads.offers(workflows),
        // (0.6.481) And the versions of a model downloaded on their own (versionWorkflow), by what downloads each.
        versions: await this.#versionOffers(workflows, models),
        job: this.downloads.status(),
        hasToken: await this.downloads.hasToken(),
      },
      warning: this.warning || '',
    };
  }
  /** The LoRAs of the Studio's style choice: the files of the loras folders. */
  /** The .safetensors files of the loras folders, named relative to their folder, sub-folders included. */
  async styles() {
    const found = new Set();
    const read = async (folder, prefix, depth) => {
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && depth < 2)
          await read(join(folder, entry.name), prefix + entry.name + sep, depth + 1);
        else if (entry.isFile() && /\.safetensors$/i.test(entry.name)) found.add(prefix + entry.name);
      }
    };
    for (const folder of this.foldersOf('', 'lora')) await read(folder, '', 0);
    return [...found].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  }
  /**
   * A job as the built-in engine reads it. The style LoRAs of the Studio become LoRAs of the job
   * for a family that takes them here ("styles" in its manifest, their files found in the loras
   * folders); a family that takes none leaves them out.
   */
  async ownJob({ styles, ...job }) {
    const manifest = family(job.pipeline);
    if (!styles?.length || !manifest.styles || !manifest.loras) return job;
    const loras = [...(job.loras ?? [])];
    for (const [index, style] of styles.entries()) {
      let path = null;
      for (const folder of this.foldersOf('', 'lora')) {
        const candidate = resolve(folder, style.name);
        // A name stays inside its folder.
        if (!candidate.startsWith(resolve(folder) + sep)) continue;
        if (
          await stat(candidate).then(
            info => info.isFile(),
            () => false,
          )
        ) {
          path = candidate;
          break;
        }
      }
      if (!path) throw problem(`LoRA introuvable dans le dossier loras : ${style.name}.`, 409);
      loras.push({ id: 'style-' + index, path, strength: style.strength });
    }
    return { ...job, loras };
  }
  /** The models directory in use: the one of the settings (a ComfyUI's, say), else Atelier's own. */
  modelsDir(config = this.config) {
    return config.modelsDir || join(this.root, 'models');
  }
  /**
   * Every folder that may hold the files a manifest sorts under `name`, the first being where
   * they are expected: the folder set apart for them (`apart`) or the one of that name in the
   * models directory; then the other names ComfyUI reads them from, and what Atelier called
   * the folder before; the same in Atelier's own directory when another one is in use.
   */
  #foldersNamed(name, apart, config) {
    const own = join(this.root, 'models'),
      chosen = this.modelsDir(config),
      folders = apart ? [apart] : [];
    for (const directory of [chosen, own]) for (const other of namesFor(name)) folders.push(join(directory, other));
    return [...new Set(folders)];
  }
  /** The folders of one component of a family (see #foldersNamed); a tokenizer lives with the text encoders unless set apart. */
  foldersOf(family, role, config = this.config) {
    if (role === 'lora') return this.#foldersNamed('loras', config.loraRoot, config);
    const spec = families()[family]?.components[role];
    if (!spec) return [];
    return this.#foldersNamed(
      spec.folder,
      (spec.format === 'tokenizer' && config.tokenizerRoot) || config[ROOT_OF[spec.folder]],
      config,
    );
  }
  /** Where the files of one component are expected, or null for a role the family does not have. */
  folderOf(family, role, config = this.config) {
    return this.foldersOf(family, role, config)[0] ?? null;
  }
  /** Every folder a generation file may be in, for the searches by name. */
  searchFolders(config = this.config) {
    const folders = this.foldersOf('', 'lora', config);
    for (const manifest of Object.values(families()))
      for (const role of Object.keys(manifest.components))
        folders.push(...this.foldersOf(manifest.family, role, config));
    return [...new Set(folders)];
  }
  /**
   * Default browse folder for each component role, as declared by the family manifests. Two
   * families give the same role to different kinds of file (« upscaler » is an image model for
   * Real-ESRGAN, a latent one for LTX): the role is the image one here, `latentUpscaler` the other.
   */
  folders(config = this.config) {
    const models = this.modelsDir(config);
    const folders = {
      // The directory itself, as the settings show it.
      models,
      model: config.modelRoot || join(models, 'diffusion_models'),
      lora: config.loraRoot || join(models, 'loras'),
      textEncoder: config.textEncoderRoot || join(models, 'text_encoders'),
      tokenizer: config.tokenizerRoot || config.textEncoderRoot || join(models, 'text_encoders'),
      upscaler: config.upscaleRoot || join(models, 'upscale_models'),
      latentUpscaler: config.latentUpscaleRoot || join(models, 'latent_upscale_models'),
    };
    for (const manifest of Object.values(families()))
      for (const role of Object.keys(manifest.components))
        folders[role] ??= this.folderOf(manifest.family, role, config);
    return folders;
  }
  /**
   * (0.6.131) The folder each kind of file is taken from when the user sets none apart for it:
   * what « Détecter » gives a line of « Dossiers à part » back. Each as if its own setting alone
   * were empty: the tokenizers go with the text encoders, wherever those are.
   */
  defaultFolders(config = this.config) {
    const settings = {
      model: 'modelRoot',
      vae: 'vaeRoot',
      lora: 'loraRoot',
      textEncoder: 'textEncoderRoot',
      tokenizer: 'tokenizerRoot',
      upscaler: 'upscaleRoot',
      latentUpscaler: 'latentUpscaleRoot',
    };
    return Object.fromEntries(
      Object.entries(settings).map(([role, key]) => [role, this.folders({ ...config, [key]: '' })[role]]),
    );
  }
  status() {
    const worker = this.worker.status(),
      setup = this.environment.status();
    return !this.config.pythonPath && ['installing', 'error'].includes(setup.state)
      ? {
          ...worker,
          state: setup.state === 'error' ? 'unavailable' : 'installing',
          error: setup.error,
          progress: setup.progress,
        }
      : worker;
  }
  /** Which families can run now: what the engine says of each, and why not while it is not ready. */
  syncCapabilities() {
    const state = this.status();
    const capabilities = structuredClone(state.capabilities ?? {});
    // A worker restarting after a cancelled generation is back in seconds, and a request
    // waits for it: its workflows stay offered meanwhile.
    if (state.state !== 'ready' && !state.recovering)
      for (const capability of Object.values(capabilities)) {
        capability.ready = false;
        capability.reason = state.error || 'Moteur Python indisponible.';
      }
    // (0.6.479) Said with what is going on, or what to do: « arrêté » was all a new installation said,
    // generation switched off as well, and an environment of several minutes to install « démarre ».
    const waiting = !this.config.enabled
      ? 'La génération locale est coupée : Paramètres › Génération › « Activer la génération locale ».'
      : state.state === 'installing'
        ? 'Le moteur de génération s’installe : quelques minutes, la première fois seulement…'
        : state.state === 'starting'
          ? 'Le moteur de génération démarre…'
          : state.error ||
            (this.unprepared
              ? 'Le moteur de génération n’est pas encore installé : « Télécharger », dans Paramètres › Modèles, ' +
                'l’installe avec un modèle.'
              : 'Moteur de génération arrêté.');
    // (0.6.479) Never installed (`engine`): what « Télécharger » of a model brings, as it does its files; the chat
    // offers it then (unavailableKind 'engine', lib/native-workflows.mjs).
    const absent =
      this.config.enabled &&
      this.unprepared === true &&
      !state.error &&
      !['installing', 'starting'].includes(state.state);
    for (const [name, manifest] of Object.entries(families())) {
      // Before the engine has said what it runs: said as it is, not as a missing family.
      if (!capabilities[name] && state.state !== 'ready')
        capabilities[name] = {
          ready: false,
          mediaType: manifest.mediaType,
          reason: waiting,
          ...(absent ? { engine: true } : {}),
        };
    }
    this.catalog.capabilities = capabilities;
  }
  client() {
    const staged = new Set();
    // Starts the worker if it is not running; gives up when the job is cancelled.
    const ready = async signal => {
      signal?.throwIfAborted();
      if (this.worker.status().state === 'ready') return;
      let abort;
      const cancelled =
        signal &&
        new Promise((_, no) => {
          abort = () => no(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
        });
      try {
        await (cancelled ? Promise.race([this.start(), cancelled]) : this.start());
      } finally {
        if (abort) signal.removeEventListener('abort', abort);
      }
    };
    return {
      status: async ({ signal } = {}) => {
        await ready(signal);
        return { idle: !this.worker.status().busy };
      },
      preflight: async (job, options) => {
        await ready(options?.signal);
        return this.worker.request('preflight', await this.ownJob(job), options);
      },
      // Copies an original image or video where the worker can read it, without loading it in memory.
      stage: async (media, { signal } = {}) => {
        try {
          signal?.throwIfAborted();
          const extension = STAGED_TYPES[media.mime];
          if (!extension || media.info.size > (media.mime.startsWith('video/') ? 512 : 64) * 1024 ** 2)
            throw problem('Fichier source invalide ou trop volumineux (64 Mo par image, 512 Mo par vidéo).');
          await mkdir(this.inputDir, { recursive: true });
          const file = join(this.inputDir, randomUUID() + extension);
          staged.add(file);
          await pipeline(media.handle.createReadStream(), createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
            signal,
          });
          return { path: file };
        } finally {
          await media.handle.close().catch(() => {});
        }
      },
      upload: async (bytes, { filename, mime, signal } = {}) => {
        signal?.throwIfAborted();
        if (bytes.length > 5 * 1024 * 1024 || !['image/png', 'image/jpeg'].includes(mime))
          throw problem('Référence préparée invalide.');
        await mkdir(this.inputDir, { recursive: true });
        const file = join(this.inputDir, randomUUID() + (mime === 'image/png' ? '.png' : '.jpg'));
        await writeFile(file, bytes, { mode: 0o600 });
        staged.add(file);
        return { path: file };
      },
      run: async (job, { signal, onProgress } = {}) => {
        try {
          return await this.worker.request('generate', await this.ownJob(job), {
            signal,
            onProgress:
              onProgress &&
              (data => {
                const value = nativeProgress(data);
                if (value) onProgress(value);
              }),
          });
        } catch (error) {
          // Stopped or out of time, its worker was ended and could remove nothing: what it
          // was writing goes now (it stayed in the folder of the outputs for an hour).
          await leftTemporaries(this.outputDir, job.outputName);
          throw error;
        }
      },
      free: async options => {
        try {
          // The Studio goes on creating: the models stay on the card, where the next creation
          // finds them (the engine itself decides what it keeps); only the copies of the
          // sources go (below).
          if (options?.keep) return { kept: true };
          const { reserve } = options ?? {};
          const wanted = Number.isFinite(reserve) && reserve > 0 ? reserve : 0;
          // The chat model comes back: the files of the engine leave, least recently used first (the
          // text encoder before the model), until the chat model has its room and 2 GiB beside it
          // (NATIVE_KEEP_ABOVE); without it coming back, they stay for the next creation.
          // (0.6.429) `timeoutMs`: how long the engine has for it once it is its turn (the worker's 60 s when
          // left out). Behind a film being assembled it waits for its turn, and is not out of time meanwhile.
          return await this.worker.release({
            ...(wanted ? { keepAbove: NATIVE_KEEP_ABOVE + wanted } : {}),
            ...(Number.isFinite(options?.timeoutMs) ? { timeoutMs: options.timeoutMs } : {}),
          });
        } finally {
          for (const file of staged) {
            await rm(file, { force: true });
            staged.delete(file);
          }
        }
      },
      original: async source => {
        const media = await generatedMedia(this.outputDir, source);
        try {
          return { bytes: await media.handle.readFile(), mime: media.mime };
        } finally {
          await media.handle.close();
        }
      },
    };
  }
  /** Unloads the models the image/video worker keeps in RAM and VRAM between generations. */
  unload() {
    return this.worker.unload();
  }
  async close() {
    this.closing = true;
    // A download stops; its .part files stay, and it resumes from there next time.
    await this.downloads.close();
    await this.environment.close();
    await this.worker.close();
    await this.starting?.catch(() => {});
    await this.worker.close();
  }
}
