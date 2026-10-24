import { mobileOn, phone, button } from './mobileShared.js';
import { watchKeyboard, keyboardLift, belowFold } from './mobileDock.js';
import { ICONS } from './icons.js';
let sheetId = 0;

// Also used by existing panel dialogs: their nesting, confirmation and owner
// lifecycle remain in api.js. Only the phone presentation/gesture is added.
export function mountSheetSurface(panel, close) {
  panel.classList.add('ms-sheet-surface');
  const grabber = button('', close, 'ms-sheet-grabber');
  const gate = () => {
    const on = mobileOn(); grabber.hidden = !on;
    panel.classList.toggle('rd-sheet-in', on);
    if (panel.parentElement?.classList.contains('modal-backdrop')) panel.parentElement.classList.toggle('rd-scrim-in', on);
  };
  gate(); phone.addEventListener('change', gate); document.addEventListener('kairos:appearance', gate);
  grabber.setAttribute('aria-label', 'Close sheet'); panel.prepend(grabber);
  let start = null;
  const down = event => { if (mobileOn() && event.button === 0) start = { x: event.clientX, y: event.clientY, id: event.pointerId }; };
  const up = event => {
    if (start && start.id === event.pointerId && event.clientY - start.y > 64 && Math.abs(event.clientX - start.x) < 48) close();
    start = null;
  };
  const cancel = () => { start = null; };
  grabber.addEventListener('pointerdown', down); grabber.addEventListener('pointerup', up);
  grabber.addEventListener('pointercancel', cancel);
  // Pointer capture keeps a downward drag on the grabber as it leaves its hit area.
  const capture = event => { grabber.setPointerCapture?.(event.pointerId); };
  grabber.addEventListener('pointerdown', capture);
  return () => { phone.removeEventListener('change', gate); document.removeEventListener('kairos:appearance', gate); grabber.remove(); panel.classList.remove('ms-sheet-surface', 'rd-sheet-in'); };
}

export function openMobileSheet({ title, content, opener = document.activeElement, fullHeight = false, onClose }) {
  if (!mobileOn()) return null;
  const dialog = document.createElement('dialog'); dialog.className = `ms-sheet${fullHeight ? ' ms-sheet-full' : ''}`; dialog.id = `ms-sheet-${++sheetId}`;
  dialog.setAttribute('aria-label', title);
  const heading = document.createElement('header'); heading.className = 'ms-sheet-header';
  const name = document.createElement('h2'); name.textContent = title;
  const dismiss = button('Close', () => close(), 'ms-glass'); heading.append(name, dismiss);
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
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    // Page-level outside-click handlers must not dismiss a live menu that has
    // moved into this sheet when its search or Options control is tapped.
    event.stopPropagation();
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
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
