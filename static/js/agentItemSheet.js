import { el } from './api.js';
import { agentAvatar } from './agentAvatar.js';

// 2026-10-14: native modal focus containment also makes the background inert.
// Details are snapshots; actions return to the original, draft-preserving card.
export function openAgentItemSheet({ title, description, details, agent, primary, onPrimary, secondary, onSecondary }) {
  const previous = document.activeElement;
  let finished = false;
  const finish = () => { if (finished) return; finished = true; sheet.remove(); if (previous?.isConnected) previous.focus(); };
  const dismiss = () => { sheet.close(); finish(); };
  document.querySelector('.agent-item-sheet')?.close();
  const close = el('button', { type: 'button', class: 'btn quiet agent-item-close', text: '×', 'aria-label': 'Close details' });
  const sheet = el('dialog', { class: 'agent-item-sheet', 'aria-labelledby': 'agent-item-title' }, [
    el('div', { class: 'agent-item-grip', 'aria-hidden': 'true' }), close,
    el('div', { class: 'agent-item-portrait' }, [agentAvatar(agent, 100)]),
    el('h2', { id: 'agent-item-title', text: title }),
    el('p', { text: description || '' }), ...(details ? [el('p', { class: 'agent-item-details', text: details })] : []),
    el('button', { type: 'button', class: 'btn primary agent-item-primary', text: primary, onclick: () => { dismiss(); onPrimary?.(); } }),
    el('button', { type: 'button', class: 'btn quiet agent-item-secondary', text: secondary, onclick: () => { dismiss(); onSecondary?.(); } }),
  ]);
  close.onclick = dismiss;
  let start = null;
  sheet.addEventListener('pointerdown', event => {
    // Only the handle/portrait starts dismissal, so scrolling details stays usable.
    if (event.target.closest('.agent-item-grip, .agent-item-portrait')) { start = { id: event.pointerId, y: event.clientY }; if (event.isTrusted) sheet.setPointerCapture(event.pointerId); }
  });
  sheet.addEventListener('pointerup', event => {
    if (start?.id === event.pointerId && event.clientY - start.y > 70) dismiss();
    start = null;
  });
  sheet.addEventListener('pointercancel', () => { start = null; });
  sheet.addEventListener('click', event => {
    const bounds = sheet.getBoundingClientRect();
    if (event.target === sheet && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dismiss();
  });
  sheet.addEventListener('keydown', event => {
    // 2026-10-14: a routine sheet can sit over the profile; its Escape must
    // dismiss only the top sheet, leaving the profile's editor available.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    event.stopPropagation();
    const focusable = [...sheet.querySelectorAll('button:not(:disabled), a[href], input, textarea')].filter(node => node.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  sheet.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  sheet.addEventListener('close', finish, { once: true });
  document.body.append(sheet); sheet.showModal(); close.focus();
  return sheet;
}
