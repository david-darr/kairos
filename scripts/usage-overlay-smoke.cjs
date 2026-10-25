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
for (const name of ['notchShell', 'activityModel', 'chatStream', 'mascot', 'agentAvatar', 'dither', 'kip']) files[`/static/js/${name}.js`] = [`static/js/${name}.js`, 'text/javascript'];
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
  if (req.url === '/api/auth/status' || req.url === '/api/agents' || req.url === '/api/agents/inbox' || req.url === '/api/triggers' || req.url === '/api/notifications') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/agents' ? agents : { runs: {}, username: 'local' })); return;
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
let openedApp = 0;
ipcMain.on('usage-overlay:interactive', (event, on) => {
  interactive.push(on);
  if (nativeWin && event.sender === nativeWin.webContents) nativeWin.setIgnoreMouseEvents(!on, { forward: true });
});
ipcMain.on('usage-overlay:open-app', () => { openedApp += 1; });
ipcMain.handle('usage-overlay:config', () => ({ edge: 'right', foldOnHover: true }));
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
  win = new BrowserWindow({ x: -5000, y: -5000, width: 360, height: 460, show: true, skipTaskbar: true, focusable: false,
    backgroundColor: '#3a4a5c', // a dark stand-in for the desktop, so the black notch is visible in screenshots
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      preload: path.join(root, 'electron/usage-overlay-preload.js') } });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/usage-overlay`);
  const js = code => win.webContents.executeJavaScript(code);
  const waitFor = async (cond) => { for (let i = 0; i < 60; i++) { if (await js(cond)) return; await delay(50); } throw new Error('Timed out: ' + cond); };
  const move = (x, y) => js(`document.dispatchEvent(new MouseEvent('mousemove',{clientX:${x},clientY:${y},bubbles:true}))`);

  // At rest: folded to the sliver, both rings drawn behind the clip, headline percents shown.
  await waitFor("document.querySelectorAll('#pill .cell').length === 2");
  assert.equal(await js("document.body.classList.contains('folded')"), true, 'starts folded');
  assert.deepEqual(await js("[...document.querySelectorAll('.pct')].map(n => n.textContent)"), ['24%', '86%']);
  await delay(600);  // capturing before the first frame has painted fails with UnknownVizError
  fs.writeFileSync(path.join(output, 'folded.png'), (await win.webContents.capturePage()).toPNG());

  // Reaching the sliver unfolds it and takes clicks; the Codex ring is past 80%, so it is red.
  const rest = await js("(r => [r.left + r.width / 2, r.top + r.height / 2])(document.getElementById('rest').getBoundingClientRect())");
  await move(rest[0], rest[1]);
  await waitFor("!document.body.classList.contains('folded')");
  assert.equal(interactive[interactive.length - 1], true, 'pointer over the notch takes clicks');
  assert.equal(await js("getComputedStyle(document.querySelector('.cell[data-p=codex] svg.reading circle')).stroke"), 'rgb(224, 132, 111)');

  // Hovering a ring opens its card, CodeNotch's layout: title, windows, reset copy, used and left.
  const ring = await js("(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector('.cell[data-p=claude] .ringwrap').getBoundingClientRect())");
  await delay(400);
  await move(ring[0], ring[1]);
  await waitFor("document.getElementById('card').classList.contains('show')");
  const cardText = await js("document.getElementById('card').innerText");
  assert.match(cardText, /Claude Usage/);
  assert.match(cardText, /5-hour limit/);
  assert.match(cardText, /Weekly limit/);
  assert.match(cardText, /24% Used · 76% left/);
  assert.match(cardText, /Resets/);
  await delay(250);
  fs.writeFileSync(path.join(output, 'card.png'), (await win.webContents.capturePage()).toPNG());

  // Clicking a ring refreshes that provider.
  await js(`(() => { const r = document.querySelector('.cell[data-p=claude] .ringwrap').getBoundingClientRect();
    const o = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, bubbles: true };
    document.getElementById('pill').dispatchEvent(new MouseEvent('mousedown', o)); document.dispatchEvent(new MouseEvent('mouseup', o)); })()`);
  await waitFor(`${JSON.stringify(refreshes)}.length >= 0`);
  for (let i = 0; i < 40 && !refreshes.includes('claude'); i++) await delay(50);
  assert.deepEqual(refreshes, ['claude'], 'a ring click refreshes only its own provider');

  // Moving away gives clicks back to the desktop and folds again.
  await move(20, 20);
  await waitFor("document.body.classList.contains('folded')");
  assert.equal(interactive[interactive.length - 1], false, 'pointer off the notch passes clicks through');

  // Native cursor IPC must wake the click-through notch without a DOM mousemove.
  win.webContents.send('usage-overlay:pointer', { x: rest[0], y: rest[1] });
  await waitFor("!document.body.classList.contains('folded')");
  await delay(400);
  win.webContents.send('usage-overlay:pointer', { x: ring[0], y: ring[1] });
  await waitFor("document.getElementById('card').classList.contains('show')");
  // Forwarding can send mouseleave as click-through changes. Repeated native
  // samples must repair hover even when the physical cursor has not moved.
  await js("document.dispatchEvent(new MouseEvent('mouseleave'))");
  win.webContents.send('usage-overlay:pointer', { x: ring[0], y: ring[1] });
  await delay(550);
  assert.equal(await js("document.body.classList.contains('folded')"), false, 'stationary native pointer cancels stray mouseleave');
  // Samples faster than the grace timers must still allow the card to close
  // and the notch to fold when the pointer stays outside.
  for (let i = 0; i < 8; i++) {
    win.webContents.send('usage-overlay:pointer', { x: -1, y: -1 });
    await delay(80);
    if (i === 4) assert.equal(await js("document.getElementById('card').classList.contains('show')"), false, 'repeated outside samples do not defer card hide');
  }
  await waitFor("document.body.classList.contains('folded')");

  // Signed out: a dash on the ring and the sign-in note on the card.
  claudeStatus = 'needs_sign_in';
  await js('refreshUsageReadings()');
  await waitFor("document.querySelector('.cell[data-p=claude] .pct').textContent === '—'");
  await move(rest[0], rest[1]);
  await waitFor("!document.body.classList.contains('folded')");
  await delay(400);
  await move(ring[0], ring[1]);
  await waitFor("document.getElementById('card').innerText.includes('Sign in to Claude Code')");

  // Real logos, not letters: Claude's mark and the OpenAI mark for Codex, loaded and in use.
  assert.deepEqual([...new Set(servedMarks)].sort(), ['claude.svg', 'openai.svg']);
  assert.match(await js("getComputedStyle(document.querySelector('.cell[data-p=codex] .mark')).maskImage"), /openai\.svg/);
  assert.match(await js("document.querySelector('#card .c-head .mark').style.getPropertyValue('--mark')"), /claude\.svg/);

  // Every edge: the pill against that edge and the card fully inside the window, never clipped.
  for (const [edge, width, height] of [['left', 360, 650], ['top', 650, 650], ['bottom', 650, 650], ['right', 360, 650]]) {
    win.setContentSize(width, height);
    win.webContents.send('usage-overlay:config', { edge, foldOnHover: false });
    await waitFor(`document.body.dataset.edge === '${edge}' && !document.body.classList.contains('folded')`);
    await delay(450);
    const ringAt = await js("(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector('.cell[data-p=codex] .ringwrap').getBoundingClientRect())");
    await move(ringAt[0], ringAt[1]);
    await waitFor("document.getElementById('card').classList.contains('show') && document.getElementById('card').innerText.includes('Codex Usage')");
    await delay(300);
    const geometry = await js(`(() => { const box = el => { const r = document.getElementById(el).getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      return { W: innerWidth, H: innerHeight, pill: box('pill'), card: box('card') }; })()`);
    const { W, H, pill, card } = geometry;
    const touching = { left: Math.round(pill.l) === 0, right: Math.round(pill.r) === W, top: Math.round(pill.t) === 0, bottom: Math.round(pill.b) === H }[edge];
    assert.ok(touching, `${edge}: pill is flush against its edge ${JSON.stringify(geometry)}`);
    assert.ok(card.l >= 0 && card.t >= 0 && card.r <= W && card.b <= H, `${edge}: card inside the window ${JSON.stringify(geometry)}`);
    fs.writeFileSync(path.join(output, `edge-${edge}.png`), (await win.webContents.capturePage()).toPNG());
    await move(-1, -1);
  }

  // Phase-1 shell: collapsed and expanded geometry at renderer scale factors.
  for (const zoom of [1, 1.25, 1.5]) {
    win.webContents.setZoomFactor(zoom); win.setContentSize(Math.round(860 * zoom), Math.round(440 * zoom));
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
    // Expanded (NotchWorking): 820 DIP wide; the status row and the cards set the height.
    { const [w, h, t, c] = await size(); assert.ok(w === 820 && h >= 150 && h <= 220 && t === 0 && Math.abs(c - await js('innerWidth / 2')) <= 1, 'expanded ' + JSON.stringify([w, h, t, c])); }
    fs.writeFileSync(path.join(output, `notch-expanded-${zoom}.png`), (await win.webContents.capturePage()).toPNG());
    // Every connected model is in the status row: three readings and "+2", all inside the notch.
    assert.deepEqual(await js("[...document.querySelectorAll('#notch-readings .n-word')].map(n => n.textContent)"),
      ['Claude sign in', 'Codex 5h 86%', 'Antigravity 2.1K tokens today', '+2'], 'status row lists every model (Claude was signed out above)');
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
      for (const line of [/Claude\s+sign in/, /Codex\s+5h 86%/, /Antigravity\s+2\.1K tokens today/, /qwen3\s+12K tokens today/, /Grok\s+no usage yet/]) assert.match(all, line);
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
  win.setContentSize(860, 440);
  const shot = async name => { await delay(400); fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG()); };
  const both = async name => { await move(-1, -1); await delay(450); await shot(`${name}-collapsed.png`); await move(430, 15); await delay(450); await shot(`${name}-expanded-light.png`);
    // A dark Appearance theme: the boards themselves.
    await js("document.body.classList.remove('notch-light')"); await shot(`${name}-expanded-dark.png`); await js("document.body.classList.add('notch-light')"); };
  // Resting with the board's four agents: the rings, the dots and four resting chips.
  agents = BOARD_AGENTS.map(agent => ({ ...agent }));
  await delay(15500); // the notch's agent poll
  await both('notch-resting');
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
  liveRuns = {}; agents = [];

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
  console.log('PASS: usage notch folded/unfold, card, click-through, ring refresh, signed-out state, logos, all four edges. Screenshots: ' + output);
}
run().then(() => exitAfterFlush(0), (error) => { console.error(error); exitAfterFlush(1); }).finally(() => {
  if (win && !win.isDestroyed()) win.destroy();
  if (nativeWin && !nativeWin.isDestroyed()) nativeWin.destroy();
  server.close();
});
