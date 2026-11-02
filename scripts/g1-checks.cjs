// Part 2, group g1: A02 (Kip, appearance and rendering) and A03 (Home).
// Run alone: node scripts/run-electron-test.cjs ui-smoke --g1-only
// (one section: --g1-section=theme|kip|chat|home|stress|bench). Not part of the default ui-smoke run.
// Every section runs even if an earlier one fails; failures are reported together at the end.
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, delay, navigate, capture, writes, reads, demoState, base, fixtures }) => {
  const only = (process.argv.find(a => a.startsWith('--g1-section=')) || '').split('=')[1] || '';
  const failures = [], bench = {};
  const section = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    try { await fn(); console.log(`g1 section ${name}: ok (${Date.now() - t0} ms)`); }
    catch (error) { failures.push(`[${name}] ${error.message.split('\nRenderer expression')[0]}`); console.log(`g1 section ${name}: FAILED ${error.message.split('\n')[0]}`); }
  };
  const soft = (ok, message) => { if (!ok) { failures.push('[soft] ' + message); console.log('g1 soft failure: ' + message); } };
  const stopAll = () => js(`Promise.all(['s1', 's2', 's3', 'g1-run', 'g1-run2', 'g1-working'].map(id => fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: id }) }))).then(() => true)`);
  const view = () => js("document.getElementById('view-content').dataset.view");
  const appearance = patch => js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(patch)}))`);
  const getAppearance = () => js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return { mode: a.mode, color: a.color, kip: a.kip, mascot: a.mascot, halftone: a.halftone }; })");
  const key = async (name, code) => {
    const send = type => win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code });
    await send('keyDown'); await send('keyUp');
  };
  const snapshot = {
    appearance: await getAppearance(),
    layout: await js("import('/static/js/layout.js').then(m => m.getLayout())"),
    empty: demoState.empty, quotas: demoState.quotas, isAdmin: demoState.isAdmin, tabs: demoState.tabs,
  };
  const restore = async () => {
    demoState.empty = snapshot.empty; demoState.quotas = snapshot.quotas; demoState.isAdmin = snapshot.isAdmin; demoState.tabs = snapshot.tabs;
    if (snapshot.quotas === undefined) delete demoState.quotas;
    if (snapshot.tabs === undefined) delete demoState.tabs;
    await stopAll().catch(() => {});
    delete demoState.liveHoldIds;
    await delay(300);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
    win.setContentSize(1440, 900);
    await js(`window.__g1Stub = null; import('/static/js/layout.js').then(m => m.saveLayout(${JSON.stringify(snapshot.layout)}))`);
    await appearance(snapshot.appearance);
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
  };

  // One page-level stub: GET responses can be replaced per path, so Home can be fed
  // any data without touching the shared fixtures. Cleared by window.__g1Stub = null.
  const installStub = () => js(`(() => {
    if (window.__g1Fetch) return true;
    window.__g1Fetch = window.fetch.bind(window);
    window.__g1Stub = null;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (init?.method || input.method || 'GET').toUpperCase();
      const stub = window.__g1Stub;
      if (stub && method === 'GET' && stub[url.pathname] !== undefined) {
        const value = typeof stub[url.pathname] === 'function' ? await stub[url.pathname](url) : stub[url.pathname];
        return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return window.__g1Fetch(input, init);
    };
    return true;
  })()`);
  const refreshHome = async () => {
    await delay(1100);  // api.js shares identical GETs for 1 s; let the previous answers expire so the stub is read
    const before = reads.filter(r => r.path === '/api/home/week').length;
    await js("document.dispatchEvent(new CustomEvent('kairos:models-changed'))");
    for (let i = 0; i < 100 && reads.filter(r => r.path === '/api/home/week').length === before; i++) await delay(50);
    await delay(500);
  };
  const showEveryCard = () => js(`import('/static/js/layout.js').then(m => { const l = m.getLayout(); const ids = [...new Set([...m.HOME_SECTIONS.map(s => s.id), ...m.knownHomeCards().map(c => c.id)])]; l.home = ['activity', ...ids.filter(id => id !== 'activity')]; l.hiddenHome = [];  /* a moved card counts as your own arrangement, so the default is not re-applied */ m.saveLayout(l); })`);
  const homeReady = async () => {
    await delay(1100);  // as in refreshHome: demoState changes between sections must not meet a shared read
    await installStub();
    await navigate('home');
    await waitFor("!!document.querySelector('.hm-home .hm-week .rd-dot-matrix') && !!document.querySelector('.dashboard-system-chip') && !!document.querySelector('.dashboard-content.is-filled')");
    await delay(900);
  };
  const contrast = (a, b) => {
    const lum = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
    const [x, y] = [lum(a), lum(b)]; return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  };
  const rgbOf = text => String(text).match(/[\d.]+/g).slice(0, 3).map(Number);

  await installStub();

  // =====================================================================
  // A02-4: light and dark themes (Color presets), auto does not exist
  // =====================================================================
  await section('theme', async () => {
    const presets = { Parchment: '#f3eadb', Linen: '#e9e4da', Stone: '#a7aca5', Clay: '#533c32', Plum: '#3c2943', Ocean: '#233447', Forest: '#23302e', Graphite: '#202127', Espresso: '#18130f' };
    await homeReady();
    const tokensBefore = await js("import('/static/js/mascot.js').then(m => ({ version: m.mascotThemeVersion(), stage: m.mascotTokens()['--m-stage'], body: m.mascotTokens()['--m-ink-body'] }))");
    const heroBefore = await js("document.querySelector('.dashboard-mascot kairos-mascot').innerHTML");
    const seen = {};
    for (const [name, color] of Object.entries(presets)) {
      await appearance({ mode: 'color', color });
      const result = await js(`(() => {
        const root = document.documentElement, s = n => root.style.getPropertyValue(n).trim();
        return { scheme: root.style.colorScheme, appearance: root.dataset.appearance, bg: s('--bg'), text: s('--text'), dim: s('--text-dim'), faint: s('--text-faint'),
          sidebar: s('--sidebar-bg'), sidebarText: s('--sidebar-text'), accent: s('--accent'),
          danger: s('--danger'), success: s('--success'), warn: s('--warn'),
          saved: JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('jarvis:appearance:v1:')))) };
      })()`);
      const bg = rgbOf(result.bg);
      assert.equal(result.appearance, 'color', name);
      assert.equal(result.saved.color, color, name + ' is saved');
      const light = contrast(bg, [0, 0, 0]) > contrast(bg, [255, 255, 255]);
      assert.equal(result.scheme, light ? 'light' : 'dark', name + ' color-scheme follows the base');
      for (const token of ['text', 'dim', 'faint', 'accent', 'danger', 'success', 'warn']) {
        assert.ok(contrast(rgbOf(result[token]), bg) >= 4.5, `${name}: --${token} reads on its base (${contrast(rgbOf(result[token]), bg).toFixed(2)})`);
      }
      assert.ok(contrast(rgbOf(result.sidebarText), rgbOf(result.sidebar)) >= 4.5, name + ' sidebar text reads');
      seen[name] = { light, mascot: await js("import('/static/js/mascot.js').then(m => ({ version: m.mascotThemeVersion(), stage: m.mascotTokens()['--m-stage'], body: m.mascotTokens()['--m-ink-body'] }))") };
    }
    assert.ok(Object.values(seen).some(v => v.light) && Object.values(seen).some(v => !v.light), 'the presets include light and dark bases');
    assert.ok(seen.Graphite.mascot.version > tokensBefore.version, 'the mascot token cache is invalidated on a theme change');
    assert.notEqual(seen.Graphite.mascot.body, seen.Parchment.mascot.body, "Kip's ink body changes between a light and a dark theme");
    assert.ok(contrast(rgbOf(seen.Graphite.mascot.body), rgbOf(await js("getComputedStyle(document.documentElement).getPropertyValue('--bg')"))) >= 3, "Kip's ink body is visible on a dark base (graphics 3:1)");
    await appearance({ mode: 'color', color: presets.Parchment });
    assert.ok(contrast(rgbOf(await js("import('/static/js/mascot.js').then(m => m.mascotTokens()['--m-ink-body'])")), rgbOf(presets.Parchment.replace(/^#/, '').match(/../g).map(h => parseInt(h, 16)).join(','))) >= 3, "Kip's ink body is visible on a light base (graphics 3:1)");
    const heroAfter = await js("document.querySelector('.dashboard-mascot kairos-mascot')?.innerHTML");
    assert.notEqual(heroAfter, heroBefore, 'the hero Kip redraws after a theme change');
    // Reload keeps the choice.
    await appearance({ mode: 'color', color: presets.Plum });
    await win.loadURL(base); await waitFor("!!document.querySelector('.dashboard-core')");
    assert.deepEqual(await js("import('/static/js/appearance.js').then(m => [m.getAppearance().mode, m.getAppearance().color, document.documentElement.style.colorScheme])"), ['color', presets.Plum, 'dark'], 'a dark theme survives a reload');
    // Back to the default look removes every override.
    await appearance({ mode: 'default' });
    assert.equal(await js("document.documentElement.style.colorScheme + '|' + document.documentElement.style.getPropertyValue('--bg')"), '|', 'Default removes the inline theme');
    // There is no Auto: the OS dark preference does not change the default look.
    const before = await js("getComputedStyle(document.body).backgroundColor + '|' + getComputedStyle(document.documentElement).getPropertyValue('--bg')");
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await delay(400);
    const after = await js("getComputedStyle(document.body).backgroundColor + '|' + getComputedStyle(document.documentElement).getPropertyValue('--bg')");
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    bench.autoThemeExists = before !== after;
    assert.equal(before, after, 'no Auto theme exists: an OS dark preference leaves the Default look unchanged (2.2.0)');
    await restore();
  });

  // The existing Appearance suites (modes, pictures, tint, shader, effects, migration) only run in the full ui-smoke; run them here too.
  await section('appearance', async () => {
    await require('./appearance-checks.cjs')({ js, win, waitFor, capture, base, delay });
    await require('./appearance-migration-checks.cjs')({ js, win, waitFor, capture, base, delay, navigate });
    await restore();
  });

  // =====================================================================
  // A02-1/3: Kip style follows every placement
  // =====================================================================
  await section('kip', async () => {
    const expected = (style, px) => style === 'halftone' && px < 44 ? 'flat' : style;
    const finishes = selector => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(n => ({ finish: n.querySelector('svg.ajar')?.dataset.finish, px: Math.round(n.getBoundingClientRect().width), shown: getComputedStyle(n).display !== 'none' }))`);
    await appearance({ mascot: true, kip: 'halftone' });
    await homeReady();
    for (const style of ['flat', 'halftone', 'pixel']) {
      await appearance({ kip: style });
      await delay(450);
      // Home hero.
      const hero = (await finishes('.dashboard-mascot kairos-mascot'))[0];
      assert.equal(hero.finish, expected(style, hero.px), `Home hero Kip is ${style}`);
      // The notch builds Kairos's Kip from KAIROS_SPEC; any size follows the root style.
      const notch = await js(`import('/static/js/mascot.js').then(async m => {
        const face = m.createMascot({ state: 'idle', size: 56, spec: m.KAIROS_SPEC }); face.id = 'g1-notch'; document.body.append(face);
        await new Promise(r => setTimeout(r, 120));
        const out = { finish: face.querySelector('svg.ajar')?.dataset.finish }; face.remove(); return out; })`);
      assert.equal(notch.finish, expected(style, 56), `a notch-style Kip is ${style}`);
      // Appearance panel preview and Home agree.
      assert.equal(await js('document.documentElement.dataset.kip'), style);
    }
    // Hidden: the same spots drop Kip and Show Kip appears.
    await appearance({ kip: 'hidden' });
    await delay(200);
    assert.equal(await js("document.documentElement.dataset.mascot"), 'off');
    assert.equal((await finishes('.dashboard-mascot kairos-mascot'))[0].shown, false, 'hidden hides Home Kip');
    // Empty states and the agents' own faces.
    await appearance({ kip: 'pixel' });
    demoState.empty = true;
    await navigate('tasks');
    await waitFor("!!document.querySelector('.empty-state-mascot kairos-mascot svg')");
    const empty = (await finishes('.empty-state-mascot kairos-mascot'))[0];
    assert.equal(empty.finish, expected('pixel', empty.px), 'the empty state Kip follows the style');
    demoState.empty = false;
    // A bot's page now lives in Bots mode: its header carries the live Kip, the sidebar row a static face.
    demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
    await navigate('agents', { agentId: 'a1' });
    await waitFor("!!document.querySelector('.bots-head-pill kairos-mascot svg') && !!document.querySelector('.bots-rail-row[data-agent-id=\"a1\"] .agent-mascot img')");
    const bot = async () => js("document.querySelector('.bots-head-pill kairos-mascot svg.ajar').dataset.finish + '|' + document.querySelector('.bots-rail-row[data-agent-id=\"a1\"] .agent-mascot img')?.src.length");
    const botPixel = await bot();
    await appearance({ kip: 'flat' }); await delay(300);
    const botFlat = await bot();
    await appearance({ kip: 'hidden' }); await delay(300);
    assert.equal(await bot(), botFlat, 'a bot keeps its own face when Kip is hidden');
    assert.equal(botFlat, botPixel, 'a bot keeps its own face across Kip styles');
    assert.equal(await js("getComputedStyle(document.querySelector('.bots-head-pill kairos-mascot')).display !== 'none'"), true, 'bot faces stay visible with Kip hidden');
    await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
    delete demoState.botsLive; delete demoState.botsAttention;
    // The call screen shows the bot (not Kip) and does not depend on the style.
    assert.ok(await js("import('/static/js/agentCall.js').then(m => typeof m === 'object')"), 'the call module loads');
    await restore();
  });

  // =====================================================================
  // A02-2/3: Kip tracks real chat runs; Stop clears; two chats never overwrite
  // =====================================================================
  await section('chat', async () => {
    const marker = (sessionId) => js(`(() => { const n = [...document.querySelectorAll('.chat-activity')].at(-1); return n ? { state: n.dataset.state, kip: n.querySelector('.chat-activity-marker kairos-mascot')?.getAttribute('state'), label: n.querySelector('.chat-activity-label')?.textContent } : null; })()`);
    const rowKip = id => js(`(() => { const row = document.querySelector('.session-item[data-session-id="${id}"]'); const k = row?.querySelector('.rd-conversation-state kairos-mascot'); return k ? k.getAttribute('state') : null; })()`);
    const send = async (id, text) => {
      await navigate('chat', { sessionId: id });
      await waitFor("!!document.querySelector('#chat-input') && document.querySelector('#chat-main')");
      await delay(500);
      await js(`document.querySelector('#chat-input').value = ${JSON.stringify(text)}; document.querySelector('#chat-input').dispatchEvent(new Event('input')); document.querySelector('#chat-send').click()`);
      await waitFor("!!document.querySelector('.chat-activity')");
    };
    await appearance({ mascot: true, kip: 'pixel' });
    demoState.liveHoldIds = ['s1', 's2'];
    await send('s1', 'First chat');
    await waitFor("document.querySelector('.chat-activity')?.dataset.state === 'waiting'");
    assert.equal((await marker()).kip, 'thinking', 's1 shows thinking while it runs');
    await send('s2', 'Second chat');
    await waitFor("[...document.querySelectorAll('.chat-activity')].at(-1)?.dataset.state === 'waiting'");
    assert.equal((await marker()).kip, 'thinking', 's2 shows thinking');
    // The conversation list gives each running chat its own Kip.
    await waitFor("!!document.querySelector('.session-item[data-session-id=\"s1\"] .rd-conversation-state kairos-mascot')");
    assert.equal(await rowKip('s1'), 'thinking'); assert.equal(await rowKip('s2'), 'thinking');
    assert.equal(await rowKip('s3'), null, 'an idle chat has no Kip');
    // Desktop redesign: the sidebar's Active list shows both running chats.
    await waitFor("!!document.querySelector('#nav .rd-chats-active .rd-chat-row[data-session-id=\"s1\"] .rd-chat-dot.is-running') && !!document.querySelector('#nav .rd-chats-active .rd-chat-row[data-session-id=\"s2\"] .rd-chat-dot.is-running')");
    // Stop s1 from its own composer: only s1 clears.
    await navigate('chat', { sessionId: 's1' }); await delay(600);
    await waitFor("document.querySelector('#chat-send')?.dataset.mode === 'stop'");
    const stops = writes.length;
    await js("document.querySelector('#chat-send').click()");
    await waitFor("!!document.querySelector('.msg-stopped')");
    assert.ok(writes.slice(stops).some(w => w.path === '/api/chat/live/stop' && JSON.parse(w.body).session_id === 's1'), 'Stop calls the stop endpoint for this chat');
    const stopped = await marker();
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.kip, 'idle', 'a stopped turn drops the thinking Kip');
    soft(stopped.label && stopped.label !== 'undefined', `BUG chatActivity.js:38: the stopped status label is empty (got ${JSON.stringify(stopped.label)})`);
    assert.notEqual(await js("document.querySelector('#chat-send').dataset.mode"), 'stop', 'the composer leaves stop mode');
    await waitFor("!document.querySelector('.session-item[data-session-id=\"s1\"] .rd-conversation-state kairos-mascot')");
    await waitFor("!document.querySelector('#nav .rd-chats-active .rd-chat-row[data-session-id=\"s1\"]')");
    assert.equal(await rowKip('s2'), 'thinking', 'stopping s1 does not touch s2');
    // s2 is still thinking when reopened.
    await navigate('chat', { sessionId: 's2' }); await delay(600);
    assert.equal((await marker()).kip, 'thinking', 's2 still thinks after s1 stopped');
    await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 's2' }) })");
    await waitFor("!document.querySelector('.session-item[data-session-id=\"s2\"] .rd-conversation-state kairos-mascot')");
    assert.equal(await js("document.querySelectorAll('.rd-conversation-state kairos-mascot').length"), 0, 'no stale Kip in the list after both stop');
    // A reload shows no stale activity for stopped turns.
    await win.loadURL(base); await waitFor("!!document.querySelector('.dashboard-core')");
    await navigate('chat', { sessionId: 's1' }); await delay(700);
    assert.equal(await js("document.querySelectorAll('.chat-activity-marker kairos-mascot[state=thinking]').length"), 0, 'a reload does not resurrect a stopped turn');
    // A finished turn shows success once, then settles to idle.
    delete demoState.liveHoldIds;
    await send('s3', 'Finish quickly');
    await waitFor("[...document.querySelectorAll('.chat-activity')].at(-1)?.dataset.state === 'done'");
    await waitFor("[...document.querySelectorAll('.chat-activity-marker kairos-mascot')].at(-1)?.getAttribute('state') === 'success' || [...document.querySelectorAll('.chat-activity-marker kairos-mascot')].at(-1)?.getAttribute('state') === 'idle'");
    await waitFor("[...document.querySelectorAll('.chat-activity-marker kairos-mascot')].at(-1)?.getAttribute('state') === 'idle'", 6000);
    // A held run at the same time as a quick one: the quick one finishes while the held one keeps thinking.
    demoState.liveHoldIds = ['s1'];
    await send('s1', 'Hold me');
    await waitFor("[...document.querySelectorAll('.chat-activity')].at(-1)?.dataset.state === 'waiting'");
    await send('s2', 'Finish me');
    await waitFor("[...document.querySelectorAll('.chat-activity')].at(-1)?.dataset.state === 'done'");
    assert.equal(await rowKip('s1'), 'thinking', 'a chat finishing leaves the other chat thinking');
    await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 's1' }) })");
    await restore();
  });

  // Home hero Kip follows the running chats (empty fixtures so nothing else needs the person).
  await section('chat', async () => {
    demoState.empty = true;
    await homeReady();
    const hero = () => js("document.querySelector('.dashboard-mascot kairos-mascot')?.getAttribute('state')");
    assert.equal(await hero(), 'idle', 'nothing running: Home Kip is idle');
    demoState.liveHoldIds = ['g1-run'];
    await js("fetch('/api/chat/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-run', message: 'Work' }) })");
    await waitFor("document.querySelector('.dashboard-mascot kairos-mascot')?.getAttribute('state') === 'thinking'");
    await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-run' }) })");
    await waitFor("document.querySelector('.dashboard-mascot kairos-mascot')?.getAttribute('state') === 'idle'");
    // Needs you beats working.
    demoState.empty = false; delete demoState.liveHoldIds;
    await homeReady();
    assert.equal(await hero(), 'needs', 'with a person to answer, Home Kip needs you');
    demoState.liveHoldIds = ['g1-run2'];
    await js("fetch('/api/chat/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-run2', message: 'Work' }) })");
    await delay(700);
    assert.equal(await hero(), 'needs', 'a running chat does not outrank needs you');
    await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-run2' }) })");
    await restore();
  });

  // =====================================================================
  // A02-3/5/6: animation makes no model calls, reduced motion informs, many instances stay stable
  // =====================================================================
  await section('stress', async () => {
    await appearance({ mascot: true, kip: 'pixel' });
    await homeReady();
    // Animation alone: cycle every state and style for 3 seconds; nothing is sent.
    const w0 = writes.length, r0 = reads.length;
    await js(`(async () => {
      const k = document.querySelector('.dashboard-mascot kairos-mascot');
      for (const s of ['thinking', 'listening', 'speaking', 'success', 'needs', 'error', 'sleeping', 'idle']) { k.setAttribute('state', s); await new Promise(r => setTimeout(r, 300)); }
    })()`);
    const modelCalls = reads.slice(r0).filter(r => /chat|complet|stream|agents\/.*run/.test(r.path));
    assert.equal(writes.length - w0, 0, 'animating Kip sends nothing');
    assert.deepEqual(modelCalls, [], 'animating Kip reads no chat or model route');
    // Reduced motion: still informative (each state has a distinct still drawing) and nothing runs.
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const distinct = await js(`(async () => {
      await new Promise(r => setTimeout(r, 300));
      const k = document.querySelector('.dashboard-mascot kairos-mascot'), out = {};
      for (const s of ['idle', 'thinking', 'listening', 'speaking', 'success', 'needs', 'error', 'sleeping']) {
        k.setAttribute('state', s); await new Promise(r => setTimeout(r, 80));
        out[s] = { svg: k.querySelector('svg.ajar')?.outerHTML.length, name: k.getAttribute('aria-label') || k.closest('[aria-label]')?.getAttribute('aria-label'),
          running: document.getAnimations().filter(a => a.effect?.target?.closest?.('kairos-mascot') && a.playState === 'running').length };
      }
      return out;
    })()`);
    for (const [state, info] of Object.entries(distinct)) assert.equal(info.running, 0, `${state}: nothing runs under reduced motion`);
    assert.ok(new Set(Object.values(distinct).map(i => i.svg)).size >= 4, 'reduced motion still draws distinct poses, not one frozen face');
    assert.match(await js("document.querySelector('.dashboard-mascot').getAttribute('aria-label')"), /^Kip, /, 'the state is also written down for assistive tech');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    // Many instances: stable layout, every svg drawn, no overflow.
    const layout = await js(`(async () => {
      const host = document.createElement('div');
      host.id = 'g1-many'; host.style.cssText = 'position:fixed;inset:60px 20px auto 20px;display:flex;flex-wrap:wrap;gap:6px;z-index:9999;background:var(--bg)';
      document.body.append(host);
      const m = await import('/static/js/mascot.js');
      const states = ['idle', 'thinking', 'listening', 'speaking', 'success', 'needs', 'error', 'sleeping'];
      for (let i = 0; i < 96; i++) host.append(m.createMascot({ state: states[i % 8], size: [22, 28, 40, 56][i % 4], decorative: true }));
      await new Promise(r => setTimeout(r, 700));
      const first = host.getBoundingClientRect(), kids = [...host.children].map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
      await new Promise(r => setTimeout(r, 900));
      const second = host.getBoundingClientRect(), kids2 = [...host.children].map(n => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
      const out = { drawn: [...host.children].filter(n => n.querySelector('svg.ajar')).length, count: host.children.length,
        stable: JSON.stringify(kids) === JSON.stringify(kids2) && first.height === second.height, overflow: host.scrollWidth > host.clientWidth + 1,
        offsets: kids.filter(([x, y, w, h], i) => w !== [22, 28, 40, 56][i % 4] || h !== w).length };
      host.remove(); return out;
    })()`);
    assert.equal(layout.drawn, layout.count, 'every one of 96 Kips is drawn');
    assert.ok(layout.stable, 'many animated Kips never move each other');
    assert.equal(layout.overflow, false); assert.equal(layout.offsets, 0, 'each Kip keeps its requested square size');
    await restore();
  });

  // =====================================================================
  // A02-6: sharp assets at high DPI
  // =====================================================================
  await section('stress', async () => {
    await appearance({ mascot: true, kip: 'halftone', halftone: true });
    await homeReady();
    const measure = async () => { await waitFor("(document.querySelector('.dashboard-core canvas')?.width || 0) > 100"); await delay(400); return measureNow(); };
    const measureNow = () => js(`(() => { const c = document.querySelector('.dashboard-core canvas'), r = c.getBoundingClientRect(); return { w: c.width, h: c.height, cssW: r.width, cssH: r.height, dpr: devicePixelRatio, mascot: document.querySelector('.dashboard-mascot kairos-mascot')?.innerHTML.length }; })()`);
    const one = await measure();
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
    await win.loadURL(base);
    await homeReady();
    const two = await measure();
    await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    assert.equal(two.dpr, 2);
    assert.ok(two.w >= one.w * 1.8, `the Home picture backing store grows with the display (1x ${one.w}px, 2x ${two.w}px)`);
    assert.ok(Math.abs(two.cssW - one.cssW) < 2, 'the picture keeps its layout size at 2x');
    await restore();
  });

  // =====================================================================
  // A03-1/5: hero actions, slogans, click-throughs
  // =====================================================================
  await section('home', async () => {
    await appearance({ mascot: true, kip: 'halftone', halftone: true });
    await js("import('/static/js/layout.js').then(m => m.resetHomeLayout())");
    await homeReady();
    const hero = await js(`(() => { const h = document.querySelector('.dashboard-hero'); return { eyebrow: h.querySelector('.eyebrow').textContent, title: h.querySelector('h1').textContent, text: h.querySelector('.dashboard-intro p').textContent,
      buttons: [...h.querySelectorAll('.dashboard-actions button')].map(b => b.textContent) }; })()`);
    assert.equal(hero.eyebrow, 'Kairos, the opportune moment');
    assert.equal(hero.title, 'Not more time. The right time.');
    assert.equal(hero.text, 'Your conversations, notes and next steps, ready for the moment you need them.');
    assert.deepEqual(hero.buttons, ['Start a conversation', 'Explore your vault ↗']);
    await js("document.querySelector('.dashboard-actions .btn.primary').click()");
    await waitFor("document.getElementById('view-content').dataset.view === 'chat'");
    await waitFor("!!document.querySelector('#chat-input')");
    assert.ok(await js("document.querySelector('#chat-main')?.classList.contains('is-empty')"), 'it is a new, empty conversation');
    await homeReady();
    await js("[...document.querySelectorAll('.dashboard-actions button')].find(b => b.textContent.startsWith('Explore your vault')).click()");
    await waitFor("document.getElementById('view-content').dataset.view === 'library'");
    await waitFor("!!document.querySelector('[data-library-section=vault]')");
    assert.equal(await js("[...document.querySelectorAll('[data-library-section=vault]')].map(n => n.getAttribute('aria-checked') || n.getAttribute('aria-pressed')).find(v => v === 'true') || null"), 'true', 'Explore your vault lands in the Vault section of Library');
    // Phone: the heading greets by the clock and New chat opens a chat.
    win.setContentSize(390, 844); await delay(500);
    await homeReady();
    const greeting = await js("document.querySelector('.hm-heading h1').textContent");
    const h = new Date().getHours();
    assert.equal(greeting.replace(/,.*/, ''), `Good ${h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'}`, 'phone Home greets by the time of day');
    const newChat = await js("[...document.querySelectorAll('.hm-heading-actions button')].find(b => /New chat/.test(b.textContent))?.textContent");
    assert.equal(newChat, 'New chat');
    await js("[...document.querySelectorAll('.hm-heading-actions button')].find(b => /New chat/.test(b.textContent)).click()");
    await waitFor("['chat', 'mobileLaunch'].includes(document.getElementById('view-content').dataset.view)");
    win.setContentSize(1440, 900); await delay(400);
    await restore();
  });

  await section('home', async () => {
    demoState.isAdmin = true;
    // The Bots rows below open Bots pages, which the in-memory Bots backend answers.
    demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
    await homeReady();
    await showEveryCard();
    await navigate('home'); await homeReady();
    await waitFor("!!document.querySelector('[data-home-section=store] .dashboard-row') && !!document.querySelector('[data-home-section=agents] .dashboard-row')");
    const settingsOpen = () => js("!!document.querySelector('.settings-window') && !document.querySelector('.settings-window').closest('.hidden') ? document.querySelector('.settings-nav-item.active')?.dataset.section || 'open' : null");
    const goes = async (label, selector, destination, expectSection) => {
      try { await goesInner(label, selector, destination, expectSection); }
      catch (error) {
        failures.push(`[home] ${label}: ${error.message.split(String.fromCharCode(10)).slice(0, 5).join(' | ')}`);
        await js("document.querySelector('.settings-titlebar-btn[title=Close]')?.click()").catch(() => {});
      }
    };
    const goesInner = async (label, selector, destination, expectSection) => {
      await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'"); await homeReady();
      await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'}); document.querySelector(${JSON.stringify(selector)}).click()`);
      if (destination === 'settings') {
        await waitFor("!!document.querySelector('.settings-window')?.getClientRects().length && !!document.querySelector('.settings-nav-item.active')");
        await delay(700);
        const active = await js("document.querySelector('.settings-nav-item.active')?.dataset.section || null");
        if (expectSection) assert.ok(expectSection.split('|').includes(active), label + ' opens Settings on the right section (got ' + active + ', wanted ' + expectSection + ')');
        await js("document.querySelector('.settings-titlebar-btn[title=Close]').click()");
        await delay(400);
        return;
      }
      await waitFor(`${JSON.stringify(destination.split('|'))}.includes(document.getElementById('view-content').dataset.view)`);
    };
    await goes('Systems chip', '.dashboard-system-chip[data-system=vault]', 'settings');
    await goes('Systems chip (models)', '.dashboard-system-chip[data-system=models]', 'settings');
    await goes('Systems Details', '[data-home-section=system] .dashboard-section-header button', 'settings');
    // Settings remembers the last section; the link must still open the Models group.
    await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow('appearance'))");
    await waitFor("document.querySelector('.settings-nav-item.active')?.dataset.section === 'appearance'");
    await js("document.querySelector('.settings-titlebar-btn[title=Close]').click()"); await delay(400);
    await goes('Model usage link (after Settings was last on Appearance)', '[data-home-section=models] .dashboard-section-header button', 'settings', 'added-models|add-models');
    await goes('Tool Store row', '[data-home-section=store] .dashboard-row', 'tool-store');
    await goes('Needs you action', '[data-home-section=needs] .hm-live-row .hm-live-copy', 'botsHome|botsShell');
    await goes('Calendar row', '[data-home-section=schedule] .dashboard-row', 'calendar');
    await goes('All chats link', '[data-home-section=chats] .dashboard-section-header button', 'chat');
    await goes('Bots row', '[data-home-section=agents] .dashboard-row', 'botsShell');
    await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
    delete demoState.botsLive; delete demoState.botsAttention;
    await restore();
  });

  // =====================================================================
  // A03-2/3: Home updates when work changes; completed notes render when reported
  // =====================================================================
  await section('home', async () => {
    demoState.isAdmin = true;
    await homeReady();
    // Recent chats
    const chatTitles = () => js("[...document.querySelectorAll('[data-home-section=chats] .dashboard-row-title')].map(n => n.textContent)");
    const sessions = await js("fetch('/api/sessions').then(r => r.json())");
    await js(`window.__g1Stub = { '/api/sessions': ${JSON.stringify([{ id: 'g1-new', title: 'A brand new conversation', updated_at: Date.now() / 1000 }])}.concat(${JSON.stringify(sessions)}) }`);
    await refreshHome();
    assert.equal((await chatTitles())[0], 'A brand new conversation', 'a new chat appears first on refresh');
    await js('window.__g1Stub = null');
    await refreshHome();
    assert.ok(!(await chatTitles()).includes('A brand new conversation'), 'and goes away when it is gone');
    // Working now: a running chat adds a row, stopping removes it.
    const working = () => js("document.querySelectorAll('[data-home-section=working] .hm-live-row').length");
    const before = await working();
    demoState.liveHoldIds = ['g1-working'];
    await js("fetch('/api/chat/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-working', message: 'Long job' }) })");
    await waitFor(`document.querySelectorAll('[data-home-section=working] .hm-live-row').length > ${before}`, 8000);
    await js("fetch('/api/chat/live/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'g1-working' }) })");
    await waitFor(`document.querySelectorAll('[data-home-section=working] .hm-live-row').length === ${before}`, 8000);
    // Needs you: an agent question adds a row, answering removes it.
    const needs = () => js("document.querySelectorAll('[data-home-section=needs] .hm-live-row').length");
    const needsBefore = await needs();
    fixtures.agentInbox.push({ id: 'g1-q', agent_id: 'a2', kind: 'question', status: 'open', created_at: Date.now() / 1000, title: 'Which folder?', body: '' });
    try {
      await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
      await waitFor(`document.querySelectorAll('[data-home-section=needs] .hm-live-row').length > ${needsBefore}`, 12000);
    } finally { fixtures.agentInbox.splice(fixtures.agentInbox.findIndex(i => i.id === 'g1-q'), 1); }
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    await waitFor(`document.querySelectorAll('[data-home-section=needs] .hm-live-row').length === ${needsBefore}`, 12000);
    // Usage: a new quota reading replaces the old one; the unknown state is not zero.
    const meter = p => js(`document.querySelector('[data-provider=${p}] [role=meter]')?.getAttribute('aria-valuenow') ?? null`);
    const codexBefore = await meter('codex');
    const stamp = Math.floor(Date.now() / 1000);
    demoState.quotas = { providers: [
      { provider: 'claude', status: 'ok', updated_at: stamp - 120, note: '', windows: [{ name: '5-hour', used_percent: 34, resets_at: stamp + 7800 }] },
      { provider: 'codex', status: 'ok', updated_at: stamp - 60, note: '', windows: [{ name: '5-hour', used_percent: 90, resets_at: stamp + 3600 }] }] };
    await refreshHome();
    assert.equal(await meter('codex'), '90', `a new reading updates the meter (${codexBefore} -> 90)`);
    // Signed out: not a zero reading.
    demoState.quotas = { providers: [{ provider: 'claude', status: 'needs_sign_in', note: '', windows: [] },
      { provider: 'codex', status: 'ok', updated_at: stamp, note: '', windows: [{ name: '5-hour', used_percent: 90, resets_at: stamp + 3600 }] }] };
    await refreshHome();
    assert.equal(await meter('claude'), null, 'a signed-out provider has no meter');
    assert.ok(await js("document.querySelector('[data-provider=claude]').textContent.includes('Sign in') && !document.querySelector('[data-provider=claude]').textContent.includes('0%')"), 'and says to sign in instead of 0%');
    delete demoState.quotas; await refreshHome();
    assert.equal(await meter('codex'), codexBefore, 'the original reading returns when the source does');
    // The week: completed notes show when the API reports them, and the chart follows the slots.
    const week = await js("fetch('/api/home/week').then(r => r.json())");
    const next = structuredClone(week);
    next.unavailable = []; next.totals.notes_done = 7;
    next.slots = next.slots.map((s, i) => ({ ...s, chats: i === 0 ? 5 : 0, agent_runs: i === 0 ? 1 : 0 }));
    next.totals.chats = 5; next.totals.agent_runs = 1; next.busiest = 'Mon';
    await js(`window.__g1Stub = { '/api/home/week': ${JSON.stringify(next)} }`);
    await refreshHome();
    const stats = await js("[...document.querySelectorAll('.hm-week-stats > div')].map(d => d.textContent)");
    assert.deepEqual(stats, ['5chats', '1agent runs', '7notes done'], 'the week lists completed notes when reported');
    assert.equal(await js("document.querySelector('.hm-busiest').textContent"), 'Busiest: Monday');
    assert.equal(await js("document.querySelectorAll('.hm-week .rd-dot-a').length"), 5, 'the chart paints the five chats of that half day');
    assert.equal(await js("document.querySelectorAll('.hm-week .rd-dot-b').length"), 1, 'and the one agent run above them');
    // An unavailable source is not drawn as zero.
    next.unavailable = ['chats', 'agent_runs', 'notes_done'];
    await js(`window.__g1Stub = { '/api/home/week': ${JSON.stringify(next)} }`);
    await refreshHome();
    assert.equal(await js("document.querySelectorAll('.hm-week-stats > div').length"), 0, 'unavailable totals are left out, not shown as 0');
    await js('window.__g1Stub = null');
    await restore();
  });

  // =====================================================================
  // A03-6: focus survives refresh; many and long cards stay packed
  // =====================================================================
  await section('home', async () => {
    demoState.isAdmin = true;
    await homeReady();
    await showEveryCard();
    await navigate('home'); await homeReady();
    await waitFor("!!document.querySelector('[data-home-section=store] .dashboard-row') && !!document.querySelector('[data-home-section=agents] .dashboard-row')");
    const targets = [['chats row', '[data-home-section=chats] .dashboard-row'], ['Systems chip', '[data-home-section=system] .dashboard-system-chip'],
      ['Tool Store row', '[data-home-section=store] .dashboard-row'], ['agent row', '[data-home-section=agents] .dashboard-row'],
      ['hero action', '.dashboard-actions .btn.primary'], ['Customize', '.hm-customize']];
    const lost = [];
    for (const [name, selector] of targets) {
      const label = await js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return null; n.focus(); return n.textContent.trim() + '|' + n.className; })()`);
      if (!label) { lost.push(name + ' (missing)'); continue; }
      await refreshHome();
      const after = await js(`(() => { const a = document.activeElement; return a && a !== document.body ? a.textContent.trim() + '|' + a.className : 'body'; })()`);
      if (after !== label) lost.push(`${name}: focus was "${label.split('|')[0]}", now "${after.split('|')[0]}"`);
    }
    assert.deepEqual(lost, [], 'a Home refresh keeps keyboard focus where it was');
    await restore();
  });

  await section('stress', async () => {
    demoState.isAdmin = true;
    const long = 'An unbroken and very long title that keeps going well past any card width ' + 'x'.repeat(160);
    const now = Date.now() / 1000;
    const cards = Array.from({ length: 14 }, (_, i) => ({ id: 'tab:crm:stress-' + i, slug: 'crm', tab_name: 'CRM', tab_icon: '', title: 'Stress card ' + i + ' ' + long.slice(0, 60), kind: i % 3 === 0 ? 'stat' : 'list',
      empty_text: 'None', value: 1234567, label: 'open items ' + long.slice(0, 40), detail: long, rows: Array.from({ length: 12 }, (_, r) => ({ title: long, meta: long, badge: 'Badge ' + r, tone: 'warn' })) }));
    demoState.tabs = demoState.tabs; // unchanged
    await homeReady();
    await js(`window.__g1Stub = {
      '/api/sessions': ${JSON.stringify(Array.from({ length: 600 }, (_, i) => ({ id: 'bulk-' + i, title: long + i, updated_at: now - i * 60 })))},
      '/api/projects': ${JSON.stringify(Array.from({ length: 80 }, (_, i) => ({ id: 'bp' + i, name: long + i, document_ids: [] })))},
      '/api/home/tab-cards': ${JSON.stringify({ cards })},
    }`);
    await js("document.dispatchEvent(new CustomEvent('jarvis:tabs-changed'))");
    await waitFor("document.querySelectorAll('[data-home-section^=\"tab:\"]').length === 0 || true");
    await delay(800);
    await showEveryCard();
    await delay(1200);
    for (const [label, width] of [['desktop', 1440], ['phone', 390]]) {
      win.setContentSize(width, width === 1440 ? 1000 : 844); await delay(900);
      const report = await js(`(() => {
        const grid = document.querySelector('.dashboard-grid'), bounds = grid.getBoundingClientRect();
        const cards = [...grid.children].filter(n => n.getClientRects().length);
        const wide = cards.filter(n => n.scrollWidth > n.clientWidth + 2).map(n => n.dataset.homeSection || n.className);
        const rows = [];
        for (const n of cards) { const r = n.getBoundingClientRect(); let row = rows.find(x => Math.abs(x[0].top - r.top) <= 2); if (!row) rows.push(row = []); row.push(r); }
        const packed = rows.every(row => Math.abs(Math.min(...row.map(r => r.left)) - bounds.left) <= 2 && Math.abs(Math.max(...row.map(r => r.right)) - bounds.right) <= 2 && row.every(r => Math.abs(r.bottom - row[0].bottom) <= 2));
        const tall = [...document.querySelectorAll('.dashboard-row')].filter(n => n.getBoundingClientRect().height > 90).length;
        return { count: cards.length, wide, packed: label === 'phone' ? true : packed, tall, chats: document.querySelectorAll('[data-home-section=chats] .dashboard-row').length, doc: document.documentElement.scrollWidth <= innerWidth + 1 };
      })()`.replace('label', JSON.stringify(label)));
      soft(report.wide.length === 0, `BUG? ${label}: cards overflow sideways with long unbroken text: ${report.wide.join(', ')}`);
      soft(report.packed, `${label}: rows stay packed to the grid edges`);
      soft(report.tall === 0, `${label}: long text is clipped to a bounded row height (${report.tall} tall rows)`);
      soft(report.chats <= 4, `${label}: recent chats stays at four rows (${report.chats})`);
      soft(report.doc, `${label}: the page does not scroll sideways`);
      const settled = await js(`new Promise(r => { const g = document.querySelector('.dashboard-grid'); const a = g.getBoundingClientRect().height; setTimeout(() => r(Math.abs(g.getBoundingClientRect().height - a) < 1), 700); })`);
      soft(settled, `${label}: Home layout does not keep changing`);
      console.log('g1 stress ' + label + ' ' + JSON.stringify(report));
    }
    await restore();
  });

  // =====================================================================
  // Benchmarks (numbers only; targets are proposed in the report)
  // =====================================================================
  await section('bench', async () => {
    await appearance({ mascot: true, kip: 'halftone', halftone: true });
    // First render and request waterfall.
    const r0 = reads.length;
    await win.loadURL(base);
    const t0 = Date.now();
    await waitFor("!!document.querySelector('.hm-home.is-filled .hm-week .rd-dot-matrix') && !!document.querySelector('.dashboard-system-chip')", 20000);
    bench.homeFirstRenderMs = Date.now() - t0;
    await delay(1200);
    const homeReads = reads.slice(r0);
    bench.homeApiReadsFirstRender = homeReads.length;
    bench.homeApiPaths = [...new Set(homeReads.map(r => r.path))].length;
    bench.homeDuplicateReads = homeReads.length - bench.homeApiPaths;
    // E3 regression bounds (before: 42 reads, 16 duplicates; after: 26 reads, 0 duplicates).
    const repeated = Object.entries(homeReads.reduce((m, r) => (m[r.path] = (m[r.path] || 0) + 1, m), {})).filter(([, n]) => n > 1);
    assert.ok(bench.homeDuplicateReads < 5, 'Home first load repeats fewer than 5 reads: ' + JSON.stringify(repeated));
    assert.ok(bench.homeApiReadsFirstRender <= 32, 'Home first load is at most 32 reads, got ' + bench.homeApiReadsFirstRender);
    // Frame times per Kip style and instance count (offscreen window; compare runs, not absolute numbers).
    const frames = (ms) => js(`new Promise(resolve => { const t = []; let last = performance.now(); const end = last + ${ms};
      const tick = now => { t.push(now - last); last = now; if (now < end) requestAnimationFrame(tick); else { t.shift(); t.sort((a, b) => a - b);
        resolve({ frames: t.length, p50: +t[Math.floor(t.length * .5)].toFixed(1), p95: +t[Math.floor(t.length * .95)].toFixed(1), over50: t.filter(x => x > 50).length }); } };
      requestAnimationFrame(tick); })`);
    for (const style of ['hidden', 'flat', 'halftone', 'pixel']) {
      await appearance({ kip: style }); await delay(500);
      bench['frames_home_kip_' + style] = await frames(2000);
    }
    await appearance({ kip: 'pixel' });
    for (const count of [12, 48]) {
      await js(`(async () => { const host = document.createElement('div'); host.id = 'g1-bench'; host.style.cssText = 'position:fixed;inset:60px 20px auto 20px;display:flex;flex-wrap:wrap;gap:4px;z-index:9999';
        document.body.append(host); const m = await import('/static/js/mascot.js'); const s = ['idle', 'thinking', 'listening', 'speaking', 'needs', 'sleeping'];
        for (let i = 0; i < ${count}; i++) host.append(m.createMascot({ state: s[i % 6], size: 32, decorative: true })); await new Promise(r => setTimeout(r, 500)); })()`);
      bench['frames_mascots_' + count] = await frames(2000);
      await js("document.getElementById('g1-bench').remove()");
    }
    for (const effect of ['dithered', 'ascii', 'numbers', 'binary']) {
      await appearance({ backgroundEffect: effect, mode: 'default', halftone: true }); await delay(600);
      bench['frames_effect_' + effect] = await frames(2000);
    }
    console.log('G1 BENCH ' + JSON.stringify(bench));
    await restore();
  });

  await restore();
  assert.deepEqual(failures, [], 'g1 failures:\n' + failures.join('\n'));
  return bench;
};
