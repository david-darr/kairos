import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime, placeHint } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), base = `/api/bot-workbench/${encodeURIComponent(ctx.agentId)}`;
  const root = el('section', { class: `bots-place${ctx.advanced ? ' is-advanced' : ''}`, 'aria-label': 'Where the bot works' });
  host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(el('p', { text: 'Loading places', role: 'status' }));
    try {
      const [places, status] = await Promise.all([api(`${base}/places`, { signal: life.signal }), api(`${base}/status${ctx.threadId ? `?thread_id=${encodeURIComponent(ctx.threadId)}` : ''}`, { signal: life.signal })]);
      if (!life.active) return;
      const pin = el('input', { type: 'checkbox', checked: !!status.place.thread, 'aria-label': 'Pin for this conversation' });
      const error = el('p', { role: 'alert', class: 'bots-workbench-error' });
      const grid = el('div', { class: 'bots-place-grid', role: 'group', 'aria-label': 'Works on' });
      const save = async value => {
        if (ctx.flush && await ctx.flush() === false) return;
        const path = pin.checked && ctx.threadId ? `/api/agents/${encodeURIComponent(ctx.agentId)}/threads/${encodeURIComponent(ctx.threadId)}` : `/api/agents/${encodeURIComponent(ctx.agentId)}`;
        try {
          await api(path, { method: 'PATCH', body: JSON.stringify({ place: value }), signal: life.signal, toast: false });
          if (life.active) { await refresh(); ctx.refresh?.(); }
        } catch (e) { if (life.active) error.textContent = e.message; }
      };
      for (const place of places) grid.append(el('button', { type: 'button', class: 'bots-btn bots-place-option',
        disabled: !place.available, title: placeHint(place), 'aria-pressed': String(status.place.effective === place.id),
        onclick: () => save(place.id) }, [el('span', { text: place.label }), el('small', { text: placeHint(place) })]));
      const unpin = el('button', { type: 'button', class: 'bots-btn', text: 'Unpin', onclick: async () => {
        pin.checked = true; await save(null);
      } });
      root.replaceChildren(el('h3', { text: 'Works on' }), grid, error);
      if (ctx.threadId) root.append(el('label', { class: 'bots-workbench-row' }, [pin, 'Pin for this conversation']));
      if (status.place.thread) root.append(el('p', { text: 'Pinned for this conversation' }), unpin);
    } catch (e) { if (life.active) root.replaceChildren(el('p', { role: 'alert', text: e.message }), el('button', { class: 'bots-btn', text: 'Retry', onclick: refresh })); }
  }
  await refresh();
  return life.handle(refresh);
}
