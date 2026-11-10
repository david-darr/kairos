// static/js/openMic.js — continuous back-and-forth voice for a chat session
// (David's ask 2026-09-15).
//
// The loop: listen, detect an utterance, transcribe it, send it as a normal
// chat message, speak the reply, listen again. Speaking while the assistant is
// talking cuts it off.
//
// Voice turns are ordinary messages. They stream, persist and appear in the
// transcript exactly like typed ones, so leaving Open Mic leaves a real
// conversation behind rather than a separate voice log that has to be merged.
//
// Open Mic runs on the same pipeline as a native call (Fluid Voice build order step 6):
//   capture     the AudioWorklet call recorder: 16 kHz PCM, 400 ms of pre-roll so the first word is whole, the call's
//               sample-based endpoint (kept at Open Mic's 900 ms via the recorder's silenceMs option)
//   recognition rolling partial transcription while the user talks (partialTranscript.js), used when the warm GPU
//               recognizer is registered, so the final transcript is ready at the endpoint; otherwise the whole clip
//   barge-in    the microphone stays open while the reply is written and spoken; the worklet's BargeIn (echo-cancelled,
//               ~250 ms of voice) cuts the voice and the turn, and the interruption is already being recorded
//   speech      the call's prefetching sentence speaker: the neural voice when one is chosen for Open Mic, the OS
//               voice otherwise, speaking each sentence as the chat reply's tokens stream in
// The turn itself is still an ordinary chat turn in that chat: same model, tools and history, no fast layer.
//
// Where an AudioWorklet cannot run (no worklet, no 16 kHz context) it falls back to the original capture: a
// MediaRecorder with loudness thresholds polled every 100 ms. The thresholds below belong to that fallback.
//
// The honest limitation, the same one voice-line's ears.py documents: an open
// microphone hears the room. Audio from a video, music, or someone else's
// conversation can be picked up as speech. That is why this is a mode you turn
// on deliberately, not the default.

import { createRecorder, transcribeBlob, transcribePartial, getSpeechStatus } from './voiceInput.js';
import { createCallRecorder, isCallRecordingSupported } from './callRecorder.js';
import { createPartialTranscriber } from './partialTranscript.js';
import { isSpeechOutputSupported } from './voiceOutput.js';
import { createVoiceSpeaker } from './callVoice.js';
import { createVoiceTrace } from './voiceTrace.js';
import { createFillerGate, fetchFillerClip } from './voiceFiller.js';
import { isBackchannel, endsInQuestion } from './backchannel.js';
import { api } from './api.js';
import { pickVoice } from './callDefaults.js';

// Tuned against normal speech at a normal distance. The onset threshold sits
// above room tone; the barge-in threshold is higher because the microphone
// also hears the assistant's own voice through the speakers, and a too-low
// value makes it interrupt itself.
const SPEECH_LEVEL = 0.12;
const BARGE_LEVEL = 0.22;
// Barge-in must be SUSTAINED, not a single loud frame: the microphone hears
// the assistant through the speakers, and one syllable's peak should never
// count as an interruption or it talks over itself.
//
// Counted across a sliding window rather than as a consecutive run. Requiring
// N in a row sounds equivalent and is not: each reading samples a slice of
// audio, and speech dips between syllables, so a real interruption produces a
// broken pattern of loud readings rather than an unbroken one. David talked
// over it for seconds and the run almost never reached three, which is why
// interrupting appeared to do nothing at all.
const BARGE_LOUD_FRAMES = 3;
const BARGE_WINDOW_FRAMES = 6;
// Speech has gaps. Ending an utterance on the first quiet frame would cut
// people off mid-sentence, so silence has to persist.
const SILENCE_MS = 900;
const MIN_UTTERANCE_MS = 350;
// A hard ceiling so a stuck recorder or a noisy room cannot record forever.
const MAX_UTTERANCE_MS = 45000;

// The reading voice for Open Mic. A voice chosen for Open Mic in Settings > Speech > More options wins (saved as
// kairos:neural-voice:openmic, the same {provider, model, voice} shape a call keeps per bot); with none chosen, or
// "Same as the Voice", Open Mic follows the Voice in Settings > Speech: its engine (Kokoro for Kairos Voice,
// ElevenLabs, Voicebox) when that is ready, else the OS voice. primeOpenMicVoice() looks the engine up at start.
export const OPEN_MIC_VOICE_KEY = 'kairos:neural-voice:openmic';
let followed = null;
function savedOpenMicVoice() {
  try { return JSON.parse(localStorage.getItem(OPEN_MIC_VOICE_KEY) || '{}') || {}; } catch { return {}; }
}
export async function primeOpenMicVoice(request = api) {
  const saved = savedOpenMicVoice();
  if (saved.provider === 'device' || saved.provider === 'neural') return;
  try {
    const catalog = await Promise.race([request('/api/agent-calls/voices', { toast: false }), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 1500))]);
    const picked = pickVoice({}, {}, catalog);
    followed = picked.provider === 'neural' ? picked : null;
  } catch { followed = null; }
}
export function openMicVoiceSelection() {
  const saved = savedOpenMicVoice();
  if (saved.provider === 'neural' && saved.model && saved.voice) return { provider: 'neural', model: saved.model, voice: saved.voice };
  if (saved.provider !== 'device' && followed) return { ...followed };
  return { provider: 'device' };
}

// `createMic`, `createCapture` and `makeSpeaker` are injection points for the suites, not configuration. Barge-in
// shipped broken once because nothing could drive this machine without a real microphone and a real voice, so the
// one test that would have caught it could not be written.
//   createCapture  a call-recorder factory (the worklet path). Default: the real one where the browser supports it.
//   createMic      the loudness recorder. Passing it WITHOUT createCapture selects the loudness path (what the
//                  original suites drive through _level); the default is that recorder, as the fallback.
//   makeSpeaker    default: the call's sentence speaker, neural voice when chosen, OS voice otherwise.
export function createOpenMic({ sessionId, sendMessage, stopTurn, onState, onError,
                                createMic, createCapture, makeSpeaker, noteHeard }) {
  const makeLevelMic = createMic || createRecorder;
  const makeCapture = createCapture || (!createMic && isCallRecordingSupported() ? createCallRecorder : null);
  let state = 'idle';
  let recorder = null;
  let mode = '';              // 'worklet' (call capture) or 'level' (loudness fallback), set once the microphone is open
  let speaker = null;
  let stopped = false;
  let epoch = 0;              // bumped on start and stop, so a late async step from an old session does nothing

  let speechStartedAt = 0;
  let lastLoudAt = 0;
  let capturing = false;
  let bargeWindow = [];
  // Utterances waiting for recognition, and the text of earlier ones the user has not finished the thought after:
  // a pause that outlasts the endpoint but not the thought becomes ONE turn, as it does in a call.
  let backlog = [];
  let transcribing = false;
  let held = '';
  let nods = 0;
  let heldTrace = null;
  let neuralFailed = false;
  // A reply is on its way (sent, not yet finished streaming): a pause in the voice is not the end of the turn.
  let replying = false;
  // Did the user start talking over a reply, and had Kairos just asked something? A nod over the voice is not a turn.
  let utterance = { during: false, asked: false };
  let fillerOn = false;
  // Per-turn latency, kept in memory for this session and logged at debug (see voiceTrace.js).
  const voiceTrace = createVoiceTrace({ label: 'openmic' });
  let turnTrace = null;
  // Rolling transcription: off until a warm GPU recognizer is confirmed (the in-process CPU engine runs at about real
  // time, so partials there would only fight the real pass for it). `recognition` is the model the call would use.
  let recognition = {};
  const partials = createPartialTranscriber({ send: (wav, signal) => transcribePartial(wav, { signal, model: recognition.model, backend: recognition.backend }) });
  partials.disable('cpu');

  // Instant acknowledgement (voiceFiller.js): if no sentence of the reply is ready half a second after the turn was sent.
  const filler = createFillerGate({
    fetchClip: (last, text) => fetchFillerClip({ selection: neuralFailed ? { provider: 'device' } : openMicVoiceSelection(), last, text }),
    blocked: () => stopped || capturing || state === 'listening' || state === 'idle',
    play: clip => { fillerOn = true; speaker?.filler?.(clip); },
  });

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onState?.(next);
    applyMicrophone();
  };

  const fail = (message) => {
    onError?.(message);
  };

  // Worklet capture only. The microphone is live in every state; while the reply is being written or spoken it is in
  // barge mode: no segmenting, only a watch for the user's voice over the echo (speechSegments.js BargeIn).
  function applyMicrophone() {
    if (mode !== 'worklet' || !recorder) return;
    recorder.setEnabled(true, state === 'thinking' || state === 'speaking');
  }

  const interrupt = () => {
    // Cut both the voice and the in-flight turn: letting the reply finish
    // generating invisibly would make the next thing said land against
    // stale context.
    // What had actually been heard goes to the chat's model so its next reply continues from there.
    if (replying || state === 'thinking' || state === 'speaking') { try { const heard = speaker?.heard?.(); if (Array.isArray(heard)) noteHeard?.(sessionId, heard); } catch { /* best effort */ } }
    filler.cancel(); fillerOn = false; replying = false;
    speaker?.cancel();
    stopTurn?.(sessionId);
  };

  // Level callback drives the loudness fallback. Kept in one place so the states
  // cannot disagree about what the microphone is currently hearing.
  const onLevel = (level) => {
    if (stopped || mode === 'worklet') return;
    const now = Date.now();

    // Barge-in. The microphone is open the whole time - through transcribing,
    // thinking and speaking - which is the only reason levels arrive here at
    // all. The first version closed the device in finishUtterance() and
    // reopened it from the speaker's onEnd, so nothing was listening while the
    // assistant talked and this branch could never run: barge-in was dead code
    // behind thresholds nothing evaluated. Found by David testing it, not by
    // the suites, which have no microphone to hear.
    if (state === 'thinking' || state === 'speaking') {
      bargeWindow.push(level >= BARGE_LEVEL);
      if (bargeWindow.length > BARGE_WINDOW_FRAMES) bargeWindow.shift();
      if (bargeWindow.filter(Boolean).length < BARGE_LOUD_FRAMES) return;
      bargeWindow = [];
      interrupt();
      beginCapture(now);
      return;
    }

    if (state !== 'listening') return;

    if (level >= SPEECH_LEVEL) {
      if (!capturing) beginCapture(now);
      lastLoudAt = now;
      return;
    }
    if (!capturing) return;
    if (now - lastLoudAt < SILENCE_MS) return;
    if (lastLoudAt - speechStartedAt < MIN_UTTERANCE_MS) {
      // Too short to be speech - a door, a cough, a keyboard. Drop it rather
      // than only clearing the flag: the recorder is running by now, and
      // leaving it to run would glue the noise onto the front of whatever is
      // actually said next.
      capturing = false;
      discardCapture();
      return;
    }
    finishUtterance();
  };

  function beginCapture(now) {
    capturing = true;
    speechStartedAt = now;
    lastLoudAt = now;
    // Recording starts HERE, not when the device opened. The stream is live
    // continuously for level metering, but capturing continuously would put
    // the assistant's own spoken reply - which the microphone hears through
    // the speakers - at the front of the next utterance sent to whisper.
    recorder?.capture();
    setState('listening');
  }

  // Ends the recording and throws the audio away. Failures are ignored on
  // purpose: this is cleanup, and there is nothing useful to tell anyone about
  // a noise that was never going to be transcribed.
  function discardCapture() {
    bargeWindow = [];
    recorder?.stop().catch(() => {});
  }

  // Loudness fallback: the end of an utterance. Hands the recorded clip to the shared recognition queue.
  async function finishUtterance() {
    if (!recorder || !capturing) return;
    capturing = false;
    bargeWindow = [];
    // The silence wait is part of the turn: speech really ended at the last loud reading.
    const trace = voiceTrace.begin(performance.now() - (Date.now() - lastLoudAt));
    voiceTrace.mark(trace, 'endpoint');
    setState('transcribing');
    const mine = epoch;
    let blob = null;
    try {
      // Ends the utterance but leaves the stream open, so levels keep arriving
      // and the next barge-in is heard.
      blob = await recorder.stop();
    } catch {
      blob = null;
    }
    if (stopped || mine !== epoch) return;
    backlog.push({ wav: blob, pcm: null, session: null, trace, decode: true });
    drain();
  }

  // -- worklet capture: the call recorder's callbacks -------------------------------------------------------------
  function speechStarted() {
    if (stopped) return;
    if (!utterance.during) utterance = { during: state === 'speaking' || state === 'thinking' || replying, asked: false };
    capturing = true;
    partials.begin();
  }

  function bargedIn() {
    if (stopped || (state !== 'thinking' && state !== 'speaking')) return;
    try { utterance = { during: true, asked: endsInQuestion(speaker?.heard?.()) }; } catch { utterance = { during: true, asked: false }; }
    interrupt();
    // The worklet already holds the start of the interruption and keeps recording it as the next utterance.
    capturing = true;
    setState('listening');
  }

  function segmentEnded(wav, timing, pcm) {
    if (stopped) return;
    capturing = false;
    const spoke = utterance; utterance = { during: false, asked: false };   // whatever this utterance was said over, it is used up
    const session = partials.take();
    if (!wav) {
      // Too little voice to be speech (a click, a cough): nothing to recognize.
      session?.cancel();
      if (!transcribing) drain();
      return;
    }
    const trace = voiceTrace.begin(performance.now() - (timing?.endpoint_ms || 0));
    voiceTrace.mark(trace, 'endpoint');
    backlog.push({ wav, pcm, session, trace, decode: false, during: spoke.during, asked: spoke.asked });
    drain();
  }

  // Final transcript of one utterance: the rolling session's text when it has one (nothing left to send, or only the
  // tail), otherwise, or if anything about that goes wrong, the whole clip.
  async function recognize(item) {
    const options = { pcm: !item.decode, ...recognition };
    if (item.session && item.pcm) {
      try {
        const rolled = await item.session.finalize(item.pcm, wav => transcribeBlob(wav, options));
        if (rolled) return rolled.text;
      } catch (problem) { if (problem?.name === 'AbortError') return ''; }
    }
    return transcribeBlob(item.wav, options);
  }

  // Recognition, one clip at a time; then the turn goes out once the user has stopped (not mid-thought).
  async function drain() {
    if (transcribing) return;
    transcribing = true;
    const mine = epoch;
    try {
      while (!stopped && mine === epoch && backlog.length) {
        const item = backlog.shift();
        setState('transcribing');
        let text = '';
        if (item.wav) {
          try {
            voiceTrace.mark(item.trace, 'upload_sent');
            text = String(await recognize(item) || '').trim();
            voiceTrace.mark(item.trace, 'transcript_back');
          } catch (error) {
            fail(error.message || 'Transcription failed.');
          }
        }
        if (stopped || mine !== epoch) return;
        // A nod over the reply ("mm-hm", "yeah") is not a turn: nothing is sent and nothing is interrupted by it.
        if (text && item.during && isBackchannel(text, item.asked)) { nods++; continue; }
        if (text) { held = held ? `${held} ${text}` : text; heldTrace = item.trace; }
      }
    } finally {
      if (mine === epoch) transcribing = false;
    }
    if (stopped || mine !== epoch) return;
    if (capturing || backlog.length) { setState('listening'); return; }   // still talking: this text goes out with the rest
    if (!held) {
      // Nothing intelligible. Back to listening rather than sending an empty
      // turn or announcing it, which in a continuous loop would fire
      // constantly on ordinary room noise.
      setState('listening');
      return;
    }
    dispatch();
  }

  async function dispatch() {
    const text = held, trace = heldTrace;
    held = ''; heldTrace = null;
    setState('thinking');
    turnTrace = trace;
    voiceTrace.mark(trace, 'turn_started');
    // Clears the cancel latch from any previous interruption. Without it the
    // speaker stays permanently silenced after the first barge-in.
    speaker?.reset();
    replying = true; fillerOn = false;
    filler.arm({ text });
    const mine = epoch;
    try {
      await sendMessage(text, {
        onChunk: (delta) => { voiceTrace.mark(trace, 'first_token'); filler.sentenceReady(); speaker?.feed(delta); },
        onDone: () => { replying = false; speaker?.finish(); },
      });
    } catch (error) {
      replying = false; filler.cancel();
      fail(error.message || 'That turn could not be sent.');
      if (!stopped && mine === epoch) setState('listening');
    }
  }

  // Which recognizer a turn uses. The call's choice (Small, on the warm CUDA server) only when a GPU runtime is
  // registered and that model is downloaded: then partials roll and the final pass is the same fast engine. Otherwise
  // nothing changes from before: the default model, on demand, one whole clip.
  async function prepareRecognition() {
    const mine = epoch;
    try {
      const status = await getSpeechStatus();
      if (!status?.acceleration?.configured) return;
      const name = status.call_model || 'small.en';
      if (!(status.models || []).some(item => item.name === name && item.downloaded)) return;
      const ready = await api('/api/speech/prepare', { method: 'POST', toast: false, body: JSON.stringify({ model: name, backend: 'auto' }) });
      if (stopped || mine !== epoch || ready?.engine !== 'cuda') return;
      recognition = { model: name, backend: 'auto' };
      partials.reset();
    } catch { /* stay on the default recognizer */ }
  }

  // Opens the device without claiming any particular state, and only once per
  // session: the stream stays live from start() to stop(). Reopening it per
  // turn would reacquire the device on every exchange, which on Windows costs
  // a noticeable delay and flickers the recording indicator.
  async function openMicrophone() {
    if (stopped) return false;
    if (recorder) return true;
    capturing = false;
    const blocked = (error) => fail(error && error.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it to use Open Mic.'
      : 'No microphone is available.');
    if (makeCapture) {
      const active = makeCapture({
        mode: 'automatic', silenceMs: SILENCE_MS,
        onSpeechStart: speechStarted, onChunk: pcm => { if (!stopped && capturing) partials.push(pcm); },
        onBargeIn: bargedIn, onSegment: segmentEnded,
        // The user's voice just started over Kairos: pause at once; a nod ends before it counts and the voice carries on.
        onBargeDuck: () => { if (!stopped && state === 'speaking') speaker?.pause?.(); },
        onBargeClear: () => { if (!stopped) speaker?.resume?.(); },
        onError: error => { fail(error?.message || 'Microphone capture stopped.'); stop(); },
      });
      try {
        await active.start();
        if (stopped) { try { active.close(); } catch { /* already gone */ } return false; }
        recorder = active; mode = 'worklet';
        applyMicrophone();
        return true;
      } catch (error) {
        try { active.close(); } catch { /* already gone */ }
        // A blocked microphone is final. Anything else is the worklet path being unavailable here: use loudness.
        if (error && error.name === 'NotAllowedError') { blocked(error); stop(); return false; }
        if (stopped) return false;
      }
    }
    mode = 'level';
    const active = makeLevelMic({ onLevel, gated: true });
    try {
      await active.start();
    } catch (error) {
      blocked(error);
      stop();
      return false;
    }
    if (stopped) { try { active.cancel(); } catch { /* already gone */ } return false; }
    recorder = active;
    return true;
  }

  async function listen() {
    if (!(await openMicrophone())) return false;
    setState('listening');
    return true;
  }

  // One timer for the session, not one per turn. The original registered a
  // fresh interval on every listen() and cleared none of them, so a long
  // conversation accumulated a live interval per exchange.
  let ceilingTimer = null;

  return {
    get state() { return state; },
    // 'worklet' (the call's capture) or 'level' (the loudness fallback); '' until the microphone is open.
    get capture() { return mode; },
    // Rolling transcription: 'on', or why it is off ('cpu', 'slow', 'unavailable'); and the model in use, if not the default.
    get recognition() { return { ...recognition, partials: partials.state.disabled || 'on' }; },
    // The in-memory latency trace of this session's voice turns.
    get latency() { return voiceTrace; },
    // How many nods ("mm-hm") over a reply were heard and ignored.
    get nods() { return nods; },

    // Exposed so a test can feed levels directly. The real path goes through
    // the recorder's analyser, which a headless suite has no way to drive.
    _level(value) { onLevel(value); },

    async start() {
      stopped = false;
      epoch++;
      clearInterval(ceilingTimer);
      // Checked on a timer rather than in the level callback so it still
      // applies to a silent stuck stream, which produces no levels to act on.
      // (Loudness path only: the worklet cuts an utterance at 30 s itself.)
      ceilingTimer = setInterval(() => {
        if (stopped || !capturing || mode !== 'level') return;
        if (Date.now() - speechStartedAt > MAX_UTTERANCE_MS) finishUtterance();
      }, 1000);
      neuralFailed = false;
      const options = {
        onStart: () => setState('speaking'),
        onSentenceReady: () => { filler.sentenceReady(); voiceTrace.mark(turnTrace, 'first_sentence'); },
        onSentenceStart: () => { fillerOn = false; voiceTrace.sentenceStart(turnTrace); },
        // The device is already open; this only returns the state. It fires
        // once the whole queue has drained rather than per sentence, so the
        // pause between the assistant's own sentences is never mistaken for
        // the end of its turn.
        onEnd: () => {
          if (stopped) return;
          // An acknowledgement that ended while the reply is still being written: keep waiting for it.
          if (replying) { setState('thinking'); return; }
          voiceTrace.report(turnTrace); listen();
        },
        // A neural voice that fails (server stopped, engine error) hands the rest of the session to the OS voice.
        onError: message => {
          if (speaker?.kind !== 'neural') return;
          neuralFailed = true;
          fail(`${message} Open Mic will use the device voice from the next reply.`);
        },
      };
      if (!makeSpeaker) { await primeOpenMicVoice(); if (stopped) return false; }
      speaker = (makeSpeaker || (opts => createVoiceSpeaker(opts, () => (neuralFailed ? { provider: 'device' } : openMicVoiceSelection()))))(options);
      if (!isSpeechOutputSupported()) {
        // Still useful without a voice: it becomes hands-free dictation with
        // replies on screen, which is better than refusing outright.
        fail('This browser cannot speak replies aloud. Open Mic will still listen and reply in text.');
      }
      // False when the microphone could not be opened (the caller then ends the session).
      const listening = await listen();
      if (listening) {
        // Creates the neural voice's audio context now, inside the user's click, and warms the recognizer.
        try { speaker?.prepare?.()?.catch?.(() => { neuralFailed = true; }); } catch { neuralFailed = true; }
        if (mode === 'worklet') prepareRecognition();
      }
      return listening;
    },

    // Called by the turn driver as the reply streams, so the speaker can start
    // talking before the whole answer has arrived.
    feed(delta) { speaker?.feed(delta); },
    finishReply() { speaker?.finish(); },

    stop() { stop(); },
  };

  function stop() {
    stopped = true;
    epoch++;
    clearInterval(ceilingTimer);
    ceilingTimer = null;
    bargeWindow = [];
    backlog = [];
    held = ''; heldTrace = null; transcribing = false;
    partials.cancel();
    try { recorder?.close(); } catch { /* already released */ }
    recorder = null;
    mode = '';
    filler.cancel(); replying = false;
    speaker?.cancel();
    speaker?.dispose?.();
    speaker = null;
    capturing = false;
    setState('idle');
  }
}

export const _thresholds = { SPEECH_LEVEL, BARGE_LEVEL, SILENCE_MS, MIN_UTTERANCE_MS, MAX_UTTERANCE_MS, BARGE_LOUD_FRAMES, BARGE_WINDOW_FRAMES };
