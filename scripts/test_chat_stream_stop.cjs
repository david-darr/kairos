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

  // The slow-reply notice, the Ollama detail and the lost-contact state
  // (static/js/waitNotice.js, fed by chatStream's last-packet time).
  const notice = await import('data:text/javascript;base64,' + Buffer.from(
    fs.readFileSync(path.join(__dirname, '../static/js/waitNotice.js'), 'utf8')).toString('base64'));
  const T = 1_000_000;  // seconds, the server's clock
  const waiting = extra => ({ status: 'processing', connected: true, turnId: 't', text: '', waitingSince: T,
    provider: 'Ollama', toolSteps: [], toolEvents: [], ...extra });
  const at = (seconds, entry, contact = 0) => notice.waitNotice(entry, (T + seconds) * 1000, contact);
  assert.equal(at(59, waiting()), null, 'plain Waiting for response before a minute');
  assert.equal(at(60, waiting()).label, 'Still waiting on Ollama · 1m 00s');
  assert.equal(at(65, waiting()).label, 'Still waiting on Ollama · 1m 05s');
  assert.equal(at(125, waiting()).label, 'Still waiting on Ollama · 2m 05s');
  assert.equal(at(70, waiting({ provider: '' })).label, 'Still waiting on the model · 1m 10s');
  assert.equal(at(70, waiting({ providerDetail: 'Loading the model into memory' })).detail, 'Loading the model into memory');
  assert.equal(at(70, waiting()).detail, '');
  assert.equal(at(70, waiting({ text: 'Hi' })), null, 'no notice once text arrives');
  assert.equal(at(130, waiting({ toolSteps: [{}], waitingSince: T + 100 })), null, 'the clock restarts after a tool finishes');
  assert.equal(at(170, waiting({ toolSteps: [{}], waitingSince: T + 100 })).label, 'Still waiting on Ollama · 1m 10s', 'and a slow model after a tool gets the notice too');
  assert.equal(at(70, waiting({ permission: { id: 'p' } })), null, 'waiting on the person, not the model');
  assert.equal(at(70, waiting({ connected: false })), null, 'only once the request is sent');
  assert.equal(at(70, waiting({ waitingSince: null })), null);
  for (const status of ['done', 'failed', 'stopped']) assert.equal(at(500, waiting({ status })), null, `no notice after ${status}`);
  assert.equal(at(500, waiting({ status: 'done' }), (T + 400) * 1000), null, 'a finished run is never lost contact');

  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    let paints = 0, fetches = 0;
    const baseFetch = global.fetch; global.fetch = (...args) => { fetches++; return baseFetch(...args); };
    first.startTurn('slow-test', 'Forge', 'Think hard', []);
    await new Promise(resolve => setImmediate(resolve));
    const slow = first.getInFlight('slow-test');
    assert.equal(slow.status, 'processing');
    const unsubscribe = first.subscribe('slow-test', () => paints++);
    const paintsBefore = paints, fetchesBefore = fetches, contactBefore = first.lastContact();
    assert.ok(contactBefore > 0);
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()), null, 'fresh turn: no notice');

    skew = 29_000;
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()), null, 'not yet 30 s of silence');
    skew = 31_000;
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()).state, 'disconnected');
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()).label, 'Lost contact with Kairos');

    viewers[0].active = true;
    viewers[0].send({ type: 'heartbeat' });
    assert.ok(first.lastContact() > contactBefore, 'a heartbeat stamps the contact time');
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()), null, 'recovers on the next packet');
    assert.equal(paints, paintsBefore, 'a heartbeat re-renders nothing');
    assert.equal(fetches, fetchesBefore, 'a heartbeat refetches nothing');
    assert.equal(slow.revision, runs['slow-test'].revision, 'a heartbeat changes no run state');

    skew = 31_000 + 29_000;
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()), null);
    skew = 31_000 + 31_000;
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()).state, 'disconnected');
    viewers[0].send({ type: 'update', sessionId: 'slow-test', turnId: 'turn-1', revision: 99, changes: { providerDetail: 'Model is working' } });
    assert.equal(notice.waitNotice(slow, Date.now(), first.lastContact()), null, 'any update packet also counts as contact');
    assert.equal(slow.providerDetail, 'Model is working');
    assert.equal(first.stopTurn('slow-test'), true, 'Stop stays available while waiting or out of contact');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(first.getInFlight('slow-test').status, 'stopped');
    assert.equal(notice.waitNotice(first.getInFlight('slow-test'), Date.now() + 999_000, 1), null, 'no notice after the run ends');
    unsubscribe();
    global.fetch = baseFetch;
  } finally { Date.now = realNow; }
  console.log('Live Chat and Forge survive viewer departure, sync to another device, and stop explicitly.');
})().catch(error => { console.error(error); process.exitCode = 1; });
