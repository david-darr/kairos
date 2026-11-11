// The account switcher in real Chromium against the real backend (accounts on, a throwaway data folder, a fresh
// loopback port; never 8420/8430). Signs two accounts in on one window (the second through "Add another account"),
// switches with the toggle and with Ctrl+Shift+2, checks the colour changes and each account sees only its own
// notes, asks a PIN, and signs one account out leaving the other. Screenshots go to the Kairos Media samples folder.
//   set JARVIS_ELECTRON_BINARY=...\electron.exe && node scripts/run-electron-test.cjs account-switcher-checks
const { app, BrowserWindow } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'data', 'account-switcher-review', 'run-' + Date.now());
const samples = process.env.KAIROS_SWITCHER_SHOTS || path.join(os.homedir(), 'Documents', 'Kairos Media', 'samples', 'account-switcher');
fs.mkdirSync(path.join(output, 'userData'), { recursive: true });
fs.mkdirSync(samples, { recursive: true });
app.setPath('userData', path.join(output, 'userData'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const checks = [], errors = [];
const ok = message => { checks.push(message); console.log('ok - ' + message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const PASS = { ana: 'ana-password-1', ben: 'ben-password-2' };
const MARK = { ana: 'ANA-NOTE-' + Date.now(), ben: 'BEN-NOTE-' + Date.now() };
let win, backend, data, log, base;
const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(code, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { if (await js(code)) return; } catch { /* the page is reloading */ } await delay(80); }
  throw new Error('Timed out: ' + code);
}
async function shot(name) {
  await delay(450);
  const png = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(output, name + '.png'), png);
  fs.writeFileSync(path.join(samples, name + '.png'), png);
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.ok(port !== 8420 && port !== 8430);
  return port;
}
// The node side signs in like another device would, to set the accounts up.
async function call(route, { body, cookie, method } = {}) {
  const response = await fetch(base + route, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', 'X-Kairos-Switch': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  assert.ok(response.ok, route + ': ' + response.status + ' ' + text);
  const session = (response.headers.getSetCookie?.() || []).find(c => c.startsWith('jarvis_session='));
  return { json: text ? JSON.parse(text) : null, cookie: session ? session.split(';')[0] : cookie };
}
const status = () => js(`fetch('/api/auth/status').then(r => r.json())`);
const accountColor = () => js(`getComputedStyle(document.documentElement).getPropertyValue('--account-color').trim()`);
const token = color => js(`getComputedStyle(document.documentElement).getPropertyValue('--acct-${color}').trim()`);
async function signInOnCard(name) {
  await waitFor(`!!document.querySelector('.welcome-auth-card input[autocomplete=current-password]')`);
  await js(`(() => { const card = document.querySelector('.welcome-auth-card');
    const user = card.querySelector('input[autocomplete=username]'), pass = card.querySelector('input[autocomplete=current-password]');
    user.value = ${JSON.stringify(name)}; pass.value = ${JSON.stringify(PASS[name])};
    [...card.querySelectorAll('button')].find(b => b.textContent === 'Log In').click(); })()`);
}
async function appReadyAs(name) {
  await waitFor(`fetch('/api/auth/status').then(r => r.json()).then(s => s.username === ${JSON.stringify(name)})`);
  await waitFor(`!!document.querySelector('.acct-switcher .acct-chip[aria-pressed=true][data-account=${JSON.stringify(name)}]') && document.getElementById('onboarding-overlay').classList.contains('hidden')`);
}
async function notesSay(name) {
  const text = await js(`fetch('/api/notes').then(r => r.text())`);
  const other = name === 'ana' ? 'ben' : 'ana';
  assert.ok(text.includes(MARK[name]), name + ' sees their own note');
  assert.ok(!text.includes(MARK[other]), name + ' sees nothing of ' + other + "'s notes");
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    const port = await freePort(); base = 'http://127.0.0.1:' + port;
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-switcher-'));
    fs.mkdirSync(path.join(data, 'vault'));
    log = fs.openSync(path.join(output, 'backend.log'), 'w');
    const env = { ...process.env, JARVIS_DATA_DIR: data, JARVIS_VAULT_DIR: path.join(data, 'vault'), APP_PORT: String(port),
      JARVIS_INSTANCE: '', AUTH_ENABLED: 'true' };
    delete env.JARVIS_UI_SECRET;
    backend = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'), ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
    let healthy = false;
    for (const until = Date.now() + 90000; Date.now() < until;) {
      assert.equal(backend.exitCode, null, 'Backend exited; see backend.log');
      try { healthy = (await fetch(base + '/api/health')).status === 200; } catch { /* starting */ }
      if (healthy) break;
      await delay(250);
    }
    assert.ok(healthy, 'Backend health timeout');

    // Two accounts, each past its first run, each with its own note.
    const ana = await call('/api/auth/setup', { body: { username: 'ana', password: PASS.ana } });
    await call('/api/settings/onboarding-complete', { body: {}, cookie: ana.cookie });
    await call('/api/auth/users', { body: { username: 'ben', password: PASS.ben }, cookie: ana.cookie });
    const ben = await call('/api/auth/login', { body: { username: 'ben', password: PASS.ben } });
    await call('/api/auth/onboarding-complete', { body: {}, cookie: ben.cookie });
    await call('/api/notes', { body: { text: MARK.ana }, cookie: ana.cookie });
    await call('/api/notes', { body: { text: MARK.ben }, cookie: ben.cookie });
    const colors = { ana: (await call('/api/auth/status', { cookie: ana.cookie })).json.color, ben: (await call('/api/auth/status', { cookie: ben.cookie })).json.color };
    assert.notEqual(colors.ana, colors.ben);
    ok(`accounts get different colours (ana ${colors.ana}, ben ${colors.ben})`);

    win = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_e, level, message) => { if (level === 3 && !/favicon|401|Failed to load resource/i.test(message)) errors.push(message); });
    await win.loadURL(base);

    // 1. Sign in ana on this window.
    await signInOnCard('ana');
    await appReadyAs('ana');
    assert.equal(await accountColor(), await token(colors.ana));
    await notesSay('ana');
    ok('ana signs in; the switcher shows her, in her colour, with her notes');

    // 2. Add another account: ben, with his password, from the switcher's +.
    await js(`document.querySelector('.acct-switcher .acct-add').click()`);
    await waitFor(`!!document.querySelector('.welcome-auth-card') && document.querySelector('.welcome-auth-card h2').textContent.includes('Add another account')`);
    await shot('add-another-account');
    await signInOnCard('ben');
    await appReadyAs('ben');
    assert.equal(await js(`document.querySelectorAll('.acct-switcher-sidebar .acct-chip:not(.acct-add)').length`), 2);
    assert.equal(await accountColor(), await token(colors.ben));
    await notesSay('ben');
    ok('Add another account signs ben in; both are on the switcher, ben open, his colour, his notes only');
    await js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'notes' } }))`);
    await waitFor(`document.documentElement.dataset.view === 'notes' && document.querySelector('#view-content').textContent.includes(${JSON.stringify(MARK.ben)})`);
    assert.ok(!(await js(`document.body.textContent.includes(${JSON.stringify(MARK.ana)})`)));
    await shot('desktop-browser-ben');
    ok("ben's Notes screen shows his note and none of ana's");

    // 3. Switch with the toggle: one click on ana's avatar, no password.
    const band = async () => js(`getComputedStyle(document.body, '::before').backgroundColor`);
    const benBand = await band();
    await js(`document.querySelector('.acct-switcher .acct-chip[data-account="ana"]').click()`);
    await appReadyAs('ana');
    assert.equal(await accountColor(), await token(colors.ana));
    assert.notEqual(await band(), benBand, 'the top band changed colour');
    await notesSay('ana');
    assert.ok(!(await js(`document.body.textContent.includes(${JSON.stringify(MARK.ben)})`)), "nothing of ben's on screen");
    assert.equal(await js(`location.pathname + location.search`), '/');
    ok('the toggle switches to ana in one click: her colour, her notes, nothing of ben on screen');

    // 4. Switch with the keyboard: Ctrl+Shift+2 is the second account (ben).
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '2', modifiers: ['control', 'shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '2', modifiers: ['control', 'shift'] });
    await appReadyAs('ben');
    assert.equal(await accountColor(), await token(colors.ben));
    await notesSay('ben');
    ok('Ctrl+Shift+2 switches to ben');

    // 5. The Profile panel lists both accounts with their sign-out choices.
    await js(`document.querySelector('.sidebar-user-card').click()`);
    await waitFor(`document.querySelectorAll('.acct-profile-section .acct-row').length === 2`);
    await shot('desktop-profile-accounts');
    await js(`document.querySelector('.modal-close-btn')?.click()`);
    await waitFor(`!document.querySelector('.acct-profile-section')`);
    await js(`document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab: 'settings', section: 'account' } }))`);
    await waitFor(`document.querySelectorAll('.acct-swatch').length === 8 && !!document.querySelector('.acct-swatch[aria-checked=true][data-color=${JSON.stringify(colors.ben)}]')`);
    await js(`document.querySelector('.acct-swatches').scrollIntoView({ block: 'center' })`);
    await shot('desktop-my-account-switching');
    assert.equal(await js(`getComputedStyle([...document.querySelectorAll('button')].find(b => b.textContent === 'Remove PIN')).display`), 'none', 'no Remove PIN without a PIN');
    await js(`document.querySelector('.modal-close-btn')?.click()`);
    ok('My account shows the account colour (his own checked) and the switching PIN');

    // 6. The desktop app's title bar holds the switcher (the class Electron's preload gives the real window).
    await js(`document.documentElement.classList.add('electron-shell'); document.dispatchEvent(new Event('kairos:layout'))`);
    await waitFor(`!!document.querySelector('#titlebar .acct-switcher-titlebar .acct-chip[aria-pressed=true]')`);
    assert.equal(await js(`getComputedStyle(document.getElementById('titlebar')).boxShadow.includes('inset')`), true);
    await shot('desktop-app-titlebar');
    ok('in the desktop app the switcher sits in the title bar, whose lower edge takes the account colour');

    // 7. Phone width: the switcher in the drawer, and a PIN on ana.
    await call('/api/auth/account/switch-pin', { method: 'PUT', body: { password: PASS.ana, pin: '2468' }, cookie: ana.cookie });
    win.setContentSize(390, 844);
    await win.loadURL(base);
    await appReadyAs('ben').catch(() => {});
    await waitFor(`fetch('/api/auth/status').then(r => r.json()).then(s => s.username === 'ben')`);
    await waitFor(`!!document.querySelector('.ms-menu-btn')`);
    await shot('phone-ben');
    await js(`document.querySelector('.ms-menu-btn').click()`);
    await waitFor(`!!document.querySelector('.ms-drawer-foot .acct-switcher-drawer .acct-chip[data-account="ana"]')`);
    await shot('phone-drawer-switcher');
    await js(`document.querySelector('.acct-switcher-drawer .acct-chip[data-account="ana"]').click()`);
    await waitFor(`!!document.querySelector('dialog.acct-pin-dialog[open]')`);
    await js(`document.querySelector('.acct-pin-input').value = '1111'; [...document.querySelectorAll('.acct-pin-actions button')].find(b => b.textContent === 'Switch').click()`);
    await waitFor(`/not right/.test(document.querySelector('.acct-pin-error')?.textContent || '')`);
    await shot('phone-pin-wrong');
    assert.equal((await status()).username, 'ben', 'a wrong PIN switches nothing');
    await js(`document.querySelector('.acct-pin-input').value = '2468'; [...document.querySelectorAll('.acct-pin-actions button')].find(b => b.textContent === 'Switch').click()`);
    await waitFor(`fetch('/api/auth/status').then(r => r.json()).then(s => s.username === 'ana')`);
    await waitFor(`!!document.querySelector('.ms-menu-btn')`);
    await notesSay('ana');
    ok('on a phone the drawer holds the switcher; ana asks her PIN, a wrong one is refused, the right one opens her');

    // 8. Log out of ana: the sign-in card offers ben, still signed in on this device, in one click.
    win.setContentSize(1280, 820);
    await win.loadURL(base);
    await appReadyAs('ana');
    await js(`[...document.querySelectorAll('#sidebar-footer .overflow-menu-item')].find(b => b.textContent === 'Log Out').click()`);
    await waitFor(`!!document.querySelector('.acct-chooser-row[data-account="ben"]')`);
    assert.equal(await js(`!!document.querySelector('.acct-chooser-row[data-account="ana"]')`), false, 'ana is signed out of this device');
    await shot('sign-in-chooser');
    await js(`document.querySelector('.acct-chooser-row[data-account="ben"]').click()`);
    await appReadyAs('ben');
    ok('logging out of ana leaves ben one click away on the sign-in card');
    await js(`document.querySelector('.acct-switcher .acct-add').click()`);
    await signInOnCard('ana');
    await appReadyAs('ana');

    // 9. Sign ben out of this device from Profile: ana stays open, ben is gone from the switcher and unreachable.
    await js(`document.querySelector('.sidebar-user-card').click()`);
    await waitFor(`document.querySelectorAll('.acct-profile-section .acct-row').length === 2`);
    await js(`[...document.querySelectorAll('.acct-profile-section .acct-row')].find(r => r.textContent.includes('ben')).querySelector('button.btn').click()`);
    await waitFor(`!document.querySelector('.acct-switcher .acct-chip[data-account="ben"]')`);
    assert.equal((await status()).username, 'ana');
    const tryBen = await js(`fetch('/api/auth/switch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kairos-Switch': '1' }, body: JSON.stringify({ username: 'ben' }) }).then(r => r.status)`);
    assert.equal(tryBen, 404);
    await js(`document.querySelector('.modal-close-btn')?.click()`);
    await shot('desktop-after-ben-signed-out');
    ok('signing ben out of this device leaves ana open; ben can no longer be switched to here');

    // 10. Sign out of all accounts: the sign-in card, with no account left to pick.
    await js(`document.querySelector('.sidebar-user-card').click()`);
    await waitFor(`!!document.querySelector('.acct-profile-section')`);
    await js(`[...document.querySelectorAll('.acct-profile-actions button')].find(b => b.textContent === 'Sign out of all accounts').click()`);
    await waitFor(`!!document.querySelector('.welcome-auth-card input[autocomplete=current-password]')`);
    assert.equal((await status()).username, null);
    ok('Sign out of all accounts returns to the sign-in card');

    assert.deepEqual(errors, [], 'Renderer console errors');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, checks, samples }, null, 2));
    console.log('PASS ' + output);
  } catch (error) {
    code = 1;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors }, null, 2));
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error(error);
  } finally {
    win?.destroy();
    if (backend?.pid) {
      const exited = backend.exitCode !== null ? Promise.resolve() : new Promise(resolve => { const t = setTimeout(resolve, 10000); backend.once('exit', () => { clearTimeout(t); resolve(); }); });
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(backend.pid), '/T', '/F'], { windowsHide: true });
      else backend.kill('SIGTERM');
      await exited;
    }
    if (log !== undefined) fs.closeSync(log);
    if (data) try { fs.rmSync(data, { recursive: true, force: true }); } catch { /* a file still held open */ }
    exitAfterFlush(code);
  }
});
