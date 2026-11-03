import { mobileOn, phone, button, reduced } from './mobileShared.js';
import { watchKeyboard, keyboardLift, belowFold } from './mobileDock.js';
import { ICONS } from './icons.js';
let sheetId = 0;
// Each dragged sheet's animated dismissal, so its close button, Escape and a
// tap outside slide it away too (slideSheetAway) instead of making it vanish.
const leaving = new WeakMap();
// Slides a phone sheet off the bottom and then runs its owner's close(). False
// where it cannot (a desktop, a sheet without the drag), so the caller closes it.
export function slideSheetAway(panel) {
  const dismiss = panel && leaving.get(panel);
  return dismiss ? dismiss() : false;
}

// Also used by existing panel dialogs: their nesting, confirmation and owner
// lifecycle remain in api.js. Only the phone presentation/gesture is added.
export function mountSheetSurface(panel, close) {
  panel.classList.add('ms-sheet-surface');
  const grabber = button('', () => slideSheetAway(panel) || close(), 'ms-sheet-grabber');
  const gate = () => {
    const on = mobileOn(); grabber.hidden = !on;
    panel.classList.toggle('rd-sheet-in', on);
    if (panel.parentElement?.classList.contains('modal-backdrop')) panel.parentElement.classList.toggle('rd-scrim-in', on);
  };
  gate(); phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
  grabber.setAttribute('aria-label', 'Close sheet'); panel.prepend(grabber);
  const disposeDrag = attachSheetDrag(panel, close, { enabled: mobileOn });
  return () => { disposeDrag(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); grabber.remove(); panel.classList.remove('ms-sheet-surface', 'rd-sheet-in'); };
}

// Swipe down to dismiss, shared by every phone sheet and popup. The sheet follows
// the finger 1:1 (and resists a pull up past its rest) and the scrim fades with
// the distance; letting go past a quarter of the height (or with a downward
// flick) slides it away at the finger's speed and then runs the same close()
// the close button runs, otherwise it settles back without overshoot
// (2026-11-03, David). Only a downward drag that starts on the handle or
// header, or on content scrolled to its top, counts.
// Decelerates from the release: the curve starts at 3.5x its average speed.
const SLIDE = 'cubic-bezier(.2,.7,.3,1)', SLIDE_SLOPE = 3.5;
const SETTLE = 'cubic-bezier(.32,.72,0,1)';
const HANDLE = '.ms-sheet-grabber, .ms-sheet-grab, .ts-sheet-grip, .agent-item-grip';
const HEADER = '.ms-sheet-header, .ms-more-header, .ms-sheet-heading, .modal-header, .permission-head, .question-head, .ts-sheet-bar, .agent-item-portrait';
const OWN_GESTURE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [data-no-sheet-drag]';
export function attachSheetDrag(panel, close, { enabled = () => phone.matches } = {}) {
  let scrim = panel;
  const abort = new AbortController(), { signal } = abort;
  let gesture = null, settling = false, away = false, swallow = false;
  const atTop = target => {
    for (let node = target; node; node = node.parentElement) {
      if (node.scrollTop > 0) return false;
      if (node === panel) break;
    }
    return true;
  };
  const scrimOf = () => (panel.matches('dialog') ? panel : panel.parentElement || panel);
  // The panel and its scrim can be one element (a dialog and its ::backdrop): one transition list for both.
  const animate = (timing, transform, drag) => {
    panel.style.transition = scrim === panel ? `transform ${timing}, --sheet-drag ${timing}` : `transform ${timing}`;
    if (scrim !== panel) scrim.style.transition = `--sheet-drag ${timing}`;
    panel.style.transform = transform; progress(drag);
  };
  const clear = () => {
    for (const node of [panel, scrim]) { node.style.transition = ''; node.style.removeProperty('--sheet-drag'); node.removeAttribute('data-sheet-dragging'); }
    panel.style.transform = ''; panel.style.willChange = ''; panel.getAnimations().forEach(animation => animation.cancel()); settling = false; away = false; gesture = null;
  };
  const progress = value => scrim.style.setProperty('--sheet-drag', String(Math.min(1, Math.max(0, value))));
  const start = (x, y, target, pointer) => {
    scrim = scrimOf();
    if (settling || !enabled() || !target?.closest || target.closest(OWN_GESTURE)) return;
    const handle = target.closest(HANDLE);
    if (!handle && target.closest('button, a[href], [role="button"]')) return;
    if (pointer && !handle && !target.closest(HEADER)) return;
    if (!handle && !atTop(target)) return;
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && panel.contains(selection.anchorNode)) return;
    // Only the handle or header can be pulled up (to give); content above its top scrolls instead.
    gesture = { x, y, grip: !!(handle || target.closest(HEADER)), active: false, dy: 0, height: panel.getBoundingClientRect().height || 1, samples: [{ y, t: performance.now() }] };
  };
  const move = (x, y, event) => {
    if (!gesture) return;
    const dx = x - gesture.x, dy = y - gesture.y;
    if (!gesture.active) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if ((dy <= 0 && !gesture.grip) || Math.abs(dx) > Math.abs(dy)) { gesture = null; return; }
      gesture.active = true;
      if (gesture.pointerId != null) panel.setPointerCapture?.(gesture.pointerId);
      panel.classList.remove('rd-sheet-in'); scrim.classList.remove('rd-scrim-in');
      panel.style.transition = 'none'; scrim.style.transition = 'none'; panel.style.willChange = 'transform';
      scrim.setAttribute('data-sheet-dragging', '');
    }
    if (event.cancelable) event.preventDefault();
    // Above its rest the sheet gives a little and then stops, as iOS sheets do.
    gesture.dy = dy >= 0 ? dy : -18 * (1 - 1 / (1 - dy / 60));
    const now = performance.now();
    gesture.samples.push({ y, t: now });
    while (gesture.samples.length > 2 && now - gesture.samples[0].t > 100) gesture.samples.shift();
    if (!reduced.matches) { panel.style.transform = `translateY(${gesture.dy}px)`; progress(Math.max(0, gesture.dy) / gesture.height); }
  };
  const spring = () => {
    settling = true;
    animate(`300ms ${SETTLE}`, 'translateY(0)', 0);
    setTimeout(clear, 320);
  };
  // speed: the finger's downward speed at release, in px/ms (0 for a button, Escape or a tap outside).
  const dismiss = (speed = 0) => {
    if (away) return true;
    if (!enabled() || !panel.isConnected || !panel.getClientRects().length) return false;
    settling = true; away = true; gesture = null; scrim = scrimOf();
    panel.classList.remove('rd-sheet-in'); scrim.classList.remove('rd-scrim-in');
    panel.getAnimations().forEach(animation => animation.cancel());
    scrim.setAttribute('data-sheet-dragging', '');
    // A dialog that closed is put back at rest at once, so the next open starts from its natural place.
    const finish = () => { close(); if (panel.matches('dialog') && !panel.open) clear(); };
    let wait;
    if (reduced.matches) {
      panel.animate({ opacity: [1, 0] }, { duration: 120, easing: 'ease-out', fill: 'forwards' }); progress(1);
      wait = 130; setTimeout(finish, wait);
    } else {
      const distance = Math.max(1, innerHeight - panel.getBoundingClientRect().top);
      // A flick carries the sheet away at the finger's speed; a tap slides it at the sheet's own pace.
      const duration = speed > 0 ? Math.round(Math.min(340, Math.max(160, SLIDE_SLOPE * distance / speed))) : 300;
      animate(`${duration}ms ${speed > 0 ? SLIDE : SETTLE}`, `translateY(${distance}px)`, 1);
      let done = false;
      const once = () => { if (!done) { done = true; finish(); } };
      panel.addEventListener('transitionend', event => { if (event.target === panel && event.propertyName === 'transform') once(); }, { signal });
      wait = duration + 40; setTimeout(once, wait);
    }
    // A close that is answered asynchronously (or refused) must not leave an invisible sheet behind.
    // (A close that went through has cleared `away`, so a sheet opened again since is left alone.)
    setTimeout(() => { if (away && panel.isConnected && panel.getClientRects().length && (!panel.matches('dialog') || panel.open)) spring(); }, wait + 840);
    return true;
  };
  leaving.set(panel, () => dismiss());
  const end = () => {
    const finished = gesture; gesture = null;
    if (!finished?.active) return;
    swallow = true; setTimeout(() => { swallow = false; }, 80);
    const first = finished.samples[0], last = finished.samples.at(-1);
    const speed = last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    // A flick down closes; a pull past a quarter closes unless the finger was already heading back up.
    if ((speed > 0.5 && finished.dy > 24) || (finished.dy > finished.height * 0.25 && speed > -0.2)) dismiss(Math.max(0, speed)); else spring();
  };
  const abandon = () => { const was = gesture; gesture = null; if (was?.active) spring(); };
  panel.addEventListener('touchstart', event => {
    if (event.touches.length === 1) start(event.touches[0].clientX, event.touches[0].clientY, event.target, false); else abandon();
  }, { passive: true, signal });
  panel.addEventListener('touchmove', event => { if (event.touches.length === 1) move(event.touches[0].clientX, event.touches[0].clientY, event); else abandon(); }, { passive: false, signal });
  panel.addEventListener('touchend', end, { signal });
  panel.addEventListener('touchcancel', abandon, { signal });
  // A mouse or pen has no scroll gesture to compete with, so it drags by the handle and header only.
  panel.addEventListener('pointerdown', event => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    start(event.clientX, event.clientY, event.target, true);
    if (gesture) gesture.pointerId = event.pointerId;
  }, { signal });
  panel.addEventListener('pointermove', event => { if (event.pointerType !== 'touch') move(event.clientX, event.clientY, event); }, { signal });
  panel.addEventListener('pointerup', event => { if (event.pointerType !== 'touch') end(); }, { signal });
  panel.addEventListener('pointercancel', event => { if (event.pointerType !== 'touch') abandon(); }, { signal });
  // The click that follows a drag released on the handle must not also close the sheet.
  panel.addEventListener('click', event => { if (swallow) { event.stopImmediatePropagation(); event.preventDefault(); swallow = false; } }, { capture: true, signal });
  // A reused dialog (the More sheet) opens again from its natural position.
  panel.addEventListener('close', clear, { signal });
  return () => { abort.abort(); leaving.delete(panel); clear(); };
}

export function openMobileSheet({ title, content, opener = document.activeElement, fullHeight = false, onClose }) {
  if (!mobileOn()) return null;
  const dialog = document.createElement('dialog'); dialog.className = `ms-sheet${fullHeight ? ' ms-sheet-full' : ''}`; dialog.id = `ms-sheet-${++sheetId}`;
  dialog.setAttribute('aria-label', title);
  const heading = document.createElement('header'); heading.className = 'ms-sheet-header';
  const name = document.createElement('h2'); name.textContent = title;
  const dismiss = button('Close', () => slideSheetAway(dialog) || close(), 'ms-glass'); heading.append(name, dismiss);
  dismiss.textContent = ''; dismiss.innerHTML = ICONS.close; dismiss.setAttribute('aria-label', 'Close');
  const body = document.createElement('div'); body.className = 'ms-sheet-body'; body.append(content);
  dialog.append(heading, body); document.body.append(dialog);
  const keyboard = watchKeyboard(dialog);
  // The visible height; with the keyboard down that includes any page below the layout viewport (belowFold).
  const viewport = () => {
    const visible = window.visualViewport?.height || innerHeight;
    dialog.style.setProperty('--ms-sheet-height', `${visible + (keyboardLift(innerHeight, window.visualViewport) ? 0 : belowFold())}px`);
  };
  viewport(); window.visualViewport?.addEventListener('resize', viewport);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    keyboard(); window.visualViewport?.removeEventListener('resize', viewport);
    cleanupSurface(); phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate);
    onClose?.(); dialog.close(); dialog.remove();
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
  };
  const gate = () => { if (!mobileOn()) close(); };
  const cleanupSurface = mountSheetSurface(dialog, close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); slideSheetAway(dialog) || close(); });
  dialog.addEventListener('click', event => {
    // Page-level outside-click handlers must not dismiss a live menu that has
    // moved into this sheet when its search or Options control is tapped.
    event.stopPropagation();
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) slideSheetAway(dialog) || close();
  });
  dialog.addEventListener('keydown', event => {
    if (event.target?.closest?.('.panel-dialog')) return;
    if (event.key !== 'Tab') return;
    const list = [...dialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && !node.closest('[hidden], [inert]'));
    const at = list.indexOf(document.activeElement);
    if (event.shiftKey ? at <= 0 : at < 0 || at === list.length - 1) {
      event.preventDefault(); (event.shiftKey ? list.at(-1) : list[0])?.focus();
    }
  });
  phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
  dialog.showModal(); dismiss.focus();
  return { dialog, body, close, dismiss };
}
