// Touch policy tests for the actual drawer recognizer, without a renderer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Events {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  emit(name, event = {}) { for (const handler of this.listeners.get(name) || []) handler(event); }
}
class Node {
  isConnected = true; clientWidth = 300; scrollWidth = 300;
  overflowX = 'hidden'; blocked = false;
  constructor(parentElement = null) {
    this.parentElement = parentElement;
    const classes = new Set(), styles = new Map();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
    this.style = { setProperty: (key, value) => styles.set(key, value), removeProperty: key => styles.delete(key) };
  }
  contains(node) { return node === this || !!node?.parentElement && this.contains(node.parentElement); }
  closest() { return this.blocked ? this : this.parentElement?.closest() || null; }
  matches() { return this.blocked; }
  getBoundingClientRect() { return { width: this.clientWidth }; }
}
const document = new Events(), window = new Events();
document.body = new Node(); document.activeElement = null;
let modal = false, phone = true, selected = false, now = 0;
document.querySelector = () => modal ? {} : null;
window.getSelection = () => ({ isCollapsed: !selected });
const context = vm.createContext({ document, window, Set, performance: { now: () => now },
  innerWidth: 390,
  matchMedia: () => ({ matches: phone }), getComputedStyle: node => ({ overflowX: node.overflowX }) });
const source = fs.readFileSync(path.join(__dirname, '../static/js/mobileDrawers.js'), 'utf8');
const { registerMobileDrawer: register, isMainDrawerZone } = vm.runInContext(source.replace(/^export /gm, '') + '\n({ registerMobileDrawer, isMainDrawerZone });', context);
const target = new Node(document.body), header = new Node(document.body);
let opens = 0, closes = 0;
function drawer(canOpen) {
  const panel = new Node(document.body), backdrop = new Node(document.body);
  return { panel, backdrop, canOpen, isOpen: () => panel.classList.contains('open'),
    open: () => { opens++; panel.classList.add('open'); }, close: () => { closes++; panel.classList.remove('open'); } };
}
const menu = drawer((node, touch) => isMainDrawerZone(touch) && !header.contains(node));
const history = drawer((node, touch) => touch.clientX >= 16 && (header.contains(node) || (!isMainDrawerZone(touch) && target.contains(node))));
register(menu); const releaseHistory = register(history);
function touchEvent(node, x, y, count = 1) {
  return { target: node, cancelable: true, defaultPrevented: false,
    touches: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })),
    preventDefault() { this.defaultPrevented = true; } };
}
function swipe(node, x, y, dx, dy = 0, end = 'touchend', duration = 300) {
  document.emit('touchstart', touchEvent(node, x, y));
  now += duration;
  const move = touchEvent(node, x + dx, y + dy);
  document.emit('touchmove', move);
  document.emit(end, touchEvent(node, x + dx, y + dy, 0));
  return move.defaultPrevented;
}
assert.equal(swipe(target, 40, 140, 120), true);
assert.ok(menu.isOpen(), 'Menu opens from the inner edge band');
assert.equal(menu.panel.classList.contains('drawer-dragging'), false);
assert.equal(swipe(menu.panel, 180, 140, -120), true);
assert.ok(!menu.isOpen(), 'Left swipe closes');
const navButton = new Node(menu.panel);
navButton.closest = selector => selector === 'button, a' ? navButton : null;
menu.panel.classList.add('open');
swipe(navButton, 160, 140, -120);
assert.ok(!menu.isOpen(), 'Navigation buttons can be swiped closed without navigating');
assert.equal(swipe(target, 40, 140, 10, 90), false, 'Vertical scrolling stays native');
assert.equal(swipe(target, 10, 140, 120), false, 'Safari edge remains free');
swipe(target, 40, 140, 20); assert.ok(!menu.isOpen(), 'Short drag cancels');
swipe(target, 40, 140, 120, 0, 'touchcancel'); assert.ok(!menu.isOpen(), 'System cancellation does not open');
assert.ok(!menu.panel.classList.contains('drawer-dragging'));
swipe(header, 140, 35, 90); assert.ok(history.isOpen(), 'Header opens history even in the left half');
swipe(history.backdrop, 340, 140, -120); assert.ok(!history.isOpen(), 'Backdrop swipe closes history');
const blocked = new Node(document.body); blocked.blocked = true;
assert.equal(swipe(blocked, 40, 140, 120), false, 'Inputs and buttons retain touch behavior');
document.activeElement = blocked;
assert.equal(swipe(blocked, 40, 140, 120), false, 'Focused editor keeps text gestures');
document.activeElement = null;
modal = true; assert.equal(swipe(target, 40, 140, 120), false, 'Modal owns gestures'); modal = false;
selected = true; assert.equal(swipe(target, 40, 140, 120), false, 'Text selection owns gestures'); selected = false;
target.scrollWidth = 600; target.overflowX = 'auto';
assert.equal(swipe(target, 40, 140, 120), false, 'Horizontal content scrolls');
target.scrollWidth = 300;
document.emit('touchstart', touchEvent(target, 40, 140));
document.emit('touchmove', touchEvent(target, 160, 140, 2));
document.emit('touchend', touchEvent(target, 160, 140, 0));
assert.ok(!menu.isOpen(), 'Multi-touch cancels');
for (const event of ['resize', 'blur']) {
  document.emit('touchstart', touchEvent(target, 40, 140));
  document.emit('touchmove', touchEvent(target, 160, 140));
  assert.ok(menu.panel.classList.contains('drawer-dragging'));
  window.emit(event);
  assert.ok(!menu.panel.classList.contains('drawer-dragging'), event + ' clears preview');
}
phone = false; assert.equal(swipe(target, 40, 140, 120), false, 'Desktop stays unchanged'); phone = true;
swipe(target, 180, 140, 64, 40);
assert.ok(menu.isOpen(), 'A short diagonal swipe opens from the broad starting zone');
swipe(menu.panel, 180, 140, -64, 40);
assert.ok(!menu.isOpen(), 'Diagonal swipe dismisses');
const cardButton = new Node(target);
cardButton.closest = selector => selector === 'button, a' ? cardButton : null;
swipe(cardButton, 130, 180, 60);
assert.ok(menu.isOpen(), 'Swiping from a button does not require precise aiming');
swipe(menu.panel, 180, 140, -60);
swipe(target, 130, 180, 30, 0, 'touchend', 60);
assert.ok(menu.isOpen(), 'Short fast flick opens');
swipe(menu.panel, 180, 140, -60);
swipe(target, 225, 300, 60, 25);
assert.ok(history.isOpen(), 'Conversation content opens history from the right half');
swipe(history.panel, 220, 140, -60);
releaseHistory(); assert.equal(swipe(header, 220, 35, 120), false, 'Unmount removes view gesture');
console.log('PASS: broad/diagonal swipes, flicks, button starts, drawer ownership, scrolling/editing, cancellation and cleanup.');
