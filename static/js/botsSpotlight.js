import { h, Button, loadBotsCss } from './botsUi.js';

export function openSpotlight({ anchor, title, text, index, count, next, back, close }) {
  loadBotsCss('/static/css/bots-onboarding.css');
  const opener = document.activeElement;
  const ring = h('div', { class: 'bots-spotlight-ring', 'aria-hidden': 'true' });
  const heading = h('h2', { id: 'bots-tour-heading', text: title });
  const tooltip = h('div', { class: 'bots-spotlight-tip', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': heading.id, tabindex: '-1' }, [
    h('span', { class: 'bots-row-hint', text: `${index + 1} of ${count}` }), heading, h('p', { text }),
    h('div', { class: 'bots-tour-actions' }, [Button({ label: 'Back', disabled: index === 0, onClick: back }),
      Button({ label: index + 1 === count ? 'Done' : 'Next', variant: 'primary', onClick: next }), Button({ label: 'End tour', onClick: close })]),
  ]);
  const root = h('div', { class: 'bots-spotlight', 'data-section': 'tour', 'data-app-mode': 'bots' }, [ring, tooltip]);
  document.body.append(root);
  function place() {
    if (!anchor.isConnected) { close(); return; }
    const rect = anchor.getBoundingClientRect(), tip = tooltip.getBoundingClientRect();
    Object.assign(ring.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
    const top = rect.bottom + tip.height + 16 < innerHeight ? rect.bottom + 12 : rect.top - tip.height - 12;
    tooltip.style.top = `${Math.max(8, Math.min(innerHeight - tip.height - 8, top))}px`;
    tooltip.style.left = `${Math.max(8, Math.min(innerWidth - tip.width - 8, rect.left))}px`;
  }
  const key = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key !== 'Tab') return;
    const buttons = [...tooltip.querySelectorAll('button:not([disabled])')];
    const at = buttons.indexOf(document.activeElement);
    if (event.shiftKey && at <= 0) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && (at === buttons.length - 1 || at < 0)) { event.preventDefault(); buttons[0]?.focus(); }
  };
  document.addEventListener('keydown', key, true); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
  const observer = new ResizeObserver(place); observer.observe(anchor); observer.observe(tooltip);
  place(); tooltip.focus();
  return { destroy() { observer.disconnect(); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); root.remove(); if (opener?.isConnected) opener.focus?.(); }, refresh: place };
}
