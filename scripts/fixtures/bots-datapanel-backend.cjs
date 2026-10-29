// The Bots data API (/api/bot-data), in memory, for the Electron checks (Phase 6 unit U2, 2026-10-29).
// ui-smoke.cjs consults every scripts/fixtures/bots-*-backend.cjs before demo/fixtures.js while demoState.botsLive is
// set: read(path, query) and mutate(path, method, body, query) answer a route or return undefined to let the demo have it.
// A check seeds state.botsDatapanel itself and restores it when done; nothing is seeded here, so no check depends on rows
// another check left. This is not a SQL engine: it understands the handful of statement shapes the check types (see
// evaluate()), answers anything else with the same kind of plain failure the server gives (message, line, hint), and keeps
// cards without rows, as the real store does. Statuses and field names follow routes/bot_data_routes.py;
// scripts/test_bots_data.py holds the real behaviour.
//
// state.botsDatapanel = {
//   bots: { [botId]: { tables: { [name]: { columns: [name], rows: [[...]] } }, cards: [{ id, title, sql, spec, pinned, created_at, updated_at }], seq: 0 } },
//   files: { 'sales.csv': { table: 'sales', columns: [name], rows: [[...]] } },   // what Load can find
//   runs: [{ botId, sql, card_id, run_id }],                                         // every run, newest last
//   failNext: { status, detail } | null,   // the next write fails
//   failRead: bool }                         // the overview read fails while set
const PAGE_MAX = 1024;
const ROWS_DEFAULT = 50;

module.exports = ({ state, now }) => {
  const store = () => state.botsDatapanel;
  const refuse = (status, detail, extra = {}) => ({ _status: status, detail, line: null, hint: '', ...extra });
  const bot = id => store()?.bots?.[id];
  const sources = b => Object.entries(b.tables).map(([name, t]) => ({ name, kind: 'table', rows: t.rows.length, columns: t.columns.map(c => ({ name: c, type: typeof (t.rows[0] || [])[t.columns.indexOf(c)] === 'number' ? 'REAL' : 'TEXT' })) }));
  const tick = () => Date.now() / 1000;

  function lineOf(sql, word) {
    const at = sql.toLowerCase().indexOf(word.toLowerCase());
    return at < 0 ? 1 : sql.slice(0, at).split('\n').length;
  }
  const num = v => (typeof v === 'number' ? v : Number(v));

  // select * from t [limit n] | select a, b from t [limit n] | select k, sum(v) as total from t group by 1 | create [or replace] table x as <select>
  function evaluate(b, sql) {
    const text = String(sql || '').trim().replace(/;+\s*$/, '');
    const low = text.toLowerCase().replace(/\s+/g, ' ');
    if (!low) throw refuse(400, 'Write a query first.', { hint: 'For example: SELECT * FROM my_table LIMIT 10' });
    if (/;/.test(text.replace(/'[^']*'/g, ''))) throw refuse(400, 'Run one statement at a time.', { line: 1, hint: 'Remove the extra statement after the semicolon.' });
    let created = null, body = low, rawBody = text;
    const make = low.match(/^create (?:or replace )?table (\w+) as (select .*)$/);
    if (make) { created = { name: make[1], kind: 'table' }; body = make[2]; rawBody = text.slice(text.toLowerCase().indexOf('select')); }
    else if (/^(insert|update|delete|drop|alter|attach|pragma|create)\b/.test(low)) {
      throw refuse(400, `Only reads and CREATE TABLE or VIEW ... AS are allowed here, not ${low.split(' ')[0].toUpperCase()}.`, { line: 1, hint: 'Use SELECT to look at data, or CREATE TABLE name AS SELECT ... to keep a result.' });
    }
    const group = body.match(/^select (\w+), sum\((\w+)\) as (\w+) from "?(\w+)"? group by 1(?: order by \w+(?: desc)?)?$/);
    if (group) {
      const t = b.tables[group[4]];
      if (!t) throw missing(b, group[4], text);
      const ki = t.columns.indexOf(group[1]), vi = t.columns.indexOf(group[2]);
      if (ki < 0 || vi < 0) throw refuse(400, `no such column: ${ki < 0 ? group[1] : group[2]}`, { hint: 'Check the column names with describe (data_describe).' });
      const sums = new Map();
      for (const r of t.rows) sums.set(r[ki], (sums.get(r[ki]) || 0) + num(r[vi]));
      return finish(b, created, [group[1], group[3]], [...sums.entries()].sort((a, c) => String(a[0]).localeCompare(String(c[0]))).map(([k, v]) => [k, v]));
    }
    const plain = body.match(/^select (\*|[\w, ]+) from "?(\w+)"?(?: limit (\d+))?$/);
    if (plain) {
      const t = b.tables[plain[2]];
      if (!t) throw missing(b, plain[2], text);
      let columns = t.columns, indexes = t.columns.map((_, i) => i);
      if (plain[1] !== '*') {
        const names = plain[1].split(',').map(s => s.trim());
        const bad = names.find(n => !t.columns.includes(n));
        if (bad) throw refuse(400, `no such column: ${bad}`, { hint: 'Check the column names with describe (data_describe).' });
        columns = names; indexes = names.map(n => t.columns.indexOf(n));
      }
      let rows = t.rows.map(r => indexes.map(i => r[i]));
      if (plain[3]) rows = rows.slice(0, Number(plain[3]));
      return finish(b, created, columns, rows);
    }
    // Not a shape this fixture knows: fail the way SQLite does, pointing at the first word it does not recognise.
    const known = new Set(['select', 'from', 'where', 'group', 'by', 'order', 'limit', 'as', 'sum', 'create', 'or', 'replace', 'table']);
    const odd = (low.match(/[a-z_]+/g) || []).find(w => !known.has(w) && !b.tables[w] && !(Object.values(b.tables).some(t => t.columns.includes(w)))) || low.split(' ')[0];
    throw refuse(400, `near "${odd}": syntax error`, { line: lineOf(text, odd), hint: 'SQLite flavour: check commas, quotes and keywords.' });
  }
  function missing(b, name, sql) {
    return refuse(400, `no such table: ${name}`, { line: lineOf(sql, name), hint: `Tables you have: ${Object.keys(b.tables).join(', ') || 'none yet'}. Load data first with data_load.` });
  }
  function finish(b, created, columns, rows) {
    if (created) b.tables[created.name] = { columns, rows };
    return { columns, rows, created };
  }
  const selectOf = (b, sql) => {
    const made = String(sql).trim().toLowerCase().match(/^create (?:or replace )?table (\w+) as /);
    return made ? `select * from ${made[1]}` : sql;
  };
  function compileChart(spec, columns, rows) {
    const xi = columns.indexOf(spec.x), yi = spec.y ? columns.indexOf(spec.y) : -1;
    if (xi < 0) return { type: spec.type, fields: ['x', 'y'], rows: [], note: null, spec, marks: 0 };
    if (spec.type === 'bar' || spec.type === 'pie') {
      const sums = new Map();
      for (const r of rows) sums.set(String(r[xi]), (sums.get(String(r[xi])) || 0) + (yi >= 0 ? num(r[yi]) : 1));
      const list = [...sums.entries()].sort((a, c) => c[1] - a[1]);
      return { type: spec.type, fields: ['x', 'y'], rows: list, note: null, spec, marks: list.length };
    }
    if (spec.type === 'histogram') {
      const values = rows.map(r => num(r[xi])).filter(Number.isFinite);
      const lo = Math.min(...values), hi = Math.max(...values), bins = spec.bins || 20;
      const out = Array.from({ length: bins }, (_, i) => [lo + (i * (hi - lo)) / bins, lo + ((i + 1) * (hi - lo)) / bins, 0]);
      for (const v of values) out[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo || 1)) * bins))][2]++;
      return { type: 'histogram', fields: ['x0', 'x1', 'y'], rows: out.filter(r => r[2]), note: null, spec, marks: out.length };
    }
    const list = rows.map(r => [r[xi], yi >= 0 ? num(r[yi]) : 1]);
    return { type: spec.type, fields: ['x', 'y'], rows: list, note: null, spec, marks: list.length };
  }
  const full = (b, card) => {
    const result = evaluate(b, selectOf(b, card.sql));
    return result;
  };
  const cardOf = (b, id) => b.cards.find(c => c.id === id);

  return {
    read(route, query = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-data/')) return undefined;
      let m;
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)$/))) {
        const b = bot(m[1]);
        if (!b) return refuse(404, 'bot not found');
        if (store().failRead) return refuse(500, 'The data panel could not answer.');
        return { sources: sources(b), cards: [...b.cards].sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.updated_at - x.updated_at) };
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/cards\/([^/]+)\/chart$/))) {
        const b = bot(m[1]); const card = b && cardOf(b, m[2]);
        if (!card) return refuse(404, 'That result is gone.');
        if (!card.spec) return refuse(404, 'That result has no chart.');
        try { const r = full(b, card); return compileChart(card.spec, r.columns, r.rows); } catch (error) { return error; }
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/tables\/([^/]+)\/stats$/))) {
        const b = bot(m[1]); const t = b?.tables[decodeURIComponent(m[2])];
        if (!t) return refuse(404, `There is no table called ${m[2]}.`);
        return { table: m[2], rows: t.rows.length, columns: t.columns.map((c, i) => ({ name: c, type: 'TEXT', non_null: t.rows.length, distinct: new Set(t.rows.map(r => r[i])).size, min: null, max: null, avg: null })) };
      }
      return undefined;
    },

    mutate(route, method, body = {}) {
      if (!state.botsLive || !store() || !route.startsWith('/api/bot-data/')) return undefined;
      const s = store();
      let m;
      if (s.failNext && !/\/cancel$/.test(route)) { const failure = s.failNext; s.failNext = null; return refuse(failure.status || 500, failure.detail || 'The data panel could not answer.'); }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/run$/)) && method === 'POST') {
        const b = bot(m[1]);
        if (!b) return refuse(404, 'bot not found');
        (s.runs ||= []).push({ botId: m[1], sql: body.sql, card_id: body.card_id || null, run_id: body.run_id || null });
        let result;
        try { result = evaluate(b, body.sql); } catch (error) { if (error?._status) return error; throw error; }
        const stamp = tick();
        let card;
        if (body.card_id) {
          card = cardOf(b, body.card_id);
          if (!card) return refuse(404, 'That result is gone.');
          Object.assign(card, { sql: body.sql, updated_at: stamp, ...(body.title !== undefined ? { title: body.title } : {}), ...(body.spec !== undefined ? { spec: body.spec } : {}) });
        } else {
          const title = result.created ? result.created.name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()) : (body.sql.replace(/\s+/g, ' ').slice(0, 60));
          card = { id: `c${++b.seq}`, title: body.title || title, sql: body.sql, spec: body.spec || null, pinned: false, created_at: stamp, updated_at: stamp };
          b.cards.push(card);
        }
        const rows = result.rows.slice(0, body.rows || ROWS_DEFAULT);
        const out = { run_id: body.run_id || `r${b.seq}`, columns: result.columns, rows, row_count: result.rows.length, truncated: result.rows.length > rows.length, created: result.created, card: { ...card } };
        if (card.spec) out.chart = compileChart(card.spec, result.columns, result.rows);
        return out;
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/cancel$/)) && method === 'POST') { (s.cancels ||= []).push(body.run_id); return { cancelled: false }; }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/page$/)) && method === 'POST') {
        const b = bot(m[1]); const card = b && cardOf(b, body.card_id);
        if (!card) return refuse(404, 'That result is gone.');
        let result;
        try { result = full(b, card); } catch (error) { if (error?._status) return error; throw error; }
        let rows = result.rows;
        for (const [column, text] of Object.entries(body.filter || {})) {
          const i = result.columns.indexOf(column);
          if (i < 0) return refuse(400, `There is no column called ${column}.`);
          rows = rows.filter(r => String(r[i] ?? '').toLowerCase().includes(String(text).toLowerCase()));
        }
        for (const item of body.sort || []) {
          const i = result.columns.indexOf(item.column);
          if (i < 0) return refuse(400, `There is no column called ${item.column}.`);
          rows = [...rows].sort((a, c) => (typeof a[i] === 'number' && typeof c[i] === 'number' ? a[i] - c[i] : String(a[i]).localeCompare(String(c[i]))) * (item.desc ? -1 : 1));
        }
        const limit = Math.min(body.limit || 100, PAGE_MAX), offset = body.offset || 0;
        (s.pages ||= []).push({ offset, limit, sort: body.sort || [], filter: body.filter || {} });
        return { columns: result.columns, rows: rows.slice(offset, offset + limit), row_count: rows.length, offset, limit, capped: false };
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/load$/)) && method === 'POST') {
        const b = bot(m[1]);
        if (!b) return refuse(404, 'bot not found');
        if (/\.\.|^[a-z]:|^\//i.test(body.source || '')) return refuse(400, 'That path is outside your own folder, so it cannot be loaded.', { hint: 'Put the file in your own folder first.' });
        const file = (s.files || {})[body.source];
        if (!file) return refuse(404, 'I could not find that file in your folder.');
        b.tables[file.table] = { columns: file.columns, rows: file.rows };
        return { loaded: [{ table: file.table, rows: file.rows.length, columns: file.columns }], sources: sources(b), cards: b.cards };
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/export$/)) && method === 'POST') {
        const b = bot(m[1]); const card = b && cardOf(b, body.card_id);
        if (!card) return refuse(404, 'That result is gone.');
        (s.exports ||= []).push({ card_id: body.card_id, format: body.format });
        return { ok: true };
      }
      if ((m = route.match(/^\/api\/bot-data\/([^/]+)\/cards\/([^/]+)$/))) {
        const b = bot(m[1]); const card = b && cardOf(b, m[2]);
        if (!card) return refuse(404, 'That result is gone.');
        if (method === 'DELETE') { b.cards = b.cards.filter(c => c.id !== card.id); return { ok: true }; }
        if (method === 'PATCH') {
          if (body.title !== undefined) card.title = body.title;
          if (body.pinned !== undefined) card.pinned = !!body.pinned;
          if (body.spec) card.spec = body.spec;
          if (body.clear_spec) card.spec = null;
          card.updated_at = tick();
          return { ...card };
        }
      }
      return undefined;
    },
  };
};
