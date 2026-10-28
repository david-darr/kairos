// Headless contract checks for effects. No Electron, backend, or network.
// Run: node scripts/test_background_effects.cjs (re-launches itself with --experimental-vm-modules)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
if (!vm.SourceTextModule) {
  const r = require('node:child_process').spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const root = path.resolve(__dirname, '..');
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...this.listeners.get(type) || []]) fn(); }
}
class Element extends Events {
  constructor(tag = 'div') {
    super();
    this.tag = tag; this.width = 1; this.height = 1; this.clientWidth = 180; this.clientHeight = 100;
    this.dataset = {}; this.style = { setProperty() {}, removeProperty() {} }; this.isConnected = true; this.children = []; this.visible = true;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name),
      toggle(name, force) { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; } };
  }
  setAttribute() {}
  checkVisibility() { return this.visible; }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  append(...nodes) { for (const child of nodes) { child.parent = this; this.children.push(child); } }
  after(node) { if (this.parent) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); } }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  getContext() {
    if (this.ctx) return this.ctx;
    const commands = [], self = this;
    const ctx = { canvas: this, commands, globalAlpha: 1,
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < data.length; i += 4) { data[i] = 80; data[i + 1] = 120; data[i + 2] = 160; data[i + 3] = 255; }
        return { data };
      }, createPattern() { return 'pattern'; }, createRadialGradient() { return { addColorStop() {} }; } };
    for (const name of ['fillText', 'drawImage', 'clearRect', 'fillRect', 'beginPath', 'arc', 'fill', 'save', 'restore', 'rect', 'clip', 'translate', 'scale']) {
      ctx[name] = (...args) => commands.push([name, ...args.map(a => a instanceof Element ? 'canvas' : a), ctx.fillStyle]);
    }
    this.ctx = ctx; return ctx;
  }
}
(async () => {
  const document = new Events(); document.documentElement = new Element(); document.documentElement.dataset.halftone = 'on';
  const created = [];
  document.createElement = tag => { const el = new Element(tag); created.push(el); return el; }; document.hidden = false;
  const window = new Events(); window.devicePixelRatio = 1;
  const reduce = new Events(); reduce.matches = false;
  const rafs = new Map(); let nextFrame = 0;
  const resizeObservers = [], intersectionObservers = [], mutationObservers = [];
  const observer = list => class { constructor(cb) { this.cb = cb; list.push(this); } observe(el) { this.el = el; } disconnect() { this.disconnected = true; } };
  class Image { constructor() { this.naturalWidth = 16; this.naturalHeight = 16; } set src(value) { this.value = value; queueMicrotask(() => this.onload()); } }
  const context = vm.createContext({ document, window, matchMedia: () => reduce, Image, performance, console,
    Path2D: class { rect() {} },
    setTimeout, clearTimeout, Uint8ClampedArray, Float32Array, Uint8Array, Uint32Array,
    requestAnimationFrame: fn => { const id = ++nextFrame; rafs.set(id, fn); return id; },
    cancelAnimationFrame: id => rafs.delete(id),
    ResizeObserver: observer(resizeObservers), IntersectionObserver: observer(intersectionObservers), MutationObserver: observer(mutationObservers),
    getComputedStyle: () => ({ getPropertyValue: name => name === '--accent' ? 'rgb(80, 60, 30)' : 'rgb(243, 234, 219)' }),
  });
  const modules = new Map(); let appearance;
  const appearancePath = path.join(root, 'static/js/appearance.js');
  const appearanceStub = new vm.SyntheticModule(['getAppearance', 'halftonePalette'], function () {
    this.setExport('getAppearance', () => appearance);
    this.setExport('halftonePalette', () => null);
  }, { context, identifier: appearancePath });
  modules.set(appearancePath, appearanceStub);
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context, identifier: file,
      importModuleDynamically: async (specifier, parent) => {
        const child = await load(path.resolve(path.dirname(parent.identifier), specifier));
        if (child.status === 'linked') await child.evaluate();
        return child;
      } });
    modules.set(file, mod);
    await mod.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
    return mod;
  }
  const prefs = await load(path.join(root, 'static/js/backgroundEffectPreferences.js')); await prefs.evaluate();
  const { normalizeEffectOptions, PICTURE_EFFECTS, ART_LOOKS } = prefs.namespace;
  const normalized = normalizeEffectOptions({ ascii: { density: Infinity, motion: 'no', tint: 'bad' }, binary: { density: -1 }, numbers: { density: 100 } });
  assert.equal(normalized.ascii.density, 9); assert.equal(normalized.ascii.motion, true); assert.equal(normalized.ascii.tint, 'theme');
  assert.equal(normalized.binary.density, 3); assert.equal(normalized.numbers.density, 24);
  appearance = { backgroundEffect: 'ascii', effectOptions: normalizeEffectOptions(), mode: 'default', halftone: true };
  const engine = await load(path.join(root, 'static/js/backgroundEffects.js')); await engine.evaluate();
  const dither = await load(path.join(root, 'static/js/dither.js')); await dither.evaluate();
  const a = new Element('canvas'), b = new Element('canvas'), img = new Image();
  dither.namespace.drawDither(a, img, 40, 32, { cell: 4, focusX: .7, focusY: .4, fade: [.86, 1] });
  engine.namespace.drawSceneDither(b, img, 40, 32, { cell: 4, focusX: .7, focusY: .4, fade: [.86, 1] });
  assert.deepEqual(a.ctx.commands, b.ctx.commands, 'Default dither operations must remain identical');
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  const step = now => { const pending = [...rafs.values()]; rafs.clear(); for (const fn of pending) fn(now); };
  const host = new Element(); let ready = 0;
  let dispose = engine.namespace.mountBackgroundEffect(host, '/picture', { onReady: () => ready++ }); await flush();
  assert.equal(ready, 1); assert.equal(rafs.size, 1, 'One loop per surface');
  const target = host.children[0], draws = () => target.ctx.commands.length;
  const atlasCalls = () => created.reduce((sum, el) => sum + (el.ctx?.commands.filter(c => c[0] === 'fillText').length || 0), 0);
  const initialAtlasCalls = atlasCalls();
  const before = draws(); step(100); step(150); assert.ok(draws() > before);
  assert.equal(atlasCalls(), initialAtlasCalls, 'Animation reuses the existing glyph atlas');
  const atlasText = () => target.ctx.commands.filter(c => c[0] === 'fillText').length;
  assert.equal(atlasText(), 0, 'Frames blit glyphs instead of painting text');
  document.hidden = true; document.emit('visibilitychange'); assert.equal(rafs.size, 0);
  const hiddenDraws = draws(); step(200); assert.equal(draws(), hiddenDraws);
  document.hidden = false; document.emit('visibilitychange'); assert.equal(rafs.size, 1);
  reduce.matches = true; reduce.emit('change'); assert.equal(rafs.size, 0);
  reduce.matches = false; reduce.emit('change'); assert.equal(rafs.size, 1);
  appearance.effectOptions.ascii.motion = false; document.emit('kairos:appearance'); await flush(); assert.equal(rafs.size, 0);
  appearance.effectOptions.ascii.motion = true; document.emit('kairos:appearance'); await flush(); assert.equal(rafs.size, 1);
  host.visible = false; mutationObservers.at(-1).cb([]); assert.equal(rafs.size, 0);
  host.visible = true; mutationObservers.at(-1).cb([]); assert.equal(rafs.size, 1);
  intersectionObservers.at(-1).cb([{ isIntersecting: false }]); assert.equal(rafs.size, 0);
  intersectionObservers.at(-1).cb([{ isIntersecting: true }]); assert.equal(rafs.size, 1);
  host.isConnected = false; mutationObservers.at(-1).cb([]); assert.equal(rafs.size, 0); assert.equal(host.children.length, 0);
  dispose();
  for (const effect of PICTURE_EFFECTS) {
    appearance.backgroundEffect = effect;
    const surface = new Element(); surface.clientWidth = 4000; surface.clientHeight = 2400;
    dispose = engine.namespace.mountBackgroundEffect(surface, '/picture'); await flush();
    assert.equal(surface.children[0].dataset.effect, effect, `${effect} renders`);
    if (['ascii', 'numbers', 'binary', 'halftone'].includes(effect)) assert.ok(Number(surface.children[0].dataset.cells) <= 20000);
    dispose(); assert.equal(rafs.size, 0);
  }
  // Animated art (David, 2026-10-28): every vendored ASCII Magic piece is in the generated
  // catalogue under a known category, declares its own slug, and draws whole frames of its size.
  // The player that shows them unchanged is ASCII Magic's own (covered in Electron, appearance-checks).
  const catalog = await load(path.join(root, 'static/js/artCatalog.js')); await catalog.evaluate();
  const { ART_CATALOG, ART_CATEGORIES } = catalog.namespace;
  const vendored = fs.readdirSync(path.join(root, 'static/vendor/ascii-magic/pieces')).map(name => name.replace(/\.js$/, '')).sort();
  // Array.from: the catalogue's arrays belong to the sandbox's realm, which strict equality compares.
  assert.deepEqual(Array.from(ART_CATALOG, ([slug]) => slug).sort(), vendored, 'The catalogue lists exactly the vendored pieces');
  assert.ok(ART_CATALOG.length > 700, 'The full library is vendored');
  for (const slug of ['aurora-cabin-snowfall', 'fuji-dawn-lake', 'balloon-valley-sunrise']) assert.ok(vendored.includes(slug), `${slug} is available`);
  for (const slug of ['ocean-sunset', 'starry-ridge']) assert.ok(!vendored.includes(slug), `${slug} (Unsplash licence) is not shipped`);
  assert.ok(ART_CATALOG.every(([, , category]) => ART_CATEGORIES.some(([id]) => id === category)));
  assert.deepEqual(Array.from(ART_LOOKS, ([id]) => id), ['original', 'dots', 'ascii', 'dither', 'blocks']);
  for (const [slug] of ART_CATALOG) {
    const mod = await load(path.join(root, 'static/vendor/ascii-magic/pieces', slug + '.js')); if (mod.status === 'linked') await mod.evaluate();
    const { meta } = mod.namespace;
    assert.equal(meta.slug, slug);
    const frame = mod.namespace.default()(1.5), text = typeof frame === 'string' ? frame : frame.text;
    const lines = text.split('\n'); assert.equal(lines.length, meta.rows, `${slug} frame rows`);
    assert.ok(lines.every(line => [...line].length === meta.cols), `${slug} frame columns`);
  }
  const dissolve = dither.namespace.dissolveCells(new Element('canvas').getContext('2d'), 4, 700);
  assert.equal(rafs.size, 1); document.hidden = true; document.emit('visibilitychange');
  await dissolve; assert.equal(rafs.size, 0, 'Dither transition cancels immediately when minimized'); document.hidden = false;
  assert.ok([...document.listeners.values()].every(set => set.size === 0), 'All engine listeners released');
  // Exercise the real store across users, malformed saved data, and reset.
  const saved = new Map();
  context.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  context.structuredClone = structuredClone; context.Blob = Blob;
  context.innerWidth = 1440; context.innerHeight = 900;
  context.CustomEvent = class { constructor(type) { this.type = type; } };
  document.dispatchEvent = event => document.emit(event.type);
  document.getElementById = () => null; document.body = new Element();
  context.indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { close() {}, transaction() {
        const tx = { objectStore: () => ({ get: () => ({}), delete: () => ({}), put: () => ({}) }) };
        queueMicrotask(() => tx.oncomplete()); return tx;
      } };
      request.onsuccess();
    }); return request;
  } };
  modules.delete(appearancePath);
  const realAppearance = await load(appearancePath); await realAppearance.evaluate();
  const api = realAppearance.namespace;
  // Both account and signed-out legacy settings migrate without losing controls.
  saved.set('jarvis:welcome-appearance:v1', JSON.stringify({ classic: true, mode: 'color', color: '#233447', halftone: false }));
  api.restoreWelcomeAppearance();
  assert.ok(document.documentElement.classList.contains('kairos-redesign'));
  assert.equal(api.getAppearance().color, '#233447');
  assert.equal(api.getAppearance().halftone, false);
  assert.ok(!('classic' in JSON.parse(saved.get('jarvis:welcome-appearance:v1'))));
  saved.set('jarvis:appearance:v1:legacy', JSON.stringify({ classic: true, redesign: false, mode: 'color', color: '#233447', chatStyle: 'terminal', motion: false, mascot: false }));
  await api.initAppearance('legacy');
  assert.ok(document.documentElement.classList.contains('kairos-redesign'));
  for (const value of [api.getAppearance(), JSON.parse(saved.get('jarvis:appearance:v1:legacy'))]) {
    assert.ok(!('classic' in value) && !('redesign' in value));
    assert.equal(value.color, '#233447'); assert.equal(value.chatStyle, 'terminal');
    assert.equal(value.motion, false); assert.equal(value.mascot, false);
  }
  await api.resetAppearance();
  assert.ok(document.documentElement.classList.contains('kairos-redesign'));
  assert.equal(api.getAppearance().mode, 'default');
  assert.equal(api.getAppearance().mascot, true);
  await api.initAppearance('one');
  api.updateAppearance({ backgroundEffect: 'binary', animatedPiece: 'snowfall',
    effectOptions: { ...api.getAppearance().effectOptions, binary: { density: 13, motion: false, tint: 'picture' } } });
  assert.equal(JSON.parse(saved.get('jarvis:appearance:v1:one')).backgroundEffect, 'binary');
  assert.equal(JSON.parse(saved.get('jarvis:welcome-appearance:v1')).effectOptions.binary.density, 13);
  await api.initAppearance('two'); assert.equal(api.getAppearance().backgroundEffect, 'dithered');
  await api.initAppearance('one'); assert.equal(api.getAppearance().effectOptions.binary.motion, false);
  assert.equal(api.getAppearance().animatedPiece, 'snowfall');
  // Desktop redesign: the animated art's Look and Chat messages persist, and bad values fall back.
  api.updateAppearance({ artLook: 'blocks', chatMessages: 'cards' });
  assert.equal(api.getAppearance().artLook, 'blocks'); assert.equal(api.getAppearance().chatMessages, 'cards');
  assert.equal(document.documentElement.dataset.chatMessages, 'cards');
  api.updateAppearance({ artLook: 'sparkles', chatMessages: 'bubbles' });
  assert.equal(api.getAppearance().artLook, 'original', 'an unknown look falls back to the piece as made');
  assert.equal(api.getAppearance().chatMessages, 'plain', 'an unknown message style falls back to Plain');
  await api.resetAppearance(); assert.equal(api.getAppearance().backgroundEffect, 'dithered');
  assert.equal(api.getAppearance().effectOptions.binary.density, 9);
  saved.set('jarvis:appearance:v1:broken', 'null'); await api.initAppearance('broken');
  assert.equal(api.getAppearance().backgroundEffect, 'dithered');
  api.updateAppearance({ backgroundEffect: 'unknown', animatedPiece: '../not-allowed', effectOptions: [] });
  assert.equal(api.getAppearance().backgroundEffect, 'dithered'); assert.equal(api.getAppearance().animatedPiece, 'aurora-cabin-snowfall');
  api.updateAppearance({ animatedPiece: 'scatter' }); assert.equal(api.getAppearance().animatedPiece, 'aurora-cabin-snowfall', 'Scatter is gone; the default piece stands in');
  // Animated is a background style of its own (David, 2026-10-28): the old effect moves to it, and
  // the theme takes a deep shade of the piece's own background as its base.
  api.updateAppearance({ mode: 'default', backgroundEffect: 'animated', animatedPiece: 'sleepy-moon' });
  assert.deepEqual([api.getAppearance().mode, api.getAppearance().backgroundEffect], ['animated', 'dithered']);
  await flush();
  const base = api.getAppearance().artBase.slice(1).match(/../g).map(v => parseInt(v, 16));
  assert.ok(api.getAppearance().artBase !== '#15171d' && base[2] > base[0], 'The base comes from the piece: a deep blue for the night sky');
  api.updateAppearance({ artBase: 'red', artAccent: 'javascript:', artPanels: 7 });
  assert.deepEqual([api.getAppearance().artBase, api.getAppearance().artAccent, api.getAppearance().artPanels], ['#15171d', '', 1], 'Bad colours fall back to the default base');
  await api.resetAppearance(); assert.equal(api.getAppearance().mode, 'default');
  console.log('Passed: per-user persistence, welcome snapshot, reset, malformed preferences, Animated migration and art colours.');
  console.log('Passed: normalization, exact legacy dither operations, five renderers, 20k cell cap, the full art catalogue and its frames, one loop, hidden/offscreen/reduced-motion/detached cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
