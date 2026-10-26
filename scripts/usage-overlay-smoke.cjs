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
let claudeStatus = 'ok', codexStatus = 'ok', quotaForbidden = false;
let liveRuns = {}, cliPairs = [];
// What the notch posted (answers, responses) and asked the main process for.
const posts = [], focus = [];
// Request ids the stub server has already seen answered, so a second answer gets 409.
const answeredIds = new Set();

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
  const codex = { provider: 'codex', status: codexStatus, stale: false, note: '', updated_at: now, windows: [
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
for (const name of ['notchShell', 'notchIcons', 'notchModelMarks', 'notchQuiet', 'notchSide', 'notchSteps', 'notchGlow', 'notchPanels', 'notchDrop', 'notchComposer',
  'kipStyle', 'activityModel', 'chatStream', 'mascot', 'agentAvatar', 'dither', 'kip']) files[`/static/js/${name}.js`] = [`static/js/${name}.js`, 'text/javascript'];
for (const name of ['kairos-theme', 'mascot']) files[`/static/css/${name}.css`] = [`static/css/${name}.css`, 'text/css'];
// Phase 3: what the composer and the drop zone asked the stub backend for.
const backend = { sessions: [], models: [], dropped: [], live: [], deleted: [], uploads: [], folderAsks: [] };
let failNextLive = false, folderStream = null;
const readBody = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
const sendJson = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function phase3(req, res) {
  if (req.url === '/api/sessions' && req.method === 'POST') {
    const id = `notch-new-${backend.sessions.length + 1}`; backend.sessions.push(id); return sendJson(res, 200, { id, title: 'New Chat' });
  }
  const model = /^\/api\/sessions\/([\w-]+)\/model$/.exec(req.url);
  if (model && req.method === 'POST') { backend.models.push([model[1], JSON.parse(await readBody(req)).model_endpoint_id]); return sendJson(res, 200, {}); }
  const remove = /^\/api\/sessions\/([\w-]+)$/.exec(req.url);
  if (remove && req.method === 'DELETE') { backend.deleted.push(remove[1]); return sendJson(res, 200, { ok: true }); }
  if (req.url === '/api/models/choices') return sendJson(res, 200, [{ id: 'm1', name: 'Sonnet 5.5', kind: 'claude_cli' }, { id: 'm2', name: 'Codex', kind: 'codex_cli' }]);
  if (req.url === '/api/notch/dropped' && req.method === 'POST') { backend.dropped.push(JSON.parse(await readBody(req)).session_id); return sendJson(res, 200, { status: 'marked' }); }
  if (req.url === '/api/chat/live' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    backend.live.push(body);
    // As chat_live.start: one turn per request id; the first answer is lost on the way back.
    if (failNextLive) { failNextLive = false; return sendJson(res, 502, { detail: 'The message could not be sent.' }); }
    return sendJson(res, 200, { turn_id: `turn-${body.request_id}` });
  }
  if (req.url === '/api/chat/attachments' && req.method === 'POST') {
    const body = (await readBody(req)).toString('latin1');
    const name = /filename="([^"]+)"/.exec(body)?.[1] || 'file';
    if (name.startsWith('slow')) await delay(1800);  // long enough to see the upload panel
    backend.uploads.push(name);
    return sendJson(res, 200, { id: `att-${backend.uploads.length}`, filename: name, size: body.length });
  }
  if (req.url === '/api/notch/folder' && req.method === 'POST') {
    const { session_id: session, path: folder } = JSON.parse(await readBody(req));
    backend.folderAsks.push([session, folder]);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = `folder-${backend.folderAsks.length}`;
    res.write(`data: ${JSON.stringify({ permission: { id, kind: 'permission', tool: 'folder_access', target: folder, title: `Allow Kairos to read ${folder}?`,
      description: 'A folder dropped on the notch. The chat gets its path and a list of file names, never the files themselves.', arguments: { path: folder },
      expires_at: Date.now() / 1000 + 120, choices: [{ id: 'once', label: 'Once, for this chat', behavior: 'allow', scope: 'session' },
        { id: 'forever', label: `Always allow reading ${folder}`, behavior: 'allow', scope: 'forever' }, { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }] } })}\n\n`);
    folderStream = { id, res, session, folder };
    return true;
  }
  return false;
}
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/') && !req.url.startsWith('/api/permissions') && await phase3(req, res) !== false) return;
  const answer = /^\/api\/permissions\/([\w-]+)\/(answer|respond)$/.exec(req.url);
  if (answer && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      posts.push({ id: answer[1], route: answer[2], body: JSON.parse(body) });
      // A folder grant's stream then says what the broker decided.
      if (folderStream?.id === answer[1]) {
        const choice = JSON.parse(body).choice, { res: stream, session, folder } = folderStream;
        stream.end(`data: ${JSON.stringify(choice === 'reject' ? { status: 'rejected' }
          : { status: 'allowed', folder: { kind: 'folder', id: `grant-${answer[1]}`, session_id: session, label: folder.split(/[\\/]/).pop(), path: folder } })}\n\n`);
        folderStream = null;
      }
      // As the server: one answer per request, and nothing for an expired one.
      const late = answer[1].startsWith('expired') || answeredIds.has(answer[1]);
      answeredIds.add(answer[1]);
      res.writeHead(late ? 409 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(late ? { detail: 'That request is no longer waiting for an answer.' } : { status: 'answered' }));
    });
    return;
  }
  if ((req.url === '/api/models/quotas' || req.url === '/api/models/quotas/refresh') && quotaForbidden) {
    res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"detail":"Admin only"}'); return;
  }
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
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ runs: liveRuns, cliPairs })); return;
  }
  // What the quiet view reads: chats, notes and the calendar, as the app's own endpoints answer them.
  const sessionList = [{ id: 'a1b2c3d4e5f6', title: 'Q4 planning', updated_at: now - 720, message_count: 6 }, { id: 'b1b2c3d4e5f6', title: 'Trip notes', updated_at: now - 86400 * 3, message_count: 2 }];
  if (req.url === '/api/sessions') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(sessionList)); return; }
  if (req.url === '/api/sessions/a1b2c3d4e5f6') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...sessionList[0], messages: [{ role: 'user', content: 'Plan Q4' }, { role: 'assistant', content: 'Here are three roadmap themes to compare, with the tradeoffs of each.' }] })); return;
  }
  if (req.url.startsWith('/api/notes')) {
    // Local midnight stays due today even when UTC has already rolled over.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'n1', text: 'Send invoice', completed: false, due_date: today.toISOString() }, { id: 'n2', text: 'Call the bank', completed: false, due_date: yesterday.toISOString() }])); return;
  }
  if (req.url.startsWith('/api/calendar/events')) {
    const at = minutes => new Date(Date.now() + minutes * 60000).toISOString();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 'e1', title: 'Design review', start: at(40), end: at(85), source: 'google', calendar_name: 'Google', completed: false }])); return;
  }
  if (req.url === '/api/auth/status' || req.url === '/api/agents' || req.url === '/api/agents/inbox' || req.url === '/api/triggers' || req.url === '/api/notifications') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/agents' ? agents : { runs: {}, username: 'David', is_admin: true })); return;
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
  let content = fs.readFileSync(path.join(root, file[0]));
  // Reproduce a cached legacy document loading the current scripts and CSS.
  if (req.url === '/usage-overlay') content = content.toString().replace('<div id="root">', `<div id="root">
    <div id="tail"></div><div id="pill"></div>
    ${['move', 'orb'].map(id => `<div id="${id}" class="handle"><svg class="h-rest" viewBox="-36 -36 72 72" aria-hidden="true">
      <circle r="28.5" fill="none" stroke="currentColor" stroke-width="6.8" stroke-linecap="round" stroke-dasharray="44.77 179.07"/>
    </svg></div>`).join('')}`);
  res.end(content);
});
const servedMarks = [];
const interactive = [];
ipcMain.on('usage-overlay:interactive', (event, on) => {
  interactive.push(on);
  if (nativeWin && event.sender === nativeWin.webContents) nativeWin.setIgnoreMouseEvents(!on, { forward: true });
});
const opened = [];
ipcMain.on('usage-overlay:open-app', (event, target, detail) => { opened.push([target, detail]); });
// Phase 2: a panel's Open chat and a chip open one chat or agent; the keyboard, only while a field is open.
const openedIds = [];
ipcMain.on('usage-overlay:open-chat', (_event, id) => openedIds.push(['chat', id]));
ipcMain.on('usage-overlay:open-agent', (_event, id) => openedIds.push(['agent', id]));
ipcMain.on('usage-overlay:focus', (_event, on) => focus.push(on));
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
  const collapsedPage = async () => {
    assert.equal(await js("document.body.dataset.edge === 'top-centre' && !document.getElementById('notch-shell').classList.contains('expanded')"), true);
    const outside = await js(`(() => {
      const shell = document.getElementById('notch-shell');
      return [...document.body.querySelectorAll('*')].filter(node => {
        if (node.id === 'root' || shell.contains(node)) return false;
        if (node.closest('#rest') && document.body.classList.contains('folded')) return false;
        if (node.closest('#card.show, #notice.show')) return false;
        for (let parent = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
        }
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }).map(node => ({ tag: node.tagName, id: node.id, class: node.getAttribute('class'),
        width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    })()`);
    assert.deepEqual(outside, [], 'collapsed top-centre page has no visible boxes outside the shell except shown rest/card/notice');
  };

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
    const collapsed = async () => { const [w, h, t, c] = await size(); assert.ok(h === 40 && t === 0 && w >= 120 && w <= 480 && Math.abs(c - await js('innerWidth / 2')) <= 1, 'collapsed ' + JSON.stringify([w, h, t, c, await js('[innerWidth, document.getElementById("notch-usage").outerHTML.slice(0,300), document.getElementById("notch-shell").dataset.state]')])); };
    await collapsed();
    await collapsedPage();
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
    await collapsedPage();
  }
  win.webContents.setZoomFactor(1);

  // Feed the real activity model through the stub snapshot, with no backend work.
  win.setContentSize(860, 640);
  const sync = () => js("import('/static/js/chatStream.js').then(stream => stream.sync())");
  const at = selector => js(`(r => [r.left + r.width / 2, r.top + r.height / 2])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`);
  // A real pointer click, as the person makes one (trusted, detail 1).
  const realClick = async selector => {
    const [x, y] = await at(selector);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await delay(150);
  };
  const panelKind = () => js("document.querySelector('#notch-takeover .n-panel')?.dataset.kind || ''");
  const panelButtons = () => js("[...document.querySelectorAll('#notch-takeover .n-act')].map(b => b.getAttribute('aria-label') || b.textContent)");
  const kipState = () => js("document.getElementById('notch-kip-large').getAttribute('state')");
  const expandNow = async () => { await move(430, 15); await waitFor("document.getElementById('notch-shell').classList.contains('expanded')"); };
  const collapseNow = async () => { await move(-1, -1); await waitFor("!document.getElementById('notch-shell').classList.contains('expanded')"); };
  const choices = [{ id: 'once', label: 'Allow once', behavior: 'allow', scope: 'once' },
    { id: 'session', label: 'Always in this chat (ls -la)', behavior: 'allow', scope: 'session' },
    { id: 'forever', label: 'Always allow ls -la', behavior: 'allow', scope: 'forever' },
    { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }];
  const approval = (id, extra = {}) => ({ id, kind: 'permission', tool: 'Bash', target: 'ls -la', title: 'Run a shell command', description: '',
    arguments: '{"command":"ls -la"}', choices, expires_at: Date.now() / 1000 + 90, ...extra });
  let revision = 10;
  const setRun = (id, changes) => { liveRuns[id] = { ...(liveRuns[id] || { status: 'processing', sessionTitle: 'Drafting the Q4 summary', text: '' }), ...changes, revision: ++revision }; };
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
  for (const label of ['Note', 'Talk', 'Drop files']) await js(`document.querySelector('.nq-view .nq-qa[aria-label="${label}"]').click()`);
  await js("document.querySelector('.nq-view .nq-pill:not(.nq-primary)').click()");
  await js("document.querySelector('.nq-view .nq-primary').click()");
  for (let i = 0; i < 40 && opened.length < 5; i++) await delay(50);
  assert.deepEqual(opened.slice(0, 3).map(o => o[0]), ['notes', 'talk', 'attach']);
  assert.match(opened[3][1].draft, /Design review/, 'Prep with Kairos seeds a chat for the event');
  assert.equal(opened[4][1].sessionId, 'a1b2c3d4e5f6', 'Continue opens the last chat');
  // New chat is the quick composer, here as everywhere.
  await js(`document.querySelector('.nq-view .nq-qa[aria-label="New chat"]').click()`);
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'composer'");
  await shot('notch-quiet-composer.png');
  await js("document.querySelector('.n-compose-field').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("!document.querySelector('#notch-takeover .n-panel') && document.getElementById('notch-panel').dataset.layout === 'quiet'");
  assert.equal(opened.length, 5, 'New chat did not go to the app');
  opened.length = 0;
  // A turn in flight brings the Kip card back with its real steps, even with fewer than two agents at work.
  // Phase 2, working: the turn's real tool steps (a finished read, a running
  // search) and the chat's next queued background item. Nothing invented.
  setRun('smoke-chat', { text: 'Working', toolSteps: [
    { phase: 'started', id: 't1', name: 'Read', summary: 'Q4 notes/revenue.md' },
    { phase: 'finished', id: 't1', name: 'Read', summary: 'Q4 notes/revenue.md', ok: true },
    { phase: 'started', id: 't2', name: 'mcp__hive_mind__vault_search', summary: 'quarterly targets' }] });
  await sync();
  await js(`document.dispatchEvent(new CustomEvent('kairos:bg-tasks', { detail: { sessionId: 'smoke-chat', items: [
    { id: 'helper:1', kind: 'helper', label: 'Save to Library', status: 'queued', activity: '' },
    { id: 'helper:2', kind: 'helper', label: 'Index the vault', status: 'running', activity: 'Reading 3 notes' }] } }))`);
  await waitFor("document.getElementById('notch-shell').dataset.state === 'thinking'");
  assert.equal(await js("document.getElementById('notch-status').textContent"), 'Drafting the Q4 summary', 'the current line reads inline');
  await both('notch-working');
  assert.deepEqual(await js("[...document.querySelectorAll('.n-lines span')].map(n => n.textContent)"),
    ['Reading Q4 notes/revenue.md', 'Searching quarterly targets', 'Next: Save to Library'], 'the step list is the real steps');
  assert.ok(await js("document.querySelector('.n-current').classList.contains('n-shimmer')"), 'the current step shimmers');
  assert.equal(await js("document.querySelector('.n-now').dataset.glow"), 'gold', 'working glows gold');
  assert.equal(await js("document.querySelectorAll('.n-now canvas.n-glow-layer').length"), 2, 'two prepared glow canvases, cross-faded');
  assert.ok((await js("[...document.querySelectorAll('.n-chips .n-chip')].map(c => c.textContent)")).includes('Index the vault: running'), 'a running background item is a chip');
  assert.equal(await js("document.querySelector('.n-chips .n-chip').textContent"), 'Index the vault: running', 'running work comes before resting agents');
  await realClick('.n-chips .n-chip[data-session]');
  assert.deepEqual(openedIds.at(-1), ['chat', 'smoke-chat'], 'a chip opens its chat');

  // Needs your approval, answered in place.
  setRun('smoke-chat', { permission: approval('perm-1') });
  await sync();
  await waitFor("document.getElementById('notch-panel').dataset.layout === 'agents'");  // a panel replaces the quiet view
  await waitFor("document.getElementById('notch-shell').dataset.state === 'needs'");
  assert.equal(await js("document.querySelector('#notch-signal .n-count')?.textContent"), '1', 'a count appears when something needs you');
  await both('notch-needs-you');
  assert.equal(await panelKind(), 'approval');
  assert.deepEqual(await panelButtons(), ['Allow once', 'Always in this chat (ls -la)', 'Reject', 'Open chat'], 'Always is this chat, its scope in words');
  assert.match(await js("document.querySelector('#notch-takeover .n-panel').innerText"), /needs your approval[\s\S]*Run a shell command[\s\S]*ls -la[\s\S]*Tool: Bash[\s\S]*Answer within 1:/i);
  assert.equal(await kipState(), 'needs');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'gold');
  assert.ok(await js("document.querySelector('.n-row').classList.contains('n-rail-mode')"), 'the chips fold to the rail');
  await collapseNow(); await delay(300);
  assert.equal(posts.length, 0, 'collapsing never answers');
  await expandNow();
  await realClick('#notch-takeover [data-choice=once]');
  assert.equal(posts.length, 0, 'a click in the first 400 ms after the panel appears does nothing');
  await delay(450);
  await js("document.querySelector('#notch-takeover [data-choice=once]').click()");
  await js("document.querySelector('#notch-takeover [data-choice=once]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))");
  await delay(150);
  assert.equal(posts.length, 0, 'a synthetic or keyboard click does nothing');
  await realClick('#notch-takeover [data-choice=once]');
  await waitFor("document.querySelector('#notch-takeover .n-panel-note').textContent === 'Allowed.'");
  assert.deepEqual(posts, [{ id: 'perm-1', route: 'answer', body: { choice: 'once' } }], 'one deliberate click, one answer');
  // A second answer gets 409 from the server, and the panel says so.
  answeredIds.add('perm-2');
  setRun('smoke-chat', { permission: approval('perm-2') });
  await sync();
  await waitFor("/Answer within/.test(document.querySelector('#notch-takeover .n-panel-note')?.textContent || '') && !!document.querySelector('#notch-takeover [data-choice=reject]')");
  await delay(450);
  await realClick('#notch-takeover [data-choice=reject]');
  await waitFor("document.querySelector('#notch-takeover .n-panel-note').textContent === 'This was already answered.'");
  assert.deepEqual(posts.at(-1), { id: 'perm-2', route: 'answer', body: { choice: 'reject' } });
  // An expired request shows as expired, and its buttons answer nothing.
  setRun('smoke-chat', { permission: approval('expired-3', { expires_at: Date.now() / 1000 - 1 }) });
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel-note')?.textContent === 'This request has expired.'");
  const sent = posts.length;
  await delay(450); await realClick('#notch-takeover [data-choice=once]');
  assert.equal(posts.length, sent, 'an expired request is not answered');
  assert.ok(await js("[...document.querySelectorAll('#notch-takeover [data-choice]')].every(b => b.disabled)"));
  await shot('notch-approval-expired.png');

  // Terminal pairing prompts are never answered from the notch: Open Kairos only.
  setRun('smoke-chat', { permission: null });
  cliPairs = [{ id: 'pair-1', kind: 'permission', tool: 'kairos_cli_pair', title: 'A terminal wants to use Kairos. It shows amber anchor. Allow this terminal?',
    choices: [{ id: 'once', label: 'Allow', behavior: 'allow', scope: 'once' }, { id: 'reject', label: 'Reject', behavior: 'deny', scope: 'once' }], expires_at: Date.now() / 1000 + 100 }];
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'cli'");
  assert.deepEqual(await panelButtons(), ['Open Kairos'], 'a pairing shows Open Kairos only');
  assert.equal(await js("document.querySelectorAll('#notch-takeover [data-choice]').length"), 0);
  const appOpens = opened.length;
  await realClick('#notch-takeover .n-act');
  assert.equal(opened.length, appOpens + 1, 'Open Kairos opens the app');
  assert.equal(opened.at(-1)[0], 'home');
  await shot('notch-cli-pairing.png');
  cliPairs = [];
  await js("document.dispatchEvent(new CustomEvent('kairos:cli-pair-closed', { detail: { id: 'pair-1' } }))");
  setRun('smoke-chat', { permission: approval('pair-2', { tool: 'kairos_cli_pair' }) });
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'cli'");
  assert.deepEqual(await panelButtons(), ['Open Kairos'], 'the pairing tool is filtered even inside a chat run');
  assert.equal(posts.length, sent, 'no pairing was ever answered');

  // Question (ask_user): an option, then Send.
  const question = (id, options) => ({ id, kind: 'question', tool: 'AskUserQuestion', title: 'Waiting for your response', choices: [], arguments: {},
    expires_at: Date.now() / 1000 + 1800, questions: [{ question: 'Which inbox should I triage first?', header: '', multiSelect: false, options }] });
  setRun('smoke-chat', { permission: question('q-1', [{ label: 'Work', description: '' }, { label: 'School', description: '' }, { label: 'Personal', description: '' }]) });
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'question'");
  assert.deepEqual(await panelButtons(), ['Work', 'School', 'Personal', 'Other…', 'Send', 'Skip']);
  await delay(450);
  await realClick('#notch-takeover .n-opt:nth-child(2)');
  await js("document.body.classList.remove('notch-light')"); await shot('notch-question-expanded-dark.png'); await js("document.body.classList.add('notch-light')");
  await shot('notch-question-expanded-light.png');
  await realClick('#notch-takeover .n-act-gold');
  await waitFor("document.querySelector('#notch-takeover .n-panel-note').textContent === 'Answered.'");
  assert.deepEqual(posts.at(-1), { id: 'q-1', route: 'respond', body: { answers: { 'Which inbox should I triage first?': 'School' } } });
  // One line of text: the window takes the keyboard only while that line is open.
  setRun('smoke-chat', { permission: question('q-2', [{ label: 'Work', description: '' }]) });
  await sync();
  await waitFor("(document.querySelector('#notch-takeover .n-panel-note')?.textContent || '').startsWith('Answer within') && !!document.querySelector('#notch-takeover .n-opt-other')");
  await delay(450);
  focus.length = 0;  // the quiet view's composer came and went above
  await realClick('#notch-takeover .n-opt-other');
  assert.deepEqual(focus, [true], 'Other… asks for the keyboard');
  await move(-1, -1); await delay(600);
  assert.equal(await js("document.getElementById('notch-shell').classList.contains('expanded')"), true, 'an open line keeps the notch open');
  setRun('smoke-chat', { permission: null });
  await sync();
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");
  assert.deepEqual(focus, [true, false], 'the keyboard goes back when the line closes');

  // Error: a failed turn, fixed copy, Open chat (never a re-send).
  setRun('smoke-chat', { status: 'failed', error: 'The selected model failed. Check its connection or choose another model. Any partial reply has been saved.' });
  await sync();
  await expandNow();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'error'");
  assert.match(await js("document.querySelector('#notch-takeover .n-panel').innerText"), /Couldn't finish Drafting the Q4 summary[\s\S]*The reply stopped before it finished/);
  assert.deepEqual(await panelButtons(), ['Open chat', 'Dismiss'], 'no Retry for a chat turn');
  assert.equal(await kipState(), 'error');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'ember');
  await shot('notch-error-expanded-light.png');
  await js("document.body.classList.remove('notch-light')"); await shot('notch-error-expanded-dark.png'); await js("document.body.classList.add('notch-light')");
  await realClick('#notch-takeover .n-act-gold');
  assert.deepEqual(openedIds.at(-1), ['chat', 'smoke-chat']);
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");
  // A sign-in error: Retry re-reads that provider's usage, and only that.
  claudeStatus = 'needs_sign_in'; await js('refreshUsageReadings()');
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'error'");
  assert.deepEqual(await panelButtons(), ['Retry', 'Dismiss']);
  const refreshed = refreshes.length;
  await delay(450); await realClick('#notch-takeover .n-act-round');
  await waitFor("document.querySelector('#notch-takeover .n-panel-note').textContent === 'Still not working. Try again shortly.'");
  assert.deepEqual(refreshes.slice(refreshed), ['claude']);
  claudeStatus = 'ok'; await js('refreshUsageReadings()');
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");

  // Recovering: a turn the server lost in a restart; a provider asking for a pause.
  setRun('smoke-two', { sessionTitle: 'Weekly plan', status: 'processing' });
  await sync();
  setRun('smoke-two', { status: 'failed', error: 'The server restarted before this reply completed.' });
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'recovering'");
  await delay(1000);
  assert.equal(await js("document.querySelector('#notch-takeover .n-panel-title').textContent"), 'Kairos lost its place and is getting back on its feet.');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'recover');
  assert.equal(await kipState(), 'sleeping');
  await shot('notch-recovering-expanded-light.png');
  await js("document.body.classList.remove('notch-light')"); await shot('notch-recovering-expanded-dark.png'); await js("document.body.classList.add('notch-light')");
  await realClick('#notch-takeover .n-act-link');
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");
  codexStatus = 'rate_limited'; await js('refreshUsageReadings()');
  await waitFor("/Codex asked for a pause/.test(document.querySelector('#notch-takeover .n-panel-title')?.getAttribute('aria-label') || '')");
  codexStatus = 'ok'; await js('refreshUsageReadings()');
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");

  // Done: a turn that finished while watched, for 6 s, in the success pose.
  setRun('smoke-three', { sessionTitle: 'Q4 summary', status: 'processing' });
  await sync();
  setRun('smoke-three', { status: 'done' });
  await sync();
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'done'");
  assert.match(await js("document.querySelector('#notch-takeover .n-panel').innerText"), /Reply ready[\s\S]*Q4 summary/);
  assert.equal(await kipState(), 'success');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'sage');
  await shot('notch-done-expanded-light.png');
  await js("document.body.classList.remove('notch-light')"); await shot('notch-done-expanded-dark.png'); await js("document.body.classList.add('notch-light')");
  await move(-1, -1); await delay(450); await shot('notch-done-collapsed.png');
  assert.equal(await js("document.getElementById('notch-kip').getAttribute('state')"), 'success', 'the collapsed Kip shows done too');
  await delay(6000);
  assert.equal(await js("document.querySelector('#notch-takeover .n-panel')?.dataset.kind || ''"), '', 'Done leaves after 6 s');
  assert.equal(posts.length, 3, 'the notch sent exactly the three deliberate answers above');
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
    // New chat opens the quick composer in the side panel too.
    await js("document.querySelector('#notch-panel .ns-new').click()");
    await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'composer'");
    await shot(`side-${edge}-composer.png`);
    await js("document.querySelector('.n-compose-field').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor("!document.querySelector('#notch-takeover .n-panel')");
    // An approval takes the Kip card's place, with the same guard: a deliberate click after 400 ms answers.
    setRun('side-chat', { sessionTitle: 'Side check', status: 'processing', permission: approval(`side-${edge}`) });
    await sync();
    await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'approval'");
    await delay(450);
    const panelBox = await js("(r => ({ l: r.left, r: r.right, t: r.top, b: r.bottom }))(document.getElementById('notch-takeover').getBoundingClientRect())");
    assert.ok(panelBox.l >= 0 && panelBox.r <= W && panelBox.b <= H, `${edge}: the panel fits the side panel ${JSON.stringify(panelBox)}`);
    assert.equal(await js("getComputedStyle(document.querySelector('#notch-panel .n-now')).display"), 'none', 'the panel takes the Kip card place');
    await shot(`side-${edge}-panel.png`);
    const before = posts.length;
    await realClick('#notch-takeover [data-choice=once]');
    await waitFor("document.querySelector('#notch-takeover .n-panel-note').textContent === 'Allowed.'");
    assert.deepEqual(posts.slice(before), [{ id: `side-${edge}`, route: 'answer', body: { choice: 'once' } }]);
    setRun('side-chat', { permission: null, status: 'stopped' });
    await sync();
    await waitFor("!document.querySelector('#notch-takeover .n-panel')");
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

  // Back to the top centre for the composer and the drop zone.
  win.setContentSize(860, 640);
  win.webContents.send('usage-overlay:config', { edge: 'top-centre', offset: 0.5, foldOnHover: false });
  await waitFor("document.body.dataset.edge === 'top-centre' && !document.body.classList.contains('folded')");
  await move(-1, -1); await delay(500);
  // Usage is admin-only: a non-admin sees no usage arcs, not an error.
  quotaForbidden = true; await js('refreshUsageReadings()');
  await waitFor("document.querySelectorAll('#notch-usage .n-reading').length === 0 && document.querySelectorAll('#notch-readings .n-word').length === 0");
  assert.equal(await panelKind(), '', 'and no error panel');
  quotaForbidden = false;

  // Phase 3: the quick composer. New opens it and only then does the window
  // take the keyboard; Escape closes it, gives the keyboard back and keeps the draft.
  await expandNow(); await delay(300);
  focus.length = 0;
  await realClick('#notch-new');
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'composer' && !!document.querySelector('.n-compose-field')");
  assert.deepEqual(focus, [true], 'the composer asks for the keyboard as it opens');
  await waitFor("document.querySelector('.n-compose-model').textContent === 'Sonnet 5.5'");
  assert.ok(await js("document.activeElement === document.querySelector('.n-compose-field')"), 'the field has focus');
  await js("(f => { f.value = 'Book a table for four on Friday'; f.dispatchEvent(new Event('input')); })(document.querySelector('.n-compose-field'))");
  await move(-1, -1); await delay(600);
  assert.equal(await js("document.getElementById('notch-shell').classList.contains('expanded')"), true, 'the open composer keeps the notch open');
  await js("document.querySelector('.n-compose-field').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("!document.querySelector('#notch-takeover .n-panel')");
  assert.deepEqual(focus, [true, false], 'closing gives the keyboard back to the app underneath');
  assert.equal(backend.live.length + backend.sessions.length, 0, 'nothing was sent or created');
  // Clicking Kip opens it again, with the draft kept.
  await expandNow(); await delay(300);
  await realClick('#notch-kip-large');
  await waitFor("document.querySelector('.n-compose-field')?.value === 'Book a table for four on Friday'");
  assert.deepEqual(focus, [true, false, true]);
  await shot('notch-composer-expanded-light.png');
  await js("document.body.classList.remove('notch-light')"); await shot('notch-composer-expanded-dark.png'); await js("document.body.classList.add('notch-light')");

  // Drop zone: files dragged over the notch open the dashed slot.
  const drag = (type, files) => js(`(() => { const data = new DataTransfer();
    for (const [name, size] of ${JSON.stringify(files)}) data.items.add(new File([new Uint8Array(size)], name));
    document.dispatchEvent(new DragEvent('${type}', { dataTransfer: data, bubbles: true, cancelable: true })); })()`);
  await drag('dragenter', [['notes.md', 10]]);
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'drop'");
  assert.match(await js("document.querySelector('#notch-takeover .n-panel').innerText"), /Drop files to start a chat[\s\S]*Documents[\s\S]*Folders[\s\S]*25 MB/);
  assert.equal(await kipState(), 'open', 'Kip opens into the box');
  assert.equal(await js("document.querySelector('#notch-takeover kairos-mascot').getAttribute('state')"), 'open');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'sage');
  await delay(400); await shot('notch-drop-expanded-light.png');
  // One file, then five, then one over the limit, refused in words and never uploaded.
  await drag('drop', [['notes.md', 10]]);
  await waitFor("[...document.querySelectorAll('.n-compose-chip')].map(c => c.textContent).join() === 'notes.md'");
  await drag('drop', [['a.pdf', 10], ['b.png', 10], ['c.js', 10], ['d.docx', 10], ['e.txt', 10]]);
  await waitFor("document.querySelectorAll('.n-compose-chip').length === 6");
  assert.deepEqual(backend.uploads, ['notes.md', 'a.pdf', 'b.png', 'c.js', 'd.docx', 'e.txt']);
  await drag('drop', [['big.zip', 25 * 1024 * 1024 + 1]]);
  await waitFor("document.querySelector('#notch-takeover .n-panel-note')?.textContent === 'big.zip is over the 25 MB limit, so it was not added.'");
  assert.equal(backend.uploads.length, 6, 'an over-limit file is never uploaded');
  // A slow upload shows the bar with Kip as its thumb.
  const dropping = drag('drop', [['slow-report.pdf', 10]]);
  await waitFor("document.querySelector('#notch-takeover .n-panel')?.dataset.kind === 'upload'");
  assert.equal(await js("document.querySelector('.n-upload-thumb').getAttribute('state')"), 'carry', 'Kip carries the files');
  assert.equal(await js("document.getElementById('notch-takeover').dataset.glow"), 'sage');
  await shot('notch-upload-expanded-light.png');
  await dropping;
  await waitFor("document.querySelectorAll('.n-compose-chip').length === 7");
  assert.equal(backend.live.length + backend.sessions.length, 0, 'dropping sends nothing');
  await shot('notch-composer-files-light.png');

  // Send: one new chat, its model, marked as carrying dropped files, and one
  // turn even though the first answer was lost and Send was pressed again.
  failNextLive = true;
  await realClick('.n-compose-send');
  await waitFor("document.querySelector('#notch-takeover .n-panel-note')?.textContent === 'The message could not be sent.'");
  assert.equal(await js("document.querySelector('.n-compose-field').value"), 'Book a table for four on Friday', 'a failed send keeps the draft');
  await realClick('.n-compose-send');
  await waitFor("!document.querySelector('#notch-takeover .n-compose')");
  assert.deepEqual(backend.sessions, ['notch-new-1'], 'one new chat');
  assert.deepEqual(backend.models, [['notch-new-1', 'm1']], 'the default model, once');
  assert.deepEqual(backend.dropped, ['notch-new-1'], 'dropped files mark the chat untrusted');
  assert.equal(backend.live.length, 2);
  assert.equal(backend.live[0].request_id, backend.live[1].request_id, 'the retry reuses its request id, so the server starts one turn');
  assert.deepEqual(backend.live[1], { session_id: 'notch-new-1', message: 'Book a table for four on Friday',
    attachment_ids: ['att-1', 'att-2', 'att-3', 'att-4', 'att-5', 'att-6', 'att-7'], references: [], request_id: backend.live[0].request_id });
  assert.deepEqual(focus.at(-1), false, 'sending closes the composer and gives the keyboard back');
  // The working panel then follows that turn.
  setRun('notch-new-1', { sessionTitle: 'New Chat', status: 'processing', text: '', toolSteps: [{ phase: 'started', id: 's1', name: 'WebSearch', summary: 'tables near the office' }] });
  await sync();
  await waitFor("document.querySelector('.n-current').textContent === 'Searching tables near the office'");

  // A folder: the broker's path-root grant, asked in the notch and answered by a click.
  const folderOutcome = js(`import('/static/js/notchDrop.js').then(m => m.askFolder({ sessionId: 'notch-new-2', path: 'C:\\\\work\\\\project',
    onRequest: request => { window.folderRequest = request; } }))`);
  await waitFor("window.folderRequest?.tool === 'folder_access'");
  assert.deepEqual(await js("window.folderRequest.choices.map(c => c.label)"), ['Once, for this chat', 'Always allow reading C:\\work\\project', 'Reject']);
  await js("fetch('/api/permissions/' + window.folderRequest.id + '/answer', { method: 'POST', body: JSON.stringify({ choice: 'reject' }) })");
  assert.deepEqual(await folderOutcome, { status: 'rejected' }, 'reject attaches nothing');
  setRun('notch-new-1', { status: 'done' }); await sync();
  console.log('PASS: phase 3 composer (keys only while open, Escape keeps the draft, one turn per send), drop of 1, 5 and an over-limit file, upload thumb, folder grant stream');

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
