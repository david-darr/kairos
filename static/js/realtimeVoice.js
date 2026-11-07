// Realtime speech-to-speech in the call dialog (build spec 6b, Track A). The browser talks to Kairos only: microphone
// audio goes up a websocket as 16 kHz PCM16, the model's audio comes back as small base64 chunks. The provider key
// never reaches the page. Same shape as callLive.js's liveVoice so the call dialog can use either.
//
// Barge-in: when the provider says the person started talking (server or semantic VAD), every scheduled chunk is
// stopped on the spot and the server is told how much of the reply was actually played, so it can truncate the
// assistant's item to what was heard (the OpenAI conversation.item.truncate pattern).

// Pure bookkeeping for what has been scheduled and what has been heard; the browser clock is passed in.
export class PlaybackTracker {
  constructor() { this.reset(); }
  reset() { this.itemId = null; this.firstStart = null; this.cursor = 0; this.scheduledMs = 0; }
  // A chunk of `ms` milliseconds arrives at `now` seconds; returns when it should start (seconds).
  schedule(itemId, ms, now) {
    if (itemId !== this.itemId) { this.reset(); this.itemId = itemId; }
    const start = Math.max(this.cursor, now);
    if (this.firstStart === null) this.firstStart = start;
    this.cursor = start + ms / 1000;
    this.scheduledMs += ms;
    return start;
  }
  // Milliseconds of the current item the person has heard at `now`, never more than was scheduled.
  playedMs(now) {
    if (this.firstStart === null) return 0;
    return Math.max(0, Math.min(this.scheduledMs, (now - this.firstStart) * 1000));
  }
  get active() { return this.firstStart !== null; }
}

export function pcm16ToFloat(buffer) {
  const view = new Int16Array(buffer);
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) out[i] = view[i] / 32768;
  return out;
}

export function base64ToBuffer(text) {
  const raw = atob(text); const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export function realtimeVoice(onState, onCaption, onLevel, onError, onInfo, deps = {}) {
  const makeSocket = deps.makeSocket || (url => new WebSocket(url));
  const makeContext = deps.makeContext || (options => new AudioContext(options));
  const getMedia = deps.getMedia || (constraints => navigator.mediaDevices.getUserMedia(constraints));
  let socket = null, stream = null, capture = null, playback = null, node = null, master = null, analyser = null;
  let generation = 0, assistantMuted = false, microphoneMuted = false, frame = null, rejectStart = null;
  const tracker = new PlaybackTracker();
  let sources = [], speaking = false, lastError = '';

  const stopSources = () => {
    for (const source of sources) { try { source.stop(); } catch { /* already finished */ } source.disconnect?.(); }
    sources = [];
  };
  const cleanup = () => {
    generation += 1; cancelAnimationFrame?.(frame); frame = null;
    rejectStart?.(new Error('Realtime call ended.')); rejectStart = null;
    stopSources(); tracker.reset();
    try { socket?.close(); } catch { /* already closed */ }
    if (node) { node.port.onmessage = null; node.disconnect(); }
    stream?.getTracks().forEach(track => track.stop());
    capture?.close().catch?.(() => {}); playback?.close().catch?.(() => {});
    socket = stream = capture = playback = node = master = analyser = null; speaking = false;
  };

  function interruptPlayback() {
    const now = playback ? playback.currentTime : 0;
    const itemId = tracker.itemId, played = Math.round(tracker.playedMs(now));
    stopSources(); tracker.reset();
    if (speaking) { speaking = false; onState('listening'); }
    return { itemId, played };
  }

  function handle(mine, message) {
    if (mine !== generation) return;
    if (message.type === 'audio') {
      if (assistantMuted || !playback) return;
      const samples = pcm16ToFloat(base64ToBuffer(message.data));
      const buffer = playback.createBuffer(1, samples.length, message.rate);
      buffer.copyToChannel(samples, 0);
      const source = playback.createBufferSource(); source.buffer = buffer; source.connect(master);
      const startAt = tracker.schedule(message.item_id || '', samples.length / message.rate * 1000, playback.currentTime);
      source.onended = () => { sources = sources.filter(item => item !== source); if (!sources.length && speaking && !tracker.active) { speaking = false; onState('listening'); } };
      source.start(startAt); sources.push(source);
      if (!speaking) { speaking = true; onState('speaking'); }
    } else if (message.type === 'speech_started') {
      const { itemId, played } = interruptPlayback();
      if (itemId !== null && socket?.readyState === 1) socket.send(JSON.stringify({ type: 'played', item_id: message.item_id || itemId, ms: played }));
    } else if (message.type === 'user_text') onCaption('You', message.delta);
    else if (message.type === 'assistant_text') onCaption('Agent', message.delta);
    else if (message.type === 'error') onError(message.message || 'Realtime voice reported an error.');
    else if (message.type === 'ended') { cleanup(); onState('ended'); }
    else if (message.type === 'work') onInfo?.({ work: message });
  }

  return {
    // The same arguments as liveVoice.start; `endpoint` is the realtime connection.
    async start(id, endpoint, voice, paidConsent) {
      cleanup(); lastError = ''; const mine = generation;
      try {
        stream = await getMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        if (mine !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        capture = makeContext({ sampleRate: 16000 });
        if (capture.sampleRate !== 16000) throw new Error('This browser cannot capture call audio at 16 kHz. Use the Kairos desktop app.');
        await capture.audioWorklet.addModule('/static/js/realtimeCapture.js');
        playback = makeContext({}); await playback.resume();
        master = playback.createGain(); analyser = playback.createAnalyser(); analyser.fftSize = 256;
        master.connect(analyser); analyser.connect(playback.destination);
        const scheme = (deps.location || location).protocol === 'https:' ? 'wss' : 'ws';
        socket = makeSocket(`${scheme}://${(deps.location || location).host}/api/agent-calls/${id}/realtime`);
        const opened = new Promise((resolve, reject) => { rejectStart = reject; socket.onopen = resolve; socket.onerror = () => reject(new Error('Realtime voice could not connect.')); });
        opened.catch(() => {});
        await opened;
        let resolveReady; const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectStart = reject; }); ready.catch(() => {});
        const timeout = setTimeout(() => rejectStart?.(new Error('Realtime voice startup timed out.')), 20000);
        socket.onmessage = event => {
          let message; try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === 'ready') { clearTimeout(timeout); onInfo?.(message); onState('listening'); resolveReady(); return; }
          if (message.type === 'error') lastError = message.message || '';
          handle(mine, message);
        };
        socket.onclose = () => { if (mine === generation) { clearTimeout(timeout); rejectStart?.(new Error(lastError || 'Realtime call ended.')); onError('Realtime voice connection lost. End the call and reconnect.'); } };
        socket.send(JSON.stringify({ type: 'start', endpoint_id: endpoint, voice, consent: !!paidConsent }));
        await ready; rejectStart = null;
        const source = capture.createMediaStreamSource(stream);
        node = new (deps.WorkletNode || AudioWorkletNode)(capture, 'kairos-realtime-capture', { channelCount: 1, numberOfInputs: 1, numberOfOutputs: 0 });
        node.port.onmessage = ({ data }) => {
          if (mine !== generation || data.type !== 'pcm' || microphoneMuted || socket?.readyState !== 1) return;
          socket.send(data.pcm);
        };
        source.connect(node); await capture.resume();
        const samples = new Float32Array(256);
        const measure = () => {
          if (mine !== generation) return;
          if (analyser) { analyser.getFloatTimeDomainData(samples); let sum = 0; for (const n of samples) sum += n * n; onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 7)); }
          frame = requestAnimationFrame(measure);
        };
        measure();
      } catch (error) { cleanup(); throw error; }
    },
    muteMicrophone(value) { microphoneMuted = !!value; stream?.getAudioTracks().forEach(track => { track.enabled = !value; }); try { socket?.send(JSON.stringify({ type: 'mute', value: !!value })); } catch { /* closed */ } },
    muteAssistant(value) { assistantMuted = !!value; if (value) interruptPlayback(); },
    // The call endpoint also ends the server session; closing the socket is enough for the provider side.
    stop() { try { socket?.send(JSON.stringify({ type: 'end' })); } catch { /* closed */ } cleanup(); },
  };
}
