// Sidebar policy, independent of DOM, storage and fetch. Server thread metadata
// remains authoritative; these preferences only change presentation.
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
export const SIDEBAR_SECTIONS = ['pinned', 'attention', 'bots'];
export const sidebarPreferenceKey = user => `kairos:bots-sidebar:${encodeURIComponent(user || 'local')}`;
export function clampSidebarWidth(value, viewport = 1440) {
  const max = Math.max(240, Math.min(480, number(viewport) - 320));
  return Math.round(Math.max(240, Math.min(max, number(value) || 280)));
}
const ids = value => [...new Set(list(value).filter(v => typeof v === 'string' && v.length <= 128))].slice(0, 100);
export function sidebarPreferences(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const order = ids(value.sections).filter(v => SIDEBAR_SECTIONS.includes(v));
  return { density: ['comfortable', 'compact', 'icons'].includes(value.density) ? value.density : 'comfortable',
    widths: { simple: clampSidebarWidth(value.widths?.simple || 280), advanced: clampSidebarWidth(value.widths?.advanced || 320) },
    sections: [...order, ...SIDEBAR_SECTIONS.filter(v => !order.includes(v))],
    collapsed: ids(value.collapsed).filter(v => SIDEBAR_SECTIONS.includes(v)), expanded: ids(value.expanded),
    closedFolders: ids(value.closedFolders), pinnedOrder: ids(value.pinnedOrder) };
}
export function reorder(items, id, offset) {
  const next = [...items], from = next.indexOf(id);
  if (from < 0) return next;
  const to = Math.max(0, Math.min(next.length - 1, from + offset));
  next.splice(from, 1); next.splice(to, 0, id); return next;
}
export function threadAttention(row, currentId = '') {
  const t = row.thread || {};
  if (row.needs_you || row.open_asks || row.waiting_on_you || row.status === 'needs_you') return 0;
  if (row.status === 'working' || row.status === 'processing') return 1;
  if (row.waiting_on_teammate || row.status === 'waiting' || row.status === 'teammate') return 2;
  if (row.queued || row.queue_count > 0 || row.status === 'queued') return 3;
  if (t.unread || row.unread) return 4;
  if (row.id === currentId) return 5;
  return 6;
}
export function visibleThreads(rows, { currentId = '', now = Date.now() / 1000, all = false } = {}) {
  const ordinary = list(rows).filter(row => row && !row.thread?.archived_at && !row.thread?.routine_run_id);
  const sorted = ordinary.slice().sort((a, b) => threadAttention(a, currentId) - threadAttention(b, currentId)
    || number(b.updated_at) - number(a.updated_at) || String(a.id).localeCompare(String(b.id)));
  const recent = new Set(ordinary.filter(row => !row.thread?.pinned && row.id !== currentId && threadAttention(row) >= 6
    && !(row.thread?.snoozed_until === 0 || number(row.thread?.snoozed_until) > now))
    .sort((a, b) => number(b.updated_at) - number(a.updated_at) || String(a.id).localeCompare(String(b.id))).slice(0, 6).map(row => row.id));
  return sorted.filter(row => {
    const exception = row.thread?.pinned || row.id === currentId || threadAttention(row) < 4;
    const snoozed = row.thread?.snoozed_until === 0 || number(row.thread?.snoozed_until) > now;
    return exception || (!snoozed && (all || row.thread?.unread || row.unread || recent.has(row.id)));
  });
}
export function folderTree(rows, folders, options) {
  const visible = visibleThreads(rows, options), known = new Set(list(folders).map(f => f.id));
  return [{ id: null, name: 'Conversations', threads: visible.filter(r => !known.has(r.thread?.folder_id)) },
    ...list(folders).map(folder => ({ ...folder, threads: visible.filter(row => row.thread?.folder_id === folder.id) }))];
}
export function orderedPins(bots, conversations, preference) {
  const pinned = new Set(list(conversations).filter(row => row.pinned).map(row => row.id));
  const rank = new Map(list(preference).map((id, i) => [id, i]));
  return list(bots).filter(bot => !bot.hidden && pinned.has(bot.id)).sort((a, b) => (rank.get(a.id) ?? 1000) - (rank.get(b.id) ?? 1000));
}

// -- Layout rules ---------------------------------------------------------------
// Comfortable widths are 280 (Simple) and 320 (Advanced); compact is 272; icons are
// 92 (Simple) and 80 (Advanced). Only comfortable can be resized, 240 to 480.
export const DENSITIES = ['comfortable', 'compact', 'icons'];
export function railWidth(density, advanced, widths = {}, viewport = 1440) {
  if (density === 'icons') return advanced ? 80 : 92;
  if (density === 'compact') return 272;
  return clampSidebarWidth(advanced ? widths.advanced || 320 : widths.simple || 280, viewport);
}
export const nextDensity = density => DENSITIES[(DENSITIES.indexOf(density) + 1) % DENSITIES.length] || 'comfortable';
// A key on the resize separator: arrows step 16 px (48 with Shift), Home and End go to the ends.
export function widthAfterKey(width, key, shift = false, viewport = 1440) {
  const step = shift ? 48 : 16;
  const next = key === 'ArrowLeft' ? width - step : key === 'ArrowRight' ? width + step
    : key === 'Home' ? 0 : key === 'End' ? Infinity : null;
  if (next === null) return null;
  return clampSidebarWidth(next === Infinity ? 480 : next === 0 ? 240 : next, viewport);
}
export const widthBounds = (viewport = 1440) => ({ min: 240, max: Math.max(240, Math.min(480, number(viewport) - 320)) });

// -- Search ----------------------------------------------------------------------
// The sidebar's search starts at two characters. It matches bot names and jobs and
// the titles and previews of conversations already loaded; the server's own search
// (U1) is what finds words inside a conversation.
export const SEARCH_MIN = 2;
export const normalizeQuery = value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const searchReady = value => normalizeQuery(value).length >= SEARCH_MIN;
export function searchMatches(query, bots, threadsByBot = {}) {
  const q = normalizeQuery(query);
  if (q.length < SEARCH_MIN) return { bots: [], threads: [] };
  const has = text => String(text ?? '').toLowerCase().includes(q);
  const matchedBots = list(bots).filter(bot => bot && (has(bot.name) || has(bot.role) || has(bot.blurb)));
  const threads = [];
  for (const bot of list(bots)) {
    for (const row of list(threadsByBot[bot?.id]?.threads ?? threadsByBot[bot?.id])) {
      if (row && !row.thread?.archived_at && !row.thread?.routine_run_id && (has(row.title) || has(row.preview))) threads.push({ agentId: bot.id, row });
    }
  }
  threads.sort((a, b) => number(b.row.updated_at) - number(a.row.updated_at) || String(a.row.id).localeCompare(String(b.row.id)));
  return { bots: matchedBots, threads: threads.slice(0, 50) };
}

// -- Attention across bots -------------------------------------------------------
// Bots that need the person come first, then those at work; the rest are not listed.
export function attentionBots(bots, state) {
  const rank = { needs_you: 0, working: 1 };
  return list(bots).map(bot => ({ bot, rank: rank[state(bot)] })).filter(item => item.rank !== undefined)
    .sort((a, b) => a.rank - b.rank || String(a.bot.name || '').localeCompare(String(b.bot.name || ''))).map(item => item.bot);
}

// A bot's folders in the person's order, then the unfiled group, as folderTree() gives them.
export function botTree(rows, folders, options) {
  const ordered = list(folders).slice().sort((a, b) => number(a.order) - number(b.order) || String(a.id).localeCompare(String(b.id)));
  return folderTree(rows, ordered, options);
}

// Move a conversation between folders: the same rule drag and the menu both use.
export function canMoveThread(row, folderId, folders) {
  if (!row || row.thread?.archived_at) return false;
  const target = folderId || null;
  if ((row.thread?.folder_id || null) === target) return false;
  return target === null || list(folders).some(folder => folder.id === target);
}

// Remove from the loaded rows what a bulk delete took (the server keeps busy and last ones).
export function afterDelete(rows, result) {
  const gone = new Set(list(result?.deleted));
  return list(rows).filter(row => !gone.has(row.id));
}

// Team preferences extend the old shape without changing existing device preferences.
export function teamSidebarPreferences(value = {}) {
  const base = sidebarPreferences(value);
  const sections = [...new Set([...ids(value?.sections).filter(v => [...SIDEBAR_SECTIONS, 'channels'].includes(v)), 'channels', ...base.sections])];
  return { ...base, sections, collapsed: ids(value?.collapsed).filter(v => [...SIDEBAR_SECTIONS, 'channels'].includes(v)),
    teamOrder: ids(value?.teamOrder), closedTeams: ids(value?.closedTeams) };
}
export function teamGroups(bots, departments = [], preference = []) {
  const rank = new Map(preference.map((id, at) => [id, at]));
  const groups = departments.map(team => ({ ...team, members: list(bots).filter(b => b.section === team.name && !b.hidden) }));
  const known = new Set(groups.map(t => t.name));
  for (const name of [...new Set(list(bots).map(b => b.section).filter(Boolean))]) if (!known.has(name)) groups.push({ id: `section_${encodeURIComponent(name)}`, name, members: bots.filter(b => b.section === name && !b.hidden) });
  const loose = list(bots).filter(b => !b.section && !b.hidden);
  if (loose.length) groups.push({ id: 'ungrouped', name: 'Bots', members: loose, ungrouped: true });
  return groups.sort((a, b) => (rank.get(a.id) ?? 1000) - (rank.get(b.id) ?? 1000) || number(a.order) - number(b.order));
}
export function roomRow(room) {
  return { id: room.id, name: room.name || 'Room', working: room.working === true || room.status === 'working' || Number(room.working_count) > 0,
    unread: Math.max(0, number(room.unread_count || room.unread)) };
}
