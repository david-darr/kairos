// Ajar, the Kairos mascot (Kairos Mascot build spec, locked 2026-10-22).
// The Kairos mark turned into a character: a flat body with the ring's
// opening bitten out of the upper right, the gold point resting in the bite,
// and two blinking pill eyes. Kairos itself is the ink round body; every bot
// is a variant (one of the six agent pastels, a shape, one accessory). The
// point, the bite and the eyes are never customisable.
//
// Two render paths, because rosters must stay cheap (the agentAvatar.js
// lesson, 2026-10-14: no SVG filters, no canvas or ResizeObserver per face):
//  - mascotUrl(spec, pose): a cached, static SVG data URL of a still pose for
//    lists, rosters, thumbnails and notifications (mascotPng rasterizes it).
//  - <kairos-mascot state="..">: inline SVG for live states, used only where
//    the state changes (Home hero, chat activity, empty states, the call).
// Both share one markup builder and one pose sheet (POSE_CSS): a pose is what
// a state looks like standing still, which is also the reduced-motion look.
// static/css/mascot.css adds the movement on top.
//
// Colours: nothing here names a colour. The body is a theme token (--text for
// Kairos, --m-body-<key> for the pastels in kairos-theme.css); everything else
// is an --m-* token from mascot.css. A static image cannot see the page's CSS,
// so mascotUrl resolves the tokens through a probe and caches per theme.
import { BAYER4 } from './dither.js';
import { kipFrame, kipSvg, kipStripSvg, KIP_LOOPS, KIP_STILL, hexOf, rgbOf } from './kip.js';

export const MASCOT_STATES = ['idle', 'thinking', 'listening', 'speaking', 'success', 'needs', 'error', 'sleeping'];
export const STATE_WORDS = { idle: 'idle', thinking: 'thinking', listening: 'listening', speaking: 'speaking',
  success: 'done', needs: 'needs you', error: 'error', sleeping: 'sleeping' };
export const AJAR_SHAPES = ['round', 'squircle', 'tall'];
export const AJAR_ACCESSORIES = ['none', 'laurel', 'spectacles', 'quill', 'rays', 'scarf'];
export const AJAR_FINISHES = ['flat', 'halftone'];
// The six agent pastels (services/agent_service.py COLORS). Each key names its
// theme token, --m-body-<key>; the spec stores '#' + key, upper case.
export const AJAR_COLOR_KEYS = ['d9b260', 'b9d2e3', 'e8c39e', 'd99a92', 'b5c7a5', 'cdbfd9'];
export const AJAR_COLORS = AJAR_COLOR_KEYS.map(key => '#' + key.toUpperCase());
export const AJAR_COLOR_NAMES = { d9b260: 'Gold', b9d2e3: 'Powder', e8c39e: 'Sand', d99a92: 'Rose', b5c7a5: 'Sage', cdbfd9: 'Lilac' };
export const AJAR_ACCESSORY_NAMES = { none: 'None', laurel: 'Laurel', spectacles: 'Spectacles', quill: 'Quill', rays: 'Rays', scarf: 'Scarf' };
// Kairos itself: ink, round, no accessory. 'ink' is never a stored bot colour.
export const KAIROS_SPEC = Object.freeze({ version: 3, character: 'ajar', shape: 'round', color: 'ink', acc: 'none', finish: 'flat' });

// -- specs ---------------------------------------------------------------------

export function hashId(id) {
  let hash = 2166136261;
  for (const char of String(id || 'agent')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

function hsl(rgb) {
  const [r, g, b] = rgb.map(v => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
// The nearest Ajar body colour: by hue for a coloured source (a saturated dot
// face colour lands on the pastel of the same family), by distance for a
// greyish one. services/agent_service.py nearest_ajar_color is the same rule.
export function nearestAjarColor(value) {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  const source = rgbOf(value), [h, s] = hsl(source);
  let best = 0, bestScore = Infinity;
  AJAR_COLOR_KEYS.forEach((key, index) => {
    const target = rgbOf('#' + key);
    const score = s > .15 ? Math.min(Math.abs(hsl(target)[0] - h), 360 - Math.abs(hsl(target)[0] - h))
      : Math.hypot(...target.map((v, i) => v - source[i]));
    if (score < bestScore - 1e-9) { bestScore = score; best = index; }
  });
  return AJAR_COLORS[best];
}

const LEGACY_SHAPES = { round: 'round', squircle: 'squircle', pill: 'tall', bean: 'tall' };
export function isAjarSpec(spec) { return !!spec && typeof spec === 'object' && spec.version === 3 && spec.character === 'ajar'; }

// Any spec in, a clean v3 spec out. A v2 dot-face spec (or none) is migrated
// the way the backend migrates stored bots: its colour to the nearest pastel,
// pill and bean to tall, glasses to spectacles, the rest from the bot's id.
export function toAjarSpec(raw, { id, color } = {}) {
  const seed = hashId(id);
  if (isAjarSpec(raw)) {
    return { version: 3, character: 'ajar',
      shape: AJAR_SHAPES.includes(raw.shape) ? raw.shape : AJAR_SHAPES[seed % 3],
      color: raw.color === 'ink' ? 'ink' : AJAR_COLORS.includes(String(raw.color).toUpperCase()) ? String(raw.color).toUpperCase() : nearestAjarColor(raw.color) || nearestAjarColor(color) || AJAR_COLORS[seed % 6],
      acc: AJAR_ACCESSORIES.includes(raw.acc) ? raw.acc : 'none',
      finish: AJAR_FINISHES.includes(raw.finish) ? raw.finish : 'flat' };
  }
  const legacy = raw && typeof raw === 'object' ? raw : {};
  const accessories = [legacy.accessory, ...(Array.isArray(legacy.accessories) ? legacy.accessories : [])];
  return { version: 3, character: 'ajar',
    shape: LEGACY_SHAPES[legacy.form] || AJAR_SHAPES[seed % 3],
    color: nearestAjarColor(legacy.color) || nearestAjarColor(color) || AJAR_COLORS[seed % 6],
    acc: accessories.includes('glasses') ? 'spectacles' : 'none', finish: 'flat' };
}
export function defaultMascot(id, color) { return toAjarSpec(null, { id, color }); }
// Like toAjarSpec, but keeps Kairos's own ink body (never a bot's).
export function normalizeMascot(raw, context) {
  if (raw?.color === 'ink') {
    const spec = toAjarSpec({ ...raw, color: AJAR_COLORS[0] }, context);
    return { ...spec, color: 'ink' };
  }
  return toAjarSpec(raw, context);
}

// Bots by id, for <kairos-mascot bot="id">. agentAvatar.js keeps it current.
const bots = new Map();
export function rememberBot(agent) { if (agent?.id) bots.set(agent.id, agent); }
export function botMascot(agent) { return toAjarSpec(agent?.avatar, { id: agent?.id, color: agent?.color }); }

// -- tokens ----------------------------------------------------------------------

const hasDom = typeof document !== 'undefined';
const bodyKey = spec => spec.color === 'ink' ? 'ink' : String(spec.color || '').replace('#', '').toLowerCase();
const bodyVar = spec => spec.color === 'ink' ? 'var(--m-ink-body)' : `var(--m-body-${bodyKey(spec)})`;
const eyeVar = spec => spec.color === 'ink' ? 'var(--m-ink-eye)' : 'var(--m-pastel-eye)';
const TOKEN_NAMES = ['--m-point', '--m-stage', '--m-shadow', '--m-halo', '--m-danger', '--m-ripple', '--m-dim', '--m-gold-hi',
  '--m-gold-text', '--m-acc', '--m-rose', '--m-line', '--m-ink-body', '--m-ink-eye', '--m-pastel-eye', '--m-ink-fixed', '--m-faint',
  ...AJAR_COLOR_KEYS.map(key => `--m-body-${key}`)];
let themeVersion = 0, tokenCache = null;
if (hasDom) {
  const bump = () => { themeVersion++; tokenCache = null; };
  document.addEventListener('kairos:appearance', bump);
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bump); } catch { /* optional */ }
}
export function mascotThemeVersion() { return themeVersion; }
// Every --m-* token as a computed colour string (rgb() or rgba()).
export function mascotTokens() {
  if (tokenCache) return tokenCache;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  (document.body || document.documentElement).append(probe);
  const out = {};
  for (const name of TOKEN_NAMES) { probe.style.color = ''; probe.style.color = `var(${name})`; out[name] = getComputedStyle(probe).color; }
  probe.remove();
  return (tokenCache = out);
}
function resolvedStyle(spec) {
  const t = mascotTokens();
  const vars = { '--m-body': spec.color === 'ink' ? t['--m-ink-body'] : t[`--m-body-${bodyKey(spec)}`],
    '--m-eye': spec.color === 'ink' ? t['--m-ink-eye'] : t['--m-pastel-eye'] };
  for (const name of TOKEN_NAMES) if (!name.startsWith('--m-body-')) vars[name] = t[name];
  return Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
}

// -- markup ----------------------------------------------------------------------

// What each state looks like standing still. Shared by the live element (as
// one injected stylesheet) and every static image (embedded), so a still
// thumbnail and a reduced-motion live mascot are the same picture.
export const POSE_CSS = `
.ajar{--m-v:max(var(--level,0),var(--word,0));display:block;width:100%;height:100%;overflow:visible}
.ajar .aj-shadow{fill:var(--m-shadow)}
.ajar .aj-body{fill:var(--m-body)}
.ajar[data-finish=halftone] .aj-body{fill-opacity:.1}
.ajar .aj-eye{fill:var(--m-eye);transform-box:fill-box;transform-origin:center}
.ajar .aj-happy,.ajar .aj-shut{fill:none;stroke:var(--m-eye);stroke-width:5;stroke-linecap:round;opacity:0}
.ajar .aj-brow{fill:none;stroke:var(--m-eye);stroke-width:3.5;stroke-linecap:round;transform-box:fill-box;transform-origin:center}
.ajar .aj-brows{opacity:0}
.ajar .aj-mouth{fill:var(--m-eye);opacity:0;transform-box:fill-box;transform-origin:center}
.ajar .aj-point{fill:var(--m-point);stroke:var(--m-stage);stroke-width:2.5}
.ajar .aj-halo{fill:none;stroke:var(--m-halo);stroke-width:2;opacity:0;transform-box:fill-box;transform-origin:center}
.ajar .aj-voice{fill:var(--m-halo);opacity:0;transform-box:fill-box;transform-origin:center}
.ajar .aj-pt{transform-box:fill-box;transform-origin:center}
.ajar .aj-orbit{transform-box:view-box;transform-origin:70px 76px}
.ajar .aj-hop,.ajar .aj-tilt,.ajar .aj-breathe{transform-box:view-box;transform-origin:70px 122px}
.ajar .aj-spark{stroke:var(--m-point);stroke-width:3;stroke-linecap:round;opacity:0;transform-box:view-box;transform-origin:100px 36px}
.ajar .aj-ripple path{fill:none;stroke:var(--m-ripple);stroke-width:3;stroke-linecap:round;opacity:0;transform-box:fill-box;transform-origin:center}
.ajar .aj-z text{fill:var(--m-dim);font-family:Cormorant Garamond,Garamond,serif;font-style:italic;opacity:0}
.ajar .acc-laurel ellipse{fill:var(--m-gold-hi);stroke:var(--m-gold-text);stroke-width:1}
.ajar .acc-spectacles{fill:none;stroke:var(--m-gold-text);stroke-width:2.6}
.ajar .acc-quill .vane{fill:var(--m-gold-hi);stroke:var(--m-gold-text);stroke-width:1.2}
.ajar .acc-quill .spine{fill:none;stroke:var(--m-dim);stroke-width:2;stroke-linecap:round}
.ajar .acc-rays line{stroke:var(--m-point);stroke-width:3.4;stroke-linecap:round}
.ajar .acc-scarf path{fill:var(--m-rose);stroke:var(--m-line);stroke-width:1}
.ajar[data-state=thinking] .aj-orbit{transform:rotate(40deg)}
.ajar[data-state=thinking] .aj-eyes{transform:translate(4px,-2px)}
.ajar[data-state=listening] .aj-tilt{transform:rotate(-5deg)}
.ajar[data-state=listening] .aj-eye{transform:scaleY(calc(1.12 + var(--m-v) * .18))}
.ajar[data-state=listening] .aj-ripple path{opacity:.8}
.ajar[data-state=listening] .aj-pt{transform:scale(calc(1 + var(--m-v) * .55))}
.ajar:is([data-state=listening],[data-state=speaking]) .aj-voice{opacity:calc(.1 + var(--m-v) * .3);transform:scale(calc(1 + var(--m-v) * .2))}
.ajar[data-state=speaking] .aj-mouth{opacity:1;transform:scaleY(calc(1 + var(--m-v) * 2.8))}
.ajar[data-state=speaking] .aj-eye{transform:scaleY(calc(1 - var(--m-v) * .4))}
.ajar[data-state=speaking] .aj-pt{transform:scale(calc(1 + var(--m-v) * .5))}
.ajar[data-state=success] .aj-eye{opacity:0}
.ajar[data-state=success] .aj-happy{opacity:1}
.ajar[data-state=success] .aj-spark{opacity:1}
.ajar[data-state=needs] .aj-brows{opacity:1}
.ajar[data-state=needs] .aj-brow{transform:translateY(-4px)}
.ajar[data-state=needs] .aj-halo{opacity:.55;transform:scale(1.6)}
.ajar[data-state=error] .aj-brows{opacity:1}
.ajar[data-state=error] .aj-brow.l{transform:rotate(-16deg)}
.ajar[data-state=error] .aj-brow.r{transform:rotate(16deg)}
.ajar[data-state=error] .aj-eye{transform:translateY(4px) scaleY(.5)}
.ajar[data-state=error] .aj-point{fill:var(--m-danger)}
.ajar[data-state=error] .aj-pt{transform:translate(-4px,10px)}
.ajar[data-state=error] .aj-mouth{opacity:1;transform:scaleX(.7)}
.ajar[data-state=sleeping] .aj-eye{opacity:0}
.ajar[data-state=sleeping] .aj-shut{opacity:1}
.ajar[data-state=sleeping] .aj-tilt{transform:rotate(5deg)}
.ajar[data-state=sleeping] .aj-pt{transform:translate(-2px,10px) scale(.75);opacity:.5}
.ajar[data-state=sleeping] .aj-z text{opacity:.8}
`.replace(/\n/g, '');

const SHAPES = {
  round: '<circle cx="70" cy="76" r="44"/>',
  squircle: '<rect x="27" y="33" width="86" height="86" rx="30"/>',
  tall: '<rect x="33" y="28" width="74" height="96" rx="37"/>',
};
const fixed = n => n.toFixed(1);
function accessoryMarkup(acc) {
  if (acc === 'laurel') {
    const leaves = [];
    for (let k = 0; k < 7; k++) { const deg = 200 + k * 12, a = deg * Math.PI / 180, x = 70 + 48 * Math.cos(a), y = 76 + 48 * Math.sin(a);
      leaves.push(`<ellipse cx="${fixed(x)}" cy="${fixed(y)}" rx="6" ry="3" transform="rotate(${deg + 90} ${fixed(x)} ${fixed(y)})"/>`); }
    return { front: `<g class="acc acc-laurel">${leaves.join('')}</g>` };
  }
  if (acc === 'rays') {
    const rays = [];
    for (let k = 0; k < 5; k++) { const a = (198 + k * 19) * Math.PI / 180;
      rays.push(`<line x1="${fixed(70 + 52 * Math.cos(a))}" y1="${fixed(76 + 52 * Math.sin(a))}" x2="${fixed(70 + 62 * Math.cos(a))}" y2="${fixed(76 + 62 * Math.sin(a))}"/>`); }
    return { back: `<g class="acc acc-rays">${rays.join('')}</g>` };
  }
  if (acc === 'quill') return { back: '<g class="acc acc-quill"><path class="vane" d="M30 108 C14 92 10 66 18 44 C28 62 34 86 30 108Z"/><path class="spine" d="M31 112 C24 90 20 66 18 46"/></g>' };
  if (acc === 'scarf') return { neck: '<g class="acc acc-scarf"><path d="M34 98 Q70 110 106 98 L104 107 Q70 119 36 107Z"/><path d="M44 104 L40 124 L50 124 L53 107Z"/></g>' };
  if (acc === 'spectacles') return { face: '<g class="acc acc-spectacles"><circle cx="55" cy="75" r="11"/><circle cx="79" cy="75" r="11"/><path d="M66 73 q1 -3 2 0"/></g>' };
  return {};
}
const SPARK = Array.from({ length: 6 }, (_, k) => { const a = (k * 60 + 15) * Math.PI / 180;
  return `<line x1="${fixed(100 + 15 * Math.cos(a))}" y1="${fixed(36 + 15 * Math.sin(a))}" x2="${fixed(100 + 22 * Math.cos(a))}" y2="${fixed(36 + 22 * Math.sin(a))}"/>`; }).join('');

let uid = 0;
// The SVG for a spec in a state. `clipId` must be unique in a document;
// `style` carries the --m-body/--m-eye variables (or, for a static image,
// every token resolved). `tone` is a halftone body image (data URL).
export function ajarMarkup(rawSpec, { state = 'idle', clipId = 'ajc' + (++uid), style = '', standalone = false, tone = '' } = {}) {
  const spec = normalizeMascot(rawSpec?.color === 'ink' ? { ...KAIROS_SPEC, ...rawSpec } : rawSpec);
  const pose = MASCOT_STATES.includes(state) ? state : 'idle';
  const acc = accessoryMarkup(spec.acc);
  const halftone = spec.finish === 'halftone' && tone;
  const head = standalone ? ` xmlns="http://www.w3.org/2000/svg" width="140" height="140"` : '';
  return `<svg class="ajar"${head} viewBox="0 0 140 140" data-state="${pose}" data-shape="${spec.shape}" data-acc="${spec.acc}" data-finish="${halftone ? 'halftone' : 'flat'}" style="${style}" aria-hidden="true" focusable="false">`
    + (standalone ? `<style>${POSE_CSS}</style>` : '')
    + `<defs><clipPath id="${clipId}"><path clip-rule="evenodd" d="M-10 -10H150V150H-10Z M80 36a20 20 0 1 0 40 0a20 20 0 1 0 -40 0Z"/></clipPath></defs>`
    + '<ellipse class="aj-shadow" cx="70" cy="129" rx="36" ry="5"/>'
    + '<circle class="aj-voice" cx="70" cy="76" r="52"/>'
    + (acc.back || '')
    + '<g class="aj-hop"><g class="aj-tilt"><g class="aj-breathe">'
    + `<g class="aj-body" clip-path="url(#${clipId})">${SHAPES[spec.shape] || SHAPES.round}${halftone ? `<image class="aj-tone" href="${tone}" x="0" y="0" width="140" height="140" preserveAspectRatio="none"/>` : ''}</g>`
    + (acc.neck || '')
    + '<g class="aj-face"><g class="aj-brows"><path class="aj-brow l" d="M48 54 L61 52"/><path class="aj-brow r" d="M73 52 L86 54"/></g>'
    + '<g class="aj-eyes"><rect class="aj-eye" x="49" y="62" width="12" height="26" rx="6"/><rect class="aj-eye" x="73" y="62" width="12" height="26" rx="6"/>'
    + '<path class="aj-happy" d="M48 79 q7 -13 14 0 M72 79 q7 -13 14 0"/><path class="aj-shut" d="M48 78 h14 M72 78 h14"/></g>'
    + '<rect class="aj-mouth" x="61" y="96" width="12" height="4" rx="2"/>'
    + (acc.face || '') + '</g>'
    + (acc.front || '')
    + '</g></g></g>'
    + '<g class="aj-orbit"><g class="aj-pt"><circle class="aj-halo" cx="100" cy="36" r="10"/><circle class="aj-point" cx="100" cy="36" r="9"/></g></g>'
    + `<g class="aj-spark">${SPARK}</g>`
    + '<g class="aj-ripple"><path d="M116 27 a13 13 0 0 1 0 18"/><path d="M123 21 a22 22 0 0 1 0 30"/></g>'
    + '<g class="aj-z"><text x="110" y="34" font-size="18">z</text><text x="121" y="20" font-size="13">z</text></g>'
    + '</svg>';
}
export function liveStyle(spec) { return `--m-body:${bodyVar(spec)};--m-eye:${eyeVar(spec)}`; }

// -- static images ---------------------------------------------------------------

const urls = new Map();
function remember(map, key, value) { if (map.size >= 512) map.delete(map.keys().next().value); map.set(key, value); return value; }
export function mascotUrl(rawSpec, pose = 'idle') {
  const spec = normalizeMascot(rawSpec?.color === 'ink' ? { ...KAIROS_SPEC, ...rawSpec } : rawSpec);
  const key = `${themeVersion}|${pose}|${spec.shape}|${spec.color}|${spec.acc}`;
  if (urls.has(key)) return urls.get(key);
  const svg = ajarMarkup({ ...spec, finish: 'flat' }, { state: pose, clipId: 'ajc', style: resolvedStyle(spec), standalone: true });
  return remember(urls, key, `data:image/svg+xml,${encodeURIComponent(svg)}`);
}
const pngs = new Map();
// A raster still (notification icons). Resolves null if it cannot draw.
export function mascotPng(spec, pose = 'needs', size = 64) {
  const source = mascotUrl(spec, pose), key = source + '|' + size;
  if (!pngs.has(key)) remember(pngs, key, new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      try { const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size); resolve(canvas.toDataURL('image/png')); }
      catch { resolve(null); }
    };
    image.onerror = () => { pngs.delete(key); resolve(null); };
    image.src = source;
  }));
  return pngs.get(key);
}

// -- Kip (pixel rendition) -----------------------------------------------------

export function kipPalette(rawSpec) {
  const spec = normalizeMascot(rawSpec?.color === 'ink' ? { ...KAIROS_SPEC, ...rawSpec } : rawSpec), t = mascotTokens();
  const hex = name => hexOf(rgbOf(t[name]));
  return { body: spec.color === 'ink' ? hex('--m-ink-body') : hex(`--m-body-${bodyKey(spec)}`),
    eye: spec.color === 'ink' ? hex('--m-ink-eye') : hex('--m-pastel-eye'),
    gold: hex('--m-point'), goldHi: hex('--m-gold-hi'), goldText: hex('--m-gold-text'), rose: hex('--m-rose'),
    danger: hex('--m-danger'), inkDim: hex('--m-dim'), inkFaint: hex('--m-faint'), stage: hex('--m-stage'), inkFixed: hex('--m-ink-fixed') };
}
const kips = new Map();
export function kipUrl(rawSpec, state = 'idle', frame) {
  const spec = normalizeMascot(rawSpec);
  const f = frame ?? KIP_STILL[state] ?? 0, key = `${themeVersion}|${state}|${f}|${spec.shape}|${spec.color}|${spec.acc}`;
  if (kips.has(key)) return kips.get(key);
  return remember(kips, key, `data:image/svg+xml,${encodeURIComponent(kipSvg(kipFrame(state, f, spec, kipPalette(spec))))}`);
}
// Every frame of a state's loop in one strip, for CSS steps() playback.
export function kipStripUrl(rawSpec, state = 'walk') {
  const spec = normalizeMascot(rawSpec), key = `${themeVersion}|strip|${state}|${spec.shape}|${spec.color}|${spec.acc}`;
  if (kips.has(key)) return { url: kips.get(key), frames: KIP_LOOPS[state] };
  const pal = kipPalette(spec), frames = Array.from({ length: KIP_LOOPS[state] }, (_, f) => kipFrame(state, f, spec, pal));
  return { url: remember(kips, key, `data:image/svg+xml,${encodeURIComponent(kipStripSvg(frames))}`), frames: frames.length };
}

// -- the halftone finish (Mote) --------------------------------------------------

// Ajar's body as halftone dots, the same 4 by 4 ordered dither as dither.js,
// drawn once into a fixed canvas per size and theme. Only the Home hero uses
// it (David, 2026-10-22: Mote is the Home hero's finish).
function insideBody(shape, x, y) {
  let d;
  if (shape === 'squircle') { const u = Math.max(0, Math.abs(x - 70) - 13), v = Math.max(0, Math.abs(y - 76) - 13); d = Math.hypot(u, v) - 30; }
  else if (shape === 'tall') { const v = Math.max(0, Math.abs(y - 76) - 11); d = Math.hypot(x - 70, v) - 37; }
  else d = Math.hypot(x - 70, y - 76) - 44;
  return Math.max(d, 20 - Math.hypot(x - 100, y - 36));  // signed distance, bite removed
}
const tones = new Map();
export function halftoneBody(rawSpec, px) {
  const spec = normalizeMascot(rawSpec?.color === 'ink' ? { ...KAIROS_SPEC, ...rawSpec } : rawSpec);
  const dpr = Math.min(2, window.devicePixelRatio || 1), size = Math.max(32, Math.round(px * dpr));
  const key = `${themeVersion}|${size}|${spec.shape}|${spec.color}`;
  if (tones.has(key)) return tones.get(key);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), t = mascotTokens();
  ctx.fillStyle = spec.color === 'ink' ? t['--m-ink-body'] : t[`--m-body-${bodyKey(spec)}`];
  const cell = Math.max(3, size / 24), n = Math.ceil(size / cell), scale = 140 / size;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + .5) * cell * scale, y = (j + .5) * cell * scale, d = insideBody(spec.shape, x, y);
    if (d > 0) continue;
    const edge = Math.min(1, -d / 9);
    if (edge < 1 && edge < BAYER4[(i & 3) + (j & 3) * 4]) continue;  // a dithered, fuzzy edge
    const tone = Math.max(.25, Math.min(1, .58 + .42 * ((x - 70) / 140 + (y - 76) / 100)));
    ctx.beginPath(); ctx.arc((i + .5) * cell, (j + .5) * cell, cell * .5 * Math.sqrt(tone) * (.6 + .4 * edge), 0, Math.PI * 2); ctx.fill();
  }
  return remember(tones, key, canvas.toDataURL('image/png'));
}

// -- the live element ------------------------------------------------------------

export function mascotOn() { return !hasDom || document.documentElement.dataset.mascot !== 'off'; }
const reducedMotion = () => hasDom && matchMedia('(prefers-reduced-motion: reduce)').matches;
// The browser already slows a hidden window's animations; this stops them.
if (hasDom) document.addEventListener('visibilitychange', () => document.documentElement.toggleAttribute('data-page-hidden', document.hidden));
let poseSheet = null;
function ensurePoseSheet() {
  if (poseSheet?.isConnected) return;
  poseSheet = document.createElement('style'); poseSheet.id = 'kairos-mascot-poses'; poseSheet.textContent = POSE_CSS;
  document.head.append(poseSheet);
}
// One observer for every live mascot: off-screen ones pause.
let visibility = null;
function watch(node) {
  if (!('IntersectionObserver' in window)) return;
  visibility ||= new IntersectionObserver(entries => {
    for (const entry of entries) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting);
  }, { rootMargin: '80px' });
  visibility.observe(node);
}
const SUCCESS_MS = 1800;

// Node (scripts/test_mascot.cjs) loads this module without a DOM.
const ElementBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;
export class KairosMascot extends ElementBase {
  static get observedAttributes() { return ['state', 'size', 'bot', 'spec', 'label', 'decorative', 'finish']; }
  constructor() { super(); this._agent = null; this._timer = 0; this._clip = 'ajc-live-' + (++uid); this._drawn = ''; }
  set agent(value) { this._agent = value || null; if (value) rememberBot(value); this._render(); }
  get agent() { return this._agent; }
  get state() { return MASCOT_STATES.includes(this.getAttribute('state')) ? this.getAttribute('state') : 'idle'; }
  set state(value) { this.setAttribute('state', value); }
  get spec() {
    let raw = null;
    try { raw = this.hasAttribute('spec') ? JSON.parse(this.getAttribute('spec')) : null; } catch { raw = null; }
    const agent = this._agent || (this.getAttribute('bot') ? bots.get(this.getAttribute('bot')) : null);
    let spec = raw ? normalizeMascot(raw)
      : agent || this.getAttribute('bot') ? toAjarSpec(agent?.avatar, { id: agent?.id || this.getAttribute('bot'), color: agent?.color }) : { ...KAIROS_SPEC };
    if (this.getAttribute('finish') === 'halftone') spec = { ...spec, finish: 'halftone' };
    return spec;
  }
  connectedCallback() {
    ensurePoseSheet();
    this._render();
    watch(this);
    if (!this._onAppearance) { this._onAppearance = () => { if (this.spec.finish === 'halftone') { this._drawn = ''; this._render(); } }; }
    document.addEventListener('kairos:appearance', this._onAppearance);
  }
  disconnectedCallback() {
    clearTimeout(this._timer); visibility?.unobserve(this);
    document.removeEventListener('kairos:appearance', this._onAppearance);
  }
  attributeChangedCallback(name, before, after) {
    if (before === after) return;
    if (name === 'state' || name === 'label' || name === 'decorative') this._sync();
    else this._render();
  }
  _size() { const size = Number(this.getAttribute('size')); return Number.isFinite(size) && size > 0 ? size : 0; }
  _render() {
    if (!this.isConnected) return;  // drawn on connect, once
    const spec = this.spec, size = this._size();
    if (size) { this.style.width = size + 'px'; this.style.height = size + 'px'; }
    const tone = spec.finish === 'halftone' && hasDom && this.isConnected ? halftoneBody(spec, size || this.clientWidth || 96) : '';
    const signature = JSON.stringify([spec, tone && tone.length, size]);
    if (signature === this._drawn) { this._sync(); return; }
    this._drawn = signature;
    this.innerHTML = ajarMarkup(spec, { state: this.state, clipId: this._clip, style: liveStyle(spec), tone });
    this._sync();
  }
  _sync() {
    const svg = this.querySelector('svg.ajar'); if (!svg) return;
    const state = this.state;
    svg.dataset.state = state;
    const decorative = this.hasAttribute('decorative');
    if (decorative) { this.setAttribute('aria-hidden', 'true'); this.removeAttribute('role'); this.removeAttribute('aria-label'); }
    else {
      this.removeAttribute('aria-hidden'); this.setAttribute('role', 'img');
      // Set as an attribute value, never as markup: a bot's name is text.
      this.setAttribute('aria-label', `${this.getAttribute('label') || this._agent?.name || 'Kairos'}, ${STATE_WORDS[state]}`);
    }
    clearTimeout(this._timer);
    if (state === 'success') {
      // Success plays once; the host may keep it with preventDefault().
      this._timer = setTimeout(() => {
        if (!this.isConnected || this.state !== 'success') return;
        const settled = new CustomEvent('mascot-settled', { bubbles: true, cancelable: true });
        if (this.dispatchEvent(settled)) this.setAttribute('state', 'idle');
      }, reducedMotion() ? 1200 : SUCCESS_MS);
    }
  }
}
if (hasDom && typeof customElements !== 'undefined' && !customElements.get('kairos-mascot')) customElements.define('kairos-mascot', KairosMascot);

// A live mascot node. label is the accessible name; pass decorative when a
// text status sits beside it (most places).
export function createMascot({ state = 'idle', size, spec, agent, label, decorative = true, finish } = {}) {
  const node = document.createElement('kairos-mascot');
  if (size) node.setAttribute('size', String(size));
  if (spec) node.setAttribute('spec', JSON.stringify(spec));
  if (label) node.setAttribute('label', label);
  if (finish) node.setAttribute('finish', finish);
  if (decorative) node.setAttribute('decorative', '');
  node.setAttribute('state', state);
  if (agent) node.agent = agent;
  return node;
}

// The bot status words (botStatus.js) as mascot states.
export function stateForStatus(status) {
  return ({ needs_you: 'needs', working: 'thinking', teammate: 'idle', queued: 'idle', idle: 'idle', off: 'sleeping', error: 'error' })[status] || 'idle';
}
