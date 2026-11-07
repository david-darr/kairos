// Instant acknowledgement: a short, natural sound while the real answer is still being written.
//
// When no first sentence is ready FILLER_AFTER_MS after the user's turn ended, Kairos says something small ("Mm, let me
// think.", "Okay.") so the line never goes dead. The phrases and the choice of one live on the server
// (core/voice_fillers.py: varied, never the same twice in a row, fitted to a request or a question, rendered once per
// voice and cached). This is the timing: arm it when a turn is sent, tell it when a sentence is ready, and it plays
// the clip only if the answer is still not there. A quick answer cancels it before anyone hears it.
import { readEvents } from './callTransport.js';

export const FILLER_AFTER_MS = 500;

// {filler, sample_rate, audio...} events -> a clip. `text` only (a device voice) or text plus PCM (a neural voice).
// Null when the server had nothing playable (a neural phrase not cached yet).
export function clipFromEvents(events) {
  let id = '', text = '', rate = 0, missing = false; const parts = [];
  for (const event of events) {
    if (event.filler) { id = event.filler.id || ''; text = event.filler.text || ''; }
    if (event.sample_rate) rate = event.sample_rate;
    if (event.cached === false) missing = true;
    if (event.audio) parts.push(Uint8Array.from(atob(event.audio), c => c.charCodeAt(0)));
  }
  if (!id || !text || missing) return null;
  if (!parts.length) return { id, text };
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  const count = Math.floor(bytes.length / 2), view = new DataView(bytes.buffer), samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return rate ? { id, text, rate, samples } : null;
}

// Ask the server for a filler. `selection` is the call's voice choice ({provider, model, voice}).
export async function fetchFillerClip({ selection, last, text }, signal) {
  const events = [], neural = selection?.provider === 'neural';
  await readEvents('/api/agent-calls/filler', { last: last || null, text: String(text || '').slice(0, 2000), ...(neural ? { model: selection.model, voice: selection.voice } : {}) }, signal, event => events.push(event));
  return clipFromEvents(events);
}

// The timing. `fetchClip(last, text)` returns a clip (or null); `play(clip)` speaks it; `blocked()` is true while the
// user is talking again or the assistant is muted. Timers are injectable so the rules can be tested without waiting.
export function createFillerGate({ fetchClip, play, blocked = () => false, after = FILLER_AFTER_MS, setTimer = setTimeout, clearTimer = clearTimeout, onPlayed = () => {} } = {}) {
  let generation = 0, timer = null, last = null, pending = null;
  const disarm = () => { generation++; clearTimer(timer); timer = null; pending = null; };
  return {
    // A turn was sent. `text` is what the user said. Work updates and muted assistants never get a filler.
    arm({ text = '', workUpdate = false, muted = false } = {}) {
      disarm();
      if (workUpdate || muted) return false;
      const mine = generation;
      // Ask now (a local, cached lookup) so the clip is in hand when the half second is up.
      pending = Promise.resolve().then(() => fetchClip(last, text)).catch(() => null);
      const request = pending;
      timer = setTimer(async () => {
        timer = null;
        const clip = await request;
        if (mine !== generation || !clip || blocked()) return;
        last = clip.id; generation++; pending = null;
        play(clip); onPlayed(clip);
      }, after);
      return true;
    },
    // The first sentence of the answer is ready, or its first words have arrived (a sentence follows within a moment, and an
    // acknowledgement started now would only hold it back): no acknowledgement.
    sentenceReady() { disarm(); },
    // Interrupted, hung up, or anything else that makes a filler wrong.
    cancel() { disarm(); },
    get last() { return last; },
    get armed() { return timer != null; },
  };
}
