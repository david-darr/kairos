// electron/browser.js — the in-app side browser (David's ask 2026-09-15).
//
// A real Chromium view hosted inside the app window, not an iframe: iframes
// can't show most of the web, because any site sending X-Frame-Options or a
// frame-ancestors CSP simply refuses to render in one. The plain-HTTP web
// client still falls back to an iframe (see static/js/browserPane.js) and is
// honest about that limit; this file is the desktop half that doesn't have it.
//
// The whole design point is that a remote page gets NONE of JARVIS's
// privileges. The app's own renderer is trusted: it talks to a loopback
// backend that holds the user's vault, credentials, and agent tools. An
// arbitrary website must never be able to reach any of that, so:
//
//   - It runs on its own session partition, which means its own cookie jar
//     and storage. A site cannot see the app's session, and signing into
//     something here never touches JARVIS's own auth.
//   - No preload script and no node integration, so there is no bridge
//     object to find. sandbox: true keeps it in a real OS sandbox.
//   - Only http/https ever load. file:, data:, blob: and friends are refused
//     outright rather than filtered, so there is nothing clever to smuggle.
//   - Loopback is blocked entirely. The backend lives on 127.0.0.1 and is
//     the privileged surface this feature must never expose; other local
//     ports may be someone else's admin panel, so the whole range is off
//     rather than just the one port we happen to know about.
//   - Every permission request (camera, mic, location, notifications, ...)
//     is denied without prompting. A prompt raised by an untrusted page,
//     inside the app's own window, would read as JARVIS asking.
//   - Nothing here gives the agent access to page content. This is a viewer
//     for the person using the app; no tool reads from it.
//
// Lifecycle matters as much as the sandbox. A WebContentsView is a NATIVE
// layer composited above the HTML, so it ignores z-index and would otherwise
// paint straight through Settings, modals, and menus — hide() exists for
// exactly that, and callers use it rather than trying to out-stack it in CSS.
// The view is destroyed on close, on session switch, and on app quit, so a
// page can't keep running (or keep playing audio) behind the app.

const { WebContentsView, session, shell } = require("electron");
const { createGate, isLoopback } = require("./browser-gate");
const { createPopups } = require("./browser-popups");

// Browse (browser-browse.js) shares this partition so the person's sign-ins
// carry over, and installs its own handlers on it: per-site permission
// prompts limited to Browse tabs, downloads saved with the internet mark,
// the ad blocker. Once it has, the pane must not overwrite them with its
// deny-all set. Shared by every pane instance (main window and detached
// chats), so it lives outside createBrowser.
// Multi-account: each Kairos account has its own profile partition (the
// first admin keeps persist:jarvis-browser, so existing sign-ins stay), and
// main.js points every pane at the signed-in account's with setPartition().
// Browse owns the handlers of each partition it has taken over.
const DEFAULT_PARTITION = "persist:jarvis-browser";
let activePartition = DEFAULT_PARTITION;
const ownedByBrowse = new Set();
function shareSession(name = activePartition) { ownedByBrowse.add(name); }
function setPartition(name) { if (typeof name === "string" && name.startsWith("persist:jarvis-browser")) activePartition = name; return activePartition; }
// Sessions that already have the pane's download hand-off. Adding it on
// every create() stacked one listener per opening, so a single download was
// handed to the system browser once per time the pane had been opened.
const handedOff = new WeakSet();

// Each detached chat owns its native view; closing it cannot close the
// main window's browser. The isolated site session and all gates are shared.
function createBrowser() {

// persist: so a signed-in site survives closing the pane, matching what a
// browser does. Deliberately NOT the app's default session — that separation
// is the cookie-isolation guarantee above, not an implementation detail.
// PARTITION is the default (first admin's) profile; the live one is
// activePartition above.
const PARTITION = DEFAULT_PARTITION;

let view = null;
let host = null;
let backendOrigin = null;
let notify = () => {};

// The address rules live in browser-gate.js, shared with Browse tabs. The
// side pane keeps the strict policy: no loopback at all.
const gate = createGate();
const safeUrl = (raw) => gate.safeUrl(raw, { allowLoopback: false });
const fromAddressBar = (input) => gate.fromAddressBar(input, { allowLoopback: false });

// Navigation history moved from webContents onto webContents.navigationHistory
// across Electron versions, and the two overlap: on the version bundled here
// (31.x) the navigationHistory OBJECT already exists while its canGoBack /
// goBack methods do not. Detecting the object rather than the method is
// therefore wrong, and wrong in a way that is easy to miss — state() is
// called from push(), which is wired to half a dozen load events, so the
// TypeError fires inside Electron's own event dispatch and wedges the page
// load rather than surfacing as a clean error. Found exactly that way by
// scripts/browser-smoke.cjs. Always feature-detect the method.
function navMethod(wc, name) {
  const nav = wc.navigationHistory;
  if (nav && typeof nav[name] === "function") return nav[name].bind(nav);
  if (typeof wc[name] === "function") return wc[name].bind(wc);
  return null;
}

function state() {
  if (!view || view.webContents.isDestroyed()) return { open: false };
  const wc = view.webContents;
  const canBack = navMethod(wc, "canGoBack");
  const canForward = navMethod(wc, "canGoForward");
  return {
    open: true,
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: canBack ? canBack() : false,
    canGoForward: canForward ? canForward() : false,
  };
}

// Called from webContents event handlers, so it runs inside Electron's own
// event dispatch. Anything that throws here propagates into that dispatch
// and can stall the page load itself rather than surfacing as a clean error
// — which is precisely what a version-detection bug in state() did. A status
// update is never worth breaking navigation over.
function push() {
  try {
    if (host && !host.isDestroyed()) host.webContents.send("browser:state", state());
  } catch { /* status is best-effort */ }
}

// Named rather than inline so scripts/browser-smoke.cjs can assert the real
// shipped logic denies, instead of only checking that a handler was
// installed. Every permission Chromium can ask for is refused without a
// prompt: a permission dialog raised by an arbitrary site, inside JARVIS's
// own window, would read as JARVIS asking for the microphone.
function denyPermissionRequest(_wc, _permission, callback) { callback(false); }
function denyPermissionCheck() { return false; }
function denyDevicePermission() { return false; }

function buildSession() {
  const name = activePartition;
  const partition = session.fromPartition(name);
  if (ownedByBrowse.has(name)) return partition;
  partition.setPermissionRequestHandler(denyPermissionRequest);
  partition.setPermissionCheckHandler(denyPermissionCheck);
  // Device pickers are a separate path from the permission handlers above.
  partition.setDevicePermissionHandler(denyDevicePermission);
  return partition;
}

function create() {
  const browserSession = buildSession();
  view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      // No preload: there is deliberately no bridge for a page to find.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      // webSecurity is left ON. Turning it off to "make sites work" would
      // hand every page the same-origin policy as a weapon.
      spellcheck: false,
    },
  });
  view.setBackgroundColor("#ffffff");

  const wc = view.webContents;

  // target=_blank and window.open stay inside this pane when they're
  // ordinary web links, and are refused otherwise. Never a real new window:
  // that would be a chrome-less Electron window with no address bar, which
  // is precisely the shape a phishing page wants.
  //
  // The exception is a sign-in pop-up (a sized window.open, as OAuth uses):
  // it opens as a real child window on this profile with window.opener kept,
  // so it can hand its result back and close (browser-popups.js). It shows
  // the site's address in its title bar.
  const popups = createPopups({ host: () => host, session: browserSession, safe: safeUrl, openTab: (url) => wc.loadURL(url) });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const safe = safeUrl(url);
    if (safe && disposition === "new-window") return popups.allow();
    if (safe) wc.loadURL(safe);
    return { action: "deny" };
  });
  wc.on("did-create-window", (child) => popups.wire(child, null));
  wc.once("destroyed", () => popups.closeAll());

  // Covers redirects and in-page navigation, not just what the user typed.
  wc.on("will-navigate", (event, url) => {
    if (!safeUrl(url)) {
      event.preventDefault();
      push();
    }
  });
  wc.on("will-redirect", (event, url) => {
    if (!safeUrl(url)) event.preventDefault();
  });

  // A download inside a sandboxed pane would write to disk with the app's
  // privileges. Hand the URL to the real browser instead, where the user's
  // normal download UI and safe-browsing checks apply.
  const partitionName = activePartition;
  if (!ownedByBrowse.has(partitionName) && !handedOff.has(browserSession)) {
    handedOff.add(browserSession);
    browserSession.on("will-download", (event, item) => {
      // Browse may have taken the session over since this was added.
      if (ownedByBrowse.has(partitionName)) return;
      event.preventDefault();
      const safe = safeUrl(item.getURL());
      if (safe) shell.openExternal(safe).catch(() => {});
    });
  }

  for (const evt of ["did-navigate", "did-navigate-in-page", "did-finish-load", "did-stop-loading", "did-start-loading", "page-title-updated"]) {
    wc.on(evt, push);
  }
  wc.on("did-fail-load", (_e, code, description, failedUrl, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires routinely when a navigation is
    // superseded — not a failure worth showing anyone.
    if (!isMainFrame || code === -3) return;
    if (host && !host.isDestroyed()) {
      host.webContents.send("browser:error", { code, description, url: failedUrl });
    }
  });

  host.contentView.addChildView(view);
  return view;
}

function attach(window, options = {}) {
  host = window;
  backendOrigin = options.backendOrigin || null;
  gate.setBackendOrigin(backendOrigin);
  notify = options.notify || (() => {});
}

function open(rawUrl, bounds) {
  if (!host || host.isDestroyed()) return { ok: false, reason: "no window" };
  // An empty address (Browse the web) opens a blank pane for the address bar to fill.
  const blank = !String(rawUrl || "").trim();
  const target = blank ? null : fromAddressBar(rawUrl);
  if (!blank && !target) return { ok: false, reason: "That address can't be opened here." };
  if (!view || view.webContents.isDestroyed()) create();
  if (bounds) setBounds(bounds);
  view.setVisible(true);
  if (target) view.webContents.loadURL(target);
  push();
  return { ok: true, url: target || "" };
}

function navigate(rawUrl) {
  if (!view || view.webContents.isDestroyed()) return { ok: false, reason: "not open" };
  const target = fromAddressBar(rawUrl);
  if (!target) return { ok: false, reason: "That address can't be opened here." };
  view.webContents.loadURL(target);
  push();
  return { ok: true, url: target };
}

// Rounded to whole pixels: the renderer measures with getBoundingClientRect,
// which returns fractions, and a native view placed on a fractional boundary
// shimmers against the HTML behind it.
function setBounds(rect) {
  if (!view || view.webContents.isDestroyed() || !rect) return;
  view.setBounds({
    x: Math.round(rect.x || 0),
    y: Math.round(rect.y || 0),
    width: Math.max(0, Math.round(rect.width || 0)),
    height: Math.max(0, Math.round(rect.height || 0)),
  });
}

// Used whenever HTML must appear above the pane — Settings, modals, menus.
// A native view is composited over the page, so this is the only thing that
// actually works; no amount of z-index will.
function setVisible(visible) {
  if (!view || view.webContents.isDestroyed()) return;
  view.setVisible(!!visible);
}

function goBack() {
  if (!view || view.webContents.isDestroyed()) return;
  const can = navMethod(view.webContents, "canGoBack");
  const go = navMethod(view.webContents, "goBack");
  if (can && go && can()) go();
}

function goForward() {
  if (!view || view.webContents.isDestroyed()) return;
  const can = navMethod(view.webContents, "canGoForward");
  const go = navMethod(view.webContents, "goForward");
  if (can && go && can()) go();
}

function reload() {
  if (view && !view.webContents.isDestroyed()) view.webContents.reload();
}

async function openExternalUrl(raw) {
  if (typeof raw !== "string" || raw.length > 4000) return { ok: false };
  const safe = safeUrl(raw);
  if (!safe) return { ok: false };
  const url = new URL(safe);
  if (url.protocol !== "https:" || url.username || url.password) return { ok: false };
  try {
    await shell.openExternal(url.toString());
    return { ok: true };
  } catch { return { ok: false }; }
}

function openExternal() {
  if (!view || view.webContents.isDestroyed()) return { ok: false };
  const safe = safeUrl(view.webContents.getURL());
  if (!safe) return { ok: false };
  shell.openExternal(safe).catch(() => {});
  return { ok: true };
}

// Fully torn down, not merely hidden: a hidden view keeps running scripts,
// timers, and audio. Called on pane close, on chat-session switch, and on
// app quit.
function close() {
  if (!view) return;
  const current = view;
  view = null;
  try {
    if (host && !host.isDestroyed()) host.contentView.removeChildView(current);
  } catch { /* window already gone */ }
  try {
    const wc = current.webContents;
    if (!wc.isDestroyed()) {
      if (typeof wc.close === "function") wc.close();
      else wc.destroy();
    }
  } catch { /* already torn down */ }
  push();
  notify("closed");
}

function isOpen() {
  return !!(view && !view.webContents.isDestroyed());
}

async function captureStill() {
  if (!isOpen()) return null;
  return view.webContents.capturePage();
}

return {
  PARTITION, attach, open, navigate, setBounds, setVisible,
  goBack, goForward, reload, openExternal, openExternalUrl, close, isOpen, state, captureStill,
  // Exported for scripts/browser-smoke.cjs, which asserts the blocking rules
  // directly rather than inferring them from behaviour. _webContents lets
  // that suite run JS inside the loaded page to prove the sandbox is real —
  // the one claim that cannot be checked from outside.
  _safeUrl: safeUrl, _fromAddressBar: fromAddressBar, _isLoopback: isLoopback,
  _denyPermissionRequest: denyPermissionRequest,
  _denyPermissionCheck: denyPermissionCheck,
  _denyDevicePermission: denyDevicePermission,
  _webContents: () => (view && !view.webContents.isDestroyed() ? view.webContents : null),
};
}
module.exports = Object.assign(createBrowser(), { createBrowser, shareSession, setPartition, partition: () => activePartition });
