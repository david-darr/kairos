// Per-turn voice latency trace: when each stage of one spoken turn happened, from the end of the
// user's speech to the first sound and every later sentence. Pure bookkeeping with an injectable
// clock, so the stages can be unit tested without a microphone, a model or a speaker.
//
// Stages, in the order a turn normally reaches them:
//   speech_end      the user actually stopped talking (endpoint time minus the silence wait)
//   endpoint        the recorder decided the utterance was over
//   upload_sent     the audio left for recognition
//   transcript_back recognition returned text
//   turn_started    the turn request was sent to the model
//   first_token     the first reply text arrived
//   first_sentence  the first sentence (or first clause) was ready to speak
//   first_audio     the first sound played
//   sentence_start  each later sentence began (a list)
export const STAGES = ['speech_end', 'endpoint', 'upload_sent', 'transcript_back', 'turn_started', 'first_token', 'first_sentence', 'first_audio'];
const KEEP = 20;

export function createVoiceTrace({ now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), log = null, label = 'voice' } = {}) {
  const turns = [];
  const emit = log || ((line) => { try { console.debug(line); } catch { /* no console */ } });

  function begin(speechEndAt) {
    const trace = { id: turns.length ? turns[turns.length - 1].id + 1 : 1, marks: {}, sentences: [] };
    turns.push(trace);
    if (turns.length > KEEP) turns.shift();
    if (speechEndAt != null) trace.marks.speech_end = speechEndAt;
    return trace;
  }

  // First write wins: a stage is when it FIRST happened (a retried upload must not move the start).
  function mark(trace, stage, at = now()) {
    if (!trace || !STAGES.includes(stage)) return false;
    if (trace.marks[stage] != null) return false;
    trace.marks[stage] = at;
    return true;
  }

  function sentenceStart(trace, at = now()) {
    if (!trace) return;
    trace.sentences.push(at);
    if (trace.sentences.length === 1) mark(trace, 'first_audio', at);
  }

  // Milliseconds from the user's speech end (or the earliest mark when it is unknown) to each stage.
  function offsets(trace) {
    if (!trace) return {};
    const base = trace.marks.speech_end ?? Math.min(...Object.values(trace.marks), ...trace.sentences);
    const out = {};
    for (const stage of STAGES) if (trace.marks[stage] != null) out[stage] = Math.round(trace.marks[stage] - base);
    if (trace.sentences.length) out.sentence_start = trace.sentences.map(at => Math.round(at - base));
    return out;
  }

  // Time spent in each stage: the gap from the nearest earlier stage that was recorded.
  function spans(trace) {
    if (!trace) return {};
    const out = {}; let last = null;
    for (const stage of STAGES) {
      const at = trace.marks[stage];
      if (at == null) continue;
      if (last !== null) out[stage] = Math.round(at - last);
      last = at;
    }
    if (trace.sentences.length > 1) out.sentence_gaps = trace.sentences.slice(1).map((at, i) => Math.round(at - trace.sentences[i]));
    return out;
  }

  const SHORT = { endpoint: 'endpoint', upload_sent: 'upload', transcript_back: 'speech-to-text', turn_started: 'dispatch', first_token: 'first token', first_sentence: 'first sentence', first_audio: 'first audio' };
  function format(trace) {
    const gaps = spans(trace), parts = [];
    for (const stage of Object.keys(SHORT)) if (gaps[stage] != null) parts.push(`${SHORT[stage]} ${gaps[stage]} ms`);
    if (gaps.sentence_gaps?.length) parts.push(`later sentences +${gaps.sentence_gaps.join(', +')} ms`);
    return parts.join(' / ');
  }

  function report(trace) {
    if (!trace) return;
    emit(`[${label}-trace] turn=${trace.id} ${JSON.stringify(offsets(trace))}`);
  }

  return { begin, mark, sentenceStart, offsets, spans, format, report, get turns() { return turns; }, get last() { return turns[turns.length - 1] || null; }, reset() { turns.length = 0; } };
}
