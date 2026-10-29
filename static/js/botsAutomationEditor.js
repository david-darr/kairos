// Bots mode: the automation editors (Agents 3.0 Phase 3, unit U3).
// Spec: phase-3-design.md sections 6 and 7; OMB F52, F56, F57, F58. Styled by static/css/bots-automations.css.
//
// Public entry points, imported lazily by U5's change card and by the Automations page and the bot panel's
// Routines section, all with the same shape: ({id, agentId, onSaved}) -> {close}.
//   openRoutineEditor({id, agentId, onSaved, routine?, prefill?})   a routine (a bot doing a prompt on a schedule)
//   openTriggerEditor({id, agentId, onSaved})                       a webhook ("When another app calls")
//   openWebhookEditor                                               the same function under its other name
//   openAppEventEditor({id, agentId, onSaved})                      "When something happens in an app"
// onSaved receives {id, revision, kind}. Nothing here decides when a routine runs: the sentence and the next three
// times come from POST /api/bot-routines/preview, and the server's refusals are shown on the field they name.
//
// Each editor is a dialog from api.js openPanelDialog (focus trap, Escape, focus back to the opener).
import { api, openPanelDialog, toast } from './api.js';
import { loadBotsCss, isAdvanced } from './botsUi.js';
import { icon } from './botsIcons.js';
import { normalizeRoutine, draftFromRoutine, emptyDraft, bodyFromDraft, previewBody, validateDraft, refusalOf,
  REPEATS, ADVANCED_REPEATS, CRON_PRESETS, WEEKDAYS, toMs, whenText, LIMITS } from './botsAutomationModel.js';

const CSS = '/static/css/bots-automations.css';

// api.js's el() writes the text "undefined" for an undefined attribute; this one leaves it out.
function el(tag, attrs = {}, children = []) {
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

let uid = 0;
const nextId = prefix => `${prefix}-${++uid}`;

// -- Small builders ---------------------------------------------------------------------------------

// A labelled field with a hint and an error line; the control gets aria-invalid and aria-describedby.
function field({ label, control, hint = '', name, wide = false }) {
  const id = nextId('bots-ed');
  const controls = [].concat(control);
  const first = controls.find(c => c?.matches?.('input, select, textarea, button')) || controls[0];
  if (first && !first.id) first.id = id;
  const error = el('p', { class: 'bots-ed-error', id: `${id}-error`, role: 'alert', hidden: '' });
  const node = el('div', { class: `bots-ed-field${wide ? ' wide' : ''}`, 'data-field': name || '' }, [
    el('label', { class: 'bots-ed-label', for: first?.id || id, text: label }),
    ...controls,
    hint ? el('p', { class: 'bots-ed-hint', id: `${id}-hint`, text: hint }) : null,
    error,
  ]);
  node.setError = message => {
    error.hidden = !message; error.textContent = message || '';
    for (const c of controls) {
      if (!c?.setAttribute) continue;
      const target = c.matches?.('input, select, textarea') ? c : null;
      if (!target) continue;
      if (message) { target.setAttribute('aria-invalid', 'true'); target.setAttribute('aria-describedby', `${id}-error`); }
      else { target.removeAttribute('aria-invalid'); target.removeAttribute('aria-describedby'); }
    }
  };
  return node;
}

const input = (attrs = {}) => el('input', { type: 'text', ...attrs });
function select(options, value, attrs = {}) {
  const node = el('select', attrs, options.map(o => el('option', { value: o.value, text: o.label })));
  node.value = value;
  return node;
}
function toggleRow(label, checked, onChange, hint = '') {
  const id = nextId('bots-ed-switch');
  const button = el('button', { type: 'button', role: 'switch', class: 'bots-switch', 'aria-checked': checked ? 'true' : 'false', 'aria-labelledby': `${id}-t` });
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', next ? 'true' : 'false'); onChange(next);
  });
  const row = el('div', { class: 'bots-ed-switch' }, [el('span', { class: 'bots-ed-switch-text' }, [el('span', { id: `${id}-t`, text: label }), hint ? el('span', { class: 'bots-ed-hint', text: hint }) : null]), button]);
  row.set = value => button.setAttribute('aria-checked', value ? 'true' : 'false');
  return row;
}

// A group of toggle buttons choosing days (Monday = 0). aria-pressed marks the chosen ones.
function dayPicker(initial, onChange) {
  let chosen = new Set(initial);
  const buttons = WEEKDAYS.map((day, index) => el('button', { type: 'button', class: 'bots-ed-day', 'aria-pressed': chosen.has(index) ? 'true' : 'false', 'aria-label': day, text: day }));
  buttons.forEach((button, index) => button.addEventListener('click', () => {
    if (chosen.has(index)) chosen.delete(index); else chosen.add(index);
    button.setAttribute('aria-pressed', chosen.has(index) ? 'true' : 'false');
    onChange([...chosen].sort((a, b) => a - b));
  }));
  const node = el('div', { class: 'bots-ed-days', role: 'group', 'aria-label': 'Days' }, buttons);
  node.set = list => { chosen = new Set(list); buttons.forEach((b, i) => b.setAttribute('aria-pressed', chosen.has(i) ? 'true' : 'false')); };
  return node;
}

// Chips for the simple repeat choice. A value that is not a chip leaves none chosen but keeps the first tabbable.
function chips(options, value, onChange, label) {
  const buttons = options.map(o => el('button', { type: 'button', role: 'radio', class: 'bots-ed-chip', 'data-value': o.value, text: o.label }));
  const node = el('div', { class: 'bots-ed-chips', role: 'radiogroup', 'aria-label': label }, buttons);
  const set = next => {
    const any = buttons.some(b => b.dataset.value === next);
    buttons.forEach((b, i) => { const on = b.dataset.value === next; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on || (!any && i === 0) ? 0 : -1; });
  };
  buttons.forEach(b => b.addEventListener('click', () => { set(b.dataset.value); onChange(b.dataset.value); }));
  node.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const at = Math.max(0, buttons.findIndex(b => b === document.activeElement));
    const target = buttons[(at + step + buttons.length) % buttons.length];
    target.focus(); target.click();
  });
  node.set = set; set(value);
  return node;
}

const zoneList = () => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Asia/Tokyo']; } };

async function visibleBots() {
  const list = await api('/api/agents').catch(() => []);
  return (Array.isArray(list) ? list : []).filter(b => !b.hidden);
}

async function loadRoutine(id, agentId) {
  const query = agentId ? `?bot_id=${encodeURIComponent(agentId)}` : '';
  const data = await api(`/api/bot-routines${query}`, { toast: false });
  const list = Array.isArray(data) ? data : data?.routines || [];
  const found = list.find(r => String(r.id) === String(id));
  return found ? normalizeRoutine(found) : null;
}

const newDialog = ({ title, body, footer, className, opener, onClose, initialFocus }) =>
  openPanelDialog({ title, body, footer, className: `bots-auto-dialog ${className}`, opener, onClose, initialFocus });

// -- The routine editor ---------------------------------------------------------------------------------

export function openRoutineEditor({ id = '', agentId = '', onSaved, routine = null, prefill = null, opener = document.activeElement } = {}) {
  let closeDialog = () => {};
  const handle = { close: () => closeDialog() };
  (async () => {
    await loadBotsCss(CSS);
    const [bots, existing] = await Promise.all([visibleBots(), routine ? Promise.resolve(routine) : id ? loadRoutine(id, agentId) : Promise.resolve(null)]);
    if (id && !existing) { toast('That routine is not there any more.', 'error'); return; }
    if (!bots.length) { toast('Make a bot first, then give it a routine.', 'error'); return; }
    const draft = existing ? draftFromRoutine(existing) : { ...emptyDraft(agentId || bots[0].id), ...(prefill || {}) };
    if (!existing && !draft.botId) draft.botId = bots[0].id;
    const dialog = buildRoutineDialog({ draft, bots, editing: !!existing, onSaved, opener });
    closeDialog = dialog.close;
  })().catch(error => { console.warn('Bots: the routine editor could not open', error); toast('The editor could not open. Try again.', 'error'); });
  return handle;
}

function buildRoutineDialog({ draft, bots, editing, onSaved, opener }) {
  const state = { draft: { ...draft }, errors: {}, serverError: '', preview: null, saving: false, advancedOpen: false, endpoints: null, threads: [] };
  const fields = {};
  const TEXT_ONLY = ['name', 'prompt', 'botId', 'resultsThreadId', 'overlap', 'runOnStartup', 'continuity', 'access', 'call', 'durationMinutes', 'timeoutMinutes'];
  const set = patch => {
    Object.assign(state.draft, patch);
    // Fields that do not change when it runs need no new preview (and keep any error already shown for them).
    if (Object.keys(patch).every(key => TEXT_ONLY.includes(key))) { delete state.errors[Object.keys(patch)[0]]; sync(); } else { sync(); schedulePreview(); }
  };

  // ---- Simple fields
  const bot = select(bots.map(b => ({ value: b.id, label: b.name })), state.draft.botId, { name: 'bot' });
  bot.addEventListener('change', () => { set({ botId: bot.value, resultsThreadId: '' }); loadThreads(); });
  fields.bot = field({ label: 'Bot', control: bot, name: 'bot' });
  const name = input({ maxlength: String(LIMITS.name), placeholder: 'Morning summary', name: 'name' });
  name.value = state.draft.name;
  name.addEventListener('input', () => set({ name: name.value }));
  fields.name = field({ label: 'Name', control: name, name: 'name' });

  const date = el('input', { type: 'date', name: 'date' }); date.value = state.draft.date;
  date.addEventListener('input', () => set({ date: date.value }));
  const time = el('input', { type: 'time', name: 'time' }); time.value = state.draft.time;
  time.addEventListener('input', () => set({ time: time.value }));
  fields.date = field({ label: 'Date', control: date, name: 'date' });
  fields.time = field({ label: 'Time', control: time, name: 'time' });
  const repeat = chips(REPEATS, state.draft.repeat, value => {
    const patch = { repeat: value };
    if (value === 'weekly' && !state.draft.weekdays.length) patch.weekdays = [new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
    set(patch);
  }, 'Repeat');
  fields.repeat = field({ label: 'Repeat', control: repeat, name: 'repeat' });
  const weekly = dayPicker(state.draft.weekdays, days => set({ weekdays: days }));
  fields.weekdays = field({ label: 'On', control: weekly, name: 'weekdays' });

  const prompt = el('textarea', { rows: '5', name: 'prompt', placeholder: 'What should the bot do each time?' });
  prompt.value = state.draft.prompt;
  prompt.addEventListener('input', () => set({ prompt: prompt.value }));
  fields.prompt = field({ label: 'Instructions', control: prompt, name: 'prompt', wide: true });

  // ---- Advanced fields
  const advRepeat = select(ADVANCED_REPEATS, state.draft.repeat, { name: 'repeatKind' });
  advRepeat.addEventListener('change', () => {
    const patch = { repeat: advRepeat.value };
    if (advRepeat.value === 'weekly' && !state.draft.weekdays.length) patch.weekdays = [0];
    set(patch);
  });
  fields.advRepeat = field({ label: 'Repeats', control: advRepeat, name: 'repeatKind' });

  const every = el('input', { type: 'number', min: String(LIMITS.minutes[0]), max: String(LIMITS.minutes[1]), name: 'everyMinutes' });
  every.value = String(state.draft.everyMinutes);
  every.addEventListener('input', () => set({ everyMinutes: every.value === '' ? '' : Number(every.value) }));
  fields.everyMinutes = field({ label: 'Every how many minutes', control: every, name: 'everyMinutes', hint: 'From 5 to 1440.' });
  const intervalDays = dayPicker(state.draft.weekdays, days => set({ weekdays: days }));
  fields.intervalDays = field({ label: 'Only on these days', control: intervalDays, name: 'intervalDays', hint: 'Leave all off for every day.' });
  const windowStart = el('input', { type: 'time', name: 'windowStart' }); windowStart.value = state.draft.windowStart;
  const windowEnd = el('input', { type: 'time', name: 'windowEnd' }); windowEnd.value = state.draft.windowEnd;
  windowStart.addEventListener('input', () => set({ windowStart: windowStart.value }));
  windowEnd.addEventListener('input', () => set({ windowEnd: windowEnd.value }));
  const windowSwitch = toggleRow('Only between certain hours', state.draft.windowOn, on => set({ windowOn: on }));
  fields.window = field({ label: 'Between', control: [el('div', { class: 'bots-ed-pair' }, [windowStart, el('span', { text: 'and' }), windowEnd])], name: 'window' });
  const endsOn = el('input', { type: 'date', name: 'endsOn' }); endsOn.value = state.draft.endsOn;
  endsOn.addEventListener('input', () => set({ endsOn: endsOn.value }));
  fields.endsOn = field({ label: 'Stop after (optional)', control: endsOn, name: 'endsOn' });

  const cron = input({ name: 'cron', placeholder: '0 9 * * 1-5', autocomplete: 'off', spellcheck: 'false' });
  cron.value = state.draft.cron;
  cron.addEventListener('input', () => set({ cron: cron.value }));
  const preset = select([{ value: '', label: 'Pick a starting point' }, ...CRON_PRESETS.map(p => ({ value: p.expression, label: p.label }))], '', { 'aria-label': 'Schedule examples' });
  preset.addEventListener('change', () => { if (preset.value) { cron.value = preset.value; set({ cron: preset.value }); } });
  fields.cron = field({ label: 'Schedule', control: [cron, preset], name: 'cron', hint: 'Five fields: minute, hour, day, month, weekday. L means the last day of the month.' });
  const zone = input({ name: 'timeZone', list: 'bots-ed-zones', autocomplete: 'off' });
  zone.value = state.draft.timeZone;
  zone.addEventListener('input', () => set({ timeZone: zone.value.trim() }));
  const zones = el('datalist', { id: 'bots-ed-zones' }, zoneList().map(z => el('option', { value: z })));
  fields.timeZone = field({ label: 'Time zone', control: [zone, zones], name: 'timeZone', hint: 'A name like America/New_York.' });

  const endpoint = select([{ value: '', label: 'Loading...' }], '', { name: 'endpointId' });
  endpoint.addEventListener('change', () => set({ endpointId: endpoint.value }));
  fields.endpointId = field({ label: 'Which limit', control: endpoint, name: 'endpointId' });
  const resetRepeat = select([{ value: 'once', label: 'Once, after the next reset' }, { value: 'every_reset', label: 'After every reset' }], state.draft.resetRepeat, { name: 'resetRepeat' });
  resetRepeat.addEventListener('change', () => set({ resetRepeat: resetRepeat.value }));
  fields.resetRepeat = field({ label: 'How often', control: resetRepeat, name: 'resetRepeat' });

  const duration = el('input', { type: 'number', min: '5', max: '240', step: '5', name: 'durationMinutes' }); duration.value = String(state.draft.durationMinutes);
  duration.addEventListener('input', () => set({ durationMinutes: duration.value === '' ? '' : Number(duration.value) }));
  fields.durationMinutes = field({ label: 'Block length (minutes)', control: duration, name: 'durationMinutes', hint: 'How long it takes on the calendar.' });
  const timeout = el('input', { type: 'number', min: '5', max: '240', name: 'timeoutMinutes', placeholder: 'No limit' }); timeout.value = String(state.draft.timeoutMinutes ?? '');
  timeout.addEventListener('input', () => set({ timeoutMinutes: timeout.value === '' ? '' : Number(timeout.value) }));
  fields.timeoutMinutes = field({ label: 'Run limit (minutes)', control: timeout, name: 'timeoutMinutes', hint: 'Time spent waiting for you does not count.' });
  const overlap = select([{ value: 'skip', label: 'Skip the new run' }, { value: 'queue', label: 'Queue one for after' }], state.draft.overlap, { name: 'overlap' });
  overlap.addEventListener('change', () => set({ overlap: overlap.value }));
  fields.overlap = field({ label: 'If the last run is still going', control: overlap, name: 'overlap' });
  const results = select([{ value: '', label: 'Its own conversation each time' }], state.draft.resultsThreadId, { name: 'resultsThreadId' });
  results.addEventListener('change', () => set({ resultsThreadId: results.value }));
  fields.results = field({ label: 'Post results to', control: results, name: 'resultsThreadId' });
  const startup = toggleRow('Also run when Kairos starts', state.draft.runOnStartup, on => set({ runOnStartup: on }));
  const continuity = toggleRow('Remember the last report', state.draft.continuity, on => set({ continuity: on }), 'The bot sees how the last run ended.');
  const access = toggleRow('Read and draft only', state.draft.access === 'read-and-draft', on => set({ access: on ? 'read-and-draft' : 'normal' }), 'It cannot send or change anything.');
  const call = toggleRow('Show as a call on the calendar', state.draft.call, on => set({ call: on }), 'Calls can be stretched on the calendar.');

  const advanced = el('div', { class: 'bots-ed-advanced', id: nextId('bots-ed-adv'), hidden: '' }, [
    fields.advRepeat,
    el('div', { class: 'bots-ed-grid' }, [fields.everyMinutes, fields.endsOn]),
    fields.intervalDays, windowSwitch, fields.window,
    fields.cron, fields.endpointId, fields.resetRepeat, fields.timeZone,
    el('div', { class: 'bots-ed-grid' }, [fields.durationMinutes, fields.timeoutMinutes]),
    fields.overlap, fields.results, startup, continuity, access, call,
  ]);
  const more = el('button', { type: 'button', class: 'bots-btn bots-ed-more', 'aria-expanded': 'false', 'aria-controls': advanced.id }, [icon('sliders-horizontal', { size: 16 }), 'More options']);
  more.addEventListener('click', () => { state.advancedOpen = !state.advancedOpen; sync(); });

  const previewBox = el('div', { class: 'bots-ed-preview', 'aria-live': 'polite' });
  const problem = el('p', { class: 'bots-ed-error', role: 'alert', hidden: '' });

  const body = el('form', { class: 'bots-ed-form', novalidate: '' }, [
    fields.name, fields.bot,
    el('div', { class: 'bots-ed-grid' }, [fields.date, fields.time]),
    fields.repeat, fields.weekdays,
    fields.prompt, more, advanced, previewBox, problem,
  ]);
  body.addEventListener('submit', event => { event.preventDefault(); save(); });

  const cancel = el('button', { type: 'button', class: 'bots-btn', text: 'Cancel' });
  const saveButton = el('button', { type: 'submit', class: 'bots-btn primary', text: editing ? 'Save' : 'Schedule' });
  const footer = el('div', { class: 'bots-dialog-footer' }, [cancel, saveButton]);
  saveButton.addEventListener('click', event => { event.preventDefault(); save(); });

  const dialog = newDialog({ title: editing ? 'Edit routine' : 'New routine', body, footer, className: 'bots-ed-dialog', opener, initialFocus: name });
  cancel.addEventListener('click', () => dialog.close());

  const simple = ['once', 'daily', 'weekdays', 'weekly'];
  const nonDefault = d => d.overlap !== 'skip' || d.runOnStartup || d.continuity || d.resultsThreadId || d.access !== 'normal' || d.call
    || d.durationMinutes !== 30 || d.timeoutMinutes !== '';
  state.advancedOpen = isAdvanced() || !simple.includes(state.draft.repeat) || nonDefault(state.draft);

  function sync() {
    const d = state.draft;
    const show = (node, on) => { node.hidden = !on; };
    show(fields.date, ['once', 'interval'].includes(d.repeat));
    show(fields.time, ['once', 'daily', 'weekdays', 'weekly', 'interval'].includes(d.repeat));
    show(fields.repeat, simple.includes(d.repeat) || !state.advancedOpen);
    show(fields.weekdays, d.repeat === 'weekly');
    advanced.hidden = !state.advancedOpen;
    more.setAttribute('aria-expanded', state.advancedOpen ? 'true' : 'false');
    show(fields.everyMinutes, d.repeat === 'interval'); show(fields.endsOn, d.repeat === 'interval'); show(fields.intervalDays, d.repeat === 'interval');
    show(windowSwitch, d.repeat === 'interval'); show(fields.window, d.repeat === 'interval' && d.windowOn);
    show(fields.cron, d.repeat === 'cron'); show(fields.endpointId, d.repeat === 'limit_reset'); show(fields.resetRepeat, d.repeat === 'limit_reset');
    show(fields.timeZone, d.repeat === 'cron' || (state.advancedOpen && d.repeat !== 'limit_reset'));
    repeat.set(d.repeat);
    if (document.activeElement !== advRepeat) advRepeat.value = d.repeat;
    windowSwitch.set(d.windowOn);
    weekly.set(d.weekdays); intervalDays.set(d.weekdays);
    for (const [key, node] of Object.entries(fields)) node.setError?.(state.errors[key] || state.errors[{ advRepeat: 'repeatKind', results: 'resultsThreadId' }[key]] || '');
    problem.hidden = !state.serverError; problem.textContent = state.serverError;
    saveButton.disabled = state.saving;
    saveButton.textContent = state.saving ? 'Saving...' : editing ? 'Save' : 'Schedule';
    drawPreview();
  }

  function drawPreview() {
    const p = state.preview;
    if (!p || Object.keys(state.errors).length) { previewBox.replaceChildren(); previewBox.hidden = true; return; }
    previewBox.hidden = false;
    previewBox.replaceChildren(
      el('p', { class: 'bots-ed-sentence', text: p.sentence || '' }),
      p.next?.length ? el('ul', { class: 'bots-ed-next', 'aria-label': 'Next times' }, p.next.map(ms => el('li', { text: whenText(ms, Date.now(), state.draft.timeZone || undefined) }))) : null,
      ...(p.warnings || []).map(w => el('p', { class: 'bots-ed-hint', text: w })));
  }

  // Preview from the engine (debounced). Client checks run first so a typo never costs a round trip.
  let previewTimer = 0, previewControl = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    state.serverError = '';
    const errors = validateDraft(state.draft);
    // Name and instructions do not matter to a preview; only the schedule's own fields do.
    const own = Object.fromEntries(Object.entries(errors).filter(([key]) => !['name', 'prompt', 'bot', 'durationMinutes', 'timeoutMinutes'].includes(key)));
    previewControl?.abort();
    if (Object.keys(own).length) { state.preview = null; showErrors(own, false); return; }
    state.errors = {};
    sync();
    previewTimer = setTimeout(async () => {
      previewControl = new AbortController();
      try {
        const result = await api('/api/bot-routines/preview', { method: 'POST', body: JSON.stringify(previewBody(state.draft)), signal: previewControl.signal, toast: false });
        state.preview = { sentence: result.sentence || '', next: (result.next || result.next_runs || []).map(toMs).filter(v => v !== null).slice(0, 3), warnings: result.warnings || [] };
        drawPreview();
      } catch (error) {
        if (error?.name === 'AbortError') return;
        const refusal = refusalOf(error);
        state.preview = null;
        const named = fieldFromMessage(refusal.message);
        showErrors(named ? { [named]: refusal.message } : {}, true, named ? '' : refusal.message);
      }
    }, 280);
  }
  // The server names no field in its 400 text, so route known words to the field they are about.
  function fieldFromMessage(message) {
    const m = String(message).toLowerCase();
    if (/cron|five fields|day of month|minute|weekday field/.test(m)) return 'cron';
    if (/window/.test(m)) return 'window';
    if (/time zone|timezone|iana/.test(m)) return 'timeZone';
    if (/passed|past|future/.test(m)) return 'date';
    return '';
  }
  function showErrors(map, fromServer, text = '') {
    state.errors = map; state.serverError = text;
    sync();
    if (!fromServer) previewBox.replaceChildren();
  }

  async function loadThreads() {
    try {
      const data = await api(`/api/agents/${encodeURIComponent(state.draft.botId)}/threads`, { toast: false });
      state.threads = (data?.threads || []).filter(t => !t.thread?.archived_at && t.thread?.opened_by !== 'routine');
    } catch { state.threads = []; }
    const options = [{ value: '', label: 'Its own conversation each time' }, ...state.threads.map(t => ({ value: t.id, label: t.title || 'Untitled' }))];
    results.replaceChildren(...options.map(o => el('option', { value: o.value, text: o.label })));
    results.value = options.some(o => o.value === state.draft.resultsThreadId) ? state.draft.resultsThreadId : '';
  }
  async function loadEndpoints() {
    try {
      const data = await api('/api/bot-limit-resets', { toast: false });
      state.endpoints = (data?.endpoints || data?.limits || []).map(e => ({ value: e.endpoint_id, label: e.name || e.endpoint_id }));
    } catch { state.endpoints = []; }
    const options = state.endpoints.length ? state.endpoints : [{ value: '', label: 'No limits found' }];
    endpoint.replaceChildren(...options.map(o => el('option', { value: o.value, text: o.label })));
    if (!state.draft.endpointId && state.endpoints[0]) state.draft.endpointId = state.endpoints[0].value;
    endpoint.value = state.draft.endpointId;
  }

  async function save() {
    if (state.saving) return;
    const errors = validateDraft(state.draft);
    if (Object.keys(errors).length) {
      showErrors(errors, false);
      body.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    state.saving = true; state.serverError = ''; sync();
    try {
      const payload = bodyFromDraft(state.draft);
      const saved = state.draft.id
        ? await api(`/api/bot-routines/${encodeURIComponent(state.draft.id)}`, { method: 'PATCH', body: JSON.stringify(payload), toast: false })
        : await api('/api/bot-routines', { method: 'POST', body: JSON.stringify(payload), toast: false });
      const record = normalizeRoutine(saved?.routine || saved);
      dialog.close();
      onSaved?.({ id: record?.id || state.draft.id, revision: record?.revision ?? 0, kind: 'routine', routine: record });
    } catch (error) {
      const refusal = refusalOf(error);
      state.saving = false;
      if (refusal.status === 409) state.serverError = 'This routine changed since you opened it. Close this and open it again to edit the latest.';
      else {
        const named = fieldFromMessage(refusal.message);
        if (named) state.errors = { [named]: refusal.message }; else state.serverError = refusal.message;
      }
      sync();
      (body.querySelector('[aria-invalid="true"]') || problem).focus?.();
    }
  }

  sync();
  loadThreads();
  loadEndpoints();
  schedulePreview();
  return dialog;
}

// -- The webhook editor ("When another app calls") --------------------------------------------------------

export function openTriggerEditor({ id = '', agentId = '', onSaved, opener = document.activeElement } = {}) {
  let closeDialog = () => {};
  (async () => {
    await loadBotsCss(CSS);
    const [bots, existing] = await Promise.all([visibleBots(), id ? api('/api/triggers', { toast: false }).then(d => (d.triggers || []).find(t => t.id === id) || null).catch(() => null) : Promise.resolve(null)]);
    if (id && !existing) { toast('That webhook is not there any more.', 'error'); return; }
    if (!bots.length) { toast('Make a bot first, then connect an app to it.', 'error'); return; }
    closeDialog = buildTriggerDialog({ bots, existing, agentId, onSaved, opener }).close;
  })().catch(error => { console.warn('Bots: the webhook editor could not open', error); toast('The editor could not open. Try again.', 'error'); });
  return { close: () => closeDialog() };
}
export const openWebhookEditor = openTriggerEditor;

function buildTriggerDialog({ bots, existing, agentId, onSaved, opener }) {
  const state = { saving: false, secret: '', path: '' };
  const draft = { name: existing?.name || '', botId: existing?.agent_id || agentId || bots[0].id, prompt: existing?.prompt_template || '', events: (existing?.events || []).join(', '),
    autoRun: !!existing?.auto_run, maxPending: existing?.max_pending || 3 };
  const fields = {};
  const bot = select(bots.map(b => ({ value: b.id, label: b.name })), draft.botId, { name: 'bot' });
  bot.addEventListener('change', () => { draft.botId = bot.value; });
  const name = input({ name: 'name', maxlength: '80', placeholder: 'New orders' }); name.value = draft.name;
  name.addEventListener('input', () => { draft.name = name.value; });
  const prompt = el('textarea', { rows: '5', name: 'prompt', placeholder: 'What should the bot do when this app calls?' }); prompt.value = draft.prompt;
  prompt.addEventListener('input', () => { draft.prompt = prompt.value; });
  const events = input({ name: 'events', placeholder: 'push, order.created' }); events.value = draft.events;
  events.addEventListener('input', () => { draft.events = events.value; });
  const pending = el('input', { type: 'number', min: '1', max: '50', name: 'maxPending' }); pending.value = String(draft.maxPending);
  pending.addEventListener('input', () => { draft.maxPending = pending.value === '' ? '' : Number(pending.value); });
  fields.name = field({ label: 'Name', control: name, name: 'name' });
  fields.bot = field({ label: 'Bot', control: bot, name: 'bot' });
  fields.prompt = field({ label: 'Instructions', control: prompt, name: 'prompt', wide: true });
  fields.events = field({ label: 'Only these events (optional)', control: events, name: 'events', hint: 'Separate with commas. Leave empty to take every event.' });
  fields.pending = field({ label: 'Most unfinished runs at once', control: pending, name: 'maxPending', hint: 'From 1 to 50. More calls wait or are turned away.' });
  const runNow = toggleRow('Run straight away', draft.autoRun, on => { draft.autoRun = on; note.hidden = !on; },
    'Off, each call waits for your OK first.');
  const note = el('p', { class: 'bots-ed-hint', hidden: draft.autoRun ? undefined : '', text: 'Anyone with the address and secret can start this bot. Keep them private.' });
  note.hidden = !draft.autoRun;
  const problem = el('p', { class: 'bots-ed-error', role: 'alert', hidden: '' });
  const connect = el('div', { class: 'bots-ed-connect', hidden: '' });
  const form = el('form', { class: 'bots-ed-form', novalidate: '' }, [fields.name, fields.bot, fields.prompt, fields.events, fields.pending, runNow, note, problem, connect]);
  form.addEventListener('submit', event => { event.preventDefault(); save(); });
  const cancel = el('button', { type: 'button', class: 'bots-btn', text: 'Cancel' });
  const submit = el('button', { type: 'submit', class: 'bots-btn primary', text: existing ? 'Save' : 'Create' });
  const dialog = newDialog({ title: existing ? 'Edit webhook' : 'New webhook', body: form, footer: el('div', { class: 'bots-dialog-footer' }, [cancel, submit]), className: 'bots-ed-dialog', opener, initialFocus: name });
  cancel.addEventListener('click', () => dialog.close());
  submit.addEventListener('click', event => { event.preventDefault(); save(); });

  const errors = () => {
    const out = {};
    if (!draft.name.trim()) out.name = 'Give it a name.';
    if (!draft.prompt.trim()) out.prompt = 'Say what the bot should do.';
    const list = draft.events.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 20) out.events = 'At most 20 events.';
    if (draft.maxPending === '' || !Number.isInteger(draft.maxPending) || draft.maxPending < 1 || draft.maxPending > 50) out.maxPending = 'Use a whole number from 1 to 50.';
    return out;
  };
  const show = map => { for (const [key, node] of Object.entries(fields)) node.setError(map[key === 'pending' ? 'maxPending' : key] || ''); };

  async function save() {
    if (state.saving) return;
    if (state.secret) { dialog.close(); return; }
    const bad = errors(); show(bad);
    if (Object.keys(bad).length) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    state.saving = true; submit.disabled = true; problem.hidden = true;
    const body = { name: draft.name.trim(), agent_id: draft.botId, action: 'card', prompt_template: draft.prompt.trim(),
      events: draft.events.split(',').map(s => s.trim()).filter(Boolean), auto_run: draft.autoRun, max_pending: draft.maxPending };
    try {
      const saved = existing
        ? await api(`/api/triggers/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: JSON.stringify(body), toast: false })
        : await api('/api/triggers', { method: 'POST', body: JSON.stringify(body), toast: false });
      onSaved?.({ id: saved.id || existing?.id, revision: saved.revision ?? 0, kind: 'webhook' });
      if (saved.secret) {
        // The secret is shown this once, then only a new one can be made.
        state.secret = saved.secret; state.path = saved.path || '';
        showConnect(saved);
      } else dialog.close();
    } catch (error) {
      problem.hidden = false; problem.textContent = refusalOf(error).message;
    } finally { state.saving = false; submit.disabled = false; }
  }

  function showConnect(saved) {
    const address = saved.path ? new URL(saved.path, location.origin).href : '';
    for (const node of [...form.children]) if (node !== connect) node.hidden = true;
    connect.hidden = false;
    connect.replaceChildren(
      el('h3', { class: 'bots-ed-sub', text: 'Connect it' }),
      el('p', { class: 'bots-ed-hint', text: 'Copy these now. The secret is shown only this once.' }),
      copyRow('Address', address),
      copyRow('Secret', state.secret, true),
    );
    submit.textContent = 'Done'; cancel.hidden = true;
    submit.focus();
  }
  return dialog;
}

function copyRow(label, value, secret = false) {
  const code = el('code', { class: 'bots-ed-code', text: value });
  const button = el('button', { type: 'button', class: 'bots-btn', 'aria-label': `Copy ${label.toLowerCase()}` }, [icon('copy', { size: 16 }), 'Copy']);
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); toast('Copied', 'success'); } catch { toast('Could not copy. Select the text instead.', 'error'); }
  });
  return el('div', { class: 'bots-ed-copy', 'data-secret': secret ? '' : undefined }, [el('span', { class: 'bots-caps', text: label }), code, button]);
}

// -- The app-event editor ("When something happens in an app") --------------------------------------------

export function openAppEventEditor({ id = '', agentId = '', onSaved, opener = document.activeElement } = {}) {
  let closeDialog = () => {};
  (async () => {
    await loadBotsCss(CSS);
    const bots = await visibleBots();
    if (!bots.length) { toast('Make a bot first, then connect an app to it.', 'error'); return; }
    const existing = id ? await api(`/api/bot-app-triggers/${encodeURIComponent(id)}`, { toast: false }).catch(() => null) : null;
    if (id && !existing) { toast('That automation is not there any more.', 'error'); return; }
    const botId = existing?.agent_id || existing?.bot_id || agentId || bots[0].id;
    const catalog = await api(`/api/bot-app-triggers/events?bot_id=${encodeURIComponent(botId)}`, { toast: false }).catch(() => ({ apps: [], unavailable: [] }));
    closeDialog = buildAppDialog({ bots, existing, botId, catalog, onSaved, opener }).close;
  })().catch(error => { console.warn('Bots: the app-event editor could not open', error); toast('The editor could not open. Try again.', 'error'); });
  return { close: () => closeDialog() };
}

function buildAppDialog({ bots, existing, botId, catalog: first, onSaved, opener }) {
  const state = { catalog: first, saving: false };
  const draft = { botId, name: existing?.name || '', prompt: existing?.prompt_template || existing?.instructions || '', app: existing?.adapter || existing?.app || '', event: existing?.events?.[0] || existing?.event || '',
    account: existing?.config?.account_id || existing?.account_id || '', filters: { text: existing?.conditions?.find(c => c.path === 'summary')?.equals || existing?.filters?.text || '' }, config: { ...(existing?.config || {}) } };
  const fields = {};
  const bot = select(bots.map(b => ({ value: b.id, label: b.name })), draft.botId, { name: 'bot' });
  const appSelect = select([{ value: '', label: 'Choose an app' }], draft.app, { name: 'app' });
  const eventSelect = select([{ value: '', label: 'Choose what to watch for' }], draft.event, { name: 'event' });
  const account = select([{ value: '', label: 'Any connected account' }], draft.account, { name: 'account' });
  const filter = input({ name: 'filter', maxlength: '200', placeholder: 'Optional words to look for' }); filter.value = draft.filters.text || '';
  const name = input({ name: 'name', maxlength: '80', placeholder: 'New email from my boss' }); name.value = draft.name;
  const prompt = el('textarea', { rows: '5', name: 'prompt', placeholder: 'What should the bot do when it happens?' }); prompt.value = draft.prompt;
  const configHost = el('div', { class: 'bots-ed-config' });
  const delivery = el('p', { class: 'bots-ed-hint bots-ed-delivery' });
  fields.bot = field({ label: 'Bot', control: bot, name: 'bot' });
  fields.app = field({ label: 'App', control: appSelect, name: 'app' });
  fields.event = field({ label: 'When this happens', control: eventSelect, name: 'event' });
  fields.account = field({ label: 'Account', control: account, name: 'account' });
  fields.filter = field({ label: 'Only when the summary equals', control: filter, name: 'filter', hint: 'Up to 200 characters.' });
  fields.name = field({ label: 'Name (optional)', control: name, name: 'name' });
  fields.prompt = field({ label: 'Instructions', control: prompt, name: 'prompt', wide: true });
  const empty = el('div', { class: 'bots-ed-empty', hidden: '' }, [
    el('p', { text: 'No connected apps can send events to this bot yet.' }),
    el('button', { type: 'button', class: 'bots-btn', text: 'Connect an app' }),
  ]);
  empty.lastChild.addEventListener('click', () => { dialog.close(); document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'tool-store' } })); });
  const unavailable = el('ul', { class: 'bots-ed-unavailable' });
  const problem = el('p', { class: 'bots-ed-error', role: 'alert', hidden: '' });
  const form = el('form', { class: 'bots-ed-form', novalidate: '' }, [fields.bot, empty, fields.app, fields.event, fields.account, configHost, fields.filter, delivery, fields.name, fields.prompt, unavailable, problem]);
  form.addEventListener('submit', event => { event.preventDefault(); save(); });
  const cancel = el('button', { type: 'button', class: 'bots-btn', text: 'Cancel' });
  const submit = el('button', { type: 'submit', class: 'bots-btn primary', text: existing ? 'Save' : 'Create' });
  const dialog = newDialog({ title: existing ? 'Edit app automation' : 'New app automation', body: form, footer: el('div', { class: 'bots-dialog-footer' }, [cancel, submit]), className: 'bots-ed-dialog', opener, initialFocus: appSelect });
  cancel.addEventListener('click', () => dialog.close());
  submit.addEventListener('click', event => { event.preventDefault(); save(); });

  const apps = () => state.catalog?.capabilities
    ? state.catalog.capabilities.filter(a => a.available).map(a => ({ ...a, app: a.id, name: a.label, accounts: a.accounts,
        events: a.events.map(e => ({ ...e, event: e.type, name: e.label, delivery: a.delivery, config_fields: a.fields.filter(f => f.kind !== 'account') })) }))
    : (state.catalog?.apps || []).filter(a => a.connected !== false);
  const currentApp = () => apps().find(a => a.app === draft.app);
  const currentEvent = () => currentApp()?.events?.find(e => e.event === draft.event);

  function fill() {
    const list = apps();
    empty.hidden = list.length > 0;
    for (const key of ['app', 'event', 'account', 'filter', 'name', 'prompt']) fields[key].hidden = !list.length;
    appSelect.replaceChildren(...[{ value: '', label: 'Choose an app' }, ...list.map(a => ({ value: a.app, label: a.name || a.app }))].map(o => el('option', { value: o.value, text: o.label })));
    if (!list.some(a => a.app === draft.app)) { draft.app = list.length === 1 ? list[0].app : ''; }
    appSelect.value = draft.app;
    const app = currentApp();
    eventSelect.replaceChildren(...[{ value: '', label: 'Choose what to watch for' }, ...(app?.events || []).map(e => ({ value: e.event, label: e.name || e.event }))].map(o => el('option', { value: o.value, text: o.label })));
    if (!app?.events?.some(e => e.event === draft.event)) draft.event = app?.events?.length === 1 ? app.events[0].event : '';
    eventSelect.value = draft.event;
    const accounts = app?.accounts || [];
    fields.account.hidden = accounts.length < 2;
    account.replaceChildren(...[{ value: '', label: 'Any connected account' }, ...accounts.map(a => ({ value: a.id, label: a.label || a.id }))].map(o => el('option', { value: o.value, text: o.label })));
    if (!accounts.some(a => a.id === draft.account)) draft.account = accounts.length === 1 ? accounts[0].id : '';
    account.value = draft.account;
    const event = currentEvent();
    configHost.replaceChildren(...(event?.config_fields || []).map(f => {
      const control = input({ name: `config-${f.key}`, maxlength: '200' }); control.value = draft.config[f.key] || '';
      control.addEventListener('input', () => { draft.config[f.key] = control.value; });
      return field({ label: f.label || f.key, control, name: `config-${f.key}`, hint: f.required ? 'Required.' : '' });
    }));
    delivery.hidden = !event;
    delivery.textContent = event ? (event.delivery === 'instant' ? 'Instant: it starts as soon as it happens.' : 'It checks regularly, so there can be a short delay.') : '';
    unavailable.replaceChildren(...(state.catalog?.unavailable || []).map(u => el('li', { text: `${u.name || u.app}: ${u.reason || 'not connected yet'}` })));
  }

  bot.addEventListener('change', async () => {
    draft.botId = bot.value; draft.app = ''; draft.event = '';
    state.catalog = await api(`/api/bot-app-triggers/events?bot_id=${encodeURIComponent(draft.botId)}`, { toast: false }).catch(() => ({ apps: [], unavailable: [] }));
    fill();
  });
  appSelect.addEventListener('change', () => { draft.app = appSelect.value; draft.event = ''; fill(); });
  eventSelect.addEventListener('change', () => { draft.event = eventSelect.value; fill(); });
  account.addEventListener('change', () => { draft.account = account.value; });
  filter.addEventListener('input', () => { draft.filters = filter.value.trim() ? { text: filter.value.trim() } : {}; });
  name.addEventListener('input', () => { draft.name = name.value; });
  prompt.addEventListener('input', () => { draft.prompt = prompt.value; });

  async function save() {
    if (state.saving) return;
    const bad = {};
    if (!draft.app) bad.app = 'Choose an app.';
    if (!draft.event) bad.event = 'Choose what to watch for.';
    if (!draft.prompt.trim()) bad.prompt = 'Say what the bot should do.';
    for (const f of currentEvent()?.config_fields || []) if (f.required && !String(draft.config[f.key] || '').trim()) bad[`config-${f.key}`] = 'This is needed.';
    for (const [key, node] of Object.entries(fields)) node.setError(bad[key] || '');
    for (const node of configHost.children) node.setError?.(bad[node.dataset.field] || '');
    if (Object.keys(bad).length) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
    state.saving = true; submit.disabled = true; problem.hidden = true;
    const body = { ...(existing ? {} : { bot_id: draft.botId }), name: draft.name.trim() || 'App automation', events: [draft.event],
      conditions: draft.filters.text ? [{ path: 'summary', equals: draft.filters.text }] : [],
      config: { ...draft.config, ...(draft.account ? { account_id: draft.account } : {}) }, prompt_template: draft.prompt.trim() };
    if (existing) body.expected_revision = String(existing.revision);
    try {
      const saved = existing
        ? await api(`/api/bot-app-triggers/${encodeURIComponent(existing.id)}`, { method: 'PATCH', body: JSON.stringify(body), toast: false })
        : await api('/api/bot-app-triggers', { method: 'POST', body: JSON.stringify(body), toast: false });
      dialog.close();
      onSaved?.({ id: saved.id || existing?.id, revision: saved.revision ?? 0, kind: 'app' });
    } catch (error) {
      const refusal = refusalOf(error);
      problem.hidden = false;
      problem.textContent = refusal.status === 409 ? 'This changed since you opened it. Close this and open it again to edit the latest.' : refusal.message;
    } finally { state.saving = false; submit.disabled = false; }
  }
  fill();
  return dialog;
}

