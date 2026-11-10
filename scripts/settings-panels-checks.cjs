// A14 Settings panels: save / revert / reset through the real Settings renderer (Part 2, group a14-settings,
// 2026-10-28). Runs alone with `--a14-settings-only` (not in the default ui-smoke run).
//
// For Forge, Vault, Speech, Notifications, Appearance, Layout, Account and Shortcuts: change a control with a real
// click or input event, assert exactly which requests (and which local storage keys) it caused, close and reopen
// Settings (and reload the page where cheap) and assert the saved value is what comes back. Where a panel has no
// revert or reset control the test says so and instead proves what the person does get (unsaved text is dropped on
// close, a failed save leaves the saved value alone). Open chat, sidebar and Home are checked for live pickup.
//
// A page-side fetch wrapper records every /api call and plays the server for the routes the mocked backend lacks
// (auth status with sign-in on, vault-dir, password, two-factor); everything else goes to demo/fixtures.js.
// Real app findings are collected in `problems` and asserted at the end, so one run lists all of them.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, demoState, writes, base }) => {
  const problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(message); };
  const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
  const report = { requestsPerSave: {}, reopenMs: {}, reopenRequests: {} };

  // -- page-side network recorder and stub server -----------------------------------------------------------------
  const install = () => js(`(() => {
    if (window.__a14) return;
    const saved = JSON.parse(sessionStorage.getItem('a14-stub') || 'null');
    const S = window.__s = saved || { auth: false, vault: 'C:\\\\Users\\\\Alex\\\\Documents\\\\Vault', password: 'old-password-1', totp: false, fail: {} };
    const persist = () => sessionStorage.setItem('a14-stub', JSON.stringify(S));
    window.__net = []; window.__a14 = true; window.__unhandled = [];
    addEventListener('unhandledrejection', e => window.__unhandled.push(String(e.reason && e.reason.message || e.reason)));
    const real = window.fetch.bind(window);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    window.fetch = async (input, options = {}) => {
      const url = new URL(String(input && input.url || input), location.href), method = String(options.method || 'GET').toUpperCase();
      if (!url.pathname.startsWith('/api/')) return real(input, options);
      const key = method + ' ' + url.pathname, body = options.body ? JSON.parse(options.body) : null;
      window.__net.push({ key, body, at: performance.now() });
      if (S.fail[key]) return reply({ detail: S.fail[key] }, 400);
      if (key === 'GET /api/auth/status') { const j = await (await real(input, options)).json(); return reply({ ...j, auth_enabled: S.auth, totp_enabled: S.totp }); }
      if (key === 'GET /api/settings') { const j = await (await real(input, options)).json(); return reply({ ...j, vault_dir: S.vault }); }
      if (key === 'POST /api/settings/vault-dir') { S.vault = body.path; persist(); return reply({ vault_dir: S.vault }); }
      if (key === 'POST /api/auth/password') {
        if (body.current_password !== S.password) return reply({ detail: 'current password is incorrect' }, 401);
        S.password = body.new_password; persist(); return reply({ ok: true });
      }
      if (key === 'POST /api/auth/totp/enroll') return reply({ provisioning_uri: 'otpauth://totp/Kairos:Alex?secret=ABCDEF' });
      if (key === 'POST /api/auth/totp/confirm') { if (body.code !== '123456') return reply({ detail: 'That code did not match.' }, 400); S.totp = true; persist(); return reply({ ok: true }); }
      if (key === 'POST /api/auth/totp/disable') { S.totp = false; persist(); return reply({ ok: true }); }
      return real(input, options);
    };
  })()`);
  const stub = async (patch) => { await js(`Object.assign(window.__s, ${JSON.stringify(patch)}); sessionStorage.setItem('a14-stub', JSON.stringify(window.__s));`); await delay(1100); };  // shared reads last 1 s (api.js)
  const failing = (key, detail) => js(`window.__s.fail[${JSON.stringify(key)}] = ${JSON.stringify(detail)}`);
  const unfail = () => js('window.__s.fail = {}');
  const mark = () => js('window.__net.length');
  const since = (from) => js(`window.__net.slice(${from})`);
  const saves = async (from) => (await since(from)).filter(r => !r.key.startsWith('GET ')).map(r => r.key + (r.body ? ' ' + JSON.stringify(r.body) : ''));
  const reads = async (from) => (await since(from)).filter(r => r.key.startsWith('GET ')).map(r => r.key);
  const lsKey = (prefix) => js(`(() => { const k = Object.keys(localStorage).find(k => k.startsWith(${JSON.stringify(prefix)})); return k ? JSON.parse(localStorage.getItem(k)) : null; })()`);

  // -- Settings window helpers --------------------------------------------------------------------------------------
  const modalOpen = () => js("!!document.querySelector('.modal-backdrop:not(.hidden) .settings-window')");
  const close = async () => { if (await modalOpen()) await js(`document.querySelector('.settings-titlebar-btn[title="Close"]').click()`); await delay(120); };
  const ready = (id) => waitFor(`document.querySelector('.set-page')?.dataset.page === ${JSON.stringify(id)} && document.querySelector('.set-body')?.children.length > 0`, 15000);
  const open = async (id) => {
    await js(`import('/static/js/views/settings.js').then(m => m.openSettingsWindow(${JSON.stringify(id)}))`);
    await ready(id);
    await delay(60);
  };
  const reopen = async (id) => { await close(); await open(id); };
  const clickText = (text, scope = '.settings-window') => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button, ' + scope + ' label')})].find(n => n.textContent.trim() === ${JSON.stringify(text)} && !n.hidden); if (!b) throw new Error('no button ' + ${JSON.stringify(text)}); b.click(); })()`);
  const setValue = (selector, value, event = 'input') => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(value)}; n.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`);
  const value = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.value`);
  const switchOn = (label) => js(`document.querySelector('.settings-window .set-switch[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-checked') === 'true'`);
  const clickSwitch = (label) => js(`document.querySelector('.settings-window .set-switch[aria-label=${JSON.stringify(label)}]').click()`);
  const reload = async () => {
    await js('window.__a14 = false');
    await win.loadURL(base);
    await waitFor("!!document.querySelector('#nav .nav-item[data-tab]') && !!document.querySelector('.sidebar-settings-btn')", 20000);
    // Reads the app made at start-up are shared for a short while (api.js SHARE_MS); wait them out so the first panel read is fresh.
    await waitFor('performance.now() > 3500', 8000);
    await install();
  };
  const countSaves = (name, list, expected) => { report.requestsPerSave[name] = list.length; assert.deepEqual(list, expected, `${name}: exact requests for one save`); };

  win.setContentSize(1440, 900); await delay(350);
  demoState.isAdmin = true;
  await navigate('home');
  await install();

  // -- Shared image connection -------------------------------------------------------------------------------------
  {
    const input = name => '#image-provider-' + name;
    const panelText = () => js("document.querySelector('.image-connection')?.textContent || ''");
    const saved = async () => { await waitFor("[...document.querySelectorAll('.image-connection [role=status]')].some(n => n.textContent === 'Connection saved.')"); };
    const imageWrites = async from => (await since(from)).filter(r => r.key === 'PUT /api/image-provider').map(r => r.body);
    await open('images');
    await waitFor("!!document.querySelector('#image-provider-key')");
    assert.ok((await panelText()).includes('Not connected. Designs use openly licensed photos, your own photos and patterns instead.'));
    assert.equal(await value(input('model')), 'gpt-image-1', 'OpenAI model is filled');
    assert.equal(await js("document.querySelector('#image-provider-key').autocomplete"), 'off');
    await setValue(input('key'), 'sk-images-test');
    let from = await mark(); await clickText('Save'); await saved();
    assert.deepEqual(await imageWrites(from), [{ kind: 'openai', key: 'sk-images-test', model: 'gpt-image-1', daily_limit: 50 }]);
    assert.ok((await panelText()).includes('Connected: OpenAI, gpt-image-1. 0 of 50 images today.'));
    assert.equal(await value(input('key')), '', 'key is cleared after saving');
    assert.equal(await js("document.querySelector('#image-provider-key').placeholder"), 'Saved. Paste a new key to replace it');
    await setValue(input('limit'), '25'); from = await mark(); await clickText('Save'); await saved();
    assert.deepEqual(await imageWrites(from), [{ daily_limit: 25 }], 'limit-only update keeps the saved key');
    await clickText('Test connection');
    await waitFor("document.querySelector('.image-connection').textContent.includes('Works')");
    demoState.botsIdentity.testError = 'The server did not answer.';
    await clickText('Test connection');
    await waitFor("document.querySelector('.image-connection').textContent.includes('The server did not answer.')");
    delete demoState.botsIdentity.testError;
    await failing('PUT /api/image-provider', 'That model is unavailable.');
    await clickText('Save');
    await waitFor("[...document.querySelectorAll('.image-connection [role=status]')].some(n => n.textContent === 'That model is unavailable.')");
    await unfail();
    await clickText('Remove'); await waitFor("!!document.querySelector('.confirm-panel')");
    assert.ok((await panelText()).includes('Connected:'), 'connection stays until confirmed');
    await clickText('Cancel', '.confirm-panel');
    await clickText('Remove'); await waitFor("!!document.querySelector('.confirm-panel')");
    await clickText('Remove', '.confirm-panel');
    await waitFor("document.querySelector('.image-connection').textContent.includes('Not connected.')");
    await setValue(input('kind'), 'xai', 'change');
    assert.equal(await value(input('model')), 'grok-2-image', 'xAI model is filled');
    await setValue(input('kind'), 'compatible', 'change');
    assert.equal(await js("document.querySelector('#image-provider-address').closest('.set-row').hidden"), false, 'Compatible shows the address');
    assert.equal(await value(input('model')), '', 'Compatible asks for its model');
    await setValue(input('address'), 'https://images.example.test/v1');
    await setValue(input('model'), 'my-image-model');
    await setValue(input('key'), 'compatible-test-key');
    await setValue(input('limit'), '0');
    from = await mark(); await clickText('Save'); await saved();
    assert.deepEqual(await imageWrites(from), [{ kind: 'compatible', key: 'compatible-test-key', model: 'my-image-model', daily_limit: 0, base_url: 'https://images.example.test/v1' }]);
    for (const width of [1440, 390]) {
      await close(); win.setContentSize(width, 900); await delay(350);
      if (width === 390) {
        await js(`(async () => {
          const host = document.createElement('div'); host.id = 'image-phone-check'; host.className = 'settings-mobile-page';
          host.style.cssText = 'position:fixed;inset:0;z-index:100;background:var(--bg)'; document.body.append(host);
          await (await import('/static/js/views/settings.js')).renderMobilePage(host, 'images');
        })()`);
      } else await open('images');
      await waitFor("!!document.querySelector('#image-provider-key')");
      // The phone page slides in; measure once it has landed.
      await waitFor("document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)");
      const layout = await js(`(() => {
        const root = document.querySelector(${width === 390 ? "'#image-phone-check .image-connection'" : "'.image-connection'"});
        const controls = [...root.querySelectorAll('input,select')].filter(n => n.getClientRects().length);
        return { labelled: controls.every(n => n.labels.length && n.labels[0].textContent.trim()),
          targets: [...controls, ...root.querySelectorAll('button')].every(n => n.getBoundingClientRect().height >= 44),
          fits: [root, ...root.querySelectorAll('*')].filter(n => n.getClientRects().length).every(n => {
            const r = n.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1 && n.scrollWidth <= n.clientWidth + 1;
          }) };
      })()`);
      assert.ok(layout.labelled, width + ': every input has a visible label');
      assert.ok(layout.fits, width + ': no sideways scroll');
      if (width === 390) assert.ok(layout.targets, 'phone controls are at least 44px tall');
    }
    await js("document.getElementById('image-phone-check')?.remove()");
    win.setContentSize(1440, 900); await delay(350);
  }

  // -- 1. Forge -----------------------------------------------------------------------------------------------------
  {
    const rootSel = 'input[aria-label="Forge root folder"]';
    await open('forge');
    const original = await value(rootSel);
    assert.ok(original.length > 3, 'Forge shows the saved root folder');
    // No revert button exists: typed-but-unsaved text is simply dropped when Settings closes.
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].filter(b => /revert|cancel|reset|undo/i.test(b.textContent)).length"), 0, 'Forge has no revert or reset control');
    await setValue(rootSel, 'C:\\Users\\Alex\\typed-not-saved');
    let from = await mark();
    await reopen('forge');
    assert.equal(await value(rootSel), original, 'Forge: closing without saving drops the typed text and shows the saved folder');
    assert.deepEqual(await saves(from), [], 'Forge: closing without saving sends nothing');

    const next = 'C:\\Users\\Alex\\Documents\\Forge Work';
    await setValue(rootSel, next); from = await mark();
    await clickText('Save folder');
    await waitFor(`window.__net.slice(${from}).some(r => r.key === 'PUT /api/forge/root')`);
    await delay(150);
    countSaves('forge root', await saves(from), ['PUT /api/forge/root ' + JSON.stringify({ path: next })]);
    assert.equal(await value(rootSel), next, 'Forge: the field shows the path the server returned');
    assert.equal(demoState.forgeRoot, next, 'Forge: the server holds the saved folder');
    assert.equal(await js("document.querySelector('.settings-window .btn[type=button]:not([disabled])') !== null"), true);
    await reopen('forge');
    assert.equal(await value(rootSel), next, 'Forge: reopening Settings shows the saved folder');
    await reload(); await open('forge');
    assert.equal(await value(rootSel), next, 'Forge: after a page reload the saved folder is still there');

    // A save the server refuses leaves the saved folder alone and re-enables Save.
    await setValue(rootSel, 'C:\\Users\\Alex\\not-allowed'); await failing('PUT /api/forge/root', 'That folder is not allowed.');
    from = await mark(); await clickText('Save folder'); await delay(300);
    assert.equal((await saves(from)).length, 1, 'Forge: a refused save is one request');
    assert.equal(demoState.forgeRoot, next, 'Forge: a refused save leaves the server value');
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].find(b => b.textContent.trim() === 'Save folder').disabled"), false, 'Forge: Save is usable again after a refusal');
    await unfail();
    await reopen('forge');
    assert.equal(await value(rootSel), next, 'Forge: after a refused save, reopening shows the saved folder');

    // Terminal over Remote Access switch: save, persist, and go back when the save fails.
    const sw = 'Allow the terminal over Remote Access';
    assert.equal(await switchOn(sw), false, 'Forge terminal switch starts off');
    from = await mark(); await clickSwitch(sw); await delay(250);
    countSaves('forge terminal switch', await saves(from), ['PUT /api/forge/terminal/settings ' + JSON.stringify({ enabled: true })]);
    assert.equal(await switchOn(sw), true);
    await reopen('forge');
    assert.equal(await switchOn(sw), true, 'Forge terminal switch: still on after reopening');
    await failing('PUT /api/forge/terminal/settings', 'Not now.');
    from = await mark(); await clickSwitch(sw); await delay(300);
    assert.equal(await switchOn(sw), true, 'Forge terminal switch: a refused change goes back to the saved state (revert)');
    assert.equal(demoState.forgeTerminalRemote, true, 'Forge terminal switch: the server kept true');
    await unfail();
    await clickSwitch(sw); await delay(250);
    assert.equal(demoState.forgeTerminalRemote, false, 'Forge terminal switch: turning it off saves false');
    await close();
    demoState.forgeRoot = undefined; demoState.forgeTerminalRemote = false;
  }

  // -- 2. Vault -----------------------------------------------------------------------------------------------------
  {
    const folder = () => js("document.querySelector('.settings-window .set-mono')?.textContent");
    await open('vault');
    const original = await folder();
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].find(b => b.textContent.startsWith('Choose folder')).disabled"), true, 'Vault: in a browser (no desktop bridge) Choose folder is disabled');
    await close();
    const picked = 'C:\\Users\\Alex\\Documents\\Other Vault';
    await js(`window.jarvis = { pickVaultFolder: async () => window.__pick }; window.__pick = ${JSON.stringify(picked)};`);
    await open('vault');
    assert.equal(await folder(), original);
    // Cancelling the folder picker sends nothing and changes nothing (the Vault's "revert").
    await js('window.__pick = null');
    let from = await mark(); await clickText('Choose folder…'); await delay(250);
    assert.deepEqual(await saves(from), [], 'Vault: cancelling the picker sends nothing');
    assert.equal(await folder(), original, 'Vault: cancelling the picker keeps the folder');
    // Choosing a folder: one POST, one re-read, new path shown.
    await js(`window.__pick = ${JSON.stringify(picked)}`);
    from = await mark(); await clickText('Choose folder…');
    await waitFor(`document.querySelector('.settings-window .set-mono')?.textContent === ${JSON.stringify(picked)}`);
    countSaves('vault folder', await saves(from), ['POST /api/settings/vault-dir ' + JSON.stringify({ path: picked })]);
    assert.deepEqual(await reads(from), ['GET /api/settings'], 'Vault: one re-read after the save');
    await reopen('vault');
    assert.equal(await folder(), picked, 'Vault: reopening shows the saved folder');
    await reload(); await js(`window.jarvis = { pickVaultFolder: async () => window.__pick }; window.__pick = null`); await open('vault');
    assert.equal(await folder(), picked, 'Vault: after a reload the saved folder is still there');
    // A refused folder: the shown path stays the saved one.
    await js(`window.__pick = 'Z:\\\\nowhere'`); await failing('POST /api/settings/vault-dir', 'That folder does not exist.');
    from = await mark(); await clickText('Choose folder…'); await delay(350);
    assert.equal(await folder(), picked, 'Vault: a refused folder keeps the saved folder');
    const unhandled = await js('window.__unhandled');
    expect(unhandled.length === 0, `VAULT PICK refused folder raises an unhandled promise rejection in the renderer (${unhandled.join('; ')}): static/js/views/settings.js:1241-1246 awaits api() in the click handler with no try/catch. Fix: wrap the POST and re-render in try { ... } catch { /* api() already toasts */ }.`);
    await unfail();
    // Existing chats: the panel says open chats keep the old vault until reconnected; there is nothing to pick up.
    assert.ok((await js("document.querySelector('.settings-window').textContent")).includes('Open chats keep their old vault until reconnected'), 'Vault says open chats keep the old vault');
    await close();
    await js('delete window.jarvis; window.__unhandled.length = 0');
    await stub({ vault: 'C:\\Users\\Alex\\Documents\\Vault' });
  }

  // -- 3. Speech ----------------------------------------------------------------------------------------------------
  {
    await js(`(() => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
        { kind: 'audioinput', deviceId: 'dev-desk-111111', label: 'Desk microphone' }, { kind: 'audioinput', deviceId: 'dev-head-222222', label: 'Headset' }] });
      window.__voices = [{ name: 'Test Voice A', lang: 'en-US' }, { name: 'Test Voice B', lang: 'en-GB' }];
      Object.defineProperty(window.speechSynthesis, 'getVoices', { configurable: true, value: () => window.__voices });
      localStorage.removeItem('jarvis:speech-input-device'); localStorage.removeItem('jarvis:speech-voice');
    })()`);
    await open('speech'); await waitFor("!!document.querySelector('#speech-input-device') && !!document.querySelector('#speech-voice')");
    // Voice engines (voiceEnginesSetup.js): ElevenLabs and VoiceStudio, keys as password fields, a free Check, plain copy.
    await waitFor("!!document.querySelector('.speech-voice-engines [data-voice-engine=\"voicestudio\"]')");
    const engines = await js(`(() => { const g = document.querySelector('.speech-voice-engines'); return {
      eleven: !!g.querySelector('[data-voice-engine="elevenlabs-key"][type="password"]') && !!g.querySelector('[data-voice-engine="elevenlabs-check"]'),
      studio: g.querySelector('[data-voice-engine="voicestudio-url"]')?.value, studioKey: g.querySelector('[data-voice-engine="voicestudio-key"]')?.type,
      cost: g.textContent.includes('per 1,000 characters'), privacy: g.textContent.includes('sent to ElevenLabs'), dash: /—/.test(g.textContent) }; })()`);
    assert.deepEqual(engines, { eleven: true, studio: 'http://127.0.0.1:3900', studioKey: 'password', cost: true, privacy: true, dash: false }, 'Speech: voice engines offer ElevenLabs and VoiceStudio with a free Check and plain cost and privacy copy');
    assert.equal(await value('#speech-input-device'), '', 'Speech: starts on the system default microphone');
    let from = await mark();
    await setValue('#speech-input-device', 'dev-head-222222', 'change');
    assert.equal(await js("localStorage.getItem('jarvis:speech-input-device')"), 'dev-head-222222', 'Speech: the microphone choice is saved on this device');
    await setValue('#speech-voice', 'Test Voice B', 'change');
    assert.equal(await js("localStorage.getItem('jarvis:speech-voice')"), 'Test Voice B', 'Speech: the voice choice is saved on this device');
    countSaves('speech microphone + voice (two saves)', await saves(from), []);
    // Open chats read the choice at the moment they start recording (voiceInput.js:241), so the module value is what they use.
    const asked = await js(`(async () => { const input = await import('/static/js/voiceInput.js'), out = await import('/static/js/voiceOutput.js'); return { device: input.getInputDevice(), voice: out.getPreferredVoice() }; })()`);
    assert.deepEqual(asked, { device: 'dev-head-222222', voice: 'Test Voice B' }, 'Speech: the modules every chat uses report the new choices at once');
    await reopen('speech'); await waitFor("!!document.querySelector('#speech-input-device') && !!document.querySelector('#speech-voice')");
    assert.equal(await value('#speech-input-device'), 'dev-head-222222', 'Speech: reopening shows the saved microphone');
    assert.equal(await value('#speech-voice'), 'Test Voice B', 'Speech: reopening shows the saved voice');
    await reload();
    await js(`(() => {
      Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
        { kind: 'audioinput', deviceId: 'dev-desk-111111', label: 'Desk microphone' }, { kind: 'audioinput', deviceId: 'dev-head-222222', label: 'Headset' }] });
      Object.defineProperty(window.speechSynthesis, 'getVoices', { configurable: true, value: () => [{ name: 'Test Voice A', lang: 'en-US' }, { name: 'Test Voice B', lang: 'en-GB' }] });
    })()`);
    await open('speech'); await waitFor("!!document.querySelector('#speech-input-device') && !!document.querySelector('#speech-voice')");
    assert.equal(await value('#speech-input-device'), 'dev-head-222222', 'Speech: microphone survives a reload');
    assert.equal(await value('#speech-voice'), 'Test Voice B', 'Speech: voice survives a reload');
    // The reset path is the first option in each list ("System default" / "Automatic"): choosing it deletes the saved value.
    await setValue('#speech-input-device', '', 'change'); await setValue('#speech-voice', '', 'change');
    assert.equal(await js("localStorage.getItem('jarvis:speech-input-device') === null && localStorage.getItem('jarvis:speech-voice') === null"), true, 'Speech: System default / Automatic remove the saved choices');
    await reopen('speech'); await waitFor("!!document.querySelector('#speech-input-device')");
    assert.equal(await value('#speech-input-device') + '|' + await value('#speech-voice'), '|', 'Speech: defaults show after reopening');
    // No revert or Reset button: the panel has no Save step either, every choice saves on change.
    assert.equal(await js("[...document.querySelectorAll('.settings-window .speech-panel button')].filter(b => /revert|cancel|reset/i.test(b.textContent)).length"), 0, 'Speech has no revert or reset control (the default option is the reset)');
    await close();
  }

  // -- 4. Notifications ---------------------------------------------------------------------------------------------
  {
    await js("localStorage.removeItem('kairos:bot-notifications')");
    await open('notifications');
    const labels = ['Bot notifications', 'Needs you', 'Results'];
    for (const label of labels) assert.equal(await switchOn(label), true, `Notifications: ${label} starts on`);
    let from = await mark();
    await clickSwitch('Bot notifications'); await delay(80);
    countSaves('notifications bot switch', await saves(from), []);
    assert.deepEqual(await js("JSON.parse(localStorage.getItem('kairos:bot-notifications'))"), { enabled: false, needs_you: true, results: true }, 'Notifications: the switch saves to this device');
    // Existing watchers read prefs() on every poll: a plan for a new question is empty now.
    const plan = (kind) => js(`import('/static/js/botNotifications.js').then(m => m.plan([{ key: 'item:1', agentId: 'a1', kind: ${JSON.stringify(kind)}, title: 'Q?' }], { names: { a1: 'Scout' } }).length)`);
    assert.equal(await plan('needs_you'), 0, 'Notifications: with Bot notifications off, a bot question makes no notification');
    await clickSwitch('Bot notifications'); await delay(80);
    assert.equal(await plan('needs_you'), 1, 'Notifications: turned back on, the next question notifies (no restart)');
    await clickSwitch('Needs you'); await delay(80);
    assert.equal(await plan('needs_you') + '/' + await plan('results'), '0/1', 'Notifications: Needs you off silences only questions');
    await reopen('notifications');
    assert.deepEqual([await switchOn('Bot notifications'), await switchOn('Needs you'), await switchOn('Results')], [true, false, true], 'Notifications: reopening shows the saved switches');
    await reload(); await open('notifications');
    assert.deepEqual([await switchOn('Bot notifications'), await switchOn('Needs you'), await switchOn('Results')], [true, false, true], 'Notifications: switches survive a reload');
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].filter(b => /revert|reset|cancel/i.test(b.textContent)).length"), 0, 'Notifications has no revert or reset control');
    // Phone and browser push needs an HTTPS Remote Access page, so its device switches cannot be driven here.
    assert.ok((await js("document.querySelector('.settings-window .set-body').textContent")).includes('Open Kairos through HTTPS Remote Access'), 'Notifications: on plain http the push section explains why it is unavailable (device preferences: MANUAL)');
    await clickSwitch('Needs you'); await delay(60);
    await close();
  }

  // -- 5. Appearance --------------------------------------------------------------------------------------------------
  {
    await js("Object.keys(localStorage).filter(k => k.startsWith('jarvis:appearance:v1:')).forEach(k => localStorage.removeItem(k))");
    // An open chat with messages, behind Settings.
    await navigate('chat', { sessionId: 's1' });
    await waitFor("document.querySelectorAll('#chat-messages .msg.user .msg-body').length > 0", 15000);
    const bubble = () => js("getComputedStyle(document.querySelector('#chat-messages .msg.user .msg-body'), '::before').content");
    const sidebarBg = () => js("getComputedStyle(document.querySelector('#sidebar')).backgroundColor");
    const saved = () => lsKey('jarvis:appearance:v1:');
    const baseBubble = await bubble(), baseSidebar = await sidebarBg();
    assert.ok(baseBubble === 'none' || baseBubble === 'normal', 'Appearance: a standard chat has no terminal prompt');
    await open('appearance');
    let from = await mark();
    await js("document.querySelector('.settings-window [data-mode=color]').click()");
    await js("document.querySelector('.settings-window [data-color=\"#233447\"]').click()");
    await js("document.querySelector('.settings-window [data-chat-style=terminal]').click()");
    await setValue('#appearance-effect-density', '9');
    await delay(150);
    assert.deepEqual(await saves(from), [], 'Appearance: every change saves on this device with zero server requests');
    report.requestsPerSave.appearance = 0;
    const stored = await saved();
    assert.equal(stored.mode, 'color'); assert.equal(stored.color, '#233447'); assert.equal(stored.chatStyle, 'terminal');
    assert.equal(stored.effectOptions[stored.backgroundEffect].density, 9, 'Appearance: the effect density is saved per effect');
    assert.match(String(await bubble()), /you/, 'Appearance: the open chat switched to terminal prompt lines at once');
    assert.notEqual(await sidebarBg(), baseSidebar, 'Appearance: the sidebar changed colour at once');
    assert.ok((await js("document.querySelector('.settings-window .appearance-status').textContent")).includes('Saved for this user on this device'), 'Appearance: the page says where it saved');
    const live = await sidebarBg();
    await reopen('appearance');
    assert.equal(await js("document.querySelector('.settings-window [data-mode=color]').getAttribute('aria-pressed')"), 'true', 'Appearance: reopening shows the saved mode');
    assert.equal(await js("document.querySelector('.settings-window [data-color=\"#233447\"]').getAttribute('aria-pressed')"), 'true', 'Appearance: reopening shows the saved colour');
    assert.equal(await js("document.querySelector('.settings-window [data-chat-style=terminal]').getAttribute('aria-pressed')"), 'true', 'Appearance: reopening shows the saved chat style');
    assert.equal(await value('#appearance-effect-density'), '9', 'Appearance: reopening shows the saved density');
    await close();
    await reload();
    assert.equal(await js("document.documentElement.dataset.chatStyle"), 'terminal', 'Appearance: chat style survives a reload');
    assert.equal(await sidebarBg(), live, 'Appearance: colour survives a reload');
    await navigate('chat', { sessionId: 's1' });
    await waitFor("document.querySelectorAll('#chat-messages .msg.user .msg-body').length > 0", 15000);
    assert.match(String(await bubble()), /you/, 'Appearance: a chat opened after a reload is in terminal style');
    // Reset appearance (the page header button) restores and saves the defaults.
    await open('appearance');
    from = await mark();
    await clickText('Reset appearance'); await delay(500);
    const defaults = await saved();
    assert.equal(defaults.mode, 'default'); assert.equal(defaults.chatStyle, 'standard');
    assert.notEqual(defaults.effectOptions[defaults.backgroundEffect].density, 9, 'Appearance: Reset puts the effect density back');
    assert.deepEqual(await saves(from), [], 'Appearance: Reset sends no server request');
    assert.equal(await js("document.documentElement.dataset.chatStyle"), 'standard', 'Appearance: Reset restores the chat style on the page');
    assert.equal(await sidebarBg(), baseSidebar, 'Appearance: Reset restores the sidebar');
    await js("document.querySelector('.modal-backdrop:not(.hidden) .settings-titlebar-btn[title=Close]')?.click()");
    await delay(150);
    const afterReset = await bubble();
    assert.ok(afterReset === 'none' || afterReset === 'normal', 'Appearance: the open chat is back to bubbles after Reset');
    await open('appearance');
    assert.equal(await js("document.querySelector('.settings-window [data-mode=default]').getAttribute('aria-pressed')"), 'true', 'Appearance: reopening after Reset shows Kairos');
    // The notch rows talk to the desktop shell: a stub plays the shell and records each call.
    await js(`(() => {
      const state = { supported: true, visible: false, edge: 'top-centre', displayId: null, offset: .5, foldOnHover: true,
        displays: [{ id: 1, label: 'Main display' }, { id: 2, label: 'Side display' }] };
      window.__notch = { calls: [], state };
      window.jarvis = { usageOverlay: { state: async () => ({ ...state }), onState: () => () => {},
        setVisible: async v => { window.__notch.calls.push(['setVisible', v]); state.visible = v; return { ...state }; },
        setConfig: async c => { window.__notch.calls.push(['setConfig', c]); Object.assign(state, c); return { ...state }; } } };
    })()`);
    await reopen('appearance');
    await waitFor("!document.querySelector('#usage-overlay-edge').disabled");
    await js("document.querySelector('#usage-overlay-toggle').click()"); await delay(120);
    await setValue('#usage-overlay-edge', 'left', 'change'); await delay(120);
    await js("document.querySelector('#usage-overlay-fold').click()"); await delay(120);
    await setValue('#usage-overlay-display', '2', 'change'); await delay(120);
    assert.deepEqual(await js('window.__notch.calls'), [['setVisible', true], ['setConfig', { edge: 'left' }], ['setConfig', { foldOnHover: false }], ['setConfig', { displayId: 2 }]], 'Appearance: each notch control calls the desktop shell once with its value');
    await reopen('appearance'); await waitFor("!document.querySelector('#usage-overlay-edge').disabled");
    assert.equal(await js("document.querySelector('#usage-overlay-toggle').getAttribute('aria-checked') + '|' + document.querySelector('#usage-overlay-edge').value + '|' + document.querySelector('#usage-overlay-fold').getAttribute('aria-checked') + '|' + document.querySelector('#usage-overlay-display').value"), 'true|left|false|2', 'Appearance: reopening shows the notch settings the shell holds');
    await js('delete window.jarvis');
    await close();
    await navigate('home');
  }

  // -- 6. Layout ----------------------------------------------------------------------------------------------------
  {
    await js("Object.keys(localStorage).filter(k => k.startsWith('kairos:layout:v1:')).forEach(k => localStorage.removeItem(k))");
    await js("document.dispatchEvent(new CustomEvent('kairos:layout'))");
    await navigate('home'); await delay(300);
    // The desktop redesign keeps the full ordered list in #rd-all-tabs; #nav is its pinned strip.
    const tabs = () => js("[...document.querySelectorAll(document.querySelector('#rd-all-tabs') ? '#rd-all-tabs .nav-item[data-tab]' : '#nav .nav-item[data-tab]')].map(n => n.dataset.tab)");
    const homeIds = () => js("[...document.querySelectorAll('[data-home-section]')].map(n => n.dataset.homeSection)");
    const layoutStore = () => lsKey('kairos:layout:v1:');
    const defaultTabs = await tabs(), defaultHome = await homeIds();
    // Bots left the sidebar for its own mode (Bots Phase 1, layout.js DEFAULT_GROUPS); the order is checked on the Workspace group.
    assert.deepEqual(defaultTabs.slice(0, 4), ['home', 'chat', 'notes', 'library'], 'Layout: default sidebar order');
    await open('layout'); await waitFor("document.querySelectorAll('.settings-window .layout-item').length > 8");
    let from = await mark();
    // Move Notes below Library with its arrow: saved at once, sidebar follows with no reload.
    await js("document.querySelector('.settings-window .layout-list[data-group=workspace] [aria-label=\"Move Notes down\"]').click()"); await delay(250);
    assert.deepEqual((await layoutStore()).groups.workspace.slice(0, 2), ['library', 'notes'], 'Layout: the new order is saved');
    assert.deepEqual((await tabs()).slice(2, 4), ['library', 'notes'], 'Layout: the sidebar followed live');
    // Hide Calendar and a Home card.
    await clickSwitch('Show Calendar'); await delay(250);
    assert.ok((await layoutStore()).hiddenTabs.includes('calendar'), 'Layout: hidden tab is saved');
    assert.ok(!(await tabs()).includes('calendar'), 'Layout: the sidebar dropped the hidden tab live');
    await clickSwitch('Show Recent chats'); await delay(300);
    assert.ok((await layoutStore()).hiddenHome.includes('chats'), 'Layout: hidden Home card is saved');
    const homeNow = await homeIds();
    expect(defaultHome.includes('chats') ? !homeNow.includes('chats') : true, `LAYOUT Home still shows "chats" after it was hidden in Layout while Settings was open (data-home-section: ${homeNow.join(',')})`);
    countSaves('layout (three changes)', await saves(from), []);
    report.requestsPerSave.layout = 0;
    await reopen('layout');
    assert.equal(await switchOn('Show Calendar'), false, 'Layout: reopening shows Calendar hidden');
    assert.equal(await switchOn('Show Recent chats'), false, 'Layout: reopening shows Recent chats hidden');
    assert.deepEqual(await js("[...document.querySelectorAll('.settings-window .layout-list[data-group=main] .layout-item')].map(n => n.dataset.id).slice(0, 2)"), ['home', 'chat'], 'Layout: reopening keeps the main group');
    assert.deepEqual(await js("[...document.querySelectorAll('.settings-window .layout-list[data-group=workspace] .layout-item')].map(n => n.dataset.id).slice(0, 2)"), ['library', 'notes'], 'Layout: reopening shows the saved order');
    await close();
    await reload();
    assert.deepEqual((await tabs()).slice(2, 4), ['library', 'notes'], 'Layout: order survives a reload');
    assert.ok(!(await tabs()).includes('calendar'), 'Layout: hidden tab survives a reload');
    // Reset sidebar restores order and tabs but not Home; Reset Home restores Home.
    await open('layout'); await waitFor("document.querySelectorAll('.settings-window .layout-item').length > 8");
    await clickText('Reset sidebar'); await delay(250);
    let store = await layoutStore();
    assert.deepEqual([store.groups.main, store.groups.workspace.slice(0, 2)], [['home', 'chat'], ['notes', 'library']], 'Layout: Reset sidebar restores the order');
    assert.deepEqual(store.hiddenTabs, [], 'Layout: Reset sidebar shows every tab again');
    assert.deepEqual((await tabs()).slice(0, 4), ['home', 'chat', 'notes', 'library'], 'Layout: the sidebar went back at once');
    assert.ok(store.hiddenHome.includes('chats'), 'Layout: Reset sidebar leaves Home alone');
    await clickText('Reset Home'); await delay(300);
    store = await layoutStore();
    assert.deepEqual(store.hiddenHome, ['needs', 'working'], 'Layout: Reset Home restores the default hidden cards');
    assert.equal(await switchOn('Show Recent chats'), true, 'Layout: Reset Home redraws the switches');
    // Reset buttons are the only way back; there is no revert.
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].filter(b => /revert|cancel/i.test(b.textContent)).length"), 0, 'Layout has no revert control (Reset sidebar and Reset Home only)');
    await close();
    { const ids = await homeIds(); assert.ok(ids.includes('chats') && !ids.includes('needs') && !ids.includes('working'), 'Layout: Home shows Recent chats again and the default-hidden cards stay hidden ' + ids.join(',')); }
  }

  // -- 7. Account ---------------------------------------------------------------------------------------------------
  {
    await open('account');
    assert.ok((await js("document.querySelector('.settings-window .set-body').textContent")).includes('Sign-in is off'), 'Account: with sign-in off the page says there is nothing to manage');
    await close();
    await stub({ auth: true, password: 'old-password-1', totp: false });
    await open('account');
    const cur = 'input[autocomplete="current-password"]', nxt = 'input[autocomplete="new-password"]';
    assert.equal(await value(cur) + await value(nxt), '', 'Account: password fields start empty');
    // Wrong current password: the error shows, nothing is changed, the typed values stay for another try.
    await setValue(cur, 'wrong'); await setValue(nxt, 'brand-new-pass-2');
    let from = await mark(); await clickText('Change password'); await delay(300);
    countSaves('account password (refused)', await saves(from), ['POST /api/auth/password ' + JSON.stringify({ current_password: 'wrong', new_password: 'brand-new-pass-2' })]);
    assert.equal(await js("document.querySelector('.settings-window .set-error').textContent"), 'current password is incorrect', 'Account: refusal shows the server message');
    assert.equal(await js("window.__s.password"), 'old-password-1', 'Account: a refused change leaves the password');
    assert.equal(await value(nxt), 'brand-new-pass-2', 'Account: a refusal keeps what was typed');
    // Right current password.
    await setValue(cur, 'old-password-1'); from = await mark(); await clickText('Change password'); await delay(300);
    countSaves('account password', await saves(from), ['POST /api/auth/password ' + JSON.stringify({ current_password: 'old-password-1', new_password: 'brand-new-pass-2' })]);
    assert.equal(await js("document.querySelector('.settings-window .set-error').textContent"), '', 'Account: the error clears on success');
    assert.ok((await js("document.querySelector('.settings-window .set-body').textContent")).includes('Password changed.'), 'Account: success is announced');
    assert.equal(await value(cur) + await value(nxt), '', 'Account: both fields are emptied after a change');
    assert.equal(await js('window.__s.password'), 'brand-new-pass-2', 'Account: the server holds the new password');
    await setValue(nxt, 'half-typed'); await reopen('account');
    assert.equal(await value(nxt), '', 'Account: closing and reopening drops typed passwords (never stored)');
    // Two-factor: enable, bad code, good code, disable.
    from = await mark(); await clickText('Enable'); await waitFor("!document.querySelector('.set-totp-setup').hidden");
    assert.ok((await js("document.querySelector('.set-totp-setup').textContent")).includes('otpauth://totp/Kairos:Alex'), 'Account: enrolling shows the provisioning URI');
    await setValue('input[placeholder="6-digit code"]', '000000'); await clickText('Confirm'); await delay(250);
    assert.ok((await js("document.querySelector('.set-totp-setup').textContent")).includes('That code did not match.'), 'Account: a wrong code is explained');
    assert.equal(await js('window.__s.totp'), false, 'Account: a wrong code leaves two-factor off');
    await setValue('input[placeholder="6-digit code"]', '123456'); await clickText('Confirm'); await delay(300);
    countSaves('account two-factor (enable, wrong code, right code)', await saves(from), [
      'POST /api/auth/totp/enroll', 'POST /api/auth/totp/confirm ' + JSON.stringify({ code: '000000' }), 'POST /api/auth/totp/confirm ' + JSON.stringify({ code: '123456' })]);
    assert.equal(await js('window.__s.totp'), true, 'Account: the right code turns two-factor on');
    assert.equal(await js("document.querySelector('.set-totp-setup').hidden"), true, 'Account: the setup box closes after confirming');
    await reopen('account');
    // The panel never says whether two-factor is on (both Enable and Disable are always shown).
    const buttons = await js("[...document.querySelectorAll('.settings-window .set-totp-setup')].length && [...document.querySelectorAll('.settings-window button')].map(b => b.textContent.trim() + (b.hidden || b.disabled ? '(off)' : '')).filter(t => /^(Enable|Disable)/.test(t))");
    expect(JSON.stringify(buttons) !== JSON.stringify(['Enable', 'Disable']), `ACCOUNT two-factor state is invisible: with two-factor ON the reopened page shows both "Enable" and "Disable" and no status (static/js/views/settings.js:1486-1516, no GET of the current state). Fix: read the user's totp flag from /api/auth/status and show Enable or Disable plus a "Two-factor is on" pill.`);
    from = await mark(); await clickText('Disable'); await delay(250);
    assert.deepEqual(await saves(from), ['POST /api/auth/totp/disable'], 'Account: Disable is one request');
    assert.equal(await js('window.__s.totp'), false, 'Account: Disable turns it off');
    assert.equal(await js("[...document.querySelectorAll('.settings-window button')].filter(b => /revert|reset|cancel/i.test(b.textContent)).length"), 0, 'Account has no revert or reset control (a half-done enrolment is dropped on close)');
    await close();
    await stub({ auth: false, totp: false });
  }

  // -- 8. Shortcuts -------------------------------------------------------------------------------------------------
  {
    await open('shortcuts');
    assert.deepEqual(await js("[...document.querySelectorAll('.settings-window .set-section-title')].map(n => n.textContent)"), ['Anywhere', 'Composer', 'Chat', 'Documents'], 'Shortcuts: four groups');
    assert.equal(await js("document.querySelectorAll('.settings-window .set-body input, .settings-window .set-body select, .settings-window .set-body textarea, .settings-window .set-body .set-switch').length"), 0, 'Shortcuts: the page is read-only (no input, switch or select to save)');
    assert.equal(await js("[...document.querySelectorAll('.settings-window .set-body button')].length"), 0, 'Shortcuts: no save, revert or reset button');
    let from = await mark();
    await js(`window.jarvis = { screenGrab: { shortcut: async () => 'CommandOrControl+Alt+K' } }; 0`);
    await reopen('shortcuts'); await delay(150);
    assert.ok((await js("document.querySelector('.settings-window .set-body').textContent")).includes('Ctrl + Alt + K'), 'Shortcuts: shows the Quick Entry key the desktop shell reports');
    await js(`window.jarvis = { screenGrab: { shortcut: async () => '' } }; 0`);
    await reopen('shortcuts'); await delay(150);
    assert.ok((await js("document.querySelector('.settings-window .set-body').textContent")).includes('Tray menu'), 'Shortcuts: a copy with no global key says Tray menu');
    assert.deepEqual(await saves(from), [], 'Shortcuts: opening it writes nothing');
    await js('delete window.jarvis');
    // The note under Quick Entry says the key can be changed in Settings; Settings has no control for it
    // (the setter lives only in the Quick Entry window: electron/screen-grab-quick.js:82).
    await js(`window.jarvis = { screenGrab: { shortcut: async () => 'CommandOrControl+Shift+6' } }; 0`);
    await reopen('shortcuts'); await delay(150);
    const note = await js("document.querySelector('.settings-window .set-body').textContent.includes('You can change this in Settings.')");
    expect(!note, 'SHORTCUTS the Quick Entry row says "You can change this in Settings." but the Shortcuts page is read-only and no other Settings page sets it (the setter is only in the Quick Entry window, electron/screen-grab-quick.js:82; text at static/js/shortcuts.js:36). Fix: say "Change it from the Quick Entry window." or add a key field here.');
    await js('delete window.jarvis');
    await close();
  }

  // -- 9. Efficiency: reopen latency and requests ------------------------------------------------------------------
  {
    await stub({ auth: true });
    for (const id of ['forge', 'vault', 'speech', 'notifications', 'appearance', 'layout', 'account', 'shortcuts']) {
      await open(id); await close();           // first open warms module imports and caches
      const times = [], counts = [], dupes = [];
      for (let i = 0; i < 12; i++) {
        await close();
        const from = await mark(), started = Date.now();
        await open(id);
        times.push(Date.now() - started - 60);   // open() waits 60 ms after readiness
        await delay(120);
        const batch = await reads(from);
        counts.push(batch.length);
        const seen = {}; for (const r of batch) seen[r] = (seen[r] || 0) + 1;
        dupes.push(Object.entries(seen).filter(([, n]) => n > 1).map(([p, n]) => `${p} x${n}`));
      }
      report.reopenMs[id] = { p50: percentile(times, .5), p95: percentile(times, .95) };
      report.reopenRequests[id] = { requests: percentile(counts, .5), duplicates: dupes.find(d => d.length) || [] };
      // /api/auth/status is read by Settings itself once per open; a path read twice per open is waste.
      const real = (report.reopenRequests[id].duplicates).filter(d => !d.startsWith('GET /api/auth/status'));
      expect(!real.length, `EFFICIENCY ${id}: reopen reads one path more than once (${real.join(', ')})`);
    }
    await close();
    await stub({ auth: false });
  }

  console.log('A14_SETTINGS_PANELS ' + JSON.stringify(report));
  assert.deepEqual(problems, [], 'Settings panel findings:\n' + problems.join('\n'));
};
