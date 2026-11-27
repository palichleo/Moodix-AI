import { formatOf, formatsFor, nearestSize, sizesFor } from './formats.mjs';
import { CHOICE_NAMES, settingName } from './setting-names.mjs';
import { PIECES, PIECE_WORDS, refOf } from './pieces.mjs';

// (0.6.198) The names of the settings on the card of a proposal are those of the Studio and of Paramètres ›
// Modèles (public/setting-names.mjs, read by the server too): the card had a table of its own (« Force des
// références », « Graine », « Cadence (i/s) »). Its own name is kept for the one setting no other screen
// shows: a length in frames, « Durée (images) » (the server says « Images vidéo »).
const CARD_NAMES = { frames: 'Durée (images)' };
const labelOf = key => CARD_NAMES[key] ?? settingName(key);
// Shown in the main area; every other editable parameter goes to « Paramètres avancés ».
const MAIN = new Set(['frames', 'width', 'height', 'seed']);
// Sound settings that matter to every take: shown in the main area too.
const SOUND_MAIN = ['seconds', 'language'];
const ADVANCED_FIRST = ['frames', 'fps', 'audio', 'width', 'height'];
// (0.6.190) Said of « sujets », the cases that receive a character, an object or a place.
const HELP = {
  msr_frames:
    'Chaque sujet est montré au modèle comme un court plan fixe de ce nombre d’images, avant la vidéo : plus long, il pèse un peu plus et coûte un peu plus de calcul.',
  msr_strength: 'À quel point la vidéo suit ses sujets (1 : au plus près).',
};
// Settings that only matter with a subject reference, and the role that brings one.
const SUBJECT_ROLE = 'msr_image';
const subjectSetting = key => key.startsWith('msr_');
const numeric = value => typeof value === 'number' && Number.isFinite(value);
// The places of the inputs in a card: the frames of the clip, the video followed; the rest are references.
// (0.6.209) Their words are those of the plateau of the Studio (public/pieces.mjs: « Début », « Fin »,
// « Sujet 1 », « À prolonger »…), written as a sentence writes them: the card shows them in capitals by its
// style sheet (« DÉBUT »), as before.
const PLACES = { start_image: PIECE_WORDS.start_image, end_image: PIECE_WORDS.end_image };
// (0.6.476) What the × of an image of a card says, in the words of the Bobine (« Retirer l’image de début »).
const TAKE_OUT = {
  start_image: 'Retirer l’image de début',
  end_image: 'Retirer l’image de fin',
  source: 'Retirer l’image à modifier',
};
// (0.6.271) Every role a family says « as: source » (runner/families): Qwen-Image-Edit's « edit_image » was
// missing, and its image to modify was shown as « Sujet 1 », a drop on it replacing it.
const SOURCES = new Set(['source_video', 'driving_video', 'source_image', 'img2img', 'edit_image', 'refilm_source']);
// (0.6.190) What a source is for, said under it in a card instead of « SOURCE »: the end of the name the
// server gives its role (« Image à modifier », « Vidéo à prolonger », « Vidéo à suivre »); by its role alone
// when the proposal names none.
const DOING = {
  img2img: PIECE_WORDS.source,
  edit_image: PIECE_WORDS.source,
  source_image: 'À agrandir',
  source_video: PIECE_WORDS.prolong,
  driving_video: PIECE_WORDS.follow,
  refilm_source: PIECE_WORDS.refilm,
};
const doing = (label, role) => {
  const said = /(?:^|\s)à\s(.+)$/i.exec(String(label ?? ''))?.[1];
  return said ? 'À ' + said.toLowerCase() : (DOING[role] ?? 'Entrée');
};
const seconds = value => value.toFixed(2).replace('.', ',') + ' s';
// A limit as it is said to the user: « 0,6 ».
const decimal = value => String(value).replace('.', ',');

/**
 * A proposal as one form: everything the user may change is editable in place, the common
 * settings first and the rest under « Paramètres avancés ». `edits()` returns only what
 * changed (and throws a readable message for an invalid value); `error(text)` shows a refusal.
 * `onStage(stage, edits)` is called when the version changes: its profile changes the size and
 * length, so the caller asks the server for the new proposal and renders it again.
 * `card`: the form of the card of the conversation (proposal-card.mjs; captures 11 and 12): the
 * length in one click (2 · 4 · 6 · 8 · 10 s), the version and the seed under « Paramètres avancés »,
 * the prompt folded with « Revenir au prompt de Moodix », the choice of Moodix marked « proposé »;
 * the two folds are given back (`folds`: their name and their panel) for the card to place. Its
 * inputs are pictures (DÉBUT and FIN in the shape of the format, a rule, SUJET 1…), « + » where the
 * workflow takes one more (`onAdd(role)`: « Créations du projet » opens under them, in the card);
 * each case says its role (`data-role`) for an image dropped or pasted on it; a changed value turns
 * to the accent (`is-changed`). `form.shelf`: the place of « Créations du projet ».
 * (0.6.476) What its model does not send (`request.held`) stays in its place, greyed, why in its bubble, and the line
 * of the server says what to do (`request.warning`); each image may be taken out with its × (`onRemove(which)`:
 * `{ input: n }`, the n-th it sends, `{ held: n }`, the n-th it holds), except what its model cannot do without
 * (`request.fixedInputs`) and the video a suite continues.
 */
export function renderProposal(
  container,
  request,
  { node, onStage, card = false, onAdd = null, onRemove = null } = {},
) {
  container.replaceChildren();
  const plan = request.plan || {},
    editable = plan.editable || {},
    parameters = plan.parameters || {},
    video = request.mediaType === 'video',
    audio = request.mediaType === 'audio',
    items = new Map((editable.parameters || []).map(item => [item.key, item])),
    controls = new Map(),
    continues = plan.references?.some(ref => ref.role === 'source_video'),
    overlap = continues && numeric(parameters.overlap_frames) ? parameters.overlap_frames : 0;
  const message = node('p', 'video-edit-error');
  message.setAttribute('role', 'alert');
  message.hidden = true;

  function field(label, control, { help, wide = false, name = false } = {}) {
    const wrapper = node('label', 'proposal-field' + (wide ? ' is-wide' : ''));
    const title = node('span', name ? 'proposal-input-name' : '', label);
    if (name) title.title = label;
    wrapper.append(title, control);
    if (help) wrapper.append(node('small', 'field-help', help));
    return wrapper;
  }
  function select(choices, value) {
    const control = node('select');
    for (const [key, text] of choices) control.add(new Option(text, String(key)));
    control.value = String(value);
    return control;
  }
  function fixed(text) {
    return node('output', 'proposal-fixed', text);
  }

  // The control of one generic parameter: a checkbox, a list, a text or a number.
  function control(item) {
    let input;
    if (item.type === 'boolean') {
      input = node('input');
      input.type = 'checkbox';
      input.checked = item.value === true;
    } else if (item.choices) {
      input = select(
        item.choices.map(choice => [choice, String(choice)]),
        item.value,
      );
      input.disabled = item.choices.length < 2;
    } else if (item.type === 'string') {
      input = node('textarea', 'proposal-prompt');
      input.rows = 4;
      input.value = String(item.value ?? '');
    } else {
      input = node('input');
      input.type = 'number';
      input.value = String(item.value);
      if (item.min !== undefined) input.min = String(item.min);
      if (item.max !== undefined) input.max = String(item.max);
      input.step = item.multipleOf ? String(item.multipleOf) : item.type === 'integer' ? '1' : 'any';
    }
    return input;
  }

  container.append(
    node(
      'p',
      'video-intention',
      plan.intention || (video ? 'Proposition vidéo' : audio ? 'Proposition de son' : 'Génération d’image'),
    ),
  );

  // Prompt: editable when the model owns it (folded in a card, at its foot).
  let prompt = null,
    promptField = null;
  if (editable.prompt) {
    prompt = node('textarea', 'proposal-prompt');
    prompt.rows = 4;
    prompt.value = plan.prompt || '';
    prompt.setAttribute('aria-label', 'Prompt');
    promptField = field('Prompt', prompt, { wide: true });
  } else if (plan.prompt) promptField = field('Prompt (fixé par le modèle)', fixed(plan.prompt), { wide: true });
  if (promptField && !card) container.append(promptField);

  // Text settings (the lyrics of a song): wide, under the prompt. (0.6.476) In a card, whose prompt is folded at its
  // foot, a negative prompt (Wan 2.2's, in Chinese) goes under « Paramètres avancés »: unfolded above everything, it
  // made the card of Wan 2.2 taller than the window at 1280 × 720, and its model, chosen in its title, out of view.
  const texts = [...items.values()].filter(
    item => item.type === 'string' && !item.choices && !item.locked && !(card && item.key === 'negative_prompt'),
  );
  for (const item of texts) {
    const input = control(item);
    input.setAttribute('aria-label', labelOf(item.key));
    controls.set(item.key, input);
    container.append(
      field(labelOf(item.key), input, {
        wide: true,
        help: item.key === 'lyrics' ? 'Vide pour un morceau instrumental.' : item.note,
      }),
    );
  }

  // In a card, the inputs as pictures, beside the settings in lines.
  const media = card ? node('div', 'proposal-media') : null,
    shelf = card ? node('div', 'proposal-shelf') : null;
  if (media) container.append(media, shelf);
  if (shelf) shelf.hidden = true;
  // The roles of the empty cases, in their order (an image dropped outside a case goes in the first).
  let emptyRoles = [];
  const grid = node('div', 'proposal-grid');
  container.append(grid);
  const shown = new Set(texts.map(item => item.key));
  if (audio)
    for (const key of SOUND_MAIN) {
      const item = items.get(key);
      if (!item) continue;
      shown.add(key);
      if (item.locked) {
        grid.append(field(labelOf(key), fixed(String(item.value)), { help: item.locked }));
        continue;
      }
      const input = control(item);
      controls.set(key, input);
      grid.append(field(labelOf(key), input));
    }

  // Inputs, each with the role it plays (and the others it may play); in a card their pictures say
  // it, and a role that may change goes under « Paramètres avancés ».
  const roleControls = [],
    roleFields = [];
  plan.references?.forEach((ref, index) => {
    const label = ref.label || ref.resource_id || 'Entrée ' + ((ref.image ?? index) + 1),
      options = editable.references?.[index] || [];
    if (options.length > 1) {
      const control = select(
        options.map(option => [option.role, option.label]),
        ref.role,
      );
      control.setAttribute('aria-label', 'Rôle de ' + label);
      roleControls.push({ index, control, initial: ref.role });
      roleFields.push(field(card ? 'Rôle de ' + label : label, control, { name: true }));
    } else if (!card) roleFields.push(field(label, fixed(ref.roleLabel || ref.role || ref.input), { name: true }));
  });
  if (!card) grid.append(...roleFields);

  // Version: changing it changes the profile, so the server proposes again.
  let versionField = null;
  if (editable.stages?.length > 1) {
    const stage = select(
      editable.stages.map(value => [value, CHOICE_NAMES[value] ?? value]),
      plan.stage,
    );
    stage.onchange = () => {
      let edits;
      try {
        edits = form.edits();
      } catch (error) {
        stage.value = plan.stage;
        form.error(error.message);
        return;
      }
      delete edits.stage;
      onStage?.(stage.value, edits);
    };
    controls.set('stage', stage);
    versionField = field('Version', stage);
  } else if (plan.stage === 'draft' || plan.stage === 'final') versionField = field('Version', fixed(CHOICE_NAMES[plan.stage]));
  if (versionField) grid.append(versionField);

  // Length: in seconds here, in frames under the advanced settings; both are the same value.
  const fps = () => {
    const control = controls.get('fps');
    const value = control ? Number(control.value) : parameters.fps;
    return value > 0 ? value : null;
  };
  const framesItem = items.get('frames');
  let frames = parameters.frames;
  const lengthText = count => {
    const rate = fps();
    if (!rate || !numeric(count)) return String(count);
    return overlap && count > overlap ? '+' + seconds((count - overlap) / rate) : seconds(count / rate);
  };
  let duration = null;
  if (framesItem && !framesItem.locked && framesItem.choices && fps()) {
    duration = select(
      framesItem.choices.map(choice => [choice, lengthText(choice)]),
      frames,
    );
    duration.disabled = framesItem.choices.length < 2;
    if (card && !duration.disabled) grid.append(lengths(overlap ? 'Durée ajoutée' : 'Durée', duration, framesItem.choices));
    else grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', duration));
  } else if (numeric(frames) && fps())
    grid.append(field(overlap ? 'Durée ajoutée' : 'Durée', fixed(lengthText(frames))));

  /**
   * The length in one click in a card (« Durée : 2 · 4 · 6 · 8 · 10 s »): for each whole second, the
   * nearest length the model accepts, and the one Moodix proposed; the list (hidden) keeps the value.
   */
  function lengths(label, list, choices) {
    const rate = fps(),
      proposed = list.value,
      near = target => choices.reduce((best, choice) => (Math.abs(choice / rate - target) < Math.abs(best / rate - target) ? choice : best));
    const picks = [...new Set([2, 4, 6, 8, 10].map(near).filter(choice => [2, 4, 6, 8, 10].some(target => Math.abs(choice / rate - target) <= 0.6)))];
    if (!picks.some(choice => String(choice) === proposed)) picks.push(Number(proposed));
    picks.sort((a, b) => a - b);
    const wrapper = node('div', 'proposal-field'),
      row = node('div', 'proposal-lengths');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', label);
    const buttons = picks.map(choice => {
      const button = node('button', 'proposal-length' + (String(choice) === proposed ? ' is-proposed' : ''), String(Math.round((choice - overlap) / rate)));
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(String(choice) === list.value));
      button.title = lengthText(choice) + (String(choice) === proposed ? ' · proposé' : '');
      button.onclick = () => {
        list.value = String(choice);
        list.onchange?.();
        for (const other of buttons) other.setAttribute('aria-checked', String(other === button));
        wrapper.classList?.toggle('is-changed', String(choice) !== proposed);
      };
      return button;
    });
    row.append(...buttons);
    const value = node('span', 'proposal-length-row');
    value.append(row, node('span', 'proposal-unit', 's'));
    list.hidden = true;
    wrapper.append(node('span', '', label), value, list);
    return wrapper;
  }
  // Format and resolution: a clean size for each format, within what the model accepts.
  const widthItem = items.get('width'),
    heightItem = items.get('height'),
    limits = { width: widthItem, height: heightItem },
    formats = formatsFor(limits);
  let size = { width: parameters.width, height: parameters.height };
  let formatControl = null,
    resolutionControl = null;
  const sizeText = value => value.width + ' × ' + value.height;
  const sizeKey = value => value.width + 'x' + value.height;
  // The size Moodix proposed, marked « proposé » in the open menus of a card.
  const proposedSize = sizeKey(size),
    proposedFormat = formatOf(size.width, size.height)?.id,
    unmarks = [];
  /**
   * « proposé » beside the choice of Moodix while a menu of a card opens (at the press of the pointer
   * or of a key); closed, the menu shows the value alone (« 16:9 · Paysage », « 768 × 448 »).
   * The lists of the page are menus of glass (glass-menu.mjs): the list of the system under one is
   * never pressed, and nothing was marked any more (16/11). The choice of Moodix carries its note
   * (`data-note`), which the menu of glass shows beside its name; the words added to the option stay
   * for a page without that menu.
   */
  function proposedMark(control, proposed) {
    const show = open => {
      for (const option of control.options || []) {
        option.text = option.text.replace(/ · proposé$/, '') + (open && option.value === proposed ? ' · proposé' : '');
        if (option.value === proposed) (option.dataset ??= {}).note = 'proposé';
        else if (option.dataset) delete option.dataset.note;
      }
    };
    control.onmousedown = control.onkeydown = () => show(true);
    control.onblur = () => show(false);
    unmarks.push(() => show(false));
  }
  const formatOfSize = () => {
    const format = formatOf(size.width, size.height);
    return format && formats.includes(format) ? format : null;
  };
  // Shows the format of the size (or « Autre ») and the sizes of that format.
  function showSize() {
    const format = formatOfSize();
    if (!format && ![...(formatControl.options || [])].some(option => option.value === 'custom'))
      formatControl.add(new Option('Autre', 'custom'));
    formatControl.value = format ? format.id : 'custom';
    const list = format ? sizesFor(format, limits) : [];
    const known = list.some(item => sizeKey(item) === sizeKey(size));
    resolutionControl.replaceChildren();
    for (const item of [...list, ...(known ? [] : [size])].sort((a, b) => a.width * a.height - b.width * b.height))
      resolutionControl.add(
        new Option(
          sizeText(item) + (!known && item === size && format ? ' (actuelle)' : ''),
          sizeKey(item),
        ),
      );
    resolutionControl.value = sizeKey(size);
    if (controls.get('width')) controls.get('width').value = String(size.width);
    if (controls.get('height')) controls.get('height').value = String(size.height);
    for (const unmark of unmarks) unmark();
    if (card) {
      formatControl.classList?.toggle('is-changed', formatControl.value !== proposedFormat);
      resolutionControl.classList?.toggle('is-changed', sizeKey(size) !== proposedSize);
      showMedia();
    }
  }
  const resizable =
    widthItem && heightItem && !widthItem.locked && !heightItem.locked && numeric(size.width) && numeric(size.height);
  if (resizable) {
    formatControl = select(
      formats.map(format => [format.id, format.label]),
      formats[0]?.id ?? '',
    );
    resolutionControl = node('select');
    formatControl.onchange = () => {
      const format = formats.find(item => item.id === formatControl.value);
      const next = format && nearestSize(sizesFor(format, limits), size.width * size.height);
      if (next) size = { ...next };
      showSize();
    };
    resolutionControl.onchange = () => {
      const [width, height] = resolutionControl.value.split('x').map(Number);
      size = { width, height };
      showSize();
    };
    grid.append(field('Format', formatControl), field('Résolution', resolutionControl));
    if (card) {
      proposedMark(formatControl, proposedFormat);
      proposedMark(resolutionControl, proposedSize);
    }
  } else if (widthItem?.follows)
    // A character put in a video: as many points as this, in the shape of the video followed.
    grid.append(field('Résolution', fixed('environ ' + sizeText(size)), { help: widthItem.locked }));
  else if (numeric(size.width) && numeric(size.height))
    grid.append(
      field(
        'Résolution',
        fixed(sizeText(size)),
        widthItem?.locked ? { help: 'Gardée de la vidéo source.' } : undefined,
      ),
    );

  // Seed, with a new random one at a click.
  let seedField = null;
  const seedItem = items.get('seed');
  if (seedItem && !seedItem.locked) {
    const seed = node('input');
    seed.type = 'number';
    seed.value = String(seedItem.value);
    seed.min = String(seedItem.min ?? 0);
    if (seedItem.max !== undefined) seed.max = String(seedItem.max);
    seed.step = '1';
    seed.setAttribute('aria-label', settingName('seed'));
    const roll = node('button', 'icon-button proposal-roll');
    roll.type = 'button';
    // (0.6.198) The words of the dice of the Studio (« Graine au hasard » before).
    roll.title = 'Tirer une seed au hasard';
    roll.setAttribute('aria-label', 'Tirer une seed au hasard');
    roll.append(symbol(node, 'dice', 'proposal-dice'));
    roll.onclick = () => {
      const max = Math.min(seedItem.max ?? 2 ** 32, Number.MAX_SAFE_INTEGER);
      seed.value = String(Math.floor(Math.random() * (max + 1)));
      seed.dispatchEvent?.(new Event('input'));
    };
    const row = node('div', 'proposal-seed');
    row.append(seed, roll);
    controls.set('seed', seed);
    seedField = field(settingName('seed'), row);
  } else if (numeric(parameters.seed)) seedField = field(settingName('seed'), fixed(String(parameters.seed)));
  if (seedField) grid.append(seedField);

  // Everything else the user may change.
  const advanced = node('details', 'proposal-advanced');
  advanced.append(node('summary', '', 'Paramètres avancés'));
  const more = node('div', 'proposal-grid');
  advanced.append(more);
  // In a card the version and the seed are advanced settings (« Paramètres avancés »).
  if (card) for (const moved of [versionField, seedField, ...roleFields]) if (moved) more.append(moved);
  const subjectFields = [];
  const keys = [
    ...ADVANCED_FIRST.filter(key => items.has(key)),
    ...[...items.keys()].filter(key => !ADVANCED_FIRST.includes(key)),
  ];
  for (const key of keys) {
    const item = items.get(key);
    if (MAIN.has(key) && !['frames', 'width', 'height'].includes(key)) continue;
    if (shown.has(key)) continue;
    // The length is chosen in seconds above; a count of frames would only repeat it.
    if (key === 'frames' && duration) continue;
    // In a card the size is the format and the resolution: its two numbers would repeat them.
    if (card && resizable && (key === 'width' || key === 'height')) continue;
    const label = labelOf(key);
    if (item.locked) {
      const wrapper = field(label, fixed(String(item.value)), { help: item.locked });
      more.append(wrapper);
      if (subjectSetting(key)) subjectFields.push(wrapper);
      continue;
    }
    const input = control(item);
    controls.set(key, input);
    // (0.6.476) A text (the negative prompt of a card) on the whole width, its words under it.
    const wrapper = field(label, input, {
      help: item.note || HELP[key],
      wide: item.type === 'string' && !item.choices,
    });
    more.append(wrapper);
    if (subjectSetting(key)) subjectFields.push(wrapper);
  }
  // In a card, the cadence and the steps of the workflow, read only (direction-artistique.md).
  if (card) {
    if (!items.has('fps') && numeric(parameters.fps)) more.append(field(settingName('fps'), fixed(String(parameters.fps))));
    if (!items.has('steps') && numeric(parameters.steps)) more.append(field(settingName('steps'), fixed(String(parameters.steps))));
  }
  // Subject-reference settings show only while an input is a subject reference.
  const showSubject = () => {
    const subject = roleControls.length
      ? roleControls.some(({ control }) => control.value === SUBJECT_ROLE) ||
        plan.references.some(
          (ref, index) => ref.role === SUBJECT_ROLE && !roleControls.some(item => item.index === index),
        )
      : plan.references?.some(ref => ref.role === SUBJECT_ROLE);
    for (const wrapper of subjectFields) wrapper.hidden = !subject;
    advanced.hidden = ![...more.children].some(child => !child.hidden);
  };
  for (const { control } of roleControls)
    control.onchange = () => {
      showSubject();
      showMedia();
    };
  if (more.children.length && !card) container.append(advanced);
  showSubject();

  // The two length controls and the two size controls follow each other.
  const framesControl = controls.get('frames');
  if (duration && framesControl) {
    duration.onchange = () => {
      framesControl.value = duration.value;
    };
    framesControl.onchange = () => {
      duration.value = framesControl.value;
    };
  }
  if (controls.get('fps') && duration)
    controls.get('fps').onchange = controls.get('fps').oninput = () => {
      for (const option of duration.options || []) option.text = lengthText(Number(option.value));
    };
  if (resizable) {
    showSize();
    for (const key of ['width', 'height'])
      if (controls.get(key))
        controls.get(key).onchange = () => {
          const width = Number(controls.get('width').value),
            height = Number(controls.get('height').value);
          if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
            size = { width, height };
            showSize();
          }
        };
  }

  /**
   * The inputs of a card as pictures (captures 11 and 12): the video followed, DÉBUT and FIN in the
   * shape of the format, a rule, then the subjects (SUJET 1…); « + » where the workflow takes one
   * more: « Créations du projet » opens in the card, and the image chosen goes in that case.
   * (0.6.209, LOTS.md, lot 12; captures 105 and 106) They are the pieces of the plateau of the Studio:
   * the same words (public/pieces.mjs), the name of a reference of the project under its word
   * (« #ref3 »), and what the user named that the proposal leaves out, greyed, after a second rule.
   */
  function showMedia() {
    if (!media) return;
    const roleOf = index => roleControls.find(item => item.index === index)?.control.value ?? plan.references[index].role,
      // (0.6.190) The name the server gives that role (« Vidéo à prolonger »): a source says with it what is done with it.
      nameOf = (index, role) =>
        editable.references?.[index]?.find(option => option.role === role)?.label ??
        (role === plan.references[index].role ? plan.references[index].roleLabel : ''),
      placed = (plan.references || []).map((ref, index) => ({ ref, role: roleOf(index), name: nameOf(index, roleOf(index)) })),
      slots = request.inputRoles || [],
      ratio = numeric(size.width) && numeric(size.height) && size.height > 0 ? size.width / size.height : 16 / 9;
    const referenceRole = slots.find(role => !SOURCES.has(role) && !PLACES[role]) ?? 'reference',
      empties = [];
    const tile = (
      ref,
      label,
      { shape = ratio, add = '', role = '', off = '', held = false, why = '', remove = null } = {},
    ) => {
      if (!ref && role) empties.push(role);
      const box = node(
          'figure',
          'proposal-input' +
            (ref ? '' : ' is-empty') +
            (shape ? '' : ' is-reference') +
            (off ? ' is-off' : '') +
            (held ? ' is-held' : ''),
        ),
        frame = node(ref ? 'span' : 'button', 'proposal-input-frame'),
        // (0.6.209, capture 106) A reference of the project is named under its word as it is written in the
        // message, « #ref3 »: the image named there is the one seen here, in that role.
        named = ref && !off ? refOf(ref.label) : '';
      // An image dropped or pasted on the case goes there (proposal-card.mjs).
      if (role && !SOURCES.has(role)) box.setAttribute('data-role', role);
      if (shape) box.style?.setProperty('--ratio', shape.toFixed(3));
      if (ref?.preview) {
        const picture = node('img');
        picture.src = ref.preview;
        picture.alt = ref.label || label;
        picture.decoding = 'async';
        // Gone (a file removed since): its name instead.
        picture.onerror = () => picture.replaceWith(node('span', 'proposal-input-file', ref.label || label));
        frame.append(picture);
      } else if (ref) frame.append(node('span', 'proposal-input-file', ref.label || label));
      else {
        frame.type = 'button';
        frame.textContent = '+';
        frame.setAttribute('aria-label', add);
        frame.title = add + '\nUne création du projet, ou une image glissée ou collée ici.';
        frame.disabled = !onAdd;
        frame.onclick = () => onAdd?.(role);
      }
      // Left out: why, in its bubble (help-tips.mjs); it has no role, its name is its word.
      if (off) frame.setAttribute('data-tip', off);
      // (0.6.476) Held by its model: in its place, greyed, why in its bubble (the words of the Bobine).
      if (held) frame.setAttribute('data-tip', why);
      // (0.6.476) Its × takes it out of the card: the proposal is made again without it (« Retirer l’image de début »).
      if (ref && remove) {
        const cross = node('button', 'proposal-input-remove');
        cross.type = 'button';
        cross.setAttribute('aria-label', remove.said);
        cross.setAttribute('data-tip', remove.said);
        cross.append(symbol(node, 'close', 'proposal-input-cross'));
        cross.onclick = event => {
          event?.stopPropagation?.();
          onRemove?.(remove.which);
        };
        frame.append(cross);
      }
      box.append(frame, node('figcaption', off ? 'proposal-input-ref' : '', label));
      if (named) box.append(node('span', 'proposal-input-ref', named));
      return box;
    };
    // (0.6.476) What its model holds and does not send, by the role of its verb (`as`), each with its place in `held`;
    // the × of an image it sends (not one its model cannot do without: `fixedInputs`) and of one it holds.
    const held = (request.held ?? []).map((item, at) => ({ item, at })),
      heldAs = as => held.filter(({ item }) => item.as === as),
      fixed = new Set(request.fixedInputs ?? []),
      sent = (ref, said) => {
        const index = placed.findIndex(item => item.ref === ref);
        return onRemove && index >= 0 && !fixed.has(index) ? { which: { input: index }, said } : null;
      },
      kept = (at, said) => (onRemove ? { which: { held: at }, said } : null),
      heldTile = ({ item, at }, label, said, shape = ratio) =>
        tile({ label: item.label, preview: item.preview }, label, {
          shape,
          held: true,
          why: item.why,
          remove: kept(at, said),
        });
    const frames = [];
    for (const { ref, role, name } of placed.filter(item => SOURCES.has(item.role)))
      frames.push(tile(ref, doing(name, role), { role, remove: sent(ref, TAKE_OUT.source) }));
    for (const entry of heldAs('source')) frames.push(heldTile(entry, PIECE_WORDS.source, TAKE_OUT.source));
    for (const [role, label] of Object.entries(PLACES)) {
      const found = placed.find(item => item.role === role),
        waiting = heldAs(role)[0];
      if (found) frames.push(tile(found.ref, label, { role, remove: sent(found.ref, TAKE_OUT[role]) }));
      else if (waiting) frames.push(heldTile(waiting, label, TAKE_OUT[role]));
      else if (slots.includes(role))
        frames.push(tile(null, label, { role, add: role === 'end_image' ? 'Ajouter une image de fin' : 'Ajouter une image de début' }));
    }
    const references = placed.filter(item => !SOURCES.has(item.role) && !PLACES[item.role]),
      room = Math.min(3, slots.filter(role => !SOURCES.has(role) && !PLACES[role]).length),
      subject = PIECE_WORDS.reference;
    // (0.6.209, capture 97) Who is put in a video says « Personnage », as on the plateau of the Studio.
    const refs = references.map(({ ref, role, name }, index) => {
      const word = name === PIECES.character.name ? PIECE_WORDS.character : subject + ' ' + (index + 1);
      return tile(ref, word, { shape: 0, role, remove: sent(ref, 'Retirer le ' + word.toLowerCase()) });
    });
    // (0.6.476) The subjects it holds, after those it sends: « Sujet 3 », greyed.
    heldAs('reference').forEach((entry, index) => {
      const word = subject + ' ' + (references.length + index + 1);
      refs.push(heldTile(entry, word, 'Retirer le ' + word.toLowerCase(), 0));
    });
    // (0.6.209, capture 106) The case of one more subject says what it takes (no word before): « Sujet »,
    // « Sujet 2 » after one given.
    if (references.length < room)
      refs.push(tile(null, subject + (references.length ? ' ' + (references.length + 1) : ''), { shape: 0, role: referenceRole, add: 'Ajouter un sujet' }));
    // (0.6.209, capture 105) An image the user named that this proposal leaves out (`cited.left`, lib/tool-
    // runtime.mjs) stays on the card, greyed, after what goes: it was only a sentence under the card, and the
    // image named was nowhere to be seen. Why, in its bubble: its model has no place for it, or (a place is
    // left: `cited.roles`) Moodix AI gave it no role. The sentence of the server stays under the card.
    const left = (request.cited?.left ?? []).map(item =>
      tile({ label: item.label, preview: item.preview }, refOf(item.label) || String(item.label ?? ''), {
        shape: 0,
        off: request.cited.roles?.length
          ? 'Ne partira pas : Moodix AI ne lui a pas donné de rôle.'
          : `Ne partira pas avec ${request.workflowName || 'ce modèle'}.`,
      }),
    );
    const groups = [frames, refs, left].filter(group => group.length);
    media.replaceChildren(...groups.flatMap((group, index) => (index ? [node('span', 'proposal-media-rule'), ...group] : group)));
    media.hidden = !groups.length;
    emptyRoles = empties;
  }
  showMedia();
  // A value changed in a card turns to the accent; Moodix's again, it goes back.
  if (card)
    for (const control of [...controls.values(), prompt].filter(Boolean)) {
      const read = () => (control.type === 'checkbox' ? control.checked : control.value),
        initial = read(),
        mark = () => control.classList?.toggle('is-changed', read() !== initial);
      control.addEventListener?.('input', mark);
      control.addEventListener?.('change', mark);
    }

  // (0.6.493) Not the note of what it does not send (`heldNote`, for the Studio): its greyed inputs and the line under
  // the notes say it here.
  const notes = (request.notes || []).filter(note => !(request.heldNote && note === request.heldNote));
  if (plan.edited?.length)
    notes.push('Modifié par vous : ' + plan.edited.map(labelOf).join(', ') + '.');
  for (const note of notes) container.append(node('p', 'field-help proposal-note', note));
  // (0.6.476) What its model does not send, and what to do (« … : retirez l’image de début ou le sujet. »).
  if (request.warning) container.append(node('p', 'field-help proposal-note proposal-warning', request.warning));
  container.append(message);

  // A card places its two folds at its foot, beside Annuler and Générer.
  const folds = [];
  if (card) {
    if (more.children.length && !advanced.hidden) folds.push({ name: 'Paramètres avancés', panel: more });
    if (promptField) {
      const panel = node('div', 'proposal-prompt-panel');
      panel.append(promptField);
      if (prompt) {
        const back = node('button', 'proposal-back', 'Revenir au prompt de Moodix');
        back.type = 'button';
        back.hidden = true;
        back.onclick = () => {
          prompt.value = plan.prompt || '';
          back.hidden = true;
        };
        prompt.addEventListener?.('input', () => (back.hidden = prompt.value === (plan.prompt || '')));
        panel.append(back);
      }
      folds.push({ name: 'Prompt', panel });
    }
  }
  const form = {
    folds,
    shelf,
    media,
    emptyRoles: () => [...emptyRoles],
    edits() {
      const edits = {};
      if (prompt && prompt.value !== (plan.prompt || '')) {
        if (!prompt.value.trim()) throw Error('Le prompt ne peut pas être vide.');
        edits.prompt = prompt.value;
      }
      const roles = roleControls
        .filter(({ control, initial }) => control.value !== initial)
        .map(({ index, control }) => ({ index, role: control.value }));
      if (roles.length) edits.references = roles;
      // The main controls carry the same values as their advanced twins: read those last.
      const values = new Map();
      if (duration) values.set('frames', duration.value);
      if (resizable) {
        values.set('width', String(size.width));
        values.set('height', String(size.height));
      }
      for (const [key, control] of controls) {
        if (key === 'stage') continue;
        const item = items.get(key);
        if (!item) continue;
        if (item.type === 'boolean') values.set(key, control.checked);
        else if (!(values.has(key) && ['frames', 'width', 'height'].includes(key))) values.set(key, control.value);
      }
      for (const [key, raw] of values) {
        const item = items.get(key),
          label = labelOf(key);
        let value;
        if (item.type === 'boolean') value = raw;
        else if (item.type === 'string') {
          value = String(raw);
          if (item.maxLength !== undefined && value.length > item.maxLength)
            throw Error(`${label} : ${item.maxLength} caractères au plus.`);
        } else if (item.choices) value = item.choices.find(choice => String(choice) === String(raw));
        else {
          const text = String(raw).trim();
          value = Number(text);
          if (!text || !Number.isFinite(value) || (item.type === 'integer' && !Number.isSafeInteger(value)))
            throw Error(`${label} : nombre invalide.`);
          if ((item.min !== undefined && value < item.min) || (item.max !== undefined && value > item.max))
            throw Error(`${label} : entre ${decimal(item.min ?? '…')} et ${decimal(item.max ?? '…')}.`);
          if (item.multipleOf && value % item.multipleOf) throw Error(`${label} : multiple de ${item.multipleOf}.`);
        }
        if (value !== undefined && value !== item.value) edits[key] = value;
      }
      return edits;
    },
    error(text) {
      message.textContent = text;
      message.hidden = !text;
    },
  };
  return form;
}

/**
 * (0.6.476) A symbol of the sprite of the page (« #i-dice », « #i-close »), as app.js draws them (icon), without a word
 * for a screen reader; the card of a proposal draws its own with it (proposal-card.mjs).
 */
export function symbol(node, name, className = '') {
  const make = tag =>
    globalThis.document?.createElementNS ? document.createElementNS('http://www.w3.org/2000/svg', tag) : node(tag);
  const svg = make('svg'),
    use = make('use');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
