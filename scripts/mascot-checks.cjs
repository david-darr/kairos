// The mascot in the app (vault: "Kairos Mascot (Build Spec)", phases 2 to 4),
// run by ui-smoke, or alone: node scripts/run-electron-test.cjs ui-smoke --mascot-only
// Home hero and its Kip style menu, empty states, the Kip style setting, bot faces in every
// Bots surface (migrated from Agents, Phase 1), the call screen, the village and the notification icon.
// The chat marker's stream (thinking, success, idle, error) is in chat-smoke.
const assert = require('node:assert/strict');
module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, writes, fixtures }) => {
  const setMascot = on => js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ kip: '${on ? 'halftone' : 'hidden'}' }))`);
  // ui-smoke --mascot-off: the same checks from a start with the switch off.
  const startedOff = process.argv.includes('--mascot-off');
  if (startedOff) {
    await navigate('home');
    assert.equal(await js("document.documentElement.dataset.mascot"), 'off');
    assert.equal(await js("getComputedStyle(document.querySelector('.dashboard-mascot kairos-mascot')).display"), 'none', 'off from the start: no mascot on Home');
    assert.equal(await js("document.querySelector('.dashboard-mascot .kip-show-chip').textContent"), 'Show Kip', 'hidden: the same spot reads Show Kip');
    await capture('mascot-home-off-from-start');
    await js("import('/static/js/appearance.js').then(m => { m.updateAppearance({ mascot: true }); return true; })");
  }
  const shown = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return !!n && n.getClientRects().length > 0 && getComputedStyle(n).display !== 'none'; })()`);

  // -- Home -------------------------------------------------------------------
  await navigate('home');
  await waitFor("!!document.querySelector('.dashboard-mascot kairos-mascot svg.ajar')");
  // Scout waits on the person in the fixtures: needs you beats working.
  await waitFor("document.querySelector('.dashboard-mascot kairos-mascot').getAttribute('state') === 'needs'");
  assert.equal(await js("document.querySelector('.dashboard-mascot').getAttribute('aria-label')"), 'Kip, needs you. Change Kip style');
  assert.equal(await js("document.querySelector('.dashboard-mascot svg.ajar').dataset.finish"), 'halftone', 'Home uses the halftone finish (Mote)');
  assert.ok(await js("(() => { const m = document.querySelector('.dashboard-mascot').getBoundingClientRect(), h = document.querySelector('.dashboard-hero').getBoundingClientRect(); return m.width >= 72 && m.left >= h.left && m.right <= h.right && m.top >= h.top && m.bottom <= h.bottom; })()"), 'the mascot sits inside the hero');
  await capture('mascot-home-desktop');
  // Clicking Kip opens the style menu: four previews, the way to Bots while he needs you.
  const heroBox = "(() => { const m = document.querySelector('.dashboard-mascot').getBoundingClientRect(), h = document.querySelector('.dashboard-hero').getBoundingClientRect(); return m.left >= h.left && m.right <= h.right && m.top >= h.top && m.bottom <= h.bottom; })()";
  await js("document.querySelector('.dashboard-mascot').click()");
  await waitFor("!!document.querySelector('.kip-menu')");
  assert.deepEqual(await js("[...document.querySelectorAll('.kip-menu [role=radio]')].map(n => n.dataset.kipStyle)"), ['flat', 'halftone', 'pixel', 'hidden']);
  assert.equal(await js("document.querySelector('.kip-menu [aria-checked=true]').dataset.kipStyle"), 'halftone');
  assert.equal(await js("document.activeElement.dataset.kipStyle"), 'halftone', 'the open menu focuses the current choice');
  assert.equal(await js("document.querySelectorAll('.kip-menu .kip-choice-art svg.ajar').length"), 3, 'three drawn previews, one for hidden');
  assert.equal(await js("document.querySelector('.kip-menu-needs').textContent"), 'Kip needs you. Open Bots');
  await capture('mascot-home-kip-menu');
  await js("document.querySelector('.kip-menu [data-kip-style=pixel]').click()");
  await waitFor("document.querySelector('.dashboard-mascot svg.ajar').dataset.finish === 'pixel'");
  assert.equal(await js("document.documentElement.dataset.kip"), 'pixel');
  assert.equal(await js("JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('jarvis:appearance:v1:')))).kip"), 'pixel', 'saved with the other appearance choices');
  assert.ok(await js("document.querySelectorAll('.dashboard-mascot svg.ajar .aj-body path').length === 2 && !document.querySelector('.dashboard-mascot svg.ajar .aj-body[clip-path]')"), 'the pixel body is a grid of cells, not a clipped shape');
  await capture('mascot-home-desktop-pixel');
  await js("document.querySelector('.kip-menu [data-kip-style=flat]').click()");
  await waitFor("document.querySelector('.dashboard-mascot svg.ajar').dataset.finish === 'flat'");
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("!document.querySelector('.kip-menu')");
  assert.equal(await js("document.activeElement.classList.contains('dashboard-mascot')"), true, 'closing returns focus to Kip');
  // Hidden: the spot reads Show Kip and the hero keeps its layout; Show Kip brings back the last look.
  await js("document.querySelector('.dashboard-mascot').click()");
  await waitFor("!!document.querySelector('.kip-menu')");
  await js("document.querySelector('.kip-menu [data-kip-style=hidden]').click()");
  await waitFor("document.documentElement.dataset.mascot === 'off'");
  assert.equal(await shown('.dashboard-mascot kairos-mascot'), false, 'hidden hides Home\'s mascot');
  assert.equal(await js("getComputedStyle(document.querySelector('.dashboard-mascot .kip-show-chip')).display !== 'none' && document.querySelector('.dashboard-mascot').getAttribute('aria-label')"), 'Show Kip');
  assert.ok(await js(heroBox), 'the Show Kip chip stays inside the hero');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await capture('mascot-home-desktop-off');
  await js("document.querySelector('.dashboard-mascot').click()");
  await waitFor("document.documentElement.dataset.mascot === 'on'");
  assert.equal(await js("document.documentElement.dataset.kip"), 'flat', 'Show Kip restores the style he had');
  assert.equal(await shown('.dashboard-mascot kairos-mascot'), true);
  await setMascot(true);

  // -- Empty states -------------------------------------------------------------
  demoState.empty = true;
  try {
    await navigate('tasks');
    await waitFor("!!document.querySelector('.empty-state-mascot kairos-mascot svg')");
    assert.equal(await js("document.querySelector('.empty-state-mascot kairos-mascot').getAttribute('state')"), 'sleeping', 'nothing scheduled: Kairos sleeps');
    assert.equal(await shown('.empty-state-rich .empty-state-icon'), false, 'the icon gives way to the mascot');
    await capture('mascot-empty-tasks');
    await setMascot(false);
    assert.equal(await shown('.empty-state-mascot'), false);
    assert.equal(await shown('.empty-state-rich .empty-state-icon'), true, 'off brings the icon back');
    await setMascot(true);
  } finally { demoState.empty = false; }

  // -- Settings > Appearance ------------------------------------------------------
  await navigate('home');
  await js("document.querySelector('.sidebar-settings-btn').click()");
  await waitFor("!!document.querySelector('[data-section=appearance]')");
  await js("document.querySelector('[data-section=appearance]').click()");
  await waitFor("!!document.getElementById('appearance-kip')");
  assert.equal(await js("document.querySelector('#appearance-kip [aria-checked=true]').dataset.kipStyle"), 'halftone', 'halftone by default, or after the earlier checks restored it');
  await js("document.querySelector('#appearance-kip [data-kip-style=hidden]').click()");
  await waitFor("document.documentElement.dataset.mascot === 'off'");
  await js("document.querySelector('#appearance-kip [data-kip-style=pixel]').click()");
  await waitFor("document.documentElement.dataset.mascot === 'on' && document.documentElement.dataset.kip === 'pixel'");
  assert.equal(await js("document.querySelector('#appearance-kip [aria-checked=true]').dataset.kipStyle"), 'pixel');
  await capture('mascot-settings-switch');
  await js("document.querySelector('#appearance-kip [data-kip-style=halftone]').click()");
  await waitFor("document.documentElement.dataset.kip === 'halftone'");
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await delay(300);

  // -- Reduced motion: nothing moves anywhere it appears ------------------------------
  await navigate('home');
  await waitFor("!!document.querySelector('.dashboard-mascot kairos-mascot svg')");
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await delay(400);
  const runningMascot = await js("JSON.stringify(document.getAnimations().filter(a => a.effect?.target?.closest?.('kairos-mascot') && a.playState === 'running').map(a => [a.constructor.name, a.animationName || a.transitionProperty, a.effect.target.getAttribute('class'), a.effect.target.closest('kairos-mascot').parentElement.className]))");
  assert.equal(runningMascot, '[]');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });


  // -- Bots: every face is an Ajar ------------------------------------------------------
  demoState.botsLive = true; demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.bots-rail-row .agent-mascot img') && !!document.querySelector('.bots-head-pill kairos-mascot svg.ajar')");
  assert.equal(await js("document.querySelectorAll('.agent-dot-avatar img[src^=\"data:image/svg+xml\"]').length > 0 && [...document.querySelectorAll('.agent-mascot')].every(n => JSON.parse(n.dataset.avatarSpec).version === 3)"), true, 'every face is a v3 Ajar');
  // Scout needs the person, Archivist works: the sidebar rows carry those states (the rail face itself stays a static idle face).
  assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=\"a1\"]').dataset.state"), 'needs_you');
  assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=\"a2\"]').dataset.state"), 'working');
  assert.equal(await js("[...document.querySelectorAll('.agent-mascot img')].some(i => decodeURIComponent(i.src).includes('<filter'))"), false, 'no SVG filters in any face');
  // The open conversation's header is the one live bot face.
  await waitFor("!!document.querySelector('.bots-head-pill kairos-mascot svg.ajar')");
  assert.equal(await js("document.querySelector('.bots-head-pill kairos-mascot').getAttribute('state')"), 'needs');
  assert.equal(await js("document.querySelector('.bots-head-pill kairos-mascot').getAttribute('aria-hidden')"), 'true', 'decorative beside its text status');
  assert.ok(await js("document.querySelectorAll('kairos-mascot').length <= 12"), 'live mascots stay few');
  await capture('mascot-bots-page');
  // Roster polls keep the same face nodes (no flicker).
  await js("window.mascotFace = document.querySelector('.bots-rail-row[data-agent-id=\"a2\"] .agent-mascot img'); window.mascotSrc = window.mascotFace.src; document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
  await delay(600);
  assert.equal(await js("document.querySelector('.bots-rail-row[data-agent-id=\"a2\"] .agent-mascot img').src === window.mascotSrc"), true, 'a poll draws the same face');

  // -- Notifications carry the bot's face --------------------------------------------------
  await js(`window.mascotNotes = []; window.mascotNotification = window.Notification;
    window.Notification = class { constructor(title, options) { window.mascotNotes.push({ title, options }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } close() {} }; true`);
  try {
    // The attention host's feed watcher learned the backlog at start; a new unread question then notifies.
    const refresh = () => js("import('/static/js/botsAttentionHost.js').then(m => m.attentionHost()?.refresh())");
    await refresh();
    await delay(600);
    demoState.botsAttention.feed.push({ id: 'mascot-q', kind: 'question', agent_id: 'a2', title: 'Which folder?', body: '', at: Date.now() / 1000, read: false, pinned: false, backlog: false, target: { tab: 'botsShell', agentId: 'a2' } });
    await refresh();
    await waitFor("window.mascotNotes.length > 0");
    assert.equal(await js("window.mascotNotes[0].title"), 'Archivist needs you');
    assert.ok(await js("String(window.mascotNotes[0].options.icon || '').startsWith('data:image/png')"), 'the icon is the face of the bot, rasterized');
  } finally {
    demoState.botsAttention.feed = demoState.botsAttention.feed.filter(item => item.id !== 'mascot-q');
    await js("window.Notification = window.mascotNotification; true");
  }

  // -- Phone: week replaces the hero; the Home badge carries the needs-you signal (393x852) ----------------------------
  win.setContentSize(393, 852); await delay(400);
  await navigate('home');
  await waitFor("!document.querySelector('.ms-menu-btn').hidden && !!document.querySelector('.hm-week .dashboard-core')");
  assert.ok(await js("!document.querySelector('.dashboard-hero, .dashboard-mascot, kairos-mascot[follow-pointer]')"), 'Phone Home has no hero mascot or pointer listener');
  assert.ok(await js("(() => { const h = document.querySelector('.hm-heading').getBoundingClientRect(), b = document.querySelector('.ms-menu-btn').getBoundingClientRect(); return h.left >= 0 && h.right <= innerWidth && (h.top >= b.bottom || h.bottom <= b.top || [...document.querySelectorAll('.hm-heading h1, .hm-heading h2')].every(t => t.getBoundingClientRect().left >= b.right)); })()"), 'Phone Home heading clears the menu button');
  // The sidebar's Home badge is the needs-you signal on phone (Agents became Bots): untouched, no mascot in the sidebar.
  assert.equal(await js("document.querySelectorAll('#ms-drawer kairos-mascot, #ms-drawer .agent-mascot').length"), 0);
  await waitFor("!!document.querySelector('.ms-drawer-row[data-drawer=home] .ms-drawer-badge:not([hidden])')");
  assert.ok(true, 'the Home badge still shows');
  // Phone Home draws no Kip, so its style switch sits beside Customize: a 44px target that opens the shared sheet.
  assert.ok(await js("(() => { const b = document.querySelector('.hm-phone-kip'); return !!b && b.getBoundingClientRect().height >= 44 && b.textContent === 'Kip: Halftone'; })()"), 'phone Home offers the Kip style switch');
  await js("document.querySelector('.hm-phone-kip').click()");
  await waitFor("!!document.querySelector('.ms-sheet .kip-choices')");
  assert.deepEqual(await js("[...document.querySelectorAll('.ms-sheet [role=radio]')].map(n => n.dataset.kipStyle + ':' + (n.getBoundingClientRect().height >= 44))"), ['flat:true', 'halftone:true', 'pixel:true', 'hidden:true']);
  await js("document.querySelector('.ms-sheet [data-kip-style=pixel]').click()");
  await waitFor("document.documentElement.dataset.kip === 'pixel'");
  await js("document.querySelector('.ms-sheet .ms-sheet-header button').click()");
  await waitFor("!document.querySelector('.ms-sheet')");
  assert.equal(await js("document.querySelector('.hm-phone-kip').textContent"), 'Kip: Pixel');
  await setMascot(true);
  await capture('mascot-phone-home');
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.bots-head-pill kairos-mascot svg') || !!document.querySelector('.bots-composer-input')");
  await delay(300);
  await capture('mascot-phone-bot-page');
  await navigate('home'); await waitFor("document.documentElement.dataset.appMode === 'kairos'");
  delete demoState.botsLive; delete demoState.botsAttention;
  win.setContentSize(1440, 900); await delay(300);

  // -- The website: the hero character and the states strip ----------------------------
  const app = await js('location.href');
  await win.loadURL(new URL('/docs/index.html', app).href);
  await waitFor("document.documentElement.classList.contains('has-mascot') && document.querySelectorAll('.mascot-strip kairos-mascot svg.ajar').length === 10 && !!document.querySelector('.hero-mascot kairos-mascot svg')");
  // The success face is a short beat that settles back to idle on its own (mascot.js), so a slow load can legitimately read idle there.
  const strip = "[...document.querySelectorAll('[data-mascot-state] kairos-mascot')].map(n => n.querySelector('svg').dataset.state)";
  const drawn = await js(strip);
  assert.deepEqual(drawn.map((state, index) => index === 3 && state === 'idle' ? 'success' : state), ['idle', 'thinking', 'needs', 'success', 'error', 'sleeping']);
  await js("document.querySelector('.mascot-states').scrollIntoView({ block: 'center', behavior: 'instant' })"); await delay(400);
  await capture('mascot-site-strip');
  await js("scrollTo(0, 0)"); await delay(200);
  await capture('mascot-site-hero');
  await win.loadURL(app);
  await waitFor("!!document.querySelector('.dashboard-core')");
  if (startedOff) await js("import('/static/js/appearance.js').then(m => { m.updateAppearance({ mascot: false }); return true; })");
};
