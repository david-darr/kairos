// A01 launch and lifetime of the real desktop app (Part 2, 2026-10-27): the
// actual electron/main.js and backend, as an isolated named instance with its
// own temp profile, port and single-instance lock. Never the installed app or
// the dev copy. Driven over the DevTools protocol; records launch timings.
//
//   node scripts/electron-main-checks.cjs
//
// Not covered here (needs a person at the desktop): clicking the tray icon and
// its menu, and Open in browser opening the default browser.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'electron', 'node_modules', 'electron'));
const NAME = 'part2check';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-main-check-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function until(probe, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

class Cdp {
  static async connect(url) {
    const cdp = new Cdp(); cdp.ws = new WebSocket(url); cdp.id = 0; cdp.waiting = new Map();
    cdp.ws.onmessage = ({ data }) => { const msg = JSON.parse(data); cdp.waiting.get(msg.id)?.(msg); cdp.waiting.delete(msg.id); };
    await new Promise((resolve, reject) => { cdp.ws.onopen = resolve; cdp.ws.onerror = reject; });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise(resolve => { this.waiting.set(id, resolve); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const { result } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result?.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

function launch({ port, debugPort, background = true, extra = [] }) {
  const args = [path.join(ROOT, 'electron'), `--instance=${NAME}`, `--user-data-dir=${profile}`, ...(background ? ['--background'] : []),
    ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []), ...extra];
  const env = { ...process.env, JARVIS_PORT: String(port) };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'JARVIS_INSTANCE', 'JARVIS_DATA_DIR', 'JARVIS_UI_SECRET']) delete env[key];
  // No windowsHide: Windows would apply it to the app's first ShowWindow and
  // turn the window's own show() into a hide. Electron is a GUI app; no console appears.
  const child = spawn(ELECTRON, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', d => { child.log += d; });
  child.stderr.on('data', d => { child.log += d; });
  child.exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  return child;
}

// Electron reports document.visibilityState "visible" even for a window never
// shown, so ask Windows whether the app process owns a visible top-level window.
const VISIBLE_WINDOWS = `
Add-Type -Namespace K -Name W -MemberDefinition @'
public delegate bool P(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(P f, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetWindowTextLength(System.IntPtr h);
'@
$target = [uint32]$args[0]; $script:n = 0
[K.W]::EnumWindows({ param($h, $l) $p = 0; [void][K.W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq $target -and [K.W]::IsWindowVisible($h) -and [K.W]::GetWindowTextLength($h) -gt 0) { $script:n++ }; $true }, [IntPtr]::Zero) | Out-Null
$script:n`;
const windowShown = pid => {
  const out = require('node:child_process').spawnSync('powershell', ['-NoProfile', '-Command', `& { ${VISIBLE_WINDOWS} } ${Number(pid)}`], { encoding: 'utf8' });
  return Number(out.stdout.trim()) > 0;
};
const health = port => fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok).catch(() => false);
const mainPage = (debugPort, port) => until(async () => {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json());
  return targets.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port}`));
}, 120000, 'the main window page');

// The first usable screen: Home, or onboarding on a profile that has never been set up.
const USABLE = `(() => {
  const view = document.querySelector('#view-content');
  if (document.querySelector('.onboarding-card')?.getClientRects().length) return 'onboarding';
  return view?.children.length && !view.textContent.includes('Loading...') && document.querySelector('#nav .nav-item[data-tab=home]') ? 'home' : '';
})()`;

async function startAndMeasure(label, ctx) {
  ctx.port = await freePort(); ctx.debugPort = await freePort();
  const started = Date.now();
  ctx.app = launch({ port: ctx.port, debugPort: ctx.debugPort });
  await until(() => health(ctx.port), 120000, `${label} backend health`);
  const healthMs = Date.now() - started;
  ctx.page = await Cdp.connect((await mainPage(ctx.debugPort, ctx.port)).webSocketDebuggerUrl);
  const screen = await until(() => ctx.page.evaluate(USABLE), 60000, `${label} first usable screen`).catch(async error => {
    const seen = await ctx.page.evaluate("document.body?.innerText.slice(0, 400)").catch(() => '(page unreadable)');
    throw new Error(`${error.message}; the window showed: ${JSON.stringify(seen)}`);
  });
  const usableMs = Date.now() - started;
  ctx.timings = { healthMs, usableMs, screen };
  console.log(`${label}: backend healthy ${healthMs} ms, ${screen} usable ${usableMs} ms`);
  return ctx;
}

async function quit({ app, port, debugPort, page }) {
  page?.close();
  const browser = await Cdp.connect((await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r => r.json())).webSocketDebuggerUrl);
  browser.send('Browser.close');
  const code = await Promise.race([app.exited, sleep(30000).then(() => 'still running')]);
  browser.close();
  return { code, backendDown: await until(async () => !(await health(port)), 20000, 'the backend to stop').catch(() => false) };
}

(async () => {
  let current;
  const timings = {};
  try {
    // Cold launch: an empty profile.
    current = {}; await startAndMeasure('cold launch', current);
    timings.cold = current.timings;
    assert.ok(fs.existsSync(path.join(profile, 'data')), 'the backend keeps its data inside the isolated profile');
    assert.equal(windowShown(current.app.pid), false, '--background starts with the window hidden');
    const note = await current.page.evaluate("fetch('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'part2 relaunch marker' }) }).then(r => r.status)");
    assert.equal(note, 200, 'the app window can save through its own backend');

    // A second launch hands over to the first and exits.
    const second = launch({ port: current.port, background: false });
    const secondCode = await Promise.race([second.exited, sleep(30000).then(() => 'still running')]);
    assert.equal(secondCode, 0, 'a second launch exits instead of starting another copy');
    await until(() => windowShown(current.app.pid), 10000, 'the first window to show itself');
    assert.equal(await health(current.port), true, 'the first copy keeps serving');
    console.log('PASS: a second launch reveals the running window and exits');

    // Closing the window hides it; the app and backend keep running.
    await current.page.evaluate("window.close(), true").catch(() => {});
    await until(() => !windowShown(current.app.pid), 10000, 'the window to hide');
    assert.equal(current.app.exitCode, null, 'closing the window does not quit');
    assert.equal(await health(current.port), true, 'the backend keeps serving after the window closes');
    console.log('PASS: closing the window keeps Kairos running in the tray');

    // Quit: the app exits and stops its backend.
    const stopped = await quit(current);
    assert.equal(stopped.code, 0, `quitting exits cleanly (got ${stopped.code})`);
    assert.equal(stopped.backendDown, true, 'quitting stops the backend');
    current = null;
    console.log('PASS: quitting stops the app and its backend');

    // Warm relaunch on the same profile keeps the data.
    current = {}; await startAndMeasure('warm launch', current);
    timings.warm = current.timings;
    const kept = await current.page.evaluate("fetch('/api/notes').then(r => r.json()).then(list => list.some(n => (n.text || '').includes('part2 relaunch marker')))");
    assert.equal(kept, true, 'a relaunch keeps what was saved');
    await quit(current); current = null;
    console.log('PASS: relaunch keeps the saved data');
    console.log('TIMINGS ' + JSON.stringify(timings));
    console.log('PASS: real app launch, single instance, close to tray, quit and relaunch.');
  } catch (error) {
    console.error(error.stack);
    if (current?.app?.log) console.error('--- app output (last 3000 chars) ---\n' + current.app.log.slice(-3000));
    process.exitCode = 1;
  } finally {
    if (current?.app && current.app.exitCode === null) {
      // Ours alone, by PID, whole tree.
      spawn('taskkill', ['/T', '/F', '/PID', String(current.app.pid)], { stdio: 'ignore' });
      await sleep(2000);
    }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
    catch (error) { console.error('Left the temp profile behind: ' + error.message); }
  }
})();
