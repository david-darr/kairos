// Overlay clips (Content Studio Editor build spec, steps 3, 5 and 7): text, image, shape and video clips on the video's
// overlay tracks, drawn over the beats in track order and under the captions, inside the engine's synchronous
// drawFrame(t). The beats stay the main picture; a video without tracks draws exactly as before. Deterministic: a
// clip's look at time t depends only on its data and t. core/video_tracks.py checks the same data on the server.
//
// Step 5 adds keyframes, our own tween model (no animation library): a clip's `keys` hold, per property (x, y, scale,
// rotation, opacity), a list of {t, v, ease}. `t` is in the clip's own time (the same clock as `in` and `out`), so a
// trim or a split never moves a keyframe against the clip's content. Between two keys the value follows the first key's
// ease; before the first key and after the last the value holds. A property without keys keeps its plain value (the
// box's x and y, `scale` 1, `rotation` 0, `opacity`). Scale and rotation turn the clip around its box's centre.
// Step 7 adds video clips: the person's own file, decoded by FFmpeg at upload into numbered frames at 30 a second
// (core/video_media.py); frame n of the file shows from n / 30 to (n + 1) / 30 of its own time.
import { clamp, card } from './kit.js';
import { fitText, assetName } from './layout.js';

export const COLORS = ['text', 'dim', 'accent', 'accent-2', 'bg', 'surface', 'white', 'black'];
export const KEY_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'];
export const EASES = ['linear', 'in', 'out', 'in-out', 'back', 'hold'];
export const KEY_RANGES = { x: [-1, 2], y: [-1, 2], scale: [.05, 10], rotation: [-3600, 3600], opacity: [0, 1] };
export const MEDIA_FPS = 30;
const VISUAL = ['text', 'image', 'shape', 'video'];
const finite = (v, d = 0) => Number.isFinite(v) ? v : d;
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
function box(b) {
  const x = clamp(finite(b?.x, .1)), y = clamp(finite(b?.y, .1));
  return { x, y, w: clamp(finite(b?.w, .3), .01, 1 - x || .01), h: clamp(finite(b?.h, .1), .01, 1 - y || .01) };
}
export const mediaName = v => typeof v === 'string' && /^media\/[a-f0-9]{64}$/.test(v) ? v.slice(6) : '';

// The keys of one property, checked and sorted by time (at most 60).
function keyList(list, prop) {
  if (!Array.isArray(list)) return null;
  const [lo, hi] = KEY_RANGES[prop];
  const out = list.slice(0, 60).filter(k => k && Number.isFinite(k.t) && Number.isFinite(k.v))
    .map(k => ({ t: Math.max(0, k.t), v: clamp(k.v, lo, hi), ease: EASES.includes(k.ease) ? k.ease : 'linear' }))
    .sort((a, b) => a.t - b.t);
  return out.length ? out : null;
}
export function normalizeKeys(keys) {
  const out = {};
  if (!keys || typeof keys !== 'object') return out;
  for (const prop of KEY_PROPS) { const list = keyList(keys[prop], prop); if (list) out[prop] = list; }
  return out;
}

// The eases, as plain curves from 0 to 1 (`back` overshoots a little before it settles; `hold` jumps at the next key).
export function ease(name, p) {
  p = clamp(p);
  switch (name) {
    case 'in': return p * p * p;
    case 'out': return 1 - Math.pow(1 - p, 3);
    case 'in-out': return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case 'back': { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); }
    case 'hold': return p >= 1 ? 1 : 0;
    default: return p;
  }
}
// A property's value at the clip's own time s from its sorted keys.
export function valueAt(list, s) {
  if (s <= list[0].t) return list[0].v;
  const last = list.at(-1);
  if (s >= last.t) return last.v;
  let i = 0;
  while (i < list.length - 2 && s >= list[i + 1].t) i++;
  const a = list[i], b = list[i + 1], span = b.t - a.t;
  return span <= 0 ? b.v : a.v + (b.v - a.v) * ease(a.ease, (s - a.t) / span);
}

// The visible overlay clips, in drawing order (lower tracks first; within a track by start).
export function normalizeTracks(input, media = {}) {
  const out = [];
  (Array.isArray(input) ? input : []).slice(0, 8).forEach((track, layer) => {
    if (!track || track.kind !== 'overlay' || track.hidden === true || !Array.isArray(track.clips)) return;
    for (const c of track.clips.slice(0, 60)) {
      if (!c || !VISUAL.includes(c.kind)) continue;
      const start = Math.max(0, finite(c.start)), inPoint = Math.max(0, finite(c.in)), out_ = Math.max(inPoint, finite(c.out, inPoint));
      if (out_ - inPoint <= 0) continue;
      const video = c.kind === 'video' ? mediaName(c.video) : '';
      out.push({ id: str(c.id, 48), track: str(track.id, 48), layer, kind: c.kind, start, end: start + out_ - inPoint, in: inPoint,
        opacity: clamp(finite(c.opacity, 1)), fadeIn: Math.max(0, finite(c.fade_in)), fadeOut: Math.max(0, finite(c.fade_out)), box: box(c.box),
        scale: clamp(finite(c.scale, 1), .05, 10), rotation: clamp(finite(c.rotation, 0), -3600, 3600), keys: normalizeKeys(c.keys),
        text: str(c.text, 140), role: c.role === 'body' ? 'body' : 'title', style: c.style === 'plain' ? 'plain' : 'card',
        color: COLORS.includes(c.color) ? c.color : (c.kind === 'shape' ? 'accent' : 'text'), align: ['left', 'right'].includes(c.align) ? c.align : 'center',
        image: assetName(c.image), fit: c.fit === 'cover' ? 'cover' : 'contain', shape: ['ellipse', 'line', 'arrow'].includes(c.shape) ? c.shape : 'rect',
        fill: c.fill !== false, stroke: clamp(finite(c.stroke, .006), .001, .05),
        video, frames: video ? Math.max(1, Math.floor(finite(media?.[video]?.frames, 1))) : 0 });
    }
  });
  return out.sort((a, b) => a.layer - b.layer || a.start - b.start);
}

// A clip's state at timeline time t: its box (x and y keyed or plain), scale, rotation and alpha (opacity keyed or
// plain, times the fades). Alpha 0 outside the clip.
export function stateAt(clip, t) {
  const s = clip.in + (t - clip.start), k = clip.keys || {};
  const x = k.x ? valueAt(k.x, s) : clip.box.x, y = k.y ? valueAt(k.y, s) : clip.box.y;
  const scale = k.scale ? valueAt(k.scale, s) : clip.scale ?? 1, rotation = k.rotation ? valueAt(k.rotation, s) : clip.rotation ?? 0;
  const opacity = k.opacity ? valueAt(k.opacity, s) : clip.opacity;
  return { x, y, w: clip.box.w, h: clip.box.h, scale, rotation, opacity, alpha: alphaAt(clip, t, opacity) };
}
// How much of a clip shows at time t: 0 outside it, else its opacity times the fades (linear, as the sound fades).
export function alphaAt(clip, t, opacity = clip.opacity) {
  if (!(t >= clip.start && t < clip.end)) return 0;
  const local = t - clip.start, length = clip.end - clip.start;
  let k = 1;
  if (clip.fadeIn > 0) k = Math.min(k, local / clip.fadeIn);
  if (clip.fadeOut > 0) k = Math.min(k, (length - local) / clip.fadeOut);
  return clamp(k) * clamp(opacity);
}
// The video frame a clip shows at timeline time t: a whole-number lookup, never a seek.
export function frameIndex(clip, t) {
  return clamp(Math.floor((clip.in + (t - clip.start)) * MEDIA_FPS + 1e-6), 0, Math.max(0, clip.frames - 1));
}

export function colorOf(name, style) {
  return { text: style.text, dim: style.dim, accent: style.accent, 'accent-2': style.second, bg: style.bg, surface: style.surface,
    white: 'rgb(255 255 255)', black: 'rgb(0 0 0)' }[name] || style.text;
}

// A text clip's frame box, its fitted lines and its colours (the card's colour when it sits on one). The fit uses the
// box's size only, so moving, turning or scaling a clip never re-wraps its text.
const fits = new Map();
export function textLayout(clip, w, h, measure, style, at = clip.box) {
  const b = { x: at.x * w, y: at.y * h, w: clip.box.w * w, h: clip.box.h * h };
  const pad = clip.style === 'card' ? Math.min(b.h * .18, Math.min(w, h) * .022) : 0;
  const inner = { x: b.x + pad, y: b.y + pad, w: Math.max(1, b.w - pad * 2), h: Math.max(1, b.h - pad * 2) };
  const min = Math.round(Math.min(w, h) * (clip.role === 'body' ? .022 : .028));
  const key = `${clip.text}|${clip.role}|${inner.w.toFixed(2)}|${inner.h.toFixed(2)}|${min}`;
  if (!fits.has(key)) { if (fits.size > 400) fits.clear(); fits.set(key, fitText(clip.text, inner, { min, max: Math.max(min, Math.min(inner.h, Math.min(w, h) * .2)), measure: (v, size) => measure(v, size, clip.role) })); }
  return { box: b, inner, fit: fits.get(key), color: colorOf(clip.color, style), bg: clip.style === 'card' ? style.bg : null };
}

// The four corners of a clip's box at its state, in frame pixels (scaled and turned around the box's centre).
export function corners(st, w, h) {
  const cx = (st.x + st.w / 2) * w, cy = (st.y + st.h / 2) * h, hw = st.w * w / 2 * st.scale, hh = st.h * h / 2 * st.scale;
  const a = st.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

// Draw one clip. env: { w, h, style, measure, font, images, frame(clip, t) }.
export function drawOverlay(g, clip, st, env, t) {
  if (st.alpha <= 0) return;
  const { w, h, style } = env;
  const b = { x: st.x * w, y: st.y * h, w: clip.box.w * w, h: clip.box.h * h };
  g.save(); g.globalAlpha = st.alpha;
  if (st.rotation || st.scale !== 1) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    g.translate(cx, cy); g.rotate(st.rotation * Math.PI / 180); g.scale(st.scale, st.scale); g.translate(-cx, -cy);
  }
  if (clip.kind === 'text') {
    const l = textLayout(clip, w, h, env.measure, style, st);
    if (l.bg) card(g, l.box.x, l.box.y, l.box.w, l.box.h, l.bg, Math.min(style.radius, 24), 'rgba(0, 0, 0, .18)');
    g.fillStyle = l.color; g.font = env.font(style, l.fit.size, clip.role); g.textBaseline = 'alphabetic'; g.textAlign = clip.align;
    const x = clip.align === 'left' ? l.inner.x : clip.align === 'right' ? l.inner.x + l.inner.w : l.inner.x + l.inner.w / 2;
    const top = l.inner.y + (l.inner.h - l.fit.lines.length * l.fit.lineHeight) / 2;
    l.fit.lines.forEach((line, row) => g.fillText(line, x, top + row * l.fit.lineHeight + l.fit.size * .88));
  } else if (clip.kind === 'image' || clip.kind === 'video') {
    const img = clip.kind === 'image' ? env.images.get(clip.image) : env.frame?.(clip, t);
    const nw = img?.naturalWidth || img?.width, nh = img?.naturalHeight || img?.height;
    if (img && nw && nh) {
      const scale = (clip.fit === 'cover' ? Math.max : Math.min)(b.w / nw, b.h / nh);
      const iw = nw * scale, ih = nh * scale;
      g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip();
      g.drawImage(img, b.x + (b.w - iw) / 2, b.y + (b.h - ih) / 2, iw, ih);
    }
  } else {
    const color = colorOf(clip.color, style), line = Math.max(1, clip.stroke * Math.min(w, h));
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

// What a clip puts on screen at time t, in frame pixels, for the render checks and the editor (the agent's pins, the
// canvas handles). x, y, w, h bound the clip as drawn (turned and scaled); `frame` is its unturned box at its place.
export function overlayBoxes(clips, t, w, h, measure, style) {
  const out = [];
  for (const clip of clips) {
    const st = stateAt(clip, t);
    if (st.alpha <= 0) continue;
    const pts = corners(st, w, h), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const bound = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const base = { clip: clip.id, track: clip.track, overlay: clip.kind, alpha: st.alpha, scale: st.scale, rotation: st.rotation,
      frame: { x: st.x * w, y: st.y * h, w: clip.box.w * w, h: clip.box.h * h }, animated: Object.keys(clip.keys || {}).length > 0 };
    if (clip.kind === 'text') {
      const l = textLayout(clip, w, h, measure, style, st);
      out.push({ ...base, kind: 'text', role: 'overlay', text: l.fit.text, fontSize: l.fit.size * st.scale, ...bound, color: l.color, bg: l.bg, truncated: l.fit.truncated });
    } else out.push({ ...base, kind: 'clip', ...bound, ...(clip.kind === 'video' ? { videoFrame: frameIndex(clip, t) } : {}) });
  }
  return out;
}
