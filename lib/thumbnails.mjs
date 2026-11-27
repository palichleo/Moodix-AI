import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { problem } from './engine.mjs';
import { atomicFile } from './update-files.mjs';
import { waveOf } from './take-film.mjs';

/**
 * Small pictures of the creations, shown where the original would be shrunk anyway: the cover
 * of a project, a banner or a card of the Studio, a tile while its original loads. The page
 * makes them (it has the original decoded, of an image as of a video) and sends them here once;
 * the server has no image library and only keeps the files.
 * (0.6.459, Bobine Pro) Beside them, the film of a take on the timeline of the Bobine, read once by the server
 * from its file (lib/take-film.mjs): the loudness of its sound (`<key>.wave.json`, with how many pictures its
 * strip has) and, for a video, pictures taken along it (`<key>.strip.jpg`).
 */
const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^${ID}\\.${ID}\\.\\d{1,3}$`);
const MAX_BYTES = 400 * 1024;
const FILM = '.wave.json',
  STRIP = '.strip.jpg',
  MAX_STRIP = 2 * 1024 * 1024;

export class Thumbnails {
  constructor(directory) {
    this.directory = directory;
    this.known = new Set();
    // When each was written: in its address, so that one made again is asked for anew.
    this.versions = new Map();
    // (0.6.459) The takes whose film is kept.
    this.films = new Set();
  }

  /** The name a thumbnail is kept under: its conversation, its run and the output in that run. */
  static key(conversationId, runId, index = 0) {
    const key = `${conversationId}.${runId}.${Number(index)}`;
    if (!KEY.test(key)) throw problem('Vignette invalide.');
    return key;
  }

  /** Reads what is on the disk, once: has() then answers from memory. */
  async load() {
    try {
      for (const name of await readdir(this.directory)) {
        if (name.endsWith(FILM) && KEY.test(name.slice(0, -FILM.length))) {
          this.films.add(name.slice(0, -FILM.length));
          continue;
        }
        const key = name.slice(0, -4);
        if (!name.endsWith('.jpg') || !KEY.test(key)) continue;
        this.known.add(key);
        await this.#stamp(key);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  has(key) {
    return this.known.has(key);
  }

  /** A number that changes when the thumbnail is written again (the time it was written). */
  version(key) {
    return this.versions.get(key) ?? 0;
  }

  async #stamp(key) {
    try {
      this.versions.set(key, Math.floor((await stat(join(this.directory, key + '.jpg'))).mtimeMs));
    } catch {
      this.versions.set(key, 0);
    }
  }

  /**
   * Keeps a JPEG the page made. Written once: a creation does not change. `replace`: made again,
   * the one kept being black (a frame the browser had not decoded, before 0.5.125).
   */
  async write(key, bytes, { replace = false } = {}) {
    if (!KEY.test(key)) throw problem('Vignette invalide.');
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      throw problem('Une vignette est une image JPEG.');
    if (bytes.length > MAX_BYTES) throw problem('Vignette trop lourde.', 413);
    if (this.known.has(key) && !replace) return false;
    await mkdir(this.directory, { recursive: true });
    await atomicFile(join(this.directory, key + '.jpg'), bytes);
    this.known.add(key);
    await this.#stamp(key);
    return true;
  }

  async read(key) {
    if (!this.known.has(key)) throw problem('Vignette introuvable.', 404);
    try {
      return await readFile(join(this.directory, key + '.jpg'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.known.delete(key);
      this.versions.delete(key);
      throw problem('Vignette introuvable.', 404);
    }
  }

  /** (0.6.459) The film of a take kept: { wave, frames } (no pictures for a sound: 0), or null. */
  async film(key) {
    if (!this.films.has(key)) return null;
    try {
      const kept = JSON.parse(await readFile(join(this.directory, key + FILM), 'utf8')),
        wave = waveOf(kept);
      if (wave && Number.isInteger(kept.frames) && kept.frames >= 0 && kept.frames <= 96) return { wave, frames: kept.frames };
    } catch (error) {
      if (error.code && error.code !== 'ENOENT') throw error;
    }
    // Gone, or not what was written: read again from the take.
    this.films.delete(key);
    return null;
  }

  /** Keeps the film of a take (lib/take-film.mjs): its wave and the number of pictures of its strip, then the strip. */
  async keepFilm(key, { wave, strip = null, frames = 0 }) {
    if (!KEY.test(key)) throw problem('Vignette invalide.');
    const read = waveOf(wave);
    if (!read) throw problem('Onde invalide.');
    if (strip && (!Buffer.isBuffer(strip) || strip[0] !== 0xff || strip[1] !== 0xd8 || strip[2] !== 0xff))
      throw problem('Une bande d’images est une image JPEG.');
    if (strip && strip.length > MAX_STRIP) throw problem('Bande d’images trop lourde.', 413);
    if (strip && !(Number.isInteger(frames) && frames > 0 && frames <= 96)) throw problem('Bande d’images invalide.');
    await mkdir(this.directory, { recursive: true });
    // (The strip first: a wave kept says its strip is there.)
    if (strip) await atomicFile(join(this.directory, key + STRIP), strip);
    await atomicFile(join(this.directory, key + FILM), JSON.stringify({ ...read, frames: strip ? frames : 0 }));
    this.films.add(key);
  }

  /** The strip of pictures of the film of a video. */
  async strip(key) {
    if (!this.films.has(key)) throw problem('Images introuvables.', 404);
    try {
      return await readFile(join(this.directory, key + STRIP));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw problem('Images introuvables.', 404);
    }
  }

  /**
   * The thumbnails of a conversation (of every one, without it), or of one of its creations (`runId`:
   * a take removed from the Studio; kept, its thumbnail stayed the cover of its conversation).
   */
  async forget(conversationId = null, runId = null) {
    const start = conversationId ? conversationId + '.' + (runId ? runId + '.' : '') : '';
    for (const key of [...this.known]) {
      if (start && !key.startsWith(start)) continue;
      this.known.delete(key);
      this.versions.delete(key);
      await rm(join(this.directory, key + '.jpg'), { force: true });
    }
    // (0.6.459) Their films with them.
    for (const key of [...this.films]) {
      if (start && !key.startsWith(start)) continue;
      this.films.delete(key);
      await rm(join(this.directory, key + FILM), { force: true });
      await rm(join(this.directory, key + STRIP), { force: true });
    }
  }
}
