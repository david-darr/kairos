// Find in a conversation, landing on a search hit, and export (Phase 1, U3).
//
// Search itself is U1's GET /api/bot-chat/search (literal, scoped, branch-aware);
// this file debounces the request, drops stale answers, cycles the hits and
// walks a hit into view: select its branch, load around it, scroll, flash.
import { h } from './botsMessageActions.js';
import { icon } from './botsIcons.js';

export const FIND_DEBOUNCE = 180, SIDEBAR_DEBOUNCE = 250, PALETTE_DEBOUNCE = 150, FLASH_MS = 1800;
export const MIN_QUERY = 1, SIDEBAR_MIN_QUERY = 2;

// Debounce with an injectable clock. `run(value)` is called once, with the latest value.
export function debounced(run, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const call = (...args) => { clearTimer(timer); timer = setTimer(() => { timer = null; run(...args); }, ms); };
  call.cancel = () => { clearTimer(timer); timer = null; };
  return call;
}

export const searchUrl = ({ query, sessionId = '', agentId = '', limit = 100 }) => {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (sessionId) params.set('session_id', sessionId);
  if (agentId) params.set('agent_id', agentId);
  return `/api/bot-chat/search?${params}`;
};

// Hits arrive newest first. Cycling wraps and keeps the position when the list is refreshed.
export function cycle(index, count, delta) { return count ? (index + delta + count) % count : -1; }

// The hits a server returned, reduced to what this UI reads.
export function normalizeHits(payload) {
  const list = Array.isArray(payload?.hits) ? payload.hits : Array.isArray(payload) ? payload : [];
  return list.filter(hit => hit && typeof hit.message_id === 'string').map(hit => ({
    message_id: hit.message_id, session_id: hit.session_id || null, leaf_id: hit.leaf_id || null,
    active: hit.active !== false, snippet: String(hit.snippet || '').slice(0, 240), ts: hit.ts || 0,
  }));
}

// Walk a hit into view. ctx: { currentSession, openThread(sessionId), selectBranch(leafId), loadAround(messageId), scrollTo(messageId), flash(messageId) }.
// Every step awaits the last, and a newer landing cancels an older one (ctx.token()).
export async function landOnHit(hit, ctx) {
  const mine = ctx.token?.();
  const stale = () => ctx.token && ctx.token() !== mine;
  if (hit.session_id && hit.session_id !== ctx.currentSession()) { await ctx.openThread(hit.session_id); if (stale()) return false; }
  if (!hit.active && hit.leaf_id) { await ctx.selectBranch(hit.leaf_id); if (stale()) return false; }
  if (!ctx.scrollTo(hit.message_id)) {
    await ctx.loadAround(hit.message_id); if (stale()) return false;
    if (!ctx.scrollTo(hit.message_id)) return false;
  }
  ctx.flash(hit.message_id);
  return true;
}

// The find bar. options: { search(query) -> Promise<payload>, land(hit), onClose, debounceMs }.
export function mountFindBar(host, { search, land, onClose, debounceMs = FIND_DEBOUNCE, setTimer, clearTimer }) {
  const input = h('input', { type: 'search', class: 'bots-find-input', 'aria-label': 'Find in this conversation', placeholder: 'Find in this conversation', autocomplete: 'off' });
  const count = h('span', { class: 'bots-find-count', role: 'status', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Previous match', onclick: () => step(-1) }, [icon('chevron-left', { size: 14 })]);
  const next = h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Next match', onclick: () => step(1) }, [icon('chevron-right', { size: 14 })]);
  const close = h('button', { type: 'button', class: 'bots-msg-act', 'aria-label': 'Close find', onclick: () => hide() }, [icon('x', { size: 14 })]);
  const label = h('span', { class: 'bots-find-other', hidden: true, text: 'Other version' });
  const root = h('div', { class: 'bots-find', role: 'search', hidden: true }, [input, count, label, prev, next, close]);
  host.append(root);
  let hits = [], at = -1, seq = 0;
  const paint = () => {
    count.textContent = !input.value.trim() ? '' : hits.length ? `${at + 1} of ${hits.length}` : 'No matches';
    label.hidden = !(hits[at] && !hits[at].active);
    prev.disabled = next.disabled = hits.length < 2;
  };
  const go = () => { if (hits[at]) Promise.resolve(land(hits[at])).catch(() => {}); paint(); };
  function step(delta) { at = cycle(at, hits.length, delta); go(); }
  const run = debounced(async () => {
    const query = input.value.trim(), mine = ++seq;
    if (query.length < MIN_QUERY) { hits = []; at = -1; paint(); return; }
    try {
      const found = normalizeHits(await search(query));
      if (mine !== seq) return; // A newer query is already on its way.
      hits = found; at = hits.length ? 0 : -1; go();
    } catch { if (mine === seq) { hits = []; at = -1; count.textContent = 'Search is unavailable'; } }
  }, debounceMs, { setTimer, clearTimer });
  input.addEventListener('input', run);
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
  });
  function show() { root.hidden = false; input.focus(); input.select(); }
  function hide() { run.cancel(); seq++; root.hidden = true; hits = []; at = -1; paint(); onClose?.(); }
  return { show, hide, toggle: () => (root.hidden ? show() : hide()), isOpen: () => !root.hidden, input, root };
}

// Download a redacted export. Markdown or JSON, 2,000 messages at most (the server enforces it).
export async function downloadExport(sessionId, format, { fetcher = fetch } = {}) {
  const kind = format === 'json' ? 'json' : 'markdown';
  const res = await fetcher(`/api/bot-chat/${encodeURIComponent(sessionId)}/export?format=${kind}`);
  if (!res.ok) throw new Error(`The export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: `conversation.${kind === 'json' ? 'json' : 'md'}` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
