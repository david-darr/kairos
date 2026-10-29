// A05 (Part 2): the native side-browser view hides and restores around Settings and overlays, driven by the REAL
// renderer. electron-main-checks.cjs launches the real desktop app the same way; this one also attaches the main
// process inspector, so it can read the real WebContentsView's visible flag and bounds and count the IPC the
// renderer sends (electron/preload.js -> ipcMain "browser:visible" / "browser:bounds" -> electron/browser.js).
//
//   node scripts/side-browser-native-checks.cjs        (cwd = worktree; hold the shared Electron lock)
//
// Isolated named instance, temp profile, free ports. Never the installed app or the dev copy. No network: the page
// is a loopback fixture reached as site.test through a host-resolver rule.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = require(path.join(ROOT, 'electron', 'node_modules', 'electron'));
const NAME = 'part2a05';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-a05-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function until(probe, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 20000);
      this.waiting.set(id, msg => { clearTimeout(timer); resolve(msg); }); this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const { result } = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result?.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const SITE_PORT = 8481;
const site = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Fixture page</title><h1>fixture</h1>'); });

// Main-process side: wrap the real side browser's setVisible/setBounds (ipcMain calls them by property, so the
// wrapper sees every renderer request), and read the native view's real state.
const INSTALL = `(() => {
  const m = process.mainModule; const { BrowserWindow } = m.require('electron');
  const sb = m.require(${JSON.stringify(path.join(ROOT, 'electron', 'browser.js'))});
  if (globalThis.__a05) return 'already';
  const log = globalThis.__a05 = { calls: [] };
  for (const name of ['setVisible', 'setBounds']) {
    const real = sb[name];
    sb[name] = (...args) => { log.calls.push({ name, arg: args[0], at: Date.now() }); return real(...args); };
  }
  return 'installed';
})()`;
const VIEW = `(() => {
  const { BrowserWindow } = process.mainModule.require('electron');
  const win = BrowserWindow.getAllWindows().find(w => w.contentView.children.length);
  if (!win) return null;
  const view = win.contentView.children.find(c => c.webContents);
  if (!view) return null;
  return { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL(), children: win.contentView.children.length };
})()`;
const CALLS = `JSON.stringify(globalThis.__a05.calls)`;
const RESET = `(globalThis.__a05.calls.length = 0, true)`;

(async () => {
  let app; let page; let main; let failed = false;
  const results = {}; const bugs = [];
  try {
    await new Promise(resolve => site.listen(SITE_PORT, '127.0.0.1', resolve));
    const port = await freePort(); const debugPort = await freePort(); const inspectPort = await freePort();
    const env = { ...process.env, JARVIS_PORT: String(port) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'JARVIS_INSTANCE', 'JARVIS_DATA_DIR', 'JARVIS_UI_SECRET']) delete env[key];
    app = spawn(ELECTRON, [path.join(ROOT, 'electron'), `--instance=${NAME}`, `--user-data-dir=${profile}`, '--background',
      `--remote-debugging-port=${debugPort}`, `--inspect=${inspectPort}`, '--host-resolver-rules=MAP site.test 127.0.0.1'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.log = ''; app.stdout.on('data', d => { app.log += d; }); app.stderr.on('data', d => { app.log += d; });
    await until(() => fetch(`http://127.0.0.1:${port}/api/health`).then(r => r.ok), 120000, 'backend health');
    const target = await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json()))
      .find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${port}`)), 60000, 'the main window page');
    page = await Cdp.connect(target.webSocketDebuggerUrl);
    main = await Cdp.connect((await until(async () => (await fetch(`http://127.0.0.1:${inspectPort}/json/list`).then(r => r.json()))[0], 30000, 'the main inspector')).webSocketDebuggerUrl);

    // Skip first-run setup through the app's own API, then load the real app shell.
    await page.evaluate("fetch('/api/settings/onboarding-complete', { method: 'POST' }).then(r => r.status)");
    await page.evaluate('location.reload()').catch(() => {}); await sleep(1500);
    const shellReady = () => page.evaluate("!!document.querySelector('.sidebar-settings-btn') && !!document.querySelector('.nav-item[data-tab=chat]')");
    await until(shellReady, 60000, 'the app shell').catch(async () => { await page.evaluate('location.reload()').catch(() => {}); await until(shellReady, 60000, 'the app shell after a second reload'); });
    assert.equal(await page.evaluate('typeof window.jarvis?.browser?.setVisible'), 'function', 'the real preload bridge is present');
    assert.equal(await main.evaluate(INSTALL), 'installed');

    const click = selector => page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing ${selector}'); e.click(); return true; })()`);
    const view = async () => JSON.parse(await main.evaluate(`JSON.stringify(${VIEW})`));
    const calls = async () => JSON.parse(await main.evaluate(CALLS));
    const visibleNow = async () => (await view())?.visible ?? null;
    const settled = async (want, what) => { await until(async () => (await visibleNow()) === want, 5000, what); };
    const key = (type, k) => page.send('Input.dispatchKeyEvent', { type, key: k, code: k === 'Escape' ? 'Escape' : undefined });

    // -- open the side browser through the UI: chat tab, overflow menu, Browse the web.
    await click('.nav-item[data-tab=chat]');
    await until(() => page.evaluate("!!document.querySelector('#overflow-plus-btn')"), 20000, 'the chat composer');
    await click('#overflow-plus-btn');
    await page.evaluate("[...document.querySelectorAll('.overflow-menu-item')].find(b => b.textContent.includes('Browse the web')).click()");
    await until(() => page.evaluate("!!document.querySelector('.browser-panel .browser-viewport')"), 10000, 'the browser panel');
    // BUG probe: the menu opens the pane with an empty address. Typing an address must then load it.
    const submit = url => page.evaluate(`(() => { const f = document.querySelector('.browser-address-form'); f.querySelector('input').value = ${JSON.stringify(url)}; f.requestSubmit(); return true; })()`);
    await submit(`http://site.test:${SITE_PORT}/`);
    const loadedFromBlank = await until(async () => (await view())?.url?.startsWith(`http://site.test:${SITE_PORT}`), 4000, 'blank pane navigation').catch(() => false);
    if (!loadedFromBlank) {
      const status = await page.evaluate("document.querySelector('.browser-status')?.textContent");
      bugs.push(`Browse the web (blank pane) then typing an address does not load it: native view ${JSON.stringify(await view())}, pane status ${JSON.stringify(status)}`);
      console.log('BUG: ' + bugs.at(-1));
      // Continue with the same entry the app uses for links in replies: an explicit URL.
      await page.evaluate(`import('/static/js/browserPane.js').then(m => m.openBrowser('http://site.test:${SITE_PORT}/'))`);
    }
    await until(async () => (await view())?.bounds?.width > 50 && (await view()).url.startsWith(`http://site.test:${SITE_PORT}`), 15000, 'the fixture page in the native view');
    // The pane slides in, so compare once the layout has settled (the page must end up on the viewport).
    const viewportRect = async () => JSON.parse(await page.evaluate("JSON.stringify((() => { const r = document.querySelector('.browser-viewport').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })())"));
    const onViewport = async () => { const b = (await view()).bounds, r = await viewportRect(); return Math.abs(b.x - Math.round(r.x)) <= 1 && Math.abs(b.y - Math.round(r.y)) <= 1 && Math.abs(b.width - Math.round(r.width)) <= 1; };
    await until(onViewport, 3000, 'the native view settled on the pane viewport').catch(() => {});
    const base = await view();
    assert.equal(base.visible, true, 'the native view is visible once the pane is open');
    const panelRect = await viewportRect();
    assert.ok(Math.abs(base.bounds.x - Math.round(panelRect.x)) <= 1 && Math.abs(base.bounds.width - Math.round(panelRect.width)) <= 1, `native bounds ${JSON.stringify(base.bounds)} follow the pane's viewport ${JSON.stringify(panelRect)}`);
    console.log('PASS: Browse the web opens a live native view at the pane viewport', JSON.stringify(base.bounds));

    // One open/close cycle with round-trip measurement. `act` runs in the renderer; the main log gives the
    // number of IPC requests and when the hide / restore actually reached the native view.
    const cycle = async (label, open, close, { dismissKey } = {}) => {
      await main.evaluate(RESET);
      const t0 = Date.now(); await open(); const tOpen = Date.now();
      await settled(false, `${label}: native view hidden`);
      const hiddenAfter = Date.now() - t0;
      const during = await view();
      const callsOpen = await calls();
      await main.evaluate(RESET);
      const t1 = Date.now(); await close(); await settled(true, `${label}: native view restored`);
      const restoredAfter = Date.now() - t1;
      const after = await view();
      const callsClose = await calls();
      assert.equal(during.visible, false, `${label}: hidden while open`);
      assert.equal(after.visible, true, `${label}: visible again after close`);
      assert.deepEqual(after.bounds, base.bounds, `${label}: same bounds after restore`);
      assert.equal(after.url, base.url, `${label}: same page after restore`);
      const hides = callsOpen.filter(c => c.name === 'setVisible');
      const shows = callsClose.filter(c => c.name === 'setVisible');
      assert.deepEqual(hides.map(c => c.arg), [false], `${label}: exactly one hide request on open (got ${JSON.stringify(callsOpen)})`);
      assert.deepEqual(shows.map(c => c.arg), [true], `${label}: exactly one restore request on close (got ${JSON.stringify(callsClose)})`);
      results[label] = { openMs: hiddenAfter, closeMs: restoredAfter, ipcOpen: callsOpen.length, ipcClose: callsClose.length,
        hideIpcLatencyMs: hides[0].at - t0, showIpcLatencyMs: shows[0].at - t1, uiOpenMs: tOpen - t0 };
      console.log(`PASS: ${label}: hidden then restored with identical bounds`, JSON.stringify(results[label]));
    };

    // 1. Settings via the real gear button; close via its own Close control.
    await cycle('settings-window',
      async () => { await click('.sidebar-settings-btn'); await until(() => page.evaluate("!!document.querySelector('.settings-window') && !document.querySelector('.settings-window').closest('.hidden')"), 10000, 'Settings'); },
      async () => { await page.evaluate("(() => { const w = document.querySelector('.settings-window'); const b = [...w.querySelectorAll('button')].find(x => /close/i.test(x.getAttribute('aria-label') || x.title || x.textContent)); if (!b) throw new Error('no close button'); b.click(); return true; })()"); });

    // 2. Settings minimized: the page behind is meant to be visible again; the pill restores Settings (hidden again).
    await click('.sidebar-settings-btn');
    await until(() => page.evaluate("!!document.querySelector('.settings-window') && !document.querySelector('.settings-window').closest('.hidden')"), 10000, 'Settings');
    await settled(false, 'minimize: hidden under Settings');
    await page.evaluate("(() => { const w = document.querySelector('.settings-window'); [...w.querySelectorAll('button')].find(x => /minimi[sz]e/i.test(x.getAttribute('aria-label') || x.title || x.textContent)).click(); return true; })()");
    await settled(true, 'minimize: native view returns while Settings is a pill');
    assert.deepEqual((await view()).bounds, base.bounds, 'minimize: same bounds');
    await click('.settings-minimized-pill');
    await settled(false, 'minimize: pill reopens Settings and hides the view again');
    await page.evaluate("(() => { const w = document.querySelector('.settings-window'); [...w.querySelectorAll('button')].find(x => /close/i.test(x.getAttribute('aria-label') || x.title || x.textContent)).click(); return true; })()");
    await settled(true, 'minimize: closing restores');
    assert.deepEqual((await view()).bounds, base.bounds, 'minimize: same bounds after the whole sequence');
    console.log('PASS: Settings minimize / pill / close keep the native view in step with what is on screen');

    // 3. Image preview overlay over the pane (a staged chat image), closed with Escape.
    await page.evaluate(`(() => { const input = [...document.querySelectorAll('input[type=file]')].find(i => !i.id);
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([png], 'a05.png', { type: 'image/png' })); input.files = dt.files;
      input.dispatchEvent(new Event('change')); return true; })()`);
    await until(() => page.evaluate("!!document.querySelector('.attach-chip-preview-button')"), 15000, 'the staged image chip');
    await cycle('image-preview',
      async () => { await click('.attach-chip-preview-button'); await until(() => page.evaluate("!!document.querySelector('.chat-image-preview')"), 5000, 'image preview'); },
      async () => { await key('keyDown', 'Escape'); await key('keyUp', 'Escape'); await until(() => page.evaluate("!document.querySelector('.chat-image-preview')"), 5000, 'preview closed'); });

    // 4. Nested: Settings over an image preview. Depth counting: closing one must not reveal the page under the other.
    await click('.attach-chip-preview-button');
    await settled(false, 'nested: hidden by the preview');
    await click('.sidebar-settings-btn');
    await until(() => page.evaluate("!!document.querySelector('.settings-window') && !document.querySelector('.settings-window').closest('.hidden')"), 10000, 'Settings over preview');
    await page.evaluate("(() => { const b = [...document.querySelector('.chat-image-preview').querySelectorAll('button')].find(x => x.textContent === 'Close'); b.click(); return true; })()");
    await sleep(400);
    assert.equal(await visibleNow(), false, 'nested: closing the preview while Settings is open keeps the native view hidden');
    await page.evaluate("(() => { const w = document.querySelector('.settings-window'); [...w.querySelectorAll('button')].find(x => /close/i.test(x.getAttribute('aria-label') || x.title || x.textContent)).click(); return true; })()");
    await settled(true, 'nested: both closed, restored');
    assert.deepEqual((await view()).bounds, base.bounds, 'nested: same bounds');
    console.log('PASS: nested Settings + preview use a depth count (no early reveal), restored with identical bounds');

    // 5. Pane resize drag (real mouse events on the real divider): hidden while dragging, restored at the NEW bounds.
    const handle = JSON.parse(await page.evaluate("JSON.stringify((() => { const r = document.querySelector('.chat-pane-resizer').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 150 }; })())"));
    const mouse = params => page.send('Input.dispatchMouseEvent', params);
    await main.evaluate(RESET);
    await mouse({ type: 'mousePressed', ...handle, button: 'left', clickCount: 1 });
    await mouse({ type: 'mouseMoved', x: handle.x - 60, y: handle.y, button: 'left', buttons: 1 });
    await settled(false, 'drag: native view hidden during the divider drag');
    await mouse({ type: 'mouseMoved', x: handle.x - 120, y: handle.y, button: 'left', buttons: 1 });
    await mouse({ type: 'mouseReleased', x: handle.x - 120, y: handle.y, button: 'left', clickCount: 1 });
    await settled(true, 'drag: native view restored after the drag');
    await sleep(400);
    const dragged = await view();
    const newRect = JSON.parse(await page.evaluate("JSON.stringify((() => { const r = document.querySelector('.browser-viewport').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })())"));
    assert.notEqual(dragged.bounds.width, base.bounds.width, 'drag: the pane really resized');
    assert.ok(Math.abs(dragged.bounds.x - Math.round(newRect.x)) <= 1 && Math.abs(dragged.bounds.width - Math.round(newRect.width)) <= 1, `drag: restored view ${JSON.stringify(dragged.bounds)} matches the new viewport ${JSON.stringify(newRect)}`);
    const dragVis = (await calls()).filter(c => c.name === 'setVisible').map(c => c.arg);
    assert.deepEqual(dragVis, [false, true], 'drag: one hide and one restore request for the whole drag');
    results.dragResize = { ipc: await calls().then(c => c.length), visibleRequests: dragVis, from: base.bounds.width, to: dragged.bounds.width };
    console.log('PASS: divider drag hides the native view and restores it at the new bounds', JSON.stringify(results.dragResize));
    base.bounds = dragged.bounds;

    // 6. Overlays over the pane area. Each must hide the native view (it paints above HTML); probes report which do not.
    const probes = {};
    const overlapsNative = selector => page.evaluate(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(x => x.getClientRects().length); if (!e) return null; const r = e.getBoundingClientRect(); const n = ${JSON.stringify(base.bounds)};
      return r.width > 0 && r.left < n.x + n.width && r.right > n.x && r.top < n.y + n.height && r.bottom > n.y; })()`);
    const probe = async (label, selector, open, close) => {
      await main.evaluate(RESET);
      await open(); await sleep(600);
      const shown = await overlapsNative(selector);
      probes[label] = { overlayShown: shown !== null, overlapsNativeArea: shown, nativeVisibleWhileOverlayOpen: await visibleNow(), paneStillOpen: await page.evaluate("!!document.querySelector('.browser-panel')"), hideRequests: (await calls()).filter(c => c.name === 'setVisible' && c.arg === false).length };
      await close(); await sleep(300);
      if (!(await page.evaluate("!!document.querySelector('.browser-panel')"))) await page.evaluate(`import('/static/js/browserPane.js').then(m => m.openBrowser('http://site.test:${SITE_PORT}/'))`).then(() => sleep(800));
    };
    const ctrlK = type => page.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 });
    await probe('command palette (Ctrl+K)', '.palette-backdrop:not(.hidden) .palette-panel',
      async () => { await page.evaluate('document.activeElement && document.activeElement.blur()'); await ctrlK('rawKeyDown'); await ctrlK('keyUp'); },
      async () => { await key('keyDown', 'Escape'); await key('keyUp', 'Escape'); });
    await probe('Integrations modal (composer menu)', '.modal-backdrop:not(.hidden) .modal-panel, .workspace-modal:not(.hidden) .modal-panel',
      async () => { await click('#overflow-plus-btn'); await page.evaluate("[...document.querySelectorAll('.overflow-menu-item')].find(b => b.textContent.includes('Integrations')).click()"); },
      async () => { await key('keyDown', 'Escape'); await key('keyUp', 'Escape'); });
    results.probes = probes;
    console.log('PROBES ' + JSON.stringify(probes));
    for (const [label, p] of Object.entries(probes)) {
      if (p.overlayShown && p.overlapsNativeArea && p.nativeVisibleWhileOverlayOpen) bugs.push(`${label} covers the native pane area but the native view stays visible (hide requests: ${p.hideRequests}); it paints over the overlay`);
    }

    // 7. Close the browser pane through its own control: view destroyed.
    await click('.browser-panel [aria-label="Close browser"]');
    await until(async () => (await view()) === null || !(await view()).url.startsWith('http://site.test'), 10000, 'the view to go away');
    console.log('PASS: closing the pane removes the native view');
    console.log('RESULTS ' + JSON.stringify(results));
    if (bugs.length) throw new Error('BUGS FOUND: ' + bugs.join(' | '));
    console.log('PASS: native side-browser view hides/restores around Settings and overlays, driven by the real renderer.');
  } catch (error) {
    failed = true; console.error(error.stack);
    try { console.error('VIEWDBG ' + await main.evaluate(`JSON.stringify(${VIEW})`)); } catch (e) { console.error('VIEWDBG err ' + e.message); }
    try { console.error('RAW ' + await main.evaluate(`JSON.stringify(process.mainModule.require('electron').BrowserWindow.getAllWindows().map(w => ({t: w.getTitle(), kids: w.contentView.children.map(c => ({keys: Object.keys(c).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(c))).join(','), wc: !!c.webContents}))})))`)); } catch (e) { console.error('RAW err ' + e.message); }
    try { console.error('PAGE ' + await page.evaluate("JSON.stringify({text: document.body.innerText.slice(0, 300), nav: [...document.querySelectorAll('[data-tab]')].map(e => e.tagName + '.' + e.className + ':' + e.dataset.tab).slice(0, 30), settings: !!document.querySelector('.sidebar-settings-btn')})")); } catch { /* page gone */ }
    if (app?.log) console.error('--- app output (last 2000 chars) ---\n' + app.log.slice(-2000));
    console.error('RESULTS ' + JSON.stringify(results));
  } finally {
    page?.close(); main?.close(); site.close();
    if (app && app.exitCode === null) { spawn('taskkill', ['/T', '/F', '/PID', String(app.pid)], { stdio: 'ignore' }); await sleep(2000); }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch (e) { console.error('Left profile: ' + e.message); }
    process.exit(failed ? 1 : 0);
  }
})();
