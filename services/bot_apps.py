"""Bots apps: small HTML pages a bot makes and the person uses in the conversation (Phase 6 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-6-design.md, sections 3.3, 4 and 5.3.

`show_html` and `update_html` put a page in a message row (`app` key: the latest revision and up to
ten kept versions). The page never runs in Kairos's own origin: the browser draws it in an iframe
with `sandbox="allow-scripts allow-forms"` and the Content-Security-Policy below, so it has no
cookies, no storage and no way to reach Kairos's API. The only ways out are the host bridge's few
messages: send a line of text to the chat (rate limited, labelled with the page's name), pass the
model a note about its state (fenced as untrusted, delivered once), and open an http(s) link
after a real click.

This module holds what the server decides: limits, the policy text, storage, rate limits, the two
rpc methods, and the Content-Security-Policy that MCP apps ask for.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from collections import deque
from typing import Any, Awaitable, Callable, Optional

from core.logs import scrub_credentials
from services import bot_widgets
from services.bot_widgets import WidgetError

MAX_HTML_BYTES = 256 * 1024
MAX_TITLE = 80
VERSIONS_KEPT = 10
RPC_PER_MINUTE = 60
MESSAGES_PER_HOUR = 20
MAX_ARGS_BYTES = 64 * 1024
MAX_MESSAGE_CHARS = 4000
MAX_CONTEXT_CHARS = 2000
MAX_MCP_DOMAINS = 16
SCRIPT_HOSTS = ("https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com")
STYLE_HOSTS = SCRIPT_HOSTS + ("https://fonts.googleapis.com",)
FONT_HOSTS = SCRIPT_HOSTS + ("https://fonts.gstatic.com",)
SANDBOX = "allow-scripts allow-forms"
DOMAIN_RE = re.compile(r"^https://[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?::\d{1,5})?$")


def csp(connect: tuple = (), resources: tuple = ()) -> str:
    """The policy every page carries. A bot's own page loads scripts, styles and fonts from three public CDNs
    (and Google Fonts) and nothing else; it cannot connect anywhere or open frames. An MCP app may add the
    domains its server declared (validated by `mcp_csp`)."""
    scripts = " ".join(SCRIPT_HOSTS + tuple(resources))
    styles = " ".join(STYLE_HOSTS + tuple(resources))
    fonts = " ".join(FONT_HOSTS + tuple(resources))
    images = " ".join(("data:", "blob:") + SCRIPT_HOSTS + tuple(resources))
    connect_src = " ".join(connect) if connect else "'none'"
    return (f"default-src 'none'; script-src 'unsafe-inline' {scripts}; style-src 'unsafe-inline' {styles}; "
            f"font-src {fonts}; img-src {images}; media-src data: blob:; connect-src {connect_src}; "
            "frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")


def mcp_csp(meta: Any) -> dict:
    """The CSP an MCP app's `_meta.ui.csp` asks for, checked: https domains only, at most 16 in all, frames
    never. Returns {"connect": [...], "resources": [...], "policy": str}. Raises WidgetError for a bad list."""
    ui = (meta or {}).get("ui") if isinstance(meta, dict) else None
    asked = (ui or {}).get("csp") if isinstance(ui, dict) else None
    if asked is None:
        return {"connect": [], "resources": [], "policy": csp()}
    if not isinstance(asked, dict):
        raise WidgetError("An app's policy request must be an object.")
    out: dict[str, list] = {}
    total = 0
    for key, name in (("connectDomains", "connect"), ("resourceDomains", "resources")):
        items = asked.get(key, [])
        if not isinstance(items, list):
            raise WidgetError(f"{key} must be a list.")
        clean = []
        for item in items:
            if not isinstance(item, str) or not DOMAIN_RE.match(item):
                raise WidgetError("An app may only ask for https domains.")
            if item not in clean:
                clean.append(item)
        total += len(clean)
        out[name] = clean
    if total > MAX_MCP_DOMAINS:
        raise WidgetError(f"An app may ask for at most {MAX_MCP_DOMAINS} domains.")
    return {**out, "policy": csp(tuple(out["connect"]), tuple(out["resources"]))}


# -- validation and storage ---------------------------------------------------------------

def _title(value: Any) -> str:
    text = " ".join(str(value or "").split())[:MAX_TITLE]
    return text or "App"


def validate_html(html: Any) -> str:
    if not isinstance(html, str) or not html.strip():
        raise WidgetError("An app needs some HTML.")
    if "\x00" in html:
        raise WidgetError("That HTML holds a null character.")
    size = len(html.encode("utf-8", "replace"))
    if size > MAX_HTML_BYTES:
        raise WidgetError(f"An app is limited to {MAX_HTML_BYTES // 1024} KB of HTML (this one is {size // 1024} KB).")
    return html


_LOCK = threading.RLock()


def show(session_id: str, bot_id: str, title: Any, html: Any, mcp_meta: Any = None, server: str = "") -> dict:
    """Put an app in the conversation. `mcp_meta` (an MCP app's `_meta`) makes it an MCP app: its page keeps the
    policy its server asked for (checked by `mcp_csp`: https domains, at most 16, never frames)."""
    html, title = validate_html(html), _title(title)
    now = time.time()
    app = {"rev": 1, "title": title, "html": html, "at": now, "versions": [{"rev": 1, "title": title, "html": html, "at": now}]}
    if mcp_meta is not None:
        app["source"] = "mcp"
        app["server"] = str(server)[:80]
        app["csp"] = mcp_csp(mcp_meta)["policy"]
    message_id = bot_widgets.append_rich_row(session_id, bot_id, "app", title, {"app": app})
    return {"message_id": message_id, "rev": 1}


def update(session_id: str, message_id: str, html: Any, title: Any = None) -> dict:
    html = validate_html(html)
    with _LOCK:
        found = bot_widgets.find_row(session_id, message_id)
        if not found or not isinstance(found[1].get("app"), dict):
            raise WidgetError("There is no app with that id in this conversation.", 404)
        index, row = found
        app = row["app"]
        rev = int(app.get("rev") or 1) + 1
        name = _title(title) if title else app.get("title", "App")
        now = time.time()
        versions = (list(app.get("versions") or []) + [{"rev": rev, "title": name, "html": html, "at": now}])[-VERSIONS_KEPT:]
        bot_widgets.set_fields(session_id, index, {"app": {**app, "rev": rev, "title": name, "html": html, "at": now, "versions": versions}})
    try:
        from services import chat_live
        chat_live.broadcast_owner({"type": "bot_rich", "sessionId": session_id, "messageId": message_id, "kind": "app"})
    except Exception:
        pass
    return {"message_id": message_id, "rev": rev}


def get(session_id: str, message_id: str, rev: Optional[int] = None) -> dict:
    """The page for the frame: {rev, latest, title, html, csp, sandbox, versions:[{rev, at}]}."""
    found = bot_widgets.find_row(session_id, message_id)
    if not found or not isinstance(found[1].get("app"), dict):
        raise WidgetError("There is no app with that id.", 404)
    app = found[1]["app"]
    versions = app.get("versions") or []
    latest = int(app.get("rev") or 1)
    want = latest if rev is None else rev
    version = next((v for v in versions if v.get("rev") == want), None)
    if version is None:
        raise WidgetError("That version of the app is no longer kept.", 404)
    return {"rev": want, "latest": latest, "title": version.get("title", app.get("title", "App")), "html": version["html"],
            "csp": app.get("csp") or csp(), "sandbox": SANDBOX, "at": version.get("at"), "source": app.get("source", "bot"),
            "versions": [{"rev": v["rev"], "at": v.get("at")} for v in versions]}


# -- rate limits ------------------------------------------------------------------------------

class Limiter:
    """A sliding window per key. `clock` is replaced in tests."""

    def __init__(self, limit: int, window: float, clock: Callable[[], float] = time.time):
        self.limit, self.window, self.clock = limit, window, clock
        self._hits: dict[Any, deque] = {}
        self._lock = threading.Lock()

    def allow(self, key: Any) -> bool:
        now = self.clock()
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


rpc_limiter = Limiter(RPC_PER_MINUTE, 60.0, lambda: time.time())
message_limiter = Limiter(MESSAGES_PER_HOUR, 3600.0, lambda: time.time())

# What the page told the model about itself, per conversation: shown to the model once.
_CONTEXT: dict[str, dict] = {}


def set_context(session_id: str, message_id: str, text: Any) -> None:
    if not isinstance(text, str):
        raise WidgetError("The note must be text.")
    text = scrub_credentials(text.replace("\x00", ""))[:MAX_CONTEXT_CHARS]
    with _LOCK:
        if text.strip():
            _CONTEXT[session_id] = {"message_id": message_id, "text": text, "at": time.time()}
        else:
            _CONTEXT.pop(session_id, None)


def pending_context_note(session_id: str) -> str:
    """The note a page left for the model, fenced as outside text, once. Empty when there is none."""
    with _LOCK:
        item = _CONTEXT.pop(session_id, None)
    if not item:
        return ""
    from core.untrusted import wrap_untrusted
    return "\n\n[An app in this conversation reported its state:]\n" + wrap_untrusted("an app the person is using", item["text"])


MAX_POINTED = 5
CHANNEL = re.compile(r"^[A-Za-z0-9_-]{4,40}$")
_SHIM_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "botsAppBridge.js")


def shim(channel: str) -> str:
    """The script that gives a page window.kairos. The text lives once, in static/js/botsAppBridge.js
    (between its SHIM markers); the browser's tests and this server read the same copy."""
    if not CHANNEL.match(channel or ""):
        raise WidgetError("That channel is not valid.")
    with open(_SHIM_FILE, encoding="utf-8") as handle:
        source = handle.read()
    start = source.index("/*SHIM-START*/") + len("/*SHIM-START*/")
    text = source[start:source.index("/*SHIM-END*/")]
    return text.replace("__CHANNEL__", json.dumps(channel)).replace("</script", "<\\/script")


def frame_document(html: str, policy: str, channel: str) -> str:
    """The page the frame loads: the bot's HTML with the policy and the bridge script placed first in its head.
    The server sends the same policy as a header, which is what binds the page (the platform's own policy
    forbids inline scripts, and a srcdoc frame would inherit it)."""
    escaped = policy.replace("&", "&amp;").replace('"', "&quot;")
    head = ('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escaped + '">'
            '<meta name="viewport" content="width=device-width, initial-scale=1"><script>' + shim(channel) + "</script>")
    head_tag = re.search(r"<head(?=[\s>])[^>]*>", html, re.IGNORECASE)
    if head_tag:
        return html[:head_tag.end()] + head + html[head_tag.end():]
    html_tag = re.search(r"<html(?=[\s>])[^>]*>", html, re.IGNORECASE)
    if html_tag:
        return html[:html_tag.end()] + "<head>" + head + "</head>" + html[html_tag.end():]
    return "<!doctype html><html><head>" + head + "</head><body>" + html + "</body></html>"


def pointed_note(pointed: Any) -> str:
    """The text added to a message when the person pointed at parts of an app (Point mode). The labels come from
    the app's own page, so they are outside text: at most 5, tag and 40-character label, fenced as untrusted."""
    if not isinstance(pointed, list):
        return ""
    lines = []
    for item in pointed[:MAX_POINTED]:
        if not isinstance(item, dict):
            continue
        tag = re.sub(r"[^a-z0-9-]", "", str(item.get("tag", "")).lower())[:20] or "element"
        label = " ".join(str(item.get("label", "")).split())[:40]
        lines.append(f'<{tag}> "{label}"')
    if not lines:
        return ""
    from core.untrusted import wrap_untrusted
    return "\n\n[The person pointed at these parts of an app:]\n" + wrap_untrusted("labels taken from an app's page", "\n".join(lines))


Sender = Callable[[str, str, dict], Awaitable[dict]]
# Set by the MCP wiring (Phase 2): async (owner, bot, tool, arguments, read_only) -> text. None = not available.
mcp_hook: Optional[Callable[..., Awaitable[Any]]] = None


async def rpc(owner: str, session_id: str, message_id: str, body: dict, sender: Optional[Sender] = None) -> dict:
    """One call from the page through the host bridge (JSON-RPC style: {method, params})."""
    from services import bot_chat_service
    session, bot = bot_chat_service.require(owner, session_id)
    method, params = body.get("method"), body.get("params") or {}
    try:
        size = len(json.dumps(params, ensure_ascii=False).encode("utf-8"))
    except (TypeError, ValueError):
        raise WidgetError("Those arguments must be plain JSON.")
    if size > MAX_ARGS_BYTES:
        raise WidgetError("Those arguments are too large.", 413)
    found = bot_widgets.find_row(session_id, str(message_id))
    if not found or not isinstance(found[1].get("app"), dict):
        raise WidgetError("That app is gone.", 404)
    if not rpc_limiter.allow((session_id, message_id)):
        raise WidgetError("That app is calling too fast. Try again in a moment.", 429)
    title = found[1]["app"].get("title", "App")
    if method == "ui/message":
        text = params.get("text") if isinstance(params, dict) else None
        if not isinstance(text, str) or not text.strip():
            raise WidgetError("There is nothing to send.")
        if not message_limiter.allow((session_id, message_id)):
            raise WidgetError("That app has sent its limit of messages for this hour.", 429)
        line = scrub_credentials(text.replace("\x00", "").strip())[:MAX_MESSAGE_CHARS]
        send = sender or bot_chat_service.send
        import uuid
        result = await send(owner, session_id, {"text": f'From the app "{title}": {line}', "send_id": uuid.uuid4().hex, "mode": None})
        return result if isinstance(result, dict) else {"ok": True}
    if method == "ui/update-model-context":
        set_context(session_id, message_id, params.get("text") if isinstance(params, dict) else None)
        return {"ok": True}
    if method == "tools/call":
        if mcp_hook is None:
            raise WidgetError("This app cannot call tools yet.", 409)
        tool = params.get("name") if isinstance(params, dict) else None
        if not isinstance(tool, str) or not tool:
            raise WidgetError("Name the tool to call.")
        read_only = bot.get("approval_mode") != "full"
        return {"result": await mcp_hook(owner, bot, tool, params.get("arguments") or {}, read_only)}
    raise WidgetError("That app call is not supported.", 400)


def set_page_context(owner: str, session_id: str, message_id: str, body: dict) -> dict:
    from services import bot_chat_service
    bot_chat_service.require(owner, session_id)
    found = bot_widgets.find_row(session_id, str(message_id))
    if not found or not isinstance(found[1].get("app"), dict):
        raise WidgetError("That app is gone.", 404)
    if not rpc_limiter.allow((session_id, message_id)):
        raise WidgetError("That app is calling too fast. Try again in a moment.", 429)
    text = body.get("text")
    if text is not None and len(str(text).encode("utf-8")) > MAX_ARGS_BYTES:
        raise WidgetError("That note is too large.", 413)
    set_context(session_id, message_id, text if text is not None else "")
    return {"ok": True}


# -- the tools ------------------------------------------------------------------------------

def _ids(ctx) -> tuple[str, str]:
    bot_id, session_id = getattr(ctx, "agent_id", None), getattr(ctx, "session_id", None)
    if not bot_id:
        raise WidgetError("This tool is for bots.")
    if not session_id:
        raise WidgetError("There is no conversation to show this in.")
    return bot_id, session_id


async def _tool_show(args: dict, ctx) -> str:
    try:
        bot_id, sid = _ids(ctx)
        result = show(sid, bot_id, (args or {}).get("title"), (args or {}).get("html"))
    except WidgetError as error:
        return "Not shown: " + str(error)
    return (f"App shown. Message id {result['message_id']}, version {result['rev']}. It runs in a sandbox with no network "
            "access except public script, style and font CDNs. Use update_html with this id to change it.")


async def _tool_update(args: dict, ctx) -> str:
    try:
        _, sid = _ids(ctx)
        result = update(sid, str((args or {}).get("message_id") or ""), (args or {}).get("html"), (args or {}).get("title"))
    except WidgetError as error:
        return "Not updated: " + str(error)
    return f"App updated to version {result['rev']}. The person can step back through the last {VERSIONS_KEPT}."


def _object(properties: dict, required: tuple = ()) -> dict:
    return {"type": "object", "properties": properties, "required": list(required)}


TOOLS = [
    {"name": "show_html", "effect": "write", "handler": _tool_show,
     "description": ("Show the person a small interactive page (one HTML document, up to 256 KB, inline CSS and JavaScript) in the "
                     "conversation: a calculator, a chart, a form, a game. It runs in a sandbox: it cannot reach the network except "
                     "public script, style and font CDNs (cdnjs, jsDelivr, unpkg, Google Fonts), and has no storage. In the page, "
                     "window.kairos.send(text) sends a line to this chat, window.kairos.setContext(text) tells you its state, and "
                     "window.kairos.open(url) offers a link."),
     "schema": _object({"title": {"type": "string"}, "html": {"type": "string"}}, ("title", "html"))},
    {"name": "update_html", "effect": "write", "handler": _tool_update,
     "description": "Replace the page you showed with a new version, by its message id. The last 10 versions are kept.",
     "schema": _object({"message_id": {"type": "string"}, "html": {"type": "string"}, "title": {"type": "string"}}, ("message_id", "html"))},
]
