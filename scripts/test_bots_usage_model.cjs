const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
(async () => {
  const m = await import(pathToFileURL(path.resolve(__dirname, '../static/js/botsUsageModel.js')).href);
  for (const [seconds, expected] of [[.45, '450ms'], [6.9, '6.9s'], [100, '1m 40s'], [7500, '2h 5m']]) assert.equal(m.duration(seconds), expected);
  assert.equal(m.cost(null), 'Unknown'); assert.equal(m.cost(0), '$0.000'); assert.equal(m.cost(.00001), '<$0.001');
  assert.deepEqual(m.geometry(5, 3, 0, 10), { left: 50, width: 30 });
  assert.deepEqual(m.geometry(-5, 30, 0, 10), { left: 0, width: 100 });
  for (const n of [.45, 6.9, 100, 7500]) { const ticks = m.ticks(n); assert(ticks.length >= 3 && ticks.length <= 6); assert(ticks.at(-1) >= n); }
  assert.equal(m.contextTone(49), 'quiet'); assert.equal(m.contextTone(50), 'warn'); assert.equal(m.contextTone(80), 'danger');
  assert.equal(m.meterTone(69), 'success'); assert.equal(m.meterTone(70), 'warn'); assert.equal(m.meterTone(91), 'danger');
  const range = m.periodRange('last-month', new Date('2026-03-15T12:00:00Z'));
  assert(new Date(range.from) < new Date(range.to));
  // Prevent missing token names and literal chart colours from slipping past QA.
  const css = fs.readFileSync(path.resolve(__dirname, '../static/css/bots-usage.css'), 'utf8');
  const tokens = fs.readFileSync(path.resolve(__dirname, '../static/css/bots.css'), 'utf8');
  for (const name of css.match(/--bots-[\w-]+/g) || []) assert(tokens.includes(`${name}:`), `Undefined token ${name}`);
  assert(!/#[a-f\d]{3,8}\b|\brgba?\(/i.test(css));
  console.log('PASS usage formatting, geometry, ranges, tones and theme tokens');
})().catch(error => { console.error(error); process.exitCode = 1; });
