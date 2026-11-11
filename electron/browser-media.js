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
//   3. The in-use indicator. Electron reports no capture state, so Kairos
//      keeps its own: a tab is marked from the moment it is given a camera,
//      microphone or screen. The mark clears when the page navigates or
//      closes, when the person presses Stop, or when every track Kairos saw
//      the page use has ended. Kairos sees tracks through a small helper put
//      into the page right before access is granted; a track it never saw
//      keeps the mark on, so a page can't hide its capture by avoiding it.
//
// Every source id the page receives was offered by this module for that
// very request, and nothing is shared without the person's click.

const crypto = require("crypto");

const PICK_TIMEOUT_MS = 120000;
const POLL_MS = 2000;
const KINDS = ["microphone", "camera", "screen"];

function webOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

// The helper, run in the page's own world. It records each capture track the
// page hands to a call (a peer connection, a video element, Web Audio, a
// recorder stream), by kind, and can report or stop them. Its handle sits on
// window under a random, fixed, non-enumerable name the page cannot replace.
function helperSource(key) {
  return `(() => {
  const KEY = ${JSON.stringify(key)};
  if (Object.prototype.hasOwnProperty.call(window, KEY)) return true;
  const seen = new Map();
  const shared = new WeakSet();
  const kindOf = (t) => {
    try {
      if (shared.has(t)) return "screen";
      const s = typeof t.getSettings === "function" ? t.getSettings() : {};
      if (s.displaySurface) return "screen";
      if (s.deviceId) return t.kind === "audio" ? "microphone" : "camera";
    } catch (e) {}
    return null;
  };
  const add = (t) => { try { if (t && typeof t.stop === "function" && !seen.has(t)) { const k = kindOf(t); if (k) seen.set(t, k); } } catch (e) {} };
  const addStream = (s) => { try { if (s && typeof s.getTracks === "function") s.getTracks().forEach(add); } catch (e) {} };
  const before = (proto, name, fn) => {
    const orig = proto && proto[name];
    if (typeof orig !== "function") return;
    proto[name] = function (...args) { try { fn(...args); } catch (e) {} return orig.apply(this, args); };
  };
  const md = window.MediaDevices && MediaDevices.prototype;
  for (const [name, isScreen] of [["getUserMedia", false], ["getDisplayMedia", true]]) {
    const orig = md && md[name];
    if (typeof orig !== "function") continue;
    md[name] = function (...args) {
      return orig.apply(this, args).then((s) => { try { if (isScreen) s.getTracks().forEach((t) => shared.add(t)); addStream(s); } catch (e) {} return s; });
    };
  }
  if (window.RTCPeerConnection) {
    before(RTCPeerConnection.prototype, "addTrack", (t, ...streams) => { add(t); streams.forEach(addStream); });
    before(RTCPeerConnection.prototype, "addTransceiver", (t) => add(t));
    before(RTCPeerConnection.prototype, "addStream", addStream);
  }
  if (window.RTCRtpSender) before(RTCRtpSender.prototype, "replaceTrack", add);
  if (window.MediaStream) before(MediaStream.prototype, "addTrack", add);
  if (window.BaseAudioContext) {
    before(BaseAudioContext.prototype, "createMediaStreamSource", addStream);
    before(BaseAudioContext.prototype, "createMediaStreamTrackSource", add);
  }
  if (window.AudioContext) before(AudioContext.prototype, "createMediaStreamSource", addStream);
  if (window.MediaStreamTrack) {
    const clone = MediaStreamTrack.prototype.clone;
    if (typeof clone === "function") MediaStreamTrack.prototype.clone = function () { const c = clone.apply(this, arguments); try { if (seen.has(this)) seen.set(c, seen.get(this)); } catch (e) {} return c; };
  }
  const src = window.HTMLMediaElement && Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  if (src && src.set) Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { ...src, set(v) { addStream(v); return src.set.call(this, v); } });
  const api = Object.freeze({
    status() {
      const live = { microphone: 0, camera: 0, screen: 0 }, count = { microphone: 0, camera: 0, screen: 0 };
      for (const [t, k] of seen) { count[k] += 1; if (t.readyState === "live") live[k] += 1; }
      return { live, seen: count };
    },
    stop(kind) {
      let n = 0;
      for (const [t, k] of seen) {
        if (kind && k !== kind) continue;
        if (t.readyState === "live") { t.stop(); n += 1; try { t.dispatchEvent(new Event("ended")); } catch (e) {} }
      }
      return n;
    },
  });
  Object.defineProperty(window, KEY, { value: api, enumerable: false, configurable: false, writable: false });
  return true;
})()`;
}

function kindsOf(setting) {
  if (setting === "camera+microphone") return ["camera", "microphone"];
  return KINDS.includes(setting) ? [setting] : [];
}

const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1e6 ? v : 0);

// `tabFor(webContents)` is the Browse tab showing those contents, or null.
// `touch()` re-sends the tab list (each tab carries what it is using).
// `send(channel, payload)` reaches the app window. The electron pieces come
// in as arguments so the rules can be tested without a real capture.
function createMedia({ store, tabFor, touch = () => {}, send = () => {}, desktopCapturer, systemPreferences, fromFrame, platform = process.platform, log = console, pickTimeoutMs = PICK_TIMEOUT_MS, pollMs = POLL_MS }) {
  const key = "__kairos_capture_" + crypto.randomBytes(8).toString("hex");
  const helper = helperSource(key);
  // tabId -> { kinds: Set, frames: Set<WebFrameMain>, timer }
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

  // -- the in-use indicator
  function capturing(tabId) {
    const c = capture.get(tabId);
    return c ? KINDS.filter((k) => c.kinds.has(k)) : [];
  }
  async function install(frame) {
    if (!frame) return false;
    try { return (await frame.executeJavaScript(helper)) === true; } catch { return false; }
  }
  async function frameStatus(frame) {
    try {
      const s = await frame.executeJavaScript(`(window[${JSON.stringify(key)}] ? window[${JSON.stringify(key)}].status() : null)`);
      if (!s || typeof s !== "object") return null;
      const out = { live: {}, seen: {} };
      for (const k of KINDS) { out.live[k] = count(s.live && s.live[k]); out.seen[k] = count(s.seen && s.seen[k]); }
      return out;
    } catch { return null; }
  }
  // What the helpers in a tab's frames report, summed. A frame that is gone
  // (navigated, removed) reports nothing and is dropped.
  async function tally(c) {
    const total = { live: { microphone: 0, camera: 0, screen: 0 }, seen: { microphone: 0, camera: 0, screen: 0 } };
    for (const frame of [...c.frames]) {
      const s = await frameStatus(frame);
      if (!s) { c.frames.delete(frame); continue; }
      for (const k of KINDS) { total.live[k] += s.live[k]; total.seen[k] += s.seen[k]; }
    }
    return total;
  }
  // A kind clears when Kairos saw the page use it and none of those tracks is live.
  function settle(tabId, c, total) {
    let changed = false;
    for (const k of [...c.kinds]) if (total.seen[k] > 0 && total.live[k] === 0) { c.kinds.delete(k); changed = true; }
    if (!c.kinds.size) { clearInterval(c.timer); capture.delete(tabId); changed = true; }
    if (changed) touch();
  }
  async function poll(tabId) {
    const c = capture.get(tabId);
    if (!c || c.polling) return;
    c.polling = true;
    try { const total = await tally(c); if (capture.get(tabId) === c) settle(tabId, c, total); } finally { c.polling = false; }
  }
  async function using(tabId, frame, kinds) {
    if (!kinds.length) return;
    let c = capture.get(tabId);
    if (!c) {
      c = { kinds: new Set(), frames: new Set(), timer: null, polling: false };
      capture.set(tabId, c);
      c.timer = setInterval(() => poll(tabId).catch(() => {}), pollMs);
      c.timer.unref?.();
    }
    for (const k of kinds) c.kinds.add(k);
    if (frame && await install(frame)) c.frames.add(frame);
    touch();
  }
  // The page navigated or closed.
  function reset(tabId) {
    const c = capture.get(tabId);
    if (c) { clearInterval(c.timer); capture.delete(tabId); touch(); }
    for (const [id, p] of [...pending]) if (p.tabId === tabId) { send("browse:event", { event: "screen-closed", requestId: id }); p.finish(null); }
  }
  // The person pressed Stop. Every track Kairos saw is stopped (the page hears
  // "ended", as when a call site's own Stop is pressed). Anything still live,
  // or in use without Kairos having seen it, keeps its mark and is reported,
  // so the app can offer to reload the page instead.
  async function stop(tabId) {
    const c = capture.get(tabId);
    if (!c) return { ok: true, remaining: [] };
    for (const frame of [...c.frames]) {
      try { await frame.executeJavaScript(`(window[${JSON.stringify(key)}] ? window[${JSON.stringify(key)}].stop() : 0)`); } catch { c.frames.delete(frame); }
    }
    const total = await tally(c);
    if (capture.get(tabId) === c) settle(tabId, c, total);
    const remaining = capturing(tabId);
    return { ok: !remaining.length, remaining };
  }

  // Called by browser-permissions.js once a camera or microphone is allowed,
  // before the page hears the answer.
  async function beforeGrant({ webContents, setting, details = {} }) {
    const kinds = kindsOf(setting).filter((k) => k !== "screen");
    if (!kinds.length) return;
    const tab = tabFor(webContents);
    if (!tab) return;
    const origin = webOrigin(webContents.getURL());
    await checkOs(kinds, tab.id, origin);
    const main = webContents.mainFrame;
    let frame = main;
    if (details.requestingUrl && !details.isMainFrame && main) {
      frame = (main.framesInSubtree || []).find((f) => f.url === details.requestingUrl) || main;
    }
    await using(tab.id, frame, kinds);
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
  async function pickScreen({ webContents, details = {} }) {
    const tab = tabFor(webContents);
    if (!tab) return false;
    const top = webOrigin(webContents.getURL());
    const requester = webOrigin(details.requestingUrl || webContents.getURL());
    if (!top || !requester) return false;
    chosen.delete(webContents.id);
    // The site's request does not say yet whether it wants sound; it is only
    // shared if the site asks for it too (onDisplayRequest).
    const pick = await runPicker({ tabId: tab.id, top, requester, audio: true });
    if (!pick || webContents.isDestroyed()) return false;
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
      await using(tab.id, frame, ["screen"]);
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
    for (const c of capture.values()) clearInterval(c.timer);
    capture.clear();
  }

  return { attach, beforeGrant, pickScreen, forgetPick: (webContentsId) => chosen.delete(webContentsId), answerScreen, capturing, reset, stop, poll, close, osStatus, _key: key };
}

module.exports = { createMedia, _helperSource: helperSource, _kindsOf: kindsOf };
