// Bots mode: the automations calendar (Agents 3.0 Phase 3, unit U3).
// Spec: phase-3-design.md section 7; OMB F56 and 3.8. Styled by static/css/bots-automation-calendar.css.
//
// Two halves. The first is plain functions with no DOM, so scripts/test_bots_automation_calendar.cjs loads this
// file in Node: the grid geometry (64 px an hour, five-minute snap), collision packing, the week and the
// mini-month, the DRAWING-ONLY projection of a routine into a range, the schedule patch a drag asks for, and
// the resize rule. The projection never decides when a routine runs: the engine's occurrences come with
// GET /api/bot-routines?from&to and win over anything projected here; cron, interval and limit-reset routines
// are drawn only at the next run the engine reports.
//
// The second half draws it: week or day view (day on a phone), a Monday-first mini-month rail with the bots
// list, the grid with the now line and limit-reset markers, drag to move, a handle to resize calls. Dragging a
// repeating routine asks "Move every time it repeats?" through ctx.confirmScope. Cron opens its editor.
import { zonedParts, zonedWallToMs, dateKey, localZone, toMs, normalizeRun, parseHHMM, clock12, clockOf,
  kipForRun, RUN_WORDS, WEEKDAYS } from './botsAutomationModel.js';
import { icon } from './botsIcons.js';

// -- Geometry -----------------------------------------------------------------------------------

export const HOUR_PX = 64;
export const SLOT_MIN = 5;
export const DAY_MIN = 1440;
export const BODY_PX = HOUR_PX * 24;
export const MIN_EVENT_PX = 18;
export const RAIL_PX = 320;
export const DRAWER_PX = 310;
export const DRAG_THRESHOLD_PX = 4;
export const BLOCK = { min: 5, max: 240 };

export const snapMinutes = (minutes, step = SLOT_MIN) => Math.round(minutes / step) * step;
export const minutesToY = minutes => (minutes / 60) * HOUR_PX;
// A y offset inside the day body as minutes since midnight, snapped to five and kept inside the day.
export const yToMinutes = (y, step = SLOT_MIN) => Math.min(DAY_MIN, Math.max(0, snapMinutes((y / HOUR_PX) * 60, step)));

// The block an event draws: top and height in px. Under 30 minutes it collapses to one line.
export function eventBox(startMinutes, durationMinutes) {
  const height = Math.max(MIN_EVENT_PX, minutesToY(Math.max(SLOT_MIN, durationMinutes)));
  return { top: minutesToY(startMinutes), height, oneLine: durationMinutes < 30 };
}

// Overlapping events share a day column side by side. Input [{key, start, end}] (minutes);
// output Map key -> {col, cols}: this event's column and how many columns its overlap group needs.
export function packColumns(events) {
  const list = [...events].sort((a, b) => a.start - b.start || b.end - a.end || String(a.key).localeCompare(String(b.key)));
  const out = new Map();
  let group = [], groupEnd = -Infinity;
  const flush = () => {
    const columns = [];
    for (const event of group) {
      let col = columns.findIndex(end => end <= event.start);
      if (col < 0) { col = columns.length; columns.push(event.end); } else columns[col] = event.end;
      out.set(event.key, { col, cols: 0 });
    }
    for (const event of group) out.get(event.key).cols = columns.length;
    group = []; groupEnd = -Infinity;
  };
  for (const event of list) {
    // A block that only touches the previous one (ends where this starts) is not an overlap.
    if (group.length && event.start >= groupEnd) flush();
    group.push(event); groupEnd = Math.max(groupEnd, event.end);
  }
  flush();
  return out;
}

// A resized block: the new length from the handle's drag distance, five-minute steps, 5 to 240.
export function resizeDuration(startDuration, deltaPx) {
  const next = snapMinutes(startDuration + (deltaPx / HOUR_PX) * 60);
  return Math.min(BLOCK.max, Math.max(BLOCK.min, next));
}

// -- Days, weeks and the mini-month ----------------------------------------------------------------

const DAY_MS = 86400000;

export function startOfDay(ms, zone) {
  const p = zonedParts(ms, zone);
  return zonedWallToMs(p.year, p.month, p.day, 0, 0, zone);
}
// The next calendar day's midnight (DST days are 23 or 25 hours, so never add 24 h blindly).
export function nextDay(ms, zone) {
  const p = zonedParts(startOfDay(ms, zone) + 36 * 3600000, zone);
  return zonedWallToMs(p.year, p.month, p.day, 0, 0, zone);
}
export function addDays(ms, count, zone) {
  let out = startOfDay(ms, zone);
  for (let i = 0; i < Math.abs(count); i++) out = count > 0 ? nextDay(out, zone) : startOfDay(out - 3600000, zone);
  return out;
}
// Monday-first: the Monday of the week holding `ms`.
export function weekStart(ms, zone) { return addDays(ms, -zonedParts(ms, zone).weekday, zone); }

// The days a view shows and the range to ask the server for. view: 'week' | 'day'.
export function viewRange(view, anchorMs, zone) {
  const first = view === 'day' ? startOfDay(anchorMs, zone) : weekStart(anchorMs, zone);
  const count = view === 'day' ? 1 : 7;
  const days = [first];
  for (let i = 1; i < count; i++) days.push(nextDay(days[i - 1], zone));
  return { view, days, from: first, to: nextDay(days[count - 1], zone) };
}

export function stepAnchor(view, anchorMs, direction, zone) { return addDays(anchorMs, (view === 'day' ? 1 : 7) * direction, zone); }

// Weeks (Monday-first) of a month for the mini-month rail: arrays of seven {ms, day, inMonth}.
export function monthGrid(anchorMs, zone) {
  const p = zonedParts(anchorMs, zone);
  const firstOfMonth = zonedWallToMs(p.year, p.month, 1, 0, 0, zone);
  let cursor = weekStart(firstOfMonth, zone);
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const q = zonedParts(cursor + 3600000 * 12, zone);
      week.push({ ms: cursor, day: q.day, inMonth: q.month === p.month });
      cursor = nextDay(cursor, zone);
    }
    if (w >= 4 && !week.some(cell => cell.inMonth)) break;
    weeks.push(week);
  }
  return weeks;
}

// -- Projection (drawing only) --------------------------------------------------------------------

// Occurrences of a routine inside [from, to) for DRAWING: once and daily are projected; every other kind only at the
// next run the engine reported. Server occurrences (ctx.occurrences) replace this entirely for the routines they cover.
export function projectOccurrences(routine, from, to, { limit = 400 } = {}) {
  const s = routine.schedule, out = [];
  const inside = ms => ms !== null && ms !== undefined && ms >= from && ms < to;
  if (s.kind === 'once') { const at = toMs(s.at); if (inside(at)) out.push(at); return out; }
  if (s.kind === 'daily') {
    const t = parseHHMM(s.time);
    if (!t) return out;
    const zone = s.time_zone || localZone();
    // Walk the schedule zone's days around the range.
    let cursor = startOfDay(from - DAY_MS, zone);
    const end = to + DAY_MS;
    while (cursor < end && out.length < limit) {
      const p = zonedParts(cursor + 3600000 * 12, zone);
      if (!s.weekdays || s.weekdays.includes(p.weekday)) {
        const at = zonedWallToMs(p.year, p.month, p.day, t.hour, t.minute, zone);
        if (inside(at)) out.push(at);
      }
      cursor = nextDay(cursor, zone);
    }
    return out;
  }
  if (inside(routine.nextRunAt)) out.push(routine.nextRunAt);
  return out;
}

// Events for a range. `occurrences` is the server's [{routine_id, at}] (any may be absent); `runs` the finished and running ones.
// A projected time that already has a run (receipt) is dropped; at most 12 receipts per routine per range (OMB F56).
export function buildEvents(routines, { from, to, occurrences = null, runs = [], now = Date.now(), receiptCap = 12 } = {}) {
  const events = [];
  const covered = new Set();
  const serverByRoutine = new Map();
  for (const occ of Array.isArray(occurrences) ? occurrences : []) {
    const at = toMs(occ.at ?? occ.scheduled_at);
    const id = String(occ.routine_id ?? occ.routineId ?? '');
    if (!id || at === null || at < from || at >= to) continue;
    if (!serverByRoutine.has(id)) serverByRoutine.set(id, []);
    serverByRoutine.get(id).push({ at, duration: Number(occ.duration_minutes) || 0 });
    covered.add(id);
  }
  const byId = new Map(routines.map(r => [r.id, r]));
  const receipts = new Map();
  for (const run of runs.map(r => ('routineId' in r && 'startedAt' in r ? r : normalizeRun(r))).filter(Boolean)) {
    const routine = byId.get(run.routineId);
    const at = run.startedAt ?? run.scheduledAt;
    if (!routine || at === null || at < from || at >= to) continue;
    const list = receipts.get(routine.id) || [];
    if (list.length >= receiptCap) continue;
    list.push({ at, run });
    receipts.set(routine.id, list);
  }
  for (const routine of routines) {
    const received = receipts.get(routine.id) || [];
    for (const { at, run } of received) {
      events.push({ key: `run:${run.id || at}`, routineId: routine.id, botId: routine.botId, at, duration: routine.durationMinutes, status: run.status, runId: run.id,
        kind: 'run', future: false, paused: false, routine });
    }
    const planned = covered.has(routine.id)
      ? serverByRoutine.get(routine.id).map(o => ({ at: o.at, duration: o.duration || routine.durationMinutes }))
      : projectOccurrences(routine, from, to).map(at => ({ at, duration: routine.durationMinutes }));
    for (const { at, duration } of planned) {
      // Drop a planned time a run already stands for (within a minute).
      if (received.some(r => Math.abs(r.at - at) < 60000)) continue;
      if (at < now - 60000 && !routine.enabled) continue;
      events.push({ key: `occ:${routine.id}:${at}`, routineId: routine.id, botId: routine.botId, at, duration, status: 'scheduled', runId: '',
        kind: 'occurrence', future: at >= now - 60000, paused: !routine.enabled, routine });
    }
  }
  return events.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

// -- Moving ---------------------------------------------------------------------------------------

export const isRecurring = schedule => schedule.kind !== 'once' && schedule.kind !== 'unknown';
// Cron and a windowed interval can be picked up too: dropping them opens their editor (moveRequest).
export const canDrag = schedule => ['once', 'daily', 'interval', 'cron'].includes(schedule.kind);

// What dropping `event` at `targetMs` asks for. scope: 'all' (every time it repeats) or 'next' (only the next run).
// Returns {patch:{schedule}} | {defer:{until}} | {editor:true} (cron, or an interval with a window) | {refuse:'text'}.
export function moveRequest(routine, fromMs, targetMs, scope = 'all') {
  const s = routine.schedule;
  if (s.kind === 'cron') return { editor: true };
  if (s.kind === 'limit_reset') return { refuse: 'This one follows your usage limit. Edit it to change that.' };
  if (s.kind === 'unknown') return { refuse: 'This schedule cannot be moved here.' };
  const target = new Date(targetMs).toISOString();
  if (s.kind === 'once') return { patch: { schedule: { kind: 'once', at: target } } };
  if (scope === 'next') return { defer: { until: target } };
  const zone = s.time_zone || localZone();
  if (s.kind === 'daily') {
    const to = zonedParts(targetMs, zone), from = zonedParts(fromMs, zone);
    const time = `${String(to.hour).padStart(2, '0')}:${String(to.minute).padStart(2, '0')}`;
    let weekdays = s.weekdays;
    if (weekdays && to.weekday !== from.weekday) {
      weekdays = [...new Set(weekdays.filter(d => d !== from.weekday).concat(to.weekday))].sort((a, b) => a - b);
      if (weekdays.length === 7) weekdays = null;
    }
    return { patch: { schedule: { kind: 'daily', time, ...(weekdays ? { weekdays } : {}), time_zone: zone } } };
  }
  // interval
  if (s.window) return { editor: true };
  const anchor = toMs(s.anchor_at) ?? fromMs;
  return { patch: { schedule: { ...scheduleBody(s), anchor_at: new Date(anchor + (targetMs - fromMs)).toISOString() } } };
}

function scheduleBody(s) {
  const out = { kind: s.kind };
  for (const [key, value] of Object.entries(s)) if (key !== 'kind' && value !== null && value !== undefined) out[key] = value;
  return out;
}

// -- DOM ------------------------------------------------------------------------------------------

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

const PHONE = '(max-width: 767px)';
const isPhone = () => typeof matchMedia === 'function' && matchMedia(PHONE).matches;

// Mount the calendar into `host`. ctx:
//   bots()              the visible bots [{id, name, color, avatar}]
//   botId()             the bot filter ('' for all)
//   fetchRange(from, to, botId) -> {routines, occurrences, runs}  (GET /api/bot-routines?from&to)
//   limitResets()       cached [{endpoint_id, name, resets_at, blocked}] for the markers
//   selectedKey()       the selected event key
//   onSelect(event)     an event was chosen
//   onEmptySlot({date, time})   an empty slot was clicked
//   patchRoutine(routine, body) -> Promise   PATCH with the routine's expected revision
//   deferRoutine(routine, until) -> Promise
//   openEditor(routine)
//   confirmScope(routine) -> Promise<'all'|'next'|null>
//   resetChoice(routine, marker, anchor) -> Promise   a drop on a limit-reset marker
//   avatar(bot, size, pose) -> node
//   signal
// Returns {dispose, refresh, setView, goto}.
export function mountCalendar(host, ctx) {
  const zone = localZone();
  const state = { view: isPhone() ? 'day' : 'week', anchor: Date.now(), data: { routines: [], occurrences: null, runs: [] }, version: 0, disposed: false, drag: null };
  const root = h('div', { class: 'bots-cal', 'data-view': state.view });
  const rail = h('aside', { class: 'bots-cal-rail', 'aria-label': 'Calendar dates and bots' });
  const main = h('div', { class: 'bots-cal-main' });
  const bar = h('div', { class: 'bots-cal-bar' });
  const scroller = h('div', { class: 'bots-cal-scroll', tabindex: '0', role: 'region', 'aria-label': 'Calendar' });
  main.append(bar, scroller);
  root.append(rail, main);
  host.replaceChildren(root);

  const bots = () => ctx.bots() || [];
  const botOf = id => bots().find(b => b.id === id);
  const live = () => !state.disposed;

  // ---- data
  async function load() {
    const at = ++state.version;
    const range = viewRange(state.view, state.anchor, zone);
    try {
      const data = await ctx.fetchRange(range.from, range.to, ctx.botId?.() || '');
      if (!live() || at !== state.version) return;
      state.data = { routines: data.routines, occurrences: data.occurrences, runs: data.runs };
    } catch { if (!live() || at !== state.version) return; }
    draw();
  }

  // ---- header bar
  function drawBar(range) {
    const first = range.days[0];
    const title = state.view === 'day'
      ? new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(first)
      : `Week of ${new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', timeZone: zone }).format(first)}`;
    const step = direction => () => { state.anchor = stepAnchor(state.view, state.anchor, direction, zone); load(); };
    bar.replaceChildren(
      h('div', { class: 'bots-cal-nav' }, [
        h('button', { type: 'button', class: 'bots-btn', text: 'Today', onclick: () => { state.anchor = Date.now(); load(); } }),
        h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': state.view === 'day' ? 'Previous day' : 'Previous week', onclick: step(-1) }, [icon('chevron-left', { size: 18 })]),
        h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': state.view === 'day' ? 'Next day' : 'Next week', onclick: step(1) }, [icon('chevron-right', { size: 18 })]),
        h('h2', { class: 'bots-cal-title', 'aria-live': 'polite', text: title }),
      ]),
      isPhone() ? null : h('div', { class: 'bots-segmented', role: 'radiogroup', 'aria-label': 'Calendar view' }, ['week', 'day'].map(value => h('button', {
        type: 'button', role: 'radio', 'aria-checked': state.view === value ? 'true' : 'false', 'data-view': value, text: value === 'week' ? 'Week' : 'Day',
        onclick: () => { state.view = value; root.dataset.view = value; load(); } }))),
    );
  }

  // ---- rail
  function drawRail() {
    const grid = monthGrid(state.anchor, zone);
    const today = dateKey(Date.now(), zone), selectedDay = dateKey(state.anchor, zone);
    const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: zone }).format(state.anchor);
    const monthStep = direction => () => {
      const p = zonedParts(state.anchor, zone);
      state.anchor = zonedWallToMs(p.year, p.month + direction, Math.min(p.day, 28), 12, 0, zone); load();
    };
    const month = h('div', { class: 'bots-cal-month' }, [
      h('div', { class: 'bots-cal-month-head' }, [
        h('span', { class: 'bots-cal-month-title', text: label }),
        h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Previous month', onclick: monthStep(-1) }, [icon('chevron-left', { size: 16 })]),
        h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Next month', onclick: monthStep(1) }, [icon('chevron-right', { size: 16 })]),
      ]),
      h('div', { class: 'bots-cal-month-grid', role: 'grid', 'aria-label': label }, [
        ...['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => h('span', { class: 'bots-cal-dow', 'aria-hidden': 'true', text: d, 'data-i': String(i) })),
        ...grid.flat().map(cell => {
          const key = dateKey(cell.ms + 3600000 * 12, zone);
          return h('button', { type: 'button', class: 'bots-cal-day', 'data-day': key, 'data-out': cell.inMonth ? undefined : '', 'data-today': key === today ? '' : undefined,
            'aria-pressed': key === selectedDay ? 'true' : 'false', 'aria-label': new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: zone }).format(cell.ms + 3600000 * 12),
            text: String(cell.day), onclick: () => { state.anchor = cell.ms + 3600000 * 12; load(); } });
        }),
      ]),
    ]);
    const counts = new Map();
    for (const r of state.data.routines) counts.set(r.botId, (counts.get(r.botId) || 0) + 1);
    const list = bots();
    const who = h('div', { class: 'bots-cal-bots' }, [
      h('div', { class: 'bots-caps', text: 'My bots' }),
      ...list.map(bot => h('div', { class: 'bots-cal-bot', 'data-bot-color': undefined, 'data-agent-id': bot.id }, [
        ctx.avatar(bot, 22), h('span', { class: 'bots-cal-bot-name', text: bot.name }),
        counts.get(bot.id) ? h('span', { class: 'bots-pill', text: String(counts.get(bot.id)) }) : null,
      ])),
    ]);
    rail.replaceChildren(month, who);
  }

  // ---- grid
  function eventNode(event, pack) {
    const bot = botOf(event.botId) || { id: event.botId, name: 'Bot' };
    const startParts = zonedParts(event.at, zone);
    const start = startParts.hour * 60 + startParts.minute;
    const box = eventBox(start, event.duration);
    const column = pack.get(event.key) || { col: 0, cols: 1 };
    const status = event.status === 'scheduled' ? (event.paused ? 'paused' : 'scheduled') : event.status;
    const needs = event.routine.checkTrouble || event.status === 'waiting' || event.routine.failureStreak >= 2;
    const draggable = event.kind === 'occurrence' && canDrag(event.routine.schedule) && event.future;
    const word = event.kind === 'run' ? RUN_WORDS[event.status] : (event.paused ? 'Paused' : 'Scheduled');
    const node = h('button', {
      type: 'button', class: 'bots-cal-event', 'data-key': event.key, 'data-routine-id': event.routineId, 'data-status': status,
      'data-kind': event.kind, 'data-bot-color': undefined, 'data-one-line': box.oneLine ? '' : undefined,
      'data-needs': needs ? '' : undefined, 'data-draggable': draggable ? '' : undefined,
      'aria-pressed': ctx.selectedKey?.() === event.key ? 'true' : 'false',
      'aria-label': `${event.routine.name}, ${bot.name}, ${clockOf(event.at, zone)}, ${word}`,
      style: `top:${box.top}px;height:${box.height}px;left:calc(${(column.col / column.cols) * 100}% + 2px);width:calc(${100 / column.cols}% - 4px);` });
    node.dataset.start = String(start);
    if (bot.color) { const key = String(bot.color).replace(/^#/, '').toLowerCase(); node.dataset.botColor = key; }
    const dot = h('span', { class: 'bots-cal-dot', 'data-state': needs ? 'needs_you' : event.paused ? 'paused' : event.status === 'running' ? 'working' : 'idle', 'aria-hidden': 'true' });
    node.append(
      h('span', { class: 'bots-cal-event-face' }, [ctx.avatar(bot, box.oneLine ? 14 : 20, kipForRun(event.status === 'scheduled' ? 'queued' : event.status))]),
      h('span', { class: 'bots-cal-event-text' }, [
        h('span', { class: 'bots-cal-event-title', text: event.routine.name }),
        box.oneLine ? null : h('span', { class: 'bots-cal-event-time', text: `${clockOf(event.at, zone)} · ${word}` }),
      ]),
      dot,
    );
    if (event.routine.call && event.kind === 'occurrence') node.append(h('span', { class: 'bots-cal-resize', 'data-resize': '', 'aria-hidden': 'true' }));
    return node;
  }

  function draw() {
    // A poll that lands mid-drag must not rebuild the block under the pointer.
    if (!live() || state.drag?.moved) return;
    const range = viewRange(state.view, state.anchor, zone);
    const now = Date.now();
    const routines = state.data.routines;
    const events = buildEvents(routines, { from: range.from, to: range.to, occurrences: state.data.occurrences, runs: state.data.runs, now });
    drawBar(range);
    drawRail();
    const today = dateKey(now, zone);
    const head = h('div', { class: 'bots-cal-head', style: `grid-template-columns: 56px repeat(${range.days.length}, minmax(0, 1fr));` }, [
      h('span', { class: 'bots-cal-gmt', text: gmtLabel(now) }),
      ...range.days.map(day => h('div', { class: 'bots-cal-dayhead', 'data-today': dateKey(day + 3600000 * 12, zone) === today ? '' : undefined }, [
        h('span', { class: 'bots-cal-dayname', text: WEEKDAYS[zonedParts(day + 3600000 * 12, zone).weekday] }),
        h('span', { class: 'bots-cal-daynum', text: String(zonedParts(day + 3600000 * 12, zone).day) }),
      ])),
    ]);
    const hours = h('div', { class: 'bots-cal-hours', 'aria-hidden': 'true' }, Array.from({ length: 24 }, (_, hour) =>
      h('span', { class: 'bots-cal-hour', style: `top:${hour * HOUR_PX}px`, text: hour ? clock12(`${hour}:00`).replace(':00', '') : '' })));
    const cols = range.days.map(day => {
      const dayEnd = nextDay(day, zone);
      const key = dateKey(day + 3600000 * 12, zone);
      const mine = events.filter(e => e.at >= day && e.at < dayEnd);
      const pack = packColumns(mine.map(e => { const p = zonedParts(e.at, zone); const s = p.hour * 60 + p.minute; return { key: e.key, start: s, end: s + Math.max(e.duration, 30) }; }));
      const col = h('div', { class: 'bots-cal-col', 'data-day': key, 'data-today': key === today ? '' : undefined, role: 'group',
        'aria-label': new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: zone }).format(day + 3600000 * 12) }, mine.map(e => eventNode(e, pack)));
      // Limit-reset markers: a dashed line where an account's usage resets.
      for (const marker of ctx.limitResets?.() || []) {
        const at = toMs(marker.resets_at ?? marker.resetsAt);
        if (at === null || at < day || at >= dayEnd) continue;
        const p = zonedParts(at, zone);
        col.append(h('div', { class: 'bots-cal-reset', 'data-endpoint': marker.endpoint_id, 'data-at': String(at), style: `top:${minutesToY(p.hour * 60 + p.minute)}px` }, [
          h('span', { class: 'bots-cal-reset-label' }, [icon('clock', { size: 12 }), `${marker.name || 'Your AI'} resets ${clockOf(at, zone)}`])]));
      }
      if (key === today) {
        const p = zonedParts(now, zone);
        col.append(h('div', { class: 'bots-cal-now', style: `top:${minutesToY(p.hour * 60 + p.minute)}px`, 'aria-hidden': 'true' }));
      }
      return col;
    });
    const body = h('div', { class: 'bots-cal-body', style: `height:${BODY_PX}px;grid-template-columns: 56px repeat(${range.days.length}, minmax(0, 1fr));` }, [hours, ...cols]);
    const keep = scroller.scrollTop, hadContent = scroller.childElementCount > 0;
    scroller.replaceChildren(head, body);
    if (hadContent) scroller.scrollTop = keep;
    else {
      const p = zonedParts(now, zone);
      scroller.scrollTop = Math.max(0, minutesToY(Math.max(0, (today === dateKey(range.days[0], zone) || range.days.some(d => dateKey(d + 3600000 * 12, zone) === today) ? p.hour * 60 : 7 * 60) - 120)));
    }
    state.geometry = { range, body };
    if (!events.length) body.append(h('p', { class: 'bots-cal-empty', text: routines.length ? 'Nothing is scheduled in this range.' : 'Nothing scheduled yet. Click a time to add a routine.' }));
  }

  function gmtLabel(ms) {
    const p = zonedParts(ms, zone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute), minutes = Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
    const sign = minutes < 0 ? '-' : '+', abs = Math.abs(minutes);
    return `GMT${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
  }

  // ---- pointer: click, drag to move, resize
  const columnAt = clientX => [...scroller.querySelectorAll('.bots-cal-col')].find(col => { const r = col.getBoundingClientRect(); return clientX >= r.left && clientX < r.right; });
  const minutesAt = (col, clientY, grab = 0) => yToMinutes(clientY - col.getBoundingClientRect().top - grab);
  const instantAt = (col, minutes) => {
    const [y, m, d] = col.dataset.day.split('-').map(Number);
    return minutes >= DAY_MIN ? nextDay(zonedWallToMs(y, m, d, 0, 0, zone), zone) : zonedWallToMs(y, m, d, Math.floor(minutes / 60), minutes % 60, zone);
  };
  const eventFor = node => {
    const key = node?.dataset.key;
    if (!key) return null;
    const range = viewRange(state.view, state.anchor, zone);
    return buildEvents(state.data.routines, { from: range.from, to: range.to, occurrences: state.data.occurrences, runs: state.data.runs, now: Date.now() }).find(e => e.key === key) || null;
  };

  let suppressClick = false;
  scroller.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const node = event.target.closest('.bots-cal-event');
    if (node) { const found = eventFor(node); if (found) ctx.onSelect?.(found); return; }
    const col = event.target.closest('.bots-cal-col');
    if (!col || event.target.closest('.bots-cal-reset')) return;
    const minutes = Math.min(DAY_MIN - 30, Math.floor(minutesAt(col, event.clientY) / 30) * 30);
    ctx.onEmptySlot?.({ date: col.dataset.day, time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` });
  });

  scroller.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    const node = event.target.closest('.bots-cal-event');
    if (!node || state.drag) return;
    const resizing = !!event.target.closest('[data-resize]');
    if (!resizing && !node.hasAttribute('data-draggable')) return;
    const found = eventFor(node);
    if (!found) return;
    const rect = node.getBoundingClientRect();
    state.drag = { node, event: found, resizing, startX: event.clientX, startY: event.clientY, grab: event.clientY - rect.top, moved: false, startTop: parseFloat(node.style.top), startHeight: parseFloat(node.style.height), target: null };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
  });

  function onMove(event) {
    const drag = state.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    drag.node.dataset.dragging = '';
    if (drag.resizing) {
      const minutes = resizeDuration(drag.event.duration, dy);
      drag.minutes = minutes;
      drag.node.style.height = `${Math.max(MIN_EVENT_PX, minutesToY(minutes))}px`;
      drag.node.dataset.duration = String(minutes);
      return;
    }
    const col = columnAt(event.clientX) || drag.target?.col;
    if (!col) return;
    const minutes = Math.min(DAY_MIN - SLOT_MIN, minutesAt(col, event.clientY, drag.grab));
    drag.target = { col, minutes };
    if (drag.node.parentElement !== col) col.append(drag.node);
    drag.node.style.top = `${minutesToY(minutes)}px`;
    drag.node.style.left = '2px'; drag.node.style.width = 'calc(100% - 4px)';
    drag.node.dataset.drop = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const marker = nearMarker(col, minutes);
    scroller.querySelectorAll('.bots-cal-reset[data-hot]').forEach(n => { if (n !== marker) n.removeAttribute('data-hot'); });
    if (marker) marker.setAttribute('data-hot', '');
  }

  const nearMarker = (col, minutes) => [...col.querySelectorAll('.bots-cal-reset')].find(n => Math.abs(parseFloat(n.style.top) - minutesToY(minutes)) <= 12);

  function stopDrag() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onCancel);
    scroller.querySelectorAll('.bots-cal-reset[data-hot]').forEach(n => n.removeAttribute('data-hot'));
    state.drag = null;
  }
  function onCancel() { const drag = state.drag; stopDrag(); if (drag?.moved) draw(); }

  async function onUp() {
    const drag = state.drag;
    stopDrag();
    if (!drag || !drag.moved) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const routine = drag.event.routine;
    try {
      if (drag.resizing) {
        if (drag.minutes && drag.minutes !== drag.event.duration) await ctx.patchRoutine(routine, { duration_minutes: drag.minutes });
        return;
      }
      if (!drag.target) return;
      const { col, minutes } = drag.target;
      const marker = nearMarker(col, minutes);
      if (marker) { await ctx.resetChoice?.(routine, { endpoint_id: marker.dataset.endpoint, at: Number(marker.dataset.at) }, drag.node); return; }
      const target = instantAt(col, minutes);
      if (Math.abs(target - drag.event.at) < 60000) return;
      const direct = moveRequest(routine, drag.event.at, target, 'all');
      if (direct.editor) { ctx.openEditor?.(routine); return; }
      if (direct.refuse) { ctx.say?.(direct.refuse); return; }
      let request = direct;
      if (isRecurring(routine.schedule)) {
        const scope = await ctx.confirmScope(routine, { next: Math.abs((routine.nextRunAt ?? 0) - drag.event.at) < 60000 });
        if (!scope) return;
        request = moveRequest(routine, drag.event.at, target, scope);
      }
      if (request.defer) await ctx.deferRoutine(routine, request.defer.until);
      else if (request.patch) await ctx.patchRoutine(routine, request.patch);
    } catch { /* the page already told the person */ }
    finally { if (live()) await load(); }
  }

  // The now line moves once a minute.
  const tick = setInterval(() => {
    if (!live() || document.hidden) return;
    const line = scroller.querySelector('.bots-cal-now');
    if (line) { const p = zonedParts(Date.now(), zone); line.style.top = `${minutesToY(p.hour * 60 + p.minute)}px`; }
  }, 60000);

  const onResize = () => {
    const phone = isPhone();
    const want = phone ? 'day' : state.view;
    if (want !== state.view) { state.view = want; root.dataset.view = want; load(); }
  };
  if (typeof matchMedia === 'function') matchMedia(PHONE).addEventListener?.('change', onResize);
  ctx.signal?.addEventListener('abort', () => dispose(), { once: true });

  function dispose() {
    if (state.disposed) return;
    state.disposed = true; clearInterval(tick); stopDrag();
    if (typeof matchMedia === 'function') matchMedia(PHONE).removeEventListener?.('change', onResize);
    host.replaceChildren();
  }

  load();
  return {
    dispose, refresh: load,
    setView(view) { state.view = view; root.dataset.view = view; return load(); },
    goto(ms) { state.anchor = ms; return load(); },
    selectionChanged() {
      const key = ctx.selectedKey?.();
      scroller.querySelectorAll('.bots-cal-event').forEach(n => n.setAttribute('aria-pressed', n.dataset.key === key ? 'true' : 'false'));
    },
  };
}

