// No browser or Electron. Exercise the real timeline and calendar navigation
// against a small DOM, including selected-day anchoring and cross-month moves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attrs = attrs; this.isConnected = true; this.scrollTop = 0;
    this.classes = new Set((attrs.class || '').split(/\s+/));
    this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)),
      contains: x => this.classes.has(x), toggle: (x, on) => { on ? this.classes.add(x) : this.classes.delete(x); } };
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    Object.assign(this, attrs); if (attrs.text !== undefined) this.textContent = attrs.text; this.append(...children);
  }
  append(...nodes) { for (const n of nodes.filter(Boolean)) { if (typeof n === 'object') n.parentElement = this; this.children.push(n); } }
  appendChild(n) { this.append(n); return n; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set innerHTML(value) { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.classes = new Set(v.split(/\s+/)); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  replaceWith(node) { const p = this.parentElement; p.children[p.children.indexOf(this)] = node; node.parentElement = p; }
  addEventListener(k, fn) { this['on' + k] = fn; }
  insertAdjacentHTML() {}
  querySelectorAll(selector) { return descendants(this).filter(n => selector.startsWith('.') ? n.classes.has(selector.slice(1)) : n.tag === selector); }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
}
const descendants = n => n.children.flatMap(c => typeof c === 'object' ? [c, ...descendants(c)] : []);
const el = (...args) => new Node(...args);
let segments, requests = [], redesign = true;
const context = vm.createContext({ console, Date, Intl, URL, Set, Map, Promise, Math, String, Number,
  document: { createElement: tag => el(tag), documentElement: { dataset: { mascot: 'on' }, classList: { contains: () => redesign } }, body: new Node('body') },
  window: { matchMedia: () => ({ matches: true }) },
  MutationObserver: class { observe() {} disconnect() {} }, setInterval: () => 0, clearInterval() {},
});
const cache = new Map();
const mocks = {
  'api.js': { el, api: async url => { requests.push(url); return []; }, iconButton: () => el('button'), openPanelDialog() {}, toast() {} },
  'mobileSheet.js': { mountSheetSurface() {} }, 'calendarRepeat.js': { repeatControls() {} },
  'mascot.js': { createMascot: ({ state, size }) => el('kairos-mascot', { state, size }) },
  'workspaceParts.js': { redesignOn: () => redesign, workspaceEmpty: () => el('section') },
  'kairosParts.js': { segmented: options => { segments = options; return el('div'); }, dotMatrix: options => options },
  'icons.js': { ICONS: { calendar: '' } },
};
async function moduleAt(file) {
  const full = path.resolve(file);
  if (cache.has(full)) return cache.get(full);
  const module = new vm.SourceTextModule(fs.readFileSync(full, 'utf8'), { context, identifier: full });
  cache.set(full, module);
  await module.link(async (specifier, parent) => {
    const base = path.basename(specifier);
    if (mocks[base]) {
      const values = mocks[base];
      return new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, { context });
    }
    return moduleAt(path.resolve(path.dirname(parent.identifier), specifier));
  });
  await module.evaluate(); return module;
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
(async () => {
  const shared = (await moduleAt('static/js/kairosParts.js')).namespace;
  mocks['kairosParts.js'].segmented = options => { segments = options; return shared.segmented(options); };
  const google = (await moduleAt('static/js/googleCalendar.js')).namespace;
  const start = new Date(2026, 9, 23), grid = el('div');
  const events = [{ source: 'calendar', title: 'Review', start: new Date(2026, 9, 23, 9).toISOString(), end: new Date(2026, 9, 23, 10).toISOString() }];
  google.weekGrid(grid, start, events, () => {}, () => {}, 1);
  assert.equal(grid.querySelectorAll('.cal-week-day').length, 1);
  assert.equal(grid.querySelectorAll('.cal-week-event').length, 1);
  assert.equal(grid.children[0].style.gridTemplateColumns, '52px repeat(1, minmax(0, 1fr))');
  google.weekGrid(grid, start, events, () => {}, () => {});
  assert.equal(grid.querySelectorAll('.cal-week-day').length, 7);
  const trip = { source: 'google', all_day: true, start: '2026-10-23', end: '2026-10-25' };
  assert.equal(google.itemsOnDay([trip], new Date(2026, 9, 24)).length, 1);
  assert.equal(google.itemsOnDay([trip], new Date(2026, 9, 25)).length, 0);

  const calendar = (await moduleAt('static/js/views/calendar.js')).namespace;
  const host = el('div'); await calendar.render(host);
  assert.deepEqual(Array.from(segments.options, x => x.value), ['day', 'week', 'month']);
  const rangeButtons = host.querySelector('.cal-range-switch').querySelectorAll('button');
  assert.deepEqual(rangeButtons.map(b => b.dataset.mobileDock), ['day', 'week', 'month']);
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  rangeButtons[0].onclick(); await flush();
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-checked')), ['true', 'false', 'false']);
  let timeline = host.querySelector('.cal-grid');
  assert.equal(timeline.querySelectorAll('.cal-week-day').length, 1);
  const nav = host.querySelector('.cal-nav');
  const period = host.querySelector('.cal-month-label').textContent;
  nav.children[3].onclick(); await flush();
  assert.notEqual(host.querySelector('.cal-month-label').textContent, period);
  segments.onChange('month'); await flush(); segments.onChange('day'); await flush();
  // Switching back to Day stays within the chosen month, with a one-day range.
  const range = new URL(requests.filter(u => u.startsWith('/api/calendar/events?')).at(-1), 'http://test');
  assert.equal((new Date(range.searchParams.get('end')) - new Date(range.searchParams.get('start'))) / 3600000, 24);
  segments.onChange('month'); await flush();
  const selected = timeline.querySelectorAll('.cal-day')[24]; selected.onclick();
  const selectedDate = new Date(selected.attrs['aria-label']);
  segments.onChange('day'); await flush();
  const selectedRange = new URL(requests.filter(u => u.startsWith('/api/calendar/events?')).at(-1), 'http://test');
  assert.equal(new Date(selectedRange.searchParams.get('start')).toDateString(), selectedDate.toDateString());

  const activity = (await moduleAt('static/js/taskActivity.js')).namespace;
  const now = new Date(2026, 10, 3, 12), recent = new Date(2026, 10, 1, 10).getTime() / 1000;
  const result = activity.activityBins([{ started_at: recent, outcome: 'succeeded' }, { ran_at: recent, outcome: 'failed' },
    { started_at: new Date(2025, 0, 1).getTime() / 1000, outcome: 'succeeded' }, { outcome: 'failed' }], 'week', now);
  assert.equal(result.count, 2); assert.equal(result.done, 1); assert.equal(result.cells.length, 168);
  assert.equal(result.cells.filter(c => c === 'b').length, 1);
  assert.equal(activity.activityBins([], 'month', now).cells.every(c => c === 'empty'), true);
  redesign = false;
  const classicHost = el('div'); await calendar.render(classicHost);
  assert.equal(classicHost.querySelector('.cal-view-switch').children.length, 2);
  assert.equal(classicHost.querySelectorAll('.cal-day').length, 42);
  assert.equal(classicHost.querySelector('.cal-single-day'), undefined);

  // Exercise the real API helper and adapter, including both caller contracts.
  mocks['api.js'] = (await moduleAt('static/js/api.js')).namespace;
  const { workspaceEmpty } = (await moduleAt('static/js/workspaceParts.js')).namespace;
  for (const look of [true, false]) for (const mascot of ['on', 'off']) {
    redesign = look; context.document.documentElement.dataset.mascot = mascot;
    let actions = 0;
    for (const options of [
      { icon: '<svg></svg>', title: 'Tasks', hint: 'Nothing scheduled', mascot: 'sleeping', actionLabel: 'Schedule', onAction: () => actions++ },
      { title: 'Models', text: 'Choose a model', mascotState: 'idle', action: { text: 'Browse', onClick: () => actions++ } },
    ]) {
      const empty = workspaceEmpty(options), host = empty.querySelector('.empty-state-mascot');
      assert.ok(empty.classList.contains('empty-state-rich'));
      assert.equal(host.children[0].tag, 'kairos-mascot');
      assert.equal(host.children[0].getAttribute('state'), options.mascot || options.mascotState);
      assert.equal(empty.querySelector('.empty-state-title').tag, look ? 'h2' : 'div');
      assert.equal(empty.querySelector('.empty-state-hint').textContent, options.hint || options.text);
      assert.equal(empty.classList.contains('rd-empty-state'), look);
      empty.querySelector('button').onclick();
      if (options.icon) assert.ok(empty.querySelector('.empty-state-icon'));
    }
    assert.equal(actions, 2);
    assert.equal(workspaceEmpty({ title: 'Documents' }).querySelector('.empty-state-mascot').children[0].getAttribute('state'), 'idle');
    assert.equal(workspaceEmpty({ title: 'Plain', mascot: null }).querySelector('.empty-state-mascot'), undefined);
  }
  console.log('Workspace tabs: timeline, dock hooks, navigation, empty-state contracts, all-day boundaries and recorded activity passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
