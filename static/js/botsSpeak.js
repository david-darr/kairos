// Stable speech breaths. Only confirmed blocks play; at most three renders are in flight.
import { api } from './api.js';
import { createSpeaker, _forSpeech } from './voiceOutput.js';

export function createBlockQueue({ prepare, play, stop = () => {}, onError = () => {} }) {
  let blocks = [], confirmed = 0, played = 0, generation = 0, playing = false, dead = false;
  const pending = new Map();
  let abort = new AbortController();
  function prefetch() {
    const mine = generation;
    for (let i = played; i < Math.min(confirmed, played + 3); i++) {
      if (!pending.has(i)) {
        const text = blocks[i], signal = abort.signal;
        // Cache failures as values until consumed, avoiding unhandled rejections.
        pending.set(i, Promise.resolve().then(() => prepare(text, signal)).then(value => ({ value }), error => ({ error })));
      }
    }
    if (!playing && played < confirmed) drain(mine);
  }
  async function drain(mine) {
    playing = true;
    try {
      while (!dead && mine === generation && played < confirmed) {
        const item = await pending.get(played);
        if (dead || mine !== generation) return;
        if (item.error) throw item.error;
        await play(item.value, abort.signal);
        if (dead || mine !== generation) return;
        pending.delete(played++);
        prefetch();
      }
    } catch (error) {
      if (!dead && mine === generation && error.name !== 'AbortError') { cancel(); onError(error); }
    } finally {
      if (mine === generation) { playing = false; if (played < confirmed) prefetch(); }
    }
  }
  function cancel() { generation++; abort.abort(); abort = new AbortController(); stop(); blocks = []; pending.clear(); confirmed = played = 0; playing = false; }
  return {
    update(next, final = false) {
      if (dead) return;
      let common = 0;
      while (common < blocks.length && common < next.length && blocks[common] === next[common]) common++;
      // A rewritten final frame invalidates queued audio, including an in-flight render.
      // Never replay the already spoken prefix.
      if (common < confirmed) {
        const keep = Math.min(played, next.length);
        cancel(); played = keep;
      }
      blocks = [...next]; confirmed = Math.max(0, blocks.length - (final ? 0 : 1));
      prefetch();
    },
    cancel, destroy() { cancel(); dead = true; },
    get state() { return { played, confirmed, pending: pending.size }; },
  };
}

// Reading a bot's replies aloud follows the Voice in Settings > Speech: the bot's own voice when it has one, else the
// Voice's engine (Kokoro for Kairos Voice, ElevenLabs, Voicebox) when it is ready, else the device voice. A block the
// engine cannot speak (no engine yet) is read by the device voice instead of failing.
export function createReadAloud({ voiceId = '', onError = () => {}, request: ask = api } = {}) {
  let context, source, request = 0, dead = false, engine = null;
  const sources = new Set();
  const device = createSpeaker();
  const requests = new AbortController();
  const useEngine = () => engine ??= voiceId ? Promise.resolve(true)
    : ask('/api/agent-calls/voices', { toast: false }).then(c => !c?.error && !!c?.voices?.length && !!c?.models?.length).catch(() => false);
  const queue = createBlockQueue({
    onError,
    stop() { device.cancel(); try { source?.stop(); } catch {} source = null; for (const node of sources) { try { node.stop(); } catch {} } sources.clear(); },
    async prepare(text, signal) {
      if (!await useEngine()) return text;
      const spoken = _forSpeech(text);
      if (!spoken) return null;
      const response = await fetch('/api/bot-voice/speak/block', { method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: spoken, voice_id: voiceId || null }) });
      if (response.status === 409 && !voiceId) { engine = Promise.resolve(false); return text; }
      if (!response.ok) throw new Error('Speech could not load. Check the local voice engine.');
      return response.body;
    },
    async play(value, signal) {
      if (value === null) return;
      if (typeof value !== 'string') {
        // Same PCM16 protocol as the call speaker, with a three-response queue.
        // Playback starts at the first audio packet, while later breaths prefetch.
        context ||= new AudioContext(); await context.resume();
        const reader = value.getReader(), decoder = new TextDecoder();
        let text = '', rate = 0, carry = null, next = context.currentTime, total = 0, last = null;
        const cancel = () => { reader.cancel().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        const packet = line => {
          if (!line.trim() || signal.aborted) return;
          const item = JSON.parse(line); if (item.error) throw new Error(item.error);
          if (item.sample_rate) {
            if (!Number.isInteger(item.sample_rate) || item.sample_rate < 8000 || item.sample_rate > 96000 || rate && rate !== item.sample_rate) throw new Error('Voice audio format is unavailable.');
            rate = item.sample_rate;
          }
          if (!item.audio) return;
          if (!rate) throw new Error('Voice audio format is unavailable.');
          const raw = Uint8Array.from(atob(item.audio), char => char.charCodeAt(0)); total += raw.length;
          if (total > rate * 2 * 180) throw new Error('Voice audio exceeded its limit.');
          const bytes = new Uint8Array(raw.length + (carry === null ? 0 : 1));
          if (carry !== null) bytes[0] = carry;
          bytes.set(raw, carry === null ? 0 : 1); carry = bytes.length % 2 ? bytes.at(-1) : null;
          const size = Math.floor(bytes.length / 2); if (!size) return;
          const buffer = context.createBuffer(1, size, rate), samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
          for (let i = 0; i < size; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
          const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination); sources.add(node); last = node;
          node.onended = () => sources.delete(node);
          const at = Math.max(context.currentTime + .02, next); next = at + buffer.duration; node.start(at);
        };
        try {
          while (!signal.aborted) {
            const chunk = await reader.read(); text += decoder.decode(chunk.value, { stream: !chunk.done });
            let index;
            while ((index = text.indexOf('\n')) >= 0) { packet(text.slice(0, index)); text = text.slice(index + 1); }
            if (chunk.done) { if (text) packet(text); break; }
          }
          if (signal.aborted) return;
          if (carry !== null || !last) throw new Error('Voice audio is incomplete.');
          if (sources.has(last)) await new Promise(resolve => {
            const done = () => { sources.delete(last); signal.removeEventListener('abort', done); resolve(); };
            last.onended = done; signal.addEventListener('abort', done, { once: true });
          });
        } finally { signal.removeEventListener('abort', cancel); reader.cancel().catch(() => {}); reader.releaseLock(); }
        return;
      }
      return new Promise((resolve, reject) => {
        if (signal.aborted) return resolve();
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        signal.addEventListener('abort', done, { once: true });
        // One promise per device breath follows actual playback completion.
        const speaker = createSpeaker({ onEnd: done, onError: error => reject(new Error(String(error))) });
        device.cancel(); source = { stop: () => speaker.cancel() };
        speaker.feed(value); speaker.finish();
        if (!window.speechSynthesis) done();
      });
    },
  });
  return {
    // Full snapshots, never deltas: a late or rewritten final frame reconciles queued breaths.
    async update(text, final = false) {
      const mine = ++request;
      try {
        const result = await api('/api/bot-voice/speak/prepare', { method: 'POST', toast: false, signal: requests.signal,
          body: JSON.stringify({ text, voice_id: voiceId || null }) });
        if (!dead && mine === request) queue.update(result.blocks, final);
      } catch (error) { if (!dead && mine === request && error.name !== 'AbortError') onError(error); }
    },
    cancel() { request++; queue.cancel(); },
    destroy() { dead = true; requests.abort(); queue.destroy(); context?.close(); },
  };
}
