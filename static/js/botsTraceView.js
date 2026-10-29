import { api, openPanelDialog } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';
import { cost, duration } from './botsUsageModel.js';
import { waterfall } from './botsTraceWaterfall.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-usage.css');
  const root = h('section', { class: 'bots-usage bots-trace', 'aria-live': 'polite' });
  host.replaceChildren(root);
  const abort = new AbortController();
  let dead = false, generation = 0, last = 0;
  async function refresh() {
    const ticket = ++generation; last = Date.now();
    root.replaceChildren(h('p', { text: 'Loading trace...' }));
    try {
      const tree = await api(`/api/bot-usage/traces/${encodeURIComponent(ctx.runId)}`, { toast: false, signal: abort.signal });
      if (dead || generation !== ticket) return;
      root.replaceChildren(h('p', { text: `${duration(tree.duration_s)} · ${cost(tree.cost_usd)} · ${tree.outcome}` }),
        h('p', { text: 'List-price equivalent, not billed', class: 'bots-usage-note' }));
      if (tree.totals_only) root.append(h('p', { text: 'Only totals remain. Trace details have expired.' }));
      else root.append(waterfall(tree));
    } catch {
      if (!dead && generation === ticket) root.replaceChildren(h('p', { text: 'Trace could not load.' }), Button({ label: 'Retry', onClick: refresh }));
    }
  }
  let timer;
  const changed = () => { if (!timer) timer = setTimeout(() => { timer = null; if (!dead) refresh(); }, Math.max(0, 1000 - (Date.now() - last))); };
  document.addEventListener('kairos:turn-state', changed);
  function destroy() { dead = true; abort.abort(); clearTimeout(timer); document.removeEventListener('kairos:turn-state', changed); root.remove(); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}

export async function openTrace(runId) {
  const host = h('div', { 'data-app-mode': 'bots' });
  let control;
  const dialog = openPanelDialog({ title: 'Run trace', body: host, wide: true, className: 'bots-dialog', onClose: () => control?.destroy() });
  control = await mount(host, { runId, signal: dialog.signal });
  if (dialog.signal.aborted) control.destroy();
  return dialog;
}
