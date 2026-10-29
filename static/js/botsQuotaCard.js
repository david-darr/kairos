import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';

// Phase 3 may supply a durable settle callback through ctx.settleCard. Without
// it the existing owner-checked session model endpoint is the authority.
export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-usage.css');
  const root = h('section', { class: 'bots-usage bots-quota-card', 'aria-live': 'polite' });
  host.replaceChildren(root);
  let dead = false, settled = false;
  const abort = new AbortController();
  async function refresh() {
    root.replaceChildren(h('p', { text: 'Checking plan limits...' }));
    try {
      const data = await api('/api/bot-usage/plan', { toast: false, signal: abort.signal });
      if (dead || settled) return;
      const current = data.models?.find(m => m.id === ctx.endpointId);
      const exhausted = current?.quota?.windows?.some(w => w.used_percent >= 100);
      if (!exhausted || current?.quota?.stale) { root.replaceChildren(h('p', { text: 'No current plan limit is reported.' })); return; }
      root.replaceChildren(h('p', { text: 'This model reached its plan limit.' }));
      const choices = (data.models || []).filter(m => m.id !== ctx.endpointId && m.status === 'connected'
        && !m.quota?.windows?.some(w => w.used_percent >= 100));
      if (!choices.length) root.append(h('p', { text: 'Connect another model in Settings to switch this chat.' }));
      for (const model of choices) root.append(Button({ label: `Switch this chat to ${model.name}`, onClick: () => settle('switched', model) }));
      root.append(Button({ label: 'Not now', onClick: () => settle('rejected') }));
    } catch { if (!dead) root.replaceChildren(h('p', { text: 'Plan limits could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  async function settle(outcome, model) {
    if (settled || dead) return;
    settled = true;
    root.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await ctx.flush?.();
      if (ctx.settleCard) await ctx.settleCard({ outcome, endpoint_id: model?.id });
      else if (outcome === 'switched') await api(`/api/sessions/${encodeURIComponent(ctx.threadId)}/model`, { method: 'POST', toast: false, signal: abort.signal,
        body: JSON.stringify({ model_endpoint_id: model.id, model_override: model.model || null }) });
      if (!dead) root.replaceChildren(h('p', { text: outcome === 'switched' ? `Switched to ${model.name}.` : 'Kept this model.' }));
    } catch {
      settled = false;
      if (!dead) root.replaceChildren(h('p', { text: 'The model could not change. Try again.' }), Button({ label: 'Retry', onClick: refresh }));
    }
  }
  function destroy() { dead = true; abort.abort(); root.remove(); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
