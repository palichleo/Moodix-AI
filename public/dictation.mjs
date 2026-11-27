/**
 * (0.6.452) The dictation (claude_design/maquettes-dictee, his answer of 26/11 « D'accord pour tout »): a microphone
 * in the bar of the chat, at the left of the arrow; in the corner of the Studio's prompt, at the left of the wand,
 * which it never replaces (his words, the same day: « dictée ne remplace pas la baguette magique »), alone there only
 * in Son, which has no wand; in the field of the Arrangeur of the Bobine. A click listens, another ends, Échap
 * cancels, Ctrl+M is the click of the place where one writes. The words arrive in the box at its cursor, to be read
 * before they are sent: nothing leaves by itself, and nothing is sent while the dictation listens or writes.
 * The sound is taken here as it is heard (public/dictation-worklet.mjs), at 16 kHz where the browser brings the
 * microphone to it (Chromium), else at its own rate and brought there at the end; mono, 16 bits, it is posted to the
 * server (lib/dictation.mjs), which hands it to Qwen3-ASR on this computer and keeps none of it.
 */
export const LISTEN_PLACEHOLDER = 'Parlez : le texte arrivera ici.';
export const SHORTCUT = 'Ctrl+M';
/** The microphone chosen in Paramètres › Moodix AI › Dictée (its deviceId), kept by this browser. */
export const MIC_KEY = 'moodix.dictation.mic';
// As lib/dictation.mjs says it (tests/dictation.mjs checks they are the same).
export const UNAVAILABLE =
  'Dictée indisponible : son modèle n’est pas installé. Installez-le dans Paramètres › Moodix AI › Dictée.';
export const BLOCKED =
  'Le micro est bloqué pour cette page. Autorisez-le dans le navigateur (le cadenas à gauche de l’adresse), puis réessayez.';
export const NO_MIC = 'Aucun micro trouvé sur cet ordinateur.';
/** What « Envoyer », « Générer » and the arrow of the Bobine say while the dictation listens or writes. */
export const DICTATING = 'La dictée n’a pas encore écrit son texte.';
const UNSUPPORTED = 'Ce navigateur ne donne pas le micro à cette page.';
const TAKEN = 'Le micro est pris par un autre programme. Fermez-le, puis réessayez.';
const ELSEWHERE = 'Une dictée est déjà en cours.';
const SILENT = 'Le micro n’a rien entendu. Vérifiez qu’il n’est pas coupé (Paramètres › Moodix AI › Dictée › Essayer).';
const NOTHING = 'La dictée n’a reconnu aucun mot.';
const CLOSED = 'La case de la dictée n’est plus ouverte. Ce qui a été dit : « ';
const FULL = 'La case est pleine : la fin de la dictée n’y tient pas.';
// (0.6.455) A box closed for a moment (the chat while its history is read, the Studio while Moodix AI sets it).
const SHUT = 'Cette case est fermée pour le moment : la dictée ne peut pas y écrire.';
const ENDED = 'Le micro s’est arrêté : ce qui a été dit jusque-là est écrit.';
const RATE = 16000;
// Shorter than this, nothing was said (a click and its second click): nothing is asked.
const SHORTEST = 0.3;
// Quieter than this all along (RMS), the microphone is cut: nothing is asked, and it is said.
const QUIET = 0.002;
/** What hears the microphone, for the dictation and for « Essayer » (public/dictation-settings.mjs). */
export const WORKLET = '/dictation-worklet.mjs';

/**
 * Its three places: the box it writes in, the element its strip goes in (the strip shows the time and the level
 * while it listens, then « Transcription… »), the words of its button, and the strip of the maquette there (D2, D9,
 * D11): its bars, the highest of them, and « Échap annule » in the chat only (the room lacks elsewhere).
 */
const PLACES = {
  chat: {
    field: '#prompt',
    host: field => field.closest?.('#chat-form')?.querySelector?.('.composer-options') ?? null,
    tip: 'Dicter',
    bars: 34,
    high: 20,
    hint: true,
  },
  studio: {
    field: '#studio-prompt',
    host: field => field.closest?.('.studio-prompt-field') ?? null,
    tip: 'Dicter le prompt',
    bars: 16,
    high: 16,
  },
  bobine: {
    field: '.bobine-ask-field .bobine-ask-words',
    host: field => field.closest?.('.bobine-ask-field') ?? null,
    tip: 'Dicter la demande',
    bars: 22,
    high: 16,
  },
};
// Ctrl+M out of a box: the place on screen, the Studio and the Bobine before the chat they open over.
const ORDER = ['studio', 'bobine', 'chat'];

/**
 * The words said, put in the text at its cursor (`start` to `end`, what is selected replaced): a space between them
 * and the words before, and after, unless a punctuation follows. Null when nothing was said.
 */
export function insertion(value, start, end, words) {
  let piece = String(words ?? '').trim();
  if (!piece) return null;
  const text = String(value ?? ''),
    from = Math.max(0, Math.min(text.length, Number.isFinite(start) ? start : text.length)),
    to = Math.max(from, Math.min(text.length, Number.isFinite(end) ? end : from)),
    before = text.slice(0, from),
    after = text.slice(to);
  if (before && !/\s$/.test(before)) piece = ' ' + piece;
  if (after && !/^[\s,.;:!?…)\]]/.test(after)) piece += ' ';
  return { piece, from, to };
}

/**
 * How loud a level heard is (RMS of 40 ms), for the bars of the strip and the segments of « Essayer »: 0 at −55 dB
 * (silence) to 1 at 0 dB, the loud levels drawn apart (power 1.5). Measured on 26/11 in Chromium, its gain control
 * on: a voice speaks at −17 dB in the median, at −8 dB in its loudest tenth, its peaks near −4 dB. The scale stopped
 * at −15 dB first: the bars stood all at their top while one spoke, a block where the voice should be seen.
 */
export function loudness(level) {
  const loud = 20 * Math.log10(Math.max(Number(level) || 0, 1e-6));
  return Math.min(1, Math.max(0, (loud + 55) / 55)) ** 1.5;
}

/** The height of a bar, from the level heard: silence at 3 px, a voice that shouts at `high`. */
export function barHeight(level, high) {
  return Math.round(3 + loudness(level) * (high - 3));
}

/** The time of the strip: 0:06, 1:59. */
export const clock = seconds => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** The sound posted to the server, as lib/dictation.mjs reads it: WAV, PCM 16 bits, mono, 16 kHz. */
export function wavOf(samples, rate = RATE) {
  const bytes = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(bytes),
    word = (at, text) => {
      for (let index = 0; index < text.length; index++) view.setUint8(at + index, text.charCodeAt(index));
    };
  word(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  word(8, 'WAVE');
  word(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  word(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** The pieces heard, end to end. */
function joined(chunks, total) {
  const all = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk.subarray(0, Math.min(chunk.length, total - at)), at);
    at += chunk.length;
    if (at >= total) break;
  }
  return all;
}

/**
 * The sound brought to 16 kHz by the browser itself (its filter keeps what is above from folding back), for a browser
 * that does not bring the microphone to a context at 16 kHz (Firefox): Chromium hears it at 16 kHz from the start, and
 * nothing is read back from an AudioBuffer there (Brave, in its strict protection, gives noise back from one).
 */
async function resampled(samples, rate, Offline) {
  if (rate === RATE) return samples;
  const length = Math.max(1, Math.round((samples.length * RATE) / rate)),
    offline = new Offline(1, length, RATE),
    buffer = offline.createBuffer(1, samples.length, rate),
    source = offline.createBufferSource();
  buffer.copyToChannel(samples, 0);
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  return (await offline.startRendering()).getChannelData(0);
}

/** What the browser said when the microphone did not open, in the user's words. */
function refusal(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return BLOCKED;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return NO_MIC;
  if (name === 'NotReadableError' || name === 'AbortError') return TAKEN;
  return `Le micro n’a pas pu s’ouvrir (${error?.message || error}).`;
}

export function setupDictation({ api, icon, notice = () => {}, page = globalThis.window }) {
  const document = page?.document;
  let status = null,
    loading = null,
    // The microphones the browser lists (enumerateDevices), null while unknown.
    microphones = null,
    // The dictation under way: { where, phase: 'starting' | 'listening' | 'writing', … }, or null.
    session = null;
  // The button of each place (the last drawn), and who follows the dictation (to grey what would send).
  const mics = new Map(),
    watchers = new Set();
  const supported = () =>
    Boolean(
      page?.isSecureContext &&
        page.navigator?.mediaDevices?.getUserMedia &&
        page.AudioWorkletNode &&
        page.OfflineAudioContext &&
        (page.AudioContext || page.webkitAudioContext),
    );
  const fieldOf = where => document?.querySelector?.(PLACES[where].field) ?? null;
  const element = (tag, className = '', text = '') => {
    const made = document.createElement(tag);
    if (className) made.className = className;
    if (text) made.textContent = text;
    return made;
  };
  const longest = () => Number(status?.maxSeconds) || 120;
  /** A context of Web Audio at `rate` (16 kHz: what is posted), or at the browser's own rate (none, or one refused). */
  function contextAt(rate) {
    const Made = page.AudioContext || page.webkitAudioContext;
    if (rate) {
      try {
        return new Made({ sampleRate: rate });
      } catch {
        // This rate refused here: the browser's own.
      }
    }
    return new Made();
  }

  /** What the server says of the dictation (installed, its engine, its settings). */
  function refresh() {
    loading ??= (async () => {
      try {
        status = await (await api('dictation')).json();
      } catch {
        // Unknown for now: the button stays as it is, a click asks again.
      } finally {
        loading = null;
      }
      paintAll();
      return status;
    })();
    return loading;
  }
  /** (Planned in the maquette) A computer without a microphone: its buttons greyed, and why. */
  async function countMicrophones() {
    try {
      const devices = await page.navigator.mediaDevices.enumerateDevices();
      microphones = devices.filter(device => device.kind === 'audioinput');
    } catch {
      microphones = null;
    }
    paintAll();
  }

  /** Why the button of a place is greyed now, in the user's words; '' when it listens at a click. */
  function why(record) {
    if (!supported()) return UNSUPPORTED;
    if (status && !status.installed) return UNAVAILABLE;
    if (microphones && !microphones.length && !session) return NO_MIC;
    if (session && session.where !== record.where) return ELSEWHERE;
    if (session) return '';
    return record.held?.() || '';
  }
  function paint(record) {
    const { button, where } = record,
      place = PLACES[where],
      mine = session?.where === where ? session : null,
      reason = mine ? '' : why(record),
      writing = mine?.phase === 'writing',
      words = writing ? 'Transcription…' : mine ? 'Terminer la dictée' : place.tip;
    button.classList.toggle('is-listening', Boolean(mine) && !writing);
    button.classList.toggle('is-busy', writing);
    if (reason) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
    button.setAttribute('aria-label', words);
    button.setAttribute('aria-pressed', String(Boolean(mine) && !writing));
    const tip = reason || (writing ? words : `${words} (${SHORTCUT})`);
    // Its bubble (public/help-tips.mjs takes the title, and shows a new one at once).
    if (button.dataset.tip !== tip) button.title = tip;
  }
  function paintAll() {
    for (const record of mics.values()) paint(record);
  }
  function changed() {
    paintAll();
    for (const watcher of watchers) {
      try {
        watcher();
      } catch {
        // One that fails does not keep the others from following.
      }
    }
  }

  /**
   * The button of a place: made (`mic`), or one of the page (`adopt`, the chat's). `held()` says why it is greyed
   * for a reason of its place (its box closed for a moment), '' otherwise. A place drawn again during a dictation
   * gets its strip back (`place`). (0.6.455) `scope()` says whose text its box holds (the conversation, the mode of
   * the Studio): another one there when the words come, they are not written in it.
   */
  function adopt(button, where, { held = null, scope = null } = {}) {
    const record = { button, where, held, scope };
    mics.set(where, record);
    button.setAttribute('aria-keyshortcuts', 'Control+M');
    button.onclick = event => {
      event?.preventDefault?.();
      void toggle(where);
    };
    paint(record);
    if (session?.where === where) queueMicrotask(place);
    if (!status && !loading) void refresh();
    return button;
  }
  function mic(where, options = {}) {
    const button = element('button', `dictation-mic in-${where}`);
    button.type = 'button';
    button.append(icon('mic'));
    return adopt(button, where, options);
  }

  /** A click on the button of a place, or Ctrl+M there. */
  async function toggle(where) {
    if (session) {
      if (session.where !== where) return notice(ELSEWHERE);
      if (session.phase === 'listening') return finish();
      if (session.phase === 'starting') return cancel();
      // Writing: its words are on their way.
      return;
    }
    // Read again when unknown or not installed: it may have been installed since (Paramètres, another tab).
    if (!status?.installed) await refresh();
    if (session) return;
    const record = mics.get(where) ?? { where },
      reason = why(record);
    // Greyed for no microphone, it still asks the browser: its list can be empty when it is not (a browser that
    // hides it before it is allowed). Not found then, it says so (refusal).
    if (reason && reason !== NO_MIC) return notice(reason);
    return start(where);
  }

  function constraints() {
    let chosen = '';
    try {
      chosen = page.localStorage?.getItem(MIC_KEY) ?? '';
    } catch {
      // Storage refused (a private window): the microphone of the system.
    }
    return {
      ...(chosen ? { deviceId: { ideal: chosen } } : {}),
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
  }
  async function start(where) {
    const field = fieldOf(where);
    // (0.6.455) Said: a click there did nothing, without a word.
    if (!field || field.disabled || field.readOnly || field.closest?.('[inert]')) return notice(SHUT);
    let context;
    try {
      // Made at the click itself: its sound is allowed by it. At 16 kHz: what the worklet hears is what is posted.
      context = contextAt(RATE);
    } catch (error) {
      return notice(refusal(error));
    }
    const mine = (session = {
      where,
      phase: 'starting',
      field,
      host: null,
      context,
      stream: null,
      sound: null,
      chunks: [],
      samples: 0,
      rate: context.sampleRate,
      levels: [],
      loudest: 0,
      strip: null,
      bars: null,
      time: null,
      controller: null,
      timer: null,
      flushed: null,
      // Where the words go: the cursor of the box at the click (its end if the box changes meanwhile).
      saved: {
        value: field.value,
        start: field.selectionStart ?? field.value.length,
        end: field.selectionEnd ?? field.value.length,
      },
      // Whose text the box holds at the click (adopt).
      scope: mics.get(where)?.scope?.() ?? null,
    });
    changed();
    // The engine of the dictation starts while one speaks (lib/dictation.mjs, warm).
    void api('dictation/warm', {}).catch(() => {});
    let stream;
    try {
      stream = await page.navigator.mediaDevices.getUserMedia({ audio: constraints() });
    } catch (error) {
      if (session !== mine) return;
      stopSound(mine);
      end(mine);
      return notice(refusal(error));
    }
    if (session !== mine) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    mine.stream = stream;
    // (0.6.455) A microphone that stops while it listens (unplugged): what was said until then is written. The strip
    // stood there before, its time stopped, until a click.
    for (const track of stream.getAudioTracks?.() ?? [])
      track.addEventListener?.('ended', () => {
        if (session !== mine || mine.phase !== 'listening') return;
        notice(ENDED);
        void finish();
      });
    try {
      let source;
      try {
        source = context.createMediaStreamSource(stream);
      } catch (error) {
        // A browser that does not bring the microphone to a context at another rate than its own (Firefox): at its
        // own rate, the sound brought to 16 kHz at the end (resampled).
        if (error?.name !== 'NotSupportedError' || context.sampleRate !== RATE) throw error;
        void context.close().catch(() => {});
        context = mine.context = contextAt(0);
        mine.rate = context.sampleRate;
        source = context.createMediaStreamSource(stream);
      }
      await context.audioWorklet.addModule(WORKLET);
      if (session !== mine) return;
      const sound = new page.AudioWorkletNode(context, 'moodix-dictation', { numberOfOutputs: 1, outputChannelCount: [1] }),
        quiet = context.createGain();
      // Pulled to the speakers to be heard by the browser, at no volume: nothing comes out of them.
      quiet.gain.value = 0;
      source.connect(sound).connect(quiet).connect(context.destination);
      sound.port.onmessage = ({ data }) => heard(mine, data);
      mine.sound = sound;
      // Held by the browser (no click of the user before it): asked once, never waited for without end.
      if (context.state === 'suspended')
        await Promise.race([context.resume(), new Promise(resolve => page.setTimeout(resolve, 1500))]);
      if (context.state !== 'running') throw new Error('le navigateur n’a pas laissé la page écouter');
    } catch (error) {
      if (session !== mine) return;
      stopSound(mine);
      end(mine);
      return notice(`Le micro n’a pas pu s’ouvrir (${error?.message || error}).`);
    }
    if (session !== mine) return;
    mine.phase = 'listening';
    mine.strip = listening(where, mine);
    place();
    mine.timer = page.setInterval(() => follow(mine), 300);
    changed();
    // One is open: the list is true now (a button greyed for none is lit again).
    if (microphones && !microphones.length) void countMicrophones();
  }
  function heard(mine, data) {
    if (session !== mine || !data) return;
    if (data.done) return mine.flushed?.();
    if (!data.samples?.length) return;
    mine.chunks.push(data.samples);
    mine.samples += data.samples.length;
    mine.loudest = Math.max(mine.loudest, Number(data.level) || 0);
    mine.levels.push(Number(data.level) || 0);
    if (mine.levels.length > 64) mine.levels.splice(0, mine.levels.length - 64);
    if (mine.phase !== 'listening') return;
    drawLevels(mine);
    // Two minutes at most (choice 12): it ends by itself there, and writes what was said.
    if (mine.samples / mine.rate >= longest()) void finish();
  }

  /** Ends the listening: what was said is written in the box. */
  async function finish() {
    const mine = session;
    if (!mine || mine.phase !== 'listening') return;
    mine.phase = 'writing';
    mine.strip?.remove();
    mine.strip = writing(mine.where);
    place();
    changed();
    // What the worklet still holds, then the microphone is let go.
    await new Promise(resolve => {
      mine.flushed = resolve;
      try {
        mine.sound.port.postMessage('flush');
      } catch {
        resolve();
      }
      page.setTimeout(resolve, 400);
    });
    stopSound(mine);
    if (session !== mine) return;
    const seconds = mine.samples / mine.rate;
    if (seconds < SHORTEST) return end(mine);
    if (mine.loudest < QUIET) {
      end(mine);
      return notice(SILENT);
    }
    let words = '';
    try {
      const sound = await resampled(joined(mine.chunks, mine.samples), mine.rate, page.OfflineAudioContext);
      mine.chunks = [];
      if (session !== mine) return;
      mine.controller = new AbortController();
      const response = await api('dictation/transcribe', wavOf(sound), {
        raw: true,
        headers: { 'Content-Type': 'audio/wav' },
        signal: mine.controller.signal,
      });
      words = String((await response.json())?.text ?? '').trim();
    } catch (error) {
      if (session !== mine) return;
      end(mine);
      if (error?.name !== 'AbortError') notice(error?.message || String(error));
      return;
    }
    if (session !== mine) return;
    end(mine);
    if (!words) return notice(NOTHING);
    write(mine, words);
  }
  /** Échap: nothing is written, the microphone is let go, the transcription asked is let go too. */
  function cancel() {
    const mine = session;
    if (!mine) return;
    mine.controller?.abort();
    stopSound(mine);
    end(mine);
  }
  function stopSound(mine) {
    for (const track of mine.stream?.getTracks?.() ?? []) track.stop();
    mine.stream = null;
    try {
      if (mine.sound) mine.sound.port.onmessage = null;
      mine.sound?.disconnect?.();
    } catch {
      // Already let go.
    }
    mine.sound = null;
    if (mine.context && mine.context.state !== 'closed') void mine.context.close().catch(() => {});
    mine.context = null;
  }
  function end(mine) {
    if (session !== mine) return;
    session = null;
    if (mine.timer) page.clearInterval(mine.timer);
    mine.timer = null;
    unplace(mine);
    changed();
  }

  /** The words in the box, at its cursor; typed as by the keys when it can have the focus (Ctrl+Z takes them away). */
  function write(mine, words) {
    const field = fieldOf(mine.where) ?? (mine.field?.isConnected ? mine.field : null),
      scope = mics.get(mine.where)?.scope;
    // (0.6.455) Nor in the text of another conversation or of another mode, shown since in the same box: they went at
    // its end (« Vidéo » clicked during « Transcription… »). Said instead, as when the box has gone.
    if (!field || field.disabled || field.readOnly || (scope && scope() !== mine.scope))
      return notice(CLOSED + words + ' »');
    const { value, start, end: stop } = mine.saved,
      at = field.value === value ? [start, stop] : [field.value.length, field.value.length],
      made = insertion(field.value, at[0], at[1], words);
    if (!made) return;
    let { piece } = made;
    const room = field.maxLength > 0 ? field.maxLength - (field.value.length - (made.to - made.from)) : Infinity;
    if (piece.length > room) {
      piece = piece.slice(0, Math.max(0, room));
      notice(FULL);
    }
    if (!piece) return;
    // (0.6.455) Typed as by the keys only where the focus still is (the box, a microphone, nothing): taken back from
    // another box clicked during « Transcription… », the next keys went into this one.
    const active = document.activeElement,
      free =
        !active ||
        active === document.body ||
        active === field ||
        Boolean(active.classList?.contains?.('dictation-mic'));
    if (free) {
      field.focus?.({ preventScroll: true });
      field.setSelectionRange?.(made.from, made.to);
    }
    const typed = free && document.activeElement === field && document.execCommand?.('insertText', false, piece);
    if (!typed) {
      field.setRangeText(piece, made.from, made.to, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ------------------------------------------------------------------ the strip
  function listening(where, mine) {
    const { bars, hint } = PLACES[where],
      strip = element('span', `dictation-strip in-${where}`),
      dot = element('span', 'dictation-dot'),
      time = element('span', 'dictation-time', '0:00'),
      levels = element('span', 'dictation-bars');
    strip.setAttribute('role', 'status');
    for (const part of [dot, time, levels]) part.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < bars; index++) levels.append(element('i', index >= bars - 4 ? 'is-now' : ''));
    strip.append(element('span', 'sr-only', 'Dictée : écoute en cours'), dot, time, levels);
    if (hint) {
      const help = element('span', 'dictation-hint');
      help.append(element('kbd', '', 'Échap'), ' annule');
      strip.append(help);
    }
    mine.bars = [...levels.children];
    mine.time = time;
    drawLevels(mine);
    return strip;
  }
  function writing(where) {
    const strip = element('span', `dictation-strip is-writing in-${where}`),
      ring = element('span', 'dictation-ring');
    strip.setAttribute('role', 'status');
    ring.setAttribute('aria-hidden', 'true');
    strip.append(ring, element('span', '', 'Transcription…'));
    return strip;
  }
  function drawLevels(mine) {
    const { high } = PLACES[mine.where],
      bars = mine.bars ?? [],
      levels = mine.levels;
    for (let index = 0; index < bars.length; index++)
      bars[index].style.height = `${barHeight(levels[levels.length - bars.length + index] ?? 0, high)}px`;
    if (mine.time) mine.time.textContent = clock(mine.samples / mine.rate);
  }
  /** The strip where the dictation is: the bar of the chat (in the place of its choices), the corner of the
   * prompt of the Studio, the field of the Bobine (in the place of its words). Drawn again, it is put back. */
  function place() {
    const mine = session;
    if (!mine?.strip) return;
    const field = fieldOf(mine.where),
      host = field ? PLACES[mine.where].host(field) : null;
    if (!host) return;
    if (field.placeholder !== LISTEN_PLACEHOLDER) {
      field.dataset.dictationPlaceholder = field.placeholder;
      field.placeholder = LISTEN_PLACEHOLDER;
    }
    host.classList.add('is-dictating');
    if (mine.where === 'bobine') {
      const button = host.querySelector('.dictation-mic');
      if (mine.strip.parentNode !== host || mine.strip.nextSibling !== button) host.insertBefore(mine.strip, button);
    } else if (mine.strip.parentNode !== host) host.append(mine.strip);
    if (mine.host && mine.host !== host) mine.host.classList.remove('is-dictating');
    Object.assign(mine, { host, field });
  }
  function unplace(mine) {
    mine.strip?.remove();
    mine.host?.classList.remove('is-dictating');
    for (const box of new Set([fieldOf(mine.where), mine.field].filter(Boolean))) {
      if (box.placeholder === LISTEN_PLACEHOLDER && box.dataset.dictationPlaceholder !== undefined)
        box.placeholder = box.dataset.dictationPlaceholder;
      delete box.dataset.dictationPlaceholder;
    }
  }
  /**
   * Every 300 ms: the strip back where it goes if its place was drawn again; its place gone from the screen
   * (another page opened), the listening ends there, and what was said is written in that place's box.
   */
  function follow(mine) {
    if (session !== mine) return;
    if (!mine.strip?.isConnected || mine.strip.parentNode !== mine.host) place();
    if (mine.phase === 'listening' && !(mine.strip?.isConnected && mine.strip.getClientRects().length)) void finish();
  }

  // ------------------------------------------------------------------ the keys
  /** The place Ctrl+M dictates in: the box that has the focus, else the one on screen (not under a dialog). */
  function placeOfKeys(target) {
    // (0.6.455) The chat open over the Studio, which is only blurred behind it: the chat first. The prompt of the
    // Studio took the words.
    const order =
      document?.body?.dataset?.chat === 'open' ? ['chat', ...ORDER.filter(where => where !== 'chat')] : ORDER;
    for (const where of order) if (target && fieldOf(where) === target) return where;
    const open = document?.querySelector?.('dialog[open]');
    for (const where of order) {
      const field = fieldOf(where);
      // (0.6.455) Nor a box made inert (the Studio while Moodix AI sets it).
      if (!field || field.disabled || field.closest?.('[inert]') || !field.getClientRects?.().length) continue;
      if (open && !open.contains(field)) continue;
      return where;
    }
    return null;
  }
  /**
   * (0.6.455) Whether Échap is the dictation's: its strip on screen (or its microphone being opened), no dialog over
   * it. Its place gone during « Transcription… », Échap took the words away, and the menu it was pressed for stayed.
   */
  function escapable(mine) {
    const open = document?.querySelector?.('dialog[open]');
    if (open && !open.contains(mine.strip ?? mine.field)) return false;
    return mine.phase === 'starting' || Boolean(mine.strip?.isConnected && mine.strip.getClientRects?.().length);
  }
  page?.addEventListener?.(
    'keydown',
    event => {
      if (session && event.key === 'Escape' && !event.isComposing && escapable(session)) {
        event.preventDefault();
        event.stopPropagation();
        return cancel();
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
      if (String(event.key).toLowerCase() !== 'm') return;
      const where = session?.where ?? placeOfKeys(event.target);
      if (!where) return;
      event.preventDefault();
      event.stopPropagation();
      void toggle(where);
    },
    true,
  );
  page?.navigator?.mediaDevices?.addEventListener?.('devicechange', () => void countMicrophones());
  if (supported()) void countMicrophones();

  return {
    refresh,
    mic,
    adopt,
    toggle,
    finish,
    cancel,
    repaint: paintAll,
    /** Whether a dictation listens or writes (in `where`, or anywhere). */
    busy: where => Boolean(session && (!where || session.where === where)),
    /** Follows the dictation: called when it begins, writes, ends. */
    watch: watcher => {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    status: () => status,
  };
}
