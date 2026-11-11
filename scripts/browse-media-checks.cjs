// Cameras, microphones and screen sharing in Kairos Browse, on real pages (2.3.0; David, 2026-11-11:
// "permission issues on browser with sharing screens and microphones in meetings such as google meetings").
//
// A local page (served here, on localhost so it is a secure page) calls getUserMedia and
// getDisplayMedia in a real Browse tab, built by the real createBrowse() on a test profile. The app's
// side of the IPC is a stand-in that records what main sends and answers as the person would: the
// prompt (Allow once, Always allow, Block, then removing the answer), the screen picker (Cancel, a
// source), and the in-use mark with its Stop. Chromium's fake camera and microphone stand in for
// devices; the picker lists this computer's real screens (desktopCapturer).
// The Kairos app's own window (the default session) is checked to be unchanged.
// Run: node scripts/run-electron-test.cjs browse-media-checks
const { app, BrowserWindow, session } = require('electron');
const { exitAfterFlush } = require('./electron-exit.cjs');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-media-'));
app.setPath('userData', path.join(tmp, 'userData'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');

const PORT = 8486;
const SITE = `http://localhost:${PORT}`;
const OTHER = `http://127.0.0.1:${PORT}`;

const failures = [];
let checksRun = 0;
async function check(name, fn) {
  checksRun += 1;
  try { await fn(); console.log(`ok - ${name}`); } catch (error) { failures.push(`${name}: ${error.message}`); console.log(`not ok - ${name}: ${error.message}`); }
}

// The call page: each button keeps its stream and hands the tracks to a peer
// connection, as a call site does.
const CALL = `<!doctype html><title>Call</title><h1>call</h1><script>
  window.streams = [];
  const use = (s) => { window.streams.push(s); const pc = new RTCPeerConnection(); s.getTracks().forEach((t) => pc.addTrack(t, s)); return s.getTracks().map((t) => t.kind).sort().join('+'); };
  window.mic = () => navigator.mediaDevices.getUserMedia({ audio: true }).then(use).catch((e) => e.name);
  window.cam = () => navigator.mediaDevices.getUserMedia({ video: true }).then(use).catch((e) => e.name);
  window.share = () => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(use).catch((e) => e.name);
  window.state = (name) => navigator.permissions.query({ name }).then((s) => s.state).catch((e) => 'error:' + e.name);
  window.live = () => window.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').map((t) => t.kind).sort().join('+');
  // A stream the page keeps to itself, handed to nothing Kairos could watch.
  window.hidden = () => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { window.kept = s; return 'kept'; }).catch((e) => e.name);
  window.keptLive = () => !!(window.kept && window.kept.getTracks().some((t) => t.readyState === 'live'));
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/call')) return res.end(CALL);
  // A link that answers 204: the browser stays on the page that followed it.
  if (req.url === '/nocontent') { res.statusCode = 204; return res.end(); }
  // A page embedding another site's call widget, allowed the camera by the page.
  if (req.url === '/embed') return res.end(`<!doctype html><title>Embed</title><iframe id="w" allow="camera; microphone" src="${OTHER}/call"></iframe>`);
  res.end('<!doctype html><title>Home</title><p>home</p>');
});

function finish(code, message) {
  if (code) console.error(message); else console.log(message);
  try { server.close(); } catch { /* closed */ }
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* in use until exit */ }
  exitAfterFlush(code);
}
process.on('unhandledRejection', (error) => finish(1, 'FAIL (unhandled rejection): ' + ((error && error.stack) || error)));
setTimeout(() => finish(1, 'FAIL: timed out before finishing.'), 180000).unref();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(100); } return null; };
const loaded = (wc) => new Promise((resolve) => {
  if (!wc.isLoading()) return resolve(true);
  const t = setTimeout(() => resolve(false), 10000);
  wc.once('did-stop-loading', () => { clearTimeout(t); resolve(true); });
});

app.whenReady().then(async () => {
  console.log(`Runtime: Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const { createBrowse, kairosPorts } = require(path.join(root, 'electron', 'browser-browse.js'));
  const { installBrowseIpc } = require(path.join(root, 'electron', 'browser-ipc.js'));

  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(`${SITE}/home`);
  const sent = [];
  const browse = createBrowse({
    host: () => win, partition: 'persist:browse-media-checks', folder: path.join(tmp, 'browser', 'default'),
    downloadsFolder: () => path.join(tmp, 'Downloads'), backendOrigin: 'http://127.0.0.1:8499',
    reservedPorts: kairosPorts({ instancePort: 8499 }), shell: { openPath() {}, showItemInFolder() {} },
    send: (channel, payload) => sent.push({ channel, payload }), log: { error: (m) => console.log('main: ' + m) },
  });
  const handlers = {}, listeners = {};
  installBrowseIpc({ ipcMain: { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { listeners[c] = fn; } },
    fromAppWindow: (e) => e.sender === 'app', getBrowse: () => browse });
  const appSender = { sender: 'app' }, pageSender = { sender: 'page' };
  const call = (c, ev, ...a) => handlers[c](ev, ...a);
  const emit = (c, ev, ...a) => listeners[c](ev, ...a);
  browse.tabs.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  browse.tabs.setVisible(true);

  // The next message main sends on a channel after `from` (an index into sent).
  const nextSent = (channel, from) => until(() => sent.slice(from).find((s) => s.channel === channel), 8000);
  const capturing = (id) => (browse.tabs.list().tabs.find((t) => t.id === id) || {}).capturing || [];
  const opened = await call('browse:open', appSender, `${SITE}/call`);
  const id = opened.id;
  const wc = browse.tabs.webContentsOf(id);
  await loaded(wc);
  // Screen sharing needs a click, as in Chrome: the call is made with a user gesture.
  const run = (code) => wc.executeJavaScript(code, /share\(\)/.test(code));
  // Ask the page for a device and answer the prompt main sends.
  async function ask(js, reply) {
    const from = sent.length;
    const result = run(js);
    const prompt = await nextSent('browse:permission', from);
    if (!prompt) return { prompt: null, result: await Promise.race([result, wait(3000).then(() => 'no answer')]) };
    if (reply) emit('browse:permission-answer', appSender, prompt.payload.requestId, reply[0], reply[1]);
    return { prompt: prompt.payload, result: await result };
  }

  await check('before any answer, a secure site sees the microphone as not blocked (so Meet asks instead of showing "blocked")', async () => {
    assert.equal(await run("state('microphone')"), 'granted');
    assert.equal(await run("state('camera')"), 'granted');
    assert.equal(sent.filter((s) => s.channel === 'browse:permission').length, 0, 'reading the state asks nothing');
  });

  await check('microphone: the prompt names the site; Allow once gives it for this page only', async () => {
    const { prompt, result } = await ask('mic()', ['allow', false]);
    assert.ok(prompt, 'a prompt was sent to the app');
    assert.equal(prompt.origin, SITE);
    assert.equal(prompt.setting, 'microphone');
    assert.equal(prompt.canRemember, true);
    assert.equal(prompt.tabId, id);
    assert.equal(result, 'audio');
    assert.equal(browse.store.getSite(SITE, 'permission:microphone'), null, 'Allow once is not remembered');
    assert.deepEqual(capturing(id), ['microphone'], 'the tab is marked in use');
    const again = await ask('mic()', null);
    assert.equal(again.prompt, null, 'no second prompt on the same page');
    assert.equal(again.result, 'audio');
  });

  await check('the page sender cannot answer a prompt', async () => {
    await run('location.reload()').catch(() => {});
    await wait(300); await loaded(wc);
    const from = sent.length;
    const result = run('mic()');
    const prompt = await nextSent('browse:permission', from);
    assert.ok(prompt, 'asked again after the page reloaded (Allow once ended)');
    emit('browse:permission-answer', pageSender, prompt.payload.requestId, 'allow', true);
    await wait(200);
    emit('browse:permission-answer', appSender, prompt.payload.requestId, 'block', false);
    assert.equal(await result, 'NotAllowedError');
    assert.equal(browse.store.getSite(SITE, 'permission:microphone'), null);
  });

  // Resolves once a new page commits in the tab.
  const committed = () => new Promise((resolve) => { const t = setTimeout(() => resolve(false), 10000); wc.once('did-navigate', () => { clearTimeout(t); resolve(true); }); });

  await check('review 2: the mark is main\'s own; a page ending one stream while keeping another cannot clear it', async () => {
    const { result } = await ask('hidden()', ['allow', false]);
    assert.equal(result, 'kept', 'a stream the page keeps to itself');
    assert.equal((await ask('mic()', null)).result, 'audio', 'a second stream, used in a call');
    assert.deepEqual(capturing(id), ['microphone']);
    assert.ok(sent.some((s) => s.channel === 'browse:state' && (s.payload.tabs || []).some((t) => t.id === id && (t.capturing || []).includes('microphone'))), 'the app was told');
    await run("streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))");
    await wait(2500);
    assert.equal(await run('keptLive()'), true, 'the kept stream still records');
    assert.deepEqual(capturing(id), ['microphone'], 'so the mark stays');
  });

  await check('review 2: Stop reloads the page, which ends every track it held, and the mark clears when the new page commits', async () => {
    assert.deepEqual(await call('browse:capture-stop', pageSender, id), { ok: false }, 'only the app can press Stop');
    const done = committed();
    const stopped = await call('browse:capture-stop', appSender, id);
    assert.deepEqual(stopped, { ok: true, reloaded: true });
    assert.ok(await done, 'the page reloaded');
    await loaded(wc);
    assert.deepEqual(capturing(id), []);
    assert.equal(await run('keptLive()'), false, 'nothing of the old page records');
    assert.ok((await ask('mic()', ['block', false])).prompt, 'Allow once ended with the page');
  });

  await check('review 3: a navigation that never commits (204) keeps the page, its tracks and its mark', async () => {
    assert.equal((await ask('mic()', ['allow', false])).result, 'audio');
    assert.deepEqual(capturing(id), ['microphone']);
    const from = sent.length;
    await call('browse:navigate', appSender, id, `${SITE}/nocontent`);
    await wait(1500); await loaded(wc);
    assert.match(wc.getURL(), /\/call$/, 'still on the call page');
    assert.equal(await run('live()'), 'audio', 'its track still records');
    assert.deepEqual(capturing(id), ['microphone'], 'so the mark stays');
    assert.equal(sent.slice(from).filter((s) => s.channel === 'browse:permission').length, 0);
    assert.equal((await ask('mic()', null)).prompt, null, 'and its Allow once still holds');
    const done = committed();
    await call('browse:capture-stop', appSender, id);
    await done; await loaded(wc);
  });

  await check('review 4: a prompt open when the page reloads is withdrawn; a late answer reaches nobody', async () => {
    const from = sent.length;
    run('mic()').catch(() => {});
    const prompt = await nextSent('browse:permission', from);
    assert.ok(prompt);
    const done = committed();
    wc.reload();
    assert.ok(await done); await loaded(wc);
    assert.ok(await until(() => sent.slice(from).some((s) => s.channel === 'browse:event' && s.payload.event === 'permission-closed' && s.payload.requestId === prompt.payload.requestId)), 'the app was told to close it');
    emit('browse:permission-answer', appSender, prompt.payload.requestId, 'allow', true);
    await wait(300);
    assert.equal(browse.store.getSite(SITE, 'permission:microphone'), null, 'nothing remembered');
    assert.deepEqual(capturing(id), []);
    const fresh = await ask('mic()', ['block', false]);
    assert.ok(fresh.prompt, 'the new page is asked itself');
    assert.equal(fresh.result, 'NotAllowedError');
  });

  await check('review 1: removing an Always allow ends what an open page holds (it reloads)', async () => {
    const first = await ask('mic()', ['allow', true]);
    assert.equal(first.result, 'audio');
    assert.equal(browse.store.getSite(SITE, 'permission:microphone'), 'allow');
    assert.deepEqual(capturing(id), ['microphone']);
    const done = committed();
    assert.deepEqual(await call('browse:site-set', appSender, `${SITE}/`, 'permission:microphone', null), { ok: true, reloaded: 1 });
    assert.ok(await done, 'the page reloaded'); await loaded(wc);
    assert.deepEqual(capturing(id), []);
    assert.equal(await run('live()'), '');
    const again = await ask('mic()', ['block', false]);
    assert.ok(again.prompt, 'asked again');
  });

  await check('review 1: blocking a site that was given the camera with Allow once ends it too', async () => {
    assert.equal((await ask('cam()', ['allow', false])).result, 'video');
    const done = committed();
    assert.deepEqual(await call('browse:site-set', appSender, `${SITE}/`, 'permission:camera', 'block'), { ok: true, reloaded: 1 });
    assert.ok(await done); await loaded(wc);
    assert.equal((await ask('cam()', null)).result, 'NotAllowedError');
    await call('browse:site-set', appSender, `${SITE}/`, 'permission:camera', null);
  });

  await check('Block is remembered: no prompt, denied; the site then reads as blocked', async () => {
    await run('location.reload()').catch(() => {}); await wait(300); await loaded(wc);
    const first = await ask('cam()', ['block', true]);
    assert.equal(first.result, 'NotAllowedError');
    assert.equal(browse.store.getSite(SITE, 'permission:camera'), 'block');
    const second = await ask('cam()', null);
    assert.equal(second.prompt, null, 'not asked again');
    assert.equal(second.result, 'NotAllowedError');
    assert.equal(await run("state('camera')"), 'denied');
  });

  await check('Browser settings list the answer; removing it makes the site ask again; Always allow is then kept', async () => {
    const list = await call('browse:permissions', appSender);
    assert.ok(list.some((r) => r.origin === SITE && r.setting === 'camera' && r.value === 'block'), JSON.stringify(list));
    assert.deepEqual(await call('browse:permissions', pageSender), []);
    assert.deepEqual(await call('browse:site-set', appSender, `${SITE}/`, 'permission:camera', null), { ok: true });
    const asked = await ask('cam()', ['allow', true]);
    assert.ok(asked.prompt, 'asked again after removing');
    assert.equal(asked.result, 'video');
    assert.equal(browse.store.getSite(SITE, 'permission:camera'), 'allow');
    await run('location.reload()').catch(() => {}); await wait(300); await loaded(wc);
    const kept = await ask('cam()', null);
    assert.equal(kept.prompt, null, 'Always allow: no prompt after a reload');
    assert.equal(kept.result, 'video');
    const done = committed();
    await call('browse:capture-stop', appSender, id);
    await done; await loaded(wc);
  });

  await check('screen sharing: getDisplayMedia goes to the Kairos picker; Cancel shares nothing', async () => {
    const from = sent.length;
    const result = run('share()');
    const req = await nextSent('browse:screen-request', from);
    assert.ok(req, 'the picker was asked for; the page said: ' + await Promise.race([result, wait(2000).then(() => 'nothing yet')]) + ' sent: ' + JSON.stringify(sent.slice(from).filter((s) => s.channel !== 'browse:state')));
    assert.equal(req.payload.origin, SITE);
    assert.equal(req.payload.tabId, id);
    assert.ok(Array.isArray(req.payload.sources));
    emit('browse:screen-answer', appSender, req.payload.requestId, null, false);
    assert.equal(await result, 'NotAllowedError');
    assert.deepEqual(capturing(id), []);
  });

  await check('screen sharing: a source not offered is refused; the picked screen is shared and marked; Stop ends it', async () => {
    let from = sent.length;
    let result = run('share()');
    let req = await nextSent('browse:screen-request', from);
    emit('browse:screen-answer', appSender, req.payload.requestId, 'screen:999999:0', false);
    assert.equal(await result, 'NotAllowedError', 'a made-up source id shares nothing');
    const screens = req.payload.sources.filter((s) => s.kind === 'screen');
    if (!screens.length) throw new Error(`this computer offered no screen to share (sources: ${req.payload.sources.length})`);
    assert.ok(screens.every((s) => typeof s.name === 'string' && (s.thumb === null || /^data:image\/jpeg;base64,/.test(s.thumb))));
    from = sent.length;
    result = run('share()');
    req = await nextSent('browse:screen-request', from);
    emit('browse:screen-answer', pageSender, req.payload.requestId, screens[0].id, false);
    await wait(200);
    emit('browse:screen-answer', appSender, req.payload.requestId, screens[0].id, false);
    assert.match(await result, /video/, 'the page got a video track');
    assert.deepEqual(capturing(id), ['screen']);
    const done = committed();
    assert.deepEqual(await call('browse:capture-stop', appSender, id), { ok: true, reloaded: true });
    assert.ok(await done); await loaded(wc);
    assert.deepEqual(capturing(id), []);
    assert.equal(await run('live()'), '');
  });

  await check('a blocked site gets no screen picker', async () => {
    assert.deepEqual(await call('browse:site-set', appSender, `${SITE}/`, 'permission:screen', 'allow'), { ok: false }, 'screen sharing can only be blocked');
    assert.deepEqual(await call('browse:site-set', appSender, `${SITE}/`, 'permission:screen', 'block'), { ok: true });
    const from = sent.length;
    assert.equal(await run('share()'), 'NotAllowedError');
    assert.equal(sent.slice(from).filter((s) => s.channel === 'browse:screen-request').length, 0);
    await call('browse:site-set', appSender, `${SITE}/`, 'permission:screen', null);
  });

  await check('navigating away ends the mark', async () => {
    const { result } = await ask('cam()', null);
    assert.equal(result, 'video');
    assert.deepEqual(capturing(id), ['camera']);
    const done = committed();
    await call('browse:navigate', appSender, id, `${SITE}/home`);
    assert.ok(await done);
    assert.deepEqual(capturing(id), [], 'cleared when the new page committed');
  });

  await check('another site in a frame: the prompt names both, has no Always, and is not remembered', async () => {
    await call('browse:navigate', appSender, id, `${SITE}/embed`);
    await wait(300); await loaded(wc);
    const frame = await until(() => wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith(OTHER)));
    assert.ok(frame, 'the widget frame loaded');
    await until(async () => (await frame.executeJavaScript('typeof window.cam')) === 'function');
    const from = sent.length;
    const result = frame.executeJavaScript('cam()');
    const prompt = await nextSent('browse:permission', from);
    assert.ok(prompt, 'asked');
    assert.equal(prompt.payload.origin, SITE);
    assert.equal(prompt.payload.embedded, OTHER);
    assert.equal(prompt.payload.canRemember, false);
    emit('browse:permission-answer', appSender, prompt.payload.requestId, 'allow', true);
    assert.equal(await result, 'video');
    assert.equal(browse.store.getSite(OTHER, 'permission:camera'), null);
    assert.equal(browse.store.getSite(SITE, 'permission:camera'), 'allow', 'the page\'s own answer from before, untouched');
    assert.deepEqual(capturing(id), ['camera']);
  });

  await check('the Kairos app window (default session) is unchanged: no Browse prompt, its own pages keep their media', async () => {
    const from = sent.length;
    const appWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    await appWin.loadURL(`${SITE}/call`);
    const got = await appWin.webContents.executeJavaScript('mic()');
    assert.equal(got, 'audio');
    assert.equal(sent.slice(from).filter((s) => s.channel === 'browse:permission').length, 0);
    assert.notEqual(session.defaultSession, session.fromPartition('persist:browse-media-checks'));
    appWin.destroy();
  });

  browse.close();
  if (failures.length) finish(1, 'FAIL\n' + failures.map((f) => ' - ' + f).join('\n'));
  else finish(0, `PASS: ${checksRun} checks. Browse media: the state reads not blocked before an answer, prompts name the site (and both sites for a frame), Allow once for the page, Always and Block remembered and removable, only the app answers, the screen picker shares only an offered source, the in-use mark kept by main until a new page commits (not by a 204, not by the page), Stop and revoking reload the page, prompts withdrawn on reload, the app window unchanged.`);
});
