import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDIO_ID, STUDIO_VERBS, enrichedPrompt, enrichMessages } from '../lib/studio.mjs';
import { ToolRuntime, checkStyles } from '../lib/tool-runtime.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../server.mjs';
import { setupCitedTakes } from '../public/cited-takes.mjs';

/** The project each file dropped in the Studio was kept in (« #ref3 » of that project). */
const importedInto = [];

test('a prompt is enriched from what the user typed, for the creation it is for', () => {
  const [system, user] = enrichMessages('  un renard dans la neige  ');
  // What was typed is the whole request; the model is told to keep it and add what is missing.
  assert.equal(user.content, 'un renard dans la neige');
  assert.match(system.content, /the prompt of an image/);
  assert.match(system.content, /Keep everything the user asked for/);
  assert.match(system.content, /Answer with the prompt alone/);
  // The same guidance as when the chat model writes a prompt itself, per kind of creation.
  assert.match(system.content, /three to six sentences in English/);
  const [video] = enrichMessages('un renard', { verb: 'create_video' });
  assert.match(video.content, /the prompt of a video clip/);
  assert.match(video.content, /present tense/);
  assert.match(enrichMessages('la suite', { verb: 'extend_video' })[0].content, /continuation of a video clip/);
  // An unknown verb is an image; the user's standing instructions come last and win.
  assert.match(enrichMessages('x', { verb: 'nope' })[0].content, /the prompt of an image/);
  assert.doesNotMatch(system.content, /standing instructions/);
  const [wished] = enrichMessages('un renard', { preferences: ' 500 caractères, en anglais ' });
  assert.match(
    wished.content,
    /standing instructions, which come first where they differ: 500 caractères, en anglais$/,
  );
});

test('the wand asks Qwen-Image-Edit an instruction that edits its images, any other model what it was asked (0.6.282)', async () => {
  const { TASKS } = await import('../lib/tasks.mjs');
  // Any other model: the words written before, to the letter.
  const [usual] = enrichMessages('la voiture en rouge');
  assert.equal(
    usual.content,
    'You rewrite what the user typed into the prompt of an image, for a generator that only reads this prompt. ' +
      'Keep everything the user asked for (the subject, the action, the place, the mood, any words to show or to say) and add what is missing. ' +
      `What the prompt must be: ${TASKS.create_image.prompt} ` +
      'Answer with the prompt alone: no preamble, no title, no quotes, no list, no explanation.',
  );
  for (const family of ['krea2', 'moss', 'nope', '__proto__', 'constructor', '', undefined, null, 7])
    assert.equal(enrichMessages('la voiture en rouge', { family })[0].content, usual.content, String(family));
  // A verb the family does not read its own way: the guide of that verb.
  assert.equal(
    enrichMessages('un renard', { verb: 'create_video', family: 'qwen_image_edit' })[0].content,
    enrichMessages('un renard', { verb: 'create_video' })[0].content,
  );
  // Qwen-Image-Edit sees its images and changes only what it is told: an instruction, nothing of the whole picture.
  const [edit, typed] = enrichMessages('  la voiture en rouge ', { family: 'qwen_image_edit' });
  assert.equal(typed.content, 'la voiture en rouge');
  assert.match(edit.content, /^You rewrite what the user typed into the prompt of an image\. Keep everything the user asked for\. /);
  assert.match(edit.content, /What the prompt must be: An editing instruction in English, for a model that sees the images given/);
  assert.match(edit.content, /Picture 1 is the image to modify; Picture 2 and Picture 3 are the other images given/);
  assert.match(edit.content, /what is not named stays as it is\. Answer with the prompt alone/);
  assert.doesNotMatch(edit.content, /three to six sentences|add what is missing|only reads this prompt/);
  // The user's standing instructions still come last, and win.
  assert.match(
    enrichMessages('x', { family: 'qwen_image_edit', preferences: ' court ' })[0].content,
    /standing instructions, which come first where they differ: court$/,
  );
});

test('the answer is kept as the prompt alone', () => {
  assert.equal(
    enrichedPrompt('<think>hmm</think>\n"Prompt: A red fox sits in fresh snow.\n\nSoft morning light."\n'),
    'A red fox sits in fresh snow.\nSoft morning light.',
  );
  assert.equal(enrichedPrompt('Enriched prompt: « A fox »'), 'A fox');
  assert.equal(enrichedPrompt('x'.repeat(5000)).length, 4000);
  assert.equal(enrichedPrompt(null), '');
});

test('the Studio has its own identifier and the verbs it may start', () => {
  assert.match(STUDIO_ID, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  for (const verb of ['create_image', 'create_video', 'extend_video', 'create_audio'])
    assert.ok(STUDIO_VERBS.includes(verb));
});

test('style LoRAs: three at most, a name and a strength within limits', () => {
  assert.deepEqual(checkStyles([{ name: 'a.safetensors' }, { name: 'sub\\b.safetensors', strength: 0.5 }]), [
    { name: 'a.safetensors', strength: 1 },
    { name: 'sub\\b.safetensors', strength: 0.5 },
  ]);
  assert.throws(() => checkStyles([{ name: '' }]), /Style invalide/);
  assert.throws(() => checkStyles([{ name: 'a', strength: 9 }]), /Style invalide/);
  assert.equal(checkStyles(Array(3).fill({ name: 'a' })).length, 3);
  assert.throws(() => checkStyles(Array(4).fill({ name: 'a' })), /trois/);
});

const krea = styles => ({
  id: '00000000-0000-4000-8000-000000000000',
  pipeline: 'krea2',
  mediaType: 'image',
  references: [],
  loras: [],
  styles,
  parameters: { prompt: 'un renard', seed: 1, width: 1024, height: 1024, steps: 8, attention: 'comfy_kitchen' },
  components: { model: 'm/krea.safetensors', textEncoder: 'm/qwen.safetensors', vae: 'm/vae.safetensors' },
});

test('a model this computer cannot run is shown greyed with its reason, others not ready stay out', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const reason = 'Krea2 demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.';
  const workflows = [];
  for (const name of await readdir(folder)) {
    const workflow = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
    // No NVIDIA card: the image and video models of the built-in engine cannot compute; a
    // workflow whose file is missing is another matter, and the sounds still run.
    if (workflow.pipeline === 'krea2')
      workflows.push({ ...workflow, ready: false, unavailableReason: reason, unavailableKind: 'hardware' });
    else if (workflow.pipeline === 'minimax_h3')
      workflows.push({ ...workflow, ready: false, unavailableReason: 'Fichier introuvable pour « Modèle ».' });
    else workflows.push({ ...workflow, ready: true });
  }
  const catalog = new ToolCatalog({ list: async () => workflows });
  const tools = await catalog.studio();
  const images = tools.create_image.map(item => [item.family, item.unavailable]);
  // The ready model first (it is the one in hand), the greyed one after it with its reason.
  assert.deepEqual(images, [
    ['moss', undefined],
    // (0.6.264) Behind the others: its preference is below theirs, as Wan 2.2's.
    ['qwen_image_edit', undefined],
    ['krea2', reason],
  ]);
  assert.ok(tools.create_image.find(item => item.family === 'krea2').limits, 'described as the others, for the page to draw it');
  // Not ready for another reason: left out, as before.
  assert.deepEqual(
    tools.create_video.map(item => item.family),
    // (0.6.223) Wan 2.2 Caméra with them, shipped since.
    ['ltx25', 'wan22', 'wan22_camera'],
  );
  // The chat model is not offered what cannot run, and a request for it finds no workflow.
  const offered = (await catalog.definitions()).find(tool => tool.function.name === 'create_image');
  assert.doesNotMatch(offered.function.description, /Krea 2/);
});

test('(0.6.256) the Studio is told the models of Agrandir and Interpoler with their factor: × 2 · × 4 for SeedVR2 and RIFE, the one of its name for Real-ESRGAN, none of their settings', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  const tools = await new ToolCatalog({ list: async () => workflows }).studio();
  const shown = verb => tools[verb].map(item => [item.family, item.media, item.finish, item.settings, Boolean(item.follows), item.roles.source.required]);
  assert.deepEqual(shown('upscale'), [
    // (0.6.261) SeedVR2 held to 8192 even at 0, as its engine; Real-ESRGAN reduces to an even side.
    ['seedvr2', 'image', { key: 'scale', choices: [2, 4], standard: 2, maxSide: 8192 }, [], false, true],
    ['realesrgan_video', 'video', { factor: 2, maxSide: 3840, even: true }, [], false, true],
    ['realesrgan_image', 'image', { factor: 4, even: true }, [], false, true],
  ]);
  assert.deepEqual(shown('interpolate'), [['rife', 'video', { key: 'multiplier', choices: [2, 4], standard: 2 }, [], false, true]]);
  // A name that says no factor: the size is the model's.
  const plain = workflows.find(item => item.pipeline === 'realesrgan_image');
  const [own] = (await new ToolCatalog({ list: async () => [{ ...plain, name: 'Agrandir' }] }).studio()).upscale;
  assert.deepEqual(own.finish, { factor: 4, even: true }, 'its family says « ×4 Plus »');
});

test('the Studio is told, per verb, the ready workflows with their inputs, sizes, lengths and settings', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  const tools = await new ToolCatalog({ list: async () => workflows }).studio();
  const named = (verb, name) => tools[verb].find(item => item.name.startsWith(name));

  const krea = named('create_image', 'Krea 2');
  assert.deepEqual(krea.size, { width: 1024, height: 1024 });
  // Each model with its family: the page keeps a family's LoRAs to itself.
  assert.equal(krea.family, 'krea2');
  assert.equal(named('create_image', 'MOSS').family, 'moss');
  assert.equal(krea.limits.width.max, 4096);
  assert.equal(krea.roles.source.count, 1);
  // The name each input has in the record of a take, and the case of the Studio it goes back to.
  assert.ok(Object.values(krea.inputs).includes('source'));
  for (const tool of Object.values(tools).flat())
    for (const role of Object.values(tool.inputs)) assert.ok(tool.roles[role]?.count > 0, tool.name + ' · ' + role);

  const h3 = named('create_video', 'MiniMax');
  assert.deepEqual(h3.size, { width: 768, height: 448 });
  assert.deepEqual(h3.final, { width: 1344, height: 768 });
  // No start or end image: its model (Omni-Ref) does not follow them; references only.
  assert.deepEqual([h3.roles.start_image.count, h3.roles.end_image.count, h3.roles.reference.count], [0, 0, 3]);
  const ltxFrames = named('create_video', 'LTX');
  assert.deepEqual([ltxFrames.roles.start_image.count, ltxFrames.roles.end_image.count], [1, 1]);
  assert.ok(Math.abs(h3.lengths.seconds[0] - 124 / 24) < 1e-9);
  assert.ok(h3.exclusive);

  const ltx = named('create_video', 'LTX');
  assert.ok(ltx.lengths.seconds.includes(5) || ltx.lengths.seconds.some(s => Math.abs(s - 121 / 24) < 1e-9));
  const more = named('extend_video', 'MiniMax');
  assert.equal(more.roles.source.count, 1);
  // 141 frames with 22 taken from the source: 119 new ones.
  assert.ok(more.lengths.seconds.some(s => Math.abs(s - 119 / 24) < 1e-9));

  const music = named('create_audio', 'Musique');
  assert.deepEqual(music.settings.filter(item => !item.fixed).map(item => item.key).sort(), ['language', 'lyrics', 'seconds']);
  // (0.6.102) Those it fixes too, at their value: « Fixe » holds Moodix AI, the user may change it.
  assert.deepEqual(
    music.settings.filter(item => item.fixed).map(item => [item.key, item.default]),
    [
      ['steps', 50],
      ['guidance_scale', 7],
      ['shift', 3],
    ],
  );
  assert.match(music.for, /music/);
  assert.equal(named('create_audio', 'Bruitages').settings.find(item => item.key === 'seconds').max, 30);

  // A character put in a video: a verb of its own, a video and an image both needed, who is who
  // in two settings; no size nor length, which are the video's.
  const [scail] = tools.replace_character;
  assert.equal(scail.family, 'wan_scail2');
  assert.deepEqual([scail.verb, scail.follows], ['replace_character', true]);
  assert.deepEqual(scail.roles, {
    source: { count: 1, media: ['video'], many: false, required: true },
    reference: { count: 1, media: ['image'], many: false, required: true },
  });
  assert.deepEqual(
    scail.settings.filter(item => !item.fixed).map(item => [item.key, item.default]),
    [
      ['subject', 'person'],
      ['reference_subject', 'person'],
    ],
  );
  assert.deepEqual([scail.limits, scail.size, scail.lengths], [undefined, undefined, undefined]);
  // The other verbs say theirs, and are not told to follow a video.
  assert.deepEqual([h3.verb, h3.follows, more.verb, more.follows], ['create_video', undefined, 'extend_video', undefined]);
  assert.equal(h3.roles.reference.many, true);
});

test('a character replaced in a video: its model among the videos, a video and an image handed over, who is who', async () => {
  const clip = {
      id: 'v',
      name: 'Clip',
      verb: 'create_video',
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'], many: false } },
    },
    scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    };
  const page = await studioPage(
    { create_video: [clip], replace_character: [scail] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
      'studio/enrich': () => ({ prompt: 'A woman in a white top wipes an apple in an orchard.', seen: true }),
    },
  );
  const { body, asked, notices, restore } = page;
  try {
    page.mode(1);
    const wand = () => body.find('studio-enrich-go')[0],
      enriched = () => asked.filter(([route]) => route === 'studio/enrich');
    // (0.6.201) The plateau is one block without a name: its rows are named.
    const blocks = () => [...body.find('studio-frames'), ...body.find('studio-pieces')].map(group => group.attributes['aria-label']),
      slots = () => body.find('studio-slot'),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, file) => {
        slots()[index].ondrop(event([file]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      generate = async () => {
        await body.find('studio-go')[0].onclick();
        await settle();
      },
      sent = () => asked.filter(([route]) => route === 'tools/action');
    // Both models in the one list of the videos; the first is the one that makes a clip.
    const pick = body.find('studio-model-pick')[0];
    assert.equal(pick.children.length, 2);
    assert.deepEqual(blocks(), ['Image de début']);
    pick.value = 's';
    pick.onchange();
    // Its inputs: the video and the character. No rare setting but the seed.
    assert.deepEqual(blocks(), ['Vidéo à suivre et personnage']);
    assert.deepEqual(
      body.find('studio-slot-pick').map(pick => pick.attributes['aria-label']),
      ['Ajouter la vidéo à suivre', 'Ajouter l’image du personnage'],
    );
    // (0.6.201, capture 97) The two on one row of the plateau, their words under them; no title. (0.6.204) The
    // plateau alone: « Qui est qui » left the column, each of its two fields is in the window of its piece.
    // (Its model just chosen: it says so for a moment, « is-flash ».)
    assert.deepEqual(
      body.find('studio-input-block').map(block => block.className.replace(' is-flash', '')),
      ['studio-input-block studio-plateau'],
    );
    assert.deepEqual(body.find('studio-piece-word').map(word => word.textContent), ['À suivre', 'Personnage']);
    assert.deepEqual(body.find('studio-input-title'), []);
    assert.equal(page.prompt().placeholder, 'Décrivez la vidéo avec votre personnage…');
    // (0.6.204) No window for a piece that is not given, and no block « Qui est qui » under the plateau.
    const pane = () => body.find('studio-piece-window'),
      who = () => pane()[0].find('studio-field'),
      cases = () => body.find('studio-slot-pick');
    assert.deepEqual([body.find('studio-who').length, pane().length], [0, 0]);
    assert.deepEqual(cases().map(pick => [pick.attributes['aria-haspopup'], pick.attributes['aria-expanded']]), [[undefined, undefined], [undefined, undefined]]);
    assert.equal(body.find('studio-rare')[0].children.length, 1);
    // The wand writes the prompt from the video and the character: it waits for both, not for words.
    assert.equal(wand().disabled, true);
    assert.equal(wand().title, 'Ajoutez d’abord la vidéo et le personnage');
    await wand().onclick();
    assert.equal(enriched().length, 0);
    // What the model cannot do without is asked for in plain words, nothing is sent. (0.6.253) In the bubble of
    // « Générer » greyed and pressed (generer-maquette.md), no longer on a line under it.
    page.prompt().value = 'Une femme en haut blanc mange une pomme dans un verger.';
    page.prompt().oninput();
    await generate();
    assert.match(page.said.at(-1), /Ajoutez la vidéo à suivre/);
    assert.equal(sent().length, 0);
    // An image is not a video: the slot says so and stays empty.
    await drop(0, { name: 'photo.png', type: 'image/png' });
    assert.match(notices.at(-1), /attend une vidéo/);
    await drop(0, { name: 'clip.mp4', type: 'video/mp4' });
    assert.match(slots()[0].className, /is-filled/);
    // Kept as a reference of the project of the conversation (Conversations here).
    assert.equal(importedInto.at(-1), 'inbox');
    await generate();
    assert.match(page.said.at(-1), /Ajoutez l’image du personnage/);
    await drop(1, { name: 'clip.mp4', type: 'video/mp4' });
    assert.match(notices.at(-1), /attend une image/);
    await drop(1, { name: 'perso.png', type: 'image/png' });
    // (0.6.204, capture 97) A click on the video given opens its small window, hung under it: its whole name,
    // « Qui remplacer », what it is, « Changer… » and « Retirer ». One window at a time.
    assert.deepEqual(cases().map(pick => [pick.attributes['aria-haspopup'], pick.attributes['aria-expanded']]), [['dialog', 'false'], ['dialog', 'false']]);
    cases()[0].onclick();
    assert.deepEqual(cases().map(pick => pick.attributes['aria-expanded']), ['true', 'false']);
    assert.deepEqual(body.find('studio-piece').map(piece => /is-open/.test(piece.className)), [true, false]);
    assert.deepEqual(
      [pane().length, pane()[0].attributes.role, pane()[0].attributes['aria-label'], pane()[0].children[0].className, pane()[0].children[0].textContent],
      [1, 'dialog', 'Vidéo à suivre', 'studio-window-title', 'Vidéo à suivre'],
    );
    const fields = () => who().map(field => [field.children[0].textContent, field.children[1].value, field.children[1].placeholder, field.children[1].dataset.ai]);
    assert.deepEqual(fields(), [['Qui remplacer', 'person', 'girl, handkerchief', 'setting-subject']]);
    const foot = () => pane()[0].find('studio-window-foot')[0].children.map(part => [part.className, part.textContent || part.children[0].textContent]);
    assert.deepEqual(foot(), [
      ['studio-window-said', '#ref1 · clip.mp4'],
      ['studio-window-button', 'Changer…'],
      ['studio-window-button', 'Retirer'],
    ]);
    // Each says what it is for in its « ? », as the settings do: at once under the pointer.
    const tipOf = field => field.children[0].children.find(child => /help-tip/.test(child.className)),
      first = tipOf(who()[0]);
    // (0.6.205) Its help beside the window: above its « ? », it covered the name of the window.
    assert.deepEqual([first.textContent, first.tabIndex, first.attributes.role, first.dataset.tipSide], ['?', 0, 'img', 'right']);
    assert.match(first.dataset.help, /« penguin ».*\n.*« girl, handkerchief »/s);
    assert.equal(first.attributes['aria-label'], 'Aide : ' + first.dataset.help);
    // The name and its « ? », nothing else (0.6.92: no mark « Moodix AI peut régler ce paramètre »).
    assert.equal(who()[0].children[0].children.length, 1);
    // The character: its own window, « Qui dessiner »; that of the video is closed.
    cases()[1].onclick();
    assert.deepEqual(cases().map(pick => pick.attributes['aria-expanded']), ['false', 'true']);
    assert.deepEqual([pane().length, pane()[0].attributes['aria-label']], [1, 'Personnage']);
    assert.deepEqual(fields(), [['Qui dessiner', 'person', 'woman', 'setting-reference_subject']]);
    assert.match(tipOf(who()[0]).dataset.help, /décor de l’image est laissé de côté/);
    // A click on its case again closes it.
    cases()[1].onclick();
    assert.deepEqual([pane().length, cases()[1].attributes['aria-expanded']], [0, 'false']);
    // Both given: the wand is ready, even with nothing typed, and hands the two over.
    page.prompt().value = '';
    page.prompt().oninput();
    assert.equal(wand().disabled, false);
    // Drawn again (another model and back), the wand is still ready: the page itself says so.
    page.studio.render();
    assert.equal(wand().disabled, false);
    assert.match(wand().title, /^Écrire le prompt d’après la vidéo et le personnage/);
    await generate();
    // (0.6.253) In the bubble of « Générer » greyed and pressed, no longer on a line under it.
    assert.match(page.said.at(-1), /cliquez sur la baguette/);
    await wand().onclick();
    await settle();
    assert.deepEqual(enriched().at(-1)[1], {
      prompt: '',
      verb: 'replace_character',
      source: { resource: 'r1' },
      reference: { resource: 'r2' },
      // A video or a character made in the conversation is found there.
      conversationId: 'c1',
    });
    assert.equal(page.prompt().value, 'A woman in a white top wipes an apple in an orchard.');
    // Typed in the window of the video; the Studio drawn again meanwhile (a step of a work elsewhere, another
    // format), the window is still open with what was typed.
    cases()[0].onclick();
    const subject = who()[0].children[1];
    subject.value = 'girl, handkerchief';
    subject.oninput();
    page.studio.render();
    assert.deepEqual([pane().length, who()[0].children[1].value], [1, 'girl, handkerchief']);
    await generate();
    const [, action] = sent().at(-1);
    assert.equal(action.name, 'replace_character');
    // The video and the character each alone (not a list); who is drawn is left to its default.
    assert.deepEqual(action.arguments, {
      prompt: 'A woman in a white top wipes an apple in an orchard.',
      intention: 'Personnage remplacé, demandé dans le Studio.',
      source: { resource: 'r1' },
      reference: { resource: 'r2' },
      subject: 'girl, handkerchief',
    });
    // Back to the model of the clips: its own inputs, and its own verb.
    body.find('studio-model-pick')[0].value = 'v';
    body.find('studio-model-pick')[0].onchange();
    // (0.6.202) The video and the character given stay, greyed, for the model that takes them; one line says so.
    assert.deepEqual(blocks(), ['Image de début', 'Gardées pour un autre modèle']);
    assert.deepEqual(
      body.find('studio-kept')[0].children.map(piece => [piece.children[1].textContent, piece.children[0].children[0].title]),
      [
        ['À suivre', 'Vidéo à suivre gardée : Clip ne la prend pas.'],
        ['Sujet', 'Sujet 1 gardé : Clip ne le prend pas.'],
      ],
    );
    assert.equal(body.find('studio-plateau-note')[0].children.at(-1).textContent, 'La vidéo à suivre et le sujet ne partiront pas avec Clip.');
    await generate();
    assert.equal(sent().at(-1)[1].name, 'create_video');
    assert.deepEqual(['source' in sent().at(-1)[1].arguments, 'reference' in sent().at(-1)[1].arguments], [false, false]);
  } finally {
    restore();
  }
});

test('the page module loads and offers the sizes of a format', async () => {
  const { sizeChoices } = await import('../public/studio.mjs');
  const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
  const { sizes, nearest } = sizeChoices({ limits }, '16:9', 768 * 448);
  assert.ok(sizes.length > 2);
  assert.ok(sizes.every(size => size.width > size.height && size.width % 32 === 0 && size.height % 32 === 0));
  assert.ok(Math.abs(nearest.width * nearest.height - 768 * 448) < 768 * 448 * 0.4);
});

test('Krea 2 offers its own sizes in the Studio, two smaller ones less and two larger ones more; another model the common ones (0.6.92)', async () => {
  // As lib/tool-catalog.mjs gives them: the limits of the family, its pipeline as `family`.
  const any = { width: { min: 64, max: 4096, multipleOf: 8 }, height: { min: 64, max: 4096, multipleOf: 8 } },
    model = (id, name, family) => ({
      id,
      name,
      family,
      direct: true,
      seeded: true,
      roles: {},
      limits: any,
      size: { width: 1024, height: 1024 },
      settings: [],
    }),
    clip = { ...model('v', 'LTX 2.5', 'ltx25'), direct: false, limits: sizes, size: { width: 768, height: 448 } };
  const page = await studioPage({
    create_image: [model('k', 'Krea 2', 'krea2'), model('m', 'MOSS Image', 'moss')],
    create_video: [clip],
  });
  const { body, restore } = page;
  const bar = () => body.find('studio-bar').find(item => item.dataset.ai === 'size'),
    // Each notch of the bar in turn, then the one it was on.
    offered = () => {
      const shown = bar(),
        at = shown.value,
        list = [];
      for (let place = 0; place <= Number(shown.max); place++) {
        shown.value = String(place);
        shown.oninput();
        list.push(shown.attributes['aria-valuetext']);
      }
      shown.value = at;
      shown.oninput();
      return list;
    },
    chip = id => body.find('studio-format').find(item => item.children.at(-1)?.textContent === id),
    each = (...list) => list.map(([width, height]) => `${width} × ${height}`),
    common = each([512, 288], [768, 448], [1024, 576], [1344, 768], [1600, 896], [1920, 1088]);
  try {
    // Krea 2 in 1:1 at its own size, 1024 × 1024 as before; from 768 × 768 to 2048 × 2048.
    assert.equal(bar().attributes['aria-valuetext'], '1024 × 1024');
    assert.deepEqual(offered(), each([768, 768], [1024, 1024], [1280, 1280], [1536, 1536], [1792, 1792], [2048, 2048]));
    chip('16:9').onclick();
    assert.equal(bar().attributes['aria-valuetext'], '1344 × 768');
    assert.deepEqual(offered(), each([1024, 576], [1344, 768], [1600, 896], [1920, 1088], [2240, 1248], [2560, 1440]));
    // MOSS Image: the common sizes, the same limits.
    const pick = body.find('studio-model-pick')[0];
    pick.value = 'm';
    pick.onchange();
    assert.deepEqual(offered(), common);
    // A video model: the common sizes it accepts.
    page.mode(1);
    assert.deepEqual(offered(), common);
  } finally {
    restore();
  }
});

test('the format frame keeps the ratio and fits its box, wide or tall', async () => {
  const { frameSize } = await import('../public/studio.mjs');
  const box = { width: 264, height: 176 };
  assert.deepEqual(frameSize(16 / 9, box), { width: 264, height: 149 });
  assert.deepEqual(frameSize(9 / 16, box), { width: 99, height: 176 });
  assert.deepEqual(frameSize(1, box), { width: 176, height: 176 });
  for (const ratio of [16 / 9, 4 / 3, 3 / 2, 1, 2 / 3, 3 / 4, 9 / 16]) {
    const size = frameSize(ratio, box);
    assert.ok(size.width <= box.width && size.height <= box.height);
    assert.ok(Math.abs(size.width / size.height / ratio - 1) < 0.02);
  }
});

test('« Enregistrer » keeps the settings of a model in a file of its own, and gives them with the tools of the Studio', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-preset-'));
  const app = await createApplication({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { readdir } = await import('node:fs/promises');
  const before = await readdir(directory);
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const preset = {
    length: 193 / 24,
    format: '16:9',
    size: '768x448',
    seed: '42',
    styles: [{ name: 'grain.safetensors', strength: 0.8 }],
    loras: { msr: { on: true, strength: 1.2 } },
  };
  const saved = await api('studio/preset', { workflow: 'h3', preset });
  assert.equal(saved.status, 200);
  const kept = (await saved.json()).preset;
  assert.equal(kept.seed, '42');
  assert.ok(kept.savedAt);
  // Given with the tools of the Studio, as kept.
  const studio = await (await api('studio')).json();
  assert.deepEqual(studio.presets.h3.loras, { msr: { on: true, strength: 1.2 } });
  assert.equal(studio.presets.h3.size, '768x448');
  // What is not a setting of the Studio is left out; what is wrong is refused, nothing kept.
  const other = await (
    await api('studio/preset', { workflow: 'ltx', preset: { length: 5, prompt: 'non', steps: 99 } })
  ).json();
  assert.deepEqual(Object.keys(other.preset).sort(), ['length', 'savedAt']);
  assert.equal((await api('studio/preset', { workflow: 'h3', preset: { seed: 'abc' } })).status, 400);
  assert.equal((await api('studio/preset', { workflow: '../x', preset: {} })).status, 400);
  assert.equal((await api('studio/preset', { workflow: 'h3', preset: { size: '768x448' } })).status, 400);
  assert.equal((await (await api('studio')).json()).presets.h3.seed, '42');
  // A file of its own, beside the others (the workflows are not written): both models in it.
  assert.ok(!before.includes('studio-presets.json'));
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(await readFile(join(directory, 'studio-presets.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.models).sort(), ['h3', 'ltx']);
});

test('a style the model does not write in time is said as such, and the model is free again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-style-'));
  const app = await createApplication({
    port: 0,
    dataDir: directory,
    enrichTimeoutMs: 400,
    spawnProcess: (_command, args, options) =>
      spawn(
        process.execPath,
        [fileURLToPath(new URL('./fixtures/fake-engine.mjs', import.meta.url)), ...args],
        options,
      ),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await (await fetch(app.url + '/api/bootstrap?brief=1')).json();
  const api = (route, body) =>
    fetch(app.url + '/api/' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, Buffer.from('GGUF\x03\0\0\0'));
  await api('config', {
    enginePath: process.execPath,
    modelPath,
    projectorPath: '',
    contextSize: 4096,
    maxOutputTokens: 1024,
    gpuLayers: 0,
  });
  assert.equal((await api('start', {})).status, 202);
  for (let tries = 0; tries < 200 && (await (await api('status')).json()).state !== 'ready'; tries++)
    await new Promise(resolve => setTimeout(resolve, 25));
  // The simulated engine never finishes this one, like a model crawling on a shared graphics card.
  // Nothing to enrich is said at once, without asking the model.
  assert.equal((await api('studio/enrich', { prompt: '   ' })).status, 400);
  // A character put in a video: nothing typed is fine, the prompt comes from the two pictures.
  // (This simulated model does not see pictures: said as such, not as « write a few words ».)
  const blind = await api('studio/enrich', {
    prompt: '',
    verb: 'replace_character',
    source: { resource: '11111111-1111-4111-8111-111111111111' },
    reference: { resource: '22222222-2222-4222-8222-222222222222' },
  });
  assert.equal(blind.status, 502);
  assert.match((await blind.json()).error, /ne voit pas les images/);
  assert.equal((await api('studio/enrich', { prompt: '', verb: 'replace_character' })).status, 400);
  const late = await api('studio/enrich', { prompt: 'aquarelle, sans réponse', verb: 'create_image' });
  assert.equal(late.status, 504);
  assert.match((await late.json()).error, /n’a pas répondu en 0 secondes.*carte graphique/);
  const status = await (await api('status')).json();
  assert.deepEqual([status.state, status.busy], ['ready', false]);
});

test('the workflows are listed once for a whole answer, whatever the number of verbs', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const folder = new URL('../runner/workflows/', import.meta.url);
  const workflows = [];
  for (const name of await readdir(folder))
    workflows.push({ ...JSON.parse(await readFile(new URL(name, folder), 'utf8')), ready: true });
  // Each listing checks the files of every workflow: 0.6 s on the machine it was measured on.
  let listed = 0;
  const tools = new ToolCatalog({
    list: async () => {
      listed++;
      return workflows;
    },
  });
  const studio = await tools.studio();
  assert.equal(listed, 1, 'the Studio');
  assert.ok(studio.create_image.length && studio.create_video.length);
  listed = 0;
  const offered = await tools.definitions({ images: 0, resources: [], outputs: [] });
  assert.equal(listed, 1, 'the tools offered to the model');
  assert.ok(offered.length > 1);
  listed = 0;
  assert.ok((await tools.actions()).upscale.length);
  assert.equal(listed, 1, 'the buttons under a creation');
});

test('under the preview: 1:1, 16:9 and 9:16, and a fourth format takes the place of « ··· »', async () => {
  const { shownFormats } = await import('../public/studio.mjs');
  const all = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'];
  assert.deepEqual(shownFormats(all, '16:9'), { main: ['1:1', '16:9', '9:16'], extra: null });
  assert.deepEqual(shownFormats(all, '4:3'), { main: ['1:1', '16:9', '9:16'], extra: '4:3' });
  // A model that cannot make a square shows the two others.
  assert.deepEqual(shownFormats(['16:9', '9:16', '21:9'], '21:9'), { main: ['16:9', '9:16'], extra: '21:9' });
});

test('a proposal of Moodix AI read in the Studio’s terms, with what the assistant may change', async () => {
  const { proposedValues } = await import('../public/studio.mjs');
  const offered = [
    { id: 'ltx', name: 'LTX 2.5', settings: [] },
    { id: 'minimax', name: 'MiniMax H3 Omni', settings: [{ key: 'language' }] },
  ];
  const values = proposedValues(
    {
      tool: 'create_video',
      workflowName: 'MiniMax H3 Omni',
      resolution: { width: 768, height: 448 },
      plan: {
        prompt: 'Un renard se lève',
        stage: 'draft',
        parameters: { width: 768, height: 448, frames: 125, fps: 24, seed: 42, language: 'fr' },
        editable: {
          prompt: true,
          parameters: [
            { key: 'frames', type: 'integer', value: 125, choices: [125, 193] },
            // « Fixe » in the workflow: shown, never changed by the pointer.
            { key: 'width', type: 'integer', value: 768, locked: 'Fixé par le workflow' },
            { key: 'height', type: 'integer', value: 448, locked: 'Fixé par le workflow' },
            { key: 'seed', type: 'integer', value: 42 },
          ],
          references: [[{ role: 'start_image' }, { role: 'reference' }]],
        },
        references: [{ role: 'start_image', resource_id: 'r1', label: 'Renard' }],
      },
    },
    offered,
  );
  assert.equal(values.workflow, 'minimax');
  assert.equal(values.prompt, 'Un renard se lève');
  assert.equal(values.promptFree, true);
  assert.equal(values.format, '16:9');
  assert.equal(values.size, '768x448');
  assert.equal(values.sizeFree, false);
  assert.ok(Math.abs(values.seconds - 125 / 24) < 1e-9);
  assert.equal(values.framesFree, true);
  assert.deepEqual(values.framesChoices, [125, 193]);
  assert.equal(values.seed, 42);
  assert.deepEqual(values.settings, { language: 'fr' });
  assert.deepEqual(values.settingsFree, { language: false });
  assert.equal(values.references.length, 1);
  assert.equal(values.source, null);
  // A continuation: its added length is counted after the overlap with its clip.
  const more = proposedValues(
    {
      tool: 'extend_video',
      workflowName: 'LTX 2.5',
      plan: {
        prompt: 'La suite',
        parameters: { width: 512, height: 288, frames: 73, fps: 24, overlap_frames: 25 },
        editable: { prompt: true, parameters: [] },
        references: [{ role: 'source_video', output_id: 'clip' }],
      },
    },
    offered,
  );
  assert.equal(more.source, 'clip');
  assert.equal(more.seconds, 2);
  assert.deepEqual(more.references, []);
});

test('another mode stops following the size of the frame it leaves', async () => {
  // Just enough of a page for the Studio to draw itself.
  class Element {
    children = [];
    style = {};
    dataset = {};
    classList = { toggle() {}, add() {}, remove() {} };
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute() {}
    removeAttribute() {}
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
  }
  const page = Object.fromEntries(['studio-view', 'studio-kinds', 'studio-body'].map(id => [id, new Element()]));
  const observers = [];
  const globals = {
    document: { getElementById: id => page[id] ?? null, querySelector: () => null },
    Option: class {
      constructor(text, value) {
        Object.assign(this, { textContent: text, value, dataset: {} });
      }
    },
    ResizeObserver: class {
      constructor(callback) {
        Object.assign(this, { callback, watched: null });
        observers.push(this);
      }
      observe(target) {
        this.watched = target;
      }
      disconnect() {
        this.watched = null;
      }
    },
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try {
    const { setupStudio } = await import('../public/studio.mjs');
    const limits = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
    const workflow = (id, media) => ({
      id,
      name: id,
      roles: {},
      limits,
      size: { width: 1024, height: 576 },
      settings: [],
      seeded: true,
      media,
    });
    const info = {
      enabled: true,
      styles: [],
      tools: { create_image: [workflow('i', 'image')], create_video: [workflow('v', 'video')] },
    };
    const studio = setupStudio({
      api: async route => ({ json: async () => (route === 'studio' ? info : { runs: [] }) }),
      node: () => new Element(),
      icon: () => new Element(),
      notice() {},
      assets: {},
      viewOutput() {},
      waitForModel: async () => {},
      blocked: () => '',
      onChange() {},
      conversation: () => 'c1',
    });
    await studio.open();
    // No page of three choices any more: the Studio opens on a mode, Image first.
    assert.equal(page['studio-body'].dataset.mode, 'image');
    assert.deepEqual(
      page['studio-kinds'].children.map(tab => tab.dataset.mode),
      ['image', 'video', 'audio'],
    );
    const following = observers.at(-1);
    assert.ok(following.watched, 'the frame follows its stage');
    page['studio-kinds'].children[1].onclick();
    assert.equal(page['studio-body'].dataset.mode, 'video');
    // Still watched, the stage left was reported once more as it went.
    assert.equal(following.watched, null);
    assert.equal(observers.filter(observer => observer.watched).length, 1);
  } finally {
    Object.assign(globalThis, before);
  }
});

/** A runtime with one image workflow, a chat model and a generator that only note what they are asked. */
function handover({ keepMs, fails = false, tight = false, onRun } = {}) {
  const turn = 'a1111111-1111-4111-8111-111111111111';
  const workflow = {
    schemaVersion: 1,
    id: 'image',
    name: 'Image',
    description: '',
    digest: 'a'.repeat(64),
    mediaType: 'image',
    pipeline: 'krea2',
    enabled: true,
    ready: true,
    parameters: { prompt: { policy: 'model', type: 'string' } },
    references: [],
  };
  const events = [];
  const engine = {
    busy: false,
    state: 'ready',
    stop: async () => {
      events.push('llm stopped');
      engine.state = 'stopped';
    },
    start: async () => {
      events.push('llm started');
      engine.state = 'ready';
    },
  };
  const runtime = new ToolRuntime({
    engine,
    ...(keepMs ? { keepMs } : {}),
    catalog: {
      list: async () => [workflow],
      read: async () => workflow,
      prepare: async () => ({
        workflow,
        job: {
          schemaVersion: 1,
          id: turn,
          pipeline: 'krea2',
          mediaType: 'image',
          workflowId: 'image',
          workflowDigest: workflow.digest,
          parameters: { prompt: 'boat', seed: 1, width: 512, height: 512 },
          components: {},
          loras: [],
          references: [],
        },
        outputNodes: [],
      }),
    },
    gallery: { put: async record => record },
    getConfig: () => ({ enabled: true, autoAllow: false, maxIterations: 5, baseUrl: 'native' }),
    engineConfig: () => ({}),
    clientFactory: () => ({
      status: async () => ({ idle: true }),
      preflight: async () => {},
      run: async (job, options) => {
        events.push('generate');
        await onRun?.(options);
        if (fails) throw Error('Mémoire vidéo insuffisante.');
        return { outputs: [{ filename: 'image.png', subfolder: '', type: 'output' }] };
      },
      // Asked to stay loaded, the generator does so unless main memory is short with its models in it.
      free: async options => {
        const kept = Boolean(options?.keep) && !tight;
        events.push(kept ? 'sources removed' : 'gpu released');
        return kept ? { kept: true } : {};
      },
    }),
  });
  /** One image asked from this conversation, run to its end; `studio`: started in its Studio. */
  async function create(conversationId, { studio = false } = {}) {
    const request = await runtime.request(
      [{ id: 'call', type: 'function', function: { name: 'create_image', arguments: '{"prompt":"boat"}' } }],
      { conversationId, turnId: turn, messages: [] },
    );
    await runtime.execute({ requestId: request.requestId, permission: 'once', ...(studio ? { studio } : {}) });
    await runtime.finished;
    return runtime.status();
  }
  return { runtime, events, create, turn };
}

test('a Studio generation unloads the chat model and leaves it unloaded; a conversation gets it back', async () => {
  for (const studio of [true, false]) {
    const { runtime, events, create, turn } = handover();
    const status = await create(studio ? STUDIO_ID : turn);
    assert.equal(status.state, 'done', status.error);
    assert.deepEqual(
      events,
      studio
        ? // The generator stays loaded for the next creation: only the copies of the sources go.
          ['llm stopped', 'generate', 'sources removed']
        : ['llm stopped', 'generate', 'gpu released', 'llm started'],
    );
    // The chat model is wanted (a message, a style): the card is given back first, once.
    events.length = 0;
    assert.equal(await runtime.yieldGpu(), studio);
    assert.deepEqual(events, studio ? ['gpu released'] : []);
    assert.equal(await runtime.yieldGpu(), false);
    await runtime.close();
  }
});

test('in a conversation, a creation started from its Studio keeps the generator and leaves the chat model unloaded', async () => {
  const { runtime, events, create, turn } = handover();
  const status = await create(turn, { studio: true });
  assert.equal(status.state, 'done', status.error);
  // The user may well make another one at once: nothing reloads, only the copies of the sources go.
  assert.deepEqual(events, ['llm stopped', 'generate', 'sources removed']);
  // The next message of the chat gives the card back first.
  events.length = 0;
  assert.equal(await runtime.yieldGpu(), true);
  assert.deepEqual(events, ['gpu released']);
  await runtime.close();
});

test('the generator a Studio creation left loaded gives the card back by itself after a while', async () => {
  const { runtime, events, create } = handover({ keepMs: 40 });
  await create(STUDIO_ID);
  await create(STUDIO_ID);
  // Two creations in a row: nothing was unloaded between them.
  assert.deepEqual(events, [
    'llm stopped',
    'generate',
    'sources removed',
    'llm stopped',
    'generate',
    'sources removed',
  ]);
  events.length = 0;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(events, ['gpu released']);
  assert.equal(await runtime.yieldGpu(), false);
  await runtime.close();
});

test('a generator that leaves the machine short of main memory is not kept loaded', async () => {
  // A video model: seventeen gigabytes of main memory beside the card, three left out of thirty-two.
  const { runtime, events, create } = handover({ tight: true });
  const status = await create(STUDIO_ID);
  assert.equal(status.state, 'done', status.error);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
  // Nothing is left to give back later, and the chat model still stays away.
  assert.equal(await runtime.yieldGpu(), false);
  assert.deepEqual(events, ['llm stopped', 'generate', 'gpu released']);
  await runtime.close();
});

test('a failed Studio creation, a conversation or closing give the whole card back', async () => {
  // A failure may have left the card full: nothing is kept after it.
  const failed = handover({ fails: true });
  const status = await failed.create(STUDIO_ID);
  assert.equal(status.state, 'error');
  assert.deepEqual(failed.events, ['llm stopped', 'generate', 'gpu released']);
  assert.equal(await failed.runtime.yieldGpu(), false);
  await failed.runtime.close();

  // A creation asked in a conversation ends with the chat model back: what the Studio left
  // loaded leaves before it, with the generator of that creation.
  const mixed = handover();
  await mixed.create(STUDIO_ID);
  mixed.events.length = 0;
  await mixed.create(mixed.turn);
  assert.deepEqual(mixed.events, ['llm stopped', 'generate', 'gpu released', 'gpu released', 'llm started']);
  await mixed.runtime.close();

  // Closing the application does not leave the generator holding the card.
  const closed = handover();
  await closed.create(STUDIO_ID);
  closed.events.length = 0;
  await closed.runtime.close();
  assert.deepEqual(closed.events, ['gpu released']);
});

test('the picture the generator has so far is kept one at a time, and dropped with the job', async () => {
  const first = { bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg' },
    second = { bytes: Buffer.from([0xff, 0xd8, 0xff, 2]), mime: 'image/jpeg' };
  let during;
  const { runtime, create } = handover({
    onRun: ({ onProgress }) => {
      onProgress({ stage: 'generating', step: 1, total: 8 });
      const before = runtime.status();
      onProgress({ preview: first });
      onProgress({ preview: second });
      const { id, preview, progress } = runtime.status();
      during = { before: before.preview, preview, progress, kept: runtime.preview(id), other: runtime.preview('x') };
    },
  });
  const status = await create(STUDIO_ID);
  // Its number only goes with the status; the bytes are asked for apart, for this job alone.
  assert.equal(during.before, undefined);
  assert.equal(during.preview, 2);
  assert.deepEqual(during.kept, { ...second, seq: 2 });
  assert.equal(during.other, null);
  // A picture is not a stage of the work: the progress line is not touched by it.
  assert.doesNotMatch(String(during.progress), /preview|object/i);
  // Once the creation is there, nothing of it stays in memory.
  assert.equal(status.preview, undefined);
  assert.equal(runtime.preview(status.id), null);
  await runtime.close();
});

/** A page that remembers what each element is, with the Studio set up in it; `routes` answers its requests. */
async function studioPage(tools, routes = {}, options = {}) {
  class Element {
    constructor(tag = '', className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, children: [], style: {}, dataset: {} });
      this.classList = { toggle() {}, add() {}, remove() {} };
      // (0.6.261) An image as a browser has it (options.pageAddress): an empty address reads as the address of the page.
      if (tag === 'img' && options.pageAddress) {
        let address;
        Object.defineProperty(this, 'src', {
          enumerable: true,
          get: () => (address === undefined ? '' : address === '' ? options.pageAddress : address),
          set: value => (address = String(value)),
        });
      }
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
    add(option) {
      this.children.push(option);
    }
    setAttribute(name, value) {
      (this.attributes ??= {})[name] = value;
    }
    removeAttribute(name) {
      delete this.attributes?.[name];
    }
    querySelector() {
      return new Element();
    }
    querySelectorAll() {
      return [];
    }
    addEventListener(type, listener) {
      (this.listeners ??= {})[type] = listener;
    }
    click() {
      this.clicks = (this.clicks ?? 0) + 1;
    }
    /** Every element under this one whose classes include `name`. */
    find(name) {
      return this.children.flatMap(child =>
        child instanceof Element
          ? [...(child.className.split(' ').includes(name) ? [child] : []), ...child.find(name)]
          : [],
      );
    }
  }
  const page = Object.fromEntries(
    ['studio-view', 'studio-kinds', 'studio-body', 'ai-status', 'ai-takeover'].map(id => [id, new Element()]),
  );
  // The pointer of Moodix AI (options.cursor: the list where what it says is written).
  if (options.cursor) {
    const classes = new Set();
    page['ai-cursor'] = {
      hidden: true,
      style: { setProperty() {} },
      classList: {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: name => classes.has(name),
      },
      querySelector: () => null,
    };
    page['ai-cursor-text'] = {
      set textContent(label) {
        if (label) options.cursor.push(label);
      },
    };
  }
  // What the page itself listens to: keys pressed with the focus on no field.
  const pageKeys = [],
    pagePointers = [];
  const globals = {
    document: {
      getElementById: id => page[id] ?? null,
      // A setting the pointer goes to (options.targets): somewhere on the page. (options.querySelector:
      // the page a test lays out itself, 0.6.102.)
      querySelector: options.querySelector
        ? options.querySelector
        : options.targets
        ? () => ({
            getBoundingClientRect: () => ({ left: 100, top: 100, width: 40, height: 40 }),
            scrollIntoView() {},
            style: { setProperty() {} },
            // « Générer » itself, while a creation it started runs.
            classList: { toggle() {} },
            querySelector: () => null,
            setAttribute() {},
          })
        : () => null,
      body: {},
      addEventListener: (type, listener) =>
        type === 'keydown' ? pageKeys.push(listener) : type === 'pointerdown' && pagePointers.push(listener),
    },
    Option: class {
      constructor(text, value) {
        Object.assign(this, { textContent: text, value, dataset: {} });
      }
    },
    ResizeObserver: undefined,
  };
  const before = Object.fromEntries(Object.keys(globals).map(key => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  const { setupStudio } = await import('../public/studio.mjs');
  const asked = [],
    notices = [],
    revealed = [],
    said = [];
  let imported = 0;
  const runs = options.runs ?? [];
  const studio = setupStudio({
    api: async (route, body) => {
      asked.push([route, body]);
      return {
        json: async () =>
          route === 'studio'
            ? {
                enabled: true,
                styles: ['a.safetensors', 'b.safetensors'],
                tools,
                presets: options.presets ?? {},
              }
            : route.startsWith('gallery/') || route.startsWith('project-gallery/')
              ? {
                  runs: route.includes(STUDIO_ID) ? (options.legacy ?? []) : runs,
                  ...(options.nextTake ? { nextTake: options.nextTake } : {}),
                }
              : (routes[route]?.(body) ?? {}),
      };
    },
    node: (tag, className, text) => new Element(tag, className, text),
    icon: glyph => Object.assign(new Element('svg'), { glyph }),
    notice: text => notices.push(text),
    // Each file dropped becomes a reference of the project, with its own preview.
    assets: {
      importFiles: async (files, kept) => {
        importedInto.push(kept?.project);
        return files.map(file => ({
          id: 'r' + ++imported,
          label: '#ref' + imported,
          name: file.name,
          previewUrl: '/preview/' + file.name,
          width: 1280,
          height: 720,
        }));
      },
      resource: options.resource ?? (id => ({ previewUrl: '/preview/' + id })),
    },
    viewOutput: options.viewOutput ?? (() => {}),
    waitForModel: options.waitForModel ?? (async () => {}),
    blocked: () => '',
    onChange() {},
    // `null`: a conversation not begun; nothing said, « c1 ».
    conversation: () => (options.conversation?.() === null ? null : (options.conversation?.() ?? 'c1')),
    ...(options.project ? { project: options.project } : {}),
    ensureConversation: async () => options.conversation?.() ?? 'c1',
    reveal: () => revealed.push(true),
    pace: 0,
    ...(options.run ? { run: options.run } : {}),
    ...(options.openAgent ? { openAgent: options.openAgent } : {}),
    ...(options.openStudio ? { openStudio: options.openStudio } : {}),
    // (0.6.253) The bubble shown at once by « Générer » greyed and pressed: what it says then.
    sayTip: element => said.push(element.title),
    // What else a test gives it (0.6.81: onWork, elsewhere, nameOf).
    ...(options.extra ?? {}),
  });
  if (options.open !== false) await studio.open();
  return {
    studio,
    page,
    body: page['studio-body'],
    asked,
    notices,
    revealed,
    said,
    pageKeys,
    pagePointers,
    runs,
    restore: () => Object.assign(globalThis, before),
    /** Opens a mode by its place among Image, Vidéo and Son. */
    mode: index => page['studio-kinds'].children[index].onclick(),
    /** The prompt of the Entrée block. */
    prompt: () => page['studio-body'].find('studio-prompt-field')[0].children[0],
  };
}
const sizes = { width: { min: 256, max: 2048, multipleOf: 32 }, height: { min: 256, max: 2048, multipleOf: 32 } };
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
/** What the screen shows: an image, or a clip, in a box of its own with the player of a take (0.6.97). */
const screenOf = shown => (String(shown?.className ?? '').includes('studio-frame-clip') ? shown.children[0] : shown);

test('Image, Vidéo and Son at the top of the screen: icons named, there from the start, opening the Studio in their mode', async () => {
  const image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] };
  const opened = [];
  const { page, body, restore } = await studioPage(
    { create_image: [image], create_video: [video] },
    {},
    { open: false, openStudio: () => opened.push(true) },
  );
  try {
    // Drawn before the Studio is ever opened: the sidebar shows them from the Chat too.
    const tabs = page['studio-kinds'].children;
    assert.deepEqual(
      tabs.map(tab => [tab.attributes.role, tab.attributes['aria-label'], tab.title, tab.children.at(-1).textContent]),
      [
        ['tab', 'Image', 'Image', 'Image'],
        ['tab', 'Vidéo', 'Vidéo', 'Vidéo'],
        ['tab', 'Son', 'Son', 'Son'],
      ],
      'an icon each and its name (shown beside it for the one chosen), for screen readers and in its tooltip',
    );
    assert.equal(tabs[0].attributes['aria-selected'], 'true');
    // From the Chat: the mode is chosen as the selector of the Studio did, and the Studio opens.
    tabs[1].onclick();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(opened.length, 1);
    // In the Studio: the mode changes, nothing else opens.
    globalThis.document.body.dataset = { view: 'studio' };
    tabs[0].onclick();
    assert.equal(body.dataset.mode, 'image');
    assert.equal(opened.length, 1);
    // The arrows go from one mode to the next, along the row or down the column.
    page['studio-kinds'].onkeydown({ key: 'ArrowDown', preventDefault() {} });
    assert.equal(body.dataset.mode, 'video');
    page['studio-kinds'].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.equal(body.dataset.mode, 'image');
    // (0.6.148) No fourth mode any more: the Bobine (ex-Montage) is a page of its own. The arrows go
    // round the three: before Image is Son, after Son is Image.
    assert.equal(tabs.length, 3);
    page['studio-kinds'].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
    assert.equal(body.dataset.mode, 'audio');
    assert.deepEqual(tabs.map(tab => tab.attributes['aria-selected']), ['false', 'false', 'true']);
    page['studio-kinds'].onkeydown({ key: 'ArrowRight', preventDefault() {} });
    assert.equal(body.dataset.mode, 'image');
    assert.doesNotMatch(String(body.children[0].className), /is-montage/);
  } finally {
    restore();
  }
});

test('the last creation stays on the screen; another conversation starts from an empty screen', async () => {
  const workflow = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const made = { id: 'r1', prompt: 'un phare', outputs: [{ originalUrl: '/media/generated/phare' }] };
  const opened = [];
  let conversation = 'c1';
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // The creation is made at once, and listed by the gallery from then on.
        page.runs.unshift(made);
        return { id: 'j', state: 'done', record: made };
      },
    },
    { viewOutput: record => opened.push(record.id), conversation: () => conversation },
  );
  const { body, studio, asked, restore } = page;
  try {
    assert.deepEqual(body.find('studio-frame-result'), [], 'an empty screen to begin with');
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    // Made in the conversation, as a creation of its Studio.
    const [, action] = asked.find(([route]) => route === 'tools/action');
    assert.equal(action.conversationId, 'c1');
    assert.equal(action.studio, true);
    assert.equal(asked.find(([route]) => route === 'tools/execute')[1].studio, true);
    const [kept] = body.find('studio-frame-result');
    assert.equal(kept.tag, 'img');
    assert.equal(kept.src, '/media/generated/phare');
    assert.match(body.find('studio-frame')[0].className, /has-result/);
    // A click shows it whole, with its settings.
    kept.onclick();
    assert.deepEqual(opened, ['r1']);
    // In the Sortie, without a count (moodix-design.md 23); on the screen still after a visit of the chat.
    assert.equal(body.find('studio-item').length, 1);
    assert.deepEqual(body.find('studio-count'), []);
    // A creation is shown as it is, with no grain over it; its actions sit on its picture, so the
    // Sortie keeps its height. No title on the blocks: their colour says what they are for.
    assert.deepEqual(body.find('picture-grain'), []);
    assert.equal(body.find('studio-item')[0].find('studio-item-del').length, 1);
    assert.deepEqual(body.find('studio-block-title'), []);
    await studio.open();
    assert.equal(body.find('studio-frame-result').length, 1);
    // Another conversation: its own Studio, an empty screen.
    conversation = 'c2';
    page.runs.length = 0;
    await studio.open();
    assert.deepEqual(body.find('studio-frame-result'), []);
    assert.equal(body.find('studio-item').length, 0);
  } finally {
    restore();
  }
});

test('« Ouvrir » on a card puts the creation on the screen of its mode', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    roles: {},
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
  };
  const clip = { id: 'c', mediaType: 'video', prompt: 'un renard', outputs: [{ originalUrl: '/clip.mp4' }] },
    picture = { id: 'p', prompt: 'un terrier', outputs: [{ originalUrl: '/p.png' }] };
  const opened = [];
  const { studio, body, restore } = await studioPage(
    { create_video: [video] },
    {},
    { runs: [picture, clip], viewOutput: record => opened.push(record.id) },
  );
  try {
    // The Studio opens on the mode of the newest take of the conversation: an image.
    assert.equal(body.dataset.mode, 'image');
    studio.show(clip);
    assert.equal(body.dataset.mode, 'video');
    const [box] = body.find('studio-frame-result'),
      shown = screenOf(box);
    assert.equal(shown.tag, 'video');
    // Its picture and a round play button (capture 22), the player of a take opened over it: never the
    // browser's controls, not even once it plays (0.6.97).
    assert.equal(shown.controls, false);
    assert.equal(body.find('take-play').length, 1);
    assert.equal(box.find('take-player').length, 1, 'the player is with the clip, in its box');
    let played = 0;
    shown.play = () => {
      played++;
      return Promise.resolve();
    };
    shown.paused = true;
    body.find('take-play')[0].onclick();
    assert.equal(played, 1, 'a clip plays on the screen');
    assert.equal(shown.controls, false);
    // « Voir en grand »: the take in its window.
    body.find('take-player-expand')[0].onclick();
    assert.deepEqual(opened, ['c']);
    assert.match(body.find('studio-item').find(tile => tile.dataset.id === 'c').className, /is-shown/);
  } finally {
    restore();
  }
});

test('the screen takes the format chosen, the take whole in it, « PRISE n » on it; while one is made, the number to come', async () => {
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true };
  // A square clip while 16:9 is the format chosen: the screen is 16:9, the clip whole inside (16/11).
  const clip = {
    id: 'c',
    mediaType: 'video',
    prompt: 'un renard',
    outputs: [{ originalUrl: '/clip.mp4', take: 4 }],
    parameters: { width: 512, height: 512, frames: 145, fps: 24 },
  };
  let page = await studioPage({ create_video: [video] }, {}, { runs: [clip] });
  try {
    const { studio, body } = page;
    studio.show(clip);
    const [frame] = body.find('studio-frame');
    const [width, height] = [frame.style.width, frame.style.height].map(value => parseFloat(value));
    assert.ok(Math.abs(width / height - 16 / 9) < 0.02, `16:9 with a square take in it (${width} × ${height})`);
    const [label] = body.find('studio-frame-label');
    assert.equal(label.textContent, 'PRISE 4');
    assert.equal(label.className, 'studio-frame-label is-take');
    // The same take is what Moodix AI is told the user has on their screen (app.js, `screen`).
    assert.deepEqual(studio.screenTake(), { take: 4, media: 'video' });
    // The readout says the format chosen, which the screen has.
    assert.match(body.find('studio-readout')[0].textContent, /^16:9/);
  } finally {
    page.restore();
  }
  // While a take is made: the number it will have (the counter of the project), in the accent.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  let finish;
  page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'running', progress: 'Génération…' }),
      'tools/job': () =>
        new Promise(resolve => {
          finish = () => resolve({ id: 'j', state: 'error', error: 'rien' });
        }),
    },
    { runs: [{ id: 'p', prompt: 'un phare', outputs: [{ originalUrl: '/p.png', take: 30 }] }], nextTake: 32 },
  );
  try {
    const { body } = page;
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    const made = body.find('studio-go')[0].onclick();
    // Asked for its state after a pause of the Studio (0,7 s).
    for (let tries = 0; !finish && tries < 120; tries++) await settle();
    const [label] = body.find('studio-frame-label');
    assert.equal(label.textContent, 'PRISE 32', 'its counter, not the last take + 1 (a take deleted keeps its number)');
    assert.equal(label.className, 'studio-frame-label is-take is-coming');
    // A take being made is not one the user can speak of yet.
    assert.equal(page.studio.screenTake(), null);
    finish();
    await made;
    await settle();
    assert.equal(body.find('studio-frame-label')[0].textContent, 'PRISE 30', 'done: the last take again');
    assert.deepEqual(page.studio.screenTake(), { take: 30, media: 'image' });
  } finally {
    page.restore();
  }
});

test('in the Sortie a clip is a strip as long as it lasts, a sound a card', async () => {
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    sound = { id: 'a', name: 'ACE-Step', roles: {}, settings: [{ key: 'seconds', default: 30 }] },
    runs = [
      {
        id: 'song',
        mediaType: 'audio',
        workflowName: 'ACE-Step 1.5',
        prompt: 'Brume d’automne\nau piano',
        outputs: [{ originalUrl: '/song.wav', take: 9 }],
        parameters: { seconds: 105 },
      },
      { id: 'rain', mediaType: 'audio', workflowName: 'MOSS-SFX', prompt: 'La pluie', outputs: [{ originalUrl: '/rain.wav' }], parameters: { seconds: 8 } },
      {
        id: 'clip',
        mediaType: 'video',
        prompt: 'un renard',
        outputs: [{ originalUrl: '/clip.mp4', thumbUrl: '/clip.jpg', take: 7 }],
        parameters: { width: 448, height: 768, frames: 145, fps: 24 },
      },
    ];
  const page = await studioPage({ create_video: [video], create_audio: [sound] }, {}, { runs });
  try {
    const { body } = page;
    // The Sortie shows them all, whatever the mode (16/11): the clip a strip, the sounds cards.
    page.mode(1);
    const strip = body.find('studio-item').find(tile => tile.dataset.id === 'clip');
    assert.equal(strip.dataset.media, 'video');
    assert.doesNotMatch(strip.className, /is-sound/);
    page.mode(2);
    const cards = body.find('studio-item').filter(tile => tile.dataset.media === 'audio');
    assert.deepEqual(cards.map(card => card.dataset.id), ['song', 'rain']);
    assert.match(cards[0].className, /is-sound/);
    assert.deepEqual(
      cards.map(card => card.find('studio-sound-head')[0].children.map(part => part.textContent)),
      [
        ['PRISE 9 · 1:45', 'MUSIQUE'],
        ['#2 · 08.00 S', 'BRUITAGE'],
      ],
    );
    assert.deepEqual(cards.map(card => card.find('studio-sound-name')[0].textContent), ['Brume d’automne', 'La pluie']);
  } finally {
    page.restore();
  }
});

test('the creations of the former Studio are no longer shown, nothing chooses them; empty, the Sortie says so', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const old = { id: 'o', prompt: 'avant', outputs: [{ originalUrl: '/old.png' }] };
  const { body, restore } = await studioPage({ create_image: [image] }, {}, { legacy: [old] });
  try {
    // moodix-design.md 7 bis 7: no « Cette conversation / Ancien Studio »; their files stay in output.
    assert.deepEqual(body.find('studio-source-pick'), []);
    assert.equal(body.find('studio-item').length, 0);
    // What the Sortie will hold, in words alone (etats-maquette.md, 55).
    const [empty] = body.find('studio-empty-strip');
    assert.equal(empty.children[0].textContent, 'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.');
  } finally {
    restore();
  }
});

test('the Sortie: pictures only, the newest at the left with the largest number, their actions on them', async () => {
  const image = {
      id: 'i',
      name: 'Image',
      styled: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
      roles: { source: { count: 1, media: ['image'] } },
    },
    video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'] } },
      exclusive: [['start_image'], ['reference']],
    },
    runs = [
      {
        id: 'p2',
        prompt: 'un phare',
        outputs: [{ originalUrl: '/p2.png' }],
        parameters: { width: 1024, height: 1024 },
      },
      {
        id: 'c2',
        mediaType: 'video',
        prompt: 'la suite',
        outputs: [{ originalUrl: '/c2.mp4' }],
        parameters: { references: [{ role: 'source_video', output_id: 'c1' }] },
      },
      {
        id: 'p1',
        prompt: 'un renard',
        outputs: [{ originalUrl: '/p1.png' }],
        parameters: { width: 1024, height: 1024 },
      },
      { id: 'c1', mediaType: 'video', prompt: 'un renard qui court', outputs: [{ originalUrl: '/c1.mp4' }] },
    ];
  const opened = [];
  const { body, restore, mode, asked } = await studioPage(
    { create_image: [image], create_video: [video] },
    {},
    { runs, viewOutput: record => opened.push(record.id) },
  );
  try {
    const items = () => body.find('studio-item'),
      numbers = () => body.find('studio-item-number').map(badge => badge.textContent),
      references = () => body.find('studio-slot-badge').map(badge => badge.textContent);
    // Its button released: the kind of the mode only.
    body.find('studio-sort-go')[0].onclick();
    // The kind of the mode (16/11), the newest at the left, numbered with the others (never two
    // « #1 »); under each its number (« PRISE n » once it has one), a continuation « ↳ SUITE »
    // (studio-maquette.md); no title (their names are for screen readers and in their tooltips).
    assert.deepEqual(numbers(), ['#4', '#2']);
    assert.deepEqual(body.find('studio-item-title'), []);
    assert.deepEqual(body.find('studio-caption'), []);
    // (0.6.198) Its name as its badge says it, « #4 » without a number of take (« Image #4 » before).
    assert.equal(items()[0].find('studio-item-pick')[0].attributes['aria-label'], '#4 · un phare');
    // The wheel scrolls it sideways, the pointer anywhere over it; a sideways move is the
    // browser's, and nothing moves when all of it shows.
    const [sortie] = body.find('is-output'),
      [strip] = body.find('studio-strip');
    Object.assign(strip, { scrollLeft: 0, scrollWidth: 1200, clientWidth: 400 });
    let stopped = 0;
    const wheel = (deltaY, deltaX = 0, deltaMode = 0) =>
      sortie.onwheel({ deltaY, deltaX, deltaMode, preventDefault: () => stopped++ });
    wheel(100);
    wheel(3, 0, 1);
    assert.equal(strip.scrollLeft, 220);
    assert.equal(stopped, 2);
    wheel(10, 80);
    assert.equal(strip.scrollLeft, 220);
    strip.scrollWidth = 400;
    wheel(100);
    assert.deepEqual([strip.scrollLeft, stopped], [220, 2]);
    // In Vidéo, the clips.
    mode(1);
    assert.deepEqual(numbers(), ['↳ SUITE', '#1']);
    // A clip: its continuation said too; « Prolonger » is its round button; no « Lire ».
    assert.equal(
      items()[0].find('studio-item-pick')[0].attributes['aria-label'],
      '#3 · suite de #1 · la suite',
    );
    assert.equal(items()[0].find('studio-item-main')[0].attributes['aria-label'], 'Prolonger · #3');
    assert.deepEqual(body.find('studio-play'), []);
    // The screen shows the last clip; it is ringed in the Sortie.
    assert.match(items()[0].className, /is-shown/);
    assert.doesNotMatch(items()[1].className, /is-shown/);
    // A click shows it whole with its details; the screen keeps the last clip. No « i » on the picture.
    items()[1].find('studio-item-pick')[0].onclick();
    assert.deepEqual(opened, ['c1']);
    assert.match(items()[0].className, /is-shown/);
    assert.deepEqual(body.find('studio-item-info'), []);
    // A right click: every action in a menu; « Ouvrir » is the same view (« Détails » before 0.6.198);
    // « Supprimer » asks on the picture before anything goes.
    items()[0].oncontextmenu({ preventDefault() {} });
    body.find('studio-item-menu')[0].children[1].onclick();
    assert.deepEqual(opened, ['c1', 'c2']);
    items()[0].oncontextmenu({ preventDefault() {} });
    const [menu] = body.find('studio-item-menu');
    assert.equal(menu.attributes.role, 'menu');
    assert.deepEqual(
      menu.children.map(entry => entry.children.at(-1).textContent),
      ['Prolonger', 'Ouvrir', 'Supprimer'],
    );
    menu.children[2].onclick();
    assert.deepEqual(body.find('studio-item-menu'), []);
    const [ask] = body.find('studio-item-confirm');
    assert.equal(ask.attributes.role, 'alertdialog');
    // (0.6.200) Its short form for a take too narrow for it (moodix.css, a container of its width): « Supprimer ? »,
    // the take named under the picture and to a screen reader (check of 21/11, overload, point G).
    const [brief] = ask.find('studio-confirm-brief');
    assert.deepEqual([brief.textContent, brief.attributes['aria-hidden']], ['Supprimer\u00a0?', 'true']);
    assert.equal(ask.find('studio-confirm-text')[0].textContent, 'Supprimer #3\u00a0?');
    // ✕ keeps it.
    ask.find('studio-confirm-no')[0].onclick();
    assert.deepEqual(body.find('studio-item-confirm'), []);
    assert.equal(asked.filter(([route]) => route === 'studio/delete').length, 0);
    // A reply of the chat named a take meanwhile (cited-takes.mjs): the project was read for it, once.
    let reads = 0;
    const cited = setupCitedTakes({
        node: () => assert.fail('nothing to draw'),
        icon: () => null,
        load: async () => (reads++, []),
        project: () => 'p1',
        references: () => [],
        viewOutput() {},
      }),
      reply = { body: {} };
    cited.show(reply, 'la prise 99');
    await settle();
    cited.show(reply, 'la prise 99.');
    await settle();
    assert.equal(reads, 1);
    // The bin, then the light one: it goes.
    items()[0].find('studio-item-del')[0].onclick();
    body.find('studio-confirm-yes')[0].onclick();
    await settle();
    assert.equal(asked.find(([route]) => route === 'studio/delete')[1].id, 'c2');
    // What the replies read of the project is forgotten with it: the next one that names a take
    // reads the project again, and no longer draws the take deleted.
    cited.show(reply, 'la prise 99.');
    await settle();
    assert.equal(reads, 2);

    // « Animer »: (0.6.256, lot 4) the picture goes to the start (« Début ») of the first video model that takes one,
    // in place of the one there: never to its references any more (the video did not start from it).
    const start = () => body.find('studio-slot').find(tile => tile.dataset.slot === 'start_image-0')?.children[0]?.children[0]?.src ?? null,
      subjects = () => body.find('studio-slot').filter(tile => tile.dataset.slot?.startsWith('reference-') && tile.className.includes('is-filled')).length;
    mode(0);
    assert.equal(items()[0].find('studio-item-main')[0].attributes['aria-label'], 'Animer · #4');
    items()[0].find('studio-item-main')[0].onclick();
    assert.equal(body.dataset.mode, 'video');
    assert.deepEqual([start(), subjects()], ['/p2.png', 0]);
    mode(0);
    items()[0].find('studio-item-main')[0].onclick();
    assert.deepEqual([start(), subjects()], ['/p2.png', 0], 'there already: the same');
    mode(0);
    items()[1].find('studio-item-main')[0].onclick();
    assert.deepEqual([start(), subjects()], ['/p1.png', 0], 'in place of the one there');
    // An image's menu keeps « Modifier » (a model of images takes one to start from).
    mode(0);
    items()[0].oncontextmenu({ preventDefault() {} });
    assert.deepEqual(
      body.find('studio-item-menu')[0].children.map(entry => entry.children.at(-1).textContent),
      ['Animer', 'Modifier', 'Ouvrir', 'Supprimer'],
    );
  } finally {
    restore();
  }
});

// (0.6.194, audit of 21/11) The gestures of the menus of the Studio, as those of the other menus.
const menuImage = {
  id: 'i',
  name: 'Image',
  styled: true,
  limits: sizes,
  size: { width: 1024, height: 1024 },
  settings: [],
  seeded: true,
  roles: { source: { count: 1, media: ['image'] } },
};

test('the menu of a take closes on a press beside it, and when the focus leaves it for another control (0.6.194)', async () => {
  // (A6: its focus gone, or never in it, the menu of a right click stayed open whatever was clicked; only
  // Échap closed it, with its focus still in it. `onfocusout` is no property of an element in Chromium.)
  let shown = null;
  const removed = [];
  const { studio, body, restore, pagePointers } = await studioPage(
    { create_image: [menuImage] },
    {},
    {
      runs: [{ id: 'p1', prompt: 'un phare', outputs: [{ originalUrl: '/p1.png' }], parameters: { width: 1024, height: 1024 } }],
      // The page: the menu as the Studio drew it.
      querySelector: selector => (selector === '#studio-view .studio-item-menu' ? shown : null),
    },
  );
  try {
    const menus = () => body.find('studio-item-menu'),
      press = target => pagePointers.forEach(listener => listener({ target })),
      open = () => {
        body.find('studio-item')[0].oncontextmenu({ preventDefault() {} });
        [shown] = menus();
        shown.remove = () => removed.push(shown);
      };
    open();
    // A press in it (one of its actions): it stays.
    press({ closest: selector => (selector === '.studio-item-menu' ? shown : null) });
    assert.deepEqual(removed, []);
    // Beside it, anywhere on the page: closed at once where it is (the Studio is not drawn again under
    // the pointer: the click goes to what was pressed), and left out of the next drawing.
    press({ closest: () => null });
    assert.deepEqual(removed, [shown]);
    studio.render();
    assert.deepEqual(menus(), []);
    // Nothing open: a press closes nothing.
    press({ closest: () => null });
    assert.equal(removed.length, 1);
    // The focus gone to another control (Tab): closed where it is, the focus left where it went. To one
    // of its actions, or nowhere (drawn again, its button taken out of the page), it stays.
    open();
    const entry = {};
    shown.contains = node => node === entry;
    shown.listeners.focusout({ relatedTarget: entry });
    shown.listeners.focusout({ relatedTarget: null });
    assert.equal(removed.length, 1);
    shown.listeners.focusout({ relatedTarget: {} });
    assert.equal(removed.length, 2);
    studio.render();
    assert.deepEqual(menus(), []);
  } finally {
    restore();
  }
});

test('« ··· » of the formats closes with Échap too, the focus back on it (0.6.194)', async () => {
  // (B14: a click beside it closed it, Échap did nothing; every other menu of the page closes with it.)
  let menu = null,
    more = null,
    dialog = null;
  const { studio, body, restore, pageKeys } = await studioPage(
    { create_image: [menuImage] },
    {},
    {
      querySelector: selector =>
        selector === '#studio-view .studio-format-menu'
          ? menu
          : selector === '#studio-view .studio-format.is-more'
            ? more
            : selector === 'dialog[open]'
              ? dialog
              : null,
    },
  );
  try {
    let focused = 0;
    const take = () => {
        [menu] = body.find('studio-format-menu');
        more = body.find('studio-format').find(chip => chip.className.includes('is-more'));
        more.focus = () => focused++;
      },
      key = name => {
        let taken = 0;
        pageKeys.forEach(listener => listener({ key: name, target: {}, preventDefault: () => taken++ }));
        return taken;
      };
    take();
    more.onclick();
    assert.deepEqual([menu.hidden, more.attributes['aria-expanded']], [false, 'true']);
    // Another key: it stays open.
    assert.deepEqual([key('ArrowDown'), menu.hidden], [0, false]);
    // A window open over the page has Échap: it stays open under it.
    dialog = {};
    assert.deepEqual([key('Escape'), menu.hidden], [0, false]);
    dialog = null;
    // Échap: closed, the focus back on « ··· », the key taken (the chat opened over the Studio stays).
    assert.equal(key('Escape'), 1);
    assert.deepEqual([menu.hidden, more.attributes['aria-expanded'], focused], [true, 'false', 1]);
    // Drawn again, it stays closed; Échap with nothing open is left to the page.
    studio.render();
    take();
    assert.deepEqual([menu.hidden, more.attributes['aria-expanded'], key('Escape')], [true, 'false', 0]);
  } finally {
    restore();
  }
});

test('in the Sortie, an upscale or an interpolation of a clip is said so, with its whole length, not « ↳ SUITE »', async () => {
  const video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] } },
    },
    from = id => [{ role: 'source_video', output_id: id }],
    runs = [
      // Made from a clip that is not in the Sortie (a file of the disk, a take deleted since): an
      // interpolation with no number of take yet, an upscale with one.
      {
        id: 'c6',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c6.mp4' }],
        parameters: { pipeline: 'rife', mode: 'smooth', frames: 241, fps: 48, references: from('gone') },
      },
      {
        id: 'c5',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c5.mp4', take: 25 }],
        parameters: { pipeline: 'realesrgan_video', frames: 121, fps: 24, references: from('gone') },
      },
      // Interpolated from the upscale, then a real continuation of it, then the upscale of the first.
      {
        id: 'c4',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c4.mp4', take: 24 }],
        parameters: { pipeline: 'ltx25', frames: 121, fps: 24, overlap_frames: 25, references: from('c3') },
      },
      {
        id: 'c3',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c3.mp4', take: 23 }],
        parameters: { pipeline: 'rife', mode: 'smooth', frames: 241, fps: 48, references: from('c2') },
      },
      {
        id: 'c2',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c2.mp4', take: 22 }],
        parameters: { pipeline: 'realesrgan_video', frames: 121, fps: 24, references: from('c1') },
      },
      {
        id: 'c1',
        mediaType: 'video',
        prompt: 'un renard qui court',
        outputs: [{ originalUrl: '/c1.mp4', take: 21 }],
        parameters: { pipeline: 'ltx25', frames: 121, fps: 24 },
      },
    ];
  const { body, restore, mode } = await studioPage({ create_video: [video] }, {}, { runs });
  try {
    body.find('studio-sort-go')[0].onclick();
    mode(1);
    const items = body.find('studio-item'),
      captions = items.map(item => item.find('studio-item-caption')[0].children.map(part => part.textContent));
    assert.deepEqual(captions, [
      // Without the clip it was made from, « ↳ » would point at nothing: its own number, as any take.
      ['#6', '05.02 S'],
      ['PRISE 25', '05.04 S'],
      ['↳ SUITE', '+04.00 S'],
      ['↳ INTERPOLÉE', '05.02 S'],
      ['↳ AGRANDIE', '05.04 S'],
      ['PRISE 21', '05.04 S'],
    ]);
    assert.deepEqual(
      items.slice(0, 5).map(item => item.find('studio-item-pick')[0].attributes['aria-label']),
      [
        // What it is stays said to a screen reader, without a clip it cannot name. (0.6.198) Each by the
        // number of its take, as its badge, and the clip it comes from by its own (« Clip #4 · suite du
        // clip #3 » before: their places in the Sortie, while the badges said « PRISE 24 », « PRISE 23 »).
        '#6 · interpolation · un renard qui court',
        'Prise 25 · agrandissement · un renard qui court',
        'Prise 24 · suite de la prise 23 · un renard qui court',
        'Prise 23 · interpolation de la prise 22 · un renard qui court',
        'Prise 22 · agrandissement de la prise 21 · un renard qui court',
      ],
    );
  } finally {
    restore();
  }
});

test('(0.6.198) a take of the Sortie is said « Prise n », as its badge shows it; « Ouvrir » and « Animer » say what the bar of a take says', async () => {
  // (Vérification du 21/11, B1, B3, B4) Its badge said « PRISE 4 », its bubble and its name « Clip #4 », its
  // place in the Sortie; its menu « Détails » for the page « Ouvrir » opens everywhere else; « Animer · en faire
  // une vidéo » beside « Animer : une vidéo qui part de cette prise » on the bar of the screen.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    video = { id: 'v', name: 'Clip', roles: { start_image: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    runs = [
      {
        id: 'c2',
        mediaType: 'video',
        prompt: 'la suite',
        parameters: { frames: 121, fps: 24, references: [{ role: 'source_video', output_id: 'c1' }] },
        outputs: [{ originalUrl: '/c2.mp4', take: 9 }],
      },
      { id: 'p1', prompt: 'un phare', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/p1.png', thumbUrl: '/p1.jpg', take: 8 }] },
      { id: 'c1', mediaType: 'video', prompt: 'un renard qui court', outputs: [{ originalUrl: '/c1.mp4', take: 4 }] },
    ];
  const opened = [];
  const { body, restore } = await studioPage(
    { create_image: [image], create_video: [video] },
    {},
    { runs, viewOutput: record => opened.push(record.id) },
  );
  try {
    const tile = id => body.find('studio-item').find(item => item.dataset.id === id),
      named = id => [tile(id).find('studio-item-pick')[0].attributes['aria-label'], tile(id).find('studio-item-pick')[0].title];
    assert.deepEqual(named('c1'), ['Prise 4 · un renard qui court', 'Prise 4 · un renard qui court']);
    assert.deepEqual(named('c2'), ['Prise 9 · suite de la prise 4 · la suite', 'Prise 9 · suite de la prise 4 · la suite']);
    assert.deepEqual(named('p1'), ['Prise 8 · un phare', 'Prise 8 · un phare']);
    assert.deepEqual(
      ['c1', 'p1'].map(id => [tile(id).find('studio-item-main')[0].attributes['aria-label'], tile(id).find('studio-item-del')[0].attributes['aria-label']]),
      [
        ['Prolonger · Prise 4', 'Supprimer · Prise 4'],
        ['Animer · Prise 8', 'Supprimer · Prise 8'],
      ],
    );
    assert.equal(tile('p1').find('studio-item-main')[0].title, 'Animer : une vidéo qui part de cette prise');
    // Its menu: « Ouvrir », with the words of the bar of a take, opens its page.
    tile('p1').oncontextmenu({ preventDefault() {} });
    const [menu] = body.find('studio-item-menu');
    assert.equal(menu.attributes['aria-label'], 'Actions · Prise 8');
    assert.deepEqual(
      menu.children.map(entry => [entry.children.at(-1).textContent, entry.title]),
      [
        ['Animer', 'Animer : une vidéo qui part de cette prise'],
        ['Ouvrir', 'Ouvrir : l’original, ses paramètres, Télécharger'],
        ['Supprimer', 'Supprimer de sa conversation (le fichier reste dans le dossier output)'],
      ],
    );
    // Their bubbles beside the menu (help-tips.mjs): above its line, that of « Ouvrir » covered the line before.
    assert.deepEqual(menu.children.map(entry => entry.dataset.tipSide), ['left', 'left', 'left']);
    menu.children[1].onclick();
    assert.deepEqual(opened, ['p1']);
    // Its question: « Supprimer la prise 4 ? ».
    tile('c1').find('studio-item-del')[0].onclick();
    assert.equal(body.find('studio-item-confirm')[0].find('studio-confirm-text')[0].textContent, 'Supprimer la prise 4 ?');
  } finally {
    restore();
  }
});

test('(0.6.198) the Studio says « modèle » where it said « workflow »: a seed of the model, its LoRA always on, no model of sound', async () => {
  // (Vérification du 21/11, A8) « Seed : … ou vide pour celle du workflow. », « LoRA du workflow », « Force fixée
  // dans Workflows », « Aucun workflow de son prêt ».
  const krea = {
    id: 'k',
    name: 'Krea 2',
    family: 'krea2',
    seedFixed: 7,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    loras: [
      { id: 'grain', name: 'film_grain', description: 'Grain de film', assistant: true, on: false, strength: { min: 0, max: 1.5, default: 0.8 } },
      { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
    ],
  };
  const page = await studioPage({ create_image: [krea] }, { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }) });
  const { body, restore } = page;
  try {
    // Its LoRA always on: its padlock and its strength say where they are set.
    const net = body.find('studio-lora-row')[1],
      [lock] = net.find('studio-lora-lock');
    assert.deepEqual(
      [lock.attributes['aria-label'], lock.title, net.find('studio-bar-value')[0].title],
      ['LoRA du modèle', 'LoRA du modèle : réglé dans Paramètres › Modèles', 'Force fixée dans Paramètres › Modèles'],
    );
    // A seed the model fixes: what to type instead of a wrong one.
    body.find('studio-more-pill')[0].onclick();
    const seed = body.find('studio-seed')[0].children[1];
    seed.value = '-3';
    seed.oninput();
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    assert.equal(body.find('studio-error')[0]?.textContent, 'Seed : un entier positif, ou vide pour celle du modèle.');
    // Son, without a model of sound.
    page.mode(2);
    assert.equal(
      body.find('asset-empty')[0]?.textContent,
      'Aucun modèle de son prêt : téléchargez les modèles de musique et de bruitages dans models\\audio.',
    );
  } finally {
    restore();
  }
});

test('(0.6.147) the bin asks with the number of the take and the montages that use it; a take of a conversation left goes, its Studio as left', async () => {
  const krea = { id: 'k', name: 'Krea 2', seeded: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    made = (id, conversationId, prompt, take, more = {}) => ({
      id,
      conversationId,
      workflowId: 'k',
      mediaType: 'image',
      prompt,
      parameters: { width: 1024, height: 1024 },
      outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg`, take }],
      ...more,
    }),
    // The newest first; take 6 was deleted: the take 7 is the second of the Sortie.
    all = [
      made('b2', 'c2', 'une barque', 9),
      made('a3', 'c1', 'un phare la nuit', 7, { montages: ['Le pêcheur'] }),
      made('a2', 'c1', 'un phare au matin', 5),
    ];
  let conversation = 'c1';
  const page = await studioPage({ create_image: [krea] }, {}, { runs: all, conversation: () => conversation, project: () => 'p1' });
  const { body, studio, asked, restore } = page;
  const item = id => body.find('studio-item').find(tile => tile.dataset.id === id);
  try {
    item('a3').find('studio-item-del')[0].onclick();
    let [ask] = body.find('studio-item-confirm');
    // Its number, as the Pellicule asks it (« #2 » before: its place in the Sortie); the montage under it.
    // (0.6.198) « la prise 7 », as its badge says it (« #7 » before).
    assert.equal(ask.find('studio-confirm-text')[0].textContent, 'Supprimer la prise 7\u00a0?');
    // Too small for the name of the montage: in short, whole under the pointer and to a screen reader.
    assert.equal(ask.find('studio-confirm-note')[0].textContent, 'Dans une bobine');
    assert.equal(ask.find('studio-confirm-note')[0].title, 'Elle sert dans la bobine « Le pêcheur »');
    assert.equal(ask.attributes['aria-label'], 'Supprimer la prise 7\u00a0? Elle sert dans la bobine « Le pêcheur ».');
    assert.equal(ask.find('studio-confirm-yes')[0].title, 'Supprimer de sa conversation (le fichier reste dans le dossier output)');
    ask.find('studio-confirm-no')[0].onclick();
    assert.deepEqual(body.find('studio-item-confirm'), []);
    // In no montage: no line.
    item('a2').find('studio-item-del')[0].onclick();
    [ask] = body.find('studio-item-confirm');
    assert.equal(ask.find('studio-confirm-text')[0].textContent, 'Supprimer la prise 5\u00a0?');
    assert.deepEqual(ask.find('studio-confirm-note'), []);
    ask.find('studio-confirm-no')[0].onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/delete').length, 0);
    // What the user writes in « c1 » stays there while « c2 » is shown.
    page.prompt().value = 'un phare sous la pluie';
    page.prompt().oninput();
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'une barque');
    // The newest take of « c1 » goes from the Pellicule, by the Studio's own deletion.
    all.splice(1, 1);
    assert.equal(await studio.remove(made('a3', 'c1', 'un phare la nuit', 7)), true);
    assert.deepEqual(asked.find(([route]) => route === 'studio/delete')[1], { id: 'a3', conversationId: 'c1' });
    // Back in « c1 »: as it was left, not with the settings of the take before the one deleted.
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un phare sous la pluie');
  } finally {
    restore();
  }
});

test('an image dragged to another slot changes role; a move that would not combine is refused', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    styled: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    // As MiniMax: a start and an end, or references, never both.
    exclusive: [['start_image', 'end_image'], ['reference']],
    roles: {
      start_image: { count: 1, media: ['image'] },
      end_image: { count: 1, media: ['image'] },
      reference: { count: 2, media: ['image'] },
    },
  };
  const { body, restore, mode } = await studioPage({ create_video: [video] });
  try {
    mode(1);
    const slots = () => body.find('studio-slot'),
      shown = () => slots().map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : '')),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      drag = (from, to) => {
        slots()[from].children[0].ondragstart(event([]));
        slots()[to].ondrop(event([]));
      };
    assert.equal(slots().length, 3, 'start, end, and one empty reference slot at a time');

    await drop(0, 'a.png');
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);
    // References do not combine with a start image: their slots say so, and still take the move.
    assert.match(slots()[2].className, /is-blocked/);
    drag(0, 2);
    assert.deepEqual(shown(), ['', '', '/preview/a.png', '']);
    assert.doesNotMatch(slots()[2].className, /is-blocked/);
    assert.match(slots()[0].className, /is-blocked/);

    // To the end slot, then a start image beside it: the two swap when one is dropped on the other.
    drag(2, 1);
    await drop(0, 'b.png');
    assert.deepEqual(shown(), ['/preview/b.png', '/preview/a.png', '']);
    drag(0, 1);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);

    // A reference beside an end image is what the model cannot take: nothing moves, and it is said.
    drag(0, 2);
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);
    assert.match(body.find('studio-error')[0].textContent, /ne se combine pas avec : Image de fin/);
  } finally {
    restore();
  }
});

test('(0.6.202) what is given that the model in hand does not take stays on the plateau, greyed, with one line, and does not go', async () => {
  // (Capture 96: an end image and a subject given to LTX 2.5, then Wan 2.2, which takes a start image only. They
  // were gone from the page without a word, kept in the draft.)
  const lengths = { seconds: [121 / 24], standard: 121 / 24 },
    base = { limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true, lengths },
    image = { count: 1, media: ['image'] },
    ltx = { ...base, id: 'l', name: 'LTX 2.5', roles: { start_image: image, end_image: image, reference: { count: 3, media: ['image'] } } },
    wan = { ...base, id: 'w', name: 'Wan 2.2', roles: { start_image: image } },
    // (No model of today takes an end without a start: the line of time is drawn for one all the same.)
    endOnly = { ...base, id: 'e', name: 'Fin seule', roles: { end_image: image } },
    scail = {
      ...base,
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      roles: { source: { count: 1, media: ['video'], many: false }, reference: { count: 1, media: ['image'], many: false } },
    };
  const page = await studioPage(
    { create_video: [ltx, wan, endOnly], replace_character: [scail] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
  );
  const { body, asked, notices, restore } = page;
  try {
    page.mode(1);
    const slots = () => body.find('studio-slot'),
      // Each piece: its word, whether it is greyed (the piece and its case).
      pieces = () => body.find('studio-piece').map(piece => [piece.children[1].textContent, /is-off/.test(piece.className), /is-off/.test(piece.children[0].className)]),
      note = () => body.find('studio-plateau-note').map(line => [line.attributes.role, line.children.length, line.children.at(-1).textContent]),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      },
      sent = async () => {
        await body.find('studio-go')[0].onclick();
        await settle();
        return asked.findLast(([route]) => route === 'tools/action')[1].arguments;
      };
    page.prompt().value = 'Un phare';
    page.prompt().oninput();
    // (The subject first: what is greyed is said in the order of the plateau, not in the order it was given.)
    await drop(2, 'sujet.png');
    await drop(0, 'debut.png');
    await drop(1, 'fin.png');
    // LTX 2.5 takes them all: nothing greyed, no line.
    assert.deepEqual(pieces(), [['Début', false, false], ['Fin', false, false], ['Sujet', false, false], ['Sujet', false, false]]);
    assert.deepEqual(note(), []);

    // Wan 2.2: the end and the subject stay, greyed, and one line says that they will not go.
    model('w');
    assert.deepEqual(pieces(), [['Début', false, false], ['Fin', true, true], ['Sujet', true, true]]);
    assert.deepEqual(note(), [['note', 2, 'L’image de fin et le sujet ne partiront pas avec Wan 2.2.']]);
    // The end at its end of the line of time, the subject after the pieces of the model, in a group of its own.
    assert.deepEqual(body.find('studio-frames')[0].children.map(part => part.className.split(' ')[0]), ['studio-piece', 'studio-span', 'studio-piece']);
    assert.deepEqual(body.find('studio-swap'), [], 'no swap with an end this model does not take');
    assert.deepEqual(body.find('studio-kept').map(row => [row.attributes.role, row.attributes['aria-label'], row.children.length]), [['group', 'Gardées pour un autre modèle', 1]]);
    // Each says why in its tooltip and aloud, and on a click; it has no name for a hand that carries a take (it
    // lights up for none), takes no drop, keeps its picture, its badge and its ×.
    const off = () => slots().slice(1);
    assert.deepEqual(
      off().map(tile => [tile.children[0].title, tile.children[0].attributes['aria-label'], tile.children[0].attributes['aria-disabled'], tile.dataset.media, tile.dataset.name, tile.ondrop, tile.ondragover]),
      [
        ['Image de fin gardée : Wan 2.2 ne la prend pas.', 'Image de fin gardée : Wan 2.2 ne la prend pas.', 'true', undefined, undefined, null, null],
        ['Sujet 1 gardé : Wan 2.2 ne le prend pas.', 'Sujet 1 gardé : Wan 2.2 ne le prend pas.', 'true', undefined, undefined, null, null],
      ],
    );
    assert.deepEqual(off().map(tile => [tile.children[0].children[0].src, tile.find('studio-slot-badge')[0].textContent, tile.find('studio-slot-remove').length]), [
      ['/preview/fin.png', '', 1],
      ['/preview/sujet.png', '@1', 1],
    ]);
    off()[0].children[0].onclick();
    assert.equal(notices.at(-1), 'Image de fin gardée : Wan 2.2 ne la prend pas.');
    // Sent with Wan 2.2: its start image, neither the end nor the subject.
    const withWan = await sent();
    assert.deepEqual([Boolean(withWan.start_image), 'end_image' in withWan, 'reference' in withWan], [true, false, false]);

    // Back to LTX 2.5: nothing greyed, no line, and both go.
    model('l');
    assert.deepEqual(pieces(), [['Début', false, false], ['Fin', false, false], ['Sujet', false, false], ['Sujet', false, false]]);
    assert.deepEqual(note(), []);
    const withLtx = await sent();
    assert.deepEqual([Boolean(withLtx.start_image), Boolean(withLtx.end_image), withLtx.reference?.length], [true, true, 1]);

    // A model with no line of time (a character put in a video): the start, the end after its own pieces; its
    // character is the subject given. One alone: « ne partira pas ».
    model('s');
    assert.deepEqual(pieces(), [['À suivre', false, false], ['Personnage', false, false], ['Début', true, true], ['Fin', true, true]]);
    assert.deepEqual(note(), [['note', 2, 'L’image de début et l’image de fin ne partiront pas avec SCAIL-2.']]);
    // × on a greyed piece takes it away for good; the line follows.
    slots()[2].find('studio-slot-remove')[0].onclick();
    assert.deepEqual(pieces(), [['À suivre', false, false], ['Personnage', false, false], ['Fin', true, true]]);
    assert.deepEqual(note(), [['note', 2, 'L’image de fin ne partira pas avec SCAIL-2.']]);
    // A greyed piece dragged to a case of the model takes that role (the end becomes the start of Wan 2.2).
    model('w');
    assert.deepEqual(pieces(), [['Début', false, false], ['Fin', true, true], ['Sujet', true, true]]);
    slots()[1].children[0].ondragstart(event([]));
    slots()[0].ondrop(event([]));
    assert.deepEqual(pieces(), [['Début', false, false], ['Sujet', true, true]]);
    assert.equal(slots()[0].children[0].children[0].src, '/preview/fin.png');
    assert.deepEqual(note(), [['note', 2, 'Le sujet ne partira pas avec Wan 2.2.']]);
    // More subjects than the model takes: those past its most, « les sujets ».
    model('l');
    await drop(3, 'deux.png');
    model('s');
    assert.deepEqual(pieces(), [['À suivre', false, false], ['Personnage', false, false], ['Début', true, true], ['Sujet', true, true]]);
    assert.equal(slots()[3].children[0].title, 'Sujet 2 gardé : SCAIL-2 ne le prend pas.');
    assert.deepEqual(note(), [['note', 2, 'L’image de début et le sujet ne partiront pas avec SCAIL-2.']]);
    // Two subjects this model does not take: « les sujets ».
    model('w');
    assert.deepEqual(pieces(), [['Début', false, false], ['Sujet', true, true], ['Sujet', true, true]]);
    assert.deepEqual(note(), [['note', 2, 'Les sujets ne partiront pas avec Wan 2.2.']]);
    assert.deepEqual(slots().slice(1).map(tile => tile.find('studio-slot-badge')[0].textContent), ['@1', '@2']);
    // The first dragged to the start, emptied: the one left is « Sujet 1 », no hole is kept before it.
    slots()[0].find('studio-slot-remove')[0].onclick();
    slots()[1].children[0].ondragstart(event([]));
    slots()[0].ondrop(event([]));
    assert.deepEqual(pieces(), [['Début', false, false], ['Sujet', true, true]]);
    assert.deepEqual(
      [slots()[0].children[0].children[0].src, slots()[1].children[0].children[0].src, slots()[1].children[0].title, slots()[1].find('studio-slot-badge')[0].textContent],
      ['/preview/sujet.png', '/preview/deux.png', 'Sujet 1 gardé : Wan 2.2 ne le prend pas.', '@1'],
    );
    // × on a subject kept takes it away for good too: nothing greyed is left, nor the line.
    slots()[1].find('studio-slot-remove')[0].onclick();
    assert.deepEqual(pieces(), [['Début', false, false]]);
    assert.deepEqual(note(), []);
    // A model that takes an end only: the start given keeps its end of the line of time, greyed.
    model('e');
    assert.deepEqual(pieces(), [['Début', true, true], ['Fin', false, false]]);
    assert.deepEqual(body.find('studio-frames')[0].children.map(part => part.className.split(' ')[0]), ['studio-piece', 'studio-span', 'studio-piece']);
    assert.deepEqual(note(), [['note', 2, 'L’image de début ne partira pas avec Fin seule.']]);
    // In the page: greyed, its word too; the line in 13 px.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('#studio-view .studio-piece.is-off .studio-slot-pick'), /opacity: 0\.38;\n  filter: grayscale\(1\);/);
    assert.match(rule('.studio-piece.is-off .studio-piece-word'), /color: var\(--text-4\);/);
    assert.match(rule('.studio-plateau-note'), /font: 400 13px\/1\.4 var\(--font-ui\);/);
  } finally {
    restore();
  }
});

test('(0.6.203) « Ajouter », the last piece of the plateau: its list gives what the model takes, greys what only another model takes, and holds the lyrics', async () => {
  // (Captures 93, 94, 100 and 101. Before: nothing said that a video can be followed or that a song has lyrics
  // with another model, and the lyrics had a button of their own under the prompt.)
  const image = { count: 1, media: ['image'] },
    shape = { limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    moss = { ...shape, id: 'm', name: 'MOSS Image', family: 'moss', roles: {} },
    krea = { ...shape, id: 'k', name: 'Krea 2', family: 'krea2', roles: { source: { ...image, many: false } } },
    // (One this computer cannot run, listed first: the list names a model that can be chosen.)
    turbo = { ...krea, id: 't', name: 'Krea 2 Turbo', unavailable: 'Krea 2 Turbo demande une carte graphique NVIDIA.' },
    // (One that takes subjects only, listed before LTX 2.5: the greyed choices follow the order of the plateau.)
    omni = { ...shape, id: 'o', name: 'MiniMax H3 Omni', family: 'minimax_h3', lengths: { seconds: [121 / 24], standard: 121 / 24 }, roles: { reference: { count: 2, media: ['image'] } } },
    ltx = { ...shape, id: 'l', name: 'LTX 2.5', family: 'ltx25', lengths: { seconds: [121 / 24], standard: 121 / 24 }, roles: { reference: { count: 3, media: ['image'] }, end_image: image, start_image: image } },
    // (As MiniMax H3: a start image or subjects, never both.)
    either = { ...shape, id: 'h', name: 'L’un ou l’autre', lengths: { seconds: [121 / 24], standard: 121 / 24 }, exclusive: [['start_image'], ['reference']], roles: { start_image: image, reference: { count: 2, media: ['image'] } } },
    scail = {
      ...shape,
      id: 's',
      name: 'Wan 2.1 SCAIL-2',
      family: 'wan_scail2',
      verb: 'replace_character',
      follows: true,
      roles: { source: { count: 1, media: ['video'], many: false }, reference: { count: 1, media: ['image'], many: false } },
    },
    sfx = { id: 'x', name: 'Bruitages (MOSS-SoundEffect v2)', family: 'moss_sfx', roles: {}, settings: [] },
    ace = { id: 'a', name: 'Musique (ACE-Step 1.5 XL)', family: 'acestep15', roles: {}, settings: [{ key: 'lyrics', type: 'string', maxLength: 4000 }] };
  const page = await studioPage(
    { create_image: [moss, turbo, krea], create_video: [omni, ltx, either], replace_character: [scail], create_audio: [sfx, ace] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => new Promise(() => {}) },
  );
  const { body, studio, pagePointers, pageKeys, restore } = page;
  try {
    const picker = page.page['studio-view'].children.find(child => child.tag === 'input'),
      add = () => body.find('studio-add')[0],
      pick = () => add().children[0],
      menu = () => add().children[2],
      // Each line of the list: greyed or not, its name and what is said of it, its reason; « — » for the rule.
      list = () => menu().children.map(item => (item.className === 'glass-menu-rule' ? '—' : [/is-off/.test(item.className), item.children.map(part => part.textContent).join(' · '), item.dataset.tip ?? ''])),
      choose = name => menu().children.find(item => item.children?.[0]?.textContent === name).onclick(),
      model = id => {
        const chosen = body.find('studio-model-pick')[0];
        chosen.value = id;
        chosen.onchange();
      },
      give = async (name, type = 'image/png') => {
        picker.files = [{ name, type }];
        await picker.onchange();
        await new Promise(resolve => setTimeout(resolve, 5));
      };
    // Image, a model that takes nothing: the plateau is « Ajouter » alone, its word under it.
    assert.deepEqual(body.find('studio-plateau')[0].children.map(row => row.children.map(part => part.className)), [['studio-add']]);
    assert.deepEqual(add().children.map(part => part.className), ['studio-add-pick', 'studio-add-word', 'glass-menu studio-add-menu']);
    assert.deepEqual(
      [pick().attributes['aria-label'], pick().attributes['aria-haspopup'], pick().attributes['aria-expanded'], pick().disabled, pick().title],
      ['Ajouter', 'menu', 'false', false, undefined],
    );
    assert.deepEqual([add().children[1].textContent, add().children[1].attributes['aria-hidden']], ['Ajouter', 'true']);
    assert.deepEqual([menu().hidden, menu().attributes.role, menu().attributes['aria-label']], [true, 'menu', 'Ajouter']);
    // What only Krea 2 takes, greyed, with the name of that model and where to choose it (capture 100).
    assert.deepEqual(list(), [[true, 'Image à modifier · avec Krea 2', 'Une image à modifier sert avec Krea 2 : choisissez-le dans Modèle.']]);
    const [greyed] = menu().children;
    assert.deepEqual(
      [greyed.attributes.role, greyed.attributes['aria-disabled'], greyed.attributes['aria-label'], greyed.dataset.tipSide, greyed.children[1].className],
      ['menuitem', 'true', 'Image à modifier, avec Krea 2', 'right', 'glass-menu-note'],
    );
    // Opened by its case; drawn again meanwhile, still open; a greyed choice does nothing; its case closes it.
    pick().onclick();
    assert.deepEqual([pick().attributes['aria-expanded'], menu().hidden], ['true', false]);
    studio.render();
    assert.deepEqual([add().className, pick().attributes['aria-expanded'], menu().hidden], ['studio-add is-open', 'true', false]);
    choose('Image à modifier');
    assert.deepEqual([picker.clicks ?? 0, menu().hidden], [0, false]);
    pick().onclick();
    assert.deepEqual([pick().attributes['aria-expanded'], menu().hidden], ['false', true]);
    // A press beside it closes it, Échap too; a press on it leaves it open.
    pick().onclick();
    pagePointers.forEach(listener => listener({ target: { closest: selector => (/studio-add/.test(selector) ? {} : null) } }));
    studio.render();
    assert.equal(menu().hidden, false);
    pagePointers.forEach(listener => listener({ target: { closest: () => null } }));
    studio.render();
    assert.deepEqual([add().className, menu().hidden], ['studio-add', true]);
    pick().onclick();
    let taken = 0;
    pageKeys.forEach(listener => listener({ key: 'Escape', target: {}, preventDefault: () => taken++ }));
    studio.render();
    assert.deepEqual([menu().hidden, taken], [true, 1]);

    // Krea 2: its image to modify, which opens the files of the computer for its case; given, « déjà donnée ».
    model('k');
    assert.deepEqual(body.find('studio-plateau')[0].children.map(row => row.children.map(part => part.className)), [['studio-pieces studio-sources', 'studio-add']]);
    assert.deepEqual(list(), [[false, 'Image à modifier', '']]);
    pick().onclick();
    choose('Image à modifier');
    assert.deepEqual([picker.clicks, picker.accept], [1, 'image/png,image/jpeg,image/webp']);
    studio.render();
    assert.equal(menu().hidden, true, 'closed by a choice');
    await give('visage.png');
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    assert.deepEqual(list(), [[true, 'Image à modifier · déjà donnée', 'Image à modifier : déjà donnée. Cliquez sur sa case pour en changer.']]);

    // Another mode: the list left open is closed.
    pick().onclick();
    page.mode(1);
    assert.equal(menu().hidden, true);
    // Vidéo, LTX 2.5 (capture 94): its three kinds, in the order of the plateau whatever the order its model
    // names them in, then under a rule what SCAIL-2 takes, said short.
    model('l');
    assert.deepEqual(list(), [
      [false, 'Image de début', ''],
      [false, 'Image de fin', ''],
      [false, 'Sujet', ''],
      '—',
      [true, 'Vidéo à suivre · avec SCAIL-2', 'Une vidéo à suivre sert avec SCAIL-2 : choisissez-le dans Modèle.'],
      [true, 'Personnage · avec SCAIL-2', 'Un personnage sert avec SCAIL-2 : choisissez-le dans Modèle.'],
    ]);
    assert.equal(menu().children[3].attributes.role, 'separator');
    // « Image de fin » opens the files for the end; « Sujet », for the next subject free, until the three are given.
    choose('Image de fin');
    await give('fin.png');
    assert.deepEqual(body.find('studio-slot').map(tile => /is-filled/.test(tile.className)), [false, true, false]);
    for (const name of ['un.png', 'deux.png', 'trois.png']) {
      choose('Sujet');
      await give(name);
    }
    assert.deepEqual(body.find('studio-references')[0].find('studio-slot').map(tile => tile.children[0].children[0].src), ['/preview/un.png', '/preview/deux.png', '/preview/trois.png']);
    assert.deepEqual(list().slice(0, 3), [
      [false, 'Image de début', ''],
      [true, 'Image de fin · déjà donnée', 'Image de fin : déjà donnée. Cliquez sur sa case pour en changer.'],
      [true, 'Sujet · déjà donnés', 'Les 3 sujets sont déjà donnés.'],
    ]);
    assert.deepEqual(body.find('studio-plateau')[0].children.at(-1).children.map(part => part.className), ['studio-pieces studio-references', 'studio-add']);
    // A model whose start image does not combine with the subjects given: greyed, why in its reason; its two
    // subjects are given already.
    model('h');
    assert.deepEqual(list().slice(0, 2), [
      [true, 'Image de début', 'Ne se combine pas avec : Sujet'],
      [true, 'Sujet · déjà donnés', 'Les 2 sujets sont déjà donnés.'],
    ]);
    // SCAIL-2: its video (the files of videos) and its character; what the first model that has them takes, greyed.
    model('s');
    assert.deepEqual(list(), [
      [false, 'Vidéo à suivre', ''],
      [true, 'Personnage · déjà donné', 'Personnage : déjà donné. Cliquez sur sa case pour en changer.'],
      '—',
      [true, 'Image de début · avec LTX 2.5', 'Une image de début sert avec LTX 2.5 : choisissez-le dans Modèle.'],
      [true, 'Image de fin · avec LTX 2.5', 'Une image de fin sert avec LTX 2.5 : choisissez-le dans Modèle.'],
      // (The first model of the list that takes subjects: named after the start and the end, as on the plateau.)
      [true, 'Sujet · avec MiniMax H3 Omni', 'Un sujet sert avec MiniMax H3 Omni : choisissez-le dans Modèle.'],
    ]);
    choose('Vidéo à suivre');
    assert.equal(picker.accept, 'video/mp4,video/webm');

    // Son (capture 101): the lyrics, greyed with a model that sings none; with one that does, they open their field
    // under the prompt (no button « + Paroles » of their own any more), and are « déjà ouvertes ».
    page.mode(2);
    assert.deepEqual(list(), [[true, 'Paroles · avec ACE-Step 1.5 XL', 'Des paroles servent avec ACE-Step 1.5 XL : choisissez-le dans Modèle.']]);
    model('a');
    assert.deepEqual(list(), [[false, 'Paroles', '']]);
    // (The field of the lyrics: the one the pointer of Moodix AI aims at, « setting-lyrics ».)
    const under = element => [element, ...(element.children ?? []).flatMap(child => (child?.children ? under(child) : []))],
      lyrics = () => under(body).filter(element => element.dataset?.ai === 'setting-lyrics').length;
    assert.deepEqual([body.find('studio-lyrics-toggle').length, lyrics()], [0, 0]);
    choose('Paroles');
    assert.equal(lyrics(), 1);
    assert.deepEqual(list(), [[true, 'Paroles · déjà ouvertes', 'Les paroles sont déjà ouvertes, sous le prompt.']]);

    // While a take is made: greyed, why in its tooltip; its list closed.
    page.mode(1);
    model('l');
    pick().onclick();
    page.prompt().value = 'Un phare';
    page.prompt().oninput();
    void body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([pick().disabled, pick().title, menu().hidden], [true, 'Génération en cours dans cette conversation : attendez sa fin.', true]);
    // In the page: its case as the others, its word in 12 px.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('#studio-view .studio-add-pick'), /width: 52px;\n  height: 52px;/);
    assert.match(rule('.studio-add-word'), /font: 400 12px\/1\.2 var\(--font-ui\);/);
    assert.match(rule('.glass-menu.studio-add-menu .glass-menu-item'), /justify-content: space-between;/);
    assert.doesNotMatch(css, /studio-lyrics-toggle/);
  } finally {
    restore();
  }
});

test('(0.6.204) the window of a piece closes at a press beside it, at Échap, with its piece, for the list « Ajouter »; under a proposal its images are those of Moodix AI', async () => {
  const image = { count: 1, media: ['image'] },
    shape = { limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true, lengths: { seconds: [121 / 24], standard: 121 / 24 } },
    ltx = { ...shape, id: 'l', name: 'LTX 2.5', roles: { start_image: image, end_image: image, reference: { count: 3, media: ['image'] } } },
    wan = { ...shape, id: 'w', name: 'Wan 2.2', roles: { start_image: image } },
    still = { id: 'i', name: 'Image', roles: { source: { ...image, many: false } }, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    scail = { ...shape, id: 's', name: 'SCAIL-2', verb: 'replace_character', follows: true, roles: { source: { count: 1, media: ['video'], many: false }, reference: { ...image, many: false } } };
  let page = await studioPage(
    { create_image: [still], create_video: [ltx, wan], replace_character: [scail] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => new Promise(() => {}) },
  );
  try {
    const { body, studio, pagePointers, pageKeys } = page;
    page.mode(1);
    const pane = () => body.find('studio-piece-window').map(found => found.attributes['aria-label']),
      open = index => body.find('studio-slot-pick')[index].onclick(),
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      },
      press = target => {
        pagePointers.forEach(listener => listener({ target }));
        // (Closed without drawing the Studio again, a press being a click too: seen once it is drawn.)
        studio.render();
      };
    for (const [index, name] of [[0, 'debut.png'], [1, 'fin.png']]) {
      body.find('studio-slot')[index].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name }], setData() {} } });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    open(1);
    assert.deepEqual(pane(), ['Image de fin']);
    // A press on its piece (its case, its window) leaves it open; beside it, it closes.
    press({ closest: selector => (selector === '.studio-piece.is-open' ? {} : null) });
    assert.deepEqual(pane(), ['Image de fin']);
    press({ closest: () => null });
    assert.deepEqual(pane(), []);
    // Échap closes it, and is taken: nothing else hears it.
    open(0);
    assert.deepEqual(pane(), ['Image de début']);
    let taken = 0;
    pageKeys.forEach(listener => listener({ key: 'Escape', target: {}, preventDefault: () => taken++ }));
    studio.render();
    assert.deepEqual([pane(), taken], [[], 1]);
    // The list « Ajouter » and a window: one at a time, each closes for the other.
    const add = () => body.find('studio-add')[0];
    open(1);
    add().children[0].onclick();
    studio.render();
    assert.deepEqual([pane(), add().children[2].hidden], [[], false]);
    open(1);
    assert.deepEqual([pane(), add().children[2].hidden], [['Image de fin'], true]);
    // Another model, which does not take its piece: closed, and not open again back with the first.
    model('w');
    assert.deepEqual(pane(), []);
    model('l');
    assert.deepEqual(pane(), []);
    // Another mode: closed.
    open(0);
    page.mode(0);
    page.mode(1);
    assert.deepEqual(pane(), []);
    // « Retirer » on a subject: its window goes with it, it does not pass to the subject that takes its place.
    const drop = async (index, name) => {
      body.find('studio-slot')[index].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name }], setData() {} } });
      await new Promise(resolve => setTimeout(resolve, 5));
    };
    await drop(2, 'un.png');
    await drop(3, 'deux.png');
    open(2);
    assert.deepEqual(pane(), ['Sujet 1']);
    body.find('studio-window-foot')[0].children.find(part => part.children[0]?.textContent === 'Retirer').onclick();
    assert.deepEqual([pane(), body.find('studio-references')[0].find('studio-slot')[0].children[0].children[0].src], [[], '/preview/deux.png']);
    // A piece dragged to another case leaves no window behind: its case given again, none opens by itself.
    body.find('studio-slot')[1].find('studio-slot-remove')[0].onclick();
    open(0);
    assert.deepEqual(pane(), ['Image de début']);
    body.find('studio-slot')[0].children[0].ondragstart({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], setData() {} } });
    body.find('studio-slot')[1].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], setData() {} } });
    assert.deepEqual([pane(), body.find('studio-slot').slice(0, 2).map(tile => /is-filled/.test(tile.className))], [[], [false, true]]);
    await drop(0, 'debut.png');
    assert.deepEqual(pane(), []);
    // Another mode where the piece of the same place is given too (the image to modify of Image, the video to
    // follow of Vidéo): the window does not pass from one to the other.
    model('s');
    body.find('studio-slot')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name: 'clip.mp4', type: 'video/mp4' }], setData() {} } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    page.mode(0);
    await drop(0, 'photo.png');
    open(0);
    assert.deepEqual(pane(), ['Image à modifier']);
    page.mode(1);
    assert.deepEqual([body.find('studio-model-pick')[0].value, pane()], ['s', []]);
    model('l');
    // While a take is made, no window: its case cannot be pressed then.
    open(0);
    page.prompt().value = 'Un phare';
    page.prompt().oninput();
    void body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([pane(), body.find('studio-slot-pick')[0].disabled], [[], true]);
    // In the page: 292 px wide, its fields 34 px high, a line of the accent around the case of its piece.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('.glass-menu.studio-piece-window'), /width: 292px;/);
    assert.match(rule("#studio-view .studio-piece-window input[type='text']"), /height: 34px;/);
    assert.match(rule('#studio-view .studio-piece.is-open .studio-slot-pick'), /box-shadow: 0 0 0 1\.5px var\(--accent\);/);
    assert.doesNotMatch(css, /\.studio-who\b/);
  } finally {
    page.restore();
  }
  // Under a proposal of Moodix AI: the window of its image opens, « Changer… » greyed with why, no « Retirer ».
  const { clip, request } = proposalOf();
  request.plan.references = [{ role: 'start_image', roleLabel: 'Image de début', preview: '/debut.jpg' }];
  page = await studioPage({ create_video: [clip] }, {});
  try {
    const answer = page.studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(page.studio.proposing(), true);
    page.body.find('studio-slot-pick')[0].onclick();
    const foot = page.body.find('studio-window-foot')[0].children;
    assert.deepEqual(
      foot.map(part => [part.className, part.textContent || part.children[0].textContent, part.disabled, part.title]),
      [
        ['studio-window-said', 'Image de début', undefined, undefined],
        ['studio-window-button', 'Changer…', true, 'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.'],
      ],
    );
    page.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    page.restore();
  }
});

test('(0.6.203) no « Ajouter » in a continuation; under a proposal of Moodix AI it is greyed, the images are its own', async () => {
  const { tools, runs } = continuing();
  let page = await studioPage(tools, {}, { runs });
  try {
    page.mode(1);
    assert.equal(page.body.find('studio-add').length, 1);
    prolonger(page.body).onclick();
    assert.deepEqual([prolonged(page.body).length, page.body.find('studio-add').length], [1, 0]);
  } finally {
    page.restore();
  }
  const { clip, request } = proposalOf();
  page = await studioPage({ create_video: [clip] }, {});
  try {
    const answer = page.studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(page.studio.proposing(), true);
    const [pick] = page.body.find('studio-add-pick');
    assert.deepEqual([pick.disabled, pick.title], [true, 'Les images de cette proposition sont celles de Moodix AI : demandez-lui dans le chat pour en changer.']);
    page.studio.decline();
    assert.equal(await answer, 'deny');
    assert.deepEqual([page.body.find('studio-add-pick')[0].disabled, page.body.find('studio-add-pick')[0].title], [false, undefined]);
  } finally {
    page.restore();
  }
});

test('(0.6.202) nothing is greyed under a proposal of Moodix AI, whose notes say what does not go, nor in a continuation, which starts from its clip alone', async () => {
  const greyed = body => [body.find('studio-plateau-note').length, body.find('studio-piece').filter(piece => /is-off/.test(piece.className)).length];
  // A proposal whose image has a role its model has not (an end image, for a model that takes a start only): its
  // note says that it does not go, the plateau does not say it a second time.
  const { clip, request } = proposalOf();
  request.plan.references = [{ role: 'end_image', roleLabel: 'Image de fin', preview: '/fin.jpg' }];
  request.notes = ['L’image de fin ne part pas avec Clip.'];
  let page = await studioPage({ create_video: [clip] }, {});
  try {
    const answer = page.studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(page.studio.proposing(), true);
    assert.deepEqual(page.body.find('studio-proposal-note').map(note => note.textContent), ['L’image de fin ne part pas avec Clip.']);
    assert.deepEqual(greyed(page.body), [0, 0]);
    page.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    page.restore();
  }
  // A continuation: the start image given for a new clip is no part of it, and is not said to stay behind.
  const { tools, runs } = continuing();
  page = await studioPage(tools, {}, { runs });
  try {
    page.mode(1);
    page.body.find('studio-slot')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name: 'debut.png' }], setData() {} } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(page.body.find('studio-slot')[0].className, /is-filled/);
    prolonger(page.body).onclick();
    // (0.6.207) Its one piece is the clip it goes on from.
    assert.deepEqual([...greyed(page.body), page.body.find('studio-slot').map(tile => tile.dataset.slot)], [0, 0, ['source-0']]);
  } finally {
    page.restore();
  }
});

test('the plateau (0.6.201): one block without a title, a word under each piece, start and end on a line of time, subjects numbered without holes', async () => {
  const lengths = { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      lengths,
      exclusive: [['start_image', 'end_image'], ['reference']],
      roles: {
        start_image: { count: 1, media: ['image'] },
        end_image: { count: 1, media: ['image'] },
        reference: { count: 3, media: ['image'] },
      },
    },
    // A model that takes a start image only.
    other = { ...video, id: 'w', name: 'Autre', exclusive: [], roles: { start_image: { count: 1, media: ['image'] } } };
  const { body, restore, mode } = await studioPage({ create_video: [video, other] });
  try {
    mode(1);
    const slots = () => body.find('studio-slot'),
      picks = () => body.find('studio-slot-pick'),
      shown = () => slots().map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : '')),
      badges = () => body.find('studio-slot-badge').map(badge => badge.textContent),
      event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
      drop = async (index, name) => {
        slots()[index].ondrop(event([{ name }]));
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      };
    // (0.6.201, captures 93 and 108) One block, the plateau, where there were two with their titles (« Début et
    // fin », « Sujets »): the start and the end on its first row, the subjects on the next; no « is-flash » yet.
    const plateau = () => body.find('studio-input-block'),
      [frames] = body.find('studio-frames'),
      [references] = body.find('studio-references');
    assert.deepEqual(plateau().map(block => block.className), ['studio-input-block studio-plateau']);
    assert.deepEqual(plateau()[0].children.map(row => row.className), ['studio-plateau-row studio-frames', 'studio-plateau-row']);
    assert.deepEqual(body.find('studio-input-title'), []);
    assert.equal(frames.attributes['aria-label'], 'Début et fin');
    // (0.6.190) « Sujets », no longer « Références »: the case receives a character, an object or a place
    // (#ref and « Références du projet » are files, and keep their name).
    assert.equal(references.attributes['aria-label'], 'Sujets');
    // (0.6.201, his decision of 21/11) A word under each piece, for the eye: its button says its whole name aloud.
    const words = () => body.find('studio-piece').map(piece => piece.children.map(part => part.className.split(' ')[0] + ':' + part.textContent).at(-1));
    assert.deepEqual(words(), ['studio-piece-word:Début', 'studio-piece-word:Fin', 'studio-piece-word:Sujet']);
    assert.deepEqual(body.find('studio-piece-word').map(word => word.attributes['aria-hidden']), ['true', 'true', 'true']);
    assert.deepEqual(body.find('studio-piece').map(piece => /is-empty/.test(piece.className)), [true, true, true]);
    assert.deepEqual(
      picks().map(pick => pick.attributes['aria-label']),
      ['Ajouter l’image de début', 'Ajouter l’image de fin', 'Ajouter le sujet 1'],
    );
    assert.equal(picks()[1].title, 'Image de fin (facultatif) · glisser, coller ou cliquer');
    // (0.6.201) Which subject it is of how many, in the tooltip of the empty case: « n/3 » is gone from the block.
    assert.equal(picks()[2].title, 'Sujet 1 sur 3 : personnage, objet ou décor · glisser, coller ou cliquer');
    assert.deepEqual(body.find('studio-references-count'), []);
    // (0.6.187) What each case is named for the hand that carries a take over it: its short name; « Changer »
    // once it holds something (« Remplacer » was cut in 12 px, longer than its case).
    // (0.6.190) « Sujet 1 », no longer « Réf. 1 ».
    assert.deepEqual(slots().map(tile => tile.dataset.name), ['Début', 'Fin', 'Sujet 1']);
    // Empty, the start and the end show their pictos, a reference « @ ».
    assert.equal(picks()[0].children[0].tag, 'svg');
    assert.equal(picks()[2].children[0].textContent, '@');

    // The length set, on the line, in the colour of the duration bar: the ivory of the room.
    const [time] = body.find('studio-span-time'),
      [line] = body.find('studio-span-line');
    assert.equal(time.textContent, '05.04 S');
    assert.equal(time.style.color, 'rgb(238, 232, 222)');
    // The bar moved to the longest: the line follows at once, without drawing the Studio again.
    const bar = body.find('studio-bar').find(item => item.dataset.ai === 'duration');
    bar.value = '2';
    bar.oninput();
    assert.equal(time.textContent, '10.04 S');
    assert.equal(time.style.color, 'rgb(238, 232, 222)');
    assert.equal(line.style.backgroundSize, '100% 100%');

    // A start image: its picto stays, small, in a badge; « ⇄ » swaps it to the end and back.
    await drop(0, 'a.png');
    assert.equal(slots()[0].find('studio-slot-badge').length, 1);
    assert.equal(picks()[0].attributes['aria-label'], 'Image de début · #ref1 · a.png');
    assert.equal(picks()[0].title, 'Image de début · glissez-la vers un autre emplacement pour changer son rôle');
    assert.deepEqual(slots().map(tile => tile.dataset.name).slice(0, 2), ['Changer', 'Fin']);
    const [swap] = body.find('studio-swap');
    assert.equal(swap.attributes['aria-label'], 'Inverser début et fin');
    swap.onclick();
    assert.deepEqual(shown(), ['', '/preview/a.png', '']);
    body.find('studio-swap')[0].onclick();
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);

    // A piece given is no longer « is-empty » (its word a little lighter then).
    assert.deepEqual(body.find('studio-piece').map(piece => /is-empty/.test(piece.className)), [false, true, true]);
    // Taken back, then subjects one at a time, numbered; the empty case says which one it is of the three.
    slots()[0].find('studio-slot-remove')[0].onclick();
    await drop(2, 'b.png');
    await drop(3, 'c.png');
    assert.deepEqual(badges(), ['@1', '@2']);
    assert.equal(picks()[4].title, 'Sujet 3 sur 3 : personnage, objet ou décor · glisser, coller ou cliquer');
    assert.deepEqual(words().slice(2), ['studio-piece-word:Sujet', 'studio-piece-word:Sujet', 'studio-piece-word:Sujet']);
    assert.match(picks()[2].attributes['aria-label'], /^Sujet 1 · /);
    // (0.6.190) « glissez-le » : the subject, no longer « la » of « la référence ».
    assert.equal(picks()[2].title, 'Sujet 1 · glissez-le vers un autre emplacement pour changer son rôle');
    assert.deepEqual([picks()[4].attributes['aria-label'], slots()[4].dataset.name], ['Ajouter le sujet 3', 'Sujet 3']);
    assert.equal(slots().length, 5, 'start, end, two references and one empty slot');
    // @1 taken back: the next one becomes @1, no hole.
    body.find('studio-references')[0].find('studio-slot-remove')[0].onclick();
    assert.deepEqual(badges(), ['@1']);
    assert.equal(
      body.find('studio-references')[0].find('studio-slot')[0].children[0].children[0].src,
      '/preview/c.png',
    );
    assert.equal(picks()[3].title, 'Sujet 2 sur 3 : personnage, objet ou décor · glisser, coller ou cliquer');

    // Another model: its plateau says so for a moment (a light line); a start image only, the line
    // ends with the length, no « ⇄ ».
    model('w');
    assert.equal(plateau().length, 1);
    // (0.6.202) The subject kept, which this model does not take, after its own pieces, and the line that says so.
    assert.deepEqual(
      plateau()[0].children.map(row => [row.className, row.attributes?.['aria-label']]),
      [
        ['studio-plateau-row studio-frames', 'Image de début'],
        ['studio-plateau-row', undefined],
        ['studio-plateau-note', undefined],
      ],
    );
    assert.match(plateau()[0].className, /is-flash/);
    assert.deepEqual(words(), ['studio-piece-word:Début', 'studio-piece-word:Sujet']);
    // (0.6.201) In the page: the word in 12 px under its case; while a take is carried over the cases that take
    // it, the name of each case (« CHANGER », « FIN ») stands in the place of its word, never two words under one.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    // (A rule by the selector that begins its line: « .studio-piece-word » ends other selectors too.)
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('.studio-piece-word'), /font: 400 12px\/1\.2 var\(--font-ui\);/);
    assert.match(rule('.studio-piece'), /flex-direction: column;\n  align-items: center;\n  gap: 6px;/);
    assert.match(
      rule("#studio-view .studio-desk[data-carrying='video'] .studio-piece:has(> .studio-slot[data-media='video']:not(.is-blocked)) .studio-piece-word"),
      /visibility: hidden;/,
    );
    assert.doesNotMatch(css, /studio-input-title|studio-references-count/);
    assert.deepEqual(body.find('studio-swap'), []);
    assert.equal(body.find('studio-span-time')[0].textContent, '10.04 S');
    // Back: the reference kept comes back with it.
    model('v');
    assert.deepEqual(badges(), ['@1']);
  } finally {
    restore();
  }
});

test('the screen: its format and length at the top left, no « i » (a click in the Sortie shows the details)', async () => {
  const video = {
      id: 'v',
      name: 'Clip',
      styled: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      seeded: true,
      stages: true,
      lengths: { seconds: [121 / 24, 193 / 24], standard: 121 / 24 },
      roles: {},
      loras: [{ id: 'grain', name: 'Grain', assistant: false, on: true, strength: { value: 0.8 } }],
    },
    image = {
      id: 'i',
      name: 'Image',
      styled: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
      roles: {},
    },
    sound = {
      id: 's',
      name: 'Bruitages',
      roles: {},
      settings: [{ key: 'seconds', type: 'number', min: 1, max: 30, default: 10 }],
    },
    clip = {
      id: 'c',
      mediaType: 'video',
      prompt: 'un renard',
      workflowId: 'v',
      workflowName: 'Clip',
      parameters: {
        width: 512,
        height: 288,
        frames: 124,
        fps: 24,
        stage: 'draft',
        loras: [{ id: 'grain', strength: 0.8 }],
        styles: [{ name: 'sub\\light.safetensors', strength: 1 }],
      },
      outputs: [{ originalUrl: '/clip.mp4' }],
    };
  const { studio, body, restore, mode } = await studioPage(
    { create_image: [image], create_video: [video], create_audio: [sound] },
    {},
    { runs: [clip] },
  );
  try {
    const readout = () => body.find('studio-readout')[0].textContent;
    // The Studio opened on the mode of the last take, a clip (16/11). An image: its format; a sound:
    // its length; a clip: both (« BROUILLON » is in Détails now).
    assert.equal(body.dataset.mode, 'video');
    mode(0);
    assert.equal(readout(), '1:1');
    mode(2);
    assert.equal(readout(), '10.00 S');
    mode(1);
    assert.equal(readout(), '16:9 - 05.04 S');
    // No « i » on the screen, nothing it opened.
    studio.show(clip);
    assert.deepEqual(body.find('studio-details-go'), []);
    assert.deepEqual(body.find('studio-details'), []);
  } finally {
    restore();
  }
});

test('the floppy disk keeps the settings of the model, given back each time it is chosen; nothing « Fixe » is kept', async () => {
  const lengths = { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    free = {
      id: 'h',
      name: 'H3',
      styled: true,
      direct: true,
      seeded: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      lengths,
      roles: {},
      loras: [
        { id: 'msr', name: 'MSR', assistant: true, on: false, strength: { min: 0, max: 2, default: 1 } },
        { id: 'net', name: 'Net', assistant: false, on: true, strength: { value: 0.7 } },
      ],
    },
    // Length, size and seed fixed in Workflows: no bar, no seed, nothing of them kept.
    fixed = {
      id: 'f',
      name: 'Fixe',
      styled: true,
      direct: false,
      seeded: false,
      limits: sizes,
      size: { width: 768, height: 448 },
      settings: [],
      roles: {},
    };
  const posted = [];
  const { body, restore, mode } = await studioPage(
    { create_video: [free, fixed] },
    {
      'studio/preset': request => {
        posted.push(request);
        return { workflow: request.workflow, preset: { ...request.preset, savedAt: 'maintenant' } };
      },
    },
  );
  try {
    mode(1);
    const disk = () => body.find('studio-save')[0],
      duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration'),
      model = id => {
        const pick = body.find('studio-model-pick')[0];
        pick.value = id;
        pick.onchange();
      };
    // In the Modèle block, its name for screen readers and in its tooltip; quiet at first.
    assert.equal(body.find('studio-set-model')[0].find('studio-save').length, 1);
    assert.equal(disk().dataset.state, 'still');
    assert.match(disk().attributes['aria-label'], /^Enregistrer ces réglages pour H3/);
    // A setting moved: a light pill.
    duration().value = '1';
    duration().oninput();
    assert.equal(disk().dataset.state, 'changed');
    // A seed and the LoRA left to the assistant, then saved: what is free, nothing else.
    body.find('studio-more-pill')[0].onclick();
    const seed = body.find('studio-seed')[0].children[1];
    seed.value = '42';
    seed.oninput();
    body.find('studio-lora-switch')[0].checked = true;
    body.find('studio-lora-switch')[0].onchange();
    await disk().onclick();
    await settle();
    const [first] = posted;
    assert.equal(first.workflow, 'h');
    assert.equal(first.preset.length, 193 / 24);
    assert.equal(first.preset.seed, '42');
    assert.equal(first.preset.format, '16:9');
    assert.deepEqual(first.preset.styles, []);
    assert.deepEqual(first.preset.loras, { msr: { on: true, strength: 1 } }, 'the LoRA fixed in Workflows is not kept');
    // Just saved: the check.
    assert.equal(disk().dataset.state, 'saved');
    assert.match(disk().attributes['aria-label'], /^Réglages enregistrés pour H3/);

    // Changed again, then another model: its own, nothing saved for it yet.
    duration().value = '2';
    duration().oninput();
    model('f');
    assert.equal(disk().dataset.state, 'still');
    await disk().onclick();
    await settle();
    assert.deepEqual(Object.keys(posted[1].preset), ['styles'], 'length, size and seed fixed: none of them kept');
    // Back to H3: its saved settings come back.
    model('h');
    assert.equal(duration().value, '1');
    assert.equal(duration().attributes['aria-valuetext'], '08.04 S');
    assert.equal(body.find('studio-seed')[0].children[1].value, '42');
    assert.equal(body.find('studio-lora-switch')[0].checked, true);
    assert.equal(disk().dataset.state, 'still');
  } finally {
    restore();
  }
});

test('the settings saved for a model come back the first time the Studio shows it', async () => {
  const video = {
    id: 'h',
    name: 'H3',
    styled: true,
    direct: true,
    seeded: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    roles: {},
  };
  const { body, restore, mode } = await studioPage(
    { create_video: [video] },
    {},
    {
      presets: {
        h: { length: 241 / 24, seed: '7', styles: [{ name: 'b.safetensors', strength: 0.5 }], savedAt: 'hier' },
      },
    },
  );
  try {
    mode(1);
    const duration = body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration.attributes['aria-valuetext'], '10.04 S');
    assert.equal(body.find('studio-seed')[0].children[1].value, '7');
    assert.equal(body.find('studio-lora-row').length, 1);
  } finally {
    restore();
  }
});

test('a model this computer cannot run is greyed in the list with its reason, and never generates', async () => {
  const reason = 'Krea2 demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.';
  const model = (id, more = {}) => ({
    id,
    name: id,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
    ...more,
  });
  const routes = { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }) };
  const started = asked => asked.filter(([route]) => route === 'tools/action').length;
  // Another model can run: it is the one in hand, the other is greyed in the list, its reason in its bubble.
  // (0.6.200) Nothing under the list: the model chosen can run (check of 21/11, overload, problem 8).
  let studio = await studioPage({ create_image: [model('moss'), model('krea', { unavailable: reason })] }, routes);
  try {
    const [usable, greyed] = studio.body.find('studio-model-pick')[0].children;
    assert.equal(usable.disabled, undefined);
    assert.deepEqual([greyed.disabled, greyed.title], [true, reason]);
    assert.deepEqual(studio.body.find('studio-model-note'), []);
    // « Générer » waits for a prompt only (55), not for the model greyed in the list.
    assert.deepEqual(
      [studio.body.find('studio-go')[0].disabled, studio.body.find('studio-go')[0].title],
      [true, 'Décrivez d’abord votre image.'],
    );
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.studio.render();
    assert.equal(studio.body.find('studio-go')[0].disabled, false);
  } finally {
    studio.restore();
  }
  // No other model: it is shown all the same, « Générer » greyed and saying why.
  studio = await studioPage({ create_image: [model('krea', { unavailable: reason })] }, routes);
  try {
    const go = studio.body.find('studio-go')[0];
    assert.deepEqual([go.disabled, go.title], [true, reason]);
    assert.equal(studio.body.find('studio-model-note')[0].textContent, reason);
    // Asked all the same (Ctrl + Entrée, or the button reached otherwise): nothing starts, and
    // the reason is said.
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    await go.onclick();
    await settle();
    assert.equal(started(studio.asked), 0);
    // (0.6.253) In the bubble of « Générer » greyed, at once, as generer-maquette.md has it (a notice before).
    assert.equal(studio.said.at(-1), reason);
  } finally {
    studio.restore();
  }
  // (0.6.200) None can run (a computer without an NVIDIA card): under the list, the reason of the one in hand
  // alone, one sentence; the others greyed in the list, each its reason in its bubble. The four were said there.
  const other = 'MOSS Image demande une carte graphique NVIDIA : son pilote n’en voit aucune sur cet ordinateur.';
  studio = await studioPage({ create_image: [model('krea', { unavailable: reason }), model('moss', { unavailable: other })] }, routes);
  try {
    const options = studio.body.find('studio-model-pick')[0].children;
    assert.deepEqual(studio.body.find('studio-model-note').map(note => note.textContent), [reason]);
    assert.deepEqual(options.map(option => [option.disabled, option.title]), [[true, reason], [true, other]]);
  } finally {
    studio.restore();
  }
});

/**
 * (0.6.188) The page as it is laid out, for what follows the prompt without drawing the Studio again
 * (goable): « Générer » there is the one drawn last.
 */
const laidOutGo = selector =>
  selector === '#studio-view .studio-go' ? (globalThis.document.getElementById('studio-body')?.find('studio-go')[0] ?? null) : null;
/** (0.6.188) Wan 2.2 as lib/tool-catalog.mjs tells it to the Studio: its start image is required (runner/families/wan22.json). */
const wanStudio = () => ({
  id: 'wan',
  name: 'Wan 2.2',
  verb: 'create_video',
  limits: sizes,
  size: { width: 768, height: 448 },
  settings: [],
  seeded: true,
  roles: {
    start_image: { count: 1, media: ['image'], many: false, required: true },
    end_image: { count: 0, media: [], many: false },
    reference: { count: 0, media: [], many: true },
  },
  inputs: { start_image: 'start_image' },
});

test('« Générer » is greyed while an input its model cannot do without is missing: its tooltip says which, it comes back once given (0.6.188)', async () => {
  // (0.6.188, capture 96) It stayed lit, and said what was missing only once pressed (request). What cannot be done
  // is greyed with its reason written: the sentence request() says. SCAIL-2 needs the video and the character; the
  // image to modify of Krea 2 is optional. Each as lib/tool-catalog.mjs tells it to the Studio.
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      inputs: { driving_video: 'source', reference_image: 'reference' },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    },
    krea = {
      id: 'k',
      name: 'Krea 2',
      verb: 'create_image',
      direct: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
      roles: { source: { count: 1, media: ['image'], many: false }, reference: { count: 0, media: [], many: true } },
      inputs: { img2img: 'source' },
    };
  const page = await studioPage(
    { create_image: [krea], create_video: [wanStudio()], replace_character: [scail] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }) },
    { querySelector: laidOutGo },
  );
  const { body, asked, said, restore } = page;
  const go = () => body.find('studio-go')[0],
    shown = () => [go().disabled, go().title],
    ready = /^Générer \((Ctrl|⌘)\+Entrée\)$/,
    type = text => {
      page.prompt().value = text;
      page.prompt().oninput();
    },
    drop = async (index, file) => {
      body.find('studio-slot')[index].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file], setData() {} } });
      await settle();
    },
    started = () => asked.filter(([route]) => route === 'tools/action').length;
  try {
    page.mode(1);
    assert.equal(body.find('studio-model-pick')[0].value, 'wan');
    // Nothing typed: the prompt is asked for first, as request() asks for it (55). (0.6.253) « Décrivez d’abord
    // votre vidéo. » (generer-maquette.md), no longer « Écrivez un prompt pour générer ».
    assert.deepEqual(shown(), [true, 'Décrivez d’abord votre vidéo.']);
    // Typed, it stays greyed while the start image is missing, and says so: as typed (goable, which lit it from the
    // prompt alone), drawn again, and one key more.
    type('Le vieux pêcheur lève lentement les yeux vers le large');
    assert.deepEqual(shown(), [true, 'Ajoutez l’image de début.']);
    page.studio.render();
    assert.deepEqual(shown(), [true, 'Ajoutez l’image de début.']);
    type('Le vieux pêcheur lève lentement les yeux vers le large.');
    assert.deepEqual(shown(), [true, 'Ajoutez l’image de début.']);
    // Asked all the same (Ctrl + Entrée): nothing starts, the sentence is said. (0.6.253) In the bubble of « Générer »
    // at once, as a press on it says it (generer-maquette.md), no longer on a line under it (request).
    page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    assert.equal(started(), 0);
    assert.deepEqual([said.at(-1), body.find('studio-error')], ['Ajoutez l’image de début.', []]);
    // The image dropped on its case (the Studio is drawn again): lit, and typing keeps it so. Taken back: greyed again.
    await drop(0, { name: 'pecheur.png', type: 'image/png' });
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    // (What was asked for is given: its sentence is gone from under the button. It stayed there, the button lit.)
    assert.deepEqual(body.find('studio-error'), []);
    assert.equal(go().disabled, false);
    assert.match(go().title, ready);
    type('Le vieux pêcheur lève les yeux.');
    assert.equal(go().disabled, false);
    assert.match(go().title, ready);
    body.find('studio-slot-remove')[0].onclick();
    assert.deepEqual(shown(), [true, 'Ajoutez l’image de début.']);

    // SCAIL-2: the video to follow, then the image of the character.
    const pick = body.find('studio-model-pick')[0];
    pick.value = 's';
    pick.onchange();
    assert.deepEqual(shown(), [true, 'Ajoutez la vidéo à suivre.']);
    type('Une femme en haut blanc mange une pomme dans un verger.');
    assert.deepEqual(shown(), [true, 'Ajoutez la vidéo à suivre.']);
    await drop(0, { name: 'clip.mp4', type: 'video/mp4' });
    assert.deepEqual(shown(), [true, 'Ajoutez l’image du personnage.']);
    type('Une femme en haut blanc mange une pomme.');
    assert.deepEqual(shown(), [true, 'Ajoutez l’image du personnage.']);
    await drop(1, { name: 'perso.png', type: 'image/png' });
    assert.equal(go().disabled, false);
    assert.match(go().title, ready);

    // Krea 2: its image to modify is optional, never asked for.
    page.mode(0);
    type('Un phare dans la brume');
    assert.equal(go().disabled, false);
    assert.match(go().title, ready);
    page.studio.render();
    assert.deepEqual([go().disabled, /is-filled/.test(body.find('studio-slot')[0].className)], [false, false]);
    assert.match(go().title, ready);
  } finally {
    restore();
  }
});

test('typing does not light « Générer » greyed while another conversation makes a creation (0.6.188)', async () => {
  // (Read by the sub-agent of lot 3, 21/11.) The form greys it and says why (0.6.81); a key lit it again from the
  // prompt alone, its tooltip back to « Générer »: its click was refused all the same.
  let why = 'Une création est en cours dans « Renard dans la neige » : attendez sa fin.';
  const image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  const page = await studioPage({ create_image: [image] }, {}, { querySelector: laidOutGo, extra: { elsewhere: () => why } });
  try {
    const go = () => page.body.find('studio-go')[0],
      type = words => {
        page.prompt().value = words;
        page.prompt().oninput();
      };
    type('un phare');
    page.studio.render();
    assert.deepEqual([go().disabled, go().title], [true, why]);
    type('un phare dans la tempête');
    assert.deepEqual([go().disabled, go().title], [true, why]);
    // Over elsewhere: the Studio is drawn again (busyChanged, 0.6.86), and what is typed lights it as before.
    why = '';
    page.studio.busyChanged();
    type('un phare');
    assert.equal(go().disabled, false);
    assert.match(go().title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
  } finally {
    page.restore();
  }
});

test('« Générer » is not greyed for an input a proposal of Moodix AI puts itself, a character being checked, the clip of a continuation; typing leaves « Libérer le GPU » alone (0.6.188)', async () => {
  // A proposal puts its images itself, as it writes its prompt (55): its « Générer » is the answer. Refused, the
  // Studio is the user's again, and so is the rule.
  const { clip, request } = proposalOf();
  clip.roles.start_image.required = true;
  let page = await studioPage({ create_video: [clip] }, {}, { querySelector: laidOutGo });
  try {
    const answer = page.studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(page.studio.proposing(), true);
    assert.equal(/is-filled/.test(page.body.find('studio-slot')[0].className), false);
    const go = page.body.find('studio-go')[0];
    assert.equal(go.disabled, false);
    assert.match(go.title, /^Générer la proposition de Moodix AI \((Ctrl|⌘)\+Entrée\)$/);
    page.studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(page.prompt().value, 'Un renard se lève');
    assert.deepEqual([page.body.find('studio-go')[0].disabled, page.body.find('studio-go')[0].title], [true, 'Ajoutez l’image de début.']);
  } finally {
    page.restore();
  }

  // A character waits for its check: from Vidéo, « Générer » brings its question back (it is no answer there).
  const image = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    runs = [{ id: 'made', conversationId: 'c1', workflowId: 'k', prompt: 'A full-length photo of a player', parameters: {}, outputs: [{ originalUrl: '/made.png', thumbUrl: '/made.jpg' }] }];
  page = await studioPage({ create_image: [image], create_video: [wanStudio()] }, {}, { runs, querySelector: laidOutGo });
  try {
    const check = page.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    page.mode(1);
    page.prompt().value = 'une mouette au-dessus du port';
    page.prompt().oninput();
    page.studio.render();
    assert.equal(page.body.find('studio-go')[0].disabled, false);
    await page.body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([page.body.dataset.mode, page.body.find('studio-check-question').length], ['image', 1]);
    await page.body.find('studio-go')[0].onclick();
    assert.equal((await check).decision, 'ok');
  } finally {
    page.restore();
  }

  // A continuation: its clip is the one continued, never asked for (its source is required by extend_video).
  const more = continuing();
  page = await studioPage(more.tools, {}, { runs: more.runs, querySelector: laidOutGo });
  try {
    prolonger(page.body).onclick();
    assert.equal(page.body.find('studio-go-label')[0].textContent, 'Générer la suite');
    page.prompt().value = 'il s’arrête';
    page.prompt().oninput();
    assert.equal(page.body.find('studio-go')[0].disabled, false);
    page.studio.render();
    assert.equal(page.body.find('studio-go')[0].disabled, false);
    assert.match(page.body.find('studio-go')[0].title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
  } finally {
    page.restore();
  }

  // A creation under way (one followed again after a reload): its bar says it, nothing of an input.
  page = await studioPage({ create_video: [wanStudio()] }, {});
  try {
    page.mode(1);
    page.prompt().value = 'Le vieux pêcheur lève les yeux';
    page.prompt().oninput();
    page.studio.followAgain();
    const go = page.body.find('studio-go')[0];
    assert.deepEqual([go.disabled, page.body.find('studio-go-label')[0].textContent], [true, 'En cours…']);
    assert.notEqual(go.title, 'Ajoutez l’image de début.');
    await page.studio.settled({ record: null });
    assert.deepEqual([page.body.find('studio-go')[0].disabled, page.body.find('studio-go')[0].title], [true, 'Ajoutez l’image de début.']);
  } finally {
    page.restore();
  }

  // The card held by the last creation (54): « Libérer le GPU » takes the place of « Générer », and what is typed
  // does not touch it (goable found it under the name of « Générer »).
  page = await studioPage({ create_video: [wanStudio()] }, {}, { querySelector: laidOutGo, extra: { gpuBlocked: () => true } });
  try {
    page.mode(1);
    const free = () => page.body.find('studio-go')[0],
      held = 'La carte graphique est restée prise par la dernière génération : la libérer';
    assert.match(free().className, /studio-recover/);
    assert.deepEqual([free().disabled, free().title], [undefined, held]);
    page.prompt().value = 'Le vieux pêcheur lève les yeux';
    page.prompt().oninput();
    assert.deepEqual([free().disabled, free().title], [undefined, held]);
    page.prompt().value = '';
    page.prompt().oninput();
    assert.deepEqual([free().disabled, free().title], [undefined, held]);
  } finally {
    page.restore();
  }
});

test('Ctrl + Entrée generates from anywhere in the Studio, and the button says so in its tooltip', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { page, body, asked, said, pageKeys, restore } = studio;
  try {
    const key = (overrides = {}) => ({ key: 'Enter', ctrlKey: true, preventDefault() {}, ...overrides }),
      started = () => asked.filter(([route]) => route === 'tools/action').length;
    // The triangle and « Générer »; the keys in its tooltip, no more « Ctrl ↵ » in the button. (0.6.253) Its
    // triangle with rounded corners (`i-go`, generer-maquette.md), no longer the one of a player.
    const go = body.find('studio-go')[0];
    assert.equal(go.children[0].glyph, 'go');
    assert.equal(go.children[1].textContent, 'Générer');
    assert.equal(body.find('studio-go-key').length, 0);
    // Nothing typed, it is greyed and says why (55); a prompt typed, the keys are in its tooltip.
    assert.deepEqual([go.disabled, go.title], [true, 'Décrivez d’abord votre image.']);
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    studio.studio.render();
    assert.match(body.find('studio-go')[0].title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
    studio.prompt().value = '';
    studio.prompt().oninput();
    // Nothing typed: a prompt is asked for, nothing starts. (0.6.253) In the bubble of « Générer », as a press on
    // it greyed says it, no longer on a line under it.
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(started(), 0);
    assert.deepEqual([said.at(-1), body.find('studio-error')], ['Décrivez d’abord votre image.', []]);
    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    // Entrée alone is a line in the prompt.
    page['studio-view'].onkeydown(key({ ctrlKey: false }));
    assert.equal(started(), 0);
    // The message box of the chat sends with Entrée: the key is not the Studio's there.
    page['studio-view'].onkeydown(key({ target: { id: 'prompt' } }));
    assert.equal(started(), 0);
    page['studio-view'].onkeydown(key());
    await settle();
    const [, sent] = asked.find(([route]) => route === 'tools/action');
    // What is typed is what is sent: no style line is added any more.
    assert.equal(sent.arguments.prompt, 'un phare');

    // After a click beside the fields the focus is on none: the key reaches the page itself, and
    // generates too, but only while the Studio is the view on screen.
    const onPage = () => pageKeys.forEach(listener => listener({ ...key(), target: document.body }));
    assert.equal(started(), 1);
    onPage();
    assert.equal(started(), 1, 'the Studio is not on screen');
    page['studio-view'].offsetParent = {};
    onPage();
    await settle();
    assert.equal(started(), 2);
    // A key pressed in a field of another view is not the Studio's.
    pageKeys.forEach(listener => listener({ ...key(), target: {} }));
    assert.equal(started(), 2);
  } finally {
    restore();
  }
});

test('« Moodix AI » (« Agent » before), right of « Générer », opens the chat as the band at the foot did', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  let opened = 0;
  const { body, restore } = await studioPage({ create_image: [image] }, {}, { openAgent: () => opened++ });
  try {
    const group = body.find('studio-go-group')[0],
      [agent] = body.find('studio-agent'),
      go = body.find('studio-go')[0];
    assert.equal(agent.id, 'agent-open');
    // The Double verre (studio-maquette.md): « ▶ Générer », a rule, the Agent. (0.6.253, generer-maquette.md) Two
    // buttons: [« × 1 ⌄ » | « ▶ Générer »] in one glass, then « Moodix AI » in its own.
    const [glass] = body.find('studio-go-glass'),
      [tries] = body.find('studio-tries');
    assert.deepEqual(group.children, [glass, agent], 'the glass of Générer then Moodix AI, in one group');
    assert.deepEqual([glass.children[0], glass.children[1].className, glass.children[2]], [tries, 'studio-go-rule', go]);
    assert.equal(tries.attributes['aria-label'], 'Essais : 1');
    assert.deepEqual(tries.find('studio-tries-count').map(count => count.textContent), ['1']);
    assert.equal(agent.find('studio-agent-word')[0].textContent, 'Moodix AI');
    // An icon, its word, its name for screen readers and in its tooltip.
    assert.equal(agent.attributes['aria-label'], 'Demander à Moodix AI');
    assert.equal(agent.title, 'Demander à Moodix AI');
    assert.equal(agent.attributes['aria-controls'], 'chat-panel');
    // No colour along its foot (moodix-design.md 7 bis 22), only the light of its work.
    assert.equal(agent.find('studio-agent-rule').length, 0);
    assert.equal(agent.find('studio-agent-light').length, 1);
    agent.onclick();
    assert.equal(opened, 1);
    // The Sortie: no colour along its foot any more.
    const output = body.find('is-output')[0];
    assert.equal(body.find('moodix-rule').length, 0);
    assert.notEqual(output.children.at(-1).className, 'moodix-rule studio-output-rule');
  } finally {
    restore();
  }
  // Nothing ready to make: the chat stays at hand all the same.
  const empty = await studioPage({ create_image: [] }, {}, { openAgent: () => opened++ });
  try {
    const [agent] = empty.body.find('studio-agent');
    assert.ok(agent, 'Agent shown with the message');
    agent.onclick();
    assert.equal(opened, 2);
  } finally {
    empty.restore();
  }
});

test('(0.6.255) the actions of the take stand in a column at the right of the frame, their names under their icons; no bubble but the reason of one greyed; held while a take is made; none for a sound or a clip continued', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    sound = { id: 's', name: 'Bruitages', roles: {}, settings: [] };
  const held = [];
  const page = await studioPage(
    { create_image: [image], create_video: [wanStudio()], create_audio: [sound], extend_video: [{ ...wanStudio(), verb: 'extend_video' }] },
    {
      'tools/actions': () => ({ upscale: ['image', 'video'], extend_video: ['video'], refilm_video: ['video'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // While it is made: the column of the take on the screen, held.
        const row = rail()[0];
        held.push([row?.inert, row?.className]);
        return { id: 'j', state: 'error', error: 'rien' };
      },
    },
    {
      runs: [
        { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1 }] },
        { id: 'c', conversationId: 'c1', mediaType: 'video', workflowId: 'wan', prompt: 'la mer', outputs: [{ originalUrl: '/c.mp4', take: 2 }] },
        { id: 's', conversationId: 'c1', mediaType: 'audio', workflowId: 's', prompt: 'des vagues', outputs: [{ originalUrl: '/s.wav', take: 3 }] },
      ],
    },
  );
  const { body, restore } = page;
  const rail = () => body.find('studio-frame-over')[0]?.find('studio-rail') ?? [],
    buttons = () => rail()[0]?.find('output-action') ?? [],
    named = () => buttons().map(button => [button.className.split(' ')[1], button.children[1].textContent, button.disabled, button.title]);
  try {
    await settle();
    // An image: « Agrandir », « Animer », over the frame (studio-frame-over follows its size); the bar under the
    // screen keeps « Générer » and Moodix AI alone.
    assert.equal(body.dataset.mode, 'image');
    assert.equal(rail().length, 1);
    assert.deepEqual(body.find('studio-actionbar')[0].find('output-action'), []);
    assert.deepEqual(named(), [
      ['output-action-upscale', 'Agrandir', false, undefined],
      ['output-action-animate', 'Animer', true, 'Aucun modèle vidéo ne part d’une image.'],
    ]);
    // Its words are still said to a screen reader.
    assert.equal(buttons()[0].attributes['aria-label'], 'Agrandir et affiner ce résultat');
    // (0.6.261) Greyed, it still answers, as « Générer »: by aria-disabled (Tab reaches it), its reason in its bubble
    // at its click, nothing done (« Animer » went to Vidéo meanwhile).
    assert.deepEqual([buttons()[1].attributes['aria-disabled'], buttons()[0].attributes['aria-disabled']], ['true', undefined]);
    buttons()[1].onclick();
    await settle();
    assert.deepEqual([page.said, body.dataset.mode], [['Aucun modèle vidéo ne part d’une image.'], 'image']);
    // Held while a take is made, lit again at its end.
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual(held, [[true, 'output-actions studio-rail']]);
    assert.equal(rail()[0].inert, false);
    // A clip: its four, in that order.
    page.mode(1);
    await settle();
    assert.deepEqual(
      named().map(([, name, greyed]) => [name, greyed]),
      [
        ['Prolonger', false],
        ['Changer la caméra', false],
        ['Interpoler', true],
        ['Agrandir', false],
      ],
    );
    // Continued: the column goes, as the actions went from the bar before.
    buttons()[0].onclick();
    assert.equal(prolonged(body).length, 1);
    assert.deepEqual(rail(), []);
    // A sound: none.
    page.mode(2);
    await settle();
    assert.deepEqual([body.dataset.mode, rail()], ['audio', []]);
  } finally {
    restore();
  }
});

test('(0.6.256) « Agrandir » prepares its page and waits for « ▶ Agrandir »: the take in « À agrandir », the prompt greyed, the model and its size; made, glued to its take; left by ×, by its button, by another page', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    finishing = (id, name, finish) => ({ id, name, media: 'image', verb: 'upscale', roles: { source: { count: 1, media: ['image'], required: true } }, settings: [], finish }),
    seedvr = finishing('sv', 'Upscale SeedVR2', { key: 'scale', choices: [2, 4], standard: 2 }),
    esrgan = finishing('es', 'Upscale rapide (Real-ESRGAN ×4)', { factor: 4 });
  const seen = [];
  const page = await studioPage(
    // (A model of clips first: not offered for an image.)
    { create_image: [image], create_video: [wanStudio()], upscale: [{ ...finishing('ev', 'Upscale vidéo (Real-ESRGAN ×2)', { factor: 2 }), media: 'video' }, seedvr, esrgan] },
    {
      'tools/actions': () => ({ upscale: ['image'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // While it is made: the take on the screen, veiled with its band; « ↳ AGRANDIE » glued before it in the Sortie.
        const frame = page.body.find('studio-frame')[0],
          strip = page.body.find('studio-strip')[0].children;
        seen.push([frame.className.includes('is-finishing'), frame.find('studio-finish-band').length, screenOf(page.body.find('studio-frame-result')[0])?.src]);
        seen.push(strip.map(tile => tile.find('studio-item-number')[0]?.textContent));
        const record = {
          id: 'u',
          conversationId: 'c1',
          prompt: 'un phare',
          parameters: { pipeline: 'seedvr2', references: [{ role: 'source_image', output_id: 'a' }] },
          outputs: [{ originalUrl: '/u.png', take: 2, width: 4096, height: 4096 }],
        };
        page.runs.unshift(record);
        return { id: 'j', state: 'done', record };
      },
    },
    { runs: [{ id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 1024, height: 1024 }] }] },
  );
  const { body, asked, restore } = page;
  const rail = name => body.find('studio-rail')[0]?.find('output-action-' + name)[0],
    sent = () => asked.filter(([route]) => route === 'tools/action'),
    chips = () => body.find('studio-finish-chip').map(chip => [chip.children[0].textContent, chip.attributes['aria-checked']]),
    size = () => body.find('studio-finish-result')[0]?.textContent,
    goWord = () => body.find('studio-go-label')[0].textContent;
  try {
    await settle();
    page.prompt().value = 'un phare au loin';
    page.prompt().oninput();
    // Pressed: nothing made, its page.
    rail('upscale').onclick();
    assert.equal(sent().length, 0, 'it waits for its button');
    const [piece] = body.find('studio-finish');
    assert.equal(piece.find('studio-piece-word')[0].textContent, 'À agrandir');
    assert.equal(piece.find('studio-slot-pick')[0].title, 'À agrandir · PRISE 1 · IMAGE');
    // Its prompt greyed, empty, why under the pointer; the prompt of Image kept in its draft.
    const field = body.find('studio-prompt-field')[0];
    assert.deepEqual([page.prompt().disabled, page.prompt().value, field.className.includes('is-needless'), field.title], [true, '', true, 'Agrandir n’a pas besoin de prompt.']);
    assert.equal(body.find('studio-enrich').length, 0);
    // « ▶ Agrandir », lit; the button of the take pressed.
    assert.deepEqual([goWord(), body.find('studio-go')[0].disabled], ['Agrandir', false]);
    assert.deepEqual([rail('upscale').className.includes('is-on'), rail('upscale').attributes['aria-pressed']], [true, 'true']);
    // At the right: the model, « Taille » × 2 · × 4, the size it gives; no format, no LoRA, no « Plus de réglages ».
    assert.equal(body.find('studio-model-pick')[0].value, 'sv');
    assert.deepEqual([chips(), size()], [[['× 2', 'true'], ['× 4', 'false']], '2048 × 2048']);
    assert.deepEqual([body.find('studio-set-format').length, body.find('studio-more-pill').length], [0, 0]);
    body.find('studio-finish-chip')[1].onclick();
    assert.deepEqual([chips(), size()], [[['× 2', 'false'], ['× 4', 'true']], '4096 × 4096']);
    // Real-ESRGAN: its factor alone, said by its name.
    const pick = body.find('studio-model-pick')[0];
    pick.value = 'es';
    pick.onchange();
    assert.deepEqual([chips(), body.find('studio-finish-factor')[0]?.textContent, size()], [[], '× 4', '4096 × 4096']);
    pick.value = 'sv';
    body.find('studio-model-pick')[0].onchange.call(pick);
    // Left by its ×: Image as it was, its model and its prompt.
    body.find('studio-finish')[0].find('studio-slot-remove')[0].onclick();
    assert.deepEqual([body.find('studio-finish').length, goWord(), page.prompt().value, body.find('studio-model-name')[0]?.textContent ?? body.find('studio-model-pick')[0]?.value], [0, 'Générer', 'un phare au loin', 'Image']);
    // Left by its button pressed again, and by another page of the Studio.
    rail('upscale').onclick();
    rail('upscale').onclick();
    assert.equal(body.find('studio-finish').length, 0);
    rail('upscale').onclick();
    page.mode(1);
    page.mode(0);
    assert.equal(body.find('studio-finish').length, 0);
    // Made: the take, the model of the page named, its factor (× 4 chosen before: the page starts again from × 2).
    rail('upscale').onclick();
    body.find('studio-finish-chip')[1].onclick();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = sent().at(-1);
    assert.equal(action.name, 'upscale');
    assert.deepEqual(action.arguments, { source: { output: 'a' }, workflow: 'sv', intention: 'Agrandir l’image.', scale: 4 });
    assert.deepEqual(seen, [
      [true, 1, '/a.png'],
      ['↳ AGRANDIE', 'PRISE 1'],
    ]);
    // Its page left, the take agrandie on the screen, « ↳ AGRANDIE » glued to its take.
    assert.equal(body.find('studio-finish').length, 0);
    assert.equal(screenOf(body.find('studio-frame-result')[0]).src, '/u.png');
    const tiles = body.find('studio-strip')[0].children;
    assert.deepEqual(tiles.map(tile => tile.find('studio-item-number')[0].textContent), ['↳ AGRANDIE', 'PRISE 1']);
    assert.ok(tiles[0].className.includes('is-suite'));
  } finally {
    restore();
  }
});

test('(0.6.256) « Animer » always starts the video from the image: its Début with the first model that takes one, on the screen at half its light, its format greyed, the cursor in the prompt', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    // The first video model takes subjects only: the picture goes to the next one, which starts from it.
    subjects = { id: 'h3', name: 'MiniMax H3', verb: 'create_video', limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true, roles: { reference: { count: 3, media: ['image'], many: true } } };
  // (0.6.261) Refused the first time, made the second.
  let tried = 0;
  const page = await studioPage(
    { create_image: [image], create_video: [subjects, wanStudio()] },
    {
      'tools/actions': () => ({ animate: ['image'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        if (!tried++) return { id: 'j', state: 'error', error: 'rien' };
        const record = { id: 'v', conversationId: 'c1', mediaType: 'video', workflowId: 'wan', prompt: 'la mer monte', outputs: [{ originalUrl: '/v.mp4', thumbUrl: '/v.jpg', take: 2 }] };
        page.runs.unshift(record);
        return { id: 'j', state: 'done', record };
      },
    },
    { runs: [{ id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 768, height: 1344 }] }] },
  );
  const { body, restore } = page;
  const start = () => body.find('studio-slot').find(tile => tile.dataset.slot === 'start_image-0')?.children[0]?.children[0]?.src ?? null,
    formats = () => body.find('studio-format').filter(chip => !chip.className.includes('is-more'));
  try {
    await settle();
    // « × 3 » in Image: back to one in Vidéo.
    body.find('studio-tries')[0].onclick();
    body.find('studio-tries-menu')[0].children[2].onclick();
    body.find('studio-rail')[0].find('output-action-animate')[0].onclick();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(body.find('studio-model-pick')[0].value, 'wan');
    assert.deepEqual([start(), body.find('studio-tries')[0].attributes['aria-label']], ['/a.png', 'Essais : 1']);
    // On the screen: the picture at half its light, « DÉBUT » at its top left; no column of actions (no take on it).
    assert.equal(body.find('studio-frame-start')[0]?.src, '/a.png');
    assert.equal(body.find('studio-frame-label')[0].textContent, 'DÉBUT');
    assert.deepEqual(body.find('studio-rail'), []);
    // Its format, greyed and why; the prompt waits for the movement.
    const checked = formats().find(chip => chip.attributes['aria-checked'] === 'true');
    assert.deepEqual([checked?.children[0].textContent, checked?.disabled, checked?.title], ['9:16', true, 'Le format suit l’image de début.']);
    checked.onclick();
    assert.equal(page.prompt().placeholder, 'Décrivez le mouvement…');
    // A prompt written before in Vidéo is kept.
    page.mode(0);
    page.mode(1);
    page.prompt().value = 'la mer monte';
    page.prompt().oninput();
    page.mode(0);
    body.find('studio-rail')[0].find('output-action-animate')[0].onclick();
    assert.equal(page.prompt().value, 'la mer monte');
    // (0.6.261) Refused: the picture stays on the screen under « DÉBUT », its format greyed (it went as the video left).
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([body.find('studio-frame-start').length, body.find('studio-frame-label')[0]?.textContent, body.find('studio-error')[0]?.textContent], [1, 'DÉBUT', 'rien']);
    assert.equal(formats().find(chip => chip.attributes['aria-checked'] === 'true')?.disabled, true);
    // Made: the screen is the take's again (the picture stays its Début).
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([body.find('studio-frame-start').length, start()], [0, '/a.png']);
  } finally {
    restore();
  }
});

test('(0.6.256) « Interpoler » prepares its page as Agrandir: « À interpoler », « Images » × 2 · × 4 and the images a second it gives', async () => {
  const rife = {
    id: 'rife',
    name: 'Interpoler (RIFE 4.26)',
    media: 'video',
    verb: 'interpolate',
    roles: { source: { count: 1, media: ['video'], required: true } },
    settings: [],
    finish: { key: 'multiplier', choices: [2, 4], standard: 2 },
  };
  const page = await studioPage(
    { create_image: [], create_video: [wanStudio()], interpolate: [rife] },
    { 'tools/actions': () => ({ interpolate: ['video'] }), 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [{ id: 'c', conversationId: 'c1', mediaType: 'video', prompt: 'la mer', parameters: { fps: 24, frames: 121 }, outputs: [{ originalUrl: '/c.mp4', take: 4 }] }] },
  );
  const { body, asked, restore } = page;
  try {
    page.mode(1);
    await settle();
    body.find('studio-rail')[0].find('output-action-interpolate')[0].onclick();
    assert.equal(body.find('studio-finish')[0].find('studio-piece-word')[0].textContent, 'À interpoler');
    assert.equal(body.find('studio-prompt-field')[0].title, 'Interpoler n’a pas besoin de prompt.');
    // Lit without a prompt: it needs none.
    assert.deepEqual([body.find('studio-go-label')[0].textContent, body.find('studio-go')[0].disabled, page.prompt().value], ['Interpoler', false, '']);
    assert.match(body.find('studio-go')[0].title, /^Interpoler \((Ctrl|⌘)\+Entrée\)$/);
    assert.equal(body.find('studio-finish-line')[0].children[0].textContent, 'Images');
    assert.equal(body.find('studio-finish-result')[0].textContent, '48 images par seconde');
    body.find('studio-finish-chip')[1].onclick();
    assert.equal(body.find('studio-finish-result')[0].textContent, '96 images par seconde');
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.deepEqual([action.name, action.arguments], ['interpolate', { source: { output: 'c' }, workflow: 'rife', intention: 'Rendre la vidéo plus fluide.', multiplier: 4 }]);
    // Not made: its page stays, its reason said.
    assert.deepEqual([body.find('studio-finish').length, body.find('studio-error')[0]?.textContent], [1, 'rien']);
  } finally {
    restore();
  }
});

test('(0.6.261) the size the page Agrandir says is the one its engine makes: SeedVR2 held to 8192, Real-ESRGAN reduced to an even side, a half rounded as Python does', async () => {
  const { roundHalfEven } = await import('../public/studio.mjs');
  assert.deepEqual([4680.5, 4681.5, 803.5, 2.4, 2.6].map(roundHalfEven), [4680, 4682, 804, 2, 3]);
  const finishing = (id, name, media, finish) => ({ id, name, media, verb: 'upscale', roles: { source: { count: 1, media: [media], required: true } }, settings: [], finish }),
    seedvr = finishing('sv', 'Upscale SeedVR2', 'image', { key: 'scale', choices: [2, 4], standard: 2, maxSide: 8192 }),
    clips = finishing('ev', 'Upscale vidéo (Real-ESRGAN ×2)', 'video', { factor: 2, maxSide: 3840, even: true });
  const page = await studioPage(
    { create_image: [still], create_video: [wanStudio()], upscale: [clips, seedvr] },
    { 'tools/actions': () => ({ upscale: ['image', 'video'] }) },
    {
      runs: [
        { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 2688, height: 1536 }] },
        { id: 'c', conversationId: 'c1', mediaType: 'video', workflowId: 'wan', prompt: 'la mer', outputs: [{ originalUrl: '/c.mp4', thumbUrl: '/c.jpg', take: 2, width: 3440, height: 1440 }] },
      ],
    },
  );
  const { body, restore } = page;
  const size = () => body.find('studio-finish-result')[0]?.textContent,
    upscale = () => body.find('studio-rail')[0].find('output-action-upscale')[0].onclick();
  try {
    await settle();
    upscale();
    // × 2: 5376 × 3072, under 8192, as it is; × 4: 10752 × 6144 held to 8192 (8192 × 4681.14…), as SeedVR2 makes it.
    assert.equal(size(), '5376 × 3072');
    body.find('studio-finish-chip')[1].onclick();
    assert.equal(size(), '8192 × 4681');
    // A clip of 3440 × 1440, × 2, held to 3840: 1607.4 brought to an even side, 1608 (1607 said before).
    page.mode(1);
    await settle();
    upscale();
    assert.equal(size(), '3840 × 1608');
  } finally {
    restore();
  }
});

test('(0.6.261) « Animer »: the nearest format the model makes for a picture of none of the list, « DÉBUT » for a file put on the screen too', async () => {
  const be = value => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    },
    chunk = (type, data) => Buffer.concat([be(data.length), Buffer.from(type, 'ascii'), data, be(0)]),
    photo = new File([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.alloc(13)), chunk('IEND', Buffer.alloc(0))])], 'photo.png', { type: 'image/png' });
  const page = await studioPage(
    { create_image: [still], create_video: [wanStudio()] },
    {
      'tools/actions': () => ({ animate: ['image'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs: [{ id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 1280, height: 800 }] }], project: () => 'p1' },
  );
  const { body, asked, restore } = page;
  const chips = () => body.find('studio-format').filter(chip => !chip.className.includes('is-more')),
    animate = () => body.find('studio-rail')[0].find('output-action-animate')[0].onclick(),
    // (The size chosen in the Studio goes with its changes to the plan.)
    sentSize = () => asked.findLast(([route]) => route === 'tools/revise')?.[1].edits ?? {};
  try {
    await settle();
    // Vidéo in 9:16 before.
    page.mode(1);
    chips().find(chip => chip.children[0].textContent === '9:16').onclick();
    page.mode(0);
    // A picture of 1280 × 800 (16:10, none of the list): the nearest format the model makes, 3:2 (9:16 kept before).
    animate();
    assert.equal(body.dataset.mode, 'video');
    page.prompt().value = 'la mer monte';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const sent = sentSize();
    assert.equal(sent.width / sent.height, 3 / 2, JSON.stringify(sent));
    // A file of the computer put on the screen of Image (kept as a reference of the project): « DÉBUT » as for a take.
    page.mode(0);
    body.find('studio-stage')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [photo], types: ['Files'] } });
    for (let tries = 0; tries < 40 && screenOf(body.find('studio-frame-result')[0])?.src !== '/preview/photo.png'; tries++) await settle();
    assert.equal(screenOf(body.find('studio-frame-result')[0])?.src, '/preview/photo.png');
    animate();
    assert.deepEqual(
      [body.dataset.mode, body.find('studio-frame-start')[0]?.src, body.find('studio-frame-label')[0]?.textContent, body.find('studio-rail').length, page.prompt().placeholder],
      ['video', '/preview/photo.png', 'DÉBUT', 0, 'Décrivez le mouvement…'],
    );
    // Its format, 16:9 (the file is of 1280 × 720), greyed and why.
    const checked = chips().find(chip => chip.attributes['aria-checked'] === 'true');
    assert.deepEqual([checked?.children[0].textContent, checked?.disabled, checked?.title], ['16:9', true, 'Le format suit l’image de début.']);
  } finally {
    restore();
  }
});

test('(0.6.261) a take of the Chat made larger keeps the draft of Image as it is; the page Agrandir of a take is left once another take comes on its screen', async () => {
  const seedvr = { id: 'sv', name: 'Upscale SeedVR2', media: 'image', verb: 'upscale', roles: { source: { count: 1, media: ['image'], required: true } }, settings: [], finish: { key: 'scale', choices: [2, 4], standard: 2 } };
  let take = null;
  const page = await studioPage(
    { create_image: [still], upscale: [seedvr] },
    { 'tools/actions': () => ({ upscale: ['image'] }) },
    { runs: [{ id: 'a', conversationId: 'c1', workflowId: 'w', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 1024, height: 1024 }] }], extra: { making: () => take } },
  );
  const { body, studio, restore } = page;
  globalThis.document.body.dataset = { view: 'studio' };
  const source = () => body.find('studio-slot').find(tile => tile.dataset.slot === 'source_image-0' && tile.className.includes('is-filled'));
  try {
    await settle();
    page.prompt().value = 'mon brouillon';
    page.prompt().oninput();
    // Asked in the Chat, followed here: Image, its draft as it was (lot 4 emptied its prompt for the whole take).
    const request = {
      requestId: 'q',
      approvalToken: 't',
      tool: 'upscale',
      mediaType: 'image',
      workflowName: 'Upscale SeedVR2',
      call: { id: 'call', type: 'function', function: { name: 'upscale', arguments: '{}' } },
      plan: { parameters: { scale: 2 }, references: [{ role: 'source_image', output_id: 'a' }], editable: { parameters: [], references: [] } },
    };
    take = chatTakeOf(request, { label: 'Agrandissement…' });
    studio.watch();
    assert.equal(studio.busy(), true);
    assert.deepEqual([body.dataset.mode, page.prompt().value, source()], ['image', 'mon brouillon', undefined]);
    Object.assign(take, { running: false, ended: { type: 'failed', record: null, message: 'rien' } });
    studio.watch();
    assert.equal(studio.busy(), false);
    // The page Agrandir of the take 1 open, a take of the Chat comes on the screen (PRISE 2): the page is left.
    body.find('studio-rail')[0].find('output-action-upscale')[0].onclick();
    assert.equal(body.find('studio-finish').length, 1);
    const made = { id: 'b', conversationId: 'c1', workflowId: 'w', prompt: 'un bateau', outputs: [{ originalUrl: '/b.png', take: 2, width: 1024, height: 1024 }] };
    take = chatTakeOf({ ...request, requestId: 'q2', tool: 'create_image', workflowName: 'Autre' }, { label: 'Génération…' });
    studio.watch();
    page.runs.unshift(made);
    Object.assign(take, { running: false, ended: { type: 'done', record: made, message: '' } });
    studio.watch();
    for (let tries = 0; studio.screenTake()?.take !== 2 && tries < 40; tries++) await settle();
    assert.deepEqual(studio.screenTake(), { take: 2, media: 'image' });
    assert.deepEqual([body.find('studio-finish').length, body.find('studio-go-label')[0].textContent], [0, 'Générer']);
  } finally {
    restore();
  }
});

test('(0.6.261) the case of a clip without its miniature shows the sign of a clip, not a broken image (« À interpoler », « À prolonger »)', async () => {
  const rife = { id: 'rife', name: 'Interpoler (RIFE 4.26)', media: 'video', verb: 'interpolate', roles: { source: { count: 1, media: ['video'], required: true } }, settings: [], finish: { key: 'multiplier', choices: [2, 4], standard: 2 } };
  const page = await studioPage(
    { create_image: [], create_video: [wanStudio()], interpolate: [rife], extend_video: [{ ...wanStudio(), verb: 'extend_video' }] },
    { 'tools/actions': () => ({ interpolate: ['video'], extend_video: ['video'] }) },
    {
      runs: [{ id: 'c', conversationId: 'c1', mediaType: 'video', workflowId: 'wan', prompt: 'la mer', parameters: { fps: 24 }, outputs: [{ take: 4 }] }],
      pageAddress: 'http://127.0.0.1:8787/',
    },
  );
  const { body, restore } = page;
  const shown = piece => body.find(piece)[0].find('studio-slot-pick')[0].children.map(child => child.glyph ?? child.tag);
  try {
    page.mode(1);
    await settle();
    body.find('studio-rail')[0].find('output-action-interpolate')[0].onclick();
    assert.deepEqual(shown('studio-finish'), ['video', 'span']);
    body.find('studio-finish')[0].find('studio-slot-remove')[0].onclick();
    body.find('studio-rail')[0].find('output-action-extend')[0].onclick();
    assert.deepEqual(shown('studio-prolong'), ['video', 'span']);
  } finally {
    restore();
  }
});

test('(0.6.253) « Générer » greyed still answers: pressed or its keys, its reason in its bubble, the prompt lit with the cursor in it, or the case of the image missing; nothing is made', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  // What a press lights: the field of the prompt, the case of the start image; where the cursor goes.
  const lit = [],
    focused = [],
    element = name => ({
      classList: { add: name2 => lit.push([name, name2]), remove() {} },
      focus: () => focused.push(name),
      offsetWidth: 0,
    }),
    field = element('prompt'),
    slot = element('start_image'),
    cursor = element('cursor'),
    querySelector = selector =>
      selector === '#studio-view .studio-prompt-field'
        ? field
        : selector === '#studio-view .studio-slot[data-slot="start_image-0"]'
          ? slot
          : selector === '#studio-prompt'
            ? cursor
            : null;
  const page = await studioPage(
    { create_image: [image], create_video: [wanStudio()] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { querySelector },
  );
  const { body, asked, said, restore } = page;
  const go = () => body.find('studio-go')[0],
    started = () => asked.filter(([route]) => route === 'tools/action').length;
  try {
    // Nothing typed: greyed for the eye and screen readers (aria-disabled), not for the pointer: it still answers.
    assert.deepEqual([go().disabled, go().attributes['aria-disabled'], go().title], [true, 'true', 'Décrivez d’abord votre image.']);
    await go().onclick();
    await settle();
    assert.equal(started(), 0);
    assert.deepEqual([said, lit, focused], [['Décrivez d’abord votre image.'], [['prompt', 'is-called']], ['cursor']]);
    // Vidéo, its own words; a prompt typed, the start image missing: its keys light its case, not the prompt.
    page.mode(1);
    assert.equal(go().title, 'Décrivez d’abord votre vidéo.');
    page.prompt().value = 'Le vieux pêcheur lève les yeux.';
    page.prompt().oninput();
    lit.length = focused.length = 0;
    page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    assert.equal(started(), 0);
    assert.deepEqual([said.at(-1), lit, focused], ['Ajoutez l’image de début.', [['start_image', 'is-called']], []]);
    // A prompt in Image: lit, it generates, nothing said in a bubble.
    page.mode(0);
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    page.studio.render();
    assert.deepEqual([go().disabled, go().attributes?.['aria-disabled']], [false, undefined]);
    const before = said.length;
    await go().onclick();
    await settle();
    assert.deepEqual([started(), said.length], [1, before]);
  } finally {
    restore();
  }
});

test('(0.6.254) « × 3 »: three takes one after the other, the same settings and a new seed for each, « 1 SUR 3 » on « Générer »; one again on another page of the Studio; a failure ends the series', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  let made = 0,
    fails = 0;
  const labels = [];
  const page = await studioPage(
    { create_image: [image], create_video: [wanStudio()] },
    {
      'tools/action': () => ({ requestId: 'q' + (made + 1), plan: { parameters: {} } }),
      'tools/execute': () => {
        // What « Générer » says while this one is made.
        labels.push(page.body.find('studio-go-label')[0]?.textContent);
        if (fails && made + 1 === fails) return { id: 'j', state: 'error', error: 'rien' };
        const record = { id: 'r' + ++made, conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: `/r${made}.png`, take: made }] };
        page.runs.unshift(record);
        return { id: 'j', state: 'done', record };
      },
    },
    { runs: [] },
  );
  const { body, asked, restore } = page;
  const tries = () => body.find('studio-tries')[0],
    menu = () => body.find('studio-tries-menu')[0],
    sent = () => asked.filter(([route]) => route === 'tools/action').map(([, action]) => action.arguments),
    choose = count => {
      tries().onclick();
      menu().children[count - 1].onclick();
    };
  try {
    // Its list: × 1 to × 4, the one chosen checked.
    assert.deepEqual(
      menu().children.map(item => [item.attributes.role, item.attributes['aria-checked'], item.attributes['aria-label'], item.find('studio-tries-count')[0].textContent]),
      [
        ['menuitemradio', 'true', '1 essai', '1'],
        ['menuitemradio', 'false', '2 essais', '2'],
        ['menuitemradio', 'false', '3 essais', '3'],
        ['menuitemradio', 'false', '4 essais', '4'],
      ],
    );
    assert.equal(menu().children[0].children.at(-1).glyph, 'check');
    choose(3);
    assert.deepEqual([tries().attributes['aria-label'], menu().children[2].attributes['aria-checked']], ['Essais : 3', 'true']);
    // A seed named: the first take has it, the two others one each of their own.
    body.find('studio-more-pill')[0].onclick();
    const seed = body.find('studio-seed')[0].children[1];
    seed.value = '42';
    seed.oninput();
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const seeds = sent().map(args => args.seed);
    assert.deepEqual([made, sent().map(args => args.prompt), seeds[0]], [3, ['un phare', 'un phare', 'un phare'], 42]);
    assert.ok(seeds.slice(1).every(value => Number.isSafeInteger(value) && value >= 0 && value !== 42), String(seeds));
    assert.notEqual(seeds[1], seeds[2]);
    assert.deepEqual(labels, ['1 SUR 3', '2 SUR 3', '3 SUR 3']);
    // Three takes in the Sortie; the count stays for the next « Générer ».
    assert.deepEqual([page.runs.map(record => record.id), tries().attributes['aria-label']], [['r3', 'r2', 'r1'], 'Essais : 3']);
    // A failure: the series ends there, its reason said.
    fails = made + 2;
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([made, sent().length, body.find('studio-error')[0]?.textContent], [4, 5, 'rien']);
    // Another page of the Studio, and back: one try again.
    page.mode(1);
    assert.equal(tries().attributes['aria-label'], 'Essais : 1');
    page.mode(0);
    assert.equal(tries().attributes['aria-label'], 'Essais : 1');
    // Chosen again, the same page chosen again: kept (only a visit).
    choose(2);
    page.mode(0);
    assert.equal(tries().attributes['aria-label'], 'Essais : 2');
  } finally {
    restore();
  }
});

test('(0.6.260) a series ends at « Arrêter » pressed once its take is saved, or between two takes; another conversation opened ends it with a word', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  let made = 0,
    shown = 'c1',
    // What the take being asked does: its job as the server answers it, and a hand that presses meanwhile.
    asked = null,
    // Pressed when the Studio reads its takes again (its take saved, or just made and being put on its screen).
    onRead = null;
  const page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q' + (made + 1), plan: { parameters: {} } }),
      'tools/execute': () => {
        const record = { id: 'r' + ++made, conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: `/r${made}.png`, take: made }] };
        page.runs.unshift(record);
        return asked?.(record) ?? { id: 'j', state: 'done', record };
      },
      // Stopped once its take was saved: the server ends it « cancelled », the take kept.
      'tools/job': () => ({ id: 'j', state: 'cancelled', record: page.runs[0] }),
    },
    { runs: [], conversation: () => shown, extra: { onRuns: () => onRead?.() } },
  );
  const { body, notices, restore } = page;
  const tries = () => body.find('studio-tries')[0],
    choose = count => {
      tries().onclick();
      body.find('studio-tries-menu')[0].children[count - 1].onclick();
    },
    halt = () => {
      onRead = null;
      body.find('studio-stop')[0].onclick();
    },
    go = async () => {
      page.prompt().value = 'un phare';
      page.prompt().oninput();
      await body.find('studio-go')[0].onclick();
      // A take followed by the page waits 700 ms between two of its answers.
      await new Promise(resolve => setTimeout(resolve, 1000));
    };
  try {
    // Its take saved, then « Arrêter »: that take kept, no other one.
    choose(3);
    asked = record => ((onRead = halt), { id: 'j', state: 'running', record });
    await go();
    assert.deepEqual([made, page.runs.map(record => record.id), body.find('studio-go-label')[0].textContent], [1, ['r1'], 'Générer']);
    // Between two takes, the first being put on its screen: the second does not go.
    asked = null;
    onRead = halt;
    await go();
    assert.equal(made, 2);
    // Another conversation opened while the first take is made: the series ends there, and says it.
    assert.equal(tries().attributes['aria-label'], 'Essais : 3');
    asked = record => {
      shown = 'c2';
      page.studio.conversationChanged();
      return { id: 'j', state: 'done', record };
    };
    await go();
    assert.deepEqual([made, notices.at(-1)], [3, 'Série arrêtée après la prise 1 sur 3 : une autre conversation a été ouverte.']);
  } finally {
    restore();
  }
});

test('(0.6.260) « × n » is at one and greyed where « Générer » makes one take (the page Agrandir, a proposal of Moodix AI), and back to one whatever changes the page', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    seedvr = { id: 'sv', name: 'Upscale SeedVR2', media: 'image', verb: 'upscale', roles: { source: { count: 1, media: ['image'], required: true } }, settings: [], finish: { key: 'scale', choices: [2, 4], standard: 2 } };
  const clip = { id: 'c', conversationId: 'c1', mediaType: 'video', workflowId: 'wan', prompt: 'la mer', outputs: [{ originalUrl: '/c.mp4', take: 2, width: 832, height: 480 }] };
  const page = await studioPage(
    { create_image: [image], create_video: [wanStudio()], upscale: [seedvr] },
    {
      'tools/actions': () => ({ upscale: ['image'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs: [clip, { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 1024, height: 1024 }] }] },
  );
  const { body, asked, said, restore } = page;
  const tries = () => body.find('studio-tries')[0],
    menu = () => body.find('studio-tries-menu')[0],
    choose = count => {
      tries().onclick();
      menu().children[count - 1].onclick();
    },
    sent = () => asked.filter(([route]) => route === 'tools/action');
  try {
    await settle();
    page.mode(0);
    choose(3);
    // The page Agrandir: at one, greyed, why in its bubble; one enlargement.
    body.find('studio-rail')[0].find('output-action-upscale')[0].onclick();
    const once = 'Agrandir fait une seule prise : la même prise agrandie deux fois donne la même image.';
    assert.deepEqual([tries().attributes['aria-label'], tries().attributes['aria-disabled'], tries().title], ['Essais : 1', 'true', once]);
    tries().onclick();
    await settle();
    assert.deepEqual([menu().hidden, said.at(-1)], [true, once]);
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual(sent().map(([, action]) => action.name), ['upscale']);
    // « Afficher dans le Studio » of a clip: another page, one try again.
    body.find('studio-finish')[0].find('studio-slot-remove')[0].onclick();
    choose(3);
    page.studio.show(clip);
    assert.equal(tries().attributes['aria-label'], 'Essais : 1');
  } finally {
    restore();
  }
  // Under a proposal of Moodix AI: at one, greyed; made, still one.
  const { clip: model, request } = proposalOf();
  const proposed = await studioPage({ create_video: [model] }, {});
  try {
    proposed.mode(1);
    proposed.body.find('studio-tries')[0].onclick();
    proposed.body.find('studio-tries-menu')[0].children[2].onclick();
    const answer = proposed.studio.propose(request, new AbortController().signal);
    await settle();
    const pick = proposed.body.find('studio-tries')[0];
    assert.deepEqual([pick.attributes['aria-label'], pick.attributes['aria-disabled'], pick.title], ['Essais : 1', 'true', 'Une proposition de Moodix AI se génère une fois.']);
    proposed.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    proposed.restore();
  }
});

test('(0.6.260) the list of the tries is closed once a creation goes (Ctrl+Entrée while it was open: it opened again at its end)', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  const page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        const record = { id: 'r1', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/r1.png', take: 1 }] };
        page.runs.unshift(record);
        return { id: 'j', state: 'done', record };
      },
    },
    { runs: [] },
  );
  const { body, restore } = page;
  try {
    body.find('studio-tries')[0].onclick();
    assert.equal(body.find('studio-tries-menu')[0].hidden, false);
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual([body.find('studio-tries-menu')[0].hidden, body.find('studio-tries')[0].attributes['aria-expanded']], [true, 'false']);
  } finally {
    restore();
  }
});

test('(0.6.260) « Libérer le GPU » is in the glass of « Générer », as before 0.6.253', async () => {
  const page = await studioPage({ create_video: [wanStudio()] }, {}, { extra: { gpuBlocked: () => true } });
  try {
    page.mode(1);
    const group = page.body.find('studio-go-group')[0],
      [glass] = group.children;
    assert.deepEqual([group.children.length, glass.className, glass.children.map(child => child.className)], [1, 'studio-go-glass', ['studio-go studio-recover']]);
  } finally {
    page.restore();
  }
});

test('(0.6.253) while the chat answers, « Générer » waits greyed with its reason, and comes back at its end; Moodix AI stays at hand', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  const reason = 'Attendez la fin de la réponse en cours.';
  let busy = reason,
    opened = 0;
  const page = await studioPage(
    { create_image: [image] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { openAgent: () => opened++, extra: { blocked: () => busy } },
  );
  const { body, asked, said, notices, restore } = page;
  const go = () => body.find('studio-go')[0],
    started = () => asked.filter(([route]) => route === 'tools/action').length;
  try {
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    page.studio.render();
    assert.deepEqual([go().disabled, go().title], [true, reason]);
    await go().onclick();
    await settle();
    assert.deepEqual([started(), said.at(-1), notices], [0, reason, []]);
    body.find('studio-agent')[0].onclick();
    assert.equal(opened, 1);
    // The answer ended: told by the page (busyChanged), the Studio is drawn again, « Générer » lit.
    busy = '';
    page.studio.busyChanged();
    assert.equal(go().disabled, false);
    assert.match(go().title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
    await go().onclick();
    await settle();
    assert.equal(started(), 1);
    // The chat answers again (a message sent from the Chat, the Studio drawn): greyed again, at once.
    busy = reason;
    page.studio.busyChanged();
    assert.deepEqual([go().disabled, go().title], [true, reason]);
  } finally {
    restore();
  }
});

test('« Enrichir le prompt » names the family of the model in hand: Qwen-Image-Edit is asked an instruction (0.6.282)', async () => {
  const edit = {
    id: 'q',
    name: 'Qwen-Image-Edit',
    family: 'qwen_image_edit',
    roles: { source: { count: 1, media: ['image'], required: true } },
    limits: sizes,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  const studio = await studioPage(
    { create_image: [edit] },
    { 'studio/enrich': () => ({ prompt: 'Make the car of Picture 1 red; the rest stays as it is.' }) },
  );
  const { body, asked, restore } = studio;
  try {
    studio.prompt().value = 'la voiture en rouge';
    studio.prompt().oninput();
    await body.find('studio-enrich-go')[0].onclick();
    assert.deepEqual(asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'la voiture en rouge',
      verb: 'create_image',
      family: 'qwen_image_edit',
    });
    assert.equal(studio.prompt().value, 'Make the car of Picture 1 red; the rest stays as it is.');
  } finally {
    restore();
  }
});

test('« Enrichir le prompt » rewrites what is typed, which can be taken back; three LoRAs at most', async () => {
  const image = {
    id: 'w',
    name: 'Image',
    styled: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  };
  // The chat model answers when the test says (answer): meanwhile, the wand says it is at work.
  let answer = null;
  const studio = await studioPage(
    { create_image: [image] },
    {
      'studio/enrich': ({ prompt }) =>
        new Promise(resolve => (answer = () => resolve({ prompt: 'A lighthouse at dusk. (' + prompt + ')' }))),
    },
  );
  const { body, asked, restore } = studio;
  try {
    const wand = () => body.find('studio-enrich-go')[0];
    // « Enrichir », the word of the Bobine too (21/11): its name for screen readers, in it and on it.
    assert.deepEqual(
      [wand().children.at(-1).textContent, wand().attributes['aria-label']],
      ['Enrichir le prompt', 'Enrichir le prompt'],
    );
    // Fewer than three letters: the wand waits, and says why.
    assert.equal(wand().disabled, true);
    assert.equal(wand().title, 'Écrivez d’abord quelques mots');

    // Nothing typed: nothing is asked of the model.
    await wand().onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/enrich').length, 0);
    assert.match(body.find('studio-error')[0].textContent, /quelques mots/);
    studio.prompt().value = 'un';
    studio.prompt().oninput();
    await wand().onclick();
    assert.equal(asked.filter(([route]) => route === 'studio/enrich').length, 0);

    studio.prompt().value = 'un phare';
    studio.prompt().oninput();
    // Ready: it says what it does, and its keys.
    studio.studio.render();
    assert.match(wand().title, /^Enrichir le prompt avec Moodix AI \((Ctrl|⌘)\+E\)$/);
    const asking = body.find('studio-enrich-go')[0].onclick();
    await settle();
    // At work: greyed, its name and its tooltip say what Moodix AI is doing.
    assert.deepEqual(
      [wand().children.at(-1).textContent, wand().attributes['aria-label'], wand().title, wand().disabled],
      ['Enrichissement du prompt…', 'Enrichissement du prompt…', 'Moodix AI enrichit votre texte…', true],
    );
    answer();
    await asking;
    assert.deepEqual(asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'un phare',
      verb: 'create_image',
    });
    assert.equal(studio.prompt().value, 'A lighthouse at dusk. (un phare)');
    // What was typed is one click away.
    const back = body.find('studio-enrich')[0].children.find(child => child.className === 'studio-link');
    back.onclick();
    assert.equal(studio.prompt().value, 'un phare');
    assert.equal(body.find('studio-enrich')[0].children.length, 1);

    // The seed is rare: under « ··· », a pill named for screen readers, closed at first.
    const [more] = body.find('studio-more-pill');
    assert.equal(more.attributes['aria-label'], 'Plus de réglages');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    more.onclick();
    assert.equal(body.find('studio-rare')[0].hidden, false);
    assert.equal(body.find('studio-seed').length, 1);
    // (0.6.206, captures 110 and 111) Its lines in a window of glass named as its pill, not in a block of the
    // column: the column of the Réglages no longer grows with them.
    const [pane] = body.find('studio-more-window');
    assert.deepEqual(
      [pane.className, pane.attributes.role, pane.attributes['aria-label'], pane.hidden, pane.children.map(part => part.className)],
      ['glass-menu studio-more-window', 'dialog', 'Plus de réglages', false, ['studio-window-title', 'studio-rare']],
    );
    assert.equal(pane.children[0].textContent, 'Plus de réglages');
    assert.deepEqual(body.find('studio-set-block').filter(block => /studio-rare/.test(block.className)), []);
    assert.deepEqual(
      [body.find('studio-more-pill')[0].attributes['aria-haspopup'], body.find('studio-more-pill')[0].attributes['aria-expanded'], body.find('studio-more-pill')[0].className],
      ['dialog', 'true', 'studio-more-pill is-open'],
    );
    // The LoRAs in their own block: « LoRA · n / 3 », a line each, and no fourth.
    for (let added = 0; added < 3; added++) body.find('studio-lora-plus')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 3);
    assert.equal(body.find('studio-lora-count')[0].textContent, '· 3 / 3');
    assert.deepEqual(body.find('studio-lora-plus'), []);
    body.find('studio-lora-drop')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 2);
    assert.equal(body.find('studio-lora-plus').length, 1);
  } finally {
    restore();
  }
});

test('the wand says « Enrichir » everywhere (21/11): its old words are nowhere in the application', async () => {
  // (0.6.198) Nor on the page Modèles, where the text encoder of the model rewrites the prompt: « Enrichir le
  // prompt avant chaque image », its « Consigne d’enrichissement »; « Prompt enrichi » on the page of a take
  // and for its setting (« Prompt amélioré », « Prompt enhance », « Expansion du prompt » before).
  const { readFile, readdir } = await import('node:fs/promises'),
    root = new URL('../', import.meta.url),
    files = ['server.mjs', 'README.md'],
    old = /Améliorer le prompt|[Aa]mélioration du prompt|[Cc]onsigne d’amélioration|Prompt amélioré|Prompt enhance|Expansion du prompt|« Améliorer »|réécrit votre texte/;
  for (const folder of ['public/', 'lib/', 'scripts/'])
    for (const name of await readdir(new URL(folder, root)))
      if (/\.(m?js|css|html)$/.test(name)) files.push(folder + name);
  assert.ok(files.length > 100, 'the files of the application are read');
  const saying = [];
  for (const name of files) if (old.test(await readFile(new URL(name, root), 'utf8'))) saying.push(name);
  assert.deepEqual(saying, []);
});

test('(0.6.199) what a generation is doing never says « images de référence »: the page names a start, an end, a subject', async () => {
  // (« Préparation des images de référence… » for the start image of Wan 2.2 as for the subjects of MiniMax H3.)
  const { readFile, readdir } = await import('node:fs/promises'),
    root = new URL('../lib/', import.meta.url),
    saying = [];
  for (const name of await readdir(root)) if (/\.mjs$/.test(name) && /images? de référence/.test(await readFile(new URL(name, root), 'utf8'))) saying.push(name);
  assert.deepEqual(saying, []);
  assert.match(await readFile(new URL('tool-runtime.mjs', root), 'utf8'), /'encoding references': 'Préparation des images…',[\s\S]*'subjects found': 'Préparation des images…',/);
});

test('Ctrl+E improves the prompt from the Studio; an image pasted or dropped on its column goes to the first free slot', async () => {
  const video = {
    id: 'v',
    name: 'Clip',
    styled: true,
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    exclusive: [['start_image', 'end_image'], ['reference']],
    roles: {
      start_image: { count: 1, media: ['image'] },
      end_image: { count: 1, media: ['image'] },
      reference: { count: 2, media: ['image'] },
    },
  };
  const studio = await studioPage(
    { create_video: [video], create_audio: [{ id: 's', name: 'Son', roles: {}, settings: [] }] },
    { 'studio/enrich': ({ prompt }) => ({ prompt: 'Better: ' + prompt }) },
  );
  const { page, body, asked, notices, restore, mode } = studio;
  try {
    mode(1);
    const improved = () => asked.filter(([route]) => route === 'studio/enrich').length,
      key = (overrides = {}) => ({ key: 'e', ctrlKey: true, preventDefault() {}, ...overrides });
    studio.prompt().value = 'un bateau';
    studio.prompt().oninput();
    // In the message box of the chat, Ctrl+E is not the Studio's.
    page['studio-view'].onkeydown(key({ target: { id: 'prompt' } }));
    await settle();
    assert.equal(improved(), 0);
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(improved(), 1);
    assert.equal(studio.prompt().value, 'Better: un bateau');

    // Pasted, then dropped on the column: the first free slots, in their order.
    const write = body.find('studio-write')[0],
      file = name => ({ name, type: 'image/png' }),
      shown = () =>
        body
          .find('studio-slot')
          .map(tile => (tile.className.includes('is-filled') ? tile.children[0].children[0].src : ''));
    let stopped = 0;
    write.onpaste({ clipboardData: { files: [file('a.png')] }, preventDefault: () => stopped++ });
    await settle();
    assert.equal(stopped, 1, 'the image is not pasted as text');
    assert.deepEqual(shown(), ['/preview/a.png', '', '']);
    body.find('studio-write')[0].ondrop({ dataTransfer: { files: [file('b.png')] }, preventDefault() {} });
    await settle();
    // The references do not combine with a start image: the end takes it.
    assert.deepEqual(shown(), ['/preview/a.png', '/preview/b.png', '']);
    body.find('studio-write')[0].onpaste({ clipboardData: { files: [file('c.png')] }, preventDefault() {} });
    await settle();
    assert.equal(notices.at(-1), 'Toutes les cases d’images sont prises.');
    // Text pasted stays text.
    stopped = 0;
    body.find('studio-write')[0].onpaste({ clipboardData: { files: [] }, preventDefault: () => stopped++ });
    assert.equal(stopped, 0);

    // A sound: no wand, and Ctrl+E does nothing.
    mode(2);
    studio.prompt().value = 'pluie';
    studio.prompt().oninput();
    assert.deepEqual(body.find('studio-enrich-go'), []);
    page['studio-view'].onkeydown(key());
    await settle();
    assert.equal(improved(), 1);
  } finally {
    restore();
  }
});

test('the LoRAs of a model do not follow to a model of another family, and come back with theirs', async () => {
  const image = (id, name, family) => ({
    id,
    name,
    family,
    styled: true,
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
    seeded: true,
  });
  const studio = await studioPage(
    {
      create_image: [
        image('k', 'Krea 2', 'krea2'),
        image('k2', 'Krea 2 rétro', 'krea2'),
        image('m', 'MOSS Image', 'moss'),
      ],
    },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
  );
  const { body, asked, restore } = studio;
  try {
    const model = to => {
        const control = body.find('studio-model-pick')[0];
        control.value = to;
        control.onchange();
      },
      generate = async () => {
        studio.prompt().value = 'une affiche';
        studio.prompt().oninput();
        await body.find('studio-go')[0].onclick();
        await settle();
        return asked.filter(([route]) => route === 'tools/action').at(-1)[1];
      };
    body.find('studio-lora-plus')[0].onclick();
    body.find('studio-lora-plus')[0].onclick();
    assert.equal(body.find('studio-lora-row').length, 2);

    // Another workflow of the same family keeps them.
    model('k2');
    assert.equal(body.find('studio-lora-row').length, 2);

    // MOSS Image: none of Krea 2's LoRAs is shown, and none is sent.
    model('m');
    assert.equal(body.find('studio-lora-row').length, 0);
    assert.equal(body.find('studio-lora-count')[0].textContent, '· 0 / 3');
    const sent = await generate();
    assert.equal(sent.arguments.workflow ?? 'm', 'm');
    assert.equal(sent.styles, undefined);

    // One of its own, then back to Krea 2: each family finds its own again.
    body.find('studio-lora-plus')[0].onclick();
    model('k');
    assert.equal(body.find('studio-lora-row').length, 2);
    assert.equal((await generate()).styles.length, 2);
    model('m');
    assert.equal(body.find('studio-lora-row').length, 1);
  } finally {
    restore();
  }
});

/** A video workflow with three lengths and a proposal of Moodix AI for it. */
function proposalOf({ prompt = 'Un renard se lève', frames = 121 } = {}) {
  const clip = {
    id: 'v',
    name: 'Clip',
    roles: { start_image: { count: 1, media: ['image'] } },
    limits: sizes,
    size: { width: 768, height: 448 },
    final: { width: 1344, height: 768 },
    stages: true,
    seeded: true,
    lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
    settings: [],
  };
  const request = {
    requestId: 'q',
    approvalToken: 't',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'Clip',
    resolution: { width: 768, height: 448 },
    call: { id: 'call', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt,
      stage: 'draft',
      parameters: { prompt, width: 768, height: 448, frames, fps: 24, seed: 7 },
      editable: {
        prompt: true,
        stages: ['draft', 'final'],
        parameters: [
          { key: 'frames', type: 'integer', value: frames, choices: [121, 193, 241] },
          { key: 'width', type: 'integer', value: 768 },
          { key: 'height', type: 'integer', value: 448 },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [],
      },
      references: [],
    },
  };
  return { clip, request };
}

/** A suite of tool calls recorded (tests/fixtures), replayed without a language model. */
async function recordedProposal() {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(new URL('./fixtures/moodix-ai-studio.json', import.meta.url), 'utf8'));
}
/** The Studio of the replay: LTX 2.5 after MiniMax H3 Omni, and the take 1 of the project. */
function replayStudio() {
  const ltx = {
      id: 'ltx',
      name: 'LTX 2.5',
      roles: {
        start_image: { count: 1, media: ['image'] },
        end_image: { count: 1, media: ['image'] },
        reference: { count: 2, media: ['image'] },
      },
      limits: sizes,
      size: { width: 768, height: 448 },
      stages: true,
      seeded: true,
      lengths: { seconds: [121 / 24, 145 / 24, 193 / 24], standard: 121 / 24 },
      settings: [],
    },
    minimax = { ...ltx, id: 'h3', name: 'MiniMax H3 Omni' },
    portrait = {
      id: 'd91877b3-e6e4-4cf8-ae95-49665e6aa1ae',
      prompt: 'Un portrait',
      outputs: [{ take: 1, thumbUrl: '/portrait.webp', originalUrl: '/portrait.png', width: 1024, height: 1024 }],
    };
  return { tools: { create_video: [minimax, ltx] }, runs: [portrait] };
}
const until = async (check, tries = 400) => {
  for (let at = 0; at < tries && !check(); at++) await new Promise(resolve => setTimeout(resolve, 2));
};

test('a recorded proposal replayed: the pointer does what Moodix AI proposes, in turn, and waits on « Générer »', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  const studio = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, asked, restore } = studio;
  try {
    const answer = studio.studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    // Each setting it changes, said as it is done (studio-maquette.md): the mode, the model, the
    // prompt written, the take carried to its case (16/11: no « Créations du projet » any more), the
    // format, the length; then « Générer ».
    assert.deepEqual(said, [
      'passe en Vidéo',
      'choisit LTX 2.5',
      'écrit le prompt',
      'pose la prise 1 en début',
      'passe en 9:16',
      'règle la durée',
      'attend votre accord',
    ]);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(studio.prompt().value, recorded.request.plan.prompt);
    assert.equal(body.find('studio-slot')[0].children[0].children[0].src, '/portrait.webp');
    const duration = body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration.attributes['aria-valuetext'], '06.04 S');
    // It stays there, « Refuser » beside it; nothing starts by itself.
    assert.equal(studio.page['ai-cursor'].classList.contains('is-visible'), true);
    assert.equal(body.find('studio-decline').length, 1);
    assert.equal(body.find('studio-shelf').length, 0);
    assert.equal(asked.filter(([route]) => route.startsWith('tools/')).length, 0);
    studio.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a model that cannot do without a subject asks for « un sujet »; Moodix AI lays a take there « comme sujet » (0.6.190)', async () => {
  // (0.6.190) The case that receives a character, an object or a place is a « Sujet », no longer a « Référence »
  // (#ref and « Références du projet » are files, and keep their name).
  const omni = {
    id: 'omni',
    name: 'MiniMax H3 Omni',
    verb: 'create_video',
    limits: sizes,
    size: { width: 768, height: 448 },
    settings: [],
    seeded: true,
    roles: { reference: { count: 3, media: ['image'], many: true, required: true } },
  };
  const page = await studioPage({ create_video: [omni] }, {}, { querySelector: laidOutGo });
  try {
    page.mode(1);
    page.prompt().value = 'Le vieux pêcheur lève les yeux vers le large.';
    page.prompt().oninput();
    const [go] = page.body.find('studio-go');
    assert.deepEqual([go.disabled, go.title], [true, 'Ajoutez un sujet.']);
  } finally {
    page.restore();
  }
  // A take Moodix AI lays in that case: its pointer says where, in the same word.
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  Object.assign(recorded.request.plan.references[0], { input: 'subject-1', role: 'msr_image', roleLabel: 'Sujet' });
  const replay = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  try {
    const answer = replay.studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.ok(said.includes('pose la prise 1 comme sujet'), said.join(' | '));
    assert.equal(replay.body.find('studio-references')[0].find('studio-slot')[0].children[0].children[0].src, '/portrait.webp');
    replay.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    replay.restore();
  }
});

test('while Moodix AI sets the Studio nothing in it answers the user and nothing stops it; on « Générer » all is theirs again', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [],
    locked = [];
  let view = null;
  // At each word of the pointer, whether the Studio was locked then (inert: the page gives it no
  // click, no key, no drop).
  Object.defineProperty(said, 'push', {
    value(label) {
      locked.push(view?.inert === true);
      return Array.prototype.push.call(this, label);
    },
  });
  const studio = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, page, restore } = studio;
  view = page['studio-view'];
  const duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
  try {
    const answer = studio.studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('écrit le prompt'));
    assert.equal(view.inert, true);
    // A touch that would reach it anyway changes nothing: the pointer goes on, to the end, and the
    // values are those of Moodix AI.
    const onDuration = { closest: () => ({ dataset: { ai: 'duration' } }) };
    view.listeners.pointerdown({ isTrusted: true, target: onDuration });
    view.listeners.input({ isTrusted: true, type: 'input', target: onDuration });
    await until(() => said.includes('attend votre accord') && view.inert === false);
    assert.deepEqual(said, [
      'passe en Vidéo',
      'choisit LTX 2.5',
      'écrit le prompt',
      'pose la prise 1 en début',
      'passe en 9:16',
      'règle la durée',
      'attend votre accord',
    ]);
    assert.equal(locked.length, said.length);
    assert.ok(locked.every(Boolean), 'locked from its first step to « Générer »');
    assert.equal(page['ai-cursor'].classList.contains('is-visible'), true);
    assert.equal(studio.prompt().value, recorded.request.plan.prompt);
    assert.equal(duration().attributes['aria-valuetext'], '06.04 S');
    // Resting on « Générer »: nothing is locked any more, the settings answer.
    assert.equal(view.inert, false);
    duration().value = '2';
    duration().oninput();
    assert.equal(duration().attributes['aria-valuetext'], '08.04 S');
    studio.studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(view.inert, false);
  } finally {
    restore();
  }
});

test('the Studio held by a proposal of another conversation answers none of its keys there (0.6.87)', async () => {
  // « Studio occupé » shown in the place of everything: Ctrl + Entrée still answered the proposal
  // waiting in the other conversation, a video started without being on screen.
  const { clip, request } = proposalOf();
  let shown = 'c1';
  const studio = await studioPage({ create_video: [clip] }, {}, { conversation: () => shown });
  const { body, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(studio.studio.proposing(), true);
    shown = 'c2';
    studio.studio.conversationChanged();
    assert.equal(body.find('studio-away').length, 1);
    let answered = false;
    void answer.then(() => (answered = true));
    studio.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    assert.equal(answered, false);
    assert.equal(studio.studio.proposing(), true);
    // Back in its conversation: its keys answer it.
    shown = 'c1';
    studio.studio.conversationChanged();
    studio.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    assert.equal(await answer, 'once');
  } finally {
    restore();
  }
});

test('a take just made stays its conversation’s until it is on its screen: the status read meanwhile does not move it (0.6.87)', async () => {
  // Its takes read again while the page read its status (every 1.2 s, letGo): the Studio went to the
  // conversation shown, and the take of the other came on its screen.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  let shown = 'c1';
  const studio = await studioPage({ create_image: [image] }, {}, { conversation: () => shown });
  const { restore } = studio;
  try {
    // Followed again after a reload, held by its conversation; another one shown meanwhile.
    studio.studio.followAgain();
    shown = 'c2';
    studio.studio.conversationChanged();
    assert.equal(studio.studio.heldFor(), 'c1');
    const record = {
      id: 'r1',
      conversationId: 'c1',
      mediaType: 'image',
      workflowId: 'w',
      workflowName: 'Image',
      prompt: 'un phare',
      parameters: {},
      outputs: [{ originalUrl: '/r1.png', thumbUrl: '/r1.jpg', take: 9 }],
    };
    const done = studio.studio.settled({ record });
    studio.studio.letGo();
    assert.equal(studio.studio.heldFor(), 'c1', 'still its own while its take comes to its screen');
    await done;
    await settle();
    assert.equal(studio.studio.heldFor(), null, 'then the one shown');
    assert.equal(studio.studio.screenTake(), null, 'without the take of the other');
  } finally {
    restore();
  }
});

test('Moodix AI sets its proposal in the Studio and waits: « Générer » is the answer, with the user’s changes', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage(
    { create_video: [clip] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, revealed, restore } = studio;
  try {
    assert.equal(studio.studio.accepts('create_video'), true);
    assert.equal(studio.studio.accepts('upscale'), false);
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // The Studio came on screen, in Vidéo, with what the pointer set.
    assert.equal(revealed.length, 1);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(studio.prompt().value, 'Un renard se lève');
    // The lengths of the model on a bar, step by step: the one proposed, written as it is made.
    const duration = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'duration');
    assert.equal(duration().value, '0');
    assert.equal(duration().attributes['aria-valuetext'], '05.04 S');
    assert.equal(studio.studio.proposing(), true);
    // Nothing starts by itself: the pointer stops on « Générer », beside a way to decline.
    assert.equal(asked.filter(([route]) => route.startsWith('tools/')).length, 0);
    assert.equal(body.find('studio-decline').length, 1);
    // The user lengthens it, then generates: the change goes first, then the answer.
    const length = duration();
    length.value = '1';
    length.oninput();
    assert.equal(length.attributes['aria-valuetext'], '08.04 S');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1], {
      requestId: 'q',
      approvalToken: 't',
      edits: { frames: 193 },
    });
    // The proposal now is the revised one, and the generation is followed by the chat turn.
    assert.equal(request.requestId, 'q2');
    assert.equal(studio.studio.proposing(), false);
    assert.equal(studio.studio.busy(), true);
    studio.studio.follow('Génération…', 0.42);
    assert.equal(body.find('studio-progress')[0].hidden, false);
    await studio.studio.settled({ record: null, error: 'Mémoire insuffisante.' });
    assert.equal(studio.studio.busy(), false);
    assert.match(body.find('studio-error')[0].textContent, /Mémoire insuffisante/);
    // The seed drawn for the proposal was its own: a creation by hand draws again.
    assert.equal(body.find('studio-seed')[0].children[1].value, '');
  } finally {
    restore();
  }
});

test('while a take is made the Studio says beside its step how long since its go, as the server counts it (0.6.93)', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const studio = await studioPage({ create_image: [image] });
  const { body, restore } = studio;
  try {
    // A creation the server makes for a page reloaded since: its time is the server's, from the go.
    studio.studio.followAgain();
    const time = () => body.find('studio-elapsed')[0];
    assert.equal(time().textContent, '');
    assert.equal(time().attributes?.['aria-hidden'], 'true', 'not read aloud every second with the step');
    studio.studio.follow('Génération · 5/8', 0.42, null, { ms: 72000, running: true });
    assert.equal(time().textContent, '1 min 12 s');
    // Its file written: its time, which no longer moves.
    studio.studio.follow('Libération du moteur de génération…', 0.95, null, { ms: 73400, running: false });
    assert.equal(time().textContent, '1 min 13 s');
    await studio.studio.settled({ record: null, error: 'Mémoire insuffisante.' });
    assert.equal(body.find('studio-elapsed').length, 0, 'nothing in the making, no time');
    // The next one counts from its own go, not from the last one's.
    studio.studio.followAgain();
    studio.studio.follow('Génération · 1/8', 0.1, null, { ms: 3000, running: true });
    assert.equal(time().textContent, '3 s');
    await studio.studio.settled({ record: null, error: 'Arrêtée.' });
  } finally {
    restore();
  }
});

test('(0.6.200) while a take is made the bubble of « Générer » says its step and its time, the words of the line of the step', async () => {
  // (Check of 21/11, overload, problem 3: it said « Générer (Ctrl+Entrée) » under « EN COURS · 40 % ».) Said in
  // place as the step goes on, the button not drawn again; drawn again, the same words.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    // (« Générer » as it is laid out, its bar too: progress() writes in it.)
    laidOut = selector => {
      const go = laidOutGo(selector);
      if (go) go.style.setProperty ??= () => {};
      return go;
    };
  const page = await studioPage({ create_image: [image] }, {}, { querySelector: laidOut });
  const { body, studio, restore } = page;
  try {
    const go = () => body.find('studio-go')[0],
      step = () => body.find('studio-progress')[0].textContent;
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    // Followed again after a reload: its step, its time not known yet.
    studio.followAgain();
    assert.deepEqual([step(), go().title], ['Génération en cours…', 'Génération en cours…']);
    const drawn = go();
    studio.follow('Génération · 5/8', 0.42, null, { ms: 72000, running: true });
    assert.deepEqual([go() === drawn, go().title], [true, 'Génération · 5/8 · 1 min 12 s']);
    // Drawn again: the words of its line, « Génération · 5/8 » and « 1 min 12 s ».
    studio.render();
    assert.deepEqual([step(), body.find('studio-elapsed')[0].textContent, go().title], ['Génération · 5/8', '1 min 12 s', 'Génération · 5/8 · 1 min 12 s']);
    // A second later, by the count alone (no word from the server meanwhile): in its bubble too.
    const again = go();
    for (let at = 0; at < 150 && body.find('studio-elapsed')[0].textContent === '1 min 12 s'; at++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([go() === again, body.find('studio-elapsed')[0].textContent, go().title], [true, '1 min 13 s', 'Génération · 5/8 · 1 min 13 s']);
    // Its file written: its time, which no longer moves.
    studio.follow('Libération du moteur de génération…', 0.95, null, { ms: 73400, running: false });
    assert.equal(go().title, 'Libération du moteur de génération… · 1 min 13 s');
    // Over: « Générer » again, with its keys.
    await studio.settled({ record: null, error: 'Arrêtée.' });
    assert.match(go().title, /^Générer \((Ctrl|⌘)\+Entrée\)$/);
  } finally {
    restore();
  }
});

test('(0.6.200) no word under 12 px where the check of 21/11 found one; « Supprimer ? » within a small take of the Sortie', async () => {
  // (Check of 21/11, overload, point G: the « ? » of the Paramètres at 11 px, the count of « Prises » at 11.5 px; the
  // question on a take of 120 px wrapped, went over the number under the picture, and out of the take.)
  const css = (await (await import('node:fs/promises')).readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    rule = selector => {
      const at = css.lastIndexOf(selector + ' {');
      assert.notEqual(at, -1, selector);
      return css.slice(at, css.indexOf('}', at));
    };
  assert.match(rule('#settings .settings-block > .help-tip'), /font: 400 12px\/18px var\(--font-ui\);/);
  assert.match(rule('.montage-count'), /font: 400 12px\/1 var\(--font-ui\);/);
  // On the picture only, the number under it left to be read; narrower than its words, « Supprimer ? » alone.
  assert.match(rule('#studio-view .studio-item-confirm'), /bottom: auto;\n  height: var\(--strip-h\);\n  container-type: inline-size;/);
  assert.match(rule('#studio-view .studio-confirm-brief'), /display: none;/);
  assert.match(css, /@container \(max-width: 179px\) \{\n  #studio-view \.studio-item-confirm \.studio-confirm-text \{\n    display: none;\n  \}\n  #studio-view \.studio-item-confirm \.studio-confirm-brief \{\n    display: block;\n  \}\n\}/);
  // The Pellicule asks on a card wide enough for its words: no short form there.
  const { deleteQuestion } = await import('../public/take-delete.mjs'),
    made = [],
    node = (tag, className = '', text = '') => {
      const element = {
        tag,
        className,
        textContent: text,
        children: [],
        attributes: {},
        append(...items) {
          this.children.push(...items);
        },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
        },
      };
      made.push(element);
      return element;
    },
    asked = { node, icon: () => null, record: { outputs: [{ take: 12 }] }, media: 'image', onKeep() {}, onDelete() {} };
  deleteQuestion(asked);
  assert.deepEqual(made.filter(element => element.className === 'studio-confirm-brief'), []);
  deleteQuestion({ ...asked, short: true });
  assert.deepEqual(made.filter(element => element.className === 'studio-confirm-brief').map(element => element.textContent), ['Supprimer\u00a0?']);
});

test('a proposal left as it is goes as it is; declined, it is answered « deny »', async () => {
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_video: [clip] });
  const { body, asked, restore } = studio;
  try {
    let answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(asked.filter(([route]) => route === 'tools/revise').length, 0, 'nothing changed: nothing revised');
    await studio.studio.settled({ record: null });

    const second = proposalOf({ prompt: 'Un phare la nuit' });
    answer = studio.studio.propose(second.request, new AbortController().signal);
    await settle();
    assert.equal(studio.prompt().value, 'Un phare la nuit');
    body.find('studio-decline')[0].onclick();
    assert.equal(await answer, 'deny');
    assert.equal(studio.studio.proposing(), false);
    assert.deepEqual(body.find('studio-decline'), []);

    // A new message in the chat declines it too; a stopped turn takes it away.
    const third = proposalOf();
    answer = studio.studio.propose(third.request, new AbortController().signal);
    await settle();
    assert.equal(studio.studio.decline(), true);
    assert.equal(await answer, 'deny');
    const stopped = new AbortController();
    answer = studio.studio.propose(proposalOf().request, stopped.signal);
    await settle();
    stopped.abort();
    await assert.rejects(answer);
    assert.equal(studio.studio.proposing(), false);
  } finally {
    restore();
  }
});

test('the pointer only sets what the workflow leaves to the assistant', async () => {
  const { clip, request } = proposalOf({ frames: 193 });
  // « Fixe » in the workflow: the length is not the assistant's.
  request.plan.editable.parameters = request.plan.editable.parameters.filter(item => item.key !== 'frames');
  clip.lengths = null;
  const studio = await studioPage({ create_video: [clip] });
  const { body, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    // No length to set: none is shown, none is sent.
    assert.deepEqual(
      body.find('studio-bar').filter(bar => bar.dataset.ai === 'duration'),
      [],
    );
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
  } finally {
    restore();
  }
});

test('the Studio reads its tools once at a time, and its creations only when something changed', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const { clip, request } = proposalOf();
  const studio = await studioPage({ create_image: [image], create_video: [clip] }, {}, { open: false });
  const { asked, restore } = studio;
  const tools = () => asked.filter(([route]) => route === 'studio').length,
    galleries = () =>
      asked.filter(([route]) => /^(project-)?gallery\//.test(route)).map(([route]) => route);
  try {
    // A proposal arrives as the Studio opens: one reading of the tools for both.
    const opening = studio.studio.open(),
      answer = studio.studio.propose(request, new AbortController().signal);
    await opening;
    await settle();
    assert.equal(tools(), 1);
    studio.studio.decline();
    await answer;
    // Its creations, without the copies kept for the model.
    assert.ok(galleries().length >= 1);
    assert.ok(galleries().every(route => /\?images=0(&|$)/.test(route)));
    // Going to the chat and back reads nothing again.
    const read = galleries().length;
    await studio.studio.open();
    await studio.studio.open();
    assert.equal(galleries().length, read);
    assert.equal(tools(), 1);
    // Something made from the chat: its creations are read again at the next opening.
    studio.studio.invalidate();
    await studio.studio.open();
    assert.equal(galleries().length, read + 1);
    // The settings closed: the tools too, in the background.
    studio.studio.invalidate({ tools: true });
    await studio.studio.open();
    await settle();
    assert.equal(tools(), 2);
  } finally {
    restore();
  }
});

test('drawn again, the Studio keeps the pictures of its Sortie and what its screen shows', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const made = {
    id: 'r1',
    mediaType: 'image',
    prompt: 'un phare',
    outputs: [{ originalUrl: '/phare', thumbUrl: '/phare.jpg' }],
  };
  const { studio, body, restore } = await studioPage({ create_image: [image] }, {}, { runs: [made] });
  try {
    const picture = () => body.find('studio-item-pick')[0].children[0];
    const first = picture();
    assert.equal(first.src, '/phare.jpg');
    studio.render();
    assert.equal(picture(), first, 'the same picture: nothing loaded again');
    studio.show(made);
    const [shown] = body.find('studio-frame-result');
    studio.render();
    assert.equal(body.find('studio-frame-result')[0], shown);
  } finally {
    restore();
  }
});

test('the LoRAs chosen in a workflow are listed for the Studio, named by their file, those switched off left out', async () => {
  const { readFile } = await import('node:fs/promises');
  const { ToolCatalog } = await import('../lib/tool-catalog.mjs');
  const krea = JSON.parse(
    await readFile(new URL('../runner/workflows/fefb88eb-8311-4409-b636-6efbb42e952c.json', import.meta.url), 'utf8'),
  );
  const loras = [
    {
      id: 'grain',
      asset: 'a1',
      description: 'Grain de film',
      enabled: { policy: 'model', default: false },
      strength: { policy: 'model', min: 0, max: 1.5, default: 0.8 },
    },
    {
      id: 'net',
      asset: 'a2',
      description: '',
      enabled: { policy: 'fixed', value: true },
      strength: { policy: 'fixed', value: 1 },
    },
    {
      id: 'old',
      asset: 'a3',
      description: 'Hors service',
      enabled: { policy: 'off' },
      strength: { policy: 'fixed', value: 1 },
    },
  ];
  const tools = new ToolCatalog({
    list: async () => [{ ...krea, loras, ready: true }],
    // The registry names its files; a LoRA without one is named by its description.
    assets: {
      list: async () => [
        { id: 'a1', path: 'D:/loras/film_grain.safetensors' },
        { id: 'a2', name: 'net.safetensors', path: 'D:/x/autre.safetensors' },
      ],
    },
  });
  const [workflow] = (await tools.studio()).create_image;
  assert.deepEqual(workflow.loras, [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ]);
});

/** A workflow that brings two LoRAs: one left to the assistant (off by default), one always on. */
const withLoras = workflow => ({
  ...workflow,
  loras: [
    {
      id: 'grain',
      name: 'film_grain',
      description: 'Grain de film',
      assistant: true,
      on: false,
      strength: { min: 0, max: 1.5, default: 0.8 },
    },
    { id: 'net', name: 'net', description: '', assistant: false, on: true, strength: { value: 1 } },
  ],
});

test('the LoRAs of the workflow show in the Studio: those of the assistant are switched there and go with the creation', async () => {
  const workflow = withLoras({
    id: 'w',
    name: 'Krea 2',
    family: 'krea2',
    roles: {},
    limits: sizes,
    direct: true,
    size: { width: 1024, height: 1024 },
    settings: [],
  });
  const page = await studioPage(
    { create_image: [workflow] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'arrêt' }),
    },
  );
  const { body, asked, restore } = page;
  try {
    // In the LoRA block, first, one line each, a padlock in place of ×.
    const rows = body.find('studio-lora-row');
    assert.equal(rows.length, 2);
    assert.match(rows[0].className, /is-off/, 'off by default, as the workflow says');
    // (0.6.92) No mark of Moodix AI beside its name: its switch says that it may be switched.
    assert.equal(rows[0].find('ai-mark').length, 0);
    assert.equal(rows[1].find('studio-lora-lock').length, 1);
    // A switch only for the one left to the assistant; « Activé » in Workflows is always applied,
    // its strength fixed there: its bar greyed.
    assert.equal(body.find('studio-lora-switch').length, 1);
    assert.equal(rows[1].find('studio-bar')[0].disabled, true);
    const [grain] = body.find('studio-lora-switch');
    grain.checked = true;
    grain.onchange();
    page.prompt().value = 'un renard';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    const [, action] = asked.find(([route]) => route === 'tools/action');
    // As the model would give it; the LoRA fixed in the workflow is not the creation's to set.
    assert.deepEqual(action.arguments.loras, { grain: { enabled: true, strength: 0.8 } });
  } finally {
    restore();
  }
});

test('a proposal of Moodix AI switches the LoRAs of the workflow as it has them; changed here, they go with « Générer »', async () => {
  const { clip, request } = proposalOf();
  request.plan.loras = [
    { id: 'grain', strength: 1.2 },
    { id: 'net', strength: 1 },
  ];
  const studio = await studioPage(
    { create_video: [withLoras(clip)] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
  );
  const { body, asked, restore } = studio;
  try {
    const answer = studio.studio.propose(request, new AbortController().signal);
    await settle();
    const [grain] = body.find('studio-lora-switch');
    assert.equal(grain.checked, true, 'on, as Moodix AI has it');
    assert.equal(body.find('studio-lora-row')[0].find('studio-bar-value')[0].textContent, '1,20');
    // The user switches it off before generating: the change goes with the answer.
    grain.checked = false;
    grain.onchange();
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(asked.find(([route]) => route === 'tools/revise')[1].edits, {
      loras: { grain: { enabled: false } },
    });
  } finally {
    restore();
  }
});

test('a replacement proposed in the chat is set by the pointer: the model, the video, the character, who is who', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    },
    clip = { id: 'v', name: 'Clip', verb: 'create_video', limits: sizes, size: { width: 768, height: 448 }, settings: [], roles: {} },
    runs = [
      {
        id: 'penguin',
        mediaType: 'video',
        prompt: 'un pingouin vole',
        outputs: [{ originalUrl: '/penguin.mp4', thumbUrl: '/penguin.jpg', width: 672, height: 672 }],
      },
      { id: 'player', prompt: 'un joueur', outputs: [{ originalUrl: '/player.png', thumbUrl: '/player.jpg' }] },
    ];
  const prompt = 'A volleyball player flies over the ice.';
  const request = {
    requestId: 'q',
    approvalToken: 't',
    tool: 'replace_character',
    mediaType: 'video',
    autoAllow: true,
    workflowName: 'SCAIL-2',
    call: { id: 'call', type: 'function', function: { name: 'replace_character', arguments: '{}' } },
    plan: {
      prompt,
      parameters: { prompt, width: 672, height: 672, frames: 121, fps: 24, seed: 3, subject: 'penguin', reference_subject: 'man' },
      editable: {
        prompt: true,
        parameters: [
          { key: 'subject', type: 'string', value: 'penguin' },
          { key: 'reference_subject', type: 'string', value: 'man' },
          { key: 'seed', type: 'integer', value: 3 },
          { key: 'width', type: 'integer', value: 672, locked: 'La vidéo prend la forme de celle qu’elle suit.' },
        ],
        references: [[], []],
      },
      // The slots' own roles, and the roles the verb gives them.
      references: [
        { input: 'video', role: 'driving_video', as: 'source', output_id: 'penguin', roleLabel: 'Vidéo à suivre' },
        { input: 'character', role: 'reference_image', as: 'reference', output_id: 'player', roleLabel: 'Personnage' },
      ],
    },
  };
  // (0.6.204) What the pointer says at each step, and the window of a piece open at that moment.
  const said = [],
    seen = [];
  let page = null;
  said.push = words => (seen.push([words, page.find('studio-piece-window').map(pane => pane.attributes['aria-label'])]), Array.prototype.push.call(said, words));
  const studio = await studioPage({ create_video: [clip], replace_character: [scail] }, {}, { runs, cursor: said, targets: true });
  const { body, restore } = studio;
  page = body;
  try {
    assert.equal(studio.studio.accepts('replace_character'), true);
    const answer = studio.studio.propose(request, new AbortController().signal);
    // Allowed in the settings: the pointer sets it, then starts it.
    assert.equal(await answer, 'once');
    // (0.6.204) Who is who lives in the window of its piece: the pointer opens that of the video for « qui
    // remplacer », that of the character for « qui dessiner », one at a time, where it then sets the field.
    assert.deepEqual(
      seen.filter(([words]) => /^règle qui/.test(words)),
      [
        ['règle qui remplacer', ['Vidéo à suivre']],
        ['règle qui dessiner', ['Personnage']],
      ],
    );
    assert.equal(body.dataset.mode, 'video');
    const pick = body.find('studio-model-pick')[0];
    assert.equal(pick.value, 's');
    // The video in its slot, the character in theirs, each with its picture.
    const tiles = body.find('studio-slot');
    assert.deepEqual(
      tiles.map(tile => tile.children[0].children[0]?.src),
      ['/penguin.jpg', '/player.jpg'],
    );
    // (0.6.204) Who is who, set by the proposal, read in the window of each piece: no window is left open by the
    // pointer, and none opens while its take is made.
    assert.deepEqual([body.find('studio-who').length, body.find('studio-piece-window').length], [0, 0]);
    body.find('studio-slot-pick')[0].onclick();
    assert.equal(body.find('studio-piece-window').length, 0, 'the take is being made');
    await studio.studio.settled({ record: null, error: 'Arrêtée.' });
    const set = index => {
      body.find('studio-slot-pick')[index].onclick();
      return body.find('studio-piece-window')[0].find('studio-field').map(field => [field.children[0].textContent, field.children[1].value]);
    };
    assert.deepEqual([set(0), set(1)], [[['Qui remplacer', 'penguin']], [['Qui dessiner', 'man']]]);
    // What each is, at the foot of its window: a take by its number; a clip by its length once it is known.
    const what = index => {
      if (body.find('studio-slot-pick')[index].attributes['aria-expanded'] !== 'true') body.find('studio-slot-pick')[index].onclick();
      return body.find('studio-window-said')[0].textContent;
    };
    assert.deepEqual([what(0), what(1)], ['PRISE 2 · VIDÉO', 'PRISE 1 · IMAGE']);
    runs[0].parameters = { frames: 161, fps: 24 };
    studio.studio.render();
    assert.equal(what(0), 'PRISE 2 · 06.71 S');
    assert.equal(studio.prompt().value, prompt);
    // The screen has the shape of the video followed.
    assert.equal(body.find('studio-readout')[0]?.textContent ?? '1:1', '1:1');
  } finally {
    restore();
  }
  // (0.6.205) A proposal that waits for « Générer »: who is who set, the window of the last piece set is left
  // open, where the user sees its value (as « Plus de réglages » was for a setting of its own).
  const words = [],
    waiting = await studioPage({ create_video: [clip], replace_character: [scail] }, {}, { runs, cursor: words, targets: true });
  try {
    const answer = waiting.studio.propose({ ...structuredClone(request), autoAllow: false }, new AbortController().signal);
    await until(() => words.includes('attend votre accord'), 1500);
    assert.ok(words.includes('règle qui dessiner') && words.includes('attend votre accord'), words.join(' | '));
    assert.deepEqual(
      waiting.body.find('studio-piece-window').map(pane => [pane.attributes['aria-label'], pane.find('studio-field')[0].children[1].value]),
      [['Personnage', 'man']],
    );
    // (0.6.206) Who is who is no setting of « Plus de réglages »: its window is not opened for it.
    assert.deepEqual(
      [waiting.body.find('studio-more-window')[0].hidden, waiting.body.find('studio-more-pill')[0].attributes['aria-expanded']],
      [true, 'false'],
    );
    waiting.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    waiting.restore();
  }
});

test('the character Moodix AI made is checked: OK keeps it, « Autre image » has another made, « Annuler » stops', async () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      verb: 'create_image',
      direct: true,
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      roles: {},
    },
    runs = [{ id: 'made', prompt: 'A full-length photo of a player', outputs: [{ originalUrl: '/made.png', thumbUrl: '/made.jpg' }] }];
  const studio = await studioPage({ create_image: [krea] }, {}, { runs });
  const { body, revealed, restore } = studio;
  try {
    // The image of a character for a video of 1280 x 720: its format, about as many points.
    assert.deepEqual(studio.studio.imageSize({ width: 1280, height: 720 }), { width: 1344, height: 768 });
    assert.equal(studio.studio.imageSize(null), null);
    let check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    assert.equal(body.dataset.mode, 'image');
    assert.ok(revealed.length >= 1, 'the Studio comes on screen');
    assert.equal(studio.studio.proposing(), true);
    assert.equal(body.find('studio-check-question')[0].textContent, 'Ce personnage vous convient ?');
    assert.equal(body.find('studio-go-label')[0].textContent, 'OK');
    // The question on a line of its own, above its three answers.
    assert.match(body.find('studio-go-group')[0].className, /is-checking/);
    assert.deepEqual(
      body.find('studio-go-group')[0].children.map(child => child.className),
      ['studio-check-question', 'secondary studio-decline', 'secondary studio-again', 'primary studio-go'],
    );
    // The prompt of the screen, changed or not, is the one of the next image.
    studio.prompt().value = 'A full-length photo of a player in red';
    studio.prompt().oninput();
    body.find('studio-again')[0].onclick();
    assert.deepEqual(await check, { decision: 'again', prompt: 'A full-length photo of a player in red' });
    assert.equal(body.find('studio-check-question').length, 0);
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    await body.find('studio-go')[0].onclick();
    assert.equal((await check).decision, 'ok');
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    await settle();
    body.find('studio-decline')[0].onclick();
    assert.equal((await check).decision, 'cancel');
    // A new message in the chat cancels it too; a stopped turn stops it.
    check = studio.studio.checkCharacter(runs[0], new AbortController().signal);
    assert.equal(studio.studio.decline(), true);
    assert.equal((await check).decision, 'cancel');
    const stopped = new AbortController();
    check = studio.studio.checkCharacter(runs[0], stopped.signal);
    stopped.abort();
    await assert.rejects(check);
    assert.equal(studio.studio.proposing(), false);
  } finally {
    restore();
  }
});

test('a replacement whose character Moodix AI just made: the pointer has its prompt written from the video and that image', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [
        { key: 'subject', type: 'string', maxLength: 200, default: 'person' },
        { key: 'reference_subject', type: 'string', maxLength: 200, default: 'person' },
      ],
    },
    runs = [
      {
        id: 'penguin',
        mediaType: 'video',
        prompt: 'un pingouin vole',
        outputs: [{ originalUrl: '/penguin.mp4', thumbUrl: '/penguin.jpg', width: 672, height: 672 }],
      },
      { id: 'player', prompt: 'une joueuse', outputs: [{ originalUrl: '/player.png', thumbUrl: '/player.jpg' }] },
    ];
  const drafted = 'A volleyball player takes the place of the penguin.',
    written =
      'A young woman in a navy volleyball jersey and black shorts flies over snowy peaks, arms spread wide, ' +
      'under a pale winter sky.';
  const proposal = () => ({
    requestId: 'q',
    approvalToken: 't',
    tool: 'replace_character',
    mediaType: 'video',
    autoAllow: true,
    workflowName: 'SCAIL-2',
    call: { id: 'call', type: 'function', function: { name: 'replace_character', arguments: '{}' } },
    plan: {
      prompt: drafted,
      parameters: { prompt: drafted, width: 672, height: 672, frames: 121, fps: 24, seed: 3 },
      editable: { prompt: true, parameters: [{ key: 'seed', type: 'integer', value: 3 }], references: [[], []] },
      references: [
        { input: 'video', role: 'driving_video', as: 'source', output_id: 'penguin', roleLabel: 'Vidéo à suivre' },
        { input: 'character', role: 'reference_image', as: 'reference', output_id: 'player', roleLabel: 'Personnage' },
      ],
    },
    // Set by the page for a character it has just made: what the user asked.
    scene: { asked: 'remplace le pingouin par une joueuse de volley' },
  });
  let studio = await studioPage(
    { replace_character: [scail] },
    {
      'studio/enrich': () => ({ prompt: written, seen: true }),
      'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }),
    },
    { runs },
  );
  try {
    assert.equal(await studio.studio.propose(proposal(), new AbortController().signal), 'once');
    // The chat model sees the video and the character where they were made, with what the user
    // asked and the prompt of Moodix AI as a draft.
    assert.deepEqual(studio.asked.find(([route]) => route === 'studio/enrich')[1], {
      prompt: 'remplace le pingouin par une joueuse de volley',
      draft: drafted,
      verb: 'replace_character',
      source: { output: 'penguin' },
      reference: { output: 'player' },
      conversationId: 'c1',
    });
    assert.equal(studio.prompt().value, written);
    // What it wrote is what is made.
    assert.deepEqual(studio.asked.find(([route]) => route === 'tools/revise')[1].edits, { prompt: written });
  } finally {
    studio.restore();
  }
  // The chat model cannot write it: the prompt of Moodix AI is made, and the Studio says why.
  studio = await studioPage(
    { replace_character: [scail] },
    {
      'studio/enrich': () => {
        throw Error('Ce modèle de chat ne voit pas les images.');
      },
    },
    { runs },
  );
  try {
    assert.equal(await studio.studio.propose(proposal(), new AbortController().signal), 'once');
    assert.equal(studio.notices.at(-1), 'Prompt de Moodix AI gardé : Ce modèle de chat ne voit pas les images.');
    assert.equal(studio.prompt().value, drafted);
    assert.equal(studio.asked.filter(([route]) => route === 'tools/revise').length, 0);
  } finally {
    studio.restore();
  }
  // A proposal of the chat itself (its own image given): its prompt, already written, is not
  // written again.
  studio = await studioPage({ replace_character: [scail] }, {}, { runs });
  try {
    const { scene, ...given } = proposal();
    assert.equal(await studio.studio.propose(given, new AbortController().signal), 'once');
    assert.equal(studio.asked.filter(([route]) => route === 'studio/enrich').length, 0);
  } finally {
    studio.restore();
  }
});

test('the screen is the conversation’s, the Sortie the project’s: a new conversation shows the takes of its project below, none above', async () => {
  const image = { id: 'w', name: 'Image', roles: { source: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    taken = { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', thumbUrl: '/a.jpg', take: 3 }] },
    elsewhere = { id: 'b', conversationId: 'c2', prompt: 'une falaise', outputs: [{ originalUrl: '/b.png', thumbUrl: '/b.jpg', take: 4 }] },
    inProject = { p1: [elsewhere, taken], p2: [] };
  let conversation = 'c1',
    project = 'p1';
  const page = await studioPage({ create_image: [image] }, {}, { runs: [], conversation: () => conversation, project: () => project });
  const { body, studio, restore, runs } = page;
  const items = () => body.find('studio-item').map(tile => tile.dataset.id),
    onScreen = () => screenOf(body.find('studio-frame-result')[0])?.src ?? null,
    // (0.6.253) What the empty screen says, line by line.
    blankSaid = () => body.find('studio-blank').flatMap(blank => blank.children.filter(line => !line.hidden).map(line => line.textContent)),
    go = async (to, into = project) => {
      conversation = to;
      project = into;
      runs.splice(0, runs.length, ...inProject[into]);
      studio.conversationChanged();
      await settle();
    };
  try {
    await go('c1');
    // Below, every take of the project, the newest at the left; above, the one of this conversation.
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(onScreen(), '/a.png');
    // A new conversation of the project (no identifier yet): the same takes below, the screen empty.
    await go(null);
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(body.find('studio-frame')[0].className.includes('is-empty'), true);
    // (0.6.198) Not « Votre première prise » above the takes of its project: the next one will be the PRISE 5.
    // (0.6.253, generer-maquette.md, A00) No sentence any more, first or next: the format and the size to come.
    assert.deepEqual(blankSaid(), ['1:1 · 1024 × 1024']);
    // Another conversation of the project: its own take above, the same Sortie.
    await go('c2');
    assert.deepEqual(items(), ['b', 'a']);
    assert.equal(onScreen(), '/b.png');
    // Another project: its own takes (none), the Studio empty (etats-maquette.md, 55); its first take to come.
    await go('c9', 'p2');
    assert.deepEqual(items(), []);
    assert.equal(body.find('studio-frame')[0].className.includes('is-empty'), true);
    assert.deepEqual(blankSaid(), ['1:1 · 1024 × 1024']);
  } finally {
    restore();
  }
});

test('a conversation opened sets the Studio as its last take was made: model, prompt, format, settings, LoRAs, inputs; a seed only if it was named', async () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      family: 'krea2',
      seeded: true,
      direct: true,
      styled: true,
      roles: { source: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'], many: true } },
      inputs: { source_image: 'source', reference_image: 'reference' },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [{ key: 'steps', type: 'number', min: 1, max: 50, default: 8 }],
      loras: [{ id: 'detail', name: 'Détail', on: false, assistant: true, strength: { min: 0, max: 2, default: 1 } }],
    },
    moss = { id: 'm', name: 'MOSS Image', family: 'moss', seeded: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    made = (id, conversationId, prompt, parameters, more = {}) => ({
      id,
      conversationId,
      workflowId: 'k',
      prompt,
      parameters: { width: 1024, height: 1024, seed: 111, ...parameters },
      outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }],
      ...more,
    }),
    // The newest first, as the gallery lists them.
    all = [
      // Made from an image of the conversation, a reference of the project that is gone, and a take deleted.
      made('wide', 'c2', 'une plage en hiver', {
        width: 1344,
        height: 768,
        steps: 12,
        seed: 4242,
        seed_given: true,
        loras: [{ id: 'detail', strength: 1.5 }],
        styles: [{ name: 'a.safetensors', strength: 0.7 }, { name: 'gone.safetensors', strength: 1 }],
        references: [
          { input: 'edit', role: 'source_image', output_id: 'first' },
          { input: 'subject-1', role: 'reference_image', resource_id: 'kept' },
          { input: 'subject-2', role: 'reference_image', resource_id: 'erased' },
        ],
      }),
      made('first', 'c2', 'une plage', {}),
      // An enlargement, made by no model of the mode: the take before it gives the settings.
      made('large', 'c1', '', { width: 2048, height: 2048 }, { workflowId: 'upscaler' }),
      made('tall', 'c1', 'un phare la nuit', { width: 768, height: 1344, steps: 20 }),
    ];
  let conversation = 'c1';
  const page = await studioPage(
    { create_image: [moss, krea] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    {
      runs: all,
      conversation: () => conversation,
      project: () => 'p1',
      resource: id => (id === 'kept' ? { id, label: '#ref2', name: 'visage.png', previewUrl: '/preview/kept', width: 800, height: 600 } : null),
    },
  );
  const { body, studio, asked, restore } = page;
  const slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null),
    sent = async () => {
      await body.find('studio-go')[0].onclick();
      await settle();
      return asked.findLast(([route]) => route === 'tools/action')[1].arguments;
    };
  try {
    // « c1 »: on the screen its newest take (the enlargement); the settings of the last one a model made.
    assert.equal(body.find('studio-frame-result')[0].src, '/large.png');
    assert.equal(page.prompt().value, 'un phare la nuit');
    let args = await sent();
    assert.equal(args.workflow, 'k', 'its model, not the first of the list');
    assert.deepEqual([args.width, args.height, args.steps], [768, 1344, 20]);
    assert.equal(args.seed, undefined, 'its seed was drawn: another is drawn');
    assert.equal(args.source, undefined);
    // What the user writes there stays, there.
    page.prompt().value = 'un phare au matin';
    page.prompt().oninput();
    // « c2 »: the settings of its last take, its inputs in their cases; the reference that is gone
    // leaves its case empty, said in the Studio.
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'une plage en hiver');
    assert.deepEqual(slots(), ['/first.jpg', '/preview/kept', null]);
    // Its LoRA whose file left the folder is not put back either, and named: what the Studio shows
    // is not all that made the take.
    assert.equal(
      body.find('studio-error')[0].textContent,
      'Une image utilisée pour la dernière prise n’existe plus : sa case est restée vide. Un LoRA de la dernière prise n’est plus dans le dossier loras : gone.',
    );
    args = await sent();
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [1344, 768, 12, 4242], 'the seed the user had named');
    assert.deepEqual(args.source, { output: 'first' });
    assert.deepEqual(args.reference, [{ resource: 'kept' }]);
    assert.deepEqual(args.loras, { detail: { enabled: true, strength: 1.5 } });
    // The LoRA of the user that is still in its folder, not the one that left it.
    assert.deepEqual(asked.findLast(([route]) => route === 'tools/action')[1].styles, [{ name: 'a.safetensors', strength: 0.7 }]);
    // Back in « c1 »: as it was left (no take made in it since), not the settings of « c2 ».
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un phare au matin');
    args = await sent();
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [768, 1344, 20, undefined]);
    assert.equal(args.loras?.detail?.enabled ?? false, false);
    // « Afficher dans le Studio » on a take made with LoRAs that left the folder: each named by its
    // file, without its folder nor « .safetensors »; the one still there is put back.
    const styled = styles => made('styled', 'c1', 'un phare', { styles });
    studio.show(
      styled([
        { name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 },
        { name: 'a.safetensors', strength: 0.6 },
        { name: 'old/gone.safetensors', strength: 1 },
      ]),
    );
    assert.equal(body.find('studio-error')[0].textContent, '2 LoRA de cette prise ne sont plus dans le dossier loras : 70sSCiFiKrea2Raw, gone.');
    await sent();
    assert.deepEqual(asked.findLast(([route]) => route === 'tools/action')[1].styles, [{ name: 'a.safetensors', strength: 0.6 }]);
    studio.show(styled([{ name: 'styles\\70sSCiFiKrea2Raw.safetensors', strength: 0.8 }]));
    assert.equal(body.find('studio-error')[0].textContent, 'Un LoRA de cette prise n’est plus dans le dossier loras : 70sSCiFiKrea2Raw.');
    // All of them still there: nothing to say.
    studio.show(styled([{ name: 'a.safetensors', strength: 1 }]));
    assert.deepEqual(body.find('studio-error'), []);
  } finally {
    restore();
  }
});

test('a take made from the chat since the Studio was last seen sets it again; one it made itself does not', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    take = (id, prompt) => ({ id, conversationId: 'c1', workflowId: 'w', prompt, parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }] });
  const page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'done', record: { id: 'b' } }),
    },
    { runs: [take('a', 'un renard')], project: () => 'p1' },
  );
  const { body, studio, runs, restore } = page;
  try {
    assert.equal(page.prompt().value, 'un renard');
    // Made here, with another prompt: the Studio keeps what the user goes on writing.
    page.prompt().value = 'un renard dans la neige';
    page.prompt().oninput();
    runs.unshift(take('b', 'un renard dans la neige'));
    await body.find('studio-go')[0].onclick();
    await settle();
    page.prompt().value = 'un renard qui court';
    page.prompt().oninput();
    await studio.open();
    assert.equal(page.prompt().value, 'un renard qui court');
    // Made from the chat meanwhile: the Studio takes its settings when it comes back on screen.
    runs.unshift(take('c', 'un lièvre'));
    studio.invalidate();
    await studio.open();
    assert.equal(page.prompt().value, 'un lièvre');
    assert.equal(body.find('studio-frame-result')[0].src, '/c.png');
  } finally {
    restore();
  }
});

test('the size a take was made at is the one shown, outside the lists too: asked in the Chat, of no format, of a proposal answered (0.6.92)', async () => {
  // Krea 2 makes any multiple of 8: the Chat asks sizes that no list of the Studio has (1920 × 1080).
  const any = { width: { min: 64, max: 4096, multipleOf: 8 }, height: { min: 64, max: 4096, multipleOf: 8 } },
    krea = {
      id: 'k',
      name: 'Krea 2',
      family: 'krea2',
      direct: true,
      seeded: true,
      roles: {},
      limits: any,
      size: { width: 1024, height: 1024 },
      settings: [],
    },
    take = (id, width, height) => ({
      id,
      conversationId: 'c1',
      workflowId: 'k',
      prompt: 'un phare',
      parameters: { width, height, seed: 3 },
      outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }],
    }),
    // Moodix AI proposes a portrait of 1080 × 1920 from the chat of the Studio.
    proposed = {
      requestId: 'p',
      approvalToken: 't',
      tool: 'create_image',
      workflowName: 'Krea 2',
      resolution: { width: 1080, height: 1920 },
      call: { id: 'call-p', type: 'function', function: { name: 'create_image', arguments: '{}' } },
      plan: {
        prompt: 'un phare la nuit',
        parameters: { prompt: 'un phare la nuit', width: 1080, height: 1920, seed: 7 },
        editable: {
          prompt: true,
          stages: [],
          parameters: [
            { key: 'width', type: 'integer', value: 1080 },
            { key: 'height', type: 'integer', value: 1920 },
            { key: 'seed', type: 'integer', value: 7 },
          ],
          references: [],
        },
        references: [],
      },
    };
  const page = await studioPage(
    { create_image: [krea] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs: [take('a', 1920, 1080)], project: () => 'p1' },
  );
  const { body, studio, asked, runs, restore } = page;
  const size = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'size'),
    // The format checked, as its chip reads.
    format = () => {
      const chip = body.find('studio-format').find(item => item.attributes?.['aria-checked'] === 'true');
      return chip?.children.at(-1).textContent;
    },
    sent = async () => {
      await body.find('studio-go')[0].onclick();
      await settle();
      const { width, height } = asked.findLast(([route]) => route === 'tools/action')[1].arguments;
      return [width, height];
    };
  try {
    // Asked in the Chat at 1920 × 1080: shown so among the sizes of 16:9, by its pixels (before
    // 1920 × 1088), and made so again; not the size of the list nearest to 1024 × 1024 (1344 × 768).
    assert.equal(size().attributes['aria-valuetext'], '1920 × 1080');
    assert.deepEqual([size().value, size().max], ['3', '6']);
    assert.equal(format(), '16:9');
    assert.deepEqual(await sent(), [1920, 1080]);
    // 1280 × 800 (16:10): no format is that, the nearest one (3:2) in place of « ··· », and its very
    // size; not the format and the size of the take before.
    runs.unshift(take('b', 1280, 800));
    studio.invalidate();
    await studio.open();
    assert.equal(size().attributes['aria-valuetext'], '1280 × 800');
    assert.equal(format(), '3:2 ···');
    assert.deepEqual(await sent(), [1280, 800]);
    // Another format chosen: a size of its list, and nothing else on the bar.
    body.find('studio-format').find(chip => chip.children.at(-1)?.textContent === '1:1').onclick();
    assert.equal(size().attributes['aria-valuetext'], '1024 × 1024');
    assert.equal(size().max, '5');
    // Proposed by Moodix AI at 1080 × 1920, then answered: its size stays once its take is made.
    const answer = studio.propose(proposed, new AbortController().signal);
    await settle();
    assert.equal(size().attributes['aria-valuetext'], '1080 × 1920');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    runs.unshift(take('c', 1080, 1920));
    await studio.settled({ record: { id: 'c' } });
    assert.equal(body.find('studio-frame-result')[0].src, '/c.png');
    assert.equal(size().attributes['aria-valuetext'], '1080 × 1920');
    assert.equal(format(), '9:16');
    assert.deepEqual(await sent(), [1080, 1920]);
    // A proposal of no format (1280 × 800) is read with the nearest one: the format in hand stayed.
    const { proposedValues } = await import('../public/studio.mjs'),
      wide = { ...proposed.plan, parameters: { ...proposed.plan.parameters, width: 1280, height: 800 } };
    assert.deepEqual(
      ['format', 'size'].map(key => proposedValues({ ...proposed, plan: wide }, [krea])[key]),
      ['3:2', '1280x800'],
    );
  } finally {
    restore();
  }
});

test('the Sortie is the project’s: the creations of its other conversations dragged into a slot become inputs', async () => {
  const scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      seeded: true,
      roles: {
        source: { count: 1, media: ['video'], many: false, required: true },
        reference: { count: 1, media: ['image'], many: false, required: true },
      },
      settings: [],
    },
    runs = [
      // Made in another conversation of the project.
      {
        id: 'clip',
        conversationId: 'other',
        mediaType: 'video',
        prompt: 'une fille cueille une pomme',
        outputs: [{ originalUrl: '/clip.mp4', thumbUrl: '/clip.jpg', width: 896, height: 512 }],
      },
      { id: 'face', conversationId: 'c1', prompt: 'un joueur', outputs: [{ originalUrl: '/face.png', thumbUrl: '/face.jpg' }] },
    ];
  const page = await studioPage(
    { replace_character: [scail] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs, project: () => 'p1' },
  );
  const { body, asked, notices, restore } = page;
  try {
    // Read for the whole project, with the open conversation.
    assert.ok(asked.some(([route]) => route === 'project-gallery/p1?images=0&conversation=c1'));
    page.mode(1);
    const items = () => body.find('studio-item'),
      slots = () => body.find('studio-slot'),
      event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], setData() {} } },
      carry = (item, slot) => {
        items()[item].find('studio-item-pick')[0].ondragstart(event);
        slots()[slot].ondrop(event);
      };
    // The whole project (16/11: the takes are shared in it): the clip of another conversation and
    // the image of this one.
    assert.equal(items().length, 2);
    // An image is not the video to follow; the clip is.
    carry(1, 0);
    assert.match(notices.at(-1), /attend une vidéo/);
    assert.doesNotMatch(slots()[0].className, /is-filled/);
    carry(0, 0);
    carry(1, 1);
    assert.deepEqual(
      slots().map(tile => tile.children[0].children[0]?.src),
      ['/clip.jpg', '/face.jpg'],
    );
    page.prompt().value = 'A young man picks an apple.';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    // The clip keeps its conversation: the server finds it there.
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.deepEqual(action.arguments.source, { output: 'clip', conversation: 'other' });
    assert.deepEqual(action.arguments.reference, { output: 'face' });
  } finally {
    restore();
  }
});

test('a click on an empty case opens the files of the computer, on a piece given its small window with « Changer… » and « Retirer » (0.6.204)', async () => {
  const image = {
      id: 'w',
      name: 'Image',
      roles: { source: { count: 1, media: ['image'], many: false } },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
    },
    runs = [{ id: 'face', conversationId: 'c1', prompt: 'un joueur', outputs: [{ originalUrl: '/face.png', thumbUrl: '/face.jpg' }] }];
  const page = await studioPage({ create_image: [image] }, {}, { runs, project: () => 'p1' });
  const { body, restore } = page;
  try {
    const picker = page.page['studio-view'].children.find(child => child.tag === 'input'),
      slot = () => body.find('studio-slot')[0];
    assert.equal(picker.clicks ?? 0, 0);
    slot().find('studio-slot-pick')[0].onclick();
    assert.equal(picker.clicks, 1, 'the files of the computer, at once');
    assert.equal(picker.accept, 'image/png,image/jpeg,image/webp');
    assert.equal(body.find('studio-shelf').length, 0);
    assert.equal(body.find('studio-input-block').length, 1, 'nothing opens under the inputs');
    // (0.6.201, capture 99) The image to modify alone on the plateau, its word under it; its row named whole.
    assert.deepEqual(body.find('studio-piece-word').map(word => word.textContent), ['À modifier']);
    assert.deepEqual(body.find('studio-pieces').map(row => row.attributes['aria-label']), ['Image à modifier']);
    // The file chosen fills the case. (0.6.204, capture 99) A click on it opens its small window, no longer the
    // files at once: its name, what it is, and at its foot « Changer… » and « Retirer ». Nothing to set with it.
    picker.files = [{ name: 'visage.png', type: 'image/png' }];
    await picker.onchange();
    await settle();
    assert.match(slot().className, /is-filled/);
    const pane = () => body.find('studio-piece-window'),
      foot = () => pane()[0].find('studio-window-foot')[0].children,
      press = name => foot().find(part => part.children[0]?.textContent === name);
    slot().find('studio-slot-pick')[0].onclick();
    assert.deepEqual([picker.clicks, pane().length], [1, 1]);
    assert.deepEqual(pane()[0].children.map(part => part.className), ['studio-window-title', 'studio-window-foot']);
    assert.deepEqual([pane()[0].children[0].textContent, foot()[0].textContent], ['Image à modifier', '#ref1 · visage.png']);
    assert.deepEqual(foot().slice(1).map(part => [part.children[0].textContent, part.disabled, part.title]), [
      ['Changer…', false, undefined],
      ['Retirer', undefined, undefined],
    ]);
    // « Changer… »: the files of the computer for this case, its window closed.
    press('Changer…').onclick();
    assert.deepEqual([picker.clicks, picker.accept], [2, 'image/png,image/jpeg,image/webp']);
    page.studio.render();
    assert.equal(pane().length, 0);
    picker.files = [{ name: 'autre.png', type: 'image/png' }];
    await picker.onchange();
    await settle();
    assert.equal(slot().children[0].children[0].src, '/preview/autre.png');
    // A take of the project carried into the case says its number at the foot of its window.
    const carried = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], setData() {} } };
    body.find('studio-item')[0].find('studio-item-pick')[0].ondragstart(carried);
    slot().ondrop(carried);
    slot().find('studio-slot-pick')[0].onclick();
    assert.equal(foot()[0].textContent, 'PRISE 1 · IMAGE');
    // « Retirer »: the case empty again, its window gone with it.
    press('Retirer').onclick();
    assert.deepEqual([/is-filled/.test(slot().className), pane().length], [false, 0]);
    // Its × takes it back the same way, its window open or not.
    picker.files = [{ name: 'visage.png', type: 'image/png' }];
    slot().find('studio-slot-pick')[0].onclick();
    await picker.onchange();
    await settle();
    slot().find('studio-slot-pick')[0].onclick();
    assert.equal(pane().length, 1);
    slot().find('studio-slot-remove')[0].onclick();
    assert.deepEqual([/is-filled/.test(slot().className), pane().length], [false, 0]);
    // Given again: no window left open from before.
    slot().find('studio-slot-pick')[0].onclick();
    await picker.onchange();
    await settle();
    assert.deepEqual([/is-filled/.test(slot().className), pane().length], [true, 0]);
  } finally {
    restore();
  }
});

test('on a take of the Sortie, « Prolonger » and « Animer » wear the pictos of the bar of the screen', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = { id: 'v', name: 'Clip', roles: { start_image: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    runs = [
      { id: 'c1', mediaType: 'video', prompt: 'un clip', outputs: [{ originalUrl: '/c1.mp4', thumbUrl: '/c1.jpg' }] },
      { id: 'p1', prompt: 'une image', outputs: [{ originalUrl: '/p1.png' }] },
    ];
  const page = await studioPage({ create_image: [image], create_video: [clip] }, {}, { runs });
  try {
    const main = id => page.body.find('studio-item').find(tile => tile.dataset.id === id).find('studio-item-main')[0];
    assert.equal(main('c1').children[0].glyph, 'act-extend');
    assert.equal(main('c1').attributes['aria-label'], 'Prolonger · #2');
    assert.equal(main('p1').children[0].glyph, 'act-animate');
  } finally {
    page.restore();
  }
  const css = (await (await import('node:fs/promises')).readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // A rounded square, smaller than on the bar, 6 px from the bottom of the picture (not of the tile).
  assert.match(css, /#studio-view \.studio-item-main,\n#studio-view \.studio-item-del \{\n  width: 26px;\n  height: 26px;\n  border: 1px solid rgba\(238, 232, 222, 0\.14\);\n  border-radius: 8px;/);
  assert.match(css, /#studio-view \.studio-item-main \{\n  top: calc\(var\(--strip-h, 96px\) - 32px\);\n  right: 6px;\n  bottom: auto;/);
});

test('the Sortie shows the whole project to begin with; its button released, the kind of the mode only', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    runs = [
      { id: 's1', mediaType: 'audio', prompt: 'un son', outputs: [{ originalUrl: '/s1.wav' }] },
      { id: 'c1', mediaType: 'video', prompt: 'un clip', outputs: [{ originalUrl: '/c1.mp4', thumbUrl: '/c1.jpg' }] },
      { id: 'p1', prompt: 'une image', outputs: [{ originalUrl: '/p1.png' }] },
    ];
  let page = await studioPage({ create_image: [image], create_video: [clip] }, {}, { runs });
  try {
    const { body } = page,
      go = () => body.find('studio-sort-go')[0],
      ids = () => body.find('studio-item').map(tile => tile.dataset.id);
    // To begin with (16/11), in Image: everything of the project, sounds and clips with the images,
    // the newest at the left, each with its number; the button pressed.
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · tout');
    assert.equal(go().attributes['aria-pressed'], 'true');
    assert.deepEqual(body.find('studio-item-number').map(badge => badge.textContent), ['#3', '#2', '#1']);
    // Another mode: still everything.
    page.mode(1);
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
    // Released: the kind of the mode (capture 20: no clip among the images); a creation keeps its number.
    go().onclick();
    assert.deepEqual(ids(), ['c1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · vidéos');
    assert.equal(go().attributes['aria-pressed'], 'false');
    assert.deepEqual(body.find('studio-item-number').map(badge => badge.textContent), ['#2']);
    // It stays released from one mode to the other, until it is pressed again.
    page.mode(0);
    assert.deepEqual(ids(), ['p1']);
    assert.equal(go().attributes['aria-label'], 'Trier la Sortie · images');
    go().onclick();
    assert.deepEqual(ids(), ['s1', 'c1', 'p1']);
  } finally {
    page.restore();
  }
  // Released on a kind with nothing made: said so, the button still there to show the others.
  page = await studioPage({ create_image: [image] }, {}, { runs: [runs[0]] });
  try {
    const { body } = page;
    assert.deepEqual(body.find('studio-item').map(tile => tile.dataset.id), ['s1']);
    body.find('studio-sort-go')[0].onclick();
    assert.equal(body.find('studio-item').length, 0);
    assert.equal(
      body.find('studio-empty-strip')[0].children[0].textContent,
      'Rien pour l’instant. Vos images apparaîtront ici, la dernière à gauche.',
    );
    body.find('studio-sort-go')[0].onclick();
    assert.deepEqual(body.find('studio-item').map(tile => tile.dataset.id), ['s1']);
  } finally {
    page.restore();
  }
});

// ------------------------------------------------------------------ a creation looked at on the screen (16/11)
const lookModels = () => {
  const krea = {
      id: 'k',
      name: 'Krea 2',
      family: 'krea2',
      seeded: true,
      direct: true,
      roles: { source: { count: 1, media: ['image'] } },
      inputs: { img2img: 'source' },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [{ key: 'steps', type: 'number', min: 1, max: 50, default: 8 }],
    },
    clip = {
      id: 'v',
      name: 'Clip',
      family: 'ltx25',
      seeded: true,
      direct: true,
      roles: { start_image: { count: 1, media: ['image'] } },
      inputs: { start_image: 'start_image' },
      limits: sizes,
      size: { width: 768, height: 448 },
      lengths: { seconds: [121 / 24, 193 / 24], standard: 121 / 24 },
      settings: [],
    };
  const sound = { id: 's', name: 'Bruitages', roles: {}, settings: [{ key: 'seconds', type: 'number', min: 1, max: 30, default: 10 }] };
  return { create_image: [krea], create_video: [clip], create_audio: [sound] };
};
const lookRuns = () => [
  {
    id: 'film',
    conversationId: 'c2',
    mediaType: 'video',
    workflowId: 'v',
    workflowName: 'Clip',
    prompt: 'un renard court dans la neige',
    parameters: { width: 1344, height: 768, frames: 193, fps: 24, seed: 777, references: [{ role: 'start_image', output_id: 'fox' }] },
    outputs: [{ originalUrl: '/film.mp4', thumbUrl: '/film.jpg', take: 9 }],
  },
  {
    id: 'fox',
    conversationId: 'c1',
    workflowId: 'k',
    workflowName: 'Krea 2',
    prompt: 'un renard',
    parameters: { width: 768, height: 1344, steps: 20, seed: 4242 },
    outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 3 }],
  },
];
const dropOn = (page, transfer) =>
  page.body.find('studio-stage')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: transfer });
const seedOf = async page => {
  await page.body.find('studio-go')[0].onclick();
  await settle();
  return page.asked.findLast(([route]) => route === 'tools/action')[1].arguments;
};
const lookRoutes = {
  'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
  'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
};

test('a take dropped on the screen is shown there with all that made it, its very seed (« Plus de réglages » left closed, 0.6.206); « Revenir » gives the Studio back', async () => {
  const page = await studioPage(lookModels(), lookRoutes, { runs: lookRuns(), project: () => 'p1' });
  const { body, studio, restore } = page;
  const back = () => body.find('studio-look-back')[0],
    onScreen = () => screenOf(body.find('studio-frame-result')[0])?.src ?? null,
    slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null);
  try {
    // The conversation « c1 »: its image on the screen, its settings (not its seed: it was drawn).
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/fox.png');
    assert.equal(back(), undefined, 'nothing looked at: no way back');
    page.prompt().value = 'mon idée en cours';
    page.prompt().oninput();
    assert.equal(body.find('studio-rare')[0].hidden, true);
    // The clip of another conversation of the project, dragged from the Sortie to the screen.
    const film = body.find('studio-item').find(tile => tile.dataset.id === 'film'),
      transfer = { files: [], types: [], setData() {} };
    film.find('studio-item-pick')[0].ondragstart({ dataTransfer: transfer });
    const stage = body.find('studio-stage')[0],
      over = { preventDefault: () => (over.taken = true), dataTransfer: transfer };
    stage.ondragover(over);
    assert.equal(over.taken, true, 'the screen takes it');
    dropOn(page, transfer);
    // Its kind is open, it is on the screen, and the Studio is as it was to make it.
    assert.equal(body.dataset.mode, 'video');
    assert.equal(onScreen(), '/film.mp4');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.deepEqual(slots(), ['/fox.jpg'], 'its start image back in its case');
    // (0.6.206) « Plus de réglages » is not opened for it any more: a window now, it would hide the take
    // looked at. Its seed is there for the one who opens it.
    assert.equal(body.find('studio-rare')[0].hidden, true, '« Plus de réglages » left closed');
    assert.equal(body.find('studio-seed')[0].children[1].value, '777');
    // The actions of that take, on the bar of the screen.
    assert.ok(body.find('output-actions')[0].children.length > 0);
    let args = await seedOf(page);
    assert.deepEqual([args.width, args.height, args.seed], [1344, 768, 777], 'its very seed');
    assert.ok(Math.abs(args.duration - 193 / 24) < 1e-9);
    // « Revenir », at the right of « Image · Vidéo · Son »: the clip leaves, the Studio is as before.
    assert.equal(back().children.at(-1).textContent, 'Revenir');
    assert.match(back().title, /remettre vos réglages d’avant/);
    back().onclick();
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/fox.png');
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    assert.equal(back(), undefined);
    args = await seedOf(page);
    assert.deepEqual([args.width, args.height, args.steps, args.seed], [768, 1344, 20, undefined]);
    // « Afficher dans le Studio », from the chat: the same.
    studio.show(lookRuns()[0]);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.ok(back());
    // Looked at twice in a row: « Revenir » still leads to the Studio of before the first.
    studio.show(lookRuns()[1]);
    assert.equal(page.prompt().value, 'un renard');
    assert.equal((await seedOf(page)).seed, 4242);
    back().onclick();
    assert.equal(page.prompt().value, 'mon idée en cours');
    // An image of a case is not a creation to look at: the screen leaves it.
    const slotDrag = { preventDefault: () => (slotDrag.taken = true), dataTransfer: { types: [], files: [] } };
    body.find('studio-stage')[0].ondragover(slotDrag);
    assert.equal(slotDrag.taken, undefined);
  } finally {
    restore();
  }
});

test('a file dropped on the screen: one Moodix made says what made it, whatever its name; one from elsewhere changes no setting', async () => {
  const { mp4Box, pngChunk } = await import('../public/media-info.mjs');
  const be = value => {
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(value);
      return bytes;
    },
    box = (type, data) => Buffer.concat([be(8 + data.length), Buffer.from(type, 'ascii'), data]),
    film = Buffer.concat([box('ftyp', Buffer.from('isomiso2', 'latin1')), box('mdat', Buffer.alloc(32))]),
    signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    picture = sheet => Buffer.concat([signature, box2('IHDR', Buffer.alloc(13)), ...(sheet ? [Buffer.from(pngChunk(sheet))] : []), box2('IEND', Buffer.alloc(0))]),
    box2 = (type, data) => Buffer.concat([be(data.length), Buffer.from(type, 'ascii'), data, be(0)]),
    file = (bytes, name, type) => new File([bytes], name, { type });
  const page = await studioPage(lookModels(), lookRoutes, { runs: lookRuns(), project: () => 'p1' });
  const { body, notices, restore } = page;
  const back = () => body.find('studio-look-back')[0],
    onScreen = () => screenOf(body.find('studio-frame-result')[0])?.src ?? null,
    drop = async dropped => {
      dropOn(page, { files: [dropped], types: ['Files'] });
      await settle();
    };
  try {
    page.prompt().value = 'mon idée en cours';
    page.prompt().oninput();
    // A clip of this project, renamed on the disk: its sheet names it; it is that take.
    await drop(file(Buffer.concat([film, Buffer.from(mp4Box({ moodix: 1, id: 'film', mediaType: 'video' }))]), 'vacances (1).mp4', 'video/mp4'));
    assert.equal(body.dataset.mode, 'video');
    assert.equal(onScreen(), '/film.mp4', 'the take itself, not a copy of the file');
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.equal((await seedOf(page)).seed, 777);
    back().onclick();
    // An image Moodix made elsewhere (another project, another computer): kept as a reference of the
    // project, shown from there, with what its sheet says made it.
    const elsewhere = { moodix: 1, id: 'ailleurs', mediaType: 'image', workflowId: 'k', workflowName: 'Krea 2', prompt: 'un phare', parameters: { width: 1344, height: 768, steps: 30, seed: 99 } };
    await drop(file(picture(elsewhere), 'phare.png', 'image/png'));
    assert.equal(body.dataset.mode, 'image');
    assert.equal(onScreen(), '/preview/phare.png');
    assert.equal(page.prompt().value, 'un phare');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    let made = await seedOf(page);
    assert.deepEqual([made.width, made.height, made.steps, made.seed], [1344, 768, 30, 99]);
    // Its actions take it as a reference of the project.
    assert.ok(body.find('output-actions')[0].children.length > 0);
    back().onclick();
    assert.equal(page.prompt().value, 'mon idée en cours');
    // Made with a model this installation does not have: said, the settings untouched.
    await drop(file(picture({ ...elsewhere, workflowId: 'inconnu', workflowName: 'Flux 3' }), 'flux.png', 'image/png'));
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-error')[0].textContent, 'Créé avec Flux 3, qui n’est pas disponible ici : vos réglages sont restés tels quels.');
    back().onclick();
    // A photo from elsewhere: on the screen, and nothing of the settings changes.
    await drop(file(picture(null), 'photo.png', 'image/png'));
    assert.equal(onScreen(), '/preview/photo.png');
    assert.equal(page.prompt().value, 'mon idée en cours');
    assert.equal(body.find('studio-rare')[0].hidden, true);
    assert.equal(body.find('studio-error').length, 0);
    made = await seedOf(page);
    assert.deepEqual([made.steps, made.seed], [20, undefined], 'the settings of before');
    assert.ok(back());
    back().onclick();
    assert.equal(onScreen(), '/fox.png');
    // A sound: its kind opens, it plays from the file itself; no action on a sound.
    const made0 = [],
      given = [],
      urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = blob => (made0.push(blob), 'blob:son');
    URL.revokeObjectURL = address => given.push(address);
    try {
      await drop(file(Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), 'pluie.wav', 'audio/wav'));
      assert.equal(body.dataset.mode, 'audio');
      back().onclick();
      assert.deepEqual(given, ['blob:son'], 'the address of the file given back');
    } finally {
      URL.createObjectURL = urls.create;
      URL.revokeObjectURL = urls.revoke;
    }
    // Neither an image, a clip nor a sound: said, nothing changes.
    await drop(file(Buffer.from('%PDF-1.7'), 'notes.pdf', 'application/pdf'));
    assert.match(notices.at(-1), /ni une image, ni une vidéo, ni un son/);
    assert.equal(back(), undefined);
  } finally {
    restore();
  }
  // A kind no model makes here has no screen to open: said, nothing changes, nothing is kept.
  const { create_image } = lookModels(),
    alone = await studioPage({ create_image }, lookRoutes, { runs: [lookRuns()[1]], project: () => 'p1' });
  try {
    dropOn(alone, { files: [file(Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1'), 'pluie.wav', 'audio/wav')], types: ['Files'] });
    await settle();
    assert.equal(alone.notices.at(-1), 'Aucun modèle de son n’est prêt : ce média ne peut pas être montré dans le Studio.');
    assert.equal(alone.body.dataset.mode, 'image');
    assert.equal(alone.body.find('studio-look-back').length, 0);
  } finally {
    alone.restore();
  }
});

test('the take on the screen is a little smaller than its frame and rounded on its own, whatever the format chosen', async () => {
  const read = async name => (await (await import('node:fs/promises')).readFile(new URL('../public/' + name, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const css = await read('moodix.css'),
    rule = selector => {
      const at = css.lastIndexOf('\n' + selector + ' {\n');
      assert.ok(at >= 0, selector);
      return css.slice(at, css.indexOf('\n}\n', at));
    };
  // 8 px all around, in the middle of the frame, corners of its own.
  const take = rule('#studio-view .studio-frame > :is(img, video, .studio-frame-clip).studio-frame-result');
  assert.match(take, /width: calc\(100% - 16px\);/);
  assert.match(take, /height: calc\(100% - 16px\);/);
  assert.match(take, /border-radius: 10px;/);
  assert.match(take, /top: 50%;\n  left: 50%;/);
  assert.match(take, /transform: translate\(-50%, -50%\);/);
  // Its box has its own shape, as large as the frame allows: rounded even in a frame of another format.
  const shaped = rule("#studio-view .studio-frame > :is(img, video, .studio-frame-clip).studio-frame-result[style*='--media-ratio']");
  assert.match(shaped, /width: min\(100cqw - 16px, \(100cqh - 16px\) \* var\(--media-ratio\)\);/);
  assert.match(shaped, /aspect-ratio: var\(--media-ratio\);/);
  assert.match(rule('#studio-view .studio-frame'), /container-type: size;/);
  // That shape is said by the Studio: from the record at once, from the picture once it is read.
  const video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [] },
    clip = { id: 'c', mediaType: 'video', prompt: 'un renard', outputs: [{ originalUrl: '/clip.mp4' }], parameters: { width: 768, height: 448, frames: 121, fps: 24 } };
  const page = await studioPage({ create_video: [video] }, {}, { runs: [clip] });
  try {
    // (A clip: its box takes the shape, read from the clip in it, 0.6.97.)
    const [box] = page.body.find('studio-frame-result'),
      shown = screenOf(box),
      said = [];
    box.style.setProperty = (name, value) => said.push([name, value]);
    shown.videoWidth = 1024;
    shown.videoHeight = 1024;
    shown.onloadedmetadata();
    assert.deepEqual(said, [['--media-ratio', '1.0000']]);
  } finally {
    page.restore();
  }
  const source = await read('studio.mjs');
  assert.match(source, /const known = sizeOfRecord\(record\);\n    if \(known\) shaped\(known\.width, known\.height\);/);
});

test('Moodix AI continues a clip of the disk (« #ref1 »): the Studio shows that clip being continued, not the empty cases of a new video', async () => {
  // As the application describes them: a new video with LTX 2.5 takes a start, an end and references;
  // a continuation takes its clip alone.
  const create = {
      id: 'ltx',
      name: 'LTX 2.5',
      verb: 'create_video',
      roles: { start_image: { count: 1, media: ['image'] }, end_image: { count: 1, media: ['image'] }, reference: { count: 2, media: ['image'], many: true } },
      exclusive: [['source'], ['reference']],
      limits: sizes,
      size: { width: 768, height: 448 },
      stages: true,
      seeded: true,
      lengths: { seconds: [121 / 24, 145 / 24], standard: 121 / 24 },
      settings: [],
    },
    extend = {
      ...create,
      verb: 'extend_video',
      roles: { source: { count: 1, media: ['video'], many: false, required: true }, reference: { count: 0, media: [], many: true } },
      lengths: { seconds: [4, 5, 6], standard: 5 },
    },
    view = { id: '5126b40d', name: 'view.mp4', label: '#ref1', width: 1152, height: 2048, originalUrl: '/media/view/original', previewUrl: '/media/view/preview' },
    request = {
      requestId: 'q1',
      approvalToken: 't1',
      tool: 'extend_video',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      resolution: { width: 1152, height: 2048 },
      call: { id: 'call1', type: 'function', function: { name: 'extend_video', arguments: '{}' } },
      plan: {
        prompt: 'The video ends with a cut to a distant staircase climbing through clouds.',
        stage: 'draft',
        parameters: { width: 1152, height: 2048, frames: 129, fps: 24, seed: 5936987926593958, overlap_frames: 9 },
        editable: { prompt: true, stages: [], parameters: [{ key: 'frames', type: 'integer', value: 129 }], references: [[]] },
        references: [{ input: 'source', role: 'source_video', as: 'source', resource_id: '5126b40d', label: '#ref1 · view.mp4', roleLabel: 'Vidéo à prolonger' }],
        loras: [],
      },
    };
  const said = [];
  const page = await studioPage(
    { create_video: [create], extend_video: [extend] },
    {},
    { runs: [], cursor: said, targets: true, resource: id => (id === view.id ? view : null) },
  );
  const { body, studio, restore } = page;
  try {
    const answer = studio.propose(structuredClone(request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.equal(body.dataset.mode, 'video');
    // The clip continued is named, and on the screen: it is not a take of the Sortie. (0.6.198) A video
    // without a number of take: « Suite de la vidéo » (« Suite du clip » before). (0.6.207) On its piece, the
    // first of the plateau, and in the window of that piece.
    assert.deepEqual(prolonged(body), ['À prolonger · view.mp4']);
    assert.equal(prolongWindow(body).about, 'Suite de la vidéo : view.mp4');
    const shown = screenOf(body.find('studio-frame-result')[0]);
    assert.deepEqual([shown.tag, shown.src, shown.poster], ['video', '/media/view/original', '/media/view/preview']);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    // Not the cases of a new video (« Début », « Fin », « Sujet »), which have nothing to do with it.
    // (0.6.201) Read from the words under the pieces: the blocks have no title any more.
    const titles = body.find('studio-piece-word').map(title => title.textContent);
    assert.equal(titles.some(title => title === 'Début' || title === 'Fin'), false, titles.join(' | '));
    assert.equal(titles.some(title => title.startsWith('Sujet')), false, titles.join(' | '));
    // Nor an empty case for « the video to follow »: the clip continued is its one piece, it is not asked again.
    assert.deepEqual(body.find('studio-slot').map(tile => tile.dataset.slot), ['source-0'], titles.join(' | '));
    assert.deepEqual(titles, ['À prolonger']);
    assert.equal(page.prompt().value, request.plan.prompt);
    // (0.6.113) A continuation the user did not want (« modifie cette prise », 19/11): no format to
    // choose in it, and no way out but « Refuser ». « Nouvelle vidéo », (0.6.207) at the foot of the window
    // of the clip, refuses it and leaves its prompt for a new video, whose format is the user's to set.
    // No « Retirer » nor × there: its clip is that of Moodix AI.
    assert.deepEqual(body.find('studio-formats'), [], 'a continuation has the format of its clip');
    assert.deepEqual([prolongWindow(body).ways, body.find('studio-prolong')[0].find('studio-slot-remove').length], [['Nouvelle vidéo'], 0]);
    const way = prolongWindow(body).way('Nouvelle vidéo');
    assert.match(way.title, /garder son prompt et ses images pour une nouvelle vidéo/);
    way.onclick();
    assert.equal(await answer, 'deny');
    assert.deepEqual(prolonged(body), []);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer');
    assert.equal(page.prompt().value, request.plan.prompt, 'its prompt stays');
    assert.equal(body.find('studio-formats').length, 1, 'the format can be chosen again');
    assert.equal(studio.proposing(), false);
  } finally {
    restore();
  }
});

test('a proposal without images shows empty cases: an image left there by the user is not part of what will be made', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  // The same proposal, with no image at all.
  const request = structuredClone(recorded.request);
  request.plan.references = [];
  request.plan.editable.references = [];
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  const filled = () => body.find('studio-slot').filter(tile => tile.className.includes('is-filled')).map(tile => tile.dataset.slot);
  try {
    // The user had put the take of the project as a start image, by hand.
    page.mode(1);
    const event = { preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [], types: [], setData() {} } };
    body.find('studio-item')[0].find('studio-item-pick')[0].ondragstart(event);
    body.find('studio-slot')[0].ondrop(event);
    assert.equal(filled().length, 1);
    const answer = studio.propose(request, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual(filled(), [], 'nothing shown that the proposal does not use');
    assert.equal(said.some(word => word.startsWith('pose ')), false);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a clip of the disk is continued with the model chosen in the Studio, which is said to the server', async () => {
  const roles = { source: { count: 1, media: ['video'], many: false, required: true }, reference: { count: 0, media: [], many: true } },
    lengths = { seconds: [4, 5, 6], standard: 5 },
    base = { limits: sizes, size: { width: 768, height: 448 }, seeded: true, settings: [], lengths },
    create = [
      { ...base, id: 'h3', name: 'MiniMax H3 Omni', verb: 'create_video', roles: {} },
      { ...base, id: 'ltx', name: 'LTX 2.5', verb: 'create_video', roles: {} },
    ],
    extend = create.map(model => ({ ...model, verb: 'extend_video', roles }));
  const page = await studioPage(
    { create_video: create, extend_video: extend },
    {
      'tools/actions': () => ({ extend_video: ['video'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs: [], project: () => 'p1' },
  );
  const { body, asked, restore } = page;
  try {
    // A video of the computer dropped on the screen: kept as a reference of the project.
    const film = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisomiso2'), Buffer.from([0, 0, 0, 12]), Buffer.from('mdat'), Buffer.alloc(4)]);
    page.mode(1);
    body.find('studio-stage')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [new File([film], 'view.mp4', { type: 'video/mp4' })], types: ['Files'] } });
    await settle();
    assert.equal(screenOf(body.find('studio-frame-result')[0]).src, '/preview/view.mp4');
    // « Prolonger », on the bar of the screen.
    await settle();
    const extendIt = body.find('output-action-extend')[0];
    assert.ok(extendIt, 'the action is offered for a clip of the disk');
    extendIt.onclick();
    assert.deepEqual(prolonged(body), ['À prolonger · view.mp4']);
    assert.equal(prolongWindow(body).about, 'Suite de la vidéo : view.mp4');
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    // No model made this clip: the list of the models that can continue one, to choose from.
    const [model] = body.find('studio-model-pick');
    assert.ok(model, 'the model is chosen');
    model.value = 'ltx';
    model.onchange();
    page.prompt().value = 'La caméra recule et découvre la vallée.';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.equal(action.name, 'extend_video');
    assert.deepEqual(action.arguments.source, { resource: 'r1' });
    assert.equal(action.arguments.workflow, 'ltx', 'the model chosen, not the first of the list');
  } finally {
    restore();
  }
  // A clip made here keeps the model that made it: not chosen, not named (the server knows it).
  const made = { id: 'c', mediaType: 'video', workflowId: 'ltx', prompt: 'un renard', outputs: [{ originalUrl: '/c.mp4', thumbUrl: '/c.jpg' }] };
  const own = await studioPage(
    { create_video: create, extend_video: extend },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [made] },
  );
  try {
    own.body.find('studio-item')[0].find('studio-item-main')[0].onclick();
    assert.equal(prolonged(own.body).length, 1);
    assert.equal(own.body.find('studio-model-pick').length, 0);
    own.prompt().value = 'Il saute.';
    own.prompt().oninput();
    await own.body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = own.asked.findLast(([route]) => route === 'tools/action');
    assert.deepEqual([action.arguments.source, action.arguments.workflow], [{ output: 'c' }, undefined]);
  } finally {
    own.restore();
  }
});

test('what a proposal of Moodix AI says of itself is read in the Studio, at the head of its column, while it waits', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  const request = structuredClone(recorded.request),
    note = '#ref2 n’est pas transmise : LTX 2.5 ne prend pas d’image pour la suite d’une vidéo. Le générateur ne la verra pas, seul le prompt peut la décrire.';
  request.notes = [note, 'Durée ajoutée : 10 s → 8 s, la plus proche que LTX 2.5 permet.'];
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  const notes = () => body.find('studio-proposal-note').map(line => line.textContent);
  try {
    assert.deepEqual(notes(), [], 'nothing to say without a proposal');
    const answer = studio.propose(request, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual(notes(), request.notes);
    // In the column of the inputs, before the prompt: read without scrolling it.
    const [write] = body.find('studio-write')[0].find('studio-block-body'),
      at = name => write.children.findIndex(child => String(child.className).includes(name));
    assert.ok(at('studio-proposal-note') >= 0 && at('studio-proposal-note') < at('studio-prompt-field'), 'above the prompt');
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.deepEqual(notes(), [], 'gone with the proposal');
  } finally {
    restore();
  }
});

/**
 * What the head of the screen says of a proposal (studio-explain.mjs): who, then what (its non-breaking
 * spaces read as spaces); null without one.
 */
const explained = body => {
  const [line] = body.find('studio-screen-head')[0]?.find('studio-explain') ?? [];
  return line
    ? [line.find('studio-explain-who')[0].textContent, line.find('studio-explain-said')[0].textContent.replace(/ /g, ' ')]
    : null;
};

test('what Moodix AI understood is said at the top of the screen, in its words, from the first step of its pointer to the answer (0.6.95)', async () => {
  // In the Chat its words come over the card; in the Studio the settings moved under a long prompt,
  // and nothing said what was meant unless the chat of the Agent was opened again.
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [],
    heads = [];
  // An image model too: the Studio opens in Image with its screen, before « passe en Vidéo ».
  tools.create_image = [{ id: 'k', name: 'Krea 2', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] }];
  let page = null;
  // At each word of the pointer, what the head of the screen said then.
  Object.defineProperty(said, 'push', {
    value(label) {
      heads.push(page ? explained(page.body) : null);
      return Array.prototype.push.call(this, label);
    },
  });
  page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    assert.equal(explained(body), null, 'nothing to say without a proposal');
    let answer = studio.propose(structuredClone(recorded.request), new AbortController().signal, { said: recorded.content });
    await until(() => said.includes('attend votre accord'));
    assert.equal(said.length, 7);
    assert.deepEqual(new Set(heads.map(head => JSON.stringify(head))), new Set([JSON.stringify(['Moodix AI', recorded.content])]), 'at every step');
    assert.deepEqual(explained(body), ['Moodix AI', recorded.content]);
    // As French sets them: « Dites « / Générer » » never cut at the guillemet, nor « : » alone on a line.
    assert.match(body.find('studio-explain-said')[0].textContent, /Studio : LTX 2\.5.*« Générer »/);
    // In the place of « Moodix AI règle le Studio »: the step of a generation is said there too.
    assert.equal(body.find('studio-ai-line').length, 0);
    assert.equal(body.find('studio-progress')[0].hidden, true);
    // Refused: it goes with the proposal.
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(explained(body), null);

    // Another proposal says its own words; a word of Markdown is read as plain text.
    answer = studio.propose(structuredClone(recorded.request), new AbortController().signal, {
      said: '**Plan fixe** de 6 s :\n\n- la neige tombe ;\n- elle lève la tête.',
    });
    await until(() => said.filter(label => label === 'attend votre accord').length === 2);
    assert.deepEqual(explained(body), ['Moodix AI', 'Plan fixe de 6 s : la neige tombe ; elle lève la tête.']);
    // Its words cut on their two lines: the round arrow shows them whole there, and folds them again.
    const [line] = body.find('studio-explain-text'),
      [more] = body.find('studio-explain-more');
    assert.equal(more.hidden, true, 'nothing cut, no arrow');
    Object.assign(line, { scrollHeight: 120, clientHeight: 38 });
    studio.render();
    assert.equal(more.hidden, false);
    assert.equal(more.attributes['aria-expanded'], 'false');
    assert.equal(more.attributes['aria-label'], 'Lire toute l’explication');
    more.onclick();
    assert.equal(more.attributes['aria-expanded'], 'true');
    assert.equal(more.attributes['aria-label'], 'Replier l’explication');
    // Drawn again (each step of the pointer draws the Studio), it stays unfolded: the same line.
    studio.render();
    assert.equal(body.find('studio-explain-more')[0], more);
    assert.equal(more.attributes['aria-expanded'], 'true');
    // « Générer »: it goes as the creation begins; the step of the take and its time (0.6.93) are said
    // in its place, never beside it.
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(explained(body), null);
    const [step] = body.find('studio-progress');
    assert.equal(step.hidden, false);
    assert.equal(step.find('studio-elapsed').length, 1);
  } finally {
    restore();
  }
});

test('when Moodix AI wrote nothing the Studio says the proposal in a sentence of its own, from the proposal (0.6.95)', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [];
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    // (The local model often calls its tool without a word: nothing is asked of it for this.)
    const answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual(explained(body), ['Proposition', 'Une vidéo de 6 secondes en 9:16 avec LTX 2.5, qui part de la prise 1.']);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
  // The sentence of each kind of proposal: its length, its format, its model, what it starts from.
  const { proposalSentence, plainWords } = await import('../public/studio-explain.mjs');
  const take = (n, role, more = {}) => ({ label: 'Prise ' + n, role, ...more });
  const video = (references, parameters = { width: 768, height: 448, frames: 121, fps: 24 }) => ({
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    plan: { parameters, references },
  });
  assert.equal(
    proposalSentence(video([take(2, 'start_image'), take(3, 'end_image'), { label: '#ref1', role: 'msr_image' }])),
    'Une vidéo de 5 secondes en 16:9 avec LTX 2.5, qui part de la prise 2 et finit sur la prise 3, avec #ref1 comme sujet.',
  );
  assert.equal(
    proposalSentence(video([take(4, 'end_image'), take(5, 'msr_image'), take(6, 'msr_image')])),
    'Une vidéo de 5 secondes en 16:9 avec LTX 2.5, qui finit sur la prise 4, avec la prise 5 et la prise 6 comme sujets.',
  );
  // A continuation: what it adds, its frames less those it takes again from the clip.
  assert.equal(
    proposalSentence({
      tool: 'extend_video',
      mediaType: 'video',
      workflowName: 'LTX 2.5',
      plan: { parameters: { width: 768, height: 448, frames: 105, fps: 24, overlap_frames: 9 }, references: [take(7, 'source_video')] },
    }),
    'La suite de la prise 7 : 4 secondes de plus avec LTX 2.5.',
  );
  assert.equal(
    proposalSentence({
      tool: 'replace_character',
      mediaType: 'video',
      workflowName: 'Wan 2.1 SCAIL-2',
      plan: {
        parameters: { width: 672, height: 672 },
        references: [take(8, 'driving_video', { as: 'source' }), take(9, 'reference_image', { as: 'reference' })],
      },
    }),
    'Le personnage de la prise 8 remplacé par celui de la prise 9, avec Wan 2.1 SCAIL-2.',
  );
  const image = { tool: 'create_image', workflowName: 'Krea 2', resolution: { width: 1024, height: 1024 } };
  assert.equal(proposalSentence(image), 'Une image en 1:1 avec Krea 2.');
  assert.equal(
    proposalSentence({ ...image, plan: { references: [{ label: 'Image 1', role: 'img2img', as: 'source' }] } }),
    'Une image en 1:1 avec Krea 2, qui modifie l’image jointe.',
  );
  assert.equal(proposalSentence({ ...image, series: { index: 2, total: 5 } }), 'Une image en 1:1 avec Krea 2 (image 2 sur 5).');
  assert.equal(
    proposalSentence({ ...image, resolution: { width: 448, height: 768 } }, { purpose: 'character' }),
    'L’image du personnage en 9:16 avec Krea 2 : vous la verrez avant le remplacement.',
  );
  assert.equal(
    proposalSentence({ tool: 'create_audio', mediaType: 'audio', workflowName: 'Bruitages', plan: { parameters: { seconds: 1 } } }),
    'Un son de 1 seconde avec Bruitages.',
  );
  // What is not known is left out rather than guessed.
  assert.equal(proposalSentence({ tool: 'create_video', mediaType: 'video' }), 'Une vidéo.');
  assert.equal(plainWords('## Le plan\n\n1. **Début** : `neige`\n2. [la fin](https://x)'), 'Le plan Début : neige la fin');
});

test('the empty screen says how to begin, but not while Moodix AI sets the Studio nor while its proposal waits (0.6.101)', async () => {
  // It said « laissez Moodix AI régler le Studio avec la moitié droite du bouton » as it did so. (0.6.253,
  // generer-maquette.md, A00) It says how to begin no more at all, nor where the take comes: the format and the size
  // to come, alone, in place. A hint is now a line of the empty screen other than that one.
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [],
    hints = [];
  let page = null;
  // (0.6.200) What is shown of it: its lines are drawn hidden, and shown again in place (sayBlank).
  const shownHints = () =>
    page
      ? page.body
          .find('studio-blank')
          .flatMap(blank => blank.children)
          .filter(line => line.className !== 'studio-blank-size' && !line.hidden).length
      : null;
  Object.defineProperty(said, 'push', {
    value(label) {
      hints.push(shownHints());
      return Array.prototype.push.call(this, label);
    },
  });
  // (0.6.200) Whether the empty screen says where the take comes, each time the pointer types a letter of the prompt.
  const typed = [],
    target = () => ({
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 40, height: 40 }),
      scrollIntoView() {},
      style: { setProperty() {} },
      classList: { toggle() {} },
      querySelector: () => null,
      setAttribute() {},
    }),
    querySelector = selector =>
      selector === '#studio-view [data-ai="prompt"]'
        ? Object.defineProperty(target(), 'value', { set: () => typed.push(page.body.find('studio-blank-size')[0] ?? null) })
        : target();
  page = await studioPage(tools, {}, { runs, cursor: said, querySelector });
  const { body, studio, restore } = page;
  const size = () => body.find('studio-blank-size').map(line => [line.textContent, line.hidden]);
  try {
    const answer = studio.propose(structuredClone(recorded.request), new AbortController().signal, { said: recorded.content });
    await until(() => said.includes('attend votre accord'));
    // (0.6.200) The Studio is not drawn again at each letter: (0.6.253) the same line of the size at each one.
    assert.deepEqual([typed.length > 1, typed[0] !== null, new Set(typed).size], [true, true, 1]);
    // At each step of the pointer, then while it waits: nothing more than the size (what is proposed is said at
    // the top of the screen).
    assert.deepEqual(hints, [0, 0, 0, 0, 0, 0, 0]);
    // (0.6.253) The format and the size Moodix AI set, under the prompt the pointer wrote: what will be made.
    assert.deepEqual(size(), [['9:16 · 448 × 768', false]]);
    studio.decline();
    assert.equal(await answer, 'deny');
    // The Studio the user's again, its prompt and its start image kept, then both taken away: the size alone.
    assert.deepEqual(shownHints(), 0);
    page.prompt().value = '';
    page.prompt().oninput();
    body.find('studio-slot-remove')[0].onclick();
    assert.deepEqual([shownHints(), size().length], [0, 1]);
  } finally {
    restore();
  }
});

test('(0.6.200) in a project without takes, how to begin is not said either while Moodix AI sets the Studio nor while its proposal waits', async () => {
  // (Above, a project with a take, where it is not said at all.) The proposal recorded, without the take it carries.
  const recorded = await recordedProposal(),
    { tools } = replayStudio(),
    request = structuredClone(recorded.request),
    call = JSON.parse(request.call.function.arguments),
    said = [],
    hints = [];
  delete call.start_image;
  delete request.plan.references;
  request.call.function.arguments = JSON.stringify(call);
  let page = null;
  // (0.6.253) How to begin is said no more (generer-maquette.md, A00): what the empty screen says, line by line.
  const shownHints = () =>
    page ? page.body.find('studio-blank').flatMap(blank => blank.children.filter(line => !line.hidden).map(line => line.textContent)) : null;
  Object.defineProperty(said, 'push', {
    value(label) {
      hints.push(shownHints());
      return Array.prototype.push.call(this, label);
    },
  });
  // The Studio opens on an image model, its screen empty: how to begin is said there.
  const image = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: {}, inputs: {}, limits: sizes, settings: [] };
  page = await studioPage({ create_image: [image], ...tools }, {}, { runs: [], cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    assert.deepEqual([body.dataset.mode, shownHints()], ['image', ['1:1 · 1024 × 1024']]);
    const answer = studio.propose(request, new AbortController().signal, { said: recorded.content });
    await until(() => said.includes('attend votre accord'));
    // At each step, the format and the size alone (those Moodix AI sets), no sentence.
    assert.ok(hints.length > 2 && hints.every(lines => lines.length === 1 && / × /.test(lines[0])), JSON.stringify(hints));
    // Refused, its prompt taken away: the format and the size of the Studio of the user.
    studio.decline();
    assert.equal(await answer, 'deny');
    page.prompt().value = '';
    page.prompt().oninput();
    // (In Vidéo, where the proposal was: what its bar « Résolution » shows.)
    const resolution = body.find('studio-bar-line').find(line => line.children[0].textContent === 'Résolution');
    assert.deepEqual([body.dataset.mode, shownHints()], ['video', ['9:16 · ' + resolution.children[2].textContent]]);
  } finally {
    restore();
  }
});

test('(0.6.200) the empty screen says where the take comes only while nothing is begun: the first one with how to begin, the next one alone; (0.6.253) the format and the size to come, alone, but over a clip continued, a sound, an error', async () => {
  // (Check of 21/11, overload, problem 1: the title, how to begin and « 16:9 · 512 × 288 » in 11 px stayed under a
  // prompt written, an image given, a clip continued, an error, over the wave of a sound.) Shown and taken away
  // in place: a key does not draw the Studio again.
  const image = {
      id: 'k',
      name: 'Krea 2',
      verb: 'create_image',
      direct: true,
      roles: { source: { count: 1, media: ['image'], many: false } },
      inputs: { img2img: 'source' },
      limits: sizes,
      size: { width: 1024, height: 1024 },
      settings: [],
      seeded: true,
    },
    // (A model without a case for it: what is put in its case for another is not given to this one.)
    plain = { ...image, id: 'p', name: 'Image simple', roles: {}, inputs: {} },
    sound = { id: 's', name: 'Bruitages', roles: {}, settings: [{ key: 'seconds', type: 'number', min: 1, max: 30, default: 10 }] },
    // (0.6.253, generer-maquette.md, A00) Every line of the empty screen: no sentence any more, the format and the
    // size to come, in mono (12 px, no longer 11), a prompt written or an image given; not under an error, over a
    // sound, over a clip continued.
    shown = body =>
      body
        .find('studio-blank')
        .flatMap(blank => blank.children)
        .filter(line => !line.hidden)
        .map(line => line.textContent),
    FIRST = ['1:1 · 1024 × 1024'];
  let page = await studioPage(
    { create_image: [image, plain], create_audio: [sound] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [] },
  );
  try {
    const { body } = page,
      type = words => {
        page.prompt().value = words;
        page.prompt().oninput();
      };
    // A project without takes, nothing written, nothing given: (0.6.253) the format and the size to come, alone.
    assert.deepEqual([shown(body), body.find('studio-blank-size').length], [FIRST, 1]);
    // A prompt written: the same, in place (the same screen, the same field, the same line), from the first key.
    const frame = body.find('studio-frame')[0],
      field = page.prompt(),
      line = body.find('studio-blank-size')[0];
    type('U');
    assert.deepEqual([shown(body), body.find('studio-blank-size')[0] === line], [FIRST, true]);
    type('');
    assert.deepEqual([shown(body), body.find('studio-frame')[0] === frame, page.prompt() === field], [FIRST, true, true]);
    // An image given to modify, another model, the image taken back: what will be made, each time.
    body.find('studio-slot')[0].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name: 'phare.png', type: 'image/png' }], setData() {} } });
    await settle();
    assert.deepEqual(shown(body), FIRST);
    const pick = model => {
      body.find('studio-model-pick')[0].value = model;
      body.find('studio-model-pick')[0].onchange();
    };
    pick('p');
    assert.deepEqual(shown(body), FIRST);
    pick('k');
    assert.deepEqual(shown(body), FIRST);
    body.find('studio-slot-remove')[0].onclick();
    assert.deepEqual(shown(body), FIRST);
    // A creation that failed: nothing while its reason is said under « Générer », its prompt taken away or not.
    type('Un phare');
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.equal(body.find('studio-error').length, 1);
    type('');
    assert.deepEqual(shown(body), []);
    // Son: over its wave, nothing.
    page.mode(2);
    assert.deepEqual([body.find('studio-bars').length, shown(body)], [1, []]);
  } finally {
    page.restore();
  }
  // A project with takes, in a conversation without any: (0.6.253) the size alone, « Votre prochaine prise » no more.
  // A clip of it continued (« Prolonger »), its prompt not written yet: nothing (its banner says what is made).
  const more = continuing();
  for (const record of more.runs) record.conversationId = 'c0';
  page = await studioPage(more.tools, {}, { runs: more.runs });
  try {
    assert.deepEqual(shown(page.body).map(said => / × /.test(said)), [true]);
    prolonger(page.body).onclick();
    assert.deepEqual(
      [page.body.dataset.mode, page.body.find('studio-frame')[0].className.includes('is-empty'), prolonged(page.body).length, shown(page.body)],
      ['video', true, 1, []],
    );
  } finally {
    page.restore();
  }
});

test('the label of the pointer of Moodix AI is whole in the window wherever it rests, and its new words are put back first where it is (0.6.101)', async () => {
  // It went to the left of the pointer at once, out of a window of 1280 px while the pointer left the
  // column of the prompt for the settings (it glides with it now, moodix.css: check-ui follows it).
  const { setupPointer } = await import('../public/studio-pointer.mjs');
  let words = '';
  const set = [],
    transitions = [],
    label = {
      // As wide as its words (about the width of the page's).
      get offsetWidth() {
        return 70 + 6 * words.length;
      },
      style: {
        set transition(value) {
          transitions.push(value);
        },
      },
    },
    text = {
      set textContent(value) {
        words = value;
      },
      closest: () => label,
    },
    cursor = {
      hidden: true,
      style: { setProperty: (name, value) => set.push([name, parseFloat(value), label.offsetWidth]) },
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: () => null,
    },
    host = { innerWidth: 1280, matchMedia: () => ({ matches: false }), requestAnimationFrame: run => run(), setTimeout };
  const pointer = setupPointer({ cursor, text, host }),
    at = x => ({ getBoundingClientRect: () => ({ left: x - 20, top: 300, width: 40, height: 40 }) });
  /** The edges of the label in the window each time its place is set: [left, right]. */
  const edges = () => {
    let x = null;
    return set.flatMap(([name, value, width]) => {
      if (name === '--ai-x') x = value;
      return name === '--ai-label-x' ? [[x + value, x + value + width]] : [];
    });
  };
  // The start of the prompt, the bar of the length at the right, the modes at the left edge, a word
  // long at the right edge: at its right where it holds, at its left where it does not.
  pointer.move(at(67), 'pose la prise 1 en début');
  pointer.move(at(1122), 'règle la durée');
  pointer.move(at(10), 'passe en Vidéo');
  pointer.move(at(1270), 'lance la génération (autorisé dans les Paramètres)');
  const placed = edges();
  assert.ok(placed.every(([left, right]) => left >= 8 && right <= 1272), JSON.stringify(placed));
  // Each new place (after the first) begins with its new words where the pointer is, at once (no
  // glide), then goes with it: the words of « règle la durée » first at the start of the prompt.
  assert.deepEqual(placed.slice(0, 3), [[89, 89 + 214], [89, 89 + 154], [950, 1104]]);
  assert.deepEqual(transitions, ['none', '', 'none', '', 'none', '']);
  // A window narrower than its words: their beginning stays in sight.
  host.innerWidth = 300;
  pointer.move(at(150), 'lance la génération (autorisé dans les Paramètres)');
  assert.equal(edges().at(-1)[0], 8);
});

test('the prompt of a proposal is folded under what Moodix AI understood while it is set and waits; its arrow shows it whole (0.6.95)', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    said = [],
    folds = [];
  let page = null;
  Object.defineProperty(said, 'push', {
    value(label) {
      const [field] = page?.body.find('studio-prompt-field') ?? [];
      folds.push(Boolean(field && field.className.split(' ').includes('is-folded')));
      return Array.prototype.push.call(this, label);
    },
  });
  page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  const field = () => body.find('studio-prompt-field')[0],
    folded = () => Boolean(field()?.className.split(' ').includes('is-folded'));
  try {
    assert.equal(body.find('studio-prompt-more').length, 0);
    let answer = studio.propose(structuredClone(recorded.request), new AbortController().signal, { said: recorded.content });
    await until(() => said.includes('attend votre accord'));
    // Folded from the moment the Studio shows the mode of the proposal (« passe en Vidéo » first).
    assert.deepEqual(folds, [false, true, true, true, true, true, true]);
    assert.equal(folded(), true);
    assert.equal(page.prompt().value, recorded.request.plan.prompt, 'the prompt is all there, folded');
    // Its arrow shows it whole; drawn again, it stays so; the arrow, turned up, folds it again.
    const more = () => body.find('studio-prompt-more')[0];
    assert.equal(more().attributes['aria-label'], 'Voir tout le prompt');
    more().onclick();
    assert.equal(folded(), false);
    assert.equal(more().attributes['aria-label'], 'Replier le prompt');
    studio.render();
    assert.equal(folded(), false);
    more().onclick();
    assert.equal(folded(), true);
    // A click in it to write shows it whole at once, without drawing it again (its focus stays).
    const box = page.prompt();
    box.onfocus();
    studio.render();
    assert.equal(folded(), false);
    // Refused: the prompt as it always was, without its arrow.
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(folded(), false);
    assert.equal(body.find('studio-prompt-more').length, 0);
    // A new proposal is folded again.
    answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await until(() => said.filter(label => label === 'attend votre accord').length === 2);
    assert.equal(folded(), true);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(folded(), false, 'its creation begun: as it always was');
  } finally {
    restore();
  }
});

/** An image model, a video model and what continues a clip, with a clip and an image of the conversation. */
function continuing({ more = true } = {}) {
  const image = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    clip = {
      id: 'v',
      name: 'LTX 2.5',
      verb: 'create_video',
      seeded: true,
      roles: { start_image: { count: 1, media: ['image'] } },
      limits: sizes,
      size: { width: 768, height: 448 },
      lengths: { seconds: [121 / 24, 193 / 24, 241 / 24], standard: 121 / 24 },
      settings: [],
    },
    // What it adds to a clip: its frames less those it takes again (9).
    extend = { ...clip, verb: 'extend_video', roles: { source: { count: 1, media: ['video'], required: true } }, lengths: { seconds: [112 / 24, 184 / 24, 232 / 24], standard: 112 / 24 } },
    runs = [
      // The newest of the conversation is an image: the Studio opens in Image.
      { id: 'fox', conversationId: 'c1', workflowId: 'k', prompt: 'un renard', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 2 }] },
      { id: 'film', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'un renard court', parameters: { width: 1344, height: 768, frames: 121, fps: 24 }, outputs: [{ originalUrl: '/film.mp4', thumbUrl: '/film.jpg', take: 1 }] },
    ];
  return { tools: { create_image: [image], create_video: [clip], ...(more ? { extend_video: [extend] } : {}) }, runs };
}
const prolonger = (body, id = 'film') => body.find('studio-item').find(tile => tile.dataset.id === id).find('studio-item-main')[0];
/**
 * (0.6.207, captures 98 and 98b) The clip a continuation goes on from, the first piece of its plateau: what its
 * case says (« À prolonger · PRISE 1 · 05.04 S »), none out of a continuation. A banner above the prompt before.
 */
const prolonged = body => body.find('studio-prolong').map(piece => piece.find('studio-slot-pick')[0].title);
/** Its window, opened by a click on its case when it is not: what it continues, the buttons of its foot. */
const prolongWindow = body => {
  const [piece] = body.find('studio-prolong');
  if (!piece.find('studio-piece-window').length) piece.find('studio-slot-pick')[0].onclick();
  const [pane] = body.find('studio-prolong')[0].find('studio-piece-window');
  return {
    pane,
    about: pane.find('studio-window-about')[0]?.textContent ?? null,
    way: name => pane.find('studio-window-button').find(way => way.children[0].textContent === name),
    ways: pane.find('studio-window-button').map(way => way.children[0].textContent),
  };
};

test('« Prolonger » on a clip of the Sortie opens Vidéo with its clip as the first piece, « À prolonger » (0.6.207), from Image too; greyed with its reason when nothing continues a video', async () => {
  const { tools, runs } = continuing();
  let page = await studioPage(
    tools,
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs },
  );
  try {
    const { body, asked } = page;
    // In Image, the Sortie shows the whole project: the clip is there with its « Prolonger ».
    assert.equal(body.dataset.mode, 'image');
    assert.equal(prolonger(body).attributes['aria-disabled'], undefined);
    prolonger(body).onclick();
    // A continuation is made in Vidéo, no format to choose. (0.6.207, captures 98 and 98b) No banner above the
    // prompt any more: its clip is the first piece of the plateau, in the place of the start of a new video,
    // the length it adds on its line of time, no « ⇄ ». (0.6.198) The clip by the number of its take.
    assert.equal(body.dataset.mode, 'video');
    assert.deepEqual([body.find('studio-extending'), prolonged(body)], [[], ['À prolonger · PRISE 1 · 05.04 S']]);
    const [frames] = body.find('studio-frames'),
      [piece] = body.find('studio-prolong');
    assert.deepEqual(
      [frames.attributes['aria-label'], frames.children.map(part => part.className.split(' ').slice(0, 2).join(' ')), body.find('studio-swap').length],
      ['Vidéo à prolonger', ['studio-piece studio-prolong', 'studio-span'], 0],
    );
    assert.equal(body.find('studio-span-time')[0].textContent, '04.67 S');
    const [tile, word] = piece.children,
      [pick] = piece.find('studio-slot-pick');
    assert.deepEqual(
      [tile.className, tile.dataset.slot, tile.dataset.media, tile.ondrop, word.textContent, word.attributes['aria-hidden']],
      ['studio-slot is-filled', 'source-0', undefined, undefined, 'À prolonger', 'true'],
    );
    assert.deepEqual(
      [pick.attributes['aria-label'], pick.attributes['aria-haspopup'], pick.attributes['aria-expanded'], pick.children[0].src, pick.find('studio-slot-badge')[0].children[0].glyph],
      ['À prolonger · PRISE 1 · 05.04 S', 'dialog', 'false', '/film.jpg', 'forward'],
    );
    // Its window: what it continues, in the words of its banner of before; what it is; « Retirer », no
    // « Changer… » (no file is chosen for the clip of a continuation).
    const opened = prolongWindow(body);
    assert.deepEqual(
      [opened.pane.attributes['aria-label'], opened.pane.children.map(part => part.className), opened.about, opened.ways],
      ['À prolonger', ['studio-window-title', 'studio-window-about', 'studio-window-foot'], 'Suite de la prise 1 : un renard court', ['Retirer']],
    );
    assert.equal(opened.pane.find('studio-window-said')[0].textContent, 'PRISE 1 · 05.04 S');
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer la suite');
    // « Retirer » leaves the continuation, as « Annuler » of the banner did; so does the × of its case.
    opened.way('Retirer').onclick();
    assert.deepEqual([prolonged(body), body.find('studio-go-label')[0].textContent, body.find('studio-piece-window').length], [[], 'Générer', 0]);
    page.mode(0);
    prolonger(body).onclick();
    assert.equal(prolonged(body).length, 1);
    body.find('studio-prolong')[0].find('studio-slot-remove')[0].onclick();
    assert.deepEqual([prolonged(body), body.find('studio-go-label')[0].textContent], [[], 'Générer']);
    page.mode(0);
    prolonger(body).onclick();
    page.prompt().value = 'il s’arrête';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.find(([route]) => route === 'tools/action');
    assert.equal(action.name, 'extend_video');
    assert.deepEqual(action.arguments.source, { output: 'film' });
    // Image is as it was: its formats, « Générer ».
    page.mode(0);
    assert.equal(body.find('studio-formats').length, 1);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer');
    assert.deepEqual(prolonged(body), []);
  } finally {
    page.restore();
  }
  // No workflow continues a video: « Prolonger » is greyed and says why; pressed, the Studio stays.
  const alone = continuing({ more: false });
  alone.runs.reverse();
  page = await studioPage(alone.tools, {}, { runs: alone.runs });
  try {
    const { body, notices } = page;
    assert.equal(body.dataset.mode, 'video');
    const main = prolonger(body);
    assert.equal(main.attributes['aria-disabled'], 'true');
    assert.match(main.className, /is-off/);
    assert.match(main.title, /Aucun modèle ne sait prolonger une vidéo\./);
    main.onclick();
    assert.equal(notices.at(-1), 'Aucun modèle ne sait prolonger une vidéo.');
    assert.equal(body.find('studio-go').length, 1, 'the Studio is still there');
    assert.equal(body.find('studio-item').length, 2);
    assert.deepEqual(prolonged(body), []);
    // In its menu too.
    body.find('studio-item').find(tile => tile.dataset.id === 'film').oncontextmenu({ preventDefault() {} });
    const entry = body.find('studio-menu-item').find(item => item.children.at(-1).textContent === 'Prolonger');
    assert.equal(entry.attributes['aria-disabled'], 'true');
    entry.onclick();
    assert.equal(body.find('studio-go').length, 1);
  } finally {
    page.restore();
  }
});

/** The continuation of the clip of `continuing()`, as Moodix AI proposes it: 193 frames, 9 of them taken again. */
function continuation() {
  const prompt = 'Le renard s’arrête et regarde la caméra';
  return {
    requestId: 'q',
    approvalToken: 't',
    tool: 'extend_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    resolution: { width: 1344, height: 768 },
    call: { id: 'call', type: 'function', function: { name: 'extend_video', arguments: '{}' } },
    plan: {
      prompt,
      stage: 'final',
      parameters: { prompt, width: 1344, height: 768, frames: 193, fps: 24, overlap_frames: 9, seed: 7 },
      editable: {
        prompt: true,
        stages: [],
        parameters: [
          { key: 'frames', type: 'integer', value: 193, choices: [121, 193, 241] },
          { key: 'width', type: 'integer', value: 1344, locked: 'Une continuation garde la taille de sa vidéo source.' },
          { key: 'height', type: 'integer', value: 768, locked: 'Une continuation garde la taille de sa vidéo source.' },
          { key: 'seed', type: 'integer', value: 7 },
        ],
        references: [[]],
      },
      references: [{ input: 'source', role: 'source_video', as: 'source', roleLabel: 'Vidéo à prolonger', label: 'Prise 1', output_id: 'film' }],
    },
  };
}

test('(0.6.207) a continuation whose model takes an end image keeps that case at the end of its line; the pointer of Moodix AI sets what is read with its clip in the window of that clip', async () => {
  const said = [],
    { tools, runs } = continuing();
  // (As LTX 2.5 continues a clip: an end image it may take, the images taken again from its clip. A start image
  // named among its roles is none of a continuation: its clip is its start.)
  Object.assign(tools.extend_video[0], {
    inputs: { source_video: 'source' },
    roles: { ...tools.extend_video[0].roles, start_image: { count: 1, media: ['image'] }, end_image: { count: 1, media: ['image'] } },
    settings: [{ key: 'overlap_frames', type: 'integer', choices: [1, 9, 17], default: 9, onlyWith: { role: 'source_video' } }],
  });
  const page = await studioPage(tools, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    page.mode(1);
    prolonger(body).onclick();
    const [frames] = body.find('studio-frames');
    assert.deepEqual(
      [frames.attributes['aria-label'], frames.children.map(part => part.className.split(' ').slice(0, 2).join(' ')), body.find('studio-piece-word').map(word => word.textContent)],
      ['Vidéo à prolonger et fin', ['studio-piece studio-prolong', 'studio-span', 'studio-piece is-empty'], ['À prolonger', 'Fin']],
    );
    assert.deepEqual(body.find('studio-swap'), []);
    studio.render();
    // A proposal that sets « Images de chevauchement »: the window of « À prolonger » is opened for it and left
    // open, where the user sees the value.
    const proposal = continuation();
    proposal.plan.parameters.overlap_frames = 17;
    proposal.plan.editable.parameters.push({ key: 'overlap_frames', type: 'integer', value: 17, choices: [1, 9, 17] });
    const answer = studio.propose(proposal, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.ok(said.includes('règle images de chevauchement'), said.join(' | '));
    const opened = body.find('studio-prolong')[0].find('studio-piece-window');
    assert.deepEqual(
      [opened.map(pane => pane.attributes['aria-label']), opened[0]?.find('studio-field')[0].children[1].value, body.find('studio-more-pill')[0]?.attributes['aria-expanded'] ?? 'false'],
      [['À prolonger'], '17', 'false'],
    );
    studio.decline();
    assert.equal(await answer, 'deny');
    // In the page: what it continues in 13 px under the name of its window; the banner and its styles are gone.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
      code = await readFile(new URL('../public/studio.mjs', import.meta.url), 'utf8');
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('.studio-window-about'), /font: 400 13px\/1\.4 var\(--font-ui\);/);
    assert.match(rule("#studio-view .studio-piece-window :is(input[type='number'], button.glass-select)"), /height: 34px;/);
    assert.doesNotMatch(css, /\.studio-extending/);
    assert.doesNotMatch(code, /'studio-extending'/);
  } finally {
    restore();
  }
});

test('(0.6.251) après un changement de caméra fait ici, la barre de la taille dit le temps que cet ordinateur vient de mettre', async () => {
  // (Essai réel du 23/11 : la barre ne disait rien avant que le Studio soit rouvert, ses outils n'étant pas relus.)
  const { tools, runs } = continuing(),
    refilm = { made: [] },
    film = { id: 'r', name: 'Changer la caméra (LTX 2.5)', verb: 'refilm_video', family: 'ltx25_refilm', roles: { source: { count: 1, media: ['video'], required: true } }, settings: [], refilm },
    made = { id: 'again', conversationId: 'c1', mediaType: 'video', workflowId: 'r', prompt: 'un renard court', parameters: { width: 1024, height: 576, frames: 121, fps: 24, refilm: { camera: { azimuth: 30, elevation: 10, distance: 1 } } }, outputs: [{ originalUrl: '/again.mp4', thumbUrl: '/again.jpg', take: 5 }] },
    page = await studioPage(
      { ...tools, refilm_video: [film] },
      {
        'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
        // (The server keeps what the creation took: its next reading of the tools says it.)
        'tools/execute': () => (page.runs.unshift(made), refilm.made.push({ pixels: 1024 * 576, frames: 121, seconds: 272 }), { id: 'j', state: 'done', record: made }),
      },
      { runs },
    );
  const { body, asked } = page,
    second = () => body.find('studio-item').find(tile => tile.dataset.id === 'film').find('studio-item-second')[0],
    said = () => body.find('studio-refilm-said')[0],
    read = () => asked.filter(([route]) => route === 'studio').length;
  try {
    page.mode(1);
    second().onclick();
    await settle();
    // Never made here: nothing to say, and its tools are not read again for it.
    assert.deepEqual([said().hidden, read()], [true, 1]);
    page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
    await settle();
    assert.deepEqual([body.find('studio-refilm').length, read()], [0, 1]);
    // The camera of that clip changed again: its tools are read again, and the bar says what it took here.
    second().onclick();
    await settle();
    assert.deepEqual([read(), said().hidden, said().textContent, said().dataset.warn], [2, false, 'Environ 4 min 30 sur cet ordinateur.', 'false']);
    // (Read once: not again at each change of camera.)
    body.find('studio-orbit-window')[0].find('studio-window-foot')[0].children.at(-1).onclick();
    second().onclick();
    await settle();
    assert.equal(read(), 2);
  } finally {
    page.restore();
  }
});

test('(0.6.244) a continuation Moodix AI proposes of the clip whose camera was being changed is a continuation', async () => {
  // (Before: the clip stayed « À refilmer », its camera beside it, under a proposal that continues it.)
  const said = [],
    { tools, runs } = continuing(),
    film = { id: 'r', name: 'Changer la caméra (LTX 2.5)', verb: 'refilm_video', family: 'ltx25_refilm', roles: { source: { count: 1, media: ['video'], required: true } }, settings: [] };
  Object.assign(tools.extend_video[0], { inputs: { source_video: 'source' } });
  const page = await studioPage({ ...tools, refilm_video: [film] }, {}, { runs, cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    page.mode(1);
    body.find('studio-item').find(tile => tile.dataset.id === 'film').find('studio-item-second')[0].onclick();
    assert.deepEqual([body.find('studio-refilm').length, body.find('studio-go-label')[0].textContent], [1, 'Changer la caméra']);
    const answer = studio.propose(continuation(), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.deepEqual([body.find('studio-refilm').length, body.find('studio-orbit').length, body.find('studio-guide').length, prolonged(body).length], [0, 0, 0, 1]);
    assert.match(prolonged(body)[0], /^À prolonger · /);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a continuation proposed by Moodix AI stays one while it waits: another mode visited, « Prolonger » on another clip, « Revenir »', async () => {
  const { tools, runs } = continuing();
  runs.push({ id: 'other', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'une mouette', parameters: { width: 768, height: 448, frames: 121, fps: 24 }, outputs: [{ originalUrl: '/other.mp4', thumbUrl: '/other.jpg', take: 0 }] });
  const sent = [];
  const page = await studioPage(tools, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) }, { runs });
  const { body, studio, notices, restore } = page;
  const shown = () => ({
    banner: prolonged(body)[0] ?? null,
    go: body.find('studio-go-label')[0].textContent,
    formats: body.find('studio-formats').length,
    duration: body.find('studio-bar').find(bar => bar.dataset.ai === 'duration')?.attributes['aria-valuetext'],
  });
  try {
    // The image of the conversation is looked at first: « Revenir » is offered.
    studio.show(runs[0]);
    assert.equal(body.find('studio-look-back').length, 1);
    const answer = studio.propose(continuation(), new AbortController().signal);
    const proposed = { banner: 'À prolonger · PRISE 1 · 05.04 S', go: 'Générer la suite', formats: 0, duration: '07.67 S' };
    // (0.6.204: until the pointer has set it all and given the Studio back, not a fixed 15 ms: with the whole
    // suite running beside it, its length was not always set yet, once in three runs.)
    await until(() => shown().duration === proposed.duration && page.page['studio-view'].inert === false);
    await settle();
    assert.deepEqual(shown(), proposed);
    // The other modes still work by hand: the user looks at Image, then comes back.
    page.mode(0);
    assert.deepEqual(prolonged(body), []);
    // No way back to the settings of before while it waits: they would come under the proposal.
    assert.deepEqual(body.find('studio-look-back'), []);
    page.mode(1);
    assert.deepEqual(shown(), proposed, 'still the continuation of its clip');
    assert.equal(body.find('studio-decline').length, 1);
    // « Prolonger » on another clip is held, and says why.
    const other = prolonger(body, 'other');
    assert.equal(other.attributes['aria-disabled'], 'true');
    other.onclick();
    assert.equal(notices.at(-1), 'Moodix AI est en train de proposer');
    assert.deepEqual(shown(), proposed);
    // Nothing touched: nothing is sent as a change of the user.
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(sent, []);
    await studio.settled({ record: null });
    // Answered: the way back is offered again.
    assert.equal(body.find('studio-look-back').length, 1);
  } finally {
    restore();
  }
});

test('the images of a proposal change role as the server offers, said by its own names; answered, they are the user’s and move freely', async () => {
  const recorded = await recordedProposal(),
    { tools, runs } = replayStudio(),
    sent = [];
  const page = await studioPage(tools, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) }, { runs });
  const { body, studio, restore } = page;
  const event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
    drag = (from, to) => {
      body.find('studio-slot')[from].children[0].ondragstart(event([]));
      body.find('studio-slot')[to].ondrop(event([]));
    },
    shown = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null),
    error = () => body.find('studio-error')[0]?.textContent ?? null,
    // The pointer has set the whole proposal (several short waits, which a busy machine stretches:
    // « Générer » pressed before its end sent the size the Studio had as a change of the user).
    rested = async () => {
      for (let turn = 0; turn < 8; turn++) await settle();
    };
  try {
    // The fixture lists the roles as the server does (lib/tool-runtime.mjs, referenceRoles): by the
    // names of the slots of the family, « msr_image » for a reference of LTX 2.5.
    assert.deepEqual(
      recorded.request.plan.editable.references[0].map(choice => choice.role),
      ['start_image', 'end_image', 'msr_image'],
    );
    let answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await rested();
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    // To « Sujet »: a role the server offers, under its own name.
    drag(0, 2);
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, null, '/portrait.webp', null]);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    // Said to the server by the name it gave that role.
    assert.deepEqual(sent, [{ references: [{ index: 0, role: 'msr_image' }] }]);
    await studio.settled({ record: null });
    // Answered: the image is the user's, it goes where they put it.
    drag(2, 0);
    assert.equal(error(), null);
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    body.find('studio-swap')[0].onclick();
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, '/portrait.webp', null]);
    // Declined instead: the same.
    answer = studio.propose(structuredClone(recorded.request), new AbortController().signal);
    await rested();
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    studio.decline();
    assert.equal(await answer, 'deny');
    body.find('studio-swap')[0].onclick();
    assert.equal(error(), null);
    assert.deepEqual(shown(), [null, '/portrait.webp', null]);
    // While a proposal waits, a role the server does not offer its image stays refused.
    const narrow = structuredClone(recorded.request);
    narrow.plan.editable.references = [[{ role: 'start_image', label: 'Image de début' }]];
    answer = studio.propose(narrow, new AbortController().signal);
    await rested();
    drag(0, 1);
    assert.equal(error(), 'Image de fin : ce rôle n’est pas possible pour cette image avec ce modèle.');
    assert.deepEqual(shown(), ['/portrait.webp', null, null]);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
});

test('a proposal that starts from an image joined to the message shows it in its slot; answered, nothing without a source is left to send', async () => {
  const { tools } = continuing();
  const page = await studioPage(
    tools,
    { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [] },
  );
  const { body, studio, asked, restore } = page;
  const prompt = 'La mer monte';
  // As lib/tool-runtime.mjs resolves an image joined to the message: neither a take nor a reference.
  const joined = () => ({
    requestId: 'q',
    approvalToken: 't',
    tool: 'create_video',
    mediaType: 'video',
    workflowName: 'LTX 2.5',
    resolution: { width: 768, height: 448 },
    call: { id: 'call', type: 'function', function: { name: 'create_video', arguments: '{}' } },
    plan: {
      prompt,
      parameters: { prompt, width: 768, height: 448, frames: 121, fps: 24, seed: 7 },
      editable: { prompt: true, parameters: [], references: [[{ role: 'start_image', label: 'Image de début' }]] },
      references: [
        { input: 'start', image: 0, attachment: 'a1b2.png', original: true, label: 'Image 1', role: 'start_image', as: 'start_image', roleLabel: 'Image de début', preview: '/media/attachments/c1/a1b2.png' },
      ],
    },
  });
  const tile = () => body.find('studio-slot')[0];
  try {
    let answer = studio.propose(joined(), new AbortController().signal);
    await settle();
    // Its picture, the one the server gives for the card of the proposal.
    assert.match(tile().className, /is-filled/);
    assert.equal(tile().children[0].children[0].src, '/media/attachments/c1/a1b2.png');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    await studio.settled({ record: null });
    // Answered: the Studio cannot name that image (no take, no reference): its slot is empty again.
    assert.doesNotMatch(tile().className, /is-filled/);
    page.prompt().value = 'La mer monte encore';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    const [, action] = asked.findLast(([route]) => route === 'tools/action');
    assert.equal('start_image' in action.arguments, false, 'no input without a source is sent');
    // Refused instead: the same.
    answer = studio.propose(joined(), new AbortController().signal);
    await settle();
    assert.match(tile().className, /is-filled/);
    studio.decline();
    assert.equal(await answer, 'deny');
    assert.doesNotMatch(tile().className, /is-filled/);
  } finally {
    restore();
  }
});

test('on a proposal, the size chosen is what is made: its format and its size go with « final » when it is one', async () => {
  const sent = [];
  // As the server answers (lib/tool-runtime.mjs, revise): another version keeps the format of the
  // size given with it and takes the size of its own profile; a size alone is taken as it is.
  const revise = ({ edits }) => {
    sent.push(edits);
    const size = !edits.stage
      ? { width: edits.width, height: edits.height }
      : edits.width < edits.height
        ? { width: 768, height: 1344 }
        : { width: 1344, height: 768 };
    return { requestId: 'q' + sent.length, approvalToken: 't' + sent.length, plan: { stage: edits.stage ?? 'draft', parameters: size } };
  };
  const { clip } = proposalOf();
  const page = await studioPage({ create_video: [clip] }, { 'tools/revise': revise });
  const { body, studio, restore } = page;
  const size = () => body.find('studio-bar').find(bar => bar.dataset.ai === 'size'),
    choose = place => {
      const bar = size();
      bar.value = String(place);
      bar.oninput();
    },
    proposed = async () => {
      const { request } = proposalOf(),
        answer = studio.propose(request, new AbortController().signal);
      await settle();
      assert.equal(size().attributes['aria-valuetext'], '768 × 448');
      return { request, answer };
    },
    generated = async ({ request, answer }) => {
      await body.find('studio-go')[0].onclick();
      assert.equal(await answer, 'once');
      await studio.settled({ record: null });
      return [sent.splice(0), request.requestId];
    };
  try {
    // A smaller draft: its size, nothing else.
    let waiting = await proposed();
    choose(0);
    assert.deepEqual(await generated(waiting), [[{ width: 512, height: 288 }], 'q1']);
    // Another format and a size that is a final: both go with « final », and the server gives them.
    waiting = await proposed();
    body.find('studio-format').find(chip => chip.children.at(-1)?.textContent === '9:16').onclick();
    choose(3);
    assert.equal(size().attributes['aria-valuetext'], '768 × 1344');
    assert.deepEqual(await generated(waiting), [[{ width: 768, height: 1344, stage: 'final' }], 'q1']);
    // A final larger than its profile: the server answers with the size of the profile, the size
    // chosen is asked again alone, and what is generated is that last proposal.
    waiting = await proposed();
    choose(5);
    assert.equal(size().attributes['aria-valuetext'], '1920 × 1088');
    assert.deepEqual(await generated(waiting), [
      [
        { width: 1920, height: 1088, stage: 'final' },
        { width: 1920, height: 1088 },
      ],
      'q2',
    ]);
  } finally {
    restore();
  }
});

test('what comes back late is not written elsewhere: a prompt improved for a conversation left, a file imported once another mode is shown', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', direct: true, roles: { source: { count: 1, media: ['image'] } }, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    scail = {
      id: 's',
      name: 'SCAIL-2',
      verb: 'replace_character',
      follows: true,
      roles: { source: { count: 1, media: ['video'], required: true }, reference: { count: 1, media: ['image'], required: true } },
      settings: [],
    },
    runs = [
      { id: 't2', conversationId: 'c2', workflowId: 'k', prompt: 'la prise de la conversation 2', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/t2.png', thumbUrl: '/t2.jpg', take: 1 }] },
    ];
  let conversation = 'c1',
    answer = null;
  const page = await studioPage(
    { create_image: [krea], replace_character: [scail] },
    {
      'studio/enrich': () => new Promise(resolve => (answer = resolve)),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
    },
    { runs, conversation: () => conversation },
  );
  const { body, studio, notices, asked, restore } = page;
  const event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files, setData() {} } }),
    slots = () => body.find('studio-slot').map(tile => [tile.dataset.slot, tile.children[0].children[0]?.src ?? null]);
  try {
    // « Enrichir le prompt » in the first conversation; the chat model takes its time.
    page.prompt().value = 'un chat roux';
    page.prompt().oninput();
    void body.find('studio-enrich-go')[0].onclick();
    await settle();
    assert.equal(typeof answer, 'function');
    // Meanwhile the second conversation is opened: its Studio is set at once, as its last take was made.
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'la prise de la conversation 2');
    answer({ prompt: 'Un chat roux assis sur un mur de pierre, lumière dorée.' });
    await settle();
    // The answer is for the conversation left: nothing of it here, and it is said.
    assert.equal(page.prompt().value, 'la prise de la conversation 2');
    assert.deepEqual(body.find('studio-enrich')[0].find('studio-link'), [], 'no « Revenir à mon texte » either');
    assert.equal(notices.at(-1), 'Prompt non enrichi : la conversation ou le mode a changé entre-temps.');
    assert.equal(studio.busy(), false);
    // The first conversation comes back as it was left.
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un chat roux');
    // Asked and answered in the same conversation and mode: written, as before.
    void body.find('studio-enrich-go')[0].onclick();
    await settle();
    answer({ prompt: 'Un chat roux, de près.' });
    await settle();
    assert.equal(page.prompt().value, 'Un chat roux, de près.');

    // A clip given to « Vidéo à suivre »; before its copy ends, the user is in Image, where a slot
    // has the same name (the image to modify).
    page.mode(1);
    assert.deepEqual(slots(), [['source-0', null], ['reference-0', null]]);
    body.find('studio-slot')[0].ondrop(event([{ name: 'danse.mp4', type: 'video/mp4' }]));
    page.mode(0);
    await settle();
    assert.deepEqual(slots(), [['source-0', null]], 'not the image to modify');
    assert.match(notices.at(-1), /^Vidéo gardée dans les références du projet, mais pas placée/);
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.equal('source' in asked.findLast(([route]) => route === 'tools/action')[1].arguments, false);
    // Nor in another conversation.
    body.find('studio-slot')[0].ondrop(event([{ name: 'a.png', type: 'image/png' }]));
    conversation = 'c2';
    studio.conversationChanged();
    await settle();
    assert.deepEqual(slots(), [['source-0', null]]);
    // Given and copied with nothing changed meanwhile: in its slot.
    body.find('studio-slot')[0].ondrop(event([{ name: 'b.png', type: 'image/png' }]));
    await settle();
    assert.deepEqual(slots(), [['source-0', '/preview/b.png']]);
  } finally {
    restore();
  }
});

test('a creation looked at leaves with its conversation: the Studio kept is the one of before, its seed does not follow; a sound of the disk gives its address back with its place on the screen', async () => {
  let conversation = 'c1';
  const runs = lookRuns();
  const page = await studioPage(lookModels(), lookRoutes, { runs, project: () => 'p1', conversation: () => conversation });
  const { body, studio, restore } = page;
  const back = () => body.find('studio-look-back').length,
    seed = () => body.find('studio-seed')[0].children[1].value;
  try {
    page.mode(1);
    page.prompt().value = 'mon idée de vidéo';
    page.prompt().oninput();
    assert.equal(seed(), '');
    // The clip of another conversation is looked at: its settings and its very seed, a way back.
    studio.show(runs[0]);
    assert.equal(page.prompt().value, 'un renard court dans la neige');
    assert.equal(seed(), '777');
    assert.equal(back(), 1);
    // A conversation not begun, in the same project: the look is over, nothing of it follows.
    conversation = null;
    studio.conversationChanged();
    await settle();
    assert.equal(back(), 0);
    assert.equal(page.prompt().value, '');
    assert.equal(seed(), '', 'the seed of a take only looked at is not the one of the next takes');
    // The conversation left comes back as it was before the look.
    conversation = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'mon idée de vidéo');
    assert.equal(seed(), '');
    assert.equal(back(), 0);
    // The same when the page says « another conversation » for the one in hand (renamed in the fil).
    studio.show(runs[0]);
    assert.equal(back(), 1);
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'mon idée de vidéo');
    assert.equal(seed(), '');
    assert.equal(back(), 0);
    assert.deepEqual(body.find('studio-frame-result'), [], 'the clip looked at left the screen');
  } finally {
    restore();
  }
  // A sound of the disk on the screen plays from an address made for it.
  const made = { id: 'new', conversationId: 'c1', workflowId: 'k', prompt: 'un phare', parameters: { width: 1024, height: 1024 }, outputs: [{ originalUrl: '/new.png', thumbUrl: '/new.jpg', take: 4 }] };
  const sounds = await studioPage(
    lookModels(),
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => (sounds.runs.unshift(made), { id: 'j', state: 'done', record: made }),
    },
    { runs: [] },
  );
  const given = [],
    urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let count = 0;
  URL.createObjectURL = () => 'blob:son' + ++count;
  URL.revokeObjectURL = address => given.push(address);
  try {
    const drop = async name => {
        dropOn(sounds, { files: [new File([Buffer.from('RIFF\x24\0\0\0WAVEfmt ', 'latin1')], name, { type: 'audio/wav' })], types: ['Files'] });
        await settle();
      },
      onScreen = () => sounds.body.find('studio-frame-result').map(shown => shown.src);
    await drop('pluie.wav');
    assert.equal(sounds.body.dataset.mode, 'audio');
    assert.deepEqual(onScreen(), ['blob:son1']);
    // Another one in its place: the address of the first is given back.
    await drop('vent.wav');
    assert.deepEqual(onScreen(), ['blob:son2']);
    assert.deepEqual(given, ['blob:son1']);
    // A take made in Image ends the look: the sound leaves the screen of Son with its address.
    sounds.mode(0);
    sounds.prompt().value = 'un phare';
    sounds.prompt().oninput();
    await sounds.body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual(onScreen(), ['/new.png']);
    assert.deepEqual(given, ['blob:son1', 'blob:son2']);
    sounds.mode(2);
    assert.deepEqual(onScreen(), [], 'no player left on an address given back');
  } finally {
    Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
    sounds.restore();
  }
});

test('a proposal made with a model of another family shelves the LoRAs of the family left; they come back with their model', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', family: 'krea2', styled: true, seeded: true, direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    moss = { ...krea, id: 'm', name: 'MOSS Image', family: 'moss' };
  const page = await studioPage(
    { create_image: [krea, moss] },
    { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
  );
  const { body, studio, asked, restore } = page;
  const loras = () => body.find('studio-lora-pick').map(pick => pick.value),
    byHand = async () => {
      await body.find('studio-go')[0].onclick();
      await settle();
      const [, action] = asked.findLast(([route]) => route === 'tools/action');
      return [action.arguments.workflow, action.styles ?? []];
    };
  try {
    // A LoRA made for Krea 2, added by hand.
    body.find('studio-lora-plus')[0].onclick();
    assert.deepEqual(loras(), ['a.safetensors']);
    // Moodix AI proposes an image with MOSS Image.
    const answer = studio.propose(
      {
        requestId: 'q',
        approvalToken: 't',
        tool: 'create_image',
        workflowName: 'MOSS Image',
        resolution: { width: 1024, height: 1024 },
        call: { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{}' } },
        plan: { prompt: 'un phare', parameters: { prompt: 'un phare', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
      },
      new AbortController().signal,
    );
    await settle();
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    await studio.settled({ record: null });
    // The Studio stays on MOSS Image, without the LoRA of the other family: none goes with it.
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    assert.deepEqual(loras(), []);
    assert.deepEqual(await byHand(), ['m', []]);
    // Krea 2 chosen again: its LoRA is back.
    const pick = body.find('studio-model-pick')[0];
    pick.value = 'k';
    pick.onchange();
    assert.deepEqual(loras(), ['a.safetensors']);
    assert.deepEqual(await byHand(), ['k', [{ name: 'a.safetensors', strength: 1 }]]);
  } finally {
    restore();
  }
});

test('a proposal whose model has a fixed length keeps it: the length left by another model is no change of the user', async () => {
  const { clip, request } = proposalOf({ frames: 241 });
  // Its length is « Fixe » in Configuration › Workflows: no list of lengths, no bar; the server
  // still lists `frames` among what the user may change on the card (editableParameters).
  const fixed = { ...clip, id: 'b', lengths: undefined },
    free = { ...clip, id: 'a', name: 'Libre' };
  const sent = [];
  const page = await studioPage({ create_video: [free, fixed] }, { 'tools/revise': ({ edits }) => (sent.push(edits), { requestId: 'q2', approvalToken: 't2' }) });
  const { body, studio, restore } = page;
  const duration = () => body.find('studio-bar').filter(bar => bar.dataset.ai === 'duration');
  try {
    // Vidéo was shown with the other model: its length (05.04 S) is in the draft.
    page.mode(1);
    assert.equal(duration()[0].attributes['aria-valuetext'], '05.04 S');
    const answer = studio.propose(request, new AbortController().signal);
    await settle();
    assert.equal(body.find('studio-model-pick')[0].value, 'b');
    assert.deepEqual(duration(), [], 'no length to set');
    // Nothing touched: nothing is sent, the 241 frames proposed are made.
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(sent, []);
  } finally {
    restore();
  }
});

test('while a character waits for its check, « Générer » from another mode is no answer: the question comes back', async () => {
  const { tools } = continuing(),
    runs = [{ id: 'made', conversationId: 'c1', workflowId: 'k', prompt: 'A full-length photo of a player', parameters: {}, outputs: [{ originalUrl: '/made.png', thumbUrl: '/made.jpg' }] }];
  const page = await studioPage(tools, { 'tools/action': () => ({ requestId: 'h', plan: { parameters: {} } }) }, { runs });
  const { body, studio, notices, asked, restore } = page;
  try {
    let answered = null;
    const check = studio.checkCharacter(runs[0], new AbortController().signal);
    void check.then(answer => (answered = answer));
    await settle();
    assert.equal(body.find('studio-check-question').length, 1);
    // The user goes to Vidéo: no question there, the button reads « Générer ».
    page.mode(1);
    assert.equal(body.find('studio-check-question').length, 0);
    assert.equal(body.find('studio-go-label')[0].textContent, 'Générer');
    page.prompt().value = 'une mouette au-dessus du port';
    page.prompt().oninput();
    await body.find('studio-go')[0].onclick();
    await settle();
    // Not taken for « OK », and nothing generated: the question is back, in Image.
    assert.equal(answered, null);
    assert.equal(asked.filter(([route]) => route === 'tools/action').length, 0);
    assert.equal(body.dataset.mode, 'image');
    assert.equal(body.find('studio-check-question').length, 1);
    assert.equal(notices.at(-1), 'Ce personnage vous convient ? Répondez d’abord : OK, Autre image ou Annuler.');
    // There, « OK » (the same button) keeps the character.
    await body.find('studio-go')[0].onclick();
    assert.deepEqual((await check).decision, 'ok');
  } finally {
    restore();
  }
});

test('« Modifier » chooses a model that takes an image when the one in hand takes none; held while Moodix AI proposes an image', async () => {
  const moss = { id: 'm', name: 'MOSS Image', verb: 'create_image', family: 'moss', direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    krea = { ...moss, id: 'k', name: 'Krea 2', family: 'krea2', roles: { source: { count: 1, media: ['image'] } } },
    runs = [{ id: 'fox', conversationId: 'c1', workflowId: 'x', prompt: 'un renard', parameters: {}, outputs: [{ originalUrl: '/fox.png', thumbUrl: '/fox.jpg', take: 3 }] }];
  const page = await studioPage({ create_image: [moss, krea] }, {}, { runs });
  const { body, studio, notices, restore } = page;
  const modify = () => {
      body.find('studio-item')[0].oncontextmenu({ preventDefault() {} });
      return body.find('studio-menu-item').find(item => item.children.at(-1).textContent === 'Modifier');
    },
    slots = () => body.find('studio-slot').map(tile => tile.children[0].children[0]?.src ?? null);
  try {
    // MOSS Image is in hand: it takes no image. Krea 2 does.
    assert.equal(body.find('studio-model-pick')[0].value, 'm');
    assert.deepEqual(slots(), []);
    modify().onclick();
    // The model that takes it is chosen, the image is in its slot.
    assert.equal(body.find('studio-model-pick')[0].value, 'k');
    assert.deepEqual(slots(), ['/fox.jpg']);
    // While Moodix AI proposes an image, the slots are those of its proposal: held, and said.
    const answer = studio.propose(
      {
        requestId: 'q',
        approvalToken: 't',
        tool: 'create_image',
        workflowName: 'Krea 2',
        resolution: { width: 1024, height: 1024 },
        call: { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{}' } },
        plan: { prompt: 'un phare', parameters: { prompt: 'un phare', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
      },
      new AbortController().signal,
    );
    await settle();
    assert.deepEqual(slots(), [null], 'the slots of the proposal: it has no image');
    const held = modify();
    assert.equal(held.attributes['aria-disabled'], 'true');
    held.onclick();
    assert.equal(notices.at(-1), 'Moodix AI est en train de proposer');
    assert.deepEqual(slots(), [null]);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
  // No model takes an image to modify: « Modifier » is not offered.
  const alone = await studioPage({ create_image: [moss] }, {}, { runs });
  try {
    alone.body.find('studio-item')[0].oncontextmenu({ preventDefault() {} });
    assert.deepEqual(
      alone.body.find('studio-menu-item').map(item => item.children.at(-1).textContent),
      ['Ouvrir', 'Supprimer'],
    );
  } finally {
    alone.restore();
  }
});

test('the LoRAs of the user show on a proposal of Moodix AI and go with « Générer »; with none in the Studio, none is sent', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', family: 'krea2', styled: true, seeded: true, direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    sent = [];
  const page = await studioPage(
    { create_image: [krea] },
    {
      'tools/revise': ({ edits }) => (
        sent.push(edits), { requestId: 'q' + sent.length, approvalToken: 't' + sent.length, ...(edits.styles?.length ? { styles: edits.styles } : {}) }
      ),
    },
  );
  const { body, studio, restore } = page;
  const loras = () => body.find('studio-lora-pick').map(pick => pick.value),
    proposed = id =>
      studio.propose(
        {
          requestId: id,
          approvalToken: 't-' + id,
          tool: 'create_image',
          workflowName: 'Krea 2',
          resolution: { width: 1024, height: 1024 },
          call: { id: 'call-' + id, type: 'function', function: { name: 'create_image', arguments: '{}' } },
          plan: { prompt: 'un phare', parameters: { prompt: 'un phare', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
        },
        new AbortController().signal,
      );
  try {
    // A LoRA the user added by hand, then Moodix AI proposes an image with the same model.
    body.find('studio-lora-plus')[0].onclick();
    const first = proposed('a');
    await settle();
    // It shows on the proposal (it was hidden there, and the image was made without it).
    assert.deepEqual(loras(), ['a.safetensors']);
    await body.find('studio-go')[0].onclick();
    assert.equal(await first, 'once');
    assert.deepEqual(sent, [{ styles: [{ name: 'a.safetensors', strength: 1 }] }]);
    await studio.settled({ record: null });
    // Taken out on the next proposal: nothing to say to the server, which has none for it.
    const second = proposed('b');
    await settle();
    assert.deepEqual(loras(), ['a.safetensors']);
    body.find('studio-lora-drop')[0].onclick();
    assert.deepEqual(loras(), []);
    await body.find('studio-go')[0].onclick();
    assert.equal(await second, 'once');
    assert.equal(sent.length, 1, 'no LoRA in the Studio: nothing revised');
  } finally {
    restore();
  }
});

test('an image of a series the user asked for goes by itself in the Studio, the setting off; the pointer says which', async () => {
  const krea = { id: 'k', name: 'Krea 2', verb: 'create_image', family: 'krea2', seeded: true, direct: true, roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] };
  const said = [];
  const page = await studioPage({ create_image: [krea] }, {}, { runs: [], cursor: said, targets: true });
  const { studio, restore } = page;
  try {
    const answer = studio.propose(
      {
        requestId: 'q2',
        approvalToken: 't',
        tool: 'create_image',
        workflowName: 'Krea 2',
        // Marked so by the server for every image of a series (lib/tool-runtime.mjs, beginSeries).
        autoAllow: true,
        series: { id: 's', index: 2, total: 3 },
        resolution: { width: 1024, height: 1024 },
        call: { id: 'call', type: 'function', function: { name: 'create_image', arguments: '{}' } },
        plan: { prompt: 'a whale', parameters: { prompt: 'a whale', width: 1024, height: 1024, seed: 3 }, editable: { prompt: true, parameters: [] }, references: [] },
      },
      new AbortController().signal,
    );
    // No « Générer » to press: it starts once set.
    assert.equal(await answer, 'once');
    assert.ok(said.includes('lance l’image 2 sur 3 demandée'), said.join(' | '));
    assert.equal(said.includes('attend votre accord'), false);
  } finally {
    restore();
  }
});

/**
 * Krea 2 as the Studio is told of it (lib/tool-catalog.mjs, studio): its denoise left to the
 * assistant between 0.6 and 0.7, read by the model only with an image to modify.
 */
const kreaWithDenoise = () => ({
  id: 'k',
  name: 'Krea 2',
  verb: 'create_image',
  family: 'krea2',
  seeded: true,
  direct: true,
  styled: true,
  roles: { source: { count: 1, media: ['image'], many: false } },
  inputs: { img2img: 'source' },
  limits: sizes,
  size: { width: 1024, height: 1024 },
  settings: [{ key: 'denoise', type: 'number', min: 0.6, max: 0.7, default: 0.6, onlyWith: { role: 'img2img', otherwise: 1 } }],
  loras: [],
});
const denoiseBar = body => body.find('studio-bar').find(bar => bar.dataset.ai === 'setting-denoise');
/**
 * « Débruitage » as the Studio shows it: its value, whether it answers, what its tip says (under the
 * pointer and on the focus: no line under it any more, 0.6.92), read by screen readers too.
 * (0.6.205, capture 99) It lives in the window of the image to modify, opened here by a click on its case
 * when it is not, and nowhere else: null while no image is given (not read, so not shown; it was greyed
 * under « Plus de réglages », « Sert seulement avec une image à modifier. »).
 */
const denoiseShown = body => {
  assert.deepEqual(
    body.find('studio-rare').flatMap(rare => rare.find('studio-fine')),
    [],
    'never under « Plus de réglages »',
  );
  if (!/is-filled/.test(body.find('studio-slot')[0]?.className ?? '')) {
    assert.deepEqual([body.find('studio-fine').length, denoiseBar(body)], [0, undefined], 'no bar without its image');
    return null;
  }
  if (!body.find('studio-piece-window').length) body.find('studio-slot-pick')[0].onclick();
  const [line] = body.find('studio-piece-window')[0].find('studio-fine'),
    tip = line.find('studio-bar-line')[0].title;
  assert.deepEqual(line.find('studio-fine-note'), [], 'no line under the bar');
  assert.equal(line.find('sr-only')[0]?.textContent, tip, 'what its tip says, for screen readers');
  assert.doesNotMatch(line.className, /is-idle/);
  return [denoiseBar(body).attributes['aria-valuetext'], !denoiseBar(body).disabled, tip];
};
/** The bar moved to `place` (its hundredths from 0,60), its window opened for it. */
const setDenoise = (body, place) => {
  denoiseShown(body);
  denoiseBar(body).value = String(place);
  denoiseBar(body).oninput();
};
const DENOISE_HELP = '0,6 garde la composition et change l’ambiance ; 0,7 laisse la composition changer.';
const pasteImage = async (body, name = 'a.png') => {
  body.find('studio-write')[0].onpaste({ clipboardData: { files: [{ name, type: 'image/png' }] }, preventDefault() {} });
  await settle();
};
const handRoutes = {
  'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
  'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }),
};

test('« Débruitage » of Krea 2 in the window of the image to modify (0.6.205): nowhere while no image is given, live with one, sent by hand only then', async () => {
  const page = await studioPage({ create_image: [kreaWithDenoise()] }, handRoutes);
  const { body, asked, restore } = page;
  const sent = async () => {
    await body.find('studio-go')[0].onclick();
    await settle();
    return asked.findLast(([route]) => route === 'tools/action')[1].arguments;
  };
  try {
    page.prompt().value = 'un escalier la nuit';
    page.prompt().oninput();
    body.find('studio-more-pill')[0].onclick();
    // No image to modify: the engine does not read it, the Studio does not show it (a setting is shown where
    // it is read): no bar, under « Plus de réglages » or elsewhere, and nothing says « Sert seulement… ».
    assert.equal(denoiseShown(body), null);
    assert.deepEqual(body.find('studio-rare')[0].find('is-idle'), []);
    let args = await sent();
    assert.deepEqual([args.source, args.denoise], [undefined, undefined]);
    // An image put in « image à modifier »: its window has the bar, from 0,60 to 0,70 by hundredths, which
    // says what its ends do in its tip; no mark of what Moodix AI may set (0.6.92).
    await pasteImage(body);
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    assert.deepEqual(denoiseShown(body), ['0,60', true, DENOISE_HELP]);
    const [pane] = body.find('studio-piece-window');
    assert.deepEqual(pane.children.map(part => part.className), ['studio-window-title', 'studio-fine', 'studio-window-foot']);
    // Its help beside the window (as the reason of a greyed choice of a list): above the bar, it covered the
    // name of the window.
    assert.equal(pane.find('studio-bar-line')[0].dataset.tipSide, 'right');
    assert.equal(pane.find('studio-bar-label')[0].textContent, 'Débruitage');
    assert.deepEqual(body.find('ai-mark'), []);
    assert.deepEqual([denoiseBar(body).min, denoiseBar(body).max], ['0', '10']);
    // Left as it is, the workflow's own value is used: nothing to send. Moved, it goes with « Générer ».
    args = await sent();
    assert.deepEqual([args.source, args.denoise], [{ resource: 'r1' }, undefined]);
    setDenoise(body, 5);
    assert.deepEqual(denoiseShown(body), ['0,65', true, DENOISE_HELP]);
    args = await sent();
    assert.deepEqual([args.source, args.denoise], [{ resource: 'r1' }, 0.65]);
    setDenoise(body, 10);
    assert.equal((await sent()).denoise, 0.7);
    // The image taken back: no bar any more, its value kept, and no longer sent.
    body.find('studio-slot-remove')[0].onclick();
    assert.equal(denoiseShown(body), null);
    args = await sent();
    assert.deepEqual([args.source, args.denoise], [undefined, undefined]);
    await pasteImage(body, 'b.png');
    assert.deepEqual(denoiseShown(body), ['0,70', true, DENOISE_HELP]);
    assert.equal((await sent()).denoise, 0.7);
  } finally {
    restore();
  }
});

test('a decimal setting between two close bounds is a bar; a wider one, or one fixed in its workflow, is not', async () => {
  const krea = kreaWithDenoise();
  // (A workflow of the user's: the denoise fixed there is no setting of the Studio at all.)
  const fixed = { ...kreaWithDenoise(), id: 'f', name: 'Krea fixe', settings: [{ key: 'steps', type: 'number', min: 1, max: 50, default: 8 }] };
  const { body, restore } = await studioPage({ create_image: [krea, fixed] });
  try {
    body.find('studio-more-pill')[0].onclick();
    // (0.6.205: the denoise is read with the image to modify, its bar is in the window of that image.)
    await pasteImage(body);
    assert.deepEqual(denoiseShown(body), ['0,60', true, DENOISE_HELP]);
    assert.equal(body.find('studio-fine').length, 1);
    const pick = body.find('studio-model-pick')[0];
    pick.value = 'f';
    pick.onchange();
    // (Its window stays open: this model takes the image too, with nothing to set with it.)
    assert.deepEqual([body.find('studio-piece-window').length, body.find('studio-fine').length], [1, 0]);
    assert.equal(denoiseBar(body), undefined);
    assert.equal(body.find('studio-rare')[0].find('studio-field').length, 1, 'its steps, in their field as before');
    // Its name alone, without the mark of Moodix AI (0.6.92).
    assert.deepEqual(body.find('studio-rare')[0].find('studio-label')[0].children, []);
  } finally {
    restore();
  }
});

test('(0.6.205) a setting the engine reads with one piece alone is set in the window of that piece; one read with two, or with none, stays under « Plus de réglages »', async () => {
  // (Capture 109, his answer 7 of 21/11: « Influence de l’image de fin » in the window of the end of LTX 2.5; that
  // of the start by symmetry. « Compression des images (CRF) » is read with either: it stays where it was.)
  const image = { count: 1, media: ['image'] },
    ltx = {
      id: 'l',
      name: 'LTX 2.5',
      family: 'ltx25',
      seeded: true,
      limits: sizes,
      size: { width: 768, height: 448 },
      lengths: { seconds: [121 / 24], standard: 121 / 24 },
      roles: { start_image: image, end_image: image },
      settings: [
        { key: 'start_strength', type: 'number', min: 0, max: 1, default: 1, onlyWith: { role: 'start_image' } },
        { key: 'end_strength', type: 'number', min: 0, max: 1, default: 1, onlyWith: { role: 'end_image' } },
        { key: 'image_compression', type: 'integer', min: 0, max: 51, default: 33, onlyWith: { roles: ['start_image', 'end_image'] } },
        // (Read with a clip to continue, which a new video has not: no piece of this model, it stays here.)
        { key: 'overlap_frames', type: 'integer', choices: [1, 9, 17], default: 9, onlyWith: { role: 'source_video' } },
        // (A bar read with either image: under « Plus de réglages » too, greyed there while neither is given.)
        { key: 'blend', type: 'number', min: 0, max: 1, default: 0.5, onlyWith: { roles: ['start_image', 'end_image'] } },
        { key: 'steps', type: 'integer', min: 1, max: 50, default: 8 },
      ],
    };
  const page = await studioPage({ create_video: [ltx] }, handRoutes);
  const { body, asked, restore } = page;
  try {
    page.mode(1);
    body.find('studio-more-pill')[0].onclick();
    // Each line of « Plus de réglages » by its name, and whether it is greyed.
    const rare = () => body.find('studio-rare')[0].children.map(line => [(line.find('studio-bar-label')[0] ?? line.find('studio-label')[0]).textContent, /is-idle/.test(line.className)]),
      pane = () => body.find('studio-piece-window')[0],
      bars = () => (pane()?.find('studio-fine') ?? []).map(line => [line.find('studio-bar-label')[0].textContent, line.find('studio-bar')[0].dataset.ai, line.find('studio-bar')[0].attributes['aria-valuetext']]),
      drop = async (index, name) => {
        body.find('studio-slot')[index].ondrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [{ name }], setData() {} } });
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      sent = async () => {
        await body.find('studio-go')[0].onclick();
        await settle();
        return asked.findLast(([route]) => route === 'tools/action')[1].arguments;
      };
    page.prompt().value = 'Un phare';
    page.prompt().oninput();
    // Nothing given: the two influences are nowhere; the compression, read with a start or an end, is greyed.
    assert.deepEqual(rare(), [['Seed', false], ['Compression des images (CRF)', true], ['Images de chevauchement', true], ['blend', true], ['Étapes', false]]);
    // (Its reason above its line, as every tip of the column: only a bar in a window says it beside the window.)
    const [greyed] = body.find('studio-rare')[0].find('studio-bar-line');
    assert.deepEqual([greyed.title, greyed.dataset.tipSide], ['Sert seulement avec l’entrée « Image de début » ou « Image de fin ».', undefined]);
    assert.deepEqual(body.find('studio-fine').length, 1);
    // The start given: its window has its influence, on a bar; the compression is read now.
    await drop(0, 'debut.png');
    body.find('studio-slot-pick')[0].onclick();
    assert.deepEqual([pane().attributes['aria-label'], bars()], ['Image de début', [['Influence de l’image de début', 'setting-start_strength', '1,00']]]);
    assert.deepEqual(pane().children.map(part => part.className), ['studio-window-title', 'studio-fine', 'studio-window-foot']);
    assert.deepEqual(rare(), [['Seed', false], ['Compression des images (CRF)', false], ['Images de chevauchement', true], ['blend', false], ['Étapes', false]]);
    // The end given: its own window, its own influence.
    await drop(1, 'fin.png');
    body.find('studio-slot-pick')[1].onclick();
    assert.deepEqual([pane().attributes['aria-label'], bars()], ['Image de fin', [['Influence de l’image de fin', 'setting-end_strength', '1,00']]]);
    // Moved, it goes with « Générer »; the start, left as it is, sends nothing of its own.
    const [bar] = pane().find('studio-bar');
    bar.value = '50';
    bar.oninput();
    let args = await sent();
    assert.deepEqual([args.end_strength, 'start_strength' in args, Boolean(args.end_image)], [0.5, false, true]);
    // The end taken back: its influence is no longer sent, nor shown anywhere.
    body.find('studio-slot')[1].find('studio-slot-remove')[0].onclick();
    args = await sent();
    assert.deepEqual(['end_strength' in args, 'end_image' in args, body.find('studio-piece-window').length], [false, false, 0]);
  } finally {
    restore();
  }
  // (0.6.207) In a continuation, what is read with its clip is set in the window of that clip, « À prolonger »,
  // no longer under « Plus de réglages ».
  const { tools, runs } = continuing();
  Object.assign(tools.extend_video[0], {
    inputs: { source_video: 'source' },
    settings: [{ key: 'overlap_frames', type: 'integer', choices: [1, 9, 17], default: 9, onlyWith: { role: 'source_video' } }],
  });
  const suite = await studioPage(tools, {}, { runs });
  try {
    suite.mode(1);
    prolonger(suite.body).onclick();
    assert.deepEqual(suite.body.find('studio-rare').flatMap(rare => rare.find('studio-field')), []);
    assert.deepEqual(
      prolongWindow(suite.body).pane.find('studio-field').map(line => [line.find('studio-label')[0].textContent, /is-idle/.test(line.className), line.children[1].value]),
      [['Images de chevauchement', false, '9']],
    );
  } finally {
    suite.restore();
  }
});

test('(0.6.205) a proposal of Moodix AI that sets a bar of « Plus de réglages » opens it; one set with a piece does not', async () => {
  const said = [],
    krea = kreaWithDenoise();
  krea.settings.push({ key: 'shift', type: 'number', min: 0, max: 1, default: 0.5 });
  const page = await studioPage({ create_image: [krea] }, {}, { runs: [], cursor: said, targets: true });
  const { body, studio, restore } = page;
  try {
    const proposal = kreaProposal({ denoise: 0.7 });
    proposal.plan.parameters.shift = 0.8;
    proposal.plan.editable.parameters.push({ key: 'shift', type: 'number', value: 0.8, min: 0, max: 1 });
    const answer = studio.propose(proposal, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    const shift = body.find('studio-bar').find(bar => bar.dataset.ai === 'setting-shift');
    assert.deepEqual(
      [body.find('studio-more-pill')[0].attributes['aria-expanded'], body.find('studio-rare')[0].hidden, shift.attributes['aria-valuetext']],
      ['true', false, '0,80'],
    );
    // (Its help above it, as every bar of the column: only a bar in a window says it beside the window.)
    assert.equal(body.find('studio-rare')[0].find('studio-bar-line')[0].dataset.tipSide, undefined);
    // « Débruitage » is not among them: in the window of its image, where the pointer set it first. (0.6.206)
    // One thing open at a time: that window closed for « Plus de réglages », the last one set.
    assert.deepEqual(body.find('studio-rare')[0].find('studio-bar').map(bar => bar.dataset.ai), ['setting-shift']);
    assert.deepEqual(body.find('studio-piece-window'), []);
    body.find('studio-slot-pick')[0].onclick();
    assert.deepEqual(
      [body.find('studio-piece-window').map(pane => pane.find('studio-bar')[0].attributes['aria-valuetext']), body.find('studio-rare')[0].hidden],
      [['0,70'], true],
    );
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    restore();
  }
  // The other way round (a model whose settings come in that order), the bar of « Plus de réglages » first,
  // then the one of the piece: that window is the one left open, « Plus de réglages » closed for it.
  const words = [],
    reversed = kreaWithDenoise();
  reversed.settings.unshift({ key: 'shift', type: 'number', min: 0, max: 1, default: 0.5 });
  const other = await studioPage({ create_image: [reversed] }, {}, { runs: [], cursor: words, targets: true });
  try {
    const proposal = kreaProposal({ denoise: 0.62 });
    proposal.plan.parameters.shift = 0.3;
    proposal.plan.editable.parameters.push({ key: 'shift', type: 'number', value: 0.3, min: 0, max: 1 });
    const answer = other.studio.propose(proposal, new AbortController().signal);
    await until(() => words.includes('attend votre accord'));
    const [first, then] = ['règle décalage (shift)', 'règle débruitage'].map(step => words.indexOf(step));
    assert.ok(first >= 0 && first < then, words.join(' | '));
    assert.deepEqual(
      [
        other.body.find('studio-piece-window').map(pane => pane.find('studio-bar')[0].attributes['aria-valuetext']),
        other.body.find('studio-rare')[0].hidden,
        other.body.find('studio-more-pill')[0].attributes['aria-expanded'],
      ],
      [['0,62'], true, 'false'],
    );
    other.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    other.restore();
  }
});

test('(0.6.206) « Plus de réglages » is a window: it closes at a press outside the Réglages and at Échap, one thing open at a time; the pointer of Moodix AI opens it for any of its settings', async () => {
  // (Captures 110 and 111. Under its pill, its lines made the column of the Réglages scroll.)
  const krea = kreaWithDenoise();
  krea.settings.push({ key: 'steps', type: 'integer', min: 1, max: 50, default: 8 });
  const page = await studioPage({ create_image: [krea] }, {});
  const { body, studio, pagePointers, pageKeys, restore } = page;
  try {
    const pill = () => body.find('studio-more-pill')[0],
      open = () => [!body.find('studio-more-window')[0].hidden, pill().attributes['aria-expanded']],
      press = target => {
        pagePointers.forEach(listener => listener({ target }));
        // (Closed without drawing the Studio again, a press being a click too: seen once it is drawn.)
        studio.render();
      },
      // (A key as the page hears it: once taken, `defaultPrevented` says so to those that hear it after.)
      key = (name, target = {}) => {
        const event = {
          key: name,
          target,
          taken: 0,
          defaultPrevented: false,
          preventDefault() {
            this.taken++;
            this.defaultPrevented = true;
          },
        };
        pageKeys.forEach(listener => listener(event));
        studio.render();
        return event.taken;
      };
    assert.deepEqual(open(), [false, 'false']);
    pill().onclick();
    assert.deepEqual(open(), [true, 'true']);
    // A press in the Réglages leaves it open (a format changed with it open, as when its lines were under its
    // pill); a press anywhere else closes it.
    press({ closest: selector => (selector === '.studio-block.is-settings' ? {} : null) });
    assert.deepEqual(open(), [true, 'true']);
    press({ closest: () => null });
    assert.deepEqual(open(), [false, 'false']);
    // Échap closes it and is taken; a list open in it takes Échap first, and so does « ··· » of the formats.
    pill().onclick();
    assert.equal(key('Escape', { closest: selector => (selector === '[role="listbox"]' ? {} : null) }), 0);
    assert.deepEqual(open(), [true, 'true']);
    // (One Échap closes one thing: the two were closed at once.)
    body.find('studio-format').find(chip => /is-more/.test(chip.className)).onclick();
    assert.equal(key('Escape'), 1, 'taken by « ··· », which closes alone');
    assert.deepEqual(open(), [true, 'true']);
    assert.equal(key('Escape'), 1);
    assert.deepEqual(open(), [false, 'false']);
    assert.equal(key('Escape'), 0, 'nothing open: left to the page');
    // One thing open at a time: the window of a piece closes for it, and it for the window of a piece or the
    // list « Ajouter ».
    await pasteImage(body);
    body.find('studio-slot-pick')[0].onclick();
    assert.equal(body.find('studio-piece-window').length, 1);
    pill().onclick();
    assert.deepEqual([open(), body.find('studio-piece-window').length], [[true, 'true'], 0]);
    body.find('studio-slot-pick')[0].onclick();
    assert.deepEqual([open(), body.find('studio-piece-window').length], [[false, 'false'], 1]);
    pill().onclick();
    body.find('studio-add-pick')[0].onclick();
    studio.render();
    assert.deepEqual([open(), body.find('studio-add')[0].children[2].hidden], [[false, 'false'], false]);
    pill().onclick();
    assert.deepEqual([open(), body.find('studio-add')[0].children[2].hidden], [[true, 'true'], true]);
    pill().onclick();
    assert.deepEqual(open(), [false, 'false']);
    // One Échap closes one thing for the window of a piece and for the list « Ajouter » too: « ··· » of the
    // formats, open with them, takes it first.
    const more = () => body.find('studio-format').find(chip => /is-more/.test(chip.className));
    body.find('studio-slot-pick')[0].onclick();
    more().onclick();
    assert.deepEqual([key('Escape'), body.find('studio-piece-window').length, more().attributes['aria-expanded']], [1, 1, 'false']);
    assert.deepEqual([key('Escape'), body.find('studio-piece-window').length], [1, 0]);
    body.find('studio-add-pick')[0].onclick();
    more().onclick();
    assert.deepEqual([key('Escape'), body.find('studio-add')[0].children[2].hidden, more().attributes['aria-expanded']], [1, false, 'false']);
    assert.deepEqual([key('Escape'), body.find('studio-add')[0].children[2].hidden], [1, true]);
    // In the page: 500 px wide, two columns, fields of 34 px, a long text over both.
    const { readFile } = await import('node:fs/promises');
    const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    const rule = selector => css.slice(css.lastIndexOf('\n' + selector + ' {'), css.indexOf('}', css.lastIndexOf('\n' + selector + ' {')));
    assert.match(rule('.glass-menu.studio-more-window'), /width: 500px;/);
    assert.match(rule('.studio-more-window .studio-rare'), /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/);
    assert.match(rule('.studio-more-window .studio-rare > .studio-field.is-wide'), /grid-column: 1 \/ -1;/);
    assert.match(rule("#studio-view .studio-more-window .studio-rare :is(input[type='number'], input[type='text'], button.glass-select)"), /height: 34px;/);
    assert.doesNotMatch(css, /\.studio-rare > \* \+ \*/);
  } finally {
    restore();
  }
  // A proposal that sets a field of it (« Étapes »): the window is opened for it, where the pointer goes and the
  // user sees the value (closed, the pointer went to a field that was not shown).
  const said = [],
    proposed = await studioPage({ create_image: [krea] }, {}, { runs: [], cursor: said, targets: true });
  try {
    const proposal = kreaProposal({ image: false });
    proposal.plan.parameters.steps = 12;
    proposal.plan.editable.parameters.push({ key: 'steps', type: 'integer', value: 12, min: 1, max: 50 });
    const answer = proposed.studio.propose(proposal, new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.ok(said.includes('règle étapes'), said.join(' | '));
    const steps = proposed.body.find('studio-rare')[0].find('studio-field').map(line => [line.find('studio-label')[0].textContent, line.children[1].value]);
    assert.deepEqual(
      [proposed.body.find('studio-more-window')[0].hidden, proposed.body.find('studio-more-pill')[0].attributes['aria-expanded'], steps],
      [false, 'true', [['Étapes', '12']]],
    );
    proposed.studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    proposed.restore();
  }
  // The length of a sound is on the bar of Durée, never among them (one rule for its lines and for the pointer).
  const sound = {
      id: 's',
      name: 'Bruitages',
      roles: {},
      seeded: true,
      settings: [
        { key: 'seconds', type: 'number', min: 1, max: 30, default: 10 },
        { key: 'steps', type: 'integer', min: 1, max: 50, default: 8 },
      ],
    },
    audio = await studioPage({ create_audio: [sound] }, {});
  try {
    audio.mode(2);
    audio.body.find('studio-more-pill')[0].onclick();
    assert.deepEqual(
      audio.body.find('studio-rare')[0].children.map(line => (line.find('studio-bar-label')[0] ?? line.find('studio-label')[0]).textContent),
      ['Seed', 'Étapes'],
    );
  } finally {
    audio.restore();
  }
});

test('no mark « Moodix AI peut régler ce paramètre » in the Studio, nor the line under « Débruitage », nor their styles (0.6.92)', async () => {
  const { readFile } = await import('node:fs/promises'),
    read = name => readFile(new URL('../public/' + name, import.meta.url), 'utf8'),
    [studio, css] = await Promise.all([read('studio.mjs'), read('moodix.css')]);
  // There would be one on almost every setting: on none, a field, a bar or a LoRA of the workflow.
  assert.doesNotMatch(studio, /ai-mark|peut régler ce paramètre|mark: true|studio-fine-note/);
  assert.doesNotMatch(css, /\.ai-mark|\.studio-fine-note/);
});

/** A proposal of Moodix AI for Krea 2, as lib/tool-runtime.mjs describes it: with an image to modify, or none. */
function kreaProposal({ denoise = 0.7, image = true, id = 'q' } = {}) {
  const prompt = 'The same staircase at night.';
  return {
    requestId: id,
    approvalToken: 't-' + id,
    tool: 'create_image',
    workflowName: 'Krea 2',
    resolution: { width: 1024, height: 1024 },
    call: { id: 'call-' + id, type: 'function', function: { name: 'create_image', arguments: '{}' } },
    plan: {
      prompt,
      // Without an image the job says the denoise really used, 1, and lists no such setting.
      parameters: { prompt, width: 1024, height: 1024, seed: 7, steps: 8, denoise: image ? denoise : 1 },
      editable: {
        prompt: true,
        stages: [],
        parameters: [
          { key: 'width', type: 'integer', value: 1024 },
          { key: 'height', type: 'integer', value: 1024 },
          { key: 'seed', type: 'integer', value: 7 },
          ...(image ? [{ key: 'denoise', type: 'number', value: denoise, min: 0.6, max: 0.7 }] : []),
        ],
        references: image ? [[{ role: 'img2img', label: 'Image à modifier' }]] : [],
      },
      references: image
        ? [{ input: 'source', resource_id: 'kept', role: 'img2img', as: 'source', roleLabel: 'Image à modifier', label: '#ref2' }]
        : [],
    },
  };
}

test('a proposal of Moodix AI sets « Débruitage » with the pointer; changed by the user, it goes with « Générer »; without an image it is left alone', async () => {
  const said = [];
  const page = await studioPage(
    { create_image: [kreaWithDenoise()] },
    { 'tools/revise': ({ edits }) => ({ requestId: 'q2', approvalToken: 't2', revised: edits }) },
    { runs: [], cursor: said, targets: true },
  );
  const { body, studio, asked, restore } = page;
  const revisions = () => asked.filter(([route]) => route === 'tools/revise').map(([, sent]) => sent.edits);
  try {
    // 0.7 proposed with its image: the pointer sets the bar, as its other settings.
    let answer = studio.propose(kreaProposal({ denoise: 0.7 }), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.ok(said.includes('règle débruitage'), said.join(' | '));
    // (0.6.205) The window of the image to modify was opened for it, and is left open: the pointer goes to
    // nothing hidden, and the user sees the value set. « Plus de réglages » stays closed: it is not there.
    assert.deepEqual(body.find('studio-piece-window').map(pane => pane.attributes['aria-label']), ['Image à modifier']);
    assert.equal(body.find('studio-more-pill')[0].attributes['aria-expanded'], 'false');
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    assert.deepEqual(denoiseShown(body), ['0,70', true, DENOISE_HELP]);
    // The user lowers it before « Générer »: sent as their change, and nothing else.
    setDenoise(body, 6);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.deepEqual(revisions(), [{ denoise: 0.66 }]);
    await studio.settled({ record: null });

    // Proposed at the value the Studio shows already: nothing to move, nothing to send.
    said.length = 0;
    answer = studio.propose(kreaProposal({ denoise: 0.66, id: 'r' }), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.equal(said.includes('règle débruitage'), false, said.join(' | '));
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(revisions().length, 1);
    await studio.settled({ record: null });

    // A proposal without an image to modify (its job says 1): the Studio keeps its own value, shown
    // nowhere (no image, no bar), and sends nothing of it.
    said.length = 0;
    answer = studio.propose(kreaProposal({ image: false, id: 's' }), new AbortController().signal);
    await until(() => said.includes('attend votre accord'));
    assert.equal(said.includes('règle débruitage'), false);
    assert.equal(denoiseShown(body), null);
    await body.find('studio-go')[0].onclick();
    assert.equal(await answer, 'once');
    assert.equal(revisions().length, 1);
  } finally {
    restore();
  }
});

test('the settings of a take: one made without an image does not give its denoise of 1 to the Studio, one made from an image gives its own back', async () => {
  const take = (id, denoise, references = []) => ({
    id,
    conversationId: 'c1',
    workflowId: 'k',
    prompt: 'un escalier',
    parameters: { width: 1024, height: 1024, seed: 5, denoise, references },
    outputs: [{ originalUrl: `/${id}.png`, thumbUrl: `/${id}.jpg` }],
  });
  const from = [{ input: 'source', role: 'img2img', resource_id: 'kept' }];
  // The newest first: the conversation opens on a take made from nothing.
  const page = await studioPage({ create_image: [kreaWithDenoise()] }, handRoutes, {
    runs: [take('alone', 1)],
    resource: id => ({ id, label: '#ref2', name: 'escalier.png', previewUrl: '/preview/' + id, width: 1024, height: 1024 }),
  });
  const { body, studio, asked, restore } = page;
  try {
    body.find('studio-more-pill')[0].onclick();
    // Its record says 1 (the picture was made from nothing): no setting, and no bar without an image.
    assert.equal(denoiseShown(body), null);
    // A take made from an image at 0.65: its image back in its case, its denoise on the bar.
    studio.show(take('edited', 0.65, from));
    assert.match(body.find('studio-slot')[0].className, /is-filled/);
    assert.deepEqual(denoiseShown(body), ['0,65', true, DENOISE_HELP]);
    await body.find('studio-go')[0].onclick();
    await settle();
    const args = asked.findLast(([route]) => route === 'tools/action')[1].arguments;
    assert.deepEqual([args.source, args.denoise], [{ resource: 'kept' }, 0.65]);
    // A take made from nothing looked at after it: no bar; the Studio keeps 0,65 (not 1, nor 0,70), seen
    // again once an image is given.
    studio.show(take('alone', 1));
    assert.doesNotMatch(body.find('studio-slot')[0].className, /is-filled/);
    assert.equal(denoiseShown(body), null);
    await pasteImage(body);
    assert.deepEqual(denoiseShown(body), ['0,65', true, DENOISE_HELP]);
    // One made from an image by an older workflow, at a denoise beyond the bounds of today: the nearest.
    studio.show(take('older', 0.75, from));
    assert.deepEqual(denoiseShown(body), ['0,70', true, DENOISE_HELP]);
    studio.show(take('lower', 0.5, from));
    assert.deepEqual(denoiseShown(body), ['0,60', true, DENOISE_HELP]);
  } finally {
    restore();
  }
});

test('« Enregistrer » keeps « Débruitage » with the other settings of the model, the case empty or not, and gives it back within its bounds', async () => {
  const posted = [];
  const save = {
    'studio/preset': request => {
      posted.push(request);
      return { workflow: request.workflow, preset: { ...request.preset, savedAt: 'maintenant' } };
    },
  };
  const first = await studioPage({ create_image: [kreaWithDenoise()] }, save);
  try {
    const { body } = first,
      disk = () => body.find('studio-save')[0];
    body.find('studio-more-pill')[0].onclick();
    // Not set yet: the disk is quiet. Set with an image: something to save.
    assert.equal(disk().dataset.state, 'still');
    await pasteImage(body);
    assert.equal(disk().dataset.state, 'still', 'an image in its case is no setting of the model');
    setDenoise(body, 5);
    assert.equal(disk().dataset.state, 'changed');
    // The image taken back, then saved: kept all the same, a setting of the model.
    body.find('studio-slot-remove')[0].onclick();
    assert.equal(denoiseShown(body), null);
    await disk().onclick();
    await settle();
    assert.deepEqual(posted[0], {
      workflow: 'k',
      preset: { format: '1:1', size: '1024x1024', seed: '', styles: [], settings: { denoise: 0.65 } },
    });
    assert.equal(disk().dataset.state, 'saved');
  } finally {
    first.restore();
  }
  // Never set: nothing of it is kept (the workflow's own value is used).
  const untouched = await studioPage({ create_image: [kreaWithDenoise()] }, save);
  try {
    await untouched.body.find('studio-save')[0].onclick();
    await settle();
    assert.deepEqual(Object.keys(posted[1].preset), ['format', 'size', 'seed', 'styles']);
  } finally {
    untouched.restore();
  }
  // Given back the first time the model is shown: at that value on its bar, once an image is given.
  const shownWith = async settings => {
    const page = await studioPage({ create_image: [kreaWithDenoise()] }, save, {
      presets: {
        k: { format: '1:1', size: '1024x1024', seed: '7', styles: [], ...(settings ? { settings } : {}), savedAt: 'hier' },
      },
    });
    try {
      page.body.find('studio-more-pill')[0].onclick();
      assert.equal(page.body.find('studio-seed')[0].children[1].value, '7');
      assert.equal(denoiseShown(page.body), null);
      await pasteImage(page.body);
      return [...denoiseShown(page.body), page.body.find('studio-save')[0].dataset.state];
    } finally {
      page.restore();
    }
  };
  assert.deepEqual(await shownWith({ denoise: 0.68 }), ['0,68', true, DENOISE_HELP, 'still']);
  // Saved when the workflow allowed more: within the bounds of today (no longer what is saved).
  assert.deepEqual(await shownWith({ denoise: 0.9 }), ['0,70', true, DENOISE_HELP, 'changed']);
  // Settings saved before the denoise was one of them: its default, and nothing « changed ».
  assert.deepEqual(await shownWith(null), ['0,60', true, DENOISE_HELP, 'still']);
});

test('the settings kept for a model: the length of a sound and the denoise, each checked; nothing else', async () => {
  const { checkPreset } = await import('../lib/studio-presets.mjs');
  assert.deepEqual(checkPreset({ settings: { denoise: 0.65 } }), { settings: { denoise: 0.65 } });
  assert.deepEqual(checkPreset({ settings: { seconds: 12 } }), { settings: { seconds: 12 } });
  assert.deepEqual(checkPreset({ seed: '7', settings: { seconds: 12, denoise: 1, steps: 40, prompt: 'non' } }), {
    seed: '7',
    settings: { seconds: 12, denoise: 1 },
  });
  for (const denoise of [0, -0.2, 1.01, '0.6', null, NaN, Infinity, [0.6]])
    assert.throws(() => checkPreset({ settings: { denoise } }), { status: 400, message: 'Débruitage invalide.' }, String(denoise));
  for (const settings of [{}, { steps: 40 }, { seconds: 0 }, { seconds: 'dix', denoise: 0.6 }, [], 'non', null])
    assert.throws(() => checkPreset({ settings }), { status: 400, message: 'Réglages invalides.' }, JSON.stringify(settings));
  // What was kept before stays as it was: a preset without settings has none.
  assert.deepEqual(checkPreset({ length: 5, seed: '' }), { length: 5, seed: '' });
});

test('the Studio stays the conversation’s whose take it makes: another one shown sees it held, and has it at the end (0.6.81)', async () => {
  // Until 0.6.80 nothing could be opened while it made a take. Since 0.6.81 the page may show another
  // conversation: the Studio keeps the one of its take (its drafts, its screen), says it is held
  // there, and is the other one's once the take is over.
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  let finish,
    shown = 'c1',
    place = 'p1',
    elsewhere = '';
  const works = [];
  const page = await studioPage(
    { create_image: [image] },
    {
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => ({ id: 'j', state: 'running', progress: 'Génération…' }),
      'tools/job': () =>
        new Promise(resolve => {
          finish = () => resolve({ id: 'j', state: 'error', error: 'rien' });
        }),
    },
    {
      conversation: () => shown,
      extra: {
        onWork: id => works.push(id),
        nameOf: id => (id === 'c1' ? 'Renard dans la neige' : 'Autre'),
        elsewhere: () => elsewhere,
        project: () => place,
      },
    },
  );
  try {
    const { body, studio } = page;
    assert.equal(studio.heldProject(), null);
    page.prompt().value = 'un phare';
    page.prompt().oninput();
    const made = body.find('studio-go')[0].onclick();
    for (let tries = 0; !finish && tries < 120; tries++) await settle();
    // Its work is the page's, in its conversation, from its first instant.
    assert.deepEqual(works, ['c1']);
    assert.equal(studio.heldFor(), 'c1');
    // Another conversation shown: the Studio is held, said so in place of its blocks.
    // (0.6.160) Of another project: the Studio, and the Bobine with it, stay in the project of the work.
    shown = 'c2';
    place = 'p2';
    assert.equal(studio.heldProject(), 'p1');
    studio.conversationChanged();
    const [held] = body.find('studio-away');
    assert.ok(held, 'held by the take of c1');
    assert.equal(held.find('studio-away-kicker')[0].textContent, 'Studio occupé');
    // (Non-breaking spaces inside the guillemets: a line never begins with « » ».)
    assert.equal(held.find('studio-away-text')[0].textContent, 'La génération de « Renard dans la neige » occupe le Studio jusqu’à sa fin.');
    assert.match(held.find('studio-away-hint')[0].textContent, /La miniature, en bas à droite, vous ramène à « Renard dans la neige »\./);
    assert.equal(body.find('studio-go').length, 0, 'nothing of c1 is drawn in c2');
    // Back in c1 meanwhile: as it was, the take in progress on « Générer ».
    shown = 'c1';
    studio.conversationChanged();
    assert.equal(body.find('studio-away').length, 0);
    assert.equal(body.find('studio-go')[0].disabled, true);
    assert.equal(page.prompt().value, 'un phare');
    // Away again, and the take ends there: the Studio is c2's (its own drafts, empty).
    shown = 'c2';
    studio.conversationChanged();
    finish();
    await made;
    await settle();
    assert.deepEqual(works, ['c1', null]);
    assert.equal(studio.holds(), false);
    assert.equal(studio.heldFor(), null);
    assert.equal(studio.heldProject(), null);
    assert.equal(body.find('studio-away').length, 0);
    assert.equal(page.prompt().value, '');
    // c1 opened again: its drafts as they were left.
    shown = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(page.prompt().value, 'un phare');
    // A work goes on in another conversation (the page says it): « Générer » is greyed, why on it,
    // and on the line of the step; « Enrichir le prompt » too.
    elsewhere = 'Génération en cours dans « Autre » : attendez sa fin.';
    studio.render();
    const [go] = body.find('studio-go');
    assert.equal(go.disabled, true);
    assert.equal(go.title, 'Génération en cours dans « Autre » : attendez sa fin.');
    assert.equal(body.find('studio-progress')[0].textContent, 'Génération en cours dans « Autre »');
    assert.equal(body.find('studio-progress')[0].hidden, false);
    assert.equal(body.find('studio-enrich-go')[0].disabled, true);
    elsewhere = '';
    studio.render();
    assert.equal(body.find('studio-go')[0].disabled, false);
    assert.equal(body.find('studio-progress')[0].hidden, true);
    // The work that greys it ends with nothing else drawing the Studio (its own creation drawn last
    // while it still counted, or a turn of Moodix ended in the Chat): the page says it changed, and
    // « Générer » is free again (0.6.86: it said « Moodix répond » until the next drawing).
    elsewhere = 'Moodix répond : attendez la fin de sa réponse.';
    studio.render();
    assert.equal(body.find('studio-go')[0].disabled, true);
    elsewhere = '';
    studio.busyChanged();
    assert.equal(body.find('studio-go')[0].disabled, false);
    assert.equal(body.find('studio-progress')[0].hidden, true);
    // Nothing changed: not drawn again (the page asks at each of its updates).
    const drawn = body.find('studio-go')[0];
    studio.busyChanged();
    assert.equal(body.find('studio-go')[0], drawn);
  } finally {
    page.restore();
  }
});

/** Every element under `root` (its controls too, whatever their class). */
const under = root => [root, ...(root.children ?? []).flatMap(child => (child && typeof child === 'object' ? under(child) : []))];
/** A take of the Chat as the page tells the Studio of it (app.js, chatTake): its request, its step. */
const chatTakeOf = (request, step = {}) => ({ request, running: true, label: '', fraction: null, preview: null, ended: null, ...step });
const still = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
const lighthouse = {
  id: 'r1',
  conversationId: 'c1',
  mediaType: 'video',
  workflowId: 'v',
  workflowName: 'Clip',
  prompt: 'Un phare dans la tempête',
  parameters: { width: 768, height: 448, frames: 121, fps: 24, seed: 7 },
  outputs: [{ originalUrl: '/r1.mp4', thumbUrl: '/r1.jpg', take: 3 }],
};

test('a take asked in the Chat is followed by the Studio of its conversation, with the settings it is made with (0.6.96)', async () => {
  // Chat and Studio are two views of one conversation: during a take asked in the Chat its Studio
  // showed it nowhere (its screen empty, the settings of before, the miniature in its corner).
  const { clip, request } = proposalOf({ prompt: 'Un phare dans la tempête' });
  let take = null;
  const stopped = [];
  const page = await studioPage({ create_image: [still], create_video: [clip] }, {}, { extra: { making: () => take, stopTurn: () => stopped.push(true) } });
  const { body, studio } = page;
  const ai = key => under(body).find(item => item.dataset?.ai === key);
  try {
    // What the user was writing in it, in Image.
    page.prompt().value = 'mon brouillon';
    page.prompt().oninput();
    // Asked, not begun (a card waiting in the Chat): nothing to follow.
    take = chatTakeOf(request, { running: false });
    studio.watch();
    assert.equal(studio.busy(), false);
    // Begun: its screen follows it, in Vidéo, with what it is made with, and how long since its go.
    Object.assign(take, { running: true, label: 'Génération · 3/8', fraction: 0.4, preview: '/media/job-preview/j/3', time: { ms: 12400, running: true } });
    studio.watch();
    assert.equal(studio.busy(), true);
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'Un phare dans la tempête');
    assert.equal(ai('size').attributes['aria-valuetext'], '768 × 448');
    assert.equal(ai('duration').attributes['aria-valuetext'], '05.04 S');
    assert.equal(ai('seed').value, '7');
    assert.equal(body.find('studio-progress')[0].textContent, 'Génération · 3/8');
    assert.equal(body.find('studio-elapsed')[0]?.textContent, '12 s', 'its time, as its card counts it (0.6.93)');
    // « Générer » waits for its end and says why; « Arrêter » stops it with its turn.
    const [go] = body.find('studio-go');
    assert.equal(go.disabled, true);
    assert.equal(body.find('studio-go-label')[0].textContent, 'En cours…');
    assert.equal(go.title, 'Génération en cours dans cette conversation : attendez sa fin.');
    body.find('studio-stop')[0].onclick();
    assert.deepEqual(stopped, [true]);
    // It does not hold the Studio: the conversation's.
    assert.equal(studio.holds(), false);
    assert.equal(studio.heldFor(), null);
    // Its next step, as it comes (nothing new: nothing drawn again).
    Object.assign(take, { label: 'Génération · 5/8', time: { ms: 75200, running: true } });
    studio.watch();
    studio.render();
    assert.equal(body.find('studio-progress')[0].textContent, 'Génération · 5/8');
    assert.equal(body.find('studio-elapsed')[0]?.textContent, '1 min 15 s');
    const drawn = body.find('studio-go')[0];
    studio.watch();
    assert.equal(body.find('studio-go')[0], drawn);
    // Over while the Studio is not on screen: as it was, then its take with its settings once it comes.
    page.runs.push(lighthouse);
    Object.assign(take, { running: false, ended: { type: 'done', record: lighthouse, message: '' } });
    studio.watch();
    assert.equal(studio.busy(), false);
    assert.equal(body.dataset.mode, 'image');
    assert.equal(page.prompt().value, 'mon brouillon');
    assert.equal(body.find('studio-elapsed').length, 0, 'no count without a take being made');
    await studio.open();
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'Un phare dans la tempête');
    assert.deepEqual(studio.screenTake(), { take: 3, media: 'video' });
    // Its seed drawn again, as for any take (it was not named).
    assert.equal(ai('seed').value, '');
  } finally {
    page.restore();
  }
});

test('the take of the Chat followed with the Studio on screen: another conversation meanwhile, then its take there at once, or why it failed (0.6.96)', async () => {
  const { clip, request } = proposalOf({ prompt: 'Un phare' });
  let take = null,
    shown = 'c1';
  const page = await studioPage(
    { create_image: [still], create_video: [clip] },
    {},
    { conversation: () => shown, extra: { making: () => (shown === 'c1' ? take : null) } },
  );
  const { body, studio } = page;
  globalThis.document.body.dataset = { view: 'studio' };
  try {
    take = chatTakeOf(request, { label: 'Génération · 1/8', fraction: 0.1 });
    studio.watch();
    assert.equal(studio.busy(), true);
    // Another conversation shown: its own Studio (not « Studio occupé »: the take holds it not).
    shown = 'c2';
    studio.conversationChanged();
    await settle();
    assert.equal(studio.busy(), false);
    assert.equal(body.find('studio-away').length, 0);
    assert.equal(page.prompt().value, '');
    // Back in c1: followed again, as it is now.
    Object.assign(take, { label: 'Génération · 5/8', fraction: 0.6 });
    shown = 'c1';
    studio.conversationChanged();
    await settle();
    assert.equal(studio.busy(), true);
    assert.equal(body.find('studio-progress')[0].textContent, 'Génération · 5/8');
    assert.equal(page.prompt().value, 'Un phare');
    // Made under the user's eyes: on the screen at once.
    page.runs.push({ ...lighthouse, prompt: 'Un phare' });
    Object.assign(take, { running: false, ended: { type: 'done', record: lighthouse, message: '' } });
    studio.watch();
    for (let tries = 0; !studio.screenTake() && tries < 40; tries++) await settle();
    assert.deepEqual(studio.screenTake(), { take: 3, media: 'video' });
    assert.equal(studio.busy(), false);
    // The next one fails: why, under its screen, as for a creation of the Studio.
    take = chatTakeOf({ ...request }, { label: 'Génération · 2/8', fraction: 0.2 });
    studio.watch();
    Object.assign(take, { running: false, ended: { type: 'failed', record: null, message: 'La mémoire vidéo a manqué.' } });
    studio.watch();
    assert.equal(studio.busy(), false);
    assert.equal(body.find('studio-error')[0]?.textContent, 'La mémoire vidéo a manqué.');
    // Never over a proposal of Moodix AI waiting in it.
    const answer = studio.propose({ ...request, requestId: 'q3' }, new AbortController().signal);
    await settle();
    take = chatTakeOf({ ...request }, { label: 'Génération · 1/8' });
    studio.watch();
    assert.equal(studio.proposing(), true);
    assert.equal(studio.busy(), false);
    studio.decline();
    assert.equal(await answer, 'deny');
  } finally {
    page.restore();
  }
});

test('followed again with its request, the Studio shows the settings it is made with; its take, its own (0.6.96)', async () => {
  // After a reload, or an image of a series made while the Studio was not on screen: the screen
  // followed it with the settings of the last take (or of the image before it).
  const { clip, request } = proposalOf({ prompt: 'Un phare' });
  const page = await studioPage({ create_video: [clip] });
  const { body, studio } = page;
  const ai = key => under(body).find(item => item.dataset?.ai === key);
  try {
    assert.equal(studio.followAgain(request), true);
    assert.equal(studio.heldFor(), 'c1');
    assert.equal(body.dataset.mode, 'video');
    assert.equal(page.prompt().value, 'Un phare');
    assert.equal(ai('seed').value, '7');
    // Made: the settings of its take, its seed drawn again (it was not named).
    page.runs.push({ ...lighthouse, prompt: 'Un phare' });
    await studio.settled({ record: lighthouse });
    assert.equal(page.prompt().value, 'Un phare');
    assert.equal(ai('seed').value, '');
    assert.deepEqual(studio.screenTake(), { take: 3, media: 'video' });
    // Nothing made: the seed of before back. (Its size shown as it is made, though not one of the list.)
    studio.followAgain({
      ...request,
      resolution: { width: 800, height: 448 },
      plan: { ...request.plan, parameters: { ...request.plan.parameters, width: 800, height: 448, seed: 9 } },
    });
    assert.equal(ai('seed').value, '9');
    assert.equal(ai('size').attributes['aria-valuetext'], '800 × 448');
    await studio.settled({ error: 'La génération a échoué.' });
    assert.equal(ai('seed').value, '');
  } finally {
    page.restore();
  }
});

test('what is being written in another mode stays when a take is made in the conversation, by the Bobine or by the Chat (0.6.192)', async () => {
  // (Found by the check of 21/11.) The conversation has an image already; the user writes a prompt in Image,
  // without making it. A video is made meanwhile (a take of the Bobine since 0.6.177, a take of the Chat since
  // 0.6.96): the Studio took the settings of the last take of every mode, and the old image came over what
  // was being typed. Only the mode of the take new to it now.
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    clip = { id: 'v9', conversationId: 'c1', mediaType: 'video', workflowId: 'v', workflowName: 'Clip', prompt: 'Il lève les yeux.', parameters: { frames: 121, fps: 24 }, outputs: [{ take: 9, originalUrl: '/media/v9' }] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    older = { id: 'i1', conversationId: 'c1', workflowId: 'i', workflowName: 'Image', prompt: 'Une vieille image', parameters: { width: 1024, height: 1024 }, outputs: [{ take: 1, originalUrl: '/media/i1' }] };
  const draft = page => {
    page.mode(0);
    page.prompt().value = 'mon brouillon';
    page.prompt().oninput();
  };
  // A take of the Bobine.
  const kept = [],
    stored = {
      schemaVersion: 1, id: 'm1', name: 'Film', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [{ id: 'a', kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: { conversationId: 'c0', runId: 'p1', output: 0 } } }],
      createdAt: '2026-11-20T03:00:00.000Z',
      updatedAt: '2026-11-20T03:00:00.000Z',
    };
  const routes = new Proxy({}, {
    get: (_, route) =>
      typeof route !== 'string'
        ? undefined
        : route === 'tools/action'
          ? body => (body.estimate ? { workflowName: 'LTX 2.5', seconds: 5.042 } : proposalOf({ prompt: body.arguments.prompt }).request)
          : route === 'montages/save'
            ? body => (kept.push(body.montage), { ...body.montage, createdAt: 'a', updatedAt: 'b' })
            : /^montages\/[^/]+\/m1$/.test(route)
              ? () => stored
              : /^montages\/[^/]+$/.test(route)
                ? () => ({ montages: [{ id: 'm1', name: 'Film' }] })
                : undefined,
  });
  const runs = [older, photo];
  let page = await studioPage({ create_image: [image], create_video: [video] }, routes, {
    runs,
    run: async () => {
      runs.unshift(clip);
      return { record: clip };
    },
  });
  try {
    const desk = page.studio.bobine().desk();
    await until(() => desk.find('montage-piece').length === 1 && desk.find('bobine-line-right')[0]?.textContent === 'LTX 2.5');
    draft(page);
    desk.find('bobine-go-main')[0].onclick();
    await until(() => kept.some(montage => !montage.plans[0].todo));
    await until(() => page.studio.screenTake()?.take === 9);
    // The Studio shows the take made, in Vidéo, with its text (0.6.177); Image is as it was being written.
    assert.deepEqual([page.body.dataset.mode, page.prompt().value], ['video', 'Il lève les yeux.']);
    page.mode(0);
    assert.equal(page.prompt().value, 'mon brouillon');
  } finally {
    page.restore();
  }
  // A take of the Chat, the Studio not on screen: read when it opens.
  const { clip: chatClip, request } = proposalOf({ prompt: 'Un phare dans la tempête' });
  let take = null;
  const made = { id: 'r1', conversationId: 'c1', mediaType: 'video', workflowId: chatClip.id, workflowName: chatClip.name, prompt: 'Un phare dans la tempête', parameters: { width: 768, height: 448, frames: 121, fps: 24 }, outputs: [{ take: 2, originalUrl: '/media/r1' }] },
    chatRuns = [older];
  page = await studioPage({ create_image: [image], create_video: [chatClip] }, {}, { runs: chatRuns, extra: { making: () => take } });
  try {
    draft(page);
    take = chatTakeOf(request, { running: true });
    page.studio.watch();
    chatRuns.unshift(made);
    Object.assign(take, { running: false, ended: { type: 'done', record: made, message: '' } });
    page.studio.watch();
    await page.studio.open();
    assert.deepEqual([page.body.dataset.mode, page.prompt().value], ['video', 'Un phare dans la tempête']);
    page.mode(0);
    assert.equal(page.prompt().value, 'mon brouillon');
  } finally {
    page.restore();
  }
});

test('followed again before its tools are read (a page just reloaded), the Studio shows the settings of the take once they are (0.6.184)', async () => {
  // (Seen on the card on 21/11: the page reloaded during a take of the Bobine follows its job at once,
  // before the Studio has read its models. It stayed in Image, « En cours · 20 % » under the form of an
  // image, while LTX 2.5 made a video: what 0.6.96 and 0.6.177 had put right for a page that stays.)
  const { clip, request } = proposalOf({ prompt: 'Un phare' });
  const image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  const page = await studioPage({ create_image: [image], create_video: [clip] }, {}, { open: false });
  const { studio } = page;
  try {
    assert.equal(studio.followAgain(request), true);
    // Its tools read (the Studio opens, or reads ahead as the page does at launch): in Vidéo, its text, its seed.
    await studio.open();
    const ai = key => under(page.body).find(item => item.dataset?.ai === key);
    assert.deepEqual([page.body.dataset.mode, page.prompt().value, ai('seed').value, studio.busy()], ['video', 'Un phare', '7', true]);
    // Made: the settings of its take, as when its request was shown at once.
    page.runs.push({ ...lighthouse, prompt: 'Un phare' });
    await studio.settled({ record: lighthouse });
    assert.deepEqual([page.prompt().value, ai('seed').value, studio.screenTake()], ['Un phare', '', { take: 3, media: 'video' }]);
  } finally {
    page.restore();
  }
  // Read ahead by the page (prefetch), the Studio not on screen: the same, drawn when it comes.
  const ahead = await studioPage({ create_image: [image], create_video: [clip] }, {}, { open: false });
  try {
    ahead.studio.followAgain(request);
    await ahead.studio.prefetch();
    await ahead.studio.open();
    assert.deepEqual([ahead.body.dataset.mode, ahead.prompt().value], ['video', 'Un phare']);
    // Nothing made: the seed of before back, as for a request shown at once.
    const ai = key => under(ahead.body).find(item => item.dataset?.ai === key);
    await ahead.studio.settled({ error: 'La génération a échoué.' });
    assert.equal(ai('seed').value, '');
  } finally {
    ahead.restore();
  }
  // Its tools read, but before the engine was ready: no model of video is offered yet (the first reading of a
  // page). Nothing can be shown then; read again with its model, its settings are.
  const tools = { create_image: [image], create_video: [] };
  const early = await studioPage(tools);
  try {
    early.studio.followAgain(request);
    assert.equal(early.body.dataset.mode, 'image');
    tools.create_video = [clip];
    // (0.6.192) Read ahead by the page once the engine is ready (app.js: invalidate, then prefetch, never open):
    // drawn there. Nothing drew it while the take went on, and the Studio stayed in Image under « En cours ».
    early.studio.invalidate({ tools: true });
    await early.studio.prefetch();
    assert.deepEqual([early.body.dataset.mode, early.prompt().value], ['video', 'Un phare']);
  } finally {
    early.restore();
  }
});

test('drawn again, Réglages and Entrée stay where they were scrolled to; « Plus de réglages », a window, scrolls nothing (0.6.206)', async () => {
  // (0.6.102) Each drawing sent them back to their top, as the Sortie was before (0.6.92): a LoRA
  // switched, a setting changed, « Plus de réglages » opened at the foot of a long column.
  const blocks = new Map();
  let desk = null;
  // The page as it is laid out: each block of the desk on the page now, its scroll its own.
  const querySelector = selector => {
    const now = globalThis.document.getElementById('studio-body')?.children[0] ?? null;
    if (now !== desk) {
      desk = now;
      blocks.clear();
    }
    if (!blocks.has(selector))
      blocks.set(selector, {
        scrollTop: 0,
        scrollLeft: 0,
        into: [],
        scrollIntoView(options) {
          this.into.push(options);
        },
      });
    return blocks.get(selector);
  };
  const image = {
    id: 'w',
    name: 'Image',
    roles: {},
    limits: sizes,
    size: { width: 1024, height: 1024 },
    seeded: true,
    settings: [{ key: 'steps', type: 'integer', min: 1, max: 50, default: 8 }],
  };
  const page = await studioPage({ create_image: [image] }, {}, { querySelector });
  const settings = '#studio-view .studio-block.is-settings > .studio-block-body',
    input = '#studio-view .studio-block.is-input',
    rare = '#studio-view .studio-rare';
  try {
    querySelector(settings).scrollTop = 140;
    querySelector(input).scrollTop = 60;
    page.studio.render();
    assert.notEqual(desk, null);
    assert.deepEqual([querySelector(settings).scrollTop, querySelector(input).scrollTop], [140, 60]);
    // (0.6.206) Opened: a window over the preview, the column is not scrolled to it (under its pill, it was
    // brought into sight, 0.6.102).
    page.body.find('studio-more-pill')[0].onclick();
    assert.equal(page.body.find('studio-rare')[0].hidden, false);
    assert.deepEqual([querySelector(rare).into, querySelector('#studio-view .studio-more-pill').into], [[], []]);
    assert.equal(querySelector(settings).scrollTop, 140);
    // Drawn again open (a setting changed): it stays where the user scrolled, nothing is brought.
    querySelector(settings).scrollTop = 300;
    page.studio.render();
    assert.deepEqual([querySelector(rare).into, querySelector(settings).scrollTop], [[], 300]);
    // Closed: nothing brought either.
    page.body.find('studio-more-pill')[0].onclick();
    assert.deepEqual(querySelector(rare).into, []);
  } finally {
    page.restore();
  }
});

test('a take to create of the bobine is made as a take of the Studio is, which follows it as it does a take of the Chat (0.6.142, 0.6.148, 0.6.177)', async () => {
  // (0.6.148) The Bobine (ex-Montage) is a page of its own beside the Studio, no fourth mode of it; the
  // Studio holds it all the same, because it creates its takes as its own. « Créer 1 prise » makes it at once.
  // (0.6.177, « studio ne suit pas exactement ce que fait bobine […] ça affiche Krea2 dans studio ») The Studio
  // stayed in the mode it was left in, a choice of the time the montage was one of its modes: it now follows
  // the take, in Vidéo with what it is made with, then shows it made, as for a take asked in the Chat.
  // (The photo is a take of another conversation of the project: named as the Studio names such a take.)
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    clip = { id: 'v9', conversationId: 'c1', mediaType: 'video', workflowId: 'v', workflowName: 'Clip', prompt: 'Il lève les yeux.', parameters: { frames: 121, fps: 24 }, outputs: [{ take: 9, originalUrl: '/media/v9' }] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true };
  const page = async (outcome, extra = {}) => {
    const runs = [photo],
      kept = [],
      stored = {
        schemaVersion: 1, id: 'm1', name: 'Film', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
        plans: [{ id: 'a', kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: { conversationId: 'c0', runId: 'p1', output: 0 } } }],
        // (0.6.181) When it was last kept: a take made since, that no page laid, is laid at its place.
        createdAt: '2026-11-20T03:00:00.000Z',
        updatedAt: '2026-11-20T03:00:00.000Z',
      };
    const routes = new Proxy({}, {
      get: (_, route) =>
        typeof route !== 'string'
          ? undefined
          : route === 'tools/action'
            ? body => (body.estimate ? { workflowName: 'LTX 2.5', seconds: 5.042 } : (asking.push(studio.body.dataset.mode), proposalOf({ prompt: body.arguments.prompt }).request))
            : route === 'tools/execute' && outcome.job
              ? () => outcome.job
            : route === 'montages/save'
              ? body => (kept.push(body.montage), { ...body.montage, createdAt: 'a', updatedAt: 'b' })
              : /^montages\/[^/]+\/m1$/.test(route)
                ? () => stored
                : /^montages\/[^/]+$/.test(route)
                  ? () => ({ montages: [{ id: 'm1', name: 'Film' }] })
                  : undefined,
    });
    const seen = [],
      // (0.6.177) The mode the Studio shows as the take is asked to the server.
      asking = [];
    let desk = null;
    const studio = await studioPage({ create_image: [image], create_video: [video] }, routes, {
      runs,
      // (`job`: no run of the page, the Studio asks the server itself and follows its job, as before 0.5.x.)
      run: outcome.job ? undefined : async (proposed, hooks) => {
        const { onProgress } = hooks;
        // (0.6.176) A run of the test's own: stopped by its signal, as the page's is.
        if (outcome.run) return outcome.run(proposed, hooks);
        // (0.6.182) With how long it has been in the making, as the server counts it. The count goes on by
        // itself between two answers of the server: the Bobine hears each second of it, as the Studio shows it.
        onProgress('Étape 2 sur 8', 0.25, null, { ms: 71800, running: true });
        const stage = () => desk.find('bobine-stage')[0]?.textContent,
          first = stage();
        await until(() => stage() !== first);
        const second = stage();
        // (A step said while the count stays where it is: heard at once all the same.)
        onProgress('Étape 3 sur 8', 0.25);
        seen.push({
          mode: studio.body.dataset.mode,
          prompt: studio.prompt().value,
          // (0.6.180) Said to the page: it writes « Bobine · Vidéo : … » in the conversation, for the model.
          bobine: hooks.bobine,
          // (0.6.181) And where its take goes there, for the server to keep with it.
          place: hooks.bobinePlace,
          // (0.6.182) The step and the count of the Studio, said above the button of « À créer ».
          step: [first, second, stage()],
          pieces: desk.find('montage-piece').map(piece => piece.children[0].textContent),
          button: desk.find('bobine-go-label')[0].textContent,
        });
        if (outcome.record) runs.push(outcome.record);
        return outcome;
      },
      extra,
    });
    desk = studio.studio.bobine().desk();
    await until(() => desk.find('montage-piece').length === 1 && desk.find('bobine-line-right')[0]?.textContent === 'LTX 2.5');
    const actions = () => studio.asked.filter(([route]) => route === 'tools/action').map(([, sent]) => sent);
    return { ...studio, desk, kept, seen, asking, actions, runs };
  };
  let studio = await page({ record: clip });
  try {
    const { body, page: view, desk, kept, seen, asking, actions } = studio;
    // The Studio: Image · Vidéo · Son again, in its mode.
    assert.deepEqual(view['studio-kinds'].children.map(tab => tab.dataset.mode), ['image', 'video', 'audio']);
    assert.equal(body.dataset.mode, 'image');
    // The model of the take, asked once to the server without making anything: in the conversation, as
    // its creation will be, its text left out (it does not choose the model).
    assert.deepEqual(actions(), [
      { conversationId: 'c1', project: actions()[0].project, studio: true, name: 'create_video', estimate: true, size: { width: 1344, height: 768 }, arguments: { prompt: 'Prise.', intention: 'Prise d’une bobine, demandée dans la Bobine.', duration: 5, format: '16:9', start_image: { output: 'p1', conversation: 'c0' } } },
    ]);
    assert.deepEqual([desk.find('montage-piece')[0].children[0].textContent, desk.find('bobine-go-label')[0].textContent], ['', 'Créer 1 prise']);
    // What the user was writing in the Studio, in Image.
    studio.prompt().value = 'mon brouillon';
    studio.prompt().oninput();
    desk.find('bobine-go-main')[0].onclick();
    await until(() => kept.some(montage => !montage.plans[0].todo));
    // Asked as the Studio asks a clip: in the conversation, for the project, by the user's own hand, at the size of the film.
    const sent = actions().at(-1);
    assert.deepEqual([sent.conversationId, sent.studio, sent.name, sent.estimate, sent.size], ['c1', true, 'create_video', undefined, { width: 1344, height: 768 }]);
    assert.deepEqual(sent.arguments, { prompt: 'Il lève les yeux.', intention: 'Prise d’une bobine, demandée dans la Bobine.', duration: 5, format: '16:9', start_image: { output: 'p1', conversation: 'c0' } });
    // While it is made the bobine says it on the take and in its button; the Studio follows it, in Vidéo,
    // with the text it is made with (0.6.177: it showed Image and the draft of an image). (0.6.200) How far it
    // is, in its button only.
    assert.deepEqual(seen, [{ mode: 'video', prompt: 'Il lève les yeux.', bobine: true, place: { id: 'm1', plan: 'a', from: 0 }, step: ['Étape 2 sur 8 · 1 min 11 s', 'Étape 2 sur 8 · 1 min 12 s', 'Étape 3 sur 8 · 1 min 12 s'], pieces: ['En cours'], button: '1 sur 1 · 25 %' }]);
    // (In Vidéo from its first instant, before the server has said what it is made with.)
    assert.deepEqual(asking, ['video']);
    // Made: the take to create is the take made, kept as such; « À créer » is empty.
    await until(() => desk.find('montage-piece')[0].children[0].textContent === 'Prise 9');
    assert.deepEqual([kept.at(-1).plans[0].source, kept.at(-1).plans[0].todo, desk.find('bobine-line').length], [{ conversationId: 'c1', runId: 'v9', output: 0 }, undefined, 0]);
    // (0.6.177) The Studio shows the take made, the newest of the conversation, as after a take of the Chat;
    // what the user was writing in Image is still there.
    assert.deepEqual([body.dataset.mode, studio.studio.screenTake(), studio.prompt().value], ['video', { take: 9, media: 'video' }, 'Il lève les yeux.']);
    studio.mode(0);
    assert.deepEqual([body.dataset.mode, studio.prompt().value], ['image', 'mon brouillon']);
  } finally {
    studio.restore();
  }
  // Made by a model the Studio does not list (its settings cannot be taken): on the screen all the same.
  studio = await page({ record: { ...clip, id: 'v10', workflowId: 'x', workflowName: 'Autre modèle', outputs: [{ take: 10, originalUrl: '/media/v10', thumbUrl: '/thumb/v10' }] } });
  try {
    const { body, desk } = studio;
    desk.find('bobine-go-main')[0].onclick();
    await until(() => desk.find('montage-piece')[0].children[0].textContent === 'Prise 10');
    assert.deepEqual([body.dataset.mode, studio.studio.screenTake()], ['video', { take: 10, media: 'video' }]);
  } finally {
    studio.restore();
  }
  // Refused by the engine: said in its line of « À créer », in amber; it can be tried again; the form of the Studio
  // says nothing, and the Studio is as it was before the take (0.6.177).
  studio = await page({ record: null, error: 'Mémoire vidéo insuffisante.' });
  try {
    const { body, desk } = studio;
    desk.find('bobine-go-main')[0].onclick();
    await until(() => desk.find('bobine-line-reason').length === 1);
    assert.deepEqual([desk.find('bobine-line-reason')[0].textContent, desk.find('bobine-line')[0].dataset.state, desk.find('bobine-line-right')[0].textContent], ['Mémoire vidéo insuffisante.', 'failed', 'Échec']);
    assert.deepEqual([desk.find('bobine-go-label')[0].textContent, desk.find('bobine-go-main')[0].disabled], ['Créer 1 prise', false]);
    assert.deepEqual([body.dataset.mode, body.find('studio-error')], ['image', []]);
  } finally {
    studio.restore();
  }
  // (0.6.176, audit of 21/11) A stop is a stop, wherever it comes from. « Arrêter » of the Studio during a
  // take of the Bobine, or « Interrompre la réponse » of the Chat (the server then says it cancelled): the
  // take was noted « Échec · Génération arrêtée. » (or « annulée »), where the Bobine's own « Arrêter » notes nothing.
  for (const outcome of [
    { run: (proposed, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), stop: true },
    { record: null, failed: true, error: 'Génération arrêtée.', cancelled: true },
    { job: { id: 'j', state: 'cancelled', error: 'Génération arrêtée.' } },
  ]) {
    studio = await page(outcome);
    try {
      const { body, desk } = studio,
        bobine = studio.studio.bobine();
      desk.find('bobine-go-main')[0].onclick();
      if (outcome.stop) {
        await until(() => body.find('studio-stop').length === 1 && studio.asked.some(([route, sent]) => route === 'tools/action' && !sent.estimate));
        await settle();
        body.find('studio-stop')[0].onclick();
      }
      await until(() => !bobine.state().filling && !bobine.state().making);
      assert.deepEqual(
        [bobine.state().failed.size, desk.find('bobine-line-reason').length, desk.find('bobine-line-right')[0].textContent === 'Échec', desk.find('bobine-go-label')[0].textContent],
        [0, 0, false, 'Créer 1 prise'],
      );
      assert.deepEqual(body.find('studio-error'), []);
    } finally {
      studio.restore();
    }
  }
  // (0.6.175, audit of 21/11) One creation at a time, and said: while a take of the Chat was made, or
  // Moodix answered, « Créer » stayed lit; the Studio refused its click without a word, and the take was
  // noted « Échec · La création n'a pas pu commencer. »
  const { request } = proposalOf({ prompt: 'Un phare dans la tempête' });
  let take = null,
    elsewhere = '',
    allowed = true;
  studio = await page({ record: clip }, { making: () => take, elsewhere: () => elsewhere, mayBegin: () => allowed });
  try {
    const { desk, notices, actions } = studio,
      go = () => desk.find('bobine-go-main')[0],
      // (0.6.200) Said short on its line at 1280 × 720, whole in its bubble and in that of « Créer ».
      waits = () => desk.find('bobine-waits').map(line => [line.textContent, line.hidden]),
      tips = () => [desk.find('bobine-waits')[0].title, go().dataset.tip];
    assert.deepEqual([go().disabled, waits()], [false, [['', true]]]);
    // A take of the Chat of this conversation, which the Studio follows: « Créer » waits for its end, and says so.
    take = chatTakeOf(request);
    studio.studio.watch();
    studio.studio.busyChanged();
    assert.deepEqual([go().disabled, waits()], [true, [['Attendez la fin de la génération en cours.', false]]]);
    assert.deepEqual(tips(), Array(2).fill('Génération en cours dans cette conversation : attendez sa fin.'));
    take = null;
    studio.studio.watch();
    studio.studio.busyChanged();
    assert.deepEqual([go().disabled, waits()], [false, [['', true]]]);
    // What greys « Générer » greys « Créer », with the same words: Moodix answering in this conversation.
    elsewhere = 'Moodix répond : attendez la fin de sa réponse.';
    studio.studio.busyChanged();
    assert.deepEqual([go().disabled, waits(), tips()], [true, [['Attendez la fin de la réponse de Moodix.', false]], [elsewhere, elsewhere]]);
    elsewhere = '';
    studio.studio.busyChanged();
    assert.deepEqual([go().disabled, waits()], [false, [['', true]]]);
    // The user says no to what the creation would cost (a conversation set aside): nothing is made, and
    // nothing has failed; the take is still to create.
    allowed = false;
    const before = actions().length;
    go().onclick();
    await settle();
    await until(() => !studio.studio.bobine().state().filling);
    assert.deepEqual(
      [actions().length, desk.find('bobine-line-reason').length, desk.find('bobine-line-right')[0].textContent === 'Échec', desk.find('bobine-go-label')[0].textContent, go().disabled, notices],
      [before, 0, false, 'Créer 1 prise', false, []],
    );
  } finally {
    studio.restore();
  }
  // (0.6.181, audit of 21/11, A5) The page reloaded while a take of the Bobine is made: the server kept
  // where it goes with its job, and the page follows that job again (take-recovery.mjs hands the Studio its
  // proposal). The Bobine says « En cours » on that take as the Studio counts, « Créer » waits; made, the
  // take is laid at its place. It stayed « à créer », its take in « Prises ».
  studio = await page({ record: clip });
  try {
    const { desk, kept, runs } = studio,
      place = { id: 'm1', plan: 'a', from: 0 },
      said = () => [desk.find('montage-piece')[0].children[0].textContent, desk.find('bobine-line-right')[0].textContent, desk.find('bobine-go-main')[0].disabled];
    // (The Bobine is the page shown: the Studio tells it when the takes of the project are read again.)
    globalThis.document.body = { dataset: { view: 'bobine' } };
    assert.equal(studio.studio.bobineWorking(), false);
    assert.equal(studio.studio.followAgain({ ...request, bobine: place }), true);
    assert.deepEqual(said(), ['En cours', 'En cours', true]);
    // (0.6.192) The Bobine says it on its take: the miniature stays hidden there (app.js syncMiniature), as for
    // a take the Bobine asked itself. It came over the timeline after a reload.
    assert.equal(studio.studio.bobineWorking(), true);
    studio.studio.follow('Étape 4 sur 8', 0.5, null, { ms: 48000, running: true });
    // (0.6.200) How far it is, in its line only: no button of the Bobine makes it.
    assert.deepEqual(said(), ['En cours', 'En cours · 50 %', true]);
    // (0.6.182) Its step and its time above the button, as for a take the Bobine asked itself.
    assert.deepEqual(desk.find('bobine-stage').map(line => line.textContent), ['Étape 4 sur 8 · 48 s']);
    // (0.6.200) Never with the wait it holds « Créer » for (the Studio follows it: « Génération en cours… »), which
    // « Créer » says in its bubble: two lines above the button made « À créer » scroll at 1280 × 720.
    assert.deepEqual([desk.find('bobine-waits')[0].hidden, desk.find('bobine-go-main')[0].dataset.tip], [true, 'Génération en cours dans cette conversation : attendez sa fin.']);
    const made = { ...clip, createdAt: '2026-11-20T03:05:00.000Z', bobine: place };
    runs.push(made);
    await studio.studio.settled({ record: made });
    await until(() => kept.some(montage => !montage.plans[0].todo));
    assert.deepEqual([desk.find('montage-piece')[0].children[0].textContent, kept.at(-1).plans[0].source, desk.find('bobine-line').length], ['Prise 9', { conversationId: 'c1', runId: 'v9', output: 0 }, 0]);
  } finally {
    studio.restore();
  }
});

test('the bobine asks its takes to LTX 2.5 by its name when the Studio has it ready, and names nothing else (0.6.151)', async () => {
  // (« Oui, LTX 2.5 », 20/11: a take drawn had gone to the model the server prefers.)
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    clip = { id: 'v', name: 'MiniMax H3 Omni', family: 'minimax', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    // (0.6.152) What it makes at once: a take longer than it is made in equal parts.
    ltx = { id: 'l', name: 'LTX 2.5', family: 'ltx25', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true, lengths: { seconds: [0.375, 5.042, 10.042], standard: 5.042 } },
    stored = {
      schemaVersion: 1, id: 'm1', name: 'Film', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [{ id: 'a', at: 0, kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 12, frame: 'fit', volume: 1, photos: { start: { conversationId: 'c0', runId: 'p1', output: 0 } } }],
    };
  const routes = new Proxy({}, {
    get: (_, route) =>
      typeof route !== 'string'
        ? undefined
        : route === 'tools/action'
          ? () => ({ workflowName: 'LTX 2.5' })
          : /^montages\/[^/]+\/m1$/.test(route)
            ? () => stored
            : /^montages\/[^/]+$/.test(route)
              ? () => ({ montages: [{ id: 'm1', name: 'Film' }] })
              : undefined,
  });
  // (Twelve seconds: two parts of six with LTX 2.5; nobody knows what the other makes: in one part.)
  for (const [videos, named, parts] of [
    [[clip, ltx], 'l', ['2 × 06.00 s']],
    [[clip, { ...ltx, unavailable: 'Un fichier de LTX 2.5 manque.' }], undefined, []],
    [[clip], undefined, []],
  ]) {
    const studio = await studioPage({ create_image: [image], create_video: videos }, routes, { runs: [photo] });
    try {
      const desk = studio.studio.bobine().desk();
      await until(() => studio.asked.some(([route]) => route === 'tools/action'));
      const [, sent] = studio.asked.find(([route]) => route === 'tools/action');
      assert.equal(sent.arguments.workflow, named, videos.map(video => video.name + (video.unavailable ? ' (absent)' : '')).join(', '));
      assert.deepEqual([sent.arguments.duration, desk.find('bobine-line-parts').map(item => item.textContent)], [parts.length ? 6 : 12, parts]);
    } finally {
      studio.restore();
    }
  }
});

test('the wand of the bobine: the chat model brought back, with what can stop the wait, then asked as the wand of the Studio (0.6.153)', async () => {
  // (Seen in the real page, 20/11: the wait for the chat model was given no signal, and the wand said
  // « Cannot read properties of undefined (reading 'throwIfAborted') ».)
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    stored = {
      schemaVersion: 1, id: 'm1', name: 'Film', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [{ id: 'a', at: 0, kind: 'video', todo: { prompt: 'Il lève les yeux.' }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: { conversationId: 'c0', runId: 'p1', output: 0 } } }],
    },
    seen = [];
  const routes = new Proxy({}, {
    get: (_, route) =>
      typeof route !== 'string'
        ? undefined
        : route === 'studio/enrich'
          ? () => ({ prompt: 'Gros plan : il lève lentement les yeux.' })
          : route === 'tools/action'
            ? () => ({ workflowName: 'LTX 2.5' })
            : route === 'montages/save'
              ? body => ({ ...body.montage, createdAt: 'a', updatedAt: 'b' })
              : /^montages\/[^/]+\/m1$/.test(route)
                ? () => stored
                : /^montages\/[^/]+$/.test(route)
                  ? () => ({ montages: [{ id: 'm1', name: 'Film' }] })
                  : undefined,
  });
  const studio = await studioPage({ create_image: [image], create_video: [video] }, routes, {
    runs: [photo],
    waitForModel: async (api, signal) => void seen.push(typeof signal?.throwIfAborted),
  });
  try {
    const desk = studio.studio.bobine().desk();
    await until(() => desk.find('bobine-go-wand').length === 1 && !desk.find('bobine-go-wand')[0].disabled);
    desk.find('bobine-go-wand')[0].onclick();
    desk.find('bobine-line')[0].onclick({ target: desk.find('bobine-line')[0] });
    await until(() => desk.find('bobine-line-words')[0]?.value === 'Gros plan : il lève lentement les yeux.');
    assert.deepEqual(seen, ['function']);
    const [, sent] = studio.asked.find(([route]) => route === 'studio/enrich');
    assert.deepEqual(sent, { prompt: 'Il lève les yeux.', verb: 'create_video' });
  } finally {
    studio.restore();
  }
});

test('a request written in the bobine: the chat model is brought back, then asked its plan with the bobine as the page has it (0.6.162)', async () => {
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    order = [];
  const routes = new Proxy({}, {
    get: (_, route) =>
      typeof route !== 'string'
        ? undefined
        : route === 'montages/arrange'
          ? () => (order.push('arrange'), { arrangement: { say: 'Une prise.', fill: [], add: [{ text: 'Le pêcheur lève les yeux.', seconds: 4, link: 'cut', start: 3, end: null }] }, problems: [] })
          : route === 'tools/action'
            ? () => ({ workflowName: 'LTX 2.5', seconds: 5.042 })
            : route === 'montages/save'
              ? body => ({ ...body.montage, createdAt: 'a', updatedAt: 'b' })
              : /^montages\/[^/]+$/.test(route)
                ? () => ({ montages: [] })
                : undefined,
  });
  const studio = await studioPage({ create_image: [image], create_video: [video] }, routes, { runs: [photo], waitForModel: async () => void order.push('model') });
  const { asked } = studio;
  try {
    const desk = studio.studio.bobine().desk();
    await until(() => desk.find('bobine-ask-words').length === 1);
    const field = desk.find('bobine-ask-words')[0];
    Object.assign(field, { value: 'Une prise qui part de la prise 3.' }).oninput();
    desk.find('bobine-ask-send')[0].onclick();
    await until(() => desk.find('bobine-ask-facts').length === 1);
    // The chat model first (it may have left the card for a creation), then the request, with the
    // project, the conversation open (its takes are of the project even before it is kept) and the bobine.
    assert.deepEqual(order, ['model', 'arrange']);
    const [, sent] = asked.find(([route]) => route === 'montages/arrange');
    assert.deepEqual(Object.keys(sent).sort(), ['conversationId', 'montage', 'previous', 'project', 'request']);
    assert.deepEqual([sent.project, sent.conversationId, sent.request, sent.previous, sent.montage.plans.length, sent.montage.schemaVersion], ['inbox', 'c1', 'Une prise qui part de la prise 3.', [], 0, 1]);
    // Its plan is laid by the page: a take to create that starts on the photo of the project; nothing is made.
    assert.equal(desk.find('bobine-ask-facts')[0].children.at(-1).textContent, '1 prise ajoutée');
    assert.equal(desk.find('bobine-line-words')[0].value, 'Le pêcheur lève les yeux.');
    assert.equal(asked.filter(([route, body]) => route === 'tools/action' && !body.estimate).length, 0);
  } finally {
    studio.restore();
  }
});

test('the Éclipse of the bobine: the chat model is brought back, then asked what happens in the take, in the conversation (0.6.146, 0.6.148)', async () => {
  const photo = { id: 'p1', conversationId: 'c0', mediaType: 'image', prompt: 'Un pêcheur', parameters: {}, outputs: [{ take: 3, originalUrl: '/media/p1', thumbUrl: '/thumb/p1' }] },
    video = { id: 'v', name: 'Clip', roles: {}, limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true },
    image = { id: 'i', name: 'Image', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    stored = {
      schemaVersion: 1, id: 'm1', name: 'Film', format: '16:9', width: 1344, height: 768, fps: 24, sounds: [],
      plans: [{ id: 'a', kind: 'video', todo: { prompt: '' }, from: 0, to: 5, frame: 'fit', volume: 1, photos: { start: { conversationId: 'c0', runId: 'p1', output: 0 } } }],
    },
    order = [];
  const routes = new Proxy({}, {
    get: (_, route) =>
      typeof route !== 'string'
        ? undefined
        : route === 'montages/describe'
          ? () => (order.push('describe'), { prompt: 'An old fisherman lifts his eyes towards the sea.' })
          : route === 'tools/action'
            ? () => ({ workflowName: 'LTX 2.5', seconds: 5.042 })
            : route === 'montages/save'
              ? body => ({ ...body.montage, createdAt: 'a', updatedAt: 'b' })
              : /^montages\/[^/]+\/m1$/.test(route)
                ? () => stored
                : /^montages\/[^/]+$/.test(route)
                  ? () => ({ montages: [{ id: 'm1', name: 'Film' }] })
                  : undefined,
  });
  const studio = await studioPage({ create_image: [image], create_video: [video] }, routes, { runs: [photo], waitForModel: async () => void order.push('model') });
  const { asked } = studio;
  try {
    const desk = studio.studio.bobine().desk();
    await until(() => desk.find('bobine-go-agent').length === 1 && !desk.find('bobine-go-agent')[0].disabled);
    desk.find('bobine-go-agent')[0].onclick();
    await until(() => desk.find('bobine-line-words')[0]?.value === 'An old fisherman lifts his eyes towards the sea.');
    // The chat model first (it may have left the card for a creation), then the request, in the
    // conversation: the take of another conversation of the project is named with its own.
    assert.deepEqual(order, ['model', 'describe']);
    const [, sent] = asked.find(([route]) => route === 'montages/describe');
    assert.deepEqual(sent, { verb: 'create_video', seconds: 5, start: { output: 'p1', conversation: 'c0' }, conversationId: 'c1' });
    // Its text is the text of the take, in its line; nothing is made.
    assert.equal(asked.filter(([route, body]) => route === 'tools/action' && !body.estimate).length, 0);
    // (0.6.148) A take made or removed elsewhere while the Bobine is shown: the Studio reads the takes
    // of the project again, and the Bobine shows them as they are now.
    assert.equal(desk.find('montage-take-number').length, 1);
    globalThis.document.body.dataset = { view: 'bobine' };
    studio.runs.push({ id: 'p2', conversationId: 'c0', mediaType: 'image', prompt: 'La mer', parameters: {}, outputs: [{ take: 4, originalUrl: '/media/p2', thumbUrl: '/thumb/p2' }] });
    studio.studio.invalidate();
    await studio.studio.open();
    await until(() => desk.find('montage-take-number').length === 2);
    assert.deepEqual(desk.find('montage-take-number').map(tile => tile.textContent), ['Prise 3', 'Prise 4']);
  } finally {
    studio.restore();
  }
});

test('(0.6.257) the camera before a video: its block under the images, its switch, its ball, its menu, sent with « Générer »; greyed under a model that does not take it', async () => {
  // (camera-avant-maquette.md, captures K00 to K04) Before 0.6.257 a piece added by « Ajouter » (0.6.211, LOTS.md,
  // lot 14): now a block always there with a model that takes the camera, « Au choix du modèle » to start, a switch
  // (his précision of 23/11: turned on and off), a menu of small balls. The sentence the application adds after the
  // prompt is said in the menu; the prompt stays as it is written.
  const image = { count: 1, media: ['image'] },
    shape = { limits: sizes, size: { width: 768, height: 448 }, settings: [], seeded: true, lengths: { seconds: [121 / 24], standard: 121 / 24 } },
    // (As the server describes them: `camera` for a new video of LTX 2.5 and of Wan 2.2.)
    ltx = { ...shape, id: 'l', name: 'LTX 2.5', family: 'ltx25', camera: true, roles: { start_image: image, end_image: image, reference: { count: 3, media: ['image'] } } },
    wan = { ...shape, id: 'w', name: 'Wan 2.2', family: 'wan22', camera: true, roles: { start_image: image } },
    omni = { ...shape, id: 'o', name: 'MiniMax H3 Omni', family: 'minimax_h3', roles: { reference: { count: 2, media: ['image'] } } },
    // (0.6.262) A model that reads the camera itself, its piece « Caméra » still among its own: never named by « Ajouter »
    // under the others (« Caméra · avec Wan 2.2 Caméra », greyed, while the block was just under it).
    reads = { ...shape, id: 'c', name: 'Wan 2.2 Caméra', family: 'wan22_camera', camera: { moves: ['dolly_in', 'pan_left'], speed: true }, roles: { start_image: image } },
    still = { id: 'i', name: 'Krea 2', family: 'krea2', roles: {}, limits: sizes, size: { width: 1024, height: 1024 }, settings: [] },
    // A take made with a camera, as its record keeps it: its prompt as written, the choice and the sentence beside it.
    made = {
      id: 'r1',
      mediaType: 'video',
      workflowId: 'l',
      workflowName: 'LTX 2.5',
      prompt: 'Le phare s’allume.',
      createdAt: '2026-11-22T10:00:00.000Z',
      parameters: { width: 768, height: 448, frames: 121, fps: 24, seed: 7, camera: { move: 'tilt_up', speed: 'fast' }, camera_prompt: 'The camera quickly tilts up.' },
      outputs: [{ take: 4, originalUrl: '/v/4.mp4', thumbUrl: '/t/4.webp' }],
    },
    plain = { ...made, id: 'r2', prompt: 'La mer.', parameters: { width: 768, height: 448, frames: 121, fps: 24, seed: 8 }, outputs: [{ take: 5, originalUrl: '/v/5.mp4', thumbUrl: '/t/5.webp' }] };
  // The parts of the block and of its menu, found again after each drawing. (0.6.262) Its menu closed in place stays in
  // the block until the Studio is drawn again: the one its ball says open only.
  const parts = body => {
    const block = body.find('studio-camera-block')[0],
      pane = block?.find('camera-block-ball')[0]?.attributes?.['aria-expanded'] === 'true' ? body.find('camera-menu')[0] : undefined;
    return {
      block,
      pane,
      toggle: block?.find('camera-block-switch')[0],
      remove: block?.find('camera-block-remove')[0],
      ball: block?.find('camera-block-ball')[0],
      face: block?.find('camera-ball')[0],
      name: block?.find('camera-block-name')[0],
      why: block?.find('camera-block-why')[0],
      speeds: block?.find('camera-block-speeds')[0],
      options: pane ? pane.find('camera-menu-option').filter(item => item.dataset.move) : [],
      model: pane?.find('camera-menu-option').find(item => !item.dataset.move),
      menuSpeeds: pane?.find('camera-menu-speeds')[0],
      added: pane?.find('camera-menu-added')[0],
    };
  };
  const pressed = speeds => speeds.children.filter(item => item.attributes['aria-pressed'] === 'true').map(item => item.dataset.speed),
    greyed = speeds => speeds.children.map(item => item.disabled);
  const page = await studioPage(
    { create_image: [still], create_video: [ltx, wan, omni, reads] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => new Promise(() => {}) },
    { runs: [] },
  );
  const { body, studio, asked, notices, pagePointers, restore } = page;
  try {
    page.mode(1);
    const add = () => body.find('studio-add')[0],
      menu = () => add().children[2],
      list = () => menu().children.map(item => (item.className === 'glass-menu-rule' ? '—' : [/is-off/.test(item.className), item.children.map(part => part.textContent).join(' · '), item.dataset.tip ?? ''])),
      now = () => parts(body),
      option = move => now().options.find(item => item.dataset.move === move),
      sentence = () => now().added.children[1].textContent,
      sent = () => asked.filter(([route]) => route === 'tools/action').at(-1)[1].arguments,
      generate = async () => {
        page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
        await settle();
      };
    // LTX 2.5 (K02): « Ajouter » has no camera any more; the block is under the plateau, in the column of the images.
    assert.equal(list().filter(line => line !== '—' && /^Caméra/.test(line[1])).length, 0, JSON.stringify(list()));
    const column = body.find('studio-inputs')[0];
    assert.deepEqual(column.children.map(block => block.className), ['studio-input-block studio-plateau', 'studio-input-block studio-camera-block']);
    let { block, toggle, ball, face, name, why, speeds } = now();
    assert.deepEqual([block.tag, block.attributes['aria-label'], block.find('camera-block-title')[0].textContent], ['section', 'Caméra', 'Caméra']);
    // At the start, « Au choix du modèle »: the switch off, the ball without a camera, the speed greyed with why.
    assert.deepEqual(
      [toggle.attributes.role, toggle.attributes['aria-checked'], toggle.attributes['aria-label'], toggle.title],
      ['switch', 'false', 'Caméra choisie', 'Activer : le dernier mouvement choisi revient'],
    );
    assert.deepEqual(
      [ball.attributes['aria-label'], ball.title, ball.attributes['aria-haspopup'], ball.attributes['aria-expanded'], ball.dataset.ai, ball.disabled],
      ['Caméra · Au choix du modèle', 'Choisir le mouvement', 'dialog', 'false', 'camera-move', false],
    );
    assert.deepEqual([name.textContent, why.hidden, speeds.dataset.ai, speeds.title, greyed(speeds), pressed(speeds)], [
      'Au choix du modèle', true, 'camera-speed', 'Choisissez d’abord un mouvement.', [true, true, true], [],
    ]);
    assert.deepEqual(speeds.children.map(item => item.children[0].textContent), ['Lente', 'Normale', 'Rapide']);
    // The ball: its drawing, no camera on it; the sign of an image at its middle while no image starts the video.
    assert.deepEqual([face.className, face.children[0].className, face.children[1].className, face.children[1].children[0].glyph], [
      'camera-ball is-playing', 'camera-ball-svg', 'camera-ball-subject is-picto', 'image',
    ]);
    assert.match(face.children[0].innerHTML, /^<svg class="camera-ball-art" viewBox="0 0 152 140" width="216"/);
    assert.doesNotMatch(face.children[0].innerHTML, /camera-ball-cam/);
    // A speed greyed says why; nothing is chosen.
    speeds.children[0].onclick();
    assert.deepEqual([notices.at(-1), toggle.attributes['aria-checked'], pressed(speeds)], ['Choisissez d’abord un mouvement.', 'false', []]);
    // On: the simplest movement, at the speed of the middle; drawn in place, the screen as it was (K00).
    const frame = body.find('studio-frame')[0];
    toggle.onclick();
    assert.deepEqual([block.className.includes('is-on'), toggle.attributes['aria-checked'], toggle.title], [true, 'true', 'Désactiver : le modèle choisit le mouvement']);
    assert.deepEqual([ball.attributes['aria-label'], name.textContent, greyed(speeds), pressed(speeds), speeds.title], [
      'Caméra · Travelling avant', 'Travelling avant', [false, false, false], ['normal'], 'À quelle vitesse la caméra bouge.',
    ]);
    assert.match(face.children[0].innerHTML, /class="camera-ball-cam" data-way="line" data-dx="-20\.9" data-dy="-6\.1"/);
    assert.equal(body.find('studio-frame')[0], frame, 'the screen is not drawn again');
    // An image in Début: it is the subject at the middle of the ball.
    add().children[0].onclick();
    menu().children.find(item => item.children?.[0]?.textContent === 'Image de début').onclick();
    const picker = page.page['studio-view'].children.find(child => child.tag === 'input');
    picker.files = [{ name: 'debut.png', type: 'image/png' }];
    await picker.onchange();
    await settle();
    ({ face } = now());
    assert.deepEqual([face.children[1].className, face.children[1].children[0].tag, face.children[1].children[0].src], ['camera-ball-subject', 'img', '/preview/debut.png']);

    // Its menu (K01), opened by the ball: at the right of the block, « Au choix du modèle » at its head, the movements
    // by family, each a small ball with its short name; the one chosen wears the ring.
    now().ball.onclick();
    const { pane, options, model, menuSpeeds, added } = now(),
      shown = body.find('studio-frame')[0];
    assert.deepEqual([pane.className, pane.attributes.role, pane.attributes['aria-label'], pane.find('studio-window-title')[0].textContent, now().ball.attributes['aria-expanded']], [
      'glass-menu camera-menu', 'dialog', 'Caméra', 'Caméra', 'true',
    ]);
    assert.deepEqual([model.attributes.role, model.attributes['aria-checked'], model.find('camera-menu-name')[0].textContent, model.children[0].className], [
      'radio', 'false', 'Au choix du modèle', 'camera-ball',
    ]);
    const groups = pane.find('camera-menu-cols')[0];
    assert.deepEqual([groups.attributes.role, groups.attributes['aria-label']], ['radiogroup', 'Mouvement']);
    assert.deepEqual(
      groups.children.map(group => [group.dataset.family, group.children[0].textContent, group.children[1].children.map(item => item.dataset.move + ':' + item.find('camera-menu-name')[0].textContent).join(' ')]),
      [
        ['0', 'Travelling', 'dolly_in:Avant dolly_out:Arrière truck_left:Gauche truck_right:Droite'],
        ['1', 'Zoom', 'zoom_in:Avant zoom_out:Arrière'],
        ['2', 'Panoramique', 'pan_left:Gauche pan_right:Droite tilt_up:Haut tilt_down:Bas'],
        ['3', 'Grue', 'crane_up:Montante crane_down:Descendante'],
        ['4', 'Orbite', 'orbit_left:Gauche orbit_right:Droite'],
        ['5', 'Sans déplacement', 'static:Fixe handheld:À l’épaule follow:Suivi'],
      ],
    );
    assert.equal(options.length, 17);
    assert.deepEqual(options.filter(item => item.className.includes('is-chosen')).map(item => [item.dataset.move, item.attributes['aria-checked']]), [['dolly_in', 'true']]);
    assert.deepEqual([option('pan_left').tag, option('pan_left').attributes.role, option('pan_left').attributes['aria-label'], option('pan_left').title], ['button', 'radio', 'Panoramique gauche', 'Panoramique gauche']);
    // Each holds its small ball of 70 px, its movement drawn on it.
    for (const item of options) assert.match(item.children[0].children[0].innerHTML, /width="70"/);
    // What the words alone do not hold (the real videos of 22/11: an orbit, a crane) stays there, greyed, « pas fiable »
    // under its name, why with its name and under the pointer; pressed, it says why and is not chosen.
    assert.deepEqual(
      options.filter(item => item.className.includes('is-off')).map(item => [item.dataset.move, item.attributes['aria-disabled'], item.find('camera-menu-note')[0].textContent, item.children[0].className, item.attributes['aria-label'], item.title]),
      [
        ['crane_up', 'true', 'pas fiable', 'camera-ball is-dim', 'Grue montante, pas fiable. Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.', 'Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.'],
        ['crane_down', 'true', 'pas fiable', 'camera-ball is-dim', 'Grue descendante, pas fiable. Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.', 'Pas fiable par les mots seuls : à l’essai, la caméra a fini en plongée.'],
        ['orbit_left', 'true', 'pas fiable', 'camera-ball is-dim', 'Orbite gauche, pas fiable. Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.', 'Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.'],
        ['orbit_right', 'true', 'pas fiable', 'camera-ball is-dim', 'Orbite droite, pas fiable. Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.', 'Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.'],
      ],
    );
    assert.equal(options.filter(item => !item.className.includes('is-off') && (item.attributes['aria-disabled'] || item.find('camera-menu-note').length)).length, 0);
    option('orbit_left').onclick();
    assert.deepEqual([notices.at(-1), option('orbit_left').attributes['aria-checked'], option('dolly_in').attributes['aria-checked']], ['Pas fiable par les mots seuls : à l’essai, la caméra est restée fixe.', 'false', 'true']);
    // The speed at its foot, and what goes to the model under it (« Ajouté au prompt : »), said as it changes.
    assert.deepEqual([pane.find('camera-menu-pace')[0].children[0].textContent, menuSpeeds.attributes.role, menuSpeeds.attributes['aria-label'], pressed(menuSpeeds)], ['Vitesse', 'group', 'Vitesse', ['normal']]);
    assert.deepEqual([added.attributes['aria-live'], added.children[0].textContent, sentence()], ['polite', 'Ajouté au prompt :', '« The camera dollies in. »']);
    assert.deepEqual(pane.children.map(part => part.className), ['camera-menu-head', 'camera-menu-cols', 'camera-menu-pace', 'camera-menu-added']);
    // A speed, another movement: in place, the menu as it is; the block says the same.
    menuSpeeds.children[0].onclick();
    assert.deepEqual([sentence(), now().pane, pressed(menuSpeeds), pressed(now().speeds), now().ball.attributes['aria-label']], [
      '« The camera slowly dollies in. »', pane, ['slow'], ['slow'], 'Caméra · Travelling avant, lent',
    ]);
    option('tilt_up').onclick();
    assert.deepEqual([sentence(), now().name.textContent, options.filter(item => item.className.includes('is-chosen')).map(item => item.dataset.move)], ['« The camera slowly tilts up. »', 'Panoramique vers le haut', ['tilt_up']]);
    // A movement without speed: its speeds greyed with why, none pressed; the speed chosen comes back after it.
    option('static').onclick();
    assert.deepEqual([sentence(), greyed(menuSpeeds), pressed(menuSpeeds), menuSpeeds.title, greyed(now().speeds), now().speeds.title], [
      '« The camera stays perfectly still, a locked-off static shot. »', [true, true, true], [], 'Ce mouvement n’a pas de vitesse.', [true, true, true], 'Ce mouvement n’a pas de vitesse.',
    ]);
    option('pan_left').onclick();
    assert.deepEqual([sentence(), greyed(menuSpeeds), pressed(menuSpeeds), now().ball.attributes['aria-label']], ['« The camera slowly pans to the left. »', [false, false, false], ['slow'], 'Caméra · Panoramique gauche, lent']);
    assert.equal(body.find('studio-frame')[0], shown, 'the screen is not drawn again for a choice');
    // Drawn again, it is still open, on what was chosen.
    studio.render();
    assert.deepEqual([now().options.filter(item => item.className.includes('is-chosen')).map(item => item.dataset.move), pressed(now().menuSpeeds), sentence()], [['pan_left'], ['slow'], '« The camera slowly pans to the left. »']);
    // « Au choix du modèle »: off, nothing added; the switch says it.
    now().model.onclick();
    assert.deepEqual([now().model.attributes['aria-checked'], now().added.children[0].textContent, sentence(), now().toggle.attributes['aria-checked'], now().name.textContent], [
      'true', 'Rien n’est ajouté au prompt : le modèle choisit le mouvement.', '', 'false', 'Au choix du modèle',
    ]);
    // (His précision) On again: the last movement chosen comes back, with its speed.
    now().toggle.onclick();
    assert.deepEqual([now().ball.attributes['aria-label'], now().options.find(item => item.className.includes('is-chosen')).dataset.move, sentence()], ['Caméra · Panoramique gauche, lent', 'pan_left', '« The camera slowly pans to the left. »']);
    // (0.6.262) Just after the ball in the order of the page, so that Maj+Tab from its first control goes back to the
    // ball and Tab from its last to what follows it (last of the block, they went to « Rapide » of the block and to
    // Image, Vidéo, Son). By the arrows, as our lists of glass: one stop in the order of Tab, the movement chosen; the
    // greyed ones passed over; Home and End. Tab past « Rapide », or Maj+Tab before the stop, closes it.
    const menus = () => (now().pane ? 1 : 0),
      stop = () => [now().model, ...now().options].filter(item => item.tabIndex === 0).map(item => item.dataset.move ?? 'model'),
      focused = () => globalThis.document.activeElement,
      keys = (pane, list) =>
        list.map(([key, shiftKey = false]) => {
          let prevented = false;
          pane.onkeydown({ key, shiftKey, preventDefault: () => (prevented = true), stopPropagation() {} });
          return [focused().dataset.move ?? focused().dataset.speed ?? 'model', prevented];
        }),
      // Its controls take the focus; it says when it is taken out of the top layer (glass-menu.mjs, closePopup).
      watched = open => {
        for (const item of [open.model, ...open.options, ...open.menuSpeeds.children]) item.focus = () => (globalThis.document.activeElement = item);
        const seen = { closed: 0 };
        open.pane.matches = selector => selector === ':popover-open' && !seen.closed;
        open.pane.hidePopover = () => seen.closed++;
        return seen;
      };
    let open = now(),
      seen = watched(open);
    assert.deepEqual(open.block.children.map(part => part.className.split(' ').at(-1)), [
      'camera-block-head', 'camera-block-ball', 'camera-menu', 'camera-block-name', 'camera-block-why', 'camera-block-speeds',
    ]);
    assert.deepEqual(stop(), ['pan_left']);
    globalThis.document.activeElement = open.options.find(item => item.dataset.move === 'pan_left');
    assert.deepEqual(keys(open.pane, [['ArrowRight'], ['ArrowDown'], ['ArrowDown'], ['ArrowDown'], ['ArrowUp'], ['ArrowLeft'], ['End'], ['ArrowDown'], ['Home'], ['ArrowUp']]), [
      ['pan_right', true], ['tilt_up', true], ['tilt_down', true], ['static', true], ['tilt_down', true], ['tilt_up', true], ['follow', true], ['model', true], ['model', true], ['follow', true],
    ]);
    // The arrows move the focus only: « Suivi » is the stop now, « Panoramique gauche » is still the one chosen.
    assert.deepEqual([stop(), now().options.filter(item => item.attributes['aria-checked'] === 'true').map(item => item.dataset.move)], [['follow'], ['pan_left']]);
    // Tab from the stop goes to the speeds, the menu open; Maj+Tab from « Lente » too. Past « Rapide »: closed.
    assert.deepEqual([keys(open.pane, [['Tab']]), menus(), seen.closed], [[['follow', false]], 1, 0]);
    globalThis.document.activeElement = open.menuSpeeds.children[0];
    assert.deepEqual([keys(open.pane, [['Tab', true]]), menus(), seen.closed], [[['slow', false]], 1, 0]);
    globalThis.document.activeElement = open.menuSpeeds.children[2];
    keys(open.pane, [['Tab']]);
    assert.deepEqual([menus(), now().ball.attributes['aria-expanded'], seen.closed], [0, 'false', 1]);
    // Open again on the movement chosen; Maj+Tab before it closes it.
    now().ball.onclick();
    open = now();
    seen = watched(open);
    assert.deepEqual(stop(), ['pan_left']);
    globalThis.document.activeElement = open.options.find(item => item.tabIndex === 0);
    keys(open.pane, [['Tab', true]]);
    assert.deepEqual([menus(), now().ball.attributes['aria-expanded'], seen.closed], [0, 'false', 1]);
    // The ball closes it in place, the focus kept on it (0.6.262: the Studio was drawn again, the focus fell on the
    // page), and opens it again; a press beside its block closes it, Échap too.
    now().ball.onclick();
    seen = watched(now());
    const opener = now().ball,
      screen = body.find('studio-frame')[0];
    let refocused = 0;
    opener.focus = () => refocused++;
    opener.onclick();
    assert.deepEqual([menus(), now().ball === opener, opener.attributes['aria-expanded'], refocused, seen.closed, body.find('studio-frame')[0] === screen], [0, true, 'false', 1, 1, true]);
    now().ball.onclick();
    assert.equal(menus(), 1);
    pagePointers.forEach(listener => listener({ target: { closest: () => null } }));
    studio.render();
    assert.equal(menus(), 0);
    now().ball.onclick();
    now().pane.onkeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    studio.render();
    assert.equal(menus(), 0);
    // « Ajouter » or « Plus de réglages » opened: one thing at a time.
    now().ball.onclick();
    add().children[0].onclick();
    studio.render();
    assert.equal(menus(), 0);
    add().children[0].onclick();

    // « Générer »: the prompt as it is written, the movement and its speed beside it. The server adds the sentence.
    page.prompt().value = 'Le pêcheur lève les yeux';
    page.prompt().oninput();
    await generate();
    assert.deepEqual([sent().prompt, sent().camera, sent().camera_speed], ['Le pêcheur lève les yeux', 'pan_left', 'slow']);
    assert.equal(page.prompt().value, 'Le pêcheur lève les yeux', 'nothing is written in the prompt of the Studio');
    // While it is made: the block is there, held, why on a press; its menu does not open.
    ({ toggle, ball } = now());
    assert.deepEqual([toggle.disabled, ball.disabled, ball.title, greyed(now().speeds)], [true, true, 'Génération en cours dans cette conversation : attendez sa fin.', [true, true, true]]);
    ball.onclick();
    toggle.onclick();
    assert.deepEqual([notices.slice(-2), body.find('camera-menu').length, sent().camera], [['Génération en cours dans cette conversation : attendez sa fin.', 'Génération en cours dans cette conversation : attendez sa fin.'], 0, 'pan_left']);
  } finally {
    restore();
  }

  // Another Studio, nothing being made: what goes with each model, what is kept, a take looked at.
  const next = await studioPage(
    { create_image: [still], create_video: [ltx, wan, omni, reads] },
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs: [made, plain] },
  );
  try {
    const { body, studio, asked, notices } = next;
    next.mode(1);
    const add = () => body.find('studio-add')[0],
      menu = () => add().children[2],
      list = () => menu().children.map(item => (item.className === 'glass-menu-rule' ? '—' : [/is-off/.test(item.className), item.children.map(part => part.textContent).join(' · '), item.dataset.tip ?? ''])),
      model = id => {
        const chosen = body.find('studio-model-pick')[0];
        chosen.value = id;
        chosen.onchange();
      },
      now = () => parts(body),
      pick = move => {
        now().ball.onclick();
        now().options.find(item => item.dataset.move === move).onclick();
      },
      sent = () => asked.filter(([route]) => route === 'tools/action').at(-1)[1].arguments,
      generate = async () => {
        next.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
        await settle();
      },
      write = text => {
        next.prompt().value = text;
        next.prompt().oninput();
      };
    // The Studio opens on the settings of the newest take of its conversation: its camera with them, as its prompt.
    assert.deepEqual([now().toggle.attributes['aria-checked'], now().ball.attributes['aria-label'], next.prompt().value], ['true', 'Caméra · Panoramique vers le haut, rapide', 'Le phare s’allume.']);
    // Off: nothing of it is sent.
    now().toggle.onclick();
    model('l');
    write('Un phare');
    await generate();
    assert.deepEqual(['camera' in sent(), 'camera_speed' in sent()], [false, false]);
    // On again: the camera of that take comes back, not the movement the switch starts from.
    now().toggle.onclick();
    assert.equal(now().ball.attributes['aria-label'], 'Caméra · Panoramique vers le haut, rapide');
    // A movement without speed goes alone.
    pick('handheld');
    await generate();
    assert.deepEqual([sent().camera, 'camera_speed' in sent()], ['handheld', false]);
    // Wan 2.2 takes it too: the same block, the same choice.
    model('w');
    assert.deepEqual([now().block.className.includes('is-off'), now().toggle.attributes['aria-checked'], now().ball.attributes['aria-label']], [false, 'true', 'Caméra · À l’épaule']);
    // A model that does not (capture 96): the block kept, greyed, why under its name, its × in place of the switch; a
    // line under the plateau says it will not go; its ball says why on a press, opens no menu; nothing of it is sent;
    // « Ajouter » says nothing of a camera.
    model('o');
    const kept = now();
    assert.deepEqual(
      [kept.block.className.includes('is-off'), kept.toggle ?? null, kept.remove.attributes['aria-label'], kept.remove.title, kept.ball.disabled, kept.ball.title, kept.why.textContent, kept.why.hidden, kept.name.textContent, greyed(kept.speeds), kept.face.className],
      [true, null, 'Retirer la caméra', 'Retirer', true, 'Caméra gardée : MiniMax H3 Omni ne la prend pas.', 'Caméra gardée : MiniMax H3 Omni ne la prend pas.', false, 'À l’épaule', [true, true, true], 'camera-ball is-playing is-dim'],
    );
    assert.deepEqual(body.find('studio-plateau-note').map(line => line.children[1].textContent), ['La caméra ne partira pas avec MiniMax H3 Omni.']);
    // (Its block alone: no piece of it on the plateau any more.)
    assert.deepEqual([body.find('studio-camera').length, body.find('studio-kept').length], [0, 0]);
    kept.ball.onclick();
    assert.deepEqual([notices.at(-1), body.find('camera-menu').length], ['Caméra gardée : MiniMax H3 Omni ne la prend pas.', 0]);
    assert.equal(list().filter(line => line !== '—' && /Caméra/.test(line[1])).length, 0, JSON.stringify(list()));
    await generate();
    assert.deepEqual(['camera' in sent(), 'camera_speed' in sent()], [false, false]);
    // Back with LTX 2.5: the block as it was.
    model('l');
    assert.deepEqual([now().block.className.includes('is-off'), now().ball.attributes['aria-label']], [false, 'Caméra · À l’épaule']);
    // Kept under a model that does not take it, its × takes it away, and the line with it; the block is back off
    // under LTX 2.5, its switch brings the movement back.
    model('o');
    now().remove.onclick();
    assert.deepEqual([body.find('studio-camera-block').length, body.find('studio-plateau-note').length], [0, 0]);
    model('l');
    assert.deepEqual([now().toggle.attributes['aria-checked'], now().name.textContent], ['false', 'Au choix du modèle']);
    now().toggle.onclick();
    assert.equal(now().ball.attributes['aria-label'], 'Caméra · À l’épaule');
    // Image: no camera anywhere; no model of images takes one, so no list offers it there (nothing to add at all).
    next.mode(0);
    assert.deepEqual([body.find('studio-camera-block').length, body.find('studio-camera').length, body.find('studio-add').length], [0, 0, 0]);

    // A take made with a camera, looked at (« Afficher dans le Studio »): its prompt as it was written, its camera
    // back in the block; « Générer » sends them as they were, the sentence is never twice in the prompt.
    studio.show(made);
    assert.deepEqual([body.dataset.mode, next.prompt().value, now().ball.attributes['aria-label']], ['video', 'Le phare s’allume.', 'Caméra · Panoramique vers le haut, rapide']);
    // One made without: the block off.
    studio.show(plain);
    assert.deepEqual([next.prompt().value, now().toggle.attributes['aria-checked'], now().name.textContent], ['La mer.', 'false', 'Au choix du modèle']);
    // (0.6.212) One made with a movement the list greys since then, looked at: its prompt, the block off (none can be
    // made with it any more), and « Générer » sends none.
    studio.show({ ...made, id: 'r3', parameters: { ...made.parameters, camera: { move: 'orbit_left', speed: 'slow' }, camera_prompt: 'The camera slowly orbits around the subject to the left.' } });
    assert.deepEqual([next.prompt().value, now().toggle.attributes['aria-checked']], ['Le phare s’allume.', 'false']);
    await generate();
    assert.deepEqual([sent().prompt, 'camera' in sent(), 'camera_speed' in sent()], ['Le phare s’allume.', false, false]);
    // (0.6.262) A piece kept for another model (the end image of LTX 2.5, under Wan 2.2): its line under the plateau,
    // and the block on one row, its ball at the left (moodix.css), so that the column does not scroll (40 to 46 px too
    // many at 1912 × 948 and 1440 × 900). Kept itself, under MiniMax H3 Omni, the block is its one line (is-off).
    model('l');
    now().toggle.onclick();
    add().children[0].onclick();
    menu().children.find(item => item.children?.[0]?.textContent === 'Image de fin').onclick();
    const picker = next.page['studio-view'].children.find(child => child.tag === 'input');
    picker.files = [{ name: 'fin.png', type: 'image/png' }];
    await picker.onchange();
    await settle();
    const shape = () => [now().block.className.includes('is-row'), now().block.className.includes('is-off'), body.find('studio-plateau-note').map(line => line.children[1].textContent)];
    assert.deepEqual(shape(), [false, false, []]);
    model('w');
    assert.deepEqual(shape(), [true, false, ['L’image de fin ne partira pas avec Wan 2.2.']]);
    model('o');
    assert.deepEqual(shape(), [false, true, ['L’image de fin et la caméra ne partiront pas avec MiniMax H3 Omni.']]);
  } finally {
    next.restore();
  }
});

test('(0.6.211) the styles of the camera: its case with a full line, its window with its small scenes and the sentence added', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    rule = selector => {
      const at = css.indexOf('\n' + selector + ' {');
      assert.ok(at >= 0, selector);
      return css.slice(at, css.indexOf('}', at));
    };
  assert.match(rule('#studio-view .studio-camera .studio-slot.is-filled .studio-slot-pick'), /border: 1px solid rgba\(238, 232, 222, 0\.24\);/);
  // (0.6.215) Its window: wide for six small scenes a row, whole (it never scrolls); the name under a scene and
  // « pas fiable » are read: 12 px.
  assert.match(rule('#studio-view .studio-camera-window'), /width: 566px;\s+max-width: none;\s+max-height: none;\s+overflow: visible;/);
  assert.match(rule('.studio-camera-groups'), /grid-template-columns: repeat\(6, 82px\);/);
  for (const size of [2, 3, 4]) assert.match(rule(`.studio-camera-group[data-size='${size}']`), new RegExp(`grid-column: span ${size};`));
  assert.match(rule('#studio-view .studio-camera-move'), /width: 82px;[\s\S]*font: 400 12px\/1\.2 var\(--font-ui\);/);
  assert.match(rule('.studio-camera-move-note'), /font: 400 12px\/1 var\(--font-ui\);/);
  assert.match(rule('.studio-camera-move.is-off .camera-scene'), /opacity: 0\.42;/);
  assert.match(rule('.studio-camera-move.is-chosen .camera-scene'), /outline: 1\.5px solid var\(--text-1\);/);
  assert.match(rule("#studio-view .studio-camera-speed[aria-pressed='true']"), /color: var\(--text-1\);/);
  // The scenes: still, then played under the pointer, under the focus, and in a loop for the one chosen; at the
  // speed chosen in the window.
  assert.match(rule('.camera-scene'), /width: 82px;\s+height: 46px;\s+overflow: hidden;/);
  assert.match(rule('.camera-scene-world,\n.camera-scene-zoom,\n.camera-scene-subject'), /animation-duration: var\(--camera-time, 2\.6s\);[\s\S]*animation-iteration-count: infinite;\s+animation-play-state: paused;/);
  assert.match(rule('.studio-camera-move:is(:hover, :focus-visible, .is-chosen) :is(.camera-scene-world, .camera-scene-zoom, .camera-scene-subject)'), /animation-play-state: running;/);
  assert.match(rule(".studio-camera-window[data-speed='slow']"), /--camera-time: 4\.2s;/);
  assert.match(rule(".studio-camera-window[data-speed='fast']"), /--camera-time: 1\.5s;/);
  // Every movement of the list has a scene that moves: an animation of its own, which exists.
  const { CAMERA_MOVES } = await import('../public/camera.mjs');
  const names = new Set();
  for (const move of CAMERA_MOVES) {
    const moved = [...css.matchAll(new RegExp(`\\n\\.camera-scene\\[data-move='${move.id}'\\] \\.camera-scene-(?:world|zoom|subject) \\{([^}]*)\\}`, 'g'))];
    assert.ok(moved.length >= 1, move.id);
    const name = moved[0][1].match(/animation-name: ([a-z-]+);/)?.[1];
    assert.ok(name && css.includes(`\n@keyframes ${name} {`), `${move.id} : ${name}`);
    names.add(name);
  }
  assert.equal(names.size, CAMERA_MOVES.length, 'one animation each');
  // What each shows: an orbit turns the world about the subject, a zoom grows the picture as one, a travelling
  // brings the camera nearer, a panoramic turns it where it stands.
  const frames = name => css.slice(css.indexOf(`\n@keyframes ${name} {`), css.indexOf('\n}\n', css.indexOf(`\n@keyframes ${name} {`)));
  assert.match(frames('camera-orbit-left'), /translate3d\(0px, 8px, -30px\) rotateY\(-8deg\);[\s\S]*translate3d\(0px, 8px, -30px\) rotateY\(58deg\);/);
  assert.match(frames('camera-zoom-in'), /transform: scale\(1\);[\s\S]*transform: scale\(1\.55\);/);
  assert.match(frames('camera-dolly-in'), /translate3d\(0px, 8px, -34px\) rotateY\(0deg\);[\s\S]*translate3d\(0px, 8px, -2px\) rotateY\(0deg\);/);
  assert.match(frames('camera-pan-left'), /rotateY\(6deg\) translateZ\(-90px\)[\s\S]*rotateY\(-9deg\) translateZ\(-90px\)/);
  // Stopped for who asks for less motion.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.camera-scene-world,\n  \.camera-scene-zoom,\n  \.camera-scene-subject \{\n    animation: none;/);  // What is added to the prompt is read: 13 px, never under 12.
  assert.match(rule('.studio-camera-added'), /font: 400 12px\/1\.4 var\(--font-ui\);/);
  assert.match(rule('.studio-camera-sentence'), /font: 400 13px\/1\.45 var\(--font-ui\);/);
  // Its sign is one of the page's.
  assert.match(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), /<symbol id="i-camera" viewBox="0 0 24 24">/);
});

test('(0.6.211, 0.6.257) the camera is for a new video made by hand: no block in a continuation, none under a proposal of Moodix AI; it is back after them', async () => {
  // A continuation starts from its clip alone, and a proposal has the pieces Moodix AI chose: the camera the user
  // had set is neither shown nor sent there, and waits for the next video made by hand. (0.6.257: its block, on.)
  const { tools, runs } = continuing();
  // (Its two tools with the camera, to see that the Studio itself leaves it out of a continuation: the server
  // gives it to a new video only.)
  for (const tool of [...tools.create_video, ...tools.extend_video]) tool.camera = true;
  let page = await studioPage(
    tools,
    { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    { runs },
  );
  const film = body => body.find('studio-camera-block')[0].find('camera-block-switch')[0].onclick(),
    menuOf = body => {
      body.find('studio-camera-block')[0].find('camera-block-ball')[0].onclick();
      return body.find('camera-menu').length;
    };
  try {
    const { body, asked } = page,
      sent = () => asked.filter(([route]) => route === 'tools/action').at(-1)[1],
      generate = async () => {
        page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
        await settle();
      };
    page.mode(1);
    film(body);
    assert.equal(menuOf(body), 1);
    // « Prolonger »: its clip, no camera, its menu gone with it; nothing of it is sent.
    prolonger(body).onclick();
    assert.deepEqual([prolonged(body).length, body.find('studio-camera-block').length, body.find('camera-menu').length, body.find('studio-plateau-note').length], [1, 0, 0, 0]);
    page.prompt().value = 'Il se lève.';
    page.prompt().oninput();
    await generate();
    assert.deepEqual([sent().name, 'camera' in sent().arguments, 'camera_speed' in sent().arguments], ['extend_video', false, false]);
    // The continuation left: the camera is in its block again, as it was set, and goes with a new video.
    prolongWindow(body).way('Retirer').onclick();
    assert.deepEqual([prolonged(body).length, body.find('studio-camera-block')[0].find('camera-block-ball')[0].attributes['aria-label']], [0, 'Caméra · Travelling avant']);
    await generate();
    assert.deepEqual([sent().name, sent().arguments.camera], ['create_video', 'dolly_in']);
  } finally {
    page.restore();
  }
  // Under a proposal of Moodix AI: no camera of the user among its pieces; refused, the camera is back.
  const { clip, request } = proposalOf();
  page = await studioPage({ create_video: [{ ...clip, camera: true }] }, {});
  try {
    page.mode(1);
    film(page.body);
    assert.equal(page.body.find('studio-camera-block')[0].find('camera-block-switch')[0].attributes['aria-checked'], 'true');
    const answer = page.studio.propose(request, new AbortController().signal);
    await settle();
    assert.deepEqual([page.studio.proposing(), page.body.find('studio-camera-block').length, page.body.find('camera-menu').length, page.body.find('studio-plateau-note').length], [true, 0, 0, 0]);
    page.studio.decline();
    assert.equal(await answer, 'deny');
    assert.equal(page.body.find('studio-camera-block')[0].find('camera-block-switch')[0].attributes['aria-checked'], 'true');
  } finally {
    page.restore();
  }
});

test('(0.6.240) « Changer la caméra » d’une vidéo faite : son bouton sur un clip, le clip et sa caméra sur le plateau, l’outil, ce qui est envoyé', async () => {
  // (Maquette du 22/11, claude_design/maquettes-camera) A clip filmed again from a camera placed by hand, by a
  // model made for it (verb refilm_video): one pose held, or two, the camera going from the first to the second.
  const { tools, runs } = continuing(),
    routes = { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    // What the server says its model holds: how far its bars go, its two zones (ellipses), how near the camera of
    // the clip nothing is made.
    bounds = {
      azimuth: { min: -90, max: 90 },
      elevation: { min: -35, max: 45 },
      distance: { min: 0.5, max: 2 },
      zones: { safe: { azimuth: 45, up: 30, down: 20 }, maybe: { azimuth: 90, up: 45, down: 35 } },
      near: 5,
    },
    second = body => body.find('studio-item').find(tile => tile.dataset.id === 'film').find('studio-item-second');
  // Without a model that films a video again: no button of it on a clip.
  let page = await studioPage(tools, routes, { runs });
  try {
    page.mode(1);
    assert.equal(second(page.body).length, 0);
  } finally {
    page.restore();
  }
  // With one that lacks its files: the button greyed, with why; pressed, it says so and changes nothing.
  const film = { id: 'r', name: 'LTX 2.5', verb: 'refilm_video', family: 'ltx25', roles: { source: { count: 1, media: ['video'], required: true } }, settings: [], refilm: bounds };
  page = await studioPage({ ...tools, refilm_video: [{ ...film, unavailable: 'Fichier absent : crossview-warp.safetensors.' }] }, routes, { runs });
  try {
    page.mode(1);
    const [held] = second(page.body);
    assert.deepEqual(
      [held.className, held.attributes['aria-disabled'], held.title],
      ['studio-item-main studio-item-second is-off', 'true', 'Changer la caméra : la même vidéo, filmée d’un autre angle\nFichier absent : crossview-warp.safetensors.'],
    );
    held.onclick();
    assert.deepEqual([page.notices.at(-1), page.body.find('studio-refilm').length], ['Fichier absent : crossview-warp.safetensors.', 0]);
  } finally {
    page.restore();
  }

  page = await studioPage({ ...tools, refilm_video: [film] }, routes, { runs });
  try {
    const { body, asked } = page,
      sent = () => asked.filter(([route]) => route === 'tools/action').at(-1)[1],
      generate = async () => {
        page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
        await settle();
      },
      pick = () => body.find('studio-orbit')[0].find('studio-slot-pick')[0],
      // (Its window closes with each creation: opened again from its case when it is not there.)
      pane = () => body.find('studio-orbit-window')[0] ?? (pick().onclick(), body.find('studio-orbit-window')[0]),
      modes = () => pane().find('studio-orbit-modes')[0].children,
      ends = () => pane().find('studio-orbit-ends')[0],
      bar = name => pane().find('studio-orbit-bar').find(line => line.children[0].textContent === name).children[1],
      told = () => [pane().find('studio-window-said')[0].textContent, pane().find('studio-window-said')[0].dataset.zone],
      mark = name => pane().find('studio-orbit-mark').find(item => item.className.includes('is-' + name)),
      guide = () => body.find('studio-guide')[0],
      world = () => guide().find('studio-guide-world')[0],
      warn = () => guide().find('studio-guide-warn')[0],
      go = () => body.find('studio-go')[0];
    page.mode(1);
    // Its button on the clip, beside « Prolonger »: its sign, its name and the clip's, its words under the pointer.
    const [button] = second(body);
    assert.deepEqual([button.className, button.children[0].glyph, button.title], ['studio-item-main studio-item-second', 'camera', 'Changer la caméra : la même vidéo, filmée d’un autre angle']);
    assert.match(button.attributes['aria-label'], /^Changer la caméra · /);
    assert.equal(body.find('studio-item').find(tile => tile.dataset.id === 'fox').find('studio-item-second').length, 0, 'none on an image');
    button.onclick();
    // Its tool open at once: it is what the action is for.
    assert.equal(body.find('studio-orbit-window').length, 1);
    // The plateau: the clip « À refilmer », then its camera; no line of time, no other case.
    const [row] = body.find('studio-refilm');
    assert.deepEqual([row.className, row.attributes['aria-label'], row.children.map(piece => piece.find('studio-piece-word')[0].textContent)], [
      'studio-plateau-row studio-frames studio-refilm', 'Vidéo à refilmer et caméra', ['À refilmer', 'Caméra'],
    ]);
    const clip = body.find('studio-prolong')[0];
    assert.match(clip.find('studio-slot-pick')[0].title, /^À refilmer · /);
    assert.deepEqual([clip.find('studio-slot-badge')[0].children[0].glyph, clip.find('studio-slot-remove')[0].attributes['aria-label']], ['camera', 'Retirer la vidéo à refilmer']);
    assert.deepEqual([body.find('studio-span').length, body.find('studio-add').length], [0, 0]);
    // The tool, open at once: one pose held, a little to the right and above; its three bars within what the
    // model holds; on the sphere, that camera alone.
    assert.deepEqual([pane().className, pane().attributes.role, pane().attributes['aria-label'], pick().title, pick().attributes['aria-expanded'], pick().children[0].glyph], [
      'glass-menu studio-piece-window studio-orbit-window', 'dialog', 'Caméra', 'Caméra · fixe, 30° · 10°', 'true', 'camera',
    ]);
    assert.deepEqual(modes().map(choice => [choice.children[0].textContent, choice.dataset.mode, choice.attributes['aria-pressed']]), [
      ['Fixe', 'fixed', 'true'],
      ['Du début à la fin', 'move', 'false'],
    ]);
    assert.deepEqual(
      pane().find('studio-orbit-bar').map(line => [line.children[0].textContent, line.children[1].type, line.children[1].min, line.children[1].max, line.children[1].step, line.children[1].value, line.children[2].textContent]),
      [
        ['Azimut', 'range', '-90', '90', '5', '30', '30°'],
        ['Hauteur', 'range', '-35', '45', '1', '10', '10°'],
        ['Distance', 'range', '0.5', '2', '0.05', '1', '× 1,0'],
      ],
    );
    assert.deepEqual(pane().find('studio-orbit-scale').map(scale => scale.children.map(word => word.textContent).join(' ')), ['Gauche Face Droite', 'Bas Haut', 'Serré Large']);
    assert.deepEqual(pane().find('studio-orbit-bar').map(line => [line.className, line.children[1].disabled]), Array(3).fill(['studio-orbit-bar', false]));
    assert.deepEqual([ends().hidden, mark('fixed').hidden, mark('start').hidden, mark('end').hidden, pane().find('studio-orbit-trail')[0].hidden, pane().find('studio-orbit-play')[0].hidden], [true, false, true, true, true, true]);
    assert.deepEqual(pane().find('studio-orbit-zone').map(zone => [zone.dataset.zone, zone.textContent]), [['safe', 'sûr'], ['maybe', 'possible'], ['out', 'hors du modèle']]);
    assert.match(pane().find('studio-orbit-ring')[0].style.background, /^conic-gradient\(var\(--orbit-out\) 0deg 90deg, var\(--orbit-maybe\) 90deg 135deg, var\(--orbit-safe\) 135deg 225deg/);
    assert.deepEqual(told(), ['Angle sûr', 'safe']);
    // (Short words, read whole beside « Aperçu » and « Retirer »; what the angles are counted from is under the sphere.)
    assert.equal(body.find('studio-orbit-face')[0].textContent, 'face : la caméra de la vidéo');
    // The simple guide on the screen: the picture of the clip, seen from that pose; it says it is no preview.
    assert.deepEqual([guide().find('studio-guide-said')[0].textContent, guide().find('studio-guide-card').at(-1).children[0]?.src, world().style.transform, warn().hidden], [
      'Guide, pas le rendu : l’image de la vidéo, vue de la caméra réglée', runs[1].outputs[0].thumbUrl, 'translateZ(0cqw) rotateX(-10deg) rotateY(-30deg)', true,
    ]);
    // « Générer » is « Changer la caméra », lit without a prompt: the clip says what is filmed.
    // Its field is empty and closed: the prompt of the video being written is neither shown nor sent.
    assert.deepEqual(
      [body.find('studio-go-label')[0].textContent, go().disabled, page.prompt().placeholder, page.prompt().value, page.prompt().disabled],
      ['Changer la caméra', false, 'Rien à écrire : seule la caméra change.', '', true],
    );
    // A bar moved: its value, the name of the piece, the guide and what the tool says of that angle follow in place.
    const window = pane(),
      // (Its words when it is lit: those of « Générer », its keys with them.)
      lit = 'Générer (Ctrl+Entrée)',
      count = () => asked.filter(([route]) => route === 'tools/action').length;
    assert.equal(go().title, lit);
    // The camera of the clip itself, or hardly another: nothing is made of it. « Changer la caméra » is greyed and
    // says why, in place; its keys make nothing either.
    bar('Azimut').value = '0';
    bar('Azimut').oninput();
    bar('Hauteur').value = '3';
    bar('Hauteur').oninput();
    assert.deepEqual([told(), warn().hidden, warn().textContent, warn().dataset.zone], [['Trop près de l’origine', 'near'], false, 'Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.', 'near']);
    assert.deepEqual([go().disabled, go().title, pane()], [true, 'Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.', window]);
    const before = count();
    await generate();
    // (Its window stays open, and the screen says the same.) (0.6.253) In the bubble of « Générer » greyed and
    // pressed (generer-maquette.md), no longer on a line under it.
    assert.deepEqual([count(), body.find('studio-orbit-window').length, page.said.at(-1), body.find('studio-error')], [before, 1, 'Trop près de la caméra de la vidéo : à si peu d’écart, le modèle se comporte mal.', []]);
    const again = pane();
    bar('Hauteur').value = '10';
    bar('Hauteur').oninput();
    assert.deepEqual([told(), go().disabled, go().title], [['Angle sûr', 'safe'], false, lit]);
    bar('Azimut').value = '50';
    bar('Azimut').oninput();
    assert.deepEqual([bar('Azimut').value, pick().title, pane(), world().style.transform], ['50', 'Caméra · fixe, 50° · 10°', again, 'translateZ(0cqw) rotateX(-10deg) rotateY(-50deg)']);
    assert.deepEqual([told(), warn().hidden, warn().textContent, warn().dataset.zone], [['Angle moins sûr', 'maybe'], false, 'Angle possible, moins sûr : le modèle tourne souvent moins que demandé.', 'maybe']);
    bar('Distance').value = '1.5';
    bar('Distance').oninput();
    assert.deepEqual([pane().find('studio-orbit-bar')[2].children[2].textContent, world().style.transform], ['× 1,5', 'translateZ(-41cqw) rotateX(-10deg) rotateY(-50deg)']);
    // Sent: the verb, the clip, the pose held; no prompt, no length, no camera of a new video.
    await generate();
    assert.equal(sent().name, 'refilm_video');
    assert.deepEqual(sent().arguments.camera, { azimuth: 50, elevation: 10, distance: 1.5 });
    assert.deepEqual(
      [sent().arguments.intention, JSON.stringify(sent().arguments.source).includes('film'), 'camera_start' in sent().arguments, 'prompt' in sent().arguments, 'duration' in sent().arguments, 'camera_speed' in sent().arguments],
      ['Caméra changée, demandée dans le Studio.', true, false, false, false, false],
    );
    // « Du début à la fin »: its two ends, the one of the end in hand; on the sphere both, and the path between.
    modes()[1].onclick();
    assert.deepEqual([modes().map(choice => choice.attributes['aria-pressed']), ends().hidden, mark('fixed').hidden, mark('start').hidden, mark('end').hidden], [['false', 'true'], false, true, false, false]);
    assert.deepEqual(ends().children.map(end => [end.children[0].textContent, end.dataset.end, end.attributes['aria-pressed'], end.children[1].textContent]), [
      ['Début', 'start', 'false', '0° · 0°'],
      ['Fin', 'end', 'true', '30° · 10°'],
    ]);
    assert.deepEqual([pane().find('studio-orbit-trail')[0].hidden, pane().find('studio-orbit-trail')[0].children.length, pane().find('studio-orbit-play')[0].hidden, pick().title], [false, 13, false, 'Caméra · 0° · 0° → 30° · 10°']);
    assert.deepEqual([mark('end').dataset.active, mark('start').dataset.active, bar('Azimut').value], ['true', 'false', '30']);
    // The start in hand: the bars set it.
    ends().children[0].onclick();
    bar('Azimut').value = '-20';
    bar('Azimut').oninput();
    assert.deepEqual([ends().children.map(end => end.attributes['aria-pressed']), pick().title, mark('start').dataset.active], [['true', 'false'], 'Caméra · -20° · 0° → 30° · 10°', 'true']);
    // The guide says what the camera comes to as a whole, as the foot of the window does: its start less sure
    // here, while the end in hand, the one it shows, is sure.
    bar('Azimut').value = '60';
    bar('Azimut').oninput();
    ends().children[1].onclick();
    assert.deepEqual([told(), warn().dataset.zone, warn().hidden, world().style.transform], [['Angle moins sûr', 'maybe'], 'maybe', false, 'translateZ(0cqw) rotateX(-10deg) rotateY(-30deg)']);
    ends().children[0].onclick();
    bar('Azimut').value = '-20';
    bar('Azimut').oninput();
    assert.deepEqual([told(), warn().hidden], [['Angle sûr', 'safe'], true]);
    // The pointer on the sphere drags the camera in hand: to the right of the clip here, by steps of five degrees.
    const globe = pane().find('studio-orbit-globe')[0];
    globe.getBoundingClientRect = () => ({ left: 100, top: 50, width: 286, height: 176 });
    globe.onpointerdown({ clientX: 100 + 143 + 30, clientY: 50 + 86, pointerId: 1, target: mark('end') });
    const dragged = Number(bar('Azimut').value);
    assert.ok(dragged > 0 && dragged % 5 === 0, String(dragged));
    assert.deepEqual([ends().children.map(end => end.attributes['aria-pressed']), typeof globe.onpointermove], [['false', 'true'], 'function']);
    globe.onpointerup();
    assert.equal(globe.onpointermove, null);
    bar('Azimut').value = '70';
    bar('Azimut').oninput();
    assert.deepEqual([told(), go().disabled], [['Angle moins sûr', 'maybe'], false]);
    // Far to the side and high at once: out of what the model learnt (its zones are ellipses). Not made either.
    bar('Hauteur').value = '40';
    bar('Hauteur').oninput();
    assert.deepEqual([told(), warn().textContent, go().disabled, go().title], [['Hors du modèle', 'out'], 'Hors de ce que le modèle sait faire : il n’a pas appris cet angle.', true, 'Hors de ce que le modèle sait faire : il n’a pas appris cet angle.']);
    const held = count();
    await generate();
    assert.equal(count(), held);
    bar('Hauteur').value = '8';
    bar('Hauteur').oninput();
    assert.deepEqual([told(), go().disabled], [['Angle moins sûr', 'maybe'], false]);
    // « Aperçu »: the guide goes from the start to the end, once.
    pane().find('studio-orbit-play')[0].onclick();
    assert.deepEqual([world().style.transform, world().style.transition], ['translateZ(0cqw) rotateX(-8deg) rotateY(-70deg)', 'transform 3s cubic-bezier(0.45, 0, 0.3, 1)']);
    // Sent: the pose of the end, and the one of the start.
    await generate();
    assert.deepEqual([sent().name, sent().arguments.camera_start, sent().arguments.camera.azimuth, 'prompt' in sent().arguments], ['refilm_video', { azimuth: -20, elevation: 0, distance: 1 }, 70, false]);
    // « Retirer », at the foot of the tool: a new video again; « Prolonger » of the same clip is a continuation.
    pane().find('studio-window-foot')[0].children.at(-1).onclick();
    // (The prompt of the video being written is back in its field, as it was.)
    assert.deepEqual(
      [body.find('studio-refilm').length, body.find('studio-guide').length, body.find('studio-go-label')[0].textContent, page.prompt().value, page.prompt().disabled ?? false],
      [0, 0, 'Générer', 'un renard court', false],
    );
    prolonger(body).onclick();
    assert.deepEqual([prolonged(body).length, body.find('studio-orbit').length, body.find('studio-go-label')[0].textContent], [1, 0, 'Générer la suite']);
    assert.match(prolonged(body)[0], /^À prolonger · /);
    await generate();
    assert.equal(sent().name, 'extend_video');
    // And the camera of the clip changed again keeps what was set.
    second(body)[0].onclick();
    assert.equal(pick().title, 'Caméra · -20° · 0° → 70° · 8°');
    // (0.6.244) « Prolonger » of the clip whose camera is being changed, without « Retirer » first: a continuation,
    // not the camera still.
    prolonger(body).onclick();
    assert.deepEqual([prolonged(body).length, body.find('studio-orbit').length, body.find('studio-refilm').length, body.find('studio-go-label')[0].textContent], [1, 0, 0, 'Générer la suite']);
    second(body)[0].onclick();
    assert.deepEqual([body.find('studio-refilm').length, body.find('studio-go-label')[0].textContent], [1, 'Changer la caméra']);
    // Nothing written at all: it is made all the same (the clip says what is filmed).
    pane().find('studio-window-foot')[0].children.at(-1).onclick();
    page.prompt().value = '';
    page.prompt().oninput();
    second(body)[0].onclick();
    const last = count();
    await generate();
    assert.deepEqual([count(), sent().name, 'prompt' in sent().arguments], [last + 1, 'refilm_video', false]);
  } finally {
    page.restore();
  }

  // A model that does not hold the distance yet: its bar stays, greyed, and says why. (0.6.250) A clip long for
  // its size is not refused any more: its size is chosen, see below.
  const reason = 'La distance ne marche pas encore avec ce modèle : son auteur le dit.',
    less = { ...film, refilm: { ...bounds, distance: { min: 1, max: 1, unavailable: reason } } };
  page = await studioPage({ ...tools, refilm_video: [less] }, routes, { runs });
  try {
    const { body } = page;
    page.mode(1);
    second(body)[0].onclick();
    const pane = body.find('studio-orbit-window')[0],
      [, , distance] = pane.find('studio-orbit-bar'),
      [, , scale] = pane.find('studio-orbit-scale'),
      go = () => body.find('studio-go')[0];
    assert.deepEqual([distance.className, distance.title, distance.children[1].disabled, distance.children[1].min, distance.children[1].max, distance.children[2].textContent], ['studio-orbit-bar is-off', reason, true, '1', '1', '× 1,0']);
    assert.deepEqual([scale.className, scale.title, scale.children.map(word => word.textContent)], ['studio-orbit-scale is-off', reason, ['Pas encore avec ce modèle']]);
    assert.deepEqual(pane.find('studio-orbit-bar').slice(0, 2).map(line => line.children[1].disabled), [false, false]);
    assert.deepEqual([go().disabled, go().title], [false, 'Générer (Ctrl+Entrée)']);
  } finally {
    page.restore();
  }
});

test('(0.6.250) « Changer la caméra » : la taille à laquelle le clip est refilmé se choisit ; plus grand est dit plus long, jamais refusé', async () => {
  // (His words of 23/11: « je veux que l’user puisse choisir sa resolution d’entrée […] ne pas griser les grande
  // resolution, juste mettre un triger warning », then « la durée ne sera pas la meme en fonction des pc, donc
  // generalise »: the time said is the one this computer took, never one measured elsewhere.)
  const { tools, runs } = continuing(),
    routes = { 'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }), 'tools/execute': () => ({ id: 'j', state: 'error', error: 'rien' }) },
    film = refilm => ({ id: 'r', name: 'Changer la caméra (LTX 2.5)', verb: 'refilm_video', family: 'ltx25_refilm', roles: { source: { count: 1, media: ['video'], required: true } }, settings: [], refilm }),
    second = (body, id = 'film') => body.find('studio-item').find(tile => tile.dataset.id === id).find('studio-item-second')[0],
    looked = body => {
      const bar = body.find('studio-bar').find(item => item.dataset.ai === 'refilm-size'),
        [said] = body.find('studio-refilm-said');
      return { bar, said, now: [bar.max, bar.value, bar.attributes['aria-valuetext'], said.hidden ? '' : said.textContent, said.dataset.warn] };
    },
    move = (body, place) => {
      const { bar } = looked(body);
      bar.value = String(place);
      bar.oninput();
      return looked(body).now;
    };
  runs.push({ id: 'bare', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'un phare', parameters: { frames: 121, fps: 24 }, outputs: [{ originalUrl: '/b.mp4', thumbUrl: '/b.jpg', take: 4 }] });
  // (A smaller clip of the project: 768 × 448.)
  runs.push({ id: 'small', conversationId: 'c1', mediaType: 'video', workflowId: 'v', prompt: 'une mouette', parameters: { width: 768, height: 448, frames: 121, fps: 24 }, outputs: [{ originalUrl: '/s.mp4', thumbUrl: '/s.jpg', take: 3 }] });

  // A computer that never changed a camera. The clip is 1344 × 768, 5 s: its bar offers the sizes of its format
  // up to its own, and starts on the one advised (1024 × 576), with nothing said under it.
  let page = await studioPage({ ...tools, refilm_video: [film({})] }, routes, { runs });
  try {
    const { body, asked } = page,
      sent = () => asked.filter(([route]) => route === 'tools/action').at(-1)[1],
      generate = async () => {
        page.page['studio-view'].onkeydown({ key: 'Enter', ctrlKey: true, preventDefault() {} });
        await settle();
      },
      go = () => body.find('studio-go')[0];
    page.mode(1);
    second(body).onclick();
    assert.deepEqual(looked(body).now, ['3', '2', '1024 × 576', '', 'false']);
    // (Its line is not there while it says nothing.)
    assert.equal(looked(body).said.hidden, true);
    const [block] = body.find('studio-refilm-size');
    assert.deepEqual(
      [block.className, block.find('studio-bar-line')[0].title, block.find('studio-bar-label')[0].textContent, block.find('studio-bar-notch').length, looked(body).said.attributes.role],
      ['studio-set-block studio-set-shape studio-refilm-size', 'La vidéo est ramenée à cette taille avant d’être refilmée. Plus grand : plus long.', 'Résolution', 4, 'status'],
    );
    // (In the place of the format and the length of a new video: neither is offered for a clip filmed again.)
    assert.deepEqual([body.find('studio-formats').length, body.find('studio-bar').filter(item => ['size', 'duration'].includes(item.dataset.ai)).length], [0, 0]);
    // Its own size, larger: said longer, in the colour of a warning, by how much. Never refused: the button stays lit.
    assert.deepEqual(move(body, 3), ['3', '3', '1344 × 768', 'Plus long à cette taille : environ 2 fois le temps de 1024 × 576.', 'true']);
    assert.deepEqual([go().disabled, body.find('studio-go-label')[0].textContent, looked(body).said.hidden], [false, 'Changer la caméra', false]);
    await generate();
    assert.deepEqual([sent().name, sent().arguments.size], ['refilm_video', { width: 1344, height: 768 }]);
    // The smallest: nothing to warn of. Sent as chosen.
    second(body).onclick();
    assert.deepEqual(looked(body).now, ['3', '3', '1344 × 768', 'Plus long à cette taille : environ 2 fois le temps de 1024 × 576.', 'true'], 'kept while the clip is the same');
    assert.deepEqual(move(body, 0), ['3', '0', '512 × 288', '', 'false']);
    await generate();
    assert.deepEqual(sent().arguments.size, { width: 512, height: 288 });
    // Another clip starts again from what suits it: a clip of 768 × 448 on its own size, the largest it has.
    second(body, 'small').onclick();
    assert.deepEqual(looked(body).now, ['1', '1', '768 × 448', '', 'false']);
    await generate();
    assert.deepEqual(sent().arguments.size, { width: 768, height: 448 });
    // A clip whose size is not known (a file from elsewhere): no bar, and no size is sent; the server takes its own.
    second(body, 'bare').onclick();
    assert.deepEqual([body.find('studio-refilm-size').length, body.find('studio-refilm').length], [0, 1]);
    await generate();
    assert.deepEqual([sent().name, 'size' in sent().arguments], ['refilm_video', false]);
  } finally {
    page.restore();
  }

  // A computer that has changed a camera before (768 × 448, 121 frames, in 113 s): it says how long it would
  // take, and starts on the largest size within its patience (60 s of work for a second of video).
  page = await studioPage({ ...tools, refilm_video: [film({ made: [{ pixels: 768 * 448, frames: 121, seconds: 113 }], patience: 60 })] }, routes, { runs });
  try {
    const { body } = page;
    page.mode(1);
    second(body).onclick();
    assert.deepEqual(looked(body).now, ['3', '2', '1024 × 576', 'Environ 3 min 10 sur cet ordinateur.', 'false']);
    assert.deepEqual(move(body, 1), ['3', '1', '768 × 448', 'Environ 1 min 50 sur cet ordinateur.', 'false']);
    // Beyond its patience: a warning, with the time. The button stays lit.
    assert.deepEqual(move(body, 3), ['3', '3', '1344 × 768', 'Long à cette taille : environ 6 min sur cet ordinateur.', 'true']);
    assert.equal(body.find('studio-go')[0].disabled, false);
  } finally {
    page.restore();
  }
  // A slower computer (the same change of camera in 400 s): it starts lower, and warns sooner.
  page = await studioPage({ ...tools, refilm_video: [film({ made: [{ pixels: 768 * 448, frames: 121, seconds: 400 }] })] }, routes, { runs });
  try {
    const { body } = page;
    page.mode(1);
    second(body).onclick();
    assert.deepEqual(looked(body).now, ['3', '0', '512 × 288', 'Environ 2 min 50 sur cet ordinateur.', 'false']);
    assert.deepEqual(move(body, 1), ['3', '1', '768 × 448', 'Long à cette taille : environ 7 min sur cet ordinateur.', 'true']);
  } finally {
    page.restore();
  }
});

test('(0.6.258) an image made larger: its size at its bottom right, a loupe of 200 px at 100 % under the pointer (the image it was made from at the left), « Comparer » to take it away; none for another image, none while it is made larger again', async () => {
  const image = { id: 'w', name: 'Image', roles: {}, limits: sizes, direct: true, size: { width: 1024, height: 1024 }, settings: [], seeded: true },
    seedvr = { id: 'sv', name: 'Upscale SeedVR2', media: 'image', verb: 'upscale', roles: { source: { count: 1, media: ['image'], required: true } }, settings: [], finish: { key: 'scale', choices: [2, 4], standard: 2 } };
  const original = { id: 'a', conversationId: 'c1', prompt: 'un phare', outputs: [{ originalUrl: '/a.png', take: 1, width: 1024, height: 1024 }] },
    // (Its settings say what was asked of the model, the size of the image it was made from: its output says its own.)
    larger = (id, from, url) => ({
      id,
      conversationId: 'c1',
      prompt: 'un phare',
      parameters: { pipeline: 'seedvr2', width: 1024, height: 1024, references: [{ role: 'source_image', output_id: from, output_index: 0 }] },
      outputs: [{ originalUrl: url, take: 2, width: 2048, height: 2048 }],
    });
  const seen = [];
  const page = await studioPage(
    { create_image: [image], upscale: [seedvr] },
    {
      'tools/actions': () => ({ upscale: ['image'] }),
      'tools/action': () => ({ requestId: 'q', plan: { parameters: {} } }),
      'tools/execute': () => {
        // Made larger again: veiled, neither its loupe nor its size meanwhile.
        const frame = page.body.find('studio-frame')[0];
        seen.push([frame.className.includes('is-finishing'), frame.find('studio-loupe').length, frame.find('studio-frame-size').length]);
        return { id: 'j', state: 'error', error: 'rien' };
      },
    },
    { runs: [larger('u', 'a', '/u.png'), original] },
  );
  const { body, restore } = page;
  const frame = () => body.find('studio-frame')[0],
    loupe = () => body.find('studio-loupe')[0],
    compare = () => body.find('studio-rail')[0]?.find('output-action-compare')[0],
    images = () => loupe().find('studio-loupe-half').map(half => half.children[0]),
    move = (clientX, clientY, pointerType = 'mouse') => {
      const picture = body.find('studio-frame-result')[0];
      picture.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 400 });
      frame().getBoundingClientRect = () => ({ left: 92, top: 42, width: 416, height: 416 });
      frame().onpointermove({ clientX, clientY, pointerType });
    };
  try {
    await settle();
    assert.equal(screenOf(body.find('studio-frame-result')[0]).src, '/u.png');
    // Its size, from its output (not the size it was asked from).
    const [size] = body.find('studio-frame-size');
    assert.deepEqual([size.textContent, size.hidden], ['2048 × 2048', false]);
    // The loupe, hidden until the pointer comes: the image it was made from at the left, the one made larger at the right.
    // (0.6.262) Above the page (popover), never cut by the frame: placed in the window.
    assert.deepEqual([loupe().hidden, loupe().attributes['aria-hidden'], loupe().attributes.popover], [true, 'true', 'manual']);
    let lifted = false;
    Object.assign(loupe(), {
      matches: selector => selector === ':popover-open' && lifted,
      showPopover: () => void (lifted = true),
      hidePopover: () => void (lifted = false),
    });
    assert.deepEqual(
      loupe().find('studio-loupe-half').map(half => half.className),
      ['studio-loupe-half is-before', 'studio-loupe-half is-after'],
    );
    assert.deepEqual(images().map(item => item.src), ['/a.png', '/u.png']);
    assert.equal(loupe().find('studio-loupe-line').length, 1);
    // « Comparer », the last of the column, pressed.
    const rail = body.find('studio-rail')[0];
    assert.equal(rail.children.at(-1), compare());
    assert.deepEqual([compare().children[1].textContent, compare().attributes['aria-pressed']], ['Comparer', 'true']);
    assert.match(compare().attributes['aria-label'], /l’originale à gauche, l’agrandie à droite/);
    // Under the pointer, at the middle of the image and a quarter of its height: centred on it, at 100 % (2048 px).
    move(300, 150);
    assert.deepEqual([loupe().hidden, lifted], [false, true]);
    assert.equal(loupe().style.transform, 'translate(200px, 50px)');
    for (const item of images())
      assert.deepEqual([item.style.width, item.style.height, item.style.transform], ['2048px', '2048px', 'translate(-924px, -412px)']);
    // Out of the image (its frame around it): hidden; by touch, none.
    move(96, 150);
    assert.deepEqual([loupe().hidden, lifted], [true, false]);
    move(300, 150, 'touch');
    assert.equal(loupe().hidden, true);
    // « Comparer » released: no loupe, said in place (the focus stays on it); pressed again, it comes back.
    move(300, 150);
    const pressed = compare();
    pressed.onclick();
    assert.deepEqual([compare(), pressed.attributes['aria-pressed'], loupe().hidden], [pressed, 'false', true]);
    assert.match(pressed.attributes['aria-label'], /remettre la loupe/);
    move(300, 150);
    assert.equal(loupe().hidden, true);
    pressed.onclick();
    move(300, 150);
    assert.deepEqual([pressed.attributes['aria-pressed'], loupe().hidden], ['true', false]);
    // Made larger again: neither meanwhile.
    rail.find('output-action-upscale')[0].onclick();
    await body.find('studio-go')[0].onclick();
    await settle();
    assert.deepEqual(seen, [[true, 0, 0]]);
  } finally {
    restore();
  }
  // The image it was made from gone from the Sortie: its size alone, no loupe, no « Comparer ». Another image: none.
  // (0.6.262) A photo of the computer made larger (put on the screen, kept as a reference: its source is the
  // reference): compared with it while it is in the project; its size alone once it is not.
  const fromFile = {
    id: 'f',
    conversationId: 'c1',
    prompt: '',
    parameters: { pipeline: 'seedvr2', width: 1024, height: 1024, references: [{ role: 'source_image', resource_id: 'r9' }] },
    outputs: [{ originalUrl: '/f.png', take: 3, width: 2048, height: 2048 }],
  };
  for (const [runs, wanted, resource = undefined, before = undefined] of [
    [[larger('v', 'gone', '/v.png')], [1, 0, false]],
    [[original], [0, 0, false]],
    [[fromFile], [1, 1, true], id => (id === 'r9' ? { id, originalUrl: '/ref/r9.png', previewUrl: '/preview/r9.webp' } : null), '/ref/r9.png'],
    [[fromFile], [1, 0, false], () => null],
  ]) {
    const other = await studioPage({ create_image: [image], upscale: [seedvr] }, { 'tools/actions': () => ({ upscale: ['image'] }) }, { runs, ...(resource ? { resource } : {}) });
    try {
      await settle();
      assert.deepEqual(
        [other.body.find('studio-frame-size').length, other.body.find('studio-loupe').length, Boolean(other.body.find('studio-rail')[0]?.find('output-action-compare')[0])],
        wanted,
      );
      if (before)
        assert.deepEqual(other.body.find('studio-loupe-half').map(half => half.children[0].src), [before, '/f.png'], 'the reference at the left, the image made larger at the right');
    } finally {
      other.restore();
    }
  }
});

test('(0.6.258) the styles of the loupe: round, 200 px, cut in two; the size in mono at 12 px; « Comparer » 8 px under the actions', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (await readFile(new URL('../public/moodix.css', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'),
    part = css.slice(css.indexOf('(0.6.258) The loupe of an image made larger'));
  assert.ok(part.length > 200);
  assert.match(part, /\.studio-loupe \{[^}]*width: 200px;[^}]*height: 200px;[^}]*border-radius: 50%;[^}]*pointer-events: none;/);
  assert.match(part, /\.is-before \{\s*clip-path: inset\(0 50% 0 0\);/);
  assert.match(part, /\.is-after \{\s*clip-path: inset\(0 0 0 50%\);/);
  assert.match(part, /\.studio-loupe-half > img \{[^}]*max-width: none;/);
  assert.match(part, /\.studio-frame-size \{[^}]*font: 500 12px\/1\.2 var\(--font-mono\);/);
  assert.match(part, /\.output-action-compare \{\s*margin-top: 8px;/);
  // (0.6.281) Hidden, never drawn: by the rule of the whole page, which wins over its display: grid.
  assert.match(css, /\n\[hidden\] \{\n  display: none !important;\n\}/);
  for (const [, size] of part.matchAll(/(\d+(?:\.\d+)?)px\/|font-size: (\d+)px/g)) if (size) assert.ok(Number(size) >= 12);
  // Its pictogram, beside those of the other actions.
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<symbol id="i-act-compare" viewBox="0 0 24 24">/);
});
