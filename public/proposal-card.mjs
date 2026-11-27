import { closePopup, openPopup } from './glass-menu.mjs';
import { layoutCaption } from './layout-boxes.mjs';
import { lackingText, missingFileCard } from './missing-file.mjs';
import { takesWords } from './montage-model.mjs';
import { renderProposal, symbol } from './video-plan.mjs';

const KINDS = { video: 'Vidéo', audio: 'Son', image: 'Image' };
// (0.6.476) What a proposal says only when it is so (lib/tool-runtime.mjs, #propose): the one revised says it again
// when it still is. Kept from the one before, the line of an image taken out stayed under the card.
const SAID_WHEN_SO = [
  'notes',
  'cited',
  'held',
  'warning',
  // (0.6.493) The note of what it does not send, which the card leaves to its greyed inputs; the verb of its models.
  'heldNote',
  'models',
  'family',
  'verb',
  'fixedInputs',
  'styles',
  'camera',
  'series',
];
// (0.6.493) What the server says of a proposal it no longer has (lib/tool-runtime.mjs: EXPIRED, a token used by another
// tab, its workflow changed): « Générer » would be refused too, so it is greyed with that reason (relecture, M3).
export const GONE = /^(Cet appel a expiré|Cette proposition ne peut plus être modifiée|Le workflow a été modifié)/;
// (0.6.493) Its time over before an answer of the server says it (the server says EXPIRED in these words).
const EXPIRED_SAID = 'Cet appel a expiré. Relancez la demande.';
/**
 * (0.6.493) What a model takes, under its name in the list of the card: for a suite, the clip it goes on and what it
 * takes beside it (`extend_video.roles`: « Vidéo, son » for LTX 2.5, « Vidéo, 3 sujets, son » for MiniMax H3 Omni), not
 * what it takes for a new shot (relecture, m4).
 */
function takenWords(model, verb) {
  if (verb !== 'extend_video' || !model.extend_video) return takesWords(model);
  const words = takesWords({ ...model, create_video: model.extend_video });
  return 'Vidéo, ' + words.charAt(0).toLowerCase() + words.slice(1);
}

/**
 * The proposal of Moodix, in its message (direction-artistique.md, « La proposition vidéo »;
 * captures 11 and 12): a card that arrives with the plan, editable in place, instead of a window.
 * - With a `delay` (none in the Chat since 16/11: a video always waits for the user there, « EN
 *   ATTENTE DE VOTRE ACCORD »), a video starts by itself after it: the glass of « Générer » fills
 *   with the accent from left to right, « DÉPART DANS 18 S » at the top right of the card.
 * - The count pauses while the pointer is on the card or while something is written in the message
 *   box (« EN PAUSE »), and stops for good at a click or a key in the card (« EN ATTENTE DE VOTRE
 *   ACCORD »): then only « Générer » starts it. A sound waits for « Générer » (no count).
 * - « Annuler » leaves the line « Proposition annulée. » (answer 'cancel'); a new message declines it
 *   too ('deny'): the card goes without a trace (Moodix answers with another). No « Toujours
 *   autoriser ».
 * « + » on an input opens « Créations du projet » in the card (`takes()`: the creations of the project);
 * the image chosen goes in its case, as an image dropped or pasted on the card (`importImage(file)`:
 * kept as a reference of the project first); the server revises the proposal (`add`), no message.
 * (0.6.476) The × of an image takes it out (`remove`). The model of a video of Moodix AI (`request.models`) is chosen
 * in its title, « LTX 2.5 ⌄ », in a list of glass as in a card « À créer » of the Bobine: the server makes the proposal
 * again for it (`workflow`); what it does not take stays in the card, greyed, why in its bubble, and a line says what
 * to do. One that is not on this computer: its download offered in the card, as the card « Il manque un fichier » does.
 * Returns `answer` ('once' after the changes are sent, 'deny' or 'cancel'), `decline()` and `stop()`.
 */
export function proposalCard({
  host,
  request,
  signal,
  node,
  api,
  delay = 30000,
  composer = null,
  takes = null,
  importImage = null,
  onChange = () => {},
  // (0.6.493) The files of a model downloaded from the card are there: the page reads its models again (the Studio,
  // the Bobine), as after the card « Il manque un fichier » (relecture, m5).
  onFetched = () => {},
}) {
  const card = node('section', 'proposal-card'),
    head = node('header', 'proposal-head'),
    title = node('p', 'proposal-title'),
    status = node('p', 'proposal-status'),
    body = node('div', 'proposal-body'),
    foot = node('footer', 'proposal-foot'),
    toggles = node('div', 'proposal-toggles'),
    panels = node('div', 'proposal-panels'),
    cancel = node('button', 'proposal-cancel', 'Annuler'),
    go = node('button', 'proposal-go'),
    // (0.6.476) The download of the model chosen in the list, when it is not on this computer.
    offered = node('div', 'proposal-offer'),
    counted = request.mediaType === 'video' && delay > 0;
  card.setAttribute('aria-label', 'Proposition de Moodix');
  card.tabIndex = -1;
  status.setAttribute('aria-live', 'polite');
  cancel.type = go.type = 'button';
  go.append(node('span', 'proposal-go-play'), node('span', 'proposal-go-word', 'Générer'));
  go.setAttribute('aria-label', 'Générer');
  head.append(title, status);
  foot.append(toggles, cancel, go);
  offered.hidden = true;
  card.append(head, body, foot, panels, offered);
  host.append(card);
  const icon = name => symbol(node, name);

  let form = null,
    saving = false,
    // (0.6.476) What the server answered of a model chosen whose files are to download (revise: `offer`).
    offer = null,
    // (0.6.493) Why the proposal can no longer be made (GONE, or its time over: `expiresIn`), said on « Générer ».
    gone = '',
    expiry = null;
  /**
   * (0.6.493) « Générer » as it can be: greyed with its reason in its bubble once the proposal is gone, never left on
   * to be refused (relecture, M3); while the changes are sent, disabled a moment. Not `disabled` when greyed: its
   * bubble stays under the pointer and on the focus.
   */
  function shut() {
    go.disabled = saving && !gone;
    if (!gone) return;
    // Its count, where it has one, stops with it: nothing starts by itself.
    stop();
    go.setAttribute('aria-disabled', 'true');
    go.dataset.tip = gone;
    go.classList.remove('is-counting', 'is-held');
    say();
  }
  /** (0.6.493) The time the server keeps this proposal (`expiresIn`), counted from the answer that made it. */
  function arm() {
    clearTimeout(expiry);
    expiry = Number.isFinite(request.expiresIn)
      ? setTimeout(() => {
          gone ||= EXPIRED_SAID;
          shut();
        }, request.expiresIn)
      : null;
  }
  /**
   * « Paramètres avancés » and « Prompt » unfold and fold back softly (16/11): their height and their
   * margin go from nothing to their own in 0.22 s, the words fading in; at once with less motion
   * asked, or where the page cannot animate.
   */
  function unfold(panel, open) {
    const still = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel.moving?.cancel?.();
    panel.moving = null;
    if (open) panel.hidden = false;
    if (still || typeof panel.animate !== 'function') {
      panel.hidden = !open;
      return onChange();
    }
    const height = panel.getBoundingClientRect().height,
      gap = globalThis.getComputedStyle?.(panel).marginTop ?? '0px',
      closed = { height: '0px', marginTop: '0px', opacity: 0 },
      opened = { height: height + 'px', marginTop: gap, opacity: 1 };
    panel.style.overflow = 'hidden';
    const move = panel.animate(open ? [closed, opened] : [opened, closed], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    panel.moving = move;
    const done = () => {
      if (panel.moving !== move) return;
      panel.moving = null;
      panel.style.overflow = '';
      if (!open) panel.hidden = true;
      onChange();
    };
    move.onfinish = done;
    move.oncancel = () => (panel.style.overflow = '');
  }
  function render() {
    // (0.6.476) The model of a video of Moodix AI is a button of its title, which opens the list of the models; chosen
    // with the keys, they stay on it, drawn again with its new name.
    const again = Boolean(title.contains?.(globalThis.document?.activeElement));
    closeModels();
    const chooser = request.models?.length ? modelButton() : null;
    title.textContent = ['Proposition', KINDS[request.mediaType] ?? KINDS.image, chooser ? '' : request.workflowName]
      .filter(Boolean)
      .join(' · ');
    if (chooser) title.append(' · ', chooser);
    if (chooser && again) chooser.focus?.({ preventScroll: true });
    form = renderProposal(body, request, {
      node,
      card: true,
      onAdd: takes || importImage ? role => void openShelf(role) : null,
      onStage: (stage, edits) => void revise({ ...edits, stage }),
      onRemove: which => void reviseWith({ remove: which }),
    });
    // « Paramètres avancés › » and « Prompt › » at the foot, their panel opening under it.
    toggles.replaceChildren();
    panels.replaceChildren();
    for (const fold of form.folds ?? []) {
      const toggle = node('button', 'proposal-toggle', fold.name);
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', 'false');
      fold.panel.hidden = true;
      toggle.onclick = () => {
        const open = fold.panel.hidden;
        toggle.setAttribute('aria-expanded', String(open));
        unfold(fold.panel, open);
      };
      toggles.append(toggle);
      panels.append(fold.panel);
    }
    showOffer();
  }
  /**
   * (0.6.476) The model of a video of Moodix AI in the title of its card, as the model of a card « À créer » of the
   * Bobine (montage.mjs, modelButton): « LTX 2.5 ⌄ », which opens the list of the models (pickModel). In amber while
   * the download of the one chosen is offered.
   */
  function modelButton() {
    const shown = offer?.workflowName ?? request.workflowName,
      control = node('button', 'proposal-model');
    control.type = 'button';
    control.append(node('span', 'proposal-model-name', shown), icon('chevron'));
    control.setAttribute('aria-haspopup', 'menu');
    control.setAttribute('aria-expanded', 'false');
    control.setAttribute('aria-label', 'Modèle de la vidéo : ' + shown);
    control.dataset.tip = 'Choisir le modèle de cette vidéo';
    if (offer) control.dataset.missing = 'true';
    control.onclick = event => {
      event?.stopPropagation?.();
      if (models) return closeModels({ refocus: true });
      pickModel(control);
    };
    return control;
  }
  // (0.6.476) The list of the models while it is open: Échap, Tab or a press beside it closes it.
  let models = null;
  function closeModels({ refocus = false } = {}) {
    if (!models) return;
    const { menu, anchor, beside } = models;
    models = null;
    globalThis.document?.removeEventListener?.('pointerdown', beside, true);
    closePopup(menu);
    menu.remove?.();
    anchor.setAttribute?.('aria-expanded', 'false');
    if (refocus && anchor.isConnected !== false) anchor.focus?.();
  }
  /**
   * (0.6.476) The models that make videos, in a list of glass under the model of the card, as the Bobine lists them
   * (montage.mjs, pickModel): under each name what it takes (takesWords: « Début, fin, 2 sujets, son »), the one of
   * the proposal checked in the accent. One that is not on this computer may be chosen, its name in amber: its download
   * is offered in the card. One that cannot be chosen (this computer cannot run it, it makes no suite, it needs an
   * image the card has not) is greyed, its reason in the bubble beside the list (`off`, ToolCatalog.choices).
   */
  function pickModel(anchor) {
    const menu = node('div', 'glass-menu bobine-piece-menu bobine-model-menu'),
      chosen = offer?.family ?? request.family,
      items = [];
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Modèle de la vidéo');
    for (const model of request.models) {
      const own = model.family === chosen,
        words = takenWords(model, request.verb),
        item = node('button', 'glass-menu-item bobine-model-item' + (model.off ? ' is-off' : '')),
        text = node('span', 'bobine-model-text');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(own));
      item.setAttribute('aria-label', `${model.name}, ${words}`);
      text.append(node('span', 'bobine-model-name', model.name), node('span', 'bobine-model-takes', words));
      item.append(text);
      if (own) item.append(icon('check'));
      if (model.missing) item.dataset.missing = 'true';
      if (model.off) {
        item.setAttribute('aria-disabled', 'true');
        item.dataset.tip = model.off;
        item.dataset.tipSide = 'right';
      }
      item.onclick = () => {
        if (model.off) return;
        closeModels({ refocus: true });
        if (!own) void chooseModel(model);
      };
      items.push(item);
      menu.append(item);
    }
    menu.onkeydown = event => {
      const at = items.indexOf(globalThis.document?.activeElement),
        back = at + items.length - 1,
        last = items.length - 1,
        moves = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: back, ArrowLeft: back, Home: 0, End: last },
        to = moves[event.key];
      if (event.key === 'Tab') return closeModels();
      if (event.key !== 'Escape' && (to === undefined || !items.length)) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      if (event.key === 'Escape') closeModels({ refocus: true });
      else items[to % items.length]?.focus?.();
    };
    models = {
      menu,
      anchor,
      beside: event => !menu.contains?.(event.target) && !anchor.contains?.(event.target) && closeModels(),
    };
    card.append(menu);
    openPopup(menu, anchor, { align: 'start' });
    anchor.setAttribute('aria-expanded', 'true');
    globalThis.document?.addEventListener?.('pointerdown', models.beside, true);
    // The first choice that can be made in hand; when none can, the first all the same: its reason is read there.
    (items.find(item => item.getAttribute?.('aria-disabled') !== 'true') ?? items[0])?.focus?.();
  }
  /**
   * (0.6.476) A model chosen in the list: the server makes the proposal again for it (`workflow`, ToolRuntime.revise),
   * with what was changed in the card. One whose files are to download answers with this proposal and its download
   * (`offer`), shown in the card in place of its settings; the model of the proposal chosen again takes it away.
   */
  async function chooseModel(model) {
    if (model.family === request.family) return dismissOffer();
    await reviseWith({ workflow: model.workflowId });
  }
  /** (0.6.476) A change of the card sent with what was changed in it (the card is drawn again from the answer). */
  async function reviseWith(change) {
    if (done) return false;
    stop();
    let edits = {};
    try {
      edits = form?.edits() ?? {};
    } catch (error) {
      form?.error(error.message);
      return false;
    }
    return revise({ ...edits, ...change });
  }
  function dismissOffer() {
    if (!offer) return;
    offer = null;
    render();
  }
  /**
   * (0.6.476) The download of the model chosen that is not on this computer, offered as the card « Il manque un
   * fichier » offers it (missing-file.mjs), in place of the settings of the card, of « Annuler » and of « Générer »:
   * its own « Annuler » goes back to the proposal as it was. The files there, the proposal is made again for that
   * model.
   */
  function showOffer() {
    const shown = offer;
    body.hidden = foot.hidden = panels.hidden = Boolean(shown);
    offered.hidden = !shown;
    offered.replaceChildren();
    say();
    if (!shown) return;
    missingFileCard({
      // Its « Annuler » leaves the line « Proposition annulée. » where it was: here, the proposal again.
      host: { append: item => (item.className === 'proposal-cancelled' ? dismissOffer() : offered.append(item)) },
      request: { missing: shown, mediaType: request.mediaType, workflowName: shown.workflowName },
      node,
      icon,
      api,
      onReady: () => {
        if (done || offer !== shown) return false;
        onFetched();
        void revise({ workflow: shown.workflowId });
        return true;
      },
    });
  }
  /**
   * « Créations du projet » under the cases (as in the Studio): the images of the project, the newest
   * at the left, 56 px; one taken goes in the case. No × (16/11): Échap or a click beside it closes
   * it, and again the same « + ».
   */
  let shelfRole = null;
  function closeShelf() {
    if (form?.shelf) form.shelf.hidden = true;
    shelfRole = null;
    globalThis.document?.removeEventListener?.('pointerdown', beside, true);
  }
  // A click beside it closes it; a case of the card (its « + ») opens or closes it itself.
  function beside(event) {
    if (form?.shelf?.contains?.(event.target) || event.target?.closest?.('.proposal-input')) return;
    closeShelf();
  }
  async function openShelf(role) {
    const shelf = form?.shelf;
    if (!shelf) return;
    if (shelfRole === role && !shelf.hidden) return closeShelf();
    shelfRole = role;
    const head = node('p', 'proposal-shelf-title', 'Créations du projet'),
      row = node('div', 'proposal-shelf-row');
    row.append(node('span', 'proposal-shelf-note', takes ? 'Chargement…' : 'Glissez ou collez une image ici.'));
    shelf.replaceChildren(head, row);
    // A file of the computer, at the end (as in the Studio).
    if (importImage) {
      const file = node('button', 'proposal-shelf-file', 'Depuis l’ordinateur…'),
        input = node('input');
      file.type = 'button';
      Object.assign(input, { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
      input.onchange = () => void addFile(role, input.files?.[0]);
      file.onclick = () => input.click?.();
      shelf.append(file, input);
    }
    shelf.hidden = false;
    globalThis.document?.addEventListener?.('pointerdown', beside, true);
    if (!takes) return;
    let list = [];
    try {
      list = (await takes()).filter(record => !record.mediaType || record.mediaType === 'image');
    } catch (error) {
      row.replaceChildren(node('span', 'proposal-shelf-note', error.message));
      return;
    }
    if (shelfRole !== role || done) return;
    row.replaceChildren(
      ...(list.length ? [] : [node('span', 'proposal-shelf-note', 'Aucune image dans ce projet pour l’instant.')]),
      ...list.slice(0, 40).map(record => {
        const output = record.outputs?.[0] ?? {},
          pick = node('button', 'proposal-shelf-pick'),
          picture = node('img');
        pick.type = 'button';
        const name = Number.isInteger(output.take) ? 'Prise ' + output.take : 'Image',
          // (0.6.477) A take made with boxes (MOSS Image) by its caption, never by their JSON.
          said = layoutCaption(record.prompt);
        pick.setAttribute('aria-label', 'Prendre : ' + name + (said ? ' · ' + said : ''));
        pick.title = name;
        Object.assign(picture, { src: output.thumbUrl || output.originalUrl || '', alt: '', loading: 'lazy', decoding: 'async' });
        pick.append(picture);
        pick.onclick = () =>
          void addInput(role, { output: record.id, ...(record.conversationId ? { conversation: record.conversationId } : {}) });
        return pick;
      }),
    );
  }
  /** An image in a case of the card: the proposal revised with it. */
  async function addInput(role, source) {
    if (!role || done) return;
    stop();
    // What was already changed in the card goes with it (the card is drawn again from the answer).
    let edits = {};
    try {
      edits = form?.edits() ?? {};
    } catch (error) {
      form?.error(error.message);
      return;
    }
    shelfRole = null;
    await revise({ ...edits, add: { role, source } });
  }
  /** A file dropped or pasted on the card: kept as a reference of the project, then put in its case. */
  async function addFile(role, file) {
    if (!importImage || !file || !/^image\/(png|jpeg|webp)$/.test(file.type || '')) return;
    try {
      const kept = await importImage(file);
      if (kept?.id) await addInput(role, { resource: kept.id });
    } catch (error) {
      form?.error(error.message);
    }
  }
  /** The case an image goes to: the one under the pointer, else the open one, else the first empty. */
  function roleAt(target) {
    const hit = target?.closest?.('[data-role]');
    if (hit) return hit.getAttribute('data-role');
    if (shelfRole) return shelfRole;
    return form?.emptyRoles?.()[0] ?? null;
  }
  card.addEventListener?.('dragover', event => {
    if (!event.dataTransfer?.types?.includes?.('Files')) return;
    event.preventDefault();
    card.classList.add('is-dropping');
  });
  card.addEventListener?.('dragleave', event => {
    if (!card.contains(event.relatedTarget)) card.classList.remove('is-dropping');
  });
  card.addEventListener?.('drop', event => {
    card.classList.remove('is-dropping');
    const [file] = event.dataTransfer?.files ?? [];
    if (!file) return;
    event.preventDefault();
    void addFile(roleAt(event.target), file);
  });
  card.addEventListener?.('paste', event => {
    // (0.6.331) Text that comes with a picture of itself (cells of Excel): left to the field, as in the Chat.
    if (event.clipboardData?.getData?.('text/plain')?.trim()) return;
    const file = [...(event.clipboardData?.files ?? [])].find(item => item.type?.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void addFile(roleAt(event.target), file);
  });
  // The changes sent: the revised proposal (a new token) replaces this one.
  async function revise(edits) {
    if (saving) return false;
    saving = true;
    go.disabled = true;
    try {
      const revised = await (
        await api('tools/revise', { requestId: request.requestId, approvalToken: request.approvalToken, edits })
      ).json();
      if (signal?.aborted || done) return false;
      // (0.6.476) The new proposal says again what is still so (SAID_WHEN_SO); the download of a model chosen comes
      // beside it (`offer`), shown in the card, not kept with the proposal.
      const { offer: offering = null, ...proposal } = revised;
      for (const key of SAID_WHEN_SO) delete request[key];
      Object.assign(request, proposal);
      offer = offering;
      arm();
      render();
      return true;
    } catch (error) {
      // (0.6.493) The proposal gone (its time over, the server started again): « Générer » greyed with why.
      if (GONE.test(error.message ?? '')) gone = error.message;
      // (0.6.476) Refused while a download was offered (the files came, the proposal had expired meanwhile): the card
      // of the proposal again, the reason under it.
      if (offer) {
        offer = null;
        render();
      }
      form?.error(error.message);
      return false;
    } finally {
      saving = false;
      shut();
    }
  }

  // The count: 'counting', 'paused' (hold), or 'waiting' (stopped for good).
  let phase = counted ? 'counting' : 'waiting',
    left = delay,
    since = 0,
    timer = null,
    ticking = null,
    pointer = false;
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  function say() {
    status.textContent =
      phase === 'waiting' ? (request.mediaType === 'video' ? 'En attente de votre accord' : '') : phase === 'paused' ? 'En pause' : `Départ dans ${Math.max(1, Math.ceil(left / 1000))} s`;
    // (0.6.493) Gone, it no longer waits for anything. While the download of the model chosen is offered, the head of
    // the card says it, in place of the head of the offer (« Il manque un fichier », which hid its title: m6).
    // (0.6.503) In the words of the card of the offer: « Il manque des fichiers » for several (LTX 2.5's six, 27/11).
    if (offer) status.textContent = lackingText(offer);
    if (gone) status.textContent = gone.startsWith('Cet appel a expiré') ? 'Expirée' : 'Plus valable';
    card.dataset.phase = phase;
  }
  function clear() {
    clearTimeout(timer);
    clearInterval(ticking);
    timer = ticking = null;
  }
  function run() {
    since = now();
    // The fill of « Générer » lasts the whole count; held, it waits with it (is-held), never restarts.
    if (!go.classList.contains('is-counting')) go.style.setProperty('--left', left + 'ms');
    go.classList.add('is-counting');
    go.classList.remove('is-held');
    timer = setTimeout(() => void confirm(), left);
    ticking = setInterval(() => {
      left = Math.max(0, left - (now() - since));
      since = now();
      say();
    }, 250);
  }
  function hold() {
    if (phase !== 'counting') return;
    clear();
    left = Math.max(0, left - (now() - since));
    phase = 'paused';
    go.classList.add('is-held');
    say();
  }
  function release() {
    if (phase !== 'paused' || pointer || composer?.value?.trim()) return;
    phase = 'counting';
    run();
    say();
  }
  function stop() {
    if (phase === 'waiting') return;
    clear();
    phase = 'waiting';
    go.classList.remove('is-counting', 'is-held');
    say();
  }
  const enter = () => {
    pointer = true;
    hold();
  };
  const leave = () => {
    pointer = false;
    release();
  };
  const typing = () => (composer?.value?.trim() ? hold() : release());
  const touched = event => {
    // Générer and Annuler answer themselves; anything else in the card stops the count.
    if (event.target === go || go.contains?.(event.target) || event.target === cancel) return;
    stop();
  };

  let settle;
  const answer = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let done = false;
  function finish(value, { line = false } = {}) {
    if (done) return;
    done = true;
    clear();
    clearTimeout(expiry);
    closeModels();
    card.removeEventListener('pointerenter', enter);
    card.removeEventListener('pointerleave', leave);
    card.removeEventListener('pointerdown', touched, true);
    card.removeEventListener('keydown', touched, true);
    card.removeEventListener('keydown', escape);
    globalThis.document?.removeEventListener?.('pointerdown', beside, true);
    composer?.removeEventListener?.('input', typing);
    signal?.removeEventListener?.('abort', abort);
    card.remove();
    // Cancelled from the card: a line says it where it was.
    if (line) host.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
    onChange();
    if (value instanceof Error) settle.reject(value);
    else settle.resolve(value);
  }
  // What runs is what the card shows: its changes are sent first.
  async function confirm() {
    // (0.6.493) Gone: refused here, its reason in the bubble of « Générer ».
    if (saving || done || gone) return;
    stop();
    if (form) {
      let edits;
      try {
        edits = form.edits();
      } catch (error) {
        form.error(error.message);
        return;
      }
      if (Object.keys(edits).length && !(await revise(edits))) return;
    }
    finish('once');
  }
  const abort = () => finish(signal.reason || new DOMException('Annulé', 'AbortError'));

  // Échap closes « Créations du projet » (16/11: no ×).
  const escape = event => {
    if (event.key !== 'Escape' || !shelfRole) return;
    event.preventDefault?.();
    closeShelf();
  };
  render();
  say();
  arm();
  cancel.onclick = () => finish('cancel', { line: true });
  go.onclick = () => void confirm();
  card.addEventListener('pointerenter', enter);
  card.addEventListener('pointerleave', leave);
  card.addEventListener('pointerdown', touched, true);
  card.addEventListener('keydown', touched, true);
  card.addEventListener('keydown', escape);
  composer?.addEventListener?.('input', typing);
  signal?.addEventListener?.('abort', abort, { once: true });
  if (signal?.aborted) abort();
  else if (phase === 'counting') {
    run();
    if (composer?.value?.trim()) hold();
  }
  onChange();
  return { answer, decline: () => finish('deny'), stop, card };
}
