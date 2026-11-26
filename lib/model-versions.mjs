/**
 * (0.6.117) The versions of a model: the files on this computer that are one of it, the one that is
 * used, and the workflow as it is made with that one (the page « Modèles », maquette du 19/11).
 *
 * A version is a file of the model, told by what it holds (lib/model-files.mjs): the one Moodix
 * ships the workflow with (« provided »), those found in the folder of the models, those the user
 * added from elsewhere. Nothing is copied nor moved: a file is read where it is.
 *
 * The rule: Moodix uses the provided version. A version the user picks is kept (`statePath`) and
 * used from then on; when its file is gone, the provided one is used again. The choice is kept
 * beside the workflows, never written into one: a shipped workflow stays the shipped one, and an
 * update of it brings no second copy. A workflow the user edited (« Réglages ») is left as they
 * wrote it, its file included: the editor has the last word.
 *
 * Some models come in two ways of being computed (MiniMax H3: distilled in 8 steps, MiniMax's own
 * in 20). The family says how a file tells which (`recipes`, as the engine reads it in
 * runner/pipelines/minimax_h3.py) and what each sets in the workflow; nobody has to know it. A
 * recipe may come in two files (FL2VA, and Ref2VA for the reference images): the second is its
 * `companion`, part of the version and no version of its own.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { problem } from './engine.mjs';
import { families } from './families.mjs';
import { describeModelFile, fits, modelsOf, taking, versionComponent } from './model-files.mjs';
import { validateNativeWorkflow } from './native-workflows.mjs';
import { atomicFile } from './update-files.mjs';

const EXTENSIONS = new Set(['.safetensors', '.gguf']);
// The same file under two spellings of its path (Windows does not tell the case of letters apart).
const spelled = path => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const same = (a, b) => spelled(a) === spelled(b);

// What a file name says of its format or of its making, not of what the version is.
const NOT_A_NAME =
  /^(?:int8|fp8|fp16|fp32|bf16|w4a8|nvfp4|convrot|e4m3fn|e5m2|scaled|pruned|comfy|transformer|model|diffusion|safetensors|gguf|\d+b|\d+[-_]?steps?|q\d(?:[_-][0km])*)$/i;

/**
 * The short name of a version, without the name of its model (« Distillé », « Uncensored v1.1 »):
 * the one its family gives the files it knows (`model.names`, by what their name holds), else
 * the name of the file less its model, its format and how it was made; the whole name when
 * nothing is left.
 */
export function versionName(file, manifest) {
  // (Less the mark a GGUF ends with: « .Q8_0 », « -Q4_K_M ».)
  const stem = basename(file)
    .replace(/\.(?:safetensors|gguf)$/i, '')
    .replace(/[._-]q\d+(?:_[a-z0-9]+)*$/i, '');
  for (const known of manifest?.model?.names ?? [])
    if (new RegExp(known.match, 'i').test(stem)) return known.name;
  const own = new Set(
    [manifest?.family ?? '', ...(manifest?.model?.name ?? '').split(/[\s-]+/)]
      .map(word => word.toLowerCase())
      .filter(Boolean),
  );
  const name = stem
    .split(/[\s_-]+/)
    .filter(word => word && !own.has(word.toLowerCase()) && !NOT_A_NAME.test(word))
    .join(' ');
  return name ? name[0].toUpperCase() + name.slice(1) : stem;
}

// The name of a file as it says what it is: less its ending.
/** Whether a file is there. */
const there = path =>
  stat(path).then(
    about => about.isFile(),
    () => false,
  );
const stemOf = path => basename(path ?? '').replace(/\.(?:safetensors|gguf)$/i, '');

/**
 * The recipe a file is computed with: the first of the family's whose marks it has, else the one without
 * marks. (0.6.419) A recipe may also ask something of the name of the file (`named`, a pattern): tensors
 * alone do not tell a distilled model merged into plain weights from the model it was distilled from.
 */
export function recipeOf(spec, described, path = '') {
  const recipes = Array.isArray(spec?.recipes) ? spec.recipes : [],
    stem = stemOf(path);
  return (
    recipes.find(
      recipe =>
        (!recipe.fingerprint || fits(described?.shapes, recipe.fingerprint)) &&
        (!recipe.named || new RegExp(recipe.named, 'i').test(stem)),
    ) ?? null
  );
}

/**
 * (0.6.419) What the name of a file says of its own settings, for a model whose versions differ by them: its
 * steps (« …_8step_… », « 4-steps », « 8steps »), as those who distil a model name their files. Nothing for a
 * family none of whose recipes sets the steps.
 */
export function saidByName(spec, path) {
  if (!(spec?.recipes ?? []).some(recipe => Object.hasOwn(recipe.parameters ?? {}, 'steps'))) return {};
  const steps = Number(/(?:^|[^a-z0-9])(\d{1,3})[\s_-]?steps?(?![a-z])/i.exec(stemOf(path))?.[1]);
  return steps >= 1 && steps <= 200 ? { steps } : {};
}

/**
 * Whether a file is the second file of its recipe (Ref2VA beside FL2VA), by the title it gives
 * itself or by its name: nothing else tells the two apart, their tensors have the same names and
 * shapes (19/11).
 */
export function isCompanion(recipe, described, path) {
  const named = recipe?.companion?.named;
  if (typeof named !== 'string' || !named) return false;
  const pattern = new RegExp(named, 'i');
  return pattern.test(described?.metadata?.['modelspec.title'] ?? '') || pattern.test(basename(path));
}

/**
 * A workflow as it is made with a version of its model. `choice`: { role, asset, file } the file of
 * the version; `parameters`, what its recipe sets (a fixed setting takes the value, one left to the
 * assistant takes it as its default, and each profile that names it); `companions`, the roles a
 * recipe of the family may fill, emptied first; `companion`, { role, asset, file } the one this
 * version fills.
 */
export function withVersion(workflow, { role, asset, file, parameters = {}, companions = [], companion = null }) {
  const next = structuredClone(workflow);
  next.components = { ...next.components, [role]: { policy: 'fixed', asset, file } };
  for (const other of companions) delete next.components[other];
  if (companion) next.components[companion.role] = { policy: 'fixed', asset: companion.asset, file: companion.file };
  for (const [key, value] of Object.entries(parameters)) {
    const policy = next.parameters?.[key];
    if (policy) next.parameters[key] = policy.policy === 'fixed' ? { ...policy, value } : { ...policy, default: value };
    for (const profile of Object.values(next.profiles ?? {}))
      if (profile?.parameters && Object.hasOwn(profile.parameters, key)) profile.parameters[key] = value;
  }
  return validateNativeWorkflow(next);
}

/** The most versions of one workflow whose settings are kept (the ones left longest ago go first). */
const KEPT_VERSIONS = 24;

/**
 * (0.6.420) `workflow` with the settings kept for a version of its model (ModelVersions.keep): those
 * of its settings it still has. The same object when nothing is kept, or when it cannot be made with them.
 */
export function withSettings(workflow, kept) {
  if (!kept?.parameters) return workflow;
  const next = structuredClone(workflow);
  for (const [key, policy] of Object.entries(kept.parameters))
    if (next.parameters?.[key]) next.parameters[key] = structuredClone(policy);
  for (const [name, values] of Object.entries(kept.profiles ?? {})) {
    const own = next.profiles?.[name]?.parameters;
    for (const [key, value] of Object.entries(own ? (values ?? {}) : {})) if (Object.hasOwn(own, key)) own[key] = value;
  }
  try {
    return validateNativeWorkflow(next);
  } catch {
    return workflow;
  }
}

export class ModelVersions {
  /**
   * `statePath`: where the choices are kept (data/model-versions.json). `assets`: the registry of
   * the files (lib/generation-assets.mjs): its folders are those looked in, and a version used is
   * registered there as any file of a workflow. `describe`: what reads a file (tests pass their own).
   * `now`: the clock (tests pass their own).
   */
  constructor({ statePath, assets, describe = describeModelFile, now = Date.now }) {
    Object.assign(this, { statePath: resolve(statePath), assets, describe, now });
    // What a file is for a family, kept while the file stays the same (path, size, date).
    this.facts = new Map();
    // The choices as last read, with the state of their file.
    this.kept = null;
    // What was last found for the file a workflow names (fitted), for a second.
    this.reads = new Map();
    this.pending = Promise.resolve();
  }

  /**
   * { used: { family: { path, asset, parameters?, companion? } }, added: { family: [path] },
   * settings: { workflow id: { file name: { parameters, profiles } } } }.
   */
  async #state() {
    let version;
    try {
      const about = await stat(this.statePath);
      version = [about.size, about.mtimeMs].join(':');
      if (this.kept?.version === version) return structuredClone(this.kept.state);
      const stored = JSON.parse(await readFile(this.statePath, 'utf8'));
      const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
      const state = { used: {}, added: {}, settings: {} };
      for (const [family, chosen] of Object.entries(plain(stored.used)))
        if (typeof chosen?.path === 'string' && typeof chosen.asset === 'string') state.used[family] = chosen;
      for (const [family, paths] of Object.entries(plain(stored.added)))
        if (Array.isArray(paths)) state.added[family] = paths.filter(path => typeof path === 'string' && path);
      for (const [id, files] of Object.entries(plain(stored.settings))) {
        const kept = Object.entries(plain(files)).filter(([, held]) => Object.keys(plain(held?.parameters)).length);
        if (kept.length) state.settings[id] = Object.fromEntries(kept);
      }
      this.kept = { version, state };
      return structuredClone(state);
    } catch {
      // No file yet, or one that cannot be read: nothing chosen, the provided versions.
      return { used: {}, added: {}, settings: {} };
    }
  }
  #save(state) {
    const operation = this.pending.then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true });
      // (Settings are written where some are kept: the file of who keeps none is as it was.)
      const { settings = {}, ...choices } = state,
        written = { schemaVersion: 1, ...choices, ...(Object.keys(settings).length ? { settings } : {}) };
      await atomicFile(this.statePath, JSON.stringify(written, null, 2));
      this.kept = null;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  /** The family of a workflow and the component its versions are files of, or null. */
  #model(workflow) {
    const manifest = families()[workflow?.pipeline],
      component = versionComponent(manifest);
    return component ? { manifest, ...component } : null;
  }

  /**
   * What the file at `path` is for a family: null when it is not there or is no version of it;
   * else { format, how, reason?, recipe?, parameters?, companion (whether it is the second file
   * of its recipe), bytes }.
   */
  async #fact(path, { manifest, spec }) {
    let about;
    try {
      about = await stat(path);
    } catch {
      return null;
    }
    if (!about.isFile()) return null;
    const key = [spelled(path), about.size, about.mtimeMs, manifest.family].join('|');
    if (!this.facts.has(key)) {
      if (this.facts.size >= 2000) this.facts.clear();
      let fact = null;
      try {
        const described = await this.describe(path, { shapes: true });
        if (modelsOf(described, { [manifest.family]: manifest }).length) {
          const recipe = recipeOf(spec, described, path),
            taken = taking(spec, described);
          fact = {
            format: described.format,
            how: taken.how,
            ...(taken.reason ? { reason: taken.reason } : {}),
            // (0.6.419) Its settings are its own: those of its recipe, then what its name says of them.
            ...(recipe ? { recipe: recipe.id, parameters: { ...recipe.parameters, ...saidByName(spec, path) } } : {}),
            companion: isCompanion(recipe, described, path),
            bytes: about.size,
          };
        }
      } catch {
        // Not a file of a model, or one that cannot be read: no version.
      }
      this.facts.set(key, fact);
    }
    return this.facts.get(key);
  }

  /** The files to look at for a family: those of its folders (one level down too), then those added. */
  async #files(model, state) {
    const { manifest, role } = model,
      folders = [this.assets.folder(manifest.family, role)]
        .flat()
        .filter(folder => typeof folder === 'string' && folder),
      found = [];
    for (const folder of folders) {
      const places = [folder];
      try {
        for (const entry of await readdir(folder, { withFileTypes: true }))
          if (entry.isDirectory()) places.push(join(folder, entry.name));
          else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) found.push(join(folder, entry.name));
      } catch {
        continue;
      }
      for (const place of places.slice(1))
        try {
          for (const entry of await readdir(place, { withFileTypes: true }))
            if (!entry.isDirectory() && EXTENSIONS.has(extname(entry.name).toLowerCase()))
              found.push(join(place, entry.name));
        } catch {
          // Unreadable: nothing to offer from there.
        }
    }
    const here = found.filter((path, index) => found.findIndex(other => same(other, path)) === index),
      added = (state.added[manifest.family] ?? []).filter(path => !here.some(other => same(other, path)));
    return [...here.map(path => ({ path, source: 'found' })), ...added.map(path => ({ path, source: 'added' }))];
  }

  /**
   * The versions of the model of `shipped`, a workflow as Moodix ships it; null for a model whose
   * file is not one to choose. `effective`: that workflow as the catalog lists it (made with the
   * version kept, or edited by the user); the version it really reads is the one said used.
   *
   * { family, role, provided: the name of the file Moodix ships it with, used: the path read (null
   *   when no file is there), versions: [{ path, file, name, bytes, format, how, reason?, recipe?,
   *   parameters?, source: 'provided' | 'found' | 'added', used, companion?: { role, path, file } }] }
   * The version used first, then the provided one, then the others by name.
   */
  async list(shipped, { effective = null } = {}) {
    const model = this.#model(shipped);
    if (!model) return null;
    const { manifest, role, spec } = model,
      state = await this.#state(),
      provided = shipped.components?.[role]?.file ?? '',
      versions = [],
      companions = new Map();
    for (const { path, source } of await this.#files(model, state)) {
      const fact = await this.#fact(path, model);
      if (!fact) continue;
      const { companion, ...told } = fact;
      // The second file of a recipe is part of the version whose first file is there.
      if (companion) companions.set(told.recipe, path);
      else
        versions.push({
          path,
          file: basename(path),
          name: versionName(path, manifest),
          ...told,
          source: basename(path).toLowerCase() === provided.toLowerCase() ? 'provided' : source,
        });
    }
    for (const version of versions) {
      const second = spec.recipes?.find(recipe => recipe.id === version.recipe)?.companion,
        path = second && companions.get(version.recipe);
      if (path) version.companion = { role: second.role, path, file: basename(path) };
    }
    // The file the workflow reads, wherever it was chosen.
    const made = effective ?? (await this.applied(shipped)),
      component = made.components?.[role];
    let used = null;
    if (component?.asset)
      try {
        const read = { kind: role, family: manifest.family, file: component.file };
        used = (await this.assets.resolve(component.asset, read)).path;
      } catch {
        // Nothing there to read: the model is to be downloaded.
      }
    const rank = version => (version.used ? 0 : version.source === 'provided' ? 1 : 2);
    for (const version of versions) version.used = Boolean(used) && same(version.path, used);
    versions.sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file, 'fr', { sensitivity: 'base' }));
    return { family: manifest.family, role, provided, used, versions };
  }

  /**
   * Keeps the version at `path` as the one used for the model of `shipped`; the provided one is
   * the rule, kept by forgetting any other. Refused, in the user's words, for a file that is not
   * a version of it, or that the model does not read as it is.
   */
  async use(shipped, path) {
    const { listed, version } = await this.#pick(shipped, path),
      state = await this.#state();
    if (version.source === 'provided') delete state.used[listed.family];
    else {
      const register = (kind, file) => this.assets.register({ path: file, kind, family: listed.family }),
        second = version.companion ? await register(version.companion.role, version.companion.path) : null;
      state.used[listed.family] = {
        path: version.path,
        asset: (await register(listed.role, version.path)).id,
        ...(version.parameters ? { parameters: version.parameters } : {}),
        ...(second
          ? { companion: { role: version.companion.role, asset: second.id, path: version.companion.path } }
          : {}),
      };
    }
    await this.#save(state);
    return this.list(shipped);
  }
  /** The version at `path` among those of `shipped`, when it can be used: refused in the user's words. */
  async #pick(shipped, path) {
    const listed = await this.list(shipped);
    if (!listed) throw problem(`${shipped?.name ?? 'Ce modèle'} n’a pas de version à choisir.`);
    const version = listed.versions.find(item => same(item.path, path));
    if (!version) throw problem('Cette version n’est plus sur cet ordinateur.', 404);
    if (version.how === 'convert')
      throw problem(`${version.file} est un GGUF : il se convertit avant de servir.`, 409);
    if (version.how !== 'direct')
      throw problem(`${version.file} ne se lit pas avec ${shipped.name} (${version.reason}).`);
    return { listed, version };
  }
  /**
   * The version at `path` as what a workflow is made with (withVersion), its files registered:
   * for a workflow the user edited, which is the one written to. Nothing is kept here.
   */
  async made(shipped, path) {
    const { listed, version } = await this.#pick(shipped, path),
      register = (kind, file) => this.assets.register({ path: file, kind, family: listed.family }),
      second = version.companion ? await register(version.companion.role, version.companion.path) : null;
    return {
      role: listed.role,
      asset: (await register(listed.role, version.path)).id,
      file: version.file,
      parameters: version.parameters ?? {},
      companions: (this.#model(shipped).spec.recipes ?? [])
        .map(recipe => recipe.companion?.role)
        .filter(Boolean),
      companion: second
        ? { role: version.companion.role, asset: second.id, file: version.companion.file }
        : null,
    };
  }

  /**
   * Adds a file from anywhere on the computer to the versions of the model of `shipped`; it is
   * read where it is. Refused with a line that names it when the model does not read it.
   */
  async add(shipped, path) {
    const model = this.#model(shipped);
    if (!model) throw problem(`${shipped?.name ?? 'Ce modèle'} n’a pas de version à choisir.`);
    const fact = await this.#fact(path, model);
    if (!fact) throw problem(`${basename(path)} ne se lit pas avec ${shipped.name}.`);
    if (fact.how === 'refused') throw problem(`${basename(path)} ne se lit pas avec ${shipped.name} (${fact.reason}).`);
    const state = await this.#state(),
      family = model.manifest.family;
    state.added[family] = [...(state.added[family] ?? []).filter(other => !same(other, path)), resolve(path)];
    await this.#save(state);
    return this.list(shipped);
  }

  /** Takes a file the user added out of the versions; the file stays on the disk. Used, the provided one is again. */
  async remove(shipped, path) {
    const model = this.#model(shipped);
    if (!model) return null;
    const state = await this.#state(),
      family = model.manifest.family;
    state.added[family] = (state.added[family] ?? []).filter(other => !same(other, path));
    if (!state.added[family].length) delete state.added[family];
    if (state.used[family] && same(state.used[family].path, path)) delete state.used[family];
    await this.#save(state);
    return this.list(shipped);
  }

  /**
   * (0.6.419) A workflow as it is made with the file it really reads, when that is not the file it
   * names. The file a workflow names may be gone (deleted, never downloaded): another file of the model
   * in the folder then stands for it (lib/generation-assets.mjs, `pick`). It was read with the settings
   * of the file that was gone, the steps of a distilled model for MiniMax's own or the reverse, and the
   * engine refused every creation (« il se calcule en 20 étapes, pas en 8 »). The file read is a version
   * of the model as any other: it comes with its own settings and its second file. The same object when
   * the workflow reads the file it names, or nothing, or a file that says nothing of its settings.
   * (0.6.420) `own`: the workflow is the user's copy, and the settings they gave that file come with it.
   */
  async fitted(workflow, { own = false } = {}) {
    const model = this.#model(workflow);
    if (!model) return workflow;
    const { manifest, role, spec } = model,
      component = workflow.components?.[role];
    if (!component?.asset || !component.file) return workflow;
    // This runs at every listing of the workflows (the Studio opening), and asking the registry for a file
    // that is not there reads its folder: 6 ms for one such model, 4 ms more on the 90 of a listing
    // (measured on the 14 workflows shipped). What was found is held for a second; past it, the file found
    // by its name where it was costs one look at the disk, and anything else is asked again.
    const key = component.asset + '|' + component.file.toLowerCase(),
      last = this.reads.get(key),
      now = this.now(),
      // (Its own asset still: the file is found by its name where it is (resolve), nothing is registered.)
      made = async stands => {
        if (!stands) return workflow;
        try {
          const next = withVersion(workflow, { role, asset: component.asset, ...stands });
          return own ? withSettings(next, await this.keptOf(workflow.id, stands.file)) : next;
        } catch {
          return workflow;
        }
      },
      held = found => {
        if (this.reads.size >= 500) this.reads.clear();
        this.reads.set(key, { at: now, ...found });
        return made(found.stands);
      };
    if (last && now - last.at < 1000) return made(last.stands);
    if (last?.path && (await there(last.path))) {
      last.at = now;
      return workflow;
    }
    let read;
    try {
      const asked = { kind: role, family: manifest.family, file: component.file };
      read = (await this.assets.resolve(component.asset, asked)).path;
    } catch {
      // Nothing there to read: the model is to be downloaded.
      return held({});
    }
    if (typeof read !== 'string') return held({});
    if (basename(read).toLowerCase() === component.file.toLowerCase()) return held({ path: read });
    const fact = await this.#fact(read, model);
    // (The second file of a recipe is no version by itself: left as it is.)
    if (!fact?.recipe || fact.companion) return held({});
    try {
      const second = spec.recipes.find(recipe => recipe.id === fact.recipe)?.companion,
        beside = second ? await this.#beside(model, fact.recipe) : null,
        kept = beside ? await this.assets.register({ path: beside, kind: second.role, family: manifest.family }) : null;
      return held({
        stands: {
          file: basename(read),
          parameters: fact.parameters,
          companions: spec.recipes.map(recipe => recipe.companion?.role).filter(Boolean),
          companion: kept ? { role: second.role, asset: kept.id, file: basename(beside) } : null,
        },
      });
    } catch {
      return workflow;
    }
  }
  /**
   * (0.6.420) Each version of a model has its own settings. Those the user gave the version `file` of
   * the workflow they edited are kept when they leave it for another (GenerationService.useVersion), and
   * come back with it (keptOf, withSettings). Leaving FastH3 for MiniMax's own model and coming back left
   * the steps of the recipe and whatever had been set for the other.
   */
  async keep(workflowId, file, workflow) {
    if (typeof workflowId !== 'string' || !workflowId || typeof file !== 'string' || !file) return;
    const state = await this.#state(),
      { [file.toLowerCase()]: former, ...others } = state.settings[workflowId] ?? {},
      profiles = Object.entries(workflow.profiles ?? {}).filter(([, profile]) => profile?.parameters);
    // (Written last: the oldest are the first.)
    const kept = Object.entries({
      ...others,
      [file.toLowerCase()]: structuredClone({
        parameters: workflow.parameters ?? {},
        profiles: Object.fromEntries(profiles.map(([name, profile]) => [name, profile.parameters])),
      }),
    });
    state.settings[workflowId] = Object.fromEntries(kept.slice(-KEPT_VERSIONS));
    await this.#save(state);
  }
  /** The settings kept for the version `file` of a workflow, or null. */
  async keptOf(workflowId, file) {
    return (await this.#state()).settings[workflowId]?.[String(file).toLowerCase()] ?? null;
  }
  /** Forgets the settings kept for the versions of a workflow (the user takes it back as shipped). */
  async forget(workflowId) {
    const state = await this.#state();
    if (!state.settings[workflowId]) return;
    delete state.settings[workflowId];
    await this.#save(state);
  }
  /** The second file of a recipe among the files of the model, or null. */
  async #beside(model, recipe) {
    for (const { path } of await this.#files(model, await this.#state())) {
      const fact = await this.#fact(path, model);
      if (fact?.companion && fact.recipe === recipe) return path;
    }
    return null;
  }

  /**
   * `shipped` as it is made with the version the user keeps for its model: the same object when
   * none is kept, when its file is gone, or when the workflow cannot be made with it. (0.6.419) With
   * none kept, or one whose file is gone, as it is made with the file it really reads (fitted).
   */
  async applied(shipped) {
    const model = this.#model(shipped);
    if (!model) return shipped;
    const chosen = (await this.#state()).used[model.manifest.family];
    if (!chosen) return this.fitted(shipped);
    if (!(await there(chosen.path))) return this.fitted(shipped);
    const second = chosen.companion && (await there(chosen.companion.path)) ? chosen.companion : null;
    try {
      return withVersion(shipped, {
        role: model.role,
        asset: chosen.asset,
        file: basename(chosen.path),
        parameters: chosen.parameters,
        companions: (model.spec.recipes ?? []).map(recipe => recipe.companion?.role).filter(Boolean),
        companion: second ? { role: second.role, asset: second.asset, file: basename(second.path) } : null,
      });
    } catch {
      return shipped;
    }
  }
}
