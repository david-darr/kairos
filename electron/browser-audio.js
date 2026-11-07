// electron/browser-audio.js — which speakers Browse plays through (Kairos
// Browser, David's feedback 2026-11-06: "an audio selector is needed in the
// browsers settings").
//
// Electron has no per-window audio output, so routing is done the way a web
// page would do it itself: every media element and Web Audio context in a
// Browse page is pointed at the chosen device with setSinkId(). A device id
// is different for every site (Chromium hashes it per origin), so Kairos
// keeps the device's name and each page looks its own id up by that name.
//   - The choice is kept in the account's Browse profile (browser.db meta),
//     so each Kairos account has its own. Empty means the system default.
//   - A small script goes into each page's frames (the page's own world,
//     where its audio objects live) when the page loads and whenever the
//     choice changes. It only routes audio; it reads nothing.
//   - Unplugged: the page's devicechange finds the name gone and plays on
//     the system default; plugged back in, it goes back.
//   - While a device is chosen, Browse pages are allowed the
//     "speaker-selection" permission check, which setSinkId needs. That lets
//     a page list the names of the audio outputs, a small privacy cost; with
//     "System default" nothing is allowed, as before.
// Limits: a Web Audio context a page creates before its document has loaded
// keeps the default device until the page reloads; and setSinkId exists only
// in secure contexts, so a plain-http site (other than localhost) always
// plays on the system default.

const MAX_LABEL = 300;

function routeScript(label) {
  return `((label) => {
  const KEY = Symbol.for('kairos.audioOutput');
  let st = window[KEY];
  if (!st) {
    st = { label: '', id: '', contexts: new Set() };
    Object.defineProperty(window, KEY, { value: st });
    const route = (el) => { try { if (typeof el.setSinkId === 'function' && el.sinkId !== st.id) el.setSinkId(st.id).catch(() => {}); } catch (e) {} };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) { route(this); return play.apply(this, args); };
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Original = window[name];
      if (typeof Original !== 'function') continue;
      window[name] = new Proxy(Original, { construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget);
        st.contexts.add(new WeakRef(ctx));
        if (st.id && typeof ctx.setSinkId === 'function') ctx.setSinkId(st.id).catch(() => {});
        return ctx;
      } });
    }
    st.apply = () => {
      document.querySelectorAll('audio, video').forEach(route);
      for (const ref of st.contexts) {
        const ctx = ref.deref();
        if (!ctx || ctx.state === 'closed') { st.contexts.delete(ref); continue; }
        if (typeof ctx.setSinkId === 'function' && ctx.sinkId !== st.id) ctx.setSinkId(st.id).catch(() => {});
      }
    };
    st.resolve = async () => {
      let id = '';
      if (st.label && navigator.mediaDevices) {
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          const found = all.find((d) => d.kind === 'audiooutput' && d.label === st.label && d.deviceId !== 'default' && d.deviceId !== 'communications');
          id = found ? found.deviceId : '';
        } catch (e) { id = ''; }
      }
      st.id = id;
      st.apply();
      return id ? 'routed' : 'default';
    };
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', () => st.resolve());
  }
  st.label = label;
  return st.resolve();
})(${JSON.stringify(label)})`;
}

function cleanLabel(value) {
  return typeof value === "string" && value.length <= MAX_LABEL && !/[\u0000-\u001f]/.test(value) ? value : null;
}

function createAudio({ store }) {
  let label = cleanLabel(store.getMeta("audioOutput") || "") || "";
  const pages = new Set();
  // Pages that have had a device set, so going back to the default resets them.
  const touched = new WeakSet();

  function applyFrame(frame) {
    try { if (frame && !frame.isDestroyed() && /^https?:/.test(frame.url)) return frame.executeJavaScript(routeScript(label)).catch(() => null); } catch { /* frame gone */ }
    return Promise.resolve(null);
  }

  function apply(wc) {
    if (!wc || wc.isDestroyed() || (!label && !touched.has(wc))) return Promise.resolve([]);
    if (label) touched.add(wc);
    let frames = [];
    try { frames = wc.mainFrame.framesInSubtree; } catch { frames = []; }
    return Promise.all(frames.map(applyFrame));
  }

  function attach(wc) {
    pages.add(wc);
    wc.on("dom-ready", () => { if (label) touched.add(wc); apply(wc); });
    // Frames that load later (a video player in an iframe).
    wc.on("did-frame-finish-load", (_e, isMainFrame, processId, routingId) => {
      if (isMainFrame || !label) return;
      try {
        const { webFrameMain } = require("electron");
        applyFrame(webFrameMain.fromId(processId, routingId));
      } catch { /* frame gone */ }
    });
    wc.once("destroyed", () => pages.delete(wc));
  }

  function set(value) {
    const next = cleanLabel(value);
    if (next === null) return { ok: false };
    label = next;
    store.setMeta("audioOutput", label);
    return Promise.all([...pages].map(apply)).then(() => ({ ok: true, label }));
  }

  return { attach, set, get: () => label, allowSpeakerSelection: () => !!label, apply, _routeScript: routeScript };
}

module.exports = { createAudio, _routeScript: routeScript, _cleanLabel: cleanLabel };
