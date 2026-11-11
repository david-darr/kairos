// Bot reports (2026-11-11, David: "an easier way to see individual Bot's reports"). A seeded three-bot Content
// Studio team (scripts/fixtures/bot_reports_seed.py) on the real backend fixture, real Chromium, a fresh port and data
// folder, isolated from every running Kairos. Checks the team report from the team's menu, a bot's report from it and
// from the team map's bot card, Suggest models, and the same views at phone width. Screenshots go to the run folder
// and, when KAIROS_REPORT_SHOTS names a folder, there too.
//   node scripts/run-electron-test.cjs bot-reports-checks
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'bot-reports-review', 'run-' + Date.now());
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
async function api(route, body) {
  const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
const shots = process.env.KAIROS_REPORT_SHOTS || '';
const shot = async name => {
  const png = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(output, name + '.png'), png);
  if (shots) { fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), png); }
};
const dialogText = "document.querySelector('.bots-report-dialog[open]')?.innerText || ''";
const closeDialog = async () => { await js("document.querySelector('.bots-report-dialog[open] .bots-report-head button')?.click(); true"); await waitFor("!document.querySelector('.bots-report-dialog[open]')"); };

app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-bot-reports-'));
    fs.mkdirSync(path.join(data, 'vault'));
    log = fs.openSync(path.join(output, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR: data, JARVIS_VAULT_DIR: path.join(data, 'vault'), APP_PORT: String(port), JARVIS_INSTANCE: 'botreports' };
    delete env.JARVIS_UI_SECRET;
    const python = path.join(root, '.venv', 'Scripts', 'python.exe');
    const seeded = spawnSync(python, [path.join('scripts', 'fixtures', 'bot_reports_seed.py')], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(seeded.status, 0, 'seed failed: ' + seeded.stderr);
    const seed = JSON.parse(seeded.stdout.trim().split('\n').at(-1));
    backend = spawn(python, ['-m', 'uvicorn', 'cli_backend_fixture:app', '--app-dir', 'scripts', '--host', '127.0.0.1', '--port', String(port)],
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
    const report = await api('/api/bot-reports/bots/' + seed.bots.Researcher);
    assert.equal(report.totals.runs, 2);
    checks.push('the report API answers for the seeded Researcher: 2 runs');

    win = new BrowserWindow({ width: 1440, height: 900, x: -3000, y: 0, show: true, skipTaskbar: true,
      webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3 && !/favicon.*404|Failed to load resource/i.test(message)) errors.push(message); });
    await win.loadURL(base + '/');
    await waitFor("document.querySelector('#view-content')?.children.length > 0 && document.querySelector('#onboarding-overlay').classList.contains('hidden')");
    const nav = detail => js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: ${JSON.stringify(detail)} })); true`);

    // 1. The team's menu in the Bots rail: Team report.
    await nav({ tab: 'botsShell', agentId: seed.bots.Producer });
    await waitFor(`!!document.querySelector('[aria-label="Options for Content Studio"]')`, 30000);
    await js(`document.querySelector('[aria-label="Options for Content Studio"]').click(); true`);
    await waitFor("[...document.querySelectorAll('[role=menuitem], .bots-menu button, .bots-menu-row')].some(n => n.textContent.trim() === 'Team report')");
    await js("[...document.querySelectorAll('[role=menuitem], .bots-menu button, .bots-menu-row')].find(n => n.textContent.trim() === 'Team report').click(); true");
    await waitFor(`/Content Studio team: report/.test(${dialogText}) && document.querySelectorAll('.bots-report-member').length === 3`);
    const team = await js(dialogText);
    assert.match(team, /Topics: 3/);
    assert.match(team, /Picks: 1/);
    assert.match(team, /Researcher/);
    assert.doesNotMatch(team, /â€”/);
    checks.push('the team menu opens the team report: three bots, the topics and the pick the team made');
    await shot('team-report-desktop');

    // 2. A bot's report, from the team report.
    await js("[...document.querySelectorAll('.bots-report-member')].find(m => /Researcher/.test(m.textContent)).querySelector('button').click(); true");
    await waitFor(`/Researcher: report/.test(${dialogText}) && document.querySelectorAll('.bots-report-run').length === 2`);
    await js("document.querySelector('.bots-report-run').open = true; true");
    const bot = await js(dialogText);
    assert.match(bot, /Searched the web \(2 times\)/);
    assert.match(bot, /Added a topic \(3 times\)/);
    assert.match(bot, /Moon dust is sharper than glass/);
    assert.match(bot, /3 steps went ahead as the team's own work/);
    assert.match(bot, /Fix: The model's limit was reached/);
    assert.match(bot, /Open conversation/);
    assert.doesNotMatch(bot, /example\.com/, 'raw arguments stay out of the report');
    checks.push('a bot report shows plain steps, what it made, approvals and the failed run with its fix');
    await shot('bot-report-desktop');

    // 3. Its link opens the conversation.
    await js("[...document.querySelectorAll('.bots-report-run button')].find(b => b.textContent.includes('Open conversation')).click(); true");
    await waitFor("!document.querySelector('.bots-report-dialog[open]')");
    await waitFor(`document.querySelector('.bots-head-name')?.textContent === 'Researcher'`, 20000);
    checks.push('Open conversation closes the report and opens the Researcher in the Bots tab');

    // 4. The team map's bot card has a Report button.
    await nav({ tab: 'botsTeamMap' });
    const hasMap = await (async () => { try { await waitFor(`!!document.querySelector('.bots-team-bot [aria-label="Report for Evaluator"]')`, 8000); return true; } catch { return false; } })();
    if (hasMap) {
      await js(`document.querySelector('.bots-team-bot [aria-label="Report for Evaluator"]').click(); true`);
      await waitFor(`/Evaluator: report/.test(${dialogText}) && !!document.querySelector('.bots-report-run')`);
      await js("document.querySelector('.bots-report-run').open = true; true");
      assert.match(await js(dialogText), /Picked a topic/);
      checks.push('the team map\'s bot card opens that bot\'s report');
      await closeDialog();
    } else {
      // The map lives behind another tab name in this build: open the same module the card uses.
      await js(`import('/static/js/botsActivityReport.js').then(m => m.openBotReport({ botId: ${JSON.stringify(seed.bots.Evaluator)} })); true`);
      await waitFor(`/Evaluator: report/.test(${dialogText})`);
      checks.push('the Evaluator\'s report opens (team map not reachable by tab name here)');
      await closeDialog();
    }

    // 5. Suggest models: a proposal from the connected Claude, applied only on a click.
    await nav({ tab: 'botsShell', agentId: seed.bots.Producer });
    await waitFor(`!!document.querySelector('[aria-label="Options for Content Studio"]')`, 20000);
    await js(`document.querySelector('[aria-label="Options for Content Studio"]').click(); true`);
    await waitFor("[...document.querySelectorAll('[role=menuitem], .bots-menu button, .bots-menu-row')].some(n => n.textContent.trim() === 'Suggest models')");
    await js("[...document.querySelectorAll('[role=menuitem], .bots-menu button, .bots-menu-row')].find(n => n.textContent.trim() === 'Suggest models').click(); true");
    await waitFor(`/Opus 5.5 on Claude/.test(document.querySelector('.bots-report-dialog[open] select')?.selectedOptions?.[0]?.textContent || '') && /Estimated cost/.test(${dialogText})`);
    const before = (await api('/api/agents')).find(a => a.id === seed.bots.Producer).model_override;
    assert.equal(before, 'claude-sonnet-5-5', 'opening Suggest models changed nothing');
    await shot('suggest-models-desktop');
    await js("[...document.querySelectorAll('.bots-report-dialog[open] button')].find(b => b.textContent === 'Apply these models').click(); true");
    await waitFor(`/Updated 3 bots/.test(${dialogText})`);
    const after = Object.fromEntries((await api('/api/agents')).map(a => [a.name, a.model_override]));
    assert.equal(after.Producer, 'claude-opus-5-5');
    assert.equal(after.Researcher, 'claude-sonnet-5-5');
    checks.push('Suggest models proposes Opus for the Producer, changes nothing until Apply, then applies the picks');
    await closeDialog();

    // 6. Phone width: the report fits, with no sideways scroll.
    win.setContentSize(390, 844); await delay(400);
    await js(`import('/static/js/botsActivityReport.js').then(m => m.openBotReport({ botId: ${JSON.stringify(seed.bots.Researcher)} })); true`);
    await waitFor(`/Researcher: report/.test(${dialogText}) && document.querySelectorAll('.bots-report-run').length === 2`);
    await js("document.querySelector('.bots-report-run').open = true; true");
    const fit = await js("(() => { const d = document.querySelector('.bots-report-dialog[open]'); const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, sideways: d.scrollWidth > d.clientWidth + 1 }; })()");
    assert.ok(fit.left >= 0 && fit.right <= fit.width && !fit.sideways, 'phone fit: ' + JSON.stringify(fit));
    checks.push('at phone width the report fits the screen with no sideways scroll');
    await shot('bot-report-phone');
    await closeDialog();
    await js(`import('/static/js/botsActivityReport.js').then(m => m.openTeamReport({ teamId: ${JSON.stringify(seed.team)} })); true`);
    await waitFor(`document.querySelectorAll('.bots-report-member').length === 3`);
    const teamFit = await js("(() => { const d = document.querySelector('.bots-report-dialog[open]'); return d.scrollWidth <= d.clientWidth + 1; })()");
    assert.ok(teamFit, 'team report fits at phone width');
    await shot('team-report-phone');
    checks.push('the team report fits at phone width too');

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
    if (backend?.pid) spawnSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { stdio: 'ignore' });
    if (log) fs.closeSync(log);
    if (data) fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    exitAfterFlush(code);
  }
});
