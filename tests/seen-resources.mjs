import test from 'node:test';
import assert from 'node:assert/strict';
import { SEEN_NOTE, joinedDigests, unseenResources } from '../lib/seen-resources.mjs';

const A = '3c037171-3a50-48bc-9705-9bcbfb223f6a',
  B = 'a34fed7a-57f5-49cc-a0bd-7955eb05d5d2';
const catalog = [
  { id: A, type: 'image', label: 'Ref 1', name: 'swing.png' },
  { id: B, type: 'image', label: 'Ref 2', name: 'stairs.png' },
  { id: 'v', type: 'video', label: 'Ref 3', name: 'clip.mp4' },
];
const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
const video = call('create_video', { prompt: 'x', start_image: { resource: A }, reference: [{ resource: B }] });

test('images passed to a generator and never looked at are shown to the model first', () => {
  const asked = [{ role: 'user', content: 'une vidéo avec la balançoire puis l’escalier' }];
  assert.deepEqual(
    unseenResources(asked, catalog, video).map(item => item.id),
    [A, B],
  );
  // Shown in this turn: the interface marks the images with their resource.
  const shown = [...asked, { role: 'user', internal: true, resourceId: A, content: [] }];
  assert.deepEqual(
    unseenResources(shown, catalog, video).map(item => item.id),
    [B],
  );
  // Read in an earlier turn: the result of the reading stays, the copies do not.
  const read = [
    ...asked,
    { role: 'tool', content: JSON.stringify({ status: 'loaded', resources: [{ id: A }, { id: B }] }) },
  ];
  assert.deepEqual(unseenResources(read, catalog, video), []);
  const shownFirst = [
    ...asked,
    { role: 'tool', content: JSON.stringify({ status: 'nothing_generated', resources: [{ id: A }, { id: B }] }) },
  ];
  assert.deepEqual(unseenResources(shownFirst, catalog, video), []);
  assert.match(SEEN_NOTE, /Nothing was generated/);
});

test('a character put in a video: the model is not sent back to look, the application sees for it', () => {
  const asked = [{ role: 'user', content: 'remplace la fille par ce personnage' }];
  const replace = call('replace_character', { prompt: 'x', source: { resource: 'v' }, reference: { resource: A } });
  assert.deepEqual(unseenResources(asked, catalog, replace), []);
});

test('nothing to show for a call without images, another tool, or no conversation', () => {
  const asked = [{ role: 'user', content: 'une vidéo' }];
  assert.deepEqual(unseenResources(asked, catalog, call('create_video', { prompt: 'x' })), []);
  assert.deepEqual(unseenResources(asked, catalog, call('upscale', { source: { resource: A } })), []);
  assert.deepEqual(unseenResources(undefined, catalog, video), []);
  assert.deepEqual(
    unseenResources(asked, catalog, call('create_image', { prompt: 'x', source: { resource: 'v' } })),
    [],
  );
});

test('an image joined to the user’s last message is under the eyes of the model: not shown again (0.6.460)', () => {
  // Five photos joined to « fais-en dans ce genre » (27/11): « you had not looked at these images yet ».
  const digest = 'ab'.repeat(32),
    image = file => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' }, file }),
    words = { type: 'text', text: 'une vidéo dans ce genre' },
    asked = [{ role: 'user', content: [words, image(`original-${digest}.png`)] }];
  assert.deepEqual(joinedDigests(asked), [digest]);
  // The references kept from them (Resources.joined, by that digest): seen with the message.
  assert.deepEqual(unseenResources(asked, catalog, video, { joined: [A] }).map(item => item.id), [B]);
  assert.deepEqual(unseenResources(asked, catalog, video, { joined: [A, B] }), []);
  // The digests of the last message the user wrote alone, each once; none from a name that is not an original.
  const again = { role: 'user', content: [image(`original-${digest}.jpg`), image(`original-${digest}.png`)] };
  assert.deepEqual(joinedDigests([...asked, { role: 'assistant', content: 'voilà' }, again]), [digest]);
  assert.deepEqual(joinedDigests([...asked, { role: 'user', content: 'une autre' }]), []);
  assert.deepEqual(joinedDigests([...asked, { role: 'user', internal: true, content: [image('x')] }]), [digest]);
  assert.deepEqual(joinedDigests([{ role: 'user', content: [image('copie.png'), image(undefined)] }]), []);
  assert.deepEqual(joinedDigests(undefined), []);
});
