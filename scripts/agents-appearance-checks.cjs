const assert = require('node:assert/strict');

// 2026-10-14: exercise Appearance on each bot surface in the isolated renderer.
// Screenshots use ui-smoke's existing data/ui-review output directory.
module.exports = async ({ js, waitFor, navigate, capture, win }) => {
  const saved = await js("import('/static/js/appearance.js').then(m => { const a=m.getAppearance(); return {mode:a.mode,color:a.color}; })");
  const check = async (surface, text, dark) => {
    const result = await js(`(() => {
      const bg = getComputedStyle(document.querySelector(${JSON.stringify(surface)})).backgroundColor;
      const fg = getComputedStyle(document.querySelector(${JSON.stringify(text)})).color;
      const rgb = value => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number)
        .map(n => value.startsWith('color(srgb') ? n : n / 255);
      const light = value => rgb(value).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
        .reduce((total, n, i) => total + n * [.2126, .7152, .0722][i], 0);
      const b = light(bg), f = light(fg);
      return { bg, fg, luminance: b, contrast: (Math.max(b, f) + .05) / (Math.min(b, f) + .05) };
    })()`);
    assert.ok(dark ? result.luminance < .22 : result.luminance > .4, `${surface} follows ${dark ? 'dark' : 'light'} appearance: ${result.bg}`);
    assert.ok(result.contrast >= 4.5, `${text} contrast ${result.contrast.toFixed(2)}:1`);
  };
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    for (const [name, color, dark] of [['light', '#f3eadb', false], ['dark', '#1f1d24', true]]) {
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${JSON.stringify(color)} }))`);
      await navigate('agents');
      await waitFor("!!document.querySelector('.agent-new-card')");
      await check('.agent-tile:not(.agent-new-card)', '.agent-tile .title', dark);
      await check('.agent-new-card', '.agent-new-card', dark);
      await check('.agent-inbox', '.agent-inbox-title', dark);
      await check('.team-tile', '.team-tile .title', dark);
      await capture(`agents-${name}-roster`);
      await navigate('agents', { agentId: 'a1', agentTab: 'work' });
      await waitFor("!!document.querySelector('.agent-header')");
      await check('.agent-header', '.agent-header h2', dark);
      await check('.agent-work-host > .glass', '.agent-work-host > .glass .title', dark);
      await capture(`agents-${name}-bot`);
      await navigate('agents', { team: 's1' });
      await waitFor("!!document.querySelector('.swarm-layout > section')");
      await check('.swarm-layout > section', '.swarm-conversation h2', dark);
      await capture(`agents-${name}-team`);
      await navigate('agents', { agentId: 'a1', profile: true });
      await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
      await check('.agent-profile-sheet', '.agent-profile-titlebar h2', dark);
      await capture(`agents-${name}-profile`);
      await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"]').click()");
      await waitFor("document.querySelector('.agent-profile-sheet').hidden");
      await navigate('agents');
      await waitFor("!!document.querySelector('.agent-new-card')");
      await js("document.querySelector('.agent-new-card').click()");
      await waitFor("!!document.querySelector('.agent-create-dialog')");
      await check('.agent-create-dialog', '.agent-create-dialog .modal-header', dark);
      await capture(`agents-${name}-create`);
      await js("document.querySelector('.agent-create-dialog [aria-label=\"Close\"]').click()");
    }
    // Reduced motion must remove the sheet and creation entrance animations.
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await navigate('agents', { agentId: 'a1', profile: true });
    await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
    assert.equal(await js("document.querySelector('.agent-profile-sheet').getAnimations({subtree:true}).length"), 0, 'sheet has no reduced-motion animation');
    await js("document.querySelector('.agent-profile-sheet [aria-label=\"Close profile\"]').click()");
    await navigate('agents');
    await waitFor("!!document.querySelector('.agent-new-card')");
    await js("document.querySelector('.agent-new-card').click()");
    await waitFor("!!document.querySelector('.agent-create-dialog')");
    assert.equal(await js("document.querySelector('.agent-create-dialog').getAnimations({subtree:true}).length"), 0, 'creation has no reduced-motion animation');
    await js("document.querySelector('.agent-create-dialog [aria-label=\"Close\"]').click()");
  } finally {
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(saved)}))`);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  }
};
