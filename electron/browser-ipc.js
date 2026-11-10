// electron/browser-ipc.js — Browse's IPC boundary (vault: "Kairos Browser -
// Phase 1 (Build Spec)", U2).
//
// Same rule as the side pane's channels in main.js: every handler checks the
// sender is the app window first. A page in a tab is untrusted by
// definition and has no preload, but the check means that even if one ever
// reached ipcRenderer it could not drive Browse. Arguments are checked here,
// in one place, rather than trusted from the renderer.
//
// Nothing here returns page content: tab metadata, history rows, settings
// and download rows only.

const MAX_TEXT = 2000;
const MAX_URL = 8192;

const isId = (v) => Number.isInteger(v) && v > 0 && v < 2 ** 31;
const text = (v, max = MAX_TEXT) => (typeof v === "string" && v.length <= max ? v : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
function rect(v) {
  if (!v || typeof v !== "object") return null;
  const r = { x: num(v.x), y: num(v.y), width: num(v.width), height: num(v.height) };
  return Object.values(r).every((n) => n !== null && n > -100000 && n < 100000) ? r : null;
}

function installBrowseIpc({ ipcMain, fromAppWindow, getBrowse, resolveBrowse = async () => getBrowse(), importPasswords = null, preparePost = null }) {
  // handle(): request/answer. on(): fire and forget. Both no-op answers when
  // the sender is wrong, Browse isn't up, or an argument is malformed.
  // `opening` channels first settle which account's Browse is open
  // (browser-profiles.js); the rest act on the one already open.
  const handle = (channel, fn, fallback = { ok: false }, opening = false) => ipcMain.handle(channel, async (event, ...args) => {
    if (!fromAppWindow(event)) return fallback;
    const browse = opening ? await resolveBrowse() : getBrowse();
    if (!browse) return fallback;
    try { const out = await fn(browse, ...args); return out === undefined ? fallback : out; } catch (err) { console.error(`[browse] ${channel}: ${err.message}`); return fallback; }
  });
  const on = (channel, fn, opening = false) => ipcMain.on(channel, async (event, ...args) => {
    if (!fromAppWindow(event)) return;
    const browse = opening ? await resolveBrowse() : getBrowse();
    if (!browse) return;
    try { await fn(browse, ...args); } catch (err) { console.error(`[browse] ${channel}: ${err.message}`); }
  });

  // Tabs.
  handle("browse:list", (b) => { b.ensureRestored(); return b.tabs.list(); }, { tabs: [], activeId: null }, true);
  handle("browse:open", (b, url, opts = {}) => {
    if (url !== null && url !== undefined && !text(url, MAX_URL)) return undefined;
    const input = url ? b.gate.fromAddressBar(url, { allowLoopback: true }) : null;
    if (url && !input) return { ok: false, reason: "That address can't be opened here." };
    return b.tabs.open(input, { background: opts && opts.background === true });
  }, { ok: false }, true);
  handle("browse:navigate", (b, id, input) => (isId(id) && text(input, MAX_URL) ? b.tabs.navigate(id, input) : undefined));
  handle("browse:find", (b, id, query, opts = {}) => (isId(id) && typeof query === "string" ? { requestId: b.tabs.find(id, query.slice(0, 500), { forward: opts.forward !== false, findNext: opts.findNext === true }) } : undefined));
  handle("browse:zoom", (b, id, direction) => (isId(id) && [-1, 0, 1].includes(direction) ? { zoom: b.tabs.zoom(id, direction) } : undefined));
  // The person pressed Send in Ask Kairos with "Share this page" ticked:
  // the only channel that returns page content (browser-tabs.js pageText).
  handle("browse:share-page", (b, id) => (isId(id) ? b.tabs.pageText(id) : undefined), null);
  on("browse:activate", (b, id) => { if (isId(id)) b.tabs.activate(id); });
  on("browse:close", (b, id) => { if (isId(id)) b.tabs.close(id); });
  on("browse:reopen-closed", (b) => b.tabs.reopenClosed());
  for (const action of ["back", "forward", "reload", "stop"]) on(`browse:${action}`, (b, id) => { if (isId(id)) b.tabs[action](id); });
  on("browse:pin", (b, id, pinned) => { if (isId(id) && typeof pinned === "boolean") b.tabs.setPinned(id, pinned); });
  on("browse:mute", (b, id, muted) => { if (isId(id) && typeof muted === "boolean") b.tabs.setMuted(id, muted); });
  on("browse:reorder", (b, ids) => { if (Array.isArray(ids) && ids.length < 1000 && ids.every(isId)) b.tabs.reorder(ids); });
  on("browse:bounds", (b, r) => { const ok = rect(r); if (ok) b.tabs.setBounds(ok); });
  on("browse:visible", (b, visible) => { if (typeof visible === "boolean") { if (visible) b.ensureRestored(); b.tabs.setVisible(visible); } }, true);
  on("browse:shortcut", (b, name, id) => { if (text(name, 40) && (id === undefined || isId(id))) b.tabs.handleShortcut(name, id); });

  // History, suggestions, pinned sites.
  handle("browse:suggest", (b, q) => (text(q, 500) !== null ? b.store.suggest(q) : undefined), []);
  handle("browse:history", (b, q) => (q ? (text(q, 500) ? b.store.searchHistory(q, 200) : undefined) : b.store.recentHistory(200)), []);
  handle("browse:history-delete", (b, id) => (isId(id) ? { ok: b.store.deleteHistory(id) > 0 } : undefined));
  handle("browse:history-clear", (b, from, to) => (num(from) !== null && num(to) !== null && from < to ? { deleted: b.store.deleteHistoryRange(from, to) } : undefined));
  handle("browse:pinned", (b) => b.store.pinned(), []);
  handle("browse:pin-site", (b, url, title) => (text(url, MAX_URL) ? { ok: b.store.pin(url, text(title, 500) || "") } : undefined));
  handle("browse:unpin-site", (b, id) => (isId(id) ? { ok: b.store.unpin(id) > 0 } : undefined));
  handle("browse:pinned-order", (b, ids) => (Array.isArray(ids) && ids.length < 500 && ids.every(isId) ? (b.store.reorderPinned(ids), { ok: true }) : undefined));

  // Home screen (Speed Dial): tiles, suggestions, customize settings.
  handle("browse:home", (b) => b.home());
  handle("browse:home-set", (b, value) => (value && typeof value === "object" ? { settings: b.setHome(value) } : undefined));
  handle("browse:pin-edit", (b, id, url, title) => (isId(id) && text(url, MAX_URL) && text(title, 500) !== null ? { ok: b.store.editPin(id, url, title) } : undefined));
  handle("browse:pin-thumb-clear", (b, id) => (isId(id) ? { ok: b.store.setThumb(id, null) > 0 } : undefined));
  handle("browse:duplicate", (b, id) => (isId(id) ? b.tabs.duplicate(id) : undefined));

  // Site settings, search engine, ad blocking.
  handle("browse:site", (b, url) => (text(url, MAX_URL) ? b.site(url) : undefined));
  handle("browse:site-set", (b, url, key, value) => (text(url, MAX_URL) && (value === null || typeof value === "string") ? b.setSite(url, key, value) : undefined));
  handle("browse:site-clear", (b, url) => (text(url, MAX_URL) ? { cleared: b.store.clearSite(url) } : undefined));
  handle("browse:search-engines", (b) => b.searchEngines());
  handle("browse:search-engine", (b, id) => (text(id, 40) ? b.setSearchEngine(id) : undefined));
  handle("browse:adblock-stats", (b) => b.adblockStats());
  on("browse:permission-answer", (b, requestId, answer, remember) => {
    if (isId(requestId) && (answer === "allow" || answer === "block")) b.answerPermission(requestId, answer, remember === true);
  });

  // The password keeper (browser-passwords.js). Saved passwords never come
  // back over these channels: fill and the generator write into the page in
  // main, and the answer to a save offer is only its id and the choice.
  handle("browse:password-answer", (b, offerId, action) => (isId(offerId) && ["save", "never", "dismiss"].includes(action) ? b.passwords.answer(offerId, action) : undefined));
  handle("browse:password-fill", (b, tabId, loginId) => (isId(tabId) && text(loginId, 40) ? b.passwords.fill(tabId, loginId) : undefined));
  handle("browse:password-generate", (b, tabId) => (isId(tabId) ? b.passwords.useGenerated(tabId) : undefined));
  if (importPasswords) handle("browse:passwords-import", () => importPasswords());

  // Audio output for every Browse page (browser-audio.js): a device's name, or "" for the system default.
  handle("browse:audio", (b) => ({ label: b.audio.get() }));
  handle("browse:audio-set", (b, label) => (typeof label === "string" && label.length <= 300 ? b.audio.set(label) : undefined));

  // Content Studio's Open upload page (main.js preparePost, studio-prepare.js): only the id of a prepared post comes
  // from the page; main fetches the plan from the backend and fills the new tab itself.
  if (preparePost) handle("browse:prepare-post", (b, prepId) => (isId(prepId) ? preparePost(b, prepId) : undefined), { ok: false }, true);

  // Downloads.
  handle("browse:downloads", (b) => b.downloads.list(), []);
  handle("browse:download", (b, id, action) => (text(id, 64) && ["pause", "resume", "cancel", "open", "show", "forget"].includes(action) ? b.downloads.control(id, action) : undefined));
}

module.exports = { installBrowseIpc, _rect: rect, _isId: isId };
