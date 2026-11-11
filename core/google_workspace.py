"""Owner-scoped Google Workspace connections for Drive, Calendar and Gmail.

Accounts have opaque IDs, encrypted tokens and an owner. Historical accounts
without owners remain shared among admins, preserving pre-migration access.
Both the old single-account file and dev's hash-keyed accounts normalize into
this shape without reauthorization. Library and Calendar selections can differ.

Routes and chat tools must resolve IDs using the actual user before using an
account. Ownerless calls may use shared accounts only. File mutations use a
reentrant lock; token refreshes use independent per-account async locks.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from email.message import EmailMessage
from copy import deepcopy
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import httpx

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.secret_storage import decrypt, decrypt_install, encrypt, encrypt_install
from core import calendar_recurrence as repeats


FILE = os.path.join(DATA_DIR, "google_workspace.json")
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
HOSTS = {
    "drive": "https://www.googleapis.com/drive/v3",
    "upload": "https://www.googleapis.com/upload/drive/v3",
    "sheets": "https://sheets.googleapis.com/v4",
    "forms": "https://forms.googleapis.com/v1",
    "thumbnail": "https://lh3.googleusercontent.com",
    "calendar": "https://www.googleapis.com/calendar/v3",
    "gmail": "https://gmail.googleapis.com/gmail/v1",
    "youtube": "https://www.googleapis.com/youtube/v3",
    "youtube_analytics": "https://youtubeanalytics.googleapis.com/v2",
    "youtube_upload": "https://www.googleapis.com/upload/youtube/v3",
}
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar"
# Content Studio's read-only YouTube analytics. Never part of SCOPES: an account gets them only when its user
# asks for them (start_sign_in(extra_scopes=...)), as an incremental grant on top of the sign-in it already has.
YOUTUBE_SCOPES = ("https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly")
# Content Studio's direct YouTube posting through the person's own Google project (spec D1). Asked for only when
# they connect posting; readonly lets Kairos check the upload goes to the channel they registered.
YOUTUBE_UPLOAD_SCOPES = ("https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly")
SCOPES = (
    "openid", "email",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    CALENDAR_SCOPE, GMAIL_SEND_SCOPE,
)
FILE_FIELDS = "nextPageToken,incompleteSearch,files(id,name,mimeType,size,parents,modifiedTime,webViewLink,description,starred,trashed,driveId,capabilities,owners,shared,thumbnailLink)"
MAX_DOWNLOAD = 25 * 1024 * 1024
ACCOUNT_KEYS = ("refresh_token", "access_token", "expires_at", "email", "granted_scopes", "calendar_ids")
_account: ContextVar[str | None] = ContextVar("google_account", default=None)
_pending: dict[str, dict] = {}
_refresh_locks: dict[str, asyncio.Lock] = {}
_lock = threading.RLock()
_calendar_cache: dict[tuple, tuple[float, list[dict]]] = {}
_calendar_list_cache: dict = {}  # account id -> (monotonic time, calendars); same 60 s TTL and invalidation as _calendar_cache
_calendar_generation = 0


class GoogleError(Exception):
    def __init__(self, message: str, status: int = 400, reason: str = "", retry_after: float | None = None,
                 info: dict | None = None):
        super().__init__(message)
        self.status = status
        self.reason = reason            # Google's error reason, e.g. "quotaExceeded"
        self.retry_after = retry_after  # seconds, from a Retry-After header when Google sent one
        # Google's ErrorInfo detail when it sent one: {"reason": "SERVICE_DISABLED", "service": "youtube.googleapis.com",
        # "consumer": "projects/123", "status": "PERMISSION_DENIED"}. Content Studio's setup names the API to turn on from it.
        self.info = info or {}


def error_info(error: dict) -> dict:
    """The parts of a Google API error body that say which API and project it is about (google.rpc.ErrorInfo), never
    a token or an email: reason, service, consumer, and the error's status."""
    out = {"status": str(error.get("status") or "")[:60]}
    for detail in error.get("details") or []:
        if isinstance(detail, dict) and str(detail.get("@type", "")).endswith("google.rpc.ErrorInfo"):
            meta = detail.get("metadata") or {}
            out.update(reason=str(detail.get("reason") or "")[:60], service=str(meta.get("service") or "")[:80],
                       consumer=str(meta.get("consumer") or "")[:60])
            break
    return {k: v for k, v in out.items() if v}


def project_number(client_id: str | None = None) -> str | None:
    """The Google Cloud project number of an OAuth client id: Google's client ids are '<project number>-<code>.apps.
    googleusercontent.com'. None when the id is not in that form (Kairos then links to the console without a project)."""
    value = client_id if client_id is not None else (_state().get("client_id") or "")
    match = re.fullmatch(r"(\d{5,20})-[A-Za-z0-9_]+\.apps\.googleusercontent\.com", value or "")
    return match.group(1) if match else None


class GoogleOffline(GoogleError):
    """Google could not be reached at all (no connection, name lookup, time-out). A plain offline state, not
    a fault: routes answer 503 with this sentence, and calendar reads fall back to what they last fetched.
    Found by the 2.3.0 upgrade rehearsal, run offline: httpx's ConnectError from the token refresh was not a
    GoogleError, so /api/calendar/events and the Google routes answered 500."""

    def __init__(self):
        super().__init__("Google can't be reached right now. Kairos shows what it already has and tries again "
                         "when the connection is back.", 503, "offline")


@contextmanager
def _reaching_google():
    try:
        yield
    except httpx.TransportError as error:  # connect, read and pool errors and every time-out
        raise GoogleOffline() from error


# Multi-Account group 6: the OAuth app (client id and secret, set once by an admin) stays in FILE for the
# whole install; each account's signed-in Google accounts and choices live in its own folder.
PERSONAL = ("accounts", "default_account", "active_account", "calendar_account", *ACCOUNT_KEYS)
ACCOUNTS_FILE = None  # a test can point the personal half at its own file


def _accounts_file() -> str:
    from core import accounts
    return ACCOUNTS_FILE or accounts.path("google_accounts.json")


def _load() -> dict:
    """The install's OAuth app with the current account's Google accounts. Sign-ins made before accounts had
    folders were all in FILE and are the first admin's (decision D7): they move to that account's file the first
    time it loads, and no other account ever sees them."""
    from core import accounts
    with _lock:
        shared = read_json(FILE, {})
        path = _accounts_file()
        personal = read_json(path, {})
        if any(key in shared for key in PERSONAL) and accounts.effective_account() == accounts.local_account():
            moved = {key: shared.pop(key) for key in PERSONAL if key in shared}
            personal = {**moved, **personal}
            write_json_atomic(path, personal)
            write_json_atomic(FILE, shared)
        return {**{k: v for k, v in shared.items() if k not in PERSONAL}, **personal}


def _save(data: dict) -> None:
    with _lock:
        write_json_atomic(_accounts_file(), {k: v for k, v in data.items() if k in PERSONAL})
        write_json_atomic(FILE, {k: v for k, v in data.items() if k not in PERSONAL})


def pending_account(state: str):
    """The account that started a sign-in, for the callback, which nobody is signed in to."""
    return (_pending.get(state) or {}).get("kairos_account")


def _state() -> dict:
    """The saved connection, moving a one-account file into `accounts` once."""
    with _lock:
        data = _load()
        if data.get("refresh_token") and not data.get("accounts"):
            ident = "acct_" + secrets.token_urlsafe(12)
            account = {key: data.pop(key) for key in ACCOUNT_KEYS if key in data}
            # owner None: connected before accounts had owners, so every admin
            # keeps the access they had to it.
            data["accounts"] = {ident: {**account, "id": ident, "owner": None, "added_at": time.time()}}
            data["default_account"] = ident
            _save(data)
        # dev stored accounts keyed by an email hash, without identity/owner.
        # Preserve every token and calendar selection, but normalize them once.
        accounts = data.get("accounts") or {}
        changed = False
        remap = {}
        for old, record in list(accounts.items()):
            if "id" not in record:
                ident = "acct_" + secrets.token_urlsafe(12)
                remap[old] = ident
                accounts[ident] = {**record, "id": ident, "owner": record.get("owner"),
                                   "added_at": record.get("added_at") or time.time()}
                del accounts[old]
                changed = True
        for key in ("active_account", "calendar_account"):
            if data.get(key) in remap:
                data[key] = remap[data[key]]
        if "default_account" not in data and accounts:
            data["default_account"] = data.get("calendar_account") or data.get("active_account") or next(iter(accounts))
            changed = True
        if changed:
            data["accounts"] = accounts
            _save(data)
        return data


def _accounts(data: dict, user: str | None = None) -> list[dict]:
    """Accounts this Kairos user may use, oldest first; None means all."""
    items = sorted((data.get("accounts") or {}).values(), key=lambda item: item.get("added_at") or 0)
    return [item for item in items if user is None or item.get("owner") in (None, user)]


def _default(data: dict) -> dict | None:
    return (data.get("accounts") or {}).get(data.get("default_account") or "")


def _library(items: list[dict]) -> list[dict]:
    """The accounts Drive, Gmail and Calendar may use: not one added only for YouTube (Content Studio's "Use another
    Google account"), which holds the YouTube permissions alone and is never anyone's Library or Calendar default."""
    return [item for item in items if not item.get("youtube_only")]


def resolve_account(user: str, account_id: str | None = None) -> str:
    """The account a Drive request uses: the one named, if this user may use
    it, else their default. Unknown and foreign ids get the same refusal."""
    data = _state()
    usable = [a for a in _accounts(data) if a.get("owner") in (None, user)]
    if account_id:
        match = next((item for item in usable if (item["id"] == account_id or (item.get("email") or "").lower() == str(account_id).strip().lower())), None)
        if match is None:
            raise GoogleError("Unknown Google account", 404)
        return match["id"]
    usable = _library(usable)
    if not usable:
        raise GoogleError("Connect Google Workspace in Library first", 401)
    chosen = (data.get("library_defaults") or {}).get(user) or data.get("active_account") or data.get("default_account")
    return next((item["id"] for item in usable if item["id"] == chosen), usable[0]["id"])



def resolve_calendar_account(user: str, account_id: str | None = None) -> str:
    data = _state()
    chosen = account_id or (data.get("calendar_defaults") or {}).get(user) or data.get("calendar_account") or data.get("default_account")
    if not chosen:
        raise GoogleError("Reconnect to add Calendar", 409)
    return resolve_account(user, chosen)


@contextmanager
def use_account(account: str | None, user: str | None = None):
    # Boundary callers supply the actual session/chat owner. None may only
    # use historical shared accounts, never a user-owned account.
    ident = resolve_account(user, account)
    token = _account.set(ident)
    try:
        yield
    finally:
        _account.reset(token)


def _calendar_account() -> dict:
    data = _state()
    ident = _account.get() or data.get("calendar_account") or data.get("default_account")
    record = (data.get("accounts") or {}).get(ident) or {}
    # An ownerless/background caller never inherits a private Calendar.
    return record if _account.get() or record.get("owner") is None else {}


def set_default(account: str, purpose: str = "library", user: str | None = None) -> dict:
    if purpose not in ("library", "calendar"):
        raise GoogleError("Unknown Google account purpose")
    with _lock:
        ident = resolve_account(user, account)
        data = _state()
        if data["accounts"][ident].get("youtube_only"):
            raise GoogleError("That Google account was added only for YouTube. Sign in to it from Library to use it "
                              "for Drive, Gmail or Calendar", 409)
        data.setdefault("calendar_defaults" if purpose == "calendar" else "library_defaults", {})[user] = ident
        _save(data)
    if purpose == "calendar":
        invalidate_calendar()
    return status(user)

def _public(item: dict, chosen: str | None) -> dict:
    # Never a token: only what the account switcher shows.
    return {"id": item["id"], "email": item.get("email"), "default": item["id"] == chosen,
            "error": item.get("error"),
            "can_send_email": GMAIL_SEND_SCOPE in (item.get("granted_scopes") or []),
            "calendar_connected": CALENDAR_SCOPE in (item.get("granted_scopes") or [])}


def account_info(ident: str | None) -> dict | None:
    """What a feature needs to know about one connected account, never a token: its id, email, the scopes it
    granted and whether it has a refresh token. None when there is no such account."""
    item = (_state().get("accounts") or {}).get(ident or "")
    if not item:
        return None
    return {"id": item["id"], "email": item.get("email"), "granted_scopes": list(item.get("granted_scopes") or []),
            "connected": bool(item.get("refresh_token")), "error": item.get("error"),
            "youtube_only": bool(item.get("youtube_only"))}


def accounts_for(user: str | None) -> list[dict]:
    """Every Google account this user may use, the YouTube-only ones too, for Content Studio's account chooser.
    Never a token: the id, the email, whether it was added only for YouTube, which YouTube grants it holds."""
    data = _state()
    out = []
    for item in _accounts(data, user):
        granted = set(item.get("granted_scopes") or [])
        out.append({"id": item["id"], "email": item.get("email"), "youtube_only": bool(item.get("youtube_only")),
                    "error": item.get("error"), "youtube_read": set(YOUTUBE_SCOPES) <= granted,
                    "youtube_upload": set(YOUTUBE_UPLOAD_SCOPES) <= granted})
    return out


def configured() -> bool:
    return bool(_state().get("client_id"))


def _id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise GoogleError("Invalid Google file ID")
    return value


def status(user: str | None = None) -> dict:
    """Calendar fields describe the installation default account, as before;
    `accounts`, `email` and `default_account` are the Drives this user can
    browse and the one their Drive opens on."""
    data = _state()
    default = _calendar_account()
    if user is not None:
        try:
            default = (data.get("accounts") or {})[resolve_calendar_account(user)]
        except GoogleError:
            default = {}
    usable = _library([a for a in _accounts(data) if a.get("owner") in (None, user)])
    chosen = resolve_account(user, None) if usable else None
    return {"configured": bool(data.get("client_id")),
            "connected": bool(usable),
            "email": next((item.get("email") for item in usable if item["id"] == chosen), None),
            "client_id": data.get("client_id") or "",
            "granted_scopes": default.get("granted_scopes") or [],
            "calendar_connected": bool(default.get("refresh_token") and CALENDAR_SCOPE in (default.get("granted_scopes") or [])),
            "calendar_ids": default.get("calendar_ids"),
            # Calendar's Reconnect refreshes this account in place; only an account this user may use.
            "calendar_account": default.get("id") if any(item["id"] == default.get("id") for item in usable) else None,
            "accounts": [_public(item, chosen) for item in usable],
            "default_account": chosen if usable else None, "active_account": chosen if usable else None}


def configure(client_id: str, client_secret: str = "", user: str | None = None) -> dict:
    client_id = client_id.strip()
    if len(client_id) > 256 or not client_id.endswith(".apps.googleusercontent.com"):
        raise GoogleError("Enter a Google OAuth Desktop client ID")
    with _lock:
        data = _state()
        if data.get("client_id") != client_id:
            # Tokens belong to the old client, so every account goes with it,
            # and sign-ins started for the old client can no longer finish.
            invalidate_calendar()
            data.pop("accounts", None)
            data.pop("default_account", None)
            data.pop("client_secret", None)
            _pending.clear()
            _refresh_locks.clear()
        data["client_id"] = client_id
        if client_secret:
            data["client_secret"] = encrypt_install(client_secret.strip())
        _save(data)
    return status(user)


def disconnect(account_id: str | None = None, user: str | None = None) -> dict:
    """Forget one of this user's accounts (their default when none is named);
    the others stay. Disconnecting when nothing is connected is a no-op. A
    shared (migrated) account may be disconnected by any admin, as before."""
    with _lock:
        if not _library(_accounts(_state(), user)) and account_id is None:
            return status(user)
        ident = resolve_account(user, account_id)
        data = _state()
        data["accounts"].pop(ident, None)
        _refresh_locks.pop(ident, None)
        if data.get("default_account") == ident:
            # Calendar passes to a shared account, else to one of the
            # disconnecting user's own, never to another user's account.
            remaining = _library(_accounts(data))
            heir = (next((item for item in remaining if item.get("owner") is None), None)
                    or next((item for item in remaining if item.get("owner") == user), None))
            data["default_account"] = heir["id"] if heir else None
            invalidate_calendar()
        _save(data)
    return status(user)


def start_sign_in(redirect_uri: str, owner: str | None = None, add: bool = False,
                  account_id: str | None = None, extra_scopes: tuple = (), only_extra: bool = False,
                  then=None, failed=None) -> str:
    """With `add` the default account stays; otherwise the account signed in
    to becomes the default (the one-account behaviour, and Calendar's
    reconnect). `account_id` reconnects that account, which must be one this
    user may use (a shared account too) and must sign in as the same email.
    `extra_scopes` is an optional added grant (YouTube analytics): Google is told to keep what the account
    already granted, and only a sign-in that asks for them ever carries them.
    `only_extra` (Content Studio's "Use another Google account") asks for the identity and the extra scopes alone,
    never Drive, Gmail or Calendar: whichever Google account the person picks in Google's chooser is added to this
    user (an account they already connected keeps what it had), and an account new to Kairos is marked YouTube-only,
    so it never becomes a Library or Calendar default. `then`, an async callable (account id, email), runs after
    the account is saved, as the Kairos account that started the sign-in; its GoogleError is the sign-in's answer.
    `failed`, a plain callable (Google's error code), runs when Google sends the person back refused or cancelled, so the
    feature that asked can say so where the person looks next (Content Studio's setup: a Testing consent screen whose
    Test users list does not have the account)."""
    if extra_scopes and not set(extra_scopes) <= set(YOUTUBE_SCOPES) | set(YOUTUBE_UPLOAD_SCOPES):
        raise GoogleError("Unknown Google permission requested")
    if only_extra and (not extra_scopes or account_id is not None):
        raise GoogleError("A YouTube-only sign-in adds a new account and needs its YouTube permissions")
    if account_id is not None:
        account_id = resolve_account(owner, account_id)
    client_id = _state().get("client_id")
    if not client_id:
        raise GoogleError("Set a Google OAuth Desktop client ID first")
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+/api/google/oauth/callback", redirect_uri):
        raise GoogleError("Google sign-in must start on this computer")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    # Single use, expiring, and bound to the Kairos user who started it: the
    # callback can only finish a sign-in begun here, for that user.
    from core import accounts
    _pending[state] = {"verifier": verifier, "expires": time.time() + 600, "owner": owner, "add": add,
                       "account": account_id, "client_id": client_id, "extra_scopes": list(extra_scopes),
                       "only_extra": only_extra, "then": then, "failed": failed,
                       "kairos_account": accounts.effective_account()}
    for stale, pending in list(_pending.items()):
        if pending["expires"] < time.time():
            _pending.pop(stale, None)
    # select_account: the chooser always shows, so a second Google account (or a YouTube Brand Account) can be picked.
    base = ("openid", "email") if only_extra else SCOPES
    params = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
              "scope": " ".join(dict.fromkeys((*base, *extra_scopes))), "access_type": "offline", "prompt": "select_account consent",
              "state": state, "code_challenge": challenge, "code_challenge_method": "S256"}
    if extra_scopes:
        params["include_granted_scopes"] = "true"
    return AUTH_URL + "?" + urlencode(params)


async def finish_sign_in(state: str, code: str | None, redirect_uri: str, error: str | None = None) -> str:
    pending = _pending.pop(state, None)
    if not pending or pending["expires"] < time.time():
        raise GoogleError("This sign-in request expired or was not started here")
    if error or not code:
        if pending.get("failed"):
            try:
                pending["failed"](str(error or "no_code")[:60])
            except Exception:  # noqa: BLE001 - a note for the screen; the refusal below is the answer
                pass
        if pending.get("extra_scopes") and error == "access_denied":
            raise GoogleError("Google did not let this sign-in finish. If your Kairos Google project's consent screen is in "
                              "Testing, add this Google account to its Test users (Google Auth Platform, Audience), then "
                              "connect again. If you pressed Cancel, just connect again.", 403)
        raise GoogleError("Google sign-in was cancelled or denied")
    data = _state()
    body = {"client_id": data["client_id"], "code": code, "code_verifier": pending["verifier"],
            "redirect_uri": redirect_uri, "grant_type": "authorization_code"}
    if data.get("client_secret"):
        body["client_secret"] = decrypt_install(data["client_secret"])
    async with httpx.AsyncClient(timeout=30) as client:
        with _reaching_google():
            response = await client.post(TOKEN_URL, data=body)
        if response.status_code >= 400:
            raise GoogleError("Google rejected the sign-in code", response.status_code)
        tokens = response.json()
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise GoogleError("Google did not return an offline access token; reconnect and approve offline access")
        access = tokens.get("access_token")
        # The email names the account in the switcher and finds it again on
        # reconnect, so a sign-in without one is refused rather than saved.
        with _reaching_google():
            profile = await client.get("https://openidconnect.googleapis.com/v1/userinfo",
                                       headers={"Authorization": f"Bearer {access}"}) if access else None
        email = profile.json().get("email") if profile is not None and profile.is_success else None
        if not email:
            raise GoogleError("Could not read the Google account's email address; try signing in again", 502)
    owner = pending["owner"]
    with _lock:
        data = _state()
        # Reconnect in place: the account named when the sign-in started, or
        # one with this email that this same user owns. A shared account is
        # only refreshed when it was named explicitly.
        named = (data.get("accounts") or {}).get(pending["account"] or "")
        if pending["account"] and named is None:
            raise GoogleError("That Google account was disconnected while signing in", 409)
        if named is not None and (named.get("email") or "").lower() != email.lower():
            if pending.get("extra_scopes"):
                raise GoogleError(f"In Google's window you chose {email}, but Kairos asked for {named.get('email')}. "
                                  f"Connect again and choose {named.get('email')}, or choose Use another Google account "
                                  f"in Kairos to add {email}", 409)
            raise GoogleError(f"Signed in as {email}, not {named.get('email')}. Choose that account to reconnect it", 409)
        existing = named or next((item for item in _accounts(data) if item.get("owner") == owner and (item.get("email") or "").lower() == email.lower()), None)
    lock = _refresh_locks.setdefault(existing["id"], asyncio.Lock()) if existing else None
    if lock:
        await lock.acquire()
    try:
        with _lock:
            data = _state()
            if data.get("client_id") != pending["client_id"]:
                raise GoogleError("The Google client ID changed during sign-in; sign in again", 409)
            accounts = data.setdefault("accounts", {})
            if existing:
                account = accounts.get(existing["id"])
                if account is None:
                    raise GoogleError("That Google account was disconnected while signing in", 409)
            else:
                ident = "acct_" + secrets.token_urlsafe(12)
                account = accounts[ident] = {"id": ident, "owner": owner, "added_at": time.time()}
                if pending.get("only_extra"):
                    account["youtube_only"] = True
            granted = str(tokens.get("scope") or "").split()
            if pending.get("extra_scopes"):  # an added grant keeps what the account already had
                granted = list(dict.fromkeys([*(account.get("granted_scopes") or []), *granted]))
            else:  # a full sign-in (Library) makes a YouTube-only account an ordinary one
                account.pop("youtube_only", None)
            account.update(refresh_token=encrypt(refresh), access_token=encrypt(access) if access else None,
                           expires_at=time.time() + int(tokens.get("expires_in") or 3600), email=email,
                           granted_scopes=granted)
            account.pop("error", None)
            # A YouTube grant (pending extra_scopes) never moves the Library or Calendar default.
            if not account.get("youtube_only") and not pending.get("extra_scopes") and (not pending["add"] or not _default(data)):
                data["default_account"] = account["id"]
            ident = account["id"]
            _save(data)
    finally:
        if lock:
            lock.release()
    invalidate_calendar()
    if pending.get("then"):
        await pending["then"](ident, email)
    return email


def _mark(ident: str, **fields) -> None:
    """Update one account from a fresh read, so a refresh finishing for
    another account at the same time is never overwritten."""
    with _lock:
        data = _state()
        account = (data.get("accounts") or {}).get(ident)
        if account is None:
            return
        for key, value in fields.items():
            if value is None:
                account.pop(key, None)
            else:
                account[key] = value
        _save(data)


async def _token(account_id: str | None = None, force: bool = False) -> str:
    """An access token for one account; None means the default account."""
    data = _state()
    ident = account_id or _account.get() or resolve_account(None)
    # A forced refresh reuses a token another request refreshed while this
    # one waited for the lock, instead of refreshing again.
    stale = ((data.get("accounts") or {}).get(ident) or {}).get("access_token")
    async with _refresh_locks.setdefault(ident, asyncio.Lock()):
        data = _state()
        account = (data.get("accounts") or {}).get(ident)
        if not account or not account.get("refresh_token"):
            raise GoogleError("Connect Google Workspace in Library first", 401)
        if (account.get("access_token") and (account.get("expires_at") or 0) > time.time() + 90
                and (not force or account["access_token"] != stale)):
            return decrypt(account["access_token"])
        body = {"client_id": data["client_id"], "refresh_token": decrypt(account["refresh_token"]),
                "grant_type": "refresh_token"}
        if data.get("client_secret"):
            body["client_secret"] = decrypt_install(data["client_secret"])
        with _reaching_google():
            async with httpx.AsyncClient(timeout=30) as client:
                response = await client.post(TOKEN_URL, data=body)
        if response.status_code >= 400:
            # Expired or revoked: flagged on this account only, until it reconnects.
            _mark(ident, error="Google sign-in expired or was revoked. Reconnect this account.")
            raise GoogleError("Google authorization expired; reconnect the account", 401)
        tokens = response.json()
        access = tokens.get("access_token")
        if not access:
            raise GoogleError("Google did not return an access token", 502)
        # Google may rotate the refresh token; keep the new one when it does.
        _mark(ident, access_token=encrypt(access), expires_at=time.time() + int(tokens.get("expires_in") or 3600),
              error=None, **({"granted_scopes": tokens["scope"].split()} if "scope" in tokens else {}),
              **({"refresh_token": encrypt(tokens["refresh_token"])} if tokens.get("refresh_token") else {}))
        return access


async def request(api: str, method: str, path: str, *, params: dict | None = None,
                  body: dict | None = None, content: bytes | None = None,
                  content_type: str | None = None, raw: bool = False, account: str | None = None,
                  timeout: float = 45, before=None) -> dict | bytes:
    """`before`, when given, runs just before every attempt, the retry after a refreshed token included; it raises to
    stop an irreversible call (a bot-made YouTube upload, services/content_studio/handsoff.py)."""
    decoded = path
    for _ in range(3):
        decoded = unquote(decoded)
    if (api not in HOSTS or not path.startswith("/") or "//" in decoded or ".." in decoded
            or re.search(r"%[0-9a-fA-F]{2}", decoded)
            or "\\" in decoded or any(ord(c) < 32 for c in decoded)):
        raise GoogleError("Invalid Google API request")
    account = account or _account.get() or (_calendar_account().get("id") if api == "calendar" else None)
    url = HOSTS[api] + path
    for retry in range(2):
        token = await _token(account, force=bool(retry))
        if before:
            before()
        headers = {"Authorization": f"Bearer {token}"}
        if content_type:
            headers["Content-Type"] = content_type
        with _reaching_google():
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.request(method, url, params=params, json=body if content is None else None,
                                                content=content, headers=headers)
        if response.status_code == 401 and retry == 0:
            continue
        if response.is_redirect:
            raise GoogleError("Google API redirects are not allowed", 502)
        if response.status_code >= 400:
            reason, info = "", {}
            try:
                error = response.json().get("error", {})
                detail = error.get("message") or response.text[:250]
                reason = str((error.get("errors") or [{}])[0].get("reason") or "")
                info = error_info(error)
            except (ValueError, AttributeError, IndexError, TypeError):
                detail = response.text[:250]
            try:
                wait = float(response.headers.get("retry-after")) if response.headers.get("retry-after") else None
            except ValueError:
                wait = None
            raise GoogleError(f"Google API: {detail}", response.status_code, reason, wait, info)
        if not raw and response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.content
    raise GoogleError("Google authorization expired; reconnect the account", 401)


def _scoped(account: str | None, api: str, method: str, path: str, **kwargs):
    return request(api, method, path, account=account, **kwargs)


async def list_files(*, account: str | None = None, query: str = "", parent: str | None = None, kind: str = "all",
                     trashed: bool = False, page_token: str | None = None, section: str = "all") -> dict:
    if section not in ("all", "my_drive", "shared", "starred", "recent", "trash"):
        raise GoogleError("Unknown Drive section")
    trashed = trashed or section == "trash"
    terms = [f"trashed = {'true' if trashed else 'false'}"]
    if section == "shared" and not parent:
        terms.append("sharedWithMe = true")
    elif section == "starred" and not parent:
        terms.append("starred = true")
    elif section == "my_drive" and not parent and not query:
        terms.append("'root' in parents")
    if parent:
        terms.append(f"'{_id(parent)}' in parents")
    if kind in ("sheet", "form", "folder"):
        mime = {"sheet": "spreadsheet", "form": "form", "folder": "folder"}[kind]
        terms.append(f"mimeType = 'application/vnd.google-apps.{mime}'")
    elif kind != "all":
        raise GoogleError("Unknown file type")
    if query:
        safe = query[:100].replace("\\", "\\\\").replace("'", "\\'")
        terms.append(f"name contains '{safe}'")
    params = {"q": " and ".join(terms), "pageSize": 100, "fields": FILE_FIELDS,
              "orderBy": "viewedByMeTime desc" if section == "recent" else "folder,name",
              "supportsAllDrives": "true", "includeItemsFromAllDrives": "true"}
    if page_token:
        params["pageToken"] = page_token
    return await _scoped(account, "drive", "GET", "/files", params=params)


async def file_info(file_id: str, account: str | None = None) -> dict:
    return await _scoped(account, "drive", "GET", f"/files/{_id(file_id)}",
                         params={"fields": FILE_FIELDS.split("files(", 1)[1].rstrip(")"),
                                 "supportsAllDrives": "true"})


async def file_content(file_id: str, export_mime: str | None = None, account: str | None = None) -> bytes:
    path = f"/files/{_id(file_id)}"
    params = {"mimeType": export_mime} if export_mime else {"alt": "media", "supportsAllDrives": "true"}
    if export_mime:
        path += "/export"
    content = await _scoped(account, "drive", "GET", path, params=params, raw=True)
    if not isinstance(content, bytes):
        raise GoogleError("Google returned no file content", 502)
    if len(content) > MAX_DOWNLOAD:
        raise GoogleError("This file is larger than Kairos's 25 MB download limit", 413)
    return content


async def drive_storage(account: str | None = None) -> dict:
    return await _scoped(account, "drive", "GET", "/about", params={"fields": "storageQuota"})


def image_mime(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if content.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "image/webp"
    raise GoogleError("This image format cannot be previewed safely", 415)


async def file_thumbnail(file_id: str, account: str | None = None) -> tuple[bytes, str]:
    info = await file_info(file_id, account)
    url = urlsplit(info.get("thumbnailLink") or "")
    if (url.scheme != "https" or url.netloc != "lh3.googleusercontent.com"
            or url.username or url.password or url.fragment):
        raise GoogleError("No supported Google thumbnail for this file", 404)
    content = await _scoped(account, "thumbnail", "GET", url.path, params=dict(parse_qsl(url.query)), raw=True)
    if not isinstance(content, bytes) or len(content) > MAX_DOWNLOAD:
        raise GoogleError("Thumbnail exceeds the 25 MB download limit", 413)
    return content, image_mime(content)


async def file_preview(file_id: str, account: str | None = None) -> tuple[bytes, str]:
    info = await file_info(file_id, account)
    mime = info.get("mimeType") or ""
    if int(info.get("size") or 0) > MAX_DOWNLOAD:
        raise GoogleError("This file is larger than Kairos's 25 MB download limit", 413)
    if mime == "application/vnd.google-apps.document":
        from core.google_preview import sanitize_html
        content = await file_content(file_id, "text/html", account)
        return sanitize_html(content.decode("utf-8", errors="replace")).encode("utf-8"), "text/html"
    if mime == "application/vnd.google-apps.presentation":
        return await file_content(file_id, "application/pdf", account), "application/pdf"
    if mime == "application/pdf":
        return await file_content(file_id, account=account), mime
    if mime.startswith("image/"):
        content = await file_content(file_id, account=account)
        return content, image_mime(content)
    extension = os.path.splitext(info.get("name") or "")[1].lower()
    if (mime.startswith("text/") or mime in ("application/json", "application/javascript", "application/xml")
            or extension in (".txt", ".md", ".py", ".js", ".ts", ".json", ".yaml", ".yml", ".css", ".html", ".xml", ".csv", ".sql", ".sh", ".c", ".cpp", ".java", ".rs")):
        return await file_content(file_id, account=account), "text/plain"
    raise GoogleError("Preview unavailable for this type; download or open in Google", 415)


async def drive_action(action: str, *, file_id: str | None = None, name: str | None = None,
                       parent: str | None = None, permission_id: str | None = None,
                       email: str | None = None, role: str | None = None,
                       permission_type: str | None = None, domain: str | None = None,
                       account: str | None = None) -> dict:
    if action == "create_folder":
        return await _scoped(account, "drive", "POST", "/files", params={"fields": "id,name,mimeType,webViewLink"},
                             body={"name": (name or "New folder")[:200], "mimeType": "application/vnd.google-apps.folder",
                                   **({"parents": [_id(parent)]} if parent else {})})
    ident = _id(file_id or "")
    path = f"/files/{ident}"
    common = {"supportsAllDrives": "true", "fields": "id,name,mimeType,parents,trashed,starred,webViewLink"}
    if action == "rename":
        if not name or len(name) > 255:
            raise GoogleError("Enter a file name under 256 characters")
        return await _scoped(account, "drive", "PATCH", path, params=common, body={"name": name})
    if action == "move":
        if not parent:
            raise GoogleError("Choose a destination folder")
        info = await file_info(ident, account)
        return await _scoped(account, "drive", "PATCH", path,
                             params={**common, "addParents": _id(parent),
                                     "removeParents": ",".join(info.get("parents") or [])}, body={})
    if action == "copy":
        return await _scoped(account, "drive", "POST", path + "/copy", params=common,
                             body={**({"name": name[:255]} if name else {}),
                                   **({"parents": [_id(parent)]} if parent else {})})
    if action in ("trash", "restore"):
        return await _scoped(account, "drive", "PATCH", path, params=common, body={"trashed": action == "trash"})
    if action == "star":
        return await _scoped(account, "drive", "PATCH", path, params=common, body={"starred": True})
    if action == "unstar":
        return await _scoped(account, "drive", "PATCH", path, params=common, body={"starred": False})
    if action == "delete":
        await _scoped(account, "drive", "DELETE", path, params={"supportsAllDrives": "true"})
        return {"deleted": True}
    if action == "permissions":
        return await _scoped(account, "drive", "GET", path + "/permissions",
                             params={"supportsAllDrives": "true", "fields": "permissions(id,type,role,emailAddress,displayName,domain),nextPageToken"})
    if action == "share":
        kind = permission_type or "user"
        if kind not in ("user", "group", "domain", "anyone") or role not in ("reader", "commenter", "writer"):
            raise GoogleError("Choose a sharing type and reader, commenter, or writer access")
        if kind in ("user", "group") and (not email or "@" not in email or len(email) > 254):
            raise GoogleError("Enter a valid email address")
        if kind == "domain" and (not domain or len(domain) > 253 or not re.fullmatch(r"[A-Za-z0-9.-]+", domain)):
            raise GoogleError("Enter a valid domain")
        permission = {"type": kind, "role": role}
        if kind in ("user", "group"):
            permission["emailAddress"] = email
        elif kind == "domain":
            permission["domain"] = domain
        return await _scoped(account, "drive", "POST", path + "/permissions",
                             params={"supportsAllDrives": "true", "sendNotificationEmail": "true" if kind in ("user", "group") else "false",
                                     "fields": "id,type,role,emailAddress,domain"}, body=permission)
    if action == "update_permission":
        if role not in ("reader", "commenter", "writer"):
            raise GoogleError("Choose reader, commenter, or writer access")
        return await _scoped(account, "drive", "PATCH", path + f"/permissions/{_id(permission_id or '')}",
                             params={"supportsAllDrives": "true", "fields": "id,type,role,emailAddress,domain"},
                             body={"role": role})
    if action == "revoke":
        await _scoped(account, "drive", "DELETE", path + f"/permissions/{_id(permission_id or '')}",
                      params={"supportsAllDrives": "true"})
        return {"revoked": True}
    if action == "revisions":
        return await _scoped(account, "drive", "GET", path + "/revisions",
                             params={"fields": "revisions(id,modifiedTime,keepForever,lastModifyingUser,originalFilename),nextPageToken"})
    raise GoogleError("Unknown Drive action")


async def upload_file(name: str, data: bytes, mime_type: str, parent: str | None = None,
                      account: str | None = None) -> dict:
    if not name or len(data) > MAX_DOWNLOAD:
        raise GoogleError("Choose a file under 25 MB", 413)
    boundary = "jarvis_" + secrets.token_hex(16)
    metadata = {"name": name[:255], **({"parents": [_id(parent)]} if parent else {})}
    payload = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"
               + json.dumps(metadata) + f"\r\n--{boundary}\r\nContent-Type: {mime_type or 'application/octet-stream'}\r\n\r\n").encode("utf-8")
    payload += data + f"\r\n--{boundary}--\r\n".encode("ascii")
    return await _scoped(account, "upload", "POST", "/files", params={"uploadType": "multipart", "fields": "id,name,mimeType,webViewLink"},
                         content=payload, content_type=f"multipart/related; boundary={boundary}")


async def sheet_get(file_id: str, cell_range: str | None = None, account: str | None = None) -> dict:
    ident = _id(file_id)
    if cell_range:
        return await _scoped(account, "sheets", "GET", f"/spreadsheets/{ident}/values/{quote(cell_range, safe='!:$')}" ,
                             params={"valueRenderOption": "FORMATTED_VALUE"})
    return await _scoped(account, "sheets", "GET", f"/spreadsheets/{ident}",
                         params={"fields": "spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title,index,gridProperties))"})


async def sheet_action(action: str, *, file_id: str | None = None, title: str | None = None,
                       cell_range: str | None = None, values: list | None = None,
                       requests: list | None = None, account: str | None = None) -> dict:
    if action == "create":
        return await _scoped(account, "sheets", "POST", "/spreadsheets", body={"properties": {"title": title or "Untitled spreadsheet"}})
    ident = _id(file_id or "")
    if action == "batch":
        if not isinstance(requests, list) or len(requests) > 50:
            raise GoogleError("Provide at most 50 spreadsheet changes")
        return await _scoped(account, "sheets", "POST", f"/spreadsheets/{ident}:batchUpdate", body={"requests": requests})
    if not cell_range or len(cell_range) > 300:
        raise GoogleError("Choose a cell range")
    path = f"/spreadsheets/{ident}/values/{quote(cell_range, safe='!:$')}"
    if action == "clear":
        return await _scoped(account, "sheets", "POST", path + ":clear", body={})
    if not isinstance(values, list) or len(values) > 1000:
        raise GoogleError("Provide at most 1,000 rows")
    if action == "update":
        return await _scoped(account, "sheets", "PUT", path, params={"valueInputOption": "USER_ENTERED"},
                             body={"range": cell_range, "majorDimension": "ROWS", "values": values})
    if action == "append":
        return await _scoped(account, "sheets", "POST", path + ":append",
                             params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
                             body={"values": values})
    raise GoogleError("Unknown Sheets action")


async def form_get(file_id: str, responses: bool = False, page_token: str | None = None,
                   account: str | None = None) -> dict:
    path = f"/forms/{_id(file_id)}" + ("/responses" if responses else "")
    return await _scoped(account, "forms", "GET", path, params={"pageSize": 100, **({"pageToken": page_token} if page_token else {})} if responses else None)


async def form_action(action: str, *, file_id: str | None = None, title: str | None = None,
                      requests: list | None = None, published: bool | None = None,
                      account: str | None = None) -> dict:
    if action == "create":
        if not title:
            raise GoogleError("Enter a form title")
        return await _scoped(account, "forms", "POST", "/forms", body={"info": {"title": title[:200]}})
    ident = _id(file_id or "")
    if action == "batch":
        if not isinstance(requests, list) or len(requests) > 50:
            raise GoogleError("Provide at most 50 form changes")
        return await _scoped(account, "forms", "POST", f"/forms/{ident}:batchUpdate", body={"requests": requests})
    if action == "publish":
        if published is None:
            raise GoogleError("Choose a published state")
        return await _scoped(account, "forms", "POST", f"/forms/{ident}:setPublishSettings",
                             body={"publishSettings": {"publishState": {
                                 "isPublished": published, "isAcceptingResponses": published}},
                                   "updateMask": "publishState"})
    raise GoogleError("Unknown Forms action")


def invalidate_calendar() -> None:
    global _calendar_generation
    _calendar_generation += 1
    _calendar_cache.clear()
    _calendar_list_cache.clear()


def _calendar_access() -> None:
    account = _calendar_account()
    if not account.get("refresh_token") or CALENDAR_SCOPE not in (account.get("granted_scopes") or []):
        raise GoogleError("Reconnect to add Calendar", 409)


def _valid_calendar_id(value) -> bool:
    # Google's own calendars use "#" (holidays, birthdays: en.usa#holiday@group.v.calendar.google.com).
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9_.@+#-]{1,256}", value)) and ".." not in value


def _calendar_id(value: str) -> str:
    if not _valid_calendar_id(value):
        raise GoogleError("Invalid Google calendar ID")
    return quote(value, safe="")


def calendar_settings(calendar_ids: list[str]) -> dict:
    _calendar_access()
    for ident in calendar_ids:
        _calendar_id(ident)
    chosen = list(dict.fromkeys(calendar_ids))
    _mark(_calendar_account()["id"], calendar_ids=chosen)
    invalidate_calendar()
    return {"calendar_ids": chosen}


async def calendar_list() -> list[dict]:
    """The account's calendars from Google, kept for _cached_calendar_list; offline, the last ones fetched."""
    _calendar_access()
    account = _calendar_account().get("id")
    generation = _calendar_generation
    try:
        calendars = await _fetch_calendar_list()
    except GoogleOffline:
        cached = _calendar_list_cache.get(account)
        if cached:
            return deepcopy(cached[1])
        raise
    if generation == _calendar_generation:
        _calendar_list_cache[account] = (time.monotonic(), deepcopy(calendars))
    return calendars


async def _fetch_calendar_list() -> list[dict]:
    calendars, page = [], None
    while True:
        result = await request("calendar", "GET", "/users/me/calendarList",
                               params={"maxResults": 250, **({"pageToken": page} if page else {})})
        for item in result.get("items", []):
            if item.get("deleted"):
                continue
            calendars.append({"id": item["id"], "name": item.get("summaryOverride") or item.get("summary") or item["id"],
                              "color": item.get("backgroundColor"), "primary": bool(item.get("primary")),
                              "time_zone": item.get("timeZone") or "UTC", "access_role": item.get("accessRole"),
                              "selected": not item.get("hidden", False) and item.get("selected", True)})
        page = result.get("nextPageToken")
        if not page:
            return calendars


async def _cached_calendar_list() -> list[dict]:
    """calendar_list() shared by one event fetch and its cache window, so an
    uncached range reads Google's calendarList once and a cached one never."""
    account = _calendar_account().get("id")
    cached = _calendar_list_cache.get(account)
    if cached and time.monotonic() - cached[0] < 60:
        return deepcopy(cached[1])
    return await calendar_list()  # refreshes the cache, or answers from it while Google can't be reached


def _timed(value: str, zone: str = "UTC") -> str:
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=ZoneInfo(zone))
        return stamp.isoformat()
    except (ValueError, ZoneInfoNotFoundError) as problem:
        raise GoogleError("Enter an ISO date/time and a valid time zone") from problem


def _map_calendar_event(item: dict, calendar: dict) -> dict:
    start, end = item.get("start", {}), item.get("end", {})
    all_day = "date" in start
    zone = start.get("timeZone") or calendar.get("time_zone") or "UTC"
    repeat = repeats.parse_google_rule(item.get("recurrence"), start.get("date") if all_day else start.get("dateTime"), zone, all_day)
    return {"id": item["id"], "title": item.get("summary") or "Untitled event",
            "start": start.get("date") if all_day else _timed(start.get("dateTime") or "", zone),
            "end": end.get("date") if all_day else _timed(end.get("dateTime") or start.get("dateTime") or "", end.get("timeZone") or zone),
            "all_day": all_day, "time_zone": zone, "location": item.get("location") or "",
            "description": item.get("description") or "", "source": "google",
            "calendar_id": calendar["id"], "calendar_color": calendar.get("color"),
            "calendar_name": calendar.get("name"), "editable": calendar.get("access_role") in ("owner", "writer"),
            "web_link": item.get("htmlLink"), "series_id": item.get("recurringEventId"),
            "original_start": item.get("originalStartTime"), "recurrence": repeat if repeat is not False else None,
            "recurrence_supported": repeat is not False, "recurrence_raw": item.get("recurrence") or [],
            "guests": sum(1 for guest in item.get("attendees", [])
                          if not guest.get("self") and not guest.get("resource") and guest.get("responseStatus") != "declined"),
            "meeting_url": next((entry.get("uri") for entry in (item.get("conferenceData") or {}).get("entryPoints", [])
                                 if entry.get("entryPointType") == "video" and entry.get("uri")), None) or item.get("hangoutLink")}


async def calendar_event(calendar_id: str, event_id: str) -> dict:
    """Read the actual series master for the all-events editor."""
    _calendar_access()
    path = f"/calendars/{_calendar_id(calendar_id)}/events/{_id(event_id)}"
    calendars = await calendar_list()
    calendar = next((c for c in calendars if c["id"] == calendar_id or (calendar_id == "primary" and c["primary"])), None)
    if calendar is None:
        raise GoogleError("Google calendar no longer available", 404)
    return _map_calendar_event(await request("calendar", "GET", path), calendar)


def calendar_event_time(item: dict) -> float:
    return datetime.fromisoformat(_timed(item["start"], item.get("time_zone") or "UTC")).timestamp()


async def calendar_events(calendar_ids: list[str], start: str, end: str) -> list[dict]:
    _calendar_access()
    start, end = _timed(start), _timed(end)
    if datetime.fromisoformat(start) >= datetime.fromisoformat(end):
        raise GoogleError("The range must end after it starts")
    ids = tuple(sorted(set(calendar_ids)))
    for ident in ids:
        _calendar_id(ident)
    key = (_calendar_account().get("id"), ids, start, end)
    cached = _calendar_cache.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        return deepcopy(cached[1])
    if not ids:
        return []
    try:
        return await _fetch_calendar_events(key, ids, start, end)
    except GoogleOffline:
        if cached:  # what was last fetched for this range stays on screen until Google answers again
            return deepcopy(cached[1])
        raise


async def _fetch_calendar_events(key: tuple, ids: tuple, start: str, end: str) -> list[dict]:
    generation = _calendar_generation
    calendars = {c["id"]: c for c in await _cached_calendar_list()}
    events = []
    for ident in ids:
        calendar = calendars.get(ident)
        if ident == "primary":
            calendar = next((c for c in calendars.values() if c["primary"]), None)
        if not calendar:
            raise GoogleError("Google calendar no longer available", 404)
        page = None
        while True:
            result = await request("calendar", "GET", f"/calendars/{_calendar_id(ident)}/events",
                                   params={"timeMin": start, "timeMax": end, "singleEvents": "true",
                                           "orderBy": "startTime", "maxResults": 2500,
                                           **({"pageToken": page} if page else {})})
            events.extend(_map_calendar_event(item, calendar) for item in result.get("items", [])
                          if item.get("status") != "cancelled" and item.get("start"))
            if len(events) > repeats.MAX_OCCURRENCES:
                raise GoogleError("Too many Google Calendar events in this range. Choose a shorter range.")
            page = result.get("nextPageToken")
            if not page:
                break
    events.sort(key=calendar_event_time)
    # A response started before a write must not refill the cache afterwards.
    if generation == _calendar_generation:
        if len(_calendar_cache) >= 64:
            _calendar_cache.clear()
        _calendar_cache[key] = (time.monotonic(), deepcopy(events))
    return events


async def selected_calendar_events(start: str, end: str) -> list[dict]:
    if not status()["calendar_connected"]:
        return []
    ids = _calendar_account().get("calendar_ids")
    if ids is None:
        # A calendar Google lists with an ID we cannot use is skipped, not allowed to hide every other calendar.
        ids = [c["id"] for c in await _cached_calendar_list() if c["selected"] and _valid_calendar_id(c["id"])]
    return await calendar_events(ids, start, end)


async def calendar_action(action: str, *, calendar_id: str = "primary", event_id: str | None = None,
                          event: dict | None = None, text: str | None = None) -> dict:
    _calendar_access()
    path = f"/calendars/{_calendar_id(calendar_id)}/events"
    if action not in ("create", "update", "delete", "quick_add"):
        raise GoogleError("Unknown Google Calendar action")
    if action in ("update", "delete"):
        path += "/" + _id(event_id or "")
    body = None
    params = None
    if action == "quick_add":
        if not text or not text.strip() or len(text) > 2000:
            raise GoogleError("Enter an event description under 2001 characters")
        path += "/quickAdd"
        params = {"text": text}
    elif action != "delete":
        fields = event or {}
        body = {k: v for k, v in fields.items() if k in ("summary", "description", "location", "start", "end")}
        if action == "create" and not all(body.get(k) for k in ("summary", "start", "end")):
            raise GoogleError("An event needs a title, start and end")
        for key in ("start", "end"):
            if key not in body:
                continue
            value = body[key]
            if not isinstance(value, dict) or ("date" in value) == ("dateTime" in value):
                raise GoogleError("Use either date or dateTime for an event boundary")
            if "date" in value:
                try:
                    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["date"]):
                        raise ValueError()
                    datetime.strptime(value["date"], "%Y-%m-%d")
                except (ValueError, TypeError) as problem:
                    raise GoogleError("Enter an all-day date as YYYY-MM-DD") from problem
                body[key] = {"date": value["date"]}
            else:
                body[key] = {"dateTime": _timed(value.get("dateTime") or "", value.get("timeZone") or "UTC")}
                if value.get("timeZone"):
                    body[key]["timeZone"] = value["timeZone"]
        if "start" in body and "end" in body:
            date_only = "date" in body["start"]
            if date_only != ("date" in body["end"]):
                raise GoogleError("Start and end must both be all-day or timed")
            key = "date" if date_only else "dateTime"
            if datetime.fromisoformat(body["start"][key]) >= datetime.fromisoformat(body["end"][key]):
                raise GoogleError("The event must end after it starts; all-day end dates are exclusive")
        if "repeat" in fields:
            try:
                if not all(body.get(k) for k in ("start", "end")):
                    raise ValueError("Changing a repeat rule needs start and end")
                all_day = "date" in body["start"]
                time_zone = body["start"].get("timeZone") or "UTC"
                repeats.zone(time_zone)
                if fields["repeat"] and not all_day and not body["start"].get("timeZone"):
                    raise ValueError("A timed repeat needs an IANA time zone")
                body["recurrence"] = repeats.google_rule(fields["repeat"],
                    body["start"].get("date") if all_day else body["start"]["dateTime"], time_zone, all_day)
            except (ValueError, TypeError) as exc:
                raise GoogleError(str(exc)) from exc
    method = {"create": "POST", "update": "PATCH", "delete": "DELETE", "quick_add": "POST"}[action]
    result = await request("calendar", method, path, body=body, params=params)
    invalidate_calendar()
    return result if isinstance(result, dict) else {"deleted": True}


async def send_gmail(account: str, to: list[str], subject: str, body: str,
                     cc: list[str] | None = None, in_reply_to: str | None = None, user: str | None = None) -> dict:
    """Send one plain-text message as the given connected Google account."""
    data = _state()
    ident = resolve_account(user, account)
    record = data["accounts"][ident]
    if GMAIL_SEND_SCOPE not in (record.get("granted_scopes") or []):
        raise GoogleError(f"Reconnect {record.get('email') or 'this account'} in Library to allow sending email", 409)
    message = EmailMessage()
    message["From"] = record.get("email") or ""
    message["To"] = ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    message["Subject"] = subject
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = in_reply_to
    message.set_content(body)
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")
    result = await request("gmail", "POST", "/users/me/messages/send", body={"raw": raw}, account=ident)
    return {"id": result.get("id"), "thread_id": result.get("threadId"), "from": record.get("email")}
