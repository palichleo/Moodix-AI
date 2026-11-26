import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../public/stream.mjs';

const MIB = 1024 * 1024;
/** A response stream that gives `blocks` (texts) one after the other, then ends. */
const stream = blocks =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
/** The events of a stream read to its end. */
async function events(blocks) {
  const seen = [];
  await readSSE(stream(blocks), event => void seen.push(event));
  return seen;
}
const frame = n => `data: ${JSON.stringify({ n })}\n\n`;

test('an answer whose small frames came in one large block is read (0.6.407)', async () => {
  // The limit of a frame was read on all that had come at once, before any frame was taken out of it: more
  // than 2 MB of small frames in one block were refused (« Une trame de réponse dépasse la taille autorisée. »).
  let block = '';
  for (let n = 0; block.length < 2.1 * MIB; n++) block += frame(n);
  const count = block.split('\n\n').length - 1,
    seen = await events([block + 'data: [DONE]\n\n']);
  assert.equal(seen.length, count);
  assert.deepEqual([seen[0], seen.at(-1)], [{ n: 0 }, { n: count - 1 }]);
  // The same in pieces of 64 KiB, as it was read before.
  const pieces = [];
  for (let at = 0; at < block.length; at += 65536) pieces.push(block.slice(at, at + 65536));
  assert.equal((await events([...pieces, 'data: [DONE]\n\n'])).length, count);
});

test('a frame over the limit is still refused, whole in one block or never ended (0.6.407)', async () => {
  const large = `data: ${JSON.stringify({ text: 'x'.repeat(2.1 * MIB) })}\n\n`,
    refused = /Une trame de réponse dépasse la taille autorisée/;
  // Whole in what came at once: refused before it is read as an event.
  await assert.rejects(events([frame(1) + large + 'data: [DONE]\n\n']), refused);
  // Never ended, piece after piece: refused once it is over the limit, not kept for ever.
  const pieces = Array.from({ length: 40 }, () => 'x'.repeat(65536)),
    encoder = new TextEncoder();
  let read = 0;
  const endless = new ReadableStream({
    pull(controller) {
      if (read++ < pieces.length) controller.enqueue(encoder.encode(read === 1 ? 'data: "' : pieces[read - 2]));
      else controller.close();
    },
  });
  await assert.rejects(readSSE(endless, () => {}), refused);
  assert.ok(read < pieces.length, `stopped after ${read} pieces`);
  // Just under the limit, a frame is read.
  const under = Math.floor(1.9 * MIB),
    fits = `data: ${JSON.stringify({ text: 'x'.repeat(under) })}\n\n`;
  assert.equal((await events([fits + 'data: [DONE]\n\n']))[0].text.length, under);
});

test('an answer cut before its end says so, and an error of the engine is thrown as it is said', async () => {
  await assert.rejects(events([frame(1)]), /La connexion au moteur a été interrompue/);
  await assert.rejects(events(['data: {"error":"Modèle arrêté."}\n\n']), /Modèle arrêté\./);
  assert.deepEqual(await events([frame(1), 'data: [DONE]\n\n', frame(2)]), [{ n: 1 }]);
});
