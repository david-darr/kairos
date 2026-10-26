// No browser or Electron. Exercise the real timeline and calendar navigation
// against a small DOM, including selected-day anchoring and cross-month moves.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// The real modules load through vm.SourceTextModule, which needs this flag; relaunch with it when run plainly.
if (!vm.SourceTextModule) {
  const run = require('node:child_process').spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}
const path = require('node:path');

class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.children = []; this.dataset = {}; this.attrs = attrs; this.isConnected = true; this.scrollTop = 0; this.value = ''; this.checked = false;
    this.classes = new Set((attrs.class || '').split(/\s+/));
    this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)),
      contains: x => this.classes.has(x), toggle: (x, on) => { on ? this.classes.add(x) : this.classes.delete(x); } };
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    Object.assign(this, attrs); if (attrs.text !== undefined) this.textContent = attrs.text; this.append(...children);
  }
  remove() { if (this.parentElement) { const siblings = this.parentElement.children; if (siblings.includes(this)) siblings.splice(siblings.indexOf(this), 1); this.parentElement = null; } }
  append(...nodes) { for (const n of nodes.filter(Boolean)) { if (typeof n === 'object') { n.remove(); n.parentElement = this; } this.children.push(n); } }
  get firstElementChild() { return this.children.find(n => typeof n === 'object'); }
  appendChild(n) { this.append(n); return n; }
  prepend(...nodes) { for (const n of nodes.filter(Boolean)) n.parentElement = this; this.children.unshift(...nodes.filter(Boolean)); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  set innerHTML(value) { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'class') this.classes = new Set(v.split(/\s+/)); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  replaceWith(node) { const p = this.parentElement; p.children[p.children.indexOf(this)] = node; node.parentElement = p; }
  before(node) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 0, node); node.parentElement = p; }
  addEventListener(k, fn) { this['on' + k] = fn; }
  focus() {}
  click() { return this.onclick?.({ currentTarget: this }); }
  insertAdjacentHTML() {}
  querySelectorAll(selector) { return descendants(this).filter(n => selector.startsWith('.') ? n.classes.has(selector.slice(1)) : n.tag === selector); }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
}
const descendants = n => n.children.flatMap(c => typeof c === 'object' ? [c, ...descendants(c)] : []);
const el = (...args) => new Node(...args);
let segments, requests = [], sent = [], redesign = true, phone = true, responses = {}, sheetOptions;
const context = vm.createContext({ console, Date, Intl, URL, Set, Map, Promise, Math, String, Number,
  document: { createElement: tag => el(tag), createComment: () => el('#comment'), documentElement: { dataset: { mascot: 'on' }, classList: { contains: () => redesign } }, body: new Node('body'), addEventListener() {}, removeEventListener() {} },
  window: { matchMedia: () => ({ matches: phone }) },
  MutationObserver: class { observe() {} disconnect() {} }, setInterval: () => 0, clearInterval() {},
});
const cache = new Map();
const mocks = {
  'api.js': { el, modelMark: () => el('span'), api: async (url, options) => { requests.push(url); sent.push({ url, options }); return typeof responses === 'function' ? responses(url, options) : responses[url] ?? []; }, iconButton: () => el('button'), openPanelDialog() {}, toast() {} },
  'mobileSheet.js': { mountSheetSurface(panel) { panel.prepend(el('button', { class: 'ms-sheet-grabber' })); return () => {}; }, openMobileSheet(options) {
    sheetOptions = options;
    let closed = false;
    return { close() { if (!closed) { closed = true; options.onClose(); } } };
  } }, 'calendarRepeat.js': { repeatControls() {} },
  'mascot.js': { createMascot: ({ state, size }) => el('kairos-mascot', { state, size }) },
  'workspaceParts.js': { redesignOn: () => redesign, workspaceEmpty: ({ title, hint, actionLabel, onAction }) => el('section', { class: 'empty-state' }, [el('h2', { class: 'empty-state-title', text: title }), el('p', { class: 'empty-state-hint', text: hint }), el('button', { text: actionLabel, onclick: onAction })]), workspaceConfirm: async () => false },
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
function assertMonth(host) {
  const cells = host.querySelectorAll('.cal-day');
  const dates = cells.map(c => new Date(c.getAttribute('aria-label'))).filter(d => !isNaN(d));
  const month = dates.find(d => d.getDate() === 1);
  const offset = (month.getDay() + 6) % 7;
  const expected = Math.ceil((offset + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
  assert.equal(cells.length, expected, 'Month uses precisely the weeks it needs');
  if (phone) for (const cell of cells.filter(c => c.classList.contains('other-month'))) {
    assert.equal(cell.children.length, 0, 'Outside-month cells stay blank');
    assert.equal(cell.disabled, true);
  }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
(async () => {
  const shared = (await moduleAt('static/js/kairosParts.js')).namespace;
  mocks['kairosParts.js'].segmented = options => { segments = options; return shared.segmented(options); };
  mocks['calendarRepeat.js'].repeatControls = (await moduleAt('static/js/calendarRepeat.js')).namespace.repeatControls;
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

  const accounts = el('div');
  responses = {
    '/api/auth/status': { is_admin: true },
    '/api/google/status': { connected: true, calendar_connected: true, email: 'owner@example.com', calendar_ids: ['work'] },
    '/api/google/calendar/calendars': [
      { id: 'work', name: 'Work', primary: true, access_role: 'owner', color: '#123456' },
      { id: 'school', name: 'School', access_role: 'reader', color: '#abcdef' },
    ],
  };
  const connected = await google.googleCalendars(accounts, async () => {});
  assert.equal(connected.length, 2);
  assert.equal(accounts.querySelectorAll('.cal-account-card').length, 1);
  assert.equal(accounts.querySelector('.cal-sync-status').textContent, 'Connected');
  assert.equal(accounts.querySelectorAll('.cal-calendar-swatch').length, 2);
  assert.deepEqual(accounts.querySelectorAll('input').map(n => n.checked), [true, false]);
  assert.ok(accounts.querySelector('.cal-default-calendar').textContent.includes('Work'));
  const filter = accounts.querySelector('input'); filter.checked = false; await filter.onchange();
  assert.deepEqual(JSON.parse(sent.at(-1).options.body), { calendar_ids: [] });
  responses = {};
  let saved = false;
  google.eventDialog([], async () => { saved = true; }, null, start);
  const form = context.document.body.querySelector('.cal-event-dialog');
  assert.equal(form.getAttribute('aria-label'), 'New event');
  assert.equal(form.querySelector('h3').textContent, 'New event');
  assert.equal(form.querySelectorAll('.ms-sheet-grabber').length, 1);
  assert.equal(form.querySelectorAll('.cal-sheet-grabber').length, 0);
  const fields = form.querySelector('.form-grid');
  assert.ok(fields.children[0].classList.contains('cal-title-field'));
  assert.equal(form.querySelectorAll('.cal-field-group').length, 2);
  const inputByLabel = label => descendants(form).find(n => n.getAttribute('aria-label') === label);
  for (const label of ['Event title', 'Calendar', 'Start', 'End', 'Time zone', 'Location', 'Description', 'Repeat', 'Edit recurring event'])
    assert.ok(inputByLabel(label), `Grouped editor preserves ${label}`);
  for (const label of ['Starts date', 'Starts time', 'Ends date', 'Ends time']) assert.ok(inputByLabel(label), `Native pill preserves ${label}`);
  const pillText = label => inputByLabel(label).parentElement.children[0].textContent;
  assert.equal(pillText('Starts date'), 'Fri, Oct 23', 'Date pill shows the full selected local date');
  assert.equal(pillText('Starts time'), '9:00 AM');
  const allDayToggle = form.querySelector('.cal-checkbox-label').querySelector('input');
  allDayToggle.checked = true; allDayToggle.onchange();
  assert.equal(inputByLabel('Starts time').disabled, true);
  assert.equal(inputByLabel('Ends time').hidden, true);
  assert.equal(inputByLabel('Ends time').parentElement.hidden, true, 'All-day mode removes the entire time pill');
  assert.ok(inputByLabel('End').value > inputByLabel('Start').value, 'All-day end remains exclusive');
  allDayToggle.checked = false; allDayToggle.onchange();
  assert.equal(inputByLabel('Starts time').disabled, false);
  assert.equal(inputByLabel('Starts time').parentElement.hidden, false);
  inputByLabel('Starts time').value = '10:00'; inputByLabel('Starts time').onchange();
  inputByLabel('Ends time').value = '11:00'; inputByLabel('Ends time').onchange();
  assert.ok(inputByLabel('Start').value.endsWith('T10:00'));
  assert.ok(inputByLabel('End').value.endsWith('T11:00'));
  assert.equal(pillText('Starts time'), '10:00 AM', 'Visible time follows the native picker');
  assert.equal(pillText('Ends time'), '11:00 AM');
  inputByLabel('Event title').value = 'Grouped event';
  inputByLabel('Location').value = 'Library';
  inputByLabel('Description').value = 'Bring notes';
  await form.onsubmit({ preventDefault() {} });
  const creation = sent.find(r => r.url === '/api/calendar/events' && r.options?.method === 'POST');
  assert.ok(saved);
  const payload = JSON.parse(creation.options.body);
  assert.equal(payload.title, 'Grouped event'); assert.equal(payload.location, 'Library');
  assert.equal(payload.description, 'Bring notes'); assert.ok(payload.time_zone);
  assert.equal(payload.recurrence, null);
  assert.ok(payload.start.endsWith('T10:00:00'));
  assert.ok(payload.end.endsWith('T11:00:00'));

  const calendar = (await moduleAt('static/js/views/calendar.js')).namespace;
  const host = el('div'); await calendar.render(host);
  const phoneHeader = host.querySelector('.view-header');
  const createBar = host.querySelector('.cal-create-bar');
  assert.equal(createBar.parentElement, phoneHeader, 'Phone Add belongs to the title row');
  assert.equal(phoneHeader.querySelectorAll('button').length, 2, 'Only calendars and Add lead the phone page');
  assert.equal(createBar.querySelector('button').getAttribute('aria-label'), 'Add');
  assert.equal(host.querySelector('.cal-nav').parentElement, phoneHeader.parentElement, 'Period and view controls follow the header');
  assert.equal(host.querySelectorAll('.cal-weekday')[0].textContent, 'M');
  assert.equal(host.querySelector('.cal-phone-days').children.length, 7);
  const currentDates = host.querySelector('.cal-phone-days').children.filter(b => b.getAttribute('aria-current') === 'date');
  assert.equal(currentDates.length, 1, 'Only today is marked current, independently of the selected day');
  assert.equal(currentDates[0].getAttribute('aria-label'), new Date().toDateString());
  assert.deepEqual(Array.from(segments.options, x => x.value), ['day', 'week', 'month']);
  const rangeButtons = host.querySelector('.cal-range-switch').querySelectorAll('button');
  assert.deepEqual(rangeButtons.map(b => b.textContent), ['Day', 'Week', 'Month']);
  assert.ok(descendants(host).every(b => !b.classList.contains('ms-dock')), 'Calendar controls stay in the header, without dock proxies');
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  assertMonth(host);
  assert.equal(host.querySelector('.cal-month-label').getAttribute('aria-label'), 'Today');
  assert.equal(host.querySelector('.cal-nav').querySelectorAll('button').some(b => b.textContent === 'Archive' || b.textContent === 'Today'), false);
  assert.ok(host.querySelector('.cal-upcoming'), 'Next 7 Days remains below the selected agenda');
  rangeButtons[0].onclick(); await flush();
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.deepEqual(rangeButtons.map(b => b.getAttribute('aria-checked')), ['true', 'false', 'false']);
  let timeline = host.querySelector('.cal-grid');
  assert.equal(timeline.querySelectorAll('.cal-week-day').length, 1);
  host.querySelector('.cal-month-label').click(); await flush();
  assert.equal(host.querySelector('.cal-phone-days').children.find(b => b.getAttribute('aria-pressed') === 'true').getAttribute('aria-label'), new Date().toDateString());
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
  nav.querySelector('.cal-period-next').onclick(); await flush();
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
  // Month fits its actual weeks from either timeline, on phone and desktop.
  for (const isPhone of [true, false]) {
    phone = isPhone;
    const monthHost = el('div'); await calendar.render(monthHost);
    assert.equal(monthHost.querySelector('.cal-create-bar').parentElement,
      monthHost.querySelector('.view-header'));
    const buttons = monthHost.querySelector('.cal-range-switch').querySelectorAll('button');
    if (!isPhone) {
      const toolbar = monthHost.querySelector('.cal-grid-toolbar');
      assert.equal(monthHost.querySelector('.cal-range-switch').parentElement, toolbar);
      assert.equal(toolbar.parentElement, monthHost.querySelector('.cal-left'));
      assert.equal(toolbar.parentElement.children.indexOf(toolbar) + 1, toolbar.parentElement.children.indexOf(monthHost.querySelector('.cal-grid')), 'Desktop selector immediately precedes the grid');
      assert.equal(monthHost.querySelector('.cal-nav').parentElement, toolbar, 'Desktop period controls share the selector row');
      assert.equal(monthHost.querySelector('.view-header').parentElement, monthHost.querySelector('.cal-workspace'), 'Desktop title uses the page wrapper');
      assert.equal(monthHost.querySelector('.view-header').querySelectorAll('button').length, 2, 'Only calendars and New event remain in the header');
      assert.equal(monthHost.querySelector('.cal-nav').querySelectorAll('button').length, 3, 'Toolbar retains Today and both period arrows');
    }
    for (const mode of ['Day', 'Week']) {
      buttons.find(button => button.textContent === mode).click(); await flush();
      assert.equal(monthHost.querySelectorAll('.cal-day').length, 0);
      if (mode === 'Week') {
        const first = new Date(monthHost.querySelectorAll('.cal-week-day')[0].getAttribute('aria-label'));
        assert.equal(first.getDay(), 1, 'Both desktop and phone weeks begin Monday');
        assert.ok(monthHost.querySelector('.cal-legend'));
        if (isPhone) assert.ok(!/\d{4}/.test(monthHost.querySelector('.cal-month-label').textContent), 'Phone range omits the year');
      }
      const before = requests.length;
      const month = buttons.find(button => button.textContent === 'Month');
      month.click(); await flush();
      assert.ok(requests.slice(before).some(url => url.startsWith('/api/calendar/events?')));
      assertMonth(monthHost);
      assert.equal(monthHost.querySelectorAll('.cal-weekday')[0].textContent, isPhone ? 'M' : 'Mon');
      assert.ok(monthHost.querySelector('.cal-selected-agenda'));
      assert.ok(monthHost.querySelector('.cal-upcoming'));
      if (!isPhone) {
        const store = monthHost.querySelector('.cal-calendars-card');
        assert.equal(store.parentElement, monthHost.querySelector('.cal-left'), 'Calendar selection stays outside the sidebar');
        assert.equal(store.hidden, true, 'Calendar selection is available only through Your calendars');
      }
      assert.equal(month.getAttribute('aria-pressed'), 'true');
      assert.equal(month.getAttribute('aria-checked'), 'true');
    }
  }
  host.querySelector('.cal-month-label').click(); await flush();
  // Reproduce the smoke completion flow: Month contains two copies of today's
  // task. Completion removes its upcoming copy and preserves the checked day copy.
  const matchMedia = context.window.matchMedia;
  for (const isPhone of [true, false]) for (const reduced of [true, false]) {
    phone = isPhone;
    context.window.matchMedia = query => ({ matches: query.includes('prefers-reduced-motion') ? reduced : phone });
    for (const source of ['tab', 'calendar', 'note']) for (const section of ['.cal-selected-agenda', '.cal-upcoming']) {
      const item = { id: 'completion', source, title: 'Review the course project', completed: false,
        source_label: 'School', toggle_url: '/api/tab-school/assignments/a1', start: new Date().toISOString() };
      const toggleUrl = source === 'tab' ? item.toggle_url : source === 'calendar' ? '/api/calendar/events/completion' : '/api/notes/completion';
      responses = (url, options) => {
        if (options?.method === 'PATCH') {
          assert.equal(url, toggleUrl);
          assert.deepEqual(JSON.parse(options.body), { completed: true });
          item.completed = true;
          return {};
        }
        return url.startsWith('/api/calendar/events?') ? [{ ...item }] : [];
      };
      const host = el('div'); await calendar.render(host);
      const panel = host.querySelector('.cal-day-panel');
      assert.equal(panel.querySelectorAll('.card').length, 2, 'Selected day and upcoming both show the active item');
      const card = host.querySelector(section).querySelector('.card');
      if (isPhone) {
        assert.ok(card.querySelector('.cal-agenda-text').querySelector('.title'));
        assert.ok(card.querySelector('.cal-agenda-summary').textContent.includes(item.source_label));
        assert.equal(card.querySelectorAll('.cal-agenda-clock').length, 0, 'Phone metadata stays inside its text column');
        assert.ok(card.querySelector('.cal-completion-hit'), 'Completion remains independently tappable');
      }
      let animations = 0;
      card.animate = () => { animations++; return { finished: Promise.resolve() }; };
      const checkbox = card.querySelector('input');
      checkbox.checked = true;
      await checkbox.onchange();
      assert.equal(item.completed, true);
      assert.equal(panel.querySelectorAll('.card').length, 1, `${source} completion retains only its selected-day copy after ticking ${section}`);
      const completedCard = host.querySelector('.cal-selected-agenda').querySelector('.card');
      assert.ok(completedCard.classList.contains('cal-item-completed'));
      assert.equal(completedCard.querySelector('input').checked, true);
      assert.equal(host.querySelector('.cal-upcoming').querySelectorAll('.card').length, 0);
      assert.equal(host.querySelector('.cal-day-count').textContent, 'One event');
      assert.equal(panel.getAttribute('aria-busy'), 'false');
      assert.equal(animations, section === '.cal-upcoming' && !reduced ? 1 : 0, 'Completion respects reduced motion');
    }
  }
  context.window.matchMedia = matchMedia;
  // Next 7 Days is a second request after the month grid. The selected day
  // retains completed cards while the upcoming list excludes them.
  for (const isPhone of [true, false]) {
    phone = isPhone;
    const completed = { id: 'done', source: 'calendar', title: 'Finished', completed: true,
      start: new Date().toISOString() };
    const pending = [];
    const host = el('div');
    responses = url => {
      if (!url.startsWith('/api/calendar/events?')) return [];
      const range = new URL(url, 'http://test');
      const days = (new Date(range.searchParams.get('end')) - new Date(range.searchParams.get('start'))) / 86400000;
      return days < 8 ? new Promise(resolve => pending.push(resolve)) : [completed];
    };
    const rendering = calendar.render(host); await flush();
    const panel = host.querySelector('.cal-day-panel');
    assert.equal(panel.getAttribute('aria-busy'), 'true', 'Month waits for its separate upcoming request');
    assert.equal(host.querySelector('.cal-selected-agenda').querySelectorAll('.card').length, 1);
    assert.equal(host.querySelector('.cal-selected-agenda').querySelector('input').checked, true);
    assert.equal(host.querySelector('.cal-day-count').textContent, 'One event');
    assert.equal(pending.length, 1);
    pending.shift()([completed]); await rendering;
    assert.equal(panel.getAttribute('aria-busy'), 'false');
    const upcoming = host.querySelector('.cal-upcoming');
    assert.equal(upcoming.querySelector('.empty-state-title').textContent, 'Nothing coming up.');
    assert.equal(upcoming.querySelector('.empty-state-hint').textContent, 'Make room for something new.');
    assert.equal(upcoming.querySelectorAll('.card').length, 0);
    assert.equal(upcoming.querySelectorAll('.cal-upcoming-day-label').length, 0);
    let adds = 0; host.querySelector('.cal-create-bar').querySelector('button').onclick = () => adds++;
    upcoming.querySelector('button').click(); assert.equal(adds, 1, 'Upcoming empty state opens event creation');
    // A day selection can still have an upcoming response in flight when
    // Month is refreshed. Its response must not release the new busy state.
    host.querySelectorAll('.cal-day').find(cell => cell.getAttribute('aria-label') === new Date(completed.start).toDateString()).click();
    host.querySelector('.cal-range-switch').querySelectorAll('button').find(b => b.textContent === 'Month').click();
    await flush(); assert.equal(pending.length, 2);
    pending.shift()([completed]); await flush();
    assert.equal(panel.getAttribute('aria-busy'), 'true');
    assert.equal(host.querySelector('.cal-upcoming').querySelector('.empty-state-title'), undefined, 'Detached response cannot populate the new upcoming section');
    pending.shift()([completed]); await flush();
    assert.equal(panel.getAttribute('aria-busy'), 'false');
    assert.equal(host.querySelector('.cal-upcoming').querySelector('.empty-state-title').textContent, 'Nothing coming up.');
  }
  responses = {};
  phone = true;

  const activity = (await moduleAt('static/js/taskActivity.js')).namespace;
  const now = new Date(2026, 10, 3, 12), recent = new Date(2026, 10, 1, 10).getTime() / 1000;
  const result = activity.activityBins([{ started_at: recent, outcome: 'succeeded' }, { ran_at: recent, outcome: 'failed' },
    { started_at: new Date(2025, 0, 1).getTime() / 1000, outcome: 'succeeded' }, { outcome: 'failed' }], 'week', now);
  assert.equal(result.count, 2); assert.equal(result.done, 1); assert.equal(result.cells.length, 168);
  assert.equal(result.cells.filter(c => c === 'b').length, 1);
  assert.equal(activity.activityBins([], 'month', now).cells.every(c => c === 'empty'), true);
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
  assert.deepEqual(modelsHost.querySelector('.cookbook-installed-list').querySelectorAll('button').map(b => b.textContent), ['Use in Chat', 'Delete', '…']);
  const changeEngine = segments.onChange;
  await changeEngine('engine');
  assert.equal(modelsHost.querySelector('.cookbook-status').querySelector('code').textContent, 'http://localhost:9123/v1');
  assert.equal(modelsHost.querySelector('.cookbook-running').querySelector('strong').textContent, 'fixture.gguf');
  assert.deepEqual(modelsHost.querySelector('.cookbook-installed-list').querySelectorAll('button').map(b => b.textContent), ['Running', 'Use in Chat', 'Delete', '…']);
  assert.equal(modelsHost.querySelector('.cookbook-model-tile').textContent, 'F');
  assert.equal(modelsHost.querySelector('.cookbook-model-count').textContent, '1 model · 2.0 GB');
  const stop = modelsHost.querySelector('.cookbook-running').querySelector('button');
  responses['/api/cookbook/engine/status'] = { running: false, model: null, base_url: null };
  await stop.click();
  assert.ok(requests.includes('/api/cookbook/engine/stop'));
  assert.equal(modelsHost.querySelector('.cookbook-model-options').querySelector('button').textContent, 'Start');
  // Sheets move original nodes; closing restores identity, order and handlers.
  const details = (await moduleAt('static/js/phoneRowDetails.js')).namespace;
  const first = el('button', { text: 'Model' }), second = el('button', { text: 'Delete' });
  const home = el('div', {}, [first, second]), opener = el('button');
  const handler = () => {}; first.onclick = handler;
  const sheet = details.phoneDetails('Task', [first, second], opener, 'Full task text');
  assert.equal(first.parentElement, sheetOptions.content);
  assert.equal(sheetOptions.opener, opener);
  assert.equal(sheetOptions.content.querySelector('p').textContent, 'Full task text');
  sheet.close();
  assert.deepEqual(home.children, [first, second]);
  assert.equal(first.onclick, handler);
  details.phoneDetails('Task', [second], opener);
  sheetOptions.content.onclick({ target: { closest: () => ({ matches: () => true, textContent: 'Delete' }) } });
  assert.deepEqual(home.children, [first, second], 'Destructive actions restore their controls before opening a confirmation');
  responses = {};

  // Exercise the real API helper and adapter, including both caller contracts.
  mocks['api.js'] = (await moduleAt('static/js/api.js')).namespace;
  const { workspaceEmpty } = (await moduleAt('static/js/workspaceParts.js')).namespace;
  for (const mascot of ['on', 'off']) {
    context.document.documentElement.dataset.mascot = mascot;
    let actions = 0;
    for (const options of [
      { icon: '<svg></svg>', title: 'Tasks', hint: 'Nothing scheduled', mascot: 'sleeping', actionLabel: 'Schedule', onAction: () => actions++ },
      { title: 'Models', text: 'Choose a model', mascotState: 'idle', action: { text: 'Browse', onClick: () => actions++ } },
    ]) {
      const empty = workspaceEmpty(options), host = empty.querySelector('.empty-state-mascot');
      assert.ok(empty.classList.contains('empty-state-rich'));
      assert.equal(host.children[0].tag, 'kairos-mascot');
      assert.equal(host.children[0].getAttribute('state'), options.mascot || options.mascotState);
      assert.equal(empty.querySelector('.empty-state-title').tag, 'h2');
      assert.equal(empty.querySelector('.empty-state-hint').textContent, options.hint || options.text);
      assert.equal(empty.classList.contains('rd-empty-state'), true);
      empty.querySelector('button').onclick();
      if (options.icon) assert.ok(empty.querySelector('.empty-state-icon'));
    }
    assert.equal(actions, 2);
    assert.equal(workspaceEmpty({ title: 'Documents' }).querySelector('.empty-state-mascot').children[0].getAttribute('state'), 'idle');
    assert.equal(workspaceEmpty({ title: 'Plain', mascot: null }).querySelector('.empty-state-mascot'), undefined);
  }
  console.log('Workspace tabs: timeline, dock hooks, navigation, empty-state contracts, all-day boundaries, recorded activity and both local-model engines passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
