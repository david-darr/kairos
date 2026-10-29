// Bots redesign, Phase 0 unit U1 (2026-10-28): the older Agents tab still works against records that carry the
// new Bots fields. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-data-only
// The Bots fixture backend (scripts/fixtures/bots-core-backend.cjs) answers /api/agents* while demoState.botsLive is
// set: a record with the new fields (section, place, hidden, thread data), an archived bot, and the real create route.
const assert = require('node:assert/strict');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Records carry the new fields; one bot is archived (still returned), one sits in a section.
    assert.equal((await call('/api/agents/a2', 'PATCH', { hidden: true })).status, 200);
    assert.equal((await call('/api/agents/a1', 'PATCH', { section: 'Work', place: 'browser' })).status, 200);
    const listed = (await call('/api/agents', 'GET')).body;
    const scout = listed.find(a => a.id === 'a1'), archivist = listed.find(a => a.id === 'a2');
    assert.deepEqual([scout.section, scout.place, scout.hidden, scout.approval_mode, scout.thread_limit], ['Work', 'browser', false, 'full', 3], 'the list carries the new fields');
    assert.equal(archivist.hidden, true, 'an archived bot is still returned');
    assert.equal(scout.instructions, scout.soul, 'instructions reads as the one standing-instruction field');
    const headers = (await call('/api/sessions?agent_id=a1', 'GET')).body;
    assert.ok(headers.length >= 2 && headers.every(h => h.thread && typeof h.thread === 'object'), 'the session listing carries the thread record');
    assert.equal(headers.filter(h => h.thread.main).length, 1, 'one main thread');

    // The older Agents tab renders every bot, the archived one included, from those records.
    await navigate('agents');
    await waitFor("[...document.querySelectorAll('.agents-rail-item')].some(n => n.dataset.search.includes('scout'))");
    assert.ok(await js("[...document.querySelectorAll('.agents-rail-item')].some(n => n.dataset.search.includes('archivist'))"), 'the older tab loses no bot to Archive');
    await capture?.('desktop-bots-data-legacy-agents');

    // Its create dialog still posts, and the route accepts it against the new record.
    const before = writes.length;
    await js("document.querySelector('.agents-rail-create [aria-label=\"New agent\"]').click()");
    await waitFor("!!document.querySelector('.agent-create-dialog')");
    await fill('.agent-create-dialog [aria-label="Bot name"]', 'Legacy Made');
    await fill('.agent-create-dialog [aria-label=Soul]', 'Standing text from the older dialog');
    await js("document.querySelector('.agent-create-footer .btn.primary').click()");
    await waitFor("!!document.querySelector('.agent-profile-sheet:not([hidden])')");
    for (let i = 0; i < 60 && !writes.slice(before).some(w => w.method === 'POST' && w.path === '/api/agents' && w.status); i++) await delay(50);
    const post = writes.slice(before).find(w => w.method === 'POST' && w.path === '/api/agents');
    assert.ok(post, 'the older dialog posts a new bot');
    assert.equal(post.status, 200, 'and the route accepts it');
    assert.equal(JSON.parse(post.body).name, 'Legacy Made');
    const made = (await call('/api/agents', 'GET')).body.find(a => a.name === 'Legacy Made');
    assert.ok(made, 'the new bot is in the list');
    assert.deepEqual([made.hidden, made.approval_mode, made.thread_limit, made.soul], [false, 'full', 3, 'Standing text from the older dialog'], 'it gets the new fields and its standing instructions in one field');
    assert.equal(await js("document.querySelector('.agent-profile-titlebar h2').textContent"), 'Legacy Made', 'its profile opens');

    // The older profile's way of saving "How it should work" now changes the field the model reads.
    const saved = await call('/api/agents/' + made.id, 'PATCH', { instructions: 'Edited the old way' });
    assert.deepEqual([saved.status, saved.body.soul, saved.body.instructions], [200, 'Edited the old way', 'Edited the old way']);

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    delete demoState.botsLive;
    delete demoState.botsCore;
  }
};
