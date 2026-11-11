// Bots from chat (Kairos 2.3.0, 2026-11-11). The person asks the chat for a bot; the model calls create_bot
// (core/bot_maker_tools.py) and the chat shows the new bot's card with Open bot, Edit and Undo; the bot is in the
// Bots tab at the Ask level. Kip's conversation in the Bots tab shows the same card. Real backend fixture with a
// scripted model ("makebot NAME | ROLE" calls the real tool, scripts/cli_backend_fixture.py) and real Chromium,
// on a fresh port and data folder, isolated from every running Kairos.
//   node scripts/run-electron-test.cjs bots-from-chat-checks
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'bots-from-chat-review', 'run-' + Date.now());
fs.mkdirSync(path.join(output, 'userData'), { recursive: true });
app.setPath('userData', path.join(output, 'userData'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const checks = [], errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win, backend, data, log, base;
const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await js(code)) return; await delay(50); }
  throw new Error('Timed out: ' + code);
}
async function api(route, body, method) {
  const response = await fetch(base + route, body === undefined && !method ? {} : {
    method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
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
const shot = async name => fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());

app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-bots-from-chat-'));
    fs.mkdirSync(path.join(data, 'vault'));
    log = fs.openSync(path.join(output, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR: data, JARVIS_VAULT_DIR: path.join(data, 'vault'), APP_PORT: String(port), JARVIS_INSTANCE: 'botsfromchat' };
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

    win = new BrowserWindow({ width: 1440, height: 900, x: -3000, y: 0, show: true, skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3 && !/favicon.*404|Failed to load resource/i.test(message)) errors.push(message); });
    await win.loadURL(base + '/');
    await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay').classList.contains('hidden')");
    const nav = detail => js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: ${JSON.stringify(detail)} })); true`);

    // 1. Classic chat: ask for a bot.
    await nav({ tab: 'chat', sessionId: chat.id });
    await waitFor(`document.querySelector('#chat-messages')?.dataset.sessionId === ${JSON.stringify(chat.id)} && !!document.getElementById('chat-input')`);
    await js(`(() => { const i = document.getElementById('chat-input'); i.focus(); i.value = 'makebot Nova | Research bot'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await js("document.getElementById('chat-send').click(); true");
    await waitFor("[...document.querySelectorAll('#chat-messages .bot-made-card')].some(c => c.querySelector('.bot-made-name')?.textContent === 'Nova')", 30000);
    const card = await js(`(() => { const c = document.querySelector('#chat-messages .bot-made-card');
      return { role: c.querySelector('.bot-made-role').textContent, detail: c.querySelector('.bot-made-detail').textContent,
        buttons: [...c.querySelectorAll('.bot-made-actions button')].map(b => b.textContent), face: !!c.querySelector('.bot-made-face svg, .bot-made-face canvas, .bot-made-face *') }; })()`);
    assert.equal(card.role, 'Research bot');
    assert.match(card.detail, /Asks before it acts/);
    assert.deepEqual(card.buttons, ['Open bot', 'Edit', 'Undo']);
    assert.ok(card.face, 'the card shows the bot\'s Kip');
    await waitFor("/I made it/.test(document.querySelector('#chat-messages').textContent)", 15000);
    await delay(3000);  // the live view's refresh has run: the card sits above the reply, as it is saved
    const live = await js("(() => { const m = [...document.querySelectorAll('#chat-messages > *')]; return { cards: m.filter(n => n.classList.contains('bot-made-card')).length, card: m.findIndex(n => n.classList.contains('bot-made-card')), reply: m.findIndex(n => /I made it/.test(n.textContent) && !n.classList.contains('bot-made-card')) }; })()");
    assert.ok(live.cards === 1 && live.reply > live.card, 'live: one card, above the reply: ' + JSON.stringify(live));
    const agents = await api('/api/agents');
    const nova = agents.find(a => a.name === 'Nova');
    assert.ok(nova, 'the bot exists');
    assert.equal(nova.approval_mode, 'ask');
    assert.equal(nova.role, 'Research bot');
    checks.push('classic chat: the request made Nova at Ask, and its card shows the look, name, job and Open bot, Edit, Undo');
    await shot('classic-card');

    // The card stays after a reload (it is saved in the conversation, above the reply).
    await nav({ tab: 'home' }); await delay(300);
    await nav({ tab: 'chat', sessionId: chat.id });
    await waitFor("document.querySelectorAll('#chat-messages .bot-made-card').length === 1");
    const order = await js("(() => { const m = [...document.querySelectorAll('#chat-messages > *')]; const card = m.findIndex(n => n.classList.contains('bot-made-card')); const reply = m.findIndex(n => /I made it/.test(n.textContent) && !n.classList.contains('bot-made-card')); return { card, reply }; })()");
    assert.ok(order.card >= 0 && order.reply > order.card, 'the card sits above the reply: ' + JSON.stringify(order));
    checks.push('the card is saved with the conversation and opens again above the reply');

    // 2. Open bot: the Bots tab shows it.
    await js("document.querySelector('#chat-messages .bot-made-open').click(); true");
    await waitFor("document.querySelector('.bots-head-name')?.textContent === 'Nova'", 20000);
    checks.push('Open bot shows Nova in the Bots tab');
    await shot('bots-tab');

    // 3. Edit opens its settings.
    await nav({ tab: 'chat', sessionId: chat.id });
    await waitFor("!!document.querySelector('#chat-messages .bot-made-edit')");
    await js("document.querySelector('#chat-messages .bot-made-edit').click(); true");
    await waitFor("document.querySelector('.bots-head-name')?.textContent === 'Nova' && !!document.querySelector('#bots-panel:not([hidden]), .bots-panel')", 20000);
    checks.push('Edit opens Nova\'s settings');

    // 4. Kip's conversation in Bots mode shows the same card.
    const kipId = (await api('/api/agents')).find(a => a.builtin === 'front_desk')?.id;
    assert.ok(kipId, 'Kip is there');
    const listed = await api(`/api/agents/${kipId}/threads`);
    const kipThread = listed.main_id ? { id: listed.main_id } : listed.threads?.[0];
    if (kipThread) {
      await api('/api/sessions/' + kipThread.id + '/model', { model_endpoint_id: endpoint.id, model_override: null }).catch(() => null);
      await api('/api/chat/live', { session_id: kipThread.id, message: 'makebot Scout | Finds venues', attachment_ids: [], references: [], request_id: require('node:crypto').randomUUID() });
      for (const until = Date.now() + 30000; Date.now() < until;) {
        const run = (await api('/api/chat/live/snapshot')).runs?.[kipThread.id];
        if (run && run.status !== 'processing') break;
        await delay(50);
      }
      const scout = (await api('/api/agents')).find(a => a.name === 'Scout');
      assert.ok(scout, 'Kip made Scout');
      assert.equal(scout.approval_mode, 'ask');
      await nav({ tab: 'botsShell', agentId: kipId, sessionId: kipThread.id });
      await waitFor("[...document.querySelectorAll('.bot-made-card .bot-made-name')].some(n => n.textContent === 'Scout')", 20000);
      await js("[...document.querySelectorAll('button')].find(b => b.textContent === 'Not now')?.click(); true");
      await delay(400);
      await js("[...document.querySelectorAll('.bot-made-card')].find(c => c.querySelector('.bot-made-name').textContent === 'Scout').scrollIntoView({ block: 'center' }); true");
      await delay(300);
      checks.push('Kip\'s conversation in the Bots tab: the request made Scout at Ask and shows its card');
      await shot('kip-card');
    } else {
      throw new Error('Kip has no conversation to ask');
    }

    // 5. Undo removes the bot, after a confirmation, and the card says so.
    await nav({ tab: 'chat', sessionId: chat.id });
    await waitFor("!!document.querySelector('#chat-messages .bot-made-undo')");
    await js("document.querySelector('#chat-messages .bot-made-undo').click(); true");
    await waitFor("!!document.querySelector('.confirm-panel')");
    await js("[...document.querySelectorAll('.confirm-panel button')].find(b => b.textContent === 'Remove bot').click(); true");
    await waitFor("document.querySelector('#chat-messages .bot-made-card')?.dataset.state === 'removed'");
    assert.ok(!(await api('/api/agents')).some(a => a.name === 'Nova'), 'Nova is gone');
    await nav({ tab: 'home' }); await delay(300);
    await nav({ tab: 'chat', sessionId: chat.id });
    await waitFor("document.querySelector('#chat-messages .bot-made-card')?.dataset.state === 'removed' && document.querySelector('#chat-messages .bot-made-actions').hidden");
    checks.push('Undo asks, removes Nova, and the card reads Removed, also after reopening');
    await shot('undone');

    assert.deepEqual(errors, [], 'Renderer console errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks }, null, 2));
    for (const line of checks) console.log('ok - ' + line);
    console.log('PASS ' + output);
  } catch (error) {
    code = 1;
    try { if (win) await shot('failure'); } catch { /* no window */ }
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
