// Phone-only primitives. Later dock, composer and picker work can share these.
export const phone = matchMedia('(max-width: 768px)');
export const reduced = matchMedia('(prefers-reduced-motion: reduce)');
export const mobileOn = () => phone.matches && document.documentElement.classList.contains('kairos-redesign');
export const go = (tab, options = {}) => document.dispatchEvent(new CustomEvent('jarvis:navigate', { detail: { tab, ...options } }));
export function haptic() { if (!reduced.matches) { try { navigator.vibrate?.(8); } catch { /* Optional capability. */ } } }
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
