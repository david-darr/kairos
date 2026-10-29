const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

// Bots appearance (migrated from the Agents appearance check, Phase 1; flag --agents-appearance-only).
// Appearance is exercised on each Bots surface in the isolated renderer: the sidebar roster, Bots home, a conversation, the
// panel and the new-bot dialog follow light and dark with readable text, and reduced motion removes the panel and dialog
// entrance animations. Screenshots use ui-smoke's existing output directory.
module.exports = async ({ js, waitFor, navigate, capture, win, demoState, base, delay }) => {
  const q = JSON.stringify;
  const saved = await js("import('/static/js/appearance.js').then(m => { const a=m.getAppearance(); return {mode:a.mode,color:a.color}; })");
  const restore = await isolateBotsCheck({ js, demoState });
  const check = async (surface, text, dark) => {
    const result = await js(`(() => {
      const parse = value => { const n = (value.match(/[\\d.]+/g) || []).map(Number); return { c: n.slice(0, 3).map(v => value.startsWith('color(srgb') ? v : v / 255), a: n.length > 3 ? n[3] : 1 }; };
      // Composite translucent surfaces over what sits behind them.
      const effective = el => { const stack = []; for (let n = el; n; n = n.parentElement) { const p = parse(getComputedStyle(n).backgroundColor); stack.push(p); if (p.a >= 1) break; }
        return stack.reduceRight((under, p) => under.map((u, i) => p.c[i] * p.a + u * (1 - p.a)), [1, 1, 1]); };
      const light = rgb => rgb.map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((total, n, i) => total + n * [.2126, .7152, .0722][i], 0);
      const surface = document.querySelector(${q(surface)}), label = document.querySelector(${q(text)});
      const b = light(effective(surface)), f = light(parse(getComputedStyle(label).color).c);
      return { bg: getComputedStyle(surface).backgroundColor, luminance: b, contrast: (Math.max(b, f) + .05) / (Math.min(b, f) + .05) };
    })()`);
    assert.ok(dark ? result.luminance < .22 : result.luminance > .4, `${surface} follows ${dark ? 'dark' : 'light'} appearance: ${result.bg} (${result.luminance})`);
    assert.ok(result.contrast >= 4.5, `${text} contrast ${result.contrast.toFixed(2)}:1`);
  };
  const clickSection = async id => {
    for (let i = 0; i < 40; i++) {
      if (await js(`(() => { const b = document.querySelector('#bots-panel .bots-acc-item[data-section=${id}][data-open=true] .bots-acc-body'); return !!b && b.getClientRects().length > 0; })()`)) return;
      if (!(await js(`!!document.querySelector('#bots-panel .bots-acc-item[data-section=${id}][data-open=true]')`))) await js(`document.querySelector('#bots-panel .bots-acc-head[data-section=${id}]').click()`);
      await delay(150);
    }
  };
  const closeDialog = async () => {
    await js("document.querySelector('.bots-create-dialog .modal-close-btn')?.click()");
    await js("document.querySelector('.confirm-panel .modal-footer .btn:last-child')?.click()");
    await waitFor("!document.querySelector('.panel-dialog.bots-create-dialog')");
  };
  let bot;
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    bot = await js(`fetch('/api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ${q(JSON.stringify({ name: `Look Probe ${Date.now() % 100000}`, role: 'Checks the light' }))} }).then(r => r.json())`);
    await js(`fetch('/api/agents/${bot.id}/threads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Main"}' }).then(r => r.json())`);
    await js("import('/static/js/botsUi.js').then(m => { m.setAdvanced(true); return true; })");
    for (const [name, color, dark] of [['light', '#f3eadb', false], ['dark', '#1f1d24', true]]) {
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${q(color)} }))`);
      // The roster is the sidebar; Bots home is the welcome.
      await navigate('botsHome');
      await waitFor("!!document.querySelector('.bots-rail-row') && !!document.querySelector('.bots-bot-card')");
      await check('.bots-rail', '.bots-rail-row .bots-rail-name', dark);
      await check('.bots-home', '.bots-home-title', dark);
      await check('.bots-home', '.bots-bot-card .bots-bot-card-name', dark);
      await capture(`bots-${name}-roster`);
      await navigate('botsShell', { agentId: bot.id });
      await waitFor(`document.documentElement.dataset.botsAgent === ${q(bot.id)} && !!document.querySelector('.bots-composer-input')`);
      await check('.bots-shell', '.bots-head-name', dark);
      await check('.bots-composer', '.bots-composer-input', dark);
      await capture(`bots-${name}-bot`);
      await navigate('botsShell', { agentId: bot.id, panel: true });
      await waitFor("!!document.querySelector('#bots-panel .bots-acc-item')");
      await clickSection('identity');
      await check('#bots-panel', '#bots-panel .bots-adv-title strong', dark);
      await capture(`bots-${name}-panel`);
      await js("document.querySelector('#bots-panel .bots-panel-close').click()");
      await waitFor("!document.querySelector('#bots-panel')");
      await navigate('botsHome');
      await waitFor("!!document.querySelector('.bots-home-actions .bots-btn.primary')");
      await js("document.querySelector('.bots-home-actions .bots-btn.primary').click()");
      await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog')");
      await check('.bots-create-dialog', '.bots-create-dialog .modal-header', dark);
      await capture(`bots-${name}-create`);
      await closeDialog();
    }
    // Reduced motion must remove the panel and creation entrance animations (keyframe animations and transitions that
    // move or resize; a colour, shadow or scrollbar fade is not motion).
    const moving = selector => `[...document.querySelector(${q(selector)}).getAnimations({ subtree: true })].filter(a => !a.effect?.target?.closest?.('kairos-mascot') && !a.effect?.target?.closest?.('.bots-kip') && (!a.transitionProperty || /^(transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|margin.*)$/.test(a.transitionProperty))).map(a => (a.animationName || a.transitionProperty || a.id || 'anim'))`;
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await navigate('botsShell', { agentId: bot.id, panel: true });
    await waitFor("!!document.querySelector('#bots-panel .bots-acc-item')");
    await delay(300);
    assert.deepEqual(await js(moving('#bots-panel')), [], 'the panel has no reduced-motion animation');
    await js("document.querySelector('#bots-panel .bots-panel-close').click()");
    await navigate('botsHome');
    await waitFor("!!document.querySelector('.bots-home-actions .bots-btn.primary')");
    await js("document.querySelector('.bots-home-actions .bots-btn.primary').click()");
    await waitFor("!!document.querySelector('.panel-dialog.bots-create-dialog')");
    await delay(300);
    assert.deepEqual(await js(moving('.bots-create-dialog')), [], 'the creation dialog has no reduced-motion animation');
    await closeDialog();
    console.log('PASS: Bots appearance (light, dark, reduced motion).');
  } finally {
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${q(saved)}))`).catch(() => {});
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {});
    await restore();
  }
};
