"""Saved logins for bots (Phase 2, unit U5).

A login is a site, a username and a password, with an optional one-time-code seed. Records live in
one file encrypted with their own key, both under <data>/bot-secrets, which no backup, export or
restore ever carries (core/backup.py). The store is write-only toward the UI: rows come back masked
(site, username, hosts, whether a code seed exists, who may use it, last used), never a password or
seed. A bot sees only "site + username" lines; filling happens in the harness (core/computer.py),
which asks `resolve_fill()` for the values at the moment it fills and never returns them.

Host binding: a login matches the page's real host (and its frames' hosts), exactly or, unless
"exact host only" is set, as a subdomain. A different host needs the person's explicit confirmation.
A corrupt or unreadable store fails closed: it is never overwritten or treated as empty.

Bot access is "all" or a list of bot ids; deleting a bot removes it from every list, never a login.
"""
import hashlib
import ipaddress
import json
import os
import re
import secrets
import threading
import time
from typing import Optional
from urllib.parse import unquote, urlsplit

from cryptography.fernet import Fernet, InvalidToken

from core.bot_held_secrets import SECRET_FOLDER, held

MAX_LOGINS = 200
MAX_BOTS = 100
BOT_ID = re.compile(r"[0-9a-f]{10}")
ALGORITHMS = {"SHA1": hashlib.sha1, "SHA256": hashlib.sha256, "SHA512": hashlib.sha512}
SOURCES = ("settings", "card", "1password")


class LoginError(ValueError):
    """Bad input. `status` is the HTTP code a route should answer with."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


class LoginRefused(LoginError):
    """A fill that must not happen. `needs_confirmation` marks the one case a person may approve."""

    def __init__(self, message: str, *, needs_confirmation: bool = False):
        super().__init__(message, 403)
        self.needs_confirmation = needs_confirmation


def _folder() -> str:
    from core.constants import DATA_DIR
    return os.path.join(DATA_DIR, SECRET_FOLDER)


def _paths() -> tuple[str, str]:
    folder = _folder()
    return os.path.join(folder, "login.key"), os.path.join(folder, "logins.enc")


_lock = threading.RLock()
_cache: dict = {"signature": None, "data": None}


def _restrict(path: str) -> None:
    try:
        os.chmod(path, 0o600)  # no-op on Windows, a real restriction on POSIX
    except OSError:
        pass


def _fernet(create: bool) -> Fernet:
    key_path, data_path = _paths()
    if os.path.exists(key_path):
        with open(key_path, "rb") as f:
            return Fernet(f.read().strip())
    if os.path.exists(data_path):
        raise LoginError("The saved logins cannot be opened: their key file is missing. Nothing was changed.", 503)
    if not create:
        return Fernet(Fernet.generate_key())  # nothing saved yet, so nothing to open
    os.makedirs(_folder(), exist_ok=True)
    key = Fernet.generate_key()
    temp = key_path + ".tmp"
    with open(temp, "wb") as f:
        f.write(key)
        f.flush()
        os.fsync(f.fileno())
    _restrict(temp)
    os.replace(temp, key_path)
    return Fernet(key)


def _load() -> dict:
    key_path, data_path = _paths()
    with _lock:
        if not os.path.exists(data_path):
            return {"version": 1, "logins": {}}
        stat = os.stat(data_path)
        signature = (stat.st_mtime_ns, stat.st_size)
        if _cache["signature"] == signature and _cache["data"] is not None:
            return json.loads(json.dumps(_cache["data"]))
        try:
            with open(data_path, "rb") as f:
                blob = f.read()
            data = json.loads(_fernet(False).decrypt(blob).decode("utf-8"))
        except (InvalidToken, ValueError, OSError) as error:
            if isinstance(error, LoginError):
                raise
            raise LoginError("The saved logins cannot be read. Nothing was changed.", 503) from error
        if not isinstance(data, dict) or not isinstance(data.get("logins"), dict):
            raise LoginError("The saved logins cannot be read. Nothing was changed.", 503)
        _cache.update(signature=signature, data=data)
        return json.loads(json.dumps(data))


def _save(data: dict) -> None:
    key_path, data_path = _paths()
    with _lock:
        fernet = _fernet(True)
        os.makedirs(_folder(), exist_ok=True)
        temp = f"{data_path}.{secrets.token_hex(4)}.tmp"
        with open(temp, "wb") as f:
            f.write(fernet.encrypt(json.dumps(data, ensure_ascii=False).encode("utf-8")))
            f.flush()
            os.fsync(f.fileno())
        _restrict(temp)
        os.replace(temp, data_path)
        stat = os.stat(data_path)
        _cache.update(signature=(stat.st_mtime_ns, stat.st_size), data=json.loads(json.dumps(data)))


def seal(text: str) -> str:
    """Encrypt `text` with the login key (the 1Password token uses it, so it sits in the same excluded folder)."""
    with _lock:
        return _fernet(True).encrypt(text.encode("utf-8")).decode("ascii")


def unseal(token: str) -> str:
    with _lock:
        try:
            return _fernet(False).decrypt(token.encode("ascii")).decode("utf-8")
        except (InvalidToken, ValueError) as error:
            raise LoginError("A saved secret cannot be read. Nothing was changed.", 503) from error


def reset_cache() -> None:
    with _lock:
        _cache.update(signature=None, data=None)


# -- hosts -----------------------------------------------------------------------------------------

def normalize_host(value: str) -> str:
    """A bare lowercase host from a site, address or host:port. LoginError for anything else."""
    text = unquote((value or "").strip())
    if not text or len(text) > 2048 or any(c.isspace() or c in "\\<>\"'`" for c in text):
        raise LoginError("Enter the site, for example example.com.")
    parts = urlsplit(text if "://" in text else "//" + text)
    if parts.scheme and parts.scheme not in ("http", "https"):
        raise LoginError("Only web sites can have a saved login.")
    if parts.username or parts.password:
        raise LoginError("Leave sign-in details out of the site address.")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or len(host) > 253:
        raise LoginError("Enter the site, for example example.com.")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if "*" in host or ".." in host or host.startswith("."):
        raise LoginError("Enter one site, without wildcards.")
    try:
        ascii_host = host.encode("idna").decode("ascii")
    except UnicodeError as error:
        raise LoginError("That site name is not valid.") from error
    if not re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*", ascii_host):
        raise LoginError("That site name is not valid.")
    return ascii_host


def host_matches(page_host: str, record: dict) -> bool:
    """Does `page_host` belong to this login: its host exactly, or a subdomain unless exact-host-only."""
    host = (page_host or "").rstrip(".").lower()
    if not host:
        return False
    for site in record.get("hosts") or []:
        if host == site:
            return True
        if not record.get("exact_host"):
            try:
                ipaddress.ip_address(site)
            except ValueError:
                if host.endswith("." + site):
                    return True
    return False


# -- records ---------------------------------------------------------------------------------------

def clean_totp(value) -> Optional[dict]:
    """A one-time-code seed: base32 text or an otpauth:// address, or {secret, algorithm, digits, period}."""
    if value in (None, "", {}):
        return None
    options = {"algorithm": "SHA1", "digits": 6, "period": 30}
    if isinstance(value, dict):
        secret = str(value.get("secret") or "")
        options.update({k: value[k] for k in options if value.get(k) not in (None, "")})
    else:
        secret = str(value)
    if secret.lower().startswith("otpauth://"):
        parts = urlsplit(secret)
        query = dict(p.split("=", 1) for p in parts.query.split("&") if "=" in p)
        if parts.hostname != "totp" or not query.get("secret"):
            raise LoginError("That is not a one-time-code address Kairos can use.")
        secret = unquote(query["secret"])
        options.update({"algorithm": (query.get("algorithm") or "SHA1").upper(), "digits": int(query.get("digits") or 6),
                        "period": int(query.get("period") or 30)})
    secret = re.sub(r"[\s-]", "", secret).upper().rstrip("=")
    try:
        digits, period = int(options["digits"]), int(options["period"])
    except (TypeError, ValueError) as error:
        raise LoginError("Digits and period must be whole numbers.") from error
    algorithm = str(options["algorithm"]).upper()
    if algorithm not in ALGORITHMS:
        raise LoginError("The code algorithm is SHA1, SHA256 or SHA512.")
    if not 6 <= digits <= 8 or not 10 <= period <= 300:
        raise LoginError("A code has 6 to 8 digits and renews every 10 to 300 seconds.")
    if not re.fullmatch(r"[A-Z2-7]{8,128}", secret):
        raise LoginError("The one-time-code seed is not valid. It is letters and the digits 2 to 7.")
    return {"secret": secret, "algorithm": algorithm, "digits": digits, "period": period}


def totp_code(seed: dict, at: Optional[float] = None) -> str:
    import pyotp
    return pyotp.TOTP(seed["secret"], digits=seed["digits"], interval=seed["period"],
                      digest=ALGORITHMS[seed["algorithm"]]).at(at if at is not None else time.time())


def _bots(value):
    if value in (None, "all"):
        return "all"
    if not isinstance(value, list) or len(value) > MAX_BOTS or any(not isinstance(b, str) or not BOT_ID.fullmatch(b) for b in value):
        raise LoginError("Choose all bots, or a list of bots.")
    return sorted(set(value))


def masked(record: dict) -> dict:
    return {"id": record["id"], "site": record["site"], "username": record["username"], "hosts": list(record["hosts"]),
            "has_totp": bool(record.get("totp")), "exact_host": bool(record.get("exact_host")), "bots": record["bots"],
            "source": record.get("source", "settings"), "last_used": record.get("last_used"),
            "created_at": record.get("created_at"), "updated_at": record.get("updated_at")}


def list_logins() -> list[dict]:
    return [masked(r) for r in sorted(_load()["logins"].values(), key=lambda r: (r["site"], r["username"]))]


def get(login_id: str) -> Optional[dict]:
    record = _load()["logins"].get(login_id)
    return masked(record) if record else None


def create(site: str, username: str, password: str, *, totp=None, exact_host: bool = False, bots="all",
           source: str = "settings") -> dict:
    host = normalize_host(site)
    username, password = (username or "").strip(), password or ""
    if not username or len(username) > 256:
        raise LoginError("Enter the username, up to 256 characters.")
    if not password or len(password) > 1024:
        raise LoginError("Enter the password, up to 1,024 characters.")
    if source not in SOURCES:
        raise LoginError("Unknown login source.")
    with _lock:
        data = _load()
        if len(data["logins"]) >= MAX_LOGINS:
            raise LoginError(f"Kairos keeps up to {MAX_LOGINS} saved logins.", 413)
        if any(r["hosts"] == [host] and r["username"].lower() == username.lower() for r in data["logins"].values()):
            raise LoginError("A login for this site and username already exists. Change it instead.", 409)
        now = time.time()
        record = {"id": secrets.token_hex(6), "site": host, "hosts": [host], "username": username, "password": password,
                  "totp": clean_totp(totp), "exact_host": bool(exact_host), "bots": _bots(bots), "source": source,
                  "last_used": None, "created_at": now, "updated_at": now}
        data["logins"][record["id"]] = record
        _save(data)
        return masked(record)


def update(login_id: str, *, username: Optional[str] = None, password: Optional[str] = None, totp="keep",
           exact_host: Optional[bool] = None, bots="keep", site: Optional[str] = None) -> dict:
    """Change a login. A blank or missing password keeps the saved one; totp="keep" keeps the seed and None removes it."""
    with _lock:
        data = _load()
        record = data["logins"].get(login_id)
        if record is None:
            raise LoginError("That login was not found.", 404)
        if site not in (None, ""):
            host = normalize_host(site)
            record["site"], record["hosts"] = host, [host]
        if username not in (None, ""):
            if len(username.strip()) > 256:
                raise LoginError("The username is up to 256 characters.")
            record["username"] = username.strip()
        if password:
            if len(password) > 1024:
                raise LoginError("The password is up to 1,024 characters.")
            record["password"] = password
        if totp != "keep":
            record["totp"] = clean_totp(totp)
        if exact_host is not None:
            record["exact_host"] = bool(exact_host)
        if bots != "keep":
            record["bots"] = _bots(bots)
        for other in data["logins"].values():
            if other["id"] != login_id and other["hosts"] == record["hosts"] and other["username"].lower() == record["username"].lower():
                raise LoginError("A login for this site and username already exists.", 409)
        record["updated_at"] = time.time()
        _save(data)
        return masked(record)


def delete(login_id: str) -> None:
    with _lock:
        data = _load()
        if data["logins"].pop(login_id, None) is None:
            raise LoginError("That login was not found.", 404)
        _save(data)


def forget_bot(bot_id: str) -> int:
    """A deleted bot leaves every access list. Logins themselves stay. Returns how many lists changed."""
    changed = 0
    with _lock:
        data = _load()
        for record in data["logins"].values():
            if isinstance(record["bots"], list) and bot_id in record["bots"]:
                record["bots"] = [b for b in record["bots"] if b != bot_id]
                changed += 1
        if changed:
            _save(data)
    return changed


def bot_may_use(record: dict, bot_id: str) -> bool:
    return record["bots"] == "all" or bot_id in record["bots"]


def usable_for(host: str, bot_id: str) -> list[dict]:
    """Masked logins this bot may use on a page at `host` (saved here, then 1Password's if connected)."""
    found = [masked(r) for r in _load()["logins"].values() if host_matches(host, r) and bot_may_use(r, bot_id)]
    try:
        from services import bot_onepassword
        found += bot_onepassword.usable_for(host, bot_id)
    except LoginError:
        raise
    except Exception:  # an optional password manager must never stop saved logins
        pass
    return sorted(found, key=lambda r: (r["site"], r["username"]))


def prompt_lines(bot_id: str) -> list[str]:
    """What a bot is told it can sign in with: site and username, nothing else."""
    return [f"{r['site']} ({r['username']})" for r in list_logins()
            if r["bots"] == "all" or bot_id in r["bots"]]


def resolve_fill(login_id: str, bot_id: str, top_host: str, frame_hosts=(), *, confirmed_cross_site: bool = False,
                 now: Optional[float] = None) -> dict:
    """The values to type, at the moment of filling: {username, password, code, site, cross_site}.

    Refuses a login this bot may not use, a page whose top-level host or any listed frame host does not
    belong to the login unless the person confirmed a cross-site fill. The values are held so scrub()
    removes them from anything a bot or transcript sees. The caller must never return them."""
    top_host = (top_host or "").strip().lower()
    if str(login_id).startswith("op:"):
        from services import bot_onepassword
        record = bot_onepassword.read_credentials(login_id, bot_id)  # fill-time read; nothing is stored here
        cross = not host_matches(top_host, record) or any(h and not host_matches(h, record) for h in frame_hosts)
        if cross and not confirmed_cross_site:
            raise LoginRefused("This page is not the site this login belongs to. The person must confirm filling it here.",
                               needs_confirmation=True)
        code = record.get("code")
    else:
        with _lock:
            data = _load()
            record = data["logins"].get(login_id)
            if record is None or not bot_may_use(record, bot_id):
                raise LoginRefused("No saved login like that is available to this bot.")
            cross = not host_matches(top_host, record) or any(h and not host_matches(h, record) for h in frame_hosts)
            if cross and not confirmed_cross_site:
                raise LoginRefused("This page is not the site this login belongs to. The person must confirm filling it here.",
                                   needs_confirmation=True)
            code = totp_code(record["totp"], now) if record.get("totp") else None
            record["last_used"] = time.time()
            _save(data)
    held.hold(record["password"])
    if code:
        held.hold_code(code)
    return {"username": record["username"], "password": record["password"], "code": code, "site": record["site"],
            "cross_site": cross}


def _all_passwords():
    try:
        for record in _load()["logins"].values():
            yield record["password"]
            if record.get("totp"):
                yield record["totp"]["secret"]
    except LoginError:
        return


held.add_source(_all_passwords)
