// Bots Phase 3, unit U1: approval levels in the renderer.
// Run: python run_electron_target.py <worktree> --bots-approvals-only <log> 600
//   (or node scripts/run-electron-test.cjs ui-smoke --bots-approvals-only)
// Mounts the real botsSectionPermissions.js in a scratch host, against the in-memory Bots backend
// (fixtures/bots-core-backend.cjs and fixtures/bots-approvals-backend.cjs). It makes two bots with two conversations each, never
// assumes which other bots exist, stands in for the desktop shell's prompt, and removes everything it made in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const clearToasts = () => js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
  const waitFor2 = async (test, what) => {
    for (let i = 0; i < 80; i++) { if (await test()) return; await delay(50); }
    throw new Error('Timed out: ' + what);
  };
  const HOST = '#bots-ap-host';
  const view = (bot, thread) => call(`/api/bots-approvals/${bot}${thread ? `?thread_id=${thread}` : ''}`).then(r => r.body);
  const modeWrites = () => writes.filter(w => w.method === 'POST' && /\/api\/bots-approvals\/[^/]+\/mode$/.test(w.path));
  const mount = async (bot, thread, advanced) => {
    await js(`(async () => {
      const M = await import('/static/js/botsSectionPermissions.js');
      window.__perm?.destroy();
      document.getElementById('bots-ap-host')?.remove();
      const host = document.createElement('div');
      host.id = 'bots-ap-host';
      host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:380px;overflow:auto;z-index:30;background:var(--bots-panel);padding:12px';
      document.body.append(host);
      window.__adv = ${advanced ? 'true' : 'false'};
      window.__perm = await M.mount(host, { agentId: ${q(bot)}, threadId: ${thread ? q(thread) : 'null'}, state: { agent: { outbound: { policy: 'allow', daily_cap: 3 } } },
        advanced: () => window.__adv, update: async () => {}, go: () => {} });
      return true;
    })()`);
    await waitFor(`!!document.querySelector('${HOST} .bots-permissions-level')`);
  };
  const expected = [];

  const savedInterface = await js("localStorage.getItem('kairos:bots-interface') || ''");
  const restore = await isolateBotsCheck({ js, demoState });
  const botIds = [];
  let phone = false;
  try {
    demoState.botsLive = true;
    delete demoState.botsApprovals;
    demoState.botsSectionModules = ['Permissions'];
    demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__prior = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason)));
      return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend
    const stamp = Date.now() % 100000;
    for (const name of [`Approvals A ${stamp}`, `Approvals B ${stamp}`]) {
      const made = await call('/api/agents', 'POST', { name, role: 'Checks approvals' });
      assert.equal(made.status, 200, 'the check makes its own bots');
      botIds.push(made.body.id);
    }
    const [A, B] = botIds;
    const threadsA = (await call(`/api/bots-approvals-fixture/${A}/threads`, 'POST', { count: 2 })).body.ids;
    const threadsB = (await call(`/api/bots-approvals-fixture/${B}/threads`, 'POST', { count: 2 })).body.ids;
    // Stands in for electron/bot-approvals.js: the same three steps after the person says yes (window.__accept).
    await js(`(() => {
      window.__accept = true; window.__desktopCalls = [];
      const post = (step, body) => fetch('/api/internal/bots-approvals/' + step, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async r => { if (!r.ok) throw new Error((await r.json()).detail); return r.json(); });
      window.jarvis = { ...(window.jarvis || {}), botApprovals: { elevate: async request => {
        window.__desktopCalls.push(request.request_id);
        const body = { request_id: request.request_id, bot_id: request.bot_id, thread_id: request.thread_id ?? null, mode: request.mode, revision: request.revision };
        if (!window.__accept) { await post('revoke', { request_id: request.request_id }); return { ok: false, message: 'Nothing was changed.' }; }
        try { for (const step of ['confirm', 'activate', 'commit']) await post(step, body); return { ok: true }; }
        catch (error) { await post('revoke', { request_id: request.request_id }); return { ok: false, message: error.message }; }
      } } };
      return true;
    })()`);

    // ================= Full is the default, and each conversation reads its own level =================================
    await js("import('/static/js/botsUi.js').then(m => m.setAdvanced(false))");
    assert.equal((await view(A)).mode, 'full');
    assert.equal((await view(B, threadsB[0])).mode, 'full');
    await mount(A, threadsA[0], false);
    assert.match(await text(`${HOST} [data-chip=level]`), /This conversation follows the bot \(Full\)/);
    assert.equal(await js(`document.querySelector('${HOST} [aria-label=Approval] [role=radio][aria-checked=true]')?.dataset.value`), 'full', 'Just do it is selected');
    assert.match(await text(`${HOST} .bots-permissions-outbound`), /At Full it sends on its own/);
    await capture('desktop-bots-approvals-simple');

    // ================= An override on one conversation leaves the others alone, and lowering is immediate =================
    const before = modeWrites().length;
    await click(`${HOST} .bots-permissions-level [data-value=ask]`);
    const started = Date.now();
    while (modeWrites().length === before && Date.now() - started < 300) await delay(10);
    assert.equal(modeWrites().length, before + 1, 'the change was sent at once, not behind the 400 ms profile debounce');
    await waitFor2(async () => (await view(A, threadsA[0])).mode === 'ask', 'the conversation drops to Ask');
    assert.equal((await view(A, threadsA[1])).mode, 'full', 'the bot own other conversation is untouched');
    assert.equal((await view(A)).mode, 'full', 'so is the bot');
    assert.equal((await view(B, threadsB[0])).mode, 'full', 'and the other bot');
    await waitFor(`/This conversation: Ask/.test(document.querySelector('${HOST} [data-chip=level]')?.textContent || '')`);
    assert.equal(await exists(`${HOST} .bots-permissions-level .bots-btn`), true, 'a way back to following the bot');
    await js(`(() => { [...document.querySelectorAll('${HOST} .bots-btn')].find(n => /Follow the bot/.test(n.textContent)).click(); return true; })()`);
    await waitFor2(async () => (await view(A, threadsA[0])).inherited === true, 'the conversation follows its bot again');

    // ================= A bot-wide change: the whole bot, then raising goes through the desktop =========================
    await click(`${HOST} [data-chip=level]`);   // no-op click: the chip is text
    await mount(A, null, false);
    await click(`${HOST} .bots-permissions-level [data-value=ask]`);
    await waitFor2(async () => (await view(A)).mode === 'ask', 'the bot drops to Ask');
    assert.equal((await view(B)).mode, 'full');
    assert.equal(await js(`document.querySelector('${HOST} [aria-label=Approval] [role=radio][aria-checked=true]')?.dataset.value`), 'ask');
    // declined at the desktop prompt: nothing changes and the person is told
    await js('window.__accept = false; true');
    await clearToasts();
    expected.push('Nothing was changed.');
    await click(`${HOST} .bots-permissions-level [data-value=full]`);
    await waitFor2(async () => (await errorToasts()).some(t => /Nothing was changed/.test(t)), 'the decline is shown');
    assert.equal((await view(A)).mode, 'ask', 'a declined raise changes nothing');
    assert.equal(await js('window.__desktopCalls.length'), 1);
    assert.equal(await js(`document.querySelector('${HOST} [aria-label=Approval] [role=radio][aria-checked=true]')?.dataset.value`), 'ask', 'the screen went back');
    // accepted
    await js('window.__accept = true; true');
    await click(`${HOST} .bots-permissions-level [data-value=full]`);
    await waitFor2(async () => (await view(A)).mode === 'full', 'the confirmed raise commits');
    assert.equal(await js('window.__desktopCalls.length'), 2);
    // a plain request to raise is refused by the server itself
    await call(`/api/bots-approvals/${A}/mode`, 'POST', { mode: 'ask', scope: 'bot' });
    const refused = await call(`/api/bots-approvals/${A}/mode`, 'POST', { mode: 'full', scope: 'bot' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.detail, /desktop/);
    // without the desktop shell the page cannot raise anything
    await js('window.__saved = window.jarvis.botApprovals; delete window.jarvis.botApprovals; true');
    await mount(A, null, false);
    await clearToasts();
    expected.push('Raising approval needs the Kairos desktop app. Open it there.');
    await click(`${HOST} .bots-permissions-level [data-value=full]`);
    await waitFor2(async () => (await errorToasts()).some(t => /desktop app/.test(t)), 'no desktop, no raise');
    assert.equal((await view(A)).mode, 'ask');
    await js('window.jarvis.botApprovals = window.__saved; true');

    // ================= Advanced: all five levels, the unavailable one says why, keyboard works =========================
    await js("window.__adv = true; import('/static/js/botsUi.js').then(m => { m.setAdvanced(true); return true; })");
    await mount(A, threadsA[1], true);
    const radios = await js(`[...document.querySelectorAll('${HOST} [aria-label=Approval] [role=radio]')].map(n => n.dataset.value)`);
    assert.deepEqual(radios, ['ask', 'edits', 'auto', 'full', 'custom']);
    assert.equal(await js(`document.querySelector('${HOST} [data-value=custom]').disabled`), true, 'Custom is unavailable here');
    assert.match(await text(`${HOST} .bots-permissions-level`), /Custom: Custom is for Codex/);
    assert.match(await text(`${HOST} [data-value=full]`), /desktop app/, 'a raise says it will ask in the desktop');
    // arrow keys move the choice; focus reaches the group by keyboard
    await js(`(() => { document.querySelector('${HOST} [aria-label=Approval] [role=radio][aria-checked=true]').focus(); return true; })()`);
    assert.equal(await js(`document.activeElement.getAttribute('role')`), 'radio');
    assert.equal(await js(`document.querySelectorAll('${HOST} [role=radio][tabindex="0"]').length > 0`), true, 'one stop in the tab order');
    // ArrowUp from Ask wraps round to Full: that is a raise, so the desktop is asked (declined here) and nothing changes
    await js('window.__accept = false; true');
    const asks = await js('window.__desktopCalls.length');
    await js(`(() => { const g = document.querySelector('${HOST} [aria-label=Approval]'); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); return true; })()`);
    await waitFor2(async () => (await js('window.__desktopCalls.length')) === asks + 1, 'the arrow key chose a level');
    assert.equal((await view(A, threadsA[1])).mode, 'ask', 'a declined raise leaves the conversation at Ask');
    await js('window.__accept = true; true');
    await capture('desktop-bots-approvals-advanced');
    // a conversation set wider than its bot without the handshake does not take effect (server rule, mirrored)
    await call(`/api/bots-approvals/${A}/mode`, 'POST', { mode: 'ask', scope: 'bot' });
    const widen = await call(`/api/bots-approvals/${A}/mode`, 'POST', { mode: 'edits', scope: 'thread', thread_id: threadsA[1] });
    assert.equal(widen.status, 409, 'a conversation cannot be widened with a plain request');

    // ================= The allowance: used up, then it asks ==============================================================
    await call(`/api/bots-approvals/${A}/mode`, 'POST', { mode: 'ask', scope: 'all_threads' });
    await mount(A, null, false);
    for (let i = 1; i <= 3; i++) {
      const sent = (await call(`/api/bots-approvals-fixture/${A}/send`, 'POST', {})).body;
      assert.deepEqual([sent.decision, sent.source], ['allow', 'allowance'], `send ${i} draws on the allowance`);
    }
    const fourth = (await call(`/api/bots-approvals-fixture/${A}/send`, 'POST', {})).body;
    assert.deepEqual([fourth.decision, fourth.source], ['ask', 'allowance-exhausted'], 'the next send asks');
    await js('window.__perm.refresh()');
    await waitFor(`/3 of 3 outside messages used today/.test(document.querySelector('${HOST} .bots-permissions-outbound')?.textContent || '')`);
    assert.match(await text(`${HOST} .bots-permissions-outbound`), /0 left/);
    // Full does not draw on it
    const other = (await call(`/api/bots-approvals-fixture/${B}/send`, 'POST', {})).body;
    assert.deepEqual([other.decision, other.source], ['allow', 'full']);
    assert.equal((await call(`/api/bots-approvals/${B}/outbound`)).body.used, 0);

    // ================= Remembered commands ===============================================================================
    await call(`/api/bots-approvals-fixture/${A}/rule`, 'POST', { command: 'make test', cwd: 'C:/work' });
    await js("window.__adv = true; true");
    await mount(A, null, true);
    await waitFor(`!!document.querySelector('${HOST} .bots-permissions-commands [data-rule]')`);
    assert.match(await text(`${HOST} .bots-permissions-commands`), /make test/);
    await js(`(() => { [...document.querySelectorAll('${HOST} .bots-permissions-commands .bots-btn')].find(n => /Remove/.test(n.textContent)).click(); return true; })()`);
    await waitFor(`!document.querySelector('${HOST} .bots-permissions-commands [data-rule]')`);
    assert.equal((await call(`/api/bots-approvals/${A}/commands`)).body.rules.length, 0);

    // ================= Phone ============================================================================================
    phone = true;
    win.setContentSize(390, 800); await delay(500);
    await mount(A, threadsA[0], true);
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll at phone width');
    assert.ok(await js(`[...document.querySelectorAll('${HOST} .bots-radio-row')].every(n => n.getBoundingClientRect().height >= 40)`), 'rows are easy to hit');
    await capture('phone-bots-approvals');
    win.setContentSize(1440, 900); await delay(400); phone = false;

    assert.deepEqual((await errorToasts()).filter(t => !expected.includes(t)), [], 'no unexpected error toast');
    assert.deepEqual(await js('window.__errs'), [], 'no script errors in the page');
  } finally {
    try {
      await js("window.__perm?.destroy(); document.getElementById('bots-ap-host')?.remove(); if (window.jarvis) delete window.jarvis.botApprovals; document.documentElement.dataset.appMode = window.__prior || ''; true");
      for (const id of botIds) await call(`/api/agents/${id}`, 'DELETE').catch(() => {});
      await js(`localStorage.setItem('kairos:bots-interface', ${q(savedInterface)}); if (!${q(savedInterface)}) localStorage.removeItem('kairos:bots-interface'); true`);
      if (phone) win.setContentSize(1440, 900);
      await delay(600);
    } finally {
      delete demoState.botsApprovals; delete demoState.botsSectionModules; delete demoState.botsAttention;
      await restore();
    }
  }
};
