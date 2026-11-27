/**
 * (0.6.466) The queue of the Studio: what « Générer ensuite » froze while a take was being made, made one after the
 * other once it is (studio.mjs, generate). One creation at a time, as the server makes them. The queue is the page's:
 * kept in its tab (sessionStorage, `moodix.file`) with the identity of that tab (app.js, TAB), it is found again only
 * when that same tab is reloaded, never by a tab duplicated from it (which has an identity of its own). Nothing goes
 * again by itself after a reload: what waited comes back paused (« EN PAUSE »), and waits for « Reprendre ».
 *
 * An entry: { id, state, reason, tries, at, conversation, project, ...what the Studio keeps of it (its mode, its
 * request, its draft, its label) }. `state`: 'waiting' (it goes in its turn), 'paused' (it waits for « Reprendre »,
 * `reason` saying why: 'stopped', 'card', 'reload'), 'running' (being made, at its try `at` of `tries`), 'failed'
 * (it could not be made, `reason` saying why, as the server said it). No DOM here.
 */
export const QUEUE_MOST = 20;
export const QUEUE_KEY = 'moodix.file';

const WAITS = new Set(['waiting', 'paused']);

export function createQueue({ storage = null, tab = '' } = {}) {
  let entries = [],
    made = 0;
  const newId = () => globalThis.crypto?.randomUUID?.() ?? `q${Date.now().toString(36)}${(made += 1)}`;
  const find = id => entries.find(entry => entry.id === id) ?? null;
  const of = (conversation, states) =>
    entries.filter(
      entry => states.has(entry.state) && (conversation === undefined || entry.conversation === conversation),
    );
  const triesOf = fields => Math.max(1, fields.tries || 1);
  /** Kept in the tab at each change; nothing kept once the queue is empty. A storage that refuses keeps nothing. */
  function save() {
    if (!storage || !tab) return;
    try {
      if (entries.length) storage.setItem(QUEUE_KEY, JSON.stringify({ tab, entries }));
      else storage.removeItem(QUEUE_KEY);
    } catch {
      // Full or refused: the queue goes on in the page, and is lost with a reload.
    }
  }
  /**
   * What this very tab kept before it was reloaded: paused, all of it. The take being made then is followed again
   * by the page (take-recovery.mjs): of its tries, those it had not begun wait (B1: they were lost without a word),
   * `later` (its first try made: the next one draws a seed of its own, as in a series).
   */
  function restore() {
    if (!storage || !tab) return;
    let kept = null;
    try {
      kept = JSON.parse(storage.getItem(QUEUE_KEY) || 'null');
    } catch {
      kept = null;
    }
    if (!kept || kept.tab !== tab || !Array.isArray(kept.entries)) return;
    for (const entry of kept.entries) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
      const tries = Math.max(1, Number(entry.tries) || 1);
      if (entry.state === 'failed') entries.push({ ...entry, tries });
      else if (entry.state === 'running') {
        const left = tries - Math.max(1, Number(entry.at) || 1);
        if (left > 0) entries.push({ ...entry, state: 'paused', reason: 'reload', tries: left, at: 0, later: true });
      } else if (WAITS.has(entry.state)) entries.push({ ...entry, state: 'paused', reason: 'reload', tries, at: 0 });
    }
    save();
  }
  restore();
  return {
    /** Every entry, in the order they were asked. */
    entries: () => [...entries],
    get: find,
    /** How many wait (`waiting` and `paused`), of a conversation or of all. */
    waits: conversation => of(conversation, WAITS).length,
    waiting: conversation => of(conversation, new Set(['waiting'])),
    paused: conversation => of(conversation, new Set(['paused'])),
    failed: conversation => of(conversation, new Set(['failed'])),
    running: () => entries.find(entry => entry.state === 'running') ?? null,
    full: () => of(undefined, WAITS).length >= QUEUE_MOST,
    /** A request to make in its turn (« Générer ensuite »): null when QUEUE_MOST wait already. */
    add(fields) {
      if (of(undefined, WAITS).length >= QUEUE_MOST) return null;
      const entry = { ...fields, id: newId(), state: 'waiting', reason: '', tries: triesOf(fields), at: 0 };
      entries.push(entry);
      save();
      return entry;
    },
    /** A take asked now (« Générer »): being made at once, its first try. Never refused. */
    begin(fields) {
      const entry = { ...fields, id: newId(), state: 'running', reason: '', tries: triesOf(fields), at: 1 };
      entries.push(entry);
      save();
      return entry;
    },
    /** The first one to go: the oldest that waits and is not paused. */
    next: () => entries.find(entry => entry.state === 'waiting') ?? null,
    /** It goes: being made, its first try. */
    start(id) {
      const entry = find(id);
      if (!entry) return null;
      Object.assign(entry, { state: 'running', reason: '', at: 1 });
      save();
      return entry;
    },
    /** Where it is made, known once it begins (a conversation made for its first take). */
    set(id, fields) {
      const entry = find(id);
      if (!entry) return;
      Object.assign(entry, fields);
      save();
    },
    /** Its try `at` is being made. */
    tried(id, at) {
      const entry = find(id);
      if (!entry) return;
      entry.at = at;
      save();
    },
    /** Made, or stopped: out of the queue. */
    done(id) {
      entries = entries.filter(entry => entry.id !== id);
      save();
    },
    /** It could not be made: kept, with why (a click on its tile gives its settings back). */
    fail(id, reason) {
      const entry = find(id);
      if (!entry) return;
      Object.assign(entry, { state: 'failed', reason: String(reason || ''), at: 0 });
      save();
    },
    /**
     * Being made, it could not begin (the card held): back at its place, paused, with the tries it has `left`;
     * `later`, held at a try after its first one.
     */
    hold(id, why, left, later = false) {
      const entry = find(id);
      if (!entry) return;
      const tries = Math.max(1, left || entry.tries);
      Object.assign(entry, { state: 'paused', reason: why, at: 0, tries, later: Boolean(later || entry.later) });
      save();
    },
    /** Every one that waits waits for « Reprendre » now, and why. */
    pause(why) {
      for (const entry of entries)
        if (entry.state === 'waiting') Object.assign(entry, { state: 'paused', reason: why });
      save();
    },
    /** « Reprendre »: those of the conversation paused go again, in their order. */
    resume(conversation) {
      for (const entry of of(conversation, new Set(['paused']))) Object.assign(entry, { state: 'waiting', reason: '' });
      save();
    },
    /** Its cross: out of the queue, whatever it is (not the one being made, which « Arrêter » stops). */
    remove(id) {
      const before = entries.length;
      entries = entries.filter(entry => entry.id !== id || entry.state === 'running');
      save();
      return entries.length < before;
    },
    /** « Vider la file »: what waits in the conversation goes; its failures stay, each with its cross. */
    clear(conversation) {
      entries = entries.filter(entry => !(WAITS.has(entry.state) && entry.conversation === conversation));
      save();
    },
    /** A conversation deleted: nothing of it is left to make. */
    forget(conversation) {
      entries = entries.filter(entry => entry.conversation !== conversation || entry.state === 'running');
      save();
    },
  };
}
