// Bots mode: the automations model (Agents 3.0 Phase 3, unit U3).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md sections 4.2, 4.3, 6 and 7; OMB F52, F55, F56.
//
// Pure functions, no DOM and no imports, so scripts/test_bots_automation_model.cjs loads this file in plain Node.
// The page, the editors and the calendar draw what this file decides: how a routine, a webhook or an app event
// reads as one list row, which status word it gets, which single fix it offers, how rows sort, and how an editor's
// draft becomes the request body.
//
// This file never decides when anything runs. Schedules are the routine engine's (services/bot_routines.py);
// the editor asks POST /api/bot-routines/preview for the sentence and the next three times. The one calculation
// kept here is for DRAWING the calendar (botsAutomationCalendar.js), and it yields to occurrences the server sends.
//
// Record shapes. The API returns the normalized routine of the design (a task carrying a `routine` object); this
// file reads that, or the flat form, or an old bot goal (schedule_kind, run_time, interval_seconds, run_at), so a
// routine that has not been migrated yet still shows up and edits.

export const STATUS_ORDER = ['needs_you', 'working', 'paused', 'done'];
export const STATUS_WORDS = { needs_you: 'Needs you', working: 'Working', paused: 'Paused', done: 'Done' };
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const BOT_FILTER_FROM = 9;       // OMB F55: the bot filter appears from nine automations, with more than one bot
export const RECENT_RUNS = 5;
export const LIMITS = { name: 80, prompt: 20000, minutes: [5, 1440], block: [5, 240], cron: 256, attachments: 20 };

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

// -- Time -----------------------------------------------------------------------------------------

// ISO text, epoch milliseconds or epoch seconds, as milliseconds (or null).
export function toMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e11 ? Math.round(value * 1000) : Math.round(value)) : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

export function localZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

// The parts of an instant as seen in a named zone: {year, month, day, hour, minute, weekday} with Monday = 0.
export function zonedParts(ms, zone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone || localZone(), hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, weekday };
}

// A wall-clock time in a named zone as an instant (ms). A time that does not exist (spring forward) moves ahead;
// one that happens twice (fall back) takes the first, as the engine does (design 4.2, 5.4).
export function zonedWallToMs(year, month, day, hour, minute, zone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = ms => {
    const p = zonedParts(ms, zone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
  };
  let guess = wall - offsetAt(wall);
  const again = wall - offsetAt(guess);
  if (again !== guess) {
    // The offset changed between the two guesses: a transition sits here. Prefer the earlier valid instant.
    const earlier = Math.min(guess, again);
    const p = zonedParts(earlier, zone);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return earlier;
    guess = Math.max(guess, again);
  }
  return guess;
}

const pad = n => String(n).padStart(2, '0');
export const dateKey = (ms, zone) => { const p = zonedParts(ms, zone); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
export const timeKey = (ms, zone) => { const p = zonedParts(ms, zone); return `${pad(p.hour)}:${pad(p.minute)}`; };

export function parseHHMM(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? { hour: +match[1], minute: +match[2] } : null;
}

// "9:00 AM" from "09:00".
export function clock12(value) {
  const t = parseHHMM(value);
  if (!t) return String(value || '');
  const hour = t.hour % 12 || 12;
  return `${hour}:${pad(t.minute)} ${t.hour < 12 ? 'AM' : 'PM'}`;
}

export function clockOf(ms, zone) {
  return clock12(timeKey(ms, zone));
}

// A plain name for a zone: "Eastern Time". Falls back to the zone id.
export function zoneName(zone) {
  if (!zone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' }).formatToParts(new Date());
    const name = parts.find(p => p.type === 'timeZoneName')?.value || '';
    return name.replace(/ (Standard|Daylight|Summer) Time$/, ' Time') || zone;
  } catch { return zone; }
}

// "just now", "5 min ago", "2 h ago", "3 d ago" / "in 5 min", "in 2 h", "tomorrow", "in 3 d".
export function relative(ms, now = Date.now()) {
  if (ms === null || ms === undefined) return '';
  const gap = ms - now, abs = Math.abs(gap);
  const minutes = Math.round(abs / 60000);
  if (abs < 60000) return gap >= 0 ? 'in under a minute' : 'just now';
  let span;
  if (minutes < 60) span = `${minutes} min`;
  else if (minutes < 1440) span = `${Math.round(minutes / 60)} h`;
  else span = `${Math.round(minutes / 1440)} d`;
  return gap >= 0 ? `in ${span}` : `${span} ago`;
}

// "Today 9:00 AM", "Tomorrow 9:00 AM", "Mon 9:00 AM", "Nov 3, 9:00 AM": the form used in rows and details.
export function whenText(ms, now = Date.now(), zone) {
  if (ms === null || ms === undefined) return '';
  const day = dateKey(ms, zone), today = dateKey(now, zone);
  const clockText = clockOf(ms, zone);
  if (day === today) return `Today ${clockText}`;
  if (day === dateKey(now + 86400000, zone)) return `Tomorrow ${clockText}`;
  const distance = (ms - now) / 86400000;
  if (distance > 0 && distance < 6) return `${WEEKDAYS[zonedParts(ms, zone).weekday]} ${clockText}`;
  const date = new Date(ms);
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: zone || localZone() }).format(date);
  return `${month} ${zonedParts(ms, zone).day}, ${clockText}`;
}

// The same, for the middle of a sentence: "resets today 6:34 AM", "next tomorrow 9:00 AM".
export function whenMid(ms, now = Date.now(), zone) {
  return whenText(ms, now, zone).replace(/^(Today|Tomorrow)\b/, m => m.toLowerCase());
}

// -- Schedules --------------------------------------------------------------------------------------

function weekdayList(value) {
  if (!Array.isArray(value)) return null;
  const days = [...new Set(value.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  return days.length && days.length < 7 ? days : null;
}

// The tagged union of design 4.2, from the new shape or an old bot goal.
export function normalizeSchedule(raw, legacy = {}) {
  if (isObject(raw) && typeof raw.kind === 'string') {
    const kind = raw.kind;
    const zone = text(raw.time_zone ?? raw.timeZone) || null;
    if (kind === 'once') return { kind, at: text(raw.at) };
    if (kind === 'daily') return { kind, time: text(raw.time), weekdays: weekdayList(raw.weekdays), time_zone: zone };
    if (kind === 'interval') {
      const window = isObject(raw.window) && raw.window.start && raw.window.end ? { start: text(raw.window.start), end: text(raw.window.end) } : null;
      return { kind, every_minutes: Number(raw.every_minutes ?? raw.everyMinutes) || 0, anchor_at: text(raw.anchor_at ?? raw.anchorAt) || null,
        weekdays: weekdayList(raw.weekdays), window, ends_at: text(raw.ends_at ?? raw.endsAt) || null, time_zone: zone };
    }
    if (kind === 'cron') return { kind, expression: text(raw.expression), time_zone: zone };
    if (kind === 'limit_reset') return { kind, endpoint_id: text(raw.endpoint_id ?? raw.endpointId), repeat: raw.repeat === 'every_reset' ? 'every_reset' : 'once' };
    return { kind: 'unknown' };
  }
  const kind = legacy.schedule_kind;
  if (kind === 'daily') return { kind: 'daily', time: text(legacy.run_time), weekdays: weekdayList(legacy.weekdays), time_zone: text(legacy.time_zone) || null };
  if (kind === 'interval') return { kind: 'interval', every_minutes: Math.round((legacy.interval_seconds || 0) / 60), anchor_at: null, weekdays: null, window: null, ends_at: null, time_zone: text(legacy.time_zone) || null };
  if (kind === 'once') return { kind: 'once', at: text(legacy.run_at) };
  return { kind: 'unknown' };
}

function everyText(minutes) {
  if (minutes === 60) return 'hour';
  if (minutes % 60 === 0 && minutes > 60) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function daysText(days) {
  if (!days) return '';
  if (days.length === 5 && days.every((d, i) => d === i)) return 'weekday';
  if (days.length === 2 && days[0] === 5 && days[1] === 6) return 'weekend day';
  return days.map(d => WEEKDAYS_LONG[d]).join(', ');
}

// "Every weekday at 9:00 AM (Eastern Time)". The server's preview sentence wins when the editor has one.
export function describeSchedule(schedule, { now = Date.now(), showZone = true } = {}) {
  const s = schedule || { kind: 'unknown' };
  const zone = showZone && s.time_zone && s.time_zone !== localZone() ? ` (${zoneName(s.time_zone)})` : '';
  if (s.kind === 'once') {
    const ms = toMs(s.at);
    return ms === null ? 'Once' : `Once, ${whenMid(ms, now, s.time_zone || undefined)}`;
  }
  if (s.kind === 'daily') {
    const days = daysText(s.weekdays);
    return `Every ${days || 'day'} at ${clock12(s.time)}${zone}`;
  }
  if (s.kind === 'interval') {
    let out = `Every ${everyText(s.every_minutes)}`;
    const days = daysText(s.weekdays);
    if (days) out += ` on ${days === 'weekday' ? 'weekdays' : days === 'weekend day' ? 'weekends' : days}`;
    if (s.window) out += `, ${clock12(s.window.start)} to ${clock12(s.window.end)}`;
    return out + zone;
  }
  if (s.kind === 'cron') return `On a custom schedule (${s.expression})${zone}`;
  if (s.kind === 'limit_reset') return s.repeat === 'every_reset' ? 'After every usage limit reset' : 'After the next usage limit reset';
  return 'On a schedule';
}

// -- Routines ---------------------------------------------------------------------------------------

export function normalizeRun(raw) {
  if (!isObject(raw)) return null;
  const status = text(raw.automation_status ?? raw.status ?? raw.outcome) || 'completed';
  const mapped = { ok: 'completed', success: 'completed', done: 'completed', error: 'failed', skipped: 'missed' }[status] || status;
  return {
    id: text(raw.id ?? raw.run_id),
    routineId: text(raw.routine_id ?? raw.task_id),
    botId: text(raw.agent_id ?? raw.bot_id),
    status: mapped,
    trigger: text(raw.trigger_type ?? raw.trigger ?? raw.source) || 'schedule',
    scheduledAt: toMs(raw.scheduled_at ?? raw.scheduled_for),
    startedAt: toMs(raw.started_at ?? raw.at),
    finishedAt: toMs(raw.finished_at ?? raw.ended_at),
    threadId: text(raw.thread_id ?? raw.execution_thread_id ?? raw.session_id) || null,
    summary: text(raw.output ?? raw.summary).slice(0, 2000),
    error: text(raw.error).slice(0, 500),
    cause: text(raw.cause ?? raw.retry_cause ?? raw.error_cause),
    attention: !!raw.attention && !raw.seen && !raw.seen_at,
    seen: !!raw.seen || !!raw.seen_at,
  };
}

export function normalizeRoutine(raw) {
  if (!isObject(raw)) return null;
  const r = isObject(raw.routine) ? { ...raw, ...raw.routine } : raw;
  const status = isObject(r.status_fields) ? r.status_fields : isObject(r.status) ? r.status : {};
  const runs = (Array.isArray(r.recent_runs) ? r.recent_runs : Array.isArray(r.runs) ? r.runs : []).map(normalizeRun).filter(Boolean);
  runs.sort((a, b) => (b.startedAt ?? b.scheduledAt ?? 0) - (a.startedAt ?? a.scheduledAt ?? 0));
  const lastRun = normalizeRun(r.last_run) || runs[0] || null;
  const enabled = r.enabled !== false;
  const get = (...keys) => { for (const key of keys) { if (r[key] !== undefined) return r[key]; if (status[key] !== undefined) return status[key]; } return undefined; };
  return {
    id: text(r.id),
    botId: text(r.agent_id ?? r.bot_id),
    name: text(r.name),
    prompt: text(r.prompt ?? r.instructions),
    enabled,
    schedule: normalizeSchedule(r.schedule, r),
    revision: Number.isInteger(r.revision) ? r.revision : (Number.isInteger(raw.revision) ? raw.revision : 0),
    durationMinutes: Number(r.duration_minutes) || 30,
    timeoutMinutes: Number(r.timeout_minutes) || null,
    overlap: r.overlap === 'queue' ? 'queue' : 'skip',
    continuity: !!r.continuity,
    runOnStartup: !!r.run_on_startup,
    sourceThreadId: text(r.source_thread_id) || null,
    resultsThreadId: text(r.results_thread_id) || null,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    checks: Array.isArray(r.checks) ? r.checks.filter(c => ['calendar', 'mail', 'runs'].includes(c)) : [],
    access: r.access === 'read-and-draft' ? 'read-and-draft' : 'normal',
    deliver: text(r.deliver) || 'normal',
    call: !!r.call,
    sentence: text(r.sentence),
    nextRunAt: toMs(get('next_run_at', 'nextRunAt', 'next_at')),
    wakeAt: toMs(get('wake_at', 'wakeAt')),
    skippedRuns: Number(get('skipped_runs', 'skippedRuns')) || 0,
    skippedToday: Number(get('skipped_today', 'skippedToday')) || 0,
    checkTrouble: text(get('check_trouble', 'checkTrouble')) || (isObject(get('check_trouble', 'checkTrouble')) ? 'trouble' : ''),
    checkCause: text(isObject(get('check_trouble', 'checkTrouble')) ? get('check_trouble', 'checkTrouble').cause : ''),
    quietCheck: !!get('quiet_check', 'quietCheck'),
    failureStreak: Number(get('failure_streak', 'failureStreak')) || 0,
    weekRuns: isObject(get('week_runs', 'weekRuns')) ? get('week_runs', 'weekRuns') : null,
    warning: text(get('warning')),
    lastRun,
    runs,
    waitingRunId: text(get('waiting_run_id', 'waitingRunId')) || (lastRun?.status === 'waiting' ? lastRun.id : '') || (runs.find(run => run.status === 'waiting')?.id || ''),
    runningRunId: text(get('running_run_id', 'runningRunId')) || (runs.find(run => run.status === 'running')?.id || ''),
  };
}

// -- The unified list -------------------------------------------------------------------------------

// Causes the person can fix, mapped to the one button each offers (OMB F55, automations.ts needs-you rules).
const SIGN_IN = /sign.?in|signed.?out|login|auth/i;
const LIMIT = /usage|limit|credit|quota|billing/i;
const SETUP = /setup|config|missing|invalid/i;

function fixFor(item) {
  if (item.fix && item.fix.kind) return { kind: item.fix.kind, label: item.fix.label || FIX_LABELS[item.fix.kind] || 'Fix', runId: item.fix.run_id || item.fix.runId || '' };
  return null;
}
const FIX_LABELS = { open_run: 'Open the run', usage: 'See usage', edit: 'Edit', reconnect: 'Reconnect', run: 'Run now' };

// What is wrong, if anything, as {reason, fix:{kind,label,runId}}; null when the automation is fine.
export function trouble(item) {
  const given = item.fix && item.fix.kind ? { reason: text(item.reason) || 'Needs your attention', fix: fixFor(item) } : null;
  if (item.status === 'needs_you') return given || { reason: text(item.reason) || 'Needs your attention', fix: { kind: 'edit', label: FIX_LABELS.edit, runId: '' } };
  if (item.kind === 'app' || item.kind === 'webhook') {
    const t = item.trigger || {};
    if (t.problem || item.problem) return { reason: text(t.problem || item.problem), fix: { kind: item.kind === 'app' ? 'reconnect' : 'edit', label: item.kind === 'app' ? FIX_LABELS.reconnect : FIX_LABELS.edit, runId: '' } };
    return null;
  }
  const r = item.routine;
  if (!r) return given;
  if (r.checkTrouble) {
    const reconnect = SIGN_IN.test(r.checkCause || r.checkTrouble);
    return { reason: `A check had trouble: ${r.checkTrouble}`.slice(0, 120), fix: { kind: reconnect ? 'reconnect' : 'edit', label: reconnect ? FIX_LABELS.reconnect : FIX_LABELS.edit, runId: '' } };
  }
  const last = r.lastRun;
  if (r.waitingRunId || last?.status === 'waiting') return { reason: 'Waiting for your answer', fix: { kind: 'open_run', label: 'Answer', runId: r.waitingRunId || last?.id || '' } };
  if (last && (last.status === 'failed' || last.status === 'missed') && !last.seen) {
    const cause = `${last.cause} ${last.error}`;
    if (SIGN_IN.test(cause)) return { reason: 'Signed out', fix: { kind: 'open_run', label: 'Sign in', runId: last.id } };
    if (LIMIT.test(cause)) return { reason: 'Hit a usage limit', fix: { kind: 'usage', label: FIX_LABELS.usage, runId: '' } };
    if (SETUP.test(cause)) return { reason: 'Needs setup', fix: { kind: 'edit', label: FIX_LABELS.edit, runId: '' } };
  }
  if (r.failureStreak >= 2) return { reason: `Failed ${r.failureStreak} times in a row`, fix: { kind: 'run', label: FIX_LABELS.run, runId: '' } };
  return given;
}

export function statusOf(item) {
  if (item.kind === 'routine' || !item.kind) {
    if (trouble(item)) return 'needs_you';
  } else if (trouble(item)) return 'needs_you';
  if (item.enabled === false) return 'paused';
  const r = item.routine;
  if (r && r.schedule.kind === 'once' && r.lastRun?.status === 'completed' && !r.nextRunAt) return 'done';
  if (item.status === 'done') return 'done';
  return 'working';
}

// One list row from one record of GET /api/bot-automations:
// {kind:'routine'|'webhook'|'app', id, bot_id, name, sentence?, enabled, status?, reason?, fix?, routine?|trigger?, ...}
export function automationItem(raw, { botName = () => '', now = Date.now() } = {}) {
  if (!isObject(raw)) return null;
  const kind = ['webhook', 'app'].includes(raw.kind) ? raw.kind : 'routine';
  const routine = kind === 'routine' ? normalizeRoutine(raw.routine ? { ...raw.routine, id: raw.id ?? raw.routine.id, agent_id: raw.bot_id ?? raw.agent_id ?? raw.routine.agent_id, enabled: raw.enabled ?? raw.routine.enabled, name: raw.name ?? raw.routine.name } : raw) : null;
  const trigger = kind === 'routine' ? null : (isObject(raw.trigger) ? raw.trigger : isObject(raw.webhook) ? raw.webhook : raw);
  const item = {
    key: `${kind}:${text(raw.id)}`,
    kind,
    id: text(raw.id),
    botId: text(raw.bot_id ?? raw.agent_id ?? trigger?.agent_id),
    name: text(raw.name) || routine?.name || text(trigger?.name) || 'Untitled automation',
    enabled: (raw.enabled ?? routine?.enabled ?? trigger?.enabled) !== false,
    status: text(raw.status),
    reason: text(raw.reason),
    fix: isObject(raw.fix) ? raw.fix : null,
    problem: text(raw.problem ?? trigger?.problem),
    routine,
    trigger,
    sentence: '',
    raw,
  };
  item.botName = botName(item.botId) || 'A bot';
  item.sentence = text(raw.sentence) || routine?.sentence || sentenceFor(item);
  const t = trouble(item);
  item.status = statusOf(item);
  item.trouble = t;
  item.statusWord = STATUS_WORDS[item.status];
  item.nextAt = kind === 'routine' ? (routine.enabled ? routine.nextRunAt : null) : toMs(raw.next_at);
  item.lastAt = kind === 'routine' ? (routine.lastRun ? (routine.lastRun.finishedAt ?? routine.lastRun.startedAt) : null) : toMs(raw.last_event_at ?? raw.last_at ?? trigger?.last_event_at);
  item.timing = timingLine(item, now);
  return item;
}

// "Every weekday at 9:00 AM, Scout follows: Check my inbox" in one plain sentence.
export function sentenceFor(item) {
  const bot = item.botName || 'A bot';
  if (item.kind === 'routine' && item.routine) {
    const what = firstLine(item.routine.prompt) || item.routine.name;
    return `${describeSchedule(item.routine.schedule)}, ${bot} follows: ${what}`;
  }
  const t = item.trigger || {};
  const what = firstLine(t.prompt_template ?? t.instructions) || item.name;
  if (item.kind === 'app') return `When something happens in ${text(t.app_name || t.app) || 'an app'}, ${bot} follows: ${what}`;
  return `When another app calls, ${bot} follows: ${what}`;
}

export function firstLine(value, max = 90) {
  const line = String(value || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}...` : line;
}

// The grey line under a row: next, last ran, "checked, nothing new", skipped today.
export function timingLine(item, now = Date.now()) {
  const parts = [];
  if (item.trouble && item.status === 'needs_you') parts.push(item.trouble.reason);
  if (item.kind === 'routine' && item.routine) {
    const r = item.routine;
    if (r.runningRunId) parts.push('Running now');
    else if (item.enabled && item.nextAt) parts.push(`Next ${whenMid(item.nextAt, now)}`);
    else if (!item.enabled) parts.push('Paused');
    if (item.lastAt) parts.push(r.quietCheck ? 'Checked, nothing new' : `Last ran ${relative(item.lastAt, now)}`);
    if (r.skippedToday) parts.push(`Skipped ${r.skippedToday} today`);
  } else {
    if (item.lastAt) parts.push(`Last event ${relative(item.lastAt, now)}`);
    else if (item.enabled) parts.push('Nothing has arrived yet');
    else parts.push('Paused');
    const skipped = Number(item.raw?.skipped_today) || 0;
    if (skipped) parts.push(`Skipped ${skipped} today`);
  }
  return parts.join(' · ');
}

// Needs-you first, then working, paused, done; then next time soonest; then name (case-blind).
export function compareItems(a, b) {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (byStatus) return byStatus;
  const an = a.nextAt ?? Infinity, bn = b.nextAt ?? Infinity;
  if (an !== bn) return an < bn ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key);
}

export function buildItems(rawList, options = {}) {
  return (Array.isArray(rawList) ? rawList : []).map(raw => automationItem(raw, options)).filter(Boolean).sort(compareItems);
}

export function filterItems(items, botId) {
  return botId ? items.filter(item => item.botId === botId) : items;
}

// The bot filter shows from nine automations when there is more than one bot.
export function showBotFilter(itemCount, botCount) {
  return itemCount >= BOT_FILTER_FROM && botCount > 1;
}

// The unseen-problem count for a sidebar dot or the page heading.
export function needsYouCount(items) { return items.filter(item => item.status === 'needs_you').length; }

// -- The editor's draft -----------------------------------------------------------------------------

export const REPEATS = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
];
export const ADVANCED_REPEATS = [
  ...REPEATS,
  { value: 'interval', label: 'Every so many minutes' },
  { value: 'cron', label: 'Custom schedule' },
  { value: 'limit_reset', label: 'When my usage limit resets' },
];
export const CRON_PRESETS = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Weekdays at 9:00 AM', expression: '0 9 * * 1-5' },
  { label: 'First of the month', expression: '0 9 1 * *' },
  { label: 'Last day of the month', expression: '0 9 L * *' },
];

export function emptyDraft(botId = '', now = Date.now()) {
  const zone = localZone();
  const start = Math.ceil((now + 3600000) / 3600000) * 3600000;   // the top of the next hour
  return {
    id: '', revision: 0, botId, name: '', prompt: '',
    repeat: 'daily', date: dateKey(start, zone), time: timeKey(start, zone), weekdays: [],
    everyMinutes: 60, windowOn: false, windowStart: '09:00', windowEnd: '17:00', endsOn: '',
    cron: '0 9 * * 1-5', timeZone: zone, endpointId: '', resetRepeat: 'once',
    durationMinutes: 30, timeoutMinutes: '', overlap: 'skip', runOnStartup: false, continuity: false,
    resultsThreadId: '', access: 'normal', enabled: true, call: false,
  };
}

// An editor draft from a normalized routine. A non-simple repeat stays what it is.
export function draftFromRoutine(routine, now = Date.now()) {
  const draft = { ...emptyDraft(routine.botId, now), id: routine.id, revision: routine.revision, name: routine.name, prompt: routine.prompt,
    durationMinutes: routine.durationMinutes, timeoutMinutes: routine.timeoutMinutes || '', overlap: routine.overlap, runOnStartup: routine.runOnStartup,
    continuity: routine.continuity, resultsThreadId: routine.resultsThreadId || '', access: routine.access, enabled: routine.enabled, call: routine.call };
  const s = routine.schedule;
  const zone = s.time_zone || localZone();
  draft.timeZone = zone;
  if (s.kind === 'once') {
    const ms = toMs(s.at);
    draft.repeat = 'once';
    if (ms !== null) { draft.date = dateKey(ms, zone); draft.time = timeKey(ms, zone); }
  } else if (s.kind === 'daily') {
    draft.time = (parseHHMM(s.time) ? s.time.padStart(5, '0') : draft.time);
    const days = s.weekdays;
    draft.weekdays = days || [];
    draft.repeat = !days ? 'daily' : days.length === 5 && days.every((d, i) => d === i) ? 'weekdays' : 'weekly';
  } else if (s.kind === 'interval') {
    draft.repeat = 'interval';
    draft.everyMinutes = s.every_minutes || 60;
    draft.weekdays = s.weekdays || [];
    if (s.window) { draft.windowOn = true; draft.windowStart = s.window.start; draft.windowEnd = s.window.end; }
    const anchor = toMs(s.anchor_at);
    if (anchor !== null) { draft.date = dateKey(anchor, zone); draft.time = timeKey(anchor, zone); }
    const ends = toMs(s.ends_at);
    if (ends !== null) draft.endsOn = dateKey(ends, zone);
  } else if (s.kind === 'cron') {
    draft.repeat = 'cron'; draft.cron = s.expression;
  } else if (s.kind === 'limit_reset') {
    draft.repeat = 'limit_reset'; draft.endpointId = s.endpoint_id; draft.resetRepeat = s.repeat;
  }
  return draft;
}

// "2026-11-03" + "09:00" in a zone as an RFC3339 instant, or null when either part is not valid.
export function instantFor(date, time, zone) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const t = parseHHMM(time);
  if (!d || !t) return null;
  return new Date(zonedWallToMs(+d[1], +d[2], +d[3], t.hour, t.minute, zone || localZone())).toISOString();
}

export function scheduleFromDraft(draft) {
  const zone = draft.timeZone || localZone();
  const days = repeatDays(draft);
  switch (draft.repeat) {
    case 'once': return { kind: 'once', at: instantFor(draft.date, draft.time, zone) };
    case 'daily': case 'weekdays': case 'weekly': {
      return { kind: 'daily', time: draft.time, ...(days ? { weekdays: days } : {}), time_zone: zone };
    }
    case 'interval': {
      const out = { kind: 'interval', every_minutes: Number(draft.everyMinutes), anchor_at: instantFor(draft.date, draft.time, zone), time_zone: zone };
      if (days) out.weekdays = days;
      if (draft.windowOn) out.window = { start: draft.windowStart, end: draft.windowEnd };
      if (draft.endsOn) out.ends_at = instantFor(draft.endsOn, '23:59', zone);
      return out;
    }
    case 'cron': return { kind: 'cron', expression: String(draft.cron || '').trim().split(/\s+/).join(' '), time_zone: zone };
    case 'limit_reset': return { kind: 'limit_reset', endpoint_id: draft.endpointId, repeat: draft.resetRepeat === 'every_reset' ? 'every_reset' : 'once' };
    default: return null;
  }
}

function repeatDays(draft) {
  if (draft.repeat === 'weekdays') return [0, 1, 2, 3, 4];
  if (draft.repeat === 'weekly' || draft.repeat === 'interval') return weekdayList(draft.weekdays);
  return null;
}

// Field errors for the editor: {field: message}. Empty means it may be sent. The server still decides.
export function validateDraft(draft, now = Date.now()) {
  const errors = {};
  const name = String(draft.name || '').trim();
  if (!draft.botId) errors.bot = 'Choose a bot.';
  if (!name) errors.name = 'Give it a name.';
  else if (name.length > LIMITS.name) errors.name = `Keep the name to ${LIMITS.name} characters.`;
  const prompt = String(draft.prompt || '').trim();
  if (!prompt) errors.prompt = 'Say what the bot should do.';
  else if (prompt.length > LIMITS.prompt) errors.prompt = `Keep the instructions to ${LIMITS.prompt.toLocaleString('en-US')} characters.`;
  const repeat = draft.repeat;
  if (['once', 'interval'].includes(repeat) && !instantFor(draft.date, draft.time, draft.timeZone)) errors.date = 'Pick a date and time.';
  if (['daily', 'weekdays', 'weekly'].includes(repeat) && !parseHHMM(draft.time)) errors.time = 'Pick a time.';
  if (repeat === 'once' && !errors.date && toMs(instantFor(draft.date, draft.time, draft.timeZone)) <= now) errors.date = 'That time has passed. Pick a later one.';
  if (repeat === 'weekly' && !weekdayList(draft.weekdays)) errors.weekdays = 'Pick the days.';
  if (repeat === 'interval') {
    const every = Number(draft.everyMinutes);
    if (!Number.isInteger(every) || every < LIMITS.minutes[0] || every > LIMITS.minutes[1]) errors.everyMinutes = `Use a whole number from ${LIMITS.minutes[0]} to ${LIMITS.minutes[1]}.`;
    if (draft.windowOn) {
      const a = parseHHMM(draft.windowStart), b = parseHHMM(draft.windowEnd);
      if (!a || !b) errors.window = 'Pick when the window starts and ends.';
      else {
        const span = (b.hour * 60 + b.minute) - (a.hour * 60 + a.minute);
        if (span <= 0) errors.window = 'The window has to end later the same day. For an overnight window, make two routines.';
        else if (!errors.everyMinutes && span < every) errors.window = 'The window must be at least as long as the gap between runs.';
      }
    }
  }
  if (repeat === 'cron') {
    const expression = String(draft.cron || '').trim();
    const fields = expression.split(/\s+/).filter(Boolean);
    if (!expression) errors.cron = 'Enter a schedule.';
    else if (expression.length > LIMITS.cron) errors.cron = `Keep it to ${LIMITS.cron} characters.`;
    else if (fields.length !== 5) errors.cron = 'Use five fields: minute, hour, day, month, weekday.';
    if (!String(draft.timeZone || '').trim()) errors.timeZone = 'Name a time zone, like America/New_York.';
  }
  if (repeat === 'limit_reset' && !String(draft.endpointId || '').trim()) errors.endpointId = 'Choose which limit.';
  const block = Number(draft.durationMinutes);
  if (!Number.isInteger(block) || block < LIMITS.block[0] || block > LIMITS.block[1]) errors.durationMinutes = `Use a whole number from ${LIMITS.block[0]} to ${LIMITS.block[1]}.`;
  if (draft.timeoutMinutes !== '' && draft.timeoutMinutes !== null) {
    const limit = Number(draft.timeoutMinutes);
    if (!Number.isInteger(limit) || limit < LIMITS.block[0] || limit > LIMITS.block[1]) errors.timeoutMinutes = `Use a whole number from ${LIMITS.block[0]} to ${LIMITS.block[1]}, or leave it empty.`;
  }
  return errors;
}

// The POST/PATCH body. `expected_revision` rides on edits so a stale save is refused, not merged.
export function bodyFromDraft(draft) {
  const body = {
    name: String(draft.name || '').trim(),
    prompt: String(draft.prompt || '').trim(),
    schedule: scheduleFromDraft(draft),
    enabled: draft.enabled !== false,
    duration_minutes: Number(draft.durationMinutes) || 30,
    timeout_minutes: draft.timeoutMinutes === '' || draft.timeoutMinutes === null ? null : Number(draft.timeoutMinutes),
    overlap: draft.overlap === 'queue' ? 'queue' : 'skip',
    continuity: !!draft.continuity,
    run_on_startup: !!draft.runOnStartup,
    results_thread_id: draft.resultsThreadId || null,
    access: draft.access === 'read-and-draft' ? 'read-and-draft' : 'normal',
    call: !!draft.call,
  };
  if (draft.id) body.expected_revision = draft.revision;
  else body.bot_id = draft.botId;
  return body;
}

export function previewBody(draft) {
  const body = { bot_id: draft.botId || undefined, schedule: scheduleFromDraft(draft) };
  if (draft.id) body.routine_id = draft.id;
  return body;
}

// A server refusal as {field, message}: `field` names an editor field when the server says which.
export function refusalOf(error) {
  const raw = String(error?.message || error || '');
  const match = /^(\d{3}):\s*(.*)$/s.exec(raw);
  return { status: match ? +match[1] : 0, message: (match ? match[2] : raw).trim() || 'That did not save. Try again.' };
}

// -- Events and attempts -----------------------------------------------------------------------------

// Attempt and event receipts, newest first, one per delivery id, at most `limit` (design 6: show the latest 30).
export function dedupeAttempts(list, limit = 30) {
  const seen = new Set(), out = [];
  const rows = (Array.isArray(list) ? list : []).map(a => ({ ...a, at: toMs(a.at ?? a.created_at ?? a.received_at) }));
  rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  for (const row of rows) {
    const key = row.delivery_id || row.id || `${row.at}:${row.outcome}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export const ATTEMPT_WORDS = {
  accepted: ['Started a run', 'ok'], captured: ['Saved as a sample', 'ok'], duplicate: ['Already received', 'muted'], ignored: ['Filtered out', 'muted'],
  rejected: ['Turned away', 'bad'], rate_limited: ['Too many at once', 'bad'], paused: ['Paused', 'muted'], failed: ['Failed', 'bad'],
  started: ['Started a run', 'ok'], joined: ['Joined a waiting run', 'ok'], filtered: ['Filtered out', 'muted'], skipped: ['Skipped', 'muted'],
};
export function attemptWord(outcome) { return ATTEMPT_WORDS[outcome] || [String(outcome || 'Unknown'), 'muted']; }

// Run status as the word and the Kip state the calendar card shows (design 7, OMB F56).
export const RUN_WORDS = { queued: 'Queued', running: 'Running', waiting: 'Waiting for you', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled', missed: 'Missed' };
export const RUN_KIP = { running: 'thinking', waiting: 'needs', completed: 'success', failed: 'error', missed: 'error', cancelled: 'sleeping', queued: 'idle' };
export const kipForRun = status => RUN_KIP[status] || 'idle';

// -- Usage limits (design 5.4 and 6: GET /api/bot-limit-resets, OMB F59) --------------------------------------

export const NEAR_LIMIT_PERCENT = 90;
export const nearLimit = endpoint => !!endpoint && (!!endpoint.blocked || (Number(endpoint.used_percent) || 0) >= NEAR_LIMIT_PERCENT);

// "Claude: 92% used, resets 3:40 PM" (or "limit reached" when blocked).
export function limitPillText(endpoint, now = Date.now()) {
  const reset = toMs(endpoint.resets_at);
  const name = endpoint.name || 'Your AI';
  const used = endpoint.blocked ? 'limit reached' : `${Math.round(Number(endpoint.used_percent) || 0)}% used`;
  return `${name}: ${used}${reset !== null ? `, resets ${clockOf(reset)}` : ''}`;
}

// Enabled routines whose next run falls before an endpoint that is near its limit resets, soonest first.
// Routines already waiting on a reset (kind limit_reset) are not listed.
export function dueBeforeReset(routines, endpoints, now = Date.now()) {
  const out = [];
  const resets = endpoints.filter(nearLimit).map(e => ({ endpoint: e, at: toMs(e.resets_at) })).filter(r => r.at !== null && r.at > now);
  if (!resets.length) return out;
  const soonest = resets.reduce((a, b) => (a.at <= b.at ? a : b));
  for (const routine of routines) {
    if (!routine.enabled || routine.schedule.kind === 'limit_reset' || routine.nextRunAt === null) continue;
    if (routine.nextRunAt > now && routine.nextRunAt < soonest.at) out.push({ routine, endpoint: soonest.endpoint, resetsAt: soonest.at });
  }
  return out.sort((a, b) => a.routine.nextRunAt - b.routine.nextRunAt);
}
