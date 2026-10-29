import { h } from './botsUi.js';

export function claimHint(seen, kind) { if (seen.has(kind)) return false; seen.add(kind); return true; }
const COPY = { widget: 'Choose an answer on the card.', app: 'Use the app here, or open it full screen.', help: 'Answer here or in the computer panel.', quota_switch: 'Choose another connected model to keep going.' };
export function mount(host, { state, signal, save }) {
  const seen = new Set(state.hints_seen || []), nodes = new Set(); let dead = false;
  const check = () => {
    if (dead) return;
    for (const card of document.querySelectorAll('[data-rich-kind]')) {
      const kind = card.dataset.richKind;
      if (!COPY[kind] || !claimHint(seen, kind)) continue;
      const hint = h('p', { class: 'bots-card-hint', role: 'note', text: COPY[kind] }); card.prepend(hint); nodes.add(hint);
      save({ hints: [kind] }).catch(() => { if (!dead) hint.textContent = 'Hint state could not save. Reopen Bots to try again.'; });
    }
  };
  const observer = new MutationObserver(check); observer.observe(host, { childList: true, subtree: true }); check();
  const destroy = () => { dead = true; observer.disconnect(); nodes.forEach(node => node.remove()); };
  signal?.addEventListener('abort', destroy, { once: true }); return { destroy, refresh: check, flush: async () => ({ ok: true }) };
}
