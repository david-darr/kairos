"""Browse's password keeper (Kairos Browser, David's feedback 2026-11-06: "it needs a proper password keeper").

The person's own saved sign-ins for sites they open in Browse. Separate from bots' saved logins
(services/bot_logins.py): nothing here is ever offered to a bot or a model.

- One file per account, accounts/<id>/bot-secrets/browse-logins.enc: the account's secrets folder, which no
  backup, export or restore carries or replaces (core/backup.py). The whole file (sites, usernames, passwords,
  the never-save list) is encrypted with the account's own key (core/secret_storage.py, Multi-Account phase
  3b), so another account's key can't open it and an admin can't read it through any route.
- Rows go to the UI without passwords. A password leaves this module three ways only: `fill()` for the exact
  origin it was saved for (asked by the desktop app's main process, which fills it into that origin's page),
  `reveal()` after the person re-entered their Kairos password (`unlock()`), and nowhere else. Values are
  never logged.
- A site is its exact origin (scheme, host and port): https://x.com and https://mobile.x.com are different.
- A corrupt or unreadable file fails closed: it is never overwritten or treated as empty.
"""
from __future__ import annotations

import csv
import io
import json
import os
import secrets
import string
import threading
import time
from typing import Optional
from urllib.parse import urlsplit

from cryptography.fernet import InvalidToken

from core.bot_held_secrets import SECRET_FOLDER

FILE = "browse-logins.enc"
MAX_LOGINS = 5000
MAX_NEVER = 2000
MAX_FIELD = 1000
MAX_PASSWORD = 1000
MAX_IMPORT_BYTES = 5 * 1024 * 1024
UNLOCK_SECONDS = 5 * 60


class PasswordError(ValueError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


_lock = threading.RLock()
_unlocked: dict[str, float] = {}


def _account() -> str:
    from core import accounts
    return accounts.effective_account()


def _path(account_id: str) -> str:
    from core import accounts
    return os.path.join(accounts.account_dir(account_id), SECRET_FOLDER, FILE)


def origin_of(url: str) -> Optional[str]:
    """The exact origin of an http(s) address, lower-case host, default ports dropped; None otherwise."""
    if not isinstance(url, str) or len(url) > 4096:
        return None
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port and not ((parts.scheme == "https" and port == 443) or (parts.scheme == "http" and port == 80)):
        return f"{parts.scheme}://{host}:{port}"
    return f"{parts.scheme}://{host}"


def _empty() -> dict:
    return {"version": 1, "logins": {}, "never": []}


def _load(account_id: str) -> dict:
    from core import secret_storage
    path = _path(account_id)
    if not os.path.exists(path):
        return _empty()
    try:
        with open(path, "r", encoding="ascii") as f:
            blob = f.read()
        data = json.loads(secret_storage.decrypt_for(account_id, blob))
    except (InvalidToken, ValueError, OSError, UnicodeError) as error:
        raise PasswordError("Saved passwords can't be read. Nothing was changed.", 503) from error
    if not isinstance(data, dict) or not isinstance(data.get("logins"), dict) or not isinstance(data.get("never", []), list):
        raise PasswordError("Saved passwords can't be read. Nothing was changed.", 503)
    data.setdefault("never", [])
    return data


def _save(account_id: str, data: dict) -> None:
    from core import secret_storage
    path = _path(account_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    blob = secret_storage.encrypt_for(account_id, json.dumps(data, ensure_ascii=False))
    temp = f"{path}.{secrets.token_hex(4)}.tmp"
    with open(temp, "w", encoding="ascii") as f:
        f.write(blob)
        f.flush()
        os.fsync(f.fileno())
    try:
        os.chmod(temp, 0o600)
    except OSError:
        pass
    os.replace(temp, path)


def _text(value, name: str, limit: int = MAX_FIELD, allow_empty: bool = True) -> str:
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise PasswordError(f"That {name} isn't valid.")
    if not allow_empty and not value:
        raise PasswordError(f"The {name} is empty.")
    return value


def _row(login_id: str, record: dict) -> dict:
    return {"id": login_id, "origin": record["origin"], "username": record.get("username", ""),
            "created": record.get("created"), "updated": record.get("updated"), "last_used": record.get("last_used"),
            "times_used": record.get("times_used", 0)}


def _find(data: dict, origin: str, username: str) -> Optional[str]:
    for login_id, record in data["logins"].items():
        if record["origin"] == origin and record.get("username", "") == username:
            return login_id
    return None


def list_logins(query: str = "") -> list[dict]:
    q = (query or "").strip().lower()[:200]
    with _lock:
        data = _load(_account())
    rows = [_row(i, r) for i, r in data["logins"].items()]
    if q:
        rows = [r for r in rows if q in r["origin"].lower() or q in r["username"].lower()]
    return sorted(rows, key=lambda r: (r["origin"], r["username"].lower()))


def match(url: str) -> dict:
    """Saved sign-ins for exactly this page's origin (no passwords), and whether the person said never."""
    origin = origin_of(url)
    if not origin:
        return {"origin": None, "logins": [], "never": False}
    with _lock:
        data = _load(_account())
    rows = [_row(i, r) for i, r in data["logins"].items() if r["origin"] == origin]
    rows.sort(key=lambda r: -(r["last_used"] or r["updated"] or 0))
    return {"origin": origin, "logins": rows, "never": origin in data["never"]}


def save(url: str, username: str, password: str) -> dict:
    """Saves a sign-in, or updates the password of the same site and username. Returns the row."""
    origin = origin_of(url)
    if not origin:
        raise PasswordError("Passwords are saved only for http and https sites.")
    username = _text(username, "username")
    password = _text(password, "password", MAX_PASSWORD, allow_empty=False)
    now = time.time()
    account_id = _account()
    with _lock:
        data = _load(account_id)
        login_id = _find(data, origin, username)
        if login_id:
            data["logins"][login_id].update(password=password, updated=now)
        else:
            if len(data["logins"]) >= MAX_LOGINS:
                raise PasswordError(f"Kairos keeps up to {MAX_LOGINS} passwords. Delete some to save more.", 409)
            login_id = secrets.token_hex(8)
            data["logins"][login_id] = {"origin": origin, "username": username, "password": password,
                                        "created": now, "updated": now, "last_used": None, "times_used": 0}
        if origin in data["never"]:
            data["never"].remove(origin)
        _save(account_id, data)
        return _row(login_id, data["logins"][login_id])


def is_saved(url: str, username: str, password: str) -> bool:
    """Whether exactly this sign-in is already saved (so Browse doesn't offer to save it again)."""
    origin = origin_of(url)
    if not origin or not isinstance(username, str) or not isinstance(password, str):
        return False
    with _lock:
        data = _load(_account())
    login_id = _find(data, origin, username)
    return bool(login_id) and secrets.compare_digest(data["logins"][login_id]["password"].encode(), password.encode())


def update(login_id: str, *, url: Optional[str] = None, username: Optional[str] = None,
           password: Optional[str] = None) -> dict:
    account_id = _account()
    with _lock:
        data = _load(account_id)
        record = data["logins"].get(login_id)
        if not record:
            raise PasswordError("That saved password no longer exists.", 404)
        origin = record["origin"]
        if url is not None:
            origin = origin_of(url)
            if not origin:
                raise PasswordError("Passwords are saved only for http and https sites.")
        new_user = _text(username, "username") if username is not None else record.get("username", "")
        other = _find(data, origin, new_user)
        if other and other != login_id:
            raise PasswordError("A password for that site and username is already saved.", 409)
        record.update(origin=origin, username=new_user, updated=time.time())
        if password is not None:
            record["password"] = _text(password, "password", MAX_PASSWORD, allow_empty=False)
        _save(account_id, data)
        return _row(login_id, record)


def delete(login_id: str) -> bool:
    account_id = _account()
    with _lock:
        data = _load(account_id)
        if data["logins"].pop(login_id, None) is None:
            return False
        _save(account_id, data)
        return True


def fill(login_id: str, url: str) -> dict:
    """The username and password, only for the exact origin they were saved for."""
    origin = origin_of(url)
    account_id = _account()
    with _lock:
        data = _load(account_id)
        record = data["logins"].get(login_id)
        if not record or not origin or record["origin"] != origin:
            raise PasswordError("That password isn't saved for this site.", 403)
        record["last_used"] = time.time()
        record["times_used"] = int(record.get("times_used", 0)) + 1
        _save(account_id, data)
        return {"username": record.get("username", ""), "password": record["password"]}


def set_never(url: str, never: bool) -> dict:
    origin = origin_of(url)
    if not origin:
        raise PasswordError("That isn't a site address.")
    account_id = _account()
    with _lock:
        data = _load(account_id)
        if never and origin not in data["never"]:
            if len(data["never"]) >= MAX_NEVER:
                data["never"].pop(0)
            data["never"].append(origin)
        if not never and origin in data["never"]:
            data["never"].remove(origin)
        _save(account_id, data)
        return {"origin": origin, "never": never}


def never_list() -> list[str]:
    with _lock:
        return sorted(_load(_account())["never"])


# -- Reveal: only after the person proves it is them (their Kairos password), for five minutes. --

def unlock(account_id: str, ok: bool) -> float:
    if not ok:
        _unlocked.pop(account_id, None)
        raise PasswordError("That password isn't right.", 403)
    until = time.time() + UNLOCK_SECONDS
    _unlocked[account_id] = until
    return until


def unlocked_until(account_id: str) -> Optional[float]:
    until = _unlocked.get(account_id)
    if until and until > time.time():
        return until
    _unlocked.pop(account_id, None)
    return None


def lock(account_id: str) -> None:
    _unlocked.pop(account_id, None)


def reveal(login_id: str) -> str:
    account_id = _account()
    if not unlocked_until(account_id):
        raise PasswordError("Confirm it's you first.", 403)
    with _lock:
        record = _load(account_id)["logins"].get(login_id)
    if not record:
        raise PasswordError("That saved password no longer exists.", 404)
    return record["password"]


# -- Strong passwords --

GENERATED_LENGTH = 20
_SYMBOLS = "-_.!@#$%*+="


def generate(length: int = GENERATED_LENGTH) -> str:
    """A random password with lower and upper case letters, digits and a symbol."""
    length = max(12, min(64, int(length)))
    alphabet = string.ascii_letters + string.digits + _SYMBOLS
    while True:
        value = "".join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.islower() for c in value) and any(c.isupper() for c in value)
                and any(c.isdigit() for c in value) and any(c in _SYMBOLS for c in value)):
            return value


# -- Import from another browser's CSV export (Chrome, Edge, Opera, Brave, Firefox, Bitwarden, 1Password) --

_URL_COLUMNS = ("url", "login_uri", "website", "web site", "origin", "uri", "login url")
_USER_COLUMNS = ("username", "login_username", "user name", "login", "email", "user")
_PASSWORD_COLUMNS = ("password", "login_password", "pass")


def _column(header: list[str], names: tuple) -> Optional[int]:
    lowered = [h.strip().lower() for h in header]
    for name in names:
        if name in lowered:
            return lowered.index(name)
    return None


def import_csv(text: str) -> dict:
    """Adds every http(s) sign-in in a password export. A site and username already saved keeps its password
    unless the export's differs, in which case it is updated. Returns counts only."""
    if not isinstance(text, str) or len(text.encode("utf-8", "ignore")) > MAX_IMPORT_BYTES:
        raise PasswordError("That file is too large to be a password export.")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        raise PasswordError("That file is empty.")
    header = rows[0]
    url_at, user_at, pass_at = _column(header, _URL_COLUMNS), _column(header, _USER_COLUMNS), _column(header, _PASSWORD_COLUMNS)
    if url_at is None or pass_at is None:
        raise PasswordError("That doesn't look like a password export: it needs a url and a password column.")
    added = updated = skipped = unchanged = 0
    account_id = _account()
    now = time.time()
    with _lock:
        data = _load(account_id)
        for row in rows[1:]:
            if not row or all(not cell.strip() for cell in row):
                continue
            try:
                url = row[url_at]
                password = row[pass_at]
                username = row[user_at] if user_at is not None and user_at < len(row) else ""
            except IndexError:
                skipped += 1
                continue
            origin = origin_of(url)
            if (not origin or not password or len(password) > MAX_PASSWORD or len(username) > MAX_FIELD
                    or "\x00" in password or "\x00" in username):
                skipped += 1
                continue
            login_id = _find(data, origin, username)
            if login_id:
                if data["logins"][login_id]["password"] == password:
                    unchanged += 1
                else:
                    data["logins"][login_id].update(password=password, updated=now)
                    updated += 1
                continue
            if len(data["logins"]) >= MAX_LOGINS:
                skipped += 1
                continue
            data["logins"][secrets.token_hex(8)] = {"origin": origin, "username": username, "password": password,
                                                    "created": now, "updated": now, "last_used": None, "times_used": 0}
            added += 1
        if added or updated:
            _save(account_id, data)
    return {"added": added, "updated": updated, "unchanged": unchanged, "skipped": skipped}
