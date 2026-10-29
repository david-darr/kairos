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
  const interrupts = [];
  let interruptReply = { outcome: 'stopping' };
  global.fetch = async (url, options = {}) => {
    if (url === '/api/bot-chat/bot-session/interrupt') { interrupts.push(JSON.parse(options.body)); return { ok: true, json: async () => interruptReply }; }
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

  // Guarded Stop (Phase 1, U3): Stop names the turn it means and goes to the bot route.
  const nextRun = (turnId, revision = 1) => ({ ...run, turnId, revision, text: '', status: 'processing', stopping: false });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  runs[SESSION] = nextRun('turn-2');
  send({ type: 'started', sessionId: SESSION, run: structuredClone(runs[SESSION]) });
  assert.equal(chatStream.getInFlight(SESSION).turnId, 'turn-2');
  assert.equal(chatStream.stopTurn(SESSION, { bot: true }), true);
  assert.equal(chatStream.getInFlight(SESSION).stopping, true, 'the Stop shows at once');
  assert.equal(chatStream.stopTurn(SESSION, { bot: true }), false, 'a repeated Stop is dropped');
  await tick();
  assert.deepEqual(interrupts, [{ turn_id: 'turn-2' }], 'only the captured turn ID is sent');
  send({ type: 'update', sessionId: SESSION, turnId: 'turn-2', revision: 2, changes: { status: 'stopped' } });
  assert.equal(chatStream.getInFlight(SESSION).status, 'stopped');

  // A stale Stop answers already-stopped: nothing is stopped, and the live turn is not left looking "stopping".
  runs[SESSION] = nextRun('turn-3');
  send({ type: 'started', sessionId: SESSION, run: structuredClone(runs[SESSION]) });
  interruptReply = { outcome: 'already-stopped' };
  interrupts.length = 0;
  assert.equal(chatStream.stopTurn(SESSION, { bot: true }), true);
  await tick(); await tick();
  assert.deepEqual(interrupts, [{ turn_id: 'turn-3' }]);
  assert.equal(chatStream.getInFlight(SESSION).status, 'processing', 'a stale Stop never ends the live turn');
  assert.equal(chatStream.getInFlight(SESSION).stopping, false);
  assert.equal(chatStream.stopTurn(SESSION, { bot: true }), true, 'and Stop can be pressed again');
  await tick();

  // Bots runtime frames are handed to the open conversation and never disturb a live turn.
  const handed = [], liveBefore = chatStream.getInFlight(SESSION).text;
  global.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  global.document = { dispatchEvent: event => handed.push(event), addEventListener() {} };
  send({ type: 'bot.queued', sessionId: SESSION, queue: { items: [], revision: 3 } });
  send({ type: 'bot.runtime', sessionId: 'someone-else', state: 'idle' });
  assert.deepEqual(handed.map(e => [e.type, e.detail.type]), [['kairos:bot-runtime', 'bot.queued'], ['kairos:bot-runtime', 'bot.runtime']]);
  assert.equal(chatStream.getInFlight(SESSION).text, liveBefore, 'a runtime frame leaves the live text alone');
  delete global.document; delete global.CustomEvent;
  console.log('PASS: bot streaming accumulates text, drops stale revisions, guards Stop by turn, and hands on runtime frames.');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
