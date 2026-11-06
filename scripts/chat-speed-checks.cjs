// Chat speed checks (Chat Speed 2.3.0, 2026-11-05). A long chat must open without long
// freezes and must never lay out every message on each key, which made typing take 3.4 s
// per key in a 134-message chat in 2.2.0. Real backend fixture and Chromium, isolated from
// every running Kairos instance. Limits are about twice what the fixed code measures, and far
// below what 2.2.0 measured (in brackets), so a regression fails without flaking.
//   node scripts/run-electron-test.cjs chat-speed-checks
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'chat-speed-review', 'run-' + Date.now());
fs.mkdirSync(path.join(output, 'userData'), { recursive: true });
app.setPath('userData', path.join(output, 'userData'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const LIMITS = { typingP95: 50 /* 2.2.0: 5,819 ms */, openLongTotal: 700 /* 904 */, openLongMax: 450 /* 648 */, drift: 4 };
const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, backend, data, log, base;
const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await js(code)) return; await delay(50); }
  throw new Error('Timed out: ' + code);
}
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, route + ': ' + response.status);
  return response.json();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port !== 8420 && port !== 8430);
  return port;
}
async function turn(id, message) {
  await api('/api/chat/live', { session_id: id, message, attachment_ids: [], references: [], request_id: require('node:crypto').randomUUID() });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const run = (await api('/api/chat/live/snapshot')).runs?.[id];
    if (run && run.status !== 'processing') { assert.equal(run.status, 'done'); return; }
    await delay(30);
  }
  throw new Error('Turn timed out: ' + message);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-chat-speed-'));
    fs.mkdirSync(path.join(data, 'vault'));
    log = fs.openSync(path.join(output, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR: data, JARVIS_VAULT_DIR: path.join(data, 'vault'), APP_PORT: String(port), JARVIS_INSTANCE: 'chatspeed' };
    delete env.JARVIS_UI_SECRET;
    backend = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'cli_backend_fixture:app', '--app-dir', 'scripts', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    let healthy = false;
    for (const until = Date.now() + 60000; Date.now() < until;) {
      assert.equal(backend.exitCode, null, 'Backend exited; see backend.log');
      try { healthy = (await fetch(base + '/api/health')).status === 200; } catch { /* Starting. */ }
      if (healthy) break;
      await delay(200);
    }
    assert.ok(healthy, 'Backend health timeout');
    await api('/api/settings/onboarding-complete', {});
    const endpoint = (await api('/api/models/choices')).find(e => e.name === 'Scripted model');
    assert.ok(endpoint);
    const chat = await api('/api/sessions', {});
    await api('/api/sessions/' + chat.id + '/model', { model_endpoint_id: endpoint.id, model_override: null });
    // 70 turns: 140 messages of mixed length, like a long working chat.
    for (let i = 0; i < 70; i++) await turn(chat.id, i % 7 === 3 ? `file note-${i}.md A note body for turn ${i}` : `lines ${[30, 12, 45, 8, 25][i % 5]}`);
    checks.push('seeded a 140-message chat');

    win = new BrowserWindow({ width: 1440, height: 900, x: -3000, y: 0, show: true, skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3 && !/favicon.*404/i.test(message)) errors.push(message); });
    await win.loadURL(base + '/');
    await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay').classList.contains('hidden')");
    await js("window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask' }); true");
    await delay(1500);

    // Opening the long chat.
    const open = await js(`(async () => {
      window.__long = [];
      const t = performance.now();
      document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'chat', sessionId: ${JSON.stringify(chat.id)} } }));
      let last = -1, stable = 0;
      while (performance.now() - t < 20000) {
        await new Promise(r => requestAnimationFrame(r));
        const n = document.querySelectorAll('#chat-messages .msg').length;
        if (n === last && n > 0) { if (++stable > 10) break; } else { stable = 0; last = n; }
      }
      return { messages: last, total: Math.round(window.__long.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(0, ...window.__long)) };
    })()`);
    assert.ok(open.messages >= 140, 'the whole chat opened: ' + open.messages);
    assert.ok(open.total <= LIMITS.openLongTotal, `opening froze ${open.total} ms in total (limit ${LIMITS.openLongTotal})`);
    assert.ok(open.max <= LIMITS.openLongMax, `opening's longest freeze ${open.max} ms (limit ${LIMITS.openLongMax})`);
    checks.push(`opened 140 messages: ${open.total} ms of freezes, longest ${open.max} ms`);

    // Old messages skip layout; the newest 24 never do.
    const skip = await js(`(() => { const m = [...document.querySelectorAll('#chat-messages .msg')]; const cv = n => getComputedStyle(n).contentVisibility;
      return { oldest: cv(m[0]), newest: m.slice(-24).every(n => cv(n) === 'visible'), skipped: m.filter(n => cv(n) === 'auto').length, total: m.length }; })()`);
    assert.equal(skip.oldest, 'auto'); assert.ok(skip.newest, 'the newest 24 messages are always laid out');
    assert.equal(skip.skipped, skip.total - 24);
    checks.push(`${skip.skipped} of ${skip.total} older messages skip layout off screen`);

    // Typing: real keys, key to the next painted frame.
    await js(`(() => { const i = document.getElementById('chat-input'); i.focus(); i.value = ''; window.__keys = []; window.__long = [];
      i.addEventListener('keydown', () => { const t = performance.now(); requestAnimationFrame(() => setTimeout(() => window.__keys.push(performance.now() - t), 0)); }, { capture: true }); return true; })()`);
    for (const ch of 'typing stays quick in a long chat ok') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await delay(60);
    }
    await delay(500);
    const typing = await js(`(() => { const k = window.__keys.slice().sort((a, b) => a - b); return { keys: k.length, p95: Math.round(k[Math.floor(k.length * .95)] || 0), text: document.getElementById('chat-input').value }; })()`);
    assert.equal(typing.text, 'typing stays quick in a long chat ok', 'every key reached the box');
    assert.ok(typing.p95 <= LIMITS.typingP95, `typing p95 ${typing.p95} ms (limit ${LIMITS.typingP95})`);
    const grown = await js("(() => { const i = document.getElementById('chat-input'); i.value = 'one\\ntwo\\nthree\\nfour'; i.dispatchEvent(new Event('input', { bubbles: true })); const tall = i.getBoundingClientRect().height; i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return { tall, short: i.getBoundingClientRect().height }; })()");
    assert.ok(grown.tall > grown.short + 30, 'the box still grows with its text: ' + JSON.stringify(grown));
    checks.push(`typing p95 ${typing.p95} ms; the box grows with its text`);

    // Reading an old message: narrowing the window (as a document pane does) keeps the line in place.
    const before = await js(`(async () => {
      const n = document.querySelector('#chat-messages'); const msg = n.querySelectorAll('.msg')[30];
      msg.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 600)); msg.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 600));
      const rect = n.getBoundingClientRect(); const caret = document.caretRangeFromPoint(rect.left + n.clientWidth / 2, rect.top + n.clientHeight / 2);
      const node = caret.startContainer, off = caret.startOffset;
      window.__line = () => { const r = document.createRange(); r.setStart(node, off); r.setEnd(node, Math.min(off + 1, node.length)); const l = r.getClientRects()[0] || r.getBoundingClientRect(); return l.top - n.getBoundingClientRect().top; };
      return window.__line();
    })()`);
    win.setSize(1000, 900); await delay(1200);
    const narrow = await js('window.__line()');
    win.setSize(1440, 900); await delay(1200);
    const wide = await js('window.__line()');
    assert.ok(Math.abs(narrow - before) <= LIMITS.drift, `narrowing moved the line ${Math.round(narrow - before)} px`);
    assert.ok(Math.abs(wide - before) <= LIMITS.drift, `widening moved the line ${Math.round(wide - before)} px`);
    checks.push('the reading position holds when the chat narrows and widens');
    fs.writeFileSync(path.join(output, 'chat-speed.png'), (await win.webContents.capturePage()).toPNG());

    assert.deepEqual(errors, [], 'Renderer console errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, open, typing, limits: LIMITS }, null, 2));
    for (const line of checks) console.log('ok - ' + line);
    console.log('PASS ' + output);
  } catch (error) {
    code = 1;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    console.error(error);
  } finally {
    win?.destroy();
    if (backend?.pid) require('node:child_process').spawnSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { stdio: 'ignore' });
    if (log) fs.closeSync(log);
    if (data) fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    exitAfterFlush(code);
  }
});
