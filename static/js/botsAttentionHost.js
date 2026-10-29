// Bots attention: the model every attention panel shares, and the host that
// shows them (Agents 3.0 Phase 1, unit U5). One drawer beside the page holds the
// Inbox, Notifications, Activity or Inspector; the views are botsInbox.js,
// botsNotifications.js, botsActivity.js and botsInspector.js, loaded when used.
//
// Two halves:
//  - The model is plain functions with no DOM (scripts/test_bots_attention_model.cjs):
//    buckets, filters, ages, navigation targets, question answers, event lines.
//  - The host mounts the drawer (U4 calls mountAttentionHost once), polls the
//    counts, and opens a panel. Widths follow OMB: Inbox 380, Notifications 300,
//    Activity 400, Inspector min(460px,45vw); a phone gets an 85 dvh sheet.
//
// Everything comes from /api/bot-attention. The older /api/agents/inbox stays for
// old callers; /api/notifications is device enrollment and is never used here.
import { loadBotsCss } from './botsUi.js';

export const BASE = '/api/bot-attention';
const CSS = '/static/css/bots-attention.css';
const hasDom = typeof document !== 'undefined';

// -- Model --------------------------------------------------------------------

export const BUCKETS = [
  { value: 'needs-you', label: 'Needs you' },
  { value: 'news', label: 'News' },
  { value: 'done', label: 'Done' },
];

export const KIND_LABELS = {
  question: 'Question', approval: 'Approval', review: 'Review', report: 'Report', done: 'Finished',
  'turn-failed': 'Could not finish', 'routine-failed': 'Routine failed', 'routine-deferred': 'Routine delayed',
  incident: 'Incident', 'sign-in': 'Sign-in needed', 'delegation-settled': 'Handoff settled', mention: 'Mention',
  spend: 'Spend', brief: 'Brief',
};
export const kindLabel = kind => KIND_LABELS[kind] || 'Update';

// The feed's filters: which notification kinds each one shows.
const PROBLEMS = ['turn-failed', 'routine-failed', 'routine-deferred', 'incident', 'sign-in', 'spend'];
const ASKS = ['question', 'approval'];
export const FEED_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'asks', label: 'Needs you' },
  { value: 'problems', label: 'Problems' },
];

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

export function bucketCounts(rows = []) {
  const counts = { 'needs-you': 0, news: 0, done: 0 };
  for (const row of rows) if (row.bucket in counts) counts[row.bucket] += 1;
  return counts;
}

// Rows for one bucket, narrowed by a search and a bot. Unread rows lead; the
// server's order (newest first) holds within each group.
export function rowsFor(rows = [], { bucket = 'needs-you', query = '', botId = '' } = {}) {
  const needle = query.trim().toLowerCase();
  const kept = rows.filter(row => row.bucket === bucket
    && (!botId || row.sender?.id === botId)
    && (!needle || [row.subject, row.snippet, row.sender?.name].some(part => text(part).toLowerCase().includes(needle))));
  return [...kept.filter(row => !row.read), ...kept.filter(row => row.read)];
}

export function filterNotifications(rows = [], filter = 'all', botId = '') {
  return rows.filter(row => {
    if (botId && row.agent_id !== botId) return false;
    if (filter === 'unread') return !row.read;
    if (filter === 'asks') return ASKS.includes(row.kind);
    if (filter === 'problems') return PROBLEMS.includes(row.kind);
    return true;
  });
}
export const unreadCount = (rows = []) => rows.filter(row => !row.read).length;

// A short age: "now", "5m", "3h", "Yesterday", then a date.
export function formatAge(at, now = Date.now() / 1000) {
  const seconds = Math.max(0, now - Number(at || 0));
  if (!at) return '';
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 172800) return 'Yesterday';
  return new Date(at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayLabel(at, now = Date.now() / 1000) {
  const day = value => { const date = new Date(value * 1000); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const gap = Math.round((day(now) - day(at)) / 86400000);
  if (gap <= 0) return 'Today';
  if (gap === 1) return 'Yesterday';
  return new Date(at * 1000).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function groupByDay(entries = [], now = Date.now() / 1000) {
  const groups = [];
  for (const entry of entries) {
    const label = dayLabel(entry.at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.entries.push(entry); else groups.push({ label, entries: [entry] });
  }
  return groups;
}

// A server target {tab, agentId, sessionId, messageId} as the canonical
// navigation {tab, agentId?, sessionId?, messageId?, attention?}. Only those
// keys, only strings; anything else is dropped. Null when there is nowhere to go.
export function navigationFor(target, attention) {
  if (!isPlainObject(target)) return null;
  const out = { tab: text(target.tab) || 'botsShell' };
  for (const key of ['agentId', 'sessionId', 'messageId']) {
    if (typeof target[key] === 'string' && target[key]) out[key] = target[key];
  }
  if (!out.agentId && !out.sessionId) return null;
  if (attention) out.attention = attention;
  return out;
}
export function openTarget(target) {
  const detail = navigationFor(target);
  if (!detail || !hasDom) return false;
  document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail }));
  return true;
}

// Answers for a question card: {question text: answer}. Each question takes a
// chosen option (or several for multi-select) or a typed answer. Returns
// {answers} when every question has one, else {error}.
export function buildAnswers(questions = [], values = {}) {
  const answers = {};
  for (const question of questions) {
    const raw = values[question.question];
    const chosen = Array.isArray(raw) ? raw.map(item => text(item).trim()).filter(Boolean) : text(raw).trim();
    const empty = Array.isArray(chosen) ? chosen.length === 0 : !chosen;
    if (empty) return { error: 'Answer every question first.' };
    answers[question.question] = question.multiSelect ? [].concat(chosen) : (Array.isArray(chosen) ? chosen[0] : chosen);
  }
  return { answers };
}

// A row's actions as buttons, in the order they are offered.
export const ACTION_LABELS = {
  reply: 'Reply', close: 'Close', approve: 'Approve', allow: 'Allow', deny: 'Deny', respond: 'Answer', skip: 'Skip', open: 'Open in chat',
};
export const hasAction = (row, action) => Array.isArray(row?.actions) && row.actions.includes(action);

// Honest labels: these rows are Kairos' own records, never a provider's trace.
export const SOURCE_LABELS = { 'kairos-runtime': 'Runtime event', 'kairos-run-timeline': 'Run timeline' };

// One Activity/Inspector entry as {title, detail, tone, source}.
export function entryLine(entry = {}) {
  const data = isPlainObject(entry.data) ? entry.data : {};
  const title = text(data.label) || text(data.name) || text(data.type) || text(data.kind) || 'Event';
  const parts = [data.status, data.outcome, data.detail].map(text).filter(Boolean);
  const failed = data.ok === false || /fail|error/i.test(`${data.type || ''} ${data.status || ''} ${data.outcome || ''}`);
  return { title, detail: parts.join(' / '), tone: failed ? 'bad' : 'ok', source: SOURCE_LABELS[entry.source] || 'Record' };
}

// -- Host ---------------------------------------------------------------------

const PANELS = {
  inbox: { title: 'Inbox', load: () => import('./botsInbox.js') },
  notifications: { title: 'Notifications', load: () => import('./botsNotifications.js') },
  activity: { title: 'Activity', load: () => import('./botsActivity.js') },
  inspector: { title: 'Inspector', load: () => import('./botsInspector.js') },
};
export const PANEL_NAMES = Object.keys(PANELS);

export function h(tag, attrs = {}, children = []) {
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

async function call(path, options = {}) {
  const { api } = await import('./api.js');
  return api(path, { toast: false, ...options });
}
export const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body || {}) });
export const get = path => call(path);
export const errorText = error => String(error?.message || error || 'Something went wrong.').replace(/^\d+: /, '');

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
let current = null;

// Mount the drawer once. options: {parent, pollMs, notify}. notify turns on
// desktop notifications from the retained feed (leave it off while another
// watcher still drives them, or each alert shows twice).
export function mountAttentionHost({ parent = hasDom ? document.body : null, pollMs = 20000, notify = false } = {}) {
  if (!hasDom || !parent) return null;
  if (current) return current.api;
  const scrim = h('div', { class: 'bots-attn-scrim', hidden: true });
  const body = h('div', { class: 'bots-attn-body' });
  const title = h('h2', { class: 'bots-attn-title' });
  const closeButton = h('button', { type: 'button', class: 'bots-icon-btn', 'aria-label': 'Close', title: 'Close' });
  const drawer = h('aside', { class: 'bots-attn', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'bots-attn-title', hidden: true }, [
    h('header', { class: 'bots-attn-head' }, [title, closeButton]), body]);
  title.id = 'bots-attn-title';
  parent.append(scrim, drawer);
  const state = { name: '', view: null, opener: null, counts: { inbox: 0, notifications: 0 }, listeners: new Set(), timer: 0, token: 0, args: {} };
  loadBotsCss(CSS);

  const emit = () => state.listeners.forEach(fn => { try { fn({ ...state.counts }); } catch { /* a listener never breaks the host */ } });
  const setCounts = (changes = {}) => {
    const next = { ...state.counts, ...changes };
    if (next.inbox === state.counts.inbox && next.notifications === state.counts.notifications) return;
    state.counts = next;
    emit();
  };

  async function refreshCounts() {
    const [inbox, feed] = await Promise.all([get(`${BASE}/inbox`).catch(() => null), get(`${BASE}/notifications`).catch(() => null)]);
    if (inbox) setCounts({ inbox: inbox.count || 0 });
    if (feed) {
      setCounts({ notifications: feed.unread || 0 });
      if (notify) feedNotifier(feed);
    }
  }
  let feedWatch = null;
  async function feedNotifier(feed) {
    if (!feedWatch) {
      const module = await import('./botNotifications.js');
      feedWatch = module.createFeedWatcher({
        names: async () => { try { return Object.fromEntries((await get('/api/agents')).map(a => [a.id, a.name])); } catch { return {}; } },
        focusedAgentId: () => (document.hasFocus() ? document.querySelector('[data-bots-agent-id]')?.dataset.botsAgentId || null : null),
        focusedSessionId: () => (document.hasFocus() ? document.querySelector('[data-bots-session-id]')?.dataset.botsSessionId || null : null),
        show: async note => {
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
          // The icon is the bot's own face in its needs-you pose (Kairos Mascot build spec), rasterized once per look.
          let face = null;
          try {
            const [{ mascotPng }, { avatarSpec }, agents] = await Promise.all([import('./mascot.js'), import('./agentAvatar.js'), get('/api/agents')]);
            const agent = (Array.isArray(agents) ? agents : []).find(a => a.id === note.agentId);
            face = await mascotPng(avatarSpec(agent || { id: note.agentId }), note.kind === 'needs_you' ? 'needs' : 'success', 64);
          } catch { /* A notification without its face is still a notification. */ }
          const shown = new Notification(note.title, { body: note.body, tag: `kairos-bot-${note.agentId}`, ...(face ? { icon: face } : {}) });
          shown.onclick = () => { window.focus?.(); openTarget(note.target) || openTarget({ tab: 'botsShell', agentId: note.agentId }); shown.close(); };
        },
      });
    }
    feedWatch(feed).catch(() => {});
  }
  const schedule = () => {
    clearTimeout(state.timer);
    state.timer = setTimeout(async () => { if (current) { if (!document.hidden || notify) await refreshCounts(); schedule(); } }, pollMs);
  };

  function close({ restoreFocus = true } = {}) {
    if (!state.name) return;
    state.token += 1;
    try { state.view?.dispose?.(); } catch { /* the view is going anyway */ }
    state.view = null; state.name = '';
    drawer.hidden = true; scrim.hidden = true;
    drawer.removeAttribute('data-panel');
    body.replaceChildren();
    const opener = state.opener; state.opener = null;
    if (restoreFocus && opener?.isConnected) opener.focus();
    document.dispatchEvent(new CustomEvent('kairos:bots-attention', { detail: { open: false, panel: '' } }));
    refreshCounts().catch(() => {});
  }

  async function open(name, args = {}) {
    const spec = PANELS[name];
    if (!spec) return false;
    if (state.name === name && JSON.stringify(state.args) === JSON.stringify(args)) return true;
    if (!state.name) state.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = ++state.token;
    try { state.view?.dispose?.(); } catch { /* replaced below */ }
    state.view = null; state.name = name; state.args = args;
    drawer.dataset.panel = name;
    title.textContent = spec.title;
    drawer.hidden = false; scrim.hidden = false;
    body.replaceChildren(h('p', { class: 'bots-attn-note', role: 'status', text: 'Loading...' }));
    document.dispatchEvent(new CustomEvent('kairos:bots-attention', { detail: { open: true, panel: name } }));
    let module;
    try { module = await spec.load(); }
    catch (error) {
      if (token === state.token) body.replaceChildren(h('p', { class: 'bots-attn-note', role: 'alert', text: `${spec.title} could not load. Close it and try again.` }));
      console.warn('Bots attention: panel failed to load', error);
      return false;
    }
    if (token !== state.token) return false;
    body.replaceChildren();
    state.view = await module.mount(body, {
      args, get, post, errorText, navigate: openTarget, setCounts, close: () => close(), open,
      openTarget: (target, extra) => { const done = openTarget(target); if (done && extra !== 'stay') close({ restoreFocus: false }); return done; },
    });
    if (token !== state.token) { state.view?.dispose?.(); return false; }
    queueMicrotask(() => (body.querySelector(FOCUSABLE) || closeButton).focus());
    return true;
  }

  import('./botsIcons.js').then(({ icon }) => closeButton.append(icon('x', { size: 18 }))).catch(() => { closeButton.textContent = 'x'; });
  closeButton.addEventListener('click', () => close());
  scrim.addEventListener('click', () => close());
  drawer.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      // A view that handled Escape itself (a reading pane going back) stops it here.
      if (event.defaultPrevented) return;
      event.stopPropagation(); close();
    } else if (event.key === 'Tab') {
      const items = [...drawer.querySelectorAll(FOCUSABLE)].filter(node => node.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  // A redraw can drop focus to the page; Escape must still close the drawer then.
  const onEscape = event => {
    if (event.key !== 'Escape' || !state.name || event.defaultPrevented) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    close();
  };
  document.addEventListener('keydown', onEscape);
  const onNavigate = event => { if (event.detail?.attention && PANELS[event.detail.attention]) open(event.detail.attention, { agentId: event.detail.agentId, sessionId: event.detail.sessionId }); };
  document.addEventListener('jarvis:navigate', onNavigate);
  const onFocus = () => { if (!document.hidden) refreshCounts().catch(() => {}); };
  document.addEventListener('visibilitychange', onFocus);

  const api = {
    open, close, refresh: refreshCounts,
    toggle: (name, args) => (state.name === name ? close() : open(name, args)),
    isOpen: () => state.name,
    counts: () => ({ ...state.counts }),
    onCounts(fn) { state.listeners.add(fn); fn({ ...state.counts }); return () => state.listeners.delete(fn); },
    dispose() {
      close({ restoreFocus: false });
      clearTimeout(state.timer);
      document.removeEventListener('jarvis:navigate', onNavigate);
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('visibilitychange', onFocus);
      scrim.remove(); drawer.remove(); current = null;
    },
  };
  current = { api };
  refreshCounts().catch(() => {}).finally(schedule);
  return api;
}

// For the sidebar buttons: open a panel on the mounted host.
export const openAttention = (name, args) => current?.api.open(name, args) ?? false;
export const closeAttention = () => current?.api.close();
export const toggleAttention = (name, args) => current?.api.toggle(name, args);
export const attentionHost = () => current?.api || null;
