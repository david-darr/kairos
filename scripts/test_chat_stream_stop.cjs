// Two browser instances join one server-owned turn; closing one viewer does
// not stop it, and Stop is a separate explicit request.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const code = fs.readFileSync(path.join(__dirname, '../static/js/chatStream.js'), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  const viewers = [];
  const runs = {};
  let stopRequests = 0;
  global.EventSource = class {
    constructor(url) { assert.equal(url, '/api/chat/live/events'); this.active = true; viewers.push(this); }
    send(packet) { if (this.active) this.onmessage?.({ data: JSON.stringify(packet) }); }
  };
  const broadcast = packet => viewers.forEach(viewer => viewer.send(packet));
  global.fetch = async (url, options = {}) => {
    if (url === '/api/chat/live/snapshot') {
      return { ok: true, json: async () => ({ type: 'snapshot', runs: structuredClone(runs) }) };
    }
    if (url === '/api/chat/live') {
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      const run = runs[body.session_id] = { turnId: 'turn-1', sessionTitle: 'Forge', prompt: body.message,
        text: '', startedAt: Date.now() / 1000, status: 'processing', stopping: false,
        permission: null, toolEvents: [], toolSteps: [], handoffs: null, runId: null, error: null, revision: 1 };
      broadcast({ type: 'started', sessionId: body.session_id, run: structuredClone(run) });
      return { ok: true, json: async () => ({ turn_id: run.turnId }) };
    }
    if (url === '/api/chat/live/stop') {
      stopRequests++;
      const id = JSON.parse(options.body).session_id;
      runs[id].status = 'stopped';
      broadcast({ type: 'update', sessionId: id, turnId: runs[id].turnId,
        changes: { status: 'stopped', stopping: false, permission: null, error: null } });
      return { ok: true, json: async () => ({ stopping: true }) };
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const first = await import(moduleUrl + '#first');
  const second = await import(moduleUrl + '#second');
  await first.connect();
  await second.connect();
  const sent = first.startTurn('forge-test', 'Forge', 'Build', []);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second.getInFlight('forge-test').prompt, 'Build');
  viewers[0].active = false; // Browser closed or lost its network connection.
  viewers[0].onerror();
  const staleSnapshot = structuredClone(runs);
  runs['forge-test'].text = 'Working live';
  runs['forge-test'].revision++;
  broadcast({ type: 'chunk', sessionId: 'forge-test', turnId: 'turn-1',
    revision: runs['forge-test'].revision, chunk: 'Working live' });
  assert.equal(second.getInFlight('forge-test').text, 'Working live');
  viewers[1].send({ type: 'snapshot', runs: staleSnapshot });
  assert.equal(second.getInFlight('forge-test').text, 'Working live');
  assert.equal(sent.status, 'processing');
  assert.equal(stopRequests, 0);

  assert.equal(second.stopTurn('forge-test'), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopRequests, 1);
  assert.equal(second.getInFlight('forge-test').status, 'stopped');
  viewers[0].active = true;
  viewers[0].send({ type: 'snapshot', runs: structuredClone(runs) });
  assert.equal(first.getInFlight('forge-test').text, 'Working live');
  assert.equal(first.getInFlight('forge-test').status, 'stopped');
  assert.equal(first.stopTurn('forge-test'), false);
  console.log('Live Chat and Forge survive viewer departure, sync to another device, and stop explicitly.');
})().catch(error => { console.error(error); process.exitCode = 1; });
