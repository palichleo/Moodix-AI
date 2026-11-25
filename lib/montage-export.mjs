/**
 * (0.6.136) The film of a montage (lib/montages.mjs): its takes found in the gallery of its
 * project, assembled by the engine (runner/video/montage.py), and the film kept as a creation of
 * the conversation it was asked from: a take as the others, numbered with them, that the Sortie
 * and the Archives show.
 */
import { randomUUID } from 'node:crypto';
import { lstat, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { problem } from './engine.mjs';
import { assemblyOf, montageSeconds, planName, planStarts } from './montages.mjs';
import { creationName } from './output-names.mjs';
import { folderName, isTodo } from '../public/montage-model.mjs';

/**
 * What finds the file of a source of a montage: `fileOf(source, label)`.
 * `gallery.get(conversationId, runId)`: the creation; `pathOf(output.source)`: its file in the
 * folder of the outputs; `projectOf(conversationId)`: the project of a conversation. A take of
 * another project, or one that is gone, is refused by the plan that names it.
 * (0.6.193) `fileOf.watermarked(path)`: whether the file found there is a film that carries a watermark
 * already (exportMontage), as its record says (`parameters.watermark`).
 */
export function takeFiles({ project, gallery, pathOf, projectOf }) {
  const watermarked = new Set();
  const fileOf = async (source, label) => {
    const gone = () => problem(`${label} : cette prise n’existe plus.`, 409);
    let run;
    try {
      run = await gallery.get(source.conversationId, source.runId, { includeImages: false });
    } catch {
      throw gone();
    }
    if ((await projectOf(source.conversationId)) !== project)
      throw problem(`${label} : cette prise est d’un autre projet.`, 409);
    const output = run.outputs?.[source.output];
    if (!output) throw gone();
    let path;
    try {
      path = await pathOf(output.source);
    } catch {
      throw gone();
    }
    if (run.parameters?.watermark) watermarked.add(path);
    return path;
  };
  fileOf.watermarked = path => watermarked.has(path);
  return fileOf;
}

/**
 * Assembles `montage` and keeps the film: returns its record as the gallery keeps it.
 * `assemble(request)`: the engine (GenerationService.assembleFilm); `conversationId`: where the
 * film is kept; `persist`: as for any creation (the history kept or not).
 */
export async function exportMontage({
  montage,
  conversationId,
  fileOf,
  assemble,
  gallery,
  persist = false,
  onProgress,
  id = randomUUID(),
  // (0.6.154) Named after its bobine (« video/2026-11-20_14-32-05_le-renard-en-hiver_a3f9.mp4 »).
  name = creationName(montage.name),
  // (0.6.187) The watermark of Paramètres › Interface (public/watermark.mjs): « aucun », or the one laid
  // over the film by the engine.
  watermark = 'aucun',
  now = () => new Date(),
}) {
  const assembly = await assemblyOf(montage, fileOf),
    started = now(),
    marked = watermark && watermark !== 'aucun' ? { watermark } : {};
  // (0.6.193) A take that is a film exported before carries its watermark already: said to the engine, which
  // lays none over it where it plays (runner/video/montage.py), never two on a picture. Only when this film
  // has one; otherwise nothing is said, the request is as it was.
  if (marked.watermark)
    for (const plan of assembly.plans) if (fileOf.watermarked?.(plan.path)) plan.watermarked = true;
  const result = await assemble({ id, outputName: name, ...marked, ...assembly }, { onProgress });
  const made = result?.outputs?.[0];
  if (!made) throw problem('Le moteur n’a pas rendu de film.', 502);
  const finished = now();
  return gallery.put(
    {
      mediaType: 'video',
      provider: 'native',
      id,
      conversationId,
      workflowId: 'montage',
      // (0.6.148) « Bobine », the name of the page it was exported from.
      workflowName: 'Bobine',
      // What a take is named by where no prompt made it: the name of its bobine.
      prompt: montage.name,
      parameters: {
        montage: montage.id,
        plans: montage.plans.length,
        sounds: montage.sounds.length,
        seconds: montageSeconds(montage),
        width: montage.width,
        height: montage.height,
        fps: montage.fps,
        frames: Math.round(montageSeconds(montage) * montage.fps),
        // (0.6.187) The one it carries, said where it has one.
        ...marked,
        generation_duration_ms: finished - started,
      },
      createdAt: finished.toISOString(),
      outputs: [{ source: made, width: montage.width, height: montage.height }],
    },
    { persist },
  );
}

const exists = path =>
  lstat(path).then(
    () => true,
    error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

/**
 * (0.6.154) « Un fichier par prise »: each take of the bobine already made, in its order and numbered (01,
 * 02…), as the film shows it (its part, its frame, its own sound; no audio track under it), in a folder of
 * its own under `bobines` in the folder of the outputs (`outputDir`), named after the bobine. A folder
 * already there is never written into: the next free one (« Le renard en hiver 2 »). These files are not
 * takes of the project. Returns { folder, files }.
 */
export async function exportTakes({
  montage,
  fileOf,
  assemble,
  outputDir,
  onProgress,
  id = () => randomUUID(),
  name = () => creationName('bobine'),
  // (0.6.187) As for the film: the watermark of Paramètres › Interface, on each of these files.
  watermark = 'aucun',
}) {
  const made = montage.plans.filter(plan => !isTodo(plan)),
    marked = watermark && watermark !== 'aucun' ? { watermark } : {};
  if (!made.length) throw problem('Aucune prise de cette bobine n’est encore créée.', 400);
  const base = folderName(montage.name);
  let folder = base;
  for (let count = 2; await exists(join(outputDir, 'bobines', folder)); count++) {
    if (count > 99) throw problem('Aucun dossier libre pour les prises de cette bobine.', 409);
    folder = base + ' ' + count;
  }
  const width = Math.max(2, String(made.length).length),
    starts = planStarts(montage),
    assemblies = [],
    files = [];
  // (0.6.344) The files of all the takes are found before the first is encoded: a take gone stopped the export
  // once those before it were encoded, in a folder left half filled (and the next export went to « … 2 »).
  for (const plan of made) {
    // (0.6.345) Named by its instants in the bobine, not by its place in it (lib/montages.mjs `planName`).
    const label = planName(starts[montage.plans.indexOf(plan)], plan),
      alone = { ...montage, plans: [{ ...plan, at: 0 }], sounds: [] };
    assemblies.push(await assemblyOf(alone, source => fileOf(source, label)));
  }
  try {
    for (const [index, assembly] of assemblies.entries()) {
      const file = String(index + 1).padStart(width, '0') + '.mp4',
        // (0.6.197) A take that is a film exported before carries its watermark already (0.6.193): its file,
        // made of it alone, is asked without one. Never two on a picture.
        own = fileOf.watermarked?.(assembly.plans[0].path) ? {} : marked;
      await assemble(
        { id: id(), outputName: name(), exportTo: ['bobines', folder, file].join('/'), ...own, ...assembly },
        { onProgress },
      );
      files.push(file);
    }
  } catch (error) {
    // (0.6.344) The engine stopped on one of them: the files it wrote before go, and their folder once empty,
    // made for this export alone (free when it was chosen: a folder there already is never written into),
    // were it on the very first file. What fails to go stays as it was.
    const place = join(outputDir, 'bobines', folder);
    await Promise.all(files.map(file => rm(join(place, file), { force: true }).catch(() => {})));
    await rmdir(place).catch(() => {});
    throw error;
  }
  return { folder: 'bobines/' + folder, files };
}
