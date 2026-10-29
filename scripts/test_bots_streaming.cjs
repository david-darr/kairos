// Bot sessions accumulate streamed text in chatStream.js like any chat, and
// stale revisions are dropped (Phase 0 U5). Run: node scripts/test_bots_streaming.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const code = fs.readFileSync(path.join(__dirname, '../static/js/chatStream.js'), 'utf8');
  const chatStream = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const sources = [];
  const runs = {};
  global.EventSource = class {
    constructor(url) { assert.equal(url, '/api/chat/live/events'); sources.push(this); }
    send(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
  };
  global.fetch = async url => {
    assert.equal(url, '/api/chat/live/snapshot');
    return { ok: true, json: async () => ({ type: 'snapshot', runs: structuredClone(runs) }) };
  };
  const send = packet => sources[0].send(packet);
  const SESSION = 'bot-session';
  const run = { turnId: 'turn-1', sessionTitle: 'Scout', prompt: 'What changed?', text: '', startedAt: 1,
    status: 'processing', stopping: false, permission: null, toolEvents: [], toolSteps: [], handoffs: null,
    runId: null, error: null, revision: 1 };
  runs[SESSION] = structuredClone(run);
  await chatStream.connect();
  assert.equal(chatStream.getInFlight(SESSION).status, 'processing');

  const seen = [];
  chatStream.subscribe(SESSION, entry => seen.push(entry.text));
  const chunk = (revision, text) => send({ type: 'chunk', sessionId: SESSION, turnId: 'turn-1', revision, chunk: text });

  chunk(2, 'Found ');
  chunk(3, 'three ');
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three ');
  assert.equal(chatStream.getInFlight(SESSION).status, 'processing', 'text is readable while the turn runs');

  // A replayed or out-of-order packet is dropped, not appended.
  chunk(3, 'three ');
  chunk(2, 'Found ');
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three ');

  // A stale snapshot (older revision) never rewinds the text.
  send({ type: 'snapshot', runs: { [SESSION]: { ...run, text: 'Found ', revision: 2 } } });
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three ');

  // A packet for another turn is ignored (it triggers a resync, which returns the old run).
  send({ type: 'chunk', sessionId: SESSION, turnId: 'other-turn', revision: 99, chunk: 'WRONG' });
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three ');

  chunk(4, 'changes today.');
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three changes today.');
  send({ type: 'update', sessionId: SESSION, turnId: 'turn-1', revision: 5, changes: { status: 'done' } });
  assert.equal(chatStream.getInFlight(SESSION).status, 'done');
  assert.equal(chatStream.getInFlight(SESSION).text, 'Found three changes today.', 'text kept at the terminal status');
  assert.deepEqual(seen.slice(0, 2), ['Found ', 'Found three '], 'subscribers saw partial text before the end');
  assert.ok(seen.includes('Found three changes today.'));
  console.log('PASS: bot streaming accumulates text and drops stale revisions.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
