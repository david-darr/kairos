// The opt-out: Settings > Appearance > Classic look. The redesign is the default look, so this keeps the
// previous design tested: the switch turns the class off and back, a few key views still render, and a
// stored redesign:false (what most existing users have) no longer pins anyone to the old look.
const assert = require('node:assert/strict');

module.exports = async function checkClassicLook({ js, win, waitFor, navigate, base, delay, capture }) {
  const redesign = () => js("document.documentElement.classList.contains('kairos-redesign')");
  const appearance = patch => js("import('/static/js/appearance.js').then(m => { m.updateAppearance(" + JSON.stringify(patch) + "); return m.getAppearance().classic; })");
  const loaded = "(!!document.querySelector('.dashboard-content.is-filled') && !document.querySelector('.dashboard-content .skeleton') && ![...document.querySelectorAll('.dashboard-stat-value')].some(n => n.textContent === '…'))";
  const key = "Object.keys(localStorage).find(k => k.startsWith('jarvis:appearance:v1:'))";

  // The default, with a fresh profile and after a reload.
  assert.equal(await redesign(), true, 'A fresh profile gets the redesign');
  assert.equal(await js("import('/static/js/appearance.js').then(m => m.getAppearance().classic)"), false, 'Classic is off by default');

  // Settings shows the switch under its new name, off, and it works.
  await js("document.querySelector('.sidebar-settings-btn').click()");
  await waitFor("!!document.querySelector('[data-section=appearance]')");
  await js("document.querySelector('[data-section=appearance]').click()");
  await waitFor("!!document.querySelector('#appearance-classic')");
  assert.ok(await js("document.querySelector('.appearance-classic-setting').textContent.includes('Classic look') && !document.querySelector('.appearance-classic-setting').textContent.includes('—') && !document.querySelector('#appearance-classic').checked"), 'The Classic look switch is off and named');
  assert.equal(await js("!!document.querySelector('#appearance-redesign')"), false, 'The old Redesign preview switch is gone');
  await js("document.querySelector('#appearance-classic').click()");
  await waitFor("!document.documentElement.classList.contains('kairos-redesign')");
  assert.equal(await js("!!document.querySelector('.kairos-redesign-backdrop')"), false, 'Classic removes the redesign backdrop');
  assert.equal(await js("JSON.parse(localStorage.getItem('jarvis:welcome-appearance:v1')).classic"), true, 'The sign-in snapshot follows');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");

  // A few key views still render in the classic look.
  await js("import('/static/js/layout.js').then(m => m.resetHomeLayout())");
  await navigate('home');
  await waitFor(loaded);
  await waitFor("!!document.querySelector('.dashboard-project-tile') && !!document.querySelector('.dashboard-agent-tile') && document.querySelectorAll('.dashboard-stat:not([data-stat=waiting])').length === 4");
  await capture('classic-home');
  await navigate('chat');
  await waitFor("!!document.querySelector('#chat-main') && !!document.querySelector('.chat-layout > .chat-backdrop')");
  await navigate('notes');
  await waitFor("!!document.querySelector('#view-content .view-constrained')");
  assert.equal(await redesign(), false, 'Views do not bring the redesign back');
  // The floating progress pill is a classic-look feature: it clears the title bar and fits the window.
  await js("import('/static/js/chatStream.js').then(m => { m.startTurn('classic-progress', 'Classic progress', 'Test', []); })");
  try {
    await waitFor("!!document.querySelector('.chat-progress-card')");
    await js("document.documentElement.classList.add('electron-shell')");
    for (const [width, height] of [[1440, 900], [390, 420]]) {
      win.setContentSize(width, height); await delay(250);
      assert.ok(await js("(() => { const r=document.querySelector('#chat-progress-host').getBoundingClientRect(); return r.top >= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) + 12 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()"), 'Progress card clears titlebar and fits window');
    }
  } finally {
    await js("import('/static/js/chatStream.js').then(m => m.stopTurn('classic-progress')); document.documentElement.classList.remove('electron-shell')");
    win.setContentSize(1440, 900);
  }

  // Reset appearance returns to the redesign.
  await js("import('/static/js/appearance.js').then(m => m.resetAppearance())");
  await waitFor("document.documentElement.classList.contains('kairos-redesign')");
  assert.equal(await js("JSON.parse(localStorage.getItem(" + key + ")).classic"), false, 'Reset appearance returns to the redesign');

  // Migration: the old opt-in field is ignored on read and dropped on the next save.
  await js("localStorage.setItem(" + key + ", JSON.stringify({ mode: 'default', redesign: false, halftone: true })); localStorage.removeItem('jarvis:welcome-appearance:v1')");
  await win.loadURL(base);
  await waitFor("!!document.querySelector('#nav .nav-item[data-tab]')");
  assert.equal(await redesign(), true, 'A stored redesign:false does not keep anyone on the old look');
  await appearance({ halftone: true });
  assert.equal(await js("'redesign' in JSON.parse(localStorage.getItem(" + key + "))"), false, 'The old field is dropped on the next save');
  await js("localStorage.setItem(" + key + ", JSON.stringify({ mode: 'default', redesign: true, classic: true }))");
  await win.loadURL(base);
  await waitFor("!!document.querySelector('#nav .nav-item[data-tab]')");
  assert.equal(await redesign(), false, 'A stored classic:true is honoured');
  // First launch: nothing stored at all.
  await js("localStorage.removeItem(" + key + "); localStorage.removeItem('jarvis:welcome-appearance:v1')");
  await win.loadURL(base);
  await waitFor("!!document.querySelector('#nav .nav-item[data-tab]')");
  assert.equal(await redesign(), true, 'A first launch with nothing stored shows the redesign');
  console.log('PASS: Classic look opt-out, redesign by default, stored redesign:false migration, reset and first launch.');
};
