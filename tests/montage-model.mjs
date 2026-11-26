import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MONTAGE_LIMITS,
  STILL_SECONDS,
  clock,
  creationOf,
  holeAt,
  linkOf,
  montageSeconds,
  placed,
  planAt,
  planStarts,
  shownSeconds,
  snapped,
  takeSeconds,
  trackOf,
  usualSize,
  withEndPulled,
  withItemChanged,
  withPhoto,
  withPlanMoved,
  withPlanPlaced,
  withTake,
  withTodoDrawn,
  withTodoMade,
  withoutItem,
} from '../public/montage-model.mjs';
import { newMontage, validateMontage } from '../lib/montages.mjs';

// (0.6.137) What a hand does to a montage on the timeline of the Studio (public/montage.mjs), written
// once for the page and the server: every change gives a montage the server takes as it is.
const C = '11111111-1111-4111-8111-111111111111',
  id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const record = (n, mediaType, more = {}) => ({ id: id(n), conversationId: C, mediaType, outputs: [{ take: n }], parameters: {}, ...more });
const clip = (n, seconds) => record(n, 'video', { workflowName: 'Wan 2.2', parameters: { frames: seconds * 16, fps: 16 } });
const empty = () => newMontage({ id: id(900), now: '2026-11-20T03:00:00.000Z' });
const kept = montage => validateMontage(montage);

test('a creation goes where its kind belongs: a clip or an image on the plans, a sound on its track (0.6.137)', () => {
  assert.deepEqual(
    [clip(1, 5), record(2, 'image'), record(3), record(4, 'audio', { workflowName: 'Musique (ACE-Step 1.5 XL)' }), record(5, 'audio', { workflowName: 'Bruitages (MOSS-SoundEffect v2)', parameters: { seconds: 6 } }), record(6, 'audio', { parameters: { seconds: 45 } })].map(trackOf),
    ['video', 'image', 'image', 'music', 'effects', 'music'],
  );
  assert.deepEqual([takeSeconds(clip(1, 5)), takeSeconds(record(5, 'audio', { parameters: { seconds: 6 } })), takeSeconds(record(2, 'image'))], [5, 6, null]);
  let montage = withTake(empty(), clip(1, 5), { id: id(11) });
  montage = withTake(montage, record(2, 'image'), { id: id(12) });
  montage = withTake(montage, record(4, 'audio', { workflowName: 'Musique', parameters: { seconds: 30 } }), { id: id(13) });
  montage = withTake(montage, record(5, 'audio', { workflowName: 'Bruitages', parameters: { seconds: 6 } }), { id: id(14), at: 2.26 });
  // A clip whole, an image for a few seconds; the music lower than a sound effect, each where it is laid.
  // (0.6.149) Each at its instant: by default at the end of the bobine.
  assert.deepEqual(montage.plans, [
    { id: id(11), at: 0, source: { conversationId: C, runId: id(1), output: 0 }, kind: 'video', from: 0, to: 5, frame: 'fit', volume: 1 },
    { id: id(12), at: 5, source: { conversationId: C, runId: id(2), output: 0 }, kind: 'image', from: 0, to: STILL_SECONDS, frame: 'fit' },
  ]);
  assert.deepEqual(montage.sounds.map(({ track, at, to, volume }) => [track, at, to, volume]), [['music', 0, 30, 0.6], ['effects', 2.26, 6, 1]]);
  assert.deepEqual(kept(montage).plans, montage.plans, 'the server takes it as it is');
  assert.deepEqual(kept(montage).sounds, montage.sounds);
  // Laid between two plans, or before the first: it takes the place of the one there, which goes later
  // with what touches it; the same take may be laid twice.
  const between = withTake(montage, clip(7, 2), { id: id(15), index: 1 });
  assert.deepEqual(between.plans.map(plan => [plan.id, plan.at]), [[id(11), 0], [id(15), 5], [id(12), 7]]);
  assert.deepEqual(withTake(between, clip(1, 5), { id: id(16), index: 0 }).plans.map(plan => [plan.source.runId, plan.at]), [[id(1), 0], [id(1), 5], [id(7), 10], [id(2), 12]]);
  // (0.6.149) Laid at an instant: on a plan, before it on its first half, after it on its second; in
  // the void after the bobine, where it is laid (a hole stays before it), or against the end within `near`.
  assert.deepEqual(withTake(montage, clip(7, 2), { id: id(15), at: 2 }).plans.map(plan => [plan.id, plan.at]), [[id(15), 0], [id(11), 2], [id(12), 7]]);
  assert.deepEqual(withTake(montage, clip(7, 2), { id: id(15), at: 3 }).plans.map(plan => [plan.id, plan.at]), [[id(11), 0], [id(15), 5], [id(12), 7]]);
  assert.deepEqual(withTake(montage, clip(7, 2), { id: id(15), at: 11 }).plans.map(plan => plan.at), [0, 5, 11]);
  assert.deepEqual(withTake(montage, clip(7, 2), { id: id(15), at: 8.2, near: 0.3 }).plans.map(plan => plan.at), [0, 5, 8]);
  // A clip whose length nobody knows is laid for a few seconds; a full montage takes nothing more.
  assert.equal(withTake(empty(), record(8, 'video'), { id: id(17) }).plans[0].to, STILL_SECONDS);
  const full = { ...empty(), plans: Array.from({ length: MONTAGE_LIMITS.plans }, (_, n) => ({ id: id(n + 1) })) };
  assert.equal(withTake(full, clip(1, 5), { id: id(999) }), full);
  assert.equal(empty().plans.length, 0, 'the montage handed over is never changed in place');
  // (0.6.141) A clip continued is laid whole, and its end can be pulled back to where its file ends:
  // 121 frames continued by 232 play 14,71 s (« montage ne voit que 10 secondes », 20/11: the 241
  // frames it generated).
  const continuation = { overlapFrames: 9, sourceFrames: 121, newFrames: 232 };
  const continued = record(9, 'video', { parameters: { frames: 241, fps: 24, continuation } });
  assert.equal(takeSeconds(continued), 14.708);
  const laid = withTake(empty(), continued, { id: id(18) });
  assert.equal(laid.plans[0].to, 14.708);
  const cut = withItemChanged(laid, id(18), { to: 10 }, { longest: takeSeconds(continued) });
  assert.equal(withItemChanged(cut, id(18), { to: 99 }, { longest: takeSeconds(continued) }).plans[0].to, 14.708);
  assert.deepEqual(kept(laid).plans, laid.plans);
});

test('plans follow one another: their starts, the one under the head, the length of the film (0.6.137)', () => {
  let montage = empty();
  for (const [n, seconds] of [[1, 5], [2, 3], [3, 4]]) montage = withTake(montage, clip(n, seconds), { id: id(10 + n) });
  assert.deepEqual([planStarts(montage), montageSeconds(montage)], [[0, 5, 8], 12]);
  assert.deepEqual([0, 4.99, 5, 7.5, 8, 11.9, 12, 99].map(at => planAt(montage, at).index), [0, 0, 1, 1, 2, 2, 2, 2]);
  assert.deepEqual([planAt(montage, 6).start, planAt(montage, 6).plan.id], [5, id(12)]);
  assert.equal(planAt(empty(), 0), null);
  // Moved one place earlier or later; at an end it stays, as an unknown one does.
  assert.deepEqual(withPlanMoved(montage, id(13), -1).plans.map(plan => [plan.id, plan.at]), [[id(11), 0], [id(13), 5], [id(12), 9]]);
  assert.deepEqual(withPlanMoved(montage, id(11), 1).plans.map(plan => [plan.id, plan.at]), [[id(12), 0], [id(11), 3], [id(13), 8]]);
  for (const [which, step] of [[id(11), -1], [id(13), 1], [id(99), 1]]) assert.equal(withPlanMoved(montage, which, step), montage);
  // (0.6.149) Dragged along the timeline so that it starts at an instant, read on the bobine as it was
  // when it was pressed: lifted, those that touched it come back to where it was, then laid there.
  // On a plan, before it on its first half and after it on its second; in the void, where it is.
  const placedAt = (which, at, options) => withPlanPlaced(montage, which, at, options).plans.map(plan => [plan.id, plan.at]);
  // (Pressed and moved a little, it stays where it is: the same bobine.)
  for (const [which, at] of [[id(11), 0.08], [id(11), 1.4], [id(12), 5.2], [id(99), 3]]) assert.equal(withPlanPlaced(montage, which, at), montage, which + ' at ' + at);
  // (The last one, in the void after the others: moved, a hole before it.)
  assert.deepEqual(placedAt(id(13), 8.3), [[id(11), 0], [id(12), 5], [id(13), 8.3]]);
  // (Lifted, 12 is at 0 to 3: past its middle, 11 goes after it.)
  assert.deepEqual(placedAt(id(11), 1.6), [[id(12), 0], [id(11), 3], [id(13), 8]]);
  assert.deepEqual(placedAt(id(13), 0), [[id(13), 0], [id(11), 4], [id(12), 9]]);
  // In the void after the bobine: where it is laid, a hole before it; against its end within `near`.
  assert.deepEqual(placedAt(id(11), 9), [[id(12), 0], [id(13), 3], [id(11), 9]]);
  assert.deepEqual(placedAt(id(11), 7.3, { near: 0.5 }), [[id(12), 0], [id(13), 3], [id(11), 7]]);
  // A sound dragged near a cut of the film (5 s, 8 s), near its start (0) or its end (12), starts on
  // it; else where it is, to the tenth of a second, never before the film. How near: the timeline says.
  assert.deepEqual([0.15, 4.85, 5.15, 5.26, 7.9, 11.85, 12.1, 3.14, -2].map(at => snapped(montage, at)), [0, 5, 5, 5.3, 8, 12, 12, 3.1, 0]);
  assert.deepEqual([4.6, 5.45, 5.57].map(at => snapped(montage, at, 0.5)), [5, 5, 5.6]);
  assert.deepEqual([4.96, 4.94].map(at => snapped(montage, at, 0.05)), [5, 4.9]);
  // Taken out: those that touched it come back to where it was.
  const without = withoutItem(montage, id(12));
  assert.deepEqual([without.plans.map(plan => plan.id), planStarts(without), montageSeconds(without)], [[id(11), id(13)], [0, 5], 9]);
});

test('a bobine may have holes: black in the film; what touches a plan follows it, what is beyond a hole stays (0.6.149)', () => {
  let montage = empty();
  for (const [n, seconds] of [[1, 5], [2, 3], [3, 4]]) montage = withTake(montage, clip(n, seconds), { id: id(10 + n) });
  // The last one dragged to 14 s: a hole from 8 to 14 s; the bobine ends with it.
  const holed = withPlanPlaced(montage, id(13), 14);
  assert.deepEqual([planStarts(holed), montageSeconds(holed)], [[0, 5, 14], 18]);
  assert.deepEqual([4, 8, 10, 13.9, 14, 17.9, 18].map(at => planAt(holed, at)?.index ?? null), [0, null, null, null, 2, 2, 2]);
  assert.deepEqual([holeAt(holed, 9), holeAt(holed, 6), holeAt(holed, 20), holeAt(empty(), 3)], [{ from: 8, to: 14 }, null, { from: 18, to: Infinity }, { from: 0, to: Infinity }]);
  // A sound stops on the cuts on both sides of the hole.
  assert.deepEqual([8.1, 13.85, 18.1].map(at => snapped(holed, at)), [8, 14, 18]);
  // The first made shorter: the second, which touches it, follows; the third, beyond the hole, stays.
  const shorter = withItemChanged(holed, id(11), { to: 4 }, { longest: 5 });
  assert.deepEqual(planStarts(shorter), [0, 4, 14]);
  // Made longer than the hole is wide, what it reaches is pushed only as far as it must be.
  const cut = withItemChanged(montage, id(12), { to: 1 }, { longest: 3 });
  assert.deepEqual(planStarts(cut), [0, 5, 6]);
  const apart = withPlanPlaced(cut, id(13), 6.5);
  assert.deepEqual(planStarts(apart), [0, 5, 6.5]);
  assert.deepEqual(planStarts(withItemChanged(apart, id(12), { to: 3 }, { longest: 3 })), [0, 5, 8]);
  // Its start cut: one that touches what is before it keeps its place and ends earlier (those after it
  // follow); one after a hole keeps its end, its start moves, never into the plan before it.
  assert.deepEqual(planStarts(withItemChanged(holed, id(12), { from: 1 }, { longest: 3 })), [0, 5, 14]);
  assert.deepEqual(withItemChanged(holed, id(12), { from: 1 }, { longest: 3 }).plans[1].to, 3);
  assert.deepEqual(withItemChanged(montage, id(12), { from: 1 }, { longest: 3 }).plans.map(plan => plan.at), [0, 5, 7]);
  const later = withItemChanged(holed, id(13), { from: 1 }, { longest: 4 });
  assert.deepEqual([later.plans[2].at, later.plans[2].from, montageSeconds(later)], [15, 1, 18]);
  const near = withPlanPlaced(withItemChanged(montage, id(13), { from: 3 }, { longest: 4 }), id(13), 10);
  assert.deepEqual(near.plans[2].at, 10);
  const back = withItemChanged(near, id(13), { from: 0 }, { longest: 4 });
  assert.deepEqual([back.plans[2].at, back.plans[2].from], [8, 1]);
  // Taken out: those that touched it come back to where it was; beyond the hole, nothing moves.
  assert.deepEqual(planStarts(withoutItem(holed, id(12))), [0, 14]);
  assert.deepEqual(planStarts(withoutItem(holed, id(11))), [0, 14]);
  // A video dragged takes with it the suite to create joined after it: it goes on from it.
  const suited = { ...montage, plans: [montage.plans[0], { id: id(20), at: 5, kind: 'video', todo: { prompt: '', suite: true }, from: 0, to: 2, frame: 'fit', volume: 1 }, { ...montage.plans[1], at: 7 }] };
  const dragged = withPlanPlaced(suited, id(11), 12);
  assert.deepEqual(dragged.plans.map(plan => [plan.id, plan.at]), [[id(12), 0], [id(11), 12], [id(20), 17]]);
  assert.equal(linkOf(dragged, id(20), wanted => (wanted.runId === id(1) ? 5 : null)).kind, 'suite');
  // The server keeps the instants as they are; a plan over the one before it is pushed after it.
  assert.deepEqual(kept(holed).plans, holed.plans);
  assert.deepEqual(kept({ ...holed, plans: holed.plans.map((plan, at) => (at === 2 ? { ...plan, at: 6 } : plan)) }).plans.map(plan => plan.at), [0, 5, 8]);
});

test('a take to create drawn in a hole stays there, and never goes on from what is around it (0.6.149)', () => {
  // (« Elle reste où on l'a dessinée, sans se coller à la fin […]. Une prise dessinée ne continue jamais
  // ce qui est avant ou après, même collée à une vidéo : elle part de son texte, ou de ses photos. »)
  const film = withTake(empty(), clip(1, 5), { id: id(11) }),
    lengthOf = wanted => (wanted.runId === id(1) ? 5 : null);
  const { montage, chosen } = withTodoDrawn(film, { id: id(20), at: 8, seconds: 4 });
  assert.deepEqual([chosen, planStarts(montage), montageSeconds(montage)], [id(20), [0, 8], 12]);
  assert.deepEqual(montage.plans[1], { id: id(20), kind: 'video', todo: { prompt: '' }, from: 0, to: 4, frame: 'fit', volume: 1, at: 8 });
  assert.deepEqual(holeAt(montage, 6), { from: 5, to: 8 });
  // Drawn against the end of the video, it touches it and still starts from its own text.
  const glued = withTodoDrawn(film, { id: id(21), at: 5, seconds: 3 }).montage,
    written = withItemChanged(glued, id(21), { prompt: 'Il se lève.' });
  assert.deepEqual(linkOf(written, id(21), lengthOf), { kind: 'own' });
  assert.deepEqual(creationOf(written, id(21), lengthOf), { verb: 'create_video', prompt: 'Il se lève.', duration: 3, format: '16:9', from: 0 });
  // Only a suite pulled from the video goes on from it.
  assert.equal(linkOf({ ...written, plans: [written.plans[0], { ...written.plans[1], todo: { prompt: 'Il se lève.', suite: true } }] }, id(21), lengthOf).kind, 'suite');
  // From a second to a minute (0.6.152: longer than its model makes, it is made in parts); drawn over a
  // plan, it goes after it.
  assert.deepEqual([9, 40, 90].map(seconds => withTodoDrawn(film, { id: id(22), at: 9, seconds }).montage.plans[1].to), [9, 40, 60]);
  assert.equal(withTodoDrawn(film, { id: id(22), at: 9, seconds: 0.3 }).montage.plans[1].to, 1);
  assert.deepEqual(planStarts(withTodoDrawn(film, { id: id(22), at: 3, seconds: 2 }).montage), [0, 5]);
  assert.deepEqual(planStarts(withTodoDrawn(empty(), { id: id(22), at: 2, seconds: 5 }).montage), [2]);
  const full = { ...empty(), plans: Array.from({ length: MONTAGE_LIMITS.plans }, (_, n) => ({ ...film.plans[0], id: id(n + 100), at: n * 5 })) };
  assert.deepEqual(withTodoDrawn(full, { id: id(22), at: 2000 }), { montage: full, reason: 'Cette bobine est pleine.' });
  assert.deepEqual(kept(montage).plans, montage.plans);
});

test('a bobine kept before 0.6.149 is read end to end, the continuations it made said as suites (0.6.149)', () => {
  // (Its plans had no instant: they followed one another; a plan to make without a start photo right
  // after a video or another plan to make went on from it.)
  const todo = (n, seconds, more = {}) => ({ id: id(n), kind: 'video', todo: { prompt: '' }, from: 0, to: seconds, frame: 'fit', volume: 1, ...more }),
    video = withTake(empty(), clip(1, 5), { id: id(11) }).plans[0],
    still = withTake(empty(), record(2, 'image'), { id: id(12) }).plans[0],
    { at: _video, ...oldVideo } = video,
    { at: _still, ...oldStill } = still;
  const old = { ...empty(), plans: [oldVideo, todo(13, 2), todo(14, 2), oldStill, todo(15, 2), todo(16, 2, { photos: { start: { conversationId: C, runId: id(2), output: 0 } } })] };
  const read = placed(old);
  assert.deepEqual(planStarts(read), [0, 5, 7, 9, 12, 14]);
  assert.deepEqual(read.plans.map(plan => plan.todo?.suite ?? null), [null, true, true, null, null, null]);
  assert.deepEqual(kept(old).plans, read.plans, 'the server reads it the same');
  // Read once: the same bobine after.
  assert.equal(placed(read), read);
  assert.equal(placed(empty()).plans.length, 0);
});

test('what is kept of a take stays within the take, and never shorter than a tenth of a second (0.6.137)', () => {
  let montage = withTake(empty(), clip(1, 5), { id: id(11) });
  montage = withTake(montage, record(2, 'image'), { id: id(12) });
  montage = withTake(montage, record(4, 'audio', { workflowName: 'Musique', parameters: { seconds: 30 } }), { id: id(13) });
  const plan = (changes, options) => withItemChanged(montage, id(11), changes, options).plans[0];
  assert.deepEqual([plan({ from: 1, to: 4 }).from, plan({ from: 1, to: 4 }).to], [1, 4]);
  // Its end never beyond the take, its start never after its end; a tenth of a second at least.
  assert.equal(plan({ to: 9 }, { longest: 5 }).to, 5);
  assert.equal(plan({ from: 7 }).from, 4.9);
  assert.equal(plan({ to: 0 }).to, 0.1);
  assert.equal(plan({ from: -3 }).from, 0);
  assert.deepEqual([plan({ frame: 'fill' }).frame, plan({ frame: 'stretch' }).frame], ['fill', 'fit']);
  assert.deepEqual([plan({ volume: 0.5 }).volume, plan({ volume: 9 }).volume, plan({ volume: -1 }).volume], [0.5, 2, 0]);
  // An image has a length and a frame, no start and no sound of its own.
  const still = changes => withItemChanged(montage, id(12), changes).plans[1];
  assert.deepEqual([still({ to: 8 }).to, still({ from: 2 }).from, still({ volume: 0.5 }).volume, still({ to: 9999 }).to], [8, 0, undefined, 600]);
  // A sound moves in the film, never before its start; it has no frame.
  const sound = changes => withItemChanged(montage, id(13), changes).sounds[0];
  assert.deepEqual([sound({ at: 4.26 }).at, sound({ at: -2 }).at, sound({ frame: 'fill' }).frame, sound({ volume: 0.3 }).volume], [4.26, 0, undefined, 0.3]);
  // Every change gives a montage the server keeps as it is; the one changed is left as it was.
  const changed = withItemChanged(withItemChanged(montage, id(11), { from: 0.5, to: 2.75, frame: 'fill', volume: 0 }), id(13), { at: 1.5, volume: 0.25 });
  assert.deepEqual(kept(changed).plans, changed.plans);
  assert.deepEqual(kept(changed).sounds, changed.sounds);
  assert.equal(montage.plans[0].to, 5);
  assert.equal(withItemChanged(montage, id(99), { to: 1 }).plans[0], montage.plans[0]);
});

test('a length rounded up to the next minute is said with it, never « 1 min 60 s » (0.6.280)', () => {
  assert.deepEqual([60.04, 119.4, 119.6].map(shownSeconds), ['1 min 00 s', '1 min 59 s', '2 min 00 s']);
});

test('the times of a montage, as a clock and as seconds (0.6.137)', () => {
  assert.deepEqual([0.5, 2.06, 14, 59.96, 65, 600].map(shownSeconds), ['0,5 s', '2,1 s', '14 s', '1 min 00 s', '1 min 05 s', '10 min 00 s']);
  assert.deepEqual([0, 6.9, 59.99, 61, 754].map(clock), ['00:00', '00:06', '00:59', '01:01', '12:34']);
  assert.deepEqual([usualSize('16:9'), usualSize('9:16'), usualSize('1:1'), usualSize('7:5')], [{ width: 1344, height: 768 }, { width: 768, height: 1344 }, { width: 1024, height: 1024 }, null]);
});

test('dragged near two cuts or two neighbours, a sound or a plan goes to the nearest, not the first met (0.6.343)', () => {
  // Cuts at 0, 5, 10 and 15 s; on a long bobine, the 8 pixels of the timeline are 4 s or more.
  let montage = empty();
  for (const n of [1, 2, 3]) montage = withTake(montage, clip(n, 5), { id: id(10 + n) });
  assert.deepEqual([9, 6, 7.5, 14.2, 20].map(at => snapped(montage, at, 4.4)), [10, 5, 5, 15, 20]);
  // A hole from 10 to 14 s: a clip of 1 s let go at 12.6 s goes against the plan after it (0.4 s away),
  // not against the one before it (2.6 s away); let go at 10.5 s, against the one before it.
  let holed = withTake(empty(), clip(1, 10), { id: id(11) });
  holed = withPlanPlaced(withTake(holed, clip(2, 5), { id: id(12) }), id(12), 14);
  holed = withTake(holed, clip(3, 5), { id: id(13) });
  const laid = at => withTake(holed, clip(4, 1), { id: id(14), at, near: 3 }).plans.map(plan => [plan.id, plan.at]);
  assert.deepEqual(laid(12.6), [[id(11), 0], [id(14), 13], [id(12), 14], [id(13), 19]]);
  assert.deepEqual(laid(10.5), [[id(11), 0], [id(14), 10], [id(12), 14], [id(13), 19]]);
  // The same for a plan of the bobine dragged into the hole.
  const moved = withPlanPlaced(withTake(holed, clip(4, 1), { id: id(14) }), id(14), 12.6, { near: 3 });
  assert.deepEqual(moved.plans.map(plan => [plan.id, plan.at]), [[id(11), 0], [id(14), 13], [id(12), 14], [id(13), 19]]);
});

test('a take laid after a video goes after the suites to create glued behind it, as a dragged block (0.6.437)', () => {
  // (Z6-13) V, the suite to create S pulled from its end, then W. A clip or an image let go on the second half of
  // V went between V and S: S went on from that clip instead of V, or from an image, from nothing at all.
  const lengthOf = wanted => ({ [id(1)]: 5, [id(2)]: 4, [id(7)]: 3 })[wanted.runId] ?? null,
    places = laid => laid.plans.map(plan => [plan.id, plan.at]);
  let montage = withTake(empty(), clip(1, 5), { id: id(11) });
  montage = withEndPulled(montage, id(11), 8, { longest: 5, suiteId: id(40) });
  montage = withTake(withItemChanged(montage, id(40), { prompt: 'Il court.' }), clip(2, 4), { id: id(12) });
  assert.deepEqual(places(montage), [[id(11), 0], [id(40), 5], [id(12), 8]]);
  // On the second half of V, or on the first half of S: after S, which still goes on from V.
  for (const [taken, at] of [[clip(7, 3), 4], [record(8, 'image'), 4], [clip(7, 3), 5.5]]) {
    const laid = withTake(montage, taken, { id: id(50), at, near: 0.3 });
    assert.deepEqual(places(laid), [[id(11), 0], [id(40), 5], [id(50), 8], [id(12), 11]], `laid at ${at} s`);
    assert.deepEqual(linkOf(laid, id(40), lengthOf), { kind: 'suite', before: 1, whole: 5 });
    assert.deepEqual(kept(laid).plans, laid.plans);
  }
  // W dragged there comes back where it was; on the first half of V, before it, V and S pushed together.
  assert.equal(withPlanPlaced(montage, id(12), 4, { near: 0.3 }), montage);
  const before = withTake(montage, clip(7, 3), { id: id(50), at: 1 });
  assert.deepEqual(places(before), [[id(50), 0], [id(11), 3], [id(40), 8], [id(12), 11]]);
  // A suite of that suite goes along too.
  const [video, suite, next] = montage.plans,
    chained = { ...montage, plans: [video, suite, { ...suite, id: id(42), at: 8 }, { ...next, at: 11 }] };
  assert.deepEqual(places(withTake(chained, clip(7, 3), { id: id(50), at: 4 })), [
    [id(11), 0],
    [id(40), 5],
    [id(42), 8],
    [id(50), 11],
    [id(12), 14],
  ]);
  // A take to create drawn against V is no suite: it goes on from nothing, and the clip goes between them.
  const drawn = withTodoDrawn(withTake(empty(), clip(1, 5), { id: id(11) }), { id: id(41), at: 5, seconds: 3 }).montage;
  assert.deepEqual(places(withTake(drawn, clip(7, 3), { id: id(50), at: 4 })), [[id(11), 0], [id(50), 5], [id(41), 8]]);
});

// (0.6.438) Two takes of 5 s, a sound on their cut (the second's), one 2 s into the second, one 3 s into the first,
// one after the end of the film.
const effect = n => record(n, 'audio', { workflowName: 'Bruitages', parameters: { seconds: 2 } });
function heard() {
  let montage = withTake(withTake(empty(), clip(1, 5), { id: id(11) }), clip(2, 5), { id: id(12) });
  for (const [n, at] of [[13, 5], [14, 7], [15, 3], [16, 12]])
    montage = withTake(montage, effect(n), { id: id(n), at });
  return montage;
}
const soundsOf = montage => montage.sounds.map(sound => sound.at);

test('a sound stays with the take it starts under when the takes move and it is not touched (0.6.438)', () => {
  // (Z6-14) A sound on a cut (a door shut on the join of two takes) was left behind as soon as a take was laid
  // before it, or made shorter, dragged, taken out: 3 s too early once a take of 3 s was laid first.
  const montage = heard();
  assert.deepEqual(soundsOf(montage), [5, 7, 3, 12]);
  // A take of 3 s laid first, the first made shorter, the second moved before it or after a hole.
  const laid = withTake(montage, clip(7, 3), { id: id(17), at: 0.5 });
  assert.deepEqual(soundsOf(laid), [8, 10, 6, 12]);
  assert.deepEqual(soundsOf(withItemChanged(montage, id(11), { to: 4 }, { longest: 5 })), [4, 6, 3, 12]);
  assert.deepEqual(soundsOf(withPlanMoved(montage, id(12), -1)), [0, 2, 8, 12]);
  assert.deepEqual(soundsOf(withPlanPlaced(montage, id(12), 8)), [8, 10, 3, 12]);
  // Its take taken out, a sound keeps its instant, never after the end of the film.
  assert.deepEqual(soundsOf(withoutItem(montage, id(11))), [0, 2, 3, 12]);
  assert.deepEqual(soundsOf(withoutItem(montage, id(12))), [5, 5, 3, 12]);
  // A sound the hand moves goes where it is put; the server keeps them as they are.
  assert.deepEqual(soundsOf(withItemChanged(montage, id(14), { at: 6 })), [5, 6, 3, 12]);
  assert.deepEqual(kept(laid).sounds, laid.sounds);
});

test('a sound follows its take moved by a suite, a take to create, a take made or an image laid (0.6.438)', () => {
  // (Z6-14) Every change of the model that moves the takes moves what starts under them as far.
  const montage = heard(),
    cut = changed => soundsOf(changed)[0];
  // The suite pulled from the end of the first take, a take to create drawn over the second: 3 s before it.
  assert.equal(cut(withEndPulled(montage, id(11), 8, { longest: 5, suiteId: id(40) })), 8);
  assert.equal(cut(withTodoDrawn(montage, { id: id(41), at: 5, seconds: 3 }).montage), 8);
  // A take to create of 5 s before it, made in 3 s.
  const todo = withTodoDrawn(montage, { id: id(41), at: 5, seconds: 5 }).montage;
  assert.deepEqual([cut(todo), cut(withTodoMade(todo, id(41), clip(30, 3)))], [10, 8]);
  // One of 10 s made in two parts: a sound 7 s into it stays 7 s into the take, the first part of 4 s made.
  const long = withTake(withItemChanged(todo, id(41), { to: 10 }), effect(18), { id: id(18), at: 12 }),
    limits = { create_video: 5, extend_video: 5 },
    parts = withTodoMade(long, id(41), clip(30, 4), { limits, partId: id(42) });
  assert.deepEqual([parts.plans[1].id, soundsOf(long).at(-1), soundsOf(parts).at(-1)], [id(42), 12, 12]);
  // An image let go in a hole too short for a take makes one of 5 s there, which pushes the second take.
  const holed = withPlanPlaced(montage, id(12), 5.5);
  assert.equal(cut(holed), 5.5);
  assert.equal(cut(withPhoto(holed, record(9, 'image'), 5.2, { id: id(43) }).montage), 10);
});
