import { ICONS } from './notchIcons.js';
import { modelLogo } from './notchModelMarks.js';

// The quiet expanded notch (Kairos Mobile v2 board NotchQuiet): with fewer than
// two agents at work it shows what is next instead of agent chips. Up next, the
// last chat to pick up, today's counts, usage at a glance and the quick actions.
// Every figure is read from the endpoints the app already uses; a module with
// nothing to show is left out and the others widen. The same readings and
// actions also feed the side notch (notchSide.js).

// ---- Pure helpers, covered by scripts/test_notch_quiet.cjs ---------------------------------------------------------
// Two or more agents at work bring the agent chips back.
export function layoutFor(working) { return working >= 2 ? 'agents' : 'quiet'; }
export function workingAgents(work) { return new Set(work.filter(item => item.agent).map(item => item.agent.id)).size; }

export function greetingFor(hour, name) {
  const word = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return `Good ${word}${name && name !== 'local' ? ', ' + name : ''}`;
}
const dayStart = now => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Chats touched today (session times are unix seconds).
export function chatsToday(sessions, now = Date.now()) {
  return sessions.filter(s => !s.is_forge && s.updated_at * 1000 >= dayStart(now)).length;
}
// Open notes whose due time is today or already past (due_date is a local ISO string).
export function notesDue(notes, now = Date.now()) {
  const end = dayStart(now) + 86400000;
  return notes.filter(n => !n.completed && n.due_date && new Date(n.due_date).getTime() < end).length;
}
// The soonest timed event that has not ended: Notes and workspace deadlines are
// not meetings to prepare for, and an all-day item has no time to count down to.
export function nextEvent(events, now = Date.now()) {
  return events.filter(e => !e.completed && !e.all_day && e.source !== 'note' && e.source !== 'tab'
    && e.start?.includes('T') && new Date(e.end || e.start).getTime() > now)
    .sort((a, b) => new Date(a.start) - new Date(b.start))[0] || null;
}
export function sourceOf(event) {
  return event.calendar_name || (event.source === 'google' ? 'Google' : event.source_label || 'Kairos');
}
export function untilCopy(event, now = Date.now()) {
  const start = new Date(event.start).getTime(), minutes = Math.round((start - now) / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes} min`;
  if (start < dayStart(now) + 86400000) return `in ${Math.round(minutes / 60)} h`;
  return start < dayStart(now) + 172800000 ? 'tomorrow' : new Date(start).toLocaleDateString(undefined, { weekday: 'long' });
}
const clock = date => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// "3:15 – 4:00 PM": the meridiem is said once when both ends share it.
export function rangeCopy(event) {
  const from = clock(new Date(event.start)), to = event.end ? clock(new Date(event.end)) : '';
  const suffix = /\s?[AP]M$/i, same = to && suffix.exec(from)?.[0] === suffix.exec(to)?.[0];
  return to ? `${same ? from.replace(suffix, '') : from} – ${to}` : from;
}
// What "Prep with Kairos" puts in a new chat's composer. Nothing is sent.
export function prepDraft(event) {
  const title = String(event.title || 'my next event').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `Help me prepare for "${title}" at ${rangeCopy(event)}. What should I know or bring?`;
}
// The chat to pick up: the most recently touched one, never a worktree session (Continue opens the chat tab).
export function recentChat(sessions) {
  return [...sessions].filter(s => !s.is_forge).sort((a, b) => b.updated_at - a.updated_at)[0] || null;
}
export function ageCopy(seconds, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now / 1000 - seconds) / 60));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
}
// The last words said in a chat, on one line.
export function snippetFrom(messages) {
  const last = [...(messages || [])].reverse().find(m => typeof m.content === 'string' && m.content.trim());
  const text = last ? last.content.replace(/\s+/g, ' ').trim() : '';
  return text.length > 70 ? text.slice(0, 69) + '…' : text;
}
export const DOTS = 24;
export function filledDots(used) { return Math.round(Math.min(Math.max(used || 0, 0), 1) * DOTS); }
// One row per subscription that reports a quota: its logo, 24 dots and the percentage.
export function usageRows(providers) {
  const rows = [];
  for (const provider of providers) {
    const windows = provider.snap?.windows || [], head = windows.find(w => w.id === 'session') || windows[0];
    if (head && provider.snap.status !== 'needsAuth') rows.push({ model: provider, used: Math.min(Math.max(head.used, 0), 1) });
  }
  return rows;
}
// The single agent's status line, or what the notch is busy with.
export function statusLine({ focus, agents, doing }) {
  if (focus) return { text: focus.title, detail: focus.detail || '', color: focus.agent?.color || '' };
  if (agents.length === 1) {
    const only = agents[0], busy = doing.get(only.id);
    return { text: busy ? `${only.name} is working` : `${only.name} is resting`, detail: busy && busy !== 'needs you' ? busy : '', color: only.color || '' };
  }
  return null;
}

// ---- Data -----------------------------------------------------------------------------------------------------------
const HEX = /^#[0-9a-f]{6}$/i;
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
// Reads the app's own endpoints for the quiet and side views. A route the
// signed-in user may not read (401, 403, 404) is not asked again; a failed
// read keeps the last answer.
export function createQuietData(onChange, load = defaultLoad) {
  const data = { name: '', sessions: null, notes: null, events: null, snippet: null };
  const denied = new Set();
  let last = 0, running = false, identityKnown = false;
  async function read(key, url, apply) {
    if (denied.has(key)) return;
    const value = await load(url);
    if (value === 'denied') denied.add(key); else if (value !== null) apply(value);
  }
  async function refresh(force = false) {
    if (running || (!force && Date.now() - last < 60000)) return;
    running = true; last = Date.now();
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    await Promise.all([
      // The shell already read the identity; ask only when it has not (standalone use).
      identityKnown ? null : read('identity', '/api/auth/status', v => { data.name = v.username || ''; identityKnown = true; }),
      read('sessions', '/api/sessions', v => { data.sessions = Array.isArray(v) ? v : []; }),
      read('notes', '/api/notes?include_completed=false', v => { data.notes = Array.isArray(v) ? v : []; }),
      read('events', `/api/calendar/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
        v => { data.events = Array.isArray(v) ? v : []; }),
    ]);
    const recent = data.sessions && recentChat(data.sessions);
    if (recent && data.snippet?.id !== `${recent.id}:${recent.updated_at}`) {
      await read('session', `/api/sessions/${encodeURIComponent(recent.id)}`,
        v => { data.snippet = { id: `${recent.id}:${recent.updated_at}`, text: snippetFrom(v.messages) }; });
    }
    running = false; onChange();
  }
  // The shell passes the sign-in it already read, so this does not ask /api/auth/status again.
  function setIdentity(name) { data.name = name || ''; identityKnown = true; }
  return { data, refresh, setIdentity };
}
async function defaultLoad(url) {
  try {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if ([401, 403, 404].includes(response.status)) return 'denied';
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

// ---- Shared pieces ------------------------------------------------------------------------------------------------
function textButton(className, label, onClick, text) {
  const b = h('button', className, text); b.type = 'button'; b.setAttribute('aria-label', label);
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}
// The four quick actions, each wired to the app action it names. `labels` is the
// caption under each icon (the side notch's are shorter). New chat opens the
// notch's quick composer when the shell passes `onNewChat`.
export function quickActions(bridge, labels, onNewChat = () => bridge.openApp?.('chat')) {
  const actions = [['New chat', ICONS.plus, onNewChat], ['Note', ICONS.note, () => bridge.openApp?.('notes')],
    ['Talk', ICONS.talk, () => bridge.openApp?.('talk')], ['Drop files', ICONS.drop, () => bridge.openApp?.('attach')]];
  return actions.map(([name, icon, run], i) => {
    const b = textButton('nq-qa', name, run);
    const mark = h('span', 'nq-qa-icon'); mark.innerHTML = icon;
    b.append(mark, h('span', 'nq-qa-label', labels[i]));
    return b;
  });
}
// "Up next": the next event's time, source and, when `prep` is true, the action that opens a chat about it.
export function upNextTile(bridge, event, { prep = true, now = Date.now() } = {}) {
  const tile = h('div', 'nq-tile nq-next');
  const mark = h('span', 'nq-next-mark'); mark.innerHTML = ICONS.calendar;
  const copy = h('span', 'nq-next-copy');
  copy.append(h('span', 'nq-label', `Up next · ${untilCopy(event, now)}`), h('span', 'nq-next-title', event.title || 'Untitled event'));
  if (prep) copy.append(h('span', 'nq-sub', `${rangeCopy(event)} · ${sourceOf(event)}`));
  tile.append(mark, copy);
  if (prep) tile.append(textButton('nq-pill', `Prep with Kairos for ${event.title || 'your next event'}`,
    () => bridge.openApp?.('chat', { draft: prepDraft(event) }), 'Prep with Kairos'));
  return tile;
}
export function usageRowNode(row) {
  const name = row.model.name, pct = Math.round(row.used * 100), filled = filledDots(row.used);
  const node = h('div', 'nq-usage-row'); node.setAttribute('aria-label', `${name} ${pct}% used`); node.title = name;
  const dots = h('span', 'nq-dots');
  for (let i = 0; i < DOTS; i++) dots.append(h('i'));
  [...dots.children].slice(0, filled).forEach(dot => dot.classList.add('on'));
  node.style.setProperty('--tone', row.used >= .8 ? 'var(--n-crit)' : row.used >= .5 ? 'var(--n-watch)' : 'var(--n-text)');
  node.append(modelLogo(row.model, 14), dots, h('span', 'nq-pct', `${pct}%`));
  return node;
}

// ---- The quiet view ----------------------------------------------------------------------------------------------
export function createQuietView({ bridge, bigKip, onNewChat }) {
  const view = h('div', 'nq-view');
  const kipSlot = h('div', 'nq-kip');
  const label = h('span', 'nq-label'), greeting = h('span', 'nq-greeting');
  const counts = h('div', 'nq-counts'), line = h('div', 'nq-line');
  const headCopy = h('div', 'nq-head-copy'); headCopy.append(label, greeting);
  const head = h('div', 'nq-head'); head.append(kipSlot, headCopy);
  const kipTile = h('div', 'nq-tile nq-kip-tile'); kipTile.append(head, counts, line);
  const next = h('div', 'nq-slot nq-next-slot'), lower = h('div', 'nq-tile nq-lower'), mid = h('div', 'nq-mid'); mid.append(next, lower);
  const actions = h('div', 'nq-tile nq-actions'); actions.setAttribute('aria-label', 'Quick actions');
  actions.append(...quickActions(bridge, ['New chat', 'Note', 'Talk', 'Drop files'], onNewChat));
  view.append(kipTile, mid, actions);

  let info = null, rows = [];
  function render(data) {
    if (!info) return;
    const now = Date.now(), { state, agents } = info;
    label.textContent = info.focus ? (state === 'needs' || state === 'error' ? 'Needs you' : 'Working') : state === 'sleeping' ? 'Resting' : 'All quiet';
    greeting.textContent = greetingFor(new Date(now).getHours(), data.name);

    const figures = [];
    if (data.sessions) figures.push([chatsToday(data.sessions, now), 'chats today']);
    if (data.notes) {
      const due = notesDue(data.notes, now);
      figures.push([due, due === 1 ? 'note due' : 'notes due']);
    }
    figures.push([agents.length, agents.length === 1 ? 'agent' : 'agents']);
    counts.replaceChildren(...figures.map(([n, word]) => { const cell = h('span'); cell.append(h('b', '', String(n)), word); return cell; }));

    const status = statusLine(info);
    line.hidden = !status;
    if (status) {
      const dot = h('span', 'nq-dot'); dot.style.setProperty('--dot', HEX.test(status.color) ? status.color : 'var(--n-watch)');
      line.replaceChildren(dot, h('span', 'nq-line-text', status.text), h('span', 'nq-sub', status.detail));
    }

    const event = data.events && nextEvent(data.events, now);
    next.replaceChildren(...(event ? [upNextTile(bridge, event, { now })] : []));

    const recent = data.sessions && recentChat(data.sessions), blocks = [];
    if (recent) {
      const pick = h('div', 'nq-pick');
      const top = h('div', 'nq-pick-top'); top.append(h('span', 'nq-label', 'Pick up where you left off'), h('span', 'nq-sub', ageCopy(recent.updated_at, now)));
      const row = h('div', 'nq-pick-row'), words = h('span', 'nq-pick-words');
      words.append(h('span', 'nq-pick-title', recent.title || 'Untitled conversation'));
      const text = data.snippet?.id === `${recent.id}:${recent.updated_at}` ? data.snippet.text : '';
      if (text) words.append(h('span', 'nq-sub', ` · ${text}`));
      row.append(words, textButton('nq-pill nq-primary', `Continue ${recent.title || 'your last chat'}`,
        () => bridge.openApp?.('chat', { sessionId: recent.id }), 'Continue')); pick.append(top, row); blocks.push(pick);
    }
    if (rows.length) { const box = h('div', 'nq-usage'); box.append(...rows.map(usageRowNode)); blocks.push(box); }
    lower.replaceChildren(...blocks);
    lower.hidden = !blocks.length;
    mid.hidden = !event && !blocks.length;
    view.classList.toggle('nq-no-mid', mid.hidden);
  }
  return {
    node: view,
    // The Kip card borrows the shell's large Kip while the quiet layout shows.
    holdKip() { kipSlot.append(bigKip); },
    update(next, data) { info = next; render(data); },
    usage(providers, data) { rows = usageRows(providers); render(data); },
  };
}
