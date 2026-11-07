"""Terminal pairing for the Kairos CLI (vault spec "Kairos CLI (Build Spec)",
section 4.3; locked 2026-10-22).

With accounts off, only the app's own windows carry the per-launch cookie
(core/auth.py's UI_SECRET), so a terminal has no way in. This module is the
one door: a terminal asks to pair, the app window raises an ordinary approval
prompt showing a word pair the terminal also shows, and only a click there
issues a token.

The rules that keep an agent's shell from walking through it:

- The token lives in this process's memory and in the CLI's memory, nowhere
  else. Nothing here writes it to disk, and only its hash is kept here.
- Only the app window can answer a pairing prompt (routes/permission_routes.py
  refuses a token holder), so a paired terminal cannot approve another one.
- Nothing allows a pair silently: the broker is asked with force_prompt, so a
  saved rule can never stand in for the click, and silence denies.
- The token is accepted on API routes only, from loopback only, and never on
  the routes that export, wipe, hand out the app cookie or manage accounts
  (COOKIE_ONLY below).
- It dies when the terminal says goodbye, after IDLE_SECONDS without a
  request (the CLI sends a heartbeat), after MAX_AGE_SECONDS, when revoked in
  Settings > Permissions, and when the backend stops.
- One pending pair at a time and a few per minute, so an unauthenticated
  caller cannot flood the window with prompts.
"""
import asyncio
import hashlib
import logging
import re
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from core import auth as auth_module
from core.auth import UI_COOKIE_NAME, auth_enabled

logger = logging.getLogger(__name__)

HEADER = "X-Kairos-CLI-Token"
SURFACE = "app:cli-pair"
TOOL = "kairos_cli_pair"
PAIR_TIMEOUT_SECONDS = 120
CLAIM_GRACE_SECONDS = 60
MAX_AGE_SECONDS = 12 * 60 * 60
IDLE_SECONDS = 5 * 60
PAIRS_PER_MINUTE = 5
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}

# Routes a terminal token never opens, whatever else it may do. Exporting or
# wiping data, network exposure and accounts stay with the app window, and
# /api/auth as a whole stays closed so a token can never mint the browser
# handoff code (ui-code) that would trade it for the app's own cookie.
COOKIE_ONLY = (
    re.compile(r"/api/system/backup(/.*)?"),
    re.compile(r"/api/system/wipe(-kinds)?"),
    re.compile(r"/api/system/tabs/[^/]+/export"),
    re.compile(r"/api/remote(/.*)?"),
    re.compile(r"/api/auth(/.*)?"),
    re.compile(r"/api/notch(/.*)?"),  # the desktop notch is the app's own window
    re.compile(r"/api/browse(/.*)?"),  # Browse is the desktop app's own window
)
# The /api/auth routes a terminal does need, carved back out of the rule above.
TOKEN_AUTH_ROUTES = {"/api/auth/status", "/api/auth/cli/heartbeat", "/api/auth/cli/session"}

# Two short, plain words the person can compare at a glance. Ordinary
# vocabulary on purpose: the pair is a visual match, not a secret.
_FIRST = ("amber", "brass", "cedar", "copper", "dusk", "ember", "fern", "flint", "gilt", "harbor",
          "hazel", "indigo", "ivory", "juniper", "linen", "maple", "meadow", "moss", "ochre", "olive",
          "pearl", "quiet", "river", "rowan", "saffron", "silver", "slate", "sorrel", "tawny", "willow")
_SECOND = ("anchor", "arrow", "beacon", "bell", "bridge", "candle", "comet", "compass", "crane", "drum",
           "falcon", "feather", "harp", "heron", "kettle", "lantern", "lark", "meteor", "orchard", "otter",
           "quill", "sail", "sparrow", "spindle", "tide", "torch", "violin", "wagon", "wren", "zephyr")


def _words() -> str:
    return f"{secrets.choice(_FIRST)}-{secrets.choice(_SECOND)}"


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean(text, limit: int) -> str:
    """Terminal-supplied labels are shown in the app as text; strip control
    characters and bound the length so a label cannot pretend to be more."""
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", str(text or ""))
    return value.strip()[:limit]


class PairRefused(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class Pair:
    id: str
    claim_hash: str
    words: str
    pid: int
    terminal: str
    created_at: float
    status: str = "pending"          # pending | allowed | rejected | expired
    reason: str = ""
    token: Optional[str] = None      # held only until claimed
    done: asyncio.Event = field(default_factory=asyncio.Event)
    task: Optional[asyncio.Task] = None


@dataclass
class Terminal:
    id: str
    token_hash: str
    words: str
    pid: int
    terminal: str
    created_at: float
    expires_at: float
    last_seen: float


_pairs: dict[str, Pair] = {}
_recent: list[float] = []
_terminals: dict[str, Terminal] = {}     # keyed by token hash
_forwarder: Optional[asyncio.Task] = None


# -- who is asking --------------------------------------------------------

def _loopback(request) -> bool:
    client = getattr(request, "client", None)
    return bool(client and client.host in _LOOPBACK)


def pairing_needed() -> bool:
    """A terminal must pair only when the backend is locked to its window:
    accounts off and a UI secret in force. With accounts on the CLI signs in
    instead; a backend started without a secret (a dev server) is open."""
    return not auth_enabled() and bool(auth_module.UI_SECRET)


def is_app_window(request) -> bool:
    """The app's own window (or a browser it handed the cookie to). Never a
    terminal token: the token is a header, and this reads only the cookie."""
    if auth_enabled():
        return False
    secret = auth_module.UI_SECRET
    if not secret:
        return True
    cookie = request.cookies.get(UI_COOKIE_NAME) or ""
    return secrets.compare_digest(cookie, secret)


def token_route_allowed(path: str) -> bool:
    if not path.startswith("/api/"):
        return False
    if path in TOKEN_AUTH_ROUTES:
        return True
    return not any(rule.fullmatch(path) for rule in COOKIE_ONLY)


def request_allowed(request) -> bool:
    """Does this request carry a live terminal token, on a route a token may
    use, from this machine? Used by core/middleware.py's local_access_open."""
    value = request.headers.get(HEADER) or ""
    if not value or not pairing_needed():
        return False
    if not _loopback(request) or not token_route_allowed(request.url.path):
        return False
    return validate(value) is not None


def validate(value: str) -> Optional[Terminal]:
    record = _terminals.get(_digest(value))
    if record is None:
        return None
    now = time.time()
    if now >= record.expires_at:
        _drop(record, "expired after 12 hours")
        return None
    if now - record.last_seen > IDLE_SECONDS:
        _drop(record, "the terminal went quiet")
        return None
    record.last_seen = now
    return record


# -- pairing --------------------------------------------------------------

def _audit(entry: dict) -> None:
    try:
        from core import permissions
        permissions.record_event(entry)
    except Exception:
        logger.exception("could not write the terminal pairing audit entry")


def _prune(now: float) -> None:
    while _recent and now - _recent[0] > 60:
        _recent.pop(0)
    for pair_id, pair in list(_pairs.items()):
        if pair.status != "pending" and now - pair.created_at > PAIR_TIMEOUT_SECONDS + CLAIM_GRACE_SECONDS:
            _pairs.pop(pair_id, None)
            if pair.token:
                revoke_token(pair.token, "never collected")


def _ensure_forwarder() -> None:
    """The pairing surface's prompts go to every app window on the live feed
    (services/chat_live.py), the same feed that carries chat prompts."""
    global _forwarder
    from core import permissions
    if _forwarder and not _forwarder.done() and SURFACE in permissions._channels:
        return
    queue = permissions.open_channel(SURFACE)

    async def forward():
        from services import chat_live
        while True:
            packet = await queue.get()
            if "permission_closed" in packet:
                chat_live.broadcast_app({"type": "cli_pair_closed", "id": packet["permission_closed"]})
            else:
                chat_live.broadcast_app({"type": "cli_pair", "request": packet})

    _forwarder = asyncio.get_running_loop().create_task(forward())


def start_pair(pid, terminal, request) -> dict:
    if auth_enabled():
        raise PairRefused(409, "Accounts are on. Sign in with: kairos login")
    if not auth_module.UI_SECRET:
        raise PairRefused(409, "This Kairos is open to local requests; no pairing is needed.")
    if not _loopback(request):
        raise PairRefused(403, "Terminals pair only from this computer.")
    now = time.time()
    _prune(now)
    if any(p.status == "pending" for p in _pairs.values()):
        raise PairRefused(429, "Another terminal is already waiting for approval in the Kairos app.")
    if len(_recent) >= PAIRS_PER_MINUTE:
        raise PairRefused(429, "Too many pairing requests. Wait a minute and try again.")
    _recent.append(now)
    claim = secrets.token_urlsafe(32)
    pair = Pair(id=uuid.uuid4().hex, claim_hash=_digest(claim), words=_words(),
                pid=int(pid) if isinstance(pid, int) and 0 <= pid < 2**31 else 0,
                terminal=_clean(terminal, 60) or "a terminal", created_at=now)
    _pairs[pair.id] = pair
    _ensure_forwarder()
    pair.task = asyncio.get_running_loop().create_task(_ask(pair))
    _audit({"decision": "cli_pair_requested", "tool": TOOL, "content": pair.words, "pid": pair.pid})
    return {"request_id": pair.id, "claim": claim, "words": pair.words,
            "expires_at": now + PAIR_TIMEOUT_SECONDS}


async def _ask(pair: Pair) -> None:
    from core import permissions
    try:
        decision = await permissions.decide(
            surface=SURFACE, tool=TOOL,
            arguments={"terminal": pair.terminal, "process": pair.pid, "words": pair.words},
            title=f"A terminal wants to use Kairos. It shows {pair.words}. Allow this terminal?",
            description=("Allow only if your terminal shows the same words. The terminal can then chat, "
                         "run Forge and answer its own chats' prompts until it closes, for 12 hours at most."),
            target=pair.words, timeout=PAIR_TIMEOUT_SECONDS, force_prompt=True,
            choices=[{"id": "allow", "label": "Allow until this terminal closes", "behavior": "allow", "scope": "once"},
                     {"id": "reject", "label": "Reject", "behavior": "deny", "scope": "once"}])
        if decision.behavior == "allow":
            pair.token = _issue(pair)
            pair.status = "allowed"
        else:
            pair.status = "expired" if "within" in decision.reason or "closed" in decision.reason else "rejected"
            pair.reason = decision.reason
    except Exception:
        logger.exception("terminal pairing failed")
        pair.status, pair.reason = "rejected", "Pairing failed."
    finally:
        if pair.status == "pending":
            pair.status = "rejected"
        pair.done.set()


def _issue(pair: Pair) -> str:
    value = "kcli_" + secrets.token_urlsafe(32)
    now = time.time()
    record = Terminal(id=uuid.uuid4().hex[:12], token_hash=_digest(value), words=pair.words, pid=pair.pid,
                      terminal=pair.terminal, created_at=now, expires_at=now + MAX_AGE_SECONDS, last_seen=now)
    _terminals[record.token_hash] = record
    _audit({"decision": "cli_token_issued", "tool": TOOL, "content": pair.words, "terminal_id": record.id})
    return value


async def claim(request_id: str, claim_value: str, wait: float = 25.0) -> dict:
    """The pairing terminal collects its answer. Only the holder of the claim
    secret returned by start_pair can; the token is handed over exactly once."""
    pair = _pairs.get(request_id or "")
    if pair is None or not secrets.compare_digest(pair.claim_hash, _digest(claim_value or "")):
        raise PairRefused(404, "No such pairing request.")
    if pair.status == "pending":
        try:
            await asyncio.wait_for(pair.done.wait(), timeout=max(0.0, min(wait, 30.0)))
        except asyncio.TimeoutError:
            return {"status": "pending"}
    _pairs.pop(pair.id, None)
    if pair.status == "allowed" and pair.token:
        token, pair.token = pair.token, None
        record = _terminals.get(_digest(token))
        return {"status": "allowed", "token": token, "terminal_id": record.id if record else None,
                "expires_at": record.expires_at if record else None}
    return {"status": pair.status, "reason": pair.reason}


# -- the terminals ----------------------------------------------------------

def _drop(record: Terminal, reason: str) -> None:
    if _terminals.pop(record.token_hash, None) is not None:
        _audit({"decision": "cli_token_revoked", "tool": TOOL, "content": record.words,
                "terminal_id": record.id, "reason": reason})


def revoke_token(value: str, reason: str) -> bool:
    record = _terminals.get(_digest(value or ""))
    if record:
        _drop(record, reason)
    return record is not None


def revoke(terminal_id: str, reason: str = "revoked in Settings") -> bool:
    record = next((r for r in _terminals.values() if r.id == terminal_id), None)
    if record:
        _drop(record, reason)
    return record is not None


def current(request) -> Optional[Terminal]:
    value = request.headers.get(HEADER) or ""
    return validate(value) if value else None


def list_terminals() -> list[dict]:
    now = time.time()
    for record in list(_terminals.values()):
        if now >= record.expires_at or now - record.last_seen > IDLE_SECONDS:
            _drop(record, "expired after 12 hours" if now >= record.expires_at else "the terminal went quiet")
    return [{"id": r.id, "words": r.words, "terminal": r.terminal, "pid": r.pid,
             "created_at": r.created_at, "expires_at": r.expires_at, "last_seen": r.last_seen}
            for r in sorted(_terminals.values(), key=lambda r: r.created_at)]


def pending_pairs() -> list[dict]:
    from core import permissions
    return permissions.pending_for(SURFACE)


def reset() -> None:
    """Tests only: forget every pair and terminal."""
    global _forwarder
    for pair in _pairs.values():
        if pair.task and not pair.task.done():
            pair.task.cancel()
    _pairs.clear()
    _recent.clear()
    _terminals.clear()
    if _forwarder and not _forwarder.done():
        _forwarder.cancel()
    _forwarder = None
