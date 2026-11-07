// Advice from each model's recent runs (Session Usage and Model Tracking, unit 7, 2026-11-07). Advice only
// (decision 4): it ranks and notes, it never switches a model. Every switch is the person's click, and the
// cost of one (the next reply re-reads the whole chat without the prompt cache) is said where it is offered.
import { ERROR_WORDS, seconds } from './modelStats.js';

// A short note for a picker row or a fallback choice: "24 runs, none failed, first output 0.6 s".
export function adviceNote(stat) {
  if (!stat || !stat.runs) return 'No runs in the last 7 days';
  if (!stat.enough_data) return `Not enough data yet (${stat.runs} run${stat.runs === 1 ? '' : 's'})`;
  const parts = [`${stat.runs} runs`, stat.failed ? `${stat.failed} failed` : 'none failed'];
  if (Number.isFinite(stat.ttft_median_s)) parts.push(`first output ${seconds(stat.ttft_median_s)}`);
  else if (Number.isFinite(stat.tokens_per_second_median)) parts.push(`${Math.round(stat.tokens_per_second_median)} tok/s`);
  return parts.join(', ');
}

function successRate(stat) {
  return stat?.enough_data && stat.runs ? 1 - (stat.failed || 0) / stat.runs : null;
}

// The fallback choices, best first: models with enough data by recent success, then by faster first output;
// models without enough data after them, in their given order. Returns [{ endpoint, stat, note }].
export function rankAlternatives(endpoints, statsByEndpoint = {}) {
  const rows = endpoints.map((endpoint, index) => {
    const stat = statsByEndpoint[endpoint.id] || null;
    return { endpoint, stat, note: adviceNote(stat), index, success: successRate(stat),
      ttft: Number.isFinite(stat?.ttft_median_s) ? stat.ttft_median_s : Infinity };
  });
  rows.sort((a, b) => {
    if ((a.success === null) !== (b.success === null)) return a.success === null ? 1 : -1;
    if (a.success === null) return a.index - b.index;
    if (Math.abs(a.success - b.success) > 1e-9) return b.success - a.success;
    if (a.ttft !== b.ttft) return a.ttft - b.ttft;
    return a.index - b.index;
  });
  return rows.map(({ endpoint, stat, note }) => ({ endpoint, stat, note }));
}

// Has this model failed repeatedly? At least 3 of its last 10 runs failed, and the latest did. Returns
// { failed, of, kind } or null.
export function repeatedFailure(stat) {
  const recent = stat?.recent_outcomes || [];
  if (recent[0] !== 'failed') return null;
  const failed = recent.filter(outcome => outcome === 'failed').length;
  if (failed < 3) return null;
  const top = Object.entries(stat.failures_by_class || {}).sort((a, b) => b[1] - a[1])[0];
  return { failed, of: recent.length, kind: top ? (ERROR_WORDS[top[0]] || top[0]) : null };
}

// What a switch costs, in words: the chat is read again without the prompt cache.
export function switchCostText(usedTokens) {
  const size = Number.isFinite(usedTokens) && usedTokens > 0 ? ` (about ${Math.round(usedTokens).toLocaleString('en-US')} tokens)` : '';
  return `Switching means the next reply reads this whole chat again without the prompt cache${size}.`;
}

// The suggestion under a failed reply, or '' when the model has not failed repeatedly.
export function switchSuggestion(stat, name, usedTokens) {
  const failing = repeatedFailure(stat);
  if (!failing) return '';
  return `${name || 'This model'} has failed ${failing.failed} of its last ${failing.of} runs${failing.kind ? `, mostly ${failing.kind}` : ''}. `
    + `Another model may do better. ${switchCostText(usedTokens)}`;
}
