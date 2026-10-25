// Headless Chrome, never Electron. Reuse ui-smoke's isolated fixture server
// and mobile-tabs-checks' actual header assertions at both iPhone sizes.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(r => setTimeout(r, ms));
const output = path.join(root, 'data', 'ui-review', 'phone-headers-' + Date.now());
fs.mkdirSync(output, { recursive: true });

async function main() {
  let source = fs.readFileSync(path.join(__dirname, 'ui-smoke.cjs'), 'utf8');
  source = source.slice(0, source.indexOf('app.commandLine.appendSwitch'))
    .replace('const { app, BrowserWindow, session } = require("electron");', '')
    .replace("const { exitAfterFlush } = require('./electron-exit.cjs');", '');
  const harness = new Module(path.join(__dirname, 'phone-header-fixtures.cjs'), module);
  harness.filename = path.join(__dirname, 'phone-header-fixtures.cjs');
  harness.paths = Module._nodeModulePaths(__dirname);
  harness._compile(source + '\nmodule.exports = { server, errors };', harness.filename);
  const { server, errors } = harness.exports;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const profile = path.join(output, 'profile');
  let socket, chrome;
  try {
    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', data => process.stderr.write(data));
    await new Promise((resolve, reject) => { chrome.once('spawn', resolve); chrome.once('error', reject); });
    const active = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !fs.existsSync(active); i++) await delay(100);
    const port = fs.readFileSync(active, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    };
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
    });
    const js = async expression => {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 150; i++) { if (await js(expression)) return; await delay(100); }
      throw new Error('Timed out: ' + expression);
    };
    await cdp('Network.enable');
    await cdp('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost:*'] });
    await cdp('Page.navigate', { url: base });
    await waitFor("!!document.querySelector('.dashboard-content.is-filled')");
    await js("import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#f3eadb' }))");
    const checks = fs.readFileSync(path.join(__dirname, 'mobile-tabs-checks.cjs'), 'utf8');
    const start = checks.indexOf('  const titleRow =');
    const end = checks.indexOf('  for (const [name, w, layout', start);
    let assertions = 0;
    const titleRow = new Function('js', 'ok', checks.slice(start, end) + '\nreturn titleRow;')(js, (value, message) => { assertions++; assert.ok(value, message); });
    const navigate = async (tab, options = {}) => {
      await js(`import('/static/js/app.js').then(m => m.switchTab(${JSON.stringify(tab)}, ${JSON.stringify(options)}))`);
      await delay(550);
    };
    for (const [width, height, safeTop] of [[393, 852, 59], [390, 844, 47]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: height - safeTop, deviceScaleFactor: 1, mobile: false });
      await js(`document.documentElement.style.cssText += ';--ms-page-height:${height}px;--native-safe-top:${safeTop}px;--native-safe-bottom:34px;--ms-ios-nudge:12px'`);
      for (const tab of ['home', 'notes', 'calendar', 'email', 'tasks', 'cookbook', 'school', 'tool-store', 'agents', 'forgeHome']) {
        await navigate(tab);
        await titleRow(`${width}×${height}: ${tab}`, safeTop + 12 + (['home', 'agents'].includes(tab) ? 6 : 18));
      }
      for (const section of ['all', 'vault', 'documents', 'google', 'designs']) {
        await navigate('library', { section });
        await titleRow(`${width}×${height}: Library ${section}`, safeTop + 30);
      }
      await js("document.querySelector('.design-card').click()");
      await waitFor("!!document.querySelector('.design-page-identity h2')"); await delay(550);
      await titleRow(`${width}×${height}: Library design view`, safeTop + 30);
      for (const [name, section] of [['design', null], ['designs', 'designs']]) {
        if (section) await navigate('library', { section });
        const shot = await cdp('Page.captureScreenshot');
        fs.writeFileSync(path.join(output, `${width}-${name}.png`), Buffer.from(shot.data, 'base64'));
      }
    }
    assert.deepEqual(errors, [], 'Fixture errors');
    console.log(`PASS: ${assertions} header assertions at 393×852 and 390×844. Screenshots: ${output}`);
  } finally {
    socket?.close();
    chrome?.kill(); // Only the child process owned by this test, by PID.
    server.closeAllConnections(); server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
