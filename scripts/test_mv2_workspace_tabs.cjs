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
  prepend(...nodes) { for (const n of nodes.filter(Boolean)) n.parentElement = this; this.children.unshift(...nodes.filter(Boolean)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set innerHTML(value) { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.classes = new Set(v.split(/\s+/)); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  replaceWith(node) { const p = this.parentElement; p.children[p.children.indexOf(this)] = node; node.parentElement = p; }
  addEventListener(k, fn) { this['on' + k] = fn; }
  click() { return this.onclick?.({ currentTarget: this }); }
  insertAdjacentHTML() {}
  querySelectorAll(selector) { return descendants(this).filter(n => selector.startsWith('.') ? n.classes.has(selector.slice(1)) : n.tag === selector); }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
}
const descendants = n => n.children.flatMap(c => typeof c === 'object' ? [c, ...descendants(c)] : []);
const el = (...args) => new Node(...args);
let segments, requests = [], redesign = true, phone = true, responses = {};
const context = vm.createContext({ console, Date, Intl, URL, Set, Map, Promise, Math, String, Number,
  document: { createElement: tag => el(tag), documentElement: { dataset: { mascot: 'on' }, classList: { contains: () => redesign } }, body: new Node('body') },
  window: { matchMedia: () => ({ matches: phone }) },
  MutationObserver: class { observe() {} disconnect() {} }, setInterval: () => 0, clearInterval() {},
});
const cache = new Map();
const mocks = {
  'api.js': { el, modelMark: () => el('span'), api: async url => { requests.push(url); return responses[url] ?? []; }, iconButton: () => el('button'), openPanelDialog() {}, toast() {} },
  'mobileSheet.js': { mountSheetSurface() {} }, 'calendarRepeat.js': { repeatControls() {} },
  'mascot.js': { createMascot: ({ state, size }) => el('kairos-mascot', { state, size }) },
  'workspaceParts.js': { redesignOn: () => redesign, workspaceEmpty: () => el('section'), workspaceConfirm: async () => false },
  'kairosParts.js': { segmented: options => { segments = options; return el('div'); }, dotMatrix: options => options },
  'icons.js': { ICONS: { calendar: '' } },
  'modelSetup.js': { openModelSetup() {} },
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
  assert.equal(grid.querySelector('.cal-week-date').textContent, '23', 'Week numbers have their own today-marker area');
  assert.ok(grid.querySelector('.cal-week-weekday').textContent, 'Weekday stays outside the date marker');
  assert.equal(grid.children[0].style.gridTemplateColumns, '52px repeat(1, minmax(0, 1fr))');
  google.weekGrid(grid, start, events, () => {}, () => {});
  assert.equal(grid.querySelectorAll('.cal-week-day').length, 7);
  const trip = { source: 'google', all_day: true, start: '2026-10-23', end: '2026-10-25' };
  assert.equal(google.itemsOnDay([trip], new Date(2026, 9, 24)).length, 1);
  assert.equal(google.itemsOnDay([trip], new Date(2026, 9, 25)).length, 0);

  const calendar = (await moduleAt('static/js/views/calendar.js')).namespace;
  const host = el('div'); await calendar.render(host);
  const phoneHeader = host.querySelector('.view-header');
  const createBar = host.querySelector('.cal-create-bar');
  assert.equal(createBar.parentElement, phoneHeader, 'Phone Add belongs to the title row');
  assert.equal(phoneHeader.querySelectorAll('button').length, 2, 'Only calendars and Add lead the phone page');
  assert.equal(createBar.querySelector('button').getAttribute('aria-label'), 'Add');
  assert.equal(host.querySelector('.cal-nav').parentElement, phoneHeader.parentElement, 'Period and view controls follow the header');
  assert.equal(host.querySelectorAll('.cal-weekday')[0].textContent, 'Mon');
  assert.equal(host.querySelector('.cal-phone-days').children.length, 7);
  const currentDates = host.querySelector('.cal-phone-days').children.filter(b => b.getAttribute('aria-current') === 'date');
  assert.equal(currentDates.length, 1, 'Only today is marked current, independently of the selected day');
  assert.equal(currentDates[0].getAttribute('aria-label'), new Date().toDateString());
  assert.deepEqual(Array.from(segments.options, x => x.value), ['day', 'week', 'month']);
  const rangeButtons = host.querySelector('.cal-range-switch').querySelectorAll('button');
  assert.deepEqual(rangeButtons.map(b => b.textContent), ['Day', 'Week', 'Month']);
  assert.ok(descendants(host).every(b => !b.dataset.mobileDock && !b.getAttribute('data-mobile-dock')), 'Calendar controls stay in the header, without dock proxies');
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assert.equal(host.querySelectorAll('.cal-day').length, 42);
  rangeButtons[0].onclick(); await flush();
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-checked')), ['true', 'false', 'false']);
  let timeline = host.querySelector('.cal-grid');
  assert.equal(timeline.querySelectorAll('.cal-week-day').length, 1);
  const strip = host.querySelector('.cal-phone-days');
  const pick = strip.children[0];
  const pickedDate = new Date(pick.getAttribute('aria-label'));
  assert.equal(pickedDate.getDay(), 1);
  pick.onclick(); await flush();
  const pickedRange = new URL(requests.filter(u => u.startsWith('/api/calendar/events?')).at(-1), 'http://test');
  assert.equal(new Date(pickedRange.searchParams.get('start')).toDateString(), pickedDate.toDateString());
  assert.equal(host.querySelector('.cal-phone-days').children.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
  const nav = host.querySelector('.cal-nav');
  const period = new URL(requests.filter(u => u.startsWith('/api/calendar/events?')).at(-1), 'http://test');
  nav.children[3].onclick(); await flush();
  const nextPeriod = new URL(requests.filter(u => u.startsWith('/api/calendar/events?')).at(-1), 'http://test');
  assert.equal((new Date(nextPeriod.searchParams.get('start')) - new Date(period.searchParams.get('start'))) / 3600000, 24);
  assert.equal(host.querySelector('.cal-month-label').textContent, new Date(nextPeriod.searchParams.get('start')).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
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

  // Use the real switch buttons, as the shared Google workspace smoke does.
  // Month must return to 42 cells from either timeline, on phone and desktop.
  for (const isPhone of [true, false]) {
    phone = isPhone;
    const monthHost = el('div'); await calendar.render(monthHost);
    assert.equal(monthHost.querySelector('.cal-create-bar').parentElement,
      monthHost.querySelector(isPhone ? '.view-header' : '.cal-left'));
    const buttons = monthHost.querySelector('.cal-nav').querySelectorAll('button');
    for (const mode of ['Day', 'Week']) {
      buttons.find(button => button.textContent === mode).click(); await flush();
      assert.equal(monthHost.querySelectorAll('.cal-day').length, 0);
      const before = requests.length;
      const month = buttons.find(button => button.textContent === 'Month');
      month.click(); await flush();
      assert.ok(requests.slice(before).some(url => url.startsWith('/api/calendar/events?')));
      assert.equal(monthHost.querySelectorAll('.cal-day').length, 42);
      assert.equal(month.getAttribute('aria-pressed'), 'true');
      assert.equal(month.getAttribute('aria-checked'), 'true');
    }
  }
  phone = true;

  const activity = (await moduleAt('static/js/taskActivity.js')).namespace;
  const now = new Date(2026, 10, 3, 12), recent = new Date(2026, 10, 1, 10).getTime() / 1000;
  const result = activity.activityBins([{ started_at: recent, outcome: 'succeeded' }, { ran_at: recent, outcome: 'failed' },
    { started_at: new Date(2025, 0, 1).getTime() / 1000, outcome: 'succeeded' }, { outcome: 'failed' }], 'week', now);
  assert.equal(result.count, 2); assert.equal(result.done, 1); assert.equal(result.cells.length, 168);
  assert.equal(result.cells.filter(c => c === 'b').length, 1);
  assert.equal(activity.activityBins([], 'month', now).cells.every(c => c === 'empty'), true);
  redesign = false;
  const classicHost = el('div'); await calendar.render(classicHost);
  assert.equal(classicHost.querySelectorAll('.cal-weekday')[0].textContent, 'Sun');
  assert.equal(classicHost.querySelector('.cal-view-switch').children.length, 2);
  assert.equal(classicHost.querySelectorAll('.cal-day').length, 42);
  assert.equal(classicHost.querySelector('.cal-single-day'), undefined);

  // Cookbook keeps the actual model names, real endpoint and all model actions.
  redesign = true;
  responses = {
    '/api/cookbook/status': { reachable: true },
    '/api/cookbook/installed': [{ name: 'fixture:small', size: 1000000000 }],
    '/api/cookbook/running': [{ name: 'fixture:small', size: 1000000000 }],
    '/api/cookbook/catalog': [{ name: 'fixture:other', label: 'Other', params: 'small', description: 'Fixture model' }],
    '/api/cookbook/engine/status': { running: true, model: 'fixture.gguf', base_url: 'http://localhost:9123/v1' },
    '/api/cookbook/engine/downloaded': [{ name: 'fixture.gguf', size: 2000000000 }],
    '/api/cookbook/engine/catalog': [],
  };
  const cookbook = (await moduleAt('static/js/views/cookbook.js')).namespace;
  const modelsHost = el('div'); await cookbook.render(modelsHost);
  assert.equal(modelsHost.querySelectorAll('.cookbook-running').length, 1);
  assert.equal(modelsHost.querySelector('.cookbook-running').querySelector('strong').textContent, 'fixture:small');
  assert.deepEqual(modelsHost.querySelector('.cookbook-installed-list').querySelectorAll('button').map(b => b.textContent), ['Use in Chat', 'Delete']);
  const changeEngine = segments.onChange;
  await changeEngine('engine');
  assert.equal(modelsHost.querySelector('.cookbook-status').querySelector('code').textContent, 'http://localhost:9123/v1');
  assert.equal(modelsHost.querySelector('.cookbook-running').querySelector('strong').textContent, 'fixture.gguf');
  assert.deepEqual(modelsHost.querySelector('.cookbook-installed-list').querySelectorAll('button').map(b => b.textContent), ['Running', 'Use in Chat', 'Delete']);
  const stop = modelsHost.querySelector('.cookbook-running').querySelector('button');
  responses['/api/cookbook/engine/status'] = { running: false, model: null, base_url: null };
  await stop.click();
  assert.ok(requests.includes('/api/cookbook/engine/stop'));
  assert.equal(modelsHost.querySelector('.cookbook-installed-list').querySelector('button').textContent, 'Start');
  responses = {};

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
  console.log('Workspace tabs: timeline, dock hooks, navigation, empty-state contracts, all-day boundaries, recorded activity and both local-model engines passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
