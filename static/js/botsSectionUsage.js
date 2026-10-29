import { api } from './api.js';
import { h, Button, loadBotsCss } from './botsUi.js';
import { cost, duration, periodRange } from './botsUsageModel.js';

export async function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-usage.css');
  let dead = false, request = 0, offset = 0;
  const abort = new AbortController();
  const root = h('section', { class: 'bots-usage', 'aria-label': 'Usage' });
  const period = h('select', { 'aria-label': 'Usage period' },
    [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['last-month', 'Last month'], ['30-days', '30 days']]
      .map(([value, text]) => h('option', { value, text })));
  period.value = 'month';
  const group = h('select', { 'aria-label': 'Group usage by' },
    ['bot', 'model', 'endpoint', 'day', 'trigger', 'routine'].map(value => h('option', { value, text: value })));
  const content = h('div', { 'aria-live': 'polite' });
  root.append(h('div', { class: 'bots-usage-controls' }, [period, group]), content);
  host.replaceChildren(root);
  function query() {
    return new URLSearchParams({ ...periodRange(period.value), group_by: group.value,
      ...(ctx.agentId ? { bot_id: ctx.agentId } : {}) });
  }
  async function refresh() {
    const ticket = ++request;
    content.replaceChildren(h('p', { text: 'Loading usage...' }));
    try {
      const params = query();
      const [summary, runs] = await Promise.all([
        api(`/api/bot-usage/summary?${params}`, { toast: false, signal: abort.signal }),
        api(`/api/bot-usage/runs?${params}&offset=${offset}&limit=25`, { toast: false, signal: abort.signal }),
      ]);
      if (dead || ticket !== request) return;
      const t = summary.totals;
      const stats = h('dl', { class: 'bots-usage-stats' });
      for (const [label, value] of [['Time', duration(t.duration_s)], ['Cost', cost(t.cost_usd)], ['Tokens', t.tokens],
        ['Steps', t.steps], ['Tools', t.tools], ['Errors', t.errors]]) stats.append(h('div', {}, [h('dt', { text: label }), h('dd', { text: String(value) })]));
      content.replaceChildren(stats, h('p', { class: 'bots-usage-note', text: summary.cost_note }));
      if (t.unknown_cost_runs) content.append(h('p', { text: `${t.unknown_cost_runs} runs have unknown cost.` }));
      if (!t.runs) { content.append(h('p', { text: ctx.agentId ? 'No usage for this bot in this period.' : 'No bot usage in this period.' })); return; }
      content.append(h('h3', { text: 'Where it went' }));
      const max = Math.max(1, ...summary.groups.map(row => row.tokens));
      for (const row of summary.groups) {
        const fill = h('span', { class: 'bots-usage-fill' }); fill.style.width = `${row.tokens / max * 100}%`;
        content.append(h('div', { class: 'bots-usage-bar-row' }, [h('span', { text: row.key }),
          h('span', { class: 'bots-usage-track', 'aria-hidden': 'true' }, [fill]), h('span', { text: cost(row.cost_usd) })]));
      }
      content.append(h('h3', { text: 'Runs' }));
      for (const row of runs.rows) {
        const button = Button({ label: `${row.model || 'Unknown model'} · ${duration(row.duration_s)} · ${cost(row.cost_usd)}`,
          onClick: async () => {
            try { const { openTrace } = await import('./botsTraceView.js'); if (!dead) await openTrace(row.run_id); }
            catch { if (!dead) content.append(h('p', { text: 'Trace could not load. Try again.' })); }
          } });
        button.dataset.runId = row.run_id; content.append(button);
      }
      if (!ctx.agentId) content.append(h('a', { href: `/api/bot-usage/usage.csv?${query()}`, download: 'bot-usage.csv', text: 'Export CSV' }));
      const pages = h('div', { class: 'bots-usage-controls' });
      if (offset) pages.append(Button({ label: 'Previous', onClick: () => { offset = Math.max(0, offset - 25); refresh(); } }));
      if (offset + runs.rows.length < runs.total) pages.append(Button({ label: 'Next', onClick: () => { offset += 25; refresh(); } }));
      content.append(pages);
    } catch {
      if (!dead && ticket === request) content.replaceChildren(h('p', { text: 'Usage could not load.' }), Button({ label: 'Retry', onClick: refresh }));
    }
  }
  period.onchange = group.onchange = () => { offset = 0; refresh(); };
  const destroy = () => { dead = true; abort.abort(); request++; root.remove(); };
  ctx.signal?.addEventListener('abort', destroy, { once: true });
  refresh();
  return { destroy, refresh, flush: async () => ({ ok: true }) };
}
