const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The notch page's only reach into the main process. Nothing here returns data
// from the system except the path of a folder the person dropped on it; the
// page gets its readings from the Kairos backend.
contextBridge.exposeInMainWorld("usageOverlay", {
  // Whether the pointer is over the pill or card: the window takes clicks only then.
  setInteractive: (on) => ipcRenderer.send("usage-overlay:interactive", !!on),
  // A chat can be opened by session id, or started with a draft to review; main checks both again (usage-overlay-navigation.js).
  openApp: (target = "home", detail = {}) => {
    if (["home", "chat", "settings", "notes", "talk", "attach"].includes(target)) ipcRenderer.send("usage-overlay:open-app", target, { sessionId: detail?.sessionId, draft: detail?.draft });
  },
  // Open one chat or one agent in Kairos (a panel's Open chat, a chip).
  openChat: (sessionId) => ipcRenderer.send("usage-overlay:open-chat", String(sessionId)),
  openAgent: (agentId) => ipcRenderer.send("usage-overlay:open-agent", String(agentId)),
  // The keyboard, only while the notch has a field open (electron/usage-overlay-focus.js).
  setFocus: (on) => ipcRenderer.send("usage-overlay:focus", !!on),
  // A dropped folder's path, for its broker grant (the page cannot read paths).
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  hide: () => ipcRenderer.send("usage-overlay:hide"),
  getConfig: () => ipcRenderer.invoke("usage-overlay:config"),
  onConfig: (handler) => ipcRenderer.on("usage-overlay:config", (_event, config) => handler(config)),
  onPointer: (handler) => ipcRenderer.on("usage-overlay:pointer", (_event, point) => handler(point)),
});
