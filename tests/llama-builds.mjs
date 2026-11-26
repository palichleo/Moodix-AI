import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LlamaBuilds,
  RELEASES,
  candidates,
  cudaOf,
  detectDevice,
  latestRelease,
  parseAsset,
} from '../lib/llama-builds.mjs';
import { held, twice } from './fixtures/held-renames.mjs';

// The files of the nightly release b12110 (4 November 2026), as GitHub lists them.
const NAMES = [
  'llama-b12110-bin-win-cpu-x64.zip',
  'llama-b12110-bin-win-cpu-arm64.zip',
  'llama-b12110-bin-win-cuda-12.4-x64.zip',
  'llama-b12110-bin-win-cuda-13.4-x64.zip',
  'llama-b12110-bin-win-cuda-13.4-arm64.zip',
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'llama-b12110-bin-win-vulkan-x64.zip',
  'llama-b12110-bin-win-vulkan-arm64.zip',
  'llama-b12110-bin-win-rocm-10.0-x64.zip',
  'llama-b12110-bin-win-sycl-x64.zip',
  'llama-b12110-bin-win-openvino-2026.4.1-x64.zip',
  'llama-b12110-bin-win-opencl-adreno-arm64.zip',
  'llama-b12110-bin-ubuntu-x64.tar.gz',
  'llama-b12110-bin-ubuntu-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-26.04-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-zdnn-s390x.tar.gz',
  'llama-b12110-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b12110-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'llama-b12110-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'cudart-llama-b12110-bin-ubuntu-cuda-13.4-arm64.tar.gz',
  'llama-b12110-bin-ubuntu-rocm-10.0-x64.tar.gz',
  'llama-b12110-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b12110-bin-ubuntu-openvino-2026.4.1-x64.tar.gz',
  'llama-b12110-bin-linux-arm64-snapdragon.tar.gz',
  'llama-b12110-bin-macos-arm64.tar.gz',
  'llama-b12110-bin-macos-x64.tar.gz',
  'llama-b12110-xcframework.zip',
  'llama-b12110-bin-android-arm64.tar.gz',
  'llama-b12110-ui.tar.gz',
];
const ASSETS = NAMES.map(name => ({ name, size: 100, url: 'https://files/' + name, sha256: '' }));
const ids = (device, assets = ASSETS) => candidates(device, assets).map(item => item.id);

test('the files of a llama.cpp release are read by pattern: system, processor, backend and its version', () => {
  assert.deepEqual(parseAsset('llama-b12110-bin-win-cuda-13.4-x64.zip'), {
    kind: 'llama',
    build: 'b12110',
    platform: 'win32',
    backend: 'cuda',
    version: '13.4',
    variant: '',
    arch: 'x64',
  });
  assert.equal(parseAsset('llama-b12110-bin-ubuntu-x64.tar.gz').backend, 'cpu');
  assert.equal(parseAsset('llama-b12110-bin-win-cpu-arm64.zip').arch, 'arm64');
  assert.equal(parseAsset('llama-b12110-bin-macos-arm64.tar.gz').platform, 'darwin');
  assert.equal(parseAsset('llama-b12110-bin-ubuntu-sycl-fp16-x64.tar.gz').variant, 'fp16');
  assert.deepEqual(parseAsset('cudart-llama-bin-win-cuda-12.4-x64.zip'), {
    kind: 'cudart',
    platform: 'win32',
    backend: 'cuda',
    version: '12.4',
    arch: 'x64',
  });
  assert.equal(parseAsset('cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz').platform, 'linux');
  // Other processors, Android, iOS, a version of Ubuntu, backends not offered: none of them.
  for (const name of [
    'llama-b12110-bin-ubuntu-s390x.tar.gz',
    'llama-b12110-bin-ubuntu-26.04-s390x.tar.gz',
    'llama-b12110-bin-linux-arm64-snapdragon.tar.gz',
    'llama-b12110-bin-android-arm64.tar.gz',
    'llama-b12110-xcframework.zip',
    'llama-b12110-ui.tar.gz',
    'llama-b12110-bin-win-openvino-2026.4.1-x64.zip',
    'llama-b12110-bin-win-opencl-adreno-arm64.zip',
    'nightly-tag.txt',
  ])
    assert.equal(parseAsset(name), null, name);
});

test('the CUDA a driver takes is read in both ways nvidia-smi writes it', () => {
  assert.deepEqual(cudaOf('| NVIDIA-SMI 610.88   KMD Version: 610.88   CUDA UMD Version: 13.3 |'), [13, 3]);
  assert.deepEqual(cudaOf('| NVIDIA-SMI 581.57   Driver Version: 581.57   CUDA Version: 13.0 |'), [13, 0]);
  assert.equal(cudaOf('nothing'), null);
});

test('each computer gets its builds, the best first, the processor alone last', () => {
  const nvidia = (computeCap, cuda) => ({ vendor: 'nvidia', name: 'card', computeCap, cuda });
  // This machine: an RTX 4070 SUPER (8.9) whose driver takes CUDA 13.3.
  const here = candidates({ platform: 'win32', arch: 'x64', gpus: [nvidia(8.9, [13, 3])] }, ASSETS);
  assert.deepEqual(
    here.map(item => item.id),
    ['cuda-13.4', 'cuda-12.4', 'vulkan', 'cpu'],
  );
  // CUDA comes with its libraries; it must see the card to count.
  assert.deepEqual(
    here[0].files.map(file => file.name),
    ['llama-b12110-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip'],
  );
  assert.equal(here[0].expect, 'CUDA');
  assert.equal(here.at(-1).expect, null);
  // A GTX 1080 (6.1): CUDA 13 no longer serves it. An older driver: CUDA 12 only.
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(6.1, [13, 0])] }), [
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(8.6, [12, 8])] }), [
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  // The newest cards (Blackwell, 12.0) take CUDA 13 first; two cards, the oldest decides.
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(12.0, [13, 4])] }), [
    'cuda-13.4',
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [nvidia(8.9, [13, 3]), nvidia(6.1, [13, 3])] }), [
    'cuda-12.4',
    'vulkan',
    'cpu',
  ]);
  // AMD and Intel: Vulkan, which works almost everywhere; no card: the processor.
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [{ vendor: 'amd', name: 'Radeon' }] }), [
    'vulkan',
    'cpu',
  ]);
  assert.deepEqual(ids({ platform: 'win32', arch: 'x64', gpus: [] }), ['cpu']);
  assert.deepEqual(ids({ platform: 'win32', arch: 'arm64', gpus: [] }), ['cpu']);
  // Linux, its own CUDA versions and libraries.
  const linux = candidates({ platform: 'linux', arch: 'x64', gpus: [nvidia(8.6, [13, 0])] }, ASSETS);
  assert.deepEqual(
    linux.map(item => item.id),
    ['cuda-13.4', 'cuda-12.8', 'vulkan', 'cpu'],
  );
  assert.equal(linux[1].files[1].name, 'cudart-llama-b12110-bin-ubuntu-cuda-12.8-x64.tar.gz');
  assert.deepEqual(ids({ platform: 'linux', arch: 'arm64', gpus: [] }), ['cpu']);
  assert.deepEqual(ids({ platform: 'linux', arch: 'x64', gpus: [{ vendor: 'intel', name: 'card0' }] }), [
    'vulkan',
    'cpu',
  ]);
  // A Mac: one build, Metal on Apple Silicon.
  const mac = candidates({ platform: 'darwin', arch: 'arm64', gpus: [{ vendor: 'apple' }] }, ASSETS);
  assert.deepEqual(
    [mac.length, mac[0].id, mac[0].expect, mac[0].files[0].name],
    [1, 'metal', 'Metal', 'llama-b12110-bin-macos-arm64.tar.gz'],
  );
  assert.deepEqual(ids({ platform: 'darwin', arch: 'x64', gpus: [] }), ['cpu']);
});

test('the cards of this computer: NVIDIA with its generation and driver, the others by their maker', async () => {
  const run = async (command, args) =>
    command === 'nvidia-smi'
      ? args.length
        ? { code: 0, output: 'NVIDIA GeForce RTX 4070 SUPER, 8.9\n' }
        : { code: 0, output: '| NVIDIA-SMI 610.88  KMD Version: 610.88  CUDA UMD Version: 13.3 |' }
      : {
          code: 0,
          output:
            'NVIDIA|NVIDIA GeForce RTX 4070 SUPER\r\nIntel Corporation|Intel(R) UHD Graphics 770\r\nMicrosoft|Microsoft Basic Display Adapter\r\n',
        };
  const device = await detectDevice({ platform: 'win32', arch: 'x64', run });
  assert.deepEqual(device.gpus, [
    { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', computeCap: 8.9, cuda: [13, 3] },
    { vendor: 'intel', name: 'Intel(R) UHD Graphics 770' },
  ]);
  // Linux reads the makers of its cards from /sys. Without nvidia-smi (Debian ships it apart from the driver),
  // an NVIDIA card counts all the same (0.6.396), without its generation or the CUDA of its driver.
  const linux = await detectDevice({
    platform: 'linux',
    arch: 'x64',
    run: async () => null,
    listDir: async () => ['card0', 'card0-DP-1', 'card1', 'renderD128'],
    readText: async path => (path.includes('card1') ? '0x10de\n' : '0x1002\n'),
  });
  assert.deepEqual(linux.gpus, [
    { vendor: 'amd', name: 'card0' },
    { vendor: 'nvidia', name: 'card1', computeCap: null, cuda: null },
  ]);
});

/** A GitHub that answers with the stable release, its pointer, then the nightly one. */
function github(files) {
  const assets = Object.entries(files).map(([name, bytes]) => ({
    name,
    size: bytes.length,
    browser_download_url: 'https://files/' + name,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  }));
  const asked = [];
  const fetchImpl = async (url, options = {}) => {
    asked.push([url, options.headers?.Range ?? '']);
    if (url === RELEASES + '/latest')
      return Response.json({
        tag_name: 'v0.9.0',
        assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://files/nightly-tag.txt' }],
      });
    if (url === 'https://files/nightly-tag.txt') return new Response('b12110\n');
    if (url === RELEASES + '/tags/b12110') return Response.json({ tag_name: 'b12110', assets });
    const name = url.replace('https://files/', '');
    if (files[name]) return new Response(files[name]);
    return new Response('', { status: 404 });
  };
  return { fetchImpl, asked };
}

test('the stable release names the nightly one that has the files: it is followed', async () => {
  const { fetchImpl } = github({ 'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu') });
  const release = await latestRelease({ fetchImpl });
  assert.equal(release.tag, 'b12110');
  assert.equal(release.assets[0].name, 'llama-b12110-bin-win-cpu-x64.zip');
  assert.match(release.assets[0].sha256, /^[0-9a-f]{64}$/);
});

test('a build that does not see the card gives way to the next; the one kept is ready to start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const { fetchImpl } = github({
    'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.from('cuda 13'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart 13'),
    'llama-b12110-bin-win-cuda-12.4-x64.zip': Buffer.from('cuda 12'),
    'cudart-llama-bin-win-cuda-12.4-x64.zip': Buffer.from('cudart 12'),
    'llama-b12110-bin-win-vulkan-x64.zip': Buffer.from('vulkan'),
    'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu'),
  });
  // Unpacked: the program at the top, the CUDA libraries in a folder of their own.
  const unpack = async (archive, destination) => {
    if (archive.includes('cudart')) {
      await mkdir(join(destination, 'bin'), { recursive: true });
      await writeFile(join(destination, 'bin', 'cudart64.dll'), 'dll');
    } else await writeFile(join(destination, 'llama-server.exe'), 'exe');
  };
  // The CUDA builds start but do not see the card (no driver here): Vulkan does.
  const run = async (command, args) =>
    args[0] === '--list-devices'
      ? {
          code: 0,
          output: command.includes('vulkan')
            ? 'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11071 MiB free)\n'
            : 'Available devices:\n',
        }
      : null;
  const builds = new LlamaBuilds({
    root,
    fetchImpl,
    run,
    unpack,
    platform: 'win32',
    arch: 'x64',
    env: { PATH: 'C:\\Windows' },
    detect: async () => ({
      platform: 'win32',
      arch: 'x64',
      gpus: [{ vendor: 'nvidia', name: 'RTX', computeCap: 8.9, cuda: [13, 3] }],
    }),
  });
  try {
    const kept = await builds.install();
    assert.equal(kept.id, 'vulkan');
    assert.equal(kept.tag, 'b12110');
    assert.equal(kept.enginePath, join(root, 'b12110-vulkan', 'llama-server.exe'));
    assert.deepEqual(kept.devices, ['Vulkan0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11071 MiB free)']);
    assert.ok(builds.owns(kept.enginePath));
    assert.equal(builds.owns('C:\\Ollama\\llama-server.exe'), false);
    const status = builds.status();
    assert.equal(status.state, 'done');
    assert.deepEqual(
      status.tried.map(item => item.label),
      ['CUDA 13.4', 'CUDA 12.4'],
    );
    assert.match(status.tried[0].reason, /ne voit pas la carte/);
    // What did not work takes no room; the downloads are gone once unpacked.
    assert.deepEqual((await readdir(root)).sort(), ['b12110-vulkan', 'downloads']);
    assert.deepEqual(await readdir(join(root, 'downloads')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the CUDA libraries land beside the program, and a file that does not match its fingerprint is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const files = {
    'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.from('cuda 13'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart 13'),
    'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu'),
  };
  const { fetchImpl } = github(files);
  // The processor build was altered on the way (same size): its fingerprint no longer matches.
  const altered = async (url, options) => (url.endsWith('cpu-x64.zip') ? new Response('CPU') : fetchImpl(url, options));
  const unpack = async (archive, destination) => {
    if (archive.includes('cudart')) {
      await mkdir(join(destination, 'bin'), { recursive: true });
      await writeFile(join(destination, 'bin', 'cudart64_13.dll'), 'dll');
    } else {
      await mkdir(join(destination, 'build', 'bin'), { recursive: true });
      await writeFile(join(destination, 'build', 'bin', 'llama-server.exe'), 'exe');
    }
  };
  const run = async () => ({
    code: 0,
    output: 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB)\n',
  });
  const builds = new LlamaBuilds({
    root,
    fetchImpl: altered,
    run,
    unpack,
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({
      platform: 'win32',
      arch: 'x64',
      gpus: [{ vendor: 'nvidia', computeCap: 8.9, cuda: [13, 3] }],
    }),
  });
  try {
    const kept = await builds.install();
    assert.equal(kept.id, 'cuda-13.4');
    const folder = join(root, 'b12110-cuda-13.4', 'build', 'bin');
    assert.ok((await stat(join(folder, 'cudart64_13.dll'))).isFile(), 'the library beside llama-server.exe');
    // Asked alone, the processor build is refused for its fingerprint.
    const only = new LlamaBuilds({
      root,
      fetchImpl: altered,
      run,
      unpack,
      platform: 'win32',
      arch: 'x64',
      env: {},
      detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [] }),
    });
    await assert.rejects(only.install(), /empreinte différente/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a llama.cpp just downloaded or unpacked that Windows holds a moment (an antivirus reading it) takes its place once let go', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const { fetchImpl: served } = github({
    'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.from('cuda 13'),
    'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.from('cudart 13'),
  });
  // The step said as each archive is asked for (0.6.88: « en attente » stayed through the next one).
  const asking = [];
  const fetchImpl = (url, options) => {
    if (/\.zip$/.test(url)) asking.push(builds.job.step);
    return served(url, options);
  };
  const unpack = async (archive, destination) => {
    if (archive.includes('cudart')) {
      await mkdir(join(destination, 'bin'), { recursive: true });
      await writeFile(join(destination, 'bin', 'cudart64_13.dll'), 'dll');
    } else await writeFile(join(destination, 'llama-server.exe'), 'exe');
  };
  const builds = new LlamaBuilds({
    root,
    fetchImpl,
    run: async () => ({ code: 0, output: 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB)\n' }),
    unpack,
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [{ vendor: 'nvidia', computeCap: 8.9, cuda: [13, 3] }] }),
  });
  // The archives downloaded, the library put beside the program, the folder unpacked.
  const folder = join(root, 'b12110-cuda-13.4'),
    paths = [
      join(root, 'downloads', 'llama-b12110-bin-win-cuda-13.4-x64.zip'),
      join(root, 'downloads', 'cudart-llama-bin-win-cuda-13.4-x64.zip'),
      join(folder + '.unpack', 'cudart64_13.dll'),
      folder,
    ];
  try {
    let kept;
    // What the installation says while it waits (0.6.87: its step stayed as it was for that minute).
    const steps = new Set(),
      // Which file was refused, and what was said then.
      at = [];
    const refused = await held(
      paths,
      async () => {
        kept = await builds.install();
      },
      { onRefused: path => (steps.add(builds.job.step), at.push([path, builds.job.step])) },
    );
    assert.equal(kept.id, 'cuda-13.4');
    assert.deepEqual(refused, twice(paths));
    assert.ok([...steps].some(step => / : en attente que Windows libère (le fichier|ses fichiers)…$/.test(step)), [...steps].join(' | '));
    assert.equal(asking.length, 2, asking.join(' | '));
    assert.ok(asking.every(step => !/en attente/.test(step)), asking.join(' | '));
    // The library let go, what came before is said again (0.6.90): not « en attente » still at the folder.
    assert.doesNotMatch(at.find(([path]) => path === resolve(folder))[1], /en attente/);
    assert.ok((await stat(join(folder, 'cudart64_13.dll'))).isFile(), 'the library beside llama-server.exe');
    assert.deepEqual((await readdir(root)).sort(), ['b12110-cuda-13.4', 'downloads']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed from the settings, the build becomes the engine of the chat model', async () => {
  const { createApplication } = await import('../server.mjs');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'llama-app-'));
  const enginePath = join(root, 'engines', 'llama.cpp', 'b12110-cuda-13.4', 'llama-server.exe');
  // An installer that answers at once, as if the build had been downloaded and tried.
  const fake = new LlamaBuilds({ root: join(root, 'engines', 'llama.cpp') });
  fake.check = async () => ({
    tag: 'b12110',
    device: {},
    candidates: [{ id: 'cuda-13.4', label: 'CUDA 13.4', size: 1 }],
  });
  fake.install = async () => {
    const result = { enginePath, tag: 'b12110', id: 'cuda-13.4', label: 'CUDA 13.4', devices: ['CUDA0: RTX'] };
    fake.job = { state: 'done', step: '', tried: [], result };
    return result;
  };
  const app = await createApplication({ port: 0, dataDir: root, llamaBuilds: fake });
  try {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await (await api('llama/check', {})).json()).candidates[0].label, 'CUDA 13.4');
    assert.equal((await api('llama/install', {})).status, 202);
    let job;
    for (let turn = 0; turn < 50; turn++) {
      job = await (await api('llama')).json();
      if (job.state === 'done' && job.used) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job.used, true);
    assert.equal(job.ours, true, 'the engine in use is one of the builds installed here');
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).enginePath, enginePath);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the builds before are removed but the one the engine runs, which stays to go back to', async () => {
  const { utimes } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  // The build in use is the oldest: the newer ones before it go, it stays.
  const ages = { 'b100-cuda-13.4': 300, 'b200-cuda-13.4': 200, 'b300-vulkan': 100 };
  for (const [name, age] of Object.entries(ages)) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, 'llama-server.exe'), 'exe');
    const at = new Date(Date.now() - age * 1000);
    await utimes(join(root, name), at, at);
  }
  const { fetchImpl } = github({ 'llama-b12110-bin-win-cpu-x64.zip': Buffer.from('cpu') });
  const builds = new LlamaBuilds({
    root,
    fetchImpl,
    run: async () => ({ code: 0, output: 'Available devices:\n' }),
    unpack: async (_archive, destination) => writeFile(join(destination, 'llama-server.exe'), 'exe'),
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [] }),
  });
  try {
    const kept = await builds.install({ inUse: join(root, 'b100-cuda-13.4', 'llama-server.exe') });
    assert.equal(kept.id, 'cpu');
    assert.equal(builds.status().state, 'done');
    assert.deepEqual((await readdir(root)).sort(), ['b100-cuda-13.4', 'b12110-cpu', 'downloads']);
    // An engine of its own (Ollama's): the newest build before stays instead.
    await mkdir(join(root, 'b400-vulkan'), { recursive: true });
    await builds.install({ inUse: 'C:\Ollama\llama-server.exe' });
    assert.deepEqual((await readdir(root)).sort(), ['b12110-cpu', 'b400-vulkan', 'downloads']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a build that cannot load the model gives the engine back to the former one', async () => {
  const { createApplication } = await import('../server.mjs');
  const { readFile } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = await mkdtemp(join(tmpdir(), 'llama-app-'));
  const folder = join(root, 'engines', 'llama.cpp', 'b12110-cuda-13.4');
  const enginePath = join(folder, 'llama-server.exe');
  await mkdir(folder, { recursive: true });
  await writeFile(enginePath, 'exe');
  const fakeEngine = fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url));
  // The engine in use loads the model; the new build says its version, then stops at loading.
  const spawnProcess = (command, args, options) =>
    command === enginePath && args[0] !== '--version'
      ? spawn(
          process.execPath,
          ['-e', 'console.error("error: unknown argument: --reasoning-format"); process.exit(1)'],
          options,
        )
      : spawn(process.execPath, [fakeEngine, ...args], options);
  const fake = new LlamaBuilds({ root: join(root, 'engines', 'llama.cpp') });
  fake.install = async () => {
    const result = { enginePath, tag: 'b12110', id: 'cuda-13.4', label: 'CUDA 13.4', devices: [] };
    fake.job = { state: 'done', step: '', tried: [], result };
    return result;
  };
  const app = await createApplication({ port: 0, dataDir: root, llamaBuilds: fake, spawnProcess });
  try {
    const { token } = await (await fetch(app.url + '/api/bootstrap')).json();
    const api = (route, body) =>
      fetch(app.url + '/api/' + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const until = async check => {
      for (let turn = 0; turn < 200; turn++) {
        const value = await check();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.fail('nothing came in time');
    };
    const modelPath = join(root, 'model.gguf');
    await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
    const settings = { enginePath: process.execPath, modelPath, projectorPath: '', contextSize: 4096 };
    assert.equal((await api('config', { ...settings, maxOutputTokens: 1024, gpuLayers: 0 })).status, 200);
    assert.equal((await api('start', {})).status, 202);
    await until(async () => (await (await api('status')).json()).state === 'ready');
    assert.equal((await api('llama/install', {})).status, 202);
    const job = await until(async () => {
      const value = await (await api('llama')).json();
      return ['done', 'error'].includes(value.state) && value;
    });
    assert.equal(job.state, 'error');
    assert.match(job.error, /ne démarre pas avec le modèle/);
    assert.match(job.error, /unknown argument/, 'what the build said');
    assert.match(job.error, /Le moteur d’avant est remis/);
    assert.equal(job.ours, false);
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).enginePath, process.execPath);
    // The model runs again on the engine before.
    await until(async () => (await (await api('status')).json()).state === 'ready');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * A GitHub that lists `files` as `github` does and serves them as the test says (0.6.393): `cuts` drops the
 * connection halfway through a file, as many times as said, once what came is on the disk (a Wi-Fi that
 * drops minutes in); `refused` answers 503; asked from where it stopped (`Range`), the rest comes.
 */
function flaky(root, files, { cuts = {}, refused = [] } = {}) {
  const { fetchImpl: listing } = github(files),
    asked = [];
  const fetchImpl = async (url, options = {}) => {
    const name = url.replace('https://files/', ''),
      bytes = files[name];
    if (!bytes) return listing(url, options);
    const from = Number(/^bytes=(\d+)-$/.exec(options.headers?.Range ?? '')?.[1] ?? 0),
      rest = bytes.subarray(from),
      status = from ? 206 : 200;
    asked.push([name, from]);
    if (refused.includes(name)) return new Response('', { status: 503 });
    if (!cuts[name]) return new Response(rest, { status });
    cuts[name]--;
    const half = rest.subarray(0, rest.length / 2),
      part = join(root, 'downloads', name + '.part');
    let sent = false;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (!sent) return void ((sent = true), controller.enqueue(half));
          for (let turn = 0; turn < 400 && (await stat(part).catch(() => null))?.size !== from + half.length; turn++)
            await new Promise(resolve => setTimeout(resolve, 5));
          controller.error(new TypeError('terminated'));
        },
      }),
      { status },
    );
  };
  return { fetchImpl, asked };
}
/** The builds of b12110 for an RTX 4070 SUPER whose driver takes CUDA 13.3. */
const RTX = {
  'llama-b12110-bin-win-cuda-13.4-x64.zip': Buffer.alloc(4000, 1),
  'cudart-llama-bin-win-cuda-13.4-x64.zip': Buffer.alloc(3000, 2),
  'llama-b12110-bin-win-cuda-12.4-x64.zip': Buffer.alloc(3500, 3),
  'cudart-llama-bin-win-cuda-12.4-x64.zip': Buffer.alloc(2500, 4),
  'llama-b12110-bin-win-vulkan-x64.zip': Buffer.alloc(2000, 5),
  'llama-b12110-bin-win-cpu-x64.zip': Buffer.alloc(1000, 6),
};
/** Unpacked: the program at the top, the CUDA libraries in a folder of their own. */
const unpacked = async (archive, destination) => {
  if (archive.includes('cudart')) {
    await mkdir(join(destination, 'bin'), { recursive: true });
    await writeFile(join(destination, 'bin', 'cudart64.dll'), 'dll');
  } else await writeFile(join(destination, 'llama-server.exe'), 'exe');
};
/** The installer on that computer, where every build sees the card. */
const rtx = (root, options) =>
  new LlamaBuilds({
    root,
    run: async () => ({
      code: 0,
      output: 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB)\n  Vulkan0: NVIDIA (12281 MiB)\n',
    }),
    unpack: unpacked,
    platform: 'win32',
    arch: 'x64',
    env: {},
    detect: async () => ({
      platform: 'win32',
      arch: 'x64',
      gpus: [{ vendor: 'nvidia', computeCap: 8.9, cuda: [13, 3] }],
    }),
    ...options,
  });

test('a download cut goes on where it stopped; cut twice, the installation stops there (0.6.393)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-')),
    name = 'llama-b12110-bin-win-cuda-13.4-x64.zip';
  try {
    // Cut once: the rest is asked for, and CUDA 13.4 is installed (CUDA 12.4 was, before).
    const once = join(root, 'once');
    let served = flaky(once, RTX, { cuts: { [name]: 1 } }),
      builds = rtx(once, { fetchImpl: served.fetchImpl });
    assert.equal((await builds.install()).id, 'cuda-13.4');
    assert.deepEqual(served.asked.slice(0, 2), [
      [name, 0],
      [name, 2000],
    ]);
    assert.ok(
      served.asked.every(([file]) => file.includes('13.4')),
      JSON.stringify(served.asked),
    );
    // What came before the cut is counted once: the page says « 7 Mo / 7 Mo », not more.
    let status = builds.status();
    assert.deepEqual([status.received, status.tried], [status.total, []]);
    // Cut twice: the installation stops, said in French with what to do; no other build is asked for.
    const twice = join(root, 'twice');
    served = flaky(twice, RTX, { cuts: { [name]: 2 } });
    builds = rtx(twice, { fetchImpl: served.fetchImpl });
    const said = await builds.install().then(
      () => assert.fail('installed'),
      error => error.message,
    );
    assert.equal(
      said,
      `La connexion a été coupée pendant le téléchargement de ${name}. L’installation de llama.cpp b12110 ` +
        '(CUDA 13.4) s’est arrêtée là, sans passer à une autre version : relancez-la, ce qui est déjà ' +
        'téléchargé de cette version est gardé.',
    );
    status = builds.status();
    assert.deepEqual([status.state, status.error, status.tried], ['error', said, []]);
    assert.ok(
      served.asked.every(([file]) => file === name),
      JSON.stringify(served.asked),
    );
    // What came stays, and the next installation goes on from there.
    assert.deepEqual(await readdir(twice), ['downloads']);
    assert.deepEqual(await readdir(join(twice, 'downloads')), [name + '.part']);
    assert.equal((await stat(join(twice, 'downloads', name + '.part'))).size, 3000);
    served.asked.length = 0;
    assert.equal((await builds.install()).id, 'cuda-13.4');
    assert.deepEqual(served.asked[0], [name, 3000]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only a build that does not work here gives way to the next, the other failures stop (0.6.393)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-')),
    cuda = 'llama-b12110-bin-win-cuda-13.4-x64.zip',
    cudart = 'cudart-llama-bin-win-cuda-13.4-x64.zip';
  const stopped = reason => error => {
    assert.match(error.message, reason);
    assert.match(error.message, /\. L’installation de llama\.cpp b12110 \(CUDA 13\.4\) s’est arrêtée là/);
    return true;
  };
  try {
    // GitHub in error: asked once (no cut), and the archive already there stays for next time.
    let folder = join(root, 'refused'),
      served = flaky(folder, RTX, { refused: [cudart] });
    await assert.rejects(
      rtx(folder, { fetchImpl: served.fetchImpl }).install(),
      stopped(/^GitHub répond 503 pour cudart-/),
    );
    assert.deepEqual(served.asked, [
      [cuda, 0],
      [cudart, 0],
    ]);
    assert.deepEqual(await readdir(join(folder, 'downloads')), [cuda]);
    // Altered on the way (same size): refused for its fingerprint, and nothing else asked for.
    folder = join(root, 'altered');
    served = flaky(folder, RTX);
    const altered = async (url, options) =>
      url.endsWith(cuda) ? new Response(Buffer.alloc(4000, 9)) : served.fetchImpl(url, options);
    await assert.rejects(
      rtx(folder, { fetchImpl: altered }).install(),
      stopped(/empreinte différente\) : il a été effacé\./),
    );
    assert.deepEqual(served.asked, []);
    // The CUDA libraries do not unpack (tar refuses, a full disk): stopped, both archives kept.
    folder = join(root, 'unpack');
    served = flaky(folder, RTX);
    const tar = async (command, args) => {
      if (!command.endsWith('tar.exe')) return { code: 0, output: 'Available devices:\n  CUDA0: NVIDIA (12281 MiB)\n' };
      if (args[1].includes('cudart')) return { code: 1, output: '' };
      await writeFile(join(args[3], 'llama-server.exe'), 'exe');
      return { code: 0, output: '' };
    };
    await assert.rejects(
      rtx(folder, { fetchImpl: served.fetchImpl, run: tar, unpack: null }).install(),
      stopped(/^Décompression impossible de cudart-llama-bin-win-cuda-13\.4-x64\.zip\. /),
    );
    assert.deepEqual((await readdir(join(folder, 'downloads'))).sort(), [cudart, cuda]);
    // An archive without llama-server is a build that does not work here: the next one is taken.
    folder = join(root, 'empty');
    served = flaky(folder, RTX);
    const builds = rtx(folder, {
      fetchImpl: served.fetchImpl,
      unpack: (archive, destination) => (archive.endsWith(cuda) ? undefined : unpacked(archive, destination)),
    });
    assert.equal((await builds.install()).id, 'cuda-12.4');
    assert.match(builds.status().tried[0].reason, /ne contient pas llama-server\.exe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('a build that does not start gives way to the next; a file that came short is asked for its rest (0.6.393)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-')),
    cuda = 'llama-b12110-bin-win-cuda-13.4-x64.zip';
  try {
    // The program of CUDA 13.4 does not start here (a library it misses): CUDA 12.4 is tried, and kept.
    let folder = join(root, 'starts'),
      served = flaky(folder, RTX);
    const run = async server =>
      server.includes('cuda-13.4')
        ? { code: 1, output: '' }
        : { code: 0, output: 'Available devices:\n  CUDA0: NVIDIA (12281 MiB)\n' };
    let builds = rtx(folder, { fetchImpl: served.fetchImpl, run });
    assert.equal((await builds.install()).id, 'cuda-12.4');
    assert.match(builds.status().tried[0].reason, /ne démarre pas sur cet ordinateur/);
    // A file that came short without an error (the connection closed as if all was sent): a cut too.
    folder = join(root, 'short');
    served = flaky(folder, RTX);
    let shortened = 1;
    const short = async (url, options) => {
      const response = await served.fetchImpl(url, options);
      if (!url.endsWith(cuda) || !shortened) return response;
      shortened--;
      return new Response(Buffer.from(await response.arrayBuffer()).subarray(0, 1500), { status: response.status });
    };
    builds = rtx(folder, { fetchImpl: short });
    assert.equal((await builds.install()).id, 'cuda-13.4');
    assert.deepEqual(
      served.asked.filter(([file]) => file === cuda),
      [
        [cuda, 0],
        [cuda, 1500],
      ],
    );
    const status = builds.status();
    assert.deepEqual([status.received, status.tried], [status.total, []]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed unpacking leaves no build behind; the downloads go once a build is installed (0.6.394)', async () => {
  const { utimes } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  const tar = async (command, args) => {
    if (!command.endsWith('tar.exe')) return { code: 0, output: 'Available devices:\n  CUDA0: NVIDIA (12281 MiB)\n' };
    if (args[1].includes('cudart')) return { code: 1, output: '' };
    await writeFile(join(args[3], 'llama-server.exe'), 'exe');
    return { code: 0, output: '' };
  };
  try {
    // The CUDA libraries do not unpack: what was unpacked goes at once, the archives stay to go on from.
    const builds = rtx(root, { fetchImpl: flaky(root, RTX).fetchImpl, run: tar, unpack: null });
    await assert.rejects(builds.install(), /Décompression impossible de cudart-/);
    assert.deepEqual(await readdir(root), ['downloads']);
    assert.deepEqual((await readdir(join(root, 'downloads'))).sort(), [
      'cudart-llama-bin-win-cuda-13.4-x64.zip',
      'llama-b12110-bin-win-cuda-13.4-x64.zip',
    ]);
    // Left by 0.6.393 and before: the unpacking of an older build cut short, newer than the build before it
    // (the one to go back to), and a download of an older release.
    const ages = { 'b12000-vulkan': 300, 'b12000-cuda-13.4.unpack': 100, 'b12000-cuda-13.4.libraries': 100 };
    for (const [name, age] of Object.entries(ages)) {
      await mkdir(join(root, name));
      const at = new Date(Date.now() - age * 1000);
      await utimes(join(root, name), at, at);
    }
    await writeFile(join(root, 'downloads', 'llama-b12000-bin-win-vulkan-x64.zip.part'), 'old');
    // A build installed, an engine of the user's in use: the build before stays, not what was left.
    const cpu = rtx(root, {
      fetchImpl: flaky(root, RTX).fetchImpl,
      detect: async () => ({ platform: 'win32', arch: 'x64', gpus: [] }),
    });
    assert.equal((await cpu.install({ inUse: 'C:\\Ollama\\llama-server.exe' })).id, 'cpu');
    assert.deepEqual((await readdir(root)).sort(), ['b12000-vulkan', 'b12110-cpu', 'downloads']);
    assert.deepEqual(await readdir(join(root, 'downloads')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('« Il voit » names the devices llama.cpp lists, not the lines it logs on the way (0.6.395)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'llama-builds-'));
  // Its error output (unbuffered) and its output, mixed: logs before the list, and between its lines.
  const output =
    'ggml_cuda_init: found 2 CUDA devices:\n' +
    '  Device 0: NVIDIA GeForce RTX 4070 SUPER, compute capability 8.9, VMM: yes\n' +
    '  Device 1: NVIDIA GeForce RTX 3060, compute capability 8.6, VMM: yes\n' +
    'load_backend: loaded CUDA backend from C:\\llama\\ggml-cuda.dll\n' +
    'Available devices:\n' +
    'load_backend: loaded CPU backend from C:\\llama\\ggml-cpu-alderlake.dll\n' +
    '  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11000 MiB free)\r\n' +
    'load_backend: loaded RPC backend from C:\\llama\\ggml-rpc.dll\n' +
    '  Device 0: NVIDIA GeForce RTX 4070 SUPER, compute capability 8.9, VMM: yes\n' +
    '  CUDA1: NVIDIA GeForce RTX 3060 (12288 MiB, 11500 MiB free)\n';
  try {
    const builds = rtx(root, { fetchImpl: flaky(root, RTX).fetchImpl, run: async () => ({ code: 0, output }) });
    assert.deepEqual((await builds.install()).devices, [
      'CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11000 MiB free)',
      'CUDA1: NVIDIA GeForce RTX 3060 (12288 MiB, 11500 MiB free)',
    ]);
    // Without its list, nothing is named: a line set in is not a device by itself (the build still sees
    // the card, and is kept).
    const bare = join(root, 'bare'),
      logged = '  CUDA0: NVIDIA GeForce RTX 4070 SUPER (12281 MiB, 11000 MiB free)\n',
      unlisted = rtx(bare, { fetchImpl: flaky(bare, RTX).fetchImpl, run: async () => ({ code: 0, output: logged }) }),
      kept = await unlisted.install();
    assert.deepEqual([kept.id, kept.devices], ['cuda-13.4', []]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an NVIDIA card is seen without nvidia-smi, and CUDA tried, the newest first (0.6.396)', async () => {
  // Windows: nvidia-smi gives nothing in time (a damaged driver, a computer under load); WMI sees the card.
  const wmi = 'NVIDIA|NVIDIA GeForce RTX 4070 SUPER\r\nIntel Corporation|Intel(R) UHD Graphics 770\r\n';
  const windows = await detectDevice({
    platform: 'win32',
    arch: 'x64',
    run: async command => (command === 'nvidia-smi' ? null : { code: 0, output: wmi }),
  });
  assert.deepEqual(windows.gpus, [
    { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070 SUPER', computeCap: null, cuda: null },
    { vendor: 'intel', name: 'Intel(R) UHD Graphics 770' },
  ]);
  // Neither its generation nor its driver known: each CUDA build is offered, then Vulkan, then the processor;
  // the trial of each decides.
  assert.deepEqual(ids(windows), ['cuda-13.4', 'cuda-12.4', 'vulkan', 'cpu']);
  // When nvidia-smi answers, its cards are the NVIDIA ones: none twice (here Linux, /sys sees the same card).
  const linux = await detectDevice({
    platform: 'linux',
    arch: 'x64',
    run: async (_command, args) =>
      args.length ? { code: 0, output: 'NVIDIA GeForce RTX 3060, 8.6\n' } : { code: 0, output: 'CUDA Version: 12.8' },
    listDir: async () => ['card0'],
    readText: async () => '0x10de\n',
  });
  assert.deepEqual(linux.gpus, [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', computeCap: 8.6, cuda: [12, 8] }]);
});
