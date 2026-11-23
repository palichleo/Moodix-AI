/**
 * (0.6.257, camera-avant-maquette.md, captures K00 to K02) The ball of the camera of a new video: the sphere of
 * « Changer la caméra » (its window, public/camera-orbit.mjs), seen a little from above, the subject in its
 * middle, the camera three quarters in front of it (azimuth 50°, on the equator), and its movement drawn in the
 * accent: the same drawing in the block « Caméra » of the Studio (216 px) and in its menu (70 px a movement).
 * What it draws is the markup of an SVG, a function of the movement alone: the subject is laid over it by the
 * page (the image of the start, or a sign of an image), and the styles (moodix.css) loop the movement.
 */

// The sphere, in the units of its view (152 × 140): its middle, its radius, the half height of its equator.
const CX = 76,
  CY = 70,
  R = 66,
  RY = 21;
export const BALL_VIEW = { width: 152, height: 140 };
/** A point of the equator at that azimuth (0: in front of the subject, towards the one who looks). */
const equator = degrees => {
  const turn = (degrees * Math.PI) / 180;
  return [CX + R * 0.92 * Math.sin(turn), CY + RY * Math.cos(turn)];
};
/** Where the camera stands, and the subject. */
export const BALL_CAMERA = equator(50);
export const BALL_SUBJECT = [CX, CY];
/** Where the subject is laid over the ball, in fractions of its width and height (a frame of 28 × 18). */
export const BALL_SUBJECT_BOX = { left: (CX - 14) / 152, top: (CY - 9) / 140, width: 28 / 152, height: 18 / 140 };

const at = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
const along = (from, to, part) => [from[0] + (to[0] - from[0]) * part, from[1] + (to[1] - from[1]) * part];

/**
 * The way the camera goes for a movement, `{ to: [x, y] }` for one where it moves along a line (a travelling, a
 * crane), `{ points }` for an orbit, `{ shake: true }` for a camera in the hand; null for one where it turns or
 * stays where it stands (a panoramic, a zoom, a fixed shot, a subject followed): its drawing alone says it.
 */
export function ballWay(move) {
  const camera = BALL_CAMERA;
  if (move === 'dolly_in') return { to: along(camera, BALL_SUBJECT, 0.45) };
  if (move === 'dolly_out') return { to: along(camera, BALL_SUBJECT, -0.5) };
  if (move === 'truck_left' || move === 'truck_right') {
    const side = move === 'truck_left' ? -30 : 26;
    return { to: [camera[0] + 0.924 * side, camera[1] - 0.381 * side] };
  }
  if (move === 'crane_up') return { to: [camera[0], camera[1] - 36] };
  if (move === 'crane_down') return { to: [camera[0], camera[1] + 30] };
  if (move === 'orbit_left' || move === 'orbit_right') {
    const end = move === 'orbit_left' ? -30 : 120;
    return { points: Array.from({ length: 25 }, (_, step) => equator(50 + ((end - 50) * step) / 24)) };
  }
  if (move === 'handheld') return { shake: true };
  return null;
}

/**
 * The SVG of the ball for a movement (null: « Au choix du modèle », no camera), `size` its width in pixels
 * (its lines keep their width in pixels whatever it is). `dim`: greyed, a movement that is not made.
 */
export function ballSvg(move = null, { size = 152, dim = false } = {}) {
  const k = 152 / size,
    width = value => (value * k).toFixed(2),
    // What the camera does, in the accent (its colour, currentColor, is given by the styles): drawn in a loop by
    // them, from its start (pathLength 1), its arrow at its end.
    stroke = (d, { dash = false, thin = false } = {}) =>
      `<path class="camera-ball-line" d="${d}" pathLength="1" fill="none" stroke="currentColor" stroke-width="${width(thin ? 1.4 : 1.6)}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${width(3)} ${width(3)}"` : ''}/>`,
    head = (from, to, length = 6.5) => {
      const dx = to[0] - from[0],
        dy = to[1] - from[1],
        norm = Math.hypot(dx, dy) || 1,
        [ux, uy] = [dx / norm, dy / norm],
        a = [to[0] - ux * length - uy * length * 0.55, to[1] - uy * length + ux * length * 0.55],
        b = [to[0] - ux * length + uy * length * 0.55, to[1] - uy * length - ux * length * 0.55];
      return `<path class="camera-ball-head" d="M${at(a)} L${at(to)} L${at(b)}" fill="none" stroke="currentColor" stroke-width="${width(1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    },
    camera = BALL_CAMERA,
    // Where it looks: two lines from the camera to the subject, faint.
    cone = `<path class="camera-ball-cone" d="M${at(camera)} L90 61 M${at(camera)} L90 79" fill="none" stroke="rgba(208, 202, 221, 0.35)" stroke-width="${width(1)}"/>`;
  const sphere =
    `<circle cx="${CX}" cy="${CY}" r="${R}" fill="rgba(238, 232, 222, 0.015)" stroke="rgba(238, 232, 222, 0.22)" stroke-width="${width(1)}"/>` +
    `<ellipse cx="${CX}" cy="${CY}" rx="${RY}" ry="${R}" fill="none" stroke="rgba(238, 232, 222, 0.07)" stroke-width="${width(1)}"/>` +
    `<path d="M${CX - R} ${CY} A${R} ${RY} 0 0 1 ${CX + R} ${CY}" fill="none" stroke="rgba(238, 232, 222, 0.2)" stroke-width="${width(1)}" stroke-dasharray="${width(2)} ${width(3)}"/>` +
    `<path d="M${CX - R} ${CY} A${R} ${RY} 0 0 0 ${CX + R} ${CY}" fill="none" stroke="rgba(238, 232, 222, 0.48)" stroke-width="${width(1)}"/>`;
  let drawn = '';
  const way = move ? ballWay(move) : null;
  if (way?.to) drawn = stroke(`M${at(camera)} L${at(way.to)}`) + head(camera, way.to);
  else if (way?.points) drawn = stroke('M' + way.points.map(at).join(' L')) + head(way.points.at(-3), way.points.at(-1));
  else if (move === 'zoom_in') drawn = cone + stroke(`M${at(camera)} L91 67 M${at(camera)} L91 73`);
  else if (move === 'zoom_out') drawn = cone + stroke(`M${at(camera)} L84 52 M${at(camera)} L84 88`);
  else if (move === 'pan_left' || move === 'pan_right') {
    const [from, to] = move === 'pan_left' ? [camera[0] + 13, camera[0] - 13] : [camera[0] - 13, camera[0] + 13];
    drawn = cone + stroke(`M${at([from, camera[1] - 9])} Q${at([camera[0], camera[1] - 19])} ${at([to, camera[1] - 9])}`) + head([camera[0], camera[1] - 17], [to, camera[1] - 9]);
  } else if (move === 'tilt_up' || move === 'tilt_down') {
    const [from, to] = move === 'tilt_up' ? [camera[1] + 11, camera[1] - 13] : [camera[1] - 13, camera[1] + 11];
    drawn = cone + stroke(`M${at([camera[0] + 12, from])} Q${at([camera[0] + 21, camera[1] - 1])} ${at([camera[0] + 12, to])}`) + head([camera[0] + 19, camera[1] - 1], [camera[0] + 12, to]);
  } else if (move === 'static') drawn = cone;
  else if (move === 'handheld') drawn = cone + stroke(`M${at([camera[0] - 12, camera[1] + 14])} l4 -5 l4 5 l4 -5 l4 5 l4 -5 l4 5`, { thin: true });
  else if (move === 'follow') drawn = stroke(`M${at(camera)} L92 72`, { dash: true }) + stroke('M70 86 L56 86') + head([70, 86], [56, 86]);
  // The camera: a ring and its point; where it goes from, a fainter point, when it moves along a line. The styles
  // carry it to its end in a loop: the page gives it as --dx and --dy (ballDress; never a style written in the
  // markup, which the page's rules of security refuse).
  let dot = '';
  if (move) {
    const [dx, dy] = way?.to ? [way.to[0] - camera[0], way.to[1] - camera[1]] : [0, 0],
      kind = way?.to ? 'line' : way?.shake ? 'shake' : 'still';
    dot =
      (way?.to ? `<circle cx="${camera[0].toFixed(1)}" cy="${camera[1].toFixed(1)}" r="3" fill="rgba(238, 232, 222, 0.3)"/>` : '') +
      `<g transform="translate(${at(camera)})"><g class="camera-ball-cam" data-way="${kind}" data-dx="${dx.toFixed(1)}" data-dy="${dy.toFixed(1)}">` +
      `<circle r="5.6" fill="rgba(238, 232, 222, 0.14)" stroke="#eee8de" stroke-width="${width(1.2)}"/><circle r="2.7" fill="#eee8de"/></g></g>`;
  }
  return (
    `<svg class="camera-ball-art" viewBox="0 0 152 140" width="${size}" height="${Math.round((size * 140) / 152)}" aria-hidden="true" focusable="false"${dim ? ' opacity="0.4"' : ''}>` +
    sphere +
    drawn +
    dot +
    '</svg>'
  );
}

/** Where the camera of a ball put in the page goes, given to the styles (--dx, --dy) once its markup is in place. */
export function ballDress(holder) {
  const camera = holder?.querySelector?.('.camera-ball-cam');
  if (!camera?.style?.setProperty) return;
  camera.style.setProperty('--dx', (Number(camera.dataset.dx) || 0) + 'px');
  camera.style.setProperty('--dy', (Number(camera.dataset.dy) || 0) + 'px');
}
