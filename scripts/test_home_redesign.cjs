// Home lifecycle and data-gating checks without Electron or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.parentElement = null; this.children = []; this.dataset = {}; this.hidden = false; this.textContent = '';
    const classes = new Set((attrs.class || '').split(' ').filter(Boolean));
    this.classList = { contains: c => classes.has(c), add: c => classes.add(c), remove: (...cs) => cs.forEach(c => classes.delete(c)), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) };
    this.properties = new Map(); this.attributes = new Map();
    this.style = { setProperty: (k, v) => this.properties.set(k, v), removeProperty: k => this.properties.delete(k) };
    Object.assign(this, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'class')));
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    this.append(...children);
  }
  append(...nodes) { for (const node of nodes) { node.remove(); this.children.push(node); node.parentElement = this; } }
  prepend(...nodes) { this.append(...nodes); this.children = [...nodes, ...this.children.filter(n => !nodes.includes(n))]; }
  replaceChildren(...nodes) { this.children.forEach(n => n.parentElement = null); this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
  before(node) { const p = this.parentElement, i = p.children.indexOf(this); node.remove(); p.children.splice(i, 0, node); node.parentElement = p; }
  after(node) { const p = this.parentElement, i = p.children.indexOf(this); node.remove(); p.children.splice(i + 1, 0, node); node.parentElement = p; }
  matches(selector) { return selector.split(',').some(s => { s = s.trim(); if (s.startsWith('[data-home-section=')) return this.dataset.homeSection === s.slice(19, -1); return s[0] === '.' ? this.classList.contains(s.slice(1)) : this.tag === s; }); }
  querySelector(selector) {
    if (selector.includes(' ')) { const [first, ...rest] = selector.split(' '); return this.querySelector(first)?.querySelector(rest.join(' ')); }
    for (const child of this.children) { if (child.matches(selector)) return child; const result = child.querySelector(selector); if (result) return result; }
    return null;
  }
  addEventListener() {}
  focus() { document.activeElement = this; }
  get isConnected() { return this === document.body || !!this.parentElement?.isConnected; }
  setAttribute(k, v) { this.attributes.set(k, v); }
  removeAttribute(k) { this.attributes.delete(k); }
}
const el = (tag, attrs, children) => new Node(tag, attrs, children);
let on = true, listener;
const phone = { matches: false, addEventListener() {}, removeEventListener() {} };
const document = new EventTarget();
document.documentElement = { classList: { contains: () => on } };
document.createComment = () => el('comment');
const order = ['needs', 'working', 'models', 'chats', 'schedule', 'system', 'stats', 'projects', 'agents', 'activity', 'store'];
let layout = { home: order, hiddenHome: order.slice(5) };
const data = {};
const content = el('div'), banner = el('div', { class: 'dashboard-core' }), mascot = el('kairos-mascot'), header = el('header', { class: 'dashboard-header' }), next = el('span', { class: 'dashboard-next' }), hero = el('section', { class: 'dashboard-hero' }, [banner, header, mascot, next]), grid = el('div');
document.body = el('body'); document.body.append(content);
content.append(hero, grid);
const parts = {};
for (const id of order.filter(id => !['needs', 'working'].includes(id))) parts[id] = el('section', { 'data-home-section': id }, [el('div', { class: 'dashboard-section-header' }, [el('h2'), el('button', { textContent: 'arrow' })])]);
const stored = new Map();
const context = {
  document, el, console, setTimeout, clearTimeout, Date, Set, Map, WeakSet, Number, JSON, matchMedia: () => phone,
  localStorage: { getItem: k => stored.get(k), setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
  HOME_SECTIONS: order.map(id => ({ id })), getLayout: () => structuredClone(layout), saveLayout: x => { layout = x; },
  homeLayout: () => ({ order: layout.home, hidden: layout.hiddenHome }), resetHomeLayout() {},
  knownHomeCards: () => ['tab:crm:follow-ups', 'tab:crm:open-count'].map(id => ({ id, title: id, tab_name: 'CRM' })),
  subscribeActivity: cb => { listener = cb; cb({ need: [], work: [] }); return () => { listener = null; }; },
  createMascot: () => el('kip'), agentAvatar: () => el('bot-kip'),
  getAppearance: () => ({ kip: 'halftone' }), openKipMenu() {}, showKip() {}, KIP_STYLE_NAMES: { halftone: 'Halftone' },
  ICONS: { calendar: '', settings: '' },
  pill: x => el('button', { textContent: x.text }),
  dotMatrix: x => el('matrix', { cells: x.cells }),
  usageCard: x => el('usage', { models: x.models }),
};
let source = fs.readFileSync('static/js/redesignHome.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ');
// Expose internal arrangement operations for contract checks using the real code.
source = source.replace('return { arrange, update(key)', 'return { arrange, swap, sheetRows, update(key)');
vm.createContext(context); vm.runInContext(source + '\nthis.mount = mountRedesignHome; this.ensure = ensureArrangement; this.legacySnapshot = legacySnapshot;', context);
const initialLayout = structuredClone(layout);
layout = { home: ['tab:crm:follow-ups', ...order], hiddenHome: [] };
stored.set('kairos:redesign-home-auto', context.legacySnapshot(layout));
const oldMixed = structuredClone(layout); context.ensure();
assert.deepEqual(layout, oldMixed, 'Legacy auto marker cannot overwrite a saved mixed tab arrangement');
stored.clear(); layout = initialLayout;
let ui;
const arrange = () => ui.arrange(layout.home, layout.hiddenHome);
ui = context.mount({ content, hero, grid, parts, data: () => data, rearrange: arrange });
arrange();
assert.equal(hero.parentElement, grid, 'Desktop has its hero');
assert.equal(header.parentElement, null); assert.equal(next.parentElement, null, 'No Classic status or next line inside redesigned hero');
assert.ok(mascot.attributes.has('follow-pointer'), 'Only the active Home hero opts into pointer tracking');
assert.equal(banner.parentElement, hero, 'Original banner stays in the hero');
assert.equal(parts.system.parentElement, grid, 'Systems is always present, even if hidden in saved layout');
assert.equal(grid.querySelector('usage'), null, 'No usage placeholder');
assert.equal(parts.chats.parentElement, null, 'No recent-chats placeholder');
data.quotas = { providers: [], models: [] }; ui.update('quotas');
assert.equal(grid.querySelector('usage'), null, 'No connected model, no usage card');
data.quotas.models.push({ id: 'l1', name: 'qwen3', kind: 'local', status: 'connected', quota: null, recorded: { today_tokens: 0, week_tokens: 0, total_tokens: 0 } });
ui.update('quotas');
assert.equal(grid.querySelector('usage').models.length, 1, 'A local model without usage is still listed');
data.quotas.models.unshift({ id: 'g1', name: 'Antigravity', kind: 'antigravity_cli', provider: 'antigravity', status: 'connected', quota: { provider: 'antigravity', status: 'no_quota', windows: [] } });
data.quotas.models.unshift({ id: 'x1', name: 'Codex', kind: 'codex_cli', provider: 'codex', status: 'needs_sign_in', quota: { provider: 'codex', status: 'needs_sign_in', windows: [] } });
ui.update('quotas');
assert.deepEqual(grid.querySelector('usage').models.map(m => m.id), ['x1', 'g1', 'l1'], 'Signed-out and quota-less subscriptions are items, in the order the route gives');
listener({ need: [{ title: 'Question', detail: 'Please choose', action: 'Reply', go() {}, agent: { id: 'a' } }], work: [] });
assert.equal(hero.parentElement, grid, 'Live need preserves the same hero');
assert.ok(grid.querySelector('bot-kip'), 'Bot rows use the bot face');
assert.equal(grid.querySelector('.hm-week'), null, 'A failed week read is hidden');
data.week = { start: '2026-10-19', end: '2026-10-25', totals: { chats: 3, agent_runs: 2, notes_done: 0 }, unavailable: ['notes_done'], busiest: 'Mon', slots: Array.from({ length: 14 }, (_, i) => ({ chats: i ? 0 : 3, agent_runs: i ? 0 : 2 })) };
ui.update('week');
const matrix = grid.querySelector('matrix');
assert.equal(matrix.cells.length, 84);
assert.equal(matrix.cells[0], 'empty');
assert.equal(matrix.cells[1], 'dim', 'Empty cells alternate sunk tones across columns');
assert.equal(matrix.cells[15], 'empty', 'Empty tones alternate across rows too');
assert.equal(matrix.cells[14], 'b');
assert.equal(matrix.cells[42], 'a', 'Chats stack from the bottom, agents above');
assert.equal(grid.querySelector('.hm-week-stats').children.length, 2, 'Unavailable notes are omitted');
const week = grid.querySelector('.hm-week');
assert.deepEqual(week.querySelector('.hm-week-days').children.map(n => n.text), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
assert.equal(week.querySelector('.hm-busiest').text, 'Busiest: Monday');
assert.equal(week.querySelector('.hm-week-range').text, 'Oct 19 \u2013 25');
data.week.unavailable = []; ui.update('week');
assert.equal(week.querySelector('.hm-week-stats').children.length, 3, 'Available notes done appear, including a real zero');
data.week.unavailable = ['notes_done']; ui.update('week');
grid.classList.remove('rd-stagger'); ui.update('week');
assert.ok(!grid.classList.contains('rd-stagger'), 'Data refresh never replays section entrance');
data.sessions = [{ id: 'chat' }]; ui.update('sessions');
assert.ok(parts.chats.parentElement, 'Recent chats appear with data');
parts.schedule.append(el('button', { class: 'dashboard-row' })); ui.update('events');
assert.ok(parts.schedule.parentElement, 'Only filtered upcoming calendar rows appear');
phone.matches = true; arrange();
assert.equal(hero.parentElement, null, 'Phone has no hero or slogan');
assert.ok(!mascot.attributes.has('follow-pointer'), 'Phone disables following eyes');
assert.equal(grid.children[0], week, 'Phone starts directly with This week');
assert.equal(banner.parentElement, week, 'Phone week owns the original Home banner');
assert.deepEqual(grid.children.slice(1).map(node => node.dataset.homeSection), ['needs', 'models', 'chats', 'schedule', 'system'], 'Phone DOM follows section order');
ui.update('week');
assert.equal(banner.parentElement, week, 'Week refresh retains the mounted phone background');
data.week = null; ui.update('week');
assert.equal(grid.querySelector('.hm-week'), null, 'Failed week data has no placeholder');
assert.equal(hero.parentElement, null, 'Failed week data never adds a phone hero');
data.week = { start: '2026-10-19', end: '2026-10-25', slots: Array.from({ length: 14 }, () => ({ chats: 0, agent_runs: 0 })), totals: { chats: 0, agent_runs: 0 }, unavailable: ['notes_done'] }; ui.update('week');
assert.equal(banner.parentElement, week, 'Recovered phone week restores the same banner');
phone.matches = false; arrange();
assert.equal(banner.parentElement, hero, 'Desktop returns the banner to the hero');
assert.equal(week.querySelector('.dashboard-core'), null, 'Desktop week is plain');
assert.ok(mascot.attributes.has('follow-pointer'), 'Desktop re-enables following eyes');
layout.home = ['chats', ...order.filter(id => id !== 'chats')]; arrange();
assert.ok(grid.classList.contains('hm-custom-order'), 'A custom arrangement retains packing');
assert.equal(grid.children[2], parts.chats);
listener({ need: [], work: [] });
assert.equal(hero.parentElement, grid, 'All clear preserves the original hero');
assert.ok(grid.querySelector('.hm-week'), 'All clear preserves This week');
assert.equal(grid.querySelector('[data-home-section=needs]'), null);
assert.equal(parts.chats.parentElement, grid, 'All clear preserves recent chats with items');
assert.equal(parts.schedule.parentElement, grid, 'All clear preserves calendar with items');
assert.ok(grid.querySelector('usage'), 'All clear preserves usage with items');
layout.home = order; arrange();
assert.equal(parts.chats.properties.get('--rd-span'), 4);
assert.equal(parts.system.properties.get('--rd-span'), 12);
layout.hiddenHome.push('models'); arrange();
assert.equal(parts.chats.properties.get('--rd-span'), 6);
assert.equal(parts.schedule.properties.get('--rd-span'), 6);
const savedLayout = structuredClone(layout);
layout = { home: order, hiddenHome: [] }; arrange();
assert.ok(grid.querySelector('[data-home-section=stats]'), 'Desktop retains enabled summary in default relative order');
assert.equal(parts.projects.parentElement, grid, 'Desktop retains enabled legacy Projects section');
layout = { home: ['tab:crm:follow-ups', 'needs', 'tab:crm:open-count', ...order.filter(id => id !== 'needs')], hiddenHome: [] };
for (const id of ['tab:crm:follow-ups', 'tab:crm:open-count']) parts[id] = el('section', { 'data-home-section': id });
listener({ need: [{ title: 'Question', action: 'Reply', go() {} }], work: [] });
assert.deepEqual(grid.children.filter(n => n.dataset.homeSection).slice(0, 3).map(n => n.dataset.homeSection),
  ['tab:crm:follow-ups', 'needs', 'tab:crm:open-count'], 'Saved tab cards remain interleaved with built-ins');
assert.deepEqual(Array.from(ui.sheetRows().main).slice(0, 3), layout.home.slice(0, 3), 'Customize lists visible cards in mixed saved order');
ui.swap('tab:crm:follow-ups', 1);
assert.deepEqual(layout.home.slice(0, 3), ['needs', 'tab:crm:follow-ups', 'tab:crm:open-count'], 'Customize moves tab cards past built-ins');
ui.swap('tab:crm:follow-ups', -1);
assert.deepEqual(layout.home.slice(0, 3), ['tab:crm:follow-ups', 'needs', 'tab:crm:open-count'], 'Customize restores mixed order');
layout = savedLayout;
phone.matches = true; arrange();
// Programmatic/touch activation can leave focus on a different element.
// Closing Customize must return to the actual opener on either surface.
for (const selector of ['.hm-phone-customize', '.hm-customize']) {
  const opener = content.querySelector(selector);
  document.activeElement = document.body;
  opener.onclick({ currentTarget: opener });
  const done = document.body.querySelector('.hm-sheet-top button');
  assert.equal(document.activeElement, done, 'Customize focuses Done when opened');
  done.onclick();
  assert.equal(document.activeElement, opener, `Customize restores focus to ${selector} after an unfocused click`);
  assert.equal(document.body.querySelector('.hm-sheet-root'), null, 'Customize removes the sheet on Done');
}
ui.dispose(); assert.equal(listener, null, 'Activity subscription is disposed');
console.log('PASS: Home gates, week matrix, live transitions, refresh motion, custom order and cleanup.');

// Account startup must not overwrite an appearance choice made before auth resolves.
(async () => {
  const source = fs.readFileSync('static/js/appearance.js', 'utf8');
  const startup = source.slice(source.indexOf('export async function initAppearance'), source.indexOf('// Validate, decode'))
    .replace(/export /g, '');
  const saved = new Map([
    ['jarvis:appearance:v1:alex', JSON.stringify({ motion: true, color: '#abcdef' })],
    ['jarvis:appearance:v1:other', JSON.stringify({ motion: true })],
  ]);
  const state = {
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    normalize: value => ({ motion: true, ...value }),
    ensureCanvases() {}, apply() {}, imageStore: async () => null, Blob, URL,
    // The Animated style's own animation, which startup also reloads (none stored here).
    dropOwnArt() {}, artDbKey: () => 'art', openArt: async () => null,
  };
  vm.createContext(state);
  vm.runInContext(`let settings = {}, storageKey = '', startupPatch = null, identityRevision = 0,
    imageRevision = 0, imageBitmap = null, storageIssue = '', artRevision = 0, ownArt = null, artColorsKey = '',
    overridePatch = null, saved = null;  // Browse's look layer (appearance.js setAppearanceOverride)
    const HALFTONE_SLOTS = [], halftoneUrl = {}, halftoneRevision = {}, DEFAULTS = {};
    ${startup}
    this.update = updateAppearance; this.init = initAppearance; this.welcome = restoreWelcomeAppearance;
    this.current = () => settings;`, state);
  state.update({ motion: false });
  state.welcome();
  assert.equal(state.current().motion, false, 'Welcome loading preserves an explicit pending selection');
  assert.ok(!saved.has(''), 'Pending settings are not saved under an empty account key');
  await state.init('alex');
  assert.equal(state.current().motion, false, 'Account loading preserves the motion choice');
  assert.equal(state.current().color, '#abcdef', 'Unchanged account preferences survive');
  assert.equal(JSON.parse(saved.get('jarvis:appearance:v1:alex')).motion, false, 'The choice persists on the correct account');
  await state.init('other');
  assert.equal(state.current().motion, true, 'The pending patch is consumed and cannot cross accounts');
  console.log('PASS: Motion selection survives startup and stays scoped to its account.');
})().catch(error => { console.error(error); process.exitCode = 1; });

