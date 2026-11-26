import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const failure = message => Object.assign(new Error(message), { status: 503 });
// What holds the engine for long: a creation, and (0.6.429) a film being assembled. While one of them is asked
// for, the engine is busy: no other creation starts behind it, and the application is not relaunched under it.
const LONG = new Set(['generate', 'assemble']);
/**
 * (0.6.429) Ends the engine with the programs it started. Under Windows, ending it alone left the ffmpeg of a
 * film being assembled running: it went on encoding for nobody, and kept its half-written file open (its
 * progress is written to a pipe nobody reads any more, which does not stop it). `taskkill /T` ends the tree;
 * when it cannot (not found, refused, too slow), the engine alone is ended as before.
 */
function endTree(child, waitMs) {
  if (process.platform !== 'win32' || !child.pid) return void child.kill();
  return new Promise(done => {
    let settled = false;
    const alone = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      done();
    };
    const timer = setTimeout(alone, waitMs);
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', alone);
      // Gone already, or one of its programs could not be ended: the engine itself is ended in any case.
      killer.once('close', alone);
    } catch {
      alone();
    }
  });
}
export class GenerationWorker {
  constructor({ root, spawnProcess = spawn, handshakeMs = 60000, stopMs = 3000 } = {}) {
    this.root = resolve(root || '.');
    this.spawnProcess = spawnProcess;
    this.handshakeMs = handshakeMs;
    this.stopMs = stopMs;
    this.child = null;
    this.pending = new Map();
    // (0.6.429) The engine answers one request after the other (runner/protocol.py: one loop reads a line, runs
    // it to its end, answers, reads the next). They are written to it one at a time: those behind wait here
    // (`queue`), where one can be withdrawn without stopping the engine, and the delay of each runs from the
    // moment it is written (`sent`). Written all at once, a `release` of 60 s sent behind a film that takes
    // two minutes to assemble ran out while it waited in the pipe, and the engine was stopped for it: the film
    // was lost (« Le moteur Python s’est arrêté (SIGTERM) »), the release too.
    this.queue = [];
    this.sent = null;
    this.state = 'stopped';
    this.error = '';
    this.capabilities = {};
    this.closing = false;
    // True from a deliberate stop (a cancelled or overdue generation) until the worker is back.
    this.recovering = false;
    // (0.6.110) Called with the worker's words when it could not import one of its libraries, as it
    // started or for a request: the application then checks the environment (generation-service).
    this.onLibrariesFailed = null;
  }
  status() {
    return {
      state: this.state,
      error: this.error,
      capabilities: this.capabilities,
      busy: [...this.pending.values()].some(p => LONG.has(p.method)),
      recovering: this.recovering,
    };
  }
  async start(config) {
    if (this.closingTask) await this.closingTask;
    if (this.terminating) await this.terminating;
    if (this.state === 'ready') return this.status();
    if (this.starting) return this.starting;
    this.closing = false;
    this.config = config;
    this.starting = this.#start(config).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  async #start(config) {
    const candidates = config.pythonPath
      ? [config.pythonPath]
      : [
          process.env.ATELIER_PYTHON,
          ...(process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']),
        ].filter(Boolean);
    let last;
    for (const python of candidates) {
      if (this.closing) break;
      this.state = 'starting';
      this.error = '';
      try {
        await this.#launch(python, config);
        if (this.closing) {
          await this.#terminate();
          break;
        }
        this.state = 'ready';
        this.error = '';
        // What waited behind a request stopped on purpose is asked of this new engine.
        this.#next();
        return this.status();
      } catch (error) {
        last = error;
        await this.#terminate();
      }
    }
    this.state = this.closing ? 'stopped' : 'unavailable';
    this.error = this.closing ? 'Le moteur Python est fermé.' : last?.message || 'Python est introuvable.';
    // No engine came back for what waited in the line.
    this.#fail(failure(this.error));
    throw failure(this.error);
  }
  #launch(python, config) {
    return new Promise((yes, no) => {
      const bootstrap =
        "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('runner',run_name='__main__')";
      let child;
      try {
        child = this.spawnProcess(python, ['-s', '-u', '-c', bootstrap, this.root, '--config', config.configPath], {
          cwd: this.root,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...config.env,
            HF_HUB_OFFLINE: '1',
            TRANSFORMERS_OFFLINE: '1',
            PYTHONIOENCODING: 'utf-8',
            PYTHONNOUSERSITE: '1',
          },
        });
      } catch (error) {
        no(error);
        return;
      }
      this.child = child;
      this.closed = new Promise(done => child.once('close', done));
      child.stdin.on('error', () => {});
      let buffer = '',
        ready = false,
        stderr = '';
      const timer = setTimeout(() => no(failure('Le moteur Python ne répond pas au démarrage.')), this.handshakeMs);
      const reject = error => {
        clearTimeout(timer);
        no(error);
        this.#fail(error);
      };
      child.on('error', error => reject(failure(`Python indisponible : ${error.message}`)));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', text => {
        stderr = (stderr + text).slice(-8000);
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', text => {
        if (this.child !== child) return;
        buffer += text;
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) {
          reject(failure('Réponse Python trop longue.'));
          void this.#terminate();
          return;
        }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            reject(failure('Protocole Python : JSON invalide.'));
            void this.#terminate();
            return;
          }
          if (event.event === 'ready') {
            if (ready || event.protocol !== 1 || !event.capabilities || typeof event.capabilities !== 'object') {
              reject(failure('Version du protocole Python incompatible.'));
              void this.#terminate();
              return;
            }
            ready = true;
            clearTimeout(timer);
            this.capabilities = event.capabilities;
            yes();
            continue;
          }
          if (!ready) {
            reject(failure('Le moteur Python n’a pas confirmé son démarrage.'));
            void this.#terminate();
            return;
          }
          // (A library it imports as it starts and could not: said by itself, in answer to no request.)
          if (event.event === 'libraries') {
            this.#librariesFailed(event.error);
            continue;
          }
          const pending = this.pending.get(event.id);
          if (!pending) continue;
          if (event.event === 'progress') {
            try {
              pending.onProgress?.(event.data);
            } catch {}
            continue;
          }
          this.pending.delete(event.id);
          pending.dispose();
          this.#done(pending);
          if (event.error) {
            if (event.error.code === 'LIBRARIES_FAILED') this.#librariesFailed(event.error.message);
            pending.no(failure(String(event.error.message || 'Erreur du moteur Python.')));
          } else if (Object.hasOwn(event, 'result')) pending.yes(event.result);
          else pending.no(failure('Réponse Python invalide.'));
        }
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.state = this.closing ? 'stopped' : 'unavailable';
        }
        const error = failure(
          `Le moteur Python s’est arrêté (${signal || code}).${stderr ? ' ' + stderr.trim().slice(-1500) : ''}`,
        );
        if (!ready) no(error);
        // Stopped on purpose (a request cancelled or out of time) and coming back: what waited in the line
        // was never written to it, and stays for the engine that follows.
        this.#fail(error, { keep: this.recovering });
      });
    });
  }
  #fail(error, { keep = false } = {}) {
    this.error = error.message;
    const kept = keep ? this.queue : [];
    for (const item of this.pending.values()) {
      if (kept.includes(item)) continue;
      item.dispose();
      item.no(error);
    }
    this.pending = new Map(kept.map(item => [item.id, item]));
    this.queue = kept;
    this.sent = null;
  }
  /** Writes the next request of the line to the engine, once it has answered the one before. */
  #next() {
    if (this.sent || !this.queue.length || this.state !== 'ready' || !this.child) return;
    const item = (this.sent = this.queue.shift());
    item.arm();
    this.child.stdin.write(JSON.stringify({ id: item.id, method: item.method, params: item.params }) + '\n', error => {
      if (!error || !this.pending.delete(item.id)) return;
      item.dispose();
      item.no(failure(error.message));
      this.#done(item);
    });
  }
  #done(item) {
    if (this.sent === item) this.sent = null;
    this.#next();
  }
  #librariesFailed(message) {
    try {
      this.onLibrariesFailed?.(String(message || ''));
    } catch {}
  }
  /** Ready and doing nothing: a short request is answered at once. */
  idle() {
    return this.state === 'ready' && Boolean(this.child) && this.pending.size === 0;
  }
  request(method, params = {}, { signal, onProgress, timeoutMs = method === 'generate' ? 3600000 : 60000 } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || failure('Opération annulée.'));
    if (this.state !== 'ready' || !this.child)
      return Promise.reject(failure(this.error || 'Le moteur Python est indisponible.'));
    if (method === 'generate' && this.status().busy)
      return Promise.reject(failure('Le moteur de génération exécute déjà une tâche.'));
    const id = randomUUID();
    return new Promise((yes, no) => {
      let timer;
      const item = { id, method, params, yes, no, onProgress };
      const abort = () => {
        if (!this.pending.delete(id)) return;
        item.dispose();
        // Still in the line: it leaves it, and the engine goes on with what it is doing. (Cancelling a
        // creation that waited behind a film being assembled stopped the engine, and the film with it.)
        const waiting = this.queue.indexOf(item);
        if (waiting >= 0) {
          this.queue.splice(waiting, 1);
          no(failure('Génération arrêtée.'));
          return;
        }
        // Being made: stopping the engine is the only way to interrupt it.
        void this.#restart().then(() => no(failure('Génération arrêtée.')));
      };
      item.dispose = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      // Its delay, from the moment the engine has it (#next): out of time, the engine is stopped.
      item.arm = () => {
        timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          item.dispose();
          void this.#restart().then(() => no(failure('Le moteur Python a dépassé le délai.')));
        }, timeoutMs);
      };
      this.pending.set(id, item);
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(item);
      this.#next();
    });
  }
  /**
   * Stops a worker that is busy (the only way to interrupt a generation) and starts a new one
   * at once: stopping it was the user's choice, not a failure, so generation stays available.
   * Resolves once the old worker is gone, without waiting for the new one.
   */
  async #restart() {
    this.recovering = true;
    await this.#terminate();
    if (this.closing || !this.config) {
      this.recovering = false;
      this.#fail(failure(this.error || 'Le moteur Python est fermé.'));
      return;
    }
    void this.start(this.config)
      .catch(() => {})
      .finally(() => {
        this.recovering = false;
      });
  }
  /**
   * The GPU given back; with `keepAbove` (bytes), main memory too, until that much is available.
   * `timeoutMs`: how long the engine has for it once it is its turn (60 s when left out).
   */
  async release({ keepAbove, timeoutMs } = {}) {
    // A worker that is starting has not touched the GPU yet.
    if (!this.child || this.state !== 'ready') return { released: true, allocatedGiB: 0 };
    const result = await this.request(
      'release',
      Number.isFinite(keepAbove) && keepAbove > 0 ? { keepAbove } : {},
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {},
    );
    if (result?.released !== true) throw failure('La libération du GPU n’a pas été confirmée.');
    return result;
  }
  /** Frees the model files the worker keeps in RAM between generations, then the GPU. */
  async unload() {
    if (!this.child || this.state !== 'ready') return { released: true, allocatedGiB: 0, freedRamGiB: 0 };
    const result = await this.request('unload');
    if (result?.released !== true) throw failure('Le déchargement des modèles n’a pas été confirmé.');
    return result;
  }
  async #terminate() {
    if (this.terminating) return this.terminating;
    this.terminating = this.#stopChild().finally(() => {
      this.terminating = null;
    });
    return this.terminating;
  }
  async #stopChild() {
    const child = this.child;
    if (!child) return;
    this.state = 'stopping';
    child.stdin?.end();
    await endTree(child, this.stopMs);
    await Promise.race([this.closed, delay(this.stopMs)]);
    if (this.child === child) {
      child.kill('SIGKILL');
      await this.closed;
    }
    if (this.child === child) this.child = null;
  }
  close() {
    if (!this.closingTask)
      this.closingTask = this.#close().finally(() => {
        this.closingTask = null;
      });
    return this.closingTask;
  }
  async #close() {
    this.closing = true;
    if (this.child && this.state === 'ready' && !this.status().busy && !this.child.stdin.writableEnded) {
      const child = this.child;
      child.stdin.end(JSON.stringify({ id: randomUUID(), method: 'shutdown', params: {} }) + '\n');
      await Promise.race([this.closed, delay(this.stopMs)]);
      if (this.child === child) await this.#terminate();
    } else await this.#terminate();
    await this.starting?.catch(() => {});
    await this.#terminate();
    this.state = 'stopped';
    this.#fail(failure('Le moteur Python est fermé.'));
  }
}
