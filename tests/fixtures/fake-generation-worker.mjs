import readline from 'node:readline';
import { spawn } from 'node:child_process';
const mode = process.env.TEST_RUNNER_MODE;
if (mode === 'crash') process.exit(2);
if (mode !== 'silent')
  console.log(JSON.stringify({ event: 'ready', protocol: 1, capabilities: { krea2: { ready: true } } }));
if (mode === 'libraries') console.log(JSON.stringify({ event: 'libraries', error: 'torch: DLL load failed' }));
// (0.6.429) As the real engine (runner/protocol.py), one request after the other: the next line is read once
// this one is answered. `wait` (ms, in its params) is how long a request takes; `seen` answers with the
// methods this engine was asked, in order; `child` starts a program of its own (as a film being assembled
// starts ffmpeg) and answers with its pid; `die` stops it by itself.
const seen = [];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  seen.push(method);
  if (method === 'shutdown') process.exit(0);
  if (method === 'die') process.exit(3);
  if (method === 'hang') continue;
  if (method === 'broken' || method === 'refused') {
    const error =
      method === 'broken'
        ? { message: "No module named 'diffusers'", code: 'LIBRARIES_FAILED' }
        : { message: 'Invalid job', code: 'INVALID_REQUEST' };
    console.log(JSON.stringify({ id, error }));
    continue;
  }
  if (method === 'generate') console.log(JSON.stringify({ event: 'progress', id, data: { step: 1, total: 8 } }));
  if (method === 'child') {
    // `detached`: as a program started by Python, which nothing ends with the one that started it (Node
    // itself ends its own children under Windows).
    const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    started.unref();
    console.log(JSON.stringify({ event: 'progress', id, data: { pid: started.pid } }));
  }
  if (Number.isFinite(params?.wait)) await new Promise(done => setTimeout(done, params.wait));
  if (method === 'bad') console.log('not json');
  else
    console.log(
      JSON.stringify({
        id,
        result:
          method === 'release'
            ? { released: true, allocatedGiB: 0 }
            : method === 'seen'
              ? { seen: [...seen] }
              : { method, params },
      }),
    );
}
