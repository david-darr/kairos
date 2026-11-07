// Chat details (Session Usage and Model Tracking, unit 1, 2026-11-07): what the context pill opens. Built
// after Hermes mobile's Session Details (David, 2026-11-07) in Kairos's own look: a Context card (the fill,
// one stacked bar by part, each part's tokens), a Model card and a Usage card. A popover on desktop, a full
// sheet on a phone (chat.css). Every figure is read from the chat's recorded runs
// (GET /api/sessions/{id}/usage) and says so; a figure the provider never reported shows "n/a", never 0.
import { el } from './api.js';
import { costText, costSource } from './modelStats.js';

export const NA = 'n/a';
// Connections that build their own requests: Kairos cannot split their window by part.
const SELF_BUILT = ['claude_cli', 'codex_cli', 'antigravity_cli'];

export function formatCount(n) {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : NA;
}

// 79,400 -> "79K", 8,900 -> "8.9K", 1,250,000 -> "1.3M": the short form the Context card uses.
export function formatShort(n) {
  if (!Number.isFinite(n)) return NA;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function formatSeconds(s) {
  if (!Number.isFinite(s)) return NA;
  return s < 10 ? `${s.toFixed(2)} s` : `${s.toFixed(1)} s`;
}

export function formatRate(r) {
  return Number.isFinite(r) ? `${r.toFixed(1)} tok/s` : NA;
}

export function formatPercent(p) {
  return Number.isFinite(p) ? `${p}%` : NA;
}

// "3 of 5 runs reported usage": said whenever a sum leaves some runs out, so a partial total is never
// read as the whole.
export function coverageNote(usage) {
  if (!usage || !usage.runs) return '';
  if (usage.reported_runs === usage.runs) return '';
  if (!usage.reported_runs) return 'The provider reported no token counts for this chat.';
  return `Token counts cover ${usage.reported_runs} of ${usage.runs} recorded runs; the others reported none.`;
}

// The Context card's parts: [key, label, tokens, estimated]. Until the window is split by part, the whole
// measured prompt is one part.
export function contextParts(context) {
  if (!context || !Number.isFinite(context.used_tokens)) return [];
  const parts = Array.isArray(context.parts) ? context.parts.filter(p => Number.isFinite(p.tokens)) : [];
  if (parts.length) return parts.map(p => [p.key, p.label, p.tokens, !!p.estimated]);
  return [['whole', 'Whole prompt', context.used_tokens, false]];
}

// The Model card's rows: [label, value].
export function modelRows(model, context) {
  const m = model || {};
  const windowTokens = Number.isFinite(m.context_window) ? m.context_window : context?.capacity_tokens;
  return [
    ['Model', m.model || NA],
    ['Provider', m.provider || NA],
    ['Context window', Number.isFinite(windowTokens) ? `${formatShort(windowTokens)}${m.context_window_estimated || context?.estimated_capacity ? ' (estimated)' : ''}` : 'unknown'],
  ];
}

// What each side call was for (unit 2's `purpose` labels), in words.
export const PURPOSES = { compact: 'compaction', open_mic_summary: 'voice summary', chat_summary: 'chat summary', model_test: 'model test' };

export function sideCalls(usage) {
  if (!Number.isFinite(usage?.side_runs)) return NA;
  const kinds = Object.entries(usage.side_purposes || {}).map(([purpose, n]) => `${n} ${PURPOSES[purpose] || purpose.replace(/_/g, ' ')}`);
  return kinds.length ? `${usage.side_runs} (${kinds.join(', ')})` : String(usage.side_runs);
}

// The newest compaction, in words: [value, hint]. Compaction never shows in the chat itself, so this row is
// where a curious person can see that it happened and what it saved.
const COMPACTED_BY = { auto: 'Automatic', manual: 'By you', cli: 'By Claude Code' };
export function lastCompaction(record) {
  if (!record) return ['none', 'This chat has not been compacted'];
  const who = COMPACTED_BY[record.trigger] || 'Automatic';
  const before = Number.isFinite(record.tokens_before) ? formatShort(record.tokens_before) : null;
  const after = Number.isFinite(record.tokens_after) ? `${record.tokens_after_estimated ? '~' : ''}${formatShort(record.tokens_after)}` : null;
  const size = before && after ? `, ${before} to ${after} tokens` : before ? `, from ${before} tokens` : '';
  const hint = record.method === 'cli' ? 'Claude Code shortened its own context during a reply'
    : record.method === 'prune' ? 'Older tool results were shortened for the model, with no model call'
    : record.written_ahead ? 'Summarised in the background before it was needed, so no message waited for it'
    : 'Older turns were summarised for the model';
  return [`${who}${size}`, `${hint}. The full conversation stays in the chat.`];
}

// The Usage card's rows, in order: [label, value, hint]. Pure, so a Node test can check it.
export function usageRows(usage) {
  if (!usage) return [];
  const last = usage.last_reply || null;
  const [compacted, compactedHint] = lastCompaction(usage.last_compaction);
  return [
    ['Calls', formatCount(usage.runs), 'Every recorded model run in this chat'],
    ['Turns', formatCount(usage.turns), 'Your messages and the replies to them'],
    ['Input', formatCount(usage.input_tokens), 'Every token the requests carried, cached part included'],
    ['Output', formatCount(usage.output_tokens)],
    ['Cache read', formatCount(usage.cache_read_tokens)],
    ['Cache write', formatCount(usage.cache_write_tokens)],
    ['Cache hit', formatPercent(usage.cache_hit_percent), 'Cache reads over input, for runs that reported both'],
    ['Tool calls', formatCount(usage.tool_calls)],
    ['Compactions', formatCount(usage.compactions)],
    ['Last compaction', compacted, compactedHint],
    ['Helper runs', formatCount(usage.helper_runs)],
    ['Side calls', sideCalls(usage), 'Model calls that were not a turn: compactions, summaries'],
    ['Side call tokens', formatCount(usage.parts?.side?.total_tokens), 'Included in the totals above'],
    ['First output', last ? formatSeconds(last.ttft_seconds) : NA, 'Last reply: time from sending to the first visible text'],
    ['Speed', last ? formatRate(last.tokens_per_second) : NA, 'Last reply; n/a when it arrived in one piece'],
    ['Cost', usage.cost ? costText(usage.cost) : NA, costSource(usage.cost) || 'Priced when each run is recorded'],
  ];
}

function card(title, children) {
  return el('section', { class: 'usage-card' }, [el('h3', { class: 'usage-card-title', text: title }), ...children]);
}

function rowList(rows, kind) {
  const list = el('dl', { class: `usage-meter-rows usage-${kind}-rows` });
  for (const [label, value, hint] of rows) {
    list.append(el('div', { class: 'usage-meter-row', title: hint || '' }, [
      el('dt', { text: label }),
      el('dd', { class: value === NA || value === 'unknown' ? 'is-na' : '', text: value }),
    ]));
  }
  return list;
}

function contextCard(context, kind = null) {
  if (!context || !Number.isFinite(context.used_tokens)) {
    return card('Context', [el('p', { class: 'usage-meter-empty', text: 'No context reading for this chat yet.' })]);
  }
  const capacity = Number.isFinite(context.capacity_tokens) ? context.capacity_tokens : null;
  const percent = Number.isFinite(context.percent) ? context.percent : null;
  const head = el('div', { class: 'usage-context-head' }, [
    el('strong', { class: 'usage-context-used', text: formatShort(context.used_tokens) }),
    el('span', { class: 'usage-context-of', text: capacity ? `of ${formatShort(capacity)}` : 'window unknown' }),
    el('span', { class: 'usage-context-percent', text: percent !== null ? `${Math.round(percent)}%` : '' }),
  ]);
  const parts = contextParts(context);
  const bar = el('div', { class: 'usage-context-bar', role: 'img',
    'aria-label': percent !== null ? `${percent}% of the context window in use` : 'Context in use' });
  const scale = capacity || context.used_tokens || 1;
  parts.forEach(([key, label, tokens], index) => {
    const segment = el('span', { class: 'usage-context-segment', 'data-part': key, 'data-index': String(index), title: `${label}: ${formatCount(tokens)}` });
    segment.style.width = `${Math.max(0, Math.min(100, (tokens / scale) * 100))}%`;
    bar.append(segment);
  });
  const list = el('ul', { class: 'usage-context-parts' });
  parts.forEach(([key, label, tokens, estimated], index) => list.append(el('li', { class: 'usage-context-part' }, [
    el('span', { class: 'usage-context-dot', 'data-part': key, 'data-index': String(index), 'aria-hidden': 'true' }),
    el('span', { class: 'usage-context-label', text: label }),
    el('span', { class: 'usage-context-tokens', text: `${estimated ? '~' : ''}${formatShort(tokens)}` }),
  ])));
  const split = parts.length > 1 ? 'Parts are estimated from what Kairos sends; the total is measured.'
    : SELF_BUILT.includes(kind) ? 'This model builds its own requests, so only the total is known.' : '';
  const basis = [context.estimated_capacity ? 'Window size estimated.' : capacity ? 'Window size reported by the provider.' : '', split]
    .filter(Boolean).join(' ');
  return card('Context', [head, bar, list, ...(basis ? [el('p', { class: 'usage-meter-source', text: basis })] : [])]);
}

// The whole body: three cards, where the figures come from, and Compact when offered.
export function renderUsage(usage, { context = null, compact = null } = {}) {
  const body = el('div', { class: 'usage-meter-body' });
  const reading = context || usage?.context || null;
  body.append(contextCard(reading, usage?.model?.kind));
  body.append(card('Model', [rowList(modelRows(usage?.model, reading), 'model')]));
  const usageChildren = [];
  if (!usage) usageChildren.push(el('p', { class: 'usage-meter-empty', text: 'Usage could not be read for this chat.' }));
  else if (!usage.runs) usageChildren.push(el('p', { class: 'usage-meter-empty', text: 'No recorded runs yet. Figures appear after the first reply.' }));
  else {
    usageChildren.push(rowList(usageRows(usage), 'usage'));
    const note = coverageNote(usage);
    if (note) usageChildren.push(el('p', { class: 'usage-meter-note', text: note }));
  }
  body.append(card('Usage', usageChildren));
  body.append(el('p', { class: 'usage-meter-source', text: 'Source: this chat\'s recorded runs, as each provider reported them. n/a means not reported.' }));
  if (compact) body.append(compact);
  return body;
}
