// Bots redesign, Phase 4 unit U1 (2026-10-29): the handoff chip and the reach editor, mounted in a scratch container
// under data-app-mode="bots". Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-delegation-only
// The delegation lane (scripts/fixtures/bots-delegation-backend.cjs) answers /api/bot-peers for the bots this check
// seeds in demoState.botsDelegation; the core lane makes and deletes the two bots.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, win, capture, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const delegation = { reach: {}, assignments: [], writes: [] };
  const restore = await isolateBotsCheck({ js, demoState }, { botsDelegation: delegation });
  const made = [];
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const stamp = Date.now().toString(36);
    for (const name of [`Lead ${stamp}`, `Reader ${stamp}`]) {
      const created = await call('/api/agents', 'POST', { name });
      assert.equal(created.status, 200, 'the check makes its own bot');
      made.push((await call('/api/agents', 'GET')).body.find(a => a.name === name));
    }
    const [lead, reader] = made;
    delegation.reach[lead.id] = { mode: 'listed', peers: [], revision: 1 };
    await js(`(() => { const box = document.createElement('div'); box.id = 'bots-delegation-scratch'; box.dataset.appMode = 'bots';
      box.style.cssText = 'position:fixed;inset:0 auto auto 0;width:360px;max-height:100vh;overflow:auto;z-index:9999;background:var(--bots-canvas, #fff)';
      box.innerHTML = '<div id="reach-host"></div><div id="chip-host"></div><div id="repeat-host"></div>'; document.body.append(box); })()`);

    // Reach: widening from "no bots" to "all" needs the acknowledgement before Save works.
    await js(`import('/static/js/botsSectionReach.js').then(m => { window.__reach = m.mount(document.getElementById('reach-host'), { agentId: ${JSON.stringify(lead.id)} }); })`);
    await waitFor("!!document.querySelector('#reach-host select')");
    const reachState = "(() => { const r = document.querySelector('#reach-host'); return { mode: r.querySelector('select').value, ack: !r.querySelector('.bots-reach-ack').hidden, save: !r.querySelector('.bots-reach-save').disabled, picker: !r.querySelector('.bots-reach-picker').hidden }; })()";
    assert.deepEqual(await js(reachState), { mode: 'listed', ack: false, save: true, picker: true }, 'listed reach shows its bot list');
    assert.equal(await js(`!![...document.querySelectorAll('#reach-host .bots-reach-picker input')].find(i => i.value === ${JSON.stringify(reader.id)})`), true, 'the other bot is offered');
    assert.equal(await js(`!![...document.querySelectorAll('#reach-host .bots-reach-picker input')].find(i => i.value === ${JSON.stringify(lead.id)})`), false, 'a bot never lists itself');
    await js("(() => { const s = document.querySelector('#reach-host select'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()");
    assert.deepEqual(await js(reachState), { mode: 'all', ack: true, save: false, picker: false }, 'widening asks for the acknowledgement');
    await js("(() => { const a = document.querySelector('#reach-host [data-reach-ack]'); a.checked = true; a.dispatchEvent(new Event('change')); })()");
    assert.equal((await js(reachState)).save, true, 'acknowledged, Save is enabled');
    await capture?.('desktop-bots-delegation-reach-widen');
    await js("document.querySelector('#reach-host .bots-reach-save').click()");
    await waitFor("document.querySelector('#reach-host select')?.value === 'all' && document.querySelector('#reach-host .bots-reach-ack').hidden");
    assert.equal(delegation.reach[lead.id].mode, 'all');
    assert.equal(delegation.writes.at(-1).acknowledge_scope, true, 'the save carried the acknowledgement');
    assert.equal(delegation.writes.at(-1).expected_revision, 1, 'the save carried the revision it read');
    // From "all", narrowing needs no acknowledgement.
    await js("(() => { const s = document.querySelector('#reach-host select'); s.value = 'none'; s.dispatchEvent(new Event('change')); })()");
    assert.deepEqual(await js(reachState), { mode: 'none', ack: false, save: true, picker: false }, 'narrowing saves directly');
    // A stale revision shows the server's refusal instead of saving.
    delegation.reach[lead.id].revision = 7;
    await js("document.querySelector('#reach-host .bots-reach-save').click()");
    await waitFor("!!document.querySelector('#reach-host .bots-reach-error')?.textContent");
    assert.match(await js("document.querySelector('#reach-host .bots-reach-error').textContent"), /changed/);
    assert.equal(delegation.reach[lead.id].mode, 'all', 'the stale save changed nothing');

    // Handoff chip: queued, working, done with a result, failed, and a consult question answered inline.
    const chip = row => js(`import('/static/js/botsHandoffChip.js').then(m => {
      if (!window.__chip) window.__chip = m.mount(document.getElementById('chip-host'), { row: ${JSON.stringify({})}, answer: async (id, text) => { window.__answered = [id, text]; } });
      window.__chip.refresh(${JSON.stringify(row)}); return document.getElementById('chip-host').textContent; })`);
    const partner = { id: reader.id, name: reader.name };
    assert.match(await chip({ mode: 'work', status: 'queued', partner, reason: 'Check the sources', done_when: 'Sources listed' }),
      new RegExp(`Delegated ${reader.name}.*Queued.*Check the sources.*Done when: Sources listed`));
    assert.match(await chip({ mode: 'work', status: 'running', partner }), /Working/);
    await chip({ mode: 'work', status: 'completed', partner, result: 'Three sources found.\nAll current.' });
    assert.equal(await js("document.querySelector('#chip-host .bots-handoff-reply summary').textContent"), 'Three sources found.', 'the reply preview is the first line');
    await js("document.querySelector('#chip-host .bots-handoff-reply').open = true");
    assert.match(await js("document.querySelector('#chip-host .bots-handoff-result').textContent"), /All current/);
    await chip({ mode: 'work', status: 'failed', partner });
    assert.equal(await js("document.querySelector('#chip-host .bots-handoff').dataset.tone"), 'danger', 'a failure shows the danger tone');
    await chip({ mode: 'consult', status: 'needs_input', partner, question: 'Which year?', inbox_item_id: 'q1' });
    assert.match(await js("document.getElementById('chip-host').textContent"), /Asked.*Waiting for you.*Which year\?/);
    await js("(() => { const t = document.querySelector('#chip-host textarea'); t.value = '2025'; document.querySelector('#chip-host .bots-handoff-answer button').click(); })()");
    await waitFor("document.getElementById('chip-host').textContent.includes('Answer sent')");
    assert.deepEqual(await js('window.__answered'), ['q1', '2025']);

    // Repeat chip.
    await js(`import('/static/js/botsHandoffChip.js').then(m => { window.__repeat = m.mount(document.getElementById('repeat-host'), { row: { type: 'repeat', count: 5, tool: 'Bash', preview: 'npm test' } }); })`);
    assert.match(await js("document.getElementById('repeat-host').textContent"), /Same call repeated 5 times, it may be stuck.*Bash: npm test/);

    // Phone width: nothing in the scratch column is wider than it; every control is reachable.
    const overflow = await js("[...document.querySelectorAll('#bots-delegation-scratch *')].filter(n => n.getBoundingClientRect().right > 361).map(n => n.className || n.tagName)");
    assert.deepEqual(overflow, [], 'no sideways overflow at phone width');
    assert.equal(await js("getComputedStyle(document.querySelector('#reach-host .bots-reach-save')).minHeight !== '0px'"), true, 'buttons keep a row height');
    await capture?.('phone-bots-delegation-chips');
  } finally {
    try {
      await js("(() => { for (const k of ['__reach', '__chip', '__repeat']) { window[k]?.destroy(); delete window[k]; } delete window.__answered; document.getElementById('bots-delegation-scratch')?.remove(); })()");
      for (const bot of made) if (bot) await call(`/api/agents/${bot.id}`, 'DELETE');
    } finally { await restore(); }
  }
};
