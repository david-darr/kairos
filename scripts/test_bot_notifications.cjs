// Desktop bot notifications (static/js/botNotifications.js) and the floating
// bot window's lifecycle (electron/bot-window.js), tested without a browser or
// Electron: the first is pure, the second is driven with stand-ins.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  // -- notifications ------------------------------------------------------
  const storage = new Map();
  global.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) };
  const code = fs.readFileSync(path.join(__dirname, '../static/js/botNotifications.js'), 'utf8');
  const N = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const inbox = (items = [], reviews = []) => ({ items, reviews });
  const q = (id, agent, title = 'A question') => ({ id, agent_id: agent, kind: 'question', title });
  const r = (id, agent, title = 'A report') => ({ id, agent_id: agent, kind: 'report', title });
  const names = async () => ({ a1: 'Scout', a2: 'Archivist' });

  let shown = [];
  let focused = null;
  const watch = N.createWatcher({ show: n => shown.push(n), names, focusedAgentId: () => focused });
  assert.deepEqual(await watch(inbox([q('i1', 'a1')])), [], 'the first poll only learns the backlog');
  assert.deepEqual(shown, []);

  await watch(inbox([q('i1', 'a1'), q('i2', 'a1', 'Pick a slot'), r('i3', 'a1'), r('i4', 'a1')]));
  assert.equal(shown.length, 1, 'three new items from one bot are one notification');
  assert.equal(shown[0].title, 'Scout needs you', 'needs-you outranks results');
  assert.equal(shown[0].body, 'Pick a slot (and 2 more)');

  shown = [];
  await watch(inbox([q('i1', 'a1'), q('i2', 'a1'), r('i3', 'a1'), r('i4', 'a1')], [{ id: 'c1', agent_id: 'a2', name: 'Shortlist' }]));
  assert.deepEqual(shown.map(n => [n.title, n.body]), [['Archivist has results', 'Shortlist']], 'a review is a result');

  shown = [];
  await watch(inbox([q('i1', 'a1')]));
  assert.deepEqual(shown, [], 'items going away notify nothing');

  shown = []; focused = 'a1';
  await watch(inbox([q('i1', 'a1'), q('i9', 'a1'), q('i10', 'a2')]));
  assert.deepEqual(shown.map(n => n.agentId), ['a2'], 'no notification for the bot on screen');

  shown = []; focused = null;
  N.savePrefs({ needs_you: false });
  await watch(inbox([q('i1', 'a1'), q('i9', 'a1'), q('i10', 'a2'), q('i11', 'a2'), r('i12', 'a2')]));
  assert.deepEqual(shown.map(n => n.title), ['Archivist has results'], 'a turned-off kind is skipped');
  N.savePrefs({ needs_you: true, enabled: false });
  shown = [];
  await watch(inbox([q('i1', 'a1'), q('i13', 'a1')]));
  assert.deepEqual(shown, [], 'the master switch turns them all off');

  // -- the bot window controller -------------------------------------------
  const { createBotWindow } = require('../electron/bot-window.js');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-botwin-'));
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } },
  ];
  const handlers = {};
  const windows = [];
  class FakeWindow {
    constructor(options) { this.options = options; this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.events = {}; this.shown = false; this.webContents = { setWindowOpenHandler() {}, on() {} }; windows.push(this); }
    setAlwaysOnTop() {} on(name, fn) { this.events[name] = fn; } async loadURL(url) { this.url = url; }
    showInactive() { this.shown = true; } hide() { this.shown = false; } isDestroyed() { return false; }
    getBounds() { return this.bounds; }
  }
  const screen = {
    getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0],
    getDisplayMatching: b => displays.find(d => b.x >= d.workArea.x && b.x < d.workArea.x + d.workArea.width) || displays[0],
  };
  const opened = [];
  const make = () => createBotWindow({
    app: { getPath: () => userData }, BrowserWindow: FakeWindow, screen,
    ipcMain: { on: (channel, fn) => { handlers[channel] = fn; } }, backendUrl: 'http://127.0.0.1:8430',
    showMain: () => opened.push('show'), sendToMain: (channel, id) => opened.push(`${channel}:${id}`),
  });

  const first = make();
  assert.equal(first.isVisible(), false, 'off by default');
  await first.setVisible(true);
  const win = windows.at(-1);
  assert.equal(win.url, 'http://127.0.0.1:8430/bot-window');
  assert.deepEqual([win.bounds.x, win.bounds.y], [1920 - 300 - 24, 1040 - 340 - 24], 'first opening: bottom-right of the main display');
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);

  // Moved to the second display: remembered there.
  win.bounds = { x: 2100, y: 120, width: 320, height: 360 };
  win.events.moved();
  await new Promise(resolve => setTimeout(resolve, 350));
  const reopened = make();  // a fresh start reads the saved position
  assert.equal(reopened.isVisible(), true, 'visibility survives a restart');
  await reopened.restore();
  assert.deepEqual(windows.at(-1).bounds, { x: 2100, y: 120, width: 320, height: 360 }, 'position remembered on its display');

  // That display unplugged: back to the main display rather than off-screen.
  displays.pop();
  const unplugged = make();
  await unplugged.restore();
  assert.equal(windows.at(-1).bounds.x, 1920 - 300 - 24, 'a missing display falls back to the main one');

  // Only the bot window may ask to open a bot, and only with a plausible id.
  const sender = windows.at(-1).webContents;
  handlers['bot-window:open-agent']({ sender: {} }, 'a1');
  handlers['bot-window:open-agent']({ sender }, '../../etc');
  assert.deepEqual(opened, [], 'other senders and malformed ids are ignored');
  handlers['bot-window:open-agent']({ sender }, 'a1');
  assert.deepEqual(opened, ['show', 'bot-window:open-agent:a1']);

  fs.rmSync(userData, { recursive: true, force: true });
  console.log('Bot notifications coalesce and respect focus and settings; the bot window remembers its place.');
})().catch(error => { console.error(error); process.exit(1); });
