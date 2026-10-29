// The data panel's rules (Phase 6 unit U2): plain-Node checks of static/js/botsDataModel.js, botsDataSql.js,
// botsDataChart.js and the pure parts of botsDataGrid.js. None of them needs a DOM for what is checked here.
// Run: node scripts/test_bots_data_model.cjs
//   - splitter clamp (query min 128, result min 180, 24 px keys), grid window and pages, sort cycle, filters
//   - how values show, TSV copy, the live-run rule (reads only), failure text, result kinds, default chart specs
//   - the SQL colour overlay is lossless and tokenizes strings, comments, numbers, keywords
//   - chart ticks, scales and the geometry of every chart type, and the colours are tokens, never hex
//   - the data context handed to the composer is bounded to 100 KB
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = path.join(__dirname, '..', 'static', 'js');
const load = file => import(pathToFileURL(path.join(dir, file)).href);
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

(async () => {
  const M = await load('botsDataModel.js');
  const S = await load('botsDataSql.js');
  const C = await load('botsDataChart.js');

  await check('the splitter keeps the query at 128 or more and the result at 180 or more', () => {
    assert.equal(M.clampSplit(50, 800), 128);
    assert.equal(M.clampSplit(900, 800), 620);
    assert.equal(M.clampSplit(300, 800), 300);
    assert.equal(M.clampSplit(undefined, 800), M.SPLIT.defaultQuery);
    assert.equal(M.clampSplit(NaN, 800), M.SPLIT.defaultQuery);
    // Too short for both minimums: split in their proportion rather than overlap.
    const tight = M.clampSplit(300, 200);
    assert.ok(tight > 0 && tight < 200);
    assert.equal(M.clampSplit(300, 0), 0);
  });

  await check('arrow keys move the separator 24 px and Home and End go to the limits', () => {
    assert.equal(M.splitKey(200, 'ArrowUp', 800), 224);
    assert.equal(M.splitKey(200, 'ArrowDown', 800), 176);
    assert.equal(M.splitKey(130, 'ArrowDown', 800), 128, 'it stops at the minimum');
    assert.equal(M.splitKey(610, 'ArrowUp', 800), 620, 'it stops where the result would drop under 180');
    assert.equal(M.splitKey(300, 'Home', 800), 128);
    assert.equal(M.splitKey(300, 'End', 800), 620);
    assert.equal(M.splitKey(300, 'a', 800), 300);
    assert.equal(M.SPLIT.step, 24);
  });

  await check('the grid draws only the rows near the viewport and asks for the pages they sit on', () => {
    assert.deepEqual(M.windowRange(0, 280, 0), { first: 0, last: -1 });
    const range = M.windowRange(0, 280, 1_000_000);
    assert.equal(range.first, 0);
    assert.equal(range.last, Math.ceil(280 / M.ROW_HEIGHT) + 6);
    const deep = M.windowRange(28 * 5000, 280, 1_000_000);
    assert.equal(deep.first, 5000 - 6);
    assert.deepEqual(M.pagesNeeded({ first: 95, last: 205 }), [0, 1, 2]);
    assert.deepEqual(M.pagesNeeded({ first: 100, last: 199 }), [1]);
    assert.deepEqual(M.pagesNeeded({ first: 0, last: -1 }), []);
    assert.equal(M.windowRange(10_000_000, 280, 50).last, 49, 'never past the last row');
  });

  await check('a header click sorts ascending, then descending, then clears; one column at a time', () => {
    let sort = [];
    sort = M.nextSort(sort, 'a'); assert.deepEqual(sort, [{ column: 'a', desc: false }]);
    sort = M.nextSort(sort, 'a'); assert.deepEqual(sort, [{ column: 'a', desc: true }]);
    sort = M.nextSort(sort, 'a'); assert.deepEqual(sort, []);
    sort = M.nextSort([{ column: 'a', desc: true }], 'b'); assert.deepEqual(sort, [{ column: 'b', desc: false }]);
    assert.equal(M.sortMark([{ column: 'a', desc: true }], 'a'), 'descending');
    assert.equal(M.sortMark([{ column: 'a', desc: false }], 'a'), 'ascending');
    assert.equal(M.sortMark([], 'a'), 'none');
    assert.deepEqual(M.cleanFilters({ a: ' x ', b: '', c: '   ', d: 5 }), { a: 'x', d: '5' });
  });

  await check('values show plainly, long text is cut, and rows copy as tab-separated text', () => {
    assert.equal(M.formatCell(null), '');
    assert.equal(M.formatCell(12), '12');
    assert.equal(M.formatCell(1.23456789), '1.234568');
    assert.equal(M.formatCell(true), 'true');
    assert.equal(M.formatCell('x'.repeat(500)).length, 403);
    assert.equal(M.rowCountLabel(1), '1 row');
    assert.equal(M.rowCountLabel(1234567), '1,234,567 rows');
    assert.equal(M.rowCountLabel(null, true), 'More rows');
    assert.equal(M.toTsv(['a', 'b'], [[1, 'x\ty'], [null, 'two\nlines']]), 'a\tb\n1\tx y\n\ttwo lines');
  });

  await check('only a read runs while the person types; making a table waits for Run', () => {
    for (const sql of ['select 1', '  SELECT * from t', 'WITH a AS (select 1) select * from a', 'values (1)', '-- note\nselect 1', '/* c */ select 1']) assert.equal(M.isLiveSafe(sql), true, sql);
    for (const sql of ['create table t as select 1', 'CREATE OR REPLACE TABLE t AS SELECT 1', 'drop table t', 'insert into t values (1)', '', '-- select\ndrop table t', 'pragma x']) assert.equal(M.isLiveSafe(sql), false, sql);
    assert.equal(M.RUN_DELAY_MS, 50);
  });

  await check('a failure keeps its message, line and hint, and drops the status prefix', () => {
    assert.deepEqual(M.failure({ message: '400: no such table: x', body: { detail: 'no such table: x', line: 3, hint: 'Tables you have: a' } }), { message: 'no such table: x', line: 3, hint: 'Tables you have: a' });
    assert.deepEqual(M.failure(new Error('500: boom')), { message: 'boom', line: null, hint: '' });
    assert.equal(M.failure(null).message, 'The query failed.');
  });

  await check('a result is a chart with a spec, text for one long cell, else a table', () => {
    assert.equal(M.resultKind(null, { running: true }), 'running');
    assert.equal(M.resultKind(null, { error: { message: 'x' } }), 'failed');
    assert.equal(M.resultKind({ spec: { type: 'bar' } }, { columns: ['a'], rows: [[1]] }), 'chart');
    assert.equal(M.resultKind({}, { columns: ['a'], rows: [['x'.repeat(200)]] }), 'text');
    assert.equal(M.resultKind({}, { columns: ['a'], rows: [['a\nb']] }), 'text');
    assert.equal(M.resultKind({}, { columns: ['a', 'b'], rows: [['x'.repeat(200), 1]] }), 'table');
    assert.equal(M.resultKind({}, { columns: ['a'], rows: [[1], [2]] }), 'table');
  });

  await check('history lists the newest first and the latest card opens by default', () => {
    const cards = [{ id: 'a', title: 'Old', updated_at: 1 }, { id: 'b', title: 'New', updated_at: 5, pinned: true }, { id: 'c', updated_at: 3 }];
    assert.equal(M.latestCard(cards).id, 'b');
    assert.equal(M.latestCard([]), null);
    assert.deepEqual(M.historyItems(cards, 'c').map(i => [i.id, i.label, i.current]), [['b', 'New', false], ['c', 'Result', true], ['a', 'Old', false]]);
  });

  await check('a starting chart spec picks a text column for x and a number column for y', () => {
    const rows = [['north', 10], ['south', 20]];
    assert.deepEqual(M.defaultSpec('bar', ['region', 'total'], rows), { type: 'bar', x: 'region', y: 'total', agg: 'sum' });
    assert.deepEqual(M.defaultSpec('bar', ['region'], [['a']]), { type: 'bar', x: 'region', y: undefined, agg: 'count' });
    assert.deepEqual(M.defaultSpec('histogram', ['n'], [[1]]), { type: 'histogram', x: 'n', bins: 20 });
    assert.equal(M.defaultSpec('bar', [], []), null);
  });

  await check('the data context for the composer is bounded and empty when nothing is shown', () => {
    assert.equal(M.currentDataContext('bot1'), null);
    M.setDataContext('bot1', { cardId: 'c1', draftSql: 'select 1' });
    assert.deepEqual(M.currentDataContext('bot1'), { cardId: 'c1', draftSql: 'select 1' });
    M.setDataContext('bot1', { cardId: '', draftSql: 'x'.repeat(100 * 1024 + 1) });
    assert.equal(M.currentDataContext('bot1'), null, 'a draft over 100 KB is not sent');
    M.setDataContext('bot1', { cardId: 'c2', draftSql: '' });
    assert.deepEqual(M.currentDataContext('bot1'), { cardId: 'c2' });
    M.setDataContext('bot1', null);
    assert.equal(M.currentDataContext('bot1'), null);
    assert.equal(M.currentDataContext('other'), null, 'one bot never sees another bot\'s panel');
  });

  await check('the api wrapper keeps the whole error body and returns blobs for exports', async () => {
    const seen = [];
    const fetcher = async (url, options) => {
      seen.push([url, options?.method || 'GET']);
      if (url.endsWith('/run')) return { ok: false, status: 400, statusText: 'Bad', json: async () => ({ detail: 'nope', line: 2, hint: 'try' }), headers: { get: () => 'application/json' } };
      if (url.endsWith('/export')) return { ok: true, status: 200, headers: { get: () => 'text/csv' }, blob: async () => 'BLOB' };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: 1 }) };
    };
    const api = M.dataApi('bot 1', fetcher);
    await assert.rejects(() => api.run({ sql: 'x' }), error => error.status === 400 && error.body.line === 2 && M.failure(error).hint === 'try');
    assert.equal(await api.exportFile('c1', 'csv'), 'BLOB');
    await api.overview(); await api.page({ card_id: 'c' }); await api.cancel('r1'); await api.patchCard('c1', {}); await api.deleteCard('c1'); await api.stats('t'); await api.histogram('t', 'a b', 5); await api.chart('c1'); await api.load({ source: 's' });
    assert.ok(seen.every(([url]) => url.startsWith('/api/bot-data/bot%201')), 'the bot id is encoded into the path');
    assert.ok(seen.some(([url, method]) => method === 'DELETE' && url.includes('/cards/c1')));
    assert.ok(seen.some(([url]) => url.includes('histogram?column=a%20b&bins=5')));
    assert.match(M.newRunId(), /^r[a-z0-9]{6,}$/);
  });

  await check('the SQL overlay is lossless and tokenizes strings, comments, numbers, keywords and functions', () => {
    const sql = "SELECT count(*), 'it''s;ok' AS s, 12.5e3\nFROM \"my table\" -- trailing\nWHERE a >= 3 /* c */ ORDER BY 1;";
    const tokens = S.tokenizeSql(sql);
    assert.equal(S.untokenize(tokens), sql, 'joined tokens are the exact text');
    const kinds = Object.fromEntries(tokens.filter(t => t.type !== 'space' && t.type !== 'punct').map(t => [t.text, t.type]));
    assert.equal(kinds.SELECT, 'keyword');
    assert.equal(kinds.count, 'function');
    assert.equal(kinds["'it''s;ok'"], 'string');
    assert.equal(kinds['"my table"'], 'ident');
    assert.equal(kinds['-- trailing'], 'comment');
    assert.equal(kinds['/* c */'], 'comment');
    assert.equal(kinds['12.5e3'], 'number');
    assert.equal(kinds.FROM, 'keyword');
    assert.equal(S.tokenizeSql('select \'unterminated').at(-1).type, 'string');
    assert.equal(S.untokenize(S.tokenizeSql("/* open")), '/* open');
    assert.equal(S.tokenizeSql('count').at(0).type, 'ident', 'a function name without a bracket is an ordinary name');
    assert.equal(S.untokenize(S.tokenizeSql('')), '');
  });

  await check('ticks are round and cover the data', () => {
    assert.deepEqual(C.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(C.niceTicks(0, 7, 4), [0, 2, 4, 6, 8]);
    const t = C.niceTicks(3, 97, 5);
    assert.ok(t[0] <= 3 && t.at(-1) >= 97);
    assert.ok(C.niceTicks(5, 5).length >= 2, 'a flat range still draws');
    assert.deepEqual(C.niceTicks(NaN, 1), [0, 1]);
    assert.equal(C.shortNumber(1500000), '1.5M');
    assert.equal(C.shortNumber(12500), '12.5k');
    assert.equal(C.shortNumber(0.123456), '0.12');
  });

  await check('a linear scale maps a domain onto a range and survives a flat domain', () => {
    const s = C.scaleLinear([0, 10], [100, 200]);
    assert.equal(s(0), 100); assert.equal(s(10), 200); assert.equal(s(5), 150);
    assert.equal(C.scaleLinear([3, 3], [0, 10])(3), 5);
    assert.equal(C.scaleLinear([0, 10], [200, 100])(10), 100, 'a reversed range flips');
  });

  const plot = C.plotBox(480, 280);
  await check('bars sit in their band, inside the plot, with heights that follow the values', () => {
    const chart = { type: 'bar', fields: ['x', 'y'], rows: [['a', 10], ['b', 30], ['c', 20]] };
    const layout = C.barLayout(chart, plot);
    assert.equal(layout.marks.length, 3);
    const [a, b, c] = layout.marks;
    assert.ok(b.h > c.h && c.h > a.h, 'taller value, taller bar');
    assert.ok(Math.abs(b.h / a.h - 3) < 0.01);
    for (const m of layout.marks) assert.ok(m.x >= plot.x && m.x + m.w <= plot.x + plot.w + 0.5 && m.y >= plot.y - 0.5 && m.y + m.h <= plot.y + plot.h + 0.5);
    assert.deepEqual(layout.xLabels.map(l => l.text), ['a', 'b', 'c']);
    assert.ok(layout.yTicks.length >= 3);
  });

  await check('grouped and stacked bars with a series', () => {
    const chart = { type: 'bar', fields: ['x', 'series', 'y'], rows: [['a', 's1', 10], ['a', 's2', 5], ['b', 's1', 3]] };
    const grouped = C.barLayout(chart, plot);
    const stacked = C.barLayout(chart, plot, { stack: true });
    assert.equal(grouped.names.length, 2);
    const a1 = grouped.marks.find(m => m.cat === 'a' && m.series === 's1'), a2 = grouped.marks.find(m => m.cat === 'a' && m.series === 's2');
    assert.ok(a2.x > a1.x, 'groups sit side by side');
    const sa1 = stacked.marks.find(m => m.cat === 'a' && m.series === 's1'), sa2 = stacked.marks.find(m => m.cat === 'a' && m.series === 's2');
    assert.equal(sa1.x, sa2.x, 'stacked bars share a column');
    assert.ok(Math.abs((sa2.y + sa2.h) - sa1.y) < 0.01, 'the second sits on top of the first');
    assert.notEqual(a1.color, a2.color);
  });

  await check('lines place numbers, dates and categories on a shared x axis', () => {
    const numbers = C.lineLayout({ type: 'line', fields: ['x', 'y'], rows: [[1, 5], [2, 9], [3, 7]] }, plot);
    assert.equal(numbers.kind, 'number');
    const pts = numbers.series[0].points;
    assert.ok(pts[0].x < pts[1].x && pts[1].x < pts[2].x);
    assert.ok(pts[1].y < pts[0].y, 'a higher value is higher up the screen');
    assert.ok(numbers.series[0].line.startsWith('M'));
    const dates = C.lineLayout({ type: 'line', fields: ['x', 'y'], rows: [['2026-01', 1], ['2026-02', 2], ['2026-04', 3]] }, plot);
    assert.equal(dates.kind, 'time');
    assert.ok(dates.series[0].points[2].x - dates.series[0].points[1].x > dates.series[0].points[1].x - dates.series[0].points[0].x, 'a two month gap is wider than a one month gap');
    const cats = C.lineLayout({ type: 'line', fields: ['x', 'y'], rows: [['a', 1], ['b', 2]] }, plot);
    assert.equal(cats.kind, 'category');
    const area = C.lineLayout({ type: 'area', fields: ['x', 'y'], rows: [[1, 5], [2, 9]] }, plot, { area: true });
    assert.ok(area.series[0].fill.endsWith('Z'));
    const two = C.lineLayout({ type: 'line', fields: ['x', 'series', 'y'], rows: [[1, 'a', 1], [2, 'a', 2], [1, 'b', 3], [2, 'b', 4]] }, plot);
    assert.equal(two.series.length, 2);
    assert.notEqual(two.series[0].color, two.series[1].color);
  });

  await check('scatter, histogram, pie and heatmap geometry', () => {
    const sc = C.scatterLayout({ type: 'scatter', fields: ['x', 'y'], rows: [[0, 0], [10, 10], ['x', 3], [5, null]] }, plot);
    assert.equal(sc.marks.length, 2, 'points without two numbers are skipped');
    assert.ok(sc.marks[1].x > sc.marks[0].x && sc.marks[1].y < sc.marks[0].y);
    const hist = C.histogramLayout({ type: 'histogram', fields: ['x0', 'x1', 'y'], rows: [[0, 5, 2], [5, 10, 8]] }, plot);
    assert.equal(hist.marks.length, 2);
    assert.ok(hist.marks[1].h > hist.marks[0].h);
    assert.ok(Math.abs(hist.marks[0].x + hist.marks[0].w + 1 - hist.marks[1].x) < 0.01, 'bins are adjacent');
    assert.deepEqual(C.histogramLayout({ type: 'histogram', fields: ['x0', 'x1', 'y'], rows: [] }, plot).marks, []);
    const pie = C.pieLayout({ type: 'pie', fields: ['x', 'y'], rows: [['a', 1], ['b', 3], ['z', 0]] }, 100, 100, 50);
    assert.equal(pie.length, 2, 'a zero slice is not drawn');
    assert.ok(Math.abs(pie[0].share - 0.25) < 1e-9 && Math.abs(pie[1].share - 0.75) < 1e-9);
    assert.ok(pie[0].d.startsWith('M100 100 L'));
    const whole = C.pieLayout({ type: 'pie', fields: ['x', 'y'], rows: [['only', 5]] }, 100, 100, 50);
    assert.ok(whole[0].d.includes('A50 50 0 1 1'), 'one slice is a full circle');
    const heat = C.heatmapLayout({ type: 'heatmap', fields: ['x', 'y', 'v'], rows: [['a', 'p', 1], ['b', 'p', 4], ['a', 'q', 2]] }, plot);
    assert.equal(heat.cells.length, 3);
    const max = heat.cells.find(c => c.raw.v === 4), min = heat.cells.find(c => c.raw.v === 1);
    assert.ok(max.opacity === 1 && min.opacity < max.opacity);
  });

  await check('chart colours are tokens, never a hex value', () => {
    assert.ok(C.SERIES_COLORS.length >= 6);
    for (const color of C.SERIES_COLORS) assert.match(color, /^var\(--[a-z0-9-]+\)$/);
    assert.equal(C.seriesColor(0), C.seriesColor(C.SERIES_COLORS.length), 'colours cycle');
    assert.equal(C.seriesColor(-1), C.SERIES_COLORS.at(-1));
    for (const file of ['botsDataChart.js', 'botsDataModel.js', 'botsDataGrid.js', 'botsDataSql.js', 'botsWorkbenchData.js', 'botsDataChip.js']) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source.replace(/#\{[^}]*\}/g, '')), `${file} has no hex colour`);
      assert.ok(!/\brgba?\(\s*\d/.test(source), `${file} has no rgb colour`);
      assert.ok(!source.includes('innerHTML'), `${file} never uses innerHTML`);
    }
    const css = fs.readFileSync(path.join(__dirname, '..', 'static', 'css', 'bots-data.css'), 'utf8');
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css) && !/rgba?\(\s*\d/.test(css), 'bots-data.css has no raw colour');
    assert.ok(!css.includes('—'), 'no em-dash');
  });

  console.log(`PASS: ${passed.length} data panel checks (${passed.join('; ')})`);
})().catch(error => { console.error(error); process.exit(1); });
