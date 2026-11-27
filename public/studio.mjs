import { FORMATS, formatOf, formatsFor, nearestFormat, nearestSize, sizeFits, sizesFor } from './formats.mjs';
import { healThumbnail, thumbnailOf } from './thumbnails.mjs';
import { livePreview } from './live-preview.mjs';
import { fluxStart, takeFlux } from './take-flux.mjs';
import { ACTION_TIPS, outputActions } from './output-actions.mjs';
import { setupPointer } from './studio-pointer.mjs';
import { closePopup, openPopup } from './glass-menu.mjs';
import { fileInfo } from './media-info.mjs';
import { forgetCitedTakes } from './cited-takes.mjs';
import { DELETE_TIP, deleteQuestion } from './take-delete.mjs';
import { explanation, foldPrompt } from './studio-explain.mjs';
import { clipPlayer, stillClip } from './take-player.mjs';
import { elapsedClock } from './generation-time.mjs';
import { settingName } from './setting-names.mjs';
import { PIECES, PIECE_WORDS as WORDS, SHORT_MODELS } from './pieces.mjs';
import {
  CAMERA_DEFAULT,
  CAMERA_GROUPS,
  CAMERA_OFF_NOTE,
  CAMERA_SPEEDS,
  cameraChoice,
  cameraHasSpeed,
  cameraLabel,
  cameraMade,
  cameraOf,
  cameraOff,
  cameraSentence,
  cameraShort,
  cameraSpeedValue,
} from './camera.mjs';
import { ballDress, ballSvg } from './camera-ball.mjs';
import {
  GLOBE,
  ORBIT_SAID,
  ORBIT_WARNS,
  distanceText,
  globeDots,
  globePoint,
  globePose,
  guideTransform,
  orbitArgs,
  orbitBounds,
  orbitCurrent,
  orbitDraft,
  orbitLabel,
  orbitPose,
  orbitRefusal,
  orbitWorst,
  poseText,
  refilmSaid,
  refilmSizes,
  refilmStart,
  ringGradient,
} from './camera-orbit.mjs';
import { clipSeconds } from './take-length.mjs';
import { setupMontage } from './montage.mjs';
import { DICTATING } from './dictation.mjs';
import { heldCause } from './generation-ui.mjs';
import { QUEUE_MOST, createQueue, queueParts } from './studio-queue.mjs';

/**
 * The Studio: the creation tools of the conversation, beside the chat. Four blocks that never
 * move, each in the colour of its function: Entrée (blue), the preview and « Générer » (red),
 * Réglages (green), Sortie (yellow). Image, Vidéo or Son is chosen at the top left.
 *
 * The user sets everything and « Générer » is the confirmation. Moodix AI may set the Studio
 * too: a creation it proposes in the chat comes here, its pointer sets what its workflow leaves
 * to the assistant, and it stops on « Générer »: the user's click is the answer.
 */
const MODES = [
  {
    id: 'image',
    verb: 'create_image',
    label: 'Image',
    icon: 'image',
    output: 'Images',
    none: 'Aucune image pour l’instant',
  },
  {
    id: 'video',
    verb: 'create_video',
    label: 'Vidéo',
    icon: 'video',
    output: 'Timeline',
    none: 'Aucune vidéo pour l’instant',
  },
  { id: 'audio', verb: 'create_audio', label: 'Son', icon: 'wave', output: 'Sons', none: 'Aucun son pour l’instant' },
];
const MODE_OF_VERB = {
  create_image: 'image',
  create_video: 'video',
  extend_video: 'video',
  replace_character: 'video',
  create_audio: 'audio',
};
const ROLES = {
  source: 'Image à modifier',
  start_image: 'Image de début',
  end_image: 'Image de fin',
  // (0.6.190) « Sujet », no longer « Référence »: the case receives a character, an object or a place;
  // #ref and « Références du projet » are files, and keep their name.
  reference: 'Sujet',
};
// Each input image says what it is with a picto (moodix-design.md 13), and (0.6.201, his decision of 21/11:
// « des mots sous les pièces, en 12 px ») with a word under it (WORDS). Its whole name is in its tooltip
// and for screen readers. A subject shows « @ », and « @1 » once given.
const PICTO = { source: 'edit', start_image: 'start', end_image: 'end' };
const ADD = {
  source: 'Ajouter l’image à modifier',
  start_image: 'Ajouter l’image de début',
  end_image: 'Ajouter l’image de fin',
};
// (0.6.102) A setting by its name in the Studio, else by the one Paramètres › Modèles gives it
// (« Étapes », « Son »): never by its key (« steps »). (0.6.198) `settingName` of setting-names.mjs, which
// holds the short names of the Studio (« Durée (s) », « Qui remplacer »): the card of a proposal says the same.
/**
 * (0.6.102) A value of a setting as a creation takes it: a switch is true or false; a number within
 * the bounds of its workflow (the nearest one when it is beyond them), whole and in its steps when it
 * must be; '' when nothing is typed (the workflow's own value then). The Studio shows what it sends.
 */
function settingValue(setting, value) {
  if (value === undefined || value === null || value === '') return '';
  if (setting.type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  if (setting.type !== 'number' && setting.type !== 'integer') return String(value);
  if (setting.choices?.length) {
    const number = Number(value);
    return setting.choices.includes(number) ? number : value;
  }
  let number = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(number)) return value;
  if (Number.isFinite(setting.min)) number = Math.max(setting.min, number);
  if (Number.isFinite(setting.max)) number = Math.min(setting.max, number);
  if (setting.multipleOf) {
    const base = Number.isFinite(setting.min) ? setting.min : 0;
    number = base + Math.round((number - base) / setting.multipleOf) * setting.multipleOf;
    if (Number.isFinite(setting.max) && number > setting.max) number -= setting.multipleOf;
  }
  if (setting.type === 'integer') {
    number = Math.round(number);
    if (Number.isFinite(setting.max) && number > setting.max) number = Math.floor(setting.max);
    if (Number.isFinite(setting.min) && number < setting.min) number = Math.ceil(setting.min);
  }
  return Math.round(number * 1e6) / 1e6;
}
/**
 * (0.6.102) What the Studio says when an input the model cannot do without is missing, by its role:
 * the video to follow and the character of a replacement, the image to modify, the start and end
 * images, a subject (0.6.190: « Ajoutez un sujet. », no longer « une image de référence »).
 */
function missingInput(workflow, role, spec) {
  const video = spec.media?.includes('video');
  if (workflow.follows) return role === 'source' || video ? 'Ajoutez la vidéo à suivre.' : 'Ajoutez l’image du personnage.';
  if (role === 'source') return video ? 'Ajoutez la vidéo à prolonger.' : 'Ajoutez l’image à modifier.';
  if (role === 'start_image') return 'Ajoutez l’image de début.';
  if (role === 'end_image') return 'Ajoutez l’image de fin.';
  return 'Ajoutez un sujet.';
}
/**
 * (0.6.188) The first input the model cannot do without that is not given yet, said as above; '' when none
 * is missing. What is in its cases (`inputs`, by role) counts once it has a source (an image joined to a
 * message has none). The clip a continuation starts from (`extending`) is not asked for: it is the one
 * continued. « Générer » is greyed meanwhile, this sentence in its tooltip; pressed all the same (its
 * keys), request() says it.
 */
function inputMissing(workflow, inputs, extending) {
  const role = missingRole(workflow, inputs, extending);
  return role ? missingInput(workflow, role, workflow.roles[role]) : '';
}
/** (0.6.253) The role of that input: its case lights up when « Générer » greyed is pressed. */
function missingRole(workflow, inputs, extending) {
  for (const [role, spec] of Object.entries(workflow?.roles ?? {})) {
    if (extending && role === 'source') continue;
    if (spec.required && spec.count && !(inputs[role] ?? []).some(item => item?.source)) return role;
  }
  return '';
}
/**
 * (0.6.253, generer-maquette.md) What the bubble of « Générer » says without a prompt: what to describe first,
 * by the page (« Écrivez un prompt pour générer » before).
 */
const BLANK_WHY = {
  image: 'Décrivez d’abord votre image.',
  video: 'Décrivez d’abord votre vidéo.',
  audio: 'Décrivez d’abord votre son.',
};
/**
 * (0.6.256, lot 4) The pages Agrandir and Interpoler: the word of the case of their take, of their button, why their
 * prompt is greyed, what their factor is called, the first step said while they work, the mark of what they made in
 * the Sortie, and what is said to the server of the request.
 */
const FINISH = {
  upscale: {
    word: 'À agrandir',
    go: 'Agrandir',
    needless: 'Agrandir n’a pas besoin de prompt.',
    line: 'Taille',
    step: 'Agrandissement…',
    badge: '↳ AGRANDIE',
    glyph: 'act-upscale',
    intention: media => `Agrandir ${media === 'video' ? 'la vidéo' : 'l’image'}.`,
    // (0.6.260) Why « × n » is greyed on its page: the same take made larger twice is the same take.
    once: 'Agrandir fait une seule prise : la même prise agrandie deux fois donne la même image.',
  },
  interpolate: {
    word: 'À interpoler',
    go: 'Interpoler',
    needless: 'Interpoler n’a pas besoin de prompt.',
    line: 'Images',
    step: 'Interpolation…',
    badge: '↳ INTERPOLÉE',
    glyph: 'act-interpolate',
    intention: () => 'Rendre la vidéo plus fluide.',
    once: 'Interpoler fait une seule prise : la même vidéo interpolée deux fois donne la même vidéo.',
  },
};
/** (0.6.261) A number rounded as Python does (the engine): a half to the even one (4680.5 → 4680, 4681.5 → 4682). */
export function roundHalfEven(value) {
  const near = Math.round(value);
  return Math.abs(value % 1) === 0.5 && near % 2 !== 0 ? near - 1 : near;
}
/**
 * (0.6.253) A button greyed that still answers: its `disabled` is its own, said by `aria-disabled`, so the
 * browser still gives it the clicks, the focus and the keys (a disabled button said nothing without a hover).
 */
function greyable(control) {
  let off = false;
  Object.defineProperty(control, 'disabled', {
    configurable: true,
    get: () => off,
    set: value => {
      off = Boolean(value);
      if (off) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    },
  });
  return control;
}
// What the values of a setting on a bar do, said under it (measured on Krea 2, 17/11).
const BAR_HELP = { denoise: '0,6 garde la composition et change l’ambiance ; 0,7 laisse la composition changer.' };
// Why a setting the model only reads with an input is greyed while the case of that input is empty.
const ONLY_WITH = { source: 'Sert seulement avec une image à modifier.' };
// The settings on a bar that « Enregistrer » keeps for a model (lib/studio-presets.mjs checks each).
const KEPT_SETTINGS = ['denoise'];
// Who is who, for a character put in a video: said in a few words, not among the rare settings. Read by a
// detector that knows English words. (0.6.204) Each in the window of its piece (`piece`, the role of that
// piece: the video to follow, the character), no longer in a block of their own beside the inputs.
const WHO = {
  subject: {
    piece: 'source',
    hint: 'girl, handkerchief',
    help:
      'La personne ou l’animal de la vidéo à remplacer, en quelques mots d’anglais : « girl », « penguin », ' +
      'ou « man in red jacket » quand la vidéo montre plusieurs personnes.\n' +
      'Après une virgule, un objet qu’elle tient reste tel quel : « girl, handkerchief ».\n' +
      '« person » suffit quand il n’y a qu’une personne.',
  },
  reference_subject: {
    piece: 'reference',
    hint: 'woman',
    help:
      'Le personnage à prendre dans l’image, en un ou deux mots d’anglais : « woman », « robot », « cartoon cat ». ' +
      'Le décor de l’image est laissé de côté.\n' +
      '« person » suffit pour un humain.',
  },
};
/**
 * (0.6.206) Whether a setting of a workflow is one of « Plus de réglages »: not the lyrics of a song (under the
 * prompt), nor who is who (in the windows of its pieces), nor the length of a sound (on the bar of Durée). One
 * rule for its lines and for the pointer of Moodix AI, which opens its window for them.
 */
const rareSetting = setting =>
  !(setting.key === 'lyrics' && setting.type === 'string') &&
  !(WHO[setting.key] && setting.type === 'string') &&
  !(setting.key === 'seconds' && setting.type === 'number');
const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const SETTING_HELP = { lyrics: 'Vide pour un morceau instrumental. Balises : [Verse], [Chorus], [Bridge]…' };
const MAX_STYLES = 3;
// The three formats shown under the preview; « ··· » opens all of them.
const MAIN_FORMATS = ['1:1', '16:9', '9:16'];
// The key that goes with Entrée to generate, as the keyboard names it.
const MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
const strengthText = value => (Math.round(value * 100) / 100).toFixed(2).replace('.', ',');
/**
 * A decimal setting between two close bounds (the denoise of Krea 2, 0.6 to 0.7): the Studio shows
 * it on a bar, by hundredths. A wider one, or a whole number, keeps its field.
 */
const fineSetting = setting =>
  setting.type === 'number' &&
  !setting.choices &&
  Number.isFinite(setting.min) &&
  Number.isFinite(setting.max) &&
  setting.max > setting.min &&
  setting.max - setting.min <= 1;
/** A value of such a setting within its bounds, at a hundredth; its default when there is none. */
function fineValue(setting, value) {
  const given = value === undefined || value === null || value === '' ? (setting.default ?? setting.min) : value,
    number = Number(given);
  if (!Number.isFinite(number)) return setting.min;
  return Math.round(Math.min(setting.max, Math.max(setting.min, number)) * 100) / 100;
}
/**
 * Whether a setting is read with these inputs (`roles`: their roles, as the family names its slots):
 * one the engine only reads with an input (`onlyWith`: the denoise of Krea 2 with an image to
 * modify) is none of a creation made without it, whose record then says another value (1).
 */
const onlyRoles = setting => (setting.onlyWith ? (setting.onlyWith.roles ?? [setting.onlyWith.role]) : []);
const settingRead = (setting, roles) => !setting.onlyWith || onlyRoles(setting).some(role => roles.includes(role));
/**
 * The case of the input a setting is only read with (by the role the Studio gives that input:
 * `inputs` of its workflow), or null for a setting read whatever the inputs.
 */
const onlyInputs = (workflow, setting) => onlyRoles(setting).map(role => workflow.inputs?.[role] ?? role);
const onlyRole = (workflow, setting) => onlyInputs(workflow, setting)[0] ?? null;
/** The settings on a bar of a model that « Enregistrer » keeps. */
const keptSettings = workflow =>
  (workflow.settings ?? []).filter(setting => KEPT_SETTINGS.includes(setting.key) && fineSetting(setting));
const leaf = name =>
  String(name)
    .split(/[\\/]/)
    .pop()
    .replace(/\.safetensors$/i, '');
// A length as the Studio writes it everywhere (moodix-design.md 27): two figures before the
// point, two after (« 05.17 s »); in capitals on the screen (« 05.17 S »). The value is the true
// one, from the frames the model makes (5 s asked can be 5.17 s made).
const twoFigures = value => (Math.round(Number(value) * 100) / 100).toFixed(2).padStart(5, '0');
// A length as everywhere: « 05.17 S » (16/11: no small « s » in the settings any more).
const seconds = value => twoFigures(value) + ' S';
// The name a slot shows while something that it takes is carried (studio-maquette.md, « Glisser »).
// (0.6.190) « Sujet 2 », no longer « Réf. 2 ».
const SHORT = { start_image: WORDS.start_image, end_image: WORDS.end_image, reference: WORDS.reference, source: 'Image', source_video: 'Vidéo' };
// (0.6.201) The word under a piece of the plateau (capture 93), by its role: what it is for, in a word or two.
// The video a character is put in says « À suivre », its character « Personnage » (capture 97). (0.6.209)
// `WORDS` is the table of public/pieces.mjs: the card of the Chat and the line of the Bobine read it too.
// (0.6.202) A piece given that the model in hand does not take, as the line under the plateau names it
// (capture 96): « L’image de fin et le sujet ne partiront pas avec Wan 2.2. ».
const KEPT = { start_image: 'l’image de début', end_image: 'l’image de fin', source: 'l’image à modifier', camera: 'la caméra' };
// The inputs of a proposal are those Moodix AI chose: said on a click on one of its cases, and (0.6.203) why
// « Ajouter » is greyed under it.
const AI_INPUTS = 'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.';
// (0.6.203, captures 94, 100 and 101) Each kind of piece in the list « Ajouter »: its name, what the list says of
// it once given (`given`), and how a model that does not take it says which one does (`serves`: « Une vidéo à
// suivre sert avec SCAIL-2 : choisissez-le dans Modèle. »). (0.6.209) `PIECES`, in public/pieces.mjs.
// (0.6.203, his answer 8 of 21/11: « avec SCAIL-2 ») A model said short in that list: the name its family has
// here, else what its name says in brackets (« Musique (ACE-Step 1.5 XL) »), else its name.
// (0.6.210) `SHORT_MODELS`, in public/pieces.mjs: the list of a line of the Bobine says « avec SCAIL-2 » too.
const shortModel = workflow =>
  SHORT_MODELS[workflow.family] ?? String(workflow.name).match(/\(([^()]+)\)\s*$/)?.[1] ?? String(workflow.name);
const figures = value => twoFigures(value) + ' S';
/** The length of a sound in the Sortie (capture 23): « 08.00 S », « 1:45 » from a minute. */
const soundFigures = value => {
  const total = Math.round(Number(value));
  return total >= 60 ? Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0') : figures(value);
};
const sizeKey = size => size.width + 'x' + size.height;
// The box the format frame fits in before its stage is laid out.
const FRAME = { width: 264, height: 176 };
// The tools of the Studio are read again in the background past this age.
const TOOLS_TTL_MS = 60000;
// (0.6.102) What scrolls in itself in the Studio, kept where it was from one drawing to the next:
// the column of Entrée (the block, moodix.css) and the body of Réglages (0.6.98).
const SCROLLED = [
  '#studio-view .studio-block.is-input',
  '#studio-view .studio-block.is-input > .studio-block-body',
  '#studio-view .studio-block.is-settings',
  '#studio-view .studio-block.is-settings > .studio-block-body',
];

/** The frame of a ratio, as large as its box allows. */
export function frameSize(ratio, box = FRAME) {
  return ratio >= box.width / box.height
    ? { width: box.width, height: Math.round(box.width / ratio) }
    : { width: Math.round(box.height * ratio), height: box.height };
}

/** The sizes offered for a workflow in a format (those of its family: Krea 2's), and the one closest to `pixels`. */
export function sizeChoices(workflow, formatId, pixels) {
  const format = FORMATS.find(item => item.id === formatId),
    sizes = format ? sizesFor(format, workflow.limits, workflow.family) : [];
  return { sizes, nearest: nearestSize(sizes, pixels) };
}

/**
 * Whether the size in a draft (« 1920x1080 ») is one the workflow makes in the format of that draft,
 * listed or not: a size a take or a proposal was made at (0.6.92).
 */
function madeSize(workflow, draft) {
  const [width, height] = /^\d+x\d+$/.test(draft.size ?? '') ? draft.size.split('x').map(Number) : [];
  return sizeFits({ width, height }, workflow.limits) && nearestFormat(width, height)?.id === draft.format;
}

/** The formats under the preview: the three main ones, and the one chosen when it is another (it takes the place of « ··· »). */
export function shownFormats(available, chosen) {
  const main = MAIN_FORMATS.filter(id => available.includes(id));
  return { main, extra: chosen && !main.includes(chosen) && available.includes(chosen) ? chosen : null };
}

/**
 * (0.6.326) The model a request names: by the identifier the server routed it to (`args.workflow_id`), then by
 * its name. Two workflows of the user may bear the same name: the first was shown while the other one was made.
 */
const modelOfRequest = (request, offered) =>
  offered.find(item => item.id === request.args?.workflow_id) ??
  offered.find(item => item.name === request.workflowName);

/**
 * What a proposal of Moodix AI sets, in the Studio's terms: the workflow, the prompt, the size,
 * the length, the seed, the settings and the inputs; and what of it the assistant may change
 * (the parameters its workflow leaves to « Assistant »). The rest is shown as it will be made.
 */
export function proposedValues(request, offered = []) {
  const plan = request.plan || {},
    parameters = plan.parameters || {},
    editable = plan.editable || {},
    items = new Map((editable.parameters || []).map(item => [item.key, item])),
    free = key => items.has(key) && !items.get(key).locked,
    workflow = modelOfRequest(request, offered) ?? offered[0] ?? null,
    references = plan.references || [],
    source = references.find(ref => ref.role === 'source_video'),
    fps = parameters.fps > 0 ? parameters.fps : null,
    overlap = source && Number.isFinite(parameters.overlap_frames) ? parameters.overlap_frames : 0,
    width = parameters.width ?? request.resolution?.width,
    height = parameters.height ?? request.resolution?.height;
  const settings = {},
    roles = references.map(ref => ref.role),
    // (0.6.102) What its workflow fixes is no choice of Moodix AI: shown at once, as it will be made,
    // the pointer does not set it (a size « Fixe » neither: `assistantSize`).
    fixed = new Set((workflow?.settings ?? []).filter(setting => setting.fixed).map(setting => setting.key));
  // (Not a setting read only with an input the proposal does not have: the Studio keeps its own.)
  for (const setting of workflow?.settings ?? [])
    if (parameters[setting.key] !== undefined && settingRead(setting, roles))
      settings[setting.key] = parameters[setting.key];
  return {
    verb: request.tool || request.call?.function?.name || 'create_image',
    workflow: workflow?.id ?? null,
    prompt: String(plan.prompt ?? request.args?.prompt ?? ''),
    promptFree: Boolean(editable.prompt),
    size: width > 0 && height > 0 ? sizeKey({ width, height }) : null,
    // (Of a ratio no format is close to, the nearest one, 0.6.92: the format in hand stayed beside its size.)
    format: nearestFormat(width, height)?.id ?? null,
    sizeFree: free('width') && free('height') && (workflow?.assistantSize ?? true),
    seconds: fps && Number.isFinite(parameters.frames) ? Math.max(0, parameters.frames - overlap) / fps : null,
    frames: parameters.frames ?? null,
    fps,
    overlap,
    framesFree: free('frames'),
    framesChoices: items.get('frames')?.choices ?? null,
    seed: Number.isFinite(parameters.seed) ? parameters.seed : null,
    seedFree: free('seed'),
    stage: plan.stage ?? null,
    settings,
    settingsFree: Object.fromEntries(Object.keys(settings).map(key => [key, free(key) && !fixed.has(key)])),
    references: references.filter(ref => ref.role !== 'source_video'),
    // The LoRAs of the workflow it switches on, with their strength (the others are off).
    loras: Array.isArray(plan.loras) ? plan.loras : null,
    roleChoices: editable.references || [],
    source: source?.output_id ?? null,
    // The clip continued is a file of the disk kept as a reference of the project (« #ref1 »), not a take.
    sourceResource: source && !source.output_id ? (source.resource_id ?? null) : null,
    sourceLabel: String(source?.label ?? ''),
  };
}

export function setupStudio({
  api,
  node,
  icon,
  notice,
  assets,
  viewOutput,
  waitForModel,
  blocked,
  onChange,
  // Called with the conversation whose creations were read again.
  onRuns = () => {},
  // The conversation the page shows: its id, or null before its first message or creation. The
  // Studio works in it, unless it holds a work of another one (`conversation()` below, 0.6.81).
  conversation: shownConversation = () => null,
  // The project of that conversation: its Sortie shows the creations of all its conversations.
  project: shownProject = () => 'inbox',
  // An id for the conversation, created when it has none yet: a creation belongs to it.
  ensureConversation = async () => shownConversation(),
  // (0.6.81) A creation made here begins (its conversation) or ends (null): the page follows it,
  // whatever page the user opens meanwhile.
  onWork = () => {},
  // Whether a creation of its own may begin (0.6.90): false when the user said no to what it costs.
  mayBegin = () => true,
  // Why nothing can be made now, in the user's words: a work goes on in another conversation; ''.
  elsewhere = () => '',
  // The name of a conversation, said where the Studio is held by it.
  nameOf = () => '',
  // The few seconds the pointer of Moodix AI sets the Studio begin (true) or end (false).
  onLock = () => {},
  // Runs an approved proposal in the conversation and writes it there; the result of the
  // generation. Without it, the Studio follows the job itself and nothing is written.
  run = null,
  // Brings the Studio on screen: a proposal of Moodix AI arrives.
  reveal = () => {},
  // Stops the turn of the chat that a generation approved here belongs to.
  stopTurn = () => {},
  // Another conversation is open.
  onConversation = () => {},
  // Resolves once the page has stopped moving (a change of view): drawing the Studio again then
  // made the movement stutter.
  afterMove = () => Promise.resolve(),
  // The pace of the pointer: 1 as it is seen, 0 at once (the tests).
  pace = 1,
  // The last generation left the card held (its engine did not say it let it go): « Libérer le GPU ».
  gpuBlocked = () => false,
  // (0.6.456) What the generation that left it held said (its error): why it failed, under its screen.
  gpuError = () => '',
  // (0.6.463) Whether that generation made its take all the same (kept): the card alone is to free.
  gpuMade = () => false,
  recoverGPU = async () => {},
  // The mark of Moodix AI drawn with a mask of its own (app.js, moodixMark): it breathes.
  mark = null,
  // « Agent »: opens the chat of Moodix AI, as the band at the foot of the Studio did.
  openAgent = () => {},
  // Brings the Studio on screen (as « Studio » of the top bar does): a mode chosen from elsewhere.
  openStudio = () => {},
  // The take of the Chat being made in the conversation shown (0.6.96): { request, running, label,
  // fraction, preview, ended }, or null. Its other view, the Studio follows it (watch).
  making = () => null,
  // (0.6.253) Shows at once the bubble of a control (public/help-tips.mjs): « Générer » greyed and pressed says why.
  sayTip = () => {},
  // (0.6.452) The dictation (public/dictation.mjs): its microphone in the corner of the prompt, at the left of the
  // wand, which it never replaces; alone there in Son, which has no wand. Handed to the Bobine too.
  dictation = null,
  // (0.6.466) Where the queue of « Générer ensuite » is kept (the sessionStorage of the tab), and the identity of the
  // tab: found again by that same tab reloaded only (studio-queue.mjs). Without them, it lives in the page.
  queueStorage = null,
  tab = '',
  // (0.6.478) The Studio was drawn (its queue may have changed, its settings moved): the window at the bottom right
  // says the queue again, and lies under the settings (app.js, syncMiniature).
  onQueue = () => {},
}) {
  const $ = id => document.getElementById(id);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms * pace));
  let info = null,
    mode = 'image',
    runs = [],
    nextTake = null, // the number the next take of the project will have (the server's counter)
    working = null, // { label, fraction, preview, controller | external, chat } while a generation runs
    busyDrawn = '', // why a work of the page greys « Générer », as last drawn (busyChanged)
    // A creation just over, its takes read again: the Studio still holds its conversation (holds),
    // or a status read meanwhile let it go (letGo) and its take went on the screen of the one shown.
    settling = false,
    releasing = null, // the chat model leaving the GPU, asked once the user sets the Studio
    released = false,
    enriching = false,
    extending = null, // the clip being continued
    // (0.6.256, lot 4) The take made larger or smoother on its own page (Agrandir, Interpoler): { verb, record,
    // workflow (the model chosen there), factor (the one chosen) }; its page is the one of its kind.
    finishing = null,
    // (0.6.256) The image « Animer » put as the start of a video: shown on the screen of Vidéo while it is its Début.
    animated = null,
    refilmId = null, // (0.6.240) the id of that clip when its camera is changed in place of being continued
    refilmGate = null, // (0.6.240) « Changer la caméra » lit or greyed in place, set with its button
    guide = null, // (0.6.240) the simple guide on the screen while a camera is set: { world, warn, bounds }
    failure = '',
    advanced = false, // « Plus de réglages » is open
    formatsOpen = false, // « ··· » is open
    addOpen = false, // (0.6.203) the list of « Ajouter » is open
    pieceOpen = null, // (0.6.204) { role, index }: the piece given whose small window is open
    pieceFocus = false, // (0.6.204) that window was just opened by a click: the focus goes into it
    cameraMenu = false, // (0.6.257) the menu of the block « Caméra » is open
    cameraFocus = false, // (0.6.257) it was just opened by a click: the focus goes to the movement chosen
    comparing = true, // (0.6.258) the loupe over an image made larger (« Comparer » pressed)
    loupeShown = null, // (0.6.258) the loupe of the screen drawn last: { hide }
    moreFocus = false, // (0.6.206) the same for the window of « Plus de réglages », opened by its pill
    drawn = null, // the size the frame was last drawn at, to ease from
    watching = null, // follows the size of the stage
    laidOut = false, // the stage was in sight at the last look: its screen eases to a new shape
    live = null, // { frame, preview } : the picture so far, in the frame now on the page
    flux = null, // { frame, flux }: the Flux of the take being made, in the frame now on the page
    blankLines = null, // (0.6.253) { size }: the format and the size in the middle of the empty screen (sayBlank)
    proposal = null, // a proposal of Moodix AI waiting for « Générer »
    checking = null, // { record, resolve }: the character Moodix AI made, waiting for the user
    ai = null, // { stopped, active, touched } while the pointer sets the Studio
    seenConversation, // the conversation the creations were read for
    runsFor, // where they were read from: the conversation and its project (where)
    runsStale = false, // something was made elsewhere since
    loading = null, // the tools being read
    unreadable = '', // why the tools could not be read, while they are not
    sketched = false, // the blocks were drawn empty while the tools were read: what comes fades in
    toolsAt = 0,
    toolsStale = false,
    shownMedia = null, // { key, element }: what the screen shows, kept from one drawing to the next
    draftsKey = null, // the conversation whose settings are in the Studio (draftKey)
    // 0.6.81: a work held here (a take made, a proposal of Moodix AI, a character checked) keeps the
    // Studio in the conversation it began in, { conversation, project }, while the page shows
    // another one, where it is said held; it is that conversation's again when the work ends (letGo).
    heldIn = null;
  // (0.6.466) The requests « Générer ensuite » froze (studio-queue.mjs). `chaining`: from the end of a take of the
  // Studio to the start of the next one (its next try, the next request of the queue): the Studio and the work of the
  // page stay held meanwhile, and nothing of the Chat or the Bobine begins between two of them.
  const queue = createQueue({ storage: queueStorage, tab });
  // (`cardWait`: what stops the wait between two of them, freeAgain.)
  let chaining = false,
    cardWait = null,
    // (0.6.478) The window at the bottom right is to be told the queue once this drawing is over (render).
    queueTold = false;
  /** Whether the Studio holds a work: a take being made, a proposal waiting, a character checked. */
  // (`settling`: a creation just over, until its take is on the screen of its own conversation, 0.6.87.)
  // (Not a take of the Chat it follows, `working.chat`: that one is its conversation's, 0.6.96.)
  const holds = () => Boolean((working && !working.chat) || proposal || checking || ai || settling || chaining);
  // (0.6.466) A take of the Studio made by its own « Générer » (or the moment until the next one of its queue): the
  // form stays free meanwhile. Not a take of the Chat or of the Bobine, nor one followed again: they write in it.
  const ownWork = () => (working ? Boolean(working.controller) && !working.montage : chaining);
  /** (0.6.466) Whether the form is held by what is being made: what the Chat or the Bobine makes is shown in it. */
  const locked = () => Boolean(working) && !ownWork();
  // (0.6.175) What is said where a creation waits for the end of another one of this conversation.
  const BUSY_HERE = 'Génération en cours dans cette conversation : attendez sa fin.';
  // (0.6.466) The wand while a take is made: the model of the chat has left the card for it (B4: greyed, silent).
  const WAND_HELD = 'Moodix AI est en pause pendant la génération.';
  /** (0.6.466) How many requests of the queue wait for their turn now (not those paused). */
  const queueLeft = () => queue.waiting().length;
  const requests = count => (count > 1 ? `${count} demandes` : `${count} demande`);
  /**
   * (0.6.175) Why a take of the Bobine cannot be created now, in the user's words; '' when it can. What
   * `generate` refuses: a creation under way here (the Studio's own, a take of the Chat it follows) or
   * just over, a work it holds in another conversation, what the page says (`blocked`: Moodix
   * answering, an operation), and what greys « Générer » (`elsewhere`). Never the Bobine's own take
   * being made: it says that one itself.
   */
  function whyNot() {
    if (working?.montage) return '';
    if (away()) return elsewhere() || 'Une création est en cours dans une autre conversation : attendez sa fin.';
    // (0.6.466) The queue of the Studio goes on: said above « Créer » short (montage.mjs, SHORT_WAITS), whole here.
    const left = queueLeft();
    if (left)
      return `Le Studio a encore ${requests(left)} en file : attendez ${left > 1 ? 'leur' : 'sa'} fin, ou arrêtez-la.`;
    if (working || settling || chaining) return BUSY_HERE;
    return blocked() || elsewhere() || '';
  }
  /** The conversation the Studio works in, and its project: the page's, unless it holds a work of another. */
  const conversation = () => (heldIn ? heldIn.conversation : shownConversation());
  const project = () => (heldIn ? heldIn.project : shownProject());
  /** The page shows another conversation than the one whose work the Studio holds. */
  const away = () => Boolean(heldIn) && heldIn.conversation !== shownConversation();
  /** A work begins here, in the conversation shown (`id` once it has one): always on screen then. */
  // (0.6.466) A request of the queue, in its own: the conversation and the project it was asked in (D9).
  function holdAt(id = shownConversation(), where = shownProject()) {
    heldIn = { conversation: id, project: where };
  }
  /** The work held here is over: left meanwhile, the Studio goes to the conversation shown. */
  function letGo() {
    if (!heldIn || holds()) return;
    const left = away();
    heldIn = null;
    if (left) conversationChanged();
  }
  // The Studio as each conversation was left (its mode, its drafts) with the newest take it had
  // then: it comes back so, unless a take was made in it since (16/11).
  const leftDrafts = new Map();
  // Per conversation, the newest take the Studio was set from, or made itself (settle).
  const lastSeen = new Map();
  // Counts the conversations the drafts were handed to (conversationChanged): the drafts are the
  // same objects from one conversation to the next, so what was asked for one and comes back later
  // (a prompt being improved, a file being imported) is told apart by this count, and not written.
  let draftsEpoch = 0,
    // The count when « Enrichir le prompt » was asked: it holds settle for its own conversation only.
    enrichEpoch = -1;
  // The take opened from the chat on the screen (« Afficher dans le Studio »): it stays there.
  let pinned = null,
    // A creation put on the screen to see what made it (inspect): the Studio as it was before, to
    // come back to with the button at the right of « Image · Vidéo · Son ».
    looked = null,
    // The address made for a file shown from the disk itself (a sound), to give back.
    lookedUrl = '';
  // What is shown on the screen for each mode: the last creation, or one opened from the chat.
  const kept = {};
  const blank = () => ({
    workflow: null,
    prompt: '',
    before: null, // what was typed before « Enrichir le prompt », to come back to
    styles: [],
    shelved: {}, // the LoRAs of the other families of models, for the way back
    workflowLoras: {}, // per workflow, its own LoRAs: { id: { on, strength } }
    format: null,
    size: null,
    seed: '',
    length: null,
    extension: null,
    orbit: null, // (0.6.240) the camera of a clip to film again (public/camera-orbit.mjs)
    inputs: {},
    settings: {},
    lyrics: false, // the lyrics are shown (« + Paroles »)
    camera: null, // (0.6.211) the camera of a video, once added: { move, speed } (public/camera.mjs)
    // (0.6.257) The last movement chosen in the block « Caméra », kept while its switch is off: it comes back on.
    cameraLast: null,
  });
  const drafts = Object.fromEntries(MODES.map(item => [item.id, blank()]));
  const picker = node('input');
  picker.type = 'file';
  picker.accept = 'image/png,image/jpeg,image/webp';
  picker.hidden = true;
  $('studio-view')?.append(picker);
  const cursor = $('ai-cursor'),
    pointer = cursor ? setupPointer({ cursor, text: $('ai-cursor-text') ?? cursor }) : null;

  const modeOf = id => MODES.find(item => item.id === id);
  /**
   * The models of a verb; without one, those the mode in hand offers: its own and, for a video,
   * those that put a character in an existing one (chosen in the same list, they bring their
   * own inputs).
   */
  /** (0.6.240) The clip in hand has its camera changed (« Changer la caméra »), it is not continued. */
  const refilming = () => mode === 'video' && Boolean(extending) && refilmId !== null && extending.id === refilmId;
  /**
   * (0.6.256) The take of the page Agrandir or Interpoler, when it is the page in hand (its kind's). A clip continued
   * or filmed again, or a proposal of Moodix AI in this page, comes first.
   */
  const finishOn = () =>
    finishing && !extending && !(proposal && proposal.mode === mode) && mode === mediaOf(finishing.record) ? finishing : null;
  const offered = verb => {
    if (verb) return info?.tools?.[verb] ?? [];
    // (0.6.256) Agrandir, Interpoler: the models that make a take of this kind larger or smoother.
    if (finishOn()) return (info?.tools?.[finishing.verb] ?? []).filter(item => item.media === mode);
    if (mode === 'video' && extending) return info?.tools?.[refilming() ? 'refilm_video' : 'extend_video'] ?? [];
    const list = info?.tools?.[modeOf(mode).verb] ?? [];
    return mode === 'video' ? [...list, ...(info?.tools?.replace_character ?? [])] : list;
  };
  const verbOf = () =>
    finishOn()
      ? finishing.verb
      : mode === 'video' && extending
        ? refilming()
          ? 'refilm_video'
          : 'extend_video'
        : (current()?.verb ?? modeOf(mode).verb);
  function current() {
    const draft = drafts[mode],
      list = offered(),
      // A model this computer cannot run (`unavailable`, its reason) is shown greyed: it is the
      // one in hand only when no other can be.
      usable = list.filter(item => !item.unavailable),
      first = usable[0] ?? list[0] ?? null;
    // A continuation stays with the workflow that made the clip when it can. A clip of the disk was
    // made by none of them: the one chosen here (in the list, or by the proposal just answered).
    // (0.6.240) A clip filmed again is filmed by the model made for it, whatever made the clip.
    if (refilming()) return first;
    // (0.6.256) Agrandir, Interpoler: the model chosen on their page, never the one of the mode's own draft.
    if (finishOn()) return usable.find(item => item.id === finishing.workflow) ?? first;
    if (mode === 'video' && extending && !proposal)
      return usable.find(item => item.id === (extending.workflowId ?? draft.workflow)) ?? first;
    return usable.find(item => item.id === draft.workflow) ?? first;
  }
  // A proposal of Moodix AI is answered from its own mode: the others still work by hand.
  const answering = () => Boolean(proposal && proposal.mode === mode && !working);
  /**
   * Another model for this mode. A LoRA is made for one family of models: those chosen for
   * Krea 2 do not follow to MOSS Image (they were sent with it), and come back with Krea 2.
   */
  function choose(id) {
    // (0.6.256) Another model on the page Agrandir or Interpoler: kept with it, the draft of the mode untouched.
    if (finishOn()) {
      finishing.workflow = id;
      return render();
    }
    const draft = drafts[mode],
      from = current()?.family,
      to = offered().find(item => item.id === id)?.family;
    if (from !== to) {
      draft.shelved[from] = draft.styles;
      draft.styles = draft.shelved[to] ?? [];
    }
    draft.workflow = id;
    // Its saved settings come back with it (« Enregistrer »), those its workflow leaves free.
    const chosen = current();
    if (chosen) applyPreset(chosen);
    render();
  }
  const button = (className, text, onclick, glyph) => {
    const control = node('button', className);
    control.type = 'button';
    if (glyph) control.append(icon(glyph));
    if (text) control.append(node('span', '', text));
    control.onclick = onclick;
    return control;
  };
  // « Agent », left of « Générer » (moodix-design.md 15 bis): the chat of Moodix AI opens from it as
  // it did from the band at the foot. Made once and moved from one drawing to the next: the move
  // between the chat and the Studio folds the chat into it (view transition, moodix.css).
  // (0.6.253, generer-maquette.md, decided on 23/11) A button of its own, 8 px right of « Générer »: no longer the
  // half of a Double verre. Always named, its Éclipse and « Moodix AI » (« Agent » before, hidden by the CSS), and
  // « Demander à Moodix AI » under the pointer. It still opens the chat.
  const AGENT_TIP = 'Demander à Moodix AI';
  const agent = button('studio-agent', '', () => openAgent(), mark ? null : 'eclipse');
  if (mark) agent.append(mark());
  agent.id = 'agent-open';
  agent.title = AGENT_TIP;
  agent.setAttribute('aria-label', AGENT_TIP);
  agent.setAttribute('aria-controls', 'chat-panel');
  // No colour along its foot (moodix-design.md 7 bis 22: the colour goes to Générer); a light runs there while
  // Moodix AI writes with the chat folded.
  const light = node('span', 'studio-agent-light');
  light.setAttribute('aria-hidden', 'true');
  agent.append(node('span', 'studio-agent-word', 'Moodix AI'), light);
  // The actions of the take on the screen, at the left of the bar (studio-maquette.md): the same
  // icons and the same help as in the conversation (output-actions.mjs), without « Ouvrir ».
  // (0.6.255, lot 3) In a column at the right of the frame (`rail`), their names under their icons when it unfolds.
  const takeActions = outputActions({
    api,
    node,
    icon,
    onDetails: null,
    onAction: (record, index, id) => takeAction(record, id),
    rail: true,
    // (0.6.261) Greyed, it answers with its reason in its bubble, as « Générer » does (pressGo).
    greyable,
    onGreyed: button => queueMicrotask(() => sayTip(button)),
    // (0.6.466, D7) While a take of the Studio is made, what makes a take of this one waits, greyed, and says why.
    held: () => (ownWork() ? RAIL_HELD : ''),
  });
  // (0.6.255) What the column of the actions takes at the right of the frame: 16 px, then its buttons of 54.
  const RAIL_ROOM = 70;
  // (0.6.261) Its buttons unfolded: 112 px wide, as tall as folded (54), so that nothing moves under the pointer.
  const RAIL_OPEN = 112;
  /**
   * (0.6.261) How far the column unfolded goes to the left, over the frame: what the stage lacks at its right for
   * its 58 px more (never more: the button keeps the place it had folded under the pointer).
   */
  function railShift(frame, size) {
    const width = frame.parentElement?.clientWidth ?? 0,
      right = (width - size.width) / 2 - RAIL_ROOM,
      more = RAIL_OPEN - (RAIL_ROOM - 16);
    return width > 0 ? Math.max(0, Math.min(more, Math.ceil(more - right))) : 0;
  }
  // Image · Vidéo · Son: drawn in the head of the screen, put back above it when there is none.
  let kindsEl = null;
  const kindsBar = () => (kindsEl ??= $('studio-kinds'));
  // (0.6.148) The Bobine (ex-Montage, public/montage.mjs): a page of its own beside the Studio, which
  // holds it here because it creates its takes as takes of the Studio. The page shows it (`bobine()`).
  // (0.6.151) The model the takes of the Bobine are asked to: LTX 2.5, when it is ready here.
  // (0.6.461, Bobine Pro, B04) The one of each take, chosen in its card among the models that make videos, one by family
  // (lib/tool-catalog.mjs videoModels): its workflow for a new take and for a suite, also one that lacks its files (the
  // server offers them), and the longest it makes.
  const bobineModels = () => info?.video ?? [],
    bobineModel = (verb, family = 'ltx25') => bobineModels().find(model => model.family === family)?.[verb] ?? null;
  const montage = setupMontage({
    api,
    node,
    icon,
    notice,
    project: () => project(),
    runs: () => runs,
    refresh: () => refresh(),
    ensureConversation: () => ensureConversation(),
    showTake: record => viewOutput(record, 0),
    // (0.6.169) A take carried from its « Prises » as the Sortie carries one: small, tilted, under the hand.
    dragImage: (tile, transfer, media, take, size) => dragGhost(tile, transfer, media, take, size),
    // (0.6.142) A take to create is created as a take of the Studio is: the same request, in the
    // conversation, one creation at a time. The bobine stays on screen meanwhile (`montage`).
    create: (wanted, hooks) => generate({ ...wanted, styles: [], edits: {}, montage: hooks ?? {} }),
    halt: () => stop(),
    // (0.6.175) Why a take of the Bobine cannot be created now: its « Créer » is greyed by it, and says it.
    busyWith: () => whyNot(),
    // (0.6.181) A take of a bobine followed again here (asked before a reload): which, and how far it is.
    // (0.6.182) With its step and how long it has been, as for a take the Bobine asked itself.
    followed: () =>
      working?.external && !working.chat && working.place
        ? { ...working.place, fraction: working.fraction, label: working.label, time: working.time }
        : null,
    inputOf: record => outputSource(record),
    // (0.6.151) Every take of the Bobine, new or suite, is asked to LTX 2.5 by its name when it is
    // ready here (« Oui, LTX 2.5 », 20/11): it makes the length drawn, from a fraction of a second.
    // (0.6.461) None for one this computer cannot run: the Bobine says why, and asks nothing of it.
    modelFor: (verb, family) => {
      const tool = bobineModel(verb, family);
      return tool && !tool.unavailable ? tool.id : null;
    },
    // (0.6.152) The longest it makes at once: a take longer than it is made in equal parts.
    longestFor: (verb, family) => bobineModel(verb, family)?.longest ?? null,
    videoModels: () => bobineModels(),
    // (0.6.464) Read again once a download made in the Bobine ends, or the settings closed: its list said a model missing
    // that was there. (The Studio reads them so too, when it comes on screen.)
    relist: () => load(),
    // (0.6.146) What happens in a plan, written by Moodix AI from its photos: the chat model comes
    // back first when it has left the card, as for « Enrichir le prompt »; the takes of the conversation shown
    // are named in the request, the others by their own conversation.
    // (0.6.153) Enrichir: the text of a take detailed by the chat model, as the wand of the Studio does.
    enrich: async (asked, { signal = new AbortController().signal } = {}) => {
      await releasing;
      await waitForModel(api, signal, () => {});
      return (await api('studio/enrich', { prompt: asked.prompt, verb: asked.verb }, { signal })).json();
    },
    write: async (asked, { signal } = {}) => {
      await releasing;
      await waitForModel(api, signal, () => {});
      return (await api('montages/describe', { ...asked, conversationId: conversation() }, { signal })).json();
    },
    // (0.6.162) The plan of a request written in the Bobine (« invente la suite »), asked to the chat
    // model in a request of its own, as its texts are: the bobine goes with it as the page has it.
    arrange: async (asked, { signal } = {}) => {
      await releasing;
      await waitForModel(api, signal, () => {});
      return (
        await api('montages/arrange', { project: project(), conversationId: conversation(), montage: asked.montage, request: asked.request, previous: asked.previous }, { signal })
      ).json();
    },
    // (0.6.144) What a plan would be made with and in how long: the request of a creation, asked
    // only to be told (`estimate`), of which the server keeps nothing. No conversation is made for
    // it: the takes of the conversation shown are named in it, the others by their own.
    estimate: async wanted =>
      (
        await api('tools/action', {
          conversationId: conversation() ?? globalThis.crypto.randomUUID(),
          project: project(),
          studio: true,
          name: wanted.verb,
          arguments: wanted.args,
          ...(wanted.size ? { size: wanted.size } : {}),
          estimate: true,
        })
      ).json(),
    // (0.6.452) The microphone of the dictation in the field of the Arrangeur.
    dictation,
  });
  // The setting Moodix AI is changing wears a ring, those it has set a fine trace, while it works.
  // Once it has stopped, nothing is framed any more. (0.6.92: no mark on the settings it may change
  // any more; there would be one on almost every setting.)
  function aiTarget(element, key) {
    element.dataset.ai = key;
    if (ai?.active === key) element.setAttribute('data-ai-active', '');
    if (ai?.touched.has(key)) element.setAttribute('data-ai-touched', '');
    return element;
  }
  function field(label, control, { help, tip, side = '', wide = false } = {}) {
    const wrapper = node('label', 'studio-field' + (wide ? ' is-wide' : '')),
      title = node('span', 'studio-label', label);
    // « ? » at the right of the name: its help at once under the pointer or on focus, as in the
    // settings (public/help-tips.mjs). A click on it does not go to the field.
    if (tip) {
      const ask = node('span', 'help-tip studio-tip', '?');
      ask.tabIndex = 0;
      ask.setAttribute('role', 'img');
      ask.setAttribute('aria-label', 'Aide : ' + tip);
      ask.dataset.help = tip;
      // (0.6.205) `side`: beside the window it is in, where above its « ? » it covered the name of the window.
      if (side) ask.dataset.tipSide = side;
      ask.onclick = event => event.preventDefault();
      title.append(ask);
    }
    wrapper.append(title, control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  function select(choices, value, onchange) {
    const control = node('select');
    for (const [key, text] of choices) control.add(new Option(text, String(key)));
    control.value = String(value);
    control.onchange = () => onchange(control.value);
    return control;
  }
  function textarea(value, rows, placeholder, oninput) {
    const control = node('textarea');
    control.rows = rows;
    control.value = value;
    control.placeholder = placeholder;
    control.oninput = () => oninput(control.value);
    return control;
  }

  // ------------------------------------------------------------------ inputs (images)
  function exclusiveWith(workflow, role) {
    // The other inputs this one cannot be combined with, when one of them is filled.
    const groups = workflow.exclusive ?? [],
      own = groups.find(group => group.includes(role));
    if (!own) return [];
    // Only the inputs this request sends: a start image chosen for a new clip is not part of
    // its continuation.
    return groups
      .filter(group => group !== own)
      .flat()
      .filter(other => workflow.roles[other]?.count && drafts[mode].inputs[other]?.some(Boolean));
  }
  async function fill(role, index, file, media = 'image') {
    if (!file) return;
    if (media === 'video' && !VIDEO_TYPES.includes(file.type))
      return notice('Cette case attend une vidéo MP4 ou WebM.');
    if (media === 'image' && VIDEO_TYPES.includes(file.type))
      return notice('Cette case attend une image, pas une vidéo.');
    const epoch = draftsEpoch,
      asked = mode;
    // Kept as a reference of the project (« #ref3 »), shared with its chats.
    const imported = await assets.importFiles([file], { project: project() });
    if (!imported.length)
      return notice(
        (media === 'video' ? 'Vidéo non importée' : 'Image non importée') +
          ' : la bibliothèque est occupée ou le fichier est illisible.',
      );
    // Its copy took a moment (a clip): another conversation or another mode is shown by now, or
    // Moodix AI proposes there. The slot of that name on the page is no longer the one it was given
    // to (a clip dropped on « Vidéo à suivre » became the image to modify of Image): not placed.
    if (epoch !== draftsEpoch || asked !== mode || answering())
      return notice(
        (media === 'video' ? 'Vidéo gardée' : 'Image gardée') +
          ' dans les références du projet, mais pas placée : ' +
          (epoch === draftsEpoch && asked === mode
            ? 'Moodix AI propose une création ici.'
            : 'la conversation ou le mode a changé entre-temps. Déposez-la de nouveau dans sa case.'),
      );
    const [resource] = imported;
    (drafts[mode].inputs[role] ??= [])[index] = {
      source: { resource: resource.id },
      preview: resource.previewUrl || resource.originalUrl,
      name: `${resource.label} · ${resource.name}`,
      width: resource.width,
      height: resource.height,
    };
    // (0.6.188) What was said of the creation before it is no longer true (« Ajoutez l’image de début. »): gone,
    // as when a take is put there (putCreation). It stayed under « Générer », lit again.
    failure = '';
    followFormat(role);
    render();
  }
  /** A video takes the format of the image it starts from, unless the user chose one. */
  function followFormat(role) {
    const draft = drafts[mode],
      image = draft.inputs[role]?.[0];
    if (mode !== 'video' || role !== 'start_image' || !image?.width || draft.formatChosen) return;
    const format = formatOf(image.width, image.height);
    if (format) Object.assign(draft, { format: format.id, size: null });
  }
  // The take the pointer of Moodix AI carries: { id, role, index, preview, over } (over: above its case).
  let aiCarry = null;
  // While Moodix AI sets the Studio, the whole Studio is locked (16/11): no click, no key, no drop
  // reaches it (inert), and nothing stops the pointer. It is the user's again when the pointer rests
  // on « Générer » (settings, « Refuser », « Générer »), or when the proposal goes.
  let aiWorking = false;
  // The last picture of a take in progress: veiled on the screen when the card stays held (54).
  let seenPreview = '';
  // « GPU libéré. Le modèle peut redémarrer. » in place of the step, until then (54).
  let freedUntil = 0;
  function lockStudio(on) {
    const changed = aiWorking !== on;
    aiWorking = on;
    const view = $('studio-view');
    if (view) view.inert = on;
    // The page holds its places too meanwhile (0.6.81): the pointer sets the Studio on screen.
    if (changed) onLock(on);
  }
  // The slot an image is being dragged from: dropped on another, the image changes role.
  let dragged = null,
    // A creation of the Sortie dragged to a slot: it becomes that input.
    carried = null;
  /**
   * While something is carried, the slots that take it light up and say their name (moodix.css;
   * studio-maquette.md, « Glisser ») : `media`, what is carried, or null once it is dropped.
   */
  function carrying(media) {
    const desk = globalThis.document?.querySelector?.('#studio-view .studio-desk');
    if (media) desk?.setAttribute?.('data-carrying', media);
    else desk?.removeAttribute?.('data-carrying');
  }
  /** The file of the computer for a slot: what a click on it opens, empty or filled. */
  function openPicker(role, index, media) {
    picker.accept = (media === 'video' ? VIDEO_TYPES : IMAGE_TYPES).join(',');
    picker.onchange = () => {
      const [file] = picker.files;
      picker.value = '';
      void fill(role, index, file, media);
    };
    picker.click();
  }
  // The model each mode showed last: another one, and the blocks of the images say so for a
  // moment (moodix-design.md 21).
  const shownModel = {};
  // « Enregistrer »: the modes whose model showed its saved settings already, what each model
  // showed first (compared with, until it is saved), the floppy disk drawn, and the last saving.
  const presetShown = {},
    baselines = {};
  let saveButton = null,
    savedJust = null;
  let flashUntil = 0,
    flashTimer = null,
    // The line from the start to the end: its colour and its figure follow the duration bar.
    span = null;
  /**
   * The role of the verb an input of the workflow takes, from the name of its slot in the family
   * (« msr_image », « reference_image » → « reference »): said by the workflow (`inputs`), else read
   * from the name. The server names the roles an image of a proposal may take by those slots.
   */
  function roleOfSlot(workflow, name) {
    const named = workflow?.inputs?.[name] ?? (name in (workflow?.roles ?? {}) ? name : String(name).replace(/_image$/, ''));
    return named === 'msr' ? 'reference' : named;
  }
  /**
   * Moves an image to another slot; the two swap when that slot is taken. Refused, with the
   * reason, when the inputs would no longer combine (MiniMax: references, or start and end).
   */
  function move(workflow, from, to) {
    const draft = drafts[mode],
      image = draft.inputs[from.role]?.[from.index];
    if (!image || (from.role === to.role && from.index === to.index)) return;
    const other = draft.inputs[to.role]?.[to.index] ?? null;
    (draft.inputs[to.role] ??= [])[to.index] = image;
    draft.inputs[from.role][from.index] = other;
    const clash = [...exclusiveWith(workflow, to.role), ...(other ? exclusiveWith(workflow, from.role) : [])];
    // An input of a proposal takes only the roles its workflow offers it, while that proposal waits
    // (answered, its images are the user's: releaseInputs). The server lists those roles by the
    // names of the slots (« msr_image »), a case here is named by the role of the verb (« reference »).
    const offeredRoles = proposal?.mode === mode ? proposal.values?.roleChoices : null;
    const refused =
      Boolean(offeredRoles) &&
      [image, other].some(
        item =>
          item?.ref !== undefined &&
          !(offeredRoles[item.ref] ?? []).some(
            choice => roleOfSlot(workflow, choice.role) === (item === image ? to.role : from.role),
          ),
      );
    if (clash.length || refused) {
      draft.inputs[to.role][to.index] = other;
      draft.inputs[from.role][from.index] = image;
      failure = refused
        ? `${ROLES[to.role]} : ce rôle n’est pas possible pour cette image avec ce modèle.`
        : `${ROLES[to.role]} ne se combine pas avec : ${[...new Set(clash)].map(role => ROLES[role]).join(', ')}.`;
    } else {
      failure = '';
      followFormat(to.role);
    }
    render();
  }
  /**
   * One piece of the plateau (moodix-design.md 13; 0.6.201, capture 93): its case, dashed while empty, with
   * its picto (« @ » for a subject); given, its picture, the picto kept small in a badge (« @1 »); and under
   * it its word (`word`: « Début », « Sujet »), the whole name in its tooltip and for screen readers. A click
   * picks a file; a file dropped on it, or the image of another case (that changes its role); × takes it back.
   */
  function slot(workflow, role, index, { label, add, tip, word = WORDS[role] ?? label, picto = null, badge = '', onRemove = null, media = 'image', off = '' }) {
    const draft = drafts[mode],
      value = draft.inputs[role]?.[index],
      // (0.6.202) `off`: a piece given that the model in hand does not take, and why (offPieces). Greyed, kept:
      // it is no case of this model, so nothing is dropped on it.
      clash = exclusiveWith(workflow, role),
      refused = clash.length ? `Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}` : '',
      // The inputs of a proposal are those Moodix AI chose: they change role, not image.
      chosenByAi = answering(),
      // The case the pointer of Moodix AI brings its take to: grown, the take shown in it.
      aiOver = Boolean(aiCarry?.over && aiCarry.role === role && aiCarry.index === index),
      tile = node(
        'div',
        'studio-slot' + (value ? ' is-filled' : '') + (refused ? ' is-blocked' : '') + (off ? ' is-off' : '') + (aiOver ? ' is-target' : ''),
      );
    tile.dataset.slot = role + '-' + index;
    if (aiOver && aiCarry.preview) tile.style.setProperty?.('--carried', `url("${aiCarry.preview}")`);
    const pick = button('studio-slot-pick', '', () => {
      // (0.6.202) Kept for a model that takes it: a click says so, as its tooltip does.
      if (off) return notice(off);
      // An input that does not combine with those given says why. It still takes the image of
      // one of them, dragged here: that is how a role is changed.
      if (refused) return notice(refused);
      // (0.6.204, capture 97) A piece given opens its small window, hung under it: what is set with it, and at
      // its foot « Changer… » (the files of the computer, which this click opened before) and « Retirer ».
      if (value) return toggleWindow(role, index);
      if (chosenByAi) return notice(AI_INPUTS);
      // Empty: a file of the computer (16/11: « Créations du projet » is gone from here; a take of the
      // project is dragged to it from the Sortie).
      openPicker(role, index, media);
    });
    // (0.6.204) Whether its window is the one open (pieceOpen).
    const opened = Boolean(value && !off && !refused && pieceOpen?.role === role && pieceOpen.index === index);
    if (value && !off && !refused) {
      pick.setAttribute('aria-haspopup', 'dialog');
      pick.setAttribute('aria-expanded', String(opened));
    }
    // Named for the hand that carries something here (moodix.css): « FIN », « SUJET 2 », « CHANGER ».
    // (0.6.187) « Changer », no longer « Remplacer »: in 12 px, as every word that names a piece now, the
    // longer word went past its case of 52 px, cut by the column under « Fin » (« REMPLACEI ») and over
    // the name of the case beside a reference (measured in the page on 21/11).
    // (0.6.202) A piece the model does not take has no name for that hand: it lights up for nothing carried.
    if (!off) {
      tile.dataset.media = media;
      tile.dataset.name = value ? 'Changer' : (SHORT[role] ?? label) + (role === 'reference' ? ' ' + (index + 1) : '');
    }
    // (0.6.190) « Sujet 1 · glissez-le » (le sujet); the image or the video of the other cases, « glissez-la ».
    pick.title = off || refused || (value ? label + (role === 'reference' ? ' · glissez-le' : ' · glissez-la') + ' vers un autre emplacement pour changer son rôle' : tip);
    pick.setAttribute('aria-label', off ? off : value ? label + ' · ' + value.name : refused ? label + ' · ' + refused : add);
    pick.disabled = locked();
    if (refused || off) pick.setAttribute('aria-disabled', 'true');
    if (value) {
      const preview = node('img');
      preview.src = value.preview || '';
      preview.alt = value.name;
      // The tile is what is dragged, not the picture as a file of the browser.
      preview.draggable = false;
      if (value.preview) pick.append(preview);
      else pick.append(icon('image'));
      // What the image is, small, at the bottom left of it.
      const mark = node('span', 'studio-slot-badge' + (badge ? ' is-text' : ''), badge);
      mark.setAttribute('aria-hidden', 'true');
      if (!badge && picto) mark.append(icon(picto));
      pick.append(mark);
      pick.draggable = !locked();
      pick.ondragstart = event => {
        dragged = { role, index, media, preview: value.preview };
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', label);
        dragGhost(pick, event.dataTransfer, media);
        tile.classList.add('is-dragged');
        carrying(media);
      };
      pick.ondragend = () => {
        dragged = null;
        tile.classList.remove('is-dragged');
        carrying(null);
      };
    } else if (picto) pick.append(icon(picto));
    else {
      const at = node('span', 'studio-slot-at', '@');
      at.setAttribute('aria-hidden', 'true');
      pick.append(at);
    }
    // The whole tile takes a drop: a file from the computer, or the image of another slot.
    tile.ondragover = event => {
      event.preventDefault();
      if (dragged) event.dataTransfer.dropEffect = 'move';
      else if (carried) event.dataTransfer.dropEffect = 'copy';
      tile.classList.add('is-target');
      // It shows what would come in it (studio-maquette.md, « Glisser »).
      const coming = dragged?.preview || (carried && (carried.outputs?.[0]?.thumbUrl || carried.outputs?.[0]?.originalUrl));
      if (coming) tile.style.setProperty?.('--carried', `url("${coming}")`);
    };
    tile.ondragleave = () => {
      tile.classList.remove('is-target');
      tile.style.removeProperty?.('--carried');
    };
    tile.ondrop = event => {
      event.preventDefault();
      event.stopPropagation();
      tile.classList.remove('is-target');
      carrying(null);
      if (locked()) return;
      if (dragged) {
        const from = dragged;
        dragged = null;
        // A video stays a video: it does not take the place of an image, nor an image its own.
        if (from.media !== media) return notice('Une vidéo et une image n’échangent pas leurs cases.');
        return move(workflow, from, { role, index });
      }
      if (refused) return notice(refused);
      if (chosenByAi) return;
      // A creation of the Sortie: a video in a slot of a video, an image in one of an image.
      if (carried) {
        const record = carried;
        carried = null;
        if (mediaOf(record) !== media)
          return notice(media === 'video' ? 'Cette case attend une vidéo.' : 'Cette case attend une image.');
        return putCreation(record, role, index);
      }
      void fill(role, index, event.dataTransfer.files[0], media);
    };
    // (0.6.202) Nothing is dropped on a piece the model does not take: a file carried over it goes where one
    // dropped beside the cases goes (the column: its first free case).
    if (off) tile.ondragover = tile.ondragleave = tile.ondrop = null;
    tile.append(pick);
    // Taken back by its ×, and (0.6.204) by « Retirer » in its window: its window goes with it.
    const takeBack = () => {
      if (opened) pieceOpen = null;
      if (onRemove) return onRemove();
      draft.inputs[role][index] = null;
      render();
    };
    if (value && !chosenByAi) {
      const remove = button('studio-slot-remove', '', takeBack, 'close');
      remove.setAttribute('aria-label', 'Retirer ' + label);
      remove.title = 'Retirer';
      tile.append(remove);
    }
    // (0.6.201) Its word under it, for the eye: its button says its whole name aloud. While something it takes
    // is carried, the name of its case (`data-name`, « CHANGER ») stands in its place (moodix.css).
    const piece = node('div', 'studio-piece' + (value ? '' : ' is-empty') + (off ? ' is-off' : '') + (opened ? ' is-open' : '')),
      said = node('span', 'studio-piece-word', word);
    said.setAttribute('aria-hidden', 'true');
    piece.append(tile, said);
    if (opened) {
      const pane = pieceWindow(workflow, { role, index, label, media, value, takeBack: chosenByAi ? null : takeBack, held: chosenByAi ? AI_INPUTS : '' }),
        focus = pieceFocus;
      pieceFocus = false;
      piece.append(pane);
      // Shown once it is on the page, above it (as « ··· »); opened by a click, the focus goes into it: its
      // first field, else its first button.
      globalThis.queueMicrotask?.(() => {
        if (!pane.isConnected || !pieceOpen) return;
        openPopup(pane, pick, { align: 'start' });
        if (focus) (pane.querySelector?.('input, select, textarea') ?? pane.querySelector?.('button:enabled'))?.focus?.();
      });
    }
    return piece;
  }
  /** (0.6.204) A click on a piece given: its window opened, closed if it was the one open. One at a time. */
  function toggleWindow(role, index) {
    const same = pieceOpen?.role === role && pieceOpen.index === index;
    pieceOpen = same ? null : { role, index };
    pieceFocus = !same;
    addOpen = cameraMenu = false;
    if (pieceOpen) advanced = false;
    render();
  }
  /**
   * (0.6.204) What a piece given is, in a few signs, at the foot of its window: a take by its number and its
   * length (« PRISE 5 · 06.71 S », « PRISE 1 · IMAGE »; « VIDÉO » for a clip whose length is not known), a file
   * by its name (« #ref2 · visage.png »).
   */
  function saidOf(value) {
    const record = value.source?.output ? runs.find(item => item.id === value.source.output) : null;
    return record ? saidOfRecord(record) : value.name;
  }
  /**
   * (0.6.204) What is set with one piece alone, the lines of its window: who is who, for a character put in a
   * video (« Qui remplacer » with the video to follow, « Qui dessiner » with the character, WHO). In a block
   * of their own under the plateau before, whatever was given; Moodix AI aims at them as before (`data-ai`).
   */
  function windowLines(workflow, role) {
    const store = (drafts[mode].settings[workflow.id] ??= {});
    const who = workflow.settings
      .filter(setting => WHO[setting.key]?.piece === role && setting.type === 'string')
      .map(setting => {
        const control = node('input');
        control.type = 'text';
        control.value = String(store[setting.key] ?? setting.default ?? '');
        control.placeholder = WHO[setting.key].hint;
        control.spellcheck = false;
        if (setting.maxLength) control.maxLength = setting.maxLength;
        control.disabled = locked();
        control.oninput = () => {
          store[setting.key] = control.value;
        };
        aiTarget(control, 'setting-' + setting.key);
        return field(settingName(setting.key), control, { tip: WHO[setting.key].help, side: 'right' });
      });
    // (0.6.205) Then what the engine reads with this piece alone, each on its bar or in its field (rareLines).
    return [...who, ...rareLines(workflow, { piece: role })];
  }
  /**
   * (0.6.204, capture 97) The small window of a piece given, one of our lists of glass hung under its case: its
   * whole name, what is set with it (windowLines), and at its foot what it is (saidOf), « Changer… » and
   * « Retirer ». Under a proposal of Moodix AI its images are its own: « Changer… » greyed with that reason
   * (`held`), no « Retirer » (`takeBack` null), as its case has no ×.
   */
  function pieceWindow(workflow, { role, index, label, media, value, takeBack, held, said = saidOf(value), about = '', change = true, foot: last = null }) {
    const pane = node('div', 'glass-menu studio-piece-window'),
      foot = node('div', 'studio-window-foot');
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', label);
    pane.hidden = true;
    foot.append(node('span', 'studio-window-said', said));
    // (0.6.207) Not for the clip of a continuation (`change` false): no file is chosen for it.
    if (change) {
      const other = button('studio-window-button', 'Changer…', () => {
        closeWindow();
        openPicker(role, index, media);
      });
      // (Its word says what it does: a tooltip only for why it cannot be pressed.)
      if (held) other.title = held;
      other.disabled = Boolean(held);
      foot.append(other);
    }
    // (0.6.207) `foot`: the one way out of a continuation, « Retirer », or « Nouvelle vidéo » under a proposal.
    if (last) {
      const way = button('studio-window-button', last.text, last.run);
      if (last.title) way.title = last.title;
      foot.append(way);
    } else if (takeBack) foot.append(button('studio-window-button', 'Retirer', takeBack));
    pane.append(node('p', 'studio-window-title', label));
    // (0.6.207) `about`: what a continuation continues, in the words of its banner of before.
    if (about) pane.append(node('p', 'studio-window-about', about));
    pane.append(...windowLines(workflow, role), foot);
    return pane;
  }
  /** Whether the workflow takes images in this role. */
  const takesImages = (workflow, role) =>
    Boolean(workflow.roles?.[role]?.count && workflow.roles[role].media.includes('image'));
  /** Whether the workflow takes a video in this role (the one a character is replaced in). */
  const takesVideo = (workflow, role) =>
    Boolean(workflow.roles?.[role]?.count && workflow.roles[role].media.includes('video'));
  /** The length set in Réglages, written as everywhere, and its place between the model's ends. */
  function spanLength(workflow) {
    const length = lengthOf(workflow);
    if (!length) return null;
    const low = length.list[0],
      high = length.list.at(-1);
    return { text: seconds(length.value), share: high > low ? (length.value - low) / (high - low) : 1 };
  }
  /**
   * The line from the start to the end, in the colour of the duration bar: the same gradient,
   * spread so that its end is the colour of the length set; the figure in that colour too.
   */
  function paintSpan() {
    if (!span) return;
    const length = spanLength(span.workflow);
    span.time.hidden = !length;
    if (!length) return;
    span.line.style.backgroundSize = 100 / Math.max(length.share, 0.01) + '% 100%';
    span.time.textContent = length.text;
    span.time.style.color = barColour(length.share);
  }
  /** « Inverser début et fin »: the two images change places; the end stays optional. */
  function swapEnds(workflow) {
    const start = { role: 'start_image', index: 0 },
      end = { role: 'end_image', index: 0 };
    if (drafts[mode].inputs.start_image?.[0]) move(workflow, start, end);
    else if (drafts[mode].inputs.end_image?.[0]) move(workflow, end, start);
  }
  /**
   * Début et fin, the first row of the plateau: the start image at the start of a fine line of time, the
   * end image at its other end (when the model takes one), the length set in Réglages on the line: in its
   * middle, with the button that swaps them, « ⇄ 05.17 s ». (0.6.201) A row of the one block, no title.
   */
  function framesRow(workflow, off = []) {
    // (0.6.207, capture 98) A continuation: its clip in the place of the start of a new video, the length it
    // adds on the line, no « ⇄ » (his answer 3 of 21/11).
    const continued = mode === 'video' && extending ? extending : null,
      start = !continued && takesImages(workflow, 'start_image'),
      end = takesImages(workflow, 'end_image');
    if (!start && !end && !continued) return null;
    // (0.6.240) A clip whose camera is changed: the clip, then its camera; no line of time (its length stays).
    if (continued && refilming()) {
      const pair = node('div', 'studio-plateau-row studio-frames studio-refilm');
      pair.setAttribute('role', 'group');
      pair.setAttribute('aria-label', 'Vidéo à refilmer et caméra');
      pair.append(prolongPiece(workflow, continued), orbitPiece(workflow));
      return pair;
    }
    // (0.6.202, capture 96) The end (or the start) given that this model does not take keeps its end of the
    // line, greyed.
    const kept = role => off.find(piece => piece.role === role && piece.index === 0);
    const row = node('div', 'studio-plateau-row studio-frames'),
      middle = node('div', 'studio-span' + (start && end ? ' is-both' : '')),
      line = node('span', 'studio-span-line'),
      time = node('span', 'studio-span-time');
    row.setAttribute('role', 'group');
    row.setAttribute(
      'aria-label',
      continued ? (end ? 'Vidéo à prolonger et fin' : 'Vidéo à prolonger') : start && end ? 'Début et fin' : start ? 'Image de début' : 'Image de fin',
    );
    line.setAttribute('aria-hidden', 'true');
    middle.append(line);
    if (start && end) {
      const swap = button('studio-swap', '', () => swapEnds(workflow), 'swap');
      swap.setAttribute('aria-label', 'Inverser début et fin');
      swap.title = 'Inverser début et fin';
      swap.disabled = locked();
      swap.append(time);
      middle.append(swap);
    } else middle.append(time);
    if (continued) row.append(prolongPiece(workflow, continued));
    else if (start)
      row.append(
        slot(workflow, 'start_image', 0, {
          label: ROLES.start_image,
          add: ADD.start_image,
          tip: ROLES.start_image + ' · glisser, coller ou cliquer',
          picto: PICTO.start_image,
        }),
      );
    else if (kept('start_image')) row.append(offPiece(workflow, kept('start_image')));
    row.append(middle);
    if (end)
      row.append(
        slot(workflow, 'end_image', 0, {
          label: ROLES.end_image,
          add: ADD.end_image,
          tip: ROLES.end_image + (start ? ' (facultatif)' : '') + ' · glisser, coller ou cliquer',
          picto: PICTO.end_image,
        }),
      );
    else if (kept('end_image')) row.append(offPiece(workflow, kept('end_image')));
    span = { line, time, workflow };
    paintSpan();
    return row;
  }
  /** (0.6.207) What a creation is, in a few signs: a take by its number and its length, a file by its name. */
  function saidOfRecord(record) {
    const take = record.outputs?.[0]?.take,
      media = mediaOf(record),
      length = media === 'video' ? lengthOfRecord(record, false) : null;
    if (!Number.isInteger(take) && !runs.some(item => item.id === record.id)) return record.name || { video: 'Vidéo', image: 'Image' }[media] || 'Son';
    return 'PRISE ' + (Number.isInteger(take) ? take : numberOf(record)) + ' · ' + (length ? figures(length) : { video: 'VIDÉO', image: 'IMAGE' }[media] ?? 'SON');
  }
  /**
   * (0.6.207, captures 98 and 98b; his answers 3 and 4 of 21/11) The clip a continuation goes on from, the first
   * piece of its plateau, « À prolonger », in the place of the start of a new video: its picture, its word; a
   * click opens its window (what it continues, what is read with it, « Retirer »), × leaves the continuation.
   * A banner above the prompt before (« Suite de la prise 5 : … », « Annuler »). It is the `source` of its
   * model: nothing is dropped on it, and no file is chosen for it (a continuation begins on a take).
   */
  function prolongPiece(workflow, record) {
    const output = record.outputs?.[0] ?? {},
      // (0.6.240) The same piece for a clip whose camera is changed: « À refilmer ».
      refilmed = refilming(),
      said = (refilmed ? WORDS.refilm : WORDS.prolong) + ' · ' + saidOfRecord(record),
      byAi = answering(),
      opened = pieceOpen?.role === 'source' && pieceOpen.index === 0,
      tile = node('div', 'studio-slot is-filled'),
      pick = button('studio-slot-pick', '', () => toggleWindow('source', 0)),
      preview = node('img'),
      mark = node('span', 'studio-slot-badge'),
      piece = node('div', 'studio-piece studio-prolong' + (opened ? ' is-open' : '')),
      word = node('span', 'studio-piece-word', refilmed ? WORDS.refilm : WORDS.prolong),
      // Left by its × and by « Retirer »: a new video, as « Annuler » of the banner did.
      leave = () => {
        extending = null;
        // (0.6.322) Nor filmed again any more: left by its × on « Changer la caméra », a continuation of the same
        // clip followed from the Chat afterwards was shown « À refilmer ».
        refilmId = null;
        pieceOpen = null;
        render();
      };
    tile.dataset.slot = 'source-0';
    pick.title = said;
    pick.setAttribute('aria-label', said);
    pick.setAttribute('aria-haspopup', 'dialog');
    pick.setAttribute('aria-expanded', String(opened));
    pick.disabled = locked();
    // (0.6.261) Tested before it is given, as in finishPiece: an empty `src` reads as the address of the page.
    const seen = output.thumbUrl || output.originalUrl || '';
    if (seen) preview.src = seen;
    preview.alt = '';
    preview.draggable = false;
    mark.setAttribute('aria-hidden', 'true');
    mark.append(icon(refilmed ? 'camera' : 'forward'));
    pick.append(seen ? preview : icon('video'), mark);
    tile.append(pick);
    if (!byAi) {
      const remove = button('studio-slot-remove', '', leave, 'close');
      remove.setAttribute('aria-label', refilmed ? 'Retirer la vidéo à refilmer' : 'Retirer la vidéo à prolonger');
      remove.title = 'Retirer';
      tile.append(remove);
    }
    word.setAttribute('aria-hidden', 'true');
    piece.append(tile, word);
    if (opened) {
      // (0.6.198) The clip by the number of its take, as the Bobine says it; a clip of the disk, « la vidéo ».
      const take = output.take,
        what = (record.prompt || record.name || '').slice(0, 90),
        pane = pieceWindow(workflow, {
          role: 'source',
          index: 0,
          label: refilmed ? WORDS.refilm : 'À prolonger',
          media: 'video',
          said: saidOfRecord(record),
          about: (refilmed ? 'Caméra changée de ' : 'Suite de ') + (Number.isInteger(take) ? 'la prise ' + take : 'la vidéo') + (what ? ' : ' + what : ''),
          change: false,
          // (0.6.113) A continuation Moodix AI proposes that the user did not ask for (« modifie cette prise, je
          // veux un dézoom lent », 19/11): no way out of it but « Refuser », which said nothing of what it
          // leaves. Refused from here, its prompt and its images stay for a new video, whose format and size
          // are the user's to set again.
          foot: byAi
            ? { text: 'Nouvelle vidéo', title: 'Refuser cette suite et garder son prompt et ses images pour une nouvelle vidéo', run: () => decline() }
            : { text: 'Retirer', run: leave },
        }),
        focus = pieceFocus;
      pieceFocus = false;
      piece.append(pane);
      globalThis.queueMicrotask?.(() => {
        if (!pane.isConnected || !pieceOpen) return;
        openPopup(pane, pick, { align: 'start' });
        if (focus) (pane.querySelector?.('input, select, textarea') ?? pane.querySelector?.('button:enabled'))?.focus?.();
      });
    }
    return piece;
  }
  /**
   * (0.6.256, captures A04 and B08) The take of the page Agrandir or Interpoler, the one piece of its plateau: its
   * picture in its case, the sign of the action on it, its word (« À agrandir »), × to leave the page. A click on it
   * shows it whole, as a take of the Sortie. Nothing is dropped on it: the page is opened from the take itself.
   */
  function finishPiece(finish) {
    const { record, verb } = finish,
      output = record.outputs?.[0] ?? {},
      said = FINISH[verb].word + ' · ' + saidOfRecord(record),
      column = node('div', 'studio-inputs'),
      plateau = node('div', 'studio-input-block studio-plateau'),
      line = node('div', 'studio-plateau-row'),
      piece = node('div', 'studio-piece studio-finish'),
      tile = node('div', 'studio-slot is-filled'),
      pick = button('studio-slot-pick', '', () => showDetails(record)),
      preview = node('img'),
      mark = node('span', 'studio-slot-badge'),
      word = node('span', 'studio-piece-word', FINISH[verb].word),
      leave = button('studio-slot-remove', '', () => leaveFinish(), 'close');
    tile.dataset.slot = 'source-0';
    pick.title = said;
    pick.setAttribute('aria-label', said);
    pick.disabled = locked();
    // (0.6.261) Its address tested before it is given: an empty `src` reads as the address of the page, and a clip
    // without its miniature showed a broken image in place of the sign of a clip.
    const seen = output.thumbUrl || (mediaOf(record) === 'image' ? output.originalUrl : '') || '';
    if (seen) preview.src = seen;
    preview.alt = '';
    preview.draggable = false;
    mark.setAttribute('aria-hidden', 'true');
    mark.append(icon(FINISH[verb].glyph));
    pick.append(seen ? preview : icon(mediaOf(record) === 'video' ? 'video' : 'image'), mark);
    leave.setAttribute('aria-label', verb === 'upscale' ? 'Ne plus agrandir cette prise' : 'Ne plus interpoler cette prise');
    leave.title = 'Retirer';
    leave.disabled = locked();
    tile.append(pick, leave);
    word.setAttribute('aria-hidden', 'true');
    piece.append(tile, word);
    line.append(piece);
    plateau.append(line);
    column.append(plateau);
    return column;
  }
  /**
   * (0.6.256, capture A04) The factor of the model of the page Agrandir or Interpoler, and what it makes: « Taille »
   * × 2 · × 4 with the size it gives under it (SeedVR2), or the factor the model has alone (Real-ESRGAN, its name
   * says it); « Images » × 2 · × 4 and the images a second it gives (RIFE). When nothing says it: the size is the
   * model's. Never another setting: those are in its page of Paramètres › Modèles.
   */
  function finishBlock(workflow, finish) {
    const spec = workflow.finish ?? {},
      upscale = finish.verb === 'upscale',
      block = node('div', 'studio-set-block studio-finish-size'),
      head = node('div', 'studio-finish-line'),
      result = node('p', 'studio-finish-result'),
      factor = spec.key ? finishFactor(workflow) : spec.factor,
      fps = Number(finish.record.parameters?.fps) || null;
    const tell = value => {
      if (!value) {
        result.textContent = upscale ? 'La taille est donnée par le modèle.' : 'Les images en plus sont données par le modèle.';
        return;
      }
      if (!upscale) {
        result.textContent = fps ? `${Math.round(fps * value)} images par seconde` : `${value} fois plus d’images`;
        return;
      }
      const made = finishSize(spec, finish.record, value);
      result.textContent = made ? `${made.width} × ${made.height}` : `${value} fois plus grande`;
    };
    // (0.6.450) A size the card of this computer cannot make (SeedVR2 beyond its memory, finishRefusal): its factor
    // greyed, why under the pointer, on a click, and under the size, where it is read without a pointer.
    const refusals = (spec.key ? spec.choices : factor ? [factor] : []).map(value => finishRefusal(workflow, finish.record, value));
    head.append(node('span', 'studio-label', FINISH[finish.verb].line));
    if (spec.key && spec.choices.length > 1) {
      const chips = node('div', 'studio-finish-chips');
      chips.setAttribute('role', 'radiogroup');
      chips.setAttribute('aria-label', FINISH[finish.verb].line);
      for (const [at, value] of spec.choices.entries()) {
        const why = refusals[at],
          chosen = value === factor && !why,
          chip = button('studio-finish-chip' + (chosen ? ' is-on' : '') + (why ? ' is-off' : ''), '× ' + value, () => {
            if (why) return notice(why);
            finishing.factor = value;
            render();
          });
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(chosen));
        chip.setAttribute('aria-label', why ? `× ${value}, indisponible. ${why}` : '× ' + value);
        if (why) {
          chip.setAttribute('aria-disabled', 'true');
          chip.title = why;
        }
        chip.disabled = locked();
        chips.append(chip);
      }
      head.append(chips);
    } else if (factor) head.append(node('span', 'studio-finish-factor', '× ' + factor));
    result.setAttribute('aria-live', 'polite');
    tell(factor);
    // The smallest of those refused: the larger ones are refused for the same reason. When none can be made, no size
    // is said as the one to come: the note names it, as the one that cannot be.
    const refused = refusals.find(Boolean);
    block.append(head, ...(refusals.every(Boolean) && refused ? [] : [result]));
    if (refused) {
      const note = node('p', 'studio-finish-note', refused);
      note.setAttribute('role', 'note');
      block.append(note);
    }
    return block;
  }
  /**
   * (0.6.211, LOTS.md, lot 14; capture 95) The camera, a piece of the plateau once added by « Ajouter »: its
   * case with its sign, its word, and under it its small window: « Mouvement » and « Vitesse », two closed
   * lists (public/camera.mjs), the English sentence the application adds after the prompt for that choice
   * (« Ajouté au prompt : »), and « Retirer ». It has no file: nothing is dropped on it nor carried from it.
   * The prompt of the Studio stays as it is written: the sentence is added where the take is made (the
   * server), and shown here so that nothing goes to the model unseen.
   * `off`: kept from a model that takes it (LTX 2.5, Wan 2.2) under one that does not: greyed, why on a
   * click, its × to take it away.
   */
  // ------------------------------------------------------------------ « Changer la caméra » d'une vidéo faite
  // (0.6.240, maquette du 22/11) The camera of a clip placed again by hand, then the clip filmed again from
  // there by a model made for it (verb `refilm_video`). The clip is the one of `extending`, whose camera is
  // changed in place of being continued (refilming); the rules of the poses are in public/camera-orbit.mjs.
  /** What the tool of the model in hand holds, and its draft, made at the first look and kept within it. */
  function orbitState(workflow) {
    const bounds = orbitBounds(workflow?.refilm),
      draft = drafts.video;
    // (The same object from one drawing to the next: its window and its guide set and read it in place.)
    draft.orbit = draft.orbit ? Object.assign(draft.orbit, orbitDraft(draft.orbit, bounds)) : orbitDraft(null, bounds);
    return { bounds, state: draft.orbit };
  }
  /**
   * Why the camera in hand is not made, '' when it is: out of what the model learnt, or too near the one of the
   * clip (public/camera-orbit.mjs). « Changer la caméra » is greyed meanwhile and says it; the server refuses
   * the same. (0.6.250) Never for a clip large or long: its size is chosen, and what is long is said, not refused.
   */
  function refilmRefusal(workflow) {
    const { bounds, state } = orbitState(workflow);
    return orbitRefusal(state, bounds);
  }
  /**
   * (0.6.250) The size the clip is filmed again at: the sizes offered for it (those of its format up to its
   * own), its length, and the one chosen, kept with the camera while the clip is the same. Another clip starts
   * from the largest this computer films again without being long (refilmStart).
   */
  function refilmChoice(workflow) {
    const { bounds, state } = orbitState(workflow),
      output = extending?.outputs?.[0] ?? {},
      made = extending?.parameters ?? {},
      seconds = clipSeconds(made),
      sizes = refilmSizes({ width: output.width ?? made.width, height: output.height ?? made.height });
    if (state.clip !== extending?.id || !sizes.some(size => sizeKey(size) === state.size)) {
      const start = refilmStart(sizes, seconds, bounds);
      state.clip = extending?.id;
      state.size = start ? sizeKey(start) : '';
    }
    return { bounds, state, sizes, seconds, size: sizes.find(size => sizeKey(size) === state.size) ?? null };
  }
  /**
   * (0.6.250) Its bar among the settings: « Résolution », then what that size costs under it. How long this
   * computer would take when it has made a change of camera before; a warning when that is long, or when it
   * never made one and the size is above the one advised. A warning only: every size is made.
   */
  function refilmBlock(workflow) {
    const choice = refilmChoice(workflow),
      { sizes, state } = choice;
    if (!sizes.length) return null;
    const block = node('div', 'studio-set-block studio-set-shape studio-refilm-size'),
      said = node('p', 'studio-refilm-said'),
      tell = () => {
        const now = refilmSaid(sizes.find(size => sizeKey(size) === state.size), sizes, choice.seconds, choice.bounds);
        said.textContent = now.text;
        said.hidden = !now.text;
        said.dataset.warn = String(now.warn);
      },
      line = barLine('Résolution', {
        key: 'refilm-size',
        count: sizes.length,
        index: Math.max(
          0,
          sizes.findIndex(size => sizeKey(size) === state.size),
        ),
        share: place => (sizes.length > 1 ? place / (sizes.length - 1) : 1),
        text: place => `${sizes[place].width} × ${sizes[place].height}`,
        onInput: place => {
          state.size = sizeKey(sizes[place]);
          tell();
        },
        notches: true,
      });
    line.title = 'La vidéo est ramenée à cette taille avant d’être refilmée. Plus grand : plus long.';
    said.setAttribute('role', 'status');
    tell();
    block.append(line, said);
    return block;
  }
  /** The camera is changed no more: a new video, as a continuation left. */
  function leaveRefilm() {
    extending = null;
    refilmId = null;
    pieceOpen = null;
    render();
  }
  /**
   * The simple guide, in the frame of the screen while the camera is set: the picture of the clip stood up in
   * space, seen from the pose in hand. It asks no model and no graphics card, and says so: it is no preview of
   * what will be made (the sides the clip never showed are the model's to invent).
   */
  function orbitGuide(workflow) {
    const { bounds, state } = orbitState(workflow),
      output = extending?.outputs?.[0] ?? {},
      box = node('div', 'studio-guide'),
      lens = node('div', 'studio-guide-lens'),
      world = node('div', 'studio-guide-world'),
      card = node('span', 'studio-guide-card'),
      warn = node('p', 'studio-guide-warn');
    if (output.thumbUrl) {
      const picture = node('img');
      picture.src = output.thumbUrl;
      picture.alt = '';
      picture.draggable = false;
      card.append(picture);
    }
    world.append(node('span', 'studio-guide-ground'), node('span', 'studio-guide-card is-back'), card);
    lens.append(world);
    box.append(lens, node('p', 'studio-guide-said', 'Guide, pas le rendu : l’image de la vidéo, vue de la caméra réglée'), warn);
    guide = { world, warn, bounds };
    paintGuide(state);
    return box;
  }
  /** The guide drawn for a pose (the one in hand unless given), with what the tool says of where it stands. */
  function paintGuide(state, pose = orbitCurrent(state)) {
    if (!guide) return;
    // (What the camera comes to as a whole, as the foot of its window says it.)
    const zone = orbitWorst(state, guide.bounds);
    guide.world.style.transition = 'none';
    guide.world.style.transform = guideTransform(pose);
    guide.warn.textContent = ORBIT_WARNS[zone];
    guide.warn.hidden = zone === 'safe';
    guide.warn.dataset.zone = zone;
  }
  /** « Aperçu »: the guide goes from the camera of the start to the one of the end, once, in three seconds. */
  function playGuide(state) {
    if (!guide || state.mode !== 'move') return;
    const { world } = guide;
    world.style.transition = 'none';
    world.style.transform = guideTransform(state.start);
    // (Read once: the start is drawn before it moves.)
    void world.offsetWidth;
    world.style.transition = 'transform 3s cubic-bezier(0.45, 0, 0.3, 1)';
    world.style.transform = guideTransform(state.end);
  }
  /**
   * The piece « Caméra » of a clip to film again, and its window: « Fixe » or « Du début à la fin », the sphere
   * (the camera is dragged on it), then Azimut, Hauteur and Distance. What it says follows in place as it is set.
   */
  function orbitPiece(workflow) {
    const { bounds, state } = orbitState(workflow),
      opened = pieceOpen?.role === 'orbit',
      tile = node('div', 'studio-slot is-filled'),
      piece = node('div', 'studio-piece studio-camera studio-orbit' + (opened ? ' is-open' : '')),
      word = node('span', 'studio-piece-word', WORDS.camera),
      said = () => WORDS.camera + ' · ' + orbitLabel(state),
      pick = button('studio-slot-pick', '', () => toggleWindow('orbit', 0), 'camera');
    pick.title = said();
    pick.setAttribute('aria-label', said());
    pick.setAttribute('aria-haspopup', 'dialog');
    pick.setAttribute('aria-expanded', String(opened));
    pick.disabled = locked();
    tile.append(pick);
    word.setAttribute('aria-hidden', 'true');
    piece.append(tile, word);
    if (!opened) return piece;
    const pane = node('div', 'glass-menu studio-piece-window studio-orbit-window'),
      modes = node('div', 'studio-camera-speeds studio-orbit-modes'),
      globe = node('div', 'studio-orbit-globe'),
      ring = node('span', 'studio-orbit-ring'),
      trail = node('span', 'studio-orbit-trail'),
      marks = {
        fixed: node('span', 'studio-orbit-mark is-fixed'),
        start: node('span', 'studio-orbit-mark is-start'),
        end: node('span', 'studio-orbit-mark is-end'),
      },
      legend = node('div', 'studio-orbit-legend'),
      ends = node('div', 'studio-orbit-ends'),
      poses = {},
      bars = {},
      told = node('span', 'studio-window-said', ''),
      play = button('studio-window-button studio-orbit-play', 'Aperçu', () => playGuide(state), 'play'),
      foot = node('div', 'studio-window-foot'),
      place = (mark, point) => {
        mark.style.left = (point.x / GLOBE.width) * 100 + '%';
        mark.style.top = (point.y / GLOBE.height) * 100 + '%';
        mark.dataset.behind = String(point.behind);
      },
      show = () => {
        const moving = state.mode === 'move',
          now = orbitCurrent(state),
          zone = orbitWorst(state, bounds);
        for (const choice of modes.children) choice.setAttribute('aria-pressed', String(choice.dataset.mode === state.mode));
        // Its two ends, when the camera moves: the one in hand is the one the bars and the pointer set.
        ends.hidden = !moving;
        for (const end of ends.children) end.setAttribute('aria-pressed', String(end.dataset.end === state.active));
        for (const key of ['start', 'end']) poses[key].textContent = poseText(state[key]);
        for (const [key, bar] of Object.entries(bars)) {
          const text = key === 'distance' ? distanceText(now[key]) : Math.round(now[key]) + '°';
          bar.input.value = String(now[key]);
          bar.input.style.setProperty?.('--fill', String((now[key] - bar.min) / (bar.max - bar.min || 1)));
          bar.input.setAttribute('aria-valuetext', text);
          bar.value.textContent = text;
        }
        // On the sphere: the camera held, or its start, its end and the path between them.
        marks.fixed.hidden = moving;
        marks.start.hidden = marks.end.hidden = trail.hidden = !moving;
        for (const key of ['fixed', 'start', 'end']) {
          place(marks[key], globePoint(state[key], bounds));
          marks[key].dataset.active = String(key === 'fixed' || state.active === key);
        }
        globeDots(state, bounds).forEach((point, at) => place(trail.children[at], point));
        play.hidden = !moving;
        // Where it stands in what the model holds: counted from the camera of the clip, less sure, or never shown.
        told.textContent = ORBIT_SAID[zone];
        told.dataset.zone = zone;
        pick.title = said();
        pick.setAttribute('aria-label', said());
        paintGuide(state);
        // « Changer la caméra » lit or greyed with it, in place.
        refilmGate?.();
      },
      // A bar moved, a camera dragged: the window stays under the hand, what it says follows in place.
      set = pose => {
        Object.assign(orbitCurrent(state), orbitPose({ ...orbitCurrent(state), ...pose }, bounds));
        show();
      },
      bar = (key, label, step, words) => {
        const line = node('div', 'studio-orbit-bar'),
          input = node('input', 'studio-bar'),
          value = node('output', 'studio-orbit-value'),
          scale = node('div', 'studio-orbit-scale');
        input.type = 'range';
        input.min = String(bounds[key].min);
        input.max = String(bounds[key].max);
        input.step = String(step);
        // What the model does not hold (its distance, for now): the bar stays, greyed, and says why.
        const off = bounds[key].unavailable || (bounds[key].min === bounds[key].max ? 'Ce modèle ne change pas ce réglage.' : '');
        input.disabled = locked() || Boolean(off);
        input.setAttribute('aria-label', label);
        input.oninput = () => set({ [key]: Number(input.value) });
        if (off) {
          line.className += ' is-off';
          line.title = scale.title = off;
          scale.className += ' is-off';
        }
        for (const mark of off ? ['Pas encore avec ce modèle'] : words) scale.append(node('span', '', mark));
        line.append(node('span', 'studio-label', label), input, value);
        bars[key] = { input, value, min: bounds[key].min, max: bounds[key].max };
        return [line, scale];
      },
      // The pointer on the sphere: the camera in hand follows it (in front of the clip; its back is set by the bar).
      drag = event => {
        const box = globe.getBoundingClientRect?.();
        if (!box?.width || !box.height) return;
        set(globePose(((event.clientX - box.left) / box.width) * GLOBE.width, ((event.clientY - box.top) / box.height) * GLOBE.height, orbitCurrent(state), bounds));
      },
      focus = pieceFocus;
    pieceFocus = false;
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', WORDS.camera);
    pane.hidden = true;
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Caméra fixe ou en mouvement');
    for (const [id, name] of [
      ['fixed', 'Fixe'],
      ['move', 'Du début à la fin'],
    ]) {
      const choice = button('studio-camera-speed', name, () => {
        state.mode = id;
        show();
        // (Its two ends make it taller: placed again, whole in the page.)
        openPopup(pane, pick, { beside: tile });
      });
      choice.dataset.mode = id;
      choice.disabled = locked();
      modes.append(choice);
    }
    globe.setAttribute('role', 'img');
    globe.setAttribute('aria-label', 'La caméra autour de la vidéo');
    // (Its colours are those of the legend under it: moodix.css names them.)
    ring.style.background = ringGradient(bounds);
    for (let at = 0; at < 13; at++) trail.append(node('i'));
    const clip = node('span', 'studio-orbit-clip');
    clip.append(icon('video'));
    marks.start.dataset.end = 'start';
    marks.end.dataset.end = 'end';
    globe.append(node('span', 'studio-orbit-sphere'), ring, clip, node('span', 'studio-orbit-face', 'face : la caméra de la vidéo'), trail, marks.start, marks.end, marks.fixed);
    globe.onpointerdown = event => {
      if (locked()) return;
      const end = event.target?.dataset?.end;
      if (end && state.mode === 'move') state.active = end;
      globe.setPointerCapture?.(event.pointerId);
      drag(event);
      globe.onpointermove = drag;
    };
    globe.onpointerup = globe.onpointercancel = () => (globe.onpointermove = null);
    for (const [zone, name] of [
      ['safe', 'sûr'],
      ['maybe', 'possible'],
      ['out', 'hors du modèle'],
    ]) {
      const item = node('span', 'studio-orbit-zone', name);
      item.dataset.zone = zone;
      legend.append(item);
    }
    for (const [key, name] of [
      // (Their words are those of the start and the end of a new video: the table of the pieces.)
      ['start', WORDS.start_image],
      ['end', WORDS.end_image],
    ]) {
      const end = button('studio-orbit-end', name, () => {
        state.active = key;
        show();
      });
      end.dataset.end = key;
      poses[key] = node('output', 'studio-orbit-pose');
      end.append(poses[key]);
      ends.append(end);
    }
    foot.append(told, play, button('studio-window-button', 'Retirer', leaveRefilm));
    pane.append(
      node('p', 'studio-window-title', WORDS.camera),
      modes,
      globe,
      legend,
      ends,
      // (Their words stand at the ends and the middle of what the model holds: a quarter turn to each side.)
      ...bar('azimuth', 'Azimut', 5, ['Gauche', 'Face', 'Droite']),
      ...bar('elevation', 'Hauteur', 1, ['Bas', 'Haut']),
      ...bar('distance', 'Distance', 0.05, ['Serré', 'Large']),
      foot,
    );
    show();
    piece.append(pane);
    globalThis.queueMicrotask?.(() => {
      if (!pane.isConnected || !pieceOpen) return;
      openPopup(pane, pick, { beside: tile });
      if (focus) modes.children[0]?.focus?.();
    });
    return piece;
  }
  /**
   * (0.6.222) Why the model in hand does not make a movement of the camera, '' when it does. A model that reads
   * the camera itself makes those of its own list; for the others the camera is a sentence of the prompt, and
   * what the words alone do not hold is not made (public/camera.mjs).
   */
  function cameraRefusal(workflow, move) {
    const own = workflow?.camera?.moves;
    return own ? (own.includes(move) ? '' : `${workflow.name} ne fait pas ce mouvement.`) : cameraOff(move);
  }
  function cameraPiece(workflow, { off = '' } = {}) {
    const draft = drafts[mode],
      // (Never open while it is kept greyed: the plateau closes its window with the model that took it, inputs.)
      opened = pieceOpen?.role === 'camera',
      tile = node('div', 'studio-slot is-filled' + (off ? ' is-off' : '')),
      piece = node('div', 'studio-piece studio-camera' + (off ? ' is-off' : '') + (opened ? ' is-open' : '')),
      word = node('span', 'studio-piece-word', WORDS.camera),
      said = () => WORDS.camera + ' · ' + cameraLabel(draft.camera),
      pick = button('studio-slot-pick', '', () => (off ? notice(off) : toggleWindow('camera', 0)), 'camera'),
      // Taken back by its ×, and by « Retirer » in its window, which goes with it.
      takeBack = () => {
        draft.camera = null;
        if (pieceOpen?.role === 'camera') pieceOpen = null;
        render();
      },
      remove = button('studio-slot-remove', '', takeBack, 'close');
    pick.title = off || said();
    pick.setAttribute('aria-label', off || said());
    if (off) pick.setAttribute('aria-disabled', 'true');
    else {
      pick.setAttribute('aria-haspopup', 'dialog');
      pick.setAttribute('aria-expanded', String(opened));
    }
    pick.disabled = locked();
    remove.setAttribute('aria-label', 'Retirer la caméra');
    remove.title = 'Retirer';
    tile.append(pick, remove);
    word.setAttribute('aria-hidden', 'true');
    piece.append(tile, word);
    if (!opened) return piece;
    const pane = node('div', 'glass-menu studio-piece-window studio-camera-window'),
      foot = node('div', 'studio-window-foot'),
      told = node('span', 'studio-window-said', ''),
      added = node('p', 'studio-camera-added'),
      sentence = node('span', 'studio-camera-sentence'),
      groups = node('div', 'studio-camera-groups'),
      pace = node('div', 'studio-camera-pace'),
      speeds = node('div', 'studio-camera-speeds'),
      cards = new Map(),
      // A movement or a speed chosen: the window stays under the hand, what it says follows in place (drawn
      // again, the scene chosen would start over and lose the focus).
      set = change => {
        draft.camera = { ...draft.camera, ...change };
        show();
      },
      show = () => {
        // The movement chosen wears the ring and plays in a loop; the others play under the pointer.
        for (const [move, card] of cards) {
          const chosen = move === draft.camera.move;
          card.className = 'studio-camera-move' + (cameraRefusal(workflow, move) ? ' is-off' : '') + (chosen ? ' is-chosen' : '');
          card.setAttribute('aria-checked', String(chosen));
        }
        // A fixed shot, a camera in the hand, one that follows its subject have no speed: its three choices
        // greyed, with why; the speed chosen before comes back with a movement that has one.
        const still = !cameraHasSpeed(draft.camera.move) || (own && !own.speed);
        speeds.title = still ? 'Ce mouvement n’a pas de vitesse.' : 'À quelle vitesse la caméra bouge.';
        for (const choice of speeds.children) {
          choice.disabled = still || locked();
          choice.setAttribute('aria-pressed', String(!still && choice.dataset.speed === draft.camera.speed));
        }
        // (The small scenes play at the speed chosen: moodix.css reads it here.)
        pane.dataset.speed = still ? 'normal' : draft.camera.speed;
        sentence.textContent = own ? '' : '« ' + cameraSentence(draft.camera) + ' »';
        told.textContent = cameraLabel(draft.camera);
        pick.title = said();
        pick.setAttribute('aria-label', said());
      },
      focus = pieceFocus,
      // (0.6.222) A model that reads the camera itself: its own movements, the others greyed « indisponible ».
      own = workflow?.camera?.moves ? workflow.camera : null,
      noted = own ? 'indisponible' : CAMERA_OFF_NOTE;
    pieceFocus = false;
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', WORDS.camera);
    pane.hidden = true;
    // (0.6.215, maquette du 22/11) In place of the list of movements, a small scene for each, by family: it
    // shows what the camera does (moodix.css moves it), under the pointer and in a loop once chosen. What the
    // words alone do not hold (an orbit, a crane: the real videos of 22/11) stays there, greyed, « pas fiable »
    // under its name: seen, never chosen; the foot of the window says why.
    groups.setAttribute('role', 'radiogroup');
    groups.setAttribute('aria-label', 'Mouvement');
    for (const family of CAMERA_GROUPS) {
      const block = node('div', 'studio-camera-group'),
        row = node('div', 'studio-camera-tiles');
      block.dataset.size = String(family.moves.length);
      block.append(node('span', 'studio-camera-family', family.name), row);
      for (const move of family.moves) {
        const why = cameraRefusal(workflow, move),
          name = cameraLabel({ move }),
          card = button('studio-camera-move', '', () => (why ? notice(why) : set({ move })));
        card.dataset.move = move;
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-label', why ? `${name}, ${noted}. ${why}` : name);
        if (why) card.setAttribute('aria-disabled', 'true');
        card.append(cameraScene(move), node('span', 'studio-camera-move-name', cameraShort(move)));
        if (why) card.append(node('span', 'studio-camera-move-note', noted));
        // Under the pointer or the focus, the foot says its whole name, or why it is greyed.
        card.onpointerenter = card.onfocus = () => (told.textContent = why || name);
        card.onpointerleave = card.onblur = () => (told.textContent = cameraLabel(draft.camera));
        cards.set(move, card);
        row.append(card);
      }
      groups.append(block);
    }
    speeds.setAttribute('role', 'group');
    speeds.setAttribute('aria-label', 'Vitesse');
    for (const speed of CAMERA_SPEEDS) {
      const choice = button('studio-camera-speed', speed.name, () => set({ speed: speed.id }));
      choice.dataset.speed = speed.id;
      speeds.append(choice);
    }
    aiTarget(groups, 'camera-move');
    aiTarget(speeds, 'camera-speed');
    pace.append(node('span', 'studio-label', 'Vitesse'), speeds);
    // (Said again as it changes, for a screen reader: it is what goes to the model.)
    added.setAttribute('aria-live', 'polite');
    added.append(node('span', 'studio-camera-adds', own ? 'Lue par le modèle : rien n’est ajouté au prompt.' : 'Ajouté au prompt :'), sentence);
    foot.append(told, button('studio-window-button', 'Retirer', takeBack));
    pane.append(node('p', 'studio-window-title', WORDS.camera), groups, pace, added, foot);
    show();
    piece.append(pane);
    globalThis.queueMicrotask?.(() => {
      if (!pane.isConnected || !pieceOpen) return;
      // Beside its case, whole in the page: under it, a window of that height would cover the foot of the Studio.
      openPopup(pane, pick, { beside: tile });
      // Opened by a choice or a click, the movement chosen in hand.
      if (focus) cards.get(draft.camera.move)?.focus?.();
    });
    return piece;
  }
  /**
   * (0.6.215) The small scene of a movement of the camera: a ground, a subject, marks behind it, which moodix.css
   * draws in perspective and moves as that camera does (`data-move`). Nothing a screen reader says: the case
   * that holds it names the movement.
   */
  function cameraScene(move) {
    const scene = node('span', 'camera-scene'),
      zoom = node('span', 'camera-scene-zoom'),
      lens = node('span', 'camera-scene-lens'),
      world = node('span', 'camera-scene-world'),
      subject = node('i', 'camera-scene-subject');
    scene.dataset.move = move;
    scene.setAttribute('aria-hidden', 'true');
    for (let face = 0; face < 5; face++) subject.append(node('b'));
    world.append(...['ground', 'grid', 'sun', 'post is-1', 'post is-2', 'post is-3', 'post is-4'].map(part => node('i', 'camera-scene-' + part)), subject);
    lens.append(world);
    zoom.append(lens);
    scene.append(zoom);
    return scene;
  }
  // ------------------------------------------------------------------ la caméra avant (0.6.257)
  // (camera-avant-maquette.md, captures K00 to K04, 23/11) The camera of a new video set before it is made: a block
  // of its own under the images, its ball, the name of its movement and its speed; a click on the ball opens the
  // movements in a menu at its right. It sets what will be made: the screen never changes for it. « Changer la
  // caméra » of a clip made stays at the right of the screen (the column of its actions), as it was.
  /** The width of the ball of the block (K00), in pixels. */
  const BALL_SIZE = 216;
  /** The parts of the block and of its menu drawn last, which a choice sets again in place (paintCamera). */
  let cameraParts = null;
  /** A class put on an element or taken from it, kept in `className` (the other classes left as they are). */
  function setClass(element, name, on) {
    const classes = String(element.className ?? '')
      .split(' ')
      .filter(item => item && item !== name);
    if (on) classes.push(name);
    element.className = classes.join(' ');
  }
  /**
   * (0.6.257) The camera of the block set: on with that movement, the speed it had kept (normal for the first), or
   * off (null): the model chooses, nothing is added to the prompt; the movement it had is kept for its way back.
   */
  function setCamera(value) {
    const draft = drafts.video;
    if (!value) {
      if (draft.camera) draft.cameraLast = draft.camera;
      draft.camera = null;
      return;
    }
    const speed = value.speed ?? draft.camera?.speed ?? draft.cameraLast?.speed ?? 'normal';
    draft.camera = draft.cameraLast = { move: value.move, speed };
  }
  /**
   * The ball of a movement (null: none, « Au choix du modèle »), `size` pixels wide: its drawing (public/camera-ball.mjs)
   * and the subject at its middle, the image of the start when there is one, else the sign of an image.
   */
  function ballFace(move, size, { dim = false, subject = '' } = {}) {
    const face = node('span', 'camera-ball' + (dim ? ' is-dim' : '')),
      art = node('span', 'camera-ball-svg'),
      center = node('span', 'camera-ball-subject' + (subject ? '' : ' is-picto'));
    face.setAttribute('aria-hidden', 'true');
    face.style.setProperty?.('--ball', size + 'px');
    art.innerHTML = ballSvg(move, { size, dim });
    ballDress(art);
    if (subject) {
      const picture = node('img');
      Object.assign(picture, { src: subject, alt: '', draggable: false });
      center.append(picture);
    } else center.append(icon('image'));
    face.append(art, center);
    return { face, art };
  }
  /** The three speeds, a group of the block or of its menu; greyed with why for a movement that has none. */
  function cameraSpeeds(className) {
    const speeds = node('div', 'studio-camera-speeds ' + className);
    speeds.setAttribute('role', 'group');
    speeds.setAttribute('aria-label', 'Vitesse');
    for (const speed of CAMERA_SPEEDS) {
      const choice = greyable(
        button('studio-camera-speed', speed.name, () => {
          if (choice.disabled) return notice(speeds.title);
          setCamera({ ...drafts.video.camera, speed: speed.id });
          paintCamera();
        }),
      );
      choice.dataset.speed = speed.id;
      speeds.append(choice);
    }
    return speeds;
  }
  /**
   * (0.6.257, K00 to K02) The block « Caméra », under the images, for a new video of a model where the camera is a
   * sentence of the prompt (LTX 2.5, Wan 2.2, MiniMax H3: public/camera.mjs, takesCamera): at its head its switch,
   * then its ball (the subject, the camera three quarters in front, its movement looped), the name of the movement
   * and its speed. Off, it is « Au choix du modèle »: nothing is added to the prompt; on again, the last movement
   * chosen comes back (his précision of 23/11: the camera of LTX before a video is turned on and off). It is kept in
   * the draft of the video, as the rest. `kept`: set for a model that takes it, under one that does not: greyed,
   * why, its × to take it away (as the other pieces kept, KEPT). None in a continuation, for a clip filmed again,
   * nor under a proposal of Moodix AI (its pieces are its own); none in Image and in Son (no model takes one).
   * A model that reads the camera itself (Wan 2.2 Caméra) keeps its piece « Caméra », from « Ajouter ».
   */
  function cameraBlock(workflow, { kept = false, row = false } = {}) {
    cameraParts = null;
    if (mode !== 'video' || answering() || extending || (workflow.camera !== true && !kept)) return null;
    const draft = drafts.video,
      off = kept ? `Caméra gardée : ${workflow.name} ne la prend pas.` : '',
      held = off ? '' : locked() ? whyNot() || BUSY_HERE : '';
    if (off || held) cameraMenu = false;
    // (0.6.262) `row`: pieces are kept for another model, their line under the plateau; the block on one row, its
    // ball at the left (moodix.css), so that the column does not scroll. Kept itself, it is one line (is-off).
    const block = node(
      'section',
      'studio-input-block studio-camera-block' + (off ? ' is-off' : row ? ' is-row' : '') + (cameraMenu ? ' is-open' : ''),
    ),
      head = node('div', 'camera-block-head'),
      ball = greyable(
        button('camera-block-ball', '', () => {
          if (off || held) return notice(off || held);
          toggleCameraMenu();
        }),
      ),
      subject = draft.inputs.start_image?.[0]?.preview || '',
      { face, art } = ballFace(draft.camera?.move ?? null, BALL_SIZE, { subject }),
      name = node('span', 'camera-block-name'),
      why = node('p', 'camera-block-why'),
      speeds = cameraSpeeds('camera-block-speeds');
    block.setAttribute('aria-label', WORDS.camera);
    head.append(node('span', 'camera-block-title', WORDS.camera));
    let toggle = null;
    if (off) {
      const remove = button('camera-block-remove', '', () => {
        setCamera(null);
        // (0.6.260) Taken away with the keys: the focus on « Ajouter », just above (it fell on the page).
        if (remove.matches?.(':focus-visible')) refocusTo = '.studio-add-pick';
        render();
      }, 'close');
      remove.setAttribute('aria-label', 'Retirer la caméra');
      remove.title = 'Retirer';
      head.append(remove);
    } else {
      // A switch, at the right of its name: off, the model chooses; on, the last movement chosen comes back.
      toggle = greyable(
        button('camera-block-switch', '', () => {
          if (held) return notice(held);
          setCamera(drafts.video.camera ? null : (drafts.video.cameraLast ?? CAMERA_DEFAULT));
          paintCamera();
        }),
      );
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', 'Caméra choisie');
      toggle.append(node('span', 'camera-block-knob'));
      toggle.disabled = Boolean(held);
      head.append(toggle);
    }
    face.className += ' is-playing';
    ball.append(face);
    ball.setAttribute('aria-haspopup', 'dialog');
    ball.disabled = Boolean(off || held);
    aiTarget(ball, 'camera-move');
    aiTarget(speeds, 'camera-speed');
    why.setAttribute('aria-live', 'polite');
    cameraParts = { workflow, block, toggle, ball, face, art, subject, name, why, speeds, off, held, menu: null };
    // (0.6.262) Its menu just after the ball, in the order of the page: Maj+Tab from its first control goes back to the
    // ball, Tab from its last to what follows the ball. Last of the block, Maj+Tab went to « Rapide » of the block and
    // Tab to Image, Vidéo, Son, at 1912 × 948 and 1440 × 900.
    const menu = cameraMenu ? cameraMenuPane(workflow) : null;
    block.append(head, ball, ...(menu ? [menu.pane] : []), name, why, speeds);
    if (menu) {
      cameraParts.menu = menu;
      const focus = cameraFocus;
      cameraFocus = false;
      globalThis.queueMicrotask?.(() => {
        if (!menu.pane.isConnected || !cameraMenu) return;
        placeCameraMenu(menu.pane, block, ball);
        if (focus) menu.first.focus?.();
      });
    }
    paintCamera();
    return block;
  }
  /**
   * (0.6.257, K01) The menu of the block: « Au choix du modèle » at its head, then the movements by family, each a
   * small ball with its short name (two columns: the families that move the camera at the left, the zoom and what the
   * words alone do not hold at the right), the orbits and the cranes greyed « pas fiable », why under the pointer;
   * the speed at its foot, and the sentence added to the prompt under it. Opaque, at the right of the block.
   */
  function cameraMenuPane(workflow) {
    const pane = node('div', 'glass-menu camera-menu'),
      head = node('div', 'camera-menu-head'),
      model = button('camera-menu-option is-model', '', () => {
        setCamera(null);
        paintCamera();
      }),
      cols = node('div', 'camera-menu-cols'),
      pace = node('div', 'camera-menu-pace'),
      speeds = cameraSpeeds('camera-menu-speeds'),
      added = node('p', 'camera-menu-added'),
      adds = node('span', 'camera-menu-adds'),
      sentence = node('span', 'camera-menu-sentence'),
      options = new Map(),
      refused = new Set();
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', WORDS.camera);
    pane.hidden = true;
    model.setAttribute('role', 'radio');
    model.setAttribute('aria-label', 'Au choix du modèle');
    model.title = 'Le modèle choisit le mouvement : rien n’est ajouté au prompt.';
    model.append(ballFace(null, 44).face, node('span', 'camera-menu-name', 'Au choix du modèle'));
    head.append(node('p', 'studio-window-title', WORDS.camera), model);
    cols.setAttribute('role', 'radiogroup');
    cols.setAttribute('aria-label', 'Mouvement');
    for (const [at, family] of CAMERA_GROUPS.entries()) {
      const group = node('div', 'camera-menu-group'),
        row = node('div', 'camera-menu-row');
      // (Its place is given by the styles: two columns, three in a short window, where it stays above « Générer ».)
      group.dataset.family = String(at);
      group.append(node('span', 'camera-menu-family', family.name), row);
      for (const move of family.moves) {
        const why = cameraRefusal(workflow, move),
          name = cameraLabel({ move }),
          option = button('camera-menu-option' + (why ? ' is-off' : ''), '', () => {
            if (why) return notice(why);
            setCamera({ move });
            paintCamera();
          });
        option.dataset.move = move;
        option.setAttribute('role', 'radio');
        option.setAttribute('aria-label', why ? `${name}, ${CAMERA_OFF_NOTE}. ${why}` : name);
        option.title = why || name;
        if (why) {
          option.setAttribute('aria-disabled', 'true');
          refused.add(option);
        }
        option.append(ballFace(move, 70, { dim: Boolean(why) }).face, node('span', 'camera-menu-name', cameraShort(move)));
        if (why) option.append(node('span', 'camera-menu-note', CAMERA_OFF_NOTE));
        options.set(move, option);
        row.append(option);
      }
      cols.append(group);
    }
    pace.append(node('span', 'studio-label', 'Vitesse'), speeds);
    added.setAttribute('aria-live', 'polite');
    added.append(adds, sentence);
    pane.append(head, cols, pace, added);
    // (0.6.262) « Au choix du modèle » and the movements not greyed, by the arrows (Home and End too), as our lists of
    // glass (glass-menu.mjs): only one of them in the order of Tab, the one chosen, so that Tab goes from them to the
    // speed. The four arrows did nothing: 15 Tab to reach « Fixe ». The greyed ones are passed over.
    const ring = [model, ...options.values()].filter(option => !refused.has(option)),
      rove = held => {
        for (const option of [model, ...options.values()]) option.tabIndex = option === held ? 0 : -1;
      };
    const chosen = options.get(drafts.video.camera?.move),
      first = chosen && ring.includes(chosen) ? chosen : model;
    rove(first);
    pane.addEventListener('focusin', event => {
      const option = event.target?.closest?.('.camera-menu-option');
      if (option && ring.includes(option)) rove(option);
    });
    pane.onkeydown = event => {
      // Échap closes it, the focus back on the ball (the page's own listener does the same from anywhere else).
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return closeCameraMenu({ refocus: true });
      }
      const list = ring,
        at = list.indexOf(globalThis.document?.activeElement),
        step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (at >= 0 && (step || event.key === 'Home' || event.key === 'End')) {
        event.preventDefault();
        const next = step ? list[(at + step + list.length) % list.length] : event.key === 'Home' ? list[0] : list.at(-1);
        rove(next);
        return next.focus?.();
      }
      // (0.6.262) Tab past its last control, or Maj+Tab before its first, closes it (it stayed open over Image, Vidéo,
      // Son, the focus going under it); the focus goes on where the keys take it.
      if (event.key === 'Tab') {
        const stops = [...list.filter(option => option.tabIndex === 0), ...speeds.children];
        if (globalThis.document?.activeElement === (event.shiftKey ? stops[0] : stops.at(-1))) closeCameraMenu();
      }
    };
    return { pane, model, options, speeds, adds, sentence, first };
  }
  /** What the block and its menu say, set again in place after a choice (drawn again, the focus would be lost). */
  function paintCamera() {
    const parts = cameraParts;
    if (!parts) return;
    const draft = drafts.video,
      choice = draft.camera,
      refused = choice ? cameraRefusal(parts.workflow, choice.move) : '',
      still = !choice || !cameraHasSpeed(choice.move),
      named = choice ? cameraLabel({ move: choice.move }) : 'Au choix du modèle';
    setClass(parts.block, 'is-on', Boolean(choice));
    setClass(parts.block, 'is-refused', Boolean(refused));
    if (parts.toggle) {
      parts.toggle.setAttribute('aria-checked', String(Boolean(choice)));
      parts.toggle.title = parts.held || (choice ? 'Désactiver : le modèle choisit le mouvement' : 'Activer : le dernier mouvement choisi revient');
    }
    parts.art.innerHTML = ballSvg(choice?.move ?? null, { size: BALL_SIZE, dim: Boolean(parts.off || refused) });
    ballDress(parts.art);
    setClass(parts.face, 'is-dim', Boolean(parts.off || refused));
    parts.name.textContent = named;
    const why = parts.off || refused;
    parts.why.textContent = why;
    parts.why.hidden = !why;
    parts.ball.title = parts.off || parts.held || 'Choisir le mouvement';
    parts.ball.setAttribute('aria-label', WORDS.camera + ' · ' + (choice ? cameraLabel(choice) : named));
    parts.ball.setAttribute('aria-expanded', String(Boolean(parts.menu)));
    const lists = [parts.speeds, ...(parts.menu ? [parts.menu.speeds] : [])],
      speedWhy = parts.off || parts.held || (!choice ? 'Choisissez d’abord un mouvement.' : still ? 'Ce mouvement n’a pas de vitesse.' : '');
    for (const speeds of lists) {
      speeds.title = speedWhy || 'À quelle vitesse la caméra bouge.';
      for (const item of speeds.children) {
        item.disabled = Boolean(speedWhy);
        item.setAttribute('aria-pressed', String(!speedWhy && item.dataset.speed === choice.speed));
      }
    }
    const menu = parts.menu;
    if (!menu) return;
    for (const [move, option] of menu.options) {
      setClass(option, 'is-chosen', choice?.move === move);
      option.setAttribute('aria-checked', String(choice?.move === move));
    }
    setClass(menu.model, 'is-chosen', !choice);
    menu.model.setAttribute('aria-checked', String(!choice));
    menu.adds.textContent = choice ? 'Ajouté au prompt :' : 'Rien n’est ajouté au prompt : le modèle choisit le mouvement.';
    menu.sentence.textContent = choice ? '« ' + cameraSentence(choice) + ' »' : '';
  }
  /** The menu of the block opened, or closed when it was open; one thing open at a time. */
  function toggleCameraMenu() {
    // (0.6.262) Open: closed in place, the focus kept on the ball (the Studio drawn again, it fell on the page after a
    // click on the ball; and nothing else had to be drawn again).
    if (cameraMenu) return closeCameraMenu({ refocus: true });
    cameraMenu = true;
    cameraFocus = true;
    addOpen = false;
    pieceOpen = null;
    advanced = false;
    render();
  }
  /**
   * The menu against its block: at its right, its top level with the block's; raised to the top of the column when it
   * would reach « Générer » (K01: it never hides it). (0.6.262) Never above the column: taller than the room left,
   * it went up to 8 px from the top of the window, over the bar of the conversation (30 px of it at 1280 × 720); it
   * is short enough there now (moodix.css, max-height: 760px).
   */
  function placeCameraMenu(pane, block, ball) {
    openPopup(pane, ball, { beside: block });
    const box = pane.getBoundingClientRect?.(),
      go = document.querySelector?.('#studio-view .studio-go-group')?.getBoundingClientRect?.(),
      column = block.closest?.('.studio-block')?.getBoundingClientRect?.();
    if (!box || !go || !column) return;
    if (box.left < go.right && box.right > go.left && box.bottom > go.top - 8) pane.style.top = Math.round(column.top) + 'px';
  }
  /** Closed without drawing the Studio again (a press beside it, Échap): the focus back on the ball when asked. */
  function closeCameraMenu({ refocus = false } = {}) {
    cameraMenu = false;
    // (0.6.262) The block drawn last first (cameraParts), the page else.
    const block = cameraParts?.block ?? document.querySelector?.('#studio-view .studio-camera-block'),
      pane = cameraParts?.menu?.pane ?? block?.querySelector?.('.camera-menu'),
      ball = cameraParts?.ball ?? block?.querySelector?.('.camera-block-ball');
    if (pane) closePopup(pane);
    block?.classList?.remove?.('is-open');
    ball?.setAttribute?.('aria-expanded', 'false');
    if (cameraParts) cameraParts.menu = null;
    if (refocus) ball?.focus?.();
  }
  /**
   * (0.6.202, capture 96) What is given that the model in hand does not take (the end image and the subject
   * of LTX 2.5 under Wan 2.2): kept in the draft for a model that takes it, as before, and shown now, greyed
   * on the plateau, one line under it saying that it will not go; it was gone without a word. `[{ role,
   * index }]`, in the order of the plateau. Not while a proposal of Moodix AI waits (its notes say what does
   * not go) nor in a continuation (its clip is all it starts from).
   */
  function offPieces(workflow) {
    if (answering() || (mode === 'video' && extending)) return [];
    const given = drafts[mode].inputs ?? {},
      found = [];
    // Without holes, as the subjects of a model that takes them: the place of each is the one its × takes away.
    if (given.reference) given.reference = given.reference.filter(Boolean);
    const others = Object.keys(given).filter(role => !['start_image', 'end_image', 'reference'].includes(role));
    for (const role of ['start_image', 'end_image', ...others, 'reference'])
      (given[role] ?? []).forEach((item, index) => {
        if (item && index >= (workflow.roles?.[role]?.count ?? 0)) found.push({ role, index });
      });
    // (0.6.211) The camera set for a model that takes it, under one that does not: kept too, the last.
    if (drafts[mode].camera && !workflow.camera) found.push({ role: 'camera', index: 0 });
    return found;
  }
  /** (0.6.202) What a role this model has not takes, from a model of the mode that has it: a video to follow, else an image. */
  const mediaOfRole = role => offered().find(item => item.roles?.[role]?.count)?.roles[role].media[0] ?? 'image';
  /** (0.6.202) A piece kept that the model does not take: its case greyed, its word, × to take it away. */
  function offPiece(workflow, { role, index }) {
    if (role === 'camera') return cameraPiece(workflow, { off: `Caméra gardée : ${workflow.name} ne la prend pas.` });
    const video = mediaOfRole(role) === 'video',
      subject = role === 'reference',
      label = video ? 'Vidéo à suivre' : subject ? ROLES.reference + ' ' + (index + 1) : (ROLES[role] ?? 'Image');
    return slot(workflow, role, index, {
      label,
      word: video ? WORDS.follow : (WORDS[role] ?? 'Image'),
      picto: video ? 'video' : (PICTO[role] ?? (subject ? null : 'image')),
      badge: subject ? '@' + (index + 1) : '',
      media: video ? 'video' : 'image',
      off: `${label} ${subject ? 'gardé' : 'gardée'} : ${workflow.name} ne ${subject ? 'le' : 'la'} prend pas.`,
      onRemove: subject
        ? () => {
            drafts[mode].inputs.reference.splice(index, 1);
            render();
          }
        : null,
    });
  }
  /**
   * (0.6.202) The one line under the plateau for all that the model does not take (his answer 10 of 21/11):
   * « L’image de fin et le sujet ne partiront pas avec Wan 2.2. ».
   */
  function offLine(workflow, off) {
    const count = role => off.filter(piece => piece.role === role).length,
      names = [...new Set(off.map(piece => piece.role))].map(role =>
        role === 'reference'
          ? count(role) > 1
            ? 'les sujets'
            : 'le sujet'
          : mediaOfRole(role) === 'video'
            ? 'la vidéo à suivre'
            : (KEPT[role] ?? 'une image'),
      ),
      said = names.length > 1 ? names.slice(0, -1).join(', ') + ' et ' + names.at(-1) : names[0],
      line = node('p', 'studio-plateau-note');
    line.setAttribute('role', 'note');
    line.append(
      icon('info'),
      node('span', '', said[0].toUpperCase() + said.slice(1) + (off.length > 1 ? ' ne partiront pas avec ' : ' ne partira pas avec ') + workflow.name + '.'),
    );
    return line;
  }
  /**
   * The Sujets (« Références » until 0.6.190), after the other pieces: no time; each image with its number
   * (« @1 »), one empty case at a time. (0.6.201) No « n/3 » any more: the empty case shows there is room
   * left, and says which one it is of how many in its tooltip (« Sujet 2 sur 3 »).
   */
  function referencesRow(workflow) {
    // The character of a video that follows another sits beside that video (sourcesRow).
    if (!takesImages(workflow, 'reference') || workflow.follows) return null;
    const draft = drafts[mode],
      most = workflow.roles.reference.count,
      // Without holes: the numbers follow each other. What is sent leaves the holes out anyway.
      given = (draft.inputs.reference ?? []).filter(Boolean);
    draft.inputs.reference = given;
    // Those past the model's most stay kept, for a model that takes them.
    const shown = given.slice(0, most),
      row = node('div', 'studio-pieces studio-references'),
      name = place => (most > 1 ? ROLES.reference + ' ' + (place + 1) : ROLES.reference);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', most > 1 ? 'Sujets' : 'Sujet');
    shown.forEach((item, place) =>
      row.append(
        slot(workflow, 'reference', place, {
          label: name(place),
          badge: '@' + (place + 1),
          onRemove: () => {
            draft.inputs.reference.splice(place, 1);
            render();
          },
        }),
      ),
    );
    if (shown.length < most)
      row.append(
        slot(workflow, 'reference', shown.length, {
          label: name(shown.length),
          add: most > 1 ? 'Ajouter le sujet ' + (shown.length + 1) : 'Ajouter le sujet',
          tip:
            (most > 1 ? `Sujet ${shown.length + 1} sur ${most}` : 'Sujet') +
            ' : personnage, objet ou décor · glisser, coller ou cliquer',
        }),
      );
    return row;
  }
  /** The image to modify (and any other input image): a case each, with its picto. */
  function sourcesRow(workflow) {
    const row = node('div', 'studio-pieces studio-sources'),
      labels = [];
    for (const [role, spec] of Object.entries(workflow.roles ?? {})) {
      if (['start_image', 'end_image', 'reference'].includes(role)) continue;
      // A continuation: its clip is the one named above the prompt (« Suite de la prise 4 »), never asked
      // again in an empty case that « Générer » would not read.
      if (role === 'source' && mode === 'video' && extending) continue;
      // The video a character is replaced in: a slot like an image's, which takes a video.
      const video = takesVideo(workflow, role);
      if (!video && !takesImages(workflow, role)) continue;
      for (let index = 0; index < spec.count; index++) {
        const label = (video ? 'Vidéo à suivre' : (ROLES[role] ?? 'Image')) + (spec.count > 1 ? ' ' + (index + 1) : '');
        labels.push(label);
        row.append(
          slot(workflow, role, index, {
            label,
            word: (video ? WORDS.follow : (WORDS[role] ?? 'Image')) + (spec.count > 1 ? ' ' + (index + 1) : ''),
            add: video ? 'Ajouter la vidéo à suivre' : spec.count === 1 && ADD[role] ? ADD[role] : 'Ajouter : ' + label,
            tip: label + (video ? ' · glisser ou cliquer' : ' · glisser, coller ou cliquer'),
            picto: video ? 'video' : (PICTO[role] ?? 'image'),
            media: video ? 'video' : 'image',
          }),
        );
      }
    }
    // A character put in a video: the video, then who is drawn in it, side by side.
    if (workflow.follows && takesImages(workflow, 'reference')) {
      const draft = drafts[mode];
      draft.inputs.reference = (draft.inputs.reference ?? []).filter(Boolean);
      labels.push('personnage');
      row.append(
        slot(workflow, 'reference', 0, {
          label: 'Personnage',
          word: WORDS.character,
          add: 'Ajouter l’image du personnage',
          tip: 'Personnage à mettre dans la vidéo · glisser, coller ou cliquer',
          badge: '@',
          onRemove: () => {
            draft.inputs.reference.splice(0, 1);
            render();
          },
        }),
      );
    }
    if (!labels.length) return null;
    // An empty case says how it is given on hover only (« … · glisser, coller ou cliquer »), as
    // Début, Fin and Sujets (16/11).
    row.setAttribute('role', 'group');
    row.setAttribute(
      'aria-label',
      workflow.follows ? labels.join(' et ') : labels.length > 1 ? 'Images' : labels[0],
    );
    return row;
  }
  /**
   * (0.6.203) The kinds of pieces a model takes, in the order of the plateau: `[{ kind, role, media, count }]`
   * (PIECES). The reference of a model that follows a video is its character; the lyrics of a song are a
   * piece too, opened under the prompt.
   */
  function kindsOf(workflow) {
    const rank = piece => ['start_image', 'end_image'].indexOf(piece.role) + 1 || (piece.role === 'reference' ? 9 : 5),
      kinds = Object.entries(workflow.roles ?? {})
        .filter(([, spec]) => spec?.count)
        .map(([role, spec]) => {
          const video = Boolean(spec.media?.includes('video'));
          return {
            kind: video ? 'follow' : role === 'reference' ? (workflow.follows ? 'character' : 'reference') : role in PIECES ? role : 'image',
            role,
            media: video ? 'video' : 'image',
            count: spec.count,
          };
        })
        .sort((a, b) => rank(a) - rank(b));
    // (0.6.211, capture 94) The camera, after what the model takes as images: a piece too, with no file.
    // (0.6.257, K00) No more for a model where it is a sentence of the prompt (LTX 2.5, Wan 2.2, MiniMax H3): its
    // block « Caméra » is always there, under the images (cameraBlock). Still for one that reads it itself (Wan 2.2
    // Caméra), as it was.
    if (workflow.camera?.moves) kinds.push({ kind: 'camera' });
    if (workflow.settings?.some(setting => setting.key === 'lyrics' && setting.type === 'string')) kinds.push({ kind: 'lyrics' });
    return kinds;
  }
  /**
   * (0.6.203, captures 94, 100 and 101) The list of « Ajouter »: what the model in hand takes, each choice
   * opening the files of the computer for its case (the lyrics, their field under the prompt), one already given
   * greyed (« déjà donnée », his answer 1 of 21/11); then, under a rule, what only another model of the mode
   * takes, greyed with the short name of that model and the sentence that says where to choose it (they were
   * nowhere: nothing said that a video can be followed, or that a song has lyrics, with another model).
   * `[{ name, note, off, run }]`, null for the rule.
   */
  function addChoices(workflow) {
    const draft = drafts[mode],
      own = kindsOf(workflow),
      choices = [];
    for (const piece of own) {
      const { name, given } = PIECES[piece.kind];
      if (piece.kind === 'lyrics') {
        const setting = workflow.settings.find(item => item.key === 'lyrics'),
          open = draft.lyrics || String(draft.settings[workflow.id]?.lyrics ?? setting.default ?? '').trim();
        choices.push(
          open
            ? { name, note: given, off: 'Les paroles sont déjà ouvertes, sous le prompt.' }
            : {
                name,
                run: () => {
                  draft.lyrics = true;
                  render();
                  document.querySelector?.('#studio-view [data-ai="setting-lyrics"]')?.focus?.();
                },
              },
        );
        continue;
      }
      // (0.6.211, capture 95) The camera: added with the movement the list starts from, its window open to
      // choose another; once added, set from its case.
      if (piece.kind === 'camera') {
        choices.push(
          draft.camera
            ? { name, note: given, off: 'La caméra est déjà réglée : cliquez sur sa case pour en changer.' }
            : {
                name,
                run: () => {
                  draft.camera = { ...CAMERA_DEFAULT };
                  pieceOpen = { role: 'camera', index: 0 };
                  pieceFocus = true;
                  advanced = false;
                  render();
                },
              },
        );
        continue;
      }
      const list = draft.inputs[piece.role] ?? [],
        free = Array.from({ length: piece.count }, (_, index) => index).find(index => !list[index]),
        clash = exclusiveWith(workflow, piece.role),
        note = piece.count > 1 ? given + 's' : given;
      if (clash.length) choices.push({ name, off: `Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}` });
      else if (free === undefined)
        choices.push({
          name,
          note,
          off: piece.kind === 'reference' && piece.count > 1 ? `Les ${piece.count} sujets sont déjà donnés.` : `${name} : ${note}. Cliquez sur sa case pour en changer.`,
        });
      else choices.push({ name, run: () => openPicker(piece.role, free, piece.media) });
    }
    const seen = new Set(own.map(piece => piece.kind)),
      others = [];
    // A model this computer can run first: « choisissez-le dans Modèle » names one that can be chosen there.
    for (const other of [...offered()].sort((a, b) => Boolean(a.unavailable) - Boolean(b.unavailable)))
      for (const piece of other.id === workflow.id ? [] : kindsOf(other)) {
        // (0.6.262) Never the camera of Wan 2.2 Caméra (« Caméra · avec Wan 2.2 Caméra », greyed): since 0.6.257 it
        // is a block of its own, under the images of the models that take it, not a piece of another model.
        if (seen.has(piece.kind) || piece.kind === 'camera') continue;
        seen.add(piece.kind);
        const { name, serves } = PIECES[piece.kind],
          short = shortModel(other);
        others.push({ kind: piece.kind, name, note: 'avec ' + short, off: `${serves} avec ${short} : choisissez-le dans Modèle.` });
      }
    // In the order of the plateau (PIECES), whichever model each comes from.
    const order = Object.keys(PIECES);
    others.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    return [...choices, ...(choices.length && others.length ? [null] : []), ...others];
  }
  /**
   * (0.6.203, captures 93 and 94) « Ajouter », the last piece of the plateau: a case with its « + », which opens
   * one of our lists of glass (addChoices), arrows, Entrée and Échap on the keyboard. Greyed with its reason
   * while a take is made (whyNot) and under a proposal of Moodix AI, whose images are its own. None in a
   * continuation, which starts from its clip alone, nor in a mode where no model takes anything.
   */
  function addPiece(workflow) {
    if (mode === 'video' && extending) return null;
    const choices = addChoices(workflow);
    if (!choices.length) return null;
    const held = answering() ? AI_INPUTS : locked() ? whyNot() || BUSY_HERE : '';
    if (held) addOpen = false;
    const piece = node('div', 'studio-add' + (addOpen ? ' is-open' : '')),
      menu = node('div', 'glass-menu studio-add-menu'),
      word = node('span', 'studio-add-word', 'Ajouter'),
      pick = button(
        'studio-add-pick',
        '',
        () => {
          // (0.6.204) One thing open at a time: the window of a piece closes for this list, and (0.6.206) that
          // of « Plus de réglages ».
          if (pieceOpen) closeWindow();
          if (cameraMenu) closeCameraMenu();
          if (advanced) closeMore();
          addOpen = !addOpen;
          piece.classList.toggle('is-open', addOpen);
          pick.setAttribute('aria-expanded', String(addOpen));
          if (!addOpen) return closePopup(menu);
          openPopup(menu, pick, { align: 'start' });
          // The first choice that can be made in hand; when none can, the first all the same: the keys read
          // why from there.
          (menu.querySelector?.('.glass-menu-item:not(.is-off)') ?? menu.querySelector?.('.glass-menu-item'))?.focus?.();
        },
        'plus',
      );
    // Its word under it says what it does: its tooltip only why it cannot be pressed.
    pick.setAttribute('aria-label', 'Ajouter');
    pick.setAttribute('aria-haspopup', 'menu');
    pick.setAttribute('aria-expanded', String(addOpen));
    if (held) pick.title = held;
    pick.disabled = Boolean(held);
    word.setAttribute('aria-hidden', 'true');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Ajouter');
    menu.hidden = !addOpen;
    for (const choice of choices) {
      if (!choice) {
        const rule = node('div', 'glass-menu-rule');
        rule.setAttribute('role', 'separator');
        menu.append(rule);
        continue;
      }
      const item = button('glass-menu-item' + (choice.off ? ' is-off' : ''), choice.name, () => {
        if (choice.off) return;
        closeAdd();
        choice.run();
      });
      item.setAttribute('role', 'menuitem');
      if (choice.note) {
        item.append(node('span', 'glass-menu-note', choice.note));
        item.setAttribute('aria-label', choice.name + ', ' + choice.note);
      }
      // Why it cannot be chosen, under the pointer and on the focus: at the right of the list (0.6.189).
      if (choice.off) {
        item.setAttribute('aria-disabled', 'true');
        item.dataset.tip = choice.off;
        item.dataset.tipSide = 'right';
      }
      menu.append(item);
    }
    // The arrows go through every choice, the greyed ones too: their reason is read on the focus.
    menu.onkeydown = event => {
      const items = [...(menu.querySelectorAll?.('.glass-menu-item') ?? [])],
        at = items.indexOf(document.activeElement),
        to = { ArrowDown: at + 1, ArrowUp: at + items.length - 1, Home: 0, End: items.length - 1 }[event.key];
      if (event.key === 'Tab') return closeAdd();
      if (event.key !== 'Escape' && to === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') closeAdd({ refocus: true });
      else items[to % items.length]?.focus?.();
    };
    piece.append(pick, word, menu);
    // Left open while the Studio is drawn again: shown once it is on the page (as « ··· »).
    if (addOpen) globalThis.queueMicrotask?.(() => menu.isConnected && addOpen && openPopup(menu, pick, { align: 'start' }));
    return piece;
  }
  /**
   * The plateau, below the prompt (0.6.201, captures 93 and 108): what the model takes in one block without a
   * title, in the style of the prompt's box, a word under each piece. The start and the end on their line of
   * time, then the other pieces on a row (the image to modify, the video to follow and its character, the
   * subjects). Four blocks with their titles before (« Début et fin », « Sujets »…); « Qui est qui » stays
   * under it.
   */
  function inputs(workflow) {
    span = null;
    // (0.6.204) The window of a piece does not outlive it: closed once its piece is taken back or moved, while a
    // take is made (its case cannot be pressed then), under another model that does not take it.
    // (0.6.211) The camera is a piece of a model that takes it, for a new video made by hand: not under a
    // proposal of Moodix AI (its pieces are its own) nor in a continuation (its clip is all it starts from).
    // (0.6.257) The piece is that of a model that reads the camera itself; for the others, the block (cameraBlock).
    const filmed = Boolean(workflow.camera?.moves && drafts[mode].camera) && !answering() && !(mode === 'video' && extending),
      taken = pieceOpen && (pieceOpen.role === 'camera' ? filmed : pieceOpen.role === 'orbit' ? refilming() : pieceOpen.index < (workflow.roles?.[pieceOpen.role]?.count ?? 0));
    if (pieceOpen && (locked() || !givenPiece(pieceOpen.role, pieceOpen.index) || !taken)) pieceOpen = null;
    const off = offPieces(workflow),
      frames = framesRow(workflow, off),
      // (0.6.202) What the model does not take: the start and the end at their end of the line of time when it
      // has one, the others after its own pieces.
      // (0.6.257) The camera kept is its block, greyed (cameraBlock), not a piece of the plateau any more.
      rest = off.filter(piece => piece.role !== 'camera' && !(frames && piece.index === 0 && (piece.role === 'start_image' || piece.role === 'end_image'))),
      pieces = [sourcesRow(workflow), referencesRow(workflow), filmed ? cameraPiece(workflow) : null].filter(Boolean);
    if (rest.length) {
      const kept = node('div', 'studio-pieces studio-kept');
      kept.setAttribute('role', 'group');
      kept.setAttribute('aria-label', 'Gardées pour un autre modèle');
      kept.append(...rest.map(piece => offPiece(workflow, piece)));
      pieces.push(kept);
    }
    // (0.6.203) « Ajouter », the last piece: with a model that takes nothing, the plateau is that case alone.
    const add = addPiece(workflow),
      plateau = frames || pieces.length || add ? node('div', 'studio-input-block studio-plateau') : null;
    if (frames) plateau.append(frames);
    if (pieces.length || add) {
      const row = node('div', 'studio-plateau-row');
      row.append(...pieces, ...(add ? [add] : []));
      plateau.append(row);
    }
    if (off.length) plateau.append(offLine(workflow, off));
    // (0.6.204) The plateau alone: « Qui est qui » left the column for the windows of its two pieces.
    // (0.6.257, K00) Under it, the block « Caméra » of a model that takes one; greyed when it is kept from one.
    const blocks = [plateau, cameraBlock(workflow, { kept: off.some(piece => piece.role === 'camera'), row: off.length > 0 })].filter(Boolean);
    if (!blocks.length) return null;
    // Another model: a light line around them for a moment, which fades (nothing blinks). Drawn
    // again meanwhile, they keep it until the moment is over.
    if (Date.now() < flashUntil) {
      for (const block of blocks) block.className += ' is-flash';
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        const lit = globalThis.document?.querySelectorAll?.('#studio-view .studio-input-block.is-flash') ?? [];
        for (const block of lit) block.classList.remove('is-flash');
      }, flashUntil - Date.now());
    }
    const column = node('div', 'studio-inputs');
    column.append(...blocks);
    return aiTarget(column, 'inputs');
  }

  // ------------------------------------------------------------------ size, length
  /** The formats and sizes a workflow offers, with the draft settled on one of each. */
  /**
   * (0.6.102) Whether a part of a workflow (a setting by its key, `lora:<id>`, `profiles`: changedParts
   * in lib/native-workflows.mjs) was changed in Paramètres › Workflows after `time` (of a take, of a
   * saving « Enregistrer »): the Studio then takes it as the workflow has it now, the rest as it was
   * (« le plus récent des deux »).
   */
  const changedSince = (workflow, time) => {
    const since = typeof time === 'number' ? time : Date.parse(time ?? '');
    return part => Number.isFinite(since) && Number(workflow?.changed?.[part] ?? 0) > since;
  };
  /**
   * (0.6.102) The size a workflow starts from, in its format: its draft's, the size it fixes, that of
   * the version it fixes (« Vidéo finale »).
   */
  function startSize(workflow, draft) {
    const base = workflow.size,
      format = base?.width > 0 && base?.height > 0 ? nearestFormat(base.width, base.height) : null;
    Object.assign(draft, { format: format?.id ?? null, size: format ? sizeKey(base) : null, formatChosen: false });
  }
  function sizing(workflow) {
    const draft = drafts[mode],
      formats = FORMATS.filter(format => sizesFor(format, workflow.limits, workflow.family).length),
      base = workflow.size ?? { width: 1024, height: 1024 };
    if (!formats.some(format => format.id === draft.format)) {
      draft.format = (formatOf(base.width, base.height) ?? formats[0])?.id ?? null;
      // (0.6.102) Nothing chosen yet: the size the workflow starts from, as it is (a size « Fixe »,
      // the size of the version it fixes), not only the nearest one of the list.
      if (!draft.size && draft.format && nearestFormat(base.width, base.height)?.id === draft.format)
        draft.size = sizeKey(base);
    }
    const { sizes, nearest } = sizeChoices(workflow, draft.format, base.width * base.height);
    const proposed = proposal?.mode === mode && proposal.values?.size === draft.size;
    // A size a take or a proposal was made at stays, outside the list too, while the model makes it
    // in the format in hand (0.6.92): replaced by the size of the list nearest to the model's own,
    // the Studio showed 1344 × 768 beside a take of 1920 × 1080 asked in the Chat. (The same for a
    // take of the Chat being made, its settings shown: showRequest, 0.6.96.)
    if (!proposed && !madeSize(workflow, draft) && !sizes.some(size => sizeKey(size) === draft.size))
      draft.size = nearest ? sizeKey(nearest) : null;
    return { formats, sizes, final: workflow.final && sizeKey(workflow.final) };
  }
  /** Draft or final, from the size: a large picture is a final, a small one a draft. */
  function stageOf(workflow, size = drafts[mode].size) {
    if (!workflow?.stages || !size) return null;
    const [width, height] = size.split('x').map(Number),
      small = workflow.size ? workflow.size.width * workflow.size.height : 0;
    return width * height > small * 1.5 ? 'final' : 'draft';
  }
  function lengthOf(workflow) {
    const lengths = workflow.lengths;
    if (!lengths?.seconds.length) return null;
    const draft = drafts[mode],
      key = extending ? 'extension' : 'length',
      nearest = wanted =>
        lengths.seconds.reduce((best, value) => (Math.abs(value - wanted) < Math.abs(best - wanted) ? value : best));
    if (!lengths.seconds.includes(draft[key])) draft[key] = nearest(draft[key] ?? lengths.standard ?? 5);
    return { key, list: lengths.seconds, value: draft[key], nearest };
  }
  // ------------------------------------------------------------------ the bars and blocks of Réglages
  /**
   * The colour of a bar at a place between its ends (0 to 1): the ivory of the room all along
   * (studio-maquette.md, « glissières à poignée ronde »; the four colours of moodix-design.md 12 are
   * those of before).
   */
  function barColour() {
    return 'rgb(238, 232, 222)';
  }
  /**
   * A thin bar (2 px, its handle 8 px) over `count` choices, at `index`: its filled part in the
   * gradient of all the bars, as far as `share(index)` between its ends (the gradient spreads over
   * the whole bar, only the part travelled shows); `notches` for a bar of a few choices, those
   * passed in the colour of their place. Returns the bar and its value, written by `text`.
   */
  function slider({ label, key, count, index, share, text, onInput, notches = false, disabled = false }) {
    const track = node('div', 'studio-bar-track' + (notches ? ' has-notches' : '')),
      bar = node('input', 'studio-bar'),
      value = node('output', 'studio-bar-value', text(index));
    bar.type = 'range';
    bar.min = '0';
    bar.max = String(Math.max(0, count - 1));
    bar.step = '1';
    bar.value = String(index);
    bar.disabled = disabled || locked();
    bar.setAttribute('aria-label', label);
    if (key) aiTarget(bar, key);
    const marks = [];
    if (notches && count > 1)
      for (let at = 0; at < count; at++) {
        const mark = node('span', 'studio-bar-notch');
        mark.setAttribute('aria-hidden', 'true');
        mark.style.left = `calc(4px + ${at / (count - 1)} * (100% - 8px))`;
        marks.push(mark);
      }
    const show = place => {
      bar.style.setProperty?.('--fill', String(share(place)));
      value.textContent = text(place);
      bar.setAttribute('aria-valuetext', text(place));
      marks.forEach((mark, at) => {
        mark.style.background = at <= place ? barColour(share(at)) : '';
        mark.classList.toggle('is-passed', at <= place);
      });
    };
    show(index);
    bar.oninput = () => {
      const place = Number(bar.value);
      show(place);
      onInput(place);
      paintSave();
    };
    track.append(bar, ...marks);
    return { track, value };
  }
  /** One line « label — thin bar — value » (moodix-design.md 8, 9). */
  function barLine(label, options) {
    const row = node('div', 'studio-bar-line'),
      { track, value } = slider({ label, ...options });
    row.append(node('span', 'studio-bar-label', label), track, value);
    return row;
  }
  /** The choices of a strength, at 0.05 apart between its ends. */
  function strengths(min, max) {
    const list = [];
    for (let step = 0; min + step * 0.05 <= max + 1e-9; step++) list.push(Math.round((min + step * 0.05) * 100) / 100);
    return list;
  }
  // ------------------------------------------------------------------ « Enregistrer »
  /** A value written the same way whatever the order of its keys: settings compared as text. */
  const canonical = value =>
    JSON.stringify(value, (key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map(name => [name, item[name]]),
          )
        : item,
    );
  /**
   * What « Enregistrer » keeps for a model (moodix-design.md 7; 7 bis 1): its length, its format
   * and size, its seed, its LoRAs and their strength, as the Studio has them now. Only what the
   * workflow leaves free: a value « Fixe » in Configuration › Workflows is neither kept nor given
   * back (no bar of length, of size or seed is offered for it; its LoRAs keep their switch and
   * strength).
   */
  function snapshot(workflow) {
    const draft = drafts[mode],
      values = {};
    if (workflow.lengths?.seconds.length) values.length = draft[extending ? 'extension' : 'length'];
    if (workflow.limits && workflow.direct && !extending && draft.size)
      Object.assign(values, { format: draft.format, size: draft.size });
    if (workflow.seeded) values.seed = draft.seed.trim();
    if (workflow.styled && mode !== 'audio' && !extending)
      values.styles = draft.styles.filter(style => style.name).map(({ name, strength }) => ({ name, strength }));
    const loras = {};
    for (const lora of workflow.loras ?? []) {
      const free = freeStrength(lora);
      if (!lora.assistant && !free) continue;
      const choice = loraChoice(workflow, lora),
        entry = {};
      if (lora.assistant) entry.on = choice.on;
      if (free) entry.strength = choice.strength;
      loras[lora.id] = entry;
    }
    if (Object.keys(loras).length) values.loras = loras;
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && !workflow.lengths) {
      const value = Number(draft.settings[workflow.id]?.seconds ?? sound.default);
      if (value > 0) values.settings = { seconds: value };
    }
    // Its settings on a bar (« Débruitage »), once set here: kept whatever the inputs of the moment.
    for (const setting of keptSettings(workflow)) {
      const value = draft.settings[workflow.id]?.[setting.key];
      if (value !== undefined && value !== '') (values.settings ??= {})[setting.key] = fineValue(setting, value);
    }
    return values;
  }
  /** Gives a model its saved settings back: those its workflow leaves free, as they still fit. */
  function applyPreset(workflow) {
    const saved = info?.presets?.[workflow.id],
      draft = drafts[mode];
    if (!saved || extending) return;
    // (0.6.102) What was changed in Paramètres › Workflows since it was saved is the workflow's now.
    const newer = changedSince(workflow, saved.savedAt);
    const lengths = workflow.lengths?.seconds ?? [];
    if (Number.isFinite(saved.length) && lengths.length && !newer('frames'))
      draft.length = lengths.reduce((best, value) =>
        Math.abs(value - saved.length) < Math.abs(best - saved.length) ? value : best,
      );
    if (saved.format && saved.size && workflow.limits && workflow.direct && !['width', 'height'].some(newer)) {
      const { sizes } = sizeChoices(workflow, saved.format, 0);
      if (sizes.some(size => sizeKey(size) === saved.size))
        Object.assign(draft, { format: saved.format, size: saved.size });
    }
    if (typeof saved.seed === 'string' && workflow.seeded && !newer('seed')) draft.seed = saved.seed;
    if (Array.isArray(saved.styles) && workflow.styled && mode !== 'audio')
      draft.styles = saved.styles
        .filter(style => info.styles.includes(style.name))
        .slice(0, MAX_STYLES)
        .map(({ name, strength }) => ({ name, strength }));
    for (const lora of workflow.loras ?? []) {
      const entry = saved.loras?.[lora.id];
      if (!entry || newer('lora:' + lora.id)) continue;
      const choice = loraChoice(workflow, lora);
      if (lora.assistant && typeof entry.on === 'boolean') choice.on = entry.on;
      if (freeStrength(lora) && Number.isFinite(entry.strength)) choice.strength = entry.strength;
      // Within the bounds the workflow gives today.
      loraChoice(workflow, lora);
    }
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && Number(saved.settings?.seconds) > 0 && !newer('seconds'))
      (draft.settings[workflow.id] ??= {}).seconds = Math.min(
        Number(sound.max ?? Infinity),
        Math.max(Number(sound.min ?? 0), saved.settings.seconds),
      );
    // Within the bounds the workflow gives today.
    for (const setting of keptSettings(workflow))
      if (Number.isFinite(saved.settings?.[setting.key]) && !newer(setting.key))
        (draft.settings[workflow.id] ??= {})[setting.key] = fineValue(setting, saved.settings[setting.key]);
  }
  /**
   * The floppy disk (moodix-design.md 7, 15 ter): 32 px at the right of the model's name, its
   * name only in its tooltip; quiet while nothing changed, a light pill once something did since
   * the last saving, a check just after one.
   */
  function saveButtonFor(workflow) {
    const disk = button('studio-save', '', () => void savePreset(workflow)),
      floppy = icon('save'),
      check = icon('check');
    floppy.classList?.add?.('studio-save-disk');
    check.classList?.add?.('studio-save-check');
    disk.append(floppy, check);
    disk.dataset.workflow = workflow.id;
    disk.dataset.state = 'still';
    disk.disabled = locked() || answering();
    saveButton = disk;
    return disk;
  }
  /** The floppy disk says whether the settings changed since they were saved (or first shown). */
  function paintSave() {
    const disk = saveButton,
      workflow = current();
    if (!disk || !workflow || disk.dataset.workflow !== workflow.id) return;
    const saved = info?.presets?.[workflow.id],
      { savedAt, ...values } = saved ?? {},
      against = saved ? canonical(values) : baselines[workflow.id],
      changed = against !== undefined && canonical(snapshot(workflow)) !== against,
      done = savedJust?.id === workflow.id && Date.now() < savedJust.until;
    disk.dataset.state = done ? 'saved' : changed ? 'changed' : 'still';
    disk.title = done
      ? 'Réglages enregistrés pour ' + workflow.name
      : changed
        ? 'Enregistrer ces réglages pour ' + workflow.name + ' : ils reviendront chaque fois que vous le choisirez, et ses LoRA iront aussi avec les créations demandées dans le Chat'
        : saved
          ? 'Réglages de ' + workflow.name + ' enregistrés · ils reviennent chaque fois que vous le choisissez ; ses LoRA vont aussi avec les créations demandées dans le Chat'
          : 'Enregistrer ces réglages pour ' + workflow.name;
    disk.setAttribute('aria-label', disk.title);
  }
  /** Keeps the settings of the model on the server, apart from its workflow, in place of the last. */
  async function savePreset(workflow) {
    if (locked() || answering()) return;
    const values = snapshot(workflow);
    try {
      const answer = await (await api('studio/preset', { workflow: workflow.id, preset: values })).json();
      (info.presets ??= {})[workflow.id] = answer.preset ?? values;
      savedJust = { id: workflow.id, until: Date.now() + 1600 };
      paintSave();
      setTimeout(paintSave, 1650);
      const said = $('live-status');
      if (said) said.textContent = 'Réglages enregistrés pour ' + workflow.name + '.';
    } catch (error) {
      notice(error.message);
    }
  }
  /** Bloc Modèle: the model chosen (a list when there are several), its own block. */
  function modelBlock(workflow, list) {
    const block = node('div', 'studio-set-block studio-set-model');
    // A clip made here is continued with the model that made it, never chosen; one of the disk has
    // none of its own: its model is chosen like that of a new video.
    if (list.length > 1 && (!extending || !extending.workflowId)) {
      const model = select(
        list.map(item => [item.id, item.unavailable ? item.name + ' · indisponible' : item.name]),
        workflow.id,
        choose,
      );
      // Greyed, with its reason under the list (unavailableNote): never left out unexplained.
      list.forEach((item, index) => {
        if (item.unavailable) Object.assign(model.children[index], { disabled: true, title: item.unavailable });
      });
      model.className = 'studio-model-pick';
      model.title = workflow.description || workflow.name;
      model.disabled = answering() || locked();
      if (answering()) model.title = 'Modèle choisi par Moodix AI pour cette proposition';
      model.setAttribute('aria-label', mode === 'audio' ? 'Type' : 'Modèle');
      aiTarget(model, 'model');
      block.append(model);
    } else {
      const name = node('span', 'studio-model-name', workflow.name);
      name.title = workflow.description || workflow.name;
      if (workflow.unavailable) name.classList.add('is-unavailable');
      block.append(name);
    }
    // Not for a continuation: what it would keep would never come back (a clip is continued with
    // the model that made it, never chosen).
    if (!extending) block.append(saveButtonFor(workflow));
    return block;
  }
  /**
   * Why the model in hand cannot be used on this computer (no NVIDIA card for a model that computes on
   * one); null when it can. (0.6.200) Its reason alone: the others, greyed in the list, say theirs in their
   * bubble. Under the list it said those of the four, the model in hand ready or not (check of 21/11,
   * overload, problem 8).
   */
  function unavailableNote(workflow) {
    if (!workflow?.unavailable) return null;
    const note = node('p', 'studio-model-note', workflow.unavailable);
    note.setAttribute('role', 'note');
    return note;
  }
  /**
   * Bloc Durée + Taille: the length the model allows, step by step (its counts of frames at 24 a
   * second: MiniMax H3 from 5.17 s, LTX 2.5 from 0.71 s; a sound, its own setting), and the sizes
   * of the format chosen, a notch each; a fine line between them.
   */
  function shapeBlock(workflow) {
    const draft = drafts[mode],
      lines = [],
      length = lengthOf(workflow);
    if (length) {
      const list = length.list,
        low = list[0],
        high = list.at(-1);
      lines.push(
        barLine(extending ? 'Durée ajoutée' : 'Durée', {
          key: 'duration',
          count: list.length,
          index: Math.max(0, list.indexOf(length.value)),
          share: place => (high > low ? (list[place] - low) / (high - low) : 1),
          text: place => seconds(list[place]),
          onInput: place => {
            draft[length.key] = list[place];
            readout();
            lengthMoved();
          },
        }),
      );
    }
    const sound = workflow.settings.find(setting => setting.key === 'seconds' && setting.type === 'number');
    if (sound && !length) {
      const store = (draft.settings[workflow.id] ??= {}),
        low = Number(sound.min ?? 1),
        high = Number(sound.max ?? 30),
        step = Number(sound.step ?? 1),
        list = [];
      for (let value = low; value <= high + 1e-9; value += step) list.push(Math.round(value * 1000) / 1000);
      const wanted = Number(store.seconds ?? sound.default ?? low),
        index = list.reduce(
          (best, value, at) => (Math.abs(value - wanted) < Math.abs(list[best] - wanted) ? at : best),
          0,
        );
      lines.push(
        barLine('Durée', {
          key: 'setting-seconds',
          count: list.length,
          index,
          share: place => (high > low ? (list[place] - low) / (high - low) : 1),
          text: place => seconds(list[place]),
          onInput: place => {
            store.seconds = list[place];
            readout();
          },
        }),
      );
    }
    if (workflow.limits && !extending) {
      const { sizes } = sizing(workflow),
        list = [...sizes];
      // A size outside the list, of a proposal (kept from a source) or of a take (asked in the Chat),
      // is shown as it is, among the others by its number of pixels (0.6.92: at the end before).
      if (draft.size && !list.some(size => sizeKey(size) === draft.size)) {
        const [width, height] = draft.size.split('x').map(Number),
          larger = list.findIndex(size => size.width * size.height > width * height);
        list.splice(larger < 0 ? list.length : larger, 0, { width, height });
      }
      if (list.length) {
        const line = barLine('Résolution', {
          key: 'size',
          count: list.length,
          index: Math.max(
            0,
            list.findIndex(size => sizeKey(size) === draft.size),
          ),
          share: place => (list.length > 1 ? place / (list.length - 1) : 1),
          text: place => `${list[place].width} × ${list[place].height}`,
          onInput: place => {
            draft.size = sizeKey(list[place]);
            readout();
          },
          notches: true,
        });
        line.title = mode === 'video' ? 'Plus grand : plus long à générer.' : '';
        // Above the length, under the format (studio-maquette.md).
        lines.unshift(line);
      }
    }
    if (!lines.length) return null;
    const block = node('div', 'studio-set-block studio-set-shape');
    lines.forEach((line, at) => {
      if (at) block.append(node('div', 'studio-set-rule'));
      block.append(line);
    });
    return block;
  }
  /** What depends on the length, kept in step while its bar moves: the line from start to end. */
  function lengthMoved() {
    paintSpan();
  }
  /**
   * Bloc LoRA (moodix-design.md 11, 7 bis 5): « LoRA · n / 3 », those of the workflow first (a
   * padlock in place of ×, their bar greyed when their strength is fixed there, their switch when
   * they are left to the assistant), then those added here, three at most, 0 to 2.
   */
  function loraBlock(workflow, styled) {
    const own = workflow.loras ?? [];
    if (!own.length && !styled) return null;
    const draft = drafts[mode],
      section = node('section', 'studio-set-block studio-lora-block'),
      head = node('div', 'studio-lora-head');
    section.setAttribute('aria-label', 'LoRA');
    head.append(node('h3', 'studio-lora-heading', 'LoRA'));
    if (styled) {
      head.append(node('span', 'studio-lora-count', `· ${draft.styles.length} / ${MAX_STYLES}`));
      if (info.styles.length && draft.styles.length < MAX_STYLES) {
        const add = button(
          'studio-lora-plus',
          '',
          () => {
            draft.styles.push({ name: info.styles[0], strength: 1 });
            render();
          },
          'plus',
        );
        add.setAttribute('aria-label', 'Ajouter un LoRA');
        add.title = 'Ajouter un LoRA';
        add.disabled = locked();
        head.append(add);
      }
    }
    section.append(head);
    for (const lora of own) section.append(workflowLoraRow(workflow, lora));
    if (styled) {
      draft.styles.forEach((style, index) => section.append(styleRow(style, index)));
      if (!info.styles.length)
        section.append(node('small', 'field-help', 'Aucun LoRA listé : le dossier loras est vide.'));
    }
    return section;
  }
  /** A LoRA of the workflow: its name, its strength (greyed when fixed there), its switch, a padlock. */
  function workflowLoraRow(workflow, lora) {
    const choice = loraChoice(workflow, lora),
      free = freeStrength(lora),
      low = free ? Number(lora.strength.min ?? 0) : Math.min(0, choice.strength),
      high = free ? Number(lora.strength.max ?? 2) : Math.max(2, choice.strength),
      list = strengths(low, high),
      row = node('div', 'studio-lora-row is-workflow' + (choice.on ? '' : ' is-off')),
      name = node('span', 'studio-lora-title'),
      { track, value } = slider({
        label: 'Force du LoRA ' + lora.name,
        count: list.length,
        index: Math.max(0, Math.round((choice.strength - low) / 0.05)),
        share: place => (high > low ? (list[place] - low) / (high - low) : 1),
        text: place => strengthText(list[place]),
        onInput: place => {
          choice.strength = list[place];
        },
        disabled: !free || !choice.on,
      }),
      lock = node('span', 'studio-lora-lock');
    // (Left to the assistant, it has its switch: no mark of Moodix AI beside its name, 0.6.92.)
    name.append(node('span', 'studio-lora-label', lora.name));
    name.title = lora.description ? lora.name + ' · ' + lora.description : lora.name;
    if (!free) value.title = 'Force fixée dans Paramètres › Modèles';
    lock.append(icon('lock'));
    lock.setAttribute('role', 'img');
    lock.setAttribute('aria-label', 'LoRA du modèle');
    lock.title = 'LoRA du modèle : réglé dans Paramètres › Modèles';
    row.append(name, track, value);
    if (lora.assistant) {
      const toggle = node('input', 'studio-lora-switch');
      toggle.type = 'checkbox';
      toggle.checked = choice.on;
      toggle.disabled = locked();
      toggle.title = 'Utiliser ce LoRA pour cette création';
      toggle.setAttribute('aria-label', 'Utiliser le LoRA ' + lora.name);
      toggle.onchange = () => {
        choice.on = toggle.checked;
        render();
      };
      row.append(toggle);
    }
    row.append(lock);
    return row;
  }
  /** A LoRA added here: its name (a click opens the list), its strength from 0 to 2, × to remove it. */
  function styleRow(style, index) {
    const draft = drafts[mode],
      list = strengths(0, 2),
      row = node('div', 'studio-lora-row'),
      name = select(
        info.styles.map(file => [file, leaf(file)]),
        style.name,
        value => {
          style.name = value;
          name.title = leaf(value);
          paintSave();
        },
      ),
      { track, value } = slider({
        label: 'Force du LoRA ' + leaf(style.name),
        count: list.length,
        index: Math.max(0, Math.min(list.length - 1, Math.round(style.strength / 0.05))),
        share: place => list[place] / 2,
        text: place => strengthText(list[place]),
        onInput: place => {
          style.strength = list[place];
        },
      }),
      remove = button(
        'studio-lora-drop',
        '',
        () => {
          draft.styles.splice(index, 1);
          render();
        },
        'close',
      );
    name.className = 'studio-lora-pick';
    name.title = leaf(style.name);
    name.disabled = locked();
    name.setAttribute('aria-label', 'LoRA ' + (index + 1));
    remove.title = 'Retirer ce LoRA';
    remove.setAttribute('aria-label', 'Retirer ce LoRA');
    remove.disabled = locked();
    row.append(name, track, value, remove);
    return row;
  }
  /**
   * A decimal setting on its bar, by hundredths (« Débruitage », 0,60 to 0,70), what its values do
   * said in its tip, under the pointer and on the focus (help-tips.mjs), as the other settings say
   * theirs: no line under it any more (0.6.92). One the model only reads with an input (an image to
   * modify) is greyed while the case of that input is empty, and its tip says why in place of that
   * help: never unavailable without its reason.
   */
  /**
   * (0.6.205, captures 99 and 109; his decision N2 of 21/11) The piece a setting is set with, by its role: one
   * the engine reads with a single input (`onlyWith`, one role) that the model in hand takes lives in the window
   * of that piece (« Débruitage » with the image to modify of Krea 2, « Influence de l’image de fin » with the
   * end of LTX 2.5), no longer under « Plus de réglages », greyed there while its case was empty: a setting is
   * shown where it is read. null for any other setting (one read with two inputs stays under « Plus de
   * réglages »). (0.6.207) The clip of a continuation is a piece too, « À prolonger »: « Images de
   * chevauchement » is set in its window.
   */
  function pieceOf(workflow, setting) {
    if (!setting?.onlyWith) return null;
    const inputs = [...new Set(onlyInputs(workflow, setting))],
      [role] = inputs;
    return inputs.length !== 1 || !workflow.roles?.[role]?.count ? null : role;
  }
  /**
   * Why a setting the model only reads with an input changes nothing now, the case of that input
   * empty ('' when it is read): said in its tip, the setting greyed. (0.6.102) A continuation reads
   * it with the clip it continues; with several inputs, each is named.
   */
  function idleReason(workflow, setting, draft = drafts[mode]) {
    const role = onlyRole(workflow, setting),
      inputs = [...new Set(onlyInputs(workflow, setting))];
    if (!role || (extending && inputs.includes('source'))) return '';
    if (inputs.some(input => (draft.inputs[input] ?? []).some(Boolean))) return '';
    const names = inputs.map(input => `« ${ROLES[input] ?? input} »`);
    return (
      ONLY_WITH[role] ??
      (names.length > 1
        ? `Sert seulement avec l’entrée ${names.slice(0, -1).join(', ')} ou ${names.at(-1)}.`
        : `Sert seulement avec l’entrée ${names[0]}.`)
    );
  }
  function fineLine(workflow, setting, { side = '' } = {}) {
    const draft = drafts[mode],
      store = (draft.settings[workflow.id] ??= {}),
      low = setting.min,
      high = setting.max,
      list = [];
    for (let step = 0; low + step * 0.01 <= high + 1e-9; step++) list.push(Math.round((low + step * 0.01) * 100) / 100);
    const reason = idleReason(workflow, setting, draft),
      idle = Boolean(reason),
      label = settingName(setting.key),
      said = idle ? reason : (BAR_HELP[setting.key] ?? ''),
      line = barLine(label, {
        key: 'setting-' + setting.key,
        count: list.length,
        index: Math.max(0, list.indexOf(fineValue(setting, store[setting.key]))),
        share: place => (list[place] - low) / (high - low),
        text: place => strengthText(list[place]),
        onInput: place => {
          store[setting.key] = list[place];
        },
        disabled: idle,
      }),
      wrapper = node('div', 'studio-fine' + (idle ? ' is-idle' : ''));
    wrapper.append(line);
    if (said) {
      // The tip of the whole line: a greyed bar takes no focus, its label and its value the pointer.
      line.title = said;
      // (0.6.205) In the window of a piece, beside the window (`side`): above the bar, it covered its name.
      if (side) line.dataset.tipSide = side;
      // Read by screen readers after the bar, where the line under it said it, without its room.
      wrapper.append(node('span', 'sr-only', said));
    }
    return wrapper;
  }
  /**
   * The rare settings, under « ··· » (moodix-design.md 10, 20, 28): the seed (a field, empty for
   * one drawn at each creation, and a die), then the workflow's own settings; one line each.
   * (0.6.205, captures 99 and 109) Not those that are set with one piece alone (pieceOf): `piece`, a
   * role, gives the lines of that piece for its window, without the seed.
   */
  function rareLines(workflow, { piece = null } = {}) {
    const draft = drafts[mode],
      lines = [];
    // (0.6.102) A seed « Fixe » too: the workflow's own while the field is empty (said in its place),
    // the one the user names otherwise, for this creation.
    const seedFixed = Number.isSafeInteger(workflow.seedFixed) ? workflow.seedFixed : null;
    if (!piece && (workflow.seeded || seedFixed !== null)) {
      const row = node('div', 'studio-set-line studio-seed'),
        seed = node('input'),
        dice = button(
          'studio-dice',
          '',
          () => {
            seed.value = draft.seed = String(Math.floor(Math.random() * 2 ** 32));
            paintSave();
          },
          'dice',
        );
      seed.type = 'number';
      seed.min = '0';
      seed.placeholder = seedFixed !== null ? String(seedFixed) : 'aléatoire';
      seed.value = draft.seed;
      seed.disabled = locked();
      seed.setAttribute('aria-label', 'Seed');
      seed.oninput = () => {
        draft.seed = seed.value;
        paintSave();
      };
      aiTarget(seed, 'seed');
      dice.title = 'Tirer une seed au hasard';
      dice.setAttribute('aria-label', 'Tirer une seed au hasard');
      dice.disabled = locked();
      row.append(node('span', 'studio-bar-label', 'Seed'), seed, dice);
      lines.push(row);
    }
    for (const setting of workflow.settings) {
      // Not the lyrics, who is who (in the windows of its two pieces, windowLines), a sound's length (on the
      // bar of Durée): rareSetting.
      if (!rareSetting(setting)) continue;
      // (0.6.205) Each line where it is set: in the window of its piece, or here.
      if (pieceOf(workflow, setting) !== piece) continue;
      if (fineSetting(setting)) {
        lines.push(fineLine(workflow, setting, { side: piece ? 'right' : '' }));
        continue;
      }
      // Kept per workflow: a song's length is not a sound effect's.
      const store = (draft.settings[workflow.id] ??= {}),
        value = store[setting.key] ?? setting.default ?? '',
        label = settingName(setting.key),
        set = next => {
          store[setting.key] = next;
          readout();
        };
      let control;
      if (setting.type === 'boolean') {
        // (0.6.102) On or off (« Audio » of LTX 2.5): a switch, sent as such. A number field took
        // « false » from a take and refused the creation.
        control = node('input', 'studio-setting-switch');
        control.type = 'checkbox';
        control.checked = settingValue(setting, value) === true;
        control.onchange = () => set(control.checked);
      } else if (setting.type === 'string' && !setting.choices) {
        control = textarea(String(value), 4, SETTING_HELP[setting.key] ?? '', set);
        if (setting.maxLength) control.maxLength = setting.maxLength;
      } else if (setting.choices)
        control = select(
          setting.choices.map(choice => [choice, String(choice)]),
          value,
          set,
        );
      else {
        control = node('input');
        control.type = 'number';
        control.value = String(value);
        if (setting.min !== undefined) control.min = String(setting.min);
        if (setting.max !== undefined) control.max = String(setting.max);
        if (setting.type === 'integer') control.step = String(setting.multipleOf ?? 1);
        else if (setting.multipleOf) control.step = String(setting.multipleOf);
        else control.step = 'any';
        control.oninput = () => set(control.value);
        // (0.6.102) Beyond its bounds, the nearest value they allow, shown at once: a whole number
        // beyond them refused the creation, a decimal was made at its limit while 12 stayed shown.
        control.onchange = () => {
          const held = settingValue(setting, control.value);
          if (held === '' || String(held) === control.value) return;
          control.value = String(held);
          set(held);
        };
      }
      aiTarget(control, 'setting-' + setting.key);
      const wrapper = field(label, control, { wide: setting.type === 'string' && !setting.choices }),
        // (0.6.102) Read only with an input not given (« Compression des images (CRF) » without a start
        // or an end image): greyed as a bar is, and why in its tip.
        idle = idleReason(workflow, setting, draft);
      // Its name, its switch at the right, on one line.
      if (setting.type === 'boolean') wrapper.className += ' is-switch';
      if (idle) {
        control.disabled = true;
        wrapper.className += ' is-idle';
        wrapper.title = idle;
        wrapper.append(node('span', 'sr-only', idle));
      } else if (setting.max !== undefined)
        wrapper.title = `De ${String(setting.min ?? 0).replace('.', ',')} à ${String(setting.max).replace('.', ',')}.`;
      lines.push(wrapper);
    }
    return lines;
  }

  // ------------------------------------------------------------------ the screen
  /**
   * The shape of the screen (16/11): the take shown at its own format, in its filet, without bands
   * (the format chosen in the settings is for the next creation); while one is made, or with none,
   * the shape of what will be made.
   */
  /**
   * The screen always takes the format chosen (16/11), empty or not: a take of another format is
   * shown whole inside it, never cropped (moodix.css, studio-frame-result).
   */
  function screenShape() {
    return shapeOf();
  }
  /** The take shown measured once its file is read (a record without its size): the screen follows. */
  function measuredOnScreen(record, width, height) {
    if (!(width > 0 && height > 0) || sizeOfRecord(record)) return;
    measured.set(record.id, { width, height });
    const page = globalThis.document,
      frame = page?.querySelector?.('#studio-view .studio-frame');
    if (frame && onStage()?.id === record.id)
      reshape(frame, screenShape(), page.querySelector('#studio-view .studio-frame-over'));
  }
  /** The number the take under way will have: the counter of the project, else the last one + 1. */
  function upcomingTake() {
    if (Number.isInteger(nextTake) && nextTake > 0) return nextTake;
    return 1 + Math.max(0, ...runs.flatMap(record => (record.outputs ?? []).map(output => output.take ?? 0)));
  }
  /**
   * (0.6.466) What a take of the Studio is asked with, frozen as it is asked: its mode, a copy of its draft, its page
   * (a clip continued or filmed again, the page Agrandir, the picture of « Animer »), its shape and its readout. The
   * form is free while it is made: the screen shows it from this, not from what is being written for the next one.
   */
  function lookNow() {
    return {
      mode,
      draft: JSON.parse(JSON.stringify(drafts[mode])),
      follows: Boolean(current()?.follows),
      extending: mode === 'video' ? extending : null,
      refilmId: mode === 'video' ? refilmId : null,
      finishing: finishOn() ? { ...finishing } : null,
      animated,
      looked: Boolean(looked),
      shape: formShape(),
      readout: readoutText(current(), { asked: true }),
    };
  }
  /**
   * (0.6.466) A request of the queue as it is asked: what « Générer » sends (`wanted`, its model kept by its id), its
   * tries, where it is made (the conversation and the project of the Studio), what the screen shows of it (lookNow)
   * and what its tile says (`label`). `queued`: asked by « Générer ensuite », behind another one.
   */
  function requestEntry(wanted, count, queued = false) {
    const look = lookNow(),
      { model = null, ...rest } = wanted,
      workflow = model ?? current(),
      finish = wanted.finish ? FINISH[wanted.finish.verb] : null,
      lasts = Boolean(workflow) && mode !== 'image',
      seconds = !lasts ? null : mode === 'audio' ? soundSeconds(workflow) : lengthOf(workflow)?.value,
      // Its length as the screen writes it (« 05.04 S »: 5.0416… s made for 5 asked).
      format = [mode === 'audio' ? '' : look.shape.label, seconds ? figures(seconds) : ''].filter(Boolean).join(' · ');
    return {
      mode,
      tries: count,
      wanted: JSON.parse(JSON.stringify({ ...rest, model: model?.id ?? null })),
      look,
      conversation: conversation(),
      project: project(),
      queued,
      label: {
        prompt: String(wanted.args?.prompt ?? '').trim() || finish?.go || (refilming() ? 'Changer la caméra' : ''),
        kind: mode,
        // Its model without what its name says in brackets (« Bruitages », of « Bruitages (MOSS-SoundEffect v2) »):
        // whole, it was cut on its tile.
        model: String(workflow?.name ?? '').replace(/\s*\([^()]*\)\s*$/, ''),
        format,
      },
    };
  }
  /**
   * (0.6.466) What a request of the queue sends, as it was asked, its model read again by its id. Gone since (a model
   * taken away): said on its tile. What else it lacks now, the server says (« … n'est pas prêt »), on its tile too.
   */
  function entryWanted(entry) {
    const wanted = JSON.parse(JSON.stringify(entry.wanted ?? {}));
    if (typeof wanted.model !== 'string') return { ...wanted, model: undefined };
    const model = (info?.tools?.[wanted.verb] ?? []).find(item => item.id === wanted.model);
    if (!model) throw Error(`${entry.label?.model || 'Son modèle'} n’est plus proposé par le Studio.`);
    return { ...wanted, model };
  }
  /**
   * (0.6.466, D5) A click on a request that failed: its settings back in the Studio as they were asked (its page, its
   * prompt, its model, its images, its tries), why it failed under the screen; its tile leaves the queue. As a take
   * looked at (inspect): « Revenir » gives back the Studio as it was. Not while the Chat or the Bobine write in it.
   */
  function takeBack(entry) {
    if (locked() || proposal || checking || ai) return notice(whyNot() || BUSY_HERE);
    const look = entry.look ?? {};
    if (!look.draft || !MODES.some(item => item.id === entry.mode)) return;
    looked ??= { mode, drafts: structuredClone(drafts), advanced, kept: { ...kept }, pinned, extending, refilmId };
    mode = entry.mode;
    const draft = drafts[mode];
    for (const key of Object.keys(draft)) if (!(key in look.draft)) delete draft[key];
    Object.assign(draft, structuredClone(look.draft));
    extending = mode === 'video' ? (look.extending ?? null) : null;
    refilmId = mode === 'video' ? (look.refilmId ?? null) : null;
    finishing = look.finishing ?? null;
    animated = look.animated ?? null;
    tries = Math.min(TRIES.at(-1), Math.max(1, entry.tries || 1));
    triesIn = mode;
    formatsOpen = addOpen = triesOpen = cameraMenu = false;
    pieceOpen = null;
    queue.remove(entry.id);
    failure = entry.reason || '';
    render();
  }
  /** (0.6.466) The take of the Studio being made, as it was asked (lookNow); null otherwise. */
  function underWay() {
    return working?.look ?? null;
  }
  /** (0.6.466) The mode of what the screen shows: the take of the Studio being made, else the page in hand. */
  function screenMode() {
    return underWay()?.mode ?? mode;
  }
  /** The shape of what will be made: a ratio, and the format it is. */
  // (0.6.466) A take of the Studio being made: its own, as it was asked (formShape: the one of the form).
  function shapeOf() {
    return underWay()?.shape ?? formShape();
  }
  function formShape() {
    if (mode === 'audio') return { ratio: 3.4, label: '' };
    if (extending) {
      const { width, height } = extending.parameters ?? {},
        format = formatOf(width, height);
      return { ratio: width > 0 && height > 0 ? width / height : 16 / 9, label: format?.id ?? 'Suite' };
    }
    // A character put in a video: the shape of that video, known once it is given.
    if (current()?.follows) {
      const video = drafts[mode].inputs.source?.[0],
        known = video?.width > 0 && video?.height > 0;
      return {
        ratio: known ? video.width / video.height : 16 / 9,
        label: known ? (formatOf(video.width, video.height)?.id ?? '') : '',
      };
    }
    const format = FORMATS.find(item => item.id === drafts[mode].format);
    return { ratio: format?.ratio ?? 1, label: format?.id ?? '' };
  }
  /**
   * What will be made, at the top left of the screen (moodix-design.md 25, 7 bis 13): its format
   * and its length, « 16:9 - 05.17 S »; an image, its format; a sound, its length. Whether it is
   * a draft or a final is said in the details of the creation (a click in the Sortie).
   */
  function readoutText(workflow = current(), { asked = false } = {}) {
    if (underWay() && !asked) return underWay().readout;
    if (!workflow) return '';
    const shape = asked ? formShape() : shapeOf(),
      length = lengthOf(workflow);
    if (mode === 'audio') {
      const sound = soundSeconds(workflow);
      return sound ? figures(sound) : '';
    }
    if (mode === 'image') return shape.label;
    return [shape.label, length ? figures(length.value) : ''].filter(Boolean).join(' - ');
  }
  /** The length of a sound to make, as its setting has it. */
  function soundSeconds(workflow) {
    const sound =
      drafts.audio.settings[workflow.id]?.seconds ??
      workflow.settings.find(setting => setting.key === 'seconds')?.default;
    return Number(sound) > 0 ? Number(sound) : null;
  }
  function readout() {
    const text = document.querySelector?.('.studio-readout');
    if (text) text.textContent = readoutText();
    // (0.6.253) The format and the size in the middle of the empty screen follow too.
    sayBlank();
    paintSave();
  }
  /**
   * (0.6.200) The words of the empty screen, in place: a key does not draw the Studio again. Where the take
   * comes only while nothing is begun: no prompt, nothing in a case, no clip continued, no reason said under
   * « Générer », never over the wave of a sound. How to begin with it in a project without takes only, and
   * not while Moodix AI sets the Studio nor while its proposal waits (0.6.101).
   */
  function sayBlank() {
    if (!blankLines) return;
    // (0.6.253, A00) « 1:1 · 1024 × 1024 »: the format and the size of what will be made, a prompt written or not.
    // A sound has neither (its bars are the screen); a model that sets its own size, its format alone. Not over a
    // clip continued or refilmed (its banner says what is made, its size is the clip's), nor under an error.
    if (extending || refilming() || failure) {
      blankLines.size.textContent = '';
      blankLines.size.hidden = true;
      return;
    }
    // The size the bar « Résolution » shows: the one of the draft, which the form sets (sizing) before the screen.
    const workflow = current(),
      chosen = mode !== 'audio' && workflow?.limits && /^\d+x\d+$/.test(drafts[mode].size ?? '') ? drafts[mode].size : '',
      size = chosen ? chosen.replace('x', ' × ') : '',
      shape = mode === 'audio' ? null : shapeOf();
    blankLines.size.textContent = [shape?.label, size].filter(Boolean).join(' · ');
    blankLines.size.hidden = !blankLines.size.textContent;
  }
  /** The room the frame has: its stage, less a margin; a default before the stage is laid out. */
  function room(frame) {
    const box = frame.parentElement,
      // (0.6.255) The frame stays in the middle, the column of the actions at its right: as much on each side.
      // Only a frame as wide as its stage is narrowed by it (a tall one leaves room enough).
      width = Math.max(0, (box?.clientWidth ?? 0) - (railTake() ? RAIL_ROOM * 2 : 0)),
      height = box?.clientHeight ?? 0;
    // As large as the stage: the Studio fills the window, the screen with it.
    return width > 40 && height > 40 ? { width: Math.min(width, 1600), height: Math.min(height, 1000) } : FRAME;
  }
  function reshape(frame, { ratio }, over = null) {
    const size = frameSize(ratio, room(frame));
    for (const element of [frame, over].filter(Boolean)) {
      element.style.width = size.width + 'px';
      element.style.height = size.height + 'px';
    }
    // (0.6.261) The column of the actions unfolded (112 px) where the stage has no room at its right (a frame in 16:9
    // at 1280 × 720 or 1440 × 900: cut by 41 px, « Agra », « Ani »): drawn over the frame by what lacks.
    over?.style.setProperty?.('--rail-shift', railShift(frame, size) + 'px');
    drawn = size;
    readout();
  }
  /**
   * The screen: a frame at the format of the take shown (of what will be made while one is made,
   * or with none), as large as the stage allows. It eases from the shape it had to the new one,
   * across formats and across modes, and follows the window when it is resized.
   */
  function stage() {
    // (0.6.466) The mode of what is on the screen: the one of the take of the Studio being made, whatever page the
    // form shows meanwhile (Image while a sound is made: its bars, not a frame).
    const mode = screenMode();
    const screen = node('div', 'studio-screen'),
      box = node('div', 'studio-stage'),
      // While a creation is being made the frame is its own (the picture so far). (0.6.256, captures A05 and B09)
      // A take made larger or smoother stays on it meanwhile, veiled, a band of light going down over it.
      finished = working?.finish && mode === mediaOf(working.finish.record) ? working.finish.record : null,
      // (0.6.256, capture A07) After « Animer »: its picture, the start of the video to make, in place of the last clip.
      start = finished ? null : animatedStart(),
      last = start ? null : (onStage() ?? finished),
      frame = node(
        'div',
        'studio-frame' +
          (mode === 'audio' ? ' is-audio' : '') +
          (working ? ' is-busy' : '') +
          (finished ? ' is-finishing' : '') +
          (last ? ' has-result' : '') +
          (start ? ' has-start' : '') +
          (!last && !start && !working && !gpuBlocked() ? ' is-empty' : '') +
          (gpuBlocked() && !working ? ' is-held' : ''),
      ),
      // (The card held, 54: the take that held it is drawn at the format chosen, as every take is.)
      next = screenShape();
    const take = last?.outputs?.[0]?.take,
      numbered = Number.isInteger(take),
      // While a take is made: the number it will have, in the accent, instead of its format.
      coming = working && !numbered ? upcomingTake() : null;
    frame.append(
      node('span', 'studio-frame-fill'),
      node(
        'span',
        'studio-frame-label' + (numbered ? ' is-take' : coming ? ' is-take is-coming' : start ? ' is-take is-start' : ''),
        numbered ? 'PRISE ' + take : coming ? 'PRISE ' + coming : start ? WORDS.start_image.toUpperCase() : next.label,
      ),
    );
    blankLines = null;
    loupeShown = null;
    if (mode === 'audio') {
      const bars = node('div', 'studio-bars');
      bars.setAttribute('aria-hidden', 'true');
      for (let index = 0; index < 48; index++) {
        const bar = node('span');
        bar.style.height = 16 + Math.round(76 * Math.abs(Math.sin(index * 0.41) * Math.cos(index * 0.13))) + '%';
        bars.append(bar);
      }
      frame.append(bars);
    }
    if (gpuBlocked() && !working) {
      // The card stays held by the last generation (etats-maquette.md, 54): its take veiled, at its
      // format, « ÉCHEC » (nothing was kept) and « ARRÊTÉE », and what to do.
      if (seenPreview) {
        const picture = node('img', 'studio-held-picture');
        Object.assign(picture, { src: seenPreview, alt: '', draggable: false });
        frame.append(picture);
      }
      const veil = node('div', 'studio-held-veil');
      veil.setAttribute('role', 'alert');
      // The same words as in the chat (54b); « Libérer le GPU » says what to do, under it. (0.6.456) Why the take
      // failed is said under the screen (preview): in a screen of 9:16, 150 px wide at 1280 × 720, it went out of it.
      // There, the first words go too (moodix.css, .studio-held-words).
      // (0.6.463) Its take made and kept, the card alone held after it (the engine could not say it was free again):
      // neither « ÉCHEC » nor « Rien n’a été enregistré », which were false then; the take is in the Sortie.
      const made = gpuMade();
      const said = node('p', 'studio-held-text');
      said.append(
        node('span', 'studio-held-words', 'La carte graphique est restée prise par la dernière génération.'),
        node('span', '', made ? ' La prise est faite : elle est dans la Sortie.' : ' Rien n’a été enregistré.'),
      );
      veil.append(node('p', 'studio-held-kicker', made ? 'Carte prise' : 'Arrêtée'), said);
      frame.append(...(made ? [] : [node('span', 'studio-failed-chip', 'Échec')]), veil);
    } else if (!working && refilming()) {
      // (0.6.240) While the camera of a clip is set: its simple guide, in the place of the take on the screen.
      frame.append(orbitGuide(current()));
    } else if (start) {
      // At half its light: no take yet, the picture the video will start from.
      const picture = node('img', 'studio-frame-start');
      Object.assign(picture, { src: start.preview, alt: '', draggable: false });
      frame.append(picture);
    } else if (last) {
      frame.append(result(last));
      if (finished) {
        const band = node('span', 'studio-finish-band');
        band.setAttribute('aria-hidden', 'true');
        frame.append(band);
      } else if (enlarged(last)) frame.append(...magnifier(last, frame));
    } else if (!working) {
      // Nothing made in this mode yet (etats-maquette.md, 55). (0.6.253, generer-maquette.md, A00) No sentence of
      // help any more, nor the Éclipse: the format and the size of what will be made, in mono, in the middle
      // (sayBlank). A sound keeps its bars.
      const blank = node('div', 'studio-blank');
      blankLines = { size: node('p', 'studio-blank-size') };
      blankLines.size.setAttribute('aria-hidden', 'true');
      blank.append(blankLines.size);
      sayBlank();
      frame.append(blank);
    } else frame.setAttribute('aria-hidden', 'true');
    const shown = node('span', 'studio-readout', readoutText());
    shown.setAttribute('aria-hidden', 'true');
    frame.append(shown);
    // Over the frame, at its size, never clipped by it. No « i » on the screen: a click on a
    // creation of the Sortie shows it whole with its details.
    // The step under way is in the head of the screen, « Arrêter » in the Double verre (form).
    const over = node('div', 'studio-frame-over');
    // Drawn at the previous shape first, so the browser has something to ease from.
    const from = drawn ?? frameSize(next.ratio);
    for (const element of [frame, over]) {
      element.style.width = from.width + 'px';
      element.style.height = from.height + 'px';
    }
    box.append(frame, over);
    screen.append(box);
    // A take of the Sortie, or a file of the computer, dropped on the screen: shown there with what
    // made it (inspect, inspectFile). Not an image of a case, which only changes case.
    const takes = event => Boolean(carried) || (!dragged && [...(event.dataTransfer?.types ?? [])].includes('Files'));
    box.ondragover = event => {
      if (!takes(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      box.classList.add('is-target');
    };
    box.ondragleave = () => box.classList.remove('is-target');
    box.ondrop = event => {
      if (!takes(event)) return;
      event.preventDefault();
      event.stopPropagation?.();
      box.classList.remove('is-target');
      carrying(null);
      if (carried) {
        const record = carried;
        carried = null;
        return inspect(record);
      }
      const [file] = event.dataTransfer.files ?? [];
      if (file) void inspectFile(file);
    };
    watching?.disconnect();
    if (typeof ResizeObserver === 'function') {
      // Called once the stage is laid out, then at every change of its size.
      watching = new ResizeObserver(() => {
        // Another view is shown: nothing to size. Back in sight (16/11): at its size at once, the
        // screen never grows into place as the Studio comes; it eases only from one format to another.
        const there = box.clientWidth > 40 && box.clientHeight > 40;
        if (!there) return void (laidOut = false);
        const still = laidOut ? [] : [frame, over];
        for (const element of still) element.style.transition = 'none';
        reshape(frame, screenShape(), over);
        if (still.length) void frame.offsetWidth;
        for (const element of still) element.style.transition = '';
        laidOut = true;
      });
      watching.observe(box);
    }
    return { screen, box, frame, over };
  }
  /**
   * (0.6.255, lot 3) The take whose actions stand in a column at the right of the frame: the one on the screen (the
   * last of its mode while one is made), not a sound, not while a clip is continued nor while the card is held.
   */
  function railTake() {
    // (0.6.466) Of the mode on the screen: that of the take of the Studio being made, the form free meanwhile.
    const mode = screenMode(),
      continued = underWay() ? underWay().extending : extending;
    const onScreen = working ? (kept[mode] ?? ownRuns().find(item => mediaOf(item) === mode) ?? null) : onStage();
    if (!onScreen || mode === 'audio' || continued || (gpuBlocked() && !working)) return null;
    // (0.6.256) Nor while the screen shows the start image « Animer » put: no take on it.
    if (animatedStart()) return null;
    return onScreen.external && !onScreen.resource ? null : onScreen;
  }
  /** The creation on the screen: the image (a click shows it whole), the clip to play, or the sound. */
  function result(record) {
    const output = record.outputs[0],
      media = mediaOf(record),
      key = record.id + '|' + (output.originalUrl || '');
    if (shownMedia?.key === key) return shownMedia.element;
    const element = screenMedia(record, output, media);
    shownMedia = { key, element };
    return element;
  }
  /** The element that shows a creation on the screen: its picture, its clip to play, or its sound. */
  function screenMedia(record, output, media) {
    if (media === 'audio') {
      const player = node('audio', 'studio-frame-result studio-frame-sound');
      Object.assign(player, { controls: true, preload: 'metadata', src: output.originalUrl || '' });
      return player;
    }
    const clip = media === 'video',
      // A clip in a box at its shape, with the player of a take over it (0.6.97).
      element = node(clip ? 'div' : 'img', 'studio-frame-result' + (clip ? ' studio-frame-clip' : ''));
    // Its own shape, for the sheet (moodix.css, --media-ratio): the take is always a little smaller
    // than the frame and rounded on its own, whatever the format chosen (16/11). Known from its
    // record at once, from the picture itself once it is read.
    const shaped = (width, height) =>
      width > 0 && height > 0 && element.style.setProperty?.('--media-ratio', (width / height).toFixed(4));
    const known = sizeOfRecord(record);
    if (known) shaped(known.width, known.height);
    if (clip) {
      // Its picture and the round ▶ (capture 22), as in the conversation: the player of a take opened
      // plays it there (take-player.mjs), never the browser's; « Voir en grand » opens it in its window
      // (not a file of the computer shown here, which has none). Kept with the clip from one drawing
      // to the next.
      const video = node('video'),
        take = output.take;
      Object.assign(video, { preload: 'metadata', playsInline: true, src: output.originalUrl || '' });
      if (output.thumbUrl) video.poster = output.thumbUrl;
      video.setAttribute('aria-label', record.prompt || 'Dernière vidéo créée');
      video.onloadedmetadata = () => {
        shaped(video.videoWidth, video.videoHeight);
        measuredOnScreen(record, video.videoWidth, video.videoHeight);
      };
      const player = clipPlayer({
        node,
        video,
        onExpand: record.external ? null : () => viewOutput(record, 0),
        label: Number.isInteger(take) ? 'Lecteur · PRISE ' + take : 'Lecteur',
      });
      element.append(video, player.element);
    } else {
      Object.assign(element, {
        alt: record.prompt || 'Dernière image créée',
        decoding: 'async',
        src: output.originalUrl,
      });
      if (!record.external) {
        element.title = 'Voir l’original et ses paramètres';
        element.onclick = () => viewOutput(record, 0);
      }
      element.onload = () => {
        shaped(element.naturalWidth, element.naturalHeight);
        measuredOnScreen(record, element.naturalWidth, element.naturalHeight);
        // (0.6.258) An image made larger: its size at the bottom right, read from its file once it is.
        const badge = globalThis.document?.querySelector?.('#studio-view .studio-frame-size');
        if (badge && onStage()?.id === record.id) sayEnlarged(badge, enlargedSize(record, element));
      };
    }
    return element;
  }
  /** (0.6.258, lot 6) An image made larger (SeedVR2, Real-ESRGAN): the loupe and its size are on it. */
  const enlarged = record => mediaOf(record) === 'image' && transformOf(record) === 'AGRANDIE';
  /**
   * (0.6.258) The image it was made larger from, when it is still in the Sortie: the address of its file. (0.6.262) Or
   * still among the references of the project (a photo of the computer put on the screen, then made larger: its
   * source is a reference, `resource_id`): its size alone was said, no « Comparer ».
   */
  function enlargedFrom(record) {
    if (!enlarged(record)) return null;
    const reference = record.parameters?.references?.find(ref => ref.role === 'source_image'),
      original = reference?.output_id ? runs.find(item => item.id === reference.output_id) : null,
      resource = !original && reference?.resource_id ? assets.resource?.(reference.resource_id) : null,
      url = original
        ? (original.outputs?.[reference.output_index ?? 0]?.originalUrl ?? original.outputs?.[0]?.originalUrl)
        : resource?.originalUrl || resource?.previewUrl;
    return url ? { url } : null;
  }
  /** (0.6.258) Its size: that of its file once it is read, else that of its output (never of what it was asked). */
  function enlargedSize(record, picture) {
    if (picture?.complete && picture.naturalWidth > 0 && picture.naturalHeight > 0)
      return { width: picture.naturalWidth, height: picture.naturalHeight };
    const { width, height } = record.outputs?.[0] ?? {};
    return width > 0 && height > 0 ? { width, height } : null;
  }
  /** (0.6.258) « 2048 × 2048 », in mono, at the bottom right of the image (its shape for the sheet, --media-ratio). */
  function sayEnlarged(badge, size) {
    badge.hidden = !size;
    badge.textContent = size ? size.width + ' × ' + size.height : '';
    if (size) badge.style.setProperty?.('--media-ratio', (size.width / size.height).toFixed(4));
  }
  const LOUPE = 200;
  /**
   * (0.6.258, lot 6, captures A06 and B10) Over an image made larger, its size at the bottom right; under the pointer,
   * a round loupe of 200 px that follows it. It shows the image at 100 % (a pixel of its file for a pixel of the
   * page), cut in two by a line: at the left the image it was made from, at the same size, at the right the image
   * made larger. Not with « Comparer » released, nor by touch (nothing goes under a finger), nor without the image
   * it was made from (deleted): its size alone.
   */
  function magnifier(record, frame) {
    const picture = result(record),
      badge = node('span', 'studio-frame-size'),
      pair = enlargedFrom(record);
    badge.title = 'Taille de l’image agrandie';
    sayEnlarged(badge, enlargedSize(record, picture));
    if (!pair) return [badge];
    const loupe = node('div', 'studio-loupe'),
      before = node('span', 'studio-loupe-half is-before'),
      after = node('span', 'studio-loupe-half is-after'),
      was = node('img'),
      now = node('img');
    Object.assign(was, { src: pair.url, alt: '', draggable: false, decoding: 'async' });
    Object.assign(now, { src: record.outputs[0].originalUrl, alt: '', draggable: false, decoding: 'async' });
    before.append(was);
    after.append(now);
    loupe.append(before, after, node('span', 'studio-loupe-line'));
    loupe.setAttribute('aria-hidden', 'true');
    // (0.6.262) Above the page (a popover, as our lists of glass): in the frame, the frame, the stage and the block of
    // the screen cut it, the image 8 px from the edges of its frame. Not round 92 px from an edge of the image (62 %
    // of it at 1912 × 948, 93 % at 1280 × 720), the image of before nearly gone at its left. Placed in the window.
    loupe.setAttribute('popover', 'manual');
    loupe.hidden = true;
    const lift = shown => {
      try {
        const open = Boolean(loupe.matches?.(':popover-open'));
        if (shown && !open) loupe.showPopover?.();
        else if (!shown && open) loupe.hidePopover?.();
      } catch {
        // Not in the page any more (drawn again meanwhile): nothing to show.
      }
    };
    const hide = () => {
      loupe.hidden = true;
      lift(false);
    };
    frame.onpointermove = event => {
      if (!comparing || event.pointerType === 'touch') return hide();
      const box = picture.getBoundingClientRect?.();
      if (!box?.width || !box.height) return hide();
      const x = (event.clientX - box.left) / box.width,
        y = (event.clientY - box.top) / box.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return hide();
      // At 100 %: the size of its file; never smaller than on the screen.
      const size = enlargedSize(record, picture),
        width = Math.max(size?.width ?? 0, box.width),
        height = (width * box.height) / box.width;
      loupe.hidden = false;
      lift(true);
      loupe.style.transform = `translate(${Math.round(event.clientX - LOUPE / 2)}px, ${Math.round(event.clientY - LOUPE / 2)}px)`;
      for (const image of [was, now]) {
        image.style.width = Math.round(width) + 'px';
        image.style.height = Math.round(height) + 'px';
        image.style.transform = `translate(${Math.round(LOUPE / 2 - x * width)}px, ${Math.round(LOUPE / 2 - y * height)}px)`;
      }
    };
    frame.onpointerleave = hide;
    loupeShown = { hide };
    return [badge, loupe];
  }
  /**
   * (0.6.258, lot 6) « Comparer », 8 px under the actions of an image made larger: pressed (at first), the loupe comes
   * under the pointer over the image; released, it does not. Said in place, the focus kept on it.
   */
  function compareButton() {
    const control = button('output-action output-action-compare', 'Comparer', () => {
      comparing = !comparing;
      sayCompare(control);
      if (!comparing) loupeShown?.hide();
    }, 'act-compare');
    sayCompare(control);
    return control;
  }
  function sayCompare(control) {
    control.setAttribute('aria-pressed', String(comparing));
    control.setAttribute(
      'aria-label',
      comparing
        ? 'Comparer : la loupe au survol de l’image, l’originale à gauche, l’agrandie à droite'
        : 'Comparer : remettre la loupe au survol de l’image',
    );
  }
  /** The number of a creation in the Sortie: the first made is #1, the newest the largest. */
  function numberOf(record) {
    // One count for all the creations of the Sortie, images, clips and sounds together: counted
    // kind by kind, an image, a clip and a sound were each « #1 » side by side.
    const at = runs.findIndex(item => item.id === record.id);
    return at < 0 ? null : runs.length - at;
  }

  /** The formats under the preview: 1:1, 16:9, 9:16, and « ··· » for all of them. */
  function formatChips(workflow, frame) {
    const draft = drafts[mode],
      wrap = node('div', 'studio-formats-wrap'),
      row = aiTarget(node('div', 'studio-formats'), 'ratio'),
      available = sizing(workflow).formats.map(format => format.id),
      { main, extra } = shownFormats(available, draft.format),
      menu = node('div', 'studio-format-menu');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', 'Format');
    // (0.6.256, capture A07) After « Animer », the format is the one of its picture: greyed, why said (greyable: it
    // still answers the pointer with its bubble).
    const held = mode === 'video' && animatedStart() ? 'Le format suit l’image de début.' : '';
    const pick = id => {
      // (0.6.320) Nor while a creation runs, whatever is still on screen (its choices are greyed, see below).
      if (held || locked()) return;
      Object.assign(draft, { format: id, size: null, formatChosen: true });
      formatsOpen = false;
      // The chips and the sizes change with the format (another one may take the place of « ··· »).
      render();
    };
    for (const id of main) {
      const format = FORMATS.find(item => item.id === id),
        chip = held ? greyable(button('studio-format', id, () => pick(id))) : button('studio-format', id, () => pick(id));
      chip.title = held || format.label;
      chip.setAttribute('role', 'radio');
      chip.setAttribute('aria-checked', String(id === draft.format));
      chip.disabled = locked() || Boolean(held);
      row.append(chip);
    }
    // Never cut by its panel (16/11): shown above the page, on the side that has room (glass-menu.mjs).
    const more = button('studio-format is-more' + (extra ? ' is-on' : ''), extra ? extra + ' ···' : '···', () => {
      if (held) return;
      formatsOpen = !formatsOpen;
      if (formatsOpen) openPopup(menu, more);
      else closePopup(menu);
      more.setAttribute('aria-expanded', String(formatsOpen));
    });
    more.setAttribute('aria-label', extra ? `Format ${extra} · tous les formats` : 'Tous les formats');
    more.setAttribute('aria-expanded', String(formatsOpen));
    if (held) {
      greyable(more);
      more.title = held;
    }
    more.disabled = locked() || Boolean(held);
    if (extra) {
      more.setAttribute('role', 'radio');
      more.setAttribute('aria-checked', 'true');
    }
    row.append(more);
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Tous les formats');
    menu.hidden = !formatsOpen;
    for (const id of available) {
      const choice = button('', id, () => pick(id));
      choice.title = FORMATS.find(item => item.id === id).label;
      choice.setAttribute('aria-pressed', String(id === draft.format));
      // (0.6.320) Greyed as the chips while a creation runs: the menu opened before Ctrl+Entrée stays open, and its
      // 4:3 changed the frame of the take being made.
      choice.disabled = locked();
      menu.append(choice);
    }
    wrap.append(row, menu);
    // Left open while the Studio is drawn again: shown once it is on the page.
    if (formatsOpen) globalThis.queueMicrotask?.(() => menu.isConnected && formatsOpen && openPopup(menu, more));
    return wrap;
  }

  // ------------------------------------------------------------------ LoRA of the workflow
  /** Whether the strength of a LoRA of the workflow is left to whoever asks (a range) or fixed there. */
  const freeStrength = lora => !Object.hasOwn(lora.strength, 'value');
  /**
   * What this creation does with a LoRA of its workflow: on or off, and how strongly. What the
   * workflow fixes follows it (switched there, it is so here at once); the rest is chosen here.
   */
  function loraChoice(workflow, lora, draft = drafts[mode]) {
    const own = (draft.workflowLoras[workflow.id] ??= {}),
      start = freeStrength(lora)
        ? (lora.strength.default ?? Math.min(lora.strength.max ?? 1, Math.max(lora.strength.min ?? 1, 1)))
        : lora.strength.value;
    const choice = (own[lora.id] ??= { on: lora.on, strength: start });
    if (!lora.assistant) choice.on = true;
    if (!freeStrength(lora)) choice.strength = lora.strength.value;
    else if (Number.isFinite(lora.strength.min) && Number.isFinite(lora.strength.max))
      choice.strength = Math.min(lora.strength.max, Math.max(lora.strength.min, choice.strength));
    return choice;
  }
  /** The workflow's LoRAs left to the assistant, as this creation has them, in the model's terms. */
  function loraArgs(workflow, draft = drafts[mode]) {
    const result = {};
    for (const lora of workflow?.loras ?? []) {
      const choice = loraChoice(workflow, lora, draft),
        entry = {};
      if (lora.assistant) entry.enabled = choice.on;
      if (choice.on && freeStrength(lora)) entry.strength = choice.strength;
      if (Object.keys(entry).length) result[lora.id] = entry;
    }
    return Object.keys(result).length ? result : null;
  }
  // ------------------------------------------------------------------ images handed over
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  /** The first image of files pasted or dropped, if any. */
  const imageFile = files => [...(files ?? [])].find(file => IMAGE_TYPES.includes(file.type)) ?? null;
  /**
   * (0.6.299) A case the page shown does not draw: the clip a suite or a change of camera starts from (the take
   * chosen in the Sortie, its first piece). « Agrandir » and « Interpoler » draw none at all (NO_FILE). A file
   * dropped or pasted on the column filled it all the same: imported as a reference of the project, nothing on
   * screen, no word, and found later as « Image à modifier » or « Vidéo à suivre » of the page behind.
   */
  const hiddenCase = role => role === 'source' && mode === 'video' && Boolean(extending);
  const NO_FILE = 'Cette page part d’une prise de la Sortie : elle ne prend pas de fichier.',
    NO_VIDEO = 'Cette page part de la prise choisie dans la Sortie : elle ne prend pas d’autre vidéo.';
  /**
   * An image pasted or dropped on the column of the prompt goes to the first free slot the model
   * takes, in the order of its slots, never to one that would not combine with those given.
   */
  function placeImage(workflow, file) {
    if (locked()) return;
    if (answering())
      return notice(
        'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.',
      );
    if (finishOn()) return notice(NO_FILE);
    const draft = drafts[mode];
    let taken = false;
    for (const [role, spec] of Object.entries(workflow.roles ?? {})) {
      if (!spec.count || !spec.media.includes('image')) continue;
      taken = true;
      if (exclusiveWith(workflow, role).length) continue;
      for (let index = 0; index < spec.count; index++)
        if (!draft.inputs[role]?.[index]) return void fill(role, index, file);
    }
    notice(taken ? 'Toutes les cases d’images sont prises.' : 'Ce modèle ne prend pas d’image en entrée.');
  }

  const videoFile = files => [...(files ?? [])].find(file => VIDEO_TYPES.includes(file.type)) ?? null;
  /** A video dropped on the column of the prompt goes to the slot of the model that takes one. */
  function placeVideo(workflow, file) {
    if (locked() || answering()) return;
    if (finishOn()) return notice(NO_FILE);
    for (const [role, spec] of Object.entries(workflow.roles ?? {}))
      if (takesVideo(workflow, role)) {
        if (hiddenCase(role)) return notice(NO_VIDEO);
        for (let index = 0; index < spec.count; index++)
          if (!drafts[mode].inputs[role]?.[index]) return void fill(role, index, file, 'video');
        return notice('La case de la vidéo est prise : retirez-la d’abord.');
      }
    notice('Ce modèle ne prend pas de vidéo en entrée.');
  }

  // ------------------------------------------------------------------ the prompt, improved
  // « Enrichir le prompt » asks for a few words first (moodix-design.md 17).
  const IMPROVE_MIN = 3;
  /**
   * A character put in a video: the video and the image handed over, from which the prompt is
   * written (not from words alone, which would invent a scene the video does not show). Null
   * for another model, or while one of the two is missing.
   */
  function sceneInputs() {
    if (!current()?.follows) return null;
    const { source, reference } = drafts[mode].inputs,
      video = source?.find(Boolean)?.source,
      character = reference?.find(Boolean)?.source;
    return video && character ? { source: video, reference: character } : null;
  }
  const improveTitle = () =>
    sceneInputs()
      ? 'Écrire le prompt d’après la vidéo et le personnage (' + MODIFIER + '+E)'
      : current()?.follows
        ? 'Ajoutez d’abord la vidéo et le personnage'
        : drafts[mode].prompt.trim().length < IMPROVE_MIN
          ? 'Écrivez d’abord quelques mots'
          : 'Enrichir le prompt avec Moodix AI (' + MODIFIER + '+E)';
  /** Whether « Enrichir » has what it needs: a few words, or the pictures a prompt is written from. */
  const improves = () =>
    current()?.follows ? Boolean(sceneInputs()) : drafts[mode].prompt.trim().length >= IMPROVE_MIN;
  /** The button follows what is typed, without drawing the Studio again (the field keeps its focus). */
  /** « Générer » as the prompt is typed: greyed while it is empty (55), without drawing the Studio again. */
  function goable() {
    const go = document.querySelector?.('#studio-view .studio-go');
    // (0.6.466) « Reprendre » needs nothing of the form. « Générer ensuite » follows what is typed as « Générer »,
    // with its own words (greyedWhy).
    if (go?.classList?.contains?.('is-again')) return;
    if (go?.classList?.contains?.('is-next')) {
      const why = greyedWhy('next');
      go.disabled = Boolean(why);
      go.classList.toggle('is-blank', why?.light === 'prompt');
      go.classList.toggle('is-unavailable', Boolean(why) && !why.light);
      go.title = why?.text || NEXT_TIP;
      return;
    }
    // (0.6.455) The dictation first, whatever holds the button besides: greyed while it listens or writes, then given
    // back as it was (`undictated`, kept by render too). Under a proposal of Moodix AI, it stayed lit; greyed by a
    // drawing of the Studio meanwhile, it stayed greyed after. Never « Libérer le GPU » in its place (54), as render.
    if (go && !working && !finishOn() && !current()?.unavailable && !gpuBlocked()) {
      if (dictating()) {
        if (!undictated.has(go)) undictated.set(go, [go.disabled, go.title || go.dataset?.tip || '']);
        go.disabled = true;
        go.title = DICTATING;
        return;
      }
      const kept = undictated.get(go);
      if (kept) {
        undictated.delete(go);
        [go.disabled, go.title] = kept;
      }
    }
    // (0.6.188) Never « Libérer le GPU », which takes its place and its name while the card is held (54). Nor
    // while another conversation makes a creation (0.6.81): greyed with that reason by the form, a key lit it
    // again and its tooltip said « Générer » (its click was refused all the same).
    if (!go || working || enriching || answering() || checking || current()?.unavailable || gpuBlocked() || elsewhere())
      return;
    // (0.6.253) Nor while the chat answers: greyed by the form with that reason (`chatBusy`).
    if (!ai && blocked()) return;
    // (0.6.256) Agrandir, Interpoler: lit with their take, whatever the prompt of the page.
    const finish = finishOn(),
      blank = !finish && !drafts[mode].prompt.trim() && !refilming(),
      // (0.6.188) Nor lit by the prompt alone while an input its model cannot do without is missing.
      missing = blank || finish ? '' : inputMissing(current(), drafts[mode].inputs, extending);
    go.disabled = blank || Boolean(missing);
    go.classList.toggle('is-blank', blank);
    go.title = blank ? blankWhy() : missing || `${finish ? FINISH[finish.verb].go : 'Générer'} (${MODIFIER}+Entrée)`;
  }
  /** (0.6.253) What « Générer » says without a prompt: what to describe first (the continuation, in Vidéo). */
  // A character put in a video: its wand writes the prompt, as request() says it.
  const blankWhy = () =>
    current()?.follows
      ? 'Écrivez un prompt, ou cliquez sur la baguette : il sera écrit d’après la vidéo et le personnage.'
      : extending && mode === 'video'
        ? 'Décrivez d’abord la suite.'
        : BLANK_WHY[mode];
  /**
   * (0.6.253) Why « Générer » is greyed now, and what lacks for it: the prompt, or the case of an input
   * (`start_image`…), lit when it is pressed. In the order the form says it (`form`): the model that cannot run
   * here, a creation of another conversation, a camera the model does not make, an input missing, the prompt.
   */
  // (0.6.466) `kind`: 'next', « Générer ensuite » (the same reasons, and its own: nextHeld); 'again', « Reprendre »,
  // which needs nothing of the form, only what holds the page (another conversation, the chat).
  function greyedWhy(kind = '') {
    const workflow = current(),
      draft = drafts[mode];
    if (kind === 'again') {
      const busy = elsewhere() || blocked();
      return busy ? { text: busy } : null;
    }
    // A take made, the card held: « Générer » is the bar of the work, or « Libérer la carte »; generate() answers.
    if (!workflow || (working && kind !== 'next') || gpuBlocked()) return null;
    const held = kind === 'next' ? nextHeld() : '';
    if (held) return { text: held };
    if (workflow.unavailable) return { text: workflow.unavailable };
    // (0.6.452) The words of the dictation are not in the prompt yet.
    if (dictating() && !finishOn()) return { text: DICTATING };
    // A proposal of Moodix AI, the character it made: answered here, whatever the prompt.
    const free = !answering() && !checking,
      busy = free ? elsewhere() : '';
    if (busy) return { text: busy };
    if (enriching) return { text: 'Moodix AI enrichit votre texte…' };
    const chat = free && !ai ? blocked() : '';
    if (chat) return { text: chat };
    if (refilming()) {
      const held = refilmRefusal(workflow);
      if (held) return { text: held };
    }
    if (!free) return null;
    // (0.6.256) Agrandir, Interpoler: nothing to write, nothing to give but the take of the page. (0.6.450) Unless
    // no size of the page can be made on the card of this computer.
    if (finishOn()) {
      const held = finishHeld(workflow);
      return held ? { text: held } : null;
    }
    if (!draft.prompt.trim() && !refilming()) return { text: blankWhy(), light: 'prompt' };
    const role = missingRole(workflow, draft.inputs, extending);
    return role ? { text: inputMissing(workflow, draft.inputs, extending), light: role } : null;
  }
  let called = null, // (0.6.253) { element, timer }: what was lit by a press on « Générer » greyed
    goButton = null; // (0.6.253) « Générer » as form() last drew it: its keys press it
  /**
   * (0.6.253, generer-maquette.md, « Générer grisé, cliqué ») A press on « Générer » greyed, or its keys: its
   * reason in its bubble, and what lacks lights up, the prompt with the cursor in it (an accent ring that pulses
   * twice, moodix.css), or the case of the image that is missing. Nothing is made. Lit, it generates. What greys it
   * is read from the Studio (greyedWhy), as form() greys it: not from the button, which may be of a drawing before.
   */
  function pressGo(go = goButton, event = null) {
    // (0.6.466) A take of the Studio being made: « Générer ensuite » puts this request in the queue. Requests paused
    // in this conversation: « Reprendre ».
    const next = !away() && ownWork(),
      again = !next && !away() && resumable().length > 0,
      why = away() ? null : greyedWhy(next ? 'next' : again ? 'again' : '');
    // The second click of a double click on « Générer », become « Générer ensuite » under the pointer: no copy of the
    // take just asked in the queue.
    if (next && event?.detail > 1) return;
    if (!why) return next ? queueNext() : again ? resumeQueue() : generate();
    if (!go) return;
    go.title = why.text;
    if (called) {
      clearTimeout(called.timer);
      called.element.classList?.remove?.('is-called');
    }
    const target =
      why.light === 'prompt'
        ? document.querySelector?.('#studio-view .studio-prompt-field')
        : why.light
          ? document.querySelector?.(`#studio-view .studio-slot[data-slot="${why.light}-0"]`)
          : null;
    if (target) {
      // Taken away first, so that a second press pulses again.
      target.classList?.remove?.('is-called');
      void target.offsetWidth;
      target.classList?.add?.('is-called');
      called = { element: target, timer: setTimeout(() => target.classList?.remove?.('is-called'), 1600) };
      if (why.light === 'prompt') document.querySelector?.('#studio-prompt')?.focus?.();
    }
    // After the focus, which shows the bubble of the prompt; after the title is taken by the bubbles too.
    queueMicrotask(() => sayTip(go));
  }
  // ------------------------------------------------------------------ (0.6.466) the queue (« Générer ensuite »)
  const NEXT_TIP = `Générer ensuite : cette demande attendra la fin de celle en cours (${MODIFIER}+Entrée)`,
    // (D7) What makes a take from the one on the screen, while a take of the Studio is made.
    RAIL_HELD = 'Attendez la fin de la génération en cours.',
    // (D6) What waits at most.
    QUEUE_FULL = `La file est pleine : ${QUEUE_MOST} demandes attendent.`;
  const theRequests = count => (count > 1 ? `les ${count} demandes` : 'la demande');
  const resumeTip = count =>
    `Reprendre la file : ${theRequests(count)} en attente${count > 1 ? ', dans l’ordre' : ''} (${MODIFIER}+Entrée)`;
  /** The requests paused in this conversation, when « Reprendre » takes the place of « Générer » (form). */
  const resumable = () =>
    !working && !chaining && !answering() && !checking && !gpuBlocked() ? queue.paused(conversation()) : [];
  /**
   * Why « Générer ensuite » is greyed, beyond what greys « Générer »: the queue full (D6), a page that makes a take
   * of a take (Prolonger, Changer la caméra, Agrandir, Interpoler: D7, made once the take is made).
   */
  function nextHeld() {
    if (queue.full()) return QUEUE_FULL;
    const page = finishOn()
      ? FINISH[finishing.verb].go
      : mode === 'video' && extending
        ? refilming()
          ? 'Changer la caméra'
          : 'Prolonger'
        : '';
    return page ? `${page} ne se met pas en file : attendez la fin de la génération en cours.` : '';
  }
  /**
   * « Générer ensuite »: what « Générer » would make now, frozen in the queue (its settings, its page, its tries,
   * its conversation), made in its turn. The form stays as it is: what is written stays, for the next one.
   */
  function queueNext() {
    let wanted;
    try {
      wanted = request();
    } catch (error) {
      return notice(error.message);
    }
    triesFollowPage();
    if (!queue.add(requestEntry(wanted, tries, true))) return notice(QUEUE_FULL);
    render();
  }
  /**
   * « Reprendre »: the requests paused in this conversation go again, in their order, the first at once. One that
   * cannot be read again is a tile in failure and the next one goes; one refused (its reason said): all stay paused.
   * (0.6.478) Of the conversation `here` (the window at the bottom right resumes from any page). During a take
   * followed again after a reload (Q3 of the maquette): they go after it, in their order (goOn).
   */
  function resumeQueue(here = conversation()) {
    if (working?.external && !working.chat && !working.place) {
      queue.resume(here);
      return render();
    }
    for (let next = queue.paused(here)[0]; next; next = queue.paused(here)[0]) {
      const going = generate({ entry: next });
      if (working) {
        queue.resume(here);
        render();
        return going;
      }
      if (queue.get(next.id)?.state !== 'failed') break;
    }
    render();
  }
  /** Its ×, « Vider la file »: what waits in this conversation goes; the failures stay, each with its cross. */
  function clearQueue(here = conversation()) {
    queue.clear(here);
    render();
  }
  // (0.6.478) What greys « Reprendre » of the window at the bottom right, beyond what greys « Générer ».
  const BOBINE_HELD = 'Attendez la fin de la prise de la Bobine.',
    AI_HELD = 'Moodix AI attend votre réponse dans le Studio : répondez-lui d’abord.';
  /** (0.6.478) Why « Reprendre » of the window is greyed now; '' when it can go (at once, or after the take, Q3). */
  function resumeHeld() {
    if (working?.montage || working?.place) return BOBINE_HELD;
    if (working?.external && !working.chat) return '';
    if (working || chaining || settling) return RAIL_HELD;
    if (proposal || checking || ai) return AI_HELD;
    return blocked() || elsewhere() || '';
  }
  /**
   * (0.6.478, variante A) The queue for the window at the bottom right (work-miniature.mjs), per conversation that has
   * requests: its name, what waits, what is paused and why, what failed, the queue full, and its foot (« Reprendre ·
   * 3 » lit or greyed with why, « Libérer le GPU » while the card is held, « Vider la file »). `docked`: it lies under
   * the settings of the Studio on screen, whose button says « Reprendre · 3 » or « Libérer le GPU » already for the
   * queue of its conversation: no foot then (never two « Reprendre » on one screen).
   */
  function queueView({ docked = false } = {}) {
    const card = gpuBlocked(),
      held = card ? '' : resumeHeld(),
      later = Boolean(working?.external && !working.chat && !working.place),
      shown = away() ? null : conversation();
    return queueParts(queue.entries()).map(({ conversation: id, waiting, paused, failed }) => {
      const count = paused.length,
        them = theRequests(count),
        said = docked && id === shown && (card ? !working : resumable().length > 0),
        reloaded = paused.some(row => row.reason === 'reload'),
        stopped = !card && !reloaded && paused.some(row => row.reason === 'stopped'),
        inOrder = count > 1 ? ', dans l’ordre' : '',
        // (Q3) After the take followed again: « les 3 demandes partiront après la prise en cours, dans l’ordre ».
        goes = later ? `${them} ${count > 1 ? 'partiront' : 'partira'} après la prise en cours` : `${them} en attente`,
        clear = `Vider la file : retirer ${them} en attente`;
      return {
        conversation: id,
        title: nameOf(id) || 'Nouvelle conversation',
        groups: [
          waiting.length ? { word: 'En attente', state: 'waiting', rows: waiting } : null,
          count ? { word: 'En pause', state: 'paused', rows: paused } : null,
          failed.length ? { word: waiting.length || count ? '' : 'Échec', state: 'failed', rows: failed } : null,
        ].filter(Boolean),
        // (Under the settings of the Studio whose button resumes it, its line under the screen says why already.)
        why: !count || said
          ? ''
          : card
            ? 'La carte graphique est restée prise.'
            : reloaded
              ? `Page rechargée : ${count > 1 ? `les ${count} demandes attendent` : 'la demande attend'} « Reprendre ».`
              : stopped
                ? 'Génération arrêtée.'
                : '',
        card: Boolean(count) && card,
        stopped,
        note: (waiting.length || count) && queue.full() ? QUEUE_FULL : '',
        held: count && !said && !card ? held : '',
        foot:
          !count || said
            ? null
            : card
              ? {
                  label: 'Libérer le GPU',
                  icon: 'chip',
                  recover: true,
                  tip:
                    'La carte graphique est restée prise par la dernière génération : la libérer.' +
                    ' La file attendra « Reprendre ».',
                  clear,
                }
              : {
                  label: `Reprendre · ${count}`,
                  icon: 'go',
                  held: Boolean(held),
                  tip:
                    held === BOBINE_HELD
                      ? 'La Bobine fait une prise : attendez sa fin, puis reprenez la file.'
                      : held || `Reprendre la file : ${goes}${inOrder}`,
                  clear,
                },
      };
    });
  }
  /**
   * (0.6.478, Q3) Requests resumed while a take followed again after a reload was made (the window's « Reprendre »):
   * they go once it is over, in their order, as those that follow a take of the Studio; the work of the page is theirs
   * from then. Stopped meanwhile: paused again (D3: nothing goes again by itself).
   */
  function goOn(stopped = false) {
    const next = working || chaining || settling ? null : queue.next();
    if (!next) return;
    if (stopped) {
      queue.pause('stopped');
      return render();
    }
    chaining = true;
    onWork(next.conversation, next.label?.prompt ?? '');
    void proceed({ entry: next, follows: true });
  }
  /**
   * (0.6.478, variante A) Where the window at the bottom right lies in the Studio: under the settings, at their width,
   * its foot on the foot of the screen; `room`, the height left there; `over`, the height from the top of the settings
   * (opened over them where there is no room). null while the Studio is not on screen, or its blocks are not side by
   * side (a narrow window: it stays in its corner).
   */
  function queueDock() {
    const box = selector => document.querySelector?.(`#studio-view ${selector}`)?.getBoundingClientRect?.(),
      settings = box('.studio-block.is-settings'),
      screen = box('.studio-block.is-preview'),
      tall = document.documentElement?.clientHeight ?? 0;
    if (!settings?.width || !screen?.width || !tall || settings.left < screen.right) return null;
    return {
      left: Math.round(settings.left),
      width: Math.round(settings.width),
      bottom: Math.round(tall - screen.bottom),
      room: Math.floor(screen.bottom - settings.bottom - 16),
      over: Math.floor(screen.bottom - settings.top),
    };
  }
  /**
   * What the line under the screen says of the requests paused here, after what stopped them: « Arrêter » (its
   * « Génération arrêtée. » said before), the card held, the page reloaded (D3: nothing goes again by itself).
   */
  function waitLine(waits, card) {
    if (!waits.length || working || chaining) return '';
    const them =
      waits.length > 1 ? `les ${waits.length} demandes de la file attendent` : 'la demande de la file attend';
    if (card) return `La carte graphique est restée prise : ${them}.`;
    if (waits.some(entry => entry.reason === 'reload')) return `Page rechargée : ${them} « Reprendre ».`;
    return `${them[0].toUpperCase()}${them.slice(1)} « Reprendre ».`;
  }
  function improvable() {
    const go = document.querySelector?.('#studio-view .studio-enrich-go');
    if (!go || enriching) return;
    // (0.6.466, B4) Greyed while a take is made, with why (its bubble said what it does).
    const held = working || chaining ? WAND_HELD : '';
    go.disabled = Boolean(held) || !improves() || dictating();
    go.title = held || (dictating() ? DICTATING : improveTitle());
  }
  /** The chat model rewrites what is typed as a full prompt; what was typed can be taken back. */
  async function enrich() {
    // (0.6.317) Never on a page whose prompt is not shown (Agrandir, Interpoler, Changer la caméra): Ctrl+E sent
    // the prompt of Image hidden behind « Agrandir », and wrote it again.
    if (enriching || finishOn() || refilming()) return;
    // (0.6.466, B4) Nor while a take is made: the model of the chat has left the card for it. Said, not silent.
    if (working || chaining) return notice(WAND_HELD);
    // (0.6.452) Nor on a prompt the dictation is still saying (Ctrl+E): its words come after.
    if (dictating()) return notice(DICTATING);
    const draft = drafts[mode],
      text = draft.prompt.trim(),
      scene = sceneInputs();
    if (!improves()) {
      failure = current()?.follows ? 'Ajoutez d’abord la vidéo et le personnage.' : 'Écrivez d’abord quelques mots.';
      return render();
    }
    const reason = blocked();
    if (reason) return notice(reason);
    // What it is asked for: the verb, the conversation and the mode in hand now. The chat model may
    // take seconds to come back and to write: the user may open another conversation meanwhile.
    const verb = verbOf(),
      home = conversation(),
      epoch = draftsEpoch,
      asked = mode,
      moved = () => epoch !== draftsEpoch || asked !== mode;
    enriching = true;
    enrichEpoch = epoch;
    failure = '';
    render();
    const controller = new AbortController();
    try {
      // The chat model is started when it is not running, once it has finished leaving.
      await releasing;
      await waitForModel(api, controller.signal, () => {});
      const result = moved()
        ? null
        : await (
            await api('studio/enrich', {
              prompt: text,
              verb,
              // (0.6.282) The family of the model in hand: Qwen-Image-Edit is asked an instruction to edit its images.
              ...(current()?.family ? { family: current().family } : {}),
              // Its video or its character made in the conversation are found there.
              ...(scene ? { ...scene, conversationId: home } : {}),
            })
          ).json();
      // Answered once another conversation or another mode is shown: the drafts are theirs now (the
      // same objects, emptied and set again), and the prompt of the one it was asked in is no
      // longer in the Studio. Written all the same, it replaced the prompt of the conversation open.
      if (moved()) {
        notice('Prompt non enrichi : la conversation ou le mode a changé entre-temps.');
        return;
      }
      draft.before = text;
      // The text rewritten writes itself in the box, in half a second (at once with less motion).
      const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
      if (box && pointer && !pointer.reduced()) {
        const step = Math.max(2, Math.ceil(result.prompt.length / 36));
        for (let index = step; index < result.prompt.length + step; index += step) {
          box.value = result.prompt.slice(0, index);
          box.scrollTop = box.scrollHeight;
          await wait(14);
        }
      }
      draft.prompt = result.prompt;
      notice('');
    } catch (error) {
      notice('Prompt non enrichi : ' + error.message);
    } finally {
      enriching = false;
      onChange();
      render();
    }
  }
  /**
   * The prompt of a replacement whose character Moodix AI has just made, written from the video
   * and that image as the wand writes it: the chat model comes back for it (the generator of the
   * image leaves the card to it), with what the user asked and the prompt of Moodix AI as a draft.
   * When it cannot be, the prompt of Moodix AI stays and the Studio says why.
   */
  async function writeScene(current) {
    const draft = drafts[current.mode],
      scene = sceneInputs(),
      { signal } = current,
      before = draft.prompt;
    if (!scene) return;
    enriching = true;
    render();
    try {
      await releasing;
      await waitForModel(api, signal, () => {});
      const result = await (
        await api(
          'studio/enrich',
          {
            prompt: String(current.request.scene?.asked ?? ''),
            draft: before.trim(),
            verb: 'replace_character',
            ...scene,
            conversationId: conversation(),
          },
          { signal },
        )
      ).json();
      // The user wrote their own meanwhile: theirs stays.
      if (draft.prompt !== before) return;
      draft.before = before;
      enriching = false;
      render();
      if (ai && !ai.stopped) await typePrompt(draft, result.prompt);
      draft.prompt = result.prompt;
    } catch (error) {
      // Stopped with the turn: nothing to say.
      if (!signal?.aborted) notice('Prompt de Moodix AI gardé : ' + error.message);
    } finally {
      enriching = false;
      render();
    }
  }
  /**
   * In the corner of the prompt, inside its box: the wand that improves it (its name for screen
   * readers and in its tooltip, with its shortcut), and once used the arrow back to what was typed.
   */
  function enrichRow() {
    const draft = drafts[mode],
      row = node('div', 'studio-enrich'),
      label = enriching ? 'Enrichissement du prompt…' : 'Enrichir le prompt',
      make = aiTarget(button('studio-enrich-go', '', enrich, 'wand'), 'enrich');
    make.append(node('span', 'sr-only', label));
    make.setAttribute('aria-label', label);
    make.setAttribute('aria-keyshortcuts', MODIFIER === '⌘' ? 'Meta+E' : 'Control+E');
    make.title = enriching ? 'Moodix AI enrichit votre texte…' : improveTitle();
    if (enriching) {
      make.classList.add('is-working');
      make.setAttribute('aria-busy', 'true');
    }
    make.disabled = enriching || Boolean(working) || chaining || !improves();
    // (0.6.466, B4) A take being made: greyed with why, its bubble said what it does.
    if (!enriching && (working || chaining)) make.title = WAND_HELD;
    // Moodix AI is taken by a work of another conversation (0.6.81): greyed, and why.
    const taken = !enriching && !working && !answering() && !checking ? elsewhere() : '';
    if (taken) {
      make.disabled = true;
      make.title = taken;
    }
    // (0.6.452) The wand waits for the words of the dictation: it would rewrite a prompt still being said.
    if (dictating() && !enriching) {
      make.disabled = true;
      make.title = DICTATING;
    }
    // (0.6.452) The microphone first, at the left of « Revenir à mon texte » and of the wand (D8).
    const mic = micOf();
    if (mic) row.append(mic);
    if (draft.before !== null && !enriching && !locked()) {
      const back = button(
        'studio-link',
        '',
        () => {
          draft.prompt = draft.before;
          draft.before = null;
          render();
        },
        'undo',
      );
      back.append(node('span', 'sr-only', 'Revenir à mon texte'));
      back.setAttribute('aria-label', 'Revenir à mon texte');
      back.title = 'Revenir à mon texte';
      row.append(back);
    }
    row.append(make);
    return row;
  }
  // (0.6.452) While the dictation listens or writes in the prompt: « Générer » and the wand wait for its words.
  const dictating = () => Boolean(dictation?.busy('studio')),
    // (0.6.455) What « Générer » was before the dictation greyed it ([disabled, title]), given back at its end.
    undictated = new WeakMap();
  /**
   * The microphone of the dictation, greyed while Moodix AI rewrites the prompt. (0.6.455) Its box holds the prompt of
   * a conversation and of a mode (as enrich() says it): « Vidéo » clicked during « Transcription… », the words went at
   * the end of the prompt of Vidéo.
   */
  const micOf = () =>
    dictation?.mic('studio', {
      held: () => (enriching ? 'Moodix AI enrichit votre texte…' : ''),
      scope: () => `${draftsEpoch}:${mode}`,
    }) ?? null;
  /** (0.6.452, D8b) Son has no wand: the microphone alone in the corner of its prompt. */
  function micRow() {
    const mic = micOf();
    if (!mic) return null;
    const row = node('div', 'studio-enrich');
    row.append(mic);
    return row;
  }
  // The buttons follow the dictation, without drawing the Studio again (the prompt keeps its focus).
  dictation?.watch(() => {
    goable();
    improvable();
  });

  // ------------------------------------------------------------------ the tries (« × 1 »)
  // (0.6.253) How many takes « Générer » makes at once, 1 to 4 (generer-maquette.md). (0.6.254) One after the other,
  // the same settings, a new seed for each (generate). Back to 1 when another page of the Studio is chosen (Image,
  // Vidéo, Son: setMode) and once a take is made in the Chat (unwatch) or the Bobine (generate): those make one.
  // (0.6.260) `triesIn`: the page it was chosen in. Back to 1 whatever changes the page (render): « Afficher dans le
  // Studio », a conversation opened whose last take is of another kind, a take of the Chat shown, not only the tabs.
  // `seriesStopped`: « Arrêter » pressed between two takes of a series, when nothing is being made to stop.
  let tries = 1,
    triesOpen = false,
    triesIn = null,
    seriesStopped = false;
  const TRIES = [1, 2, 3, 4];
  /** (0.6.260) Back to one try when the page of the Studio is no longer the one it was chosen in. */
  function triesFollowPage() {
    if (triesIn !== mode) tries = 1;
    triesIn = mode;
  }
  /**
   * (0.6.260) Why « × n » is greyed, '' when it is not: the page Agrandir (Interpoler) makes one take, as a proposal of
   * Moodix AI does (its « Générer » answers it, once). They made 3 identical enlargements, or showed « × 3 » for one.
   */
  function triesHeld() {
    const finish = finishOn();
    if (finish) return FINISH[finish.verb].once;
    return answering() ? 'Une proposition de Moodix AI se génère une fois.' : '';
  }
  /**
   * (0.6.253) « × 1 ⌄ », at the left of the glass of « Générer »: a fine grey ×, the count in Jost, its arrow.
   * (0.6.254) Pressed, its list under it, opaque (#121116): × 1 to × 4, a check on the one chosen.
   * (0.6.454) The number alone, without the × before it, in the button and in its list (27/11: « enleve le "x" devant
   * le "x1", je veux juste le numero, c'est plus beau »).
   */
  function triesButton() {
    const pick = greyable(node('button', 'studio-tries')),
      menu = node('div', 'glass-menu studio-tries-menu'),
      // (0.6.260) Greyed with why (triesHeld), at one: what « Générer » makes there.
      held = triesHeld();
    if (held) triesOpen = false;
    pick.type = 'button';
    pick.append(node('span', 'studio-tries-count', String(held ? 1 : tries)), icon('tries-down'));
    pick.title = held || 'Essais : combien en faire d’un coup';
    pick.setAttribute('aria-label', `Essais : ${held ? 1 : tries}`);
    pick.setAttribute('aria-haspopup', 'menu');
    pick.setAttribute('aria-expanded', String(triesOpen));
    pick.disabled = Boolean(held);
    const show = () => {
      openPopup(menu, pick, { align: 'start' });
      menu.querySelector?.('.glass-menu-item.is-on')?.focus?.();
    };
    pick.onclick = () => {
      // Greyed, it answers with its reason in its bubble, as « Générer » does (pressGo).
      if (pick.disabled) return void queueMicrotask(() => sayTip(pick));
      // One list open at a time, as for « Ajouter » (0.6.204).
      if (addOpen) closeAdd();
      triesOpen = !triesOpen;
      pick.setAttribute('aria-expanded', String(triesOpen));
      if (triesOpen) show();
      else closePopup(menu);
    };
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Essais');
    menu.hidden = !triesOpen;
    for (const count of TRIES) {
      const item = button('glass-menu-item' + (count === tries ? ' is-on' : ''), '', () => {
        tries = count;
        closeTries({ refocus: true });
        render();
      });
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(count === tries));
      item.setAttribute('aria-label', count === 1 ? '1 essai' : `${count} essais`);
      item.append(node('span', 'studio-tries-count', String(count)));
      if (count === tries) item.append(icon('check'));
      menu.append(item);
    }
    menu.onkeydown = event => {
      const items = [...(menu.querySelectorAll?.('.glass-menu-item') ?? [])],
        at = items.indexOf(document.activeElement),
        to = { ArrowDown: at + 1, ArrowUp: at + items.length - 1, Home: 0, End: items.length - 1 }[event.key];
      if (event.key === 'Tab') return closeTries();
      if (event.key !== 'Escape' && to === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') closeTries({ refocus: true });
      else items[to % items.length]?.focus?.();
    };
    // Left open while the Studio is drawn again: shown once it is on the page (as « Ajouter »).
    if (triesOpen) globalThis.queueMicrotask?.(() => menu.isConnected && triesOpen && show());
    return { pick, menu };
  }
  function closeTries({ refocus = false } = {}) {
    triesOpen = false;
    const pick = document.querySelector?.('#studio-view .studio-tries'),
      menu = document.querySelector?.('#studio-view .studio-tries-menu');
    if (menu) closePopup(menu);
    pick?.setAttribute?.('aria-expanded', 'false');
    if (refocus) pick?.focus?.();
  }
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (triesOpen && !event.target?.closest?.('.studio-tries, .studio-tries-menu')) closeTries();
    },
    true,
  );
  /**
   * (0.6.254) The next try of a series: what the first asked, with a new seed. The seed the user named goes with
   * the first one only; a model that draws one by itself draws again; a seed « Fixe » of its model is replaced.
   */
  // (0.6.319) The model of the first try (request): a continuation is left once its first try is made, and current()
  // then read the model of Vidéo (a seed « Fixe » of the model of the continuation, and no new seed went).
  function anotherTry(wanted, workflow = wanted.model ?? current()) {
    const seed = Math.floor(Math.random() * 2 ** 31),
      args = { ...wanted.args },
      edits = { ...wanted.edits };
    if ('seed' in args) args.seed = seed;
    else if ('seed' in edits || Number.isSafeInteger(workflow?.seedFixed)) edits.seed = seed;
    return { ...wanted, args, edits };
  }

  // ------------------------------------------------------------------ generation
  function request() {
    const draft = drafts[mode],
      workflow = current(),
      verb = verbOf(),
      prompt = draft.prompt.trim();
    if (!workflow) throw Error('Aucun modèle prêt pour cette création.');
    // (0.6.256) Agrandir, Interpoler: the take, the model of the page named, its factor; no prompt, no setting.
    const finish = finishOn();
    if (finish) {
      const args = { source: outputSource(finish.record), workflow: workflow.id, intention: FINISH[finish.verb].intention(mode) },
        factor = finishFactor(workflow);
      if (factor !== null) args[workflow.finish.key] = factor;
      return { verb, args, edits: {}, styles: [], finish: { verb: finish.verb, record: finish.record } };
    }
    // (0.6.240) A clip filmed again needs no prompt: the clip says what is filmed.
    if (!prompt && !refilming())
      throw Error(
        workflow?.follows
          ? 'Écrivez un prompt, ou cliquez sur la baguette : il sera écrit d’après la vidéo et le personnage.'
          : 'Écrivez un prompt.',
      );
    const args = { prompt },
      edits = {};
    // Named when its verb has several: the models of another verb of the list are not its rivals.
    // A continuation is not named (the server gives it the model of its clip), unless its clip is a
    // file of the disk, which no model made: the one chosen here.
    if (offered(verb).length > 1 && (!extending || !extending.workflowId)) args.workflow = workflow.id;
    if (mode === 'video')
      args.intention = extending
        ? 'Suite demandée dans le Studio.'
        : workflow.follows
          ? 'Personnage remplacé, demandé dans le Studio.'
          : 'Création demandée dans le Studio.';
    // A continuation starts from its clip; the inputs it also takes (subject references) follow.
    if (extending) args.source = outputSource(extending);
    // (0.6.240) « Changer la caméra »: the pose held, or the one of the end with the one of the start. No
    // prompt: the one in the draft is of another video, and the server knows the one of the clip.
    if (refilming()) {
      // (A camera the model does not make: « Changer la caméra » is greyed and says it; its keys still come here.)
      const held = refilmRefusal(workflow);
      if (held) throw Error(held);
      Object.assign(args, orbitArgs(orbitState(workflow).state), { intention: 'Caméra changée, demandée dans le Studio.' });
      // (0.6.250) The size it is filmed again at, chosen on its bar.
      const { size } = refilmChoice(workflow);
      if (size) args.size = { width: size.width, height: size.height };
      delete args.prompt;
    }
    // What the model cannot do without is asked for here, in the user's words (0.6.102: by its
    // role; an image to modify was asked for as « l’image du personnage »). (0.6.188) « Générer » is
    // greyed meanwhile and says the same (inputMissing): its keys still come here.
    const lacking = inputMissing(workflow, draft.inputs, extending);
    if (lacking) throw Error(lacking);
    for (const [role, spec] of Object.entries(workflow.roles)) {
      if (extending && role === 'source') continue;
      // Never an input without a source (an image of a proposal that was joined to its message).
      const chosen = (draft.inputs[role] ?? []).filter(item => item?.source).map(item => item.source);
      if (!chosen.length || !spec.count) continue;
      // Several references go as a list; a single one (the character of a video) alone.
      args[role] = (spec.many ?? role === 'reference') ? chosen.slice(0, spec.count) : chosen[0];
    }
    if (workflow.lengths?.seconds.length) args.duration = draft[extending ? 'extension' : 'length'];
    // (0.6.211) The camera set, with a model that takes it: its movement, and its speed when it has one. The
    // prompt goes as it is written; the server adds the sentence the window of the piece shows.
    // (0.6.222) With a model that reads the camera itself (Wan 2.2 Caméra), the movement and its speed are two
    // of its settings, changed by the user's own hand: nothing is added to the prompt. A movement the model in
    // hand does not make is refused here, in words, never left out without a word.
    const camera = workflow.camera && !extending ? cameraMade(draft.camera) : null;
    if (camera) {
      const why = cameraRefusal(workflow, camera.move);
      if (why) throw Error(`Caméra : « ${cameraLabel({ move: camera.move })} » ne part pas avec ${workflow.name}. ${why}`);
      if (workflow.camera.moves) {
        edits.camera = camera.move;
        if (workflow.camera.speed && cameraHasSpeed(camera.move)) edits.camera_speed = cameraSpeedValue(camera.speed);
      } else {
        args.camera = camera.move;
        if (cameraHasSpeed(camera.move)) args.camera_speed = camera.speed;
      }
    }
    if (workflow.limits && draft.size && !extending) {
      const [width, height] = draft.size.split('x').map(Number);
      if (workflow.direct) Object.assign(args, { width, height });
      else Object.assign(edits, { width, height });
      // A large picture is a final, a small one a draft: the profile only names it here.
      if (workflow.stages) args.stage = stageOf(workflow);
    }
    const seedFixed = Number.isSafeInteger(workflow.seedFixed) ? workflow.seedFixed : null;
    if (draft.seed.trim() && (workflow.seeded || seedFixed !== null)) {
      const seed = Number(draft.seed);
      if (!Number.isSafeInteger(seed) || seed < 0)
        throw Error(
          seedFixed !== null
            ? 'Seed : un entier positif, ou vide pour celle du modèle.'
            : 'Seed : un entier positif, ou vide pour un tirage.',
        );
      // (0.6.102) A seed « Fixe » holds Moodix AI, not the user: changed here, it is the user's own change.
      if (workflow.seeded) args.seed = seed;
      else edits.seed = seed;
    }
    const store = (draft.settings[workflow.id] ??= {});
    for (const setting of workflow.settings) {
      const value = store[setting.key];
      if (value === undefined || value === '') continue;
      // Read only with an input that does not go with this creation (« Débruitage » without an
      // image to modify): greyed here, and not sent.
      if (setting.onlyWith && onlyInputs(workflow, setting).every(input => args[input] === undefined)) continue;
      // (0.6.102) Within the bounds of the workflow, as the field then shows it: beyond them, the
      // nearest one. A switch is on or off (« false » went as the number 0, refused).
      const made = settingValue(setting, value);
      store[setting.key] = made;
      // What the workflow fixes holds Moodix AI: changed here, it is the user's own change of the
      // proposal (as on its card in the Chat), sent with the size it fixes too. As it is, nothing goes.
      if (setting.fixed) {
        if (made !== setting.default) edits[setting.key] = made;
      } else args[setting.key] = made;
    }
    // The LoRAs of the workflow left to the assistant, as chosen here.
    const loras = loraArgs(workflow, draft);
    if (loras) args.loras = loras;
    const styles = workflow.styled && mode !== 'audio' && !extending ? draft.styles.filter(style => style.name) : [];
    return { verb, args, edits, styles, model: workflow };
  }
  // The user sets the Studio to make something: the chat model leaves the GPU now, not at the
  // first « Générer ». Asked in the background, never under an answer, a message waiting for the
  // model or a proposal of Moodix AI; a refusal changes nothing, a generation unloads it anyway.
  function release() {
    if (released || releasing || working || enriching || proposal || ai || blocked()) return;
    released = true;
    releasing = api('studio/release', {})
      .then(() => onChange())
      .catch(() => {})
      .finally(() => {
        releasing = null;
      });
  }
  /**
   * An action on the take on the screen (output-actions.mjs): Prolonger and Animer set the Studio as
   * before; Agrandir et affiner and Interpoler are made at once, from that take.
   */
  function takeAction(record, id) {
    // (0.6.260) Said, never silent: from the Chat or the Archives, the Studio opened and nothing happened in it.
    if (working) return notice(whyNot() || BUSY_HERE);
    if (proposal) return notice('Moodix AI est en train de proposer');
    if (id === 'animate') return animateImage(record);
    if (id === 'extend') return actionsOf(record).find(action => action.id === 'extend')?.run();
    if (id === 'refilm') return actionsOf(record).find(action => action.id === 'refilm')?.run();
    // (0.6.256, lot 4) Agrandir and Interpoler prepare their page and wait for its button: made at once before.
    if (id === 'upscale' || id === 'interpolate') finishTake(record, id);
  }
  /**
   * (0.6.256, captures A04 and B08) The page Agrandir (or Interpoler) of a take: in the page of its kind, the take on
   * the screen and in its case « À agrandir », the prompt greyed (it needs none), at the right the model and its
   * factor, « ▶ Agrandir » under the screen. Pressed again on its page, or its × pressed: left, as Prolonger is.
   */
  function finishTake(record, verb) {
    if (working) return notice(whyNot() || BUSY_HERE);
    if (proposal) return notice('Moodix AI est en train de proposer');
    if (finishOn()?.verb === verb && finishing.record.id === record.id) return leaveFinish();
    const kind = mediaOf(record);
    leaveLook();
    if (mode !== kind) setMode(kind);
    // (0.6.260) A page of its own: one try, as after « Animer » (it kept « × 3 » and made three enlargements).
    tries = 1;
    extending = null;
    refilmId = null;
    finishing = { verb, record, workflow: null, factor: null };
    kept[kind] = record;
    failure = '';
    menuFor = confirmFor = null;
    pieceOpen = null;
    render();
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  /** (0.6.256) The page Agrandir or Interpoler left: the page of its kind as it was, the take still on the screen. */
  function leaveFinish() {
    finishing = null;
    render();
  }
  /** (0.6.256) The factor sent with the model of the page: the one chosen, or the one it starts from. */
  function finishFactor(workflow) {
    const spec = workflow?.finish;
    if (!spec?.key) return null;
    const wanted = spec.choices.includes(finishing?.factor) ? finishing.factor : spec.standard,
      // (0.6.450) Not one the card of this computer cannot make while it can make another: × 2 where × 4 is
      // beyond it. When none can be made, the one wanted stays, greyed, and nothing is made (finishHeld).
      can = value => !finishing?.record || !finishRefusal(workflow, finishing.record, value);
    return can(wanted) ? wanted : (spec.choices.find(can) ?? wanted);
  }
  /**
   * (0.6.261) The size a factor gives the take of the page, as its engine makes it: held by the largest side the
   * model makes (Real-ESRGAN for a clip: 3840; SeedVR2: 8192), each side then reduced as the engine rounds it
   * (Python: a half to the even): an even one for Real-ESRGAN, at least 16. Null when the size of the take is
   * not known.
   */
  function finishSize(spec, record, value) {
    const source = sizeOfRecord(record);
    if (!source || !value) return null;
    const wide = source.width * value,
      high = source.height * value,
      largest = Math.max(wide, high);
    if (!(spec.maxSide && largest > spec.maxSide)) return { width: Math.round(wide), height: Math.round(high) };
    const ratio = spec.maxSide / largest,
      side = length => (spec.even ? Math.max(2, roundHalfEven((length * ratio) / 2) * 2) : Math.max(16, roundHalfEven(length * ratio)));
    return { width: side(wide), height: side(high) };
  }
  /**
   * (0.6.450) Why the card of this computer cannot make the take that many times larger with this model: more
   * pixels than its memory holds (`maxPixels`, which the engine says from the memory of the card: SeedVR2, 5120 ×
   * 5120 made and 6144 × 6144 not on 12 Go, 26/11). '' when it can, and when nothing says it cannot.
   */
  function finishRefusal(workflow, record, value) {
    const spec = workflow?.finish,
      made = spec && Number.isFinite(spec.maxPixels) ? finishSize(spec, record, value) : null;
    if (!made || made.width * made.height <= spec.maxPixels) return '';
    return `× ${value} donnerait ${made.width} × ${made.height} : c’est trop pour la mémoire de la carte graphique de cet ordinateur.`;
  }
  /** (0.6.450) Why the page Agrandir makes nothing here: the factor it would send is beyond the card. */
  function finishHeld(workflow) {
    const finish = finishOn(),
      spec = workflow?.finish;
    return finish && spec ? finishRefusal(workflow, finish.record, spec.key ? finishFactor(workflow) : spec.factor) : '';
  }
  async function generate(given = null) {
    // (0.6.175) A take of the Bobine that cannot begin is refused with its reason, said there: it got
    // nothing back, and noted « Échec · La création n'a pas pu commencer. », with a notice from here beside it.
    const refuse = why => {
      if (given?.montage) throw Object.assign(new Error(why), { refused: true });
    };
    // (0.6.466) A request of the queue (`entry`), and whether it follows the take just made (`follows`, as the next try
    // of a series does): then it goes in the conversation it was asked in, wherever the page is meanwhile (D9).
    const entry = given?.entry ?? null,
      follows = Boolean(given?.again || given?.follows);
    // (Nor from the Studio of another conversation than the one whose work it holds, 0.6.87.)
    if (working || (away() && !follows)) return refuse(whyNot() || BUSY_HERE);
    // An action on a take brings what to make; « Générer » (a click, its keys) does not. (0.6.254) Nor the next try
    // of a series (`again`): what the first one asked, a new seed, and where the series is.
    const onTake = given?.verb ? given : null,
      again = given?.again ?? null;
    // A proposal of Moodix AI or its character came meanwhile: they are answered first, the series ends there.
    if (again && (checking || answering())) return;
    // The character being checked: the key that generates keeps it, where the question is asked
    // (Image, the button reads « OK »). From another mode, where it reads « Générer », it is no
    // answer: the question comes back on screen instead of being taken for a yes.
    if (!onTake && !entry && checking) {
      if (mode === 'image') return checking.resolve('ok');
      setMode('image');
      return notice('Ce personnage vous convient ? Répondez d’abord : OK, Autre image ou Annuler.');
    }
    if (!onTake && !entry && !follows && answering()) return approve();
    // No creation of its own while the take just made is put on its screen (0.6.88): its end would
    // have ended this one's work. (An answer to Moodix AI above is no such creation.)
    if (settling) return refuse(BUSY_HERE);
    // (0.6.466) What follows a take of the Studio is not held by that take, the work of the page (`blocked(true)`); a
    // request of the queue says itself what its model cannot do (the server's reason, on its tile).
    const reason = follows ? blocked(true) : blocked() || (onTake || entry ? '' : current()?.unavailable);
    if (reason) {
      refuse(reason);
      // (0.6.466) It waits at its place with those after it, for « Reprendre »: nothing goes again by itself.
      const left = again ? again.series.total - again.series.at + 1 : entry?.tries;
      if (follows) holdRest(entry ?? again.entry, left, reason, Boolean(again));
      return notice(reason);
    }
    let wanted;
    try {
      wanted = onTake ?? again?.wanted ?? (entry ? entryWanted(entry) : request());
      // (0.6.466) A request of the queue at a try after its first one (found again after a reload, held by the card
      // between two tries): a seed of its own, as the next try of a series has.
      if (entry?.later) wanted = anotherTry(wanted);
    } catch (error) {
      // (0.6.466) A request of the queue that cannot be read again (its model gone): a tile in failure, with why.
      if (entry) queue.fail(entry.id, error.message);
      else failure = error.message;
      return render();
    }
    // Asked once the creation can go (0.6.90): asked before, a « yes » cost the conversation set aside
    // for a creation that then did not go (an image missing, a seed refused).
    // (The user said no to what it costs: nothing to say again in the Bobine.)
    // (0.6.254) Once for a series: its first try. (0.6.466) Once for a queue: its first request.
    if (!follows && !mayBegin()) return refuse('');
    // (0.6.254) « × 3 »: three takes one after the other, said on « Générer » (« 1 SUR 3 · 46 % »). Not a take
    // of the Bobine nor an action on a take, which make one; a take of the Bobine puts the tries back to 1.
    // (0.6.260) Nor the page Agrandir (Interpoler): it made the same enlargement three times.
    triesFollowPage();
    // (0.6.466) A request of the queue with the tries it was asked with (D2: one request, its tries one after the
    // other).
    const asks = entry ? entry.tries : tries,
      series = onTake || wanted.finish ? null : (again?.series ?? (asks > 1 ? { at: 1, total: asks } : null));
    if (onTake?.montage) tries = 1;
    // (0.6.466) A take of the Studio is a request of its queue from its start: kept in the tab with its tries (B1), at
    // its place among the others, with what it was asked with (its draft: its screen, and its tile if it fails).
    let asking = entry ?? again?.entry ?? null;
    if (!onTake) {
      if (entry) queue.start(entry.id);
      else if (asking) queue.tried(asking.id, series?.at ?? 1);
      else asking = queue.begin(requestEntry(wanted, series?.total ?? 1));
    }
    // (0.6.260) A creation that begins: no « Arrêter » of a former series held for it, and the list of the tries
    // closed (left open by Ctrl+Entrée, it opened again at the end of the take and took the focus).
    if (!again) seriesStopped = false;
    // (0.6.466) Not by a take that follows another: the list is the user's, opened for the next request.
    if (!follows) triesOpen = false;
    failure = '';
    // (0.6.177, « studio ne suit pas exactement ce que fait bobine ») A take of the Bobine is followed here as
    // a take of the Chat is (watch): the Studio kept as it is, then the mode of the take at once, and its
    // settings once the server has said them. It stayed in the mode it was left in: « Krea 2 », the prompt of
    // an image, a screen at the wrong format, while LTX 2.5 made a video for the Bobine.
    let followed = null;
    if (onTake?.montage && info) {
      leaveLook();
      followed = { before: asItIs() };
      mode = MODE_OF_VERB[wanted.verb] ?? mode;
    }
    const controller = new AbortController(),
      // Where the creation will be kept once made: the mode it was asked in. (0.6.466) A request of the queue: its own.
      asked = asking ? asking.mode : mode;
    let made = null,
      result = null,
      // (0.6.148) Why a take of the bobine was not made: said there, never on the form of a mode.
      refused = '',
      // (0.6.176) Stopped, from here (« Arrêter ») or on the server (the Chat's « Interrompre la réponse »,
      // a card answered « Annuler »): a stop, wherever it came from, and said with one word.
      halted = false,
      // (0.6.466) The card still taken when a request that follows another went: it waits for it, then goes again.
      busyCard = false;
    // (`montage`: asked by the montage, which shows it being made on its own timeline.)
    // (0.6.182) `tell`: what the Bobine hears of it, its step, how far it is, its picture so far, and how long it
    // has been (the count of the Studio, as its own line under « Générer » says it).
    working = {
      // (0.6.256) Agrandir, Interpoler: their first step said, their take shown while it is made (stage).
      label: wanted.finish ? FINISH[wanted.finish.verb].step : 'Préparation…',
      fraction: null,
      controller,
      montage: Boolean(onTake?.montage),
      series,
      ...(wanted.finish ? { finish: wanted.finish } : {}),
      ...(onTake?.montage?.onProgress ? { tell: () => working && onTake.montage.onProgress(working.label, working.fraction, working.preview, working.time) } : {}),
      // (0.6.466) Its request in the queue, and what it was asked with: the screen shows it, the form is free.
      ...(asking ? { entry: asking, look: asking.look } : {}),
    };
    chaining = false;
    // Its conversation from its first instant (0.6.81): the page may show another meanwhile, the
    // creation is still this one's, and the page follows it there. (0.6.466) A request of the queue: the one it was
    // asked in, with its project, the page held from the take before it (`follows`).
    const conversationId = ((entry || again) && asking?.conversation) || (await ensureConversation()),
      projectId = (entry || again) && asking?.project ? asking.project : project();
    if (asking && (asking.conversation !== conversationId || asking.project !== projectId))
      queue.set(asking.id, { conversation: conversationId, project: projectId });
    holdAt(conversationId, projectId);
    if (!follows) onWork(conversationId, wanted.args?.prompt ?? '');
    render();
    onChange();
    const pause = () => new Promise(resolve => setTimeout(resolve, 700));
    // (0.6.324) Stopped while the server answered: the request it made there is cancelled, as stop() does once it
    // knows it (pressed before tools/action answered, it stayed waiting on the server for its 15 minutes).
    const cancelIfStopped = id => {
      if (!controller.signal.aborted) return;
      if (id) api('tools/cancel', { requestId: id }).catch(() => {});
      controller.signal.throwIfAborted();
    };
    try {
      await releasing;
      let proposed = await (
        await api('tools/action', {
          conversationId,
          // Its takes are numbered in this project (« PRISE n »).
          project: project(),
          studio: true,
          name: wanted.verb,
          arguments: wanted.args,
          ...(wanted.styles.length ? { styles: wanted.styles } : {}),
          // (0.6.144) A plan of the montage: at the size of its film, set by the server for the model it chooses.
          ...(wanted.size ? { size: wanted.size } : {}),
        })
      ).json();
      working.requestId = proposed.requestId;
      cancelIfStopped(proposed.requestId);
      // The size chosen here, where the workflow sets its own.
      const shown = proposed.plan?.parameters ?? {},
        edits = Object.fromEntries(Object.entries(wanted.edits).filter(([key, value]) => shown[key] !== value));
      if (Object.keys(edits).length) {
        proposed = await (
          await api('tools/revise', { requestId: proposed.requestId, approvalToken: proposed.approvalToken, edits })
        ).json();
        working.requestId = proposed.requestId;
        cancelIfStopped(proposed.requestId);
      }
      controller.signal.throwIfAborted();
      if (followed) {
        // What it is made with: its model, its text, its format, its length, its photos (the Flux starts from them).
        showRequest({ tool: wanted.verb, ...proposed });
        render();
      }
      if (run) {
        // In the conversation: followed and written there like a creation of the chat.
        const done = await run(proposed, {
          signal: controller.signal,
          conversationId,
          // (0.6.180) Asked in the Bobine: written so in the conversation, for the model.
          bobine: Boolean(onTake?.montage),
          // (0.6.181) Where it goes there: found again by the Bobine when the page is reloaded meanwhile.
          ...(onTake?.montage && onTake.place ? { bobinePlace: onTake.place } : {}),
          onProgress: (label, fraction, preview, time) => {
            if (!working) return;
            Object.assign(working, {
              label: typeof label === 'string' && label ? label : working.label,
              fraction: Number.isFinite(fraction) ? fraction : working.fraction,
              preview: preview ?? working.preview,
            });
            timeWork(time);
            progress();
            working.tell?.();
          },
        });
        if (!done.record) {
          halted = done.cancelled === true;
          throw Error(done.error || 'La génération a échoué.');
        }
        made = done.record.id;
      } else {
        let job = await (
          await api('tools/execute', {
            requestId: proposed.requestId,
            permission: 'once',
            studio: true,
            ...(proposed.mediaType ? { approvalToken: proposed.approvalToken } : {}),
          })
        ).json();
        const jobId = job.id;
        let listed = false;
        while (!['done', 'error', 'cancelled'].includes(job.state)) {
          Object.assign(working, {
            label: job.progress || 'Génération…',
            fraction: job.fraction ?? null,
            preview: job.previewUrl ?? working.preview,
          });
          timeWork(job.elapsed);
          // The result is shown as soon as it exists.
          if (job.record && !listed) {
            listed = true;
            await refresh().catch(() => {});
            render();
          }
          progress();
          working.tell?.();
          await pause();
          job = await (await api('tools/job')).json();
          if (job?.id !== jobId) throw Error('La génération suivie a été remplacée par une autre tâche.');
        }
        if (!job.record) {
          halted = job.state === 'cancelled';
          throw Error(job.error || 'La génération a échoué.');
        }
        made = job.record.id;
      }
      // (0.6.466) The page of a request of the queue is left only by that very request: the form was free meanwhile.
      if (extending && (!asking || asking.look.extending?.id === extending.id)) extending = null;
      // (0.6.256) A video made from the picture « Animer » put: its screen shows the take, not the picture. (0.6.261)
      // Once made only: refused or stopped, the picture stays under « DÉBUT » (it went as the video left). Not a take of
      // the Bobine, which has nothing to do with it.
      if (asked === 'video' && !onTake?.montage && (!asking || asking.look.animated === animated)) animated = null;
    } catch (error) {
      halted ||= controller.signal.aborted;
      // (0.6.466) A request of the queue found the card still taken (the server was letting the last take go): no
      // failure, it goes again once the card is free (freeAgain).
      busyCard =
        (follows || Boolean(entry)) &&
        !halted &&
        error?.status === 409 &&
        /opération GPU est déjà en cours/.test(error.message);
      const said = halted ? 'Génération arrêtée.' : error.message;
      if (onTake?.montage) refused = said;
      else if (!busyCard) failure = said;
    } finally {
      working = null;
      // (0.6.466) The request it was: made, out of the queue (unless its next try goes); stopped, out, and those
      // that wait are paused; failed, kept as a tile with its reason, and the next one goes. Asked by « Générer »
      // with nothing after it, its reason is said under the screen, as before the queue: its settings are those of
      // the form.
      const stopped = halted || controller.signal.aborted || seriesStopped,
        more = Boolean(series && made && series.at < series.total);
      if (asking && !busyCard) {
        if (stopped) {
          queue.done(asking.id);
          queue.pause('stopped');
        } else if (made) {
          if (!more) queue.done(asking.id);
        } else if (asking.queued || queue.next()) {
          queue.fail(asking.id, failure);
          failure = '';
        } else queue.done(asking.id);
      }
      // What follows it, held from now: the Studio and the work of the page stay its own until it begins.
      chaining = !onTake && !stopped && (busyCard || more || Boolean(queue.next()));
      // Held until its take is on its own screen (settling, 0.6.87).
      settling = true;
      try {
        await refresh().catch(() => {});
        // It stays on the screen, as the gallery lists it (with the addresses it is shown from).
        const record = made && runs.find(item => item.id === made);
        result = record || null;
        if (followed) {
          // (0.6.177) As after a take of the Chat (unwatch, showMade): the Studio as it was, then, made, the
          // take on its screen with its settings, the newest of the conversation. Not made: as it was.
          asItWas(followed.before);
          if (record) {
            // (The newest take of the conversation: `settle` shows its mode, and its settings when the Studio has its model.)
            // (0.6.192: the mode of that take alone, what was being written in another one stays.)
            pinned = null;
            settle();
          }
        } else {
          // (0.6.142) In the Studio of before the conversations, a take of the bobine leaves the screen of the mode as it was.
          if (record && !onTake?.montage) {
            kept[asked] = record;
            // (0.6.256) Agrandie or interpolée: on the screen, its page left (as a continuation is once made).
            if (wanted.finish && finishing?.record.id === wanted.finish.record.id) finishing = null;
            // Made from what was looked at: those settings are the user's now, nothing to come back to.
            // (0.6.466) Only by the request asked from it: the form was free meanwhile.
            if (!asking || asking.look.looked) endLook();
          }
          // (0.6.251) A clip filmed again: the server has learnt what this computer took for it (`refilm.made`),
          // which the tools read before do not say. Read again at the next change of camera.
          if (record?.parameters?.refilm) toolsStale = true;
          settledHere();
        }
      } finally {
        settling = false;
      }
      onChange();
      render();
      scrollStrip();
      // The page's work is over; left meanwhile, the Studio goes to the conversation shown. (0.6.466) Unless what
      // follows it goes now: they are one work for the page, the chat held from one to the other.
      if (!chaining) {
        onWork(null);
        letGo();
      }
    }
    // (0.6.142) Asked by the montage: the take made, or why there is none, said there and not on the form.
    if (onTake?.montage) {
      // (0.6.176) A stop is told as one (`stopped`): the Bobine notes no failure, as for its own « Arrêter ».
      if (!result) throw Object.assign(new Error(refused || 'La génération a échoué.'), halted ? { stopped: true } : {});
      return result;
    }
    if (!chaining) return;
    // (0.6.260) « Arrêter » between two takes (the take just made being put on its screen): nothing more goes.
    // (0.6.466) Its request is over, those that wait are paused (« Reprendre »).
    if (seriesStopped) {
      if (asking) queue.done(asking.id);
      queue.pause('stopped');
      failure = 'Génération arrêtée.';
      return endChain();
    }
    // (0.6.466) The card still taken: once it is free, the same take goes again, nothing made, nothing lost.
    if (busyCard) return proceed(again ? { again } : { entry: asking, follows: true }, true);
    // (0.6.254) The next try of a series: once this one is made and on its screen, not stopped nor failed.
    // (0.6.260) Stopped once its take was saved (the take is then kept, found again in the gallery: `halted` stayed
    // false and the next one went), or between two takes (seriesStopped): the series ends there too.
    // (0.6.466) In the conversation it is made in, whatever the page shows meanwhile (D9: it went on there, its notice
    // « Série arrêtée… une autre conversation a été ouverte » is no more).
    if (series && result && series.at < series.total) {
      const at = { ...series, at: series.at + 1 };
      return proceed({ again: { wanted: anotherTry(wanted), series: at, entry: asking } });
    }
    // A try made, its record not read again: its series ends there, as before.
    if (asking && queue.get(asking.id)?.state === 'running') queue.done(asking.id);
    // (0.6.466) The next request of the queue, in its turn.
    const next = queue.next();
    if (next) return proceed({ entry: next, follows: true });
    endChain();
  }
  /**
   * (0.6.466) The next try, or the next request of the queue, once the card and the page are free (freeAgain): begun,
   * it holds the Studio and the page as the take before did. One that cannot be read again is a tile in failure, the
   * next one goes. Held by the card, stopped, or refused before it began (its reason said): it waits at its place,
   * paused, with those after it; nothing goes again by itself, the Studio and the page are let go.
   */
  async function proceed(then, card = false) {
    for (;;) {
      const entry = then.entry ?? then.again?.entry ?? null,
        left = then.again ? then.again.series.total - then.again.series.at + 1 : (entry?.tries ?? 1),
        why = await freeAgain(card);
      if (why) {
        holdRest(entry, left, why, Boolean(then.again));
        if (why === 'stopped') failure = 'Génération arrêtée.';
        return endChain();
      }
      const going = generate(then);
      if (working) return going;
      const next = entry && queue.get(entry.id)?.state === 'failed' ? queue.next() : null;
      if (next) {
        then = { entry: next, follows: true };
        card = false;
        continue;
      }
      // (A try of a series held by a proposal of Moodix AI: its series ends there, as before.)
      const held = queue.running();
      if (held) queue.done(held.id);
      queue.pause('stopped');
      return endChain();
    }
  }
  /** (0.6.466) Nothing follows any more: the work of the page is over, the Studio follows the page again. */
  function endChain() {
    chaining = false;
    onWork(null);
    letGo();
    render();
  }
  /**
   * (0.6.466) A request that could not begin waits at its place, paused, with those after it, and why; `later`, at a
   * try after its first one.
   */
  function holdRest(entry, left, why, later = false) {
    const reason = why === 'card' ? 'card' : 'stopped';
    if (entry) queue.hold(entry.id, reason, left, later);
    queue.pause(reason);
    if (why !== 'card' && why !== 'stopped') failure = why;
  }
  /**
   * (0.6.466) Between two requests: the card still taken by the last take (`card`, the server letting it go: every
   * second until its generation is over), or the page busy a moment (a conversation being opened: `blocked`). '' once
   * free; 'card', the card held by the last take (« Libérer le GPU »); 'stopped', « Arrêter » meanwhile.
   */
  async function freeAgain(card) {
    cardWait = new AbortController();
    const { signal } = cardWait;
    // Said on the line of the step while it waits for the card (form, `between`).
    cardWait.card = card;
    if (card) render();
    try {
      for (let first = true; ; first = false) {
        if (card || !first) await wait(1000);
        if (signal.aborted || seriesStopped) return 'stopped';
        if (gpuBlocked()) return 'card';
        if (card) {
          let job = null;
          try {
            job = await (await api('tools/job')).json();
          } catch {
            job = null;
          }
          if (signal.aborted || seriesStopped) return 'stopped';
          if (job?.blocked) return 'card';
          if (job && !['done', 'error', 'cancelled'].includes(job.state)) continue;
          card = cardWait.card = false;
        }
        if (!blocked(true)) return '';
      }
    } finally {
      cardWait = null;
    }
  }
  function stop() {
    // (0.6.260) Between two takes of a series (the take just made being put on its screen): the next one does not go.
    // (0.6.466) Nor the next request of the queue, nor one that waits for the card: they are paused.
    if (!working) {
      if (settling || chaining) {
        seriesStopped = true;
        cardWait?.abort();
      }
      return;
    }
    if (working.external) return stopTurn();
    working.controller.abort();
    if (working.requestId) api('tools/cancel', { requestId: working.requestId }).catch(() => {});
  }
  /**
   * How long the take under way has been in the making (0.6.93), beside its step: the count of the
   * server (`time`, the fourth value of a progress), going on by itself between two of its answers;
   * for the work it was given for only (`timed`): the next one counts from its own go.
   */
  let elapsedNode = null,
    timed = null;
  const elapsed = elapsedClock(text => {
    if (!working || timed !== working) return elapsed.stop();
    working.time = text;
    if (elapsedNode) elapsedNode.textContent = text;
    // (0.6.200) In the bubble of « Générer » too, second after second (workTip).
    const go = away() ? null : document.querySelector?.('#studio-view .studio-go');
    // (0.6.466) Not « Générer ensuite »: its bubble says what it does, or why it is greyed.
    if (go && !go.classList?.contains?.('is-next')) go.title = workTip();
    // (0.6.182) A take of the Bobine: said there too, beside the step, second after second.
    working.tell?.();
  });
  function timeWork(time) {
    if (!working) return;
    if (timed !== working) {
      elapsed.reset();
      timed = working;
    }
    elapsed.update(time);
  }
  /**
   * (0.6.200) The bubble of « Générer » while a take is made: the words of the line of its step, and its time
   * (« Génération · 5/8 · 1 min 12 s »). It said « Générer (Ctrl+Entrée) » under « EN COURS · 40 % » (check of
   * 21/11, overload, problem 3). A take of the Chat followed here keeps why nothing else is made (0.6.96).
   */
  const workTip = () => (working.chat ? BUSY_HERE : [working.label, working.time].filter(Boolean).join(' · '));
  /** Updates the button and the screen alone: the form keeps its focus while a generation runs. */
  /**
   * (0.6.253) What « Générer » says while its take is made: « 46 % » (`percent`, null while unknown: « En cours… »).
   * (0.6.254) In a series, which try first: « 1 SUR 3 · 46 % », « 1 SUR 3 ».
   */
  function goLabel(percent = null) {
    const series = working?.series,
      done = percent === null ? '' : `${percent} %`;
    if (!series) return done || 'En cours…';
    return [`${series.at} SUR ${series.total}`, done].filter(Boolean).join(' · ');
  }
  /** (0.6.466) At the right of « Générer ensuite »: how far the take is, and in a series which try (« 1/3 · 46 % »). */
  function nextPercent(percent = null) {
    const series = working?.series,
      done = percent === null ? '' : `${percent} %`;
    return [series ? `${series.at}/${series.total}` : '', done].filter(Boolean).join(' · ');
  }
  function progress() {
    if (!working) return;
    if (working.preview) seenPreview = working.preview;
    // Held by another conversation than the one shown (0.6.81): the page shows that it is, not the take.
    if (away()) return;
    const go = document.querySelector?.('#studio-view .studio-go'),
      line = $('studio-progress');
    const known = Number.isFinite(working.fraction) && working.fraction !== null,
      percent = known ? Math.round(Math.min(1, Math.max(0, working.fraction)) * 100) : null;
    // (0.6.466) « Générer ensuite » over the bar that fills: how far, at its right (« 1/3 · 46 % »); its own words in
    // its bubble, never the step's, which the line under the head says.
    const next = go?.classList?.contains?.('is-next') ? go.querySelector('.studio-go-percent') : null;
    if (next) {
      go.classList.toggle('is-indeterminate', !known);
      go.style.setProperty('--studio-progress', known ? String(percent / 100) : '0');
      next.textContent = nextPercent(percent);
    } else if (go) {
      go.classList.toggle('is-indeterminate', !known);
      go.style.setProperty('--studio-progress', known ? String(percent / 100) : '0');
      const label = go.querySelector('.studio-go-label');
      // (0.6.253, A10 « En cours ») « 46 % » alone in the bar that fills (« En cours · 46 % » before).
      if (label) label.textContent = goLabel(percent);
      go.setAttribute('aria-valuenow', known ? String(percent) : '');
      go.title = workTip();
    }
    if (line) {
      line.hidden = false;
      line.textContent = working.label || '';
      // (Its time stays beside it: the words of the step change, not the count.)
      if (elapsedNode) line.append(elapsedNode);
    }
    // A sound lights its bars as it goes.
    const bars = document.querySelectorAll?.('#studio-view .studio-bars span') ?? [];
    bars.forEach((bar, index) => bar.classList.toggle('is-lit', known && index < (percent * bars.length) / 100));
    // What the generator has so far, on the screen, through the Flux (take-flux.mjs, capture 24): the
    // start image until a picture comes, else the colours of the room. The frame is rebuilt with the page.
    const frame = document.querySelector?.('#studio-view .studio-frame');
    // (0.6.256, captures A05 and B09) Not over a take being made larger or smoother: it stays seen, veiled, its band
    // of light going down over it (stage).
    // (0.6.466) The take of the Studio being made, with the images it was asked with: not those of the form, free.
    const asked = underWay()?.draft ?? drafts[mode];
    if (frame && screenMode() !== 'audio' && !frame.classList?.contains?.('is-finishing')) {
      if (flux?.frame !== frame) {
        flux?.flux.stop();
        flux = { frame, flux: takeFlux(frame, { node }) };
        // (0.6.179) As the card of the Chat chooses it (fluxStart): the start image, else the first image given.
        const start = fluxStart(
          Object.entries(asked.inputs).flatMap(([role, items]) =>
            (items ?? []).filter(Boolean).map(item => ({ role, preview: item.preview })),
          ),
        );
        if (start) flux.flux.source(start);
        else flux.flux.neutral();
      }
      if (Number.isFinite(working.fraction)) flux.flux.progress(working.fraction);
    }
    if (frame && working.preview) {
      if (live?.frame !== frame)
        live = { frame, preview: livePreview(node, frame, { onLoad: picture => flux?.flux.source(picture) }) };
      live.preview.show(working.preview);
    }
    // The creation under way at the left of the Sortie says how far it is.
    const making = document.querySelector?.('#studio-view .studio-item.is-making .studio-item-meta');
    if (making) making.textContent = known ? percent + ' %' : '';
  }

  // ------------------------------------------------------------------ Moodix AI sets the Studio
  /** Said to screen readers while the pointer works; nothing shown: a touch of the user takes over. */
  function status(on) {
    const live = $('live-status');
    if (live && on) live.textContent = 'Moodix AI règle le Studio.';
  }
  /** Where the pointer goes for a setting: the element that wears its key. */
  const targetOf = key => {
    if (key !== 'kind') return document.querySelector?.(`#studio-view [data-ai="${key}"]`);
    const tab = document.querySelector?.(`#studio-kinds [data-mode="${proposal?.mode ?? mode}"]`);
    return tab && tab.checkVisibility?.({ visibilityProperty: true }) !== false ? tab : null;
  };
  /**
   * The pointer glides to `element` (0.25 s), saying what it does; false once it was stopped. The
   * first time it appears there, without a way to go: nothing to wait for.
   */
  async function glide(element, label, anchor) {
    if (!ai || ai.stopped) return false;
    const travels = Boolean(pointer?.visible);
    pointer?.move(element, label, anchor);
    await wait(pointer?.reduced() || !travels ? 0 : 260);
    return Boolean(ai && !ai.stopped);
  }
  /**
   * One step of the pointer, the whole animation in 2 to 3 s (16/11): it goes (0.25 s), it rings, it
   * sets, it leaves a trace. `hold`: what the change itself takes, a model or a setting 0.3 s (the
   * ring, the new value, the trace); a bar moves in its own 0.3 s, a prompt is written in 1 s at most.
   */
  async function stepTo(key, label, apply, { anchor, hold = 0, rare = false } = {}) {
    if (!ai || ai.stopped) return false;
    // The prompt is written without a mark (studio-maquette.md): no ring, no trace on it.
    const marked = key !== 'prompt';
    // `rare`: a setting under « Plus de réglages », opened for it: the pointer does not go to what
    // is folded, and the user sees the value it sets, theirs to change before « Générer ».
    if (rare) {
      advanced = true;
      pieceOpen = null;
    }
    // (0.6.204) A setting that lives in the window of a piece (who is who; 0.6.205, « Débruitage »): its window
    // opened for it, for the same reason, and left open: the user sees the value set there, as under « Plus de
    // réglages » (one window at a time: the last piece set).
    const inWindow = windowOf(key);
    if (inWindow) {
      pieceOpen = inWindow;
      advanced = false;
    }
    ai.active = marked ? key : null;
    render();
    // (Its window is shown once on the page: the pointer goes to its field where it is then.)
    if (inWindow) await null;
    if (!(await glide(targetOf(key), label, anchor))) return false;
    if (hold) await wait(hold / 2);
    await apply();
    if (hold) {
      render();
      await wait(hold / 2);
    }
    if (!ai || ai.stopped) return false;
    if (marked) ai.touched.add(key);
    ai.active = null;
    render();
    // (Drawn again, its window is shown once on the page: the pointer follows its field there.)
    if (inWindow) await null;
    pointer?.follow(targetOf(key), anchor);
    return Boolean(ai && !ai.stopped);
  }
  /**
   * (0.6.204) The piece whose window holds the setting the pointer goes to (`key`: « setting-subject »), when
   * that piece is given; null for a setting of the column.
   */
  function windowOf(key) {
    const name = String(key).replace(/^setting-/, ''),
      workflow = current(),
      role = WHO[name]?.piece ?? (workflow ? pieceOf(workflow, workflow.settings.find(setting => setting.key === name)) : null);
    return role && givenPiece(role, 0) ? { role, index: 0 } : null;
  }
  /**
   * (0.6.207) What is given in a place of the plateau: what its case holds, or for the `source` of a continuation
   * the clip it goes on from (no case holds that one).
   */
  function givenPiece(role, index) {
    if (mode === 'video' && extending && role === 'source') return index === 0 ? extending : null;
    // (0.6.211) The camera has no case of an input: its choice is the piece.
    // (0.6.240) The camera of a clip to film again is there as long as that clip is.
    if (role === 'orbit') return index === 0 && refilming() ? orbitState(current()).state : null;
    if (role === 'camera') return index === 0 ? (drafts[mode].camera ?? null) : null;
    return drafts[mode].inputs[role]?.[index] ?? null;
  }
  /** The prompt written as it is typed: about 40 letters a second, 1 s at most whatever its length (16/11). */
  async function typePrompt(draft, text, { instant = false } = {}) {
    const box = document.querySelector?.('#studio-view [data-ai="prompt"]');
    if (instant || pointer?.reduced() || !box) {
      draft.prompt = text;
      return;
    }
    const length = Math.min(1000, (text.length / 40) * 1000),
      ticks = Math.max(1, Math.round(length / 33)),
      step = Math.max(1, Math.ceil(text.length / ticks));
    for (let index = step; index < text.length + step; index += step) {
      if (!ai || ai.stopped) return;
      draft.prompt = text.slice(0, index);
      box.value = draft.prompt;
      box.scrollTop = box.scrollHeight;
      // (0.6.200) Nothing said on the empty screen under the words being written.
      sayBlank();
      await wait(length / ticks);
    }
    draft.prompt = text;
  }
  // Where a take goes, said by the pointer: « pose la prise 26 en fin », « pose la prise 2 comme sujet » (0.6.190).
  const WHERE = {
    start_image: 'en début',
    end_image: 'en fin',
    reference: 'comme sujet',
    source: 'à modifier',
    source_video: 'en vidéo à suivre',
  };
  /**
   * A take of the project put in its case (studio-maquette.md, step 2): the pointer goes to the case
   * carrying the take, the case grows and shows it (0.2 s), and it is put down. A reference that is
   * no take is put at once.
   */
  async function dragIn(draft, entry, { instant = false } = {}) {
    const put = () => ((draft.inputs[entry.role] ??= [])[entry.index] = entry.item);
    const record = entry.ref.output_id ? runs.find(item => item.id === entry.ref.output_id) : null,
      take = record?.outputs?.[entry.ref.output_index ?? 0]?.take;
    if (instant || !pointer || pointer.reduced() || !record) {
      put();
      return true;
    }
    const label = 'pose ' + (Number.isInteger(take) ? 'la prise ' + take : 'l’image') + ' ' + (WHERE[entry.role] ?? ''),
      caseOf = () => document.querySelector?.(`#studio-view .studio-slot[data-slot="${entry.role}-${entry.index}"]`);
    aiCarry = { id: record.id, role: entry.role, index: entry.index, preview: entry.item.preview, over: false };
    pointer.carry(entry.item.preview, Number.isInteger(take) ? 'PRISE ' + take : '');
    render();
    if (!(await glide(caseOf(), label))) return false;
    aiCarry.over = true;
    render();
    // It marks 0.2 s over its case (16/11): the case grown, the take shown in it.
    await wait(200);
    if (!ai || ai.stopped) return false;
    put();
    aiCarry = null;
    pointer.carry(null);
    render();
    return Boolean(ai && !ai.stopped);
  }
  /**
   * Shows a proposal of Moodix AI in the Studio. What its workflow leaves to the assistant is
   * set by the pointer, the rest is shown as it will be made; the pointer stops on « Générer »
   * and waits. Resolves 'once' when the user generates (their changes sent first), 'deny' when
   * they decline; rejects when the turn is stopped. `said`: the words Moodix AI wrote for it, said at
   * the top of the screen meanwhile ('' when it wrote none: the Studio says the proposal in a sentence
   * of its own, 0.6.95); `purpose`: 'character', the image of a character made for a replacement.
   */
  function propose(request, signal, { said = '', purpose = '' } = {}) {
    const target = MODE_OF_VERB[request.tool || request.call?.function?.name] ?? request.mediaType ?? 'image';
    return new Promise((resolve, reject) => {
      const settle = () => {
        signal?.removeEventListener('abort', abort);
        endPointer();
      };
      const abort = () => {
        settle();
        proposal = null;
        failure = '';
        // (0.6.316) What it set is given back, as when declined: stopped during « Préparation… » of « Générer »
        // on it, its seed stayed for every creation by hand after it, and the page « Générer la suite ».
        if (mine.extending) extending = null;
        giveBackSeed(mine);
        releaseInputs(mine);
        render();
        letGo();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      const mine = {
        request,
        mode: target,
        values: null,
        touched: new Set(),
        signal,
        // What Moodix AI understood, at the top of the screen, and its prompt folded under it, until
        // the proposal is answered (0.6.95): one line made for it, moved from one drawing to the next.
        explain: explanation({ node, icon, said, request, purpose }),
        fold: { open: false, cut: false },
        resolve: decision => {
          settle();
          resolve(decision);
        },
      };
      proposal = mine;
      // Its conversation, the one shown (0.6.81): left meanwhile, the proposal waits there.
      holdAt();
      signal?.addEventListener('abort', abort, { once: true });
      // Locked from now until the pointer rests on « Générer », or the proposal goes (endPointer).
      lockStudio(true);
      failure = '';
      const shown = reveal();
      void (async () => {
        // The Studio comes on screen first (from the chat, its movement), then the pointer works.
        try {
          await shown;
        } catch {
          // The view changed anyway, or did not: the proposal is shown where it is.
        }
        const verb = request.tool || request.call?.function?.name;
        // The tools read ahead may predate the workflow it proposes (the engine just ready, a
        // workflow switched on): read again, rather than wait for a « Générer » with nothing to set.
        if (!info || !offered(verb).some(item => item.name === request.workflowName)) await load().catch(() => {});
        if (!proposal || proposal.request !== request) return;
        if (!offered(verb).length) {
          // Still nothing to set it with: said to the chat, which would otherwise wait for good.
          settle();
          proposal = null;
          render();
          letGo();
          reject(
            new Error('Le Studio n’a aucun modèle prêt pour cette création : vérifiez Paramètres › Modèles.'),
          );
          return;
        }
        proposal.values = proposedValues(request, offered(verb));
        await animate(proposal);
      })();
    });
  }
  async function animate(current) {
    const { values, request } = current,
      target = current.mode,
      list = offered(values.verb),
      workflow = list.find(item => item.id === values.workflow) ?? list[0],
      draft = drafts[target];
    if (!workflow) {
      lockStudio(false);
      return render();
    }
    ai = { stopped: false, active: null, touched: new Set() };
    status(true);
    // What the assistant may not change is shown at once, as it will be made.
    // (0.6.244) A clip it continues is continued, whatever was being done to its camera.
    refilmId = null;
    if (values.source)
      extending = runs.find(item => item.id === values.source) ?? { id: values.source, prompt: '', parameters: {} };
    else if (values.sourceResource) {
      // A clip of the disk (« #ref1 »): continued like a take. It is not in the Sortie, so it is put
      // on the screen, where the user sees what is continued. (Left out, the Studio showed the cases
      // of a new video, all empty, while the proposal continued that clip.)
      const size = request.resolution ?? {};
      extending = resourceRecord(assets.resource?.(values.sourceResource) ?? { id: values.sourceResource }, 'video', {
        name: values.sourceLabel,
        width: size.width,
        height: size.height,
      });
      kept[target] = extending;
      pinned = extending.id;
    } else if (target === 'video') extending = null;
    // Kept with the proposal: it stays the continuation of that clip whatever mode the user looks
    // at while it waits (setMode gives it back with Vidéo).
    current.extending = target === 'video' ? extending : null;
    if (!values.sizeFree && values.size && !extending) {
      draft.format = values.format ?? draft.format;
      draft.size = values.size;
    }
    current.seedBefore = draft.seed;
    if (values.seed !== null) draft.seed = String(values.seed);
    // The LoRAs of the workflow as the proposal has them: on with their strength, the others off.
    if (values.loras && workflow.loras?.length) {
      const chosen = new Map(values.loras.map(item => [item.id, item.strength]));
      for (const item of workflow.loras) {
        const choice = loraChoice(workflow, item, draft);
        choice.on = chosen.has(item.id) || !item.assistant;
        if (chosen.has(item.id) && Number.isFinite(chosen.get(item.id))) choice.strength = chosen.get(item.id);
      }
      current.lorasShown = JSON.stringify(loraArgs(workflow, draft));
    }
    if (!values.promptFree) draft.prompt = values.prompt;
    for (const [key, value] of Object.entries(values.settings))
      if (!values.settingsFree[key]) (draft.settings[workflow.id] ??= {})[key] = value;
    const steps = [];
    if (mode !== target) steps.push(['kind', 'passe en ' + modeOf(target).label, () => setMode(target)]);
    // Its model, with the LoRAs of its family (takeModel), as when the user chooses it in the list.
    if (draft.workflow !== workflow.id && list.length > 1)
      steps.push(['model', 'choisit ' + workflow.name, () => takeModel(draft, target, workflow), { hold: 300 }]);
    else takeModel(draft, target, workflow);
    if (values.promptFree)
      steps.push(['prompt', 'écrit le prompt', options => typePrompt(draft, values.prompt, options), { anchor: { ax: 34, ay: 30 } }]);
    // Its cases are those of the proposal, and no other: an image the user had left in a case is not
    // part of what will be made, and shown there it said the contrary (a proposal without images
    // left them all in place). Each image of the proposal then goes in its case, one after the other:
    // a take of the project is carried there (dragIn).
    draft.inputs = {};
    for (const entry of referenceInputs(values.references))
      steps.push(['inputs', '', options => dragIn(draft, entry, options), { own: true }]);
    if (values.sizeFree && values.format && values.format !== draft.format && !extending)
      steps.push([
        'ratio',
        'passe en ' + values.format,
        () => Object.assign(draft, { format: values.format, size: values.size }),
      ]);
    else if (values.sizeFree && values.size)
      Object.assign(draft, { format: values.format ?? draft.format, size: values.size });
    if (values.framesFree && values.seconds !== null && workflow.lengths)
      steps.push([
        'duration',
        'règle la durée',
        // The handle of the bar goes from where it is to the length proposed, notch after notch, in
        // 0.3 s whatever their number (16/11).
        async ({ instant = false } = {}) => {
          const key = extending ? 'extension' : 'length',
            list = workflow.lengths.seconds,
            near = list.reduce((best, value) =>
              Math.abs(value - values.seconds) < Math.abs(best - values.seconds) ? value : best,
            ),
            from = list.indexOf(lengthOf(workflow)?.value),
            to = list.indexOf(near);
          values.lengthShown = near;
          if (!instant && pointer && !pointer.reduced() && from >= 0 && from !== to) {
            const way = Math.sign(to - from),
              pause = 300 / Math.abs(to - from);
            for (let at = from + way; ; at += way) {
              if (!ai || ai.stopped) break;
              draft[key] = list[at];
              render();
              await wait(pause);
              if (at === to) break;
            }
          }
          draft[key] = near;
        },
      ]);
    // (A setting on a bar, « Débruitage », shows its default until it is set: proposed at that
    // value, nothing moves. Set, « Plus de réglages » opens on it: see stepTo.)
    const onBar = key => {
      const setting = workflow.settings.find(item => item.key === key);
      return setting && fineSetting(setting) ? setting : null;
    };
    const shown = key => {
      const value = draft.settings[workflow.id]?.[key];
      return onBar(key) ? fineValue(onBar(key), value) : (value ?? '');
    };
    // (0.6.205) A setting under « Plus de réglages », which is opened for it; one set with a piece is in the
    // window of that piece (stepTo opens it), not there. (0.6.206) Every one of them, a field as a bar: its
    // window closed, the pointer went to a field that was not shown.
    const rareBar = key => {
      const setting = workflow.settings.find(item => item.key === key);
      return Boolean(setting) && rareSetting(setting) && !pieceOf(workflow, setting);
    };
    for (const [key, value] of Object.entries(values.settings))
      if (values.settingsFree[key] && String(shown(key)) !== String(value))
        steps.push([
          'setting-' + key,
          // (0.6.102) By its name, never its key (« règle steps »).
          'règle ' + settingName(key).toLowerCase(),
          () => {
            (draft.settings[workflow.id] ??= {})[key] = value;
            if (key === 'lyrics' && value) draft.lyrics = true;
            if (rareBar(key)) advanced = true;
          },
          { hold: 300, rare: rareBar(key) },
        ]);
    // With less motion asked, nothing moves: the end shows at once.
    const still = Boolean(pointer?.reduced());
    let done = 0;
    for (const [key, label, apply, options] of steps) {
      if (still) await apply({ instant: true });
      else if (!(await (options?.own ? apply() : stepTo(key, label, apply, options)))) break;
      done++;
    }
    if (done < steps.length) {
      if (proposal !== current) return;
      // The pointer stopped before the end (« Générer » pressed from elsewhere): what is left is set
      // at once, the proposal whole. The user cannot stop it: the Studio is locked (16/11).
      for (const [, , apply] of steps.slice(done)) await apply({ instant: true });
      lockStudio(false);
      return render();
    }
    if (!ai || ai.stopped || proposal !== current) return;
    // A character Moodix AI has just made: the pointer has the prompt written from the video and
    // that image, with the wand (the chat model comes back for it, then leaves the card again).
    if (request.scene && sceneInputs())
      if (!(await stepTo('enrich', 'écrit le prompt d’après la vidéo et le personnage', () => writeScene(current))))
        return;
    if (!ai || ai.stopped || proposal !== current) return;
    // The values it reached are those of the proposal: what changes after that is the user's.
    current.touched = new Set(ai.touched);
    ai.active = 'generate';
    render();
    const auto = request.autoAllow === true;
    pointer?.move(
      targetOf('generate'),
      // An image of a series the user asked for goes by itself whatever the settings (image-series.mjs).
      request.series
        ? `lance l’image ${request.series.index} sur ${request.series.total} demandée`
        : auto
          ? 'lance la génération (autorisé dans les Paramètres)'
          : 'attend votre accord',
    );
    await wait(still ? 0 : 260);
    if (!ai || ai.stopped || proposal !== current) return;
    status(false);
    if (auto) {
      endPointer();
      return approve();
    }
    // It stays on « Générer », « Refuser » beside it, until the user answers (studio-maquette.md):
    // the Studio is theirs again, its settings, « Refuser » and « Générer » (16/11).
    ai.waiting = true;
    lockStudio(false);
  }
  /**
   * The model of a draft set without the list (a proposal of Moodix AI): the LoRAs the user added
   * follow their family, as in choose(). Left in place, those made for Krea 2 stayed on under MOSS
   * Image and went with the next « Générer » by hand.
   */
  function takeModel(draft, target, workflow) {
    const models = modelsOf(target),
      held = models.find(item => item.id === draft.workflow) ?? models.find(item => !item.unavailable) ?? models[0];
    if (held && held.family !== workflow.family) {
      draft.shelved[held.family] = draft.styles;
      draft.styles = draft.shelved[workflow.family] ?? [];
    }
    draft.workflow = workflow.id;
  }
  /** The images of a proposal, each with the slot of its role: [{ role, index, item, ref }]. */
  function referenceInputs(references) {
    const counts = {};
    return references.map((ref, index) => {
      const resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null,
        record = ref.output_id ? runs.find(item => item.id === ref.output_id) : null,
        output = record?.outputs?.[ref.output_index ?? 0] ?? null,
        // The role as the verb names it (a video to follow is its « source »), else the slot's.
        role = ref.as ?? (ref.role in ROLES ? ref.role : ref.role === 'msr_image' ? 'reference' : ref.role),
        width = resource?.width ?? output?.width ?? record?.parameters?.width,
        height = resource?.height ?? output?.height ?? record?.parameters?.height;
      const item = {
        source: ref.resource_id
          ? { resource: ref.resource_id }
          : ref.output_id
            ? { output: ref.output_id, ...(ref.output_conversation ? { conversation: ref.output_conversation } : {}) }
            : null,
        // An image joined to the message is neither a take nor a reference of the project: its
        // picture is the one the server gives for the card of the proposal (`preview`).
        preview:
          resource?.previewUrl || resource?.originalUrl || output?.thumbUrl || output?.originalUrl || ref.preview || '',
        name: ref.label || ref.roleLabel || ROLES[role] || 'Entrée',
        ...(width > 0 && height > 0 ? { width, height } : {}),
        ref: index,
        role,
      };
      counts[role] = (counts[role] ?? -1) + 1;
      return { role, index: counts[role], item, ref };
    });
  }
  function endPointer() {
    if (ai) ai.stopped = true;
    ai = null;
    aiCarry = null;
    lockStudio(false);
    status(false);
    pointer?.carry(null);
    pointer?.hide();
    render();
  }
  /**
   * A touch of the user once the pointer rests on « Générer » (« Générer » itself too): the pointer
   * goes, the proposal stays theirs to change; nothing is drawn again (a click there, or on « Refuser »,
   * keeps the button it was pressed on). While it works nothing takes over: the Studio is locked.
   */
  function takeOver() {
    if (!ai || aiWorking) return;
    ai.stopped = true;
    ai = null;
    status(false);
    pointer?.hide();
  }
  /** What the user changed in the Studio from the proposal, as the server takes it. */
  function edits() {
    const { values, request } = proposal,
      plan = request.plan || {},
      items = new Map((plan.editable?.parameters || []).map(item => [item.key, item])),
      draft = drafts[proposal.mode],
      workflow = offered(values.verb).find(item => item.id === values.workflow) ?? current(),
      changes = {};
    const prompt = draft.prompt.trim();
    if (!prompt) throw Error('Écrivez un prompt.');
    if (plan.editable?.prompt && prompt !== values.prompt.trim()) changes.prompt = prompt;
    if (
      values.size &&
      draft.size &&
      draft.size !== values.size &&
      items.has('width') &&
      items.has('height') &&
      !extending
    ) {
      const stage = workflow?.stages ? stageOf(workflow, draft.size) : null,
        [width, height] = draft.size.split('x').map(Number);
      // The size chosen goes in any case, and with it the version it belongs to when that changes
      // (a large picture is a final). « final » alone gave the size of that profile in the format
      // of the proposal: not the format, nor the size, the Studio showed.
      Object.assign(changes, { width, height });
      if (stage && values.stage && stage !== values.stage && plan.editable?.stages?.includes(stage))
        changes.stage = stage;
    }
    // Only when the pointer set the length of this proposal on its bar (`lengthShown`): a workflow
    // whose length is « Fixe » shows no bar, and what the draft holds then is the length of another
    // model, which went as a change of the user (241 frames proposed, 121 made).
    if (values.lengthShown !== undefined && values.seconds !== null && items.has('frames') && values.fps) {
      const wanted = draft[extending ? 'extension' : 'length'];
      if (Number.isFinite(wanted) && wanted !== values.lengthShown && Math.abs(wanted - values.seconds) > 0.01) {
        let frames = Math.round(wanted * values.fps) + values.overlap;
        const choices = values.framesChoices;
        if (choices?.length)
          frames = choices.reduce((best, value) => (Math.abs(value - frames) < Math.abs(best - frames) ? value : best));
        if (frames !== values.frames) changes.frames = frames;
      }
    }
    const seed = draft.seed.trim();
    if (seed && values.seed !== null && Number(seed) !== values.seed && items.has('seed')) {
      const number = Number(seed);
      if (!Number.isSafeInteger(number) || number < 0) throw Error('Seed : un entier positif.');
      changes.seed = number;
    }
    // The LoRAs of the user for this family, shown with the proposal (added, taken out or left as
    // they were): it is made with them, as « Générer » by hand makes it. Moodix AI proposes none
    // itself: left out here, what the Studio showed was not what was made, and the settings of
    // that take then emptied the list.
    if (workflow?.styled && proposal.mode !== 'audio' && !extending) {
      const styles = draft.styles.filter(style => style.name).map(({ name, strength }) => ({ name, strength }));
      if (JSON.stringify(styles) !== JSON.stringify(request.styles ?? [])) changes.styles = styles;
    }
    // The LoRAs of the workflow switched or set here.
    if (proposal.lorasShown !== undefined && workflow) {
      const now = loraArgs(workflow, draft);
      if (JSON.stringify(now) !== proposal.lorasShown) changes.loras = now ?? {};
    }
    for (const key of Object.keys(values.settings)) {
      const item = items.get(key),
        value = draft.settings[workflow?.id]?.[key];
      if (!item || item.locked || value === undefined || String(value) === String(values.settings[key])) continue;
      // (0.6.102) Within the bounds the proposal gives it (its workflow's, « Fixe » as « Assistant »),
      // shown so; a switch as true or false.
      const made = settingValue(item, value);
      if (made === '' || String(made) === String(values.settings[key])) continue;
      if (workflow) draft.settings[workflow.id][key] = made;
      changes[key] = made;
    }
    // An image dragged to another slot changes role: said by the name the server gave that role
    // (the slot of the family, « msr_image » for a reference of LTX 2.5), the one it takes back.
    const roles = [];
    for (const [role, list] of Object.entries(draft.inputs))
      for (const item of list ?? []) {
        if (item?.ref === undefined || item.role === role) continue;
        const choice = (values.roleChoices[item.ref] ?? []).find(option => roleOfSlot(workflow, option.role) === role);
        roles.push({ index: item.ref, role: choice?.role ?? role });
      }
    if (roles.length) changes.references = roles;
    return changes;
  }
  /**
   * The proposal is answered (generated, refused, stopped with its turn): the images it put in the
   * slots are the user's from now on. They no longer carry what tied them to it (`ref`, `role`: an
   * image of a proposal changes role only as its workflow offers), and move like any other: kept,
   * « Inverser début et fin » and every drag were refused for good once the proposal was gone.
   */
  function releaseInputs(answered) {
    const inputs = drafts[answered.mode].inputs;
    for (const [role, list] of Object.entries(inputs))
      inputs[role] = (list ?? []).map(item => {
        // An image joined to the message was the proposal's alone: the Studio has nothing to name it
        // by (no take, no reference). Left in its slot, « Générer » by hand sent it as `null`, which
        // the server refuses at each try.
        if (!item?.source) return null;
        const own = { ...item };
        delete own.ref;
        delete own.role;
        return own;
      });
  }
  /** « Générer » on a proposal: the user's changes are sent, then the generation is theirs to watch. */
  async function approve() {
    if (!proposal || working) return;
    if (ai) takeOver();
    const current = proposal,
      { request } = current;
    let changes;
    try {
      changes = edits();
    } catch (error) {
      failure = error.message;
      return render();
    }
    failure = '';
    working = { label: 'Préparation…', fraction: null, external: true };
    render();
    if (Object.keys(changes).length)
      try {
        // Each answer is the proposal anew, under another identifier and another token.
        const revise = async changed => {
          const revised = await (
            await api('tools/revise', {
              requestId: request.requestId,
              approvalToken: request.approvalToken,
              edits: changed,
            })
          ).json();
          Object.assign(request, revised);
          return revised;
        };
        const made = (await revise(changes)).plan?.parameters ?? {};
        // Another version has its own scale for the server: asked with a size, it keeps the format
        // of that size and gives the size of its profile. When that is not the size chosen here, it
        // is asked again, alone (as « Générer » by hand asks it): what is made is what is shown.
        if (
          changes.stage &&
          Number.isInteger(made.width) &&
          Number.isInteger(made.height) &&
          (made.width !== changes.width || made.height !== changes.height)
        )
          await revise({ width: changes.width, height: changes.height });
      } catch (error) {
        working = null;
        failure = error.message;
        return render();
      }
    if (proposal !== current) return;
    proposal = null;
    if (extending) extending = null;
    giveBackSeed(current);
    releaseInputs(current);
    current.resolve('once');
  }
  /**
   * The image of a character Moodix AI made to put in a video, shown to the user before the
   * video is made: « OK » keeps it (the replacement runs at once), « Autre image » has another
   * made from the prompt of the screen (changed or not), « Annuler » stops everything. Resolves
   * { decision: 'ok' | 'again' | 'cancel', prompt }; rejects when the turn is stopped.
   */
  function checkCharacter(record, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        checking = null;
        render();
        letGo();
        reject(signal.reason || new DOMException('Annulé', 'AbortError'));
      };
      // Checked in the conversation shown (0.6.81): left meanwhile, the question waits there.
      holdAt();
      checking = {
        record,
        resolve: decision => {
          signal?.removeEventListener('abort', abort);
          const prompt = drafts.image.prompt.trim();
          checking = null;
          render();
          letGo();
          // Read by screen readers: the question answered.
          $('live-status') &&
            ($('live-status').textContent =
              decision === 'cancel'
                ? 'Remplacement annulé.'
                : decision === 'again'
                  ? 'Autre image du personnage…'
                  : 'Personnage gardé : le remplacement se prépare.');
          resolve({ decision, prompt });
        },
      };
      signal?.addEventListener('abort', abort, { once: true });
      failure = '';
      if (mode !== 'image') setMode('image');
      kept.image = runs.find(item => item.id === record.id) ?? record;
      void reveal();
      render();
      $('live-status') &&
        ($('live-status').textContent = 'Image du personnage à vérifier : OK, autre image ou annuler.');
    });
  }
  /** The proposal is declined: from its « Annuler », or by a new message in the chat. */
  function decline() {
    if (checking) {
      checking.resolve('cancel');
      return true;
    }
    if (!proposal || working) return false;
    const current = proposal;
    proposal = null;
    extending = null;
    failure = '';
    giveBackSeed(current);
    releaseInputs(current);
    current.resolve('deny');
    render();
    letGo();
    return true;
  }
  /** The seed drawn for a proposal was its own: the next creation by hand draws again, unless the user typed one. */
  function giveBackSeed(answered) {
    const draft = drafts[answered.mode];
    if (answered.values && draft.seed === String(answered.values.seed)) draft.seed = answered.seedBefore ?? '';
  }
  /**
   * A creation of the conversation shown, made by the server for a page reloaded since (0.6.82): the
   * screen follows it again (follow) until it is over (settled), as one approved here; its stop stops
   * it (stopTurn). False when the Studio already holds a work. With its `request` (0.6.96), the
   * Studio shows the settings it is made with, not those it had (the last take, the image of a series
   * before it); its take, once there, gives them as any take does (settled).
   */
  function followAgain(request = null) {
    if (holds()) return false;
    // (A take of the Chat it followed: the Studio as it was first.)
    if (working?.chat) unfollow();
    holdAt();
    const shown = request ? showRequest(request) : null;
    // (0.6.181) `place`: asked in the Bobine, where it goes there (the server kept it with its job).
    // (0.6.184) `asked`: its request, when it could not be shown (the tools of the Studio not read yet, or
    // read before the engine was ready, when no model is offered): shown once they are (showLate).
    working = { label: 'Génération en cours…', fraction: null, external: true, ...(shown ? { shown } : request ? { asked: request } : {}), ...(request?.bobine ? { place: request.bobine, tell: () => montage.busyChanged() } : {}) };
    render();
    working.tell?.();
    return true;
  }
  /**
   * (0.6.184, seen on the card on 21/11) The work followed again whose request could not be shown: a page
   * just reloaded follows its job at once, before the Studio has read its tools, and no model was known to
   * show it with. The Studio stayed in Image, « En cours · 20 % » under the form of an image, while LTX 2.5
   * made a video. Shown as soon as they are read with its model (load): the first reading of a page comes
   * before the engine is ready, and offers no model yet.
   */
  function showLate() {
    if (!working?.external || !working.asked) return;
    const shown = showRequest(working.asked);
    if (!shown) return;
    working.shown = shown;
    delete working.asked;
  }
  /**
   * The settings of `request` (a proposal, as the server makes it) in the draft of its mode, at once, as
   * the pointer sets those of a proposal (animate): its model, its prompt, its format and size, its
   * length, its seed, its settings, its LoRAs (those of the user it is made with too) and its inputs
   * (0.6.96). What was shown ({ mode, seedBefore }), or null when the Studio has not its model.
   */
  function showRequest(request) {
    const verb = request.tool || request.call?.function?.name,
      target = MODE_OF_VERB[verb] ?? request.mediaType ?? 'image',
      list = offered(verb),
      workflow = modelOfRequest(request, list);
    if (!modelsOf(target).length) return null;
    mode = target;
    formatsOpen = false;
    // An action on a take (Agrandir, Interpoler), a model the Studio has not: its mode alone. (0.6.261) Nor one it has
    // (lot 4: the Studio lists them): shown as a creation of its mode, the prompt of Image was emptied the whole take.
    if (!workflow || FINISH[verb]) {
      if (target !== 'video') extending = null;
      return null;
    }
    const values = proposedValues(request, list),
      draft = drafts[target],
      seedBefore = draft.seed,
      size = request.resolution ?? {};
    // A continuation shows the clip it continues (a take, or a file of the disk), as proposed.
    // (0.6.323) Never as a clip filmed again: on « Changer la caméra », a continuation of that clip asked in the Chat
    // was followed « À refilmer ». The page of the user comes back with its camera once it is over (asItWas).
    refilmId = null;
    extending =
      target !== 'video'
        ? null
        : values.source
          ? (runs.find(item => item.id === values.source) ?? { id: values.source, prompt: '', parameters: {} })
          : values.sourceResource
            ? resourceRecord(assets.resource?.(values.sourceResource) ?? { id: values.sourceResource }, 'video', {
                name: values.sourceLabel,
                width: size.width,
                height: size.height,
              })
            : null;
    takeModel(draft, target, workflow);
    // Its saved settings (« Enregistrer ») do not come over those it is made with.
    presetShown[target] = true;
    Object.assign(draft, { prompt: values.prompt, before: null, inputs: {} });
    if (values.size && !extending) Object.assign(draft, { format: values.format ?? draft.format, size: values.size });
    if (workflow.seeded) draft.seed = values.seed !== null ? String(values.seed) : '';
    if (values.loras && workflow.loras?.length) {
      const chosen = new Map(values.loras.map(item => [item.id, item.strength]));
      for (const item of workflow.loras) {
        const choice = loraChoice(workflow, item, draft);
        choice.on = chosen.has(item.id) || !item.assistant;
        if (chosen.has(item.id) && Number.isFinite(chosen.get(item.id))) choice.strength = chosen.get(item.id);
      }
    }
    for (const [key, value] of Object.entries(values.settings)) {
      (draft.settings[workflow.id] ??= {})[key] = value;
      if (key === 'lyrics' && value) draft.lyrics = true;
    }
    for (const entry of referenceInputs(values.references)) (draft.inputs[entry.role] ??= [])[entry.index] = entry.item;
    const lengths = workflow.lengths?.seconds ?? [];
    if (lengths.length && values.seconds !== null)
      draft[extending ? 'extension' : 'length'] = lengths.reduce((best, value) =>
        Math.abs(value - values.seconds) < Math.abs(best - values.seconds) ? value : best,
      );
    if (workflow.styled && target !== 'audio' && !extending)
      draft.styles = (Array.isArray(request.styles) ? request.styles : [])
        .filter(style => style?.name)
        .slice(0, MAX_STYLES)
        .map(({ name, strength }) => ({ name, strength }));
    return { mode: target, seedBefore };
  }
  /**
   * The take of the Chat being made in the conversation shown (0.6.96), as `making()` gives it: Chat
   * and Studio are two views of that conversation. While it is made, the screen follows it as a
   * creation of the Studio (the Flux of the picture so far, its step, « En cours · 42 % », « Arrêter »,
   * which stops it with its turn), with the settings it is made with; « Générer » waits for its end and
   * says why. It does not hold the Studio: another conversation opened, the Studio is that one's
   * (greyed there, as before), and follows the take again once back. Over, the Studio is as it was, then
   * shows the take made with its settings (the last take of the conversation), or why it failed. Asked
   * at each step of the take and whenever the page changes: nothing new, nothing done.
   */
  function watch() {
    const take = making() ?? null;
    if (working?.chat) {
      if (take?.request !== working.request || !take.running) return unwatch(take?.request === working.request ? take.ended : null);
      // How long it has been in the making, as the server counts it (0.6.93): its clock goes on alone.
      if (take.time && take.time !== working.timeGiven) {
        working.timeGiven = take.time;
        timeWork(take.time);
      }
      const label = take.label || working.label,
        fraction = Number.isFinite(take.fraction) ? take.fraction : working.fraction,
        preview = take.preview || working.preview;
      if (label === working.label && fraction === working.fraction && preview === working.preview) return;
      Object.assign(working, { label, fraction, preview });
      return progress();
    }
    // Not over a work of its own, a proposal or Moodix AI setting it, nor a prompt being improved.
    if (!take?.running || holds() || working || enriching || !info || away()) return;
    leaveLook();
    const before = asItIs();
    showRequest(take.request);
    working = {
      label: take.label || 'Génération en cours…',
      fraction: Number.isFinite(take.fraction) ? take.fraction : null,
      preview: take.preview || null,
      external: true,
      chat: true,
      request: take.request,
      before,
      timeGiven: take.time,
    };
    // Its time from its go, beside its step, as its card counts it (0.6.93).
    if (take.time) timeWork(take.time);
    failure = '';
    render();
  }
  /**
   * The take of the Chat followed here is followed no more: the Studio as it was before it (nothing
   * drawn), but for what went wrong before: that take came since.
   */
  function unfollow() {
    const { before } = working;
    working = null;
    // (Its count with it: the next work counts from its own go.)
    elapsed.stop();
    asItWas(before);
    failure = '';
  }
  /** The Studio as it is, kept to be put back (asItWas): before a take it follows, of the Chat or of the Bobine. */
  function asItIs() {
    return {
      mode,
      drafts: structuredClone(drafts),
      advanced,
      kept: { ...kept },
      pinned,
      extending,
      // (0.6.321) The clip in hand filmed again (« Changer la caméra »), not continued: see putBack.
      refilmId,
      // What a model showed first, for « Enregistrer » (paintSave): not the settings of the take followed.
      presetShown: { ...presetShown },
      baselines: { ...baselines },
    };
  }
  /** The Studio as `before` kept it (asItIs), with what its models had shown first. Nothing is drawn. */
  function asItWas(before) {
    putBack(before);
    for (const item of MODES) presetShown[item.id] = before.presetShown[item.id];
    for (const key of Object.keys(baselines)) if (!(key in before.baselines)) delete baselines[key];
  }
  /**
   * The take of the Chat followed here is over (`ended`: { type, record, message }), or not shown any
   * more. Made: the newest take of the conversation, on the screen with its settings, now when the
   * Studio is on screen, else when it comes (open reads its takes again). Failed under the user's eyes:
   * why, as for a creation of its own (in the Chat, its card says it).
   */
  function unwatch(ended = null) {
    unfollow();
    const seen = globalThis.document?.body?.dataset?.view === 'studio';
    if (ended?.record) {
      runsStale = true;
      // (0.6.254) A take made in the Chat: the Studio makes one again.
      tries = 1;
      if (seen) return void showMade(ended.record);
    } else if (ended?.type === 'failed' && seen) failure = ended.message || 'La génération a échoué.';
    render();
  }
  /** The take of the Chat just made, on the screen with its settings, as the last take (settle). */
  async function showMade(made) {
    await refresh().catch(() => {});
    // Something else came meanwhile (a creation, a proposal, another conversation): theirs.
    if (working || holds() || made.conversationId !== conversation()) return render();
    pinned = null;
    settle();
    const record = runs.find(item => item.id === made.id);
    if (record) {
      kept[mediaOf(record)] = record;
      if (modelsOf(mediaOf(record)).length) mode = mediaOf(record);
    }
    render();
    scrollStrip();
  }
  /**
   * A work of the page began or ended (0.6.86): the Studio is drawn again when what greys « Générer »
   * changes. Drawn last while its own creation, or a turn of Moodix, still counted as a work of this
   * conversation, it said « Moodix répond » and kept « Générer » greyed until it was drawn again.
   */
  function busyChanged() {
    // (0.6.175) The Bobine greys « Créer » by the same works: it is told too, wherever the Studio is.
    montage.busyChanged();
    if (away() || !info || !$('studio-body')) return;
    const free = !working && !(gpuBlocked() && !working) && !answering() && !checking,
      elsewhereNow = free ? elsewhere() : '',
      // (0.6.253) The chat that answers greys « Générer » too (form, `chatBusy`).
      now = elsewhereNow + '|' + (free && !ai && !elsewhereNow ? blocked() : '');
    if (now !== busyDrawn) render();
  }
  /** A generation approved here, run by the chat turn: its progress comes from there, with its time. */
  function follow(label, fraction, preview, time) {
    // (A take of the Chat followed here hears its own: watch.)
    if (!working?.external || working.chat) return;
    Object.assign(working, {
      label: typeof label === 'string' && label ? label : working.label,
      fraction: Number.isFinite(fraction) ? fraction : working.fraction,
      preview: preview ?? working.preview,
    });
    timeWork(time);
    progress();
    // (0.6.181) A take of a bobine: its line there follows it.
    working.tell?.();
  }
  /** The end of a generation approved here: its creation is shown on the screen. */
  async function settled(result) {
    // (Not a take of the Chat followed here: watch ends it.)
    const external = working?.external && !working.chat,
      // The settings of its request, shown by followAgain (0.6.96).
      shown = external ? working.shown : null;
    if (external) working = null;
    // Held until its take is on its own screen (settling, 0.6.87).
    settling = true;
    try {
      await refresh().catch(() => {});
      // Made from the Studio as it is set: its settings are those of that take already.
      settledHere();
      if (result?.record) {
        const record = runs.find(item => item.id === result.record.id) ?? result.record;
        kept[mediaOf(record)] = record;
        // (0.6.260) A take that Moodix AI proposed, made: one try again, as after a take of the Chat (unwatch).
        tries = 1;
        // Shown from its request: those of its take now, its seed drawn again unless it was named.
        if (shown) adopt(record);
      } else if (external && result?.error) failure = result.error;
      // Nothing made: the seed and the images shown with its request were its own.
      if (shown && !result?.record) {
        drafts[shown.mode].seed = shown.seedBefore;
        releaseInputs({ mode: shown.mode });
      }
    } finally {
      settling = false;
    }
    render();
    scrollStrip();
    // Left meanwhile (0.6.81): the Studio goes to the conversation shown.
    letGo();
    // (0.6.478, Q3) Requests resumed while it was made (the window's « Reprendre » after a reload): theirs now.
    if (external) goOn(result?.error === 'Génération arrêtée.');
  }

  // ------------------------------------------------------------------ results
  const mediaOf = record => record.mediaType || 'image';
  /** A creation as an input: its run, with its conversation when it is another of the project. */
  const outputSource = record =>
    // A file put on the screen, kept as a reference of the project (inspectFile).
    record.resource
      ? { resource: record.resource }
      : record.conversationId && record.conversationId !== conversation()
        ? { output: record.id, conversation: record.conversationId }
        : { output: record.id };
  /** What the screen shows: the creation just made or opened from the chat, else the last of its mode. */
  /**
   * The takes of the open conversation: the screen is that conversation's (16/11), with the settings
   * of its last take (adopt). The Sortie is the project's: every take of all its conversations, a new
   * conversation included.
   */
  const ownRuns = () => runs.filter(record => !record.conversationId || record.conversationId === conversation());
  function onStage() {
    if (working) return null;
    return kept[mode] ?? ownRuns().find(item => mediaOf(item) === mode) ?? null;
  }
  /** The image model « Modifier » works with: the one in hand when it takes an image to modify, else the first that does. */
  function editor() {
    const list = offered('create_image').filter(item => !item.unavailable && takesImages(item, 'source')),
      held = modelsOf('image').find(item => item.id === drafts.image.workflow);
    return list.find(item => item.id === held?.id) ?? list[0] ?? null;
  }
  // Agrandie (Real-ESRGAN) or interpolée (RIFE): made from a clip too (its « source_video »), but the
  // whole clip again, not its continuation (17/11: they were said « ↳ SUITE », their length « + »).
  // (0.6.256) An image agrandie too (SeedVR2, Real-ESRGAN): made from its « source_image ».
  const TRANSFORMED = { realesrgan_video: 'AGRANDIE', rife: 'INTERPOLÉE', seedvr2: 'AGRANDIE', realesrgan_image: 'AGRANDIE' };
  const transformOf = record => TRANSFORMED[record.parameters?.pipeline] ?? null;
  /** The clip a continuation goes on from; none for anything else. */
  const sourceOf = record =>
    transformOf(record) ? undefined : record.parameters?.references?.find(ref => ref.role === 'source_video')?.output_id;
  /** The clip (the image) an upscale or an interpolation was made from. */
  const transformedFrom = record =>
    transformOf(record)
      ? record.parameters?.references?.find(ref => ref.role === 'source_video' || ref.role === 'source_image')?.output_id
      : undefined;
  /** (0.6.300) The cases of these drafts (one a mode) that hold the take `id`, emptied: whether one was. */
  function withoutTake(set, id) {
    let found = false;
    for (const draft of Object.values(set ?? {}))
      for (const list of Object.values(draft?.inputs ?? {}))
        (list ?? []).forEach((input, index) => {
          if (input?.source?.output !== id) return;
          list[index] = null;
          found = true;
        });
    return found;
  }
  /**
   * A take leaves its conversation (its file stays in output): the one deletion of the page, that of
   * the Sortie and of the Pellicule (0.6.147, take-delete.mjs). Whether it went: refused, it says why.
   */
  async function remove(record) {
    let gone = false;
    try {
      const where = record.conversationId ?? conversation();
      // A creation of another conversation of the project leaves that conversation.
      await api('studio/delete', { id: record.id, conversationId: where });
      gone = true;
      // A later reply of the chat that names it no longer draws it from what was read before.
      forgetCitedTakes();
      if (extending?.id === record.id) extending = null;
      if (finishing?.record.id === record.id) finishing = null;
      for (const key of Object.keys(kept)) if (kept[key].id === record.id) delete kept[key];
      // (0.6.300) Nor anything else of it. Looked at (« Afficher dans le Studio »), it kept the Studio on it:
      // the next take of the Chat no longer chose the mode. Laid in a case (« Animer », « Modifier », dropped
      // there), its case stayed filled, and « Générer » sent a take that was gone, refused by the server.
      if (pinned === record.id) pinned = null;
      // (In the drafts in hand, in those the page goes back to after a look, in those of the other conversations.)
      const emptied = [drafts, looked?.drafts, ...[...leftDrafts.values()].map(left => left.drafts)].map(set =>
        withoutTake(set, record.id),
      );
      if (emptied[0]) notice('La prise supprimée a été retirée de sa case.');
      // (0.6.147) The newest take of a conversation left, whose Studio is kept as it was left: it comes
      // back so, not with the settings of the take before it (as settledHere does for the one in hand).
      const left = leftDrafts.get(where);
      if (left?.newest === record.id) {
        const { runs: remaining = [] } = await (await api(`gallery/${encodeURIComponent(where)}?images=0`)).json();
        left.newest = remaining.find(run => run.conversationId === where && run.id !== record.id)?.id ?? null;
      }
      await refresh();
      // A take deleted here leaves the settings in hand as they are (not those of the take before it).
      settledHere();
    } catch (error) {
      notice(error.message);
    }
    render();
    return gone;
  }
  // ------------------------------------------------------------------ the Sortie
  // (moodix-design.md 15, 15 bis, 22-24; 7 bis 7, 8, 11): pictures only, the newest at the left
  // with the largest number; one round button on each (Prolonger, Animer), the bin on hover or
  // focus, all of them and « Ouvrir » under a right click or a long press; a click shows it whole
  // with its details; a deletion is asked on the picture itself.
  const KIND = { video: 'Clip', image: 'Image', audio: 'Son' };
  // What the Sortie shows: the whole project, images, clips and sounds (16/11: its button at the
  // right is pressed to begin with); released, the kind of the mode only.
  const SORTS = [
    { id: 'all', icon: 'grid', label: 'Tout', none: 'Aucune création dans ce projet pour l’instant' },
    // A mode without takes (etats-maquette.md, 55): what the Sortie will hold, the last at the left.
    { id: 'image', icon: 'image', label: 'Images', none: 'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.' },
    { id: 'video', icon: 'video', label: 'Vidéos', none: 'Rien pour l’instant. Vos vidéos apparaîtront ici, la dernière à gauche.' },
    { id: 'audio', icon: 'wave', label: 'Sons', none: 'Rien pour l’instant. Vos sons apparaîtront ici, la dernière à gauche.' },
  ];
  let sortieAll = true; // the Sortie shows the whole project, not only the kind of the mode
  let menuFor = null, // the creation whose menu is open
    confirmFor = null, // the creation whose deletion waits for its confirmation
    pressed = false; // a long press opened a menu: the click that ends it selects nothing
  // The size of each image shown, read from the picture itself: a record does not keep it.
  const measured = new Map();
  /**
   * « Modifier »: the image is the one to modify of the next image. The model in hand may take none
   * (MOSS Image) while another does (Krea 2): that one is then chosen, as « Animer » chooses its
   * video model; left in hand, the image went into a slot no one saw and nothing happened.
   */
  function editImage(record) {
    const model = editor();
    if (!model || working) return;
    if (proposal?.mode === 'image') return notice('Moodix AI est en train de proposer');
    // (0.6.298) Another page than « Agrandir » or « Interpoler », when one of them is open: it stayed (the same
    // medium keeps it, setMode), its model took the name of the model to edit with, and the image went in a
    // case of the draft hidden behind it. The click seemed to do nothing.
    finishing = null;
    setMode('image');
    if (current()?.id !== model.id) choose(model.id);
    putCreation(record, 'source', 0);
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
  }
  /** A creation of the Sortie (of any conversation of the project) in a slot of the mode shown. */
  function putCreation(record, role, index = 0) {
    (drafts[mode].inputs[role] ??= [])[index] = creationInput(record);
    failure = '';
    followFormat(role);
    render();
  }
  /**
   * Where « Animer » puts a picture. (0.6.256, lot 4, captures A07 and A08) Always its start image (« Début »), with
   * the first video model that takes one: among its references before (Sujet), the video did not start from it.
   */
  function animation() {
    const video = offered('create_video').find(item => !item.unavailable && takesImages(item, 'start_image'));
    return video ? { video, role: 'start_image' } : null;
  }
  /**
   * « Animer » (7 bis 11): the picture goes to the first video model that starts from an image, as its start image,
   * in place of the one there. (0.6.256) The page Vidéo opens with it: on its screen at half its light, « DÉBUT » at
   * its top left (animatedStart), the format its own (greyed meanwhile, why said), « × 1 » again, the cursor in the
   * prompt, « Décrivez le mouvement… » when it is empty; the picture flies from the screen to its case. Not while a
   * proposal of Moodix AI waits.
   */
  function animateImage(record) {
    const target = animation();
    if (!target || working) return;
    if (proposal) return notice('Moodix AI est en train de proposer');
    const { video } = target,
      draft = drafts.video;
    // Where it flies from: the picture of the screen (the take of Image), before Vidéo is drawn.
    const from = flightStart();
    // (0.6.298) « Interpoler » or « Agrandir » of a video left for it, as for « Modifier » (editImage).
    finishing = null;
    setMode('video');
    extending = null;
    tries = 1;
    if (current()?.id !== video.id) choose(video.id);
    // (Read in Vidéo: the inputs of its draft.)
    const clash = exclusiveWith(video, 'start_image');
    if (clash.length) return notice(`Ne se combine pas avec : ${clash.map(other => ROLES[other]).join(', ')}`);
    animated = record.id;
    // (0.6.261) Its format, or the nearest one the model makes (1280 × 800: 3:2), never the one of before: kept, a
    // picture in landscape was animated in 9:16, its format greyed « Le format suit l’image de début. ».
    const input = creationInput(record),
      made = formatsFor(video.limits ?? {}, video.family),
      format = input.width && input.height ? nearestFormat(input.width, input.height, made.length ? made : FORMATS) : null;
    // Its format, whatever was chosen before: the video starts from the picture.
    if (format) Object.assign(draft, { format: format.id, size: null, formatChosen: false });
    (draft.inputs.start_image ??= [])[0] = input;
    failure = '';
    render();
    $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
    fly(from, input.preview);
    globalThis.queueMicrotask?.(() => globalThis.document?.querySelector?.('#studio-prompt')?.focus?.({ preventScroll: true }));
  }
  /**
   * (0.6.256) The start image « Animer » put, while it is still the one of Vidéo: shown on its screen. (0.6.261) A
   * file of the computer put on the screen too (kept as a reference: its source is the reference, resourceRecord).
   */
  function animatedStart() {
    if (!animated || mode !== 'video' || working || extending || finishOn() || answering()) return null;
    const start = drafts.video.inputs.start_image?.[0],
      from = start?.source,
      same = from?.resource !== undefined ? 'file:' + from.resource === animated : from?.output === animated;
    return same && start.preview ? start : null;
  }
  /** (0.6.256) Where the picture of « Animer » leaves from: the take on the screen, measured before Vidéo is drawn. */
  function flightStart() {
    const picture = document.querySelector?.('#studio-view .studio-frame-result img, #studio-view .studio-frame-result');
    const box = picture?.getBoundingClientRect?.();
    return box?.width ? { left: box.left, top: box.top, width: box.width, height: box.height } : null;
  }
  /**
   * (0.6.256, capture A07b) The picture flies from the screen to its case « Début » (0.9 s after 0.3 s), then its case
   * lights up for a moment. Neither with the animations reduced, nor without a page to draw in.
   */
  function fly(from, src) {
    const page = globalThis.document;
    if (!from || !src || !page?.createElement || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const tile = page.querySelector?.('#studio-view .studio-slot[data-slot="start_image-0"]'),
      to = tile?.getBoundingClientRect?.();
    if (!to?.width) return;
    const ghost = page.createElement('img');
    ghost.src = src;
    ghost.alt = '';
    ghost.className = 'studio-flight';
    Object.assign(ghost.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
    page.body.append(ghost);
    const move = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
    const flight = ghost.animate?.([{ transform: 'none' }, { transform: move }], {
      duration: 900,
      delay: 300,
      easing: 'cubic-bezier(0.5, 0, 0.2, 1)',
      fill: 'forwards',
    });
    if (!flight) return void ghost.remove();
    flight.onfinish = flight.oncancel = () => {
      ghost.remove();
      const now = page.querySelector?.('#studio-view .studio-slot[data-slot="start_image-0"]');
      if (!now) return;
      now.classList.add('is-landed');
      setTimeout(() => now.classList.remove('is-landed'), 900);
    };
  }
  /** « Ouvrir » a creation (« Détails » before 0.6.198): shown whole, its details beside it (what a click on it does). */
  function showDetails(record) {
    menuFor = confirmFor = null;
    render();
    viewOutput(record, 0);
  }
  function askDelete(record) {
    menuFor = null;
    confirmFor = record.id;
    render();
    document.querySelector?.('#studio-view .studio-confirm-no')?.focus?.();
  }
  function openMenu(record) {
    if (working) return;
    confirmFor = null;
    menuFor = record.id;
    render();
    document.querySelector?.('#studio-view .studio-item-menu button')?.focus?.();
  }
  /** Back on the picture of a creation, its menu or its question closed. */
  function backTo(record) {
    menuFor = confirmFor = null;
    render();
    document.querySelector?.(`#studio-view .studio-item[data-id="${record.id}"] .studio-item-pick`)?.focus?.();
  }
  /**
   * (0.6.194, audit of 21/11, A6) The menu of a creation closed where it is, the Studio not drawn again:
   * what was pressed beside it, or given the focus, keeps it (drawn again under the pointer, the click of
   * a press beside it went to nothing). The next drawing leaves it out.
   */
  function dropMenu(menu = document.querySelector?.('#studio-view .studio-item-menu')) {
    menuFor = null;
    menu?.remove?.();
  }
  /**
   * Why a clip cannot be continued now, or '' when it can: a proposal of Moodix AI waits (the Studio
   * shows what it will make, as for « Animer »), or no workflow continues a video here. Then
   * « Prolonger » is greyed with that reason, as on the bar of the screen (output-actions.mjs): set
   * all the same, it left the Studio with « Aucun workflow prêt » and nothing to come back with.
   */
  function cannotExtend() {
    if (proposal) return 'Moodix AI est en train de proposer';
    const list = info?.tools?.extend_video ?? [];
    if (list.some(item => !item.unavailable)) return '';
    return list[0]?.unavailable || 'Aucun modèle ne sait prolonger une vidéo.';
  }
  /** What can be done with a creation: Prolonger or Animer first, then Modifier, Ouvrir, Supprimer. */
  function actionsOf(record) {
    const media = mediaOf(record),
      list = [];
    if (media === 'video') {
      const held = cannotExtend();
      list.push({
        id: 'extend',
        label: 'Prolonger',
        glyph: 'act-extend',
        title: held ? 'Prolonger · écrire la suite de ce clip\n' + held : 'Prolonger · écrire la suite de ce clip',
        off: Boolean(held),
        run: () => {
          if (working) return;
          const refused = cannotExtend();
          if (refused) return notice(refused);
          // A continuation is made in Vidéo. The Sortie shows the whole project in every mode: pressed
          // from Image or Son, the clip made of that mode a continuation without its banner (no
          // « Annuler », no format, « Générer la suite » sending the clip as the source of an image).
          if (mode !== 'video') setMode('video');
          extending = record;
          finishing = null;
          // (0.6.244) Continued, not filmed again: the same clip whose camera was being changed (or was, a
          // moment ago) is an ordinary clip again.
          refilmId = null;
          failure = '';
          menuFor = confirmFor = null;
          render();
          $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
        },
      });
    }
    // (0.6.240) « Changer la caméra »: the same clip filmed again from a camera placed by hand, with a model
    // made for it. Greyed with its reason while that model lacks its files.
    if (media === 'video' && (info?.tools?.refilm_video ?? []).length) {
      const able = info.tools.refilm_video.find(item => !item.unavailable),
        held = proposal ? 'Moodix AI est en train de proposer' : able ? '' : info.tools.refilm_video[0].unavailable || 'Indisponible.';
      list.push({
        id: 'refilm',
        label: 'Changer la caméra',
        glyph: 'camera',
        title: held ? ACTION_TIPS.refilm + '\n' + held : ACTION_TIPS.refilm,
        off: Boolean(held),
        run: () => {
          if (working) return;
          if (held) return notice(held);
          // Made in Vidéo, as a continuation is: the clip takes the place of the start of a new video.
          if (mode !== 'video') setMode('video');
          extending = record;
          finishing = null;
          refilmId = record.id;
          failure = '';
          menuFor = confirmFor = null;
          // Its tool open at once: it is what the action is for.
          pieceOpen = { role: 'orbit', index: 0 };
          pieceFocus = true;
          render();
          // (0.6.251) After a change of camera made here: its tools read again, for the time it took (the bar
          // of the size says it), then drawn with them while the clip is still the one in hand.
          if (toolsStale)
            void load()
              .then(() => {
                if (refilming() && extending?.id === record.id && !working) render();
              })
              .catch(() => {});
          $('studio-view')?.scrollTo?.({ top: 0, behavior: 'smooth' });
        },
      });
    }
    if (media === 'image' && animation())
      list.push({
        id: 'animate',
        label: 'Animer',
        glyph: 'act-animate',
        // (0.6.198) The words of the bar of a take (« Animer · en faire une vidéo » before).
        title: proposal ? 'Moodix AI est en train de proposer' : ACTION_TIPS.animate,
        off: Boolean(proposal),
        run: () => animateImage(record),
      });
    // Not in the design, kept: an image starts the next one, with a model that takes one. Held while
    // Moodix AI proposes an image: the slots of Image are those of its proposal.
    if (media === 'image' && editor())
      list.push({
        id: 'edit',
        label: 'Modifier',
        glyph: 'edit',
        title: proposal?.mode === 'image' ? 'Moodix AI est en train de proposer' : 'Modifier · repartir de cette image',
        off: proposal?.mode === 'image',
        run: () => editImage(record),
      });
    // (0.6.198) « Ouvrir », as the bar of a take opens the same page (« Détails » before).
    list.push({ id: 'details', label: 'Ouvrir', glyph: 'info', title: ACTION_TIPS.details, run: () => showDetails(record) });
    list.push({
      id: 'delete',
      label: 'Supprimer',
      glyph: 'trash',
      title: DELETE_TIP,
      danger: true,
      run: () => askDelete(record),
    });
    return list;
  }
  /** A round button on the picture: its icon, its name and the creation's for screen readers. */
  function onPicture(action, className, name) {
    const control = button(className + (action.off ? ' is-off' : ''), '', action.run, action.glyph);
    control.setAttribute('aria-label', action.label + ' · ' + name);
    control.title = action.title;
    // Off while a proposal waits, it says why on hover, on focus, and when it is pressed.
    if (action.off) control.setAttribute('aria-disabled', 'true');
    control.disabled = Boolean(working);
    return control;
  }
  function item(record, next = null) {
    const media = mediaOf(record),
      output = record.outputs[0] ?? {},
      number = numberOf(record),
      // (0.6.198) A take by the number its badge shows (« PRISE 4 »): « Prise 4 »; one without it by its place in the
      // Sortie, as its badge (« #3 »). The clip it comes from likewise (« Clip #4 · suite du clip #3 » before).
      name = Number.isInteger(output.take) ? 'Prise ' + output.take : '#' + number,
      madeFrom = (id, place) => {
        const take = runs.find(run => run.id === id)?.outputs?.[0]?.take;
        return Number.isInteger(take) ? 'la prise ' + take : '#' + place;
      },
      from = media === 'video' && sourceOf(record) ? numberOf({ id: sourceOf(record), mediaType: 'video' }) : null,
      // An upscale or an interpolation of a clip: the clip it was made from.
      transform = media === 'audio' ? null : transformOf(record),
      origin = transform && transformedFrom(record) ? numberOf({ id: transformedFrom(record), mediaType: media }) : null,
      said = [
        name,
        from ? 'suite de ' + madeFrom(sourceOf(record), from) : '',
        transform ? (transform === 'AGRANDIE' ? 'agrandissement' : 'interpolation') + (origin ? ' de ' + madeFrom(transformedFrom(record), origin) : '') : '',
        record.prompt || '',
      ]
        .filter(Boolean)
        .join(' · '),
      actions = actionsOf(record),
      shown = onStage()?.id === record.id,
      tile = node(
        'div',
        'studio-item' +
          (media === 'audio' ? ' is-sound' : '') +
          (extending?.id === record.id ? ' is-selected' : '') +
          (shown ? ' is-shown' : ''),
      );
    tile.dataset.id = record.id;
    tile.dataset.media = media;
    // The picture: a click shows it whole with its details (the screen keeps the last creation);
    // the one on the screen is ringed in white here (moodix-design.md 24). Dragged to a slot of
    // the inputs, it becomes that input.
    const pick = button('studio-item-pick', '', () => {
      if (pressed) return void (pressed = false);
      showDetails(record);
    });
    pick.setAttribute('aria-label', said);
    pick.title = said.length > 140 ? said.slice(0, 139) + '…' : said;
    if (shown) pick.setAttribute('aria-current', 'true');
    pick.draggable = !working;
    pick.ondragstart = event => {
      carried = record;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/plain', name);
      // Carried at the size of a slot of the inputs: the whole picture hid where it would go.
      dragGhost(pick, event.dataTransfer, media, output.take);
      tile.classList.add('is-carried');
      carrying(media);
    };
    pick.ondragend = () => {
      carried = null;
      tile.classList.remove('is-carried');
      carrying(null);
    };
    if (media === 'audio') {
      // A card (capture 23): « PRISE 29 · 30.00 S » and its kind, its stripes, its name.
      const head = node('span', 'studio-sound-head'),
        wave = node('span', 'studio-thumb-wave'),
        sound = lengthOfRecord(record),
        title = String(record.prompt || 'Son').split('\n')[0];
      head.append(
        node('span', '', [Number.isInteger(output.take) ? 'PRISE ' + output.take : '#' + number, sound ? soundFigures(sound) : '']
          .filter(Boolean)
          .join(' · ')),
        node('span', '', /musi|ace-?step|song/i.test(record.workflowName || '') ? 'MUSIQUE' : 'BRUITAGE'),
      );
      for (const part of [head, wave]) part.setAttribute('aria-hidden', 'true');
      pick.append(head, wave, node('span', 'studio-sound-name', title));
    } else {
      const small = output.thumbUrl,
        key = record.id + '|' + (small || output.originalUrl || '');
      let picture = pictures.get(key);
      if (picture) used.add(key);
      else if (small || media === 'image') {
        picture = node('img');
        // The tile is what is dragged, not the picture as a file of the browser.
        Object.assign(picture, { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
        picture.src = small || output.originalUrl || '';
        picture.onload = () => {
          if (media === 'image' && !small) {
            measured.set(record.id, { width: picture.naturalWidth, height: picture.naturalHeight });
            void thumbnailOf(api, record, 0, picture);
          }
          // The thumbnail of a clip found black (kept before 0.5.125): made again from the clip.
          else if (media === 'video' && small) void healThumbnail(api, record, 0, picture);
        };
      } else {
        // Its first picture only, of which a thumbnail is made for the next time.
        picture = stillClip(node('video'));
        Object.assign(picture, {
          muted: true,
          preload: 'metadata',
          playsInline: true,
          draggable: false,
          src: (output.originalUrl || '') + '#t=0.1',
        });
        picture.onloadeddata = () => void thumbnailOf(api, record, 0, picture);
      }
      if (!used.has(key)) {
        pictures.set(key, picture);
        used.add(key);
      }
      pick.append(picture);
    }
    // A right click, the menu key, or a long press: every action in a menu.
    tile.oncontextmenu = event => {
      event.preventDefault();
      openMenu(record);
    };
    let holding = null;
    pick.onpointerdown = event => {
      if (event.pointerType !== 'touch') return;
      holding = setTimeout(() => {
        pressed = true;
        openMenu(record);
      }, 550);
    };
    pick.onpointerup = pick.onpointercancel = pick.onpointerleave = () => clearTimeout(holding);
    // Under it (capture 22): « PRISE n » and its length (« 06.04 S »), its format for an image; a
    // continuation, « ↳ SUITE +04.00 S », glued to its take; an upscale or an interpolation,
    // « ↳ AGRANDIE » or « ↳ INTERPOLÉE » and its whole length. Made from a clip that is not in the
    // Sortie (a file of the disk, a take deleted since), « ↳ » would point at nothing: its own number.
    const take = output.take,
      caption = node('span', 'studio-item-caption'),
      badge = node(
        'span',
        'studio-item-number',
        from ? '↳ SUITE' : transform && origin ? '↳ ' + transform : Number.isInteger(take) ? 'PRISE ' + take : '#' + number,
      ),
      length = lengthOfRecord(record, Boolean(from)),
      shape = sizeOfRecord(record);
    caption.setAttribute('aria-hidden', 'true');
    caption.append(
      badge,
      node(
        'span',
        'studio-item-meta',
        media === 'image' ? (shape ? (formatOf(shape.width, shape.height)?.id ?? '') : '') : length ? (from ? '+' : '') + figures(length) : '',
      ),
    );
    // A clip as wide as it is long (30 px a second: captures 21 and 22), at the height of the strip;
    // its picture along it as frames at its format.
    if (media === 'video') {
      if (shape) tile.style.setProperty?.('--ratio', (shape.width / shape.height).toFixed(3));
      if (length) tile.style.setProperty?.('--seconds', length.toFixed(2));
      if (output.thumbUrl) {
        pick.style.setProperty?.('--strip', `url("${output.thumbUrl}")`);
        pick.classList.add('has-strip');
      }
    }
    // (0.6.256) An agrandie (interpolée) made just after its take sits glued to it too.
    if ((from && next?.id === sourceOf(record)) || (transform && origin && next?.id === transformedFrom(record))) tile.className += ' is-suite';
    tile.append(pick, caption);
    const main = actions.find(action => action.id === 'extend' || action.id === 'animate');
    if (main) tile.append(onPicture(main, 'studio-item-main', name));
    // (0.6.240) « Changer la caméra », beside it on a clip, when a model can film a video again.
    const second = actions.find(action => action.id === 'refilm');
    if (second) tile.append(onPicture(second, 'studio-item-main studio-item-second', name));
    // No « i » on the picture: a click on it shows its details.
    tile.append(
      onPicture(
        actions.find(action => action.id === 'delete'),
        'studio-item-del',
        name,
      ),
    );
    if (menuFor === record.id) {
      const menu = node('div', 'studio-item-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Actions · ' + name);
      for (const action of actions) {
        const entry = button('studio-menu-item' + (action.danger ? ' is-danger' : ''), action.label, () => {
          menuFor = null;
          action.run();
        });
        entry.setAttribute('role', 'menuitem');
        entry.title = action.title;
        // (0.6.198) Its bubble beside the menu, as beside a list (help-tips.mjs): above its line, « Ouvrir :
        // l’original, ses paramètres, Télécharger » covered « Modifier ».
        entry.dataset.tipSide = 'left';
        if (action.off) entry.setAttribute('aria-disabled', 'true');
        menu.append(entry);
      }
      menu.onkeydown = event => {
        const entries = [...(menu.querySelectorAll?.('button') ?? [])],
          at = entries.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation?.();
          backTo(record);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          entries[(at + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus?.();
        }
      };
      // Closed when the focus leaves it for another control (Tab), where it is: the focus stays where it
      // went. (0.6.194, audit of 21/11, A6) Listened to: `onfocusout` is no property of an element in
      // Chromium, it was never called. Taken out of the page (drawn again), it goes nowhere and stays
      // open: a press beside it closes it (dropMenu, at the end of setupStudio).
      menu.addEventListener?.('focusout', event => {
        if (menuFor === record.id && event.relatedTarget && !menu.contains?.(event.relatedTarget)) dropMenu(menu);
      });
      tile.append(menu);
    }
    // « Supprimer la prise 12 ? » (0.6.147: the number of the take, as the Pellicule asks it; the montages that
    // use it said under it), written once for both (take-delete.mjs).
    if (confirmFor === record.id)
      tile.append(
        deleteQuestion({
          node,
          icon,
          record,
          media,
          shown: number,
          name,
          // A take of the Sortie is too small for the names of the montages: « Dans un montage ».
          short: true,
          onKeep: () => backTo(record),
          onDelete: () => {
            confirmFor = null;
            void remove(record);
          },
        }),
      );
    return tile;
  }
  /** The length of a creation (`added`: what a continuation adds to its clip). */
  function lengthOfRecord(record, added = false) {
    const p = record.parameters ?? {};
    if (Number(p.seconds) > 0) return Number(p.seconds);
    if (!(p.frames > 0 && p.fps > 0)) return null;
    return Math.max(0, p.frames - (added && p.overlap_frames > 0 ? p.overlap_frames : 0)) / p.fps;
  }
  /** The size of a creation, from its file or its settings; null when neither says it. */
  function sizeOfRecord(record) {
    const output = record.outputs?.[0] ?? {},
      measuredSize = measured.get(record.id),
      width = output.width ?? record.parameters?.width ?? measuredSize?.width,
      height = output.height ?? record.parameters?.height ?? measuredSize?.height;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  // The pictures of the Sortie, kept from one drawing to the next (those of this drawing in `used`).
  const pictures = new Map();
  let used = new Set();
  /**
   * The Sortie: the creations of the project, of all its conversations, images, clips and sounds
   * together (16/11), the newest at the left (a new one pushes the others to the right); its button
   * at the right, released, keeps those of the kind of the mode (the images in Image, the clips in
   * Vidéo, the sounds in Son). Empty, its icon and a line that say so, without a frame (one would look like a place
   * to drop a file: moodix-design.md 7 bis 18).
   */
  function outputs() {
    used = new Set();
    const section = node('section', 'studio-block is-output studio-results'),
      own = SORTS.find(item => item.id === mode) ?? SORTS[0],
      sort = sortieAll ? SORTS[0] : own,
      // Of the whole project, whatever the conversation open (a new one too): they are shared in it.
      shown = sortieAll ? runs : runs.filter(record => mediaOf(record) === mode);
    section.setAttribute('aria-label', 'Sortie');
    // (0.6.478, variante A) The requests of the queue are in the window at the bottom right alone, under the settings
    // (work-miniature.mjs): the Sortie keeps the take under way and the takes made. The take under way is drawn
    // whatever the Sortie holds (0.6.466, B2: with no take yet, or none of the kind shown, it said it was empty while
    // the screen made one). A take followed again after a reload: « EN COURS » too, when a queue waits.
    const here = conversation(),
      queued = queue.entries().some(entry => entry.conversation === here),
      making = working && (!working.external || queued) ? node('div', 'studio-item is-making') : null,
      ahead = Boolean(making);
    if (!runs.length && !ahead) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(node('span', '', own.none));
      section.append(empty);
      return section;
    }
    // The creations, and at their right the button that sorts them.
    const row = node('div', 'studio-sortie-row');
    section.append(row);
    if (!shown.length && !ahead) {
      const empty = node('div', 'studio-empty-strip');
      empty.append(node('span', '', sort.none));
      row.append(empty, sortButton(own));
      return section;
    }
    const strip = node('div', 'studio-strip studio-timeline');
    strip.setAttribute('aria-label', sort.id === 'all' ? 'Créations du projet' : sort.label + ' du projet');
    // The creation under way, at the far left (studio-maquette.md): dark, « EN COURS » and how far.
    // (0.6.256, captures A05 and B09) A take being made larger or smoother: « ↳ AGRANDIE », glued to its take.
    const larger = making ? working.finish : null,
      finishFrom = larger && shown.some(record => record.id === larger.record.id) ? larger.record.id : null;
    if (making) {
      const pick = node('div', 'studio-item-pick'),
        caption = node('span', 'studio-item-caption');
      caption.append(node('span', 'studio-item-number', finishFrom ? FINISH[working.finish.verb].badge : 'En cours'), node('span', 'studio-item-meta', ''));
      making.setAttribute('aria-hidden', 'true');
      making.append(pick, caption);
      if (finishFrom) making.className += ' is-suite';
      else strip.append(making);
    }
    // A continuation made just after its clip sits glued to it (« une suite reste collée à sa prise »).
    shown.forEach((record, at) => {
      if (record.id === finishFrom) strip.append(making);
      strip.append(item(record, shown[at + 1]));
    });
    // The wheel of a mouse scrolls it sideways, the pointer anywhere over the Sortie (a mouse has
    // no sideways wheel); a sideways move of a trackpad is left to the browser.
    section.onwheel = event => scrollSideways(strip, event);
    row.append(strip, sortButton(own));
    // Those no longer shown (another mode, a creation removed) are let go.
    for (const key of pictures.keys()) if (!used.has(key)) pictures.delete(key);
    return section;
  }
  /**
   * What the hand carries (studio-maquette.md, « Glisser »; 16/11): the picture at the size of a slot
   * of the inputs (one on the screen gives it, 52 px otherwise) and 104 %, tilted by −3°, with its
   * shadow and « PRISE n » at its top left; a sound, its grey stripes. Drawn at once on a canvas from
   * the picture the tile already holds: nothing is loaded while the drag starts. (0.6.169) `size`: the
   * Bobine gives its own, that of a take on its track.
   */
  function dragGhost(pick, transfer, media, take = null, size = null) {
    const page = globalThis.document;
    if (!transfer?.setDragImage || !page?.createElement || !page.body) return;
    const slot = size ? null : page.querySelector?.('#studio-view .studio-slot')?.getBoundingClientRect?.(),
      width = Math.round((size?.width || slot?.width || 52) * 1.04),
      height = Math.round((size?.height || slot?.height || 52) * 1.04),
      // Room around it for the tilt and the shadow.
      room = 16,
      full = [width + room * 2, height + room * 2],
      ratio = globalThis.devicePixelRatio || 1,
      canvas = page.createElement('canvas'),
      context = canvas.getContext?.('2d');
    if (!context) return;
    canvas.width = Math.round(full[0] * ratio);
    canvas.height = Math.round(full[1] * ratio);
    Object.assign(canvas.style, {
      position: 'fixed',
      top: '-1000px',
      left: '-1000px',
      width: full[0] + 'px',
      height: full[1] + 'px',
      pointerEvents: 'none',
    });
    const shape = () => {
      context.beginPath();
      if (context.roundRect) context.roundRect(0, 0, width, height, 6);
      else context.rect(0, 0, width, height);
    };
    context.scale(ratio, ratio);
    context.translate(full[0] / 2, full[1] / 2);
    context.rotate((-3 * Math.PI) / 180);
    context.translate(-width / 2, -height / 2);
    context.save();
    context.shadowColor = 'rgba(0, 0, 0, 0.55)';
    context.shadowBlur = 14;
    context.shadowOffsetY = 6;
    shape();
    context.fillStyle = '#000';
    context.fill();
    context.restore();
    context.save();
    shape();
    context.clip();
    const source = pick.querySelector?.('img, video'),
      sourceWidth = source?.naturalWidth || source?.videoWidth,
      sourceHeight = source?.naturalHeight || source?.videoHeight,
      // A picture still loading has its size and no pixels yet.
      drawable = source?.tagName === 'VIDEO' ? source.readyState >= 2 : source?.complete !== false;
    if (media !== 'audio' && sourceWidth && sourceHeight && drawable) {
      const scale = Math.max(width / sourceWidth, height / sourceHeight),
        drawn = [sourceWidth * scale, sourceHeight * scale];
      context.drawImage(source, (width - drawn[0]) / 2, (height - drawn[1]) / 2, ...drawn);
    } else if (media === 'audio') {
      context.fillStyle = '#6e7480';
      for (let x = 7; x < width - 7; x += 7) context.fillRect(x, height * 0.34, 3, height * 0.32);
    } else {
      // Its picture not there yet: the slot's size all the same, framed in grey.
      context.strokeStyle = '#6e7480';
      context.lineWidth = 2;
      context.strokeRect(1, 1, width - 2, height - 2);
    }
    context.restore();
    // « PRISE n » at its top left, as on the screen.
    if (Number.isInteger(take)) {
      const word = 'PRISE ' + take,
        mono = globalThis.getComputedStyle?.(page.documentElement)?.getPropertyValue?.('--font-mono')?.trim() || 'monospace';
      context.font = `400 8.5px ${mono}`;
      context.letterSpacing = '0.8px';
      const chip = context.measureText(word).width + 10;
      context.fillStyle = 'rgba(12, 11, 14, 0.78)';
      context.beginPath();
      if (context.roundRect) context.roundRect(4, 4, chip, 15, 4);
      else context.rect(4, 4, chip, 15);
      context.fill();
      context.fillStyle = '#eee8de';
      context.fillText(word, 9, 14.5);
    }
    page.body.append(canvas);
    transfer.setDragImage(canvas, full[0] / 2, full[1] / 2);
    // Its picture is taken as the drag starts: the canvas can go.
    setTimeout(() => canvas.remove(), 0);
  }
  /**
   * The button at the right of the Sortie: pressed, the whole project (as it is to begin with);
   * released, the kind of the mode only; a click goes from one to the other.
   */
  function sortButton(own) {
    const box = node('div', 'studio-sort'),
      main = button('studio-sort-go is-current', '', () => {
        sortieAll = !sortieAll;
        render();
        document.querySelector?.('#studio-view .studio-sort-go')?.focus?.();
      }, 'grid');
    main.setAttribute('aria-label', 'Trier la Sortie · ' + (sortieAll ? 'tout' : own.label.toLowerCase()));
    main.setAttribute('aria-pressed', String(sortieAll));
    main.title = 'Toutes les prises du projet';
    box.append(main);
    return box;
  }
  /** A turn of the wheel, as so many pixels sideways along `strip` (nothing when it all shows). */
  function scrollSideways(strip, event) {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || strip.scrollWidth <= strip.clientWidth) return;
    // Lines (Firefox) or pages, as pixels.
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? strip.clientWidth : 1;
    event.preventDefault();
    strip.scrollLeft += event.deltaY * unit;
  }
  /** A new creation goes at the left of the strip: the strip shows it. */
  function scrollStrip() {
    const strip = document.querySelector?.('#studio-view .studio-strip');
    if (strip) strip.scrollLeft = 0;
  }

  // ------------------------------------------------------------------ the page
  function message(text) {
    const panel = node('section', 'studio-desk is-empty');
    // The chat stays at hand when nothing can be made here.
    panel.append(node('p', 'asset-empty', text), agent);
    return panel;
  }
  /**
   * The Studio as it will be, while its tools are read the first time: its four blocks on their
   * grain, the screen in the middle with the room of its bar. What they hold fades in once read.
   */
  function skeleton() {
    const desk = node('div', 'studio-desk is-loading'),
      said = node('p', 'sr-only', 'Chargement du Studio…'),
      screen = node('div', 'studio-screen'),
      preview = node('section', 'studio-block is-preview');
    desk.setAttribute('aria-busy', 'true');
    said.setAttribute('role', 'status');
    screen.append(node('div', 'studio-stage'));
    const waiting = node('div', 'studio-actionbar is-waiting');
    waiting.append(agent);
    preview.append(screen, waiting);
    const blocks = [node('section', 'studio-block is-input'), preview, node('section', 'studio-block is-settings')];
    desk.append(said, ...blocks.map(grained), grained(node('section', 'studio-block is-output')));
    return desk;
  }
  /**
   * A block of the Studio: what it holds, in its body. No grain of its own any more: the grain of the
   * room is behind the glass, never over a picture (reference-maquettes.md).
   */
  function grained(block) {
    const body = node('div', 'studio-block-body');
    body.append(...block.children);
    block.replaceChildren(body);
    return block;
  }
  /**
   * Image / Vidéo / Son, at the top left of the Studio: three tabs, their icons, their names for
   * screen readers and in their tooltips. Each chooses its mode (chooseMode); from elsewhere, the
   * Studio opens in that mode.
   */
  function kinds() {
    const bar = kindsBar();
    if (!bar) return;
    bar.removeAttribute('data-ai-active');
    bar.removeAttribute('data-ai-touched');
    aiTarget(bar, 'kind');
    if (bar.children.length !== MODES.length) {
      bar.replaceChildren(
        ...MODES.map(item => {
          const tab = node('button', 'kind-tab');
          tab.type = 'button';
          tab.setAttribute('role', 'tab');
          tab.setAttribute('aria-label', item.label);
          tab.title = item.label;
          // Its name in the one tooltip of the page (help-tips.mjs).
          tab.dataset.tip = item.label;
          tab.dataset.mode = item.id;
          // Its name beside its icon when it is the one chosen (moodix.css).
          tab.append(icon(item.icon), node('span', 'kind-tab-name', item.label));
          tab.onclick = () => {
            chooseMode(item.id);
            if (globalThis.document?.body?.dataset?.view !== 'studio') openStudio();
          };
          return tab;
        }),
      );
      // The arrows go from one mode to the next, as in any row (or column) of tabs.
      bar.onkeydown = event => {
        const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
        if (!step || locked()) return;
        event.preventDefault();
        const ring = MODES.map(item => item.id),
          next = ring[(ring.indexOf(mode) + step + ring.length) % ring.length];
        chooseMode(next);
        for (const tab of bar.children) if (tab.dataset.mode === next) tab.focus?.();
      };
    }
    for (const tab of bar.children) {
      const chosen = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(chosen));
      tab.tabIndex = chosen ? 0 : -1;
      // (0.6.466) Free while the Studio makes a take of its own: the next request may be of another kind.
      tab.disabled = locked();
    }
  }
  /**
   * Image · Vidéo · Son are drawn in the head of the screen (form); without a screen (nothing ready to
   * make, the Studio being read), they go back above the body, never left in a page drawn away.
   */
  function keepKinds(body) {
    const bar = kindsBar();
    if (bar && !body.contains?.(bar)) body.parentElement?.insertBefore?.(bar, body);
  }
  function chooseMode(id) {
    if (locked() || aiWorking) return;
    if (mode === id) return;
    if (ai) takeOver();
    setMode(id);
    release();
  }
  function setMode(next) {
    // (0.6.254) Another page of the Studio: one try again.
    if (next !== mode) tries = 1;
    mode = next;
    failure = '';
    formatsOpen = addOpen = triesOpen = cameraMenu = false;
    pieceOpen = null;
    if (next !== 'video') extending = null;
    // (0.6.256) The page Agrandir (Interpoler) of a take is left for another kind, as Prolonger is.
    if (finishing && next !== mediaOf(finishing.record)) finishing = null;
    // Back in Vidéo while a proposal of Moodix AI waits there: the clip it continues is its own, not
    // lost with a look at Image or Son (it was then shown, and its length sent, as a new video's).
    else if (proposal?.mode === 'video' && proposal.values) extending = proposal.extending ?? null;
    render();
  }
  // (0.6.95) What measures the prompt of a proposal once drawn (folded, its arrow only when it is
  // cut), and follows its width; the line of Moodix AI last drawn, let go once its proposal is.
  let measurePrompt = null,
    promptWatch = null,
    explaining = null;
  /**
   * The four blocks: Entrée, the preview with « Générer », Réglages, Sortie. Their places
   * depend on the width only: three columns and the output under them when wide.
   */
  function form() {
    // (A Studio drawn without its prompt, nothing ready to make: nothing of a former one to measure.)
    measurePrompt = null;
    const draft = drafts[mode],
      list = offered(),
      workflow = current();
    if (!info.enabled) return message('La génération locale est désactivée : activez-la dans Paramètres › Génération.');
    if (!workflow)
      return message(
        mode === 'audio'
          ? 'Aucun modèle de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.'
          : 'Aucun modèle prêt pour cette création : vérifiez Paramètres › Modèles.',
      );
    // The first time a mode shows its model, the settings saved for it come back (not over a
    // proposal of Moodix AI, which sets its own).
    if (!presetShown[mode]) {
      presetShown[mode] = true;
      if (!answering() && !extending) applyPreset(workflow);
    }
    const desk = node('div', 'studio-desk'),
      write = node('section', 'studio-block is-input studio-write'),
      preview = node('section', 'studio-block is-preview studio-center'),
      settings = node('section', 'studio-block is-settings studio-settings');
    if (aiCarry) desk.setAttribute('data-carrying', 'image');
    write.setAttribute('aria-label', 'Entrée');
    preview.setAttribute('aria-label', 'Aperçu et génération');
    settings.setAttribute('aria-label', 'Réglages');

    // Entrée: what the user writes and hands over.
    const named = node('label', 'sr-only', 'Prompt');
    named.htmlFor = 'studio-prompt';
    write.append(named);
    // (0.6.207) A continuation has no banner above the prompt any more (« Suite de la prise 5 : … », « Annuler »):
    // its clip is the first piece of the plateau, « À prolonger » (prolongPiece).
    // What a proposal of Moodix AI says of itself, as on its card in the chat: an image the user
    // named that it does not transmit (the continuation of a video by LTX 2.5 takes none), a model
    // used in place of the one asked for. Nothing else showed it here. At the head of the column:
    // under the cases it was out of sight in a window of 720 px (the column scrolls in itself).
    if (answering())
      for (const note of proposal.request.notes ?? []) write.append(node('p', 'studio-proposal-note', String(note)));
    // (0.6.256) Agrandir, Interpoler: their prompt greyed, empty, why under the pointer; the one of the page kept.
    const finish = finishOn();
    const prompt = textarea(
      // (0.6.240) A clip filmed again: the clip says what is filmed. Its field is empty and closed meanwhile; the
      // prompt of the video being written stays in its draft, neither shown nor sent.
      refilming() || finish ? '' : draft.prompt,
      8,
      finish
        ? ''
        : refilming()
        ? 'Rien à écrire : seule la caméra change.'
        : extending
          ? 'Ce qui se passe ensuite…'
        : mode === 'image'
          ? 'Décrivez votre image…'
          : mode === 'video'
            ? workflow.follows
              ? 'Décrivez la vidéo avec votre personnage…'
              : animatedStart()
                ? 'Décrivez le mouvement…'
                : 'Décrivez votre vidéo…'
            : 'Décrivez votre son…',
      value => {
        draft.prompt = value;
        // « Enrichir le prompt » waits for a few words; « Générer », for one.
        improvable();
        goable();
        // (0.6.200) The empty screen says nothing from the first key, and again when it is all taken away.
        sayBlank();
      },
    );
    prompt.id = 'studio-prompt';
    if (refilming() || finish) prompt.disabled = true;
    prompt.maxLength = 4000;
    prompt.title = MODIFIER + ' + Entrée pour générer';
    aiTarget(prompt, 'prompt');
    // Folded to its first lines while a proposal of Moodix AI is set and waits (0.6.95): what it
    // understood, at the top of the screen, is read first; its arrow shows it whole.
    const folded = answering() ? proposal.fold : null;
    // (0.6.452, D8b) Son has no wand, but the microphone of the dictation, alone in the corner of its prompt.
    const micAlone = mode === 'audio' && !finish && Boolean(dictation);
    const promptField = node(
      'div',
      'studio-field studio-prompt-field is-wide' +
        ((mode !== 'audio' && !finish && !refilming()) || micAlone ? ' has-enrich' : '') +
        (folded && !folded.open ? ' is-folded' : ''),
    );
    promptField.append(prompt);
    if (finish) {
      promptField.className += ' is-needless';
      promptField.title = prompt.title = FINISH[finish.verb].needless;
      // (0.6.317) Nor on « Changer la caméra », which has nothing to write: its wand, greyed, said « Ajoutez
      // d’abord la vidéo et le personnage » (the model reads the clip it is given, as one that puts a character).
    } else if (mode !== 'audio' && !refilming()) promptField.append(enrichRow());
    else if (micAlone) {
      const corner = micRow();
      if (corner) promptField.append(corner);
    }
    if (enriching) promptField.classList.add('is-improving');
    measurePrompt = folded
      ? foldPrompt({ node, icon, field: promptField, box: prompt, state: folded, onToggle: () => render() })
      : null;
    write.append(promptField);
    // An image pasted (Ctrl+V) or dropped anywhere on the column: in the first free slot.
    write.ondragover = event => {
      if (!event.dataTransfer?.types?.includes?.('Files')) return;
      event.preventDefault();
      write.classList.add('is-dropping');
    };
    write.ondragleave = event => {
      if (!write.contains?.(event.relatedTarget)) write.classList.remove('is-dropping');
    };
    write.ondrop = event => {
      write.classList.remove('is-dropping');
      const file = imageFile(event.dataTransfer?.files),
        clip = file ? null : videoFile(event.dataTransfer?.files);
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      if (file) placeImage(workflow, file);
      else if (clip) placeVideo(workflow, clip);
      else notice('Seules les images PNG, JPEG ou WebP vont dans les cases.');
    };
    write.onpaste = event => {
      // (0.6.331) Text that comes with a picture of itself (cells of Excel): pasted in the prompt, as in the Chat.
      if (event.clipboardData?.getData?.('text/plain')?.trim()) return;
      const file = imageFile(event.clipboardData?.files);
      if (!file) return;
      event.preventDefault();
      placeImage(workflow, file);
    };
    // A song's lyrics are words handed over too: under the prompt, opened on demand. (0.6.203) From the list
    // of « Ajouter » (addChoices, capture 101), no longer from a button « + Paroles (facultatif) » of their own.
    const lyrics = workflow.settings.find(setting => setting.key === 'lyrics' && setting.type === 'string');
    if (lyrics) {
      const store = (draft.settings[workflow.id] ??= {}),
        value = store.lyrics ?? lyrics.default ?? '';
      if (draft.lyrics || String(value).trim()) {
        const box = textarea(String(value), 4, SETTING_HELP.lyrics, next => {
          store.lyrics = next;
        });
        if (lyrics.maxLength) box.maxLength = lyrics.maxLength;
        aiTarget(box, 'setting-lyrics');
        write.append(field(settingName('lyrics'), box, { wide: true }));
      }
    }
    // The input images (a continuation shows only those it takes: subject references, for
    // MiniMax H3). Another model than the last one drawn: their blocks say so for a moment.
    if (shownModel[mode] && shownModel[mode] !== workflow.id) flashUntil = Date.now() + 650;
    shownModel[mode] = workflow.id;
    // (0.6.256) Agrandir, Interpoler: their take alone, in its case « À agrandir » (« À interpoler »).
    const row = finish ? finishPiece(finish) : inputs(workflow);
    if (row) write.append(row);

    // Réglages (moodix-design.md 16, 20, 28): blocks without titles, Modèle · Durée + Taille ·
    // LoRA, and « ··· » for the rare ones (the seed, the workflow's own settings).
    settings.append(modelBlock(workflow, list));
    const lacking = extending ? null : unavailableNote(workflow);
    if (lacking) settings.append(lacking);
    // (0.6.256) Agrandir, Interpoler: the model, then its factor and what it makes; nothing else (its settings are
    // in its page of Paramètres › Modèles).
    const finishSize = finish ? finishBlock(workflow, finish) : null;
    if (finishSize) settings.append(finishSize);
    // The format, above the resolution (studio-maquette.md: no longer under the screen).
    if (workflow.limits && !extending && !finish && mode !== 'audio') {
      const formats = node('div', 'studio-set-block studio-set-format');
      formats.append(node('span', 'studio-label', 'Format'), formatChips(workflow));
      settings.append(formats);
    }
    // (0.6.250) A clip filmed again: the size it is brought to, in the place of the format and the length.
    const shape = finish ? null : refilming() ? refilmBlock(workflow) : shapeBlock(workflow);
    if (shape) settings.append(shape);
    // Those of the user show on a proposal of Moodix AI too: it is made with them (edits).
    const styled = workflow.styled && mode !== 'audio' && !extending;
    const loras = finish ? null : loraBlock(workflow, styled);
    if (loras) settings.append(loras);
    const rare = finish ? [] : rareLines(workflow);
    if (rare.length) {
      const more = button('studio-more-pill' + (advanced ? ' is-open' : ''), '···', () => {
        advanced = !advanced;
        // (0.6.206) One thing open at a time: the list « Ajouter » and the window of a piece close for it.
        if (advanced) {
          addOpen = cameraMenu = false;
          pieceOpen = null;
        }
        moreFocus = advanced;
        render();
      });
      more.append(node('span', 'studio-more-word', 'Plus de réglages'));
      more.setAttribute('aria-label', 'Plus de réglages');
      more.title = 'Plus de réglages';
      more.setAttribute('aria-haspopup', 'dialog');
      more.setAttribute('aria-expanded', String(advanced));
      // (0.6.206, captures 110 and 111; his decision N1 of 21/11) Its lines in a window of glass against the
      // column, at its left, over the preview, in two columns: opened under its pill, they made the column of
      // the Réglages scroll, the model and the format out of sight. Shown once on the page (showMore).
      const pane = node('div', 'glass-menu studio-more-window'),
        block = node('div', 'studio-rare');
      pane.setAttribute('role', 'dialog');
      pane.setAttribute('aria-label', 'Plus de réglages');
      pane.hidden = block.hidden = !advanced;
      block.append(...rare);
      pane.append(node('p', 'studio-window-title', 'Plus de réglages'), block);
      settings.append(more, pane);
      if (advanced) globalThis.queueMicrotask?.(() => pane.isConnected && advanced && showMore(pane, more));
    }

    // The preview, its formats and the button.
    const { screen, over } = stage(),
      head = node('div', 'studio-screen-head'),
      heldGpu = gpuBlocked() && !working,
      freed = !heldGpu && !working && Date.now() < freedUntil,
      // A work goes on in another conversation (0.6.81): nothing is made here until its end, said
      // on the line of the step (a proposal of Moodix AI answered here is this conversation's own).
      busyElsewhere = !working && !heldGpu && !answering() && !checking ? elsewhere() : '',
      // (0.6.253) The chat answers (or an operation of the page goes on): « Générer » waits, greyed (A10).
      chatBusy = !working && !heldGpu && !answering() && !checking && !ai && !busyElsewhere ? blocked() : '',
      // (0.6.466) Between two requests of the queue: the next one is being asked, or waits for the card a moment.
      between = !working && chaining ? (cardWait?.card ? 'Attente de la carte graphique…' : 'Demande suivante…') : '',
      step = node(
        'p',
        'studio-progress' + (heldGpu ? ' is-alert' : ''),
        heldGpu
          ? 'Carte graphique encore prise'
          : freed
            ? 'GPU libéré. Le modèle peut redémarrer.'
            : busyElsewhere
              ? busyElsewhere.replace(/ : .*$/, '')
              : (working?.label ?? between),
      ),
      // What Moodix AI understood, while its pointer sets the Studio and while its proposal waits
      // (0.6.95, studio-explain.mjs): in the place of « Moodix AI règle le Studio », its words.
      explain = (answering() || ai) && proposal?.explain ? proposal.explain : null;
    busyDrawn = busyElsewhere + '|' + chatBusy;
    // The line of a proposal answered, or replaced, is let go (it watched its width).
    if (explaining && explaining !== proposal?.explain) explaining.dispose();
    explaining = proposal?.explain ?? null;
    // Image · Vidéo · Son at the left, then the step under way in the middle, or what Moodix AI
    // proposes. (The card held during a proposal says it on the screen itself: its veil, 54.)
    step.id = 'studio-progress';
    step.setAttribute('role', 'status');
    step.hidden = Boolean(explain) || (!working && !heldGpu && !freed && !busyElsewhere && !between);
    // How long the take under way has been in the making (0.6.93), beside its step: not among what
    // the status says aloud, which would read it every second.
    elapsedNode = working ? node('time', 'studio-elapsed', working.time ?? '') : null;
    if (elapsedNode) {
      elapsedNode.setAttribute('aria-hidden', 'true');
      step.append(elapsedNode);
    }
    if (kindsBar()) head.append(kindsBar());
    head.append(step);
    if (explain) head.append(explain.element);
    // A creation is on the screen to be looked at (inspect): back to the Studio as it was before.
    // Not while Moodix AI proposes or has a character checked, in whatever mode: the settings of
    // before would come under what it proposes (lookBack).
    if (looked && !proposal && !checking && !ai) {
      const back = button('studio-look-back', 'Revenir', lookBack, 'undo');
      back.title = 'Retirer ce média de l’écran et remettre vos réglages d’avant';
      back.setAttribute('aria-label', 'Revenir à mes réglages : retirer ce média de l’écran');
      back.disabled = locked();
      head.append(back);
    }
    preview.append(head, screen);
    const bar = node('div', 'studio-actionbar');
    // The actions of the take on the screen; held while Moodix AI proposes or a take is made. (0.6.255, lot 3) In a
    // column at the right of the frame, over it (studio-frame-over follows its size, whatever its format): the bar
    // keeps « Générer » and Moodix AI alone, in the middle.
    const onScreen = railTake();
    if (onScreen) {
      const row = takeActions(onScreen, 0);
      row.className += ' studio-rail';
      // (Each makes a creation: not while another conversation makes one, 0.6.81.) (0.6.466, D7) A take of the Studio
      // being made: each greyed with why (RAIL_HELD), the form free; a take of the Chat or of the Bobine: held.
      row.inert = answering() || locked() || Boolean(busyElsewhere);
      if (row.inert) row.classList.add('is-held');
      // (0.6.256) On the page Agrandir (Interpoler) of this take: its button pressed; pressed again, the page is left.
      const pressed =
        finish?.record.id === onScreen.id
          ? [...row.children].find(child => String(child.className).split(' ').includes('output-action-' + finish.verb))
          : null;
      if (pressed) {
        pressed.className += ' is-on';
        pressed.setAttribute('aria-pressed', 'true');
      }
      // (0.6.258, lot 6) An image made larger, the image it was made from still there: « Comparer », 8 px under them.
      if (enlargedFrom(onScreen)) row.append(compareButton());
      over.append(row);
    }
    bar.append(node('div', 'output-actions is-empty'));
    // (0.6.466) A take of the Studio itself being made (or the moment to the next one of its queue): « Générer
    // ensuite » over the bar that fills, the form free. Requests paused in this conversation: « Reprendre · n ».
    const next = ownWork(),
      waits = queue.paused(conversation()),
      paused = resumable().length > 0,
      goes = next ? ' is-next' : paused ? ' is-again' : '';
    // (0.6.253) Greyed, it still answers (greyable): its reason in its bubble, and what lacks lights up (pressGo).
    const go = aiTarget(
        greyable(button('primary studio-go' + goes, '', event => pressGo(go, event), 'go')),
        'generate',
      ),
      label = node(
        'span',
        'studio-go-label',
        next
          ? 'Générer ensuite'
          : paused
            ? `Reprendre · ${waits.length}`
            : working
              ? goLabel()
              : refilming()
                ? 'Changer la caméra'
                : extending
                  ? 'Générer la suite'
                  : finish
                    ? FINISH[finish.verb].go
                    : 'Générer',
      ),
      fill = node('span', 'studio-go-bar');
    goButton = go;
    fill.setAttribute('aria-hidden', 'true');
    // The triangle and its word, centred (moodix-design.md 7 bis 22); the keys are in its tooltip.
    // While the creation is made, « Génération · 42 % » alone, over the bar that fills the button.
    // (0.6.466) « Générer ensuite »: how far the take is at its right (« 1/3 · 46 % », progress); between two
    // requests, the bar of a wait, as when a take begins.
    if (next) {
      go.append(label, node('span', 'studio-go-percent', working ? nextPercent() : ''), fill);
      if (!working) go.classList.add('is-indeterminate');
    } else go.append(label, fill);
    go.title = (answering() ? 'Générer la proposition de Moodix AI' : finish ? FINISH[finish.verb].go : 'Générer') + ` (${MODIFIER}+Entrée)`;
    // Nothing to make without a prompt (55): greyed, said in its tooltip; Moodix AI stays. (0.6.256) Agrandir and
    // Interpoler need none, nor any input but their take.
    const blank = !draft.prompt.trim() && !answering() && !checking && !refilming() && !finish;
    // (0.6.253, A10 « Moodix AI écrit ») Nor while the chat answers (`blocked`, which generate refuses): « Générer »
    // waits, greyed, and says why. Not under a proposal it waits on, which is answered here.
    go.disabled = enriching || Boolean(working) || Boolean(workflow.unavailable) || blank || Boolean(busyElsewhere) || Boolean(chatBusy);
    if (blank && !working) {
      go.title = blankWhy();
      go.classList.add('is-blank');
    }
    // (0.6.188, capture 96) Nor without an input its model cannot do without (the start image of Wan 2.2, the video
    // and the character of SCAIL-2): greyed, its tooltip says which, as request() says it once pressed. The prompt
    // first, as there; not under a proposal of Moodix AI, which puts its images itself.
    const missing =
      !working && !blank && !answering() && !checking && !finish ? inputMissing(workflow, draft.inputs, extending) : '';
    if (missing) {
      go.disabled = true;
      go.title = missing;
    }
    // (0.6.450) Nor a size the card of this computer cannot make, when the page has no other to offer (an image
    // already large under SeedVR2): greyed, its tooltip says why, as the note under the size.
    const tooLarge = finish && !working ? finishHeld(workflow) : '';
    if (tooLarge) {
      go.disabled = true;
      go.title = tooLarge;
      go.classList.add('is-unavailable');
    }
    // (0.6.240) Nor a camera its model does not make, nor the one of a clip too long for it: greyed, its tooltip
    // says which, and it follows the bars of the tool in place (refilmGate, called by its window).
    refilmGate = null;
    if (refilming() && !working && !next && !go.disabled) {
      const lit = go.title;
      refilmGate = () => {
        const held = refilmRefusal(workflow);
        go.disabled = Boolean(held);
        go.title = held || lit;
        go.classList.toggle('is-unavailable', Boolean(held));
      };
      refilmGate();
    }
    // The only model of this mode cannot run here: « Générer » is greyed and says why.
    if (workflow.unavailable) {
      go.title = workflow.unavailable;
      go.classList.add('is-unavailable');
    }
    // One creation at a time (0.6.81): greyed while another conversation makes one, and why.
    if (busyElsewhere && !workflow.unavailable) {
      go.title = busyElsewhere;
      go.classList.add('is-unavailable');
    }
    if (chatBusy && !workflow.unavailable) {
      go.title = chatBusy;
      go.classList.add('is-unavailable');
    }
    // (0.6.452) Nor while the dictation listens or writes in the prompt: its words are not there yet. (0.6.455) What
    // it would be without, kept for its end (goable).
    if (dictating() && !working && !finish && !workflow.unavailable) {
      undictated.set(go, [go.disabled, go.title]);
      go.disabled = true;
      go.title = DICTATING;
    }
    // A take of the Chat of this conversation, followed here (watch, 0.6.96): one creation at a time.
    // (0.6.200) Any other take made: the words of the line of its step and its time, which progress() puts
    // in its bubble at the end of each drawing (workTip).
    if (working?.chat) go.title = BUSY_HERE;
    if (working && !next) {
      go.setAttribute('role', 'progressbar');
      go.setAttribute('aria-valuemin', '0');
      go.setAttribute('aria-valuemax', '100');
      go.setAttribute('aria-label', 'Génération en cours');
    }
    // (0.6.466) « Générer ensuite » and « Reprendre »: greyed for their own reasons (greyedWhy), said in their bubble,
    // lit by a press as « Générer » is.
    if (next || paused) {
      const why = greyedWhy(next ? 'next' : 'again');
      undictated.delete(go);
      go.disabled = Boolean(why);
      go.classList.toggle('is-blank', why?.light === 'prompt');
      go.classList.toggle('is-unavailable', Boolean(why) && !why.light);
      go.title = why?.text || (next ? NEXT_TIP : resumeTip(waits.length));
      go.setAttribute('aria-label', next ? 'Générer ensuite' : `Reprendre · ${waits.length}`);
    }
    // (0.6.253, generer-maquette.md, decided on 23/11) Two buttons, 8 px apart, centred: [« × 1 ⌄ » | « ▶ Générer »],
    // one glass, then [« ◐ Moodix AI »] (the Double verre « ▶ Générer » | the Éclipse before). While a take is made,
    // the glass of « Générer » is the bar that fills, « Arrêter » in it at its right, after a rule; Moodix AI stays.
    // (0.6.466) A take of the Studio: 266 px, « Générer ensuite » in it. Paused: « Reprendre · n », its × after a rule.
    const group = node('div', 'studio-go-group'),
      glass = node('div', 'studio-go-glass' + (working || next ? ' is-working' : '') + (next ? ' is-next' : '')),
      rule = node('span', 'studio-go-rule');
    if (paused) glass.className += ' is-paused';
    rule.setAttribute('aria-hidden', 'true');
    if (working || next) {
      const halt = button('studio-stop', '', stop, 'stop'),
        // (0.6.466) What it does to the queue, while requests wait.
        words = next && queueLeft() ? 'Arrêter la génération : la file se met en pause' : 'Arrêter la génération';
      halt.setAttribute('aria-label', words);
      halt.title = words;
      glass.append(go, rule, halt);
    } else if (paused) {
      // (0.6.478) Of the conversation shown: the click is not a conversation (clearQueue takes one from the window).
      const clear = button('studio-clear', '', () => clearQueue(), 'close'),
        words = `Vider la file : retirer ${theRequests(waits.length)} en attente`;
      clear.setAttribute('aria-label', words);
      clear.title = words;
      glass.append(go, rule, clear);
    } else {
      // (0.6.254) Its list in the glass, shown above the page (a popover: never cut by the glass).
      const tried = triesButton();
      glass.append(tried.pick, rule, go, tried.menu);
    }
    // Its Éclipse breathes while Moodix AI proposes: from its first setting to the user's answer.
    agent.classList?.toggle('is-thinking', Boolean(!working && (answering() || ai)));
    // (0.6.253) Pressed, it opens the chat, a creation under way or not: the chat can be opened meanwhile (0.6.81),
    // where the take is followed too. So it stays lit (the maquette grey it at 45 %: said in the report).
    group.append(glass, agent);
    // The character Moodix AI made, on the screen: kept, made again, or everything stopped.
    if (checking && mode === 'image' && !working) {
      // The question on a line of its own above its three answers: on one line with them, « OK »
      // was cut at the right of a window of 1280 px.
      group.className += ' is-checking';
      label.textContent = 'OK';
      go.title = `Garder ce personnage : le remplacement se lance (${MODIFIER}+Entrée)`;
      go.disabled = false;
      const again = button('secondary studio-again', 'Autre image', () => checking.resolve('again'), 'dice');
      again.title = 'Faire une autre image du personnage, avec le prompt ci-contre';
      const stop = button('secondary studio-decline', 'Annuler', () => checking.resolve('cancel'));
      stop.title = 'Arrêter le remplacement';
      const question = node('span', 'studio-check-question', 'Ce personnage vous convient ?');
      group.replaceChildren(question, stop, again, go);
    }
    if (answering()) {
      // « Refuser » at the left of the Double verre; its half Agent tinted (moodix.css).
      const no = button('secondary studio-decline', 'Refuser', () => decline());
      no.title = 'Refuser cette proposition de Moodix AI';
      group.replaceChildren(no, ...group.children);
      group.classList.add('is-proposal');
    }
    if (heldGpu) {
      // The only thing to do (54): « Libérer le GPU » in place of Générer, the same glass and size.
      const free = button(
        'studio-go studio-recover',
        '',
        async () => {
          free.disabled = true;
          await recoverGPU();
          freedUntil = Date.now() + 4000;
          render();
          setTimeout(() => render(), 4100);
        },
        'chip',
      );
      free.append(node('span', 'studio-go-label', 'Libérer le GPU'));
      // (0.6.466) Requests paused here: freed, the card lets them go again with « Reprendre », not by itself.
      free.title =
        'La carte graphique est restée prise par la dernière génération : la libérer' +
        (waits.length ? '. La file attendra « Reprendre ».' : '');
      // (0.6.260) In the glass of « Générer » (0.6.253 left it bare: the group lost its own glass then).
      const held = node('div', 'studio-go-glass');
      held.append(free);
      group.replaceChildren(held);
      group.classList.add('is-held');
    }
    bar.append(group);
    preview.append(bar);
    // (0.6.456) The card held, its screen says so (54), but « Échec » alone told nothing of why the take failed: that,
    // as the server says it, under the screen as any failure, without what it added for the card held (UNRELEASED).
    // Free again, the same, as the server says it then (recover).
    // (0.6.466) Then what waits in the queue of this conversation, paused, and why (waitLine).
    const failed = [heldGpu ? heldCause(gpuError()) : heldCause(failure) || failure, waitLine(waits, heldGpu)]
      .filter(Boolean)
      .join(' ');
    if (failed) {
      const alert = node('p', 'studio-error', failed);
      alert.setAttribute('role', 'alert');
      preview.append(alert);
    }

    desk.append(...[write, preview, settings].map(grained), grained(outputs()));
    desk.classList.toggle('is-generating', Boolean(working));
    // (0.6.466) Not by a take of the Studio itself: the next request is written meanwhile.
    if (locked()) for (const control of desk.querySelectorAll('textarea, select, input')) control.disabled = true;
    // What « Enregistrer » compares with, until the model is saved: the settings it showed first.
    baselines[workflow.id] ??= canonical(snapshot(workflow));
    paintSave();
    return desk;
  }
  /**
   * (0.6.260) What had the focus of the keys, to give it back once the Studio is drawn again (render replaces it all,
   * the focus fell on the page): a button of the column of the actions, « × n », the ball of the camera, its switch,
   * « Générer », « Arrêter ». A focus of the keys only (`:focus-visible`): one of the pointer would keep the column
   * unfolded under no pointer. Never a field (its caret would be lost). `refocusTo`: where it goes when that control
   * is no longer drawn (the camera taken away with its ×).
   */
  let refocusTo = null;
  // (0.6.466) « Vider la file » too.
  const REFOCUSED = [
    'studio-tries',
    'camera-block-ball',
    'camera-block-switch',
    'studio-go',
    'studio-stop',
    'studio-clear',
  ];
  function focusKey(element) {
    if (!element?.matches?.(':focus-visible') || ['TEXTAREA', 'INPUT', 'SELECT'].includes(element.tagName)) return null;
    const names = String(element.className ?? '').split(' '),
      action = names.find(name => name.startsWith('output-action-'));
    if (action) return '.studio-rail > .' + action;
    const known = REFOCUSED.find(name => names.includes(name));
    return known ? '.' + known : null;
  }
  /**
   * (0.6.466) A field of the Studio being written in, found again once drawn again: by its id, else by what Moodix AI
   * names it (`data-ai`), with its caret and how far it was scrolled.
   */
  function fieldOf(element) {
    if (!['TEXTAREA', 'INPUT'].includes(element?.tagName)) return null;
    const key = element.id ? '#' + element.id : element.dataset?.ai ? `[data-ai="${element.dataset.ai}"]` : '';
    if (!key) return null;
    let start = null,
      end = null;
    try {
      [start, end] = [element.selectionStart, element.selectionEnd];
    } catch {
      // A field of numbers has no caret to give back.
    }
    return { key, start, end, top: element.scrollTop ?? 0 };
  }
  function writeAgain(desk, { key, start, end, top }) {
    const field = desk.querySelector?.(key);
    if (!field || field.disabled) return;
    field.focus?.({ preventScroll: true });
    try {
      if (start !== null && end !== null) field.setSelectionRange?.(start, end);
    } catch {
      // (Idem.)
    }
    if (top) field.scrollTop = top;
  }
  function render() {
    kinds();
    // (0.6.478) Once drawn, whatever it drew: the window at the bottom right says the queue, under the settings.
    if (!queueTold) {
      queueTold = true;
      queueMicrotask(() => {
        queueTold = false;
        onQueue();
      });
    }
    const body = $('studio-body');
    if (!body) return;
    // The drafts are named after their conversation: at the first drawing, and when a new one gets
    // its identifier (its first take) while they are on the page.
    if (draftsKey === null || (draftsKey.startsWith('new|') && conversation())) draftsKey = draftKey();
    body.dataset.mode = mode;
    triesFollowPage();
    const focused = globalThis.document?.activeElement,
      focusAgain = (body.contains?.(focused) && focusKey(focused)) || null,
      focusElse = refocusTo,
      // (0.6.466) The field being written in (the prompt of the next request while a take of the Studio is made, its
      // seed, a setting): the same one drawn again keeps the focus and the caret. A request of the queue that went or
      // ended took them away, and the next keys went nowhere.
      writing = body.contains?.(focused) ? fieldOf(focused) : null;
    refocusTo = null;
    // The stage leaves with the form it is in, and nothing follows its size any longer: still
    // watched, it was reported once more as it went, with no mode left to read a format from.
    watching?.disconnect();
    watching = null;
    // Held by a work of another conversation than the one shown (0.6.81): said so, nothing of that
    // conversation drawn here (its take in progress is in the miniature).
    if (away()) {
      if (flux) {
        flux.flux.stop();
        flux = null;
      }
      body.replaceChildren(awayPanel());
      return;
    }
    if (!info) {
      if (unreadable) body.replaceChildren(message('Studio indisponible : ' + unreadable));
      else {
        sketched = true;
        body.replaceChildren(skeleton());
      }
      return keepKinds(body);
    }
    // Where the Sortie was scrolled to: drawn again, it stays there (a click on a creation, a
    // change of model), not back at its start.
    const along = document.querySelector?.('#studio-view .studio-strip')?.scrollLeft ?? 0;
    // (0.6.102) The same for the blocks that scroll in themselves, Réglages and Entrée: a LoRA
    // switched, « Plus de réglages » opened, a case filled sent them back to their top.
    const tops = SCROLLED.map(selector => document.querySelector?.(selector)?.scrollTop ?? 0);
    const desk = form();
    if (sketched) desk.classList.add('is-arriving');
    sketched = false;
    body.replaceChildren(desk);
    keepKinds(body);
    // (0.6.260) The focus back on the same control drawn again (focusKey), else where it was said to go.
    const regained = (focusAgain && desk.querySelector?.(focusAgain)) || (focusElse && desk.querySelector?.(focusElse));
    regained?.focus?.({ preventScroll: true });
    if (!regained && writing) writeAgain(desk, writing);
    // What Moodix AI understood and its prompt, measured once on the page: an arrow only where words
    // are cut (0.6.95). The prompt is measured again when its column changes width.
    if (explaining && (answering() || ai)) explaining.measure();
    promptWatch?.disconnect();
    promptWatch = null;
    if (measurePrompt) {
      measurePrompt();
      const box = desk.querySelector?.('#studio-prompt');
      if (box && typeof ResizeObserver === 'function') {
        const measure = measurePrompt;
        promptWatch = new ResizeObserver(() => measure());
        promptWatch.observe(box);
      }
    }
    if (along) {
      const strip = document.querySelector?.('#studio-view .studio-strip');
      if (strip) strip.scrollLeft = along;
    }
    SCROLLED.forEach((selector, at) => {
      const block = tops[at] ? document.querySelector?.(selector) : null;
      if (block) block.scrollTop = tops[at];
    });
    if (working) progress();
    // Nothing made any more: the Flux leaves with its frame.
    else if (flux) {
      flux.flux.stop();
      flux = null;
    }
  }
  /**
   * The Studio held by a work of another conversation (0.6.81), in place of its blocks: what holds it,
   * and the way back (the miniature). It is this conversation's again at the end of that work.
   */
  function awayPanel() {
    const panel = node('div', 'studio-away'),
      sign = mark?.(),
      // (Non-breaking spaces inside the guillemets: a line never begins with « » ».)
      name = `« ${nameOf(heldIn?.conversation) || 'une autre conversation'} »`;
    panel.setAttribute('role', 'status');
    if (sign) {
      sign.classList?.add('studio-away-mark');
      panel.append(sign);
    }
    panel.append(
      node('p', 'studio-away-kicker', 'Studio occupé'),
      node(
        'p',
        'studio-away-text',
        // (0.6.466) Its queue goes on there (D9): said with what still waits.
        (working || chaining) && queueLeft()
          ? `La file de ${name} occupe le Studio jusqu’à sa fin : encore ${requests(queueLeft())} en attente.`
          : working || chaining
          ? `La génération de ${name} occupe le Studio jusqu’à sa fin.`
          : checking
            ? `L’image d’un personnage attend votre avis dans le Studio de ${name}.`
            : `Une proposition de Moodix AI attend votre accord dans le Studio de ${name}.`,
      ),
      node('p', 'studio-away-hint', `La miniature, en bas à droite, vous ramène à ${name}.`),
    );
    return panel;
  }
  async function refresh() {
    if (!info) return;
    const id = conversation(),
      // (0.6.301) Where these takes are read for, said before the request: its answer is dropped when the page
      // is elsewhere by then (the reading of that place is on its way). Two conversations opened one after the
      // other, the first answered last: the Sortie showed the takes of the first project in the second, which
      // could be continued or deleted there, and nothing read them again.
      asked = where();
    seenConversation = id;
    // Without the copies kept for the model (a storyboard per clip): the Studio shows the files.
    // Those of the whole project, the open conversation with them.
    const route = `project-gallery/${encodeURIComponent(project())}?images=0` + (id ? '&conversation=' + id : '');
    const read = await (await api(route)).json();
    if (where() !== asked) return;
    runs = read.runs ?? [];
    nextTake = Number.isInteger(read.nextTake) ? read.nextTake : null;
    runsFor = asked;
    runsStale = false;
    onRuns(id);
    // (0.6.148) The bobine shows the takes of the project too: one made or removed is shown there.
    if (globalThis.document?.body?.dataset?.view === 'bobine') montage.refreshed();
  }
  /**
   * Reads the tools of the Studio (the server checks the files of every workflow: most of a
   * second). Two callers at once (a proposal arriving as the Studio opens) share one request.
   */
  function load() {
    loading ??= api('studio')
      .then(response => response.json())
      .then(value => {
        info = value;
        unreadable = '';
        toolsAt = Date.now();
        toolsStale = false;
        // (0.6.184) A work followed again before they were read: its settings, now (drawn by who asked).
        showLate();
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  /**
   * The Studio comes on screen. Its tools are read the first time, then again in the background
   * when the settings were closed since or a minute went by (the page shows them meanwhile, and
   * is drawn again only if they changed). The creations are read again only for another
   * conversation, or when something was made elsewhere: switching views costs nothing.
   */
  async function open() {
    // Another conversation: what was on the screen belonged to the one before.
    if (seenConversation !== undefined && seenConversation !== conversation()) forget();
    render();
    // A proposal of Moodix AI waits on « Générer » (the page was left meanwhile, 0.6.81): its pointer
    // is there again.
    if (ai?.waiting && !away()) pointer?.move(targetOf('generate'), 'attend votre accord');
    const drawn = shown();
    try {
      if (!info) await load();
      else if (toolsStale || Date.now() - toolsAt > TOOLS_TTL_MS) {
        const before = JSON.stringify(info);
        void load()
          .then(async () => {
            if (JSON.stringify(info) === before || ai) return;
            await afterMove();
            render();
          })
          .catch(() => {});
      }
      if (runsStale || runsFor !== where() || seenConversation !== conversation()) await refresh();
    } catch (error) {
      if (!info) unreadable = error.message;
      notice('Studio indisponible : ' + error.message);
    }
    // A take of the Chat being made, that the Studio could not follow before its tools were read
    // (0.6.96): followed from now (settle waits for its end).
    if (!working) watch();
    const set = settle();
    // Drawn again only if what it shows has changed, once the page has stopped moving.
    await afterMove();
    if (set || shown() !== drawn) render();
  }
  /** Where the creations shown come from: the conversation and its project. */
  const where = () => `${conversation()}|${project()}`;
  /** What the Studio shows of what it reads: its tools and creations, from where. */
  const shown = () => JSON.stringify([info, runs, unreadable]);
  /**
   * Reads ahead, as the page opens (app.js): its tools, most of the wait the first time, and the
   * creations of the conversation. The Studio is then drawn whole the first time it comes on screen.
   * Again once the generation engine is ready: until then no workflow is.
   */
  async function prefetch() {
    try {
      const before = info && JSON.stringify(info),
        // (0.6.192) A work followed again whose request waits for its model to be shown (showLate, 0.6.184).
        waiting = Boolean(working?.asked);
      if (!info || toolsStale) await load();
      if (runsStale || runsFor !== where() || seenConversation !== conversation()) await refresh();
      // (0.6.192) Shown now that its model is read (the engine was not ready at the first reading): drawn.
      // Nothing drew it while the take went on, and the Studio stayed in Image under « En cours ».
      if (settle() || (waiting && working && !working.asked)) render();
      // Read again (the engine is ready): drawn again if what it offers changed.
      if (before && JSON.stringify(info) !== before && !ai && !working) {
        await afterMove();
        render();
      }
    } catch {
      // Said when the Studio opens, which reads them again.
    }
  }
  /**
   * Something changed elsewhere: a creation made from the chat (its creations are read again at
   * the next opening), or the settings (`tools`: its workflows too).
   */
  function invalidate({ tools = false } = {}) {
    runsStale = true;
    if (tools) toolsStale = true;
    // (0.6.346) The Bobine asks again for the models it said missing: one may have been downloaded there.
    if (tools) montage.toolsChanged();
  }
  /** When the user last changed each part of each workflow, as tools read so tell it: { id → { part: time } }. */
  const changesOf = value => {
    const map = new Map();
    for (const list of Object.values(value?.tools ?? {}))
      for (const item of list ?? []) if (item?.changed) map.set(item.id, item.changed);
    return map;
  };
  /**
   * (0.6.102) The parts of workflow `id` just changed in Paramètres (`parts`: a setting by its key,
   * `lora:<id>`, `profiles`) in every draft the Studio keeps (the conversation in hand, those left):
   * each takes the workflow's value now, the rest stays.
   */
  function freshen(id, parts) {
    const sets = [drafts, ...[...leftDrafts.values()].map(left => left.drafts)];
    for (const set of sets)
      for (const item of MODES) {
        const draft = set[item.id],
          models = modelsOf(item.id),
          workflow = models.find(model => model.id === id);
        if (!draft || !workflow) continue;
        for (const part of parts)
          if (part.startsWith('lora:')) delete draft.workflowLoras?.[id]?.[part.slice(5)];
          else delete draft.settings?.[id]?.[part];
        // What the Studio sets for the model in hand: its size, its length, its seed.
        if ((draft.workflow ?? models.find(model => !model.unavailable)?.id) !== id) continue;
        if (workflow.limits && ['width', 'height', 'stage', 'profiles'].some(part => parts.has(part)))
          startSize(workflow, draft);
        if (parts.has('frames')) Object.assign(draft, { length: null, extension: null });
        if (parts.has('seed')) draft.seed = '';
      }
  }
  /**
   * (0.6.102) A workflow was saved in Paramètres › Workflows (or set back, deleted, shown again) and
   * the settings closed: the Studio reads its tools at once, where it waited to come on screen again
   * and kept meanwhile what the workflow no longer has; and what was just changed there (a policy, a
   * value) takes, for that setting only, the place of what the last take gave (« le plus récent des
   * deux »): a setting turned « Fixe » shows its value, a default its new one. The rest stays, and
   * nothing moves when nothing changed. A work holding the Studio (a take made, a proposal of Moodix
   * AI, a character checked) keeps the settings it has: they are its own.
   */
  async function workflowsSaved() {
    const before = info;
    toolsStale = true;
    try {
      await load();
    } catch {
      return;
    }
    if (!before || !info || JSON.stringify(before) === JSON.stringify(info)) return;
    const was = changesOf(before);
    if (!(working || proposal || ai || checking || settling))
      for (const [id, parts] of changesOf(info)) {
        const fresh = Object.keys(parts).filter(part => was.get(id)?.[part] !== parts[part]);
        if (fresh.length) freshen(id, new Set(fresh));
      }
    await afterMove();
    render();
  }
  function forget() {
    // A creation was being looked at: the Studio is first as it was before (leaveLook), not left
    // with the settings of that creation and no way back.
    leaveLook();
    for (const key of Object.keys(kept)) delete kept[key];
    pinned = null;
    extending = null;
    finishing = animated = null;
    failure = '';
  }
  /** What names the conversation of the drafts: its identifier; a new one, by its project. */
  const draftKey = () => conversation() ?? 'new|' + project();
  /**
   * Another conversation is open (or the project of one not begun changed): the Studio shows its
   * creations, and its own prompt and inputs; those of the one left are kept for its return. A new
   * conversation has none: the Studio empty (etats-maquette.md, 55).
   */
  function conversationChanged() {
    // A work held here goes on in its conversation (0.6.81): the Studio stays that one's, said held in
    // the one shown (render), and comes back to it as it was; it goes to the one shown at its end (letGo).
    if (heldIn && holds()) {
      // The pointer resting on « Générer » goes with it; it comes back there with the Studio (open).
      if (away()) pointer?.hide();
      render();
      return;
    }
    heldIn = null;
    // A take of the Chat followed here (watch, 0.6.96) is the conversation left's: the Studio as it
    // was before it, kept as such for its return (where it follows it again, below).
    if (working?.chat) unfollow();
    // A creation was being looked at: the look ends as « Revenir » ends it, before anything is kept
    // of the conversation left. Kept as they were, its drafts were those of the take looked at (its
    // very seed with them, which followed into the conversation opened) and the user's own were lost.
    leaveLook();
    // (0.6.256) The page Agrandir (Interpoler) is the take's of the conversation left, as the picture to
    // animate is: both go with what `forget` forgets, below.
    const next = draftKey();
    // A conversation not begun that gets its identifier while its first take is made: the same one.
    const begun = draftsKey?.startsWith('new|') && conversation() && Boolean(working);
    if (draftsKey !== null && next !== draftsKey && !begun) {
      if (!draftsKey.startsWith('new|')) {
        leftDrafts.set(draftsKey, { mode, drafts: structuredClone(drafts), newest: lastSeen.get(draftsKey) ?? null });
        if (leftDrafts.size > 40) leftDrafts.delete(leftDrafts.keys().next().value);
      }
      // Empty until its takes are read (settle): the prompt and the inputs are a conversation's own.
      for (const item of MODES) Object.assign(drafts[item.id], { prompt: '', before: null, inputs: {} });
      lastSeen.delete(next);
      draftsEpoch++;
    }
    draftsKey = next;
    forget();
    onConversation();
    // Back in a conversation whose take of the Chat is being made: the Studio follows it again (settle
    // waits for its end).
    watch();
    if (info)
      void refresh()
        .then(settle, () => {})
        .then(render);
    else render();
  }
  /** The models a mode offers, whatever is being continued: its own and, for a video, those that follow one. */
  const modelsOf = id => [
    ...(info?.tools?.[modeOf(id).verb] ?? []),
    ...(id === 'video' ? (info?.tools?.replace_character ?? []) : []),
  ];
  /**
   * A reference of the project (an image or a clip of the disk, « #ref1 ») as a creation: what the
   * screen shows and what the actions and a continuation take as their source (`outputSource`).
   * `sheet`: what Moodix wrote in the file, when it made it; `name`, `width`, `height`: what is known
   * of it when the page has not its reference at hand.
   */
  function resourceRecord(resource, kind, { sheet = null, name = '', width, height } = {}) {
    const wide = resource.width ?? width,
      high = resource.height ?? height;
    return {
      id: 'file:' + resource.id,
      external: true,
      resource: resource.id,
      mediaType: kind,
      prompt: String(sheet?.prompt ?? ''),
      // How it is named where a clip continued is named (« Suite de la vidéo : view.mp4 »).
      name: resource.name || name || '',
      workflowId: sheet?.workflowId,
      workflowName: sheet?.workflowName,
      parameters: sheet?.parameters ?? (wide > 0 && high > 0 ? { width: wide, height: high } : {}),
      outputs: [{ originalUrl: resource.originalUrl || resource.previewUrl || '', thumbUrl: resource.previewUrl || '', width: wide, height: high }],
    };
  }
  /** A take of the project as an input of the Studio (its picture, its name, its size). */
  function creationInput(record, index = 0) {
    const output = { ...record.outputs[index], ...measured.get(record.id) };
    return {
      source: { ...outputSource(record), ...(index > 0 ? { index } : {}) },
      preview: output.thumbUrl || output.originalUrl,
      name: record.prompt || KIND[mediaOf(record)] || 'Création',
      width: output.width ?? record.parameters?.width,
      height: output.height ?? record.parameters?.height,
    };
  }
  /**
   * The Studio as it was to make a take (16/11): its model, its prompt, its format and size, its
   * length, its settings, its LoRAs and its inputs, in the draft of its mode. Not its seed, drawn
   * again, unless the user had named it (`seed_given`) or the take is looked at for what made it
   * (`exactSeed`: inspect). An input that is no longer there (a take
   * deleted or gone to another project, a reference erased) leaves its case empty, and a LoRA of
   * the user whose file left its folder is not put back: how many inputs (`lost`) and which LoRAs
   * (`gone`, by their files) are returned, for the Studio to say so.
   */
  function adopt(record, { exactSeed = false } = {}) {
    const target = mediaOf(record),
      draft = drafts[target],
      made = record.parameters ?? {},
      workflow = modelsOf(target).find(item => item.id === record.workflowId) ?? null,
      gone = [];
    // (0.6.211) With the camera it was made with (none: none): its prompt is kept without the sentence added.
    Object.assign(draft, { prompt: String(record.prompt ?? ''), before: null, inputs: {}, extension: null, camera: typeof made.camera === 'string' ? cameraOf(made) : cameraChoice(made.camera) });
    if (!workflow) return { lost: 0, gone };
    // The LoRAs of the user are of one family of models: those of the family left wait for its return.
    const family = modelsOf(target).find(item => item.id === draft.workflow)?.family;
    if (family !== undefined && family !== workflow.family) {
      draft.shelved[family] = draft.styles;
      draft.styles = draft.shelved[workflow.family] ?? [];
    }
    draft.workflow = workflow.id;
    // Its saved settings (« Enregistrer ») do not come over those of the take.
    presetShown[target] = true;
    // (0.6.102) « Le plus récent des deux »: what was changed in Paramètres › Workflows since this
    // take (a policy, a value) is shown as the workflow has it now, the rest as the take had it. Not for
    // a take looked at to see what made it (`exactSeed`: inspect), which shows it all as it was.
    const newer = exactSeed ? () => false : changedSince(workflow, record.createdAt);
    if (workflow.seeded)
      draft.seed =
        !newer('seed') && (exactSeed || made.seed_given === true) && Number.isSafeInteger(made.seed)
          ? String(made.seed)
          : '';
    // A seed « Fixe »: the field is empty for the workflow's own; looked at, the take's when it was another.
    else if (Number.isSafeInteger(workflow.seedFixed))
      draft.seed = exactSeed && Number.isSafeInteger(made.seed) && made.seed !== workflow.seedFixed ? String(made.seed) : '';
    if (workflow.limits && ['width', 'height', 'stage', 'profiles'].some(newer)) startSize(workflow, draft);
    else if (workflow.limits && made.width > 0 && made.height > 0) {
      // Of a ratio no format is close to (1280 × 800 asked in the Chat), the nearest format (0.6.92):
      // left as they were, the format and the size shown were those of the take before.
      const format = nearestFormat(made.width, made.height);
      if (format) Object.assign(draft, { format: format.id, size: sizeKey(made), formatChosen: true });
    }
    const lengths = workflow.lengths?.seconds ?? [],
      // The whole clip; of a continuation, what it added to the clip it started from.
      length = lengthOfRecord(record, Boolean(sourceOf(record)));
    if (lengths.length && newer('frames')) draft.length = null;
    else if (lengths.length && length > 0)
      draft.length = lengths.reduce((best, value) => (Math.abs(value - length) < Math.abs(best - length) ? value : best));
    // The roles of its inputs, as its record names them (those of the family: « img2img »).
    const given = (Array.isArray(made.references) ? made.references : []).map(ref => ref?.role);
    for (const setting of workflow.settings ?? []) {
      // Changed since in Paramètres: its value now (a default, a value « Fixe »).
      if (newer(setting.key)) {
        delete draft.settings[workflow.id]?.[setting.key];
        continue;
      }
      if (made[setting.key] === undefined || made[setting.key] === null) continue;
      // Read only with an input the take did not have (an image made from nothing says a denoise
      // of 1, which is no setting): the Studio keeps the one it has.
      if (!settingRead(setting, given)) continue;
      (draft.settings[workflow.id] ??= {})[setting.key] = fineSetting(setting)
        ? fineValue(setting, made[setting.key])
        : made[setting.key];
      if (setting.key === 'lyrics') draft.lyrics = Boolean(made[setting.key]);
    }
    // The LoRAs of its workflow as it had them: on with their strength, the others off.
    if (Array.isArray(made.loras) && workflow.loras?.length) {
      const chosen = new Map(made.loras.map(item => [item.id, item.strength]));
      for (const item of workflow.loras) {
        // Changed since in Paramètres: as the workflow has it now.
        if (newer('lora:' + item.id)) {
          delete draft.workflowLoras[workflow.id]?.[item.id];
          continue;
        }
        const choice = loraChoice(workflow, item, draft);
        choice.on = chosen.has(item.id) || !item.assistant;
        if (chosen.has(item.id) && Number.isFinite(chosen.get(item.id))) choice.strength = chosen.get(item.id);
        loraChoice(workflow, item, draft);
      }
    }
    // Those of the user, which are still in their folder; the others are named to the user.
    if (workflow.styled && target !== 'audio') {
      const had = (Array.isArray(made.styles) ? made.styles : []).filter(style => style?.name);
      draft.styles = had
        .filter(style => (info.styles ?? []).includes(style.name))
        .slice(0, MAX_STYLES)
        .map(({ name, strength }) => ({ name, strength }));
      gone.push(...had.filter(style => !(info.styles ?? []).includes(style.name)).map(style => leaf(style.name)));
    }
    // Its inputs, each in the case of its role, in their order.
    let lost = 0;
    const counts = {};
    for (const ref of Array.isArray(made.references) ? made.references : []) {
      // The role as the Studio names it: said by the workflow (`inputs`), else read from its name.
      const named = workflow.inputs?.[ref.role] ?? (ref.role in workflow.roles ? ref.role : String(ref.role).replace(/_image$/, '')),
        role = named === 'msr' ? 'reference' : named,
        spec = workflow.roles?.[role],
        index = counts[role] ?? 0;
      // Not a case of this model (the clip a continuation started from): nothing to fill.
      if (!spec?.count || index >= spec.count) continue;
      const taken = ref.output_id ? runs.find(item => item.id === ref.output_id) : null,
        resource = ref.resource_id ? assets.resource?.(ref.resource_id) : null;
      counts[role] = index + 1;
      if (taken && spec.media.includes(mediaOf(taken)))
        (draft.inputs[role] ??= [])[index] = creationInput(taken, ref.output_index > 0 ? ref.output_index : 0);
      else if (resource)
        (draft.inputs[role] ??= [])[index] = {
          source: { resource: resource.id },
          preview: resource.previewUrl || resource.originalUrl,
          name: `${resource.label} · ${resource.name}`,
          width: resource.width,
          height: resource.height,
        };
      else lost++;
    }
    return { lost, gone };
  }
  /**
   * What the Studio says of the LoRAs a take was made with whose files are no longer in their
   * folder (`of`: « cette prise », « la dernière prise »), each once; '' when none is missing.
   */
  function goneLoras(names, of) {
    const files = [...new Set(names)];
    return files.length > 1
      ? `${files.length} LoRA de ${of} ne sont plus dans le dossier loras : ${files.join(', ')}.`
      : files.length
        ? `Un LoRA de ${of} n’est plus dans le dossier loras : ${files[0]}.`
        : '';
  }
  /**
   * The creations of the conversation in hand have just been read: the Studio takes the settings of
   * its last take, mode by mode, and shows the mode of the newest (16/11). Only when that take is
   * new to it: one it made itself, or was set from already, changes nothing, and a conversation left
   * comes back as it was left unless a take was made in it since. A conversation without a take keeps
   * the model and the settings in hand, its prompt and its inputs empty. Nothing while a take is made
   * or Moodix AI proposes: the Studio is theirs.
   * (0.6.192) In a conversation the Studio had settled already, only the modes that have a take new to it:
   * a video made meanwhile (by the Chat, by the Bobine) says nothing of the mode Image. Taken mode by mode,
   * the last image of the conversation came over the prompt being written in Image, and what was typed
   * there was lost.
   */
  function settle() {
    // (0.6.466) Nor between two requests of the queue: the form is the user's, the next request is being written.
    if (!info || runsFor !== where() || working || chaining || proposal || ai || checking) return false;
    // Nor while the prompt of this conversation is being improved: its answer would be written over
    // the settings taken here. (Asked in a conversation left since, it is dropped: nothing to wait for.)
    if (enriching && enrichEpoch === draftsEpoch) return false;
    const key = draftKey(),
      own = ownRuns(),
      newest = own[0]?.id ?? null,
      left = leftDrafts.get(key);
    leftDrafts.delete(key);
    if (!left && lastSeen.has(key) && lastSeen.get(key) === newest) return false;
    // (The take it knew as the newest; none for a conversation never settled here, or one come back to: all
    // its modes then, as when it is opened.)
    const known = !left && lastSeen.has(key) ? lastSeen.get(key) : null;
    lastSeen.set(key, newest);
    if (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value);
    if (left && left.newest === newest) {
      for (const item of MODES) Object.assign(drafts[item.id], left.drafts[item.id]);
      mode = left.mode;
      return true;
    }
    if (!newest) return false;
    let lost = 0;
    const gone = [],
      // The modes of the takes made since the one it knew (`own` is newest first).
      since = known ? own.findIndex(record => record.id === known) : -1,
      fresh = since > 0 ? new Set(own.slice(0, since).map(mediaOf)) : null;
    for (const item of MODES) {
      if (fresh && !fresh.has(item.id)) continue;
      // The last take of the mode that one of its models made (not an enlargement, which has no settings).
      const models = new Set(modelsOf(item.id).map(model => model.id)),
        last = own.find(record => mediaOf(record) === item.id && models.has(record.workflowId));
      if (!last) continue;
      const missing = adopt(last);
      lost += missing.lost;
      gone.push(...missing.gone);
    }
    // The screen shows that newest take: its mode (when a model makes that kind here), and no longer
    // a take the Studio kept on it; one opened from the chat (« Afficher dans le Studio ») stays.
    for (const kind of Object.keys(kept)) if (kept[kind].id !== pinned) delete kept[kind];
    if (!pinned && modelsOf(mediaOf(own[0])).length) mode = mediaOf(own[0]);
    extending = null;
    // (0.6.261) The page Agrandir (Interpoler) of a take no longer on its screen: left, as Prolonger is. It still said
    // « À agrandir · PRISE 1 » and made it larger with the take of the Chat shown, « PRISE 2 ».
    if (finishing && kept[mediaOf(finishing.record)]?.id !== finishing.record.id) finishing = null;
    // What could not be put back as the take had it, said: the settings shown are not all its own.
    failure = [
      lost > 1
        ? `${lost} images utilisées pour la dernière prise n’existent plus : leurs cases sont restées vides.`
        : lost
          ? 'Une image utilisée pour la dernière prise n’existe plus : sa case est restée vide.'
          : '',
      goneLoras(gone, 'la dernière prise'),
    ]
      .filter(Boolean)
      .join(' ');
    return true;
  }
  /** The Studio has just made a take itself: its settings are already those of the newest take. */
  function settledHere() {
    if (runsFor === where()) lastSeen.set(draftKey(), ownRuns()[0]?.id ?? null);
  }
  /** Nothing is looked at any more: no way back, the address of a file of the disk given back. */
  function endLook() {
    looked = null;
    if (!lookedUrl) return;
    // The file shown from that address leaves the screen with it: given back while a mode still
    // showed it (a sound looked at, then a take made in Image), it left there a player that could
    // no longer read anything.
    for (const key of Object.keys(kept))
      if (kept[key].outputs?.[0]?.originalUrl === lookedUrl) {
        if (pinned === kept[key].id) pinned = null;
        delete kept[key];
      }
    globalThis.URL?.revokeObjectURL?.(lookedUrl);
    lookedUrl = '';
  }
  /**
   * The Studio as it was before the look: its drafts, its screen, its mode, « Plus de réglages »;
   * the look is over. Nothing is drawn. What the take looked at added to a draft and was not there
   * before (the format said chosen) leaves with it.
   */
  function leaveLook() {
    if (!looked) return;
    const before = looked;
    endLook();
    putBack(before);
  }
  /**
   * The Studio as `before` kept it (a look, a take of the Chat followed, 0.6.96): its drafts, its
   * screen, its mode, « Plus de réglages ». What was added to a draft since and was not there leaves.
   */
  function putBack(before) {
    for (const item of MODES) {
      const draft = drafts[item.id];
      for (const key of Object.keys(draft)) if (!(key in before.drafts[item.id])) delete draft[key];
      Object.assign(draft, before.drafts[item.id]);
    }
    for (const key of Object.keys(kept)) delete kept[key];
    Object.assign(kept, before.kept);
    // (0.6.321) With the clip in hand, whether its camera was being changed: « Prolonger » of it while another take
    // was looked at, then « Revenir », and « Changer la caméra » came back as « Générer la suite ».
    ({ mode, advanced, pinned, extending, refilmId } = before);
  }
  /**
   * A creation put on the screen to see what made it (16/11): dropped there from the Sortie or from
   * the computer, or « Afficher dans le Studio » on a take of the chat. Its kind opens (Image, Vidéo,
   * Son), it is on the screen with its actions (Agrandir, Prolonger…), and the Studio takes all that
   * made it: model, prompt, format, settings, LoRAs, inputs and its very seed, « Plus de réglages »
   * open. What made a file from elsewhere is not known: the settings stay as they are. The Studio as
   * it was before is kept: « Revenir », at the right of « Image · Vidéo · Son », gives it back.
   */
  /** Why a creation of this kind cannot be put on the screen now, or '' when it can. */
  function cannotLook(kind) {
    if (working) return 'Une création est en cours : attendez sa fin pour en regarder une autre.';
    if (proposal || ai) return 'Moodix AI est en train de proposer';
    // Nor while a character waits for its check (0.6.88): looked at, the image to check left the screen.
    if (checking) return 'Un personnage attend votre réponse dans le Studio : « OK », « Autre image » ou « Annuler ».';
    // A kind no model makes here has no screen: the Studio would only say so.
    if (info && !modelsOf(kind).length)
      return `Aucun modèle ${kind === 'audio' ? 'de son' : kind === 'video' ? 'de vidéo' : 'd’image'} n’est prêt : ce média ne peut pas être montré dans le Studio.`;
    return '';
  }
  function inspect(record) {
    const refused = cannotLook(mediaOf(record));
    if (refused) return notice(refused);
    looked ??= { mode, drafts: structuredClone(drafts), advanced, kept: { ...kept }, pinned, extending, refilmId };
    const target = mediaOf(record);
    mode = target;
    kept[target] = record;
    pinned = record.id;
    extending = null;
    finishing = animated = null;
    formatsOpen = false;
    failure = '';
    if (info && modelsOf(target).some(item => item.id === record.workflowId)) {
      // (0.6.206, point 5 of LOTS.md) « Plus de réglages » is not opened for it any more: a window now, it
      // would hide the take looked at. Its settings are on its page, and a press on the pill away.
      const { lost, gone } = adopt(record, { exactSeed: true });
      failure = [
        lost > 1
          ? `${lost} images utilisées pour cette prise n’existent plus : leurs cases sont restées vides.`
          : lost
            ? 'Une image utilisée pour cette prise n’existe plus : sa case est restée vide.'
            : '',
        goneLoras(gone, 'cette prise'),
      ]
        .filter(Boolean)
        .join(' ');
    } else if (record.external && record.workflowName)
      // Made by Moodix, with a model this installation does not have.
      failure = `Créé avec ${record.workflowName}, qui n’est pas disponible ici : vos réglages sont restés tels quels.`;
    render();
  }
  /** « Revenir »: the creation looked at leaves the screen, the Studio is as it was before. */
  function lookBack() {
    // Held while a proposal of Moodix AI waits, as a look is (cannotLook): the drafts of before,
    // put back under it, went with « Générer » as changes of the user.
    if (!looked || working || proposal || checking || ai) return;
    leaveLook();
    formatsOpen = false;
    failure = '';
    render();
  }
  /**
   * A file of the computer dropped on the screen. One Moodix made says so itself (the sheet it
   * carries: public/media-info.mjs), whatever its name: a take of this project is that take; another
   * is shown with what made it. An image or a clip is kept as a reference of the project, so that it
   * can be enlarged, continued, animated; a sound is played from the file.
   */
  async function inspectFile(file) {
    const type = String(file?.type || ''),
      kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : null;
    if (!kind) return notice('Ce fichier n’est ni une image, ni une vidéo, ni un son.');
    const refused = cannotLook(kind);
    if (refused) return notice(refused);
    // (0.6.325) Read, then copied, for the conversation it was dropped in, as fill() checks it: c2 opened meanwhile
    // (a clip takes a moment to copy), the file dropped in c1 was shown on the screen of c2, with « Revenir ».
    const epoch = draftsEpoch,
      moved = () => epoch !== draftsEpoch;
    const sheet = await fileInfo(file).catch(() => null),
      known = sheet?.id ? runs.find(item => item.id === sheet.id) : null;
    if (moved()) return notice('Fichier non montré : la conversation a changé entre-temps.');
    if (known) return inspect(known);
    let resource = null;
    if (kind !== 'audio') [resource = null] = await assets.importFiles([file], { project: project() }).catch(() => []);
    if (working || proposal || ai) return;
    if (moved())
      return notice(
        (resource ? 'Fichier gardé dans les références du projet, mais pas montré' : 'Fichier non montré') +
          ' : la conversation a changé entre-temps.',
      );
    const address = resource ? resource.originalUrl || resource.previewUrl : (globalThis.URL?.createObjectURL?.(file) ?? '');
    if (!address) return notice('Ce fichier n’a pas pu être lu.');
    inspect(
      resource
        ? resourceRecord(resource, kind, { sheet })
        : {
            id: `file:${file.name}:${file.size}:${file.lastModified ?? 0}`,
            external: true,
            mediaType: kind,
            prompt: String(sheet?.prompt ?? ''),
            workflowId: sheet?.workflowId,
            workflowName: sheet?.workflowName,
            parameters: sheet?.parameters ?? {},
            outputs: [{ originalUrl: address, thumbUrl: '' }],
          },
    );
    if (!resource) {
      // Another file of the disk was on the screen: it left it for this one, its address is given back.
      if (lookedUrl && lookedUrl !== address) globalThis.URL?.revokeObjectURL?.(lookedUrl);
      lookedUrl = address;
    }
  }
  /** « Afficher dans le Studio » on a take of the chat: on the screen, with what made it (inspect). */
  function show(record) {
    inspect(record);
  }

  // Ctrl + Entrée (⌘ on a Mac) generates from anywhere in the Studio, not only from the prompt.
  // (0.6.466) A take of the Studio being made: its keys too (« Générer ensuite », the wand said paused).
  const shortcut = event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || locked() || enriching || aiWorking) return;
    // Held by a work of another conversation (« Studio occupé », 0.6.87): nothing of that one is on
    // screen, its keys answer nothing (Ctrl + Entrée started the video waiting there, or said « OK »).
    if (away()) return;
    // The message box of the chat has its own keys: these are the Studio's.
    if (event.target?.id === 'prompt') return;
    if (event.key === 'Enter') {
      event.preventDefault();
      // (0.6.253) « Générer » greyed: its keys say why and light what lacks, as a press on it does.
      void pressGo();
    } else if (String(event.key).toLowerCase() === 'e' && !event.shiftKey && mode !== 'audio' && info?.enabled) {
      // « Enrichir le prompt » (moodix-design.md 17): Ctrl+E, ⌘+E on a Mac.
      event.preventDefault();
      void enrich();
    }
  };
  const view = $('studio-view');
  if (view) {
    view.onkeydown = shortcut;
    // While Moodix AI sets the Studio it is locked (inert, lockStudio): nothing of the user reaches it,
    // nothing stops the pointer (16/11). Resting on « Générer », a touch of the user sends the pointer
    // away; the proposal stays, theirs to change.
    const touched = event => {
      if (aiWorking) return;
      if (event.isTrusted !== false && ai) takeOver();
      else if (event.type === 'input' && !proposal) release();
    };
    view.addEventListener?.('input', touched, true);
    view.addEventListener?.('pointerdown', event => !aiWorking && event.isTrusted !== false && ai && takeOver(), true);
    // Pointer and rings follow their setting when the page scrolls under them.
    view.addEventListener?.('scroll', () => ai?.active && pointer?.follow(targetOf(ai.active)), { passive: true });
  }
  // With the focus on no field (after a click beside them) the key goes to the page itself: it
  // is taken there too, while the Studio is the view on screen and no window is open over it.
  document.addEventListener?.('keydown', event => {
    if (event.target !== document.body || $('studio-view')?.offsetParent == null) return;
    if (!document.querySelector('dialog[open]')) shortcut(event);
  });
  // A click outside « ··· » closes it; (0.6.194, audit of 21/11, B14) Échap too, as every other menu of
  // the page, the focus back on « ··· » (a window open over the page keeps Échap for itself).
  function closeFormats({ refocus = false } = {}) {
    formatsOpen = false;
    const menu = document.querySelector?.('#studio-view .studio-format-menu'),
      more = document.querySelector?.('#studio-view .studio-format.is-more');
    if (menu) closePopup(menu);
    more?.setAttribute?.('aria-expanded', 'false');
    if (refocus) more?.focus?.();
  }
  document.addEventListener?.('pointerdown', event => {
    if (!formatsOpen || event.target?.closest?.('.studio-formats-wrap')) return;
    closeFormats();
  });
  document.addEventListener?.(
    'keydown',
    event => {
      if (event.key !== 'Escape' || !formatsOpen || document.querySelector?.('dialog[open]')) return;
      // (Taken: the chat opened over the Studio folds at Échap when nothing else has it, app.js.)
      event.preventDefault();
      closeFormats({ refocus: true });
    },
    true,
  );
  /**
   * (0.6.206) The window of « Plus de réglages », shown against the column of the Réglages, at its left, their
   * tops level, never over « Générer »: as tall as what is above it at most, its lines scrolling in it beyond.
   */
  function showMore(pane, more) {
    const column = document.querySelector?.('#studio-view .studio-block.is-settings'),
      top = column?.getBoundingClientRect?.().top,
      limit = document.querySelector?.('#studio-view .studio-go-group')?.getBoundingClientRect?.().top;
    if (Number.isFinite(top) && Number.isFinite(limit) && limit - top > 172) pane.style.maxHeight = Math.round(limit - top - 12) + 'px';
    openPopup(pane, more, { beside: column });
    // Opened by its pill, the focus goes into it (its first field): the pill drawn again had lost it.
    if (moreFocus) pane.querySelector?.('input, select, textarea, button')?.focus?.();
    moreFocus = false;
  }
  // It closes at a press outside the Réglages (their own controls leave it open: a format changed, it stays,
  // as its lines did under the pill), at Échap (the focus back on its pill), without drawing the Studio again.
  function closeMore({ refocus = false } = {}) {
    advanced = false;
    const more = document.querySelector?.('#studio-view .studio-more-pill'),
      pane = document.querySelector?.('#studio-view .studio-more-window');
    if (pane) closePopup(pane);
    more?.classList?.remove?.('is-open');
    more?.setAttribute?.('aria-expanded', 'false');
    if (refocus) more?.focus?.();
  }
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (advanced && !event.target?.closest?.('.studio-block.is-settings')) closeMore();
    },
    true,
  );
  document.addEventListener?.(
    'keydown',
    event => {
      // (One Échap closes one thing: « ··· » of the formats, open too, has taken it; a list open in the
      // window takes it first.)
      if (event.key !== 'Escape' || event.defaultPrevented || !advanced || document.querySelector?.('dialog[open]')) return;
      if (event.target?.closest?.('[role="listbox"]')) return;
      event.preventDefault();
      closeMore({ refocus: true });
    },
    true,
  );
  // (0.6.204) The window of a piece closes the same way: a press beside it and its piece, Échap (the focus back on
  // its case) before anything else hears it. Without drawing the Studio again: a press on another control is
  // also its click, which a control replaced meanwhile would lose.
  function closeWindow({ refocus = false } = {}) {
    pieceOpen = null;
    const piece = document.querySelector?.('#studio-view .studio-piece.is-open'),
      pick = piece?.querySelector?.('.studio-slot-pick'),
      pane = piece?.querySelector?.('.studio-piece-window');
    if (pane) closePopup(pane);
    piece?.classList?.remove?.('is-open');
    pick?.setAttribute?.('aria-expanded', 'false');
    if (refocus) pick?.focus?.();
  }
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (pieceOpen && !event.target?.closest?.('.studio-piece.is-open')) closeWindow();
    },
    true,
  );
  document.addEventListener?.(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !pieceOpen || document.querySelector?.('dialog[open]')) return;
      event.preventDefault();
      closeWindow({ refocus: true });
    },
    true,
  );
  // (0.6.257) The menu of the block « Caméra » the same way: a press beside its block, Échap.
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (cameraMenu && !event.target?.closest?.('.studio-camera-block')) closeCameraMenu();
    },
    true,
  );
  document.addEventListener?.(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !cameraMenu || document.querySelector?.('dialog[open]')) return;
      event.preventDefault();
      closeCameraMenu({ refocus: true });
    },
    true,
  );
  // (0.6.203) The list of « Ajouter » closes as « ··· » does: a press beside it, Échap (the focus back on its case).
  function closeAdd({ refocus = false } = {}) {
    addOpen = false;
    const piece = document.querySelector?.('#studio-view .studio-add'),
      pick = piece?.querySelector?.('.studio-add-pick'),
      menu = piece?.querySelector?.('.studio-add-menu');
    if (menu) closePopup(menu);
    piece?.classList?.remove?.('is-open');
    pick?.setAttribute?.('aria-expanded', 'false');
    if (refocus) pick?.focus?.();
  }
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (addOpen && !event.target?.closest?.('.studio-add')) closeAdd();
    },
    true,
  );
  document.addEventListener?.(
    'keydown',
    event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !addOpen || document.querySelector?.('dialog[open]')) return;
      event.preventDefault();
      closeAdd({ refocus: true });
    },
    true,
  );
  // (0.6.194, audit of 21/11, A6) A press beside the menu of a creation closes it, as « ··· » and the
  // lists: its focus may be gone (drawn again meanwhile) or elsewhere, and nothing else heard the press.
  document.addEventListener?.(
    'pointerdown',
    event => {
      if (menuFor && !event.target?.closest?.('.studio-item-menu')) dropMenu();
    },
    true,
  );
  // The modes of the Studio are there from the start.
  kinds();
  return {
    open,
    prefetch,
    render,
    busy: () => Boolean(working) || enriching,
    propose,
    decline,
    followAgain,
    busyChanged,
    follow,
    settled,
    watch,
    show,
    // (0.6.240) « Changer la caméra » of a take, asked from the Chat or the Archives.
    refilm: record => actionsOf(record).find(action => action.id === 'refilm')?.run(),
    // (0.6.256) The page Agrandir or Interpoler of a take, asked from the Chat or the Archives.
    finish: (record, verb) => finishTake(record, verb),
    // (0.6.260) Why that page cannot open now ('' when it can): asked there before the Chat is left.
    // (0.6.466) Nor between two requests of its queue.
    finishBlocked: () =>
      working || chaining ? whyNot() || BUSY_HERE : proposal ? 'Moodix AI est en train de proposer' : '',
    conversationChanged,
    invalidate,
    workflowsSaved,
    checkCharacter,
    /**
     * The size of the image of a character for a video of `size` (its format, about as many
     * points as the image workflow makes by itself), or null when that workflow sets its own.
     */
    imageSize: size => {
      const workflow = offered('create_image').find(item => !item.unavailable);
      const format = size?.width > 0 && size?.height > 0 ? formatOf(size.width, size.height) : null;
      if (!workflow?.direct || !workflow.limits || !format) return null;
      const pixels = (workflow.size?.width ?? 1024) * (workflow.size?.height ?? 1024);
      const { nearest } = sizeChoices(workflow, format.id, pixels);
      return nearest ? { width: nearest.width, height: nearest.height } : null;
    },
    /**
     * The LoRAs of the user the Studio has for conversation `id` in mode `target` (0.6.88): those it
     * shows when its settings are that conversation's, else those it kept when it left it; null when
     * it has none for it. A creation made at once while that Studio is not on screen takes them.
     */
    stylesFor: (id, target = 'image') => {
      const own = id && id === draftsKey ? drafts : leftDrafts.get(id)?.drafts,
        styles = own?.[target]?.styles;
      return Array.isArray(styles) ? styles.filter(style => style?.name).map(({ name, strength }) => ({ name, strength })) : null;
    },
    /** Whether a proposal of Moodix AI waits for « Générer », or a character for its check. */
    proposing: () => Boolean(proposal || checking),
    /**
     * Whether the Studio holds a work (0.6.81): a take being made, a proposal of Moodix AI waiting,
     * a character checked; it stays that conversation's while the page shows another.
     */
    holds,
    /** The conversation whose work the Studio holds, or null. */
    heldFor: () => (heldIn && holds() ? heldIn.conversation : null),
    /** (0.6.160) The project of that work, or null: the Studio and the Bobine are that project's meanwhile. */
    heldProject: () => (heldIn && holds() ? heldIn.project : null),
    /** The few seconds the pointer of Moodix AI sets the Studio (it is locked, the page holds its places). */
    settingUp: () => aiWorking,
    /** A work held here may be over (the page asks again): left meanwhile, the Studio follows the page. */
    letGo,
    // (0.6.466) The queue of the Studio (studio-queue.mjs), for the page: the Chat waits for its end, never queued.
    /** How many requests wait for their turn (not those paused): « 46 % · 3 en attente » in the Chat. */
    queued: () => queueLeft(),
    /**
     * Whether the queue holds the page: requests wait for their turn, or the next one is about to go (between two of
     * them no take is made for a second, and a message would take the card from it). Paused, it holds nothing.
     */
    queueHolds: () => chaining || queueLeft() > 0,
    /** Why a message of the Chat waits for the queue, in the user's words; '' when no request waits. */
    queueReason: () => {
      const left = queueLeft();
      if (!left) return '';
      return `Le chat attend la fin de la file du Studio : ${requests(left)} en attente. Arrêter la met en pause.`;
    },
    /** What closing the tab would lose: the requests that wait (paused too), the tries of a series not begun. */
    queueWaits: () => {
      const running = queue.running();
      return queue.waits() + (running && running.at < running.tries ? running.tries - running.at : 0);
    },
    /** A conversation deleted (`id`; null, all of them): what it had to make goes with it. */
    forgetQueue: id => {
      if (id) queue.forget(id);
      else for (const entry of queue.entries()) queue.remove(entry.id);
      render();
    },
    /** ■ of the Chat between two requests (no take on the server to stop): the next one does not go, all pause. */
    stopQueue: () => stop(),
    /** (0.6.470) The page goes away, or is shown again as it was left: the queue kept in the tab stays as it was. */
    leaving: on => queue.leaving(on),
    // (0.6.478, variante A) The queue in the window at the bottom right (work-miniature.mjs, app.js syncMiniature):
    // what it says, where it lies in the Studio, and its gestures, from any page.
    queueView,
    queueDock,
    queueRemove: id => {
      if (queue.remove(id)) render();
    },
    queueResume: id => resumeQueue(id),
    queueClear: id => clearQueue(id),
    queueTakeBack: id => {
      const entry = queue.get(id);
      if (entry?.state === 'failed') takeBack(entry);
    },
    /**
     * The take on the screen (« PRISE n » at its top left), for what Moodix AI is told of it:
     * { take, media }, or null when the screen shows none (nothing made, a file of the disk, a
     * creation being made).
     */
    screenTake: () => {
      const record = onStage(),
        take = record?.outputs?.[0]?.take;
      return Number.isInteger(take) ? { take, media: mediaOf(record) } : null;
    },
    /** The verbs the Studio answers for Moodix AI. */
    accepts: name => name in MODE_OF_VERB,
    /**
     * (0.6.147) A take of any conversation leaves it, as from the Sortie (the Pellicule asks it): the
     * Studio forgets it too, its Sortie and its montage read again. Whether it went.
     */
    remove,
    /** (0.6.148) The Bobine, a page of its own (public/montage.mjs): its takes are made by the Studio. */
    bobine: () => montage,
    /** (0.6.148) A take of the bobine is being made: the bobine shows it, no miniature is needed. */
    // (0.6.192) Or follows one again after a reload (`place`, 0.6.181): the Bobine says it on its take, and
    // the miniature came over the timeline to say it a second time.
    bobineWorking: () => Boolean(working?.montage || working?.place),
  };
}
