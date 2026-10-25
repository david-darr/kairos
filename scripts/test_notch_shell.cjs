// Run the real phase-1 controller with a tiny DOM and deterministic clocks.
const assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs');
const elements = new Map();
function element(tag = 'div') {
  const classes = new Set(), attrs = new Map(), events = new Map();
  const node = { tagName: tag, dataset: {}, children: [], style: { setProperty() {} },
    classList: { contains: n => classes.has(n), add: n => classes.add(n), remove: n => classes.delete(n),
      toggle(n, on = !classes.has(n)) { on ? classes.add(n) : classes.delete(n); } },
    append(...nodes) { this.children.push(...nodes); }, prepend(node) { this.children.unshift(node); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(k, v) { attrs.set(k, v); }, getAttribute: k => attrs.get(k), toggleAttribute() {},
    addEventListener: (n, fn) => events.set(n, fn), events, querySelector: () => null,
    getAnimations: () => [], animate: (frames, options) => fades.push(options.duration),
    getContext: () => ({ clearRect() {}, fillRect() {} }),
    getBoundingClientRect: () => ({ left: 180, right: 540, top: 0, bottom: 34 }) };
  Object.defineProperty(node, 'id', { set(value) { elements.set(value, node); }, get() { return [...elements].find(([, value]) => value === node)?.[0]; } });
  return node;
}
const body = element(), root = element(), card = element(), pill = element(), rest = element(), fades = [];
for (const [id, node] of Object.entries({ root, card, pill, rest })) elements.set(id, node);
card.getBoundingClientRect = () => ({ left: 400, right: 646, top: 70, bottom: 300 });
let now = 0, next = 0, reduced = false, activity, stored = {}, storageListener;
const jobs = new Map();
function advance(ms) {
  const end = now + ms;
  while (true) {
    const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    const [id, job] = due; jobs.delete(id); now = job.at; job.fn();
  }
  now = end;
}
const context = { document: { body, documentElement: root, createElement: element, getElementById: id => elements.get(id) },
  window: { addEventListener(name, fn) { if (name === 'storage') storageListener = fn; } },
  localStorage: { getItem: () => JSON.stringify(stored) }, matchMedia: () => ({ matches: reduced }),
  getComputedStyle: () => ({ getPropertyValue: () => 'parchment' }),
  createMascot: () => element('kairos-mascot'), KAIROS_SPEC: {}, BAYER4: Array(16).fill(.5),
  mascotUrl: () => 'data:image/svg+xml,test', avatarSpec: agent => agent,
  collectActivity: () => activity || { need: [], work: [] },
  chatStream: { subscribeAll() {}, connect: () => Promise.resolve(), sync: () => new Promise(() => {}) },
  fetch: () => new Promise(() => {}), setInterval() {}, clearInterval() {},
  setTimeout: (fn, ms) => { jobs.set(++next, { fn, at: now + ms }); return next; }, clearTimeout: id => jobs.delete(id) };
const source = fs.readFileSync(require.resolve('../static/js/notchShell.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace('export function', 'function');
// The real shared wording, in its own scope as in the browser (both modules have a toneOf).
const readings = { Date }; vm.createContext(readings);
vm.runInContext(fs.readFileSync(require.resolve('../static/js/quotaReadings.js'), 'utf8').replace(/^export /gm, '') + '\nthis.api = { shortReading, modelGroups, toSnap };', readings);
Object.assign(context, readings.api);
vm.createContext(context); vm.runInContext(source + '\nthis.make = createNotchShell;', context);
const controller = context.make({ pill, card, bridge: {}, renderRing() {}, hideCard() { card.classList.remove('show'); } });
assert.equal(controller.isExpanded(), false);
controller.pointer(200, 10); advance(80); controller.pointer(200, 10); advance(69);
assert.equal(controller.isExpanded(), false, 'hover waits 150 ms'); advance(1);
assert.equal(controller.isExpanded(), true, 'stationary samples do not restart expansion');
card.classList.add('show'); assert.equal(controller.pointer(500, 120), true, 'usage details stay interactive');
assert.equal(controller.hot(100, 120), false, 'empty transparent space stays click-through');
for (let i = 0; i < 4; i++) { controller.pointer(-1, -1); advance(80); }
assert.equal(controller.isExpanded(), false, 'outside samples do not postpone collapse');
controller.pointer(200, 10); advance(100); controller.pointer(-1, -1); advance(100);
assert.equal(controller.isExpanded(), false, 'leaving cancels pending expansion');
reduced = true; elements.get('notch-shell').events.get('click')();
assert.equal(controller.isExpanded(), true); assert.equal(fades.at(-1), 120, 'reduced motion uses a 120 ms fade');
controller.reset(); assert.equal(controller.isExpanded(), false, 'configuration reset clears expansion');
console.log('PASS: notch hover delay, cancellation, click, repeated samples, hot regions, collapse and reduced-motion fade');

// Every connected model is in the status row; past four, the last place is "+N" listing all.
const text = node => node.textContent ?? '';
const endpoint = (id, name, kind, extra = {}) => ({ id, name, kind, status: 'connected', quota: null, recorded: { today_tokens: 0, week_tokens: 0, total_tokens: 0 }, ...extra });
const claudeQuota = { provider: 'claude', status: 'ok', windows: [{ name: '5-hour', used_percent: 34 }] };
const listed = [
  endpoint('c1', 'Claude Opus', 'claude_cli', { provider: 'claude', quota: claudeQuota }),
  endpoint('c2', 'Claude Sonnet', 'claude_cli', { provider: 'claude', quota: claudeQuota }),
  endpoint('x1', 'Codex', 'codex_cli', { provider: 'codex', quota: { provider: 'codex', status: 'ok', windows: [{ name: 'Weekly', used_percent: 61 }] } }),
  endpoint('g1', 'Antigravity', 'antigravity_cli', { provider: 'antigravity', quota: { provider: 'antigravity', status: 'no_quota', windows: [] }, recorded: { today_tokens: 0, week_tokens: 3400, total_tokens: 3400 } }),
  endpoint('l1', 'qwen3', 'local', { recorded: { today_tokens: 12000, week_tokens: 12000, total_tokens: 12000 } }),
];
const ringsFor = [{ id: 'claude', name: 'Claude', snap: context.toSnap(claudeQuota) }, { id: 'codex', name: 'Codex', snap: context.toSnap(listed[2].quota) }];
controller.readings(ringsFor, context.modelGroups(listed.slice(0, 4)));
const row = elements.get('notch-readings'), collapsed = elements.get('notch-usage');
assert.deepEqual(row.children.map(text), ['Claude 5h 34%', 'Codex wk 61%', 'Antigravity 3.4K tokens this week'], 'one reading per account, Antigravity listed without a quota');
assert.deepEqual(row.children.map(n => n.dataset.p), ['claude', 'codex', 'antigravity']);
assert.equal(collapsed.children.length, 3, 'two rings and a count');
assert.equal(text(collapsed.children[2]), '+1');
controller.readings(ringsFor, context.modelGroups([...listed, endpoint('a1', 'Grok', 'api'), endpoint('a2', 'Mine', 'api')]));
assert.deepEqual(row.children.map(text), ['Claude 5h 34%', 'Codex wk 61%', 'Antigravity 3.4K tokens this week', '+3'], 'the panel keeps to four places');
assert.equal(row.children[3].dataset.p, 'all', '"+N" opens the card listing every model');
assert.equal(text(collapsed.children[2]), '+4', 'collapsed counts the models without a ring');
controller.readings(ringsFor, context.modelGroups([endpoint('l1', 'qwen3', 'local', { recorded: { today_tokens: 12000, week_tokens: 12000, total_tokens: 12000 } }), endpoint('a1', 'Grok', 'api')]));
assert.deepEqual(row.children.map(text), ['qwen3 12K tokens today', 'Grok no usage yet']);
assert.deepEqual(row.children.map(n => n.dataset.p), ['model:l1', 'model:a1']);
console.log('PASS: notch lists every connected model, quota or recorded tokens, and caps the row with "+N"');

body.classList.add('notch-offline'); assert.equal(controller.hot(200, 10), false, 'host loss leaves no hot region');
body.classList.remove('notch-offline');
const collectorSource = fs.readFileSync(require.resolve('../static/js/activityModel.js'), 'utf8').replace('export function', 'function');
const collectorContext = {}; vm.createContext(collectorContext); vm.runInContext(collectorSource + '\nthis.collect = collectActivity;', collectorContext);
const aggregate = collectorContext.collect({ chats: new Map([
  ['running', { title: 'Running', status: 'processing', text: true }],
  ['approval', { title: 'Approval', status: 'processing', permission: true }],
  ['failed', { title: 'Failed', status: 'error' }],
]), remote: { agents: [{ id: 'bot', name: 'Scout', status: 'working' }], inbox: { items: [{ id: 'question', agent_id: 'bot', kind: 'question' }], reviews: [] }, pending: [], devices: [] } });
assert.equal(aggregate.need.length, 3); assert.equal(aggregate.work.length, 2);
assert.equal(aggregate.need.find(item => item.key === 'inbox:question').agent.name, 'Scout');
assert.equal(aggregate.work.find(item => item.kind === 'agent').agent.id, 'bot');
console.log('PASS: shared collector preserves working chats, approvals, failures, agent questions and bot identities');
