// Bots mode look foundation, in the renderer (Agents 3.0 Phase 0, unit U2).
// Run by ui-smoke behind --bots-look-only (U1's generic loader runs
// scripts/bots-<name>-checks.cjs for --bots-<name>-only, and the full run includes
// every bots-*-checks.cjs): node scripts/run-electron-test.cjs ui-smoke --bots-look-only
//
// Mounts the row kit, a menu and a Kip header in a scratch container with
// <html data-app-mode="bots">: the tokens resolve, the interface font stack begins
// with Geist and its font file loads, the kit behaves (switch, radio, segmented,
// text row, menu), the Kip beats play and stop under reduced motion, and an
// Appearance change repaints the kit. Everything scratch is removed at the end
// and the mode attribute is put back.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, demoState, base }) => {
  const TOKENS = ['--bots-app', '--bots-panel', '--bots-card', '--bots-menu', '--bots-raised', '--bots-raised-hover', '--bots-menu-active',
    '--bots-inset', '--bots-control', '--bots-composer-ring', '--bots-hairline', '--bots-ink', '--bots-ink-secondary', '--bots-ink-tertiary',
    '--bots-accent', '--bots-accent-ink', '--bots-focus', '--bots-success', '--bots-danger', '--bots-warning', '--bots-bubble-user',
    '--bots-bubble-bot', '--bots-radius-card', '--bots-radius-bubble', '--bots-radius-menu', '--bots-radius-pill', '--bots-shadow-float',
    '--bots-ease', '--bots-dur-tap', '--bots-dur-pop', '--bots-dur-panel', '--bots-text-row', '--bots-text-bubble',
    '--bots-font-sans', '--bots-font-prose', '--bots-font-mono'];
  const reduce = value => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] });
  const savedAppearance = await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return { mode: a.mode, color: a.color }; })");
  const restore = await isolateBotsCheck({ js, demoState });

  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__botsLookMode = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots'; return true; })()`);

    // -- Tokens and fonts -----------------------------------------------------
    const tokens = await js(`(() => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(${JSON.stringify(TOKENS)}.map(t => [t, cs.getPropertyValue(t).trim()])); })()`);
    const empty = Object.entries(tokens).filter(([, value]) => !value).map(([name]) => name);
    assert.deepEqual(empty, [], 'every --bots-* token resolves under data-app-mode="bots"');
    assert.ok(tokens['--bots-font-sans'].startsWith('"Geist"'), `interface stack starts with Geist: ${tokens['--bots-font-sans']}`);
    assert.ok(tokens['--bots-font-prose'].startsWith('"Inter"'), 'prose stack starts with Inter');
    assert.ok(tokens['--bots-font-mono'].startsWith('"Geist Mono"'), 'code stack starts with Geist Mono');
    assert.equal(tokens['--bots-radius-card'], '14px');
    assert.equal(await js("getComputedStyle(document.documentElement).fontFamily.startsWith('Geist') || getComputedStyle(document.documentElement).fontFamily.startsWith('\"Geist\"')"), true, 'Bots text computes to Geist');
    // The three font files load from the app's own files (no network, no 404).
    const fonts = await js(`(async () => {
      const out = {};
      for (const face of ['14px "Geist"', '14px "Geist Mono"', '14px "Inter"']) { await document.fonts.load(face); out[face] = document.fonts.check(face); }
      return out;
    })()`);
    assert.deepEqual(Object.values(fonts), [true, true, true], `fonts load: ${JSON.stringify(fonts)}`);
    // Outside Bots mode nothing changes: the tokens do not exist.
    assert.equal(await js(`(() => { const prior = document.documentElement.dataset.appMode; document.documentElement.dataset.appMode = 'kairos';
      const value = getComputedStyle(document.documentElement).getPropertyValue('--bots-ink').trim(); document.documentElement.dataset.appMode = prior; return value; })()`), '', 'Kairos mode does not see the Bots tokens');

    // -- The row kit, a menu and a Kip header -----------------------------------
    await js(`(async () => {
      const U = await import('/static/js/botsUi.js');
      const K = await import('/static/js/botsKip.js');
      document.getElementById('bots-look-scratch')?.remove();
      const host = document.createElement('div');
      host.id = 'bots-look-scratch';
      host.dataset.botColor = 'd99a92';
      host.style.cssText = 'position:fixed;left:24px;top:24px;width:420px;z-index:30;background:var(--bots-app);padding:12px;max-height:90vh;overflow:auto';
      window.__botsLook = { events: [], U, K };
      const log = (...args) => window.__botsLook.events.push(args.join(':'));
      const bot = { id: 'scout', name: 'Scout', color: '#D99A92', enabled: true };
      const header = document.createElement('div');
      header.id = 'bots-look-header';
      header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;font:600 14px var(--bots-font-sans);color:var(--bots-ink)';
      const kip = K.botKip(bot, { size: 24, state: K.stateForBot(bot, { status: 'idle' }) });
      header.append(kip, 'Scout');
      window.__botsLook.kip = kip;
      host.append(
        header,
        U.PageHeader({ title: 'Settings', intro: 'How Scout behaves.', backLabel: 'Details', onBack: () => log('back') }),
        U.Card({ label: 'Before Scout acts', children: [
          U.SwitchRow({ title: 'Ask first', hint: 'Check with me before sending.', checked: false, onChange: v => log('switch', v) }),
          U.SwitchRow({ title: 'Bot-coloured', checked: true, bot: true, onChange: v => log('botswitch', v) }),
          U.NavRow({ title: 'Apps', value: '2 on', iconName: 'plug', onClick: () => log('nav') }),
          U.TextRow({ title: 'Job', value: 'Researcher', maxLength: 60, onCommit: v => log('text', v) }),
        ] }),
        U.RadioGroup({ label: 'Where it works', value: 'auto', options: [
          { value: 'auto', title: 'Let it choose' }, { value: 'computer', title: 'Its computer' }, { value: 'browser', title: 'Browser' } ],
          onChange: v => log('radio', v) }),
        (() => { const row = document.createElement('div'); row.style.margin = '12px 0'; row.append(U.Segmented({ label: 'Mode', value: 'ask', options: [{ value: 'ask', label: 'Ask' }, { value: 'go', label: 'Just do it' }], onChange: v => log('seg', v) }), U.BotSwitch({ checked: true, color: '#D99A92', label: 'Colour switch' })); return row; })(),
        (() => { const b = U.Button({ label: 'Menu', iconName: 'ellipsis', onClick: e => U.openMenu(e.currentTarget, [
          { heading: 'Scout' }, { label: 'Duplicate', iconName: 'copy', onSelect: () => log('menu', 'duplicate') }, { separator: true },
          { label: 'Archive', iconName: 'archive', meta: 'hides it', onSelect: () => log('menu', 'archive') }, { label: 'Delete', iconName: 'trash-2', danger: true, onSelect: () => log('menu', 'delete') },
          { note: 'Archived bots keep their routines.' } ]) }); b.id = 'bots-look-menu-button'; return b; })()
      );
      document.body.append(host);
      return true;
    })()`);
    await waitFor("!!document.querySelector('#bots-look-scratch .bots-kip kairos-mascot')");
    await capture('bots-look-kit');

    // Layout and type from the design: rows at least 46 px, titles 14 px, card radius 14.
    const rows = await js(`(() => {
      const q = s => document.querySelector('#bots-look-scratch ' + s);
      const cs = (n, p) => getComputedStyle(n)[p];
      return { rowH: q('.bots-switch-row').offsetHeight, title: cs(q('.bots-row-title'), 'fontSize'), titleFont: cs(q('.bots-row-title'), 'fontFamily'),
        card: cs(q('.bots-card-body'), 'borderTopLeftRadius'), pageTitle: cs(q('.bots-page-title'), 'fontSize'), segH: q('.bots-segmented button').offsetHeight,
        icons: document.querySelectorAll('#bots-look-scratch svg.bots-icon').length, iconStroke: q('svg.bots-icon').getAttribute('stroke'), caps: cs(q('.bots-card-label'), 'textTransform') };
    })()`);
    assert.ok(rows.rowH >= 46, `row height ${rows.rowH}`);
    assert.equal(rows.title, '14px');
    assert.ok(rows.titleFont.includes('Geist'), `row font ${rows.titleFont}`);
    assert.equal(rows.card, '14px');
    assert.equal(rows.pageTitle, '18px');
    assert.ok(rows.icons >= 3 && rows.iconStroke === 'currentColor', 'Lucide icons draw in currentColor');
    assert.equal(rows.caps, 'uppercase');

    // The kit behaves.
    await js("document.querySelector('#bots-look-scratch .bots-switch-row').click()");
    assert.equal(await js("document.querySelector('#bots-look-scratch .bots-switch-row .bots-switch').getAttribute('aria-checked')"), 'true', 'clicking the row toggles the switch');
    await js("document.querySelector('#bots-look-scratch .bots-nav-row').click()");
    await js("document.querySelector('#bots-look-scratch .bots-back').click()");
    await js("document.querySelector('#bots-look-scratch .bots-radio-row[data-value=browser]').click()");
    assert.equal(await js("document.querySelector('#bots-look-scratch .bots-radio-row[aria-checked=true]').dataset.value"), 'browser');
    await js("document.querySelector('#bots-look-scratch [role=radiogroup] .bots-radio-row[aria-checked=true]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
    assert.equal(await js("document.querySelector('#bots-look-scratch .bots-radio-row[aria-checked=true]').dataset.value"), 'auto', 'arrow keys wrap through the radio list');
    await js("document.querySelector('#bots-look-scratch .bots-segmented button[data-value=go]').click()");
    assert.equal(await js("document.querySelector('#bots-look-scratch .bots-segmented button[aria-checked=true]').dataset.value"), 'go');
    await js(`(() => { const f = document.querySelector('#bots-look-scratch .bots-text-row input'); f.focus(); f.value = 'Analyst'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
    await js(`(() => { const f = document.querySelector('#bots-look-scratch .bots-text-row input'); f.value = 'Typo'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()`);
    assert.equal(await js("document.querySelector('#bots-look-scratch .bots-text-row input').value"), 'Analyst', 'Escape puts the committed text back');
    const events = await js('window.__botsLook.events');
    for (const expected of ['switch:true', 'nav', 'back', 'radio:browser', 'radio:auto', 'seg:go', 'text:Analyst']) assert.ok(events.includes(expected), `${expected} in ${JSON.stringify(events)}`);
    assert.ok(!events.includes('text:Typo'), 'an escaped edit is never committed');

    // The bot's colour re-themes everything inside: the user bubble colour is that bot's Kip pastel.
    const rose = await js(`(() => { const host = document.getElementById('bots-look-scratch'); const a = getComputedStyle(host).getPropertyValue('--bots-bubble-user').trim();
      const probe = document.createElement('span'); probe.style.background = 'var(--m-body-d99a92)'; document.body.append(probe); const b = getComputedStyle(probe).backgroundColor; probe.remove();
      const c = document.createElement('span'); c.style.background = a; host.append(c); const d = getComputedStyle(c).backgroundColor; c.remove(); return { b, d }; })()`);
    assert.equal(rose.d, rose.b, 'data-bot-color paints the bubble token in the bot\'s pastel');

    // The menu: opens, takes arrow keys, Escape closes and returns focus, a pick runs and closes.
    await js("document.getElementById('bots-look-menu-button').click()");
    await waitFor("!!document.querySelector('.bots-menu')");
    assert.equal(await js("document.querySelectorAll('.bots-menu [role=menuitem]').length"), 3);
    assert.ok(await js("getComputedStyle(document.querySelector('.bots-menu')).borderTopLeftRadius === '12px' && document.querySelector('.bots-menu-row').offsetHeight >= 30"), 'menu radius 12 and rows 30 px');
    assert.equal(await js("document.activeElement.textContent.includes('Duplicate')"), true, 'the first row is focused');
    await capture('bots-look-menu');
    await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor("!document.querySelector('.bots-menu')");
    assert.equal(await js("document.activeElement.id"), 'bots-look-menu-button', 'closing returns focus to the opener');
    await js("document.getElementById('bots-look-menu-button').click()");
    await waitFor("!!document.querySelector('.bots-menu')");
    await js("[...document.querySelectorAll('.bots-menu-row')].find(n => n.textContent.includes('Archive')).click()");
    await waitFor("!document.querySelector('.bots-menu')");
    assert.ok((await js('window.__botsLook.events')).includes('menu:archive'));

    // -- Kip: states, beats, reduced motion -----------------------------------------
    assert.equal(await js("window.__botsLook.kip.querySelector('kairos-mascot').getAttribute('state')"), 'idle');
    await js("window.__botsLook.kip.setState(window.__botsLook.K.stateForBot({ id: 'scout' }, { status: 'needs_you' }))");
    assert.equal(await js("window.__botsLook.kip.querySelector('kairos-mascot').getAttribute('state')"), 'needs', 'a bot that needs you shows the needs pose');
    assert.equal(await js("getComputedStyle(window.__botsLook.kip).width"), '24px', 'the header Kip is 24 px');
    await reduce(false);
    await js("window.__botsLook.kip.beat('arrive')");
    assert.equal(await js("window.__botsLook.kip.dataset.beat"), 'arrive');
    assert.notEqual(await js("getComputedStyle(window.__botsLook.kip).animationName"), 'none', 'a beat animates when motion is allowed');
    assert.ok(await js("window.__botsLook.kip.getAnimations().length > 0"));
    await waitFor("!window.__botsLook.kip.dataset.beat", 4000);
    await reduce(true);
    await js("window.__botsLook.kip.beat('celebrate')");
    assert.equal(await js("getComputedStyle(window.__botsLook.kip).animationName"), 'none', 'reduced motion stops the beats');
    assert.equal(await js("window.__botsLook.kip.getAnimations().length"), 0);
    // The kit's own entrance animations stop too.
    await js("document.getElementById('bots-look-scratch').classList.add('bots-panel-in')");
    assert.equal(await js("getComputedStyle(document.getElementById('bots-look-scratch')).animationName"), 'none', 'reduced motion stops panel entrances');
    await reduce(false);

    // -- Appearance change repaints ------------------------------------------------
    const paint = () => js(`(() => { const host = document.getElementById('bots-look-scratch'); const body = host.querySelector('.bots-card-body');
      return { card: getComputedStyle(body).backgroundColor, ink: getComputedStyle(host.querySelector('.bots-row-title')).color, app: getComputedStyle(host).backgroundColor }; })()`);
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#f3eadb' }))`);
    await delay(150);
    const light = await paint();
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: '#1f1d24' }))`);
    await waitFor(`getComputedStyle(document.querySelector('#bots-look-scratch .bots-card-body')).backgroundColor !== ${JSON.stringify(light.card)}`, 4000);
    const dark = await paint();
    assert.notEqual(dark.card, light.card, 'the card repaints for the new base');
    assert.notEqual(dark.ink, light.ink, 'the text repaints for the new base');
    assert.notEqual(dark.app, light.app, 'the ground repaints for the new base');
    await capture('bots-look-dark');
    // The bot's pastel does not move with Appearance (illustration colour).
    assert.equal(await js(`(() => { const cs = getComputedStyle(document.getElementById('bots-look-scratch')); return cs.getPropertyValue('--bots-bubble-user').trim() === cs.getPropertyValue('--m-body-d99a92').trim(); })()`), true, 'the bubble token stays on the pastel');
  } finally {
    try {
      await reduce(false);
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${JSON.stringify(savedAppearance)}))`);
      await js(`(() => { document.getElementById('bots-look-scratch')?.remove(); document.querySelectorAll('.bots-menu').forEach(n => n.remove());
        const prior = window.__botsLookMode; if (prior) document.documentElement.dataset.appMode = prior; else delete document.documentElement.dataset.appMode;
        delete window.__botsLook; delete window.__botsLookMode; return true; })()`);
    } finally { await restore(); }
  }
};
