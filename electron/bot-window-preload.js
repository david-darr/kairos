const { contextBridge, ipcRenderer } = require("electron");

// The bot window's only reach into the main process: open a bot in the main
// window, or hide itself. Its data comes from the Kairos backend, like the app.
contextBridge.exposeInMainWorld("botWindow", {
  openAgent: (agentId) => ipcRenderer.send("bot-window:open-agent", String(agentId)),
  hide: () => ipcRenderer.send("bot-window:hide"),
});
