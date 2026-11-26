/**
 * (0.6.452) Paramètres › Moodix AI › Dictée (claude_design/maquettes-dictee, D12 and D13, approved on 26/11): its
 * model, downloaded or taken away at once (« Télécharger » with its licence, « Retirer » asked first); the microphone
 * of this browser and its trial (its level only: nothing is played back, nothing is kept); the language; where it runs
 * (« Carte graphique » greyed with its reason when no build of llama.cpp for a card is installed); the words to write
 * well. Those four are kept with the other settings at « Enregistrer », « Annuler » goes back to them.
 */
import { MIC_KEY, WORKLET, loudness } from './dictation.mjs';
import { sizeText } from './missing-file.mjs';

const LANGUAGES = [
  ['fr', 'Français'],
  ['en', 'Anglais'],
  ['auto', 'Automatique'],
];
const PLACES = [
  ['cpu', 'Processeur'],
  ['gpu', 'Carte graphique'],
];
// The card measured by the study, the processor alone by Moodix (26/11, 0.6.453: 2.1 s for a sentence of 8 to 10 s).
export const CARD_TIP =
  'Une phrase en 0,3 s au lieu de 2 s, mais 3,6 Go de la carte en moins pour le chat et les générations.';
const FIRST_INSTALL = 'Installez d’abord le modèle.';
const REMOVE_QUESTION = size =>
  `Retirer la dictée de cet ordinateur ? Son modèle (${size}) et sa version de llama.cpp sont effacés : il faudra les télécharger à nouveau pour dicter.`;
const licenseName = license => String(license?.name || 'Apache-2.0').replace(/^Apache-2\.0$/, 'Apache 2.0');
const licenseTip = license =>
  licenseName(license) === 'Apache 2.0'
    ? 'Licence Apache 2.0 : usage personnel et commercial permis.'
    : `Licence ${licenseName(license)}.`;

/** The lit segments of the level of the trial (ten), from its RMS, on the scale of the bars of the strip. */
export function meterSegments(level) {
  return Math.round(loudness(level) * 10);
}

/** What the line « Modèle » says: to download (its size), downloading (how far), installed. */
export function modelLine(status) {
  const model = status?.model ?? {},
    job = status?.job ?? {},
    name = model.name || 'Qwen3-ASR 1.7B';
  if (job.state === 'running') {
    const total = Number(job.total) || 0,
      received = Math.min(total, Number(job.received) || 0),
      share = total ? Math.floor((received / total) * 100) : 0;
    return `Téléchargement : ${share} % · ${sizeText(received)} sur ${sizeText(total)}`;
  }
  if (status?.installed) return `${name} · installé · ${sizeText(model.bytes)}`;
  // Its size unknown (the server not read): never « 1 Mo à télécharger ».
  const left = Number(model.left || model.bytes) || 0;
  return `${name}, d’Alibaba · ${left ? `${sizeText(left)} à télécharger · ` : ''}${licenseName(model.license)}`;
}

export function setupDictationSettings({
  $,
  node,
  api,
  dictation = null,
  confirmFn = text => globalThis.confirm(text),
  // Told when the draft of the settings is read again from the server (the guard of the settings takes it as kept).
  onLoaded = () => {},
  page = globalThis.window,
}) {
  let status = null,
    saved = null,
    current = null,
    savedMic = '',
    mic = '',
    following = false,
    acting = false,
    trial = null,
    said = '';
  const section = $('dictation-settings');
  if (!section) return { load: async () => {}, draft: () => null, dirty: () => false, save: async () => {}, revert() {}, close() {} };

  const readMic = () => {
    try {
      return page?.localStorage?.getItem(MIC_KEY) ?? '';
    } catch {
      return '';
    }
  };
  const keepMic = value => {
    try {
      if (value) page?.localStorage?.setItem(MIC_KEY, value);
      else page?.localStorage?.removeItem(MIC_KEY);
    } catch {
      // Storage refused (a private window): the microphone of the system, as before.
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /** A row of choices made once; `paint` says which is pressed, and which cannot be. */
  function segments(box, list, pick) {
    box.replaceChildren(
      ...list.map(([id, name]) => {
        const choice = node('button', 'settings-segment', name);
        choice.type = 'button';
        choice.dataset.value = id;
        choice.setAttribute('role', 'radio');
        choice.onclick = () => {
          if (choice.getAttribute('aria-disabled') === 'true') return;
          pick(id);
        };
        return choice;
      }),
    );
  }
  segments($('dictation-language'), LANGUAGES, language => change({ language }));
  segments($('dictation-place'), PLACES, place => change({ place }));
  $('dictation-words').oninput = () => {
    if (current) current.words = $('dictation-words').value;
  };
  $('dictation-mic').onchange = () => {
    mic = $('dictation-mic').value;
    if (trial) void startTrial();
  };
  $('dictation-get').onclick = () => void act();
  $('dictation-try').onclick = () => void (trial ? stopTrial() : startTrial());

  function change(patch) {
    if (!current) return;
    current = { ...current, ...patch };
    paint();
  }
  function say(text) {
    said = text || '';
    paint();
  }
  function paint() {
    const installed = Boolean(status?.installed),
      running = status?.job?.state === 'running',
      get = $('dictation-get'),
      tryIt = $('dictation-try');
    $('dictation-model').textContent = modelLine(status);
    get.textContent = running ? 'Annuler' : installed ? 'Retirer' : 'Télécharger';
    get.title = running || installed ? '' : licenseTip(status?.model?.license);
    get.disabled = acting || !status;
    tryIt.textContent = trial ? 'Arrêter' : 'Essayer';
    tryIt.disabled = !installed && !trial;
    tryIt.title = installed || trial ? '' : FIRST_INSTALL;
    for (const choice of $('dictation-language').children)
      choice.setAttribute('aria-checked', String(choice.dataset.value === (current?.language ?? 'fr')));
    const card = status?.card ?? { available: false, reason: '' };
    for (const choice of $('dictation-place').children) {
      choice.setAttribute('aria-checked', String(choice.dataset.value === (current?.place ?? 'cpu')));
      if (choice.dataset.value !== 'gpu') continue;
      // Greyed, not hidden: why it cannot run there, under the pointer.
      const off = !card.available && current?.place !== 'gpu';
      if (off) choice.setAttribute('aria-disabled', 'true');
      else choice.removeAttribute('aria-disabled');
      choice.title = card.available ? CARD_TIP : card.reason || CARD_TIP;
    }
    if (current && $('dictation-words').value !== current.words) $('dictation-words').value = current.words;
    // What the engine of the dictation says of itself (a card refused, a generation holds it), or what failed here.
    const engine = status?.engine ?? {},
      line = said || (status?.job?.state === 'error' ? status.job.error : '') || engine.error || engine.note || '';
    $('dictation-state').textContent = line;
    $('dictation-state').hidden = !line;
  }

  /** The microphones of this browser in the list (their names once one was allowed), the one chosen kept. */
  async function listMicrophones() {
    const select = $('dictation-mic'),
      system = /Windows/i.test(page?.navigator?.userAgent || '') ? 'Micro par défaut de Windows' : 'Micro par défaut du système';
    let found = [];
    try {
      found = (await page.navigator.mediaDevices.enumerateDevices()).filter(
        device => device.kind === 'audioinput' && device.deviceId && !['default', 'communications'].includes(device.deviceId),
      );
    } catch {
      // The browser lists none: the system's alone.
    }
    const options = [new Option(system, '')];
    found.forEach((device, index) => options.push(new Option(device.label || `Micro ${index + 1}`, device.deviceId)));
    // The one chosen before, gone (unplugged): still named, so that it stays chosen until another is.
    if (mic && !found.some(device => device.deviceId === mic)) options.push(new Option('Micro choisi (débranché)', mic));
    select.replaceChildren(...options);
    select.value = mic;
  }

  async function read() {
    status = await (await api('dictation')).json();
    return status;
  }
  /** Opened: what the server keeps, the microphone this browser keeps; a download under way is followed again. */
  async function load() {
    said = '';
    try {
      await read();
    } catch (error) {
      status = null;
      said = error.message;
      paint();
      return;
    }
    saved = { language: status.settings.language, place: status.settings.place, words: status.settings.words };
    current = { ...saved };
    savedMic = mic = readMic();
    paint();
    void listMicrophones();
    onLoaded();
    if (status.job?.state === 'running') void follow();
  }
  /** « Télécharger », « Annuler », « Retirer »: at once, not at « Enregistrer ». */
  async function act() {
    if (!status || acting) return;
    const running = status.job?.state === 'running';
    if (status.installed && !running && !confirmFn(REMOVE_QUESTION(sizeText(status.model?.bytes)))) return;
    acting = true;
    said = '';
    paint();
    try {
      const route = running ? 'dictation/cancel' : status.installed ? 'dictation/remove' : 'dictation/download';
      if (route === 'dictation/remove') stopTrial();
      status = await (await api(route, {})).json();
    } catch (error) {
      said = error.message;
    } finally {
      acting = false;
    }
    paint();
    void dictation?.refresh();
    if (status?.job?.state === 'running') void follow();
  }
  /** The download as it goes, while the settings are open: its line says how far it is. */
  async function follow() {
    if (following) return;
    following = true;
    try {
      while ($('settings')?.open !== false) {
        await new Promise(resolve => setTimeout(resolve, 700));
        await read();
        paint();
        if (status.job?.state !== 'running') break;
      }
    } catch (error) {
      say(error.message);
    } finally {
      following = false;
    }
    void dictation?.refresh();
  }

  /**
   * « Essayer »: the level of the microphone chosen, in the ten segments, as the dictation hears it (its worklet: an
   * AnalyserNode would be read back, and Brave, in its strict protection, gives noise back from one); nothing is
   * heard back, nothing is kept.
   */
  async function startTrial() {
    stopTrial();
    const mine = (trial = { stream: null, context: null, sound: null });
    paint();
    try {
      const stream = await page.navigator.mediaDevices.getUserMedia({
        audio: { ...(mic ? { deviceId: { exact: mic } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (trial !== mine) return stream.getTracks().forEach(track => track.stop());
      mine.stream = stream;
      const context = (mine.context = new (page.AudioContext || page.webkitAudioContext)());
      await context.audioWorklet.addModule(WORKLET);
      if (trial !== mine) return;
      const sound = (mine.sound = new page.AudioWorkletNode(context, 'moodix-dictation', {
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { levels: true },
        })),
        quiet = context.createGain(),
        segments = [...$('dictation-meter').children];
      // Pulled to the speakers to be heard by the browser, at no volume: nothing comes out of them.
      quiet.gain.value = 0;
      context.createMediaStreamSource(stream).connect(sound).connect(quiet).connect(context.destination);
      sound.port.onmessage = ({ data }) => {
        if (trial !== mine || !Number.isFinite(data?.level)) return;
        const lit = meterSegments(data.level);
        segments.forEach((segment, index) => segment.classList.toggle('is-on', index < lit));
      };
      if (context.state === 'suspended')
        await Promise.race([context.resume(), new Promise(resolve => page.setTimeout(resolve, 1500))]);
      if (trial !== mine) return;
      if (context.state !== 'running') throw new Error('le navigateur n’a pas laissé la page écouter');
      // Allowed now: the microphones have their names.
      void listMicrophones();
    } catch (error) {
      if (trial !== mine) return;
      stopTrial();
      say(
        error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          ? 'Le micro est bloqué pour cette page. Autorisez-le dans le navigateur (le cadenas à gauche de l’adresse), puis réessayez.'
          : error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError'
            ? 'Ce micro n’est pas branché.'
            : error?.name === 'NotReadableError'
              ? 'Le micro est pris par un autre programme. Fermez-le, puis réessayez.'
              : `Le micro n’a pas pu s’ouvrir (${error?.message || error}).`,
      );
    }
  }
  function stopTrial() {
    const mine = trial;
    if (!mine) return;
    trial = null;
    if (mine.sound) mine.sound.port.onmessage = null;
    for (const track of mine.stream?.getTracks?.() ?? []) track.stop();
    if (mine.context && mine.context.state !== 'closed') void mine.context.close().catch(() => {});
    for (const segment of $('dictation-meter').children) segment.classList.remove('is-on');
    paint();
  }

  return {
    load,
    /** What « Enregistrer » would keep (the guard of the settings compares it); null before it is read. */
    draft: () => (current ? { ...current, mic } : null),
    dirty: () => Boolean(current && saved && (!same(current, saved) || mic !== savedMic)),
    async save() {
      if (!current || !saved) return;
      if (mic !== savedMic) {
        keepMic(mic);
        savedMic = mic;
      }
      if (same(current, saved)) return;
      status = await (await api('dictation/settings', current)).json();
      saved = { language: status.settings.language, place: status.settings.place, words: status.settings.words };
      current = { ...saved };
      paint();
      void dictation?.refresh();
    },
    /** Closed without « Enregistrer »: as it was kept. */
    revert() {
      if (saved) current = { ...saved };
      mic = savedMic;
      $('dictation-mic').value = mic;
      paint();
    },
    /** The settings closed: the trial of the microphone stops. */
    close() {
      stopTrial();
    },
  };
}
