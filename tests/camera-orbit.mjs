import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GLOBE,
  GUIDE_LENS,
  ORBIT_BOUNDS,
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
  refilmSaid,
  refilmSizes,
  refilmStart,
  refilmTime,
  ringGradient,
  workSaid,
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
    // (0.6.250) The size advised while the computer has made nothing, its patience, what it made.
    advised: 1024 * 576,
    patience: 60,
    made: [],
  });
  assert.deepEqual(orbitBounds(null), ORBIT_BOUNDS);
  // The server's bounds, each one taken whole or not at all.
  const own = orbitBounds({
    azimuth: { min: -60, max: 60, safe: [-30, 30] },
    elevation: { min: 0, max: 45 },
    distance: { min: 3, max: 1 },
    zones: { safe: { azimuth: 30, up: 20, down: 10 }, maybe: { azimuth: 60, up: 0, down: 35 } },
    near: 8,
    advised: 400000,
    patience: 30,
    made: [{ pixels: 344064, frames: 121, seconds: 113, size: '768 × 448' }, { pixels: 0, frames: 121, seconds: 9 }, { pixels: 10, frames: '121', seconds: 9 }, null],
  });
  assert.deepEqual(own, {
    azimuth: { min: -60, max: 60 },
    elevation: { min: 0, max: 45 },
    distance: ORBIT_BOUNDS.distance,
    zones: { safe: { azimuth: 30, up: 20, down: 10 }, maybe: ORBIT_BOUNDS.zones.maybe },
    near: 8,
    advised: 400000,
    patience: 30,
    made: [{ pixels: 344064, frames: 121, seconds: 113 }],
  });
  assert.deepEqual(orbitPose({ azimuth: 120, elevation: -10, distance: 1 }, own), { azimuth: 60, elevation: 0, distance: 1 });
  for (const none of [{ azimuth: { min: 90, max: -90 } }, { azimuth: { min: '0', max: 90 } }, { near: -1 }, { near: '5' }, { advised: 0 }, { patience: '60' }, { made: 'x' }]) assert.deepEqual(orbitBounds(none), ORBIT_BOUNDS, JSON.stringify(none));
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

test('(0.6.250) the size a clip is filmed again at: those of its format up to its own; a large one is said long, never refused', () => {
  const said = clip => refilmSizes(clip).map(size => size.width + ' × ' + size.height);
  // The sizes of its format, the smallest first, up to its own; its own cut down to multiples of 32.
  assert.deepEqual(said({ width: 1600, height: 896 }), ['512 × 288', '768 × 448', '1024 × 576', '1344 × 768', '1600 × 896']);
  assert.deepEqual(said({ width: 896, height: 1600 }), ['288 × 512', '448 × 768', '576 × 1024', '768 × 1344', '896 × 1600']);
  assert.deepEqual(said({ width: 768, height: 448 }), ['512 × 288', '768 × 448']);
  assert.deepEqual(said({ width: 1280, height: 704 }), ['512 × 288', '768 × 448', '1024 × 576', '1280 × 704']);
  assert.deepEqual(said({ width: 1290, height: 730 }), ['512 × 288', '768 × 448', '1024 × 576', '1280 × 704']);
  assert.deepEqual(said({ width: 1024, height: 1024 }), ['384 × 384', '512 × 512', '768 × 768', '1024 × 1024']);
  // (Never one of another shape: the sizes of 16:9 that fit in a clip of 1600 × 1200 are none of its own.)
  assert.deepEqual(said({ width: 1600, height: 1200 }), ['384 × 288', '512 × 384', '640 × 480', '768 × 576', '1024 × 768', '1280 × 960', '1600 × 1184']);
  // (A panorama no format is near: its own size alone, never a size that would cut a third of it away.)
  assert.deepEqual(said({ width: 1920, height: 640 }), ['1920 × 640']);
  for (const none of [null, {}, { width: 100, height: 40 }, { width: 'x', height: 448 }]) assert.deepEqual(refilmSizes(none), [], JSON.stringify(none));

  const sizes = refilmSizes({ width: 1600, height: 896 }),
    at = name => sizes.find(size => size.width + ' × ' + size.height === name),
    seconds = 121 / 24,
    never = orbitBounds(null),
    here = orbitBounds({ made: [{ pixels: 768 * 448, frames: 121, seconds: 113 }] });
  // A computer that never changed a camera: no time to say. It starts on the largest size within the one
  // advised, says nothing up to it, and above it how many times longer, as a warning.
  assert.equal(refilmTime(at('1024 × 576'), seconds, never), null);
  assert.equal(refilmStart(sizes, seconds, never), at('1024 × 576'));
  assert.deepEqual(sizes.map(size => refilmSaid(size, sizes, seconds, never)), [
    { text: '', warn: false },
    { text: '', warn: false },
    { text: '', warn: false },
    { text: 'Plus long à cette taille : environ 2 fois le temps de 1024 × 576.', warn: true },
    { text: 'Plus long à cette taille : environ 2,5 fois le temps de 1024 × 576.', warn: true },
  ]);
  // (A clip smaller than the size advised starts on its own; one whose every size is above it, on the smallest.)
  assert.deepEqual(refilmStart(refilmSizes({ width: 768, height: 448 }), seconds, never), { width: 768, height: 448 });
  assert.equal(refilmStart(sizes, seconds, orbitBounds({ advised: 1000 })), sizes[0]);
  assert.equal(refilmStart([], seconds, never), null);
  // A computer that has: its own time, brought to what is asked in proportion to the pictures to make (their
  // size by their number). The same size and length: that time itself.
  assert.deepEqual(refilmTime(at('768 × 448'), seconds, here), { seconds: 113, exact: true });
  assert.deepEqual(refilmTime(at('1600 × 896'), seconds, here), { seconds: (113 * 1600 * 896) / (768 * 448), exact: false });
  assert.equal(Math.round(refilmTime(at('768 × 448'), 61 / 24, here).seconds), 57, 'half as long, half the time');
  // (The nearest of what it made: that size first, then the nearest in pictures to make.)
  const two = orbitBounds({ made: [{ pixels: 768 * 448, frames: 121, seconds: 113 }, { pixels: 1024 * 576, frames: 49, seconds: 100 }] });
  assert.deepEqual(refilmTime(at('1024 × 576'), seconds, two), { seconds: (100 * 121) / 49, exact: false });
  assert.equal(Math.round(refilmTime(at('1344 × 768'), seconds, two).seconds), Math.round((113 * 1344 * 768) / (768 * 448)));
  assert.equal(refilmTime(at('768 × 448'), undefined, here), null, 'a clip that does not say its length');
  // It starts on the largest size within its patience (60 s of work for a second of video), says the time of
  // each, and warns beyond.
  assert.equal(refilmStart(sizes, seconds, here), at('1024 × 576'));
  assert.deepEqual(sizes.map(size => refilmSaid(size, sizes, seconds, here)), [
    { text: 'Environ 50 s sur cet ordinateur.', warn: false },
    { text: 'Environ 1 min 50 sur cet ordinateur.', warn: false },
    { text: 'Environ 3 min 10 sur cet ordinateur.', warn: false },
    { text: 'Long à cette taille : environ 6 min sur cet ordinateur.', warn: true },
    { text: 'Long à cette taille : environ 8 min sur cet ordinateur.', warn: true },
  ]);
  // (A faster computer goes further, a slower one starts lower: nothing of another computer is said.)
  assert.equal(refilmStart(sizes, seconds, orbitBounds({ made: [{ pixels: 768 * 448, frames: 121, seconds: 40 }] })), at('1600 × 896'));
  assert.equal(refilmStart(sizes, seconds, orbitBounds({ made: [{ pixels: 768 * 448, frames: 121, seconds: 2000 }] })), sizes[0]);
  assert.equal(refilmStart(sizes, seconds, orbitBounds({ made: [{ pixels: 768 * 448, frames: 121, seconds: 113 }], patience: 30 })), at('768 × 448'));
  // A time as a sentence says it.
  assert.deepEqual([3, 20, 57, 58, 100, 223, 290, 296, 354, 660].map(workSaid), ['5 s', '20 s', '55 s', '1 min', '1 min 40', '3 min 40', '4 min 50', '5 min', '6 min', '11 min']);
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
