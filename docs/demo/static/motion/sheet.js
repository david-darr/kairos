// A character's reference sheet (Video Styles unit 3): every view, expression and mouth shape, the palette with its
// hex values, the outline weight and the proportions, drawn by the same rig the videos use. The layout comes from
// the server (core/character_sheet.py LAYOUT) so the sheet-match checks know where each cell is.
import { drawCharacter, geometry, poseAt } from './rig.js';

const LABEL = '#3a3340', DIM = '#7a7280', FONT = 'Arial, Helvetica, sans-serif';
const NAMES = { three_quarter: 'three-quarter', MBP: 'M B P', FV: 'F V' };
const still = poseAt('idle', 0);

function label(g, text, x, y, size = 26, color = LABEL, align = 'center', weight = 600) {
  g.font = `${weight} ${size}px ${FONT}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic'; g.fillText(text, x, y);
}

export function drawSheet(g, data) {
  const { spec, layout, version, status } = data, L = layout;
  g.fillStyle = L.background; g.fillRect(0, 0, L.w, L.h);
  label(g, spec.name, 60, 84, 64, LABEL, 'left', 700);
  label(g, `Character sheet, version ${version}${status ? ` (${status})` : ''}. Family: ${spec.family}. Accessory: ${spec.accessory}. Outline ${spec.outline}/1000 of height.`,
    60, 124, 26, DIM, 'left', 500);
  g.strokeStyle = '#ddd5ca'; g.lineWidth = 2;
  for (const cell of [...L.views, ...L.expressions, ...L.mouths]) g.strokeRect(cell.x + 8, cell.y + 8, cell.w - 16, cell.h - 16);
  for (const cell of L.views) {
    label(g, NAMES[cell.view] || cell.view, cell.x + cell.w / 2, cell.y + 46);
    drawCharacter(g, spec, cell.x + cell.w / 2, cell.feet, cell.height, { view: cell.view, expression: 'neutral', pose: still });
  }
  for (const cell of L.expressions) {
    label(g, cell.expression, cell.x + cell.w / 2, cell.y + 46);
    drawCharacter(g, spec, cell.x + cell.w / 2, cell.feet, cell.height, { view: 'front', expression: cell.expression, pose: still });
  }
  for (const cell of L.mouths) {
    label(g, NAMES[cell.mouth] || cell.mouth, cell.x + cell.w / 2, cell.y + 44);
    // A close-up of the face: the whole figure, large, clipped to its cell around the head.
    const geo = geometry(spec, cell.height, 'front');
    g.save(); g.beginPath(); g.rect(cell.x + 10, cell.y + 56, cell.w - 20, cell.h - 66); g.clip();
    const feet = cell.y + 56 + (cell.h - 66) / 2 - geo.headCY;
    drawCharacter(g, spec, cell.x + cell.w / 2, feet, cell.height, { view: 'front', expression: 'neutral', mouth: cell.mouth, pose: still });
    g.restore();
  }
  const P = L.palette;
  label(g, 'Palette', P.x, P.y + 30, 26, LABEL, 'left');
  P.keys.forEach((key, i) => {
    const col = i % 3, row = Math.floor(i / 3), x = P.x + col * P.cw, y = P.y + 48 + row * P.ch;
    g.fillStyle = spec.palette[key]; g.beginPath(); g.roundRect(x, y, 64, P.ch - 18, 10); g.fill();
    g.strokeStyle = spec.palette.outline; g.lineWidth = 2; g.stroke();
    label(g, key.replace('_', ' '), x + 78, y + 26, 22, LABEL, 'left');
    label(g, spec.palette[key], x + 78, y + 52, 20, DIM, 'left', 500);
  });
  const p = spec.proportions;
  label(g, `Head ${p.head}, body width ${p.body_width}, limbs ${p.limb_length}, limb width ${p.limb_width}, eyes ${p.eye_size} (of height).`,
    P.x, L.h - 22, 20, DIM, 'left', 500);
}

const node = typeof document !== 'undefined' && document.getElementById('kd-sheet-data');
if (node) {
  try {
    const data = JSON.parse(node.textContent), canvas = document.getElementById('kd-sheet');
    canvas.width = data.layout.w; canvas.height = data.layout.h;
    drawSheet(canvas.getContext('2d'), data);
    document.body.dataset.ready = '1';
  } catch (error) { document.body.dataset.error = String(error && error.message || error); }
}
