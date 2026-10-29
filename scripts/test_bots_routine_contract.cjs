// The routines fixture (scripts/fixtures/bots-routines-backend.cjs) holds the server's contract
// (routes/bot_routine_routes.py, services/bot_routines.py): the same DTO keys, the status words with their
// legacy outcome mapping, the preview shape and the stale-revision refusal. Run: node scripts/test_bots_routine_contract.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const factory = require('./fixtures/bots-routines-backend.cjs');

const fresh = () => { const state = {}; const b = factory({ state, now: 1_800_000_000 }); return { state, get: (p, q) => b.read(p, q), send: (p, m, body) => b.mutate(p, m, body) }; };
const status = (a) => a?._status ?? 200;
const bot = 'a-test';
const make = (f, extra = {}) => f.send('/api/bot-routines', 'POST', { bot_id: bot, name: 'Brief', instructions: 'Do it', schedule: { kind: 'daily', time: '09:00', time_zone: 'UTC' }, ...extra });

(() => {
  // The server module owns these key lists; the fixture must carry every one.
  const server = fs.readFileSync(path.join(__dirname, '..', 'services', 'bot_routines.py'), 'utf8');
  for (const key of factory.ROUTINE_KEYS) assert.ok(server.includes(`"${key}"`), `the server's routine view has ${key}`);
  for (const key of factory.RUN_KEYS) assert.ok(server.includes(`"${key}"`), `the server's run view has ${key}`);
  const f = fresh();
  const routine = make(f);
  assert.deepEqual(Object.keys(routine).filter(k => !factory.ROUTINE_KEYS.includes(k)), [], 'no keys beyond the contract');
  for (const key of factory.ROUTINE_KEYS) assert.ok(key in routine, `routine has ${key}`);
})();

(() => {
  // Status words and the legacy outcome beside them.
  assert.deepEqual(factory.STATUSES, ['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'missed']);
  assert.deepEqual(Object.fromEntries(factory.STATUSES.map(s => [s, factory.OUTCOME[s]])),
    { queued: 'queued', running: 'running', waiting: 'running', completed: 'succeeded', failed: 'failed', cancelled: 'stopped', missed: 'lost' });
  const py = fs.readFileSync(path.join(__dirname, '..', 'services', 'task_service.py'), 'utf8');
  for (const word of factory.STATUSES) assert.ok(py.includes(`"${word}"`), `the server knows ${word}`);
})();

(() => {
  // Preview: the sentence and three times, or the field to fix.
  const f = fresh();
  const ok = f.send('/api/bot-routines/preview', 'POST', { schedule: { kind: 'interval', every_minutes: 15 } });
  assert.equal(ok.next.length, 3);
  assert.equal(ok.sentence, 'Every 15 minutes');
  const seconds = f.send('/api/bot-routines/preview', 'POST', { schedule: { kind: 'cron', expression: '* * * * * *', time_zone: 'UTC' } });
  assert.deepEqual([status(seconds), seconds.field], [400, 'expression']);
  const noZone = f.send('/api/bot-routines/preview', 'POST', { schedule: { kind: 'cron', expression: '0 9 * * *' } });
  assert.deepEqual([status(noZone), noZone.field], [400, 'time_zone']);
})();

(() => {
  // Revisions, run now, cancel, seen, and the status mapping on run records.
  const f = fresh();
  const routine = make(f);
  const stale = f.send(`/api/bot-routines/${routine.id}`, 'PATCH', { name: 'X', expected_revision: 'r0' });
  assert.deepEqual([status(stale), stale.code], [409, 'stale']);
  const edited = f.send(`/api/bot-routines/${routine.id}`, 'PATCH', { name: 'Renamed', expected_revision: routine.revision });
  assert.equal(edited.revision, 'r2');
  const run = f.send(`/api/bot-routines/${routine.id}/run`, 'POST', {});
  assert.equal(run.run.status, 'waiting');
  assert.equal(run.run.outcome, 'running');
  assert.equal(f.get(`/api/bot-routines/${routine.id}`).state, 'needs_you');
  assert.equal(status(f.send(`/api/bot-routines/${routine.id}/run`, 'POST', {})), 409);
  assert.equal(f.send(`/api/bot-routine-runs/${run.run.id}/cancel`, 'POST').ok, true);
  assert.equal(f.get(`/api/bot-routines/${routine.id}/runs`).runs[0].outcome, 'stopped');
  assert.equal(status(f.send(`/api/bot-routine-runs/${run.run.id}/cancel`, 'POST')), 409);
  assert.equal(f.send(`/api/bot-routine-runs/${run.run.id}/seen`, 'POST').seen, true);
  assert.equal(status(f.send('/api/bot-routine-runs/none/seen', 'POST')), 404);
  assert.equal(f.send('/api/tasks', 'GET'), undefined, 'other routes are not its own');
  assert.equal(make(f, { name: 'Renamed' }).code, 'duplicate');
})();

console.log('bots routine contract: ok');
