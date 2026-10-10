const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { localPointer, boundsDiffer, trackOverlay } = require('../electron/usage-overlay-tracking');
const { boundsFor, chooseDisplay, EDGES } = require('../electron/usage-overlay-placement');

// Electron screen rectangles are DIPs, even when the physical panels differ.
const primary = { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const left = { id: 2, scaleFactor: 1.5, bounds: { x: -1707, y: -180, width: 1707, height: 960 },
  workArea: { x: -1667, y: -180, width: 1667, height: 960 } }; // 2560x1440 panel, left taskbar
const above = { id: 3, scaleFactor: 1.75, bounds: { x: 240, y: -823, width: 1463, height: 823 },
  workArea: { x: 240, y: -787, width: 1463, height: 787 } }; // top taskbar
const rightTaskbar = { ...primary, id: 4, workArea: { x: 0, y: 0, width: 1872, height: 1080 } };
const small = { id: 5, scaleFactor: 2, bounds: { x: -640, y: -480, width: 640, height: 480 },
  workArea: { x: -640, y: -480, width: 640, height: 440 } };
for (const display of [primary, left, above, rightTaskbar, small]) {
  const a = display.workArea;
  for (const edge of EDGES) for (const offset of [0, 0.37, 0.5, 1]) {
    const b = boundsFor({ edge, offset }, display);
    assert.ok(b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height);
    assert.equal({ left: b.x - a.x, right: a.x + a.width - b.x - b.width,
      top: b.y - a.y, bottom: a.y + a.height - b.y - b.height }[edge], 0, `${edge} is flush on display ${display.id}`);
    for (const scaleFactor of [1, 1.25, 1.5, 1.75, 2]) {
      assert.deepEqual(boundsFor({ edge, offset }, { ...display, scaleFactor }), b, 'scaleFactor never multiplies screen DIPs');
    }
  }
}
assert.deepEqual(boundsFor({ edge: 'right', offset: 0.5 }, primary), { x: 1560, y: 191, width: 360, height: 650 });
assert.deepEqual(boundsFor({ edge: 'left', offset: 0.5 }, left), { x: -1667, y: -25, width: 360, height: 650 });
assert.equal(chooseDisplay([primary, left], 2, 1), left);
assert.equal(chooseDisplay([primary], 2, 1), primary, 'removed saved display falls back to primary');
assert.equal(chooseDisplay([left], 99, 1), left, 'missing primary falls back to an attached display');
assert.deepEqual(localPointer({ x: -1200, y: -180 }, { x: -1400, y: -280 }, 1.25), { x: 160, y: 80 });
assert.equal(boundsDiffer({ x: -1666, y: -24, width: 361, height: 649 }, { x: -1667, y: -25, width: 360, height: 650 }), false);

let tick, stopped = 0, visible = false, destroyed = false, cursor = { x: -1662, y: 300 }, zoom = 1, writes = 0;
let displays = [primary, left], config = { displayId: 2, edge: 'left', offset: 0.5 };
const target = () => boundsFor(config, chooseDisplay(displays, config.displayId, primary.id));
let actual = { ...target() };
const win = new EventEmitter(), sent = [];
win.webContents = new EventEmitter();
win.webContents.getZoomFactor = () => zoom;
win.webContents.send = (channel, value) => sent.push({ channel, value });
win.isDestroyed = () => destroyed;
win.isVisible = () => visible;
win.getBounds = win.getContentBounds = () => ({ ...actual });
win.setBounds = b => { actual = { ...b }; writes++; win.emit('move'); win.emit('resize'); };
const tracking = trackOverlay(win, { getCursorScreenPoint: () => cursor }, target,
  { setInterval: fn => { tick = fn; return 7; }, clearInterval: id => { assert.equal(id, 7); stopped++; } });
win.emit('ready-to-show');
assert.equal(sent.length, 0, 'hidden overlays do not send pointers');
actual.x = 200;
visible = true; win.emit('show');
assert.deepEqual(actual, target(), 'show repairs native bounds before sampling');
assert.deepEqual(sent.at(-1), { channel: 'usage-overlay:pointer', value: { x: 5, y: 325 } });
const count = sent.length, stableWrites = writes;
tick();
assert.equal(sent.length, count + 1, 'stationary cursor repairs stale renderer hover');
assert.equal(writes, stableWrites, 'correct native geometry does not cause repeated setBounds');
zoom = 1.25; tick();
assert.deepEqual(sent.at(-1).value, { x: 4, y: 260 }, 'stationary native cursor accounts for a zoom change');
// DPI/resolution/work area can change on the selected display at runtime.
displays = [primary, { ...left, scaleFactor: 1.25, workArea: { x: -2048, y: -100, width: 2048, height: 1104 } }];
tracking.place();
assert.deepEqual(actual, target(), 'display metrics recompute position and size in DIPs');
// Windows applies a late WM_DPICHANGED relocation AFTER our metrics handler.
actual = { x: -900, y: 200, width: 450, height: 812 }; win.emit('move'); win.emit('resize'); tick();
assert.deepEqual(actual, target(), 'polling repairs late Windows movement and pre-DPI size');
actual.x++; actual.height--; const roundedWrites = writes; tick();
assert.equal(writes, roundedWrites, 'one DIP native rounding does not cause a placement loop');
displays = [primary]; tracking.place();
assert.deepEqual(actual, boundsFor(config, primary), 'display removal repairs stale saved monitor placement');
actual.x = 200; tick();
assert.deepEqual(actual, target(), 'delayed OS relocation after unplug is repaired');
displays = [primary, left]; tick();
assert.deepEqual(actual, boundsFor(config, left), 'reconnected saved monitor is selected again');
tracking.setDragging(true); actual.y += 40; const carried = { ...actual }; tick();
assert.deepEqual(actual, carried, 'placement repair does not fight the move handle');
config.offset = (actual.y - left.workArea.y) / (left.workArea.height - actual.height);
tracking.setDragging(false);
assert.deepEqual(actual, carried, 'releasing the handle keeps its new offset');
actual.x = 200; tick(); assert.deepEqual(actual, target(), 'repair resumes after carrying');
win.webContents.emit('did-finish-load');
assert.deepEqual(sent.at(-1).value, localPointer(cursor, actual, zoom), 'reload restores pointer state');
visible = false; win.emit('hide'); assert.equal(stopped, 1);
const hiddenCount = sent.length; tick(); assert.equal(sent.length, hiddenCount);
actual.x = 200; tracking.place(); assert.deepEqual(actual, target(), 'hidden overlays also accept new placement');
visible = true; win.emit('show'); assert.ok(sent.length > hiddenCount);
destroyed = true; win.emit('closed'); assert.equal(stopped, 2);
const closedWrites = writes; tracking.place(); tick(); assert.equal(writes, closedWrites);
console.log('PASS: DIP geometry, mixed DPI, negative displays, taskbars, display removal/reconnection, delayed native relocation, hover polling and drag lifecycle');

// Exercise the real renderer's pointer handlers and grace timers without an
// Electron compositor. Geometry is fixed; native hit testing stays in the smoke.
async function rendererChecks() {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  let time = 0, nextId = 0, nativePointer, configChanged;
  const pending = new Map(), handlers = new Map(), interaction = [];
  const classList = (...initial) => {
    const values = new Set(initial);
    return { contains: value => values.has(value), add: (...names) => names.forEach(n => values.add(n)),
      remove: (...names) => names.forEach(n => values.delete(n)),
      toggle: (name, on) => on ? values.add(name) : values.delete(name) };
  };
  const element = (left, top, width, height) => ({ classList: classList(), dataset: {},
    style: { setProperty() {} }, offsetHeight: height, offsetWidth: width,
    getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} });
  const elements = { pill: element(290, 240, 70, 170), rest: element(350, 285, 10, 79),
    card: element(10, 240, 246, 180), tail: element(259, 250, 32, 36),
    move: element(0, 0, 57, 57), orb: element(0, 0, 57, 57), notice: element(0, 0, 0, 0) };
  const body = { classList: classList('folded'), dataset: {} };
  const bridge = { onPointer: fn => { nativePointer = fn; }, onConfig: fn => { configChanged = fn; },
    getConfig: () => ({ edge: 'right', foldOnHover: true }), setInteractive: on => interaction.push(on) };
  const context = { window: { usageOverlay: bridge, addEventListener() {} },
    document: { body, getElementById: id => elements[id], addEventListener: (name, fn) => handlers.set(name, fn) },
    innerWidth: 360, innerHeight: 650, PROVIDERS: [], SIGN_IN: {},
    fetch: () => new Promise(() => {}), requestAnimationFrame: fn => fn(),
    getComputedStyle: () => ({ getPropertyValue: () => '38.7' }), matchMedia: () => ({ matches: true }),
    setTimeout: (fn, ms) => { const id = ++nextId; pending.set(id, { fn, at: time + ms }); return id; },
    clearTimeout: id => pending.delete(id), setInterval() {} };
  const source = fs.readFileSync(path.join(__dirname, '../static/js/usage-overlay.js'), 'utf8')
    .replace(/^import .* from '\.\/quotaReadings\.js';\r?\n/m, '');
  vm.runInNewContext(source, context, { filename: 'usage-overlay.js' });
  await Promise.resolve(); // initial getConfig
  const advance = ms => {
    const until = time + ms;
    while (true) {
      const due = [...pending].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due; pending.delete(id); time = job.at; job.fn();
    }
    time = until;
  };
  nativePointer({ x: 355, y: 320 });
  assert.equal(body.classList.contains('folded'), false, 'native samples wake the actual renderer');
  assert.equal(interaction.at(-1), true, 'wake asks the native window to accept clicks');
  handlers.get('mouseleave')();
  nativePointer({ x: 355, y: 320 }); advance(550);
  assert.equal(body.classList.contains('folded'), false, 'stationary native sample repairs stray mouseleave');
  elements.card.classList.add('show');
  for (let i = 0; i < 8; i++) {
    nativePointer({ x: -1, y: -1 }); advance(80);
    if (i === 3) assert.equal(elements.card.classList.contains('show'), false, 'card hides despite repeated outside samples');
  }
  assert.equal(body.classList.contains('folded'), true, 'repeated outside samples do not restart fold grace');
  assert.equal(interaction.at(-1), false, 'outside samples restore click-through');
  nativePointer({ x: 355, y: 320 }); advance(550);
  assert.equal(body.classList.contains('folded'), false, 'hover wakes again after a completed fold timer');
  configChanged({ edge: 'right', foldOnHover: false });
  for (let i = 0; i < 8; i++) { nativePointer({ x: -1, y: -1 }); advance(80); }
  assert.equal(body.classList.contains('folded'), false, 'always expanded setting still works');
  console.log('PASS: actual renderer native hover, stationary recovery, repeated samples, grace timers and click-through');
}
rendererChecks().catch(error => { console.error(error); process.exitCode = 1; });
