// Voice latency work (Fluid Voice build order steps 1 and 2, no new models): the per-turn trace helper, the sentence
// chunker (no hold-back, first-clause release, abbreviations/decimals), the call speaker's prefetching queue
// (order, cancellation mid-prefetch, look-ahead limit), the call transport's push channel and the rolling transcript
// (partials, commit, reuse / tail finals, fallback, the slow-engine gate) against a scripted fake recognizer, and
// Open Mic on the call pipeline (step 6): worklet capture at its 900 ms endpoint, barge-in, held text, rolling partials,
// the prefetching neural speaker, the loudness fallback.
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
  assert.deepEqual(_chunk('It arrives Nov. 12 at the latest. Then Dec. 3 for the rest.'), ['It arrives Nov. 12 at the latest.', 'Then Dec. 3 for the rest.'], 'a short month name does not end a sentence');
  assert.deepEqual(_chunk('She lives on Elm Ave. near the park. Mx. Lee too.'), ['She lives on Elm Ave. near the park.', 'Mx. Lee too.']);
  assert.deepEqual(_chunk('No. I do not think so.'), ['No.', 'I do not think so.'], 'a reply that starts with "No." is not held back');
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
  const callVoice = await load('static/js/callVoice.js', 'const {api,el}=globalThis.__api;const {createChunker,createSpeaker,_forSpeech}=globalThis.__vo;const {readEvents}=globalThis.__tr;\n');
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

  // ---- rolling transcript (build order step 4) --------------------------------------------------------------------
  // A scripted fake recognizer stands in for whisper: 12 words, one per 500 ms, cut into segments every 3 s (the way
  // whisper cuts at a pause). A window is just a Float32Array whose samples carry their absolute position, so the fake
  // knows what audio it was given. `rtf` models recognition time as a real-time factor of the audio it is handed.
  {
    const { createPartialTranscriber, PARTIAL_MAX_RTF } = await load('static/js/partialTranscript.js');
    const rate = 16, words = Array.from({ length: 12 }, (_, i) => `w${i}`), SEG = 3000;
    const clip = ms => Float32Array.from({ length: ms * rate }, (_, i) => (i + 1) / 1e7);        // absolute sample index in the value
    const startOf = pcm => (Math.round(pcm[0] * 1e7) - 1) / rate, lengthMs = pcm => pcm.length / rate;
    const transcribe = pcm => {                      // what the fake recognizer says about [start, start + length)
      const a = startOf(pcm), b = a + lengthMs(pcm), parts = [];
      for (let i = 0; i < words.length; i++) { const s0 = i * 500, s1 = s0 + 500; if (s0 >= a && s1 <= b) parts.push({ i, s0, s1 }); }
      const segs = [];
      for (const p of parts) { const at = Math.floor(p.s0 / SEG); (segs[at] ||= { text: [], end_ms: 0 }); segs[at].text.push(words[p.i]); segs[at].end_ms = p.s1 - a; }
      const list = segs.filter(Boolean).map(g => ({ text: g.text.join(' '), end_ms: g.end_ms }));
      return { text: list.map(g => g.text).join(' '), segments: list };
    };
    const harness = (options = {}) => {
      const log = { sent: [], finals: [], captions: [] };
      const rtf = options.rtf ?? .1;
      const send = async (pcm, signal) => {
        log.sent.push({ from: startOf(pcm), ms: lengthMs(pcm) });
        if (options.fail) { const e = new Error('down'); if (options.status) e.status = options.status; throw e; }
        if (options.busy) return { busy: true, text: '' };
        if (options.hold) await options.hold(signal);
        return { ...transcribe(pcm), timings: { recognition_ms: lengthMs(pcm) * rtf } };
      };
      const sendFinal = async pcm => { log.finals.push({ from: startOf(pcm), ms: lengthMs(pcm) }); return transcribe(pcm).text; };
      const partials = createPartialTranscriber({ send, encode: pcm => pcm, onText: text => log.captions.push(text), ...(options.maxRtf ? { maxRtf: options.maxRtf } : {}) });
      return { partials, log, sendFinal };
    };
    // Stream `totalMs` of speech into a session as the recorder does: 1 s chunks, then the pause flush; returns the clip.
    const speak = async (partials, totalMs, pauseExtra = 300, chunkMs = 1000, deliverMs = totalMs) => {
      partials.begin(); let at = 0;     // deliverMs < totalMs: the recorder had not yet handed out the last words when the turn ended
      while (at < deliverMs) { const n = Math.min(chunkMs, deliverMs - at); partials.push(clip(at + n).subarray(at * rate)); at += n; await tick(); await tick(); }
      if (pauseExtra) { partials.push(clip(at + pauseExtra).subarray(at * rate)); await tick(); await tick(); }
      return { speechMs: totalMs, pcm: clip(totalMs + 160) };            // the segment: voiced audio plus the 160 ms trailing keep
    };

    // 1. A 6 s utterance. Partials caption it as it goes; two agreeing runs commit the first segment; the end of the turn is
    //    the last partial itself (it saw all the voiced audio at the pause), so nothing is uploaded at all.
    {
      const { partials, log, sendFinal } = harness();
      const { pcm } = await speak(partials, 6000);
      assert.ok(log.captions.length >= 4, 'the caption grows as the user talks');
      assert.equal(log.captions[0], 'w0 w1');
      assert.equal(log.captions.at(-1), 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11', 'the last caption is the whole sentence');
      assert.ok(log.sent.some(entry => entry.from === 3000), 'once the first segment is stable the window moves past it (later partials start at 3 s)');
      assert.ok(log.sent.filter(entry => entry.from === 3000).every(entry => entry.ms <= 3600), 'and stays short, so a long sentence does not get slower to follow');
      const done = await partials.take().finalize(pcm, sendFinal);
      assert.deepEqual(done, { text: 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11', mode: 'reuse' });
      assert.equal(log.finals.length, 0, 'reuse sends nothing at the end of the turn');
    }
    // 2. No pause flush before the endpoint: the last partial misses the final words, so only the TAIL after the committed text is sent.
    {
      const { partials, log, sendFinal } = harness();
      const { pcm } = await speak(partials, 6000, 0, 1000, 5000);
      const done = await partials.take().finalize(pcm, sendFinal);
      assert.equal(done.mode, 'tail');
      assert.equal(done.text, 'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11', 'committed text plus the tail is the complete sentence');
      assert.equal(log.finals.length, 1);
      assert.equal(log.finals[0].from, 3000, 'the final pass starts at the committed boundary');
      assert.ok(log.finals[0].ms < pcm.length / rate / 2 + 200, `only ${log.finals[0].ms} ms of the ${pcm.length / rate} ms clip are sent`);
    }
    // 3. A short utterance has no committed text and no flush: nothing to reuse, so the caller sends the whole clip as before.
    {
      const { partials, log, sendFinal } = harness();
      const { pcm } = await speak(partials, 2000, 0, 1000, 1000);
      assert.equal(await partials.take().finalize(pcm, sendFinal), null, 'null means: send the whole clip');
      assert.equal(log.finals.length, 0);
    }
    // 4. A partial still running at the end of the turn: one that covers the voiced audio is waited for, an older one is dropped.
    {
      let release;
      const { partials, sendFinal } = harness({ hold: () => new Promise(resolve => { release = resolve; }) });
      partials.begin(); partials.push(clip(1000)); await tick();
      const pcm = clip(1000 + 160);
      const outcome = partials.take().finalize(pcm, sendFinal); await tick();
      release();
      assert.deepEqual(await outcome, { text: 'w0 w1', mode: 'reuse' }, 'the in-flight run already covers every voiced sample, so its answer is the final one');
      const second = harness({ hold: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
      second.partials.begin(); second.partials.push(clip(1000)); await tick();
      const late = await second.partials.take().finalize(clip(3000), second.sendFinal);
      assert.equal(late, null, 'an in-flight run that covers less than the clip is aborted and the whole clip goes instead');
    }
    // 5. Failure falls back cleanly: the utterance goes whole-clip; three in a row switch it off for the call; a 404 at once.
    {
      const bad = harness({ fail: true });
      const { pcm } = await speak(bad.partials, 3000);
      assert.equal(await bad.partials.take().finalize(pcm, bad.sendFinal), null, 'a failed partial means the whole clip is sent');
      assert.equal(bad.log.finals.length, 0);
      for (let i = 0; i < 3; i++) { await speak(bad.partials, 1500, 0); bad.partials.take(); }
      assert.equal(bad.partials.state.disabled, 'unavailable', 'repeated failures stop rolling transcription for the call');
      const sentBefore = bad.log.sent.length; await speak(bad.partials, 3000); assert.equal(bad.log.sent.length, sentBefore, 'and no more requests are made');
      bad.partials.reset(); assert.equal(bad.partials.state.disabled, '', 'a new call starts clean');
      const old = harness({ fail: true, status: 404 }); await speak(old.partials, 1500, 0);
      assert.equal(old.partials.state.disabled, 'unavailable', 'a server without the endpoint is never asked again');
      const busy = harness({ busy: true }); const result = await speak(busy.partials, 3000);
      assert.equal(await busy.partials.take().finalize(result.pcm, busy.sendFinal), null, 'a busy engine answer is skipped, not an error');
      assert.equal(busy.partials.state.failures, 0);
    }
    // 6. A recognizer slower than PARTIAL_MAX_RTF (CPU Small) would only fight the real pass for the engine: rolling turns itself off.
    {
      const slow = harness({ rtf: 1.0 }); await speak(slow.partials, 4000);
      assert.equal(slow.partials.state.disabled, 'slow', `real-time factor 1.0 is above ${PARTIAL_MAX_RTF}`);
      const fast = harness({ rtf: .1 }); await speak(fast.partials, 4000);
      assert.equal(fast.partials.state.disabled, '', 'a GPU-speed recognizer keeps rolling');
    }
    // 6b. The in-process CPU engine is off by default (disable('cpu')), and so is a GPU server that falls back to CPU mid-call.
    {
      const cpu = harness(); cpu.partials.disable('cpu'); await speak(cpu.partials, 3000);
      assert.equal(cpu.log.sent.length, 0, 'a CPU call never sends a rolling request');
      const drop = harness(); const original = drop.partials; original.begin();
      const custom = createPartialTranscriber({ send: async pcm => ({ ...transcribe(pcm), engine: 'cpu' }), encode: pcm => pcm });
      custom.begin(); custom.push(clip(1000)); await tick(); await tick(); custom.push(clip(2000).subarray(1000 * rate)); await tick(); await tick();
      assert.equal(custom.state.disabled, 'cpu', 'a reply that says the engine fell back to CPU turns rolling off');
    }
    // 7. A new utterance drops the old session: no request from it can land in the next one's caption.
    {
      let release; const { partials, log } = harness({ hold: () => new Promise(resolve => { release = resolve; }) });
      partials.begin(); partials.push(clip(1000)); await tick();
      partials.begin(); release(); await tick(); await tick();
      assert.deepEqual(log.captions, [], 'a cancelled session never captions');
    }

    // ---- measured with the fake recognizer: what the end-of-turn pass costs, whole clip vs rolling --------------
    // Recognition time = audio length x real-time factor. CPU Small is ~1.0 (the one committed figure, core/speech.py);
    // a CUDA whisper server is assumed ~0.1 (NOT measured on this machine: no GPU runtime or model is installed here).
    // The pause-flush partial starts ~300 ms into the silence and the endpoint fires at 700 ms, so a reused answer is free
    // only for the part of its run that fits in that 400 ms; any more is waited for. The CPU rows show the gate: at
    // factor 1.0 rolling switches itself off (above PARTIAL_MAX_RTF), so the turn costs exactly what it did before.
    const table = [];
    for (const [engine, factor] of [['cpu small', 1.0], ['cuda', .1], ['cuda (slower, 0.25)', .25]]) for (const seconds of [2, 4, 6]) {
      const ms = seconds * 1000, whole = ms * factor;
      const { partials, log, sendFinal } = harness({ rtf: factor });
      const { pcm } = await speak(partials, ms, 300);
      const disabled = partials.state.disabled;
      const rolled = disabled ? null : await partials.take().finalize(pcm, sendFinal);
      const last = log.sent.at(-1), wait = rolled ? (rolled.mode === 'reuse' ? Math.max(0, last.ms * factor - 400) : log.finals.at(-1).ms * factor) : whole;
      table.push(`${engine} ${seconds} s: whole clip ${Math.round(whole)} ms -> ${disabled ? `rolling off (${disabled}), whole clip` : rolled ? `${rolled.mode} ${Math.round(wait)} ms` : 'whole clip'}${rolled ? ` (saves ${Math.round(whole - wait)} ms)` : ''}`);
    }
    console.log('Final-pass recognition cost (fake recognizer, scripted words):\n  ' + table.join('\n  '));
  }


  // ---- Open Mic on the call pipeline (build order step 6) ---------------------------------------------------------------
  // The real openMic.js, with the browser pieces behind it faked: the call recorder (driven by calling its callbacks, the
  // way the worklet does), speech recognition (scripted), the chat turn and, for most cases, the voice.
  {
    const pt = await load('static/js/partialTranscript.js', 'const encodeWav = pcm => pcm;\n');
    const vt = await load('static/js/voiceTrace.js');
    const vf = await load('static/js/voiceFiller.js');
    const bc = await load('static/js/backchannel.js');
    const deps = { filler: async () => null, transcribe: async () => '', partial: async () => ({ text: '', segments: [] }), status: async () => ({}), api: async () => ({}) };
    const calls = { transcribe: [], partial: [], api: [] };
    globalThis.__omDeps = {
      createRecorder: () => { throw new Error('the loudness recorder is not expected here'); },
      createCallRecorder: () => { throw new Error('the real call recorder is not expected here'); },
      isCallRecordingSupported: () => true, isSpeechOutputSupported: () => true,
      transcribeBlob: async (blob, options) => { calls.transcribe.push({ blob, options }); return deps.transcribe(blob, options); },
      transcribePartial: async (wav, options) => { calls.partial.push(options); return deps.partial(wav, options); },
      getSpeechStatus: () => deps.status(),
      api: async (path, options) => { calls.api.push({ path, body: JSON.parse(options?.body || '{}') }); return deps.api(path, options); },
      createPartialTranscriber: pt.createPartialTranscriber, createVoiceSpeaker: callVoice.createVoiceSpeaker, createVoiceTrace: vt.createVoiceTrace,
      createFillerGate: vf.createFillerGate, fetchFillerClip: (...args) => deps.filler(...args), isBackchannel: bc.isBackchannel, endsInQuestion: bc.endsInQuestion,
    };
    const om = await load('static/js/openMic.js', 'const {createRecorder,createCallRecorder,isCallRecordingSupported,isSpeechOutputSupported,transcribeBlob,transcribePartial,getSpeechStatus,api,createPartialTranscriber,createVoiceSpeaker,createVoiceTrace,createFillerGate,fetchFillerClip,isBackchannel,endsInQuestion}=globalThis.__omDeps;\n');
    const reset = () => { calls.transcribe.length = calls.partial.length = calls.api.length = 0; deps.transcribe = async () => ''; deps.partial = async () => ({ text: '', segments: [] }); deps.status = async () => ({}); deps.api = async () => ({}); deps.filler = async () => null; };
    const quiet = Float32Array.from({ length: 16000 }, () => .01);       // a clip: 1 s of 16 kHz samples
    const harness = (options = {}) => {
      const h = { sent: [], log: [], states: [], errors: [], enabled: [], closed: 0, speaker: null, finishTurn: null, turns: 0 };
      h.factory = opts => { h.cap = opts; return { async start() { if (options.startError) throw options.startError; }, setEnabled(on, barge) { h.enabled.push([on, barge]); }, close() { h.closed++; } }; };
      h.noted = [];
      h.makeSpeaker = opts => { h.speakerOptions = opts; h.speaker = { feeds: [], resets: 0, cancels: 0, finishes: 0, played: [], fillers: [], pauses: 0, resumes: 0,
        heard() { return this.played.slice(); }, pause() { this.pauses++; }, resume() { this.resumes++; }, filler(clip) { this.fillers.push(clip); },
        feed(t) { this.feeds.push(t); }, finish() { this.finishes++; }, reset() { this.resets++; }, cancel() { this.cancels++; } }; return h.speaker; };
      h.mic = om.createOpenMic({ sessionId: 's1', onState: s => h.states.push(s), onError: e => h.errors.push(e), stopTurn: id => h.log.push('stop:' + id), noteHeard: (id, heard) => h.noted.push([id, heard]),
        createCapture: options.noCapture ? undefined : h.factory, createMic: options.createMic, makeSpeaker: options.realSpeaker ? undefined : h.makeSpeaker,
        sendMessage: (text, handlers) => { h.sent.push(text); h.turns++; h.emit = () => handlers.onChunk('Hello there. '); if (!options.slowStart) h.emit(); return new Promise(resolve => { h.finishTurn = () => { handlers.onDone(); resolve('done'); }; }); } });
      h.segment = (ms, endpoint = 900) => h.cap.onSegment({ wav: ms }, { endpoint_ms: endpoint, audio_ms: ms }, Float32Array.from({ length: 16 * ms + 2560 }, () => .01));
      h.say = (ms = 1000, endpoint = 900) => { h.cap.onSpeechStart(); h.cap.onChunk(Float32Array.from({ length: 16 * ms }, () => .01), false); h.segment(ms, endpoint); };
      return h;
    };

    // 1. Worklet capture at Open Mic's own endpoint; one clip -> one chat turn spoken as it streams; the mic watches for barge-in while thinking and speaking.
    {
      reset(); const h = harness(); deps.transcribe = async () => 'what time is it';
      assert.equal(await h.mic.start(), true); await tick();
      assert.equal(h.mic.capture, 'worklet', 'with a worklet-capable browser Open Mic uses the call recorder');
      assert.equal(h.cap.silenceMs, 900, 'and keeps its 900 ms end-of-speech wait through the recorder option'); assert.equal(h.cap.mode, 'automatic');
      assert.equal(h.mic.state, 'listening'); assert.deepEqual(h.enabled.at(-1), [true, false], 'listening: the recorder is segmenting, not in barge mode');
      assert.equal(calls.api.length, 0, 'no speech runtime registered: nothing is prepared, nothing changes for the default recognizer');
      h.say(); await wait(5);
      assert.deepEqual(h.sent, ['what time is it']);
      assert.equal(calls.transcribe.length, 1); assert.deepEqual(calls.transcribe[0].options, { pcm: true }, 'the clip is already a 16 kHz WAV: no decode, and the default model as before');
      assert.deepEqual(h.states, ['listening', 'transcribing', 'thinking']);
      assert.deepEqual(h.speaker.feeds, ['Hello there. '], 'the chat reply streams into the speaker as it arrives'); assert.equal(h.speaker.resets, 1);
      assert.deepEqual(h.enabled.at(-1), [true, true], 'while the reply is thinking the microphone stays open in barge mode');
      h.speakerOptions.onStart(); assert.equal(h.mic.state, 'speaking'); assert.deepEqual(h.enabled.at(-1), [true, true]);
      const offsets = h.mic.latency.offsets(h.mic.latency.last);
      for (const stage of ['speech_end', 'endpoint', 'upload_sent', 'transcript_back', 'turn_started', 'first_token']) assert.ok(Number.isFinite(offsets[stage]), 'trace has ' + stage);
      // Reply done and spoken: back to listening and out of barge mode.
      h.finishTurn(); assert.equal(h.speaker.finishes, 1); h.speakerOptions.onEnd(); await tick();
      assert.equal(h.mic.state, 'listening'); assert.deepEqual(h.enabled.at(-1), [true, false], 'listening again after the reply');
      h.mic.stop(); assert.equal(h.closed, 1, 'stop closes the recorder'); assert.equal(h.mic.state, 'idle');
    }

    // 2. Barge-in: the user's voice over the reply cuts the voice and the turn, and the interruption becomes the next turn.
    {
      reset(); const h = harness(); let said = 'first thing'; deps.transcribe = async () => said;
      await h.mic.start(); h.say(); await wait(5); h.speakerOptions.onStart(); assert.equal(h.mic.state, 'speaking');
      h.cap.onBargeIn(); h.cap.onSpeechStart();
      assert.equal(h.speaker.cancels, 1, 'the voice is cut'); assert.deepEqual(h.log, ['stop:s1'], 'and so is the chat turn');
      assert.equal(h.mic.state, 'listening'); assert.deepEqual(h.enabled.at(-1), [true, false], 'the recorder goes back to segmenting; the worklet already holds the start of the interruption');
      said = 'actually never mind'; h.segment(1200); await wait(5);
      assert.deepEqual(h.sent, ['first thing', 'actually never mind'], 'the interruption goes out as the next turn');
      assert.equal(h.speaker.resets, 2, 'the speaker latch is cleared for the new reply');
      // A barge-in with nothing to interrupt (listening) is ignored.
      h.finishTurn(); h.speakerOptions.onEnd(); await tick(); const cancels = h.speaker.cancels; h.cap.onBargeIn(); assert.equal(h.speaker.cancels, cancels);
      h.mic.stop();
    }

    // 2b. Interruption memory, nods and the pause: what was heard goes to the chat's model, a nod is not a turn, and the voice
    //     is paused at the first sign of the user's voice and handed back if it was only a nod.
    {
      reset(); const h = harness(); let said = 'tell me a story'; deps.transcribe = async () => said;
      await h.mic.start(); h.say(); await wait(5); h.speakerOptions.onStart(); h.speaker.played = ['Once upon a time.'];
      h.cap.onBargeDuck(); assert.equal(h.speaker.pauses, 1, 'the voice pauses Kairos at once'); h.cap.onBargeClear(); assert.equal(h.speaker.resumes, 1, 'and a nod gives the voice back');
      h.cap.onBargeIn(); h.cap.onSpeechStart();
      assert.deepEqual(h.noted, [['s1', ['Once upon a time.']]], 'the sentences that had begun to play are reported when the user takes the floor');
      said = 'yeah, right'; h.segment(700); await wait(5);
      assert.deepEqual(h.sent, ['tell me a story'], 'a nod said over the reply is not sent as a turn'); assert.equal(h.mic.nods, 1); assert.equal(h.mic.state, 'listening');
      said = 'actually stop'; h.cap.onSpeechStart(); h.segment(900); await wait(5);
      assert.deepEqual(h.sent, ['tell me a story', 'actually stop'], 'anything else is a turn, even after a nod'); assert.equal(h.mic.nods, 1);
      // "Yes" after Kairos asked a question is the answer, not a nod.
      h.speaker.played = ['Do you want the detail?']; h.cap.onBargeIn(); h.cap.onSpeechStart(); said = 'yeah'; h.segment(500); await wait(5);
      assert.deepEqual(h.sent.at(-1), 'yeah'); h.mic.stop();
    }

    // 2c. Instant acknowledgement: after half a second with no sentence ready a clip plays; a quick answer never hears one.
    {
      reset(); const h = harness({ slowStart: true }); deps.transcribe = async () => 'what is the capital of france'; const asked = [];
      deps.filler = async ({ last, text }) => { asked.push([last, text]); return { id: 'okay', text: 'Okay.' }; };
      await h.mic.start(); h.say(); await wait(5);
      assert.equal(h.speaker.fillers.length, 0, 'nothing before the half second'); await wait(560);
      assert.deepEqual(h.speaker.fillers, [{ id: 'okay', text: 'Okay.' }], 'a slow answer gets its acknowledgement'); assert.deepEqual(asked, [[null, 'what is the capital of france']]);
      h.emit(); h.finishTurn(); h.speakerOptions.onEnd(); await tick(); h.say(); await wait(5); h.emit(); await wait(560);
      assert.equal(h.speaker.fillers.length, 1, 'the second answer started within the half second: no acknowledgement'); assert.equal(asked.at(-1)[0], 'okay', 'the last phrase is passed so it is not repeated');
      h.mic.stop();
    }

    // 3. A pause that outlasts the endpoint but not the thought is ONE turn; noise and empty transcripts send nothing.
    {
      reset(); const h = harness(); const texts = ['I was thinking', 'about the budget']; let release; deps.transcribe = () => new Promise(resolve => { release = () => resolve(texts.shift()); });
      await h.mic.start(); h.say(); await wait(5); assert.equal(h.mic.state, 'transcribing');
      h.say(); await wait(5);                                  // the user carries on while the first clip is still being recognized
      release(); await wait(5); release(); await wait(5);
      assert.deepEqual(h.sent, ['I was thinking about the budget'], 'both clips are joined into a single turn');
      h.mic.stop();
      reset(); const noisy = harness(); await noisy.mic.start();
      noisy.cap.onSpeechStart(); noisy.cap.onSegment(null, { endpoint_ms: 900 }, null); await wait(5);
      assert.deepEqual(noisy.sent, []); assert.equal(calls.transcribe.length, 0, 'a click or cough (no segment audio) is never recognized'); assert.equal(noisy.mic.state, 'listening');
      deps.transcribe = async () => '   '; noisy.say(); await wait(5);
      assert.deepEqual(noisy.sent, [], 'an empty transcript sends nothing'); assert.equal(noisy.mic.state, 'listening'); assert.deepEqual(noisy.errors, []);
      deps.transcribe = async () => { throw new Error('engine busy'); }; noisy.say(); await wait(5);
      assert.deepEqual(noisy.errors, ['engine busy']); assert.equal(noisy.mic.state, 'listening', 'a recognition failure is reported and the loop recovers');
      noisy.mic.stop();
    }

    // 4. Rolling partial transcription where the warm GPU recognizer is registered: the final transcript is ready at the endpoint.
    {
      reset(); const h = harness();
      deps.status = async () => ({ acceleration: { configured: true }, call_model: 'small.en', models: [{ name: 'small.en', downloaded: true }] });
      deps.api = async () => ({ engine: 'cuda', prepare_ms: 40 });
      deps.partial = async () => ({ text: 'hello there', segments: [{ text: 'hello there', end_ms: 1100 }], timings: { recognition_ms: 80 }, engine: 'cuda' });
      deps.transcribe = async () => { throw new Error('the whole clip should not be needed'); };
      await h.mic.start(); await wait(5);
      assert.deepEqual(calls.api, [{ path: '/api/speech/prepare', body: { model: 'small.en', backend: 'auto' } }], 'the call model is prepared on the warm GPU server');
      assert.deepEqual(h.mic.recognition, { model: 'small.en', backend: 'auto', partials: 'on' });
      h.cap.onSpeechStart(); h.cap.onChunk(Float32Array.from({ length: 19200 }, () => .01), true); await wait(5);
      assert.equal(calls.partial.length, 1); assert.deepEqual([calls.partial[0].model, calls.partial[0].backend], ['small.en', 'auto'], 'a partial is requested while the user is still talking');
      h.cap.onSegment({ wav: 1 }, { endpoint_ms: 900 }, Float32Array.from({ length: 19200 + 2560 }, () => .01)); await wait(5);
      assert.deepEqual(h.sent, ['hello there'], 'the partial that covers the speech IS the transcript');
      assert.equal(calls.transcribe.length, 0, 'no upload and no recognition run at the end of the turn');
      h.mic.stop();
      // A CPU engine, a missing model or no registered runtime: partials stay off and the default recognizer is untouched.
      for (const [status, prepared] of [[{ acceleration: { configured: true }, call_model: 'small.en', models: [{ name: 'small.en', downloaded: true }] }, { engine: 'cpu' }],
        [{ acceleration: { configured: true }, call_model: 'small.en', models: [{ name: 'small.en', downloaded: false }] }, { engine: 'cuda' }], [{ acceleration: { configured: false } }, { engine: 'cuda' }]]) {
        reset(); const g = harness(); deps.status = async () => status; deps.api = async () => prepared; deps.transcribe = async () => 'whole clip';
        await g.mic.start(); await wait(5);
        assert.deepEqual(g.mic.recognition, { partials: 'cpu' }); g.cap.onSpeechStart(); g.cap.onChunk(Float32Array.from({ length: 19200 }, () => .01), true); g.segment(1000); await wait(5);
        assert.equal(calls.partial.length, 0, 'no partial requests'); assert.deepEqual(g.sent, ['whole clip']); assert.deepEqual(calls.transcribe[0].options, { pcm: true });
        g.mic.stop();
      }
    }

    // 5. Capture fallbacks.
    {
      reset(); const denied = harness({ startError: Object.assign(new Error('no'), { name: 'NotAllowedError' }) });
      assert.equal(await denied.mic.start(), false); assert.deepEqual(denied.errors, ['Microphone access was blocked. Allow it to use Open Mic.']); assert.equal(denied.mic.state, 'idle');
      // A worklet that cannot start (no 16 kHz context, module failed) drops to the loudness recorder instead of failing.
      const events = []; const level = harness({ startError: new Error('This browser cannot capture call audio at 16 kHz.'),
        createMic: () => ({ async start() { events.push('level-start'); }, capture() {}, async stop() { return { size: 4 }; }, close() { events.push('level-close'); }, cancel() {} }) });
      assert.equal(await level.mic.start(), true); assert.equal(level.mic.capture, 'level', 'falls back to the loudness recorder'); assert.deepEqual(events, ['level-start']); assert.deepEqual(level.errors, []);
      level.mic.stop();
      // The loudness recorder by itself (the injection the older suites use) selects the loudness path.
      const only = harness({ noCapture: true, createMic: () => ({ async start() {}, capture() {}, async stop() { return { size: 4 }; }, close() {}, cancel() {} }) });
      await only.mic.start(); assert.equal(only.mic.capture, 'level'); only.mic.stop();
    }

    // 6. The real call speaker: a chosen neural voice prefetches the sentences of the reply; the OS voice otherwise.
    {
      reset(); const streams = [];
      global.fetch = async (path, options) => {
        const entry = { path, body: JSON.parse(options.body), aborted: false };
        entry.stream = new ReadableStream({ start(controller) { entry.controller = controller;
          options.signal?.addEventListener('abort', () => { entry.aborted = true; try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch {} }); } });
        streams.push(entry); return new Response(entry.stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
      };
      const store = new Map(); global.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) };
      store.set('kairos:neural-voice:openmic', JSON.stringify({ provider: 'neural', model: 'kokoro', voice: 'af_heart' }));
      let reply = 'One here. Two here. Three here.';
      const real = harness({ realSpeaker: true }); const mic = om.createOpenMic({ sessionId: 's1', stopTurn: () => {}, onState: s => real.states.push(s), onError: e => real.errors.push(e),
        createCapture: real.factory, sendMessage: (text, handlers) => { handlers.onChunk(reply); return new Promise(() => {}); } });
      deps.transcribe = async () => 'tell me three things';
      await mic.start(); real.cap.onSpeechStart(); real.cap.onSegment({ wav: 1 }, { endpoint_ms: 900 }, quiet); await wait(30);
      assert.deepEqual(streams.map(r => r.body), [{ text: 'One here.', model: 'kokoro', voice: 'af_heart' }, { text: 'Two here.', model: 'kokoro', voice: 'af_heart' }],
        'the reply is cut into sentences as it streams, and every complete sentence is requested at once, ahead of playback');
      await wait(150); assert.equal(streams.length, 3, 'the last sentence follows its 100 ms flush, before the turn has ended');
      assert.equal(mic.state, 'thinking');
      // The user talks over it: every in-flight render is aborted.
      real.cap.onBargeIn(); assert.ok(streams.every(r => r.aborted), 'barge-in aborts every queued and prefetching render'); assert.equal(mic.state, 'listening');
      mic.stop();
      // No neural voice chosen: the OS voice speaks.
      store.set('kairos:neural-voice:openmic', JSON.stringify({ provider: 'device' }));
      const spoken = []; global.window.speechSynthesis = { speak: u => spoken.push(u.text), cancel() {}, getVoices: () => [], pending: false, speaking: false, addEventListener() {} };
      global.SpeechSynthesisUtterance = global.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } addEventListener() {} };
      streams.length = 0; reply = 'Plain voice. Second line.';
      const os = harness({ realSpeaker: true }); const micB = om.createOpenMic({ sessionId: 's1', stopTurn: () => {}, onState() {}, onError() {},
        createCapture: os.factory, sendMessage: (text, handlers) => { handlers.onChunk(reply); return new Promise(() => {}); } });
      await micB.start(); os.cap.onSpeechStart(); os.cap.onSegment({ wav: 1 }, { endpoint_ms: 900 }, quiet); await wait(150);
      assert.deepEqual(spoken, ['Plain voice.', 'Second line.'], 'with no neural voice chosen the OS voice speaks the sentences'); assert.equal(streams.length, 0);
      micB.stop(); delete global.window.speechSynthesis; delete global.window.SpeechSynthesisUtterance; delete global.SpeechSynthesisUtterance;
    }
  }

  console.log('Voice latency trace, chunker, prefetching speaker, push channel, rolling transcript and Open Mic on the call pipeline: passed');
})().catch(error => { console.error(error); process.exit(1); });
