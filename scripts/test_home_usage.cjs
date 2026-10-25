// Exercise the shipped usage renderer with real quota normalization, without Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.attrs = { ...attrs }; this.children = children.filter(Boolean);
    const classes = new Set((attrs.class || '').split(' '));
    this.classList = { add: (...values) => values.forEach(value => classes.add(value)), contains: value => classes.has(value) };
    this.style = { setProperty() {} };
  }
  append(...nodes) { this.children.push(...nodes.filter(Boolean)); }
  setAttribute(key, value) { this.attrs[key] = value; }
  get textContent() { return (this.attrs.text || '') + this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
  all(predicate) { return this.children.filter(n => typeof n !== 'string').flatMap(n => [...(predicate(n) ? [n] : []), ...n.all(predicate)]); }
}
const context = {
  el: (tag, attrs, children) => new Node(tag, attrs, children),
  modelMark: (mark, name) => mark ? new Node('img', { 'aria-label': name, class: 'model-mark' }) : null, Date,
};
vm.createContext(context);
const load = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
vm.runInContext(load('static/js/quotaReadings.js') + '\n' + load('static/js/kairosParts.js') + '\nthis.render = usageCard;', context);
// The quotas route's `models`: one entry per endpoint, subscriptions first.
const sub = (id, provider, quota, extra = {}) => ({ id, name: provider, kind: provider + '_cli', provider, status: 'connected', quota, ...extra });
const one = quota => context.render({ models: [sub('c1', quota.provider, quota)] });
const claude = { provider: 'claude', status: 'ok', windows: [
  { name: '5-hour', used_percent: 34, resets_at: Math.floor(Date.now()/1000)+600 },
  { name: 'Weekly', used_percent: 61, resets_at: Math.floor(Date.now()/1000)+86400 },
] };
const models = [
  sub('c1', 'claude', claude), sub('c2', 'claude', claude),
  sub('x1', 'codex', { provider: 'codex', status: 'ok', windows: [{ name: 'Weekly', used_percent: 83 }] }),
  sub('g1', 'antigravity', { provider: 'antigravity', status: 'no_quota', windows: [], note: 'This CLI does not report usage limits.' },
    { recorded: { today_tokens: 1200, week_tokens: 5400, total_tokens: 9000 } }),
  { id: 'l1', name: 'qwen3', kind: 'local', model: 'qwen3:8b', mark: 'qwen', status: 'connected', quota: null, recorded: { today_tokens: 0, week_tokens: 0, total_tokens: 842000 } },
  { id: 'a1', name: 'Mine', kind: 'api', model: 'x', mark: null, status: 'connected', quota: null, recorded: { today_tokens: 0, week_tokens: 0, total_tokens: 0 } },
];
const card = context.render({ models });
assert.deepEqual(Array.from(card.all(n => n.attrs['data-provider'] || n.attrs['data-model']), n => n.attrs['data-provider'] || n.attrs['data-model']),
  ['claude', 'codex', 'antigravity', 'l1', 'a1'], 'Every connected model, one group per subscription account, subscriptions first');
assert.equal(card.all(n => n.classList.contains('model-mark')).length, 4, 'A logo where the model has one');
assert.equal(card.all(n => n.classList.contains('rd-usage-glyph')).length, 1, 'A small generic mark otherwise');
assert.equal(card.all(n => n.attrs.role === 'meter').length, 3, 'Shared account windows draw once');
assert.equal(card.all(n => n.attrs.role === 'meter')[0].attrs['aria-valuenow'], '34');
assert.ok(card.all(n => n.attrs.title).some(n => n.attrs.title.includes('34% Used') && n.attrs.title.includes('66% left')));
assert.ok(card.textContent.includes('Resets in 10 min'));
const tokens = card.all(n => n.classList.contains('rd-usage-tokens')).map(n => n.textContent);
assert.deepEqual([...tokens], ['5.4K tokens this week · 1.2K today', 'None this week · 842K tokens in all', 'No usage yet'], 'Quota-less models show what Kairos counted');
assert.ok(card.all(n => n.classList.contains('rd-usage-tokens')).every(n => n.attrs.title.includes('Not a quota')));
assert.ok(card.textContent.includes('Local · qwen3:8b'), 'A local model names its kind and model');
for (const [used, tone] of [[0, 'ample'], [0.1, 'ample'], [49.9, 'ample'], [50, 'watch'], [79.9, 'watch'], [80, 'crit'], [100, 'crit'], [110, 'crit']]) {
  const node = one({ provider: 'claude', status: 'ok', windows: [{ name: '5-hour', used_percent: used }] });
  const row = node.all(n => n.attrs['data-quota-tone'])[0], meter = node.all(n => n.attrs.role === 'meter')[0];
  assert.equal(row.attrs['data-quota-tone'], tone, `${used}% tone`);
  assert.equal(meter.attrs['aria-valuenow'], String(Math.min(used, 100)), 'Meter stays within its range');
  assert.equal(meter.attrs['aria-valuemin'], '0'); assert.equal(meter.attrs['aria-valuemax'], '100');
  assert.ok(meter.classList.contains('rd-tone-' + tone));
  if (used === 0.1) assert.ok(node.textContent.includes('0.1%'));
}
const signedOut = context.render({ models: [sub('c1', 'claude', { provider: 'claude', status: 'needs_sign_in', note: 'Long authentication diagnostics.' }, { status: 'needs_sign_in' })] });
assert.ok(signedOut.textContent.includes('Sign in to Claude Code') && signedOut.textContent.includes('Long authentication diagnostics.'));
assert.equal(signedOut.all(n => n.attrs.role === 'meter').length, 0, 'Sign-in is not a zero quota');
for (const status of ['ok', 'stale']) {
  const stale = one({ provider: 'codex', status, updated_at: Math.floor(Date.now()/1000)-3600, windows: [{ name: '5-hour', used_percent: 0.1, resets_at: Math.floor(Date.now()/1000)-1 }] });
  assert.ok(stale.textContent.includes('Updated 1h ago'));
  assert.ok(stale.textContent.includes('Resetting'));
}
const noTimestamp = one({ provider: 'codex', status: 'stale', windows: [{ name: 'Weekly', used_percent: 20 }] });
assert.ok(noTimestamp.textContent.includes('Usage may be out of date.'));
const unavailable = context.render({ models: [sub('c1', 'claude', { provider: 'claude', status: 'unavailable', windows: [], note: 'Usage could not be read right now.' }, { status: 'unavailable' })] });
assert.equal(unavailable.all(n => n.attrs.role === 'meter').length, 0, 'No fabricated readings for unavailable providers');
assert.ok(unavailable.textContent.includes('Usage could not be read right now.') && unavailable.textContent.includes('No usage yet'), 'An unreadable quota is still listed, and says so');
assert.equal(context.render({ models: [] }).all(n => n.attrs['data-provider'] || n.attrs['data-model']).length, 0);
console.log('PASS: every connected model listed, shared account windows, real meters, 50/80% boundaries, reset copy, tiny usage, stale age, sign-in diagnostics, logos and recorded tokens.');
