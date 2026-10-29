// The old UI-3 conversation layout check, migrated to the Bots page (Phase 1 check migration; flags
// --agents-layout-only and --agents-layout-captures / --agents-layout-before for the screenshots).
// Same intents on the real Bots page and panel: a round Back control, the old tab links landing on the bot, live status,
// what needs the person shown with its count, the routine and its cadence shown in the panel, user and bot messages told apart
// (and kept apart in dark), the composer's face-side actions, the conversation list, the panel starting below the desktop
// title bar in a short window, the phone layout (Back, card, 44 px targets, messages aligned), surfaces that are token
// derived and readable, and no animation under reduced motion. Waiting items and approvals now live in the Bots inbox and
// the conversation's permission cards; they are asserted in bots-attention-checks.cjs and bots-chat-checks.cjs.
// The check makes its own bot and conversation and restores everything in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');
const chatBackend = require('./fixtures/bots-chat-backend.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base, capturesOnly = false, stage = 'after' }) => {
  const q = JSON.stringify;
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const type = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const pressEscape = () => js("(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  const setAdvanced = on => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${on}); return true; })`);
  let checks = 0;
  const ok = (value, message) => { assert.ok(value, message); checks++; };
  const appearance = await js("import('/static/js/appearance.js').then(m => { const a = m.getAppearance(); return { mode: a.mode, color: a.color }; })");
  const restore = await isolateBotsCheck({ js, demoState }, { botsChat: undefined });
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    const name = `Layout Probe ${Date.now() % 100000}`;
    const bot = (await call('/api/agents', 'POST', { name, role: 'Keeps the layout honest' })).body;
    const sid = (await call(`/api/agents/${bot.id}/threads`, 'POST', { title: 'Main' })).body.id;
    chatBackend.latest.root();
    chatBackend.latest.seed(sid, [
      { role: 'user', content: 'What changed in the layout today?' },
      { role: 'assistant', content: 'The header, the composer and the panel were rebuilt. Nothing else moved.' },
      { role: 'user', content: 'Good. Keep it that way.' },
    ]);
    Object.assign(demoState.botsCore.agents.find(a => a.id === bot.id), { status: 'needs_you', needs_you: 3, status_detail: '' });
    const open = (extra = {}) => navigate('agents', { agentId: bot.id, sessionId: sid, ...extra });
    const ready = () => waitFor("document.querySelectorAll('.bots-log .bots-msg').length >= 3 && !!document.querySelector('.bots-composer-input')");

    // Screenshots: desktop and phone, light and dark (the "before" stage is a capture-only pass against another tree).
    for (const [device, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      win.setContentSize(width, height);
      for (const [tone, color] of [['light', '#f3eadb'], ['dark', '#1f1d24']]) {
        await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${q(color)} }))`);
        await open(); await ready(); await delay(300);
        await capture(`ui3-${stage}-${device}-${tone}`);
      }
    }
    if (capturesOnly) return { checks, stage };

    // 1. Desktop header: round Back, the bot's own name card and a Conversations button; the old tab links land on the page.
    win.setContentSize(1440, 900);
    await setAdvanced(false);
    await open(); await ready();
    ok(await js("document.querySelector('.bots-head-back').getAttribute('aria-label') === 'All bots'"), 'Back is labelled All bots');
    ok(await js("document.querySelector('.bots-head-pill').textContent.includes(" + q(name) + ")"), 'the name card shows the bot');
    for (const tab of ['chat', 'work', 'routines', 'memory']) {
      await navigate('agents', { agentId: bot.id, agentTab: tab });
      await waitFor(`document.documentElement.dataset.botsAgent === ${q(bot.id)} && !!document.querySelector('.bots-composer-input')`);
      ok(await js("document.getElementById('view-content').dataset.view === 'botsShell'"), `the old ${tab} link opens the bot's page`);
    }
    await open(); await ready();

    // 2. Live state uses the bot status, and what waits for the person shows as a count.
    ok(await js("/Needs you/.test(document.querySelector('.bots-head-status').textContent) && document.querySelector('.bots-head-status').dataset.state === 'needs_you'"), 'the live state uses the bot status');
    ok(await js(`document.querySelector('.bots-rail-row[data-agent-id=${bot.id}] .bots-rail-count')?.textContent === '3'`), 'the sidebar row counts what waits for the person');

    // 3. Messages are told apart; the composer carries its face-side actions.
    ok(await js("(() => { const u = getComputedStyle(document.querySelector('.bots-msg.user .bots-msg-bubble')), b = getComputedStyle(document.querySelector('.bots-msg.bot .bots-msg-bubble')); return u.backgroundColor !== b.backgroundColor; })()"), 'user and bot bubbles are told apart');
    await setAdvanced(true);
    await waitFor("document.querySelector('.bots-composer').dataset.form === 'advanced'");
    ok(await exists('.bots-composer-clip') && await exists('.bots-composer-input'), 'the composer offers the reference action beside the input');
    await setAdvanced(false);
    await waitFor("document.querySelector('.bots-composer').dataset.form === 'simple'");

    // 4. Conversations: the list sits in a popover from the header and names the conversation.
    await click('.bots-head-convos');
    await waitFor("!document.querySelector('#bots-convos').hidden");
    ok(await js(`!!document.querySelector('#bots-convos [data-session="${sid}"]')`), 'the conversation list names this conversation');
    await pressEscape();
    await waitFor("document.querySelector('#bots-convos').hidden");

    // 5. The panel shows the routine and its cadence, and Escape on a nested dialog leaves the panel open.
    await setAdvanced(true);
    await open({ panel: 'routines' });
    const section = async id => {
      for (let i = 0; i < 40; i++) {
        if (await js(`(() => { const b = document.querySelector('#bots-panel .bots-acc-item[data-section=${id}][data-open=true] .bots-acc-body'); return !!b && b.getClientRects().length > 0; })()`)) return;
        if (!(await exists(`#bots-panel .bots-acc-item[data-section=${id}][data-open=true]`))) await click(`#bots-panel .bots-acc-head[data-section=${id}]`);
        await delay(150);
      }
      throw new Error('could not open ' + id);
    };
    await waitFor("!!document.querySelector('#bots-panel .bots-acc-item')");
    await section('routines');
    await waitFor("!!document.querySelector('#bots-panel [data-panel-card=routines] .bots-actions .bots-btn')");
    await click('#bots-panel [data-panel-card=routines] .bots-actions .bots-btn');
    await waitFor("!!document.querySelector('.panel-dialog [aria-label=\"Routine name\"]')");
    await type('.panel-dialog [aria-label="Routine name"]', 'Morning sweep');
    await type('.panel-dialog [aria-label="What to do"]', 'Look for new layout problems.');
    await click('.panel-dialog .bots-dialog-footer .bots-btn.primary');
    await waitFor("!!document.querySelector('#bots-panel [data-panel-card=routines] .bots-routine')");
    ok(await js("document.querySelector('#bots-panel [data-panel-card=routines] .bots-routine').textContent.includes('At 08:00 every day')"), 'the routine shows its cadence');
    await click('#bots-panel [data-panel-card=routines] .bots-actions .bots-btn');
    await waitFor("!!document.querySelector('.panel-dialog')");
    await pressEscape();
    await waitFor("!document.querySelector('.panel-dialog')");
    ok(await exists('#bots-panel'), 'Escape closes only the nested dialog and the panel stays');

    // 6. In a short desktop window the panel starts below the title bar and keeps its face.
    win.setContentSize(1280, 600);
    await js("document.documentElement.classList.add('electron-shell')");
    await delay(300);
    ok(await js("(() => { const bar = document.querySelector('.titlebar')?.getBoundingClientRect().bottom || 0, sheet = document.querySelector('#bots-panel').getBoundingClientRect(), face = document.querySelector('#bots-panel .bots-adv-title img, #bots-panel .agent-avatar')?.getBoundingClientRect(); return sheet.top >= bar - 1 && !!face && face.top >= bar && face.bottom <= innerHeight; })()"), 'the panel starts below the title bar and its face is visible');
    await capture('bots-profile-titlebar');
    await js("document.documentElement.classList.remove('electron-shell')");
    win.setContentSize(1440, 900);
    await click('#bots-panel .bots-panel-close');
    await waitFor("!document.querySelector('#bots-panel')");

    // 7. Phone: Back, the card and the composer are real targets; user messages sit to the right; the panel fills the screen.
    await setAdvanced(false);
    win.setContentSize(390, 844);
    await open(); await ready();
    await waitFor("document.getAnimations().filter(a => a.effect?.target?.closest?.('.bots-shell-header') && !a.effect.target.closest('kairos-mascot')).length === 0");
    ok(await js("(() => { const p = document.querySelector('.bots-head-pill').getBoundingClientRect(), b = document.querySelector('.bots-head-back').getBoundingClientRect(), c = document.querySelector('.bots-head-convos').getBoundingClientRect(); return p.height >= 43.5 && b.width >= 43.5 && b.height >= 43.5 && b.right <= p.left + 12 && c.right <= innerWidth && p.right <= c.left; })()"), 'Back, the name card and Conversations are 44 px targets in one row');
    ok(await js("[...document.querySelectorAll('.bots-composer button')].filter(b => b.getClientRects().length).every(b => { const r = b.getBoundingClientRect(); return r.width >= 43.5 && r.height >= 43.5; })"), 'composer buttons are 44 px targets');
    ok(await js("(() => { const u = document.querySelector('.bots-msg.user .bots-msg-bubble').getBoundingClientRect(); return u.right > innerWidth / 2 && u.right <= innerWidth; })()"), 'user messages sit on the right and inside the window');
    await capture('bots-phone-conversation');
    await click('.bots-head-pill');
    await waitFor("!!document.querySelector('#bots-panel')");
    await delay(400);
    ok(await js("(() => { const r = document.querySelector('#bots-panel').getBoundingClientRect(); return r.width >= innerWidth - 2 && r.top >= 0; })()"), 'the phone panel fills the screen from the top');
    ok(await js("[...document.querySelectorAll('#bots-panel .bots-tabs [role=tab]')].length === 3 && [...document.querySelectorAll('#bots-panel .bots-tabs [role=tab]')].every(t => { const r = t.getBoundingClientRect(); return r.height >= 43.5 && r.bottom <= innerHeight; })"), 'the phone panel keeps its three tabs as 44 px targets');
    await capture('bots-phone-panel');
    await click('#bots-panel .bots-panel-close');
    await waitFor("!document.querySelector('#bots-panel')");

    // 8. Surfaces are token derived and readable in light and dark.
    win.setContentSize(1440, 900);
    for (const [tone, color] of [['light', '#f3eadb'], ['dark', '#1f1d24']]) {
      await js(`import('/static/js/appearance.js').then(m => m.updateAppearance({ mode: 'color', color: ${q(color)} }))`);
      await open(); await ready(); await delay(300);
      const rows = await js(`(() => {
        const parse = value => { const n = (value.match(/[\\d.]+/g) || []).map(Number); return { c: n.slice(0, 3).map(v => value.startsWith('color(srgb') ? v : v / 255), a: n.length > 3 ? n[3] : 1 }; };
        const effective = el => { const stack = []; for (let n = el; n; n = n.parentElement) { const p = parse(getComputedStyle(n).backgroundColor); stack.push(p); if (p.a >= 1) break; }
          return stack.reduceRight((under, p) => under.map((u, i) => p.c[i] * p.a + u * (1 - p.a)), [1, 1, 1]); };
        const light = rgb => rgb.map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        return ['.bots-msg.bot .bots-msg-bubble', '.bots-msg.user .bots-msg-bubble', '.bots-composer'].map(selector => {
          const node = document.querySelector(selector), b = light(effective(node)), f = light(parse(getComputedStyle(node).color).c);
          return { selector, ratio: (Math.max(b, f) + .05) / (Math.min(b, f) + .05) };
        });
      })()`);
      for (const row of rows) ok(row.ratio >= 4.5, `${tone}: ${row.selector} contrast ${row.ratio}`);
    }

    // 9. Reduced motion removes the page's animations, including the panel's entrance.
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await open({ panel: true }); await ready();
    await waitFor("!!document.querySelector('#bots-panel')");
    await delay(300);
    const motion = await js("[...document.querySelector('.bots-shell').getAnimations({ subtree: true })].filter(a => !a.effect?.target?.closest?.('kairos-mascot') && !a.effect?.target?.closest?.('.bots-kip') && (!a.transitionProperty || /^(transform|translate|scale|rotate|top|left|right|bottom|inset|width|height|margin.*)$/.test(a.transitionProperty))).map(a => ({ target: String(a.effect?.target?.className || '').slice(0, 40), name: a.animationName || a.transitionProperty }))");
    ok(motion.length === 0, 'reduced motion disables the page animations: ' + JSON.stringify(motion));
    console.log(`PASS: Bots conversation layout: ${checks} assertions.`);
    return { checks };
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {});
    await js(`import('/static/js/appearance.js').then(m => m.updateAppearance(${q(appearance)}))`).catch(() => {});
    await js("document.documentElement.classList.remove('electron-shell')").catch(() => {});
    win.setContentSize(1440, 900);
    await restore();
  }
};
