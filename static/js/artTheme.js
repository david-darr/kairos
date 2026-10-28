// The colours the Animated background style takes from its art (David, 2026-10-28): a base, the
// art's own background, and an accent, its strongest colour that stands out from that base.
// appearance.js builds the rest of the theme from these the same way it does for Color.
const rgbOf = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const hexOf = color => '#' + color.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const chroma = color => Math.max(...color) - Math.min(...color);
function luminance(color) {
  return color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
};
function average(entries) {
  let total = 0; const sum = [0, 0, 0];
  for (const [color, weight] of entries) { total += weight; color.forEach((v, i) => { sum[i] += v * weight; }); }
  return total ? sum.map(v => v / total) : null;
}
// The most colourful candidate that stands clear of the base; failing that, the most colourful.
function pickAccent(candidates, base) {
  const ranked = candidates.filter(color => chroma(color) > 40).sort((a, b) => chroma(b) - chroma(a));
  return ranked.find(color => contrast(color, base) >= 3) || ranked[0] || null;
}

// A piece's colours over a few frames: which keys sit on its border or cover a large share of it
// (its background), and how often every key appears.
function pieceCounts(mod) {
  const draw = mod.default(), counts = new Map(), edge = new Set();
  let cells = 0, palette = mod.meta.palette;
  for (const t of [0, 1.3, 2.9, 4.1]) {
    const frame = draw(t);
    if (typeof frame === 'string') return null;
    if (frame.palette) palette = frame.palette;
    const rows = frame.color.split('\n').map(row => [...row]), last = rows.length - 1;
    rows.forEach((row, r) => row.forEach((key, c) => {
      if (key === ' ' || !palette?.[key]) return;
      cells++; counts.set(key, (counts.get(key) || 0) + 1);
      if (r === 0 || r === last || c === 0 || c === row.length - 1) edge.add(key);
    }));
  }
  if (!cells) return null;
  const background = new Set(edge);
  for (const [key, count] of counts) if (count > cells * .12) background.add(key);
  const back = [...counts].filter(([key]) => background.has(key)).map(([key, count]) => [rgbOf(palette[key]), count]);
  const front = [...counts].filter(([key, count]) => !background.has(key) && count >= cells * .005).map(([key]) => rgbOf(palette[key]));
  return { base: average(back), front };
}

// One piece: a deep shade of its own background as the base, so the app sits with the black stage
// the piece is shown on (as on ascii-magic.com), and its brightest colour as the accent.
export function pieceColors(mod) {
  const found = pieceCounts(mod);
  if (!found?.base) return null;
  let base = found.base;
  while (luminance(base) > .025) base = base.map(v => v * .85);
  const accent = pickAccent(found.front, base);
  return { base: hexOf(base), accent: accent ? hexOf(accent) : null };
}

// Your own animation: the picture's border as the base and its most colourful common colour as
// the accent. `frames` are drawable images or video frames, sampled small.
export function pictureColors(frames) {
  const size = 48, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const border = [], buckets = new Map();
  let pixels = 0;
  for (const frame of frames) {
    ctx.clearRect(0, 0, size, size); ctx.drawImage(frame, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < size * size; i++) {
      if (data[i * 4 + 3] < 128) continue;
      const color = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]], x = i % size, y = Math.floor(i / size);
      pixels++;
      if (x < 3 || y < 3 || x >= size - 3 || y >= size - 3) border.push([color, 1]);
      // Buckets of 32 levels a channel, each remembering its average colour.
      const key = color.map(v => v >> 5).join(',');
      const bucket = buckets.get(key) || { sum: [0, 0, 0], count: 0 };
      color.forEach((v, k) => { bucket.sum[k] += v; }); bucket.count++; buckets.set(key, bucket);
    }
  }
  const base = average(border);
  if (!base) return null;
  const front = [...buckets.values()].filter(bucket => bucket.count >= pixels * .01).map(bucket => bucket.sum.map(v => v / bucket.count));
  const accent = pickAccent(front, base);
  return { base: hexOf(base), accent: accent ? hexOf(accent) : null };
}
