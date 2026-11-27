import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, statfs as fsStatfs, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { families } from './families.mjs';
import { LONG_RETRIES, renameWithRetry } from './update-files.mjs';

/**
 * Downloads the files a shipped workflow names and this computer does not have, from the
 * sources listed in runner/downloads.json (keyed by the file name the workflow gives). Each
 * file goes to the folder of its kind in the models directory of the settings, under the name
 * of its source; it is then registered for the workflow, which finds it without any setting.
 *
 * A download resumes where it stopped (the `.part` file stays), checks the room on the disk
 * first, and checks size and SHA-256 at the end. A folder (a diffusers model, a tokenizer) is
 * filled under `<name>.download` and takes its name only once complete.
 *
 * Each source names its licence (`license`: name, link to its text, limits in a sentence, after
 * the table of THIRD_PARTY_NOTICES.md): the page shows it before the download. One with
 * conditions (`restricted`: LTX 2.5, MiniMax H3, Krea 2, SAM 3.1) is confirmed by the user first,
 * and nothing starts without that confirmation (`accepted`); the choice stays the user's.
 *
 * (0.6.223) A source may be a file the engine does not read as it is (`convert: 'int8'`: the two files
 * of Wan 2.2 Fun Camera are published as 8-bit floats only): it is downloaded and checked like any
 * other, then written again in the engine's own format under the name the workflow gives
 * (runner/convert.py, on the processor: a minute and a half a file of 14 GiB, the card left to
 * whatever holds it), and the downloaded file is removed. The converted file has no SHA-256 to
 * check: two computers do not round to the same last integer.
 */
const HUGGING_FACE = 'https://huggingface.co';
// Room left free on the disk after a download.
const MARGIN = 2 * 1024 ** 3;
const TOKEN = /^[\x21-\x7e]{8,200}$/;
// (0.6.432) The pauses before each new try of a download cut, while the tries in a row bring nothing: about four
// minutes in all, for a Wi-Fi that comes back or a router that starts again.
const PAUSES = [5, 15, 30, 60, 120].map(seconds => seconds * 1000);

const problem = (message, status = 400) => Object.assign(new Error(message), { status });
/** (0.6.432) A connection lost on the way, said as such, with what to do: Node said « terminated ». */
const cut = name =>
  Object.assign(
    problem(
      `La connexion a été coupée pendant le téléchargement de ${name} : relancez-le, il reprendra où il en était.`,
      502,
    ),
    { cut: true },
  );
const hfUrl = (repo, revision, path) =>
  `${HUGGING_FACE}/${repo}/resolve/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
export const formatBytes = bytes =>
  bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go'
    : Math.max(1, Math.round(bytes / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';

/** The licence of a source as the page shows it: its name, the link to its text, its limits. */
function licenseOf(source) {
  const license = source?.license;
  if (!license?.name) return null;
  return {
    name: String(license.name),
    url: /^https:\/\//.test(license.url || '') ? license.url : '',
    limits: typeof license.limits === 'string' ? license.limits : '',
    restricted: license.restricted === true,
  };
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
/**
 * A file is only given its name once complete and checked (it is `.part` before): a file of a
 * folder being filled that has its name and its size is done, whatever stopped the download.
 */
async function done(file) {
  return !(await exists(file.path + '.part')) && (await sizeOf(file.path)) === file.size;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash;
}

export class ModelDownloads {
  /** `convert(from, to, { signal })` writes the file at `from` again in the engine's format at `to`. */
  /** A start being prepared: nothing is « running » yet, and no other may begin. */
  #starting = false;
  // (0.6.451) `families`: the families whose workflows it downloads for; the dictation (lib/dictation.mjs) gives
  // its own, which is no family of the generation engine.
  // (0.6.479) `onDone(workflow)`: told once every file of a download is there and registered. `engine`: the engine
  // of a new installation, which « Télécharger » of a model prepares too (the user's choice of 27/11, « Oui, d'un
  // seul clic »): { bytes, needed(), prepare(signal), progress() }, see lib/generation-service.mjs.
  constructor({
    catalogPath,
    dataDir,
    assets,
    folderOf,
    fetchImpl = fetch,
    statfs = fsStatfs,
    convert = null,
    families: known = families,
    onDone = null,
    engine = null,
  }) {
    Object.assign(this, { catalogPath, assets, folderOf, fetchImpl, statfs, convert, known, onDone, engine });
    this.tokenPath = join(dataDir, 'huggingface-token');
    this.job = { state: 'idle' };
    this.controller = null;
    this.catalogCache = null;
    this.pauses = PAUSES;
  }
  async catalog() {
    if (!this.catalogCache)
      try {
        this.catalogCache = JSON.parse(await readFile(this.catalogPath, 'utf8'));
      } catch {
        this.catalogCache = {};
      }
    return this.catalogCache;
  }
  async #token() {
    try {
      const token = (await readFile(this.tokenPath, 'utf8')).trim();
      return TOKEN.test(token) ? token : '';
    } catch {
      return '';
    }
  }
  async hasToken() {
    return Boolean(await this.#token());
  }
  /** (0.6.479) The engine a download prepares as well, or null: prepared already, or nothing to ask. */
  async #engineToPrepare() {
    try {
      return this.engine && (await this.engine.needed()) ? this.engine : null;
    } catch {
      return null;
    }
  }
  /** Keeps the Hugging Face token on this computer only; an empty one removes it. */
  async setToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!token) {
      await rm(this.tokenPath, { force: true });
      return false;
    }
    if (!TOKEN.test(token)) throw problem('Jeton Hugging Face invalide.');
    await writeFile(this.tokenPath, token, { mode: 0o600 });
    return true;
  }
  /** Whether the file of a component cannot be found at all (as opposed to found and unsuitable). */
  async #absent(workflow, role, policy) {
    try {
      await this.assets.resolve(policy.asset, { kind: role, family: workflow.pipeline, file: policy.file });
      return false;
    } catch (error) {
      return error.code === 'ENOENT' || /not found|absolute local path|Aucun fichier/.test(error.message);
    }
  }
  /**
   * The components of a workflow whose file is not here, each with its source when one is known,
   * and the licence of that source (null when the catalog names none).
   */
  async missing(workflow) {
    if (!this.known()[workflow.pipeline]) return [];
    const catalog = await this.catalog(),
      missing = [];
    for (const [role, policy] of Object.entries(workflow.components || {})) {
      if (policy?.policy !== 'fixed' || !policy.file || !policy.asset) continue;
      if (await this.#absent(workflow, role, policy)) {
        const source = catalog[policy.file] || null;
        missing.push({ role, file: policy.file, asset: policy.asset, source, license: licenseOf(source) });
      }
    }
    // (0.6.421) Its LoRAs are files of the model as its components are: the LoRA of the subjects of LTX 2.5
    // was never offered, and LTX 2.5 stayed without it on another computer.
    for (const lora of workflow.loras ?? []) {
      if (!lora?.file || !lora.asset) continue;
      if (await this.#absent(workflow, 'lora', lora)) {
        const source = catalog[lora.file] || null;
        missing.push({ role: 'lora', file: lora.file, asset: lora.asset, source, license: licenseOf(source) });
      }
    }
    return missing;
  }
  /**
   * For each shipped workflow that lacks files: which, under which licence, how much to download,
   * whether a token is needed, and whether a licence with conditions is to confirm first.
   * (0.6.479) On a new installation, `engine: { bytes }` beside: the engine its click prepares as well, about what
   * it downloads (`bytes` and `left` stay those of the files); a workflow whose files are all here then has an offer
   * too, of the engine alone (no file, `bytes` and `left` 0).
   */
  async offers(workflows) {
    const offers = {},
      token = await this.hasToken(),
      engine = await this.#engineToPrepare();
    for (const record of workflows) {
      if (!record.builtin || record.importDraft || record.ready) continue;
      const missing = await this.missing(record);
      if (!missing.length && !engine) continue;
      const known = missing.filter(item => item.source);
      const gated = known.some(item => item.source.gated);
      const bytes = known.reduce((sum, item) => sum + item.source.size, 0);
      // What a stopped download already holds is not fetched again: what is left is said.
      let left = bytes;
      try {
        left = 0;
        for (const file of this.#plan(record, known).flatMap(item => item.files))
          left += (await done(file)) ? 0 : file.size - Math.min(file.size, await sizeOf(file.path + '.part'));
      } catch {
        left = bytes;
      }
      const converting = known.reduce((sum, item) => sum + (item.source.convert ? item.source.size : 0), 0);
      offers[record.id] = {
        files: missing.map(item => ({
          role: item.role,
          file: item.file,
          size: item.source?.size ?? null,
          license: item.license,
        })),
        bytes,
        left,
        complete: known.length === missing.length,
        // Some of these files are written again in the engine's format once downloaded: said, with
        // the room the disk needs meanwhile (what is left to fetch, and the converted files beside
        // their sources before those leave; `bytes` is about what stays afterwards).
        convert: converting > 0,
        room: left + converting,
        restricted: known.some(item => item.license?.restricted),
        gated,
        needsToken: gated && !token,
        page: known.find(item => item.source.page)?.source.page || '',
        ...(engine ? { engine: { bytes: engine.bytes } } : {}),
      };
    }
    return offers;
  }
  status() {
    const { state, workflowId, name, received = 0, total = 0, current = '', error = '', engine } = this.job;
    // (0.6.479) The engine of a new installation being prepared (`engine`: 'waiting', 'preparing', 'ready'): what
    // it does, in the place of the name of a file.
    const doing =
      state === 'running' && engine === 'preparing' ? this.engine?.progress?.() || 'Préparation du moteur' : current;
    return { state, workflowId, name, received, total, current: doing, error, ...(engine ? { engine } : {}) };
  }
  /** Where each missing file goes, and the files to fetch for it (one, or those of a folder). */
  #plan(workflow, missing) {
    return missing.map(item => {
      const folder = this.folderOf(workflow.pipeline, item.role),
        source = item.source;
      if (!folder) throw problem(`Aucun dossier pour « ${item.role} ».`);
      if (source.folder) {
        const target = join(folder, item.file),
          staging = target + '.download';
        return {
          ...item,
          target,
          staging,
          files: source.files.map(file => ({
            url: hfUrl(source.repo, source.revision, file.path),
            path: join(staging, ...file.path.split('/')),
            size: file.size,
            sha256: file.sha256 || '',
            gated: Boolean(source.gated),
          })),
        };
      }
      const url = source.url || hfUrl(source.repo, source.revision, source.path);
      const fetched = join(folder, basename(source.path || new URL(url).pathname));
      // A file to convert keeps the name of its source while it is one, and the converted file
      // takes the name the workflow asks for.
      const target = source.convert ? join(folder, item.file) : fetched;
      return {
        ...item,
        target,
        ...(source.convert ? { convert: { from: fetched } } : {}),
        files: [{ url, path: fetched, size: source.size, sha256: source.sha256 || '', gated: Boolean(source.gated), source }],
      };
    });
  }
  /** `accepted`: the user read the licences with conditions of these files, and confirmed. */
  async start(workflow, options) {
    // (0.6.288) Held from the first instant, not once « running » is written after the files, the token and the
    // disk were read: two starts asked at once (a double click, two tabs) passed both, wrote the same .part one
    // behind the other, and the file was erased at the end as too long; « Arrêter » stopped the second only.
    if (this.job.state === 'running' || this.#starting) throw problem('Un téléchargement est déjà en cours.', 409);
    this.#starting = true;
    try {
      return await this.#begin(workflow, options);
    } finally {
      this.#starting = false;
    }
  }
  async #begin(workflow, { accepted = false } = {}) {
    // (0.6.198) Said to the user: « modèle », « Moodix », and the place of the token as the page names it.
    if (!workflow?.builtin) throw problem('Seuls les modèles fournis avec Moodix se téléchargent.');
    const missing = await this.missing(workflow),
      // (0.6.479) The engine of a new installation comes with it, after its files.
      engine = await this.#engineToPrepare();
    if (!missing.length && !engine) throw problem('Rien à télécharger : tous les fichiers de ce modèle sont là.');
    const unknown = missing.filter(item => !item.source);
    if (unknown.length)
      throw problem(`Pas de source connue pour ${unknown.map(item => item.file).join(', ')} : placez-le dans son dossier.`);
    // A licence with conditions is the user's to read and to confirm: never passed over in silence.
    const restricted = [...new Set(missing.filter(item => item.license?.restricted).map(item => item.license.name))];
    if (restricted.length && !accepted) {
      const several = restricted.length > 1;
      throw problem(
        `${several ? 'Licences' : 'Licence'} à conditions (${restricted.join(', ')}) : lisez-${several ? 'les' : 'la'} et confirmez avant de télécharger.`,
        409,
      );
    }
    const token = await this.#token();
    const page = missing.find(item => item.source.page)?.source.page;
    // (0.6.479) Where the token is made, said with the rest.
    if (missing.some(item => item.source.gated) && !token)
      throw problem(
        `Ces fichiers demandent un compte Hugging Face : acceptez la licence sur ${page} avec ce compte, ` +
          'créez un jeton de lecture sur huggingface.co/settings/tokens, ' +
          'puis enregistrez votre jeton dans Paramètres › Modèles › Fichiers.',
        403,
      );
    const plan = this.#plan(workflow, missing);
    if (plan.some(item => item.convert) && typeof this.convert !== 'function')
      throw problem('Ces fichiers se convertissent après le téléchargement : le moteur de génération n’est pas disponible ici.', 409);
    // Nothing is overwritten: a file of that name which is not the workflow's stays.
    for (const item of plan) {
      // (Nor a file that has the name of a source to convert without being it.)
      if (item.convert && (await exists(item.convert.from)) && (await sizeOf(item.convert.from)) !== item.files[0].size)
        throw problem(`${basename(item.convert.from)} existe déjà dans ${this.folderOf(workflow.pipeline, item.role)} sans être le fichier attendu.`, 409);
      if (await exists(item.target)) {
        const file = item.files[0];
        // (A converted file has not the size of its source: one that is there and does not serve
        // this model is not one to write over either.)
        const complete = !item.staging && !item.convert && (await sizeOf(item.target)) === file.size;
        if (!complete)
          throw problem(`${basename(item.target)} existe déjà dans ${this.folderOf(workflow.pipeline, item.role)} sans convenir à ce modèle.`, 409);
        item.files = [];
      }
    }
    // Room on each disk for what remains to fetch there.
    const needs = new Map();
    for (const item of plan)
      for (const file of item.files) {
        const folder = this.folderOf(workflow.pipeline, item.role);
        await mkdir(folder, { recursive: true });
        // A file of a folder already fetched whole needs no room (its folder may still lack its name:
        // its last rename refused, or the download stopped meanwhile). Counted, it asked for its size again.
        const left = (await done(file)) ? 0 : file.size - (await sizeOf(file.path + '.part'));
        // The converted file is written beside its source before the source leaves: as much again.
        needs.set(folder, (needs.get(folder) || 0) + Math.max(0, left) + (item.convert ? file.size : 0));
      }
    for (const [folder, bytes] of needs) {
      const disk = await this.statfs(folder);
      const free = Number(disk.bavail) * Number(disk.bsize);
      if (bytes + MARGIN > free)
        throw problem(`Pas assez de place dans ${folder} : ${formatBytes(bytes)} à télécharger, ${formatBytes(free)} libres.`, 507);
    }
    const files = plan.flatMap(item => item.files);
    let received = 0;
    for (const file of files)
      received += (await done(file)) ? file.size : Math.min(file.size, await sizeOf(file.path + '.part'));
    this.controller = new AbortController();
    this.job = {
      state: 'running',
      workflowId: workflow.id,
      name: workflow.name,
      total: files.reduce((sum, file) => sum + file.size, 0) + (engine ? engine.bytes : 0),
      received,
      current: '',
      error: '',
      ...(engine ? { engine: 'waiting' } : {}),
    };
    const signal = this.controller.signal,
      bring = () => this.#run(plan, workflow, token, signal),
      // (0.6.479) A file the engine converts (Wan 2.2 Fun Camera) needs it there: the engine then comes first.
      first = Boolean(engine) && plan.some(item => item.convert),
      steps = first
        ? this.#prepareEngine(engine, signal, { first }).then(bring)
        : bring().then(() => (engine ? this.#prepareEngine(engine, signal) : undefined));
    this.task = steps.then(
      () => {
        this.job = { ...this.job, state: 'done', current: '' };
        try {
          this.onDone?.(workflow);
        } catch {
          // What it starts says its own failures.
        }
      },
      error => {
        this.job = signal.aborted
          ? { ...this.job, state: 'cancelled', current: '' }
          : { ...this.job, state: 'error', current: '', error: error.message };
      },
    );
    return this.status();
  }
  /**
   * (0.6.479) The engine of a new installation, once the files are there (before them, `first`, when the engine
   * converts one): prepared, then started (`prepare`), what it does said by `progress`. uv does not tell its bytes:
   * the bar waits meanwhile. « Arrêter » stops it; the libraries uv brought in full stay in its cache for the next
   * time. A failure after the files keeps them, registered, and says its reason; « Télécharger » then offers the
   * engine alone.
   */
  async #prepareEngine(engine, signal, { first = false } = {}) {
    signal.throwIfAborted();
    this.job.engine = 'preparing';
    try {
      await engine.prepare(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // (What uv says may be the last 3000 characters of its errors: their first line and their last.)
      const lines = String(error?.message || '')
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(Boolean),
        reason = (lines.length > 1 ? `${lines[0]} … ${lines.at(-1)}` : lines[0] || 'raison inconnue').slice(0, 400);
      const said = first ? 'Le moteur' : 'Les fichiers sont là, mais le moteur';
      throw problem(`${said} de génération n’a pas pu être préparé : ${reason}`, 502);
    }
    // (Its share of the bar once it is there, before the files or after them.)
    Object.assign(this.job, { engine: 'ready', received: Math.min(this.job.total, this.job.received + engine.bytes) });
  }
  async #run(plan, workflow, token, signal) {
    for (const item of plan) {
      for (const file of item.files) {
        this.job.current = basename(file.path);
        await this.#fetchFile(file, token, signal);
      }
      if (item.staging) {
        if (await exists(item.target)) throw problem(`${basename(item.target)} existe déjà.`, 409);
        await renameWithRetry(item.staging, item.target, {
          retries: LONG_RETRIES,
          signal,
          // Said while it waits (0.6.87): « 100 % » for a minute, without a word, before.
          onWait: () => {
            this.job.current = `${basename(item.target)} : en attente que Windows libère le dossier`;
          },
        });
      }
      if (item.convert) {
        // Said while it lasts: the bar is at the end of this file, and minutes pass.
        this.job.current = `${basename(item.target)} : conversion pour le moteur de Moodix`;
        // (What an interrupted conversion left is its own to write again: runner/convert.py.)
        await this.convert(item.convert.from, item.target, { signal });
        if (!(await exists(item.target))) throw problem(`${basename(item.target)} n’a pas été converti.`, 502);
        // The source served only for this: 15 Go the engine never reads.
        await rm(item.convert.from, { force: true });
      }
      await this.assets.register({ id: item.asset, path: item.target, kind: item.role, family: workflow.pipeline });
    }
  }
  /** SHA-256 of a gated file, which Hugging Face only gives to an account that accepted the licence. */
  async #hashFromHub(file, token, signal) {
    const { repo, revision, path } = file.source;
    const response = await this.fetchImpl(`${HUGGING_FACE}/api/models/${repo}/paths-info/${revision}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path], expand: false }),
      signal,
    });
    if (!response.ok) return '';
    const [entry] = await response.json();
    return /^[0-9a-f]{64}$/.test(entry?.lfs?.oid || '') ? entry.lfs.oid : '';
  }
  async #fetchFile(file, token, signal) {
    const partial = file.path + '.part',
      // (0.6.432) What the other files brought: each try counts this one again from what reached the disk.
      before = this.job.received - Math.min(file.size, await sizeOf(partial));
    // (0.6.432) A cut is asked again from where it stopped, after a pause that « Arrêter » ends, as long as the
    // tries bring something; once a few in a row bring nothing, it stops and says so. It stopped at the first
    // before, said « terminated » or « fetch failed », to be started again by hand.
    for (let failed = 0; ; ) {
      const offset = await sizeOf(partial);
      try {
        return await this.#fetchOnce(file, token, signal, before);
      } catch (error) {
        if (!error.cut || signal.aborted) throw error;
        // Not while the source has never answered since this download was started: no network at the click is
        // said at once, not after four minutes of a bar that does not move.
        if (!this.job.reached) throw error;
        if ((await sizeOf(partial)) > offset) failed = 0;
        if (failed === this.pauses.length) throw error;
        // Said where the page shows the file being fetched, the time of the pause.
        const name = basename(file.path),
          pause = this.pauses[failed++];
        this.job.current = `${name} : connexion coupée, nouvel essai dans ${Math.max(1, Math.round(pause / 1000))} s`;
        await delay(pause, undefined, { signal });
        this.job.current = name;
      }
    }
  }
  /** One try: the rest of the file from its .part, checked, and named once whole. */
  async #fetchOnce(file, token, signal, before) {
    const partial = file.path + '.part',
      // (0.6.432) A connection lost on the way (a Wi-Fi that drops, Hugging Face that closes it, five minutes
      // without a byte) is a cut. A disk that refuses (its own error, with `syscall`) is none, as for llama.cpp.
      lost = error => {
        if (signal.aborted || error.syscall) throw error;
        throw cut(basename(file.path));
      };
    // A file of a folder already completed (and checked) by an earlier, stopped download.
    if (await done(file)) return;
    await mkdir(join(partial, '..'), { recursive: true });
    if (!file.sha256 && file.gated && token) file.sha256 = await this.#hashFromHub(file, token, signal).catch(lost);
    let offset = await sizeOf(partial);
    if (offset > file.size) {
      await rm(partial, { force: true });
      offset = 0;
    }
    this.job.received = before + offset;
    const huggingFace = new URL(file.url).origin === HUGGING_FACE;
    const headers = {
      'User-Agent': 'AtelierLocal-models',
      ...(offset ? { Range: `bytes=${offset}-` } : {}),
      ...(huggingFace && token ? { Authorization: `Bearer ${token}` } : {}),
    };
    let hash = offset ? await hashFile(partial) : createHash('sha256');
    if (offset < file.size) {
      const response = await this.fetchImpl(file.url, { headers, redirect: 'follow', signal }).catch(lost);
      this.job.reached = true;
      if (response.status === 401 || response.status === 403)
        throw problem(`Accès refusé par la source de ${basename(file.path)} : vérifiez le jeton et la licence acceptée.`, 403);
      if (!response.ok || !response.body) throw problem(`La source de ${basename(file.path)} répond ${response.status}.`, 502);
      if (offset && response.status !== 206) {
        // The source starts again from the beginning: so does the file.
        this.job.received -= offset;
        offset = 0;
        hash = createHash('sha256');
      }
      // (0.6.432) A rest that does not start where this file stopped, or is of a file of another size: nothing to
      // add to it (it was added, and the file refused at its end).
      const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
      if (offset && range && (Number(range[1]) !== offset || !['*', String(file.size)].includes(range[2])))
        throw problem(`La source de ${basename(file.path)} ne correspond plus au fichier attendu.`, 502);
      const job = this.job;
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          job.received += chunk.length;
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(partial, { flags: offset ? 'a' : 'w' }), {
        signal,
      }).catch(lost);
    }
    const size = await sizeOf(partial);
    // (0.6.432) Come short, the connection closed before its end: a cut too.
    if (size < file.size) throw cut(basename(file.path));
    if (size !== file.size) throw problem(`${basename(file.path)} est incomplet (${size} octets sur ${file.size}).`, 502);
    if (file.sha256 && hash.digest('hex') !== file.sha256) {
      await rm(partial, { force: true });
      throw problem(`${basename(file.path)} ne correspond pas à l’original (empreinte différente) : il a été effacé.`, 502);
    }
    // Just downloaded: an antivirus may read it a while before it can take its name (refused at once
    // before 0.6.85, the download failed at its very end and had to read the whole file again).
    await renameWithRetry(partial, file.path, {
      retries: LONG_RETRIES,
      signal,
      // Said while it waits (0.6.87): « 100 % » for a minute, without a word, before.
      onWait: () => {
        this.job.current = `${basename(file.path)} : en attente que Windows libère le fichier`;
      },
    });
  }
  cancel() {
    this.controller?.abort();
  }
  async close() {
    this.cancel();
    await this.task?.catch(() => {});
  }
}
