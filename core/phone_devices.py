"""Paired phones: the pairing code and the device token the Kairos iPhone app signs in with
(specs/phone-api.md; the contract is docs/PHONE-API.md in the kairos-ios repository).

A phone is paired once. A signed-in desktop session makes a six-digit code (start_pairing); the phone
sends it back with no sign-in at all (claim) and receives a token, `kph_...`, shown that one time. From
then on the phone sends `Authorization: Bearer kph_...` and core/middleware.py treats the request as
that account, exactly like its browser session.

The rules that keep this door narrow:

- Only accounts can pair (accounts on). The token is 256 random bits; this file keeps only its SHA-256
  hash, in data/phone_devices.json. The token itself is never written, logged or returned again.
- A token is bound to the user name AND the account's folder id, so a deleted account's token never
  opens a later account that reuses the name. Whether it is an admin is read from the account on every
  request, never stored with the token.
- A code is six digits, lives ten minutes, works once, and lives in memory only (a restart cancels it).
  One code per account; a new one cancels the old one.
- Wrong tries: CLAIM_TRIES wrong codes from one address inside CLAIM_WINDOW_SECONDS lock that address
  out for the rest of the window and cancel every waiting code; and a code is cancelled once
  CLAIM_TRIES wrong codes have been tried while it waited, from any address at all. The phone sends
  only a code (no account name), so a wrong try cannot be pinned on one code: it counts against each.
  A code therefore faces at most five guesses in a million before it is gone, however many addresses
  the guesser has.
- A phone token never opens the routes that mint or manage sign-ins (DESKTOP_ONLY): making another
  pairing code, passwords, two-step codes, users, the remote access switches, backups and wipes.
- Unpairing, a password change or reset, and deleting the account end the token at once and close the
  streams and websockets opened with it (ended_listeners; core/middleware.py listens).
"""
import hashlib
import os
import re
import secrets
import threading
import time
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.auth import auth_enabled, auth_manager
from core.constants import DATA_DIR
from core.try_limits import TryLimit, address_key

DEVICES_FILE = os.path.join(DATA_DIR, "phone_devices.json")

TOKEN_PREFIX = "kph_"
_TOKEN_SHAPE = re.compile(r"kph_[A-Za-z0-9_-]{43}")
DEVICE_ID_SHAPE = re.compile(r"d_[0-9a-f]{24}")
_CODE_SHAPE = re.compile(r"[0-9]{6}")

CODE_TTL_SECONDS = 10 * 60
CLAIM_TRIES = 5
CLAIM_WINDOW_SECONDS = 10 * 60
MAX_DEVICES_PER_ACCOUNT = 10
LAST_SEEN_SAVE_SECONDS = 60     # a request updates last_seen in memory; the file at most this often

CLAIM_PATH = "/api/phone/pair/claim"
WRONG_CODE = "That code is not right or has expired."
TOO_MANY_TRIES = "Too many tries. Make a new code on your desktop."

# Routes a phone token never opens, whatever the account may do in a browser. Everything that mints or
# manages a sign-in stays with the desktop: another pairing code (a stolen token must not be able to pair
# a second phone that survives the first being removed), passwords, two-step codes, the account switcher
# and user management (all of /api/auth but the "who am I" read), the remote access switches, the push
# relay address, and the whole-install backup, restore and wipe.
DESKTOP_ONLY = (
    re.compile(r"/api/phone/pair/start"),
    re.compile(r"/api/phone/push/relay"),
    re.compile(r"/api/auth/(?!status$).*"),
    re.compile(r"/api/remote(/.*)?"),
    re.compile(r"/api/system/backup(/.*)?"),
    re.compile(r"/api/system/wipe(-kinds)?"),
)
DESKTOP_ONLY_MESSAGE = "Do this in Kairos on your desktop. A paired phone cannot."

# Called with the ids of devices whose token just ended (unpaired, password changed, account deleted).
ended_listeners: list = []

_lock = threading.RLock()
_codes: dict[str, dict] = {}        # user name -> {"code", "expires_at", "wrong"}
_claim_tries = TryLimit(CLAIM_TRIES, CLAIM_WINDOW_SECONDS)
_saved_seen: dict[str, float] = {}  # device id -> when its last_seen_at last reached the file


class PairError(Exception):
    def __init__(self, status: int, detail: str, retry_after: int = 0):
        super().__init__(detail)
        self.status, self.detail, self.retry_after = status, detail, retry_after


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean(text, limit: int) -> str:
    """A phone names itself; the name is shown in Settings as text. No control characters, bounded."""
    value = re.sub(r"[\x00-\x1f\x7f-\x9f  ]", " ", str(text or ""))
    return " ".join(value.split())[:limit]


# -- the store ----------------------------------------------------------------------------------------------

class _Store:
    """data/phone_devices.json: {"devices": {device id: row}}. A row holds the token's hash, never the token."""

    def __init__(self) -> None:
        self.devices: dict[str, dict] = {}
        self.by_hash: dict[str, str] = {}
        self.load()

    def load(self) -> None:
        data = read_json(DEVICES_FILE, {})
        rows = data.get("devices") if isinstance(data, dict) else None
        self.devices = {k: v for k, v in (rows or {}).items() if isinstance(v, dict) and v.get("token_hash")}
        self.by_hash = {row["token_hash"]: device_id for device_id, row in self.devices.items()}

    def save(self) -> None:
        write_json_atomic(DEVICES_FILE, {"devices": self.devices})


_store = _Store()


def reload() -> None:
    """Read the file again (a restored backup, or a test's fresh data folder)."""
    with _lock:
        _store.load()
        _codes.clear()
        _saved_seen.clear()
    _claim_tries.clear()


def _view(device_id: str, row: dict) -> dict:
    return {"id": device_id, "username": row["username"], "account_id": row["account_id"], "name": row.get("name") or "iPhone",
            "model": row.get("model") or "", "app_version": row.get("app_version") or "",
            "created_at": row.get("created_at") or 0, "last_seen_at": row.get("last_seen_at") or 0}


def _owned(username: str) -> list[str]:
    account_id = auth_manager.account_id(username)
    return [device_id for device_id, row in _store.devices.items()
            if row["username"] == username and row["account_id"] == account_id]


def devices_for(username: str) -> list[dict]:
    """The account's paired phones, oldest first."""
    with _lock:
        rows = [_view(device_id, _store.devices[device_id]) for device_id in _owned(username)]
    return sorted(rows, key=lambda r: (r["created_at"], r["id"]))


# -- pairing ------------------------------------------------------------------------------------------------

def _expire_codes(now: float) -> None:
    for username in [u for u, entry in _codes.items() if entry["expires_at"] <= now]:
        del _codes[username]


def start_pairing(username: str, now: Optional[float] = None) -> tuple[str, float]:
    """A new code for this account, replacing any it had. Answers (code, expires_at as unix seconds)."""
    now = time.time() if now is None else now
    if not auth_enabled() or auth_manager.account_id(username) is None:
        raise PairError(400, "Pairing a phone needs a Kairos login. Set one up in Settings, Remote access.")
    with _lock:
        _expire_codes(now)
        if len(_owned(username)) >= MAX_DEVICES_PER_ACCOUNT:
            raise PairError(409, f"This account already has {MAX_DEVICES_PER_ACCOUNT} phones paired. Remove one first.")
        _codes.pop(username, None)
        taken = {entry["code"] for entry in _codes.values()}
        while True:
            code = f"{secrets.randbelow(1_000_000):06d}"
            if code not in taken:
                break
        expires_at = now + CODE_TTL_SECONDS
        _codes[username] = {"code": code, "expires_at": expires_at, "wrong": 0}
        return code, expires_at


def cancel_pairing(username: str) -> None:
    with _lock:
        _codes.pop(username, None)


def pairing_waiting(username: str, now: Optional[float] = None) -> bool:
    now = time.time() if now is None else now
    with _lock:
        _expire_codes(now)
        return username in _codes


def claim(code: str, address: Optional[str], name="", model="", app_version="", now: Optional[float] = None) -> dict:
    """The phone's side: trade a code for a token. Answers {"token", "device"}; raises PairError (400 for a
    wrong or expired code, 429 once the tries ran out). The token is in the answer and nowhere else."""
    now = time.time() if now is None else now
    who = address_key(address)
    # Compared against every waiting code, each in constant time, whatever was sent.
    guess = code if isinstance(code, str) and _CODE_SHAPE.fullmatch(code) else "x" * 6
    with _lock:
        _expire_codes(now)
        wait = _claim_tries.wait(who, now)
        if wait:
            # A locked-out address is not looked at again: its tries neither match nor count.
            raise PairError(429, TOO_MANY_TRIES, wait)
        match = None
        for username, entry in _codes.items():
            if secrets.compare_digest(entry["code"].encode(), guess.encode()):
                match = username
        if match is None or not auth_enabled():
            tries = _claim_tries.add(who, now)
            spent = False
            for username in list(_codes):
                _codes[username]["wrong"] += 1
                if _codes[username]["wrong"] >= CLAIM_TRIES:
                    del _codes[username]
                    spent = True
            if tries >= CLAIM_TRIES:
                _codes.clear()
                raise PairError(429, TOO_MANY_TRIES, _claim_tries.wait(who, now))
            if spent:
                raise PairError(429, TOO_MANY_TRIES)
            raise PairError(400, WRONG_CODE)
        del _codes[match]   # single use, whatever happens next
        account_id = auth_manager.account_id(match)
        if account_id is None:
            raise PairError(400, WRONG_CODE)
        if len(_owned(match)) >= MAX_DEVICES_PER_ACCOUNT:
            raise PairError(409, f"This account already has {MAX_DEVICES_PER_ACCOUNT} phones paired. Remove one first.")
        token = TOKEN_PREFIX + secrets.token_urlsafe(32)
        device_id = "d_" + secrets.token_hex(12)
        row = {"token_hash": _digest(token), "username": match, "account_id": account_id,
               "name": _clean(name, 60) or "iPhone", "model": _clean(model, 40), "app_version": _clean(app_version, 20),
               "created_at": now, "last_seen_at": now}
        _store.devices[device_id] = row
        _store.by_hash[row["token_hash"]] = device_id
        _store.save()
        _saved_seen[device_id] = now
        return {"token": token, "device": _view(device_id, row)}


# -- signing in with a token --------------------------------------------------------------------------------

def presented_token(connection) -> Optional[str]:
    """The phone token this request or websocket carries, valid or not; None when it carries none.
    Only the Authorization header is read: a token in an address would end up in logs and history."""
    try:
        header = connection.headers.get("authorization") or ""
    except Exception:
        return None
    scheme, _, value = header.partition(" ")
    value = value.strip()
    if scheme.lower() != "bearer" or not value.startswith(TOKEN_PREFIX):
        return None
    return value


def resolve(token: Optional[str], now: Optional[float] = None) -> Optional[dict]:
    """The device a token belongs to, or None: unknown, removed, its account gone, or accounts off."""
    if not isinstance(token, str) or not _TOKEN_SHAPE.fullmatch(token) or not auth_enabled():
        return None
    digest = _digest(token)
    now = time.time() if now is None else now
    with _lock:
        device_id = _store.by_hash.get(digest)
        row = _store.devices.get(device_id) if device_id else None
        if row is None or not secrets.compare_digest(row["token_hash"], digest):
            return None
        if auth_manager.account_id(row["username"]) != row["account_id"]:
            return None     # the account was deleted (and perhaps made again under the same name)
        row["last_seen_at"] = now
        if now - _saved_seen.get(device_id, 0) >= LAST_SEEN_SAVE_SECONDS:
            _saved_seen[device_id] = now
            try:
                _store.save()
            except OSError:
                pass
        return _view(device_id, row)


def device_for(connection) -> Optional[dict]:
    """The paired phone this request is signed in as, or None (a browser session, or nobody)."""
    token = presented_token(connection)
    return resolve(token) if token else None


def still_valid(device_id: str, token_hash: str) -> bool:
    """For a stream or websocket opened with a token: is that same token still good?"""
    if not auth_enabled():
        return False
    with _lock:
        row = _store.devices.get(device_id)
        return bool(row and secrets.compare_digest(row["token_hash"], token_hash)
                    and auth_manager.account_id(row["username"]) == row["account_id"])


def token_hash(token: str) -> str:
    return _digest(token)


def route_allowed(path: str) -> bool:
    """May a phone token open this path at all? (What the account may do there is the route's own check.)"""
    return not any(rule.fullmatch(path) for rule in DESKTOP_ONLY)


# -- ending tokens ------------------------------------------------------------------------------------------

def _end(device_ids: list[str]) -> None:
    removed = []
    with _lock:
        for device_id in device_ids:
            row = _store.devices.pop(device_id, None)
            if row:
                _store.by_hash.pop(row["token_hash"], None)
                _saved_seen.pop(device_id, None)
                removed.append(device_id)
        if removed:
            _store.save()
    if removed:
        for listener in list(ended_listeners):
            try:
                listener(removed)
            except Exception:
                pass


def revoke(username: str, device_id: str) -> bool:
    """Unpair one of the account's own phones. False when it is not theirs (or not there)."""
    with _lock:
        if device_id not in _owned(username):
            return False
    _end([device_id])
    return True


def revoke_account(username: str) -> None:
    """Every phone paired to a user name, whatever folder id the rows carry: the password changed, or the
    account was deleted (its folder id can no longer be asked for)."""
    with _lock:
        mine = [device_id for device_id, row in _store.devices.items() if row["username"] == username]
        _codes.pop(username, None)
    _end(mine)


def _credentials_changed(username: str) -> None:
    revoke_account(username)


from core import auth as _auth_module  # noqa: E402
_auth_module.credential_listeners.append(_credentials_changed)
