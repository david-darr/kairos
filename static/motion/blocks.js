// Pack C classic (David, 2026-11-10: "much closer to the block-game reference"): every pixel texture the classic block
// world and its characters wear, drawn in code here as plain data. Nothing is loaded from a file and nothing comes from
// any game: each texture is a 16 x 16 (or part-sized) grid of RGB pixels built from a base colour, a deterministic
// per-pixel jitter and a few hand-written rules (a grass edge, plank seams, ore specks). The renderers (classic3d.js,
// blender/kairos_stage.py through the Blender pass) show them with hard nearest-neighbour pixels.
//
// Imports nothing that draws; safe in Node (scripts/test_classic_model.mjs checks that every texture is deterministic).
import { hash } from './kit.js';

export const TEX = 16;                // block textures are 16 x 16 pixels
const clampByte = v => Math.max(0, Math.min(255, Math.round(v)));

// A texture: { w, h, data: Uint8ClampedArray RGBA }. `alpha` 0 pixels are cut out (flowers).
export function texture(w, h) { return { w, h, data: new Uint8ClampedArray(w * h * 4) }; }
function put(t, x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return;
  const i = (y * t.w + x) * 4; t.data[i] = clampByte(r); t.data[i + 1] = clampByte(g); t.data[i + 2] = clampByte(b); t.data[i + 3] = a;
}
export function pixel(t, x, y) { const i = (y * t.w + x) * 4; return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]]; }
// A deterministic number in [0, 1) for a texture, a pixel and a channel.
const rnd = (seed, ...k) => (hash(`${seed}|${k.join(',')}`) % 1000003) / 1000003;
// Each pixel jittered: a brightness step shared by the channels (so pixels stay the same hue) plus a small per-channel
// wobble; `amount` is the largest step (the reference: 3 to 8).
function jittered(seed, x, y, base, amount = 7) {
  const step = Math.round((rnd(seed, x, y) * 2 - 1) * amount);
  return base.map((c, i) => c + step + Math.round((rnd(seed, x, y, i) - .5) * 3));
}
function fill(t, seed, base, amount) { for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) put(t, x, y, jittered(seed, x, y, base, amount)); return t; }
export const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const shade = (c, k) => c.map(v => v * k);

// The world's colours (the reference's numbers) and the few of our own (the blast crate, the cake, the lantern).
export const COLOURS = {
  dirt: [134, 96, 67], grass: [98, 160, 58], stone: [126, 126, 128], leaves: [62, 122, 40], planks: [150, 120, 76],
  water: [70, 112, 210], sand: [219, 207, 152], log: [104, 82, 50], log_ring: [168, 138, 88], cloud: [255, 255, 255],
  ore_copper: [214, 128, 72], ore_gem: [96, 214, 222], petal_red: [214, 44, 52], petal_yellow: [246, 210, 56], stem: [52, 120, 36],
};

// -- block textures ------------------------------------------------------------------------------------------------------

function grassTop() { return fill(texture(TEX, TEX), 'grass-top', COLOURS.grass, 8); }
function dirt() {
  const t = fill(texture(TEX, TEX), 'dirt', COLOURS.dirt, 7);
  // A few darker and lighter clods.
  for (let n = 0; n < 9; n++) put(t, Math.floor(rnd('dirt-clod', n, 0) * TEX), Math.floor(rnd('dirt-clod', n, 1) * TEX), shade(COLOURS.dirt, n % 2 ? .78 : 1.14));
  return t;
}
// The side of a grass block: green for 3 to 5 pixels from the top (a ragged edge, column by column), then dirt.
export function grassEdge(x) { return 3 + Math.floor(rnd('grass-edge', x) * 3); }
function grassSide() {
  const t = dirt();
  for (let x = 0; x < TEX; x++) for (let y = 0; y < grassEdge(x); y++) put(t, x, y, jittered('grass-side', x, y, COLOURS.grass, 8));
  return t;
}
function stone() {
  const t = fill(texture(TEX, TEX), 'stone', COLOURS.stone, 6);
  // Soft cracks: short darker runs.
  for (let n = 0; n < 6; n++) {
    let x = Math.floor(rnd('crack', n, 0) * TEX), y = Math.floor(rnd('crack', n, 1) * TEX);
    for (let k = 0; k < 3; k++) { put(t, x, y, shade(COLOURS.stone, .8)); x += rnd('crack', n, k, 2) > .5 ? 1 : 0; y += 1; }
  }
  return t;
}
// Stone with specks of a mineral in a few small clusters (our own colours).
function ore(kind) {
  const t = stone(), c = COLOURS[kind];
  for (let n = 0; n < 4; n++) {
    const x = 2 + Math.floor(rnd(kind, n, 0) * 11), y = 2 + Math.floor(rnd(kind, n, 1) * 11);
    put(t, x, y, c); put(t, x + 1, y, shade(c, .85)); if (n % 2) put(t, x, y + 1, shade(c, 1.1));
  }
  return t;
}
function logSide() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    // Vertical bark grooves every few pixels.
    const groove = (x % 4 === 1) || (x % 4 === 2 && rnd('bark', x, Math.floor(y / 3)) > .6);
    put(t, x, y, jittered('log-side', x, y, groove ? shade(COLOURS.log, .78) : COLOURS.log, 6));
  }
  return t;
}
function logTop() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    const base = d > 6.5 ? COLOURS.log : Math.round(d) % 2 ? COLOURS.log_ring : shade(COLOURS.log_ring, .84);
    put(t, x, y, jittered('log-top', x, y, base, 5));
  }
  return t;
}
function leaves() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const r = rnd('leaf', x, y);
    put(t, x, y, jittered('leaves', x, y, r < .18 ? shade(COLOURS.leaves, .62) : r > .9 ? shade(COLOURS.leaves, 1.25) : COLOURS.leaves, 8));
  }
  return t;
}
// Planks: a darker seam every 4th row, and board ends offset row by row.
export const plankSeam = y => y % 4 === 3;
function planks() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const row = Math.floor(y / 4), end = (x + row * 5) % 16 === 0;
    const base = plankSeam(y) || end ? shade(COLOURS.planks, .74) : COLOURS.planks;
    put(t, x, y, jittered('planks', x, y, base, 6));
  }
  return t;
}
function water() { return fill(texture(TEX, TEX), 'water', COLOURS.water, 6); }
function sand() { return fill(texture(TEX, TEX), 'sand', COLOURS.sand, 6); }
function cloud() { return fill(texture(TEX, TEX), 'cloud', [250, 250, 252], 3); }
// A flower sprite (two crossed planes): a stem, two leaves and a head of petals; the rest is cut out.
function flower(kind) {
  const t = texture(TEX, TEX), c = COLOURS[kind];
  for (let y = 7; y < TEX; y++) put(t, 7, y, jittered(kind + 's', 7, y, COLOURS.stem, 6));
  put(t, 6, 11, COLOURS.stem); put(t, 5, 10, COLOURS.stem); put(t, 8, 12, COLOURS.stem); put(t, 9, 11, COLOURS.stem);
  for (const [x, y] of [[7, 3], [6, 4], [8, 4], [7, 5], [6, 6], [8, 6], [5, 5], [9, 5], [7, 4]]) put(t, x, y, jittered(kind, x, y, c, 8));
  put(t, 7, 5, [255, 236, 140]);
  return t;
}
// Our own blast crate (no other game's explosive block): red-orange boards with yellow and black hazard stripes on the
// sides, a dark lid with a fuse hole on top.
function crateSide() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    let base = [196, 62, 40];
    if (y >= 6 && y <= 9) base = ((x + y) >> 1) % 2 ? [24, 22, 26] : [244, 196, 46];
    if (y === 0 || y === TEX - 1 || x === 0 || x === TEX - 1) base = [120, 36, 26];
    put(t, x, y, jittered('crate', x, y, base, 5));
  }
  return t;
}
function crateTop() {
  const t = fill(texture(TEX, TEX), 'crate-top', [120, 36, 26], 5);
  for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) put(t, x, y, [30, 26, 28]);
  return t;
}
function cakeSide() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const base = y < 4 ? [250, 248, 244] : y === 4 && x % 3 === 0 ? [250, 248, 244] : y > 11 ? [170, 104, 62] : [214, 150, 92];
    put(t, x, y, jittered('cake', x, y, base, 4));
  }
  return t;
}
function cakeTop() {
  const t = fill(texture(TEX, TEX), 'cake-top', [250, 248, 244], 3);
  for (let n = 0; n < 7; n++) put(t, 2 + Math.floor(rnd('cherry', n, 0) * 12), 2 + Math.floor(rnd('cherry', n, 1) * 12), [214, 40, 56]);
  return t;
}
function lantern() {
  const t = texture(TEX, TEX);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
    const frame = x < 2 || x > 13 || y < 2 || y > 13 || x === 7 || x === 8;
    put(t, x, y, jittered('lantern', x, y, frame ? [62, 56, 60] : [255, 214, 120], frame ? 4 : 6));
  }
  return t;
}

const MAKERS = {
  grass_top: grassTop, grass_side: grassSide, dirt, stone, ore_copper: () => ore('ore_copper'), ore_gem: () => ore('ore_gem'),
  log_side: logSide, log_top: logTop, leaves, planks, water, sand, cloud, flower_red: () => flower('petal_red'),
  flower_yellow: () => flower('petal_yellow'), crate_side: crateSide, crate_top: crateTop, cake_side: cakeSide, cake_top: cakeTop, lantern,
};
export const TEXTURES = Object.keys(MAKERS);
const made = new Map();
export function blockTexture(name) {
  if (!MAKERS[name]) throw new Error(`No block texture ${name}`);
  if (!made.has(name)) made.set(name, MAKERS[name]());
  return made.get(name);
}

// Each block's faces: [top, bottom, side] texture names. `water` shows its top only; flowers are crossed sprites.
export const BLOCKS = {
  grass: { faces: ['grass_top', 'dirt', 'grass_side'] }, dirt: { faces: ['dirt', 'dirt', 'dirt'] },
  stone: { faces: ['stone', 'stone', 'stone'] }, ore_copper: { faces: ['ore_copper', 'ore_copper', 'ore_copper'] },
  ore_gem: { faces: ['ore_gem', 'ore_gem', 'ore_gem'] }, log: { faces: ['log_top', 'log_top', 'log_side'] },
  leaves: { faces: ['leaves', 'leaves', 'leaves'] }, planks: { faces: ['planks', 'planks', 'planks'] },
  sand: { faces: ['sand', 'sand', 'sand'] }, cloud: { faces: ['cloud', 'cloud', 'cloud'], glow: .4 },
  water: { faces: ['water', null, null], liquid: true }, crate: { faces: ['crate_top', 'crate_top', 'crate_side'] },
  cake: { faces: ['cake_top', 'cake_side', 'cake_side'] }, lantern: { faces: ['lantern', 'lantern', 'lantern'], glow: .9 },
  flower_red: { sprite: 'flower_red' }, flower_yellow: { sprite: 'flower_yellow' },
};

// -- character skins: one texture per box face, 1 pixel per P (a sixteenth of a block) ------------------------------------
//
// Box sizes in P (the reference's classic proportions): head 8 x 8 x 8, torso 8 wide x 4 deep x 12 tall, arms and legs
// 4 x 4 x 12. Faces: front, back, left, right (the figure's own sides), top, bottom. The head's front is the face plane
// (faceTexture below, 16 x 16, two pixels per P); its other faces are drawn here at 2 pixels per P too, for crisper hair.
export const OUTFIT_DETAILS = ['none', 'zip', 'stripe', 'heart', 'star', 'pocket'];
export const HAIR_STYLES = ['short', 'long', 'tuft', 'bald'];
export const SKIN_FACES = ['front', 'back', 'left', 'right', 'top', 'bottom'];

function plain(w, h, seed, colour, amount = 4) { return fill(texture(w, h), seed, colour, amount); }
// The torso: shirt all round, the detail on the front (a zip, a stripe, a pixel heart or star, a pocket).
function torso(o, face) {
  const w = face === 'left' || face === 'right' ? 4 : 8, h = face === 'top' || face === 'bottom' ? 4 : 12;
  const t = plain(w, h, `shirt:${o.shirt}:${face}`, rgb(o.shirt), 4), d = rgb(o.detail);
  if (face === 'top') for (let x = 2; x < 6; x++) put(t, x, 1, rgb(o.skin));             // the neck
  if (o.detail_style === 'stripe' && h === 12) for (let x = 0; x < w; x++) for (const y of [5, 6]) put(t, x, y, jittered('stripe', x, y, d, 3));
  if (face !== 'front') return t;
  if (o.detail_style === 'zip') { for (let y = 1; y < 12; y++) put(t, 3, y, shade(d, y % 2 ? 1 : .86)); put(t, 4, 2, d); }
  if (o.detail_style === 'heart') for (const [x, y] of [[2, 3], [3, 3], [5, 3], [6, 3], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [3, 5], [4, 5], [5, 5], [4, 6]]) put(t, x, y, d);
  if (o.detail_style === 'star') for (const [x, y] of [[4, 2], [3, 3], [4, 3], [5, 3], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [3, 5], [5, 5]]) put(t, x, y, d);
  if (o.detail_style === 'pocket') { for (let x = 1; x < 4; x++) for (let y = 3; y < 6; y++) put(t, x, y, shade(d, y === 3 ? .8 : 1)); }
  // The waist: a belt row in the pants colour, so shirt and legs meet cleanly.
  for (let x = 0; x < w; x++) put(t, x, 11, shade(rgb(o.pants), 1.05));
  return t;
}
// An arm: the sleeve, then the skin hand in the bottom 4 pixels; the top is the shoulder, the bottom the palm.
function arm(o, face) {
  const h = face === 'top' || face === 'bottom' ? 4 : 12;
  if (face === 'bottom') return plain(4, 4, 'palm', shade(rgb(o.skin), .94), 3);
  const t = plain(4, h, `sleeve:${o.shirt}:${face}`, rgb(o.shirt), 4);
  if (h === 12) {
    for (let y = 8; y < 12; y++) for (let x = 0; x < 4; x++) put(t, x, y, jittered('hand', x, y, rgb(o.skin), 3));
    for (let x = 0; x < 4; x++) put(t, x, 7, shade(rgb(o.shirt), .8));                    // the cuff
  }
  return t;
}
// A leg: pants, then the shoe in the bottom 3 pixels; the sole underneath.
function leg(o, face) {
  if (face === 'bottom') return plain(4, 4, 'sole', shade(rgb(o.shoes), .7), 3);
  const h = face === 'top' ? 4 : 12, t = plain(4, h, `pants:${o.pants}:${face}`, rgb(o.pants), 4);
  if (h === 12) {
    for (let y = 9; y < 12; y++) for (let x = 0; x < 4; x++) put(t, x, y, jittered('shoe', x, y, y === 11 ? shade(rgb(o.shoes), .72) : rgb(o.shoes), 3));
    if (face === 'front') put(t, 1, 9, shade(rgb(o.shoes), 1.25));                        // a lace highlight
  }
  return t;
}
// The head's sides, back, top and bottom at 2 pixels per P: hair on the top and back and down to row 6 on the sides
// (`long` hair runs to the bottom at the back; `tuft` adds a few pixels up front on top; `bald` is skin).
function head(o, face) {
  const t = plain(16, 16, `head:${o.skin}:${face}`, rgb(o.skin), 3), hair = rgb(o.hair);
  if (o.hair_style === 'bald' || face === 'bottom') return t;
  const rows = face === 'top' ? 16 : face === 'back' ? (o.hair_style === 'long' ? 16 : 12) : 6;
  for (let y = 0; y < rows; y++) for (let x = 0; x < 16; x++) {
    // A ragged lower edge on the sides and back.
    if (face !== 'top' && y === rows - 1 && rnd('hairline', face, x) > .55) continue;
    put(t, x, y, jittered(`hair:${o.hair}`, x, y, hair, 6));
  }
  if (face === 'left' || face === 'right') for (const y of [6, 7]) put(t, face === 'left' ? 14 : 1, y, jittered('sideburn', y, 0, hair, 4));   // the sideburn by the face
  return t;
}
const PARTS = { head, torso, arm, leg };
export function skinTexture(outfit, part, face) {
  if (!PARTS[part] || !SKIN_FACES.includes(face)) throw new Error(`No skin face ${part}.${face}`);
  return PARTS[part](outfit, face);
}
// Long hair: a slab behind the head (8 wide, 2 deep, 10 tall in P), hair all round.
export function hairSlab(outfit) { return plain(8, 10, `slab:${outfit.hair}`, rgb(outfit.hair), 7); }

// -- the face: a 16 x 16 texture on the head's front --------------------------------------------------------------------
//
// Rows 0 to 3 are the hairline (hair colour, a ragged lower edge; none when bald); the eyes are 2 pixels wide at x 3-4
// and 11-12 on row 7; brows sit two rows above them; the mouth sits on rows 10 to 13. Every mood has a closed and an
// open version: the open one shows while the character talks (the mouth follows the voice's level).
export const MOODS = ['neutral', 'happy', 'smug', 'angry', 'scared', 'sad', 'crying', 'shocked', 'laughing', 'splat'];
export const EYES = ['normal', 'wide', 'smug', 'happy', 'shut', 'angry'];
export const BROWS = ['none', 'up', 'down', 'sad'];
export const MOUTHS = ['line', 'smirk', 'frown', 'o', 'open', 'wail', 'laugh', 'grin'];
// mood: [eyes, brows, closed mouth, open mouth, tears]
export const MOOD_FACE = {
  neutral: ['normal', 'none', 'line', 'open', false], happy: ['happy', 'up', 'grin', 'laugh', false],
  smug: ['smug', 'down', 'smirk', 'open', false], angry: ['angry', 'down', 'frown', 'open', false],
  scared: ['wide', 'sad', 'o', 'wail', false], sad: ['normal', 'sad', 'frown', 'open', false],
  crying: ['shut', 'sad', 'frown', 'wail', true], shocked: ['wide', 'up', 'o', 'open', false],
  laughing: ['happy', 'up', 'grin', 'laugh', false], splat: ['shut', 'sad', 'frown', 'wail', false],
};
export const TEAR = [120, 190, 255];
const EYE_X = [3, 11];

// The face as cells [x, y, colour key]: keys skin, hair, white, pupil, brow, mouth, tongue, teeth, tear, cream, red.
export function faceCells(mood, open = false, look = 0, blink = false) {
  const [eyes0, brows, closed, opened, tears] = MOOD_FACE[mood] || MOOD_FACE.neutral;
  const eyes = blink && eyes0 !== 'shut' && eyes0 !== 'happy' ? 'shut' : eyes0;
  const cells = [], at = (x, y, k) => cells.push([x, y, k]);
  const rect = (x, y, w, h, k) => { for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) at(x + a, y + b, k); };
  const l = Math.max(-1, Math.min(1, Math.round(look)));       // pupils look left (-1) or right (1)
  for (const x of EYE_X) {
    // The pupil is the inner pixel (towards the nose) when looking ahead, else the pixel on the side looked at.
    const inner = x < 8 ? x + 1 : x, pupil = l < 0 ? x : l > 0 ? x + 1 : inner;
    if (eyes === 'normal' || eyes === 'angry' || eyes === 'smug') { at(x, 7, x === pupil ? 'pupil' : 'white'); at(x + 1, 7, x + 1 === pupil ? 'pupil' : 'white'); }
    if (eyes === 'smug') rect(x, 6, 2, 1, 'lid');                                  // a heavy lid: half shut, pleased with itself
    else if (eyes === 'wide') { rect(x, 6, 2, 2, 'white'); at(pupil, 7, 'pupil'); }
    else if (eyes === 'happy') { rect(x, 6, 2, 1, 'pupil'); at(x - 1, 7, 'pupil'); at(x + 2, 7, 'pupil'); }   // ^ ^
    else if (eyes === 'shut') rect(x, 7, 2, 1, 'pupil');
  }
  if (brows === 'up') for (const x of EYE_X) rect(x, 4, 2, 1, 'brow');
  if (brows === 'down') { at(3, 5, 'brow'); at(4, 6, 'brow'); at(12, 5, 'brow'); at(11, 6, 'brow'); }
  if (brows === 'sad') { at(3, 6, 'brow'); at(4, 5, 'brow'); at(12, 6, 'brow'); at(11, 5, 'brow'); }
  if (eyes === 'angry') { at(4, 6, 'brow'); at(11, 6, 'brow'); }
  if (tears) for (const x of [3, 12]) for (let y = 8; y <= 14; y++) if (y % 3 !== 1) at(x, y, 'tear');
  const m = open ? opened : closed;
  if (m === 'line') rect(6, 11, 4, 1, 'mouth');
  else if (m === 'smirk') { rect(6, 11, 3, 1, 'mouth'); at(9, 10, 'mouth'); }
  else if (m === 'frown') { rect(6, 11, 4, 1, 'mouth'); at(5, 12, 'mouth'); at(10, 12, 'mouth'); }
  else if (m === 'grin') { at(5, 10, 'mouth'); rect(6, 11, 4, 1, 'mouth'); at(10, 10, 'mouth'); }
  else if (m === 'o') { rect(7, 10, 2, 2, 'mouth'); }
  else if (m === 'open') { rect(6, 10, 4, 3, 'mouth'); rect(7, 12, 2, 1, 'tongue'); }
  else if (m === 'wail') { rect(5, 10, 6, 4, 'mouth'); rect(6, 13, 4, 1, 'tongue'); rect(6, 10, 4, 1, 'mouth'); }
  else if (m === 'laugh') { rect(5, 10, 6, 3, 'mouth'); rect(5, 10, 6, 1, 'teeth'); rect(7, 12, 2, 1, 'tongue'); }
  if (mood === 'splat') for (const [x, y] of [[2, 2], [3, 2], [4, 3], [6, 1], [7, 2], [8, 2], [11, 3], [12, 4], [13, 3], [9, 5], [10, 6], [5, 8], [6, 9], [12, 9], [13, 10],
    [2, 10], [3, 11], [8, 14], [9, 13], [4, 13], [11, 12], [14, 7], [1, 6], [7, 6], [8, 5]]) at(x, y, (x + y) % 4 ? 'cream' : 'red');
  return cells;
}

// The whole face texture (16 x 16): skin, the hairline, then the cells. `colours` maps keys to RGB.
export function faceTexture(outfit, mood, open = false, look = 0, blink = false) {
  const t = plain(16, 16, `face:${outfit.skin}`, rgb(outfit.skin), 3);
  const hair = rgb(outfit.hair), skin = rgb(outfit.skin);
  if (outfit.hair_style !== 'bald') for (let x = 0; x < 16; x++) {
    const low = 2 + (rnd('fringe', outfit.hair_style, x) > .6 ? 1 : 0) + (outfit.hair_style === 'tuft' && x > 9 ? 1 : 0);
    for (let y = 0; y <= Math.min(3, low); y++) put(t, x, y, jittered(`hair:${outfit.hair}`, x, y, hair, 6));
  }
  const colours = { white: [246, 246, 246], pupil: rgb(outfit.eyes), brow: shade(hair, .8), mouth: [72, 30, 28], tongue: [214, 64, 72],
    teeth: [250, 250, 246], tear: TEAR, lid: shade(skin, .82), skin2: skin, cream: [252, 250, 244], red: [214, 40, 56] };
  for (const [x, y, k] of faceCells(mood, open, look, blink)) put(t, x, y, colours[k]);
  return t;
}
