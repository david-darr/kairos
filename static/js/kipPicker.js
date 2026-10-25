// The Kip style control (David, 2026-10-25): four little previews (flat,
// halftone, pixel, hidden) that apply as soon as one is chosen. It is the
// same control in Appearance, in a popover on desktop Home and in the shared
// sheet on phones. The choice is the appearance `kip` setting (appearance.js,
// kipStyle.js); hidden is the old Show Kip off.
import { el } from './api.js';
import { createMascot } from './mascot.js';
import { getAppearance, updateAppearance } from './appearance.js';
import { KIP_STYLES, KIP_STYLE_NAMES, DEFAULT_KIP_STYLE } from './kipStyle.js';
import { openMobileSheet } from './mobileSheet.js';
import { mobileOn } from './mobileShared.js';

let lastShown = DEFAULT_KIP_STYLE;  // what Show Kip brings back this session
export const kipStyle = () => getAppearance().kip;
export function setKipStyle(style) {
  if (!KIP_STYLES.includes(style)) return;
  if (style !== 'hidden') lastShown = style;
  updateAppearance({ kip: style });
}
export function showKip() { setKipStyle(kipStyle() === 'hidden' ? lastShown : kipStyle()); }

// The four choices as a radio group. Arrow keys move through them.
export function kipChoices({ size = 52, onPick = () => {} } = {}) {
  const group = el('div', { class: 'kip-choices', role: 'radiogroup', 'aria-label': 'Kip style' });
  const buttons = new Map();
  for (const style of KIP_STYLES) {
    const preview = style === 'hidden'
      ? el('span', { class: 'kip-choice-art kip-choice-hidden', 'aria-hidden': 'true' })
      : el('span', { class: 'kip-choice-art', 'aria-hidden': 'true' }, [createMascot({ state: 'idle', size, finish: style, decorative: true })]);
    if (style !== 'hidden') { const kip = preview.firstChild; kip.setAttribute('still', ''); kip.setAttribute('data-preview', ''); }
    const button = el('button', { type: 'button', class: 'kip-choice', role: 'radio', 'data-kip-style': style, onclick: () => { setKipStyle(style); sync(); onPick(style); } },
      [preview, el('span', { class: 'kip-choice-name', text: KIP_STYLE_NAMES[style] })]);
    buttons.set(style, button); group.append(button);
  }
  function sync() {
    const current = kipStyle();
    for (const [style, button] of buttons) { button.setAttribute('aria-checked', String(style === current)); button.tabIndex = style === current ? 0 : -1; }
  }
  group.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = KIP_STYLES[(KIP_STYLES.indexOf(kipStyle()) + step + KIP_STYLES.length) % KIP_STYLES.length];
    buttons.get(next).click(); buttons.get(next).focus();
  });
  sync();
  return { node: group, sync };
}

// A compact popover on desktop, the shared sheet on phones. `needs` adds the
// way to Agents the hero Kip had when it needed you.
let closePopover = null;
export function openKipMenu(opener, { needs } = {}) {
  closePopover?.();
  const choices = kipChoices({ size: mobileOn() ? 64 : 48 });
  const body = el('div', { class: 'kip-menu-body' }, [choices.node]);
  const finish = () => sheet ? sheet.close() : closePopover?.();
  if (needs) body.append(el('button', { type: 'button', class: 'kip-menu-needs', text: 'Kip needs you. Open Agents', onclick: () => { finish(); needs(); } }));
  let sheet = null;
  if (mobileOn()) {
    sheet = openMobileSheet({ title: 'Kip', content: body, opener });
    if (sheet) { body.classList.add('kip-menu-sheet'); choices.node.querySelector('[aria-checked=true]')?.focus(); return; }
  }
  const pop = el('div', { class: 'kip-menu', role: 'dialog', 'aria-label': 'Kip style' }, [el('p', { class: 'kip-menu-title', text: 'Kip style' }), body]);
  document.body.append(pop);
  const place = () => {
    const box = opener.getBoundingClientRect(), width = pop.offsetWidth, height = pop.offsetHeight;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - width - 8, box.right - width))}px`;
    pop.style.top = `${box.bottom + 8 + height > innerHeight - 8 && box.top - 8 - height > 8 ? box.top - 8 - height : box.bottom + 8}px`;
  };
  place();
  opener.setAttribute('aria-expanded', 'true');
  const abort = new AbortController(), { signal } = abort;
  closePopover = () => {
    abort.abort(); pop.remove(); closePopover = null; opener.removeAttribute('aria-expanded');
    if (opener.isConnected) opener.focus();
  };
  document.addEventListener('pointerdown', event => { if (!pop.contains(event.target) && !opener.contains(event.target)) closePopover?.(); }, { signal });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closePopover?.(); } }, { signal, capture: true });
  window.addEventListener('resize', () => closePopover?.(), { signal });
  choices.node.querySelector('[aria-checked=true]')?.focus();
}

// Turns a button that holds a Kip into the switch: hidden, it reads Show Kip
// and brings him back; otherwise it opens the menu. Returns { sync, dispose }.
// `name` is Kip's current spoken state, a function; `needs` returns the way to
// Agents (or null) when the menu opens.
export function wireKipSwitch(button, { name = () => 'Kip', needs } = {}) {
  button.classList.add('kip-switch');
  const chip = el('span', { class: 'kip-show-chip', text: 'Show Kip' });
  button.append(chip);
  button.setAttribute('aria-haspopup', 'dialog');
  const sync = () => {
    const hidden = kipStyle() === 'hidden';
    button.setAttribute('aria-label', hidden ? 'Show Kip' : `${name()}. Change Kip style`);
  };
  button.addEventListener('click', () => { if (kipStyle() === 'hidden') showKip(); else openKipMenu(button, { needs: needs?.() }); });
  document.addEventListener('kairos:appearance', sync);
  sync();
  return { sync, dispose: () => { document.removeEventListener('kairos:appearance', sync); closePopover?.(); } };
}
