// Pack B's 3D stage as data (static/motion/stage.js): what both renderers play. Run: node scripts/test_stage_model.mjs
// Checks that the model is complete and deterministic, that the spike's three flaws are gone (the head and body are one
// surface, the leaf is a folded blade, the arms stay in front of the body through an orbit), that labels sit above heads
// and inside the frame, and that the projection matches a camera built the way three.js and Blender build theirs.
import assert from 'node:assert/strict';
import { stageModel, stagePose, normalizeStage, labelsAt, actorBoxes, project, characterModel, fovs } from '../static/motion/stage.js';

const pip = { name: 'Pip 3D', family: 'round', accessory: 'leaf', outline: 7, form: '3d',
  proportions: { head: .42, body_width: .62, limb_length: .26, limb_width: .055, eye_size: .036 },
  palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', limb: '#5b4a6b', eye: '#231b2e', mouth: '#8c3b4a', outline: '#2e2438', accent: '#7cc6a4', cheek: '#f08a8a' } };
const chars = { aaaaaaaaaaaa: { spec: pip, version: 1 } };
const beat = (stage, camera = 'pan') => ({ id: 'b1', kind: 'stage', start: 0, end: 4, camera, mouth: 'XXAAEEOOMMFFXX', stage: normalizeStage(stage) });
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };

// 1. Complete and deterministic.
const b = beat({ shot: 'wide', cast: [{ character: 'aaaaaaaaaaaa', speaking: true, action: 'wave' }], people: { count: 5, seed: 2 },
  props: [{ shape: 'ball' }, { shape: 'ring', x: .8 }], labels: [{ over: 'c0', text: '5 h 40 m', sub: 'slept', at: .2 }, { over: 'p1', text: '7 h', at: .1 }] });
const model = stageModel(b, chars);
assert.deepEqual(stageModel(b, chars), model); checks++;
for (const p of model.prims) {
  ok(!p.group || model.groups[p.group], `prim ${p.name} has its group`);
  ok(model.materials[p.material], `prim ${p.name} has its material`);
  ok(p.type !== 'mesh' || model.meshes[p.mesh], `prim ${p.name} has its mesh`);
}
for (const t of [0, .5, 1.7, 3.99]) {
  const pose = stagePose(model, b, t, 1920, 1080, true);
  assert.deepEqual(stagePose(model, b, t, 1920, 1080, true), pose); checks++;
  for (const [name, v] of Object.entries(pose.groups)) { ok(model.groups[name], `pose group ${name} is in the model`); ok(v.every(Number.isFinite), `${name} is finite`); }
}

// 2. The spike's flaws. One surface for head and body (a single mesh, no separate head sphere), with no seam: its radius
// never drops to a pinch between them.
const cm = characterModel(pip);
ok(!cm.prims.some(p => p.name === 'head'), 'no separate head sphere');
const body = cm.meshes.body, zs = [];
for (let i = 2; i < body.verts.length; i += 3) zs.push(body.verts[i]);
ok(Math.max(...zs) - Math.min(...zs) > 1.2, 'the body mesh runs from the legs to the top of the head');
const ring = z => {
  let near = Infinity, r = 0;
  for (let i = 2; i < body.verts.length; i += 3) near = Math.min(near, Math.abs(body.verts[i] - z));
  for (let i = 0; i < body.verts.length; i += 3) if (Math.abs(Math.abs(body.verts[i + 2] - z) - near) < 1e-6) r = Math.max(r, Math.hypot(body.verts[i], body.verts[i + 1]));
  return r;
};
ok(ring(cm.plan.neck) > .6 * Math.min(cm.plan.hr, cm.plan.br), 'the neck is a soft waist, not a pinch');
// The leaf is a blade with a fold: its points are not all in one plane.
const leaf = cm.meshes.leaf, lz = [];
for (let i = 2; i < leaf.verts.length; i += 3) lz.push(leaf.verts[i]);
ok(Math.max(...lz) - Math.min(...lz) > .02, 'the leaf is folded and curled, not a flat disc');
// Arms hang in front of the body's middle plane, so an orbit never shows one passing behind the body.
for (const side of ['l', 'r']) ok(cm.groups['arm_' + side].pivot[1] < 0 && cm.prims.find(p => p.name === 'hand_' + side).pos[1] < 0, `arm ${side} is in front`);

// 3. Labels: above the head they belong to, inside the frame, popped in after their time.
const pose = stagePose(model, b, 1, 1920, 1080, true), labels = labelsAt(model, b, pose, 1, 1920, 1080);
ok(labels.length === 2, 'both labels are shown');
const boxes = actorBoxes(model, b, pose, 1920, 1080);
const pipBox = boxes.find(x => x.key === 'c0');
ok(labels[0].y < pipBox.head.cy, 'the label is above the head');
ok(labels.every(l => l.x > 0 && l.x < 1920 && l.y > 0 && l.y < 1080), 'labels are in frame');
ok(labelsAt(model, b, stagePose(model, b, .05, 1920, 1080, true), .05, 1920, 1080).length === 0, 'labels wait for their time');

// 4. The projection: the camera target lands in the middle of the frame; a point to the right lands right.
const cam = pose.camera, [cx, cy] = project(cam, cam.target, 1920, 1080);
ok(Math.abs(cx - 960) < 1e-6 && Math.abs(cy - 540) < 1e-6, 'the target is the frame centre');
ok(project(cam, [cam.target[0] + 1, cam.target[1], cam.target[2]], 1920, 1080)[0] > 960, '+X is screen right');
const f = fovs(35, 1920, 1080);
ok(Math.abs(f.h - 2 * Math.atan(18 / 35)) < 1e-12 && f.v < f.h, 'horizontal sensor fit, 36 mm');

// 5. Framing per shot: the figure grows from wide to medium to close and stays above the caption band.
const heights = ['wide', 'medium', 'close'].map(shot => {
  const bb = beat({ shot, cast: [{ character: 'aaaaaaaaaaaa', speaking: true }] }, 'still'), m = stageModel(bb, chars);
  const box = actorBoxes(m, bb, stagePose(m, bb, 1, 1920, 1080, true), 1920, 1080)[0];
  ok(box.y + box.h < 1080 * .82, `${shot}: the feet stay above the caption band`);
  return box.height / 1080;
});
ok(heights[0] < heights[1] && heights[1] < heights[2], 'wide < medium < close');
console.log(`stage model: ${checks} checks passed`);
