// Home lifecycle and data-gating checks without Electron or network requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  get lastChild() { return this.children.at(-1); }
  get firstElementChild() { return this.children[0]; }
  get childElementCount() { return this.children.length; }
  addEventListener() {}
  setAttribute(k, v) { this.attributes.set(k, v); }
  removeAttribute(k) { this.attributes.delete(k); }
}

const el = (tag, attrs = {}, children) => new Node(tag, { ...attrs, ...(attrs.text !== undefined ? { textContent: attrs.text } : {}) }, children);
const callbacks = new Map();
let on = true;
const phone = { addEventListener: (name, fn) => callbacks.set(name, fn), removeEventListener: name => callbacks.delete(name) };
const document = { documentElement: { dataset: {} }, createComment: () => el('comment'), addEventListener() {}, removeEventListener() {} };
let requests = 0;
const state = { projects: [], sessions: [], models: [], apps: [], location: { value: 'new_worktree' } };
const context = { document, el, JSON, Map, Promise,
  api: async () => { requests++; return { files: [{ added: 8, removed: 3 }] }; },
  mobileOn: () => on, phone, button: (text, action, cls) => { const n = el('button', { textContent: text, class: cls }); n.click = action; return n; },
  go() {}, ICONS: { plus: '<svg/>', home: '<svg/>' },
  emptyState: x => el('empty', { textContent: x.title }),
  dotMatrix: x => el('matrix', { textContent: x.label, cells: x.cells }),
  sessionStatus: s => ({ key: s.needs_approval ? 'approval' : s.working ? 'working' : 'idle', rank: s.needs_approval ? 0 : s.working ? 1 : 3 }),
  changeTotals: rows => rows.reduce((n, x) => ({ added: n.added + x.added, removed: n.removed + x.removed }), { added: 0, removed: 0 }),
  diffCounts: x => el('counts', { textContent: `${x.added}/${x.removed}` }),
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/mobileForge.js'), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, ''), context);
const page = el('div'), banner = el('div'), toolbar = el('div'), grid = el('div'), composer = el('form'), hint = el('p');
page.append(banner, toolbar, grid, composer, hint);
const adapter = context.mountMobileForge({ page, banner, toolbar, grid, composer, hint, getState: () => state, overview: true });
assert.equal(page.querySelector('empty').textContent, 'Choose a project');
state.project = { id: 'p', name: 'Actual project', git: { branch: 'dev', activity: [{ date: '2026-10-22', commits: 2 }, { date: '2026-10-23', commits: 0 }], lifespan: { age_days: 94, first_commit: 1 } } };
state.projects = [state.project];
state.sessions = [{ id: 'working', title: 'Building', working: true, forge: { branch: 'feature' } }, { id: 'approval', title: 'Review', needs_approval: true, forge: { branch: 'other' } }];
state.apps = [{ project_id: 'other', port: 9 }, { project_id: 'p', port: 5173, session_id: 'working' }];
adapter.update(false);
assert.equal(page.querySelector('.mf-dashboard-title').textContent, 'Actual project');
assert.equal(page.querySelector('matrix').textContent, '2026-10-22: 2 commits, 2026-10-23: 0 commits');
assert.equal(page.querySelector('.mf-working-copy').querySelector('strong').textContent, 'Review', 'approval outranks working');
assert.equal(page.querySelector('.mf-working-pill').textContent, '1 session working', 'approval is not counted as working');
assert.equal(page.querySelector('.mf-summary-grid').children[0].querySelector('strong').textContent, '1', 'services belong to selected project');
assert.equal(page.querySelector('counts'), null, 'unavailable changes are omitted');
const card = page.querySelector('.mf-board').children[1];
adapter.update(false);
assert.equal(page.querySelector('.mf-board').children[1], card, 'unchanged updates retain DOM and focus');
assert.equal(toolbar.parentElement.tag, 'details', 'original controls are retained in details');
on = false; callbacks.get('change')();
assert.equal(page.querySelector('.mf-dashboard'), null);
assert.equal(toolbar.parentElement, page); assert.equal(grid.parentElement, page); assert.equal(banner.parentElement, page);
on = true; callbacks.get('change')();
assert.equal(page.querySelector('.mf-dashboard-title').textContent, 'Actual project', 'resize repaints selected project');
adapter.dispose();
assert.equal(page.querySelector('.mf-dashboard'), null);
assert.equal(toolbar.parentElement, page); assert.equal(grid.parentElement, page);
console.log('Forge mobile board data, priority, DOM stability and desktop restoration pass.');

context.edgeBlur = () => el('blur');
context.longPress = () => () => {};
context.setTimeout = setTimeout; context.clearTimeout = clearTimeout;
context.ICONS.search = '<svg/>';
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js/mobileForgeSessions.js'), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, ''), context);
const historyPage = el('section');
const history = context.mountForgeSessions(historyPage);
const now = Date.now() / 1000;
const rows = [
  { id: 'old', title: 'Earlier task', updated_at: now - 172800, forge: { branch: 'old' } },
  { id: 'work', title: 'Current task', updated_at: now, working: true, forge: { branch: 'dev' }, _changes: [{ added: 9, removed: 2 }] },
  { id: 'needs', title: 'Needs review', updated_at: now, needs_approval: true, forge: { branch: 'review' } },
];
history.update(rows, [], () => {});
assert.equal(historyPage.firstElementChild.classList.contains('ms-history-dock'), true);
const groups = historyPage.querySelector('.ms-history-list').children;
assert.equal(groups.length, 2);
assert.equal(groups[0].querySelector('h2').textContent, 'Today');
assert.equal(groups[1].querySelector('h2').textContent, 'Earlier');
assert.equal(groups[0].querySelector('.ms-history-main').querySelector('strong').textContent, 'Needs review');
assert.equal(historyPage.querySelector('counts').textContent, '9/2');
history.update([], [], () => {});
assert.equal(historyPage.querySelector('empty').textContent, 'No sessions yet.');
history.dispose();
console.log('Forge session date groups, priority, real diff counts and empty state pass.');
