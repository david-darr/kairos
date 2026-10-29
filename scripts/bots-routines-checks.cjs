// Bots redesign, Phase 3 unit U2 (2026-10-29): the routines API as the page sees it, against the fixture backend
// (scripts/fixtures/bots-routines-backend.cjs). The pages that show routines belong to unit U3; this proves the
// contract they build on from inside the real renderer: create, preview, edit a cadence with a revision, Run now,
// a waiting run, cancel, and the results link. Creates its own routines on its own made-up bot id, restores state.
// Run: node scripts/run-electron-test.cjs scripts/ui-smoke.cjs --bots-routines-only
const assert = require('node:assert/strict');
const { isolateBotsCheck } = require('./bots-check-support.cjs');

module.exports = async ({ js, waitFor, navigate, win, demoState, base, writes }) => {
  const call = (path, method, body) => js(`fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' },
    body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} }).then(async r => ({ status: r.status, body: await r.json() }))`);
  const restore = await isolateBotsCheck({ js, demoState });
  const stamp = Date.now().toString(36);
  const bot = `routines-check-bot-${stamp}`;
  try {
    demoState.botsLive = true;
    delete demoState.botsRoutines;
    await win.loadURL(base);
    await waitFor("!!document.querySelector('.dashboard-core')");
    const start = writes.length;

    // Preview: a sentence and three times; a six-field cron names the field to fix.
    const preview = await call('/api/bot-routines/preview', 'POST', { schedule: { kind: 'interval', every_minutes: 15 } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.sentence, 'Every 15 minutes');
    assert.equal(preview.body.next.length, 3);
    const seconds = await call('/api/bot-routines/preview', 'POST', { schedule: { kind: 'cron', expression: '* * * * * *', time_zone: 'UTC' } });
    assert.deepEqual([seconds.status, seconds.body.field], [400, 'expression']);

    // Create, then edit the cadence with the revision the page holds.
    const made = await call('/api/bot-routines', 'POST', { bot_id: bot, name: `Check ${stamp}`, instructions: 'Say hello.',
      schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' } });
    assert.equal(made.status, 200);
    const routine = made.body;
    assert.deepEqual([routine.state, routine.overlap, routine.revision], ['working', 'skip', 'r1']);
    const edited = await call(`/api/bot-routines/${routine.id}`, 'PATCH', { schedule: { kind: 'interval', every_minutes: 30 }, expected_revision: routine.revision });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.sentence, 'Every 30 minutes');
    assert.equal(edited.body.revision, 'r2');
    const stale = await call(`/api/bot-routines/${routine.id}`, 'PATCH', { name: 'Late', expected_revision: 'r1' });
    assert.deepEqual([stale.status, stale.body.code], [409, 'stale']);

    // Run now starts one waiting run (needs you); a second is refused; the run carries the results link.
    const run = await call(`/api/bot-routines/${routine.id}/run`, 'POST', { request_id: `req-${stamp}` });
    assert.equal(run.status, 200);
    assert.deepEqual([run.body.run.status, run.body.run.outcome], ['waiting', 'running']);
    assert.ok(run.body.run.execution_thread_id, 'the run names its conversation, the results link');
    assert.equal((await call(`/api/bot-routines/${routine.id}`, 'GET')).body.state, 'needs_you');
    assert.equal((await call(`/api/bot-routines/${routine.id}/run`, 'POST', {})).status, 409);

    // Cancel exactly that run; the legacy outcome reads stopped; cancelling again is refused.
    assert.equal((await call(`/api/bot-routine-runs/${run.body.run.id}/cancel`, 'POST')).status, 200);
    const runs = (await call(`/api/bot-routines/${routine.id}/runs`, 'GET')).body.runs;
    assert.deepEqual([runs[0].status, runs[0].outcome], ['cancelled', 'stopped']);
    assert.equal((await call(`/api/bot-routine-runs/${run.body.run.id}/cancel`, 'POST')).status, 409);
    assert.equal((await call(`/api/bot-routine-runs/${run.body.run.id}/seen`, 'POST')).body.seen, true);

    // Delete leaves nothing behind for this bot.
    assert.equal((await call(`/api/bot-routines/${routine.id}`, 'DELETE')).status, 200);
    assert.deepEqual((await call(`/api/bot-routines?bot_id=${bot}`, 'GET')).body.routines, []);
    assert.ok(writes.slice(start).every(w => !w.status || w.status < 500), 'no server errors');
  } finally {
    delete demoState.botsRoutines;
    await restore();
  }
};
