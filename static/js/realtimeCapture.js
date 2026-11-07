// AudioWorklet for realtime voice: the microphone as continuous 16 kHz PCM16 (40 ms blocks) plus a level, nothing else.
// The provider's own voice activity detection decides turns, so there is no segmenting here.
class KairosRealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Int16Array(640); this.filled = 0; this.sum = 0; this.count = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      this.block[this.filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.sum += sample * sample; this.count += 1;
      if (this.filled === this.block.length) {
        const out = this.block.slice();
        this.port.postMessage({ type: 'pcm', pcm: out.buffer, level: Math.sqrt(this.sum / this.count) }, [out.buffer]);
        this.filled = 0; this.sum = 0; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('kairos-realtime-capture', KairosRealtimeCapture);
