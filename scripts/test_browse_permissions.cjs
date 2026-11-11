// Kairos Browse's per-site permissions and screen sharing rules (electron/browser-permissions.js,
// electron/browser-media.js, the store in electron/browser-store.js; 2.3.0, David 2026-11-11: Google Meet
// could not use the microphone or share a screen). Fake webContents, a fake desktopCapturer and a real
// per-account store file; no Electron, no capture. The real pages are in scripts/browse-media-checks.cjs.
// Run: node scripts/test_browse_permissions.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { createPermissions, _settingFor, _trustworthy } = require(path.join(root, 'electron', 'browser-permissions.js'));
const { createMedia } = require(path.join(root, 'electron', 'browser-media.js'));
const { openStore } = require(path.join(root, 'electron', 'browser-store.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-perms-'));
let failures = 0, count = 0;
async function test(name, fn) {
  count += 1;
  try { await fn(); console.log(`ok - ${name}`); } catch (e) { failures += 1; console.log(`not ok - ${name}\n  ${e.stack}`); }
}

let nextWc = 1;
const page = (url) => ({ id: nextWc++, url, isDestroyed: () => false, getURL() { return this.url; }, mainFrame: null });
const MEET = 'https://meet.google.com/abc-defg-hij';

// A permissions broker whose prompt answers from a queue and records what it was asked.
function broker(store, { tabs = null, answers = [] } = {}) {
  const asked = [], granted = [];
  const perms = createPermissions({
    store,
    ask: (req) => { asked.push(req); return answers.length ? answers.shift() : { answer: 'block', remember: false }; },
    isTab: (wc) => (tabs ? tabs.has(wc) : true),
    beforeGrant: async ({ setting }) => { granted.push(setting); },
  });
  return { perms, asked, granted };
}

(async () => {
  const store = openStore(path.join(tmp, 'account-a', 'browser.db'));

  await test('the per-site store keeps answers by origin, and one is removed by setting it to null', () => {
    store.setSite('https://meet.google.com/abc', 'permission:microphone', 'allow');
    assert.equal(store.getSite('https://meet.google.com/other/path?x=1', 'permission:microphone'), 'allow', 'same origin, any path');
    assert.equal(store.getSite('http://meet.google.com/', 'permission:microphone'), null, 'another scheme is another origin');
    assert.equal(store.getSite('https://evil.meet.google.com.example/', 'permission:microphone'), null);
    assert.ok(store.allSiteSettings().some((r) => r.origin === 'https://meet.google.com' && r.key === 'permission:microphone'));
    store.setSite('https://meet.google.com/', 'permission:microphone', null);
    assert.equal(store.getSite(MEET, 'permission:microphone'), null);
  });

  await test('each account has its own answers (one store file per account)', () => {
    const other = openStore(path.join(tmp, 'account-b', 'browser.db'));
    store.setSite(MEET, 'permission:camera', 'allow');
    assert.equal(other.getSite(MEET, 'permission:camera'), null);
    other.close();
    store.setSite(MEET, 'permission:camera', null);
  });

  await test('settings map Electron permissions, including screen sharing', () => {
    assert.equal(_settingFor('media', { mediaTypes: ['audio'] }), 'microphone');
    assert.equal(_settingFor('media', { mediaTypes: ['video'] }), 'camera');
    assert.equal(_settingFor('media', { mediaTypes: ['audio', 'video'] }), 'camera+microphone');
    assert.equal(_settingFor('display-capture'), 'screen');
    assert.equal(_settingFor('media', { mediaTypes: [] }), 'screen', 'getDisplayMedia arrives as media with no device types');
    assert.equal(_settingFor('media', {}), null);
    assert.equal(_settingFor('midi'), null);
    assert.equal(_trustworthy('https://meet.google.com'), true);
    assert.equal(_trustworthy('http://localhost:3000'), true);
    assert.equal(_trustworthy('http://example.com'), false);
  });

  await test('Allow once: granted for this page without remembering, no second prompt, gone after navigating', async () => {
    const { perms, asked, granted } = broker(store, { answers: [{ answer: 'allow', remember: false }] });
    const wc = page(MEET);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].origin, 'https://meet.google.com');
    assert.equal(asked[0].setting, 'microphone');
    assert.equal(asked[0].canRemember, true);
    assert.deepEqual(granted, ['microphone'], 'the in-use mark and OS check run before the page hears yes');
    assert.equal(store.getSite(MEET, 'permission:microphone'), null, 'nothing remembered');
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(asked.length, 1, 'same page: no second prompt');
    assert.equal(perms.check(wc, 'media', 'https://meet.google.com', { mediaType: 'audio', isMainFrame: true }), true);
    perms.navigated(wc.id);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: MEET, isMainFrame: true }), false, 'asks again after a navigation (and this time the queue says block)');
    assert.equal(asked.length, 2);
  });

  await test('Always allow is remembered per site; a combined request remembers both', async () => {
    const { perms, asked } = broker(store, { answers: [{ answer: 'allow', remember: true }] });
    const wc = page(MEET);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio', 'video'], requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(store.getSite(MEET, 'permission:camera'), 'allow');
    assert.equal(store.getSite(MEET, 'permission:microphone'), 'allow');
    const fresh = page('https://meet.google.com/xyz');
    assert.equal(await perms.decide(fresh, 'media', { mediaTypes: ['video'], requestingUrl: fresh.url, isMainFrame: true }), true);
    assert.equal(asked.length, 1, 'remembered: no prompt in a new tab');
  });

  await test('Block is remembered and the site is not asked again; removing it asks again', async () => {
    const { perms, asked } = broker(store, { answers: [{ answer: 'block', remember: true }, { answer: 'allow', remember: false }] });
    const wc = page('https://zoom.us/wc/join/1');
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true }), false);
    assert.equal(store.getSite(wc.url, 'permission:microphone'), 'block');
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true }), false);
    assert.equal(asked.length, 1);
    assert.equal(perms.check(wc, 'media', 'https://zoom.us', { mediaType: 'audio', isMainFrame: true }), false, 'a blocked site reads as blocked');
    store.setSite(wc.url, 'permission:microphone', null);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true }), true);
    assert.equal(asked.length, 2);
  });

  await test('an unanswered secure site reads as allowed to the check (so Meet asks), never granted without a prompt', async () => {
    const { perms, asked } = broker(store);
    const wc = page('https://teams.microsoft.com/v2/');
    assert.equal(perms.check(wc, 'media', 'https://teams.microsoft.com', { mediaType: 'video', isMainFrame: true }), true);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['video'], requestingUrl: wc.url, isMainFrame: true }), false, 'the prompt said block');
    assert.equal(asked.length, 1);
    const plain = page('http://example.com/');
    assert.equal(perms.check(plain, 'media', 'http://example.com', { mediaType: 'video', isMainFrame: true }), false, 'not a secure page');
    assert.equal(perms.check(wc, 'notifications', 'https://teams.microsoft.com', { isMainFrame: true }), false, 'only camera and microphone read that way');
  });

  await test('file:, data: and unknown schemes are blocked without a prompt', async () => {
    const { perms, asked } = broker(store, { answers: [{ answer: 'allow', remember: true }] });
    for (const url of ['file:///C:/Users/x/call.html', 'data:text/html,<p>x', 'chrome://settings', 'kairos://x', 'about:blank']) {
      const wc = page(url);
      assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: url, isMainFrame: true }), false, url);
      assert.equal(perms.check(wc, 'media', url, { mediaType: 'audio', isMainFrame: true }), false, url);
    }
    assert.equal(asked.length, 0);
  });

  await test('a frame of another site: asked naming both, once only, and a Block on the page blocks it', async () => {
    const { perms, asked } = broker(store, { answers: [{ answer: 'allow', remember: true }] });
    const wc = page('https://example.com/support');
    const widget = 'https://calls.vendor.test/embed';
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: widget, isMainFrame: false }), true);
    assert.equal(asked[0].embedded, 'https://calls.vendor.test');
    assert.equal(asked[0].origin, 'https://example.com');
    assert.equal(asked[0].canRemember, false);
    assert.equal(store.getSite('https://example.com/', 'permission:microphone'), null, 'never remembered for a frame');
    assert.equal(store.getSite(widget, 'permission:microphone'), null);
    assert.equal(perms.check(wc, 'media', 'https://calls.vendor.test', { mediaType: 'audio', isMainFrame: false, securityOrigin: 'https://calls.vendor.test' }), true, 'this page only');
    assert.equal(perms.check(wc, 'media', 'https://other.vendor.test', { mediaType: 'audio', isMainFrame: false, securityOrigin: 'https://other.vendor.test' }), false);
    assert.equal(await perms.decide(wc, 'notifications', { requestingUrl: widget, isMainFrame: false }), false, 'frames get camera and microphone only');
    store.setSite('https://example.com/', 'permission:camera', 'block');
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['video'], requestingUrl: widget, isMainFrame: false }), false);
    assert.equal(asked.length, 1, 'blocked page: the frame is not asked');
    store.setSite('https://example.com/', 'permission:camera', null);
  });

  await test('only Browse tabs ask: the side pane and sign-in pop-ups on the same profile get nothing, even a remembered allow', async () => {
    const tabWc = page(MEET), pane = page(MEET);
    const { perms, asked } = broker(store, { tabs: new Set([tabWc]) });
    assert.equal(store.getSite(MEET, 'permission:microphone'), 'allow');
    assert.equal(await perms.decide(pane, 'media', { mediaTypes: ['audio'], requestingUrl: MEET, isMainFrame: true }), false);
    assert.equal(perms.check(pane, 'media', 'https://meet.google.com', { mediaType: 'audio', isMainFrame: true }), false);
    assert.equal(await perms.decide(tabWc, 'media', { mediaTypes: ['audio'], requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(asked.length, 0);
    store.setSite(MEET, 'permission:microphone', null); store.setSite(MEET, 'permission:camera', null);
  });

  await test('display-capture is refused only for a blocked site; the picker decides the rest', async () => {
    const { perms } = broker(store);
    const wc = page(MEET);
    assert.equal(await perms.decide(wc, 'display-capture', { requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: [], requestingUrl: MEET, isMainFrame: true }), true);
    assert.equal(perms.check(wc, 'media', 'https://meet.google.com', { isMainFrame: true }), false, 'a check with no device type says nothing');
    assert.equal(perms.check(wc, 'media', 'https://meet.google.com', { mediaType: 'unknown', isMainFrame: true }), false);
    store.setSite(MEET, 'permission:screen', 'block');
    assert.equal(await perms.decide(wc, 'display-capture', { requestingUrl: MEET, isMainFrame: true }), false);
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: [], requestingUrl: MEET, isMainFrame: true }), false);
    assert.equal(perms.check(wc, 'display-capture', 'https://meet.google.com', { isMainFrame: true }), false);
    store.setSite(MEET, 'permission:screen', null);
  });

  await test('review 4: an answer that arrives after the page changed is thrown away (nothing granted, remembered or kept for the new page)', async () => {
    let release;
    const perms = createPermissions({ store, ask: () => new Promise((r) => { release = r; }), isTab: () => true });
    const wc = page('https://meet.google.com/reload-race');
    const decided = perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true });
    await new Promise((r) => setImmediate(r));
    perms.navigated(wc.id);
    release({ answer: 'allow', remember: true });
    assert.equal(await decided, false);
    assert.equal(store.getSite(wc.url, 'permission:microphone'), null, 'not remembered');
    assert.equal(perms.wasGranted(wc.id, 'microphone'), false);
    let asked = 0;
    const again = createPermissions({ store, ask: () => { asked += 1; return { answer: 'block' }; } });
    assert.equal(await again.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true }), false);
    assert.equal(asked, 1, 'the new page is asked itself');
  });

  await test('review 3: answers last until a new page commits; a navigation that never commits (a 204) keeps them', async () => {
    const perms = createPermissions({ store, ask: () => ({ answer: 'allow', remember: false }) });
    const wc = page('https://meet.google.com/stay');
    assert.equal(await perms.decide(wc, 'media', { mediaTypes: ['audio'], requestingUrl: wc.url, isMainFrame: true }), true);
    assert.equal(perms.wasGranted(wc.id, 'microphone'), true);
    // No navigated() call: the 204 never committed, so the page and its answer stay.
    assert.equal(perms.check(wc, 'media', 'https://meet.google.com', { mediaType: 'audio', isMainFrame: true }), true);
    assert.equal(perms.wasGranted(wc.id, 'microphone'), true);
    perms.navigated(wc.id);
    assert.equal(perms.wasGranted(wc.id, 'microphone'), false);
  });

  await test('review 1: revoking drops Allow once answers for the setting; wasGranted names pages that hold it', async () => {
    const perms = createPermissions({ store, ask: () => ({ answer: 'allow', remember: false }) });
    const wc = page('https://meet.google.com/revoke');
    await perms.decide(wc, 'media', { mediaTypes: ['audio', 'video'], requestingUrl: wc.url, isMainFrame: true });
    assert.equal(perms.wasGranted(wc.id, 'camera'), true);
    perms.revoke(wc.id, 'camera');
    assert.equal(perms.wasGranted(wc.id, 'camera'), true, 'still held until the page reloads');
    assert.equal(perms.check(wc, 'media', 'https://meet.google.com', { mediaType: 'audio', isMainFrame: true }), true, 'the microphone answer is untouched');
  });
  // -- screen sharing and the OS switch (browser-media.js), with a stubbed capturer
  const thumb = { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') };
  const SOURCES = [{ id: 'screen:0:0', name: 'Entire screen', thumbnail: thumb }, { id: 'window:42:0', name: 'Notes', thumbnail: thumb }];
  function mediaHarness({ platform = 'win32', status = {}, tabbed = true } = {}) {
    const sent = [];
    const wc = { id: 99, isDestroyed: () => false, getURL: () => MEET };
    const frame = { url: MEET, executeJavaScript: async () => true };
    const media = createMedia({
      store, platform, log: { error() {} }, pickTimeoutMs: 2000,
      tabFor: (w) => (tabbed && w === wc ? { id: 7 } : null),
      send: (channel, payload) => sent.push({ channel, payload }),
      desktopCapturer: { getSources: async () => SOURCES },
      systemPreferences: { getMediaAccessStatus: (k) => status[k] || 'granted', askForMediaAccess: async () => false },
      fromFrame: (f) => (f === frame ? wc : null),
    });
    return { media, sent, wc, frame };
  }
  const request = (frame, extra = {}) => ({ frame, securityOrigin: 'https://meet.google.com', videoRequested: true, audioRequested: true, userGesture: true, ...extra });
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return true; await new Promise((res) => setTimeout(res, 10)); } return false; };
  const nextScreenRequest = async (sent) => { for (let i = 0; i < 50; i++) { const r = sent.find((s) => s.channel === 'browse:screen-request'); if (r) return r.payload; await new Promise((res) => setTimeout(res, 10)); } return null; };

  await test('screen picker: offers screens and windows, shares only the source picked, with system sound on Windows', async () => {
    const { media, sent, frame } = mediaHarness();
    let streams = null;
    const handled = new Promise((res) => {
      const callback = (s) => { streams = s; res(); };
      // attach() is Electron's; call the handler it would install.
      const fake = { setDisplayMediaRequestHandler: (fn) => fn(request(frame), callback) };
      media.attach(fake);
    });
    const req = await nextScreenRequest(sent);
    assert.ok(req, 'the picker was asked for');
    assert.equal(req.origin, 'https://meet.google.com');
    assert.equal(req.audio, true);
    assert.deepEqual(req.sources.map((s) => [s.id, s.kind]), [['screen:0:0', 'screen'], ['window:42:0', 'window']]);
    assert.match(req.sources[0].thumb, /^data:image\/jpeg;base64,/);
    assert.equal(media.answerScreen(req.requestId, 'window:999:0', true).ok, true);
    await handled;
    assert.deepEqual(streams, {}, 'a source that was not offered shares nothing');
  });

  await test('screen picker: the picked window and loopback sound; the tab is marked as sharing', async () => {
    const { media, sent, frame } = mediaHarness();
    let streams = null;
    const handled = new Promise((res) => media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(frame), (s) => { streams = s; res(); }) }));
    const req = await nextScreenRequest(sent);
    media.answerScreen(req.requestId, 'window:42:0', true);
    await handled;
    assert.equal(streams.video.id, 'window:42:0');
    assert.equal(streams.audio, 'loopback');
    assert.deepEqual(media.capturing(7), ['screen']);
    media.reset(7);
    assert.deepEqual(media.capturing(7), [], 'navigation clears the mark');
    media.close();
  });

  await test('screen picker: Cancel shares nothing; no sound on macOS; a blocked site and a non-tab get no picker', async () => {
    let h = mediaHarness();
    let streams = null;
    let handled = new Promise((res) => h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame), (s) => { streams = s; res(); }) }));
    let req = await nextScreenRequest(h.sent);
    h.media.answerScreen(req.requestId, null, false);
    await handled;
    assert.deepEqual(streams, {});
    assert.deepEqual(h.media.capturing(7), []);

    h = mediaHarness({ platform: 'darwin' });
    handled = new Promise((res) => h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame), (s) => { streams = s; res(); }) }));
    req = await nextScreenRequest(h.sent);
    assert.equal(req.audio, false, 'the computer sound option is Windows only');
    h.media.answerScreen(req.requestId, 'screen:0:0', true);
    await handled;
    assert.equal(streams.video.id, 'screen:0:0');
    assert.equal(streams.audio, undefined);
    h.media.close();

    store.setSite(MEET, 'permission:screen', 'block');
    h = mediaHarness();
    await new Promise((res) => h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame), (s) => { streams = s; res(); }) }));
    assert.deepEqual(streams, {});
    assert.equal(h.sent.filter((s) => s.channel === 'browse:screen-request').length, 0);
    store.setSite(MEET, 'permission:screen', null);

    h = mediaHarness({ tabbed: false });
    await new Promise((res) => h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame), (s) => { streams = s; res(); }) }));
    assert.deepEqual(streams, {}, 'the side pane gets no picker');
  });

  await test('screen picker in the permission step: Cancel is a plain no; a pick is used once by the handler that follows', async () => {
    const h = mediaHarness();
    const perms = createPermissions({ store, ask: () => ({ answer: 'block' }), isTab: () => true, pickScreen: h.media.pickScreen });
    let decided = perms.decide(h.wc, 'media', { mediaTypes: [], requestingUrl: MEET, isMainFrame: true });
    let req = await nextScreenRequest(h.sent);
    assert.equal(req.audio, true, 'sound is offered on Windows; used only if the site asks');
    h.media.answerScreen(req.requestId, null, false);
    assert.equal(await decided, false, 'Cancel: the page gets NotAllowedError, as in Chrome');
    h.sent.length = 0;
    decided = perms.decide(h.wc, 'media', { mediaTypes: [], requestingUrl: MEET, isMainFrame: true });
    req = await nextScreenRequest(h.sent);
    h.media.answerScreen(req.requestId, 'screen:0:0', true);
    assert.equal(await decided, true);
    let streams = null;
    h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame, { audioRequested: false }), (s) => { streams = s; }) });
    await until(() => streams);
    assert.equal(streams.video.id, 'screen:0:0', 'the handler used the pick, with no second picker');
    assert.equal(streams.audio, undefined, 'no sound: the site did not ask for it');
    assert.equal(h.sent.filter((s) => s.channel === 'browse:screen-request').length, 1);
    assert.deepEqual(h.media.capturing(7), ['screen']);
    h.media.close();
  });

  await test('screen picker: an unanswered picker is withdrawn and shares nothing', async () => {
    const h = mediaHarness();
    let streams = null;
    const handled = new Promise((res) => h.media.attach({ setDisplayMediaRequestHandler: (fn) => fn(request(h.frame), (s) => { streams = s; res(); }) }));
    await handled;
    assert.deepEqual(streams, {});
    assert.ok(h.sent.some((s) => s.channel === 'browse:event' && s.payload.event === 'screen-closed'));
  });

  await test('the OS switch: Windows privacy off and macOS denied are reported plainly; macOS asks first', async () => {
    let h = mediaHarness({ status: { microphone: 'denied' } });
    h.wc.mainFrame = h.frame;
    await h.media.beforeGrant({ webContents: h.wc, setting: 'camera+microphone', details: { isMainFrame: true } });
    const ev = h.sent.find((s) => s.payload && s.payload.event === 'media-os-blocked');
    assert.ok(ev, 'reported');
    assert.deepEqual(ev.payload.kinds, ['microphone']);
    assert.equal(ev.payload.platform, 'win32');
    assert.deepEqual(h.media.capturing(7), ['microphone', 'camera'], 'the tab is marked as in use');
    h.media.reset(7);
    await h.media.beforeGrant({ webContents: h.wc, setting: 'camera', details: {}, current: () => false });
    assert.deepEqual(h.media.capturing(7), [], 'review 4: no mark for a page that is already gone');
    h.media.close();

    h = mediaHarness({ platform: 'darwin', status: { camera: 'not-determined' } });
    h.wc.mainFrame = h.frame;
    await h.media.beforeGrant({ webContents: h.wc, setting: 'camera', details: { isMainFrame: true } });
    const mac = h.sent.find((s) => s.payload && s.payload.event === 'media-os-blocked');
    assert.deepEqual(mac.payload.kinds, ['camera'], 'macOS asked and the person said no');
    h.media.close();

    h = mediaHarness({ platform: 'linux', status: { microphone: 'denied' } });
    h.wc.mainFrame = h.frame;
    await h.media.beforeGrant({ webContents: h.wc, setting: 'microphone', details: { isMainFrame: true } });
    assert.equal(h.sent.filter((s) => s.payload && s.payload.event === 'media-os-blocked').length, 0);
    h.media.close();
  });

  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `FAIL: ${failures} of ${count}` : `PASS: ${count} checks`);
  process.exit(failures ? 1 : 0);
})();
