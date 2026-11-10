// Pack A scenes (Video Styles build spec, unit 3): flat layered settings with parallax (sky, far, mid, near), simple
// icon props and the cast, drawn by the rig. DOM-free; deterministic in (beat, t). The `scene` beat's data is
// checked by core/video_store.py; this file only draws it.
import { clamp, hash, inOut, seededRandom } from './kit.js';
import { blinkAt, drawCharacter, figureBox, mouthAt, poseAt, viewAt } from './rig.js';
import { cameraAt } from './layout.js';

export const SETTINGS = ['meadow', 'city', 'space', 'room', 'ocean', 'lab'];
export const SHOTS = { wide: .30, medium: .46, close: .74 };
export const PALETTES = {
  dawn: { sky: ['#ffd9b8', '#fff1df'], far: '#f2b8a2', mid: '#d98f8a', near: '#7d5a7a', ground: '#5b4466', prop: '#ffffff', ink: '#3a2a40', glow: '#fff6e8' },
  mint: { sky: ['#bfe8e0', '#eefaf6'], far: '#9fd6c6', mid: '#6fb8a6', near: '#3f8a7e', ground: '#2f6a63', prop: '#fff7e6', ink: '#1f3b3a', glow: '#ffffff' },
  dusk: { sky: ['#5b4b8a', '#f2a490'], far: '#8a6aa8', mid: '#5e4a85', near: '#3a2f5e', ground: '#2a2347', prop: '#ffe3a8', ink: '#1c1733', glow: '#ffe9c7' },
  night: { sky: ['#14213d', '#2d3f6b'], far: '#2a3a63', mid: '#1f2d50', near: '#152039', ground: '#0f172b', prop: '#ffd166', ink: '#0a0f1e', glow: '#fff3c4' },
  paper: { sky: ['#f4efe6', '#fbf8f2'], far: '#e2d6c3', mid: '#c9b79c', near: '#a48b6e', ground: '#7d6750', prop: '#ffffff', ink: '#3b3127', glow: '#ffffff' },
};
const DEPTH = { sky: 0, far: .22, mid: .5, near: .8, cast: 1 };
// A style pack's lighting (core/style_pack_store.py): how strong the soft light gradients on the flat layers are.
export const LIGHTING = { flat: 0, soft: 1, glow: 1.8 };
const TAU = Math.PI * 2;

// A captioned scene stands its figures far enough above the caption band that feet (and a push-in camera) stay clear.
export function groundLine(h, band, captioned) { return captioned && band ? band.y - h * .03 : h * .88; }

// The camera per depth: a far layer moves less than the cast. `p` is the beat's progress 0..1.
export function layerTransform(camera, p, seed, depth, w, h, anchorY) {
  const cam = cameraAt(camera, p, seed), s = 1 + (cam.scale - 1) * depth;
  return { s, dx: cam.dx * w * depth, dy: cam.dy * h * depth, ax: w / 2, ay: anchorY };
}
const apply = (tf, x, y) => [tf.ax + (x - tf.ax) * tf.s + tf.dx, tf.ay + (y - tf.ay) * tf.s + tf.dy];

// Where each cast member stands and what it shows at `t` seconds into the beat.
export function placeCast(beat, characters, w, h, ground, t, p) {
  const scene = beat.scene || {}, short = Math.min(w, h), H0 = short * (SHOTS[scene.shot] || SHOTS.medium);
  const duration = Math.max(.01, beat.end - beat.start);
  return (scene.cast || []).filter(m => characters?.[m.character]?.spec).map((m, i) => {
    const spec = characters[m.character].spec, facing = m.facing === 'left' ? -1 : 1;
    let fx = .08 + .84 * clamp(m.x ?? .5);
    if (m.action === 'walk') fx += facing * (.2 * inOut(p) - .1);
    const speaking = !!m.speaking && !!beat.mouth;
    const mouth = speaking ? mouthAt(beat.mouth, t) : 'rest';
    const view = viewAt(m.view || 'front', m.turn, t, duration * .45);
    const pose = poseAt(m.action || 'idle', t + i * .37, { speaking, open: !['rest', 'MBP'].includes(mouth) });
    const H = H0, feet = scene.shot === 'close' ? ground + H * .42 : ground;
    return { member: m, spec, version: characters[m.character].version, x: fx * w, y: feet, H,
      state: { view, expression: m.expression || 'neutral', mouth, blink: blinkAt(`${m.character}:${beat.id}`, t), pose, facing: m.facing } };
  });
}

function hills(g, y, amp, period, seed, color, w, h) {
  g.beginPath(); g.moveTo(-w, h * 2);
  for (let x = -w; x <= w * 2; x += 24) g.lineTo(x, y - amp * (.6 * Math.sin(x / period + seed) + .4 * Math.sin(x / (period * .47) + seed * 2.1)));
  g.lineTo(w * 2, h * 2); g.closePath(); g.fillStyle = color; g.fill();
}
function soft(g, color, x, y, w, h, alpha = .14, light = 1) {
  // Soft gradient light on a flat layer, within the palette (glow over the layer colour). A flat pack draws none.
  if (!(light > 0)) return;
  alpha = Math.min(.6, alpha * light);
  const grad = g.createLinearGradient(x, y, x, y + h); grad.addColorStop(0, color); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.save(); g.globalAlpha *= alpha; g.fillStyle = grad; g.fillRect(x, y, w, h); g.restore();
}

function layer(g, name, setting, pal, w, h, ground, seed, seconds) {
  const random = seededRandom(`${seed}:${name}`);
  if (name === 'sky') {
    const grad = g.createLinearGradient(0, 0, 0, ground); grad.addColorStop(0, pal.sky[0]); grad.addColorStop(1, pal.sky[1]);
    g.fillStyle = grad; g.fillRect(-w, -h, w * 3, h * 3);
    if (setting === 'space' || setting === 'room' || setting === 'lab') return;
    g.save(); g.globalAlpha = .5; g.fillStyle = pal.glow; g.beginPath(); g.arc(w * .78, h * .2, Math.min(w, h) * .12, 0, TAU); g.fill(); g.restore();
    return;
  }
  if (setting === 'meadow' || setting === 'ocean') {
    if (name === 'far') hills(g, ground - h * .2, h * .05, 260, random() * 9, pal.far, w, h);
    if (name === 'mid' && setting === 'meadow') hills(g, ground - h * .07, h * .045, 170, random() * 9, pal.mid, w, h);
    if (name === 'mid' && setting === 'ocean') {
      for (let i = 0; i < 4; i++) {
        const y = ground - h * (.13 - i * .03);
        g.beginPath(); g.moveTo(-w, h * 2);
        for (let x = -w; x <= w * 2; x += 20) g.lineTo(x, y + Math.sin(x / 90 + seconds * (1.2 + i * .3) + i) * h * .008);
        g.lineTo(w * 2, h * 2); g.closePath(); g.fillStyle = i % 2 ? pal.mid : pal.far; g.fill();
        // Foam on each crest, so water reads as water in any palette.
        g.save(); g.globalAlpha = .55; g.strokeStyle = pal.glow; g.lineWidth = Math.max(2, h * .003); g.setLineDash([w * .03, w * .05]); g.beginPath();
        for (let x = -w; x <= w * 2; x += 20) { const yy = y + Math.sin(x / 90 + seconds * (1.2 + i * .3) + i) * h * .008; if (x === -w) g.moveTo(x, yy); else g.lineTo(x, yy); }
        g.stroke(); g.restore();
      }
    }
    if (name === 'near') { g.fillStyle = pal.near; g.fillRect(-w, ground, w * 3, h * 2); soft(g, pal.glow, -w, ground, w * 3, h * .05, .14, pal.light); }
  } else if (setting === 'city') {
    if (name === 'far') for (let x = -w * .2; x < w * 1.3; x += w * .06) { const bh = h * (.18 + random() * .22); g.fillStyle = pal.far; g.fillRect(x, ground - h * .08 - bh, w * .055, bh + h); }
    if (name === 'mid') {
      for (let x = -w * .2; x < w * 1.3; x += w * .11) {
        const bh = h * (.12 + random() * .2), bw = w * .09; g.fillStyle = pal.mid; g.fillRect(x, ground - bh, bw, bh + h);
        g.fillStyle = pal.glow; g.globalAlpha = .45;
        for (let wy = ground - bh + h * .025; wy < ground - h * .03; wy += h * .045) for (let wx = x + bw * .15; wx < x + bw * .8; wx += bw * .3) if (random() > .35) g.fillRect(wx, wy, bw * .14, h * .02);
        g.globalAlpha = 1;
      }
    }
    if (name === 'near') { g.fillStyle = pal.near; g.fillRect(-w, ground, w * 3, h * 2); g.fillStyle = pal.ground; g.fillRect(-w, ground + h * .03, w * 3, h * .01); }
  } else if (setting === 'space') {
    if (name === 'far') {
      g.fillStyle = pal.glow;
      for (let i = 0; i < 140; i++) { g.globalAlpha = .3 + random() * .6; g.beginPath(); g.arc(random() * w * 1.4 - w * .2, random() * ground, 1 + random() * 2.2, 0, TAU); g.fill(); }
      // A far planet, its soft light kept inside its own disc (a square of light showed around it before).
      const r = Math.min(w, h) * .1, px = w * .2, py = h * .24;
      g.globalAlpha = 1; g.fillStyle = pal.far; g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      g.save(); g.beginPath(); g.arc(px, py, r, 0, TAU); g.clip(); soft(g, pal.glow, px - r, py - r, r * 2, r * 2, .25, pal.light); g.restore();
    }
    if (name === 'mid') hills(g, ground - h * .05, h * .02, 300, random() * 9, pal.mid, w, h);
    if (name === 'near') {
      g.fillStyle = pal.near; g.fillRect(-w, ground, w * 3, h * 2);
      g.fillStyle = pal.ground; for (let i = 0; i < 7; i++) { g.beginPath(); g.ellipse(random() * w, ground + h * (.02 + random() * .06), w * (.02 + random() * .03), h * .008, 0, 0, TAU); g.fill(); }
    }
  } else if (setting === 'room' || setting === 'lab') {
    if (name === 'far') {
      if (setting === 'room') {
        const wx = w * .62, wy = h * .14, ww = w * .22, wh = h * .3; g.fillStyle = pal.glow; g.fillRect(wx, wy, ww, wh);
        g.strokeStyle = pal.far; g.lineWidth = Math.max(6, w * .006); g.strokeRect(wx, wy, ww, wh); g.beginPath(); g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh); g.moveTo(wx, wy + wh / 2); g.lineTo(wx + ww, wy + wh / 2); g.stroke();
      } else {
        g.strokeStyle = pal.far; g.lineWidth = 2; g.globalAlpha = .6; g.beginPath();
        for (let x = 0; x < w * 1.2; x += w * .05) { g.moveTo(x, 0); g.lineTo(x, ground); }
        for (let y = 0; y < ground; y += w * .05) { g.moveTo(-w * .1, y); g.lineTo(w * 1.2, y); }
        g.stroke(); g.globalAlpha = 1;
      }
    }
    if (name === 'mid') {
      const sy = setting === 'room' ? h * .3 : ground - h * .16;
      g.fillStyle = pal.mid; g.fillRect(w * .06, sy, w * .32, h * .02);
      for (let i = 0; i < 6; i++) {
        const bx = w * (.08 + i * .045), bh = h * (.06 + random() * .05);
        g.fillStyle = i % 2 ? pal.far : pal.near;
        if (setting === 'room') g.fillRect(bx, sy - bh, w * .03, bh);
        else { g.beginPath(); g.moveTo(bx, sy); g.lineTo(bx + w * .015, sy - bh); g.lineTo(bx + w * .03, sy); g.closePath(); g.fill(); }
      }
    }
    if (name === 'near') { g.fillStyle = pal.near; g.fillRect(-w, ground, w * 3, h * 2); soft(g, pal.glow, -w, ground, w * 3, h * .04, .1, pal.light); }
  }
}

// Simple flat icons, drawn in the palette's prop colour with its ink outline. Each fits a unit box around (0, 0).
export function drawIcon(g, icon, size, pal, t = 0) {
  const s = size / 2, o = Math.max(2, size * .045);
  g.save(); g.lineWidth = o; g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = pal.ink; g.fillStyle = pal.prop;
  const fs = () => { g.fill(); g.stroke(); };
  g.beginPath();
  switch (icon) {
    case 'sun': for (let i = 0; i < 8; i++) { const a = i * TAU / 8 + t * .3; g.moveTo(Math.cos(a) * s * .62, Math.sin(a) * s * .62); g.lineTo(Math.cos(a) * s * .95, Math.sin(a) * s * .95); } g.stroke(); g.beginPath(); g.arc(0, 0, s * .45, 0, TAU); fs(); break;
    case 'moon': g.arc(0, 0, s * .8, .6, TAU - .6 + .001); g.arc(s * .35, -s * .1, s * .6, TAU - 1.1, 1.3, true); g.closePath(); fs(); break;
    case 'star': for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? s * .42 : s * .95; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); fs(); break;
    case 'cloud': g.arc(-s * .4, s * .1, s * .38, Math.PI * .5, Math.PI * 1.5); g.arc(0, -s * .15, s * .48, Math.PI, 0); g.arc(s * .45, s * .1, s * .36, Math.PI * 1.5, Math.PI * .5); g.closePath(); fs(); break;
    case 'lightbulb': g.arc(0, -s * .2, s * .55, Math.PI * .8, Math.PI * .2); g.lineTo(s * .22, s * .55); g.lineTo(-s * .22, s * .55); g.closePath(); fs(); g.beginPath(); g.rect(-s * .24, s * .55, s * .48, s * .3); g.fillStyle = pal.ink; g.fill(); break;
    case 'heart': g.moveTo(0, s * .8); g.bezierCurveTo(-s * 1.1, 0, -s * .55, -s * .9, 0, -s * .35); g.bezierCurveTo(s * .55, -s * .9, s * 1.1, 0, 0, s * .8); fs(); break;
    case 'book': g.rect(-s * .8, -s * .55, s * .78, s * 1.1); g.rect(s * .02, -s * .55, s * .78, s * 1.1); fs(); break;
    case 'planet': g.arc(0, 0, s * .5, 0, TAU); fs(); g.beginPath(); g.ellipse(0, 0, s * .95, s * .25, -.35, 0, TAU); g.stroke(); break;
    case 'drop': g.moveTo(0, -s * .9); g.bezierCurveTo(s * .2, -s * .5, s * .65, -s * .05, s * .62, s * .3); g.arc(0, s * .3, s * .62, 0, Math.PI); g.bezierCurveTo(-s * .65, -s * .05, -s * .2, -s * .5, 0, -s * .9); fs(); break;
    case 'leaf': g.moveTo(-s * .8, s * .8); g.quadraticCurveTo(-s * .8, -s * .8, s * .8, -s * .8); g.quadraticCurveTo(s * .8, s * .8, -s * .8, s * .8); fs(); g.beginPath(); g.moveTo(-s * .8, s * .8); g.lineTo(s * .4, -s * .4); g.stroke(); break;
    case 'gear': for (let i = 0; i < 16; i++) { const a = i * TAU / 16 + t * .5, r = i % 2 ? s * .62 : s * .88; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); fs(); g.beginPath(); g.arc(0, 0, s * .25, 0, TAU); g.fillStyle = pal.ink; g.fill(); break;
    case 'arrow': g.moveTo(-s * .85, -s * .2); g.lineTo(s * .2, -s * .2); g.lineTo(s * .2, -s * .55); g.lineTo(s * .9, 0); g.lineTo(s * .2, s * .55); g.lineTo(s * .2, s * .2); g.lineTo(-s * .85, s * .2); g.closePath(); fs(); break;
    case 'question': g.arc(0, 0, s * .9, 0, TAU); fs(); g.beginPath(); g.arc(0, -s * .25, s * .3, Math.PI * 1.1, Math.PI * .45); g.lineTo(0, s * .25); g.lineWidth = o * 2; g.stroke(); g.beginPath(); g.arc(0, s * .55, o * 1.2, 0, TAU); g.fillStyle = pal.ink; g.fill(); break;
    case 'coin': g.ellipse(0, 0, s * .8, s * .8, 0, 0, TAU); fs(); g.beginPath(); g.ellipse(0, 0, s * .5, s * .5, 0, 0, TAU); g.stroke(); break;
    case 'clock': g.arc(0, 0, s * .85, 0, TAU); fs(); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -s * .55); g.moveTo(0, 0); g.lineTo(Math.cos(t) * s * .4, Math.sin(t) * s * .4); g.stroke(); break;
    case 'rocket': g.moveTo(0, -s * .95); g.quadraticCurveTo(s * .45, -s * .4, s * .3, s * .5); g.lineTo(-s * .3, s * .5); g.quadraticCurveTo(-s * .45, -s * .4, 0, -s * .95); fs(); g.beginPath(); g.arc(0, -s * .2, s * .14, 0, TAU); g.fillStyle = pal.ink; g.fill(); break;
    case 'tree': g.rect(-s * .1, s * .2, s * .2, s * .7); g.fillStyle = pal.ink; g.fill(); g.beginPath(); g.arc(0, -s * .2, s * .6, 0, TAU); g.fillStyle = pal.prop; fs(); break;
    case 'house': g.moveTo(-s * .7, -s * .05); g.lineTo(0, -s * .8); g.lineTo(s * .7, -s * .05); g.lineTo(s * .55, -s * .05); g.lineTo(s * .55, s * .8); g.lineTo(-s * .55, s * .8); g.lineTo(-s * .55, -s * .05); g.closePath(); fs(); g.beginPath(); g.rect(-s * .15, s * .3, s * .3, s * .5); g.stroke(); break;
    case 'magnifier': g.arc(-s * .15, -s * .15, s * .55, 0, TAU); fs(); g.beginPath(); g.moveTo(s * .25, s * .25); g.lineTo(s * .85, s * .85); g.lineWidth = o * 2.4; g.stroke(); break;
    case 'atom': for (let i = 0; i < 3; i++) { g.beginPath(); g.ellipse(0, 0, s * .9, s * .32, i * Math.PI / 3 + t * .4, 0, TAU); g.stroke(); } g.beginPath(); g.arc(0, 0, s * .16, 0, TAU); g.fillStyle = pal.ink; g.fill(); break;
    default: g.arc(0, 0, s * .6, 0, TAU); fs();
  }
  g.restore();
}

// The scene's colours: a style pack's own palette (checked hex values) or a named one, with the pack's lighting.
export function paletteOf(project) {
  const pack = project.pack || {};
  return { ...(pack.palette || PALETTES[project.palette] || PALETTES.dawn), light: LIGHTING[pack.lighting] ?? 1 };
}

// A close shot frames the figure from the chest up: the near ground layer stands in front of it, so its lower body
// never reaches the caption band under the ground line. Returns the y the cast is cut at, or null for other shots.
export function castClip(beat, p, w, h, ground) {
  if ((beat.scene || {}).shot !== 'close') return null;
  const tf = layerTransform(beat.camera, p, hash(beat.id) % 100, DEPTH.near, w, h, ground * .85);
  return tf.ay + (ground - tf.ay) * tf.s + tf.dy;
}
const clipped = (box, clip) => clip == null ? box : { ...box, h: Math.max(0, Math.min(box.h, clip - box.y)), clip };

// Draws the whole scene beat into `g` (w x h). Returns what layout reports: characters and props in frame pixels.
export function drawScene(g, beat, project, w, h, ground, t, p) {
  const pal = paletteOf(project), scene = beat.scene || {}, setting = SETTINGS.includes(scene.setting) ? scene.setting : 'meadow';
  const seed = hash(beat.id) % 100, boxes = [];
  for (const name of ['sky', 'far', 'mid', 'near']) {
    const tf = layerTransform(beat.camera, p, seed, DEPTH[name], w, h, ground * .85);
    g.save(); g.translate(tf.dx + tf.ax * (1 - tf.s), tf.dy + tf.ay * (1 - tf.s)); g.scale(tf.s, tf.s);
    layer(g, name, setting, pal, w, h, ground, `${beat.id}:${setting}`, t);
    g.restore();
  }
  const castTf = layerTransform(beat.camera, p, seed, DEPTH.cast, w, h, ground * .85), short = Math.min(w, h);
  for (const prop of (scene.props || [])) {
    const bob = prop.float ? Math.sin(TAU * (t / 2.4 + prop.x)) * short * .012 : 0;
    const [x, y] = apply(castTf, prop.x * w, prop.y * h + bob), size = prop.size * short * castTf.s;
    g.save(); g.translate(x, y); drawIcon(g, prop.icon, size, pal, t); g.restore();
    boxes.push({ kind: 'prop', beat: beat.id, icon: prop.icon, x: x - size / 2, y: y - size / 2, w: size, h: size });
  }
  // Soft contact shadows, then the cast, back to front by x so overlaps read left to right.
  const cast = placeCast(beat, project.characters, w, h, ground, t, p), clip = castClip(beat, p, w, h, ground);
  g.save();
  if (clip != null) { g.beginPath(); g.rect(-w, -h, w * 3, clip + h); g.clip(); }
  for (const c of cast) {
    const [x, y] = apply(castTf, c.x, c.y), H = c.H * castTf.s;
    g.save(); g.globalAlpha = .18; g.fillStyle = pal.ink; g.beginPath(); g.ellipse(x, y, H * .28, H * .04, 0, 0, TAU); g.fill(); g.restore();
    const box = drawCharacter(g, c.spec, x, y, H, c.state);
    boxes.push({ kind: 'character', beat: beat.id, character: c.member.character, version: c.version, shot: scene.shot || 'medium',
      view: c.state.view, expression: c.state.expression, mouth: c.state.mouth, action: c.member.action || 'idle', speaking: !!c.member.speaking,
      ...clipped(box, clip), short });
  }
  g.restore();
  return boxes;
}

// The boxes drawScene would report, without drawing (layout()).
export function sceneBoxes(beat, project, w, h, ground, t, p) {
  const scene = beat.scene || {}, seed = hash(beat.id) % 100, short = Math.min(w, h);
  const castTf = layerTransform(beat.camera, p, seed, DEPTH.cast, w, h, ground * .85), boxes = [];
  for (const prop of (scene.props || [])) {
    const bob = prop.float ? Math.sin(TAU * (t / 2.4 + prop.x)) * short * .012 : 0;
    const [x, y] = apply(castTf, prop.x * w, prop.y * h + bob), size = prop.size * short * castTf.s;
    boxes.push({ kind: 'prop', beat: beat.id, icon: prop.icon, x: x - size / 2, y: y - size / 2, w: size, h: size });
  }
  const clip = castClip(beat, p, w, h, ground);
  for (const c of placeCast(beat, project.characters, w, h, ground, t, p)) {
    const [x, y] = apply(castTf, c.x, c.y), H = c.H * castTf.s;
    boxes.push({ kind: 'character', beat: beat.id, character: c.member.character, version: c.version, shot: scene.shot || 'medium',
      view: c.state.view, expression: c.state.expression, mouth: c.state.mouth, action: c.member.action || 'idle', speaking: !!c.member.speaking,
      ...clipped(figureBox(c.spec, x, y, H, c.state), clip), short });
  }
  return boxes;
}
