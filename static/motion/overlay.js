// Overlay clips (Content Studio Editor build spec, step 3): text, image and shape clips on the video's overlay tracks,
// drawn over the beats in track order and under the captions, inside the engine's synchronous drawFrame(t). The beats
// stay the main picture; a video without tracks draws exactly as before. Deterministic: a clip's look at time t
// depends only on its data and t. core/video_tracks.py checks the same data on the server.
import { clamp, card } from './kit.js';
import { fitText, assetName } from './layout.js';

export const COLORS = ['text', 'dim', 'accent', 'accent-2', 'bg', 'surface', 'white', 'black'];
const finite = (v, d = 0) => Number.isFinite(v) ? v : d;
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
function box(b) {
  const x = clamp(finite(b?.x, .1)), y = clamp(finite(b?.y, .1));
  return { x, y, w: clamp(finite(b?.w, .3), .01, 1 - x || .01), h: clamp(finite(b?.h, .1), .01, 1 - y || .01) };
}

// The visible overlay clips, in drawing order (lower tracks first; within a track by start).
export function normalizeTracks(input) {
  const out = [];
  (Array.isArray(input) ? input : []).slice(0, 8).forEach((track, layer) => {
    if (!track || track.kind !== 'overlay' || track.hidden === true || !Array.isArray(track.clips)) return;
    for (const c of track.clips.slice(0, 60)) {
      if (!c || !['text', 'image', 'shape'].includes(c.kind)) continue;
      const start = Math.max(0, finite(c.start)), inPoint = Math.max(0, finite(c.in)), out_ = Math.max(inPoint, finite(c.out, inPoint));
      if (out_ - inPoint <= 0) continue;
      out.push({ id: str(c.id, 48), track: str(track.id, 48), layer, kind: c.kind, start, end: start + out_ - inPoint, in: inPoint,
        opacity: clamp(finite(c.opacity, 1)), fadeIn: Math.max(0, finite(c.fade_in)), fadeOut: Math.max(0, finite(c.fade_out)), box: box(c.box),
        text: str(c.text, 140), role: c.role === 'body' ? 'body' : 'title', style: c.style === 'plain' ? 'plain' : 'card',
        color: COLORS.includes(c.color) ? c.color : (c.kind === 'shape' ? 'accent' : 'text'), align: ['left', 'right'].includes(c.align) ? c.align : 'center',
        image: assetName(c.image), fit: c.fit === 'cover' ? 'cover' : 'contain', shape: ['ellipse', 'line', 'arrow'].includes(c.shape) ? c.shape : 'rect',
        fill: c.fill !== false, stroke: clamp(finite(c.stroke, .006), .001, .05) });
    }
  });
  return out.sort((a, b) => a.layer - b.layer || a.start - b.start);
}

// How much of a clip shows at time t: 0 outside it, else its opacity times the fades (linear, as the sound fades).
export function alphaAt(clip, t) {
  if (!(t >= clip.start && t < clip.end)) return 0;
  const local = t - clip.start, length = clip.end - clip.start;
  let k = 1;
  if (clip.fadeIn > 0) k = Math.min(k, local / clip.fadeIn);
  if (clip.fadeOut > 0) k = Math.min(k, (length - local) / clip.fadeOut);
  return clamp(k) * clip.opacity;
}

export function colorOf(name, style) {
  return { text: style.text, dim: style.dim, accent: style.accent, 'accent-2': style.second, bg: style.bg, surface: style.surface,
    white: 'rgb(255 255 255)', black: 'rgb(0 0 0)' }[name] || style.text;
}

// A text clip's frame box, its fitted lines and its colours (the card's colour when it sits on one).
export function textLayout(clip, w, h, measure, style) {
  const b = { x: clip.box.x * w, y: clip.box.y * h, w: clip.box.w * w, h: clip.box.h * h };
  const pad = clip.style === 'card' ? Math.min(b.h * .18, Math.min(w, h) * .022) : 0;
  const inner = { x: b.x + pad, y: b.y + pad, w: Math.max(1, b.w - pad * 2), h: Math.max(1, b.h - pad * 2) };
  const min = Math.round(Math.min(w, h) * (clip.role === 'body' ? .022 : .028));
  const fit = fitText(clip.text, inner, { min, max: Math.max(min, Math.min(inner.h, Math.min(w, h) * .2)), measure: (v, size) => measure(v, size, clip.role) });
  return { box: b, inner, fit, color: colorOf(clip.color, style), bg: clip.style === 'card' ? style.bg : null };
}

// Draw one clip. env: { w, h, style, measure, font, images }.
export function drawOverlay(g, clip, alpha, env) {
  if (alpha <= 0) return;
  const { w, h, style } = env;
  g.save(); g.globalAlpha = alpha;
  if (clip.kind === 'text') {
    const t = textLayout(clip, w, h, env.measure, style);
    if (t.bg) card(g, t.box.x, t.box.y, t.box.w, t.box.h, t.bg, Math.min(style.radius, 24), 'rgba(0, 0, 0, .18)');
    g.fillStyle = t.color; g.font = env.font(style, t.fit.size, clip.role); g.textBaseline = 'alphabetic'; g.textAlign = clip.align;
    const x = clip.align === 'left' ? t.inner.x : clip.align === 'right' ? t.inner.x + t.inner.w : t.inner.x + t.inner.w / 2;
    const top = t.inner.y + (t.inner.h - t.fit.lines.length * t.fit.lineHeight) / 2;
    t.fit.lines.forEach((line, row) => g.fillText(line, x, top + row * t.fit.lineHeight + t.fit.size * .88));
  } else if (clip.kind === 'image') {
    const img = env.images.get(clip.image), b = { x: clip.box.x * w, y: clip.box.y * h, w: clip.box.w * w, h: clip.box.h * h };
    if (img) {
      const scale = (clip.fit === 'cover' ? Math.max : Math.min)(b.w / img.naturalWidth, b.h / img.naturalHeight);
      const iw = img.naturalWidth * scale, ih = img.naturalHeight * scale;
      g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
      g.drawImage(img, b.x + (b.w - iw) / 2, b.y + (b.h - ih) / 2, iw, ih);
    }
  } else {
    const b = { x: clip.box.x * w, y: clip.box.y * h, w: clip.box.w * w, h: clip.box.h * h }, color = colorOf(clip.color, style);
    const line = Math.max(1, clip.stroke * Math.min(w, h));
    g.fillStyle = color; g.strokeStyle = color; g.lineWidth = line; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    if (clip.shape === 'rect') g.roundRect(b.x + (clip.fill ? 0 : line / 2), b.y + (clip.fill ? 0 : line / 2), b.w - (clip.fill ? 0 : line), b.h - (clip.fill ? 0 : line), Math.min(style.radius, b.w / 2, b.h / 2));
    else if (clip.shape === 'ellipse') g.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(.5, b.w / 2 - (clip.fill ? 0 : line / 2)), Math.max(.5, b.h / 2 - (clip.fill ? 0 : line / 2)), 0, 0, Math.PI * 2);
    else {
      const x0 = b.x + line, y0 = b.y + line, x1 = b.x + b.w - line, y1 = b.y + b.h - line;
      g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      if (clip.shape === 'arrow') {
        const a = Math.atan2(y1 - y0, x1 - x0), head = Math.max(line * 3, Math.min(w, h) * .02);
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - head * Math.cos(a - .5), y1 - head * Math.sin(a - .5));
        g.lineTo(x1 - head * Math.cos(a + .5), y1 - head * Math.sin(a + .5)); g.closePath(); g.fill();
      }
      g.restore(); return;
    }
    if (clip.fill) g.fill(); else g.stroke();
  }
  g.restore();
}

// What a clip puts on screen at time t, in frame pixels, for the render checks and the editor (the agent's pins).
export function overlayBoxes(clips, t, w, h, measure, style) {
  const out = [];
  for (const clip of clips) {
    const alpha = alphaAt(clip, t);
    if (alpha <= 0) continue;
    const base = { clip: clip.id, track: clip.track, overlay: clip.kind, alpha };
    if (clip.kind === 'text') {
      const l = textLayout(clip, w, h, measure, style);
      out.push({ ...base, kind: 'text', role: 'overlay', text: l.fit.text, fontSize: l.fit.size, x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h,
        color: l.color, bg: l.bg, truncated: l.fit.truncated });
    } else out.push({ ...base, kind: 'clip', x: clip.box.x * w, y: clip.box.y * h, w: clip.box.w * w, h: clip.box.h * h });
  }
  return out;
}
