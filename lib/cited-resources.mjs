/**
 * An image the user names by its label ("ref6", "Ref 6", "la référence 6") must reach the
 * generator. A model that only describes it in the prompt is told so once, with the argument
 * to pass; its next call stands, whatever it decides. A proposal that still leaves it out says
 * so to the user (citedNote): what they named is not shown to the generator, and why when the
 * workflow could not take it (the continuation of a video by LTX 2.5 takes no image).
 */
import { imageRoles } from './tool-catalog.mjs';
import { CAPABLE, RAILS } from './model-wording.mjs';

/** What follows a number that is a length, as a pattern: its unit (« 8 s », « 10 secondes », « 2 min »). */
export const UNIT = String.raw`\s*(?:s|sec|secs|secondes?|seconds?|min|mn|minutes?)\b`;
/**
 * (0.6.305) The numbers that follow a first one named, as a pattern: « refs 1 et 2 », « références 1, 2 et 3 »,
 * « prises 3, 4 et 5 ». Only the first was read: « anime les refs 1 et 2 » named the reference 1 alone, the
 * second was neither asked of the model nor kept from the tidying of the references. A list ends with « et »:
 * a number after a comma alone is not one of them (« anime #ref1, 8 » asks for eight seconds), nor is one
 * followed by its unit or that begins a format or a size (« la ref 1 et 8 s », « ref 2 et 16:9 »).
 */
export const listed = digits => {
  const number = String.raw`(?:n°|#)?\s*\d{1,${digits}}\b(?!${UNIT}|\s*[:/×*]\s*\d|\s*x\s*\d|\.\d)`;
  return String.raw`(?:(?:\s*,\s*${number})*\s*(?:,\s*)?(?:et|and|&)\s*${number})*`;
};
const LABEL = new RegExp(String.raw`\br[ée]f(?:[ée]rence)?s?\s*(?:n°|#)?\s*(\d{1,4})\b(${listed(4)})`, 'gi');
// (0.6.460) « ce qu’il cite n’est pas transmis ». The telling of before, « transmise », is still in the
// conversations written then: read as a telling too, so that it is not said a second time there.
const MARK = 'n’est pas transmis à l’outil',
  MARKS = [MARK, 'n’est pas transmise à l’outil'];
const GENERATORS = new Set(['create_image', 'create_video', 'replace_character']);
// (0.6.460) The verbs whose telling says how to keep the image out: a video (citedMessage).
const VIDEOS = new Set(['create_video', 'extend_video', 'replace_character']);
// The roles of a verb, as the model is told of them.
const ROLE_WORDS = {
  source: 'image à modifier',
  start_image: 'image de départ',
  end_image: 'image de fin',
  reference: 'référence',
};

const textOf = message =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
      : '';

// What the user wrote, not what the page adds in their name for the model (`internal`: an image
// shown to it carries the label of its reference, and was taken for the user's last message: only
// that label was looked for, and « said once » was forgotten after each image shown).
const written = message => message?.role === 'user' && !message.internal;

/** The numbers of the references the last user message names (« #ref3 », « ref 3 »). */
export function citedNumbers(messages) {
  if (!Array.isArray(messages)) return [];
  const last = messages.findLast(written);
  const named = match => [match[1], ...(match[2].match(/\d+/g) ?? [])].map(Number);
  return [...new Set([...textOf(last).matchAll(LABEL)].flatMap(named))];
}

/** The active image resources the last user message names. */
export function citedImages(messages, catalog) {
  const numbers = new Set(citedNumbers(messages));
  return numbers.size ? catalog.filter(item => item.type === 'image' && numbers.has(item.reference)) : [];
}

/** Whether the model was told already, for the user's last request, that an image it names is left out. */
export function citedSaid(messages) {
  if (!Array.isArray(messages)) return false;
  const last = messages.findLastIndex(written);
  const told = message => message?.role === 'tool' && MARKS.some(mark => textOf(message).includes(mark));
  return last >= 0 && messages.slice(last + 1).some(told);
}

/**
 * (0.6.460) Whether a call that leaves out an image the user names is sent back for it (`wording`: the one of
 * the model that answers, lib/model-wording.mjs). Not an image asked of a capable model: since 0.5.106 each
 * image joined to a message has its « #ref » written in it, and a large model sees what it is shown; for an
 * image, giving it to the generator is a choice that « #ref9 » does not make (Krea 2 copies it, Qwen-Image-Edit
 * retouches it). Sent back for five photos shown as examples, ChatGPT made ten images of one of them (27/11,
 * « Photo spatiale années 70 »). A video still is: the telling was born of one (0.4.15), its second image only
 * described. Either way the proposal says to the user what is left out (citedNote), its picture greyed.
 */
export const citedAsked = (name, wording = RAILS) => !(wording === CAPABLE && name === 'create_image');

/**
 * (0.6.460) Whether the arguments pass an image by its position among those attached ({"image": 0}): it may well
 * be the one named, as a proposal knows (lib/tool-runtime.mjs, #cite). « Anime-la », a photo joined, was sent back
 * for the image it had passed.
 */
function byPosition(passed) {
  let args;
  try {
    args = JSON.parse(passed);
  } catch {
    return false;
  }
  return Object.values(args && typeof args === 'object' ? args : {}).some(value =>
    [value].flat().some(source => source !== null && typeof source === 'object' && source.image !== undefined),
  );
}

/**
 * Active image resources the last user message names and this generation call leaves out. `wording`: the one
 * of the model that made the call (citedAsked).
 */
export function citedUnused(messages, catalog, call, { wording = RAILS } = {}) {
  if (!Array.isArray(messages) || !GENERATORS.has(call?.function?.name)) return [];
  if (!citedAsked(call.function.name, wording)) return [];
  // Said once already for this request.
  if (citedSaid(messages)) return [];
  const passed = String(call.function.arguments ?? '');
  // A draft promoted takes the inputs of the draft and no other: nothing to pass in that call (told
  // to pass the image, the model made a call the promotion could only refuse; the proposal says why
  // the image is left out, lib/tool-runtime.mjs).
  if (/"reuse_output"\s*:/.test(passed)) return [];
  if (byPosition(passed)) return [];
  return citedImages(messages, catalog).filter(item => !passed.includes(item.id));
}

const oneOf = words => (words.length > 1 ? words.slice(0, -1).join(', ') + ' ou ' + words.at(-1) : words[0]);

/**
 * What the model is told: which image is missing, and how to pass it. `roles`: those its workflow
 * has a place left in, when they are known (a proposal already resolved), each with its argument.
 * `verb`: the tool called. (0.6.460) Its own roles when its workflow is not known yet: « image de fin,
 * référence ou image de départ » was told for an image too, which has neither. And for a video, the way
 * out, in the telling itself (a capable model never reads the `note` of a result): told to pass an image
 * the user did not want (« sans la ref 1 »), the model had no other words to go by.
 */
export function citedMessage(unused, roles = null, { byNumber = false, verb = '' } = {}) {
  // (A capable model names a reference by its number: lib/model-wording.mjs.)
  const list = unused
      .map(item => `${item.label} (${byNumber ? `{"ref": ${item.reference}}` : `{"resource": "${item.id}"}`})`)
      .join(', '),
    named = roles?.length ? roles : verb ? imageRoles(verb) : [],
    where = named.length ? ` (${oneOf(named.map(role => `${ROLE_WORDS[role] ?? role} : ${role}`))})` : '',
    out = VIDEOS.has(verb)
      ? ` Si l’utilisateur ne veut pas de ${unused.length > 1 ? 'ces images' : 'cette image'} dans la vidéo, ` +
        'refais le même appel.'
      : '';
  // The same words whatever the count: they are also how a second telling is avoided.
  return (
    `L’utilisateur cite ${list} : ce qu’il cite ${MARK}. Décrire une image dans le prompt ne la montre pas ` +
    `au générateur. Refais l’appel en la passant dans le rôle qui convient à sa demande${where}.${out}`
  );
}

/**
 * What the user reads on a proposal that leaves out an image they named (`left`): the generator
 * will not see it, and why when its workflow could not take it. `here`, `none` and `other` as
 * ToolCatalog.room gives them; `continues`: the proposal continues a video.
 */
export function citedNote(left, { workflow = '', here = [], none = false, other = null, continues = false } = {}) {
  const many = left.length > 1,
    labels = left.map(item => item.label),
    list = many ? labels.slice(0, -1).join(', ') + ' et ' + labels.at(-1) : labels[0],
    it = many ? 'les' : 'la';
  const why = here.length
    ? ''
    : none
      ? ` : ${workflow} ne prend pas d’image${continues ? ' pour la suite d’une vidéo' : ''}`
      : ` : ${workflow} n’a pas de place pour ${many ? 'elles' : 'elle'} avec les autres entrées`;
  return (
    `${list} ${many ? 'ne sont pas transmises' : 'n’est pas transmise'}${why}. ` +
    `Le générateur ne ${it} verra pas, seul le prompt peut ${it} décrire.` +
    (!here.length && other ? ` ${other} peut ${it} recevoir.` : '')
  );
}
