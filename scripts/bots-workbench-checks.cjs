// Integration gate after the orchestrator wires the Monitor button. No live account or Electron run on the builder.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, demoState, base, writes, capture }) => {
  const q = JSON.stringify;
  const restore = await isolateBotsCheck({ js, demoState }, { botsWorkbench: { bots: {}, profiles: [], settings: { max_running: 2, idle_minutes: 10 }, counter: 0, log: [] } });
  const originalSize = win.getContentSize();
  const preferences = await js(`Object.fromEntries([${q('kairos:bots-workbench-width')}].map(k => [k, localStorage.getItem(k)]))`);
  let botId, sid;
  const until = async predicate => { for (const end = Date.now() + 10000; Date.now() < end; await delay(50)) if (predicate()) return; assert.fail('Fixture did not settle'); };
  const call = (url, method = 'GET', body) => js(`fetch(${q(url)}, { method: ${q(method)}, headers: {'Content-Type':'application/json'}, body: ${body ? q(JSON.stringify(body)) : 'undefined'} }).then(async r => ({ status:r.status, body:await r.json() }))`);
  const click = selector => js(`(() => { const n=document.querySelector(${q(selector)}); if(!n) throw new Error('Missing '+${q(selector)}); n.click(); })()`);
  const clickText = (selector, text) => js(`(() => { const n=[...document.querySelectorAll(${q(selector)})].find(n=>n.textContent.trim()===${q(text)}); if(!n) throw new Error('Missing '+${q(text)}); n.click(); })()`);
  const refresh = () => js(`import('/static/js/botsWorkbenchHost.js').then(async m => { const h=await m.openWorkbench(${q(botId)},{threadId:${q(sid)},tab:'computer'}); await h.refresh(); })`);
  try {
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    botId = (await call('/api/agents', 'POST', { name: `Workbench ${Math.random().toString(36).slice(2, 9)}` })).body.id;
    assert.ok(botId, 'created a unique bot');
    sid = (await call(`/api/agents/${botId}/threads`, 'POST', { title: 'Workbench checks' })).body.id;
    assert.ok(sid, 'created its own conversation');
    await navigate('botsShell', { agentId: botId, sessionId: sid });
    await waitFor("!!document.querySelector('.bots-monitor')");
    await js("document.querySelector('.bots-monitor').focus()");
    const startMark = writes.length;
    await click('.bots-monitor');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'asleep'");
    assert.equal(writes.slice(startMark).filter(w => w.path.endsWith('/computer/start')).length, 0, 'opening only looks');
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
    await waitFor("!document.querySelector('.bots-workbench')");
    assert.equal(await js("document.activeElement.classList.contains('bots-monitor')"), true, 'Escape restores focus');
    await click('.bots-monitor');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'asleep'");
    for (const [phase, message, button] of [['starting', 'Starting the computer', 'Check again'], ['ready', 'Computer is ready', 'Take control'], ['off', 'Computer use is off', 'Choose a place'], ['asleep', 'Computer is asleep', 'Start']]) {
      demoState.botsWorkbench.bots[botId].phase = phase;
      demoState.botsWorkbench.bots[botId].running = phase === 'ready';
      await refresh();
      assert.equal(await js("document.querySelector('.bots-workbench-phase').textContent"), message);
      assert.equal(await js("document.querySelector('.bots-workbench-action').textContent"), button);
    }
    await click('.bots-workbench-action');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'ready'");
    await click('.bots-workbench-action');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'taken'");
    assert.equal(await js("document.querySelector('.bots-workbench-phase').textContent"), 'You have the wheel');
    demoState.botsWorkbench.bots[botId].lease_id = 'another-device';
    await click('.bots-workbench-action');
    await waitFor("document.querySelector('.bots-workbench-error').textContent.includes('Control changed')");
    assert.equal(demoState.botsWorkbench.bots[botId].taken_over, true, 'stale release keeps control');
    // Reopen to obtain the current lease, then hand it back.
    await js("import('/static/js/botsWorkbenchHost.js').then(m=>m.closeWorkbench())");
    await click('.bots-monitor');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'taken'");
    await click('.bots-workbench-action');
    await waitFor("document.querySelector('.bots-workbench-computer')?.dataset.phase === 'ready'");
    await click('.bots-place input');
    await clickText('.bots-place-option', 'Browser');
    await waitFor("document.querySelector('.bots-place')?.textContent.includes('Pinned for this conversation')");
    assert.equal(demoState.botsCore.threads.find(t => t.id === sid).thread.place, 'browser');
    await clickText('.bots-place button', 'Unpin');
    await waitFor("!document.querySelector('.bots-place')?.textContent.includes('Pinned for this conversation')");
    await click('[data-tab="browser"]');
    await waitFor("!!document.querySelector('.bots-browser-address') && !!document.querySelector('.bots-workbench-action')");
    await click('.bots-workbench-action');
    await waitFor("!document.querySelector('.bots-browser-address').disabled");
    await js("document.querySelector('.bots-browser-address').value='example.com'; document.querySelector('.bots-browser-chrome').requestSubmit()");
    await until(() => demoState.botsWorkbench.bots[botId].url === 'https://example.com');
    assert.ok(demoState.botsWorkbench.log.some(row => row[0] === 'input' && row[2].kind === 'navigate'));
    await click('[data-tab="computer"]');
    for (const [id, button] of [['help-done', 'Done'], ['help-cancel', 'Cancel']]) {
      demoState.botsWorkbench.bots[botId].help = { id, reason: 'Please sign in', site: 'example.com', thread_id: sid };
      await refresh();
      await clickText('.bots-help-card button', button);
      await until(() => demoState.botsWorkbench.bots[botId].settled.includes(id));
      assert.equal(demoState.botsWorkbench.bots[botId].settled.filter(x => x === id).length, 1);
      assert.equal((await call(`/api/bot-workbench/${botId}/help/${id}/settle`, 'POST', { outcome: 'done' })).status, 409);
    }
    await click('[data-tab="files"]');
    await waitFor("document.querySelector('.bots-workbench-files')?.textContent.includes('Not shared')");
    await win.setContentSize(390, 844);
    await waitFor("getComputedStyle(document.querySelector('.bots-workbench')).position === 'fixed'");
    assert.ok(await js("Math.abs(document.querySelector('.bots-workbench').getBoundingClientRect().width-innerWidth)<2"), 'phone workbench fills viewport');
    await capture?.('phone-bots-workbench');
  } finally {
    await js("import('/static/js/botsWorkbenchHost.js').then(m=>m.closeWorkbench({restoreFocus:false}))").catch(() => {});
    if (sid) await call(`/api/agents/${botId}/threads/delete`, 'POST', { thread_ids: [sid] }).catch(() => {});
    if (botId) await call(`/api/agents/${botId}`, 'DELETE').catch(() => {});
    await win.setContentSize(...originalSize);
    await js(`(() => { for(const [k,v] of Object.entries(${q(preferences)})) { if(v===null) localStorage.removeItem(k); else localStorage.setItem(k,v); } })()`).catch(() => {});
    await restore();
  }
};
