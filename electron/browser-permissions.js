// electron/browser-permissions.js — per-site permissions for the person's
// Browse tabs (vault: "Kairos Browser - Phase 1 (Build Spec)", U1; media and
// screen sharing for video calls, 2.3.0).
//
// The side pane denies everything without asking (browser.js). A daily
// browser can't: a video call needs the camera. So for Browse tabs only:
//   - a short list of permissions goes to a Kairos prompt that names the
//     site asking. The person answers Allow once (this page only, until it
//     navigates or closes), Always allow for this site, or Block; Always and
//     Block are kept per origin in the account's own store;
//   - a few harmless ones (fullscreen, sanitized clipboard writes) are
//     allowed, as Chrome does;
//   - everything else stays denied, without a prompt.
// Only http and https pages ask: file:, data: and any other scheme are
// denied. Nothing is granted without the person's click or a remembered
// choice.
//
// Frames: a frame of another origin than the tab's page (a call widget
// embedded in a site) may ask for the camera or microphone only, and only
// once Chromium has checked the page let it (the iframe's allow= policy).
// The prompt names both sites, its answer lasts for that page only, and a
// Block kept for the page's own site blocks its frames too. Anything else a
// cross-origin frame asks for is denied.
//
// Screen sharing is decided by the Kairos picker (browser-media.js), which
// runs from here for getDisplayMedia(); a site the person blocked gets no
// picker at all.

const MEDIA = new Set(["camera", "microphone", "camera+microphone"]);
const ALWAYS = new Set(["fullscreen", "clipboard-sanitized-write"]);

// Electron's permission name (plus media type) -> the setting Kairos keeps.
function settingFor(permission, details = {}) {
  if (permission === "media") {
    const types = details.mediaTypes || [];
    if (types.includes("video")) return types.includes("audio") ? "camera+microphone" : "camera";
    if (types.includes("audio")) return "microphone";
    // getDisplayMedia() reaches the handler as "media" with no device types
    // (seen on Electron 43); the Kairos picker then decides.
    return details.mediaTypes ? "screen" : null;
  }
  return { geolocation: "location", notifications: "notifications", "clipboard-read": "clipboard", "display-capture": "screen" }[permission] || null;
}

function webOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

// Chromium only offers cameras and microphones to secure pages: https, or
// http on this computer.
function trustworthy(origin) {
  try {
    const u = new URL(origin);
    return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch { return false; }
}

const keysOf = (setting) => (setting === "camera+microphone" ? ["camera", "microphone"] : [setting]);

function storedAnswer(store, url, setting) {
  // A combined camera+microphone request is allowed only if both are.
  const values = keysOf(setting).map((k) => store.getSite(url, `permission:${k}`));
  if (values.every((v) => v === "allow")) return "allow";
  if (values.some((v) => v === "block")) return "block";
  return null;
}

function remember(store, url, setting, answer) {
  for (const k of keysOf(setting)) store.setSite(url, `permission:${k}`, answer);
}

// `ask({ webContents, origin, setting, embedded, canRemember })` resolves to
// { answer: 'allow' | 'block', remember: boolean }. It is the UI's prompt;
// no answer means block. `isTab(webContents)` says whether the contents are
// a Browse tab (the side pane and sign-in pop-ups share the profile but
// never get a prompt). `beforeGrant({ webContents, setting, details,
// current })` runs once an allow is decided, before the page hears it: the
// OS check and the in-use mark (browser-media.js); `current()` says whether
// the page that asked is still the one in the tab.
// `pickScreen({ webContents, details, current })` is the screen picker
// (browser-media.js): true once the person picked a screen or window.
// `speakerSelection()` says whether pages may pick an audio output, which
// Browse's own audio routing needs while a device is chosen (browser-audio.js).
//
// Every answer belongs to one document. The tab's document generation goes
// up when a new page commits in it (navigated(), wired to did-navigate, so a
// navigation that never commits, such as a 204, keeps the page and its
// answers). An answer that arrives after the page changed is thrown away:
// the new page never inherits a prompt meant for the old one.
function createPermissions({ store, ask, isTab = () => true, beforeGrant = async () => {}, pickScreen = async () => true, speakerSelection = () => false }) {
  // webContents id -> { gen, once: Set("<frame origin>|<setting>"), granted: Set(setting) }
  const docs = new Map();
  function doc(wc) {
    if (!docs.has(wc.id)) docs.set(wc.id, { gen: 0, once: new Set(), granted: new Set() });
    return docs.get(wc.id);
  }
  const hasOnce = (wc, requester, setting) => keysOf(setting).every((k) => doc(wc).once.has(`${requester}|${k}`));
  function grantOnce(wc, requester, setting) { for (const k of keysOf(setting)) doc(wc).once.add(`${requester}|${k}`); }
  // A new page committed in the tab (or it closed): its answers end.
  function navigated(webContentsId) {
    const d = docs.get(webContentsId);
    docs.set(webContentsId, { gen: d ? d.gen + 1 : 1, once: new Set(), granted: new Set() });
  }
  function forget(webContentsId) { docs.delete(webContentsId); }
  // Whether the page now in the tab was given this setting (by a prompt or a
  // remembered allow), so revoking it can end what it holds.
  const wasGranted = (webContentsId, setting) => {
    const d = docs.get(webContentsId);
    return !!d && keysOf(setting).some((k) => d.granted.has(k));
  };
  // Removing or blocking a site's answer: Allow once answers for it end too.
  function revoke(webContentsId, setting) {
    const d = docs.get(webContentsId);
    if (!d) return;
    for (const k of keysOf(setting)) for (const key of [...d.once]) if (key.endsWith(`|${k}`)) d.once.delete(key);
  }

  const live = (wc) => wc && !wc.isDestroyed();

  async function grant(webContents, setting, details, gen) {
    const current = () => live(webContents) && doc(webContents).gen === gen;
    if (!current()) return false;
    try { await beforeGrant({ webContents, setting, details, current }); } catch { /* the OS check and the mark are best-effort */ }
    if (!current()) return false;
    for (const k of keysOf(setting)) doc(webContents).granted.add(k);
    return true;
  }

  async function decide(webContents, permission, details = {}) {
    if (ALWAYS.has(permission)) return true;
    const setting = settingFor(permission, details);
    if (!setting || !live(webContents) || !isTab(webContents)) return false;
    const top = webOrigin(webContents.getURL());
    const requester = details.requestingUrl ? webOrigin(details.requestingUrl) : top;
    if (!top || !requester) return false;
    const gen = doc(webContents).gen;
    const current = () => live(webContents) && doc(webContents).gen === gen;
    const blocked = storedAnswer(store, top, setting) === "block";
    if (setting === "screen") {
      if (blocked) return false;
      // getDisplayMedia(): the picker runs now, so Cancel reaches the page
      // as a plain no. (A bare display-capture request has no picker; the
      // display handler shows it then.)
      if (permission !== "media") return true;
      let picked = false;
      try { picked = !!(await pickScreen({ webContents, details, current })); } catch { picked = false; }
      return picked && current();
    }
    if (requester !== top) {
      // An embedded frame: camera and microphone only, never remembered.
      if (!MEDIA.has(setting) || blocked) return false;
      if (hasOnce(webContents, requester, setting)) return grant(webContents, setting, details, gen);
      const reply = await Promise.resolve(ask({ webContents, origin: top, setting, embedded: requester, canRemember: false })).catch(() => null);
      if (!reply || reply.answer !== "allow" || !current()) return false;
      grantOnce(webContents, requester, setting);
      return grant(webContents, setting, details, gen);
    }
    const known = storedAnswer(store, top, setting);
    if (known === "block") return false;
    if (known === "allow" || hasOnce(webContents, top, setting)) return grant(webContents, setting, details, gen);
    const reply = await Promise.resolve(ask({ webContents, origin: top, setting, embedded: null, canRemember: true })).catch(() => null);
    // The page changed while the prompt was up: the answer was for a page
    // that is gone, so nothing is granted or remembered.
    if (!current()) return false;
    const answer = reply && reply.answer === "allow" ? "allow" : "block";
    if (reply && reply.remember) remember(store, top, setting, answer);
    if (answer !== "allow") return false;
    if (!reply.remember) grantOnce(webContents, top, setting);
    return grant(webContents, setting, details, gen);
  }

  // The synchronous check Chromium makes before some APIs, and behind
  // navigator.permissions.query(). It never prompts. Electron can only say
  // granted or denied, and "denied" makes a call site (Google Meet) show
  // "camera blocked" without ever asking. So for the camera and microphone
  // on a secure page the person has not blocked, it says granted: the
  // capture itself still goes through decide() and its prompt.
  function check(webContents, permission, requestingOrigin, details = {}) {
    if (ALWAYS.has(permission)) return true;
    if (permission === "speaker-selection") return !!speakerSelection();
    if (permission === "media" && !["audio", "video"].includes(details.mediaType)) return false;
    const setting = settingFor(permission, { mediaTypes: [details.mediaType] });
    if (!setting || !live(webContents) || !isTab(webContents)) return false;
    const top = webOrigin(webContents.getURL());
    const requester = webOrigin(details.securityOrigin || requestingOrigin || webContents.getURL());
    if (!top || !requester) return false;
    const known = storedAnswer(store, top, setting);
    if (known === "block") return false;
    if (setting === "screen") return true;
    if (requester !== top) return MEDIA.has(setting) && hasOnce(webContents, requester, setting);
    if (known === "allow" || hasOnce(webContents, top, setting)) return true;
    return MEDIA.has(setting) && trustworthy(top);
  }

  function attach(partitionSession) {
    partitionSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      decide(wc, permission, details).then((ok) => callback(!!ok), () => callback(false));
    });
    partitionSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      try { return check(wc, permission, requestingOrigin, details); } catch { return false; }
    });
    // USB, serial and HID device pickers stay off in Phase 1.
    partitionSession.setDevicePermissionHandler(() => false);
  }

  return { attach, decide, check, navigated, forget, wasGranted, revoke };
}

module.exports = { createPermissions, _settingFor: settingFor, _webOrigin: webOrigin, _trustworthy: trustworthy };
