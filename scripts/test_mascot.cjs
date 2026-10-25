// The Kairos mascot (vault: "Kairos Mascot (Build Spec)", phase 1).
// Run: node scripts/test_mascot.cjs          (all checks, then the renderer)
//      node scripts/test_mascot.cjs --no-render
// Plain-Node checks load static/js/mascot.js and kip.js straight from disk;
// the browser checks (every state renders, reduced motion stops everything,
// captures in four appearances at 16/28/72/176px) run in Electron through
// scripts/mascot-render.cjs and write to data/mascot-review/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/;
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };

(async () => {
  const M = await import(pathToFileURL(path.join(root, 'static/js/mascot.js')).href);
  const K = await import(pathToFileURL(path.join(root, 'static/js/kip.js')).href);
  const bot = { version: 3, character: 'ajar', shape: 'tall', color: '#D99A92', acc: 'scarf', finish: 'flat' };

  await check('every state has its own markup, for Kairos and a bot', () => {
    for (const spec of [M.KAIROS_SPEC, bot]) {
      const all = M.MASCOT_STATES.map(state => M.ajarMarkup(spec, { state, clipId: 'c' }));
      M.MASCOT_STATES.forEach((state, i) => assert.ok(all[i].includes(`data-state="${state}"`), state));
      assert.equal(new Set(all).size, 8);
    }
    assert.ok(M.ajarMarkup({ ...bot, state: 'nonsense' }, { state: 'nonsense' }).includes('data-state="idle"'), 'an unknown state falls back to idle');
  });
  await check('the notch poses: open widens the bite into a lid, carry trails the point', () => {
    assert.deepEqual(M.MASCOT_POSES, [...M.MASCOT_STATES, 'open', 'carry']);
    assert.deepEqual(M.MASCOT_STATES.length, 8, 'the bot statuses are unchanged');
    for (const spec of [M.KAIROS_SPEC, bot]) {
      const all = M.MASCOT_POSES.map(state => M.ajarMarkup(spec, { state, clipId: 'c' }));
      assert.equal(new Set(all).size, M.MASCOT_POSES.length, 'every pose is its own picture');
      for (const pose of ['open', 'carry']) {
        const svg = M.ajarMarkup(spec, { state: pose, style: M.liveStyle(spec) });
        assert.ok(svg.includes(`data-state="${pose}"`), pose);
        assert.ok(!svg.includes('<filter') && !COLOR.test(svg), pose + ' names no colour and uses no filter');
      }
    }
    assert.ok(M.ajarMarkup(M.KAIROS_SPEC).includes('class="aj-bite"'), 'the bite is addressable');
    assert.match(M.POSE_CSS, /\.ajar\[data-state=open\] \.aj-bite\{d:path\("[^"]*a27 27/, 'open widens the bite');
    assert.match(M.POSE_CSS, /\.ajar\[data-state=carry\] \.aj-orbit\{transform:rotate\(-150deg\)\}/, 'carry trails the point behind');
    assert.ok(!COLOR.test(M.POSE_CSS) && !/anim/.test(M.POSE_CSS), 'still poses, no colour');
    for (const pose of ['open', 'carry']) assert.ok(M.STATE_WORDS[pose], pose + ' has words');
    const css = fs.readFileSync(path.join(root, 'static/css/mascot.css'), 'utf8');
    const start = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    const gate = css.slice(start, css.indexOf('\n}\n', start));
    assert.ok(/data-state=open\] \.aj-pt \{ animation: aj-lid/.test(gate) && /data-state=carry\] \.aj-pt \{ animation: aj-trail/.test(gate),
      'their movement is inside the motion gate');
  });
  await check('no SVG filters and no raw colours in the mascot sources or markup', () => {
    for (const file of ['static/js/mascot.js', 'static/js/kip.js', 'static/js/kipStyle.js', 'static/js/kipPicker.js', 'static/css/mascot.css', 'static/js/agentAvatar.js']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!/<filter|feTurbulence|feGaussianBlur/.test(text), file + ' uses no SVG filters');
      const lines = text.split('\n').filter(line => COLOR.test(line) && !/^\s*(\/\/|\/\*|\*)/.test(line));
      assert.deepEqual(lines, [], file + ' names no colour');
    }
    for (const state of M.MASCOT_STATES) {
      const svg = M.ajarMarkup(bot, { state, style: M.liveStyle(bot) }) + M.POSE_CSS;
      assert.ok(!svg.includes('<filter'));
      assert.ok(!COLOR.test(svg), state + ' markup names no colour');
    }
  });
  await check('the theme tokens behind every body colour exist', () => {
    const theme = fs.readFileSync(path.join(root, 'static/css/kairos-theme.css'), 'utf8');
    for (const key of M.AJAR_COLOR_KEYS) assert.match(theme, new RegExp(`--m-body-${key}:\\s*#${key}`, 'i'));
    const css = fs.readFileSync(path.join(root, 'static/css/mascot.css'), 'utf8');
    for (const name of ['--m-point', '--m-stage', '--m-shadow', '--m-halo', '--m-danger', '--m-ripple', '--m-dim', '--m-faint', '--m-gold-hi', '--m-gold-text', '--m-rose', '--m-line', '--m-ink-body', '--m-ink-eye', '--m-pastel-eye', '--m-ink-fixed'])
      assert.ok(css.includes(name + ':'), name);
  });
  await check('reduced motion: every animation is gated on prefers-reduced-motion', () => {
    const css = fs.readFileSync(path.join(root, 'static/css/mascot.css'), 'utf8');
    const gate = css.indexOf('@media (prefers-reduced-motion: no-preference)');
    const end = css.indexOf('\n}\n', gate);
    const outside = css.slice(0, gate) + css.slice(end);
    assert.ok(!/animation:\s*aj-/.test(outside), 'no keyframe runs outside the motion gate');
    assert.ok(!/animation/.test(M.POSE_CSS), 'still poses carry no animation');
  });
  await check('labels are text: the markup carries no name', () => {
    const svg = M.ajarMarkup(bot, { state: 'needs' });
    assert.ok(svg.includes('aria-hidden="true"'));
    assert.deepEqual(M.STATE_WORDS.needs, 'needs you');
  });
  await check('v3 specs normalise and hostile values never reach the markup', () => {
    assert.deepEqual(M.toAjarSpec(bot), bot);
    const hostile = M.toAjarSpec({ ...bot, shape: '"><script>', color: '#D99A92"/><x', acc: 'onload=1' }, { id: 'x' });
    assert.ok(M.AJAR_SHAPES.includes(hostile.shape) && M.AJAR_COLORS.includes(hostile.color) && hostile.acc === 'none');
    assert.ok(!M.ajarMarkup(hostile).includes('<script'));
  });
  await check('v2 dot faces still read, as their nearest Ajar', () => {
    const v2 = { form: 'pill', color: '#FA70AB', finish: 'plush', face: 'smile', accessory: 'glasses' };
    assert.deepEqual(M.toAjarSpec(v2, { id: 'a1' }), { version: 3, character: 'ajar', shape: 'tall', color: '#D99A92', acc: 'spectacles', finish: 'flat' });
    assert.deepEqual(M.toAjarSpec(null, { id: 'a1', color: '#b9d2e3' }).color, '#B9D2E3');
  });
  await check('v2 and v3 specs both validate in the backend, the same way', () => {
    const python = path.join(root, '.venv', 'Scripts', 'python.exe');
    const script = `import json, sys
from services.agent_service import validate_avatar, nearest_ajar_color, ajar_from_legacy
v2 = {'form': 'pill', 'color': '#FA70AB', 'finish': 'plush', 'face': 'smile', 'accessory': 'glasses'}
v3 = ${JSON.stringify(bot)}
out = {'v2': validate_avatar(v2, 'a1'), 'v3': validate_avatar(v3), 'none': ajar_from_legacy(None, 'a1', '#d9b260'),
       'near': [nearest_ajar_color(c) for c in ['#FA70AB', '#DD6ADC', '#A25BFF', '#4778FF', '#00B1FF', '#04BB9F', '#B6D80B', '#FFCC38', '#FF8066', '#777777']]}
bad = 0
for value in [{**v3, 'color': 'ink'}, {**v3, 'acc': 'bow'}, {**v3, 'x': 1}, {**v2, 'form': 'octopus'}]:
    try: validate_avatar(value)
    except ValueError: bad += 1
out['refused'] = bad
print(json.dumps(out))`;
    const result = spawnSync(fs.existsSync(python) ? python : 'python', ['-c', script], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: root, JARVIS_DATA_DIR: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mascot-')) } });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.deepEqual(out.v2, M.toAjarSpec({ form: 'pill', color: '#FA70AB', finish: 'plush', face: 'smile', accessory: 'glasses' }, { id: 'a1' }));
    assert.deepEqual(out.v3, bot);
    assert.deepEqual(out.none, M.toAjarSpec(null, { id: 'a1', color: '#d9b260' }), 'the default from an id agrees');
    assert.deepEqual(out.near, ['#FA70AB', '#DD6ADC', '#A25BFF', '#4778FF', '#00B1FF', '#04BB9F', '#B6D80B', '#FFCC38', '#FF8066', '#777777'].map(M.nearestAjarColor));
    assert.equal(out.refused, 4);
  });
  await check('Kip draws every state inside its grid, at both sizes', () => {
    const pal = { body: '#3a2a20', eye: '#fbf6ee', gold: '#b8893b', goldHi: '#d9b260', goldText: '#83601f', rose: '#d99a92', danger: '#a8432f', inkDim: '#6b5646', inkFaint: '#7a6553', stage: '#fbf6ee', inkFixed: '#3a2a20' };
    for (const state of [...M.MASCOT_STATES, 'walk']) for (let f = 0; f < K.KIP_LOOPS[state]; f++) {
      for (const [grid, frame] of [[24, K.kipFrame(state, f, bot, pal)], [12, K.kipMiniFrame(state, f, bot, pal)]]) {
        assert.ok(frame.size > 20, `${state} ${f} draws`);
        for (const key of frame.keys()) { const [x, y] = key.split(',').map(Number); assert.ok(x >= 0 && y >= 0 && x < grid && y < grid); }
      }
    }
    const lines = K.kipHalfBlocks(K.kipFrame('idle', 0, bot, pal), { color: false });
    assert.ok(lines.length <= 12 && lines.every(line => /^[ ▀▄█]*$/.test(line)));
  });
  // -- the pixel style --------------------------------------------------------------------
  // The body path is runs of square cells ('M x y h w v s h-w z'); a point is inside when a run covers it.
  const cellsOf = svg => [...svg.matchAll(/<path (?:class="aj-px-hi" )?d="([^"]*)"/g)].map(match => [...match[1].matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h-[\d.]+z/g)].map(run => run.slice(1).map(Number)));
  const covers = (runs, x, y) => runs.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h);
  await check('the pixel finish draws a crisp grid body for every shape, grid and state', () => {
    assert.ok(M.AJAR_FINISHES.includes('pixel'));
    for (const shape of M.AJAR_SHAPES) for (const grid of [14, 20]) {
      const size = 140 / grid;
      const svg = M.ajarMarkup({ ...bot, shape, finish: 'pixel' }, { state: 'idle', grid });
      assert.ok(svg.includes('data-finish="pixel"'), 'the finish is on the svg');
      assert.ok(!svg.includes('clip-path') && !svg.includes('<image'), 'no clipped shape, no raster');
      const [body, light] = cellsOf(svg);
      assert.ok(body.length > 8, shape + ' ' + grid + ' draws rows of cells');
      for (const [x, y, w, h] of [...body, ...light]) {
        assert.ok(Math.abs(x / size - Math.round(x / size)) < 1e-9 && Math.abs(y / size - Math.round(y / size)) < 1e-9 && Math.abs(w / size - Math.round(w / size)) < 1e-9 && Math.abs(h - size) < 1e-9, 'every run sits on the grid');
        assert.ok(x >= 0 && y >= 0 && x + w <= 140 && y + h <= 140, 'inside the face');
      }
      assert.ok(covers(body, 70, 76), shape + ' ' + grid + ': the body covers the centre');
      assert.ok(!covers(body, 100, 36), shape + ' ' + grid + ': the bite is cut out for the point');
      assert.ok(light.length > 0 && light.every(([x, y]) => covers(body, x + size / 2, y + size / 2)), 'the light cells stay on the body');
      assert.ok(covers(body, 55, 75) && covers(body, 79, 75), shape + ' ' + grid + ': the body sits behind both eyes');
    }
    const states = M.MASCOT_STATES.map(state => M.ajarMarkup({ ...bot, finish: 'pixel' }, { state }));
    assert.equal(new Set(states).size, 8, 'every state is its own pixel Kip');
    for (const svg of states) {
      assert.ok(svg.includes('class="aj-eye"') && svg.includes('aj-pt') && svg.includes('aj-point') && svg.includes('aj-mouth'), 'eyes, point and mouth are still there');
      assert.ok(!COLOR.test(svg) && !svg.includes('<filter'), 'the pixel markup names no colour and uses no filter');
    }
    assert.ok(M.ajarMarkup(M.KAIROS_SPEC, { finish: 'pixel' }).includes('data-finish="flat"'), 'a flat spec is unchanged');
    assert.equal(M.pixelGrid(16), 14); assert.equal(M.pixelGrid(40), 14); assert.equal(M.pixelGrid(96), 20); assert.equal(M.pixelGrid(0), 20);
    assert.equal(M.pixelBody('round', 20), M.pixelBody('round', 20), 'a body is built once per shape and grid');
    const kairos = M.ajarMarkup({ ...M.KAIROS_SPEC, finish: 'pixel' }, { state: 'needs' });
    assert.ok(kairos.includes('data-finish="pixel"') && kairos.includes('data-state="needs"'), 'Kairos itself draws in the pixel style');
  });
  await check('the pixel pose sheet keeps the eyes and point readable and stays crisp', () => {
    for (const rule of ['.ajar[data-finish=pixel]{shape-rendering:crispEdges}', '.ajar[data-finish=pixel] :is(.aj-eye,.aj-mouth){rx:0}'])
      assert.ok(M.POSE_CSS.includes(rule), rule);
    assert.ok(!/anim/.test(M.POSE_CSS), 'still poses carry no animation');
    const css = fs.readFileSync(path.join(root, 'static/css/mascot.css'), 'utf8');
    assert.ok(/kairos-mascot\[still\] \* \{ animation: none !important/.test(css), 'a still pixel Kip does not move');
    assert.ok(/@media \(prefers-reduced-motion: reduce\) \{\s*kairos-mascot, kairos-mascot \* \{ animation: none !important/.test(css), 'reduced motion stops it');
    assert.ok(/kip-swap/.test(css.slice(0, css.indexOf('@media (prefers-reduced-motion: reduce)'))), 'the style crossfade is inside the motion gate');
  });
  // -- the Kip style setting ---------------------------------------------------------------
  const S = await import(pathToFileURL(path.join(root, 'static/js/kipStyle.js')).href);
  await check('the Kip style setting has four values and migrates the old on/off', () => {
    assert.deepEqual(S.KIP_STYLES, ['flat', 'halftone', 'pixel', 'hidden']);
    assert.deepEqual(M.AJAR_FINISHES, ['flat', 'halftone', 'pixel'], 'every visible style is a finish');
    for (const style of S.KIP_STYLES) assert.equal(S.kipStyleOf({ kip: style }), style);
    assert.equal(S.kipStyleOf({ mascot: false }), 'hidden', 'the old off is hidden');
    assert.equal(S.kipStyleOf({ mascot: true }), S.DEFAULT_KIP_STYLE, 'the old on keeps the current look (halftone on Home)');
    assert.equal(S.kipStyleOf({}), S.DEFAULT_KIP_STYLE); assert.equal(S.kipStyleOf(null), S.DEFAULT_KIP_STYLE);
    assert.equal(S.kipStyleOf({ kip: 'neon', mascot: false }), 'hidden', 'an unknown style falls back to the old switch');
    assert.equal(S.kipStyleOf({ kip: 'pixel', mascot: false }), 'pixel', 'the new setting wins over the old one');
    for (const style of S.KIP_STYLES) assert.ok(S.KIP_STYLE_NAMES[style], style + ' has a name');
  });
  await check('appearance keeps the style with the other choices and derives the on/off from it', () => {
    const text = fs.readFileSync(path.join(root, 'static/js/appearance.js'), 'utf8');
    assert.ok(text.includes('value.kip = kipStyleOf(raw);') && text.includes("value.mascot = value.kip !== 'hidden';"), 'normalize derives mascot from the style');
    assert.ok(text.includes('root.dataset.kip = settings.kip;') && text.includes("root.dataset.mascot = settings.mascot ? 'on' : 'off';"), 'the root carries both');
    assert.ok(text.includes("typeof patch.mascot === 'boolean' && !('kip' in patch)"), 'the old updateAppearance({ mascot }) still works');
    const notch = fs.readFileSync(path.join(root, 'static/js/notchShell.js'), 'utf8');
    assert.ok(notch.includes('kipStyleOf(settings)') && !/finish: 'flat'/.test(notch), 'the notch follows the style');
  });
  await check('the Home switcher and the Appearance control share one picker', () => {
    const picker = fs.readFileSync(path.join(root, 'static/js/kipPicker.js'), 'utf8');
    assert.ok(picker.includes("role: 'radiogroup'") && picker.includes("role: 'radio'") && picker.includes('ArrowRight'), 'a keyboard-operable radio group');
    assert.ok(picker.includes('openMobileSheet') && picker.includes("class: 'kip-menu'"), 'a sheet on phones, a popover on desktop');
    assert.ok(picker.includes("'Show Kip'"), 'hidden reads Show Kip');
    assert.match(fs.readFileSync(path.join(root, 'static/js/views/home.js'), 'utf8'), /wireKipSwitch\(heroMascotButton/, 'the hero Kip is the switch');
    assert.match(fs.readFileSync(path.join(root, 'static/js/views/appearancePanel.js'), 'utf8'), /kipChoices\(\)/, 'Appearance uses the same choices');
    assert.match(fs.readFileSync(path.join(root, 'static/js/redesignHome.js'), 'utf8'), /hm-phone-kip/, 'phone Home has its switch');
  });
  await check('the CLI assets are current', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'build_kip_assets.cjs'), '--check'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  console.log('PASS: ' + passed.join('; '));

  if (process.argv.includes('--no-render')) return;
  const electron = process.env.JARVIS_ELECTRON_BINARY || require('../electron/node_modules/electron');
  const render = spawnSync(electron, [path.join(__dirname, 'mascot-render.cjs')], { stdio: 'inherit', windowsHide: true, timeout: 240000 });
  if (render.status !== 0) { console.error('FAIL: renderer checks'); process.exit(1); }
})().catch(error => { console.error(error.stack || error.message); console.error('Passed before failing: ' + passed.join('; ')); process.exit(1); });
