// Client side of end-of-turn by meaning (core/turn_detect.py behind POST /api/speech/turn). No imports, so the call
// dialog, Open Mic and the tests all share it with their own transport:
//   const turn = createTurnEndpoint({ post: (wav, signal) => Promise<{available, complete, probability}>, encode: pcm => wav });
//   const verdict = await turn.ask(pcm);   // {complete, probability} or null
// null means "no opinion" (not set up, too slow, failed): the caller then waits out its ordinary silence exactly as it
// did before Smart Turn existed. The endpoint latches itself off when the server says it is unavailable or keeps failing,
// so a missing model or onnxruntime costs one request, not one per pause.
export const ASK_TIMEOUT_MS = 700;   // a verdict later than this is worth less than the silence wait it replaces
const FAILURES_BEFORE_OFF = 3;

export function createTurnEndpoint({ post, encode, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  let off = false, failures = 0;
  return {
    get off() { return off; },
    turnOff() { off = true; },
    async ask(pcm) {
      if (off || !pcm || !pcm.length) return null;
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const answer = await post(encode(pcm), abort.signal);
        failures = 0;
        if (!answer || answer.available === false) { off = true; return null; }
        return { complete: !!answer.complete, probability: answer.probability };
      } catch {
        if (++failures >= FAILURES_BEFORE_OFF) off = true;
        return null;
      } finally { clearTimeout(timer); }
    },
  };
}

export async function postTurn(wav, signal) {
  const form = new FormData();
  form.append('audio', wav, 'turn.wav');
  const res = await fetch('/api/speech/turn', { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error('turn');
  return res.json();
}
