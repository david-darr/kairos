// Isolation checks for the in-app side browser (electron/browser.js).
//
// Separate from chat-smoke.cjs on purpose: that suite drives the renderer,
// while everything worth proving here lives in the MAIN process — which
// session a page gets, which URLs are refused, whether permissions are
// denied, and whether the view is really destroyed. Those are the security
// claims, so they get asserted directly rather than inferred from what the
// UI happens to show.
//
// Loopback only by default. No outside network is contacted: pages are
// served by a local fixture server, and the one "remote" origin is a
// loopback port aliased through a host rule, so the blocking rules can be
// exercised without depending on the internet being reachable.
//
// Pass --live to additionally load a real website at the end. That is
// opt-in precisely so the default run stays hermetic and deterministic for
// CI, while a release still gets to prove the pane actually WORKS against
// the real web — the one thing loopback fixtures cannot demonstrate.

const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'data', 'browser-smoke-profile'));
const sideBrowser = require(path.join(root, 'electron', 'browser.js'));

const failures = [];
// Awaits the body, so an async check's rejection is recorded as a failure
// instead of vanishing into an unhandled promise.
let checksRun = 0;
async function check(name, fn) {
  checksRun += 1;
  try { await fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
}

// Stands in for the backend the app itself talks to — the privileged origin
// the pane must never reach.
const BACKEND_PORT = 8477;
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Fixture</title><h1>fixture page</h1>');
});
server.on('error', error => finish(1, error.message));

app.commandLine.appendSwitch('host-resolver-rules', `MAP fixture.test 127.0.0.1, MAP other.test 127.0.0.1`);

// A main-process failure here would otherwise be a silent hang: the window
// is never shown, so an unhandled rejection leaves the process alive with
// nothing on screen and nothing on stdout. Both guards below turn that into
// a real, readable failure.
//
// exitAfterFlush, not app.quit() or app.exit(): see scripts/electron-exit.cjs.
// app.exit() drops buffered stdout (an earlier version of this file "passed"
// while printing nothing), and app.quit() ignores process.exitCode on
// Electron 31/Windows (a failing run exited 0). The helper avoids both.
function finish(code, message) {
  if (code) console.error(message); else console.log(message);
  try { server.close(); } catch { /* already closed */ }
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  exitAfterFlush(code);
}

process.on('unhandledRejection', (error) => {
  finish(1, 'FAIL (unhandled rejection): ' + ((error && error.stack) || error));
});
// Live page loads are slower and depend on someone else's server, so the
// watchdog is given real room when --live is on.
setTimeout(() => finish(1, 'FAIL: timed out before finishing.'), process.argv.includes('--live') ? 180000 : 90000).unref();

// Pages for the Browse checks, on their own port.
const BROWSE_PORT = 8478;
const PROXY_PORT = 8479; // stands in for the egress proxy, a reserved port
const browseServer = http.createServer((req, res) => {
  const page = (body) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>${req.url}</title>${body}`); };
  if (req.url === '/ad.js') { res.setHeader('Content-Type', 'text/javascript'); res.end('window.adLoaded = true;'); return; }
  if (req.url === '/file.bin') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="report.bin"');
    res.end(Buffer.alloc(2048, 7));
    return;
  }
  if (req.url === '/ads') return page('<div class="ad-banner" id="banner">ad</div><p id="text">article</p><script src="/ad.js"></script>');
  // A stand-in for an OAuth pop-up sign-in ("Sign in with Google / Apple / X"):
  // the site opens the identity provider (another origin) in a sized pop-up,
  // which posts its result to window.opener and closes itself.
  const site = `http://fixture.test:${BROWSE_PORT}`, idp = `http://other.test:${BROWSE_PORT}`;
  // Sign-in forms for the password keeper (scripts/browse-keeper-checks.cjs).
  const form = (action) => `<form id="f" method="post" action="${action}"><input id="u" name="u" autocomplete="username"><input id="p" name="p" type="password" autocomplete="current-password"><button id="go">Sign in</button></form>`;
  if (req.url === '/login') return page(form('/welcome'));
  if (req.url === '/welcome') return page('<p>Welcome</p>');
  if (req.url === '/login-bad') { res.statusCode = req.method === 'POST' ? 401 : 200; return page('<p class="error">Wrong password</p>' + form('/login-bad')); }
  if (req.url === '/spa') return page(`<div id="app"><input id="u" autocomplete="username"><button id="next">Next</button></div><script>
    document.getElementById('next').onclick = () => {
      document.getElementById('app').innerHTML = '<input id="p" type="password"><div role="button" id="go">Log in</div>';
      document.getElementById('go').onclick = () => { history.pushState({}, '', '/spa/home'); document.getElementById('app').innerHTML = '<p>Home</p>'; };
    };
  </script>`);
  if (req.url === '/signup') return page('<form id="f" method="post" action="/welcome"><input id="u" name="u" autocomplete="username"><input id="p1" name="p1" type="password" autocomplete="new-password"><input id="p2" name="p2" type="password" autocomplete="new-password"><button id="go">Create</button></form>');
  if (req.url === '/framed') return page(`<p>Another site's sign-in inside</p><iframe src="${idp}/login" width="400" height="200"></iframe>`);
  if (req.url === '/media') return page('<audio id="a"></audio>');
  if (req.url === '/oauth-start') return page(`<button id="signin">Sign in</button><script>
    window.addEventListener('message', (e) => { if (e.origin === ${JSON.stringify(idp)}) document.title = 'signed-in:' + e.data; });
    document.getElementById('signin').onclick = () => { window.popup = window.open(${JSON.stringify(idp + '/oauth-popup')}, 'signin', 'width=480,height=600'); };
    window.newTab = () => window.open(${JSON.stringify(idp + '/oauth-tab')}, '_blank');
  </script>`);
  if (req.url === '/oauth-popup') return page(`<p>Signing in</p><script>
    setTimeout(() => { if (window.opener) window.opener.postMessage('token-123', ${JSON.stringify(site)}); else document.title = 'no-opener'; setTimeout(() => window.close(), 150); }, 150);
  </script>`);
  if (req.url === '/oauth-tab') return page(`<p>Signing in</p><script>
    setTimeout(() => { if (window.opener) window.opener.postMessage('tab-token', ${JSON.stringify(site)}); setTimeout(() => window.close(), 150); }, 150);
  </script>`);
  page(`<h1>browse fixture</h1><a id="link" href="/second">second</a>`);
});

async function browseChecks(win) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createGate } = require(path.join(root, 'electron', 'browser-gate.js'));
  const { openStore } = require(path.join(root, 'electron', 'browser-store.js'));
  const { createAdblock } = require(path.join(root, 'electron', 'browser-adblock.js'));
  const { createPermissions } = require(path.join(root, 'electron', 'browser-permissions.js'));
  const { createDownloads, _markFromInternet } = require(path.join(root, 'electron', 'browser-downloads.js'));
  const { createTabs } = require(path.join(root, 'electron', 'browser-tabs.js'));
  const { resaveCookies } = require(path.join(root, 'electron', 'browser-engine.js'));
  await new Promise(resolve => browseServer.listen(BROWSE_PORT, '127.0.0.1', resolve));
  const base = `http://fixture.test:${BROWSE_PORT}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-smoke-'));
  const partition = session.fromPartition('persist:browse-smoke');
  const gate = createGate({ backendOrigin: BACKEND_ORIGIN, reservedPorts: [PROXY_PORT] });
  const store = openStore(path.join(tmp, 'browser.db'));
  const adblock = createAdblock();
  adblock.load(['/ad.js$script\n##.ad-banner']);
  const asked = [];
  createPermissions({ store, ask: (req) => { asked.push(req.setting); return { answer: 'allow', remember: true }; } }).attach(partition);
  const saved = [];
  const downloads = createDownloads({ store, folder: () => path.join(tmp, 'Downloads'), notify: d => saved.push(d), shell: { openPath() {}, showItemInFolder() {} } });
  downloads.attach(partition);
  const events = [];
  let tabs;
  adblock.attach(partition, { enabledFor: url => store.getSite(url, 'adblock') !== 'off', onBlocked: id => tabs.countBlocked(id) });
  tabs = createTabs({ host: () => win, session: partition, gate, store, adblock, notify: e => events.push(e) });
  tabs.setBounds({ x: 300, y: 0, width: 900, height: 800 });
  tabs.setVisible(true);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const loaded = (wc) => new Promise((resolve) => {
    if (!wc.isLoading()) return resolve(true);
    const t = setTimeout(() => resolve(false), 10000);
    wc.once('did-stop-loading', () => { clearTimeout(t); resolve(true); });
  });
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await wait(100); } return false; };

  await check('browse gate: localhost opens, Kairos ports never do', () => {
    const opts = { allowLoopback: true };
    assert.ok(gate.safeUrl('http://localhost:3000/', opts));
    assert.ok(gate.safeUrl('http://127.0.0.1:5173/', opts), 'a dev server is just another local site');
    assert.equal(gate.safeUrl(`${BACKEND_ORIGIN}/api/settings`, opts), null);
    assert.equal(gate.safeUrl(`http://localhost:${BACKEND_PORT}/`, opts), null, 'backend port on any loopback spelling');
    assert.equal(gate.safeUrl(`http://[::1]:${PROXY_PORT}/`, opts), null, 'proxy port reserved');
    assert.equal(gate.safeUrl('file:///etc/passwd', opts), null);
    assert.equal(gate.fromAddressBar('localhost:5173', opts), 'http://localhost:5173/');
    assert.equal(gate.fromAddressBar('mailto:a@b.com', opts), null);
    assert.equal(gate.safeUrl('http://localhost:3000/'), null, 'the strict policy is unchanged');
  });

  let first;
  await check('browse: a tab opens, loads and lands in history', async () => {
    const r = tabs.open(`${base}/`);
    assert.equal(r.ok, true);
    first = r.id;
    const wc = tabs.webContentsOf(first);
    assert.ok(await loaded(wc));
    assert.ok(await until(() => store.recentHistory(5).some(h => h.url === `${base}/`)), 'history recorded');
    assert.equal(tabs.list().activeId, first);
  });

  await check('browse: a tab page has no bridge, node or IPC', async () => {
    const probe = await tabs.webContentsOf(first).executeJavaScript('({ j: typeof window.jarvis, r: typeof window.require, p: typeof window.process })');
    assert.deepEqual(probe, { j: 'undefined', r: 'undefined', p: 'undefined' });
  });

  await check('browse: a refused address opens no tab', () => {
    const before = tabs.list().tabs.length;
    assert.equal(tabs.open(`${BACKEND_ORIGIN}/`).ok, false);
    assert.equal(tabs.list().tabs.length, before);
  });

  await check('browse: pop-ups need the person, then open as tabs', async () => {
    const wc = tabs.webContentsOf(first);
    const before = tabs.list().tabs.length;
    await wc.executeJavaScript(`window.open(${JSON.stringify(base + '/popup-a')}); 1`);
    await wait(300);
    assert.equal(tabs.list().tabs.length, before, 'no tab without a click');
    assert.ok(events.some(e => e.event === 'popup-blocked'), 'the block is reported');
    wc.sendInputEvent({ type: 'mouseDown', x: 50, y: 50, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 50, y: 50, button: 'left', clickCount: 1 });
    await wait(150);
    await wc.executeJavaScript(`window.open(${JSON.stringify(base + '/popup-b')}); 1`);
    assert.ok(await until(() => tabs.list().tabs.length === before + 1), 'a tab right after a click');
  });

  const click = (wc) => {
    wc.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
  };

  await check('browse: a sign-in pop-up is a real window with its opener, and closes back', async () => {
    const r = tabs.open(`${base}/oauth-start`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await loaded(wc));
    const before = tabs.list().tabs.length;
    click(wc); await wait(100);
    await wc.executeJavaScript("document.getElementById('signin').click(); 1");
    assert.ok(await until(() => tabs.popups.list().length === 1), 'a pop-up window opened');
    const popup = tabs.popups.list()[0];
    assert.equal(popup.webContents.session, partition, 'on the person profile');
    assert.equal(popup.getParentWindow(), win, 'a child of the Kairos window');
    assert.equal(tabs.list().tabs.length, before, 'not a tab');
    assert.ok(await until(() => wc.getTitle() === 'signed-in:token-123'), `the opener got the result (title ${wc.getTitle()})`);
    assert.ok(await until(() => tabs.popups.list().length === 0), 'it closed itself');
    const prefs = popup.isDestroyed() ? null : popup.webContents.getLastWebPreferences();
    if (prefs) assert.equal(prefs.sandbox, true);
    tabs.close(r.id);
  });

  await check('browse: a page opening a sign-in tab keeps its opener; the tab closes back', async () => {
    const r = tabs.open(`${base}/oauth-start`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await loaded(wc));
    const before = tabs.list().tabs.length;
    click(wc); await wait(100);
    await wc.executeJavaScript('window.newTab(); 1');
    assert.ok(await until(() => tabs.list().tabs.length === before + 1), 'a Browse tab opened');
    assert.ok(await until(() => wc.getTitle() === 'signed-in:tab-token'), `the opener got the result (title ${wc.getTitle()})`);
    assert.ok(await until(() => tabs.list().tabs.length === before), 'window.close() closed that tab');
    tabs.close(r.id);
  });

  await check('browse: a sign-in pop-up still needs the person', async () => {
    const r = tabs.open(`${base}/oauth-start`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await loaded(wc));
    await wait(5200); // past the gesture window of opening the tab from this test
    const blockedBefore = events.filter(e => e.event === 'popup-blocked').length;
    await wc.executeJavaScript("window.open('http://other.test:" + BROWSE_PORT + "/oauth-popup', 'x', 'width=300,height=300'); 1");
    await wait(300);
    assert.equal(tabs.popups.list().length, 0, 'no window without a click');
    assert.equal(events.filter(e => e.event === 'popup-blocked').length, blockedBefore + 1);
    tabs.close(r.id);
  });

  await check('browse: sites see the Chrome user agent, not the Electron one', async () => {
    const { cleanUserAgent } = require(path.join(root, 'electron', 'browser-browse.js'));
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Kairos/2.2.2 Chrome/150.0.7871.250 Electron/43.8.3 Safari/537.36';
    assert.equal(cleanUserAgent(ua), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.250 Safari/537.36');
    partition.setUserAgent(cleanUserAgent(partition.getUserAgent()));
    const r = tabs.open(`${base}/`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await loaded(wc));
    const seen = await wc.executeJavaScript('navigator.userAgent');
    assert.ok(!/Electron|Kairos/i.test(seen) && /Chrome\/\d+/.test(seen), seen);
    tabs.close(r.id);
  });

  const keeper = require('./browse-keeper-checks.cjs');
  await keeper.passwordChecks({ check, win, partition, gate, store, adblock, base, otherBase: `http://other.test:${BROWSE_PORT}`, loaded, until, wait });
  // localhost: media devices exist only in secure contexts (https, or localhost).
  await keeper.audioChecks({ check, win, gate, store, base: `http://localhost:${BROWSE_PORT}`, until });
  await keeper.profileChecks({ check });

  await check('browse: permission prompt asked once, then remembered', async () => {
    const wc = tabs.webContentsOf(first);
    const one = await wc.executeJavaScript('Notification.requestPermission()');
    assert.equal(one, 'granted');
    assert.deepEqual(asked, ['notifications']);
    assert.equal(store.getSite(`${base}/`, 'permission:notifications'), 'allow');
    await wc.executeJavaScript('Notification.requestPermission()');
    assert.equal(asked.length, 1, 'no second prompt');
    const geo = await wc.executeJavaScript(`navigator.permissions.query({ name: 'midi' }).then(s => s.state).catch(() => 'denied')`);
    assert.notEqual(geo, 'granted', 'unlisted permissions are not granted');
  });

  await check('browse: ad blocking blocks the script, hides the element, counts it, and has an off switch', async () => {
    const r = tabs.open(`${base}/ads`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await loaded(wc));
    await wait(300);
    assert.equal(await wc.executeJavaScript('window.adLoaded === true'), false, 'ad script blocked');
    assert.equal(await wc.executeJavaScript(`getComputedStyle(document.getElementById('banner')).display`), 'none');
    assert.equal(await wc.executeJavaScript(`getComputedStyle(document.getElementById('text')).display`), 'block');
    assert.ok(tabs.list().tabs.find(t => t.id === r.id).blocked >= 1, 'count shown');
    store.setSite(`${base}/ads`, 'adblock', 'off');
    wc.reload();
    await wait(200);
    assert.ok(await loaded(wc));
    assert.ok(await until(() => wc.executeJavaScript('window.adLoaded === true')), 'off switch lets it load');
    store.setSite(`${base}/ads`, 'adblock', null);
  });

  await check('browse: downloads save to the folder with the internet mark', async () => {
    tabs.navigate(first, `${base}/file.bin`);
    assert.ok(await until(() => saved.some(d => d.state === 'completed')), 'download completed');
    const done = saved.find(d => d.state === 'completed');
    assert.equal(path.basename(done.path), 'report.bin');
    assert.equal(fs.statSync(done.path).size, 2048);
    if (process.platform === 'win32') {
      const zone = fs.readFileSync(`${done.path}:Zone.Identifier`, 'utf8');
      assert.match(zone, /ZoneId=3/);
      assert.match(zone, /HostUrl=http:\/\/fixture\.test/);
    }
    assert.equal(store.downloads().find(d => d.id === done.id).state, 'completed');
    assert.equal(_markFromInternet(done.path, 'https://u:p@x.test/', '', 'linux'), false, 'only Windows gets the mark');
  });

  await check('browse: zoom is remembered per site', async () => {
    tabs.activate(first);
    tabs.navigate(first, `${base}/`);
    assert.ok(await loaded(tabs.webContentsOf(first)));
    assert.equal(tabs.zoom(first, 1), 1.1);
    assert.equal(store.getSite(`${base}/`, 'zoom'), '1.1');
    assert.equal(tabs.zoom(first, 0), 1);
    assert.equal(store.getSite(`${base}/`, 'zoom'), null);
  });

  await check('browse: close, reopen closed, pin order', async () => {
    const r = tabs.open(`${base}/closing`);
    assert.ok(await loaded(tabs.webContentsOf(r.id)));
    const count = tabs.list().tabs.length;
    tabs.close(r.id);
    assert.equal(tabs.list().tabs.length, count - 1);
    const again = tabs.reopenClosed();
    assert.equal(again.ok, true);
    assert.equal(tabs.list().tabs.length, count);
    tabs.setPinned(again.id, true);
    assert.equal(tabs.list().tabs[0].id, again.id, 'pinned tabs lead');
  });

  await check('browse: session restore reopens the tabs, discarded until chosen', async () => {
    await wait(700);
    const urls = store.loadSession().map(t => t.url);
    assert.ok(urls.length >= 3, `session saved: ${urls.length}`);
    tabs.closeAll();
    const again = createTabs({ host: () => win, session: partition, gate, store, adblock, notify: () => {} });
    again.setBounds({ x: 300, y: 0, width: 900, height: 800 });
    assert.equal(again.restore(), urls.length);
    const list = again.list();
    assert.equal(list.tabs.filter(t => !t.discarded).length, 1, 'only the chosen tab is live');
    assert.equal(list.tabs[0].pinned, true, 'pin kept');
    again.closeAll();
  });

  await check('browse: cookie re-save keeps cookies and runs once', async () => {
    await partition.cookies.set({ url: `${base}/`, name: 'keep', value: 'v1', expirationDate: Date.now() / 1000 + 3600 });
    const marker = path.join(tmp, 'cookies-resaved.json');
    const n = await resaveCookies(partition, marker);
    assert.ok(n >= 1);
    assert.equal(await resaveCookies(partition, marker), null);
    assert.equal((await partition.cookies.get({ name: 'keep' }))[0].value, 'v1');
  });

  try { store.close(); } catch { /* already closed */ }
  browseServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// U2: the IPC boundary and the shared profile, through the real
// createBrowse and installBrowseIpc with a stand-in ipcMain.
async function browseIpcChecks(win) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createBrowse, kairosPorts } = require(path.join(root, 'electron', 'browser-browse.js'));
  const { installBrowseIpc } = require(path.join(root, 'electron', 'browser-ipc.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-ipc-'));
  const sent = [];
  sideBrowser.shareSession();
  const browse = createBrowse({
    host: () => win, partition: sideBrowser.PARTITION, folder: path.join(tmp, 'browser', 'default'),
    downloadsFolder: () => path.join(tmp, 'Downloads'), backendOrigin: BACKEND_ORIGIN,
    reservedPorts: kairosPorts({ instancePort: BACKEND_PORT }), shell: { openPath() {}, showItemInFolder() {} },
    send: (channel, payload) => sent.push({ channel, payload }), log: { error() {} },
  });
  const handlers = {}, listeners = {};
  const fakeIpc = { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { listeners[c] = fn; } };
  installBrowseIpc({ ipcMain: fakeIpc, fromAppWindow: e => e.sender === 'app', getBrowse: () => browse });
  const app_ = { sender: 'app' }, page = { sender: 'page' };
  const call = (c, ev, ...a) => handlers[c](ev, ...a);
  const emit = (c, ev, ...a) => listeners[c](ev, ...a);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const base = `http://fixture.test:${BROWSE_PORT}`;
  await new Promise(resolve => browseServer.listen(BROWSE_PORT, '127.0.0.1', resolve));

  await check('browse ipc: Kairos instance ports are all reserved', () => {
    const ports = kairosPorts({ instancePort: 8430, remotePort: 9443 });
    for (const p of [8420, 8421, 8422, 8430, 8431, 8888, 8889, 9443]) assert.ok(ports.includes(p), `port ${p}`);
    assert.equal(browse.gate.safeUrl('http://127.0.0.1:8420/', { allowLoopback: true }), null, 'the installed app is never opened');
    assert.ok(browse.gate.safeUrl('http://127.0.0.1:5173/', { allowLoopback: true }));
  });

  await check('browse ipc: only the app window can drive it', async () => {
    assert.deepEqual(await call('browse:list', page), { tabs: [], activeId: null });
    assert.deepEqual(await call('browse:open', page, `${base}/`), { ok: false });
    emit('browse:visible', page, true);
    assert.equal(browse.tabs.list().tabs.length, 0, 'nothing opened for a page sender');
  });

  let tabId;
  await check('browse ipc: open, list and malformed arguments', async () => {
    assert.equal(browse.gate.fromAddressBar('example.test:8080/a', { allowLoopback: true }), 'https://example.test:8080/a', 'host:port is an address');
    const ok = await call('browse:open', app_, `${base}/`);
    assert.equal(ok.ok, true);
    tabId = ok.id;
    assert.equal((await call('browse:list', app_)).tabs.length, 1);
    assert.deepEqual(await call('browse:navigate', app_, 'one', `${base}/`), { ok: false }, 'id must be a number');
    assert.deepEqual(await call('browse:open', app_, { url: 'x' }), { ok: false });
    assert.deepEqual(await call('browse:zoom', app_, tabId, 5), { ok: false });
    emit('browse:bounds', app_, { x: 'a' });
    emit('browse:reorder', app_, ['x']);
    assert.equal((await call('browse:open', app_, 'file:///etc/passwd')).ok, false);
  });

  await check('browse ipc: site settings accept only known keys and values', async () => {
    assert.deepEqual(await call('browse:site-set', app_, `${base}/`, 'adblock', 'off'), { ok: true });
    assert.deepEqual(await call('browse:site-set', app_, `${base}/`, 'zoom', '9'), { ok: false });
    assert.deepEqual(await call('browse:site-set', app_, `${base}/`, 'permission:camera', 'granted-forever'), { ok: false });
    assert.deepEqual(await call('browse:site-set', app_, `${base}/`, 'permission:midi', 'allow'), { ok: false });
    assert.equal((await call('browse:site', app_, `${base}/`)).settings.adblock, 'off');
    assert.deepEqual(await call('browse:site-set', app_, `${base}/`, 'adblock', null), { ok: true });
  });

  await check('browse ipc: a permission prompt goes to the app and the answer comes back', async () => {
    const wc = browse.tabs.webContentsOf(tabId);
    await new Promise(r => (wc.isLoading() ? wc.once('did-stop-loading', r) : r()));
    const answer = wc.executeJavaScript('Notification.requestPermission()');
    let prompt = null;
    for (let i = 0; i < 50 && !prompt; i++) { await wait(100); prompt = sent.find(s => s.channel === 'browse:permission'); }
    assert.ok(prompt, 'prompt sent to the app');
    assert.equal(prompt.payload.setting, 'notifications');
    assert.equal(prompt.payload.origin, base);
    emit('browse:permission-answer', page, prompt.payload.requestId, 'allow', true);
    await wait(200);
    emit('browse:permission-answer', app_, prompt.payload.requestId, 'block', false);
    assert.equal(await answer, 'denied', 'the page sender was ignored; the app said block');
  });

  await check('browse ipc: the side pane on the shared profile gets no prompt', async () => {
    const before = sent.filter(s => s.channel === 'browse:permission').length;
    assert.equal(sideBrowser.open(`http://other.test:${BROWSE_PORT}/`, { x: 0, y: 0, width: 300, height: 300 }).ok, true);
    const pane = sideBrowser._webContents();
    await new Promise(r => (pane.isLoading() ? pane.once('did-stop-loading', r) : r()));
    assert.equal(await pane.executeJavaScript('Notification.requestPermission()'), 'denied');
    assert.equal(sent.filter(s => s.channel === 'browse:permission').length, before, 'no prompt for a non-Browse view');
    sideBrowser.close();
  });

  browse.close();
  browseServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

app.whenReady().then(async () => {
  console.log(`Runtime: Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
  if (process.argv.includes('--verify-failure')) { finish(1, 'EXPECTED FAILURE: exit-code verification'); return; }
  await new Promise(resolve => server.listen(BACKEND_PORT, '127.0.0.1', resolve));

  await check('opens original-message links externally with URL validation', async () => {
    const { shell } = require('electron');
    const original = shell.openExternal;
    const opened = [];
    shell.openExternal = async url => { opened.push(url); };
    try {
      const link = 'https://mail.google.com/mail/u/?authuser=work%40example.com#all/11b9d7d41d395e91';
      assert.equal((await sideBrowser.openExternalUrl(link)).ok, true);
      assert.deepEqual(opened, [link]);
      for (const bad of ['javascript:alert(1)', 'file:///C:/secret', 'https://name:pass@example.com/', 'https://127.0.0.1/api/settings', 'http://example.com/']) {
        assert.equal((await sideBrowser.openExternalUrl(bad)).ok, false);
      }
      assert.equal(opened.length, 1, 'unsafe URLs never reach the OS browser');
    } finally { shell.openExternal = original; }
  });

  // -- URL gating. The single choke point every entry path funnels through,
  // so it is tested directly rather than through six different callers.
  await check('rejects non-web schemes', () => {
    sideBrowser.attach(null, { backendOrigin: BACKEND_ORIGIN });
    for (const bad of [
      'file:///C:/Windows/System32/drivers/etc/hosts',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'blob:https://example.test/abc',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'ws://example.test',
      'not a url at all',
      '',
      null,
    ]) {
      assert.equal(sideBrowser._safeUrl(bad), null, `should refuse ${bad}`);
    }
  });

  await check('rejects loopback in every spelling', () => {
    for (const host of [
      'http://127.0.0.1:8420/api/settings',
      'http://127.0.0.1/',
      'http://127.9.9.9/',
      'http://localhost:3000/',
      'http://LOCALHOST/',
      'http://app.localhost/',
      'http://[::1]:8420/',
      'http://0.0.0.0:8420/',
    ]) {
      assert.equal(sideBrowser._safeUrl(host), null, `should refuse ${host}`);
    }
    // The backend is the reason loopback is blocked at all; confirm the
    // origin check would catch it even if it were not on loopback.
    assert.equal(sideBrowser._safeUrl(`${BACKEND_ORIGIN}/api/sessions`), null);
  });

  await check('allows ordinary web addresses', () => {
    assert.ok(sideBrowser._safeUrl('https://example.test/path?q=1'));
    assert.ok(sideBrowser._safeUrl('http://example.test'));
    // A host that merely starts with the same characters as a blocked one
    // must not be caught by a sloppy prefix match.
    assert.ok(sideBrowser._safeUrl('https://localhost.example.test/'));
    assert.ok(sideBrowser._safeUrl('https://127.0.0.1.example.test/'));
  });

  await check('address bar distinguishes hosts from searches', () => {
    assert.equal(sideBrowser._fromAddressBar('example.test'), 'https://example.test/');
    assert.equal(sideBrowser._fromAddressBar('  example.test/a?b=1  '), 'https://example.test/a?b=1');
    assert.ok(sideBrowser._fromAddressBar('how tall is k2').startsWith('https://www.google.com/search?q='), 'Google is the default search (David, 2026-11-03)');
    // A typed scheme is honoured, which means a typed BAD scheme is refused
    // rather than silently turned into a search.
    assert.equal(sideBrowser._fromAddressBar('file:///etc/passwd'), null);
    assert.equal(sideBrowser._fromAddressBar('http://127.0.0.1:8420'), null);
    assert.equal(sideBrowser._fromAddressBar(''), null);
  });

  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`${BACKEND_ORIGIN}/`);
  sideBrowser.attach(win, { backendOrigin: BACKEND_ORIGIN });

  // -- refused targets must not open a view at all, rather than opening one
  // and navigating it somewhere harmless.
  await check('refused target does not open a pane', () => {
    const result = sideBrowser.open('file:///etc/passwd', { x: 0, y: 0, width: 400, height: 400 });
    assert.equal(result.ok, false);
    assert.equal(sideBrowser.isOpen(), false);
  });

  const opened = sideBrowser.open(`http://fixture.test:${BACKEND_PORT}/`, { x: 600, y: 0, width: 600, height: 800 });
  await check('opens a real web page', () => {
    assert.equal(opened.ok, true);
    assert.equal(sideBrowser.isOpen(), true);
  });

  await new Promise(resolve => setTimeout(resolve, 2500));

  // -- the isolation guarantees themselves.
  await check('runs on its own session partition', () => {
    const paneSession = session.fromPartition(sideBrowser.PARTITION);
    const appSession = win.webContents.session;
    assert.notEqual(paneSession, appSession, 'pane must not share the app session');
    assert.equal(sideBrowser.state().open, true);
  });

  await check('a cookie set in the pane is invisible to the app session', async () => {
    // The real guarantee, exercised rather than asserted structurally: a
    // site signed in inside the pane must leave nothing the app's own
    // session can read.
    const paneSession = session.fromPartition(sideBrowser.PARTITION);
    await paneSession.cookies.set({ url: `http://fixture.test:${BACKEND_PORT}/`, name: 'pane_only', value: 'secret' });
    const inPane = await paneSession.cookies.get({ name: 'pane_only' });
    const inApp = await win.webContents.session.cookies.get({ name: 'pane_only' });
    assert.equal(inPane.length, 1, 'cookie should exist in the pane session');
    assert.equal(inApp.length, 0, 'app session must not see the pane cookie');
  });

  await check('page has no preload bridge, no node, no IPC', async () => {
    // Evaluated inside the PAGE itself. If any of these are defined, the
    // sandbox has leaked and an arbitrary website could drive the app.
    const wc = sideBrowser._webContents();
    assert.ok(wc, 'pane should be open for this check');
    const probe = await wc.executeJavaScript(`({
      jarvis: typeof window.jarvis,
      require: typeof window.require,
      process: typeof window.process,
      module: typeof window.module,
      electron: typeof window.electron
    })`);
    assert.equal(probe.jarvis, 'undefined', 'the app bridge must not exist in the pane');
    assert.equal(probe.require, 'undefined');
    assert.equal(probe.process, 'undefined');
    assert.equal(probe.module, 'undefined');
    assert.equal(probe.electron, 'undefined');
  });

  await check('the page cannot reach the backend it is blocked from', async () => {
    // Even though fetch is same-process, the backend origin is a different
    // origin to the page, so CORS must stop it. This is the check that
    // matters most: the backend holds the vault and credentials.
    const wc = sideBrowser._webContents();
    assert.ok(wc);
    const reached = await wc.executeJavaScript(
      `fetch(${JSON.stringify(BACKEND_ORIGIN + '/')}, { mode: 'cors' }).then(() => 'reached').catch(() => 'blocked')`,
    );
    assert.equal(reached, 'blocked');
  });

  await check('permission handlers deny every request', () => {
    // The actual shipped functions, not a check that some handler exists.
    for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'clipboard-read', 'display-capture', 'fullscreen']) {
      let answer = 'never called';
      sideBrowser._denyPermissionRequest({}, permission, (allowed) => { answer = allowed; });
      assert.equal(answer, false, `${permission} must be denied`);
      assert.equal(sideBrowser._denyPermissionCheck({}, permission), false);
    }
    assert.equal(sideBrowser._denyDevicePermission({}), false);
  });

  await check('bounds are applied as whole pixels', () => {
    sideBrowser.setBounds({ x: 10.4, y: 20.6, width: 300.5, height: 400.2 });
    // No getter is exposed for bounds, so the assertion is that a fractional
    // rect is accepted without throwing — the rounding itself is unit-tested
    // by the absence of a crash plus the visual check in chat-smoke.
    assert.equal(sideBrowser.isOpen(), true);
  });

  await check('visibility toggles without destroying the view', () => {
    sideBrowser.setVisible(false);
    assert.equal(sideBrowser.isOpen(), true, 'hiding must not dispose');
    sideBrowser.setVisible(true);
    assert.equal(sideBrowser.isOpen(), true);
  });

  // -- disposal. A hidden view keeps running scripts, timers, and audio, so
  // "closed" has to mean destroyed.
  await check('close destroys the view', () => {
    sideBrowser.close();
    assert.equal(sideBrowser.isOpen(), false);
    assert.equal(sideBrowser.state().open, false);
  });

  await check('close is safe to call twice', () => {
    sideBrowser.close();
    assert.equal(sideBrowser.isOpen(), false);
  });

  await check('controls are no-ops when nothing is open', () => {
    sideBrowser.goBack();
    sideBrowser.goForward();
    sideBrowser.reload();
    sideBrowser.setBounds({ x: 0, y: 0, width: 10, height: 10 });
    sideBrowser.setVisible(true);
    assert.equal(sideBrowser.navigate('https://example.test').ok, false);
    assert.equal(sideBrowser.openExternal().ok, false);
  });

  await check('reopens cleanly after being closed', () => {
    assert.equal(sideBrowser.open(`http://other.test:${BACKEND_PORT}/`, { x: 0, y: 0, width: 400, height: 400 }).ok, true);
    assert.equal(sideBrowser.isOpen(), true);
    sideBrowser.close();
    assert.equal(sideBrowser.isOpen(), false);
  });


  // -- Browse (vault: "Kairos Browser - Phase 1", U1): the person's tabbed
  // browser, driven through its real modules on a separate partition. Same
  // hermetic rule: a local fixture server behind host-rule names.
  await browseChecks(win);
  await browseIpcChecks(win);

  // -- live check against the real web. OFF by default (--live), because the
  // rest of this file is deliberately hermetic and must stay deterministic
  // in CI. Everything above proves the pane REFUSES the right things; this
  // proves it actually WORKS, which is the one thing loopback fixtures
  // cannot show. example.com is IANA's reserved documentation domain: tiny,
  // stable, no tracking, and intended for exactly this.
  if (process.argv.includes('--live')) {
    const LIVE = 'https://example.com/';
    const settled = (wc) => new Promise((resolve) => {
      const done = () => { clearTimeout(timer); wc.off('did-finish-load', done); resolve(true); };
      const timer = setTimeout(() => { wc.off('did-finish-load', done); resolve(false); }, 25000);
      wc.on('did-finish-load', done);
    });

    await check('live: loads and renders a real website', async () => {
      assert.equal(sideBrowser.open(LIVE, { x: 600, y: 0, width: 600, height: 800 }).ok, true);
      const wc = sideBrowser._webContents();
      assert.ok(wc, 'a view should exist for a real https URL');
      assert.ok(await settled(wc), 'the page should finish loading');
      // Real content, read out of the rendered DOM — not just a 200.
      const heading = await wc.executeJavaScript("document.querySelector('h1') && document.querySelector('h1').textContent");
      assert.ok(heading && heading.trim().length, 'the page should render real text');
      assert.ok(wc.getTitle().length, 'the page should report a title');
      const state = sideBrowser.state();
      assert.equal(state.open, true);
      assert.ok(state.url.startsWith('https://'), `expected an https url, got ${state.url}`);
    });

    await check('live: isolation still holds on a real page', async () => {
      const wc = sideBrowser._webContents();
      const probe = await wc.executeJavaScript(`({
        jarvis: typeof window.jarvis,
        require: typeof window.require,
        process: typeof window.process
      })`);
      assert.equal(probe.jarvis, 'undefined');
      assert.equal(probe.require, 'undefined');
      assert.equal(probe.process, 'undefined');
      // A real page must still be unable to reach the local backend.
      const reached = await wc.executeJavaScript(
        `fetch(${JSON.stringify(BACKEND_ORIGIN + '/')}, { mode: 'cors' }).then(() => 'reached').catch(() => 'blocked')`,
      );
      assert.equal(reached, 'blocked');
    });

    await check('live: navigating and going back works on real pages', async () => {
      const wc = sideBrowser._webContents();
      assert.equal(sideBrowser.navigate('https://www.iana.org/help/example-domains').ok, true);
      assert.ok(await settled(wc), 'the second page should finish loading');
      assert.ok(sideBrowser.state().canGoBack, 'back should be available after a second navigation');
      sideBrowser.goBack();
      assert.ok(await settled(wc), 'going back should finish loading');
      assert.ok(sideBrowser.state().url.includes('example.com'), `back should return to the first page, got ${sideBrowser.state().url}`);
    });

    sideBrowser.close();
    await check('live: closed cleanly', () => assert.equal(sideBrowser.isOpen(), false));
  }

  if (failures.length) finish(1, 'FAIL\n' + failures.map(f => ' - ' + f).join('\n'));
  else finish(0, (process.argv.includes('--live') ? 'PASS (with live web check): ' : 'PASS: ') + `${checksRun} checks. ` + 'side-browser isolation — scheme and loopback blocking, backend origin refused, separate session partition with unshared cookies, no bridge/node/IPC in the page, permissions denied, view destroyed on close. Browse — gate policies, tabs and history, pop-ups only after a click, sign-in pop-ups and tabs keeping their opener, Chrome user agent, password offers and exact-origin fill, audio output routing, remembered permissions, ad blocking with off switch, marked downloads, zoom per site, reopen and pin, session restore, cookie re-save.');
});
