// Settings entrance lifecycle checks; no Electron, backend, or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const frames = [];
const context = vm.createContext({ requestAnimationFrame: callback => frames.push(callback) });
const source = fs.readFileSync(path.join(__dirname, '../static/js/settingsKit.js'), 'utf8');
vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), context);
const staggerEntrance = vm.runInContext('staggerEntrance', context);
const flush = () => new Promise(resolve => setImmediate(resolve));
function container() {
  const classes = new Set();
  return { classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    getAnimations: () => [] };
}
function animation(parentElement, animationName = 'rd-rise') {
  let finish, cancel;
  const finished = new Promise((resolve, reject) => { finish = resolve; cancel = reject; });
  return { animationName, effect: { target: { parentElement } }, finished, finish, cancel };
}
(async () => {
  const list = container();
  const first = animation(list), last = animation(list, 'rd-opacity');
  // Unfinished nested/control animations must never hold up entrance cleanup.
  const nested = animation({ parentElement: list });
  const control = animation(list, 'spinner');
  list.getAnimations = options => {
    assert.equal(options.subtree, true);
    return [first, last, nested, control];
  };
  staggerEntrance(list);
  assert.ok(list.classList.contains('rd-stagger'));
  frames.shift()();
  first.finish();
  await flush();
  assert.ok(list.classList.contains('rd-stagger'), 'Wait for the final staggered child');
  last.finish();
  await flush();
  assert.ok(!list.classList.contains('rd-stagger'), 'Release filled animations so idle Settings settles');

  const hidden = container(), interrupted = animation(hidden);
  hidden.getAnimations = () => [interrupted];
  staggerEntrance(hidden);
  frames.shift()();
  interrupted.cancel(new Error('Hidden or detached during entrance'));
  await flush();
  assert.ok(!hidden.classList.contains('rd-stagger'), 'Cancelled entrances cannot replay when revealed');

  const classic = container();
  staggerEntrance(classic);
  frames.shift()();
  await flush();
  assert.ok(!classic.classList.contains('rd-stagger'), 'Hidden, empty, or Classic lists consume their first render too');
  console.log('Settings motion lifecycle checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
