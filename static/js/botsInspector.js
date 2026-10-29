// The Inspector (Agents 3.0 Phase 1, unit U5): one conversation's runs and the
// events Kairos recorded for them, secrets already removed. It shows the real
// persisted run timeline and runtime records, each labelled with its source. It
// is not a provider trace and never claims to be one (full tracing is Phase 6).
import { Segmented } from './botsUi.js';
import { BASE, entryLine, formatAge, h, errorText } from './botsAttentionHost.js';

const FILTERS = [{ value: 'all', label: 'All' }, { value: 'problems', label: 'Problems' }];

export async function mount(root, ctx) {
  const sessionId = ctx.args?.sessionId || '';
  const view = { entries: [], runs: [], total: 0, filter: 'all', error: '', loaded: false };
  let disposed = false;
  const list = h('div', { class: 'bots-attn-scroll' });
  root.replaceChildren(list);
  if (!sessionId) { list.replaceChildren(h('p', { class: 'bots-attn-note', text: 'Open a conversation first, then inspect it.' })); return { dispose() { disposed = true; } }; }

  async function load() {
    try {
      const data = await ctx.get(`${BASE}/threads/${encodeURIComponent(sessionId)}/events`);
      if (disposed) return;
      view.entries = data.entries || []; view.runs = data.runs || []; view.total = data.total || 0; view.loaded = true; view.error = '';
    } catch (error) {
      if (disposed) return;
      view.error = errorText(error);
    }
    draw();
  }

  const tokens = run => [run.input_tokens != null ? `${run.input_tokens} in` : '', run.output_tokens != null ? `${run.output_tokens} out` : ''].filter(Boolean).join(', ');

  function draw() {
    if (disposed) return;
    const filters = Segmented({ label: 'Event filter', value: view.filter, options: FILTERS, onChange: value => { view.filter = value; draw(); } });
    filters.classList.add('bots-attn-tabs');
    const lines = view.entries.map(entry => ({ entry, line: entryLine(entry) })).filter(({ line }) => view.filter === 'all' || line.tone === 'bad');
    list.replaceChildren(
      h('p', { class: 'bots-attn-note', text: 'What Kairos recorded for this conversation. Secrets are removed. This is not a provider trace.' }),
      view.error ? h('p', { class: 'bots-attn-note error', role: 'alert', text: view.error }) : null,
      view.runs.length ? h('section', { class: 'bots-attn-day' }, [
        h('div', { class: 'bots-caps bots-attn-day-label', text: 'Runs' }),
        h('div', { class: 'bots-attn-rows', role: 'list' }, view.runs.map(run => h('div', { class: `bots-attn-entry tone-${run.outcome === 'completed' ? 'ok' : /fail|error/.test(run.outcome || '') ? 'bad' : 'ok'}`, role: 'listitem', 'data-run': run.id }, [
          h('span', { class: 'bots-attn-row-main' }, [
            h('span', { class: 'bots-attn-row-top' }, [h('span', { class: 'bots-attn-subject', text: run.outcome || 'running' }), h('span', { class: 'bots-attn-age', text: formatAge(run.started_at) })]),
            h('span', { class: 'bots-attn-snippet', text: [run.model, tokens(run)].filter(Boolean).join(' / ') || 'No usage reported' }),
          ])]))),
      ]) : null,
      h('div', { class: 'bots-attn-tools' }, [filters]),
      h('div', { class: 'bots-attn-rows', role: 'list', 'aria-label': 'Events' }, lines.length ? lines.map(({ entry, line }) => h('div', { class: `bots-attn-entry tone-${line.tone}`, role: 'listitem', 'data-id': entry.id }, [
        h('span', { class: 'bots-attn-row-main' }, [
          h('span', { class: 'bots-attn-row-top' }, [h('span', { class: 'bots-attn-subject', text: line.title }), h('span', { class: 'bots-attn-age', text: formatAge(entry.at) })]),
          line.detail ? h('span', { class: 'bots-attn-snippet', text: line.detail }) : null,
          h('span', { class: 'bots-attn-source', text: line.source }),
        ])])) : [h('p', { class: 'bots-attn-note', text: view.loaded ? 'No events recorded.' : 'Loading...' })]),
      view.total > view.entries.length ? h('p', { class: 'bots-attn-note', text: `Showing the newest ${view.entries.length} of ${view.total}.` }) : null,
    );
  }

  await load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, 15000);
  return { dispose() { disposed = true; clearInterval(timer); }, refresh: load };
}
