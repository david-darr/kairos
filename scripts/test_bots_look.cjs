// Bots mode look foundation (Agents 3.0 Phase 0, unit U2): the plain-Node checks.
// Run: node scripts/test_bots_look.cjs
// Loads botsIcons.js, botsKip.js, botsUi.js and mascot.js straight from disk and
// reads bots.css as text. The contrast and reduced-motion checks are in
// scripts/test_bots_look.py; the rendered checks are scripts/bots-look-checks.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const staticDir = path.join(root, 'static');
const passed = [];
const check = async (name, fn) => { await fn(); passed.push(name); };
const load = file => import(pathToFileURL(path.join(staticDir, file)).href);
const read = file => fs.readFileSync(path.join(staticDir, file), 'utf8');

// OMB's 39 named mascot states (openmausbot-report.md 3.12), written out here so the
// fold table cannot quietly lose one.
const OMB_39 = [
  'sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching', 'working',
  'excited', 'surprised', 'suspicious', 'angry', 'drowsy', 'happy', 'curious', 'confused', 'bored',
  'proud', 'shy', 'sad', 'laughing', 'scared', 'playful', 'celebrate',
  'orbit', 'radar', 'progress',
  'spawning', 'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving', 'uploading',
  'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down',
];

// The --bots-* names the design (phase-0-design.md, 5.1) defines in bots.css.
const TOKENS = [
  '--bots-app', '--bots-panel', '--bots-card', '--bots-menu', '--bots-composer', '--bots-raised',
  '--bots-raised-hover', '--bots-menu-active', '--bots-inset', '--bots-control', '--bots-control-line',
  '--bots-composer-ring', '--bots-hairline', '--bots-hairline-dense',
  '--bots-ink', '--bots-ink-secondary', '--bots-ink-tertiary',
  '--bots-accent', '--bots-accent-text', '--bots-accent-border', '--bots-accent-ink', '--bots-focus',
  '--bots-success', '--bots-success-ink', '--bots-danger', '--bots-danger-ink', '--bots-warning',
  '--bots-bubble-user', '--bots-bubble-user-ink', '--bots-bubble-bot', '--bots-bot-color',
  '--bots-radius-card', '--bots-radius-bubble', '--bots-radius-menu', '--bots-radius-pill',
  '--bots-shadow-float',
  '--bots-ease', '--bots-dur-tap', '--bots-dur-msg', '--bots-dur-pop', '--bots-dur-panel', '--bots-dur-sheet',
  '--bots-text-caps', '--bots-text-hint', '--bots-text-hint-lg', '--bots-text-row', '--bots-text-bubble', '--bots-leading-bubble',
  '--bots-font-sans', '--bots-font-prose', '--bots-font-mono',
  '--bots-row-h', '--bots-menu-row-h', '--bots-panel-w', '--bots-panel-w-advanced', '--bots-sidebar-w', '--bots-sidebar-w-advanced',
].sort();

function botsSources() {
  const files = [];
  for (const dir of ['js', 'js/views']) {
    for (const name of fs.readdirSync(path.join(staticDir, dir))) {
      if (/^bots.*\.js$/.test(name)) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

(async () => {
  const { ICONS, ICON_NAMES, iconSvg } = await load('js/botsIcons.js');
  const M = await load('js/mascot.js');
  const K = await load('js/botsKip.js');

  await check('every icon called in the Bots modules is in botsIcons.js', () => {
    const files = botsSources();
    assert.ok(files.includes('js/botsUi.js') && files.includes('js/botsKip.js'), 'the scan finds the U2 modules');
    const missing = [];
    let calls = 0;
    for (const file of files) {
      const text = read(file);
      // icon('x'), iconSvg('x'), iconName: 'x', iconName = 'x', icons: ['x', ...]
      const patterns = [/\bicon(?:Svg)?\(\s*['"]([a-z0-9-]+)['"]/g, /\biconName\s*[:=]\s*['"]([a-z0-9-]+)['"]/g];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) { calls++; if (!ICONS[match[1]]) missing.push(`${file}: ${match[1]}`); }
      }
    }
    assert.ok(calls >= 2, 'the scan finds calls');
    assert.deepEqual(missing, [], 'icon names missing from botsIcons.js');
  });

  await check('the icon set is the design\'s Phase 0 set and draws in currentColor', () => {
    const set = ['plus', 'x', 'search', 'settings', 'pencil', 'trash-2', 'copy', 'archive', 'archive-restore', 'ellipsis', 'pin', 'folder',
      'folder-plus', 'message-square', 'messages-square', 'zap', 'check', 'circle-alert', 'triangle-alert', 'info', 'eye',
      'sliders-horizontal', 'brain', 'wrench', 'plug', 'calendar-clock', 'shield', 'history', 'gauge', 'bell', 'sparkles', 'upload',
      'image', 'refresh-cw', 'arrow-left', 'arrow-down', 'chevron-down', 'chevron-right', 'chevron-left', 'external-link', 'lock',
      'clock', 'send', 'mic', 'paperclip', 'square', 'undo-2', 'share-2', 'download', 'panel-right'];
    assert.deepEqual([...ICON_NAMES].sort(), [...set].sort());
    for (const name of set) {
      const svg = iconSvg(name);
      assert.ok(svg.startsWith('<svg') && svg.includes('stroke="currentColor"') && svg.includes('viewBox="0 0 24 24"'), name);
      assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(ICONS[name]), `${name} has no colour`);
      assert.ok(/<(path|circle|rect|line|polyline|polygon|ellipse)\b/.test(ICONS[name]), `${name} has drawing data`);
    }
    assert.ok(iconSvg('plus', { size: 20, stroke: 1.75 }).includes('width="20"') && iconSvg('plus', { size: 20, stroke: 1.75 }).includes('stroke-width="1.75"'));
    assert.ok(iconSvg('plus', { label: 'Add' }).includes('aria-label="Add"'));
    assert.ok(iconSvg('plus').includes('aria-hidden="true"'), 'decorative by default');
    assert.throws(() => iconSvg('not-an-icon'), /unknown icon/);
  });

  await check('kipStateFor covers all 39 OMB names with a Kip state or pose', () => {
    assert.equal(OMB_39.length, 39);
    assert.equal(new Set(OMB_39).size, 39);
    assert.deepEqual([...K.OMB_STATES].sort(), [...OMB_39].sort(), 'botsKip lists the same 39');
    for (const name of OMB_39) {
      assert.ok(Object.hasOwn(K.KIP_FOLD, name), `${name} is folded explicitly, not by the idle fallback`);
      assert.ok(M.MASCOT_POSES.includes(K.kipStateFor(name)), `${name} -> ${K.kipStateFor(name)}`);
    }
    const expected = {
      'sleeping': 'sleeping', 'powering-down': 'sleeping', 'waking': 'idle', 'idle': 'idle', 'bored': 'idle', 'shy': 'idle',
      'drowsy': 'idle', 'bouncing': 'idle', 'dragging': 'idle', 'spawning': 'idle', 'listening': 'listening', 'dictating': 'listening',
      'thinking': 'thinking', 'searching': 'thinking', 'working': 'thinking', 'writing': 'thinking', 'loading': 'thinking',
      'orbit': 'thinking', 'radar': 'thinking', 'progress': 'thinking', 'humming': 'speaking', 'excited': 'success', 'happy': 'success',
      'proud': 'success', 'celebrate': 'success', 'laughing': 'success', 'playful': 'success', 'curious': 'needs', 'surprised': 'needs',
      'confused': 'needs', 'notifying': 'needs', 'alerting': 'needs', 'suspicious': 'error', 'angry': 'error', 'scared': 'error',
      'sad': 'error', 'sending': 'carry', 'receiving': 'carry', 'uploading': 'carry',
    };
    assert.deepEqual(Object.fromEntries(OMB_39.map(n => [n, K.kipStateFor(n)])), expected, 'the design table (5.4)');
    assert.equal(K.kipStateFor('no-such-state'), 'idle');
    assert.equal(K.kipStateFor(undefined), 'idle');
    assert.equal(K.kipStateFor('THINKING'), 'thinking');
  });

  await check('stateForBot follows OMB priority: failed tool, working, needs you, off, idle', () => {
    const bot = { id: 'a', enabled: true };
    assert.equal(K.stateForBot(bot, {}), 'idle');
    assert.equal(K.stateForBot(bot), 'idle');
    assert.equal(K.stateForBot(bot, { status: 'idle' }), 'idle');
    assert.equal(K.stateForBot(bot, { status: 'working' }), 'thinking');
    assert.equal(K.stateForBot(bot, { live: true }), 'thinking');
    assert.equal(K.stateForBot(bot, { status: 'needs_you' }), 'needs');
    assert.equal(K.stateForBot({ enabled: false }, { status: 'idle' }), 'sleeping');
    assert.equal(K.stateForBot({ status: 'off' }, {}), 'sleeping');
    assert.equal(K.stateForBot(bot, { status: 'off' }), 'sleeping');
    // Priority: a failed tool beats working, working beats needs-you, needs-you beats off.
    assert.equal(K.stateForBot(bot, { failedTool: true, status: 'working' }), 'error');
    assert.equal(K.stateForBot(bot, { failedTool: true, status: 'needs_you' }), 'error');
    assert.equal(K.stateForBot(bot, { status: 'working', live: true }), 'thinking');
    assert.equal(K.stateForBot({ enabled: false }, { status: 'working' }), 'thinking');
    assert.equal(K.stateForBot({ enabled: false }, { status: 'needs_you' }), 'needs');
    for (const status of ['needs_you', 'working', 'teammate', 'queued', 'idle', 'off', '']) {
      assert.ok(M.MASCOT_STATES.includes(K.stateForBot(bot, { status })), status);
    }
  });

  await check('the beats are the design\'s nine and each has a rule in bots-kip.css', () => {
    assert.deepEqual(K.KIP_BEATS, ['arrive', 'switch', 'customize', 'alert', 'thinking', 'working', 'success', 'celebrate', 'failure']);
    assert.equal(K.KIP_BEAT_MS, 1400);
    const css = read('css/bots-kip.css');
    for (const beat of K.KIP_BEATS) {
      assert.ok(css.includes(`data-beat="${beat}"`), `${beat} rule`);
      assert.ok(css.includes(`@keyframes bots-kip-${beat}`), `${beat} keyframes`);
    }
    assert.ok(!/filter\s*:|drop-shadow|blur\(/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no filters in the beats (the mascot.js rule)');
  });

  await check('bots.css defines exactly the design\'s --bots-* tokens', () => {
    const css = read('css/bots.css');
    const defined = new Set();
    for (const match of css.matchAll(/^\s*(--bots-[\w-]+)\s*:/gm)) defined.add(match[1]);
    assert.deepEqual([...defined].sort(), TOKENS);
    assert.ok(!css.includes('@import'), 'bots.css imports nothing');
    // Every var(--bots-x) used inside bots.css and bots-kip.css names a defined token.
    for (const file of ['css/bots.css', 'css/bots-kip.css']) {
      for (const match of read(file).matchAll(/var\((--bots-[\w-]+)/g)) {
        assert.ok(defined.has(match[1]), `${file} uses ${match[1]}, which bots.css does not define`);
      }
    }
    // The tokens live under Bots mode only.
    for (const selector of css.matchAll(/^(\[data-app-mode[^{]*)\{/gm)) assert.ok(selector[1].includes('data-app-mode="bots"'), selector[1]);
    // Design values (5.1).
    assert.match(css, /--bots-radius-card:\s*14px/);
    assert.match(css, /--bots-radius-bubble:\s*18px/);
    assert.match(css, /--bots-radius-menu:\s*12px/);
    assert.match(css, /--bots-radius-pill:\s*999px/);
    assert.match(css, /--bots-dur-tap:\s*120ms/);
    assert.match(css, /--bots-dur-msg:\s*180ms/);
    assert.match(css, /--bots-dur-pop:\s*200ms/);
    assert.match(css, /--bots-dur-panel:\s*240ms/);
    assert.match(css, /--bots-dur-sheet:\s*350ms/);
    assert.match(css, /--bots-composer-ring:\s*inset 0 0 0 1px rgba\(var\(--ink-rgb\), \.07\)/);
    assert.match(css, /--bots-raised-hover:\s*rgba\(var\(--ink-rgb\), \.06\)/);
    assert.match(css, /--bots-menu-active:\s*rgba\(var\(--ink-rgb\), \.08\)/);
    assert.match(css, /--bots-shadow-float:\s*var\(--popup-shadow\)/);
    assert.match(css, /--bots-text-bubble:\s*15px/);
    assert.match(css, /--bots-leading-bubble:\s*22px/);
  });

  await check('the font stacks put Geist first for the interface, Inter for prose, Geist Mono for code', () => {
    const css = read('css/bots.css');
    assert.match(css, /--bots-font-sans:\s*"Geist",/);
    assert.match(css, /--bots-font-prose:\s*"Inter",/);
    assert.match(css, /--bots-font-mono:\s*"Geist Mono",/);
    assert.match(css, /\[data-bots-font="inter"\]/, 'the all-Inter switch');
  });

  await check('every font url() in the stylesheets is a file on disk, and every font file is used and licensed', () => {
    const urls = [];
    for (const name of fs.readdirSync(path.join(staticDir, 'css'))) {
      if (!name.endsWith('.css')) continue;
      for (const match of read(`css/${name}`).matchAll(/url\(\s*["']?([^"')]+\.woff2?)["']?\s*\)/g)) urls.push(match[1]);
    }
    assert.ok(urls.length >= 5, 'Jost, Cormorant, Geist, Geist Mono and Inter are declared');
    for (const url of urls) {
      assert.ok(url.startsWith('/static/fonts/'), url);
      assert.ok(fs.existsSync(path.join(root, url.slice(1))), `${url} is missing on disk`);
    }
    const onDisk = fs.readdirSync(path.join(staticDir, 'fonts')).filter(f => f.endsWith('.woff2'));
    for (const file of onDisk) assert.ok(urls.includes(`/static/fonts/${file}`), `${file} is not used by any @font-face`);
    const bots = [...read('css/bots.css').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(m => m[1]).sort();
    assert.deepEqual(bots, ['/static/fonts/Geist-Variable.woff2', '/static/fonts/GeistMono-Variable.woff2', '/static/fonts/Inter-Variable.woff2']);
    for (const file of ['Geist-OFL.txt', 'Inter-OFL.txt', 'Jost-OFL.txt', 'CormorantGaramond-OFL.txt']) {
      assert.ok(fs.existsSync(path.join(staticDir, 'fonts', file)), `${file} beside the fonts`);
    }
    for (const file of bots) assert.ok(fs.statSync(path.join(root, file.slice(1))).size > 10000, `${file} is a real font file`);
    // font-display swap on every new face, as the design requires.
    const faces = read('css/bots.css').match(/@font-face\s*\{[^}]*\}/g) || [];
    assert.equal(faces.length, 3);
    for (const face of faces) assert.ok(face.includes('font-display: swap'));
  });

  await check('licence and notice files are in place', () => {
    assert.match(fs.readFileSync(path.join(staticDir, 'vendor/lucide-LICENSE.txt'), 'utf8'), /ISC License/);
    const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    for (const needle of ['## Geist and Geist Mono', 'Geist v1.7.2', '## Inter', 'Inter v4.1', '## Lucide', 'Lucide 1.57.0']) {
      assert.ok(notices.includes(needle), needle);
    }
    assert.ok(read('index.html').includes('<link rel="stylesheet" href="/static/css/bots.css">'), 'index.html links bots.css once');
    assert.equal((read('index.html').match(/bots\.css/g) || []).length, 1);
  });

  await check('botsUi.js: the Simple/Advanced preference persists, defaults to Simple and survives a storage failure', async () => {
    const U = await load('js/botsUi.js');
    const store = new Map();
    global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    U.resetBotsInterfaceForTest();
    assert.equal(U.isAdvanced(), false, 'Simple by default');
    assert.equal(U.setAdvanced(true), true, 'a change is reported');
    assert.equal(U.isAdvanced(), true);
    assert.equal(store.get(U.INTERFACE_KEY), 'advanced');
    assert.equal(U.setAdvanced(true), false, 'no change');
    U.resetBotsInterfaceForTest();
    assert.equal(U.isAdvanced(), true, 'read back from storage');
    U.setAdvanced(false);
    assert.equal(store.get(U.INTERFACE_KEY), 'simple');
    global.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    U.resetBotsInterfaceForTest();
    assert.equal(U.isAdvanced(), false);
    assert.doesNotThrow(() => U.setAdvanced(true));
    assert.equal(U.isAdvanced(), true, 'memory carries it');
    delete global.localStorage;
    assert.equal(U.botColorKey('#D9B260'), 'd9b260');
    assert.equal(U.botColorKey('#123456'), '');
    assert.equal(U.botColorKey(null), '');
    assert.deepEqual(U.BOT_COLOR_KEYS, [...M.AJAR_COLOR_KEYS], 'the six Kip pastels, in mascot.js order');
    for (const name of ['Card', 'NavRow', 'SwitchRow', 'RadioRow', 'TextRow', 'Segmented', 'PageHeader', 'BotSwitch', 'loadBotsCss', 'isAdvanced', 'setAdvanced', 'openMenu', 'Menu', 'MenuRow', 'MenuSeparator', 'MenuLabel', 'MenuNote']) {
      assert.equal(typeof U[name], 'function', name);
    }
  });

  console.log(`PASS: ${passed.length} Bots look checks (${passed.join('; ')})`);
})().catch(error => { console.error(error); process.exit(1); });
