// electron/browser-adblock.js — Kairos's own ad and tracker blocker (vault:
// "Kairos Browser - Phase 1 (Build Spec)", U1; David chose Kairos's own
// matcher over a package, 2026-11-03).
//
// Reads the common Adblock Plus / uBlock list syntax:
//   network rules   ||ads.example.com^  /banner/*  |https://x.test/  @@exceptions
//   options         $third-party $~third-party $domain=a.com|~b.com $script
//                   $image $stylesheet $xmlhttprequest $subdocument $media
//                   $font $object $ping $websocket $other $important
//   element hiding  ##.ad   example.com##.banner   ~sub.example.com##.x   #@#
// Anything else (scriptlets ##+js, $redirect, $removeparam, $csp, regex rules,
// procedural selectors like :has-text) is skipped and counted, so it is
// visible how much of a list is not applied. Honest limit: without
// scriptlets, YouTube's video ads and some anti-adblock walls get through.
//
// Speed: rules are indexed once when lists load. ||host rules go in a map by
// host, so a request walks its host's suffixes; the rest go under their
// rarest-looking token. A request check touches a handful of rules.
//
// Element hiding is applied by browser-tabs.js with insertCSS from main,
// never a preload, so pages still have no bridge to find.

const TYPES = {
  script: "script", image: "image", stylesheet: "stylesheet", xmlhttprequest: "xhr", xhr: "xhr",
  subdocument: "subFrame", frame: "subFrame", media: "media", font: "font", object: "object",
  ping: "ping", websocket: "webSocket", other: "other",
};
// Option words that change matching in ways this engine does not implement.
// A rule carrying one is skipped rather than applied wrongly.
const UNSUPPORTED = new Set(["redirect", "redirect-rule", "removeparam", "csp", "rewrite", "replace", "header",
  "permissions", "urlskip", "uritransform", "empty", "mp4", "popup", "popunder", "generichide", "ghide",
  "elemhide", "ehide", "specifichide", "shide", "document", "doc", "badfilter", "strict1p", "strict3p",
  "inline-script", "inline-font", "to", "from", "method", "denyallow", "cname", "all"]);
const PROCEDURAL = /:(-abp-|has-text|matches-css|matches-attr|matches-path|xpath|upward|remove|style|watch-attr|min-text-length|others|if|if-not|nth-ancestor|matches-media)\b/;

// A small list of two-label public suffixes so co.uk sites are first-party to
// each other. Not the full Public Suffix List: good enough for third-party
// checks on ads, not a security boundary.
const SECOND_LEVEL = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp",
  "ne.jp", "or.jp", "com.br", "com.mx", "co.in", "co.kr", "com.cn", "com.tw", "com.tr", "co.za", "com.sg", "com.ar"]);

function siteOf(host) {
  const labels = String(host || "").toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const tail2 = labels.slice(-2).join(".");
  return SECOND_LEVEL.has(tail2) ? labels.slice(-3).join(".") : tail2;
}

function hostMatches(host, domain) { return host === domain || host.endsWith("." + domain); }

// $domain= and element-hiding domain lists: included and excluded hosts.
function parseDomains(list, separator) {
  const include = [], exclude = [];
  for (const raw of list.split(separator)) {
    const d = raw.trim().toLowerCase();
    if (!d) continue;
    if (d.startsWith("~")) exclude.push(d.slice(1)); else include.push(d);
  }
  return { include, exclude };
}

function domainAllowed(host, rule) {
  if (rule.exclude && rule.exclude.some((d) => hostMatches(host, d))) return false;
  if (rule.include && rule.include.length) return rule.include.some((d) => hostMatches(host, d));
  return true;
}

function escapeRegex(text) { return text.replace(/[.+?${}()[\]\\]/g, "\\$&"); }

// The filter pattern as a regular expression over the full URL.
function patternRegex(pattern) {
  let p = pattern, prefix = "", suffix = "";
  if (p.startsWith("||")) { p = p.slice(2); prefix = "^[a-z][a-z0-9+.-]*://([^/?#]*\\.)?"; }
  else if (p.startsWith("|")) { p = p.slice(1); prefix = "^"; }
  if (p.endsWith("|")) { p = p.slice(0, -1); suffix = "$"; }
  // "|" is escaped first: the "^" separator's replacement contains one.
  const body = escapeRegex(p).replace(/\|/g, "\\|").replace(/\*/g, ".*").replace(/\^/g, "(?:[^a-zA-Z0-9_.%-]|$)");
  return new RegExp(prefix + body + suffix, "i");
}

// The token a non-host rule is filed under: the longest run of letters and
// digits that is not next to a wildcard (so it must appear in any match).
function tokenOf(pattern) {
  let best = "";
  const re = /[a-z0-9%]{3,}/gi;
  let m;
  while ((m = re.exec(pattern))) {
    const before = pattern[m.index - 1], after = pattern[m.index + m[0].length];
    if (before === "*" || after === "*") continue;
    if (m[0].length > best.length) best = m[0].toLowerCase();
  }
  return best;
}

function urlTokens(url) { return String(url).toLowerCase().match(/[a-z0-9%]{3,}/g) || []; }

function parseNetwork(line) {
  let text = line, exception = false;
  if (text.startsWith("@@")) { exception = true; text = text.slice(2); }
  if (/^\/.*\/$/.test(text) || /^\/.*\/\$/.test(text)) return { skip: "regex" };
  let options = "";
  const dollar = text.lastIndexOf("$");
  if (dollar > 0 && !/[/=]/.test(text.slice(dollar + 1, dollar + 2) || "")) { options = text.slice(dollar + 1); text = text.slice(0, dollar); }
  const rule = { exception, important: false, thirdParty: null, types: null, notTypes: null, include: null, exclude: null };
  for (const raw of options ? options.split(",") : []) {
    const opt = raw.trim().toLowerCase();
    const negated = opt.startsWith("~");
    const name = (negated ? opt.slice(1) : opt).split("=")[0];
    if (name === "third-party" || name === "3p") rule.thirdParty = !negated;
    else if (name === "first-party" || name === "1p") rule.thirdParty = negated;
    else if (name === "domain") Object.assign(rule, parseDomains(opt.slice(7), "|"));
    else if (name === "important") rule.important = true;
    else if (name === "match-case") continue;
    else if (TYPES[name]) {
      if (negated) (rule.notTypes = rule.notTypes || new Set()).add(TYPES[name]);
      else (rule.types = rule.types || new Set()).add(TYPES[name]);
    } else return { skip: UNSUPPORTED.has(name) ? name : "unknown option" };
  }
  if (!text || text === "*" || text === "|" || text === "||") {
    // A bare option rule ($script,domain=x) matches every URL of that kind.
    if (!rule.types && !rule.include) return { skip: "too broad" };
    text = "*";
  }
  rule.pattern = text;
  rule.regex = patternRegex(text);
  // ||host^ and ||host/ rules are filed under their host.
  const anchored = /^\|\|([a-z0-9.-]+)(?=[\^/:*|]|$)/i.exec(text);
  if (anchored && !anchored[1].includes("*")) rule.host = anchored[1].toLowerCase();
  return { rule };
}

function createAdblock() {
  let hostRules = new Map(), tokenRules = new Map(), looseRules = [];
  let hideGeneric = [], hideSpecific = [], hideExceptions = [];
  let stats = { lists: 0, network: 0, cosmetic: 0, skipped: 0, skippedBy: {} };
  const cssCache = new Map();

  function file(rule) {
    if (rule.host) {
      if (!hostRules.has(rule.host)) hostRules.set(rule.host, []);
      hostRules.get(rule.host).push(rule);
      return;
    }
    const token = tokenOf(rule.pattern);
    if (!token) { looseRules.push(rule); return; }
    if (!tokenRules.has(token)) tokenRules.set(token, []);
    tokenRules.get(token).push(rule);
  }

  function skip(why) {
    stats.skipped += 1;
    stats.skippedBy[why] = (stats.skippedBy[why] || 0) + 1;
  }

  function addLine(raw) {
    const line = raw.trim();
    if (!line || line.startsWith("!") || line.startsWith("[")) return;
    const cosmetic = /^([^#]*)(##\+js|#@#\+js|#@\?#|#@\$#|#@%#|#@#|#\?#|#\$#|#%#|##)(.*)$/.exec(line);
    if (cosmetic) {
      const [, domains, marker, selector] = cosmetic;
      if (marker !== "##" && marker !== "#@#") return skip(marker.includes("+js") || marker.includes("%") ? "scriptlet" : "extended css");
      if (selector.startsWith("+js(") || PROCEDURAL.test(selector) || !selector.trim()) return skip("procedural");
      const rule = { selector: selector.trim(), ...parseDomains(domains, ",") };
      if (marker === "#@#") hideExceptions.push(rule);
      else if (rule.include.length) hideSpecific.push(rule);
      else hideGeneric.push(rule);
      stats.cosmetic += 1;
      return;
    }
    const parsed = parseNetwork(line);
    if (parsed.skip) return skip(parsed.skip);
    file(parsed.rule);
    stats.network += 1;
  }

  // Replace every list at once. `lists` is an array of list texts.
  function load(lists) {
    hostRules = new Map(); tokenRules = new Map(); looseRules = [];
    hideGeneric = []; hideSpecific = []; hideExceptions = [];
    stats = { lists: lists.length, network: 0, cosmetic: 0, skipped: 0, skippedBy: {} };
    cssCache.clear();
    for (const text of lists) for (const line of String(text).split(/\r?\n/)) addLine(line);
    return stats;
  }

  function applies(rule, url, ctx) {
    if (rule.types && !rule.types.has(ctx.type)) return false;
    if (rule.notTypes && rule.notTypes.has(ctx.type)) return false;
    if (rule.thirdParty !== null && rule.thirdParty !== ctx.thirdParty) return false;
    if ((rule.include || rule.exclude) && !domainAllowed(ctx.sourceHost, rule)) return false;
    return rule.regex.test(url);
  }

  function candidates(url, host) {
    const out = [];
    const labels = host.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const found = hostRules.get(labels.slice(i).join("."));
      if (found) out.push(...found);
    }
    for (const token of new Set(urlTokens(url))) {
      const found = tokenRules.get(token);
      if (found) out.push(...found);
    }
    out.push(...looseRules);
    return out;
  }

  // Should this request be blocked? `type` is Electron's resourceType;
  // `sourceUrl` is the page that made the request. Pages themselves
  // (mainFrame) are never blocked: the person asked for them.
  function match(url, { type = "other", sourceUrl = "" } = {}) {
    if (type === "mainFrame") return { block: false };
    let host, sourceHost;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return { block: false }; }
    try { sourceHost = new URL(sourceUrl).hostname.toLowerCase(); } catch { sourceHost = ""; }
    const ctx = { type, sourceHost, thirdParty: !!sourceHost && siteOf(host) !== siteOf(sourceHost) };
    let blocked = null, important = false;
    const rules = candidates(url, host);
    for (const rule of rules) {
      if (rule.exception || !applies(rule, url, ctx)) continue;
      blocked = rule;
      if (rule.important) { important = true; break; }
    }
    if (!blocked) return { block: false };
    if (!important) {
      for (const rule of rules) if (rule.exception && applies(rule, url, ctx)) return { block: false, exception: rule.pattern };
    }
    return { block: true, rule: blocked.pattern };
  }

  // Element-hiding CSS for a page's host, cached per host.
  function cosmeticCss(pageHost) {
    const host = String(pageHost || "").toLowerCase();
    if (cssCache.has(host)) return cssCache.get(host);
    const excepted = new Set(hideExceptions.filter((r) => domainAllowed(host, r)).map((r) => r.selector));
    const selectors = [];
    for (const r of hideGeneric) if (!excepted.has(r.selector) && domainAllowed(host, r)) selectors.push(r.selector);
    for (const r of hideSpecific) if (!excepted.has(r.selector) && domainAllowed(host, r)) selectors.push(r.selector);
    // Chunked so one selector the engine can't parse only voids its chunk.
    const chunks = [];
    for (let i = 0; i < selectors.length; i += 500) chunks.push(`${selectors.slice(i, i + 500).join(",\n")} { display: none !important; }`);
    const css = chunks.join("\n");
    if (cssCache.size > 500) cssCache.clear();
    cssCache.set(host, css);
    return css;
  }

  // The request filter for a partition. `enabledFor(pageUrl)` is the
  // per-site off switch; `onBlocked(webContentsId)` feeds the count shown
  // in the address field. Electron allows one onBeforeRequest listener per
  // session, and this is it for the person's profile.
  function attach(partitionSession, { enabledFor = () => true, onBlocked = () => {} } = {}) {
    partitionSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const wc = details.webContents;
        const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : details.referrer || "";
        if (details.resourceType === "mainFrame" || !enabledFor(pageUrl)) return callback({});
        const verdict = match(details.url, { type: details.resourceType, sourceUrl: pageUrl });
        if (verdict.block && wc) onBlocked(wc.id);
        callback(verdict.block ? { cancel: true } : {});
      } catch {
        // A matcher bug must never break browsing.
        callback({});
      }
    });
  }

  return { load, match, cosmeticCss, attach, stats: () => ({ ...stats, skippedBy: { ...stats.skippedBy } }) };
}

// The lists Kairos fetches (daily, browser-tabs.js / main.js), as data.
const LISTS = [
  { id: "easylist", url: "https://easylist.to/easylist/easylist.txt" },
  { id: "easyprivacy", url: "https://easylist.to/easylist/easyprivacy.txt" },
  { id: "ublock-filters", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt" },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_MAX_BYTES = 15 * 1024 * 1024;

// Keeps the lists in `dir`, one file each, and refreshes them once a day.
// A failed or odd download keeps the copy already there; with nothing saved
// yet and no network, blocking simply starts empty. `fetchText(url)`
// resolves to the body (main.js passes the profile session's fetch).
function createListUpdater({ adblock, dir, fetchText, lists = LISTS, now = () => Date.now(), log = console }) {
  const fs = require("fs");
  const path = require("path");
  const fileOf = (list) => path.join(dir, `${list.id}.txt`);

  function loadSaved() {
    const texts = lists.map((l) => { try { return fs.readFileSync(fileOf(l), "utf8"); } catch { return ""; } }).filter(Boolean);
    return adblock.load(texts);
  }

  function stale(list) {
    try { return now() - fs.statSync(fileOf(list)).mtimeMs > DAY_MS; } catch { return true; }
  }

  async function refresh({ force = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    let changed = 0;
    for (const list of lists) {
      if (!force && !stale(list)) continue;
      try {
        const text = await fetchText(list.url);
        // A real list starts with a header or a comment, and is not huge.
        if (typeof text !== "string" || text.length > LIST_MAX_BYTES || !/^\s*(\[Adblock|!)/i.test(text)) throw new Error("not a filter list");
        const temp = `${fileOf(list)}.tmp`;
        fs.writeFileSync(temp, text);
        fs.renameSync(temp, fileOf(list));
        changed += 1;
      } catch (err) {
        log.error(`[browser] filter list ${list.id} not refreshed: ${err && err.message}`);
      }
    }
    return changed ? loadSaved() : adblock.stats();
  }

  return { loadSaved, refresh };
}

module.exports = { createAdblock, createListUpdater, LISTS, _siteOf: siteOf, _tokenOf: tokenOf, _patternRegex: patternRegex };
