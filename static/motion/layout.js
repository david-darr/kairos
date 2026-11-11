import { clamp, range, inOut, hash } from './kit.js';
import { normalizeStage } from './stage.js';
import { normalizeVoxel } from './voxel.js';
import { normalizeStory, balanceCoverage } from './classic.js';

export const SIZES = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
export const KINDS = ['title', 'statement', 'big-number', 'list', 'image', 'quote', 'split', 'logo', 'end', 'scene', 'stage', 'voxel', 'story'];
export const CAMERAS = ['still', 'push', 'pull', 'pan', 'shake'];
export const TRANSITIONS = ['cut', 'whip', 'zoom', 'flip', 'dither', 'mosaic', 'wipe'];
export const LIMITS = { beats: 100, text: 180, sub: 160, number: 24, item: 100, items: 5, minBpm: 40, maxBpm: 240, minBars: .25, maxBars: 16 };
const str = (v, n) => typeof v === 'string' || typeof v === 'number' ? Array.from(String(v).replace(/\s+/gu, ' ').trim()).slice(0, n).join('') : '';
const finite = (v, fallback) => Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback;
// Names stay relative to the project's assets directory, never remote URLs.
export function assetName(value) {
  if (typeof value !== 'string') return '';
  const name = value.replace(/^assets\//, '');
  return /^[\w.-]{1,180}$/u.test(name) && !name.includes('..') ? name : '';
}
// Caption styles (step 7): the whole line, or the line with its current word in the accent colour (highlight) or on an
// accent box (box). A word style needs the line's words aligned (core/video_align.py); a line without them keeps line captions.
export const CAPTION_STYLES = ['line', 'highlight', 'box'];
// The caption's words: the part's text split on spaces, counting only pieces with a letter or digit (as the server does).
export const isWord = piece => /[\p{L}\p{N}_]/u.test(piece);
function attachWords(captions, words, start) {
  if (!Array.isArray(words)) return;
  const count = captions.reduce((n, c) => n + c.text.split(' ').filter(isWord).length, 0);
  if (words.length !== count || !words.every(w => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))) return;
  let k = 0;
  for (const c of captions) {
    const n = c.text.split(' ').filter(isWord).length;
    c.words = words.slice(k, k + n).map(([a, b]) => ({ start: start + a, end: start + b }));
    k += n;
  }
}
export function normalizeProject(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const bpm = clamp(finite(input.bpm, 120), LIMITS.minBpm, LIMITS.maxBpm), bar = 240 / bpm;
  let start = 0;
  const ids = new Set(), captionsOn = input.narration?.captions !== false;
  const captionStyle = CAPTION_STYLES.includes(input.narration?.caption_style) ? input.narration.caption_style : 'line', wordStyle = captionStyle !== 'line';
  const raw = Array.isArray(input.beats) && input.beats.length ? input.beats : [{ kind: 'end', text: input.title || 'Untitled', bars: 1 }];
  const beats = raw.slice(0, LIMITS.beats).map((value, i) => {
    const b = value && typeof value === 'object' ? value : {};
    let id = str(b.id, 64) || `b${i + 1}`;
    while (ids.has(id)) id += `-${i + 1}`;
    ids.add(id);
    // A narrated beat's length is its measured line (the server derives `seconds`); other beats keep bars.
    const bars = clamp(finite(b.bars, 1), LIMITS.minBars, LIMITS.maxBars);
    const seconds = Number.isFinite(b.seconds) && b.seconds > 0 ? clamp(b.seconds, .25, 120) : bars * bar, end = start + seconds;
    // A big-number with no number would draw "0": it becomes a statement instead.
    const kind = KINDS.includes(b.kind) && !(b.kind === 'big-number' && !str(b.number, LIMITS.number)) ? b.kind : 'statement';
    const result = { id, kind, bars, start, end,
      text: str(b.text, LIMITS.text), sub: str(b.sub, LIMITS.sub), number: str(b.number, LIMITS.number),
      items: (Array.isArray(b.items) ? b.items : []).slice(0, 5).map(v => str(v, LIMITS.item)).filter(Boolean),
      image: assetName(b.image), camera: CAMERAS.includes(b.camera) ? b.camera : 'still',
      transition: TRANSITIONS.includes(b.transition) ? b.transition : 'cut',
      treatment: ['halftone', 'dither'].includes(b.treatment) ? b.treatment : 'none',
      captions: captionsOn && Array.isArray(b.spoken?.parts) ? b.spoken.parts.filter(part => Array.isArray(part) && Number.isFinite(part[0]) && Number.isFinite(part[1]) && part[1] > part[0])
        .map(([from, to, text]) => ({ start: start + from, end: start + to, text: str(text, 160) })).filter(c => c.text) : [] };
    // Word captions (step 7): each part's words with their aligned times, when the line was aligned with confidence.
    if (result.captions.length && wordStyle) attachWords(result.captions, b.spoken?.words, start);
    // A Pack A scene keeps its setting, shot, cast and props, and the mouth shapes measured from its line.
    if (kind === 'scene' || kind === 'stage' || kind === 'voxel') {
      if (kind === 'scene') result.scene = normalizeScene(b.scene);
      else if (kind === 'stage') result.stage = normalizeStage(b.stage);   // Pack B: a 3D studio shot (stage.js)
      else result.voxel = normalizeVoxel(b.voxel);   // Pack C: a blocky voxel world shot (voxel.js)
      result.mouth = typeof b.spoken?.mouth === 'string' && /^[XAEOMF]{1,2000}$/.test(b.spoken.mouth) ? b.spoken.mouth : '';
    }
    // A Story Short shot (Pack C classic, static/motion/classic.js and story.js): its scene, who speaks the line, the
    // line's words with their aligned times (always word by word in this format), the flashback flag and the mouth.
    if (kind === 'story') {
      result.story = normalizeStory(b.story);
      result.say = str(b.say, 400); result.speaker = str(b.speaker, 12); result.flashback = b.flashback === true;
      result.mouth = typeof b.spoken?.mouth === 'string' && /^[XAEOMF]{1,2000}$/.test(b.spoken.mouth) ? b.spoken.mouth : '';
      result.lead = Number.isFinite(b.spoken?.lead) ? b.spoken.lead : .06;
      result.speech = Number.isFinite(b.spoken?.seconds) ? b.spoken.seconds : 0;
      result.speechEnd = result.lead + result.speech;
      result.words = Array.isArray(b.spoken?.words) ? b.spoken.words.filter(w => Array.isArray(w) && Number.isFinite(w[0])).map(([a, z]) => ({ start: start + a, end: start + z })) : [];
    }
    start = end; return result;
  });
  // Story Shorts vary their coverage: too many closes of one character play partly as two-shots (classic.js).
  balanceCoverage(beats);
  const characters = input.characters && typeof input.characters === 'object' ? input.characters : {};
  return { id: str(input.id, 64), title: str(input.title, 180), look: str(input.look, 64), bpm, bar, fps: input.fps === 60 ? 60 : 30, captionStyle, renderer: input.renderer === 'blender' ? 'blender' : 'threejs',
    palette: str(input.palette, 24) || 'dawn', characters, pack: normalizePack(input.pack),
    aspects: (Array.isArray(input.aspects) ? input.aspects : ['16:9']).filter(a => SIZES[a]), beats, duration: start,
    captioned: beats.some(b => b.captions.length) };
}
const ONE = (v, list, fallback) => list.includes(v) ? v : fallback;
const HEX = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
// A user-made style pack's look as the player receives it (core/style_pack_store.render_look): colours and names only.
export function normalizePack(input) {
  if (!input || typeof input !== 'object') return null;
  const raw = input.palette && typeof input.palette === 'object' ? input.palette : null;
  const layers = ['far', 'mid', 'near', 'ground', 'prop', 'ink', 'glow'];
  const palette = raw && Array.isArray(raw.sky) && raw.sky.length === 2 && raw.sky.every(HEX) && layers.every(k => HEX(raw[k]))
    ? { sky: [...raw.sky], ...Object.fromEntries(layers.map(k => [k, raw[k]])) } : null;
  return { palette, lighting: ONE(input.lighting, ['flat', 'soft', 'glow'], 'soft'), captionCase: input.caption_case === 'upper' ? 'upper' : 'sentence' };
}
const unit = (v, fallback) => clamp(finite(v, fallback), 0, 1);
// Defensive copy of a scene beat (the backend validates it; core/video_store.py _scene).
export function normalizeScene(input) {
  const s = input && typeof input === 'object' ? input : {};
  return { setting: ONE(s.setting, ['meadow', 'city', 'space', 'room', 'ocean', 'lab'], 'meadow'), shot: ONE(s.shot, ['wide', 'medium', 'close'], 'medium'),
    cast: (Array.isArray(s.cast) ? s.cast : []).slice(0, 3).filter(m => m && typeof m.character === 'string').map((m, i, all) => ({
      character: m.character.slice(0, 12), x: unit(m.x, (i + 1) / (all.length + 1)),
      view: ONE(m.view, ['front', 'three_quarter', 'side', 'back'], 'front'), turn: ONE(m.turn, ['front', 'three_quarter', 'side', 'back'], undefined),
      expression: ONE(m.expression, ['neutral', 'happy', 'surprised', 'worried', 'thinking'], 'neutral'),
      action: ONE(m.action, ['idle', 'wave', 'point', 'walk', 'jump', 'shrug', 'think', 'nod'], 'idle'), speaking: m.speaking === true,
      facing: m.facing === 'left' ? 'left' : 'right' })),
    props: (Array.isArray(s.props) ? s.props : []).slice(0, 6).filter(v => v && typeof v.icon === 'string').map(v => ({
      icon: str(v.icon, 20), x: unit(v.x, .5), y: unit(v.y, .3), size: clamp(finite(v.size, .1), .03, .35), float: v.float === true })) };
}
export function dimensions(aspect) {
  const [width, height] = SIZES[aspect] || SIZES['16:9']; return { width, height, aspect: SIZES[aspect] ? aspect : '16:9' };
}
// A captioned (narrated) video keeps a band at the bottom for its captions; the beat's own copy stays above it.
export function safeArea(aspect, captioned = false) {
  const { width: w, height: h } = dimensions(aspect), portrait = aspect === '9:16';
  if (captioned) return { x: w * .05, y: h * (portrait ? .13 : .05), w: w * .9, h: h * (portrait ? .56 : aspect === '1:1' ? .70 : .73) };
  return { x: w * .05, y: h * (portrait ? .13 : .05), w: w * .9, h: h * (portrait ? .70 : .90) };
}
export function captionBand(aspect) {
  const { width: w, height: h } = dimensions(aspect), portrait = aspect === '9:16';
  return portrait ? { x: w * .05, y: h * .70, w: w * .9, h: h * .13 } : { x: w * .05, y: h * (aspect === '1:1' ? .77 : .80), w: w * .9, h: h * (aspect === '1:1' ? .18 : .15) };
}
// The caption on screen at t: a part shows from its start until a moment after it ends, or until the next part.
export function captionAt(project, t) {
  const all = project.beats.flatMap(b => b.captions.map(c => ({ ...c, beat: b.id })));
  for (let i = 0; i < all.length; i++) {
    const until = Math.min(all[i].end + .3, all[i + 1]?.start ?? Infinity);
    if (t >= all[i].start && t < until) return all[i];
  }
  return null;
}
export const frameTime = (project, t) => clamp(Number.isFinite(t) ? t : 0, 0, project.duration);
export function beatAt(project, t) {
  t = frameTime(project, t);
  return project.beats.find(b => t < b.end) || project.beats.at(-1);
}
export function transitionWindows(project) {
  return project.beats.slice(0, -1).map((b, i) => ({ kind: b.transition, from: i, to: i + 1,
    start: b.end - .175, end: b.end + .175, cut: b.end })).filter(w => w.kind !== 'cut');
}
export function transitionAt(project, t) {
  const w = transitionWindows(project).find(w => t >= w.start && t < w.end);
  return w ? { ...w, p: range(t, w.start, w.end) } : null;
}
// Camera transforms only backgrounds/photos; copy always occupies its safe-area grid.
export function cameraAt(camera, p, seed = 0) {
  const k = inOut(p), wave = Math.sin(p * Math.PI);
  return { scale: camera === 'push' ? 1 + .075 * k : camera === 'pull' ? 1.075 - .075 * k : camera === 'pan' || camera === 'shake' ? 1.04 : 1,
    dx: camera === 'pan' ? (k - .5) * .035 : camera === 'shake' ? Math.sin(p * 61 + seed) * .002 * wave : 0,
    dy: camera === 'shake' ? Math.cos(p * 79 + seed) * .002 * wave : 0 };
}
export function beatElapsed(beat, t) {
  const duration = beat.end - beat.start, local = clamp(t - beat.start, 0, duration);
  if (beat.kind !== 'end') return local;
  const moving = Math.max(0, duration - 1.5);
  return moving === 0 ? duration : Math.min(local, moving) * duration / moving;
}

// Greedy wrapping followed by adjacent-line balancing. Split unbroken words by codepoint.
// Words stay whole unless `split` is set: the fitter shrinks the type first and splits a word only when it
// cannot fit even at the minimum size (a Studio preview broke "opening" into "openin / g").
export function wrapText(text, size, width, measure, split = false) {
  const words = [];
  for (const word of text.split(/\s+/u).filter(Boolean)) {
    if (!split) { words.push(word); continue; }
    let chunk = '';
    for (const char of word) {
      if (chunk && measure(chunk + char, size) > width) { words.push(chunk); chunk = ''; }
      chunk += char;
    }
    if (chunk) words.push(chunk);
  }
  const lines = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && measure(last + ' ' + word, size) <= width) lines[lines.length - 1] += ' ' + word;
    else lines.push(word);
  }
  for (let pass = 0; pass < 4; pass++) for (let i = lines.length - 2; i >= 0; i--) {
    const parts = lines[i].split(' '), word = parts.at(-1);
    if (parts.length < 2) continue;
    const a = parts.slice(0, -1).join(' '), b = word + ' ' + lines[i + 1];
    if (measure(b, size) <= width && Math.abs(measure(a, size) - measure(b, size)) < Math.abs(measure(lines[i], size) - measure(lines[i + 1], size))) {
      lines[i] = a; lines[i + 1] = b;
    }
  }
  return lines;
}
export function fitText(text, box, { min = 40, max = 140, measure } = {}) {
  measure ||= (s, size) => Array.from(s).length * size * .55;
  let split = false;
  const fits = (size, value = text) => { const lines = wrapText(value, size, box.w, measure, split); return lines.length * size * 1.14 <= box.h + 1e-6 && lines.every(l => measure(l, size) <= box.w); };
  if (!fits(min)) split = true;  // A word too long for the box even at the minimum: only now break it.
  let lo = min, hi = Math.max(min, max);
  for (let i = 0; i < 14; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  const size = Math.floor(lo * 100) / 100;
  let value = text, truncated = false;
  if (!fits(size)) {
    const chars = Array.from(text);
    while (chars.length && !fits(size, chars.join('') + '...')) chars.pop();
    value = chars.join('').trimEnd() + '...'; truncated = true;
  }
  return { text: value, lines: wrapText(value, size, box.w, measure, split), size, lineHeight: size * 1.14, truncated };
}

// Choose balanced word boundaries at the target size before considering shrinkage.
export function fitStatement(text, box, { min, max, measure }) {
  const balance = (value, size, count) => {
    const words = value.split(/\s+/u).filter(Boolean), memo = new Map();
    const solve = (start, remaining) => {
      if (!remaining) return start === words.length ? { cost: 0, lines: [] } : null;
      const key = `${start}:${remaining}`;
      if (memo.has(key)) return memo.get(key);
      let best = null;
      for (let end = start + 1; end <= words.length - remaining + 1; end++) {
        const line = words.slice(start, end).join(' '), width = measure(line, size);
        if (width > box.w) break;
        const tail = solve(end, remaining - 1);
        if (tail && (!best || width * width + tail.cost < best.cost)) best = { cost: width * width + tail.cost, lines: [line, ...tail.lines] };
      }
      memo.set(key, best); return best;
    };
    return solve(0, count)?.lines;
  };
  for (let size = max; size >= min; size--) for (const count of [2, 3]) {
    if (count * size * 1.14 > box.h) continue;
    const lines = balance(text, size, count);
    if (lines) return { text, lines, size, lineHeight: size * 1.14, truncated: false };
  }
  const fit = fitText(text, { ...box, h: Math.min(box.h, min * 1.14 * 3) }, { min, max: min, measure });
  fit.lines = balance(fit.text, min, Math.min(3, fit.lines.length)) || fit.lines;
  return fit;
}
// Marker and first-line cap centre share the same origin as the row's text.
export function listMarker(box) {
  const y0 = box.y + (box.h - box.lines.length * box.lineHeight) * (box.composition === 'bottom' ? 1 : .5);
  // The marker grows with the row, so a large list keeps its proportions.
  const grow = Math.max(1, box.size / 90);
  return { x: box.x - 24 * grow, y: y0 + box.size * .52, radius: 7 * grow };
}

// Display sizes account for a conservative .72em cap height. All aspects have S=1080.
export const TYPE = {
  title: [210, 270], statement: [150, 195], 'big-number': [525, 750],
  list: [135, 165], quote: [135, 180], end: [180, 240],
  image: [135, 180], split: [135, 180], logo: [150, 195], scene: [56, 104], stage: [56, 104], voxel: [56, 104], story: [56, 104]
};
export function compositionAt(beats, index) {
  let previous = -1;
  for (let i = 0; i <= index; i++) {
    const choices = [0, 1, 2].filter(n => n !== previous);
    previous = choices[hash(`${i}:${beats[i].kind}:${beats[i].id}`) % choices.length];
  }
  return ['left', 'center', 'bottom'][previous];
}
// Shared with layout reporting: frame zero already contains the first headline.
export function revealElapsed(beat, t, first = false) {
  return beatElapsed(beat, t) + (first ? beat.camera === 'still' ? beat.end - beat.start : .28 : 0);
}
export function beatLayout(beat, aspect, measure, style = {}) {
  const s = safeArea(aspect, style.captioned), portrait = aspect === '9:16', boxes = [];
  const composition = style.composition || compositionAt([beat], 0);
  const align = composition === 'center' ? 'center' : 'left';
  const add = (text, x, y, w, h, role = 'title', delay = 0, bounds) => {
    if (!text) return;
    const box = { x: s.x + x * s.w, y: s.y + y * s.h, w: w * s.w, h: h * s.h };
    const source = style.upper && role !== 'body' ? text.toUpperCase() : text;
    const [min, max] = bounds || (role === 'body' ? [45.36, 60] : TYPE[beat.kind]);
    const fitter = beat.kind === 'statement' && role === 'title' ? fitStatement : fitText;
    let fit = fitter(source, box, { min, max, measure: (v, size) => measure(v, size, role) });
    // A short figure or heading that cannot fit at the kind's smallest size is set smaller rather than cut off
    // with "..." (a narrated 9:16 sample cut "500 t" to "5..." and a list heading mid-word, 2026-11-10). Long copy
    // keeps the size floor; video_checks names any text still cut off.
    if (fit.truncated && (role === 'number' || source.split(/\s+/u).length <= 4)) {
      const smaller = fitText(source, box, { min: Math.round(min * (role === 'number' ? .35 : .6)), max: min, measure: (v, size) => measure(v, size, role) });
      if (!smaller.truncated) fit = smaller;
    }
    // Avoid a larger font wrapping into two narrow lines when a slightly
    // smaller, still in-range setting can occupy the intended headline width.
    if (beat.kind !== 'statement' && role === 'title' && box.w >= s.w * .60 && Math.max(...fit.lines.map(v => measure(v, fit.size, role))) < s.w * .60) {
      for (let size = max; size >= min; size -= 1) {
        const candidate = fitText(source, box, { min: size, max: size, measure: (v, n) => measure(v, n, role) });
        if (!candidate.truncated && Math.max(...candidate.lines.map(v => measure(v, size, role))) >= s.w * .60) { fit = candidate; break; }
      }
    }
    boxes.push({ beat: beat.id, kind: 'text', ...box, ...fit, role, delay, align, composition, minSize: min, capHeight: fit.size * .72 });
  };
  const image = (x, y, w, h, contain = false) => boxes.push({ beat: beat.id, kind: 'image', image: beat.image, x, y, w, h, contain, composition });
  const { width, height } = dimensions(aspect);
  const x = composition === 'center' ? .075 : 0, widthFraction = composition === 'center' ? .85 : .92;
  const top = composition === 'bottom' ? .25 : composition === 'center' ? .13 : .04;
  switch (beat.kind) {
    case 'big-number':
      if (aspect === '16:9') {
        add(beat.number || '0', 0, .12, .64, .74, 'number', 0, TYPE['big-number']);
        add(beat.text, .67, .35, .33, .48, 'body', 1, [54, 86]);
      } else {
        add(beat.number || '0', 0, .06, 1, .62, 'number', 0, TYPE['big-number']);
        add(beat.text, x, .73, widthFraction, .24, 'body', 1, [54, 86]);
      } break;
    case 'list': {
      const titled = !!beat.text;
      add(beat.text, x, 0, widthFraction, .26);
      // Without a heading the rows take the whole frame; few rows set large so they carry it (2026-11-05 pass:
      // two untitled rows sat small in the upper left of an empty frame).
      const count = Math.max(1, beat.items.length), start = titled ? .29 : .08, step = (titled ? .70 : .88) / count;
      // Four or five rows also have room to set larger than body text (Studio click-through: four untitled rows filled a third of the frame).
      const bounds = count <= 3 ? (titled ? [72, 120] : [96, 150]) : count <= 5 ? (titled ? [59.4, 96] : [72, 120]) : [59.4, 86];
      // Fit all rows at one size, so the list reads as one typographic object.
      beat.items.forEach((v, i) => add(v, x + .055, start + i * step, widthFraction - .055, step * .91, 'body', i + 1, bounds));
      const rows = boxes.filter(b => b.role === 'body');
      let size = Math.min(...rows.map(b => b.size));
      // A row reads best on one line: take the largest in-range size at which every row fits whole, if there is one.
      for (let n = bounds[1]; n >= bounds[0]; n -= 1) {
        if (rows.every(row => measure(row.text, n, 'body') <= row.w)) { size = n; break; }
      }
      for (const row of rows) Object.assign(row, { align: 'left' }, fitText(row.text, row, { min: size, max: size, measure: (v, n) => measure(v, n, 'body') }), { capHeight: size * .72 });
      break;
    }
    case 'image':
      image(0, 0, width, height); add(beat.text, .025, .52, .95, .32); add(beat.sub, .025, .86, .95, .13, 'body', 1); break;
    case 'split':
      if (portrait) {
        image(s.x, s.y, s.w, s.h * .40); add(beat.text, 0, .44, 1, .37); add(beat.sub, 0, .84, 1, .16, 'body', 1);
      } else {
        image(s.x + s.w * .56, s.y, s.w * .44, s.h); add(beat.text, 0, .06, .52, .65); add(beat.sub, 0, .76, .52, .24, 'body', 1);
      } break;
    case 'logo':
      image(s.x + s.w * .25, s.y, s.w * .5, s.h * .37, true);
      add(beat.text, x, .42, widthFraction, .40); add(beat.sub, x, .86, widthFraction, .14, 'body', 1); break;
    case 'quote':
      add(beat.text, x, top + .06, widthFraction, .54); add(beat.sub, x, top + .64, widthFraction, .11, 'body', 1); break;
    case 'scene':
    case 'stage':
    case 'voxel':
    case 'story':
      // The scene carries the shot; its words are a short label across the top, clear of the cast.
      add(beat.text, .03, 0, .94, portrait ? .1 : .15, 'title', 0, TYPE.scene);
      for (const box of boxes) Object.assign(box, { align: 'center', composition: 'center' });
      break;
    default:
      if (beat.kind === 'title') {
        const titleTop = composition === 'bottom' ? .09 : composition === 'center' ? .045 : 0;
        add(beat.text, x, titleTop, widthFraction, .78);
        add(beat.sub, x, titleTop + .81, widthFraction, .10, 'body', 1);
        break;
      }
      if (beat.kind === 'end') {
        const endTop = composition === 'bottom' ? .08 : composition === 'center' ? .04 : 0;
        add(beat.text, x, endTop, widthFraction, .74);
        add(beat.sub, x, endTop + .78, widthFraction, .14, 'body', 1, [59.4, 75]);
        break;
      }
      add(beat.text, x, top, widthFraction, .60);
      add(beat.sub, x, top + .64, widthFraction, .11, 'body', 1, beat.kind === 'end' ? [59.4, 75] : undefined);
  }
  return boxes;
}

// Foreground transform shared by drawing and layout reporting.
export function transitionTransform(kind, p, incoming, width, height) {
  const k = inOut(p), v = incoming ? k - 1 : k;
  if (kind === 'whip') return { sx: 1, sy: 1, dx: -v * width, dy: 0 };
  if (kind === 'zoom') return { sx: incoming ? .55 + .45 * k : 1 + 1.8 * k, sy: incoming ? .55 + .45 * k : 1 + 1.8 * k, dx: 0, dy: 0 };
  if (kind === 'flip') return { sx: Math.abs(Math.cos(Math.PI * p)), sy: 1, dx: 0, dy: 0 };
  return { sx: 1, sy: 1, dx: 0, dy: 0 };
}
export function visibleBox(box, transform, clip, width, height) {
  const x = width / 2 + (box.x - width / 2) * transform.sx + transform.dx;
  const y = height / 2 + (box.y - height / 2) * transform.sy + transform.dy;
  const left = Math.max(x, clip.x), top = Math.max(y, clip.y);
  const right = Math.min(x + box.w * transform.sx, clip.x + clip.w), bottom = Math.min(y + box.h * transform.sy, clip.y + clip.h);
  return right > left && bottom > top ? { ...box, x: left, y: top, w: right - left, h: bottom - top, size: box.size && box.size * transform.sy } : null;
}
