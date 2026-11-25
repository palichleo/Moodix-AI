import assert from 'node:assert/strict';
import test from 'node:test';
import { elsewhere, setupUnexpectedErrors, unexpectedMessage } from '../public/unexpected-errors.mjs';

const ORIGIN = 'http://127.0.0.1:8787';
/** An error as the browser hands it: its stack names the scripts it passed through, not this test's file. */
const raised = (error, ...frames) =>
  Object.assign(error, {
    stack: [`${error.name}: ${error.message}`, ...frames.map(frame => '    at ' + frame)].join('\n'),
  });
const ours = error => raised(error, `sendMessage (${ORIGIN}/app.js:3478:12)`);

test('an error raised by a script that is not the page’s is not said as one of Moodix (0.6.285)', () => {
  const listeners = {},
    said = [];
  let clock = 0;
  const view = { location: { origin: ORIGIN }, addEventListener: (type, handler) => (listeners[type] = handler) };
  setupUnexpectedErrors({ view, notice: text => said.push(text), log: () => {}, now: () => (clock += 20000) });
  const told = () =>
    said.splice(0).map(text => text.replace('Une action s’est arrêtée sur une erreur inattendue : ', ''));
  const lost = () => new TypeError("Cannot read properties of undefined (reading 'M_ID')");
  const theirs = 'r.handle (chrome-extension://abcdef/inpage.js:1:2345)';

  // What a friend saw with every message: the promise of an extension's script, put in the page, let fail.
  listeners.unhandledrejection({ reason: raised(lost(), theirs) });
  listeners.unhandledrejection({ reason: raised(lost(), '<anonymous>:3:9', 'new Promise (<anonymous>)') });
  listeners.unhandledrejection({
    reason: Object.assign(lost(), { stack: 'handle@moz-extension://abcdef/inpage.js:1:2345\n' }),
  });
  // The same through the « error » event, which has no file name for a script put in the page.
  listeners.error({ error: raised(lost(), theirs), filename: '' });
  assert.deepEqual(told(), []);

  // Ours as soon as one frame is one of the page's scripts, whatever called it or was called by it.
  const mixed = raised(lost(), 'JSON.parse (<anonymous>)', `api (${ORIGIN}/app.js:120:9)`, `wrapped (${theirs})`);
  listeners.unhandledrejection({ reason: mixed });
  listeners.unhandledrejection({
    reason: raised(new Error('une suite'), `async refresh (${ORIGIN}/studio.mjs:7609:5)`),
  });
  listeners.unhandledrejection({
    reason: Object.assign(new Error('renard'), { stack: `send@${ORIGIN}/app.js:10:5\n` }),
  });
  assert.deepEqual(told(), ["Cannot read properties of undefined (reading 'M_ID')", 'une suite', 'renard']);

  // Nothing known of where it comes from: said, as before.
  listeners.unhandledrejection({ reason: Object.assign(new Error('sans pile'), { stack: undefined }) });
  listeners.unhandledrejection({
    reason: Object.assign(new Error('en-tête seul'), { stack: 'Error: en-tête seul' }),
  });
  listeners.unhandledrejection({ reason: Object.assign(new Error('a@b.fr:25'), { stack: 'Error: a@b.fr:25' }) });
  listeners.unhandledrejection({ reason: 'un texte' });
  listeners.error({ message: 'Script error.', filename: '' });
  assert.deepEqual(told(), ['sans pile', 'en-tête seul', 'a@b.fr:25', 'un texte', 'Script error.']);

  // A page without an address (a test, a file opened by hand) tells nothing apart.
  assert.equal(elsewhere(raised(lost(), 'x (chrome-extension://abcdef/inpage.js:1:1)'), undefined), false);
  assert.equal(elsewhere(raised(lost(), 'x (chrome-extension://abcdef/inpage.js:1:1)'), ORIGIN), true);
  // Another port of the same machine is another application.
  assert.equal(elsewhere(raised(lost(), 'x (http://127.0.0.1:8790/app.js:1:1)'), ORIGIN), true);
});

test('an error nobody caught is said once, in plain words; a request given up on purpose is not', () => {
  const listeners = {},
    said = [],
    logged = [];
  let clock = 0,
    leaving = false;
  const view = {
    location: { origin: 'http://127.0.0.1:8787' },
    addEventListener: (type, handler) => (listeners[type] = handler),
  };
  setupUnexpectedErrors({ view, notice: text => said.push(text), quiet: () => leaving, log: error => logged.push(error), now: () => clock });
  const broken = ours(new TypeError('workflowsUI.reset is not a function'));
  listeners.error({ error: broken, filename: 'http://127.0.0.1:8787/app.js' });
  assert.deepEqual(said, ['Une action s’est arrêtée sur une erreur inattendue : workflowsUI.reset is not a function']);
  assert.deepEqual(logged, [broken]);
  // The same again at once: said once.
  clock = 5000;
  listeners.error({ error: broken, filename: 'http://127.0.0.1:8787/app.js' });
  assert.equal(said.length, 1);
  clock = 16000;
  listeners.unhandledrejection({ reason: broken });
  assert.equal(said.length, 2);
  // Not ours, or not an error of the user's action.
  listeners.error({ error: new Error('extension'), filename: 'chrome-extension://abc/content.js' });
  listeners.unhandledrejection({ reason: Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }) });
  listeners.error({ message: 'ResizeObserver loop completed with undelivered notifications.' });
  leaving = true;
  listeners.unhandledrejection({ reason: new Error('Failed to fetch') });
  assert.equal(said.length, 2);
  assert.equal(unexpectedMessage(''), '');
  assert.equal(unexpectedMessage('Plain'), 'Une action s’est arrêtée sur une erreur inattendue : Plain');
});
