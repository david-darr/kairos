// Bots redesign, Phase 0 unit U1 (2026-10-28), migrated for Phase 1: the API aliases keep working against records that
// carry the new Bots fields, and the retired Agents tab's links land in Bots. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-data-only
// The Bots fixture backend (scripts/fixtures/bots-core-backend.cjs) answers /api/agents* while demoState.botsLive is
// set: a record with the new fields (section, place, hidden, thread data), an archived bot, and the real create route.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, navigate, win, capture, writes, demoState, base }) => {
  const fill = (selector, value) => js(`(() => { const n=document.querySelector(${JSON.stringify(selector)}); n.value=${JSON.stringify(value)}; n.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const restore = await isolateBotsCheck({ js, demoState });
  try {
    demoState.botsLive = true;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Records carry the new fields; one bot is archived (still returned), one sits in a section.
    assert.equal((await call('/api/agents/a1', 'PATCH', { section: 'Work', place: 'browser', hidden: false })).status, 200);
    assert.equal((await call('/api/agents/a2', 'PATCH', { hidden: true })).status, 200);
    const listed = (await call('/api/agents', 'GET')).body;
    const scout = listed.find(a => a.id === 'a1'), archivist = listed.find(a => a.id === 'a2');
    assert.deepEqual([scout.section, scout.place, scout.hidden, scout.approval_mode, scout.thread_limit], ['Work', 'browser', false, 'full', 3], 'the list carries the new fields');
    assert.equal(archivist.hidden, true, 'an archived bot is still returned');
    assert.equal(scout.instructions, scout.soul, 'instructions reads as the one standing-instruction field');
    const headers = (await call('/api/sessions?agent_id=a1', 'GET')).body;
    assert.ok(headers.length >= 2 && headers.every(h => h.thread && typeof h.thread === 'object'), 'the session listing carries the thread record');
    assert.equal(headers.filter(h => h.thread.main).length, 1, 'one main thread');

    // The retired Agents tab's link lands on the Bots roster, which shows every bot: the visible ones as cards,
    // the archived one behind Archived (it is still returned, never lost).
    await navigate('agents');
    await waitFor("document.getElementById('view-content').dataset.view === 'botsHome' && !!document.querySelector('.bots-bot-card[data-agent-id=a1]')");
    assert.equal(await js("document.documentElement.dataset.appMode"), 'bots', 'the old link opens Bots');
    assert.equal(await js("!!document.querySelector('.bots-bot-card[data-agent-id=a2]')"), false, 'the archived bot is not a card');
    assert.equal(await js("document.querySelector('.bots-home-actions .bots-btn:nth-child(2)').hidden"), false, 'Archived is offered because a bot is archived');
    await capture?.('desktop-bots-data-agents-link');

    // The creation route still takes the older body (a name and standing text) and applies the new record's fields.
    const existingIds = new Set(listed.map(a => a.id));
    const before = writes.length;
    const post = await call('/api/agents', 'POST', { name: 'Legacy Made', soul: 'Standing text from the older dialog' });
    assert.equal(post.status, 200, 'the route accepts the older body');
    const made = (await call('/api/agents', 'GET')).body.find(a => !existingIds.has(a.id) && a.name === 'Legacy Made');
    assert.ok(made, 'the new bot is in the list');
    assert.ok(writes.slice(before).some(w => w.method === 'POST' && w.path === '/api/agents' && w.status === 200));
    assert.deepEqual([made.hidden, made.approval_mode, made.thread_limit, made.soul], [false, 'full', 3, 'Standing text from the older dialog'], 'it gets the new fields and its standing instructions in one field');
    // An old profile link opens the panel on that bot.
    assert.equal((await call(`/api/agents/${made.id}/threads`, 'POST', { title: 'First' })).status, 200, 'a bot opens on a conversation');
    await navigate('agents', { agentId: made.id, profile: true });
    await waitFor(`document.documentElement.dataset.botsAgent === ${JSON.stringify(made.id)} && !!document.querySelector('#bots-panel')`);
    await js("import('/static/js/botsPanelHost.js').then(h => h.closeBotSettings())");

    // The older profile's way of saving "How it should work" now changes the field the model reads.
    const saved = await call('/api/agents/' + made.id, 'PATCH', { instructions: 'Edited the old way' });
    assert.deepEqual([saved.status, saved.body.soul, saved.body.instructions], [200, 'Edited the old way', 'Edited the old way']);

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    await restore();
  }
};
