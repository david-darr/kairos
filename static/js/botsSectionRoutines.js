// Bots mode: the bot panel's Routines section (Agents 3.0 Phase 3, unit U3). Spec: phase-3-design.md sections 3 and 7; OMB F55.
// Styled by static/css/bots-automations.css.
//
// Phase 1's panel registers this by wrapping `mount(host, ctx)`; ctx is {agentId, threadId, mode, getAgent, refresh, navigate, signal}.
// It resolves to {dispose, refresh}, owns only children of `host`, aborts its requests on disposal and never touches panel state.
//
// Rows are enabled first, then the soonest next run, then name. Each shows the switch, the name, next and latest run, an attention or
// error line (two lines at most), a failure streak, runs this week and a skipped count, with Logs and a Pause or Edit shortcut.
// "Add" and a row's name open the same editor the Automations page uses. Logs opens the page on that routine.
import { api, toast } from './api.js';
import { loadBotsCss, Card, SwitchRow, Button } from './botsUi.js';
import { normalizeRoutine, describeSchedule, whenMid, relative, refusalOf } from './botsAutomationModel.js';

const CSS = '/static/css/bots-automations.css';
const POLL_MS = 15000;

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

// Enabled first, then the soonest next run (none last), then name.
export function sortRoutines(list) {
  return [...list].sort((a, b) => (b.enabled - a.enabled) || ((a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

export async function mount(host, ctx = {}) {
  await loadBotsCss(CSS);
  const control = new AbortController();
  ctx.signal?.addEventListener('abort', () => control.abort(), { once: true });
  const root = h('div', { class: 'bots-routines' });
  host.append(root);
  const state = { routines: [], loaded: false, failed: false, disposed: false, version: 0 };
  const go = (tab, options = {}) => (ctx.navigate ? ctx.navigate(tab, options) : document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } })));

  async function load() {
    const at = ++state.version;
    try {
      const data = await api(`/api/bot-routines?bot_id=${encodeURIComponent(ctx.agentId)}`, { signal: control.signal, toast: false });
      if (state.disposed || at !== state.version) return;
      state.routines = sortRoutines((Array.isArray(data) ? data : data?.routines || []).map(normalizeRoutine).filter(Boolean));
      state.failed = false;
    } catch (error) {
      if (state.disposed || at !== state.version || error?.name === 'AbortError') return;
      state.failed = !state.loaded;
    }
    state.loaded = true;
    draw();
  }

  async function openEditor(routine) {
    const editor = await import('./botsAutomationEditor.js');
    editor.openRoutineEditor({ id: routine?.id || '', agentId: ctx.agentId, routine: routine || null, onSaved: () => { load(); ctx.refresh?.(); }, opener: document.activeElement });
  }

  async function setEnabled(routine, enabled, control) {
    try {
      await api(`/api/bot-routines/${encodeURIComponent(routine.id)}`, { method: 'PATCH', body: JSON.stringify({ enabled, expected_revision: String(routine.revision) }), toast: false });
    } catch (error) {
      control.setChecked?.(!enabled);
      toast(refusalOf(error).status === 409 ? 'That changed somewhere else. Reloaded.' : refusalOf(error).message, 'error');
    }
    await load();
  }

  function row(routine) {
    const last = routine.lastRun;
    const attention = routine.checkTrouble
      || (last && ['failed', 'missed'].includes(last.status) ? (last.error || last.summary) : '')
      || (last?.status === 'waiting' ? (last.summary || 'Waiting for your answer') : '') || routine.warning;
    const lines = [
      h('span', { class: 'bots-routines-line', text: `${describeSchedule(routine.schedule)}${routine.enabled && routine.nextRunAt ? ` · next ${whenMid(routine.nextRunAt)}` : routine.enabled ? '' : ' · paused'}` }),
      last ? h('span', { class: 'bots-routines-line', text: `Last ${({ completed: 'ran', failed: 'failed', missed: 'was missed', cancelled: 'was cancelled', running: 'is running', waiting: 'is waiting for you', queued: 'is queued' })[last.status] || 'ran'} ${relative(last.finishedAt ?? last.startedAt)}` }) : h('span', { class: 'bots-routines-line', text: 'Has not run yet' }),
      attention ? h('span', { class: 'bots-routines-attention', text: String(attention).slice(0, 240) }) : null,
      h('span', { class: 'bots-routines-meta', text: [routine.failureStreak >= 2 ? `Failed ${routine.failureStreak} in a row` : '', routine.weekRuns ? `${routine.weekRuns.ok}/${routine.weekRuns.total} this week` : '', routine.skippedRuns ? `Skipped ${routine.skippedRuns}` : ''].filter(Boolean).join(' · ') }),
    ];
    const toggle = SwitchRow({ title: routine.name, hint: '', checked: routine.enabled, onChange: value => setEnabled(routine, value, toggle) });
    toggle.classList.add('bots-routines-switch');
    toggle.querySelector('.bots-row-main').replaceChildren(
      h('button', { type: 'button', class: 'bots-routines-name', text: routine.name, onclick: event => { event.stopPropagation(); openEditor(routine); } }),
      ...lines.filter(Boolean));
    const node = h('div', { class: 'bots-routines-row', 'data-routine-id': routine.id, 'data-enabled': routine.enabled ? 'true' : 'false' }, [
      toggle,
      h('div', { class: 'bots-routines-links' }, [
        h('button', { type: 'button', class: 'bots-btn', text: 'Logs', 'aria-label': `Logs for ${routine.name}`, onclick: () => go('botsAutomations', { botId: ctx.agentId, select: `routine:${routine.id}` }) }),
      ]),
    ]);
    // The switch's accessible name comes from the routine's name.
    toggle.control?.setAttribute('aria-label', `${routine.name} on`);
    toggle.control?.removeAttribute('aria-labelledby');
    return node;
  }

  function draw() {
    if (state.disposed) return;
    const focused = document.activeElement?.closest?.('.bots-routines-row')?.dataset.routineId;
    const add = Button({ label: 'Add', iconName: 'plus', variant: 'primary', onClick: () => openEditor(null) });
    add.classList.add('bots-routines-add');
    const all = h('button', { type: 'button', class: 'bots-btn bots-routines-all', text: 'See all automations', onclick: () => go('botsAutomations', { botId: ctx.agentId }) });
    let content;
    if (state.failed) content = h('p', { class: 'bots-routines-message', role: 'alert', text: 'Routines could not load. Try again in a moment.' });
    else if (!state.loaded) content = h('p', { class: 'bots-routines-message', role: 'status', text: 'Loading...' });
    else if (!state.routines.length) content = h('p', { class: 'bots-routines-message', text: 'No routines yet. Add one and this bot works on its own, on a schedule.' });
    else content = Card({ children: state.routines.map(row) });
    // replaceChildren would print a null as the text "null", so the link is added only when there is something to see.
    root.replaceChildren(h('div', { class: 'bots-routines-head' }, [h('span', { class: 'bots-caps', text: 'Routines' }), add]), content, ...(state.routines.length ? [all] : []));
    if (focused) root.querySelector(`.bots-routines-row[data-routine-id="${window.CSS.escape(focused)}"] .bots-routines-name`)?.focus({ preventScroll: true });
  }

  const timer = setInterval(() => { if (!document.hidden && !document.querySelector('.bots-auto-dialog')) load(); }, POLL_MS);
  const onChanged = () => load();
  document.addEventListener('kairos:bots-automation-changed', onChanged);
  await load();
  const dispose = () => {
    state.disposed = true; ++state.version; clearInterval(timer); control.abort();
    document.removeEventListener('kairos:bots-automation-changed', onChanged);
    root.remove();
  };
  return { dispose, refresh: load };
}

