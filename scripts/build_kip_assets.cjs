// Builds Kip's terminal assets for the Kairos CLI (static/img/mascot/kip/).
//   node scripts/build_kip_assets.cjs           # write them
//   node scripts/build_kip_assets.cjs --check   # fail if they are stale
// Kip is Ajar on a pixel grid (static/js/kip.js); the CLI uses it in its
// 12 x 6 cell mascot slot and its banner (Kairos CLI build spec, "Mascot
// slot"). Colours come from the brand tokens in static/css/kairos-theme.css,
// in the CLI's two terminal themes: parchment (light terminals) and night
// (dark terminals). The format is documented in the mascot build spec's
// asset section and in kip/README.md, which this script also writes.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'static', 'img', 'mascot', 'kip');
// The CLI's states, and the engine state each one plays.
const STATES = [['idle', 'idle'], ['thinking', 'thinking'], ['needs-you', 'needs'], ['done', 'success'], ['error', 'error'], ['sleeping', 'sleeping']];
const SPEC = { shape: 'round', acc: 'none' };  // Kairos itself

function brandTokens() {
  const css = fs.readFileSync(path.join(root, 'static', 'css', 'kairos-theme.css'), 'utf8');
  return Object.fromEntries([...css.matchAll(/(--k-[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)].map(([, name, value]) => [name, value.toUpperCase()]));
}

function palettes(K, t) {
  const parchment = { body: t['--k-ink'], eye: t['--k-surface'], gold: t['--k-gold'], goldHi: t['--k-gold-hi'], goldText: t['--k-gold-text'],
    rose: t['--k-rose'], danger: t['--k-danger'], inkDim: t['--k-ink-dim'], inkFaint: t['--k-ink-faint'], stage: t['--k-parchment'], inkFixed: t['--k-ink'] };
  // Night: Kairos's ink body reads as parchment on a dark terminal, as the
  // app's dark appearances turn --text light.
  const night = { ...parchment, body: t['--k-parchment'], eye: t['--k-ink'], goldText: t['--k-gold-hi'],
    inkDim: K.mixColor(t['--k-parchment'], t['--k-ink'], .3), inkFaint: K.mixColor(t['--k-parchment'], t['--k-ink'], .45), stage: t['--k-ink'] };
  return { parchment, night };
}

// -- a small PNG encoder (RGBA, no dependencies) ---------------------------------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xFFFFFFFF; for (const byte of buffer) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) { const [r, g, b, a] = pixel(x, y); raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4); }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

async function build() {
  const K = await import(pathToFileURL(path.join(root, 'static', 'js', 'kip.js')).href);
  const pals = palettes(K, brandTokens());
  const files = new Map();
  const sheet = { format: 'kairos-kip-sheet', version: 1, character: 'Kip, the Kairos mascot', style: 'pixel',
    states: STATES.map(([name]) => name), sizes: {}, themes: {}, text_face: {}, spinner: {} };
  for (const [size, draw, grid] of [['full', K.kipFrame, K.KIP_GRID], ['mini', K.kipMiniFrame, K.KIP_MINI_GRID]]) {
    sheet.sizes[size] = { grid, cells: [grid, grid / 2], png: {}, frames: {} };
    for (const [theme, pal] of Object.entries(pals)) {
      const colours = [];
      const index = colour => { let i = colours.indexOf(colour); if (i < 0) { colours.push(colour); i = colours.length - 1; } return i; };
      const framesByState = {};
      for (const [name, state] of STATES) framesByState[name] = Array.from({ length: K.KIP_LOOPS[state] }, (_, f) => draw(state, f, SPEC, pal));
      // JSON frames: one string per row, '.' clear, otherwise a palette index (base 36).
      sheet.sizes[size].frames[theme] = Object.fromEntries(Object.entries(framesByState).map(([name, frames]) => [name, frames.map(frame =>
        Array.from({ length: grid }, (_, y) => Array.from({ length: grid }, (_, x) => { const c = frame.get(x + ',' + y); return c ? index(c).toString(36) : '.'; }).join('')))]));
      sheet.themes[theme] ||= {};
      sheet.themes[theme][size] = colours;
      // PNG sheet: one row per state (in `states` order), one column per frame.
      const columns = Math.max(...Object.values(framesByState).map(frames => frames.length));
      const rows = Object.values(framesByState);
      const name = `kip-${size}-${theme}.png`;
      files.set(name, png(columns * grid, rows.length * grid, (x, y) => {
        const frame = rows[Math.floor(y / grid)][Math.floor(x / grid)];
        const colour = frame?.get((x % grid) + ',' + (y % grid));
        return colour ? [...K.rgbOf(colour), 255] : [0, 0, 0, 0];
      }));
      sheet.sizes[size].png[theme] = name;
    }
  }
  sheet.fps = Object.fromEntries(STATES.map(([name, state]) => [name, K.KIP_FPS[state]]));
  sheet.frame_counts = Object.fromEntries(STATES.map(([name, state]) => [name, K.KIP_LOOPS[state]]));
  // Tier 2: a three-line text face for terminals without truecolour; '*' is
  // the point. Tier 3: a one-character status (the CLI's working line).
  const eyes = { idle: '▮ ▮', thinking: '▮ ▮', 'needs-you': '▮ ▮', done: '^ ^', error: '; ;', sleeping: '- -' };
  const point = { idle: '*', thinking: '*', 'needs-you': '!', done: '*', error: 'x', sleeping: 'z' };
  for (const [name] of STATES) {
    sheet.text_face[name] = { unicode: [' .---.  ' + point[name], '( ' + eyes[name] + ' )', " `---'"],
      ascii: [' .---.  ' + point[name], '( ' + eyes[name].replace(/▮/g, '|') + ' )', " `---'"] };
  }
  sheet.spinner = { thinking: ['◜', '◝', '◞', '◟'], 'needs-you': ['!'], done: ['✓'], error: ['×'], idle: ['•'], sleeping: ['z'],
    ascii: { thinking: ['|', '/', '-', '\\'], 'needs-you': ['!'], done: ['+'], error: ['x'], idle: ['.'], sleeping: ['z'] } };
  files.set('kip.json', Buffer.from(JSON.stringify(sheet, null, 1) + '\n'));
  // Tier 1 without colour support: plain half-blocks, the first frame of each state.
  for (const [name, state] of STATES) {
    files.set(`kip-${name}.txt`, Buffer.from(K.kipHalfBlocks(K.kipFrame(state, K.KIP_STILL[state], SPEC, pals.night), { color: false, hole: pals.night.eye }).join('\n') + '\n'));
    files.set(`kip-mini-${name}.txt`, Buffer.from(K.kipHalfBlocks(K.kipMiniFrame(state, K.KIP_STILL[state], SPEC, pals.night), { n: 12, color: false, hole: pals.night.eye }).join('\n') + '\n'));
  }
  files.set('README.md', Buffer.from(README));
  return files;
}

const README = `# Kip terminal assets

Kip, the Kairos mascot, in its pixel style (vault: "Kairos Mascot (Build
Spec)", section 6; the app draws the flat style, Home the halftone). Built by
\`node scripts/build_kip_assets.cjs\` from \`static/js/kip.js\` and the brand
tokens; do not edit by hand.

States: \`idle\`, \`thinking\`, \`needs-you\`, \`done\`, \`error\`, \`sleeping\`
(sleeping plays at 4 frames a second).
Themes: \`parchment\` (light terminals), \`night\` (dark terminals).
Sizes: \`full\` (24 x 24 pixels, 24 x 12 cells) and \`mini\` (12 x 12 pixels,
12 x 6 cells, the CLI's mascot slot).

- \`kip-<size>-<theme>.png\`: a sprite sheet. One row per state, in the order of
  \`states\` in kip.json; one column per frame, left to right. Unused cells at
  the end of a row are transparent. For sixel or Kitty graphics.
- \`kip.json\`: the same frames as text. \`sizes.<size>.frames.<theme>.<state>\`
  is a list of frames; a frame is a list of rows; each character is \`.\`
  (clear) or a base-36 index into \`themes.<theme>.<size>\` (hex colours).
  \`fps\` and \`frame_counts\` give the loop. Draw two pixel rows per cell with
  \`▀\` (upper half: foreground = top pixel, background = bottom pixel).
- \`kip-<state>.txt\`, \`kip-mini-<state>.txt\`: the still frame as plain
  half-blocks with no colour, for terminals without truecolour.
- \`text_face\` (three lines, \`unicode\` and \`ascii\`) and \`spinner\` in
  kip.json: the plain-terminal tiers.

Choose the tier by capability: sixel or Kitty graphics, then truecolour
half-blocks from kip.json, then the plain text face, else hidden. Honour
\`--no-motion\` by drawing frame 0 only.
`;

build().then(files => {
  if (process.argv.includes('--check')) {
    // Text is compared with LF line endings: Git may check it out as CRLF.
    const same = (name, data) => { const disk = fs.readFileSync(path.join(outDir, name));
      return name.endsWith('.png') ? disk.equals(data) : disk.toString('utf8').replace(/\r\n/g, '\n') === data.toString('utf8'); };
    const stale = [...files].filter(([name, data]) => !fs.existsSync(path.join(outDir, name)) || !same(name, data)).map(([name]) => name);
    if (stale.length) { console.error('Stale Kip assets (run node scripts/build_kip_assets.cjs): ' + stale.join(', ')); process.exit(1); }
    console.log('Kip assets are current.'); return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, data] of files) fs.writeFileSync(path.join(outDir, name), data);
  console.log(`Wrote ${files.size} files to ${path.relative(root, outDir)}`);
}).catch(error => { console.error(error); process.exit(1); });
