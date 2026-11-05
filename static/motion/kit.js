// Canvas primitives take their context explicitly. Importing this file needs no DOM.
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, p) => a + (b - a) * p;
export const range = (t, a, b) => b === a ? +(t >= b) : clamp((t - a) / (b - a));
export const expoOut = p => (p = clamp(p)) === 1 ? 1 : 1 - 2 ** (-10 * p);
export const inOut = p => (p = clamp(p)) < .5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
export const backOut = p => { p = clamp(p); if (p === 0 || p === 1) return p; p -= 1; return 1 + 2.70158 * p ** 3 + 1.70158 * p ** 2; };
export const pop = (t, at = 0, length = .4) => backOut(range(t, at, at + length));
export function hash(value) {
  let h = 2166136261;
  for (const c of String(value)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}
export function seededRandom(seed) {
  let s = typeof seed === 'number' ? seed >>> 0 : hash(seed);
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
export function zoomAbout(ctx, x, y, scale, draw) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.translate(-x, -y);
  draw(); ctx.restore();
}
export function scrim(ctx, w, h, color, alpha = .78) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); ctx.restore();
}
export function card(ctx, x, y, w, h, color, radius, shadowColor) {
  ctx.save(); ctx.shadowColor = shadowColor; ctx.shadowBlur = 32; ctx.shadowOffsetY = 12;
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, clamp(radius, 0, Math.min(w, h) / 2));
  ctx.fill(); ctx.restore();
}
export function windowReveal(ctx, p, box, draw) {
  const k = expoOut(p);
  if (!k) return;
  ctx.save(); ctx.beginPath();
  ctx.rect(box.x, box.y + box.h * (1 - k) / 2, box.w, box.h * k); ctx.clip(); draw(); ctx.restore();
}
export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// Mask rectangles are also usable as a clip path: no shared mutable mask canvas.
export function ditherMask(ctx, w, h, p, cell = 12) {
  ctx.beginPath();
  for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
    if (p >= 1 || (p > 0 && p > (BAYER[((y / cell) & 3) * 4 + ((x / cell) & 3)] + .5) / 16)) ctx.rect(x, y, cell, cell);
  }
}
export function drawDithered(ctx, source, p, w = source.width, h = source.height) {
  ctx.save(); ditherMask(ctx, w, h, p); ctx.clip(); ctx.drawImage(source, 0, 0, w, h); ctx.restore();
}
export function dotField(ctx, text, font, w, h, step = 7, seed = text) {
  ctx.clearRect(0, 0, w, h); ctx.font = font; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillStyle = 'rgb(255 255 255)'; ctx.fillText(text, w / 2, h / 2);
  const data = ctx.getImageData(0, 0, w, h).data, random = seededRandom(seed), points = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (data[(y * w + x) * 4 + 3] > 100) points.push({ x, y, sx: random() * w, sy: random() * h, delay: random() * .3 });
  }
  return points;
}
export function dotType(ctx, points, t, color, step = 7) {
  ctx.save(); ctx.fillStyle = color;
  for (const p of points) {
    const k = inOut(range(t, p.delay, p.delay + .6));
    ctx.beginPath(); ctx.arc(lerp(p.sx, p.x, k), lerp(p.sy, p.y, k), step * .44 * k, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
export const typedText = (text, t, step = .05) => Array.from(text).slice(0, Math.max(0, Math.floor(t / step))).join('');

// CSS colours are resolved to sRGB by the browser before these pure functions run.
export function rgb(color) {
  if (/^#[\da-f]{3}$/i.test(color)) return [...color.slice(1)].map(c => parseInt(c + c, 16));
  if (/^#[\da-f]{6}$/i.test(color)) return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const values = String(color).match(/[\d.]+/g);
  return values && values.length >= 3 ? values.slice(0, 3).map(Number) : [0, 0, 0];
}
export function luminance(color) {
  return rgb(color).map(v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
export function contrast(a, b) {
  const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export function readable(preferred, bg, palette) {
  if (contrast(preferred, bg) >= 4.5) return preferred;
  return [...palette].sort((a, b) => contrast(b, bg) - contrast(a, bg))[0] || preferred;
}
