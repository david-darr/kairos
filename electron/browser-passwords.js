// electron/browser-passwords.js — the password keeper in Browse tabs (Kairos
// Browser, David's feedback 2026-11-06: "it needs a proper password keeper").
//
// The saved passwords live in the backend, per Kairos account, encrypted with
// the account's own key (services/browse_passwords.py). This module is the
// part that touches pages:
//   - It watches sign-in forms in a tab's top document (and frames of the
//     same origin) from an isolated world: page scripts can't see or change
//     what it reads. When a sign-in looks successful (the page navigated, or
//     the password field went away), Browse OFFERS to save it. Nothing is
//     ever saved without the person's click.
//   - When a page shows a sign-in field and passwords are saved for exactly
//     that origin, Browse suggests them in a strip above the page; Fill puts
//     the username and password into the page. Only the exact origin it was
//     saved for, checked here and again in the backend, and never into a
//     frame of another origin (the fill script can't even reach one).
//   - On a sign-up form it offers a strong password and fills it in.
//
// Values travel only from the page to the backend (save) and from the
// backend to the page (fill), through this process's memory. They are never
// logged, never sent to the app's page, and a pending offer is forgotten
// after three minutes or when its tab closes.
//
// Talking to a page without a preload: executeJavaScriptInIsolatedWorld()
// returns a promise's value, so main arms a promise in the page ("tell me at
// the next sign-in") and gets the answer as the reply. No console messages,
// no globals in the page's own world.

const crypto = require("crypto");

const WORLD = 1002;
const OFFER_MS = 3 * 60 * 1000;
const SETTLE_MS = 4000;
const MATCH_CACHE_MS = 20000;

// -- the scripts run in the page's isolated world -------------------------

// Shared helpers, inlined at the top of each script.
const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const textLike = (i) => i && i.tagName === 'INPUT' && ['text', 'email', 'tel', ''].includes((i.getAttribute('type') || '').toLowerCase());
  const isNew = (i) => /new-password/i.test(i.getAttribute('autocomplete') || '');
  const isUserField = (i) => textLike(i) && /\\b(username|email)\\b/i.test(i.getAttribute('autocomplete') || '');
  // This document and any frame of the same origin; another origin's frame
  // throws on access and is skipped, so nothing here ever reaches one.
  const docs = () => { const out = [document]; for (const f of document.querySelectorAll('iframe, frame')) { try { if (f.contentWindow.location.origin === location.origin && f.contentDocument) out.push(f.contentDocument); } catch (e) {} } return out; };
`;

// Resolves with { username, password, isNew } at the next sign-in submit, or
// null when the page goes away. Listeners are installed once per document.
const CAPTURE = `(() => {
  ${HELPERS}
  let s = window.__kairosPasswords;
  if (!s) {
    s = window.__kairosPasswords = { waiters: [], lastUser: '', lastKey: '', watched: new WeakSet() };
    const userFor = (pw) => {
      const scope = pw.form || pw.ownerDocument;
      const inputs = [...scope.querySelectorAll('input')];
      const marked = inputs.find((i) => isUserField(i) && i.value);
      if (marked) return marked.value;
      for (let k = inputs.indexOf(pw) - 1; k >= 0; k--) if (textLike(inputs[k]) && inputs[k].value && visible(inputs[k])) return inputs[k].value;
      return s.lastUser;
    };
    const fire = (pw) => {
      const fields = [...(pw.form || pw.ownerDocument).querySelectorAll('input[type=password]')].filter((i) => i.value);
      if (!fields.length) return;
      const chosen = fields.find(isNew) || (fields.length >= 2 ? fields[fields.length - 1] : fields[0]);
      const result = { username: String(userFor(pw) || '').slice(0, 1000), password: String(chosen.value).slice(0, 1000), isNew: fields.some(isNew) || fields.length >= 2 };
      const key = result.username + '\\n' + result.password;
      if (key === s.lastKey) return;
      s.lastKey = key; setTimeout(() => { if (s.lastKey === key) s.lastKey = ''; }, 3000);
      const waiting = s.waiters; s.waiters = [];
      for (const w of waiting) w(result);
    };
    const watch = (d) => {
      if (s.watched.has(d)) return; s.watched.add(d);
      d.addEventListener('submit', (e) => { const pw = e.target.querySelector && e.target.querySelector('input[type=password]'); if (pw) fire(pw); }, true);
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target && e.target.type === 'password') fire(e.target); }, true);
      d.addEventListener('click', (e) => {
        const b = e.target.closest && e.target.closest('button, input[type=submit], input[type=button], [role=button]');
        if (!b) return;
        const scope = b.form || b.closest('form') || d;
        const pw = [...scope.querySelectorAll('input[type=password]')].find((i) => i.value && visible(i));
        if (pw) fire(pw);
      }, true);
      // Username-first sign-ins (one screen for the name, the next for the
      // password): remember the name typed before the password screen.
      const note = (e) => { if (textLike(e.target) && e.target.value && e.target.value.length <= 200) s.lastUser = e.target.value; };
      d.addEventListener('input', note, true);
      d.addEventListener('change', note, true);
    };
    s.watch = watch;
    watch(document);
    addEventListener('pagehide', () => { const waiting = s.waiters; s.waiters = []; for (const w of waiting) w(null); });
  }
  // Frames of the same origin that loaded since (a sign-in form in one).
  for (const d of docs()) { try { s.watch(d); } catch (e) {} }
  return new Promise((resolve) => s.waiters.push(resolve));
})()`;

// Resolves when a sign-in field shows: { kind: 'password' | 'username',
// newPassword }. `want` is 'any' or 'password' (after a username step).
const presence = (want) => `(() => new Promise((resolve) => {
  ${HELPERS}
  const want = ${JSON.stringify(want)};
  const check = () => {
    for (const d of docs()) {
      const pws = [...d.querySelectorAll('input[type=password]')].filter(visible);
      if (pws.length) return { kind: 'password', newPassword: pws.some(isNew) || (pws.length >= 2 && pws.every((i) => !i.value)) };
    }
    if (want === 'any') for (const d of docs()) if ([...d.querySelectorAll('input')].some((i) => isUserField(i) && visible(i))) return { kind: 'username', newPassword: false };
    return null;
  };
  const first = check();
  if (first) return resolve(first);
  let timer = null;
  const mo = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; const found = check(); if (found) { mo.disconnect(); resolve(found); } }, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
  addEventListener('pagehide', () => { mo.disconnect(); resolve(null); }, { once: true });
}))()`;

// Whether a filled-in password field is still on screen (a failed sign-in
// usually leaves the form up).
const STILL_THERE = `(() => { ${HELPERS} return docs().some((d) => [...d.querySelectorAll('input[type=password]')].some((i) => i.value && visible(i))); })()`;

// Puts values into the page. Refuses unless the document is still `origin`.
const fillScript = (origin, mode, username, password) => `((origin, mode, username, password) => {
  ${HELPERS}
  if (location.origin !== origin) return { filled: 0 };
  const setValue = (input, value) => {
    let proto = Object.getPrototypeOf(input), desc = null;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    input.focus();
    if (desc && desc.set) desc.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  let filled = 0;
  for (const d of docs()) {
    const pws = [...d.querySelectorAll('input[type=password]')].filter(visible);
    if (mode === 'generate') {
      const targets = pws.filter(isNew).length ? pws.filter(isNew) : (pws.length >= 2 ? pws.slice(-2) : pws);
      for (const input of targets) { setValue(input, password); filled++; }
      if (filled) break;
      continue;
    }
    const pw = pws.find((i) => !isNew(i)) || null;
    const scope = (pw && pw.form) || d;
    const inputs = [...scope.querySelectorAll('input')].filter(visible);
    let user = inputs.find(isUserField) || null;
    if (!user && pw) { const at = inputs.indexOf(pw); for (let k = at - 1; k >= 0; k--) if (textLike(inputs[k])) { user = inputs[k]; break; } }
    if (!user && !pw) { const texts = inputs.filter(textLike); if (texts.length === 1) user = texts[0]; }
    if (user && username) { setValue(user, username); filled++; }
    if (pw && password) { setValue(pw, password); filled++; }
    if (filled) break;
  }
  return { filled };
})(${JSON.stringify(origin)}, ${JSON.stringify(mode)}, ${JSON.stringify(username || "")}, ${JSON.stringify(password || "")})`;

// -- strong passwords ------------------------------------------------------

const SYMBOLS = "-_.!@#$%*+=";
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" + SYMBOLS;
function generatePassword(length = 20) {
  const n = Math.max(12, Math.min(64, length | 0));
  for (;;) {
    let out = "";
    for (let i = 0; i < n; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\d/.test(out) && [...out].some((c) => SYMBOLS.includes(c))) return out;
  }
}

function originOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
}

// -- the module ------------------------------------------------------------

// `backend(route, body)` calls the backend's desktop routes
// (/api/browse/passwords/desktop/<route>) and resolves with the JSON, or
// rejects; `send(channel, payload)` talks to the app's page.
function createPasswords({ backend, send = () => {}, log = console }) {
  const pages = new Map();     // tab id -> { wc, gen, origin, capture, suggestion }
  const offers = new Map();    // offer id -> { tabId, origin, username, password, expires }
  const matchCache = new Map(); // origin -> { at, value }
  let nextOffer = 1;

  const quiet = (label) => (err) => { log.error(`[browse] passwords: ${label}: ${err && err.name ? err.name : "failed"}`); return null; };
  const run = (wc, code) => (wc.isDestroyed() ? Promise.resolve(null) : wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]));
  const pageOrigin = (wc) => { try { return originOf(wc.getURL()); } catch { return null; } };

  async function match(origin) {
    const hit = matchCache.get(origin);
    if (hit && Date.now() - hit.at < MATCH_CACHE_MS) return hit.value;
    const value = await backend("match", { url: origin });
    matchCache.set(origin, { at: Date.now(), value });
    return value;
  }

  // A sign-in counts as successful when the page moves on after it: a new
  // page that isn't an error (did-navigate), or a single-page site changing
  // its address (did-navigate-in-page). The capture and the navigation reach
  // main in either order, so each navigation is numbered and a capture looks
  // for one numbered after its document was armed.
  function attach(tab, wc) {
    const state = { wc, gen: 0, docGen: 0, origin: null, capture: null, settleTimer: null, suggestion: null,
      navSeq: 0, armedSeq: 0, lastNav: { at: 0, ok: false } };
    pages.set(tab.id, state);
    const navigated = (ok) => {
      state.navSeq += 1;
      state.lastNav = { at: Date.now(), ok };
      if (state.capture) settle(tab.id, state, ok);
    };
    wc.on("dom-ready", () => { state.docGen += 1; state.armedSeq = state.navSeq; arm(tab.id, state, "any", true); });
    wc.on("did-navigate", (_e, _url, code) => navigated(!(code >= 400)));
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (!isMainFrame) return;
      navigated(true);
      arm(tab.id, state, "any", false);
    });
    wc.once("destroyed", () => forget(tab.id));
  }

  function forget(tabId) {
    const state = pages.get(tabId);
    if (state) { clearTimeout(state.settleTimer); state.capture = null; }
    pages.delete(tabId);
    for (const [id, offer] of offers) if (offer.tabId === tabId) offers.delete(id);
  }

  // A new document (newDoc) or an in-page route: watch for its sign-in. The
  // capture is per document; the sign-in field watch restarts on each route.
  function arm(tabId, state, want, newDoc) {
    const origin = pageOrigin(state.wc);
    state.gen += 1;
    const gen = state.gen;
    state.origin = origin;
    if (state.suggestion) { state.suggestion = null; send("browse:password-suggest", { tabId, origin: null }); }
    if (!origin) return;
    if (newDoc) captureLoop(tabId, state, state.docGen, origin, state.armedSeq);
    watchPresence(tabId, state, gen, origin, want);
  }

  function captureLoop(tabId, state, docGen, origin, armedSeq) {
    run(state.wc, CAPTURE).then((result) => {
      if (!result || typeof result.password !== "string" || !result.password) return;
      clearTimeout(state.settleTimer);
      state.capture = { origin, username: String(result.username || ""), password: result.password, at: Date.now() };
      if (state.docGen === docGen) captureLoop(tabId, state, docGen, origin, armedSeq);
      // The page already moved on (its navigation arrived first).
      if (state.navSeq > armedSeq && Date.now() - state.lastNav.at < 3000) return settle(tabId, state, state.lastNav.ok);
      // No navigation within a few seconds: the sign-in worked if the
      // password field is gone (single-page sites), not if it's still there.
      state.settleTimer = setTimeout(async () => {
        if (!state.capture) return;
        const still = await run(state.wc, STILL_THERE).catch(() => true);
        if (state.capture) settle(tabId, state, still === false);
      }, SETTLE_MS);
    }, () => { /* the page went away */ });
  }

  async function settle(tabId, state, success) {
    const capture = state.capture;
    state.capture = null;
    clearTimeout(state.settleTimer);
    if (!capture || !success) return;
    let known = null;
    try { known = await backend("known", { url: capture.origin, username: capture.username, password: capture.password }); }
    catch (err) { return quiet("known")(err); }
    if (!known || known.saved || known.never) return;
    const offerId = nextOffer++;
    offers.set(offerId, { tabId, ...capture, expires: Date.now() + OFFER_MS });
    setTimeout(() => offers.delete(offerId), OFFER_MS).unref?.();
    matchCache.delete(capture.origin);
    send("browse:password-offer", { offerId, tabId, origin: capture.origin, username: capture.username, update: !!known.update });
  }

  function watchPresence(tabId, state, gen, origin, want) {
    run(state.wc, presence(want)).then(async (found) => {
      if (!found || state.gen !== gen || pageOrigin(state.wc) !== origin) return;
      let saved = null;
      try { saved = await match(origin); } catch (err) { quiet("match")(err); }
      if (state.gen !== gen) return;
      const logins = (saved && Array.isArray(saved.logins) ? saved.logins : []).slice(0, 20).map((l) => ({ id: String(l.id), username: String(l.username || "") }));
      const generate = found.kind === "password" && !!found.newPassword;
      if (logins.length || generate) {
        state.suggestion = { origin, kind: found.kind };
        send("browse:password-suggest", { tabId, origin, kind: found.kind, logins, generate });
      }
      // A username-first sign-in shows its password field next.
      if (found.kind === "username") watchPresence(tabId, state, gen, origin, "password");
    }, () => { /* the page went away */ });
  }

  // The person pressed Fill for one saved sign-in.
  async function fill(tabId, loginId) {
    const state = pages.get(tabId);
    if (!state || !state.suggestion) return { ok: false };
    const origin = pageOrigin(state.wc);
    if (!origin || origin !== state.suggestion.origin) return { ok: false };
    let creds;
    try { creds = await backend("fill", { id: loginId, url: origin }); } catch (err) { quiet("fill")(err); return { ok: false }; }
    if (!creds || pageOrigin(state.wc) !== origin) return { ok: false };
    const result = await run(state.wc, fillScript(origin, "login", creds.username, creds.password)).catch(quiet("fill script"));
    creds = null;
    return { ok: !!(result && result.filled), filled: (result && result.filled) || 0 };
  }

  // A strong password into a sign-up form; the save offer follows the submit.
  async function useGenerated(tabId) {
    const state = pages.get(tabId);
    if (!state || !state.suggestion) return { ok: false };
    const origin = pageOrigin(state.wc);
    if (!origin || origin !== state.suggestion.origin) return { ok: false };
    const result = await run(state.wc, fillScript(origin, "generate", "", generatePassword())).catch(quiet("generate script"));
    return { ok: !!(result && result.filled), filled: (result && result.filled) || 0 };
  }

  async function answer(offerId, action) {
    const offer = offers.get(offerId);
    offers.delete(offerId);
    if (!offer || offer.expires < Date.now()) return { ok: false };
    try {
      if (action === "save") await backend("save", { url: offer.origin, username: offer.username, password: offer.password });
      else if (action === "never") await backend("never", { url: offer.origin });
      matchCache.delete(offer.origin);
      return { ok: true };
    } catch (err) { quiet(action)(err); return { ok: false }; }
  }

  function close() {
    for (const state of pages.values()) clearTimeout(state.settleTimer);
    pages.clear(); offers.clear(); matchCache.clear();
  }

  return { attach, fill, useGenerated, answer, close, forget, _offers: offers, _pages: pages };
}

// Import another browser's exported CSV (Chrome, Edge, Opera, Firefox and
// the like): the person picks the file, the backend adds it to this
// account's passwords, then Kairos offers to move the file to the Recycle
// Bin, since it holds every password in plain text (design D5).
const IMPORT_MAX = 5 * 1024 * 1024;
async function importCsv({ dialog, fs, shell, parent, post }) {
  const picked = await dialog.showOpenDialog(parent || undefined, {
    title: "Import passwords", buttonLabel: "Import", properties: ["openFile"],
    filters: [{ name: "Password export (CSV)", extensions: ["csv"] }],
  });
  if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
  const file = picked.filePaths[0];
  let text;
  try {
    if (fs.statSync(file).size > IMPORT_MAX) return { ok: false, message: "That file is too large to be a password export." };
    text = fs.readFileSync(file, "utf8");
  } catch { return { ok: false, message: "That file couldn't be read." }; }
  let counts;
  try { counts = await post(text); } catch (err) { return { ok: false, message: (err && err.message) || "Kairos couldn't import that file." }; }
  text = null;
  const answer = await dialog.showMessageBox(parent || undefined, {
    type: "question", buttons: ["Move to Recycle Bin", "Keep the file"], defaultId: 0, cancelId: 1, noLink: true,
    title: "Import passwords", message: `Imported ${counts.added} new and ${counts.updated} updated passwords.`,
    detail: "The exported file still holds your passwords as plain text. Move it to the Recycle Bin?",
  });
  let trashed = false;
  if (answer.response === 0) { try { await shell.trashItem(file); trashed = true; } catch { trashed = false; } }
  return { ok: true, ...counts, trashed };
}

module.exports = { createPasswords, importCsv, generatePassword, _fillScript: fillScript, _presence: presence, CAPTURE, WORLD };
