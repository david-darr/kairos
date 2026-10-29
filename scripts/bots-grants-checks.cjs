// Bots Phase 2, unit U4: the Access section (grants), in the renderer.
// Run: python run_electron_target.py <worktree> --bots-grants-only <log> 600
//   (or node scripts/run-electron-test.cjs ui-smoke --bots-grants-only)
// Mounts the real botsSectionGrants.js in a scratch host, and once inside the real panel, against the in-memory Bots
// backend (fixtures/bots-core-backend.cjs and fixtures/bots-grants-backend.cjs). It creates its own bot, never assumes which
// other bots exist, and removes everything it made, and restores its page preferences, in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const checked = selector => js(`document.querySelector(${q(selector)})?.getAttribute('aria-checked') === 'true'`);
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const clearToasts = () => js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
  const putCount = () => writes.filter(w => w.method === 'PUT' && /\/access$/.test(w.path)).length;
  const HOST = '#bots-gr-host';
  const mountGrants = async (id, advanced) => {
    await js(`(async () => {
      const M = await import('/static/js/botsSectionGrants.js');
      window.__grants?.destroy();
      document.getElementById('bots-gr-host')?.remove();
      const host = document.createElement('div');
      host.id = 'bots-gr-host';
      host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:360px;overflow:auto;z-index:30;background:var(--bots-panel);padding:12px';
      document.body.append(host);
      window.__adv = ${advanced ? 'true' : 'false'};
      window.__grants = await M.mount(host, { agentId: ${q(id)}, state: { agent: {} }, advanced: () => window.__adv, flush: async () => {}, refresh: async () => {}, go: () => {} });
      return true;
    })()`);
    await waitFor(`!!document.querySelector('${HOST} .bots-grants-ceiling')`);
  };
  const access = id => call(`/api/bots/${id}/access`).then(r => r.body);
  const waitFor2 = async (test, what) => {
    for (let i = 0; i < 80; i++) { if (await test()) return; await delay(50); }
    throw new Error('Timed out: ' + what);
  };
  const expected = [];   // error toasts this check caused on purpose

  const savedInterface = await js("localStorage.getItem('kairos:bots-interface') || ''");
  const restore = await isolateBotsCheck({ js, demoState });
  let botId = null, phone = false;
  try {
    demoState.botsLive = true;
    delete demoState.botsGrants;
    demoState.botsSectionModules = ['Grants'];
    // The shell's inbox and notification polls need a store to answer from; an empty one, removed in `finally`.
    demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__prior = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
      return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend
    const made = await call('/api/agents', 'POST', { name: `Access Probe ${Date.now() % 100000}`, role: 'Checks access' });
    assert.equal(made.status, 200, 'the check makes its own bot');
    botId = made.body.id;

    // ================= Simple: the ceiling in words, every app, and what cannot be switched on =========================
    await js("import('/static/js/botsUi.js').then(m => m.setAdvanced(false))");
    await mountGrants(botId, false);
    await waitFor(`!!document.querySelector('${HOST} [data-app=gh1]')`);
    assert.match(await text(`${HOST} .bots-grants-ceiling`), /most the bot can do/);
    assert.match(await text(`${HOST} .bots-grants-ceiling`), /approval level \(Full by default\) cannot add to it/, 'Full cannot widen, and it says so');
    for (const id of ['gh1', 'google', 'down1']) assert.ok(await exists(`${HOST} [data-app=${id}]`), `an app row for ${id}`);
    assert.equal(await checked(`${HOST} [data-app=gh1] .bots-switch`), true, 'the legacy reading starts available apps on');
    assert.equal(await checked(`${HOST} [data-app=down1] .bots-switch`), false);
    assert.equal(await js(`document.querySelector('${HOST} [data-app=down1] .bots-switch').disabled`), true, 'an unavailable app cannot be switched on');
    assert.match(await text(`${HOST} [data-app=down1]`), /switched off in Settings/, 'and says why');
    assert.equal(await exists(`${HOST} .bots-grants-native`), false, 'built-in tools are Advanced');
    await capture('desktop-bots-grants-simple');
    const before = putCount();
    await click(`${HOST} [data-app=down1] .bots-switch`);
    await delay(250);
    assert.equal(putCount(), before, 'clicking an unavailable switch saves nothing');

    // ================= Instant persistence: switch an app off, then on at read-only =========================================
    const first = await access(botId);
    assert.equal(first.mode, 'legacy');
    await click(`${HOST} [data-app=gh1] .bots-switch`);
    await waitFor2(async () => (await access(botId)).grants.connector_scopes.gh1 === 'off', 'github saved off');
    let saved = await access(botId);
    assert.equal(saved.mode, 'explicit', 'saving the form ends the legacy reading');
    assert.ok(saved.revision > first.revision, 'the revision rose');
    assert.deepEqual(saved.apps.find(a => a.id === 'gh1').tools.map(t => t.state), ['off', 'off', 'off']);
    assert.equal(saved.apps.find(a => a.id === 'google').tools[0].state, 'on', 'the other apps are as they were');
    await click(`${HOST} [data-app=gh1] .bots-switch`);
    await waitFor(`!!document.querySelector('${HOST} [data-scope=gh1]')`);
    await click(`${HOST} [data-scope=gh1] [data-value=read]`);
    await waitFor2(async () => (await access(botId)).grants.connector_scopes.gh1 === 'read', 'github saved read-only');
    saved = await access(botId);
    const github = saved.apps.find(a => a.id === 'gh1').tools;
    assert.deepEqual(Object.fromEntries(github.map(t => [t.name, t.state])), { list_issues: 'on', create_issue: 'off', frobnicate: 'off' },
      'read-only allows the read, refuses the write, and refuses a tool whose effect is not known');
    assert.match(github.find(t => t.name === 'frobnicate').reason, /not known to be read-only/);

    // ================= Advanced: pick tools, block a built-in, search =============================================================
    await js("window.__adv = true; import('/static/js/botsUi.js').then(m => { m.setAdvanced(true); return true; })");
    await waitFor(`!!document.querySelector('${HOST} .bots-grants-native')`);
    await js(`(() => { const b = [...document.querySelectorAll('${HOST} .bots-btn')].find(n => /Choose tools/.test(n.textContent)); if (!b) throw new Error('no Choose tools'); b.click(); return true; })()`);
    await waitFor(`!!document.querySelector('${HOST} [data-tool="gh1:list_issues"]')`);
    assert.match(await text(`${HOST} [data-tool="gh1:frobnicate"]`), /Effect unknown/);
    await click(`${HOST} [data-tool="gh1:list_issues"] .bots-switch`);
    await waitFor2(async () => JSON.stringify((await access(botId)).grants.connector_tools.gh1.tools) === JSON.stringify(['create_issue', 'frobnicate']), 'a picked tool list saved');
    saved = await access(botId);
    assert.equal(saved.apps.find(a => a.id === 'gh1').tools.find(t => t.name === 'list_issues').state, 'off');
    assert.equal(saved.apps.find(a => a.id === 'gh1').tools.find(t => t.name === 'create_issue').state, 'off', 'a picked tool is still refused when the scope is read-only');

    await click(`${HOST} [data-native=Bash] .bots-switch`);
    await waitFor2(async () => (await access(botId)).grants.tool_scope.deny.includes('native:Bash'), 'Bash blocked');
    assert.equal(await checked(`${HOST} [data-native=Bash] .bots-switch`), false);
    assert.equal(await js(`document.querySelector('${HOST} [data-native=send_email] .bots-switch').disabled`), true, 'an unavailable built-in cannot be switched on');
    await js(`(() => { const i = document.querySelector('${HOST} .bots-grants-search'); i.value = 'read'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitFor(`!document.querySelector('${HOST} [data-native=Bash]') && !!document.querySelector('${HOST} [data-native=Read]')`);
    await js(`(() => { const i = document.querySelector('${HOST} .bots-grants-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await waitFor(`!!document.querySelector('${HOST} [data-native=Bash]')`);
    await capture('desktop-bots-grants-advanced');

    // ================= A refused save puts the screen back =========================================================================
    demoState.botsGrants.failNext = 'refuse';
    expected.push('github is not available, so it cannot be switched on.');
    await clearToasts();
    await click(`${HOST} [data-native=Bash] .bots-switch`);
    await waitFor2(async () => (await errorToasts()).length > 0, 'the refusal is shown');
    await waitFor2(async () => (await checked(`${HOST} [data-native=Bash] .bots-switch`)) === false, 'the switch went back');
    assert.ok((await access(botId)).grants.tool_scope.deny.includes('native:Bash'), 'the server still has Bash blocked');
    await clearToasts();

    // ================= A stale revision reloads the current state ================================================================
    demoState.botsGrants.bump[botId] = (demoState.botsGrants.bump[botId] || 0) + 1;   // someone else changed access
    await click(`${HOST} [data-native=Read] .bots-switch`);
    await waitFor(`!!document.querySelector('${HOST} .bots-grants-stale')`);
    assert.match(await text(`${HOST} .bots-grants-stale`), /changed somewhere else/);
    assert.equal(await checked(`${HOST} [data-native=Read] .bots-switch`), true, 'the unsaved change is not shown as saved');
    assert.ok(!(await access(botId)).grants.tool_scope.deny.includes('native:Read'));
    await click(`${HOST} .bots-grants-stale .bots-btn`);
    await waitFor(`!document.querySelector('${HOST} .bots-grants-stale')`);
    await click(`${HOST} [data-native=Read] .bots-switch`);
    await waitFor2(async () => (await access(botId)).grants.tool_scope.deny.includes('native:Read'), 'after a reload the save goes through');
    demoState.botsGrants.failNext = 'stale';
    await click(`${HOST} [data-native=Read] .bots-switch`);
    await waitFor(`!!document.querySelector('${HOST} .bots-grants-stale')`);

    // ================= Destroyed while a save is on its way ===========================================================================
    await click(`${HOST} .bots-grants-stale .bots-btn`);
    await waitFor(`!document.querySelector('${HOST} .bots-grants-stale')`);
    await js(`(() => { document.querySelector('${HOST} [data-native=Read] .bots-switch').click(); window.__grants.destroy(); return true; })()`);
    await delay(400);
    assert.equal(await exists(`${HOST} .bots-grants`), false, 'nothing is drawn after destroy');

    // ================= Inside the real panel ==========================================================================================
    await js(`(async () => {
      const P = await import('/static/js/botsPanel.js');
      window.__panel?.destroy();
      document.getElementById('bots-gr-host')?.remove();
      const host = document.createElement('div');
      host.id = 'bots-gr-host';
      host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:min(420px,42vw);z-index:30;background:var(--bots-panel)';
      document.body.append(host);
      window.__panel = P.mountBotPanel(host, { agentId: ${q(botId)}, mode: 'advanced', onClose: () => {} });
      return true;
    })()`);
    await waitFor(`!!document.querySelector('${HOST} .bots-acc-head[data-section=access]')`);
    await click(`${HOST} .bots-acc-head[data-section=access]`);
    await waitFor(`!!document.querySelector('${HOST} [data-panel-card=access] .bots-grants .bots-grants-ceiling')`);
    assert.match(await text(`${HOST} [data-panel-card=access]`), /Connected apps/, 'the panel mounts the grants section');
    await js("window.__panel?.destroy(); true");

    // ================= Phone ======================================================================================================
    phone = true;
    win.setContentSize(390, 800); await delay(500);
    await mountGrants(botId, true);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll at phone width');
    assert.ok(await js(`[...document.querySelectorAll('${HOST} .bots-switch-row')].every(n => n.getBoundingClientRect().height >= 40)`), 'rows are easy to hit');
    await capture('phone-bots-grants');
    win.setContentSize(1440, 900); await delay(400); phone = false;

    assert.deepEqual((await errorToasts()).filter(t => !expected.includes(t)), [], 'no unexpected error toast');
    assert.deepEqual(await js('window.__errs'), [], 'no script errors in the page');
  } finally {
    try {
      await js("window.__grants?.destroy(); window.__panel?.destroy(); document.getElementById('bots-gr-host')?.remove(); document.documentElement.dataset.appMode = window.__prior || ''; true");
      if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
      await js(`localStorage.setItem('kairos:bots-interface', ${q(savedInterface)}); if (!${q(savedInterface)}) localStorage.removeItem('kairos:bots-interface'); true`);
      if (phone) win.setContentSize(1440, 900);
      await delay(600);   // the shell's badge refresh after the delete still needs the fixtures
    } finally {
      delete demoState.botsGrants; delete demoState.botsSectionModules; delete demoState.botsAttention;
      await restore();
    }
  }
};
