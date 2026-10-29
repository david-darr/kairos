// The data panel's rules, without a DOM (Phase 6 unit U2, 2026-10-29): the splitter, paging, sorting, how a
// value is shown, what a failed query says, the live-run rule and the calls to /api/bot-data. Plain Node
// loads this file (scripts/test_bots_data_model.cjs); the API wrapper reaches api.js only when it is called.

export const SPLIT = { minQuery: 128, minResult: 180, step: 24, defaultQuery: 200, key: 'kairos:bots-data-split' };
export const RUN_DELAY_MS = 50;
export const ROW_HEIGHT = 28;
export const PAGE_SIZE = 100;
export const MAX_TABLE_ROWS = 1_000_000;
export const CHART_TYPES = ['bar', 'line', 'area', 'scatter', 'histogram', 'pie', 'heatmap'];
export const CHART_LABELS = { bar: 'Bar', line: 'Line', area: 'Area', scatter: 'Scatter', histogram: 'Histogram', pie: 'Pie', heatmap: 'Heatmap' };
export const AGGS = ['sum', 'avg', 'min', 'max', 'count'];

// -- the splitter between the result area (above) and the query editor (below) ----------------
// `total` is the height of the whole panel body; the query keeps at least 128 px and the result at least 180.
export function clampSplit(queryHeight, total) {
  const room = Number(total) || 0;
  if (room < SPLIT.minQuery + SPLIT.minResult) return Math.max(0, Math.round(room * SPLIT.minQuery / (SPLIT.minQuery + SPLIT.minResult)));
  const wanted = Number.isFinite(Number(queryHeight)) ? Number(queryHeight) : SPLIT.defaultQuery;
  return Math.round(Math.min(Math.max(wanted, SPLIT.minQuery), room - SPLIT.minResult));
}
// Keyboard on the separator: the arrows move 24 px (up grows the query, as the handle sits above it).
export function splitKey(current, key, total) {
  const at = clampSplit(current, total);
  if (key === 'ArrowUp') return clampSplit(at + SPLIT.step, total);
  if (key === 'ArrowDown') return clampSplit(at - SPLIT.step, total);
  if (key === 'Home') return clampSplit(SPLIT.minQuery, total);
  if (key === 'End') return clampSplit(Number.MAX_SAFE_INTEGER, total);
  return at;
}

// -- the grid: which rows are on screen and which pages they need -----------------------------
export function windowRange(scrollTop, viewport, total, rowHeight = ROW_HEIGHT, overscan = 6) {
  if (!(total > 0)) return { first: 0, last: -1 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total - 1, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { first, last };
}
export function pagesNeeded(range, pageSize = PAGE_SIZE) {
  if (range.last < range.first) return [];
  const pages = [];
  for (let p = Math.floor(range.first / pageSize); p <= Math.floor(range.last / pageSize); p++) pages.push(p);
  return pages;
}
// Click a header: none, then ascending, then descending, then none again. One sort column at a time.
export function nextSort(sort, column) {
  const current = (sort || []).find(item => item.column === column);
  if (!current) return [{ column, desc: false }];
  if (!current.desc) return [{ column, desc: true }];
  return [];
}
export function sortMark(sort, column) {
  const item = (sort || []).find(s => s.column === column);
  return item ? (item.desc ? 'descending' : 'ascending') : 'none';
}
// Filter text per column, empty ones dropped.
export function cleanFilters(filters) {
  return Object.fromEntries(Object.entries(filters || {}).map(([k, v]) => [k, String(v ?? '').trim()]).filter(([, v]) => v));
}

// -- showing values --------------------------------------------------------------------------
export function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  return text.length > 400 ? text.slice(0, 400) + '...' : text;
}
export function isNumeric(value) { return typeof value === 'number' && Number.isFinite(value); }
export function rowCountLabel(count, truncated = false) {
  if (count === null || count === undefined) return truncated ? 'More rows' : '';
  const n = Number(count).toLocaleString('en-US');
  return `${n} ${count === 1 ? 'row' : 'rows'}`;
}
// Copy as tab-separated text: tabs and line breaks inside a cell become spaces.
export function toTsv(columns, rows) {
  const clean = value => formatCell(value).replace(/[\t\r\n]+/g, ' ');
  return [columns.map(clean).join('\t'), ...rows.map(row => row.map(clean).join('\t'))].join('\n');
}

// -- cards ---------------------------------------------------------------------------------------
export function latestCard(cards) {
  return [...(cards || [])].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0] || null;
}
export function historyItems(cards, currentId) {
  return [...(cards || [])].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .map(card => ({ id: card.id, label: card.title || 'Result', pinned: !!card.pinned, current: card.id === currentId }));
}
// What a result shows: a chart when its card has a spec, text for one long text cell, else a table.
export function resultKind(card, result) {
  if (result?.error) return 'failed';
  if (result?.running) return 'running';
  if (card?.spec) return 'chart';
  const rows = result?.rows || [];
  if (rows.length === 1 && result.columns?.length === 1 && typeof rows[0][0] === 'string' && (rows[0][0].length > 160 || rows[0][0].includes('\n'))) return 'text';
  return 'table';
}
// Only a read runs while the person types; making a table waits for Run.
export function isLiveSafe(sql) { return /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*)(select|with|values)\b/i.test(sql || ''); }
export function failure(error) {
  const body = error?.body || {};
  const message = String(body.detail || error?.message || 'The query failed.').replace(/^\d+:\s*/, '');
  return { message, line: body.line || null, hint: body.hint || '' };
}
export function defaultSpec(type, columns, rows = []) {
  const names = columns || [];
  const firstNumeric = names.find((name, i) => rows.some(row => isNumeric(row[i])));
  const firstText = names.find(name => name !== firstNumeric) || names[0];
  if (!names.length) return null;
  if (type === 'histogram') return { type, x: firstNumeric || names[0], bins: 20 };
  if (type === 'scatter') return { type, x: names[0], y: names[1] || names[0] };
  if (type === 'heatmap') return { type, x: names[0], y: names[1] || names[0], agg: 'count' };
  return { type, x: firstText, y: firstNumeric && firstNumeric !== firstText ? firstNumeric : undefined, agg: firstNumeric && firstNumeric !== firstText ? 'sum' : 'count' };
}

// -- what the chat should know about the panel ---------------------------------------------------
const contexts = new Map();
export function setDataContext(agentId, context) { if (context) contexts.set(agentId, { ...context }); else contexts.delete(agentId); }
// { cardId, draftSql } for the composer to send with a message, or null when the panel shows nothing.
export function currentDataContext(agentId) {
  const c = contexts.get(agentId);
  if (!c || (!c.cardId && !c.draftSql)) return null;
  const out = {};
  if (c.cardId) out.cardId = c.cardId;
  if (c.draftSql && new TextEncoder().encode(c.draftSql).length <= 100 * 1024) out.draftSql = c.draftSql;
  return Object.keys(out).length ? out : null;
}

// -- the calls ---------------------------------------------------------------------------------------
export function dataApi(botId, fetcher) {
  const base = `/api/bot-data/${encodeURIComponent(botId)}`;
  const call = async (path, options = {}) => {
    // A direct fetch keeps the whole error body (detail, line, hint) for the failed card.
    const res = await (fetcher || fetch)(base + path, { headers: { 'Content-Type': 'application/json' }, ...options });
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch { /* not json */ }
      const error = new Error(`${res.status}: ${body.detail || res.statusText}`);
      error.status = res.status; error.body = body;
      throw error;
    }
    const type = res.headers?.get?.('content-type') || '';
    return type.includes('application/json') ? res.json() : res;
  };
  const json = (method, body) => ({ method, body: JSON.stringify(body) });
  return {
    overview: () => call(''),
    run: (body, signal) => call('/run', { ...json('POST', body), signal }),
    cancel: runId => call('/cancel', json('POST', { run_id: runId })),
    page: body => call('/page', json('POST', body)),
    load: body => call('/load', json('POST', body)),
    chart: cardId => call(`/cards/${encodeURIComponent(cardId)}/chart`),
    patchCard: (id, body) => call(`/cards/${encodeURIComponent(id)}`, json('PATCH', body)),
    deleteCard: id => call(`/cards/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    stats: table => call(`/tables/${encodeURIComponent(table)}/stats`),
    histogram: (table, column, bins = 20) => call(`/tables/${encodeURIComponent(table)}/histogram?column=${encodeURIComponent(column)}&bins=${bins}`),
    exportFile: async (cardId, format) => {
      const res = await (fetcher || fetch)(`${base}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ card_id: cardId, format }) });
      if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* not json */ }
        const error = new Error(`${res.status}: ${body.detail || res.statusText}`);
        error.status = res.status; error.body = body;
        throw error;
      }
      return res.blob();
    },
  };
}
export function newRunId() { return 'r' + Math.random().toString(36).slice(2, 12); }
