// electron/browser-media.js — cameras, microphones and screen sharing in
// Browse tabs (2.3.0; David, 2026-11-11: "permission issues on browser with
// sharing screens and microphones in meetings such as google meetings").
//
// Three jobs, all for the Browse profile's session only:
//   1. Screen sharing. Without a display-media handler Electron rejects every
//      getDisplayMedia() call, so no call site could present. Here a request
//      from a Browse tab becomes Kairos's picker (the screens and windows,
//      with pictures, plus the computer's sound on Windows); the page gets
//      only the one source the person picked, or nothing.
//   2. The operating system's own switch. When Windows' privacy setting or
//      macOS's Privacy & Security list keeps Kairos from the microphone,
//      camera or screen, a page just sees a device error. Kairos says so,
//      plainly, with where to turn it on.
//   3. The in-use mark. Electron reports no capture state, and anything the
//      page itself reports could be faked, so the mark is the main process's
//      own record: a page is marked from the moment it is given a camera,
//      microphone or screen, and the mark stays until that page is gone (a
//      new page commits in the tab, or the tab closes). Stop reloads the
//      page, which is the one way to be sure every track it holds ends.
//
// Every source id the page receives was offered by this module for that
// very request, and nothing is shared without the person's click.

const PICK_TIMEOUT_MS = 120000;
const KINDS = ["microphone", "camera", "screen"];

function webOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

function kindsOf(setting) {
  if (setting === "camera+microphone") return ["camera", "microphone"];
  return KINDS.includes(setting) ? [setting] : [];
}

// `tabFor(webContents)` is the Browse tab showing those contents, or null.
// `touch()` re-sends the tab list (each tab carries what its page was given).
// `reloadTab(tabId)` reloads a tab's page. `send(channel, payload)` reaches
// the app window. The electron pieces come in as arguments so the rules can
// be tested without a real capture.
function createMedia({ store, tabFor, touch = () => {}, send = () => {}, reloadTab = () => false, desktopCapturer, systemPreferences, fromFrame, platform = process.platform, log = console, pickTimeoutMs = PICK_TIMEOUT_MS }) {
  // tabId -> Set of kinds the page now in the tab was given.
  const capture = new Map();
  const pending = new Map();
  let nextRequest = 1;

  // -- the operating system's switch
  function osStatus(kind) {
    if (!systemPreferences || typeof systemPreferences.getMediaAccessStatus !== "function") return "granted";
    if (platform !== "win32" && platform !== "darwin") return "granted";
    // Windows has no screen-capture switch.
    if (kind === "screen" && platform !== "darwin") return "granted";
    try { return systemPreferences.getMediaAccessStatus(kind) || "unknown"; } catch { return "unknown"; }
  }
  async function checkOs(kinds, tabId, origin) {
    const blocked = [];
    for (const kind of kinds) {
      let status = osStatus(kind);
      // macOS asks the person itself, once, for the camera and microphone.
      if (status === "not-determined" && platform === "darwin" && kind !== "screen" && typeof systemPreferences.askForMediaAccess === "function") {
        try { status = (await systemPreferences.askForMediaAccess(kind)) ? "granted" : "denied"; } catch { status = "denied"; }
      }
      if (status === "denied" || status === "restricted") blocked.push(kind);
    }
    if (blocked.length) send("browse:event", { event: "media-os-blocked", tabId, origin, kinds: blocked, platform });
    return blocked;
  }

  // -- the in-use mark
  function capturing(tabId) {
    const kinds = capture.get(tabId);
    return kinds ? KINDS.filter((k) => kinds.has(k)) : [];
  }
  function using(tabId, kinds) {
    if (!kinds.length) return;
    if (!capture.has(tabId)) capture.set(tabId, new Set());
    for (const k of kinds) capture.get(tabId).add(k);
    touch();
  }
  // A new page committed in the tab, or it closed: the old page's capture
  // ended with it. Any picker still open for the tab is cancelled.
  function reset(tabId) {
    if (capture.delete(tabId)) touch();
    for (const [id, p] of [...pending]) if (p.tabId === tabId) { send("browse:event", { event: "screen-closed", requestId: id }); p.finish(null); }
  }
  // Stop, or revoking a site's answer: the page is reloaded, the only way to
  // be sure every track it holds ends (a page can keep a stream Kairos never
  // sees). The mark clears when the new page commits (reset()).
  function stop(tabId) {
    if (!capture.has(tabId)) return { ok: true, reloaded: false };
    return { ok: !!reloadTab(tabId), reloaded: true };
  }

  // Called by browser-permissions.js once a camera or microphone is allowed,
  // before the page hears the answer. `current()` says the page that asked
  // is still the one in the tab.
  async function beforeGrant({ webContents, setting, current = () => true }) {
    const kinds = kindsOf(setting).filter((k) => k !== "screen");
    if (!kinds.length) return;
    const tab = tabFor(webContents);
    if (!tab) return;
    await checkOs(kinds, tab.id, webOrigin(webContents.getURL()));
    if (current()) using(tab.id, kinds);
  }

  // -- screen sharing
  async function sourcesFor() {
    const list = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
    return list.map((s) => ({
      source: s,
      offer: {
        id: s.id, name: String(s.name || "").slice(0, 200) || (s.id.startsWith("screen:") ? "Screen" : "Window"),
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}` : null,
      },
    }));
  }

  // The picker itself: the screens and windows, sent to the app; resolves to
  // the offered source the person picked (and whether sound goes too), or null.
  async function runPicker({ tabId, top, requester, audio }) {
    if (platform === "darwin") await checkOs(["screen"], tabId, top);
    const found = await sourcesFor();
    const requestId = nextRequest++;
    const reply = await new Promise((resolve) => {
      const finish = (r) => { clearTimeout(timer); pending.delete(requestId); resolve(r); };
      const timer = setTimeout(() => { send("browse:event", { event: "screen-closed", requestId }); finish(null); }, pickTimeoutMs);
      pending.set(requestId, { tabId, sources: found, finish });
      send("browse:screen-request", {
        requestId, tabId, origin: top, embedded: requester !== top ? requester : null,
        // The computer's sound can be shared on Windows only (Electron's loopback).
        audio: !!audio && platform === "win32",
        sources: found.map((f) => f.offer),
      });
    });
    const picked = reply && found.find((f) => f.offer.id === reply.sourceId);
    return picked ? { source: picked.source, audio: reply.audio === true } : null;
  }

  // What each tab's page picked in the permission step, for the display
  // handler that follows it: webContents id -> { source, audio, requester, at }.
  const chosen = new Map();
  const CHOSEN_MS = 30000;

  // Chromium asks permission for getDisplayMedia() before the display handler
  // runs, and only a no at that step reaches the page as the standard
  // NotAllowedError (a no from the handler is an AbortError, which call sites
  // treat as a failure, not a cancel). So the picker runs here: Cancel is a
  // plain no, and a pick is kept for the handler. Called by
  // browser-permissions.js for a site that is not blocked.
  async function pickScreen({ webContents, details = {}, current = () => true }) {
    const tab = tabFor(webContents);
    if (!tab) return false;
    const top = webOrigin(webContents.getURL());
    const requester = webOrigin(details.requestingUrl || webContents.getURL());
    if (!top || !requester) return false;
    chosen.delete(webContents.id);
    // The site's request does not say yet whether it wants sound; it is only
    // shared if the site asks for it too (onDisplayRequest).
    const pick = await runPicker({ tabId: tab.id, top, requester, audio: true });
    if (!pick || webContents.isDestroyed() || !current()) return false;
    chosen.set(webContents.id, { ...pick, requester, at: Date.now() });
    return true;
  }

  async function onDisplayRequest(request, callback) {
    let answered = false;
    const deny = () => { if (answered) return; answered = true; try { callback({}); } catch { /* the frame is gone */ } };
    try {
      const frame = request.frame;
      const wc = frame && fromFrame ? fromFrame(frame) : null;
      const tab = wc && !wc.isDestroyed() ? tabFor(wc) : null;
      if (!tab) return deny();
      const top = webOrigin(wc.getURL());
      const requester = webOrigin(frame.url) || webOrigin(request.securityOrigin);
      if (!top || !requester || store.getSite(top, "permission:screen") === "block") return deny();
      // The pick made in the permission step for this page and frame, if fresh;
      // otherwise (an engine that skips that step) the picker runs now.
      const earlier = chosen.get(wc.id);
      chosen.delete(wc.id);
      const pick = earlier && earlier.requester === requester && Date.now() - earlier.at < CHOSEN_MS
        ? earlier : await runPicker({ tabId: tab.id, top, requester, audio: request.audioRequested });
      if (!pick || wc.isDestroyed()) return deny();
      using(tab.id, ["screen"]);
      answered = true;
      const streams = { video: pick.source };
      if (pick.audio && request.audioRequested && platform === "win32") streams.audio = "loopback";
      try { callback(streams); } catch (err) { log.error(`[browse] screen share: ${err.message}`); reset(tab.id); }
    } catch (err) {
      log.error(`[browse] screen share request: ${err && err.message}`);
      deny();
    }
  }
  function answerScreen(requestId, sourceId, audio) {
    const p = pending.get(requestId);
    if (!p) return { ok: false };
    p.finish(typeof sourceId === "string" ? { sourceId, audio: audio === true } : null);
    return { ok: true };
  }

  function attach(partitionSession) {
    partitionSession.setDisplayMediaRequestHandler((request, callback) => { onDisplayRequest(request, callback); }, { useSystemPicker: false });
  }

  function close() {
    chosen.clear();
    for (const p of [...pending.values()]) p.finish(null);
    capture.clear();
  }

  return { attach, beforeGrant, pickScreen, forgetPick: (webContentsId) => chosen.delete(webContentsId), answerScreen, capturing, reset, stop, close, osStatus };
}

module.exports = { createMedia, _kindsOf: kindsOf };
