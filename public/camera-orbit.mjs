/**
 * « Changer la caméra » d'une vidéo déjà faite (0.6.240, maquette du 22/11, claude_design/maquettes-camera) : the
 * camera placed by hand around the scene of a clip, then the clip filmed again from there by a model made for it
 * (verb `refilm_video`).
 *
 * A pose is `{ azimuth, elevation, distance }`: degrees to the right of the camera of the clip, degrees above it,
 * and how far it stands as a multiple of where that camera stood (1: as far). Either one pose held for the whole
 * clip (« Fixe »), or two, the camera going from the first to the second over its length (« Du début à la fin »).
 *
 * What a model holds is said by the server with its tool (`refilm`): how far its bars go, the zone it is sure of
 * (`zones.safe`) and the one it may do (`zones.maybe`), each an ellipse over the azimuth and the elevation (45° to
 * the side and 30° above at once are not both held); beyond them, what it never learnt, which is not made. Nor is
 * a camera too near the one of the clip (`near`): there such a model behaves badly. The angle chosen is a target:
 * such models often turn less than asked.
 *
 * Nothing here needs the page: the Studio draws with what these functions say (public/studio.mjs).
 */

// What the tool is drawn with when the server says nothing of a bound (what its author gives for
// CrossView-Warp; the server's own replace them).
export const ORBIT_BOUNDS = {
  azimuth: { min: -90, max: 90 },
  elevation: { min: -35, max: 45 },
  distance: { min: 0.5, max: 2 },
  // Each zone an ellipse: how far to the side with the camera level, how far above and below facing the clip.
  zones: { safe: { azimuth: 45, up: 30, down: 20 }, maybe: { azimuth: 90, up: 45, down: 35 } },
  // Degrees from the camera of the clip under which nothing is made.
  near: 5,
  // How long a clip may be for its size, `[{ pixels, seconds }]`; none: the server alone says.
  limits: [],
};
/** The bounds of a tool, each one the server's when it gives it whole, the one above otherwise. */
export function orbitBounds(refilm) {
  const real = value => typeof value === 'number' && Number.isFinite(value),
    axis = key => {
      const own = refilm?.[key];
      return own && real(own.min) && real(own.max) && own.min < own.max ? { min: own.min, max: own.max } : { ...ORBIT_BOUNDS[key] };
    },
    // The distance may be one value alone: the model does not hold it, and says why (`unavailable`).
    far = refilm?.distance,
    distance =
      far && real(far.min) && real(far.max) && far.min > 0 && far.min <= far.max
        ? { min: far.min, max: far.max, ...(typeof far.unavailable === 'string' && far.unavailable ? { unavailable: far.unavailable } : {}) }
        : { ...ORBIT_BOUNDS.distance },
    zone = key => {
      const own = refilm?.zones?.[key];
      return own && [own.azimuth, own.up, own.down].every(value => real(value) && value > 0)
        ? { azimuth: own.azimuth, up: own.up, down: own.down }
        : { ...ORBIT_BOUNDS.zones[key] };
    },
    limits = (Array.isArray(refilm?.limits) ? refilm.limits : [])
      .filter(row => real(row?.pixels) && real(row?.seconds) && row.pixels > 0 && row.seconds > 0)
      .map(({ pixels, seconds }) => ({ pixels, seconds }))
      .sort((a, b) => a.pixels - b.pixels);
  return {
    azimuth: axis('azimuth'),
    elevation: axis('elevation'),
    distance,
    zones: { safe: zone('safe'), maybe: zone('maybe') },
    near: real(refilm?.near) && refilm.near >= 0 ? refilm.near : ORBIT_BOUNDS.near,
    limits,
  };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, otherwise) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : otherwise);
/** A pose within the bounds of the tool, whatever it is given: the camera of the clip for what is missing. */
export function orbitPose(value, bounds = ORBIT_BOUNDS) {
  return {
    azimuth: clamp(Math.round(number(value?.azimuth, 0)), bounds.azimuth.min, bounds.azimuth.max),
    elevation: clamp(Math.round(number(value?.elevation, 0)), bounds.elevation.min, bounds.elevation.max),
    distance: clamp(Math.round(number(value?.distance, 1) * 100) / 100, bounds.distance.min, bounds.distance.max),
  };
}
/** What « Changer la caméra » starts from: one pose held, a little to the right and above. */
export const orbitFresh = (bounds = ORBIT_BOUNDS) => ({
  mode: 'fixed',
  active: 'end',
  fixed: orbitPose({ azimuth: 30, elevation: 10, distance: 1 }, bounds),
  start: orbitPose({ azimuth: 0, elevation: 0, distance: 1 }, bounds),
  end: orbitPose({ azimuth: 30, elevation: 10, distance: 1 }, bounds),
});
/** The draft of the tool as it is kept, whatever it is given (a draft of before, a take looked at). */
export function orbitDraft(value, bounds = ORBIT_BOUNDS) {
  const fresh = orbitFresh(bounds);
  if (!value || typeof value !== 'object') return fresh;
  return {
    mode: value.mode === 'move' ? 'move' : 'fixed',
    active: value.active === 'start' ? 'start' : 'end',
    fixed: orbitPose(value.fixed ?? fresh.fixed, bounds),
    start: orbitPose(value.start ?? fresh.start, bounds),
    end: orbitPose(value.end ?? fresh.end, bounds),
  };
}
/** The pose the bars and the pointer set: the one held, or the end in hand of the two. */
export const orbitCurrent = draft => (draft.mode === 'fixed' ? draft.fixed : draft[draft.active]);
/** The poses the clip will be filmed with: one held, or the start then the end. */
export const orbitPoses = draft => (draft.mode === 'fixed' ? [draft.fixed] : [draft.start, draft.end]);

/** « safe », « maybe » or « out »: where a pose stands in what the model holds (an ellipse for each zone). */
export function orbitZone(pose, bounds = ORBIT_BOUNDS) {
  const within = zone => (pose.azimuth / zone.azimuth) ** 2 + (pose.elevation / (pose.elevation >= 0 ? zone.up : zone.down)) ** 2 <= 1;
  return within(bounds.zones.safe) ? 'safe' : within(bounds.zones.maybe) ? 'maybe' : 'out';
}
/**
 * What a draft comes to: « out » when one of its poses is, « near » when the camera hardly leaves the one of the
 * clip (the pose held; both ends of a camera that moves: starting from the clip's own is its ordinary case),
 * else the least sure of its poses. « out » and « near » are not made (orbitRefusal).
 */
export function orbitWorst(draft, bounds = ORBIT_BOUNDS) {
  const poses = orbitPoses(draft),
    zones = poses.map(pose => orbitZone(pose, bounds));
  if (zones.includes('out')) return 'out';
  if (!poses.some(pose => Math.hypot(pose.azimuth, pose.elevation) >= bounds.near)) return 'near';
  return zones.includes('maybe') ? 'maybe' : 'safe';
}
// What the tool says of each, at its foot and over the guide.
export const ORBIT_SAID = {
  safe: 'Angle sûr',
  maybe: 'Angle moins sûr',
  out: 'Hors du modèle',
  near: 'Trop près de l’origine',
};
export const ORBIT_WARNS = {
  safe: '',
  maybe: 'Angle possible, moins sûr : le modèle tourne souvent moins que demandé.',
  out: 'Hors de ce que le modèle sait faire : il n’a pas appris cet angle.',
  near: 'Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.',
};
/** Why the camera of a draft is not made, '' when it is. */
export function orbitRefusal(draft, bounds = ORBIT_BOUNDS) {
  const zone = orbitWorst(draft, bounds);
  return zone === 'out' || zone === 'near' ? ORBIT_WARNS[zone] : '';
}
/**
 * Why the camera of a clip cannot be changed for its size or its length, '' when it can, or when the tool or
 * the clip does not say enough (the server then says it). `clip` is `{ width, height, seconds }`; the first
 * line of the limits as large as the clip gives how long it may be.
 */
export function clipRefusal(clip, bounds = ORBIT_BOUNDS) {
  const pixels = Number(clip?.width) * Number(clip?.height),
    seconds = Number(clip?.seconds);
  if (!bounds.limits.length || !(pixels > 0)) return '';
  const row = bounds.limits.find(limit => limit.pixels >= pixels);
  if (!row) return 'Vidéo trop grande pour changer sa caméra.';
  // (A quarter of a second of grace: a clip of 121 frames is « 5 s ».)
  if (seconds > row.seconds + 0.25)
    return `Vidéo trop longue : à cette taille, la caméra se change jusqu’à ${String(Math.round(row.seconds * 10) / 10).replace('.', ',')} s.`;
  return '';
}

const degrees = value => Math.round(value) + '°';
/** A pose as its end of the window names it: « 35° · 23° ». */
export const poseText = pose => `${degrees(pose.azimuth)} · ${degrees(pose.elevation)}`;
/** How far, as the bar says it: « × 1,0 ». */
export const distanceText = value => '× ' + Number(value).toFixed(1).replace('.', ',');
/** The camera of a draft as its piece names it: « fixe, 30° · 10° », « 0° · 0° → 30° · 10° ». */
export const orbitLabel = draft => (draft.mode === 'fixed' ? 'fixe, ' + poseText(draft.fixed) : poseText(draft.start) + ' → ' + poseText(draft.end));

/** What the verb is sent: the pose held, or the one of the end with the one of the start. */
export function orbitArgs(draft) {
  const pose = ({ azimuth, elevation, distance }) => ({ azimuth, elevation, distance });
  return draft.mode === 'fixed' ? { camera: pose(draft.fixed) } : { camera: pose(draft.end), camera_start: pose(draft.start) };
}
/** The draft a take was made with, from its sheet (`parameters.refilm`); null when it keeps none. */
export function orbitOf(parameters, bounds = ORBIT_BOUNDS) {
  const made = parameters?.refilm;
  if (!made?.camera || typeof made.camera !== 'object') return null;
  const end = orbitPose(made.camera, bounds);
  return made.camera_start && typeof made.camera_start === 'object'
    ? { mode: 'move', active: 'end', fixed: end, start: orbitPose(made.camera_start, bounds), end }
    : { mode: 'fixed', active: 'end', fixed: end, start: orbitPose(null, bounds), end };
}

/** The pose between two, `at` from 0 (the first) to 1 (the second). */
export const poseBetween = (start, end, at) => ({
  azimuth: start.azimuth + (end.azimuth - start.azimuth) * at,
  elevation: start.elevation + (end.elevation - start.elevation) * at,
  distance: start.distance + (end.distance - start.distance) * at,
});

// The sphere of the window, seen from a little above: its radius, its centre, how far it is tilted.
export const GLOBE = { radius: 68, x: 143, y: 86, width: 286, height: 176, tilt: 20 };
/**
 * Where a camera is drawn on the sphere: `{ x, y, behind }`. In front of the clip at its bottom (« face »),
 * to its right at the right; nearer the centre as it comes nearer (`bounds.distance`).
 */
export function globePoint(pose, bounds = ORBIT_BOUNDS) {
  const turn = (pose.azimuth * Math.PI) / 180,
    rise = (pose.elevation * Math.PI) / 180,
    tilt = (GLOBE.tilt * Math.PI) / 180,
    { min, max } = bounds.distance,
    // As far as it may go: on the sphere. As near: at six tenths of its radius.
    radius = GLOBE.radius * (0.6 + 0.4 * clamp((pose.distance - min) / (max - min || 1), 0, 1)),
    x = radius * Math.cos(rise) * Math.sin(turn),
    y = radius * Math.sin(rise),
    z = radius * Math.cos(rise) * Math.cos(turn);
  return { x: GLOBE.x + x, y: GLOBE.y - (y * Math.cos(tilt) - z * Math.sin(tilt)), behind: y * Math.sin(tilt) + z * Math.cos(tilt) < 0 };
}
/**
 * The pose a point of the sphere names, for the pointer that drags a camera there: in front of the clip only
 * (its back is set by the bar), its distance kept.
 */
export function globePose(x, y, pose, bounds = ORBIT_BOUNDS) {
  const up = clamp((GLOBE.y - y) / GLOBE.radius, -1, 1),
    elevation = clamp(Math.round((Math.asin(up) * 180) / Math.PI) + 8, bounds.elevation.min, bounds.elevation.max),
    side = clamp((x - GLOBE.x) / (GLOBE.radius * Math.max(0.2, Math.cos((elevation * Math.PI) / 180))), -1, 1),
    azimuth = clamp(Math.round((Math.asin(side) * 180) / Math.PI / 5) * 5, bounds.azimuth.min, bounds.azimuth.max);
  return orbitPose({ azimuth, elevation, distance: pose.distance }, bounds);
}
/**
 * The ring of the zones around the equator of the sphere: a CSS conic gradient of a circle seen from above (the
 * page lays it flat), whose colours are the three variables of moodix.css. In front of the clip at its bottom,
 * to its right at the right: an azimuth `a` is the angle 180° - a of the gradient.
 */
export function ringGradient(bounds = ORBIT_BOUNDS) {
  // (Around the equator the camera is level: each zone goes as far to the side as its ellipse is wide.)
  const [safeFrom, safeTo] = [-bounds.zones.safe.azimuth, bounds.zones.safe.azimuth],
    [maybeFrom, maybeTo] = [-bounds.zones.maybe.azimuth, bounds.zones.maybe.azimuth],
    at = azimuth => Math.round((180 - clamp(azimuth, -180, 180)) * 10) / 10,
    stops = [
      ['out', 0, at(maybeTo)],
      ['maybe', at(maybeTo), at(safeTo)],
      ['safe', at(safeTo), at(safeFrom)],
      ['maybe', at(safeFrom), at(maybeFrom)],
      ['out', at(maybeFrom), 360],
    ].filter(([, from, to]) => to > from);
  return 'conic-gradient(' + stops.map(([zone, from, to]) => `var(--orbit-${zone}) ${from}deg ${to}deg`).join(', ') + ')';
}
/** The path of the camera on the sphere, from the start to the end of a draft: thirteen points `{ x, y, behind }`. */
export function globeDots(draft, bounds = ORBIT_BOUNDS) {
  return Array.from({ length: 13 }, (_, at) => globePoint(poseBetween(draft.start, draft.end, at / 12), bounds));
}

// How far the eye stands from the picture of the guide, in hundredths of the width of its frame (moodix.css
// gives the same perspective to its lens).
export const GUIDE_LENS = 82;
/**
 * The simple guide: the picture of the clip stood up in space, seen from a pose. The CSS transform of its world
 * (moodix.css draws it in perspective). It asks no model and no graphics card; it does not show what the model
 * will invent of the sides.
 */
export function guideTransform(pose) {
  // In hundredths of the width of its frame (`cqw`), as its perspective is (GUIDE_LENS): it is the same picture
  // in a small frame and in a large one. As far as the camera of the clip stood (1): the picture as it is.
  // Twice as far: half as large.
  const round = value => Math.round(value * 10) / 10 || 0,
    depth = round(-GUIDE_LENS * (clamp(pose.distance, 0.1, 10) - 1));
  return `translateZ(${depth}cqw) rotateX(${round(-pose.elevation)}deg) rotateY(${round(-pose.azimuth)}deg)`;
}
