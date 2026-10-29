"""The front desk's one installed routine and small, atomic local stores.

The minute tick installs/checks metadata only. Execution belongs to the routine
engine; an unavailable engine never turns into a second background runner.
"""
import hashlib
import json
import os
import re
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from core.atomic_io import write_json_atomic
from core.constants import DATA_DIR

DIRECTORY = os.path.join(DATA_DIR, "front_desk")
LOCK = threading.RLock()


def read(name, default=None):
    # Fail closed on an unreadable stamp instead of recreating a deleted watch.
    with LOCK:
        try:
            with open(os.path.join(DIRECTORY, name + ".json"), encoding="utf-8-sig") as handle:
                return json.load(handle)
        except FileNotFoundError:
            return deepcopy({} if default is None else default)


def write(name, value):
    with LOCK:
        write_json_atomic(os.path.join(DIRECTORY, name + ".json"), value)


def bot_id():
    from services import front_desk
    return front_desk.bot_id()


def main_thread_id():
    from services import front_desk
    return front_desk.main_thread_id()


def owner():
    """Resolve background authority from the bot's session, never tool input."""
    from core.session_manager import session_manager
    from services.bot_attention import owner_of, legacy_owner
    session = session_manager.get_session(main_thread_id())
    return owner_of(session or {}) or legacy_owner()


def require_owner(user):
    from fastapi import HTTPException
    from services.bot_attention import require_thread
    try:
        sid = main_thread_id()
    except ImportError:
        raise HTTPException(503, "The front desk is not ready yet") from None
    if not sid:
        raise HTTPException(404, "Front desk not found")
    require_thread(sid, user)


def connected():
    from core import google_workspace
    from services.email_service import email_service
    from services.calendar_service import calendar_service
    user = owner()
    accounts = [a for a in email_service.list_accounts() if a.get("owner") in (None, user)]
    google = google_workspace.status(user)
    return {"mail": bool(accounts), "calendar": bool(google.get("calendar_connected") or calendar_service._events)}


def fingerprint(routine):
    keys = ("name", "instructions", "schedule", "timeout_minutes", "checks", "access", "deliver", "overlap")
    config = {**routine, **(routine.get("routine") or {})}
    return hashlib.sha256(json.dumps({k: config.get(k) for k in keys}, sort_keys=True).encode()).hexdigest()


def ensure_watch():
    from core import front_desk_watch_adapter as adapter
    with LOCK:
        stamp = read("watch")
        if stamp.get("created_at"):
            return stamp
        if not bot_id() or not any(connected().values()):
            return None
        if not adapter.available():
            return None
        adapter.register()
        now = time.time()
        config = {"agent_id": bot_id(), "name": "Keep an eye on my day",
                  "instructions": "Check my day. Read and save local drafts only. Never send or change outside data.",
                  "schedule": {"kind": "interval", "every_minutes": 15,
                               "anchor_at": datetime.fromtimestamp(now + 900, timezone.utc).isoformat()},
                  "timeout_minutes": 15, "checks": ["calendar", "mail", "runs"],
                  "access": "read-and-draft", "deliver": "brief", "overlap": "skip", "enabled": True,
                  "results_thread_id": main_thread_id()}
        # Adapter creation must be idempotent with this durable key. It closes
        # the create/JSON-stamp crash gap without adopting an unrelated routine.
        routine = adapter.create(config, owner=owner(), key="front-desk-watch")
        stamp = {"created_at": now, "routine_id": routine["id"], "as_made": fingerprint(routine)}
        write("watch", stamp)
        return stamp


def state():
    from core import front_desk_watch_adapter as adapter
    with LOCK:
        stamp, checks = read("watch"), read("checks")
        sources = connected()
        routine = adapter.get(stamp["routine_id"], owner=owner()) if stamp.get("routine_id") else None
        config = {**(routine or {}), **((routine or {}).get("routine") or {})}
        enabled = bool(routine and config.get("enabled", True) and not config.get("deleted_at"))
        status = "working" if enabled else "paused" if routine else "off" if stamp else "not_connected"
        if not stamp and any(sources.values()):
            status = "off"
        return {"routine_id": stamp.get("routine_id"), "enabled": enabled, "state": status,
                "revision": config.get("revision"), "last_check_at": checks.get("last_check_at"),
                "last_result": checks.get("last_result"), "next_at": config.get("next_at"), "connected": sources,
                "available": adapter.available(), "edited": bool(routine and fingerprint(routine) != stamp.get("as_made")),
                "morning": read("watch-settings", {"on": True, "time": "08:00", "zone": "UTC"})}


def settings(*, morning_on=None, morning_time=None, zone=None, language=None):
    if morning_time is not None and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", morning_time):
        raise ValueError("Choose a time from 00:00 to 23:59")
    if zone is not None:
        ZoneInfo(zone)
    with LOCK:
        value = read("watch-settings", {"on": True, "time": "08:00", "zone": "UTC"})
        value.update({k: v for k, v in {"on": morning_on, "time": morning_time, "zone": zone, "language": language}.items() if v is not None})
        write("watch-settings", value)
        return value


def run_now():
    from core import front_desk_watch_adapter as adapter
    with LOCK:
        value, stamp = read("checks"), read("watch")
        if not stamp.get("routine_id"):
            raise ValueError("Connect mail or calendar to start watching")
        now = time.time()
        last = max(value.get("last_run_at", 0), value.get("last_manual_run_at", 0))
        if last and now - last < 600:
            raise ValueError("I checked recently. Try again in a few minutes.")
        result = adapter.run_now(stamp["routine_id"], owner=owner())
        value["last_manual_run_at"] = now
        write("checks", value)
        return result
