// The most a frame of an answer may weigh.
const LARGEST = 2 * 1024 * 1024;

export async function readSSE(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let complete = false;
  const consume = async () => {
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      // (0.6.407) The limit of a frame, read on that frame: it was read on all that had come at once, before
      // any frame was taken out of it, and more than 2 MB of small frames in one block were refused.
      if (frame.length > LARGEST) throw new Error('Une trame de réponse dépasse la taille autorisée.');
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        complete = true;
        return;
      }
      const event = JSON.parse(data);
      if (event.error)
        throw new Error(typeof event.error === 'string' ? event.error : event.error.message || 'Erreur du moteur.');
      await onEvent(event);
    }
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      await consume();
      // What is left is one frame that has not ended yet.
      if (buffer.length > LARGEST) throw new Error('Une trame de réponse dépasse la taille autorisée.');
      if (done) break;
    }
    if (!complete) throw new Error('La connexion au moteur a été interrompue. La réponse reçue est conservée.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
