/**
 * A prompt written without seeing the images it is about is empty or wrong (a "wooden staircase"
 * for a stone one in the clouds). When a generation call passes reference images the model has
 * not looked at in this conversation, they are shown to it first; it then writes its call again.
 */
// (A character put in a video is not here: its prompt is written by the application itself,
// from the video and the image, see lib/scene-prompt.mjs. Sent back to look at them, the chat
// model answered « done » without generating.)
const GENERATORS = new Set(['create_image', 'create_video']);
// The name of an image the user joined, as the conversation keeps it: the digest of its file (lib/history.mjs).
const ORIGINAL = /^original-([0-9a-f]{64})\.(?:png|jpg|webp)$/;

/**
 * (0.6.460) The digests of the images joined to the last message the user wrote: the model sees them with it.
 * Each is the file the page kept as a reference of the project when it was joined, the same bytes (app.js,
 * addFiles): Resources.joined finds those references by their digest.
 */
export function joinedDigests(messages) {
  if (!Array.isArray(messages)) return [];
  const last = messages.findLast(message => message?.role === 'user' && !message.internal);
  if (!Array.isArray(last?.content)) return [];
  const digests = last.content.map(part => (part?.type === 'image_url' ? ORIGINAL.exec(part.file ?? '')?.[1] : null));
  return [...new Set(digests.filter(Boolean))];
}

/**
 * Active image resources this call passes and the conversation has never shown to the model. `joined`: the
 * ids of those joined to the user's last message (joinedDigests), shown to it with that message.
 */
export function unseenResources(messages, catalog, call, { joined = [] } = {}) {
  if (!Array.isArray(messages) || !GENERATORS.has(call?.function?.name)) return [];
  const passed = String(call.function.arguments ?? '');
  // The interface marks each image it shows with its resource; those copies last one turn, and
  // the result of the reading ("loaded", with the identifiers) stays in the conversation.
  // (0.6.460) And an image joined to the message: five joined to « fais-en dans ce genre » were said
  // never looked at, « you had not looked at these images yet », and shown again (27/11).
  const seen = new Set([...messages.map(message => message?.resourceId).filter(Boolean), ...joined]);
  const loaded = messages
    .filter(message => message?.role === 'tool' && typeof message.content === 'string')
    .map(message => message.content)
    .filter(text => /"status"\s*:\s*"(?:loaded|nothing_generated)"/.test(text));
  return catalog.filter(
    item =>
      item.type === 'image' &&
      passed.includes(item.id) &&
      !seen.has(item.id) &&
      !loaded.some(text => text.includes(item.id)),
  );
}

/** What the model reads with the images. */
export const SEEN_NOTE =
  'Nothing was generated: you had not looked at these images yet. They are shown below. Make your call again now, ' +
  'writing the prompt from what you actually see in them.';
