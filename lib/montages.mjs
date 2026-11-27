/**
 * (0.6.136) A montage: takes of a project laid one after the other, with sounds under them, read
 * as one film (the user's request of 19/11: « un plan composé de tout, image/vidéo/son. Ça
 * fonctionnera comme une timeline, une vraie cette fois »). This is its first step: what the
 * user lays by hand. A montage is a file of its project, kept by the application; nothing of it
 * lives in the memory of a chat model.
 *
 * {
 *   schemaVersion: 1, id, name,
 *   format: '16:9', width, height: one of the sizes of that format (public/formats.mjs), fps,
 *   plans:  [{ id, at, source, kind: 'video' | 'image', from, to, frame: 'fit' | 'fill', volume }],
 *           (0.6.142) a plan **to make** has no `source` yet but `todo: { prompt, suite }`, a length (`to`),
 *           `photos: { start, end }`, the photos it starts on and arrives on (0.6.159: its alone),
 *           and `replaces: { source, from, to }` when it takes the place of the end of a video;
 *           (0.6.149) `at`: its instant in the bobine, `todo.suite`: it goes on from the video before it,
 *   sounds: [{ id, source, track: 'music' | 'effects', at, from, to, volume }],
 *   createdAt, updatedAt,
 *   (0.6.154) archived: { at, name, format, width, height, fps, plans, sounds }, the bobine as it was
 *   when « Enregistrer » put it in the Archives (the Bobine goes on keeping what is open in it)
 * }
 * `source` names a creation of the project as the gallery does: { conversationId, runId, output }
 * (lib/gallery.mjs). A plan shows its source from `from` to `to` seconds (an image: 0 to its
 * length); the plans are in the order of the list, each from its instant (0.6.149: there may be a
 * hole between two, black in the film; a file of before it, without instants, is read end to end,
 * public/montage-model.mjs `placed`). A sound starts `at` seconds of the film and plays its source
 * from `from` to `to`.
 * Nothing is copied: the takes stay where they are, a montage only says which and when.
 */
import { access, mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { problem } from './engine.mjs';
import { TRASH_DAYS } from './history.mjs';
import { projectId } from './projects.mjs';
import { atomicFile, renameWithRetry } from './update-files.mjs';
import {
  MONTAGE_LIMITS,
  MONTAGE_RATES,
  TODO_LIMITS,
  isTodo,
  mono,
  montageSeconds,
  montageSizes,
  placed,
  planStarts,
  usualSize,
} from '../public/montage-model.mjs';

// (0.6.137) What the page knows of a montage too is written once, for both (public/montage-model.mjs).
export { MONTAGE_LIMITS, montageSeconds, montageSizes, planStarts };

const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// (0.6.442) A bobine set aside, `corbeille/<id>-<instant>.json`: the instant in UTC to the second (`remove`), then
// `-2`, `-3`... when its project went and another of that name was there (`moveProject`). It waits there as long as
// a conversation waits in the bin of the history (lib/history.mjs).
const ASIDE = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-(\d{14})(?:-\d+)*\.json$/,
  ASIDE_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;
const asideAt = stamp => Date.parse(stamp.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3T$4:$5:$6Z'));
const FRAMES = ['fit', 'fill'],
  KINDS = ['video', 'image'],
  TRACKS = ['music', 'effects'];

const invalid = message => problem(message, 400);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
// (0.6.409) The furthest instant of a bobine: as many takes as it may hold, each as long as a take may be
// (200 of ten minutes). It was ten hours, less than that; the engine says the same (runner/video/montage.py).
const FURTHEST = MONTAGE_LIMITS.plans * MONTAGE_LIMITS.longest;
function seconds(value, label, low, high) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high)
    throw invalid(`${label} : durée invalide.`);
  // (A millisecond is finer than a frame; what the page computes by dragging is rounded to it.)
  return Math.round(value * 1000) / 1000;
}
function source(value, label) {
  if (!plain(value) || !ID.test(value.conversationId ?? '') || !ID.test(value.runId ?? ''))
    throw invalid(`${label} : prise invalide.`);
  const output = value.output ?? 0;
  if (!Number.isInteger(output) || output < 0 || output > 63) throw invalid(`${label} : prise invalide.`);
  return { conversationId: value.conversationId, runId: value.runId, output };
}
function volume(value, label) {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2)
    throw invalid(`${label} : volume invalide.`);
  return Math.round(value * 100) / 100;
}
const own = (value, label) => {
  if (!ID.test(value ?? '')) throw invalid(`${label} : identifiant invalide.`);
  return value;
};
/**
 * (Relecture du 21/11) How long a part of a take is, to the millisecond as its instants are kept: computed
 * in floating point, 1.083 − 0.983 is 0.0999…, and a take brought to its shortest (0.1 s, as far as the
 * page lets its edge go) was refused: the whole bobine could not be kept any more.
 */
const span = (from, to) => Math.round((to - from) * 1000) / 1000;
const date = (value, fallback) =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : fallback;

/** (0.6.154) What a bobine is made of, without its identity and its dates: what « Enregistrer » keeps of it. */
const contentOf = ({ name, format, width, height, fps, plans, sounds }) => ({ name, format, width, height, fps, plans, sounds });

/**
 * (0.6.154) The bobine as it was put in the Archives, checked as a bobine is; one that cannot be read
 * any more (a rule of a later version) is left out, the bobine itself stays.
 */
function archivedOf(input, now) {
  if (!plain(input.archived)) return {};
  try {
    const kept = validateMontage({ ...input.archived, schemaVersion: 1, id: input.id }, { now, nested: true });
    return { archived: { at: date(input.archived.at, now), ...contentOf(kept) } };
  } catch {
    return {};
  }
}

/** A montage as it is kept: every field checked, nothing else carried over. */
export function validateMontage(input, { now = new Date().toISOString(), nested = false } = {}) {
  if (!plain(input)) throw invalid('Bobine invalide.');
  if (input.schemaVersion !== 1) throw invalid('Version de bobine inconnue.');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MONTAGE_LIMITS.name)
    throw invalid(`Le nom de la bobine doit contenir entre 1 et ${MONTAGE_LIMITS.name} caractères.`);
  const sizes = montageSizes(input.format);
  if (!sizes.length) throw invalid('Format de bobine inconnu.');
  if (!sizes.some(size => size.width === input.width && size.height === input.height))
    throw invalid(`Cette taille n’est pas une taille du format ${input.format}.`);
  if (!MONTAGE_RATES.includes(input.fps)) throw invalid('Cadence de bobine invalide.');
  if (!Array.isArray(input.plans) || input.plans.length > MONTAGE_LIMITS.plans)
    throw invalid(`Une bobine compte au plus ${MONTAGE_LIMITS.plans} prises.`);
  if (!Array.isArray(input.sounds) || input.sounds.length > MONTAGE_LIMITS.sounds)
    throw invalid(`Une bobine compte au plus ${MONTAGE_LIMITS.sounds} sons.`);
  const seen = new Set();
  const once = id => {
    if (seen.has(id)) throw invalid('Deux éléments de la bobine ont le même identifiant.');
    seen.add(id);
    return id;
  };
  // (0.6.142) The photos a plan goes by, each a creation of the project.
  const photosOf = (plan, label) => {
    if (plan.photos === undefined) return {};
    if (!plain(plan.photos) || Object.keys(plan.photos).some(side => side !== 'start' && side !== 'end')) throw invalid(`${label} : photos invalides.`);
    const photos = {};
    for (const side of ['start', 'end']) if (plan.photos[side] !== undefined) photos[side] = source(plan.photos[side], `${label}, photo`);
    return Object.keys(photos).length ? { photos } : {};
  };
  // (0.6.149) Its instant in the bobine; a file of before 0.6.149 has none (see `placed` below).
  const instant = (plan, label) => (plan.at === undefined ? {} : { at: seconds(plan.at, label, 0, FURTHEST) });
  const listed = input.plans.map((plan, index) => {
    const label = `Prise ${index + 1}`;
    if (!plain(plan) || !KINDS.includes(plan.kind)) throw invalid(`${label} : ni vidéo ni image.`);
    // (0.6.142) A plan to make: a clip that does not exist yet. No take, a length a clip can have,
    // what happens in it, and what of a take it replaces.
    if (plan.todo !== undefined) {
      if (!plain(plan.todo) || typeof plan.todo.prompt !== 'string' || plan.todo.prompt.length > TODO_LIMITS.prompt)
        throw invalid(`${label} : texte de la prise à créer invalide.`);
      if (plan.todo.suite !== undefined && typeof plan.todo.suite !== 'boolean') throw invalid(`${label} : suite invalide.`);
      // (0.6.461, Bobine Pro, B04) The model it is made with: the family of its workflow (« ltx25 », « minimax_h3 »).
      if (plan.todo.model !== undefined && (typeof plan.todo.model !== 'string' || !/^[a-z0-9_]{1,40}$/.test(plan.todo.model)))
        throw invalid(`${label} : modèle de la prise à créer invalide.`);
      // (0.6.462, Bobine Pro, B05) Its subjects (« Sujet 1 », « Sujet 2 »…), images of the project, as its photos.
      if (plan.todo.subjects !== undefined && (!Array.isArray(plan.todo.subjects) || plan.todo.subjects.length > TODO_LIMITS.subjects))
        throw invalid(`${label} : sujets de la prise à créer invalides (${TODO_LIMITS.subjects} au plus).`);
      const subjects = (plan.todo.subjects ?? []).map(item => source(item, `${label}, sujet`));
      if (plan.kind !== 'video' || plan.source !== undefined || (plan.from !== undefined && plan.from !== 0))
        throw invalid(`${label} : une prise à créer est une vidéo sans fichier.`);
      const to = seconds(plan.to, label, TODO_LIMITS.shortest, TODO_LIMITS.longest);
      if (plan.frame !== undefined && !FRAMES.includes(plan.frame)) throw invalid(`${label} : cadre invalide.`);
      let replaces = {};
      if (plan.replaces !== undefined) {
        if (!plain(plan.replaces)) throw invalid(`${label} : ce qu’il remplace est invalide.`);
        const from = seconds(plan.replaces.from, label, 0, 36000),
          until = seconds(plan.replaces.to, label, 0, 36000);
        if (until <= from) throw invalid(`${label} : ce qu’il remplace est invalide.`);
        replaces = { replaces: { source: source(plan.replaces.source, label), from, to: until } };
      }
      return {
        id: once(own(plan.id, label)),
        ...instant(plan, label),
        kind: 'video',
        todo: {
          prompt: plan.todo.prompt,
          ...(plan.todo.suite ? { suite: true } : {}),
          ...(plan.todo.model ? { model: plan.todo.model } : {}),
          ...(subjects.length ? { subjects } : {}),
        },
        from: 0,
        to,
        frame: plan.frame ?? 'fit',
        volume: volume(plan.volume, label),
        ...photosOf(plan, label),
        ...replaces,
      };
    }
    const from = plan.kind === 'image' ? 0 : seconds(plan.from, label, 0, 36000),
      to = seconds(plan.to, label, 0, 36000);
    if (plan.kind === 'image' && plan.from !== undefined && plan.from !== 0)
      throw invalid(`${label} : une image commence à 0.`);
    if (span(from, to) < MONTAGE_LIMITS.shortest || span(from, to) > MONTAGE_LIMITS.longest)
      throw invalid(`${label} : sa durée va de ${MONTAGE_LIMITS.shortest} à ${MONTAGE_LIMITS.longest} secondes.`);
    if (plan.frame !== undefined && !FRAMES.includes(plan.frame)) throw invalid(`${label} : cadre invalide.`);
    return {
      id: once(own(plan.id, label)),
      ...instant(plan, label),
      source: source(plan.source, label),
      kind: plan.kind,
      from,
      to,
      frame: plan.frame ?? 'fit',
      // (An image has no sound of its own: nothing to set.)
      ...(plan.kind === 'video' ? { volume: volume(plan.volume, label) } : {}),
      // (0.6.159) No photos: they are those of a take to create. A bobine kept before carried those of the
      // take it was made from, shown above it for ever: they are left out as it is read.
    };
  });
  // Each at its instant, none over the one before it; those of an older file end to end, its
  // continuations said as suites.
  const { plans } = placed({ plans: listed });
  const sounds = input.sounds.map((sound, index) => {
    const label = `Son ${index + 1}`;
    if (!plain(sound) || !TRACKS.includes(sound.track)) throw invalid(`${label} : piste inconnue.`);
    const from = seconds(sound.from, label, 0, 36000),
      to = seconds(sound.to, label, 0, 36000);
    if (span(from, to) < MONTAGE_LIMITS.shortest) throw invalid(`${label} : trop court.`);
    return {
      id: once(own(sound.id, label)),
      source: source(sound.source, label),
      track: sound.track,
      at: seconds(sound.at, label, 0, FURTHEST),
      from,
      to,
      volume: volume(sound.volume, label),
    };
  });
  return {
    schemaVersion: 1,
    id: own(input.id, 'Bobine'),
    name,
    format: input.format,
    width: input.width,
    height: input.height,
    fps: input.fps,
    plans,
    sounds,
    createdAt: date(input.createdAt, now),
    updatedAt: date(input.updatedAt, now),
    ...(nested ? {} : archivedOf(input, now)),
  };
}

/**
 * (0.6.154) What the Archives show of a bobine put there: when, how long, how many takes, and the first
 * takes made, whose pictures its card shows.
 * (0.6.444) All but the when of the bobine as it is now, as its name already was: a click on its card opens that
 * one, and the card of a bobine changed since said « 7 prises » and the pictures of then for a bobine of 2. What
 * « Enregistrer » put there stays in its file (`archived`): the Bobine says by it what changed since.
 */
function archivedSummary(montage) {
  return {
    at: montage.archived.at,
    seconds: montageSeconds(montage),
    plans: montage.plans.length,
    pictures: montage.plans.filter(plan => plan.source).slice(0, 2).map(plan => plan.source),
  };
}

/** A montage with nothing in it yet, at the usual size of its format. */
export function newMontage({ name = 'Sans titre', format = '16:9', id = randomUUID(), now = new Date().toISOString() } = {}) {
  const size = usualSize(format);
  if (!size) throw invalid('Format de bobine inconnu.');
  return validateMontage(
    { schemaVersion: 1, id, name, format, width: size.width, height: size.height, fps: MONTAGE_RATES[0], plans: [], sounds: [] },
    { now },
  );
}

/**
 * (0.6.345) A plan of the bobine starting at `start`, named as the page names it, by its instants: « Prise de
 * 00.05 à 00.10 ». « Prise 4 », its place in the bobine, is what the page calls the 4th take of the project.
 */
export const planName = (start, plan) => `Prise de ${mono(start)} à ${mono(start + plan.to - plan.from)}`;

/**
 * What the engine assembles (runner/video/montage.py): the montage with the file of each source.
 * `fileOf(source)`: the absolute path of a creation, or a refusal. A sound that starts after the
 * end of the film is left out; nothing else is changed.
 */
export async function assemblyOf(montage, fileOf) {
  const total = montageSeconds(montage);
  if (!montage.plans.length) throw invalid('Cette bobine n’a encore aucune prise.');
  // (0.6.142) A film is made of takes: a plan to make has none yet.
  const waiting = montage.plans.findIndex(isTodo);
  if (waiting >= 0) {
    const count = montage.plans.filter(isTodo).length;
    throw invalid(`${count} ${count > 1 ? 'prises sont encore' : 'prise est encore'} à créer : ${count > 1 ? 'créez-les ou retirez-les' : 'créez-la ou retirez-la'} avant d’exporter le film.`);
  }
  const plans = [],
    starts = planStarts(montage);
  for (const [index, plan] of montage.plans.entries())
    plans.push({
      path: await fileOf(plan.source, planName(starts[index], plan)),
      // (0.6.149) Its instant: a hole before it is black and silent in the film.
      at: starts[index],
      kind: plan.kind,
      from: plan.from,
      to: plan.to,
      frame: plan.frame,
      volume: plan.volume ?? 1,
    });
  const sounds = [];
  for (const [index, sound] of montage.sounds.entries())
    if (sound.at < total)
      sounds.push({
        path: await fileOf(sound.source, `Son ${index + 1}`),
        at: sound.at,
        from: sound.from,
        to: sound.to,
        volume: sound.volume,
      });
  return { width: montage.width, height: montage.height, fps: montage.fps, plans, sounds };
}

/** (0.6.352) The name of a bobine whose file cannot be read, as far as its text still says it (lib/history.mjs). */
function unreadableName(text) {
  const found = String(text ?? '').match(/"name"\s*:\s*"((?:[^"\\]|\\.){1,240})"/);
  let name = '';
  try {
    name = found ? String(JSON.parse(`"${found[1]}"`)).trim().slice(0, MONTAGE_LIMITS.name) : '';
  } catch {}
  return name ? `${name} (illisible)` : 'Bobine illisible';
}

/** The montages of the projects, one file each: `<dir>/<project>/<id>.json`. */
export class Montages {
  constructor({ dir }) {
    this.dir = dir;
    this.pending = Promise.resolve();
  }
  #folder(project) {
    return join(this.dir, projectId(project));
  }
  #queue(work) {
    const run = this.pending.then(work);
    this.pending = run.catch(() => {});
    return run;
  }
  async #stored(project, id) {
    let text;
    try {
      text = await readFile(join(this.#folder(project), own(id, 'Bobine') + '.json'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw problem('Cette bobine n’existe plus.', 404);
      throw error;
    }
    try {
      return validateMontage(JSON.parse(text));
    } catch (error) {
      // (0.6.351) A file there that cannot be read, damaged or refused by a rule of today: said as such, never
      // « Erreur locale inattendue », and known (`unreadable`) to what would write over it or take it out, and
      // (0.6.352) to the list that names it (`text`).
      throw Object.assign(error.status ? error : problem('Son fichier est abîmé ; il est gardé tel quel.'), {
        unreadable: true,
        text,
      });
    }
  }
  /** The montages of a project, the last changed first: what a list shows of each. */
  async list(project) {
    let names;
    try {
      names = await readdir(this.#folder(project));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const found = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        const montage = await this.#stored(project, name.slice(0, -5));
        found.push({
          id: montage.id,
          name: montage.name,
          format: montage.format,
          plans: montage.plans.length,
          sounds: montage.sounds.length,
          seconds: montageSeconds(montage),
          updatedAt: montage.updatedAt,
          ...(montage.archived ? { archived: archivedSummary(montage) } : {}),
        });
      } catch (error) {
        // A file that cannot be read leaves the others. (0.6.352) Listed as such when it is there, by its name as
        // far as its text still says it and the date of its file: it went out of the Bobine without a word, a whole
        // bobine gone with a rule made harder by an update. Nothing of it is touched; the page does not open it.
        if (!error.unreadable) continue;
        const changed = await stat(join(this.#folder(project), name)).then(
          info => info.mtime.toISOString(),
          () => null,
        );
        if (changed)
          found.push({ id: name.slice(0, -5), name: unreadableName(error.text), updatedAt: changed, unreadable: true });
      }
    }
    return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  read(project, id) {
    return this.#stored(project, id);
  }
  /**
   * (0.6.147) The takes the montages of a project use, by « conversation/take »: the names of those
   * montages, the last changed first, each once. A plan, its photos (and the subjects of a take to create, 0.6.462), the end of a take it replaces,
   * a sound: what the question « Supprimer la prise 12 ? » says before a take goes (public/take-delete.mjs).
   */
  async uses(project) {
    const found = new Map();
    let names;
    try {
      names = await readdir(this.#folder(project));
    } catch (error) {
      if (error.code === 'ENOENT') return found;
      throw error;
    }
    const all = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
      try {
        all.push(await this.#stored(project, name.slice(0, -5)));
      } catch {
        // A file that cannot be read leaves the others.
      }
    }
    all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const montage of all) {
      const sources = [
        ...montage.plans.flatMap(plan => [plan.source, plan.photos?.start, plan.photos?.end, plan.replaces?.source, ...(plan.todo?.subjects ?? [])]),
        ...montage.sounds.map(sound => sound.source),
      ];
      for (const source of sources) {
        if (!source) continue;
        const key = source.conversationId + '/' + source.runId,
          list = found.get(key) ?? [];
        if (!list.includes(montage.name)) list.push(montage.name);
        found.set(key, list);
      }
    }
    return found;
  }
  /**
   * Keeps a montage, new or changed. Its date of creation stays the one it was first kept with.
   * (0.6.154) `archive`: « Enregistrer », the bobine as it is now put in the Archives, now; otherwise
   * what was put there stays as it was (what the page sends of it is never taken).
   */
  save(project, input, { archive = false } = {}) {
    return this.#queue(async () => {
      const now = new Date().toISOString();
      const montage = validateMontage({ ...input, updatedAt: now }, { now });
      delete montage.archived;
      let before = null;
      try {
        before = await this.#stored(project, montage.id);
        montage.createdAt = before.createdAt;
      } catch (error) {
        // (0.6.351) Never written over when its file cannot be read: nothing says what it held (a hand, a disk, a
        // later version), and only the user sends a bobine to the corbeille (« Supprimer la bobine »).
        if (error.unreadable) throw problem('Son fichier ne se lit plus ; rien n’est écrit par-dessus.', 409);
        if (error.status !== 404) throw error;
      }
      if (archive) montage.archived = { at: now, ...contentOf(montage) };
      else if (before?.archived) montage.archived = before.archived;
      await mkdir(this.#folder(project), { recursive: true });
      await atomicFile(join(this.#folder(project), montage.id + '.json'), JSON.stringify(montage, null, 2));
      return montage;
    });
  }
  /**
   * (0.6.444) « Retirer des Archives »: the bobine stays in the Bobine as it is, its card of the Archives goes with
   * what « Enregistrer » put there. Only « Supprimer la bobine » took a card out of the Archives, the bobine with
   * it. Its date of change stays: nothing it holds changed. `{ unarchived: false }`: it was not there (taken out
   * from another tab).
   */
  unarchive(project, id) {
    return this.#queue(async () => {
      const montage = await this.#stored(project, id).catch(error => {
        // As `save`: what nothing can read is never written over.
        if (error.unreadable) throw problem('Son fichier ne se lit plus ; rien n’est écrit par-dessus.', 409);
        throw error;
      });
      if (!montage.archived) return { unarchived: false };
      delete montage.archived;
      await atomicFile(join(this.#folder(project), montage.id + '.json'), JSON.stringify(montage, null, 2));
      return { unarchived: true };
    });
  }
  /**
   * Takes a montage out of its project. Its file is kept aside (`corbeille`), never destroyed
   * here: the takes it named are untouched in any case.
   */
  remove(project, id) {
    return this.#queue(async () => {
      // (0.6.351) Set aside as it is even when its file cannot be read: the user asks it, and it could be neither
      // kept nor taken out any more. Held an instant by Windows, tried again as the rest of the data is.
      await this.#stored(project, id).catch(error => {
        if (!error.unreadable) throw error;
      });
      const aside = join(this.#folder(project), 'corbeille');
      await mkdir(aside, { recursive: true });
      const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      await renameWithRetry(join(this.#folder(project), id + '.json'), join(aside, `${id}-${stamp}.json`));
      return { removed: id };
    });
  }
  /**
   * (0.6.442) A bobine of the corbeille back in its project as it was set aside, its card of the Archives with it.
   * « Bobine mise de côté. » said it could come back, and nothing took it back, while a conversation comes back
   * from its bin (lib/history.mjs). Set aside more than once, the last copy comes back. Never over a bobine of the
   * same identifier there (one the page kept since).
   */
  restore(project, id) {
    return this.#queue(async () => {
      own(id, 'Bobine');
      const aside = join(this.#folder(project), 'corbeille'),
        target = join(this.#folder(project), id + '.json'),
        key = name => ASIDE.exec(name)[2] + name;
      const copies = (await readdir(aside).catch(error => (error.code === 'ENOENT' ? [] : Promise.reject(error))))
        .filter(name => ASIDE.exec(name)?.[1] === id)
        .sort((a, b) => (key(a) < key(b) ? -1 : 1));
      if (!copies.length) throw problem('Cette bobine n’est plus dans la corbeille.', 404);
      if (await access(target).then(() => true, () => false))
        throw problem('Une bobine de même identifiant est déjà dans ce projet : rien n’a été remplacé.', 409);
      await renameWithRetry(join(aside, copies.at(-1)), target);
      return { restored: id };
    });
  }
  /**
   * (0.6.442) At launch, after the bin of the history: the bobines set aside more than 30 days ago go for good, as
   * a conversation does, by the instant their name says (a file keeps the date of its last change, not that of its
   * setting aside). One that cannot go now stays to the next launch; a name that says no instant stays. What went:
   * [{ project, id }].
   */
  purgeTrash({ now = Date.now() } = {}) {
    return this.#queue(async () => {
      const names = (folder, options) =>
          readdir(folder, options).catch(error => (error.code === 'ENOENT' ? [] : Promise.reject(error))),
        purged = [];
      for (const entry of await names(this.dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || (entry.name !== 'inbox' && !ID.test(entry.name))) continue;
        const aside = join(this.dir, entry.name, 'corbeille');
        for (const name of await names(aside).catch(() => [])) {
          const found = ASIDE.exec(name);
          if (!found || !(now - asideAt(found[2]) > ASIDE_MS)) continue;
          const gone = await rm(join(aside, name)).then(() => true, () => false);
          if (gone) purged.push({ project: entry.name, id: found[1] });
        }
      }
      return purged;
    });
  }
  /**
   * (0.6.289) The montages of a project that goes follow its takes: a project deleted gives its conversations
   * back to « Sans projet », and its bobines stayed in a folder no list read any more, neither the Bobine nor
   * the Archives, though the window said nothing was erased. Their files move as they are (read and kept
   * again, a bobine lost its card of the Archives), those set aside (`corbeille`) with them. Nothing is
   * written over where they arrive: a bobine whose identifier is taken there gets another. Asked again after
   * it was stopped, it moves what is left.
   */
  moveProject(from, to) {
    return this.#queue(async () => {
      const source = this.#folder(from),
        target = this.#folder(to);
      if (source === target) return { moved: 0 };
      const names = folder => readdir(folder).catch(error => (error.code === 'ENOENT' ? [] : Promise.reject(error))),
        taken = path => access(path).then(
          () => true,
          () => false,
        );
      let moved = 0;
      for (const name of await names(source)) {
        if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
        await mkdir(target, { recursive: true });
        if (!(await taken(join(target, name)))) await renameWithRetry(join(source, name), join(target, name));
        else {
          // Another identifier, said in the file too when it can be read (one that cannot stays as it is).
          const id = randomUUID(),
            text = await readFile(join(source, name), 'utf8');
          let renamed = null;
          try {
            renamed = JSON.stringify({ ...JSON.parse(text), id }, null, 2);
          } catch {}
          if (renamed === null) await renameWithRetry(join(source, name), join(target, id + '.json'));
          else {
            await atomicFile(join(target, id + '.json'), renamed);
            await rm(join(source, name));
          }
        }
        moved++;
      }
      for (const name of await names(join(source, 'corbeille'))) {
        if (!name.endsWith('.json')) continue;
        await mkdir(join(target, 'corbeille'), { recursive: true });
        let place = join(target, 'corbeille', name);
        for (let n = 2; await taken(place); n++) place = join(target, 'corbeille', `${name.slice(0, -5)}-${n}.json`);
        await renameWithRetry(join(source, 'corbeille', name), place);
      }
      // Its folders go once empty; anything else found there stays, and they with it.
      await rmdir(join(source, 'corbeille')).catch(() => {});
      await rmdir(source).catch(() => {});
      return { moved };
    });
  }
}
