// The floating bot window (Agents 2.0, 2026-10-14): a small, always-on-top,
// movable window listing the bots that need the person. Off by default; opened
// from the tray or Settings. Unlike the usage overlay it takes clicks, so it is
// an ordinary frameless window the person drags by its title bar.
//
// Its position is remembered per display: moving it to another monitor and
// back puts it where it was on each. A saved spot on a display that is no
// longer connected falls back to the bottom-right of the main display.
const path = require("node:path");
const fs = require("node:fs");

const SIZE = { width: 300, height: 340 };
const MIN = { width: 240, height: 160 };
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function createBotWindow({ app, BrowserWindow, screen, ipcMain, backendUrl, showMain, sendToMain, onChange = () => {} }) {
  let win = null;
  let visible = false;
  let displayId = null;
  let saved = {};  // display id -> bounds
  let saveTimer = null;
  const file = () => path.join(app.getPath("userData"), "bot-window.json");

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file(), "utf8"));
      visible = data.visible === true;
      displayId = Number.isFinite(data.displayId) ? data.displayId : null;
      saved = data.bounds && typeof data.bounds === "object" ? data.bounds : {};
    } catch { visible = false; }
  }
  function save() {
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ visible, displayId, bounds: saved }));
    fs.renameSync(`${target}.tmp`, target);
  }
  function fallback() {
    const area = screen.getPrimaryDisplay().workArea;
    return { x: area.x + area.width - SIZE.width - 24, y: area.y + area.height - SIZE.height - 24, ...SIZE };
  }
  function boundsToShow() {
    const display = screen.getAllDisplays().find(d => d.id === displayId);
    const b = display && saved[String(displayId)];
    if (!b) return fallback();
    // Keep it reachable if the display's work area shrank since it was saved.
    const area = display.workArea;
    const width = Math.max(MIN.width, Math.min(b.width, area.width));
    const height = Math.max(MIN.height, Math.min(b.height, area.height));
    return {
      x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
      y: Math.min(Math.max(b.y, area.y), area.y + area.height - height), width, height,
    };
  }
  function remember() {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getBounds();
      displayId = screen.getDisplayMatching(b).id;
      saved[String(displayId)] = b;
      save();
    }, 300);
  }
  function state() { return { visible }; }

  async function build() {
    // Rounded corners need a transparent window; Linux compositors vary, so
    // there it is an opaque window with square corners instead.
    const transparent = process.platform !== "linux";
    win = new BrowserWindow({
      ...boundsToShow(), minWidth: MIN.width, minHeight: MIN.height,
      frame: false, transparent, backgroundColor: transparent ? "#00000000" : "#fbf6ee",
      alwaysOnTop: true, skipTaskbar: true, resizable: true, show: false, title: "Kairos bots",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: path.join(__dirname, "bot-window-preload.js") },
    });
    win.setAlwaysOnTop(true, "floating");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== `${backendUrl}/bot-window`) event.preventDefault();
    });
    win.on("moved", remember);
    win.on("resized", remember);
    win.on("closed", () => { win = null; });
    await win.loadURL(`${backendUrl}/bot-window`);
  }

  async function setVisible(on, { backendReady = true } = {}) {
    visible = !!on;
    save();
    if (visible && backendReady) {
      if (!win || win.isDestroyed()) await build();
      win.showInactive();
    } else if (win && !win.isDestroyed()) {
      win.hide();
    }
    onChange(state());
    return state();
  }

  const fromBotWindow = event => !!win && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.on("bot-window:open-agent", (event, agentId) => {
    if (!fromBotWindow(event) || typeof agentId !== "string" || !AGENT_ID.test(agentId)) return;
    showMain();
    sendToMain("bot-window:open-agent", agentId);
  });
  ipcMain.on("bot-window:hide", (event) => { if (fromBotWindow(event)) setVisible(false).catch(console.error); });

  load();
  return { state, setVisible, isVisible: () => visible, restore: () => (visible ? setVisible(true) : Promise.resolve(state())) };
}

module.exports = { createBotWindow };
