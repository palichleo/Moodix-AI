/**
 * The camera of a video (0.6.211; LOTS.md, lot 14; captures 95 and 107): a closed list of movements, a speed,
 * and the fixed English sentence the application writes at the end of the prompt for each choice. Nothing of
 * the engine changes: the models read it as they read any prompt (study of 21/11, « caméra et technologies »,
 * § 2.4.1 and 4.1). No measure says yet how well each model follows each movement: a simple one alone is
 * usually followed, an orbit less so.
 *
 * One table for the page and the server (lib/tool-runtime.mjs imports it): the Studio shows the sentence that
 * will be added, the server adds that very one, the page of a take names the choice.
 */

// The models that take it, by family (runner/families), and the verb: a new video. (A continuation, a character
// put in a video and the Bobine come with lot 15.)
export const CAMERA_FAMILIES = ['ltx25', 'wan22'];
export const CAMERA_VERBS = ['create_video'];
/** Whether a model of that family takes the camera for that verb. */
export const takesCamera = (family, verb) => CAMERA_FAMILIES.includes(family) && CAMERA_VERBS.includes(verb);

// Each movement: its name on screen, its English words after « The camera [slowly] », or a sentence of its own
// (`whole`) for what has no speed: a fixed shot, a camera held in the hand, one that follows its subject.
// `she`: its French name is feminine (« Grue montante, lente »).
// (0.6.212) `off`: what the words alone do not hold, said by the user on the real videos of 22/11 (LTX 2.5,
// from an image, « Normale »): for « Orbite gauche » the camera stayed still while the subject turned round, for
// « Grue montante » it ended looking down on him. Those movements and their mirrors stay in the list, greyed,
// with why (cameraOff): no take is made with them until a model made for the camera takes them. A take made
// with one before keeps its name and its sentence (cameraMade).
const ORBIT_FAILS = 'Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.';
const CRANE_FAILS = 'Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.';
/** What the list says beside a movement it greys (its line of the list; the reason is under the pointer). */
export const CAMERA_OFF_NOTE = 'pas fiable';
export const CAMERA_MOVES = [
  { id: 'static', name: 'Fixe', whole: 'The camera stays perfectly still, a locked-off static shot.' },
  { id: 'dolly_in', name: 'Travelling avant', words: 'dollies in' },
  { id: 'dolly_out', name: 'Travelling arrière', words: 'dollies out' },
  { id: 'truck_left', name: 'Travelling latéral gauche', words: 'trucks to the left' },
  { id: 'truck_right', name: 'Travelling latéral droit', words: 'trucks to the right' },
  { id: 'pan_left', name: 'Panoramique gauche', words: 'pans to the left' },
  { id: 'pan_right', name: 'Panoramique droit', words: 'pans to the right' },
  { id: 'tilt_up', name: 'Panoramique vers le haut', words: 'tilts up' },
  { id: 'tilt_down', name: 'Panoramique vers le bas', words: 'tilts down' },
  { id: 'crane_up', name: 'Grue montante', words: 'cranes up', she: true, off: CRANE_FAILS },
  { id: 'crane_down', name: 'Grue descendante', words: 'cranes down', she: true, off: CRANE_FAILS },
  { id: 'zoom_in', name: 'Zoom avant', words: 'zooms in' },
  { id: 'zoom_out', name: 'Zoom arrière', words: 'zooms out' },
  { id: 'orbit_left', name: 'Orbite gauche', words: 'orbits around the subject to the left', she: true, off: ORBIT_FAILS },
  { id: 'orbit_right', name: 'Orbite droite', words: 'orbits around the subject to the right', she: true, off: ORBIT_FAILS },
  { id: 'handheld', name: 'À l’épaule', whole: 'Handheld camera, with a slight natural shake.' },
  { id: 'follow', name: 'Suivi du sujet', whole: 'The camera follows the subject, keeping it in frame.' },
];
// The speeds: the name of the list, the English adverb, how the page of a take says it after the movement.
export const CAMERA_SPEEDS = [
  { id: 'slow', name: 'Lente', adverb: 'slowly', said: ['lent', 'lente'] },
  { id: 'normal', name: 'Normale', adverb: '', said: ['', ''] },
  { id: 'fast', name: 'Rapide', adverb: 'quickly', said: ['rapide', 'rapide'] },
];
// What « Ajouter › Caméra » starts from (capture 95): the simplest movement, at the speed of the list's middle.
export const CAMERA_DEFAULT = { move: 'dolly_in', speed: 'normal' };

const moveOf = id => CAMERA_MOVES.find(move => move.id === id) ?? null;
const speedOf = id => CAMERA_SPEEDS.find(speed => speed.id === id) ?? null;
/** Whether a movement has a speed (a fixed shot has none). */
export const cameraHasSpeed = id => Boolean(moveOf(id)?.words);
/** (0.6.212) Why a movement of the list is greyed and not made; '' for one that is proposed, or none of the list. */
export const cameraOff = id => moveOf(id)?.off ?? '';

/**
 * The camera a take was made with, `{ move, speed }`, from what its sheet keeps: any movement of the list,
 * proposed today or not (a take keeps its name, a draft promoted stays the same shot); null when it names none.
 * A speed that is none of the list, or given to a movement that has none, is the normal one.
 */
export function cameraMade(value) {
  const move = moveOf(value?.move);
  if (!move) return null;
  return { move: move.id, speed: move.words && speedOf(value.speed) ? value.speed : 'normal' };
}

/**
 * A choice for a take to make, as it is kept and sent, `{ move, speed }`, from whatever names one (`{ move,
 * speed }`, or the two arguments of a verb): null when it names no movement of the list, or one the list greys
 * (cameraOff).
 */
export function cameraChoice(value) {
  const made = cameraMade(value);
  return made && !cameraOff(made.move) ? made : null;
}

/** The English sentence added to the prompt for a choice: « The camera slowly dollies in. »; '' for none. */
export function cameraSentence(value) {
  const choice = cameraMade(value);
  if (!choice) return '';
  const move = moveOf(choice.move),
    adverb = speedOf(choice.speed).adverb;
  return move.whole ?? `The camera ${adverb ? adverb + ' ' : ''}${move.words}.`;
}

/** A choice as the page of a take names it: « Travelling avant, lent », « Grue montante », « Fixe »; '' for none. */
export function cameraLabel(value) {
  const choice = cameraMade(value);
  if (!choice) return '';
  const move = moveOf(choice.move),
    said = speedOf(choice.speed).said[move.she ? 1 : 0];
  return move.name + (said ? ', ' + said : '');
}

/**
 * A prompt with the sentence of the camera after it, as the model is given it: the prompt ends its own
 * sentence first (« …sur le ponton » → « …sur le ponton. The camera slowly dollies in. »). The prompt alone
 * when there is no choice.
 */
export function withCamera(prompt, value) {
  const sentence = cameraSentence(value);
  if (!sentence) return String(prompt ?? '');
  // (What a sentence left open ends with is dropped: « …le ponton, » → « …le ponton. ».)
  const text = String(prompt ?? '')
    .trim()
    .replace(/[\s,;:]+$/, '');
  if (!text) return sentence;
  // Ended already, a quote or a bracket closed after its full stop too: « …"Come in." ».
  return text + (/[.!?…][»”"')\]]*$/.test(text) ? ' ' : '. ') + sentence;
}
