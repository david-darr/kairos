// The Node half of scripts/bench_voice_turn.py: one spoken turn through the REAL browser-side modules, headless.
//
//   capture + endpoint   static/js/speechSegments.js SpeechSegments (the AudioWorklet's own class), fed 10 ms blocks of
//                        real speech audio at real-time pace, exactly as the worklet feeds it 128-sample blocks
//   rolling transcript   static/js/partialTranscript.js (the call's rolling partials and final pass)
//   chunker              static/js/voiceOutput.js createChunker (first clause / first sentence release, 100 ms flush)
//   acknowledgement      static/js/voiceFiller.js createFillerGate (the half-second rule)
//   barge-in             static/js/speechSegments.js BargeIn (pause after 120 ms of voice, interrupt after 320 ms)
//
// Speech-to-text and the voice are the Python side's (HTTP on loopback): whisper and the OS voice, or fakes in CI-light
// mode. The language model is a scripted stand-in that streams a reply at a fixed first-token delay and token rate
// (no cloud call). Everything after the endpoint is timed on this process's wall clock; the endpoint itself is timed
// in audio samples, so it is exact whatever the pace.
//
// usage: node bench_voice_harness.mjs <config.json>   -> prints one JSON document
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const strip = text => text.replace(/^import .*;\r?\n/gm, '');
const load = async (file, prefix = '') => import('data:text/javascript;base64,' + Buffer.from(prefix + strip(fs.readFileSync(path.join(root, file), 'utf8'))).toString('base64'));
const { SpeechSegments, BargeIn, BARGE_DUCK_MS, BARGE_VOICE_MS } = await load('static/js/speechSegments.js');
const { createChunker } = await load('static/js/voiceOutput.js');
const { createPartialTranscriber } = await load('static/js/partialTranscript.js');
const { createFillerGate } = await load('static/js/voiceFiller.js', 'const readEvents=null;\n');

const RATE = 16000;
const BLOCK = 160;                               // 10 ms
const LEAD_MS = 25;                              // the speaker schedules audio ~25 ms ahead of "now" (callVoice.js)
const now = () => performance.timeOrigin + performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

function readWav(file) {
  const bytes = fs.readFileSync(file);
  let at = 12;
  while (at < bytes.length - 8) {
    const id = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4);
    if (id === 'data') {
      const count = Math.floor(Math.min(size, bytes.length - at - 8) / 2), out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in ' + file);
}
function encodeWav(samples, rate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

// -- the Python side's services --------------------------------------------------------------------------------------
async function post(pathname, body, headers = {}) {
  const response = await fetch(cfg.service_url + pathname, { method: 'POST', body, headers });
  if (!response.ok) throw new Error(`${pathname} ${response.status}`);
  return response.json();
}
const sttFinal = (wav, name) => post('/stt/final', wav, { 'content-type': 'audio/wav', 'x-fixture': name });
const sttPartial = (wav, name) => post('/stt/partial', wav, { 'content-type': 'audio/wav', 'x-fixture': name });
const tts = async text => { const began = now(); const reply = await post('/tts', JSON.stringify({ text }), { 'content-type': 'application/json' }); reply.overhead_ms = Math.max(0, now() - began - reply.total_ms); return reply; };

// A seeded generator so a run is repeatable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// -- one spoken turn --------------------------------------------------------------------------------------------------
async function runTurn(fixture, repeat) {
  const random = rng(1000 + repeat * 7 + fixture.name.length);
  const pcm = readWav(fixture.wav);
  const speechEnd = fixture.speech_end_sample;
  const marks = { segments: 0, partialSent: 0 };
  let fed = 0, speechEndWall = 0;
  const transcripts = []; let dispatchedAt = 0, turnStart = 0;
  let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
  let inflightSegments = 0, speechActive = false, dispatched = false;
  const result = { fixture: fixture.name, repeat, audio_ms: Math.round(pcm.length / 16) };

  const partials = createPartialTranscriber({ send: async (wav) => { marks.partialSent++; return sttPartial(wav, fixture.name); }, encode: encodeWav });
  if (cfg.backend !== 'cuda' || !cfg.partials) partials.disable('cpu');
  // The filler gate: the real half-second rule. The clip is pre-rendered (a cached filler); playing it is a scheduled buffer.
  const fillerClip = cfg.filler_clip;
  const gate = createFillerGate({
    fetchClip: async () => fillerClip ? { id: 'okay', text: 'Okay.' } : null,
    blocked: () => speechActive,
    play: () => { result.filler_start_wall = now() + LEAD_MS; },
  });

  // Smart Turn is not installed on this machine, so "oracle" stands in for it: a perfect verdict (finished only if the speaker's
  // sentence really is over) after its measured ~12 ms CPU cost. The real hook is what runs: SpeechSegments asks at a 200 ms pause
  // and the answer comes back through answer(); with no model the call keeps its plain 700 ms silence wait.
  const segmenter = new SpeechSegments({
    onPause: cfg.smart_turn === 'oracle' ? (id) => setTimeout(() => segmenter.answer(id, fed >= speechEnd), cfg.smart_ms || 15) : null,
    rate: RATE, silenceMs: cfg.silence_ms || 700, chunkMs: 1000,
    onStart: () => { speechActive = true; partials.begin(); },
    onChunk: chunk => { if (speechActive) partials.push(chunk); },
    onSegment: (segment, timing) => {
      speechActive = false;
      const session = partials.take();
      if (!segment.length) { session?.cancel(); return; }
      marks.segments++; inflightSegments++;
      const firedWall = now();
      const endpointMs = Math.round((fed - speechEnd) / 16);          // audio samples, exact whatever the pace
      if (marks.segments === 1) { result.endpoint_ms = endpointMs; result.endpoint_wall = firedWall; }
      result.last_endpoint_ms = endpointMs; result.last_endpoint_wall = firedWall;
      (async () => {
        let text = '', mode = 'whole';
        try {
          if (session) {
            const rolled = await session.finalize(segment, async wav => (await sttFinal(wav, fixture.name)).text);
            if (rolled) { text = rolled.text; mode = rolled.mode; }
          }
          if (!text && mode === 'whole') text = (await sttFinal(encodeWav(segment, RATE), fixture.name)).text;
        } catch (error) { result.error = String(error); }
        transcripts.push(text.trim()); result.stt_mode = mode; result.partials_sent = marks.partialSent;
        inflightSegments--; result.transcript_wall = now();
        if (!speechActive && inflightSegments === 0 && !dispatched) { dispatched = true; dispatch(); }
      })();
    },
  });

  // The model: a scripted reply, first token after a jittered delay, then a steady token rate.
  async function dispatch() {
    dispatchedAt = now(); result.transcript = transcripts.join(' ').trim();
    const ttft = Math.max(20, cfg.ttft_ms * (0.85 + 0.3 * random()));
    gate.arm({ text: result.transcript });
    const chunker = createChunker(async sentence => {
      const readyAt = now();
      if (result.first_sentence_wall == null) {
        result.first_sentence_wall = readyAt; gate.sentenceReady();
        const asked = now();
        const spoken = await tts(sentence);
        result.first_audio_wall = asked + spoken.overhead_ms + spoken.first_write_ms + LEAD_MS;
        result.tts_first_write_ms = spoken.first_write_ms; result.tts_audio_ms = spoken.audio_ms; result.tts_audio = spoken.audio;
        resolveDone();
      }
    });
    await sleep(ttft);
    result.first_token_wall = now(); gate.sentenceReady();   // the answer has started: no acknowledgement
    const words = cfg.reply.split(/(?<=\s)/);
    const gap = 1000 / cfg.tokens_per_s;
    let flushTimer = null;
    for (const word of words) {
      chunker.feed(word); clearTimeout(flushTimer); flushTimer = setTimeout(() => chunker.flushSentence(), 100);
      await sleep(gap * (word.split(/\s+/).length) * 1.3);
      if (result.first_audio_wall != null) break;
    }
    clearTimeout(flushTimer); chunker.finish();
  }

  // Feed the audio at real-time pace (or as fast as possible when pace is 0).
  if (cfg.smart_turn === 'oracle') segmenter.smartTurn(true);
  const start = now(); turnStart = start;
  for (let at = 0; at < pcm.length; at += BLOCK) {
    const block = pcm.subarray(at, Math.min(pcm.length, at + BLOCK));
    if (cfg.pace) await sleep(start + (at + block.length) / 16 / cfg.pace - now());
    else if (at % 3200 === 0) await new Promise(resolve => setImmediate(resolve));
    fed = at + block.length;
    segmenter.push(block);
    if (fed >= speechEnd && !speechEndWall) speechEndWall = now();
  }
  // Silence runs out before the reply is ready only in a broken run; give the reply time to finish.
  let giveUp; await Promise.race([done, new Promise(resolve => { giveUp = setTimeout(resolve, 30000); })]); clearTimeout(giveUp);
  gate.cancel();
  result.speech_end_wall = speechEndWall; result.segments = marks.segments;
  const rel = value => (value == null ? null : Math.round(value - result.last_endpoint_wall));
  if (result.endpoint_ms == null) return { ...result, failed: 'no endpoint' };
  const anchor = result.last_endpoint_ms;                           // the endpoint wait (silence) after speech end, from audio time
  const since = value => (value == null ? null : anchor + Math.round(value - result.last_endpoint_wall));
  const out = {
    fixture: fixture.name, repeat, segments: result.segments, stt_mode: result.stt_mode, partials_sent: result.partials_sent,
    transcript: result.transcript, audio_ms: result.audio_ms,
    endpoint_ms: result.last_endpoint_ms,
    transcript_final_ms: since(result.transcript_wall),
    first_token_ms: since(result.first_token_wall),
    first_sentence_ms: since(result.first_sentence_wall),
    first_audio_ms: since(result.first_audio_wall),
    stt_ms: rel(result.transcript_wall),
  };
  if (result.filler_start_wall != null) {
    out.filler_ms = since(result.filler_start_wall);
    const fillerEnd = result.filler_start_wall + (cfg.filler_ms || 0);
    // The answer queues behind the acknowledgement: it cannot start before the filler ends.
    out.first_sound_ms = Math.min(out.filler_ms, out.first_audio_ms);
    out.first_audio_after_filler_ms = since(Math.max(result.first_audio_wall, fillerEnd));
  } else out.first_sound_ms = out.first_audio_ms;
  out.tts_audio = result.tts_audio;
  return out;
}

// -- barge-in: the user talks over Kairos's voice ---------------------------------------------------------------------
async function runBarge(spec, leakPcm, repeat) {
  const user = readWav(spec.wav), onset = spec.onset_sample;
  const random = rng(77 + repeat);
  const leakGain = cfg.leak_gain;
  const lead = RATE;                                                   // 1 s of Kairos speaking alone first (learns the leak)
  const total = lead + user.length + RATE;
  const events = [];
  let at = 0;
  const detector = new BargeIn({ rate: RATE,
    onDuck: () => events.push({ type: 'duck', sample: at }), onClear: () => events.push({ type: 'clear', sample: at }),
    onBarge: () => events.push({ type: 'barge', sample: at }) });
  detector.reset(.002);
  const start = now();
  let stopped = false;
  for (let i = 0; i < total && !stopped; i += BLOCK) {
    const block = new Float32Array(Math.min(BLOCK, total - i));
    for (let j = 0; j < block.length; j++) {
      const t = i + j;
      const echo = leakPcm.length ? leakPcm[t % leakPcm.length] * leakGain : 0;
      const voice = t >= lead && t - lead < user.length ? user[t - lead] : 0;
      block[j] = echo + voice + (random() - .5) * .002;
    }
    if (cfg.pace) await sleep(start + (i + block.length) / 16 / cfg.pace - now());
    at = i + block.length;
    detector.push(block);
    if (events.some(e => e.type === 'barge')) stopped = true;
  }
  const voiceStart = lead + onset;
  const find = type => events.find(e => e.type === type);
  const ms = event => (event ? Math.round((event.sample - voiceStart) / 16) : null);
  return { fixture: spec.name, repeat, voice_ms: Math.round((user.length - onset) / 16), duck_ms: ms(find('duck')), clear_ms: ms(find('clear')), barge_ms: ms(find('barge')),
    outcome: find('barge') ? 'interrupt' : find('clear') ? 'nod' : 'nothing' };
}

// -- the run ----------------------------------------------------------------------------------------------------------
const turns = [], barges = [];
for (let repeat = 0; repeat < cfg.repeats; repeat++) {
  for (const fixture of cfg.fixtures) {
    const turn = await runTurn(fixture, repeat);
    turns.push(turn);
  }
}
const leak = (turns.find(t => t.tts_audio && t.tts_audio.length)?.tts_audio) || '';
const leakPcm = leak ? (() => { const bytes = Buffer.from(leak, 'base64'); const out = new Float32Array(bytes.length >> 1); for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2) / 32768; return out; })() : new Float32Array(0);
for (const turn of turns) delete turn.tts_audio;
for (let repeat = 0; repeat < cfg.barge_repeats; repeat++) for (const spec of cfg.barge) barges.push(await runBarge(spec, leakPcm, repeat));
process.stdout.write(JSON.stringify({ turns, barges, constants: { BARGE_DUCK_MS, BARGE_VOICE_MS, LEAD_MS } }));
