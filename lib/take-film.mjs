import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { plainFolder } from './update-files.mjs';
import { imageSize } from './image-size.mjs';
import { BOOTSTRAP } from './video-still.mjs';

// (0.6.459, Bobine Pro, B01) Twelve values a second of the sound of a take, from 0 to 100 (runner/video/film.py).
export const WAVE_RATE = 12;
// The longest sound whose wave is kept: two hours.
const LONGEST = WAVE_RATE * 7200;

/**
 * What the piece of a take shows on the timeline of the Bobine (« La Bobine, plus belle et plus pro », 27/11):
 * the loudness of its sound (`wave`: { rate, sound, levels }, twelve values a second from 0 to 100) and, for a
 * video (`pictures`), pictures taken in it at regular intervals, square, side by side in one JPEG (`strip`,
 * `frames` of them). Read by the Python of the generation engine (runner/video/film.py) in a command that runs
 * on the processor and ends, with no model loaded, as the first or last picture of a video (lib/video-still.mjs).
 * `workDir`: a folder of the application where its files are written, then removed. `run`: what runs a command
 * of the Python environment (lib/python-environment.mjs, runEnvironmentCommand).
 */
export async function readFilm({ python, root, input, pictures = true, workDir, env = process.env, run, timeoutMs = 120000 }) {
  if (!python || typeof run !== 'function')
    throw Error('l’environnement de génération n’est pas installé (Paramètres › Génération)');
  await plainFolder(workDir, true);
  const folder = await mkdtemp(join(resolve(workDir), 'film-'));
  try {
    const wave = join(folder, 'wave.json'),
      strip = join(folder, 'strip.jpg');
    try {
      await run(
        python,
        ['-s', '-c', BOOTSTRAP, resolve(root), 'film', '--input', input, '--wave', wave].concat(pictures ? ['--strip', strip] : []),
        {
          cwd: resolve(root),
          env: { ...env, PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1' },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (error) {
      if (error?.name === 'TimeoutError') throw Error('la lecture de la prise a dépassé le délai');
      if (error?.code === 'ENOENT') throw Error('le Python du moteur de génération est introuvable');
      // The last line the command wrote: its reason, in the user's words (runner/video/film.py).
      const reason = String(error?.message || '')
        .trim()
        .split(/\r?\n/)
        .at(-1);
      throw Error(reason || 'la prise n’a pas pu être lue');
    }
    const read = waveOf(JSON.parse(await readFile(wave, 'utf8')));
    if (!read) throw Error('l’onde de la prise est illisible');
    if (!pictures) return { wave: read, strip: null, frames: 0 };
    const bytes = await readFile(strip),
      size = imageSize(bytes);
    // Square pictures side by side: as many as its width holds its height.
    if (!size || bytes[0] !== 0xff || size.width % size.height) throw Error('les images de la prise sont illisibles');
    return { wave: read, strip: bytes, frames: size.width / size.height };
  } finally {
    if (dirname(folder) === resolve(workDir)) await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/** The wave of a take as runner/video/film.py writes it, checked: { rate, sound, levels }, or null. */
export function waveOf(value) {
  if (!value || value.rate !== WAVE_RATE || typeof value.sound !== 'boolean' || !Array.isArray(value.levels)) return null;
  if (value.levels.length > LONGEST || !value.levels.every(level => Number.isInteger(level) && level >= 0 && level <= 100)) return null;
  return { rate: WAVE_RATE, sound: value.sound, levels: value.levels };
}
