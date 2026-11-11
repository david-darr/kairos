// Pure logic for Studio's video editor (no DOM): beat timing on the timeline, timecodes, frame steps, zoom and ruler
// maths, snapping, trimming in half bars, shuttle speeds, the keyboard table and the remembered pane sizes.
// tabs/studio/view.js and static/js/studioTimeline.js draw it; scripts/test_studio_editor_model.cjs checks it.
// Written for Kairos (Content Studio Editor build spec, steps 1 to 7); no third-party code. Steps 5 to 7 add the canvas
// handles' maths (snapping to the safe area and centre lines, nudges), keyframes (add at the playhead, move, copy and
// paste; the values come from the engine's own interpolation in static/motion/overlay.js) and video clips.
import { valueAt, KEY_PROPS, EASES, KEY_RANGES } from '../motion/overlay.js';
export { KEY_PROPS, EASES };

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
  if (b.kind === 'voxel') return b.voxel?.world ? `Blocky ${b.voxel.world.replace('-', ' ')}, ${b.voxel.time || 'day'}, ${b.voxel.shot || 'medium'} shot` : 'Blocky world';
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
  ['Delete', 'Delete the selected keyframes, clip or beat (with Ripple on, later clips on its track move up)'],
  ['A', 'Add keyframes at the playhead to the selected clip (its animated properties, or all of them)'],
  ['[ / ]', 'Previous or next keyframe of the selected clip'],
  ['Ctrl + C / Ctrl + V', 'Copy the selected keyframes; paste them at the playhead on the selected clip'],
  ['Arrows on the preview', 'With the clip box focused: nudge the clip 1 pixel (Shift: 10)'],
  ['S', 'Split the selected clip at the playhead'],
  ['C', 'Comment mode: click the preview to pin a comment for Kairos'],
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
    if (key === 'c' && !e.shiftKey) return 'copy-keys';
    if (key === 'v' && !e.shiftKey) return 'paste-keys';
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
    case 's': return 'split';
    // Keyframes (step 5): A adds them at the playhead. K stays the shuttle's stop, as in other editors' J/K/L.
    case 'a': return 'keyframe';
    case '[': return 'previous-key';
    case ']': return 'next-key';
    case 'c': return 'comment';
    case 'Escape': return 'escape';
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
  out.ripple = raw.ripple === true;   // ripple delete for track clips: off until the person turns it on
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

// -- Tracks and clips (Content Studio Editor build spec, step 3; core/video_tracks.py checks the same rules) ------------
// Overlay tracks hold text, image and shape clips drawn over the beats (the last track on top, captions above all);
// audio tracks hold sound clips. A clip starts at `start` on the timeline and plays its own time from `in` to `out`.
export const TRACK_KINDS = ['overlay', 'audio'];
export const CLIP_KINDS = { overlay: ['text', 'image', 'shape', 'video'], audio: ['sound'] };
export const CLIP_COLORS = ['text', 'dim', 'accent', 'accent-2', 'bg', 'surface', 'white', 'black'];
export const CLIP_SHAPES = ['rect', 'ellipse', 'line', 'arrow'];
export const MAX_TRACKS = 8, MAX_TRACK_CLIPS = 60, MAX_CLIPS = 200;
const FRAME = 1 / FPS;
const r4 = v => Math.round(v * 10000) / 10000;
export const clipLength = c => c.out - c.in;
export const clipEnd = c => c.start + clipLength(c);
export const tracksOf = p => Array.isArray(p.tracks) ? p.tracks : [];
export function findClip(p, id) {
  for (const track of tracksOf(p)) { const index = track.clips.findIndex(c => c.id === id); if (index >= 0) return { track, clip: track.clips[index], index }; }
  return null;
}
// Ids are unique across beats, tracks and clips (the server refuses a clip id a beat has).
export function uniqueId(p, base) {
  const taken = new Set([...p.beats.map(b => b.id), ...tracksOf(p).flatMap(t => [t.id, ...t.clips.map(c => c.id)])]);
  let n = 1; while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
export const sortClips = track => { track.clips.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1)); return track; };
// Does a clip of this length fit at `start` on the track without overlapping another clip (except `ignore`)?
export function fits(track, start, length, ignore = null) {
  if (start < -1e-6) return false;
  return track.clips.every(c => c.id === ignore || start + length <= c.start + 1e-6 || start >= clipEnd(c) - 1e-6);
}
// The first free start at or after `at` on a track for a clip of `length` (moving past any clip in the way).
export function freeStart(track, at, length, ignore = null) {
  let start = Math.max(0, at);
  for (let guard = 0; guard < 200 && !fits(track, start, length, ignore); guard++) {
    const blocker = track.clips.filter(c => c.id !== ignore && start < clipEnd(c) - 1e-6 && start + length > c.start + 1e-6).sort((a, b) => clipEnd(a) - clipEnd(b))[0];
    if (!blocker) break;
    start = clipEnd(blocker);
  }
  return r4(start);
}
// A new clip with the defaults the inspector shows. `at` is the playhead; text and shapes last 3 s, a sound its length.
export function newClip(p, kind, at, extra = {}) {
  const id = uniqueId(p, 'k'), base = { id, kind, start: r4(Math.max(0, at)), in: 0, out: 3, fade_in: 0, fade_out: 0 };
  if (kind === 'text') return { ...base, opacity: 1, fade_in: .3, fade_out: .3, text: 'Your text', box: { x: .1, y: .08, w: .8, h: .16 }, role: 'title', style: 'card', color: 'text', align: 'center', ...extra };
  if (kind === 'image') return { ...base, opacity: 1, image: '', box: { x: .62, y: .08, w: .3, h: .3 }, fit: 'contain', ...extra };
  if (kind === 'shape') return { ...base, opacity: 1, shape: 'rect', box: { x: .1, y: .7, w: .3, h: .06 }, color: 'accent', fill: true, stroke: .006, ...extra };
  return { ...base, volume: .8, audio: '', ...extra };
}
// Cut a clip at timeline time `at`: the clip keeps the part before; returns the part after (a fade in stays with the
// first part, a fade out with the second), or null when `at` is not at least a frame inside it.
export function splitClip(clip, at, newId) {
  if (!(at >= clip.start + FRAME - 1e-6 && at <= clipEnd(clip) - FRAME + 1e-6)) return null;
  const cut = r4(clip.in + at - clip.start);
  const second = { ...structuredClone(clip), id: newId, start: r4(at), in: cut, fade_in: 0 };
  clip.out = cut; clip.fade_out = 0; clip.fade_in = Math.min(clip.fade_in, clipLength(clip));
  second.fade_out = Math.min(second.fade_out, clipLength(second));
  return second;
}
// Drag an edge to timeline time t. The left edge moves the clip's start and its `in` together (in stays >= 0); the
// right edge moves `out`. A clip keeps at least one frame, a sound stays inside its file (`limit` seconds), and the
// edge stops at the next clip on its track.
export function trimClip(clip, edge, t, { track = null, limit = Infinity } = {}) {
  const out = { start: clip.start, in: clip.in, out: clip.out };
  const others = track ? track.clips.filter(c => c.id !== clip.id) : [];
  if (edge === 'left') {
    const floor = Math.max(clip.start - clip.in, ...others.filter(c => clipEnd(c) <= clip.start + 1e-6).map(clipEnd), 0);
    const start = clamp(t, floor, clipEnd(clip) - FRAME), delta = start - clip.start;
    out.start = r4(start); out.in = r4(clip.in + delta);
  } else {
    const ceiling = Math.min(clip.start + (limit - clip.in), ...others.filter(c => c.start >= clipEnd(clip) - 1e-6).map(c => c.start));
    out.out = r4(clip.in + clamp(t, clip.start + FRAME, ceiling) - clip.start);
  }
  out.fade_in = Math.min(clip.fade_in || 0, out.out - out.in); out.fade_out = Math.min(clip.fade_out || 0, out.out - out.in - out.fade_in);
  return out;
}
// Remove a clip; with ripple, later clips on the same track move left by its length (closing the gap).
export function removeClip(track, id, ripple = false) {
  const at = track.clips.findIndex(c => c.id === id);
  if (at < 0) return track;
  const [gone] = track.clips.splice(at, 1);
  if (ripple) for (const c of track.clips) if (c.start >= gone.start - 1e-6) c.start = r4(Math.max(0, c.start - clipLength(gone)));
  return track;
}
// Where a clip is on screen in plain words, for the timeline and for screen readers.
export function clipLabel(c, sounds = {}, media = {}) {
  if (c.kind === 'text') return c.text || 'Text';
  if (c.kind === 'image') return c.image ? `Image ${c.image.slice(7, 15)}` : 'Image (choose one)';
  if (c.kind === 'video') return media[c.video]?.title || (c.video ? `Video ${c.video.slice(6, 14)}` : 'Video (choose one)');
  if (c.kind === 'shape') return `${c.color || 'accent'} ${c.shape || 'rect'}`;
  return sounds[c.audio]?.title || (c.audio ? `Sound ${c.audio.slice(7, 15)}` : 'Sound (choose one)');
}
// Snapping targets for clips: beat edges, every other clip's edges, the playhead, the work area and chapters.
export function clipSnapTargets(p, list, extra = {}, ignore = null) {
  const out = new Set(snapTargets(list, extra));
  for (const t of tracksOf(p)) for (const c of t.clips) if (c.id !== ignore) { out.add(c.start); out.add(clipEnd(c)); }
  return [...out].sort((a, b) => a - b);
}
// Comment pins show on the preview near their time.
export const pinVisible = (pin, t, near = 1.5) => Math.abs(pin.t - t) <= near;

// -- Keyframes and the canvas (Content Studio Editor build spec, step 5; core/video_tracks.py checks the same rules) -----
// A clip's keys are per property, in the clip's own time (the clock of `in` and `out`): own = in + (t - start).
export const KEY_NAMES = { x: 'Left', y: 'Top', scale: 'Size', rotation: 'Turn', opacity: 'Opacity' };
export const EASE_NAMES = { linear: 'Linear', in: 'Ease in', out: 'Ease out', 'in-out': 'Ease in and out', back: 'Overshoot', hold: 'Hold' };
const KEY_EPS = 1 / 120;
export const ownTime = (clip, t) => r4((clip.in || 0) + t - clip.start);
export const timelineTime = (clip, own) => r4(clip.start + own - (clip.in || 0));
export const animatedProps = clip => KEY_PROPS.filter(prop => clip.keys?.[prop]?.length);
const plain = (clip, prop) => prop === 'x' ? clip.box.x : prop === 'y' ? clip.box.y : prop === 'scale' ? (clip.scale ?? 1) : prop === 'rotation' ? (clip.rotation ?? 0) : (clip.opacity ?? 1);
// Every keyable value of a visual clip at timeline time t, as the engine draws it.
export function clipValues(clip, t) {
  const own = ownTime(clip, t), out = {};
  for (const prop of KEY_PROPS) {
    const keys = clip.keys?.[prop];
    out[prop] = keys?.length ? valueAt([...keys].sort((a, b) => a.t - b.t).map(k => ({ ...k, ease: k.ease || 'linear' })), own) : plain(clip, prop);
  }
  return out;
}
const fit = (prop, v) => { const [lo, hi] = KEY_RANGES[prop]; return Math.round(clamp(v, lo, hi) * 10000) / 10000; };
// Set (or replace) one key at timeline time t; an existing key there keeps its ease unless one is given.
export function setKey(clip, prop, t, value, ease) {
  const own = ownTime(clip, t), keys = (clip.keys ||= {})[prop] ||= [];
  const at = keys.findIndex(k => Math.abs(k.t - own) < KEY_EPS);
  const key = { t: own, v: fit(prop, value), ease: ease || (at >= 0 ? keys[at].ease : 'linear') || 'linear' };
  if (at >= 0) keys[at] = key; else keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return key;
}
// Keys for every animated property (or all of them when none is) at t, holding the values the clip shows there.
export function keyAll(clip, t) {
  const values = clipValues(clip, t), props = animatedProps(clip).length ? animatedProps(clip) : KEY_PROPS;
  for (const prop of props) setKey(clip, prop, t, values[prop]);
  return props;
}
function tidy(clip) {
  for (const prop of KEY_PROPS) if (clip.keys && !clip.keys[prop]?.length) delete clip.keys[prop];
  if (clip.keys && !Object.keys(clip.keys).length) delete clip.keys;
  return clip;
}
// Remove the keys at these own times (every property's, or `props`). Returns how many went.
export function removeKeys(clip, owns, props = KEY_PROPS) {
  let gone = 0;
  for (const prop of props) {
    const keys = clip.keys?.[prop];
    if (!keys) continue;
    const kept = keys.filter(k => !owns.some(o => Math.abs(k.t - o) < KEY_EPS));
    gone += keys.length - kept.length; clip.keys[prop] = kept;
  }
  tidy(clip);
  return gone;
}
// Turn a property's animation off: its value at t becomes the plain value and its keys go.
export function unanimate(clip, prop, t) {
  const v = clipValues(clip, t)[prop];
  if (clip.keys) delete clip.keys[prop];
  setPlain(clip, prop, v);
  return tidy(clip);
}
export function setPlain(clip, prop, v) {
  if (prop === 'x' || prop === 'y') {
    const size = prop === 'x' ? clip.box.w : clip.box.h;
    clip.box = { ...clip.box, [prop]: Math.round(clamp(v, 0, 1 - size) * 10000) / 10000 };
  } else if (prop === 'scale') { if (fit('scale', v) === 1) delete clip.scale; else clip.scale = fit('scale', v); }
  else if (prop === 'rotation') { if (fit('rotation', v) === 0) delete clip.rotation; else clip.rotation = fit('rotation', v); }
  else clip.opacity = fit('opacity', v);
}
// A change made on the canvas or in a field: an animated property gets a key at the playhead (auto-record stays off
// for the rest); a plain one changes its plain value.
export function applyValues(clip, t, values) {
  for (const [prop, v] of Object.entries(values)) {
    if (!KEY_PROPS.includes(prop) || !Number.isFinite(v)) continue;
    if (clip.keys?.[prop]?.length) setKey(clip, prop, t, v); else setPlain(clip, prop, v);
  }
  return clip;
}
// The distinct key times of a clip (own time) with the properties keyed at each, sorted.
export function keyMoments(clip) {
  const out = new Map();
  for (const prop of KEY_PROPS) for (const k of clip.keys?.[prop] || []) {
    const near = [...out.keys()].find(o => Math.abs(o - k.t) < KEY_EPS);
    const at = near ?? k.t;
    if (!out.has(at)) out.set(at, []);
    out.get(at).push(prop);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([own, props]) => ({ own, t: timelineTime(clip, own), props }));
}
// Move every key at own time `from` to own time `to` (a key already at `to` on the same property is replaced).
export function moveKeys(clip, from, to) {
  to = r4(Math.max(0, to));
  for (const prop of KEY_PROPS) {
    const keys = clip.keys?.[prop];
    const key = keys?.find(k => Math.abs(k.t - from) < KEY_EPS);
    if (!key) continue;
    clip.keys[prop] = keys.filter(k => k === key || Math.abs(k.t - to) >= KEY_EPS);
    key.t = to;
    clip.keys[prop].sort((a, b) => a.t - b.t);
  }
  return clip;
}
// Copy the keys at these own times; paste them with their spacing kept, the first at timeline time t.
export function copyKeys(clip, owns) {
  const base = Math.min(...owns), keys = {};
  for (const prop of KEY_PROPS) {
    const picked = (clip.keys?.[prop] || []).filter(k => owns.some(o => Math.abs(k.t - o) < KEY_EPS));
    if (picked.length) keys[prop] = picked.map(k => ({ dt: r4(k.t - base), v: k.v, ease: k.ease || 'linear' }));
  }
  return Object.keys(keys).length ? { keys } : null;
}
export function pasteKeys(clip, clipboard, t) {
  const own = ownTime(clip, t), pasted = new Set();
  for (const [prop, list] of Object.entries(clipboard?.keys || {})) {
    if (!KEY_PROPS.includes(prop)) continue;
    for (const k of list) { setKey(clip, prop, timelineTime(clip, own + k.dt), k.v, k.ease); pasted.add(r4(own + k.dt)); }
  }
  return [...pasted].sort((a, b) => a - b);
}
// The previous or next key moment of a clip from timeline time t, inside the clip, or null.
export function nextKeyTime(clip, t, direction) {
  const times = keyMoments(clip).map(m => m.t).filter(x => x >= clip.start - 1e-6 && x <= clipEnd(clip) + 1e-6);
  return direction < 0 ? [...times].reverse().find(x => x < t - 1e-4) ?? null : times.find(x => x > t + 1e-4) ?? null;
}

// Snapping a box (shares of the frame) while it moves on the canvas: its left edge, centre and right edge to the
// vertical lines, its top, middle and bottom to the horizontal ones, within `reach` (a share). Returns the snapped x
// and y and the lines it snapped to, for the guides.
export function canvasLines(safe) {
  const xs = [0, .5, 1], ys = [0, .5, 1];
  if (safe) { xs.push(safe.x, safe.x + safe.w); ys.push(safe.y, safe.y + safe.h); }
  return { xs, ys };
}
export function snapMove(box, lines, reachX, reachY) {
  const pick = (start, size, targets, reach) => {
    let best = null;
    for (const [offset, edge] of [[0, 'start'], [size / 2, 'centre'], [size, 'end']]) for (const line of targets) {
      const d = Math.abs(start + offset - line);
      if (d <= reach && (!best || d < best.d)) best = { d, value: line - offset, line, edge };
    }
    return best;
  };
  const sx = pick(box.x, box.w, lines.xs, reachX), sy = pick(box.y, box.h, lines.ys, reachY);
  return { x: sx ? sx.value : box.x, y: sy ? sy.value : box.y, guides: { x: sx?.line ?? null, y: sy?.line ?? null } };
}
// A nudge on the canvas: `dx` and `dy` in frame pixels.
export function nudge(values, dx, dy, w, h) {
  return { x: values.x + dx / w, y: values.y + dy / h };
}
// The angle (degrees) of a point around a centre, for the rotate handle; with `step` it rounds to that many degrees.
export function angleOf(cx, cy, px, py, step = 0) {
  const a = Math.atan2(py - cy, px - cx) * 180 / Math.PI + 90;
  return step ? Math.round(a / step) * step : a;
}
// Video clips (step 7): a clip from an uploaded file starts at the playhead, as long as the file (at most 30 s).
export function videoClip(p, at, media, info) {
  return { id: uniqueId(p, 'k'), kind: 'video', start: r4(Math.max(0, at)), in: 0, out: r4(Math.min(info?.seconds || 3, 30)), fade_in: 0, fade_out: 0,
    opacity: 1, video: media, box: { x: .55, y: .1, w: .4, h: .4 }, fit: 'cover' };
}
