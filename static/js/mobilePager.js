import { mobileOn, reduced, haptic } from './mobileShared.js';

// One continuous progress value drives both the pages and the glass thumb.
// The system back edge remains free; the rest of the surface belongs to the pager.
export function mountPager(host, pages, tabs, initial = 0, onChange = () => {}, enabled = () => true) {
  let index = initial, gesture = null, suppress = false;
  const paint = progress => host.style.setProperty('--ms-page', progress);
  const select = next => {
    const previous = index;
    index = Math.max(0, Math.min(1, next));
    if (previous !== index && mobileOn()) pages[index].classList.add('rd-enter-rise');
    if (pages[1 - index].contains(document.activeElement)) document.activeElement.blur?.();
    host.classList.remove('ms-dragging'); paint(index);
    // Focusing a control on the off-screen page can scroll the clipped window; the transform alone positions pages.
    const clip = pages[0].parentElement?.parentElement; if (clip?.scrollLeft) clip.scrollLeft = 0;
    pages.forEach((page, i) => { page.inert = i !== index; page.setAttribute('aria-hidden', String(i !== index)); });
    tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    onChange(index);
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => { haptic(); select(i); });
    tab.addEventListener('keydown', e => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        e.preventDefault(); select(e.key === 'Home' ? 0 : e.key === 'End' ? 1 : e.key === 'ArrowRight' ? 1 : 0); tabs[index].focus();
      }
    });
  });
  // A swipe belongs to content that can still scroll sideways in that direction.
  const scrolls = (node, dx) => {
    for (; node && node !== host; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX) &&
          (dx > 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1)) return true;
    }
    return false;
  };
  const start = e => {
    gesture = null;
    if (!mobileOn() || !enabled() || e.touches.length !== 1 || document.querySelector('dialog[open], [aria-modal="true"]') ||
        e.target.closest('input, textarea, select, a, [contenteditable], pre, canvas') ||
        (e.target.closest('button') && !e.target.closest('.ms-history-main') && !e.target.closest('.agents-rail-item')) || !window.getSelection()?.isCollapsed) return;
    const t = e.touches[0]; if (t.clientX < 16) return; gesture = { x: t.clientX, y: t.clientY, dx: 0, locked: false, at: performance.now(), target: e.target };
  };
  const move = e => {
    if (!gesture || e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - gesture.x, dy = t.clientY - gesture.y;
    if (!gesture.locked) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
      if (index === 1 && dx < 0) { gesture = null; return; }
      if (Math.abs(dy) > Math.abs(dx) || scrolls(gesture.target, dx)) { gesture = null; return; }
      gesture.locked = true; host.classList.add('ms-dragging');
    }
    if (e.cancelable) e.preventDefault();
    gesture.dx = dx;
    if (!reduced.matches) paint(Math.max(0, Math.min(1, index - dx / host.clientWidth)));
  };
  const end = () => {
    if (!gesture) return;
    if (gesture.locked) {
      const { dx, at } = gesture;
      const commit = Math.abs(dx) >= 60 || (Math.abs(dx) > 24 && Math.abs(dx) / (performance.now() - at) > .5);
      select(commit ? index + (dx < 0 ? 1 : -1) : index);
      suppress = true; setTimeout(() => { suppress = false; }, 400); haptic();
    }
    gesture = null;
  };
  const cancel = () => { gesture = null; select(index); };
  const click = e => { if (suppress) { e.preventDefault(); e.stopPropagation(); } };
  host.addEventListener('touchstart', start, { passive: true });
  host.addEventListener('touchmove', move, { passive: false });
  host.addEventListener('touchend', end); host.addEventListener('touchcancel', cancel);
  host.addEventListener('click', click, true);
  select(index);
  return { select, dispose() {
    host.removeEventListener('touchstart', start); host.removeEventListener('touchmove', move);
    host.removeEventListener('touchend', end); host.removeEventListener('touchcancel', cancel); host.removeEventListener('click', click, true);
  } };
}
