// U1's wire samples are also posted through the real Python store by test_bots_fdbot.py.
const assert = require('node:assert/strict');
const factory = require('./fixtures/bots-fdbot-backend.cjs');
const { CARD_DATA_SCHEMA, CARD_SAMPLES } = factory;

function validate(value, schema, where = 'card') {
  if (schema.enum) assert.ok(schema.enum.includes(value), where);
  if (schema.type === 'string' || schema.type === 'number' || schema.type === 'boolean') assert.equal(typeof value, schema.type, where);
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), where);
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${where}.${key}`);
    for (const [key, sub] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) validate(value[key], sub, `${where}.${key}`);
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), where);
    if (schema.maxItems) assert.ok(value.length <= schema.maxItems, where);
    if (schema.minItems) assert.ok(value.length >= schema.minItems, where);
    value.forEach((v, i) => validate(v, schema.items, `${where}[${i}]`));
  }
}

{
  const samples = CARD_SAMPLES;
  assert.deepEqual(Object.keys(samples).sort(), Object.keys(CARD_DATA_SCHEMA).sort());
  for (const [kind, data] of Object.entries(samples)) validate(data, CARD_DATA_SCHEMA[kind], kind);
  assert.throws(() => validate({ task_id: 2 }, CARD_DATA_SCHEMA.task_link));
  assert.throws(() => validate({ options: ['1','2','3','4','5'] }, CARD_DATA_SCHEMA.chips));

  // The fixture owns only its routes, creates its own singleton and preserves a hide.
  const state = { botsLive: true };
  const data = { agentsFixture: [] };
  const backend = factory({ state, data, now: 1800000000 });
  assert.equal(backend.read('/api/front-desk/state').bot_id, null);
  const first = backend.mutate('/api/front-desk/ensure', 'POST');
  assert.equal(first.agent.name, 'Kip');
  assert.equal(first.agent.builtin, 'front_desk');
  assert.equal(first.agent.order, -1);
  assert.equal(backend.mutate('/api/front-desk/ensure', 'POST').bot_id, first.bot_id);
  state.botsCore.agents[0].hidden = true;
  assert.equal(backend.mutate('/api/front-desk/ensure', 'POST').agent.hidden, true);
  assert.equal(backend.read('/api/front-desk/roster').length, 0);
  assert.equal(backend.read('/api/agents'), undefined);
  assert.equal(backend.mutate('/api/front-desk/ensure', 'POST', { owner: 'other' })._status, 422);
  assert.equal(backend.mutate('/api/front-desk/other', 'POST'), undefined);
  state.botsLive = false;
  assert.equal(backend.read('/api/front-desk/state'), undefined);
  console.log('Front desk card wire and fixture checks passed.');
}
