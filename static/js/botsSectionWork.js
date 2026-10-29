import { api as sharedApi, el as h } from './api.js';
import { loadBotsCss } from './botsUi.js';
import { loadBotsModule } from './botsPanelHost.js';
import { groupsFor, rowText, matches, updatedLabel, checkOutcome } from './botsWorkModel.js';
import { openNewTask } from './botsNewTask.js';
import { mount as mountTask } from './botsTaskPage.js';

const enc = encodeURIComponent;
export function mount(host, ctx = {}) {
  loadBotsCss('/static/css/bots-work.css');
  const api = ctx.api || sharedApi, controller = new AbortController();
  let disposed = false, sequence = 0, data = null, query = '', oldest = false, resolvedOpen = false;
  let tab = 'active', poll, checkTimer, checking = false, checkMessage = '', watch = null, sheet = null;
  const timers = new Set(), pending = new Set();
  try { tab = localStorage.getItem('kairos:bots-tasks-view') === 'next' ? 'next' : 'active'; } catch { /* device only */ }
  const root = h('section', { class: 'bots-work', 'aria-label': 'Tasks' });
  const body = h('div', { class: 'bots-work-body' }), watchHost = h('div', { class: 'bots-work-watch', hidden: tab !== 'next' });
  const notice = h('p', { class: 'bots-work-notice', role: 'status', 'aria-live': 'polite' });
  const search = h('input', { type: 'search', maxlength: '200', placeholder: 'Search tasks', 'aria-label': 'Search tasks', hidden: true });
  search.addEventListener('input', () => { query = search.value; paint(); });
  search.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); search.value = query = ''; search.hidden = true; searchButton.focus(); paint(); } });
  const active = h('button', { type: 'button', role: 'tab', text: 'Active', onclick: () => select('active') });
  const next = h('button', { type: 'button', role: 'tab', text: 'Up next', onclick: () => select('next') });
  const sort = h('button', { type: 'button', class: 'bots-btn', 'aria-label': 'Sort oldest first', text: 'Newest', onclick: () => {
    oldest = !oldest; sort.textContent = oldest ? 'Oldest' : 'Newest'; sort.setAttribute('aria-label', oldest ? 'Sort newest first' : 'Sort oldest first'); paint();
  } });
  const searchButton = h('button', { type: 'button', class: 'bots-btn', text: 'Search', onclick: () => { search.hidden = !search.hidden; if (!search.hidden) search.focus(); } });
  const tabs = h('div', { role: 'tablist', 'aria-label': 'Task lists', class: 'bots-work-tabs' }, [active, next]);
  tabs.addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); select(event.key === 'Home' ? 'active' : event.key === 'End' ? 'next' : tab === 'active' ? 'next' : 'active');
    (tab === 'active' ? active : next).focus();
  } });
  function select(value) {
    tab = value;
    try { localStorage.setItem('kairos:bots-tasks-view', value); } catch { /* memory only */ }
    paint();
  }
  const request = (path, options = {}) => api(path, { ...options, signal: controller.signal });
  const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, ms); timers.add(timer); return timer; };
  function openTask(task) {
    sheet?.dispose(); sheet = mountTask(root, { ...ctx, api, taskId: task.id, onChanged: refresh });
  }
  async function mutate(path, payload = {}, hold = false, row = null) {
    if (pending.has(path)) return;
    pending.add(path); if (row) row.inert = true;
    try {
      await request(path, { method: 'POST', body: JSON.stringify(payload) });
      if (disposed) return;
      if (hold && row) {
        row.dataset.checked = 'true';
        document.dispatchEvent(new CustomEvent('kairos:front-desk-finished', { detail: { taskId: row.dataset.taskId } }));
        await new Promise(resolve => { const t = setTimeout(resolve, 450); timers.add(t); });
      }
      if (!disposed) { notice.textContent = ''; await refresh(); }
    } catch (error) { if (!disposed) notice.textContent = error.message || 'Could not update. Try again.'; }
    finally { pending.delete(path); if (row?.isConnected) row.inert = false; if (!disposed) paint(); }
  }
  function taskRow(task) {
    const row = h('article', { class: 'bots-work-row', 'data-task-id': task.id });
    const box = h('button', { type: 'button', class: 'bots-work-checkbox', role: 'checkbox',
      'aria-checked': task.state === 'resolved' ? 'true' : 'false', 'aria-label': `${task.state === 'resolved' ? 'Reopen' : 'Mark done'}: ${task.title}`,
      text: task.state === 'resolved' ? '✓' : '', onclick: () => mutate(`/api/front-desk/tasks/${enc(task.id)}/${task.state === 'resolved' ? 'reopen' : 'resolve'}`, {}, task.state !== 'resolved', row) });
    const link = h('button', { type: 'button', class: 'bots-work-open', onclick: () => openTask(task) }, [
      h('strong', { text: task.title }), h('span', { class: `bots-work-state ${task.state}`, text: rowText(task) }),
      task.channel_tag ? h('small', { text: task.channel_tag }) : null,
    ]);
    const main = h('div', { class: 'bots-work-row-main' }, [link]);
    if (task.state === 'failed') main.append(h('button', { type: 'button', class: 'bots-btn primary', text: 'Try again',
      onclick: () => mutate(`/api/front-desk/tasks/${enc(task.id)}/again`, { turn_count: task.turn_count }, false, row) }));
    row.append(box, main); return row;
  }
  function looseRows() {
    const loose = h('section', { class: 'bots-work-loose', 'aria-label': 'Needs you' });
    for (const item of [...(data.loose?.questions || []), ...(data.loose?.approvals || [])]) {
      const title = item.title || item.description || 'Open this conversation to answer';
      if (!matches({ title }, query)) continue;
      // P3 remains the authority for card answers. Opening the conversation
      // reaches its existing card renderer rather than making a second gate.
      loose.append(h('button', { type: 'button', class: 'bots-work-loose-row', text: `${ctx.agent?.name || 'Kip'} asks: ${title}`,
        onclick: () => ctx.navigate?.('bots', { agent: ctx.agent?.id || ctx.agentId, session: item.thread_id, inbox: item.thread_id ? undefined : item.id }) }));
    }
    return loose;
  }
  function paint() {
    if (disposed) return;
    for (const [button, value] of [[active, 'active'], [next, 'next']]) { button.setAttribute('aria-selected', String(tab === value)); button.tabIndex = tab === value ? 0 : -1; }
    watchHost.hidden = tab !== 'next';
    body.replaceChildren();
    if (!data) { body.append(h('p', { text: 'Loading tasks...' })); return; }
    if (tab === 'active') {
      const groups = groupsFor(data, { query, oldest, resolvedOpen });
      if (!groups.length) body.append(h('div', { class: 'bots-work-empty' }, [h('h3', { text: query ? 'No tasks match your search.' : 'Nothing active right now.' }),
        h('p', { text: query ? 'Try a shorter search.' : 'Add a task with +, or start one from Up next.' })]));
      for (const [index, group] of groups.entries()) {
        const section = h('section', { class: 'bots-work-group', 'data-group': group.id });
        const heading = group.id === 'resolved' ? h('button', { type: 'button', class: 'bots-work-fold', text: 'Resolved',
          'aria-expanded': String(resolvedOpen), onclick: () => { resolvedOpen = !resolvedOpen; paint(); } }) : h('h3', { text: `${group.label} ${group.rows.length}` });
        section.append(h('header', {}, [heading, index === 0 ? h('small', { text: updatedLabel(data.updated_at) }) : null]));
        if (!group.folded) for (const task of group.rows) section.append(taskRow(task));
        body.append(section);
      }
      const loose = looseRows(); if (loose.children.length) body.append(loose);
    } else {
      const cards = (data.up_next || []).filter(s => matches(s, query)).sort((a, b) => (oldest ? 1 : -1) * (a.created_at - b.created_at));
      for (const suggestion of cards) {
        const row = h('article', { class: 'bots-work-suggestion', 'data-suggestion-id': suggestion.id }, [h('h3', { text: suggestion.title }), h('p', { text: suggestion.detail }),
          h('small', { text: `${suggestion.origin === 'asked' ? 'You asked' : 'Noticed'}${suggestion.source?.app ? ` · From ${suggestion.source.app === 'mail' ? 'Mail' : 'Calendar'}` : ''}` })]);
        row.append(h('div', { class: 'bots-work-actions' }, [h('button', { type: 'button', class: 'bots-btn', text: 'Hide', onclick: () => mutate(`/api/front-desk/suggestions/${enc(suggestion.id)}/hide`, {}, false, row) }),
          h('button', { type: 'button', class: 'bots-btn primary', text: 'Start', onclick: () => mutate(`/api/front-desk/suggestions/${enc(suggestion.id)}/start`, {}, false, row) })]));
        body.append(row);
      }
      if (!cards.length) body.append(h('div', { class: 'bots-work-empty' }, [h('h3', { text: query ? 'No suggestions match your search.' : 'What can I take off your plate?' }),
        h('p', { text: query ? 'Try a shorter search.' : 'Check your connected mail and calendar for work Kip can help with.' }),
        h('button', { type: 'button', class: 'bots-btn primary bots-work-show-me', text: checking ? 'Looking...' : 'Show me', disabled: checking, onclick: showMe }),
        h('p', { role: 'status', text: checkMessage })]));
      if (data.coming_up?.length) {
        const upcoming = h('section', { class: 'bots-work-coming-up' }, [h('h3', { text: 'Coming up' })]);
        for (const routine of data.coming_up) upcoming.append(h('button', { type: 'button', class: 'bots-work-loose-row',
          text: `${routine.title || routine.name || 'Routine'}${routine.next_run_at ? ` · ${new Date(routine.next_run_at * 1000).toLocaleString()}` : ''}`,
          onclick: () => ctx.navigate?.('botsAutomations', { bot_id: ctx.agent?.id || ctx.agentId, routine: routine.id }) }));
        body.append(upcoming);
      }
      loadWatch();
    }
  }
  let watchAttempted = false;
  async function loadWatch() {
    if (watchAttempted) return;
    watchAttempted = true; watchHost.textContent = 'Loading day checks...';
    try {
      const mod = await (ctx.loadWatch ? ctx.loadWatch() : loadBotsModule('section:Watch'));
      if (disposed) return;
      watchHost.replaceChildren();
      const mounted = await mod.mount(watchHost, { ...ctx, api });
      if (disposed) mounted?.dispose?.(); else watch = mounted;
    } catch { if (!disposed) watchHost.replaceChildren(h('p', { text: 'Day checks are not available yet.' })); }
  }
  async function showMe() {
    if (checking) return;
    checking = true; checkMessage = ''; paint();
    const began = Date.now();
    try {
      const before = await request('/api/front-desk/watch');
      await request('/api/front-desk/watch/run-now', { method: 'POST', body: '{}' });
      async function check() {
        if (disposed) return;
        try {
          const [, current] = await Promise.all([refresh(), request('/api/front-desk/watch')]);
          if (disposed) return;
          const message = checkOutcome({ hasSuggestions: !!data?.up_next?.length,
            finished: Number(current.last_check_at) > Number(before.last_check_at || 0) && current.state !== 'working',
            failed: current.state === 'failed' || current.last_result === 'failed', elapsed: Date.now() - began });
          if (message !== 'Looking...') { checking = false; checkMessage = message === 'found' ? '' : message; paint(); return; }
          checkTimer = setTimeout(check, 3000);
        } catch { if (!disposed) { checking = false; checkMessage = checkOutcome({ failed: true }); paint(); } }
      }
      if (!disposed) { checkMessage = 'Looking...'; paint(); checkTimer = setTimeout(check, 3000); }
    } catch { if (!disposed) { checking = false; checkMessage = checkOutcome({ failed: true }); paint(); } }
  }
  async function refresh() {
    const current = ++sequence;
    try {
      const result = await request('/api/front-desk/work?resolved=1');
      if (disposed || current !== sequence) return;
      data = result; notice.textContent = '';
      ctx.onNeedsInputCount?.(result.needs_input_count ?? (result.groups?.needs_input?.length || 0));
      root.dispatchEvent(new CustomEvent('kairos:front-desk-work', { bubbles: true, detail: result }));
      // Keep a checked row in place throughout its 450 ms hold.
      if (!pending.size) paint();
    } catch (error) {
      if (!disposed && current === sequence) { notice.textContent = error.message || 'Could not load tasks. Try again.';
        if (!data) body.replaceChildren(h('button', { type: 'button', class: 'bots-btn', text: 'Try again', onclick: refresh })); }
    }
  }
  root.append(h('header', { class: 'bots-work-toolbar' }, [tabs, sort, searchButton]), search, notice, watchHost, body,
    h('button', { type: 'button', class: 'bots-work-fab', 'aria-label': 'New task', text: '+', onclick: () => {
      sheet?.dispose(); sheet = openNewTask(root, { ...ctx, api, onCreated: (_task, info) => { select(info.saved ? 'next' : 'active'); refresh(); } });
    } }));
  host.append(root); paint(); refresh();
  function tick() { poll = later(async () => { if (!document.hidden) await refresh(); if (!disposed) tick(); }, 3000); }
  tick();
  return { refresh, dispose() {
    if (disposed) return;
    disposed = true; sequence++; controller.abort(); clearTimeout(poll); clearTimeout(checkTimer);
    for (const timer of timers) clearTimeout(timer); watch?.dispose?.(); sheet?.dispose?.(); root.remove();
  } };
}
