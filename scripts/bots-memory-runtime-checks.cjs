// Bots Phase 2, unit U2: Memory activity, recall, forget and About you, in the renderer.
// Run: python run_electron_target.py <worktree> --bots-memory-runtime-only <log> 600
//   (or node scripts/run-electron-test.cjs ui-smoke --bots-memory-runtime-only)
// Mounts the real botsSectionMemoryActivity.js and botsSectionAboutYou.js in a scratch host against the in-memory
// lane (fixtures/bots-memory-runtime-backend.cjs). It creates its own bot, never assumes which other bots exist,
// and removes everything it made, and restores its page preferences, in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, writes, demoState, base }) => {
  const q = JSON.stringify;
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const text = selector => js(`document.querySelector(${q(selector)})?.textContent || ''`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const type = (selector, value, enter = false) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)});
    n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true }));
    if (${enter}) n.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  const buttonWith = label => js(`(() => { const b = [...document.querySelectorAll('#mr-host .bots-btn')].find(n => n.textContent.trim() === ${q(label)}); if (!b) throw new Error('no button ' + ${q(label)}); b.click(); return true; })()`);
  const hasButton = label => js(`[...document.querySelectorAll('#mr-host .bots-btn')].some(n => n.textContent.trim() === ${q(label)} && !n.hidden)`);
  const yes = () => click('.confirm-panel .modal-footer .btn:last-child');
  const errorToasts = () => js("[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)");
  const lane = () => demoState.botsMemoryRuntime;
  const mount = (module, id) => js(`(async () => {
    window.__mr?.destroy?.();
    document.getElementById('mr-host')?.remove();
    const host = document.createElement('div');
    host.id = 'mr-host';
    host.style.cssText = 'position:fixed;right:0;top:0;bottom:0;width:420px;overflow:auto;z-index:30;background:var(--bots-panel);padding:12px';
    document.body.append(host);
    const M = await import('/static/js/${module}.js');
    window.__refreshes = 0; window.__flushes = 0;
    window.__mr = await M.mount(host, { agentId: ${q(id)}, state: { agent: { id: ${q(id)} } }, advanced: true,
      flush: async () => { window.__flushes++; }, refresh: async () => { window.__refreshes++; }, go() {} });
    return true;
  })()`);
  const sectionText = () => text('#mr-host');

  const restore = await isolateBotsCheck({ js, demoState });
  let botId = null, phone = false;
  // Bots mode polls the attention lane; give it an empty one of its own so no route is missing, and put back whatever was there.
  const hadAttention = Object.hasOwn(demoState, 'botsAttention'), priorAttention = demoState.botsAttention;
  try {
    demoState.botsLive = true;
    demoState.botsAttention = { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] };
    delete demoState.botsMemoryRuntime;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js(`(() => { window.__prior = document.documentElement.dataset.appMode || ''; document.documentElement.dataset.appMode = 'bots';
      window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message)));
      window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason && e.reason.stack || e.reason))); return true; })()`);
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");   // seeds the in-memory backend
    const made = await call('/api/agents', 'POST', { name: `Memory Probe ${Date.now() % 100000}`, role: 'Keeps notes' });
    assert.equal(made.status, 200, 'the check makes its own bot');
    botId = made.body.id;
    lane();   // the lane is created on first use
    await call('/api/bots/profile');   // creates the lane state

    // ================= Memory activity: empty, then real reports =================================================================
    await mount('botsSectionMemoryActivity', botId);
    await waitFor("document.querySelector('#mr-host').textContent.includes('Nothing tidied yet')");
    assert.match(await sectionText(), /Nothing tidied yet\. It tidies once a day after 03:00/, 'a named empty state, not a blank card');
    assert.match(await sectionText(), /Nothing noticed yet/);
    assert.match(await sectionText(), /No ideas right now/);
    assert.equal(await hasButton('Tidy now'), true);
    assert.ok(await exists('#mr-host .bots-mact-input[aria-label="Search its notes and past chats"]'));

    const nowSeconds = Date.now() / 1000;
    Object.assign(lane().bots[botId], {
      pending_threads: 2, pending_turns: 5,
      capture: { kind: 'capture', at: nowSeconds - 120, saved: 2, profile: 1, deferred: 0, topics: ['workspace'], rejected: { 'no evidence': 1 } },
      report: { kind: 'tidy', at: nowSeconds - 3 * 3600, expired: 2, duplicates: 1, superseded: 0, deferred: 0, organized: 0, contradictionsChecked: 1, topicChecks: 0, note: '' },
      dream: { last_run: nowSeconds - 86400, report: { kind: 'dream', at: nowSeconds - 86400, patterns: 1, outdated: 2, ideas: 1, note: '' } },
      ideas: [{ id: 'i1', title: 'Plan Sundays', text: 'A routine that sets up the week.', kind: 'routine', created: nowSeconds - 3600, expires: nowSeconds + 23 * 3600 },
        { id: 'i2', title: 'Expired idea', text: 'Should never show.', kind: 'skill', created: nowSeconds - 90000, expires: nowSeconds - 3600 }],
    });
    await js('window.__mr.refresh()');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Plan Sundays')");
    const shown = await sectionText();
    assert.match(shown, /Noticed 2 min ago/);
    assert.match(shown, /Saved\s*2/);
    assert.match(shown, /workspace/, 'the captured topic');
    assert.match(shown, /Not kept\s*1 no evidence/);
    assert.match(shown, /Tidied 3 h ago/);
    assert.match(shown, /Expired\s*2/);
    assert.match(shown, /Looked back 1 d ago/);
    assert.match(shown, /2 chats waiting to be noticed \(5 exchanges\)/);
    assert.match(shown, /2[23] h left/, 'an idea says how long it has left');
    assert.match(shown, /Nothing is made until you ask/, 'an idea never creates anything');
    assert.doesNotMatch(shown, /Expired idea/, 'an expired idea is not shown');
    await capture('desktop-bots-memory-activity');

    // ================= Tidy now ================================================================================================
    await buttonWith('Tidy now');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Tidying now')");
    assert.equal(lane().tidied, 1);
    assert.ok(writes.some(w => w.method === 'POST' && w.path === `/api/bots/${botId}/memory/tidy`), 'Tidy now posted to the bot');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Tidied just now')", 6000);

    // ================= Recall with a citation, opened as inert text ===============================================================
    lane().results.henderson = [{ kind: 'conversation', title: 'Trip', source: 'c1', ref: 'msg-1', role: 'user', ts: nowSeconds - 86400, text: 'The Henderson deal closes in March.' }];
    lane().messages['msg-1'] = 'The Henderson deal closes in March. <img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    await type('#mr-host .bots-mact-input[aria-label="Search its notes and past chats"]', 'henderson', true);
    await waitFor("!!document.querySelector('#mr-host .bots-mact-result')");
    assert.match(await text('#mr-host .bots-mact-cite'), /^You in Trip, \d{4}-\d{2}-\d{2}$/, 'the result names its conversation');
    assert.equal(await js("document.querySelector('#mr-host .bots-mact-result').dataset.ref"), 'msg-1', 'with a stable message reference');
    await click('#mr-host .bots-mact-result .bots-btn');
    await waitFor("!!document.querySelector('#mr-host .bots-mact-opened')");
    assert.match(await text('#mr-host .bots-mact-opened'), /<img src=x/, 'imported text is shown as text');
    assert.equal(await exists('#mr-host .bots-mact-opened img, #mr-host .bots-mact-opened script'), false, 'and never becomes markup');
    await delay(100);
    assert.equal(await js('window.__pwned === undefined'), true, 'nothing ran');
    await type('#mr-host .bots-mact-input[aria-label="Search its notes and past chats"]', 'nothingmatches', true);
    await waitFor("document.querySelector('#mr-host').textContent.includes('Nothing found')");

    // ================= Forget ====================================================================================================
    await type('#mr-host .bots-mact-input[aria-label="A name or word to forget"]', 'ab', true);
    await waitFor("document.querySelector('#mr-host').textContent.includes('at least three letters')");
    assert.deepEqual(lane().forgot, [], 'a short word is refused before anything is sent');
    await type('#mr-host .bots-mact-input[aria-label="A name or word to forget"]', 'Henderson');
    await buttonWith('Forget');
    await waitFor("!!document.querySelector('.confirm-panel')");
    await yes();
    await waitFor("document.querySelector('#mr-host').textContent.includes('Forgot \"Henderson\"')");
    assert.deepEqual(lane().forgot, ['Henderson']);
    assert.ok(await js('window.__refreshes >= 1'), 'the panel is told to refresh after a forget');
    assert.equal(await exists('#mr-host .bots-mact-result'), false, 'old results are cleared');

    // ================= Memory off says so ========================================================================================
    lane().bots[botId].memory_enabled = false;
    await js('window.__mr.refresh()');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Memory is off for this bot')");
    assert.equal(await js("[...document.querySelectorAll('#mr-host .bots-btn')].find(n => n.textContent.trim() === 'Tidy now').disabled"), true, 'Tidy now is off while memory is off');
    await type('#mr-host .bots-mact-input[aria-label="Search its notes and past chats"]', 'henderson', true);
    await waitFor("document.querySelector('#mr-host').textContent.includes('Memory is off, so there is nothing to search')");
    lane().bots[botId].memory_enabled = true;
    lane().bots[botId].upkeep = false;
    await js('window.__mr.refresh()');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Automatic notes are off')");
    assert.equal(await js("[...document.querySelectorAll('#mr-host .bots-btn')].find(n => n.textContent.trim() === 'Tidy now').disabled"), true);
    lane().bots[botId].upkeep = true;

    // ================= A failure is recoverable ==================================================================================
    lane().failActivity = true;
    await mount('botsSectionMemoryActivity', botId);
    await waitFor("!!document.querySelector('#mr-host .bots-mact-error')");
    assert.match(await text('#mr-host .bots-mact-error'), /could not be read/);
    lane().failActivity = false;
    await buttonWith('Retry');
    await waitFor("!!document.querySelector('#mr-host .bots-mact .bots-card')");
    assert.equal(await exists('#mr-host .bots-mact-error'), false);

    // ================= Destroyed while a request is pending ======================================================================
    await js(`(async () => {
      const host = document.createElement('div'); host.id = 'mr-gone'; document.body.append(host);
      const M = await import('/static/js/botsSectionMemoryActivity.js');
      const handle = await M.mount(host, { agentId: ${q(botId)}, flush: async () => {}, refresh: async () => {} });
      handle.destroy(); await new Promise(r => setTimeout(r, 400));
      window.__goneEmpty = host.children.length === 0; host.remove(); return true;
    })()`);
    assert.equal(await js('window.__goneEmpty'), true, 'a destroyed section draws nothing when its request returns');

    // ================= About you =================================================================================================
    lane().profile = { text: 'I live in Lisbon.', hash: 'h1', learned: [{ id: 'f1', text: 'Likes jazz', learned_by: 'Scout', at: nowSeconds - 3 * 86400 },
      { id: 'f2', text: 'Runs on Sundays', learned_by: 'Scout', at: nowSeconds - 3600 }] };
    await mount('botsSectionAboutYou', botId);
    await waitFor("!!document.querySelector('#mr-host .bots-mact-about')");
    assert.equal(await js("document.querySelector('#mr-host .bots-mact-about').value"), 'I live in Lisbon.');
    assert.match(await text('#mr-host .bots-mact-counter'), /^17 \/ 24,000 characters$/);
    assert.match(await sectionText(), /Likes jazz[\s\S]*Learned by Scout, 3 d ago/);

    const before = writes.length;
    await type('#mr-host .bots-mact-about', 'I live in Lisbon. I run.');
    await delay(200);
    assert.equal(writes.slice(before).filter(w => w.method === 'PUT').length, 0, 'autosave waits for a pause');
    await waitFor("document.querySelector('#mr-host .bots-mact-status').textContent === 'Saved'", 5000);
    const puts = writes.slice(before).filter(w => w.method === 'PUT' && w.path === '/api/bots/profile');
    assert.equal(puts.length, 1, 'one save for the burst');
    assert.equal(lane().profile.text, 'I live in Lisbon. I run.');
    assert.match(puts[0].body, /"expected_hash":"h1"/, 'the save carries the hash it was opened with');

    lane().profile.learned.length = 2;
    await click('#mr-host .bots-mact-fact[data-fact=f1] .bots-btn');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Bots will not learn that again')");
    assert.equal(await exists('#mr-host .bots-mact-fact[data-fact=f1]'), false, 'the removed fact is gone');
    assert.deepEqual(lane().profile.learned.map(f => f.id), ['f2']);

    lane().failProfile = true;
    await type('#mr-host .bots-mact-about', 'I live in Lisbon. I run. Fails.');
    await waitFor("/Could not save/.test(document.querySelector('#mr-host .bots-mact-status').textContent)", 5000);
    assert.equal(await hasButton('Retry'), true, 'a failed save offers Retry');
    assert.equal(await js("document.querySelector('#mr-host .bots-mact-about').value"), 'I live in Lisbon. I run. Fails.', 'the draft is kept');
    lane().failProfile = false;
    await buttonWith('Retry');
    await waitFor("document.querySelector('#mr-host .bots-mact-status').textContent === 'Saved'", 5000);
    assert.equal(lane().profile.text, 'I live in Lisbon. I run. Fails.');

    lane().conflictProfile = true;
    await type('#mr-host .bots-mact-about', 'Edited while it changed elsewhere');
    await waitFor("/changed somewhere else/.test(document.querySelector('#mr-host .bots-mact-status').textContent)", 5000);
    assert.equal(await hasButton('Reload'), true, 'a conflict offers Reload');
    lane().conflictProfile = false;
    await buttonWith('Reload');
    await waitFor("document.querySelector('#mr-host .bots-mact-about').value === 'I live in Lisbon. I run. Fails.'");

    lane().profile.learned = [];
    await js('window.__mr.refresh()');
    await waitFor("document.querySelector('#mr-host').textContent.includes('Nothing learned yet')");

    // ================= Phone layout =============================================================================================
    phone = true;
    win.setContentSize(390, 800); await delay(500);
    await mount('botsSectionMemoryActivity', botId);
    await waitFor("!!document.querySelector('#mr-host .bots-mact .bots-card')");
    assert.equal(await js("(() => { const h = document.getElementById('mr-host'); return h.scrollWidth <= h.clientWidth + 1; })()"), true, 'no sideways scroll in the section at phone width');
    assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'no sideways scroll on the page');
    await capture('phone-bots-memory-activity');
    win.setContentSize(1440, 900); await delay(400); phone = false;

    assert.deepEqual(await errorToasts(), [], 'no error toast');
    assert.deepEqual(await js('window.__errs'), [], 'no script errors in the page');
  } finally {
    try {
      await js("window.__mr?.destroy?.(); document.getElementById('mr-host')?.remove(); document.getElementById('mr-gone')?.remove(); document.querySelectorAll('.modal-backdrop').forEach(n => n.remove()); document.documentElement.dataset.appMode = window.__prior || ''; true");
      if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
      if (phone) win.setContentSize(1440, 900);
      await delay(1500);   // let any attention poll already under way finish while its lane still answers
    } finally {
      delete demoState.botsMemoryRuntime;
      if (hadAttention) demoState.botsAttention = priorAttention; else delete demoState.botsAttention;
      await restore();
    }
  }
};
