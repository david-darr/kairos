// Pure pointer math plus shared-listener lifecycle, without Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/js/mascot.js', 'utf8');
const block = source.slice(source.indexOf('export function pointerEyeOffset'), source.indexOf('// Node (scripts/test_mascot.cjs)')).replaceAll('export ', '');
const window = new EventTarget(), document = new EventTarget();
document.documentElement = { dataset: {} };
document.hidden = false;
const queries = new Map();
const frames = new Map(); let next = 0, mutation, adds = 0, removes = 0;
const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
window.addEventListener = (...args) => { adds++; add(...args); };
window.removeEventListener = (...args) => { removes++; remove(...args); };
const context = { window, document, Math, Set,
  matchMedia: query => { if (!queries.has(query)) queries.set(query, Object.assign(new EventTarget(), { matches: false })); return queries.get(query); },
  MutationObserver: class { constructor(cb) { mutation = cb; } observe() {} disconnect() { mutation = null; } },
  requestAnimationFrame: cb => { frames.set(++next, cb); return next; },
  cancelAnimationFrame: id => frames.delete(id),
};
vm.createContext(context);
vm.runInContext(block + ';this.math=pointerEyeOffset;this.allowed=pointerFollowAllowed;this.follow=followPointer;', context);
const rect = { left: 0, top: 0, width: 72, height: 72 };
const center = context.math(36, 36, rect);
assert.equal(center.x, 0); assert.equal(center.y, 0);
const far = context.math(1000, 1000, rect);
assert.ok(Math.abs(Math.hypot(far.x, far.y) - 4) < 1e-9, 'Movement is capped');
assert.ok(context.math(37, 36, rect).x < far.x, 'Near movement is smaller');
assert.ok(context.math(-100, 36, rect).x < 0);
for (const guard of ['reduced', 'noHover', 'hidden', 'mascotOff']) assert.equal(context.allowed({ [guard]: true }), false);
assert.equal(context.allowed({}), true);
const mascot = () => {
  const gaze = { value: null, setAttribute: (_, v) => { gaze.value = v; }, removeAttribute: () => { gaze.value = null; } };
  return { gaze, isConnected: true, querySelector: () => gaze, getBoundingClientRect: () => rect };
};
const a = mascot(), b = mascot();
context.follow(a, true); context.follow(b, true);
assert.equal(adds, 1, 'Opt-ins share exactly one pointer listener');
const move = () => window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 100, clientY: 0 }));
move(); move(); assert.equal(frames.size, 1, 'Pointer bursts share one rAF');
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb()); };
flush(); assert.ok(a.gaze.value); assert.equal(a.gaze.value, b.gaze.value);
for (const query of queries.values()) {
  move(); query.matches = true; query.dispatchEvent(new Event('change'));
  assert.equal(frames.size, 0); assert.equal(a.gaze.value, null);
  move(); assert.equal(frames.size, 0, 'Disabled guards detach the listener');
  query.matches = false; query.dispatchEvent(new Event('change'));
}
document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
move(); assert.equal(frames.size, 0);
document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
document.documentElement.dataset.mascot = 'off'; mutation();
move(); assert.equal(frames.size, 0);
document.documentElement.dataset.mascot = 'on'; mutation();
context.follow(a, false); move(); flush(); assert.equal(a.gaze.value, null); assert.ok(b.gaze.value);
context.follow(b, false);
assert.equal(mutation, null, 'Final unmount disconnects the observer');
assert.equal(adds, removes, 'Final unmount removes every shared pointer listener');
move(); assert.equal(frames.size, 0);
console.log('PASS: pointer math, guards, shared listener, rAF throttle and unmount cleanup.');
