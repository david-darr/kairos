// The transcript of a Bots conversation (Phase 1, U3).
//
// Two halves. The first is pure and runs in plain Node (scripts/test_bots_transcript.cjs):
// day labels, rows, the 120-message window, bottom-follow, tool folding, the
// live status line and what a screen reader is told. The second, mountTranscript,
// draws that onto the page: role=log with aria-live off, a separate announcer,
// day and "New messages" markers, version switchers, reactions, quotes, the live
// reply with its presence line and Now card, and the jump pills.
//
// The server (U1's GET /api/bot-chat/{sid}/messages) returns the active branch,
// so nothing here walks parents. Message rows read: id, parent_id, role, content,
// ts, status, kind, attachments, reactions [{emoji,count,mine}], version {index,
// count, ids}, reply_to_id, reply_to {id,role,snippet}, citations, via.
import { h, messageTray, touchTray, reactionBar, versionSwitcher, replyQuote, citationBadges, userEditor } from './botsMessageActions.js';
import { attachmentGallery } from './botsChatAttachments.js';

export const WINDOW_SIZE = 120, TOP_REVEAL_PX = 250, FOLLOW_PX = 80, QUIET_GAP = 900, JOIN_GAP = 300;
export const COLLAPSE_CHARS = 600, COLLAPSE_LINES = 8;

const rowRenderers = new Map();
// Returns an unregister function. Callers can also supply instance rowRenderers.
export function registerRowRenderer(kind, renderer) {
  const entries = rowRenderers.get(kind) || [], entry = { renderer };
  entries.push(entry); rowRenderers.set(kind, entries);
  return () => { const at = entries.indexOf(entry); if (at >= 0) entries.splice(at, 1); if (!entries.length) rowRenderers.delete(kind); };
}
export function renderRegisteredRow(kind, row, options) {
  return (rowRenderers.get(kind)?.at(-1)?.renderer || options?.rowRenderers?.[kind])?.(row, options) || null;
}

// -- Pure: time ----------------------------------------------------------------
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
export function dayLabel(ts, now = Date.now() / 1000) {
  const date = new Date(ts * 1000), today = new Date(now * 1000);
  if (!Number.isFinite(date.getTime())) return '';
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}
const clock = ts => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const elapsedLabel = seconds => { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const workedLabel = seconds => { const s = Math.max(0, Math.round(seconds)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

// -- Pure: text ------------------------------------------------------------------
// A conversational reply shows one bubble per paragraph. A blank line inside a fenced code block is not a paragraph break.
export function splitConversational(text) {
  const parts = [];
  let current = [], fence = null;
  const flush = () => { const piece = current.join('\n').trim(); if (piece) parts.push(piece); current = []; };
  for (const line of String(text || '').split('\n')) {
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { current.push(line); if (mark && mark[1][0] === fence.char && mark[1].length >= fence.length && !line.replace(mark[0], '').trim()) fence = null; continue; }
    if (mark) { fence = { char: mark[1][0], length: mark[1].length }; current.push(line); continue; }
    if (!line.trim()) flush(); else current.push(line);
  }
  flush();
  return parts.length ? parts : [''];
}
export const shouldCollapse = text => String(text || '').length > COLLAPSE_CHARS || String(text || '').split('\n').length > COLLAPSE_LINES;
export const firstSentence = (text, max = 120) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return (end >= 0 && end < max ? flat.slice(0, end + 1) : flat.slice(0, max)).trim();
};

// -- Pure: rows ------------------------------------------------------------------
// messages: the visible branch in order. Returns rows for the DOM: day marker, "New messages" divider, messages.
// The divider sits above the first reply after the read cursor, or after the person's last message.
export function buildRows(messages, { now = Date.now() / 1000, readId = null, quietGap = QUIET_GAP, simple = true } = {}) {
  const rows = [];
  let lastDay = '', lastTs = 0, prev = null, unreadFrom = -1;
  // Everything up to the read cursor, or the person's own last message (whichever is later), counts as read.
  const after = Math.max(readId ? messages.findIndex(m => m.id === readId) : -1, messages.map(m => m.role).lastIndexOf('user'));
  if (after >= 0) unreadFrom = messages.findIndex((m, i) => i > after && m.role !== 'user' && !m.kind);
  messages.forEach((message, index) => {
    if (message.goal_step && message.goal_root) return;
    const label = dayLabel(message.ts, now);
    let marker = false;
    if (label && label !== lastDay) { rows.push({ type: 'day', key: `day:${label}:${message.id}`, label }); lastDay = label; marker = true; }
    else if (simple && lastTs && message.ts - lastTs > quietGap) { rows.push({ type: 'day', key: `gap:${message.id}`, label: `${label} ${clock(message.ts)}`.trim() }); marker = true; }
    if (index === unreadFrom && !rows.some(r => r.type === 'unread')) rows.push({ type: 'unread', key: 'unread' });
    const rich = !!message.kind && message.kind !== 'message';
    const joinPrev = !!prev && !marker && !rich && !prev.rich && prev.message.role === message.role && prev.message.bot_id === message.bot_id && message.ts - prev.message.ts < JOIN_GAP && rows.at(-1)?.type === 'message';
    const row = { type: rich ? message.kind : 'message', key: message.id, message, rich, joinPrev, joinNext: false };
    if (joinPrev) prev.joinNext = true;
    rows.push(row); prev = row; lastTs = message.ts;
  });
  return rows;
}

// -- Pure: the 120-message window -------------------------------------------------
export function createWindow(size = WINDOW_SIZE) {
  let list = [], start = 0, end = 0;
  const clamp = () => { start = Math.max(0, Math.min(start, list.length)); end = Math.max(start, Math.min(end, list.length)); };
  const api = {
    set(messages) { list = [...messages]; end = list.length; start = Math.max(0, end - size); },
    all: () => list,
    slice: () => list.slice(start, end),
    range: () => ({ start, end }),
    atLatest: () => end === list.length,
    hiddenAbove: () => start, hiddenBelow: () => list.length - end,
    has: id => list.some(m => m.id === id),
    indexOf: id => list.findIndex(m => m.id === id),
    get: id => list.find(m => m.id === id) || null,
    // A live append moves the window only while it is showing the latest messages.
    append(message) {
      const at = list.findIndex(m => m.id === message.id);
      if (at >= 0) { list[at] = { ...list[at], ...message }; return false; }
      const following = end === list.length;
      list.push(message);
      if (following) { end = list.length; if (end - start > size) start = end - size; }
      return following;
    },
    patch(id, fields) { const at = list.findIndex(m => m.id === id); if (at < 0) return false; list[at] = { ...list[at], ...fields }; return true; },
    remove(id) { const at = list.findIndex(m => m.id === id); if (at < 0) return false; list.splice(at, 1); if (at < start) start--; if (at < end) end--; clamp(); return true; },
    // An older page lands above; the rows already shown stay where they are.
    prepend(older) {
      const fresh = older.filter(m => !list.some(x => x.id === m.id));
      list.unshift(...fresh); start += fresh.length; end += fresh.length; return fresh.length;
    },
    appendPage(newer) { const fresh = newer.filter(m => !list.some(x => x.id === m.id)); list.push(...fresh); return fresh.length; },
    // Hidden rows come back first; the window never grows past twice its size.
    revealOlder(count = 30) {
      const n = Math.min(count, start); start -= n;
      if (end - start > size * 2) end = start + size * 2;
      return n;
    },
    revealNewer(count = 30) { const n = Math.min(count, list.length - end); end += n; if (end - start > size * 2) start = end - size * 2; return n; },
    latest() { end = list.length; start = Math.max(0, end - size); },
    around(id) {
      const at = list.findIndex(m => m.id === id); if (at < 0) return false;
      start = Math.max(0, at - Math.floor(size / 2)); end = Math.min(list.length, start + size); start = Math.max(0, end - size); return true;
    },
  };
  return api;
}

// Prepending rows must not move what the reader is looking at.
export const anchorAfterPrepend = (before, newScrollHeight) => before.scrollTop + (newScrollHeight - before.scrollHeight);

// -- Pure: bottom-follow ---------------------------------------------------------
// Following breaks only on a gesture that scrolls up. Content growth never breaks it; reaching the bottom resumes it.
export function createFollow() {
  let following = true;
  return {
    following: () => following,
    gesture() { following = false; },
    scrolled({ top, height, client }) { if (height - top - client <= FOLLOW_PX) following = true; },
    jump() { following = true; },
  };
}
export function upwardGesture(event, { typing = false } = {}) {
  if (event.type === 'wheel') return event.deltaY < 0;
  if (event.type === 'touchmove') return !!event.movedDown;
  if (event.type === 'keydown') return !typing && ['PageUp', 'Home', 'ArrowUp'].includes(event.key);
  if (event.type === 'pointerdown') return !!event.onScrollbar;
  return false;
}

// -- Pure: tools and the live line --------------------------------------------------
export function stepVerb(step) {
  const name = String(step?.name || step?.kind || '').toLowerCase();
  if (/search|grep|find|query/.test(name)) return 'Searching';
  if (/read|open|fetch|browse|web/.test(name)) return 'Reading';
  if (/command|shell|bash|exec|terminal/.test(name)) return 'Running a command';
  if (/write|edit|patch|save/.test(name)) return 'Writing';
  return name ? `Using ${step.name || step.kind}` : 'Writing';
}
const startedStep = item => item.phase === 'started' || /started/.test(item.kind || '');
const finishedStep = item => item.phase === 'finished' || /finished|failed/.test(item.kind || '');
// Merge a turn's tool steps and events by call ID: each finish joins the most recent start of the same tool.
export function normalizeSteps(entry) {
  const events = [...(entry?.toolSteps || []), ...(entry?.toolEvents || [])];
  const byId = new Map();
  events.forEach((item, index) => {
    const pending = finishedStep(item) && [...byId].reverse().find(([, step]) => step.name === item.name && startedStep(step));
    const id = item.id || pending?.[0] || `${item.name || item.kind}-${index}`;
    byId.set(id, { ...(byId.get(id) || {}), ...item });
  });
  return [...byId].map(([id, step]) => ({ id, name: step.name || step.kind || '', summary: step.summary || stepVerb(step), detail: step.output || step.detail || '',
    state: step.ok === false || step.phase === 'failed' || step.kind === 'tool_failed' ? 'failed' : finishedStep(step) ? 'done' : 'running' }));
}
// Consecutive finished steps fold into "Used N tools"; a running or failed step stays on its own line.
export function foldSteps(steps) {
  const out = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.state === 'done') { if (last?.type === 'run') { last.steps.push(step); last.count++; } else out.push({ type: 'run', count: 1, steps: [step] }); }
    else out.push({ type: 'step', step });
  }
  return out.map(item => (item.type === 'run' && item.count === 1 ? { type: 'step', step: item.steps[0] } : item));
}
export const foldLabel = count => `Used ${count} tools`;
export function digestLabel(digest = {}) {
  const bits = [];
  if (digest.tools) bits.push(`${digest.tools} ${digest.tools === 1 ? 'tool' : 'tools'}`);
  if (digest.files) bits.push(`${digest.files} ${digest.files === 1 ? 'file' : 'files'}`);
  return `Worked for ${workedLabel(digest.seconds || 0)}${bits.length ? ` · ${bits.join(', ')}` : ''}`;
}
// The line beside the presence avatar: what the bot is doing and for how long.
export function liveStatus(entry, now = Date.now() / 1000) {
  if (!entry) return null;
  const steps = normalizeSteps(entry), active = [...steps].reverse().find(s => s.state === 'running');
  const seconds = Math.max(0, now - (entry.startedAt || now) - (entry.pausedSeconds || 0));
  const verb = entry.stopping ? 'Stopping' : entry.permission ? 'Waiting for you' : active ? stepVerb({ name: active.name }) : entry.text ? 'Writing' : 'Thinking';
  const state = entry.stopping ? 'stopping' : entry.permission ? 'needs' : entry.status !== 'processing' ? entry.status : active ? 'working' : 'thinking';
  return { verb, state, elapsed: elapsedLabel(seconds), line: `${verb} · ${workedLabel(seconds)}`, active, steps };
}
// A verify card: steps parsed from shell activity with their result.
export function verifySummary(steps = []) {
  const count = status => steps.filter(s => s.status === status).length;
  const parts = [`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`];
  if (count('passed')) parts.push(`${count('passed')} verified`);
  if (count('failed')) parts.push(`${count('failed')} failed`);
  if (count('unverified')) parts.push(`${count('unverified')} unverified`);
  return parts.join(' · ');
}

// -- Pure: what a screen reader hears -----------------------------------------------
// One announcement per transition: a question to answer, a finished reply, a failure. A stop the person
// asked for is never announced. `seen` is the Set the caller keeps.
export function announcementFor(entry, name, seen) {
  if (!entry) return null;
  const once = key => { const full = `${entry.turnId || 'turn'}:${key}`; if (seen.has(full)) return false; seen.add(full); return true; };
  if (entry.permission && once(`ask:${entry.permission.id}`)) return `${name} needs your answer.`;
  if (entry.status === 'done' && once('done')) { const text = firstSentence(entry.text); return text ? `${name} replied: ${text}` : `${name} finished.`; }
  if (entry.status === 'failed' && once('failed')) return `${name} could not finish. ${entry.error || ''}`.trim();
  return null;
}

// -- DOM ---------------------------------------------------------------------------
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// opts: { agent, sessionId, renderBody(node, text, live), kip(agent, size, state), getContext() -> {busy,lastAssistantId,pinnedId,canSpeak},
//   handlers (tray handlers), react, selectVersion, jump(id), goToSource(id), onNeedOlder(), onNeedNewer(), onEdit(id, text), onUnpin(),
//   isSendKey(event), replyStyle(), simple() }
export function mountTranscript(host, opts) {
  const win = createWindow(), follow = createFollow(), raw = new Set();
  const nodes = new Map();
  let rows = [], readId = null, editing = null, live = null, liveTimer = null, loading = false, disposed = false, flashTimer = null;
  const log = h('div', { class: 'bots-log', role: 'log', 'aria-live': 'off', 'aria-label': `Conversation with ${opts.agent.name}` });
  const scroller = h('div', { class: 'bots-transcript', tabindex: '-1' }, [log]);
  const pinned = h('div', { class: 'bots-pinned', hidden: true });
  const jump = h('button', { type: 'button', class: 'bots-jump', hidden: true, onclick: () => jumpToLatest() }, [h('span', { text: 'Jump to latest' })]);
  const later = h('button', { type: 'button', class: 'bots-later', hidden: true, onclick: () => { win.revealNewer(60); if (win.atLatest()) opts.onNeedNewer?.(); draw({ keep: true }); } });
  const announcer = h('div', { class: 'bots-announcer', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const root = h('div', { class: 'bots-transcript-wrap' }, [pinned, scroller, later, jump, announcer]);
  host.append(root);

  const ctx = () => ({ busy: false, ...opts.getContext?.() });
  const timeNode = message => h('time', { class: 'bots-msg-time', datetime: new Date(message.ts * 1000).toISOString(), text: clock(message.ts) });
  const lookup = id => win.get(id);

  function bodyNode(message, text, extra = '') {
    const body = h('div', { class: `bots-msg-body ${extra}`.trim() });
    if (raw.has(message.id)) { body.append(h('pre', { class: 'bots-raw', text: message.content || '' })); return body; }
    opts.renderBody(body, text, false);
    return body;
  }
  function userBody(message) {
    const body = bodyNode(message, message.content || '');
    if (!shouldCollapse(message.content)) return body;
    body.classList.add('collapsed');
    const toggle = h('button', { type: 'button', class: 'bots-link', text: 'Show full', 'aria-expanded': 'false', onclick: () => {
      const open = body.classList.toggle('collapsed') === false; toggle.textContent = open ? 'Show less' : 'Show full'; toggle.setAttribute('aria-expanded', String(open));
    } });
    return h('div', { class: 'bots-collapsible' }, [body, toggle]);
  }
  function messageNode(row) {
    const message = row.message, user = message.role === 'user';
    const speaker = opts.messageAgent?.(message) || opts.agent;
    const card = h('article', { class: `bots-msg ${user ? 'user' : 'bot'}${row.joinPrev ? ' join-prev' : ''}${row.joinNext ? ' join-next' : ''}${message.status === 'failed' ? ' failed' : ''}`,
      'data-message-id': message.id, 'data-role': message.role, tabindex: '-1' });
    const bubbles = h('div', { class: 'bots-msg-bubbles' });
    if (editing === message.id) {
      const editor = userEditor(message, { isSendKey: opts.isSendKey, onCancel: () => { editing = null; patchRow(message.id); },
        onSubmit: async text => { await opts.onEdit(message.id, text); editing = null; } });
      bubbles.append(h('div', { class: 'bots-msg-bubble' }, [editor.node]));
      queueMicrotask(editor.focus);
    } else if (user) bubbles.append(h('div', { class: 'bots-msg-bubble' }, [userBody(message)]));
    else {
      const parts = opts.replyStyle?.() === 'conversational' && !raw.has(message.id) ? splitConversational(message.content) : [message.content || ''];
      for (const part of parts) bubbles.append(h('div', { class: 'bots-msg-bubble' }, [bodyNode(message, part)]));
    }
    const meta = h('div', { class: 'bots-msg-meta' }, [timeNode(message),
      message.via === 'api' ? h('span', { class: 'bots-msg-via', text: 'Sent through the API, not typed here' }) : null,
      ctx().pinnedId === message.id ? h('span', { class: 'bots-msg-via', text: 'Pinned' }) : null,
      versionSwitcher(message, (id, m) => opts.selectVersion?.(id, m))]);
    const parts = [replyQuote(message, lookup, opts.jump), bubbles, attachmentGallery(message.attachments, { sessionId: opts.sessionId }),
      citationBadges(message, opts.goToSource), reactionBar(message, opts.react), meta];
    card.append(...parts.filter(Boolean));
    if (!row.joinPrev && !user && opts.kip) card.prepend(h('div', { class: 'bots-msg-face', 'aria-hidden': 'true' }, [opts.kip(speaker, 24, 'idle')]));
    if (!row.joinPrev && opts.speakerLabels) card.prepend(h('strong', { class: 'bots-room-speaker', text: user ? 'You' : speaker.name }));
    if (opts.room) {
      const p = message.meta?.auto?.p;
      if (Number.isFinite(p)) card.append(h('span', { class: 'bots-hint', text: `Chosen by auto (${Math.round(p * 100)} percent)` }));
    }
    if (!opts.room) card.append(messageTray(message, { ...ctx(), raw: raw.has(message.id) }, { ...opts.handlers, raw: m => toggleRaw(m.id) }));
    else if (opts.handlers) card.append(h('div', { class: 'bots-msg-tray', role: 'toolbar', 'aria-label': 'Message actions' },
      [['reply', 'Reply'], ['copy', 'Copy'], ['pin', ctx().pinnedId === message.id ? 'Unpin' : 'Pin']].filter(([key]) => opts.handlers[key])
        .map(([key, label]) => h('button', { type: 'button', class: 'bots-btn', text: label, onclick: () => opts.handlers[key](message) }))));
    touchTray(card);
    return card;
  }
  function richNode(row) {
    const m = row.message;
    if (row.type === 'compaction') return h('details', { class: 'bots-chip-row', 'data-message-id': m.id }, [h('summary', { text: 'Earlier messages summarised' }), h('div', { class: 'bots-chip-detail' }, [bodyNode(m, m.summary || m.content || '')])]);
    if (row.type === 'digest') return h('details', { class: 'bots-chip-row digest', 'data-message-id': m.id }, [h('summary', { text: digestLabel(m.digest) }),
      m.digest?.tool_names?.length ? h('ul', { class: 'bots-chip-detail' }, m.digest.tool_names.slice(0, 8).map(t => h('li', { text: t }))) : null]);
    if (['stop', 'stopped', 'goal_digest'].includes(row.type)) return h('div', { class: 'bots-quiet-row', 'data-message-id': m.id, text: m.content || 'You stopped this.' });
    if (row.type === 'verify') return h('div', { class: 'bots-verify', 'data-message-id': m.id }, [h('div', { class: 'bots-verify-head', text: verifySummary(m.verify?.steps) }),
      h('ul', {}, (m.verify?.steps || []).map(s => h('li', { class: s.status, text: `${s.label} · ${s.status}` })))]);
    return messageNode({ ...row, type: 'message' });
  }
  function rowNode(row) {
    if (row.type === 'day') return h('div', { class: 'bots-day', role: 'separator', text: row.label });
    if (row.type === 'unread') return h('div', { class: 'bots-unread', role: 'separator', text: 'New messages' });
    return renderRegisteredRow(row.type, row, opts) || (row.rich && row.type !== 'message' ? richNode(row) : messageNode(row));
  }

  function draw({ keep = false, anchor = null } = {}) {
    const before = { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
    rows = buildRows(win.slice(), { readId, simple: opts.simple ? opts.simple() : true });
    nodes.clear();
    const frag = rows.map(row => { const node = rowNode(row); if (row.message) nodes.set(row.message.id, node); return node; });
    log.replaceChildren(...frag, ...(live ? [live.node] : []));
    if (anchor) scroller.scrollTop = anchorAfterPrepend(before, scroller.scrollHeight);
    else if (keep) scroller.scrollTop = before.scrollTop;
    else if (follow.following()) scroller.scrollTop = scroller.scrollHeight;
    pills();
  }
  function patchRow(id) {
    const row = rows.find(r => r.message?.id === id), old = nodes.get(id);
    if (!row || !old) return;
    row.message = win.get(id) || row.message;
    const next = rowNode(row); old.replaceWith(next); nodes.set(id, next);
  }
  function pills() {
    const below = win.hiddenBelow();
    later.hidden = below === 0; later.textContent = below ? `Show ${below} later` : '';
    const away = !follow.following();
    jump.hidden = !away && win.atLatest();
    jump.classList.toggle('new-reply', away && !!live);
  }
  const toggleRaw = id => { if (raw.has(id)) raw.delete(id); else raw.add(id); patchRow(id); };

  // -- Scrolling --------------------------------------------------------------------
  const typing = () => ['TEXTAREA', 'INPUT'].includes(document.activeElement?.tagName);
  scroller.addEventListener('wheel', e => { if (upwardGesture(e)) follow.gesture(); pills(); }, { passive: true });
  let touchY = 0;
  scroller.addEventListener('touchstart', e => { touchY = e.touches[0]?.clientY ?? 0; }, { passive: true });
  scroller.addEventListener('touchmove', e => { if (upwardGesture({ type: 'touchmove', movedDown: (e.touches[0]?.clientY ?? 0) - touchY > 6 })) follow.gesture(); }, { passive: true });
  scroller.addEventListener('keydown', e => { if (upwardGesture(e, { typing: typing() })) follow.gesture(); });
  scroller.addEventListener('pointerdown', e => { if (e.target === scroller && e.offsetX > scroller.clientWidth) follow.gesture(); });
  scroller.addEventListener('scroll', () => {
    follow.scrolled({ top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight });
    if (scroller.scrollTop < TOP_REVEAL_PX && !loading) {
      if (win.hiddenAbove()) { win.revealOlder(40); draw({ anchor: true }); }
      else if (opts.onNeedOlder) { loading = true; Promise.resolve(opts.onNeedOlder()).finally(() => { loading = false; }); }
    }
    pills();
  }, { passive: true });

  function jumpToLatest() {
    follow.jump();
    if (!win.atLatest()) { win.latest(); draw(); }
    scroller.scrollTo?.({ top: scroller.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' }) ?? (scroller.scrollTop = scroller.scrollHeight);
    pills();
  }
  function scrollToMessage(id, { flash = true } = {}) {
    if (!win.has(id)) return false;
    if (!nodes.has(id)) { win.around(id); follow.gesture(); draw({ keep: true }); }
    const node = nodes.get(id); if (!node) return false;
    follow.gesture();
    node.scrollIntoView?.({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    if (flash) flashMessage(id);
    pills();
    return true;
  }
  function flashMessage(id) {
    nodes.get(id)?.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => nodes.get(id)?.classList.remove('flash'), 1800);
  }

  // -- The live reply -----------------------------------------------------------------
  function buildLive() {
    const face = h('span', { class: 'bots-live-face' }, [opts.kip ? opts.kip(opts.agent, 36, 'thinking') : null]);
    const status = h('span', { class: 'bots-live-line', role: 'status' });
    const body = h('div', { class: 'bots-msg-body' });
    const steps = h('details', { class: 'bots-now' }, [h('summary', { text: 'What it is doing' })]);
    const stepList = h('ul', { class: 'bots-now-steps' }), tail = h('pre', { class: 'bots-now-tail', hidden: true });
    steps.append(stepList, tail);
    const bubble = h('div', { class: 'bots-msg-bubble', hidden: true }, [body]);
    const node = h('article', { class: 'bots-msg bot bots-live', 'aria-busy': 'true', 'data-live': '' }, [h('div', { class: 'bots-presence' }, [face, status]), bubble, steps]);
    return { node, face, status, body, bubble, stepList, tail, steps, cursor: h('span', { class: 'msg-cursor' }), openFold: new Set() };
  }
  function paintLive() {
    if (!live || !live.entry) return;
    const entry = live.entry, state = liveStatus(entry);
    const speaker = opts.liveAgent?.(entry);
    if (speaker && live.speakerId !== speaker.id) {
      live.speakerId = speaker.id;
      if (opts.kip) live.face.replaceChildren(opts.kip(speaker, 36, 'thinking'));
    }
    live.status.textContent = state.line; live.node.dataset.state = state.state;
    if (speaker) live.status.textContent = `${speaker.name}: ${state.line}`;
    if (opts.room && entry.incomplete) live.status.textContent = `${speaker?.name || 'Bot'} is replying. Waiting for the complete reply.`;
    live.node.setAttribute('aria-busy', String(entry.status === 'processing'));
    live.face.firstElementChild?.setState?.(state.state === 'needs' ? 'alert' : state.state === 'working' ? 'working' : 'thinking');
    const text = entry.text || '';
    live.bubble.hidden = !text;
    if (text !== live.lastText) {
      live.lastText = text;
      const parts = opts.replyStyle?.() === 'conversational' ? splitConversational(text) : [text];
      opts.renderBody(live.body, parts.join('\n\n'), entry.status === 'processing');
    }
    if (entry.status === 'processing' && text) live.body.append(live.cursor); else live.cursor.remove();
    const folded = foldSteps(state.steps);
    live.stepList.replaceChildren(...folded.slice(-4).map(item => item.type === 'run'
      ? h('li', { class: 'done' }, [foldLabel(item.count)])
      : h('li', { class: item.step.state }, [`${item.step.state === 'failed' ? 'Failed' : item.step.state === 'done' ? 'Done' : 'Working'} · ${item.step.summary}`])));
    const tail = [...state.steps].reverse().find(s => s.detail)?.detail;
    live.tail.hidden = !tail; live.tail.textContent = tail ? String(tail).split('\n').slice(-2).join('\n').slice(0, 320) : '';
    live.steps.hidden = !state.steps.length;
    if (follow.following()) scroller.scrollTop = scroller.scrollHeight;
    pills();
  }
  function setLive(entry) {
    if (!entry) { clearLive(); return; }
    if (!live) { live = buildLive(); log.append(live.node); }
    live.entry = entry; paintLive();
    if (!liveTimer) liveTimer = setInterval(() => { if (live?.entry?.status === 'processing') live.status.textContent = liveStatus(live.entry).line; }, 1000);
  }
  function clearLive() {
    clearInterval(liveTimer); liveTimer = null;
    live?.node.remove(); live = null; pills();
  }

  function renderPinned(message) {
    pinned.hidden = !message;
    if (!message) { pinned.replaceChildren(); return; }
    pinned.replaceChildren(
      h('button', { type: 'button', class: 'bots-pinned-text', 'aria-label': 'Go to the pinned message', onclick: () => opts.jump?.(message.id) }, [h('strong', { text: 'Pinned' }), h('span', { text: String(message.content || message.snippet || '').replace(/\s+/g, ' ').slice(0, 140) })]),
      h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Unpin', title: 'Unpin', text: '×', onclick: () => opts.onUnpin?.() }));
  }

  return {
    root, scroller, log,
    setMessages(list, { read = null, keepPosition = false } = {}) { readId = read; win.set(list); if (!keepPosition) follow.jump(); draw({ keep: keepPosition }); },
    append(message) { const showing = win.append(message); if (showing) { draw(); } else pills(); return showing; },
    patch(id, fields) { if (win.patch(id, fields)) patchRow(id); },
    remove(id) { if (win.remove(id)) draw({ keep: true }); },
    // An older page lands above the window; if the reader is still at the top, the first rows of it come into view too.
    prepend(older) { const n = win.prepend(older); if (n) { if (scroller.scrollTop < TOP_REVEAL_PX) win.revealOlder(40); draw({ anchor: true }); } return n; },
    appendPage(newer) { const n = win.appendPage(newer); pills(); return n; },
    loadedIds: () => win.all().map(m => m.id), get: id => win.get(id), has: id => win.has(id),
    around(list, id) { win.set(list); win.around(id); follow.gesture(); draw({ keep: true }); },
    scrollToMessage, jumpToLatest, flashMessage, setLive, clearLive, renderPinned, toggleRaw, liveMount: () => live?.node || log,
    startEdit(id) { editing = id; patchRow(id); }, stopEdit() { const id = editing; editing = null; if (id) patchRow(id); }, editing: () => editing,
    lastUserMessage: () => [...win.all()].reverse().find(m => m.role === 'user' && !m.kind) || null,
    isFollowing: () => follow.following(),
    announce(text) { announcer.textContent = ''; setTimeout(() => { if (!disposed) announcer.textContent = text; }, 30); },
    redraw: () => draw({ keep: true }),
    dispose() { disposed = true; clearInterval(liveTimer); clearTimeout(flashTimer); root.remove(); },
  };
}
