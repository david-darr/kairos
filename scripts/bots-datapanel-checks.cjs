// The Bots data panel, in the renderer (Phase 6 unit U2). Run by ui-smoke behind --bots-datapanel-only:
//   node scripts/run-electron-test.cjs ui-smoke --bots-datapanel-only
//
// Covers: the empty state and Load, a query that runs 50 ms after typing (the first run makes a card, later edits update it),
// the table with server paging, sort and a column filter, a failed query (message, line, hint), making a table waiting for Run,
// Cancel on a running query, a chart from a result with its SVG and PNG export and the CSV file, History and Pin, full screen
// with Escape, the splitter keys and its limits, the data context sent with chat, a data result inside a conversation (inline
// chart, Open result), a load error with Retry, and the same panel in a phone-sized window.
//
// It creates its own bot through the fixture API and seeds demoState.botsDatapanel itself (scripts/fixtures/bots-datapanel-backend.cjs),
// never assuming which other bots exist, and puts everything back in `finally`. The panel is mounted here from
// static/js/botsWorkbenchData.js, so the check does not depend on the workbench host another unit builds.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const text = selector => js(`(${q(selector)} || {}).textContent || ''`);
  const click = selector => js(`(() => { const n = ${q(selector)}; if (!n) throw new Error('no ${selector.replace(/'/g, '')}'); n.click(); return true; })()`);
  const clickText = (scope, label) => js(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim().includes(${JSON.stringify(label)})); if (!n) throw new Error('no ${label}'); n.click(); return true; })()`);
  const typeSql = value => js(`(() => { const n = ${q('.bots-data .bots-sql-input')}; n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const key = (selector, name) => js(`${q(selector)}.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`);
  const state = () => demoState.botsDatapanel;
  const mine = () => state().bots[botId];
  const waitText = async (selector, expected, label) => {
    for (let i = 0; i < 80; i++) { if ((await text(selector)).includes(expected)) return; await delay(50); }
    assert.ok((await text(selector)).includes(expected), `${label}: "${await text(selector)}" should include "${expected}"`);
  };
  const rowCount = () => js("document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)').length");
  const firstColumn = () => js("[...document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)')].slice(0, 5).map(r => r.children[0].textContent)");
  const original = win.getContentSize();
  const resize = size => { win.setContentSize(size[0], size[1]); return delay(450); };
  const toastsClear = () => js("[...document.querySelectorAll('#toast-host .toast')].map(n => { const t = n.textContent; n.remove(); return t; })");

  const restore = await isolateBotsCheck({ js, demoState });
  let botId = '';
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    const made = await call('/api/agents', 'POST', { name: `Datapanel ${Date.now() % 100000}` });
    assert.equal(made.status, 200, 'the fixture makes a bot');
    botId = made.body.id;
    const rows = Array.from({ length: 120 }, (_, i) => [['North', 'South', 'East', 'West'][i % 4], ((i * 7) % 90) + 5, `2026-0${(i % 9) + 1}-1${i % 9}`]);
    demoState.botsDatapanel = { bots: { [botId]: { tables: {}, cards: [], seq: 0 } },
      files: { 'sales.csv': { table: 'sales', columns: ['region', 'amount', 'order_date'], rows } }, runs: [], pages: [], cancels: [], exports: [], failNext: null, failRead: false };

    // The page's own fetch can be held (to see a query running) and an anchor click is recorded instead of saving a file.
    await js(`(() => {
      window.__realFetch = window.fetch; window.__hold = false; window.__downloads = []; window.__opened = [];
      window.fetch = (url, opts) => (window.__hold && String(url).includes('/run'))
        ? new Promise((resolve, reject) => { opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); })
        : window.__realFetch(url, opts);
      window.__blobs = {}; const realCreate = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { const u = realCreate(blob); window.__blobs[u] = blob; return u; };
      window.__realAnchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return window.__realAnchorClick.call(this);
        const entry = { name: this.download, href: this.href };
        window.__downloads.push(entry);
        (window.__blobs[this.href] ? window.__blobs[this.href].text() : Promise.resolve('')).then(t => { entry.text = t; }).catch(() => {});
      };
      document.addEventListener('kairos:bots-workbench-open', e => { window.__opened.push(e.detail); e.preventDefault(); });
    })()`);

    // Mount the panel in a Bots-styled wrapper.
    await js(`(async () => {
      const wrap = document.createElement('div');
      wrap.id = 'dp-wrap'; wrap.dataset.appMode = 'bots';
      wrap.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:min(560px, 100vw);z-index:900;';
      document.body.append(wrap);
      const m = await import('/static/js/botsWorkbenchData.js');
      window.__dp = await m.mount(wrap, { agentId: ${JSON.stringify(botId)}, threadId: '' });
    })()`);

    // -- empty, Load, a failed Load ----------------------------------------------------------------------------------------
    await waitFor("!!document.querySelector('.bots-data[data-state=ready]')");
    assert.match(await text('.bots-data-empty-title'), /No data yet/, 'a named empty state');
    assert.match(await text('.bots-data-empty-hint'), /load a file/i);
    assert.match(await text('.bots-data-sources'), /None loaded yet/);
    await js(`(() => { const n = ${q('.bots-data-load-input')}; n.value = 'missing.csv'; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await clickText('.bots-data-load button', 'Load');
    await waitFor("document.querySelectorAll('#toast-host .toast').length > 0");
    assert.match((await toastsClear()).join(' '), /could not find that file/, 'a missing file says so in plain words');
    await js(`(() => { const n = ${q('.bots-data-load-input')}; n.value = '../outside.csv'; })()`);
    await clickText('.bots-data-load button', 'Load');
    await waitFor("document.querySelectorAll('#toast-host .toast').length > 0");
    assert.match((await toastsClear()).join(' '), /outside your own folder/, 'a path outside the folder is refused');
    await js(`(() => { const n = ${q('.bots-data-load-input')}; n.value = 'sales.csv'; })()`);
    await clickText('.bots-data-load button', 'Load');
    await waitFor("!!document.querySelector('.bots-data-source')");
    assert.match(await text('.bots-data-source'), /sales/);
    assert.match(await text('.bots-data-source'), /120/, 'the strip shows the row count');
    await toastsClear();

    // -- the first run makes a card, later edits update it ---------------------------------------------------------------
    await typeSql('SELECT * FROM sales');
    await waitFor("document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)').length > 3");
    assert.equal(state().runs.length, 1, 'one run after typing');
    assert.equal(state().runs[0].card_id, null, 'the first run makes a card');
    assert.equal(mine().cards.length, 1);
    const cardId = mine().cards[0].id;
    await waitText('.bots-data-count', '120 rows', 'the row count shows');
    assert.equal(await js("document.querySelectorAll('.bots-grid-th').length"), 3, 'a header cell per column');
    assert.ok(await rowCount() < 40, 'only the rows near the viewport are drawn');
    await typeSql('SELECT region, amount FROM sales');
    for (let i = 0; i < 80 && state().runs.length < 2; i++) await delay(50);
    assert.equal(state().runs.length, 2, 'a second run after the edit');
    assert.equal(state().runs[1].card_id, cardId, 'the edit updates the same card');
    assert.equal(mine().cards.length, 1, 'still one card');
    assert.equal(mine().cards[0].sql, 'SELECT region, amount FROM sales');
    assert.match(await text('.bots-data-source-rows'), /120/);
    await typeSql('SELECT * FROM sales');
    await waitFor("document.querySelectorAll('.bots-grid-th').length === 3");
    for (let i = 0; i < 80 && state().runs.length < 3; i++) await delay(50);
    // One keystroke burst makes one run, not one per character.
    const before = state().runs.length;
    await js(`(() => { const n = ${q('.bots-data .bots-sql-input')}; for (const v of ['S', 'SE', 'SEL', 'SELE', 'SELEC', 'SELECT', 'SELECT *', 'SELECT * FROM sales LIMIT 90']) { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
    await delay(400);
    assert.equal(state().runs.length, before + 1, 'typing quickly runs once, 50 ms after the last key');
    assert.equal(state().runs.at(-1).sql, 'SELECT * FROM sales LIMIT 90');
    await typeSql('SELECT * FROM sales');
    for (let i = 0; i < 80 && state().runs.at(-1).sql !== 'SELECT * FROM sales'; i++) await delay(50);
    await waitText('.bots-data-count', '120 rows', 'back to all rows');
    await capture?.('desktop-bots-datapanel-table');

    // -- paging, sort and filter go to the server -------------------------------------------------------------------------
    await js(`(() => { const s = ${q('.bots-data .bots-grid-scroll')}; s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); })()`);
    for (let i = 0; i < 80 && !state().pages.some(p => p.offset >= 100); i++) await delay(50);
    assert.ok(state().pages.some(p => p.offset === 100 && p.limit === 100), 'scrolling down asks for the page that starts at row 100');
    await js(`${q('.bots-data .bots-grid-scroll')}.scrollTop = 0; ${q('.bots-data .bots-grid-scroll')}.dispatchEvent(new Event('scroll'))`);
    await clickText('.bots-grid-th', 'amount');
    for (let i = 0; i < 80 && !state().pages.some(p => p.sort.length); i++) await delay(50);
    assert.deepEqual(state().pages.filter(p => p.sort.length).at(-1).sort, [{ column: 'amount', desc: false }], 'a header click sorts ascending on the server');
    await waitFor("document.querySelector('.bots-grid-th[aria-sort=ascending]')");
    await waitFor("!!document.querySelector('.bots-data .bots-grid-row:not(.loading)')");
    const lowest = await js("document.querySelector('.bots-data .bots-grid-row:not(.loading)').children[1].textContent");
    assert.equal(lowest, '5', 'the smallest amount comes first');
    await clickText('.bots-grid-th', 'amount');
    await waitFor("document.querySelector('.bots-grid-th[aria-sort=descending]')");
    for (let i = 0; i < 40 && (await js("document.querySelector('.bots-data .bots-grid-row:not(.loading)')?.children[1].textContent")) === '5'; i++) await delay(50);
    await waitFor("!!document.querySelector('.bots-data .bots-grid-row:not(.loading)')");
    assert.notEqual(await js("document.querySelector('.bots-data .bots-grid-row:not(.loading)').children[1].textContent"), '5', 'descending reverses it');
    await clickText('.bots-grid-th', 'amount');
    await waitFor("!document.querySelector('.bots-grid-th[aria-sort=ascending]') && !document.querySelector('.bots-grid-th[aria-sort=descending]')");
    await js(`(() => { const n = document.querySelector('.bots-grid-filter[aria-label="Filter region"]'); n.value = 'north'; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    for (let i = 0; i < 80 && !state().pages.some(p => p.filter.region === 'north'); i++) await delay(50);
    assert.ok(state().pages.some(p => p.filter.region === 'north'), 'a column filter goes to the server');
    await waitFor("[...document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)')].length > 0 && [...document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)')].every(r => r.children[0].textContent === 'North')");
    await js(`(() => { const n = document.querySelector('.bots-grid-filter[aria-label="Filter region"]'); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor("[...document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)')].some(r => r.children[0].textContent === 'South')");

    // -- a failed query ---------------------------------------------------------------------------------------------------
    const cardsBefore = mine().cards.length;
    await typeSql('SELECT *\nFRM sales');
    await waitFor("!!document.querySelector('.bots-data-failed')");
    assert.match(await text('.bots-data-failed-msg'), /syntax error/, 'the message is the database\'s');
    assert.match(await text('.bots-data-failed-line'), /Line 2/, 'it names the line');
    assert.match(await text('.bots-data-failed-hint'), /commas, quotes and keywords/, 'and gives a hint');
    assert.equal(await js("document.querySelector('.bots-data-failed').getAttribute('role')"), 'alert');
    assert.equal(mine().cards.length, cardsBefore, 'a failed query saves no card');
    await typeSql('SELECT * FROM nosuch');
    await waitText('.bots-data-failed-msg', 'no such table: nosuch', 'a missing table');
    assert.match(await text('.bots-data-failed-hint'), /Tables you have: sales/);
    await capture?.('desktop-bots-datapanel-failed');

    // -- making a table waits for Run ---------------------------------------------------------------------------------------
    const runsBefore = state().runs.length;
    await typeSql('CREATE OR REPLACE TABLE big_north AS SELECT * FROM sales LIMIT 5');
    await delay(400);
    assert.equal(state().runs.length, runsBefore, 'a CREATE does not run while typing');
    assert.match(await text('.bots-data-status'), /Press Run to make this table/);
    await clickText('.bots-data-query-bar button', 'Run');
    for (let i = 0; i < 80 && state().runs.length === runsBefore; i++) await delay(50);
    assert.equal(state().runs.length, runsBefore + 1, 'Run makes it');
    await waitFor("[...document.querySelectorAll('.bots-data-source-name')].some(n => n.textContent === 'big_north')");
    await waitText('.bots-data-note', 'Made the table big_north', 'it says what it made');
    // Ctrl+Enter runs too.
    await typeSql('CREATE OR REPLACE TABLE big_north AS SELECT * FROM sales LIMIT 7');
    await js(`${q('.bots-data .bots-sql-input')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))`);
    for (let i = 0; i < 80 && state().runs.length < runsBefore + 2; i++) await delay(50);
    assert.equal(state().runs.length, runsBefore + 2, 'Ctrl+Enter runs');
    await waitFor("!document.querySelector('.bots-data-running')");
    await delay(500);   // let that run's own redraw finish before the next one starts

    // -- cancel ------------------------------------------------------------------------------------------------------------
    await js('window.__hold = true');
    const writesBefore = writes.length, cancelsBefore = state().cancels.length;
    await js(`(() => { window.__tl = []; const r = document.querySelector('.bots-data-result'); new MutationObserver(() => window.__tl.push((r.firstElementChild?.className || 'none') + ' ' + (r.textContent || '').slice(0, 60))).observe(r, { childList: true }); })()`);
    await typeSql('SELECT * FROM sales LIMIT 3');
    await waitFor("!!document.querySelector('.bots-data-running')");
    assert.match(await text('.bots-data-running'), /Running/, 'running shows: ' + await js("document.querySelector('.bots-data-result').innerText + ' | hold=' + window.__hold + ' | runs=' + document.querySelectorAll('.bots-data-running').length"));
    await clickText('.bots-data-running button', 'Cancel');
    try { await waitFor("!!document.querySelector('.bots-data-failed')"); } catch (e) { throw new Error('now: ' + await js("document.querySelector('.bots-data-result').innerHTML.slice(0, 400)") + ' timeline: ' + JSON.stringify(await js('window.__tl')) + ' runs=' + JSON.stringify(state().runs.slice(-3))); }
    assert.match(await text('.bots-data-failed-msg'), /You stopped this query/, 'Cancel says so');
    for (let i = 0; i < 40 && state().cancels.length === cancelsBefore; i++) await delay(50);
    assert.equal(state().cancels.length, cancelsBefore + 1, 'Cancel asks the server to stop the run');
    assert.ok(writes.slice(writesBefore).some(w => w.path === `/api/bot-data/${botId}/cancel` && w.method === 'POST'));
    await js('window.__hold = false');

    // -- a chart, with exports -------------------------------------------------------------------------------------------
    await typeSql('SELECT region, SUM(amount) AS total FROM sales GROUP BY 1');
    await waitFor("document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)').length === 4");
    await js(`(() => { const s = ${q('.bots-data-builder select[aria-label="Chart type"]')}; s.value = 'bar'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor("!!document.querySelector('.bots-data .bots-chart')");
    assert.equal(await js("document.querySelectorAll('.bots-data .bots-chart rect[rx]').length"), 4, 'one bar per region');
    assert.equal(await js("document.querySelectorAll('.bots-data .bots-chart rect[rx] > title').length"), 4, 'each bar has a plain tooltip');
    assert.equal(await js("document.querySelector('.bots-data .bots-chart').getAttribute('role')"), 'img');
    const paints = await js("[...document.querySelectorAll('.bots-data .bots-chart [fill], .bots-data .bots-chart [stroke]')].flatMap(n => [n.getAttribute('fill'), n.getAttribute('stroke')]).filter(v => v && v !== 'none')");
    assert.ok(paints.length > 4 && paints.every(v => /^var\(--[a-z0-9-]+\)$/.test(v)), `every colour is a token: ${[...new Set(paints)].join(', ')}`);
    assert.equal(mine().cards.find(c => c.sql.includes('GROUP BY')).spec.type, 'bar', 'the spec is saved with the card, not the rows');
    assert.ok(!JSON.stringify(mine().cards).includes('"North"'), 'a card never holds rows');
    await capture?.('desktop-bots-datapanel-chart');
    // The Table view of the same result.
    await clickText('.bots-data-tab', 'Table');
    await waitFor("!document.querySelector('.bots-data .bots-chart') && document.querySelectorAll('.bots-data .bots-grid-row:not(.loading)').length === 4");
    await clickText('.bots-data-tab', 'Chart');
    await waitFor("!!document.querySelector('.bots-data .bots-chart')");
    // Other types draw too.
    for (const type of ['line', 'area', 'pie']) {
      await js(`(() => { const s = ${q('.bots-data-builder select[aria-label="Chart type"]')}; s.value = ${JSON.stringify(type)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor("!!document.querySelector('.bots-data .bots-chart')");
      for (let i = 0; i < 80 && mine().cards.find(c => c.sql.includes('GROUP BY')).spec?.type !== type; i++) await delay(50);
      assert.equal(mine().cards.find(c => c.sql.includes('GROUP BY')).spec.type, type, `${type} is saved`);
      await delay(150);
      assert.ok(await js("document.querySelector('.bots-data .bots-chart').children.length > 3"), `${type} draws marks`);
    }
    await js(`(() => { const s = ${q('.bots-data-builder select[aria-label="Chart type"]')}; s.value = 'bar'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    for (let i = 0; i < 80 && mine().cards.find(c => c.sql.includes('GROUP BY')).spec?.type !== 'bar'; i++) await delay(50);
    await waitFor("!!document.querySelector('.bots-data .bots-chart rect[rx]')");

    await waitFor("!document.querySelector('.bots-menu')");
    await clickText('.bots-data-bar button', 'Export');
    await waitFor("!!document.querySelector('.bots-menu')");
    const items = await js("[...document.querySelectorAll('.bots-menu .bots-menu-row')].map(n => n.textContent.trim())");
    assert.deepEqual(items, ['CSV file', 'Excel file', 'Chart as PNG', 'Chart as SVG', 'Copy rows as text']);
    await clickText('.bots-menu .bots-menu-row', 'Chart as SVG');
    for (let i = 0; i < 60 && !(await js("window.__downloads.some(d => d.name.endsWith('.svg') && d.text)")); i++) await delay(50);
    const svg = await js("window.__downloads.find(d => d.name.endsWith('.svg'))");
    assert.ok(svg && /^[A-Za-z0-9_-]+\.svg$/.test(svg.name), 'an SVG file is saved with a plain name');
    assert.ok(svg.text.startsWith('<svg') && svg.text.includes('xmlns='), 'it is a real SVG');
    assert.ok(!svg.text.includes('var('), 'the saved picture has live colours, not tokens');
    await waitFor("!document.querySelector('.bots-menu')");
    await clickText('.bots-data-bar button', 'Export');
    await waitFor("!!document.querySelector('.bots-menu')");
    await clickText('.bots-menu .bots-menu-row', 'Chart as PNG');
    for (let i = 0; i < 80 && !(await js("window.__downloads.some(d => d.name.endsWith('.png'))")); i++) await delay(50);
    assert.ok(await js("window.__downloads.some(d => d.name.endsWith('.png'))"), 'a PNG file is saved');
    await waitFor("!document.querySelector('.bots-menu')");
    await clickText('.bots-data-bar button', 'Export');
    await waitFor("!!document.querySelector('.bots-menu')");
    await clickText('.bots-menu .bots-menu-row', 'CSV file');
    for (let i = 0; i < 60 && !state().exports.length; i++) await delay(50);
    assert.deepEqual(state().exports.map(e => e.format), ['csv'], 'CSV is made by the server');
    assert.ok(await js("window.__downloads.some(d => d.name.endsWith('.csv'))"), 'and saved as a file');

    // -- History and Pin -----------------------------------------------------------------------------------------------------
    try { await waitFor("!document.querySelector('.bots-menu')"); } catch (e) { throw new Error('menu left: ' + await js("[...document.querySelectorAll('.bots-menu')].map(m => m.dataset.closing + ':' + m.textContent.slice(0, 80)).join(' | ')")); }
    const total = mine().cards.length;
    await waitFor("!document.querySelector('.bots-menu')");
    await clickText('.bots-data-bar button', 'History');
    await waitFor("!!document.querySelector('.bots-menu')");
    assert.equal(await js("document.querySelectorAll('.bots-menu .bots-menu-row').length"), total, 'every saved result is listed');
    assert.equal(await js("document.querySelectorAll('.bots-menu .bots-menu-row[aria-checked=true]').length"), 1, 'the open one is marked');
    const target = mine().cards.find(c => c.id === cardId);
    await clickText('.bots-menu .bots-menu-row', target.title);
    await waitFor(`${q('.bots-data .bots-sql-input')}.value === ${JSON.stringify(target.sql)}`);
    await waitFor("!!document.querySelector('.bots-data .bots-chart, .bots-data .bots-grid-row:not(.loading)')");
    await click('.bots-data-bar [aria-label="Pin this result"]');
    for (let i = 0; i < 40 && !mine().cards.find(c => c.id === cardId).pinned; i++) await delay(50);
    assert.equal(mine().cards.find(c => c.id === cardId).pinned, true, 'Pin is saved');
    assert.equal(await js("document.querySelector('.bots-data-bar [aria-label=\"Unpin this result\"]').getAttribute('aria-pressed')"), 'true');

    // -- the data context sent with chat ---------------------------------------------------------------------------------------
    let context = await js(`import('/static/js/botsDataModel.js').then(m => m.currentDataContext(${JSON.stringify(botId)}))`);
    assert.deepEqual(context, { cardId }, 'the open result travels with the next message');
    await typeSql('SELECT * FROM sales LIMIT 11');
    await delay(10);
    context = await js(`import('/static/js/botsDataModel.js').then(m => m.currentDataContext(${JSON.stringify(botId)}))`);
    assert.equal(context.cardId, cardId);
    assert.equal(context.draftSql, 'SELECT * FROM sales LIMIT 11', 'an unsaved draft travels too');
    assert.equal(await js(`import('/static/js/botsDataModel.js').then(m => m.currentDataContext('another-bot'))`), null, 'never another bot\'s');

    // -- full screen, the splitter ---------------------------------------------------------------------------------------------
    await click('.bots-data-bar [aria-label="Full screen"]');
    await waitFor("document.querySelector('.bots-data').classList.contains('is-fullscreen')");
    const full = await js("(() => { const r = document.querySelector('.bots-data').getBoundingClientRect(); return [Math.round(r.width) === innerWidth, Math.round(r.height) === innerHeight]; })()");
    assert.deepEqual(full, [true, true], 'full screen fills the window');
    await waitFor("!document.querySelector('.bots-menu')");
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    await waitFor("!document.querySelector('.bots-data').classList.contains('is-fullscreen')");
    const sep = '.bots-data-split';
    assert.equal(await js(`${q(sep)}.getAttribute('role')`), 'separator');
    const start = Number(await js(`${q(sep)}.getAttribute('aria-valuenow')`));
    await key(sep, 'ArrowUp');
    assert.equal(Number(await js(`${q(sep)}.getAttribute('aria-valuenow')`)), start + 24, 'an arrow key moves it 24 px');
    await key(sep, 'ArrowDown');
    assert.equal(Number(await js(`${q(sep)}.getAttribute('aria-valuenow')`)), start, 'and back');
    await key(sep, 'ArrowDown');
    assert.ok(Number(await js(`${q(sep)}.getAttribute('aria-valuenow')`)) >= 128, 'never below the minimum');
    await key(sep, 'Home');
    assert.equal(Number(await js(`${q(sep)}.getAttribute('aria-valuenow')`)), 128, 'the query keeps at least 128 px');
    await key(sep, 'End');
    const resultHeight = await js("Math.round(document.querySelector('.bots-data-result').getBoundingClientRect().height)");
    assert.ok(resultHeight >= 178, `the result keeps at least 180 px (${resultHeight})`);
    assert.equal(await js("localStorage.getItem('kairos:bots-data-split') !== null"), true, 'the split is remembered');
    await key(sep, 'Home');

    // -- a data result inside the conversation ------------------------------------------------------------------------------------
    const chartCard = mine().cards.find(c => c.spec);
    await js(`(async () => {
      const m = await import('/static/js/botsRichRows.js');
      const holder = document.createElement('div'); holder.id = 'rich-holder'; holder.dataset.appMode = 'bots';
      holder.style.cssText = 'position:fixed;left:0;top:0;width:520px;z-index:901;background:var(--bg);padding:8px';
      document.body.append(holder);
      holder.append(m.renderRichRow({ id: 'm-data', kind: 'data_result', data_result: { card_id: ${JSON.stringify(chartCard.id)}, title: 'By region', rows: 4, chart: true, columns: ['region', 'total'] } }, { agentId: ${JSON.stringify(botId)}, sessionId: 's1' }));
    })()`);
    await waitFor("!!document.querySelector('#rich-holder .bots-data-inline svg.bots-chart')");
    assert.equal(await js("Math.round(document.querySelector('#rich-holder svg.bots-chart').getBoundingClientRect().height) <= 290"), true, 'the inline chart is about 280 px tall');
    assert.match(await text('#rich-holder .bots-data-inline-count'), /4 rows/);
    await clickText('#rich-holder button', 'Open result');
    await waitFor("window.__opened.length === 1");
    assert.deepEqual(await js("window.__opened[0]"), { agentId: botId, tab: 'data', threadId: 's1', cardId: chartCard.id }, 'Open result asks for the Data tab on that result');
    await js("document.getElementById('rich-holder').remove()");

    // -- a load error with Retry --------------------------------------------------------------------------------------------------
    state().failRead = true;
    await js('window.__dp.refresh()');
    await waitFor("!!document.querySelector('.bots-data[data-state=error] .bots-data-failed')");
    assert.match(await text('.bots-data-failed-msg'), /could not load/);
    state().failRead = false;
    await clickText('.bots-data-failed button', 'Try again');
    await waitFor("!!document.querySelector('.bots-data[data-state=ready]')");
    assert.deepEqual(await toastsClear(), [], 'no error toast from the failed load');

    // -- the same panel on a phone -------------------------------------------------------------------------------------------------
    await resize([390, 844]);
    await delay(300);
    const phone = await js(`(() => { const w = ${q('#dp-wrap')}.getBoundingClientRect(), d = ${q('.bots-data')}; return { wrap: Math.round(w.width), vw: innerWidth, overflow: d.scrollWidth > d.clientWidth + 1, queryHeight: Math.round(${q('.bots-data-query')}.getBoundingClientRect().height) }; })()`);
    assert.ok(phone.wrap <= phone.vw, 'the panel fits the screen');
    assert.equal(phone.overflow, false, 'no sideways scroll');
    assert.ok(phone.queryHeight >= 120, 'the editor stays usable');
    await capture?.('phone-bots-datapanel');
    await resize(original);

    // -- closing leaves nothing behind ----------------------------------------------------------------------------------------------
    await js('window.__dp.destroy()');
    assert.equal(await js("!document.querySelector('.bots-data')"), true, 'the panel is gone');
    assert.equal(await js(`import('/static/js/botsDataModel.js').then(m => m.currentDataContext(${JSON.stringify(botId)}))`), null, 'and it no longer speaks for the chat');
    assert.deepEqual(await toastsClear(), [], 'no error toast');
  } finally {
    try { await js('window.__dp && window.__dp.destroy()'); } catch { /* the page may be gone */ }
    try {
      await js(`(() => {
        if (window.__realFetch) window.fetch = window.__realFetch;
        if (window.__realAnchorClick) HTMLAnchorElement.prototype.click = window.__realAnchorClick;
        document.getElementById('dp-wrap')?.remove(); document.getElementById('rich-holder')?.remove();
        try { localStorage.removeItem('kairos:bots-data-split'); } catch (e) {}
      })()`);
    } catch { /* the page may be gone */ }
    try { win.setContentSize(original[0], original[1]); await delay(250); } catch { /* window closed */ }
    if (botId) { try { await call(`/api/agents/${botId}`, 'DELETE'); } catch { /* already removed */ } }
    delete demoState.botsDatapanel;
    await restore();
  }
};
