// Shared by the AudioWorklet and audio regression tests. All times come from
// samples, so a busy renderer cannot clip a word or advance the silence timer.
export class SpeechSegments {
  constructor({ rate = 16000, preRollMs = 400, silenceMs = 700, onStart = () => {}, onSegment = () => {} } = {}) {
    this.rate = rate; this.preRoll = Math.round(rate * preRollMs / 1000);
    this.silence = rate * silenceMs / 1000; this.onStart = onStart; this.onSegment = onSegment;
    this.reset();
  }
  reset(keepNoise = false) {
    const previousNoise = this.noise, calibrated = this.calibrated;
    this.ring = []; this.ringSize = 0; this.parts = []; this.length = 0;
    this.active = false; this.attack = 0; this.voiced = 0; this.quiet = 0;
    this.noise = .002; this.calibration = []; this.calibrated = 0; this.lastVoice = 0;
    if (keepNoise && calibrated >= this.rate * .2) { this.noise = previousNoise; this.calibrated = calibrated; }
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
        this.onStart();
      }
    } else {
      this.parts.push(samples.slice()); this.length += samples.length;
      if (rms > Math.max(.0025, this.noise * 1.6)) {
        this.voiced += samples.length; this.lastVoice = this.length; this.quiet = 0;
      } else this.quiet += samples.length;
      if (this.quiet >= this.silence || this.length >= this.rate * 30) this.finish();
    }
    return rms;
  }
  finish() {
    const accepted = this.voiced >= this.rate * .12;
    const length = Math.min(this.length, this.lastVoice + Math.round(this.rate * .16), this.rate * 30);
    const overflow = Math.max(0, this.length - this.rate * 30);
    const tail = overflow ? this.parts.at(-1).slice(-overflow) : null;
    const pcm = accepted ? new Float32Array(length) : new Float32Array(0);
    let at = 0; if (accepted) for (const part of this.parts) { const n = Math.min(part.length, length-at); if (n <= 0) break; pcm.set(part.subarray(0,n),at); at += n; }
    const endpointMs = Math.round(this.quiet / this.rate * 1000);
    this.active = false; this.attack = 0; this.voiced = 0; this.quiet = 0; this.parts = []; this.length = 0; this.lastVoice = 0;
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
