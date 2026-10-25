// Presentation lifecycle checks without Electron or a running server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.children = []; this.attrs = attrs; this.dataset = {}; this.hidden = !!attrs.hidden;
    this.value = ''; this.title = attrs.title || ''; this.text = attrs.text || '';
    this.classes = new Set((attrs.class || '').split(' ').filter(Boolean));
    this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x) };
    this.listeners = {};
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    this.append(...children);
  }
  get childNodes() { return [...this.children]; }
  get isConnected() { return this.parent ? this.parent.isConnected : this.tag === 'root'; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; this.replaceChildren(); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of [...nodes].reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
  before(...nodes) { const parent = this.parent; for (const node of nodes) { node.remove(); node.parent = parent; parent.children.splice(parent.children.indexOf(this), 0, node); } }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; } }
  replaceWith(node) { this.before(node); this.remove(); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.attrs.id === selector.slice(1);
    if (selector.startsWith('[data-session-id=')) return this.dataset.sessionId === selector.slice(18, -2);
    return selector === this.tag;
  }
  querySelectorAll(selector) { const matches = node => selector.split(', ').some(s => node.matches(s)); return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  removeEventListener(name) { delete this.listeners[name]; }
  setAttribute(name, value) { this.attrs[name] = value; }
  click() { this.attrs.onclick?.(); this.listeners.click?.(); }
  insertBefore(node, reference) { if (reference) reference.before(node); else this.append(node); }
  dispatchEvent(event) { this.listeners[event.type]?.(event); this.attrs['on' + event.type]?.(event); }
  focus() { this.focused = true; }
}
const el = (tag, attrs, children) => new Node(tag, attrs, children);

const root = new Node('root', { class: 'kairos-redesign' });
const document = { documentElement: root, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; } };
const desktop = { matches: true, addEventListener(_, fn) { this.change = fn; }, removeEventListener() {} };
let inflight = [], listener;
const chatStream = { listInFlight: () => inflight, getInFlight: id => inflight.find(run => run.sessionId === id), subscribeAll(fn) { listener = fn; return () => { listener = null; }; } };
const observers = [];
class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} }
const context = vm.createContext({ el, document, chatStream, createMascot: () => el('kairos-mascot'), matchMedia: () => desktop, MutationObserver, Date });
const source = fs.readFileSync(path.join(__dirname, '../static/js/redesignConversations.js'), 'utf8').trimStart().replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
vm.runInContext(source + '\nthis.parts = { conversationGroups, conversationCounts, mountConversations };', context);
const { conversationGroups: group, conversationCounts: counts, mountConversations } = context.parts;
const stamp = (day, hour = 12) => new Date(2026, 9, day, hour).getTime() / 1000;
const sessions = [
  { id: 'old', title: 'Old', updated_at: stamp(18), project_id: 'p', starred: true },
  { id: 'today', title: 'Today title', updated_at: stamp(23), forge: true },
  { id: 'week', title: 'Week title', updated_at: stamp(20), project_id: 'p' },
  { id: 'yesterday', title: 'Yesterday title', updated_at: stamp(22) },
  { id: 'missing', title: 'No timestamp' },
];
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(group(sessions, [], new Date(2026, 9, 23, 16))).map(g => [g.label, g.rows.map(s => s.id)]), [
  ['Today', ['today']], ['Yesterday', ['yesterday']], ['Earlier this week', ['week']], ['Older', ['old', 'missing']],
]);
const working = group(sessions, [{ sessionId: 'old', status: 'processing' }, { sessionId: 'today', status: 'done' }, { sessionId: 'absent', status: 'processing' }], new Date(2026, 9, 23));
assert.equal(working[0].label, 'Working now'); assert.equal(working[0].rows[0].id, 'old');
assert.equal(working.flatMap(g => g.rows).length, sessions.length, 'working rows appear exactly once');
assert.equal(group([], []).length, 0);
assert.equal(group([{ id: 'boundary', updated_at: stamp(23, 0) }], [], new Date(2026, 9, 23))[0].label, 'Today');
assert.equal(group([{ id: 'sun', updated_at: stamp(18) }], [], new Date(2026, 9, 19))[0].label, 'Yesterday', 'Monday preserves Yesterday before the week cutoff');
assert.equal(group([{ id: 'sat', updated_at: stamp(17) }], [], new Date(2026, 9, 19))[0].label, 'Older');
// DST fall-back day is a calendar day, not a 24-hour subtraction.
assert.equal(group([{ id: 'dst', updated_at: new Date(2026, 10, 1, 0, 30).getTime() / 1000 }], [], new Date(2026, 10, 2, 23))[0].label, 'Yesterday');
let selectedFilter;
const filters = [{ id: null, label: 'All', select: () => { selectedFilter = null; } }, { id: 'p', label: 'Project', select: () => { selectedFilter = 'p'; } }, { id: 'empty', label: 'Empty' }];
assert.deepEqual(plain(counts(sessions, filters)).map(f => f.count), [5, 2, 0]);
assert.deepEqual(plain(counts([], filters)).map(f => f.count), [0, 0, 0]);
assert.equal(sessions[0].id, 'old', 'grouping does not mutate input order');

const originals = sessions.map(s => el('text', { text: s.title }));
const rows = sessions.map((s, i) => el('button', { class: 'session-item' + (s.id === 'today' ? ' active' : ''), 'data-session-id': s.id, 'data-title': s.title }, [originals[i]]));
const list = el('div', { id: 'sessions-list' }, rows);
list.chatSessions = sessions; list.chatFilters = filters;
const newChat = el('button', { class: 'chat-new-btn' });
const panel = el('aside', { id: 'chat-sessions' }, [newChat, list]);
const container = el('div', { class: 'chat-history-collapsed' }, [panel]); root.append(container);
const dispose = mountConversations(container);
container.querySelector('.rd-conversations-filters').children[1].click(); assert.equal(selectedFilter, 'p', 'segments call the existing project selection');
assert.equal(container.querySelector('.rd-chat-initial'), null, 'no letter tiles');
assert.equal(container.querySelectorAll('.rd-conversation-tag').length, 1);
assert.equal(container.querySelector('.rd-conversation-detail').children.length, 1, 'no fabricated preview');
assert.equal(list.classList.contains('rd-stagger'), false, 'closed panel does not consume first-open motion');
container.classList.remove('chat-history-collapsed'); observers[0].fn();
assert.equal(list.classList.contains('rd-stagger'), true);
observers[0].fn(); assert.equal(list.classList.contains('rd-stagger'), false, 'subsequent opens do not replay motion');
const search = container.querySelector('.rd-chat-search'); search.value = 'Today title'; search.listeners.input();
assert.equal(list.querySelectorAll('.rd-conversations-group').length, 1, 'search removes empty groups');
assert.equal(rows[0].hidden, true); assert.equal(rows[1].hidden, false);
assert.equal(container.querySelector('.rd-conversations-footer').textContent, '5 conversations');
search.value = ''; search.listeners.input();
inflight = [{ sessionId: 'old', status: 'processing' }]; listener();
assert.equal(list.querySelector('.rd-conversations-group').textContent, 'Working now');
assert.equal(container.querySelectorAll('kairos-mascot').length, 1);
root.dataset.mascot = 'off'; document.listeners['kairos:appearance']();
assert.equal(container.querySelectorAll('kairos-mascot').length, 0);
inflight = [{ sessionId: 'old', status: 'done' }]; listener();
assert(rows[0].querySelector('.rd-conversation-state').classes.has('is-finished'));
const rename = el('input', { class: 'session-rename-input' }); rows[0].replaceChildren(rename);
inflight = []; listener(); assert.equal(rows[0].childNodes[0], rename, 'live updates preserve inline rename');
// Phone layout restores the original controller nodes.
rows[0].replaceChildren(originals[0]);
desktop.matches = false; desktop.change();
assert.equal(panel.children[0], newChat);
assert.deepEqual(list.children, rows, 'Phone restores original row ordering');
rows.forEach((row, i) => assert.equal(row.childNodes[0], originals[i]));
assert.equal(container.querySelector('.rd-conversations-header'), null, 'phone list is untouched');
desktop.matches = true; desktop.change(); dispose();
assert.equal(listener, null); assert.equal(panel.children[0], newChat);
assert.equal(container.querySelector('.rd-conversations-header'), null);
console.log('PASS: date groups, week/DST boundaries, real working state, project counts, search, rename, phone restoration and cleanup.');
