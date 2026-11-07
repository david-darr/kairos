// electron/browser-tabs.js — Browse's tabs (vault: "Kairos Browser - Phase 1
// (Build Spec)", U1).
//
// One WebContentsView per live tab, on the person's profile partition. The
// isolation rules are browser.js's, unchanged: no preload, no node, sandbox
// on, web security on, http/https only through browser-gate.js. What a daily
// browser adds on top:
//   - several tabs, pinned and muted ones, reopen closed, session restore;
//   - pop-ups and target=_blank become tabs, but only right after the
//     person clicked or typed (or where the site is allowed pop-ups);
//   - background tabs over a limit are discarded (the view destroyed, the
//     address kept) and come back when selected;
//   - history, zoom per site, find, print, devtools, ad blocking.
// The renderer only ever sees tab metadata through notify(); page content
// never leaves the view.

const { WebContentsView } = require("electron");
const { createPopups } = require("./browser-popups");

const LIVE_LIMIT = 12;           // views kept alive besides the active tab
// How long a click or key counts as "the person asked": Chrome's transient
// user activation lasts 5 s, and sign-in buttons often fetch before they open
// their window (David, 2026-11-06: "apps that open a new tab to signin").
const GESTURE_MS = 5000;
const CLOSED_LIMIT = 25;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const FAVICON_MAX = 64 * 1024;

// Ctrl/Cmd shortcuts Browse handles even while a page has focus.
function shortcutFor(input) {
  if (input.type !== "keyDown") return null;
  const mod = input.control || input.meta;
  const key = String(input.key || "").toLowerCase();
  if (key === "f5" || (mod && key === "r")) return input.shift ? "hard-reload" : "reload";
  if (key === "f12" || (mod && input.shift && key === "i")) return "devtools";
  if (input.alt && key === "arrowleft") return "back";
  if (input.alt && key === "arrowright") return "forward";
  if (key === "escape") return "escape";
  if (!mod) return null;
  if (key === "t") return input.shift ? "reopen-closed" : "new-tab";
  if (key === "w") return "close-tab";
  if (key === "l") return "focus-address";
  if (key === "f") return "find";
  if (key === "p") return "print";
  if (key === "tab") return input.shift ? "previous-tab" : "next-tab";
  if (key === "=" || key === "+") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (key === "0") return "zoom-reset";
  return null;
}

function nextZoom(current, direction) {
  if (direction === 0) return 1;
  const i = ZOOM_STEPS.findIndex((z) => z >= current - 0.001);
  const at = i < 0 ? ZOOM_STEPS.length - 1 : i;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + direction))];
}

// "#abc", "#aabbcc" or "rgb(…)" from a page, as "#rrggbb"; anything else is null.
function hexColor(value) {
  const text = String(value || "").trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(text);
  if (m) return "#" + m[1].split("").map((c) => c + c).join("");
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text);
  if (m) return "#" + m.slice(1, 4).map((v) => Math.min(255, Number(v)).toString(16).padStart(2, "0")).join("");
  return null;
}

function createTabs({ host, session: partitionSession, gate, store, adblock, notify = () => {}, onShortcut = () => {}, onTabContents = () => {} }) {
  const tabs = new Map();
  let order = [];
  let activeId = null;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let visible = false;
  let nextId = 1;
  const closed = [];
  const blockedCounts = new Map();
  let saveTimer = null;

  const allow = { allowLoopback: true };
  const safe = (url) => gate.safeUrl(url, allow);
  // Sign-in pop-ups (window.open with a size, as OAuth uses) open as real
  // child windows on this same profile, with window.opener kept, and close
  // back to the page that opened them (browser-popups.js).
  const popups = createPopups({ host, session: partitionSession, safe, openTab: (url, opener) => open(url, { opener }) });

  function meta(tab) {
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null;
    const nav = wc && wc.navigationHistory;
    return {
      id: tab.id, url: wc ? wc.getURL() || tab.url : tab.url, title: wc ? wc.getTitle() || tab.title : tab.title,
      favicon: tab.favicon || null, pinned: tab.pinned, muted: tab.muted, audible: wc ? wc.isCurrentlyAudible() : false,
      loading: wc ? wc.isLoading() : false, discarded: !wc, active: tab.id === activeId,
      canGoBack: !!(nav && nav.canGoBack && nav.canGoBack()), canGoForward: !!(nav && nav.canGoForward && nav.canGoForward()),
      zoom: wc ? wc.getZoomFactor() : 1, blocked: blockedCounts.get(tab.id) || 0,
      // Chameleon (Browse's look): the site's declared theme colour, else one
      // sampled from the top of the page.
      color: tab.themeColor || tab.sampledColor || null,
    };
  }

  function emit() {
    try { notify({ tabs: order.map((id) => meta(tabs.get(id))), activeId }); } catch { /* status is best-effort */ }
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { store.saveSession(order.map((id) => { const m = meta(tabs.get(id)); return { url: m.url, title: m.title, pinned: m.pinned }; }).filter((t) => safe(t.url))); }
      catch (err) { console.error(`[browser] could not save the session: ${err.message}`); }
    }, 500);
  }

  // Favicons are fetched here and handed over as data: URLs, because the
  // app's own page only loads images from itself (its CSP).
  async function loadFavicon(tab, urls) {
    const url = (urls || []).find((u) => safe(u));
    if (!url) return;
    try {
      const response = await partitionSession.fetch(url, { redirect: "follow" });
      const type = response.headers.get("content-type") || "";
      if (!response.ok || !/^image\//.test(type)) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > FAVICON_MAX) return;
      tab.favicon = `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
      emit();
    } catch { /* no icon */ }
  }

  // Speed Dial pictures: when a pinned site finishes loading in the tab on
  // screen, a small JPEG of it is kept for its home-screen tile. Only the
  // visible tab is captured, since a hidden view paints nothing.
  const THUMB_WIDTH = 400, THUMB_MAX = 80 * 1024;
  function captureTile(tab) {
    setTimeout(async () => {
      try {
        const wc = tab.view && tab.view.webContents;
        if (!wc || wc.isDestroyed() || tab.id !== activeId || !visible) return;
        const pin = store.pinnedFor(wc.getURL());
        if (!pin) return;
        const image = await wc.capturePage();
        if (image.isEmpty()) return;
        const jpeg = image.resize({ width: THUMB_WIDTH, quality: "good" }).toJPEG(70);
        if (jpeg.length > THUMB_MAX) return;
        store.setThumb(pin.id, `data:image/jpeg;base64,${jpeg.toString("base64")}`);
        notify({ event: "home-changed" });
      } catch { /* a picture is a nicety */ }
    }, 1500);
  }

  // A page with no theme colour gets one sampled from a strip along its top,
  // averaged to a single pixel. Only the visible tab paints, so only it is
  // sampled; the others are sampled when they're next shown.
  async function sampleColor(tab) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed() || tab.themeColor || tab.id !== activeId || !visible) return;
      const strip = await wc.capturePage({ x: 0, y: 0, width: Math.max(1, Math.round(bounds.width)), height: 12 });
      if (strip.isEmpty()) return;
      const px = strip.resize({ width: 1, height: 1, quality: "good" }).toBitmap(); // BGRA
      tab.sampledColor = "#" + [px[2], px[1], px[0]].map((v) => v.toString(16).padStart(2, "0")).join("");
      emit();
    } catch { /* no colour, the look stays as it is */ }
  }

  function applyZoom(tab) {
    const wc = tab.view && tab.view.webContents;
    if (!wc || wc.isDestroyed()) return;
    const saved = Number(store.getSite(wc.getURL(), "zoom"));
    wc.setZoomFactor(saved > 0 ? saved : 1);
  }

  function applyCosmetics(tab) {
    const wc = tab.view && tab.view.webContents;
    if (!wc || wc.isDestroyed() || !adblock) return;
    const url = wc.getURL();
    if (store.getSite(url, "adblock") === "off") return;
    let host = "";
    try { host = new URL(url).hostname; } catch { return; }
    const css = adblock.cosmeticCss(host);
    if (css) wc.insertCSS(css, { cssOrigin: "user" }).catch(() => {});
  }

  function wire(tab) {
    const wc = tab.view.webContents;
    // Pop-ups and target=_blank: a new tab, only if the person just acted
    // or the site is allowed pop-ups. Never a real window.
    // Pop-ups and target=_blank, only if the person just acted or the site is
    // allowed pop-ups. A sized window.open (a sign-in pop-up) becomes a real
    // child window; anything else becomes a Browse tab. Both keep the page's
    // window.opener (unless the page itself asked for noopener), so a sign-in
    // can postMessage its result back and close itself, as in Chrome.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const target = safe(url);
      const asked = Date.now() - tab.lastGesture < GESTURE_MS || store.getSite(wc.getURL(), "popups") === "allow";
      if (!target) return { action: "deny" };
      if (!asked) { notify({ event: "popup-blocked", tabId: tab.id, url: target }); return { action: "deny" }; }
      if (disposition === "new-window") return popups.allow();
      return { action: "allow", createWindow: (options) => adopt(options, target, { background: disposition === "background-tab", opener: tab.id }) };
    });
    wc.on("did-create-window", (child) => popups.wire(child, tab.id));
    wc.on("will-navigate", (event, url) => { if (!safe(url)) { event.preventDefault(); emit(); } });
    wc.on("will-redirect", (event, url) => { if (!safe(url)) event.preventDefault(); });
    wc.on("input-event", (_e, input) => {
      if (["mouseDown", "keyDown", "rawKeyDown", "touchStart", "gestureTap"].includes(input.type)) tab.lastGesture = Date.now();
    });
    wc.on("before-input-event", (event, input) => {
      const name = shortcutFor(input);
      if (!name) return;
      event.preventDefault();
      handleShortcut(name, tab.id);
    });
    wc.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) blockedCounts.set(tab.id, 0); });
    wc.on("did-navigate", (_e, url) => { store.addVisit(url, wc.getTitle()); applyZoom(tab); emit(); });
    wc.on("did-navigate-in-page", (_e, url, isMainFrame) => { if (isMainFrame) store.addVisit(url, wc.getTitle()); emit(); });
    wc.on("page-title-updated", (_e, title) => { tab.title = title; store.setTitle(wc.getURL(), title); emit(); });
    wc.on("page-favicon-updated", (_e, urls) => { loadFavicon(tab, urls); });
    wc.on("dom-ready", () => applyCosmetics(tab));
    wc.on("did-finish-load", () => { captureTile(tab); sampleColor(tab); });
    wc.on("did-change-theme-color", (_e, color) => { tab.themeColor = hexColor(color); emit(); });
    wc.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) { tab.themeColor = null; tab.sampledColor = null; } });
    for (const evt of ["did-start-loading", "did-stop-loading", "audio-state-changed"]) wc.on(evt, emit);
    wc.on("did-fail-load", (_e, code, description, failedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires routinely when a navigation is superseded.
      if (isMainFrame && code !== -3) notify({ event: "load-failed", tabId: tab.id, code, description, url: failedUrl });
    });
    wc.on("enter-html-full-screen", () => { tab.fullscreen = true; layout(); notify({ event: "fullscreen", tabId: tab.id, on: true }); });
    wc.on("leave-html-full-screen", () => { tab.fullscreen = false; layout(); notify({ event: "fullscreen", tabId: tab.id, on: false }); });
    wc.on("found-in-page", (_e, result) => notify({ event: "found", tabId: tab.id, matches: result.matches, active: result.activeMatchOrdinal }));
    wc.on("render-process-gone", (_e, details) => notify({ event: "crashed", tabId: tab.id, reason: details.reason }));
  }

  function makeView(tab, adopted = null) {
    tab.view = new WebContentsView(adopted ? { webContents: adopted.webContents, webPreferences: adopted.webPreferences } : {
      webPreferences: {
        session: partitionSession,
        // No preload: there is deliberately no bridge for a page to find.
        sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        webviewTag: false, spellcheck: true,
        // The built-in PDF viewer.
        plugins: true,
      },
    });
    tab.view.setBackgroundColor("#ffffff");
    tab.view.setVisible(false);
    const wc = tab.view.webContents;
    wc.setAudioMuted(tab.muted);
    wire(tab);
    host().contentView.addChildView(tab.view);
    // A page closing a window it opened (window.close() after a sign-in)
    // closes that tab. Kairos's own closing clears tab.view first.
    const view = tab.view;
    wc.once("destroyed", () => { if (tab.view === view && tabs.get(tab.id) === tab) { tab.view = null; close(tab.id); } });
    try { onTabContents(tab, wc); } catch { /* extras are best-effort */ }
    // An adopted window is already navigating to its address.
    if (tab.url && !adopted) wc.loadURL(tab.url);
  }

  // A window the page opened (target=_blank, or window.open without a size)
  // becomes a tab that keeps the page's window.opener: Electron hands over
  // the new contents, and the tab takes them instead of loading the address.
  function adopt(options, url, { background, opener }) {
    const tab = { id: nextId++, url, title: "", pinned: false, muted: false, favicon: null, view: null, lastGesture: 0, lastActive: Date.now(), fullscreen: false };
    tabs.set(tab.id, tab);
    const at = opener && order.includes(opener) ? order.indexOf(opener) + 1 : order.length;
    order.splice(at, 0, tab.id);
    makeView(tab, options);
    if (!background || activeId === null) activate(tab.id); else emit();
    return tab.view.webContents;
  }

  function destroyView(tab) {
    if (!tab.view) return;
    const view = tab.view;
    tab.url = view.webContents.isDestroyed() ? tab.url : view.webContents.getURL() || tab.url;
    tab.title = view.webContents.isDestroyed() ? tab.title : view.webContents.getTitle() || tab.title;
    tab.view = null;
    try { host().contentView.removeChildView(view); } catch { /* window gone */ }
    // Destroyed, not hidden: a hidden view keeps running scripts and audio.
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
  }

  function layout() {
    for (const id of order) {
      const tab = tabs.get(id);
      if (!tab.view) continue;
      const show = visible && id === activeId;
      if (show) {
        const win = host();
        // Fullscreen video fills the whole window, over the sidebar.
        const full = tab.fullscreen && win ? win.getContentBounds() : null;
        const rect = full ? { x: 0, y: 0, width: full.width, height: full.height } : bounds;
        tab.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) });
      }
      tab.view.setVisible(show);
    }
  }

  // Keep at most LIVE_LIMIT views besides the active one; the least
  // recently used, silent ones go first.
  function discardExtra() {
    const live = order.map((id) => tabs.get(id)).filter((t) => t.view && t.id !== activeId);
    if (live.length <= LIVE_LIMIT) return;
    live.filter((t) => !t.view.webContents.isCurrentlyAudible()).sort((a, b) => a.lastActive - b.lastActive)
      .slice(0, live.length - LIVE_LIMIT).forEach(destroyView);
  }

  function open(rawUrl, { background = false, opener = null, pinned = false, discarded = false, title = "" } = {}) {
    const url = rawUrl ? safe(rawUrl) : null;
    if (rawUrl && !url) return { ok: false, reason: "That address can't be opened here." };
    const tab = { id: nextId++, url: url || "", title, pinned, muted: false, favicon: null, view: null, lastGesture: 0, lastActive: Date.now(), fullscreen: false };
    tabs.set(tab.id, tab);
    const at = opener && order.includes(opener) ? order.indexOf(opener) + 1 : order.length;
    order.splice(at, 0, tab.id);
    if (!discarded) makeView(tab);
    if (!background || activeId === null) activate(tab.id); else emit();
    return { ok: true, id: tab.id };
  }

  function activate(id) {
    const tab = tabs.get(id);
    if (!tab) return { ok: false };
    activeId = id;
    tab.lastActive = Date.now();
    if (!tab.view) makeView(tab);
    discardExtra();
    layout();
    if (visible) tab.view.webContents.focus();
    if (!tab.themeColor && !tab.sampledColor) setTimeout(() => sampleColor(tab), 400);
    emit();
    return { ok: true };
  }

  function close(id) {
    const tab = tabs.get(id);
    if (!tab) return { ok: false };
    const m = meta(tab);
    if (safe(m.url)) { closed.push({ url: m.url, title: m.title, pinned: m.pinned }); if (closed.length > CLOSED_LIMIT) closed.shift(); }
    const index = order.indexOf(id);
    destroyView(tab);
    tabs.delete(id);
    blockedCounts.delete(id);
    order.splice(index, 1);
    if (activeId === id) {
      activeId = null;
      const next = order[Math.min(index, order.length - 1)];
      if (next) activate(next); else emit();
    } else emit();
    return { ok: true };
  }

  function reopenClosed() {
    const last = closed.pop();
    return last ? open(last.url, { pinned: last.pinned, title: last.title }) : { ok: false };
  }

  const wcOf = (id) => { const t = tabs.get(id ?? activeId); return t && t.view && !t.view.webContents.isDestroyed() ? t.view.webContents : null; };

  function navigate(id, input) {
    const target = gate.fromAddressBar(input, allow);
    if (!target) return { ok: false, reason: "That address can't be opened here." };
    const tab = tabs.get(id ?? activeId);
    if (!tab) return open(target);
    if (!tab.view) { tab.url = target; makeView(tab); } else tab.view.webContents.loadURL(target);
    return { ok: true, url: target };
  }

  function nav(id, name) {
    const wc = wcOf(id);
    if (!wc) return;
    const h = wc.navigationHistory;
    if (name === "back" && h.canGoBack()) h.goBack();
    if (name === "forward" && h.canGoForward()) h.goForward();
    if (name === "reload") wc.reload();
    if (name === "hard-reload") wc.reloadIgnoringCache();
    if (name === "stop") wc.stop();
  }

  function zoom(id, direction) {
    const wc = wcOf(id);
    if (!wc) return null;
    const factor = nextZoom(wc.getZoomFactor(), direction);
    wc.setZoomFactor(factor);
    store.setSite(wc.getURL(), "zoom", factor === 1 ? null : factor);
    emit();
    return factor;
  }

  function find(id, text, { forward = true, findNext = false } = {}) {
    const wc = wcOf(id);
    if (!wc) return null;
    if (!text) { wc.stopFindInPage("clearSelection"); return null; }
    return wc.findInPage(String(text).slice(0, 500), { forward, findNext });
  }

  function handleShortcut(name, id = activeId) {
    switch (name) {
      case "new-tab": case "focus-address": case "find": case "escape": onShortcut(name, id); break;
      case "close-tab": close(id); break;
      case "reopen-closed": reopenClosed(); break;
      case "next-tab": case "previous-tab": {
        if (!order.length) break;
        const i = order.indexOf(activeId), step = name === "next-tab" ? 1 : -1;
        activate(order[(i + step + order.length) % order.length]);
        break;
      }
      case "zoom-in": zoom(id, 1); break;
      case "zoom-out": zoom(id, -1); break;
      case "zoom-reset": zoom(id, 0); break;
      case "print": { const wc = wcOf(id); if (wc) wc.print({}, () => {}); break; }
      case "devtools": { const wc = wcOf(id); if (wc) wc.isDevToolsOpened() ? wc.closeDevTools() : wc.openDevTools({ mode: "detach" }); break; }
      default: nav(id, name);
    }
  }

  // Counted by the ad blocker's request filter (main.js), per tab.
  function countBlocked(webContentsId) {
    for (const tab of tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.id === webContentsId) {
        blockedCounts.set(tab.id, (blockedCounts.get(tab.id) || 0) + 1);
        if (tab.id === activeId) emit();
        return;
      }
    }
  }

  // Ask Kairos's "Share this page": the page's title, address and visible
  // text, read only when the person presses Send with sharing ticked. Read
  // in an isolated world so the page's own scripts can't change what is
  // read. The one place page content leaves the view, and only on a click.
  const SHARE_LIMIT = 200000;
  async function pageText(id) {
    const wc = wcOf(id);
    if (!wc) return null;
    const url = wc.getURL();
    if (!safe(url)) return null;
    const result = await wc.executeJavaScriptInIsolatedWorld(1001, [{ code:
      `({ title: document.title, text: document.body ? document.body.innerText.slice(0, ${SHARE_LIMIT}) : "" })` }]);
    return { url, title: String(result && result.title || "").slice(0, 500), text: String(result && result.text || "").slice(0, SHARE_LIMIT) };
  }

  function restore() {
    const saved = store.loadSession();
    for (const t of saved) if (safe(t.url)) open(t.url, { pinned: !!t.pinned, title: t.title || "", discarded: true, background: true });
    if (order.length) activate(order[0]);
    return order.length;
  }

  return {
    open, close, activate, navigate, reopenClosed, restore, handleShortcut, find, zoom, countBlocked, pageText,
    duplicate(id) { const t = tabs.get(id); const url = t && meta(t).url; return url && safe(url) ? open(url, { opener: id }) : { ok: false }; },
    back: (id) => nav(id, "back"), forward: (id) => nav(id, "forward"), reload: (id) => nav(id, "reload"), stop: (id) => nav(id, "stop"),
    // Pinned tabs stay together at the top: a newly pinned tab goes after the
    // other pins, an unpinned one to the top of the rest.
    setPinned(id, on) {
      const t = tabs.get(id);
      if (!t) return { ok: false };
      t.pinned = !!on;
      const rest = order.filter((x) => x !== id);
      order = [...rest.filter((x) => tabs.get(x).pinned), id, ...rest.filter((x) => !tabs.get(x).pinned)];
      emit();
      return { ok: true };
    },
    setMuted(id, on) { const t = tabs.get(id); if (!t) return { ok: false }; t.muted = !!on; const wc = wcOf(id); if (wc) wc.setAudioMuted(t.muted); emit(); return { ok: true }; },
    reorder(ids) { if (ids.length === order.length && ids.every((id) => tabs.has(id))) { order = [...ids]; emit(); return { ok: true }; } return { ok: false }; },
    setBounds(rect) { bounds = { x: rect.x || 0, y: rect.y || 0, width: rect.width || 0, height: rect.height || 0 }; layout(); },
    setVisible(on) { visible = !!on; layout(); },
    list: () => ({ tabs: order.map((id) => meta(tabs.get(id))), activeId }),
    webContentsOf: wcOf,
    closeAll() { popups.closeAll(); for (const id of [...order]) destroyView(tabs.get(id)); tabs.clear(); order = []; activeId = null; clearTimeout(saveTimer); },
    popups,
    _shortcutFor: shortcutFor, _nextZoom: nextZoom,
  };
}

module.exports = { createTabs, _shortcutFor: shortcutFor, _nextZoom: nextZoom, _hexColor: hexColor };
