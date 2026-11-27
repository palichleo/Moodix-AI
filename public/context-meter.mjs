const format = value => new Intl.NumberFormat('fr-FR').format(value);
export function contextBudget({ used, capacity, precision }) {
  const known = Number.isSafeInteger(used) && used >= 0;
  return {
    used: known ? used : null,
    capacity,
    precision,
    occupied: known ? Math.min(100, (100 * used) / capacity) : 0,
    warning: known && used >= capacity ? 'full' : known && used >= capacity * 0.9 ? 'near' : '',
  };
}

export function setupContextMeter({
  $,
  api,
  getRequest,
  getConversation = () => undefined,
  getConfig,
  isReady,
  isBusy,
  delay = 800,
}) {
  let timer,
    controller,
    revision = 0,
    conversation = getConversation(),
    last = {};
  const box = $('context-meter');
  function render(result = last) {
    last = result;
    const { contextSize: capacity = 8192 } = getConfig(),
      budget = contextBudget({ ...result, capacity });
    const qualifier =
      budget.precision === 'text-only' ? '≥ ' : ['estimated', 'rough'].includes(budget.precision) ? '≈ ' : '';
    const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(budget.occupied);
    const usage =
      budget.used === null
        ? 'Contexte utilisé : comptage indisponible.'
        : 'Contexte utilisé : ' +
          qualifier +
          format(budget.used) +
          ' / ' +
          format(capacity) +
          ' tokens (' +
          qualifier +
          percent +
          ' %).';
    const detail =
      budget.used === null
        ? 'Le comptage nécessite un moteur prêt et compatible.'
        : budget.precision === 'text-only'
          ? 'Texte compté ; le coût des images est inconnu et s’ajoute à cette valeur.'
          : budget.precision === 'estimated'
            ? 'Estimation avec le template et le tokenizer du moteur.'
            : budget.precision === 'rough'
              ? 'Estimation d’après la longueur du texte : le service distant donne le compte exact après chaque réponse.'
              : 'Messages envoyés et réponses, avec les consignes et outils inclus dans cette conversation.';
    const warning =
      budget.warning === 'full' ? 'Contexte saturé.' : budget.warning === 'near' ? 'Contexte presque rempli.' : '';
    // (0.6.454) The bubble of the ring (agent-studio-maquette.md, 25/11): the share in whole percents (never « 90 % »
    // before the amber, nor « 100 % » before it is full), then the tokens in mono, then the warning in amber. How it
    // is counted stays for screen readers alone.
    const lines =
      budget.used === null
        ? ['Contexte utilisé : comptage indisponible.']
        : [
            'Contexte utilisé : ' + Math.floor(budget.occupied) + ' %',
            qualifier + format(budget.used) + ' / ' + format(capacity) + ' tokens',
            warning,
          ].filter(Boolean);
    box.dataset.tipLines = budget.used === null ? 'plain' : warning ? 'plain mono warn' : 'plain mono';
    box.title = lines.join('\n');
    // The share, from 0 to 100, without a unit: each arc of the ring is drawn on a length of 100 (moodix.css).
    box.style.setProperty('--context-used', String(budget.occupied));
    box.dataset.warning = budget.warning;
    box.setAttribute('aria-valuemax', String(capacity));
    box.setAttribute('aria-valuetext', [usage, detail, warning].filter(Boolean).join(' '));
    if (budget.used === null) box.removeAttribute('aria-valuenow');
    else box.setAttribute('aria-valuenow', String(Math.min(capacity, budget.used)));
  }
  function pause() {
    revision++;
    clearTimeout(timer);
    controller?.abort();
  }
  function schedule() {
    pause();
    const current = revision;
    if (isBusy()) return;
    const selected = getConversation();
    if (selected !== conversation) {
      conversation = selected;
      last = {};
    }
    const request = getRequest();
    if (!request) {
      render({ used: 0, precision: 'exact' });
      return;
    }
    render();
    if (!isReady()) return;
    timer = setTimeout(async () => {
      controller = new AbortController();
      try {
        const result = await (await api('context', request, { signal: controller.signal })).json();
        if (current === revision && !isBusy()) render(result);
      } catch {
        if (current === revision) render({});
      }
    }, delay);
  }
  function observe(event) {
    const usage = event.usage;
    if (
      !usage ||
      !Number.isSafeInteger(usage.prompt_tokens) ||
      usage.prompt_tokens < 0 ||
      !Number.isSafeInteger(usage.completion_tokens) ||
      usage.completion_tokens < 0
    )
      return;
    conversation = getConversation();
    render({ used: usage.prompt_tokens + usage.completion_tokens, precision: 'exact' });
  }
  render(getRequest() ? {} : { used: 0, precision: 'exact' });
  return { schedule, pause, observe };
}
