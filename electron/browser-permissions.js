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
// never get a prompt). `beforeGrant({ webContents, setting, details })` runs
// once an allow is decided, before the page hears it: the OS check and the
// in-use indicator (browser-media.js).
// `speakerSelection()` says whether pages may pick an audio output, which
// Browse's own audio routing needs while a device is chosen (browser-audio.js).
// `pickScreen({ webContents, details })` is the screen picker
// (browser-media.js): true once the person picked a screen or window.
function createPermissions({ store, ask, isTab = () => true, beforeGrant = async () => {}, pickScreen = async () => true, speakerSelection = () => false }) {
  // Allow once: per tab, per page. webContents id -> Set of
  // "<page origin>|<frame origin>|<setting>".
  const once = new Map();
  const onceKey = (top, requester, k) => `${top}|${requester}|${k}`;
  function hasOnce(wc, top, requester, setting) {
    const set = once.get(wc.id);
    return !!set && keysOf(setting).every((k) => set.has(onceKey(top, requester, k)));
  }
  function grantOnce(wc, top, requester, setting) {
    if (!once.has(wc.id)) once.set(wc.id, new Set());
    for (const k of keysOf(setting)) once.get(wc.id).add(onceKey(top, requester, k));
  }
  // The page navigated or the tab closed: its Allow once answers end.
  function forget(webContentsId) { once.delete(webContentsId); }

  const live = (wc) => wc && !wc.isDestroyed();

  async function grant(webContents, setting, details) {
    try { await beforeGrant({ webContents, setting, details }); } catch { /* the grant stands; the indicator is best-effort */ }
    return true;
  }

  async function decide(webContents, permission, details = {}) {
    if (ALWAYS.has(permission)) return true;
    const setting = settingFor(permission, details);
    if (!setting || !live(webContents) || !isTab(webContents)) return false;
    const top = webOrigin(webContents.getURL());
    const requester = details.requestingUrl ? webOrigin(details.requestingUrl) : top;
    if (!top || !requester) return false;
    const blocked = storedAnswer(store, top, setting) === "block";
    if (setting === "screen") {
      if (blocked) return false;
      // getDisplayMedia(): the picker runs now, so Cancel reaches the page
      // as a plain no. (A bare display-capture request has no picker; the
      // display handler shows it then.)
      if (permission !== "media") return true;
      try { return !!(await pickScreen({ webContents, details })); } catch { return false; }
    }
    if (requester !== top) {
      // An embedded frame: camera and microphone only, never remembered.
      if (!MEDIA.has(setting) || blocked) return false;
      if (hasOnce(webContents, top, requester, setting)) return grant(webContents, setting, details);
      const reply = await Promise.resolve(ask({ webContents, origin: top, setting, embedded: requester, canRemember: false })).catch(() => null);
      if (!reply || reply.answer !== "allow" || !live(webContents)) return false;
      grantOnce(webContents, top, requester, setting);
      return grant(webContents, setting, details);
    }
    const known = storedAnswer(store, top, setting);
    if (known === "block") return false;
    if (known === "allow" || hasOnce(webContents, top, top, setting)) return grant(webContents, setting, details);
    const reply = await Promise.resolve(ask({ webContents, origin: top, setting, embedded: null, canRemember: true })).catch(() => null);
    const answer = reply && reply.answer === "allow" ? "allow" : "block";
    if (reply && reply.remember) remember(store, top, setting, answer);
    if (answer !== "allow" || !live(webContents)) return false;
    if (!reply.remember) grantOnce(webContents, top, top, setting);
    return grant(webContents, setting, details);
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
    if (requester !== top) return MEDIA.has(setting) && hasOnce(webContents, top, requester, setting);
    if (known === "allow" || hasOnce(webContents, top, top, setting)) return true;
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

  return { attach, decide, check, forget };
}

module.exports = { createPermissions, _settingFor: settingFor, _webOrigin: webOrigin, _trustworthy: trustworthy };
