import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';
import { meterTone } from './botsUsageModel.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-usage.css');
  const root = h('section', { class: 'bots-usage bots-plan', 'aria-label': 'Plan usage' });
  host.replaceChildren(root);
  let dead = false, generation = 0;
  const abort = new AbortController();
  async function refresh(force = false) {
    const ticket = ++generation;
    root.replaceChildren(h('p', { text: 'Loading plan usage...' }));
    try {
      const data = await api(`/api/bot-usage/plan${force === true ? '?refresh=1' : ''}`, { toast: false, signal: abort.signal });
      if (dead || ticket !== generation) return;
      root.replaceChildren(h('h3', { text: 'Plan usage' }), Button({ label: 'Refresh plan', onClick: () => refresh(true) }));
      if (!data.providers?.length) root.append(h('p', { text: 'No plan windows reported.' }));
      for (const provider of data.providers || []) {
        root.append(h('h4', { text: provider.provider }));
        if (provider.stale || provider.note) root.append(h('p', { text: provider.note || 'This reading is stale.' }));
        for (const window of provider.windows || []) {
          const value = window.used_percent;
          const meter = h('progress', { max: 100, value, 'aria-label': `${provider.provider} ${window.name}`, class: `bots-plan-meter ${meterTone(value)}` });
          root.append(h('div', { class: 'bots-plan-window' }, [h('span', { text: `${window.name}: ${value}%` }), meter,
            h('small', { text: window.resets_at ? `Resets ${new Date(window.resets_at * 1000).toLocaleString()}` : 'Reset time unknown' })]));
        }
      }
    } catch {
      if (!dead && ticket === generation) root.replaceChildren(h('p', { text: 'Plan usage could not load.' }), Button({ label: 'Retry', onClick: () => refresh() }));
    }
  }
  function destroy() { dead = true; abort.abort(); root.remove(); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
