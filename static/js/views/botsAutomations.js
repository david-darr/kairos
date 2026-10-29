// Bots Automations page (Agents 3.0 Phase 3, unit U3). Spec: phase-3-design.md sections 6, 7 and 8 (U3); OMB F55, F56, 3.8.
// Styled by static/css/bots-automations.css and static/css/bots-automation-calendar.css (scoped to [data-app-mode="bots"]).
//
// One page for every way a bot starts work on its own: routines (on a schedule), webhooks (when another app calls) and
// app events (when something happens in a connected app). View contract: render(container, tabId, options) returns a cleanup
// function. Options: botId (filter to one bot), select (a routine id or a row key to open), mode ('list' | 'calendar').
//
// Data comes from the Phase 3 API (design section 6): GET /api/bot-automations is the unified list; the calendar asks
// GET /api/bot-routines?from&to for its range; the editors and buttons write through /api/bot-routines*,
// /api/triggers, /api/bot-app-triggers, /api/bot-webhooks. The page never works out when anything runs.
// Needs-you rows offer exactly one fix. A new automation is either a plain message to the chosen bot or a manual editor.
import { api, toast, confirmDialog, openPanelDialog } from '../api.js';
import { agentAvatar } from '../agentAvatar.js';
import { loadBotsCss, applyBotsInterface, Segmented, openMenu, withBotColor } from '../botsUi.js';
import { icon } from '../botsIcons.js';
import { visibleBots } from '../botsRail.js';
import { buildItems, filterItems, showBotFilter, needsYouCount, normalizeRoutine, normalizeRun, whenText, whenMid, relative, firstLine, refusalOf,
  RECENT_RUNS, RUN_WORDS, toMs } from '../botsAutomationModel.js';
import { mountWebhookDetails, mountAppEventDetails, runFix } from '../botsAutomationEvents.js';
import { mountWarnings, currentReading } from '../botsLimitReset.js';

const SHEET = '/static/css/bots-automations.css';
const CAL_CSS = '/static/css/bots-automation-calendar.css';
const MODE_KEY = 'kairos:bots-automations-view';
const POLL_MS = 10000;

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}
const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
const stored = () => { try { return localStorage.getItem(MODE_KEY) || ''; } catch { return ''; } };
const store = value => { try { localStorage.setItem(MODE_KEY, value); } catch { /* a per-device nicety */ } };
const isPhone = () => matchMedia('(max-width: 767px)').matches;
const send = (path, method, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body), toast: false });

export async function render(container, tabId, options = {}) {
  await Promise.all([loadBotsCss(SHEET), loadBotsCss(CAL_CSS)]);
  applyBotsInterface();
  container.classList.add('bots-auto-view');
  const control = new AbortController();
  const state = {
    bots: [], raw: [], items: [], mode: options.mode || stored() || 'list', botId: options.botId || '', selected: options.select || '', version: 0, disposed: false,
    loaded: false, failed: false, composerOpen: false, restore: null, signature: '', details: null, calendar: null, previewCache: new Map(),
  };
  if (!['list', 'calendar'].includes(state.mode)) state.mode = 'list';
  const botName = id => state.bots.find(b => b.id === id)?.name || '';
  const botById = id => state.bots.find(b => b.id === id);

  // ---- shell
  const title = h('h1', { class: 'bots-auto-title', text: 'Automations' });
  const count = h('span', { class: 'bots-auto-count', 'aria-live': 'polite' });
  const botFilter = h('select', { class: 'bots-auto-filter', 'aria-label': 'Show automations for', hidden: '' });
  const modeSwitch = Segmented({ label: 'View', value: state.mode, options: [{ value: 'list', label: 'List' }, { value: 'calendar', label: 'Calendar' }], onChange: setMode });
  modeSwitch.classList.add('bots-auto-mode');
  const newButton = h('button', { type: 'button', class: 'bots-btn primary bots-auto-new', 'aria-expanded': 'false' }, [icon('plus', { size: 16 }), 'New automation']);
  const head = h('header', { class: 'bots-auto-head' }, [h('div', { class: 'bots-auto-heading' }, [title, count]), h('div', { class: 'bots-auto-tools' }, [botFilter, modeSwitch, newButton])]);
  const limitHost = h('div', { class: 'bots-auto-limit' });
  const composer = h('section', { class: 'bots-auto-composer', 'aria-label': 'New automation', hidden: '' });
  const banner = h('div', { class: 'bots-auto-banner', role: 'status', hidden: '' });
  const main = h('div', { class: 'bots-auto-main' });
  const details = h('aside', { class: 'bots-auto-details', 'aria-label': 'Automation details', hidden: '' });
  const body = h('div', { class: 'bots-auto-body', 'data-mode': state.mode }, [main, details]);
  container.replaceChildren(h('div', { class: 'bots-auto' }, [head, limitHost, composer, banner, body]));

  // ---- data
  async function load() {
    const at = ++state.version;
    const query = state.botId ? `?bot_id=${encodeURIComponent(state.botId)}` : '';
    try {
      const [bots, data] = await Promise.all([
        api('/api/agents', { toast: false }).then(visibleBots).catch(() => state.bots),
        api(`/api/bot-automations${query}`, { signal: control.signal, toast: false }),
      ]);
      if (state.disposed || at !== state.version) return;
      state.bots = bots;
      state.raw = Array.isArray(data) ? data : data?.items || data?.automations || [];
      state.failed = false;
    } catch (error) {
      if (state.disposed || at !== state.version || error?.name === 'AbortError') return;
      if (!state.loaded) state.failed = true;
    }
    state.loaded = true;
    state.items = buildItems(state.raw, { botName });
    draw();
  }

  const signatureOf = () => JSON.stringify([state.mode, state.botId, state.selected, state.items.map(i => [i.key, i.status, i.enabled, i.sentence, i.timing, i.trouble?.reason, i.routine?.revision, i.routine?.runs.map(r => [r.id, r.status, r.seen])]), state.bots.map(b => [b.id, b.name])]);

  function draw() {
    if (state.disposed) return;
    const shown = filterItems(state.items, state.botId);
    const next = signatureOf();
    drawHead(shown);
    drawFilter();
    if (state.mode === 'list') {
      if (next !== state.signature || !main.querySelector('.bots-auto-list, .bots-auto-empty, .bots-auto-message')) drawList(shown);
    } else if (!state.calendar) drawCalendar();
    state.signature = next;
    drawDetails();
    state.warnings?.refresh();
  }

  function drawHead(shown) {
    const needs = needsYouCount(shown);
    count.textContent = !state.loaded ? '' : shown.length ? `${shown.length} ${shown.length === 1 ? 'automation' : 'automations'}${needs ? `, ${needs} need${needs === 1 ? 's' : ''} you` : ''}` : '';
    modeSwitch.querySelectorAll('button').forEach(b => { const on = b.dataset.value === state.mode; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
    body.dataset.mode = state.mode;
  }

  function drawFilter() {
    const show = showBotFilter(state.items.length, state.bots.length) || !!state.botId;
    botFilter.hidden = !show || state.bots.length < 2;
    if (botFilter.hidden) return;
    const options = [{ value: '', label: 'All bots' }, ...state.bots.map(b => ({ value: b.id, label: b.name }))];
    const signature = JSON.stringify(options);
    if (botFilter.dataset.signature !== signature) {
      botFilter.dataset.signature = signature;
      botFilter.replaceChildren(...options.map(o => h('option', { value: o.value, text: o.label })));
    }
    botFilter.value = state.botId;
  }
  botFilter.addEventListener('change', () => { state.botId = botFilter.value; state.signature = ''; state.calendar?.refresh(); load(); });

  // ---- list
  function row(item) {
    const bot = botById(item.botId) || { id: item.botId, name: item.botName };
    const selected = state.selected === item.key;
    const sw = h('button', { type: 'button', role: 'switch', class: 'bots-switch', 'aria-checked': item.enabled ? 'true' : 'false', 'aria-label': `${item.name} on` });
    sw.addEventListener('click', event => { event.stopPropagation(); toggle(item, sw); });
    const fix = item.status === 'needs_you' && item.trouble?.fix
      ? h('button', { type: 'button', class: 'bots-btn bots-auto-fix', text: item.trouble.fix.label, 'aria-label': `${item.trouble.fix.label}: ${item.name}`, onclick: event => { event.stopPropagation(); runFix(item, fixContext()); } })
      : null;
    const open = h('button', { type: 'button', class: 'bots-auto-row-main', 'aria-pressed': selected ? 'true' : 'false', onclick: () => select(item.key) }, [
      agentAvatar(bot, 28),
      h('span', { class: 'bots-auto-row-text' }, [
        h('span', { class: 'bots-auto-row-sentence', text: item.sentence }),
        h('span', { class: 'bots-auto-row-timing', text: item.timing }),
      ]),
    ]);
    const status = h('span', { class: 'bots-auto-status', 'data-status': item.status }, [h('span', { class: 'bots-auto-dot', 'aria-hidden': 'true' }), item.statusWord]);
    const node = h('li', { class: 'bots-auto-row', 'data-key': item.key, 'data-kind': item.kind, 'data-status': item.status, 'aria-current': selected ? 'true' : undefined }, [open, status, fix, sw]);
    return withBotColor(node, bot.color);
  }

  function drawList(shown) {
    if (state.failed) { main.replaceChildren(h('p', { class: 'bots-auto-message', role: 'alert', text: 'Automations could not load. Try opening this page again.' })); return; }
    if (!state.loaded) { main.replaceChildren(h('p', { class: 'bots-auto-message', role: 'status', text: 'Loading...' })); return; }
    const focused = document.activeElement?.closest?.('.bots-auto-row')?.dataset.key;
    const focusedSwitch = document.activeElement?.matches?.('.bots-switch') && !!focused;
    if (!shown.length) {
      main.replaceChildren(h('div', { class: 'bots-auto-empty' }, [
        h('h2', { text: state.botId ? 'Nothing yet for this bot' : 'No automations yet' }),
        h('p', { text: 'An automation lets a bot work on its own: on a schedule, when an app calls, or when something happens in a connected app.' }),
        h('button', { type: 'button', class: 'bots-btn primary', text: 'New automation', onclick: () => toggleComposer(true) }),
      ]));
      return;
    }
    main.replaceChildren(h('ul', { class: 'bots-auto-list', role: 'list', 'aria-label': 'Automations' }, shown.map(row)));
    if (focused) {
      const target = main.querySelector(`.bots-auto-row[data-key="${CSS.escape(focused)}"]`);
      (focusedSwitch ? target?.querySelector('.bots-switch') : target?.querySelector('.bots-auto-row-main'))?.focus({ preventScroll: true });
    }
  }

  async function toggle(item, sw) {
    const next = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', next ? 'true' : 'false');
    try {
      if (item.kind === 'routine') await send(`/api/bot-routines/${encodeURIComponent(item.id)}`, 'PATCH', { enabled: next, expected_revision: String(item.routine.revision) });
      else if (item.kind === 'webhook') await send(`/api/triggers/${encodeURIComponent(item.id)}`, 'PATCH', { enabled: next });
      else await send(`/api/bot-app-triggers/${encodeURIComponent(item.id)}`, 'PATCH', { enabled: next });
    } catch (error) {
      sw.setAttribute('aria-checked', next ? 'false' : 'true');
      toast(refusalOf(error).status === 409 ? 'That changed somewhere else. Reloaded.' : refusalOf(error).message, 'error');
    }
    await refreshAll();
  }

  // ---- selection and the details panel
  function select(key) {
    state.selected = key;
    state.signature = '';
    state.details = null;
    draw();
    state.calendar?.selectionChanged();
    if (isPhone()) details.querySelector('.bots-auto-details-back')?.focus();
  }
  const selectedItem = () => state.items.find(i => i.key === state.selected) || null;

  function drawDetails() {
    const item = selectedItem();
    if (!item) {
      details.hidden = true; details.dataset.open = 'false';
      if (state.details) { state.details.dispose?.(); state.details = null; }
      return;
    }
    const signature = JSON.stringify([item.key, item.status, item.enabled, item.sentence, item.timing, item.trouble?.reason, item.routine?.revision, item.routine?.runs.map(r => [r.id, r.status, r.seen]), item.trigger?.revision]);
    if (state.details?.signature === signature) return;
    const hadFocus = details.contains(document.activeElement) ? document.activeElement.dataset.action : '';
    state.details?.dispose?.();
    details.hidden = false; details.dataset.open = 'true';
    state.details = buildDetails(item);
    state.details.signature = signature;
    if (hadFocus) details.querySelector(`[data-action="${hadFocus}"]`)?.focus({ preventScroll: true });
  }

  function buildDetails(item) {
    const bot = botById(item.botId) || { id: item.botId, name: item.botName };
    const children = [], disposers = [];
    const close = h('button', { type: 'button', class: 'bots-icon-btn bots-auto-details-back', 'aria-label': 'Close details', onclick: () => { state.selected = ''; state.signature = ''; draw(); state.calendar?.selectionChanged(); } }, [icon(isPhone() ? 'arrow-left' : 'x', { size: 18 })]);
    const mark = h('span', { class: 'bots-auto-status', 'data-status': item.status }, [h('span', { class: 'bots-auto-dot', 'aria-hidden': 'true' }), item.statusWord]);
    children.push(h('div', { class: 'bots-auto-details-head' }, [close, agentAvatar(bot, 32), h('div', { class: 'bots-auto-details-title' }, [h('h2', { text: item.name }), h('p', { text: bot.name })]), mark]));
    if (item.trouble) {
      children.push(h('div', { class: 'bots-auto-trouble', role: 'status' }, [
        h('span', { text: item.trouble.reason }),
        item.trouble.fix ? h('button', { type: 'button', class: 'bots-btn', 'data-action': 'fix', text: item.trouble.fix.label, onclick: () => runFix(item, fixContext()) }) : null,
      ]));
    }
    children.push(h('p', { class: 'bots-auto-details-sentence', text: item.sentence }));
    const live = h('p', { class: 'bots-auto-details-live', 'aria-live': 'polite', text: item.timing });
    children.push(live);
    const slot = h('div', { class: 'bots-auto-details-slot' });
    if (item.kind === 'webhook') disposers.push(mountWebhookDetails(slot, item, { refresh: refreshAll, signal: control.signal }));
    if (item.kind === 'app') disposers.push(mountAppEventDetails(slot, item, { refresh: refreshAll, signal: control.signal }));
    const prompt = item.routine?.prompt || item.trigger?.prompt_template || item.trigger?.instructions || '';
    if (prompt) children.push(h('section', { class: 'bots-auto-block' }, [h('h3', { class: 'bots-caps', text: 'Instructions' }), h('p', { class: 'bots-auto-instructions', text: prompt })]));
    if (item.routine) {
      const next = h('ul', { class: 'bots-auto-next', 'aria-label': 'Next times' });
      children.push(h('section', { class: 'bots-auto-block' }, [h('h3', { class: 'bots-caps', text: 'Next times' }), next]));
      loadNext(item, next);
      children.push(runsBlock(item));
    }
    children.push(slot);
    children.push(h('div', { class: 'bots-auto-actions' }, buttonsFor(item)));
    const node = h('div', { class: 'bots-auto-details-body' }, children);
    details.replaceChildren(node);
    return { dispose() { disposers.forEach(d => d?.dispose?.()); } };
  }

  async function loadNext(item, list) {
    const r = item.routine;
    const key = `${r.id}:${r.revision}:${r.nextRunAt}`;
    let times = state.previewCache.get(key);
    if (!times) {
      try {
        const result = await send('/api/bot-routines/preview', 'POST', { schedule: r.schedule });
        times = (result.next || result.next_runs || []).map(toMs).filter(v => v !== null).slice(0, 3);
        state.previewCache.set(key, times);
      } catch { times = r.nextRunAt ? [r.nextRunAt] : []; }
    }
    if (state.disposed || !list.isConnected) return;
    list.replaceChildren(...(times.length ? times.map(ms => h('li', { text: whenText(ms) })) : [h('li', { class: 'bots-auto-none', text: r.enabled ? 'Nothing is scheduled.' : 'Paused.' })]));
  }

  function runsBlock(item) {
    const runs = item.routine.runs.slice(0, RECENT_RUNS);
    const list = h('ul', { class: 'bots-auto-runs', 'aria-label': 'Recent runs' });
    if (!runs.length) list.append(h('li', { class: 'bots-auto-none', text: 'No runs yet.' }));
    for (const run of runs) {
      const open = h('button', { type: 'button', class: 'bots-auto-run-open', 'data-run-id': run.id, 'data-status': run.status, disabled: !run.threadId || undefined,
        'aria-label': `${RUN_WORDS[run.status] || run.status}, ${relative(run.startedAt ?? run.scheduledAt)}. Open the conversation.`,
        onclick: () => openThread(item.botId, run.threadId) }, [
        h('span', { class: 'bots-auto-run-word', text: RUN_WORDS[run.status] || run.status }),
        h('span', { class: 'bots-auto-run-when', text: relative(run.startedAt ?? run.scheduledAt) }),
        run.summary || run.error ? h('span', { class: 'bots-auto-run-summary', text: firstLine(run.error || run.summary, 140) }) : null,
      ]);
      const actions = [];
      if (['running', 'waiting', 'queued'].includes(run.status)) actions.push(h('button', { type: 'button', class: 'bots-btn', text: run.status === 'waiting' ? 'Review' : 'Cancel run', 'data-action': `run-${run.id}`,
        onclick: () => run.status === 'waiting' ? openThread(item.botId, run.threadId) : cancelRun(run) }));
      else if (run.attention) actions.push(h('button', { type: 'button', class: 'bots-btn', text: 'Mark seen', 'data-action': `seen-${run.id}`, onclick: () => markSeen(run) }));
      list.append(h('li', { class: 'bots-auto-run', 'data-status': run.status }, [open, ...actions]));
    }
    return h('section', { class: 'bots-auto-block' }, [h('h3', { class: 'bots-caps', text: 'Recent runs' }), list]);
  }

  function buttonsFor(item) {
    const out = [];
    out.push(h('button', { type: 'button', class: 'bots-btn primary', 'data-action': 'run', onclick: () => runNow(item) }, [icon('zap', { size: 16 }), 'Run now']));
    out.push(h('button', { type: 'button', class: 'bots-btn', 'data-action': 'pause', text: item.enabled ? 'Pause' : 'Resume', onclick: () => setEnabled(item, !item.enabled) }));
    out.push(h('button', { type: 'button', class: 'bots-btn', 'data-action': 'edit', onclick: () => edit(item) }, [icon('pencil', { size: 16 }), 'Edit']));
    out.push(h('button', { type: 'button', class: 'bots-btn danger', 'data-action': 'delete', onclick: () => remove(item) }, [icon('trash-2', { size: 16 }), 'Delete']));
    return out;
  }

  // ---- actions
  async function refreshAll() { await load(); state.calendar?.refresh(); }

  function fixContext() { return { openThread, go, edit, refresh: refreshAll }; }

  function openThread(botId, threadId) {
    if (!threadId) { toast('That run has no conversation to open.', 'error'); return; }
    go('botsShell', { agentId: botId, sessionId: threadId });
  }

  async function runNow(item) {
    try {
      if (item.kind === 'routine') await send(`/api/bot-routines/${encodeURIComponent(item.id)}/run`, 'POST', { request_id: crypto.randomUUID() });
      else if (item.kind === 'webhook') await send(`/api/bot-webhooks/${encodeURIComponent(item.id)}/test`, 'POST');
      else await send(`/api/bot-app-triggers/${encodeURIComponent(item.id)}/test`, 'POST');
      toast('Started', 'success');
    } catch (error) { toast(refusalOf(error).message, 'error'); }
    await refreshAll();
  }

  async function setEnabled(item, enabled) {
    try {
      if (item.kind === 'routine') await send(`/api/bot-routines/${encodeURIComponent(item.id)}`, 'PATCH', { enabled, expected_revision: String(item.routine.revision) });
      else if (item.kind === 'webhook') await send(`/api/triggers/${encodeURIComponent(item.id)}`, 'PATCH', { enabled });
      else await send(`/api/bot-app-triggers/${encodeURIComponent(item.id)}`, 'PATCH', { enabled });
    } catch (error) { toast(refusalOf(error).status === 409 ? 'That changed somewhere else. Reloaded.' : refusalOf(error).message, 'error'); }
    await refreshAll();
  }

  async function edit(item, opener = document.activeElement) {
    const editor = await import('../botsAutomationEditor.js');
    const onSaved = () => refreshAll();
    if (item.kind === 'routine') editor.openRoutineEditor({ id: item.id, agentId: item.botId, routine: item.routine, onSaved, opener });
    else if (item.kind === 'webhook') editor.openTriggerEditor({ id: item.id, agentId: item.botId, onSaved, opener });
    else editor.openAppEventEditor({ id: item.id, agentId: item.botId, onSaved, opener });
  }

  async function remove(item) {
    const noun = item.kind === 'routine' ? 'routine' : item.kind === 'webhook' ? 'webhook' : 'app automation';
    const opener = document.activeElement;
    if (!await confirmDialog({ title: `Delete this ${noun}?`, message: `"${item.name}" will stop. You can bring it back for a little while.`, confirmLabel: 'Delete' })) { opener?.focus?.(); return; }
    try {
      const path = item.kind === 'routine' ? `/api/bot-routines/${encodeURIComponent(item.id)}`
        : item.kind === 'webhook' ? `/api/triggers/${encodeURIComponent(item.id)}` : `/api/bot-app-triggers/${encodeURIComponent(item.id)}`;
      const result = await send(path, 'DELETE', item.kind === 'routine' ? { expected_revision: String(item.routine.revision) } : undefined);
      state.selected = '';
      showRestore({ item, receiptId: result?.receipt_id || '' });
    } catch (error) { toast(refusalOf(error).message, 'error'); }
    await refreshAll();
  }

  function showRestore({ item, receiptId }) {
    state.restore = { item, receiptId };
    clearTimeout(state.restoreTimer);
    banner.hidden = false;
    banner.replaceChildren(h('span', { text: `Deleted "${item.name}".` }), h('button', { type: 'button', class: 'bots-btn', text: 'Bring it back', 'data-action': 'restore', onclick: restore }));
    state.restoreTimer = setTimeout(hideRestore, 30000);
  }
  function hideRestore() { state.restore = null; banner.hidden = true; banner.replaceChildren(); }
  async function restore() {
    const { item, receiptId } = state.restore || {};
    if (!item) return;
    try {
      if (item.kind === 'routine' && receiptId) await send(`/api/bot-automation-changes/${encodeURIComponent(receiptId)}/undo`, 'POST');
      else if (item.kind === 'routine') await send(`/api/bot-routines/${encodeURIComponent(item.id)}/restore`, 'POST');
      else if (item.kind === 'app') await send(`/api/bot-app-triggers/${encodeURIComponent(item.id)}/restore`, 'POST');
      else if (item.kind === 'webhook') await send(`/api/bot-webhooks/${encodeURIComponent(item.id)}/restore`, 'POST');
      else throw new Error('There is nothing to bring back.');
      toast('Brought back', 'success');
      hideRestore();
    } catch (error) { toast(refusalOf(error).message || 'That could not be brought back.', 'error'); }
    await refreshAll();
  }

  async function cancelRun(run) {
    try { await send(`/api/bot-routine-runs/${encodeURIComponent(run.id)}/cancel`, 'POST'); toast('Cancelled', 'success'); }
    catch (error) { toast(refusalOf(error).message, 'error'); }
    await refreshAll();
  }
  async function markSeen(run) {
    try { await send(`/api/bot-routine-runs/${encodeURIComponent(run.id)}/seen`, 'POST'); } catch (error) { toast(refusalOf(error).message, 'error'); }
    await refreshAll();
  }

  // ---- new automation
  function toggleComposer(open) {
    state.composerOpen = open ?? !state.composerOpen;
    newButton.setAttribute('aria-expanded', state.composerOpen ? 'true' : 'false');
    composer.hidden = !state.composerOpen;
    if (!state.composerOpen) return;
    if (!composer.childElementCount) buildComposer();
    composer.querySelector('textarea')?.focus();
  }
  newButton.addEventListener('click', () => toggleComposer());

  function buildComposer() {
    const text = h('textarea', { rows: '3', class: 'bots-auto-say', 'aria-label': 'Say what should happen', placeholder: 'Say what should happen, like "Every weekday at 9, summarize my inbox".' });
    const who = h('select', { class: 'bots-auto-who', 'aria-label': 'Which bot' }, state.bots.map(b => h('option', { value: b.id, text: b.name })));
    if (state.botId && state.bots.some(b => b.id === state.botId)) who.value = state.botId;
    const problem = h('p', { class: 'bots-ed-error', role: 'alert', hidden: '' });
    const sendButton = h('button', { type: 'button', class: 'bots-btn primary', 'data-action': 'say' }, [icon('send', { size: 16 }), 'Send']);
    const manual = h('button', { type: 'button', class: 'bots-btn bots-auto-manual', text: 'Set it up yourself', 'aria-haspopup': 'menu' });
    async function say() {
      const message = text.value.trim();
      if (!message) { problem.hidden = false; problem.textContent = 'Say what should happen first.'; text.setAttribute('aria-invalid', 'true'); text.focus(); return; }
      text.removeAttribute('aria-invalid'); problem.hidden = true; sendButton.disabled = true;
      try {
        const data = await api(`/api/agents/${encodeURIComponent(who.value)}/threads`, { toast: false });
        // A bot that has never been talked to has no conversation yet: start its first one.
        const sessionId = data?.main_id || data?.threads?.[0]?.id
          || (await send(`/api/agents/${encodeURIComponent(who.value)}/threads`, 'POST', {}))?.id;
        if (!sessionId) throw new Error('That bot has no conversation to message.');
        const { startTurn } = await import('../chatStream.js');
        startTurn(sessionId, 'Chat', message, []);
        go('botsShell', { agentId: who.value, sessionId });
      } catch (error) { problem.hidden = false; problem.textContent = refusalOf(error).message; sendButton.disabled = false; }
    }
    sendButton.addEventListener('click', say);
    text.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); say(); } });
    manual.addEventListener('click', () => openMenu(manual, [
      { label: 'On a schedule', iconName: 'calendar-clock', onSelect: () => newManual('routine') },
      { label: 'When something happens in an app', iconName: 'plug', onSelect: () => newManual('app') },
      { label: 'When another app calls', iconName: 'zap', onSelect: () => newManual('webhook') },
    ]));
    composer.replaceChildren(text, h('div', { class: 'bots-auto-composer-row' }, [who, manual, sendButton]), problem);
  }

  async function newManual(kind, prefill = null) {
    const editor = await import('../botsAutomationEditor.js');
    const onSaved = ({ id, kind: saved }) => { state.selected = `${saved}:${id}`; state.signature = ''; toggleComposer(false); refreshAll(); };
    const agentId = state.botId || state.bots[0]?.id || '';
    const opener = newButton;
    if (kind === 'routine') editor.openRoutineEditor({ agentId, onSaved, prefill, opener });
    else if (kind === 'app') editor.openAppEventEditor({ agentId, onSaved, opener });
    else editor.openTriggerEditor({ agentId, onSaved, opener });
  }

  // ---- calendar
  function setMode(value) {
    state.mode = value; store(value); state.signature = '';
    if (value === 'list') { state.calendar?.dispose(); state.calendar = null; main.replaceChildren(); }
    draw();
  }

  async function fetchRange(from, to, botId) {
    const query = `start=${from / 1000}&end=${to / 1000}${botId ? `&bot_id=${encodeURIComponent(botId)}` : ''}`;
    const data = await api(`/api/bot-routines?${query}`, { signal: control.signal, toast: false });
    const list = (Array.isArray(data) ? data : data?.routines || []).map(normalizeRoutine).filter(Boolean);
    const runs = [...(data?.runs || []).map(normalizeRun), ...list.flatMap(r => r.runs.map(run => ({ ...run, routineId: run.routineId || r.id })))].filter(Boolean);
    const seen = new Set();
    const unique = runs.filter(run => { const key = run.id || `${run.routineId}:${run.startedAt}`; if (seen.has(key)) return false; seen.add(key); return true; });
    return { routines: list, occurrences: Array.isArray(data?.occurrences) ? data.occurrences : (data?.routines || []).flatMap(r => (r.occurrences || []).map(o => ({ ...(typeof o === 'string' ? { at: o } : o), routine_id: r.id }))), runs: unique };
  }

  async function patchRoutine(routine, patch) {
    try { await send(`/api/bot-routines/${encodeURIComponent(routine.id)}`, 'PATCH', { ...patch, expected_revision: String(routine.revision) }); }
    catch (error) { toast(refusalOf(error).status === 409 ? 'That changed somewhere else. Reloaded.' : refusalOf(error).message, 'error'); throw error; }
    await load();
  }
  async function deferRoutine(routine, until) {
    try { await send(`/api/bot-routines/${encodeURIComponent(routine.id)}/defer`, 'POST', { until, expected_revision: String(routine.revision) }); }
    catch (error) { toast(refusalOf(error).message, 'error'); throw error; }
    await load();
  }

  // A small dialog with named choices; resolves to the chosen value or null.
  function choose({ title: heading, message, choices, opener }) {
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (settled) return; settled = true; dialog.close(); resolve(value); };
      const buttons = choices.map(c => h('button', { type: 'button', class: `bots-btn${c.primary ? ' primary' : ''}`, 'data-choice': c.value, disabled: c.disabled || undefined, text: c.label, onclick: () => done(c.value) }));
      const cancel = h('button', { type: 'button', class: 'bots-btn', 'data-choice': 'cancel', text: 'Cancel', onclick: () => done(null) });
      const dialog = openPanelDialog({ title: heading, body: h('p', { class: 'bots-ed-hint', text: message }), footer: h('div', { class: 'bots-dialog-footer bots-choose' }, [cancel, ...buttons]),
        className: 'bots-auto-dialog bots-choose-dialog', opener, initialFocus: buttons.find(b => !b.disabled), onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    });
  }

  const confirmScope = (routine, { next }) => choose({ title: 'Move every time it repeats?', message: `"${routine.name}" repeats. Move all of its runs, or only the next one.`,
    choices: [{ value: 'all', label: 'Every time', primary: true }, { value: 'next', label: 'Only the next time', disabled: !next }], opener: document.activeElement });

  async function resetChoice(routine, marker, opener) {
    const reading = currentReading().endpoints.find(e => e.endpoint_id === marker.endpoint_id);
    const name = reading?.name || 'your AI';
    const pick = await choose({ title: 'Run after the reset?', message: `${name} resets ${whenMid(marker.at)}.`, opener,
      choices: [{ value: 'move', label: 'Move the next run to after it', primary: true }, { value: 'once', label: 'Run once after the next reset' }, { value: 'every', label: 'Run after every reset' }] });
    if (!pick) return;
    try {
      if (pick === 'move') await send('/api/bot-limit-resets/after-reset', 'POST', { routine_id: routine.id });
      else await send(`/api/bot-routines/${encodeURIComponent(routine.id)}`, 'PATCH', { schedule: { kind: 'limit_reset', endpoint_id: marker.endpoint_id, repeat: pick === 'every' ? 'every_reset' : 'once' }, expected_revision: String(routine.revision) });
      toast('Updated', 'success');
    } catch (error) { toast(refusalOf(error).message, 'error'); }
    await refreshAll();
  }

  async function drawCalendar() {
    const { mountCalendar } = await import('../botsAutomationCalendar.js');
    if (state.disposed || state.mode !== 'calendar' || state.calendar) return;
    const host = h('div', { class: 'bots-auto-calendar' });
    main.replaceChildren(host);
    state.calendar = mountCalendar(host, {
      bots: () => state.bots, botId: () => state.botId, fetchRange,
      limitResets: () => currentReading().endpoints.filter(e => e.resets_at),
      selectedKey: () => state.calendarKey || '',
      onSelect: event => { state.calendarKey = event.key; select(`routine:${event.routineId}`); },
      onEmptySlot: ({ date, time }) => newManual('routine', { date, time, repeat: 'once' }),
      patchRoutine, deferRoutine, confirmScope, resetChoice, say: message => toast(message, 'error'),
      openEditor: routine => edit({ kind: 'routine', id: routine.id, botId: routine.botId, routine }),
      avatar: (bot, size, pose) => agentAvatar(bot, size, pose), signal: control.signal,
    });
  }

  // ---- go
  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.bots-auto-dialog')) refreshAll(); }, POLL_MS);
  const onChanged = () => refreshAll();
  document.addEventListener('kairos:bots-automation-changed', onChanged);
  document.addEventListener('jarvis:agents-changed', onChanged);
  const warnings = state.warnings = await mountWarnings(limitHost, { routines: () => state.items.filter(i => i.routine).map(i => i.routine), onChanged: refreshAll, signal: control.signal });
  await load();
  if (options.select && !state.items.some(i => i.key === options.select)) {
    const byId = state.items.find(i => i.id === options.select);
    state.selected = byId ? byId.key : '';
    draw();
  }

  return () => {
    state.disposed = true; ++state.version; clearInterval(timer); clearTimeout(state.restoreTimer);
    control.abort();
    document.removeEventListener('kairos:bots-automation-changed', onChanged);
    document.removeEventListener('jarvis:agents-changed', onChanged);
    state.calendar?.dispose(); state.details?.dispose?.(); warnings?.dispose?.();
  };
}

