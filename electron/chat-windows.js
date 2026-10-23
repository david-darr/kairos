// Only app-owned session routes, never a renderer-supplied URL.
const validSessionId = id => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);
function installChatWindows({ ipcMain, BrowserWindow, app, screen, fs, path, backendUrl, preload, icon, isMainSender, createBrowser }) {
  const windows = new Map();
  const browsers = new Map();
  const target = () => path.join(app.getPath('userData'), 'chat-window-bounds.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(target(), 'utf8')); } catch { /* First use. */ }
  const owns = event => [...windows.values()].some(win => !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  ipcMain.handle('chat:open-window', async (event, id) => {
    if (!validSessionId(id) || !(isMainSender(event) || owns(event))) return { ok: false, reason: 'Invalid session or sender' };
    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return { ok: true }; }
    const bounds = saved?.[id];
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.max(760, Math.min(area.width, Number(bounds?.width) || 1280));
    const height = Math.max(540, Math.min(area.height, Number(bounds?.height) || 900));
    const position = Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y) ? {
      x: Math.max(area.x, Math.min(area.x + area.width - width, bounds.x)),
      y: Math.max(area.y, Math.min(area.y + area.height - height, bounds.y)),
    } : {};
    const win = new BrowserWindow({ width, height, ...position, minWidth: 760, minHeight: 540,
      backgroundColor: '#F3EADB', title: 'Kairos · Chat', titleBarStyle: 'hidden', autoHideMenuBar: true, icon: icon(),
      ...(process.platform === 'win32' ? { titleBarOverlay: { color: '#EFE4D2', symbolColor: '#6B5646', height: 35 } } : {}),
      webPreferences: { contextIsolation: true, nodeIntegration: false, preload },
    });
    windows.set(id, win);
    const browser = createBrowser?.();
    if (browser) { browser.attach(win, { backendOrigin: new URL(backendUrl).origin }); browsers.set(win, browser); }
    win.webContents.setWindowOpenHandler(({ url }) => {
      try { if (/^https?:$/.test(new URL(url).protocol)) win.webContents.send('browser:open-request', url); } catch { /* Deny malformed URLs. */ }
      return { action: 'deny' };
    });
    win.on('resize', () => win.webContents.send('browser:host-resized'));
    const url = new URL(backendUrl); url.pathname = '/'; url.search = ''; url.hash = '';
    url.searchParams.set('window', 'chat'); url.searchParams.set('session', id);
    const guard = (event, destination) => { try { const parsed = new URL(destination); if (parsed.origin === url.origin && parsed.pathname === '/') return; } catch { /* Deny. */ } event.preventDefault(); };
    win.webContents.on('will-navigate', guard); win.webContents.on('will-redirect', guard);
    win.on('close', () => {
      saved = { ...saved, [id]: win.getNormalBounds() };
      try { fs.writeFileSync(target(), JSON.stringify(saved)); } catch { /* Best effort. */ }
    });
    win.on('closed', () => { browser?.close(); browsers.delete(win); windows.delete(id); });
    await win.loadURL(url.toString());
    return { ok: true };
  });
  const windowFor = event => [...windows.values()].find(win => !win.isDestroyed() && event.sender === win.webContents);
  return { owns, windowFor, browserFor: event => owns(event) ? browsers.get(windowFor(event)) : null };
}
module.exports = { validSessionId, installChatWindows };
