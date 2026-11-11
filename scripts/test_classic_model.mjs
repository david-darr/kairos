// Pack C classic (static/motion/blocks.js, classic.js, story.js) as data: what the three.js renderer and the Story Short
// draw. Run: node scripts/test_classic_model.mjs
// Checks: every pixel texture is deterministic and follows its rules (the grass edge, plank seams, jitter, ore specks,
// cut-out flowers); the mesher draws faces only where no neighbour hides them and water's top only; the classic box
// proportions and pivots; faces (the eye, brow and mouth set, a closed and an open mouth per mood, tears); poses on constant
// keys with the reference's numbers; the story's word timing, cuts and cameras; the effects; the split-screen layout, the
// one-word captions, the mouth's minimum hold and the flashback grade; and the distance rules (no other game's names).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEXTURES, blockTexture, pixel, grassEdge, plankSeam, COLOURS, BLOCKS, skinTexture, faceTexture, faceCells, MOODS, MOOD_FACE, TEAR, rgb } from '../static/motion/blocks.js';
import { worldModel, meshWorld, PLACES, P, HEIGHT, BODY, blockPlan, blockCharacter, poseAt, keyed, KEY_RATE, normalizeStory, storyModel, storyPose,
  timeOf, shotAt, wordStarts, CUT_EARLY, FOV, debrisAt, smokeAt, blastLight, blastShake, splatAt, fuseAt, blastSet, groundAt, openFrames, classicBoxes,
  voxelAsStory, avatarCamera, POSES } from '../static/motion/classic.js';
import { LAYOUT, W, H, captionAt, mouthOpen, edgeFlash, SEPIA, KEY_WORDS, words as lineWords } from '../static/motion/story.js';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const near = (a, b, tol, message) => ok(Math.abs(a - b) <= tol, `${message}: ${a} vs ${b}`);

// 1. Textures: 16 x 16, deterministic (drawn twice the same), each pixel jittered within 8 (plus a small per-channel wobble).
for (const name of TEXTURES) {
  const a = blockTexture(name);
  ok(a.w === 16 && a.h === 16 && a.data.length === 16 * 16 * 4, `${name} is 16 x 16`);
}
// A fresh module load draws the same pixels (determinism across runs, not just a cache hit).
const again = await import('../static/motion/blocks.js?again');
for (const name of TEXTURES) eq(Array.from(again.blockTexture(name).data), Array.from(blockTexture(name).data), `${name} is drawn the same every time`);
const dirt = blockTexture('dirt'), side = blockTexture('grass_side'), top = blockTexture('grass_top');
let jitterMax = 0;
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const [r, g, b] = pixel(top, x, y);
  jitterMax = Math.max(jitterMax, ...[r, g, b].map((v, i) => Math.abs(v - COLOURS.grass[i])));
}
ok(jitterMax >= 3 && jitterMax <= 10, `grass pixels jitter by 3 to 8 (plus 1 or 2 per channel): ${jitterMax}`);
for (let x = 0; x < 16; x++) {
  const edge = grassEdge(x);
  ok(edge >= 3 && edge <= 5, `the grass side is green for 3 to 5 px (column ${x}: ${edge})`);
  const green = pixel(side, x, edge - 1), below = pixel(side, x, edge);
  ok(green[1] > green[0] + 30 && below[0] > below[1] - 5, `column ${x}: green over the edge, dirt under it`);
}
for (const y of [3, 7, 11, 15]) ok(plankSeam(y), `a plank seam on row ${y}`);
const planks = blockTexture('planks');
ok(pixel(planks, 5, 3)[0] < pixel(planks, 5, 1)[0] - 10, 'the seam row is darker than the board');
const ore = blockTexture('ore_copper');
ok([...Array(256).keys()].some(i => { const [r, g] = pixel(ore, i % 16, Math.floor(i / 16)); return r > 180 && g < 150; }), 'ore specks show in the stone');
const flower = blockTexture('flower_red');
ok(pixel(flower, 0, 0)[3] === 0 && pixel(flower, 7, 12)[3] === 255, 'a flower is a cut-out sprite');
eq(BLOCKS.water.faces, ['water', null, null], 'water shows its top only');
eq(BLOCKS.grass.faces, ['grass_top', 'dirt', 'grass_side'], 'grass: green top, a green-edged side, dirt underneath');

// 2. The mesher: faces only where no neighbour hides them, gathered per texture; water's top dropped 0.12.
const two = { blocks: new Map([['0,0,0', 'stone'], ['1,0,0', 'stone']]), sprites: [] };
const m2 = meshWorld(two);
eq(m2.stone.count, 10, 'two touching cubes show 10 faces, not 12');
const pool = { blocks: new Map([['0,0,0', 'water'], ['0,0,-1', 'dirt']]), sprites: [] };
const mw = meshWorld(pool);
ok(mw.water.count === 1 && mw.water.positions.every((v, i) => i % 3 !== 2 || Math.abs(v - .88) < 1e-9), 'water is one top face, 0.12 below the block top');
ok(mw.dirt.count === 6, 'dirt under water keeps its top (seen through the water)');
for (const place of PLACES) {
  const a = worldModel(place, 3), b = worldModel(place, 3);
  eq([...a.blocks], [...b.blocks], `${place}: the same seed builds the same world`);
  const mesh = meshWorld(a), faces = Object.values(mesh).reduce((n, v) => n + v.count, 0);
  ok(faces > 1000 && faces < 60000, `${place}: ${faces} faces`);
  ok(Object.keys(mesh).every(t => TEXTURES.includes(t)), `${place}: every face uses a texture drawn in code`);
  if (place !== 'cave' && place !== 'sky-island') ok(groundAt(a, 0.5, 0.5) === 0, `${place}: the cast stands on z = 0`);
}
ok(worldModel('cliff', 2).marks.edge && worldModel('cliff', 2).marks.drop >= 20, 'the cliff has an edge and a long drop');
ok([...worldModel('meadow', 1).blocks.values()].includes('log') && [...worldModel('meadow', 1).blocks.values()].includes('leaves'), 'trees are logs with leaves');

// 3. The character: the reference's classic proportions and pivots, in P = 1/16.
eq(BODY.torso, [8 * P, 4 * P, 12 * P], 'torso 8 x 4 x 12 P');
eq(BODY.limb, [4 * P, 4 * P, 12 * P], 'arms and legs 4 x 4 x 12 P');
ok(BODY.head === 8 * P && BODY.pivot === 12 * P, 'an 8 P head; the body pivot 12 P up');
eq(BODY.shoulder, [6 * P, 0, 10 * P], 'shoulder pivots at (+-6 P, 0, 10 P) over the body pivot');
eq(BODY.hip, [2 * P, 0, 0], 'hip pivots at (+-2 P, 0, 0)');
ok(Math.abs(HEIGHT - 2) < 1e-9, 'a character is 32 P, two blocks, tall');
const outfit = { skin: '#f0c8a8', hair: '#1d1a22', hair_style: 'long', shirt: '#5e2b8c', detail: '#e8e3f0', detail_style: 'heart', pants: '#2a2833', shoes: '#ececec', eyes: '#2d2140' };
const cm = blockCharacter('x', outfit, { headset: '#b05aff' });
ok(cm.groups.arm_l.pivot[2] === 22 * P && cm.groups.leg_r.pivot[0] === 2 * P, 'the pivots are placed on the body');
ok(cm.parts.some(p => p.name === 'hair') && cm.parts.some(p => p.name === 'cup_l' && p.colour === '#b05aff'), 'long hair is a slab; the avatar headset is in the speaker colour');
for (const p of cm.parts.filter(p => !p.colour)) ok(['front', 'back', 'left', 'right', 'top', 'bottom'].every(f => p.tex[f]), `${p.name}: a texture on every face`);
const arm = skinTexture(outfit, 'arm', 'front'), leg = skinTexture(outfit, 'leg', 'front'), torso = skinTexture(outfit, 'torso', 'front');
ok(arm.w === 4 && arm.h === 12 && Math.abs(pixel(arm, 1, 10)[0] - rgb(outfit.skin)[0]) < 12, 'a sleeve ends in a skin hand (bottom 4 px)');
ok(Math.abs(pixel(leg, 1, 11)[0] - rgb(outfit.shoes)[0] * .72) < 14 && Math.abs(pixel(leg, 1, 4)[2] - rgb(outfit.pants)[2]) < 12, 'pants with shoes in the bottom 3 px');
ok(Math.abs(pixel(torso, 4, 4)[0] - rgb(outfit.detail)[0]) < 4, 'the shirt front carries its detail (a pixel heart)');
const headSide = skinTexture(outfit, 'head', 'left');
ok(Math.abs(pixel(headSide, 8, 2)[0] - rgb(outfit.hair)[0]) < 12 && Math.abs(pixel(headSide, 8, 10)[0] - rgb(outfit.skin)[0]) < 12, 'hair down to row 6 on the sides');

// 4. Faces: eyes 2 px wide at x 3-4 and 11-12 on row 7; brows two rows up; every mood a closed and an open mouth; tears.
const at = (cells, x, y) => cells.find(c => c[0] === x && c[1] === y)?.[2];
const neutral = faceCells('neutral');
ok(['white', 'pupil'].includes(at(neutral, 3, 7)) && ['white', 'pupil'].includes(at(neutral, 4, 7)) && at(neutral, 11, 7) && at(neutral, 12, 7), 'eyes at x 3-4 and 11-12, row 7');
for (const mood of MOODS) {
  const closed = JSON.stringify(faceCells(mood, false)), opened = JSON.stringify(faceCells(mood, true));
  ok(closed !== opened, `${mood}: a closed and an open mouth`);
}
ok(faceCells('crying').some(c => c[2] === 'tear' && c[1] === 14), 'crying: light-blue tears down to row 14');
eq(TEAR, [120, 190, 255], 'the tear colour');
ok(faceCells('scared').filter(c => c[2] === 'white').length === 8, 'scared: wide eyes');
ok(faceCells('happy').some(c => c[2] === 'pupil' && c[1] === 6), 'happy: ^ ^ eyes');
ok(faceCells('laughing', true).some(c => c[2] === 'teeth'), 'laughing open: a row of teeth');
ok(faceCells('neutral', true).some(c => c[2] === 'tongue'), 'open: a red tongue');
ok(faceCells('splat').some(c => c[2] === 'cream'), 'the splat face');
ok(Object.keys(MOOD_FACE).length === MOODS.length, 'every mood has a face');
const face = faceTexture(outfit, 'neutral');
ok(Math.abs(pixel(face, 7, 1)[0] - rgb(outfit.hair)[0]) < 12, 'the hairline on rows 0 to 3');

// 5. Poses on constant keys: values change in steps, never in between; the reference's walk and run numbers.
const DEG = Math.PI / 180;
for (const pose of POSES) {
  let changes = 0, prev = null;
  for (let f = 0; f < 60; f++) {
    const q = JSON.stringify(poseAt(pose, f / 30, { talking: true }));
    if (prev !== null && q !== prev) changes++;
    prev = q;
  }
  ok(changes <= 2 * 12, `${pose}: at most a dozen held keys a second (${changes} in 2 s)`);
}
const walk = [...Array(30).keys()].map(f => poseAt('walk', f / 30).leg_l[0]);
near(Math.max(...walk), 34 * DEG, 1e-9, 'walk legs swing 34 degrees'); near(Math.min(...walk), -34 * DEG, 1e-9, 'and back');
ok(new Set(walk.map(v => v.toFixed(6))).size === 3, 'a walk key is held: only -34, 0 and 34 degrees appear');
near(Math.max(...[...Array(30).keys()].map(f => poseAt('walk', f / 30).arm_r[0])), 31 * DEG, 1e-9, 'walk arms swing 31 degrees');
near(Math.max(...[...Array(30).keys()].map(f => poseAt('run', f / 30).leg_l[0])), 55 * DEG, 1e-9, 'run legs swing 55 degrees');
near(poseAt('run', .1).body[0], 10 * DEG, 1e-9, 'a run leans 10 degrees');
ok(poseAt('hang', 0).arm_l[0] < -Math.PI, 'hang: arms over and behind the head, gripping the edge');
ok(keyed(.2) === Math.floor(.2 * KEY_RATE) / KEY_RATE, 'keys snap time down to the key grid');

// 6. The story: words, cuts on words, moves, leaving, the fall, cameras.
const chars = { aaaaaaaaaaaa: { spec: { outfit, colour: '#b05aff' } }, bbbbbbbbbbbb: { spec: { outfit: { ...outfit, shirt: '#e2592c' }, colour: '#ffa028' } } };
const beat = { id: 'b', kind: 'story', start: 10, end: 12, say: 'Help me, please, right now!', speaker: 'aaaaaaaaaaaa', mouth: 'XXAAAAEEXXOOAA', lead: .06, speech: 1.6,
  words: [{ start: 10.06, end: 10.3 }, { start: 10.35, end: 10.5 }, { start: 10.55, end: 10.9 }, { start: 11, end: 11.2 }, { start: 11.25, end: 11.6 }],
  story: normalizeStory({ place: 'cliff', cast: [{ character: 'aaaaaaaaaaaa', pose: 'hang', mood: 'scared' },
    { character: 'bbbbbbbbbbbb', x: 3, y: .9, pose: 'walk', face: 'c0', move: { to: [.7, .9], at: { t: 0 } }, leave: { at: { word: 4, after: .2 } } }],
  shots: [{ shot: 'close', on: 0, shake: true }, { shot: 'low', on: 1, at: { word: 2 } }, { shot: 'top', on: 0, at: { word: 4 } }],
  fx: [{ kind: 'fall', on: 0, at: { word: 4, after: .3 } }] }) };
eq(wordStarts(beat).map(v => +v.toFixed(3)), [.06, .35, .55, 1, 1.25], 'word starts come from the aligned words');
near(timeOf(beat, { word: 2 }, { cut: true }), .55 - CUT_EARLY, 1e-9, 'a cut lands 0.06 s before its word');
near(timeOf(beat, { word: 4, after: .2 }), 1.45, 1e-9, 'after: seconds later than the word');
eq([0, .6, 1.3].map(t => shotAt(beat, t).index), [0, 1, 2], 'three shots, cut on their words');
const noWords = { ...beat, words: [] };
ok(wordStarts(noWords).every((v, i, a) => i === 0 || v > a[i - 1]), 'without aligned words, the words share the line by letters');
const model = storyModel(beat, chars);
ok(Math.abs(model.actors[0].place.z - (0 - 34 * P)) < 1e-9, 'the hanger hangs with its hands at the edge');
const p0 = storyPose(model, beat, 0, 1080, 1280), p1 = storyPose(model, beat, .5, 1080, 1280), p2 = storyPose(model, beat, 1.9, 1080, 1280);
ok(p1.poses[1].x < 3 && p1.poses[1].pose === 'walk', 'the helper walks in');
ok(p2.poses[1].y > .9 && Math.abs(Math.abs(p2.poses[1].yaw) - Math.PI) < 1e-9, 'then turns and walks away');
const turn = storyPose(model, beat, 1.45 + .06, 1080, 1280).poses[1].yaw;
ok(Math.abs(turn - Math.PI / 2) < 1e-9, 'the turn is held at a quarter for its first keys (0.22 to 0.25 s in all)');
ok(p2.poses[0].z < model.actors[0].place.z - .5 && p2.poses[0].pose === 'flail', 'the fall drops him flailing (z = -0.5 x 13 x t^2)');
near(p2.poses[0].z - p1.poses[0].z, -.5 * 13 * (1.9 - 1.55) ** 2 - (p1.poses[0].q.lift - p2.poses[0].q.lift), .05, 'the fall follows 13 m/s^2');
eq([p0.camera.fov, p1.camera.fov, p2.camera.fov], [FOV.close, FOV.low, FOV.top], 'each shot has its lens');
ok(FOV.close >= 40 && FOV.close <= 44 && FOV.medium >= 46 && FOV.medium <= 52 && FOV.wide === 56 && FOV.low === 44, 'the reference lenses');
ok(p1.camera.pos[2] < model.actors[1].place.z + 28 * P, 'the low angle looks up at the helper');
ok(p2.camera.pos[2] > p2.camera.target[2] + 2, 'the top shot looks down');
const shaken = [0, 1 / 30, 2 / 30].map(t => storyPose(model, beat, t, 1080, 1280).camera.pos.join());
ok(new Set(shaken).size === 3, 'a panicky close shakes');
ok(p0.poses[0].open === true || storyPose(model, beat, 3 / 30, 1080, 1280).poses[0].open === true, 'the speaker\'s mouth opens with the voice');
ok(storyPose(model, beat, 3 / 30, 1080, 1280).poses[1].open === false, 'a listener\'s mouth stays shut');
const boxes = classicBoxes(model, p0, 1080, 1280, 640);
ok(boxes.some(b => b.key === 'c0' && b.y + b.h > 640 && b.body.cy > 640) && boxes.every(b => b.body && b.head), 'each cast member\'s box and check points, offset under the avatar strip');

// 7. Effects: the fuse speeds up, the blast throws blocks under gravity 20, 22 smoke cubes, light and shake decay, the splat.
const fuse = { t0: 0, seconds: 2 };
const flashes = [...Array(60).keys()].map(f => fuseAt(fuse, f / 30).flash);
const flips = f => f.slice(1).filter((v, i) => v !== f[i]).length;
ok(flips(flashes.slice(30)) > flips(flashes.slice(0, 30)), 'the fuse flashes faster towards the bang (3 to 12 Hz)');
ok(fuseAt(fuse, .05).scale > 1 && fuseAt(fuse, .2).scale === 1, 'the crate pops on a held key');
const world = worldModel('village', 1), blast = { pos: [10.5, 8.4, .5], radius: 3.2 };
const thrown = blastSet(world, blast);
ok(thrown.length > 10 && thrown.length <= 140, `a blast takes ${thrown.length} blocks`);
const d0 = debrisAt(thrown, blast, 1, 1.2), d1 = debrisAt(thrown, blast, 1, 1.4);
ok(d0.length === thrown.length && debrisAt(thrown, blast, 1, .9).length === 0, 'debris only after the bang');
const vz = (d1[0].pos[2] - d0[0].pos[2]) / .2, vz2 = (debrisAt(thrown, blast, 1, 1.6)[0].pos[2] - d1[0].pos[2]) / .2;
near(vz - vz2, 20 * .2, .02, 'gravity 20');
eq(smokeAt(blast, 0, .5).length, 22, '22 smoke cubes');
near(blastLight(0, .1), Math.exp(-.7), 1e-9, 'the orange light decays e^(-7t)');
near(blastShake(0, .5), .22 * Math.exp(-1.6), 1e-9, 'the camera shakes 0.22 e^(-3.2t)');
const splat = splatAt([0, 0, 1], 0, .2);
ok(splat.length === 26 && splat.filter(c => c.colour === '#d62838').length === 6, '26 splat cubes, about 3 white to 1 red');

// 8. The Story Short frame: the split screen, the caption, the mouth hold, the grade.
ok(W === 1080 && H === 1920 && LAYOUT.avatar.h === 640 && LAYOUT.scene.y === 640 && LAYOUT.scene.h === 1280, 'a 640 px avatar strip over a 1080 x 1280 scene');
ok(LAYOUT.border === 14 && LAYOUT.divider.h === 8, 'a 14 px border and an 8 px divider');
ok(LAYOUT.caption.y > LAYOUT.divider.y && LAYOUT.caption.size === 96 && LAYOUT.caption.outline === 12, 'captions under the divider, 96 px with a 12 px outline');
const starts = [.06, .35, .55, 1, 1.25];
eq(captionAt(beat, .01, starts), null, 'no word before the first');
const c2 = captionAt(beat, .6, starts);
ok(c2.text === 'PLEASE,' && c2.text.split(' ').length === 1 && c2.key, 'one UPPERCASE word at a time; "please" is a key word');
ok(captionAt(beat, 1.9, starts).index === 4, 'the last word stays to the end of the shot');
ok(!captionAt(beat, .4, starts).key && KEY_WORDS.includes('subscribe'), 'only key words take the speaker\'s colour');
eq(lineWords('Hi, Juno - wait!'), ['Hi,', 'Juno', 'wait!'], 'a dash is not a word');
eq(mouthOpen('XAXAAXXXOXOO'), '000110000011', 'the mouth holds open and shut for at least two frames');
eq(openFrames('XAXAAXXXOXOO').join(''), mouthOpen('XAXAAXXXOXOO'), 'the 3D and 2D mouths agree');
ok(SEPIA === .75, 'flashbacks are 75 percent sepia');
ok(edgeFlash(0, 5) === 1 && edgeFlash(.31, 5) === 0 && edgeFlash(3, .1) > 0, 'white flashes at a flashback\'s start and end');
const avatar = avatarCamera(1, .05), later = avatarCamera(1, 1);
ok(avatar.fov < later.fov, 'the avatar pops in a little when the speaker changes');

// 9. A classic voxel beat reads as a one-shot story beat (Pack C's explainer beats in the classic look).
const vb = voxelAsStory({ id: 'v', kind: 'voxel', start: 0, end: 3, camera: 'push', voxel: { world: 'ocean', time: 'night', shot: 'wide', seed: 2, look: 'classic',
  cast: [{ character: 'aaaaaaaaaaaa', x: .5, action: 'jump', expression: 'surprised', speaking: true, facing: 'camera' }], props: [], labels: [] } });
ok(vb.story.place === 'beach' && vb.story.time === 'dusk' && vb.story.cast[0].pose === 'cheer' && vb.story.cast[0].mood === 'shocked', 'world, time, action and expression map to the classic set');

// 10. Distance rules: no other game's name, its creatures or the named channel's characters anywhere in the classic code.
const source = ['blocks.js', 'classic.js', 'classic3d.js', 'story.js'].map(f => readFileSync(new URL(`../static/motion/${f}`, import.meta.url), 'utf8')).join('\n');
ok(!/minecraft|mojang|creeper|enderman|herobrine|\bsteve\b|maizen|\bmikey\b|\btnt\b/i.test(source), 'the classic code names no other game, mob, skin or channel');

console.log(`classic model: ${checks} checks passed`);
