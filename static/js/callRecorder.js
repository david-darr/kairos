// Direct 16 kHz PCM; no per-turn codec, decodeAudioData or resampling contexts.
import { getInputDevice, setInputDevice, encodeWav } from './voiceInput.js';

export function isCallRecordingSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);
}
export function createCallRecorder({ onLevel, onSpeechStart, onSegment, onChunk, onPause, onBargeIn, onBargeDuck, onBargeClear, onError, mode = 'automatic', silenceMs = 0 } = {}) {
  let stream = null, context = null, source = null, node = null, gain = null, closed = false, enabled = false, settleReady = null, readyTimer = null;
  const close = () => {
    closed = true; enabled = false;
    clearTimeout(readyTimer); settleReady?.(); settleReady = null;
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); node = null; }
    source?.disconnect(); gain?.disconnect(); source = gain = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    context?.close().catch(() => {}); context = null;
  };
  return {
    async start() {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
      const device = getInputDevice();
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: device ? { ...audio, deviceId: { exact: device } } : audio }); }
        catch (error) { if (!device || error.name === 'NotAllowedError') throw error; setInputDevice(''); stream = await navigator.mediaDevices.getUserMedia({ audio }); }
        if (closed) { stream.getTracks().forEach(track => track.stop()); stream = null; return; }
        const active = context = new AudioContext({ sampleRate: 16000 });
        if (active.sampleRate !== 16000) throw new Error('This browser cannot capture call audio at 16 kHz. Use the Kairos desktop app.');
        await active.audioWorklet.addModule('/static/js/callAudioProcessor.js');
        if (closed) return;
        source = active.createMediaStreamSource(stream);
        node = new AudioWorkletNode(active, 'kairos-call-capture', { channelCount: 1, numberOfInputs: 1, numberOfOutputs: 1 });
        const ready = new Promise((resolve, reject) => {
          settleReady = resolve;
          // A context still waiting for a tap (a phone, or a page opened from a notification) is "locked", not broken:
          // the call screen then asks for one tap instead of blaming the microphone.
          readyTimer = setTimeout(() => reject(active.state === 'running' ? new Error('Microphone capture did not start. Check your input device and try again.')
            : Object.assign(new Error('Tap to start the call.'), { name: 'AudioLocked' })), 5000);
        });
        node.port.onmessage = ({ data }) => {
          if (closed || !enabled) return;
          if (data.type === 'ready') { clearTimeout(readyTimer); settleReady?.(); settleReady = null; }
          if (data.type === 'level') onLevel?.(data.level);
          if (data.type === 'speech_start') onSpeechStart?.();
          if (data.type === 'chunk') onChunk?.(data.pcm, data.pause);
          if (data.type === 'pause') onPause?.(data.id, data.pcm);
          if (data.type === 'barge_in') onBargeIn?.();
          if (data.type === 'barge_duck') onBargeDuck?.();
          if (data.type === 'barge_clear') onBargeClear?.();
          // The raw samples ride along (third argument) so a rolling transcript can send just the tail.
          if (data.type === 'segment') onSegment?.(data.pcm.length ? encodeWav(data.pcm, 16000) : null, data.timing, data.pcm.length ? data.pcm : null);
        };
        node.onprocessorerror = () => { close(); onError?.(new Error('Microphone processing stopped. End the call and try again.')); };
        gain = active.createGain(); gain.gain.value = 0;
        source.connect(node); node.connect(gain); gain.connect(active.destination);
        enabled = true; node.port.postMessage({ type: 'mode', value: mode }); if (silenceMs > 0) node.port.postMessage({ type: 'silence', value: silenceMs }); node.port.postMessage({ type: 'enabled', value: true });
        // The worklet's first message is the proof the context runs. resume() is asked for but never waited on: on a
        // phone with no recent tap it can stay pending for good, and the 5 s timer above turns that into AudioLocked.
        active.resume().catch(() => {});
        await ready;
      } catch (error) { close(); throw error; }
    },
    // `barge` keeps the microphone open while Kairos speaks: no segmenting, only a watch for the user's voice over the echo.
    setEnabled(value, barge = false) { enabled = !!value && !closed; node?.port.postMessage({ type: 'enabled', value: enabled }); node?.port.postMessage({ type: 'barge', value: enabled && !!barge }); },
    // End of turn by meaning: on, the processor asks onPause(id, pcm) at a short pause; answer with verdict(id, complete).
    setSmartTurn(value) { node?.port.postMessage({ type: 'smart_turn', value: !!value }); },
    verdict(id, complete) { if (!closed) node?.port.postMessage({ type: 'verdict', id, complete: !!complete }); },
    beginHold() { if (enabled && !closed) node?.port.postMessage({ type: 'hold_start' }); },
    endHold() { if (!closed) node?.port.postMessage({ type: 'hold_end' }); },
    cancelHold() { node?.port.postMessage({ type: 'hold_cancel' }); },
    close,
  };
}
