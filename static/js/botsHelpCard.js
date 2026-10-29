import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), item = ctx.help;
  host.replaceChildren();
  if (!item) return life.handle(async () => {});
  const error = el('p', { role: 'alert' });
  const root = el('section', { class: 'bots-help-card', 'aria-label': item.site ? 'Sign in' : 'Computer help' }, [
    el('h3', { text: item.site ? `Sign in at ${item.site}` : 'The bot needs you' }), el('p', { text: item.reason }), error,
  ]);
  let pending = false;
  for (const [outcome, label] of [['done', 'Done'], ['cancel', 'Cancel']]) root.append(el('button', { type: 'button', class: 'bots-btn', text: label,
    disabled: !!item.outcome, onclick: async () => {
      if (pending) return;
      pending = true;
      root.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await api(`/api/bot-workbench/${encodeURIComponent(ctx.agentId)}/help/${encodeURIComponent(item.id)}/settle`, { method: 'POST', body: JSON.stringify({ outcome }), signal: life.signal, toast: false });
        if (life.active) { root.replaceChildren(el('p', { text: outcome === 'done' ? 'Done' : 'Cancelled' })); ctx.refresh?.(); }
      } catch (e) { if (life.active) { error.textContent = e.message; pending = false; root.querySelectorAll('button').forEach(b => { b.disabled = false; }); } }
    } }));
  if (item.outcome) error.textContent = 'This help request is no longer available';
  host.append(root);
  return life.handle(async () => {});
}
