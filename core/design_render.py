"""One board as a page, and the security boundary around it (spec 3c, 5).

A board is a fragment. At render time it is wrapped in a fixed document: the
design system's fonts (from Kairos's own font route, never a CDN), its
`--ds-*` tokens, a reset, the board's size, and Kairos's viewer script, the
only script that may run. The response's Content-Security-Policy header pins
that script by hash and allows no network, forms or navigation; the canvas
frames it with sandbox="allow-scripts" and no allow-same-origin, so the board
runs in an opaque origin that cannot reach the app's cookies, storage or API.

The viewer script handles the declarative click-throughs (data-kd-goto,
data-kd-toggle), hover outlines, picking, in-place text edits and live token
previews. It talks to the canvas only through postMessage, and accepts
messages only from its parent window; the canvas likewise accepts messages
only from the frame it created, and treats them as data.

Render tokens: the Electron render window has no cookies, so it loads a board
through a short-lived signed URL (`rt`), valid for one board for ten minutes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import re
import secrets
import time
from typing import Optional

from core import design_formats, design_html, design_store, design_systems

_SECRET = secrets.token_bytes(32)
TOKEN_SECONDS = 600

VIEWER_SCRIPT = r"""(function () {
  'use strict';
  var mode = 'browse', marks = {}, hover = null, editing = null, ownScroll = false;
  var parentWin = window.parent;
  function send(message) { try { parentWin.postMessage(message, '*'); } catch (e) {} }
  function target(node) { return node && node.closest ? node.closest('[data-kd]') : null; }
  function paint() {
    var all = document.querySelectorAll('[data-kd-mark]');
    for (var i = 0; i < all.length; i++) all[i].removeAttribute('data-kd-mark');
    Object.keys(marks).forEach(function (kind) {
      (marks[kind] || []).forEach(function (id) {
        var node = document.querySelector('[data-kd="' + String(id).replace(/[^a-z0-9-]/g, '') + '"]');
        if (node) node.setAttribute('data-kd-mark', (node.getAttribute('data-kd-mark') ? node.getAttribute('data-kd-mark') + ' ' : '') + kind);
      });
    });
  }
  // A point as fractions of the board the canvas draws: on the canvas the
  // frame is exactly the board, so the viewport is the board's own size.
  function point(event) {
    var w = window.innerWidth || 1;
    var h = ownScroll ? (document.documentElement.scrollHeight || 1) : (window.innerHeight || 1);
    return { x: Math.max(0, Math.min(1, (event.pageX) / w)), y: Math.max(0, Math.min(1, (event.pageY) / h)) };
  }
  // How tall the content is (not the frame): a website or email board grows to it.
  var lastHeight = 0;
  function contentHeight() {
    var body = document.body, bottom = 0;
    if (!body) return 0;
    for (var i = 0; i < body.children.length; i++) {
      var child = body.children[i];
      if (child.tagName === 'SCRIPT') continue;
      var r = child.getBoundingClientRect(), mb = parseFloat(getComputedStyle(child).marginBottom) || 0;
      if (r.height && r.bottom + mb > bottom) bottom = r.bottom + mb;
    }
    return Math.ceil(bottom + (window.scrollY || 0));
  }
  function reportSize() {
    var height = contentHeight();
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    send({ type: 'kd-size', height: height, width: document.documentElement.scrollWidth });
  }
  function describe(node) {
    var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    return { id: node.getAttribute('data-kd'), tag: node.tagName.toLowerCase(), text: text.slice(0, 60) };
  }
  function leafText(node) {
    for (var i = 0; i < node.children.length; i++) {
      var tag = node.children[i].tagName.toLowerCase();
      if (['b', 'i', 'em', 'strong', 'br', 'span', 'small'].indexOf(tag) < 0) return false;
    }
    return (node.textContent || '').trim().length > 0;
  }
  function finishEdit(save) {
    if (!editing) return;
    var node = editing.node; editing = null;
    node.removeAttribute('contenteditable');
    var text = node.innerText.replace(/\n+$/, '');
    if (save && text !== node.getAttribute('data-kd-before')) send({ type: 'kd-text', id: node.getAttribute('data-kd'), text: text });
    else if (!save) node.innerText = node.getAttribute('data-kd-before');
    node.removeAttribute('data-kd-before');
  }
  document.addEventListener('mouseover', function (event) {
    if (mode === 'browse') return;
    var node = target(event.target);
    if (hover && hover !== node) hover.removeAttribute('data-kd-hover');
    hover = node; if (node) node.setAttribute('data-kd-hover', '');
  }, true);
  document.addEventListener('mouseout', function () { if (hover) { hover.removeAttribute('data-kd-hover'); hover = null; } }, true);
  document.addEventListener('click', function (event) {
    if (editing && editing.node.contains(event.target)) return;
    var node = target(event.target);
    if (mode === 'select' || mode === 'comment') {
      event.preventDefault(); event.stopPropagation();
      send({ type: 'kd-pick', mode: mode, element: node ? describe(node) : null, point: point(event),
             additive: !!(event.shiftKey || event.ctrlKey || event.metaKey) });
      return;
    }
    if (mode === 'text') { event.preventDefault(); return; }
    var toggle = event.target.closest && event.target.closest('[data-kd-toggle]');
    if (toggle) {
      event.preventDefault();
      var id = String(toggle.getAttribute('data-kd-toggle')).replace(/[^a-z0-9-]/g, '');
      var hidden = document.querySelector('[data-kd="' + id + '"]');
      if (hidden) { if (hidden.hasAttribute('hidden')) hidden.removeAttribute('hidden'); else hidden.setAttribute('hidden', ''); }
      return;
    }
    var link = event.target.closest && event.target.closest('[data-kd-goto]');
    if (link) {
      event.preventDefault();
      send({ type: 'kd-goto', board: String(link.getAttribute('data-kd-goto')).slice(0, 60),
             overlay: link.getAttribute('data-kd-goto-mode') === 'overlay' });
      return;
    }
    if (event.target.closest && event.target.closest('a')) event.preventDefault();
  }, true);
  document.addEventListener('dblclick', function (event) {
    if (mode !== 'text') return;
    var node = target(event.target);
    if (!node || !leafText(node)) return;
    event.preventDefault(); finishEdit(true);
    editing = { node: node };
    node.setAttribute('data-kd-before', node.innerText);
    node.setAttribute('contenteditable', 'plaintext-only');
    node.focus();
  }, true);
  document.addEventListener('keydown', function (event) {
    if (editing && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEdit(true); return; }
    if (editing && event.key === 'Escape') { event.preventDefault(); finishEdit(false); return; }
    if (!editing) send({ type: 'kd-key', key: event.key, ctrl: !!(event.ctrlKey || event.metaKey), shift: !!event.shiftKey });
  }, true);
  document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
  // On the canvas the board does not scroll: the wheel pans and zooms the canvas.
  document.addEventListener('wheel', function (event) {
    if (ownScroll && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    send({ type: 'kd-wheel', dx: event.deltaX, dy: event.deltaY, unit: event.deltaMode, ctrl: !!(event.ctrlKey || event.metaKey),
           x: event.clientX, y: event.clientY });
  }, { passive: false });
  window.addEventListener('message', function (event) {
    if (event.source !== parentWin) return;
    var data = event.data || {};
    if (data.type === 'kd-mode') {
      finishEdit(true);
      mode = ['browse', 'select', 'comment', 'text'].indexOf(data.mode) >= 0 ? data.mode : 'browse';
      ownScroll = !!data.scroll;
      document.documentElement.setAttribute('data-kd-mode', mode);
    } else if (data.type === 'kd-marks') {
      marks = {}; ['picked', 'changed', 'commented'].forEach(function (kind) {
        if (Array.isArray(data[kind])) marks[kind] = data[kind].slice(0, 200);
      }); paint();
    } else if (data.type === 'kd-tokens') {
      var lines = String(data.css || '').split('\n').filter(function (line) {
        return /^\s*--ds-[a-z0-9-]+\s*:\s*[^;{}<>\\]+;\s*$/.test(line) && !/url\(|expression/i.test(line);
      });
      document.getElementById('kd-live-tokens').textContent = ':root{' + lines.join('') + '}';
    } else if (data.type === 'kd-show') {
      var shown = document.querySelector('[data-kd="' + String(data.id || '').replace(/[^a-z0-9-]/g, '') + '"]');
      if (shown && shown.scrollIntoView) shown.scrollIntoView({ block: 'center' });
    }
  });
  send({ type: 'kd-ready', height: document.documentElement.scrollHeight });
  reportSize();
  if (window.ResizeObserver) { var sizes = new ResizeObserver(reportSize); sizes.observe(document.documentElement); if (document.body) sizes.observe(document.body); }
  window.addEventListener('load', reportSize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportSize);
})();"""
VIEWER_HASH = "sha256-" + base64.b64encode(hashlib.sha256(VIEWER_SCRIPT.encode("utf-8")).digest()).decode()

RESET = """*, *::before, *::after { box-sizing: border-box; }
html { width: %(w)spx; min-height: %(min)spx; overflow-x: hidden; background: var(--ds-bg); -webkit-text-size-adjust: 100%%; }
body { margin: 0; min-height: %(min)spx; background: var(--ds-bg); color: var(--ds-text); font-family: var(--ds-font-sans);
       font-size: var(--ds-size-3); line-height: 1.45; -webkit-font-smoothing: antialiased; }
img, svg, video { max-width: 100%%; }
button, input, select, textarea { font: inherit; color: inherit; }
[hidden] { display: none !important; }
[data-kd-goto], [data-kd-toggle] { cursor: pointer; }
html[data-kd-mode="select"] [data-kd], html[data-kd-mode="comment"] [data-kd] { cursor: crosshair; }
html[data-kd-mode="text"] [data-kd] { cursor: text; }
[data-kd-hover] { outline: 1px dashed var(--kd-ui, var(--ds-accent)); outline-offset: -1px; }
[data-kd-mark~="commented"] { outline: 2px dashed var(--kd-ui, var(--ds-accent)); outline-offset: -2px; }
[data-kd-mark~="picked"] { outline: 2px solid var(--kd-ui, var(--ds-accent)); outline-offset: -2px; }
[data-kd-mark~="changed"] { outline: 2px solid var(--ds-success); outline-offset: -2px; transition: outline-color .6s; }
[contenteditable] { outline: 2px solid var(--kd-ui, var(--ds-accent)) !important; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
"""
# A fixed or growing board prints as one page its own size.
BOARD_PRINT = """@page { size: %(w)spx %(h)spx; margin: 0; }
@media print { html, body { height: %(h)spx; overflow: hidden; } }
"""
# A document board prints as real pages (Creative Output Quality spec, Phase 2; the rules Phase 0 proved in
# Electron): the content flows across them, a running header from the second page, page numbers on every
# page, table headers repeated, headings kept with what follows. On screen the board is padded by the page
# margin so lines wrap where they will in print. A board's own <style> can override any of it, e.g.
# `@page { @top-left { content: none } }`. Margin boxes don't see custom properties, so their font and colour
# are the look's values, resolved here.
PAGED_PRINT = """@media screen { body { padding: %(m)spx; } }
@page { size: %(page)s; margin: %(m)spx; background: %(bg)s;
  @top-left { content: "%(header)s"; font: 8.5pt %(font)s; color: %(dim)s; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8.5pt %(font)s; color: %(dim)s; } }
@page :first { @top-left { content: none; } }
@media print {
  html { width: auto; min-height: 0; }
  body { min-height: 0; }
  thead { display: table-header-group; }
  tr, figure, img, svg, blockquote, [data-kd-keep] { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }
  [data-kd-page-break] { break-before: page; }
}
"""


def csp(origin: str, design_id: str) -> str:
    """The board's header policy. Path sources need an absolute origin."""
    base = origin.rstrip("/")
    return ("default-src 'none'; "
            "style-src 'unsafe-inline'; "
            f"font-src {base}/api/design-fonts/; "
            f"img-src data: {base}/api/designs/{design_id}/; "
            f"script-src '{VIEWER_HASH}'; "
            "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; "
            "object-src 'none'; frame-ancestors 'self'")


def render_document(design_id: str, slug: str, *, version: Optional[int] = None, viewer: bool = True,
                    font_base: str = "/api/design-fonts", data: Optional[dict] = None,
                    board: Optional[str] = None, width: Optional[int] = None) -> str:
    """The full page for one board (current, or as it was at `version`)."""
    data = data or design_store.manifest(design_id)
    if version:
        snap = design_store.snapshot_at(design_id, version)
        meta = snap["manifest"]["boards"].get(slug)
        if meta is None:
            raise LookupError(f"Board `{slug}` did not exist at version {version}.")
        source = snap["boards"][slug]
        system_id = snap["manifest"].get("design_system") or design_systems.BUILTIN_ID
        overrides = snap["manifest"].get("token_overrides") or {}
    else:
        meta = data["boards"].get(slug)
        if meta is None:
            raise LookupError(f"No board `{slug}`.")
        source = board if board is not None else design_store.board_html(design_id, slug)
        system_id = data.get("design_system") or design_systems.BUILTIN_ID
        overrides = data.get("token_overrides") or {}
    if width:  # Focus mode's Desktop / Tablet / Phone switch, for browser and custom frames.
        meta = {**meta, "w": max(320, min(4000, int(width)))}
    system = design_systems.get(system_id) or design_systems.builtin()
    head = "\n".join([design_systems.font_faces(system["id"], font_base),
                      design_systems.tokens_css(system["tokens"], overrides),
                      RESET % {"w": int(meta["w"]), "h": int(meta["h"]), "min": _min_height(meta)},
                      print_rules(meta, design_systems.variables(system["tokens"], overrides),
                                  (snap["manifest"] if version else data).get("title"))])
    script = f"<script>{VIEWER_SCRIPT}</script>" if viewer else ""
    title = html.escape(meta.get("title") or slug)
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{title}</title>'
            f'<meta name="viewport" content="width={int(meta["w"])}">'
            f"<style>{head}</style><style id=\"kd-live-tokens\"></style></head>"
            f'<body data-kd-board="{html.escape(slug)}" data-kd-frame="{html.escape(meta.get("frame") or "none")}">'
            f"{source}{script}</body></html>")


def sample_csp(origin: str) -> str:
    """A look preview's policy: like a board's, with no script at all."""
    base = origin.rstrip("/")
    return ("default-src 'none'; style-src 'unsafe-inline'; "
            f"font-src {base}/api/design-fonts/; img-src data:; script-src 'none'; connect-src 'none'; "
            "form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'self'")


def render_sample(system_id: str, *, font_base: str = "/api/design-fonts", rt: Optional[str] = None) -> Optional[str]:
    """Tool Store's 1200x800 preview of a bundled look or the Kairos system, or of a person's style or
    draft when `rt` is a token signed for it (they are private, and the frame sends no session).
    None for anything else, saved token-only systems included."""
    from core import design_looks, design_references
    look = design_looks.get(system_id)
    system = None
    if look is None and system_id != design_systems.BUILTIN_ID:
        if not verify(system_id, "style-preview", rt):
            return None
        if design_references.DRAFT_RE.fullmatch(system_id):
            try:
                look = design_references.load_draft(system_id)["look"]
            except LookupError:
                return None
            system = {"id": system_id, "tokens": design_looks.tokens(look), "fonts": design_looks.fonts(look)}
        else:
            look = design_systems._style_look(system_id)
            if look is None:
                return None
    system = system or design_systems.get(system_id)
    if look is None:  # Kairos, drawn with the same preview as the looks.
        look = {"name": "Kairos", "mood": ["warm", "calm", "precise"], "imagery": "",
                "guide": "Parchment grounds, bistre ink and a gold point. Warm, calm and precise.",
                "shape": {"radius": "12px", "button": "pill", "border": "1px", "label_case": "none",
                          "label_tracking": "0.02em", "display_weight": "500", "display_style": "italic"}}
    head = "\n".join([design_systems.font_faces(system["id"], font_base, system.get("fonts") if system.get("id", "").startswith("draft-") else None),
                      design_systems.tokens_css(system["tokens"]), RESET % {"w": 1200, "h": 800, "min": 800}])
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(look["name"])}</title>'
            f'<meta name="viewport" content="width=1200"><style>{head}</style></head>'
            f"<body>{design_looks.sample(look)}</body></html>")


def print_rules(meta: dict, tokens: dict[str, str], title: Optional[str] = None) -> str:
    """How the board prints: one page its own size, or a document's flowing pages."""
    if not design_formats.paged(meta):
        return BOARD_PRINT % {"w": int(meta["w"]), "h": int(meta["h"])}
    name = design_formats.page(meta)[0]
    header = re.sub(r'["\\<>{};\x00-\x1f]', " ", title or meta.get("title") or "")[:90].strip()
    font = re.sub(r"[;{}<>\\]", "", tokens.get("--ds-font-sans") or "sans-serif")[:200]
    return PAGED_PRINT % {"page": name, "m": design_formats.PAGE_MARGIN, "header": header, "font": font,
                          "dim": _colour(tokens, "--ds-text-dim", "#666"), "bg": _colour(tokens, "--ds-bg", "#fff")}


def _colour(tokens: dict[str, str], key: str, fallback: str) -> str:
    """A token's colour for the @page rules, or the fallback if it isn't a plain colour."""
    value = tokens.get(key) or ""
    return value if re.fullmatch(r"#[0-9a-fA-F]{3,8}|[a-z]{3,20}|rgba?\([0-9., %]+\)", value) else fallback


def _min_height(meta: dict) -> int:
    """A growing board (website, email) is as tall as its content, at least its
    minimum: the page must not stretch to the frame, or it could never shrink."""
    if design_formats.grows(meta):
        return int(meta.get("min_h") or meta["h"])
    return int(meta["h"])


def sign(design_id: str, slug: str, seconds: int = TOKEN_SECONDS) -> str:
    expires = int(time.time()) + seconds
    mac = hmac.new(_SECRET, f"{design_id}:{slug}:{expires}".encode(), hashlib.sha256).digest()[:18]
    return f"{expires}.{base64.urlsafe_b64encode(mac).decode().rstrip('=')}"


def verify(design_id: str, slug: str, token: Optional[str]) -> bool:
    if not token or not re.fullmatch(r"[0-9]{10}\.[A-Za-z0-9_-]{24}", token):
        return False
    expires, _, mac = token.partition(".")
    if int(expires) < time.time():
        return False
    expected = base64.urlsafe_b64encode(hmac.new(_SECRET, f"{design_id}:{slug}:{expires}".encode(),
                                                 hashlib.sha256).digest()[:18]).decode().rstrip("=")
    return hmac.compare_digest(mac, expected)

