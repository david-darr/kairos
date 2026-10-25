// Reload coverage for legacy preferences; headless store coverage is in test_background_effects.cjs.
const assert = require('node:assert/strict');
module.exports = async function checkAppearanceMigration({ js, win, waitFor, base }) {
  const key = await js("Object.keys(localStorage).find(k => k.startsWith('jarvis:appearance:v1:'))");
  const original = await js(`localStorage.getItem(${JSON.stringify(key)})`);
  try {
    for (const legacy of [{ classic: true }, { redesign: false }, null]) {
      if (legacy) await js(`localStorage.setItem(${JSON.stringify(key)}, JSON.stringify(${JSON.stringify(legacy)}))`);
      else await js(`localStorage.removeItem(${JSON.stringify(key)}); localStorage.removeItem('jarvis:welcome-appearance:v1')`);
      await win.loadURL(base);
      await waitFor("!!document.querySelector('#nav .nav-item[data-tab]')");
      assert.ok(await js("document.documentElement.classList.contains('kairos-redesign')"), 'Legacy and first-launch profiles use the redesign');
      assert.ok(await js(`!('classic' in JSON.parse(localStorage.getItem(${JSON.stringify(key)})))`), 'Obsolete flag is removed on load');
    }
    await js("import('/static/js/views/settings.js').then(m => m.openSettingsWindow('appearance'))");
    await waitFor("!!document.querySelector('.appearance-panel')");
    assert.ok(await js("!document.querySelector('#appearance-classic, .appearance-classic-setting')"), 'Appearance has no Classic control');
    await js("import('/static/js/appearance.js').then(m => m.resetAppearance())");
    assert.ok(await js("document.documentElement.classList.contains('kairos-redesign')"), 'Reset keeps the redesign');
  } finally {
    await js(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(original)})`);
    await win.loadURL(base);
    await waitFor("!!document.querySelector('#nav .nav-item[data-tab]')");
  }
};
