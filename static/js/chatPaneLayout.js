import { el } from './api.js';

// The chat keeps most of the room and a document opens beside it at about
// 40% (David, 2026-10-09: "the default width to be a lot smaller"). These
// are shares of the chat area; MAX_SHARE leaves room to widen the chat more.
const DEFAULT_SHARE = 0.6;
const MAX_SHARE = 0.7;
const MIN_WIDTH = 380;
// A new key, so widths saved under the old 520 px default don't hide it.
const STORAGE_KEY = 'kairos:chat-pane-width';
let current = null;

// Every right-hand pane registers here so even rapid opens close the native
// browser synchronously. The registration owns the divider and its listeners.
export function mountChatPane(host, panel, close, { onDrag } = {}) {
  const main = host.querySelector('#chat-main');
  // Capture the painted width before replacing a pane. An auto width cannot
  // transition to the fixed split width in CSS, so interpolate pixels once.
  const openingWidth = main?.getBoundingClientRect().width;
  const replacingPane = current?.host === host && host.classList.contains('has-pane');
  current?.close();
  let preferred = null; // null: the default share of whatever room there is
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH) preferred = saved;
  } catch { /* Storage can be disabled on this device. */ }
  const defaultWidth = () => Math.round(host.clientWidth * DEFAULT_SHARE);
  const handle = el('div', { class: 'chat-pane-resizer', tabindex: '0', role: 'separator',
    'aria-label': 'Resize chat column', 'aria-orientation': 'vertical', 'aria-controls': 'chat-main' });
  let pointer = null, startX = 0, startWidth = 0;
  let maximized = false;
  let entrance = [];
  const stopEntrance = () => {
    for (const animation of entrance) animation.cancel();
    entrance = [];
    if (host.classList.contains('pane-opening')) {
      // Settle the underlying split while CSS transitions are disabled.
      // Re-enabling them during cancellation would start a second animation.
      main?.getBoundingClientRect();
      host.classList.remove('pane-opening');
    }
  };
  const inertBefore = new Map();
  const maximum = () => Math.max(MIN_WIDTH, Math.floor(host.clientWidth * MAX_SHARE));
  const clamp = width => Math.max(MIN_WIDTH, Math.min(maximum(), width));
  const sync = () => {
    const width = clamp(preferred ?? defaultWidth());
    host.style.setProperty('--chat-pane-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    handle.setAttribute('aria-valuetext', `${Math.round(width)} pixels`);
  };
  const save = () => {
    try {
      if (preferred === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(preferred));
    } catch { /* Best effort. */ }
  };
  const resize = width => { stopEntrance(); preferred = clamp(width); sync(); };
  const stopDrag = () => {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    host.classList.remove('pane-dragging');
    onDrag?.(false);
    save();
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || window.innerWidth <= 1100) return;
    event.preventDefault();
    stopEntrance();
    handle.focus({ preventScroll: true });
    pointer = event.pointerId; startX = event.clientX; startWidth = main.getBoundingClientRect().width;
    handle.setPointerCapture(pointer);
    host.classList.add('pane-dragging');
    onDrag?.(true);
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId === pointer) resize(startWidth + event.clientX - startX);
  });
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('lostpointercapture', stopDrag);
  handle.addEventListener('dblclick', () => { stopEntrance(); preferred = null; sync(); save(); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    resize(clamp(preferred ?? defaultWidth()) + (event.key === 'ArrowRight' ? 24 : -24)); save();
  });
  const setMaximized = value => {
    if (value) stopEntrance();
    maximized = value && window.innerWidth > 1100;
    host.classList.toggle('pane-maximized', maximized);
    // Hidden conversations must also leave the keyboard/accessibility tree.
    for (const node of host.querySelectorAll('#chat-main, #chat-sessions, .side-chat')) {
      if (maximized) {
        if (!inertBefore.has(node)) inertBefore.set(node, node.inert);
        node.inert = true;
      }
    }
    if (!maximized) {
      for (const [node, inert] of inertBefore) node.inert = inert;
      inertBefore.clear();
    }
    panel.dispatchEvent(new CustomEvent('pane-maximize', { detail: maximized }));
  };
  const onWindowResize = () => {
    stopEntrance();
    if (window.innerWidth <= 1100) { stopDrag(); setMaximized(false); }
    sync();
  };
  const animateDocuments = !replacingPane && (panel.classList.contains('artifact-viewer') || panel.classList.contains('chat-files-panel'))
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const split = window.innerWidth > 1100 && main && !host.classList.contains('forge-conversation');
  // Disable the CSS resize transition before installing the split, including
  // replacements and reduced motion. Only the shared entrance owns opening.
  if (split) host.classList.add('pane-opening');
  host.classList.add('has-pane');
  host.append(handle);
  if (host.moveBefore && panel.isConnected) host.moveBefore(panel, null);
  else host.append(panel);
  sync();
  const targetWidth = main?.getBoundingClientRect().width;
  if (animateDocuments) {
    const timing = { duration: 300, easing: 'cubic-bezier(.22, 1, .36, 1)' };
    entrance.push(panel.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'translateX(0)' }], timing));
    if (split) {
      // Measure the settled CSS split, including its saved-width clamp.
      const animation = main.animate([{ width: `${openingWidth}px` }, { width: `${targetWidth}px` }], timing);
      entrance.push(animation);
      animation.onfinish = () => {
        if (!entrance.includes(animation)) return;
        main.getBoundingClientRect();
        host.classList.remove('pane-opening');
      };
    }
  }
  if (!animateDocuments) host.classList.remove('pane-opening');
  let hostWidth = host.clientWidth;
  const observer = new ResizeObserver(() => {
    if (host.clientWidth !== hostWidth) { stopEntrance(); hostWidth = host.clientWidth; }
    sync();
  });
  observer.observe(host);
  window.addEventListener('resize', onWindowResize);
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onMotionChange = () => { if (motion.matches) stopEntrance(); };
  motion.addEventListener('change', onMotionChange);
  const registration = current = { close, host };
  return {
    isMaximized: () => maximized,
    setMaximized,
    dispose() {
      stopEntrance();
      stopDrag(); setMaximized(false);
      observer.disconnect(); window.removeEventListener('resize', onWindowResize);
      motion.removeEventListener('change', onMotionChange);
      handle.remove();
      host.classList.remove('has-pane', 'pane-dragging');
      host.style.removeProperty('--chat-pane-width');
      if (current === registration) current = null;
    },
  };
}
