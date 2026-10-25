// Sheet gestures must not steal the click or focus of header actions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
if (!vm.SourceTextModule) {
  const run = require('node:child_process').spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
(async () => {
  const listeners = {}, captures = [], classes = new Set();
  const panel = {
    parentElement: null, scrollTop: 0,
    matches: () => false, contains: () => true,
    classList: { remove: (...names) => names.forEach(name => classes.delete(name)) },
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {}, removeAttribute() {}, getAnimations: () => [],
    getBoundingClientRect: () => ({ height: 400 }),
    setPointerCapture: id => captures.push(id),
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const context = vm.createContext({ AbortController, performance: { now: () => 0 }, setTimeout: () => 1,
    window: { getSelection: () => ({ isCollapsed: true }) } });
  const dependencies = {
    './mobileShared.js': { mobileOn: () => true, phone: { matches: true }, button() {}, reduced: { matches: false } },
    './mobileDock.js': { watchKeyboard() {}, keyboardLift() {}, belowFold() {} },
    './icons.js': { ICONS: {} },
  };
  const mod = new vm.SourceTextModule(fs.readFileSync('static/js/mobileSheet.js', 'utf8'), { context });
  await mod.link(name => new vm.SyntheticModule(Object.keys(dependencies[name]), function () {
    for (const [key, value] of Object.entries(dependencies[name])) this.setExport(key, value);
  }, { context }));
  await mod.evaluate();
  const dispose = mod.namespace.attachSheetDrag(panel, () => {}, { enabled: () => true });
  const target = (control = false, handle = false) => ({ parentElement: panel, scrollTop: 0,
    closest: selector => selector.includes('.ms-sheet-grabber') ? (handle ? panel : null)
      : selector.includes('button,') ? (control ? panel : null)
      : selector.includes('.modal-header') ? panel : null,
  });
  const down = node => listeners.pointerdown({ target: node, pointerType: 'mouse', button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  const move = y => listeners.pointermove({ pointerType: 'mouse', clientX: 10, clientY: y, cancelable: true, preventDefault() {} });
  const up = () => listeners.pointerup({ pointerType: 'mouse' });
  down(target(true)); move(40); up();
  assert.deepEqual(captures, [], 'Close and other header buttons keep their native click target');
  assert.equal(panel.style.transform, undefined, 'Dragging a button does not move the sheet');
  down(target()); move(13); up();
  assert.deepEqual(captures, [], 'A header tap does not capture the release');
  down(target()); move(40);
  assert.deepEqual(captures, [7], 'A real header drag captures after the movement threshold');
  assert.equal(panel.style.transform, 'translateY(30px)');
  up(); dispose();
  assert.equal(panel.style.transform, '', 'Disposal releases the dragged presentation');
  down(target(true, true));
  assert.deepEqual(captures, [7], 'A grabber tap also keeps its close click');
  console.log('PASS: sheet header actions, tap targets, drag capture and cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
