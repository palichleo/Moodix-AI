/**
 * A request whose workflow lacks a file (etats-maquette.md, 53): a card on the model of the proposal
 * card, in the message. « IL MANQUE UN FICHIER · VIDÉO · WAN SCAIL 2 », each file with an amber point,
 * its name and its size; where it goes; « Annuler » and « Télécharger · 28,6 Go ». While it downloads:
 * a line, « 3,4 / 28,6 GO » and « Arrêter » (what was fetched stays: it goes on from there). Once the
 * file is there, `onReady()`: true when the page sent the request again (the conversation had not
 * moved); else the card says « Wan SCAIL 2 est prêt » and offers « Reprendre la demande » (`onResume`):
 * a message sent hours later on its own would come out of context.
 *
 * Under the files, their licences (model-licenses.mjs): each by its name, a link to its text and its
 * limits. One with conditions (LTX 2.5, MiniMax H3, Krea 2, SAM 3.1) is confirmed first: « Télécharger »
 * then shows those licences alone, « À LIRE AVANT DE TÉLÉCHARGER », with « Retour » and « J’ai lu,
 * télécharger »; a free one is only named, and the download starts at once.
 *
 * (0.6.479) On a new installation the engine of generation comes with the first model downloaded (engineText,
 * engineWait), in the size of its button; a model whose files are all here offers it alone: « IL MANQUE LE MOTEUR
 * DE GÉNÉRATION », its one line « Moteur de génération de Moodix » and its size.
 */
import { licenseBlock, restrictedOf } from './model-licenses.mjs';

const KINDS = { video: 'Vidéo', audio: 'Son', image: 'Image' };
// What the server says of a download whose file Windows holds a moment (lib/model-downloads.mjs).
const WAITING = /en attente que Windows libère/;

/** « 28,6 Go », « 578 Mo ». */
export function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1).replace('.', ',') + ' Go';
  return Math.max(1, Math.round(value / 1024 ** 2)).toLocaleString('fr-FR') + ' Mo';
}

/**
 * (0.6.225) What a download that is converted afterwards asks of the disk (the offer says `convert`, and `room`:
 * what is left to fetch plus the converted files written beside their sources before those leave): one
 * sentence, '' for a download that is not converted.
 */
export function roomText(offer) {
  if (!offer?.convert || !(offer.room > 0)) return '';
  return `Il faut ${sizeText(offer.room)} de place libre : après le téléchargement, les fichiers sont convertis pour le moteur de Moodix, puis les originaux sont effacés.`;
}

/** (0.6.479) An offer of the engine alone: the files of its model are all here, on a new installation. */
export const engineOnly = offer =>
  Array.isArray(offer?.files) && !offer.files.length && Number(offer?.engine?.bytes) > 0;
/**
 * (0.6.479) The engine of a new installation, which the same click prepares after the files (`offer.engine`, about
 * what it downloads): one sentence, '' when it is there already. `size`: how the page beside it writes a size.
 */
export function engineText(offer, size = sizeText) {
  const bytes = Number(offer?.engine?.bytes) || 0;
  if (!(bytes > 0)) return '';
  // Its files all here (Qwen-Image-Edit downloaded on a new installation, 27/11): the engine alone.
  if (engineOnly(offer))
    return (
      `Les fichiers sont là : il manque le moteur de génération de Moodix, environ ${size(bytes)}, ` +
      'installé une seule fois pour tous les modèles.'
    );
  return (
    `Le moteur de génération de Moodix se télécharge avec : environ ${size(bytes)}, ` +
    'une seule fois pour tous les modèles.'
  );
}
/** (0.6.479) What a click on « Télécharger » fetches in all: `bytes` of files, and the engine of a new installation. */
export const withEngine = (bytes, offer) => (Number(bytes) || 0) + (Number(offer?.engine?.bytes) || 0);
/**
 * (0.6.503) What a download offered lacks, as the head of its card says it: the engine of a new installation alone,
 * several files (« des fichiers », decision of 27/11), or one. The card of a proposal says it in its own head.
 */
export const lackingText = missing =>
  engineOnly(missing)
    ? 'Il manque le moteur de génération'
    : missing?.files?.length > 1
      ? 'Il manque des fichiers'
      : 'Il manque un fichier';
/** (0.6.479) What a download says while the engine is prepared after its files, '' before and after. */
export function engineWait(job) {
  if (job?.engine !== 'preparing') return '';
  return /^Démarrage/.test(job.current || '')
    ? 'Démarrage du moteur de génération…'
    : 'Préparation du moteur de génération : quelques minutes, une seule fois.';
}

/**
 * (0.6.493) A card taller than the conversation (LTX 2.5's six files and two licences at 1280 × 720): its head kept in
 * view, in a proposal card the head of that card, with the button of its model (relecture, m6). The page keeps the
 * conversation at its end as it grows (its ResizeObserver, public/app.js, made first, so answered first); here, in the
 * same frame, before it is painted, the conversation goes back up to that head. « Télécharger » comes after the
 * licences, read down.
 */
function keepHead(card) {
  const Watch = globalThis.ResizeObserver;
  if (typeof Watch !== 'function') return;
  const watch = new Watch(() => {
    watch.disconnect();
    const top = card.closest?.('.proposal-card') ?? card,
      area = top.closest?.('.chat-area');
    if (!area || !card.isConnected) return;
    // Under the mask of the top of the conversation (14 px, moodix.css), and a little room.
    const under = area.getBoundingClientRect().top + 22 - top.getBoundingClientRect().top;
    if (under > 0) area.scrollBy?.({ top: -under, behavior: 'instant' });
  });
  watch.observe(card);
}

export function missingFileCard({
  host,
  request,
  node,
  icon,
  api,
  onReady = () => false,
  onResume = () => {},
  poll = 1000,
  wait = null,
}) {
  const missing = request.missing,
    // (0.6.479) Its files all here, the engine of a new installation alone to fetch: « Il manque un fichier » then
    // said a file none of its lines named.
    alone = engineOnly(missing),
    card = node('section', 'missing-card'),
    pause = wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
    // The licences with conditions of these files: read and confirmed before the download.
    restricted = restrictedOf(missing.files);
  // (0.6.479) « des fichiers » when there are several (decision of 27/11), as the sentence of the chat says it
  // (app.js). (0.6.503) In the words the head of a proposal says too (lackingText).
  const plural = missing.files?.length > 1,
    lacking = lackingText(missing);
  card.setAttribute('aria-label', lacking);
  let state = 'idle',
    left = missing.left || missing.bytes,
    received = 0,
    // (0.6.479) With the engine of a new installation, which the server counts in the job too.
    total = withEngine(missing.bytes, missing),
    error = '',
    // Said while Windows holds the file just downloaded (0.6.90: the line stood full, without a word).
    waiting = '',
    following = false,
    starting = false,
    gone = false,
    // (0.6.479) Its source asks for an account whose token is not on this computer: « Télécharger » greyed, why in its
    // bubble (the server refused it at the click, decision of 27/11); back once a token is saved (moodix:token).
    tokenNeeded = missing.needsToken === true;
  // (0.6.479) What its source asks for, with where the token is made; the model named (« Ce fichier » stood under six
  // files), as the Bobine and « Modèles » name it.
  const account =
    `${request.workflowName || 'Ce modèle'} demande un compte Hugging Face : acceptez la licence` +
    `${missing.page ? ' sur ' + missing.page : ''} avec ce compte, ` +
    'créez un jeton de lecture sur huggingface.co/settings/tokens, ' +
    'puis enregistrez votre jeton dans Paramètres › Modèles › Fichiers.';

  function button(className, text, onclick, glyph) {
    const element = node('button', className);
    element.type = 'button';
    if (glyph) element.append(icon(glyph));
    element.append(node('span', '', text));
    element.onclick = onclick;
    return element;
  }
  function render() {
    if (gone) return;
    const head = node(
        'p',
        'missing-head',
        [lacking, KINDS[request.mediaType] ?? KINDS.image, request.workflowName].filter(Boolean).join(' · '),
      ),
      list = node('ul', 'missing-files');
    const files = alone ? [{ file: 'Moteur de génération de Moodix', size: missing.engine.bytes }] : missing.files;
    for (const file of files) {
      const item = node('li', 'missing-file');
      item.append(
        node('span', 'missing-dot'),
        node('span', 'missing-name', file.file),
        node('span', 'missing-size', file.size ? sizeText(file.size) : ''),
      );
      list.append(item);
    }
    const note = node(
      'p',
      'missing-note',
      // (0.6.479) Where the token is made, said with the rest, and the engine its button counts.
      tokenNeeded
        ? [account, engineText(missing)].filter(Boolean).join(' ')
        : alone
          ? engineText(missing)
          : [
              (plural ? 'Ils vont' : 'Il va') +
                ' dans votre dossier des modèles, depuis Hugging Face. ' +
                'Le téléchargement reprend où il en était si vous l’arrêtez.',
              roomText(missing),
              engineText(missing),
            ]
              .filter(Boolean)
              .join(' '),
    );
    const foot = node('div', 'missing-foot');
    if (state === 'running') {
      const progress = node('div', 'missing-progress'),
        line = node('span', 'missing-line'),
        fill = node('span', 'missing-fill');
      fill.style.width = (total ? Math.min(100, (received / total) * 100) : 0) + '%';
      line.append(fill);
      progress.append(line, node('span', 'missing-count', `${sizeText(received)} / ${sizeText(total)}`));
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuenow', String(total ? Math.round((received / total) * 100) : 0));
      foot.append(progress, button('text-button missing-stop', 'Arrêter', () => void stop()));
    } else if (state === 'done') {
      const there = alone ? 'Le moteur est prêt' : plural ? 'Les fichiers sont là' : 'Le fichier est là';
      foot.append(node('p', 'missing-done', `${there}. Je reprends votre demande…`));
    } else if (state === 'ready') {
      foot.append(
        node('p', 'missing-done', `${request.workflowName} est prêt`),
        button('missing-go', 'Reprendre la demande', () => onResume(), 'play'),
      );
    } else if (state === 'confirm') {
      const several = restricted.length > 1;
      foot.append(
        node(
          'p',
          'missing-ask',
          `Vous avez lu ${several ? 'ces licences' : 'cette licence'} et vous en acceptez les conditions ?`,
        ),
        button('text-button missing-back', 'Retour', () => back()),
        button(
          'missing-go',
          'J’ai lu, télécharger · ' + sizeText(withEngine(left, missing)),
          () => void confirm(),
          'download',
        ),
      );
    } else {
      const go = button(
        'missing-go',
        'Télécharger · ' + sizeText(withEngine(left, missing)),
        () => void start(),
        'download',
      );
      // (0.6.479) Greyed for want of its token, the sentence in its bubble (and above it, in the note).
      if (tokenNeeded) Object.assign(go, { disabled: true, title: account });
      foot.append(button('text-button missing-cancel', 'Annuler', () => cancel()), go);
    }
    const parts = [head, list, note],
      licenses = licenseBlock({ node, files: missing.files, confirm: state === 'confirm' });
    if (licenses) parts.push(licenses);
    if (error) {
      const alert = node('p', 'missing-error', error);
      alert.setAttribute('role', 'alert');
      parts.push(alert);
    }
    // Under its line, while Windows holds the file just downloaded (0.6.479: or while its engine is prepared).
    if (state === 'running' && waiting) {
      const said = node('p', 'missing-note missing-wait', waiting);
      said.setAttribute('role', 'status');
      card.replaceChildren(...parts, foot, said);
    } else card.replaceChildren(...parts, foot);
  }
  /** « Télécharger »: at once under free licences; one with conditions is shown alone and confirmed first. */
  async function start() {
    // (0.6.479) Not without its token: the server refuses it (its button is greyed meanwhile).
    if (tokenNeeded) return;
    if (!restricted.length) return download(false);
    error = '';
    state = 'confirm';
    render();
  }
  /** « J’ai lu, télécharger »: the download, with the word that the licences were read. */
  const confirm = () => download(true);
  function back() {
    state = 'idle';
    render();
  }
  async function download(accepted) {
    // (0.6.288) One start at a time: a second click before the answer is refused by the server (« déjà en
    // cours »), and its refusal put the card back to « Télécharger », an error over a download that goes on.
    if (starting) return;
    starting = true;
    error = '';
    try {
      const job = await (
        await api('downloads/start', { id: missing.workflowId, ...(accepted ? { accepted: true } : {}) })
      ).json();
      ({ received = 0, total = total } = job);
      state = 'running';
    } catch (failure) {
      state = 'idle';
      error = failure.message;
    } finally {
      starting = false;
    }
    render();
    if (state === 'running') await follow();
  }
  /** The download as it goes (GET /api/downloads), until the file is there, stopped or failed. */
  async function follow() {
    if (following) return;
    following = true;
    try {
      while (!gone && card.isConnected !== false) {
        const { job } = await (await api('downloads')).json();
        if (job.workflowId !== missing.workflowId && job.state === 'running') {
          state = 'idle';
          error = `Un autre téléchargement est en cours (${job.name}) : attendez sa fin.`;
          return;
        }
        if (job.state === 'done' && job.workflowId === missing.workflowId) {
          // Sent again by the page, or left to the user (the conversation moved meanwhile).
          state = onReady() ? 'done' : 'ready';
          render();
          return;
        }
        if (job.state === 'cancelled' || job.state === 'error' || job.state === 'idle') {
          state = 'idle';
          // (0.6.479) The job counts the engine of a new installation too: what is left of the files alone, none
          // once it stopped while the engine was prepared (its files are all there then).
          const engine = job.engine && job.engine !== 'ready' ? Number(missing.engine?.bytes) || 0 : 0;
          left =
            job.engine === 'preparing' ? 0 : Math.max(0, (job.total || total) - (job.received || 0) - engine) || left;
          if (job.state === 'error') error = job.error;
          return;
        }
        received = job.received;
        total = job.total || total;
        waiting = WAITING.test(job.current ?? '') ? job.current : engineWait(job);
        render();
        await pause(poll);
      }
    } catch (failure) {
      state = 'idle';
      error = failure.message;
    } finally {
      following = false;
      render();
    }
  }
  async function stop() {
    try {
      await api('downloads/cancel', {});
    } catch (failure) {
      error = failure.message;
    }
  }
  /** « Annuler »: the card goes, a line says it where it was. */
  function cancel() {
    gone = true;
    card.remove();
    host.append(node('p', 'proposal-cancelled', 'Proposition annulée.'));
  }
  /** (0.6.479) A token saved in Paramètres › Modèles › Fichiers (app.js, saveToken): « Télécharger » comes back. */
  function tokenSaved(event) {
    if (gone || card.isConnected === false)
      return globalThis.document?.removeEventListener?.('moodix:token', tokenSaved);
    if (!tokenNeeded || !event?.detail?.hasToken) return;
    tokenNeeded = false;
    render();
  }
  if (tokenNeeded) globalThis.document?.addEventListener?.('moodix:token', tokenSaved);
  render();
  host.append(card);
  keepHead(card);
  // A download of this file already under way (stopped and started again from the settings).
  void api('downloads')
    .then(response => response.json())
    .then(({ job, hasToken } = {}) => {
      // (0.6.479) Its token saved since the card was made (a conversation opened again later).
      if (hasToken && tokenNeeded) tokenSaved({ detail: { hasToken } });
      if (job?.state === 'running' && job.workflowId === missing.workflowId) {
        state = 'running';
        ({ received = 0, total = total } = job);
        waiting = WAITING.test(job.current ?? '') ? job.current : engineWait(job);
        render();
        return follow();
      }
    })
    .catch(() => {});
  return { card, start, confirm, back, stop, cancel };
}
