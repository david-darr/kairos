// Pure logic for Studio's video editor (no DOM): beat timing on the timeline, timecodes, frame steps, zoom and ruler
// maths, snapping, trimming in half bars, shuttle speeds, the keyboard table and the remembered pane sizes.
// tabs/studio/view.js and static/js/studioTimeline.js draw it; scripts/test_studio_editor_model.cjs checks it.
// Written for Kairos (Content Studio Editor build spec, steps 1 and 2); no third-party code.

export const FPS = 30;
// The scene schema's choices (core/style_packs.py, core/character_store.py, core/video_store.py); a Python test
// compares these lists with the server's own.
export const SETTINGS = ['meadow', 'city', 'space', 'room', 'ocean', 'lab'];
export const SHOTS = ['wide', 'medium', 'close'];
export const PROPS = ['sun', 'moon', 'star', 'cloud', 'lightbulb', 'heart', 'book', 'planet', 'drop', 'leaf', 'gear', 'arrow',
  'question', 'coin', 'clock', 'rocket', 'tree', 'house', 'magnifier', 'atom'];
export const VIEWS = ['front', 'three_quarter', 'side', 'back'];
export const EXPRESSIONS = ['neutral', 'happy', 'surprised', 'worried', 'thinking'];
export const ACTIONS = ['idle', 'wave', 'point', 'walk', 'jump', 'shrug', 'think', 'nod'];
export const MAX_ON_SCREEN = 3, MAX_PROPS = 6;
// Pack B's 3D stage shot (core/video_store.py _stage, core/style_packs.py; static/motion/stage.js draws it).
export const STAGE_SETS = ['lavender', 'peach', 'mint', 'sky', 'night'];
export const STAGE_PROPS = ['ball', 'block', 'pillar', 'ring', 'coin'];
export const STAGE_FACINGS = ['camera', 'left', 'right'];
export const STAGE_COLORS = ['mint', 'violet', 'gold', 'coral', 'blue'];
export const MAX_PEOPLE = 8, MAX_LABELS = 8;
export const LEAD = .25;   // seconds of picture before a narrated line starts (core/video_store.py LEAD)

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A narrated beat lasts as long as its spoken line (the server measures it into `seconds`); others last their bars.
export const beatSeconds = (b, p) => Number.isFinite(b.seconds) && b.seconds > 0 ? b.seconds : Number(b.bars) * 240 / (p.bpm || 120);
export const totalSeconds = p => p.beats.reduce((s, b) => s + beatSeconds(b, p), 0);
export const isNarrated = b => typeof b.say === 'string' && b.say.length > 0;

// Each beat as a clip: where it starts and ends, and whether its length comes from its narration.
export function clips(p) {
  let start = 0;
  return p.beats.map((b, index) => {
    const seconds = beatSeconds(b, p), clip = { index, id: b.id, kind: b.kind, start, end: start + seconds, seconds,
      narrated: isNarrated(b), measured: !!b.spoken, label: beatLabel(b) };
    start += seconds;
    return clip;
  });
}
export function beatLabel(b) {
  const text = b.text || (b.number !== undefined && b.number !== '' ? String(b.number) : '') || (b.items || []).filter(Boolean).join(', ');
  if (text) return text;
  if (b.kind === 'scene') return b.scene?.setting ? `${b.scene.setting}, ${b.scene.shot || 'medium'} shot` : 'Scene';
  if (b.kind === 'stage') return b.stage?.set ? `3D ${b.stage.set} set, ${b.stage.shot || 'medium'} shot` : '3D stage';
  return 'No text';
}
// Chapters (long-form) as markers at the start of their beat.
export function chapterMarks(p, list = clips(p)) {
  const at = new Map(list.map(c => [c.id, c.start]));
  return (p.chapters || []).filter(c => at.has(c.start)).map((c, n) => ({ id: c.id, title: c.title, number: n + 1, time: at.get(c.start) }));
}
// The clip under time t (the last one at the very end).
export function clipAt(list, t) {
  return list.find(c => t < c.end) || list.at(-1) || null;
}

// mm:ss.ff with frames, as editors show it; hours only when needed.
export function timecode(t, fps = FPS) {
  const frames = Math.max(0, Math.round((Number(t) || 0) * fps));
  const f = frames % fps, s = Math.floor(frames / fps) % 60, m = Math.floor(frames / fps / 60) % 60, h = Math.floor(frames / fps / 3600);
  const two = n => String(n).padStart(2, '0');
  return (h ? `${h}:${two(m)}` : two(m)) + `:${two(s)}.${two(f)}`;
}
// Plain words for screen readers and labels.
export function spokenTime(t) {
  const s = Math.max(0, Number(t) || 0), m = Math.floor(s / 60), rest = s - m * 60;
  return m ? `${m} min ${rest.toFixed(1)} s` : `${rest.toFixed(1)} s`;
}
export const toFrame = (t, fps = FPS) => Math.round((Number(t) || 0) * fps);
export function stepFrames(t, frames, total, fps = FPS) {
  const last = Math.max(0, Math.floor(total * fps - 1e-6));
  return clamp(toFrame(t, fps) + frames, 0, last) / fps;
}

// Zoom is pixels per second of video.
export const ZOOM = { min: 4, max: 480, start: 60 };
export const clampZoom = z => clamp(Number(z) || ZOOM.start, ZOOM.min, ZOOM.max);
export const zoomBy = (z, factor) => clampZoom(z * factor);
export function fitZoom(total, width) { return clampZoom((Math.max(120, width) - 24) / Math.max(1, total)); }
// The zoom slider moves on a log scale so every step feels the same.
export const zoomToSlider = z => Math.round(Math.log(clampZoom(z) / ZOOM.min) / Math.log(ZOOM.max / ZOOM.min) * 1000);
export const sliderToZoom = v => clampZoom(ZOOM.min * Math.pow(ZOOM.max / ZOOM.min, clamp(Number(v) || 0, 0, 1000) / 1000));

// Ruler ticks: the smallest "nice" step that keeps labels at least minPx apart, with minor ticks in between.
const STEPS = [1 / FPS, 2 / FPS, 5 / FPS, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
export function rulerStep(z, minPx = 72) {
  const major = STEPS.find(s => s * z >= minPx) || STEPS.at(-1);
  const minor = major >= 60 ? major / 6 : major >= 10 ? major / 5 : major >= 1 ? major / (major === 2 ? 4 : major === 15 ? 3 : 5) : major / 2;
  return { major, minor };
}
export function rulerTicks(z, total, minPx = 72) {
  const { major, minor } = rulerStep(z, minPx), ticks = [];
  const count = Math.floor(total / minor + 1e-6);
  for (let i = 0; i <= count && ticks.length < 6000; i++) {
    const t = i * minor, isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    ticks.push({ t, major: isMajor, label: isMajor ? rulerLabel(t, major) : '' });
  }
  return ticks;
}
export function rulerLabel(t, major) {
  if (major < 1) return timecode(t).replace(/^00:/, '');
  const m = Math.floor(t / 60), s = Math.round(t - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Snapping: the nearest target within `px` pixels at zoom z, or the time unchanged.
export function snapTargets(list, { playhead, inPoint, outPoint, marks = [] } = {}) {
  const out = new Set([0]);
  for (const c of list) { out.add(c.start); out.add(c.end); }
  for (const t of [playhead, inPoint, outPoint]) if (Number.isFinite(t)) out.add(t);
  for (const m of marks) out.add(m.time);
  return [...out].sort((a, b) => a - b);
}
export function snap(t, targets, z, px = 8) {
  let best = null;
  for (const target of targets) {
    const d = Math.abs(target - t) * z;
    if (d <= px && (best === null || d < Math.abs(best - t) * z)) best = target;
  }
  return best === null ? { t, snapped: false } : { t: best, snapped: true };
}

// Trimming a beat that lasts its bars: a length in seconds becomes half-bar steps from 0.5 to 8.
export function barsFor(seconds, bpm) {
  const bars = Math.round((Number(seconds) || 0) / (240 / (bpm || 120)) * 2) / 2;
  return clamp(bars, .5, 8);
}
// Where a dragged clip lands: before the first clip whose middle is after the pointer.
export function dropIndex(list, t, from) {
  let to = list.findIndex(c => t < (c.start + c.end) / 2);
  if (to < 0) to = list.length;
  return to > from ? to - 1 : to;
}

// J, K and L: each press of L doubles forward speed (up to 8x), J the same backwards, K stops.
export function shuttle(rate, key) {
  if (key === 'k') return 0;
  if (key === 'l') return rate <= 0 ? 1 : Math.min(rate * 2, 8);
  if (key === 'j') return rate >= 0 ? -1 : Math.max(rate * 2, -8);
  return rate;
}
// Playback inside the work area (I to O) when both are set, else the whole video.
export function playRange(total, inPoint, outPoint) {
  const a = Number.isFinite(inPoint) ? clamp(inPoint, 0, total) : 0, b = Number.isFinite(outPoint) ? clamp(outPoint, 0, total) : total;
  return b - a > 1 / FPS ? { start: a, end: b } : { start: 0, end: total };
}
export function advance(t, dt, rate, range, loop) {
  let next = t + dt * rate, stopped = false;
  if (rate > 0 && next >= range.end) { if (loop) next = range.start + (next - range.end) % Math.max(1e-6, range.end - range.start); else { next = range.end; stopped = true; } }
  if (rate < 0 && next <= range.start) { if (loop) next = range.end - (range.start - next) % Math.max(1e-6, range.end - range.start); else { next = range.start; stopped = true; } }
  return { t: next, stopped };
}

// The keyboard. Returns the action for a key event, or null. Fields and menus keep their own keys.
export const SHORTCUTS = [
  ['Space', 'Play or pause'],
  ['J / K / L', 'Play backwards, stop, play forwards (press again to go faster)'],
  ['Left / Right', 'One frame back or forward (Shift: 10 frames)'],
  ['Up / Down', 'Previous or next beat edge'],
  ['Home / End', 'Start or end of the video'],
  ['I / O', 'Set the start or end of the work area at the playhead'],
  ['Alt + X', 'Clear the work area'],
  ['Delete', 'Delete the selected beat'],
  ['Ctrl + D', 'Duplicate the selected beat'],
  ['Alt + Left / Right', 'Move the selected beat earlier or later'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Shift + Z or Ctrl + Y', 'Redo'],
  ['= / -', 'Zoom the timeline in or out'],
  ['\\', 'Fit the whole video in the timeline'],
  ['N', 'Snapping on or off'],
  ['G', 'Safe area guides on or off'],
  ['?', 'Show these shortcuts'],
];
export function keyAction(e) {
  const mod = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
    if (key === 'd') return 'duplicate';
    return null;
  }
  if (e.altKey) {
    if (key === 'ArrowLeft') return 'move-earlier';
    if (key === 'ArrowRight') return 'move-later';
    if (key === 'x') return 'clear-work-area';
    return null;
  }
  switch (key) {
    case ' ': return 'play';
    case 'j': case 'k': case 'l': return 'shuttle-' + key;
    case 'ArrowLeft': return e.shiftKey ? 'back-10' : 'back-1';
    case 'ArrowRight': return e.shiftKey ? 'forward-10' : 'forward-1';
    case 'ArrowUp': return 'previous-edge';
    case 'ArrowDown': return 'next-edge';
    case 'Home': return 'start';
    case 'End': return 'end';
    case 'i': return 'mark-in';
    case 'o': return 'mark-out';
    case 'Delete': case 'Backspace': return 'delete';
    case '=': case '+': return 'zoom-in';
    case '-': case '_': return 'zoom-out';
    case '\\': return 'zoom-fit';
    case 'n': return 'snap';
    case 'g': return 'guides';
    case '?': return 'shortcuts';
    default: return null;
  }
}
// Keys typed into a field, a menu or a dialog are not shortcuts.
export function isTyping(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toLowerCase();
  if (target.isContentEditable || tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') return !['checkbox', 'radio', 'button', 'range'].includes(String(target.type || '').toLowerCase());
  return false;
}
export function edgeTime(list, t, direction) {
  const edges = [...new Set([0, ...list.map(c => c.end)])].sort((a, b) => a - b), eps = .5 / FPS;
  return direction < 0 ? [...edges].reverse().find(e => e < t - eps) ?? 0 : edges.find(e => e > t + eps) ?? edges.at(-1);
}

// The panes: sizes in pixels, remembered per person on this device.
export const PANES = { left: [180, 520, 248], right: [260, 620, 340], timeline: [150, 520, 236] };
export function clampPanes(raw = {}, viewport = { width: 1440, height: 900 }) {
  const out = {};
  for (const [name, [lo, hi, start]] of Object.entries(PANES)) out[name] = Math.round(clamp(Number.isFinite(raw[name]) ? raw[name] : start, lo, hi));
  // The preview keeps at least 320 px across and 200 px down.
  const spare = viewport.width - 320 - 12;
  if (out.left + out.right > spare) { const scale = Math.max(0, spare) / (out.left + out.right); out.left = Math.max(PANES.left[0], Math.round(out.left * scale)); out.right = Math.max(PANES.right[0], Math.round(out.right * scale)); }
  out.timeline = Math.min(out.timeline, Math.max(PANES.timeline[0], viewport.height - 260));
  for (const key of ['leftTab', 'rightTab']) if (typeof raw[key] === 'string' && /^[a-z]{2,12}$/.test(raw[key])) out[key] = raw[key];
  for (const key of ['guides', 'snap']) out[key] = typeof raw[key] === 'boolean' ? raw[key] : true;
  return out;
}
export const panesKey = username => 'kairos:studio-editor:v1:' + String(username || 'local');

// The narration lane: peak levels from the server (0..255 at `rate` a second, from the line's start), placed on the
// beat. Without them (not narrated yet) the measured caption parts show as speech spans.
export function speechSpans(p, list = clips(p)) {
  const out = [];
  p.beats.forEach((b, i) => {
    for (const part of b.spoken?.parts || []) if (Array.isArray(part)) out.push({ beat: b.id, start: list[i].start + part[0], end: list[i].start + part[1] });
  });
  return out;
}
// The music bed's level over time, as the mix makes it: the bed sits under the voice and ducks while a line plays
// (core/video_audio.py: 12 dB more, opening 120 ms early, releasing over 400 ms). Returns 0..1 at `t`.
export function musicLevel(t, spans, volume = .7) {
  let duck = 0;
  for (const s of spans) {
    if (t >= s.start - .12 && t <= s.end) duck = Math.max(duck, t < s.start ? (t - (s.start - .12)) / .12 : 1);
    else if (t > s.end && t < s.end + .4) duck = Math.max(duck, 1 - (t - s.end) / .4);
  }
  const level = clamp(Number(volume) || 0, 0, 1);
  return level * (1 - duck * .75);   // -12 dB is about a quarter of the amplitude
}
