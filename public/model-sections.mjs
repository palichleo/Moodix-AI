/**
 * (0.6.481) The page « Modèles » in sections (27/11): « omni, de base, et pi-h3 doivent etre une sous section de
 * Minimax H3 », and the same for Wan 2.2 (its own and Caméra) and LTX 2.5 (Distillé, Uncensored). A section is a
 * model as the user names it; its parts are the models it holds, each with its own « Télécharger », « Proposé à
 * Moodix AI » and « Réglages ». A family joins the section of another by its manifest (`model.section`,
 * runner/families); the versions of a model on this computer are parts of its section, and so are those Moodix
 * can download it with (`absent`, lib/generation-service.mjs). Nothing here draws: what each part says and can
 * do, for public/native-workflow-ui.mjs to put on the page.
 */
import { lineOf, versionData } from './models-page.mjs';

/** What a workflow of a model that has several makes (Real-ESRGAN: images, videos). */
export const kindOf = record => ({ video: 'Vidéos', audio: 'Sons' })[record?.mediaType] ?? 'Images';

/** A name without the one of its section at its start: « Wan 2.2 Caméra » in Wan 2.2 is « Caméra ». */
const shortOf = (name, section) => (name.startsWith(section + ' ') ? name.slice(section.length + 1) : name);

/**
 * The sections of the lines of a group, in their order: { name, does, lines }, its own line first, then those
 * that join it (`section`, the name of its own line). A line whose section is not among them, or joins another
 * one itself, is a section of its own.
 */
export function sectionsOf(lines) {
  const all = lines ?? [],
    home = line =>
      typeof line.section === 'string' && line.section !== line.name
        ? all.find(other => other.name === line.section && (!other.section || other.section === other.name))
        : null;
  return all
    .filter(line => !home(line))
    .map(line => ({ name: line.name, does: line.does, lines: [line, ...all.filter(other => home(other) === line)] }));
}

/** The order of the versions of a model in its section: the one Moodix ships first, then by name. */
const rankOf = (entry, file) => (String(file).toLowerCase() === String(entry.provided ?? '').toLowerCase() ? 0 : 1);

/**
 * The models of a section, in its order: for each of its lines, each version of its model on this computer and
 * each one Moodix can download it with (`absent`), the one it ships first; or the workflow itself, for a model
 * whose file is not one to choose (pi H3, the two of Real-ESRGAN). `workflows`: the workflows as listed;
 * `downloads`: { offers, versions, job } of the server. Each part:
 *   { key, label: its name in its section, name: its whole name (« MiniMax H3 · Omni »), data: what follows its
 *     name, in mono, entry, record: its workflow, line: its line of the server, version | item: the version here,
 *     or the one to download, kind: 'workflow' | 'used' | 'other' | 'convert' | 'refused' | 'absent', state: as
 *     models-page.mjs says it of its workflow (or 'other', 'convert', 'refused', 'missing'), note, serves: whether
 *     it is what its workflow makes with (its switch and its settings are then that workflow's), download:
 *     { id, offer, bytes } what « Télécharger » fetches, or null, held: why its switch and settings are greyed }
 */
export function partsOf(section, workflows, downloads) {
  const parts = [],
    job = downloads?.job ?? {};
  for (const line of section.lines) {
    const own = [],
      head = line === section.lines[0],
      records = (line.workflows ?? [])
        .map(entry => [entry, (workflows ?? []).find(record => record.id === entry.id)])
        .filter(([, record]) => record);
    for (const [entry, record] of records) {
      const shown = lineOf({ ...line, workflows: [entry] }, workflows, downloads),
        fetched =
          shown.state === 'download' ? { id: shown.offer[0].id, offer: shown.offer[1], bytes: shown.bytes } : null,
        base = { entry, record, line, note: '', download: null, held: '' },
        // What a part that is its workflow says: what models-page.mjs says of the line of that workflow alone.
        serving = { state: shown.state, note: shown.note, serves: true, download: fetched },
        several = records.length > 1 ? kindOf(record) : '';
      const versions = Array.isArray(entry.versions) ? entry.versions : [],
        absent = Array.isArray(entry.absent) ? entry.absent : [];
      if (!versions.length && !absent.length) {
        own.push({ ...base, ...serving, kind: 'workflow', label: several, data: entry.version ? [entry.version] : [] });
        continue;
      }
      const found = [
        ...versions.map(version => ({ file: version.file, version })),
        ...absent.map(item => ({ file: item.file, item })),
      ].sort((a, b) => rankOf(entry, a.file) - rankOf(entry, b.file));
      for (const { version, item } of found) {
        const label = [several, (version ?? item).name].filter(Boolean).join(' · ');
        if (version) {
          const told = { ...base, version, label, data: versionData(version) };
          if (version.used) own.push({ ...told, ...serving, kind: 'used' });
          else if (version.how === 'direct')
            own.push({
              ...told,
              kind: 'other',
              state: 'other',
              serves: false,
              held: `${line.name} utilise une version à la fois : choisissez « Utiliser » pour celle-ci.`,
            });
          else
            own.push({
              ...told,
              kind: version.how === 'convert' ? 'convert' : 'refused',
              state: version.how === 'convert' ? 'convert' : 'refused',
              serves: false,
              held:
                version.how === 'convert'
                  ? `${version.file} : un GGUF se convertit avant de servir.`
                  : `${version.file} : format ${version.reason}, que ce modèle ne lit pas.`,
            });
          continue;
        }
        // The version its workflow makes with and lacks: what its line would say, « Télécharger » included.
        if (item.download === record.id) {
          own.push({ ...base, item, label, data: [], ...serving, kind: 'absent' });
          continue;
        }
        // Another one, downloaded on its own.
        const offer = downloads?.versions?.[item.download],
          state =
            job.state === 'running' && job.workflowId === item.download
              ? 'downloading'
              : offer?.complete
                ? 'download'
                : 'missing';
        own.push({
          ...base,
          item,
          label,
          data: [],
          kind: 'absent',
          state,
          serves: false,
          note: state === 'missing' ? 'Pas sur cet ordinateur, et pas de téléchargement connu.' : '',
          download:
            state === 'download'
              ? {
                  id: item.download,
                  offer,
                  // (0.6.479) With the engine of a new installation, which its click prepares too, as lineOf counts it.
                  bytes: (offer.left ?? offer.bytes ?? 0) + (Number(offer.engine?.bytes) || 0),
                }
              : null,
          held: state === 'missing' ? 'Ce modèle n’est pas sur cet ordinateur.' : 'À télécharger d’abord.',
        });
      }
    }
    // The models of the section's own line by their names (« Omni », « De base »); a line that joins it without the
    // section's name (« Caméra », « pi H3 »), the name of each of its versions after it when it has several.
    const short = shortOf(line.name, section.name);
    for (const part of own) {
      const told = part.label;
      if (head) {
        part.label = told || line.name;
        part.name = told ? `${line.name} · ${told}` : line.name;
      } else {
        part.label = own.length > 1 && told ? `${short} · ${told}` : short;
        part.name = own.length > 1 && told ? `${line.name} · ${told}` : line.name;
      }
      part.key = [part.record.id, part.version?.file ?? part.item?.file ?? ''].join(':');
    }
    parts.push(...own);
  }
  return parts;
}

/**
 * Whether a section is drawn as one line (its model alone: « Réglages » and « Proposé à Moodix AI » on its
 * line, as before) or with a row for each of its models.
 */
export const isSingle = parts => parts.length === 0 || (parts.length === 1 && parts[0].serves);
