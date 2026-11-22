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
  cameraOff,
  cameraSentence,
  cameraShort,
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

test('the camera is taken by LTX 2.5 and Wan 2.2 for a new video; the page is served its table, the server reads the same', async () => {
  assert.deepEqual([CAMERA_FAMILIES, CAMERA_VERBS], [['ltx25', 'wan22'], ['create_video']]);
  assert.deepEqual(
    [['ltx25', 'create_video'], ['wan22', 'create_video'], ['ltx25', 'extend_video'], ['minimax_h3', 'create_video'], ['wan_scail2', 'replace_character'], ['krea2', 'create_image'], [undefined, 'create_video']].map(
      ([family, verb]) => takesCamera(family, verb),
    ),
    [true, true, false, false, false, false, false],
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
