// Pack B, the glossy 3D studio (Video Styles build spec, section 3 Pack B). This module is the 3D scene as data: the
// mascot built from its character spec, the stand-in people, the props, the studio set, its lights, and every
// transform and camera position at a moment of a beat. It imports nothing that draws, so the same numbers feed both
// renderers: three.js in the render window (stage3d.js) and, when the person has Blender installed and picked it,
// Blender (blender/kairos_stage.py), which receives this model and the per-frame poses as JSON. Any difference between
// their pictures is the renderer, never the animation.
//
// Coordinates are Blender's: Z up, metres, the cast standing on the floor (z = 0) facing -Y, the camera in front at -Y.
// Euler angles are XYZ in Blender's sense (matrix Rz*Ry*Rx); three.js reads them with rotation order 'ZYX'.
// A group's transform is [px, py, pz, rx, ry, rz, sx, sy, sz] about its pivot, on top of its rest place.
import { clamp, range, inOut, backOut, hash } from './kit.js';

export const SETS = ['lavender', 'peach', 'mint', 'sky', 'night'];
export const PROPS = ['ball', 'block', 'pillar', 'ring', 'coin'];
export const SHOTS = ['wide', 'medium', 'close'];
export const ACTIONS = ['idle', 'wave', 'point', 'walk', 'jump', 'shrug', 'think', 'nod'];
export const EXPRESSIONS = ['neutral', 'happy', 'surprised', 'worried', 'thinking'];
export const FACINGS = ['camera', 'left', 'right'];
export const SENSOR = 36;            // mm, horizontal fit: Blender's camera and three's are set from the same lens
export const HEIGHT = 1.5;           // a cast member's height in metres, feet to the top of the head
const TAU = Math.PI * 2;
const MOUTH = { A: [.82, 1, 1.75], E: [1.12, 1, .95], O: [.62, 1, 1.42], F: [.98, 1, .55] };

// The set's tones: backdrop, floor sheen and light colours. One per channel keeps a series consistent.
export const TONES = {
  lavender: { set: '#d8cfee', world: '#dcd6ea', key: '#fff4e8', fill: '#e8f0ff', rim: '#ffffff', bounce: '#8a7f9e' },
  peach:    { set: '#f4d6c6', world: '#f2ddd2', key: '#fff1e2', fill: '#ffe9f0', rim: '#ffffff', bounce: '#a3807a' },
  mint:     { set: '#cdece0', world: '#d6eee5', key: '#fffaf0', fill: '#e6f4ff', rim: '#ffffff', bounce: '#6f9a8c' },
  sky:      { set: '#cfe0f4', world: '#d9e5f3', key: '#fff6ea', fill: '#e9f1ff', rim: '#ffffff', bounce: '#7b8fae' },
  night:    { set: '#3a4170', world: '#2c3258', key: '#ffe8cf', fill: '#9fb4ff', rim: '#cfd9ff', bounce: '#1d2140' },
};
const PEOPLE = ['#8ec5e8', '#f2b5c4', '#b8e0a8', '#f6d48f', '#c5b3e6', '#9fd8cf', '#f4b183', '#a7b8f0'];
const PROP_COLOURS = ['#7cc6a4', '#9b7fd1', '#f6c85f', '#f08a7a', '#6fb1e8'];

const str = (v, n) => typeof v === 'string' || typeof v === 'number' ? Array.from(String(v).replace(/\s+/gu, ' ').trim()).slice(0, n).join('') : '';
const one = (v, list, fallback) => list.includes(v) ? v : fallback;
const num = (v, lo, hi, fallback) => Number.isFinite(Number(v)) && v !== null && v !== '' ? clamp(Number(v), lo, hi) : fallback;

// Defensive copy of a stage beat's `stage` (the backend validates it; core/video_store.py _stage).
export function normalizeStage(input) {
  const s = input && typeof input === 'object' ? input : {};
  const cast = (Array.isArray(s.cast) ? s.cast : []).slice(0, 3).filter(m => m && typeof m.character === 'string').map((m, i, all) => ({
    character: m.character.slice(0, 12), x: num(m.x, -1, 1, all.length === 1 ? 0 : -.6 + 1.2 * i / Math.max(1, all.length - 1)),
    expression: one(m.expression, EXPRESSIONS, 'neutral'), action: one(m.action, ACTIONS, 'idle'), speaking: m.speaking === true,
    facing: one(m.facing, FACINGS, 'camera'),
    react: m.react && typeof m.react === 'object' ? { at: num(m.react.at, 0, 60, 0), expression: one(m.react.expression, EXPRESSIONS, 'surprised') } : null }));
  const people = s.people && typeof s.people === 'object' ? s.people : {};
  return {
    set: one(s.set, SETS, 'lavender'), shot: one(s.shot, SHOTS, 'medium'), pedestal: s.pedestal === true, cast,
    people: { count: Math.round(num(people.count, 0, 8, 0)), seed: Math.round(num(people.seed, 0, 999, 0)) },
    props: (Array.isArray(s.props) ? s.props : []).slice(0, 6).filter(p => p && PROPS.includes(p.shape)).map((p, i) => ({
      shape: p.shape, x: num(p.x, -1, 1, i % 2 ? .7 : -.7), depth: num(p.depth, 0, 1, .5), size: num(p.size, .1, 1, .4),
      color: Math.round(num(p.color, 0, PROP_COLOURS.length - 1, i % PROP_COLOURS.length)) })),
    labels: (Array.isArray(s.labels) ? s.labels : []).slice(0, 8).filter(l => l && /^[cp][0-9]$/.test(l.over)).map(l => ({
      over: l.over, text: str(l.text, 16), sub: str(l.sub, 32), at: num(l.at, 0, 60, 0) })).filter(l => l.text),
  };
}

// -- geometry -------------------------------------------------------------------------------------------------------

const round = v => Math.round(v * 1e4) / 1e4;
function rgb01(hex) { return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); }
function mix(a, b, k) { return a.map((v, i) => v + (b[i] - v) * k); }
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// A closed surface of rings around Z: `ring(u)` for u from 0 (bottom pole) to 1 (top pole) gives {z, r, d (depth
// ratio), n (superellipse exponent)}; `colour(x, y, z)` paints each vertex. Poles are single vertices.
function sweep(ring, rings, segments, colour) {
  const verts = [], colors = [], faces = [];
  const push = (x, y, z) => { verts.push(round(x), round(y), round(z)); if (colour) colors.push(...colour(x, y, z).map(round)); };
  const bottom = ring(0), top = ring(1);
  push(0, 0, bottom.z);
  for (let i = 1; i < rings; i++) {
    const u = (1 - Math.cos(Math.PI * i / rings)) / 2, r = ring(u);
    for (let s = 0; s < segments; s++) {
      const a = TAU * s / segments, c = Math.cos(a), sn = Math.sin(a), e = 2 / r.n;
      push(r.r * Math.sign(c) * Math.abs(c) ** e, r.r * r.d * Math.sign(sn) * Math.abs(sn) ** e, r.z);
    }
  }
  push(0, 0, top.z);
  const last = verts.length / 3 - 1;
  for (let s = 0; s < segments; s++) faces.push(0, 1 + (s + 1) % segments, 1 + s);
  for (let i = 0; i < rings - 2; i++) {
    const a = 1 + i * segments, b = 1 + (i + 1) * segments;
    for (let s = 0; s < segments; s++) faces.push(a + s, a + (s + 1) % segments, b + (s + 1) % segments, a + s, b + (s + 1) % segments, b + s);
  }
  const base = 1 + (rings - 2) * segments;
  for (let s = 0; s < segments; s++) faces.push(base + s, base + (s + 1) % segments, last);
  return colour ? { verts, faces, colors } : { verts, faces };
}

// A rounded disc or cylinder around Z (the pedestal, a coin, a pillar): flat caps, rounded edges.
function lathe(radius, depth, bevel, segments = 72) {
  const h = depth / 2, inner = radius - bevel, profile = [];
  for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + Math.PI / 2 * i / 8; profile.push([inner + bevel * Math.cos(a), -h + bevel + bevel * Math.sin(a)]); }
  for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 * i / 8; profile.push([inner + bevel * Math.cos(a), h - bevel + bevel * Math.sin(a)]); }
  const verts = [0, 0, round(-h)], faces = [];
  for (const [r, z] of profile) for (let s = 0; s < segments; s++) { const a = TAU * s / segments; verts.push(round(r * Math.cos(a)), round(r * Math.sin(a)), round(z)); }
  verts.push(0, 0, round(h));
  const top = verts.length / 3 - 1;
  for (let s = 0; s < segments; s++) faces.push(0, 1 + (s + 1) % segments, 1 + s);
  for (let p = 0; p < profile.length - 1; p++) {
    const a = 1 + p * segments, b = 1 + (p + 1) * segments;
    for (let s = 0; s < segments; s++) faces.push(a + s, a + (s + 1) % segments, b + (s + 1) % segments, a + s, b + (s + 1) % segments, b + s);
  }
  const last = 1 + (profile.length - 1) * segments;
  for (let s = 0; s < segments; s++) faces.push(last + s, last + (s + 1) % segments, top);
  return { verts, faces };
}

// A tube along a path of points (the mouth's smile, the scarf, the antenna's stem): circular cross-section, capped.
function tube(path, radius, segments = 16, closed = false) {
  const verts = [], faces = [], n = path.length;
  for (let i = 0; i < n; i++) {
    const p = path[i], q = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)], o = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    let t = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    const len = Math.hypot(...t) || 1; t = t.map(v => v / len);
    const ref = Math.abs(t[2]) < .9 ? [0, 0, 1] : [1, 0, 0];
    let a = [t[1] * ref[2] - t[2] * ref[1], t[2] * ref[0] - t[0] * ref[2], t[0] * ref[1] - t[1] * ref[0]];
    const al = Math.hypot(...a); a = a.map(v => v / al);
    const b = [t[1] * a[2] - t[2] * a[1], t[2] * a[0] - t[0] * a[2], t[0] * a[1] - t[1] * a[0]];
    const r = typeof radius === 'function' ? radius(i / (n - 1)) : radius;
    for (let s = 0; s < segments; s++) {
      const ang = TAU * s / segments, c = Math.cos(ang) * r, sn = Math.sin(ang) * r;
      verts.push(round(p[0] + a[0] * c + b[0] * sn), round(p[1] + a[1] * c + b[1] * sn), round(p[2] + a[2] * c + b[2] * sn));
    }
  }
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const A = i * segments, B = ((i + 1) % n) * segments;
    for (let s = 0; s < segments; s++) faces.push(A + s, A + (s + 1) % segments, B + (s + 1) % segments, A + s, B + (s + 1) % segments, B + s);
  }
  if (!closed) {
    for (const [end, flip] of [[0, true], [n - 1, false]]) {
      const c = verts.length / 3; verts.push(...path[end].map(round));
      for (let s = 0; s < segments; s++) {
        const x = end * segments + s, y = end * segments + (s + 1) % segments;
        faces.push(...(flip ? [c, y, x] : [c, x, y]));
      }
    }
  }
  return { verts, faces };
}

// A leaf: a pointed blade with a fold along its midrib and a gentle upward curl, so it reads as a leaf from every side
// (the spike's flattened sphere read as a disc from the front). Both renderers draw it two-sided.
function leafMesh(length, width) {
  const verts = [], faces = [], N = 18, M = 8;
  for (let i = 0; i <= N; i++) {
    const s = i / N, half = width * Math.sin(Math.PI * s) ** .85 * (1 - .25 * s);
    for (let j = 0; j <= M; j++) {
      const u = -1 + 2 * j / M;
      const x = s * length, y = u * half, z = Math.abs(u) * half * .45 + .18 * length * s * s;
      verts.push(round(x), round(y), round(z));
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
    const a = i * (M + 1) + j, b = a + M + 1;
    faces.push(a, b, b + 1, a, b + 1, a + 1);
  }
  return { verts, faces };
}

// The studio cyclorama: a floor that curves up into a back wall, wide enough that an orbit never sees its edge.
function cyclorama() {
  const profile = [];
  for (let i = 0; i < 12; i++) profile.push([-9 + 11 * i / 11, 0]);
  for (let i = 1; i <= 24; i++) { const a = Math.PI / 2 * i / 24; profile.push([2.4 + 3 * Math.sin(a), 3 - 3 * Math.cos(a)]); }
  for (let i = 1; i <= 6; i++) profile.push([5.4, 3 + i]);
  const xs = Array.from({ length: 61 }, (_, i) => -30 + i);
  const verts = [], faces = [];
  for (const [y, z] of profile) for (const x of xs) verts.push(x, round(y), round(z));
  const n = xs.length;
  for (let r = 0; r < profile.length - 1; r++) for (let c = 0; c < n - 1; c++) {
    const a = r * n + c;
    faces.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
  }
  return { verts, faces };
}

// -- the mascot, from its character spec ------------------------------------------------------------------------------

// The 3D body plan of a character spec, in metres. core/character_checks.py repeats the few numbers it measures
// (stage_metrics), so the 3D sheet and frame checks know where the body and head are.
export function bodyPlan(spec) {
  const p = spec.proportions, H = HEIGHT;
  const hh = p.head * H / 2, zh = H - hh, hr = hh * 1.08;
  const legLen = p.limb_length * H * .62, bottom = legLen * .72, top = zh - hh * .25;
  const br = p.body_width * H * .5 * .78;
  return { H, hh, zh, hr, legLen, bottom, top, zb: (bottom + top) / 2, bh: (top - bottom) / 2, br,
    limbR: p.limb_width * H * 1.15, n: spec.family === 'square' ? 3.6 : 2, depth: .9, eye: p.eye_size * H * 1.35, family: spec.family };
}

// The body and head as one surface: a smooth union of the two radii, so the neck is a soft waist and the colour blends
// across it (the spike's two spheres met at a visible seam).
function bodyRadius(plan, z) {
  const u = (z - plan.zb) / plan.bh;
  let rb = 0;
  if (Math.abs(u) < 1) {
    if (plan.family === 'square') rb = plan.br * (1 - Math.abs(u) ** 4) ** .25;
    else rb = plan.br * Math.sqrt(1 - u * u) * (plan.family === 'triangle' ? 1 - .36 * (u + 1) / 2 : 1);
  }
  const v = (z - plan.zh) / plan.hh;
  const rh = Math.abs(v) < 1 ? plan.hr * (plan.family === 'square' ? (1 - Math.abs(v) ** 4) ** .25 : Math.sqrt(1 - v * v)) : 0;
  return (rb ** 6 + rh ** 6) ** (1 / 6);
}
function neckZ(plan) {
  let best = plan.zh, least = Infinity;
  for (let z = plan.zh - plan.hh; z < plan.top; z += .005) {
    const r = bodyRadius(plan, z);
    if (r < least && z > plan.zb) { least = r; best = z; }
  }
  return best;
}
// Where the front surface is at (x, z): the cross-section is a superellipse of the body's radius there.
function frontY(plan, x, z) {
  const r = Math.max(1e-4, bodyRadius(plan, z)), k = clamp(Math.abs(x) / r, 0, .999);
  return -plan.depth * r * (1 - k ** plan.n) ** (1 / plan.n);
}

export function characterModel(spec) {
  const plan = bodyPlan(spec), pal = spec.palette, neck = neckZ(plan);
  const body = rgb01(pal.body), head = rgb01(pal.head), shade = rgb01(pal.body_shade);
  const belly = mix(body, head, .55);
  const surface = sweep(u => ({ z: plan.bottom + (plan.H - plan.bottom) * u, r: bodyRadius(plan, plan.bottom + (plan.H - plan.bottom) * u), d: plan.depth, n: plan.n }),
    72, 64, (x, y, z) => {
      let c = mix(body, head, smooth(neck - .06, neck + .06, z));
      c = mix(c, shade, .45 * (1 - smooth(plan.bottom, plan.bottom + .14, z)));
      const d = Math.hypot(x / (plan.br * .56), (z - (plan.zb - plan.bh * .1)) / (plan.bh * .56));
      const front = smooth(plan.br * .1, plan.br * .45, -y);
      return mix(c, belly, (1 - smooth(.78, 1, d)) * front * (z < neck ? 1 : 0));
    });
  const e = plan.eye, ez = plan.zh + plan.hh * .08, ex = plan.hr * .36, mz = plan.zh - plan.hh * .4;
  const shoulder = [plan.br * .9, -.05, plan.zb + plan.bh * .42], la = spec.proportions.limb_length * plan.H * .5;
  const elbow = [shoulder[0] + .06, shoulder[1] - .015, shoulder[2] - la];
  const hip = [plan.br * .42, -.01, plan.bottom + .06];
  const groups = {
    root: { parent: null, pivot: [0, 0, 0] },
    lean: { parent: 'root', pivot: [0, 0, plan.bottom + .06] },
    head: { parent: 'lean', pivot: [0, 0, neck] },
    eye_l: { parent: 'head', pivot: [-ex, frontY(plan, ex, ez), ez] }, eye_r: { parent: 'head', pivot: [ex, frontY(plan, ex, ez), ez] },
    brow_l: { parent: 'head', pivot: [-ex, frontY(plan, ex, ez + e) + .012, ez + e + .045] },
    brow_r: { parent: 'head', pivot: [ex, frontY(plan, ex, ez + e) + .012, ez + e + .045] },
    mouth: { parent: 'head', pivot: [0, frontY(plan, 0, mz) + .006, mz] },
    arm_l: { parent: 'lean', pivot: [-shoulder[0], shoulder[1], shoulder[2]] }, arm_r: { parent: 'lean', pivot: shoulder },
    fore_l: { parent: 'arm_l', pivot: [-elbow[0], elbow[1], elbow[2]] }, fore_r: { parent: 'arm_r', pivot: elbow },
    leg_l: { parent: 'root', pivot: [-hip[0], hip[1], hip[2]] }, leg_r: { parent: 'root', pivot: hip },
  };
  const sph = (name, group, material, pos, scale, rot = [0, 0, 0]) => ({ name, type: 'sphere', group, material, pos, scale, rot });
  const mesh = (name, group, material, key, pos = [0, 0, 0], rot = [0, 0, 0]) => ({ name, type: 'mesh', group, material, mesh: key, pos, rot });
  const smile = tube(Array.from({ length: 13 }, (_, i) => { const x = -1 + i / 6; return [x * .075, -.004 * (1 - x * x), .028 * x * x]; }), .0115, 10);
  const prims = [mesh('body', 'lean', 'body', 'body')];
  for (const [side, sx] of [['l', -1], ['r', 1]]) {
    const s = groups['arm_' + side].pivot, el = groups['fore_' + side].pivot;
    const mid = (a, b) => a.map((v, i) => (v + b[i]) / 2);
    const upper = mid(s, el), hand = [el[0] + sx * .02, el[1] - .01, el[2] - la * .92];
    prims.push(sph('arm_' + side, 'arm_' + side, 'limb', upper, [plan.limbR * .82, plan.limbR * .82, la * .62], [0, -sx * .06, 0]));
    prims.push(sph('fore_' + side, 'fore_' + side, 'limb', mid(el, hand), [plan.limbR * .78, plan.limbR * .78, la * .55]));
    prims.push(sph('hand_' + side, 'fore_' + side, 'limb', hand, [plan.limbR * 1.12, plan.limbR * 1.0, plan.limbR * 1.12]));
    const h = groups['leg_' + side].pivot;
    prims.push(sph('leg_' + side, 'leg_' + side, 'limb', [h[0], h[1], h[2] / 2 + .04], [plan.limbR, plan.limbR, h[2] / 2 + .02]));
    prims.push(sph('foot_' + side, 'leg_' + side, 'limb', [h[0] * 1.05, h[1] - .06, .055], [plan.limbR * 1.35, plan.limbR * 1.9, .065]));
    const eye = groups['eye_' + side].pivot;
    prims.push(sph('eye_' + side, 'eye_' + side, 'eye', [eye[0], eye[1] + e * .2, eye[2]], [e * .72, e * .5, e]));
    prims.push(sph('catch_' + side, 'eye_' + side, 'catch', [eye[0] - e * .28, eye[1] - e * .2, eye[2] + e * .42], [e * .2, e * .1, e * .22]));
    const brow = groups['brow_' + side].pivot;
    prims.push(sph('brow_' + side, 'brow_' + side, 'brow', brow, [e * .82, .02, .017], [0, sx * .05, 0]));
    const cz = plan.zh - plan.hh * .2, cx = plan.hr * .62;
    prims.push(sph('cheek_' + side, 'head', 'cheek', [sx * cx, frontY(plan, cx, cz) + .012, cz], [.068, .022, .042], [0, 0, -sx * .45]));
  }
  const m = groups.mouth.pivot;
  prims.push(mesh('smile', 'mouth', 'mouth', 'smile', [m[0], m[1] - .004, m[2] - .012]));
  prims.push(sph('mouth_open', 'mouth', 'mouth', [m[0], m[1] + .006, m[2]], [.085, .032, .035]));
  prims.push(sph('teeth', 'mouth', 'teeth', [m[0], m[1] - .008, m[2] + .016], [.058, .012, .013]));
  const meshes = { body: surface, smile };
  const crown = plan.H;
  if (spec.accessory === 'leaf') {
    meshes.stem = tube([[0, 0, crown - .03], [.01, 0, crown + .05], [.035, 0, crown + .09]], .016, 10);
    meshes.leaf = leafMesh(.24, .075);
    prims.push(mesh('stem', 'head', 'stem', 'stem'));
    prims.push(mesh('leaf', 'head', 'leaf', 'leaf', [.035, 0, crown + .085], [0, -.35, .5]));
  } else if (spec.accessory === 'antenna') {
    meshes.stem = tube([[0, 0, crown - .03], [0, 0, crown + .1], [.02, 0, crown + .16]], .014, 10);
    prims.push(mesh('stem', 'head', 'stem', 'stem'));
    prims.push(sph('bulb', 'head', 'accent', [.02, 0, crown + .19], [.045, .045, .045]));
  } else if (spec.accessory === 'bow') {
    const z = crown - plan.hh * .2, x = plan.hr * .55;
    prims.push(sph('bow_a', 'head', 'accent', [x - .06, -.02, z + .06], [.07, .035, .05], [0, .5, 0]));
    prims.push(sph('bow_b', 'head', 'accent', [x + .06, -.02, z + .02], [.07, .035, .05], [0, -.5, 0]));
    prims.push(sph('bow_k', 'head', 'accent', [x, -.03, z + .04], [.032, .03, .032]));
  } else if (spec.accessory === 'cap') {
    prims.push(sph('cap', 'head', 'accent', [0, .01, crown - plan.hh * .32], [plan.hr * 1.02, plan.hr * plan.depth * 1.04, plan.hh * .62]));
    prims.push(sph('brim', 'head', 'accent', [0, -plan.hr * .75, crown - plan.hh * .42], [plan.hr * .62, plan.hr * .5, .03]));
  } else if (spec.accessory === 'scarf') {
    const r = bodyRadius(plan, neck) * 1.02;
    meshes.scarf = tube(Array.from({ length: 40 }, (_, i) => { const a = TAU * i / 40; return [r * Math.cos(a), r * plan.depth * Math.sin(a), neck]; }), .045, 12, true);
    prims.push(mesh('scarf', 'head', 'accent', 'scarf'));
  }
  const materials = {
    body: { color: '#ffffff', vertex_colors: true, roughness: .3, coat: .9, coat_roughness: .06 },
    limb: { color: pal.limb, roughness: .3, coat: .8, coat_roughness: .08 },
    eye: { color: pal.eye, roughness: .08, coat: 1, coat_roughness: .02 },
    catch: { color: '#ffffff', roughness: .2, coat: 0, emission: .6 },
    brow: { color: pal.outline, roughness: .5, coat: 0 },
    mouth: { color: pal.mouth, roughness: .45, coat: .3, coat_roughness: .2 },
    teeth: { color: '#fbf6ee', roughness: .3, coat: 0 },
    cheek: { color: pal.cheek, roughness: .7, coat: 0 },
    accent: { color: pal.accent, roughness: .26, coat: .9, coat_roughness: .06, two_sided: true },
    leaf: { color: pal.accent, roughness: .3, coat: .8, coat_roughness: .08, two_sided: true },
    stem: { color: pal.limb, roughness: .35, coat: .5, coat_roughness: .1 },
  };
  return { plan: { ...plan, neck }, groups, prims, meshes, materials, top: crown + (spec.accessory === 'leaf' ? .2 : spec.accessory === 'antenna' ? .24 : .02) };
}

// -- expressions and actions ------------------------------------------------------------------------------------------

const FACE = {
  neutral:   { eye: 1, squint: 1, browZ: 0, browTilt: 0, rest: 'smile', curve: .55, cheek: 1, lookX: 0, lookZ: 0 },
  happy:     { eye: 1, squint: .62, browZ: .014, browTilt: 0, rest: 'smile', curve: 1.25, cheek: 1.25, lookX: 0, lookZ: .008 },
  surprised: { eye: 1.24, squint: 1.1, browZ: .05, browTilt: 0, rest: 'o', curve: .55, cheek: .9, lookX: 0, lookZ: .006 },
  worried:   { eye: .95, squint: .9, browZ: .018, browTilt: .32, rest: 'frown', curve: .7, cheek: .8, lookX: 0, lookZ: -.004 },
  thinking:  { eye: 1, squint: .85, browZ: .022, browTilt: -.18, rest: 'flat', curve: .25, cheek: 1, lookX: .014, lookZ: .012 },
};
function faceAt(member, t) {
  const a = FACE[member.expression] || FACE.neutral;
  if (!member.react) return { ...a, k: 0 };
  const k = inOut(range(t, member.react.at, member.react.at + .3)), b = FACE[member.react.expression] || a;
  const out = { k };
  for (const key of Object.keys(a)) out[key] = typeof a[key] === 'number' ? a[key] + (b[key] - a[key]) * k : (k < .5 ? a[key] : b[key]);
  return out;
}
export function blinkAt(seed, t) {
  const random = n => (hash(`${seed}:${n}`) % 10000) / 10000;
  let at = .7 + random(0) * 1.5;
  for (let n = 1; at < t + 1 && n < 400; n++) {
    if (t >= at && t < at + .16) { const k = (t - at) / .16; return k < .35 ? k / .35 : k < .55 ? 1 : 1 - (k - .55) / .45; }
    at += 2.4 + random(n) * 2.2;
  }
  return 0;
}
const T = (px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => [px, py, pz, rx, ry, rz, sx, sy, sz];

// One cast member's transforms at t seconds into the beat (keyed by group name, without the member's prefix).
export function memberPose(member, model, t, mouthCodes, seed, place) {
  const plan = model.plan, out = {};
  const breathe = Math.sin(TAU * t / 2.7), sway = .03 * Math.sin(TAU * t / 4.3 + seed);
  let lift = 0, squash = 0, rz = place.facing + sway, rx = 0;
  const face = faceAt(member, t), react = member.react ? range(t, member.react.at, member.react.at + .45) : 0;
  const arm = { l: [0, .1, 0], r: [0, -.1, 0] }, fore = { l: [0, 0, 0], r: [0, 0, 0] }, leg = { l: 0, r: 0 };
  let headRx = 0, headRy = 0, headRz = 0;
  arm.l[0] += .04 * Math.sin(TAU * t / 3.2); arm.r[0] += .04 * Math.sin(TAU * t / 3.2 + 1);
  const into = inOut(range(t, 0, .4));
  switch (member.action) {
    case 'wave': {
      arm.r = [-.15 * into, -2.35 * into, 0];
      fore.r = [0, .45 * Math.sin(TAU * t * 1.6) * into, 0];
      headRz = .08 * into; break;
    }
    case 'point': arm.r = [-1.25 * into, -.55 * into, 0]; fore.r = [-.2 * into, 0, 0]; headRz = .12 * into; rz += .12 * into; break;
    case 'shrug': {
      const k = into * (.75 + .25 * Math.sin(TAU * t / 1.8));
      arm.l = [-.2 * k, .62 * k, 0]; arm.r = [-.2 * k, -.62 * k, 0];
      fore.l = [-1.15 * k, -.35 * k, 0]; fore.r = [-1.15 * k, .35 * k, 0];
      headRy = .14 * k; lift = .012 * k; break;
    }
    case 'think': arm.r = [-.95 * into, -.25 * into, 0]; fore.r = [-1.95 * into, .55 * into, 0]; headRy = -.1 * into; headRx = -.08 * into; headRz = .1 * into; break;
    case 'nod': headRx = .14 * Math.max(0, Math.sin(TAU * t * .9)) * into; break;
    case 'jump': {
      const cycle = (t % 1.5) / 1.5, air = range(cycle, .22, .78);
      lift = air > 0 && air < 1 ? .28 * 4 * air * (1 - air) : 0;
      squash = cycle < .22 ? .1 * Math.sin(Math.PI * cycle / .22) : cycle > .78 ? .08 * Math.sin(Math.PI * (cycle - .78) / .22) : -.04 * Math.sin(Math.PI * air);
      arm.l = [0, .9 * Math.sin(Math.PI * air), 0]; arm.r = [0, -.9 * Math.sin(Math.PI * air), 0]; break;
    }
    case 'walk': {
      const ph = TAU * t * 1.7;
      leg.l = .42 * Math.sin(ph); leg.r = -.42 * Math.sin(ph); lift = .025 * Math.abs(Math.cos(ph));
      arm.l[0] = -.38 * Math.sin(ph); arm.r[0] = .38 * Math.sin(ph); break;
    }
    default: break;
  }
  if (react > 0 && react < 1) { lift += .1 * 4 * react * (1 - react); squash -= .05 * Math.sin(Math.PI * react); }
  if (member.react && t >= member.react.at) {
    const k = inOut(range(t, member.react.at, member.react.at + .3)) * (1 - inOut(range(t, member.react.at + 1.6, member.react.at + 2.4)));
    if (member.action === 'idle' || member.action === 'nod') { arm.l = [arm.l[0], .55 * k + arm.l[1] * (1 - k), 0]; arm.r = [arm.r[0], -.55 * k + arm.r[1] * (1 - k), 0]; }
    headRx -= .16 * k;
  }
  const talking = member.speaking && mouthCodes && mouthCodes[Math.floor(t * 30 + 1e-6)] && mouthCodes[Math.floor(t * 30 + 1e-6)] !== 'X';
  if (talking) headRx += .03 * Math.sin(TAU * t * 1.3);
  const sz = 1 - squash + .01 * breathe, sxy = 1 / Math.sqrt(Math.max(.5, sz));
  out.root = T(0, 0, lift + .008 * breathe, rx, 0, rz, sxy, sxy, sz);
  // The head and body are one surface: a nod or a tilt leans the upper body about the hips, so the face moves with it.
  out.lean = T(0, 0, 0, .55 * headRx, .55 * headRy, .5 * (headRz + .06 * Math.sin(TAU * t / 6.1 + seed) * (1 - face.k)));
  out.head = T();
  const blink = blinkAt(seed, t);
  for (const [side, sgn] of [['l', -1], ['r', 1]]) {
    out['eye_' + side] = T(face.lookX, 0, face.lookZ, 0, 0, 0, face.eye * (face.squint < 1 ? 1.06 : 1), 1, face.eye * face.squint * (1 - .9 * blink));
    out['brow_' + side] = T(0, 0, face.browZ + (face.eye - 1) * .05, 0, sgn * face.browTilt, 0, 1, 1, 1);
    out['arm_' + side] = T(0, 0, 0, ...arm[side]);
    out['fore_' + side] = T(0, 0, 0, ...fore[side]);
    out['leg_' + side] = T(0, 0, 0, leg[side], 0, 0);
  }
  // The mouth: the smile line at rest (curved up, flat, or turned over into a frown), an open shape while speaking.
  const code = member.speaking && mouthCodes ? mouthCodes[Math.floor(t * 30 + 1e-6)] || 'X' : 'X';
  const open = MOUTH[code] || (code === 'X' && face.rest === 'o' ? [.55, 1, 1.05] : null);
  out.mouth = T(0, 0, 0, 0, face.rest === 'frown' && !open ? Math.PI : 0, 0, 1, 1, 1);
  out.smile = open ? T(0, 0, 0, 0, 0, 0, 0, 0, 0) : T(0, 0, 0, 0, 0, 0, code === 'M' ? .85 : 1, 1, code === 'M' ? .25 : face.curve);
  out.mouth_open = open ? T(0, 0, 0, 0, 0, 0, ...open) : T(0, 0, 0, 0, 0, 0, 0, 0, 0);
  out.teeth = code === 'E' || code === 'F' ? T() : T(0, 0, 0, 0, 0, 0, 0, 0, 0);
  out.cheeks = face.cheek;
  return out;
}

// -- the stage of one beat --------------------------------------------------------------------------------------------

// Where each cast member and stand-in stands: the cast across the front, the people in a loose row behind.
function placements(stage) {
  const cast = stage.cast.map((m, i) => ({ x: m.x * 1.7, y: -.15 * (i % 2), z: stage.pedestal && i === 0 ? .12 : 0,
    facing: m.facing === 'left' ? -.42 : m.facing === 'right' ? .42 : 0 }));
  const people = [];
  const n = stage.people.count;
  // Slots across the stage, skipping the space each cast member stands in, so labels over people never sit on the cast.
  const slots = [];
  for (let x = -3.2; x <= 3.2 + 1e-6; x += .4) if (!cast.some(c => Math.abs(c.x - x) < .75)) slots.push(x);
  for (let i = 0; i < n; i++) {
    const r = (hash(`${stage.people.seed}:${i}`) % 1000) / 1000;
    const x = slots.length ? slots[Math.round((n === 1 ? .75 : i / (n - 1)) * (slots.length - 1))] : -2.6 + 5.2 * i / Math.max(1, n - 1);
    people.push({ x: x + (r - .5) * .12, y: .55 + r * .5, scale: .88 + .2 * r, colour: PEOPLE[(i + stage.people.seed) % PEOPLE.length], phase: r * TAU });
  }
  return { cast, people };
}

// A person stand-in: a glossy pill with a round head, no face.
function personMeshes() {
  return { person: sweep(u => { const z = .02 + 1.18 * u, k = (z - .6) / .6; return { z, r: .2 * Math.sqrt(Math.max(0, 1 - k ** 8)) * (1 - .12 * u), d: .85, n: 2 }; }, 24, 32) };
}

// The whole beat as data: materials, meshes, groups and primitives, lights and world. `characters` maps a character id
// to {spec, version}. Stable across frames: only stagePose() changes per frame.
export function stageModel(beat, characters) {
  const stage = beat.stage, tone = TONES[stage.set], place = placements(stage);
  const materials = { set: { color: tone.set, roughness: .62, coat: 0 }, pedestal: { color: '#f3eefb', roughness: .22, coat: .6, coat_roughness: .1 } };
  const meshes = { cyclorama: cyclorama(), pedestal: lathe(1.0, .12, .04), ...personMeshes() };
  const groups = {}, prims = [{ name: 'cyclorama', type: 'mesh', group: null, material: 'set', mesh: 'cyclorama', pos: [0, 0, 0], rot: [0, 0, 0], receive_only: true }];
  const actors = [];
  stage.cast.forEach((member, i) => {
    const entry = characters[member.character];
    if (!entry) return;
    const key = `c${i}`, cm = characterModel(entry.spec), p = place.cast[i];
    for (const [name, m] of Object.entries(cm.materials)) materials[`${key}_${name}`] = m;
    for (const [name, m] of Object.entries(cm.meshes)) meshes[`${member.character}:${entry.version}:${name}`] = m;
    for (const [name, g] of Object.entries(cm.groups)) {
      const pivot = g.parent ? g.pivot : [p.x, p.y, p.z];
      groups[`${key}_${name}`] = { parent: g.parent ? `${key}_${g.parent}` : null, pivot: g.parent ? pivot.map((v, j) => v + [p.x, p.y, p.z][j]) : pivot };
    }
    for (const prim of cm.prims) {
      const pos = prim.pos.map((v, j) => v + [p.x, p.y, p.z][j]);
      const group = ['smile', 'mouth_open', 'teeth'].includes(prim.name) ? `${key}_${prim.name}` : `${key}_${prim.group}`;
      if (['smile', 'mouth_open', 'teeth'].includes(prim.name)) groups[group] = { parent: `${key}_mouth`, pivot: pos };
      if (prim.name.startsWith('cheek_')) groups[`${key}_${prim.name}`] = { parent: `${key}_head`, pivot: pos };
      prims.push({ ...prim, name: `${key}_${prim.name}`, group: prim.name.startsWith('cheek_') ? `${key}_${prim.name}` : group, material: `${key}_${prim.material}`,
        mesh: prim.mesh ? `${member.character}:${entry.version}:${prim.mesh}` : undefined, pos });
    }
    if (stage.pedestal && i === 0) prims.push({ name: 'pedestal', type: 'mesh', group: null, material: 'pedestal', mesh: 'pedestal', pos: [p.x, p.y, .06], rot: [0, 0, 0] });
    actors.push({ key, kind: 'character', character: member.character, member, index: i, top: cm.top, plan: cm.plan, place: p });
  });
  place.people.forEach((person, i) => {
    const key = `p${i}`;
    materials[key] = { color: person.colour, roughness: .3, coat: .6, coat_roughness: .1 };
    groups[key] = { parent: null, pivot: [person.x, person.y, 0] };
    prims.push({ name: `${key}_body`, type: 'mesh', group: key, material: key, mesh: 'person', pos: [person.x, person.y, 0], rot: [0, 0, 0], scale: [person.scale, person.scale, person.scale] });
    prims.push({ name: `${key}_head`, type: 'sphere', group: key, material: key, pos: [person.x, person.y, 1.3 * person.scale], scale: [.17 * person.scale, .16 * person.scale, .18 * person.scale], rot: [0, 0, 0] });
    actors.push({ key, kind: 'person', index: i, top: 1.48 * person.scale, place: person });
  });
  stage.props.forEach((prop, i) => {
    const key = `prop${i}`, s = prop.size, colour = PROP_COLOURS[prop.color];
    materials[key] = { color: colour, roughness: .2, coat: .9, coat_roughness: .05, metallic: prop.shape === 'coin' ? .45 : 0 };
    const x = prop.x * 3.4, y = -.4 + prop.depth * 2.6;
    if (prop.shape === 'ball') prims.push({ name: key, type: 'sphere', group: null, material: key, pos: [x, y, s], scale: [s, s, s], rot: [0, 0, 0] });
    else if (prop.shape === 'block') {
      meshes[`block${i}`] = sweep(u => { const z = 2 * s * u, k = (z - s) / s; return { z, r: s * (1 - Math.abs(k) ** 8) ** .125, d: 1, n: 8 }; }, 24, 48);
      prims.push({ name: key, type: 'mesh', group: null, material: key, mesh: `block${i}`, pos: [x, y, 0], rot: [0, 0, .5 * (i % 2 ? 1 : -1)] });
    } else if (prop.shape === 'pillar') {
      meshes[`pillar${i}`] = lathe(s * .55, s * 4, .08);
      prims.push({ name: key, type: 'mesh', group: null, material: key, mesh: `pillar${i}`, pos: [x, y, s * 2], rot: [0, 0, 0] });
    } else if (prop.shape === 'ring') {
      meshes[`ring${i}`] = tube(Array.from({ length: 48 }, (_, j) => { const a = TAU * j / 48; return [s * Math.cos(a), 0, s * Math.sin(a)]; }), s * .28, 20, true);
      prims.push({ name: key, type: 'mesh', group: null, material: key, mesh: `ring${i}`, pos: [x, y, s * 1.28], rot: [0, 0, .4] });
    } else {
      meshes[`coin${i}`] = lathe(s * .8, s * .22, s * .06);
      prims.push({ name: key, type: 'mesh', group: null, material: key, mesh: `coin${i}`, pos: [x, y, s * .8], rot: [Math.PI / 2, 0, .3] });
    }
  });
  const night = stage.set === 'night';
  return {
    beat: beat.id, set: stage.set, materials, meshes, groups, prims, actors,
    lights: [
      { name: 'key', pos: [-3.2, -4.4, 4.6], target: [0, 0, .9], size: 3, power: night ? 380 : 520, color: tone.key, shadow: true },
      { name: 'fill', pos: [4.4, -3.4, 2.4], target: [0, 0, .9], size: 4, power: night ? 110 : 170, color: tone.fill },
      { name: 'rim', pos: [1.8, 3.4, 4.2], target: [0, 0, 1.2], size: 2, power: night ? 700 : 520, color: tone.rim },
    ],
    world: { color: tone.world, strength: night ? .2 : .32, bounce: tone.bounce },
  };
}

// -- camera ----------------------------------------------------------------------------------------------------------

export function fovs(lens, w, h) {
  const hf = 2 * Math.atan(SENSOR / 2 / lens);
  return { h: hf, v: 2 * Math.atan(Math.tan(hf / 2) * h / w) };
}
// The shot's framing: where the subject's feet and the top of its head sit on screen, above the caption band when
// captioned (feet 5% of the height above the caption band, as Pack A stands its figures, so a two-line caption stays clear;
// Pack A's close shot is likewise the whole figure at about three quarters
// of the frame), with room above the head for a floating label; and the camera's move over the beat (push, pull, pan as
// a slow orbit, shake).
const FRAMING = { captioned: { wide: [.43, .75], medium: [.3, .75], close: [.17, .75] }, clean: { wide: [.42, .86], medium: [.28, .88], close: [.13, .9] } };
export function cameraAt(model, beat, t, w, h, captioned) {
  const stage = beat.stage, duration = Math.max(.1, beat.end - beat.start), p = clamp(t / duration);
  const actors = model.actors.filter(a => a.kind === 'character');
  const speaker = actors.find(a => a.member.speaking) || actors[0];
  const lens = stage.shot === 'close' ? 50 : stage.shot === 'medium' ? 42 : 35;
  const f = fovs(lens, w, h), frame = FRAMING[captioned ? 'captioned' : 'clean'];
  const xs = model.actors.map(a => a.place.x);
  const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const centre = stage.shot === 'wide' ? (xs.length ? (Math.max(...xs) + Math.min(...xs)) / 2 : 0) : speaker ? speaker.place.x : 0;
  const feet = speaker ? speaker.place.z : 0, top = speaker ? speaker.place.z + speaker.top : 1.6;
  const k = inOut(p);
  const move = beat.camera === 'push' ? 1.06 - .1 * k : beat.camera === 'pull' ? .96 + .1 * k : 1;
  const [yt, yf] = frame[stage.shot];
  let view = (top - feet) / (yf - yt);
  if (stage.shot === 'wide') view = Math.max(view, 2 * (spread / 2 + 1.0) / Math.tan(f.h / 2) * Math.tan(f.v / 2));
  // A push or pull keeps the feet where they are on screen and grows or shrinks the figure above them.
  view *= move;
  const zc = feet + (yf - .5) * view;
  const distance = view / 2 / Math.tan(f.v / 2);
  const orbit = beat.camera === 'pan' ? (k - .5) * .3 : 0;
  const shake = beat.camera === 'shake' ? Math.sin(t * 23 + 1) * .006 : 0;
  const side = stage.shot === 'wide' || !speaker ? 0 : speaker.place.x > .3 ? -1 : speaker.place.x < -.3 ? 1 : 0;
  const yaw = -Math.PI / 2 + orbit + .1 * side;
  const elevation = stage.shot === 'wide' ? .12 : stage.shot === 'medium' ? .07 : .03;
  const target = [centre + shake, 0, zc];
  const pos = [target[0] + distance * Math.cos(yaw) * Math.cos(elevation), target[1] + distance * Math.sin(yaw) * Math.cos(elevation),
    target[2] + distance * Math.sin(elevation) + shake];
  return { pos, target, lens };
}

// A world point to frame pixels: [x, y from the top-left, depth in front of the camera]. The same projection three.js
// and Blender make with the same camera (horizontal sensor fit), so labels drawn in 2D sit on the 3D heads in both.
export function project(camera, point, w, h) {
  const f = norm(sub(camera.target, camera.pos)), r = norm(cross(f, [0, 0, 1])), u = cross(r, f), d = sub(point, camera.pos);
  const z = dot(d, f), v = fovs(camera.lens, w, h);
  if (z <= 1e-4) return [NaN, NaN, z];
  return [(dot(d, r) / (z * Math.tan(v.h / 2)) + 1) / 2 * w, (1 - dot(d, u) / (z * Math.tan(v.v / 2))) / 2 * h, z];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };

// Everything that moves at t seconds into the beat: group transforms, the camera, and each actor's anchors in the
// world (head top for labels, body and head centres for the sheet checks).
export function stagePose(model, beat, t, w, h, captioned) {
  const groups = {}, anchors = {};
  for (const actor of model.actors) {
    if (actor.kind === 'character') {
      const pose = memberPose(actor.member, { plan: actor.plan }, t, actor.member.speaking ? beat.mouth : '', hash(`${beat.id}:${actor.index}`) % 997, actor.place);
      for (const [name, value] of Object.entries(pose)) if (name !== 'cheeks') groups[`${actor.key}_${name}`] = value;
      for (const side of ['l', 'r']) groups[`${actor.key}_cheek_${side}`] = T(0, 0, 0, 0, 0, 0, pose.cheeks, 1, pose.cheeks);
      const root = pose.root, lift = root[2], sz = root[8];
      const at = z => [actor.place.x, actor.place.y, actor.place.z + lift + z * sz];
      // The sheet checks sample the skin between the cheeks and the middle of the belly (core/character_checks.py).
      anchors[actor.key] = { label: at(actor.top + .12), body: at(actor.plan.zb), head: at(actor.plan.zh - .2 * actor.plan.hh), feet: at(0), top: at(actor.top), width: actor.plan.br };
    } else {
      const bob = .015 * Math.sin(TAU * t / 2.3 + actor.place.phase), sway = .04 * Math.sin(TAU * t / 3.7 + actor.place.phase);
      groups[actor.key] = T(0, 0, bob, 0, 0, sway, 1, 1, 1);
      const at = z => [actor.place.x, actor.place.y, bob + z];
      anchors[actor.key] = { label: at(actor.top + .1), body: at(.6 * actor.place.scale), head: at(1.3 * actor.place.scale), feet: at(0), top: at(actor.top), width: .2 * actor.place.scale };
    }
  }
  return { beat: beat.id, camera: cameraAt(model, beat, t, w, h, captioned), groups, anchors };
}

// Labels on screen at t: each with its projected anchor and how far it has popped in. Drawn by the 2D engine (engine.js).
export function labelsAt(model, beat, pose, t, w, h) {
  const out = [];
  for (const label of beat.stage.labels) {
    const anchor = pose.anchors[label.over];
    if (!anchor || t < label.at) continue;
    const [x, y, z] = project(pose.camera, anchor.label, w, h);
    if (!Number.isFinite(x) || z <= 0) continue;
    out.push({ ...label, x, y, depth: z, k: backOut(range(t, label.at, label.at + .45)) });
  }
  return out;
}

// Each actor's box in frame pixels (projected from its feet, top and width), for the layout report and the checks.
export function actorBoxes(model, beat, pose, w, h) {
  const out = [];
  for (const actor of model.actors) {
    const a = pose.anchors[actor.key];
    const pts = [a.feet, a.top].flatMap(p => [-1, 1].flatMap(sx => [-1, 1].map(sy => [p[0] + sx * a.width * 1.15, p[1] + sy * a.width, p[2]])));
    const proj = pts.map(p => project(pose.camera, p, w, h)).filter(p => Number.isFinite(p[0]));
    if (!proj.length) continue;
    const xs = proj.map(p => p[0]), ys = proj.map(p => p[1]);
    const [fx, fy] = project(pose.camera, a.feet, w, h), [tx, ty] = project(pose.camera, a.top, w, h);
    const [bx, by] = project(pose.camera, a.body, w, h), [hx, hy] = project(pose.camera, a.head, w, h);
    out.push({ key: actor.key, kind: actor.kind, character: actor.character, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys), height: Math.hypot(fx - tx, fy - ty), body: { cx: bx, cy: by }, head: { cx: hx, cy: hy } });
  }
  return out;
}
