// g2 (A22): Open Mic state machine edge cases, spoken replies, and the denied-microphone state; Open Mic on the call pipeline
// (worklet capture, 900 ms endpoint, barge-in, held speech, rolling partials, loudness fallback).
// Runs after g2-chat-checks.cjs in the same page (it reuses window.__g2's fetch/microphone stubs).
const assert = require('node:assert/strict');

module.exports = async ({ js, win, waitFor, capture, delay, navigate, writes }) => {
  const toast = text => `[...document.querySelectorAll('.toast')].some(t => t.textContent.includes(${JSON.stringify(text)}))`;
  const g = expr => js(`window.__g2.${expr}`);
  const om = expr => js(`window.__g2.om.${expr}`);
  const synth = expr => js(`window.__synth.${expr}`);
  const bugs = [];   // known app defects: recorded, reported together at the end so the rest of the suite still runs
  const soft = (fn) => { try { fn(); } catch (error) { bugs.push(String(error.message).split(/\r?\n/)[0]); } };

  // ---- 6. Open Mic state machine: the cases a real room produces -------------------------
  // The real openMic.js with an injected microphone and voice (its documented test seam), driven by levels.
  await js(`(async () => {
    const m = await import('/static/js/openMic.js');
    const g = window.__g2; g.om = { log: [], captured: 0, stopped: 0, closed: 0, sent: [], errors: [], states: [], cancelled: 0, resets: 0, spoken: [] };
    const wavBlob = () => new Blob([new Uint8Array(4000)], { type: 'audio/wav' });
    g.omMake = (opts = {}) => m.createOpenMic({ sessionId: 's1',
      sendMessage: opts.send || ((text, h) => { g.om.sent.push(text); h.onChunk('Reply one. Reply two.'); h.onDone(); return Promise.resolve('done'); }),
      stopTurn: () => g.om.log.push('stopTurn'),
      onState: s => g.om.states.push(s), onError: e => g.om.errors.push(e),
      createMic: () => ({ async start() { if (opts.denied) throw new DOMException('no', 'NotAllowedError'); if (opts.nodevice) throw new Error('none'); },
        capture() { g.om.captured++; }, async stop() { g.om.stopped++; return wavBlob(); }, close() { g.om.closed++; }, cancel() { g.om.closed++; } }),
      makeSpeaker: () => { let c = false; return { feed(t) { if (!c) g.om.spoken.push(t); }, finish() {}, reset() { c = false; g.om.resets++; }, cancel() { c = true; g.om.cancelled++; } }; } });
    g.omReset = () => { Object.assign(g.om, { log: [], captured: 0, stopped: 0, closed: 0, sent: [], errors: [], states: [], cancelled: 0, resets: 0, spoken: [] }); };
    return true; })()`);
  // A real WAV is needed by transcribeBlob's decoder.
  await js(`(() => { const rate = 16000, n = 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
    window.__g2.realWav = new Blob([buf], { type: 'audio/wav' }); return true; })()`);
  // Make the injected recorder hand back the real WAV.
  await js(`(async () => { const m = await import('/static/js/openMic.js'); const g = window.__g2;
    g.omMake = (opts = {}) => m.createOpenMic({ sessionId: 's1',
      sendMessage: opts.send || ((text, h) => { g.om.sent.push(text); h.onChunk('Reply one. Reply two.'); h.onDone(); return Promise.resolve('done'); }),
      stopTurn: () => g.om.log.push('stopTurn'), onState: s => g.om.states.push(s), onError: e => g.om.errors.push(e),
      createMic: () => ({ async start() { if (opts.denied) throw new DOMException('no', 'NotAllowedError'); if (opts.nodevice) throw new Error('none'); },
        capture() { g.om.captured++; }, async stop() { g.om.stopped++; return g.realWav; }, close() { g.om.closed++; }, cancel() { g.om.closed++; } }),
      makeSpeaker: () => { let c = false; return { feed(t) { if (!c) g.om.spoken.push(t); }, finish() {}, reset() { c = false; g.om.resets++; }, cancel() { c = true; g.om.cancelled++; } }; } });
    return true; })()`);
  const speak = async () => { await js("window.__mic._level(0.5)"); await delay(420); await js("window.__mic._level(0.5)"); await delay(950); await js("window.__mic._level(0.01)"); };
  await js("window.__g2.omReset(); window.__g2.transcribes.length = 0; window.__mic = window.__g2.omMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");
  // Too-short noise (a door, a cough) is dropped: never transcribed or sent.
  await js("window.__mic._level(0.5)");
  await delay(950);
  await js("window.__mic._level(0.01)");
  await waitFor("window.__g2.om.stopped === 1");
  await delay(150);
  const noiseTranscribed = await g('transcribes.length'), noiseSent = await om('sent');
  soft(() => assert.equal(noiseTranscribed, 0, 'BUG A22-2: a short noise (door, cough) is dropped, never transcribed (openMic.js MIN_UTTERANCE_MS branch is unreachable)'));
  await js("window.__mic.stop(); window.__g2.transcribes.length = 0; window.__g2.omReset(); window.__mic = window.__g2.omMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");

  // One real utterance: listen, transcribe, send once, speak the reply.
  await js("window.__g2.transcript = 'what time is it'; window.__g2.omReset(); true");
  await speak();
  await waitFor("window.__g2.om.sent.length === 1");
  assert.deepEqual(await om('sent'), ['what time is it'], 'listen -> transcribe -> send, once');
  assert.deepEqual(await om('spoken'), ['Reply one. Reply two.'], 'the reply streams to the speaker');
  assert.equal(await g('transcribes.length'), 1, 'one transcription for one utterance');
  // Latency trace (build order step 1): the turn is stamped from the end of speech to the first token, in order, in memory.
  const openMicTrace = await js("(() => { const t = window.__mic.latency.last; return t ? window.__mic.latency.offsets(t) : null; })()");
  assert.ok(openMicTrace, 'Open Mic keeps a trace of the turn');
  for (const stage of ['speech_end', 'endpoint', 'upload_sent', 'transcript_back', 'turn_started', 'first_token']) assert.ok(Number.isFinite(openMicTrace[stage]), `Open Mic trace records ${stage}`);
  assert.ok(openMicTrace.speech_end === 0 && openMicTrace.endpoint >= 800 && openMicTrace.endpoint <= openMicTrace.upload_sent && openMicTrace.upload_sent <= openMicTrace.transcript_back && openMicTrace.transcript_back <= openMicTrace.turn_started && openMicTrace.turn_started <= openMicTrace.first_token,
    `Open Mic trace stages are in turn order, with the 900 ms silence wait counted (${JSON.stringify(openMicTrace)})`);
  // Sound between the speech level and the barge level while the assistant talks is NOT captured
  // (the microphone hearing the assistant must not become the next utterance).
  const capturedAfterTurn = await om('captured');
  for (const v of [0.15, 0.18, 0.2, 0.15, 0.18, 0.2]) await js(`window.__mic._level(${v})`);
  assert.equal(await om('captured'), capturedAfterTurn, 'sound below the barge level never starts a second utterance while the assistant answers');
  assert.ok(!(await om('log')).includes('stopTurn'), 'and does not interrupt the reply');
  await js("window.__mic.stop(); true");
  assert.equal(await js("window.__mic.state"), 'idle');
  assert.ok((await om('closed')) >= 1, 'stop closes the microphone');
  // Silence / empty transcript: back to listening, nothing sent, no error.
  await js("window.__g2.transcript = ''; window.__g2.omReset(); window.__mic = window.__g2.omMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");
  await speak();
  await waitFor("window.__g2.om.states.includes('transcribing')");
  await waitFor("window.__mic.state === 'listening'");
  assert.deepEqual(await om('sent'), [], 'an empty transcript sends nothing');
  assert.deepEqual(await om('errors'), [], 'and says nothing');
  // Transcription failure: error reaches the user and the loop recovers.
  await js("window.__g2.transcribeError = 'engine busy'; window.__g2.omReset(); true");
  await speak();
  await waitFor("window.__g2.om.errors.length === 1 && window.__mic.state === 'listening'");
  assert.deepEqual(await om('errors'), ['engine busy']);
  assert.deepEqual(await om('sent'), []);
  // A turn that cannot be sent reports and recovers.
  await js("window.__g2.transcribeError = null; window.__g2.transcript = 'try this'; window.__g2.omReset(); window.__mic.stop(); window.__mic = window.__g2.omMake({ send: () => Promise.reject(new Error('Provider is down')) }); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");
  await speak();
  await waitFor("window.__g2.om.errors.length === 1");
  assert.deepEqual(await om('errors'), ['Provider is down']);
  await waitFor("window.__mic.state === 'listening'");
  // The 45 s ceiling ends a stuck utterance by itself (clock advanced, not waited out).
  await js("window.__g2.omReset(); window.__g2.transcript = 'long one'; window.__mic.stop(); window.__mic = window.__g2.omMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");
  await js("window.__mic._level(0.5)");
  await js("window.__realNow = Date.now; Date.now = () => window.__realNow() + 50000; true");
  try { await waitFor("window.__g2.om.sent.length === 1", 6000); } finally { await js("Date.now = window.__realNow; true"); }
  assert.deepEqual(await om('sent'), ['long one'], 'an utterance past the 45 s ceiling is cut and sent');
  await js("window.__mic.stop(); true");
  // Microphone failures at start: honest message, nothing left open.
  for (const [opts, text] of [[{ denied: true }, 'Microphone access was blocked. Allow it to use Open Mic.'], [{ nodevice: true }, 'No microphone is available.']]) {
    await js(`window.__g2.omReset(); window.__mic = window.__g2.omMake(${JSON.stringify(opts)}); window.__mic.start()`);
    await waitFor("window.__g2.om.errors.length >= 1");
    assert.equal((await om('errors'))[0], text);
    assert.equal(await js("window.__mic.state"), 'idle', 'a failed start is not "listening"');
  }
  // No speech synthesis: honest note, and it still listens.
  await js("window.__speechSynth = Object.getOwnPropertyDescriptor(window, 'speechSynthesis'); delete window.speechSynthesis; window.__g2.omReset(); window.__mic = window.__g2.omMake(); window.__mic.start()");
  await waitFor("window.__g2.om.errors.length === 1");
  assert.deepEqual(await om('errors'), ['This browser cannot speak replies aloud. Open Mic will still listen and reply in text.']);
  await waitFor("window.__mic.state === 'listening'");
  await js("window.__mic.stop(); if (window.__speechSynth) Object.defineProperty(window, 'speechSynthesis', window.__speechSynth); true");


  // ---- 6b. Open Mic on the call pipeline (Fluid Voice build order step 6) ---------------------------------------------
  // The real openMic.js, real recognition upload and real rolling-transcript module; only the browser's recorder is injected
  // here (the worklet cannot hear a test room). The next block runs the real worklet on a synthetic tone.
  await js(`(async () => {
    const m = await import('/static/js/openMic.js'); const g = window.__g2;
    g.cap = { options: null, enabled: [], closed: 0, sent: [], states: [], errors: [], stops: 0, resets: 0, cancels: 0, spoken: [], speakerOptions: null };
    g.capReset = () => { const c = g.cap; c.enabled = []; c.closed = 0; c.sent = []; c.states = []; c.errors = []; c.stops = 0; c.resets = 0; c.cancels = 0; c.spoken = []; };
    g.capMake = (opts = {}) => m.createOpenMic({ sessionId: 's1',
      sendMessage: opts.send || ((text, h) => { g.cap.sent.push(text); h.onChunk('Reply one. Reply two.'); h.onDone(); return Promise.resolve('done'); }),
      stopTurn: () => { g.cap.stops++; }, onState: s => g.cap.states.push(s), onError: e => g.cap.errors.push(e),
      createCapture: options => { g.cap.options = options; return { async start() {}, setEnabled(on, barge) { g.cap.enabled.push([on, barge]); }, close() { g.cap.closed++; } }; },
      makeSpeaker: options => { g.cap.speakerOptions = options; let cancelled = false; return { feed(t) { if (!cancelled) g.cap.spoken.push(t); }, finish() {}, reset() { cancelled = false; g.cap.resets++; }, cancel() { cancelled = true; g.cap.cancels++; } }; } });
    g.capSegment = (ms = 1000, endpoint = 900) => g.cap.options.onSegment(g.realWav, { endpoint_ms: endpoint, audio_ms: ms }, new Float32Array(16 * ms));
    return true; })()`);
  await js("window.__g2.capReset(); window.__g2.transcribes.length = 0; window.__g2.transcript = 'what time is it'; window.__mic = window.__g2.capMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'");
  const cap = expr => js(`window.__g2.cap.${expr}`);
  assert.equal(await js("window.__mic.capture"), 'worklet', 'Open Mic captures through the call recorder');
  assert.equal(await cap('options.silenceMs'), 900, 'and keeps its 900 ms end-of-speech wait');
  assert.deepEqual(await cap('enabled.at(-1)'), [true, false], 'listening: segmenting, not in barge mode');
  await js("window.__g2.cap.options.onSpeechStart(); window.__g2.capSegment()");
  await waitFor("window.__g2.cap.sent.length === 1");
  assert.deepEqual(await cap('sent'), ['what time is it'], 'the worklet segment is recognized and sent as an ordinary turn');
  assert.deepEqual(await cap('spoken'), ['Reply one. Reply two.'], 'the reply streams to the speaker');
  assert.equal(await g('transcribes.length'), 1, 'one upload for one utterance');
  assert.equal(await g('transcribes[0].name'), 'speech.wav', 'the PCM clip goes up as it is (no decode of a codec stream)');
  const workletTrace = await js("(() => { const t = window.__mic.latency.last; return window.__mic.latency.offsets(t); })()");
  for (const stage of ['speech_end', 'endpoint', 'upload_sent', 'transcript_back', 'turn_started', 'first_token']) assert.ok(Number.isFinite(workletTrace[stage]), `worklet trace records ${stage}`);
  // Thinking and speaking keep the microphone open in barge mode; the user's voice over the reply cuts voice and turn.
  assert.deepEqual(await cap('enabled.at(-1)'), [true, true], 'the microphone watches for barge-in while the reply is thinking');
  await js("window.__g2.cap.speakerOptions.onStart()");
  assert.equal(await js("window.__mic.state"), 'speaking');
  await js("window.__g2.cap.options.onBargeIn(); window.__g2.cap.options.onSpeechStart()");
  assert.equal(await cap('cancels'), 1, 'barge-in silences the voice'); assert.equal(await cap('stops'), 1, 'and stops the chat turn');
  assert.equal(await js("window.__mic.state"), 'listening'); assert.deepEqual(await cap('enabled.at(-1)'), [true, false]);
  await js("window.__g2.transcript = 'wait, something else'; window.__g2.capSegment(1200)");
  await waitFor("window.__g2.cap.sent.length === 2");
  assert.equal((await cap('sent'))[1], 'wait, something else', 'the interruption is the next turn');
  assert.ok((await cap('resets')) >= 2 && (await cap('spoken')).length === 2, 'and the reply after an interruption is still spoken');
  // Two pieces of one thought (a pause past the endpoint) go out as one turn.
  await js(`(() => { const g = window.__g2; g.joinN = 0; g.joinInner = window.fetch;
    window.fetch = async (input, init = {}) => { const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname === '/api/speech/transcribe' && (init.method || 'GET').toUpperCase() === 'POST') { const n = ++g.joinN; g.transcribes.push({ bytes: 1, name: 'speech.wav' }); await new Promise(r => setTimeout(r, 250));
        return new Response(JSON.stringify({ text: ['first part', 'second part'][n - 1] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
      return g.joinInner(input, init); };
    g.capReset(); g.transcribes.length = 0; g.cap.speakerOptions.onEnd(); return true; })()`);
  await waitFor("window.__mic.state === 'listening'");
  await js("window.__g2.cap.options.onSpeechStart(); window.__g2.capSegment()");
  await waitFor("window.__mic.state === 'transcribing'");
  await js("window.__g2.cap.options.onSpeechStart(); window.__g2.capSegment()");
  await waitFor("window.__g2.cap.sent.length === 1");
  assert.deepEqual(await cap('sent'), ['first part second part'], 'speech that continues while the first clip is recognized joins into one turn');
  await js("window.fetch = window.__g2.joinInner; window.__mic.stop(); true");

  // Rolling partial transcription: used when a GPU runtime is registered; the final transcript then needs no upload.
  await js(`(() => { const g = window.__g2; g.partialCalls = []; g.prepareCalls = [];
    g.inner = window.fetch;
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href); const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/speech/prepare') { g.prepareCalls.push(JSON.parse(init.body)); return json({ engine: 'cuda', prepare_ms: 20 }); }
      if (url.pathname === '/api/speech/partial') { g.partialCalls.push({ model: init.body.get('model'), backend: init.body.get('backend') });
        return json({ text: 'rolling words', segments: [{ text: 'rolling words', end_ms: 1100 }], timings: { recognition_ms: 50 }, engine: 'cuda' }); }
      return g.inner(input, init);
    };
    g.speech = { engine_available: true, active_model: 'base.en', call_model: 'small.en', acceleration: { supported: true, configured: true }, models: [{ name: 'small.en', downloaded: true }] };
    return true; })()`);
  await js("(async () => { (await import('/static/js/voiceInput.js')).refreshSpeechStatus(); return true; })()");
  await js("window.__g2.capReset(); window.__g2.transcribes.length = 0; window.__mic = window.__g2.capMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening' && window.__g2.prepareCalls.length === 1");
  assert.deepEqual(await g('prepareCalls[0]'), { model: 'small.en', backend: 'auto' }, 'the call model is prepared on the GPU recognizer');
  await waitFor("window.__mic.recognition.partials === 'on'");
  await js("window.__g2.cap.options.onSpeechStart(); window.__g2.cap.options.onChunk(new Float32Array(19200), true); true");
  await waitFor("window.__g2.partialCalls.length === 1");
  assert.deepEqual(await g('partialCalls[0]'), { model: 'small.en', backend: 'auto' }, 'a partial transcript is requested while the user is still talking');
  await js("window.__g2.cap.options.onSegment(window.__g2.realWav, { endpoint_ms: 900, audio_ms: 1360 }, new Float32Array(19200 + 2560)); true");
  await waitFor("window.__g2.cap.sent.length === 1");
  assert.deepEqual(await cap('sent'), ['rolling words'], 'the partial that covers the speech is the transcript');
  assert.equal(await g('transcribes.length'), 0, 'with nothing uploaded at the end of the turn');
  await js("window.__mic.stop(); window.fetch = window.__g2.inner; window.__g2.speech = { engine_available: true, active_model: 'base.en', models: [] }; true");
  // Without a registered runtime nothing is prepared and the default recognizer is used exactly as before.
  await js("(async () => { (await import('/static/js/voiceInput.js')).refreshSpeechStatus(); return true; })()");
  await js("window.__g2.prepareCalls.length = 0; window.__g2.transcribes.length = 0; window.__g2.capReset(); window.__g2.transcript = 'plain'; window.__mic = window.__g2.capMake(); window.__mic.start()");
  await waitFor("window.__mic.state === 'listening'"); await delay(150);
  assert.equal(await g('prepareCalls.length'), 0); assert.deepEqual(await js("window.__mic.recognition"), { partials: 'cpu' });
  await js("window.__g2.cap.options.onSpeechStart(); window.__g2.capSegment()");
  await waitFor("window.__g2.cap.sent.length === 1"); assert.equal(await g('transcribes.length'), 1);
  await js("window.__mic.stop(); true");

  // The real worklet on a synthetic tone: real capture, real 900 ms endpoint, real barge-in, nothing injected but the chat turn and voice.
  const workletOk = await js(`(async () => {
    const g = window.__g2, m = await import('/static/js/openMic.js');
    const ac = new AudioContext({ sampleRate: 16000 }); await Promise.race([ac.resume(), new Promise(r => setTimeout(r, 1500))]);
    if (ac.state !== 'running') return false;
    const osc = ac.createOscillator(), gain = ac.createGain(), dest = ac.createMediaStreamDestination();
    osc.frequency.value = 220; gain.gain.value = 0; osc.connect(gain); gain.connect(dest); osc.start();
    g.toneCtx = ac; g.tone = gain; g.gumBefore = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async constraints => { g.gum.push(constraints.audio); return dest.stream; };
    g.tn = { states: [], at: [], sent: [], stops: 0, errors: [], cancels: 0 };
    g.tnMic = m.createOpenMic({ sessionId: 's1',
      sendMessage: (text, h) => { g.tn.sent.push(text); h.onChunk('Reply. '); return new Promise(() => {}); },
      stopTurn: () => { g.tn.stops++; }, onState: s => { g.tn.states.push(s); g.tn.at.push(performance.now()); }, onError: e => g.tn.errors.push(e),
      makeSpeaker: () => ({ feed() {}, finish() {}, reset() {}, cancel() { g.tn.cancels++; } }) });
    return true; })()`);
  if (workletOk) {
    await js("window.__g2.transcribes.length = 0; window.__g2.transcript = 'tone words'; window.__g2.tnMic.start()");
    await waitFor("window.__g2.tnMic.state === 'listening'", 8000);
    assert.equal(await js("window.__g2.tnMic.capture"), 'worklet', 'by default the real call recorder is used');
    await js("window.__g2.tone.gain.value = 0.2; true"); await delay(700);
    const offAt = await js("(() => { window.__g2.tone.gain.value = 0; return performance.now(); })()");
    await waitFor("window.__g2.tn.states.includes('transcribing')", 5000);
    const endpointAfter = await js(`window.__g2.tn.at[window.__g2.tn.states.indexOf('transcribing')] - ${offAt}`);
    assert.ok(endpointAfter >= 800 && endpointAfter < 1600, `the worklet ends the utterance after Open Mic's 900 ms of silence (${Math.round(endpointAfter)} ms)`);
    await waitFor("window.__g2.tn.sent.length === 1", 5000);
    assert.deepEqual(await js("window.__g2.tn.sent"), ['tone words']); assert.equal(await js("window.__g2.transcribes.length"), 1);
    await waitFor("window.__g2.tnMic.state === 'thinking'");
    // Talking over the reply while it is "thinking": the real BargeIn hears the tone and interrupts.
    await delay(400);   // the barge detector spends its first 150 ms learning how much of the reply's own sound leaks back in
    await js("window.__g2.transcript = 'interrupting'; window.__g2.tone.gain.value = 0.2; true");
    try { await waitFor("window.__g2.tn.stops === 1", 5000); }
    catch (error) { throw new Error(error.message + ' ' + await js("JSON.stringify({ tn: window.__g2.tn, state: window.__g2.tnMic.state, ctx: window.__g2.toneCtx.state, gain: window.__g2.tone.gain.value })")); }
    assert.equal(await js("window.__g2.tn.cancels"), 1, 'the voice is cut by the user speaking over it');
    await delay(400); await js("window.__g2.tone.gain.value = 0; true");
    await waitFor("window.__g2.tn.sent.length === 2", 6000);
    assert.equal((await js("window.__g2.tn.sent"))[1], 'interrupting', 'and the interruption is heard whole and sent as the next turn');
    await js("window.__g2.tnMic.stop(); window.__g2.tone.gain.value = 0; true");
  } else {
    console.log('NOTE: the test page cannot start an audio context here; the real-worklet check was skipped.');
  }
  await js("(() => { const g = window.__g2; if (g.gumBefore) navigator.mediaDevices.getUserMedia = g.gumBefore; g.toneCtx?.close(); return true; })()");

  // Without AudioWorklet support Open Mic falls back to its loudness recorder and still works end to end.
  await js(`(async () => {
    const g = window.__g2, m = await import('/static/js/openMic.js');
    g.workletCtor = window.AudioWorkletNode; delete window.AudioWorkletNode;
    g.fb = { states: [], sent: [], errors: [] };
    g.fbMic = m.createOpenMic({ sessionId: 's1', sendMessage: (text, h) => { g.fb.sent.push(text); h.onChunk('Ok. '); h.onDone(); return Promise.resolve('done'); }, stopTurn() {},
      onState: s => g.fb.states.push(s), onError: e => g.fb.errors.push(e), makeSpeaker: () => ({ feed() {}, finish() {}, reset() {}, cancel() {} }) });
    g.fbMic.start(); return true; })()`);
  await waitFor("window.__g2.fbMic.state === 'listening'");
  assert.equal(await js("window.__g2.fbMic.capture"), 'level', 'no AudioWorklet: the loudness recorder is used');
  await js("window.__g2.transcript = 'fallback works'; window.__g2.fbMic._level(0.5)"); await delay(420);
  await js("window.__g2.fbMic._level(0.5)"); await delay(950); await js("window.__g2.fbMic._level(0.01)");
  await waitFor("window.__g2.fb.sent.length === 1", 6000);
  assert.deepEqual(await js("window.__g2.fb.sent"), ['fallback works']); assert.deepEqual(await js("window.__g2.fb.errors"), []);
  await js("window.__g2.fbMic.stop(); window.AudioWorkletNode = window.__g2.workletCtor; true");

  // ---- 7. Spoken replies: voice choice, queue end, stop, fallbacks ------------------------
  await js(`(async () => {
    const vo = await import('/static/js/voiceOutput.js');
    const synth = { spoken: [], queue: [], cancels: 0, pending: false, speaking: false,
      voices: [{ name: 'Local US', lang: 'en-US', localService: true }, { name: 'Net GB', lang: 'en-GB', localService: false }, { name: 'Microsoft George', lang: 'en-GB', localService: true }, { name: 'Local FR', lang: 'fr-FR', localService: true }],
      getVoices() { return this.voices; }, addEventListener() {},
      speak(u) { this.queue.push(u); this.pending = this.queue.length > 1; this.speaking = true; this.spoken.push({ text: u.text, voice: u.voice?.name, rate: u.rate, lang: u.lang }); },
      cancel() { this.cancels++; this.queue = []; this.speaking = false; this.pending = false; },
      finishNext() { const u = this.queue.shift(); this.speaking = this.queue.length > 0; this.pending = this.queue.length > 1; u.fire('end'); } };
    window.__synth = synth;
    window.__realUtt = window.SpeechSynthesisUtterance;
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.l = {}; } addEventListener(n, f) { this.l[n] = f; } fire(n, e = {}) { this.l[n]?.(e); } };
    window.__realSynth = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
    window.__vo = vo;
    return true; })()`);
  await js("window.__vo.setPreferredVoice(''); window.__ev = []; window.__sp = window.__vo.createSpeaker({ onStart: () => __ev.push('start'), onEnd: () => __ev.push('end'), onError: e => __ev.push('error:' + e) }); true");
  await js("__sp.feed('First sentence. Second one. Third one. Fourth one. '); __sp.finish(); true");
  assert.deepEqual(await synth('spoken.map(s => s.text)'), ['First sentence.', 'Second one.', 'Third one.', 'Fourth one.'], 'sentences are voiced in order, each released as soon as it is complete, nothing dropped');
  assert.equal(await synth('spoken[0].voice'), 'Microsoft George', 'the default prefers a local British male voice when one exists');
  assert.equal(await synth('spoken[0].rate'), 1.02);
  await js("__synth.queue[0].fire('start')");
  assert.deepEqual(await js("__ev"), ['start'], 'speaking starts once');
  await js("__synth.finishNext()");
  assert.deepEqual(await js("__ev"), ['start'], 'the end is reported only when the whole queue has drained, not per sentence');
  await js("__synth.finishNext(); __synth.finishNext(); __synth.finishNext()");
  assert.deepEqual(await js("__ev"), ['start', 'end'], 'one end, after the last sentence');
  // Voice choice persists, wins, and a vanished voice falls back instead of going silent.
  await js("__vo.setPreferredVoice('Local US'); window.__synth.spoken.length = 0; __sp.reset(); __sp.feed('Hello there. '); __sp.finish(); true");
  assert.equal(await synth('spoken[0].voice'), 'Local US', 'the chosen voice speaks');
  assert.equal(await js("localStorage.getItem('jarvis:speech-voice')"), 'Local US', 'the choice is saved on this device');
  await js("__vo.setPreferredVoice('Uninstalled'); window.__synth.spoken.length = 0; __sp.reset(); __sp.feed('Still audible. '); __sp.finish(); true");
  assert.equal(await synth('spoken[0].voice'), 'Microsoft George', 'a missing saved voice falls back to the default');
  // Stop: cancels the engine, reports the end once, stays silent until the next turn resets it.
  await js("__vo.setPreferredVoice(''); window.__ev.length = 0; window.__synth.queue.length = 0; window.__synth.spoken.length = 0; window.__synth.cancels = 0; __sp.reset(); __sp.feed('Talking now. More to say. '); __sp.finish(); __synth.queue[0].fire('start'); __sp.cancel(); true");
  assert.equal(await synth('cancels'), 1, 'stop cancels the speech engine');
  assert.deepEqual(await js("__ev"), ['start', 'end'], 'stopping while speaking reports the end exactly once');
  const voiced = await synth('spoken.length');
  await js("__sp.feed('Dropped after stop. '); __sp.finish(); true");
  assert.equal(await synth('spoken.length'), voiced, 'nothing more is voiced after a stop until reset');
  // A playback failure is reported.
  await js("__synth.queue.length = 0; __sp.reset(); __sp.feed('This will fail. '); __sp.finish(); __synth.queue.at(-1).fire('error', { error: 'synthesis-failed' }); true");
  assert.ok((await js("__ev")).includes('error:synthesis-failed'), 'a playback failure is reported');
  // No speech engine: the support check says so.
  await js("delete window.speechSynthesis; true");
  assert.equal(await js("__vo.isSpeechOutputSupported()"), false, 'a browser without speech synthesis is detected, not assumed');
  assert.deepEqual(await js("__vo.listVoices()"), [], 'and offers no voices');
  await js("Object.defineProperty(window, 'speechSynthesis', window.__realSynth); window.SpeechSynthesisUtterance = window.__realUtt; true");

  // ---- 8. A refused microphone must not leave Open Mic looking active ---------------------
  await js("(() => { const g = window.__g2; g.mic = 'denied'; g.gum.length = 0; return true; })()");
  await js("document.querySelectorAll('.toast').forEach(t => t.remove()); true");
  const omPostsBefore = writes.filter(w => /\/open-mic$/.test(w.path)).length;
  await js("document.querySelector('#chat-openmic').click()");
  await waitFor(toast('Microphone access was blocked. Allow it to use Open Mic.'));
  await delay(400);
  const stuck = await js("({ active: document.querySelector('#chat-openmic').classList.contains('active'), layout: document.querySelector('#chat-main').classList.contains('open-mic') })");
  const omPosts = writes.filter(w => /\/open-mic$/.test(w.path)).slice(omPostsBefore).map(w => JSON.parse(w.body).active);
  soft(() => assert.deepEqual(stuck, { active: false, layout: false }, 'BUG A22-1: after a denied microphone Open Mic must not stay shown as active'));
  soft(() => assert.deepEqual(omPosts, [true, false], 'BUG A22-1: after a denied microphone the session must be told Open Mic ended'));
  return bugs;   // known app defects found by this suite; the caller asserts them after the remaining modules have run
};
