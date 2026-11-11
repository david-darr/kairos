// Pack C classic (David, 2026-11-10, closer to the block-game reference he shared; see the Video Styles build spec,
// "Pack C classic as built"): the classic block world, its blocky characters, their poses, the effects and the cameras,
// as data. Nothing here draws: static/motion/classic3d.js draws it with three.js; blocks.js holds every pixel texture.
//
// Units: one block is 1. A character is 32 P tall (P = 1/16 block): two blocks. Z is up; the default camera looks along
// +Y; a character facing the camera faces -Y. Block (i, j, k) fills [i, i+1] x [j, j+1] x [k, k+1]; the ground the cast
// stands on is the top of k = -1 (z = 0). Every key is constant: poses change in steps (the motion snaps, never eases),
// as the reference asks; only the camera's small push uses a smoothstep.
//
// Distance rules (Video Styles spec, Pack C): no other game's textures, skins, sounds or names. The textures are drawn in
// code (blocks.js), the characters are our own (core/character_store.py, form `block`), the blast crate is our own design.
import { clamp, hash } from './kit.js';
import { BLOCKS, MOODS } from './blocks.js';

export const P = 1 / 16;
export const HEIGHT = 32 * P;            // a character is two blocks tall
export const PLACES = ['meadow', 'cliff', 'village', 'party', 'cave', 'beach', 'sky-island'];
export const TIMES = ['day', 'dusk'];
export const POSES = ['idle', 'walk', 'run', 'hips', 'despair', 'flail', 'hang', 'wave', 'shove', 'nod', 'point', 'cheer', 'cry',
  'laugh', 'shrug', 'think', 'sit'];
export const SHOTS = ['close', 'medium', 'wide', 'low', 'top', 'orbit'];
export const FX = ['fuse', 'blast', 'splat', 'fall', 'pop'];
export const PROPS = ['crate', 'cake', 'lantern', 'balloon', 'table'];
export const SFX = ['boom', 'splat', 'sting', 'riser', 'pop', 'whoosh', 'impact', 'steps', 'gasp'];
export { MOODS };
// The reference's lenses (vertical field of view, degrees): closes 40 to 44, mediums 46 to 52, wides 56, low angle 44.
export const FOV = { close: 42, medium: 49, wide: 56, low: 44, top: 50, orbit: 52 };
export const KEY_RATE = 7.6;             // a held key lasts about 4 frames at 30 fps: walk keys at 1.9 Hz x 4 a cycle
export const CUT_EARLY = .06;            // a cut lands this long before the word it hangs on
export const LIMITS = { cast: 4, shots: 3, fx: 4, props: 6, sfx: 6, changes: 6, debris: 140, smoke: 22, splat: 26 };
const TAU = Math.PI * 2, DEG = Math.PI / 180;

const rnd = (seed, ...k) => (hash(`${seed}:${k.join(',')}`) % 100003) / 100003;
const round = v => Math.round(v * 1e4) / 1e4;
const one = (v, list, fallback) => list.includes(v) ? v : fallback;
const num = (v, lo, hi, fallback) => Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? clamp(Number(v), lo, hi) : fallback;
const smoothstep = x => { x = clamp(x); return x * x * (3 - 2 * x); };
// A held key: time snapped down to the key grid of `rate` keys a second.
export const keyed = (t, rate = KEY_RATE) => Math.floor(t * rate + 1e-6) / rate;

// -- value noise for terrain ----------------------------------------------------------------------------------------------
function noise(seed, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, s = v => v * v * (3 - 2 * v);
  const a = rnd(seed, x0, y0), b = rnd(seed, x0 + 1, y0), c = rnd(seed, x0, y0 + 1), d = rnd(seed, x0 + 1, y0 + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}
const fbm = (seed, x, y) => .65 * noise(seed, x, y) + .35 * noise(seed + '+', x * 2.1, y * 2.1);

// -- the world ------------------------------------------------------------------------------------------------------------
//
// A world: `blocks` (Map 'i,j,k' -> block name), `sprites` (flowers), `clouds` (flat boxes), `marks` (named places such as
// the cliff's edge), the sky and the light. Built from the place and a seed, deterministically.
export const SKY = {
  day: { horizon: [178, 214, 255], top: [96, 156, 245], sun: [1, .96, .9], sunPower: 3.2, world: .6, fog: [190, 220, 255] },
  dusk: { horizon: [255, 188, 140], top: [92, 96, 190], sun: [1, .78, .58], sunPower: 2.4, world: .45, fog: [236, 178, 150] },
  cave: { horizon: [26, 22, 34], top: [14, 12, 20], sun: [1, .9, .76], sunPower: .45, world: .22, fog: [24, 20, 30] },
};
const key = (i, j, k) => `${i},${j},${k}`;
export const X0 = -26, X1 = 26, Y0 = -10, Y1 = 44;

function column(blocks, i, j, top, kinds, depth = 4) {
  // From the surface block (top - 1) down `depth` blocks: grass on top, dirt for 3, stone below (or the place's own kinds).
  for (let n = 0; n < depth; n++) {
    const k = top - 1 - n;
    blocks.set(key(i, j, k), typeof kinds === 'function' ? kinds(n, k) : kinds[Math.min(n, kinds.length - 1)]);
  }
}
const SOIL = (n) => n === 0 ? 'grass' : n < 3 ? 'dirt' : 'stone';
function tree(world, i, j, base, seed) {
  // A 4 to 6 block log with a diamond of leaves around and over its top.
  const tall = 4 + Math.floor(rnd(seed, 'tall', i, j) * 3);
  for (let k = 0; k < tall; k++) world.blocks.set(key(i, j, base + k), 'log');
  const top = base + tall;
  for (let dk = -2; dk <= 1; dk++) {
    const r = dk <= -1 ? 2 : dk === 0 ? 1 : 0;
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.abs(di) + Math.abs(dj) > r + (dk === -2 ? 1 : 0)) continue;
      if (dk < 0 && di === 0 && dj === 0) continue;
      const k2 = key(i + di, j + dj, top + dk);
      if (!world.blocks.has(k2)) world.blocks.set(k2, 'leaves');
    }
  }
  world.blocks.set(key(i, j, top), 'leaves');
}
function flowers(world, seed, count, area, ground, avoid = () => false) {
  for (let n = 0; n < count; n++) {
    const i = Math.floor(area[0] + (area[1] - area[0]) * rnd(seed, 'fi', n)), j = Math.floor(area[2] + (area[3] - area[2]) * rnd(seed, 'fj', n));
    if (avoid(i, j)) continue;
    const z = ground(i, j);
    if (z === null || world.blocks.has(key(i, j, z))) continue;
    world.sprites.push({ x: i + .5, y: j + .5, z, sprite: n % 3 ? 'flower_red' : 'flower_yellow' });
  }
}
function clouds(world, seed, count, z = 34) {
  for (let n = 0; n < count; n++) {
    world.clouds.push({ x: round(-70 + 140 * rnd(seed, 'cx', n)), y: round(18 + 90 * rnd(seed, 'cy', n)), z: z + Math.floor(rnd(seed, 'cz', n) * 3),
      w: 6 + Math.floor(rnd(seed, 'cw', n) * 10), d: 4 + Math.floor(rnd(seed, 'cd', n) * 6) });
  }
}
function house(world, i0, j0, seed, w = 7, d = 6, tall = 4) {
  // Plank walls with log corners, a door gap and two window gaps on the front (-Y side), a stepped plank roof.
  for (let a = 0; a < w; a++) for (let b = 0; b < d; b++) for (let k = 0; k < tall; k++) {
    const edge = a === 0 || a === w - 1 || b === 0 || b === d - 1;
    if (!edge) continue;
    const corner = (a === 0 || a === w - 1) && (b === 0 || b === d - 1);
    const door = b === 0 && a === Math.floor(w / 2) && k < 2, win = b === 0 && (a === 1 || a === w - 2) && k === 1;
    if (door || win) continue;
    world.blocks.set(key(i0 + a, j0 + b, k), corner ? 'log' : 'planks');
  }
  for (let layer = 0; layer < Math.ceil(d / 2) + 1; layer++) for (let a = -1; a <= w; a++) for (const b of [layer - 1, d - layer]) {
    if (b < -1 || b > d) continue;
    world.blocks.set(key(i0 + a, j0 + b, tall + layer), layer === Math.ceil(d / 2) ? 'log' : 'planks');
  }
  for (let layer = 0; layer < Math.ceil(d / 2) + 1; layer++) for (let a = -1; a <= w; a++) for (let b = layer - 1; b <= d - layer; b++)
    if (!world.blocks.has(key(i0 + a, j0 + b, tall + layer)) && (a === -1 || a === w)) world.blocks.set(key(i0 + a, j0 + b, tall + layer), 'planks');
  world.marks.houses.push({ x: i0 + w / 2, y: j0, w, d, tall, door: [i0 + Math.floor(w / 2) + .5, j0 - .5] });
}

function flatLand(world, seed, { hills = 3, rise = .12, stage = true } = {}) {
  // Grass land with soft hills that rise away from the camera; the stage (where the cast stands) is flat at z = 0.
  const tops = new Map();
  for (let j = Y0; j < Y1; j++) for (let i = X0; i < X1; i++) {
    const x = i + .5, y = j + .5, onStage = stage && Math.abs(x) < 9 && y > -4 && y < 6;
    let h = onStage ? 0 : Math.round((fbm(seed, x / 9, y / 9) - .45) * hills + Math.max(0, y - 8) * rise);
    if (!onStage && y < 3) h = Math.min(0, h);
    h = clamp(h, -2, 12);
    tops.set(`${i},${j}`, h);
  }
  for (const [ij, h] of tops) {
    const [i, j] = ij.split(',').map(Number);
    // Fill down to the lowest neighbour so no side shows a hole.
    let low = h;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) low = Math.min(low, tops.get(`${i + di},${j + dj}`) ?? h - 1);
    column(world.blocks, i, j, h, SOIL, Math.max(2, h - low + 2));
  }
  return (i, j) => tops.has(`${i},${j}`) ? tops.get(`${i},${j}`) : null;
}

export function worldModel(place, seed = 0, time = 'day') {
  const s = `${place}:${seed}`;
  const world = { place, seed, time: place === 'cave' ? 'cave' : time, blocks: new Map(), sprites: [], clouds: [], marks: { houses: [] }, lanterns: [] };
  if (place === 'meadow' || place === 'village' || place === 'party') {
    const ground = flatLand(world, s, { hills: place === 'meadow' ? 5 : 2 });
    const clear = (i, j) => Math.abs(i + .5) < 10 && j > -6 && j < 7;
    if (place !== 'meadow') {
      // A stone path towards the houses, the houses behind the stage.
      for (let j = -2; j < 14; j++) for (const i of [-1, 0]) world.blocks.set(key(i, j, -1), 'stone');
      house(world, -14, 10, s + 'a'); house(world, 5, 9, s + 'b', 8, 6, 4); house(world, -4, 18, s + 'c', 6, 5, 4);
    } else {
      // A pond off to one side.
      for (let j = 8; j < 14; j++) for (let i = 9; i < 16; i++) if (Math.hypot(i - 12, (j - 11) * 1.3) < 3.4) { world.blocks.set(key(i, j, -1), 'water'); world.blocks.set(key(i, j, -2), 'dirt'); }
    }
    const spots = [[-12, 4], [13, 3], [-19, 12], [18, 14], [-8, 22], [10, 24], [-22, 26], [22, 30], [0, 32], [-15, 34], [15, 38]];
    spots.forEach(([i, j], n) => { if (rnd(s, 'tree', n) > .15 && !clear(i, j)) { const g = ground(i, j); if (g !== null && !world.blocks.has(key(i, j, g))) tree(world, i, j, g, s + n); } });
    flowers(world, s, 60, [X0 + 2, X1 - 2, -8, 20], ground, (i, j) => Math.abs(i + .5) < 3 && j < 5);
    if (place === 'party') {
      // A long table with the cake on it, balloons tied around.
      for (let i = 2; i < 6; i++) world.blocks.set(key(i, 2, 0), 'planks');
      world.marks.table = { x: 4, y: 2.5, z: 1 };
    }
    clouds(world, s, 14);
  } else if (place === 'cliff') {
    // A grass plateau for y >= 0 whose face drops to a valley 28 blocks down, facing the camera (-Y). Stone with ore
    // specks shows in the face; the valley has grass, trees and a stream.
    const drop = 28;
    const ground = (i, j) => j >= 0 ? 0 : -drop;
    for (let j = Y0 - 20; j < Y1; j++) for (let i = X0; i < X1; i++) {
      if (j >= 0) {
        const h = Math.abs(i + .5) < 12 && j < 8 ? 0 : Math.round(clamp((fbm(s, i / 8, j / 8) - .45) * 3 + Math.max(0, j - 10) * .1, -1, 8));
        const depth = j < 3 ? drop + h + 1 : 4;
        column(world.blocks, i, j, h, (n, k) => n === 0 ? 'grass' : n < 3 ? 'dirt' : rnd(s, 'ore', i, j, k) > .965 ? (rnd(s, 'ore2', i, k) > .5 ? 'ore_copper' : 'ore_gem') : 'stone', depth);
      } else if (j >= Y0 - 20) {
        const stream = Math.abs(i - 4 - Math.sin(j / 5) * 3) < 1.6 && j < -6;
        column(world.blocks, i, j, -drop, stream ? ['water', 'dirt'] : SOIL, 2);
      }
    }
    // Ragged edge: a few blocks stick out of the face near the top, and a few are missing.
    for (let i = X0; i < X1; i++) for (let k = -drop; k < -1; k++) if (rnd(s, 'ledge', i, k) > .985 && Math.abs(i) > 3) world.blocks.set(key(i, -1, k), 'stone');
    for (const [i, j] of [[-10, 4], [11, 5], [-18, 12], [16, 16], [-6, 20], [8, 26], [-14, -18], [12, -16], [-22, -12], [20, -24], [2, -26]])
      tree(world, i, j, ground(i, j), s + i + j);
    flowers(world, s, 40, [X0 + 2, X1 - 2, 1, 18], (i, j) => world.blocks.has(key(i, j, -1)) && !world.blocks.has(key(i, j, 0)) ? 0 : null, (i) => Math.abs(i + .5) < 3);
    world.marks.edge = { y: 0, z: 0 };
    world.marks.drop = drop;
    clouds(world, s, 16);
  } else if (place === 'cave') {
    // A stone chamber open towards the camera: floor, walls and a ceiling with ore specks, lanterns for light.
    for (let j = -6; j < 26; j++) for (let i = -16; i < 16; i++) {
      const wall = Math.abs(i + .5) > 9 + 2 * noise(s, j / 4, 1) || j > 20 + 2 * noise(s, i / 4, 2);
      const ceiling = 7 + Math.round(noise(s + 'c', i / 3, j / 3) * 2);
      const stoneOr = (k) => rnd(s, 'ore', i, j, k) > .94 ? (rnd(s, 'o2', i, j) > .5 ? 'ore_copper' : 'ore_gem') : 'stone';
      if (wall) { for (let k = -1; k <= ceiling; k++) world.blocks.set(key(i, j, k), stoneOr(k)); continue; }
      world.blocks.set(key(i, j, -1), Math.abs(i + .5) < 9 && j < 2 ? 'stone' : stoneOr(-1));
      world.blocks.set(key(i, j, -2), 'stone');
      if (j > -2) world.blocks.set(key(i, j, ceiling), stoneOr(ceiling));
    }
    for (const [i, j] of [[-6, 6], [6, 8], [-3, 16], [4, 14]]) { world.blocks.set(key(i, j, 0), 'lantern'); world.lanterns.push([i + .5, j + .5, .5]); }
  } else if (place === 'beach') {
    // A sand island in water, a tree, flowers on a grass patch.
    for (let j = Y0; j < Y1; j++) for (let i = X0; i < X1; i++) {
      const d = Math.hypot(i + .5, (j - 3) * 1.2), r = 11 + 2 * noise(s, Math.atan2(j - 3, i) * 2 + 4, 1);
      if (d < r) column(world.blocks, i, j, d < r - 6 && j > 6 ? 1 : 0, d < r - 7 && j > 6 ? SOIL : ['sand', 'sand', 'stone'], 3);
      else { world.blocks.set(key(i, j, -1), 'water'); world.blocks.set(key(i, j, -3), 'sand'); }
    }
    tree(world, 6, 10, 1, s + 't'); tree(world, -7, 12, 1, s + 'u');
    clouds(world, s, 14);
  } else {
    // sky-island: a floating island of grass and dirt over a stone underside that narrows downwards.
    for (let j = -8; j < 16; j++) for (let i = -14; i < 14; i++) {
      const d = Math.hypot(i + .5, (j - 3) * 1.25), r = 12 + 2 * noise(s, Math.atan2(j - 3, i) * 2 + 4, 1);
      if (d >= r) continue;
      const depth = 2 + Math.round((1 - d / r) * 9 + noise(s, i / 3, j / 3) * 2);
      column(world.blocks, i, j, 0, SOIL, depth);
    }
    tree(world, -7, 8, 0, s + 't'); tree(world, 8, 9, 0, s + 'u');
    flowers(world, s, 30, [-12, 12, -6, 14], (i, j) => world.blocks.has(key(i, j, -1)) && !world.blocks.has(key(i, j, 0)) ? 0 : null, (i, j) => Math.abs(i + .5) < 3 && j < 5);
    clouds(world, s, 20, 8);
    clouds(world, s + 'low', 10, -14);
  }
  world.sky = SKY[world.time] || SKY.day;
  return world;
}

// The surface under (x, y): the z of the top of the highest solid block in that column at or below `from`.
export function groundAt(world, x, y, from = 3) {
  const i = Math.floor(x), j = Math.floor(y);
  for (let k = Math.floor(from); k > -40; k--) {
    const b = world.blocks.get(key(i, j, k));
    if (b && b !== 'water') return k + 1;
    if (b === 'water') return k + .88;
  }
  return 0;
}

// Blocks taken out by blasts: every block within `r` of the blast's centre (sphere), not deeper than 4 under it.
export function blastSet(world, blast) {
  const out = [], [cx, cy, cz] = blast.pos, r = blast.radius;
  for (let i = Math.floor(cx - r); i <= Math.ceil(cx + r); i++) for (let j = Math.floor(cy - r); j <= Math.ceil(cy + r); j++)
    for (let k = Math.floor(cz - r); k <= Math.ceil(cz + r); k++) {
      const b = world.blocks.get(key(i, j, k));
      if (!b || b === 'water' || k < cz - 4) continue;
      const d = Math.hypot(i + .5 - cx, j + .5 - cy, k + .5 - cz);
      if (d <= r) out.push({ i, j, k, block: b, d });
    }
  return out.sort((a, b) => a.d - b.d || a.k - b.k || a.i - b.i || a.j - b.j).slice(0, LIMITS.debris);
}

// -- the mesher: faces only where no neighbour hides them, gathered per texture -------------------------------------------
//
// Returns { texture name: { positions, normals, uvs, count } } of quads (two triangles each, non-indexed). Water shows
// its top only, dropped 0.12; flowers are two crossed quads with cut-out pixels. `skip` (a Set of keys) leaves blocks out
// (blown away by a blast).
const FACES = [
  { n: [0, 0, 1], side: 0, quad: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },          // top
  { n: [0, 0, -1], side: 1, quad: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },         // bottom
  { n: [0, -1, 0], side: 2, quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },         // front (towards the camera)
  { n: [0, 1, 0], side: 2, quad: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]] },          // back
  { n: [-1, 0, 0], side: 2, quad: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },         // left
  { n: [1, 0, 0], side: 2, quad: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },          // right
];
const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
const opaque = name => !!name && name !== 'water' && !BLOCKS[name]?.sprite;
export function meshWorld(world, skip = null) {
  const out = {};
  const add = (tex, corners, n) => {
    const m = out[tex] || (out[tex] = { positions: [], normals: [], uvs: [], count: 0 });
    for (const idx of [0, 1, 2, 0, 2, 3]) { m.positions.push(...corners[idx]); m.normals.push(...n); m.uvs.push(...UV[idx]); }
    m.count++;
  };
  for (const [k, name] of world.blocks) {
    if (skip && skip.has(k)) continue;
    const [i, j, z] = k.split(',').map(Number), def = BLOCKS[name];
    if (!def) continue;
    if (name === 'water') {
      const above = world.blocks.get(key(i, j, z + 1));
      if (above && !(skip && skip.has(key(i, j, z + 1)))) continue;
      add('water', FACES[0].quad.map(([a, b]) => [i + a, j + b, z + .88]), [0, 0, 1]);
      continue;
    }
    for (const f of FACES) {
      const nk = key(i + f.n[0], j + f.n[1], z + f.n[2]), nb = world.blocks.get(nk);
      if (opaque(nb) && !(skip && skip.has(nk))) continue;
      const tex = def.faces[f.side];
      if (!tex) continue;
      add(tex, f.quad.map(([a, b, c]) => [i + a, j + b, z + c]), f.n);
    }
  }
  for (const s of world.sprites) {
    const r = .45;
    for (const [dx, dy] of [[1, 1], [1, -1]]) {
      const ax = dx * r * Math.SQRT1_2, ay = dy * r * Math.SQRT1_2;
      add(s.sprite, [[s.x - ax, s.y - ay, s.z], [s.x + ax, s.y + ay, s.z], [s.x + ax, s.y + ay, s.z + .9], [s.x - ax, s.y - ay, s.z + .9]], [0, -1, 0]);
    }
  }
  return out;
}

// -- the classic blocky character --------------------------------------------------------------------------------------------
//
// The reference's proportions, in P: torso 8 x 4 x 12, head an 8 P cube on a neck pivot, arms 4 x 4 x 12 from shoulder
// pivots at (+-6 P, 0, 10 P) over the body pivot, legs 4 x 4 x 12 from hip pivots at (+-2 P, 0, 0) under it, the body pivot
// 12 P up. Each box face wears its own texture (blocks.js skinTexture); the head's front is the face (faceTexture).
export const BODY = { pivot: 12 * P, torso: [8 * P, 4 * P, 12 * P], head: 8 * P, limb: [4 * P, 4 * P, 12 * P],
  shoulder: [6 * P, 0, 10 * P], hip: [2 * P, 0, 0], neck: 12 * P };
export function blockPlan() {
  // Heights from the feet (z), for the checks and the cameras: core/character_checks.py block_plan repeats them.
  return { H: HEIGHT, hip: BODY.pivot, chest: BODY.pivot + 6 * P, neck: BODY.pivot + BODY.neck, head: BODY.pivot + BODY.neck + 4 * P,
    eyes: BODY.pivot + BODY.neck + 4.5 * P, top: HEIGHT, width: BODY.torso[0] + 2 * BODY.limb[0], body_half: BODY.torso[0] / 2,
    // Where the checks sample: the shirt low on the torso (under any chest detail, above the belt) and the skin between
    // the eyes and the mouth; br is half the torso with both sleeves (core/character_checks.py block_plan, kept equal by a test).
    zb: 14.5 * P, face: 27.75 * P, zh: 28 * P, br: 8 * P };
}
const PLAN = blockPlan();
// One character's parts: boxes with their group, centre (in the group's frame), size and a texture per face.
export function blockCharacter(id, outfit, { headset = null } = {}) {
  const T = (part, faces = ['front', 'back', 'left', 'right', 'top', 'bottom']) => Object.fromEntries(faces.map(f => [f, `${id}:${part}:${f}`]));
  const parts = [
    { name: 'torso', group: 'body', pos: [0, 0, 6 * P], size: BODY.torso, tex: T('torso') },
    { name: 'head', group: 'head', pos: [0, 0, 4 * P], size: [8 * P, 8 * P, 8 * P], tex: { ...T('head'), front: `${id}:face` } },
    { name: 'arm_l', group: 'arm_l', pos: [0, 0, -4 * P], size: BODY.limb, tex: T('arm') },
    { name: 'arm_r', group: 'arm_r', pos: [0, 0, -4 * P], size: BODY.limb, tex: T('arm') },
    { name: 'leg_l', group: 'leg_l', pos: [0, 0, -6 * P], size: BODY.limb, tex: T('leg') },
    { name: 'leg_r', group: 'leg_r', pos: [0, 0, -6 * P], size: BODY.limb, tex: T('leg') },
  ];
  if (outfit.hair_style === 'long') parts.push({ name: 'hair', group: 'head', pos: [0, 5 * P, 3 * P], size: [8 * P, 2 * P, 10 * P], tex: Object.fromEntries(['front', 'back', 'left', 'right', 'top', 'bottom'].map(f => [f, `${id}:slab`])) });
  if (headset) {
    // The avatar's box headset: a band over the top and two cups in the speaker's colour.
    parts.push({ name: 'band', group: 'head', pos: [0, 0, 8.5 * P], size: [9 * P, 2 * P, 1 * P], colour: '#24222a' });
    for (const [n, sx] of [['cup_l', -1], ['cup_r', 1]]) parts.push({ name: n, group: 'head', pos: [sx * 4.8 * P, 0, 3.5 * P], size: [1.8 * P, 4 * P, 4.5 * P], colour: headset });
    parts.push({ name: 'mic', group: 'head', pos: [-4.2 * P, -3.2 * P, 1.2 * P], size: [.8 * P, 4 * P, .8 * P], colour: '#24222a' });
  }
  // Group pivots in the character's own frame (feet at the origin).
  const groups = {
    root: { parent: null, pivot: [0, 0, 0] }, body: { parent: 'root', pivot: [0, 0, BODY.pivot] },
    head: { parent: 'body', pivot: [0, 0, BODY.pivot + BODY.neck] },
    arm_l: { parent: 'body', pivot: [-BODY.shoulder[0], 0, BODY.pivot + BODY.shoulder[2]] }, arm_r: { parent: 'body', pivot: [BODY.shoulder[0], 0, BODY.pivot + BODY.shoulder[2]] },
    leg_l: { parent: 'root', pivot: [-BODY.hip[0], 0, BODY.pivot] }, leg_r: { parent: 'root', pivot: [BODY.hip[0], 0, BODY.pivot] },
  };
  return { id, outfit, parts, groups, plan: blockPlan() };
}

// -- poses: every key constant ------------------------------------------------------------------------------------------
//
// A pose at t: rotations in radians for body (lean), head, arms and legs, and the root's offset; all computed from t
// snapped to the pose's key grid, so they change in steps. The reference's numbers: walk 1.9 Hz (legs +-34, arms +-31
// degrees), run 3.0 Hz (+-55, a 10 degree lean), a turn of 0.22 to 0.25 s.
const square4 = (t, hz) => [0, 1, 0, -1][Math.floor(t * hz * 4 + 1e-6) % 4];    // a cycle as four held keys
export function poseAt(pose, t, { talking = false, phase = 0 } = {}) {
  const q = { body: [0, 0, 0], head: [0, 0, 0], arm_l: [0, 0, 0], arm_r: [0, 0, 0], leg_l: [0, 0, 0], leg_r: [0, 0, 0], lift: 0, bob: 0 };
  const tt = t + phase;
  switch (pose) {
    case 'walk': { const s = square4(tt, 1.9); q.leg_l[0] = 34 * DEG * s; q.leg_r[0] = -34 * DEG * s; q.arm_l[0] = -31 * DEG * s; q.arm_r[0] = 31 * DEG * s; q.lift = s ? P : 0; break; }
    case 'run': { const s = square4(tt, 3); q.leg_l[0] = 55 * DEG * s; q.leg_r[0] = -55 * DEG * s; q.arm_l[0] = -50 * DEG * s; q.arm_r[0] = 50 * DEG * s; q.body[0] = 10 * DEG; q.lift = s ? 1.5 * P : 0; break; }
    case 'hips': q.arm_l = [.12, .5, 0]; q.arm_r = [.12, -.5, 0]; q.body[1] = .04; break;
    case 'despair': q.head[0] = .45; q.arm_l = [-2.6, -.38, 0]; q.arm_r = [-2.6, .38, 0]; q.body[0] = .18; break;   // hands to the head, head down
    case 'flail': { const k = Math.floor(tt * 6 + 1e-6) % 2; q.arm_l = [-2.8 + k * 1.4, .45, 0]; q.arm_r = [-1.4 - k * 1.4, -.45, 0]; q.leg_l[0] = (k ? .5 : -.4); q.leg_r[0] = (k ? -.4 : .5); q.head[2] = k ? .2 : -.2; break; }
    case 'hang': { const k = Math.floor(tt * 3 + 1e-6) % 2; q.arm_l = [-3.32, -.1, 0]; q.arm_r = [-3.32, .1, 0]; q.leg_l[0] = k ? .35 : -.25; q.leg_r[0] = k ? -.25 : .35; q.head[0] = -.12; break; }
    case 'wave': { const k = Math.floor(tt * 2.5 * 2 + 1e-6) % 2; q.arm_r = [-2.75, k ? -.5 : .05, 0]; q.head[1] = .06; break; }
    case 'shove': { const k = t < .12 ? 0 : 1; q.arm_l = [-.6 - .95 * k, -.12 * k, 0]; q.arm_r = [-.6 - .95 * k, .12 * k, 0]; q.body[0] = .18 * k; q.leg_l[0] = -.3 * k; q.leg_r[0] = .3 * k; break; }
    case 'nod': break;
    case 'point': q.arm_r = [-1.55, .1, 0]; break;
    case 'cheer': { const k = Math.floor(tt * 4 + 1e-6) % 2; q.arm_l = [-2.9, .4, 0]; q.arm_r = [-2.9, -.4, 0]; q.lift = k ? 3 * P : 0; break; }
    case 'cry': { const k = Math.floor(tt * 3 + 1e-6) % 2; q.arm_l = [-1.95, -.62, 0]; q.arm_r = [-1.95, .62, 0]; q.head[0] = .1 + k * .05; q.body[0] = .08 + k * .04; break; }
    case 'laugh': { const k = Math.floor(tt * 5 + 1e-6) % 2; q.arm_l = [-.55, -.45, 0]; q.arm_r = [-.55, .45, 0]; q.head[0] = k ? -.3 : -.12; q.body[0] = k ? -.12 : 0; break; }
    case 'shrug': q.arm_l = [-.6, .85, 0]; q.arm_r = [-.6, -.85, 0]; q.head[1] = .15; break;
    case 'think': q.arm_r = [-2.3, .5, 0]; q.head[1] = .14; q.head[0] = -.1; break;
    case 'sit': q.leg_l[0] = -1.5; q.leg_r[0] = -1.5; q.lift = -12 * P; break;
    default: break;
  }
  // A talker nods on held keys; idle figures breathe in two steps so nothing is ever frozen.
  if (talking && pose !== 'flail' && pose !== 'hang') q.head[0] += [0, .1, 0, .05][Math.floor(tt * 4 + 1e-6) % 4];
  if (pose === 'nod') q.head[0] += [0, .22, 0, .22][Math.floor(tt * 3 + 1e-6) % 4];
  if (pose === 'idle' || pose === 'hips') { q.arm_l[2] -= Math.floor(tt * 1.2 + 1e-6) % 2 ? .04 : 0; q.arm_r[2] += Math.floor(tt * 1.2 + 1e-6) % 2 ? .04 : 0; }
  return q;
}

// -- the story: words, keys and times ----------------------------------------------------------------------------------------
//
// A time inside a beat is given as {word: n} (the line's n-th word) or {t: seconds}. With the line's aligned word times
// (beat.words, seconds from the beat's start) a word means its start; a cut lands CUT_EARLY before it. Without word
// times, words share the line's speech by letters.
export function wordStarts(beat) {
  if (Array.isArray(beat.words) && beat.words.length) return beat.words.map(w => w.start - beat.start);
  const words = String(beat.say || '').split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  const speech = Math.max(.2, (beat.speech || (beat.end - beat.start) - .4));
  const total = words.reduce((n, w) => n + w.length + 1, 0) || 1;
  let at = beat.lead ?? .06;
  return words.map(w => { const s = at; at += speech * (w.length + 1) / total; return s; });
}
export function timeOf(beat, ref, { cut = false } = {}) {
  if (!ref || typeof ref !== 'object') return 0;
  const length = beat.end - beat.start;
  if (Number.isFinite(ref.t)) return clamp(ref.t, 0, length);
  if (Number.isFinite(ref.word)) {
    const starts = wordStarts(beat), n = clamp(Math.floor(ref.word), 0, Math.max(0, starts.length - 1));
    return clamp((starts[n] ?? 0) + (ref.after || 0) - (cut ? CUT_EARLY : 0), 0, length);
  }
  return 0;
}

// Defensive copy of a story beat's `story` (core/video_store.py _story validates it).
// {word: n, after: s}: s seconds after the word starts (a wave a moment after "bye").
const ref = v => v && typeof v === 'object' ? (Number.isFinite(Number(v.word)) && v.word !== null ? { word: Math.max(0, Math.floor(Number(v.word))), after: num(v.after, 0, 3, 0) } : { t: num(v.t, 0, 60, 0) }) : null;
const facing = v => typeof v === 'number' ? clamp(v, -180, 180) : ['camera', 'left', 'right', 'away', 'c0', 'c1', 'c2', 'c3'].includes(v) ? v : 'camera';
export function normalizeStory(input) {
  const s = input && typeof input === 'object' ? input : {};
  const cast = (Array.isArray(s.cast) ? s.cast : []).slice(0, LIMITS.cast).filter(m => m && typeof m.character === 'string').map((m, i, all) => ({
    character: m.character.slice(0, 12), x: num(m.x, -12, 12, all.length === 1 ? 0 : -1.6 + 3.2 * i / Math.max(1, all.length - 1)), y: num(m.y, -6, 12, 0),
    pose: one(m.pose, POSES, 'idle'), mood: one(m.mood, MOODS, 'neutral'), face: facing(m.face),
    changes: (Array.isArray(m.changes) ? m.changes : []).slice(0, LIMITS.changes).filter(c => c && typeof c === 'object').map(c => ({
      at: ref(c.at) || { t: 0 }, pose: one(c.pose, POSES, undefined), mood: one(c.mood, MOODS, undefined), face: c.face === undefined ? undefined : facing(c.face) })),
    move: m.move && typeof m.move === 'object' ? { to: [num(m.move.to?.[0], -14, 14, 0), num(m.move.to?.[1], -8, 14, 0)], at: ref(m.move.at) || { t: 0 },
      run: m.move.run === true } : null,
    leave: m.leave && typeof m.leave === 'object' ? { at: ref(m.leave.at) || { t: 0 } } : null })) ;
  return {
    place: one(s.place, PLACES, 'meadow'), seed: Math.round(num(s.seed, 0, 999, 0)), time: one(s.time, TIMES, 'day'), cast,
    shots: (Array.isArray(s.shots) && s.shots.length ? s.shots : [{}]).slice(0, LIMITS.shots).map((sh, i) => ({
      shot: one(sh?.shot, SHOTS, 'medium'), on: Math.round(num(sh?.on, 0, LIMITS.cast - 1, 0)), with: sh?.with === undefined ? null : Math.round(num(sh.with, 0, LIMITS.cast - 1, 0)),
      at: i === 0 ? { t: 0 } : (ref(sh?.at) || { t: 0 }), push: num(sh?.push, 0, .6, .3), shake: sh?.shake === true, side: sh?.side === 'left' || sh?.side === 'right' ? sh.side : null })),
    fx: (Array.isArray(s.fx) ? s.fx : []).slice(0, LIMITS.fx).filter(f => f && FX.includes(f.kind)).map(f => ({
      kind: f.kind, at: ref(f.at) || { t: 0 }, on: f.on === undefined ? null : Math.round(num(f.on, 0, LIMITS.cast - 1, 0)),
      x: num(f.x, -14, 14, 0), y: num(f.y, -8, 16, 0), radius: num(f.radius, 1, 5, 3), seconds: num(f.seconds, .3, 4, 1.6) })),
    props: (Array.isArray(s.props) ? s.props : []).slice(0, LIMITS.props).filter(p => p && PROPS.includes(p.kind)).map(p => ({
      kind: p.kind, x: num(p.x, -14, 14, 0), y: num(p.y, -8, 16, 0), colour: typeof p.colour === 'string' && /^#[0-9a-f]{6}$/i.test(p.colour) ? p.colour : null })),
    sfx: (Array.isArray(s.sfx) ? s.sfx : []).slice(0, LIMITS.sfx).filter(f => f && SFX.includes(f.kind)).map(f => ({ kind: f.kind, at: ref(f.at) || { t: 0 } })),
    keys: (Array.isArray(s.keys) ? s.keys : []).slice(0, 8).filter(k => typeof k === 'string').map(k => k.toLowerCase().replace(/[^a-z0-9']/g, '').slice(0, 24)).filter(Boolean),
  };
}

// The shot on screen at t (seconds into the beat): its index and when it started.
export function shotAt(beat, t) {
  const shots = beat.story.shots;
  let index = 0;
  for (let i = 1; i < shots.length; i++) if (t >= timeOf(beat, shots[i].at, { cut: true })) index = i;
  return { index, shot: shots[index], start: index ? timeOf(beat, shots[index].at, { cut: true }) : 0,
    end: index + 1 < shots.length ? timeOf(beat, shots[index + 1].at, { cut: true }) : beat.end - beat.start };
}

// -- one beat's scene as data --------------------------------------------------------------------------------------------
//
// `characters` maps an id to {spec}; `blasts` are blasts in earlier beats at the same place (their blocks stay gone).
export function storyModel(beat, characters, blasts = []) {
  const v = beat.story, world = worldModel(v.place, v.seed, v.time);
  const gone = new Set();
  for (const b of blasts) for (const x of blastSet(world, b)) gone.add(key(x.i, x.j, x.k));
  const actors = v.cast.map((m, i) => {
    const spec = characters[m.character]?.spec;
    const hang = m.pose === 'hang' || m.changes.some(c => c.pose === 'hang');
    const edge = world.marks.edge;
    const z = hang && edge ? edge.z - 34 * P : groundAt(world, m.x, m.y);
    return { key: `c${i}`, index: i, character: m.character, member: m, outfit: spec?.outfit || null, colour: spec?.colour || '#ffffff',
      place: { x: m.x, y: hang && edge ? edge.y - 5 * P : m.y, z }, model: spec?.outfit ? blockCharacter(m.character, spec.outfit) : null };
  });
  // The beat's blasts (fx), resolved to world positions now so the renderer and the checks agree.
  const fx = v.fx.map(f => {
    const target = f.on !== null ? actors[f.on] : null;
    const pos = target ? [target.place.x, target.place.y, target.place.z] : [f.x, f.y, groundAt(world, f.x, f.y)];
    return { ...f, pos: [pos[0], pos[1], pos[2] + (f.kind === 'blast' ? .5 : 0)] };
  });
  const own = fx.filter(f => f.kind === 'blast').map(f => ({ pos: f.pos, radius: f.radius, at: f.at }));
  const debris = own.map(b => blastSet({ ...world, blocks: new Map([...world.blocks].filter(([k]) => !gone.has(k))) }, b));
  return { beat: beat.id, world, gone, actors, fx, blasts: own, debris, props: v.props.map(p => ({ ...p, z: groundAt(world, p.x, p.y) })) };
}

// Where a cast member is and how it stands at t: position, yaw (radians; 0 faces the camera) and the pose's groups.
export function memberAt(model, beat, actor, t, speaking) {
  const m = actor.member;
  let pose = m.pose, mood = m.mood, face = m.face;
  for (const c of m.changes) if (t >= timeOf(beat, c.at)) { pose = c.pose ?? pose; mood = c.mood ?? mood; face = c.face ?? face; }
  let { x, y, z } = actor.place, yaw = 0, walking = false;
  // A move: walk (or run) from the start place to `to`, in held steps of a quarter stride.
  if (m.move) {
    const t0 = timeOf(beat, m.move.at), [tx, ty] = m.move.to, dist = Math.hypot(tx - x, ty - y), speed = m.move.run ? 5.2 : 2.6;
    const dur = dist / speed;
    if (t >= t0) {
      const k = clamp(keyed(t - t0) / Math.max(.01, dur));
      const nx = x + (tx - x) * k, ny = y + (ty - y) * k;
      if (k < 1) { walking = true; yaw = Math.atan2(tx - x, -(ty - y)); }
      x = nx; y = ny;
    }
  }
  // Leaving: a turn of about a quarter second in two held keys, then a walk off away from the camera.
  if (m.leave) {
    const t0 = timeOf(beat, m.leave.at);
    if (t >= t0) {
      const k = t - t0;
      yaw = k < .12 ? Math.PI / 2 : Math.PI;
      if (k >= .24) { walking = true; const d = keyed(k - .24) * 2.8; y += d; x += 0; }
    }
  }
  if (!walking && !(m.leave && t >= timeOf(beat, m.leave.at))) {
    const target = typeof face === 'string' && face[0] === 'c' ? model.actors[Number(face[1])] : null;
    if (typeof face === 'number') yaw = face * DEG;
    else if (face === 'left') yaw = -Math.PI / 2;
    else if (face === 'right') yaw = Math.PI / 2;
    else if (face === 'away') yaw = Math.PI;
    else if (target && target !== actor) yaw = Math.atan2(target.place.x - x, -(target.place.y - y));
  }
  if (walking && pose !== 'run') pose = m.move?.run ? 'run' : 'walk';
  // A fall (fx) drops the member: z = -0.5 * 13 * t^2 from its start, flailing.
  for (const f of model.fx) if (f.kind === 'fall' && f.on === actor.index) {
    const t0 = timeOf(beat, f.at);
    if (t >= t0) { const k = t - t0; z -= .5 * 13 * k * k; pose = 'flail'; mood = mood === 'neutral' ? 'scared' : mood; y -= .9 * Math.min(k, .5); }
  }
  let splat = false;
  for (const f of model.fx) if (f.kind === 'splat' && f.on === actor.index && t >= timeOf(beat, f.at) + .05) { splat = true; }
  const q = poseAt(pose, t, { talking: speaking, phase: actor.index * .13 });
  // Listeners look at whoever speaks (head only), when they face the camera.
  return { x, y, z: z + q.lift, yaw, pose, mood: splat ? 'splat' : mood, q };
}

// -- effects ------------------------------------------------------------------------------------------------------------------
//
// fuse: the crate pops (a held scale key) and a white overlay flashes at a rate that speeds up from 3 to 12 Hz, then the
// blast. blast: the blocks within its radius are launched by their distance (spinning, gravity 20), 22 smoke cubes swell and
// rise, an orange light decays e^(-7t), the camera shakes 0.22 e^(-3.2t). splat: 26 small cubes (3 white to 1 red) and a
// splat face. fall: see memberAt. pop: a puff of 8 white cubes.
export function fuseAt(f, t) {
  const t0 = f.t0, k = t - t0;
  if (k < 0) return { visible: true, scale: 1, flash: 0 };
  const dur = f.seconds, p = clamp(k / dur), hz = 3 + 9 * p;
  // The flash: on for the first half of each cycle at the current rate (held, not faded).
  const phase = (3 * k + 4.5 * k * k / dur) % 1;    // the integral of 3 + 9 k / dur
  return { visible: k < dur, scale: k < .1 ? 1.12 : 1, flash: k < dur && phase < .5 ? .7 : 0, hz };
}
export function debrisAt(list, blast, t0, t) {
  const k = t - t0;
  if (k < 0) return [];
  return list.map((b, n) => {
    const r = rnd(`debris:${b.i},${b.j},${b.k}`, n), r2 = rnd('d2', b.i, b.j, b.k), r3 = rnd('d3', b.i, b.j, b.k);
    const cx = b.i + .5 - blast.pos[0], cy = b.j + .5 - blast.pos[1], cz = b.k + .5 - blast.pos[2], d = Math.max(.3, Math.hypot(cx, cy, cz));
    const speed = 9 + 7 * (1 - Math.min(1, d / (blast.radius + .5))) + 4 * r;
    const vx = cx / d * speed * .8 + (r2 - .5) * 3, vy = cy / d * speed * .8 - 2.5 * r3, vz = 6 + 8 * r + Math.max(0, cz / d) * 5;
    const z = b.k + .5 + vz * k - .5 * 20 * k * k;
    return { block: b.block, pos: [b.i + .5 + vx * k, b.j + .5 + vy * k, Math.max(-40, z)], rot: [(r - .5) * 14 * k, (r2 - .5) * 14 * k, (r3 - .5) * 10 * k], scale: .5 + .5 * r3 };
  });
}
export function smokeAt(blast, t0, t, count = LIMITS.smoke) {
  const k = t - t0;
  if (k < 0 || k > 3.2) return [];
  return Array.from({ length: count }, (_, n) => {
    const a = rnd('smoke', n) * TAU, r = .4 + 2.2 * rnd('smoke-r', n), up = .6 + 2.4 * rnd('smoke-u', n);
    const grow = .5 + 1.8 * Math.min(1, k / .8) * (.6 + .4 * rnd('smoke-s', n));
    return { pos: [blast.pos[0] + Math.cos(a) * r * Math.min(1, k * 2), blast.pos[1] + Math.sin(a) * r * Math.min(1, k * 2), blast.pos[2] + up * Math.min(1.5, k * 1.5) + .4 * k],
      size: grow, shade: .55 + .3 * rnd('smoke-c', n), alpha: clamp(1.1 - k / 3) };
  });
}
export const blastLight = (t0, t) => t < t0 ? 0 : Math.exp(-7 * (t - t0));
export const blastShake = (t0, t) => t < t0 ? 0 : .22 * Math.exp(-3.2 * (t - t0));
export function splatAt(pos, t0, t, count = LIMITS.splat) {
  const k = t - t0;
  if (k < 0 || k > 1.4) return [];
  return Array.from({ length: count }, (_, n) => {
    const a = rnd('splat', n) * TAU, up = rnd('splat-u', n), sp = 2.2 + 3 * rnd('splat-s', n);
    return { pos: [pos[0] + Math.cos(a) * sp * k, pos[1] + Math.sin(a) * sp * k * .6 - .3 * k, pos[2] + (2 + 4 * up) * k - .5 * 20 * k * k],
      colour: n % 4 === 3 ? '#d62838' : '#fbf9f4', size: .1 + .1 * rnd('splat-z', n) };
  }).filter(c => c.pos[2] > pos[2] - 2.5);
}

// -- cameras -------------------------------------------------------------------------------------------------------------------
//
// From the shot and where the cast is at t. A two-person shot looks across the line between them (perpendicular to it);
// a close frames the head and shoulders; the low angle sits under the subject looking up; the top shot looks straight down
// past the subject; orbit circles a falling subject. Every shot pushes in by `push` with a smoothstep over its length;
// `shake` jitters a panicky close; a blast shakes 0.22 e^(-3.2t).
export function storyCamera(model, beat, t, poses, w, h) {
  const { shot: sh, start, end } = shotAt(beat, t), p = smoothstep((t - start) / Math.max(.1, end - start));
  const subject = poses[sh.on] || poses[0] || { x: 0, y: 0, z: 0, yaw: 0 };
  const other = sh.with !== null ? poses[sh.with] : poses.find((q, i) => i !== sh.on) || null;
  const head = [subject.x, subject.y, subject.z + 28 * P], chest = [subject.x, subject.y, subject.z + 18 * P];
  let dir;       // from the target towards the camera (unit, on the ground plane)
  const level = other && Math.abs(other.z - subject.z) < 1;
  if (other && level && (sh.shot === 'medium' || sh.shot === 'wide' || sh.with !== null)) {
    const dx = other.x - subject.x, dy = other.y - subject.y, l = Math.hypot(dx, dy) || 1;
    dir = [-dy / l, dx / l];
    if (dir[1] > 0) dir = [-dir[0], -dir[1]];          // the camera side (-Y)
    // Turn a little towards the subject's front so the face reads (about 28 degrees off the perpendicular).
    const turn = (dx * dir[1] - dy * dir[0] > 0 ? -1 : 1) * .5;
    dir = [dir[0] * Math.cos(turn) - dir[1] * Math.sin(turn), dir[0] * Math.sin(turn) + dir[1] * Math.cos(turn)];
  } else {
    // In front of the subject, a little to one side so the box head reads in depth.
    const a = subject.yaw + (sh.shot === 'close' ? .32 : sh.shot === 'low' ? .12 : 0);
    dir = [Math.sin(a), -Math.cos(a)];
  }
  if (sh.side === 'left') dir = [-.5, -.86]; else if (sh.side === 'right') dir = [.5, -.86];
  const fov = FOV[sh.shot];
  let target, distance, height;
  if (sh.shot === 'close') { target = [head[0], head[1], head[2] - 3.5 * P]; distance = 2.65; height = .18; }
  else if (sh.shot === 'medium') { target = other && sh.with !== null ? mid(chest, [other.x, other.y, other.z + 18 * P]) : [chest[0], chest[1], chest[2] + 2 * P]; distance = other && sh.with !== null ? 4.6 : 3.9; height = .35; }
  else if (sh.shot === 'wide') { target = other ? mid(chest, [other.x, other.y, other.z + 14 * P]) : chest; distance = 9 + (other ? Math.hypot(other.x - subject.x, other.y - subject.y) * .7 : 0); height = 2.4; }
  else if (sh.shot === 'low') { target = [head[0], head[1], head[2] - 2 * P]; distance = 3.1; height = -1.7; }
  else if (sh.shot === 'top') { target = [subject.x, subject.y - .25, subject.z + 26 * P]; distance = .55; height = 3.6; }
  else { target = [head[0], head[1], head[2] - 6 * P]; distance = 3.7; height = -.35; }
  distance -= sh.push * p * (sh.shot === 'wide' ? 1.6 : 1);
  let pos;
  if (sh.shot === 'orbit') {
    const a = -Math.PI / 2 - .55 + (t - start) * .9;      // swings across his front, the cliff face behind him
    pos = [target[0] + Math.cos(a) * distance, target[1] + Math.sin(a) * distance, target[2] + height];
  } else pos = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + height];
  // Shakes: a panicky close jitters on held keys; a blast shakes the whole picture.
  let shake = sh.shake ? .035 : 0;
  for (const b of model.blasts) shake += blastShake(timeOf(beat, b.at), t);
  if (shake) {
    const k = Math.floor(t * 30 + 1e-6);
    const jx = (rnd('shake', k, 0) - .5) * 2 * shake, jy = (rnd('shake', k, 1) - .5) * 2 * shake, jz = (rnd('shake', k, 2) - .5) * 2 * shake;
    pos = [pos[0] + jx, pos[1] + jy, pos[2] + jz]; target = [target[0] + jx * .6, target[1] + jy * .6, target[2] + jz * .6];
  }
  return { pos: pos.map(round), target: target.map(round), fov, up: sh.shot === 'top' ? [0, 1, 0] : [0, 0, 1], shot: sh.shot, index: shotAt(beat, t).index, subject: sh.on };
}
const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);

// A world point to pixels with a vertical field of view: [x, y from the top, depth], for labels and the checks.
export function projectV(camera, point, w, h) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
  const f = norm(sub(camera.target, camera.pos)), r = norm(cross(f, camera.up || [0, 0, 1])), u = cross(r, f), d = sub(point, camera.pos);
  const z = dot(d, f), tv = Math.tan(camera.fov * DEG / 2), th = tv * w / h;
  if (z <= 1e-4) return [NaN, NaN, z];
  return [(dot(d, r) / (z * th) + 1) / 2 * w, (1 - dot(d, u) / (z * tv)) / 2 * h, z];
}

// Everything that moves in a story beat at t: each member's pose, the camera, the effects' state.
export function storyPose(model, beat, t, w, h, speakerKey = beat.speaker) {
  const poses = model.actors.map(a => memberAt(model, beat, a, t, a.character === speakerKey && t < (beat.speechEnd ?? Infinity)));
  const camera = storyCamera(model, beat, t, poses, w, h);
  const effects = [];
  // A fuse burns until the beat's blast when there is one (its flashing speeds up to the bang), else for its own seconds.
  const bang = model.blasts.length ? timeOf(beat, model.blasts[0].at) : null;
  for (const f of model.fx) {
    const t0 = timeOf(beat, f.at);
    if (f.kind === 'fuse') effects.push({ kind: 'fuse', pos: f.pos, ...fuseAt({ ...f, t0, seconds: bang !== null && bang > t0 ? bang - t0 : f.seconds }, t) });
    if (f.kind === 'pop' && t >= t0 && t < t0 + .6) effects.push({ kind: 'pop', cubes: splatAt([f.pos[0], f.pos[1], f.pos[2] + 1], t0, t, 8).map(c => ({ ...c, colour: '#f4f4f4' })) });
  }
  model.blasts.forEach((b, n) => {
    const t0 = timeOf(beat, b.at);
    effects.push({ kind: 'blast', index: n, blown: t >= t0, debris: debrisAt(model.debris[n], b, t0, t), smoke: smokeAt(b, t0, t), light: blastLight(t0, t), pos: b.pos });
  });
  for (const f of model.fx) if (f.kind === 'splat') {
    const t0 = timeOf(beat, f.at), target = f.on !== null ? poses[f.on] : null;
    const at = target ? [target.x, target.y - .3, target.z + 28 * P] : f.pos;
    effects.push({ kind: 'splat', cubes: splatAt(at, t0, t) });
  }
  return storyFaces(model, beat, { beat: beat.id, t, poses, camera, effects }, t);
}

// -- the avatar strip's room -----------------------------------------------------------------------------------------------------
//
// A dark gaming room (wall 34, 30, 52), shelves with coloured boxes, a black chair, a blue-white monitor light from below
// the camera, three LED strips and a rim light in the speaker's colour; the speaker sits chest-up with a box headset.
export const ROOM = { wall: [34, 30, 52], monitor: [190, 214, 255] };
export function roomModel(seed = 0) {
  const boxes = [];
  const shelf = (x, z) => { boxes.push({ pos: [x, 2.6, z], size: [2.4, .5, .08], colour: '#3e3550' }); for (let n = 0; n < 4; n++) boxes.push({ pos: [x - .9 + n * .6 + (rnd(seed, 'b', x, z, n) - .5) * .1, 2.55, z + .18], size: [.34, .3, .28 + .12 * rnd(seed, 'h', x, z, n)], colour: ['#e0574f', '#4fb0e0', '#f2c14e', '#7ad17a', '#c67be8'][Math.floor(rnd(seed, 'c', x, z, n) * 5)] }); };
  shelf(-2.1, 2.5); shelf(2.2, 2.9); shelf(-2.4, 1.6);
  return { boxes, wall: { y: 3, z: [0, 5], x: [-6, 6] }, chair: [{ pos: [0, .8, 1.45], size: [1.25, .3, 1.6], colour: '#151318' }, { pos: [-.72, .4, .85], size: [.2, .9, .2], colour: '#151318' }, { pos: [.72, .4, .85], size: [.2, .9, .2], colour: '#151318' }],
    leds: [{ pos: [0, 2.95, 2.78], size: [5.2, .05, .07] }, { pos: [-2.3, 2.95, 1.55], size: [.07, .05, 2.4] }, { pos: [2.3, 2.95, 1.55], size: [.07, .05, 2.4] }] };
}
// The avatar camera at t: chest-up, zoom 1.10, breathing 1.2%, a small pop for 0.15 s when the speaker changes.
export function avatarCamera(t, sinceChange) {
  const breathe = 1 + .012 * Math.sin(TAU * t / 3.2), pop = sinceChange < .15 ? 1.045 : 1;
  const fov = 31 / 1.10 / breathe / pop;
  return { pos: [0, -3.35, 1.62], target: [0, 0, 1.5], fov: round(fov), up: [0, 0, 1] };
}

// -- faces, listeners, labels and boxes ------------------------------------------------------------------------------------

// The mouth from the voice's level (core/video_mouth.py codes, one a frame): open on open shapes, held two frames at least.
export function openFrames(codes, hold = 2) {
  const open = Array.from(codes || '', c => 'AEOF'.includes(c) ? 1 : 0);
  let i = 0;
  while (i < open.length) {
    let j = i;
    while (j < open.length && open[j] === open[i]) j++;
    if (j - i < hold && i > 0) for (let k = i; k < j; k++) open[k] = open[i - 1];
    i = j;
  }
  return open;
}
// A blink: the eyes shut for three frames every 2.6 to 4.2 s (held keys, never a fade).
export function blinking(seed, t) {
  let at = .8 + rnd(seed, 'blink', 0) * 1.6;
  for (let n = 1; at < t + 1 && n < 200; n++) { if (t >= at && t < at + .1) return true; at += 2.6 + rnd(seed, 'blink', n) * 1.6; }
  return false;
}
const mouthCache = new WeakMap();
// Faces and listeners on top of storyPose's members: the speaker's mouth opens with the voice; listeners turn their head
// towards the speaker (on held keys) unless they face away.
export function storyFaces(model, beat, pose, t) {
  if (!mouthCache.has(beat)) mouthCache.set(beat, openFrames(beat.mouth || ''));
  const open = mouthCache.get(beat), frame = Math.floor(t * 30 + 1e-6);
  const speaker = model.actors.findIndex(a => a.character === beat.speaker);
  pose.poses.forEach((q, i) => {
    const a = model.actors[i];
    q.open = i === speaker && !!open[frame];
    q.blink = !q.open && blinking(`${beat.id}:${i}`, t) && q.mood !== 'crying' && q.mood !== 'splat';
    q.look = 0;
    if (speaker >= 0 && i !== speaker && q.pose !== 'hang' && q.pose !== 'flail') {
      const s = pose.poses[speaker], want = Math.atan2(s.x - q.x, -(s.y - q.y));
      let d = want - q.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      q.q.head[2] += clamp(Math.round(d / .3) * .3, -.6, .6);
      q.look = Math.sign(Math.round(d * 2) / 2) || 0;
    }
    void a;
  });
  return pose;
}

// Each cast member's box on screen (in frame pixels, the scene's rectangle offset by `oy`), with the points the checks
// sample: the middle of the shirt (body) and the cheek (head, skin below the eyes).
export function classicBoxes(model, pose, w, h, oy = 0) {
  const out = [];
  pose.poses.forEach((q, i) => {
    const a = model.actors[i];
    if (!a?.model) return;
    const at = z => [q.x, q.y, q.z + z];
    const pts = [0, HEIGHT].flatMap(z => [-1, 1].flatMap(sx => [-1, 1].map(sy => [q.x + sx * 8 * P, q.y + sy * 4 * P, q.z + z])));
    const proj = pts.map(p => projectV(pose.camera, p, w, h)).filter(p => Number.isFinite(p[0]) && p[2] > 0);
    if (proj.length < 8) return;
    const xs = proj.map(p => p[0]), ys = proj.map(p => p[1] + oy);
    const [bx, by] = projectV(pose.camera, at(PLAN.zb), w, h), [hx, hy] = projectV(pose.camera, at(PLAN.face), w, h);
    const [fx, fy] = projectV(pose.camera, at(0), w, h), [tx, ty] = projectV(pose.camera, at(HEIGHT), w, h);
    out.push({ key: a.key, kind: 'character', character: a.character, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys), height: Math.hypot(fx - tx, fy - ty), body: { cx: bx, cy: by + oy }, head: { cx: hx, cy: hy + oy },
      facing: Math.abs(Math.atan2(Math.sin(q.yaw), Math.cos(q.yaw))) < 1.2, pose: q.pose });
  });
  return out;
}

// Floating labels over heads for a classic voxel beat (the stage's label data), projected with the vertical lens.
export function classicLabels(model, labels, pose, t, w, h) {
  const out = [];
  for (const label of labels || []) {
    if (t < label.at || label.over[0] !== 'c') continue;
    const q = pose.poses[Number(label.over[1])];
    if (!q) continue;
    const [x, y, z] = projectV(pose.camera, [q.x, q.y, q.z + HEIGHT + .35], w, h);
    if (!Number.isFinite(x) || z <= 0) continue;
    const k = clamp((t - label.at) / .3);
    out.push({ ...label, x, y, depth: z, k: k < 1 ? k * 1.1 : 1 });
  }
  return out;
}

// A Pack C voxel beat drawn in the classic look: its world, cast and shot read as a story beat with one shot and no line
// of its own (the narration is the video's narrator, as in every Pack C explainer).
const WORLD_PLACE = { meadow: 'meadow', cave: 'cave', village: 'village', 'sky-island': 'sky-island', ocean: 'beach' };
const ACTION_POSE = { idle: 'idle', wave: 'wave', point: 'point', walk: 'walk', jump: 'cheer', shrug: 'shrug', think: 'think', nod: 'nod' };
const EXPRESSION_MOOD = { neutral: 'neutral', happy: 'happy', surprised: 'shocked', worried: 'scared', thinking: 'neutral' };
export function voxelAsStory(beat) {
  const v = beat.voxel, speaking = v.cast.findIndex(m => m.speaking);
  const story = normalizeStory({
    place: WORLD_PLACE[v.world] || 'meadow', seed: v.seed, time: v.time === 'day' ? 'day' : 'dusk',
    cast: v.cast.map(m => ({ character: m.character, x: m.x * 3.2, y: 0, pose: ACTION_POSE[m.action] || 'idle', mood: EXPRESSION_MOOD[m.expression] || 'neutral',
      face: m.facing === 'camera' ? 'camera' : m.facing, changes: m.react ? [{ at: { t: m.react.at }, mood: EXPRESSION_MOOD[m.react.expression] }] : [] })),
    shots: [{ shot: v.shot, on: Math.max(0, speaking), push: beat.camera === 'push' ? .45 : beat.camera === 'pan' ? .2 : 0, shake: beat.camera === 'shake' }],
    props: v.props.filter(p => p.kind === 'crate' || p.kind === 'lantern').map(p => ({ kind: p.kind, x: p.x * 4, y: 1 + p.depth * 3 })),
  });
  return { ...beat, kind: 'story', story, speaker: speaking >= 0 ? v.cast[speaking].character : '', lead: .25, speech: 0, speechEnd: Infinity, words: [] };
}
