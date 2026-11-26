import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server.mjs';

test('préférences par défaut, choix enregistré et restauré après redémarrage', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-preferences-'));
  let app;
  try {
    app = await createApplication({ port: 0, dataDir });
    let initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.deepEqual(initial.preferences, { saveHistory: true });
    const response = await fetch(`${app.url}/api/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveHistory: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { preferences: { saveHistory: false } });
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')), { saveHistory: false });
    await app.close();
    app = await createApplication({ port: 0, dataDir });
    initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.equal(initial.preferences.saveHistory, false);
    const back = await fetch(`${app.url}/api/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveHistory: true }),
    });
    assert.equal(back.status, 200);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')).saveHistory, true);
    assert.deepEqual((await (await fetch(`${app.url}/api/bootstrap`)).json()).config, initial.config);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('les préférences refusent les écritures sans jeton et les valeurs invalides', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-preferences-'));
  let app;
  try {
    await writeFile(join(dataDir, 'preferences.json'), '{"saveHistory":false}');
    app = await createApplication({ port: 0, dataDir });
    const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const request = (body, token = initial.token) =>
      fetch(`${app.url}/api/preferences`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await request({ saveHistory: true }, '')).status, 401);
    // (0.6.434) The theme among them: the Jour mode is gone, a page of before cannot set it again.
    for (const invalid of [null, {}, { theme: 'light' }, { saveHistory: 'oui' }, { saveHistory: 0 }]) {
      assert.equal((await request(invalid)).status, 400);
    }
    assert.equal(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')).saveHistory, false);
    assert.equal((await (await fetch(`${app.url}/api/bootstrap`)).json()).preferences.saveHistory, false);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('un fichier de préférences endommagé revient aux préférences par défaut', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-preferences-'));
  try {
    for (const contents of ['{', '{"saveHistory":"oui"}']) {
      await writeFile(join(dataDir, 'preferences.json'), contents);
      const app = await createApplication({ port: 0, dataDir });
      try {
        assert.deepEqual((await (await fetch(`${app.url}/api/bootstrap`)).json()).preferences, { saveHistory: true });
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('les réglages d’interface (salle, grain…) sont relus au redémarrage et gardés quand une autre préférence change', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-interface-'));
  const room = { room: 'lavande', light: 'discret', grain: 'film', dose: 75, motion: 'fige', filters: ['centre'] };
  let app;
  try {
    app = await createApplication({ port: 0, dataDir });
    let initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    const save = (body, token) =>
      fetch(`${app.url}/api/preferences`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const kept = (await (await save({ room }, initial.token)).json()).preferences.room;
    // Ce que le serveur en retient (ce qui est valide), et ce n'est pas la salle par défaut.
    assert.equal(kept.room, 'lavande');
    assert.deepEqual([kept.light, kept.grain, kept.dose, kept.motion], ['discret', 'film', 75, 'fige']);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')).room, kept);
    // Au redémarrage : la même salle (elle revenait aux réglages par défaut).
    await app.close();
    app = await createApplication({ port: 0, dataDir });
    initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.deepEqual(initial.preferences.room, kept);
    // Une autre préférence enregistrée ensuite ne l'efface pas du fichier.
    const changed = await save({ saveHistory: false }, initial.token);
    assert.equal(changed.status, 200);
    assert.deepEqual((await changed.json()).preferences.room, kept);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')).room, kept);
    // Un fichier dont la salle est abîmée : ses valeurs valides, le reste par défaut, jamais un refus de démarrer.
    await app.close();
    await writeFile(join(dataDir, 'preferences.json'), JSON.stringify({ theme: 'dark', saveHistory: true, room: { room: 'inconnue', dose: 'beaucoup', grain: 'gros' } }));
    app = await createApplication({ port: 0, dataDir });
    initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    assert.deepEqual([initial.preferences.room.room, initial.preferences.room.grain, initial.preferences.room.dose], ['salle', 'gros', 40]);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('(0.6.434) un fichier qui nomme encore le mode Jour : l’apparence par défaut, sans erreur ni avis', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'atelier-preferences-'));
  let app;
  try {
    // Written by a version that had it, the history turned off.
    await writeFile(join(dataDir, 'preferences.json'), JSON.stringify({ theme: 'light', saveHistory: false }, null, 2));
    app = await createApplication({ port: 0, dataDir });
    const initial = await (await fetch(`${app.url}/api/bootstrap`)).json();
    // The rest of the file is read; of the theme nothing is kept, and nothing is said.
    assert.deepEqual(initial.preferences, { saveHistory: false });
    assert.equal(initial.warning, '');
    assert.doesNotMatch(await (await fetch(app.url)).text(), /data-theme/);
    // The next preference saved writes the file without it.
    const saved = await fetch(`${app.url}/api/preferences`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${initial.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ saveHistory: true }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'preferences.json'), 'utf8')), { saveHistory: true });
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
