"""Person-scoped onboarding receipts and setup checks. No model turns or installs."""
import asyncio
import copy
import hashlib
import os
from pathlib import Path
import re
import threading
import time

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

FILE = Path(DATA_DIR) / "bot_onboarding.json"
LOCK = threading.RLock()
DEFAULT = {"welcome_seen": False, "tour": {"done": False, "step": 0, "variant": "simple"},
           "hints_seen": [], "notices": {}, "setup_checked_at": None}
ID = re.compile(r"^[a-zA-Z0-9_.:-]{1,80}$")


class OnboardingError(ValueError):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status


def key(owner):
    if not owner:
        raise OnboardingError("Sign in first.", 403)
    return hashlib.sha256(owner.encode()).hexdigest()[:24]


def state(owner):
    with LOCK:
        stored = read_json(str(FILE), {}).get("people", {}).get(key(owner), {})
        return copy.deepcopy({**DEFAULT, **stored})


def patch(owner, changes):
    with LOCK:
        all_people = read_json(str(FILE), {})
        result = state(owner)
        if set(changes) - {"welcome_seen", "tour", "hints", "notices"}:
            raise OnboardingError("Unknown onboarding field.")
        if "welcome_seen" in changes:
            if type(changes["welcome_seen"]) is not bool:
                raise OnboardingError("Welcome state must be true or false.")
            result["welcome_seen"] = changes["welcome_seen"]
        if "tour" in changes:
            tour = {**result["tour"], **changes["tour"]}
            if (set(tour) != {"done", "step", "variant"} or type(tour["done"]) is not bool or
                    type(tour["step"]) is not int or not 0 <= tour["step"] <= 10 or tour["variant"] not in ("simple", "advanced")):
                raise OnboardingError("Invalid tour state.")
            result["tour"] = tour
        for hint in changes.get("hints", []):
            if not isinstance(hint, str) or not ID.fullmatch(hint):
                raise OnboardingError("Invalid hint.")
            if hint not in result["hints_seen"]:
                result["hints_seen"].append(hint)
        if len(result["hints_seen"]) > 200:
            raise OnboardingError("Too many hints.")
        for ident, change in changes.get("notices", {}).items():
            if not ID.fullmatch(ident) or set(change) - {"dismissed"} or type(change.get("dismissed")) is not bool:
                raise OnboardingError("Invalid notice.")
            prior = result["notices"].get(ident)
            # A notice receipt is permanent. Re-enqueueing can never resurrect it.
            result["notices"][ident] = {"shown_at": prior["shown_at"] if prior else time.time(),
                                         "dismissed": bool((prior or {}).get("dismissed") or change["dismissed"])}
        if len(result["notices"]) > 100:
            raise OnboardingError("Too many notices.")
        all_people.setdefault("people", {})[key(owner)] = result
        _save(all_people)
        return copy.deepcopy(result)


def _save(value):
    write_json_atomic(str(FILE), value)
    try:
        os.chmod(FILE, 0o600)
    except OSError:
        pass


def model_ready():
    from core.model_endpoints import list_endpoints
    return any(e.get("enabled", True) and not e.get("error") and
               (e.get("kind") in ("claude_cli", "codex_cli", "antigravity_cli", "local") or e.get("has_api_key")) for e in list_endpoints())


def connected_apps(owner):
    from core import google_workspace
    from services.email_service import email_service
    google = google_workspace.status(owner)
    scopes = google.get("granted_scopes") or []
    gmail = any("gmail." in s or s == "https://mail.google.com/" for s in scopes)
    gmail = gmail or any(a.get("owner") in (None, owner) and "gmail.com" == a.get("imap_host", "").removeprefix("imap.") for a in email_service.list_accounts())
    return {"gmail": gmail, "calendar": bool(google.get("calendar_connected"))}


async def checks(owner):
    from services.bot_workbench import docker_status
    from core import call_voices
    async def one(ident, title, fn, fix):
        try:
            ready = await fn()
            return {"id": ident, "title": title, "status": "ready" if ready else "needs_setup", "fix": fix}
        except Exception:
            return {"id": ident, "title": title, "status": "not_checked", "fix": fix}
    async def model():
        return await asyncio.to_thread(model_ready)
    async def computer():
        data = await docker_status()
        return data.get("available") and data.get("image_ready")
    async def voice():
        catalog = await call_voices.catalog()
        return bool(catalog.get("voices") and catalog.get("models"))
    async def app(ident):
        return (await asyncio.to_thread(connected_apps, owner))[ident]
    rows = await asyncio.gather(one("model", "Model", model, "add-models"),
                                one("computer", "Computer", computer, "computer-use"),
                                one("gmail", "Gmail", lambda: app("gmail"), "integrations"),
                                one("calendar", "Calendar", lambda: app("calendar"), "integrations"),
                                one("voice", "Voice engine", voice, "speech"))
    rows.insert(4, {"id": "notifications", "title": "Notifications", "status": "not_checked", "fix": "notifications"})
    return rows


async def setup(owner, recheck=False, now=None):
    now = time.time() if now is None else now
    # Persist the reservation before awaiting checks, so concurrent rechecks cannot race.
    with LOCK:
        people = read_json(str(FILE), {})
        stored = people.setdefault("people", {}).setdefault(key(owner), copy.deepcopy(DEFAULT))
        last = stored.get("setup_checked_at")
        if last is not None and now - last < 10:
            if recheck:
                raise OnboardingError("Wait a moment before checking again.", 429)
            if stored.get("setup"):
                return copy.deepcopy(stored["setup"])
        stored["setup_checked_at"] = now
        _save(people)
    result = {"checked_at": now, "checks": await checks(owner)}
    with LOCK:
        people = read_json(str(FILE), {})
        people["people"][key(owner)]["setup"] = result
        _save(people)
    return result
