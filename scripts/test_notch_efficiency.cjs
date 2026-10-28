// Idle cost of the desktop notch (A15 benchmark): requests per minute the real shell and
// quota page make while nothing happens, and the native cursor tick. Plain Node, simulated clock.
// Run: node scripts/test_notch_efficiency.cjs
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const strip = file => fs.readFileSync(require.resolve('../static/js/' + file), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
let live = true, now = 0, next = 0; const jobs = new Map(), counts = {};
function advance(ms) {
  const end = now + ms;
  for (;;) {
    const due = [...jobs].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, job] = due; now = job.at;
    if (job.every) job.at += job.every; else jobs.delete(id);
    job.fn();
  }
  now = end;
}
const settle = () => new Promise(r => setImmediate(r));
async function run(ms) { for (let t = 0; t < ms; t += 1000) { advance(1000); await settle(); await settle(); } }
function element(tag = 'div') {
  const attrs = new Map();
  return { tagName: tag, dataset: {}, children: [], style: { setProperty() {} }, id: '',
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    append() {}, prepend() {}, remove() {}, replaceChildren() {}, set innerHTML(v) {},
    setAttribute(k, v) { attrs.set(k, v); }, getAttribute: k => attrs.get(k), toggleAttribute() {},
    addEventListener() {}, querySelector: () => null, getAnimations: () => [], animate: () => ({ finished: Promise.resolve() }),
    getContext: () => ({ clearRect() {}, fillRect() {} }), getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 30 }) };
}
const body = element(), root = element(), byId = new Map();
const doc = { body, documentElement: root, createElement: element, createElementNS: (n, t) => element(t),
  getElementById: id => byId.get(id) || (byId.set(id, element()), byId.get(id)), dispatchEvent() {}, addEventListener() {} };
// Routes a signed-in admin can read answer 200 with empty data, as an idle install does.
const fetchStub = async (url) => {
  const key = String(url).split('?')[0]; counts[key] = (counts[key] || 0) + 1;
  const data = key === '/api/auth/status' ? { username: 'david', is_admin: true } : key === '/api/triggers' ? { pending: [] }
    : key === '/api/notifications' ? { devices: [] } : key === '/api/agents/inbox' ? { items: [], reviews: [] } : [];
  return { ok: true, status: 200, json: async () => data };
};
const clock = Date;
class FakeDate extends clock { static now() { return 1.7e12 + now; } constructor(...a) { super(...(a.length ? a : [1.7e12 + now])); } }
const context = { document: doc, CustomEvent: class {}, Date: FakeDate,
  Math, Set, Map, encodeURIComponent, innerHeight: 800, innerWidth: 1280, fetch: fetchStub,
  createGlow: () => ({ set() {} }), createTakeover: () => ({ panel: null, show: () => null, revealed() {} }),
  watchDrags: () => ({ dragging: false }), dropPanel: () => null, createComposer: () => ({ open: false, want: () => null, folderWant: () => null, openComposer() {} }),
  kipStyleOf: () => 'halftone', window: { addEventListener() {} }, localStorage: { getItem: () => '{}' }, matchMedia: () => ({ matches: false }),
  getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }), createMascot: () => element('kairos-mascot'), KAIROS_SPEC: {}, BAYER4: Array(16).fill(.5),
  mascotUrl: () => 'data:,', avatarSpec: a => a, collectActivity: () => ({ need: [], work: [] }),
  chatStream: { live: () => live, subscribeAll() {}, connect: () => Promise.resolve(), sync: () => fetchStub('/api/chat/live/snapshot') },
  setInterval: (fn, ms) => { const id = ++next; jobs.set(id, { fn, at: now + ms, every: ms }); return id; }, clearInterval: id => jobs.delete(id),
  setTimeout: (fn, ms) => { const id = ++next; jobs.set(id, { fn, at: now + ms }); return id; }, clearTimeout: id => jobs.delete(id) };
function load(file, globals, names) {
  const scope = vm.createContext({ document: doc, Date: FakeDate, Math, Set, Map, fetch: fetchStub, encodeURIComponent, innerHeight: 800, innerWidth: 1280, ...globals });
  vm.runInContext(strip(file) + `\nthis.api = { ${names} };`, scope); return scope.api;
}
const icons = load('notchIcons.js', {}, 'ICONS');
const marks = load('notchModelMarks.js', {}, 'logoKeyOf, initialOf, modelLogo, logoRing');
const quiet = load('notchQuiet.js', { ...icons, ...marks }, 'layoutFor, workingAgents, createQuietView, createQuietData, quickActions, upNextTile, nextEvent');
const side = load('notchSide.js', { ...icons, ...quiet }, 'createSideNotch, isSideEdge, sideCardAt, sideTop');
Object.assign(context, icons, marks, quiet, side);
const readings = { Date: FakeDate }; vm.createContext(readings);
vm.runInContext(fs.readFileSync(require.resolve('../static/js/quotaReadings.js'), 'utf8').replace(/^export /gm, '') + '\nthis.api = { shortReading, modelGroups, toSnap, PROVIDERS, SIGN_IN };', readings);
Object.assign(context, readings.api);
const steps = {}; vm.createContext(steps);
vm.runInContext(fs.readFileSync(require.resolve('../static/js/notchSteps.js'), 'utf8').replace(/^export /gm, '') + '\nthis.api = { chatRows, taskRows };', steps);
Object.assign(context, steps.api);
vm.createContext(context); vm.runInContext(strip('notchShell.js') + '\nthis.make = createNotchShell;', context);

(async () => {
  context.make({ card: element(), bridge: {}, renderReadings() {}, hideCard() {} });
  await run(1000);
  const first = { ...counts };
  console.log('FIRST LOAD requests:', JSON.stringify(first));
  for (const k of Object.keys(counts)) delete counts[k];
  const minutes = 10; await run(minutes * 60000);
  const total = Object.values(counts).reduce((a, b) => a + b, 0), perMin = total / minutes;
  const per = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, +(v / minutes).toFixed(1)]));
  console.log('IDLE shell requests/min by route:', JSON.stringify(per), 'total', perMin.toFixed(1));
  assert.ok(perMin <= 8, `idle shell makes ${perMin} requests a minute (target <= 8)`);
  assert.equal(first['/api/auth/status'], 1, 'first load reads /api/auth/status once (shell identity reused by the quiet data)');
  for (const route of ['/api/sessions', '/api/notes', '/api/calendar/events']) assert.ok((per[route] || 0) === 0, `${route} is not read while the notch stays collapsed`);
  assert.ok((per['/api/auth/status'] || 0) === 0, `/api/auth/status is read ${per['/api/auth/status']}x a minute; identity is already known`);
  console.log('PASS: idle shell stays within its request budget');
  // While the live feed is down the shell falls back to 15 s polling to notice the host and recover.
  live = false; for (const k of Object.keys(counts)) delete counts[k];
  await run(60000);
  const down = (counts['/api/agents'] || 0);
  assert.ok(down >= 3 && down <= 5, `disconnected shell polls /api/agents ${down}x a minute (want 4)`);
  console.log('PASS: disconnected shell polls every 15 s:', down, '/api/agents reads in a minute');
  live = true;

  // The quota page's own timers.
  const page = fs.readFileSync(require.resolve('../static/js/usage-overlay.js'), 'utf8');
  const timers = [...page.matchAll(/setInterval\([^;]*?,\s*([\d_]+)\)/g)].map(m => Number(m[1].replace(/_/g, '')));
  console.log('usage-overlay.js intervals (ms):', timers.join(', '), '=> quota reads/min', 60000 / Math.min(...timers));

  // Native cursor tick while visible: one cursor read and one IPC send per tick.
  const { trackOverlay } = require('../electron/usage-overlay-tracking');
  let sent = 0, tick;
  const bounds = { x: 0, y: 0, width: 860, height: 300 };
  const handlers = {};
  const win = { isDestroyed: () => false, isVisible: () => true, getContentBounds: () => bounds, getBounds: () => bounds, setBounds() {},
    on: (n, f) => { handlers[n] = f; }, webContents: { getZoomFactor: () => 1, send: () => { sent++; }, on() {} } };
  trackOverlay(win, { getCursorScreenPoint: () => ({ x: 5, y: 5 }) }, () => bounds, { now: () => now, setInterval: (fn, ms) => { tick = { fn, ms }; return 1; }, clearInterval() {} });
  handlers.show();
  const base = sent; for (let i = 0; i < 750; i++) { now += 80; tick.fn(); }
  console.log(`native tracker: ${tick.ms} ms tick = ${Math.round(60000 / tick.ms)} ticks/min while visible; IPC sends per 750 stationary ticks: ${sent - base}`);
  assert.ok(sent - base >= 55 && sent - base <= 62, `a still cursor sends ${sent - base} IPC messages a minute (want about 60, the 1 Hz heartbeat)`);
})().catch(e => { console.error(e); process.exitCode = 1; });
