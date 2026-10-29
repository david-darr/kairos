// The settings patch queue behind a bot's panel (Agents 3.0 Phase 0, unit U4): plain-Node checks.
// Run: node scripts/test_bots_patch_queue.cjs
// Loads static/js/botsPatchQueue.js straight from disk and drives it with a fake clock, a fake
// sender and a fake re-read, so nothing here waits on a real timer.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

// A clock the test advances by hand.
function clock() {
  let now = 0, next = 1;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: id => timers.delete(id),
    async advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
      await settle();
    },
    pending: () => timers.size,
  };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

(async () => {
  const { createPatchQueue, BYPASS_KEYS, DEBOUNCE_MS } = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsPatchQueue.js')).href);

  // A sender that records what it was given and answers like the server (the bot with the patch laid on).
  function rig(options = {}) {
    const clk = clock();
    const sent = [], saved = [], rolled = [];
    const server = { a1: { id: 'a1', name: 'Scout', role: 'Old', soul: 'x', endpoint_id: null } };
    let failNext = false, hold = null;
    const queue = createPatchQueue({
      send: async (id, body) => {
        sent.push({ id, body: { ...body } });
        if (hold) await hold.promise;
        if (failNext) { failNext = false; throw new Error('400: a bot called Scout already exists'); }
        Object.assign(server[id], body);
        return { ...server[id] };
      },
      reread: async id => { if (options.rereadFails) throw new Error('offline'); return { ...server[id] }; },
      onSaved: (id, agent, body) => saved.push({ id, agent, body }),
      onRollback: (id, agent, error) => rolled.push({ id, agent, error: error.message }),
      setTimer: clk.setTimer, clearTimer: clk.clearTimer,
    });
    return { queue, clk, sent, saved, rolled, server, fail: () => { failNext = true; },
      holdSend: () => { let release; hold = { promise: new Promise(r => { release = r; }) }; return () => { hold = null; release(); }; } };
  }

  await check('the delay is 400 ms and model and approval skip it', () => {
    assert.equal(DEBOUNCE_MS, 400);
    assert.deepEqual([...BYPASS_KEYS].sort(), ['approval_mode', 'endpoint_id', 'model_effort', 'model_override']);
  });

  await check('changes inside 400 ms are merged into one request, sent 400 ms after the last one', async () => {
    const { queue, clk, sent } = rig();
    queue.update('a1', { role: 'Reads' });
    await clk.advance(300);
    queue.update('a1', { blurb: 'Quiet' });
    await clk.advance(300);
    assert.equal(sent.length, 0, 'the second change restarted the wait');
    queue.update('a1', { role: 'Reads more' });
    await clk.advance(399);
    assert.equal(sent.length, 0);
    await clk.advance(1);
    assert.equal(sent.length, 1, 'one request');
    assert.deepEqual(sent[0].body, { role: 'Reads more', blurb: 'Quiet' }, 'merged, the later value wins');
  });

  await check('the overlay shows unsent changes over a record read from the server, and clears once saved', async () => {
    const { queue, clk, server } = rig();
    queue.update('a1', { role: 'Typed' });
    assert.deepEqual(queue.overlayFor('a1'), { role: 'Typed' });
    assert.equal(queue.apply({ id: 'a1', name: 'Scout', role: 'Old' }).role, 'Typed', 'a poll that lands now does not undo the edit');
    assert.equal(queue.apply({ id: 'zz', role: 'Other' }).role, 'Other', 'other bots are untouched');
    assert.equal(queue.isPending('a1'), true);
    await clk.advance(400);
    assert.deepEqual(queue.overlayFor('a1'), {}, 'saved, so nothing is held over');
    assert.equal(queue.isPending('a1'), false);
    assert.equal(server.a1.role, 'Typed');
  });

  await check('a value changed again while a send is in flight stays in the overlay', async () => {
    const { queue, clk, sent, holdSend } = rig();
    const release = holdSend();
    queue.update('a1', { role: 'First' });
    await clk.advance(400);
    assert.equal(sent.length, 1);
    queue.update('a1', { role: 'Second' });
    release();
    await clk.advance(0);
    assert.deepEqual(queue.overlayFor('a1'), { role: 'Second' }, 'the newer edit is still shown, and waits its own 400 ms');
    assert.equal(sent.length, 1);
    await clk.advance(400);
    assert.deepEqual(sent.map(s => s.body.role), ['First', 'Second'], 'sent in order, one at a time');
    assert.deepEqual(queue.overlayFor('a1'), {});
  });

  await check('model and approval changes are sent at once, with whatever else was waiting', async () => {
    const { queue, clk, sent } = rig();
    queue.update('a1', { role: 'Waiting' });
    const done = queue.update('a1', { endpoint_id: 'm3', model_override: 'opus' });
    await done;
    assert.equal(sent.length, 1, 'no wait');
    assert.deepEqual(sent[0].body, { role: 'Waiting', endpoint_id: 'm3', model_override: 'opus' });
    assert.equal(clk.pending(), 0, 'the pending timer was cleared');
    await queue.update('a1', { approval_mode: 'full' });
    assert.deepEqual(sent[1].body, { approval_mode: 'full' });
    await queue.update('a1', { model_effort: 'high' });
    assert.equal(sent.length, 3);
  });

  await check('an update made during a request waits for its own send to finish', async () => {
    const { queue, clk, holdSend, sent } = rig();
    const release = holdSend();
    queue.update('a1', { role: 'First' });
    await clk.advance(400);
    let settled = false;
    queue.update('a1', { role: 'Second' }).then(() => { settled = true; });
    release();
    await settle();
    assert.equal(settled, false, 'the first response does not acknowledge the second edit');
    await clk.advance(400);
    assert.equal(settled, true);
    assert.equal(sent.length, 2);
  });

  await check('flush during an in-flight send drains newer edits before resolving', async () => {
    const { queue, clk, holdSend, server } = rig();
    const release = holdSend();
    queue.update('a1', { role: 'First' });
    await clk.advance(400);
    queue.update('a1', { role: 'Second' });
    let settled = false;
    const flushed = queue.flush('a1').then(() => { settled = true; });
    await settle();
    assert.equal(settled, false);
    release(); await flushed;
    assert.equal(server.a1.role, 'Second');
    assert.equal(queue.isPending('a1'), false);
    assert.equal(clk.pending(), 0);
  });

  await check('immediate:true sends at once for any key', async () => {
    const { queue, sent } = rig();
    await queue.update('a1', { name: 'Renamed' }, { immediate: true });
    assert.equal(sent.length, 1);
  });

  await check('a failed send forgets the overlay, re-reads the bot and reports the error', async () => {
    const { queue, clk, rolled, server, fail, saved } = rig();
    fail();
    queue.update('a1', { name: 'Archivist', role: 'Bad' });
    await clk.advance(400);
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].id, 'a1');
    assert.match(rolled[0].error, /already exists/);
    assert.equal(rolled[0].agent.name, 'Scout', 'the re-read shows what is really stored');
    assert.equal(rolled[0].agent.role, 'Old');
    assert.deepEqual(queue.overlayFor('a1'), {}, 'the screen goes back to the stored values');
    assert.equal(queue.isPending('a1'), false);
    assert.equal(saved.length, 0);
    assert.equal(server.a1.name, 'Scout');
    // The lane works again afterwards.
    queue.update('a1', { role: 'Fine' });
    await clk.advance(400);
    assert.equal(server.a1.role, 'Fine');
  });

  await check('if the re-read fails too, the caller still hears about it (with no bot)', async () => {
    const { queue, clk, rolled, fail } = rig({ rereadFails: true });
    fail();
    queue.update('a1', { role: 'x' });
    await clk.advance(400);
    assert.equal(rolled.length, 1);
    assert.equal(rolled[0].agent, null);
  });

  await check('flush sends everything now and waits for it, for one bot or all', async () => {
    const { queue, clk, sent } = rig();
    queue.update('a1', { role: 'One' });
    queue.update('a2', { role: 'Two' });
    await queue.flush('a1');
    assert.deepEqual(sent.map(s => s.id), ['a1'], 'only that bot');
    await queue.flush();
    assert.deepEqual(sent.map(s => s.id).sort(), ['a1', 'a2']);
    assert.equal(clk.pending(), 0);
    await queue.flush();
    assert.equal(sent.length, 2, 'nothing left to send');
  });

  await check('lanes are separate: each bot has its own wait and its own request', async () => {
    const { queue, clk, sent, server } = rig();
    server.a2 = { id: 'a2', name: 'Archivist' };
    queue.update('a1', { role: 'A' });
    await clk.advance(200);
    queue.update('a2', { role: 'B' });
    await clk.advance(200);
    assert.deepEqual(sent.map(s => s.id), ['a1']);
    await clk.advance(200);
    assert.deepEqual(sent.map(s => s.id), ['a1', 'a2']);
  });

  await check('cancel drops queued changes when a bot is deleted', async () => {
    const { queue, clk, sent } = rig();
    queue.update('a1', { role: 'Doomed' });
    queue.cancel('a1');
    await clk.advance(1000);
    assert.equal(sent.length, 0);
    assert.deepEqual(queue.overlayFor('a1'), {});
    assert.equal(clk.pending(), 0);
    queue.cancel('never-seen');
  });

  await check('an update with nothing in it is ignored', async () => {
    const { queue, clk, sent } = rig();
    await queue.update('a1', {});
    await clk.advance(1000);
    assert.equal(sent.length, 0);
  });

  await check('flushing an empty lane does not block a later edit', async () => {
    const { queue, sent, clk } = rig();
    await queue.flush('a1');
    queue.update('a1', { role: 'After empty flush' });
    await clk.advance(400);
    assert.equal(sent.length, 1);
    await queue.flush('a1');
    await queue.update('a1', { endpoint_id: 'm3' });
    assert.equal(sent.length, 2);
    assert.equal(queue.isPending('a1'), false);
  });

  await check('flushResult says whether the settings saved, and never rejects', async () => {
    const { queue, clk, saved, server, fail } = rig();
    assert.deepEqual(Object.keys(await queue.flushResult('a1')).sort(), ['agent', 'ok'], 'nothing pending is a success');
    queue.update('a1', { role: 'Saved role' });
    const good = await queue.flushResult('a1');
    assert.equal(good.ok, true);
    assert.equal(good.agent.role, 'Saved role');
    assert.equal(server.a1.role, 'Saved role');
    fail();
    queue.update('a1', { role: 'Refused role' });
    const bad = await queue.flushResult('a1');
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /already exists/);
    assert.equal(server.a1.role, 'Saved role', 'a refused edit never reaches the record');
    assert.equal((await queue.flushResult('a1')).ok, true, 'a failure is reported once');
    assert.equal(saved.length, 1);
  });

  await check('a failed debounced save is still reported to the next flush (a send must not run on unchosen settings)', async () => {
    const { queue, clk, fail, rolled } = rig();
    fail();
    queue.update('a1', { role: 'Will be refused' });
    await clk.advance(400);
    assert.equal(rolled.length, 1);
    const result = await queue.flushResult('a1');
    assert.equal(result.ok, false);
    assert.equal(result.error.message, '400: a bot called Scout already exists');
  });

  await check('flushBotEdits goes through the registered queue and resolves {ok, agent}', async () => {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'static', 'js', 'botsPatchQueue.js')).href);
    assert.deepEqual(await mod.flushBotEdits('a1'), { ok: true, agent: null }, 'with no panel loaded nothing can be pending');
    const { queue, fail } = rig();
    mod.setSharedQueue(queue);
    queue.update('a1', { role: 'Through the shared queue' });
    assert.equal((await mod.flushBotEdits('a1')).ok, true);
    fail();
    queue.update('a1', { role: 'Refused' });
    const bad = await mod.flushBotEdits('a1');
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
    mod.setSharedQueue({ flushResult: () => Promise.reject(new Error('boom')) });
    assert.equal((await mod.flushBotEdits('a1')).ok, false, 'an unexpected failure is a result, not a rejection');
    mod.setSharedQueue(null);
  });

  console.log(`PASS: ${passed.length} bots patch-queue checks`);
  for (const name of passed) console.log('  ok - ' + name);
})().catch(error => { console.error(error); process.exit(1); });
