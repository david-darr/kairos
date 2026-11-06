const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = async file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '')).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const { createBlockQueue } = await load('static/js/botsSpeak.js');
  const { _chunk, _forSpeech } = await load('static/js/voiceOutput.js');
  assert.deepEqual(_chunk('Hello there. This is next! Then another? Final line.'), ['Hello there.', 'This is next!', 'Then another?', 'Final line.']);
  let prepared = [], played = [], finish;
  const queue = createBlockQueue({ prepare: async text => { prepared.push(text); return text; }, play: text => { played.push(text); return new Promise(resolve => finish = resolve); } });
  queue.update(['A']); await tick(); assert.deepEqual(prepared, []);
  queue.update(['A', 'B', 'C', 'D', 'E']); await tick();
  assert.deepEqual(prepared, ['A', 'B', 'C']); assert.deepEqual(played, ['A']);
  finish(); await tick(); assert.deepEqual(prepared, ['A', 'B', 'C', 'D']); assert.deepEqual(played, ['A', 'B']);
  finish(); await tick(); finish(); await tick(); finish(); await tick();
  assert.deepEqual(played, ['A', 'B', 'C', 'D']);
  queue.update(['A', 'B', 'C', 'D', 'E'], true); await tick(); assert.equal(played.at(-1), 'E');
  finish(); await tick(); queue.update(['A', 'B', 'C', 'D', 'E'], true); await tick(); assert.equal(played.length, 5);
  queue.destroy();
  let resolveRender, errors = [];
  const stale = createBlockQueue({ prepare: () => new Promise(resolve => resolveRender = resolve), play: value => played.push(value), onError: e => errors.push(e) });
  stale.update(['stale'], true); await tick(); stale.cancel(); resolveRender('stale'); await tick(); assert.equal(played.includes('stale'), false); stale.destroy();
  let reconcile = [], stops = 0;
  const rewritten = createBlockQueue({ prepare: async x => x, play: async x => { reconcile.push(x); }, stop: () => stops++ });
  rewritten.update(['One', 'Draft']); await tick(); rewritten.update(['One', 'Final'], true); await tick();
  assert.deepEqual(reconcile, ['One', 'Final']); rewritten.destroy(); assert.ok(stops);
  const changed = createBlockQueue({ prepare: async x => x, play: async x => { reconcile.push(x); } });
  changed.update(['Spoken', 'Draft']); await tick(); changed.update(['Rewritten', 'Final'], true); await tick();
  assert.deepEqual(reconcile.slice(-2), ['Spoken', 'Final'], 'a rewritten final frame never replays completed audio'); changed.destroy();
  const state = { botsLive: true }, fixture = require('./fixtures/bots-voice-backend.cjs')({ state });
  assert.equal(fixture.read('/api/bot-voice/voices'), undefined); assert.equal(fixture.mutate('/api/bot-voice/speak/prepare', 'POST', {}), undefined);
  state.botsVoice = { botIds: ['owned'], catalog: { models: [], voices: [] } };
  assert.equal(fixture.mutate('/api/bot-voice/owned/notes', 'POST', { text: 'Hello' })._status, 409);
  assert.equal(fixture.mutate('/api/bot-voice/owned/notes', 'POST', { text: 'x'.repeat(1001) })._status, 422);
  assert.equal(fixture.read('/other-route'), undefined);
  state.botsVoice.catalog = { models: ['local'], voices: [{ id: 'local' }] };
  const note = fixture.mutate('/api/bot-voice/owned/notes', 'POST', { text: 'Hello' });
  assert.equal(fixture.read(note.transcript_url).transcript, 'Hello');
  assert.equal(Buffer.from(fixture.read(note.url)._audioWav, 'base64').subarray(0, 4).toString(), 'RIFF');
  // The first PCM packet plays before the HTTP stream finishes, including an
  // odd-byte packet boundary. Cancellation stops every scheduled source.
  const oldFetch = global.fetch, oldContext = global.AudioContext;
  let packets, nodes = [], finished = false;
  global.__speechApi = async () => ({ blocks: ['Read this.'], withheld: false });
  global.__deviceSpeaker = () => ({ cancel() {} });
  global.__speechCleaner = _forSpeech;
  global.AudioContext = class {
    currentTime = 0; destination = {};
    async resume() {} async close() {}
    createBuffer(channels, size, rate) { return { duration: size / rate, getChannelData: () => new Float32Array(size) }; }
    createBufferSource() { const node = { connect() {}, start() { nodes.push(this); }, stop() { this.stopped = true; this.onended?.(); } }; return node; }
  };
  global.fetch = async () => new Response(new ReadableStream({ start(controller) { packets = controller; } }));
  const source = fs.readFileSync('static/js/botsSpeak.js', 'utf8').replace(/^import .*;\r?\n/gm, '') + '\n';
  const module = await import('data:text/javascript;base64,' + Buffer.from('const api=globalThis.__speechApi,createSpeaker=globalThis.__deviceSpeaker,_forSpeech=globalThis.__speechCleaner;\n' + source).toString('base64'));
  const pcmErrors = [], reader = module.createReadAloud({ voiceId: 'local', onError: e => pcmErrors.push(e) });
  await reader.update('Read this.', true); await tick();
  const send = item => packets.enqueue(new TextEncoder().encode(JSON.stringify(item) + '\n'));
  send({ sample_rate: 24000 }); send({ audio: Buffer.from([1]).toString('base64') }); send({ audio: Buffer.from([0, 0, 0]).toString('base64') });
  await tick(); assert.equal(nodes.length, 1, 'playback starts while the response is open');
  send({ done: true }); packets.close(); await tick(); nodes[0].onended(); await tick();
  assert.deepEqual(pcmErrors, []); reader.destroy();
  global.fetch = oldFetch; global.AudioContext = oldContext; delete global.__speechApi; delete global.__deviceSpeaker; delete global.__speechCleaner;
  // Drive the transcript's actual live-turn lifecycle without browser speech.
  const oldDocument = global.document;
  class Node extends EventTarget {
    children = []; dataset = {}; classList = { toggle() {}, add() {}, remove() {} };
    append(...nodes) { for (const node of nodes.flat()) if (node) { node.parent = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this[key] = value; } removeAttribute(key) { delete this[key]; }
    querySelectorAll() { return []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  }
  const doc = new EventTarget(); doc.documentElement = { dataset: {} }; global.document = doc;
  global.__speechH = (tag, attrs = {}, children = []) => { const node = new Node(); Object.assign(node, attrs); node.append(children); return node; };
  const snapshots = [], selections = []; let cancelled = 0, destroyed = 0;
  global.__speechModule = { createReadAloud(options) { selections.push(options.voiceId); return { update: async (text, final) => snapshots.push([text, final]), cancel() { cancelled++; }, destroy() { destroyed++; } }; } };
  const transcriptSource = fs.readFileSync('static/js/botsTranscript.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace("import('./botsSpeak.js')", 'Promise.resolve(globalThis.__speechModule)');
  const transcript = await import('data:text/javascript;base64,' + Buffer.from('const h=globalThis.__speechH;\n' + transcriptSource).toString('base64'));
  const mounted = transcript.mountTranscript(new Node(), { agent: { id: 'owned', name: 'Voice', speak_replies: true }, renderBody() {} });
  mounted.setLive({ turnId: 'one', text: 'Hello.', status: 'processing', startedAt: Date.now() / 1000 }); await tick();
  mounted.setLive({ turnId: 'one', text: 'Hello. Final.', status: 'done', startedAt: Date.now() / 1000 }); await tick();
  assert.deepEqual(snapshots, [['Hello.', false], ['Hello. Final.', true]]);
  mounted.setLive({ turnId: 'one', text: 'Hello. Final.', status: 'stopped' }); await tick(); assert.ok(cancelled);
  document.dispatchEvent(new CustomEvent('kairos:bots-saved', { detail: { agentId: 'owned', agent: { speak_replies: false } } }));
  mounted.setLive({ turnId: 'two', text: 'Quiet.', status: 'processing' }); await tick(); assert.equal(snapshots.length, 2);
  document.dispatchEvent(new CustomEvent('kairos:bots-saved', { detail: { agentId: 'owned', agent: { speak_replies: true, voice_id: 'new-local' } } }));
  mounted.setLive({ turnId: 'three', text: 'New voice.', status: 'done' }); await tick(); assert.equal(selections.at(-1), 'new-local');
  mounted.dispose(); assert.ok(destroyed >= 2);
  global.document = oldDocument; delete global.__speechH; delete global.__speechModule;
  for (const file of ['static/css/bots-voice.css', 'static/js/botsSpeak.js', 'static/js/botsCallBar.js', 'static/js/botsVoiceNote.js']) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /#[a-f0-9]{3,8}\b|rgba?\(|\u2014/i);
  }
  console.log('Bots speech queue: passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
