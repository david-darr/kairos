import { api, el } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { lifetime } from './botsWorkbenchModel.js';

export async function mount(host, ctx) {
  loadBotsCss('/static/css/bots-workbench.css');
  const life = lifetime(ctx), root = el('section');
  const base = `/api/bot-workbench/${encodeURIComponent(ctx.agentId)}`;
  host.replaceChildren(root);
  async function refresh() {
    root.replaceChildren(el('p', { role: 'status', text: 'Loading signed-in sites' }));
    try {
      const sites = await api(base + '/sites', { signal: life.signal });
      if (!life.active) return;
      root.replaceChildren(el('h3', { text: 'Signed-in sites' }));
      if (!sites.length) root.append(el('p', { text: 'No saved sites' }));
      for (const site of sites) root.append(el('div', { class: 'bots-workbench-row' }, [el('span', { text: site }),
        el('button', { class: 'bots-btn', type: 'button', text: 'Sign out', onclick: async event => {
          const button = event.currentTarget;
          if (ctx.flush && await ctx.flush() === false) return;
          button.disabled = true;
          try { await api(base + '/sites/sign-out', { method: 'POST', body: JSON.stringify({ host: site }), signal: life.signal, toast: false }); if (life.active) await refresh(); }
          catch (e) { if (life.active) { root.append(el('p', { role: 'alert', text: e.message })); button.disabled = false; } }
        } }),
      ]));
    } catch (e) { if (life.active) root.replaceChildren(el('p', { role: 'alert', text: e.message }), el('button', { class: 'bots-btn', text: 'Retry', onclick: refresh })); }
  }
  await refresh(); return life.handle(refresh);
}
