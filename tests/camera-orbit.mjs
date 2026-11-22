import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GLOBE,
  GUIDE_LENS,
  ORBIT_BOUNDS,
  ORBIT_SAID,
  ORBIT_WARNS,
  clipRefusal,
  distanceText,
  globeDots,
  globePoint,
  globePose,
  guideTransform,
  orbitArgs,
  orbitBounds,
  orbitCurrent,
  orbitDraft,
  orbitFresh,
  orbitLabel,
  orbitOf,
  orbitPose,
  orbitPoses,
  orbitRefusal,
  orbitWorst,
  orbitZone,
  poseBetween,
  poseText,
  ringGradient,
} from '../public/camera-orbit.mjs';

// (0.6.240) « Changer la caméra » d'une vidéo faite : the camera placed by hand, one pose held or two. Nothing of it
// needs the page nor the graphics card.

test('a pose stays within the bounds of the tool; the bounds are the server’s when it gives them whole', () => {
  assert.deepEqual(orbitPose({ azimuth: 30.4, elevation: 9.6, distance: 1.234 }), { azimuth: 30, elevation: 10, distance: 1.23 });
  assert.deepEqual(orbitPose({ azimuth: 400, elevation: -90, distance: 9 }), { azimuth: 90, elevation: -35, distance: 2 });
  assert.deepEqual(orbitPose({ azimuth: -400, elevation: 200, distance: 0 }), { azimuth: -90, elevation: 45, distance: 0.5 });
  // What is missing, or no number: the camera of the clip.
  for (const none of [null, undefined, {}, { azimuth: 'x', elevation: null, distance: '' }, 3]) assert.deepEqual(orbitPose(none), { azimuth: 0, elevation: 0, distance: 1 }, JSON.stringify(none));
  // What the tool is drawn with when the server says nothing: what the author of the model gives.
  assert.deepEqual(ORBIT_BOUNDS, {
    azimuth: { min: -90, max: 90 },
    elevation: { min: -35, max: 45 },
    distance: { min: 0.5, max: 2 },
    zones: { safe: { azimuth: 45, up: 30, down: 20 }, maybe: { azimuth: 90, up: 45, down: 35 } },
    near: 5,
    limits: [],
  });
  assert.deepEqual(orbitBounds(null), ORBIT_BOUNDS);
  // The server's bounds, each one taken whole or not at all.
  const own = orbitBounds({
    azimuth: { min: -60, max: 60, safe: [-30, 30] },
    elevation: { min: 0, max: 45 },
    distance: { min: 3, max: 1 },
    zones: { safe: { azimuth: 30, up: 20, down: 10 }, maybe: { azimuth: 60, up: 0, down: 35 } },
    near: 8,
    limits: [{ pixels: 2000, seconds: 4 }, { pixels: 'x', seconds: 9 }, { pixels: 1000, seconds: 8 }, { pixels: 500, seconds: 0 }, null],
  });
  assert.deepEqual(own, {
    azimuth: { min: -60, max: 60 },
    elevation: { min: 0, max: 45 },
    distance: ORBIT_BOUNDS.distance,
    zones: { safe: { azimuth: 30, up: 20, down: 10 }, maybe: ORBIT_BOUNDS.zones.maybe },
    near: 8,
    // (The lines that say a size and a length, the smallest first.)
    limits: [{ pixels: 1000, seconds: 8 }, { pixels: 2000, seconds: 4 }],
  });
  assert.deepEqual(orbitPose({ azimuth: 120, elevation: -10, distance: 1 }, own), { azimuth: 60, elevation: 0, distance: 1 });
  for (const none of [{ azimuth: { min: 90, max: -90 } }, { azimuth: { min: '0', max: 90 } }, { near: -1 }, { near: '5' }, { limits: 'x' }]) assert.deepEqual(orbitBounds(none), ORBIT_BOUNDS, JSON.stringify(none));
  // A distance the model does not hold: one value alone, and why; every pose keeps it.
  const held = orbitBounds({ distance: { min: 1, max: 1, unavailable: 'La distance ne marche pas encore avec ce modèle : son auteur le dit.' } });
  assert.deepEqual(held.distance, { min: 1, max: 1, unavailable: 'La distance ne marche pas encore avec ce modèle : son auteur le dit.' });
  assert.deepEqual(orbitBounds({ distance: { min: 0.8, max: 1.2, unavailable: 7 } }).distance, { min: 0.8, max: 1.2 });
  assert.equal(orbitPose({ azimuth: 10, elevation: 0, distance: 1.7 }, held).distance, 1);
  assert.ok(Number.isFinite(globePoint({ azimuth: 10, elevation: 0, distance: 1 }, held).x));
});

test('the draft of the tool: one pose held, or two; what the verb is sent; what a take gives back', () => {
  const fresh = orbitFresh();
  assert.deepEqual(fresh, { mode: 'fixed', active: 'end', fixed: { azimuth: 30, elevation: 10, distance: 1 }, start: { azimuth: 0, elevation: 0, distance: 1 }, end: { azimuth: 30, elevation: 10, distance: 1 } });
  assert.deepEqual(orbitDraft(null), fresh);
  assert.deepEqual(orbitDraft({ mode: 'spin', active: 'x', fixed: { azimuth: 999 } }).fixed, { azimuth: 90, elevation: 0, distance: 1 });
  assert.deepEqual([orbitDraft({ mode: 'move', active: 'start' }).mode, orbitDraft({ mode: 'move', active: 'start' }).active], ['move', 'start']);
  // Held: the bars set that pose, and it is the one sent.
  assert.equal(orbitCurrent(fresh), fresh.fixed);
  assert.deepEqual(orbitPoses(fresh), [fresh.fixed]);
  assert.deepEqual(orbitArgs(fresh), { camera: { azimuth: 30, elevation: 10, distance: 1 } });
  assert.equal(orbitLabel(fresh), 'fixe, 30° · 10°');
  // From a start to an end: the bars set the end in hand; both are sent, the end as `camera`.
  const moving = { ...fresh, mode: 'move', start: { azimuth: -10, elevation: 5, distance: 1.5 }, end: { azimuth: 40, elevation: 20, distance: 0.8 } };
  assert.equal(orbitCurrent(moving), moving.end);
  assert.equal(orbitCurrent({ ...moving, active: 'start' }), moving.start);
  assert.deepEqual(orbitPoses(moving), [moving.start, moving.end]);
  assert.deepEqual(orbitArgs(moving), { camera: { azimuth: 40, elevation: 20, distance: 0.8 }, camera_start: { azimuth: -10, elevation: 5, distance: 1.5 } });
  assert.equal(orbitLabel(moving), '-10° · 5° → 40° · 20°');
  assert.deepEqual([poseText({ azimuth: -12.4, elevation: 3.6, distance: 1 }), distanceText(1), distanceText(0.75)], ['-12° · 4°', '× 1,0', '× 0,8']);
  // The sheet of a take made so gives its draft back; one made otherwise, none.
  assert.deepEqual(orbitOf({ refilm: orbitArgs(moving) }), { mode: 'move', active: 'end', fixed: moving.end, start: moving.start, end: moving.end });
  assert.deepEqual(orbitOf({ refilm: orbitArgs(fresh) }), { mode: 'fixed', active: 'end', fixed: fresh.fixed, start: { azimuth: 0, elevation: 0, distance: 1 }, end: fresh.fixed });
  for (const none of [null, undefined, {}, { refilm: null }, { refilm: {} }, { refilm: { camera: 'orbit_left' } }, { camera: 'orbit_left' }]) assert.equal(orbitOf(none), null, JSON.stringify(none));
});

test('where a camera stands in what the model holds: sure, possible, never learnt, too near the clip’s own', () => {
  const zone = (azimuth, elevation) => orbitZone({ azimuth, elevation, distance: 1 });
  // Each zone is an ellipse: as far as it goes to the side with the camera level, above and below facing the clip.
  assert.deepEqual([zone(0, 0), zone(45, 0), zone(-45, 0), zone(0, 30), zone(0, -20), zone(30, 20)], ['safe', 'safe', 'safe', 'safe', 'safe', 'safe']);
  // (45° to the side and 30° above at once are not both held.)
  assert.deepEqual([zone(45, 30), zone(-45, -20), zone(46, 0), zone(0, 31), zone(0, -21), zone(90, 0), zone(0, 45), zone(0, -35), zone(60, 30)], Array(9).fill('maybe'));
  assert.deepEqual([zone(90, 45), zone(-90, -35), zone(91, 0), zone(0, 46), zone(0, -36), zone(70, 40), zone(180, 0)], Array(7).fill('out'));
  // What a draft comes to: the least sure of its poses; the start counts only when the camera moves.
  const still = { azimuth: 30, elevation: 0, distance: 1 },
    draft = { mode: 'move', active: 'end', fixed: still, start: { azimuth: 80, elevation: 40, distance: 1 }, end: { azimuth: 50, elevation: 0, distance: 1 } };
  assert.deepEqual([orbitWorst(draft), orbitWorst({ ...draft, start: still }), orbitWorst({ ...draft, mode: 'fixed' })], ['out', 'maybe', 'safe']);
  // Too near the camera of the clip, nothing is made: the pose held; both ends of a camera that moves (starting
  // from the clip's own is its ordinary case).
  const origin = { azimuth: 0, elevation: 0, distance: 1 },
    at = (azimuth, elevation) => ({ azimuth, elevation, distance: 1 });
  assert.deepEqual(
    [origin, at(4, 0), at(3, 3), at(5, 0), at(0, -5), at(4, 4)].map(fixed => orbitWorst({ ...draft, mode: 'fixed', fixed })),
    ['near', 'near', 'near', 'safe', 'safe', 'safe'],
  );
  assert.deepEqual(
    [orbitWorst({ ...draft, start: origin, end: at(40, 0) }), orbitWorst({ ...draft, start: at(40, 0), end: origin }), orbitWorst({ ...draft, start: origin, end: at(2, 1) })],
    ['safe', 'safe', 'near'],
  );
  // (Out of what it learnt first; a model that holds any angle near the clip's own: none too near.)
  assert.equal(orbitWorst({ ...draft, start: origin, end: at(90, 45) }), 'out');
  assert.equal(orbitWorst({ ...draft, mode: 'fixed', fixed: origin }, orbitBounds({ near: 0 })), 'safe');
  // With the zones of another model.
  assert.equal(orbitZone(at(40, 0), orbitBounds({ zones: { safe: { azimuth: 30, up: 20, down: 20 } } })), 'maybe');
  // What the tool says of each: in a few words at its foot, whole over the guide.
  assert.deepEqual(ORBIT_SAID, { safe: 'Angle sûr', maybe: 'Angle moins sûr', out: 'Hors du modèle', near: 'Trop près de l’origine' });
  assert.deepEqual(ORBIT_WARNS, {
    safe: '',
    maybe: 'Angle possible, moins sûr : le modèle tourne souvent moins que demandé.',
    out: 'Hors de ce que le modèle sait faire : il n’a pas appris cet angle.',
    near: 'Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.',
  });
  // What is not made, and why: out of what it learnt, too near. The less sure angle is made.
  assert.deepEqual(
    [at(30, 0), at(60, 0), at(70, 40), origin].map(fixed => orbitRefusal({ ...draft, mode: 'fixed', fixed })),
    ['', '', ORBIT_WARNS.out, ORBIT_WARNS.near],
  );
});

test('a clip too large or too long for the model: said before it is asked', () => {
  const bounds = orbitBounds({ limits: [{ pixels: 1344 * 768, seconds: 3 }, { pixels: 768 * 448, seconds: 5 }] }),
    clip = (width, height, seconds) => clipRefusal({ width, height, seconds }, bounds);
  // The first line as large as the clip gives how long it may be (121 frames at 24 a second are « 5 s »).
  assert.deepEqual([clip(768, 448, 5), clip(768, 448, 121 / 24), clip(448, 768, 5), clip(640, 352, 5.2), clip(1344, 768, 3)], ['', '', '', '', '']);
  assert.equal(clip(768, 448, 8), 'Vidéo trop longue : à cette taille, la caméra se change jusqu’à 5 s.');
  assert.equal(clip(1344, 768, 5), 'Vidéo trop longue : à cette taille, la caméra se change jusqu’à 3 s.');
  assert.equal(clipRefusal({ width: 768, height: 448, seconds: 9 }, orbitBounds({ limits: [{ pixels: 1e6, seconds: 7.5 }] })), 'Vidéo trop longue : à cette taille, la caméra se change jusqu’à 7,5 s.');
  assert.equal(clip(1920, 1080, 2), 'Vidéo trop grande pour changer sa caméra.');
  // What the tool or the clip does not say is left to the server.
  assert.deepEqual([clipRefusal({ width: 1920, height: 1080, seconds: 60 }), clip(undefined, 448, 9), clip(768, 448, undefined), clip(768, 448, NaN), clipRefusal(null, bounds)], ['', '', '', '', '']);
});

test('the sphere: a camera in front at its bottom, to the right at its right, behind greyed; the pointer names a pose', () => {
  const far = { azimuth: 0, elevation: 0, distance: 2 },
    round = point => [Math.round(point.x), Math.round(point.y), point.behind];
  // In front of the clip, as far as it goes: on the sphere, below its centre (seen from a little above).
  assert.deepEqual(round(globePoint(far)), [GLOBE.x, GLOBE.y + Math.round(GLOBE.radius * Math.sin((GLOBE.tilt * Math.PI) / 180)), false]);
  // To the right, to the left, above; behind the clip.
  assert.deepEqual(round(globePoint({ ...far, azimuth: 90 })), [GLOBE.x + GLOBE.radius, GLOBE.y, false]);
  assert.deepEqual(round(globePoint({ ...far, azimuth: -90 })), [GLOBE.x - GLOBE.radius, GLOBE.y, false]);
  assert.ok(globePoint({ ...far, elevation: 60 }).y < globePoint(far).y);
  assert.equal(globePoint({ ...far, azimuth: 180 }).behind, true);
  // Nearer the clip, nearer the centre.
  const near = globePoint({ azimuth: 90, elevation: 0, distance: 0.5 });
  assert.equal(Math.round(near.x), GLOBE.x + Math.round(GLOBE.radius * 0.6));
  // The pointer: the pose under it, by steps of five degrees to the side, its distance kept; never out of the bounds.
  assert.deepEqual(globePose(GLOBE.x, GLOBE.y, { azimuth: 77, elevation: 3, distance: 1.4 }), { azimuth: 0, elevation: 8, distance: 1.4 });
  const right = globePose(GLOBE.x + 40, GLOBE.y, far);
  assert.ok(right.azimuth > 0 && right.azimuth % 5 === 0, JSON.stringify(right));
  assert.ok(globePose(GLOBE.x - 40, GLOBE.y, far).azimuth < 0);
  assert.ok(globePose(GLOBE.x, GLOBE.y - 50, far).elevation > globePose(GLOBE.x, GLOBE.y + 10, far).elevation);
  assert.deepEqual(globePose(-999, 999, far), { azimuth: -90, elevation: -35, distance: 2 });
  // The ring of the zones around its equator, where the camera is level: in front of the clip at the bottom of
  // the circle (180°), its right at the right (90°); sure from -45° to 45°, possible to 90°, its back never learnt.
  assert.equal(
    ringGradient(),
    'conic-gradient(var(--orbit-out) 0deg 90deg, var(--orbit-maybe) 90deg 135deg, var(--orbit-safe) 135deg 225deg, var(--orbit-maybe) 225deg 270deg, var(--orbit-out) 270deg 360deg)',
  );
  assert.equal(
    ringGradient(orbitBounds({ zones: { safe: { azimuth: 180, up: 30, down: 20 }, maybe: { azimuth: 180, up: 45, down: 35 } } })),
    'conic-gradient(var(--orbit-safe) 0deg 360deg)',
  );
  // The path from a start to an end: thirteen points, from the left of the sphere to its right here.
  const path = globeDots({ start: { azimuth: -30, elevation: 0, distance: 1 }, end: { azimuth: 30, elevation: 0, distance: 1 } });
  assert.equal(path.length, 13);
  assert.ok(path[0].x < GLOBE.x && path.at(-1).x > GLOBE.x && Math.abs(path[6].x - GLOBE.x) < 0.01);
  assert.deepEqual(poseBetween({ azimuth: 0, elevation: 0, distance: 1 }, { azimuth: 40, elevation: 20, distance: 2 }, 0.5), { azimuth: 20, elevation: 10, distance: 1.5 });
});

test('the simple guide: the picture of the clip stood up in space, seen from the pose', () => {
  // The camera of the clip: the picture as it is.
  assert.equal(guideTransform({ azimuth: 0, elevation: 0, distance: 1 }), 'translateZ(0cqw) rotateX(0deg) rotateY(0deg)');
  // To the right: the picture turns the other way; above: it leans; twice as far, half as large; half as far, twice.
  assert.equal(guideTransform({ azimuth: 30, elevation: 10, distance: 1 }), 'translateZ(0cqw) rotateX(-10deg) rotateY(-30deg)');
  assert.equal(guideTransform({ azimuth: -12.34, elevation: 0, distance: 2 }), `translateZ(${-GUIDE_LENS}cqw) rotateX(0deg) rotateY(12.3deg)`);
  assert.equal(guideTransform({ azimuth: 0, elevation: 0, distance: 0.5 }), `translateZ(${GUIDE_LENS / 2}cqw) rotateX(0deg) rotateY(0deg)`);
});

test('the page is served the module of the tool, which reads nothing of the page', async () => {
  assert.match(await readFile(new URL('../server.mjs', import.meta.url), 'utf8'), /\['\/camera-orbit\.mjs', \['camera-orbit\.mjs',/);
  // From the Chat and the Archives, the action of a take leads to the Studio, its tool open (public/app.js).
  assert.match(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), /if \(action === 'refilm'\)\r?\n\s+return void closeChat\(\)\r?\n\s+\.then\(\(\) => revealStudio\(\)\)\r?\n\s+\.then\(\(\) => studioUI\.refilm\(record\)\);/);
  const source = await readFile(new URL('../public/camera-orbit.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bdocument\.|\bwindow\.|globalThis/);
});
