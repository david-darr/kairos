// Isolated Electron smoke for the desktop usage notch. No real backend, CLI or
// account call: the page is served from a local stub with synthetic readings,
// and the main-process side of its bridge is stubbed here to record what the
// page asks for. Run: node scripts/run-electron-test.cjs usage-overlay-smoke
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { trackOverlay } = require('../electron/usage-overlay-tracking');
const placement = require('../electron/usage-overlay-placement');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'data', 'usage-overlay-smoke-profile'));
const output = path.join(root, 'data', 'usage-overlay-review');
const now = Date.now() / 1000;
let claudeStatus = 'ok';
let liveRuns = {};
// Four agents, as on the v2 boards, so the notch's dots, chips and rail have something to show.
let agents = [];
const BOARD_AGENTS = [['scout', 'Scout', '#B9D2E3'], ['quill', 'Quill', '#E9C9A8'], ['atlas', 'Atlas', '#B8C9A6'], ['sol', 'Sol', '#D9B260']]
  .map(([id, name, color]) => ({ id, name, color, status: 'idle' }));
const refreshes = [];
function quota() {
  const claude = claudeStatus === 'needs_sign_in'
    ? { provider: 'claude', status: 'needs_sign_in', stale: true, windows: [], note: 'Sign-in has expired or is missing. Open the CLI once to renew it.' }
    : { provider: 'claude', status: 'ok', stale: false, note: '', updated_at: now, windows: [
      { name: '5-hour', used_percent: 24, resets_at: now + 3600 * 2 },
      { name: 'Weekly', used_percent: 61, resets_at: now + 86400 * 3 },
    ] };
  const codex = { provider: 'codex', status: 'ok', stale: false, note: '', updated_at: now, windows: [
    { name: '5-hour', used_percent: 86, resets_at: now + 1500 },
    { name: 'Weekly', used_percent: 12, resets_at: now + 86400 * 5 },
  ] };
  const none = { today_tokens: 0, week_tokens: 0, total_tokens: 0 };
  // Every connected model, as core/quota_usage.py lists them: subscriptions, then local, then API.
  const models = [
    { id: 'c1', name: 'Claude', kind: 'claude_cli', model: '', mark: 'claude', provider: 'claude', status: claudeStatus === 'ok' ? 'connected' : claudeStatus, quota: claude, recorded: none },
    { id: 'x1', name: 'Codex', kind: 'codex_cli', model: '', mark: 'openai', provider: 'codex', status: 'connected', quota: codex, recorded: none },
    { id: 'g1', name: 'Antigravity', kind: 'antigravity_cli', model: '', mark: 'gemini', provider: 'antigravity', status: 'connected',
      quota: { provider: 'antigravity', status: 'no_quota', stale: false, note: 'This CLI does not report usage limits.', windows: [], updated_at: now },
      recorded: { today_tokens: 2100, week_tokens: 8400, total_tokens: 8400 } },
    { id: 'l1', name: 'qwen3', kind: 'local', model: 'qwen3:8b', mark: 'qwen', provider: null, status: 'connected', quota: null,
      recorded: { today_tokens: 12000, week_tokens: 30000, total_tokens: 90000 } },
    { id: 'a1', name: 'Grok', kind: 'api', model: 'grok-4', mark: 'grok', provider: null, status: 'connected', quota: null, recorded: none },
  ];
  return { providers: [claude, codex], models };
}
const files = {
  '/usage-overlay': ['static/usage-overlay.html', 'text/html'],
  '/static/css/usage-overlay.css': ['static/css/usage-overlay.css', 'text/css'],
  '/static/js/usage-overlay.js': ['static/js/usage-overlay.js', 'text/javascript'],
  '/static/js/quotaReadings.js': ['static/js/quotaReadings.js', 'text/javascript'],
};
for (const name of ['notchShell', 'notchIcons', 'notchModelMarks', 'notchQuiet', 'notchSide', 'kipStyle', 'activityModel', 'chatStream', 'mascot', 'agentAvatar', 'dither', 'kip']) files[`/static/js/${name}.js`] = [`static/js/${name}.js`, 'text/javascript'];
for (const name of ['kairos-theme', 'mascot']) files[`/static/css/${name}.css`] = [`static/css/${name}.css`, 'text/css'];
const server = http.createServer((req, res) => {
  if (req.url === '/api/models/quotas' || req.url === '/api/models/quotas/refresh') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', c => { body += c; });
      req.on('end', () => { refreshes.push(JSON.parse(body).provider); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(quota())); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quota()));
    return;
  }
  if (req.url === '/api/chat/live/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"snapshot","runs":{}}\n\n'); return; }
  if (req.url === '/api/chat/live/snapshot') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ runs: liveRuns })); return;
  }
  // What the quiet view reads: chats, notes and the calendar, as the app's own endpoints answer them.
  const sessionList = [{ id: 'a1b2c3d4e5f6', title: 'Q4 planning', updated_at: now - 720, message_count: 6 }, { id: 'b1b2c3d4e5f6', title: 'Trip notes', updated_at: now - 86400 * 3, message_count: 2 }];
  if (req.url === '/api/sessions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sessionList)); return; }
  if (req.url === '/api/sessions/a1b2c3d4e5f6') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...sessionList[0], messages: [{ role: 'user', content: 'Plan Q4' }, { role: 'assistant', content: 'Here are three roadmap themes to compare, with the tradeoffs of each.' }] })); return;
  }
  if (req.url.startsWith('/api/notes')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ id: 'n1', text: 'Send invoice', completed: false, due_date: new Date().toISOString().slice(0, 10) + 'T09:00:00' }, { id: 'n2', text: 'Call the bank', completed: false, due_date: '2020-01-01T09:00:00' }])); return; }
  if (req.url.startsWith('/api/calendar/events')) {
    const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'e1', title: 'Design review', start: at(40), end: at(85), source: 'google', calendar_name: 'Google', completed: false }])); return;
  }
  if (req.url === '/api/auth/status' || req.url === '/api/agents' || req.url === '/api/agents/inbox' || req.url === '/api/triggers' || req.url === '/api/notifications') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/agents' ? agents : { runs: {}, username: 'David' })); return;
  }
  const markMatch = /^\/static\/img\/model-marks\/([a-z0-9-]+\.svg)$/.exec(req.url);
  if (markMatch) {
    servedMarks.push(markMatch[1]);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(path.join(root, 'static/img/model-marks', markMatch[1])));
    return;
  }
  const file = files[req.url];
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file[1] });
  res.end(fs.readFileSync(path.join(root, file[0])));
});
const servedMarks = [];
const interactive = [];
ipcMain.on('usage-overlay:interactive', (event, on) => {
  interactive.push(on);
  if (nativeWin && event.sender === nativeWin.webContents) nativeWin.setIgnoreMouseEvents(!on, { forward: true });
});
const opened = [];
ipcMain.on('usage-overlay:open-app', (event, target, detail) => { opened.push([target, detail]); });
ipcMain.handle('usage-overlay:config', () => ({ edge: 'top-centre', foldOnHover: false, offset: 0.5 }));
let win;
let nativeWin;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function run() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(output, { recursive: true });
  // Shown, but placed off every screen: the pill's clip-path transition runs on the
  // compositor, which a hidden window never advances, so a hidden window's capture
  // showed the pill frozen half-unfolded while the page itself was correct.
  win = new BrowserWindow({ x: -5000, y: -5000, width: 860, height: 640, show: true, skipTaskbar: true, focusable: false,
    backgroundColor: '#3a4a5c', // a dark stand-in for the desktop, so the black notch is visible in screenshots
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(root, 'electron/usage-overlay-preload.js') } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/usage-overlay`);
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async (cond) => { for (let i = 0; i < 60; i++) { if (await js(cond)) return; await delay(50); } throw new Error('Timed out: ' + cond); };
  const move = (x, y) => js(`document.dispatchEvent(new MouseEvent('mousemove',{clientX:${x},clientY:${y},bubbles:true}))`);

  await waitFor("document.body.dataset.edge === 'top-centre' && document.querySelectorAll('#notch-usage .n-reading').length === 2");
  await delay(600);  // capturing before the first frame has painted fails with UnknownVizError

  // Phase-1 shell: collapsed and expanded geometry at renderer scale factors.
  for (const zoom of [1, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom); win.setContentSize(Math.round(860 * zoom), Math.round(640 * zoom));
    win.webContents.send('usage-overlay:config', { edge: 'top-centre', foldOnHover: false });
    await waitFor("document.body.dataset.edge === 'top-centre'");
    await move(-1, -1); await delay(550);
    const size = () => js("(r => [Math.round(r.width), Math.round(r.height), Math.round(r.top), Math.round(r.left + r.width / 2)])(document.getElementById('notch-shell').getBoundingClientRect())");
    // Collapsed (NotchCollapsed): 40 DIP tall, as wide as its contents, centred and flush with the top.
    // The two rings and "+3" for the models without one.
    assert.equal(await js("document.querySelector('#notch-usage .n-models')?.textContent"), '+3');
    const collapsed = async () => { const [w, h, t, c] = await size(); assert.ok(h === 40 && t === 0 && w >= 120 && w <= 480 && Math.abs(c - await js('innerWidth / 2')) <= 1, 'collapsed ' + JSON.stringify([w, h, t, c, await js('[innerWidth, document.getElementById("notch-usage").outerHTML.slice(0,300), document.getElementById("notch-shell").dataset.state, document.getElementById("pill").dataset.cells]')])); };
    await collapsed();
    fs.writeFileSync(path.join(output, `notch-collapsed-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
    await move(430, 15); await delay(450);
    await waitFor("document.getElementById('notch-shell').getAnimations().length === 0");
    // Expanded (NotchQuiet with nothing running): 820 DIP wide; the status row and the cards set the height.
    fs.writeFileSync(path.join(output, `notch-expanded-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
    { const [w, h, t, c] = await size(); assert.ok(w === 820 && h >= 200 && h <= 380 && t === 0 && Math.abs(c - await js('innerWidth / 2')) <= 1, 'expanded ' + JSON.stringify([w, h, t, c, await js('innerWidth')])); }
    // Every connected model is in the status row as its logo and reading, no names: three readings and "+2", all inside the notch.
    assert.deepEqual(await js("[...document.querySelectorAll('#notch-readings .n-word')].map(n => n.textContent)"),
      ['5h 24%', '5h 86%', '2.1K today', '+2'], 'status row lists every model by logo');
    assert.deepEqual(await js("[...document.querySelectorAll('#notch-readings .n-word')].slice(0, 3).map(n => n.title)"), ['Claude', 'Codex', 'Antigravity'], 'the name is the tooltip');
    assert.equal(await js("document.querySelectorAll('#notch-readings .n-word > svg').length"), 3, 'the three subscription logos are inline SVG');
    assert.equal(await js("document.querySelector('#notch-readings .n-word > svg').getAttribute('fill')"), 'currentColor');
    assert.ok(await js("(s => [...document.querySelectorAll('#notch-readings .n-word')].every(n => { const r = n.getBoundingClientRect(); return r.width > 0 && r.left >= s.left && r.right <= s.right; }))(document.getElementById('notch-shell').getBoundingClientRect())"), 'readings stay inside the notch');
    if (zoom === 1) {
      const at = async selector => js(`(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector('${selector}').getBoundingClientRect())`);
      const agy = await at('#notch-readings [data-p=antigravity]');
      await move(agy[0], agy[1]);
      await waitFor("document.getElementById('card').classList.contains('show') && /Antigravity Usage/.test(document.getElementById('card').innerText)");
      assert.match(await js("document.getElementById('card').innerText"), /This week\s+8\.4K tokens/);
      await delay(250); fs.writeFileSync(path.join(output, 'notch-card-antigravity.png'), (await win.webContents.capturePage()).toPNG());
      const more = await at('#notch-readings [data-p=all]');
      await move(more[0], more[1]);
      await waitFor("/^Models/.test(document.getElementById('card').innerText)");
      const all = await js("document.getElementById('card').innerText");
      for (const line of [/Claude\s+5h 24%/, /Codex\s+5h 86%/, /Antigravity\s+2\.1K tokens today/, /qwen3\s+12K tokens today/, /Grok\s+no usage yet/]) assert.match(all, line);
      assert.ok(servedMarks.includes('qwen.svg') && servedMarks.includes('grok.svg'), 'models with other marks draw their files');
      assert.ok(await js("(r => r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight)(document.getElementById('card').getBoundingClientRect())"), 'the card stays within the window');
      await delay(250); fs.writeFileSync(path.join(output, 'notch-card-all-models.png'), (await win.webContents.capturePage()).toPNG());
      await move(430, 15);
    }
    await move(-1, -1); await delay(550);
    assert.equal(interactive.at(-1), false, 'outside notch is click-through');
    await collapsed();
  }
  win.webContents.setZoomFactor(1);

  // Feed the real activity model through the stub snapshot, with no backend work.
  win.setContentSize(860, 640);
  const shot = async name => { await delay(400); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const both = async name => { await move(-1, -1); await delay(450); await shot(`${name}-collapsed.png`); await move(430, 15); await delay(450); await shot(`${name}-expanded-light.png`);
    // A dark Appearance theme: the boards themselves.
    await js("document.body.classList.remove('notch-light')"); await shot(`${name}-expanded-dark.png`); await js("document.body.classList.add('notch-light')"); };
  // Resting with the board's four agents, none at work: the quiet view (NotchQuiet) and four resting agents.
  agents = BOARD_AGENTS.map(agent => ({ ...agent }));
  await delay(15500); // the notch's agent poll
  await both('notch-resting');
  await move(430, 15); await delay(450);
  assert.equal(await js("document.getElementById('notch-panel').dataset.layout"), 'quiet', 'nothing at work shows the quiet view');
  const quietText = await js("document.querySelector('.nq-view').innerText");
  for (const line of [/all quiet/i, /Good (morning|afternoon|evening), David/, /up next · in \d+ min/i, /Design review/, /Prep with Kairos/, /pick up where you left off/i,
    /Q4 planning/, /Here are three roadmap themes/, /Continue/, /1\s+chats today/, /2\s+notes due/, /4\s+agents/, /24%/, /86%/, /New chat/, /Drop files/]) assert.match(quietText, line);
  assert.ok(await js("[...document.querySelectorAll('.nq-view')].every(v => (r => r.left >= 0 && r.right <= innerWidth)(v.getBoundingClientRect()))"), 'the quiet view fits the window');
  assert.equal(await js("document.querySelectorAll('.nq-usage-row').length"), 2, 'a usage row for each quota');
  assert.equal(await js("document.querySelectorAll('.nq-usage-row')[0].querySelectorAll('.nq-dots i.on').length"), 6, '24% fills 6 of 24 dots');
  // Every quick action reaches the app, with Prep and Continue carrying their chat.
  for (const label of ['New chat', 'Note', 'Talk', 'Drop files']) await js(`document.querySelector('.nq-view .nq-qa[aria-label="${label}"]').click()`);
  await js("document.querySelector('.nq-view .nq-pill:not(.nq-primary)').click()");
  await js("document.querySelector('.nq-view .nq-primary').click()");
  for (let i = 0; i < 40 && opened.length < 6; i++) await delay(50);
  assert.deepEqual(opened.slice(0, 4).map(o => o[0]), ['chat', 'notes', 'talk', 'attach']);
  assert.match(opened[4][1].draft, /Design review/, 'Prep with Kairos seeds a chat for the event');
  assert.equal(opened[5][1].sessionId, 'a1b2c3d4e5f6', 'Continue opens the last chat');
  opened.length = 0;
  liveRuns = { 'smoke-chat': { status: 'processing', sessionTitle: 'Drafting the Q4 summary', text: 'Working', revision: 1 } };
  await js("import('/static/js/chatStream.js').then(stream => stream.sync())");
  await waitFor("document.getElementById('notch-shell').dataset.state === 'thinking'");
  assert.equal(await js("document.getElementById('notch-status').textContent"), 'Drafting the Q4 summary', 'the current line reads inline');
  await both('notch-working');
  liveRuns['smoke-chat'] = { ...liveRuns['smoke-chat'], permission: { id: 'smoke-approval' }, revision: 2 };
  await js("import('/static/js/chatStream.js').then(stream => stream.sync())");
  await waitFor("document.getElementById('notch-shell').dataset.state === 'needs'");
  assert.equal(await js("document.querySelector('#notch-signal .n-count')?.textContent"), '1', 'a count appears when something needs you');
  await both('notch-needs-you');
  // Two agents at work bring the chips back (NotchWorking).
  liveRuns = {};
  agents = BOARD_AGENTS.map((agent, i) => ({ ...agent, status: i < 2 ? 'working' : 'idle', status_detail: i ? 'writing draft' : 'asking research' }));
  await js("import('/static/js/chatStream.js').then(stream => stream.sync())");
  await delay(15500);
  await waitFor("document.getElementById('notch-panel').dataset.layout === 'agents'");
  await move(430, 15); await delay(450);
  assert.equal(await js("document.querySelectorAll('.n-chip').length"), 4, 'four agent chips');
  assert.ok(await js("(r => r.height >= 150 && r.height <= 240)(document.getElementById('notch-shell').getBoundingClientRect())"), 'the working layout keeps its board height');
  await shot('notch-two-agents-working.png');

  // The side-edge notch (NotchSide), on each edge: a 44 px pill flush to the edge, a 380 px panel when expanded.
  win.setContentSize(656, 800); await delay(400);
  const W = await js('innerWidth'), H = await js('innerHeight'), mid = H / 2; // the window's own size, whatever the OS adds
  const box = () => js("(r => ({ l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }))(document.getElementById('notch-shell').getBoundingClientRect())");
  const flush = (b, edge) => edge === 'left' ? Math.round(b.l) === 0 : Math.round(b.r) === W;
  for (const edge of ['left', 'right']) {
    win.webContents.send('usage-overlay:config', { edge, offset: 0.5, foldOnHover: false });
    await waitFor(`document.body.dataset.edge === '${edge}' && !document.body.classList.contains('folded')`);
    await move(-1, -1); await delay(750);
    let b = await box();
    assert.ok(Math.round(b.w) === 44 && flush(b, edge), `${edge}: a 44 px pill flush to the edge ${JSON.stringify(b)}`);
    assert.ok(Math.abs((b.t + b.b) / 2 - mid) <= 2, `${edge}: centred along the edge at offset .5 ${JSON.stringify(b)}`);
    assert.equal(await js("getComputedStyle(document.getElementById('notch-shell')).borderRadius"), edge === 'left' ? '0px 22px 22px 0px' : '22px 0px 0px 22px', 'rounded on the inner side');
    assert.equal(await js("document.querySelectorAll('#notch-usage .nm-ring .nm-logo').length"), 2, 'the logo rings are stacked in the rail');
    assert.ok(!/Claude|Codex|Antigravity|%/.test(await js("document.getElementById('notch-bar').innerText")), 'no names or figures in the rail');
    assert.equal(await js("getComputedStyle(document.querySelector('#notch-cluster')).display"), 'grid', 'the agent dots show at rest');
    await shot(`side-${edge}-resting.png`);
    // Expanded: the board's modules, stacked, flush to the edge and inside the window.
    await move(edge === 'left' ? 20 : W - 20, mid);
    await waitFor("document.getElementById('notch-shell').classList.contains('expanded')");
    await delay(450);
    await shot(`side-${edge}-expanded.png`);
    b = await box();
    assert.ok(Math.round(b.w) === 380 && flush(b, edge) && b.t >= 0 && b.b <= H, `${edge}: a 380 px panel flush to the edge ${JSON.stringify(b)}`);
    const panelText = await js("document.getElementById('notch-panel').innerText");
    for (const line of [/up next · in \d+ min/i, /Design review/, /5h 24%/, /Scout: asking research/]) assert.match(panelText, line);
    assert.equal(await js("getComputedStyle(document.querySelector('#notch-panel .n-chips'), '::before').content"), '"Agents"', 'the agents list is labelled');
    assert.equal(await js("document.querySelectorAll('#notch-panel .ns-actions .nq-qa').length"), 4, 'four quick actions in a row');
    assert.equal(await js("getComputedStyle(document.querySelector('#notch-panel .nq-view')).display"), 'none', 'the quiet view is the top notch only');
    const anti = await js("(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector('#notch-readings [data-p=antigravity]').getBoundingClientRect())");
    await move(anti[0], anti[1]);
    await waitFor("document.getElementById('card').classList.contains('show') && /Antigravity Usage/.test(document.getElementById('card').innerText)");
    await delay(250);
    const card = await js("(r => ({ l: r.left, r: r.right, t: r.top, b: r.bottom }))(document.getElementById('card').getBoundingClientRect())");
    assert.ok(card.l >= 0 && card.r <= W && card.t >= 0 && card.b <= H, `${edge}: the card stays in the window ${JSON.stringify(card)}`);
    assert.ok(edge === 'left' ? card.l >= b.r : card.r <= b.l, `${edge}: the card opens inward of the panel`);
    await shot(`side-${edge}-card.png`);
    await js("document.querySelector('#notch-panel .ns-new').click()");
    for (let i = 0; i < 40 && !opened.length; i++) await delay(50);
    assert.equal(opened.pop()[0], 'chat', 'the side panel has its own New chat');
    await move(edge === 'left' ? W - 16 : 5, mid);
    await waitFor("!document.getElementById('notch-shell').classList.contains('expanded')");
    await delay(450);
  }
  // The position along the edge: the ends are flush with the window's ends, and the expanded panel stays inside.
  for (const [offset, expect] of [[0, 'top'], [1, 'bottom']]) {
    win.webContents.send('usage-overlay:config', { edge: 'right', offset, foldOnHover: false });
    await delay(500);
    const b = await box();
    assert.ok(expect === 'top' ? Math.round(b.t) === 0 : Math.round(b.b) === H, `offset ${offset}: flush with the ${expect} ${JSON.stringify(b)}`);
    await move(W - 20, expect === 'top' ? 40 : H - 40);
    await waitFor("document.getElementById('notch-shell').classList.contains('expanded')");
    await delay(450);
    const open = await box();
    assert.ok(open.t >= 0 && open.b <= H, `offset ${offset}: the expanded panel stays inside the window ${JSON.stringify(open)}`);
    await move(5, mid); await waitFor("!document.getElementById('notch-shell').classList.contains('expanded')");
  }
  // Folded (opt-in): only the small tab at the edge, which wakes the notch.
  win.webContents.send('usage-overlay:config', { edge: 'right', offset: 0.5, foldOnHover: true });
  await waitFor("document.body.classList.contains('folded')");
  await delay(500);
  {
    const tab = await js("(r => ({ l: r.left, r: r.right, w: r.width, h: r.height, c: (r.top + r.bottom) / 2 }))(document.getElementById('rest').getBoundingClientRect())");
    assert.ok(Math.round(tab.r) === W && Math.round(tab.w) === 10 && Math.abs(tab.c - mid) <= 2, 'the folded tab sits at the edge, level with the notch ' + JSON.stringify(tab));
    await move(tab.l + 5, tab.c);
    await waitFor("!document.body.classList.contains('folded')");
  }
  agents = [];

  // Nothing the page renders may come from a script-capable source.
  assert.equal(await js("document.querySelectorAll('#card script, #card img, #card iframe').length"), 0);
  // Real transparent native window, actual screen geometry, actual IPC bridge.
  // This checks this machine's compositor/DPI; it cannot reproduce every user's monitor.
  nativeWin = new BrowserWindow({ ...placement.boundsFor({ edge:'right', offset:0.5 }, screen.getPrimaryDisplay()),
    frame:false, transparent:true, hasShadow:false, focusable:false, skipTaskbar:true, show:false,
    webPreferences:{ contextIsolation:true, nodeIntegration:false, backgroundThrottling:false, preload:path.join(root,'electron/usage-overlay-preload.js') } });
  nativeWin.setIgnoreMouseEvents(true, { forward:true });
  let desired = placement.boundsFor({ edge:'right', offset:0.5 }, screen.getPrimaryDisplay());
  const tracking = trackOverlay(nativeWin, screen, () => desired);
  await nativeWin.loadURL(`http://127.0.0.1:${server.address().port}/usage-overlay`);
  nativeWin.showInactive();
  for (const edge of placement.EDGES) {
    desired = placement.boundsFor({ edge, offset:0.5 }, screen.getPrimaryDisplay());
    tracking.place(); await delay(100);
    const actual = nativeWin.getBounds();
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(actual[key]-desired[key]) <= 1,
      edge + ': native DIP rounding stays within one pixel: ' + JSON.stringify({actual,desired}));
  }
  // Move this disposable window under the existing cursor, without moving the
  // system cursor or clicking anything. Native polling alone must unfold it.
  desired = placement.boundsFor({ edge:'right', offset:0.5 }, screen.getPrimaryDisplay());
  tracking.place(); nativeWin.webContents.send('usage-overlay:config', { edge:'right', foldOnHover:true });
  await delay(150);
  const restAt = await nativeWin.webContents.executeJavaScript("(r => ({x:r.left+r.width/2,y:r.top+r.height/2}))(document.getElementById('rest').getBoundingClientRect())");
  const cursor = screen.getCursorScreenPoint();
  desired = { ...desired, x:Math.round(cursor.x-restAt.x), y:Math.round(cursor.y-restAt.y) };
  tracking.place(); await delay(250);
  assert.equal(await nativeWin.webContents.executeJavaScript("document.body.classList.contains('folded')"), false, 'actual native cursor wakes click-through window');
  nativeWin.hide(); nativeWin.destroy(); nativeWin = null;
  console.log('PASS: actual native transparent window bounds on all edges and native cursor wake on this display');
  console.log('PASS: usage notch folded/unfold, card, click-through, ring refresh, quiet view, side edges, logos. Screenshots: ' + output);
}
run().then(() => exitAfterFlush(0), (error) => { console.error(error); exitAfterFlush(1); }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  if (nativeWin && !nativeWin.isDestroyed()) nativeWin.destroy();
  server.close();
});
