import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

/**
 * The line under llama.cpp in Paramètres › Mise à jour › Composants, as the page follows an installation:
 * `installLlama` and `followLlama` cut out of public/app.js and run on what the server answers (`jobs`, one
 * answer of GET /api/llama after the other, the last one again once they are all given).
 */
async function line(jobs) {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    from = source.indexOf('async function installLlama() {'),
    to = source.indexOf('/** The versions of the programs Atelier runs on');
  assert.ok(from > 0 && to > from, 'installLlama and followLlama are where the test cuts them');
  const text = { textContent: '' },
    go = { hidden: true, textContent: '', onclick: null },
    asked = [];
  const context = vm.createContext({
    state: {},
    llamaLine: () => ({ text, go }),
    megabytes: bytes => `${bytes} o`,
    api: async (route, body) => {
      asked.push(body ? 'POST ' + route : 'GET ' + route);
      return { json: async () => (jobs.length > 1 ? jobs.shift() : jobs[0]) };
    },
    setTimeout: resolve => setImmediate(resolve),
  });
  vm.runInContext(source.slice(from, to) + '\nglobalThis.followLlama = followLlama;', context);
  return { text, go, asked, follow: () => context.followLlama() };
}

test('an installation of llama.cpp that stopped gives its button back, to ask again (0.6.398)', async () => {
  // « …s'est arrêtée là : relancez-la », said the line, its button hidden until the tab was opened again.
  const stopped = 'La connexion a été coupée pendant le téléchargement. L’installation s’est arrêtée là : relancez-la.',
    downloading = { state: 'downloading', step: 'Téléchargement…', received: 1, total: 2 };
  let page = await line([downloading, { state: 'error', error: stopped, ours: false }]);
  await page.follow();
  assert.equal(page.text.textContent, stopped);
  assert.deepEqual([page.go.hidden, page.go.textContent], [false, 'Installer']);
  // Clicked: the installation is asked again, the button hidden while it goes.
  page.asked.length = 0;
  await page.go.onclick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.asked[0], 'POST llama/install');
  // One of ours already in use: the button is the one of an update.
  page = await line([{ state: 'error', error: stopped, ours: true }]);
  await page.follow();
  assert.deepEqual([page.go.hidden, page.go.textContent], [false, 'Mettre à jour']);
});

test('while an installation of llama.cpp goes on, its button stays hidden', async () => {
  const page = await line([
    { state: 'downloading', step: 'Téléchargement…', received: 1, total: 2 },
    { state: 'trying', step: 'Essai…' },
    { state: 'error', error: 'Installation annulée.', ours: false },
  ]);
  const seen = [];
  Object.defineProperty(page.go, 'hidden', {
    get: () => seen.at(-1),
    set: value => void seen.push(value),
  });
  await page.follow();
  // Hidden at each step of the installation, shown once it has stopped.
  assert.deepEqual(seen, [true, true, true, false]);
});
