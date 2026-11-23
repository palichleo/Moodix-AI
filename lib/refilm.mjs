import { problem } from './engine.mjs';
import { orbitBounds, orbitRefusal, ORBIT_WARNS } from '../public/camera-orbit.mjs';

/**
 * (0.6.242) « Changer la caméra » d'une vidéo faite (verb `refilm_video`), on the server: the camera the user
 * placed by hand in the Studio (public/camera-orbit.mjs), checked before anything is proposed, and the format
 * the clip is filmed again at. The rules are the family's (`refilm` in runner/families/ltx25_refilm.json),
 * said in the words of the Studio; the engine holds the same ones on the file itself (runner/video/refilm.py),
 * where it also finds a second shot, which no record says.
 *
 * The verb is the user's own hand only: never offered to Moodix AI (`hand` in lib/tasks.json), it asks for no
 * prompt (the clip says what is filmed; the job is given the word of the LoRA's author) and no length (the clip's,
 * cut down to what the model takes). Its size is the clip's, or a smaller one chosen in the Studio (`size`,
 * 0.6.248). Only what cannot be made is refused: a large or long clip takes longer, never refused for it. The
 * Studio says how long from what this computer took before (0.6.249: `made`, which the catalog adds to `refilm`
 * from the history of times, lib/generation-progress.mjs), or from the size advised (`advised`) when nothing was
 * made here.
 */
export const REFILM = 'refilm_video';
// What the model films at; the clip is timed again to it (the frame of each instant).
const FPS = 24;
const POSE_KEYS = ['azimuth', 'elevation', 'distance'];

// The words of what is not made, those of the engine (SAID in runner/video/refilm.py).
export const REFILM_SAID = {
  invalid: 'Caméra : angles ou distance invalides.',
  pivot: 'Caméra : le point autour duquel elle tourne se donne de 0 à 1, sur la largeur et la hauteur de la première image.',
  small: 'Vidéo trop petite pour changer sa caméra : il lui faut 64 pixels de côté au moins.',
  short: 'Vidéo trop courte pour changer sa caméra : il lui faut au moins 9 images.',
  unknown: 'La vidéo à refilmer ne dit pas sa taille, sa longueur ou sa cadence : sa caméra ne peut pas être changée.',
  taken: '« Changer la caméra » se fait sur une vidéo créée dans Moodix : choisissez-en une parmi les prises.',
  missing: 'La vidéo à refilmer est introuvable.',
  hand: '« Changer la caméra » se demande à la main, dans le Studio.',
  edited: 'La vidéo à refilmer, sa taille et sa longueur ne se changent pas sur la proposition : demandez de nouveau le changement de caméra.',
  size: 'Taille : une largeur et une hauteur en multiples de 32, de 64 pixels au moins.',
};

/** A number as a French sentence writes it: 5 → « 5 », 5.5 → « 5,5 », 29.97 → « 29,97 » (2 digits). */
const decimal = (value, digits = 1) => {
  const scale = 10 ** digits,
    text = (Math.floor(Number(value) * scale + 0.5) / scale).toFixed(digits);
  return (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text).replace('.', ',');
};
const fpsSaid = (fps, { min, max }) =>
  `Cette vidéo est à ${decimal(fps, 2)} images par seconde : la caméra se change sur une vidéo de ${decimal(min)} à ${decimal(max)} images par seconde.`;
/** A clip longer than the model films (`seconds`: the most it does), as long_said of the engine says it. */
export const longSaid = seconds => `Vidéo trop longue pour changer sa caméra : ${decimal(seconds)} s au plus.`;
/** A size chosen larger than the clip (its own, cut down to multiples of 32), as size_said of the engine says it. */
export const sizeSaid = ({ width, height }) => `Taille : au plus ${width} × ${height}, la taille de la vidéo.`;
/** A size chosen of another shape than the clip's (`shape`: the share it may differ by), as shape_said says it. */
export const shapeSaid = shape => `Taille : elle garde le format de la vidéo, à ${decimal(shape * 100)} % près.`;

/**
 * What a family holds of the camera and of the clips: the bounds of the Studio (orbitBounds, the server's own
 * when it gives them whole), the frame rates of the clips it takes, the most frames it films (the last of its
 * `frames`: 481, 20 s at 24 a second) and the share a size chosen may differ from the shape of the clip by
 * (`shape`). null for a family without `refilm`.
 */
export function refilmBounds(manifest) {
  const own = manifest?.refilm;
  if (!own || typeof own !== 'object') return null;
  const rate = own.sourceFps,
    real = value => typeof value === 'number' && Number.isFinite(value),
    frames = manifest.parameters?.frames?.choices;
  return {
    ...orbitBounds(own),
    sourceFps: rate && real(rate.min) && real(rate.max) && rate.min > 0 && rate.min <= rate.max ? { min: rate.min, max: rate.max } : { min: FPS, max: FPS },
    mostFrames: Array.isArray(frames) && frames.length && frames.every(Number.isInteger) ? Math.max(...frames) : Infinity,
    shape: real(own.shape) && own.shape >= 0 ? own.shape : 0.1,
  };
}

const plainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
/** A pose as the Studio sends it (orbitArgs), within the bars and the distance of the model; refused in words. */
function poseOf(value, bounds) {
  if (!plainObject(value) || Object.keys(value).some(key => !POSE_KEYS.includes(key))) throw problem(REFILM_SAID.invalid);
  // (A pose without its distance is as far as the camera of the clip, as the Studio draws it.)
  const pose = { azimuth: value.azimuth, elevation: value.elevation, distance: value.distance ?? 1 };
  if (!POSE_KEYS.every(key => typeof pose[key] === 'number' && Number.isFinite(pose[key]))) throw problem(REFILM_SAID.invalid);
  const far = bounds.distance;
  if (pose.distance < far.min || pose.distance > far.max)
    throw problem(far.unavailable || `Distance : entre ${decimal(far.min)} et ${decimal(far.max)}.`);
  if (['azimuth', 'elevation'].some(key => pose[key] < bounds[key].min || pose[key] > bounds[key].max))
    throw problem(ORBIT_WARNS.out);
  return pose;
}

/**
 * The camera of a request (`camera`: the pose held, or the one of the end; `camera_start`: the one of the start
 * when it moves; `pivot`: the point it turns around, `{ x, y }` in fractions of the first frame), as it will be
 * made: `{ camera, camera_start?, pivot? }`. Refused in the words of the Studio: a pose out of what the model
 * learnt, or one that hardly leaves the camera of the clip (orbitRefusal).
 */
export function refilmCamera({ camera, camera_start: start, pivot } = {}, bounds) {
  if (camera === undefined || camera === null) throw problem('Caméra : la position de la caméra manque.');
  const end = poseOf(camera, bounds),
    begin = start === undefined || start === null ? null : poseOf(start, bounds);
  const said = orbitRefusal(begin ? { mode: 'move', start: begin, end } : { mode: 'fixed', fixed: end }, bounds);
  if (said) throw problem(said);
  let point = null;
  if (pivot !== undefined && pivot !== null) {
    if (
      !plainObject(pivot) ||
      Object.keys(pivot).some(key => !['x', 'y'].includes(key)) ||
      !['x', 'y'].every(key => typeof pivot[key] === 'number' && pivot[key] >= 0 && pivot[key] <= 1)
    )
      throw problem(REFILM_SAID.pivot);
    point = { x: pivot.x, y: pivot.y };
  }
  return { camera: end, ...(begin ? { camera_start: begin } : {}), ...(point ? { pivot: point } : {}) };
}

/**
 * The frames of the file of a take, as clipSeconds of public/take-length.mjs counts its length (the Studio
 * refuses with it): the file of a continuation holds the clip it continues, then what it adds (`continuation`,
 * written by the engine), not the frames its job generated, overlap included (241 for a file of 473 on 21/11).
 */
function fileFrames(parameters) {
  const made = parameters?.continuation;
  return made?.sourceFrames > 0 && made?.newFrames > 0 ? made.sourceFrames + made.newFrames : parameters?.frames;
}

/**
 * The clip a take is, as far as its record tells: `{ width, height, frames, fps }` (its file, its own frames and
 * rate as the engine wrote them; `format` adds what a chain of upscales and smoothings says of its rate).
 */
export function clipOf(record, index = 0, format = null) {
  const output = record?.outputs?.[index] ?? {},
    parameters = record?.parameters ?? {};
  return {
    width: format?.width ?? output.width ?? parameters.width,
    height: format?.height ?? output.height ?? parameters.height,
    frames: fileFrames(parameters),
    fps: Number.isFinite(parameters.fps) ? parameters.fps : (format?.fps ?? null),
  };
}

/**
 * What a clip is filmed again at without a size chosen: `{ width, height, frames }`, its size cut down to
 * multiples of 32 in its middle, and the frames at 24 a second its length covers, 8n + 1 (output_format of
 * runner/video/refilm.py). Refused in words for a rate the model does not take, a clip too small, too short, or
 * longer than the model films (20 s); never for the time it takes (0.6.248).
 */
export function refilmFormat({ width, height, frames, fps } = {}, bounds) {
  if (![width, height, frames].every(value => Number.isInteger(value) && value > 0) || !(Number.isFinite(fps) && fps > 0))
    throw problem(REFILM_SAID.unknown);
  if (fps < bounds.sourceFps.min || fps > bounds.sourceFps.max) throw problem(fpsSaid(fps, bounds.sourceFps));
  const made = { width: Math.floor(width / 32) * 32, height: Math.floor(height / 32) * 32 };
  if (Math.min(made.width, made.height) < 64) throw problem(REFILM_SAID.small);
  const covered = Math.floor(((frames - 1) / fps) * FPS + 1e-6) + 1,
    count = Math.floor((covered - 1) / 8) * 8 + 1;
  if (count < 9) throw problem(REFILM_SAID.short);
  if (count > bounds.mostFrames) throw problem(longSaid((bounds.mostFrames - 1) / FPS));
  return { ...made, frames: count };
}

/**
 * (0.6.248) The size a clip is filmed at: `size` (`{ width, height }`) when the Studio chose one, else its own cut
 * down to multiples of 32 (`made`, refilmFormat), which is always taken. A size chosen is in multiples of 32, of 64
 * pixels at least, at most the clip's own, and keeps its shape within `bounds.shape` (of `clip`, clipOf, its own
 * size): the engine shrinks the clip on the processor to cover it, then cuts it in its middle (fitted of
 * runner/video/refilm.py), and its depth, its guide and LTX are made at that size. A larger size only takes
 * longer: nothing is refused for it. Refused in words (« Taille : … », size_refusal of the engine).
 */
export function refilmSize(size, made, clip, bounds) {
  if (size === undefined || size === null) return { width: made.width, height: made.height };
  if (
    !plainObject(size) ||
    Object.keys(size).some(key => !['width', 'height'].includes(key)) ||
    !['width', 'height'].every(key => Number.isInteger(size[key]) && size[key] >= 64 && size[key] % 32 === 0)
  )
    throw problem(REFILM_SAID.size);
  const chosen = { width: size.width, height: size.height };
  if (chosen.width === made.width && chosen.height === made.height) return chosen;
  if (chosen.width > made.width || chosen.height > made.height) throw problem(sizeSaid(made));
  // (The same operations as the engine's, so that both find the same at the edge.)
  if (Math.abs((chosen.width * clip.height) / (chosen.height * clip.width) - 1) > bounds.shape) throw problem(shapeSaid(bounds.shape));
  return chosen;
}

/**
 * The parameters of the job for a camera (refilmCamera), as the engine reads them, and the size of the clip as
 * its record says it (`clip`, clipOf), which the engine compares with its file: the job's own size may be a
 * smaller one, chosen in the Studio (0.6.248). The size of the clip is not kept with the take (#saveRecord).
 */
export function refilmParameters({ camera, camera_start: start, pivot, clip }) {
  return {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    distance: camera.distance,
    ...(start ? { start_azimuth: start.azimuth, start_elevation: start.elevation, start_distance: start.distance } : {}),
    ...(pivot ? { pivot_x: pivot.x, pivot_y: pivot.y } : {}),
    ...(clip ? { source_width: clip.width, source_height: clip.height } : {}),
  };
}

/** What the sheet of the take keeps of its camera (`parameters.refilm`, read back by orbitOf of the Studio). */
export function refilmSheet({ camera, camera_start: start, pivot }) {
  return { camera: { ...camera }, ...(start ? { camera_start: { ...start } } : {}), ...(pivot ? { pivot: { ...pivot } } : {}) };
}

/** The word the job is given for a prompt: the one the LoRA's author trained it with (the family's template). */
export const refilmPrompt = manifest => manifest?.template?.parameters?.prompt?.value ?? 'crossview';
