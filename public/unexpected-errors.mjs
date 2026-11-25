/**
 * An error nobody caught stops what the user asked for: said in a notice, discreetly, instead of a
 * button that does nothing (« Nouveau chat » stopped silently from 0.5.87 to 0.5.109). Not said:
 * a request given up on purpose (AbortError), the browser's own ResizeObserver note, an error of
 * another origin (an extension), or the same one again within 10 s. Written to the console too.
 */
const QUIET = /AbortError|ResizeObserver loop|The user aborted|The operation was aborted/i;

/**
 * (0.6.285) Whether an error was raised without passing through one of this page's scripts, as far as its
 * stack tells: it has frames, and none names a file of the page's origin. The script an extension of the
 * browser puts in the page is in this case, and a promise it lets fail has no file name to be told by: said
 * as ours, « Cannot read properties of undefined (reading 'M_ID') » came with every message, for a name
 * Moodix has nowhere. Without a stack or without a frame nothing is known: the error is said.
 */
export function elsewhere(error, origin) {
  if (!origin) return false;
  const lines = String(error?.stack ?? '').split('\n'),
    // Chromium: « Name: message », then « at … » lines. Firefox and Safari: « name@file:line:column » alone.
    named = lines.filter(line => /^\s*at\s/.test(line)),
    frames = named.length ? named : lines.filter(line => /@.*:\d+:\d+\s*$/.test(line));
  return frames.length > 0 && !frames.some(line => line.includes(origin));
}

export function unexpectedMessage(error) {
  const message = String(error?.message ?? error ?? '').trim();
  if (!message || QUIET.test(String(error?.name ?? '')) || QUIET.test(message)) return '';
  return 'Une action s’est arrêtée sur une erreur inattendue : ' + message;
}

export function setupUnexpectedErrors({ view = globalThis, notice, quiet = () => false, log = console.error, now = Date.now }) {
  let last = '',
    lastAt = 0;
  function tell(error) {
    const said = unexpectedMessage(error);
    // Leaving the page, updating or closing: what fails then is not the user's action.
    if (!said || quiet()) return;
    // (0.6.285) Raised by a script that is not this page's (see `elsewhere`): the browser's console has it.
    if (elsewhere(error, view.location?.origin)) return;
    if (said === last && now() - lastAt < 10000) return;
    last = said;
    lastAt = now();
    log(error);
    notice(said);
  }
  view.addEventListener?.('error', event => {
    // This page's scripts only.
    if (event.filename && view.location && !event.filename.startsWith(view.location.origin)) return;
    tell(event.error ?? event.message);
  });
  view.addEventListener?.('unhandledrejection', event => tell(event.reason));
  return { tell };
}
