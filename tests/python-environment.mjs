import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  PREPARATION,
  PythonEnvironment,
  environmentVariables,
  nothingInstalled,
  preparationBytes,
  preparationRoom,
  runEnvironmentCommand,
} from '../lib/python-environment.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'atelier-python-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = new PythonEnvironment({
    root,
    dataDir: join(root, 'data'),
    fetchAsset: async () => {
      throw Error('Unexpected network');
    },
    ...options,
  });
  t.after(() => env.close());
  return { root, env };
}
/**
 * (0.6.479) The libraries of runner/uv.lock a platform takes, walked from the project through their markers (only the
 * forms the lock uses), each with the wheel uv picks there: the sizes the lock gives, and the names it gives none.
 */
async function lockedWheels(platform) {
  const text = await readFile(new URL('../runner/uv.lock', import.meta.url), 'utf8'),
    env = platform === 'win32' ? { sys_platform: 'win32', platform_machine: 'AMD64' } : { sys_platform: 'linux' },
    packages = new Map(),
    edges = list =>
      [...list.matchAll(/\{ name = "([^"]+)"(?:, extra = \[([^\]]*)\])?(?:, marker = "([^"]*)")? \}/g)].map(m => ({
        name: m[1],
        extras: [...(m[2] ?? '').matchAll(/"([^"]+)"/g)].map(extra => extra[1]),
        marker: m[3] ?? '',
      }));
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const main = block.split(/^\[package\./m)[0],
      optional = block.match(/^\[package\.optional-dependencies\]([\s\S]*)$/m)?.[1] ?? '',
      extras = [...optional.matchAll(/^([\w-]+) = \[([\s\S]*?)^\]/gm)],
      wheels = [...(main.match(/^wheels = \[([\s\S]*?)^\]/m)?.[1] ?? '').matchAll(/\{ url = "([^"]+)"[^}]*\}/g)];
    packages.set(main.match(/^name = "([^"]+)"/m)[1], {
      deps: edges(main.match(/^dependencies = \[([\s\S]*?)^\]/m)?.[1] ?? ''),
      optional: Object.fromEntries(extras.map(m => [m[1], edges(m[2])])),
      wheels: wheels.map(m => ({
        file: decodeURIComponent(m[1].split('/').pop()),
        size: Number(m[0].match(/size = (\d+)/)?.[1] ?? NaN),
      })),
    });
  }
  const holds = marker =>
      !marker ||
      marker.split(/ or /).some(part =>
        part.split(/ and /).every(term => {
          const [, key, op, value] = term.trim().match(/^(\w+) (==|!=) '([^']*)'$/);
          return (env[key] === value) === (op === '==');
        }),
      ),
    taken = new Map(),
    walk = (name, extras = []) => {
      const first = !taken.has(name),
        seen = taken.get(name) ?? new Set(),
        fresh = extras.filter(extra => !seen.has(extra));
      fresh.forEach(extra => seen.add(extra));
      taken.set(name, seen);
      const own = packages.get(name);
      for (const dep of [...(first ? own.deps : []), ...fresh.flatMap(extra => own.optional[extra] ?? [])])
        if (holds(dep.marker)) walk(dep.name, dep.extras);
    };
  walk('atelier-generation-runtime');
  taken.delete('atelier-generation-runtime');
  const fits = file => {
    const [python, abi, place] = file.replace(/\.whl$/, '').split('-').slice(-3);
    const here = place === 'any' || (platform === 'win32' ? /win_amd64/.test(place) : /manylinux.*x86_64/.test(place));
    const ours =
      ['none', 'abi3', 'cp313'].includes(abi) &&
      (python.split('.').some(tag => tag === 'cp313' || /^py3/.test(tag) || tag === 'py2') ||
        (abi === 'abi3' && /^cp3\d+$/.test(python) && Number(python.slice(3)) <= 13));
    return here && ours;
  };
  return [...taken.keys()].map(name => ({ name, ...packages.get(name).wheels.find(wheel => fits(wheel.file)) }));
}

test('(0.6.479) a first preparation downloads the wheels of runner/uv.lock, and PyTorch, estimated', async () => {
  // The « Télécharger » of a model says it on a new installation (lib/model-downloads.mjs, offers).
  for (const platform of ['win32', 'linux']) {
    const wheels = await lockedWheels(platform),
      unsized = wheels.filter(wheel => !Number.isFinite(wheel.size)).map(wheel => wheel.name);
    // As many as uv checks on Windows once they are there (« Checked 52 packages », nothingInstalled).
    if (platform === 'win32') assert.equal(wheels.length, 52);
    assert.ok(wheels.every(wheel => wheel.file), 'a wheel for each library');
    // The index of PyTorch gives the lock no size: they alone are estimated.
    assert.deepEqual(unsized.sort(), ['torch', 'torchvision']);
    const sized = wheels.reduce((sum, wheel) => sum + (Number.isFinite(wheel.size) ? wheel.size : 0), 0);
    assert.equal(PREPARATION[platform].wheels, sized, `${platform} : runner/uv.lock changed, PREPARATION too`);
    assert.equal(preparationBytes(platform), Math.round(sized + PREPARATION[platform].estimate));
  }
  assert.equal(preparationBytes('darwin'), 0);
});

test('(0.6.506) on Windows the engine is said as measured: about 2,1 Go to download, 3,9 Gio on the disk', () => {
  // (27/11: 2 399 710 141 bytes received, about 105 Mo of them again after a stop; 3,888 Gio in the runtime folder.)
  assert.equal(preparationBytes('win32'), 2300676470);
  assert.equal(preparationRoom('win32'), Math.round(3.9 * 1024 ** 3));
  // Linux, not measured: its estimate as before, and on the disk at least what it downloads.
  assert.equal(PREPARATION.linux.estimate, 1024 ** 3);
  assert.equal(preparationRoom('linux'), preparationBytes('linux'));
  assert.equal(preparationRoom('darwin'), 0);
});

test('(0.6.479) an environment is prepared once its preparation ended, not when its folder is there', async t => {
  const { env } = await fixture(t);
  assert.equal(await env.prepared(), false);
  await mkdir(join(env.directory, 'venv'), { recursive: true });
  await writeFile(join(env.directory, 'venv', 'pyvenv.cfg'), 'home = C:\\Python\n');
  // Stopped on the way (uv makes the environment before its libraries): still to prepare.
  assert.deepEqual([await env.exists(), await env.prepared()], [true, false]);
  await writeFile(join(env.directory, 'verified.json'), '{"fingerprint":"x"}\n');
  assert.equal(await env.prepared(), true);
});

async function cachedUv(env) {
  const binary = join(env.directory, 'uv', '0.13.7', env.platform === 'win32' ? 'uv.exe' : 'uv');
  await mkdir(resolve(binary, '..'), { recursive: true });
  await writeFile(binary, 'local uv test fixture');
  return binary;
}

test('Windows and Linux setup exclusively select private Python, libraries and caches', async t => {
  const before = { ...process.env };
  for (const platform of ['win32', 'linux']) {
    const calls = [],
      { root, env } = await fixture(t, {
        platform,
        arch: 'x64',
        run: async (command, args, options) => {
          calls.push({ command, args, options });
          return { stdout: '', stderr: '' };
        },
      }),
      uv = await cachedUv(env);
    const python = await env.ensure();
    assert.equal(env.status().state, 'ready');
    assert.equal(python, join(env.directory, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
    assert.equal(calls.length, 3);
    assert.equal(calls[0].command, uv);
    assert.ok(calls[0].args.includes('--no-bin'));
    assert.ok(calls[0].args.includes('--no-registry'));
    assert.ok(calls[1].args.includes('--locked'));
    assert.ok(calls[1].args.includes('--managed-python'));
    assert.ok(calls[1].args.includes('--no-python-downloads'));
    assert.equal(calls[2].command, python);
    for (const { options } of calls) {
      for (const name of [
        'UV_CACHE_DIR',
        'UV_PYTHON_INSTALL_DIR',
        'UV_PYTHON_BIN_DIR',
        'UV_PROJECT_ENVIRONMENT',
        'HF_HOME',
        'TORCH_HOME',
        'TRITON_CACHE_DIR',
        'TORCHINDUCTOR_CACHE_DIR',
        'TMP',
        'TEMP',
        'TMPDIR',
      ])
        assert.ok(options.env[name].startsWith(env.directory + sep), name);
      assert.equal(options.env.UV_PYTHON_INSTALL_BIN, '0');
      assert.equal(options.env.UV_PYTHON_INSTALL_REGISTRY, '0');
      assert.equal(options.cwd, root);
      assert.equal(options.env.PATH, before.PATH);
    }
    await new PythonEnvironment({
      root,
      dataDir: join(root, 'data'),
      platform,
      arch: 'x64',
      run: async () => ({ stdout: '', stderr: '' }),
      fetchAsset: async () => {
        throw Error('A repeat launch must reuse uv');
      },
    }).ensure();
  }
  assert.deepEqual({ ...process.env }, before);
});

test('preparation is shared, reports progress and cancellation cannot report a late ready', async t => {
  let reached,
    commands = 0;
  const waiting = new Promise(resolve => {
      reached = resolve;
    }),
    { env } = await fixture(t, {
      run: async (_command, args, { signal }) => {
        commands++;
        if (args[0] === 'sync') {
          reached();
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
        }
        return { stdout: '', stderr: '' };
      },
    });
  await cachedUv(env);
  const first = env.ensure(),
    second = env.ensure();
  assert.equal(first, second);
  const rejected = assert.rejects(first, /abort/i);
  await waiting;
  assert.equal(env.status().state, 'installing');
  assert.match(env.status().progress, /bibliothèques/);
  await env.close();
  await rejected;
  assert.equal(commands, 2);
  assert.notEqual(env.status().state, 'ready');
  await assert.rejects(env.ensure(), /fermé/);
});

test('interrupted installation can retry without replacing a system Python', async t => {
  let attempts = 0;
  const { env } = await fixture(t, {
    run: async (_command, args) => {
      if (args[0] === 'sync' && attempts++ === 0) throw Error('Network interrupted');
      return { stdout: '', stderr: '' };
    },
  });
  await cachedUv(env);
  await assert.rejects(env.ensure(), /Network interrupted/);
  assert.equal(env.status().state, 'error');
  await env.ensure();
  assert.equal(env.status().state, 'ready');
  assert.equal(attempts, 2);
});

test('environment detection never creates a fresh venv and lock mismatches cannot start the verification step', async t => {
  let verified = false;
  const { env } = await fixture(t, {
    run: async (_command, args) => {
      if (args[0] === 'sync') throw Error('The lockfile needs to be updated, but --locked was provided');
      if (args[0] === '-s') verified = true;
      return { stdout: '', stderr: '' };
    },
  });
  assert.equal(await env.exists(), false);
  await cachedUv(env);
  await mkdir(join(env.directory, 'venv'));
  await writeFile(join(env.directory, 'venv', 'pyvenv.cfg'), 'home = private Python');
  assert.equal(await env.exists(), true);
  await assert.rejects(env.ensure(), /lockfile/);
  assert.equal(verified, false);
  assert.equal(env.status().state, 'error');
});

test('an unverified archive never executes and temporary downloads are removed', async t => {
  let commands = 0;
  const { env } = await fixture(t, {
    run: async () => {
      commands++;
    },
    fetchAsset: async () => new Response('not the verified uv archive'),
  });
  await assert.rejects(env.ensure(), /empreinte/);
  assert.equal(commands, 0);
  assert.equal(env.status().state, 'error');
  assert.deepEqual(await readdir(join(env.directory, 'tmp')), []);
});

test('unsupported platforms and unsafe cached binaries fail before installation', async t => {
  const { env: unsupported } = await fixture(t, { platform: 'darwin' });
  await assert.rejects(unsupported.ensure(), /Windows ou Linux x64/);
  const { root, env } = await fixture(t),
    binary = await cachedUv(env);
  await link(binary, join(root, 'other-link'));
  await assert.rejects(env.ensure(), /non sûr/);
});

test('a cancelled installer command is reaped and pre-cancelled commands never spawn', async () => {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await assert.rejects(
      runEnvironmentCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        env: process.env,
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.ok(Date.now() - started < 5000);
  assert.throws(() => runEnvironmentCommand(process.execPath, [], { signal: controller.signal }), /abort/i);
  assert.equal(environmentVariables('/private/runtime').PYTHONPATH, '');
});

test('the check that imports every library is made once, then skipped while nothing changed (0.6.110)', async t => {
  // Seven seconds of every start, before the engine started and imported its libraries for itself.
  const unchanged = 'Resolved 72 packages in 0.77ms\nChecked 52 packages in 2ms\n';
  let said = unchanged,
    failing = false,
    offline = false;
  const calls = [],
    { root, env } = await fixture(t, {
      run: async (_command, args) => {
        const step = args[0] === 'sync' ? 'sync' : args[0] === '-s' ? 'check' : 'python';
        calls.push(step);
        if (step === 'check' && failing) throw Error('DLL load failed while importing _C');
        if (step === 'sync' && offline) throw Error('Network interrupted');
        return { stdout: '', stderr: step === 'sync' ? said : '' };
      },
    });
  await cachedUv(env);
  await mkdir(join(root, 'runner'));
  await writeFile(join(root, 'runner', 'uv.lock'), 'version = 1\n');
  await writeFile(join(root, 'runner', 'pyproject.toml'), '[project]\n');
  const checks = async options => {
    calls.length = 0;
    await env.ensure(options);
    return calls.filter(step => step === 'check').length;
  };
  const engine = { engineReads: true };
  assert.equal(await checks(engine), 1, 'never checked: checked');
  assert.equal(env.trusted, false);
  assert.equal(await checks(engine), 0, 'passed, nothing changed, and the engine reads its libraries');
  assert.deepEqual(calls, ['python', 'sync'], 'uv still makes sure of the libraries');
  assert.deepEqual([env.trusted, env.status().state], [true, 'ready']);
  assert.equal(await checks(), 1, 'an engine that imports nothing as it starts: the check is what reads them');
  assert.equal(env.trusted, false);
  assert.equal(await checks(engine), 0);
  // Other libraries asked for (an update of the application).
  await writeFile(join(root, 'runner', 'uv.lock'), 'version = 2\n');
  assert.equal(await checks(engine), 1);
  assert.equal(await checks(engine), 0);
  // uv installed something, did not say it checked, or says a line this version does not know.
  for (const words of [
    'Resolved 72 packages in 1ms\nPrepared 1 package in 2s\nInstalled 1 package in 3s\n',
    'Resolved 72 packages in 1ms\n',
    unchanged + 'warning: something new\n',
    '',
  ]) {
    said = words;
    assert.equal(await checks(engine), 1, JSON.stringify(words));
  }
  said = unchanged;
  assert.equal(await checks(engine), 0);
  // The engine could not import a library: the trust of this start is withdrawn, the next one checks.
  assert.equal(await env.distrust(), true);
  assert.equal(await env.distrust(), false, 'nothing left to withdraw');
  assert.equal(await checks(engine), 1);
  assert.equal(await checks(engine), 0);
  // A check that fails leaves no mark of the one that passed.
  failing = true;
  await assert.rejects(env.ensure(), /DLL load failed/);
  assert.equal(env.status().state, 'error');
  failing = false;
  assert.equal(await checks(engine), 1);
  assert.equal(await checks(engine), 0);
  // A start that fails before uv answered skipped nothing: there is no trust of it to withdraw.
  offline = true;
  await assert.rejects(env.ensure(engine), /Network interrupted/);
  assert.equal(env.trusted, false);
});

test('uv is read as having changed nothing only when it says nothing else', () => {
  assert.equal(nothingInstalled({ stderr: 'Resolved 72 packages in 0.77ms\r\nChecked 52 packages in 2ms\r\n' }), true);
  assert.equal(nothingInstalled({ stdout: 'Checked 1 package in 2ms\n', stderr: '' }), true);
  assert.equal(nothingInstalled({ stderr: 'Resolved 72 packages in 1ms\nUninstalled 1 package in 4ms\n' }), false);
  assert.equal(nothingInstalled({ stderr: 'Resolved 72 packages in 1ms\nAudited 52 packages in 2ms\n' }), false);
  assert.equal(nothingInstalled({}), false);
  assert.equal(nothingInstalled(), false);
});

test('a preparation stopped at the end of its hour says so in French, with what to do (0.6.397)', async t => {
  // The hour given to the whole preparation, made short here: that limit and no other.
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = ms => timeout.call(AbortSignal, ms === 3600000 ? 20 : ms);
  t.after(() => {
    AbortSignal.timeout = timeout;
  });
  const { env } = await fixture(t, {
    // uv still bringing the libraries over a slow connection when the hour is over: stopped as
    // runEnvironmentCommand stops it, rejected with the reason of the signal. (The timer stands for the
    // process of uv, which keeps Node running: the one of AbortSignal.timeout does not.)
    run: async (_command, args, { signal }) => {
      if (args[0] === 'sync')
        await new Promise((_, no) => {
          const running = setTimeout(() => no(Error('The hour never ended.')), 5000),
            stop = () => (clearTimeout(running), no(signal.reason));
          if (signal.aborted) stop();
          else signal.addEventListener('abort', stop, { once: true });
        });
      return { stdout: '', stderr: '' };
    },
  });
  await cachedUv(env);
  await assert.rejects(env.ensure(), /a dépassé une heure/);
  const { state, error } = env.status();
  assert.equal(state, 'error');
  assert.match(error, /^La préparation de l’environnement Python a dépassé une heure/);
  assert.match(error, /Relancez-la avec « Vérifier l’environnement »/);
  assert.doesNotMatch(error, /aborted|timeout/i);
});
