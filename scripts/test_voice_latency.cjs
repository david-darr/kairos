// Voice latency work (Fluid Voice build order steps 1 and 2, no new models): the per-turn trace helper, the sentence
// chunker (no hold-back, first-clause release, abbreviations/decimals), the call speaker's prefetching queue
// (order, cancellation mid-prefetch, look-ahead limit) and the call transport's push channel.
// Plain node, no browser: the speaker runs against a fake AudioContext and a fake speech endpoint.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '');
const load = async (file, prefix = '') => import('data:text/javascript;base64,' + Buffer.from(prefix + source(file)).toString('base64'));

(async () => {
  // ---- trace helper --------------------------------------------------------------------------------------------
  const { createVoiceTrace, STAGES } = await load('static/js/voiceTrace.js');
  let clock = 1000; const lines = [];
  const voice = createVoiceTrace({ now: () => clock, log: line => lines.push(line), label: 'call' });
  const t = voice.begin(1000);                    // the user stopped talking at t=1000
  clock = 1040; voice.mark(t, 'endpoint');
  clock = 1050; voice.mark(t, 'upload_sent');
  clock = 1450; voice.mark(t, 'transcript_back');
  clock = 1452; voice.mark(t, 'turn_started');
  clock = 1900; voice.mark(t, 'first_token');
  clock = 1950; voice.mark(t, 'first_sentence');
  clock = 2000; voice.sentenceStart(t);           // first sound
  clock = 2800; voice.sentenceStart(t);           // second sentence
  clock = 3300; voice.sentenceStart(t);
  clock = 9999; assert.equal(voice.mark(t, 'first_token'), false, 'a stage keeps the time it FIRST happened');
  assert.equal(voice.mark(t, 'bogus'), false, 'unknown stages are ignored');
  assert.equal(voice.mark(null, 'endpoint'), false, 'no trace, no mark');
  assert.deepEqual(voice.offsets(t), { speech_end: 0, endpoint: 40, upload_sent: 50, transcript_back: 450, turn_started: 452, first_token: 900, first_sentence: 950, first_audio: 1000, sentence_start: [1000, 1800, 2300] });
  assert.deepEqual(voice.spans(t), { endpoint: 40, upload_sent: 10, transcript_back: 400, turn_started: 2, first_token: 448, first_sentence: 50, first_audio: 50, sentence_gaps: [800, 500] });
  assert.equal(voice.format(t), 'endpoint 40 ms / upload 10 ms / speech-to-text 400 ms / dispatch 2 ms / first token 448 ms / first sentence 50 ms / first audio 50 ms / later sentences +800, +500 ms');
  voice.report(t);
  assert.equal(lines.length, 1); assert.match(lines[0], /^\[call-trace\] turn=1 \{"speech_end":0,/);
  const u = voice.begin(); assert.equal(u.id, 2); clock = 5000; voice.mark(u, 'turn_started'); clock = 5300; voice.mark(u, 'first_token');
  assert.deepEqual(voice.offsets(u), { turn_started: 0, first_token: 300 }, 'without a speech end the earliest mark is the base');
  assert.deepEqual(voice.offsets(null), {}); assert.equal(voice.format(null), '');
  for (let i = 0; i < 30; i++) voice.begin();
  assert.equal(voice.turns.length, 20, 'only the last 20 turns are kept in memory'); assert.equal(voice.last.id, 32);
  assert.ok(STAGES.includes('first_audio'));

  // ---- chunker -------------------------------------------------------------------------------------------------
  const { _chunk, createChunker } = await load('static/js/voiceOutput.js');
  assert.deepEqual(_chunk('First one. Second one. Third one. Fourth one.'), ['First one.', 'Second one.', 'Third one.', 'Fourth one.'], 'every sentence is its own chunk');
  // No hold-back: sentence 2 goes the moment sentence 3 starts, and a flushed sentence goes without the next one.
  const out = []; const chunker = createChunker(s => out.push(s));
  chunker.feed('One is here. Two is ');
  assert.deepEqual(out, ['One is here.'], 'the first sentence goes alone');
  chunker.feed('here too. Th');
  assert.deepEqual(out, ['One is here.', 'Two is here too.'], 'sentence 2 is released when its boundary arrives, not when sentence 3 completes');
  chunker.feed('ree is here.'); chunker.flushSentence();
  assert.deepEqual(out, ['One is here.', 'Two is here too.', 'Three is here.'], 'a flushed sentence needs no successor');
  // First-clause release: only the first chunk, only at >= 6 words, only at a clause mark.
  assert.deepEqual(_chunk('Well, I think we should probably go ahead, and then do the rest, as planned.'), ['Well, I think we should probably go ahead,', 'and then do the rest, as planned.'],
    'the first chunk ends at the first comma that follows at least six words');
  assert.deepEqual(_chunk('Sure, I can do that right now, no problem.'), ['Sure, I can do that right now,', 'no problem.'], 'a short lead-in comma does not split');
  assert.deepEqual(_chunk('Yes, that works. Then another long clause here, with more words after it, and more.'), ['Yes, that works.', 'Then another long clause here, with more words after it, and more.'],
    'later sentences are never cut at a comma');
  assert.deepEqual(_chunk('Okay, fine; but we need to be careful here, since it matters.'), ['Okay, fine; but we need to be careful here,', 'since it matters.']);
  assert.deepEqual(_chunk('That is a good plan to follow — and I will start right away.'), ['That is a good plan to follow', 'and I will start right away.'], 'a dash releases the first clause');
  assert.deepEqual(_chunk('The total is 1,000 or 2,500 dollars all together, maybe.'), ['The total is 1,000 or 2,500 dollars all together,', 'maybe.'], 'a comma inside a number is not a clause mark');
  const clauseStream = []; const streamed = createChunker(s => clauseStream.push(s));
  for (const piece of ['Well, I think we ', 'should probably go', ' ahead, and', ' then more.']) streamed.feed(piece);
  assert.deepEqual(clauseStream, ['Well, I think we should probably go ahead,'], 'the clause is released as soon as its comma and the space after it arrive');
  // Abbreviations and decimals.
  assert.deepEqual(_chunk('Dr. Smith will see you now. Mr. Jones left. Prof. Lee agrees.'), ['Dr. Smith will see you now.', 'Mr. Jones left.', 'Prof. Lee agrees.'], 'titles do not end a sentence');
  assert.deepEqual(_chunk('See the U.S. Army page. It costs 3.5 dollars. Version v1.10.0 shipped.'), ['See the U.S. Army page.', 'It costs 3.5 dollars.', 'Version v1.10.0 shipped.'], 'initialisms, decimals and versions stay whole');
  assert.deepEqual(_chunk('Use a tool, e.g. This one. And i.e. That one.'), ['Use a tool, e.g. This one.', 'And i.e. That one.']);
  assert.deepEqual(_chunk('Is it ready? Yes! Good. Moving on.'), ['Is it ready?', 'Yes!', 'Good.', 'Moving on.']);
  const held = []; const digits = createChunker(s => held.push(s));
  digits.feed('I have 3.'); digits.flushSentence();
  assert.deepEqual(held, [], 'a digit and full stop waits in case it is 3.5');
  digits.feed('5 apples. '); assert.deepEqual(held, [], 'the decimal completes without a split'); digits.finish();
  assert.deepEqual(held, ['I have 3.5 apples.']);
  const titled = []; const title = createChunker(s => titled.push(s));
  title.feed('Thanks, Dr.'); title.flushSentence(); assert.deepEqual(titled, [], 'a flush after a title waits');
  title.finish(); assert.deepEqual(titled, ['Thanks, Dr.']);
  const first = []; const resettable = createChunker(s => first.push(s));
  resettable.feed('One two three four five six, seven. '); resettable.reset(); resettable.feed('Alpha beta gamma delta epsilon zeta, eta.'); resettable.finish();
  assert.equal(first.at(-2), 'Alpha beta gamma delta epsilon zeta,', 'reset restores the first-clause release for the next turn');

  // ---- call speaker: prefetch, order, cancellation ----------------------------------------------------------------
  const created = [];  // every scheduled source, in start order
  class FakeContext {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData(array) { array.fill(0); } }; }
    createBuffer(channels, length, rate) { const data = new Float32Array(length); return { length, duration: length / rate, getChannelData: () => data }; }
    createBufferSource() { const node = { buffer: null, connect() {}, start(at) { node.at = at; created.push(node); }, stop() { node.stopped = true; }, onended: null }; return node; }
    async resume() {} close() {}
  }
  global.AudioContext = FakeContext; global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
  const requests = [];
  global.fetch = async (path, options) => {
    const entry = { body: JSON.parse(options.body), aborted: false };
    entry.stream = new ReadableStream({ start(controller) {
      entry.controller = controller;
      options.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch {} });
    } });
    entry.send = item => { try { entry.controller.enqueue(new TextEncoder().encode(JSON.stringify(item) + '\n')); } catch { /* a cancelled turn's late chunk */ } };
    // length is the sentence number * 2400 samples (0.1 s at 24 kHz) so a node says whose audio it is
    entry.audio = (n, chunks = 1) => { for (let i = 0; i < chunks; i++) entry.send({ audio: Buffer.alloc(n * 2400 * 2 / chunks).toString('base64') }); };
    entry.finish = () => { entry.send({ done: true }); try { entry.controller.close(); } catch { /* already aborted */ } };
    requests.push(entry);
    return new Response(entry.stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  const vo = await load('static/js/voiceOutput.js'), tr = await load('static/js/callTransport.js', 'const api=async()=>({});');
  globalThis.__vo = vo; globalThis.__tr = tr; globalThis.__api = { api: async () => ({}), el: () => ({}) };
  const callVoice = await load('static/js/callVoice.js', 'const {api,el}=globalThis.__api;const {createChunker,_forSpeech}=globalThis.__vo;const {readEvents}=globalThis.__tr;\n');
  const make = () => {
    const events = []; created.length = 0; requests.length = 0;
    const speaker = callVoice.neuralSpeaker({ onStart: () => events.push('start'), onEnd: () => events.push('end'), onError: e => events.push('error:' + e),
      onSentenceReady: i => events.push('ready' + i), onSentenceStart: i => events.push('sentence' + i) }, () => ({ model: 'm', voice: 'v' }));
    return { speaker, events };
  };
  const rates = request => request.send({ sample_rate: 24000 });
  const lengths = () => created.map(node => node.buffer.length / 2400);

  // Order with prefetch: all three renders are requested up front; audio plays strictly in sentence order.
  {
    const { speaker, events } = make();
    await speaker.prepare(); speaker.reset();
    speaker.feed('One here. Two here. Three here.'); speaker.finish(); await tick();
    assert.equal(requests.length, 3, 'sentence 2 and 3 are fetched while sentence 1 has not started playing');
    assert.deepEqual(requests.map(r => r.body.text), ['One here.', 'Two here.', 'Three here.']);
    assert.deepEqual(events.filter(e => e.startsWith('ready')), ['ready0', 'ready1', 'ready2']);
    requests.forEach(rates);
    requests[1].audio(2); requests[1].finish(); await tick();
    assert.equal(created.length, 0, 'sentence 2 finished first but is held until sentence 1 has played its audio in');
    requests[0].audio(1, 2); await tick();
    assert.deepEqual(lengths(), [0.5, 0.5].map(x => x), 'sentence 1 starts as soon as its first packet arrives (streams in two packets)');
    requests[0].finish(); await tick();
    assert.deepEqual(lengths(), [0.5, 0.5, 2], 'the buffered sentence 2 drops in right behind sentence 1');
    assert.ok(Math.abs(created[2].at - (created[1].at + created[1].buffer.duration)) < 1e-9,'sentence 2 is scheduled back to back with sentence 1, no gap');
    requests[2].audio(3); requests[2].finish(); await tick();
    assert.deepEqual(lengths(), [0.5, 0.5, 2, 3], 'sentence 3 plays last');
    assert.ok(created[3].at >= created[2].at + created[2].buffer.duration - 1e-9, 'timeline is monotonic');
    await wait(450);
    assert.deepEqual(events.filter(e => e.startsWith('sentence') || e === 'start'), ['sentence0', 'start', 'sentence1', 'sentence2'],
      'the first sentence start and first sound are reported, then each later sentence start');
    assert.equal(events.filter(e => e === 'end').length, 0, 'not ended while audio is still scheduled');
    created.forEach(node => node.onended?.());
    assert.equal(events.filter(e => e === 'end').length, 1, 'ends once, after the last source');
    assert.equal(events.filter(e => e.startsWith('error')).length, 0);
    speaker.dispose();
  }

  // The look-ahead is bounded: the fourth sentence is requested only after the first is done.
  {
    const { speaker } = make();
    await speaker.prepare(); speaker.reset();
    speaker.feed('One. Two. Three. Four. Five.'); speaker.finish(); await tick();
    assert.equal(requests.length, 3, 'at most three renders are in flight');
    requests[0].send({ sample_rate: 24000 }); requests[0].audio(1); requests[0].finish(); await tick();
    assert.equal(requests.length, 4, 'finishing a sentence opens the next request');
    speaker.dispose();
  }

  // Cancellation mid-prefetch: everything in flight aborts, buffered audio never plays, nothing settles a newer turn.
  {
    const { speaker, events } = make();
    await speaker.prepare(); speaker.reset();
    speaker.feed('One. Two. Three.'); speaker.finish(); await tick();
    requests.forEach(rates); requests[1].audio(2); await tick();
    assert.equal(created.length, 0);
    speaker.cancel(); await tick();
    assert.ok(requests.every(r => r.aborted), 'every in-flight and prefetched request is aborted');
    requests[0].audio(1); requests[2].audio(3); await tick();
    assert.equal(created.length, 0, 'late chunks from the cancelled turn cannot start playback');
    await wait(30);
    assert.deepEqual(events.filter(e => e === 'end' || e === 'start' || e.startsWith('error')), [], 'a cancelled turn reports no start, end or error');
    // The next turn works, and a late chunk from the old one still cannot leak into it.
    speaker.reset(); const old = requests.length;
    speaker.feed('Next one.'); speaker.finish(); await tick();
    assert.equal(requests.length, old + 1);
    requests.at(-1).send({ sample_rate: 24000 }); requests.at(-1).audio(5); requests.at(-1).finish(); await tick();
    assert.deepEqual(lengths(), [5], 'only the new turn is heard');
    created.forEach(node => node.onended?.());
    assert.equal(events.filter(e => e === 'end').length, 1);
    speaker.dispose();
  }

  // Cancelling while the head sentence is playing and the next is already fully buffered.
  {
    const { speaker, events } = make();
    await speaker.prepare(); speaker.reset();
    speaker.feed('One. Two.'); speaker.finish(); await tick();
    requests.forEach(rates); requests[0].audio(1); await tick(); requests[1].audio(2); requests[1].finish(); await tick();
    assert.deepEqual(lengths(), [1]);
    speaker.cancel(); requests[0].audio(1); requests[0].finish(); await tick();
    assert.deepEqual(lengths(), [1], 'sentence 2 is dropped with the cancelled turn');
    assert.ok(created[0].stopped, 'the playing source is stopped');
    await wait(30); assert.equal(events.filter(e => e === 'end').length, 0);
    speaker.dispose();
  }

  // A failed sentence reports once and the rest still play in order.
  {
    const { speaker, events } = make();
    await speaker.prepare(); speaker.reset();
    speaker.feed('One. Two.'); speaker.finish(); await tick();
    requests[0].send({ error: 'engine down' }); await tick();
    requests[1].send({ sample_rate: 24000 }); requests[1].audio(2); requests[1].finish(); await tick();
    assert.deepEqual(events.filter(e => e.startsWith('error')), ['error:engine down']);
    assert.deepEqual(lengths(), [2], 'the next sentence is not blocked by the failed one');
    speaker.dispose();
  }

  // ---- call transport push channel ----------------------------------------------------------------------------------
  {
    const pushed = []; const opened = [];
    global.window = { addEventListener() {}, removeEventListener() {} }; global.navigator = { sendBeacon() {} };
    global.fetch = async (path, options) => {
      opened.push(path);
      if (!path.endsWith('/watch')) throw new Error('unexpected ' + path);
      const entry = {};
      entry.stream = new ReadableStream({ start(c) { entry.controller = c; options.signal?.addEventListener('abort', () => { try { c.close(); } catch {} }); } });
      entry.send = item => entry.controller.enqueue(new TextEncoder().encode(JSON.stringify(item) + '\n'));
      transportEntry = entry;
      return new Response(entry.stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
    let transportEntry;
    globalThis.__transportApi = async () => ({ id: 'c'.repeat(32), jobs: [], ended: false });
    const mod = await import('data:text/javascript;base64,' + Buffer.from('const api=globalThis.__transportApi;\n' + source('static/js/callTransport.js')).toString('base64'));
    const transport = mod.callTransport({ ensureSession: async () => 's1', agentId: () => 'a1' }, () => {}, event => pushed.push(event));
    await transport.start({ id: 'a1' }, 'e1', 'm1'); await tick(); await tick();
    assert.deepEqual(opened, ['/api/agent-calls/' + 'c'.repeat(32) + '/watch'], 'the call opens its push channel when it starts');
    transportEntry.send({ type: 'ready' }); transportEntry.send({ type: 'work', task_id: 't1', status: 'done' }); await tick();
    assert.deepEqual(pushed, [{ type: 'ready' }, { type: 'work', task_id: 't1', status: 'done' }], 'a pushed finish reaches the call immediately, with no poll interval');
    transport.dispose(); await tick();
    const count = opened.length; await wait(30);
    assert.equal(opened.length, count, 'ending the call closes the channel and stops reconnecting');
  }

  console.log('Voice latency trace, chunker, prefetching speaker and push channel: passed');
})().catch(error => { console.error(error); process.exit(1); });
