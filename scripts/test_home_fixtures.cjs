const assert = require('node:assert/strict');
const state = {};
const { fixture } = require('../demo/fixtures.js')({ state });
const read = path => fixture(new URL(path, 'http://fixture'));
for (const clear of [false, true]) {
  state.homeClear = clear;
  const usage = read('/api/models/quotas');
  assert.deepEqual(usage.models.map(model => model.id), read('/api/models').map(model => model.id), 'Every connected endpoint has a usage entry');
  assert.deepEqual(usage.models[0].quota, usage.providers[0], 'Subscription models carry their account reading');
  assert.equal(usage.models[2].quota, null, 'Local tokens are not a provider quota');
  assert.equal(usage.models[2].recorded.total_tokens, 842000);
  assert.equal(usage.models[0].recorded.total_tokens, 1200000, 'Cache reads stay out of fresh token totals');
}
state.quotas = { providers: [{ provider: 'claude', status: 'needs_sign_in', windows: [] }] };
assert.equal(read('/api/models/quotas').models[0].status, 'needs_sign_in', 'Signed-out fixtures also update the per-model reading');
state.empty = true;
assert.deepEqual(read('/api/models/quotas').models, [], 'No endpoints means no model usage cards');
state.empty = false;
state.quotas.models = [];
assert.deepEqual(read('/api/models/quotas').models, [], 'An explicit empty usage override is preserved');
console.log('PASS: Home fixture endpoint, quota, recorded usage and empty-state contracts');
