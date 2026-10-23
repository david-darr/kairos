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
  modelMark: (mark, name) => new Node('img', { 'aria-label': name, class: 'model-mark' }), Date,
};
vm.createContext(context);
const load = file => fs.readFileSync(file, 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
vm.runInContext(load('static/js/quotaReadings.js') + '\n' + load('static/js/kairosParts.js') + '\nthis.render = usageCard;', context);
const providers = [{ provider: 'claude', status: 'ok', windows: [
  { name: '5-hour', used_percent: 34, resets_at: Math.floor(Date.now()/1000)+600 },
  { name: 'Weekly', used_percent: 61, resets_at: Math.floor(Date.now()/1000)+86400 },
] }, { provider: 'codex', status: 'ok', windows: [{ name: 'Weekly', used_percent: 83 }] }];
const card = context.render({ providers, accounting: [{ name: 'Local', text: '842K tokens via Kairos', title: 'Not a quota.' }] });
assert.deepEqual(Array.from(card.all(n => n.attrs['data-provider']), n => n.attrs['data-provider']), ['claude', 'codex']);
assert.equal(card.all(n => n.classList.contains('model-mark')).length, 2);
assert.equal(card.all(n => n.attrs.role === 'meter').length, 3);
assert.equal(card.all(n => n.attrs.role === 'meter')[0].attrs['aria-valuenow'], '34');
assert.ok(card.all(n => n.attrs.title).some(n => n.attrs.title.includes('34% Used') && n.attrs.title.includes('66% left')));
assert.ok(card.textContent.includes('Resets in 10 min'));
assert.ok(card.textContent.includes('842K tokens via Kairos'));
assert.equal(card.all(n => n.classList.contains('dashboard-model-usage')).length, 1);
for (const [used, tone] of [[0, 'ample'], [0.1, 'ample'], [49.9, 'ample'], [50, 'watch'], [79.9, 'watch'], [80, 'crit'], [100, 'crit'], [110, 'crit']]) {
  const node = context.render({ providers: [{ provider: 'claude', status: 'ok', windows: [{ name: '5-hour', used_percent: used }] }] });
  const row = node.all(n => n.attrs['data-quota-tone'])[0], meter = node.all(n => n.attrs.role === 'meter')[0];
  assert.equal(row.attrs['data-quota-tone'], tone, `${used}% tone`);
  assert.equal(meter.attrs['aria-valuenow'], String(Math.min(used, 100)), 'Meter stays within its range');
  assert.equal(meter.attrs['aria-valuemin'], '0'); assert.equal(meter.attrs['aria-valuemax'], '100');
  assert.ok(meter.classList.contains('rd-tone-' + tone));
  if (used === 0.1) assert.ok(node.textContent.includes('0.1%'));
}
const signedOut = context.render({ providers: [{ provider: 'claude', status: 'needs_sign_in', note: 'Long authentication diagnostics.' }] });
assert.ok(signedOut.textContent.includes('Sign in to Claude Code') && signedOut.textContent.includes('Long authentication diagnostics.'));
assert.equal(signedOut.all(n => n.attrs.role === 'meter').length, 0, 'Sign-in is not a zero quota');
for (const status of ['ok', 'stale']) {
  const stale = context.render({ providers: [{ provider: 'codex', status, updated_at: Math.floor(Date.now()/1000)-3600, windows: [{ name: '5-hour', used_percent: 0.1, resets_at: Math.floor(Date.now()/1000)-1 }] }] });
  assert.ok(stale.textContent.includes('Updated 1h ago'));
  assert.ok(stale.textContent.includes('Resetting'));
}
const noTimestamp = context.render({ providers: [{ provider: 'codex', status: 'stale', windows: [{ name: 'Weekly', used_percent: 20 }] }] });
assert.ok(noTimestamp.textContent.includes('Usage may be out of date.'));
const unavailable = context.render({ providers: [{ provider: 'claude', status: 'unavailable' }] });
assert.equal(unavailable.all(n => n.attrs['data-provider']).length, 0, 'No fabricated readings for unavailable providers');
console.log('PASS: usage provider hooks, real meters, 50/80% boundaries, reset copy, tiny usage, stale age, sign-in diagnostics, logos and separate token accounting.');
