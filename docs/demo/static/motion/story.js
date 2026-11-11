// The Story Short format (Pack C classic, David 2026-11-10): a 1080 x 1920 split screen with the talking avatar of whoever
// speaks on top (a dark gaming room, a box headset, LEDs and a border in the speaker's colour) and the block scene below;
// pure dialogue, one UPPERCASE word at a time in a heavy outlined caption, key words in the speaker's colour; sepia
// FLASHBACK segments with a tag and white flashes at the edges. This module is the 2D part: the layout, the caption's
// word at a moment, the mouth from the voice's level, and the drawing of the border, divider, captions and the grade.
// It imports nothing that draws in 3D; the geometry functions are safe in Node (scripts/test_classic_model.mjs).
import { clamp } from './kit.js';

export const W = 1080, H = 1920;
// The reference's layout: the top 640 px is the avatar behind a 14 px border in the speaker's colour, an 8 px dark
// divider on the seam, the bottom 1080 x 1280 the block animation; captions sit just under the divider.
export const LAYOUT = {
  avatar: { x: 0, y: 0, w: W, h: 640 }, border: 14, divider: { y: 636, h: 8, colour: '#0c0a12' },
  scene: { x: 0, y: 640, w: W, h: 1280 }, caption: { y: 790, size: 96, outline: 12, max: 1000 },
  tag: { x: 40, y: 1830, size: 54 },
};
// Each speaker owns a colour (the reference's purple, orange and pink are the defaults for the first three).
export const SPEAKER_COLOURS = ['#b05aff', '#ffa028', '#ff64aa', '#3ec7ff'];
export const KEY_WORDS = ['help', 'bye', 'goodbye', 'like', 'subscribe', 'please', 'sorry', 'no'];
export const SEPIA = .75;
// The caption font: Archivo Black (SIL Open Font License, bundled with the app in static/fonts/looks/archivoblack), the
// closest heavy geometric sans the app already ships; Montserrat is not in the app and no font is downloaded.
export const CAPTION_FONT = '"Kairos Story Caption", "Archivo Black", "Arial Black", sans-serif';

const clean = w => w.toLowerCase().replace(/[^a-z0-9']/g, '');
export const words = say => String(say || '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));

// The word on screen at t (seconds into the beat): the last word that has started; it stays until the next one and to the
// end of the beat. starts: each word's start in seconds from the beat's start. Null before the first word.
export function captionAt(beat, t, starts) {
  const list = words(beat.say);
  let k = -1;
  for (let i = 0; i < Math.min(list.length, starts.length); i++) if (t >= starts[i]) k = i;
  if (k < 0) return null;
  const word = list[k], keys = [...KEY_WORDS, ...(beat.story?.keys || [])];
  return { index: k, word, text: word.toUpperCase().replace(/[^\p{L}\p{N}'!?.,-]/gu, ''), key: keys.includes(clean(word)), since: t - starts[k] };
}

// The mouth from the voice's level: open on frames whose code (core/video_mouth.py, from the line's own audio) is an
// open shape, with a minimum hold of two frames so it never flickers. Returns a string of 0 and 1, one a frame.
export function mouthOpen(codes, hold = 2) {
  const open = Array.from(codes || '', c => 'AEOF'.includes(c) ? 1 : 0);
  let i = 0;
  while (i < open.length) {
    let j = i;
    while (j < open.length && open[j] === open[i]) j++;
    if (j - i < hold && i > 0) for (let k = i; k < j; k++) open[k] = open[i - 1];
    i = j;
  }
  return open.join('');
}

// The flashback grade at a moment: how much white flashes in from the edges (at a flashback's start and end).
export function edgeFlash(sinceStart, untilEnd) {
  const a = sinceStart >= 0 && sinceStart < .3 ? 1 - sinceStart / .3 : 0, b = untilEnd >= 0 && untilEnd < .2 ? 1 - untilEnd / .2 : 0;
  return clamp(Math.max(a, b));
}

// -- drawing (2D canvas) ---------------------------------------------------------------------------------------------------

export function drawFrameParts(g, picture, { colour, flashback = false, flash = 0, tagPop = 1 }) {
  const { avatar, scene, divider, border } = LAYOUT;
  // The avatar strip, its border in the speaker's colour.
  g.drawImage(picture, avatar.x, avatar.y, avatar.w, avatar.h, avatar.x, avatar.y, avatar.w, avatar.h);
  g.save(); g.strokeStyle = colour; g.lineWidth = border; g.strokeRect(border / 2, border / 2, avatar.w - border, avatar.h - border - 4); g.restore();
  // The scene, graded in a flashback: 75% sepia, a vignette, white at the edges as it starts and ends, the tag.
  g.save();
  if (flashback) g.filter = `sepia(${SEPIA}) contrast(1.04)`;
  g.drawImage(picture, scene.x, scene.y, scene.w, scene.h, scene.x, scene.y, scene.w, scene.h);
  g.restore();
  if (flashback) {
    const v = g.createRadialGradient(scene.x + scene.w / 2, scene.y + scene.h / 2, scene.h * .28, scene.x + scene.w / 2, scene.y + scene.h / 2, scene.h * .78);
    v.addColorStop(0, 'rgba(40, 24, 8, 0)'); v.addColorStop(1, 'rgba(40, 24, 8, .62)');
    g.fillStyle = v; g.fillRect(scene.x, scene.y, scene.w, scene.h);
  }
  if (flash > 0) {
    // A white glow from every edge inwards (a framed flash), held for its few frames.
    g.save(); g.globalAlpha = flash;
    const edge = 190;
    const sides = [[scene.x, scene.y, scene.w, edge, 0, 1], [scene.x, scene.y + scene.h - edge, scene.w, edge, 0, -1], [scene.x, scene.y, edge, scene.h, 1, 0], [scene.x + scene.w - edge, scene.y, edge, scene.h, -1, 0]];
    for (const [x, y, w, h, dx, dy] of sides) {
      const gx = dx > 0 ? g.createLinearGradient(x, 0, x + w, 0) : dx < 0 ? g.createLinearGradient(x + w, 0, x, 0) : dy > 0 ? g.createLinearGradient(0, y, 0, y + h) : g.createLinearGradient(0, y + h, 0, y);
      gx.addColorStop(0, 'rgba(255,255,255,1)'); gx.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gx; g.fillRect(x, y, w, h);
    }
    g.restore();
  }
  // The divider on the seam.
  g.fillStyle = divider.colour; g.fillRect(0, divider.y, W, divider.h);
  if (flashback) drawTag(g, tagPop);
}

function outlined(g, text, x, y, size, fill, outline) {
  g.font = `400 ${size}px ${CAPTION_FONT}`; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.save(); g.shadowColor = 'rgba(0, 0, 0, .5)'; g.shadowBlur = 18; g.shadowOffsetY = 7;
  g.strokeStyle = '#000000'; g.lineWidth = outline * 2; g.strokeText(text, x, y);
  g.restore();
  g.fillStyle = fill; g.fillText(text, x, y);
}
export function drawTag(g, pop = 1) {
  const { x, y, size } = LAYOUT.tag;
  g.save(); g.translate(x, y); g.scale(pop, pop);
  g.font = `400 ${size}px ${CAPTION_FONT}`;
  const w = g.measureText('FLASHBACK').width;
  g.fillStyle = 'rgba(20, 14, 6, .78)'; g.beginPath(); g.roundRect(-18, -size * .95, w + 36, size * 1.25, 10); g.fill();
  g.restore();
  g.save(); g.translate(x, y); g.scale(pop, pop); g.textAlign = 'left';
  g.font = `400 ${size}px ${CAPTION_FONT}`; g.fillStyle = '#ffe9b8'; g.fillText('FLASHBACK', 0, 0);
  g.restore();
}
// The caption word: white (or the speaker's colour for a key word) with a 12 px black outline and a soft shadow; it pops
// in over 0.08 s and stays. Returns its box for the layout report.
export function drawCaption(g, caption, colour, measure) {
  const { y, size, outline, max } = LAYOUT.caption;
  g.font = `400 ${size}px ${CAPTION_FONT}`;
  const width = measure ? measure(caption.text, size) : g.measureText(caption.text).width;
  const fit = Math.min(1, max / Math.max(1, width)), pop = caption.since < .08 ? 1.18 - 2.25 * caption.since : 1;
  const s = size * fit;
  g.save(); g.translate(W / 2, y); g.scale(pop, pop);
  outlined(g, caption.text, 0, 0, s, caption.key ? colour : '#ffffff', outline);
  g.restore();
  const w = width * fit * pop + outline * 2, h = s * 1.05 * pop + outline * 2;
  return { x: W / 2 - w / 2, y: y - s * .82 * pop - outline, w, h, size: s };
}
