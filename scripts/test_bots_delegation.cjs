// Bots Phase 4 U1: the DOM-free delegation model (chip states and labels, reach values, edges) and the
// fixture lane's reach rules. Run: node scripts/test_bots_delegation.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const model = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsDelegationModel.js')).href);

  // Chip states, verbs, failure tone and where a click goes.
  const queued = model.handoffModel({ mode: 'work', status: 'queued', partner: { id: 'b2', name: 'Reader' }, work_session_id: 's9' });
  assert.deepEqual([queued.label, queued.verb, queued.failed], ['Queued', 'Delegated', false]);
  assert.deepEqual(queued.target, { tab: 'botsShell', agentId: 'b2', sessionId: 's9' });
  assert.equal(model.handoffModel({ status: 'running' }).label, 'Working');
  assert.equal(model.handoffModel({ status: 'needs_input', mode: 'consult' }).verb, 'Asked');
  assert.equal(model.handoffModel({ status: 'needs_input' }).label, 'Waiting for you');
  assert.equal(model.handoffModel({ mode: 'notify' }).verb, 'Notified');
  for (const state of ['failed', 'cancelled']) assert.equal(model.handoffModel({ status: state }).failed, true, state);
  assert.equal(model.handoffModel({ status: 'completed', result: 'All good' }).preview, 'All good');
  assert.deepEqual(model.handoffModel({ room_id: 'r1', thread_id: 't1' }).target, { tab: 'botsRoom', roomId: 'r1', threadId: 't1' });
  assert.equal(model.handoffModel({ status: 'mystery' }).label, 'Queued', 'an unknown status reads as queued, never blank');

  // Reach values: all is null, none is empty, listed drops duplicates.
  assert.equal(model.reachValue('all'), null);
  assert.deepEqual(model.reachValue('none', ['a']), []);
  assert.deepEqual(model.reachValue('listed', ['a', 'a', 'b']), ['a', 'b']);
  // Widening needs the acknowledgement; narrowing and staying put do not.
  assert.equal(model.widensReach(['a'], null), true);
  assert.equal(model.widensReach(['a'], ['a', 'b']), true);
  assert.equal(model.widensReach([], ['a']), true);
  assert.equal(model.widensReach(['a', 'b'], ['a']), false);
  assert.equal(model.widensReach(null, []), false, 'from all, anything is narrower');
  assert.equal(model.widensReach(null, null), false);

  // Edges and repeat rows.
  assert.equal(model.edgeLabel({ source: 'b1', target: 'b2', status: 'running', reason: 'Check sources' }, { b1: 'Lead', b2: 'Reader' }),
    'Lead to Reader: Working, Check sources');
  assert.equal(model.edgeLabel({ target: 'b2', status: 'done' }), 'You to b2: Done');
  assert.equal(model.repeatLabel({ count: 10 }), 'Same call repeated 10 times, it may be stuck');

  // Fixture lane: answers only seeded bots, widening needs the flag, stale revision is 409.
  const state = { botsLive: true, botsDelegation: { reach: { b1: { mode: 'listed', peers: ['b2'], revision: 1 } }, assignments: [
    { id: 'x', assignee_bot_id: 'b2', requester: { bot_id: 'b1' }, status: 'running' }] } };
  const lane = require('./fixtures/bots-delegation-backend.cjs')({ state });
  assert.equal(lane.read('/api/bot-peers/zz/reach'), undefined, 'an unseeded bot falls through');
  assert.equal(lane.read('/api/bot-peers/b1/reach').mode, 'listed');
  assert.equal(lane.mutate('/api/bot-peers/b1/reach', 'PUT', { mode: 'all', expected_revision: 1 })._status, 400);
  assert.equal(lane.mutate('/api/bot-peers/b1/reach', 'PUT', { mode: 'none', expected_revision: 0 })._status, 409);
  assert.equal(lane.mutate('/api/bot-peers/b1/reach', 'PUT', { mode: 'all', acknowledge_scope: true, expected_revision: 1 }).mode, 'all');
  assert.equal(lane.read('/api/bot-assignments', { bot_id: 'b1' }).length, 1);
  assert.equal(lane.read('/api/bot-assignments', { status: 'completed' }).length, 0);
  state.botsLive = false;
  assert.equal(lane.read('/api/bot-peers/b1/reach'), undefined, 'silent outside Bots');

  console.log('PASS: bots delegation model and fixture lane');
})().catch(error => { console.error(error); process.exit(1); });
