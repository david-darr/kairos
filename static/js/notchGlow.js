// The notch's state glows (Kairos Notch build spec, 4a "Palette and glows"):
// an ordered-dither dot field (dither.js BAYER4) in the state's colour,
// rising from the bottom of a card or sitting as a halo behind Kip. Each is
// drawn once per state change into one of two fixed canvases, and a change
// cross-fades the two with a CSS opacity transition: no frame loop, no
// filter. The colours are the notch's own tokens (usage-overlay.css).
import { BAYER4 } from './dither.js';

// tone -> [the colour at the glow's root, the colour it fades toward]
const TONES = {
  gold: ['--n-watch', '--n-watch'],
  ember: ['--n-crit', '--n-crit'],
  sage: ['--n-ample', '--n-ample'],
  recover: ['--n-rose', '--n-lilac'],
};
export const GLOW_TONES = Object.keys(TONES);

// How strongly a cell shows, 0..1: rising from the bottom edge (a card) or
// around the centre (a halo). Pure, so scripts/test_notch_panels.cjs runs it.
export function glowLevel(shape, x, y, width, height) {
  if (shape === 'halo') {
    const d = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2));
    return Math.max(0, 1 - d) ** 1.4;
  }
  const d = Math.hypot((x - width / 2) / (width * .6), (height - y) / (height * .5));
  return Math.max(0, 1 - d) ** 1.8;
}

export function createGlow(host, { shape = 'bottom', cell = 5 } = {}) {
  const layers = [0, 1].map(() => {
    const canvas = document.createElement('canvas');
    canvas.className = 'n-glow-layer';
    canvas.setAttribute('aria-hidden', 'true');
    host.prepend(canvas);
    return canvas;
  });
  let front = 0, drawn = '';
  function paint(canvas, tone) {
    const width = host.clientWidth, height = host.clientHeight;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!TONES[tone] || !width || !height) return;
    const style = getComputedStyle(host);
    const [root, far] = TONES[tone].map(name => style.getPropertyValue(name).trim());
    const size = cell * scale, columns = Math.ceil(canvas.width / size), rows = Math.ceil(canvas.height / size);
    ctx.globalAlpha = .6;  // a glow under the words, never over them
    for (let j = 0; j < rows; j++) for (let i = 0; i < columns; i++) {
      const x = (i + .5) * size, y = (j + .5) * size;
      const level = glowLevel(shape, x, y, canvas.width, canvas.height);
      const threshold = BAYER4[(i & 3) + (j & 3) * 4];
      if (level <= threshold * .9) continue;
      // Two colours (recovering) blend by a second pass of the same dither.
      ctx.fillStyle = root === far || (y / canvas.height) > threshold ? root : far;
      ctx.beginPath();
      ctx.arc(x, y, size * (.14 + .2 * level), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return {
    // Draw the new state into the back canvas, then cross-fade to it.
    set(tone) {
      const key = `${tone}|${host.clientWidth}x${host.clientHeight}`;
      if (key === drawn) return;
      drawn = key;
      const back = 1 - front;
      paint(layers[back], tone);
      layers[back].classList.add('on');
      layers[front].classList.remove('on');
      front = back;
      host.dataset.glow = tone || '';
    },
  };
}
