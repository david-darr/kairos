// Conversational voice (Fluid Voice, track B), the browser half: the spoken-style clean-up, backchannels, what both
// speakers remember (the sentences actually heard), pause and resume, and that neither plays a thinking filler (removed
// 2026-11-11: the first thing heard is the answer). The server half is scripts/test_voice_conversational.py;
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

  globalThis.__tr = { readEvents: async () => {} };
  assert.equal(fs.existsSync('static/js/voiceFiller.js'), false, 'the filler gate is gone');

  // ---- the call's neural speaker: what was heard, pause and resume, no filler -----------------------------------------
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
  { // no filler: nothing is scheduled until the answer's first sentence has audio
    const { speaker, events } = await fresh();
    assert.equal(speaker.filler, undefined, 'the neural speaker has no filler to play');
    speaker.feed('The answer is here.'); await tick();
    assert.equal(created.length, 0, 'silence while the answer is being written'); assert.deepEqual(events, []);
    speaker.finish(); await tick();
    requests[0].send({ sample_rate: 24000 }); requests[0].audio(1); requests[0].finish(); await tick();
    assert.equal(created.length, 1, 'the first sound is the answer'); await wait(60); assert.deepEqual(events.slice(0, 2).sort(), ['sentence0', 'start']);
    speaker.cancel(); speaker.dispose();
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
    assert.equal(speaker.filler, undefined, 'the device speaker has no filler to say');
    speaker.feed('First one here. Second one here.'); speaker.finish();
    assert.deepEqual(spoken.map(u => u.text), ['First one here.', 'Second one here.'], 'only the answer is spoken');
    assert.deepEqual(events.filter(e => e.startsWith('ready')), ['ready0', 'ready1'], 'the answer\'s sentences are numbered from zero');
    spoken[0].handlers.start(); assert.deepEqual(events.slice(-2), ['sentence0', 'start']);
    assert.deepEqual(speaker.heard(), ['First one here.'], 'the sentences that began to play, raw, in order');
    speaker.pause(); assert.equal(paused, 1); assert.equal(speaker.paused, true); speaker.resume(); assert.equal(resumed, 1);
    speaker.pause(); speaker.cancel(); assert.equal(cancelled, 1); assert.equal(resumed, 2, 'cancelling a paused voice resumes the queue so the next reply is not stuck');
    assert.deepEqual(speaker.heard(), ['First one here.'], 'still readable after the cancel');
    speaker.reset(); assert.deepEqual(speaker.heard(), []);
    // voices are chosen through the shared wrapper too
    const both = callVoice.createVoiceSpeaker({}, () => ({ provider: 'device' }), () => speaker);
    both.reset(); assert.equal(typeof both.pause, 'function'); assert.equal(typeof both.heard, 'function'); assert.equal(both.filler, undefined);
    both.cancel(); both.dispose();
  }

  console.log('Conversational voice (spoken style, backchannels, no filler, heard sentences, pause and resume): passed');
})().catch(error => { console.error(error); process.exit(1); });
