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
  focus() {}
}
const el = (tag, attrs, children) => new Node(tag, attrs, children);
const root = new Node('root', { class: 'kairos-redesign' });
const document = { documentElement: root, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, removeEventListener(name) { delete this.listeners[name]; } };
const sessions = [{ id: 'one', title: 'Real chat', updated_at: Date.now() / 1000 - 3600 }, { id: 'two', title: 'Idle chat' }];
let processing = true, streamListener, requests = 0;
const chatStream = {
  getInFlight: id => id === 'one' && processing ? { status: 'processing' } : null,
  listInFlight: () => processing ? [{ sessionId: 'one', status: 'processing' }] : [],
  subscribeAll: callback => { streamListener = callback; return () => { streamListener = null; }; },
};
const createMascot = () => el('kairos-mascot');
const emptyState = ({ title, text }) => el('section', {}, [createMascot(), el('h2', { text: title }), el('p', { text })]);
const observers = [];
class MutationObserver { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
const context = vm.createContext({ document, el, createMascot, emptyState, segmented: () => el('div'), chatStream, MutationObserver, mountConversations: () => () => {}, CSS: { escape: value => value }, api: async () => { requests++; return sessions; }, Date });
const source = fs.readFileSync(path.join(__dirname, '../static/js/redesignChatParts.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
vm.runInContext(source + '\nthis.parts = { chatAge, workingChats, mountChatParts };', context);
const { chatAge, workingChats, mountChatParts } = context.parts;
async function run() {
  assert.equal(chatAge(undefined), ''); assert.equal(chatAge('invalid'), '');
  assert.equal(chatAge(Date.now() / 1000 + 60), 'Now');
  assert.equal(chatAge(Date.now() / 1000 - 7200), '2h');
  let opened;
  const working = workingChats(sessions, id => { opened = id; });
  assert.equal(working.querySelectorAll('button').length, 1);
  working.querySelector('button').click(); assert.equal(opened, 'one');
  root.dataset.mascot = 'off'; assert.equal(workingChats(sessions, () => {}).querySelectorAll('kairos-mascot').length, 0); delete root.dataset.mascot;
  const original = el('text', { text: 'Real chat' });
  const row = el('button', { class: 'session-item', 'data-session-id': 'one', 'data-title': 'Real chat' }, [original]);
  const list = el('div', { id: 'sessions-list' }, [row]);
  const panel = el('div', { id: 'chat-sessions' }, [list]);
  const messages = el('div', { id: 'chat-messages' });
  const main = el('div', { id: 'chat-main', class: 'is-empty' }, [messages, el('div', { class: 'chat-composer-dock' })]);
  const dock = main.querySelector('.chat-composer-dock');
  const menu = el('div', { class: 'overflow-menu hidden' });
  const container = el('div', {}, [panel, main, menu]); root.append(container);
  const dispose = mountChatParts(container);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(messages.childNodes.length, 0, 'empty-state must never enter the message list');
  assert.equal(container.querySelector('.rd-chat-idle').hidden, false);
  assert.equal(dock.parent, container.querySelector('.rd-chat-idle-layout'));
  assert.equal(menu.classList.contains('rd-menu-in'), true);
  root.classList.remove('kairos-redesign'); document.listeners['kairos:appearance']();
  assert.equal(row.childNodes[0], original); assert.equal(row.childNodes.length, 1); assert.equal(row.hidden, false);
  assert.equal(container.querySelector('.rd-chat-idle').hidden, true);
  root.classList.add('kairos-redesign'); document.listeners['kairos:appearance']();
  processing = false; streamListener(); const requestCount = requests;
  streamListener(); assert.equal(requests, requestCount, 'stream updates must not fetch session metadata');
  main.classList.remove('is-empty'); observers[0].fn(); assert.equal(container.querySelector('.rd-chat-idle').hidden, true);
  dispose(); assert.equal(row.childNodes[0], original); assert.equal(streamListener, null);
  assert.equal(dock.parent, main, 'restore the original composer dock on cleanup');
  assert.equal(container.querySelector('.rd-chat-idle-layout'), null);
  assert.equal(container.querySelector('.rd-chat-idle'), null); assert.equal(menu.classList.contains('rd-menu-in'), false);
  assert(observers.every(observer => observer.disconnected));
  console.log('PASS: real activity only, mascot off, empty message list, Classic restoration, stream fetch bounds, cleanup.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
