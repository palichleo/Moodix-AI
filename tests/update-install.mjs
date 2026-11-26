import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tarball, sourceEntries } from './fixtures/update-archive.mjs';
import * as module from '../lib/update-install.mjs';
const sha = '1234567890abcdef1234567890abcdef12345678';

test('preparation pins the download to a commit and stages sources without replacing the running app', async t => {
  assert.equal(typeof module.prepareUpdate, 'function');
  const root = await mkdtemp(join(tmpdir(), 'atelier-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'scripts'));
  await cp(project + '/lib/update-files.mjs', join(root, 'lib/update-files.mjs'));
  await cp(project + '/lib/update-archive.mjs', join(root, 'lib/update-archive.mjs'));
  await cp(project + '/scripts/apply-update.mjs', join(root, 'scripts/apply-update.mjs'));
  await writeFile(join(root, 'server.mjs'), 'old server');
  await mkdir(join(root, 'runner'));
  await writeFile(join(root, 'runner/pyproject.toml'), 'old requirements');
  await writeFile(join(root, 'runner/uv.lock'), 'old lock');
  const urls = [];
  const plan = await module.prepareUpdate({
    root,
    version: '0.3.0',
    currentVersion: '0.2.0',
    port: 8787,
    fetchUpdate: async (url, options) => {
      urls.push(url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.body, undefined);
      return urls.length === 1
        ? new Response(sha)
        : new Response(
            tarball([
              ...sourceEntries,
              { name: 'repo/runner/pyproject.toml', text: 'new requirements' },
              { name: 'repo/runner/uv.lock', text: 'new lock' },
            ]),
          );
    },
  });
  assert.deepEqual(urls, [
    'https://api.github.com/repositories/1449534927/commits/main',
    `https://codeload.github.com/palichleo/Moodix-AI/tar.gz/${sha}`,
  ]);
  assert.equal(await readFile(join(root, 'server.mjs'), 'utf8'), 'old server');
  assert.equal(await readFile(join(root, 'runner/pyproject.toml'), 'utf8'), 'old requirements');
  assert.equal(await readFile(join(root, 'runner/uv.lock'), 'utf8'), 'old lock');
  assert.equal(await readFile(join(plan.workspace, 'stage/runner/pyproject.toml'), 'utf8'), 'new requirements');
  assert.equal(await readFile(join(plan.workspace, 'stage/runner/uv.lock'), 'utf8'), 'new lock');
  assert.equal(await readFile(join(plan.workspace, 'stage/server.mjs'), 'utf8'), 'export const version="0.3.0";');
  assert.equal(JSON.parse(await readFile(join(plan.workspace, 'plan.json'), 'utf8')).version, '0.3.0');
  assert.ok(plan.workspace.startsWith(join(root, 'data/updates')));
});

test('invalid commit metadata or obsolete versions never stage or install sources', async t => {
  assert.equal(typeof module.prepareUpdate, 'function');
  const root = await mkdtemp(join(tmpdir(), 'atelier-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const commit of ['../escape', 'https://attacker.test', 'z'.repeat(40), ''])
    await assert.rejects(
      module.prepareUpdate({
        root,
        version: '0.3.0',
        currentVersion: '0.2.0',
        port: 8787,
        fetchUpdate: async () => new Response(commit),
      }),
    );
  await assert.rejects(
    module.prepareUpdate({
      root,
      version: '0.1.0',
      currentVersion: '0.2.0',
      port: 8787,
      fetchUpdate: async () => {
        assert.fail('Must not download an obsolete version');
      },
    }),
  );
  assert.deepEqual(await readdir(root), []);
});

test('main moved between the check and the click: the version downloaded is the one installed (0.5.129)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atelier-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'scripts'));
  await cp(project + '/lib/update-files.mjs', join(root, 'lib/update-files.mjs'));
  await cp(project + '/lib/update-archive.mjs', join(root, 'lib/update-archive.mjs'));
  await cp(project + '/scripts/apply-update.mjs', join(root, 'scripts/apply-update.mjs'));
  const published = version => async url =>
    url.includes('/commits/')
      ? new Response(sha)
      : new Response(
          tarball(
            sourceEntries.map(entry =>
              entry.name === 'repo/package.json' ? { ...entry, text: entry.text.replace('"0.3.0"', `"${version}"`) } : entry,
            ),
          ),
        );
  // Announced 0.3.0 when the application started; 0.4.0 pushed since.
  const plan = await module.prepareUpdate({ root, version: '0.3.0', currentVersion: '0.2.0', port: 8787, fetchUpdate: published('0.4.0') });
  assert.equal(plan.version, '0.4.0');
  assert.equal(JSON.parse(await readFile(join(plan.workspace, 'plan.json'), 'utf8')).version, '0.4.0');
  // What is on GitHub is not newer than what is installed: said, nothing staged.
  await rm(join(root, 'data'), { recursive: true, force: true });
  await assert.rejects(
    module.prepareUpdate({ root, version: '0.3.0', currentVersion: '0.2.0', port: 8787, fetchUpdate: published('0.2.0') }),
    /La version publiée sur GitHub \(v0\.2\.0\) n’est pas plus récente que celle installée \(v0\.2\.0\)/,
  );
  assert.deepEqual((await readdir(root)).sort(), ['lib', 'scripts']);
});


test('the folders of the updates before go, but the last one and the one a failure says it kept (0.6.392)', async t => {
  // Each kept the sources of the version it replaced, 10 MB more at every update, and none was ever removed.
  const { utimes } = await import('node:fs/promises');
  const data = await mkdtemp(join(tmpdir(), 'atelier-installs-')),
    updates = join(data, 'updates');
  t.after(() => rm(data, { recursive: true, force: true }));
  // No update ever: nothing to do.
  assert.deepEqual(await module.pruneInstalls(data), []);
  const made = async (name, age) => {
    await mkdir(join(updates, name, 'backup'), { recursive: true });
    await writeFile(join(updates, name, 'backup', 'server.mjs'), 'sources of before');
    const at = new Date(Date.now() - age * 1000);
    await utimes(join(updates, name), at, at);
  };
  await made('install-aaa111', 3000);
  await made('install-bbb222', 2000);
  await made('install-ccc333', 1000);
  // Not its own: the folder of a rescue update, a name that only looks like one, a file.
  await made('rescue-ddd444', 4000);
  await made('install-with.dot', 4000);
  await writeFile(join(updates, 'install-file'), 'not a folder');
  const others = ['install-file', 'install-with.dot', 'rescue-ddd444'];
  // The last update failed, and says where it kept the version of before: that folder stays too.
  const kept = `Redémarrage impossible. La sauvegarde est conservée dans ${join(updates, 'install-aaa111')}. EPERM`;
  await writeFile(join(data, 'update-status.json'), JSON.stringify({ state: 'error', error: kept }));
  assert.deepEqual(await module.pruneInstalls(data), ['install-bbb222']);
  assert.deepEqual((await readdir(updates)).sort(), ['install-aaa111', 'install-ccc333', ...others]);
  // Once an update went well, only the last folder stays, as it was.
  await writeFile(join(data, 'update-status.json'), JSON.stringify({ state: 'done', error: kept }));
  assert.deepEqual(await module.pruneInstalls(data), ['install-aaa111']);
  assert.deepEqual((await readdir(updates)).sort(), ['install-ccc333', ...others]);
  assert.equal(await readFile(join(updates, 'install-ccc333', 'backup', 'server.mjs'), 'utf8'), 'sources of before');
  assert.deepEqual(await module.pruneInstalls(data), []);
});
