// Advice from recent runs (static/js/modelAdvice.js, Session Usage and Model Tracking unit 7), without
// Electron: ranking follows the stats, too little data ranks after measured models, a model that keeps
// failing gets a suggestion with the cost of switching, and nothing here can switch a model.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { Number, Math, Object, Infinity, console };
vm.createContext(context);
const load = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
vm.runInContext(load('static/js/modelStats.js') + '\n' + load('static/js/modelAdvice.js')
  + '\nthis.api = { adviceNote, rankAlternatives, repeatedFailure, switchSuggestion, switchCostText };', context);
const { adviceNote, rankAlternatives, repeatedFailure, switchSuggestion, switchCostText } = context.api;

const endpoints = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, name: id.toUpperCase() }));
const stats = {
  a: { runs: 20, enough_data: true, failed: 4, ttft_median_s: 0.3 },   // 80% success, fast
  b: { runs: 10, enough_data: true, failed: 0, ttft_median_s: 2.0 },   // 100%, slow
  c: { runs: 3, enough_data: false, failed: 0 },                       // too little data
  e: { runs: 10, enough_data: true, failed: 0, ttft_median_s: 0.9 },   // 100%, faster than b
};
const ranked = rankAlternatives(endpoints, stats);
assert.deepEqual(Array.from(ranked, r => r.endpoint.id), ['e', 'b', 'a', 'c', 'd'], 'success, then speed, then no data in given order');
assert.equal(ranked[0].note, '10 runs, none failed, first output 0.9 s');
assert.equal(ranked[3].note, 'Not enough data yet (3 runs)');
assert.equal(ranked[4].note, 'No runs in the last 7 days');
assert.equal(adviceNote({ runs: 8, enough_data: true, failed: 2, tokens_per_second_median: 41.6 }), '8 runs, 2 failed, 42 tok/s');

// Repeated failure: at least 3 of the last 10, and the latest failed.
const failing = { failures_by_class: { rate_limit: 3, network: 1 }, recent_outcomes: ['failed', 'finished', 'failed', 'failed', 'failed'] };
assert.deepEqual(JSON.parse(JSON.stringify(repeatedFailure(failing))), { failed: 4, of: 5, kind: 'rate limit' });
assert.equal(repeatedFailure({ recent_outcomes: ['finished', 'failed', 'failed', 'failed'] }), null, 'latest run worked');
assert.equal(repeatedFailure({ recent_outcomes: ['failed', 'failed', 'finished'] }), null, 'two failures are not a pattern');
assert.equal(repeatedFailure(null), null);
const text = switchSuggestion(failing, 'Qwen', 48200);
assert.equal(text, 'Qwen has failed 4 of its last 5 runs, mostly rate limit. Another model may do better. '
  + 'Switching means the next reply reads this whole chat again without the prompt cache (about 48,200 tokens).');
assert.equal(switchSuggestion({ recent_outcomes: ['finished'] }, 'Qwen', 1), '');
assert.equal(switchCostText(null), 'Switching means the next reply reads this whole chat again without the prompt cache.');
// Advice only: the module offers no way to change a model.
assert.ok(!/api\(|fetch\(|\/model['"`]/.test(fs.readFileSync('static/js/modelAdvice.js', 'utf8')), 'modelAdvice.js makes no requests');
console.log('model advice: ok');
