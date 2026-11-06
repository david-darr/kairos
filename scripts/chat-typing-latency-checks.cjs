// Typing in the chat composer must stay instant, and Send must put the user's
// own bubble on screen before any server round trip. Regression guard for the
// 2.2.0 report "what I type takes a long time to show". Real backend and
// Chromium on a throwaway data dir and a free port (never 8420 / 8430).
//
//   electron scripts/chat-typing-latency-checks.cjs [--measure]
//
// --measure prints the numbers and never fails (used to compare releases).
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const measureOnly = process.argv.includes('--measure');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-typing-ud-'));
app.setPath('userData', userData);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
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
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
const reply = i => `Reply ${i}\n\n## Heading ${i}\n\nSome **bold** text with \`code\` and a [link](https://example.test).\n\n- one\n- two\n\n\`\`\`js\nconst x = ${i};\nconsole.log(x);\n\`\`\`\n\n| a | b |\n| - | - |\n| ${i} | ${i + 1} |`;

app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-typing-'));
    fs.mkdirSync(path.join(data, 'vault'));
    log = fs.openSync(path.join(data, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR: data, JARVIS_VAULT_DIR: path.join(data, 'vault'), APP_PORT: String(port), JARVIS_INSTANCE: 'typinglat' };
    delete env.JARVIS_UI_SECRET;
    backend = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-X', 'utf8', '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    const until = Date.now() + 90000; let healthy = false;
    while (Date.now() < until) {
      assert.equal(backend.exitCode, null, 'Backend exited; see ' + path.join(data, 'backend.log'));
      try { healthy = (await fetch(base + '/api/health')).status === 200; } catch { /* starting */ }
      if (healthy) break;
      await delay(200);
    }
    assert.ok(healthy, 'Backend health timeout');
    await api('/api/settings/onboarding-complete', {});
    const session = await api('/api/sessions', {});
    for (let i = 0; i < 100; i++) {
      await api(`/api/sessions/${session.id}/messages`, { role: 'user', content: `Question number ${i}, please explain something.` });
      await api(`/api/sessions/${session.id}/messages`, { role: 'assistant', content: reply(i) });
    }
    win = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL(base + '/');
    await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay')?.classList.contains('hidden')");
    await js(`import('/static/js/app.js').then(m => m.switchTab('chat', { sessionId: ${JSON.stringify(session.id)} }))`);
    await waitFor("document.querySelectorAll('#chat-messages .msg').length >= 200");
    await delay(1500);

    // Instrument: handler cost per keystroke (window capture -> window bubble
    // around the textarea's own listeners) and keystroke -> next frame.
    await js(`(() => {
      const input = document.getElementById('chat-input');
      window.__lat = { handler: [], frame: [] };
      let t0 = 0;
      window.addEventListener('input', () => { t0 = performance.now(); }, true);
      window.addEventListener('input', () => {
        const done = performance.now(); window.__lat.handler.push(done - t0);
        requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => window.__lat.frame.push(performance.now() - t0); ch.port2.postMessage(0); });
      }, false);
      input.focus();
    })()`);
    const text = 'the quick brown fox jumps over the lazy dog again';
    for (const ch of text) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      await delay(60);
    }
    await delay(300);
    const typed = await js("document.getElementById('chat-input').value");
    assert.equal(typed, text, 'Real keystrokes reached the composer');
    const lat = await js('window.__lat');
    const handlerMedian = median(lat.handler), handlerMax = Math.max(...lat.handler);
    const frameMedian = median(lat.frame), frameMax = Math.max(...lat.frame);

    // Send: click -> the user's own bubble in the transcript.
    await js(`(() => {
      const messages = document.getElementById('chat-messages');
      window.__send = { t0: 0, shown: null };
      new MutationObserver(() => {
        if (window.__send.shown === null && window.__send.t0 && [...messages.querySelectorAll('.msg.user .msg-body')].some(n => (n._rawText || n.textContent).includes('${text}'))) window.__send.shown = performance.now() - window.__send.t0;
      }).observe(messages, { childList: true, subtree: true });
      const send = document.getElementById('chat-send');
      send.addEventListener('click', () => { window.__send.t0 = performance.now(); }, true);
      // A server that never answers: the bubble must not wait for it.
      const original = window.fetch;
      window.fetch = (...args) => /\\/api\\/chat\\/live$/.test(String(args[0]?.url || args[0])) ? new Promise(() => {}) : original.apply(window, args);
    })()`);
    await js("document.getElementById('chat-send').click()");
    await delay(1500);
    const sendMs = await js('window.__send.shown');

    const report = { handlerMedianMs: +handlerMedian.toFixed(2), handlerMaxMs: +handlerMax.toFixed(2), frameMedianMs: +frameMedian.toFixed(2), frameMaxMs: +frameMax.toFixed(2), sendToBubbleMs: sendMs === null ? null : +sendMs.toFixed(2), messages: 200 };
    console.log('MEASURE ' + JSON.stringify(report));
    if (!measureOnly) {
      assert.ok(handlerMax < 12, 'Per-keystroke handlers took ' + handlerMax.toFixed(1) + 'ms (limit 12ms)');
      assert.ok(frameMedian < 40, 'Keystroke to next frame median ' + frameMedian.toFixed(1) + 'ms (limit 40ms)');
      // Send-to-bubble is reported, not tightly asserted: with 200 messages it is ~220 ms in 2.2 against
      // ~19 ms in 2.1 (full transcript reflow, a mascot SVG per message), a separate and larger fix.
      assert.ok(sendMs !== null && sendMs < 1000, 'User bubble did not appear before the server answered: ' + sendMs);
      console.log('PASS typing latency');
    }
  } catch (error) {
    code = 1; console.error(error);
  } finally {
    win?.destroy();
    if (backend?.pid) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true });
      else backend.kill('SIGTERM');
      await delay(500);
    }
    if (log !== undefined) fs.closeSync(log);
    for (const folder of [data, userData]) if (folder) { try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch { /* best effort */ } }
    exitAfterFlush(code);
  }
});
