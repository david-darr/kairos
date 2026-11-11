// A 3D character's reference sheet (Pack B, Video Styles unit 5; Pack C's blocky characters, form voxel, too): the four views, five expressions and six mouth shapes
// rendered with the same model and renderer the videos use (stage.js, stage3d.js), plus a flat colour key (each part
// in its spec colour, unlit) that the sheet checks measure, the palette with its hex values and the proportions. The
// layout comes from the server (core/character_sheet.py LAYOUT_3D) so the checks know where each cell is.
import { stageModel, normalizeStage, memberPose, characterModel, HEIGHT } from './stage.js';
import { StageRenderer } from './stage3d.js';
import { voxelModel, normalizeVoxel, voxelMemberPose, voxelPlan } from './voxel.js';
import { VoxelRenderer } from './voxel3d.js';

const LABEL = '#3a3340', DIM = '#7a7280', FONT = 'Arial, Helvetica, sans-serif';
const NAMES = { three_quarter: 'three-quarter', MBP: 'M B P', FV: 'F V', key: 'colour key (flat, unlit)' };
const YAW = { front: 0, three_quarter: -.62, side: -Math.PI / 2, back: Math.PI };
const CODE = { rest: 'X', A: 'A', E: 'E', O: 'O', MBP: 'M', FV: 'F' };
const SS = 2;

function label(g, text, x, y, size = 26, color = LABEL, align = 'center', weight = 600) {
  g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(text, x, y);
}

// Pack C (form voxel): the blocky figure from voxel.js, drawn by voxel3d.js with its pixel face, without a world.
function voxelFigure(spec) {
  const beat = { id: 'sheet', start: 0, end: 10, voxel: normalizeVoxel({ world: 'meadow', shot: 'medium', cast: [{ character: 'sheetfigure0', x: 0, speaking: true }] }) };
  const model = voxelModel(beat, { sheetfigure0: { spec, version: 1 } });
  model.boxes = []; model.puffs = []; model.glows = [];
  const plan = voxelPlan(spec);
  return { beat, model, plan: { ...plan, zh: plan.zh } };
}
function voxelPoseFor(model, { expression = 'neutral', mouth = 'rest' }) {
  const actor = model.actors[0], member = { ...actor.member, expression, action: 'idle', speaking: true, react: null };
  const pose = voxelMemberPose(member, actor.plan, .1, CODE[mouth].repeat(40), 1, actor.place);
  const groups = {};
  for (const [name, value] of Object.entries(pose.groups)) groups[`c0_${name}`] = value;
  for (const name of ['root', 'lean', 'head']) groups[`c0_${name}`] = [0, 0, 0, 0, 0, 0, 1, 1, 1];   // the rest pose, no breathing or sway
  return { groups, faces: { c0: { ...pose.face, blink: 0 } } };
}

// The one figure at the origin, as a stage model without a set (the sheet's background is flat).
function figure(spec) {
  const beat = { id: 'sheet', start: 0, end: 10, stage: normalizeStage({ set: 'lavender', shot: 'medium', cast: [{ character: 'sheetfigure0', x: 0, speaking: true }] }) };
  const model = stageModel(beat, { sheetfigure0: { spec, version: 1 } });
  model.prims = model.prims.filter(p => p.name !== 'cyclorama');
  return { beat, model, plan: characterModel(spec).plan };
}

function poseFor(model, beat, { expression = 'neutral', mouth = 'rest' }) {
  const member = { ...beat.stage.cast[0], expression, action: 'idle', speaking: true, react: null };
  const codes = CODE[mouth].repeat(40);
  const actor = model.actors[0];
  const pose = memberPose(member, { plan: actor.plan }, .25, codes, 1, actor.place);
  const groups = {};
  for (const [name, value] of Object.entries(pose)) if (name !== 'cheeks') groups[`c0_${name}`] = value;
  for (const side of ['l', 'r']) groups[`c0_cheek_${side}`] = [0, 0, 0, 0, 0, 0, pose.cheeks, 1, pose.cheeks];
  groups.c0_root = [0, 0, 0, 0, 0, 0, 1, 1, 1];     // the sheet shows the rest pose, no breathing or sway
  groups.c0_head = [0, 0, 0, 0, 0, 0, 1, 1, 1];
  return { groups };
}

export async function drawSheet(g, data) {
  const { spec, layout, version, status } = data, L = layout;
  g.fillStyle = L.background; g.fillRect(0, 0, L.w, L.h);
  label(g, spec.name, 60, 84, 64, LABEL, 'left', 700);
  const blocky = spec.form === 'voxel';
  label(g, blocky ? `Blocky character sheet, version ${version}${status ? ` (${status})` : ''}. Family: ${spec.family}. Accessory: ${spec.accessory}. Built from rounded boxes, pixel face drawn in code.`
    : `3D character sheet, version ${version}${status ? ` (${status})` : ''}. Family: ${spec.family}. Accessory: ${spec.accessory}. Glossy, no outline in 3D.`,
    60, 124, 26, DIM, 'left', 500);
  const { beat, model, plan } = blocky ? voxelFigure(spec) : figure(spec);
  const big = Math.max(...[...L.views, L.key, ...L.expressions, ...L.mouths].flatMap(c => [c.w, c.h])) * SS;
  const stage = blocky ? new VoxelRenderer(big, big, { ss: 1, look: false }) : new StageRenderer(big, big, { ss: 1, look: false });
  const posed = options => blocky ? voxelPoseFor(model, options) : poseFor(model, beat, options);
  const metres = cell => HEIGHT / cell.height;           // the figure's 1.5 m is `height` pixels tall in its cell
  const draw = (cell, { yaw = 0, flat = false, expression, mouth, head = false }) => {
    const m = metres(cell), viewHeight = cell.h * m;
    // A blocky head is tall: its close-up sits a little lower in the cell so the cell's label stays clear of its top.
    const cz = head ? plan.zh + (blocky ? .1 : -.02) : (cell.feet - (cell.y + cell.h / 2)) * m;
    const image = stage.renderCell(model, posed({ expression, mouth }),
      { width: cell.w * SS, height: cell.h * SS, center: [0, 0, cz], viewHeight, yaw, flat });
    g.drawImage(image, cell.x, cell.y, cell.w, cell.h);
  };
  for (const cell of L.views) draw(cell, { yaw: YAW[cell.view] });
  draw(L.key, { flat: true });
  for (const cell of L.expressions) draw(cell, { expression: cell.expression });
  for (const cell of L.mouths) draw(cell, { mouth: cell.mouth, head: true });
  g.strokeStyle = '#ddd5ca'; g.lineWidth = 2;
  for (const cell of [...L.views, L.key, ...L.expressions, ...L.mouths]) g.strokeRect(cell.x + 8, cell.y + 8, cell.w - 16, cell.h - 16);
  for (const cell of L.views) label(g, NAMES[cell.view] || cell.view, cell.x + cell.w / 2, cell.y + 46);
  label(g, NAMES.key, L.key.x + L.key.w / 2, L.key.y + 46);
  for (const cell of L.expressions) label(g, cell.expression, cell.x + cell.w / 2, cell.y + 46);
  for (const cell of L.mouths) label(g, NAMES[cell.mouth] || cell.mouth, cell.x + cell.w / 2, cell.y + 44);
  const P = L.palette;
  label(g, 'Palette', P.x, P.y + 30, 26, LABEL, 'left');
  P.keys.forEach((key, i) => {
    const col = i % 3, row = Math.floor(i / 3), x = P.x + col * P.cw, y = P.y + 48 + row * P.ch;
    g.fillStyle = spec.palette[key]; g.beginPath(); g.roundRect(x, y, 64, P.ch - 18, 10); g.fill();
    g.strokeStyle = '#ddd5ca'; g.lineWidth = 2; g.stroke();
    label(g, key.replace('_', ' '), x + 78, y + 26, 22, LABEL, 'left');
    label(g, spec.palette[key], x + 78, y + 52, 20, DIM, 'left', 500);
  });
  const p = spec.proportions;
  label(g, `Head ${p.head}, body width ${p.body_width}, limbs ${p.limb_length}, limb width ${p.limb_width}, eyes ${p.eye_size} (of height).`,
    P.x, L.h - 22, 20, DIM, 'left', 500);
  return stage.info;
}

const node = typeof document !== 'undefined' && document.getElementById('kd-sheet-data');
if (node) {
  window.kdReady = (async () => {
    try {
      const data = JSON.parse(node.textContent), canvas = document.getElementById('kd-sheet');
      canvas.width = data.layout.w; canvas.height = data.layout.h;
      window.kdSheetInfo = await drawSheet(canvas.getContext('2d'), data);
      document.body.dataset.ready = '1';
    } catch (error) { document.body.dataset.error = String(error && error.message || error); }
  })();
}
