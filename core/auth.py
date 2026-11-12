"""Auth: single-user-by-default with a real login/session model when enabled,
matching Odysseus's own approach (see Kairos Plan's v2 scoping — "match what
Odysseus uses" for auth was David's explicit call, 2026-08-31).

- AUTH_ENABLED=false (default): single trusted local user, no login screen —
  the sane default for the Electron desktop app running on one person's
  machine. Every request resolves to the one local user.
- AUTH_ENABLED=true: real accounts. bcrypt password hashes, session cookies,
  optional per-user TOTP 2FA, admin/non-admin privilege split. This is the
  mode the plain-web access path ("front door #2") should run in for anyone
  exposing the backend beyond localhost.

Reserved usernames ("internal-tool", "api") can never be registered. Codex's
tool calls carry their own per-turn token instead (core/tool_access.py); the
process-wide internal token that once impersonated "internal-tool" was
removed in roadmap phase 2 (2026-10-05).
"""
import os
import hashlib
import re
import secrets
import threading
import time
from typing import Optional

import bcrypt
import pyotp

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

AUTH_FILE = os.path.join(DATA_DIR, "auth.json")
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
PASSWORD_RESETS_FILE = os.path.join(DATA_DIR, "password_resets.json")

SESSION_COOKIE_NAME = "jarvis_session"
SESSION_TTL_SECONDS = 7 * 24 * 60 * 60  # 7 days, matches Odysseus

# The account switcher (David's ask 2026-11-11, like Google's): each person signs in once on a device, and the
# device remembers that sign-in so switching back is one click. The device holds one secret, in DEVICE_COOKIE_NAME;
# the server keeps a "remembered" row per account signed in on that device, bound to the secret's hash. A
# remembered row is not a session and its id never leaves the server. Only POST /api/auth/switch opens a session
# from it, after the account's switching PIN when it has one.
#
# The device cookie is a bearer secret, exactly like the session cookie: whoever holds a copy holds that device's
# accounts. It is httponly and samesite=lax, and it is narrowed three ways (review 2026-11-11):
# - it is rotated on every sign-in, switch and sign-out, so a copy goes dead the next time the device switches;
# - a remembered row ends when its password sign-in's session would (SESSION_TTL_SECONDS); after that it only
#   shows as "sign in again" and can open nothing;
# - signing an account out of a device, changing its password, an admin reset or deleting it revoke its rows.
# Switches are serialized (one lock) and each closes every live session the device holds, not only the one sent.
DEVICE_COOKIE_NAME = "kairos_device"
# The first switcher build (an hour on local dev, 2026-11-11) kept one token per account here; still read once.
ACCOUNTS_COOKIE_NAME = "kairos_accounts"
MAX_DEVICE_ACCOUNTS = 9
# An expired remembered sign-in still shows on the switcher (as "sign in again") for this long.
REMEMBER_SHOWN_AFTER_EXPIRY_SECONDS = 30 * 24 * 60 * 60
_TOKEN_SHAPE = re.compile(r"^[A-Za-z0-9_-]{20,64}$")

# A switching PIN (4 to 8 digits, per account, optional): wrong tries are limited. PIN_TRIES_PER_LOCK wrong tries
# in a row lock switching into that account for PIN_LOCK_SECONDS; PIN_FORGET_AFTER wrong tries in a row drop the
# device's remembered sign-in, so only the password gets back in.
PIN_SHAPE = re.compile(r"^[0-9]{4,8}$")
PIN_TRIES_PER_LOCK = 5
PIN_LOCK_SECONDS = 60
PIN_FORGET_AFTER = 10

# Each account's colour, on its avatar ring, the switcher and the app's top edge. Names, not colours: the colours
# themselves are theme tokens (static/css/kairos-theme.css, --acct-<name>), so the CSS never holds raw values.
ACCOUNT_COLORS = ("teal", "blue", "plum", "red", "amber", "green", "slate", "orange")

# Forgot-password (David's ask 2026-09-10): a 6-digit code emailed through
# whichever configured Email-tab account matches the address the user typed
# in, since there's no per-user email field to check against instead. Short
# TTL and a request cooldown, matching TOTP-code UX rather than a long-lived
# magic link.
RESET_CODE_TTL_SECONDS = 15 * 60
RESET_REQUEST_COOLDOWN_SECONDS = 60
RESET_MAX_ATTEMPTS = 5

RESERVED_USERNAMES = {"internal-tool", "api"}

SINGLE_USER = "local"

# With accounts off, every local request used to count as the one admin user,
# so any process on the machine - an agent's shell included, whose sandbox
# limits file writes but not loopback HTTP - could export the backup or wipe
# data through the API (reproduced 2026-09-22). When Electron starts the
# backend it now passes a per-launch secret and gives its own windows a cookie
# holding it; with accounts off, only requests carrying that cookie are the
# local user (core/middleware.py). Taken out of the environment at import,
# before anything starts a child process, so no agent inherits it. A backend
# started without it (a dev server) stays open as before.
UI_COOKIE_NAME = "jarvis_ui"
UI_CODE_TTL_SECONDS = 60


def _take_ui_secret(environ=os.environ) -> Optional[str]:
    return environ.pop("JARVIS_UI_SECRET", None) or None


UI_SECRET = _take_ui_secret()

# One-time codes that hand the cookie to the person's own browser (the tray's
# "Open in browser"): minted only by a request that already holds the cookie,
# single use, and short-lived.
_ui_codes: dict[str, float] = {}


def mint_ui_code() -> str:
    now = time.time()
    for stale in [c for c, expires in _ui_codes.items() if expires < now]:
        _ui_codes.pop(stale, None)
    code = secrets.token_urlsafe(24)
    _ui_codes[code] = now + UI_CODE_TTL_SECONDS
    return code


def redeem_ui_code(code: str) -> bool:
    expires = _ui_codes.pop(code, None) if code else None
    return expires is not None and expires >= time.time()


def owner_or_default(owner: Optional[str]) -> Optional[str]:
    """Who a record belongs to when it names no owner (a chat made before accounts, or through a channel).
    With accounts off every request is the single local user, so it is theirs; with accounts on it is the only
    account's, or no one's when there are several, so one person's old records never show to another."""
    if owner:
        return owner
    if not auth_enabled():
        return SINGLE_USER
    return auth_manager.sole_user() or (SINGLE_USER if not auth_manager.has_any_users() else None)


def auth_enabled() -> bool:
    """True if EITHER the AUTH_ENABLED env var or the persisted setting says
    so. Two sources because they serve different deployments: the env var is
    how scripted/server runs force auth on (scripts/run_remote.py), while the
    setting is how a user turns on accounts from the desktop UI — a packaged
    app gives them nowhere to set an env var.

    Deliberately OR, never AND: neither source can switch auth off when the
    other has turned it on. Turning on remote access (core/remote_access.py)
    sets the persisted flag, so exposing the app to a network can never
    silently leave it running with the single-trusted-local-user bypass.

    Imported lazily to avoid a circular import — core.settings reads
    core.constants, and this module is imported by middleware that settings
    routes depend on."""
    if os.getenv("AUTH_ENABLED", "false").lower() in {"1", "true", "yes"}:
        return True
    try:
        from core import settings as settings_store
        return bool(settings_store.get_setting("auth_enabled"))
    except Exception:
        return False


# Called with the tokens of sessions that just ended (sign-out, switch, password change, expiry, deleted account):
# core/middleware.py closes the websockets and streams opened with them.
revoke_listeners: list = []

# Called with a user name when its password changes (by the person, an admin or a reset code) or the account is
# deleted: every other kind of sign-in that hangs off the account ends too (paired phones, core/phone_devices.py).
credential_listeners: list = []


def _credentials_changed(username: str) -> None:
    for listener in list(credential_listeners):
        try:
            listener(username)
        except Exception:
            pass


# What a wrong user name is checked against, so "no such user" takes as long as "wrong password" (a sign-in that
# answers faster for unknown names tells a caller which names exist). Made once, on first use.
_absent_user_hash: Optional[bytes] = None


def _spend_a_password_check(password: str) -> None:
    global _absent_user_hash
    if _absent_user_hash is None:
        _absent_user_hash = bcrypt.hashpw(secrets.token_urlsafe(16).encode("utf-8"), bcrypt.gensalt())
    try:
        bcrypt.checkpw(password.encode("utf-8"), _absent_user_hash)
    except ValueError:
        pass


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class AuthManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._users: dict = read_json(AUTH_FILE, {"users": {}})
        self._sessions: dict = read_json(SESSIONS_FILE, {})
        self._resets: dict = read_json(PASSWORD_RESETS_FILE, {})

    # -- users --------------------------------------------------------

    def has_any_users(self) -> bool:
        return bool(self._users.get("users"))

    def sole_user(self) -> Optional[str]:
        """The only account, when there is exactly one. An ownerless chat or
        routine (made before ownership, or through a channel) is then that
        person's: there is no other user whose records it could expose."""
        users = list(self._users.get("users") or {})
        return users[0] if len(users) == 1 else None

    def create_user(self, username: str, password: str, is_admin: bool = False) -> None:
        if username in RESERVED_USERNAMES:
            raise ValueError(f"'{username}' is a reserved username")
        if username in self._users["users"]:
            raise ValueError(f"user '{username}' already exists")
        password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        account_id = self._new_account_id(first=not self._users["users"])
        self._users["users"][username] = {
            "password_hash": password_hash,
            "is_admin": is_admin,
            "totp_secret": None,
            "totp_enabled": False,
            "created_at": time.time(),
            "account_id": account_id,
            "machine_access": bool(is_admin),
            "color": self._next_color(),
        }
        write_json_atomic(AUTH_FILE, self._users)

    # -- account colour (the switcher) -----------------------------------

    def _next_color(self) -> str:
        """The least used colour of the palette, earliest first on a tie, so the first eight accounts all differ."""
        used = [u.get("color") for u in self._users["users"].values()]
        return min(ACCOUNT_COLORS, key=lambda c: (used.count(c), ACCOUNT_COLORS.index(c)))

    def account_color(self, username: str) -> Optional[str]:
        """An account's colour; accounts made before colours get theirs the first time it is asked for."""
        user = self._users["users"].get(username)
        if not user:
            return None
        if user.get("color") not in ACCOUNT_COLORS:
            user["color"] = self._next_color()
            write_json_atomic(AUTH_FILE, self._users)
        return user["color"]

    def set_account_color(self, username: str, color: str) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        if color not in ACCOUNT_COLORS:
            raise ValueError("pick one of the account colours")
        user["color"] = color
        write_json_atomic(AUTH_FILE, self._users)

    # -- switching PIN (optional, per account) ---------------------------

    def has_switch_pin(self, username: str) -> bool:
        user = self._users["users"].get(username)
        return bool(user and user.get("switch_pin_hash"))

    def set_switch_pin(self, username: str, pin: Optional[str]) -> None:
        """Sets (4 to 8 digits) or clears (None) the PIN asked when switching into this account on a device."""
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        if pin is None:
            user.pop("switch_pin_hash", None)
        else:
            if not PIN_SHAPE.match(pin):
                raise ValueError("Use 4 to 8 digits.")
            user["switch_pin_hash"] = bcrypt.hashpw(pin.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        user.pop("pin_failures", None)
        user.pop("pin_locked_until", None)
        write_json_atomic(AUTH_FILE, self._users)

    def check_switch_pin(self, username: str, pin: Optional[str]) -> dict:
        """One try at an account's PIN. Answers {"ok": True}, or {"ok": False, "reason": ...} where reason is
        "required" (no PIN given), "wrong" (with "tries_left" before the next lock), "locked" (with
        "retry_after" seconds; the try was not even checked) or "forget" (too many wrong tries: the caller drops
        the device's remembered sign-in, so only the password gets back in). Wrong tries are counted on the
        account, so they add up across devices and restarts."""
        user = self._users["users"].get(username)
        if not user or not user.get("switch_pin_hash"):
            return {"ok": True}
        now = time.time()
        locked_until = user.get("pin_locked_until") or 0
        if locked_until > now:
            return {"ok": False, "reason": "locked", "retry_after": int(locked_until - now) + 1}
        if not pin:
            return {"ok": False, "reason": "required"}
        if PIN_SHAPE.match(pin) and bcrypt.checkpw(pin.encode("utf-8"), user["switch_pin_hash"].encode("utf-8")):
            if user.get("pin_failures") or user.get("pin_locked_until"):
                user.pop("pin_failures", None)
                user.pop("pin_locked_until", None)
                write_json_atomic(AUTH_FILE, self._users)
            return {"ok": True}
        failures = int(user.get("pin_failures") or 0) + 1
        if failures >= PIN_FORGET_AFTER:
            user.pop("pin_failures", None)
            user.pop("pin_locked_until", None)
            write_json_atomic(AUTH_FILE, self._users)
            return {"ok": False, "reason": "forget"}
        user["pin_failures"] = failures
        if failures % PIN_TRIES_PER_LOCK == 0:
            wait = PIN_LOCK_SECONDS
            user["pin_locked_until"] = now + wait
            write_json_atomic(AUTH_FILE, self._users)
            return {"ok": False, "reason": "locked", "retry_after": wait}
        write_json_atomic(AUTH_FILE, self._users)
        return {"ok": False, "reason": "wrong", "tries_left": PIN_TRIES_PER_LOCK - failures % PIN_TRIES_PER_LOCK}

    # -- account folders (core/accounts.py, Multi-Account phase 1) ----

    def _new_account_id(self, first: bool) -> str:
        """A folder id for a new account: random, so it is safe on every file system and two names that
        differ only by letter case never share a folder. The first account on an install that so far had
        none takes over the "local" folder the single local user worked in, so nothing has to move."""
        from core.accounts import ACCOUNTS_DIR, LOCAL_ID
        taken = {u.get("account_id") for u in self._users["users"].values()}
        if first and LOCAL_ID not in taken and os.path.isdir(os.path.join(ACCOUNTS_DIR, LOCAL_ID)):
            return LOCAL_ID
        while True:
            candidate = secrets.token_hex(6)
            if candidate not in taken and candidate != LOCAL_ID:
                return candidate

    def account_id(self, username: str) -> Optional[str]:
        """The folder id of an account, or None if there is no such account. Accounts made before folders
        get theirs the first time they are asked for."""
        user = self._users["users"].get(username)
        if not user:
            return None
        if not user.get("account_id"):
            user["account_id"] = self._new_account_id(first=len(self._users["users"]) == 1)
            write_json_atomic(AUTH_FILE, self._users)
        return user["account_id"]

    def username_for_account(self, account_id: str) -> Optional[str]:
        """The user name of an account folder id, or None (the shared "local" folder has no user)."""
        return next((name for name, info in self._users["users"].items() if info.get("account_id") == account_id), None)

    def account_ids(self) -> list[str]:
        return [self.account_id(name) for name in list(self._users["users"])]

    def first_admin_account(self) -> Optional[str]:
        """The account the single local user works in when accounts are off: the earliest admin's."""
        admins = sorted((info.get("created_at") or 0, name) for name, info in self._users["users"].items()
                        if info.get("is_admin"))
        return self.account_id(admins[0][1]) if admins else None

    def verify_password(self, username: str, password: str) -> bool:
        user = self._users["users"].get(username)
        if not user:
            _spend_a_password_check(password)
            return False
        return bcrypt.checkpw(password.encode("utf-8"), user["password_hash"].encode("utf-8"))

    def is_admin(self, username: str) -> bool:
        if username == SINGLE_USER:
            return True
        user = self._users["users"].get(username)
        return bool(user and user.get("is_admin"))

    def has_machine_access(self, username: str) -> bool:
        """Whether this user's chats and bots may use this computer's shell and files. Admins always do (computed,
        whatever the stored flag says); everyone else only when an admin granted it. The single local user is
        the owner of the machine."""
        if username == SINGLE_USER:
            return True
        user = self._users["users"].get(username)
        if not user:
            return False
        return bool(user.get("is_admin") or user.get("machine_access"))

    def set_machine_access(self, username: str, enabled: bool) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        if user.get("is_admin"):
            raise ValueError("admins always have machine access")
        user["machine_access"] = bool(enabled)
        write_json_atomic(AUTH_FILE, self._users)

    # -- account/user management (Settings tab, David's ask 2026-08-31,
    # matching Odysseus's Account + Admin > Users panels) -----------------

    def list_users(self) -> list[dict]:
        return [
            {"username": u, "is_admin": info.get("is_admin", False), "totp_enabled": info.get("totp_enabled", False), "created_at": info.get("created_at"),
             "machine_access": self.has_machine_access(u)}
            for u, info in self._users["users"].items()
        ]

    def change_password(self, username: str, new_password: str) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        user["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        write_json_atomic(AUTH_FILE, self._users)
        _credentials_changed(username)

    def drop_sessions(self, username: str) -> None:
        """End every open session for one account (after an admin resets its password)."""
        self._drop([t for t, s in self._sessions.items() if s.get("username") == username])

    def set_admin(self, username: str, is_admin: bool) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        if not is_admin and self._count_admins() <= 1 and user.get("is_admin"):
            raise ValueError("can't demote the last admin")
        user["is_admin"] = is_admin
        write_json_atomic(AUTH_FILE, self._users)

    def _count_admins(self) -> int:
        return sum(1 for u in self._users["users"].values() if u.get("is_admin"))

    def delete_user(self, username: str) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        if user.get("is_admin") and self._count_admins() <= 1:
            raise ValueError("can't delete the last admin")
        del self._users["users"][username]
        write_json_atomic(AUTH_FILE, self._users)
        _credentials_changed(username)
        # Any live sessions for this user stop authenticating on next use
        # anyway (validate_session re-checks the user exists), but drop them
        # now so /api/auth/users reflects reality immediately.
        self._drop([t for t, s in self._sessions.items() if s.get("username") == username])

    def disable_totp(self, username: str) -> None:
        user = self._users["users"].get(username)
        if not user:
            raise KeyError(f"no such user: {username}")
        user["totp_secret"] = None
        user["totp_enabled"] = False
        user.pop("totp_pending_secret", None)
        write_json_atomic(AUTH_FILE, self._users)

    # -- TOTP (optional 2FA) -------------------------------------------

    def totp_enabled(self, username: str) -> bool:
        user = self._users["users"].get(username)
        return bool(user and user.get("totp_enabled"))

    def start_totp_enrollment(self, username: str) -> str:
        """Generates a new secret (not yet active) and returns its otpauth:// URI.

        Held apart from the active secret until confirmed: starting a new
        enrollment while 2FA is on must not break the authenticator in use."""
        secret = pyotp.random_base32()
        self._users["users"][username]["totp_pending_secret"] = secret
        write_json_atomic(AUTH_FILE, self._users)
        return pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name="Kairos")

    def confirm_totp_enrollment(self, username: str, code: str) -> bool:
        user = self._users["users"].get(username)
        if not user:
            return False
        # Enrollments started before pending secrets existed kept theirs in totp_secret.
        pending = user.get("totp_pending_secret") or (None if user.get("totp_enabled") else user.get("totp_secret"))
        if not pending or not pyotp.totp.TOTP(pending).verify(code):
            return False
        user["totp_secret"] = pending
        user["totp_enabled"] = True
        user.pop("totp_pending_secret", None)
        write_json_atomic(AUTH_FILE, self._users)
        return True

    def verify_totp(self, username: str, code: str) -> bool:
        user = self._users["users"].get(username)
        if not user or not user.get("totp_enabled"):
            return False
        return pyotp.totp.TOTP(user["totp_secret"]).verify(code)

    # -- sessions --------------------------------------------------------

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(32)
        self._sessions[token] = {"username": username, "expires_at": time.time() + SESSION_TTL_SECONDS}
        write_json_atomic(SESSIONS_FILE, self._sessions)
        return token

    def _drop(self, tokens) -> None:
        """Ends sessions and remembered rows (and the sessions opened from those rows), saves, and tells the
        listeners, which close any websocket or stream still running on one of them."""
        with self._lock:
            ending = {t for t in tokens if t and t in self._sessions}
            ending |= {t for t, s in self._sessions.items() if s.get("remember") in ending}
            for token in ending:
                del self._sessions[token]
            if ending:
                write_json_atomic(SESSIONS_FILE, self._sessions)
        for listener in list(revoke_listeners) if ending else []:
            try:
                listener(ending)
            except Exception:
                pass

    def validate_session(self, token: str) -> Optional[str]:
        session = self._sessions.get(token)
        if not session:
            return None
        # A device's remembered sign-in is never a session itself: only the switch route opens one from it.
        if session.get("kind") == "remember":
            return None
        if session["expires_at"] < time.time():
            self.delete_session(token)
            return None
        # Re-check the user still exists — a deleted account's cookie stops
        # authenticating on its next use rather than continuing to work.
        if session["username"] not in self._users["users"]:
            return None
        # A session opened from a remembered sign-in ends with it (signed out of that account on this device).
        parent = session.get("remember")
        if parent and parent not in self._sessions:
            self.delete_session(token)
            return None
        return session["username"]

    def delete_session(self, token: str) -> None:
        self._drop([token])

    def notification_session_valid(self, username: str, binding: str) -> bool:
        """Validate device enrollment without persisting a bearer session token. An enrollment made since the
        account switcher is bound to the device's remembered sign-in for the account, and is valid only while
        that account is the one open on the device: another account's open app never gets this one's pushes."""
        if username not in self._users["users"]:
            return False
        now = time.time()
        for token, row in list(self._sessions.items()):
            if row.get("username") != username or row.get("expires_at", 0) <= now:
                continue
            if not secrets.compare_digest(_digest(token), binding):
                continue
            if row.get("kind") == "remember":
                return any(other.get("remember") == token and other.get("expires_at", 0) > now
                           for other in list(self._sessions.values()))
            return True
        return False

    # -- sign-ins remembered on a device (the account switcher) ----------
    # A device is the hash of its secret (DEVICE_COOKIE_NAME). Its rows: "remember" rows (one per account signed
    # in on it) and the sessions opened from them, each carrying "device". Every change below runs under the lock
    # and rotates the secret; the route sets the new one as the cookie.

    def _device_rows(self, device_hash: Optional[str]) -> list[str]:
        return [t for t, s in self._sessions.items() if device_hash and s.get("device") == device_hash]

    def device_accounts(self, device: Optional[str]) -> list[dict]:
        """The accounts signed in on a device, in sign-in order, each {"username", "id", "expired"}. "id" is the
        server's own row key, never sent to the device."""
        if not device:
            return []
        now, dh = time.time(), _digest(device)
        rows = [(t, s) for t, s in list(self._sessions.items()) if s.get("kind") == "remember" and s.get("device") == dh
                and s.get("username") in self._users["users"]]
        rows.sort(key=lambda r: r[1].get("created_at", 0))
        return [{"username": s["username"], "id": t, "expired": s["expires_at"] <= now} for t, s in rows]

    def _rotate(self, device: Optional[str]) -> str:
        """A new secret for the device: every row bound to the old one moves to it, so the old value opens nothing."""
        new = secrets.token_urlsafe(32)
        old, fresh = (_digest(device) if device else None), _digest(new)
        for token in self._device_rows(old):
            self._sessions[token]["device"] = fresh
        return new

    def _device_sessions(self, device: Optional[str]) -> list[str]:
        dh = _digest(device) if device else None
        return [t for t in self._device_rows(dh) if self._sessions[t].get("kind") != "remember"]

    def device_sign_in(self, device: Optional[str], username: str, open_session: Optional[str] = None) -> tuple[str, str]:
        """A password sign-in on a device: the account joins it (replacing an older row for the same account) and
        becomes the open one. Every session the device held closes. Answers (new device secret, session)."""
        with self._lock:
            ending = self._device_sessions(device) + [open_session]
            ending += [r["id"] for r in self.device_accounts(device) if r["username"] == username]
            self._drop(ending)
            new = self._rotate(device)
            now, dh = time.time(), _digest(new)
            remember, session = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self._sessions[remember] = {"username": username, "expires_at": now + SESSION_TTL_SECONDS,
                                        "kind": "remember", "created_at": now, "device": dh}
            self._sessions[session] = {"username": username, "expires_at": now + SESSION_TTL_SECONDS,
                                       "remember": remember, "device": dh}
            self._purge_remembered(now)
            write_json_atomic(SESSIONS_FILE, self._sessions)
            return new, session

    def device_switch(self, device: Optional[str], username: str, pin: Optional[str], open_session: Optional[str] = None) -> dict:
        """Opens another account signed in on this device. Answers {"ok": True, "device", "session"} or
        {"ok": False, "reason": "absent" | "expired" | one of check_switch_pin's reasons, ...}. On success every
        session the device held closes (including one a parallel switch just opened) and its secret rotates."""
        with self._lock:
            target = next((r for r in self.device_accounts(device) if r["username"] == username), None)
            if target is None:
                return {"ok": False, "reason": "absent"}
            if target["expired"]:
                return {"ok": False, "reason": "expired"}
            check = self.check_switch_pin(username, pin)
            if not check["ok"]:
                if check["reason"] == "forget":
                    self._drop([target["id"]])
                return check
            self._drop(self._device_sessions(device) + [open_session])
            new = self._rotate(device)
            row = self._sessions[target["id"]]
            session = secrets.token_urlsafe(32)
            self._sessions[session] = {"username": username, "expires_at": row["expires_at"], "remember": target["id"],
                                       "device": _digest(new)}
            write_json_atomic(SESSIONS_FILE, self._sessions)
            return {"ok": True, "device": new, "session": session}

    def device_sign_out(self, device: Optional[str], username: Optional[str] = None) -> Optional[str]:
        """Signs one account (or, with no name, every account) out of a device. Answers the device's new secret,
        or None when nothing is left on it."""
        with self._lock:
            self._drop([r["id"] for r in self.device_accounts(device) if username is None or r["username"] == username])
            if username is None:
                self._drop(self._device_rows(_digest(device) if device else None))
            if not self.device_accounts(device):
                return None
            new = self._rotate(device)
            write_json_atomic(SESSIONS_FILE, self._sessions)
            return new

    def device_adopt(self, device: Optional[str], session: Optional[str], legacy=()) -> Optional[str]:
        """Brings sign-ins from before device secrets onto this device: an open session with no device behind it,
        and the first switcher build's per-account tokens (the kairos_accounts cookie). Answers the device secret
        to keep: a new one when anything was brought over, else the one given."""
        with self._lock:
            found = []
            row = self._sessions.get(session or "")
            if row and row.get("kind") != "remember" and not row.get("device") and self.validate_session(session):
                remember = row.get("remember")
                if not remember or remember not in self._sessions:
                    remember = secrets.token_urlsafe(32)
                    self._sessions[remember] = {"username": row["username"], "expires_at": row["expires_at"],
                                                "kind": "remember", "created_at": time.time()}
                    row["remember"] = remember
                found.append(remember)
            for token in legacy:
                old = self._sessions.get(token)
                if old and old.get("kind") == "remember" and not old.get("device") and token not in found:
                    found.append(token)
            if not found:
                return device
            device = device or secrets.token_urlsafe(32)
            dh = _digest(device)
            have = {r["username"] for r in self.device_accounts(device)}
            for remember in found:
                entry = self._sessions[remember]
                for token, other in self._sessions.items():
                    if other.get("remember") == remember:
                        other["device"] = dh
                if entry["username"] not in have:
                    entry["device"] = dh
                    have.add(entry["username"])
            new = self._rotate(device)
            write_json_atomic(SESSIONS_FILE, self._sessions)
            return new

    def revoke_other_sign_ins(self, username: str, keep_session: Optional[str]) -> None:
        """After a password change: every session and remembered sign-in of the account ends, on every device,
        except the session that changed it and the remembered row it came from."""
        keep = {keep_session, self.remember_of(keep_session)} - {None}
        self._drop([t for t, s in list(self._sessions.items()) if s.get("username") == username and t not in keep])

    def _purge_remembered(self, now: float) -> None:
        stale = [t for t, s in self._sessions.items() if s.get("kind") == "remember"
                 and s.get("expires_at", 0) + REMEMBER_SHOWN_AFTER_EXPIRY_SECONDS < now]
        for token in stale:
            del self._sessions[token]

    def remember_of(self, session_token: Optional[str]) -> Optional[str]:
        """The remembered sign-in a session was opened from, if any."""
        row = self._sessions.get(session_token or "")
        return row.get("remember") if row and row.get("kind") != "remember" else None

    def binding_token(self, session_token: Optional[str]) -> Optional[str]:
        """What a device's push enrollment is bound to: the remembered sign-in behind the session (it outlives the
        sessions switching opens and closes), else the session itself. Server-side only, never sent anywhere."""
        return self.remember_of(session_token) or session_token

    # -- password reset (forgot password, David's ask 2026-09-10) ---------
    # Callers (routes/auth_routes.py) MUST return an identical response
    # whether create_password_reset returns a real code or None (unknown
    # user, or a request already outstanding) - the whole point of a
    # constant-shape response is that this method's return value never
    # leaks whether a username or email exists.

    def create_password_reset(self, username: str) -> Optional[str]:
        user = self._users["users"].get(username)
        if not user:
            return None
        existing = self._resets.get(username)
        if existing and existing["requested_at"] + RESET_REQUEST_COOLDOWN_SECONDS > time.time():
            return None
        code = f"{secrets.randbelow(1_000_000):06d}"
        self._resets[username] = {
            "code": code,
            "requested_at": time.time(),
            "expires_at": time.time() + RESET_CODE_TTL_SECONDS,
            "attempts": 0,
        }
        write_json_atomic(PASSWORD_RESETS_FILE, self._resets)
        return code

    def redeem_password_reset(self, username: str, code: str, new_password: str) -> bool:
        entry = self._resets.get(username)
        if not entry:
            return False
        if entry["expires_at"] < time.time():
            del self._resets[username]
            write_json_atomic(PASSWORD_RESETS_FILE, self._resets)
            return False
        entry["attempts"] = entry.get("attempts", 0) + 1
        # Checked and persisted before the compare so a script hammering
        # guesses burns its budget even if it never sends the right code -
        # a 6-digit space is only ~1e6, worth capping hard.
        if entry["attempts"] > RESET_MAX_ATTEMPTS:
            del self._resets[username]
            write_json_atomic(PASSWORD_RESETS_FILE, self._resets)
            return False
        if not secrets.compare_digest(entry["code"], code.strip()):
            write_json_atomic(PASSWORD_RESETS_FILE, self._resets)
            return False
        self.change_password(username, new_password)
        del self._resets[username]
        write_json_atomic(PASSWORD_RESETS_FILE, self._resets)
        # A password reset is exactly the moment to assume the account may
        # have been compromised or the old password forgotten under
        # duress - drop every existing session so a stale/leaked cookie
        # elsewhere stops working immediately rather than outliving the
        # password it was issued under.
        self._drop([t for t, s in self._sessions.items() if s.get("username") == username])
        return True


auth_manager = AuthManager()
