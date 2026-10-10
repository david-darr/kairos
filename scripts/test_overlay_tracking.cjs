const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { localPointer, trackOverlay } = require('../electron/usage-overlay-tracking');
const { boundsFor, EDGES } = require('../electron/usage-overlay-placement');

assert.deepEqual(localPointer({ x: -1200, y: 180 }, { x: -1400, y: 80 }, 1.25), { x: 160, y: 80 });
// scaleFactor describes physical pixels, and must not multiply Electron's DIPs.
for (const scaleFactor of [1, 1.25, 1.5, 2]) for (const edge of EDGES) {
  const display = { scaleFactor, workArea: { x: -960, y: -640, width: 640, height: 480 } };
  const b = boundsFor({ edge, offset: 0.5 }, display);
  assert.ok(b.x >= -960 && b.y >= -640 && b.x + b.width <= -320 && b.y + b.height <= -160);
}
let tick, stopped = 0, visible = false, destroyed = false, cursor = { x: 1920, y: 400 }, zoom = 1;
let target = { x: 1560, y: 195, width: 360, height: 650 }, actual = { ...target };
const win = new EventEmitter(), sent = [];
win.webContents = new EventEmitter();
win.webContents.getZoomFactor = () => zoom;
win.webContents.send = (channel, value) => sent.push({ channel, value });
win.isDestroyed = () => destroyed;
win.isVisible = () => visible;
win.getContentBounds = () => actual;
win.setBounds = b => { actual = { ...b }; };
const tracking = trackOverlay(win, { getCursorScreenPoint: () => cursor }, () => target,
  { setInterval: fn => { tick = fn; return 7; }, clearInterval: id => { assert.equal(id, 7); stopped++; } });
win.emit('ready-to-show');
assert.equal(sent.length, 0, 'hidden overlays do not poll or send pointers');
actual.x = 200;
visible = true; win.emit('show');
assert.deepEqual(actual, target, 'show repairs native bounds before sampling');
assert.deepEqual(sent.at(-1), { channel: 'usage-overlay:pointer', value: { x: 360, y: 205 } });
const count = sent.length; tick();
assert.equal(sent.length, count, 'stationary cursor does not flood renderer');
cursor = { x: 1700, y: 450 }; zoom = 2; tick();
assert.deepEqual(sent.at(-1).value, { x: 70, y: 127.5 }, 'native cursor accounts for renderer zoom');
target = { x: -1920, y: 0, width: 360, height: 650 }; tracking.place();
assert.deepEqual(actual, target, 'display changes reapply placement');
visible = false; win.emit('hide'); assert.equal(stopped, 1);
const hiddenCount = sent.length; tick(); assert.equal(sent.length, hiddenCount);
visible = true; win.emit('show'); assert.ok(sent.length > hiddenCount);
destroyed = true; win.emit('closed'); assert.equal(stopped, 2);
tracking.place();
console.log('PASS: overlay placement, native cursor conversion, show/hide/close and display lifecycle');
