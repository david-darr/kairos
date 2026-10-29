// Bot profile and draft retention, migrated to the Bots panel (Phase 1 check migration; flag --agents-profile-only).
// The old check drove the Agents profile sheet; the same intents now run in the real Bots page and panel
// (navigate('agents', { agentId, profile: true }) lands in the panel): a Memory draft that survives a real poll,
// keeps focus and its caret and is saved by choice; the exact connection, version and reasoning saved by the Model
// section; the look saved from Identity; the peer allow-list saved by id; field limits; the standing instructions
// counted in UTF-8 bytes; settings search; SOUL.md drift with a stale apply refused; Escape and phone behaviour; and a
// default look that does not change between reloads. The inbox answer and review approval the old check also covered
// belong to the Bots inbox and are asserted in bots-attention-checks.cjs. It makes its own bots and removes nothing it
// did not make; preferences are restored in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, writes, demoState, win, capture, base }) => {
  const q = JSON.stringify;
  const call = (path, method = 'GET', body) => js(`fetch(${q(path)}, { method: ${q(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : q(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const exists = selector => js(`!!document.querySelector(${q(selector)})`);
  const click = selector => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.click(); return true; })()`);
  const type = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); if (!n) throw new Error('missing ' + ${q(selector)}); n.focus(); n.value = ${q(value)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const choose = (selector, value) => js(`(() => { const n = document.querySelector(${q(selector)}); n.value = ${q(value)}; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const pressEscape = () => js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
  const panel = '#bots-panel';
  const card = id => `${panel} [data-panel-card=${id}]`;
  // The panel draws once when it loads and again when its overview arrives; open a section only after the body is shown.
  const openSection = async id => {
    const shown = `(() => { const b = document.querySelector('${panel} .bots-acc-item[data-section=${id}][data-open=true] .bots-acc-body'); return !!b && b.getClientRects().length > 0; })()`;
    for (let i = 0; i < 40; i++) {
      if (await js(shown)) return;
      if (!(await exists(`${panel} .bots-acc-item[data-section=${id}][data-open=true]`))) await click(`${panel} .bots-acc-head[data-section=${id}]`);
      await delay(150);
    }
    throw new Error('Could not open section ' + id + ' ' + await js(`[...document.querySelectorAll('${panel} .bots-acc-item')].map(n => n.dataset.section + ':' + n.dataset.open + ':' + n.querySelector('.bots-acc-body')?.hidden).join(' ')`));
  };
  const patches = (from, id) => writes.slice(from).filter(w => w.path === `/api/agents/${id}` && w.method === 'PATCH').map(w => JSON.parse(w.body || '{}'));
  const waitPatch = async (from, id, test, what) => {
    for (let i = 0; i < 100; i++) { if (patches(from, id).some(test)) return; await delay(50); }
    throw new Error(`Timed out waiting for a saved change: ${what}. Saw ${JSON.stringify(patches(from, id))}`);
  };
  const record = async id => (await call(`/api/agents/${id}`)).body.agent;
  const setAdvanced = on => js(`import('/static/js/botsUi.js').then(m => { m.setAdvanced(${on}); return true; })`);
  const openPanelFor = async (id, extra = {}) => {
    await navigate('agents', { agentId: id, profile: true, ...extra });
    await waitFor(`document.documentElement.dataset.botsAgent === ${q(id)} && !!document.querySelector('${panel} .bots-acc-item, ${panel} .bots-tabs')`);
  };

  const restore = await isolateBotsCheck({ js, demoState });
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    await js("fetch('/api/agents').then(r => r.json()).then(() => true)");
    const stamp = Date.now() % 100000;
    const bot = (await call('/api/agents', 'POST', { name: `Profile Probe ${stamp}`, role: 'Original job', soul: 'Be brief and kind.' })).body;
    const friend = (await call('/api/agents', 'POST', { name: `Profile Friend ${stamp}` })).body;
    assert.ok(bot.id && friend.id, 'the check made its own bots');
    await setAdvanced(true);

    // 1. The old profile link opens the panel on the bot's own page; Escape closes it and returns focus to the header.
    await openPanelFor(bot.id);
    assert.equal(await js(`document.querySelector('${panel}').getAttribute('role')`), 'dialog');
    assert.equal(await js(`document.querySelectorAll('${panel} .bots-acc-item').length`), 14, 'the panel shows its fourteen sections');
    await capture?.('desktop-bots-profile-panel');
    await pressEscape();
    await waitFor(`!document.querySelector('${panel}')`);
    assert.ok(await js("document.activeElement?.classList.contains('bots-head-pill') || document.activeElement === document.body"), 'focus returns to the header when the panel closes');
    await openPanelFor(bot.id);

    // 2. A Memory draft survives a real poll, keeps focus and caret, and is saved only by choice.
    await openSection('memory');
    await waitFor(`!!document.querySelector('${card('memory')} textarea')`);
    await delay(500);
    await js(`(() => { const area = document.querySelector('${card('memory')} textarea'); area.focus(); area.value = 'Half-typed memory draft'; area.dispatchEvent(new Event('input', { bubbles: true })); area.setSelectionRange(7, 7); })()`);
    assert.ok(await js(`document.activeElement === document.querySelector('${card('memory')} textarea')`), 'the memory draft has focus');
    await delay(21500);   // the panel polls every 20 seconds
    demoState.botsCore.memoryText = { ...(demoState.botsCore.memoryText || {}), [bot.id]: 'Updated by the bot' };
    await delay(21500);
    assert.equal(await js(`document.querySelector('${card('memory')} textarea').value`), 'Half-typed memory draft', 'a newer saved memory does not overwrite the draft');
    let mark = writes.length;
    await click(`${card('memory')} .bots-actions .bots-btn`);
    for (let i = 0; i < 80 && !writes.slice(mark).some(w => w.path === `/api/agents/${bot.id}/memory` && w.method === 'PUT' && w.status); i++) await delay(50);
    assert.ok(writes.slice(mark).some(w => w.path === `/api/agents/${bot.id}/memory` && JSON.parse(w.body).text === 'Half-typed memory draft'), 'memory saves by choice');

    // 3. Model: connection, version and reasoning come from the catalog and are saved exactly.
    await openSection('model');
    await waitFor(`!!document.querySelector('${card('model')} select[aria-label="Connection"]')`);
    mark = writes.length;
    await choose(`${card('model')} select[aria-label="Connection"]`, 'm2');
    await waitFor(`[...document.querySelector('${card('model')} select[aria-label="Model version"]').options].some(o => o.value === 'workspace-fast')`);
    assert.ok(await js(`[...document.querySelector('${card('model')} select[aria-label="Model version"]').options].some(o => o.textContent === 'Workspace Fast')`), 'versions show the catalog names');
    await choose(`${card('model')} select[aria-label="Model version"]`, 'workspace-fast');
    await choose(`${card('model')} select[aria-label="Reasoning"]`, 'high');
    assert.ok(await js(`document.querySelector('${card('model')} .agent-model-summary').textContent.includes('Codex · Workspace Fast · high')`), 'the summary shows connection, version and effort');
    await waitPatch(mark, bot.id, p => p.endpoint_id === 'm2' && p.model_override === 'workspace-fast' && p.model_effort === 'high', 'the full model selection');
    await js(`document.querySelector('${card('model')} select[aria-label="Reasoning"]').focus()`);

    // 4. Identity: the look saves; field limits are in place.
    await openSection('identity');
    await waitFor(`!!document.querySelector('${card('identity')} .bots-avatar-editor')`);
    mark = writes.length;
    await click(`${card('identity')} [aria-label="Kip accessory"] [data-value=quill]`);
    await waitPatch(mark, bot.id, p => p.avatar?.acc === 'quill', 'the look');
    assert.equal((await record(bot.id)).avatar.acc, 'quill', 'the profile saved the look');
    assert.equal(await js(`document.querySelector('${card('identity')} .bots-identity .bots-text-row:nth-child(1) input').maxLength`), 100, 'name limit');
    assert.equal(await js(`document.querySelector('${card('identity')} .bots-identity .bots-text-row:nth-child(2) input').maxLength`), 200, 'job limit');

    // 5. Access saves the selected peer by id, through the reach editor (Phase 4: "Only these bots").
    await openSection('access');
    const reach = `${card('access')} .bots-reach`;
    await waitFor(`!!document.querySelector('${reach} select')`);
    await js(`(() => { const s = document.querySelector('${reach} select'); s.value = 'listed'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor(`[...document.querySelectorAll('${reach} .bots-reach-picker label')].some(n => n.textContent.includes(${q(friend.name)}))`);
    await js(`(() => { const box = [...document.querySelectorAll('${reach} .bots-reach-picker label')].find(n => n.textContent.includes(${q(friend.name)})).querySelector('input');
      box.checked = true; box.dispatchEvent(new Event('change'));
      const ack = document.querySelector('${reach} [data-reach-ack]'); if (!ack.closest('label').hidden) { ack.checked = true; ack.dispatchEvent(new Event('change')); } })()`);
    mark = writes.length;
    await js(`document.querySelector('${reach} .bots-reach-save').click()`);
    for (let tries = 0; tries < 50 && !((await record(bot.id)).peers || []).includes(friend.id); tries++) await delay(100);
    assert.equal(await js(`document.querySelector('${reach} .bots-reach-error')?.textContent || ''`), '', 'the save was not refused');
    assert.ok(writes.slice(mark).some(w => w.method === 'PUT' && w.path === `/api/bot-peers/${bot.id}/reach` && JSON.parse(w.body).peers.includes(friend.id)), 'the reach save names the peer');
    assert.deepEqual((await record(bot.id)).peers, [friend.id], 'the peer id persisted in the profile');

    // 6. Standing instructions are counted in UTF-8 bytes and multi-byte characters stay whole.
    await openSection('soul');
    await type(`${card('soul')} textarea`, '🙂'.repeat(7000));
    assert.ok(await js(`new TextEncoder().encode(document.querySelector('${card('soul')} textarea').value).length`) <= 24000, 'soul is held to 24,000 UTF-8 bytes');
    assert.ok(await js(`/24,000 bytes/.test(document.querySelector('${card('soul')} .bots-count').textContent)`), 'the byte counter is shown');
    assert.equal(await js(`document.querySelector('${card('soul')} textarea').value.length % 2`), 0, 'multi-byte characters are kept whole');
    await type(`${card('soul')} textarea`, 'Be brief and kind.');
    await js(`document.querySelector('${card('soul')} textarea').blur()`);

    // 7. Search filters the sections; clearing brings them back.
    await type(`${panel} .bots-search`, 'soul');
    const shown = () => js(`[...document.querySelectorAll('${panel} .bots-acc-item')].filter(n => !n.hidden && n.getClientRects().length).map(n => n.dataset.section)`);
    await waitFor(`[...document.querySelectorAll('${panel} .bots-acc-item')].filter(n => !n.hidden && n.getClientRects().length).length < 14`);
    assert.ok((await shown()).includes('soul'), 'search keeps the matching section');
    await type(`${panel} .bots-search`, '');
    await waitFor(`[...document.querySelectorAll('${panel} .bots-acc-item')].filter(n => !n.hidden && n.getClientRects().length).length === 14`);

    // 8. SOUL.md drift is shown, a stale apply is refused with its reason, and a later apply is by choice.
    demoState.botsCore.soulFiles = { ...(demoState.botsCore.soulFiles || {}), [bot.id]: 'External soul edit' };
    await navigate('home'); await openPanelFor(bot.id);
    await openSection('soul');
    await waitFor(`!!document.querySelector('${card('soul')} .bots-drift')`);
    assert.ok(await js(`document.querySelector('${card('soul')} .bots-drift').textContent.includes('External soul edit')`), 'file drift is shown');
    demoState.botsCore.soulFiles[bot.id] = 'Changed once more outside Kairos';
    await js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
    const useFile = () => js(`[...document.querySelectorAll('${card('soul')} .bots-drift .bots-btn')].find(n => /Use the file/.test(n.textContent)).click()`);
    await useFile();
    await waitFor("[...document.querySelectorAll('#toast-host .toast.error')].length > 0");
    assert.equal((await record(bot.id)).soul, 'Be brief and kind.', 'a stale apply changed nothing');
    await js("document.querySelectorAll('#toast-host .toast').forEach(n => n.remove())");
    await waitFor(`/Changed once more outside Kairos/.test(document.querySelector('${card('soul')} .bots-drift')?.textContent || '')`);
    await useFile();
    await waitFor(`!document.querySelector('${card('soul')} .bots-drift')`);
    assert.equal((await record(bot.id)).soul, 'Changed once more outside Kairos', 'the external file is applied by choice');

    // 9. On a phone the panel covers the page and Escape closes it.
    win.setContentSize(390, 844);
    await delay(400);
    assert.ok(await js(`(() => { const r = document.querySelector('${panel}').getBoundingClientRect(); return r.width >= innerWidth - 2 && r.left <= 1; })()`), 'the panel covers phone content');
    await capture?.('phone-bots-profile-panel');
    await pressEscape();
    await waitFor(`!document.querySelector('${panel}')`);
    win.setContentSize(1440, 900);
    await delay(300);

    // 10. A bot with no saved look gets the same default every time it is drawn, across reloads.
    const bare = demoState.botsCore.agents.find(a => a.id === friend.id);
    bare.color = null; delete bare.avatar;
    const face = () => js(`document.querySelector('.bots-rail-row[data-agent-id=${friend.id}] img')?.src || ''`);
    // (The page remembers a look it already drew, so measure from a fresh load.)
    const loaded = async () => {
      await win.loadURL(base);
      await waitFor(`document.documentElement.dataset.appMode === 'bots' && !!document.querySelector('.bots-rail-row[data-agent-id=${friend.id}] img')`);
      return face();
    };
    const firstFace = await loaded();
    assert.ok(firstFace, 'the bot has a face');
    for (let reload = 0; reload < 2; reload++) assert.equal(await loaded(), firstFace, 'the missing-look default is stable across reloads');
  } finally {
    win.setContentSize(1440, 900);
    await restore();
  }
  console.log('PASS: Bots profile panel (drafts, model, look, peers, limits, drift, phone, stable default).');
};
