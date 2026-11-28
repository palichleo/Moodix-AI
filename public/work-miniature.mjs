import { fluxStart, takeFlux } from './take-flux.mjs';
import { livePreview } from './live-preview.mjs';
import { generationTime, takeTime } from './generation-time.mjs';

/**
 * The miniature of the chat (0.6.81). While a work of a conversation goes on (Moodix answers, a
 * card waits for the user, a take is made) and the user looks elsewhere (another conversation, the
 * Pellicule, the Paramètres; never its Chat nor its Studio, 0.6.96), a small window of glass at the
 * bottom right of the page shows it as the conversation does: the Éclipse of Moodix and the name of
 * the conversation, the take in progress (the Flux of the picture so far, « VIDÉO · LTX 2.5 », its
 * stage and its percentage, the line that fills). A click brings the user back to the conversation.
 * Ended while they are away, it says how (the take made, with its picture; a failure, in amber; a
 * cancellation) until they are back there, or close it (×). The dash folds it into a pill, which the
 * browser keeps; in the Paramètres it is that pill, in the foot of their window (`place`).
 *
 * app.js tells it the work (`begin`, `rename`, `answer`, `end`) and where it shows (`place`); the
 * cards of the conversation tell it the take (`take`, from generation-ui.mjs: start, progress,
 * image, done, failed, stopped). `open()` brings back to the conversation; `mark()` draws the
 * Éclipse of Moodix; `makeFlux` and `makePreview` draw the take (none in the tests).
 *
 * (0.6.478) It is the place of the queue of the Studio too (variante A of claude_design/maquette-file-bas-droite):
 * under the take, what waits, in its order (`queue`, from studio.mjs: per conversation, a line per request and its
 * cross; paused, why, and at its foot « Reprendre · 3 » and « Vider la file »; those that failed, in red). Folded, the
 * pill says « 3 en attente » beside the percentage. In the Chat of that conversation the list alone (`alone`); in its
 * Studio, the list alone lies under the settings, at their width (`dock`); in a Chat of 1168 px, where it covered the
 * end of the input, its pill rises over it (`raise`). A queue paused keeps the window, with no ×, until « Reprendre »
 * or « Vider la file ».
 */
export const FOLDED_KEY = 'moodix.miniature';
/** (0.6.478) The room a list needs under the settings of the Studio: its title, a line, the air around them. */
const ROOM = 30 + 46 + 26;
/** (0.6.501) The height of its pill (moodix.css), and how far it lies from the settings above it and the Sortie. */
const PILL = 44,
  APART = 4;
/**
 * (0.6.505) What a list says there beyond ROOM, above its first line or at its foot, stuck at the bottom of the window
 * over its lines (moodix.css): the name of another conversation (28 px), why it is paused (25 px a line), « Reprendre
 * · 3 » and « Vider la file » (45 px). ROOM alone, at 1168 × 788 the first line of the queue of another conversation
 * lay whole under its foot (46 px of 46).
 */
const NAME = 28,
  WHY = 25,
  FOOT = 45;
/**
 * (0.6.505) How many lines why it is paused takes at the width of the settings (268 px): measured, 24,9 px for « La
 * carte graphique est restée prise. » (36 characters), 41,8 px for each « Page rechargée : … » (50 and more).
 */
const whyLines = text => (String(text).length > 40 ? 2 : 1);
const KINDS = { image: 'Image', video: 'Vidéo', audio: 'Son' };
// What « waiting » says when nothing else is said (waitFor).
const WAITING = 'En attente de votre accord';
/** « 42 % », as the message box says it. */
const percentOf = fraction => Math.floor(Math.min(1, Math.max(0, fraction)) * 100) + ' %';

export function setupMiniature({
  node,
  icon = () => null,
  mark = () => null,
  open = () => {},
  // « × »: whether the miniature may go (false keeps it), then what goes with it (0.6.87: without the
  // history, the conversation it leads back to can be found nowhere else).
  mayClose = () => true,
  onClosed = () => {},
  // (0.6.478) The gestures of the list of the queue (each told the id it is about, then its conversation): a line
  // taken out, « Reprendre », « Vider la file », a request that failed given back to the Studio, the name of a
  // conversation (back to its Studio), « Libérer le GPU ».
  onRemove = () => {},
  onResume = () => {},
  onClear = () => {},
  onTakeBack = () => {},
  onOpenQueue = () => {},
  onRecover = () => {},
  storage = globalThis.localStorage,
  makeFlux = takeFlux,
  makePreview = livePreview,
} = {}) {
  const root = node('aside', 'work-mini'),
    back = node('button', 'work-mini-back'),
    head = node('span', 'work-mini-head'),
    // The Éclipse of Moodix signs it (in 232 px, the word « MOODIX » left the name of the
    // conversation a few letters: measured 64 px at 1280 × 720).
    signature = node('span', 'work-mini-mark'),
    title = node('span', 'work-mini-title'),
    frame = node('span', 'work-mini-frame'),
    still = node('img', 'work-mini-still'),
    line = node('span', 'work-mini-line'),
    kind = node('span', 'work-mini-kind'),
    figure = node('span', 'work-mini-percent'),
    stage = node('span', 'work-mini-stage'),
    // Its words, and at their right how long the take has been in the making, then how long it took
    // (0.6.93): what its card says.
    stageWords = node('span', 'work-mini-said'),
    stageTime = node('time', 'work-mini-time'),
    bar = node('span', 'work-mini-bar'),
    fill = node('span', 'work-mini-fill'),
    fold = node('button', 'work-mini-fold'),
    close = node('button', 'work-mini-close'),
    // (0.6.478) What waits in the queue of the Studio, under the take.
    list = node('div', 'work-mini-file');
  root.hidden = true;
  list.hidden = true;
  root.setAttribute('aria-label', 'Miniature de la conversation en cours');
  back.type = fold.type = close.type = 'button';
  still.alt = '';
  still.decoding = 'async';
  still.hidden = true;
  const drawn = mark?.();
  if (drawn) signature.append(drawn);
  signature.setAttribute('aria-hidden', 'true');
  head.append(signature, title);
  frame.append(still);
  frame.setAttribute('aria-hidden', 'true');
  line.append(kind, figure);
  stage.append(stageWords, stageTime);
  bar.append(fill);
  bar.setAttribute('aria-hidden', 'true');
  back.append(head, frame, line, stage, bar);
  // The chevron folds it (turned over once folded: it opens it again).
  for (const [button, glyph] of [
    [fold, 'chevron'],
    [close, 'close'],
  ]) {
    const drawnIcon = icon(glyph);
    if (drawnIcon) button.append(drawnIcon);
  }
  close.setAttribute('aria-label', 'Fermer la miniature');
  close.title = 'Fermer';
  close.hidden = true;
  root.append(back, list, fold, close);

  let work = null,
    // What it says: 'answer' (Moodix answers, no take in hand), 'waiting' (a card waits for the
    // user), 'making', then 'done', 'failed', 'stopped' or 'answered' (the turn over without a take).
    phase = 'answer',
    running = false,
    shown = false,
    words = 'Moodix répond…',
    // What 'waiting' says (0.6.88: Moodix AI may wait for the user in the Studio, see waitFor).
    waitingWords = WAITING,
    kindText = '',
    stageText = '',
    // The count of its card while it is made; how long it took, once made (0.6.93).
    timeText = '',
    madeTime = '',
    fraction = null,
    picture = '',
    // The address the still shows (`src` reads back as a whole address).
    stillAt = '',
    request = null,
    flux = null,
    live = null,
    // Somewhere to be put back when the Paramètres close (`place`).
    corner = null;
  let folded = false;
  try {
    folded = storage?.getItem?.(FOLDED_KEY) === 'pill';
  } catch {
    // Without the browser's storage: the card.
  }
  // (0.6.200) Put as its pill whatever the user keeps (`place`: on the page of the Bobine, open in its corner, it
  // covered the end of the timeline), and whether its chevron opened it there: for that page only, the choice
  // kept for the other pages left as it was.
  let pillHere = false,
    openedHere = false;
  // (0.6.478) The queue (`queue`): its parts, and the key of the list last drawn (drawn again only when it changes:
  // its scroll, the line under the pointer and the focus stay). `alone`: the list without the take, which the page
  // shows; `home`: the conversation whose Chat or Studio is on screen (its name is not said there); `docked`: where it
  // lies in the Studio ({ left, width, bottom, room, over }); `raised`: how high over the input of the chat its pill
  // goes. Folded or opened there alone (`localMode`, `closedHere`), nothing kept. `footed`: in the foot of the
  // Paramètres, where it is its pill.
  let parts = [],
    listKey = '',
    alone = false,
    home = null,
    docked = null,
    raised = 0,
    localMode = '',
    closedHere = false,
    footed = false;
  // (0.6.478) Lying in the Studio where a line has no room (1280 × 720): its title alone, until its chevron opens it
  // over the settings.
  // (0.6.505) Its room counted from what its first list says: the queue of another conversation, its name, why it is
  // paused and its foot (1168 × 788: 135 px under the settings, 188 needed), is its title alone too.
  const tight = () => Boolean(docked) && docked.room < roomOf(parts[0]);
  /** (0.6.505) The room a list needs under the settings for its first line whole: ROOM, and what it says beyond. */
  function roomOf(part) {
    if (!part) return ROOM;
    const why = part.why ? WHY * whyLines(part.why) : 0;
    return ROOM + (part.conversation !== home ? NAME : 0) + why + (part.foot ? FOOT : 0);
  }
  const foldedNow = () =>
    pillHere || tight() ? !openedHere : docked ? closedHere : folded;
  /**
   * (0.6.501) Where its foot lies in the Studio, from that of the page: on the foot of the screen; as its line, with
   * less room under the settings than its height, lower, APART under them, never nearer the Sortie than APART. At
   * 1280 × 720 the settings of a model not on this computer are 45 px taller: it covered 6 px of them.
   */
  function dockBottom() {
    if (!tight() || !Number.isFinite(docked.under)) return docked.bottom;
    const lowered = Math.min(docked.bottom, docked.under - APART - PILL);
    return Number.isFinite(docked.floor) ? Math.max(docked.floor + APART, lowered) : lowered;
  }
  /**
   * (0.6.501) Its line in the Studio says « Reprendre · 3 » when the button of the Studio does not (a model not on this
   * computer: « Télécharger »; a take followed after a reload): it was behind the chevron, at 1280 × 720 and 1168 ×
   * 788. For the queue of the conversation shown only, the first one: the line has no room for the name of another.
   */
  const pillFoot = () => tight() && foldedNow() && Boolean(parts[0]?.foot) && parts[0].conversation === home;

  /** The Flux of the take in progress, in the frame, from the picture so far (as the card's). */
  function startFlux(asked) {
    stopFlux();
    flux = makeFlux?.(frame, { node }) ?? null;
    live = makePreview?.(node, frame, { onLoad: image => flux?.source(image) }) ?? null;
    const start = fluxStart(asked?.plan?.references);
    if (start) flux?.source(start);
    else flux?.neutral();
    flux?.visible(shown);
  }
  function stopFlux() {
    flux?.stop();
    live?.clear();
    flux = live = null;
  }
  function paint() {
    const making = phase === 'making' || phase === 'waiting',
      ended = ['done', 'failed', 'stopped', 'answered'].includes(phase),
      said =
        phase === 'answer'
          ? words
          : phase === 'waiting'
            ? waitingWords
            : phase === 'making'
              ? stageText
              : phase === 'done'
                ? stageText
                : phase === 'failed'
                  ? stageText
                  : phase === 'stopped'
                    ? 'Génération arrêtée.'
                    : 'Moodix a répondu';
    title.textContent = work?.title || 'Nouvelle conversation';
    kind.textContent = phase === 'answer' || phase === 'answered' ? '' : kindText;
    figure.textContent = phase === 'making' && Number.isFinite(fraction) ? percentOf(fraction) : '';
    stageWords.textContent = said;
    stageTime.textContent = phase === 'making' ? timeText : phase === 'done' ? madeTime : '';
    fill.style?.setProperty?.('--mini-progress', String(Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0));
    root.dataset.phase = phase;
    root.classList.toggle('has-take', Boolean(kindText) && phase !== 'answer' && phase !== 'answered');
    root.classList.toggle('is-folded', foldedNow());
    // (0.6.478) The take above the list, or the list alone; as its pill (folded, or in the foot of the Paramètres), it
    // says what waits beside the percentage.
    const now = Boolean(work) && !alone,
      count = now && (foldedNow() || footed) ? countOf() : null;
    back.hidden = !now;
    list.hidden = !parts.length;
    if (count) kind.textContent = count.text;
    kind.classList.toggle('is-count', Boolean(count));
    kind.classList.toggle('is-paused', Boolean(count?.paused));
    root.classList.toggle('has-now', now);
    root.classList.toggle('has-queue', parts.length > 0);
    root.classList.toggle('has-count', Boolean(count));
    root.classList.toggle('is-docked', Boolean(docked));
    root.classList.toggle('is-over', tight() && openedHere);
    root.classList.toggle('is-raised', raised > 0);
    root.classList.toggle('has-pill-foot', pillFoot());
    // (0.6.501) What lies in the Studio is given to its style by name (`under`, `floor`: dockBottom only).
    const spots = docked
      ? {
          left: docked.left,
          width: docked.width,
          bottom: dockBottom(),
          room: Math.max(PILL, docked.room),
          over: docked.over,
        }
      : raised
        ? { raise: raised }
        : {};
    for (const [name, value] of Object.entries(spots)) root.style?.setProperty?.(`--work-mini-${name}`, `${value}px`);
    drawList(now);
    bar.hidden = !(phase === 'making' || phase === 'done');
    bar.classList.toggle('is-determinate', Number.isFinite(fraction));
    still.hidden = !picture || making;
    if (picture && stillAt !== picture) {
      stillAt = picture;
      still.src = picture;
    }
    // The × once the work is over: it stays until the user is back there, or closes it. (0.6.478) Never for the list:
    // a queue stays until « Reprendre » or « Vider la file ».
    close.hidden = running || !ended || !now;
    const folding = foldedNow() ? 'Agrandir la miniature' : 'Réduire la miniature';
    fold.setAttribute('aria-label', folding);
    fold.setAttribute('aria-pressed', String(foldedNow()));
    fold.title = foldedNow() ? 'Agrandir' : 'Réduire';
    back.setAttribute(
      'aria-label',
      `Revenir à la conversation « ${title.textContent} » : ${[kind.textContent, said, figure.textContent, stageTime.textContent].filter(Boolean).join(' · ')}`,
    );
  }
  /** (0.6.478) What the pill says of the queue: « 3 en attente », else « 3 en pause », else « 1 en échec »; or null. */
  function countOf() {
    const groups = parts.flatMap(part => part.groups),
      rows = state => groups.reduce((sum, group) => sum + (group.state === state ? group.rows.length : 0), 0);
    const [waiting, paused, failed] = ['waiting', 'paused', 'failed'].map(rows);
    if (waiting) return { text: `${waiting} en attente` };
    if (paused) return { text: `${paused} en pause`, paused: true };
    return failed ? { text: `${failed} en échec` } : null;
  }
  /**
   * (0.6.478) The list of the queue, drawn again only when what it says changes (the take draws the window each
   * second): its scroll and the line under the pointer stay; the focus stays on its control, or goes to the next one
   * when its line went (its cross pressed from the keyboard).
   */
  function drawList(now) {
    const key = JSON.stringify([parts, home, now && work?.conversationId, now && phase === 'stopped']);
    if (key === listKey) return;
    listKey = key;
    const spots = () => [...(list.querySelectorAll?.('[data-spot]') ?? [])],
      focused = root.ownerDocument?.activeElement,
      at = list.contains?.(focused) ? spots().indexOf(focused) : -1,
      was = at >= 0 ? focused.dataset.spot : '',
      lists = () => [...(list.querySelectorAll?.('[data-rows]') ?? [])],
      scrolled = new Map(lists().map(rows => [rows.dataset.rows, rows.scrollTop])),
      // (Where the window has no more room, the list scrolls as one: moodix.css.)
      top = list.scrollTop;
    list.replaceChildren?.(...parts.map(part => drawPart(part, now)));
    for (const rows of lists()) rows.scrollTop = scrolled.get(rows.dataset.rows) ?? 0;
    if (top) list.scrollTop = top;
    if (at < 0) return;
    const again = spots();
    (again.find(spot => spot.dataset.spot === was) ?? again[Math.min(at, again.length - 1)] ?? fold).focus?.();
  }
  /** The queue of one conversation: its name, why it is paused, its lines, the queue full, its foot. */
  function drawPart(part, now) {
    const box = node('section', 'work-mini-queue'),
      // The take above is its own, or the page shows its Chat or its Studio: its name is said there already.
      named = part.conversation !== home && !(now && work?.conversationId === part.conversation);
    box.setAttribute('aria-label', `File du Studio : « ${part.title} »`);
    if (named) {
      const name = node('button', 'work-mini-queue-back'),
        sign = node('span', 'work-mini-mark'),
        drawn = mark?.();
      name.type = 'button';
      if (drawn) sign.append(drawn);
      sign.setAttribute('aria-hidden', 'true');
      name.append(sign, node('span', 'work-mini-queue-name', part.title));
      name.setAttribute('aria-label', `Revenir au Studio de « ${part.title} »`);
      name.dataset.spot = `back:${part.conversation}`;
      name.onclick = () => onOpenQueue(part.conversation);
      box.append(name);
    }
    // (« Génération arrêtée. » not said twice, under the take that says it.)
    const said = part.stopped && now && phase === 'stopped' && work?.conversationId === part.conversation;
    if (part.why && !said) box.append(node('p', 'work-mini-queue-why' + (part.card ? ' is-card' : ''), part.why));
    for (const group of part.groups) {
      if (group.word) {
        const head = node('div', `work-mini-queue-head is-${group.state}`),
          title = node('span', 'work-mini-queue-title');
        title.append(node('b', '', group.word), node('span', 'work-mini-queue-count', ` · ${group.rows.length}`));
        head.append(title);
        box.append(head);
      }
      const rows = node('ol', `work-mini-rows is-${group.state}`);
      rows.dataset.rows = `${part.conversation}|${group.state}`;
      rows.append(...group.rows.map(item => drawRow(item, group.state === 'failed', part.conversation)));
      box.append(rows);
    }
    if (part.note) box.append(node('p', 'work-mini-queue-note', part.note));
    if (part.held) box.append(node('p', 'work-mini-held', part.held));
    if (part.foot) box.append(drawFoot(part));
    return box;
  }
  /** A line: its kind, the start of its prompt, its model and its format, its tries; one that failed, why. */
  function drawRow(item, failed, conversation) {
    const line = node('li', 'work-mini-row' + (failed ? ' is-failed' : '')),
      words = node(failed ? 'button' : 'span', 'work-mini-row-words'),
      what = node('span', 'work-mini-row-what'),
      cross = node('button', 'work-mini-row-del'),
      gone = failed ? 'Retirer cette demande' : 'Retirer de la file',
      [drawn, shut] = [icon(item.icon), icon('close')];
    line.dataset.media = item.kind;
    if (drawn) line.append(drawn);
    if (failed) what.append(node('span', 'work-mini-row-why', `Échec · ${item.reason}`));
    else what.append(node('span', 'work-mini-row-model', item.what));
    if (!failed && item.tries > 1) what.append(node('span', 'work-mini-row-tries', `× ${item.tries}`));
    words.append(node('span', 'work-mini-row-text', item.prompt), what);
    // Its kind and its whole prompt in its bubble, at the left of the window (help-tips.mjs): above it, it hid the
    // line before. Not the bubble of its cross: at its left, it would hide its own line.
    words.title = item.tip;
    words.dataset.tipSide = 'left';
    if (failed) {
      words.type = 'button';
      words.setAttribute(
        'aria-label',
        `Échec · ${item.reason} · ${item.prompt} · un clic remet ses réglages dans le Studio`,
      );
      words.dataset.spot = `pick:${item.id}`;
      words.onclick = () => onTakeBack(item.id, conversation);
    }
    cross.type = 'button';
    if (shut) cross.append(shut);
    cross.title = gone;
    cross.setAttribute('aria-label', gone);
    cross.dataset.spot = `del:${item.id}`;
    cross.onclick = () => onRemove(item.id, conversation);
    line.append(words, cross);
    return line;
  }
  /**
   * Its foot, paused: « Reprendre · 3 » (greyed with why, which it says above it and in its bubble; « Libérer le
   * GPU » while the card is held), and « Vider la file ».
   */
  function drawFoot(part) {
    const { foot } = part,
      box = node('div', 'work-mini-foot'),
      go = node('button', 'work-mini-resume'),
      clear = node('button', 'work-mini-clear', 'Vider la file'),
      drawn = icon(foot.icon);
    go.type = clear.type = 'button';
    if (drawn) go.append(drawn);
    go.append(node('span', '', foot.label));
    go.title = foot.tip;
    go.dataset.tipSide = 'left';
    go.dataset.spot = `go:${part.conversation}`;
    if (foot.held) go.setAttribute('aria-disabled', 'true');
    go.onclick = () => {
      if (foot.held) return;
      if (foot.recover) onRecover(part.conversation);
      else onResume(part.conversation);
    };
    clear.title = foot.clear;
    clear.dataset.spot = `clear:${part.conversation}`;
    clear.onclick = () => onClear(part.conversation);
    box.append(go, clear);
    return box;
  }
  back.onclick = () => open(work);
  fold.onclick = () => {
    // (0.6.200) Where it comes as its pill: opened, or folded again, there alone; nothing kept.
    // (0.6.478) Lying in the Studio with no room for a line: opened over the settings, or folded again, there alone.
    if (pillHere || tight()) {
      openedHere = !openedHere;
      return paint();
    }
    if (docked) {
      closedHere = !closedHere;
      return paint();
    }
    folded = !folded;
    try {
      storage?.setItem?.(FOLDED_KEY, folded ? 'pill' : 'card');
    } catch {
      // Kept for this page only.
    }
    paint();
  };
  close.onclick = () => {
    const was = work;
    if (mayClose(was) === false) return;
    forget();
    onClosed(was);
  };
  // (0.6.478) Opened over the settings of the Studio, where it had no room: a click beside it, or Échap, folds it.
  const page = root.ownerDocument;
  const foldBack = () => {
    if (!tight() || !openedHere) return;
    openedHere = false;
    paint();
  };
  page?.addEventListener?.('pointerdown', event => root.contains(event.target) || foldBack(), true);
  page?.addEventListener?.('keydown', event => event.key === 'Escape' && foldBack());
  // (0.6.478) Its height, for a page that scrolls under it: the last row of the Archives comes out from under it,
  // however long its list (moodix.css).
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(() =>
      page?.documentElement?.style?.setProperty?.('--work-mini-height', `${root.offsetHeight || 0}px`),
    ).observe(root);

  /** The work of a conversation begins: what it says starts again. */
  function begin(given) {
    stopFlux();
    work = given ? { ...given } : null;
    phase = 'answer';
    running = Boolean(work);
    words = 'Moodix répond…';
    kindText = stageText = picture = timeText = madeTime = '';
    fraction = null;
    request = null;
    paint();
  }
  /**
   * The take in hand, not begun, waits for the user somewhere else (0.6.88: Moodix AI in the Studio
   * of its conversation): `text` in place of « Préparation… », and no Flux. Its first progress makes
   * it again.
   */
  function waitFor(text) {
    if (!work || !running || !text || !['making', 'waiting'].includes(phase) || Number.isFinite(fraction)) return;
    if (phase === 'waiting' && waitingWords === text) return;
    stopFlux();
    phase = 'waiting';
    waitingWords = text;
    paint();
  }
  /** Moodix answers (no take in hand): what the line says (« Le modèle se charge… »). */
  function answer(text) {
    if (!work || !text) return;
    words = text;
    if (phase === 'answer') paint();
  }
  /** A card of the conversation says where its take is (generation-ui.mjs, `onLive`). */
  function take(event = {}) {
    if (!work || !running) return;
    const asked = event.request ?? request ?? {};
    if (event.type === 'start') {
      request = asked;
      waitingWords = WAITING;
      kindText = [KINDS[asked.mediaType] ?? KINDS.image, asked.workflowName].filter(Boolean).join(' · ');
      fraction = null;
      picture = timeText = madeTime = '';
      stageText = 'Préparation…';
      // A video or a sound waits for the user on its card (or in the Studio); an image is made at once.
      // (0.6.180) Nor one of the Studio or of the Bobine (`compact`): accepted by its click, it said « En
      // attente de votre accord » until its first step.
      phase = ['video', 'audio'].includes(asked.mediaType) && !asked.autoAllow && !event.compact ? 'waiting' : 'making';
      if (phase === 'making') startFlux(asked);
      else stopFlux();
    } else if (event.type === 'progress') {
      if (phase !== 'making') startFlux(asked);
      phase = 'making';
      stageText = event.text || stageText || 'Génération…';
      if (Number.isFinite(event.fraction)) {
        fraction = event.fraction;
        flux?.progress(fraction);
      }
      if (event.preview) live?.show(event.preview);
    } else if (event.type === 'time') {
      // Its card's count (generation-ui.mjs), each second: drawn while it is made.
      timeText = String(event.text ?? '');
      if (phase !== 'making') return;
    } else if (event.type === 'image') {
      const output = event.record?.outputs?.[event.index ?? 0] ?? {};
      picture = output.thumbUrl || output.analysisDataUrl || (event.record?.mediaType === 'image' ? output.originalUrl : '') || picture;
      if (Number.isInteger(output.take)) work.take = output.take;
    } else if (event.type === 'done') {
      stopFlux();
      if (event.record || !event.failed) {
        const output = event.record?.outputs?.[0] ?? {};
        picture ||= output.thumbUrl || output.analysisDataUrl || (event.record?.mediaType === 'image' ? output.originalUrl : '') || '';
        const number = Number.isInteger(output.take) ? output.take : work.take;
        phase = 'done';
        fraction = 1;
        stageText = Number.isInteger(number) ? `Prise ${number} prête` : 'Prise prête';
        // How long it took, as its record says it (the whole of it only, from 0.6.93).
        const took = takeTime(event.record);
        madeTime = took?.whole ? generationTime(took.ms) : '';
      } else {
        phase = 'failed';
        stageText = 'Échec · ' + (event.error || 'la génération a échoué.');
      }
    } else if (event.type === 'failed') {
      stopFlux();
      phase = 'failed';
      stageText = 'Échec · ' + (event.message || 'la génération a échoué.');
    } else if (event.type === 'stopped') {
      stopFlux();
      phase = 'stopped';
    } else return;
    if (phase === 'failed' || phase === 'stopped') timeText = madeTime = '';
    paint();
  }
  /** The work is over: its last state stays while the user is away (a turn without a take: answered). */
  function end() {
    if (!work) return;
    running = false;
    stopFlux();
    if (phase === 'answer') phase = 'answered';
    // Declined where it was shown (a card answered, a proposal refused): nothing is left to say.
    if (phase === 'waiting') phase = 'answered';
    paint();
  }
  /** Nothing to show any more: the user is back in the conversation, closed it, or it is gone. */
  function forget() {
    begin(null);
    place(null);
  }
  /**
   * Where it shows: `null` hidden, 'corner' at the bottom right of the page, or an element (the foot
   * of the Paramètres) where it goes as the pill. The Flux draws only while it is in sight. (0.6.200)
   * `pill`: as its pill whatever the user keeps (the page of the Bobine), until its chevron opens it there.
   * (0.6.478) `alone`: the list without the take (its Chat or its Studio on screen); `home`: the conversation of that
   * Chat or Studio; `dock`: where it lies in the Studio, under the settings; `raise`: its pill over the input of the
   * chat, so high from the foot of the page. It shows while it has a take to show, or a queue.
   */
  function place(where, { pill = false, alone: only = false, home: shownHome = null, dock = null, raise = 0 } = {}) {
    const local = pill ? 'pill' : dock && where === 'corner' ? 'dock' : '';
    if (local !== localMode) {
      localMode = local;
      openedHere = closedHere = false;
    }
    pillHere = pill;
    alone = Boolean(only);
    home = shownHome;
    docked = local === 'dock' ? dock : null;
    raised = where === 'corner' && raise > 0 ? raise : 0;
    footed = Boolean(where) && where !== 'corner';
    const visible = Boolean(where) && (Boolean(work && !alone) || parts.length > 0);
    shown = visible && Boolean(work) && !alone;
    root.hidden = !visible;
    flux?.visible(shown);
    if (!visible) return;
    const inFoot = where !== 'corner';
    root.classList.toggle('is-foot', inFoot);
    if (inFoot && root.parentNode !== where) {
      corner ??= root.parentNode;
      where.prepend?.(root);
    } else if (!inFoot && corner && root.parentNode !== corner) corner.append(root);
    paint();
  }
  /** Another name for the conversation (the model named it, the user renamed it). */
  function rename(text) {
    if (!work || !text || work.title === text) return;
    work.title = text;
    paint();
  }
  /**
   * (0.6.478) What waits in the queue of the Studio (studio.mjs, queueView): per conversation, { conversation, title,
   * groups: [{ word, state, rows }], why, card, stopped, note, held, foot }; [] when nothing waits. Drawn at the next
   * `place`, which says where.
   */
  function queue(given = []) {
    parts = Array.isArray(given) ? given : [];
  }
  return {
    element: root,
    begin,
    answer,
    waitFor,
    take,
    end,
    forget,
    place,
    rename,
    queue,
    /** The work it shows: { conversationId, title, kind, take }, or null. */
    get work() {
      return work;
    },
    get running() {
      return running;
    },
    /** Whether it is about a take (in progress, waiting for the user, or ended), not words alone. */
    get taking() {
      return phase !== 'answer' && phase !== 'answered';
    },
    get phase() {
      return phase;
    },
    /** Whether it shows as its pill (0.6.200: on the page that puts it so, whatever the user keeps). */
    get folded() {
      return foldedNow();
    },
  };
}
