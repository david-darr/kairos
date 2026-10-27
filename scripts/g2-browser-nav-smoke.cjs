// g2 (A05): the side browser's navigation, history, reload and cookie behaviour on loopback fixtures, with
// no network. browser-smoke.cjs proves what the pane REFUSES and only checks back/forward against the real web
// under --live; this proves they work offline. Run:
//   electron/node_modules/electron/dist/electron.exe scripts/g2-browser-nav-smoke.cjs   (cwd = worktree)
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'data', 'g2-browser-nav-profile'));
const sideBrowser = require(path.join(root, 'electron', 'browser.js'));
const failures = [];
const check = async (name, fn) => { try { await fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
const hits = [];
const APP_PORT = 8478, SITE_PORT = 8479;
const site = http.createServer((req, res) => {
  hits.push({ path: req.url, cookie: req.headers.cookie || '' });
  if (req.url.startsWith('/set')) res.setHeader('Set-Cookie', 'visit=1; Path=/');
  if (req.url === '/redirect-out') { res.writeHead(302, { Location: 'file:///C:/Windows/win.ini' }); res.end(); return; }
  if (req.url === '/redirect-in') { res.writeHead(302, { Location: '/b' }); res.end(); return; }
  res.setHeader('Content-Type', 'text/html');
  const name = req.url.split(/[?#]/)[0].slice(1) || 'home';
  res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1><a id=top href="#top">top</a>`);
});
const appServer = http.createServer((_q, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>App</title>'); });
const finish = (code, message) => {
  if (code) console.error(message); else console.log(message);
  try { site.close(); appServer.close(); } catch { /* closed */ }
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  exitAfterFlush(code);
};
process.on('unhandledRejection', error => finish(1, 'FAIL (unhandled rejection): ' + ((error && error.stack) || error)));
setTimeout(() => finish(1, 'FAIL: timed out'), 90000).unref();
app.commandLine.appendSwitch('host-resolver-rules', 'MAP site.test 127.0.0.1');

app.whenReady().then(async () => {
  await new Promise(resolve => site.listen(SITE_PORT, '127.0.0.1', resolve));
  await new Promise(resolve => appServer.listen(APP_PORT, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(`http://127.0.0.1:${APP_PORT}/`);
  const errors = [];
  sideBrowser.attach(win, { backendOrigin: `http://127.0.0.1:${APP_PORT}`, notify: () => {} });
  win.webContents.on('ipc-message', () => {});
  const bounds = { x: 600, y: 0, width: 600, height: 800 };
  const origin = `http://site.test:${SITE_PORT}`;
  const loaded = () => new Promise(resolve => {
    const wc = sideBrowser._webContents();
    const done = () => { clearTimeout(timer); wc.off('did-stop-loading', done); resolve(true); };
    const timer = setTimeout(() => { wc.off('did-stop-loading', done); resolve(false); }, 8000);
    wc.on('did-stop-loading', done);
  });
  const settle = async () => { for (let i = 0; i < 60; i++) { const s = sideBrowser.state(); if (s.open && !s.loading && s.url) return s; await new Promise(r => setTimeout(r, 100)); } return sideBrowser.state(); };

  await check('open loads the page and reports url and title', async () => {
    assert.equal(sideBrowser.open(`${origin}/set-a`, bounds).ok, true);
    const state = await settle();
    assert.equal(state.url, `${origin}/set-a`);
    assert.equal(state.title, 'Page set-a');
    assert.equal(state.canGoBack, false, 'nothing to go back to on the first page');
    assert.equal(state.canGoForward, false);
  });
  await check('navigate adds history; a bare path-less address is normalised only when valid', async () => {
    const next = sideBrowser.navigate(`${origin}/b`);
    assert.equal(next.ok, true);
    const state = await settle();
    assert.equal(state.url, `${origin}/b`);
    assert.equal(state.canGoBack, true, 'back is available after a second page');
    assert.equal(state.canGoForward, false);
  });
  await check('the cookie set by page A is sent to page B in the pane session', async () => {
    assert.ok(hits.find(h => h.path === '/b')?.cookie.includes('visit=1'), JSON.stringify(hits));
  });
  await check('back and forward move through history and update state', async () => {
    sideBrowser.goBack();
    let state = await settle();
    for (let i = 0; i < 30 && !state.url.endsWith('/set-a'); i++) { await new Promise(r => setTimeout(r, 100)); state = await settle(); }
    assert.equal(state.url, `${origin}/set-a`, 'back returns to the first page');
    assert.equal(state.canGoBack, false);
    assert.equal(state.canGoForward, true);
    assert.equal(state.title, 'Page set-a');
    sideBrowser.goForward();
    state = await settle();
    for (let i = 0; i < 30 && !state.url.endsWith('/b'); i++) { await new Promise(r => setTimeout(r, 100)); state = await settle(); }
    assert.equal(state.url, `${origin}/b`, 'forward returns to the second page');
    assert.equal(state.canGoForward, false);
  });
  await check('reload fetches the page again and keeps the url', async () => {
    const before = hits.filter(h => h.path === '/b').length;
    sideBrowser.reload();
    await settle(); await new Promise(r => setTimeout(r, 400));
    assert.equal(hits.filter(h => h.path === '/b').length, before + 1, 'reload makes one new request');
    assert.equal(sideBrowser.state().url, `${origin}/b`);
  });
  await check('an in-page anchor changes the url without a new request', async () => {
    const before = hits.length;
    await sideBrowser._webContents().executeJavaScript("document.getElementById('top').click(); true");
    await new Promise(r => setTimeout(r, 300));
    assert.equal(hits.length, before, 'no new request for an in-page jump');
    assert.ok(sideBrowser.state().url.endsWith('/b#top'));
  });
  await check('a redirect inside the allowed origin is followed', async () => {
    sideBrowser.navigate(`${origin}/redirect-in`);
    let state = await settle();
    for (let i = 0; i < 30 && !state.url.endsWith('/b'); i++) { await new Promise(r => setTimeout(r, 100)); state = await settle(); }
    assert.equal(state.url, `${origin}/b`);
  });
  await check('a redirect to a refused scheme never leaves the pane on it', async () => {
    sideBrowser.navigate(`${origin}/redirect-out`);
    await new Promise(r => setTimeout(r, 1200));
    const state = sideBrowser.state();
    assert.ok(!/^file:/i.test(state.url), 'the pane must not land on file: (' + state.url + ')');
  });
  await check('a refused address leaves the page and history untouched', async () => {
    sideBrowser.navigate(`${origin}/a`); await settle();
    const before = sideBrowser.state();
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', `http://127.0.0.1:${APP_PORT}/`, 'http://localhost:1/']) {
      const result = sideBrowser.navigate(bad);
      assert.equal(result.ok, false, bad);
    }
    const after = sideBrowser.state();
    assert.equal(after.url, before.url);
    assert.equal(after.canGoBack, before.canGoBack);
  });
  await check('hide and show keep the page, history and cookies (Settings/overlay path)', async () => {
    const before = sideBrowser.state();
    sideBrowser.setVisible(false);
    assert.equal(sideBrowser.isOpen(), true, 'hiding does not dispose');
    sideBrowser.setBounds({ x: 10.4, y: 20.6, width: 500.2, height: 300.7 });
    sideBrowser.setVisible(true);
    const after = sideBrowser.state();
    assert.equal(after.url, before.url);
    assert.equal(after.canGoBack, before.canGoBack, 'history survives a hide/show');
    const view = win.contentView.children.at(-1);
    assert.deepEqual(view.getBounds(), { x: 10, y: 21, width: 500, height: 301 }, 'bounds are rounded to whole pixels');
  });
  await check('the pane session cookie is not visible to the app session', async () => {
    const appCookies = await win.webContents.session.cookies.get({});
    assert.equal(appCookies.filter(c => c.name === 'visit').length, 0);
    const paneCookies = await session.fromPartition(sideBrowser.PARTITION).cookies.get({});
    assert.equal(paneCookies.filter(c => c.name === 'visit').length, 1);
  });
  await check('close destroys the view and clears navigation state; reopen starts with no history', async () => {
    sideBrowser.close();
    assert.equal(sideBrowser.isOpen(), false);
    assert.deepEqual(sideBrowser.state(), { open: false });
    sideBrowser.open(`${origin}/fresh`, bounds); const s = await settle();
    assert.equal(s.canGoBack, false, 'a reopened pane has a new history');
    sideBrowser.close();
  });

  if (failures.length) finish(1, 'FAIL\n' + failures.map(f => ' - ' + f).join('\n'));
  else finish(0, 'PASS: side browser open, navigate, back/forward, reload, in-page anchor, redirects (allowed and refused), refused addresses, hide/show with rounded bounds, cookie isolation and close, offline on loopback.');
});
