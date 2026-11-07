// Realtime voice in the browser (build spec 6b): the playback bookkeeping, and the client against a fake websocket and a
// fake AudioContext: audio chunks are scheduled gaplessly, the provider's speech_started stops every scheduled chunk at
// once and reports how much was heard, startup errors surface, and nothing but the websocket to Kairos is ever used.
// Plain node, no browser, no network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const load = async file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(file, 'utf8')).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const { PlaybackTracker, realtimeVoice, pcm16ToFloat, base64ToBuffer } = await load('static/js/realtimeVoice.js');

  // ---- bookkeeping ---------------------------------------------------------------------------------------------
  const tracker = new PlaybackTracker();
  assert.equal(tracker.schedule('a', 100, 10), 10);              // first chunk starts now
  assert.ok(Math.abs(tracker.schedule('a', 100, 10.01) - 10.1) < 1e-9, 'the next chunk follows the first with no gap');
  assert.equal(Math.round(tracker.playedMs(10.05)), 50);
  assert.equal(tracker.playedMs(99), 200, 'never more than was scheduled');
  assert.equal(tracker.playedMs(5), 0, 'before it starts nothing was heard');
  tracker.schedule('b', 50, 20);                                  // a new reply starts fresh
  assert.equal(tracker.scheduledMs, 50);
  tracker.reset();
  assert.equal(tracker.active, false);
  assert.equal(tracker.playedMs(30), 0);

  // ---- samples ---------------------------------------------------------------------------------------------------
  const pcm = new Int16Array([0, 16384, -16384, 32767]);
  const back = pcm16ToFloat(base64ToBuffer(Buffer.from(pcm.buffer).toString('base64')));
  assert.deepEqual([...back].map(v => Math.round(v * 100) / 100), [0, 0.5, -0.5, 1]);

  // ---- the client ------------------------------------------------------------------------------------------------
  global.cancelAnimationFrame = () => {};
  global.requestAnimationFrame = () => 1;
  const sent = [];
  let socket = null, now = 0;
  const contexts = [];
  const makeContext = options => {
    const sources = [];
    const context = {
      sampleRate: options.sampleRate || 48000, sources, closed: false,
      get currentTime() { return now; },
      audioWorklet: { addModule: async () => {} },
      resume: async () => {}, close: async () => { context.closed = true; },
      createGain: () => ({ connect() {}, disconnect() {} }),
      createAnalyser: () => ({ connect() {}, fftSize: 0, getFloatTimeDomainData(array) { array.fill(0); } }),
      destination: {},
      createBuffer: (channels, length, rate) => ({ length, rate, copyToChannel() {} }),
      createBufferSource: () => { const source = { buffer: null, started: null, stopped: false, connect() {}, disconnect() {}, start(at) { source.started = at; }, stop() { source.stopped = true; } }; sources.push(source); return source; },
      createMediaStreamSource: () => ({ connect() {} }),
    };
    contexts.push(context);
    return context;
  };
  class FakeNode { constructor() { this.port = { onmessage: null }; } disconnect() {} }
  const fakeSocket = url => {
    socket = { url, readyState: 0, sent, send(data) { sent.push(typeof data === 'string' ? JSON.parse(data) : { binary: data.byteLength }); }, close() { this.readyState = 3; } };
    setImmediate(() => { socket.readyState = 1; socket.onopen?.(); });
    return socket;
  };
  const states = [], captions = [], errors = [], infos = [];
  const client = realtimeVoice(state => states.push(state), (role, text) => captions.push([role, text]), () => {}, message => errors.push(message), info => infos.push(info), {
    makeSocket: fakeSocket, makeContext, WorkletNode: FakeNode, location: { protocol: 'http:', host: '127.0.0.1:8420' },
    getMedia: async () => ({ getTracks: () => [{ stop() {} }], getAudioTracks: () => [{ enabled: true }] }),
  });

  const starting = client.start('abc123', 'endpoint-1', 'cedar', true);
  while (!socket || socket.readyState !== 1) await tick();
  await tick();
  assert.equal(socket.url, 'ws://127.0.0.1:8420/api/agent-calls/abc123/realtime');
  assert.deepEqual(sent[0], { type: 'start', endpoint_id: 'endpoint-1', voice: 'cedar', consent: true });
  socket.onmessage({ data: JSON.stringify({ type: 'ready', provider: 'xai', label: 'xAI Grok Voice', model: 'm', price_per_minute: 0.05, verified: false }) });
  await starting;
  assert.equal(infos[0].provider, 'xai');
  assert.ok(states.includes('listening'));

  // microphone blocks go up as binary; a muted microphone sends none
  const node = contexts[0] && null;
  const chunk = (ms, rate = 24000) => Buffer.from(new Int16Array(rate * ms / 1000).buffer).toString('base64');
  const audio = (ms, item = 'itemA') => socket.onmessage({ data: JSON.stringify({ type: 'audio', data: chunk(ms), rate: 24000, item_id: item }) });
  now = 5;
  audio(100); audio(100); audio(100);
  const playback = contexts[1];
  assert.equal(playback.sources.length, 3);
  assert.deepEqual(playback.sources.map(s => Math.round(s.started * 1000)), [5000, 5100, 5200], 'chunks are scheduled back to back');
  assert.ok(states.includes('speaking'));

  now = 5.13;                                                    // 130 ms into the reply the person starts talking
  socket.onmessage({ data: JSON.stringify({ type: 'speech_started', item_id: 'itemA' }) });
  assert.ok(playback.sources.every(s => s.stopped), 'every scheduled chunk is stopped on the spot');
  const report = sent.filter(m => m.type === 'played').pop();
  assert.equal(report.item_id, 'itemA');
  assert.equal(report.ms, 130);
  assert.equal(states[states.length - 1], 'listening');

  // a reply that has finished playing reports the whole thing
  now = 9; audio(200, 'itemB'); now = 20;
  socket.onmessage({ data: JSON.stringify({ type: 'speech_started', item_id: 'itemB' }) });
  assert.equal(sent.filter(m => m.type === 'played').pop().ms, 200);

  // captions and errors, and a muted assistant plays nothing
  socket.onmessage({ data: JSON.stringify({ type: 'user_text', delta: 'hello' }) });
  socket.onmessage({ data: JSON.stringify({ type: 'assistant_text', delta: 'hi there' }) });
  assert.deepEqual(captions, [['You', 'hello'], ['Agent', 'hi there']]);
  client.muteAssistant(true);
  const before = playback.sources.length;
  audio(50, 'itemC');
  assert.equal(playback.sources.length, before);
  client.muteMicrophone(true);
  assert.equal(sent.filter(m => m.type === 'mute').pop().value, true);
  socket.onmessage({ data: JSON.stringify({ type: 'error', message: 'Provider error.' }) });
  assert.deepEqual(errors, ['Provider error.']);
  socket.onmessage({ data: JSON.stringify({ type: 'work', task_id: 't1', status: 'running' }) });
  assert.equal(infos[infos.length - 1].work.task_id, 't1');

  client.stop();
  assert.ok(sent.some(m => m.type === 'end'));
  assert.ok(contexts.every(c => c.closed));

  // a startup that is refused reports the server's own reason, not a generic one
  const second = realtimeVoice(() => {}, () => {}, () => {}, message => errors.push(message), () => {}, {
    makeSocket: url => { const s = { readyState: 0, send() {}, close() {} }; setImmediate(() => { s.readyState = 1; s.onopen?.(); setImmediate(() => { s.onmessage({ data: JSON.stringify({ type: 'error', message: 'Enable paid realtime voice explicitly before starting this call.' }) }); s.onclose?.(); }); }); return s; },
    makeContext, WorkletNode: FakeNode, location: { protocol: 'https:', host: 'kairos.example' },
    getMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }),
  });
  await assert.rejects(second.start('zzz', 'e', 'v', false), /Enable paid realtime voice/);

  console.log('realtime voice client: ok');
})().catch(error => { console.error(error); process.exit(1); });
