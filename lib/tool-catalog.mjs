import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { problem } from './engine.mjs';
import { family, familyPrompt } from './families.mjs';
import {
  componentStandIn,
  effective,
  madeLora,
  madePolicy,
  onlyRoles,
  policySchema,
  referenceLora,
  unreadParameters,
  workflowSchema,
} from './native-workflows.mjs';
import { FORMATS } from '../public/formats.mjs';
import { SETTING_NAMES } from '../public/setting-names.mjs';
import { takesCamera } from '../public/camera.mjs';
import { orList, subjectsTaken } from '../public/montage-model.mjs';
import { CAPABLE, RAILS } from './model-wording.mjs';
import { TASKS } from './tasks.mjs';

/**
 * The language model sees a few intent verbs (tasks.json) instead of one tool per workflow.
 * It passes a prompt and assigns images or videos to roles (source, start_image, reference…);
 * the router then picks the enabled workflow whose reference slots match those roles.
 * Verbs, roles, parameters and descriptions are all derived from tasks.json, the family
 * manifests and the user's workflows: adding a workflow or a family adds or extends tools.
 */
export { TASKS };
/**
 * The words of the verbs for a capable model (lib/model-wording.mjs): what tasks.json says to the
 * small local model (a plan agreed in words before a video, limits of lines), said as a contract.
 * Only words: the roles, their media and what is required stay those of tasks.json.
 */
const CAPABLE_TASKS = JSON.parse(readFileSync(new URL('./tasks-capable.json', import.meta.url), 'utf8'));
function capableTask(name) {
  const task = TASKS[name],
    words = CAPABLE_TASKS[name] ?? {};
  const described = (specs, own) =>
    Object.fromEntries(
      Object.entries(specs ?? {}).map(([key, spec]) => [
        key,
        { ...spec, ...(own?.[key]?.description ? { description: own[key].description } : {}) },
      ]),
    );
  return {
    ...task,
    ...(words.summary ? { summary: words.summary } : {}),
    ...(words.guidance ? { guidance: words.guidance } : {}),
    ...(words.prompt ? { prompt: words.prompt } : {}),
    roles: described(task.roles, words.roles),
    ...(task.arguments ? { arguments: described(task.arguments, words.arguments) } : {}),
  };
}
// Settings a family leaves to the model without saying what they are: said to a capable model.
const CAPABLE_SETTINGS = {
  stage:
    'draft: a quick preview, smaller, to check the motion; final: full size and quality, several times slower. Leave it out for a draft; final only when the user asks for the final version.',
  width: 'Width in pixels, only when the user asks for a size or a shape. Omit it otherwise.',
  height: 'Height in pixels, only when the user asks for a size or a shape. Omit it otherwise.',
};
const RESERVED = new Set([
  'workflow',
  'prompt',
  'intention',
  'reuse_output',
  'loras',
  'components',
  'duration',
  'seed',
  'format',
]);
// `conversation`: an earlier result of another conversation of the project (the Sortie of the
// Studio is the project's), never offered to the model.
const SOURCE_KEYS = ['image', 'resource', 'frame', 'output', 'index', 'conversation'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// `frame` by name: the exact first or last image of a video (a take, a video reference), where an
// image is taken. Offered to a capable model only; accepted from any (ToolRuntime, stills).
export const STILL_FRAMES = ['first', 'last'];
/** The roles of a verb that take an image: where a frame of a video stands in for one. */
export const imageRoles = name =>
  Object.entries(TASKS[name]?.roles ?? {})
    .filter(([, spec]) => spec.media.includes('image'))
    .map(([role]) => role);
// A take of the project by its number, « PRISE n »: the application finds it (server.mjs, withTakes).
const TAKE = 'Number of a take of this project, as the user sees it (« PRISE 12 », « la prise 12 »).';

const sourceSchema = {
  type: 'object',
  properties: {
    image: { type: 'integer', minimum: 0, description: 'Position of an image the user attached (0 = first).' },
    resource: { type: 'string', description: 'ID of an active resource.' },
    frame: { type: 'integer', minimum: 0, maximum: 2, description: 'Frame of a video resource used as an image.' },
    output: { type: 'string', description: 'run_id of an earlier result in this conversation.' },
    index: { type: 'integer', minimum: 0, description: 'Output position within that run (default 0).' },
    take: { type: 'integer', minimum: 1, description: TAKE },
  },
  additionalProperties: false,
};

/**
 * The sources of a capable model (lib/model-wording.mjs): the same for every request of every
 * conversation, so that the definitions stay in the cache of the provider. Takes and references by
 * their numbers, as the user names them; the application finds them in the project (server.mjs,
 * withTakes and refsToIds) and answers a number that is none. No list of identifiers: on 0.6.43 the
 * definitions changed with each project and each creation, and the cache with them.
 */
// (Said once in the description of the tool, « Sources: », not in each of its roles: a dozen roles
// repeated the same words, 1 300 tokens of every request.)
const capableSourceSchema = {
  type: 'object',
  properties: {
    take: { type: 'integer', minimum: 1 },
    ref: { type: 'integer', minimum: 1 },
    // An image of a video used as an image: its exact first or last one (of a take or a reference,
    // kept as a reference of the project: ToolRuntime, stills), or a sample of a video reference.
    frame: {
      anyOf: [
        { type: 'string', enum: STILL_FRAMES },
        { type: 'integer', minimum: 0, maximum: 2 },
      ],
    },
    image: { type: 'integer', minimum: 0 },
    output: { type: 'string' },
    index: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};
const capableWholeSchema = {
  ...capableSourceSchema,
  properties: Object.fromEntries(Object.entries(capableSourceSchema.properties).filter(([key]) => key !== 'frame')),
};

/** A source for a role that takes a video whole: no frame of it to name. */
const wholeSourceSchema = {
  ...sourceSchema,
  properties: Object.fromEntries(Object.entries(sourceSchema.properties).filter(([key]) => key !== 'frame')),
};

/**
 * Source schema restricted to what the conversation can actually reference: attached images
 * (by position), active resources and earlier native results (by enumerated ID). Each variant
 * requires its key, so a constrained decoder can neither leave a source empty nor invent an ID.
 * Returns null when nothing of a compatible media exists.
 */
function availableSourceSchema(media, available) {
  const variants = [];
  if (media.includes('image') && available.images > 0)
    variants.push({
      type: 'object',
      properties: { image: { ...sourceSchema.properties.image, maximum: available.images - 1 } },
      required: ['image'],
      additionalProperties: false,
    });
  // A video resource can stand in for an image through one of its frames.
  const resources = available.resources.filter(
    item => media.includes(item.type) || (item.type === 'video' && media.includes('image')),
  );
  if (resources.length)
    variants.push({
      type: 'object',
      properties: {
        resource: { type: 'string', enum: resources.map(item => item.id), description: 'ID of an active resource.' },
        // A frame of a video stands in for an image: a role that takes the video itself is not
        // offered one (named there, the video became an image and the call was refused).
        ...(media.includes('image') && resources.some(item => item.type === 'video')
          ? { frame: sourceSchema.properties.frame }
          : {}),
      },
      required: ['resource'],
      additionalProperties: false,
    });
  const outputs = available.outputs.filter(item => media.includes(item.mediaType));
  if (outputs.length)
    variants.push({
      type: 'object',
      properties: {
        output: {
          type: 'string',
          enum: outputs.map(item => item.id),
          description: 'run_id of an earlier result in this conversation.',
        },
        index: { ...sourceSchema.properties.index, maximum: Math.max(...outputs.map(item => item.count)) - 1 },
      },
      required: ['output'],
      additionalProperties: false,
    });
  // The takes of the project by their number, those of this conversation and of the others.
  const takes = available.takes.filter(item => media.includes(item.mediaType));
  if (takes.length)
    variants.push({
      type: 'object',
      properties: { take: { type: 'integer', enum: takes.map(item => item.take), description: TAKE } },
      required: ['take'],
      additionalProperties: false,
    });
  if (!variants.length) return null;
  return variants.length === 1 ? variants[0] : { anyOf: variants };
}

/** Normalizes the caller's description of referenceable sources, or null to advertise them generically. */
function availability(available) {
  if (available === undefined) return null;
  const list = value => (Array.isArray(value) ? value : []);
  return {
    images: Number.isInteger(available.images) && available.images > 0 ? available.images : 0,
    resources: list(available.resources).filter(item => typeof item?.id === 'string'),
    outputs: list(available.outputs).filter(
      item => typeof item?.id === 'string' && Number.isInteger(item.count) && item.count > 0,
    ),
    takes: list(available.takes).filter(item => Number.isInteger(item?.take) && typeof item.mediaType === 'string'),
  };
}

/** Workflows of different families that each say what they are the one for. */
const chosen = serving =>
  serving.length > 1 &&
  serving.every(workflow => family(workflow.pipeline).chooseFor) &&
  new Set(serving.map(workflow => workflow.pipeline)).size > 1;
/**
 * One property for a setting several workflows own with different limits (a music length up
 * to ten minutes, a sound effect up to thirty seconds): the widest bounds, and each workflow's
 * own description when it differs. The application keeps the chosen workflow's bounds.
 */
function widen(current, schema, id) {
  const merged = { ...current };
  if (schema.minimum !== undefined && merged.minimum !== undefined)
    merged.minimum = Math.min(merged.minimum, schema.minimum);
  else delete merged.minimum;
  if (schema.maximum !== undefined && merged.maximum !== undefined)
    merged.maximum = Math.max(merged.maximum, schema.maximum);
  else delete merged.maximum;
  if (schema.description && !merged.description?.includes(schema.description))
    merged.description = [merged.description, `For ${id}: ${schema.description}`].filter(Boolean).join(' ');
  return merged;
}
/** Whether the model may choose this workflow's clip length (its frame count is a model choice). */
const timed = workflow => workflow.mediaType === 'video' && workflow.parameters.frames?.policy === 'model';
const drawsSeed = workflow => workflow.parameters.seed?.policy === 'random';
/** A video workflow whose width and height are its own: the model names a format, not a size. */
const sized = workflow =>
  workflow.mediaType === 'video' &&
  ['width', 'height'].every(key => workflow.parameters[key] && workflow.parameters[key].policy !== 'model');
// The rate a clip is made at: that of its profile when it has profiles, which replaces the value of
// the workflow in the job (the editor greys that value for this reason). Read the other way round,
// a length asked in seconds was counted at one rate and made at another: 5 s gave 4 s.
const fpsOf = workflow =>
  workflow.profiles?.draft?.parameters.fps ?? workflow.parameters.fps?.value ?? workflow.parameters.fps?.default ?? 24;
/** The frames of its source a continuation renders again with this workflow. */
const overlapOf = workflow =>
  workflow.parameters.overlap_frames?.value ??
  workflow.parameters.overlap_frames?.default ??
  family(workflow.pipeline).parameters.overlap_frames?.choices?.[0] ??
  0;
/** The frame counts a workflow allows: its list, or its range step by step. */
function frameCounts(workflow) {
  const spec = effective(workflow.parameters.frames, family(workflow.pipeline).parameters.frames ?? {});
  if (spec.choices) return spec.choices;
  const step = spec.multipleOf || 1,
    low = Math.ceil((spec.min ?? 1) / step) * step,
    high = spec.max ?? low + 600 * step,
    counts = [];
  for (let value = low; value <= high && counts.length < 4096; value += step) counts.push(value);
  return counts;
}

/**
 * The frame count closest to `seconds` (of new footage for a continuation, which also re-renders
 * `overlap` frames of its source) among those the workflow allows, and the length it gives.
 */
export function framesFor(workflow, seconds, { continuation = false } = {}) {
  const fps = fpsOf(workflow),
    overlap = continuation ? overlapOf(workflow) : 0,
    choices = frameCounts(workflow);
  const length = frames => (frames - overlap) / fps,
    longer = choices.filter(value => value > overlap);
  // (0.6.404) None longer than what a continuation renders again of its source: said, where « Reduce of empty
  // array with no initial value » was thrown. No workflow shipped is so.
  if (!longer.length)
    throw problem(
      `Ce workflow ne peut pas prolonger une vidéo : aucune de ses durées ne dépasse les ${overlap} images ` +
        'reprises de la vidéo d’origine.',
    );
  const frames = longer.reduce((best, value) => {
    const gap = Math.abs(length(value) - seconds),
      bestGap = Math.abs(length(best) - seconds);
    return gap < bestGap - 1e-9 || (Math.abs(gap - bestGap) <= 1e-9 && value > best) ? value : best;
  });
  return { frames, seconds: length(frames) };
}

/**
 * The lengths, in seconds, a video workflow whose frames the model chooses makes for the verb `name`: `{ seconds,
 * standard }` (for a continuation, what it adds), or null. A free range is offered by the second, a list as it is.
 * (0.6.461) Shared by the Studio and the Bobine, which cuts a take longer than the longest (montage-model.mjs `partsOf`).
 */
function lengthsOf(workflow, name) {
  const p = workflow.parameters,
    manifest = family(workflow.pipeline);
  if (workflow.mediaType !== 'video' || p.frames?.policy !== 'model') return null;
  const spec = effective(p.frames, manifest.parameters.frames ?? {}),
    fps = fpsOf(workflow),
    continuation = name === 'extend_video',
    overlap = continuation ? overlapOf(workflow) : 0,
    frames = spec.choices ?? Array.from({ length: 30 }, (_, index) => framesFor(workflow, index + 1, { continuation }).frames),
    seconds = [...new Set(frames.filter(count => count > overlap).map(count => (count - overlap) / fps))]
      .filter(length => length >= 0.5)
      .sort((a, b) => a - b),
    standard = p.frames.default ?? manifest.parameters.frames?.default;
  return { seconds, standard: Number.isFinite(standard) ? (standard - overlap) / fps : null };
}

/**
 * The slots of a workflow that take a verb's role. Given the verb (`name`), a role its family
 * does not combine with one the verb requires has none (LTX 2.5: subject references beside the
 * video a continuation starts from).
 */
const slotsFor = (workflow, role, name) => {
  const manifest = family(workflow.pipeline);
  const groups = manifest.exclusive ?? [],
    own = groups.find(group => group.includes(role)),
    needed = Object.entries(TASKS[name]?.roles ?? {}).filter(([other, spec]) => spec.required && other !== role);
  if (own && needed.some(([other]) => groups.some(group => group !== own && group.includes(other)))) return [];
  return workflow.references.filter(slot => manifest.roles[slot.role]?.as === role);
};
const slotMedia = (workflow, slot) => family(workflow.pipeline).roles[slot.role].media;

/** (0.6.476) The input of a slot (`input`) given by a source as the router reads it: an image, a resource, a result. */
export function referenceOf(slot, source) {
  const reference = { input: slot.id };
  if (source.image !== undefined) reference.image = source.image;
  if (source.resource !== undefined) {
    reference.resource_id = source.resource;
    if (source.frame !== undefined) reference.frame = source.frame;
  }
  if (source.output !== undefined) {
    reference.output_id = source.output;
    if (source.index !== undefined) reference.output_index = source.index;
    if (source.conversation !== undefined) reference.output_conversation = source.conversation;
  }
  return reference;
}

/**
 * (0.6.476) Where the inputs passed (`provided`: by role of the verb `name`, each with its media) go in a workflow, and
 * what it does not take: each in the first free slot of its role and media, in their order, as assign() places them,
 * unless its family does not combine it with an input placed before (`exclusive`: MiniMax H3, subjects or a start and
 * an end image). `placed`: [{ role, index, slot }]; `left`: [{ role, index, kind, count }] ('none': no slot of its
 * role, 'full': its `count` slots are taken, 'apart': not with what is placed); `missing`: the name of a required slot
 * left empty.
 */
export function fitInputs(workflow, provided, name) {
  const groups = family(workflow.pipeline).exclusive ?? [],
    used = new Set(),
    taken = new Set(),
    placed = [],
    left = [];
  for (const [role, list] of Object.entries(provided))
    list.forEach((source, index) => {
      const slots = slotsFor(workflow, role, name).filter(slot => slotMedia(workflow, slot) === source.media),
        slot = slots.find(item => !used.has(item.id)),
        own = groups.find(group => group.includes(role)),
        apart = own && groups.some(group => group !== own && group.some(item => taken.has(item)));
      if (!slots.length) left.push({ role, index, kind: 'none' });
      else if (!slot) left.push({ role, index, kind: 'full', count: slots.length });
      else if (apart) left.push({ role, index, kind: 'apart' });
      else {
        used.add(slot.id);
        taken.add(role);
        placed.push({ role, index, slot });
      }
    });
  const missing = workflow.references.find(slot => slot.required && !used.has(slot.id));
  return { placed, left, ...(missing ? { missing: missing.name || missing.id } : {}) };
}

// (0.6.476) What a family takes of each of its exclusive groups, as the card says it: « des sujets ou un début et une
// fin ».
const GROUP_WORDS = {
  reference: 'des sujets',
  start_image: 'un début et une fin',
  end_image: 'un début et une fin',
  source: 'une vidéo',
};
const IMAGE_WORDS = { start_image: 'd’image de début', end_image: 'd’image de fin', source: 'd’image à modifier' };

/**
 * (0.6.476) Why an input passed is not sent (`item`, of fitInputs' `left`), in the words the Bobine says of a piece its
 * model does not take (public/montage.mjs: notTaken, subjectLeft): it stays in the card, greyed, this reason in its
 * bubble. `label`: the name of the model; `others`: the models that take subjects, named when it takes none
 * (« choisissez … »).
 */
export function leftWhy(workflow, name, { role, kind, count }, { label = workflow.name, others = '' } = {}) {
  const video = TASKS[name]?.output === 'video' || name === 'extend_video',
    groups = family(workflow.pipeline).exclusive ?? [],
    both = () => [...new Set(groups.map(group => GROUP_WORDS[group[0]] ?? group.join(' et ')))].join(' ou '),
    plural = count > 1 ? 's' : '';
  if (role === 'reference' && video) {
    if (kind === 'full')
      return `${label} prend ${count} sujet${plural} au plus : celui-ci reste là, mais n’est pas envoyé.`;
    if (kind === 'apart') return `${label} prend ${both()}, pas les deux : celui-ci reste là, mais n’est pas envoyé.`;
    const suite = name === 'extend_video' && slotsFor(workflow, 'reference', 'create_video').length > 0;
    return (
      (suite
        ? `${label} ne prend pas de sujet dans une suite.` +
          (others ? ` Pour une suite avec des sujets : ${others}.` : '')
        : `${label} ne prend pas de sujet${others ? ' : choisissez ' + others : ''}.`) +
      ' Il reste là, mais n’est pas envoyé.'
    );
  }
  if (role === 'reference')
    return kind === 'full'
      ? `${label} prend ${count} autre${plural} image${plural} au plus : celle-ci reste là, mais n’est pas envoyée.`
      : `${label} ne prend pas d’autre image : elle reste là, mais n’est pas envoyée.`;
  if (kind === 'apart') return `${label} prend ${both()}, pas les deux : elle reste là, mais n’est pas envoyée.`;
  return `${label} ne prend pas ${IMAGE_WORDS[role] ?? 'cette image'} : elle reste là, mais n’est pas envoyée.`;
}

/**
 * (0.6.476) The line of the card of a proposal whose model does not send every input (`held`: those greyed, by the
 * role of the verb, `as`): what is not sent, named as the card names it (« Début », « Sujet 3 »), and what to do:
 * remove it, or choose a model that takes everything (`others`, their names). A family that does not combine two of
 * them (MiniMax H3: subjects, or a start and an end) says which to remove. `references`: what it sends, by the role of
 * its family. '' when it sends everything.
 */
export function heldWarning(workflow, name, references = [], held = [], others = []) {
  if (!held.length) return '';
  const manifest = family(workflow.pipeline),
    roles = manifest.roles ?? {},
    sent = references.map(ref => roles[ref.role]?.as),
    every = [...sent, ...held.map(item => item.as)],
    frames = (manifest.exclusive ?? []).some(group => group.includes('start_image') || group.includes('end_image'));
  if (frames && held.some(item => item.kind === 'apart')) {
    const starts = every.includes('start_image'),
      ends = every.includes('end_image'),
      them = starts && ends ? 'les images de début et de fin' : starts ? 'l’image de début' : 'l’image de fin';
    return (
      `${workflow.name} prend des sujets ou un début et une fin, pas les deux : retirez ${them} ou ` +
      `${every.filter(role => role === 'reference').length > 1 ? 'les sujets' : 'le sujet'}.`
    );
  }
  let subject = sent.filter(role => role === 'reference').length;
  const named = held.map(item =>
    item.as === 'start_image'
      ? { text: 'l’image de début', image: true }
      : item.as === 'end_image'
        ? { text: 'l’image de fin', image: true }
        : item.as === 'source'
          ? { text: 'l’image à modifier', image: true }
          : { text: `le sujet ${++subject}`, image: false },
  );
  const one = named.length === 1,
    images = named.every(item => item.image),
    list = named.map(item => item.text),
    what = list.length > 1 ? list.slice(0, -1).join(', ') + ' et ' + list.at(-1) : list[0];
  return (
    what.charAt(0).toUpperCase() +
    what.slice(1) +
    (one ? ` n’est pas envoyé${images ? 'e' : ''}` : ` ne sont pas envoyé${images ? 'e' : ''}s`) +
    ` à ${workflow.name} : retirez-${one ? (images ? 'la' : 'le') : 'les'}` +
    (others.length ? `, ou choisissez ${orList(others)}` : '') +
    '.'
  );
}

/**
 * (0.6.476) What a proposal says of the inputs its model does not send (`held`) where no card shows them greyed (an
 * image of Moodix AI, made at once in the Chat or set in the Studio), and what its take keeps of them, which its model
 * is told with its result: each by its name, as the image named and left out is said (« #ref3 et Prise 7 ne sont pas
 * envoyées à Krea 2. »). '' when it sends everything.
 */
export function heldNote(workflow, held = []) {
  if (!held.length) return '';
  const names = held.map((item, index) => item.label || 'Image ' + (index + 1)),
    list = names.length > 1 ? names.slice(0, -1).join(', ') + ' et ' + names.at(-1) : names[0];
  return `${list} ${names.length > 1 ? 'ne sont pas envoyées' : 'n’est pas envoyée'} à ${workflow.name}.`;
}

/** Whether a workflow can perform a verb at all, independently of the sources provided. */
export function serves(workflow, name) {
  const task = TASKS[name],
    manifest = family(workflow.pipeline);
  if (!task || !manifest.tasks.includes(name)) return false;
  if (task.output !== 'source' && task.output !== manifest.mediaType) return false;
  for (const [role, spec] of Object.entries(task.roles))
    if (spec.required && !slotsFor(workflow, role, name).some(slot => spec.media.includes(slotMedia(workflow, slot))))
      return false;
  // A required slot outside this verb's roles (a mandatory source video, say) excludes the workflow.
  return workflow.references.every(slot => !slot.required || Object.hasOwn(task.roles, manifest.roles[slot.role].as));
}

/**
 * The slots of a workflow a verb can fill: those of the verb's own roles, less the ones its family
 * does not combine with a role the verb requires (slotsFor). What the model may pass and what the
 * card of a proposal lets the user add are the same slots: no first or last frame on a
 * continuation, no subject reference beside the video LTX 2.5 continues.
 */
export function verbSlots(workflow, name) {
  const task = TASKS[name];
  // A verb the catalog does not know has no rule of its own: every slot.
  if (!task) return [...workflow.references];
  // (0.6.152) Not a role of the user's own hand only: the card of a proposal is the chat model's.
  const open = new Set(
    Object.keys(task.roles)
      .filter(role => !task.roles[role].hand)
      .flatMap(role => slotsFor(workflow, role, name).map(slot => slot.id)),
  );
  return workflow.references.filter(slot => open.has(slot.id));
}

/**
 * The inputs a family does not combine, among the slots a proposal fills (`held`, their ids): the
 * slots filled of each of its exclusive groups, when several groups hold one (MiniMax: reference
 * images, and a start or an end image); empty when the inputs go together. The test route() makes
 * of what the model passes, made of what a card holds.
 */
export function apartInputs(workflow, held) {
  const manifest = family(workflow.pipeline),
    filled = workflow.references.filter(slot => held.includes(slot.id)),
    groups = (manifest.exclusive ?? [])
      .map(group => filled.filter(slot => group.includes(manifest.roles[slot.role]?.as)))
      .filter(slots => slots.length);
  return groups.length > 1 ? groups : [];
}

/**
 * The inputs the card of a proposal of `name` shows, by the role each slot has in its family
 * (`start_image`, `msr_image`…): the slots filled (`held`, their ids), and those where one more
 * input may go beside them.
 */
export function openRoles(workflow, name, held = []) {
  const open = new Set(verbSlots(workflow, name).map(slot => slot.id));
  return workflow.references
    .filter(slot => held.includes(slot.id) || (open.has(slot.id) && !apartInputs(workflow, [...held, slot.id]).length))
    .map(slot => slot.role);
}

function sources(name, args) {
  const assigned = {};
  for (const [role, spec] of Object.entries(TASKS[name].roles)) {
    if (args[role] === undefined) {
      if (spec.required) throw problem(`${name} needs a ${role}: ${spec.description}`);
      continue;
    }
    const list = spec.many ? args[role] : [args[role]];
    if (!Array.isArray(list) || list.length > 64)
      throw problem(`${role} must be ${spec.many ? 'a list of sources' : 'one source'}.`);
    for (const source of list) {
      const kinds = ['image', 'resource', 'output'].filter(key => source?.[key] !== undefined);
      if (
        !source ||
        typeof source !== 'object' ||
        Array.isArray(source) ||
        Object.keys(source).some(key => !SOURCE_KEYS.includes(key)) ||
        kinds.length !== 1
      )
        throw problem(`Each ${role} needs exactly one of image, resource or output.`);
      if (source.conversation !== undefined && (source.output === undefined || !UUID.test(String(source.conversation))))
        throw problem(`${role}: a conversation goes only with an output.`);
    }
    // A role that takes a video whole: a frame named with it says nothing, the video is meant.
    const whole = !spec.media.includes('image');
    if (list.length) assigned[role] = whole ? list.map(({ frame, ...source }) => source) : list;
  }
  return assigned;
}

/** Assigns each provided source to a compatible slot of the workflow, or explains why it cannot. */
function assign(workflow, provided, name) {
  const used = new Set(),
    references = [];
  for (const [role, list] of Object.entries(provided))
    for (const source of list) {
      const slot = slotsFor(workflow, role, name).find(
        slot => !used.has(slot.id) && slotMedia(workflow, slot) === source.media,
      );
      if (!slot) return { error: `no free ${source.media} slot for ${role}` };
      used.add(slot.id);
      references.push(referenceOf(slot, source));
    }
  const missing = workflow.references.find(slot => slot.required && !used.has(slot.id));
  // (0.6.94) In the user's words, who reads it on the refusal too (« Appel d’outil refusé : … »).
  if (missing)
    return {
      error: `« ${missing.name || missing.id} » est obligatoire dans ce workflow`,
      missing: missing.name || missing.id,
    };
  return { references, unused: workflow.references.length - used.size };
}

/**
 * The LoRAs a workflow brings itself (Settings, Workflows), as the Studio shows them: always on
 * (« Activé »), or left to whoever asks (« Assistant », on by default or not), with a fixed
 * strength or a range to choose in. Those switched off are not offered, nor the one of the subject
 * references, on by itself with them (referenceLora). `names`: the file of each asset id.
 */
function workflowLoras(workflow, manifest, names) {
  const spec = manifest.loras?.strength ?? { type: 'number' },
    bound = referenceLora(workflow);
  return (workflow.loras ?? [])
    .filter(lora => lora !== bound)
    .filter(lora => lora.enabled.policy === 'model' || (lora.enabled.policy === 'fixed' && lora.enabled.value))
    .map(lora => {
      // (0.6.94) As it is made: a switch or a strength saved without a default has its stand-in.
      const made = madeLora(lora, workflow.pipeline),
        free = lora.strength.policy === 'model',
        range = free ? effective(lora.strength, spec) : null;
      return {
        id: lora.id,
        name: loraName(lora, names),
        description: lora.description ?? '',
        assistant: lora.enabled.policy === 'model',
        on: lora.enabled.policy === 'model' ? made.enabled.default === true : true,
        strength: free
          ? {
              min: range.min,
              max: range.max,
              ...(Object.hasOwn(made.strength, 'default') ? { default: made.strength.default } : {}),
            }
          : { value: lora.strength.value },
      };
    });
}
/** A LoRA of a workflow by what the user knows of it: its file, else what it is said to bring. */
const loraName = (lora, names) =>
  (names.get(lora.asset) ?? '').replace(/\.safetensors$/i, '') || lora.description || lora.id;

// (0.6.102) A setting as the user knows it, by its name in Paramètres › Modèles; a number as it is
// written to the user (« 0,6 »).
const nameOf = key => SETTING_NAMES[key] ?? key;
const shown = value => String(value).replace('.', ',');
// (0.6.461) A video asked this many seconds longer than its workflow makes at once is a film, not a clip: its
// card says where a film is made.
const FILM_BEYOND = 2;
const FILM_NOTE = 'Un film plus long, ou en plusieurs plans, se monte dans la Bobine : un plan par prise.';
/** (0.6.461) The longest clip a workflow makes at once, in seconds; null when it does not say. */
function longestOf(workflow) {
  const counts = frameCounts(workflow);
  return counts.length ? Math.max(...counts) / fpsOf(workflow) : null;
}
// (0.6.102) What the Studio sets with its own controls (the prompt, the bars of size and length,
// the seed) or what has a section of its own in the editor (the enhancement of the prompt): no line
// of « Plus de réglages ».
const STUDIO_OWN = new Set(['prompt', 'width', 'height', 'frames', 'stage', 'seed', 'expandPrompt']);
// The settings of the subject references of LTX 2.5, read with one of them only (public/video-plan.mjs).
const SUBJECT_SETTINGS = /^msr_/;
/** The versions a workflow is made at, which its profiles apply to (as the editor says: inertSetting). */
function stagesOf(workflow, manifest) {
  const stage = workflow.parameters?.stage;
  if (!stage || !workflow.profiles) return [];
  if (stage.policy === 'fixed') return [stage.value];
  return stage.choices ?? manifest.parameters?.stage?.choices ?? Object.keys(workflow.profiles);
}
/** The input a setting is read with only, as the Studio greys it: its family's, or a subject reference. */
function settingInput(workflow, key, spec) {
  if (spec.onlyWith) return { ...spec.onlyWith };
  if (SUBJECT_SETTINGS.test(key) && (workflow.references ?? []).some(slot => slot.role === 'msr_image'))
    return { role: 'msr_image' };
  return null;
}
/**
 * (0.6.102) Whether a setting is one of the Studio's for a verb: left to Moodix AI, or fixed by the
 * workflow, which holds Moodix AI and leaves the user free to change it for a creation; unless it
 * changes nothing whatever it holds (read by no engine, one value only, replaced by the profile of
 * every version, read only with an input this verb never takes: the overlap of a continuation in a
 * new video).
 */
/**
 * (0.6.222) The camera a model reads itself (family wan22_camera): its settings `camera` (a closed list of
 * movements, « none » for no camera) and `camera_speed`, which the piece « Caméra » of the Studio sets in
 * place of two ordinary lines. `{ moves, speed }` for a new video; null for a model that has none (the
 * camera is then a sentence of its prompt, or nothing).
 */
function cameraSettings(manifest, parameters, verb) {
  const spec = manifest.parameters.camera,
    policy = parameters.camera,
    set = key => Boolean(manifest.parameters[key]) && ['fixed', 'model'].includes(parameters[key]?.policy);
  if (verb !== 'create_video' || !Array.isArray(spec?.choices) || !set('camera')) return null;
  const moves = (effective(policy, spec).choices ?? spec.choices).filter(move => move !== 'none');
  return moves.length ? { moves, speed: set('camera_speed') } : null;
}
/**
 * (0.6.256) What the page Agrandir or Interpoler of the Studio offers of a model: the factors it may take, by the
 * setting that holds them (`key`: SeedVR2 `scale`, × 2 and × 4; RIFE `multiplier`), the one it starts from
 * (`standard`); or the factor it has without a setting (Real-ESRGAN: its name says it, « ×4 »), null when nothing
 * says it (the size is then the model's). `maxSide`: the largest side it makes, when it is held.
 * (0.6.450) `maxPixels`: the most pixels the card of this computer makes with it, when the engine says it (SeedVR2,
 * runner/pipelines/seedvr2.py, `reach`): the page greys the factors that give more, with why.
 */
function finishOf(workflow, manifest, capability = null) {
  const p = workflow.parameters,
    value = key => p[key]?.value ?? p[key]?.default,
    largest = Number(value('max_side')),
    // (0.6.261) The size the page says is the one the engine makes. SeedVR2 holds its output to the largest side of
    // its family even at 0 (« 8192 au plus », runner/pipelines/seedvr2.py: 10240 × 5760 said, 8192 × 4608 made).
    ceiling = workflow.pipeline === 'seedvr2' ? Number(manifest.parameters.max_side?.max) || 0 : 0,
    held = largest > 0 && ceiling ? Math.min(largest, ceiling) : largest > 0 ? largest : ceiling,
    // Real-ESRGAN brings a side it reduces back to an even one (runner/pipelines/realesrgan.py: 1608, not 1607).
    maxSide = {
      ...(held > 0 ? { maxSide: held } : {}),
      ...(/^realesrgan_/.test(workflow.pipeline ?? '') ? { even: true } : {}),
      ...(Number.isFinite(capability?.maxPixels) && capability.maxPixels >= 0 ? { maxPixels: capability.maxPixels } : {}),
    };
  for (const key of ['scale', 'multiplier']) {
    if (!p[key] || !manifest.parameters[key]) continue;
    const spec = effective(p[key], manifest.parameters[key]),
      choices =
        p[key].policy === 'model'
          ? (spec.choices ?? [2, 4].filter(factor => factor >= (spec.min ?? 1) && factor <= (spec.max ?? 4)))
          : [value(key)];
    const standard = choices.includes(value(key)) ? value(key) : choices[0];
    return { key, choices: choices.filter(Number.isFinite), standard, ...maxSide };
  }
  const said = /×\s*(\d+)/.exec(workflow.name ?? '') ?? /×\s*(\d+)/.exec(manifest.model?.version ?? '');
  return { factor: said ? Number(said[1]) : null, ...maxSide };
}
function studioSetting(workflow, manifest, key, policy, verb) {
  if (STUDIO_OWN.has(key) || !['model', 'fixed'].includes(policy?.policy)) return false;
  const spec = manifest.parameters[key];
  if (!spec || spec.unused) return false;
  const only = settingInput(workflow, key, spec);
  if (only) {
    const taken = new Set(
      Object.keys(TASKS[verb].roles).flatMap(role => slotsFor(workflow, role, verb).map(slot => slot.role)),
    );
    if (!(only.roles ?? [only.role]).some(role => taken.has(role))) return false;
  }
  if (policy.policy === 'model') return true;
  if (effective(policy, spec).choices?.length === 1) return false;
  const stages = stagesOf(workflow, manifest);
  return !(stages.length && stages.every(stage => Object.hasOwn(workflow.profiles?.[stage]?.parameters ?? {}, key)));
}

function accepted(workflow, name) {
  const roles = Object.keys(TASKS[name].roles).filter(role => !TASKS[name].roles[role].hand && slotsFor(workflow, role, name).length);
  return roles.length ? roles.join(', ') : 'prompt only';
}

/**
 * The workflows of a verb (`serving`) a model can pass by their name: a capable model is shown
 * names (« LTX 2.5 ») rather than identifiers, when no other workflow of the verb has the same one.
 */
const byName = serving => workflow =>
  serving.filter(other => other.name === workflow.name).length === 1 ? workflow.name : workflow.id;

export class ToolCatalog {
  /**
   * `workflows`: the catalog of the workflows. `timing`: what the creations took on this computer
   * (ProgressHistory of lib/generation-progress.mjs), which the Studio says before a creation (0.6.249).
   */
  constructor(workflows, { timing = null } = {}) {
    this.workflows = workflows;
    this.timing = timing;
  }

  /** Media each output button can act on now: { upscale: ['image', 'video'], interpolate: [...], ... }. */
  async actions() {
    // (0.6.94) The buttons of a take are the user's hand: a workflow not offered to Moodix AI serves them too.
    const result = {},
      ready = await this.#runnable();
    // (0.6.242) « Changer la caméra » of a clip (refilm_video): a button of the user's hand, which opens the Studio.
    for (const name of ['upscale', 'interpolate', 'extend_video', 'refilm_video']) {
      const media = new Set();
      for (const workflow of await this.#serving(name, ready))
        for (const slot of slotsFor(workflow, 'source')) media.add(slotMedia(workflow, slot));
      result[name] = [...media];
    }
    // « Animer » a take: a clip that starts from the image (create_video and its first image).
    result.animate = [];
    for (const workflow of await this.#serving('create_video', ready))
      if (slotsFor(workflow, 'start_image', 'create_video').some(slot => slotMedia(workflow, slot) === 'image')) {
        result.animate = ['image'];
        break;
      }
    return result;
  }

  /**
   * What the Studio shows for each creation verb: the ready workflows, and for each the inputs
   * it takes (how many per role), its sizes, its lengths in seconds and its own settings. After
   * them, those this computer cannot run whatever the files chosen (`unavailable`, the reason:
   * no NVIDIA card for a model that computes on one): shown greyed, never left out unexplained.
   */
  async studio() {
    // (0.6.94) Those not offered to Moodix AI too (« Proposé à Moodix AI » off): the
    // Studio is the user's own hand.
    const result = {},
      all = await this.workflows.list(),
      ready = all.filter(workflow => workflow.ready),
      lacking = all.filter(workflow => !workflow.ready && workflow.unavailableKind === 'hardware'),
      // (0.6.242) A shipped model without its files, which the Studio shows greyed (« Changer la caméra »): from
      // the same listing (each one checks the files of every workflow).
      fetchable = all.filter(workflow => !workflow.ready && workflow.builtin && workflow.unavailableKind === 'files'),
      names = await this.#loraFiles(ready),
      // (0.6.102) When the user last changed each part of each workflow: the Studio shows the newer
      // of such a change and the value of the last take of a conversation (« le plus récent des deux »).
      changes = (await this.workflows.changes?.().catch(() => ({}))) ?? {};
    for (const name of ['create_image', 'create_video', 'extend_video', 'replace_character', 'create_audio', 'refilm_video', 'upscale', 'interpolate']) {
      // (0.6.256) Agrandir and Interpoler: a take made larger or smoother, on its own page of the Studio. What
      // they offer is their factor (`finish`), never the settings of their model (those stay in its page).
      const finish = name === 'upscale' || name === 'interpolate';
      const task = TASKS[name],
        // A video made from another one the user hands over (a character replaced in it) has
        // that video's length and shape: no size is offered. (A continuation is told apart
        // by the page, which knows the clip it continues; a take made larger or smoother too.)
        follows = name !== 'extend_video' && !finish && Boolean(task.roles.source?.required),
        // (0.6.242) A clip filmed again from another camera (refilm_video): its length and its format are the
        // clip's, its camera is placed with the bounds of its family (`refilm`), and the settings of its model
        // stay in the page of the model. Shown without its files too, greyed with the reason (its download is
        // offered in Paramètres › Modèles): the Studio names what it lacks, never leaves the tool out.
        refilm = name === 'refilm_video';
      // The family the router prefers comes first: it is the one selected when the page opens.
      const preferred = (a, b) => (family(b.pipeline).preference ?? 0) - (family(a.pipeline).preference ?? 0);
      const serving = [
        ...(await this.#serving(name, ready)).sort(preferred),
        ...(await this.#serving(name, lacking)).sort(preferred),
        ...(refilm ? (await this.#serving(name, fetchable)).sort(preferred) : []),
      ];
      // (0.6.249) What each model filming a clip again took on this computer, one line per size and length made
      // here (ProgressHistory.made): the Studio says from it how long a size would take, and warns beyond the
      // `patience` of its family. The time depends on the computer: never one measured elsewhere.
      const made = new Map();
      if (refilm)
        for (const workflow of serving)
          made.set(workflow.id, (await this.timing?.made?.(workflow.id).catch(() => null)) ?? []);
      result[name] = serving.map(workflow => {
        const manifest = family(workflow.pipeline),
          p = workflow.parameters,
          // (0.6.222) A model that reads the camera itself: what its piece of the Studio may set.
          ownCamera = cameraSettings(manifest, p, name),
          // (0.6.102) The bounds of the workflow, « Fixe » as « Assistant »: the user's own.
          limit = key => {
            const spec = manifest.parameters[key];
            if (!spec || !p[key]) return null;
            const own = effective(p[key], spec);
            return { min: own.min, max: own.max, multipleOf: spec.multipleOf };
          },
          value = key => p[key]?.value ?? p[key]?.default,
          profile = stage => workflow.profiles?.[stage]?.parameters,
          size = from => (from?.width && from?.height ? { width: from.width, height: from.height } : null),
          // The version a workflow fixes (« Vidéo finale ») is the size the Studio starts from: from the
          // draft's, it made a final at 288 × 512 (0.6.102).
          start = p.stage?.policy === 'fixed' ? p.stage.value : 'draft';
        const lengths = refilm ? null : lengthsOf(workflow, name);
        return {
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          media: workflow.mediaType,
          verb: name,
          ...(follows ? { follows: true } : {}),
          // (0.6.211) It takes the camera of the Studio (public/camera.mjs): a sentence the application
          // adds to its prompt, so only where the prompt is the user's to write.
          // (0.6.222) Or it reads the camera itself: its movements, and whether it has a speed.
          ...(ownCamera ? { camera: ownCamera } : takesCamera(workflow.pipeline, name) && p.prompt?.policy === 'model' ? { camera: true } : {}),
          ...(workflow.ready ? {} : { unavailable: workflow.unavailableReason }),
          // The family of the model: a LoRA made for one is of no use to another.
          family: workflow.pipeline,
          for: manifest.chooseFor ?? '',
          // It takes the style LoRAs of the Studio (the families whose manifest says so); the
          // size is an argument or a user edit; the workflow has draft and final profiles; its
          // seed is drawn unless given.
          styled: manifest.styles === true,
          direct: p.width?.policy === 'model' && p.height?.policy === 'model',
          // (0.6.102) Whether Moodix AI chooses the size (its own) or the format (a video's): the
          // pointer sets only what it chose, never a size the workflow fixes.
          assistantSize: (p.width?.policy === 'model' && p.height?.policy === 'model') || workflow.mediaType === 'video',
          stages: p.stage?.policy === 'model',
          seeded: drawsSeed(workflow),
          // (0.6.102) A seed « Fixe »: the Studio makes it unless the user names another one.
          ...(p.seed?.policy === 'fixed' ? { seedFixed: p.seed.value } : {}),
          ...(changes[workflow.id] ? { changed: structuredClone(changes[workflow.id]) } : {}),
          roles: Object.fromEntries(
            Object.keys(task.roles).map(role => [
              role,
              {
                count: slotsFor(workflow, role, name).length,
                media: [...new Set(slotsFor(workflow, role, name).map(slot => slotMedia(workflow, slot)))],
                many: Boolean(task.roles[role].many),
                // What the verb or this workflow cannot do without (its character, for a
                // replacement made by hand: the Studio does not make it from words).
                ...(task.roles[role].required || slotsFor(workflow, role, name).some(slot => slot.required)
                  ? { required: true }
                  : {}),
              },
            ]),
          ),
          // The role of this verb each input of the workflow takes, by its name in a take's record
          // (« reference_image » → « reference »): the Studio puts the inputs of a take back in their cases.
          inputs: Object.fromEntries(
            Object.keys(task.roles).flatMap(role => slotsFor(workflow, role, name).map(slot => [slot.role, role])),
          ),
          ...(manifest.exclusive ? { exclusive: manifest.exclusive } : {}),
          ...(workflow.mediaType !== 'audio' && p.width && p.height && !follows
            ? {
                limits: { width: limit('width'), height: limit('height') },
                // A draft size first when the workflow has one: quick by default.
                size: size(profile(start)) ?? size({ width: value('width'), height: value('height') }),
                final: start === 'draft' && p.stage?.policy === 'fixed' ? null : size(profile('final')),
              }
            : {}),
          ...(lengths ? { lengths } : {}),
          // (0.6.242) What the camera of a clip filmed again may be (public/camera-orbit.mjs, orbitBounds), and
          // (0.6.249) what this computer took for it (`made`).
          ...(refilm && manifest.refilm
            ? { refilm: { ...structuredClone(manifest.refilm), made: made.get(workflow.id) ?? [] } }
            : {}),
          ...(finish ? { finish: finishOf(workflow, manifest, this.workflows.capabilities?.[workflow.pipeline]) } : {}),
          // Its own LoRAs, chosen in its settings: shown in the Studio, those left to the
          // assistant switched and set there too.
          loras: workflowLoras(workflow, manifest, names),
          // The workflow's own settings: lyrics, seconds, language… (0.6.102) Those it fixes too,
          // at their value: « Fixe » holds Moodix AI, the user may change it for a creation (`fixed`,
          // which is no mark on the page: the Studio sends it as the user's own change, and the
          // pointer of Moodix AI does not set it as its choice).
          settings: Object.entries(p)
            // (0.6.222) Not the two settings of its camera: its piece sets them.
            .filter(
              ([key, policy]) =>
                !refilm &&
                !finish &&
                !(ownCamera && (key === 'camera' || key === 'camera_speed')) &&
                studioSetting(workflow, manifest, key, policy, name),
            )
            .map(([key, policy]) => {
              // (0.6.94) With what is made when nothing is set (madePolicy): its default, or the
              // value that stands in for one the workflow was saved without.
              const spec = effective(policy, manifest.parameters[key]),
                made = policy.policy === 'fixed' ? { default: policy.value } : madePolicy(workflow, key),
                onlyWith = settingInput(workflow, key, spec);
              return {
                key,
                type: spec.type,
                ...(spec.min !== undefined ? { min: spec.min } : {}),
                ...(spec.max !== undefined ? { max: spec.max } : {}),
                ...(spec.choices ? { choices: spec.choices } : {}),
                ...(spec.maxLength ? { maxLength: spec.maxLength } : {}),
                ...(spec.multipleOf ? { multipleOf: spec.multipleOf } : {}),
                ...(Object.hasOwn(made, 'default') ? { default: made.default } : {}),
                ...(policy.policy === 'fixed' ? { fixed: true } : {}),
                // Read by the engine only with an input (the denoise of Krea 2 with an image to
                // modify, `role` as in `inputs` above): the Studio greys it while that case is empty.
                ...(onlyWith ? { onlyWith } : {}),
              };
            }),
        };
      });
    }
    return result;
  }

  /**
   * (0.6.461, Bobine Pro, B04) The models a take of the Bobine may be made with: one by family of models that make
   * videos (LTX 2.5, MiniMax H3, pi H3, Wan 2.2), not those that read a camera of their own, which the Bobine does not
   * set. Its name, whether it makes sound, and for a new take (`create_video`) and a suite (`extend_video`) the
   * workflow it is asked to, what it takes (how many of each role) and the longest it makes; null when it does not.
   * That workflow: the first one ready here, else one this computer cannot run (`unavailable`, the reason), else a
   * shipped one that lacks only files Moodix downloads (`missing`: the Bobine offers them), else any other, said
   * `unavailable` with its reason (its engine is not there): greyed in the Bobine, never left out. In the order the
   * router prefers them, then by family.
   * (0.6.476) `all`: the list when it was read already. `chat`: for the card of a proposal of Moodix AI, whose
   * workflows are those offered to it first; one ready that is not is said `offered: false`.
   */
  async videoModels(all, { chat = false } = {}) {
    all ??= await this.workflows.list();
    const fetchable = all.filter(
        workflow => !workflow.ready && workflow.builtin && workflow.unavailableKind === 'files',
      ),
      lists = [
        ...(chat ? [all.filter(workflow => workflow.ready && workflow.enabled !== false)] : []),
        all.filter(workflow => workflow.ready),
        all.filter(workflow => !workflow.ready && workflow.unavailableKind === 'hardware'),
        fetchable,
        all.filter(workflow => !workflow.ready),
      ],
      entry = (workflow, name) => ({
        id: workflow.id,
        name: workflow.name,
        roles: Object.fromEntries(
          Object.keys(TASKS[name].roles).map(role => {
            const slots = slotsFor(workflow, role, name),
              // (0.6.462, Bobine Pro, B05) A subject of LTX 2.5 needs its LoRA (`requiresLora`, referenceLora): a workflow
              // without one takes none, which the Bobine says.
              needs = slots.some(slot => family(workflow.pipeline).roles[slot.role]?.requiresLora);
            return [
              role,
              {
                count: slots.length,
                ...(TASKS[name].roles[role].required || slots.some(slot => slot.required) ? { required: true } : {}),
                ...(needs && !referenceLora(workflow) ? { lora: false } : {}),
              },
            ];
          }),
        ),
        // The longest it makes at once (seconds; what it adds, for a suite), or null when it fixes its length itself.
        longest: Math.max(0, ...(lengthsOf(workflow, name)?.seconds ?? [])) || null,
        // (0.6.464) And the shortest, as the server makes it of a take shorter (framesFor: the fewest frames it allows),
        // or null: MiniMax H3 makes 5,17 s of a take of 2 s, which the card of the Bobine says before it is asked.
        shortest: lengthsOf(workflow, name)?.seconds.length ? framesFor(workflow, 0, { continuation: name === 'extend_video' }).seconds : null,
        ...(workflow.ready
          ? chat && workflow.enabled === false
            ? { offered: false }
            : {}
          : fetchable.includes(workflow)
            ? { missing: true }
            : { unavailable: workflow.unavailableReason || 'il ne se fait pas sur cet ordinateur.' }),
      }),
      chosen = (pipeline, name) => {
        for (const list of lists) {
          const workflow = list.find(item => item.pipeline === pipeline && serves(item, name));
          if (workflow) return entry(workflow, name);
        }
        return null;
      },
      pipelines = [...new Set(all.map(workflow => workflow.pipeline))].filter(pipeline => {
        const manifest = family(pipeline);
        return manifest?.mediaType === 'video' && !manifest.parameters?.camera && manifest.tasks?.includes('create_video');
      });
    return pipelines
      .map(pipeline => {
        const manifest = family(pipeline);
        return {
          family: pipeline,
          name: manifest.model?.name || pipeline,
          sound: Boolean(manifest.parameters.audio),
          preference: manifest.preference ?? 0,
          create_video: chosen(pipeline, 'create_video'),
          extend_video: chosen(pipeline, 'extend_video'),
        };
      })
      .filter(model => model.create_video)
      .sort((a, b) => b.preference - a.preference || a.family.localeCompare(b.family))
      .map(({ preference: _preference, ...model }) => model);
  }

  /**
   * (0.6.476) The models the card of a video proposal of Moodix AI is made with, in the list of glass of its title
   * (public/proposal-card.mjs), as the Bobine lists them (videoModels): for `name` (create_video, extend_video), the
   * workflow each is asked to (`workflowId`, its `name`), whether its files are to download (`missing`), why it cannot
   * be chosen (`off`: it makes no suite, this computer cannot run it, it is not offered to Moodix AI, it needs an input
   * the card has not), and whether it takes every input of the card (`all`; `inputs`: their media by role of the verb,
   * those greyed included). Null for another verb.
   */
  async choices(name, inputs = {}) {
    if (name !== 'create_video' && name !== 'extend_video') return null;
    const all = await this.workflows.list(),
      listed = await this.videoModels(all, { chat: true }),
      suites = orList(
        listed
          .filter(model => model.extend_video && !model.extend_video.unavailable)
          .map(model => model.extend_video.name),
      );
    return listed.map(model => {
      const entry = model[name],
        label = entry?.name ?? model.create_video.name,
        workflow = entry ? all.find(item => item.id === entry.id) : null,
        fit = workflow ? fitInputs(workflow, inputs, name) : null,
        needed = fit?.missing ? workflow.references.find(slot => (slot.name || slot.id) === fit.missing) : null,
        off = !entry
          ? `${label} ne prolonge pas une vidéo.${suites ? ' Pour une suite : ' + suites + '.' : ''}`
          : entry.unavailable
            ? `${label} : ${entry.unavailable}`
            : entry.offered === false
              ? `${label} n’est pas proposé à Moodix AI : activez « Proposé à Moodix AI » dans ses réglages ` +
                '(Paramètres › Modèles).'
              : needed
                ? family(workflow.pipeline).roles[needed.role]?.as === 'start_image'
                  ? `${label} part d’une image de début : ajoutez-en une à la carte, puis choisissez-le.`
                  : `${label} ne se fait pas sans « ${fit.missing} » : ajoutez-la à la carte, puis choisissez-le.`
                : '';
      return {
        family: model.family,
        name: label,
        sound: model.sound,
        create_video: model.create_video,
        extend_video: model.extend_video,
        workflowId: entry?.id ?? null,
        ...(entry?.missing ? { missing: true } : {}),
        ...(off ? { off } : {}),
        all: Boolean(fit && !fit.missing && !fit.left.length),
      };
    });
  }

  /** The file of each LoRA asset the workflows use, read once from the registry (its name, or ''). */
  async #loraFiles(workflows) {
    const used = new Set(workflows.flatMap(workflow => (workflow.loras ?? []).map(lora => lora.asset)).filter(Boolean)),
      names = new Map();
    if (!used.size) return names;
    try {
      for (const asset of (await this.workflows.assets?.list?.()) ?? [])
        if (used.has(asset.id)) names.set(asset.id, asset.name || (asset.path ? basename(asset.path) : ''));
    } catch {
      // The registry is unreadable: the LoRAs are named by their description.
    }
    return names;
  }

  isGenerationTool(name) {
    return Object.hasOwn(TASKS, name);
  }

  /**
   * The ready workflows Moodix AI is offered. Listing them checks the files of every workflow (most
   * of a second with models on a hard disk): an answer about several verbs reads the list once and
   * passes it on. (0.6.94) « Proposé à Moodix AI » (`enabled`) off leaves one out here
   * only: the Studio and the buttons of a take still have it (#runnable).
   */
  async #ready() {
    return (await this.workflows.list()).filter(workflow => workflow.ready && workflow.enabled !== false);
  }
  /** The workflows that can be made here, offered to Moodix AI or not: those of the user's own hand. */
  async #runnable() {
    return (await this.workflows.list()).filter(workflow => workflow.ready);
  }
  /**
   * Shipped workflows that lack only a file Moodix can download (etats-maquette.md, 53): a verb
   * none of the ready ones makes still reaches them, and the file is offered in the chat.
   */
  /** The workflow of `name` that only lacks a file to download, when no ready one makes it (53). */
  async lacking(name) {
    if ((await this.#serving(name)).length) return null;
    return (await this.#fetchable(name))[0] ?? null;
  }
  async #fetchable(name, all) {
    // (`all`: the list when it was read already, 0.6.460: an answer reads it once.)
    return (all ?? (await this.workflows.list())).filter(
      workflow => !workflow.ready && workflow.builtin && workflow.unavailableKind === 'files' && serves(workflow, name),
    );
  }
  async #serving(name, ready) {
    return (ready ?? (await this.#ready())).filter(workflow => serves(workflow, name));
  }
  /**
   * (0.6.460) The ready workflows of a verb, with the shipped ones that lack only a file to download when each
   * workflow of the verb is the one for something (`chooseFor`: music, sound effects) and nothing ready is for
   * what they make. The model then names the one that makes what is asked, and its file is offered in the chat
   * (53), as when no workflow of the verb is ready. Asked for « une musique douce au piano » with the music
   * model not downloaded, the chat proposed the sound-effect model, the only one it was told of (27/11).
   * Not beside a workflow that makes anything (Krea 2 beside MOSS Image): that one answers.
   */
  async #offeredFor(name, serving, all) {
    if (!serving.length || !serving.every(workflow => family(workflow.pipeline).chooseFor)) return serving;
    const made = new Set(serving.map(workflow => workflow.pipeline));
    const wanting = (await this.#fetchable(name, all)).filter(
      workflow => family(workflow.pipeline).chooseFor && !made.has(workflow.pipeline),
    );
    return [...serving, ...wanting];
  }

  /**
   * The clip lengths, in seconds, of the workflows that can perform this verb and let the model
   * choose. For a continuation, what it adds: it renders the end of its source again (the
   * overlap), so each frame count gives that much less new footage, and with no length asked it
   * adds about a standard clip (route). Told the lengths of a new clip, the model proposed
   * 14.4 s where MiniMax adds 13.5 s at most.
   */
  async lengths(name) {
    if (!TASKS[name]) return [];
    const continuation = name === 'extend_video';
    return (await this.#serving(name)).filter(timed).flatMap(workflow => {
      const manifest = family(workflow.pipeline).parameters.frames ?? {},
        spec = effective(workflow.parameters.frames, manifest),
        fps = fpsOf(workflow),
        overlap = continuation ? overlapOf(workflow) : 0,
        range = continuation
          ? frameCounts(workflow).filter(count => count > overlap)
          : (spec.choices ?? [spec.min, spec.max]).filter(Number.isFinite),
        standard = workflow.parameters.frames.default ?? manifest.default;
      if (!range.length || !Number.isFinite(standard)) return [];
      return [
        {
          name: workflow.name,
          min: (Math.min(...range) - overlap) / fps,
          max: (Math.max(...range) - overlap) / fps,
          standard: continuation ? framesFor(workflow, standard / fps, { continuation }).seconds : standard / fps,
        },
      ];
    });
  }

  /**
   * What one more image would find in a proposal: `references` are its inputs, each with the slot
   * (`input`) it fills in `workflow`. `here`: the roles of the verb in which that workflow would
   * still take an image beside them; `none`: it takes no image at all for this verb; `other`: when
   * it has no place left, the name of another ready workflow of the verb that would take these
   * inputs and the image.
   */
  async room(name, workflow, references = []) {
    const task = TASKS[name];
    if (!task) return { here: [], none: true, other: null };
    // The inputs as the router was given them: by role of the verb, each with its media.
    const roles = family(workflow.pipeline).roles ?? {},
      provided = {};
    for (const reference of references) {
      const slot = workflow.references.find(item => item.id === reference.input),
        role = roles[slot?.role];
      if (role?.as) (provided[role.as] ??= []).push({ media: role.media });
    }
    const pictured = Object.entries(task.roles).filter(([, spec]) => spec.media.includes('image') && !spec.hand);
    const takes = candidate =>
      pictured
        .filter(([role, spec]) => spec.many || !provided[role]?.length)
        .filter(([role]) => {
          const more = { ...provided, [role]: [...(provided[role] ?? []), { media: 'image' }] },
            apart = (family(candidate.pipeline).exclusive || []).filter(group =>
              group.some(item => more[item]?.length),
            );
          return apart.length < 2 && !assign(candidate, more, name).error;
        })
        .map(([role]) => role);
    const here = takes(workflow);
    return {
      here,
      none: !pictured.some(([role]) =>
        slotsFor(workflow, role, name).some(slot => slotMedia(workflow, slot) === 'image'),
      ),
      other: here.length
        ? null
        : ((await this.#serving(name)).find(item => item.id !== workflow.id && takes(item).length)?.name ?? null),
    };
  }

  /**
   * One tool per verb that at least one ready workflow can perform.
   * `available` ({ images, resources: [{ id, type }], outputs: [{ id, mediaType, count, workflowId, draft }] })
   * describes what the current conversation can reference. When given, source roles only offer
   * those sources, with their IDs enumerated, and a verb whose required source has nothing to
   * point to is not offered at all: a model must never be asked for an ID that does not exist.
   * `wording` (lib/model-wording.mjs): the words of the small local model (« rails », as they always
   * were) or those of a capable one; the same tools, the same arguments either way.
   */
  async definitions(available, { wording = RAILS } = {}) {
    const context = availability(available);
    // (0.6.460) The whole list, read once: the ready ones, and what only lacks a file (#fetchable, #offeredFor).
    const tools = [],
      all = await this.workflows.list(),
      ready = all.filter(workflow => workflow.ready && workflow.enabled !== false);
    for (const name of Object.keys(TASKS)) {
      // (0.6.242) A verb of the user's own hand only (`hand`: « Changer la caméra »): never a tool of Moodix AI,
      // not even to offer its files.
      if (TASKS[name].hand) continue;
      let serving = await this.#serving(name, ready);
      if (!serving.length) serving = await this.#fetchable(name, all);
      // (0.6.460) With what only lacks a file, when it is the one for something nothing ready makes (#offeredFor).
      else serving = await this.#offeredFor(name, serving, all);
      const definition = serving.length ? this.#definition(name, serving, context, wording === CAPABLE) : null;
      if (definition) tools.push(definition);
    }
    return tools;
  }

  #definition(name, serving, available, capable = false) {
    const task = capable ? capableTask(name) : TASKS[name],
      properties = {},
      required = [],
      offered = new Set(),
      // How the model names a workflow: its id, or for a capable model its name when it is the only one.
      named = capable ? byName(serving) : workflow => workflow.id;
    const video = serving.some(workflow => workflow.mediaType === 'video');
    if (task.prompt && serving.some(workflow => workflow.parameters.prompt?.policy === 'model')) {
      properties.prompt = { type: 'string', minLength: 1, maxLength: 8000, description: task.prompt };
      // (0.6.282) A family that reads its prompt its own way says how (Qwen-Image-Edit: an instruction that edits
      // the images given, not the whole picture): for its workflows, or alone when they are the only ones.
      const takers = serving.filter(workflow => workflow.parameters.prompt?.policy === 'model'),
        own = new Map();
      for (const workflow of takers) {
        const guide = familyPrompt(workflow.pipeline, name);
        if (guide) own.set(guide, [...(own.get(guide) ?? []), named(workflow)]);
      }
      if (own.size === 1 && [...own.values()][0].length === takers.length)
        properties.prompt.description = [...own.keys()][0];
      else if (own.size)
        properties.prompt.description = [
          task.prompt,
          ...[...own].map(([guide, ids]) => `For ${ids.join(', ')}: ${guide}`),
        ].join(' ');
      if (
        serving.every(
          workflow =>
            workflow.parameters.prompt?.policy === 'model' && !Object.hasOwn(workflow.parameters.prompt, 'default'),
        )
      )
        required.push('prompt');
    }
    for (const [role, spec] of Object.entries(task.roles)) {
      // (0.6.152) A role of the user's own hand only (the end image of a continuation): never offered to the chat model.
      if (spec.hand) continue;
      const capacity = Math.max(0, ...serving.map(workflow => slotsFor(workflow, role, name).length));
      if (!capacity) continue;
      const schema = capable
        ? spec.media.includes('image')
          ? capableSourceSchema
          : capableWholeSchema
        : available
          ? availableSourceSchema(spec.media, available)
          : spec.media.includes('image')
            ? sourceSchema
            : wholeSourceSchema;
      if (!schema) {
        // Nothing in this conversation can fill a required role: the verb cannot run yet.
        if (spec.required) return null;
        continue;
      }
      for (const variant of schema.anyOf || [schema])
        for (const key of ['image', 'resource', 'output', 'take', 'ref']) if (variant.properties[key]) offered.add(key);
      properties[role] = spec.many
        ? { type: 'array', items: schema, maxItems: capacity, description: spec.description }
        : { ...schema, description: spec.description };
      if (spec.required) required.push(role);
    }
    if (serving.length > 1) {
      // The model leaves the choice to the application, except for a workflow whose family says
      // what it is the one for (MOSS Image: posters and text in the picture). Asked to choose by
      // the descriptions alone, it named a video workflow that could not take the images passed.
      const special = serving
        .filter(workflow => family(workflow.pipeline).chooseFor)
        .map(workflow => ` Pass ${named(workflow)} for ${family(workflow.pipeline).chooseFor}.`);
      // Workflows that are each the one for something (music, sound effects): only the model
      // knows which the user wants, so it always says.
      const choose = chosen(serving);
      properties.workflow = {
        type: 'string',
        enum: serving.map(named),
        description:
          (choose
            ? 'The workflow that makes what the user asked for.'
            : capable
              ? 'Only when the user names one of the workflows listed above. Omit it otherwise: the application picks the one that takes what you pass.'
              : 'Optional: force one of the workflows listed above, when the user names it. Omit it to let the application pick the best match.') +
          special.join(''),
      };
      if (choose) required.push('workflow');
    }
    const durations = serving.filter(timed);
    if (task.output === 'video' && durations.length) {
      // Always asked for, so a length the user gave ("3 secondes") is not left in the prompt:
      // the model states it, or null for the workflow's own default.
      const always = durations.length === serving.length;
      const lengths = durations.map(longestOf).filter(Number.isFinite),
        longest = lengths.length ? Math.round(Math.max(...lengths) * 100) / 100 : 0;
      properties.duration = {
        type: always ? ['number', 'null'] : 'number',
        minimum: 0.5,
        maximum: 120,
        description: capable
          ? (name === 'extend_video'
              ? 'Seconds of new footage to add after the source video, when the user gave a length'
              : 'Clip length in seconds, when the user gave one') +
            (always
              ? '; null when they gave none, and the application uses the usual length of the workflow.'
              : ` (only for: ${durations.map(named).join(', ')}).`) +
            ' Rounded to the closest length the workflow allows.' +
            // (0.6.461) How long one clip can be, and where a film goes: asked for « un film de 30 secondes en
            // trois plans », the model promised three shots of ten seconds and one clip of 14 s was proposed.
            (name === 'create_video' && longest
              ? ` One clip is ${longest} seconds at most here. A longer film, or several shots with cuts ` +
                'between them, does not fit in one clip: propose its first shot only, and tell the user that a film ' +
                'of several shots is put together in the Bobine page of the application, one shot a take.'
              : '')
          : (name === 'extend_video'
              ? 'Seconds of new footage to add after the source video: the length the user asked for'
              : 'Clip length in seconds: the length the user asked for') +
            (always ? ', or null when they gave none.' : ', if they gave one.') +
            ' Never write the length in the prompt. Rounded to the closest length the workflow allows' +
            (always ? '' : ` (only for: ${durations.map(workflow => workflow.id).join(', ')})`) +
            '.',
      };
      if (always) required.push('duration');
    }
    // A workflow that sets its own size still takes the format the user names; a video made
    // from another one (its continuation, a character replaced in it) has that video's.
    if (task.output === 'video' && !task.roles.source?.required && serving.some(sized))
      properties.format = {
        type: 'string',
        enum: FORMATS.map(format => format.id),
        description:
          'Picture format, only when the user asks for one ("vertical" or "portrait" is 9:16, "paysage" 16:9, "carré" 1:1). Omit it otherwise: a video that starts from an image takes the format of that image.',
      };
    // The application draws the seed; the model passes one only when the user named it.
    if (serving.some(drawsSeed))
      properties.seed = {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        description:
          'Only when the user gives a seed number: exactly that number. Omit it otherwise; the application draws one.',
      };
    const owners = {};
    for (const workflow of serving) {
      const manifest = family(workflow.pipeline);
      for (const [key, policy] of Object.entries(workflow.parameters)) {
        if (key === 'prompt' || policy.policy !== 'model' || RESERVED.has(key) || Object.hasOwn(task.roles, key))
          continue;
        // The clip length is asked in seconds (duration), not as a frame count.
        if (key === 'frames' && properties.duration) continue;
        // A setting the engine only reads with an input (the denoise of Krea 2 with an image to
        // modify) is offered with the role of that input, by a workflow that takes it: nothing to
        // pass there, nothing said of it.
        const only = onlyRoles(manifest.parameters[key]).map(role => manifest.roles?.[role]?.as);
        if (only.length && !only.some(role => properties[role] && slotsFor(workflow, role, name).length)) continue;
        (owners[key] ??= []).push(named(workflow));
        // (0.6.94) With the value made when nothing is passed, a default the workflow lacks included.
        const schema = policySchema(madePolicy(workflow, key), manifest.parameters[key]);
        if (capable && !schema.description && CAPABLE_SETTINGS[key]) schema.description = CAPABLE_SETTINGS[key];
        properties[key] = properties[key] ? widen(properties[key], schema, named(workflow)) : schema;
      }
      const schema = workflowSchema(workflow).properties;
      for (const key of ['loras', 'components'])
        if (schema[key])
          properties[key] = {
            ...schema[key],
            properties: { ...properties[key]?.properties, ...schema[key].properties },
          };
    }
    for (const [key, ids] of Object.entries(owners))
      if (ids.length < serving.length)
        properties[key].description = [properties[key].description, `Only for: ${ids.join(', ')}.`]
          .filter(Boolean)
          .join(' ');
    // The verb's own arguments (the description of a character to make, for replace_character):
    // answered by the application before any workflow is chosen.
    for (const [key, spec] of Object.entries(task.arguments ?? {})) properties[key] = structuredClone(spec);
    if (task.output === 'video' || (task.output === 'source' && video)) {
      properties.intention = {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
        description: capable
          ? 'One or two sentences in the user’s language, shown on the card of the proposal: what it will be.'
          : 'One or two sentences explaining the proposal to the user, who must confirm every video.',
      };
      if (task.output === 'video') required.push('intention');
    }
    const finals = serving.filter(workflow => workflow.profiles?.final).map(workflow => workflow.id);
    const drafts = available?.outputs.filter(item => item.draft && finals.includes(item.workflowId));
    // (A capable model: always offered, without the list of the drafts, the same at every request.)
    if (finals.length && (!available || capable || drafts.length))
      properties.reuse_output = {
        type: 'string',
        ...(available && !capable ? { enum: drafts.map(item => item.id) } : {}),
        description:
          // (prompt and duration stay `required` for every call: the application leaves them aside here.)
          capable
            ? 'When the user asks for the final version of a draft: the run_id of that draft, with stage final and intention. The draft keeps its prompt, its length and its inputs: prompt and duration are then not used, and no other argument is accepted.'
            : 'run_id of an approved draft to render again with the final profile: pass it with stage=final and intention. The draft keeps its prompt, its length and its inputs: what prompt and duration say is then not used, and no other argument is accepted.',
      };
    const list = serving
      .map(workflow =>
        capable
          ? `- ${named(workflow) === workflow.name ? workflow.name : `${workflow.id}: ${workflow.name}`}. ${workflow.description} (inputs: ${accepted(workflow, name)})`
          : `- ${workflow.id}: ${workflow.name}. ${workflow.description} (accepts: ${accepted(workflow, name)})`,
      )
      .join('\n');
    const kinds = (
      capable
        ? [
            ['take', '{"take": n} the take « PRISE n » of the project'],
            [
              'ref',
              '{"ref": n} the reference #refN of the project; "frame": "last" for the last image of a video take or reference (to start a new clip where it ends), "first" for its first; 0, 1 or 2 for a sample of a video reference',
            ],
            ['image', '{"image": n} the n-th image the user attached in this conversation (0 = first)'],
            [
              'output',
              '{"output": "run_id"} an earlier result of this conversation that has no take number, with "index" for its position in the run',
            ],
          ]
        : [
            ['image', '{"image": n} is the n-th image the user attached in this conversation (0 = first)'],
            ['resource', '{"resource": "id"} an active resource'],
            ['output', '{"output": "run_id"} an earlier result of this conversation'],
            ['take', '{"take": n} the take « PRISE n » of this project, when the user names a take by its number'],
          ]
    ).filter(([key]) => offered.has(key));
    const sources = kinds.length ? `\nSources: ${kinds.map(([, text]) => text).join('; ')}.` : '';
    return {
      type: 'function',
      function: {
        name,
        description: `${task.summary} ${task.guidance}\nWorkflows:\n${list}${sources}`,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    };
  }

  /**
   * Picks the workflow for one verb call and converts the call into that workflow's arguments.
   * `mediaOf(source)` returns 'image', 'video' or 'audio' for a source object.
   * `originOf(source)`, when given, returns `{ workflowId, pipeline }` for an earlier result (or null):
   * a workflow that produced a source, or at least one of the same model family, is preferred
   * over a more specific one, so a continuation stays in the model that made the clip.
   * `byHand`: asked by the user's own hand (the Studio, the buttons of a take), whose workflows are
   * all those that can be made here, offered to Moodix AI or not (0.6.94).
   * (0.6.476) `chosen`: the model chosen in the card of a proposal of Moodix AI (`args.workflow`, ToolRuntime.revise):
   * it is the one, whatever it takes of the inputs. What a workflow does not take is `left` ([{ role, index, source,
   * why }]): it stays in the card, greyed. Moodix AI's own images of create_image too, when no image model takes them
   * all.
   */
  async route(name, args, { mediaOf, originOf, byHand = false, chosen = false }) {
    const task = TASKS[name];
    if (!task) throw problem('Outil de génération inconnu.', 400);
    // (0.6.242) Never made for a call of Moodix AI: it is not one of its tools (definitions).
    if (task.hand && !byHand) throw problem(`${name} se demande à la main, dans le Studio.`, 400);
    const known = new Set([...RESERVED, ...Object.keys(task.roles), ...Object.keys(task.arguments ?? {})]);
    // The verb's own arguments are not the workflow's: dealt with before (see #definition).
    args = Object.fromEntries(Object.entries(args).filter(([key]) => !Object.hasOwn(task.arguments ?? {}, key)));
    // (0.6.152) A role of the user's own hand only is not taken from the chat model.
    if (!byHand) for (const [role, spec] of Object.entries(task.roles)) if (spec.hand) delete args[role];
    const provided = sources(name, args);
    for (const list of Object.values(provided)) for (const source of list) source.media = await mediaOf(source);
    const origins = [];
    if (originOf)
      for (const list of Object.values(provided))
        for (const source of list) {
          if (source.output === undefined) continue;
          const origin = await originOf(source);
          if (origin) origins.push(origin);
        }
    const affinity = workflow =>
      Math.max(
        0,
        ...origins.map(origin =>
          origin.workflowId === workflow.id ? 2 : origin.pipeline && origin.pipeline === workflow.pipeline ? 1 : 0,
        ),
      );
    // (0.6.460) The list read once: what can be made here (by hand, offered to Moodix AI or not: #runnable; else
    // #ready), then what only lacks a file.
    const all = await this.workflows.list();
    let serving = all.filter(
      workflow => workflow.ready && (byHand || workflow.enabled !== false) && serves(workflow, name),
    );
    if (!serving.length) serving = await this.#fetchable(name, all);
    // (0.6.461, Bobine Pro, B04) A workflow named by the user's own hand that lacks only files Moodix downloads (a take
    // of the Bobine asked to MiniMax H3, LTX 2.5 being here): it is the one routed, its download offered (#missing),
    // never another model made in its place.
    else if (byHand && typeof args.workflow === 'string' && !serving.some(workflow => workflow.id === args.workflow)) {
      const fetchable = (await this.#fetchable(name, all)).find(workflow => workflow.id === args.workflow);
      if (fetchable) serving = [...serving, fetchable];
    }
    // As the model was told of them (definitions, #offeredFor): one that lacks a file may be named.
    else if (!byHand) serving = await this.#offeredFor(name, serving, all);
    // The workflow the model names comes first, when it can take what was passed: a model that
    // names one for its description (and overlooks an image it cannot take) still gets a video.
    // (By its id, or by its name for a capable model, which is shown names: byName.)
    const named =
      args.workflow === undefined
        ? null
        : (serving.find(workflow => workflow.id === args.workflow) ??
          serving.find(workflow => workflow.name === args.workflow && byName(serving)(workflow) === workflow.name));
    if (args.workflow !== undefined && !named)
      throw problem(`Le workflow ${args.workflow} ne peut pas exécuter ${name}.`, 400);
    if (chosen && !named) throw problem('Choisissez le modèle de la proposition.', 400);
    // (0.6.476) An image to reuse and none to modify, from Moodix AI: the first is the image a model starts from, where
    // a workflow takes it so and not as it was passed (Krea 2 has no place for it, Qwen-Image-Edit needs the image it
    // retouches). It was refused (0.6.460).
    const moved =
      !byHand && !chosen && name === 'create_image' && !provided.source && provided.reference?.length
        ? {
            source: provided.reference.slice(0, 1),
            ...(provided.reference.length > 1 ? { reference: provided.reference.slice(1) } : {}),
          }
        : null;
    // (0.6.476) What a workflow takes of the images of create_image when none takes them all, and of anything for the
    // model chosen in a card: the rest stays in the card, greyed (`left`).
    const partial = chosen || (!byHand && name === 'create_image');
    const reasons = [];
    let best,
      lacking;
    for (const workflow of serving) {
      if (chosen && workflow !== named) continue;
      // Upscaling keeps the media type: an image source needs an image workflow.
      if (task.output === 'source' && provided.source && workflow.mediaType !== provided.source[0].media) {
        reasons.push(`${workflow.id}: ${workflow.mediaType} only`);
        continue;
      }
      // (0.6.476) The model of a verb that leads it in the chat (`chatFirst`: Qwen-Image-Edit for an image given,
      // LTX 2.5 for a video): before the one its family prefers in the Studio (`preference`), which stays the Studio's.
      // Lacking a file, only one that makes the verb from nothing: no download of Qwen-Image-Edit proposed for an image
      // Krea 2 changes.
      const lead =
        !byHand &&
        Boolean(family(workflow.pipeline).chatFirst?.includes(name)) &&
        (workflow.ready !== false || !workflow.references.some(slot => slot.required))
          ? 1
          : 0;
      for (const given of [provided, ...(moved ? [moved] : [])]) {
        const result = assign(workflow, given, name),
          count = Object.values(given).reduce((sum, list) => sum + list.length, 0);
        // Inputs the family cannot combine (MiniMax: reference images or start/end images).
        const apart = (family(workflow.pipeline).exclusive || []).filter(group =>
          group.some(role => given[role]?.length),
        );
        let candidate = null;
        if (!result.error && apart.length <= 1) candidate = { result, left: [], taken: count, complete: 1 };
        else if (partial) {
          const fit = fitInputs(workflow, given, name);
          if (!fit.missing && (chosen || fit.placed.length))
            candidate = {
              result: {
                references: fit.placed.map(({ role, index, slot }) => referenceOf(slot, given[role][index])),
                unused: workflow.references.length - fit.placed.length,
              },
              left: fit.left.map(item => ({ ...item, source: given[item.role][item.index] })),
              taken: fit.placed.length,
              complete: 0,
            };
        }
        // (0.6.134) What the workflow named cannot do without and was not given (Wan 2.2: an image to start from).
        if (result.missing && workflow === named) lacking = result.missing;
        if (!candidate) {
          if (given !== provided) continue;
          if (result.error) reasons.push(`${workflow.id}: ${result.error}`);
          else reasons.push(`${workflow.id}: ${apart.map(group => group.join('/')).join(' and ')} do not combine`);
          continue;
        }
        // The workflow named, when it takes everything; then a ready one, one that takes everything, the most taken;
        // the origin of a clip continued; the inputs as passed before an image moved; the lead of the chat, the origin
        // of the sources, the family the manifest prefers (SeedVR2 over Real-ESRGAN for images), then the most
        // specific workflow.
        const rank = [
          workflow === named && candidate.complete ? 1 : 0,
          // (0.6.460) Unnamed, a ready workflow before one that lacks a file (#offeredFor): never a download
          // proposed for what a ready one makes.
          workflow.ready === false ? 0 : 1,
          candidate.complete,
          candidate.taken,
          // (0.6.476) A suite stays with the model that made its clip (MiniMax H3 Omni): before the lead of the chat.
          name === 'extend_video' ? affinity(workflow) : 0,
          given === provided ? 1 : 0,
          lead,
          affinity(workflow),
          family(workflow.pipeline).preference ?? 0,
          -candidate.result.unused,
        ];
        const first = best ? rank.findIndex((value, i) => value !== best.rank[i]) : -1;
        if (!best || (first >= 0 && rank[first] > best.rank[first]))
          best = { workflow, ...candidate, rank, moved: given !== provided };
      }
    }
    // (0.6.476) Images Moodix AI gives to create_image that no model here starts from (MOSS Image alone): in words.
    if (!best && !byHand && name === 'create_image' && (provided.source || provided.reference) && serving.length)
      throw problem(
        'Aucun modèle d’image de cet ordinateur ne part d’une image : décrivez dans le prompt ce qu’il faut en garder.',
        400,
      );
    // (0.6.460) By the user's own hand, an image to reuse and none to modify, where no workflow takes one alone (Krea 2
    // has no place for it, Qwen-Image-Edit needs the image it retouches): said in words, with what to do. (Moodix AI's
    // is the image modified, 0.6.476.)
    const alone = { reference: provided.reference?.slice(0, 1) ?? [] };
    if (
      !best &&
      name === 'create_image' &&
      alone.reference.length &&
      !provided.source &&
      serving.length &&
      serving.every(workflow => assign(workflow, alone, name).error)
    )
      throw problem(
        'Aucun modèle d’image ne prend une référence seule : il faut la donner comme image à modifier (source) ' +
          'pour partir d’elle, ou décrire dans le prompt ce qu’il faut en garder.',
        400,
      );
    if (!best)
      throw problem(
        `Aucun workflow ne correspond à ces entrées pour ${name}. ${reasons.join('; ') || 'Aucun workflow actif.'}`,
        400,
      );
    const { workflow, result } = best,
      routed = { workflow_id: workflow.id },
      notes = [];
    if (named && workflow !== named)
      notes.push(
        lacking
          ? `${named.name} ne se fait pas sans « ${lacking} » : ${workflow.name} est utilisé à la place.`
          : `${named.name} ne prend pas ces entrées ensemble : ${workflow.name} est utilisé à la place.`,
      );
    if (best.moved)
      notes.push(
        (provided.reference.length > 1 ? 'La première référence' : 'La référence') +
          ` est prise comme image à modifier : ${workflow.name} part d’elle.`,
      );
    // (0.6.476) Why each input left out is not sent, the models that take subjects named where it takes none.
    let left = [];
    if (best.left.length) {
      const verbModels =
          TASKS[name].output === 'video' || name === 'extend_video' ? await this.videoModels(all, { chat: true }) : [],
        takers = orList(
          verbModels
            .filter(model => model.family !== workflow.pipeline && model[name] && !model[name].unavailable)
            .filter(model => subjectsTaken({ takes: { [name]: model[name].roles } }, name) > 0)
            .map(model => model[name].name),
        );
      left = best.left.map(({ role, index, kind, count, source }) => ({
        role,
        index,
        kind,
        source,
        why: leftWhy(workflow, name, { role, kind, count }, { others: takers }),
      }));
    }
    if (args.prompt !== undefined) routed.prompt = args.prompt;
    if (args.duration !== undefined && args.duration !== null) {
      if (
        typeof args.duration !== 'number' ||
        !Number.isFinite(args.duration) ||
        args.duration <= 0 ||
        args.duration > 120
      )
        throw problem('duration doit être un nombre de secondes entre 0 et 120.', 400);
      if (!timed(workflow)) notes.push(`Durée ignorée : ${workflow.name} fixe la longueur du clip.`);
      else {
        const continuation = name === 'extend_video';
        const { frames, seconds } = framesFor(workflow, args.duration, { continuation });
        routed.frames = frames;
        if (Math.abs(seconds - args.duration) > 0.05)
          notes.push(
            // (0.6.460) With the comma of a French sentence (« 14,38 s »), as the other notes (`shown`).
            `Durée ${continuation ? 'ajoutée ' : ''}: ${shown(args.duration)} s → ${shown(seconds.toFixed(2))} s, ` +
              `la plus proche que ${workflow.name} permet.`,
          );
        // (0.6.461) Asked much longer than a clip can be (« un film de 30 secondes en trois plans »): where a film
        // is made, said on the card. The chat proposed one clip of 14 s without a word of the Bobine (27/11).
        if (!continuation && args.duration - seconds > FILM_BEYOND) notes.push(FILM_NOTE);
      }
    } else if (timed(workflow)) {
      // No length asked: the workflow's standard clip, in a draft as in a final. A draft profile
      // is a smaller picture; its own frame count (one second) is not a length anyone asked for.
      const standard = workflow.parameters.frames.default ?? family(workflow.pipeline).parameters.frames?.default;
      if (Number.isInteger(standard))
        routed.frames =
          name === 'extend_video'
            ? framesFor(workflow, standard / fpsOf(workflow), { continuation: true }).frames
            : standard;
    }
    let format;
    if (args.format !== undefined && args.format !== null) {
      if (!FORMATS.some(item => item.id === args.format))
        throw problem(`format doit être l’un de : ${FORMATS.map(item => item.id).join(', ')}.`, 400);
      if (sized(workflow)) format = args.format;
      // (0.6.102) Said as the other notes: the name, then what became of the value.
      else notes.push(`Format : valeur ignorée, ${workflow.name} ne règle pas sa taille ainsi.`);
    }
    let seed;
    if (args.seed !== undefined && args.seed !== null) {
      if (!Number.isSafeInteger(args.seed) || args.seed < 0) throw problem('seed doit être un entier positif.', 400);
      if (drawsSeed(workflow)) seed = args.seed;
      // (0.6.102) Said under the name the editor shows (« Seed »), as every note of the router.
      else notes.push(`Seed : valeur ignorée, fixée par le workflow ${workflow.name}.`);
    }
    // (0.6.102) The files named, as the LoRAs: the workflow's own (#componentsFor).
    if (args.components !== undefined) this.#componentsFor(workflow, args.components, notes);
    // (0.6.94) The LoRAs named, as the other settings passed: what the workflow fixes stays its own.
    // Named all the same, a LoRA « Activé » had the whole call refused (« enabled is fixed; a locked
    // parameter cannot be overridden »).
    if (args.loras !== undefined) {
      const loras = await this.#lorasFor(workflow, args.loras, serving, notes);
      if (loras !== undefined) routed.loras = loras;
    }
    // An intention only exists for video proposals; an image workflow rejects it.
    if (workflow.mediaType === 'video' && args.intention !== undefined) routed.intention = args.intention;
    // Upscaling or smoothing a video still goes through the video confirmation, which shows an intention.
    if (workflow.mediaType === 'video' && routed.intention === undefined) routed.intention = task.summary;
    // What the engine does not read with these inputs (the denoise of Krea 2 without an image to
    // modify): passed all the same, it is left aside without a word, as the tool says it is.
    const unread = unreadParameters(workflow, result.references);
    for (const [key, value] of Object.entries(args)) {
      if (known.has(key)) continue;
      const policy = workflow.parameters[key];
      if (policy?.policy === 'model' && Object.hasOwn(unread, key)) continue;
      if (policy?.policy === 'model') {
        // Bounds widened for several workflows: a value beyond this one's is brought back to it.
        const spec = effective(policy, family(workflow.pipeline).parameters[key]);
        const low = spec.min ?? -Infinity,
          high = spec.max ?? Infinity;
        if (typeof value === 'number' && spec.type === 'number' && (value < low || value > high)) {
          routed[key] = Math.min(high, Math.max(low, value));
          notes.push(`${nameOf(key)} : ${shown(value)} → ${shown(routed[key])}, la limite de ${workflow.name}.`);
        } else routed[key] = value;
      } else if (serving.some(other => other.parameters[key]?.policy === 'model'))
        // A setting of another workflow of this verb (lyrics passed for a sound effect).
        notes.push(`${nameOf(key)} : valeur ignorée, ${workflow.name} ne prend pas ce réglage.`);
      else if (Object.hasOwn(family(workflow.pipeline).parameters, key))
        notes.push(`${nameOf(key)} : valeur ignorée, fixée par le workflow ${workflow.name}.`);
      else throw problem(`${name} n’accepte pas l’argument ${key}.`, 400);
    }
    if (result.references.length) routed.references = result.references;
    return {
      workflow,
      args: routed,
      notes,
      ...(seed !== undefined ? { seed } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(left.length ? { left } : {}),
    };
  }

  /**
   * (0.6.102) The files a call names, which no tool offers any more: each is the workflow's own, as
   * a fixed setting is (« Assistant » left the files of the editor; a workflow saved so is made with its
   * default file). Never passed on: the same file is nothing to say, another one is left aside and said
   * in `notes`, as a file the workflow does not take; the call is never refused for it.
   */
  #componentsFor(workflow, given, notes) {
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
      notes.push(`Fichiers ignorés : ${workflow.name} prend les siens.`);
      return;
    }
    const specs = family(workflow.pipeline).components;
    for (const [role, asset] of Object.entries(given)) {
      const policy = workflow.components?.[role],
        name = `« ${specs[role]?.label || role} »`;
      if (!policy) notes.push(`${name} : fichier ignoré, ${workflow.name} ne prend pas ce fichier.`);
      else if (asset !== (policy.policy === 'fixed' ? policy.asset : componentStandIn(policy)))
        notes.push(`${name} : fichier ignoré, fixé par le workflow ${workflow.name}.`);
    }
  }

  /**
   * (0.6.94) The LoRAs a call names, as the chosen workflow takes them: its switch or its strength,
   * when the workflow fixes them (« Activé », « Désactivé », a strength « Fixe »), are the workflow's,
   * as any fixed setting is. The same value is taken as it is (nothing is said); another is left
   * aside and said in `notes`; a strength for a LoRA that is not on, left aside too. A LoRA of another
   * workflow of the verb is left aside as its other settings are; one no workflow has is kept, for
   * the workflow to refuse. Undefined when nothing is left to pass.
   */
  async #lorasFor(workflow, given, serving, notes) {
    if (!given || typeof given !== 'object' || Array.isArray(given)) return given;
    const names = await this.#loraFiles([workflow]),
      bound = referenceLora(workflow),
      kept = {};
    for (const [id, selection] of Object.entries(given)) {
      const lora = (workflow.loras ?? []).find(item => item.id === id);
      if (!lora) {
        if (serving.some(other => other !== workflow && other.loras?.some(item => item.id === id)))
          notes.push(`LoRA ${id} ignoré : ${workflow.name} ne le prend pas.`);
        else kept[id] = selection;
        continue;
      }
      // The LoRA of the subject references is set by its images alone (resolveNativeWorkflow); what
      // is not an object is for the workflow to refuse.
      if (lora === bound || !selection || typeof selection !== 'object' || Array.isArray(selection)) {
        kept[id] = selection;
        continue;
      }
      const name = `« ${loraName(lora, names)} »`,
        entry = { ...selection },
        locked = lora.enabled.policy !== 'model',
        always = lora.enabled.policy === 'fixed' && lora.enabled.value === true;
      if (locked && !always) {
        // Off in the workflow: nothing of it is used.
        if (entry.enabled === true || Object.hasOwn(entry, 'strength'))
          notes.push(`LoRA ${name} ignoré : désactivé dans le workflow ${workflow.name}.`);
        continue;
      }
      if (locked && Object.hasOwn(entry, 'enabled')) {
        if (entry.enabled !== true) notes.push(`LoRA ${name} gardé : toujours activé dans le workflow ${workflow.name}.`);
        delete entry.enabled;
      }
      const on =
        locked ||
        (typeof entry.enabled === 'boolean' ? entry.enabled : madeLora(lora, workflow.pipeline).enabled.default === true);
      if (Object.hasOwn(entry, 'strength')) {
        if (!on) {
          if (entry.enabled !== false) notes.push(`Intensité du LoRA ${name} ignorée : ce LoRA n’est pas activé.`);
          delete entry.strength;
        } else if (lora.strength.policy !== 'model') {
          if (entry.strength !== lora.strength.value)
            notes.push(
              `Intensité du LoRA ${name} ignorée : ${String(lora.strength.value).replace('.', ',')}, fixée par le workflow ${workflow.name}.`,
            );
          delete entry.strength;
        }
      }
      if (Object.keys(entry).length) kept[id] = entry;
    }
    return Object.keys(kept).length ? kept : undefined;
  }
}
