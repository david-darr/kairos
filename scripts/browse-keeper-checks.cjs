// scripts/browse-keeper-checks.cjs — the password keeper and the audio
// output in Browse tabs, run from scripts/browser-smoke.cjs (it owns the
// fixture server, the window and the partition).
//
// The keeper (electron/browser-passwords.js) runs against a stand-in for the
// backend's desktop routes, so what main sends to the app page, and when, is
// checked exactly; the backend store itself is scripts/test_browse_passwords.py.

const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..');

async function passwordChecks({ check, win, partition, gate, store, adblock, base, otherBase, loaded, until, wait }) {
  const { createPasswords, _fillScript, WORLD } = require(path.join(root, 'electron', 'browser-passwords.js'));
  const { createTabs } = require(path.join(root, 'electron', 'browser-tabs.js'));
  const origin = base;
  const saved = [], never = new Set(), routes = [], sent = [];
  const backend = async (route, body) => {
    routes.push(route);
    if (route === 'known') return { saved: saved.some(x => x.url === body.url && x.username === body.username && x.password === body.password), never: never.has(body.url), update: saved.some(x => x.url === body.url && x.username === body.username) };
    if (route === 'save') { saved.push({ ...body }); return { id: String(saved.length - 1) }; }
    if (route === 'never') { never.add(body.url); return {}; }
    if (route === 'match') return { origin: body.url, logins: saved.map((x, i) => ({ id: String(i), username: x.username, url: x.url })).filter(x => x.url === body.url), never: never.has(body.url) };
    if (route === 'fill') { const x = saved[Number(body.id)]; if (!x || x.url !== body.url) throw new Error('HTTP 403'); return { username: x.username, password: x.password }; }
    throw new Error('unknown route');
  };
  const passwords = createPasswords({ backend, send: (channel, payload) => sent.push({ channel, payload }), log: { error() {} } });
  const tabs = createTabs({ host: () => win, session: partition, gate, store, adblock, onTabContents: (tab, wc) => passwords.attach(tab, wc) });
  tabs.setBounds({ x: 300, y: 0, width: 900, height: 800 });
  tabs.setVisible(true);
  const offers = () => sent.filter(m => m.channel === 'browse:password-offer');
  const suggestions = (tabId) => sent.filter(m => m.channel === 'browse:password-suggest' && m.payload.tabId === tabId && m.payload.origin);
  const openAt = async (url) => { const r = tabs.open(url); const wc = tabs.webContentsOf(r.id); await until(() => wc.getURL() === url && !wc.isLoading()); await wait(250); return { id: r.id, wc }; };
  const type = (wc, id, value) => wc.executeJavaScript(`(() => { const i = document.getElementById(${JSON.stringify(id)}); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);

  await check('passwords: a successful sign-in is offered for saving, never saved on its own', async () => {
    const { id, wc } = await openAt(`${base}/login`);
    await type(wc, 'u', 'alice'); await type(wc, 'p', 's3cret-pw');
    await wc.executeJavaScript("document.getElementById('go').click(); 1");
    assert.ok(await until(() => offers().length === 1), 'an offer after the page moved on');
    const offer = offers()[0].payload;
    assert.equal(offer.origin, origin);
    assert.equal(offer.username, 'alice');
    assert.equal(offer.tabId, id);
    assert.ok(!('password' in offer), 'the app page never gets the password');
    assert.ok(!routes.includes('save'), 'nothing saved without the click');
    assert.deepEqual(await passwords.answer(offer.offerId, 'save'), { ok: true });
    assert.deepEqual(saved, [{ url: origin, username: 'alice', password: 's3cret-pw' }]);
    assert.deepEqual(await passwords.answer(offer.offerId, 'save'), { ok: false }, 'an offer is answered once');
    tabs.close(id);
  });

  await check('passwords: a failed sign-in is not offered', async () => {
    const before = offers().length;
    const { id, wc } = await openAt(`${base}/login-bad`);
    await type(wc, 'u', 'alice'); await type(wc, 'p', 'wrong-guess');
    await wc.executeJavaScript("document.getElementById('go').click(); 1");
    await wait(5500);
    assert.equal(offers().length, before, 'a 401 page with the form still up is no success');
    tabs.close(id);
  });

  await check('passwords: a saved sign-in is suggested on its own origin and fills in', async () => {
    const { id, wc } = await openAt(`${base}/login`);
    assert.ok(await until(() => suggestions(id).length >= 1), 'suggested');
    const suggestion = suggestions(id).at(-1).payload;
    assert.deepEqual(suggestion.logins, [{ id: '0', username: 'alice' }]);
    assert.equal(suggestion.generate, false);
    assert.deepEqual(await passwords.fill(id, '0'), { ok: true, filled: 2 });
    assert.deepEqual(await wc.executeJavaScript("[document.getElementById('u').value, document.getElementById('p').value]"), ['alice', 's3cret-pw']);
    tabs.close(id);
  });

  await check('passwords: never into a frame of another origin', async () => {
    const { id, wc } = await openAt(`${base}/framed`);
    await wait(800);
    assert.equal(suggestions(id).length, 0, 'the sign-in form of the site inside is not this page\'s');
    assert.deepEqual(await passwords.fill(id, '0'), { ok: false });
    // Even asked directly, the fill script reaches only same-origin documents.
    const result = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: _fillScript(origin, 'login', 'alice', 's3cret-pw') }]);
    assert.equal(result.filled, 0);
    const other = await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: _fillScript(otherBase, 'login', 'alice', 's3cret-pw') }]);
    assert.equal(other.filled, 0, 'a page of one origin is never filled with values for another');
    const frame = wc.mainFrame.frames.find(f => f.url.startsWith(otherBase));
    assert.ok(frame, 'the frame loaded');
    assert.deepEqual(await frame.executeJavaScript("[document.getElementById('u').value, document.getElementById('p').value]"), ['', '']);
    tabs.close(id);
  });

  await check('passwords: a username-first sign-in on a single-page site is offered after it moves on', async () => {
    const before = offers().length;
    const { id, wc } = await openAt(`${base}/spa`);
    await type(wc, 'u', 'bob@example.test');
    await wc.executeJavaScript("document.getElementById('next').click(); 1");
    await wait(300);
    await type(wc, 'p', 'spa-pass-1');
    await wc.executeJavaScript("document.getElementById('go').click(); 1");
    assert.ok(await until(() => offers().length === before + 1), 'offered after the in-page move');
    const offer = offers().at(-1).payload;
    assert.equal(offer.username, 'bob@example.test', 'the name from the first step');
    assert.deepEqual(await passwords.answer(offer.offerId, 'never'), { ok: true });
    assert.ok(never.has(origin));
    never.delete(origin);
    tabs.close(id);
  });

  await check('passwords: a sign-up form gets a strong password, then the save offer', async () => {
    const before = offers().length;
    const { id, wc } = await openAt(`${base}/signup`);
    assert.ok(await until(() => suggestions(id).some(m => m.payload.generate)), 'a strong password is offered');
    assert.deepEqual(await passwords.useGenerated(id), { ok: true, filled: 2 });
    const [one, two] = await wc.executeJavaScript("[document.getElementById('p1').value, document.getElementById('p2').value]");
    assert.equal(one, two, 'the password and its confirmation match');
    assert.ok(one.length >= 16 && /[a-z]/.test(one) && /[A-Z]/.test(one) && /\d/.test(one), 'strong');
    assert.ok(!JSON.stringify(sent).includes(one), 'the new password never went to the app page');
    await type(wc, 'u', 'carol');
    await wc.executeJavaScript("document.getElementById('go').click(); 1");
    assert.ok(await until(() => offers().length === before + 1));
    assert.equal(offers().at(-1).payload.username, 'carol');
    tabs.close(id);
  });

  await check('passwords: no password reaches the app page at all', () => {
    const all = JSON.stringify(sent);
    for (const secret of ['s3cret-pw', 'spa-pass-1', 'wrong-guess']) assert.ok(!all.includes(secret), secret);
  });
  tabs.closeAll();
  passwords.close();
}

// Bots and the person's Browse passwords (David, 2026-11-07: "yes bots can
// use your saved passwords, but that can be turned off"). Bots browse in
// their contained computer, so the fill is the harness's
// (core/computer.py fill_login, login_id "browse"). Here a real Chromium
// page is scanned with the driver's own field script (LOGIN_ROWS in
// core/computer_driver.py), the real harness and store decide in Python
// (scripts/fixtures/bot_browse_fill.py), and what reached the driver is typed
// into the real page the way the driver types it. Not run: the driver itself
// (Playwright in Docker).
async function botPasswordChecks({ check, win, partition, gate, store, base, otherBase, until }) {
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const { createTabs } = require(path.join(root, 'electron', 'browser-tabs.js'));
  const driverSource = fs.readFileSync(path.join(root, 'core', 'computer_driver.py'), 'utf8');
  const LOGIN_ROWS = /LOGIN_ROWS = """([\s\S]*?)"""/.exec(driverSource)[1];
  const tabs = createTabs({ host: () => win, session: partition, gate, store });
  tabs.setBounds({ x: 300, y: 0, width: 900, height: 800 });
  const PASSWORD = 'Bot-fill-pw-7731';
  const open = async (url) => {
    const r = tabs.open(url);
    const wc = tabs.webContentsOf(r.id);
    await until(() => wc.getURL() === url && !wc.isLoading());
    await until(async () => (url.endsWith('/framed') ? wc.mainFrame.framesInSubtree.length > 1 : true));
    await new Promise(res => setTimeout(res, 300));
    return { id: r.id, wc };
  };
  // What the driver's login_candidates() does, in this page's frames.
  const scan = async (wc) => {
    const all = [wc.mainFrame, ...wc.mainFrame.framesInSubtree.filter(f => f !== wc.mainFrame)];
    const frames = [], fields = [], refs = [];
    for (const frame of all) {
      if (frame !== wc.mainFrame && /^(about|data|blob):/.test(frame.url)) continue;
      const rows = await frame.executeJavaScript(`(${LOGIN_ROWS})()`);
      frames.push(frame.url); refs.push(frame);
      for (const row of rows) fields.push({ ...row, frame: frames.length - 1 });
    }
    return { scan: { url: wc.getURL(), frames, fields }, refs };
  };
  const pages = {};
  let result = null;

  await check('bots: real sign-in pages scanned with the driver\'s own field script', async () => {
    for (const [name, url] of [['login', `${base}/login`], ['other', `${otherBase}/login`], ['framed', `${base}/framed`]]) {
      const { id, wc } = await open(url);
      pages[name] = { id, wc, ...(await scan(wc)) };
    }
    assert.deepEqual(pages.login.scan.fields.map(f => [f.kind, f.frame]), [['username', 0], ['password', 0]]);
    assert.equal(pages.framed.scan.frames.length, 2, 'the frame of another site is seen');
    assert.ok(pages.framed.scan.fields.length && pages.framed.scan.fields.every(f => f.frame === 1), 'its fields are in that frame');
    const python = [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python')].find(p => fs.existsSync(p)) || 'python';
    const job = { site: base, username: 'al', password: PASSWORD, scans: Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, v.scan])) };
    const output = await new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(root, 'scripts', 'fixtures', 'bot_browse_fill.py')], { cwd: root, windowsHide: true });
      let out = '', err = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('the Python side took over 60 s')); }, 60000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err.slice(-800)}`)); });
      child.stdin.end(JSON.stringify(job));
    });
    result = JSON.parse(output.trim().split('\n').at(-1));
  });

  await check('bots: on, the exact site is filled by the browser layer and the model is told no value', async () => {
    assert.ok(result, 'the Python side ran');
    const done = result.cases['exact site'];
    assert.match(done.text, /^URL: .* \| Filled username, password for the Browse password saved for http:\/\/fixture\.test:\d+\. Nothing was submitted\.$/);
    assert.deepEqual(done.values, { username: 'al', password: PASSWORD, code: null }, 'the values went to the driver');
    // Typed into the real page the way the driver types (querySelectorAll('input')[index] in its frame).
    const { wc, refs, scan: seen } = pages.login;
    for (const field of seen.fields) {
      const value = done.values[field.kind];
      await refs[field.frame].executeJavaScript(`(() => { const i = document.querySelectorAll('input')[${field.index}]; i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    assert.deepEqual(await wc.executeJavaScript("[document.getElementById('u').value, document.getElementById('p').value]"), ['al', PASSWORD]);
  });

  await check('bots: off, another site, a frame of another site, and another account fill nothing', () => {
    assert.ok(result, 'the Python side ran');
    const expect = {
      'switched off': /turned off bots using their Browse passwords/,
      'another site': /No Browse password is saved for http:\/\/other\.test:\d+/,
      'a frame of another site': /frame from another site/,
      "another account's bot": /No Browse password is saved for/,
      'a bot of another account': /available to this bot/,
    };
    for (const [name, pattern] of Object.entries(expect)) {
      const got = result.cases[name];
      assert.equal(got.values, null, `${name}: nothing reached the driver`);
      assert.match(got.text, /^Not filled: /, name);
      assert.match(got.text, pattern, name);
    }
    assert.equal(result.prompt_off, null, 'off: bots are told nothing');
    assert.equal(result.prompt_bob, null, 'the other account has nothing saved, so its bots are told nothing');
  });

  await check('bots: each use is listed (bot, site, time), per account', () => {
    assert.ok(result, 'the Python side ran');
    assert.equal(result.uses.length, 1, 'one fill, one use');
    assert.deepEqual([result.uses[0].bot, result.uses[0].origin, result.uses[0].username], ['Scout', base, 'al']);
    assert.ok(Math.abs(result.uses[0].at - Date.now() / 1000) < 300, 'with the time');
    assert.deepEqual(result.bob_uses, [], 'nothing in the other account\'s list');
    assert.equal(result.listed[0].last_bot_use, result.uses[0].at);
  });

  await check('bots: the password is in no model text, prompt, use list or log line', () => {
    assert.ok(result, 'the Python side ran');
    const { cases, ...rest } = result;
    const told = Object.values(cases).map(c => c.text);
    assert.ok(!JSON.stringify([told, rest]).includes(PASSWORD));
    assert.ok(!/\bal\b|fixture\.test/.test(result.prompt_on) && /login_id "browse"/.test(result.prompt_on), 'the prompt names no site or username');
  });
  tabs.closeAll();
}

// Audio output (electron/browser-audio.js): the routing script, and the
// permission it needs only while a device is chosen.
async function audioChecks({ check, win, gate, store, base, until }) {
  // A partition of its own: these checks install their own permission
  // handlers, which must not replace the other Browse checks'.
  const partition = require('electron').session.fromPartition('persist:browse-audio-smoke');
  const { createAudio } = require(path.join(root, 'electron', 'browser-audio.js'));
  const { createPermissions } = require(path.join(root, 'electron', 'browser-permissions.js'));
  const { createTabs } = require(path.join(root, 'electron', 'browser-tabs.js'));
  const audio = createAudio({ store });
  const perms = createPermissions({ store, ask: () => ({ answer: 'block' }), speakerSelection: () => audio.allowSpeakerSelection() });
  const tabs = createTabs({ host: () => win, session: partition, gate, store, onTabContents: (_tab, wc) => audio.attach(wc) });
  tabs.setBounds({ x: 300, y: 0, width: 900, height: 800 });
  // Page scripts wrapped so a failure says what failed, not just that one did.
  const inPage = async (wc, label, code) => {
    const out = await wc.executeJavaScript(`(async () => { try { return { ok: true, value: await (async () => (${code}))() }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })()`);
    if (!out.ok) throw new Error(`${label}: ${out.error}`);
    return out.value;
  };
  const sink = (wc) => inPage(wc, 'reading the audio element sink', "document.getElementById('a').sinkId");

  await check('audio: "System default" lets pages pick nothing', async () => {
    await audio.set('');
    assert.equal(perms.check(null, 'speaker-selection', base), false);
    assert.equal(store.getMeta('audioOutput'), '');
  });

  await check('audio: a chosen output is kept in the profile and routes the page, unplugged falls back', async () => {
    perms.attach(partition);
    const r = tabs.open(`${base}/media`);
    const wc = tabs.webContentsOf(r.id);
    assert.ok(await until(() => wc.getURL().endsWith('/media') && !wc.isLoading()), 'the page loaded');
    await audio.set('A speaker that is not plugged in');
    assert.equal(store.getMeta('audioOutput'), 'A speaker that is not plugged in');
    assert.equal(perms.check(wc, 'speaker-selection', base), true);
    assert.equal(await sink(wc), '', 'not there: the page plays on the default');
    // A real output on this computer, if it has one besides the default.
    const outputs = await inPage(wc, 'listing outputs', "navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === 'audiooutput' && x.deviceId !== 'default' && x.deviceId !== 'communications').map(x => x.label))");
    if (outputs.length && outputs[0]) {
      await audio.set(outputs[0]);
      assert.ok(await until(async () => (await sink(wc)) !== ''), 'the page audio goes to that output');
      const ctx = await inPage(wc, 'a Web Audio context', "(async () => { const c = new AudioContext(); await new Promise(r => setTimeout(r, 400)); const id = c.sinkId; c.close(); return id; })()");
      assert.ok(typeof ctx === 'string' && ctx !== '', 'and a Web Audio context the page makes after loading');
    } else console.log('  (no second audio output on this computer: routing to a real device not exercised)');
    await audio.set('');
    assert.ok(await until(async () => (await sink(wc)) === ''), 'back to the default');
    assert.equal(perms.check(wc, 'speaker-selection', base), false);
    assert.equal((await audio.set('x'.repeat(301))).ok, false, 'a malformed name is refused');
    tabs.closeAll();
  });
}

// One Browse per Kairos account (electron/browser-profiles.js): the backend
// names the profile, a change of account closes the old one first, and each
// profile has its own partition and folder.
async function profileChecks({ check }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const { createBrowseProfiles } = require(path.join(root, 'electron', 'browser-profiles.js'));
  const { partitionFor, browseFolder, validProfile } = require(path.join(root, 'electron', 'browser-browse.js'));

  await check('profiles: each account has its own partition and folder; the first admin keeps the old one', () => {
    assert.equal(partitionFor('default'), 'persist:jarvis-browser', 'existing sign-ins stay with the first admin');
    assert.equal(partitionFor('bea123456789'), 'persist:jarvis-browser-bea123456789');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-browse-profiles-'));
    assert.equal(browseFolder(tmp, 'default'), path.join(tmp, 'browser', 'default'));
    assert.equal(browseFolder(tmp, 'filters'), path.join(tmp, 'browser', 'account-filters'), 'an account id never lands on a shared folder');
    for (const bad of ['../x', 'Bea', '', null, 'a'.repeat(33), 'default/..']) {
      assert.equal(validProfile(bad), null, String(bad));
      assert.throws(() => partitionFor(bad));
    }
  });

  await check('profiles: signing in as another account closes the first account\'s Browse', async () => {
    let who = 'default';
    const opened = [], closed = [], switched = [];
    const profiles = createBrowseProfiles({
      fetchProfile: async () => who,
      open: (profile) => { opened.push(profile); return { profile, close: () => closed.push(profile) }; },
      onSwitch: (profile) => switched.push(profile),
    });
    const [a, b] = await Promise.all([profiles.resolve(), profiles.resolve()]);
    assert.equal(a, b, 'one Browse, however many ask at once');
    assert.equal(a.profile, 'default');
    assert.equal((await profiles.resolve()).profile, 'default');
    assert.deepEqual(opened, ['default'], 'the same account keeps its Browse');
    who = 'bea123456789';
    assert.equal((await profiles.resolve()).profile, 'bea123456789');
    assert.deepEqual(closed, ['default'], 'the old account\'s tabs closed first');
    who = null;
    assert.equal(await profiles.resolve(), null, 'signed out: no Browse at all');
    assert.deepEqual(closed, ['default', 'bea123456789']);
    who = '../../evil';
    assert.equal(await profiles.resolve(), null, 'a malformed answer opens nothing');
    assert.deepEqual(switched, ['default', 'bea123456789', null]);
  });
}

module.exports = { passwordChecks, botPasswordChecks, audioChecks, profileChecks };
