// Pack C's voxel world as data (static/motion/voxel.js): what the three.js renderer plays. Run: node scripts/test_voxel_model.mjs
// Checks that every world is deterministic (the same seed builds the same blocks, another seed builds others), stays
// within its block budget, keeps the stage flat and the ground in front of the cast below the feet, that the blocky
// character keeps our own proportions (a big head, not a quarter of the height), that its pixel face changes with the
// expression and the mouth codes from the narration, that the mouth follows the codes frame by frame, and that labels
// and framing work as in Pack B. Also: the block palette has no well-known block game's look (no block whose top and
// sides differ in colour, no names from it).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voxelModel, voxelPose, normalizeVoxel, worldModel, voxelCharacter, voxelPlan, voxelMemberPose, faceCells, labelsAt, actorBoxes,
  asStage, WORLDS, TIMES, BLOCKS, LIMITS, B, swell } from '../static/motion/voxel.js';

const pip = { name: 'Pip Block', family: 'round', accessory: 'leaf', outline: 7, form: 'voxel',
  proportions: { head: .42, body_width: .62, limb_length: .26, limb_width: .055, eye_size: .036 },
  palette: { body: '#f4a259', body_shade: '#e0843d', head: '#f7c08a', limb: '#5b4a6b', eye: '#231b2e', mouth: '#8c3b4a', outline: '#2e2438', accent: '#7cc6a4', cheek: '#f08a8a' } };
const chars = { aaaaaaaaaaaa: { spec: pip, version: 1 } };
const beat = (voxel, camera = 'pan', mouth = 'XXAAEEOOMMFFXX') => ({ id: 'b1', kind: 'voxel', start: 0, end: 4, camera, mouth, voxel: normalizeVoxel(voxel) });
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };

// 1. Every world and time of day: deterministic, inside the budget, the stage flat, nothing in front above the feet.
for (const world of WORLDS) for (const time of TIMES) {
  const v = normalizeVoxel({ world, time, seed: 7 });
  const a = worldModel(v), b = worldModel(v);
  assert.deepEqual(a, b); checks++;
  ok(a.boxes.length > 500 && a.boxes.length <= LIMITS.boxes, `${world}/${time}: ${a.boxes.length} blocks, inside the budget`);
  ok(a.boxes.every(x => BLOCKS[x.block] && [x.x, x.y, x.z, x.s].every(Number.isFinite)), `${world}: every block is known and placed`);
  for (const x of a.boxes) {
    const top = x.z + (x.sz ?? x.s) / 2;
    // The stage (where the cast stands) and the path to the camera stay at or below the cast's feet.
    if (Math.abs(x.x) < 3 && x.y < 1.2 && x.y > -9 && top > .02 && !(world === 'cave' && x.z > 3)) assert.fail(`${world}: a block at ${x.x}, ${x.y} stands ${top.toFixed(2)} m over the stage`);
  }
  checks++;
  if (time === 'day') {
    const other = worldModel(normalizeVoxel({ world, time, seed: 8 }));
    ok(JSON.stringify(other.boxes) !== JSON.stringify(a.boxes), `${world}: another seed builds another world`);
  }
}

// 2. Our own look: block names and colours. No block shows a different top strip on its sides (every block is one colour
// all round), none is named after a well-known block game's blocks, and the palette is pastel, not that game's greens and browns.
const forbidden = /grass|dirt|cobble|plank|oak|creeper|ender|nether|redstone|obsidian|diamond|ore|tnt|minecraft|mojang/i;
for (const [name, def] of Object.entries(BLOCKS)) {
  ok(!forbidden.test(name), `block ${name} has our own name`);
  ok(/^#[0-9a-f]{6}$/.test(def.color) && !('top' in def) && !('side' in def), `block ${name} is one colour on every face`);
}
const source = readFileSync(new URL('../static/motion/voxel.js', import.meta.url), 'utf8') + readFileSync(new URL('../static/motion/voxel3d.js', import.meta.url), 'utf8');
ok(!/minecraft|mojang|creeper|enderman|herobrine/i.test(source.replace(/well-known block game/g, '')), 'the voxel code names no other game or its mobs');

// 3. The character: our own proportions (a head about 40% of the height, not a quarter), a closed rig, a face.
const cm = voxelCharacter(pip), P = voxelPlan(pip);
ok(P.head / P.H > .36 && P.head / P.H < .5, `the head is ${(P.head / P.H * 100).toFixed(0)}% of the height (a quarter would read as another game's)`);
ok(P.hw > P.bw, 'the head is wider than the body');
ok(Math.abs(P.leg + P.body + P.head - P.H) < 1e-9, 'legs, body and head add up to the height');
for (const part of cm.parts) ok(cm.groups[part.group] && part.size.every(v => v > 0), `part ${part.name} has its group and a size`);
ok(cm.face.size[0] > 0 && cm.face.pos[1] < -P.hd / 2, 'the face sits just in front of the head');
for (const family of ['round', 'square', 'triangle']) {
  const plan = voxelPlan({ ...pip, family });
  ok(plan.bevel > 0 && plan.bevel <= .35, `${family}: rounded edges`);
  if (family === 'triangle') ok(plan.taper < 1 && plan.splay > .03, 'a triangle body narrows at the top and its arms clear the hips');
}

// 4. The pixel face: each expression and each mouth code draws something different, blinks close the eyes, and the
// eyes keep a light catch (a face with highlights, not two dark squares).
const faces = new Set();
for (const e of ['neutral', 'happy', 'surprised', 'worried', 'thinking']) for (const m of ['X', 'A', 'E', 'O', 'M', 'F']) faces.add(JSON.stringify(faceCells(e, m)));
ok(faces.size >= 26, `${faces.size} distinct faces from 5 expressions and 6 mouth shapes`);
ok(faceCells('neutral', 'X').some(c => c[2] === 'catch') && faceCells('neutral', 'X').some(c => c[2] === 'cheek'), 'eyes have a catch light and the cheeks show');
ok(JSON.stringify(faceCells('neutral', 'X', 1)) !== JSON.stringify(faceCells('neutral', 'X', 0)), 'a blink closes the eyes');
ok(faceCells('neutral', 'X').every(([x, y]) => x >= 0 && x < 16 && y >= 0 && y < 16), 'the face stays on its 16 x 16 grid');

// 5. Mouth timing: frame n of the beat shows the code measured for frame n of the line (unit 3's envelope method).
const codes = 'XXAAAEEEOOOMMFFXXX';
for (let n = 0; n < codes.length; n++) {
  const pose = voxelMemberPose({ action: 'idle', expression: 'neutral', speaking: true, facing: 'camera', react: null }, P, (n + .5) / 30, codes, 3, {});
  assert.equal(pose.face.mouth, codes[n]); checks++;
}
const silent = voxelMemberPose({ action: 'idle', expression: 'neutral', speaking: false, facing: 'camera', react: null }, P, .1, codes, 3, {});
ok(silent.face.mouth === 'X', 'a character that is not speaking keeps its mouth at rest');
const react = voxelMemberPose({ action: 'idle', expression: 'neutral', speaking: false, facing: 'camera', react: { at: 1, expression: 'surprised' } }, P, 1.5, '', 3, {});
ok(react.face.expression === 'surprised', 'a reaction changes the face mid-shot');

// 6. The beat: complete and deterministic poses; labels above heads and inside the frame; framing grows wide to close.
const b = beat({ world: 'village', time: 'dusk', shot: 'wide', cast: [{ character: 'aaaaaaaaaaaa', speaking: true, action: 'wave' }],
  people: { count: 4, seed: 2 }, props: [{ kind: 'lantern', x: -.8 }, { kind: 'gem', x: .8 }], labels: [{ over: 'c0', text: '3.5%', sub: 'salt', at: .2 }, { over: 'p1', text: '7', at: .1 }] });
const model = voxelModel(b, chars);
assert.deepEqual(voxelModel(b, chars), model); checks++;
for (const part of model.parts) ok(model.groups[part.group], `part ${part.name} has its group`);
for (const t of [0, .5, 1.7, 3.99]) {
  const pose = voxelPose(model, b, t, 1920, 1080, true);
  assert.deepEqual(voxelPose(model, b, t, 1920, 1080, true), pose); checks++;
  for (const [name, v] of Object.entries(pose.groups)) { ok(model.groups[name], `pose group ${name} is in the model`); ok(v.every(Number.isFinite), `${name} is finite`); }
}
const pose = voxelPose(model, b, 1, 1920, 1080, true), labels = labelsAt(model, asStage(b), pose, 1, 1920, 1080);
ok(labels.length === 2, 'both labels are shown');
const box = actorBoxes(model, asStage(b), pose, 1920, 1080).find(x => x.key === 'c0');
ok(labels[0].y < box.head.cy, 'the label floats above the head');
ok(labels.every(l => l.x > 0 && l.x < 1920 && l.y > 0 && l.y < 1080), 'labels are in frame');
const heights = ['wide', 'medium', 'close'].map(shot => {
  const bb = beat({ world: 'meadow', shot, cast: [{ character: 'aaaaaaaaaaaa', speaking: true }] }, 'still'), m = voxelModel(bb, chars);
  const x = actorBoxes(m, asStage(bb), voxelPose(m, bb, 1, 1920, 1080, true), 1920, 1080)[0];
  ok(x.y + x.h < 1080 * .82, `${shot}: the feet stay above the caption band`);
  return x.height / 1080;
});
ok(heights[0] < heights[1] && heights[1] < heights[2], 'wide < medium < close');
ok(Math.abs(swell(1, 2, 3) - swell(1, 2, 3)) === 0 && Math.abs(swell(1, 2, 3)) < .05, 'the swell is small and the same every time');
ok(B === .5, 'half-metre blocks: a character stands three blocks tall');
console.log(`voxel model: ${checks} checks passed`);
