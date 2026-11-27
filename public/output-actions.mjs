/**
 * The actions on a take, the same everywhere, the same icons and the same help (chat, Studio,
 * Pellicule; claude_design/maquettes/reference-maquettes.md):
 * - image: Ouvrir · Agrandir et affiner · Animer · Afficher dans le Studio;
 * - video: Ouvrir · Prolonger · Changer la caméra (0.6.240) · Interpoler · Agrandir et affiner · Afficher dans le
 *   Studio;
 * - sound: Ouvrir · Afficher dans le Studio.
 * Icons only (claude_design/icones-actions: their drawing and the words under the pointer, which are
 * their name for screen readers too). One that no active workflow can do is greyed, with the reason
 * under its words. « Ouvrir » shows the original and its settings (« Détails » before 0.6.6).
 * (0.6.198) The reason says « modèle » and « agrandir », as the rest of the application (« Aucun
 * workflow d’upscale image actif » before).
 */
const ACTIONS = [
  {
    id: 'details',
    label: 'Ouvrir',
    tip: 'Ouvrir : l’original, ses paramètres, Télécharger',
    icon: 'act-open',
    media: ['image', 'video', 'audio'],
  },
  {
    id: 'extend',
    verb: 'extend_video',
    label: 'Prolonger',
    tip: 'Prolonger : la suite de cette vidéo',
    icon: 'act-extend',
    media: ['video'],
    missing: () => 'Aucun modèle ne sait prolonger une vidéo.',
  },
  {
    id: 'refilm',
    verb: 'refilm_video',
    label: 'Changer la caméra',
    tip: 'Changer la caméra : la même vidéo, filmée d’un autre angle',
    icon: 'camera',
    media: ['video'],
    missing: () => 'Aucun modèle ne sait changer la caméra d’une vidéo.',
  },
  {
    id: 'interpolate',
    verb: 'interpolate',
    label: 'Interpoler',
    tip: 'Interpoler : des images en plus, un mouvement plus fluide',
    icon: 'act-interpolate',
    media: ['video'],
    missing: () => 'Aucun modèle d’interpolation actif.',
  },
  {
    id: 'upscale',
    verb: 'upscale',
    label: 'Agrandir et affiner',
    // (0.6.255) Its name under its icon in the column of the Studio (lot 3).
    name: 'Agrandir',
    tip: 'Agrandir et affiner ce résultat',
    icon: 'act-upscale',
    media: ['image', 'video'],
    missing: media => `Aucun modèle ne sait agrandir ${media === 'video' ? 'une vidéo' : 'une image'}.`,
  },
  {
    id: 'animate',
    verb: 'animate',
    label: 'Animer',
    tip: 'Animer : une vidéo qui part de cette prise',
    icon: 'act-animate',
    media: ['image'],
    missing: () => 'Aucun modèle vidéo ne part d’une image.',
  },
  {
    id: 'studio',
    label: 'Afficher dans le Studio',
    tip: 'Afficher dans le Studio : votre prompt et vos réglages ne changent pas',
    icon: 'act-studio',
    media: ['image', 'video', 'audio'],
  },
];
/** (0.6.198) The words of each action under the pointer, by its id: the Studio says them too (its « Ouvrir », « Animer »). */
export const ACTION_TIPS = Object.fromEntries(ACTIONS.map(action => [action.id, action.tip]));
const CACHE_MS = 5000;
/** The words of an action under the pointer; greyed, why under them. */
const tipOf = (action, reason = '') => (reason ? `${action.tip}\n${reason}` : action.tip);

/**
 * `actions(record, index)` builds the row of one take. `onAction(record, index, id)` receives
 * upscale, interpolate, extend and animate; Ouvrir calls `onDetails(record, index)`, Afficher dans
 * le Studio `onShow(record, index)` (absent: not offered, as in the Studio itself). Without
 * `onDetails`, no « Ouvrir » (the Studio: a click on the take on its screen opens it).
 * (0.6.466) `held()`: why what makes a take of this one waits now ('' when nothing holds it): greyed, with that reason.
 */
export function outputActions({
  api,
  node,
  onDetails,
  onAction,
  onShow = null,
  icon: drawIcon = null,
  rail = false,
  greyable = null,
  onGreyed = null,
  held = () => '',
}) {
  let available = null,
    loaded = 0,
    // (0.6.261) What the server said last: a row drawn again (the Studio draws itself again at each change) starts
    // from it, not greyed until its answer comes back (a click in between was lost, a focus given back fell on grey).
    known = null;
  function load() {
    if (!available || Date.now() - loaded > CACHE_MS) {
      loaded = Date.now();
      available = Promise.resolve()
        .then(() => api('tools/actions'))
        .then(response => response.json())
        .catch(() => ({}))
        .then(verbs => (known = verbs));
    }
    return available;
  }
  function icon(name) {
    // The Studio draws its icons itself (`icon`), as everything it shows.
    if (drawIcon) return drawIcon(name);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    svg.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }
  return function actions(record, index) {
    const media = ['video', 'audio'].includes(record.mediaType) ? record.mediaType : 'image',
      row = node('div', 'output-actions');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Actions sur cette prise');
    const buttons = [];
    for (const action of ACTIONS.filter(item => item.media.includes(media))) {
      if ((action.id === 'studio' && !onShow) || (action.id === 'details' && !onDetails)) continue;
      const button = node('button', 'output-action output-action-' + action.id);
      // (0.6.261) In the column of the Studio, a greyed one still answers (`greyable`: its `disabled` said by
      // aria-disabled), as « Générer »: the keys reach it, its reason is shown at its focus and said (`onGreyed`) at
      // its click. Disabled, Tab passed it by and a screen reader heard its name alone.
      if (rail && greyable) greyable(button);
      button.type = 'button';
      button.setAttribute('aria-label', action.tip);
      // (0.6.255) In the column of the Studio (`rail`), its name under its icon when the column unfolds, and no
      // bubble: only one greyed says why in its own.
      if (!rail) button.title = tipOf(action);
      button.append(icon(action.icon), node('span', '', rail ? (action.name ?? action.label) : action.label));
      button.onclick = () => {
        if (button.disabled) return void onGreyed?.(button);
        if (action.id === 'details') onDetails(record, index);
        else if (action.id === 'studio') onShow(record, index);
        else onAction(record, index, action.id);
      };
      if (action.verb) {
        // Disabled until the server says an active workflow can do it (what it said last, when it did).
        const waits = held();
        button.disabled = Boolean(waits) || !(known?.[action.verb] || []).includes(media);
        if (waits) button.title = rail ? waits : tipOf(action, waits);
        else if (known && button.disabled)
          button.title = rail ? action.missing(media) : tipOf(action, action.missing(media));
        buttons.push([button, action]);
      }
      row.append(button);
    }
    function refresh() {
      return load().then(verbs => {
        for (const [button, action] of buttons) {
          const waits = held(),
            ready = !waits && (verbs[action.verb] || []).includes(media);
          button.disabled = !ready;
          if (!rail) button.title = tipOf(action, ready ? '' : waits || action.missing(media));
          else if (!ready) button.title = waits || action.missing(media);
          else {
            // Ready again: its bubble of before goes (public/help-tips.mjs turned its title into a tip).
            button.removeAttribute?.('title');
            delete button.dataset?.tip;
          }
        }
      });
    }
    // Workflows can become ready after the row was drawn (relaunch, model added):
    // the row checks again when the pointer reaches it. A disabled button gets no
    // pointer events, so the listener sits on the row.
    if (buttons.length) row.addEventListener?.('pointerenter', refresh);
    refresh();
    return row;
  };
}
