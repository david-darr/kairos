// One owner per decorative surface. The original dither painter is unchanged.
import { drawDither, loadDitherImage } from './dither.js';
import { getAppearance, halftonePalette } from './appearance.js';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const owners = new Set();
let mutations;
const wakeAll = () => { for (const owner of [...owners]) owner.wake(); };
function subscribe(owner) {
  if (!owners.size) {
    mutations = new MutationObserver(wakeAll);
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'data-view', 'data-halftone', 'open'] });
    document.addEventListener('visibilitychange', wakeAll);
    reduce.addEventListener('change', wakeAll);
  }
  owners.add(owner);
}
function unsubscribe(owner) {
  owners.delete(owner);
  if (!owners.size) {
    mutations.disconnect();
    document.removeEventListener('visibilitychange', wakeAll);
    reduce.removeEventListener('change', wakeAll);
  }
}
export function backgroundEffectKey() {
  const a = getAppearance();
  return JSON.stringify([a.backgroundEffect, a.effectOptions, a.mode, a.halftone, a.artBase]);
}
const clamp = x => Math.max(0, Math.min(1, x));
function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function theme() {
  const style = getComputedStyle(document.documentElement);
  return { ink: style.getPropertyValue('--accent').trim(), base: style.getPropertyValue('--bg').trim() };
}
function sample(img, W, H, c, opts) {
  const cols = Math.ceil(W / c), rows = Math.ceil(H / c);
  const small = canvas(cols, rows), ctx = small.getContext('2d', { willReadFrequently: true });
  const scale = Math.max(cols / img.naturalWidth, rows / img.naturalHeight);
  const sw = cols / scale, sh = rows / scale;
  ctx.drawImage(img, (img.naturalWidth - sw) * (opts.focusX ?? .5),
    (img.naturalHeight - sh) * (opts.focusY ?? .5), sw, sh, 0, 0, cols, rows);
  const pixels = ctx.getImageData(0, 0, cols, rows).data;
  const lum = new Float32Array(cols * rows), colors = new Array(lum.length);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (.2126 * pixels[i * 4] + .7152 * pixels[i * 4 + 1] + .0722 * pixels[i * 4 + 2]) / 255;
    // 64 picture inks bound atlas memory while retaining the picture's colours.
    colors[i] = `rgb(${[0, 1, 2].map(k => Math.round(pixels[i * 4 + k] / 85) * 85).join(',')})`;
  }
  return { cols, rows, lum, colors };
}
function picturePainter(target, img, W, H, opts, effect, prefs, colors) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let c = Math.max(2, Math.round(prefs.density * dpr));
  while (Math.ceil(W / c) * Math.ceil(H / c) > 20000) c++;
  const grid = sample(img, W, H, c, opts), ctx = target.getContext('2d');
  if (effect !== 'halftone') {
    // Stretch luminance to the picture's own 3rd..97th percentile so pale scenes still read as a picture.
    const sorted = Float32Array.from(grid.lum).sort(), lo = sorted[Math.floor(sorted.length * .03)], hi = sorted[Math.floor(sorted.length * .97)];
    if (hi - lo > .05) for (let i = 0; i < grid.lum.length; i++) grid.lum[i] = clamp((grid.lum[i] - lo) / (hi - lo));
  }
  target.width = W; target.height = H;
  target.dataset.cells = String(grid.lum.length);
  const ramp = effect === 'numbers' ? '0123456789' : effect === 'binary' ? '01' : ' .:-=+*#%@';
  const atlases = new Map();
  function atlas(ink) {
    if (atlases.has(ink)) return atlases.get(ink);
    const sheet = canvas(c * ramp.length, c), ac = sheet.getContext('2d');
    ac.font = `${c}px Consolas, monospace`; ac.textAlign = 'center'; ac.textBaseline = 'middle'; ac.fillStyle = ink;
    for (let i = 0; i < ramp.length; i++) ac.fillText(ramp[i], (i + .5) * c, c * .5, c);
    atlases.set(ink, sheet); return sheet;
  }
  // All atlases are built before animation. Frames only blit cached glyphs.
  if (effect !== 'halftone') for (const ink of prefs.tint === 'picture' ? new Set(grid.colors) : [colors.ink]) atlas(ink);
  const angle = Math.PI / 6, co = Math.cos(angle), si = Math.sin(angle);
  return t => {
    ctx.globalAlpha = 1; ctx.fillStyle = colors.base; ctx.fillRect(0, 0, W, H);
    const drift = prefs.motion && !reduce.matches ? t : 0;
    const drawCell = (x, y, i, X, Y) => {
      const l = clamp(grid.lum[i] + Math.sin(y * .13 - drift * .55) * (drift ? .035 : 0));
      const ink = prefs.tint === 'picture' ? grid.colors[i] : colors.ink;
      const fade = opts.fade ? 1 - clamp((Y / H - opts.fade[0]) / (opts.fade[1] - opts.fade[0])) : 1;
      ctx.globalAlpha = effect === 'halftone' ? fade * .85 : fade;
      if (effect === 'halftone') {
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(X, Y, c * .49 * Math.sqrt(1 - l), 0, Math.PI * 2); ctx.fill();
      } else {
        let index = Math.min(ramp.length - 1, Math.floor((1 - l) * ramp.length));
        if (effect !== 'ascii') {
          index = (index + Math.floor(drift / 3 + (x * 7 + y * 13) % 17 / 17)) % ramp.length;
          ctx.globalAlpha *= .12 + (1 - l) * .88;
        }
        ctx.drawImage(atlases.get(ink), index * c, 0, c, c, X, Y, c, c);
      }
    };
    if (effect === 'halftone') {
      // Rotate positions, sample the scene at those positions, and clip to its box.
      const extent = Math.ceil(Math.hypot(W, H) / c / 2) + 1;
      for (let y = -extent; y <= extent; y++) for (let x = -extent; x <= extent; x++) {
        const X = W / 2 + (x * co - y * si) * c, Y = H / 2 + (x * si + y * co) * c;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const gx = Math.min(grid.cols - 1, Math.floor(X / c)), gy = Math.min(grid.rows - 1, Math.floor(Y / c));
        drawCell(gx, gy, gy * grid.cols + gx, X, Y);
      }
    } else for (let y = 0; y < grid.rows; y++) for (let x = 0; x < grid.cols; x++) drawCell(x, y, y * grid.cols + x, x * c, y * c);
    ctx.globalAlpha = 1;
  };
}
// Default preferences pass the same options to the unchanged legacy painter.
export function drawSceneDither(target, img, W, H, opts = {}) {
  const a = getAppearance(), prefs = a.effectOptions.dithered;
  let palette = opts.palette ?? halftonePalette();
  if (prefs.tint === 'picture') palette = null;
  if (prefs.tint === 'theme') {
    const colors = theme(), probe = canvas(1, 1).getContext('2d');
    palette = {};
    for (const key of ['ink', 'base']) {
      probe.fillStyle = colors[key]; probe.fillRect(0, 0, 1, 1);
      palette[key] = [...probe.getImageData(0, 0, 1, 1).data].slice(0, 3);
    }
  }
  return drawDither(target, img, W, H, { ...opts, cell: prefs.density, palette });
}

export function mountBackgroundEffect(el, src, opts = {}) {
  const target = canvas(1, 1); target.className = 'dither-canvas background-effect-canvas';
  target.setAttribute('aria-hidden', 'true'); target.style.pointerEvents = 'none';
  el.prepend(target);
  let disposed = false, connected = el.isConnected, inView = true, raf = 0, timer = 0;
  let revision = 0, dirty = true, building = false, painter = null, moving = false, time = 0, last = 0, accumulator = 0;
  let wasReduced = reduce.matches;
  let pendingReady = opts.onReady;
  const settle = () => { const fn = pendingReady; pendingReady = null; fn?.(); };
  const visible = () => !document.hidden && el.isConnected && inView && el.clientWidth > 0 && el.clientHeight > 0 &&
    (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) &&
    (opts.preview || opts.backdrop || document.documentElement.dataset.halftone === 'on');
  function stop() { cancelAnimationFrame(raf); raf = 0; last = 0; accumulator = 0; }
  function frame(now) {
    raf = 0;
    if (!visible()) { stop(); return; }
    if (last) accumulator += Math.min(100, now - last);
    last = now;
    if (accumulator >= 50) { time += (accumulator - accumulator % 50) / 1000; accumulator %= 50; painter?.(time); }
    if (moving && !reduce.matches) raf = requestAnimationFrame(frame);
  }
  async function build() {
    if (building || !dirty || !visible()) return;
    building = true; dirty = false; const token = ++revision;
    const a = getAppearance(), effect = opts.effect || a.backgroundEffect;
    const prefs = a.effectOptions[effect], colors = theme();
    const dpr = window.devicePixelRatio || 1;
    // Dither uses the exact original device-pixel dimensions and painter.
    const scale = effect === 'dithered' ? dpr : Math.min(dpr, 2, 2560 / Math.max(el.clientWidth, el.clientHeight));
    const W = Math.max(1, Math.round(el.clientWidth * scale)), H = Math.max(1, Math.round(el.clientHeight * scale));
    try {
      // Animated art is drawn by ASCII Magic's own player (artPlayer.js), not here.
      const img = await loadDitherImage(src, opts.version || 0);
      if (disposed || token !== revision || !visible()) { dirty = true; return; }
      const next = effect === 'dithered' ? () => drawSceneDither(target, img, W, H, opts) : picturePainter(target, img, W, H, opts, effect, prefs, colors);
      if (disposed || token !== revision || !visible()) { dirty = true; return; }
      painter = next; moving = prefs.motion && !['dithered', 'halftone'].includes(effect); wasReduced = reduce.matches;
      const started = performance.now(); painter(0); el.dataset.drawMs = String(Math.round(performance.now() - started));
      el.classList.add('is-dithered'); target.dataset.effect = effect; settle();
    } catch { settle(); /* Existing picture or parchment remains if decoding fails. */ }
    finally { building = false; if (!disposed) wake(); }
  }
  function wake() {
    if (disposed) return;
    if (el.isConnected) connected = true;
    else if (connected) { dispose(); return; }
    if (!visible()) { stop(); settle(); return; }
    if (building) return;
    if (dirty) { stop(); build(); return; }
    if (reduce.matches !== wasReduced) { wasReduced = reduce.matches; if (wasReduced) { stop(); painter?.(0); } }
    if (moving && !reduce.matches && painter && !raf) raf = requestAnimationFrame(frame);

  }
  const owner = { wake };
  function invalidate() { dirty = true; ++revision; wake(); }
  let seenWidth = el.clientWidth, seenHeight = el.clientHeight;
  const observer = new ResizeObserver(() => {
    if (seenWidth === el.clientWidth && seenHeight === el.clientHeight) return;
    seenWidth = el.clientWidth; seenHeight = el.clientHeight;
    clearTimeout(timer); timer = setTimeout(invalidate, 150);
  });
  const intersection = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; wake(); });
  function dispose() {
    if (disposed) return; disposed = true; ++revision; stop(); clearTimeout(timer);
    observer.disconnect(); intersection.disconnect(); unsubscribe(owner);
    document.removeEventListener('kairos:appearance', invalidate); window.removeEventListener('resize', resize);
    target.remove(); el.classList.remove('is-dithered'); settle();
  }
  function resize() { clearTimeout(timer); timer = setTimeout(invalidate, 150); }
  observer.observe(el); intersection.observe(el); subscribe(owner);
  document.addEventListener('kairos:appearance', invalidate); window.addEventListener('resize', resize);
  wake(); return dispose;
}
