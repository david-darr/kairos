const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installChatWindows, validSessionId } = require('../electron/chat-windows');
const esm = file => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).toString('base64'));
(async () => {
  const { createPaneState, clampSplit, clampChatWidth } = await esm('static/js/chatPaneState.js');
  const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const state = createPaneState(storage, 'user:a');
  assert.equal(state.split, 62);
  state.show('design'); state.show('background'); state.show('design');
  assert.deepEqual(state.open, ['design', 'background']);
  state.close('design'); assert.deepEqual(state.open, ['background']);
  state.close('missing'); state.close('background'); assert.deepEqual(state.open, []);
  assert.equal(state.resize(-40), 20); assert.equal(state.resize(200), 80);
  assert.equal(state.resize(0), 20);
  assert.equal(clampChatWidth(1200, -1), 380); assert.equal(clampChatWidth(1200, 9999), 840);
  assert.equal(clampChatWidth(900, 9999), 568);
  state.resize(54); assert.equal(createPaneState(storage, 'user:a').split, 54);
  assert.equal(createPaneState(storage, 'user:b').split, 62);
  for (const value of ['bad', undefined, NaN]) assert.equal(clampSplit(value), 62);
  const unavailable = createPaneState({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  assert.equal(unavailable.resize(45), 45);
  // Run the actual shared registration against a small DOM, including the
  // existing artifact slot's replacement and narrow-screen overlay contract.
  class Element {
    constructor(attrs = {}) {
      this.attrs = attrs; this.children = []; this.dataset = {}; this.listeners = {}; this.isConnected = true;
      const classes = new Set((attrs.class || '').split(' '));
      this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
      this.style = { removeProperty(key) { delete this[key]; } };
    }
    append(node) { node.remove(); this.children.push(node); node.parent = this; }
    moveBefore(node) { this.append(node); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    after(node) { node.remove(); const parent = this.parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); node.parent = parent; }
    setAttribute(key, value) { this.attrs[key] = value; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    dispatchEvent(event) { this.listeners[event.type]?.(event); }
    focus() {} setPointerCapture() {}
    getBoundingClientRect() { return { top: 0, height: 800 }; }
    closest() { return this; }
  }
  const events = new Map(), documentEvents = new Map();
  const window = { innerWidth: 1440, addEventListener: (type, fn) => events.set(type, fn), removeEventListener: type => events.delete(type) };
  const document = { dispatchEvent() {}, addEventListener: (type, fn) => documentEvents.set(type, fn), removeEventListener: type => documentEvents.delete(type) };
  const stackCode = fs.readFileSync(path.join(__dirname, '../static/js/chatPaneStack.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const stack = new Function('el', 'createPaneState', 'holdReadingPositions', 'window', 'document', 'localStorage', 'CustomEvent', stackCode + '\nreturn { mountStackedPane, paneIsOpen, setPaneUser, paneStorageKey, desktopPanes };')(
    (tag, attrs) => new Element(attrs), createPaneState, () => {}, window, document, storage, class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } });
  stack.setPaneUser('a'); assert.equal(stack.paneStorageKey('width'), 'width:a');
  const host = new Element();
  let roots = 0, releases = 0, maximized = false;
  const mount = (host, root, close, options) => { assert(options.sharedRoot); host.append(root); roots++; return { setMaximized: value => maximized = value, dispose: () => releases++ }; };
  const openPane = kind => {
    const panel = new Element({ class: kind === 'documents' ? 'artifact-panel' : '' });
    let layout;
    const close = () => { layout.dispose(); panel.remove(); };
    layout = stack.mountStackedPane(host, panel, close, { kind }, mount);
    return { panel, layout, close };
  };
  const design = openPane('design'), background = openPane('background');
  assert.equal(roots, 1, 'two panes share one artifact registration');
  assert(stack.paneIsOpen(host, 'design')); assert(stack.paneIsOpen(host, 'background'));
  const rootPane = host.children[0], divider = rootPane.children.find(node => node.attrs.role === 'separator');
  assert.equal(divider.attrs['aria-orientation'], 'horizontal');
  divider.listeners.keydown({ key: 'End', preventDefault() {} }); assert.equal(divider.attrs['aria-valuenow'], '80');
  divider.listeners.keydown({ key: 'ArrowDown', preventDefault() {} }); assert.equal(divider.attrs['aria-valuenow'], '80');
  assert.equal(saved.get('kairos:chat-pane-split:a'), '80');
  design.layout.setMaximized(true); assert(maximized && background.panel.hidden);
  design.layout.setMaximized(false); assert(!maximized && !background.panel.hidden);
  design.close(); assert.equal(background.panel.style.flex, '1 1 0');
  const documents = openPane('documents'); assert(!documents.panel.classList.contains('artifact-panel'), 'only the shared root owns artifact layout');
  const computer = openPane('computer'); assert(!stack.paneIsOpen(host, 'documents')); assert(stack.paneIsOpen(host, 'computer'));
  window.innerWidth = 900; events.get('resize')();
  assert(!stack.paneIsOpen(host, 'background')); assert(stack.paneIsOpen(host, 'computer'), 'computer retains its existing narrow overlay');
  computer.close(); assert.equal(releases, 1); assert.equal(host.children.length, 0);
  window.innerWidth = 1440;
  const three = [openPane('design'), openPane('background'), openPane('documents')];
  assert.equal(host.children[0].children.filter(node => node.attrs.role === 'separator').length, 2, 'each stacked boundary has a separator');
  three.forEach(pane => pane.close());
  const { parseChatWindow } = await esm('static/js/chatWindowRoute.js');
  const id = 'abcdef012345';
  assert.deepEqual(parseChatWindow(`?window=chat&session=${id}`), { sessionId: id });
  for (const query of ['', '?window=chat', '?window=other&session=' + id, '?window=chat&session=https://example.com', '?window=chat&session=../escape']) assert.equal(parseChatWindow(query), null);
  for (const value of [null, {}, 12, '../file', 'https://example.com', 'abcdef012345/extra', 'a'.repeat(10000)]) assert.equal(validSessionId(value), false);
  let handler, created = [], writes = [], browserCloses = 0;
  class Window {
    constructor(options) { this.options = options; this.events = {}; this.sent = []; this.webContents = { mainFrame: {}, send: (...args) => this.sent.push(args), setWindowOpenHandler: fn => this.openHandler = fn, on: (type, fn) => this.events[type] = fn }; created.push(this); }
    on(type, fn) { this.events[type] = fn; }
    isDestroyed() { return false; }
    show() { this.shown = true; } focus() { this.focused = true; }
    getNormalBounds() { return { width: 1200, height: 800, x: 20, y: 20 }; }
    async loadURL(url) { this.url = url; }
  }
  const sender = {};
  const windows = installChatWindows({ ipcMain: { handle: (channel, fn) => { assert.equal(channel, 'chat:open-window'); handler = fn; } }, BrowserWindow: Window,
    app: { getPath: () => '/data' }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    fs: { readFileSync() { throw Error(); }, writeFileSync: (...args) => writes.push(args) }, path, backendUrl: 'http://127.0.0.1:7777', preload: '/app/preload.js', icon: () => null, isMainSender: e => e.sender === sender,
    createBrowser: () => ({ attach() {}, close() { browserCloses++; } }) });
  for (const invalid of ['https://evil.example', '../escape', '', null, 'abcdef012345?url=evil']) assert.equal((await handler({ sender }, invalid)).ok, false);
  assert.equal((await handler({ sender: {} }, id)).ok, false); assert.equal(created.length, 0);
  assert.equal((await handler({ sender }, id)).ok, true);
  const win = created[0];
  assert(windows.browserFor({ sender: win.webContents, senderFrame: win.webContents.mainFrame }));
  assert.equal(windows.browserFor({ sender: win.webContents, senderFrame: {} }), null);
  assert.deepEqual(win.options.webPreferences, { contextIsolation: true, nodeIntegration: false, preload: '/app/preload.js' });
  assert.equal(win.url, `http://127.0.0.1:7777/?window=chat&session=${id}`);
  assert.equal(win.openHandler({ url: 'https://evil.example' }).action, 'deny');
  assert.deepEqual(win.sent.at(-1), ['browser:open-request', 'https://evil.example']);
  let prevented = false; win.events['will-navigate']({ preventDefault() { prevented = true; } }, 'https://evil.example'); assert(prevented);
  await handler({ sender }, id); assert.equal(created.length, 1); assert(win.focused);
  assert.equal((await handler({ sender: win.webContents, senderFrame: {} }, id)).ok, false);
  assert.equal((await handler({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, id)).ok, true);
  win.events.close(); assert.equal(writes.length, 1);
  win.events.closed(); assert.equal(browserCloses, 1); await handler({ sender }, id); assert.equal(created.length, 2);
  const browserModule = { exports: {} };
  class NativeView {
    constructor(options) { this.options = options; let destroyed = false, url = ''; this.webContents = { isDestroyed: () => destroyed,
      close: () => destroyed = true, loadURL: value => url = value, getURL: () => url, getTitle: () => '', isLoading: () => false,
      on() {}, once() {}, setWindowOpenHandler() {} }; }
    setBackgroundColor() {} setVisible() {}
  }
  const electron = { WebContentsView: NativeView, session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {} }) }, shell: {} };
  new Function('require', 'module', fs.readFileSync(path.join(__dirname, '../electron/browser.js'), 'utf8'))(name => {
    // browser.js's own helpers (the address gate, sign-in pop-ups) are real; Electron is the stand-in.
    if (name === './browser-gate' || name === './browser-popups') return require(path.join(__dirname, '../electron', name));
    assert.equal(name, 'electron'); return electron;
  }, browserModule);
  const mainBrowser = browserModule.exports, chatBrowser = mainBrowser.createBrowser();
  const nativeHost = () => ({ isDestroyed: () => false, webContents: { send() {} }, contentView: { addChildView() {}, removeChildView() {} } });
  mainBrowser.attach(nativeHost()); chatBrowser.attach(nativeHost());
  mainBrowser.open('https://example.com/'); chatBrowser.open('https://example.org/');
  assert.notEqual(mainBrowser._webContents(), chatBrowser._webContents());
  chatBrowser.close(); assert(mainBrowser.isOpen()); assert(!chatBrowser.isOpen()); mainBrowser.close();
  console.log('PASS: pane open/close/stack, split clamps, per-user persistence, disabled storage, single-chat routes, IPC validation, secure window options, bounds and independent close.');
})().catch(error => { console.error(error); process.exitCode = 1; });
