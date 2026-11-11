// Pack C, the blocky voxel world (Video Styles build spec, section 3 Pack C, unit 6). This module is the world as data:
// the terrain and props as boxes on a half-metre grid, the blocky characters built from boxes from their character spec,
// the sky and the light for the time of day, and every transform, face and camera position at a moment of a beat. It
// imports nothing that draws; static/motion/voxel3d.js draws it with three.js (built in). Pack C renders with three.js
// only: its faces are pixel textures drawn in code each frame, which the Blender path does not carry.
//
// Our own look, kept apart from any well-known block game on purpose (the spec's commercial rules):
// - blocks are soft, bevelled toy cubes in a pastel palette with our own names (moss, clay, lilac stone, blossom...),
//   flat colours with a gentle pillow shade; no block has a different-coloured top strip on its sides, no stone with
//   coloured specks, no planks, bricks or ore patterns;
// - characters have a big head (about 40% of their height, not a quarter), stubby limbs, rounded edges, flat colours
//   from their spec and a small pixel face with highlights in the eyes and cheeks; no skins, no hair texture;
// - round sun and moon, puffy round clouds, round stars, soft light with ambient occlusion.
//
// Coordinates are those of stage.js (Pack B): Z up, metres, the cast standing on z = 0 facing -Y, the camera in front at
// -Y; a group's transform is [px, py, pz, rx, ry, rz, sx, sy, sz] about its pivot, on top of its rest place.
import { clamp, range, inOut, hash } from './kit.js';
import { cameraAt, project, labelsAt, actorBoxes, blinkAt, HEIGHT, SHOTS, ACTIONS, EXPRESSIONS, FACINGS } from './stage.js';

export { SHOTS, ACTIONS, EXPRESSIONS, FACINGS, HEIGHT, project, labelsAt, actorBoxes };
export const WORLDS = ['meadow', 'cave', 'village', 'sky-island', 'ocean'];
export const TIMES = ['day', 'dusk', 'night'];
export const PROPS = ['gem', 'lantern', 'crate', 'flag', 'ball', 'star'];
export const B = .5;                    // one block, in metres: a character stands three blocks tall
export const LIMITS = { boxes: 40000, people: 6, props: 6, labels: 8, cast: 3 };
const TAU = Math.PI * 2;

// Our block palette. `kind`: solid (lit, matte), gloss (water), glow (unlit, lights itself). Names are ours.
export const BLOCKS = {
  moss: { color: '#8fd6a6', kind: 'solid' }, fern: { color: '#69c2a0', kind: 'solid' },
  clay: { color: '#e9a57e', kind: 'solid' }, sand: { color: '#f3dca6', kind: 'solid' },
  stone: { color: '#aaa4cb', kind: 'solid' }, slate: { color: '#7c86b6', kind: 'solid' },
  bark: { color: '#b98597', kind: 'solid' }, blossom: { color: '#f7a8c8', kind: 'solid' }, lilac: { color: '#c7b5f3', kind: 'solid' },
  palm: { color: '#5fc79f', kind: 'solid' }, cream: { color: '#f6ecd7', kind: 'solid' }, roof: { color: '#ef8a6f', kind: 'solid' },
  teal: { color: '#5bb6c8', kind: 'solid' }, door: { color: '#7a5a8c', kind: 'solid' }, path: { color: '#ecdcbc', kind: 'solid' },
  post: { color: '#8a7aa6', kind: 'solid' }, crate: { color: '#e0b27a', kind: 'solid' }, cloth: { color: '#f2777a', kind: 'solid' },
  ball: { color: '#6fb1e8', kind: 'solid' }, cloud: { color: '#ffffff', kind: 'solid' }, petal: { color: '#ffd166', kind: 'solid' },
  pink: { color: '#ff8fab', kind: 'solid' }, white: { color: '#fffaf2', kind: 'solid' },
  water: { color: '#45c4d6', kind: 'gloss' },
  window: { color: '#ffe7a3', kind: 'glow' }, lamp: { color: '#fff0c2', kind: 'glow' }, crystal: { color: '#7ff0ff', kind: 'glow' },
  rose: { color: '#f29cff', kind: 'glow' }, gem: { color: '#b48cff', kind: 'glow' }, star: { color: '#ffe066', kind: 'glow' },
};

// The sky and light for the time of day: sky gradient (top, horizon, below), the key light, the fill, fog.
export const SKIES = {
  day:   { top: '#6cb4f0', horizon: '#d4ecff', below: '#e8f4ff', key: '#fff2dc', keyPower: 2.7, fill: '#d2e8ff', ground: '#b4a69a', fillPower: 1.05, fog: '#d6ecff', exposure: 1, disc: 'sun', disc_color: '#fff6d8' },
  dusk:  { top: '#5a5cb4', horizon: '#ffb48c', below: '#ffd2b8', key: '#ffb47e', keyPower: 2.2, fill: '#ffc7a6', ground: '#6a587c', fillPower: .8, fog: '#f2b6a2', exposure: 1, disc: 'sun', disc_color: '#ffd29a' },
  night: { top: '#0d1440', horizon: '#2a3a7a', below: '#1c2758', key: '#a9bcff', keyPower: .95, fill: '#4a5aa0', ground: '#171230', fillPower: .62, fog: '#1d2858', exposure: 1.1, disc: 'moon', disc_color: '#eef2ff' },
};
const CAVE = { top: '#1a1430', horizon: '#2a2048', below: '#1a1430', fog: '#2a2048' };
const PEOPLE = ['#8ec5e8', '#f2b5c4', '#b8e0a8', '#f6d48f', '#c5b3e6', '#9fd8cf'];

const str = (v, n) => typeof v === 'string' || typeof v === 'number' ? Array.from(String(v).replace(/\s+/gu, ' ').trim()).slice(0, n).join('') : '';
const one = (v, list, fallback) => list.includes(v) ? v : fallback;
const num = (v, lo, hi, fallback) => Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), lo, hi) : fallback;
const round = v => Math.round(v * 1e4) / 1e4;

// Defensive copy of a voxel beat's `voxel` (the backend validates it; core/video_store.py _voxel).
export function normalizeVoxel(input) {
  const s = input && typeof input === 'object' ? input : {};
  const cast = (Array.isArray(s.cast) ? s.cast : []).slice(0, LIMITS.cast).filter(m => m && typeof m.character === 'string').map((m, i, all) => ({
    character: m.character.slice(0, 12), x: num(m.x, -1, 1, all.length === 1 ? 0 : -.6 + 1.2 * i / Math.max(1, all.length - 1)),
    expression: one(m.expression, EXPRESSIONS, 'neutral'), action: one(m.action, ACTIONS, 'idle'), speaking: m.speaking === true,
    facing: one(m.facing, FACINGS, 'camera'),
    react: m.react && typeof m.react === 'object' ? { at: num(m.react.at, 0, 60, 0), expression: one(m.react.expression, EXPRESSIONS, 'surprised') } : null }));
  const people = s.people && typeof s.people === 'object' ? s.people : {};
  return {
    world: one(s.world, WORLDS, 'meadow'), time: one(s.time, TIMES, 'day'), shot: one(s.shot, SHOTS, 'medium'),
    seed: Math.round(num(s.seed, 0, 999, 0)), cast,
    people: { count: Math.round(num(people.count, 0, LIMITS.people, 0)), seed: Math.round(num(people.seed, 0, 999, 0)) },
    props: (Array.isArray(s.props) ? s.props : []).slice(0, LIMITS.props).filter(p => p && PROPS.includes(p.kind)).map((p, i) => ({
      kind: p.kind, x: num(p.x, -1, 1, i % 2 ? .7 : -.7), depth: num(p.depth, 0, 1, .5) })),
    labels: (Array.isArray(s.labels) ? s.labels : []).slice(0, LIMITS.labels).filter(l => l && /^[cp][0-9]$/.test(l.over)).map(l => ({
      over: l.over, text: str(l.text, 16), sub: str(l.sub, 32), at: num(l.at, 0, 60, 0) })).filter(l => l.text),
  };
}

// -- noise -------------------------------------------------------------------------------------------------------------

const rnd = (seed, ...k) => (hash(`${seed}:${k.join(',')}`) % 100003) / 100003;
// Smooth value noise in [0, 1] on a unit lattice.
function noise(seed, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const s = v => v * v * (3 - 2 * v), a = rnd(seed, x0, y0), b = rnd(seed, x0 + 1, y0), c = rnd(seed, x0, y0 + 1), d = rnd(seed, x0 + 1, y0 + 1);
  return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
}
const fbm = (seed, x, y) => .65 * noise(seed, x, y) + .35 * noise(seed + '+', x * 2.1, y * 2.1);

// -- the world ---------------------------------------------------------------------------------------------------------

// A world is built on cells of B metres: column (i, j) is centred at (i*B, j*B); block k spans z from k*B to (k+1)*B, so a
// column of height h has its surface at z = h*B and the cast stands on h = 0. The grid is a wedge that widens away from
// the camera, so no shot or orbit sees its edge; fog takes the far end.
const Y0 = -10, Y1 = 34;
const halfWidth = y => 9 + .62 * (y - Y0);

function terrain(cells, top, under) {
  // cells: Map 'i,j' -> {i, j, h, top?, under?}. Each column is filled from its surface down to its lowest neighbour's
  // surface, so every side that shows is covered and nothing is hollow.
  const boxes = [];
  for (const c of cells.values()) {
    let low = c.h - 1;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = cells.get(`${c.i + di},${c.j + dj}`);
      low = Math.min(low, n ? n.h : c.h - 2);
    }
    low = Math.max(low, c.h - 8);
    for (let k = c.h - 1; k >= low; k--) {
      const depth = c.h - 1 - k, block = c.blocks ? c.blocks(depth, k) : depth === 0 ? (c.top || top) : (c.under || under);
      if (block) boxes.push({ x: c.i * B, y: c.j * B, z: (k + .5) * B, s: B, block });
    }
  }
  return boxes;
}
function wedge(fn) {
  const cells = new Map();
  for (let j = Math.round(Y0 / B); j <= Math.round(Y1 / B); j++) {
    const y = j * B, half = Math.round(halfWidth(y) / B);
    for (let i = -half; i <= half; i++) {
      const cell = fn(i * B, y, i, j);
      if (cell) cells.set(`${i},${j}`, { i, j, ...cell });
    }
  }
  return cells;
}
// The stage area where the cast stands (flat, clear of trees and props) and the ground in front of it (never above the
// feet, so nothing comes between the camera and the cast).
const onStage = (x, y) => Math.abs(x) < 4.6 && y > -2.2 && y < 3.2;

// A small helper to place a list of boxes; `at` is a cell's surface.
const box = (x, y, z, s, block, extra = {}) => ({ x: round(x), y: round(y), z: round(z), s, block, ...extra });

function tree(out, x, y, ground, seed, kind = 'blossom') {
  const tall = 3 + Math.floor(rnd(seed, 'tall', x, y) * 2);
  for (let k = 0; k < tall; k++) out.push(box(x, y, ground + (k + .5) * B, B, 'bark'));
  const cz = ground + (tall + 1) * B, leaf = kind === 'lilac' || rnd(seed, 'tone', x, y) > .55 ? 'lilac' : 'blossom';
  // A rounded crown: the cells inside a ball of 1.6 blocks around the crown's centre.
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -1; c <= 2; c++) {
    if (Math.hypot(a, b, c * 1.15) > 1.9) continue;
    out.push(box(x + a * B, y + b * B, cz + c * B, B, leaf));
  }
}
function palm(out, x, y, ground, lean = 1) {
  for (let k = 0; k < 6; k++) out.push(box(x + lean * .06 * k * k / 4, y, ground + (k + .5) * B * .8, B * .7, 'bark', { sz: B * .8 }));
  const tx = x + lean * .06 * 36 / 4, tz = ground + 6 * B * .8;
  for (let a = 0; a < 6; a++) {
    const ang = a / 6 * TAU + .3;
    for (let r = 1; r <= 3; r++) out.push(box(tx + Math.cos(ang) * r * B * .8, y + Math.sin(ang) * r * B * .8, tz - (r - 1) ** 1.6 * .12, B * .6, 'palm', { sz: B * .3 }));
  }
}
function house(out, x0, y0, roof, seed) {
  // Walls 6 x 5 blocks, 5 high, cream; a door and two windows on the front; a stepped roof that narrows across x.
  const w = 6, d = 5, tall = 5;
  for (let a = 0; a < w; a++) for (let b = 0; b < d; b++) for (let k = 0; k < tall; k++) {
    const edge = a === 0 || a === w - 1 || b === 0 || b === d - 1;
    if (!edge) continue;
    let block = 'cream';
    if (b === 0 && (a === 2 || a === 3) && k < 2) block = a === 2 ? 'door' : 'door';
    if (b === 0 && (a === 1 || a === 4) && k === 2) block = 'window';
    if ((a === 0 || a === w - 1) && b === 2 && k === 2) block = 'window';
    out.push(box(x0 + (a + .5) * B, y0 + (b + .5) * B, (k + .5) * B, B, block));
  }
  for (let layer = 0; layer < 3; layer++) for (let a = -1 + layer; a <= w - layer; a++) for (let b = -1; b <= d; b++)
    out.push(box(x0 + (a + .5) * B, y0 + (b + .5) * B, (tall + layer + .5) * B, B, roof));
}
function crystals(out, x, y, z, seed, glow) {
  for (let n = 0; n < 5; n++) {
    const r = rnd(seed, 'c', x, y, n), s = .12 + .16 * r;
    out.push(box(x + (rnd(seed, 'cx', n, x) - .5) * .7, y + (rnd(seed, 'cy', n, y) - .5) * .4, z + s * 1.2, s, glow, { sz: s * (1.8 + r * 1.6), tilt: (r - .5) * .9 }));
  }
}
function island(out, cx, cy, cz, R, seed, trees) {
  // A floating island: a mossy top and a stepped underside of lilac stone and slate, deepest in the middle.
  const n = Math.ceil(R / B) + 2, top = Math.round(cz / B);
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
    const x = cx + a * B, y = cy + b * B, ang = Math.atan2(b, a);
    const rr = R * (.88 + .24 * noise(seed, Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5));
    const dist = Math.hypot(a * B, b * B);
    if (dist > rr) continue;
    const bump = onStage(x, y) ? 0 : Math.max(0, Math.round((fbm(seed, x / 3, y / 3) - .5) * 3 + (y - cy) * .12));
    const depth = 1 + Math.round(Math.pow(1 - dist / rr, .7) * R * 1.3 / B * .55 + noise(seed + 'd', x, y) * 2);
    for (let k = top + bump - 1; k >= top - depth; k--) {
      const down = top + bump - 1 - k;
      // Grass only on top, lilac stone below: never a green layer over a brown one (a well-known block game's look).
      out.push(box(x, y, (k + .5) * B, B, k >= top - 1 ? 'moss' : k > top - 4 ? 'stone' : 'slate'));
    }
  }
  for (const [tx, ty] of trees) tree(out, cx + tx, cy + ty, top * B, seed);
}
function clouds(out, seed, count, area) {
  for (let n = 0; n < count; n++) {
    const x = area.x[0] + (area.x[1] - area.x[0]) * rnd(seed, 'clx', n), y = area.y[0] + (area.y[1] - area.y[0]) * rnd(seed, 'cly', n);
    const z = area.z[0] + (area.z[1] - area.z[0]) * rnd(seed, 'clz', n), size = 1.1 + 1.4 * rnd(seed, 'cls', n);
    for (let p = 0; p < 5; p++) {
      const r = size * (.55 + .45 * rnd(seed, 'clr', n, p));
      out.push({ x: round(x + (p - 2) * size * .6), y: round(y + (rnd(seed, 'cldy', n, p) - .5) * size * .6), z: round(z + r * .25), r: round(r), cloud: true });
    }
  }
}

// The world of one beat: boxes (static, drawn instanced), puffs (round cloud spheres), the lights that glow, the sky.
export function worldModel(voxel) {
  const seed = `${voxel.world}:${voxel.seed}`, boxes = [], puffs = [], glows = [];
  let water = null, enclosed = false;
  const sky = voxel.world === 'cave' ? { ...SKIES[voxel.time], ...CAVE } : SKIES[voxel.time];
  if (voxel.world === 'meadow' || voxel.world === 'village') {
    const village = voxel.world === 'village';
    const cells = wedge((x, y) => {
      let h = 0;
      if (!onStage(x, y)) {
        const rise = village ? Math.max(0, y - 14) * .22 : Math.max(0, y - 3) * .17;
        h = Math.round((fbm(seed, x / 7, y / 7) - .45) * (village ? 2 : 5) + rise);
        if (y < 1.5) h = Math.min(0, h);
        if (village && y < 13) h = Math.min(h, 0);
        h = clamp(h, -2, 14);
      }
      const path = village && ((Math.abs(x) < .9 && y > 0) || Math.hypot(x, y - .6) < 2.6);
      return { h, top: path ? 'path' : (fbm(seed + 't', x / 4, y / 4) > .55 ? 'fern' : 'moss'), under: village ? 'moss' : 'fern' };
    });
    boxes.push(...terrain(cells, 'moss', 'fern'));
    const ground = (x, y) => (cells.get(`${Math.round(x / B)},${Math.round(y / B)}`)?.h ?? 0) * B;
    if (village) {
      [[-8.6, 6.5, 'roof'], [-3.4, 9, 'teal'], [2.4, 7.5, 'roof'], [7.2, 5.5, 'teal']].forEach(([x, y, roof], n) => house(boxes, x, y, roof, seed + n));
      for (const x of [-1.6, 1.6]) {
        for (let k = 0; k < 4; k++) boxes.push(box(x, 3.4, (k + .5) * .38, .14, 'post', { sz: .38 }));
        boxes.push(box(x, 3.4, 4 * .38 + .17, .3, 'lamp'));
        glows.push({ pos: [x, 3.4, 4 * .38 + .17], color: BLOCKS.lamp.color, power: 1.2 });
      }
      for (const [x, y] of [[-12, 13], [11, 12], [-6.5, 15], [5.5, 16]]) tree(boxes, x, y, ground(x, y), seed);
    } else {
      const spots = [[-6.2, 4.2], [5.8, 5.2], [-10.5, 9], [10, 10.5], [-3.2, 12], [3.8, 14], [-14, 15], [14.5, 17], [0, 21]];
      spots.forEach(([x, y], n) => { if (rnd(seed, 'tree', n) > .12) tree(boxes, x, y, ground(x, y), seed + n); });
      // Little blooms on the grass: tiny cubes in three colours, kept off the stage and the path to the camera.
      for (let n = 0; n < 70; n++) {
        const x = (rnd(seed, 'fx', n) - .5) * 22, y = -1 + rnd(seed, 'fy', n) * 16;
        if (Math.abs(x) < 2.2 && y < 3) continue;
        const kind = ['petal', 'pink', 'white'][n % 3];
        boxes.push(box(x, y, ground(x, y) + .08, .14, kind));
      }
    }
  } else if (voxel.world === 'cave') {
    enclosed = true;
    const cells = wedge((x, y) => {
      if (Math.abs(x) > 12 || y > 13) return null;
      const wall = 5.2 + 1.6 * noise(seed, y / 2.5, 3) + (y > 8 ? -Math.min(5, (y - 8) * 1.2) : 0);
      const ceiling = 12 - Math.round(noise(seed + 'ceil', x / 2, y / 2) * 2.4);
      if (Math.abs(x) > wall || y > 10.5 + noise(seed, x / 2, 9) * 1.5) return { h: ceiling, top: 'stone', under: 'stone', wall: true };
      let h = onStage(x, y) ? 0 : clamp(Math.round((fbm(seed, x / 2.5, y / 2.5) - .55) * 2), -1, 1);
      if (y < 1.5) h = Math.min(0, h);
      return { h, top: 'slate', under: 'stone', ceiling };
    });
    boxes.push(...terrain(cells, 'slate', 'stone'));
    // The ceiling, with a few hanging points; open to the camera behind.
    for (const c of cells.values()) {
      if (c.wall) continue;
      const z0 = (c.ceiling ?? 12) * B;
      boxes.push(box(c.i * B, c.j * B, z0 + B / 2, B, 'stone'));
      const hang = rnd(seed, 'hang', c.i, c.j);
      if (hang > .93 && !onStage(c.i * B, c.j * B + 1)) for (let k = 1; k <= 1 + Math.floor((hang - .93) * 40); k++) boxes.push(box(c.i * B, c.j * B, z0 - (k - .5) * B, B, 'stone'));
    }
    const spots = [[-4.6, 3, 'crystal'], [4.4, 5, 'rose'], [-3.5, 8.5, 'rose'], [3.2, 9.4, 'crystal'], [-5, -1, 'crystal'], [5, 1.5, 'crystal']];
    spots.forEach(([x, y, glow], n) => {
      crystals(boxes, x, y, 0, seed + n, glow);
      if (n < 4) glows.push({ pos: [x, y, .6], color: BLOCKS[glow].color, power: 2.4 });
    });
  } else if (voxel.world === 'sky-island') {
    island(boxes, 0, 2.2, 0, 7.2, seed, [[-4.2, 3.2], [4.6, 4.4]]);
    island(boxes, -15, 24, 4, 3, seed + 'a', [[0, 0]]);
    island(boxes, 13, 30, -3, 3.6, seed + 'b', [[.5, .5]]);
    island(boxes, -3, 40, 9, 2.4, seed + 'c', []);
    clouds(puffs, seed, 14, { x: [-30, 30], y: [8, 48], z: [-9, 7] });
    clouds(puffs, seed + 'low', 5, { x: [-14, 14], y: [-4, 6], z: [-10, -7] });
  } else {
    // Ocean: a small sand island in turquoise water, a palm, two far islands.
    water = { level: -.2 };
    const cells = wedge((x, y) => {
      const d = Math.hypot(x, (y - 1.2) * 1.15), R = 4.4 + .7 * noise(seed, Math.atan2(y - 1.2, x) * 2 + 4, 1);
      if (d < R) return { h: d < R - 1.2 || onStage(x, y) ? 0 : -1 + (d < R - .5 ? 1 : 0), top: 'sand', under: 'sand' };
      return { h: -1, top: 'water', under: null, water: true };
    });
    for (const c of cells.values()) {
      if (c.water) boxes.push(box(c.i * B, c.j * B, water.level - .15, B, 'water', { sz: .3 }));
      else for (let k = c.h - 1; k >= -2; k--) boxes.push(box(c.i * B, c.j * B, (k + .5) * B, B, 'sand'));
    }
    palm(boxes, 2.6, 2.6, 0, 1);
    for (const [x, y, s] of [[-16, 26, 3], [15, 32, 2.6]]) {
      for (let a = -s; a <= s; a += B) for (let b = -s; b <= s; b += B) if (Math.hypot(a, b) < s) boxes.push(box(x + a, y + b, -.25, B, 'sand'));
      palm(boxes, x, y, 0, -1);
    }
    clouds(puffs, seed, 10, { x: [-30, 30], y: [18, 50], z: [6, 14] });
  }
  if (voxel.world !== 'cave' && voxel.world !== 'sky-island') clouds(puffs, seed + 'sky', 8, { x: [-34, 34], y: [24, 52], z: [9, 16] });
  if (voxel.time === 'night' && voxel.world !== 'cave') for (const b of boxes) if (b.block === 'window' && glows.length < 6) glows.push({ pos: [b.x, b.y - .4, b.z], color: BLOCKS.window.color, power: .9 });
  return { boxes, puffs, glows, water, enclosed, sky };
}

// -- the blocky character, from its character spec ----------------------------------------------------------------------

// The body plan of a voxel character, in metres. core/character_checks.py repeats the few numbers it measures
// (voxel_plan), so the sheet and frame checks know where the body and head are; a test keeps the two equal.
export function voxelPlan(spec) {
  const p = spec.proportions, H = HEIGHT, family = spec.family;
  const head = p.head * H, leg = Math.max(.16, p.limb_length * H * .55), body = H - head - leg;
  const bw = p.body_width * H * .5, bd = bw * .74, hw = Math.max(bw * 1.06, head * 1.12), hd = head * .96;
  const aw = Math.max(.1, p.limb_width * H * 1.7), lw = aw * 1.12, arm = body * .9;
  const taper = family === 'triangle' ? .74 : 1;
  const bevel = family === 'round' ? .32 : family === 'triangle' ? .2 : .1;     // share of the smaller side
  const shoulder = leg + body - aw * .55, ax = bw * taper / 2 + aw * .42;     // arms just touch the body's sides
  const splay = taper < 1 ? Math.asin(clamp(bw * (1 - taper) / 2 / arm)) + .04 : .03;
  return { H, head, leg, body, bw, bd, hw, hd, aw, lw, arm, taper, bevel, shoulder, ax, splay, lx: bw * .26,
    hip: leg, neck: leg + body, zb: leg + body / 2, zh: H - head / 2, forehead: H - head * .13, top: H, family };
}

// Parts are boxes: centre, size, colour key from the palette, bevel (share of the smaller side), taper (the top's width
// as a share of the bottom's), and the group that moves them.
export function voxelCharacter(spec) {
  const P = voxelPlan(spec), pal = spec.palette;
  const groups = {
    root: { parent: null, pivot: [0, 0, 0] },
    lean: { parent: 'root', pivot: [0, 0, P.hip] },
    head: { parent: 'lean', pivot: [0, 0, P.neck] },
    arm_l: { parent: 'lean', pivot: [-P.ax, 0, P.shoulder] }, arm_r: { parent: 'lean', pivot: [P.ax, 0, P.shoulder] },
    leg_l: { parent: 'root', pivot: [-P.lx, 0, P.hip] }, leg_r: { parent: 'root', pivot: [P.lx, 0, P.hip] },
  };
  const part = (name, group, colour, pos, size, extra = {}) => ({ name, group, colour, pos: pos.map(round), size: size.map(round), bevel: P.bevel, taper: 1, ...extra });
  const parts = [
    part('body', 'lean', 'body', [0, 0, P.zb + P.body * .07], [P.bw, P.bd, P.body * .86], { taper: P.taper }),
    part('hem', 'lean', 'body_shade', [0, 0, P.leg + P.body * .08], [P.bw * (1.02 - (1 - P.taper) * .1), P.bd * 1.02, P.body * .16], { bevel: P.bevel * .8 }),
    part('head', 'head', 'head', [0, 0, P.zh], [P.hw, P.hd, P.head], { bevel: P.bevel * 1.1 }),
  ];
  for (const [side, sx] of [['l', -1], ['r', 1]]) {
    const ax = sx * P.ax;
    parts.push(part('arm_' + side, 'arm_' + side, 'limb', [ax, 0, P.shoulder - P.arm / 2 + P.aw * .5], [P.aw, P.aw, P.arm - P.aw * .3]));
    parts.push(part('hand_' + side, 'arm_' + side, 'head', [ax, 0, P.shoulder - P.arm + P.aw * .3], [P.aw * 1.08, P.aw * 1.08, P.aw * .9]));
    parts.push(part('leg_' + side, 'leg_' + side, 'limb', [sx * P.lx, 0, P.leg / 2 + .03], [P.lw, P.lw * 1.08, P.leg - .02]));
    parts.push(part('foot_' + side, 'leg_' + side, 'body_shade', [sx * P.lx, -.03, .045], [P.lw * 1.14, P.lw * 1.5, .09]));
  }
  const top = P.top, hz = P.zh;
  if (spec.accessory === 'leaf') {
    parts.push(part('stem', 'head', 'limb', [0, 0, top + .05], [.05, .05, .12], { bevel: .2 }));
    parts.push(part('leaf', 'head', 'accent', [.09, 0, top + .13], [.2, .1, .045], { bevel: .3, rot: [0, -.35, 0] }));
  } else if (spec.accessory === 'antenna') {
    parts.push(part('stem', 'head', 'limb', [0, 0, top + .09], [.04, .04, .18], { bevel: .2 }));
    parts.push(part('bulb', 'head', 'accent', [0, 0, top + .22], [.1, .1, .1], { bevel: .4 }));
  } else if (spec.accessory === 'bow') {
    for (const [n, dx] of [['bow_a', -.075], ['bow_b', .075]]) parts.push(part(n, 'head', 'accent', [P.hw * .3 + dx, 0, top + .02], [.12, .07, .1], { bevel: .3 }));
    parts.push(part('bow_k', 'head', 'accent', [P.hw * .3, 0, top + .02], [.06, .08, .07], { bevel: .3 }));
  } else if (spec.accessory === 'cap') {
    parts.push(part('cap', 'head', 'accent', [0, .01, top - P.head * .08], [P.hw * 1.04, P.hd * 1.04, P.head * .3]));
    parts.push(part('brim', 'head', 'accent', [0, -P.hd * .62, top - P.head * .2], [P.hw * .9, P.hd * .35, .04], { bevel: .2 }));
  } else if (spec.accessory === 'scarf') {
    parts.push(part('scarf', 'head', 'accent', [0, 0, P.neck + .02], [P.bw * P.taper * 1.12 + .04, P.bd * 1.12 + .04, .1], { bevel: .3 }));
    parts.push(part('scarf_end', 'lean', 'accent', [P.bw * .22, -P.bd * .56, P.neck - .12], [.1, .05, .2], { bevel: .3 }));
  }
  // The face: a pixel texture drawn in code (voxel3d.js drawFace) on a plane just in front of the head's flat front.
  const face = { group: 'head', pos: [0, round(-P.hd / 2 - .004), round(hz - P.head * .03)], size: [round(P.hw * .84), round(P.head * .84)] };
  const accessoryTop = { leaf: .2, antenna: .28, bow: .08, cap: .02, scarf: 0, none: 0 }[spec.accessory] || 0;
  return { plan: P, groups, parts, face, top: top + accessoryTop, palette: pal };
}

// -- the pixel face -----------------------------------------------------------------------------------------------------

// A face on a 16 x 16 pixel grid: [x, y, colour key] cells. Expressions change the eyes, brows and the resting mouth; the
// mouth codes from the narration (X rest, A, E, O, M for M/B/P, F for F/V) open it. Eyes have a light catch; cheeks show.
export const FACE_GRID = 16;
const EYES = { l: 4, r: 10 };
export function faceCells(expression, mouth = 'X', blink = 0, look = 0) {
  const cells = [], put = (x, y, c) => cells.push([x, y, c]);
  const rect = (x, y, w, h, c) => { for (let a = 0; a < w; a++) for (let b = 0; b < h; b++) put(x + a, y + b, c); };
  const shut = blink > .5;
  for (const side of ['l', 'r']) {
    const x = EYES[side] + look;
    if (expression === 'happy' && !shut) { put(x, 7, 'eye'); put(x + 1, 6, 'eye'); put(x + 2, 7, 'eye'); continue; }
    if (shut) { rect(x, 7, 2, 1, 'eye'); continue; }
    if (expression === 'surprised') { rect(x, 5, 2, 4, 'eye'); put(x, 5, 'catch'); }
    else if (expression === 'worried') { rect(x, 6, 2, 2, 'eye'); put(x, 6, 'catch'); }
    else { rect(x, 5, 2, 3, 'eye'); put(x, 5, 'catch'); }
  }
  if (expression === 'worried') { put(4, 4, 'brow'); put(5, 3, 'brow'); put(10, 3, 'brow'); put(11, 4, 'brow'); }
  if (expression === 'surprised') { rect(4, 2, 2, 1, 'brow'); rect(10, 2, 2, 1, 'brow'); }
  if (expression === 'thinking') { rect(4, 4, 2, 1, 'brow'); put(10, 2, 'brow'); put(11, 3, 'brow'); }
  rect(2, 9, 2, 1, 'cheek'); rect(12, 9, 2, 1, 'cheek');
  const m = mouth || 'X';
  if (m === 'A') { rect(6, 10, 4, 3, 'mouth'); rect(7, 12, 2, 1, 'cheek'); }
  else if (m === 'E') { rect(5, 10, 6, 2, 'mouth'); rect(6, 10, 4, 1, 'teeth'); }
  else if (m === 'O') { rect(7, 10, 2, 3, 'mouth'); put(6, 11, 'mouth'); put(9, 11, 'mouth'); }
  else if (m === 'M') rect(6, 11, 4, 1, 'mouth');
  else if (m === 'F') { rect(6, 10, 4, 2, 'mouth'); rect(6, 10, 4, 1, 'teeth'); }
  else if (expression === 'happy') { put(5, 10, 'mouth'); rect(6, 11, 4, 1, 'mouth'); put(10, 10, 'mouth'); rect(7, 12, 2, 1, 'mouth'); }
  else if (expression === 'surprised') { rect(7, 10, 2, 2, 'mouth'); }
  else if (expression === 'worried') { put(6, 12, 'mouth'); rect(7, 11, 2, 1, 'mouth'); put(9, 12, 'mouth'); }
  else if (expression === 'thinking') { rect(7, 11, 3, 1, 'mouth'); }
  else { put(6, 10, 'mouth'); rect(7, 11, 2, 1, 'mouth'); put(9, 10, 'mouth'); }
  return cells;
}

// -- poses --------------------------------------------------------------------------------------------------------------

const T = (px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => [px, py, pz, rx, ry, rz, sx, sy, sz];
const EXPRESSION_AT = (member, t) => member.react && t >= member.react.at + .15 ? member.react.expression : member.expression;

// One voxel character's group transforms and face at t seconds into the beat (keyed without the member's prefix).
export function voxelMemberPose(member, plan, t, mouthCodes, seed, place) {
  const out = {};
  const breathe = Math.sin(TAU * t / 2.6), sway = .025 * Math.sin(TAU * t / 4.1 + seed);
  let lift = 0, squash = 0, headRx = 0, headRy = 0, headRz = 0, lean = 0;
  const arm = { l: [0, plan.splay, 0], r: [0, -plan.splay, 0] }, leg = { l: 0, r: 0 };
  arm.l[0] += .05 * Math.sin(TAU * t / 3.1); arm.r[0] += .05 * Math.sin(TAU * t / 3.1 + 1);
  const into = inOut(range(t, 0, .35));
  switch (member.action) {
    case 'wave': arm.r = [-.1 * into, -2.5 * into + (1 - into) * -plan.splay, .3 * Math.sin(TAU * t * 1.7) * into]; headRz = .08 * into; break;
    case 'point': arm.r = [-1.45 * into, -.35 * into, 0]; headRz = .1 * into; break;
    case 'shrug': {
      const k = into * (.75 + .25 * Math.sin(TAU * t / 1.8));
      arm.l = [-.35 * k, .9 * k, 0]; arm.r = [-.35 * k, -.9 * k, 0]; headRy = .12 * k; lift = .015 * k; break;
    }
    case 'think': arm.r = [-2.2 * into, .35 * into, 0]; headRy = -.08 * into; headRx = -.08 * into; headRz = .12 * into; break;
    case 'nod': headRx = .16 * Math.max(0, Math.sin(TAU * t * .9)) * into; break;
    case 'jump': {
      const cycle = (t % 1.4) / 1.4, air = range(cycle, .22, .78);
      lift = air > 0 && air < 1 ? .3 * 4 * air * (1 - air) : 0;
      squash = cycle < .22 ? .1 * Math.sin(Math.PI * cycle / .22) : cycle > .78 ? .08 * Math.sin(Math.PI * (cycle - .78) / .22) : -.04 * Math.sin(Math.PI * air);
      arm.l = [0, 1.1 * Math.sin(Math.PI * air) + plan.splay, 0]; arm.r = [0, -1.1 * Math.sin(Math.PI * air) - plan.splay, 0]; break;
    }
    case 'walk': {
      const ph = TAU * t * 1.8;
      leg.l = .5 * Math.sin(ph); leg.r = -.5 * Math.sin(ph); lift = .03 * Math.abs(Math.cos(ph));
      arm.l[0] = -.45 * Math.sin(ph); arm.r[0] = .45 * Math.sin(ph); break;
    }
    default: break;
  }
  if (member.react) {
    const r = range(t, member.react.at, member.react.at + .45);
    if (r > 0 && r < 1) { lift += .1 * 4 * r * (1 - r); squash -= .05 * Math.sin(Math.PI * r); }
    const k = inOut(range(t, member.react.at, member.react.at + .3)) * (1 - inOut(range(t, member.react.at + 1.6, member.react.at + 2.4)));
    if (member.action === 'idle' || member.action === 'nod') { arm.l[1] += .5 * k; arm.r[1] -= .5 * k; }
    headRx -= .14 * k;
  }
  const frame = Math.floor(t * 30 + 1e-6);
  const code = member.speaking && mouthCodes ? mouthCodes[frame] || 'X' : 'X';
  if (code !== 'X') headRx += .035 * Math.sin(TAU * t * 1.4);
  lean = .03 * Math.sin(TAU * t / 5.3 + seed);
  const sz = 1 - squash + .012 * breathe, sxy = 1 / Math.sqrt(Math.max(.5, sz));
  const facing = member.facing === 'left' ? -.42 : member.facing === 'right' ? .42 : 0;
  out.root = T(0, 0, lift, 0, 0, facing + sway, sxy, sxy, sz);
  out.lean = T(0, 0, 0, .3 * headRx, 0, lean);
  out.head = T(0, 0, 0, .7 * headRx, headRy, headRz);
  for (const side of ['l', 'r']) { out['arm_' + side] = T(0, 0, 0, ...arm[side]); out['leg_' + side] = T(0, 0, 0, leg[side], 0, 0); }
  const blink = blinkAt(seed, t);
  const expression = EXPRESSION_AT(member, t);
  return { groups: out, face: { expression, mouth: code, blink: blink > .5 ? 1 : 0, look: expression === 'thinking' ? 1 : 0 } };
}

// -- the beat -----------------------------------------------------------------------------------------------------------

function surfaceAt(world, x, y) {
  // The cast and props stand on z = 0 on every world's stage; a prop off the stage sits on the highest box under it.
  if (onStage(x, y)) return 0;
  let z = 0;
  for (const b of world.boxes) if (Math.abs(b.x - x) < B / 2 && Math.abs(b.y - y) < B / 2 && b.block !== 'water' && b.z + (b.sz || b.s) / 2 > z && b.z < 3) z = b.z + (b.sz || b.s) / 2;
  return z;
}

function propBoxes(prop, x, y, z, i) {
  const out = [], glows = [];
  if (prop.kind === 'crate') out.push(box(x, y, z + .3, .6, 'crate'));
  else if (prop.kind === 'ball') out.push(box(x, y, z + .25, .5, 'ball', { bevel: .5 }));
  else if (prop.kind === 'gem') { out.push(box(x, y, z + .45, .32, 'gem', { tilt: .7, spin: true })); glows.push({ pos: [x, y, z + .45], color: BLOCKS.gem.color, power: .8 }); }
  else if (prop.kind === 'star') { for (const tilt of [0, .785, 1.571, -.785]) out.push(box(x, y, z + .6, .5, 'star', { sy: .1, sz: .13, tilt, spin: true })); }
  else if (prop.kind === 'lantern') {
    out.push(box(x, y, z + .2, .34, 'post', { sz: .06 }));
    out.push(box(x, y, z + .42, .26, 'lamp', { sz: .36 }));
    out.push(box(x, y, z + .65, .34, 'post', { sz: .06 }));
    glows.push({ pos: [x, y, z + .45], color: BLOCKS.lamp.color, power: 1 });
  } else {
    for (let k = 0; k < 6; k++) out.push(box(x, y, z + (k + .5) * .25, .08, 'post', { sz: .25 }));
    out.push(box(x + .24, y, z + 1.3, .44, 'cloth', { sz: .28, sy: .05, wave: true }));
  }
  return { boxes: out.map(b => ({ ...b, prop: i })), glows };
}

// The whole beat as data: the world, the cast built from their specs, the stand-in people, the props, sky and lights.
// `characters` maps a character id to {spec, version}. Stable across frames: only voxelPose() changes per frame.
export function voxelModel(beat, characters) {
  const v = beat.voxel, world = worldModel(v), actors = [], groups = {}, parts = [], faces = [];
  const boxes = world.boxes.slice(), glows = world.glows.slice();
  const casted = v.cast.map((m, i) => ({ x: m.x * 1.7, y: -.15 * (i % 2) }));
  v.cast.forEach((member, i) => {
    const entry = characters[member.character];
    if (!entry) return;
    const key = `c${i}`, cm = voxelCharacter(entry.spec), p = casted[i];
    const place = { x: p.x, y: p.y, z: surfaceAt(world, p.x, p.y), facing: 0 };
    for (const [name, g] of Object.entries(cm.groups)) {
      groups[`${key}_${name}`] = { parent: g.parent ? `${key}_${g.parent}` : null, pivot: g.pivot.map((c, j) => round(c + [place.x, place.y, place.z][j])) };
    }
    for (const part of cm.parts) parts.push({ ...part, name: `${key}_${part.name}`, group: `${key}_${part.group}`, color: entry.spec.palette[part.colour],
      pos: part.pos.map((c, j) => round(c + [place.x, place.y, place.z][j])) });
    faces.push({ key, group: `${key}_${cm.face.group}`, pos: cm.face.pos.map((c, j) => round(c + [place.x, place.y, place.z][j])), size: cm.face.size, palette: cm.palette });
    actors.push({ key, kind: 'character', character: member.character, member, index: i, top: cm.top, plan: cm.plan, place });
  });
  // Stand-in people: faceless blocky figures in soft colours, in a loose row behind, clear of the cast.
  const slots = [];
  for (let x = -3.2; x <= 3.2 + 1e-6; x += .4) if (!casted.some(c => Math.abs(c.x - x) < .75)) slots.push(x);
  for (let i = 0; i < v.people.count; i++) {
    const r = rnd(`${v.people.seed}`, 'person', i), n = v.people.count;
    const slot = slots.length ? slots[Math.round((n === 1 ? .75 : i / (n - 1)) * (slots.length - 1))] : -2.6 + 5.2 * i / Math.max(1, n - 1);
    const x = round(slot + (r - .5) * .12), y = round(.7 + r * .6);
    const scale = .85 + .2 * r, colour = PEOPLE[(i + v.people.seed) % PEOPLE.length], key = `p${i}`, z = surfaceAt(world, x, y);
    groups[key] = { parent: null, pivot: [x, y, z] };
    parts.push({ name: `${key}_body`, group: key, color: colour, pos: [x, y, round(z + .42 * scale)], size: [round(.4 * scale), round(.28 * scale), round(.62 * scale)], bevel: .25, taper: 1 });
    parts.push({ name: `${key}_legs`, group: key, color: '#6f6a8f', pos: [x, y, round(z + .06 * scale)], size: [round(.34 * scale), round(.24 * scale), round(.14 * scale)], bevel: .3, taper: 1 });
    parts.push({ name: `${key}_head`, group: key, color: colour, pos: [x, y, round(z + .93 * scale)], size: [round(.4 * scale), round(.38 * scale), round(.38 * scale)], bevel: .3, taper: 1 });
    actors.push({ key, kind: 'person', index: i, top: 1.12 * scale, place: { x, y, z, phase: r * TAU, scale } });
  }
  v.props.forEach((prop, i) => {
    const x = round(prop.x * 3.4), y = round(-.4 + prop.depth * 2.6), made = propBoxes(prop, x, y, surfaceAt(world, x, y), i);
    boxes.push(...made.boxes); glows.push(...made.glows);
  });
  if (boxes.length > LIMITS.boxes) boxes.length = LIMITS.boxes;
  const sky = world.sky;
  return { beat: beat.id, world: v.world, time: v.time, boxes, puffs: world.puffs, glows: glows.slice(0, 6), water: world.water, enclosed: world.enclosed,
    sky, groups, parts, faces, actors };
}

// Everything that moves at t: group transforms, faces, the water, the camera, and each actor's anchors in the world.
export function voxelPose(model, beat, t, w, h, captioned) {
  const groups = {}, anchors = {}, faces = {};
  for (const actor of model.actors) {
    if (actor.kind === 'character') {
      const pose = voxelMemberPose(actor.member, actor.plan, t, actor.member.speaking ? beat.mouth : '', hash(`${beat.id}:${actor.index}`) % 997, actor.place);
      for (const [name, value] of Object.entries(pose.groups)) groups[`${actor.key}_${name}`] = value;
      faces[actor.key] = pose.face;
      const root = pose.groups.root, lift = root[2], sz = root[8], p = actor.place, P = actor.plan;
      const at = z => [p.x, p.y, round(p.z + lift + z * sz)];
      // The checks sample the head's forehead (no face pixels there) and the middle of the body (core/character_checks.py).
      anchors[actor.key] = { label: at(actor.top + .14), body: at(P.zb), head: at(P.forehead), feet: at(0), top: at(actor.top), width: P.hw / 2 };
    } else {
      const p = actor.place, bob = .02 * Math.abs(Math.sin(TAU * t / 1.9 + p.phase)), sway = .05 * Math.sin(TAU * t / 3.3 + p.phase);
      groups[actor.key] = T(0, 0, bob, 0, 0, sway);
      const at = z => [p.x, p.y, round(p.z + bob + z)];
      anchors[actor.key] = { label: at(actor.top + .1), body: at(.42 * p.scale), head: at(.93 * p.scale), feet: at(0), top: at(actor.top), width: .2 * p.scale };
    }
  }
  const stageLike = { ...beat, stage: beat.voxel };
  return { beat: beat.id, camera: cameraAt(model, stageLike, t, w, h, captioned), groups, anchors, faces, t };
}

// The water's surface offset for a box at time t (a slow swell), the same in every renderer and test.
export const swell = (x, y, t) => .045 * Math.sin(x * 1.3 + t * 1.6) * Math.cos(y * .9 - t * 1.1);

// Labels and boxes take the stage shape (stage.js) so the engine draws and reports them the same way as Pack B.
export const asStage = beat => ({ ...beat, stage: beat.voxel });
