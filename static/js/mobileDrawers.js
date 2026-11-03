// One touch recognizer for the app menu and view-owned drawers. Touch events
// leave vertical scrolling to Safari; only a deliberate horizontal drag wins.
// A drawer may also offer a way back (2026-11-03, David): on a pushed page a
// swipe right goes back a page first, and only a top-level page opens the drawer.
const drawers = new Set();
let installed = false;
let gesture = null;
let suppressClickUntil = 0;
const mobile = () => matchMedia('(max-width: 768px)').matches;
const excluded = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="slider"], .overflow-menu, .model-picker-menu, .custom-select-menu, pre, canvas';

// A broad starting area, with only the outermost edge reserved for iOS Back.
export const isMainDrawerZone = touch => touch.clientX >= 16 && touch.clientX <= Math.min(200, innerWidth * .5);

function clearGesture() {
  if (gesture?.locked && gesture.back) gesture.drawer.onBackCancel?.({ speed: 0 });
  else if (gesture?.locked) {
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
  // Another modal on screen keeps its own gestures; a registered drawer, open, is modal itself.
  const modal = document.querySelector('dialog[open], [aria-modal="true"]:not(dialog)');
  if (!mobile() || event.touches.length !== 1 || (modal && ![...drawers].some(d => d.panel === modal)) ||
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
  let drawer = opened, back = null;
  if (!opened) {
    // A pushed page's way back comes first; each drawer decides its own starting area for it.
    for (const candidate of candidates) { back = candidate.back?.(event.target, touch) || null; if (back) { drawer = candidate; break; } }
    if (!back) { if (touch.clientX < 16) return; drawer = candidates.find(d => d.canOpen(event.target, touch)); }
  }
  if (!drawer || (opened && !opened.panel.contains(event.target) && !opened.backdrop.contains(event.target))) return;
  gesture = { drawer, back, open: !!opened, id: touch.identifier, x: touch.clientX, y: touch.clientY,
    at: performance.now(), dx: 0, locked: false, samples: [{ x: touch.clientX, t: performance.now() }] };
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
        (Math.abs(dx) >= 10 && (gesture.open ? dx > 0 : dx < 0))) { gesture = null; return; }
    if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.15) return;
    gesture.width = gesture.back ? innerWidth : gesture.drawer.panel.getBoundingClientRect().width;
    gesture.locked = true;
    if (!gesture.back) gesture.drawer.panel.classList.add('drawer-dragging');
  }
  if (!event.cancelable) { clearGesture(); return; }
  event.preventDefault();
  gesture.dx = dx;
  const now = performance.now();
  gesture.samples.push({ x: touch.clientX, t: now });
  while (gesture.samples.length > 2 && now - gesture.samples[0].t > 100) gesture.samples.shift();
  if (gesture.back) { gesture.drawer.onBackDrag?.(Math.max(0, dx)); return; }
  const offset = Math.max(-gesture.width, Math.min(0, (gesture.open ? 0 : -gesture.width) + dx));
  gesture.drawer.panel.style.setProperty('--drawer-swipe-x', `${offset}px`);
  gesture.drawer.backdrop.style.display = 'block';
  gesture.drawer.backdrop.style.opacity = String(1 + offset / gesture.width);
  gesture.drawer.onDrag?.(offset, gesture.width);
}

function end(event) {
  if (!gesture?.locked) { gesture = null; return; }
  const { drawer, back, open, dx, width, samples } = gesture;
  const distance = open ? -dx : dx;
  // The finger's speed over its last moments, in the direction of the swipe (px/ms).
  const first = samples[0], last = samples.at(-1);
  const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
  const speed = open ? -velocity : velocity;
  // Far enough, or a quick flick; a finger already heading back cancels.
  const commit = speed > -0.2 && (distance >= (back ? width * .3 : Math.min(56, width * .2)) ||
    (distance >= 24 && speed > .35));
  if (event.cancelable) event.preventDefault();
  suppressClickUntil = performance.now() + 400;
  if (back) { gesture = null; commit ? drawer.onBack(back, { speed: Math.max(0, speed) }) : drawer.onBackCancel?.({ speed: Math.max(0, -speed) }); return; }
  clearGesture();
  if (commit) open ? drawer.close({ speed: Math.max(0, speed) }) : drawer.open({ speed: Math.max(0, speed) });
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
