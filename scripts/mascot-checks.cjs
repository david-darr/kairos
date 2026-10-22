// The mascot in the app (vault: "Kairos Mascot (Build Spec)", phases 2 to 4),
// run by ui-smoke, or alone: node scripts/run-electron-test.cjs ui-smoke --mascot-only
// Home hero, empty states, the Show the mascot switch, bot faces in every
// Agents surface, the call screen, the village and the notification icon.
// The chat marker's stream (thinking, success, idle, error) is in chat-smoke.
const assert = require('node:assert/strict');
module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, writes, fixtures }) => {
  const setMascot = on => js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mascot: ${on} }))`);
  // ui-smoke --mascot-off: the same checks from a start with the switch off.
  const startedOff = process.argv.includes('--mascot-off');
  if (startedOff) {
    await navigate('home');
    assert.equal(await js("document.documentElement.dataset.mascot"), 'off');
    assert.equal(await js("!!document.querySelector('.dashboard-mascot') && getComputedStyle(document.querySelector('.dashboard-mascot')).display"), 'none', 'off from the start: no mascot on Home');
    await capture('mascot-home-off-from-start');
    await js("import('/static/js/appearance.js').then(m => { m.updateAppearance({ mascot: true }); return true; })");
  }
  const shown = selector => js(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return !!n && n.getClientRects().length > 0 && getComputedStyle(n).display !== 'none'; })()`);

  // -- Home -------------------------------------------------------------------
  await navigate('home');
  await waitFor("!!document.querySelector('.dashboard-mascot kairos-mascot svg.ajar')");
  // Scout waits on the person in the fixtures: needs you beats working.
  await waitFor("document.querySelector('.dashboard-mascot kairos-mascot').getAttribute('state') === 'needs'");
  assert.equal(await js("document.querySelector('.dashboard-mascot').getAttribute('aria-label')"), 'Kairos needs you. Open Agents');
  assert.equal(await js("document.querySelector('.dashboard-mascot').disabled"), false, 'a needs-you mascot is a way to the waiting items');
  assert.equal(await js("document.querySelector('.dashboard-mascot svg.ajar').dataset.finish"), 'halftone', 'Home uses the halftone finish (Mote)');
  assert.ok(await js("(() => { const m = document.querySelector('.dashboard-mascot').getBoundingClientRect(), h = document.querySelector('.dashboard-hero').getBoundingClientRect(); return m.width >= 72 && m.left >= h.left && m.right <= h.right && m.top >= h.top && m.bottom <= h.bottom; })()"), 'the mascot sits inside the hero');
  await capture('mascot-home-desktop');
  await setMascot(false);
  assert.equal(await shown('.dashboard-mascot'), false, 'off hides Home\'s mascot');
  await capture('mascot-home-desktop-off');
  await setMascot(true);
  assert.equal(await shown('.dashboard-mascot'), true);

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
  await waitFor("!!document.getElementById('appearance-mascot')");
  assert.equal(await js("document.getElementById('appearance-mascot').checked"), true, 'on (by default, or after the off run turned it back on)');
  await js("document.getElementById('appearance-mascot').click()");
  await waitFor("document.documentElement.dataset.mascot === 'off'");
  await js("document.getElementById('appearance-mascot').click()");
  await waitFor("document.documentElement.dataset.mascot === 'on'");
  await capture('mascot-settings-switch');
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
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.agents-rail-item.agent-tile .agent-mascot img')");
  assert.equal(await js("document.querySelectorAll('.agent-dot-avatar img[src^=\"data:image/svg+xml\"]').length > 0 && [...document.querySelectorAll('.agent-mascot')].every(n => JSON.parse(n.dataset.avatarSpec).version === 3)"), true, 'every face is a v3 Ajar');
  // Scout needs the person, Archivist works: the rail faces take those poses.
  assert.equal(await js("document.querySelector('.agents-rail-item[data-key=\"agent:a1\"] .agent-mascot').dataset.pose"), 'needs');
  assert.equal(await js("document.querySelector('.agents-rail-item[data-key=\"agent:a2\"] .agent-mascot').dataset.pose"), 'thinking');
  assert.equal(await js("[...document.querySelectorAll('.agent-mascot img')].some(i => decodeURIComponent(i.src).includes('<filter'))"), false, 'no SVG filters in any face');
  // The open conversation's header is the one live bot face.
  await waitFor("!!document.querySelector('.agent-profile-face kairos-mascot svg.ajar')");
  assert.equal(await js("document.querySelector('.agent-profile-face kairos-mascot').getAttribute('state')"), 'needs');
  assert.equal(await js("document.querySelector('.agent-profile-face kairos-mascot').getAttribute('aria-hidden')"), 'true', 'decorative beside its text status');
  assert.ok(await js("document.querySelectorAll('kairos-mascot').length <= 12"), 'live mascots stay few');
  await capture('mascot-agents-dm');
  // Roster polls keep the same face nodes (no flicker).
  await js("window.mascotFace = document.querySelector('.agents-rail-item[data-key=\"agent:a2\"] .agent-mascot img'); window.mascotSrc = window.mascotFace.src; document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
  await delay(600);
  assert.equal(await js("document.querySelector('.agents-rail-item[data-key=\"agent:a2\"] .agent-mascot img').src === window.mascotSrc"), true, 'a poll draws the same face');

  // -- Notifications carry the bot's face --------------------------------------------------
  await js(`window.mascotNotes = []; window.mascotNotification = window.Notification;
    window.Notification = class { constructor(title, options) { window.mascotNotes.push({ title, options }); } static get permission() { return 'granted'; } static requestPermission() { return Promise.resolve('granted'); } close() {} }; true`);
  try {
    // The watcher learns the backlog first; a new question then notifies.
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    await delay(600);
    fixtures.agentInbox.push({ id: 'mascot-q', agent_id: 'a2', kind: 'question', status: 'open', created_at: Date.now() / 1000, title: 'Which folder?', body: '' });
    await js("document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
    await waitFor("window.mascotNotes.length > 0");
    assert.equal(await js("window.mascotNotes[0].title"), 'Archivist needs you');
    assert.ok(await js("String(window.mascotNotes[0].options.icon || '').startsWith('data:image/png')"), 'the icon is the face of the bot, rasterized');
  } finally {
    fixtures.agentInbox.splice(fixtures.agentInbox.findIndex(item => item.id === 'mascot-q'), 1);
    await js("window.Notification = window.mascotNotification; document.dispatchEvent(new CustomEvent('jarvis:agents-changed'))");
  }

  // -- Phone: the mascot beside the bottom tab bar (393x852) ----------------------------
  win.setContentSize(393, 852); await delay(400);
  await navigate('home');
  await waitFor("!!document.querySelector('.ms-tabbar') && !!document.querySelector('.dashboard-mascot kairos-mascot svg')");
  assert.ok(await js("(() => { const m = document.querySelector('.dashboard-mascot').getBoundingClientRect(), b = document.querySelector('.ms-tabbar').getBoundingClientRect(); return m.width >= 44 && m.bottom <= b.top && m.right <= innerWidth && m.left >= 0; })()"), 'Home mascot clears the tab bar');
  // The bar's Agents badge is the needs-you signal on phone: untouched, no mascot in the bar.
  assert.equal(await js("document.querySelectorAll('.ms-tabbar kairos-mascot, .ms-tabbar .agent-mascot').length"), 0);
  assert.ok(await js("!!document.querySelector('.ms-tabbar-item[data-tabbar=agents] .ms-tabbar-badge')"), 'the Agents badge still shows');
  await capture('mascot-phone-home');
  await navigate('agents', { agentId: 'a1' });
  await waitFor("!!document.querySelector('.agent-profile-face kairos-mascot svg') || !!document.querySelector('.side-chat-input')");
  await delay(300);
  await capture('mascot-phone-agent-dm');
  win.setContentSize(1440, 900); await delay(300);

  // -- The website: the hero character and the states strip ----------------------------
  const app = await js('location.href');
  await win.loadURL(new URL('/docs/index.html', app).href);
  await waitFor("document.documentElement.classList.contains('has-mascot') && document.querySelectorAll('.mascot-strip kairos-mascot svg.ajar').length === 10 && !!document.querySelector('.hero-mascot kairos-mascot svg')");
  assert.deepEqual(await js("[...document.querySelectorAll('[data-mascot-state] kairos-mascot')].map(n => n.querySelector('svg').dataset.state)"), ['idle', 'thinking', 'needs', 'success', 'error', 'sleeping']);
  await js("document.querySelector('.mascot-states').scrollIntoView({ block: 'center', behavior: 'instant' })"); await delay(400);
  await capture('mascot-site-strip');
  await js("scrollTo(0, 0)"); await delay(200);
  await capture('mascot-site-hero');
  await win.loadURL(app);
  await waitFor("!!document.querySelector('.dashboard-core')");
  if (startedOff) await js("import('/static/js/appearance.js').then(m => { m.updateAppearance({ mascot: false }); return true; })");
};
