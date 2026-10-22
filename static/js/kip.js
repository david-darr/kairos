// Kip in its pixel style (Kairos Mascot build spec, 2026-10-22; David named
// the mascot Kip, in flat, pixel and halftone styles): the character on a 24 by 24
// grid, used in the Agents village and in the terminal (the CLI reads the
// sheets this module builds, static/img/mascot/kip/). No DOM and no imports,
// so scripts/build_kip_assets.cjs and scripts/test_mascot.cjs load it from
// disk. Colours come in as a palette the caller resolved from the theme
// tokens; nothing here names a colour of its own.

export const KIP_GRID = 24;
export const KIP_MINI_GRID = 12;
// Frames per loop at 8 frames a second (sleeping runs at 4).
export const KIP_LOOPS = { idle: 32, thinking: 16, listening: 8, speaking: 8, success: 16, needs: 8, error: 16, sleeping: 12, walk: 4 };
export const KIP_FPS = { idle: 8, thinking: 8, listening: 8, speaking: 8, success: 8, needs: 8, error: 8, sleeping: 4, walk: 8 };
// A still frame that reads as the state (reduced motion, static sprites).
export const KIP_STILL = { idle: 0, thinking: 2, listening: 2, speaking: 2, success: 4, needs: 0, error: 0, sleeping: 6, walk: 0 };
// A fixed voice level per frame, so sheets are deterministic.
const LEVELS = [.2, .6, .9, .5, .3, .8, .4, .1];

// Colour helpers on '#rrggbb' strings or [r, g, b] arrays.
export function rgbOf(value) {
  if (Array.isArray(value)) return value.slice(0, 3);
  const text = String(value || '').trim();
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  let hex = text.replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const n = parseInt(hex.slice(0, 6), 16);
  return Number.isFinite(n) ? [n >> 16 & 255, n >> 8 & 255, n & 255] : [0, 0, 0];
}
export function hexOf(rgb) {
  return '#' + rgbOf(rgb).map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
export function mixColor(a, b, t) { const A = rgbOf(a), B = rgbOf(b); return hexOf(A.map((v, i) => v + (B[i] - v) * t)); }
export function luminance(color) {
  const c = rgbOf(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
}
const BLACK = [0, 0, 0], WHITE = [255, 255, 255];

function bodySet(shape, n = KIP_GRID) {
  const s = n / KIP_GRID, set = new Set();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + .5) / s - 11.5, dy = (y + .5) / s - 12.5;
    let inside;
    if (shape === 'squircle') inside = dx ** 4 + dy ** 4 <= 7.5 ** 4;
    else if (shape === 'tall') inside = (dx / 6.4) ** 2 + (dy / 8.4) ** 2 <= 1;
    else inside = dx * dx + dy * dy <= 8.1 * 8.1;
    const nx = (x + .5) / s - 18, ny = (y + .5) / s - 5;
    if (nx * nx + ny * ny <= 3.5 * 3.5) inside = false;  // the bite
    if (inside) set.add(x + ',' + y);
  }
  return set;
}
const BODY_CACHE = new Map();
const body = (shape, n) => { const key = shape + n; if (!BODY_CACHE.has(key)) BODY_CACHE.set(key, bodySet(shape, n)); return BODY_CACHE.get(key); };
const Z4 = ['1111', '..1.', '.1..', '1111'];

// pal: { body, eye, gold, goldHi, goldText, rose, danger, inkDim, inkFaint, stage, inkFixed }.
// Returns Map 'x,y' -> '#rrggbb'. spec: { shape, acc }.
export function kipFrame(state, frame, spec = {}, pal, level) {
  const loop = KIP_LOOPS[state] || 1, f = ((frame % loop) + loop) % loop;
  level = level ?? LEVELS[f % LEVELS.length];
  const P = new Map(), N = KIP_GRID;
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) P.set(x + ',' + y, c); };
  const fill = hexOf(pal.body);
  const dark = luminance(fill) < .2;
  const outline = dark ? mixColor(fill, BLACK, .45) : mixColor(fill, pal.inkFixed || BLACK, .55);
  const hi = mixColor(fill, WHITE, dark ? .16 : .38);
  const eye = hexOf(pal.eye);
  let ox = 0, oy = 0, eyeDx = 0, eyes = 'open', mouth = 0, feet = 0, pt = [17, 4], ptC = hexOf(pal.gold), ptSize = 2;
  const fx = [];
  const B = body(spec.shape || 'round', N);
  if (state === 'idle') {
    if (f === 28 || f === 29) eyes = 'blink';
    if (f >= 12 && f < 19) eyeDx = 1;
    if (Math.floor(f / 6) % 2) pt = [17, 3];
  } else if (state === 'walk') {
    feet = f % 2 ? 1 : 2; if (f % 2) oy = -1;
    if (Math.floor(f / 2) % 2) pt = [17, 3];
  } else if (state === 'thinking') {
    const seq = [0, 0, 1, 1, 2, 2, 1, 1, 0, 0, -1, -1, -2, -2, -1, -1]; ox = seq[f];
    eyeDx = Math.sign(seq[(f + 1) % 16] - ox) || Math.sign(seq[(f + 2) % 16] - ox);
    feet = Math.floor(f / 2) % 2 ? 1 : 2;
    const a = -0.9 + f * Math.PI / 8; pt = [Math.round(11 + ox + 11 * Math.cos(a)), Math.round(12 + 11 * Math.sin(a))];
  } else if (state === 'listening') {
    eyes = 'wide';
    [1 + Math.round(level * 3), 1 + Math.round(level * 4), 1 + Math.round(level * 2)]
      .forEach((h, i) => { for (let k = 0; k < h; k++) fx.push([21 + i, 9 - k, hexOf(pal.goldText)]); });
    if (level > .6) ptSize = 3;
  } else if (state === 'speaking') {
    mouth = level < .3 ? 1 : level < .65 ? 2 : 3;
    if (f % 4 === 3) pt = [17, 3];
  } else if (state === 'success') {
    oy = [0, 0, 1, -2, -3, -3, -2, 0, 0, 0, 0, 0, 0, 0, 0, 0][f]; eyes = 'happy';
    if (f >= 3 && f <= 7) {
      for (const [sx, sy] of [[3, 3], [20, 11], [3, 15], [21, 1]]) for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) fx.push([sx + a, sy + b, hexOf(pal.gold)]);
      ptC = hexOf(pal.goldHi);
    }
  } else if (state === 'needs') {
    eyes = 'wide'; if (f === 6) oy = -1;
    if (f >= 4) { pt = null; for (const y of [1, 2, 3, 5]) fx.push([18, y, hexOf(pal.goldText)]); }
  } else if (state === 'error') {
    eyes = 'worried'; pt = [17, 7]; ptC = hexOf(pal.danger);
    if (f < 4) ox = [0, -1, 1, 0][f];
    const p = Math.floor(f * 12 / 16);
    fx.push([19 + (p > 6 ? 1 : 0), 7 - Math.floor(p / 2), hexOf(pal.inkFaint)]);
    fx.push([20 - (p > 6 ? 1 : 0), 5 - Math.floor(p / 3), hexOf(pal.inkFaint)]);
  } else if (state === 'sleeping') {
    eyes = 'shut'; pt = [17, 7]; ptC = mixColor(pal.gold, pal.stage, .5);
    const zx = 18 + Math.floor(f / 4), zy = 7 - f;
    Z4.forEach((row, ry) => [...row].forEach((c, rx) => { if (c === '1') fx.push([zx + rx, zy + ry, hexOf(pal.inkDim)]); }));
  }
  for (const key of B) {
    const [x, y] = key.split(',').map(Number);
    const edge = !B.has((x + 1) + ',' + y) || !B.has((x - 1) + ',' + y) || !B.has(x + ',' + (y + 1)) || !B.has(x + ',' + (y - 1));
    let c = edge ? outline : fill;
    if (!edge && B.has((x - 1) + ',' + y) && B.has(x + ',' + (y - 1)) && !B.has((x - 2) + ',' + (y - 2)) && x < 12 && y < 12) c = hi;
    if (state === 'error' && edge && f < 2) c = hexOf(pal.danger);
    put(x + ox, y + oy, c);
  }
  const fy = 21 + oy;
  const feetX = feet === 1 ? [7, 8, 14, 15] : feet === 2 ? [8, 9, 13, 14] : [8, 9, 14, 15];
  for (const x of feetX) put(x + ox, fy, outline);
  const cx = 11.5 + ox, cy = 12.5 + oy;
  const acc = spec.acc || 'none';
  if (acc === 'laurel') for (let a = 205; a <= 289; a += 12) {
    const r = a * Math.PI / 180;
    put(Math.floor(cx + 9.3 * Math.cos(r)), Math.floor(cy + 9.3 * Math.sin(r)), hexOf(pal.goldHi));
    if ((a / 12) % 2 < 1) put(Math.floor(cx + 8.4 * Math.cos(r)), Math.floor(cy + 8.4 * Math.sin(r)), hexOf(pal.goldText));
  }
  if (acc === 'rays') for (let a = 200; a <= 290; a += 22) {
    const r = a * Math.PI / 180;
    put(Math.floor(cx + 10.3 * Math.cos(r)), Math.floor(cy + 10.3 * Math.sin(r)), hexOf(pal.gold));
    put(Math.floor(cx + 11.4 * Math.cos(r)), Math.floor(cy + 11.4 * Math.sin(r)), hexOf(pal.gold));
  }
  if (acc === 'scarf') {
    for (const key of B) { const [x, y] = key.split(',').map(Number); if (y === 17 || y === 18) put(x + ox, y + oy, hexOf(pal.rose)); }
    put(5 + ox, 19 + oy, hexOf(pal.rose)); put(5 + ox, 20 + oy, hexOf(pal.rose)); put(4 + ox, 20 + oy, hexOf(pal.rose));
  }
  if (acc === 'quill') {
    const h = hexOf(pal.goldHi), t = hexOf(pal.goldText), d = hexOf(pal.inkDim);
    [[3, 19, d], [2, 18, h], [2, 17, h], [1, 16, h], [2, 16, t], [1, 15, h], [2, 15, t], [1, 14, h], [2, 14, t], [1, 13, h], [1, 12, h], [1, 11, t]]
      .forEach(([x, y, c]) => put(x + ox, y + oy, c));
  }
  const EL = [8 + ox + eyeDx, 11 + oy], ER = [13 + ox + eyeDx, 11 + oy];
  for (const [ex, ey] of [EL, ER]) {
    const pair = y => { put(ex, ey + y, eye); put(ex + 1, ey + y, eye); };
    if (eyes === 'open') [0, 1, 2].forEach(pair);
    else if (eyes === 'wide') [-1, 0, 1, 2].forEach(pair);
    else if (eyes === 'blink' || eyes === 'shut') pair(2);
    else if (eyes === 'happy') { put(ex - 1, ey + 2, eye); put(ex, ey + 1, eye); put(ex + 1, ey + 1, eye); put(ex + 2, ey + 2, eye); }
    else if (eyes === 'worried') [1, 2].forEach(pair);
  }
  if (eyes === 'worried') { put(EL[0] + 1, EL[1] - 2, eye); put(EL[0], EL[1] - 1, eye); put(ER[0], ER[1] - 2, eye); put(ER[0] + 1, ER[1] - 1, eye); }
  if (acc === 'spectacles') for (const [ex, ey] of [EL, ER]) for (let x = ex - 1; x <= ex + 2; x++) for (let y = ey - 1; y <= ey + 3; y++)
    if (x === ex - 1 || x === ex + 2 || y === ey - 1 || y === ey + 3) put(x, y, hexOf(pal.goldText));
  if (mouth) {
    const mx = 10 + ox, my = 16 + oy;
    if (mouth === 1) put(mx + 1, my, eye);
    else { [0, 1, 2].forEach(i => put(mx + i, my, eye)); if (mouth === 3) [0, 1, 2].forEach(i => put(mx + i, my + 1, eye)); }
  }
  if (pt) {
    const [px, py] = pt, gold = hexOf(pal.gold);
    put(px, py, ptC); put(px + 1, py, ptC); put(px, py + 1, ptC); put(px + 1, py + 1, ptC === gold ? hexOf(pal.goldText) : ptC);
    if (ptSize === 3) { const h = hexOf(pal.goldHi); put(px - 1, py, h); put(px + 2, py + 1, h); put(px, py - 1, h); put(px + 1, py + 2, h); }
  }
  for (const [x, y, c] of fx) put(x, y, c);
  return P;
}

// The 12 by 12 Kip for the CLI's 12 x 6 cell slot (Kairos CLI build spec,
// "Mascot slot"): one half-block per two pixels. Drawn for its size, not
// scaled down, so the eyes and the point survive.
export function kipMiniFrame(state, frame, spec = {}, pal) {
  const loop = KIP_LOOPS[state] || 1, f = ((frame % loop) + loop) % loop;
  const P = new Map(), N = KIP_MINI_GRID;
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < N && y < N) P.set(x + ',' + y, c); };
  const fill = hexOf(pal.body), eye = hexOf(pal.eye);
  const outline = luminance(fill) < .2 ? mixColor(fill, BLACK, .45) : mixColor(fill, pal.inkFixed || BLACK, .5);
  const B = new Set();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x + .5 - 5.6, dy = y + .5 - 6.3;
    let inside = spec.shape === 'squircle' ? dx ** 4 + dy ** 4 <= 4.1 ** 4 : spec.shape === 'tall' ? (dx / 3.5) ** 2 + (dy / 4.5) ** 2 <= 1 : dx * dx + dy * dy <= 4.5 * 4.5;
    if ((x + .5 - 9.2) ** 2 + (y + .5 - 2.4) ** 2 <= 2.1 * 2.1) inside = false;
    if (inside) B.add(x + ',' + y);
  }
  let ox = 0, oy = 0, eyes = 'open', pt = [8, 1], ptC = hexOf(pal.gold), feet = 0;
  const fx = [];
  if (state === 'idle') { if (f === 28 || f === 29) eyes = 'blink'; if (Math.floor(f / 6) % 2) pt = [8, 0]; }
  else if (state === 'walk') { feet = 1 + f % 2; }
  else if (state === 'thinking') {
    const ring = [[8, 1], [10, 3], [11, 6], [10, 9], [6, 11], [2, 9], [0, 6], [2, 2]];
    pt = ring[Math.floor(f / 2) % 8]; feet = 1 + Math.floor(f / 2) % 2; ox = [0, 0, 1, 1, 0, 0, -1, -1][Math.floor(f / 2) % 8];
  } else if (state === 'listening' || state === 'needs') {
    eyes = 'wide';
    if (state === 'needs' && f >= 4) { pt = null; for (const y of [0, 1, 3]) fx.push([10, y, hexOf(pal.goldText)]); }
  } else if (state === 'speaking') { if (f % 2) fx.push([5, 9, eye], [6, 9, eye]); }
  else if (state === 'success') {
    eyes = 'happy'; oy = [0, 0, -1, -1, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0][f];
    if (f >= 2 && f <= 6) fx.push([1, 1, hexOf(pal.gold)], [11, 5, hexOf(pal.gold)], [0, 8, hexOf(pal.gold)]);
  } else if (state === 'error') { eyes = 'worried'; pt = [9, 4]; ptC = hexOf(pal.danger); if (f < 3) ox = [0, -1, 1][f]; }
  else if (state === 'sleeping') {
    eyes = 'shut'; pt = [9, 4]; ptC = mixColor(pal.gold, pal.stage, .5);
    if (f % 6 < 4) fx.push([10 + (f % 6 > 1 ? 1 : 0), 2 - Math.floor((f % 6) / 2), hexOf(pal.inkDim)]);
  }
  for (const key of B) {
    const [x, y] = key.split(',').map(Number);
    const edge = !B.has((x + 1) + ',' + y) || !B.has((x - 1) + ',' + y) || !B.has(x + ',' + (y + 1)) || !B.has(x + ',' + (y - 1));
    put(x + ox, y + oy, edge ? (state === 'error' && f < 2 ? hexOf(pal.danger) : outline) : fill);
  }
  const feetX = feet === 1 ? [3, 7] : feet === 2 ? [4, 8] : [4, 7];
  for (const x of feetX) put(x + ox, 11 + oy, outline);
  const acc = spec.acc || 'none';
  if (acc === 'scarf') for (const key of B) { const [x, y] = key.split(',').map(Number); if (y === 8) put(x + ox, y + oy, hexOf(pal.rose)); }
  if (acc === 'laurel') for (const [x, y] of [[1, 3], [2, 2], [3, 1]]) put(x + ox, y + oy, hexOf(pal.goldHi));
  if (acc === 'rays') for (const [x, y] of [[0, 3], [2, 0], [5, 0]]) put(x + ox, y + oy, hexOf(pal.gold));
  if (acc === 'quill') for (const [x, y] of [[0, 4], [0, 5], [0, 6], [1, 7]]) put(x + ox, y + oy, hexOf(pal.goldHi));
  const EL = [4 + ox, 5 + oy], ER = [7 + ox, 5 + oy];
  for (const [ex, ey] of [EL, ER]) {
    if (eyes === 'open') { put(ex, ey, eye); put(ex, ey + 1, eye); }
    else if (eyes === 'wide') { put(ex, ey - 1, eye); put(ex, ey, eye); put(ex, ey + 1, eye); }
    else if (eyes === 'blink' || eyes === 'shut' || eyes === 'worried') put(ex, ey + 1, eye);
    else if (eyes === 'happy') put(ex, ey, eye);
  }
  if (acc === 'spectacles') { put(EL[0] - 1, EL[1], hexOf(pal.goldText)); put(ER[0] + 1, ER[1], hexOf(pal.goldText)); }
  if (pt) put(pt[0], pt[1], ptC);
  for (const [x, y, c] of fx) put(x, y, c);
  return P;
}

// One frame as SVG paths, one per colour: crisp at any integer scale.
export function kipPathMarkup(pixels, dx = 0) {
  const byColour = new Map();
  for (const [key, colour] of pixels) {
    const [x, y] = key.split(',').map(Number);
    if (!byColour.has(colour)) byColour.set(colour, []);
    byColour.get(colour).push(`M${x + dx} ${y}h1v1h-1z`);
  }
  return [...byColour].map(([colour, d]) => `<path fill="${colour}" d="${d.join('')}"/>`).join('');
}
export function kipSvg(pixels, n = KIP_GRID) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}" shape-rendering="crispEdges">${kipPathMarkup(pixels)}</svg>`;
}
// A horizontal strip of frames: the village plays it with CSS steps().
export function kipStripSvg(frames, n = KIP_GRID) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * frames.length} ${n}" width="${n * frames.length}" height="${n}" shape-rendering="crispEdges">${frames.map((pixels, i) => kipPathMarkup(pixels, i * n)).join('')}</svg>`;
}

// Terminal half-blocks: each character is two stacked pixels (upper half
// in the foreground colour, lower half in the background colour). With
// colour: 24-bit ANSI. Without: plain blocks, the shape only.
// `hole`: a colour drawn as clear in plain mode, so the eyes show as gaps.
export function kipHalfBlocks(pixels, { n = KIP_GRID, color = true, trimX = true, hole = null } = {}) {
  if (!color && hole) pixels = new Map([...pixels].filter(([, c]) => c !== hexOf(hole)));
  let minX = 0, maxX = n - 1;
  if (trimX) {
    const xs = [...pixels.keys()].map(k => +k.split(',')[0]);
    minX = Math.min(...xs); maxX = Math.max(...xs);
  }
  const fg = c => { const [r, g, b] = rgbOf(c); return `\x1b[38;2;${r};${g};${b}m`; };
  const bg = c => { const [r, g, b] = rgbOf(c); return `\x1b[48;2;${r};${g};${b}m`; };
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '';
    for (let x = minX; x <= maxX; x++) {
      const a = pixels.get(x + ',' + y), b = pixels.get(x + ',' + (y + 1));
      if (!color) { line += a && b ? '█' : a ? '▀' : b ? '▄' : ' '; continue; }
      if (!a && !b) line += '\x1b[0m ';
      else if (a && b && a === b) line += '\x1b[0m' + fg(a) + '█';
      else if (a && b) line += fg(a) + bg(b) + '▀';
      else if (a) line += '\x1b[0m' + fg(a) + '▀';
      else line += '\x1b[0m' + fg(b) + '▄';
    }
    lines.push(color ? line + '\x1b[0m' : line.replace(/\s+$/, ''));
  }
  return lines;
}
