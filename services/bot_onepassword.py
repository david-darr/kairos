"""Optional 1Password adapter for saved logins (Phase 2, unit U5).

Uses the 1Password command line (`op`) already on this computer with a service-account token the
person pastes; no SDK is installed. It is lazy: nothing here runs until a person connects, and a
missing `op` reports "unavailable" with the reason instead of failing.

- The token is stored sealed with the login key, in the same folder that backups never carry.
- Each vault has its own list of bots that may use it (default none).
- Item lists hold only the site and username. A password or code is read at the moment of filling
  (`read_credentials`), used once, and held for scrubbing; it is never stored here.
- `op` runs with fixed arguments and no shell, a short time limit and only the variables it needs.
"""
import json
import os
import shutil
import subprocess
import threading
import time
from typing import Callable, Optional

from services import bot_logins
from services.bot_logins import LoginError, host_matches, normalize_host

TIMEOUT = 20
MAX_VAULTS = 50
MAX_ITEMS = 500
CACHE_SECONDS = 60
STATE_FILE = "onepassword.json"

Runner = Callable[[list, dict, int], "tuple[int, str]"]
_lock = threading.RLock()
_cache: dict = {}


def _default_runner(args: list, env: dict, timeout: int):
    path = shutil.which("op")
    if not path:
        raise FileNotFoundError("op")
    clean = {k: v for k, v in os.environ.items() if k in ("PATH", "SystemRoot", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP")}
    clean.update(env)
    done = subprocess.run([path, *args], capture_output=True, text=True, timeout=timeout, env=clean, shell=False, check=False)
    return done.returncode, done.stdout


_runner: Runner = _default_runner


def set_runner(runner: Optional[Runner]) -> None:
    """Tests only: replace the command runner."""
    global _runner
    _runner = runner or _default_runner
    _cache.clear()


def _state_path() -> str:
    return os.path.join(bot_logins._folder(), STATE_FILE)


def _read_state() -> dict:
    try:
        with open(_state_path(), encoding="utf-8") as f:
            return json.loads(bot_logins.unseal(f.read()))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise LoginError("The 1Password connection cannot be read. Nothing was changed.", 503) from error


def _write_state(state: dict) -> None:
    folder = bot_logins._folder()
    os.makedirs(folder, exist_ok=True)
    temp = _state_path() + ".tmp"
    with open(temp, "w", encoding="utf-8") as f:
        f.write(bot_logins.seal(json.dumps(state)))
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, _state_path())
    _cache.clear()


def available() -> tuple[bool, str]:
    if _runner is _default_runner and not shutil.which("op"):
        return False, "The 1Password command line (op) is not installed on this computer."
    return True, ""


def _op(args: list, token: str, timeout: int = TIMEOUT):
    try:
        code, out = _runner(args, {"OP_SERVICE_ACCOUNT_TOKEN": token}, timeout)
    except FileNotFoundError as error:
        raise LoginError("The 1Password command line (op) is not installed on this computer.", 503) from error
    except subprocess.TimeoutExpired as error:
        raise LoginError("1Password did not answer in time.", 504) from error
    if code != 0:
        raise LoginError("1Password refused the request. Check the service-account token and its vault access.", 502)
    try:
        return json.loads(out)
    except ValueError as error:
        raise LoginError("1Password answered in a form Kairos cannot read.", 502) from error


def status() -> dict:
    ok, reason = available()
    state = _read_state() if ok else {}
    return {"available": ok, "reason": reason, "connected": bool(state.get("token")),
            "vaults": [{"id": v["id"], "name": v["name"], "bots": v.get("bots", [])} for v in state.get("vaults", [])]}


def _vaults(token: str, previous: list) -> list:
    rows = _op(["vault", "list", "--format", "json"], token)
    if not isinstance(rows, list):
        raise LoginError("1Password answered in a form Kairos cannot read.", 502)
    grants = {v["id"]: v.get("bots", []) for v in previous}
    return [{"id": str(r["id"]), "name": str(r.get("name", ""))[:100], "bots": grants.get(str(r["id"]), [])}
            for r in rows[:MAX_VAULTS] if isinstance(r, dict) and r.get("id")]


def connect(token: str) -> dict:
    token = (token or "").strip()
    if not token or len(token) > 4096:
        raise LoginError("Paste the service-account token.")
    ok, reason = available()
    if not ok:
        raise LoginError(reason, 503)
    with _lock:
        state = {"token": token, "vaults": _vaults(token, [])}
        _write_state(state)
    return status()


def refresh() -> dict:
    with _lock:
        state = _read_state()
        if not state.get("token"):
            raise LoginError("1Password is not connected.", 409)
        state["vaults"] = _vaults(state["token"], state.get("vaults", []))
        _write_state(state)
    return status()


def disconnect() -> dict:
    with _lock:
        try:
            os.remove(_state_path())
        except FileNotFoundError:
            pass
        _cache.clear()
    return status()


def set_vault_bots(vault_id: str, bots) -> dict:
    cleaned = bot_logins._bots(bots)
    with _lock:
        state = _read_state()
        vault = next((v for v in state.get("vaults", []) if v["id"] == vault_id), None)
        if vault is None:
            raise LoginError("That vault was not found.", 404)
        vault["bots"] = cleaned
        _write_state(state)
    return status()


def _vault_allows(vault: dict, bot_id: str) -> bool:
    return vault.get("bots") == "all" or bot_id in (vault.get("bots") or [])


def _items(token: str, vault_id: str) -> list:
    stamp = _cache.get(vault_id)
    if stamp and time.monotonic() - stamp[0] < CACHE_SECONDS:
        return stamp[1]
    rows = _op(["item", "list", "--vault", vault_id, "--categories", "Login", "--format", "json"], token)
    rows = [r for r in rows[:MAX_ITEMS] if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []
    _cache[vault_id] = (time.monotonic(), rows)
    return rows


def _item_hosts(item: dict) -> list[str]:
    hosts = []
    for url in item.get("urls") or []:
        try:
            hosts.append(normalize_host(url.get("href", "")))
        except LoginError:
            continue
    return hosts


def usable_for(host: str, bot_id: str) -> list[dict]:
    """Masked rows for items in vaults this bot may use whose address matches `host`."""
    state = _read_state()
    if not state.get("token"):
        return []
    found = []
    for vault in state.get("vaults", []):
        if not _vault_allows(vault, bot_id):
            continue
        for item in _items(state["token"], vault["id"]):
            hosts = _item_hosts(item)
            if host_matches(host, {"hosts": hosts}):
                found.append({"id": f"op:{vault['id']}:{item['id']}", "site": hosts[0], "username": str(item.get("additional_information", ""))[:256],
                              "hosts": hosts, "has_totp": False, "exact_host": False, "bots": [bot_id], "source": "1password",
                              "last_used": None, "created_at": None, "updated_at": None})
    return found


def read_credentials(login_id: str, bot_id: str) -> dict:
    """At fill time: {site, hosts, exact_host, username, password, code}. Refuses a vault this bot may not use."""
    try:
        _, vault_id, item_id = login_id.split(":", 2)
    except ValueError as error:
        raise bot_logins.LoginRefused("No saved login like that is available to this bot.") from error
    state = _read_state()
    vault = next((v for v in state.get("vaults", []) if v["id"] == vault_id), None)
    if not state.get("token") or vault is None or not _vault_allows(vault, bot_id):
        raise bot_logins.LoginRefused("No saved login like that is available to this bot.")
    item = _op(["item", "get", item_id, "--vault", vault_id, "--format", "json", "--reveal"], state["token"])
    fields = {str(f.get("purpose") or f.get("id") or "").upper(): f for f in item.get("fields", []) if isinstance(f, dict)}
    username, password = (fields.get("USERNAME") or {}).get("value"), (fields.get("PASSWORD") or {}).get("value")
    otp = next((f for f in item.get("fields", []) if isinstance(f, dict) and f.get("type") == "OTP"), None)
    if not username or not password:
        raise bot_logins.LoginRefused("That 1Password item has no username and password to fill.")
    hosts = _item_hosts(item)
    return {"site": hosts[0] if hosts else "", "hosts": hosts, "exact_host": False, "username": str(username),
            "password": str(password), "code": str(otp.get("totp")) if otp and otp.get("totp") else None}
