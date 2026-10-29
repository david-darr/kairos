// The webhook and connected-app event contract, as the Electron fixture honours it (Bots Phase 3 unit U4, 2026-10-29).
// Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 6, 8 (U4) and 9. Run: node scripts/test_bots_events_contract.cjs
// Holds scripts/fixtures/bots-events-backend.cjs to routes/bot_event_routes.py: capability availability, filters,
// attempt redaction, limits, restore, and that the fixture answers only its own routes.
const assert = require('node:assert/strict');
const factory = require('./fixtures/bots-events-backend.cjs');

const fresh = (extra = {}) => {
  const state = { botsLive: true };
  const backend = factory({ state, data: {}, now: 1_800_000_000 });
  Object.assign(backend, { state });
  const get = (route, query) => backend.read(route, query);
  const send = (route, method, body, query) => backend.mutate(route, method, body, query);
  Object.assign(fresh, extra);
  return { state, backend, get, send };
};
const status = (answer) => answer?._status ?? 200;
const make = (send, over = {}) => send('/api/bot-webhooks', 'POST', { name: 'Orders', agent_id: 'a1', prompt_template: 'Look.', ...over });
const secretOf = (hook) => hook.address.split('/').pop();
const post = (send, hook, body, query = {}) => send(`/api/bot-webhooks/in/${hook.id}/${secretOf(hook)}`, 'POST', body, query);

(() => {
  // It answers only its own namespaces, and only while a check has turned Bots on.
  const { state, get, send } = fresh();
  for (const route of ['/api/agents', '/api/bot-routines', '/api/bot-cards', '/api/triggers', '/api/bot-automations', '/api/bot-approvals/a1']) {
    assert.equal(get(route), undefined, `reads ${route} fall through`);
    assert.equal(send(route, 'POST', {}), undefined, `writes ${route} fall through`);
  }
  assert.notEqual(get('/api/bot-webhooks'), undefined);
  assert.notEqual(get('/api/bot-app-triggers'), undefined);
  state.botsLive = false;
  assert.equal(get('/api/bot-webhooks'), undefined, 'off unless a check turns it on');
  assert.equal(send('/api/bot-app-triggers', 'POST', {}), undefined);
})();

(() => {
  // The catalogue: real accounts only, honest delivery, a reason and a fix when something is not connected.
  const { state, get, send } = fresh();
  const caps = get('/api/bot-app-triggers/events').capabilities;
  assert.deepEqual(caps.map(c => c.id), ['mail', 'calendar', 'kairos']);
  for (const c of caps) assert.deepEqual(Object.keys(c).sort(), [...factory.CAPABILITY_KEYS].sort(), `${c.id} carries the documented keys`);
  const byId = Object.fromEntries(caps.map(c => [c.id, c]));
  assert.equal(byId.kairos.delivery, 'instant');
  assert.equal(byId.kairos.delivery_label, 'Instant');
  assert.equal(byId.mail.delivery, 'poll');
  assert.match(byId.mail.delivery_label, /every 15 minutes/);
  assert.deepEqual(byId.mail.accounts, [{ id: 'mail1', label: 'me@example.test' }]);
  assert.ok(byId.mail.available);
  assert.equal(JSON.stringify(caps).match(/slack|github|stripe|notion/i), null, 'nothing is promised that is not implemented');
  state.botsEvents.mailAccounts = [];
  const bare = get('/api/bot-app-triggers/events').capabilities.find(c => c.id === 'mail');
  assert.equal(bare.available, false);
  assert.match(bare.reason, /No email account/);
  assert.deepEqual(bare.fix, { label: 'Connect email', target: 'email' });
  const refused = send('/api/bot-app-triggers', 'POST', { bot_id: 'a1', name: 'M', events: ['mail.received'], prompt_template: 'x' });
  assert.equal(status(refused), 409);
  assert.equal(status(get('/api/bot-app-triggers/events', { bot_id: 'nope' })), 404);
})();

(() => {
  // Making an app trigger: one app each, owned account, bounded, extra fields refused, revision-checked, soft delete.
  const { state, get, send } = fresh();
  const base = { bot_id: 'a1', name: 'New mail', events: ['mail.received'], prompt_template: 'Triage.' };
  assert.equal(status(send('/api/bot-app-triggers', 'POST', { ...base, events: ['slack.message'] })), 400);
  assert.equal(status(send('/api/bot-app-triggers', 'POST', { ...base, events: ['mail.received', 'task.finished'] })), 400);
  assert.equal(status(send('/api/bot-app-triggers', 'POST', { ...base, secret: 'x' })), 422);
  assert.equal(status(send('/api/bot-app-triggers', 'POST', { ...base, config: { account_id: 'not-mine' } })), 404);
  assert.equal(status(send('/api/bot-app-triggers', 'POST', { ...base, bot_id: 'nope' })), 404);
  const sub = send('/api/bot-app-triggers', 'POST', base);
  assert.equal(sub.revision, 1);
  assert.equal(sub.auto_run, false, 'waits for the person unless Run straight away is on');
  assert.equal(sub.config.account_id, 'mail1', 'the one connected account is chosen');
  assert.equal('cursor' in sub, false, 'never exposes the cursor');
  const renamed = send(`/api/bot-app-triggers/${sub.id}`, 'PATCH', { expected_revision: '1', name: 'Renamed' });
  assert.equal(renamed.revision, 2);
  assert.equal(status(send(`/api/bot-app-triggers/${sub.id}`, 'PATCH', { expected_revision: '1', name: 'Late' })), 409);
  assert.equal(status(send(`/api/bot-app-triggers/${sub.id}`, 'PATCH', { ingress: 'x' })), 422);
  const tested = send(`/api/bot-app-triggers/${sub.id}/test`, 'POST', {});
  assert.equal(tested.reachable, true);
  assert.match(tested.note, /Nothing was started/);
  state.botsEvents.mailAccounts = [];
  const synced = send(`/api/bot-app-triggers/${sub.id}/sync`, 'POST', {});
  assert.equal(synced.state, 'needs_reconnect', 'a revoked account asks to reconnect');
  assert.equal(send(`/api/bot-app-triggers/${sub.id}/test`, 'POST', {}).reachable, false);
  assert.equal(send(`/api/bot-app-triggers/${sub.id}`, 'DELETE').ok, true);
  const listed = get('/api/bot-app-triggers');
  assert.deepEqual([listed.triggers.length, listed.deleted.map(d => d.id)], [0, [sub.id]]);
  const back = send(`/api/bot-app-triggers/${sub.id}/restore`, 'POST', {});
  assert.equal(back.enabled, false, 'restored paused');
  assert.equal(status(send(`/api/bot-app-triggers/${sub.id}/restore`, 'POST', {})), 404);
  for (let i = 0; i < 9; i++) state.botsEvents.appTriggers.push({ id: `x${i}`, agent_id: 'a1' });
  assert.equal(status(send('/api/bot-app-triggers', 'POST', base)), 409, 'ten per bot');
})();

(() => {
  // Webhook addresses: credentials, filters, limits, duplicates.
  const { get, send } = fresh();
  const hook = make(send, { conditions: [{ path: 'type', equals: 'order.paid' }], max_pending: 2 });
  assert.match(hook.address, new RegExp(`^/api/bot-webhooks/in/${hook.id}/[A-Za-z0-9_-]{20,}$`));
  assert.equal('secret' in hook, false, 'the secret is never listed');
  assert.equal(JSON.stringify(get('/api/bot-webhooks')).includes(secretOf(hook)), false, 'the address is shown only on its own route');
  assert.equal(get(`/api/bot-webhooks/${hook.id}/address`).address, hook.address);
  assert.equal(status(send(`/api/bot-webhooks/in/${hook.id}/wrong`, 'POST', {})), 403);
  assert.equal(status(send(`/api/bot-webhooks/in/nope/x`, 'POST', {})), 404);
  assert.equal(status(send(`/api/bot-webhooks/in/${hook.id}`, 'POST', { type: 'order.paid' }, { authorization: `Bearer ${secretOf(hook)}`, 'x-kairos-delivery': 'b1' })), 202, 'Bearer works');
  assert.equal(status(send(`/api/bot-webhooks/in/${hook.id}`, 'POST', { type: 'order.paid' }, { 'x-kairos-secret': secretOf(hook), 'x-kairos-delivery': 'h1' })), 202, 'X-Kairos-Secret works');
  assert.equal(status(post(send, hook, { type: 'order.paid' }, { 'x-kairos-delivery': 'p3' })), 429, 'two pending at most');
  const ignored = post(send, make(send, { name: 'Filtered', conditions: [{ path: 'type', equals: 'order.paid' }] }), { type: 'other' }, { 'x-kairos-delivery': 'f1' });
  assert.equal(ignored.status, 'ignored');
  const spare = make(send, { name: 'Spare', max_pending: 50 });
  assert.equal(status(post(send, spare, { n: 1 }, { 'x-kairos-delivery': 'd1' })), 202);
  assert.equal(post(send, spare, { n: 1 }, { 'x-kairos-delivery': 'd1' }).status, 'duplicate');
  for (let i = 0; i < 20; i++) post(send, spare, { n: i }, { 'x-kairos-delivery': `r${i}` });
  assert.equal(status(post(send, spare, { n: 99 }, { 'x-kairos-delivery': 'r99' })), 429, 'ten a minute');
  assert.equal(status(send('/api/bot-webhooks', 'POST', { name: 'x', agent_id: 'a1', secret: 'mine' })), 422);
  assert.equal(status(send('/api/bot-webhooks', 'POST', { name: 'x', agent_id: 'a1', max_pending: 51 })), 422);
  assert.equal(status(send('/api/bot-webhooks', 'POST', { name: 'x', agent_id: 'nope' })), 400);
  const big = post(send, make(send, { name: 'Big' }), { x: 'a'.repeat(300 * 1024) });
  assert.equal(status(big), 413);
})();

(() => {
  // Capture starts nothing; test starts nothing; attempts are redacted, bounded and latest first.
  const { state, get, send } = fresh();
  const hook = make(send);
  assert.equal(send(`/api/bot-webhooks/${hook.id}/capture`, 'POST', {}).capturing, true);
  assert.equal(get(`/api/bot-webhooks/${hook.id}/sample`).capturing, true);
  assert.equal(post(send, hook, { type: 'order.paid', note: 'hello' }).status, 'captured');
  assert.equal(state.botsEvents.pending[hook.id] || 0, 0, 'capture starts nothing');
  const sample = get(`/api/bot-webhooks/${hook.id}/sample`);
  assert.equal(sample.capturing, false);
  assert.deepEqual(JSON.parse(sample.sample.body), { type: 'order.paid', note: 'hello' });
  assert.equal(status(send(make(send, { name: 'Other' }) && `/api/bot-webhooks/${hook.id}/test`, 'POST', {})), 200, 'tests with the sample');
  const test = send(`/api/bot-webhooks/${hook.id}/test`, 'POST', { payload: { a: 1 }, event_type: 'x' });
  assert.equal(test.passes_filters, true);
  assert.match(test.note, /Nothing was started/);
  assert.equal(state.botsEvents.pending[hook.id] || 0, 0, 'a test starts nothing');
  const bare = make(send, { name: 'Bare' });
  assert.equal(status(send(`/api/bot-webhooks/${bare.id}/test`, 'POST', {})), 409, 'no sample and no payload');
  send(`/api/bot-webhooks/in/${hook.id}/${secretOf(hook)}x`, 'POST', {});
  post(send, hook, {}, { 'x-kairos-delivery': `token=${secretOf(hook)}` });
  const attempts = get(`/api/bot-webhooks/${hook.id}/attempts`);
  const dumped = JSON.stringify(attempts);
  assert.equal(dumped.includes(secretOf(hook)), false, 'no credential in the history');
  assert.equal(dumped.includes('/api/bot-webhooks/in/'), false, 'no address in the history');
  assert.equal(attempts.attempts[0].outcome, 'waiting', 'latest first');
  for (let i = 0; i < 2100; i++) state.botsEvents.attempts[hook.id].unshift({ at: i, outcome: 'waiting', detail: `n${i}` });
  state.botsEvents.attempts[hook.id].length = 2000;
  const listed = get(`/api/bot-webhooks/${hook.id}/attempts`);
  assert.equal(listed.attempts.length, 30, 'the latest 30 are shown');
  assert.equal(listed.total, 2000, 'two thousand are kept');
  assert.equal(factory.redact('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'), false);
})();

(() => {
  // Delete, restore, rotate.
  const { get, send } = fresh();
  const hook = make(send);
  const old = hook.address;
  assert.equal(send(`/api/bot-webhooks/${hook.id}`, 'DELETE').restorable_days, 7);
  assert.equal(status(post(send, hook, {})), 404, 'a deleted webhook is gone');
  assert.deepEqual(get('/api/bot-webhooks').deleted.map(d => d.id), [hook.id]);
  const back = send(`/api/bot-webhooks/${hook.id}/restore`, 'POST', {});
  assert.equal(back.enabled, false, 'restored paused');
  assert.equal(get(`/api/bot-webhooks/${hook.id}/address`).address, old, 'the old address is back');
  assert.equal(status(send(`/api/bot-webhooks/${hook.id}/restore`, 'POST', {})), 409);
  send(`/api/bot-webhooks/${hook.id}`, 'PATCH', { enabled: true });
  const rotated = send(`/api/bot-webhooks/${hook.id}/rotate`, 'POST', {});
  assert.notEqual(rotated.address, old);
  assert.equal(status(send(old, 'POST', {})), 403, 'the old credential stops at once');
  assert.equal(status(send(rotated.address, 'POST', {}, { 'x-kairos-delivery': 'n1' })), 202);
  for (let i = 0; i < 55; i++) { const h = make(send, { name: `w${i}` }); send(`/api/bot-webhooks/${h.id}`, 'DELETE'); }
  assert.equal(get('/api/bot-webhooks').deleted.length, 50, 'at most fifty deleted are kept');
  assert.equal(status(send('/api/bot-webhooks/nope', 'PATCH', { enabled: false })), 404);
})();

console.log('PASS: Bots events contract (capabilities, filters, limits, capture, attempts, restore, route ownership).');
