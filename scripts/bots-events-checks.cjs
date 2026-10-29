// Bots redesign, Phase 3 unit U4 (2026-10-29): webhook addresses and connected-app event triggers, end to end through the page's
// own network layer. Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-events-only
// The fixture backend (scripts/fixtures/bots-events-backend.cjs) answers /api/bot-webhooks* and /api/bot-app-triggers* while
// demoState.botsLive is set, with the keys, statuses and limits of routes/bot_event_routes.py. This check makes its own bot and
// its own sources, never assumes which other bots exist, and restores the fixture state in finally. It drives the same calls the
// Automations page makes (unit U3 owns that page's screens): capture a sample, copy the address, pause and test, read the
// attempts, restore a deleted source, pick an account and a filter, and follow a revoked account to its reconnect action.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, win, writes, demoState, base }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  // The harness hands a fixture the query string, not headers, so a sender's headers travel as lower-case query keys.
  const send = (hook, body, headers = {}, how = 'path') => {
    const secret = hook.address.split('/').pop();
    const query = new URLSearchParams(how === 'bearer' ? { ...headers, authorization: `Bearer ${secret}` } : how === 'header' ? { ...headers, 'x-kairos-secret': secret } : headers).toString();
    const path = `/api/bot-webhooks/in/${hook.id}${how === 'path' ? '/' + secret : ''}${query ? '?' + query : ''}`;
    return call(path, 'POST', body);
  };
  const errorToasts = "[...document.querySelectorAll('#toast-host .toast.error')].map(n => n.textContent)";
  const restore = await isolateBotsCheck({ js, demoState });
  try {
    demoState.botsLive = true;
    delete demoState.botsEvents;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Its own bot, found by the ID the route returns.
    const bot = await call('/api/agents', 'POST', { name: 'Events Check Bot' });
    assert.equal(bot.status, 200, 'the check makes its own bot');
    const botId = bot.body.id;
    assert.ok(botId, 'the new bot has an ID');

    // What the connected accounts really offer, and how each arrives.
    let mark = writes.length;
    const caps = (await call(`/api/bot-app-triggers/events?bot_id=${botId}`, 'GET')).body.capabilities;
    const mail = caps.find(c => c.id === 'mail'), kairos = caps.find(c => c.id === 'kairos');
    assert.ok(mail.available && mail.accounts.length >= 1, 'a connected email account is offered');
    assert.equal(kairos.delivery, 'instant');
    assert.equal(mail.delivery, 'poll');
    assert.match(mail.delivery_label, /Checked about every/, 'polling is labelled honestly');
    assert.equal(writes.length, mark, 'reading the catalogue writes nothing');

    // An app trigger: pick the account and a filter, test it, then see a revoked account ask to reconnect.
    mark = writes.length;
    const accountId = mail.accounts[0].id;
    const made = await call('/api/bot-app-triggers', 'POST', {
      bot_id: botId, name: 'Events check mail', events: ['mail.received'], config: { account_id: accountId },
      conditions: [{ path: 'data.from', equals: 'Boss' }], prompt_template: 'Triage the new mail.' });
    assert.equal(made.status, 200, 'the trigger is created');
    assert.equal(made.body.auto_run, false, 'it waits for the person unless Run straight away is on');
    assert.deepEqual(made.body.conditions, [{ path: 'data.from', equals: 'Boss' }], 'the filter is kept');
    assert.equal(writes.slice(mark).find(w => w.method === 'POST' && w.path === '/api/bot-app-triggers').status, 200);
    const tested = (await call(`/api/bot-app-triggers/${made.body.id}/test`, 'POST', {})).body;
    assert.equal(tested.reachable, true);
    assert.match(tested.note, /Nothing was started/, 'a test starts nothing');
    demoState.botsEvents.mailAccounts = [];
    const synced = (await call(`/api/bot-app-triggers/${made.body.id}/sync`, 'POST', {})).body;
    assert.equal(synced.trigger.state, 'needs_reconnect', 'a revoked account asks to reconnect');
    const gone = (await call('/api/bot-app-triggers/events', 'GET')).body.capabilities.find(c => c.id === 'mail');
    assert.deepEqual([gone.available, gone.fix], [false, { label: 'Connect email', target: 'email' }], 'the reconnect action is offered');
    const refused = await call('/api/bot-app-triggers', 'POST', { bot_id: botId, name: 'Again', events: ['mail.received'], prompt_template: 'x' });
    assert.equal(refused.status, 409, 'nothing new is made without an account');
    demoState.botsEvents.mailAccounts = [{ id: accountId, label: 'me@example.test' }];
    assert.equal((await call(`/api/bot-app-triggers/${made.body.id}/sync`, 'POST', {})).body.trigger.state, 'ok', 'reconnecting brings it back');
    assert.equal((await call(`/api/bot-app-triggers/${made.body.id}`, 'DELETE')).status, 200);
    assert.deepEqual((await call('/api/bot-app-triggers', 'GET')).body.deleted.map(d => d.id), [made.body.id], 'deleted, not gone');
    const back = await call(`/api/bot-app-triggers/${made.body.id}/restore`, 'POST', {});
    assert.deepEqual([back.status, back.body.enabled], [200, false], 'restored paused');

    // A webhook: create, copy the address, capture a sample, test with it, pause, read the attempts, delete and restore.
    mark = writes.length;
    const hook = (await call('/api/bot-webhooks', 'POST', { name: 'Events check hook', agent_id: botId, prompt_template: 'Look at it.',
      conditions: [{ path: 'type', equals: 'order.paid' }] })).body;
    assert.ok(hook.address.startsWith(`/api/bot-webhooks/in/${hook.id}/`), 'an address is made');
    assert.equal('secret' in hook, false);
    const copied = (await call(`/api/bot-webhooks/${hook.id}/address`, 'GET')).body.address;
    assert.equal(copied, hook.address, 'the owner copies the address from its own route');
    assert.equal(JSON.stringify((await call('/api/bot-webhooks', 'GET')).body).includes(hook.address.split('/').pop()), false, 'the list never carries it');
    assert.equal((await send(hook, {}, {}, 'none')).status, 403, 'no credential is refused');
    assert.equal((await call(`/api/bot-webhooks/in/${hook.id}/wrong`, 'POST', {})).status, 403);

    mark = writes.length;
    assert.equal((await call(`/api/bot-webhooks/${hook.id}/capture`, 'POST', {})).body.capturing, true);
    const captured = await send(hook, { type: 'order.paid', order: { id: 7 } });
    assert.deepEqual([captured.status, captured.body.status], [200, 'captured'], 'the next request is kept as the sample');
    const sample = (await call(`/api/bot-webhooks/${hook.id}/sample`, 'GET')).body;
    assert.deepEqual([sample.capturing, JSON.parse(sample.sample.body).order.id], [false, 7]);
    assert.equal(demoState.botsEvents.pending[hook.id] || 0, 0, 'capture starts nothing');
    const test = (await call(`/api/bot-webhooks/${hook.id}/test`, 'POST', {})).body;
    assert.equal(test.passes_filters, true, 'the sample passes the filter');
    assert.equal(demoState.botsEvents.pending[hook.id] || 0, 0, 'a test starts nothing');

    const first = await send(hook, { type: 'order.paid' }, { 'x-kairos-delivery': 'one' }, 'bearer');
    assert.deepEqual([first.status, first.body.waiting_for_approval], [202, true], 'a Bearer credential works and the work waits for the person');
    assert.equal((await send(hook, { type: 'order.paid' }, { 'x-kairos-delivery': 'one' }, 'header')).body.status, 'duplicate', 'a repeat is dropped');
    assert.equal((await send(hook, { type: 'refund' }, { 'x-kairos-delivery': 'two' })).body.status, 'ignored', 'the filter keeps other events out');

    const attempts = (await call(`/api/bot-webhooks/${hook.id}/attempts`, 'GET')).body;
    assert.ok(attempts.attempts.length >= 4 && attempts.attempts.length <= 30, 'the latest attempts are listed');
    assert.equal(JSON.stringify(attempts).includes(hook.address.split('/').pop()), false, 'no credential in the history');
    assert.ok(attempts.attempts.some(a => a.outcome === 'rejected') && attempts.attempts.some(a => a.outcome === 'captured'), 'the rejected and captured requests are in it');

    assert.equal((await call(`/api/bot-webhooks/${hook.id}`, 'PATCH', { enabled: false })).body.enabled, false, 'paused');
    assert.equal((await send(hook, { type: 'order.paid' }, { 'x-kairos-delivery': 'three' })).status, 404, 'a paused webhook is not there');
    await call(`/api/bot-webhooks/${hook.id}`, 'PATCH', { enabled: true });
    const rotated = (await call(`/api/bot-webhooks/${hook.id}/rotate`, 'POST', {})).body;
    assert.notEqual(rotated.address, hook.address);
    assert.equal((await send(hook, {}, { 'x-kairos-delivery': 'old' })).status, 403, 'the old address stops at once');

    assert.equal((await call(`/api/bot-webhooks/${hook.id}`, 'DELETE')).body.restorable_days, 7);
    assert.deepEqual((await call('/api/bot-webhooks', 'GET')).body.deleted.map(d => d.id), [hook.id], 'deleted, restorable');
    const returned = await call(`/api/bot-webhooks/${hook.id}/restore`, 'POST', {});
    assert.deepEqual([returned.status, returned.body.enabled], [200, false], 'restored paused');
    for (const w of writes.slice(mark)) {
      if (w.path.startsWith('/api/bot-webhooks/in/')) continue;
      assert.ok(w.status === undefined || w.status < 500, `${w.method} ${w.path} did not fail`);
    }

    assert.deepEqual(await js(errorToasts), [], 'no error toast');
  } finally {
    delete demoState.botsEvents;
    await restore();
  }
};
