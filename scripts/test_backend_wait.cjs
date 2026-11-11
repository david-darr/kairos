// The desktop app's wait for its backend (electron/backend-wait.js, 2026-11-10): an update with moving
// progress is waited out however long it takes, a real stall still fails, and nothing answering at all still
// fails after the old two minutes. A fake clock and fake answers; no Electron, backend or network.
// Run: node scripts/test_backend_wait.cjs
const assert = require('node:assert/strict');
const path = require('node:path');
const { waitForBackend, describe, UPDATE_HEADLINE } = require(path.join(__dirname, '..', 'electron', 'backend-wait.js'));

const MINUTE = 60 * 1000;

// answer(t) is what the backend says at fake time t (ms): 'down', 'ok', or a progress state.
function run(answer, { timeoutMs = 2 * MINUTE, stallMs = 5 * MINUTE } = {}) {
  let t = 0;
  const updates = [];
  const waits = [];
  const fetchImpl = async () => {
    const said = answer(t);
    if (said === 'down') throw new Error('ECONNREFUSED');
    if (said === 'ok') return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
    return { ok: false, status: 503, json: async () => said };
  };
  return waitForBackend({
    fetchImpl, baseUrl: 'http://127.0.0.1:1', timeoutMs, stallMs,
    onWaiting: (elapsed, updated) => waits.push([elapsed, updated]),
    onUpdating: (state) => updates.push(state),
    sleep: async (ms) => { t += ms; }, now: () => t,
  }).then((result) => ({ ...result, at: t, updates, waits }));
}

const moving = (t) => ({ status: 'updating', phase: 'moving', detail: 'Moving your files into your account', done: Math.floor(t / 10000), total: 400 });

(async () => {
  // A quick start, as before.
  let r = await run((t) => (t < 3000 ? 'down' : 'ok'));
  assert.equal(r.ok, true);
  assert.equal(r.updated, false);

  // Nothing ever answers: the old two-minute limit.
  r = await run(() => 'down');
  assert.equal(r.ok, false);
  assert.equal(r.stalled, false);
  assert.ok(r.at >= 2 * MINUTE && r.at < 2 * MINUTE + 1000, `gave up at ${r.at}`);

  // A 33-minute update whose progress keeps moving, then the app starts: waited out, never "couldn't start".
  r = await run((t) => (t < 33 * MINUTE ? moving(t) : t < 33 * MINUTE + 20000 ? 'down' : 'ok'));
  assert.equal(r.ok, true, 'a long update with moving progress is waited out');
  assert.equal(r.updated, true);
  assert.ok(r.updates.length > 1000);
  assert.ok(r.waits.every(([, updated]) => updated), 'the gap after the update counts as part of it');

  // Progress that stops moving: a real stall, reported as one, after the stall limit and not before.
  r = await run((t) => (t < 4 * MINUTE ? moving(t) : moving(4 * MINUTE)));
  assert.equal(r.ok, false);
  assert.equal(r.stalled, true);
  assert.ok(r.at >= 4 * MINUTE + 5 * MINUTE - 10000 && r.at <= 4 * MINUTE + 5 * MINUTE + 1000, `stalled at ${r.at}`);
  assert.equal(r.last.phase, 'moving');

  // A copy that counts files in its detail keeps the wait alive even while done stays put.
  r = await run((t) => (t < 20 * MINUTE ? { status: 'updating', phase: 'moving', detail: `Copying chats: ${Math.floor(t / 5000)} files so far`, done: 3, total: 40 } : 'ok'));
  assert.equal(r.ok, true);

  // After an update, the app gets the stall limit to come up, not the two-minute one.
  r = await run((t) => (t < MINUTE ? moving(t) : t < MINUTE + 4 * MINUTE ? 'down' : 'ok'));
  assert.equal(r.ok, true);

  // What the window says.
  assert.equal(describe({ detail: 'Moving your files into your account', done: 12, total: 68 }), 'Moving your files into your account (12 of 68)');
  assert.equal(describe({ detail: 'Checking your data', done: 0, total: 0 }), 'Checking your data');
  assert.match(UPDATE_HEADLINE, /^Updating your data for this version\. This can take a few minutes\. Don't close Kairos\.$/);
  console.log('backend wait: 8 checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
