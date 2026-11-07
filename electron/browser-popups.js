// electron/browser-popups.js — sign-in pop-ups for Browse tabs (Kairos
// Browser, David's feedback 2026-11-06: "sometimes it has trouble logging
// into certain websites such as twitter, or apps that open a new tab to
// signin").
//
// Why sign-ins failed: every window.open became a fresh tab loaded by
// address, so the sign-in page had no window.opener. "Sign in with Google /
// Apple / Microsoft / X" pop-ups hand their result back with
// window.opener.postMessage(...) and then window.close(), or the page waits
// for the pop-up to close; with no opener neither happened, and the page sat
// on its sign-in button.
//
// Now a sized window.open (what OAuth uses) opens as a real child window of
// the Kairos window:
//   - on the same profile partition as the tab, so the sign-in's cookies are
//     the person's and the opener relationship holds;
//   - the same isolation as a tab: no preload, sandbox, context isolation, no
//     node, http/https only through browser-gate.js on every navigation;
//   - the site's address always in its title bar, since the window has no
//     address field of its own (a pop-up must never pass for Kairos);
//   - closed when the page calls window.close(), when Browse closes, or by the
//     person.
// Anything a pop-up itself opens without a size goes to a Browse tab.

const GESTURE_MS = 5000;

function hostOf(url) { try { return new URL(url).host; } catch { return ""; } }

function createPopups({ host, session: partitionSession, safe, openTab = () => {} }) {
  const windows = new Set();

  function webPreferences() {
    return {
      session: partitionSession,
      // No preload: there is deliberately no bridge for a page to find.
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webviewTag: false, spellcheck: true,
    };
  }

  // The answer to setWindowOpenHandler for a sized window.open.
  function allow() {
    const parent = host();
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        parent: parent && !parent.isDestroyed() ? parent : undefined, modal: false, show: true,
        width: 520, height: 680, minWidth: 320, minHeight: 320, autoHideMenuBar: true, backgroundColor: "#ffffff",
        title: "Sign in", webPreferences: webPreferences(),
      },
    };
  }

  function titleFor(wc, title) {
    const where = hostOf(wc.getURL()) || "Loading";
    return title && title !== wc.getURL() ? `${where} - ${title}` : where;
  }

  // Called from the opener's did-create-window. `openerTab` is the Browse tab
  // that opened it, for anything the pop-up opens as a tab.
  function wire(child, openerTab) {
    if (!child || child.isDestroyed()) return;
    windows.add(child);
    child.on("closed", () => windows.delete(child));
    try { child.setMenu(null); } catch { /* no menu */ }
    const wc = child.webContents;
    let lastGesture = 0;
    // Centre it over Kairos.
    try {
      const parent = host();
      if (parent && !parent.isDestroyed()) {
        const p = parent.getBounds(), c = child.getBounds();
        child.setPosition(Math.round(p.x + (p.width - c.width) / 2), Math.round(p.y + Math.max(40, (p.height - c.height) / 2)));
      }
    } catch { /* placement is a nicety */ }
    const showTitle = (title) => { if (!child.isDestroyed()) child.setTitle(titleFor(wc, title)); };
    wc.on("page-title-updated", (event, title) => { event.preventDefault(); showTitle(title); });
    wc.on("did-navigate", () => showTitle(wc.getTitle()));
    wc.on("did-navigate-in-page", () => showTitle(wc.getTitle()));
    wc.on("will-navigate", (event, url) => { if (!safe(url)) event.preventDefault(); });
    wc.on("will-redirect", (event, url) => { if (!safe(url)) event.preventDefault(); });
    wc.on("input-event", (_e, input) => {
      if (["mouseDown", "keyDown", "rawKeyDown", "touchStart", "gestureTap"].includes(input.type)) lastGesture = Date.now();
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const target = safe(url);
      if (!target || Date.now() - lastGesture > GESTURE_MS) return { action: "deny" };
      if (disposition === "new-window") return allow();
      openTab(target, openerTab);
      return { action: "deny" };
    });
    wc.on("did-create-window", (grandchild) => wire(grandchild, openerTab));
    showTitle("");
  }

  function closeAll() {
    for (const win of [...windows]) { try { if (!win.isDestroyed()) win.destroy(); } catch { /* gone */ } }
    windows.clear();
  }

  return { allow, wire, closeAll, list: () => [...windows].filter((w) => !w.isDestroyed()), _webPreferences: webPreferences };
}

module.exports = { createPopups, _hostOf: hostOf };
