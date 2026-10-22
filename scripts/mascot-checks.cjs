// The mascot in the app (vault: "Kairos Mascot (Build Spec)", phases 2 to 4),
// run by ui-smoke, or alone: node scripts/run-electron-test.cjs ui-smoke --mascot-only
// Home hero, empty states, the Show the mascot switch, bot faces in every
// Agents surface, the call screen, the village and the notification icon.
// The chat marker's stream (thinking, success, idle, error) is in chat-smoke.
const assert = require('node:assert/strict');
module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, writes }) => {
  const setMascot = on => js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mascot: ${on} }))`);
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
  assert.equal(await js("document.getElementById('appearance-mascot').checked"), true, 'on by default');
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
  assert.equal(await js("document.getAnimations().filter(a => a.effect?.target?.closest?.('kairos-mascot') && a.playState === 'running').length"), 0);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

  if (module.exports.agents) await module.exports.agents({ js, waitFor, delay, navigate, win, capture, demoState, writes });
};
