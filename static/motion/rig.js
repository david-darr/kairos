// Pack A's 2D character rig (Video Styles build spec, unit 3). DOM-free: every function takes its canvas context.
//
// A character is a versioned spec (core/character_store.py): proportions, palette, outline weight and family
// (round, square or triangle body, dot eyes). drawCharacter() draws it from those numbers alone, so every frame and
// the reference sheet come from the same data. Parts: head, body, two-bone arms and legs. Views (front,
// three_quarter, side, back) are drawn separately and swapped for head turns; expressions change eyes, brows and the
// resting mouth; the six mouth shapes (rest, A, E, O, MBP, FV) come from the narration's measured mouth string;
// blinks are seeded per character and beat; squash and stretch are scale curves on the whole figure from its feet.
import { clamp, hash, inOut, range } from './kit.js';

export const VIEWS = ['front', 'three_quarter', 'side', 'back'];
export const EXPRESSIONS = ['neutral', 'happy', 'surprised', 'worried', 'thinking'];
export const MOUTHS = ['rest', 'A', 'E', 'O', 'MBP', 'FV'];
export const ACTIONS = ['idle', 'wave', 'point', 'walk', 'jump', 'shrug', 'think', 'nod'];
export const MOUTH_CODES = { X: 'rest', A: 'A', E: 'E', O: 'O', M: 'MBP', F: 'FV' };
const TAU = Math.PI * 2;

// The figure's geometry in pixels for a height H, feet at (0, 0), y up is negative.
export function geometry(spec, H, view = 'front') {
  const p = spec.proportions, L = p.limb_length * H, headH = p.head * H;
  const narrow = { front: 1, three_quarter: .9, side: .74, back: 1 }[view] ?? 1;
  const headW = headH * (spec.family === 'square' ? 1.04 : 1) * ({ front: 1, three_quarter: .95, side: .88, back: 1 }[view] ?? 1);
  const bodyTop = -H + headH * .82, bodyBottom = -L * .9;
  const bodyH = bodyBottom - bodyTop, bodyW = p.body_width * H * narrow;
  const shoulderY = bodyTop + bodyH * (spec.family === 'triangle' ? .34 : .24);
  // A triangle's sides close in toward its top, so its shoulders sit on the slope.
  const shoulderX = spec.family === 'triangle' ? bodyW * .5 * (.42 + .58 * (shoulderY - bodyTop) / bodyH) * .96 : bodyW * (spec.family === 'square' ? .47 : .43);
  return { H, L, headH, headW, headCX: 0, headCY: -H + headH / 2, bodyTop, bodyBottom, bodyH, bodyW, bodyCY: bodyTop + bodyH / 2,
    shoulderX, shoulderY, hipX: bodyW * (view === 'side' ? .06 : .2), hipY: bodyBottom - bodyH * .04, armBone: L * .48, legBone: L * .5,
    limbW: p.limb_width * H, outline: spec.outline / 1000 * H, eye: p.eye_size * H };
}

// Seeded blinks: every 2.2 to 4.2 seconds, 0.15 s long (close, hold, open). 0 open, 1 shut.
export function blinkAt(seed, t) {
  const random = n => (hash(`${seed}:${n}`) % 10000) / 10000;
  let at = .6 + random(0) * 1.5;
  for (let n = 1; at < t + 1 && n < 400; n++) {
    if (t >= at && t < at + .15) { const k = (t - at) / .15; return k < .33 ? k / .33 : k < .55 ? 1 : 1 - (k - .55) / .45; }
    at += 2.2 + random(n) * 2;
  }
  return 0;
}

// The mouth shape at t seconds into a beat, from the measured string (one code per 1/30 s); rest without one.
export function mouthAt(codes, t) {
  if (!codes) return 'rest';
  const i = Math.floor(t * 30 + 1e-6);
  return MOUTH_CODES[codes[i]] || 'rest';
}

// A head turn: the view steps through its neighbours (front, three-quarter, side) from `start` seconds, 0.09 s a step.
export function viewAt(from, to, t, start) {
  if (!to || to === from) return from;
  const order = ['front', 'three_quarter', 'side'];
  if (from === 'back' || to === 'back') return t >= start ? to : from;
  const a = order.indexOf(from), b = order.indexOf(to), steps = Math.abs(b - a);
  const k = Math.floor(Math.max(0, t - start) / .09);
  return order[a + Math.sign(b - a) * Math.min(steps, k)];
}

// The pose of an action at t seconds: two-bone angles (0 hangs down, positive swings outward or forward),
// squash and stretch (sx, sy from the feet), lift (fraction of H off the ground), lean, head tilt and nod.
export function poseAt(action, t, { speaking = false, open = false } = {}) {
  const breathe = Math.sin(TAU * t / 2.6);
  const pose = { arm: [[.16, .12], [.16, .12]], leg: [[0, 0], [0, 0]], sx: 1, sy: 1, lift: 0, lean: 0, tilt: 0, nod: 0, walk: 0 };
  pose.sy = 1 + .012 * breathe; pose.sx = 1 - .007 * breathe;
  pose.arm[0][0] += .03 * Math.sin(TAU * t / 3.1); pose.arm[1][0] += .03 * Math.sin(TAU * t / 3.1 + 1);
  const into = inOut(range(t, 0, .35));
  if (action === 'wave') {
    pose.arm[1] = [.16 + 2.34 * into, .12 + (.55 + .45 * Math.sin(TAU * t * 2.2)) * into];
  } else if (action === 'point') {
    pose.arm[1] = [.16 + 1.42 * into + .03 * Math.sin(TAU * t * 1.5), .12 - .1 * into];
    pose.lean = .03 * into;
  } else if (action === 'walk') {
    const s = Math.sin(TAU * t * 1.7);
    pose.leg = [[.38 * s, Math.max(0, -.5 * s)], [-.38 * s, Math.max(0, .5 * s)]];
    pose.arm = [[.16 - .35 * s, .2], [.16 + .35 * s, .2]];
    pose.lift = .018 * Math.abs(Math.cos(TAU * t * 1.7)); pose.walk = 1;
  } else if (action === 'jump') {
    // Anticipation squash, stretch on take-off, the arc, squash on landing, settle: one hop every 1.6 s.
    const c = (t % 1.6) / 1.6;
    if (c < .18) { const k = inOut(c / .18); pose.sy = 1 - .14 * k; pose.sx = 1 + .12 * k; }
    else if (c < .3) { const k = (c - .18) / .12; pose.sy = .86 + .3 * k; pose.sx = 1.12 - .22 * k; pose.lift = .05 * k; }
    else if (c < .72) { const k = (c - .3) / .42; pose.lift = .05 + .2 * Math.sin(Math.PI * k); pose.sy = 1.16 - .14 * k; pose.sx = .9 + .1 * k; pose.arm = [[.9, .3], [.9, .3]]; }
    else if (c < .84) { const k = (c - .72) / .12; pose.sy = 1 - .13 * Math.sin(Math.PI * k); pose.sx = 1 + .11 * Math.sin(Math.PI * k); }
  } else if (action === 'shrug') {
    const k = into * (.6 + .4 * Math.max(0, Math.sin(TAU * t / 1.8)));
    pose.arm = [[.16 + .75 * k, .12 - 1.7 * k], [.16 + .75 * k, .12 - 1.7 * k]];
    pose.tilt = .07 * k; pose.sy *= 1 + .02 * k;
  } else if (action === 'think') {
    pose.arm[1] = [.16 + .32 * into, .12 + 2.3 * into];
    pose.tilt = -.06 * into;
  } else if (action === 'nod') {
    pose.nod = .045 * Math.max(0, Math.sin(TAU * t * 1.4));
  }
  if (speaking && open) pose.nod += .01;
  return pose;
}

function path(g, family, cx, cy, w, h, role) {
  g.beginPath();
  if (family === 'square') g.roundRect(cx - w / 2, cy - h / 2, w, h, Math.min(w, h) * (role === 'head' ? .3 : .22));
  else if (family === 'triangle' && role === 'body') {
    // A soft triangle: apex up, base on the hips, every corner rounded.
    const top = [cx, cy - h / 2], left = [cx - w / 2, cy + h / 2], right = [cx + w / 2, cy + h / 2], r = Math.min(w, h) * .16;
    g.moveTo((left[0] + right[0]) / 2, left[1]);
    g.arcTo(right[0], right[1], top[0], top[1], r); g.arcTo(top[0], top[1], left[0], left[1], r * 1.4); g.arcTo(left[0], left[1], right[0], right[1], r);
    g.closePath();
  } else g.ellipse(cx, cy, w / 2, h / 2, 0, 0, TAU);
}

function fillShape(g, spec, geo, family, cx, cy, w, h, role, colors) {
  const grad = g.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
  grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
  path(g, family, cx, cy, w, h, role);
  g.fillStyle = grad; g.fill();
  g.lineWidth = geo.outline; g.strokeStyle = spec.palette.outline; g.lineJoin = 'round'; g.stroke();
}

// A two-bone limb from (x, y): the bones' angles from straight down, mirrored by `side` (-1 left, 1 right).
function limb(g, spec, geo, x, y, side, bone, [a1, a2], end = 'hand') {
  const ex = x + Math.sin(a1) * bone * side, ey = y + Math.cos(a1) * bone;
  const hx = ex + Math.sin(a1 + a2) * bone * side, hy = ey + Math.cos(a1 + a2) * bone;
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const [width, color] of [[geo.limbW + geo.outline * 2, spec.palette.outline], [geo.limbW, spec.palette.limb]]) {
    g.beginPath(); g.moveTo(x, y); g.lineTo(ex, ey); g.lineTo(hx, hy); g.lineWidth = width; g.strokeStyle = color; g.stroke();
  }
  g.beginPath();
  if (end === 'foot') g.ellipse(hx + side * geo.limbW * .45, hy, geo.limbW * 1.05, geo.limbW * .62, 0, 0, TAU);
  else g.arc(hx, hy, geo.limbW * .82, 0, TAU);
  g.fillStyle = spec.palette.limb; g.fill(); g.lineWidth = geo.outline; g.strokeStyle = spec.palette.outline; g.stroke();
  return { x: hx, y: hy };
}

function accessory(g, spec, geo, view, behind) {
  const c = spec.palette, top = geo.headCY - geo.headH / 2, o = geo.outline;
  g.lineWidth = o; g.strokeStyle = c.outline; g.lineJoin = 'round'; g.lineCap = 'round';
  if (spec.accessory === 'antenna' && behind) {
    g.beginPath(); g.moveTo(0, top + o); g.lineTo(geo.headW * .08, top - geo.headH * .26); g.lineWidth = o * 1.4; g.stroke();
    g.beginPath(); g.arc(geo.headW * .08, top - geo.headH * .3, geo.headH * .07, 0, TAU); g.fillStyle = c.accent; g.fill(); g.lineWidth = o; g.stroke();
  } else if (spec.accessory === 'leaf' && behind) {
    g.beginPath(); g.moveTo(0, top + o * .5); g.quadraticCurveTo(geo.headW * .22, top - geo.headH * .32, geo.headW * .34, top - geo.headH * .18);
    g.quadraticCurveTo(geo.headW * .16, top - geo.headH * .02, 0, top + o * .5); g.fillStyle = c.accent; g.fill(); g.stroke();
  } else if (spec.accessory === 'cap' && !behind) {
    g.beginPath(); g.ellipse(0, top + geo.headH * .2, geo.headW * .5, geo.headH * .28, 0, Math.PI, TAU); g.closePath();
    g.fillStyle = c.accent; g.fill(); g.stroke();
    if (view !== 'back') { g.beginPath(); g.ellipse(view === 'front' ? 0 : geo.headW * .3, top + geo.headH * .2, geo.headW * (view === 'front' ? .32 : .36), geo.headH * .06, 0, 0, TAU); g.fill(); g.stroke(); }
  } else if (spec.accessory === 'bow' && !behind) {
    const x = geo.headW * (view === 'side' ? -.18 : .3), y = top + geo.headH * .14, s = geo.headH * .13;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x - s * 1.4, y - s); g.lineTo(x - s * 1.4, y + s); g.closePath();
    g.moveTo(x, y); g.lineTo(x + s * 1.4, y - s); g.lineTo(x + s * 1.4, y + s); g.closePath();
    g.fillStyle = c.accent; g.fill(); g.stroke();
    g.beginPath(); g.arc(x, y, s * .45, 0, TAU); g.fill(); g.stroke();
  } else if (spec.accessory === 'scarf' && !behind) {
    g.beginPath(); g.roundRect(-geo.bodyW * .4, geo.bodyTop - o, geo.bodyW * .8, geo.headH * .16, geo.headH * .08);
    g.fillStyle = c.accent; g.fill(); g.stroke();
    if (view !== 'back') { g.beginPath(); g.roundRect(geo.bodyW * .12, geo.bodyTop + geo.headH * .08, geo.headH * .13, geo.headH * .3, geo.headH * .05); g.fill(); g.stroke(); }
  }
}

function eyes(g, spec, geo, view, expression, blink) {
  if (view === 'back') return;
  const c = spec.palette, cy = geo.headCY + geo.headH * .02, gap = geo.headW * .19;
  const shift = view === 'three_quarter' ? geo.headW * .14 : view === 'side' ? geo.headW * .25 : 0;
  const look = expression === 'thinking' ? [geo.eye * .45, -geo.eye * .6] : [0, 0];
  const list = view === 'side' ? [[shift, 1]] : view === 'three_quarter' ? [[shift - gap * .78, .84], [shift + gap * .9, 1]] : [[-gap, 1], [gap, 1]];
  const r = geo.eye * (expression === 'surprised' ? 1.28 : 1);
  g.fillStyle = c.eye; g.strokeStyle = c.eye; g.lineCap = 'round';
  for (const [x, scale] of list) {
    if (expression === 'happy') {
      g.beginPath(); g.arc(x, cy + r * .5, r * 1.05 * scale, Math.PI * 1.12, Math.PI * 1.88); g.lineWidth = r * .62; g.stroke();
    } else {
      const open = clamp(1 - blink);
      g.beginPath();
      if (open < .2) { g.moveTo(x - r * scale, cy); g.lineTo(x + r * scale, cy); g.lineWidth = r * .45; g.stroke(); }
      else { g.ellipse(x + look[0], cy + look[1], r * scale, r * scale * open, 0, 0, TAU); g.fill(); }
      // A small catch light keeps a dot eye alive.
      if (open >= .6) { g.beginPath(); g.arc(x + look[0] + r * .32 * scale, cy + look[1] - r * .34, r * .26 * scale, 0, TAU); g.fillStyle = '#ffffff'; g.fill(); g.fillStyle = c.eye; }
    }
    // Brows carry surprised, worried and thinking.
    const by = cy - r * 2.3, bw = r * 1.4 * scale;
    g.lineWidth = Math.max(1, r * .4); g.beginPath();
    if (expression === 'surprised') { g.arc(x, by + r * .5, bw, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); }
    else if (expression === 'worried') {
      // The inner ends rise: toward the middle of the face (or forward, for a side view's one eye).
      const inner = view === 'side' ? 1 : x < shift ? 1 : -1;
      g.moveTo(x - bw * inner, by + r * .25); g.lineTo(x + bw * .75 * inner, by - r * .55); g.stroke();
    }
    else if (expression === 'thinking' && x === list.at(-1)[0]) { g.moveTo(x - bw, by); g.lineTo(x + bw, by - r * .6); g.stroke(); }
  }
}

function cheeks(g, spec, geo, view, expression) {
  if (view === 'back' || view === 'side') return;
  const cy = geo.headCY + geo.headH * .17, gap = geo.headW * .3, shift = view === 'three_quarter' ? geo.headW * .14 : 0;
  g.save(); g.globalAlpha *= expression === 'happy' ? .65 : .38; g.fillStyle = spec.palette.cheek;
  for (const x of view === 'three_quarter' ? [shift + gap * .95] : [-gap, gap]) { g.beginPath(); g.ellipse(x, cy, geo.eye * 1.25, geo.eye * .7, 0, 0, TAU); g.fill(); }
  g.restore();
}

export function drawMouth(g, spec, geo, view, shape, expression = 'neutral') {
  if (view === 'back') return;
  const c = spec.palette, w = geo.headW * .3, x = view === 'three_quarter' ? geo.headW * .13 : view === 'side' ? geo.headW * .3 : 0;
  const y = geo.headCY + geo.headH * .24;
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = c.mouth; g.fillStyle = c.mouth;
  const lw = Math.max(1.5, geo.outline * .8), side = view === 'side' ? .6 : 1;
  if (shape === 'rest') {
    g.beginPath(); g.lineWidth = lw;
    if (expression === 'happy') { g.moveTo(x - w * .5 * side, y - w * .05); g.quadraticCurveTo(x, y + w * .42, x + w * .5 * side, y - w * .05); g.closePath(); g.fill(); g.stroke(); }
    else if (expression === 'worried') { g.moveTo(x - w * .32 * side, y + w * .06); g.quadraticCurveTo(x - w * .1, y - w * .08, x, y + w * .02); g.quadraticCurveTo(x + w * .12, y + w * .12, x + w * .32 * side, y - w * .02); g.stroke(); }
    else if (expression === 'surprised') { g.ellipse(x, y + w * .05, w * .14 * side, w * .18, 0, 0, TAU); g.fill(); }
    else if (expression === 'thinking') { g.moveTo(x - w * .1, y + w * .04); g.lineTo(x + w * .3 * side, y - w * .02); g.stroke(); }
    else { g.moveTo(x - w * .32 * side, y); g.quadraticCurveTo(x, y + w * .2, x + w * .32 * side, y); g.stroke(); }
    return;
  }
  g.beginPath();
  if (shape === 'A') { g.ellipse(x, y + w * .1, w * .3 * side, w * .27, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(x, y + w * .26, w * .16 * side, w * .08, 0, 0, TAU); g.fillStyle = c.cheek; g.fill(); }
  else if (shape === 'E') { g.roundRect(x - w * .38 * side, y - w * .02, w * .76 * side, w * .2, w * .08); g.fill(); g.beginPath(); g.rect(x - w * .3 * side, y - w * .02, w * .6 * side, w * .06); g.fillStyle = '#ffffff'; g.fill(); }
  else if (shape === 'O') { g.ellipse(x, y + w * .06, w * .17 * side, w * .2, 0, 0, TAU); g.fill(); }
  else if (shape === 'MBP') { g.moveTo(x - w * .26 * side, y + w * .04); g.lineTo(x + w * .26 * side, y + w * .04); g.lineWidth = lw * 1.6; g.stroke(); }
  else if (shape === 'FV') { g.roundRect(x - w * .26 * side, y, w * .52 * side, w * .14, w * .05); g.fill(); g.beginPath(); g.rect(x - w * .2 * side, y, w * .4 * side, w * .07); g.fillStyle = '#ffffff'; g.fill(); }
}

// Draws one character with its feet at (x, y), `H` pixels tall. Returns the frame boxes the layout reports.
// state: {view, expression, mouth, blink, pose, facing}
export function drawCharacter(g, spec, x, y, H, state = {}) {
  const view = state.view || 'front', expression = state.expression || 'neutral', pose = state.pose || poseAt('idle', 0);
  const facing = state.facing === 'left' ? -1 : 1, geo = geometry(spec, H, view), c = spec.palette;
  g.save();
  g.translate(x, y - pose.lift * H);
  g.scale(pose.sx * (view === 'front' || view === 'back' ? 1 : facing), pose.sy);
  g.rotate(pose.lean);
  // Far limbs first (behind the body in turned views), then legs, body, near arm, head.
  const far = view === 'side' || view === 'three_quarter';
  const [left, right] = [-1, 1];
  if (far) limb(g, spec, geo, left * geo.shoulderX * (view === 'side' ? .2 : .7), geo.shoulderY, left, geo.armBone, pose.arm[0]);
  limb(g, spec, geo, left * geo.hipX, geo.hipY, left, geo.legBone, pose.leg[0], 'foot');
  limb(g, spec, geo, right * geo.hipX, geo.hipY, right, geo.legBone, pose.leg[1], 'foot');
  if (view === 'back') { limb(g, spec, geo, left * geo.shoulderX, geo.shoulderY, left, geo.armBone, pose.arm[0]); limb(g, spec, geo, right * geo.shoulderX, geo.shoulderY, right, geo.armBone, pose.arm[1]); }
  fillShape(g, spec, geo, spec.family, 0, geo.bodyCY, geo.bodyW, geo.bodyH, 'body', [c.body, c.body_shade]);
  if (view !== 'back') {
    // A belly patch in the head colour gives the body a front.
    g.save(); g.globalAlpha *= .55; g.beginPath();
    g.ellipse(view === 'front' ? 0 : geo.bodyW * .12, geo.bodyCY + geo.bodyH * .1, geo.bodyW * (view === 'side' ? .16 : .24), geo.bodyH * .26, 0, 0, TAU);
    g.fillStyle = c.head; g.fill(); g.restore();
  }
  if (!far && view !== 'back') limb(g, spec, geo, left * geo.shoulderX, geo.shoulderY, left, geo.armBone, pose.arm[0]);
  if (view !== 'back') limb(g, spec, geo, right * geo.shoulderX * (view === 'side' ? .2 : 1), geo.shoulderY, right, geo.armBone, pose.arm[1]);
  // The head turns about the neck: tilt and nod.
  g.save(); g.translate(0, geo.bodyTop); g.rotate(pose.tilt * (view === 'front' || view === 'back' ? 1 : 1)); g.translate(0, -geo.bodyTop + pose.nod * H);
  accessory(g, spec, geo, view, true);
  const headFamily = spec.family === 'square' ? 'square' : 'round';
  fillShape(g, spec, geo, headFamily, 0, geo.headCY, geo.headW, geo.headH, 'head', [c.head, c.head]);
  if (view === 'back') {
    g.save(); path(g, headFamily, 0, geo.headCY + geo.headH * .06, geo.headW * .8, geo.headH * .74, 'head'); g.globalAlpha *= .22; g.fillStyle = c.body_shade; g.fill(); g.restore();
  }
  cheeks(g, spec, geo, view, expression);
  eyes(g, spec, geo, view, expression, state.blink || 0);
  drawMouth(g, spec, geo, view, state.mouth && state.mouth !== 'rest' ? state.mouth : 'rest', expression);
  accessory(g, spec, geo, view, false);
  g.restore();
  g.restore();
  return figureBox(spec, x, y, H, state);
}

// Boxes in frame pixels for layout and the sheet-match checks: the figure (with room for raised arms and the
// accessory), its height, the body's centre and size, and the outline width it was drawn with.
export function figureBox(spec, x, y, H, state = {}) {
  const view = state.view || 'front', pose = state.pose || poseAt('idle', 0), geo = geometry(spec, H, view);
  const sx = pose.sx, sy = pose.sy, foot = y - pose.lift * H, top = foot - H * sy * 1.12;
  const width = (Math.max(geo.bodyW, geo.headW) + geo.armBone * 2.6) * sx;
  return { x: x - width / 2, y: top, w: width, h: H * sy * 1.12 + geo.limbW, height: H * sy,
    body: { cx: x, cy: foot + geo.bodyCY * sy, w: geo.bodyW * sx, h: geo.bodyH * sy }, outline: geo.outline };
}
