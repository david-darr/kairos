// A bot's Memory activity (Bots Phase 2, unit U2). Mounted inside the Memory section: what the bot noticed,
// tidied and looked back on, the ideas it has for you (they last 24 hours), a search over its notes and past chats,
// and "forget". Contract (phase-2-design.md section 6): mount(host, ctx) -> {destroy, refresh, flush}, safe to
// destroy while requests are pending. ctx: agentId, state.agent, advanced, flush(), refresh(), go(section).
// Everything the server sends is drawn as plain text.
import { api, el, confirmDialog } from './api.js';
import { Card, Button, loadBotsCss } from './botsUi.js';
import { icon } from './botsIcons.js';
import {
  citation, forgetTermProblem, ideaLeft, liveIdeas, memoryState, messageOf, nothingHappened, pendingLine, recallQuery,
  reportRows, reportTitle,
} from './botsMemoryActivityModel.js';

export const MEMORY_ACTIVITY_CSS = '/static/css/bots-memory-activity.css';

export function mount(host, ctx) {
  loadBotsCss(MEMORY_ACTIVITY_CSS);
  const base = `/api/bots/${encodeURIComponent(ctx.agentId)}`;
  const root = el('div', { class: 'bots-mact', 'data-section': 'memory-activity' });
  host.append(root);

  let destroyed = false, loading = true, error = '', data = null, generation = 0, busy = '', notice = '';
  const draft = { search: '', forget: '' };
  let results = null, searchError = '', opened = null, openedError = '', forgetError = '';

  async function load() {
    const mine = ++generation;
    if (!data) { loading = true; draw(); }
    error = '';
    try {
      const next = await api(`${base}/memory/activity`, { toast: false });
      if (destroyed || mine !== generation) return;
      data = next;
    } catch (failure) {
      if (destroyed || mine !== generation) return;
      error = messageOf(failure);
    }
    loading = false;
    draw();
  }

  async function tidyNow() {
    if (busy) return;
    busy = 'tidy'; notice = '';
    draw();
    try {
      await ctx.flush?.();
      await api(`${base}/memory/tidy`, { method: 'POST', toast: false, body: JSON.stringify({}) });
      notice = 'Tidying now. The result shows here in a moment.';
      setTimeout(() => { if (!destroyed) load(); }, 1500);
    } catch (failure) { notice = messageOf(failure); }
    finally { busy = ''; if (!destroyed) draw(); }
  }

  async function search() {
    const query = recallQuery(draft.search);
    if (!query) { searchError = 'Type a few words to look for.'; results = null; draw(); return; }
    busy = 'search'; searchError = ''; opened = null; openedError = '';
    draw();
    try {
      const found = await api(`${base}/recall?${query}&limit=12`, { toast: false });
      if (destroyed) return;
      results = found;
    } catch (failure) { if (!destroyed) { searchError = messageOf(failure); results = null; } }
    finally { busy = ''; if (!destroyed) draw(); }
  }

  async function openMessage(result) {
    openedError = ''; opened = { ref: result.ref, loading: true };
    draw();
    try {
      const message = await api(`${base}/recall/messages/${encodeURIComponent(result.ref)}`, { toast: false });
      if (!destroyed && opened?.ref === result.ref) opened = { ref: result.ref, text: message.text, truncated: message.truncated };
    } catch (failure) { if (!destroyed) { openedError = messageOf(failure); opened = null; } }
    if (!destroyed) draw();
  }

  async function forget() {
    const problem = forgetTermProblem(draft.forget);
    if (problem) { forgetError = problem; draw(); return; }
    const term = draft.forget.trim().replace(/\s+/g, ' ');
    if (!await confirmDialog({ title: `Forget "${term}"?`, message: 'Every note, topic, archive entry and About you line that mentions it is removed, and bots will not keep it again.', confirmLabel: 'Forget' })) return;
    busy = 'forget'; forgetError = ''; notice = '';
    draw();
    try {
      await ctx.flush?.();
      const done = await api(`${base}/memory/forget`, { method: 'POST', toast: false, body: JSON.stringify({ term }) });
      draft.forget = '';
      results = null;
      notice = `Forgot "${done.term}": ${done.notebook_lines} note lines, ${done.learned_facts} learned facts, ${done.about_lines} About you lines.`;
      await ctx.refresh?.();
      await load();
    } catch (failure) { if (!destroyed) forgetError = messageOf(failure); }
    finally { busy = ''; if (!destroyed) draw(); }
  }

  function reportBlock(report, empty) {
    if (!report) return el('p', { class: 'bots-mact-empty', text: empty });
    const rows = reportRows(report);
    return el('div', { class: 'bots-mact-report' }, [
      el('div', { class: 'bots-mact-when', text: reportTitle(report) }),
      nothingHappened(report) && !report.note
        ? el('div', { class: 'bots-mact-line', text: 'Nothing needed changing.' })
        : el('dl', { class: 'bots-mact-rows' }, rows.flatMap(r => [el('dt', { text: r.label }), el('dd', { text: r.value })])),
    ]);
  }

  function draw() {
    if (destroyed) return;
    const state = memoryState(data);
    const body = [];
    if (loading) body.push(el('p', { class: 'bots-mact-empty', role: 'status', text: 'Loading what the bot has been doing with its notes.' }));
    else if (error) body.push(el('div', { class: 'bots-mact-error', role: 'alert' }, [
      el('span', { text: error }), Button({ label: 'Retry', onClick: () => load() })]));
    else if (data) {
      if (state.text) body.push(el('div', { class: `bots-mact-state ${state.kind}`, role: 'status' }, [icon(state.kind === 'off' ? 'info' : 'triangle-alert', { size: 16 }), el('span', { text: state.text })]));
      if (notice) body.push(el('p', { class: 'bots-mact-notice', role: 'status', text: notice }));
      const pending = pendingLine(data);
      body.push(Card({ label: 'Tidy', children: [
        reportBlock(data.report, state.kind === 'off' ? 'It is not tidying while memory is off.' : `Nothing tidied yet. It tidies once a day after ${data.tidy_time || '03:00'}.`),
        pending ? el('p', { class: 'bots-mact-line', text: pending }) : null,
        el('div', { class: 'bots-mact-actions' }, [Button({ label: busy === 'tidy' ? 'Tidying' : 'Tidy now', iconName: 'sparkles',
          disabled: !!busy || !data.upkeep || state.kind === 'off', onClick: tidyNow })]),
      ] }));
      body.push(Card({ label: 'Noticed in chats', children: [reportBlock(data.capture, 'Nothing noticed yet. It looks after a chat goes quiet.')] }));
      body.push(Card({ label: 'Looked back', children: [
        reportBlock(data.dream?.report, 'No look back yet. It needs two chats, and each bot gets its day.'),
      ] }));
      const ideas = liveIdeas(data.ideas);
      body.push(Card({ label: 'Ideas for you', children: ideas.length
        ? ideas.map(idea => el('div', { class: 'bots-mact-idea' }, [
          el('div', { class: 'bots-mact-idea-title', text: idea.title }),
          el('div', { class: 'bots-mact-line', text: idea.text }),
          el('div', { class: 'bots-mact-when', text: `${idea.kind === 'skill' ? 'A skill' : 'A routine'} idea, ${ideaLeft(idea)}. Nothing is made until you ask.` }),
        ]))
        : [el('p', { class: 'bots-mact-empty', text: 'No ideas right now. They appear after a look back and last a day.' })] }));
    }
    body.push(searchCard(), forgetCard());
    root.replaceChildren(...body);
  }

  function searchCard() {
    const input = el('input', { type: 'search', class: 'bots-mact-input', placeholder: 'Search its notes and past chats', 'aria-label': 'Search its notes and past chats', maxlength: '600' });
    input.value = draft.search;
    input.addEventListener('input', () => { draft.search = input.value; });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
    const list = results
      ? (results.disabled ? [el('p', { class: 'bots-mact-empty', text: 'Memory is off, so there is nothing to search.' })]
        : results.results.length ? results.results.map(result => {
          const cite = citation(result);
          const row = el('div', { class: 'bots-mact-result', 'data-ref': cite.ref }, [
            el('div', { class: 'bots-mact-cite', text: cite.label }),
            el('div', { class: 'bots-mact-snippet', text: result.text }),
          ]);
          if (result.kind === 'conversation' || result.kind === 'memory') {
            row.append(Button({ label: opened?.ref === cite.ref ? 'Hide' : 'Open', onClick: () => (opened?.ref === cite.ref ? (opened = null, draw()) : openMessage(result)) }));
          }
          if (opened?.ref === cite.ref) {
            row.append(el('div', { class: 'bots-mact-opened', text: opened.loading ? 'Loading.' : `${opened.text}${opened.truncated ? ' (cut short)' : ''}` }));
          }
          return row;
        }) : [el('p', { class: 'bots-mact-empty', text: 'Nothing found. Try other words.' })])
      : [];
    return Card({ label: 'Look something up', children: [
      el('div', { class: 'bots-mact-form' }, [input, Button({ label: 'Search', iconName: 'search', disabled: !!busy, onClick: search })]),
      searchError ? el('p', { class: 'bots-mact-error-line', role: 'alert', text: searchError }) : null,
      openedError ? el('p', { class: 'bots-mact-error-line', role: 'alert', text: openedError }) : null,
      ...list,
    ] });
  }

  function forgetCard() {
    const input = el('input', { type: 'text', class: 'bots-mact-input', placeholder: 'A name or word to forget', 'aria-label': 'A name or word to forget', maxlength: '60' });
    input.value = draft.forget;
    input.addEventListener('input', () => { draft.forget = input.value; });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); forget(); } });
    return Card({ label: 'Forget', children: [
      el('p', { class: 'bots-mact-line', text: 'Removes every mention of a word from this bot\'s notes, topics, archive and About you.' }),
      el('div', { class: 'bots-mact-form' }, [input, Button({ label: 'Forget', iconName: 'trash-2', variant: 'danger', disabled: !!busy, onClick: forget })]),
      forgetError ? el('p', { class: 'bots-mact-error-line', role: 'alert', text: forgetError }) : null,
    ] });
  }

  load();
  return {
    destroy() { destroyed = true; generation++; root.remove(); },
    refresh() { return load(); },
    flush() { return Promise.resolve(); },
  };
}
