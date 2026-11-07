import { SpeechSegments, HeldSpeech, BargeIn, CHUNK_MS } from './speechSegments.js';

class KairosCallProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.enabled = false; this.levelSamples = 0; this.ready = false;
    this.manual = false; this.barge = false;
    this.held = new HeldSpeech({ rate: sampleRate,
      onStart: () => this.port.postMessage({ type: 'speech_start' }),
      onSegment: (pcm, timing) => this.port.postMessage({ type: 'segment', pcm, timing }, [pcm.buffer]),
    });
    this.segmenter = new SpeechSegments({ rate: sampleRate,
      onStart: () => this.port.postMessage({ type: 'speech_start' }),
      onSegment: (pcm, timing) => this.port.postMessage({ type: 'segment', pcm, timing }, [pcm.buffer]),
      // New audio of the running utterance for rolling transcription (see partialTranscript.js).
      chunkMs: CHUNK_MS, onChunk: (pcm, meta) => this.port.postMessage({ type: 'chunk', pcm, pause: meta.pause }, [pcm.buffer]),
      // A short pause: ask the page whether the sentence is finished (Smart Turn); its answer comes back as 'verdict'.
      onPause: (id, pcm) => this.port.postMessage({ type: 'pause', id, pcm }, [pcm.buffer]),
    });
    // While Kairos speaks the segmenter rests and this listens for the user over the echo (speechSegments.js).
    this.bargeIn = new BargeIn({ rate: sampleRate,
      onDuck: () => this.port.postMessage({ type: 'barge_duck' }),
      onClear: () => this.port.postMessage({ type: 'barge_clear' }),
      onBarge: ({ parts, voiced }) => {
        this.barge = false;
        this.port.postMessage({ type: 'barge_in' });
        this.segmenter.begin(parts, voiced);
      } });
    this.port.onmessage = ({ data }) => {
      if (data.type === 'enabled' && data.value !== this.enabled) {
        this.enabled = data.value; this.segmenter.reset(true);
        if (!this.enabled) this.held.cancel();
      }
      if (data.type === 'barge' && data.value !== this.barge) {
        this.barge = data.value && this.enabled && !this.manual;
        if (this.barge) this.bargeIn.reset(this.segmenter.noise);
      }
      if (data.type === 'smart_turn') this.segmenter.smartTurn(data.value);
      if (data.type === 'verdict') this.segmenter.answer(data.id, data.complete);
      // A caller that wants a longer end-of-speech wait than the call's 700 ms (Open Mic keeps its 900 ms).
      if (data.type === 'silence' && data.value > 0) this.segmenter.silence = sampleRate * data.value / 1000;
      if (data.type === 'mode') { this.manual = data.value === 'hold'; this.held.cancel(); this.segmenter.reset(true); }
      if (data.type === 'hold_start' && this.enabled && this.manual) this.held.begin();
      if (data.type === 'hold_end') this.held.release();
      if (data.type === 'hold_cancel') this.held.cancel();
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.enabled || !channel) return true;
    let rms;
    if (this.barge && !this.segmenter.active) rms = this.bargeIn.push(channel);
    else if (!this.manual || !this.ready) rms = this.segmenter.push(channel);
    else { let square = 0; for (const value of channel) square += value*value; rms = Math.sqrt(square/channel.length); this.held.push(channel); }
    if (!this.ready && this.segmenter.calibrated >= sampleRate * .2) { this.ready = true; this.port.postMessage({ type: 'ready' }); }
    this.levelSamples += channel.length;
    if (this.levelSamples >= sampleRate * .05) {
      this.levelSamples = 0; this.port.postMessage({ type: 'level', level: Math.min(1, rms * 12) });
    }
    return true;
  }
}
registerProcessor('kairos-call-capture', KairosCallProcessor);
