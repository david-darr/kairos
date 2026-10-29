import { h, Button } from './botsUi.js';

export function noticeBlocked({ dialog, firstChat, call }) { return !!(dialog || firstChat || call); }
export function createNoticeQueue(receipts = {}) {
  const pending = [], seen = new Set(Object.keys(receipts));
  return { add(notice) { if (!notice?.id || seen.has(notice.id)) return false; seen.add(notice.id); pending.push(notice); return true; },
    next(busy) { return noticeBlocked(busy) ? null : pending.shift() || null; } };
}
export function mount(host, { state, signal, save }) {
  const queue = createNoticeQueue(state.notices), root = h('aside', { class: 'bots-notices', 'data-section': 'notices', 'data-app-mode': 'bots', 'aria-label': 'Bots notice', hidden: true });
  let current = null, activeCall = document.documentElement.dataset.botsCallActive === 'true', dead = false;
  host.append(root);
  function refresh() {
    if (current || dead) return;
    const notice = queue.next({ dialog: document.querySelector('dialog[open], .modal-backdrop:not(.hidden), [role="dialog"]:not([hidden])'), firstChat: document.querySelector('.bots-live[aria-busy="true"]'), call: activeCall });
    if (!notice) return;
    current = notice; root.hidden = false;
    const status = h('p', { role: 'status' });
    root.replaceChildren(h('p', { text: notice.text }), Button({ label: 'Got it', onClick: async () => {
      try { await save({ notices: { [notice.id]: { dismissed: true } } }); if (!dead) { root.hidden = true; current = null; refresh(); } }
      catch { if (!dead) status.textContent = 'Notice state could not save. Try again.'; }
    } }), status);
    save({ notices: { [notice.id]: { dismissed: false } } }).catch(() => { if (!dead) status.textContent = 'Notice state could not save. Try again.'; });
  }
  const add = event => { queue.add(event.detail); refresh(); };
  const call = event => { activeCall = event.detail.active; refresh(); };
  document.addEventListener('kairos:bots-notice', add); document.addEventListener('kairos:bots-call-state', call);
  const timer = setInterval(refresh, 1000);
  const destroy = () => { dead = true; clearInterval(timer); document.removeEventListener('kairos:bots-notice', add); document.removeEventListener('kairos:bots-call-state', call); root.remove(); };
  signal?.addEventListener('abort', destroy, { once: true }); return { destroy, refresh, flush: async () => ({ ok: true }) };
}
