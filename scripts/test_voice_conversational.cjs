// Conversational voice (Fluid Voice, track B), the browser half: the spoken-style clean-up, backchannels, the
// acknowledgement gate and clip decoding, and what both speakers remember (the sentences actually heard), pause and
// resume, and play an acknowledgement ahead of the answer. The server half is scripts/test_voice_conversational.py;
// the shared tables in scripts/fixtures keep the two from drifting. Plain node: fake AudioContext, fake speech synthesis.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
const load = async (file, prefix = '') => import('data:text/javascript;base64,' + Buffer.from(prefix + source(file)).toString('base64'));
const table = name => JSON.parse(fs.readFileSync('scripts/fixtures/' + name, 'utf8'));

(async () => {
  // ---- the spoken-style clean-up and backchannels: the same tables the server is checked against ---------------------
  const vo = await load('static/js/voiceOutput.js');
  for (const item of table('spoken-style-cases.json')) assert.equal(vo._forSpeech(item.in), item.out, JSON.stringify(item.in));
  assert.equal(vo._forSpeech('```js\nconsole.log(1)\n```\n```py\nprint(2)\n```'), vo.CODE_LINE, 'two code blocks in a row are one spoken line');
  const bc = await load('static/js/backchannel.js');
  for (const item of table('backchannel-cases.json')) assert.equal(bc.isBackchannel(item.text, item.asked), item.expect, JSON.stringify(item));
  assert.equal(bc.endsInQuestion(['Sure.', 'Do you want the detail?']), true);
  assert.equal(bc.endsInQuestion(['Do you want it?', 'Okay then.']), false);
  assert.equal(bc.endsInQuestion([]), false);

  // ---- clip decoding ---------------------------------------------------------------------------------------------
  globalThis.__tr = { readEvents: async () => {} };
  const vf = await load('static/js/voiceFiller.js', 'const {readEvents}=globalThis.__tr;\n');
  const pcm = Buffer.alloc(8); pcm.writeInt16LE(16384, 0); pcm.writeInt16LE(-16384, 2);
  const clip = vf.clipFromEvents([{ filler: { id: 'okay', text: 'Okay.' } }, { sample_rate: 24000 }, { audio: pcm.toString('base64') }]);
  assert.equal(clip.rate, 24000); assert.equal(clip.samples.length, 4); assert.equal(clip.samples[0], .5); assert.equal(clip.samples[1], -.5);
  assert.deepEqual(vf.clipFromEvents([{ filler: { id: 'okay', text: 'Okay.' } }]), { id: 'okay', text: 'Okay.' }, 'a device voice gets the text only');
  assert.equal(vf.clipFromEvents([{ filler: { id: 'okay', text: 'Okay.' } }, { cached: false }]), null, 'a neural phrase not cached yet is skipped');
  assert.equal(vf.clipFromEvents([]), null);

  // ---- the acknowledgement gate: timing rules with a manual clock -------------------------------------------------
  const clock = () => {
    const timers = []; let id = 0;
    return { setTimer: (fn, ms) => { timers.push({ id: ++id, fn, ms }); return id; }, clearTimer: handle => { const at = timers.findIndex(t => t.id === handle); if (at >= 0) timers.splice(at, 1); }, timers,
      fire: async () => { const t = timers.shift(); if (t) await t.fn(); await tick(); } };
  };
  const make = (options = {}) => {
    const c = clock(), played = [], asked = []; let n = 0;
    const gate = vf.createFillerGate({ setTimer: c.setTimer, clearTimer: c.clearTimer, blocked: () => !!options.blocked,
      fetchClip: async (last, text) => { asked.push([last, text]); return options.none ? null : { id: 'f' + (++n), text: 'Okay.' }; }, play: clip => played.push(clip.id) });
    return { gate, c, played, asked };
  };
  assert.equal(vf.FILLER_AFTER_MS, 500);
  {
    const { gate, c, played, asked } = make();
    assert.equal(gate.arm({ text: 'what time is it' }), true); assert.equal(c.timers[0].ms, 500, 'it waits half a second');
    await tick(); assert.deepEqual(asked, [[null, 'what time is it']], 'the clip is fetched at once so it is in hand when the time is up');
    await c.fire(); assert.deepEqual(played, ['f1'], 'no sentence by then: the acknowledgement plays');
    gate.arm({ text: 'and now' }); await tick(); assert.equal(asked.at(-1)[0], 'f1', 'the last phrase is passed so the server never repeats it');
    await c.fire(); assert.deepEqual(played, ['f1', 'f2']);
  }
  { // a quick answer
    const { gate, c, played } = make(); gate.arm({ text: 'hi' }); await tick(); gate.sentenceReady(); await c.fire();
    assert.deepEqual(played, [], 'the first sentence was ready in time: nothing plays'); assert.equal(c.timers.length, 0);
  }
  { // cancel, work updates, muted, blocked, nothing playable
    const a = make(); a.gate.arm({ text: 'x' }); await tick(); a.gate.cancel(); await a.c.fire(); assert.deepEqual(a.played, [], 'an interruption cancels it');
    const b = make(); assert.equal(b.gate.arm({ text: 'x', workUpdate: true }), false); assert.equal(b.c.timers.length, 0);
    const m = make(); assert.equal(m.gate.arm({ text: 'x', muted: true }), false);
    const k = make({ blocked: true }); k.gate.arm({ text: 'x' }); await tick(); await k.c.fire(); assert.deepEqual(k.played, [], 'not while the user is talking again');
    const none = make({ none: true }); none.gate.arm({ text: 'x' }); await tick(); await none.c.fire(); assert.deepEqual(none.played, [], 'no clip, no sound');
    const again = make(); again.gate.arm({ text: 'x' }); again.gate.arm({ text: 'y' }); assert.equal(again.c.timers.length, 1, 'arming again replaces the earlier timer');
  }

  // ---- the call's neural speaker: what was heard, pause and resume, an acknowledgement ahead of the answer ----------
  const created = [], requests = [];
  class FakeContext {
    constructor() { this.currentTime = 0; this.destination = {}; this.state = 'running'; this.suspends = 0; this.resumes = 0; FakeContext.last = this; }
    createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(array) { array.fill(0); } }; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); return { length, duration: length / rate, rate, getChannelData: () => data, copyToChannel(from) { data.set(from); } }; }
    createBufferSource() { const node = { buffer: null, connect() {}, start(at) { node.at = at; created.push(node); }, stop() { node.stopped = true; }, onended: null }; return node; }
    async resume() { this.state = 'running'; this.resumes++; } async suspend() { this.state = 'suspended'; this.suspends++; } close() {}
  }
  global.AudioContext = FakeContext; global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
  global.fetch = async (path, options) => {
    const entry = { body: JSON.parse(options.body), aborted: false };
    entry.stream = new ReadableStream({ start(controller) { entry.controller = controller; options.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch {} }); } });
    entry.send = item => { try { entry.controller.enqueue(new TextEncoder().encode(JSON.stringify(item) + '\n')); } catch {} };
    entry.audio = n => entry.send({ audio: Buffer.alloc(n * 2400 * 2).toString('base64') });
    entry.finish = () => { entry.send({ done: true }); try { entry.controller.close(); } catch {} };
    requests.push(entry);
    return new Response(entry.stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  const tr = await load('static/js/callTransport.js', 'const api=async()=>({});');
  globalThis.__vo = vo; globalThis.__tr = tr; globalThis.__api = { api: async () => ({}), el: () => ({}) };
  const callVoice = await load('static/js/callVoice.js', 'const {api,el}=globalThis.__api;const {createChunker,createSpeaker,_forSpeech}=globalThis.__vo;const {readEvents}=globalThis.__tr;\n');
  const fresh = async () => {
    created.length = 0; requests.length = 0; const events = [];
    const speaker = callVoice.neuralSpeaker({ onStart: () => events.push('start'), onEnd: () => events.push('end'), onSentenceStart: i => events.push('sentence' + i) }, () => ({ model: 'm', voice: 'v' }));
    await speaker.prepare(); speaker.reset();
    return { speaker, events, context: FakeContext.last };
  };
  {
    const { speaker, context } = await fresh();
    speaker.feed('One here. Two here. Three here.'); speaker.finish(); await tick();
    requests.forEach(r => r.send({ sample_rate: 24000 })); requests[0].audio(1); requests[0].finish(); requests[1].audio(2); await tick();
    assert.deepEqual(speaker.heard(), [], 'scheduled but the output clock has not reached it: nothing has been heard yet');
    context.currentTime = created[0].at + .05;
    assert.deepEqual(speaker.heard(), ['One here.'], 'the first sentence is being heard');
    context.currentTime = created[1].at + .01; assert.deepEqual(speaker.heard(), ['One here.', 'Two here.']);
    speaker.pause(); await tick(); assert.equal(context.state, 'suspended', 'the voice is held mid-word'); assert.equal(speaker.paused, true);
    speaker.resume(); await tick(); assert.equal(context.state, 'running'); assert.equal(speaker.paused, false);
    speaker.pause(); await tick();
    speaker.cancel(); await tick();
    assert.equal(context.state, 'running', 'cancelling a paused voice un-pauses the output so the next reply can play');
    assert.deepEqual(speaker.heard(), ['One here.', 'Two here.'], 'what was heard survives the cancel, for the history');
    speaker.reset(); assert.deepEqual(speaker.heard(), [], 'and is forgotten when the next reply starts');
    speaker.dispose();
  }
  { // an acknowledgement is queued ahead of the answer and is not part of what was heard
    const { speaker, events, context } = await fresh();
    speaker.filler({ id: 'okay', text: 'Okay.', rate: 24000, samples: new Float32Array(12000).fill(.1) }); await tick();
    assert.equal(created.length, 1, 'the clip is scheduled at once'); assert.equal(created[0].buffer.length, 12000);
    await wait(60); assert.deepEqual(events, ['start'], 'it is the first sound');
    speaker.feed('The answer is here.'); speaker.finish(); await tick();
    requests[0].send({ sample_rate: 24000 }); requests[0].audio(1); requests[0].finish(); await tick();
    assert.equal(created.length, 2); assert.ok(created[1].at >= created[0].at + created[0].buffer.duration - 1e-9, 'the answer queues right behind the acknowledgement');
    context.currentTime = created[1].at + .01;
    assert.deepEqual(speaker.heard(), ['The answer is here.'], 'the acknowledgement is not part of the reply that is remembered');
    speaker.cancel(); speaker.dispose();
  }
  { // an acknowledgement that ends while the reply is still being written reports the lull, so the owner keeps waiting
    const { speaker, events } = await fresh();
    speaker.filler({ id: 'okay', text: 'Okay.', rate: 24000, samples: new Float32Array(2400).fill(.1) }); await wait(50);
    created[0].onended(); assert.deepEqual(events, ['start', 'end']);
    speaker.dispose();
  }

  // ---- the device (OS voice) speaker ------------------------------------------------------------------------------
  {
    const spoken = []; let paused = 0, resumed = 0, cancelled = 0;
    class Utterance { constructor(text) { this.text = text; this.handlers = {}; } addEventListener(name, fn) { this.handlers[name] = fn; } }
    global.SpeechSynthesisUtterance = Utterance;
    global.window = { speechSynthesis: { speak: u => spoken.push(u), cancel: () => { cancelled++; }, pause: () => { paused++; }, resume: () => { resumed++; }, pending: false, speaking: false, getVoices: () => [] }, SpeechSynthesisUtterance: Utterance };
    const events = [];
    const speaker = vo.createSpeaker({ onStart: () => events.push('start'), onEnd: () => events.push('end'), onSentenceStart: i => events.push('sentence' + i), onSentenceReady: i => events.push('ready' + i) });
    speaker.reset();
    speaker.filler({ text: 'Mm, let me think.' });
    assert.equal(spoken.length, 1); assert.deepEqual(events, [], 'an acknowledgement is not a sentence of the reply');
    spoken[0].handlers.start(); assert.deepEqual(events, ['start']); assert.deepEqual(speaker.heard(), []);
    speaker.feed('First one here. Second one here.'); speaker.finish();
    assert.deepEqual(spoken.map(u => u.text), ['Mm, let me think.', 'First one here.', 'Second one here.']);
    assert.deepEqual(events.filter(e => e.startsWith('ready')), ['ready0', 'ready1'], 'the answer\'s sentences are numbered from zero, the acknowledgement is not counted');
    spoken[1].handlers.start(); assert.deepEqual(speaker.heard(), ['First one here.'], 'the sentences that began to play, raw, in order');
    speaker.pause(); assert.equal(paused, 1); assert.equal(speaker.paused, true); speaker.resume(); assert.equal(resumed, 1);
    speaker.pause(); speaker.cancel(); assert.equal(cancelled, 1); assert.equal(resumed, 2, 'cancelling a paused voice resumes the queue so the next reply is not stuck');
    assert.deepEqual(speaker.heard(), ['First one here.'], 'still readable after the cancel');
    speaker.reset(); assert.deepEqual(speaker.heard(), []);
    // voices are chosen through the shared wrapper too
    const both = callVoice.createVoiceSpeaker({}, () => ({ provider: 'device' }), () => speaker);
    both.reset(); assert.equal(typeof both.pause, 'function'); assert.equal(typeof both.heard, 'function'); assert.equal(typeof both.filler, 'function');
    both.cancel(); both.dispose();
  }

  console.log('Conversational voice (spoken style, backchannels, acknowledgement gate, heard sentences, pause and resume): passed');
})().catch(error => { console.error(error); process.exit(1); });
