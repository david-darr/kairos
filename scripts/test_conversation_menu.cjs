// Renderer interaction and preload contract checks; no Electron process/server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
class Node {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag; this.attrs = attrs; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {};
    this.text = attrs.text || ''; this.classList = { add() {}, contains: () => true };
    for (const [key, value] of Object.entries(attrs)) {
      if (key.startsWith('on')) this.addEventListener(key.slice(2), value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    this.append(...children);
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  get isConnected() { return this === document.body || !!this.parent?.isConnected; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { this.children.forEach(child => child.parent = null); this.children = []; }
  addEventListener(type, fn) { (this.listeners[type] ||= new Set()).add(fn); }
  removeEventListener(type, fn) { this.listeners[type]?.delete(fn); }
  dispatch(type, args = {}) {
    const event = { type, target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...args };
    for (const fn of [...(this.listeners[type] || [])]) fn(event);
    return event;
  }
  click() { return this.dispatch('click'); }
  focus() { document.activeElement = this; }
  getBoundingClientRect() { return this.tag === 'button' ? { left: 30, bottom: 90, width: 200, height: 40 } : { width: 240, height: 280 }; }
}
const document = new Node('document'); document.body = new Node('body'); document.documentElement = new Node('html');
document.createTextNode = text => new Node('text', { text });
const window = new Node('window'); window.innerWidth = 1000; window.innerHeight = 800;
const id = 'abcdef012345', otherId = '123456abcdef';
const sessions = [{ id, title: 'First chat', starred: false }, { id: otherId, title: 'Other chat', starred: true }];
let desktop = true, renamed, deleted, opened, split, calls = [];
const list = new Node('div'), messages = new Node('div'); document.body.append(list, messages);
const context = vm.createContext({
  document, window, el: (tag, attrs, children) => new Node(tag, attrs, children),
  matchMedia: () => ({ matches: desktop }), Event: class { constructor(type) { this.type = type; } },
  api: async (url, options) => { calls.push([url, options]); return url === '/api/sessions' ? sessions : [{ id: 'project', name: 'Work' }]; },
  activeSessionId: 'active', activeProjectFilter: null, SESSION_MIME: 'session',
  setArtifactContext() {}, syncChatLayout() {}, canSplit: () => true,
  openSession: sid => { opened = sid; }, openSideChat: sid => { split = sid; },
  startRename: (_row, session) => { renamed = session.id; }, deleteSession: async session => { deleted = session.id; return false; },
  setTimeout: fn => fn(),
});
const source = read('static/js/redesignConversations.js').replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
vm.runInContext(source, context);
const chat = read('static/js/views/chat.js');
vm.runInContext(chat.slice(chat.indexOf('async function refreshSessions('), chat.indexOf('// Shared by history rows')), context);
// This test uses the real row event handlers and existing action handlers.
Node.prototype.dispatchEvent = function(event) { return this.dispatch(event.type, event); };
const menu = () => document.body.children.find(node => node.attrs.role === 'menu');
const labels = () => menu().children.map(node => node.textContent.slice(1));
const choose = label => menu().children.find(node => node.textContent.slice(1) === label).click();
const key = key => document.dispatch('keydown', { key });
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  let exposed;
  vm.runInNewContext(read('electron/preload.js'), { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'jarvis'); exposed = api; } },
      ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true }; }, on() {}, send() {} } };
  } });
  window.jarvis = exposed;
  await vm.runInContext('refreshSessions(list, messages)', Object.assign(context, { list, messages }));
  const row = list.children[0]; row.focus();
  let event = row.dispatch('contextmenu', { clientX: 70, clientY: 140 });
  assert(event.prevented); assert.equal(menu().style.left, '70px'); assert.equal(menu().style.top, '140px');
  assert.deepEqual(labels(), ['Open', 'Open in new window', 'Rename', 'Star', 'Move to Project', 'Open side by side', 'Delete']);
  assert(menu().children.every(node => node.attrs.role === 'menuitem'));
  assert.equal(document.activeElement, menu().children[0]);
  key('ArrowUp'); assert.equal(document.activeElement, menu().children.at(-1));
  key('ArrowDown'); assert.equal(document.activeElement, menu().children[0]);
  key('End'); assert.equal(document.activeElement, menu().children.at(-1));
  key('Home'); key('ArrowDown'); assert.equal(document.activeElement, menu().children[1]);
  choose('Open in new window'); assert.equal(menu(), undefined); assert.equal(document.activeElement, row);
  assert.deepEqual(calls.at(-1), ['chat:open-window', id], 'renderer invokes the exact function exposed by the actual preload with the row ID');
  for (const trigger of [{ key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) {
    event = row.dispatch('keydown', trigger); assert(event.prevented); assert.equal(menu().style.top, '90px');
    key('Escape'); assert.equal(menu(), undefined); assert.equal(document.activeElement, row);
  }
  assert(!row.dispatch('keydown', { key: 'F10', shiftKey: false }).prevented);
  for (const [target, type] of [[document, 'scroll'], [document, 'pointerdown'], [document, 'click'], [window, 'resize']]) {
    row.dispatch('contextmenu'); target.dispatch(type); assert.equal(menu(), undefined); assert.equal(document.activeElement, row);
  }
  row.dispatch('contextmenu'); document.dispatch('pointerdown', { target: menu().children[0] }); assert(menu());
  key('Tab'); assert.equal(menu(), undefined);
  row.dispatch('contextmenu', { clientX: 999, clientY: 799 }); assert.equal(menu().style.left, '752px'); assert.equal(menu().style.top, '512px');
  choose('Open'); assert.equal(opened, id);
  row.dispatch('contextmenu'); choose('Rename'); assert.equal(renamed, id);
  row.dispatch('contextmenu'); choose('Open side by side'); assert.equal(split, id);
  row.dispatch('contextmenu'); choose('Delete'); await tick(); assert.equal(deleted, id);
  row.dispatch('contextmenu'); choose('Move to Project'); await tick(); assert.deepEqual(labels(), ['No Project', 'Work']);
  choose('Work'); await tick(); assert(calls.some(([url, options]) => url === `/api/sessions/${id}/project` && JSON.parse(options.body).project_id === 'project'));
  list.children[0].dispatch('contextmenu'); choose('Star'); await tick();
  assert(calls.some(([url, options]) => url === `/api/sessions/${id}/star` && JSON.parse(options.body).starred === true));
  list.children[1].dispatch('contextmenu'); assert(labels().includes('Unstar')); key('Escape');
  window.jarvis = undefined; list.children[0].dispatch('contextmenu'); assert(!labels().includes('Open in new window')); key('Escape');
  window.jarvis = {}; list.children[0].dispatch('contextmenu'); assert(!labels().includes('Open in new window')); key('Escape');
  assert(!document.dispatch('contextmenu').prevented, 'default context menu outside rows is untouched');
  desktop = false; assert(!list.children[0].dispatch('keydown', { key: 'ContextMenu' }).prevented); assert.equal(menu(), undefined);
  list.children[0].dispatch('contextmenu', { clientX: 12, clientY: 24 });
  const legacy = document.body.children.find(node => node.attrs.class === 'glass context-menu');
  assert(legacy, 'phone retains its original row menu');
  assert(!legacy.textContent.includes('Open in new window'));
  vm.runInContext('closeSessionMenu()', context);
  assert.equal(document.listeners.keydown.size, 0); assert.equal(document.listeners.scroll.size, 0);
  const main = read('electron/main.js');
  assert(main.indexOf('const chatWindows = installChatWindows(') < main.indexOf('async function createWindow('));
  const app = read('static/js/app.js');
  assert(app.includes("if (chatWindow) await switchTab('chat', chatWindow)"));
  assert(app.includes('mod.render(nextView, tabId, { ...options,'));
  assert(chat.includes('if (options.sessionId) await openSession(options.sessionId, sessionsList, messages)'));
  assert(read('static/js/chatPaneToolbar.js').includes('window.jarvis?.openChatWindow?.(getSessionId())'), 'header uses the same preload API');
  assert.match(read('core/session_manager.py'), /session_id = uuid\.uuid4\(\)\.hex\[:12\]/);
  console.log('PASS: row context/keyboard menu, positioning, focus, dismissal, existing actions, API visibility, real renderer→preload IPC, startup routing and session IDs.');
})().catch(error => { console.error(error); process.exitCode = 1; });
