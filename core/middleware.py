"""Security headers + auth dependencies.

get_current_user()/require_admin() are FastAPI dependencies routes use to gate
access. When AUTH_ENABLED=false (the local-desktop default), every request
resolves to the single local user with admin rights — no login screen, no
friction, matching the "single trusted user on their own machine" case.
"""
import asyncio
import re
import secrets
from typing import Optional

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

from core import auth as auth_module
from core.auth import auth_manager, auth_enabled, SESSION_COOKIE_NAME, SINGLE_USER, UI_COOKIE_NAME
from core.constants import APP_PORT


_NO_CACHE_SUFFIXES = (".js", ".mjs", ".css", ".html")
# The only responses whose own Content-Security-Policy survives (see dispatch): a Design board's render,
# a bundled look's preview (script-free) and a bot's sandboxed app page.
_OWN_POLICY_PATHS = (re.compile(r"/api/designs/[^/]+/boards/[^/]+/render"),
                     re.compile(r"/api/design-looks/[a-z0-9-]+/preview"),
                     re.compile(r"/api/bot-widgets/[^/]+/apps/[^/]+/frame"))

# The port this process's local listener actually serves on, from the first
# request that arrives over plain http on 127.0.0.1 (the desktop window and a
# dev browser always do). Codex's write tools call back to it (see
# local_api_base). It used to come from APP_PORT alone, a default of 8420 that
# no launcher sets, so on any other port - the dev backend runs on 8421 - the
# calls reached whatever was on 8420 and failed with 401 (reproduced
# 2026-09-22). The remote listener, TLS on a tailnet address, is ignored: the
# callback always goes to the local one.
_loopback_port: Optional[int] = None


def _app_page_script_hashes() -> str:
    """The one inline script the app page may run: the import map that lets Studio's editor load the vendored three.js
    by its bare name (static/motion/stage3d.js and the vendored example files import 'three'). An external import map
    is not allowed by browsers, so the page carries it inline and only that page's policy allows exactly its hash.
    Checked once at startup: if static/index.html does not carry the exact map core/three_vendor.py defines, no hash
    is added and the page's 3D preview falls back to stand-in cards (scripts/test_app_csp.py keeps them equal)."""
    from core import three_vendor
    from core.constants import STATIC_DIR
    try:
        page = open(f"{STATIC_DIR}/index.html", encoding="utf-8").read()
    except OSError:
        return ""
    return " " + three_vendor.csp_hash() if three_vendor.IMPORT_MAP_TAG in page else ""


APP_PAGE_SCRIPT_HASHES = _app_page_script_hashes()


def content_security_policy(path: str) -> str:
    """The app's own policy. The app page ("/") adds the hash of its import map; every other response has none."""
    hashes = APP_PAGE_SCRIPT_HASHES if path == "/" else ""
    return ("default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'" + hashes + "; "
            "frame-src 'self' https: http://127.0.0.1:* http://localhost:*; img-src 'self' data: blob:; "
            # Your own animation for the Animated background plays from a local object URL.
            "media-src 'self' blob:; "
            # Desktop notifications show the bot's face, a data: SVG; Chromium
            # loads notification icons under connect-src. data: reaches no host.
            "connect-src 'self' data:")


def remember_loopback_port(scope: dict) -> None:
    global _loopback_port
    server = scope.get("server")
    if scope.get("type") == "http" and scope.get("scheme") == "http" and server and server[0] in ("127.0.0.1", "::1"):
        _loopback_port = server[1]


def local_api_base() -> str:
    """Where a helper process started by this backend reaches its API. APP_PORT
    stays the fallback for a backend no local request has reached yet (the
    packaged app serves on 8420, which is that default)."""
    return f"http://127.0.0.1:{_loopback_port or APP_PORT}/api"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        remember_loopback_port(request.scope)
        response = await call_next(request)
        # A Design board's own policy (routes/design_routes.py): its viewer
        # script's hash, no network, framed only by the app itself. The same
        # for a bot's sandboxed app page (routes/bot_widget_routes.py, Bots
        # Phase 6). Only these paths may keep their own policy: the header
        # alone is never enough (security review 2026-10-29).
        design_board = (response.headers.get("X-Kairos-Design-Render") == "1"
                        and any(p.fullmatch(request.url.path) for p in _OWN_POLICY_PATHS))
        board_policy = response.headers.get("Content-Security-Policy") if design_board else None
        if "X-Kairos-Design-Render" in response.headers:
            del response.headers["X-Kairos-Design-Render"]
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        # No inline <script> in index.html runs except the three.js import map,
        # allowed by its hash on "/" only — script-src 'self' covers same-origin
        # external modules and dynamic import(), so 'unsafe-inline' is dropped.
        # style-src keeps it since style.css still uses some inline style
        # attributes from JS-built elements (views/*.js).
        # frame-src (David's ask 2026-09-15, the side browser): the web
        # client has no native browser view, so it falls back to an iframe —
        # and without an explicit frame-src, `default-src 'self'` blocks
        # every remote page outright, making that fallback dead on arrival.
        # Found by scripts/chat-smoke.cjs, which reproduces this exact header.
        #
        # Deliberately the narrowest widening that makes it work: it permits
        # EMBEDDING https pages and loopback HTTP app previews. No script, style, connect,
        # or font source changes, so a framed page still cannot run anything
        # in this origin — it is a separate browsing context, the frame is
        # sandboxed without allow-top-navigation (static/js/browserPane.js),
        # and X-Frame-Options/frame-ancestors below still stop JARVIS itself
        # from being framed by anyone else. Plain HTTP is limited to the two
        # App Preview hosts; the renderer chooses its session's allowed port.
        # The app page ("/") also allows its one inline import map by hash (see content_security_policy).
        response.headers["Content-Security-Policy"] = content_security_policy(request.url.path)
        # Odysseus applies this same no-cache rule to .js/.css/.html source
        # files specifically (see specs/frontend.md) — without it, Electron's
        # persistent Chromium profile (unlike the old ad hoc kiosk browser
        # launches, which used a fresh temp profile every time) can keep
        # serving a stale cached script indefinitely after a code change,
        # even across a full app relaunch. Found live 2026-08-31 — a real fix
        # looked like it worked (server confirmed via curl) but the running
        # window was still executing the old, broken app.js.
        path = request.url.path
        if path.startswith(("/api/notifications", "/api/chat/live", "/api/chat/stream")):
            response.headers["Cache-Control"] = "no-store"
        if path == "/api/chat/artifacts/content":
            # Only the authenticated, session-checked viewer may be framed.
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
            response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'self'; sandbox"
            response.headers["Cache-Control"] = "no-store"
        elif re.fullmatch(r"/api/google/drive/files/[A-Za-z0-9_-]+/(preview|thumbnail|download)", path):
            # Google content must keep its sandbox even after the app headers.
            response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
        elif path.startswith(("/generated-files/", "/generated-images/")):
            # Legacy links still work, but generated HTML/SVG must never run
            # with the app's origin (including when opened in a new tab).
            response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
            if not path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
                response.headers["Content-Disposition"] = "attachment"
        if path == "/" or path.endswith(_NO_CACHE_SUFFIXES):
            response.headers["Cache-Control"] = "no-store"
        if board_policy:
            response.headers["X-Frame-Options"] = "SAMEORIGIN"
            response.headers["Content-Security-Policy"] = board_policy
        return response


def local_access_open(request: Request) -> bool:
    """With accounts off: is this the app's own window (or a browser it
    handed the cookie to)? Always true for a backend started without a UI
    secret, such as a dev server. See core/auth.py's UI_SECRET.

    A terminal the person paired in the app window (core/cli_access.py) also
    counts, on API routes only and never on the cookie-only ones."""
    secret = auth_module.UI_SECRET
    if not secret:
        return True
    cookie = request.cookies.get(UI_COOKIE_NAME) or ""
    if secrets.compare_digest(cookie, secret):
        return True
    from core import cli_access
    return cli_access.request_allowed(request)


def get_current_user(request: Request) -> Optional[str]:
    """Returns the authenticated username, or None if unauthenticated.
    Does not raise — routes that require auth should use require_user()/require_admin()."""
    if not auth_enabled():
        return SINGLE_USER if local_access_open(request) else None

    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    return auth_manager.validate_session(token)


# Long-lived connections end with their session (account switcher review, 2026-11-11). A websocket (a realtime call)
# or a streamed response (the live chat feed) is signed in once, when it opens; switching accounts, signing out or a
# password change ends that session, and the connection must not keep serving the old account. Every connection
# opened with a session is registered here; core/auth.py tells us when sessions end, and each connection is also
# re-checked every SESSION_RECHECK_SECONDS (an expired session, a deleted account).
SESSION_RECHECK_SECONDS = 15
_STREAM_TYPES = {b"text/event-stream", b"application/x-ndjson", b"application/jsonl"}
_live_sessions: dict = {}  # session token -> set of (event loop, asyncio.Event)


def _sessions_ended(tokens) -> None:
    for token in tokens:
        for loop, ended in list(_live_sessions.get(token, ())):
            try:
                loop.call_soon_threadsafe(ended.set)
            except RuntimeError:  # that loop is closed: its connection is gone
                pass


auth_module.revoke_listeners.append(_sessions_ended)


class _SessionGuard:
    """Wraps one connection's receive and send. Once its session ends: a websocket is closed (code 4401) and
    reads as disconnected; a streamed response (an event stream or line-by-line JSON) sends its last, empty chunk
    and the app reads a disconnect, so the stream stops. Any other reply goes out whole: the switch and sign-out
    routes end the very session they came with, and their answers must still arrive."""

    def __init__(self, scope, receive, send, session):
        self.kind, self.session = scope["type"], session
        self._receive, self._send = receive, send
        self.ended = asyncio.Event()
        self.entry = (asyncio.get_running_loop(), self.ended)
        _live_sessions.setdefault(session, set()).add(self.entry)
        self.watcher = None
        self.closed = False
        self.streaming = False  # set when an HTTP reply starts with a stream's content type

    async def _watch(self):
        while not self.ended.is_set():
            try:
                await asyncio.wait_for(self.ended.wait(), SESSION_RECHECK_SECONDS)
            except asyncio.TimeoutError:
                if auth_manager.validate_session(self.session) is None:
                    self.ended.set()

    async def _finish(self):
        if self.kind == "websocket":
            if not self.closed:
                self.closed = True
                try:
                    await self._send({"type": "websocket.close", "code": 4401, "reason": "signed out"})
                except Exception:
                    pass
            return {"type": "websocket.disconnect", "code": 4401}
        return {"type": "http.disconnect"}

    async def receive(self):
        if self.ended.is_set():
            return await self._finish()
        if self.watcher is None:
            self.watcher = asyncio.ensure_future(self._watch())
        message = asyncio.ensure_future(self._receive())
        stop = asyncio.ensure_future(self.ended.wait())
        done, _ = await asyncio.wait({message, stop}, return_when=asyncio.FIRST_COMPLETED)
        if message not in done and self.kind == "http" and not self.streaming:
            await message  # not a stream: its reply goes out whole
            done = {message}
        if message in done:
            stop.cancel()
            return message.result()
        message.cancel()
        return await self._finish()

    async def send(self, message):
        if message.get("type") == "http.response.start":
            kind = dict(message.get("headers") or []).get(b"content-type", b"").split(b";")[0].strip().lower()
            self.streaming = kind in _STREAM_TYPES
        if not self.ended.is_set() or self.closed:
            if self.closed and self.kind == "websocket":
                return
            if self.closed and message.get("type") == "http.response.body":
                return
            return await self._send(message)
        if self.kind == "websocket":
            await self._finish()
            return
        if self.streaming and message.get("type") == "http.response.body" and message.get("more_body"):
            self.closed = True  # a stream: its last chunk, empty
            return await self._send({"type": "http.response.body", "body": b"", "more_body": False})
        return await self._send(message)

    def close(self):
        if self.watcher:
            self.watcher.cancel()
        entries = _live_sessions.get(self.session)
        if entries:
            entries.discard(self.entry)
            if not entries:
                _live_sessions.pop(self.session, None)


class AccountContextMiddleware:
    """Sets the account every request and websocket works in (core/accounts.py, Multi-Account phase 1),
    from the same sign-in check the routes use, or a model tool call's turn token. No sign-in, no account:
    personal data is then refused, never guessed. A plain ASGI layer, so the account follows the request
    into the endpoint and any work it starts; it is added outermost in app.py. A connection signed in with a
    session cookie is also guarded: it ends when that session does (_SessionGuard)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        from starlette.requests import HTTPConnection
        from core import accounts
        session = None
        try:
            connection = HTTPConnection(scope)
            user = get_current_user(connection)
            account = accounts.account_for_user(user)
            if user is not None and auth_enabled():
                session = connection.cookies.get(SESSION_COOKIE_NAME)
            if account is None and connection.headers.get("X-JARVIS-Tool-Token"):
                # A model's tool call (mcp_servers/hive_mind_cli.py, the bot MCP proxy) carries its turn's
                # token instead of a sign-in: it works in the account the turn ran in.
                from core import tool_access
                grant = tool_access.resolve(connection.headers["X-JARVIS-Tool-Token"])
                account = grant.account if grant else None
        except Exception:  # an unreadable sign-in is no sign-in, never a crashed request
            account = None
        token = accounts.set_current(account)
        guard = _SessionGuard(scope, receive, send, session) if session else None
        try:
            if guard:
                await self.app(scope, guard.receive, guard.send)
            else:
                await self.app(scope, receive, send)
        finally:
            if guard:
                guard.close()
            accounts.reset_current(token)


def require_user(request: Request) -> str:
    user = get_current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


def require_admin(request: Request) -> str:
    user = require_user(request)
    if not auth_manager.is_admin(user):
        raise HTTPException(status_code=403, detail="admin privileges required")
    return user
