const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

// The Bots conversation runtime (Phase 1 U1, 2026-10-29). Run behind --bots-runtime-only. It makes its own bot and
// conversations in the runtime fixture (scripts/fixtures/bots-runtime-backend.cjs), never assumes which other bots
// exist, drives the synthetic model through demoState.botsRuntimeControl, and calls the /api/bot-chat contract from the
// page itself: queue across navigation and reload, queue edit and delete, a stale Stop against the next turn, an
// alternate branch, and a solo goal Stop. The renderer is U3's; this check holds the runtime contract it will use.
module.exports = async ({ js, waitFor, delay, navigate, win, base, demoState }) => {
  const api = (method, path, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)},
    headers: { 'content-type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))`);
  let counter = 0;
  const send = async (sid, text, extra = {}) => {
    const state = (await api('GET', `/api/bot-chat/${sid}/state`)).body;
    return api('POST', `/api/bot-chat/${sid}/send`, { send_id: `runtime-${process.pid}-${++counter}`, text, expected_leaf_id: state.active_leaf_id, ...extra });
  };
  const botId = `runtime-bot-${process.pid}`;
  const restore = await isolateBotsCheck({ js, demoState }, {});
  const control = demoState.botsRuntimeControl;
  try {
    assert.ok(control, 'the runtime fixture is installed');
    control.reset();
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const first = control.seed(botId, 2), second = control.thread(botId), third = control.thread(botId);

    // A send is accepted at once; a lost-response retry gets the same answer and adds no second message.
    const sent = await api('POST', `/api/bot-chat/${first}/send`, { send_id: `runtime-${process.pid}-first`, text: 'Start the report', expected_leaf_id: null });
    assert.equal(sent.status, 202); assert.equal(sent.body.queued, false); assert.ok(sent.body.turn_id);
    const retry = await api('POST', `/api/bot-chat/${first}/send`, { send_id: `runtime-${process.pid}-first`, text: 'Start the report', expected_leaf_id: null });
    assert.equal(retry.body.replayed, true); assert.equal(retry.body.turn_id, sent.body.turn_id);
    assert.equal((await api('POST', `/api/bot-chat/${first}/send`, { send_id: `runtime-${process.pid}-first`, text: 'Something else', expected_leaf_id: null })).status, 409);
    assert.equal(control.tree(first).length, 1);

    // The queue survives navigation and a page reload, and keeps its order.
    const queuedA = (await send(first, 'Then check the totals')).body, queuedB = (await send(first, 'And the dates')).body;
    assert.deepEqual([queuedA.queued, queuedA.reason, queuedB.queued], [true, 'busy', true]);
    await navigate('home');
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    let queue = (await api('GET', `/api/bot-chat/${first}/queue`)).body;
    assert.deepEqual(queue.items.map(item => item.text), ['Then check the totals', 'And the dates']);
    assert.equal((await api('GET', `/api/bot-chat/${first}/state`)).body.turn.status, 'running', 'the turn outlived the reload');

    // Edit takes a queued message back; delete leaves a tombstone and a repeat is refused.
    const taken = (await api('POST', `/api/bot-chat/${first}/queue/${queuedA.queue_id}/edit`)).body;
    assert.equal(taken.draft.text, 'Then check the totals');
    const removed = (await api('DELETE', `/api/bot-chat/${first}/queue/${queuedB.queue_id}`)).body;
    assert.deepEqual(removed.items, []); assert.ok(removed.consumed_queue_ids.includes(queuedB.queue_id));
    assert.equal((await api('DELETE', `/api/bot-chat/${first}/queue/${queuedB.queue_id}`)).status, 409);
    control.finish(first, 'Report started.');
    assert.equal(control.tree(first).filter(m => m.role === 'user').length, 1, 'removed messages never ran');

    // Slots: the third conversation waits for a free slot, then runs when one opens.
    await send(second, 'Second job');
    await send(first, 'Another job');
    const overflow = (await send(third, 'Third job')).body;
    assert.deepEqual([overflow.queued, overflow.reason], [true, 'capacity']);
    control.finish(second, 'second done');
    assert.equal((await api('GET', `/api/bot-chat/${third}/state`)).body.turn.status, 'running', 'the waiting thread started by itself');
    control.finish(first, 'done'); control.finish(third, 'done');

    // A late Stop for a finished turn cannot reach the next turn.
    const turnOne = (await send(second, 'Quick one')).body;
    control.finish(second, 'quick done');
    const turnTwo = (await send(second, 'Longer one')).body;
    const stale = await api('POST', `/api/bot-chat/${second}/interrupt`, { turn_id: turnOne.turn_id });
    assert.equal(stale.body.outcome, 'already-stopped');
    assert.equal((await api('GET', `/api/bot-chat/${second}/state`)).body.turn.status, 'running');
    const held = (await send(second, 'Waiting behind it')).body;
    const stop = await api('POST', `/api/bot-chat/${second}/interrupt`, { turn_id: turnTwo.turn_id });
    assert.equal(stop.body.outcome, 'stopping');
    const afterStop = (await api('GET', `/api/bot-chat/${second}/queue`)).body;
    assert.equal(afterStop.paused, true); assert.deepEqual(afterStop.items.map(item => item.id), [held.queue_id], 'queued work waits after a Stop');
    assert.equal(control.tree(second).filter(m => m.kind === 'stopped').length, 1, 'one quiet note');
    assert.equal((await api('POST', `/api/bot-chat/${second}/queue/resume`)).body.paused, false);
    control.finish(second, 'resumed');

    // An edited question becomes another version; the old one stays and can be chosen again.
    let page = (await api('GET', `/api/bot-chat/${first}/messages`)).body;
    const question = page.messages.find(m => m.role === 'user');
    const edit = await api('POST', `/api/bot-chat/${first}/messages/${question.bot_message_id}/edit`,
      { send_id: `runtime-${process.pid}-edit`, text: 'Start the report, shorter', expected_leaf_id: page.active_leaf_id, expected_revision: page.branch_revision });
    assert.equal(edit.status, 202);
    control.finish(first, 'Shorter report.');
    page = (await api('GET', `/api/bot-chat/${first}/messages`)).body;
    const switcher = page.messages.find(m => m.version);
    assert.equal(switcher.version.count, 2); assert.equal(switcher.version.index, 2);
    assert.equal(control.tree(first).filter(m => m.role === 'user' && m.content === 'Start the report').length, 1, 'the first version is kept');
    const back = await api('POST', `/api/bot-chat/${first}/active-branch`, { message_id: switcher.version.ids[0], expected_revision: page.branch_revision });
    assert.equal(back.body.messages.at(-1).content, 'done', 'the newest leaf under the chosen version');
    assert.equal((await api('POST', `/api/bot-chat/${first}/active-branch`, { message_id: switcher.version.ids[1], expected_revision: 0 })).status, 409);

    // A solo goal can be stopped by its root; an old root does nothing.
    const goalSession = control.thread(botId);
    await send(goalSession, 'Finish the whole job', { mode: 'goal' });
    const goal = (await api('GET', `/api/bot-chat/${goalSession}/state`)).body.goal;
    assert.equal(goal.status, 'working');
    assert.equal((await api('POST', `/api/bot-chat/${goalSession}/goal/stop`, { root_id: 'an-old-root' })).body.outcome, 'already-stopped');
    assert.equal((await api('GET', `/api/bot-chat/${goalSession}/state`)).body.turn.status, 'running');
    assert.equal((await api('POST', `/api/bot-chat/${goalSession}/goal/stop`, { root_id: goal.root_id })).body.outcome, 'stopping');
    assert.equal((await api('GET', `/api/bot-chat/${goalSession}/state`)).body.goal.status, 'stopped');

    // Other people's and unknown conversations are not found.
    assert.equal((await api('GET', '/api/bot-chat/not-a-conversation/state')).status, 404);
    await delay(50);
  } finally {
    try { control?.reset(); } finally { await restore(); }
  }
};
