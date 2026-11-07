// Shared by the AudioWorklet and audio regression tests. All times come from
// samples, so a busy renderer cannot clip a word or advance the silence timer.
// Audio kept after the last voiced sample when a segment is cut (also what the rolling transcript treats as trailing).
export const TRAILING_KEEP_MS = 160;
// Rolling transcription feed: while an utterance runs, the new audio is handed out about every CHUNK_MS, and once more
// when the speaker has been quiet for PAUSE_FLUSH_MS (a likely end of turn, ~400 ms before the 700 ms endpoint), so a
// partial transcript that covers all the voiced audio can already be on its way when the endpoint fires.
export const CHUNK_MS = 1000;
export const PAUSE_FLUSH_MS = 300;
// End of turn by meaning (core/turn_detect.py, Smart Turn). Only when the owner switches it on with `smartTurn(true)`.
// A pause of SMART_PAUSE_MS asks "is this sentence finished?" once, handing out the last SMART_WINDOW_MS of the utterance
// with an id. The answer decides the pause: complete ends the turn at once; incomplete keeps listening until the speaker
// has been quiet for SMART_CAP_MS, then ends anyway; no answer by the ordinary silence wait (slow, failed, off) ends it
// exactly as without Smart Turn. Voice resuming forgets the question.
export const SMART_PAUSE_MS = 200;
export const SMART_CAP_MS = 2500;
export const SMART_WINDOW_MS = 8000;

// The pure decision, shared by the segmenter and by any other endpointer (Open Mic) that counts silence its own way:
// given how long the speaker has been quiet and the verdict so far (null = none yet, true = complete, false =
// incomplete), may the turn end now?
export function endOfTurn({ quietMs, verdict = null, silenceMs = 700, capMs = SMART_CAP_MS }) {
  if (verdict === true) return quietMs >= SMART_PAUSE_MS;
  if (verdict === false) return quietMs >= Math.max(capMs, silenceMs);
  return quietMs >= silenceMs;
}

export class SpeechSegments {
  constructor({ rate = 16000, preRollMs = 400, silenceMs = 700, chunkMs = 0, pauseFlushMs = PAUSE_FLUSH_MS, onStart = () => {}, onSegment = () => {}, onChunk = null, onPause = null, capMs = SMART_CAP_MS } = {}) {
    this.onPause = onPause; this.smart = false; this.silenceMs = silenceMs; this.capMs = capMs; this.pauseId = 0; this.asked = 0; this.verdict = null;
    this.rate = rate; this.preRoll = Math.round(rate * preRollMs / 1000);
    this.silence = rate * silenceMs / 1000; this.onStart = onStart; this.onSegment = onSegment;
    this.chunk = Math.round(rate * chunkMs / 1000); this.pause = Math.round(rate * pauseFlushMs / 1000); this.onChunk = onChunk;
    this.reset();
  }
  reset(keepNoise = false) {
    const previousNoise = this.noise, calibrated = this.calibrated;
    this.ring = []; this.ringSize = 0; this.parts = []; this.length = 0;
    this.active = false; this.attack = 0; this.voiced = 0; this.quiet = 0;
    this.pending = []; this.pendingSize = 0; this.paused = false; this.asked = 0; this.verdict = null;
    this.noise = .002; this.calibration = []; this.calibrated = 0; this.lastVoice = 0;
    if (keepNoise && calibrated >= this.rate * .2) { this.noise = previousNoise; this.calibrated = calibrated; }
  }
  smartTurn(value) { this.smart = !!value && !!this.onPause; this.verdict = null; }
  // The answer to a pause question (ignored when it is for an older pause).
  answer(id, complete) { if (this.active && id === this.pauseId && this.asked) { this.verdict = !!complete; this.decide(); } }
  decide() {
    if (this.active && endOfTurn({ quietMs: this.quiet / this.rate * 1000, verdict: this.smart ? this.verdict : null, silenceMs: this.silenceMs, capMs: this.capMs })) this.finish();
  }
  push(samples) {
    let square = 0; for (const sample of samples) square += sample * sample;
    const rms = Math.sqrt(square / Math.max(1, samples.length));
    if (!this.active) {
      this.ring.push(samples.slice()); this.ringSize += samples.length;
      while (this.ringSize > this.preRoll && this.ring.length > 1) this.ringSize -= this.ring.shift().length;
      if (this.calibrated < this.rate * .2) {
        this.calibration.push(rms); this.calibrated += samples.length;
        // Low percentile avoids learning a quiet opening syllable as noise.
        const ordered = [...this.calibration].sort((a,b) => a-b);
        this.noise = Math.max(.0005, Math.min(.012, ordered[Math.floor(ordered.length * .2)]));
        return rms;
      }
      const speech = rms > Math.max(.004, this.noise * 2.5);
      this.attack = speech ? this.attack + samples.length : Math.max(0, this.attack - samples.length * .5);
      if (!speech) this.noise = this.noise * .96 + Math.min(rms, this.noise * 1.3) * .04;
      if (this.attack >= this.rate * .06) {
        this.active = true; this.parts = this.ring; this.length = this.ringSize;
        this.ring = []; this.ringSize = 0; this.voiced = this.attack; this.quiet = 0; this.lastVoice = this.length;
        this.startChunks(); this.onStart(); this.flushChunk(false);
      }
    } else {
      const copy = samples.slice(); this.parts.push(copy); this.length += samples.length;
      if (this.onChunk) { this.pending.push(copy); this.pendingSize += copy.length; }
      if (rms > Math.max(.0025, this.noise * 1.6)) {
        this.voiced += samples.length; this.lastVoice = this.length; this.quiet = 0; this.paused = false;
        this.asked = 0; this.verdict = null;
      } else this.quiet += samples.length;
      if (this.length >= this.rate * 30) this.finish();
      else {
        if (this.smart && !this.asked && this.quiet >= this.rate * SMART_PAUSE_MS / 1000 && this.voiced >= this.rate * .12) this.ask();
        if (!this.active) return rms;
        if (this.smart && this.verdict !== null) this.decide();
        else if (this.quiet >= this.silence) this.finish();
        if (this.active) this.flushChunk(this.quiet >= this.pause && !this.paused);
      }
    }
    return rms;
  }
  // The utterance began elsewhere (barge-in: the detector already listened to the first part). Start it as if the
  // energy gate had just opened, with `parts` as its pre-roll and `voiced` samples of speech already counted.
  begin(parts, voiced) {
    this.parts = parts.slice(); this.length = this.parts.reduce((total, part) => total + part.length, 0);
    this.ring = []; this.ringSize = 0; this.active = true; this.attack = 0; this.voiced = voiced; this.quiet = 0; this.lastVoice = this.length;
    this.startChunks(); this.onStart(); this.flushChunk(false);
  }
  // Hands the last SMART_WINDOW_MS of the utterance to the owner with a fresh id; the verdict comes back through answer().
  ask() {
    const keep = Math.round(this.rate * SMART_WINDOW_MS / 1000), end = Math.min(this.length, this.lastVoice + Math.round(this.rate * TRAILING_KEEP_MS / 1000));
    const out = new Float32Array(Math.min(end, keep)); let skip = Math.max(0, end - keep), at = 0, taken = 0;
    for (const part of this.parts) {
      if (taken >= end) break;
      const from = Math.max(0, skip - taken), to = Math.min(part.length, end - taken);
      if (to > from) { out.set(part.subarray(from, to), at); at += to - from; }
      taken += part.length;
    }
    this.asked = ++this.pauseId; this.verdict = null; this.onPause(this.pauseId, out);
  }
  startChunks() { this.pending = this.onChunk ? this.parts.slice() : []; this.pendingSize = this.onChunk ? this.length : 0; this.paused = false; this.asked = 0; this.verdict = null; }
  // Hands out the audio that arrived since the last chunk: when a chunk's worth is waiting, or when `pause` says the
  // speaker just went quiet for long enough to be at a likely end of turn.
  flushChunk(pause) {
    if (!this.onChunk || !this.pendingSize) return;
    if (!pause && (this.chunk <= 0 || this.pendingSize < this.chunk)) return;
    if (pause) this.paused = true;
    const out = new Float32Array(this.pendingSize); let at = 0;
    for (const part of this.pending) { out.set(part, at); at += part.length; }
    this.pending = []; this.pendingSize = 0;
    this.onChunk(out, { pause: !!pause });
  }
  finish() {
    const accepted = this.voiced >= this.rate * .12;
    const length = Math.min(this.length, this.lastVoice + Math.round(this.rate * TRAILING_KEEP_MS / 1000), this.rate * 30);
    const overflow = Math.max(0, this.length - this.rate * 30);
    const tail = overflow ? this.parts.at(-1).slice(-overflow) : null;
    const pcm = accepted ? new Float32Array(length) : new Float32Array(0);
    let at = 0; if (accepted) for (const part of this.parts) { const n = Math.min(part.length, length-at); if (n <= 0) break; pcm.set(part.subarray(0,n),at); at += n; }
    const endpointMs = Math.round(this.quiet / this.rate * 1000);
    this.active = false; this.attack = 0; this.voiced = 0; this.quiet = 0; this.parts = []; this.length = 0; this.lastVoice = 0;
    this.pending = []; this.pendingSize = 0; this.paused = false; this.asked = 0; this.verdict = null;
    this.ring = []; this.ringSize = 0;
    if (tail) { this.ring = [tail]; this.ringSize = tail.length; }
    this.onSegment(pcm, { endpoint_ms: endpointMs, audio_ms: Math.round(pcm.length / this.rate * 1000) });
  }
}

// Full utterance capture: no energy gate or pause splitting. The user chooses
// the boundary, with Voice-line's 180 ms release tail to retain the final word.
export class HeldSpeech {
  constructor({ rate = 16000, onStart = () => {}, onSegment = () => {} } = {}) {
    this.rate = rate; this.onStart = onStart; this.onSegment = onSegment; this.cancel();
  }
  cancel() { this.active = false; this.parts = []; this.length = 0; this.tail = null; }
  begin() { if (this.active) { this.tail = null; return; } this.cancel(); this.active = true; this.onStart(); }
  release() { if (this.active && this.tail == null) this.tail = Math.round(this.rate * .18); }
  push(samples) {
    if (!this.active) return;
    const count = Math.min(samples.length, this.rate * 60 - this.length, this.tail ?? samples.length);
    this.parts.push(samples.slice(0, count)); this.length += count;
    if (this.tail != null) this.tail -= count;
    if (this.tail === 0 || this.length >= this.rate * 60) {
      const pcm = this.length >= this.rate * .25 ? new Float32Array(this.length) : new Float32Array(0);
      let at = 0; if (pcm.length) for (const part of this.parts) { pcm.set(part, at); at += part.length; }
      const timing = { endpoint_ms: this.tail === 0 ? 180 : 0, audio_ms: Math.round(this.length / this.rate * 1000), limit: this.length >= this.rate * 60 };
      this.cancel(); this.onSegment(pcm, timing);
    }
  }
}

// Barge-in while Kairos speaks. The microphone stays open (the browser's echo canceller is already on: callRecorder asks
// for echoCancellation/noiseSuppression/autoGainControl), but it is not segmenting: this watches for the user's voice
// over whatever of Kairos's own voice still leaks back in. Chromium's canceller only knows audio it plays itself, so an
// OS device voice can leak more than a neural voice that plays through Web Audio; the floor below learns the actual
// leak during playback instead of assuming it is gone.
//
// Voice is energy that stays above a floor. It acts in two steps so a stop is fast AND a nod is not an interruption:
//   after BARGE_DUCK_MS  `onDuck`: the owner pauses Kairos's voice at once (the user may be about to talk)
//   after BARGE_VOICE_MS `onBarge`: it really is the user taking the floor; the owner cancels the reply for good
// If the voice ends between the two (a backchannel: "mm-hm", "yeah", a cough) and stays quiet for BARGE_CLEAR_MS, `onClear`
// fires and the voice carries on. Until then the pause holds, so the gaps between a person's words do not make it stutter.
export const BARGE_DUCK_MS = 120;     // voice this long pauses Kairos (a stop well under 200 ms, audio buffer included)
export const BARGE_VOICE_MS = 320;    // sustained voice needed to interrupt. A single "yeah" or "mm-hm" is ~150-300 ms.
export const BARGE_GAP_MS = 100;      // a dip this short between syllables does not restart the count; a longer one does
export const BARGE_CLEAR_MS = 350;    // once Kairos is paused, the user must stay quiet this long before the voice carries on (words have gaps)
export const BARGE_WARMUP_MS = 150;   // learn Kairos's own leak first; nothing can interrupt in the first 150 ms of speech
export const BARGE_MIN_LEVEL = .012;  // never a voice below this RMS, however quiet the learned floor is (noise, breathing)
export const BARGE_RATIO = 3;         // a voice is at least this many times the learned leak floor (about +9.5 dB)
export const BARGE_PREROLL_MS = 300;  // audio before the voice onset handed to the utterance, so the first word is whole
const FLOOR_TRACK = .05;              // the floor follows quieter-than-voice blocks quickly (leak rises and falls with syllables)
const FLOOR_DRIFT = .002;             // and loud blocks only slowly, so a user's speech cannot teach it to ignore them

export class BargeIn {
  constructor({ rate = 16000, voiceMs = BARGE_VOICE_MS, gapMs = BARGE_GAP_MS, warmupMs = BARGE_WARMUP_MS, minLevel = BARGE_MIN_LEVEL,
    ratio = BARGE_RATIO, preRollMs = BARGE_PREROLL_MS, duckMs = BARGE_DUCK_MS, clearMs = BARGE_CLEAR_MS, onBarge = () => {}, onDuck = () => {}, onClear = () => {} } = {}) {
    this.onDuck = onDuck; this.onClear = onClear; this.duck = Math.round(rate * duckMs / 1000); this.clearGap = Math.round(rate * clearMs / 1000); this.ducked = false;
    this.rate = rate; this.voice = Math.round(rate * voiceMs / 1000); this.gap = Math.round(rate * gapMs / 1000);
    this.warmup = Math.round(rate * warmupMs / 1000); this.minLevel = minLevel; this.ratio = ratio;
    this.preRoll = Math.round(rate * preRollMs / 1000); this.onBarge = onBarge;
    this.reset();
  }
  // Start of a stretch of Kairos speaking. `ambient` is the room noise the segmenter already measured.
  reset(ambient = .002) {
    this.floor = Math.max(.0005, ambient); this.warmed = 0; this.voiced = 0; this.quiet = 0; this.run = false; this.ducked = false;
    this.buf = []; this.size = 0;
  }
  get threshold() { return Math.max(this.minLevel, this.floor * this.ratio); }
  push(samples) {
    let square = 0; for (const sample of samples) square += sample * sample;
    const rms = Math.sqrt(square / Math.max(1, samples.length));
    this.buf.push(samples.slice()); this.size += samples.length;
    if (this.warmed < this.warmup) {
      this.warmed += samples.length; this.floor += (rms - this.floor) * .25; this.trim(); return rms;
    }
    if (rms > this.threshold) {
      this.run = true; this.voiced += samples.length; this.quiet = 0; this.floor += (rms - this.floor) * FLOOR_DRIFT;
      if (!this.ducked && this.voiced >= this.duck && this.voiced < this.voice) { this.ducked = true; this.onDuck(); }
      if (this.voiced >= this.voice) {
        const parts = this.buf, voiced = this.voiced;
        this.reset(this.floor); this.warmed = this.warmup;   // armed again at once if the caller keeps feeding us
        this.onBarge({ parts, voiced });
      }
    } else {
      this.floor += (rms - this.floor) * FLOOR_TRACK;
      if (this.run && (this.quiet += samples.length) > (this.ducked ? this.clearGap : this.gap)) {
        this.run = false; this.voiced = 0; this.quiet = 0;
        if (this.ducked) { this.ducked = false; this.onClear(); }    // it was only a nod: Kairos carries on
      }
      if (!this.run) this.trim();
    }
    if (this.size > this.rate * 3) this.trim(true);
    return rms;
  }
  // Keep only the pre-roll while no voice run is under way (or cap the whole buffer if a run drags on).
  trim(all = false) {
    const keep = all ? this.rate * 3 : this.preRoll;
    while (this.buf.length > 1 && this.size - this.buf[0].length >= keep) this.size -= this.buf.shift().length;
  }
}
