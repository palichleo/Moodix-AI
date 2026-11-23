import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CAMERA_DEFAULT,
  CAMERA_FAMILIES,
  CAMERA_GROUPS,
  CAMERA_MOVES,
  CAMERA_OFF_NOTE,
  CAMERA_SPEEDS,
  CAMERA_VERBS,
  cameraChoice,
  cameraHasSpeed,
  cameraLabel,
  cameraMade,
  cameraOf,
  cameraOff,
  cameraSentence,
  cameraShort,
  cameraSpeedName,
  cameraSpeedValue,
  takesCamera,
  withCamera,
} from '../public/camera.mjs';

// (0.6.211, LOTS.md, lot 14) The camera of a video: a closed list, and for each choice the fixed English sentence
// the application adds to the prompt. Nothing of it needs the graphics card.

test('each movement of the camera has its fixed sentence, at each speed', () => {
  // Every movement, slow: the sentence the model is given, to the letter. One changed is a change of what every
  // take made with it was made from.
  assert.deepEqual(
    CAMERA_MOVES.map(move => [move.id, move.name, cameraSentence({ move: move.id, speed: 'slow' })]),
    [
      ['static', 'Fixe', 'The camera stays perfectly still, a locked-off static shot.'],
      ['dolly_in', 'Travelling avant', 'The camera slowly dollies in.'],
      ['dolly_out', 'Travelling arrière', 'The camera slowly dollies out.'],
      ['truck_left', 'Travelling latéral gauche', 'The camera slowly trucks to the left.'],
      ['truck_right', 'Travelling latéral droit', 'The camera slowly trucks to the right.'],
      ['pan_left', 'Panoramique gauche', 'The camera slowly pans to the left.'],
      ['pan_right', 'Panoramique droit', 'The camera slowly pans to the right.'],
      ['tilt_up', 'Panoramique vers le haut', 'The camera slowly tilts up.'],
      ['tilt_down', 'Panoramique vers le bas', 'The camera slowly tilts down.'],
      ['crane_up', 'Grue montante', 'The camera slowly cranes up.'],
      ['crane_down', 'Grue descendante', 'The camera slowly cranes down.'],
      ['zoom_in', 'Zoom avant', 'The camera slowly zooms in.'],
      ['zoom_out', 'Zoom arrière', 'The camera slowly zooms out.'],
      ['orbit_left', 'Orbite gauche', 'The camera slowly orbits around the subject to the left.'],
      ['orbit_right', 'Orbite droite', 'The camera slowly orbits around the subject to the right.'],
      ['handheld', 'À l’épaule', 'Handheld camera, with a slight natural shake.'],
      ['follow', 'Suivi du sujet', 'The camera follows the subject, keeping it in frame.'],
    ],
  );
  // The three speeds of the list; the normal one adds no word.
  assert.deepEqual(CAMERA_SPEEDS.map(speed => [speed.id, speed.name]), [['slow', 'Lente'], ['normal', 'Normale'], ['fast', 'Rapide']]);
  assert.deepEqual(
    ['slow', 'normal', 'fast'].map(speed => cameraSentence({ move: 'pan_left', speed })),
    ['The camera slowly pans to the left.', 'The camera pans to the left.', 'The camera quickly pans to the left.'],
  );
  // What has no speed says the same at each: a fixed shot, a camera in the hand, one that follows.
  for (const move of ['static', 'handheld', 'follow']) {
    assert.equal(cameraHasSpeed(move), false, move);
    assert.equal(new Set(['slow', 'normal', 'fast'].map(speed => cameraSentence({ move, speed }))).size, 1, move);
  }
  assert.deepEqual(CAMERA_MOVES.filter(move => cameraHasSpeed(move.id)).length, 14);
  // One sentence each, its own, ended by its full stop; no two movements say the same.
  const all = CAMERA_MOVES.flatMap(move => CAMERA_SPEEDS.map(speed => cameraSentence({ move: move.id, speed: speed.id })));
  assert.ok(all.every(sentence => /^[A-Z][^.]*\.$/.test(sentence)), 'one sentence, one full stop');
  assert.equal(new Set(CAMERA_MOVES.map(move => cameraSentence({ move: move.id, speed: 'normal' }))).size, CAMERA_MOVES.length);
  assert.equal(new Set(CAMERA_MOVES.map(move => move.id)).size, CAMERA_MOVES.length);
  // What « Ajouter › Caméra » starts from is a choice of the list.
  assert.deepEqual([CAMERA_DEFAULT, cameraSentence(CAMERA_DEFAULT)], [{ move: 'dolly_in', speed: 'normal' }, 'The camera dollies in.']);
});

test('a choice of camera is of the list or is none; the page of a take names it in French', () => {
  assert.deepEqual(cameraChoice({ move: 'dolly_in', speed: 'slow' }), { move: 'dolly_in', speed: 'slow' });
  // A speed that is none of the list, or none given: the normal one. Given to a movement without speed: none kept.
  assert.deepEqual(cameraChoice({ move: 'dolly_in', speed: 'warp' }), { move: 'dolly_in', speed: 'normal' });
  assert.deepEqual(cameraChoice({ move: 'dolly_in' }), { move: 'dolly_in', speed: 'normal' });
  assert.deepEqual(cameraChoice({ move: 'static', speed: 'fast' }), { move: 'static', speed: 'normal' });
  // Nothing else of what it was given is kept (a free text beside it, an « ends on »).
  assert.deepEqual(cameraChoice({ move: 'pan_left', speed: 'fast', ends: 'the door', prompt: 'x' }), { move: 'pan_left', speed: 'fast' });
  // No movement of the list: no choice, no sentence, no name.
  for (const none of [null, undefined, {}, 'dolly_in', { move: 'spin' }, { move: 'toString' }, { move: '' }, { speed: 'slow' }, 3]) {
    assert.equal(cameraChoice(none), null);
    assert.equal(cameraSentence(none), '');
    assert.equal(cameraLabel(none), '');
  }
  // (Capture 107) « Travelling avant, lent »; the speed agrees with its movement; the normal one is not said.
  assert.deepEqual(
    [
      { move: 'dolly_in', speed: 'slow' },
      { move: 'dolly_in', speed: 'normal' },
      { move: 'dolly_in', speed: 'fast' },
      { move: 'crane_up', speed: 'slow' },
      { move: 'orbit_left', speed: 'slow' },
      { move: 'orbit_right', speed: 'fast' },
      { move: 'tilt_up', speed: 'slow' },
      { move: 'static', speed: 'slow' },
      { move: 'handheld' },
    ].map(cameraLabel),
    ['Travelling avant, lent', 'Travelling avant', 'Travelling avant, rapide', 'Grue montante, lente', 'Orbite gauche, lente', 'Orbite droite, rapide', 'Panoramique vers le haut, lent', 'Fixe', 'À l’épaule'],
  );
});

test('(0.6.212) an orbit and a crane are greyed with why: no choice for a take to make, their name and sentence kept for a take made', () => {
  // The user's verdict on the real videos of 22/11 (LTX 2.5): « Orbite gauche », the camera stayed still; « Grue
  // montante », it ended looking down. Both, and their mirrors, stay in the list with why; nothing else is greyed.
  assert.deepEqual(
    CAMERA_MOVES.filter(move => cameraOff(move.id)).map(move => [move.id, cameraOff(move.id)]),
    [
      ['crane_up', 'Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.'],
      ['crane_down', 'Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.'],
      ['orbit_left', 'Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.'],
      ['orbit_right', 'Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.'],
    ],
  );
  assert.equal(CAMERA_OFF_NOTE, 'pas fiable');
  for (const none of [null, undefined, '', 'spin', 'toString', 'dolly_in', 'pan_left', 'static']) assert.equal(cameraOff(none), '', String(none));
  // What « Ajouter › Caméra » starts from is not one of them.
  assert.equal(cameraOff(CAMERA_DEFAULT.move), '');
  for (const move of ['crane_up', 'crane_down', 'orbit_left', 'orbit_right']) {
    // No choice for a take to make, at any speed...
    for (const speed of ['slow', 'normal', 'fast', undefined]) assert.equal(cameraChoice({ move, speed }), null, move);
    // ...and what a take was made with is still read whole: its name on its page, the sentence it was given.
    assert.deepEqual(cameraMade({ move, speed: 'fast', ends: 'x' }), { move, speed: 'fast' });
    assert.notEqual(cameraLabel({ move, speed: 'slow' }), '');
    assert.match(cameraSentence({ move, speed: 'slow' }), /^The camera slowly (cranes|orbits) /);
    assert.match(withCamera('Le phare', { move, speed: 'slow' }), /^Le phare\. The camera slowly /);
  }
  // Every other movement is a choice as before, and what a take was made with is read the same way.
  for (const move of CAMERA_MOVES.filter(item => !cameraOff(item.id))) {
    assert.deepEqual(cameraChoice({ move: move.id, speed: 'slow' }), cameraMade({ move: move.id, speed: 'slow' }), move.id);
    assert.notEqual(cameraChoice({ move: move.id }), null, move.id);
  }
  for (const none of [null, undefined, {}, 'dolly_in', { move: 'spin' }, { speed: 'slow' }]) assert.equal(cameraMade(none), null);
});

test('the sentence goes after the prompt, which ends its own sentence first; without a choice the prompt is untouched', () => {
  const slow = { move: 'dolly_in', speed: 'slow' };
  assert.equal(withCamera('Le pêcheur lève les yeux', slow), 'Le pêcheur lève les yeux. The camera slowly dollies in.');
  assert.equal(withCamera('Le pêcheur lève les yeux.', slow), 'Le pêcheur lève les yeux. The camera slowly dollies in.');
  assert.equal(withCamera('  He looks up!  \n', slow), 'He looks up! The camera slowly dollies in.');
  assert.equal(withCamera('Will he look up?', slow), 'Will he look up? The camera slowly dollies in.');
  assert.equal(withCamera('He waits…', slow), 'He waits… The camera slowly dollies in.');
  // A quote or a bracket closed after its full stop; a sentence left open by a comma or a colon.
  assert.equal(withCamera('He says: "Come in."', slow), 'He says: "Come in." The camera slowly dollies in.');
  assert.equal(withCamera('Il dit « entrez »', slow), 'Il dit « entrez ». The camera slowly dollies in.');
  assert.equal(withCamera('A wide shot (dawn)', slow), 'A wide shot (dawn). The camera slowly dollies in.');
  assert.equal(withCamera('Le ponton, la brume, ', slow), 'Le ponton, la brume. The camera slowly dollies in.');
  assert.equal(withCamera('Plan large :', slow), 'Plan large. The camera slowly dollies in.');
  // No prompt: the sentence alone. No choice: the prompt as it was given, to the character.
  assert.equal(withCamera('', slow), 'The camera slowly dollies in.');
  assert.equal(withCamera('   ', slow), 'The camera slowly dollies in.');
  for (const none of [null, undefined, {}, { move: 'spin' }]) assert.equal(withCamera('  Le ponton, ', none), '  Le ponton, ');
  assert.equal(withCamera(undefined, null), '');
});

test('the camera is taken by LTX 2.5, Wan 2.2 and MiniMax H3 for a new video; the page is served its table, the server reads the same', async () => {
  // (0.6.221) MiniMax H3 with them: the camera by the words is a sentence of the prompt.
  assert.deepEqual([CAMERA_FAMILIES, CAMERA_VERBS], [['ltx25', 'wan22', 'minimax_h3'], ['create_video']]);
  assert.deepEqual(
    [['ltx25', 'create_video'], ['wan22', 'create_video'], ['ltx25', 'extend_video'], ['minimax_h3', 'create_video'], ['minimax_h3', 'extend_video'], ['wan_scail2', 'replace_character'], ['wan_scail2', 'create_video'], ['wan22_camera', 'create_video'], ['krea2', 'create_image'], [undefined, 'create_video']].map(
      ([family, verb]) => takesCamera(family, verb),
    ),
    [true, true, false, true, false, false, false, false, false, false],
  );
  // Those families exist in the engine under those names.
  for (const family of CAMERA_FAMILIES) assert.equal(JSON.parse(await readFile(new URL(`../runner/families/${family}.json`, import.meta.url), 'utf8')).mediaType ?? 'video', 'video', family);
  // One table: the page is served it, the server and the Studio import it, neither writes a sentence of its own.
  assert.match(await readFile(new URL('../server.mjs', import.meta.url), 'utf8'), /\['\/camera\.mjs', \['camera\.mjs',/);
  for (const name of ['../lib/tool-runtime.mjs', '../lib/tool-catalog.mjs', '../public/studio.mjs', '../public/assets-ui.mjs']) {
    const text = await readFile(new URL(name, import.meta.url), 'utf8');
    assert.match(text, /from '(\.\.\/public|\.)\/camera\.mjs'/, name);
    // (In a string of its code: its comments speak of the camera too.)
    assert.doesNotMatch(text, /['"`](The camera |Handheld camera)/, name + ' writes a sentence of the camera itself');
  }
});

test('(0.6.215) the movements by family, each with its short name: every movement of the list once', () => {
  // The window of the Studio shows them so: the family above, the short name under each small scene.
  assert.deepEqual(
    CAMERA_GROUPS.map(group => [group.name, group.moves.map(move => `${move}=${cameraShort(move)}`).join(' ')]),
    [
      ['Travelling', 'dolly_in=Avant dolly_out=Arrière truck_left=Gauche truck_right=Droite'],
      ['Zoom', 'zoom_in=Avant zoom_out=Arrière'],
      ['Panoramique', 'pan_left=Gauche pan_right=Droite tilt_up=Haut tilt_down=Bas'],
      ['Grue', 'crane_up=Montante crane_down=Descendante'],
      ['Orbite', 'orbit_left=Gauche orbit_right=Droite'],
      ['Sans déplacement', 'static=Fixe handheld=À l’épaule follow=Suivi'],
    ],
  );
  const shown = CAMERA_GROUPS.flatMap(group => group.moves);
  assert.deepEqual([...shown].sort(), CAMERA_MOVES.map(move => move.id).sort());
  assert.equal(new Set(shown).size, shown.length);
  // Six scenes a row: no family is wider, and a short name is never empty for a movement of the list.
  assert.ok(CAMERA_GROUPS.every(group => group.moves.length >= 2 && group.moves.length <= 4));
  assert.ok(CAMERA_MOVES.every(move => cameraShort(move.id).length > 0 && cameraShort(move.id).length <= 11));
  for (const none of [null, undefined, '', 'spin', 'toString', 'constructor']) assert.equal(cameraShort(none), '', String(none));
});

test('(0.6.222) the camera a model reads itself: its two settings, read back as a choice of the window', () => {
  // The three speeds of the window as the number such a model reads, and back to the nearest of the three.
  assert.deepEqual(['slow', 'normal', 'fast', 'warp', undefined].map(cameraSpeedValue), [0.5, 1, 2, 1, 1]);
  assert.deepEqual([0.25, 0.5, 0.74, 0.75, 1, 1.5, 1.51, 2, 4, undefined, 'x'].map(cameraSpeedName), ['slow', 'slow', 'slow', 'normal', 'normal', 'normal', 'fast', 'fast', 'fast', 'normal', 'normal']);
  for (const speed of ['slow', 'normal', 'fast']) assert.equal(cameraSpeedName(cameraSpeedValue(speed)), speed);
  // The sheet of a take: the settings of the model (an id, a number), or the choice kept beside its prompt.
  assert.deepEqual(cameraOf({ camera: 'orbit_left', camera_speed: 2 }), { move: 'orbit_left', speed: 'fast' });
  assert.deepEqual(cameraOf({ camera: 'crane_up' }), { move: 'crane_up', speed: 'normal' });
  assert.deepEqual(cameraOf({ camera: 'static', camera_speed: 0.5 }), { move: 'static', speed: 'normal' });
  assert.deepEqual(cameraOf({ camera: { move: 'dolly_in', speed: 'slow' }, camera_prompt: 'x' }), { move: 'dolly_in', speed: 'slow' });
  for (const none of [null, undefined, {}, { camera: 'none' }, { camera: 'spin' }, { camera: '' }, { camera: null }, { camera: 3 }, { camera_speed: 2 }]) assert.equal(cameraOf(none), null, JSON.stringify(none));
});

test('(0.6.257) the ball of the camera: the camera three quarters in front of the subject, the way of each movement, its drawing', async () => {
  // (camera-avant-maquette.md, K00 and K01; outil/gen_camera_avant.py, move_path and ball) The sphere of « Changer la
  // caméra » seen a little from above, in a view of 152 × 140: the subject at its middle, the camera at azimuth 50°.
  const { BALL_CAMERA, BALL_SUBJECT, BALL_SUBJECT_BOX, BALL_VIEW, ballSvg, ballWay } = await import('../public/camera-ball.mjs');
  assert.deepEqual(BALL_VIEW, { width: 152, height: 140 });
  assert.deepEqual(BALL_SUBJECT, [76, 70]);
  assert.deepEqual(BALL_CAMERA.map(value => Number(value.toFixed(2))), [122.51, 83.5]);
  assert.deepEqual(Object.values(BALL_SUBJECT_BOX).map(value => Number(value.toFixed(4))), [0.4079, 0.4357, 0.1842, 0.1286]);
  const distance = point => Math.hypot(point[0] - BALL_SUBJECT[0], point[1] - BALL_SUBJECT[1]),
    from = distance(BALL_CAMERA);
  // Along a line: a travelling nearer or farther, to the left or the right; a crane up or down.
  assert.ok(distance(ballWay('dolly_in').to) < from * 0.6 && distance(ballWay('dolly_out').to) > from * 1.4);
  assert.ok(ballWay('truck_left').to[0] < BALL_CAMERA[0] - 20 && ballWay('truck_right').to[0] > BALL_CAMERA[0] + 20);
  assert.deepEqual([ballWay('crane_up').to[1] - BALL_CAMERA[1], ballWay('crane_down').to[1] - BALL_CAMERA[1]].map(Math.round), [-36, 30]);
  // An orbit along the equator, from the camera; the hand that holds it; nothing for what turns or stays in place.
  const orbit = ballWay('orbit_left').points;
  assert.equal(orbit.length, 25);
  assert.deepEqual(orbit[0], BALL_CAMERA);
  assert.ok(orbit.every(point => Math.abs(((point[0] - 76) / (66 * 0.92)) ** 2 + ((point[1] - 70) / 21) ** 2 - 1) < 1e-9));
  assert.ok(ballWay('orbit_right').points.at(-1)[1] < BALL_SUBJECT[1], 'to the right it goes behind the subject');
  assert.deepEqual(ballWay('handheld'), { shake: true });
  for (const move of ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'tilt_up', 'tilt_down', 'static', 'follow', 'nothing']) assert.equal(ballWay(move), null, move);
  // Its drawing: the sphere alone for « Au choix du modèle »; for each movement, the camera and the way it goes.
  const none = ballSvg(null);
  assert.match(none, /^<svg class="camera-ball-art" viewBox="0 0 152 140" width="152" height="140" aria-hidden="true" focusable="false">/);
  assert.doesNotMatch(none, /camera-ball-(cam|line|head|cone)/);
  const { CAMERA_MOVES } = await import('../public/camera.mjs');
  for (const { id } of CAMERA_MOVES) {
    const drawn = ballSvg(id),
      way = ballWay(id);
    assert.match(drawn, new RegExp(`class="camera-ball-cam" data-way="${way?.to ? 'line' : way?.shake ? 'shake' : 'still'}"`), id);
    // Everything but a fixed shot draws its movement in the accent, which the styles draw in a loop (pathLength 1).
    if (id === 'static') assert.doesNotMatch(drawn, /camera-ball-line/);
    else assert.match(drawn, /class="camera-ball-line" d="M[^"]+" pathLength="1" fill="none" stroke="currentColor"/, id);
    // Where it goes along a line is where the camera is carried to.
    if (way?.to) assert.match(drawn, new RegExp(`data-dx="${(way.to[0] - BALL_CAMERA[0]).toFixed(1)}" data-dy="${(way.to[1] - BALL_CAMERA[1]).toFixed(1)}"`), id);
    // No style in its markup (the rules of security of the page refuse it: check-ui saw it) nor a variable in an
    // attribute (never read there).
    assert.doesNotMatch(drawn, / style=|var\(/, id);
  }
  // The page gives where the camera goes to the styles once the markup is in place.
  const { ballDress } = await import('../public/camera-ball.mjs'),
    set = {},
    holder = { querySelector: selector => (selector === '.camera-ball-cam' ? { dataset: { dx: '-20.9', dy: '-6.1' }, style: { setProperty: (key, value) => (set[key] = value) } } : null) };
  ballDress(holder);
  assert.deepEqual(set, { '--dx': '-20.9px', '--dy': '-6.1px' });
  ballDress({ querySelector: () => null });
  ballDress(null);
  // Its lines keep their width in pixels whatever its size; greyed, it is at 40 %.
  assert.match(ballSvg('dolly_in', { size: 76 }), /class="camera-ball-line"[^>]*stroke-width="3\.20"/);
  assert.match(ballSvg('dolly_in', { size: 304 }), /class="camera-ball-line"[^>]*stroke-width="0\.80"/);
  assert.match(ballSvg('orbit_left', { size: 70, dim: true }), /^<svg [^>]*width="70" height="64" [^>]*opacity="0\.4">/);
  assert.doesNotMatch(ballSvg('orbit_left', { size: 70 }), /opacity="0\.4"/);
  // The styles: the movement looped every 2,8 s, never for who asks for less motion; its menu opaque; nothing under 12 px.
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    part = css.slice(css.indexOf('/* ------------------------------------------------------------------ la caméra avant (0.6.257) */'));
  assert.ok(part.length > 1000);
  assert.match(part, /\.camera-ball\.is-playing:not\(\.is-dim\) \.camera-ball-line,\n\.camera-menu-option:is\(:hover, :focus-visible\):not\(\.is-off\) \.camera-ball-line \{\n  animation: camera-ball-draw 2\.8s infinite;/);
  assert.match(part, /\.camera-ball-cam\[data-way='line'\][^{]*\{\n  animation: camera-ball-go 2\.8s infinite;/);
  assert.match(part, /@keyframes camera-ball-go \{[\s\S]*?transform: translate\(var\(--dx\), var\(--dy\)\);/);
  assert.match(part, /@media \(prefers-reduced-motion: reduce\) \{\n  \.camera-ball \.camera-ball-line,[\s\S]*?animation: none !important;/);
  assert.match(part, /#studio-view \.glass-menu\.camera-menu \{[^}]*background: #121116;/);
  const sizes = [...part.matchAll(/font(?:-size)?: (?:\d+ )?([\d.]+)px/g)].map(found => Number(found[1]));
  assert.ok(sizes.length > 5 && sizes.every(size => size >= 12), JSON.stringify(sizes));
  // The page is served it, and the Studio draws with it.
  assert.match(await readFile(new URL('../server.mjs', import.meta.url), 'utf8'), /\['\/camera-ball\.mjs', \['camera-ball\.mjs',/);
  assert.match(await readFile(new URL('../public/studio.mjs', import.meta.url), 'utf8'), /from '\.\/camera-ball\.mjs'/);
});
