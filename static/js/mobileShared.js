// Phone-only primitives. Later dock, composer and picker work can share these.
export const phone = matchMedia('(max-width: 768px)');
// The composer plus: one glyph for chat and Forge so the three controls centre identically.
export const PLUS_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
export const reduced = matchMedia('(prefers-reduced-motion: reduce)');
// The in-flow background layer of an iOS Safari tab (mobileChrome.js), or null everywhere else.
export const pageBleed = () => document.querySelector('body > .ms-page-bleed');
export const mobileOn = () => phone.matches && document.documentElement.classList.contains('kairos-redesign');
export const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
// Browsers refuse (and log an error for) vibration before the first tap, so it is gated on user activation.
export function haptic() { if (!reduced.matches && navigator.userActivation?.hasBeenActive !== false) { try { navigator.vibrate?.(8); } catch { /* Optional capability. */ } } }
export function button(label, action, className = 'ms-glass') {
  const node = document.createElement('button');
  node.type = 'button'; node.className = className; node.textContent = label;
  node.addEventListener('click', action);
  return node;
}
export function edgeBlur(edge) {
  const node = document.createElement('div'); node.className = `ms-blur ms-blur-${edge}`;
  node.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 6; i++) {
    const layer = document.createElement('i'); layer.style.setProperty('--step', i); node.append(layer);
  }
  return node;
}
// A long press must never also activate the underlying card.
export function longPress(node, action) {
  let timer, x, y, fired = false;
  const cancel = () => clearTimeout(timer);
  node.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    fired = false; x = e.clientX; y = e.clientY;
    timer = setTimeout(() => { fired = true; haptic(); action(); }, 500);
  });
  node.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(type, cancel);
  node.addEventListener('click', e => { if (fired) { e.preventDefault(); e.stopImmediatePropagation(); fired = false; } }, true);
  node.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); action(); });
  return cancel;
}
