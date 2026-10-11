const { contextBridge, ipcRenderer } = require("electron");

// The notch page's only reach into the main process. Nothing here returns data
// from the system; the page gets its readings from the Kairos backend.
contextBridge.exposeInMainWorld("usageOverlay", {
  // Whether the pointer is over the pill or card: the window takes clicks only then.
  setInteractive: (on) => ipcRenderer.send("usage-overlay:interactive", !!on),
  openApp: () => ipcRenderer.send("usage-overlay:open-app"),
  hide: () => ipcRenderer.send("usage-overlay:hide"),
  // The main process reads the native cursor in DIPs; DOM screen coordinates
  // are not used for placement on mixed-DPI monitors.
  moveStart: () => ipcRenderer.send("usage-overlay:move-start"),
  moveTo: () => ipcRenderer.send("usage-overlay:move-to"),
  moveEnd: () => ipcRenderer.send("usage-overlay:move-end"),
  getConfig: () => ipcRenderer.invoke("usage-overlay:config"),
  onConfig: (handler) => ipcRenderer.on("usage-overlay:config", (_event, config) => handler(config)),
  onPointer: (handler) => ipcRenderer.on("usage-overlay:pointer", (_event, point) => handler(point)),
});
