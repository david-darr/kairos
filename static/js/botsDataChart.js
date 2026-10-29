// Charts for the data panel, the chat and widgets (Phase 6 unit U2, 2026-10-29): drawn here as inline SVG
// from the small reduction the server sends (at most 10,000 marks). Colours are always tokens (var(--accent)
// and friends); export resolves them to the live values first. No library, and no innerHTML: every label is a
// text node, so a value from a file cannot become markup. The layout functions are pure (scripts/test_bots_data_model.cjs).

export const MAX_MARKS = 10_000;
export const SERIES_COLORS = ['var(--accent)', 'var(--success)', 'var(--warn)', 'var(--danger)', 'var(--m-body-b9d2e3)',
  'var(--m-body-d99a92)', 'var(--m-body-cdbfd9)', 'var(--m-body-b5c7a5)'];
export const seriesColor = i => SERIES_COLORS[((i % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];

// -- scales and ticks ---------------------------------------------------------------------------------
export function scaleLinear([d0, d1], [r0, r1]) {
  const span = d1 - d0;
  return value => (span === 0 ? (r0 + r1) / 2 : r0 + ((value - d0) / span) * (r1 - r0));
}
// Round tick values covering [min, max]: steps of 1, 2 or 5 times a power of ten, about `count` of them.
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.5 : 1; min -= pad; max += pad; }
  const raw = (max - min) / Math.max(1, count);
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * power).find(s => s >= raw) || 10 * power;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5 && ticks.length < 50; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}
export function shortNumber(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v * 100) / 100);
}
const numeric = v => typeof v === 'number' && Number.isFinite(v);
const asNumber = v => (numeric(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const asTime = v => { if (typeof v !== 'string' || !/^\d{4}-\d{2}(-\d{2})?/.test(v)) return null; const t = Date.parse(v.replace(' ', 'T') + (v.length <= 7 ? '-01' : '')); return Number.isFinite(t) ? t : null; };
const clip = (text, n) => { const s = String(text ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function rowsOf(chart) {
  const fields = chart.fields || [];
  return (chart.rows || []).map(row => Object.fromEntries(fields.map((f, i) => [f, row[i]])));
}
export function seriesNames(rows) {
  const names = [];
  for (const r of rows) if (r.series !== undefined && r.series !== null && !names.includes(r.series)) names.push(r.series);
  return names;
}

export function plotBox(width, height, mini = false) {
  const m = mini ? { l: 34, r: 8, t: 8, b: 22 } : { l: 52, r: 14, t: 14, b: 34 };
  return { x: m.l, y: m.t, w: Math.max(10, width - m.l - m.r), h: Math.max(10, height - m.t - m.b), width, height };
}

// -- layouts (pure) --------------------------------------------------------------------------------------
export function barLayout(chart, plot, { stack = false } = {}) {
  const rows = rowsOf(chart);
  const cats = [...new Set(rows.map(r => String(r.x)))];
  const names = seriesNames(rows);
  const groups = names.length || 1;
  const cell = new Map(rows.map(r => [`${r.x}\u0000${r.series ?? ''}`, Number(r.y) || 0]));
  const stackTotals = cats.map(c => (names.length ? names : ['']).reduce((s, n) => s + Math.max(0, cell.get(`${c}\u0000${n}`) || 0), 0));
  const maxV = Math.max(0, ...(stack && names.length ? stackTotals : rows.map(r => Number(r.y) || 0)));
  const minV = Math.min(0, ...rows.map(r => Number(r.y) || 0));
  const ticks = niceTicks(minV, maxV || 1, 4);
  const domain = [Math.min(minV, ticks[0]), Math.max(maxV, ticks[ticks.length - 1])];
  const yScale = scaleLinear(domain, [plot.y + plot.h, plot.y]);
  const band = plot.w / Math.max(1, cats.length);
  const inner = Math.min(band * 0.78, 56 * (stack ? 1 : groups));
  const marks = [];
  cats.forEach((cat, ci) => {
    const left = plot.x + ci * band + (band - inner) / 2;
    let running = 0;
    (names.length ? names : ['']).forEach((name, si) => {
      const value = cell.get(`${cat}\u0000${name}`);
      if (value === undefined) return;
      const w = stack || !names.length ? inner : inner / groups;
      const x = stack || !names.length ? left : left + si * w;
      let y0 = yScale(0), y1 = yScale(value);
      if (stack && names.length) { y0 = yScale(running); y1 = yScale(running + Math.max(0, value)); running += Math.max(0, value); }
      marks.push({ x, y: Math.min(y0, y1), w: Math.max(1, w - (stack ? 0 : 1)), h: Math.abs(y1 - y0), series: name, cat, value, color: seriesColor(si) });
    });
  });
  return { marks, yTicks: ticks.filter(t => t >= domain[0] && t <= domain[1]).map(t => ({ value: t, y: yScale(t) })),
    xLabels: cats.map((c, i) => ({ text: c, x: plot.x + i * band + band / 2 })), names, domain };
}

function xKind(rows) {
  if (rows.every(r => asNumber(r.x) !== null)) return 'number';
  if (rows.every(r => asTime(String(r.x)) !== null)) return 'time';
  return 'category';
}
export function lineLayout(chart, plot, { area = false } = {}) {
  const rows = rowsOf(chart);
  const kind = xKind(rows);
  const names = seriesNames(rows);
  const cats = kind === 'category' ? [...new Set(rows.map(r => String(r.x)))] : [];
  const xv = r => (kind === 'number' ? asNumber(r.x) : kind === 'time' ? asTime(String(r.x)) : cats.indexOf(String(r.x)));
  const xs = rows.map(xv);
  const ys = rows.map(r => Number(r.y) || 0);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yTicks = niceTicks(Math.min(0, ...ys), Math.max(...ys, 0) || 1, 4);
  const yDomain = [yTicks[0], yTicks[yTicks.length - 1]];
  const sx = scaleLinear([xMin, xMax], [plot.x + (kind === 'category' ? 6 : 0), plot.x + plot.w - (kind === 'category' ? 6 : 0)]);
  const sy = scaleLinear(yDomain, [plot.y + plot.h, plot.y]);
  const list = (names.length ? names : ['']).map((name, si) => {
    const points = rows.filter(r => (r.series ?? '') === name).map(r => ({ x: sx(xv(r)), y: sy(Number(r.y) || 0), raw: r }))
      .sort((a, b) => a.x - b.x);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
    const base = sy(Math.max(yDomain[0], 0));
    const fill = points.length ? `${line} L${points[points.length - 1].x.toFixed(1)} ${base.toFixed(1)} L${points[0].x.toFixed(1)} ${base.toFixed(1)} Z` : '';
    return { name, points, line, fill: area ? fill : '', color: seriesColor(si) };
  });
  const step = Math.max(1, Math.ceil((kind === 'category' ? cats.length : 6) / 6));
  const xLabels = kind === 'category'
    ? cats.map((c, i) => ({ text: c, x: sx(i), i })).filter(l => l.i % step === 0)
    : niceTicks(xMin, xMax, 5).filter(t => t >= xMin && t <= xMax).map(t => ({ text: kind === 'time' ? new Date(t).toISOString().slice(0, 10) : shortNumber(t), x: sx(t) }));
  return { series: list, yTicks: yTicks.map(t => ({ value: t, y: sy(t) })), xLabels, kind };
}

export function scatterLayout(chart, plot) {
  const rows = rowsOf(chart);
  const names = seriesNames(rows);
  const pts = rows.map(r => ({ x: asNumber(r.x), y: asNumber(r.y), s: r.series })).filter(p => p.x !== null && p.y !== null);
  const xt = niceTicks(Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.x)), 5);
  const yt = niceTicks(Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.y)), 4);
  const sx = scaleLinear([xt[0], xt[xt.length - 1]], [plot.x, plot.x + plot.w]);
  const sy = scaleLinear([yt[0], yt[yt.length - 1]], [plot.y + plot.h, plot.y]);
  return { marks: pts.map(p => ({ x: sx(p.x), y: sy(p.y), raw: p, color: seriesColor(Math.max(0, names.indexOf(p.s))) })),
    xTicks: xt.map(t => ({ value: t, x: sx(t) })), yTicks: yt.map(t => ({ value: t, y: sy(t) })) };
}

export function histogramLayout(chart, plot) {
  const rows = rowsOf(chart);
  if (!rows.length) return { marks: [], xTicks: [], yTicks: [] };
  const lo = Math.min(...rows.map(r => Number(r.x0))), hi = Math.max(...rows.map(r => Number(r.x1)));
  const maxY = Math.max(...rows.map(r => Number(r.y) || 0), 1);
  const yt = niceTicks(0, maxY, 4);
  const sx = scaleLinear([lo, hi], [plot.x, plot.x + plot.w]);
  const sy = scaleLinear([0, yt[yt.length - 1]], [plot.y + plot.h, plot.y]);
  return { marks: rows.map(r => ({ x: sx(Number(r.x0)), w: Math.max(1, sx(Number(r.x1)) - sx(Number(r.x0)) - 1), y: sy(Number(r.y)), h: sy(0) - sy(Number(r.y)), raw: r })),
    xTicks: niceTicks(lo, hi, 5).filter(t => t >= lo && t <= hi).map(t => ({ value: t, x: sx(t) })), yTicks: yt.map(t => ({ value: t, y: sy(t) })) };
}

export function pieLayout(chart, cx, cy, r) {
  const rows = rowsOf(chart).filter(row => Number(row.y) > 0);
  const total = rows.reduce((s, row) => s + Number(row.y), 0);
  let angle = -Math.PI / 2;
  return rows.map((row, i) => {
    const share = total ? Number(row.y) / total : 0;
    const a0 = angle, a1 = angle + share * Math.PI * 2;
    angle = a1;
    const p = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const d = share >= 0.9999
      ? `M${cx - r} ${cy} A${r} ${r} 0 1 1 ${cx + r} ${cy} A${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
      : `M${cx} ${cy} L${p(a0, r)} A${r} ${r} 0 ${big} 1 ${p(a1, r)} Z`;
    return { d, label: String(row.x), value: Number(row.y), share, color: seriesColor(i) };
  });
}

export function heatmapLayout(chart, plot) {
  const rows = rowsOf(chart);
  const xs = [...new Set(rows.map(r => String(r.x)))], ys = [...new Set(rows.map(r => String(r.y)))];
  const maxV = Math.max(...rows.map(r => Number(r.v) || 0), 1);
  const cw = plot.w / Math.max(1, xs.length), ch = plot.h / Math.max(1, ys.length);
  return { cells: rows.map(r => ({ x: plot.x + xs.indexOf(String(r.x)) * cw, y: plot.y + ys.indexOf(String(r.y)) * ch, w: cw - 1, h: ch - 1,
    opacity: Math.max(0.08, (Number(r.v) || 0) / maxV), raw: r })), xs, ys, cw, ch };
}

// Series from a widget's Chart node ({kind, series:[{name, points:[{x,y}]}]}) in the server's row form.
export function chartFromSeries(node) {
  const rows = [];
  for (const s of node.series || []) for (const p of s.points || []) rows.push([p.x, node.series.length > 1 ? s.name : null, p.y]);
  return { type: node.kind || 'bar', fields: ['x', 'series', 'y'], rows };
}

// -- drawing ---------------------------------------------------------------------------------------------
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}
function title(node, text) { node.append(svg('title', {}, text)); return node; }

function axes(root, plot, yTicks, xLabels, mini) {
  for (const t of yTicks) {
    root.append(svg('line', { x1: plot.x, x2: plot.x + plot.w, y1: t.y, y2: t.y, stroke: 'var(--text-dim)', 'stroke-opacity': 0.18 }));
    root.append(svg('text', { x: plot.x - 6, y: t.y + 3, 'text-anchor': 'end', fill: 'var(--text-dim)', 'font-size': mini ? 9 : 10 }, shortNumber(t.value)));
  }
  for (const l of xLabels || []) root.append(svg('text', { x: l.x, y: plot.y + plot.h + (mini ? 14 : 18), 'text-anchor': 'middle', fill: 'var(--text-dim)', 'font-size': mini ? 9 : 10 }, clip(l.text, mini ? 8 : 12)));
}

// Draw `chart` ({type, fields, rows, note, spec}) into host. Returns the <svg>.
export function drawChart(host, chart, { width = 480, height = 280, mini = false, label = 'Chart' } = {}) {
  const root = svg('svg', { class: 'bots-chart', viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': label, 'font-family': 'inherit' });
  root.style.maxWidth = `${width}px`;
  const plot = plotBox(width, height, mini);
  const type = chart.type;
  if (!chart.rows || !chart.rows.length) {
    root.append(svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: 'var(--text-dim)', 'font-size': 12 }, 'Nothing to draw'));
  } else if (type === 'bar') {
    const L = barLayout(chart, plot, { stack: !!chart.spec?.stack });
    axes(root, plot, L.yTicks, L.xLabels.length > 14 ? L.xLabels.filter((_, i) => i % Math.ceil(L.xLabels.length / 10) === 0) : L.xLabels, mini);
    for (const m of L.marks) root.append(title(svg('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: m.color, rx: 2 }), `${m.cat}${m.series ? ' / ' + m.series : ''}: ${shortNumber(m.value)}`));
  } else if (type === 'line' || type === 'area') {
    const L = lineLayout(chart, plot, { area: type === 'area' });
    axes(root, plot, L.yTicks, L.xLabels, mini);
    for (const s of L.series) {
      if (s.fill) root.append(svg('path', { d: s.fill, fill: s.color, 'fill-opacity': 0.18, stroke: 'none' }));
      root.append(svg('path', { d: s.line, fill: 'none', stroke: s.color, 'stroke-width': 1.75, 'stroke-linejoin': 'round' }));
      if (s.points.length <= 60) for (const p of s.points) root.append(title(svg('circle', { cx: p.x, cy: p.y, r: 2.5, fill: s.color }), `${p.raw.x}: ${shortNumber(Number(p.raw.y))}`));
    }
  } else if (type === 'scatter') {
    const L = scatterLayout(chart, plot);
    axes(root, plot, L.yTicks, L.xTicks.map(t => ({ text: shortNumber(t.value), x: t.x })), mini);
    for (const m of L.marks) root.append(svg('circle', { cx: m.x, cy: m.y, r: 2.5, fill: m.color, 'fill-opacity': 0.7 }));
  } else if (type === 'histogram') {
    const L = histogramLayout(chart, plot);
    axes(root, plot, L.yTicks, L.xTicks.map(t => ({ text: shortNumber(t.value), x: t.x })), mini);
    for (const m of L.marks) root.append(title(svg('rect', { x: m.x, y: m.y, width: m.w, height: m.h, fill: 'var(--accent)', rx: 1 }), `${shortNumber(Number(m.raw.x0))} to ${shortNumber(Number(m.raw.x1))}: ${m.raw.y}`));
  } else if (type === 'pie') {
    const r = Math.min(plot.w, plot.h) / 2;
    const cx = plot.x + (mini ? plot.w / 2 : r + 6), cy = plot.y + plot.h / 2;
    const slices = pieLayout(chart, cx, cy, r);
    for (const s of slices) root.append(title(svg('path', { d: s.d, fill: s.color, stroke: 'var(--bg)', 'stroke-width': 1 }), `${s.label}: ${shortNumber(s.value)} (${Math.round(s.share * 100)}%)`));
    if (!mini) slices.slice(0, 10).forEach((s, i) => {
      const y = plot.y + 8 + i * 18, x = cx + r + 24;
      root.append(svg('rect', { x, y: y - 8, width: 10, height: 10, fill: s.color, rx: 2 }));
      root.append(svg('text', { x: x + 16, y, fill: 'var(--text)', 'font-size': 11 }, `${clip(s.label, 18)} ${Math.round(s.share * 100)}%`));
    });
  } else if (type === 'heatmap') {
    const L = heatmapLayout(chart, plot);
    for (const c of L.cells) root.append(title(svg('rect', { x: c.x, y: c.y, width: Math.max(1, c.w), height: Math.max(1, c.h), fill: 'var(--accent)', 'fill-opacity': c.opacity }), `${c.raw.x} / ${c.raw.y}: ${shortNumber(Number(c.raw.v))}`));
    L.xs.forEach((x, i) => { if (i % Math.ceil(L.xs.length / 8) === 0) root.append(svg('text', { x: plot.x + i * L.cw + L.cw / 2, y: plot.y + plot.h + 14, 'text-anchor': 'middle', fill: 'var(--text-dim)', 'font-size': 9 }, clip(x, 8))); });
    L.ys.forEach((y, i) => { if (i % Math.ceil(L.ys.length / 8) === 0) root.append(svg('text', { x: plot.x - 4, y: plot.y + i * L.ch + L.ch / 2 + 3, 'text-anchor': 'end', fill: 'var(--text-dim)', 'font-size': 9 }, clip(y, 6))); });
  } else {
    root.append(svg('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: 'var(--text-dim)', 'font-size': 12 }, 'This chart type is not drawn here'));
  }
  if (type === 'bar' || type === 'line' || type === 'area') {
    const names = seriesNames(rowsOf(chart));
    if (names.length > 1 && !mini) names.slice(0, 6).forEach((n, i) => {
      root.append(svg('rect', { x: plot.x + i * 96, y: height - 10, width: 8, height: 8, fill: seriesColor(i), rx: 2 }));
      root.append(svg('text', { x: plot.x + i * 96 + 12, y: height - 3, fill: 'var(--text-dim)', 'font-size': 10 }, clip(n, 11)));
    });
  }
  host.append(root);
  return root;
}

// -- export (client side) -------------------------------------------------------------------------------
// Resolve var(--token) paints to live colours so the picture stands on its own outside the page.
export function standaloneSvg(svgEl, { background = 'var(--bg)' } = {}) {
  const clone = svgEl.cloneNode(true);
  const style = getComputedStyle(document.documentElement);
  const resolve = value => String(value).replace(/var\((--[a-z0-9-]+)\)/gi, (_, name) => style.getPropertyValue(name).trim() || 'currentColor');
  const walk = node => {
    for (const attr of ['fill', 'stroke']) if (node.hasAttribute?.(attr)) node.setAttribute(attr, resolve(node.getAttribute(attr)));
    [...(node.children || [])].forEach(walk);
  };
  walk(clone);
  const viewBox = (clone.getAttribute('viewBox') || '0 0 480 280').split(/\s+/).map(Number);
  clone.setAttribute('xmlns', NS);
  clone.setAttribute('width', viewBox[2]); clone.setAttribute('height', viewBox[3]);
  clone.setAttribute('font-family', 'sans-serif');
  const back = svg('rect', { x: 0, y: 0, width: viewBox[2], height: viewBox[3], fill: resolve(background) });
  clone.insertBefore(back, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}
export function svgBlob(svgEl) { return new Blob([standaloneSvg(svgEl)], { type: 'image/svg+xml' }); }
export async function pngBlob(svgEl, scale = 2) {
  const text = standaloneSvg(svgEl);
  const [, , w, h] = (svgEl.getAttribute('viewBox') || '0 0 480 280').split(/\s+/).map(Number);
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('The picture could not be made.')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = w * scale; canvas.height = h * scale;
    const g = canvas.getContext('2d');
    g.scale(scale, scale);
    g.drawImage(image, 0, 0, w, h);
    return await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}
export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
