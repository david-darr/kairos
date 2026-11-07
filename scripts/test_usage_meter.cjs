// The chat usage meter's rows (static/js/usageMeter.js), without Electron: unknown is "n/a", never 0,
// and a partial total says so.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { el: () => ({ append() {} }), Number, Math, console };
vm.createContext(context);
const load = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
vm.runInContext(load('static/js/modelStats.js') + '\n' + load('static/js/usageMeter.js') + '\nthis.api = { usageRows, coverageNote, formatCount, formatRate, formatSeconds, formatShort, contextParts, modelRows, sideCalls, NA };', context);
const { usageRows, coverageNote, formatCount, formatRate, formatSeconds, formatShort, contextParts, modelRows, sideCalls, NA } = context.api;
const value = (rows, label) => rows.find(r => r[0] === label)?.[1];

// Known figures render; unknown ones say n/a.
const full = { runs: 3, reported_runs: 3, turns: 3, input_tokens: 182400, output_tokens: 9120, cache_read_tokens: 151300,
  cache_write_tokens: 0, cache_hit_percent: 83, tool_calls: 0, compactions: 0, helper_runs: 0,
  last_reply: { ttft_seconds: 1.42, tokens_per_second: 61.3 } };
let rows = usageRows(full);
assert.equal(value(rows, 'Input'), '182,400');
assert.equal(value(rows, 'Cache write'), '0', 'a reported zero is a real zero');
assert.equal(value(rows, 'Cache hit'), '83%');
assert.equal(value(rows, 'First output'), '1.42 s');
assert.equal(value(rows, 'Speed'), '61.3 tok/s');
assert.equal(coverageNote(full), '');

const none = { runs: 2, reported_runs: 0, turns: 2, input_tokens: null, output_tokens: null, cache_read_tokens: null,
  cache_write_tokens: null, cache_hit_percent: null, tool_calls: 0, compactions: 0, helper_runs: 0,
  last_reply: { ttft_seconds: null, tokens_per_second: null } };
rows = usageRows(none);
for (const label of ['Input', 'Output', 'Cache read', 'Cache write', 'Cache hit', 'First output', 'Speed']) {
  assert.equal(value(rows, label), NA, `${label} is n/a when unreported`);
}
assert.match(coverageNote(none), /reported no token counts/);
assert.match(coverageNote({ ...full, reported_runs: 2 }), /2 of 3/);

// A chat with no finished reply yet has no speed to show.
assert.equal(value(usageRows({ ...full, last_reply: null }), 'Speed'), NA);
assert.equal(formatCount(undefined), NA);
assert.equal(formatRate(null), NA);
assert.equal(formatSeconds(12.345), '12.3 s');
// The Context card: the whole measured prompt is one part until the window is split by part.
assert.deepEqual(JSON.parse(JSON.stringify(contextParts({ used_tokens: 79000 }))), [['whole', 'Whole prompt', 79000, false]]);
assert.equal(contextParts(null).length, 0);
assert.equal(formatShort(79400), '79K');
assert.equal(formatShort(8900), '8.9K');
// The Model card: an unknown window says so instead of 0.
let model = Object.fromEntries(modelRows({ model: 'gpt-6.1', provider: 'Codex', context_window: null }, null));
assert.equal(model['Context window'], 'unknown');
model = Object.fromEntries(modelRows({ model: 'm', provider: null, context_window: 500000, context_window_estimated: true }, null));
assert.equal(model['Context window'], '500K (estimated)');
assert.equal(model['Provider'], NA);
assert.equal(value(usageRows(full), 'Calls'), '3');
// Side calls (unit 2): counted by purpose, in words; an older backend without them says n/a.
assert.equal(sideCalls({ side_runs: 3, side_purposes: { compact: 1, chat_summary: 2 } }), '3 (1 compaction, 2 chat summary)');
assert.equal(sideCalls({ side_runs: 0, side_purposes: {} }), '0');
assert.equal(sideCalls({}), NA);
assert.equal(value(usageRows({ ...full, parts: { side: { total_tokens: null } } }), 'Side call tokens'), NA);
// Cost (unit 4): unknown is never $0, a subscription is included, sub-cent keeps 4 decimals.
const cost = statuses => value(usageRows({ ...full, cost: { total_usd: statuses.total ?? null, statuses: statuses.s, sources: [] } }), 'Cost');
assert.equal(cost({ s: { unknown: 2 } }), 'unknown');
assert.equal(cost({ s: { included: 3 } }), 'included (subscription or local)');
assert.equal(cost({ total: 0.00123, s: { estimated: 2 } }), '$0.0012 estimated');
assert.equal(cost({ total: 1.5, s: { estimated: 2, unknown: 1 } }), '$1.50 estimated, 1 run not priced');
assert.equal(cost({ total: 0.2, s: { actual: 1 } }), '$0.20 reported');
assert.equal(value(usageRows(full), 'Cost'), NA, 'an older backend without costs says n/a');
// Seamless compaction (2026-11-07): the chat never shows a compaction, so Chat details names the newest one.
const hint = (rows, label) => rows.find(r => r[0] === label)?.[2];
assert.equal(value(usageRows(full), 'Last compaction'), 'none', 'an older backend or an uncompacted chat');
rows = usageRows({ ...full, last_compaction: { trigger: 'auto', method: 'summary', tokens_before: 14200, tokens_after: 6100, tokens_after_estimated: true, written_ahead: true } });
assert.equal(value(rows, 'Last compaction'), 'Automatic, 14K to ~6.1K tokens');
assert.match(hint(rows, 'Last compaction'), /in the background before it was needed/);
rows = usageRows({ ...full, last_compaction: { trigger: 'cli', method: 'cli', tokens_before: 151000 } });
assert.equal(value(rows, 'Last compaction'), 'By Claude Code, from 151K tokens');
rows = usageRows({ ...full, last_compaction: { trigger: 'manual', method: 'summary', tokens_before: null } });
assert.equal(value(rows, 'Last compaction'), 'By you');
for (const r of usageRows({ ...full, last_compaction: { trigger: 'auto', method: 'prune' } })) assert.ok(!/—/.test(`${r[1]} ${r[2] || ''}`), 'no em-dashes');
console.log('usage meter: ok');
