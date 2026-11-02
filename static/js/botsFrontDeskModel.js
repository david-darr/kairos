// Pure front-desk presentation rules. Times are milliseconds.
export const TABS = Object.freeze(['chat', 'tasks', 'make']);
export function tabForPath(path = '') {
  const value = String(path).split(/[?#]/)[0].replace(/\/+$/, '');
  if (/(?:^|\/)tasks(?:\/|$)/.test(value)) return 'tasks';
  if (/(?:^|\/)make(?:\/|$)/.test(value)) return 'make';
  return 'chat';
}
export function tabFor(value) { return TABS.includes(value) ? value : tabForPath(value); }
export function badgeCount(work = {}) {
  if (Number.isFinite(work.needs_input_count)) return Math.max(0, Math.floor(work.needs_input_count));
  return (work.groups?.needs_input?.length || 0) + (work.loose?.questions?.length || 0) + (work.loose?.approvals?.length || 0);
}
export function badgeDigits(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n ? n > 99 ? '99+' : String(n) : '';
}
export function stepPill({ working = false, step = '', changedAt = 0, now = Date.now(), needs = false } = {}) {
  if (needs) return 'Needs you';
  if (!working) return '';
  const elapsed = Math.max(0, now - changedAt);
  return elapsed >= 60000 ? 'This is taking a while' : elapsed >= 20000 ? 'Still working' : String(step || 'Thinking').slice(0, 100);
}
export function kipState({ needs = false, working = false, draft = '', answeredAt = null, finishedAt = null, tab = 'chat', now = Date.now(), off = false } = {}) {
  if (finishedAt !== null && now - finishedAt >= 0 && now - finishedAt < 2600) return 'success';
  if (needs) return 'needs';
  if (working) return 'thinking';
  if (off) return 'sleeping';
  if (tab !== 'chat') return 'idle';
  if (String(draft).trim()) return 'listening';
  if (answeredAt !== null && now - answeredAt >= 0 && now - answeredAt < 2600) return 'success';
  return 'idle';
}
export const swipeThreshold = width => Math.max(96, Math.max(0, Number(width) || 0) * .35);
export function swipeMove({ dx = 0, dy = 0, width = 0, locked = '' } = {}) {
  if (locked === 'vertical') return { axis: 'vertical', action: null, progress: 0 };
  if (!locked && Math.max(Math.abs(dx), Math.abs(dy)) < 8) return { axis: '', action: null, progress: 0 };
  if (!locked && Math.abs(dy) >= Math.abs(dx)) return { axis: 'vertical', action: null, progress: 0 };
  const progress = Math.min(1, Math.abs(dx) / swipeThreshold(width));
  return { axis: 'horizontal', action: progress >= 1 ? dx > 0 ? 'start' : 'hide' : null, progress };
}
// Apply per turn, preserving normal rows, then cards in creation order and one last chip set.
export function orderTurnCards(messages, { pending = false, firstDay = false, streaming = false } = {}) {
  const words = [], cards = []; let chips;
  for (const row of messages || []) {
    if (row.type !== 'fd_card') words.push(row);
    else if (row.fd_kind === 'chips') chips = row;
    else cards.push(row);
  }
  return [...words, ...cards, ...(!pending && !firstDay && !streaming && chips ? [chips] : [])];
}
export function entranceDelay(index, count, { history = true, firstDay = false } = {}) {
  if (history) return null;
  return firstDay ? Math.max(0, index) * 400 : Math.max(0, index - Math.max(0, count - 12)) * 40;
}
export function safeHttps(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\\]/.test(value)) return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}
// What the front desk says it watches (routes/front_desk_watch_routes.py /watch, plus the custom tabs with Home cards).
export function watchLine(watch, tabNames = []) {
  if (!watch || typeof watch !== 'object') return '';
  const sources = [watch.connected?.calendar ? 'Calendar' : '', watch.connected?.mail ? 'Mail' : '', ...tabNames].filter(Boolean);
  const list = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  if (watch.state === 'working' && sources.length) return `Watching ${list([...new Set(sources)])}`;
  if (watch.state === 'paused') return 'Not watching your day. It is paused.';
  if (watch.state === 'off') return 'Not watching your day yet.';
  if (watch.state === 'not_connected') return 'Connect mail or calendar so Kip can watch your day.';
  return '';
}
// The desktop Today panel: the brief's Needs you, Your day and Important emails, then each custom tab's Home cards.
export const TODAY_SECTIONS = Object.freeze({ needs: 'Needs you', day: 'Calendar', mail: 'Mail' });
export function todayView(brief, cards = []) {
  const sections = (Array.isArray(brief?.sections) ? brief.sections : []).filter(s => TODAY_SECTIONS[s.id])
    .map(s => ({ id: s.id, label: TODAY_SECTIONS[s.id], rows: (s.rows || []).slice(0, 4).map(r => ({ text: String(r.text || ''), note: String(r.note || '') })),
      more: Math.max(0, (s.rows || []).length - 4) + (s.more || 0), empty: s.empty || '' }));
  const tabs = (Array.isArray(cards) ? cards : []).slice(0, 6).map(card => ({ id: card.id, label: String(card.tab_name || card.title || 'Tab'), title: String(card.title || ''),
    rows: card.kind === 'list' ? (card.rows || []).slice(0, 4).map(r => ({ text: String(r.title || ''), note: [r.meta, r.badge].filter(Boolean).join(' · ') }))
      : [{ text: card.kind === 'progress' ? `${card.value} of ${card.total}` : String(card.value ?? ''), note: [card.label, card.detail].filter(Boolean).join(' · ') }],
    empty: card.empty_text || 'Nothing here yet.' }));
  return { date: String(brief?.date_label || ''), sections, tabs };
}
