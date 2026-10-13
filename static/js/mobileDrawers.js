// One touch recognizer for the app menu and view-owned drawers. Touch events
// leave vertical scrolling to Safari; only a deliberate horizontal drag wins.
const drawers = new Set();
let installed = false;
let gesture = null;
let suppressClickUntil = 0;
const mobile = () => matchMedia('(max-width: 768px)').matches;
const excluded = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], .overflow-menu, .model-picker-menu, .custom-select-menu, pre, canvas';

// A broad starting area, with only the outermost edge reserved for iOS Back.
export const isMainDrawerZone = touch => touch.clientX >= 16 && touch.clientX <= Math.min(200, innerWidth * .5);

function clearGesture() {
  if (gesture?.locked) {
    gesture.drawer.panel.classList.remove('drawer-dragging');
    gesture.drawer.panel.style.removeProperty('--drawer-swipe-x');
    gesture.drawer.backdrop.style.removeProperty('display');
    gesture.drawer.backdrop.style.removeProperty('opacity');
    gesture.drawer.onDragEnd?.();
  }
  gesture = null;
}

function start(event) {
  clearGesture();
  if (!mobile() || event.touches.length !== 1 || document.querySelector('dialog[open], [aria-modal="true"]') ||
      !event.target.closest || event.target.closest(excluded) ||
      !window.getSelection()?.isCollapsed) return;
  // Horizontal content (code, tables, carousels) keeps its own gestures.
  for (let node = event.target; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
  }
  const touch = event.touches[0];
  const candidates = [...drawers].filter(d => d.panel.isConnected);
  const opened = candidates.find(d => d.isOpen());
  // Buttons and links keep ordinary taps. Only a committed horizontal drag
  // cancels their click, so starting on a card or title doesn't require aiming.
  const drawer = opened || candidates.find(d => d.canOpen(event.target, touch));
  if (!drawer || (opened && !opened.panel.contains(event.target) && !opened.backdrop.contains(event.target))) return;
  gesture = { drawer, open: !!opened, id: touch.identifier, x: touch.clientX, y: touch.clientY,
    at: performance.now(), dx: 0, locked: false };
}

function move(event) {
  if (!gesture) return;
  if (!mobile() || event.touches.length !== 1) { clearGesture(); return; }
  const touch = [...event.touches].find(t => t.identifier === gesture.id);
  if (!touch) { clearGesture(); return; }
  const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
  if (!gesture.locked) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
    if ((Math.abs(dy) >= 14 && Math.abs(dy) > Math.abs(dx) * 1.25) ||
        (Math.abs(dx) >= 10 && (gesture.open ? dx > 0 : dx < 0))) { clearGesture(); return; }
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    gesture.width = gesture.drawer.panel.getBoundingClientRect().width;
    gesture.locked = true;
    gesture.drawer.panel.classList.add('drawer-dragging');
  }
  if (!event.cancelable) { clearGesture(); return; }
  event.preventDefault();
  gesture.dx = dx;
  const offset = Math.max(-gesture.width, Math.min(0, (gesture.open ? 0 : -gesture.width) + dx));
  gesture.drawer.panel.style.setProperty('--drawer-swipe-x', `${offset}px`);
  gesture.drawer.backdrop.style.display = 'block';
  gesture.drawer.backdrop.style.opacity = String(1 + offset / gesture.width);
  gesture.drawer.onDrag?.(offset, gesture.width);
}

function end(event) {
  if (!gesture?.locked) { clearGesture(); return; }
  const { drawer, open, dx, width, at } = gesture;
  const distance = open ? -dx : dx;
  const commit = distance >= Math.min(56, width * .2) ||
    (distance >= 24 && distance / Math.max(1, performance.now() - at) > .35);
  if (event.cancelable) event.preventDefault();
  suppressClickUntil = performance.now() + 400;
  clearGesture();
  if (commit) open ? drawer.close() : drawer.open();
}

export function registerMobileDrawer(drawer) {
  drawers.add(drawer);
  if (!installed) {
    installed = true;
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end, { passive: false });
    document.addEventListener('touchcancel', clearGesture, { passive: true });
    document.addEventListener('kairos:mobile-drawer-opening', clearGesture);
    window.addEventListener('resize', clearGesture);
    window.addEventListener('blur', clearGesture);
    document.addEventListener('visibilitychange', clearGesture);
    document.addEventListener('click', event => {
      if (performance.now() < suppressClickUntil && event.detail > 0) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
  }
  return () => {
    if (gesture?.drawer === drawer) clearGesture();
    drawers.delete(drawer);
  };
}
