import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';
import { mount as mountUsage } from './botsSectionUsage.js';
import { mount as mountPlan } from './botsPlanMeters.js';
import { cost } from './botsUsageModel.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css'); loadBotsCss('/static/css/bots-usage.css');
  const root = h('section', { 'data-app-mode': 'bots', class: 'bots-usage' });
  const budget = h('div'), usage = h('div'), plan = h('div');
  root.append(h('h2', { text: 'Usage and spend' }), budget, usage, plan); host.replaceChildren(root);
  let dead = false, generation = 0, controls = [];
  const abort = new AbortController();
  async function refresh() {
    const ticket = ++generation;
    budget.replaceChildren(h('p', { text: 'Loading budget...' }));
    try {
      const [data, prices] = await Promise.all([api('/api/bot-usage/budget', { toast: false, signal: abort.signal }),
        api('/api/bot-usage/prices', { toast: false, signal: abort.signal })]);
      if (dead || ticket !== generation) return;
      const input = h('input', { type: 'number', min: 0, step: '.01', 'aria-label': 'Monthly cap in USD', placeholder: 'No cap' });
      input.value = data.monthly_usd ?? '';
      const warning = h('p', { role: 'status', text: data.capped ? 'Monthly spend cap reached. An admin can raise it under Settings, Usage and spend.'
        : data.near_cap ? 'Bot usage is near the monthly spend cap.' : `${cost(data.spent_usd)} this month` });
      const save = Button({ label: 'Save cap', onClick: async () => {
        if (!input.checkValidity()) { input.reportValidity(); return; }
        save.disabled = true;
        try { await ctx.flush?.(); await api('/api/bot-usage/budget', { method: 'PUT', toast: false,
          signal: abort.signal, body: JSON.stringify({ monthly_usd: input.value === '' ? null : Number(input.value), warn_percent: data.warn_percent }) }); if (!dead) refresh(); }
        catch { if (!dead) { save.disabled = false; warning.textContent = 'Cap could not save. Try again.'; } }
      } });
      budget.replaceChildren(h('h3', { text: 'Monthly spend cap' }), warning, h('p', { text: 'List-price equivalent, not billed. Unknown costs are excluded.' }), input, save);
      const stale = Date.now() - Date.parse(prices.as_of) > 120 * 86400000;
      budget.append(h('p', { class: 'bots-usage-note', text: `${stale ? 'Price table needs review. ' : ''}Prices as of ${prices.as_of}.` }));
      const editor = h('textarea', { 'aria-label': 'Price overrides', rows: 6 });
      editor.value = JSON.stringify(prices.prices_override, null, 2);
      const status = h('p', { role: 'status' });
      budget.append(h('details', {}, [h('summary', { text: 'Price overrides' }), h('p', { text: 'USD per million tokens: input, output, cache_read, cache_write.' }), editor,
        Button({ label: 'Save prices', onClick: async () => {
          try { const value = JSON.parse(editor.value); await api('/api/bot-usage/prices', { method: 'PUT', toast: false, signal: abort.signal,
            body: JSON.stringify({ prices_override: value }) }); if (!dead) status.textContent = 'Prices saved for future runs.'; }
          catch { if (!dead) status.textContent = 'Prices could not save. Check the values.'; }
        } }), status]));
    } catch { if (!dead && ticket === generation) budget.replaceChildren(h('p', { text: 'Budget could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  controls = await Promise.all([mountUsage(usage, { ...ctx, agentId: null }), mountPlan(plan, ctx)]);
  function destroy() { dead = true; abort.abort(); for (const c of controls) c.destroy(); root.remove(); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh: async () => { refresh(); for (const c of controls) c.refresh(); }, flush: async () => ({ ok: true }) };
}

export async function mountHousekeeping(host, ctx = {}) {
  loadBotsCss('/static/css/bots.css'); loadBotsCss('/static/css/bots-usage.css');
  const root = h('section', { 'data-app-mode': 'bots', class: 'bots-usage' });
  host.replaceChildren(root);
  const abort = new AbortController();
  let dead = false;
  async function refresh() {
    root.replaceChildren(h('p', { text: 'Loading housekeeping...' }));
    try {
      const config = await api('/api/bot-usage/housekeeping', { toast: false, signal: abort.signal });
      if (dead) return;
      const days = h('input', { type: 'number', min: 1, max: 3650, step: 1, 'aria-label': 'Trace retention days' });
      const size = h('input', { type: 'number', min: .25, max: 4096, step: '.25', 'aria-label': 'Trace size cap in MB' });
      days.value = config.event_retention_days; size.value = config.event_size_cap_mb;
      const status = h('p', { role: 'status' });
      const save = Button({ label: 'Save housekeeping', onClick: async () => {
        if (!days.checkValidity() || !size.checkValidity()) { days.reportValidity(); size.reportValidity(); return; }
        save.disabled = true;
        try { await api('/api/bot-usage/housekeeping', { method: 'PUT', toast: false, signal: abort.signal,
          body: JSON.stringify({ event_retention_days: Number(days.value), event_size_cap_mb: Number(size.value) }) });
          if (!dead) status.textContent = 'Saved. Applies on the next daily cleanup.';
        } catch { if (!dead) status.textContent = 'Housekeeping could not save. Try again.'; }
        finally { if (!dead) save.disabled = false; }
      } });
      root.replaceChildren(h('h2', { text: 'Housekeeping' }), h('p', { text: 'Remove old trace details. Run totals and usage history are kept.' }),
        h('label', { text: 'Keep trace details for days' }, [days]), h('label', { text: 'Trace size cap in MB' }, [size]), save, status);
    } catch { if (!dead) root.replaceChildren(h('p', { text: 'Housekeeping could not load.' }), Button({ label: 'Retry', onClick: refresh })); }
  }
  function destroy() { dead = true; abort.abort(); root.remove(); }
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
