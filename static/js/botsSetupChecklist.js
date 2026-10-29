import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';

export const setupStatus = value => ({ ready: 'Ready', needs_setup: 'Needs setup', not_checked: 'Not checked' }[value] || 'Not checked');
export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-onboarding.css');
  let dead = false, version = 0, checkedAt = 0;
  const abort = new AbortController();
  const root = h('section', { class: 'bots-setup', 'data-section': 'setup', 'aria-label': 'Setup checklist' });
  const rows = h('div', { role: 'list' }), status = h('p', { role: 'status' });
  const recheck = Button({ label: 'Check again', onClick: () => refresh(true) });
  root.append(h('h2', { text: 'Check your setup', tabindex: '-1' }), rows, recheck, status); host.replaceChildren(root);
  const navigate = section => ctx.navigate ? ctx.navigate(section) : document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings', section } }));
  async function refresh(force = false) {
    if (force && Date.now() - checkedAt < 10000) { status.textContent = 'Wait a moment before checking again.'; return; }
    const mine = ++version; recheck.disabled = true; status.textContent = 'Checking setup...';
    try {
      const result = await api('/api/bot-onboarding/setup' + (force ? '/recheck' : ''), { method: force ? 'POST' : 'GET', signal: abort.signal, toast: false });
      if (dead || mine !== version) return;
      checkedAt = Date.now();
      rows.replaceChildren(...result.checks.map(check => {
        const value = check.id === 'notifications' && typeof Notification !== 'undefined'
          ? Notification.permission === 'granted' ? 'ready' : Notification.permission === 'denied' ? 'needs_setup' : 'not_checked' : check.status;
        return h('div', { class: 'bots-setup-row', role: 'listitem', 'data-check': check.id, 'data-status': value }, [h('span', { text: check.title }),
          h('span', { class: 'bots-setup-status', text: setupStatus(value) }), Button({ label: value === 'ready' ? 'Settings' : 'Set up', onClick: () => navigate(check.fix) })]);
      })); status.textContent = 'Setup checked.';
    } catch { if (!dead && mine === version) { status.textContent = 'Setup could not load. Try again.'; checkedAt = 0; } }
    finally { if (!dead && mine === version) recheck.disabled = false; }
  }
  const destroy = () => { dead = true; version++; abort.abort(); root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true }); refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
