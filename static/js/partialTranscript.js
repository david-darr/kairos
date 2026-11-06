// Transcribe while the user talks (Fluid Voice build order step 4).
//
// The call recorder hands this the utterance's audio as it arrives (about every second, and once more at the first
// pause). For each hand-off it asks /api/speech/partial about the audio since the last text it has COMMITTED, shows
// the result in the caption, and when two runs in a row agree on a whole segment it commits that segment and moves
// the window past it. At the end of the turn the final pass then has far less to do:
//
//   reuse      the last partial already covered every voiced sample (the pause-flush chunk usually does, ~400 ms
//              before the 700 ms endpoint), so its text IS the transcript: no upload, no recognition, no wait
//   tail       otherwise only the audio after the committed text is sent; the committed text is prepended
//   (null)     nothing usable (partials failed, were off, or never ran): the caller sends the whole clip, exactly
//              as it did before this existed
//
// Nothing here is allowed to make a turn worse than the whole-clip path. A failed partial marks that utterance as
// "send the whole clip"; three failures in a row, a 404, a recognizer slower than PARTIAL_MAX_RTF, or a CPU engine
// (which would only fight the real transcription for the one engine) switch rolling transcription off for the call.
import { encodeWav } from './voiceInput.js';

export const PARTIAL_MIN_WINDOW_MS = 600;     // less audio than this is not worth a request
export const PARTIAL_MAX_WINDOW_MS = 10000;   // an uncommitted window longer than this stops updating; the final pass takes it
export const PARTIAL_MAX_RTF = .6;            // recognition time / audio time; above it partials would only crowd the real pass
export const COMMIT_EDGE_MS = 500;            // a segment ending this close to the window's end may still change: not committed
export const PARTIAL_MAX_FAILURES = 3;        // consecutive failures before rolling transcription turns itself off for the call
const SAMPLES_PER_MS = 16;
const TRAILING_KEEP_MS = 160;                 // speechSegments.js keeps this much after the last voiced sample
const MIN_FINAL_SAMPLES = 3200;               // the server treats less than 0.2 s as "no speech"

const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const join = (...texts) => texts.map(text => String(text || '').trim()).filter(Boolean).join(' ');

export function createPartialTranscriber({ send, encode = encodeWav, onText = () => {}, now = () => performance.now(), maxRtf = PARTIAL_MAX_RTF } = {}) {
  const state = { disabled: '', failures: 0, rtf: null, runs: 0 };
  let current = null;

  function audioWindow(session, from, to) {
    const out = new Float32Array(to - from); let at = 0, offset = 0;
    for (const part of session.parts) {
      const end = offset + part.length;
      if (end > from && offset < to) { const slice = part.subarray(Math.max(0, from - offset), Math.min(part.length, to - offset)); out.set(slice, at); at += slice.length; }
      offset = end;
    }
    return out;
  }

  function run(session) {
    if (state.disabled || session.closed || session.failed) return;
    if (session.inflight) { session.dirty = true; return; }
    const from = session.committed, to = session.total, length = to - from;
    if (length < PARTIAL_MIN_WINDOW_MS * SAMPLES_PER_MS) return;
    if (length > PARTIAL_MAX_WINDOW_MS * SAMPLES_PER_MS) return;
    session.dirty = false;
    const controller = new AbortController(), started = now();
    const job = { end: to, cancelled: false, cancel() { job.cancelled = true; controller.abort(); } };
    job.promise = (async () => {
      try {
        const result = await send(encode(audioWindow(session, from, to), 16000), controller.signal);
        if (job.cancelled || result?.busy) return;
        if (typeof result?.text !== 'string') throw new Error('Invalid partial transcript');
        state.failures = 0; state.runs++; session.runs++;
        if (result.engine && result.engine !== 'cuda') state.disabled ||= 'cpu';   // the GPU server dropped out mid-call
        const audioMs = length / SAMPLES_PER_MS, took = Number(result.timings?.recognition_ms ?? now() - started);
        if (audioMs >= 1500) {
          const rtf = took / audioMs; state.rtf = state.rtf == null ? rtf : (state.rtf + rtf) / 2;
          if (state.rtf > maxRtf) state.disabled = 'slow';
        }
        const segments = (Array.isArray(result.segments) ? result.segments : []).filter(item => item && typeof item.text === 'string');
        let keep = 0;
        if (session.previous && segments.length > 1) {
          const limit = Math.min(segments.length - 1, session.previous.length);
          while (keep < limit && normalize(segments[keep].text) === normalize(session.previous[keep]) && segments[keep].end_ms <= audioMs - COMMIT_EDGE_MS) keep++;
        }
        if (keep) {
          session.committedText = join(session.committedText, segments.slice(0, keep).map(item => item.text).join(' '));
          session.committed = Math.min(to, from + Math.round(segments[keep - 1].end_ms * SAMPLES_PER_MS));
        }
        const rest = segments.slice(keep);
        session.previous = rest.map(item => item.text);
        session.tailText = segments.length ? rest.map(item => item.text).join(' ') : result.text.trim();
        session.coveredTo = to;
        session.caption = join(session.committedText, session.tailText);
        onText(session.caption, { committed: session.committedText });
      } catch (problem) {
        if (job.cancelled || problem?.name === 'AbortError') return;
        session.failed = true; state.failures++;
        if (problem?.status === 404 || state.failures >= PARTIAL_MAX_FAILURES) state.disabled = 'unavailable';
      } finally {
        if (session.inflight === job) session.inflight = null;
        if (session.dirty && !job.cancelled) run(session);
      }
    })();
    session.inflight = job;
  }

  function create() {
    const session = { parts: [], total: 0, committed: 0, committedText: '', tailText: '', caption: '', coveredTo: 0, previous: null,
      inflight: null, dirty: false, closed: false, failed: false, runs: 0, mode: '' };
    session.cancel = () => { session.closed = true; session.inflight?.cancel(); };
    // End of the turn. `pcm` is the finished segment (what the whole-clip path would upload); `sendFinal(wav)` is the
    // ordinary /transcribe call. Resolves {text, mode}, or null when the caller should send the whole clip itself.
    session.finalize = async (pcm, sendFinal) => {
      session.closed = true;
      const need = pcm.length - TRAILING_KEEP_MS * SAMPLES_PER_MS;
      const inflight = session.inflight;
      if (inflight) {
        // A run that already covers all the voiced audio is the best final there is: let it land. Anything older is dropped.
        if (inflight.end >= need) await inflight.promise.catch(() => {}); else inflight.cancel();
      }
      if (session.failed || !session.runs) return null;
      if (session.coveredTo >= need && session.caption) return { text: session.caption, mode: 'reuse' };
      if (session.committed > 0 && session.committed < pcm.length) {
        const tail = pcm.subarray(session.committed);
        if (tail.length < MIN_FINAL_SAMPLES) return { text: session.committedText, mode: 'committed' };
        return { text: join(session.committedText, await sendFinal(encode(tail, 16000))), mode: 'tail' };
      }
      return null;
    };
    return session;
  }

  return {
    state,
    // A new utterance started. Whatever the previous one left behind is dropped.
    begin() { current?.cancel(); current = create(); return current; },
    // New audio of the running utterance (the recorder's chunks, ~1 s apart and once at the first pause).
    push(pcm) {
      if (!current) current = create();
      if (current.closed) return;
      current.parts.push(pcm); current.total += pcm.length;
      run(current);
    },
    // Hand the finished utterance's session to its audio-queue entry; the next utterance starts a fresh one.
    take() { const taken = current; current = null; return taken; },
    cancel() { current?.cancel(); current = null; },
    // Off for the rest of the call. The in-process CPU recognizer runs at about real time (core/speech.py), so rolling
    // partials there would only compete with the real pass for the one engine; only a GPU server rolls by default.
    disable(reason) { state.disabled = reason; this.cancel(); },
    reset() { this.cancel(); state.disabled = ''; state.failures = 0; state.rtf = null; state.runs = 0; },
  };
}
