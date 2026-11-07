// electron/browser-gate.js — the one address gate for every page Kairos
// shows (vault: "Kairos Browser - Phase 1 (Build Spec)", U1).
//
// Moved out of browser.js so the side pane and Browse tabs judge addresses
// with the same code. Every entry point funnels through safeUrl(): the
// address bar, link clicks, redirects and window.open.
//
// Two policies, picked per caller:
//   - allowLoopback false (the side pane today, and anything a page could
//     steer): no loopback at all, as browser.js always did.
//   - allowLoopback true (the person's own Browse tabs, D4 "Always allow"):
//     local dev servers open, but Kairos's own backend and egress-proxy
//     ports never do, on any loopback spelling. Those ports are the
//     privileged surface; everything else on localhost is the person's.

function isLoopback(hostname) {
  const name = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "0:0:0:0:0:0:0:1") return true;
  // Only a bare IPv4 literal can be a loopback address. A prefix test like
  // /^127\./ also matches "127.0.0.1.example.test", which is an ordinary
  // registrable domain someone can own — blocking it would be wrong, and
  // silently so. Caught by scripts/browser-smoke.cjs.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) {
    const octets = name.split(".").map(Number);
    if (octets.every((o) => o <= 255)) return octets[0] === 127 || name === "0.0.0.0";
  }
  return false;
}

// Search engines the address bar can use. Google is the default (David,
// 2026-11-03: "I also want the searches to default to google").
const SEARCH = {
  duckduckgo: "https://duckduckgo.com/?q=",
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  brave: "https://search.brave.com/search?q=",
};

function portOf(url) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function createGate(options = {}) {
  let backendOrigin = options.backendOrigin || null;
  let reservedPorts = new Set(options.reservedPorts || []);
  let engine = SEARCH[options.searchEngine] ? options.searchEngine : "google";

  function setBackendOrigin(origin) {
    backendOrigin = origin || null;
    // The backend's own port is always reserved, whatever else is.
    try { if (origin) reservedPorts.add(portOf(new URL(origin))); } catch { /* not a URL */ }
  }
  setBackendOrigin(backendOrigin);

  function setReservedPorts(ports) {
    reservedPorts = new Set((ports || []).map(Number).filter((p) => Number.isInteger(p) && p > 0 && p < 65536));
    setBackendOrigin(backendOrigin);
  }

  function setSearchEngine(id) { if (SEARCH[id]) engine = id; }

  // Returns a normalized absolute URL string, or null when the target must
  // not load.
  function safeUrl(raw, { allowLoopback = false } = {}) {
    let parsed;
    try {
      parsed = new URL(String(raw || "").trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // Belt and braces: even if the backend somehow isn't on loopback (a
    // JARVIS_BACKEND_URL override), its origin stays off limits.
    if (backendOrigin && parsed.origin === backendOrigin) return null;
    if (isLoopback(parsed.hostname)) {
      if (!allowLoopback || reservedPorts.has(portOf(parsed))) return null;
    }
    return parsed.toString();
  }

  // What the user types is not a URL yet. "example.com" and "how tall is k2"
  // both arrive here; the first is a host, the second is a search.
  function fromAddressBar(input, opts = {}) {
    const text = String(input || "").trim();
    if (!text) return null;
    // localhost:3000 and 127.0.0.1:8080 are addresses, not a "localhost:"
    // scheme. Checked first, then anything with a scheme is taken literally,
    // so a typed bad scheme is refused rather than turned into a search.
    if (/^(localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$|\?|#)/i.test(text)) return safeUrl(`http://${text}`, opts);
    // example.com:8080 is a host and port, not an "example.com:" scheme.
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+:\d{1,5}(\/|$|\?|#)/i.test(text)) return safeUrl(`https://${text}`, opts);
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return safeUrl(text, opts);
    // A bare token with a dot and no spaces is a hostname; anything else is a
    // search phrase. Deliberately simple and predictable rather than clever.
    if (/^[^\s/]+\.[^\s/]{2,}(\/|$|\?|#)/i.test(text)) return safeUrl(`https://${text}`, opts);
    return safeUrl(SEARCH[engine] + encodeURIComponent(text), opts);
  }

  return { safeUrl, fromAddressBar, setBackendOrigin, setReservedPorts, setSearchEngine,
    searchEngine: () => engine, reservedPorts: () => [...reservedPorts] };
}

module.exports = { createGate, isLoopback, SEARCH };
