import { clamp, expoOut, pop, inOut, hash, seededRandom, zoomAbout, scrim, card, windowReveal, BAYER, contrast, readable, luminance, rgb } from './kit.js';
import { drawScene, sceneBoxes, groundLine, packCard, drawCardSky, drawCardWorld } from './scene.js';
import { stageModel, stagePose, labelsAt, actorBoxes } from './stage.js';
import { normalizeProject, dimensions, safeArea, captionBand, captionAt, fitText, frameTime, beatAt, transitionAt, beatLayout, cameraAt, beatElapsed, transitionTransform, visibleBox, compositionAt, revealElapsed, listMarker } from './layout.js';

function lookTokens(canvas, supplied) {
  const doc = canvas.ownerDocument, root = getComputedStyle(doc.documentElement), probe = doc.createElement('span');
  probe.style.position = 'absolute'; probe.style.visibility = 'hidden';
  for (const [k, v] of Object.entries(supplied || {})) if (k.startsWith('--ds-')) probe.style.setProperty(k, String(v));
  doc.body.append(probe);
  const raw = key => supplied?.[`--ds-${key}`] ?? root.getPropertyValue(`--ds-${key}`).trim();
  const color = (key, fallback) => {
    probe.style.color = `var(--ds-${key}, ${fallback})`;
    return getComputedStyle(probe).color;
  };
  const bg = color('bg', 'Canvas'), text = color('text', 'CanvasText');
  probe.style.fontFamily = 'var(--ds-font-display, var(--ds-font-sans, sans-serif))';
  const display = getComputedStyle(probe).fontFamily;
  probe.style.fontFamily = 'var(--ds-font-sans, sans-serif)';
  const sans = getComputedStyle(probe).fontFamily;
  const result = { bg, text, surface: color('surface', bg), dim: color('text-dim', text), accent: color('accent', text),
    second: color('accent-2', text), onAccent: color('on-accent', bg), display, sans,
    radius: Math.max(0, parseFloat(raw('radius-m')) || 0), upper: ['upper', 'uppercase'].includes(raw('label-case')),
    weight: /^\d{3}$/.test(raw('display-weight')) ? raw('display-weight') : '700',
    italic: raw('display-style') === 'italic', pattern: raw('pattern') || (/sport|bold|dynamic/i.test(raw('mood')) ? 'stripes' : luminance(bg) < .3 ? 'grid' : 'dots') };
  probe.remove();
  result.palette = [result.text, result.dim, result.accent, result.second, result.onAccent, result.bg, result.surface];
  result.ink = readable(text, bg, result.palette);
  if (contrast(result.ink, bg) < 4.5) throw new Error('Motion look requires a text/background token pair with contrast >= 4.5:1');
  // Keep the gradient endpoint within the same contrast envelope as bare bg.
  const base = rgb(bg), surface = rgb(result.surface);
  result.backdrop = bg;
  for (let blend = 1; blend > 0; blend -= .05) {
    const endpoint = `rgb(${base.map((v, i) => Math.round(v * (1 - blend) + surface[i] * blend)).join(' ')})`;
    if ([text, result.dim, result.accent].every(c => contrast(readable(c, bg, result.palette), endpoint) >= 4.5)) { result.backdrop = endpoint; break; }
  }
  return result;
}
function buffer(doc, w, h) { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; }
function font(style, size, role) {
  return `${role !== 'body' && style.italic ? 'italic ' : ''}${role === 'body' ? 500 : style.weight} ${size}px ${role === 'body' ? style.sans : style.display}`;
}
// Missing-glyph metrics are checked in each look font; shapes need no font at all.
export function drawQuoteMark(g, style, x, y, size = 96) {
  g.save(); g.fillStyle = style.accent; g.textAlign = 'left'; g.textBaseline = 'top';
  for (const role of ['title', 'body']) {
    g.font = font(style, size, role);
    const width = g.measureText('\u201c').width;
    if (width > 0 && ['\u{10ffff}', '\ufffd', '?'].every(missing => Math.abs(width - g.measureText(missing).width) > .01)) {
      g.fillText('\u201c', x, y); g.restore(); return role;
    }
  }
  for (let i = 0; i < 2; i++) {
    const left = x + i * size * .32;
    g.beginPath(); g.moveTo(left + size * .24, y);
    g.quadraticCurveTo(left, y, left, y + size * .45);
    g.lineTo(left + size * .24, y + size * .45);
    g.lineTo(left + size * .24, y + size * .23);
    g.lineTo(left + size * .10, y + size * .23);
    g.quadraticCurveTo(left + size * .10, y + size * .08, left + size * .24, y + size * .06);
    g.closePath(); g.fill();
  }
  g.restore(); return 'shape';
}
function cover(ctx, img, box, contain = false) {
  const scale = (contain ? Math.min : Math.max)(box.w / img.naturalWidth, box.h / img.naturalHeight);
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  ctx.save(); ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.drawImage(img, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h); ctx.restore();
}

export function mount(canvas, input, options = {}) {
  if (!canvas?.getContext) throw new TypeError('mount requires a canvas');
  const project = normalizeProject(input), { width: w, height: h, aspect } = dimensions(options.aspect || project.aspects[0]);
  canvas.width = w; canvas.height = h;
  const doc = canvas.ownerDocument, ctx = canvas.getContext('2d'), style = lookTokens(canvas, options.tokens), safe = safeArea(aspect, project.captioned);
  // A style pack draws its copy beats in its own world (scene.js packCard); scenes and captions keep their own colours.
  const packLook = project.pack?.palette ? packCard(project.pack) : null;
  const cardStyle = packLook ? { ...style, bg: packLook.bg, backdrop: packLook.backdrop, text: packLook.text, dim: packLook.dim, accent: packLook.accent,
    second: packLook.second, surface: packLook.surface, onAccent: packLook.onAccent, rule: packLook.rule, pattern: 'flat', reportBg: packLook.worstBg,
    palette: [packLook.text, packLook.dim, packLook.accent] } : style;
  const styleOf = beat => beat.kind === 'scene' || beat.kind === 'stage' ? style : cardStyle;
  // Pack B (stage.js): 3D studio shots. three.js draws them here; with the Blender renderer this page is the overlay
  // pass instead (options.layer 'overlay'): stage shots stay transparent, everything else draws as usual, transitions
  // into and out of a stage shot are cuts, and the 3D pose of every frame is reported for Blender (kdPose).
  const overlay = options.layer === 'overlay', hasStage = project.beats.some(b => b.kind === 'stage');
  const models = new Map(), poses = new Map();
  let stage3d = null;
  const modelOf = beat => { if (!models.has(beat.id)) models.set(beat.id, stageModel(beat, project.characters)); return models.get(beat.id); };
  const poseOf = (beat, seconds) => {
    const key = `${beat.id}:${seconds.toFixed(5)}`;
    if (!poses.has(key)) { if (poses.size > 64) poses.clear(); poses.set(key, stagePose(modelOf(beat), beat, seconds, w, h, project.captioned)); }
    return poses.get(key);
  };
  const measureCtx = buffer(doc, 1, 1).getContext('2d');
  const measure = (text, size, role) => { measureCtx.font = font(style, size, role); return measureCtx.measureText(text).width; };
  const images = new Map(), samples = new Map(), plans = new Map();
  const layers = Array.from({ length: 2 }, () => ({ bg: buffer(doc, w, h), fg: buffer(doc, w, h) }));
  let loaded = false;
  const plan = beat => {
    if (!plans.has(beat.id)) plans.set(beat.id, beatLayout(beat, aspect, measure, { ...style, captioned: project.captioned, composition: compositionAt(project.beats, project.beats.indexOf(beat)) }));
    return plans.get(beat.id);
  };
  const assetURL = name => {
    const base = new URL(options.assetsBase || 'assets/', doc.baseURI);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const url = new URL(encodeURIComponent(name), base);
    // Keep render-token authentication for a standalone player, including relative assets.
    const token = new URL(doc.URL).searchParams.get('rt');
    if (token && url.origin === new URL(doc.URL).origin) url.searchParams.set('rt', token);
    return url.href;
  };
  const loadImage = name => new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { images.set(name, img); resolve(); };
    img.onerror = () => reject(new Error(`Motion image failed to load: ${name}`));
    img.src = assetURL(name);
  });
  const ready = (async () => {
    // Explicit loads activate @font-face rules before fonts.ready can resolve early.
    await Promise.all([doc.fonts.load(font(style, 96, 'title')), doc.fonts.load(font(style, 48, 'body')),
      ...[...new Set(project.beats.map(b => b.image).filter(Boolean))].map(loadImage)]);
    await doc.fonts.ready;
    if (hasStage && !overlay) {
      const { StageRenderer } = await import('./stage3d.js');
      stage3d = new StageRenderer(w, h, { ss: options.ss || 2 });
      for (const beat of project.beats) if (beat.kind === 'stage') stage3d.build(modelOf(beat));
    }
    for (const beat of project.beats) plan(beat);
    loaded = true; drawFrame(0);
  })();

  function background(g, beat, p) {
    const style = styleOf(beat);
    const seconds = p * (beat.end - beat.start);
    if (beat.kind === 'stage') {
      if (!overlay) g.drawImage(stage3d.render(modelOf(beat), poseOf(beat, seconds)), 0, 0);
      return;
    }
    g.fillStyle = style.bg; g.fillRect(0, 0, w, h);
    // A Pack A scene draws its own layered setting, props and cast (scene.js); the look keeps the type.
    if (beat.kind === 'scene') { drawScene(g, beat, project, w, h, groundLine(h, band, project.captioned), seconds, p); return; }
    if (packLook) drawCardSky(g, packLook, w, h, safe.y + safe.h);
    else {
      const gradient = g.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, style.bg); gradient.addColorStop(1, style.backdrop);
      g.fillStyle = gradient; g.fillRect(0, 0, w, h);
    }
    const camera = cameraAt(beat.camera, p, hash(beat.id) % 100);
    g.save(); g.translate(camera.dx * w, camera.dy * h);
    zoomAbout(g, w / 2, h / 2, camera.scale, () => {
      if (packLook) drawCardWorld(g, packLook, w, h, safe.y + safe.h, seconds);
      else {
      g.save(); g.translate(Math.sin(seconds * .21) * 22, Math.sin(seconds * .17) * 22); g.globalAlpha = .06; g.fillStyle = style.accent; g.strokeStyle = style.second; g.lineWidth = 2;
      if (style.pattern === 'dots' || style.pattern === 'confetti') {
        for (let y = -44; y < h + 44; y += 44) for (let x = -44; x < w + 44; x += 44) { g.beginPath(); g.arc(x, y, style.radius > 10 ? 1.5 : 2.5, 0, Math.PI * 2); g.fill(); }
      } else if (['grain', 'noise'].includes(style.pattern)) {
        const random = seededRandom(beat.id);
        for (let i = 0; i < 3500; i++) g.fillRect(random() * w, random() * h, 2, 2);
      } else if (['waves', 'topo'].includes(style.pattern)) {
        for (let y = -100; y < h + 100; y += 54) {
          g.beginPath();
          for (let x = -80; x <= w + 80; x += 16) {
            const yy = y + Math.sin(x / 180 + seconds * .15 + y / 200) * (style.pattern === 'topo' ? 36 : 18);
            if (x === -80) g.moveTo(x, yy); else g.lineTo(x, yy);
          }
          g.stroke();
        }
      } else if (style.pattern !== 'flat') {
        g.beginPath();
        for (let x = -h; x < w + h; x += 96) { g.moveTo(x, 0); g.lineTo(x + (style.pattern === 'stripes' ? h : 0), h); }
        if (style.pattern !== 'stripes') for (let y = 0; y < h; y += 96) { g.moveTo(0, y); g.lineTo(w, y); }
        g.stroke();
      }
      g.restore();
      }
      for (const box of plan(beat).filter(b => b.kind === 'image')) {
        const img = images.get(beat.image);
        if (img) {
          const paint = () => {
            if (beat.treatment === 'none' || box.contain) cover(g, img, box, box.contain);
            else treatment(g, img, box, beat.treatment, beat.image, style);
          };
          if (beat.kind === 'logo' || beat.kind === 'split') windowReveal(g, p * (beat.end - beat.start) / .45, box, paint);
          else paint();
          if (beat.kind === 'split') {
            g.strokeStyle = style.accent; g.lineWidth = 3; g.strokeRect(box.x + 2, box.y + 2, box.w - 4, box.h - 4);
          }
        } else {
          card(g, box.x, box.y, box.w, box.h, style.surface, style.radius, style.surface);
          g.strokeStyle = style.accent; g.lineWidth = 6; g.strokeRect(box.x + 12, box.y + 12, box.w - 24, box.h - 24);
        }
      }
    });
    g.restore();
    if (beat.kind === 'image') scrim(g, w, h, style.bg, .55);
  }
  function treatment(g, img, box, kind, name, style) {
    const cols = Math.ceil(box.w / 9), rows = Math.ceil(box.h / 9), key = `${name}:${cols}:${rows}`;
    if (!samples.has(key)) {
      const c = buffer(doc, cols, rows), cg = c.getContext('2d', { willReadFrequently: true });
      cover(cg, img, { x: 0, y: 0, w: cols, h: rows });
      samples.set(key, cg.getImageData(0, 0, cols, rows).data);
    }
    const data = samples.get(key), cellW = box.w / cols, cellH = box.h / rows;
    g.save(); g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
    g.fillStyle = style.bg; g.fillRect(box.x, box.y, box.w, box.h);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4, lum = (data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722) / 255;
      if (kind === 'halftone') {
        g.fillStyle = style.accent; g.beginPath();
        g.arc(box.x + (x + .5) * cellW, box.y + (y + .5) * cellH, Math.min(cellW, cellH) * .53 * Math.sqrt(1 - lum), 0, Math.PI * 2); g.fill();
      } else {
        g.fillStyle = lum > (BAYER[(y & 3) * 4 + (x & 3)] + .5) / 16 ? style.second : style.accent;
        g.fillRect(box.x + x * cellW, box.y + y * cellH, cellW + .1, cellH + .1);
      }
    }
    g.restore();
  }
  function textState(box, beat, t) {
    const local = revealElapsed(beat, t, beat === project.beats[0]), quarter = 60 / project.bpm;
    const words = box.lines.flatMap(line => line.split(' ')), span = Math.min((beat.end - beat.start) * .48, project.bar * .75);
    const subdivisions = 2 ** Math.max(0, Math.ceil(Math.log2((words.length + box.delay * 2) * quarter / Math.max(.02, span))));
    const step = quarter / subdivisions, delay = box.delay * step * 2;
    return { local, step, delay, length: Math.min(.38, Math.max(.05, (beat.end - beat.start) * .18)), words };
  }
  // Floating numbers over heads: a card with the figure and a short line, popped in at the label's time, drawn by the
  // 2D engine so the type stays sharp and on-look in both renderers.
  const labelInk = '#231b2e', labelCard = '#ffffff';
  function stageLabels(beat, seconds) {
    const pose = poseOf(beat, seconds), out = [];
    for (const label of labelsAt(modelOf(beat), beat, pose, seconds, w, h)) {
      const big = Math.round(Math.min(w, h) * .062), small = Math.round(Math.min(w, h) * .03), pad = big * .32;
      const width = Math.max(measure(label.text, big, 'title'), label.sub ? measure(label.sub, small, 'body') : 0) + pad * 2;
      const height = big * 1.05 + (label.sub ? small * 1.3 : 0) + pad * 1.4;
      const floor = (project.captioned ? band.y : h) - 12;
      const x = clamp(label.x - width / 2, safe.x, safe.x + safe.w - width);
      let y = clamp(label.y - height, safe.y, floor - height);
      for (let pass = 0; pass < out.length; pass++) {
        const hit = out.find(o => x < o.box.x + o.box.w + 8 && o.box.x < x + width + 8 && y < o.box.y + o.box.h + 8 && o.box.y < y + height + 8);
        if (!hit) break;
        y = hit.box.y - height - 10;
      }
      out.push({ ...label, box: { x, y: Math.max(0, y), w: width, h: height }, big, small, pad });
    }
    return out;
  }
  function drawLabels(g, beat, seconds) {
    for (const l of stageLabels(beat, seconds)) {
      const { x, y, w: bw, h: bh } = l.box;
      g.save();
      g.translate(x + bw / 2, y + bh); g.scale(l.k, l.k); g.translate(-(x + bw / 2), -(y + bh));
      g.globalAlpha = clamp(l.k * 1.4);
      card(g, x, y, bw, bh, labelCard, Math.min(28, bh / 3), 'rgba(35, 27, 46, .35)');
      g.beginPath(); g.moveTo(x + bw / 2 - 14, y + bh - 1); g.lineTo(x + bw / 2, y + bh + 16); g.lineTo(x + bw / 2 + 14, y + bh - 1); g.fillStyle = labelCard; g.fill();
      g.fillStyle = labelInk; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      g.font = font(style, l.big, 'title'); g.fillText(l.text, x + bw / 2, y + l.pad * .7 + l.big * .88);
      if (l.sub) { g.font = font(style, l.small, 'body'); g.globalAlpha *= .8; g.fillText(l.sub, x + bw / 2, y + l.pad * .7 + l.big * 1.05 + l.small * 1.05); }
      g.restore();
    }
  }
  function foreground(g, beat, t) {
    const style = styleOf(beat);
    if (beat.kind === 'stage') drawLabels(g, beat, beatElapsed(beat, t));
    if (beat.kind === 'image') {
      g.fillStyle = style.bg; g.fillRect(safe.x, safe.y + safe.h * .50, safe.w, safe.h * .50);
    }
    if (beat.kind === 'quote') {
      const title = plan(beat).find(b => b.role === 'title');
      // The mark is a large accent set against the quote's own size (condensed display fonts draw it small).
      const mark = title ? Math.round((title.size || 120) * 1.8) : 0;
      if (title) drawQuoteMark(g, style, title.x, Math.max(safe.y, title.y - mark * .62), mark);
    }
    let highlighted = false;
    for (const box of plan(beat).filter(b => b.kind === 'text')) {
      const state = textState(box, beat, t);
      if (state.local < state.delay) continue;
      if (beat.kind === 'scene' || beat.kind === 'stage') {
        // A scene's label sits on a card in the look's background, so it reads over any sky.
        const lineW = Math.max(...box.lines.map(line => measure(line, box.size, box.role)));
        const k = expoOut(state.local / state.length), pad = box.size * .28;
        g.save(); g.globalAlpha = .9 * k;
        card(g, box.x - pad + (box.align === 'center' ? (box.w - lineW) / 2 : 0), box.y + (box.h - box.lines.length * box.lineHeight) / 2 - pad * .6,
          lineW + pad * 2, box.lines.length * box.lineHeight + pad * 1.2, style.bg, Math.min(style.radius, 24), style.bg);
        g.restore();
      }
      const ink = readable(box.role === 'number' ? style.accent : box.role === 'body' ? style.dim : style.text, style.bg, style.palette);
      g.save(); g.beginPath(); g.rect(box.x, box.y, box.w, box.h); g.clip();
      g.font = font(style, box.size, box.role); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      const blockH = box.lines.length * box.lineHeight, y0 = box.y + (box.h - blockH) * (box.composition === 'bottom' ? 1 : .5);
      let wordIndex = 0;
      box.lines.forEach((line, row) => {
        let x = box.x + (box.align === 'center' ? (box.w - measure(line, box.size, box.role)) / 2 : 0);
        for (const word of line.split(' ')) {
          const index = wordIndex++, start = state.delay + index * state.step, k = pop(state.local, start, state.length);
          if (state.local < start) { x += measure(word + ' ', box.size, box.role); continue; }
          const y = y0 + row * box.lineHeight + box.size * .88 + box.size * .40 * (1 - k);
          const highlight = !highlighted && box.role !== 'body' && (box.role === 'number' || index === state.words.length - 1);
          if (highlight) highlighted = true;
          g.fillStyle = highlight ? readable(style.accent, style.bg, style.palette) : ink;
          g.globalAlpha = expoOut((state.local - start) / state.length);
          g.fillText(word, x, y);
          x += measure(word + ' ', box.size, box.role);
        }
      });
      g.restore();
      if (box.role !== 'body' && beat.kind !== 'scene' && beat.kind !== 'stage') {
        g.fillStyle = style.rule || style.accent;   // the rule is decoration: a pack's prop colour even where it would not read as text
        const k = expoOut(state.local / state.length);
        g.fillRect(box.x, Math.min(safe.y + safe.h - 8, box.y + box.h + 8), Math.min(box.w * .24, 240) * k, 6);
      }
      if (beat.kind === 'list' && box.role === 'body') {
        const marker = listMarker(box);
        g.fillStyle = style.accent; g.beginPath(); g.arc(marker.x, marker.y, marker.radius * clamp(pop(state.local, state.delay)), 0, Math.PI * 2); g.fill();
      }
    }
  }
  function renderLayer(beat, t, index) {
    const layer = layers[index];
    for (const [kind, c] of Object.entries(layer)) {
      const g = c.getContext('2d'); g.resetTransform(); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none'; g.clearRect(0, 0, w, h);
      g.save();
      if (kind === 'bg') background(g, beat, clamp(beatElapsed(beat, t) / (beat.end - beat.start)));
      else foreground(g, beat, t);
      g.restore();
    }
    return layer;
  }
  function active(t) {
    t = frameTime(project, t);
    const beat = beatAt(project, t);
    // The end-card hold also suppresses any incoming or outgoing transition.
    if (beat.kind === 'end' && t >= Math.max(beat.start, beat.end - 1.5)) return { t, beat, transition: null };
    const tr = transitionAt(project, t);
    // In the Blender overlay pass a stage shot's picture comes from Blender underneath, so its transitions are cuts.
    if (tr && overlay && (project.beats[tr.from].kind === 'stage' || project.beats[tr.to].kind === 'stage')) return { t, beat, transition: null };
    return { t, beat, transition: tr };
  }
  function composite(layer, tr, incoming, foregroundOnly = false) {
    const tf = transitionTransform(tr.kind, tr.p, incoming, w, h), k = inOut(tr.p);
    if (tr.kind === 'flip' && incoming !== (tr.p >= .5)) return;
    ctx.save();
    if (foregroundOnly) { ctx.beginPath(); ctx.rect(safe.x, safe.y, safe.w, safe.h); ctx.clip(); }
    if (incoming && ['dither', 'mosaic', 'wipe'].includes(tr.kind)) {
      ctx.beginPath();
      if (tr.kind === 'wipe') ctx.rect(0, 0, w * k, h);
      else {
        const cell = tr.kind === 'mosaic' ? 120 : 12;
        for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
          const threshold = tr.kind === 'mosaic' ? hash(`${x}:${y}`) / 4294967296 : (BAYER[((y / cell) & 3) * 4 + ((x / cell) & 3)] + .5) / 16;
          if (tr.p > threshold) ctx.rect(x, y, cell, cell);
        }
      }
      ctx.clip();
    }
    if (tr.kind === 'whip') ctx.filter = `blur(${18 * Math.sin(Math.PI * tr.p)}px)`;
    if (tr.kind === 'zoom') ctx.globalAlpha = incoming ? k : 1 - k;
    ctx.translate(w / 2 + tf.dx, h / 2 + tf.dy); ctx.scale(tf.sx, tf.sy); ctx.translate(-w / 2, -h / 2);
    if (tr.kind === 'flip') {
      // Project a yawed card in strips: its far edge recedes vertically as well
      // as horizontally. The cosine squeeze alone would look like a flat wipe.
      const strips = 96, stripW = w / strips, yaw = Math.sin(Math.PI * tr.p);
      for (let i = 0; i < strips; i++) {
        const u = (i + .5) / strips, depth = incoming ? 1 - u : u;
        const projectedH = h / (1 + .28 * yaw * depth);
        ctx.drawImage(layer, i * stripW, 0, stripW, h, i * stripW, (h - projectedH) / 2, stripW + .4, projectedH);
      }
    } else ctx.drawImage(layer, 0, 0);
    // Deterministic motion trails; avoid filter-blurred copy and keep boxes exact.
    if (tr.kind === 'whip' && !foregroundOnly) {
      ctx.globalAlpha = .09 * Math.sin(Math.PI * tr.p);
      for (let i = 1; i <= 3; i++) ctx.drawImage(layer, i * 18, 0);
    }
    ctx.restore();
  }
  // Captions burn in from the script's measured parts, in a band below the beat's copy, over every transition.
  const band = captionBand(aspect), captionFits = new Map();
  const [capMin, capMax] = aspect === '16:9' ? [44, 62] : [46, 64], capPad = 20;
  const upper = project.pack?.captionCase === 'upper';
  function caption(t) {
    let part = project.captioned ? captionAt(project, t) : null;
    if (!part) return null;
    if (upper) part = { ...part, text: part.text.toUpperCase() };
    if (!captionFits.has(part.text)) captionFits.set(part.text, fitText(part.text, { w: band.w - capPad * 2, h: band.h - capPad * 2 }, { min: capMin, max: capMax, measure: (v, size) => measure(v, size, 'body') }));
    const fit = captionFits.get(part.text), lineW = Math.max(...fit.lines.map(line => measure(line, fit.size, 'body')));
    const boxW = Math.min(band.w, lineW + capPad * 2), boxH = fit.lines.length * fit.lineHeight + capPad * 2;
    return { part, fit, x: band.x + (band.w - boxW) / 2, y: band.y + (band.h - boxH) / 2, w: boxW, h: boxH,
      color: readable(style.text, style.bg, style.palette) };
  }
  function drawCaption(t) {
    const c = caption(t);
    if (!c) return;
    ctx.save(); ctx.globalAlpha = .9; card(ctx, c.x, c.y, c.w, c.h, style.bg, Math.min(style.radius, 24), style.bg); ctx.globalAlpha = 1;
    ctx.font = font(style, c.fit.size, 'body'); ctx.fillStyle = c.color; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    c.fit.lines.forEach((line, row) => ctx.fillText(line, c.x + c.w / 2, c.y + capPad + row * c.fit.lineHeight + c.fit.size * .88));
    ctx.restore();
  }
  function drawFrame(time) {
    if (!loaded) throw new Error('Await mount.ready before drawing');
    const { t, beat, transition: tr } = active(time);
    ctx.resetTransform(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    if (overlay) ctx.clearRect(0, 0, w, h);
    else { ctx.fillStyle = style.bg; ctx.fillRect(0, 0, w, h); }
    if (!tr) {
      const layer = renderLayer(beat, t, 0); ctx.drawImage(layer.bg, 0, 0); ctx.drawImage(layer.fg, 0, 0); drawCaption(t); return;
    }
    const a = renderLayer(project.beats[tr.from], t, 0), b = renderLayer(project.beats[tr.to], t, 1);
    // Paint scene pairs in order so an incoming background covers outgoing copy.
    for (const [layer, incoming] of [[a, false], [b, true]]) {
      composite(layer.bg, tr, incoming); composite(layer.fg, tr, incoming, true);
    }
    if (tr.kind === 'wipe') {
      ctx.fillStyle = style.accent; ctx.fillRect(w * inOut(tr.p) - 10, 0, 20, h);
    }
    drawCaption(t);
  }
  function layout(time) {
    if (!loaded) throw new Error('Await mount.ready before requesting layout');
    const { t, beat, transition: tr } = active(time), result = [];
    const candidates = tr ? [[project.beats[tr.from], false], [project.beats[tr.to], true]] : [[beat, true]];
    for (const [b, incoming] of candidates) {
      if (tr?.kind === 'flip' && incoming !== (tr.p >= .5)) continue;
      if (tr?.kind === 'zoom' && (incoming ? inOut(tr.p) === 0 : inOut(tr.p) === 1)) continue;
      const transform = tr ? transitionTransform(tr.kind, tr.p, incoming, w, h) : { sx: 1, sy: 1, dx: 0, dy: 0 };
      for (const box of plan(b)) {
        const state = box.kind === 'text' ? textState(box, b, t) : null;
        if (state && state.local <= state.delay) continue;
        const clip = box.kind === 'text' ? safe : { x: 0, y: 0, w, h };
        const camera = cameraAt(b.camera, clamp(beatElapsed(b, t) / (b.end - b.start)), hash(b.id) % 100);
        const tf = box.kind === 'image' ? { sx: transform.sx * camera.scale, sy: transform.sy * camera.scale,
          dx: transform.dx + camera.dx * w * transform.sx, dy: transform.dy + camera.dy * h * transform.sy } : transform;
        const visible = visibleBox(box, tf, clip, w, h);
        if (!visible) continue;
        const { lines, lineHeight, delay, role, contain, image, ...publicBox } = visible;
        if (box.kind === 'text') {
          const s = styleOf(b);
          publicBox.role = role; publicBox.fontSize = box.size;
          publicBox.text = state.words.filter((_, i) => state.local > state.delay + i * state.step).join(' ');
          publicBox.color = readable(role === 'number' ? s.accent : role === 'body' ? s.dim : s.text, s.bg, s.palette);
          // A pack card reports the lightest sky its copy can sit on (sky gradient and glow), so the check is honest.
          publicBox.bg = s.reportBg || s.bg;
          publicBox.highlightColor = readable(s.accent, s.bg, s.palette);
        }
        result.push(publicBox);
      }
      // A stage shot's cast, projected from the 3D pose, and its floating labels as text.
      if (b.kind === 'stage' && !tr) {
        const seconds = beatElapsed(b, t), pose = poseOf(b, seconds), model = modelOf(b);
        for (const box of actorBoxes(model, b, pose, w, h)) {
          if (box.kind !== 'character') continue;
          const member = b.stage.cast[Number(box.key.slice(1))];
          result.push({ beat: b.id, kind: 'character', stage: true, character: box.character, shot: b.stage.shot, x: box.x, y: box.y, w: box.w, h: box.h,
            height: box.height, short: Math.min(w, h), body: box.body, head: box.head, expression: member?.expression, action: member?.action });
        }
        for (const l of stageLabels(b, seconds)) {
          if (l.k < .05) continue;
          result.push({ beat: b.id, kind: 'text', role: 'label', text: [l.text, l.sub].filter(Boolean).join(' '), fontSize: l.small || l.big,
            x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h, color: labelInk, bg: labelCard });
        }
      }
      // A scene's cast and props, in frame pixels, for the sheet-match checks (only outside transitions).
      if (b.kind === 'scene' && !tr) {
        const p = clamp(beatElapsed(b, t) / (b.end - b.start));
        result.push(...sceneBoxes(b, project, w, h, groundLine(h, band, project.captioned), p * (b.end - b.start), p));
      }
    }
    const c = caption(t);
    if (c) result.push({ beat: c.part.beat, kind: 'text', role: 'caption', text: c.part.text, fontSize: c.fit.size, x: c.x, y: c.y, w: c.w, h: c.h,
      color: c.color, bg: style.bg, truncated: c.fit.truncated });
    return result;
  }
  // The 3D pose at a time, for the Blender renderer: the stage shot on screen with every transform and the camera, or null.
  function pose(time) {
    if (!loaded) throw new Error('Await mount.ready before requesting a pose');
    const { t, beat } = active(time);
    if (beat.kind !== 'stage') return null;
    const p = poseOf(beat, beatElapsed(beat, t));
    return { beat: beat.id, camera: p.camera, groups: p.groups };
  }
  const stageModels = () => Object.fromEntries(project.beats.filter(b => b.kind === 'stage').map(b => [b.id, modelOf(b)]));
  return { ready, duration: project.duration, drawFrame, layout, pose, stageModels, stageInfo: () => stage3d && { ...stage3d.info, lost: stage3d.lost },
    info: { duration: project.duration, fps: 30, width: w, height: h, aspect, layer: overlay ? 'overlay' : 'full',
      renderer: hasStage ? (overlay ? 'blender' : 'threejs') : '2d-engine', beats: project.beats.map(({ id, start, end }) => ({ id, start, end })) } };
}

// A module import for Studio does not mount anything unless the player marker exists.
const projectElement = typeof document !== 'undefined' && document.getElementById('kd-project');
if (projectElement && document.getElementById('kd-canvas')) {
  try {
    const params = new URLSearchParams(location.search);
    const m = mount(document.getElementById('kd-canvas'), JSON.parse(projectElement.textContent), { aspect: params.get('aspect') || undefined,
      layer: params.get('layer') === 'overlay' ? 'overlay' : 'full' });
    window.kdInfo = m.info; window.kdDrawFrame = m.drawFrame; window.kdLayout = m.layout; window.kdReady = m.ready;
    window.kdPose = m.pose; window.kdStageModels = m.stageModels; window.kdStageInfo = m.stageInfo;
    if (params.has('play')) m.ready.then(() => preview(m));
  } catch (error) { window.kdReady = Promise.reject(error); }
}
function preview(m) {
  const controls = document.getElementById('kd-controls'), toggle = document.getElementById('kd-toggle'), scrub = document.getElementById('kd-scrub'), output = document.getElementById('kd-time');
  if (!controls) return;
  controls.hidden = false; scrub.max = m.duration;
  let playing = true, position = 0, anchor;
  const current = now => playing ? (position + (now - anchor) / 1000) % m.duration : position;
  toggle.onclick = () => { const now = performance.now(); position = current(now); anchor = now; playing = !playing; toggle.textContent = playing ? 'Pause' : 'Play'; };
  scrub.oninput = () => { position = Number(scrub.value); anchor = performance.now(); playing = false; toggle.textContent = 'Play'; };
  function tick(now) {
    anchor ??= now; const t = current(now); m.drawFrame(t); scrub.value = t; output.textContent = `${t.toFixed(2)} / ${m.duration.toFixed(2)} s`; requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
