// Bots rooms, end to end through the renderer's own network layer (Agents 3.0 Phase 4, unit U2). Run by ui-smoke behind
// --bots-rooms-only:
//   node scripts/run-electron-test.cjs ui-smoke --bots-rooms-only
//
// Covers, against scripts/fixtures/bots-rooms-backend.cjs: two bots and rooms created through the API; a conversation in every
// responder mode (everyone, mentions, one bot, auto); holding and releasing a bot by typing; a message queued while the room works
// and cleared by Stop all; a goal run, a second goal refused, and Stop ending it; threads that always keep one; and a reload
// in the middle of a turn that picks the missed frames back up from the stored cursor (and reloads from scratch when the cursor
// is older than anything held).
// When the room screen module from unit U3 is present it is also loaded and its contract exports are checked; this check does not
// depend on that screen's markup, so it passes alone, repeated, and in any order.
//
// It creates its own bots and rooms with unique names, never assumes which other bots exist, and removes everything it made and
// restores demoState.botsRooms and every page preference in `finally`.
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, delay, demoState, base, win }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  const ok = async (path, method, body, expected = 200) => {
    const answer = await call(path, method, body);
    assert.equal(answer.status, expected, `${method} ${path} -> ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  let counter = 0;
  const unique = Date.now() % 1000000;
  const sendId = () => `rooms-check-${unique}-${String(++counter).padStart(4, '0')}`;
  const say = (roomId, text, extra = {}) => call(`/api/bot-rooms/${roomId}/messages`, 'POST', { text, send_id: sendId(), ...extra });
  const messages = async (roomId, query = '') => (await ok(`/api/bot-rooms/${roomId}/messages${query}`, 'GET')).messages;
  const botTexts = async roomId => (await messages(roomId)).filter(m => m.role === 'bot').map(m => m.text);
  const systemTexts = async roomId => (await messages(roomId)).filter(m => m.role === 'system').map(m => m.text);
  const frames = after => ok(`/api/bot-rooms/_frames?after=${after}`, 'GET');

  // The dashboard polls the attention feed on every load; an empty one keeps those routes answered without
  // this check depending on another check's rows.
  const restore = await isolateBotsCheck({ js, demoState }, {
    botsAttention: { items: [], feed: [], events: {}, runs: {}, prefs: {}, failNext: null, responses: [] },
  });
  const botIds = [], roomIds = [];
  const previousRooms = demoState.botsRooms;
  try {
    demoState.botsLive = true;
    demoState.botsRooms = {};  // this check's own rooms store; the fixture answers nothing without it
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");

    // Two bots of its own.
    const names = [`Room Ada ${unique}`, `Room Bo ${unique}`];
    for (const name of names) {
      const made = await ok('/api/agents', 'POST', { name });
      botIds.push(made.id);
    }
    const [ada, bo] = botIds;
    const newRoom = async (extra = {}) => {
      const room = await ok('/api/bot-rooms', 'POST', { name: `Check room ${unique}-${roomIds.length}`, bot_ids: [ada, bo], setup_done: true, ...extra });
      roomIds.push(room.id);
      return room;
    };

    // Creating: limits and the first look.
    assert.equal((await call('/api/bot-rooms', 'POST', { name: '', bot_ids: [ada] })).status, 422, 'a room needs a name');
    assert.equal((await call('/api/bot-rooms', 'POST', { name: 'x', bot_ids: [] })).status, 422, 'a room needs a bot');
    assert.equal((await call('/api/bot-rooms', 'POST', { name: 'x', bot_ids: ['not-a-bot'] })).status, 422, 'members must be real bots');
    const pending = await ok('/api/bot-rooms', 'POST', { name: `Setup room ${unique}`, bot_ids: [ada] });
    roomIds.push(pending.id);
    assert.equal(pending.setup_state, 'pending');
    assert.equal((await say(pending.id, 'hello')).status, 409, 'a room finishes setup before its first message');
    const done = await ok(`/api/bot-rooms/${pending.id}/setup`, 'POST', { action: 'complete', bulletin: 'Keep it short' });
    assert.equal(done.setup_state, 'done');
    assert.equal(done.bulletin, 'Keep it short');

    // Every responder mode.
    const everyone = await newRoom({ default_responder: { kind: 'everyone' } });
    assert.equal((await say(everyone.id, 'status please')).status, 202);
    assert.equal((await botTexts(everyone.id)).length, 2, 'everyone answers');

    const mentions = await newRoom({ default_responder: { kind: 'mentions' } });
    await say(mentions.id, `@${names[1]} how is it going`);
    assert.deepEqual((await botTexts(mentions.id)).map(t => t.split(':')[0]), [names[1]], 'only the mentioned bot answers');
    await say(mentions.id, 'is anyone there?');
    assert.equal((await botTexts(mentions.id)).length, 1, 'nobody answers an unaddressed message');
    assert.ok((await systemTexts(mentions.id)).some(t => /Mention a bot with @/.test(t)), 'the room says how to get an answer');

    const lead = await newRoom({ default_responder: { kind: 'member', bot_id: bo } });
    await say(lead.id, 'no mention');
    assert.deepEqual((await messages(lead.id)).filter(m => m.role === 'bot').map(m => m.bot_id), [bo], 'the lead answers by default');

    const auto = await newRoom({ default_responder: { kind: 'auto', fallback_bot_id: ada } });
    demoState.botsRooms.autoPick = bo;
    await say(auto.id, 'who owns this');
    const picked = (await messages(auto.id)).find(m => m.role === 'bot');
    assert.deepEqual([picked.bot_id, picked.meta.auto.p >= 0.6], [bo, true], 'auto routes above the floor');
    demoState.botsRooms.autoPick = null;
    await say(auto.id, 'and this one');
    assert.equal((await messages(auto.id)).filter(m => m.role === 'bot').at(-1).bot_id, ada, 'with no pick it falls back');

    // Hold and release by typing.
    const held = await newRoom({ default_responder: { kind: 'everyone' } });
    const stopTyped = (await say(held.id, `@${names[0]} stop`)).body;
    assert.deepEqual(stopTyped.held, [ada]);
    await say(held.id, 'status?');
    assert.deepEqual((await botTexts(held.id)).map(t => t.split(':')[0]), [names[1]], 'a held bot sits out');
    assert.equal((await ok(`/api/bot-rooms/${held.id}`, 'GET')).members.find(m => m.bot_id === ada).held, true);
    const quoted = (await say(held.id, `> @${names[1]} stop\njust a quote`)).body;
    assert.deepEqual(quoted.held, [], 'quoted text holds nobody');
    const resumed = (await say(held.id, `@${names[0]} resume`)).body;
    assert.deepEqual(resumed.released, [ada]);
    assert.equal((await ok(`/api/bot-rooms/${held.id}`, 'GET')).members.find(m => m.bot_id === ada).held, false);

    // Queue while the room works, then Stop all.
    const busy = await newRoom({ default_responder: { kind: 'member', bot_id: ada } });
    const slow = (await say(busy.id, 'long job [slow]')).body;
    assert.equal(slow.queued, false);
    assert.equal((await ok(`/api/bot-rooms/${busy.id}`, 'GET')).working, true, 'the room shows it is working');
    const waiting = (await say(busy.id, 'one more thing')).body;
    assert.equal(waiting.queued, true, 'a second message waits');
    const queue = (await ok(`/api/bot-rooms/${busy.id}/queue`, 'GET')).items;
    assert.deepEqual(queue.map(q => q.position), [1]);
    assert.equal((await call(`/api/bot-rooms/${busy.id}`, 'DELETE')).status, 409, 'a working room cannot be deleted');
    assert.equal((await call(`/api/bot-rooms/${busy.id}`, 'PATCH', { member_ids: [ada] })).status, 409, 'nor have its members changed');
    const stopped = await ok(`/api/bot-rooms/${busy.id}/stop`, 'POST', {});
    assert.deepEqual(stopped.stopped, [ada]);
    assert.equal((await ok(`/api/bot-rooms/${busy.id}`, 'GET')).working, false);
    assert.equal((await ok(`/api/bot-rooms/${busy.id}/queue`, 'GET')).items.length, 0, 'Stop all clears the queue');
    assert.equal((await botTexts(busy.id)).length, 0, 'a stopped turn leaves no reply');
    const cancelled = (await messages(busy.id)).filter(m => m.role === 'system').at(-1);
    assert.deepEqual([cancelled.meta.outcome, cancelled.meta.retry], ['cancelled', true], 'the cancelled turn offers Retry');

    // A goal run: one at a time, Stop ends it.
    const goalRoom = await newRoom({ default_responder: { kind: 'member', bot_id: ada } });
    const threadId = goalRoom.threads[0].id;
    assert.equal((await say(goalRoom.id, 'finish the report', { mode: 'goal' })).status, 202);
    assert.equal((await ok(`/api/bot-rooms/${goalRoom.id}/threads/${threadId}/goal`, 'GET')).goal.status, 'working');
    assert.equal((await say(goalRoom.id, 'a second goal', { mode: 'goal' })).status, 409, 'only one goal at a time per thread');
    await ok(`/api/bot-rooms/${goalRoom.id}/stop`, 'POST', {});
    assert.equal((await ok(`/api/bot-rooms/${goalRoom.id}/threads/${threadId}/goal`, 'GET')).goal.status, 'stopped');

    // Threads always keep one.
    const side = await ok(`/api/bot-rooms/${goalRoom.id}/threads`, 'POST', { title: 'Side' });
    const removed = await ok(`/api/bot-rooms/${goalRoom.id}/threads/delete`, 'POST', { thread_ids: [threadId, side.id] });
    assert.equal(removed.deleted.length, 1);
    assert.equal((await ok(`/api/bot-rooms/${goalRoom.id}/threads`, 'GET')).threads.length, 1);

    // Reload in the middle of a turn: the stored cursor replays what the page missed.
    const replay = await newRoom({ default_responder: { kind: 'member', bot_id: ada } });
    await say(replay.id, 'start [slow]');
    const cursor = (await frames(0)).cursor;
    await js(`localStorage.setItem('kairos:check-rooms-cursor', ${JSON.stringify(String(cursor))})`);
    await ok(`/api/bot-rooms/${replay.id}/_release`, 'POST', {});  // the turn finishes while the page is away
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const stored = await js("localStorage.getItem('kairos:check-rooms-cursor')");
    const missed = await frames(Number(stored));
    assert.equal(missed.reset, false, 'a recent cursor replays');
    assert.ok(missed.frames.some(f => f.type === 'room.turn' && f.data.status === 'ended'), 'the reload sees the turn end');
    assert.ok(missed.frames.some(f => f.type === 'room.message' && f.data.message.role === 'bot'), 'and the reply');
    assert.equal((await frames(missed.cursor + 1000)).reset, true, 'a cursor from before a restart reloads from scratch');
    await js("localStorage.removeItem('kairos:check-rooms-cursor')");

    // Unread rises for bot messages and clears when read.
    assert.ok((await ok(`/api/bot-rooms/${replay.id}`, 'GET')).unread >= 1);
    assert.equal((await ok(`/api/bot-rooms/${replay.id}/read`, 'POST', {})).unread, 0);

    // The room screen from unit U3, when it has landed: its contract exports exist.
    const screen = await js(`import('/static/js/views/botsRoom.js').then(m => ({ render: typeof m.render, mountRoom: typeof m.mountRoom })).catch(() => null)`);
    if (screen) assert.deepEqual(screen, { render: 'function', mountRoom: 'function' }, 'the room screen keeps its contract');

    // A room never leaks into the bots' own conversations: nothing here created a thread for a bot.
    for (const id of botIds) {
      const threads = await ok(`/api/agents/${id}/threads`, 'GET');
      assert.ok(!(threads.threads || []).some(t => (t.thread || t).opened_by === 'room'), 'a room seat is never in a bot thread list');
    }
    console.log('Bots rooms checks: every assertion passed.');
  } finally {
    try {
      for (const id of roomIds) {
        await call(`/api/bot-rooms/${id}/stop`, 'POST', {}).catch(() => null);
        await call(`/api/bot-rooms/${id}`, 'DELETE').catch(() => null);
      }
      for (const id of botIds) await call(`/api/agents/${id}`, 'DELETE').catch(() => null);
      await js("localStorage.removeItem('kairos:check-rooms-cursor')").catch(() => null);
    } finally {
      if (previousRooms === undefined) delete demoState.botsRooms; else demoState.botsRooms = previousRooms;
      await restore();
      // Stop the page polling the dashboard feeds once their fixtures are gone.
      try { await win.loadURL('about:blank'); } catch { /* the window may be gone */ }
    }
  }
};
