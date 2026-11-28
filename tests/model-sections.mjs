import test from 'node:test';
import assert from 'node:assert/strict';
import { isSingle, kindOf, partsOf, sectionsOf } from '../public/model-sections.mjs';
import { preparationBytes } from '../lib/python-environment.mjs';

/**
 * (0.6.481) The page « Modèles » in sections (27/11): MiniMax H3 holds Omni, De base and pi H3; Wan 2.2 its own
 * and Caméra; LTX 2.5 its versions. What each part says and can do, from the lines of the server as
 * lib/generation-service.mjs writes them (`section`, `versions`, `absent`).
 */
const GIB = 1024 ** 3;
const record = (id, more = {}) => ({
  id,
  name: id,
  pipeline: 'minimax_h3',
  mediaType: 'video',
  enabled: true,
  ready: true,
  ...more,
});
const version = (name, file, more = {}) => ({
  path: 'D:\\models\\' + file,
  file,
  name,
  format: 'INT8',
  how: 'direct',
  bytes: 1,
  source: 'found',
  used: false,
  ...more,
});
const offer = (bytes, more = {}) => ({ files: [], bytes, left: bytes, complete: true, ...more });
const OMNI = 'fasth3_omniref_8step_pruned_int8_convrot.safetensors',
  FL2VA = 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const minimax = (versions, absent = []) => ({
  name: 'MiniMax H3',
  does: 'Vidéos de 5 à 15 s, avec le son.',
  group: 'video',
  order: 2,
  workflows: [
    {
      id: 'mm',
      family: 'minimax_h3',
      provided: OMNI,
      used: versions.find(item => item.used)?.path ?? null,
      versions,
      absent,
    },
  ],
});
const pi = {
  name: 'pi H3',
  does: 'Vidéos en 4 étapes.',
  group: 'video',
  order: 2.5,
  section: 'MiniMax H3',
  workflows: [{ id: 'pi', family: 'pi_h3', version: '4 étapes' }],
};
const brief = parts =>
  parts.map(part => [part.label, part.name, part.kind, part.state, part.serves, part.data.join(' · ')]);

test('a line joins the section its family names, where that section’s line is; any other is its own (0.6.481)', () => {
  const ltx = { name: 'LTX 2.5', order: 1, workflows: [] },
    wan = { name: 'Wan 2.2', order: 4, workflows: [] },
    camera = { name: 'Wan 2.2 Caméra', order: 5, section: 'Wan 2.2', workflows: [] },
    lost = { name: 'Orphelin', section: 'Absent', workflows: [] },
    chained = { name: 'Chaîne', section: 'pi H3', workflows: [] };
  const sections = sectionsOf([ltx, minimax([]), pi, wan, camera, lost, chained]);
  assert.deepEqual(
    sections.map(section => [section.name, section.lines.map(line => line.name)]),
    [
      ['LTX 2.5', ['LTX 2.5']],
      ['MiniMax H3', ['MiniMax H3', 'pi H3']],
      ['Wan 2.2', ['Wan 2.2', 'Wan 2.2 Caméra']],
      // A section that is not in the group, or a line that joins another itself: on its own.
      ['Orphelin', ['Orphelin']],
      ['Chaîne', ['Chaîne']],
    ],
  );
  assert.equal(sections[1].does, 'Vidéos de 5 à 15 s, avec le son.');
  assert.deepEqual([sectionsOf(undefined), sectionsOf([])], [[], []]);
  // Out of its section's group (the page draws a group at a time), a line is on its own.
  assert.deepEqual(
    sectionsOf([pi]).map(section => section.name),
    ['pi H3'],
  );
});

test('MiniMax H3 holds its versions here, the one to download, and pi H3: each with what serves it (0.6.481)', () => {
  const workflows = [record('mm'), record('pi', { pipeline: 'pi_h3' })],
    versions = [version('Omni', OMNI, { source: 'provided', used: true, parameters: { steps: 8 } })],
    absent = [{ file: FL2VA, name: 'De base', download: 'mm_v0123456789abcdef' }],
    downloads = {
      offers: {},
      versions: { mm_v0123456789abcdef: offer(20 * GIB, { left: 19 * GIB }) },
      job: { state: 'idle' },
    };
  const [section] = sectionsOf([minimax(versions, absent), pi]),
    parts = partsOf(section, workflows, downloads);
  assert.deepEqual(brief(parts), [
    ['Omni', 'MiniMax H3 · Omni', 'used', 'ready', true, 'INT8 · 8 étapes'],
    ['De base', 'MiniMax H3 · De base', 'absent', 'download', false, ''],
    // A line that joins: named as it is, what it is after its name.
    ['pi H3', 'pi H3', 'workflow', 'ready', true, '4 étapes'],
  ]);
  // De base is downloaded on its own: what is left of it, and greyed until it is here.
  assert.deepEqual(parts[1].download, {
    id: 'mm_v0123456789abcdef',
    offer: downloads.versions.mm_v0123456789abcdef,
    bytes: 19 * GIB,
  });
  assert.equal(parts[1].held, 'À télécharger d’abord.');
  assert.deepEqual(
    parts.map(part => part.key),
    [`mm:${OMNI}`, `mm:${FL2VA}`, 'pi:'],
  );
  assert.equal(isSingle(parts), false);
  // Under way: said on its row; no source known: greyed, and said.
  const running = partsOf(section, workflows, {
    ...downloads,
    job: { state: 'running', workflowId: 'mm_v0123456789abcdef', received: 1, total: 2 },
  });
  assert.deepEqual([running[1].state, running[1].download], ['downloading', null]);
  const unknown = partsOf(section, workflows, { offers: {}, versions: {}, job: {} });
  assert.deepEqual(
    [unknown[1].state, unknown[1].note, unknown[1].held],
    ['missing', 'Pas sur cet ordinateur, et pas de téléchargement connu.', 'Ce modèle n’est pas sur cet ordinateur.'],
  );
  assert.equal(
    partsOf(section, workflows, { versions: { mm_v0123456789abcdef: offer(GIB, { complete: false }) } })[1].state,
    'missing',
  );
});

test('both versions here: the one Moodix ships first, the other one to take, greyed until it is (0.6.481)', () => {
  const workflows = [record('mm', { customized: true }), record('pi', { pipeline: 'pi_h3', enabled: false })],
    // The server sends the one used first: the section keeps its order, the one Moodix ships first.
    versions = [
      version('De base', FL2VA, { used: true, parameters: { steps: 20 } }),
      version('Omni', OMNI, { source: 'provided', parameters: { steps: 8 } }),
      version('Cinema', 'cinema-Q8_0.gguf', { format: 'GGUF Q8', how: 'convert' }),
      version('Essai', 'essai-w4a8.safetensors', { format: 'W4A8', how: 'refused', reason: 'W4A8' }),
    ];
  const [section] = sectionsOf([minimax(versions), pi]),
    parts = partsOf(section, workflows, { offers: {}, job: {} });
  assert.deepEqual(brief(parts), [
    ['Omni', 'MiniMax H3 · Omni', 'other', 'other', false, 'INT8 · 8 étapes'],
    ['De base', 'MiniMax H3 · De base', 'used', 'ready', true, 'INT8 · 20 étapes'],
    ['Cinema', 'MiniMax H3 · Cinema', 'convert', 'convert', false, 'GGUF Q8'],
    ['Essai', 'MiniMax H3 · Essai', 'refused', 'refused', false, 'W4A8'],
    // Not offered to Moodix AI: its own switch says it; the line of before said it under its description.
    ['pi H3', 'pi H3', 'workflow', 'off', true, '4 étapes'],
  ]);
  assert.deepEqual(
    parts.map(part => part.held),
    [
      'MiniMax H3 utilise une version à la fois : choisissez « Utiliser » pour celle-ci.',
      '',
      'cinema-Q8_0.gguf : un GGUF se convertit avant de servir.',
      'essai-w4a8.safetensors : format W4A8, que ce modèle ne lit pas.',
      '',
    ],
  );
  assert.equal(parts[0].version.path, 'D:\\models\\' + OMNI);
});

test('the version a workflow lacks to run is downloaded by that workflow, as its line did (0.6.481)', () => {
  // Nothing of MiniMax H3 here: Omni comes with its workflow's own download, De base on its own.
  const workflows = [
      record('mm', { ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' }),
      record('pi', { pipeline: 'pi_h3', ready: false }),
    ],
    absent = [
      { file: OMNI, name: 'Omni', download: 'mm' },
      { file: FL2VA, name: 'De base', download: 'mm_v0123456789abcdef' },
    ],
    downloads = {
      offers: { mm: offer(42 * GIB), pi: offer(39 * GIB) },
      versions: { mm_v0123456789abcdef: offer(40 * GIB) },
      job: { state: 'idle' },
    };
  const [section] = sectionsOf([minimax([], absent), pi]),
    parts = partsOf(section, workflows, downloads);
  assert.deepEqual(brief(parts), [
    ['Omni', 'MiniMax H3 · Omni', 'absent', 'download', true, ''],
    ['De base', 'MiniMax H3 · De base', 'absent', 'download', false, ''],
    ['pi H3', 'pi H3', 'workflow', 'download', true, '4 étapes'],
  ]);
  assert.deepEqual(
    parts.map(part => [part.download.id, part.download.bytes]),
    [
      ['mm', 42 * GIB],
      ['mm_v0123456789abcdef', 40 * GIB],
      ['pi', 39 * GIB],
    ],
  );
  // The workflow's download under way: on the row of Omni, whatever De base says.
  const running = partsOf(section, workflows, { ...downloads, job: { state: 'running', workflowId: 'mm' } });
  assert.deepEqual(
    running.map(part => part.state),
    ['downloading', 'download', 'download'],
  );
});

test('(0.6.479) a new installation: each row of a section counts the engine its click prepares', () => {
  // Every model lacks the engine then: the row of a version downloaded on its own said its files alone, where the
  // row of its workflow counted the engine too (lineOf).
  const workflows = [
      record('mm', { ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' }),
      record('pi', { pipeline: 'pi_h3', ready: false }),
    ],
    // (0.6.506) As the server says it on Windows, measured on 27/11.
    engine = { bytes: preparationBytes('win32') },
    absent = [
      { file: OMNI, name: 'Omni', download: 'mm' },
      { file: FL2VA, name: 'De base', download: 'mm_v0123456789abcdef' },
    ],
    downloads = {
      offers: { mm: offer(42 * GIB, { engine }), pi: offer(0, { engine }) },
      versions: { mm_v0123456789abcdef: offer(40 * GIB, { left: 39 * GIB, engine }) },
      job: { state: 'idle' },
    };
  const [section] = sectionsOf([minimax([], absent), pi]);
  assert.deepEqual(
    partsOf(section, workflows, downloads).map(part => [part.label, part.state, part.download.bytes]),
    [
      ['Omni', 'download', 42 * GIB + engine.bytes],
      ['De base', 'download', 39 * GIB + engine.bytes],
      // Its files all here: the engine alone.
      ['pi H3', 'download', engine.bytes],
    ],
  );
});

test('Wan 2.2 and its Caméra, Real-ESRGAN’s two workflows, a model alone (0.6.481)', () => {
  const wan = {
      name: 'Wan 2.2',
      does: 'Animer une image.',
      workflows: [
        {
          id: 'wan',
          family: 'wan22',
          provided: 'wan_i2v_high.safetensors',
          versions: [version('Image vers vidéo', 'wan_i2v_high.safetensors', { source: 'provided', used: true })],
          absent: [],
        },
      ],
    },
    camera = {
      name: 'Wan 2.2 Caméra',
      section: 'Wan 2.2',
      workflows: [
        {
          id: 'cam',
          family: 'wan22_camera',
          provided: 'camera_high.safetensors',
          versions: [version('Fun Camera', 'camera_high.safetensors', { source: 'provided', used: true })],
          absent: [],
        },
      ],
    },
    workflows = [record('wan', { pipeline: 'wan22' }), record('cam', { pipeline: 'wan22_camera', enabled: false })];
  const [section] = sectionsOf([wan, camera]);
  assert.deepEqual(brief(partsOf(section, workflows, {})), [
    ['Image vers vidéo', 'Wan 2.2 · Image vers vidéo', 'used', 'ready', true, 'INT8'],
    ['Caméra', 'Wan 2.2 Caméra', 'used', 'off', true, 'INT8'],
  ]);
  // A line that joins with several versions: each named after it.
  const two = {
    ...camera,
    workflows: [
      {
        ...camera.workflows[0],
        versions: [
          ...camera.workflows[0].versions,
          version('Fun Camera FP8', 'camera_fp8.safetensors', { format: 'FP8' }),
        ],
      },
    ],
  };
  assert.deepEqual(
    partsOf(sectionsOf([wan, two])[0], workflows, {})
      .slice(1)
      .map(part => [part.label, part.name]),
    [
      ['Caméra · Fun Camera', 'Wan 2.2 Caméra · Fun Camera'],
      ['Caméra · Fun Camera FP8', 'Wan 2.2 Caméra · Fun Camera FP8'],
    ],
  );
  // Real-ESRGAN: one line of two workflows, each a part, named by what it makes.
  const esr = {
      name: 'Real-ESRGAN',
      workflows: [
        { id: 'esr-image', family: 'realesrgan_image', version: '×4 Plus' },
        { id: 'esr-video', family: 'realesrgan_video', version: '×2 Plus' },
      ],
    },
    upscalers = [record('esr-image', { mediaType: 'image' }), record('esr-video', { mediaType: 'video' })];
  assert.deepEqual(brief(partsOf(sectionsOf([esr])[0], upscalers, {})), [
    ['Images', 'Real-ESRGAN · Images', 'workflow', 'ready', true, '×4 Plus'],
    ['Vidéos', 'Real-ESRGAN · Vidéos', 'workflow', 'ready', true, '×2 Plus'],
  ]);
  assert.deepEqual([kindOf({ mediaType: 'audio' }), kindOf(undefined)], ['Sons', 'Images']);
  // A model alone, of one version: drawn on one line, as before.
  const alone = {
    name: 'Krea 2',
    workflows: [
      {
        id: 'krea',
        family: 'krea2',
        provided: 'krea.safetensors',
        versions: [],
        absent: [{ file: 'krea.safetensors', name: 'Turbo', download: 'krea' }],
      },
    ],
  };
  const single = partsOf(sectionsOf([alone])[0], [record('krea', { pipeline: 'krea2', ready: false })], {
    offers: { krea: offer(GIB) },
  });
  assert.deepEqual(
    [brief(single), isSingle(single)],
    [[['Turbo', 'Krea 2 · Turbo', 'absent', 'download', true, '']], true],
  );
  assert.deepEqual(
    [
      isSingle([]),
      isSingle(
        partsOf(sectionsOf([{ name: 'ACE-Step 1.5', workflows: [{ id: 'a', version: 'XL' }] }])[0], [record('a')], {}),
      ),
    ],
    [true, true],
  );
  // A workflow that is not listed is no part.
  assert.deepEqual(partsOf(sectionsOf([alone])[0], [], {}), []);
});
