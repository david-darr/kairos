// electron/browser-permissions.js — per-site permissions for the person's
// Browse tabs (vault: "Kairos Browser - Phase 1 (Build Spec)", U1).
//
// The side pane denies everything without asking (browser.js). A daily
// browser can't: a video call needs the camera. So for Browse tabs only:
//   - a short list of permissions goes to a Kairos prompt that names the
//     site asking, and the answer is remembered per origin in the store;
//   - a few harmless ones (fullscreen, sanitized clipboard writes) are
//     allowed, as Chrome does;
//   - everything else stays denied, without a prompt.
// A request from a frame of another origin than the tab's page is denied:
// the person is looking at the page, not at whatever it embeds.

// Electron's permission name (plus media type) -> the setting Kairos keeps.
function settingFor(permission, details = {}) {
  if (permission === "media") {
    const types = details.mediaTypes || [];
    if (types.includes("video")) return types.includes("audio") ? "camera+microphone" : "camera";
    if (types.includes("audio")) return "microphone";
    return null;
  }
  return { geolocation: "location", notifications: "notifications", "clipboard-read": "clipboard" }[permission] || null;
}

const ALWAYS = new Set(["fullscreen", "clipboard-sanitized-write"]);

function originOf(url) { try { return new URL(url).origin; } catch { return null; } }

function storedAnswer(store, url, setting) {
  // A combined camera+microphone request is allowed only if both are.
  const keys = setting === "camera+microphone" ? ["camera", "microphone"] : [setting];
  const values = keys.map((k) => store.getSite(url, `permission:${k}`));
  if (values.every((v) => v === "allow")) return "allow";
  if (values.some((v) => v === "block")) return "block";
  return null;
}

function remember(store, url, setting, answer) {
  const keys = setting === "camera+microphone" ? ["camera", "microphone"] : [setting];
  for (const k of keys) store.setSite(url, `permission:${k}`, answer);
}

// `ask({ webContents, origin, setting })` resolves to { answer: 'allow' |
// 'block', remember: boolean }. It is the UI's prompt; no answer means block.
// `speakerSelection()` says whether pages may pick an audio output, which
// Browse's own audio routing needs while a device is chosen (browser-audio.js).
function createPermissions({ store, ask, speakerSelection = () => false }) {
  function decide(webContents, permission, details = {}) {
    if (ALWAYS.has(permission)) return Promise.resolve(true);
    const setting = settingFor(permission, details);
    if (!setting) return Promise.resolve(false);
    const pageUrl = webContents && !webContents.isDestroyed() ? webContents.getURL() : "";
    const origin = originOf(pageUrl);
    const requester = originOf(details.requestingUrl || pageUrl);
    if (!origin || requester !== origin) return Promise.resolve(false);
    const known = storedAnswer(store, pageUrl, setting);
    if (known) return Promise.resolve(known === "allow");
    return Promise.resolve(ask({ webContents, origin, setting }))
      .then((reply) => {
        const answer = reply && reply.answer === "allow" ? "allow" : "block";
        if (reply && reply.remember) remember(store, pageUrl, setting, answer);
        return answer === "allow";
      })
      .catch(() => false);
  }

  // The synchronous check Chromium makes before some APIs: only what was
  // already allowed, never a prompt.
  function check(webContents, permission, requestingOrigin, details = {}) {
    if (ALWAYS.has(permission)) return true;
    if (permission === "speaker-selection") return !!speakerSelection();
    const setting = settingFor(permission, { ...details, mediaTypes: details.mediaType ? [details.mediaType] : [] });
    if (!setting || !webContents || webContents.isDestroyed()) return false;
    const pageUrl = webContents.getURL();
    if (originOf(requestingOrigin) && originOf(requestingOrigin) !== originOf(pageUrl)) return false;
    return storedAnswer(store, pageUrl, setting) === "allow";
  }

  function attach(partitionSession) {
    partitionSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      decide(wc, permission, details).then(callback, () => callback(false));
    });
    partitionSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => check(wc, permission, requestingOrigin, details));
    // USB, serial and HID device pickers stay off in Phase 1.
    partitionSession.setDevicePermissionHandler(() => false);
  }

  return { attach, decide, check };
}

module.exports = { createPermissions, _settingFor: settingFor };
