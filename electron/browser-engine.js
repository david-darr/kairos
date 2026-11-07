// electron/browser-engine.js — the engine-level pieces of Kairos Browser
// (vault: "Kairos Browser - Phase 1 (Build Spec)", U0).
//
// Kairos runs on castlabs' Electron for Content Security build so DRM video
// (Netflix, Disney+, Spotify web) can play: it adds Widevine, which Chromium
// downloads and keeps updated as a component. Stock Electron has no
// `components` module, so everything here degrades to a no-op there.
//
// Cookie encryption is a fuse electron-builder flips at package time
// (package.json build.electronFuses). Phase 0
// showed the catch: cookies written before the fuse stay in plain text on
// disk until something rewrites them. resaveCookies() rewrites each one once,
// so an upgrade does not leave the person's old sign-ins readable.

const fs = require("fs");
const path = require("path");

// Widevine is optional to the app: if it fails, DRM sites fail and nothing
// else does. Never awaited by start-up.
function startWidevine(electron, log = console) {
  const { components } = electron;
  if (!components || typeof components.whenReady !== "function") return Promise.resolve({ available: false });
  return components.whenReady()
    .then(() => ({ available: true, status: components.status() }))
    .catch((err) => {
      log.error(`[browser] Widevine did not install: ${err && err.message}`);
      return { available: false, error: String(err && err.message) };
    });
}

// The address a cookie belongs to, so cookies.set() writes it back to the
// same place. Host-only cookies must be set without `domain`, or they would
// come back as domain cookies that subdomains can read.
function cookieUrl(cookie) {
  const host = String(cookie.domain || "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

function cookieDetails(cookie) {
  const details = {
    url: cookieUrl(cookie), name: cookie.name, value: cookie.value, path: cookie.path,
    secure: cookie.secure, httpOnly: cookie.httpOnly,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
  // A session cookie has no expiry and must stay a session cookie.
  if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
  return details;
}

// Once per partition: a marker file in the browser data folder says it ran.
// Returns how many cookies were rewritten, or null when it already ran.
async function resaveCookies(partitionSession, markerFile, log = console) {
  if (fs.existsSync(markerFile)) return null;
  const cookies = await partitionSession.cookies.get({});
  let rewritten = 0;
  for (const cookie of cookies) {
    try {
      await partitionSession.cookies.set(cookieDetails(cookie));
      rewritten += 1;
    } catch (err) {
      // One odd cookie must not stop the rest; it stays as it was.
      log.error(`[browser] could not rewrite a cookie for ${cookie.domain}: ${err && err.message}`);
    }
  }
  await partitionSession.cookies.flushStore();
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString(), rewritten }));
  return rewritten;
}

module.exports = { startWidevine, resaveCookies, _cookieDetails: cookieDetails };
