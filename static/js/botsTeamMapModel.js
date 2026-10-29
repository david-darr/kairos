// Canvas policy. No page, storage or transport dependencies.
export const CARD = Object.freeze({ width: 236, height: 126, gap: 16, padding: 20, header: 64, maxColumns: 6 });
export const CANVAS_KEY = 'kairos:bots-team-canvas';
export const MIN_SCALE = .3, MAX_SCALE = 1.5, DRAG_THRESHOLD = 5;
const num = (v, fallback = 0) => typeof v === 'number' && Number.isFinite(v) ? v : fallback;
export const clampPosition = v => Math.max(-99999, Math.min(99999, num(v)));
export const clampScale = v => Math.max(MIN_SCALE, Math.min(MAX_SCALE, num(v, 1)));
export const point = p => ({ x: clampPosition(p?.x), y: clampPosition(p?.y) });
export function bestColumns(count, available = 1100) {
  const max = Math.min(CARD.maxColumns, Math.max(1, Math.floor((num(available, 1100) - 2 * CARD.padding + CARD.gap) / (CARD.width + CARD.gap))));
  return Math.max(1, Math.min(max, Math.ceil(Math.sqrt(Math.max(1, num(count)) * CARD.height / CARD.width))));
}
export function teamSize(count, columns = bestColumns(count)) {
  columns = Math.max(1, Math.min(CARD.maxColumns, Math.floor(num(columns, 1))));
  return { width: CARD.padding * 2 + columns * CARD.width + (columns - 1) * CARD.gap,
    height: CARD.header + CARD.padding * 2 + Math.max(1, Math.ceil(Math.max(0, num(count)) / columns)) * (CARD.height + CARD.gap) - CARD.gap, columns };
}
export function readLayout(raw) {
  const teams = Object.create(null);
  if (raw && typeof raw.teams === 'object' && raw.teams) for (const [id, p] of Object.entries(raw.teams).slice(0, 200)) {
    if (/^[A-Za-z0-9_-]{1,128}$/.test(id)) teams[id] = point(p);
  }
  return { ...point(raw), scale: clampScale(raw?.scale), teams };
}
export function zoomAt(view, cursor, scale) {
  const old = clampScale(view?.scale), next = clampScale(scale);
  return { ...view, x: clampPosition(cursor.x - (cursor.x - num(view.x)) * next / old), y: clampPosition(cursor.y - (cursor.y - num(view.y)) * next / old), scale: next };
}
export function bounds(tiles) {
  if (!tiles?.length) return { x: 0, y: 0, width: CARD.width + 40, height: CARD.height + 104 };
  const x = Math.min(...tiles.map(t => t.x)), y = Math.min(...tiles.map(t => t.y));
  return { x, y, width: Math.max(...tiles.map(t => t.x + t.width)) - x, height: Math.max(...tiles.map(t => t.y + t.height)) - y };
}
export function fitToView(tiles, viewport, padding = 32) {
  const b = bounds(tiles), width = Math.max(1, num(viewport?.width, 800)), height = Math.max(1, num(viewport?.height, 600));
  const scale = Math.max(MIN_SCALE, Math.min(1, (width - padding * 2) / b.width, (height - padding * 2) / b.height));
  return { x: clampPosition((width - b.width * scale) / 2 - b.x * scale), y: clampPosition((height - b.height * scale) / 2 - b.y * scale), scale };
}
export function gesture(start, current, kind = 'pan') { return Math.hypot(current.x - start.x, current.y - start.y) < DRAG_THRESHOLD ? 'click' : ['bot', 'team'].includes(kind) ? kind : 'pan'; }
export const dropTarget = (p, tiles, excluding) => [...tiles].reverse().find(t => t.id !== excluding && p.x >= t.x && p.x <= t.x + t.width && p.y >= t.y && p.y <= t.y + t.height) || null;
export const botState = bot => bot?.needs_you || bot?.waiting_on_user || ['needs_you', 'waiting-on-user'].includes(bot?.status) ? { state: 'needs_you', label: 'Waiting for you' }
  : ['working', 'processing', 'running'].includes(bot?.status) ? { state: 'working', label: 'Working' }
    : bot?.enabled === false || ['unavailable', 'not-responding', 'error', 'off'].includes(bot?.status) ? { state: 'off', label: 'No signal' } : { state: 'idle', label: 'Ready' };
export function mapData(raw = {}) {
  const flat = raw.bots || raw.members || [], byId = new Map(flat.map(b => [b.id || b.bot_id, b]));
  const seen = new Set();
  const departments = (raw.departments || raw.teams || []).map(team => ({ ...team, members: (team.members || team.bot_ids || flat.filter(b => b.section === team.name)).map(b => typeof b === 'string' ? byId.get(b) : b).filter(b => b && !b.hidden).map(b => { const id = b.id || b.bot_id; seen.add(id); return { ...b, id, chief: b.chief || team.chief_bot_id === id }; }) }));
  const loose = flat.filter(b => !b.hidden && !seen.has(b.id || b.bot_id)).map(b => ({ ...b, id: b.id || b.bot_id }));
  if (loose.length) departments.push({ id: 'ungrouped', name: 'Other bots', ungrouped: true, members: loose });
  return { departments, bots: departments.flatMap(t => t.members), rooms: raw.rooms || [], edges: (raw.handoffs || raw.edges || raw.live_edges || []).slice(0, 12) };
}
export function layoutTeams(teams, saved = {}, available = 1100) {
  let x = 0;
  return teams.map(t => { const size = teamSize(t.members.length, bestColumns(t.members.length, available)), pos = saved[t.id] ? point(saved[t.id]) : { x, y: 0 }; x += size.width + 40; return { ...t, ...size, ...pos }; });
}
export const tagSlug = text => String(text || '').toLowerCase().trim().replace(/\s+/g, '-');
export function taggedBots(text, selected, data) {
  const ids = new Set(selected);
  const tokens = String(text).match(/@[\p{L}\p{N}_-]+/gu)?.map(t => t.slice(1).toLowerCase()) || [];
  for (const token of tokens) {
    if (token === 'everyone') data.bots.forEach(b => ids.add(b.id));
    data.bots.filter(b => [b.id, b.slug, tagSlug(b.name)].some(v => String(v || '').toLowerCase() === token)).forEach(b => ids.add(b.id));
    data.departments.filter(t => [t.id, tagSlug(t.name)].includes(token)).forEach(t => t.members.forEach(b => ids.add(b.id)));
  }
  return data.bots.filter(b => ids.has(b.id));
}
