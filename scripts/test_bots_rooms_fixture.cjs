// The rooms fixture backend (scripts/fixtures/bots-rooms-backend.cjs) honours the contract in
// phase-4-design.md sections 3.4, 4.2 and 5: the same keys and the same status codes as routes/bot_room_routes.py.
// Run: node scripts/test_bots_rooms_fixture.cjs
const assert = require('node:assert/strict');
const factory = require('./fixtures/bots-rooms-backend.cjs');

const BOTS = [{ id: 'a1', name: 'Ada' }, { id: 'b2', name: 'Bo' }, { id: 'c3', name: 'Cy' }, { id: 'h9', name: 'Ghost', hidden: true }];
const fresh = (extra = {}) => {
  const state = { botsLive: true, botsCore: { agents: BOTS.map(b => ({ ...b })) }, botsRooms: {}, ...extra };
  const backend = factory({ state, now: 1_800_000_000 });
  return { state, backend, get: (route, query) => backend.read(route, query), send: (route, method, body) => backend.mutate(route, method, body) };
};
const status = answer => answer?._status ?? 200;
let n = 0;
const sid = () => `send-${String(++n).padStart(6, '0')}`;
const room = (t, extra = {}) => t.send('/api/bot-rooms', 'POST', { name: 'Plan', bot_ids: ['a1', 'b2'], setup_done: true, ...extra });
const say = (t, r, text, extra = {}) => t.send(`/api/bot-rooms/${r.id}/messages`, 'POST', { text, send_id: sid(), ...extra });
const texts = (t, r, role) => t.get(`/api/bot-rooms/${r.id}/messages`).messages.filter(m => !role || m.role === role).map(m => m.text);

(() => {
  // Only while a check has seeded state.botsRooms; otherwise every route is left to the demo.
  const off = fresh({ botsRooms: undefined });
  assert.equal(off.get('/api/bot-rooms'), undefined);
  assert.equal(off.send('/api/bot-rooms', 'POST', { name: 'x', bot_ids: ['a1'] }), undefined);
  const live = fresh({ botsLive: false });
  assert.equal(live.get('/api/bot-rooms'), undefined, 'a fixture is silent unless botsLive is set');
  assert.equal(fresh().get('/api/agents'), undefined, 'other namespaces are not answered');
})();

(() => {
  // Create, read, patch, delete: the keys and the refusals of the service.
  const t = fresh();
  const r = room(t, { context: 'Q4' });
  assert.deepEqual(r.members.map(m => m.name), ['Ada', 'Bo']);
  assert.equal(r.setup_state, 'done'); assert.equal(r.turn_timeout_minutes, 5); assert.equal(r.threads.length, 1);
  assert.deepEqual(r.default_responder, { kind: 'mentions' });
  assert.equal(t.send('/api/bot-rooms', 'POST', { name: 'New', bot_ids: ['a1'] }).setup_state, 'pending');
  for (const body of [{ name: '', bot_ids: ['a1'] }, { name: 'x'.repeat(101), bot_ids: ['a1'] }, { name: 'x', bot_ids: [] }, { name: 'x', bot_ids: ['zz'] },
    { name: 'x', bot_ids: ['h9'] }, { name: 'x', bot_ids: ['a1'], context: 'c'.repeat(61) }, { name: 'x', bot_ids: ['a1'], description: 'd'.repeat(121) },
    { name: 'x', bot_ids: ['a1'], turn_timeout_minutes: 0 }, { name: 'x', bot_ids: ['a1'], turn_timeout_minutes: 1441 }, { name: 'x', bot_ids: ['a1'], owner: 'me' },
    { name: 'x', bot_ids: ['a1'], default_responder: { kind: 'member', bot_id: 'b2' } }, { name: 'x', bot_ids: ['a1'], default_responder: { kind: 'loud' } }])
    assert.equal(status(t.send('/api/bot-rooms', 'POST', body)), 422, JSON.stringify(body));
  assert.equal(status(t.get('/api/bot-rooms/nope')), 404);
  const patched = t.send(`/api/bot-rooms/${r.id}`, 'PATCH', { name: 'Roadmap', default_responder: { kind: 'member', bot_id: 'b2' }, expected_revision: r.revision });
  assert.deepEqual([patched.name, patched.revision], ['Roadmap', r.revision + 1]);
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}`, 'PATCH', { name: 'x', expected_revision: r.revision })), 409);
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}`, 'PATCH', { seat_session_id: 'x' })), 422);
  const left = t.send(`/api/bot-rooms/${r.id}`, 'PATCH', { member_ids: ['a1'] });
  assert.deepEqual(left.default_responder, { kind: 'mentions' }, 'the lead left, so the default fell back');
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}`, 'PATCH', { member_ids: [] })), 422);
  assert.equal(t.send(`/api/bot-rooms/${r.id}`, 'DELETE').deleted, true);
  assert.equal(status(t.get(`/api/bot-rooms/${r.id}`)), 404);
})();

(() => {
  // Sending: 404, 409 while setup is pending, one message per send id, paging and the unread count.
  const t = fresh();
  const pending = t.send('/api/bot-rooms', 'POST', { name: 'New', bot_ids: ['a1'] });
  assert.equal(status(say(t, pending, 'hi')), 409);
  assert.equal(t.send(`/api/bot-rooms/${pending.id}/setup`, 'POST', { action: 'complete', bulletin: 'Be kind' }).setup_state, 'done');
  assert.equal(status(t.send(`/api/bot-rooms/${pending.id}/setup`, 'POST', { action: 'explode' })), 422);
  const r = room(t, { default_responder: { kind: 'member', bot_id: 'a1' } });
  assert.equal(status(t.send('/api/bot-rooms/nope/messages', 'POST', { text: 'x', send_id: sid() })), 404);
  assert.equal(status(say(t, r, 'x', { thread_id: 'nope' })), 404);
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}/messages`, 'POST', { text: 'x', send_id: 'short' })), 422);
  const first = t.send(`/api/bot-rooms/${r.id}/messages`, 'POST', { text: 'hello', send_id: 'send-fixed-1' });
  assert.equal(status(first), 202);
  const again = t.send(`/api/bot-rooms/${r.id}/messages`, 'POST', { text: 'hello', send_id: 'send-fixed-1' });
  assert.equal(again.replayed, true); assert.equal(again.message.id, first.message.id);
  assert.deepEqual(texts(t, r), ['hello', 'Ada: noted.']);
  assert.equal(t.get(`/api/bot-rooms/${r.id}`).unread, 1);
  assert.equal(t.send(`/api/bot-rooms/${r.id}/read`, 'POST', {}).unread, 0);
  for (let i = 0; i < 60; i++) say(t, r, `line ${i} @Bo`);
  const pageOne = t.get(`/api/bot-rooms/${r.id}/messages`, { limit: '10' });
  assert.equal(pageOne.messages.length, 10); assert.equal(pageOne.has_more, true);
  assert.equal(t.get(`/api/bot-rooms/${r.id}/messages`, { limit: '9999' }).messages.length, 200 >= 122 ? 122 : 200, 'capped at the page maximum');
  const older = t.get(`/api/bot-rooms/${r.id}/messages`, { limit: '10', before: String(pageOne.messages[0].seq) });
  assert.ok(older.messages.at(-1).seq < pageOne.messages[0].seq);
  assert.equal(status(t.get(`/api/bot-rooms/${r.id}/messages`, { around: 'nope' })), 404);
})();

(() => {
  // Responder modes.
  const t = fresh();
  const everyone = room(t, { default_responder: { kind: 'everyone' } });
  say(t, everyone, 'all of you');
  assert.deepEqual(texts(t, everyone, 'bot'), ['Ada: noted.', 'Bo: noted.']);
  const mentions = room(t, { default_responder: { kind: 'mentions' } });
  say(t, mentions, '@Bo what do you think');
  say(t, mentions, 'nobody addressed');
  assert.deepEqual(texts(t, mentions, 'bot'), ['Bo: noted.']);
  assert.match(texts(t, mentions, 'system').at(-1), /Mention a bot with @/);
  const auto = room(t, { default_responder: { kind: 'auto', fallback_bot_id: 'a1' } });
  t.state.botsRooms.autoPick = 'b2';
  say(t, auto, 'who handles this');
  const picked = t.get(`/api/bot-rooms/${auto.id}/messages`).messages.find(m => m.role === 'bot');
  assert.deepEqual([picked.bot_id, picked.meta.auto.p], ['b2', 0.9]);
  t.state.botsRooms.autoPick = null;
  say(t, auto, 'and now');
  assert.equal(t.get(`/api/bot-rooms/${auto.id}/messages`).messages.filter(m => m.role === 'bot').at(-1).bot_id, 'a1');
  const at = room(t, { default_responder: { kind: 'member', bot_id: 'b2' } });
  say(t, at, '@everyone report');
  assert.equal(texts(t, at, 'bot').length, 2);
})();

(() => {
  // Holds by text, queueing while working, Stop, and the queue routes.
  const t = fresh();
  const r = room(t, { default_responder: { kind: 'everyone' } });
  const held = say(t, r, '@Ada stop');
  assert.deepEqual(held.held, ['a1']);
  say(t, r, 'status?');
  assert.deepEqual(texts(t, r, 'bot'), ['Bo: noted.'], 'a held bot does not answer');
  assert.equal(t.get(`/api/bot-rooms/${r.id}`).members[0].held, true);
  assert.deepEqual(say(t, r, '@Ada resume').released, ['a1']);
  assert.equal(t.get(`/api/bot-rooms/${r.id}`).members[0].held, false);
  assert.deepEqual(say(t, r, '> @Bo stop\nquoted only').held, [], 'quoted lines hold nobody');
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}/holds`, 'POST', { bot_id: 'zz', held: true })), 404);
  assert.equal(t.send(`/api/bot-rooms/${r.id}/holds`, 'POST', { bot_id: 'b2', held: true }).changed, true);
  t.send(`/api/bot-rooms/${r.id}/holds`, 'POST', { bot_id: 'b2', held: false });

  const w = room(t, { default_responder: { kind: 'member', bot_id: 'a1' } });
  const slow = say(t, w, 'long job [slow]');
  assert.equal(slow.queued, false);
  assert.equal(t.get(`/api/bot-rooms/${w.id}`).working, true);
  const waiting = say(t, w, 'queued one');
  assert.equal(waiting.queued, true);
  const queue = t.get(`/api/bot-rooms/${w.id}/queue`).items;
  assert.deepEqual(queue.map(q => q.position), [1]);
  assert.equal(status(t.send(`/api/bot-rooms/${w.id}`, 'PATCH', { member_ids: ['a1'] })), 409, 'members cannot change while it works');
  assert.equal(status(t.send(`/api/bot-rooms/${w.id}`, 'DELETE')), 409);
  assert.equal(t.send(`/api/bot-rooms/${w.id}/queue/${queue[0].id}`, 'DELETE').cancelled, true);
  assert.equal(status(t.send(`/api/bot-rooms/${w.id}/queue/${queue[0].id}`, 'DELETE')), 409);
  assert.equal(status(t.send(`/api/bot-rooms/${w.id}/queue/nope`, 'DELETE')), 404);
  say(t, w, 'second queued');
  assert.deepEqual(t.send(`/api/bot-rooms/${w.id}/stop`, 'POST', {}).stopped, ['a1']);
  assert.equal(t.get(`/api/bot-rooms/${w.id}`).working, false);
  assert.equal(t.get(`/api/bot-rooms/${w.id}/queue`).items.length, 0, 'Stop all clears the queue');
  assert.equal(texts(t, w, 'bot').length, 0, 'the stopped turn said nothing');
  const retry = t.get(`/api/bot-rooms/${w.id}/messages`).messages.filter(m => m.role === 'system').at(-1);
  assert.deepEqual([retry.meta.outcome, retry.meta.retry], ['cancelled', true]);
  assert.equal(status(t.send(`/api/bot-rooms/${w.id}/stop`, 'POST', { bot_id: 'zz' })), 404);
  say(t, w, 'another [slow]');
  say(t, w, 'queued behind');
  t.send(`/api/bot-rooms/${w.id}/_release`, 'POST', {});
  assert.equal(texts(t, w, 'bot').length, 2, 'released work finishes, then the queue runs');
  const typed = say(t, w, 'again [slow]');
  assert.equal(say(t, w, 'stop').stopped.length, 1, 'a typed stop word is a person Stop');
})();

(() => {
  // Goals: one live goal per thread; Stop ends it; threads keep one.
  const t = fresh();
  const r = room(t, { default_responder: { kind: 'member', bot_id: 'a1' } });
  const goal = say(t, r, 'finish the report', { mode: 'goal' });
  assert.equal(status(goal), 202);
  const thread = r.threads[0].id;
  assert.equal(t.get(`/api/bot-rooms/${r.id}/threads/${thread}/goal`).goal.status, 'working');
  assert.equal(status(say(t, r, 'a second goal', { mode: 'goal' })), 409);
  assert.equal(t.send(`/api/bot-rooms/${r.id}/stop`, 'POST', {}).stopped.length, 1);
  assert.equal(t.get(`/api/bot-rooms/${r.id}/threads/${thread}/goal`).goal.status, 'stopped');
  const second = t.send(`/api/bot-rooms/${r.id}/threads`, 'POST', { title: 'Side' });
  assert.deepEqual(t.get(`/api/bot-rooms/${r.id}/threads`).threads.map(x => x.title), ['', 'Side']);
  assert.equal(t.send(`/api/bot-rooms/${r.id}/threads/${second.id}`, 'PATCH', { title: 'Renamed' }).title, 'Renamed');
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}/threads/nope`, 'PATCH', { title: 'x' })), 404);
  assert.equal(t.send(`/api/bot-rooms/${r.id}/threads/delete`, 'POST', { thread_ids: [thread, second.id] }).deleted.length, 1, 'one thread stays');
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}/threads/delete`, 'POST', { thread_ids: [] })), 422);
  assert.equal(status(t.send(`/api/bot-rooms/${r.id}/threads/delete`, 'POST', { thread_ids: Array.from({ length: 501 }, (_, i) => String(i)) })), 422);
})();

(() => {
  // Frames replay from a cursor, and say when they cannot.
  const t = fresh();
  const r = room(t, { default_responder: { kind: 'member', bot_id: 'a1' } });
  const before = t.get('/api/bot-rooms/_frames', { after: '0' });
  assert.equal(before.reset, false); assert.ok(before.frames.some(f => f.type === 'room'));
  say(t, r, 'hello');
  const later = t.get('/api/bot-rooms/_frames', { after: String(before.cursor) });
  assert.deepEqual(later.frames.map(f => f.type), ['room.message', 'room.queue', 'room.message']);
  assert.equal(t.get('/api/bot-rooms/_frames', { after: '9999' }).reset, true, 'a cursor from before a restart cannot be replayed');
  for (let i = 0; i < 520; i++) say(t, r, `m${i}`);
  assert.ok(t.state.botsRooms.frames.length <= 500, 'the buffer is bounded');
  assert.equal(t.get('/api/bot-rooms/_frames', { after: '1' }).reset, true, 'a cursor older than the buffer must reload');
})();

console.log('PASS bots rooms fixture: statuses, keys, responder modes, holds, queue, goals and frame replay.');
