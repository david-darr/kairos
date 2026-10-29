// The runtime fixture holds to the same acceptance, queue, Stop, steer and branch cases as the Python suites
// (test_bots_chat_runtime.py, test_bots_message_tree.py, test_bots_goal_runs.py). Run: node scripts/test_bots_runtime_fixtures.cjs
const assert = require('node:assert/strict');
const factory = require('./fixtures/bots-runtime-backend.cjs');

const world = () => {
  const state = { botsLive: true };
  const backend = factory({ state, now: 1000 });
  const call = (method, route, body = {}, query = {}) => (method === 'GET' ? backend.read(route, query) : backend.mutate(route, method, body, query));
  const control = state.botsRuntimeControl;
  const url = (sid, tail = '') => `/api/bot-chat/${sid}${tail}`;
  let n = 0;
  const send = (sid, text, extra = {}) => {
    const leaf = call('GET', url(sid, '/state')).active_leaf_id;
    return call('POST', url(sid, '/send'), { send_id: `send-${++n}-${Math.random().toString(36).slice(2)}`, text, expected_leaf_id: leaf, ...extra });
  };
  return { state, backend, call, control, url, send };
};
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('a send is accepted once and a retry returns the first result', () => {
  const w = world(), sid = w.control.seed('b1');
  const first = w.call('POST', w.url(sid, '/send'), { send_id: 'send-id-one', text: 'once', expected_leaf_id: null });
  assert.equal(first.queued, false);
  const again = w.call('POST', w.url(sid, '/send'), { send_id: 'send-id-one', text: 'once', expected_leaf_id: null });
  assert.equal(again.replayed, true);
  assert.equal(again.turn_id, first.turn_id);
  assert.equal(w.control.tree(sid).length, 1);
  const different = w.call('POST', w.url(sid, '/send'), { send_id: 'send-id-one', text: 'else', expected_leaf_id: null });
  assert.equal(different._status, 409);
});

test('a stale leaf is refused and saves nothing', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'one'); w.control.finish(sid, 'a');
  const stale = w.call('POST', w.url(sid, '/send'), { send_id: 'stale-send-1', text: 'two', expected_leaf_id: 'nope' });
  assert.equal(stale._status, 409);
  assert.equal(w.control.tree(sid).length, 2);
});

test('a busy thread queues, drains in order and merges compatible messages', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'first');
  const a = w.send(sid, 'second'), b = w.send(sid, 'third');
  assert.deepEqual([a.reason, b.reason], ['busy', 'busy']);
  assert.equal(w.call('GET', w.url(sid, '/queue')).items.length, 2);
  w.control.finish(sid, 'one');
  const users = w.control.tree(sid).filter(m => m.role === 'user').map(m => m.content);
  assert.equal(users[1], 'second\n\nthird');
  assert.equal(w.call('GET', w.url(sid, '/queue')).items.length, 0);
});

test('messages far apart or spoken do not coalesce', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'run'); w.send(sid, 'early'); w.control.skew(300); w.send(sid, 'late');
  w.control.finish(sid, 'x'); w.control.finish(sid, 'y'); w.control.finish(sid, 'z');
  assert.deepEqual(w.control.tree(sid).filter(m => m.role === 'user').map(m => m.content), ['run', 'early', 'late']);
});

test('thread slots: overflow queues with capacity and runs when a slot frees', () => {
  const w = world(), a = w.control.seed('bot', 2), b = w.control.thread('bot'), c = w.control.thread('bot');
  assert.equal(w.send(a, 'a').queued, false);
  assert.equal(w.send(b, 'b').queued, false);
  const third = w.send(c, 'c');
  assert.deepEqual([third.queued, third.reason], [true, 'capacity']);
  w.control.finish(a, 'done');
  assert.equal(w.call('GET', w.url(c, '/state')).turn.status, 'running');
});

test('queue edit returns the draft, delete leaves a tombstone, a second delete conflicts', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'run');
  const a = w.send(sid, 'keep'), b = w.send(sid, 'drop');
  const taken = w.call('POST', w.url(sid, `/queue/${a.queue_id}/edit`));
  assert.equal(taken.draft.text, 'keep');
  const gone = w.call('DELETE', w.url(sid, `/queue/${b.queue_id}`));
  assert.deepEqual(new Set(gone.consumed_queue_ids), new Set([a.queue_id, b.queue_id]));
  assert.equal(w.call('DELETE', w.url(sid, `/queue/${b.queue_id}`))._status, 409);
});

test('Stop names its turn: a stale one is a no-op, the right one keeps the queue and pauses it', () => {
  const w = world(), sid = w.control.seed('b1');
  const one = w.send(sid, 'one'); w.control.finish(sid, 'done one');
  const two = w.send(sid, 'two');
  assert.equal(w.call('POST', w.url(sid, '/interrupt'), { turn_id: one.turn_id }).outcome, 'already-stopped');
  assert.equal(w.call('GET', w.url(sid, '/state')).turn.status, 'running');
  const queued = w.send(sid, 'next');
  assert.equal(w.call('POST', w.url(sid, '/interrupt'), { turn_id: two.turn_id }).outcome, 'stopping');
  const rows = w.control.tree(sid);
  assert.equal(rows.filter(m => m.kind === 'stopped').length, 1);
  const queue = w.call('GET', w.url(sid, '/queue'));
  assert.equal(queue.paused, true);
  assert.deepEqual(queue.items.map(i => i.id), [queued.queue_id]);
  assert.equal(w.call('POST', w.url(sid, '/interrupt'), { turn_id: two.turn_id }).outcome, 'already-stopped');
  const resumed = w.call('POST', w.url(sid, '/queue/resume'));
  assert.equal(resumed.paused, false);
  assert.equal(w.call('GET', w.url(sid, '/state')).turn.status, 'running');
});

test('steer interrupts quietly, takes exactly the head group, refuses stale revisions and turns', () => {
  const w = world(), sid = w.control.seed('b1');
  const first = w.send(sid, 'work');
  const a = w.send(sid, 'one'), b = w.send(sid, 'two'), c = w.send(sid, 'three');
  const revision = w.call('GET', w.url(sid, '/queue')).revision;
  assert.equal(w.call('POST', w.url(sid, `/queue/${a.queue_id}/steer`), { turn_id: first.turn_id, queue_revision: revision - 1 })._status, 409);
  assert.equal(w.call('POST', w.url(sid, `/queue/${a.queue_id}/steer`), { turn_id: 'other', queue_revision: revision }).blocked, 'turn-changed');
  assert.equal(w.call('POST', w.url(sid, `/queue/${b.queue_id}/steer`), { turn_id: first.turn_id, queue_revision: revision }).blocked, 'not-first');
  const done = w.call('POST', w.url(sid, `/queue/${a.queue_id}/steer`), { turn_id: first.turn_id, queue_revision: revision, group_ids: [a.queue_id, b.queue_id] });
  assert.deepEqual(done.consumed_ids, [a.queue_id, b.queue_id]);
  const rows = w.control.tree(sid);
  assert.equal(rows.filter(m => m.kind === 'stopped').length, 0);
  assert.equal(rows.filter(m => m.role === 'user').at(-1).content, 'one\n\ntwo');
  assert.deepEqual(w.call('GET', w.url(sid, '/queue')).items.map(i => i.id), [c.queue_id]);
});

test('edit adds a sibling and keeps the old version; choosing a version restores it', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'q1'); w.control.finish(sid, 'a1'); w.send(sid, 'q2'); w.control.finish(sid, 'a2');
  const page = w.call('GET', w.url(sid, '/messages'));
  const target = page.messages[2];
  const edited = w.call('POST', w.url(sid, `/messages/${target.bot_message_id}/edit`),
    { send_id: 'edit-send-001', text: 'q2 again', expected_leaf_id: page.active_leaf_id, expected_revision: page.branch_revision });
  assert.equal(edited.queued, false);
  w.control.finish(sid, 'a2b');
  assert.equal(w.control.tree(sid).length, 6, 'nothing deleted');
  const replayed = w.call('POST', w.url(sid, `/messages/${target.bot_message_id}/edit`),
    { send_id: 'edit-send-001', text: 'q2 again', expected_leaf_id: page.active_leaf_id, expected_revision: page.branch_revision });
  assert.equal(replayed.replayed, true);
  const now = w.call('GET', w.url(sid, '/messages'));
  const switcher = now.messages.find(m => m.version);
  assert.equal(switcher.version.count, 2);
  const around = w.call('GET', w.url(sid, '/messages'), {}, { around: target.bot_message_id });
  assert.equal(around._status, 409);
  const back = w.call('POST', w.url(sid, '/active-branch'), { message_id: target.bot_message_id, expected_revision: now.branch_revision });
  assert.equal(back.messages.at(-1).content, 'a2');
  assert.equal(w.call('POST', w.url(sid, '/active-branch'), { message_id: target.bot_message_id, expected_revision: 0 })._status, 409);
});

test('regenerate adds an alternative answer under the same question', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'q'); w.control.finish(sid, 'first');
  const page = w.call('GET', w.url(sid, '/messages'));
  const result = w.call('POST', w.url(sid, '/regenerate'), { send_id: 'regen-send-01', expected_leaf_id: page.active_leaf_id, expected_revision: page.branch_revision });
  assert.equal(result.queued, false);
  w.control.finish(sid, 'second');
  const rows = w.control.tree(sid);
  assert.equal(rows.filter(m => m.role === 'user').length, 1);
  assert.equal(rows.filter(m => m.role === 'assistant').length, 2);
  assert.equal(w.call('GET', w.url(sid, '/messages')).messages.at(-1).version.count, 2);
});

test('a busy thread refuses an edit with 409 and nothing changes', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'q'); w.control.finish(sid, 'a'); w.send(sid, 'working');
  const page = w.call('GET', w.url(sid, '/messages'));
  const refused = w.call('POST', w.url(sid, `/messages/${page.messages[0].bot_message_id}/edit`),
    { send_id: 'edit-busy-001', text: 'x', expected_leaf_id: page.active_leaf_id, expected_revision: page.branch_revision });
  assert.equal(refused._status, 409);
});

test('reactions are one per person, pins and the read cursor behave', () => {
  const w = world(), sid = w.control.seed('b1');
  w.send(sid, 'q'); w.control.finish(sid, 'a');
  const target = w.call('GET', w.url(sid, '/messages')).messages[1].bot_message_id;
  assert.deepEqual(w.call('POST', w.url(sid, `/messages/${target}/reaction`), { emoji: 'heart', on: true }).reactions, [{ emoji: 'heart', count: 1, mine: true }]);
  const changed = w.call('POST', w.url(sid, `/messages/${target}/reaction`), { emoji: 'tada', on: true });
  assert.deepEqual(changed.reactions, [{ emoji: 'tada', count: 1, mine: true }]);
  assert.equal(w.call('POST', w.url(sid, `/messages/${target}/reaction`), { emoji: 'skull', on: true })._status, 422);
  assert.equal(w.call('PATCH', w.url(sid, '/pin'), { message_id: target }).pinned_message_id, target);
  assert.equal(w.call('PATCH', w.url(sid, '/pin'), { message_id: 'missing' })._status, 404);
  const first = w.call('GET', w.url(sid, '/messages')).messages[0].bot_message_id;
  assert.equal(w.call('POST', w.url(sid, '/read'), { message_id: null }).unread, false);
  assert.equal(w.call('POST', w.url(sid, '/read'), { message_id: first }).last_read_message_id, target, 'never backward');
});

test('foreign and unknown targets are 404; bodies are validated', () => {
  const w = world(), sid = w.control.seed('b1');
  assert.equal(w.call('GET', w.url('nope', '/state'))._status, 404);
  assert.equal(w.call('POST', w.url(sid, '/send'), { send_id: 'abc', text: 'x', expected_leaf_id: null })._status, 422);
  assert.equal(w.call('POST', w.url(sid, '/send'), { send_id: 'valid-send-1', text: '  ', expected_leaf_id: null })._status, 422);
  assert.equal(w.call('GET', w.url('search', ''), {}, { q: 'zzz' }).hits.length, 0);
});

test('a solo goal stops by its root and a stale root does nothing', () => {
  const w = world(), sid = w.control.seed('b1');
  const sent = w.send(sid, 'finish the report', { mode: 'goal' });
  const goal = w.call('GET', w.url(sid, '/state')).goal;
  assert.equal(goal.status, 'working');
  assert.equal(w.call('POST', w.url(sid, '/goal/stop'), { root_id: 'old' }).outcome, 'already-stopped');
  assert.equal(w.call('GET', w.url(sid, '/state')).turn.status, 'running');
  assert.equal(w.call('POST', w.url(sid, '/goal/stop'), { root_id: goal.root_id }).outcome, 'stopping');
  assert.equal(w.call('GET', w.url(sid, '/state')).goal.status, 'stopped');
  assert.equal(w.control.tree(sid).filter(m => m.kind === 'stopped').length, 1);
  assert.ok(sent.turn_id);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + '\n' + error.stack); }
}
if (failed) { console.log(`${failed} of ${cases.length} failed`); process.exit(1); }
console.log(`PASS: ${cases.length} runtime fixture cases.`);
