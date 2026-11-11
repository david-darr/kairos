// electron/preload.js — the only bridge between the sandboxed renderer
// (contextIsolation: true, nodeIntegration: false, in main.js) and Node/OS
// capabilities. Exposes a small, fixed set of narrow functions, not a
// general IPC passthrough — the renderer can ask for exactly these specific
// things and nothing else, matching "trusted gateway, untrusted execution"
// from the harness architecture research (see JARVIS Plan / Harness
// Architecture Ideas).
//
// This file runs ONLY in the app's own window. The side browser's
// WebContentsView is created with no preload at all (electron/browser.js),
// so nothing below is reachable from a page opened in it — that separation
// is what keeps an arbitrary website from driving the app.

const { contextBridge, ipcRenderer } = require("electron");

// Each entry is a named function taking plain data, never a channel string
// supplied by the caller — a generic send(channel, ...) would hand the
// renderer the entire IPC surface and undo the point of this file.
contextBridge.exposeInMainWorld("jarvis", {
  openChatWindow: sessionId => ipcRenderer.invoke('chat:open-window', sessionId),
  forgeTerminal: {
    openExternal: url => ipcRenderer.invoke('forge-terminal:external', url),
  },
  // Library > Vault "Open in Obsidian" (2026-10-22): an obsidian://open URL
  // only; the main process re-checks its shape.
  vault: {
    openInObsidian: url => ipcRenderer.invoke('vault:obsidian', url),
  },
  forgePreview: {
    open: (id, url, bounds) => ipcRenderer.invoke('forge-preview:open', id, url, bounds),
    navigate: url => ipcRenderer.invoke('forge-preview:navigate', url),
    state: () => ipcRenderer.invoke('forge-preview:state'),
    openExternal: () => ipcRenderer.invoke('forge-preview:external'),
    back: () => ipcRenderer.send('forge-preview:back'),
    forward: () => ipcRenderer.send('forge-preview:forward'),
    reload: () => ipcRenderer.send('forge-preview:reload'),
    close: () => ipcRenderer.send('forge-preview:close'),
    setBounds: rect => ipcRenderer.send('forge-preview:bounds', rect),
    setWidth: width => ipcRenderer.send('forge-preview:width', width),
    setVisible: visible => ipcRenderer.send('forge-preview:visible', !!visible),
    onState: handler => {
      const wrapped = (_event, state) => handler(state);
      ipcRenderer.on('forge-preview:state', wrapped);
      return () => ipcRenderer.removeListener('forge-preview:state', wrapped);
    },
    onError: handler => {
      const wrapped = (_event, error) => handler(error);
      ipcRenderer.on('forge-preview:error', wrapped);
      return () => ipcRenderer.removeListener('forge-preview:error', wrapped);
    },
  },
  pickVaultFolder: () => ipcRenderer.invoke("pick-vault-folder"),
  // Two #rrggbb colors; main.js checks both and that the call came from this window.
  setTitleBar: (color, symbolColor) => ipcRenderer.send("window:title-bar", String(color), String(symbolColor)),
  // Liquid glass's see-through window; main.js checks the platform and the sender.
  setSeeThrough: on => ipcRenderer.send("window:see-through", !!on),
  openGoogleSignIn: (url) => ipcRenderer.invoke("google:open-sign-in", url),
  openSocialSignIn: (url) => ipcRenderer.invoke("social:open-sign-in", url),

  screenGrab: {
    capture: () => ipcRenderer.invoke("screen-grab:capture"),
    shortcut: () => ipcRenderer.invoke("screen-grab:shortcut"),
    onModelsRequest: (handler) => {
      const wrapped = (_event, requestId) => handler(requestId);
      ipcRenderer.on("screen-grab:models-request", wrapped);
      return () => ipcRenderer.removeListener("screen-grab:models-request", wrapped);
    },
    replyModels: (requestId, models) => ipcRenderer.send("screen-grab:models-reply", requestId, models),
    replyQuickDraft: (requestId, result) => ipcRenderer.send("screen-grab:quick-result", requestId, result),
    onQuickDraft: (handler) => {
      const wrapped = (_event, draft) => handler(draft);
      ipcRenderer.on("screen-grab:quick-draft", wrapped);
      return () => ipcRenderer.removeListener("screen-grab:quick-draft", wrapped);
    },
  },

  usageOverlay: {
    onNavigate: handler => {
      const wrapped = (_event, target, detail) => { if (["home", "chat", "settings", "notes", "talk", "attach"].includes(target)) handler(target, detail || {}); };
      ipcRenderer.on("usage-overlay:navigate", wrapped);
      return () => ipcRenderer.removeListener("usage-overlay:navigate", wrapped);
    },
    // The notch opens one chat or one agent (electron/main.js checks the id).
    onOpen: handler => {
      const chat = (_event, id) => handler({ tab: "chat", id }), agent = (_event, id) => handler({ tab: "agents", id });
      ipcRenderer.on("usage-overlay:open-chat", chat);
      ipcRenderer.on("usage-overlay:open-agent", agent);
      return () => { ipcRenderer.removeListener("usage-overlay:open-chat", chat); ipcRenderer.removeListener("usage-overlay:open-agent", agent); };
    },
    state: () => ipcRenderer.invoke("usage-overlay:state"),
    setVisible: (visible) => ipcRenderer.invoke("usage-overlay:set-visible", !!visible),
    setConfig: (changes) => ipcRenderer.invoke("usage-overlay:set-config", {
      edge: changes && changes.edge, foldOnHover: changes && changes.foldOnHover,
      offset: changes && changes.offset, displayId: changes && changes.displayId }),
    onState: (handler) => {
      const wrapped = (_event, state) => handler(state);
      ipcRenderer.on("usage-overlay:state", wrapped);
      return () => ipcRenderer.removeListener("usage-overlay:state", wrapped);
    },
  },

  // A desktop notification was clicked (Agents 2.0, 2026-10-14).
  showWindow: () => ipcRenderer.send("app:show"),

  // Raising a bot's approval level: the desktop shell asks you in its own prompt (electron/bot-approvals.js).
  botApprovals: { elevate: request => ipcRenderer.invoke("bot-approvals:elevate", request) },

  // Browse (Kairos Browser Phase 1). Controls and metadata only, like the
  // side browser below, except sharePage, which Ask Kairos calls only when
  // the person sends with "Share this page" ticked. Main checks the sender
  // and every argument (electron/browser-ipc.js).
  browse: (() => {
    const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
    const send = (channel) => (...args) => ipcRenderer.send(channel, ...args);
    // Each subscription returns its own unsubscribe; the raw event (which
    // carries `sender`) never reaches page code.
    const subscribe = (channel) => (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    };
    return {
      list: invoke("browse:list"), open: invoke("browse:open"), navigate: invoke("browse:navigate"),
      find: invoke("browse:find"), zoom: invoke("browse:zoom"), sharePage: invoke("browse:share-page"),
      activate: send("browse:activate"), close: send("browse:close"), reopenClosed: send("browse:reopen-closed"),
      back: send("browse:back"), forward: send("browse:forward"), reload: send("browse:reload"), stop: send("browse:stop"),
      pin: send("browse:pin"), mute: send("browse:mute"), reorder: send("browse:reorder"),
      setBounds: send("browse:bounds"), setVisible: (visible) => ipcRenderer.send("browse:visible", !!visible), shortcut: send("browse:shortcut"),
      suggest: invoke("browse:suggest"), history: invoke("browse:history"), deleteHistory: invoke("browse:history-delete"),
      clearHistory: invoke("browse:history-clear"), pinned: invoke("browse:pinned"), pinSite: invoke("browse:pin-site"),
      unpinSite: invoke("browse:unpin-site"), orderPinned: invoke("browse:pinned-order"),
      home: invoke("browse:home"), setHome: invoke("browse:home-set"), editPin: invoke("browse:pin-edit"),
      clearPinThumb: invoke("browse:pin-thumb-clear"), duplicate: invoke("browse:duplicate"),
      site: invoke("browse:site"), setSite: invoke("browse:site-set"), clearSite: invoke("browse:site-clear"),
      searchEngines: invoke("browse:search-engines"), setSearchEngine: invoke("browse:search-engine"), adblockStats: invoke("browse:adblock-stats"),
      answerPermission: send("browse:permission-answer"), permissions: invoke("browse:permissions"),
      // Screen sharing picker and the in-use indicator's Stop.
      answerScreen: send("browse:screen-answer"), stopCapture: invoke("browse:capture-stop"), onScreenRequest: subscribe("browse:screen-request"),
      downloads: invoke("browse:downloads"), download: invoke("browse:download"),
      // Password keeper: answers and actions only; no password ever comes back.
      answerPassword: invoke("browse:password-answer"), fillPassword: invoke("browse:password-fill"),
      useStrongPassword: invoke("browse:password-generate"), importPasswords: invoke("browse:passwords-import"),
      onPasswordOffer: subscribe("browse:password-offer"), onPasswordSuggest: subscribe("browse:password-suggest"),
      audioOutput: invoke("browse:audio"), setAudioOutput: invoke("browse:audio-set"),
      // Content Studio: open a prepared post's upload page and fill it (stops before the final button).
      preparePost: invoke("browse:prepare-post"), onPrepareProgress: subscribe("browse:prepare-progress"),
      onState: subscribe("browse:state"), onEvent: subscribe("browse:event"), onDownload: subscribe("browse:download"),
      onPermission: subscribe("browse:permission"), onShortcut: subscribe("browse:shortcut"),
    };
  })(),

  // Side browser (David's ask 2026-09-15). Controls only: nothing here can
  // read page content, and the main process re-validates every URL anyway
  // (electron/browser.js's safeUrl) rather than trusting this side.
  browser: {
    open: (url, bounds) => ipcRenderer.invoke("browser:open", url, bounds),
    navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
    state: () => ipcRenderer.invoke("browser:state"),
    openExternal: (url) => ipcRenderer.invoke("browser:external", url),
    back: () => ipcRenderer.send("browser:back"),
    forward: () => ipcRenderer.send("browser:forward"),
    reload: () => ipcRenderer.send("browser:reload"),
    close: () => ipcRenderer.send("browser:close"),
    setBounds: (rect) => ipcRenderer.send("browser:bounds", rect),
    setVisible: (visible) => ipcRenderer.send("browser:visible", !!visible),

    // Subscriptions return their own unsubscribe function. The raw event
    // object is never passed through: it carries a `sender` reference that
    // would leak an IPC handle straight into page scope.
    onState: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("browser:state", wrapped);
      return () => ipcRenderer.removeListener("browser:state", wrapped);
    },
    onError: (handler) => {
      const wrapped = (_event, payload) => handler(payload);
      ipcRenderer.on("browser:error", wrapped);
      return () => ipcRenderer.removeListener("browser:error", wrapped);
    },
    // Raised when an external link is activated in the app UI, so the
    // renderer can open the pane itself and keep its own layout in step.
    onOpenRequest: (handler) => {
      const wrapped = (_event, url) => handler(url);
      ipcRenderer.on("browser:open-request", wrapped);
      return () => ipcRenderer.removeListener("browser:open-request", wrapped);
    },
    onHostResized: (handler) => {
      const wrapped = () => handler();
      ipcRenderer.on("browser:host-resized", wrapped);
      return () => ipcRenderer.removeListener("browser:host-resized", wrapped);
    },
  },
});
