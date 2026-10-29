"""Routines: a bot does something on a schedule (Bots redesign, Phase 3 unit U2,
2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 4.2, 4.3,
5.4, 6 and 9.

A routine is still a task in `tasks.json` (ids, ownership and history stay
valid); this module owns the normalized `routine` object on it and every way
to change it. Schedules come from core/bot_schedules.py, runs are started and
tracked by core/bot_routine_runner.py, and the Phase 3 U5 cards reach all of
this through `automation_backend()` at the bottom.

What lives here:
- `normalize_config`: one validator for the editor, the API and a bot's own
  request. The person's editor may set what a bot may not (attachments,
  threads, startup runs, checks, result delivery).
- CRUD with a revision on every configuration change (run status never bumps
  it), so a stale editor or a stale Undo is refused instead of overwriting.
- Lazy translation of old goals: a goal with no `routine` object is read as
  one without writing anything; the first edit materializes it, after one
  backup of tasks.json.
- Soft deletion: a deleted routine is kept seven days (50 at most) and can be
  restored.
- `run_now`, `defer`, run cancel and seen marks, the unified summaries, and
  `enqueue_event` for webhook and app events (U4).
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from core import bot_schedules
from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core.bot_routine_checks import CHECK_KINDS
from services import task_service as task_module
from services.task_service import task_service

SCHEMA_VERSION = 1
MAX_NAME, MAX_PROMPT = 80, 8000
MAX_ATTACHMENTS = 50
MAX_ROUTINES_PER_BOT = 20
OVERLAPS = ("skip", "queue")
ACCESS = ("normal", "read-and-draft")
REPORTS = ("notable", "always")
TRASH_FILE = os.path.join(DATA_DIR, "bot_routine_trash.json")
TRASH_SECONDS = 7 * 24 * 3600
TRASH_MAX = 50
OUTPUT_BOUND, ERROR_BOUND = 4000, 1000
EVENT_MAX_EVENTS, EVENT_MAX_CHARS, EVENT_MAX_PENDING = 20, 48000, 3
RECEIPTS_KEPT = 200
BACKUP_FILE = task_module.TASKS_FILE + ".pre-routines.bak"

# Everything the person configures (the snapshot Undo restores). Status and
# the revision are not configuration.
CONFIG_KEYS = ("name", "prompt", "enabled", "report_when", "schedule", "overlap", "access", "deliver",
               "duration_minutes", "timeout_minutes", "continuity", "call", "run_on_startup", "attachments",
               "checks", "source_thread_id", "results_thread_id")
# What a bot's own request may set (U5 enforces the same list on its side).
BOT_KEYS = ("name", "prompt", "enabled", "report_when", "schedule", "overlap", "access", "duration_minutes",
            "timeout_minutes", "continuity", "call")
DEFAULTS = {"overlap": "skip", "access": "normal", "deliver": "normal", "duration_minutes": 30, "timeout_minutes": None,
            "continuity": False, "call": False, "run_on_startup": False, "attachments": [], "checks": [],
            "source_thread_id": None, "results_thread_id": None}

_LOCK = threading.RLock()
_recent_requests: dict[str, tuple[float, str]] = {}


class RoutineError(Exception):
    """A routine request that was not applied. `status` is the HTTP code."""

    def __init__(self, message: str, status: int = 400, code: str = "invalid", field: Optional[str] = None):
        super().__init__(message)
        self.status, self.code, self.field = status, code, field


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()[:12]


# -- reading ------------------------------------------------------------------------------

def is_routine(task: Optional[dict]) -> bool:
    """A bot's scheduled task: a routine, or an old goal read as one."""
    return bool(task and task.get("agent_id") and task.get("schedule_kind") != "card"
                and (task.get("routine") or {}).get("kind") != "event"
                and not task.get("builtin_action"))


def _owner_of(task: dict) -> Optional[str]:
    from core import task_scope
    return task_scope.owner_for(task)


def owned_by(task: dict, owner: str, is_admin: bool = False) -> bool:
    return task_service.visible_to(task, owner, is_admin)


def config_of(task: dict) -> dict:
    """The routine's configuration, from its record or translated from a goal."""
    routine = task.get("routine")
    if routine:
        out = {k: copy.deepcopy(routine.get(k, DEFAULTS.get(k))) for k in CONFIG_KEYS
               if k not in ("name", "prompt", "enabled", "report_when")}
    else:
        schedule = None
        try:
            schedule = bot_schedules.from_legacy(task)
        except (ValueError, TypeError):
            pass
        out = {**copy.deepcopy(DEFAULTS), "schedule": schedule}
    out.update(name=task.get("name"), prompt=task.get("prompt"), enabled=bool(task.get("enabled")),
               report_when=task.get("report_when") or "notable")
    return out


def revision_of(task: dict) -> str:
    routine = task.get("routine")
    if routine and isinstance(routine.get("revision"), int):
        return f"r{routine['revision']}"
    return "L" + _digest(config_of(task))


def _status_of(task: dict) -> dict:
    status = (task.get("routine") or {}).get("status") or {}
    return {"skipped": dict(status.get("skipped") or {}), "check_trouble": list(status.get("check_trouble") or []),
            "failure_streak": int(status.get("failure_streak") or 0), "weekly": dict(status.get("weekly") or {}),
            "wake_at": status.get("wake_at"), "queued": bool(status.get("queued")),
            "held_until": status.get("held_until"), "deferred_since": status.get("deferred_since")}


def bounded(text, limit: int):
    text = "" if text is None else str(text)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def run_view(run: dict) -> dict:
    """One run as the API returns it: the canonical status and the legacy
    outcome side by side, output and error bounded."""
    status = task_module.automation_status(run)
    ran_at = run.get("ran_at")
    return {"id": run["id"], "routine_id": run.get("task_id"), "name": run.get("task_name"), "status": status,
            "outcome": run.get("outcome") or ("failed" if run.get("error") else "succeeded"),
            "scheduled_for": run.get("scheduled_for"), "started_at": run.get("started_at"),
            "finished_at": ran_at if status not in ("queued", "running", "waiting") else None,
            "duration_seconds": run.get("duration_seconds"), "late_seconds": run.get("late_seconds"),
            "trigger_type": run.get("trigger_type") or run.get("source") or "schedule",
            "event_ref": run.get("event_ref"), "retry_cause": run.get("retry_cause"),
            "retry_count": run.get("retry_count") or 0, "execution_thread_id": run.get("execution_thread_id"),
            "destination": run.get("destination"), "attention": run.get("attention"), "seen": bool(run.get("seen")),
            "report_state": run.get("report_state"), "model_ran": run.get("model_ran"),
            "summary": bounded(run.get("summary"), 280) or None,
            "output": bounded(run.get("output"), OUTPUT_BOUND), "error": bounded(run.get("error"), ERROR_BOUND) or None,
            "missed_occurrences": run.get("missed_occurrences"), "run_id": run.get("run_id")}


def _runs_for(task_id: str) -> list[dict]:
    return task_service.list_runs(task_id)


def view(task: dict, runs: int = 5) -> dict:
    """The routine as the API and the editor see it."""
    config = config_of(task)
    schedule = config["schedule"]
    history = _runs_for(task["id"])
    try:
        from core import task_scheduler
        working = task_scheduler.run_in_progress(task["id"])
    except Exception:
        working = False
    needs_you = any(r.get("attention") and not r.get("seen") for r in history[:10])
    waiting = bool(history and task_module.automation_status(history[0]) == "waiting")
    done = (not config["enabled"] and schedule and schedule["kind"] in ("once", "limit_reset")
            and not task.get("next_run_at") and bool(history))
    if needs_you or waiting:
        state = "needs_you"
    elif not config["enabled"]:
        state = "done" if done else "paused"
    else:
        state = "working"
    sentence = bot_schedules.describe(schedule) if schedule else "On a schedule"
    return {"id": task["id"], "bot_id": task.get("agent_id"), "owner": task.get("owner_user"),
            "name": config["name"], "instructions": config["prompt"], "enabled": config["enabled"],
            "report": config["report_when"], "schedule": schedule, "sentence": sentence,
            "next_run_at": task.get("next_run_at") if config["enabled"] else None,
            "overlap": config["overlap"], "access": config["access"], "deliver": config["deliver"],
            "duration_minutes": config["duration_minutes"], "timeout_minutes": config["timeout_minutes"],
            "continuity": config["continuity"], "call": config["call"], "run_on_startup": config["run_on_startup"],
            "attachments": config["attachments"], "checks": config["checks"],
            "source_thread_id": config["source_thread_id"], "results_thread_id": config["results_thread_id"],
            "revision": revision_of(task), "legacy": not task.get("routine"), "state": state,
            "status": _status_of(task), "running": working, "waiting": waiting,
            "recent_runs": [run_view(r) for r in history[:runs]],
            "last_run": run_view(history[0]) if history else None, "created_at": task.get("created_at")}


def list_routines(owner: str, is_admin: bool, bot_id: Optional[str] = None, start: Optional[float] = None,
                  end: Optional[float] = None) -> list[dict]:
    """The caller's routines (newest first). With a time range, each also
    lists its occurrences inside it, for the calendar."""
    out = []
    for task in task_service.list_tasks():
        if not is_routine(task) or not owned_by(task, owner, is_admin) or (bot_id and task.get("agent_id") != bot_id):
            continue
        row = view(task)
        if start is not None and end is not None and row["schedule"] and row["enabled"]:
            row["occurrences"] = occurrences(row["schedule"], start, end)
        out.append(row)
    return out


def occurrences(schedule: dict, start: float, end: float, limit: int = 300) -> list[str]:
    reset = None
    if schedule["kind"] == "limit_reset":
        from services import bot_limit_resets
        reset = bot_limit_resets.reset_time(schedule.get("endpoint_id"))
        found = bot_schedules.next_times(schedule, start - 1, 1, reset)
        return [m.isoformat() for m in found if start <= m.timestamp() <= end]
    return [m.isoformat() for m in bot_schedules.occurrences_between(schedule, start - 1, end, limit)]


def get_routine(owner: str, is_admin: bool, routine_id: str) -> dict:
    task = task_service.get_task(routine_id)
    if not is_routine(task) or not owned_by(task, owner, is_admin):
        raise RoutineError("routine not found", 404, "not_found")
    return view(task, runs=20)


# -- validating ---------------------------------------------------------------------------

def _clean_text(value, field: str, limit: int, label: str) -> str:
    text = " ".join(str(value or "").split()) if field == "name" else str(value or "").strip()
    if not text or len(text) > limit:
        raise RoutineError(f"A routine needs a {label} of 1 to {limit} characters.", 400, field=field)
    return text


def _thread(owner: Optional[str], bot_id: str, thread_id, field: str) -> Optional[str]:
    if thread_id in (None, ""):
        return None
    from core.session_manager import session_manager
    session = session_manager.get_session(str(thread_id)) if isinstance(thread_id, str) else None
    mine = session and session.get("agent_id") == bot_id and (
        not session.get("owner_user") or not owner or session.get("owner_user") == owner)
    if not mine:
        raise RoutineError("That conversation was not found for this bot.", 404, "not_found", field)
    return thread_id


def _attachments(values) -> list[str]:
    if values in (None, []):
        return []
    if not isinstance(values, list) or len(values) > MAX_ATTACHMENTS or any(
            not isinstance(v, str) or not v or len(v) > 80 for v in values):
        raise RoutineError(f"Attachments are a list of up to {MAX_ATTACHMENTS} files.", 400, field="attachments")
    from core import attachments
    missing = [v for v in values if attachments.staged_file_info(v) is None]
    if missing:
        raise RoutineError("One of the attached files is no longer available.", 400, field="attachments")
    return list(dict.fromkeys(values))


def normalize_config(raw: dict, *, partial: bool = False, owner: Optional[str] = None, bot_id: Optional[str] = None,
                     bot_request: bool = False, now: Optional[float] = None) -> dict:
    """Validate a routine request. `partial` keeps only the keys given.
    `bot_request` restricts it to what a bot may set. Accepts `instructions`
    as the name for `prompt` and `report` for `report_when`."""
    if not isinstance(raw, dict):
        raise RoutineError("The routine needs details.")
    raw = dict(raw)
    if "instructions" in raw:
        raw["prompt"] = raw.pop("instructions")
    if "report" in raw:
        raw["report_when"] = raw.pop("report")
    allowed = BOT_KEYS if bot_request else CONFIG_KEYS
    unknown = [k for k in raw if k not in allowed]
    if unknown:
        raise RoutineError(f"Unknown routine setting: {', '.join(sorted(unknown))}.", 400, field=sorted(unknown)[0])
    out: dict = {}
    if "name" in raw or not partial:
        out["name"] = _clean_text(raw.get("name"), "name", MAX_NAME, "name")
    if "prompt" in raw or not partial:
        out["prompt"] = _clean_text(raw.get("prompt"), "prompt", MAX_PROMPT, "set of instructions")
    if "schedule" in raw or not partial:
        try:
            out["schedule"] = bot_schedules.normalize(raw.get("schedule"), now)
        except bot_schedules.ScheduleError as error:
            raise RoutineError(error.message, 400, field=error.field)
    if raw.get("report_when") is not None:
        if raw["report_when"] not in REPORTS:
            raise RoutineError("Report is notable or always.", 400, field="report_when")
        out["report_when"] = raw["report_when"]
    if raw.get("overlap") is not None:
        if raw["overlap"] not in OVERLAPS:
            raise RoutineError("Overlap is skip or queue.", 400, field="overlap")
        out["overlap"] = raw["overlap"]
    if raw.get("access") is not None:
        if raw["access"] not in ACCESS:
            raise RoutineError("Access is normal or read-and-draft.", 400, field="access")
        out["access"] = raw["access"]
    if raw.get("deliver") is not None:
        if not isinstance(raw["deliver"], str) or not raw["deliver"].strip() or len(raw["deliver"]) > 40:
            raise RoutineError("Deliver names where the result goes.", 400, field="deliver")
        out["deliver"] = raw["deliver"].strip()
    for key in ("duration_minutes", "timeout_minutes"):
        if raw.get(key) is not None:
            if type(raw[key]) is not int or not 5 <= raw[key] <= 240:
                raise RoutineError(f"{key.replace('_', ' ').capitalize()} is a whole number from 5 to 240.", 400, field=key)
            out[key] = raw[key]
        elif key in raw and partial:
            out[key] = None
    for key in ("continuity", "call", "enabled", "run_on_startup"):
        if raw.get(key) is not None:
            if not isinstance(raw[key], bool):
                raise RoutineError(f"{key.replace('_', ' ').capitalize()} is true or false.", 400, field=key)
            out[key] = raw[key]
    if "checks" in raw:
        checks = raw["checks"] or []
        if not isinstance(checks, list) or any(c not in CHECK_KINDS for c in checks):
            raise RoutineError(f"Checks are any of: {', '.join(CHECK_KINDS)}.", 400, field="checks")
        out["checks"] = list(dict.fromkeys(checks))
    if "attachments" in raw:
        out["attachments"] = _attachments(raw["attachments"])
    for key in ("source_thread_id", "results_thread_id"):
        if key in raw:
            out[key] = _thread(owner, bot_id, raw[key], key) if bot_id else raw[key]
    if partial and not out:
        raise RoutineError("Nothing to change: give at least one setting.")
    return out


# -- writing ------------------------------------------------------------------------------

def _backup_once() -> None:
    """Before the first routine write, keep a copy of tasks.json."""
    if not os.path.exists(BACKUP_FILE) and os.path.exists(task_module.TASKS_FILE):
        try:
            shutil.copyfile(task_module.TASKS_FILE, BACKUP_FILE)
        except OSError:
            pass


def _materialize(task: dict) -> dict:
    """Give an old goal its routine object (nothing else changes)."""
    if task.get("routine"):
        return task["routine"]
    _backup_once()
    config = config_of(task)
    task["routine"] = {"schema_version": SCHEMA_VERSION, "revision": 0, "status": {},
                       **{k: config[k] for k in CONFIG_KEYS if k not in ("name", "prompt", "enabled", "report_when")}}
    return task["routine"]


def _sync_legacy(task: dict) -> None:
    """Keep the old task columns in step with the schedule."""
    schedule = task["routine"]["schedule"]
    task.update(bot_schedules.legacy_fields(schedule))
    for key in ("time_zone", "weekdays"):
        task.pop(key, None)
    if schedule.get("time_zone"):
        task["time_zone"] = schedule["time_zone"]
    if schedule.get("weekdays"):
        task["weekdays"] = list(schedule["weekdays"])


def _apply(task: dict, changes: dict, *, bump: bool = True, reset_next: Optional[bool] = None) -> None:
    routine = _materialize(task)
    for key in ("name", "prompt", "enabled", "report_when"):
        if key in changes:
            task[key] = changes[key]
    for key in CONFIG_KEYS:
        if key in changes and key not in ("name", "prompt", "enabled", "report_when"):
            routine[key] = copy.deepcopy(changes[key])
    if "schedule" in changes:
        _sync_legacy(task)
    schedule_touched = "schedule" in changes or changes.get("enabled") is True
    if schedule_touched if reset_next is None else reset_next:
        if task.get("enabled"):
            task["next_run_at"] = task_service.routine_next(task)
        elif "schedule" in changes:
            task["next_run_at"] = None
    if changes.get("enabled") is False:
        routine.setdefault("status", {}).pop("queued", None)
    if bump:
        routine["revision"] = int(routine.get("revision") or 0) + 1
    task_service._save_tasks()


def _check_once_enable(config: dict, task: dict) -> None:
    schedule = config.get("schedule") or (config_of(task)["schedule"])
    if config.get("enabled") is True and schedule and schedule["kind"] == "once":
        at = datetime.fromisoformat(schedule["at"]).timestamp()
        if at <= time.time():
            raise RoutineError("This one-time routine has already had its time. Make a new one instead.", 400)


def _legacy_task_args(config: dict) -> dict:
    return bot_schedules.legacy_fields(config["schedule"])


def create(owner: str, bot_id: str, spec: dict, *, application_id: Optional[str] = None,
           origin_session_id: Optional[str] = None) -> dict:
    """A new routine. `spec` is already normalized (normalize_config)."""
    from services.agent_service import agent_service
    if agent_service.get(bot_id) is None:
        raise RoutineError("That bot was not found.", 404, "not_found", "bot_id")
    with _LOCK:
        if application_id:
            for task in task_service.list_tasks():
                if (task.get("routine") or {}).get("application_id") == application_id:
                    return task
        mine = [t for t in task_service.list_tasks() if is_routine(t) and t.get("agent_id") == bot_id
                and (t.get("owner_user") or owner) == owner]
        if len(mine) >= MAX_ROUTINES_PER_BOT:
            raise RoutineError(f"This bot already has {MAX_ROUTINES_PER_BOT} routines. Delete one first.", 409, "limit")
        if any(t.get("name") == spec["name"] for t in mine):
            raise RoutineError(f'A routine named "{spec["name"]}" already exists. Change that one instead.', 409, "duplicate", "name")
        config = {**copy.deepcopy(DEFAULTS), **spec}
        config.setdefault("enabled", True)
        config.setdefault("report_when", "notable")
        if config["enabled"]:
            _check_once_enable(config, {})
        _backup_once()
        first = bot_schedules.next_after(config["schedule"], time.time(),
                                         _reset_for(config["schedule"])) if config["enabled"] else None
        routine = {"schema_version": SCHEMA_VERSION, "revision": 1, "status": {},
                   **{k: config[k] for k in CONFIG_KEYS if k not in ("name", "prompt", "enabled", "report_when")},
                   "next_run_at": first.isoformat() if first else None}
        if application_id:
            routine["application_id"] = application_id
        legacy = bot_schedules.legacy_fields(config["schedule"])
        try:
            task = task_service.create_task(
                config["name"], config["prompt"], legacy["schedule_kind"], run_at=legacy["run_at"],
                interval_seconds=legacy["interval_seconds"], run_time=legacy["run_time"], agent_id=bot_id,
                report_when=config["report_when"], enabled=config["enabled"], owner_user=owner,
                origin_session_id=origin_session_id, routine=routine,
                time_zone=config["schedule"].get("time_zone"), weekdays=config["schedule"].get("weekdays"))
        except ValueError as error:
            raise RoutineError(str(error))
        if first is None and config["enabled"] and config["schedule"]["kind"] != "limit_reset":
            task_service.delete_task(task["id"])
            raise RoutineError("This schedule has no upcoming time.", 400, field="schedule")
        return task


def _reset_for(schedule: dict) -> Optional[float]:
    if schedule["kind"] != "limit_reset":
        return None
    from services import bot_limit_resets
    return bot_limit_resets.reset_time(schedule.get("endpoint_id"))


def create_for_owner(owner: str, bot_id: str, raw: dict, origin_session_id: Optional[str] = None) -> dict:
    spec = normalize_config(raw, owner=owner, bot_id=bot_id)
    return view(create(owner, bot_id, spec, origin_session_id=origin_session_id))


def _writable(owner: str, is_admin: bool, routine_id: str, expected_revision: Optional[str]) -> dict:
    task = task_service.get_task(routine_id)
    if not is_routine(task) or not owned_by(task, owner, is_admin):
        raise RoutineError("routine not found", 404, "not_found")
    if expected_revision is not None and expected_revision != revision_of(task):
        raise RoutineError("This routine changed since you opened it. Reload it and try again.", 409, "stale")
    return task


def patch(owner: str, is_admin: bool, routine_id: str, raw: dict, expected_revision: Optional[str] = None) -> dict:
    with _LOCK:
        task = _writable(owner, is_admin, routine_id, expected_revision)
        changes = normalize_config(raw, partial=True, owner=owner, bot_id=task["agent_id"])
        _check_once_enable(changes, task)
        _apply(task, changes)
        return view(task)


def delete(owner: str, is_admin: bool, routine_id: str, expected_revision: Optional[str] = None) -> dict:
    """Soft delete: kept seven days so it can be restored."""
    with _LOCK:
        task = _writable(owner, is_admin, routine_id, expected_revision)
        _trash(task)
        _cancel_active(task["id"])
        task_service.delete_task(task["id"])
        return {"ok": True, "id": routine_id, "restorable_until": time.time() + TRASH_SECONDS}


def _trash(task: dict) -> None:
    items = [i for i in read_json(TRASH_FILE, []) if i.get("deleted_at", 0) > time.time() - TRASH_SECONDS]
    items.append({"deleted_at": time.time(), "task": copy.deepcopy(task)})
    write_json_atomic(TRASH_FILE, items[-TRASH_MAX:])


def restore_deleted(owner: str, is_admin: bool, routine_id: str) -> dict:
    with _LOCK:
        items = read_json(TRASH_FILE, [])
        found = next((i for i in items if i["task"]["id"] == routine_id
                      and i.get("deleted_at", 0) > time.time() - TRASH_SECONDS), None)
        if found is None or not owned_by(found["task"], owner, is_admin):
            raise RoutineError("There is nothing to restore.", 404, "not_found")
        if routine_id in task_service._tasks:
            raise RoutineError("Something already uses that place.", 409, "stale")
        task = copy.deepcopy(found["task"])
        for key in ("run_started_at", "active_run_id", "run_for", "run_source", "run_extra"):
            task.pop(key, None)
        task_service._tasks[routine_id] = task
        if task.get("enabled") and task.get("routine"):
            task["next_run_at"] = task_service.routine_next(task)
        task_service._save_tasks()
        write_json_atomic(TRASH_FILE, [i for i in items if i is not found])
        return view(task)


def _cancel_active(task_id: str) -> None:
    from core import task_scheduler
    task_scheduler.stop_run(task_id)


def delete_for_bot(bot_id: str) -> int:
    """A bot deleted: its routines go (agent_service already clears goals);
    cancel anything queued or running for it."""
    count = 0
    for task in list(task_service.list_tasks()):
        if task.get("agent_id") == bot_id and task.get("schedule_kind") != "card":
            _cancel_active(task["id"])
            task_service.delete_task(task["id"])
            count += 1
    return count


# -- previews --------------------------------------------------------------------------------

def preview(raw_schedule: dict, count: int = 3) -> dict:
    """The sentence and next occurrences for a schedule, validated the same way
    a save would be, or the field error."""
    try:
        schedule = bot_schedules.normalize(raw_schedule)
    except bot_schedules.ScheduleError as error:
        raise RoutineError(error.message, 400, field=error.field)
    return {**bot_schedules.preview(schedule, count=count, reset_at=_reset_for(schedule)), "schedule": schedule}


# -- running by hand -------------------------------------------------------------------------

async def run_now(owner: str, is_admin: bool, routine_id: str, request_id: Optional[str] = None) -> dict:
    """Start a run now. The same request id twice starts one run."""
    from core import task_scheduler
    task = _writable(owner, is_admin, routine_id, None)
    now = time.time()
    for key in [k for k, (at, _) in _recent_requests.items() if now - at > 300]:
        _recent_requests.pop(key, None)
    key = f"{routine_id}|{request_id}"
    if request_id and key in _recent_requests:
        found = next((r for r in _runs_for(routine_id) if r["id"] == _recent_requests[key][1]), None)
        return {"started": False, "duplicate": True, "run": run_view(found) if found else None}
    if task_scheduler.run_in_progress(routine_id):
        raise RoutineError("This routine is already running.", 409, "running")
    work = task_scheduler.start_in_background(task, "manual")
    for _ in range(40):
        live = task_service.get_task(routine_id) or {}
        if live.get("active_run_id") or work.done():
            break
        import asyncio
        await asyncio.sleep(0.05)
    run_id = (task_service.get_task(routine_id) or {}).get("active_run_id")
    history = _runs_for(routine_id)
    found = next((r for r in history if r["id"] == run_id), None) or (history[0] if history else None)
    if request_id and found:
        _recent_requests[key] = (now, found["id"])
    return {"started": True, "run": run_view(found) if found else None}


def defer(owner: str, is_admin: bool, routine_id: str) -> dict:
    """Skip the next occurrence only; the one after it is unchanged."""
    with _LOCK:
        task = _writable(owner, is_admin, routine_id, None)
        if not task.get("enabled") or not task.get("next_run_at"):
            raise RoutineError("This routine has no next run to skip.", 409, "no_next")
        schedule = config_of(task)["schedule"]
        if schedule["kind"] == "once":
            raise RoutineError("A one-time routine has no later run. Pause it instead.", 409, "no_next")
        after = datetime.fromisoformat(task["next_run_at"]).timestamp()
        following = bot_schedules.next_after(schedule, after, _reset_for(schedule))
        if following is None:
            raise RoutineError("There is no later run to move to.", 409, "no_next")
        _materialize(task)
        task["next_run_at"] = following.isoformat()
        task_service._save_tasks()
        return view(task)


def move_next_run(owner: str, is_admin: bool, routine_id: str, when: float, expected_revision: Optional[str] = None) -> dict:
    """Move only the next occurrence to `when` (after a limit reset). The
    schedule after that run is unchanged."""
    with _LOCK:
        task = _writable(owner, is_admin, routine_id, expected_revision)
        if not task.get("enabled"):
            raise RoutineError("This routine is paused.", 409, "paused")
        _materialize(task)
        task["next_run_at"] = datetime.fromtimestamp(when, timezone.utc).isoformat()
        task_service._save_tasks()
        return view(task)


def continue_after_reset(owner: str, bot_id: str, thread_id: str, endpoint_id: str, title: str = "") -> dict:
    """"Continue when your limit resets": one once-only limit_reset routine in
    that conversation. The bot picks up where the stopped turn left off."""
    name = _clean_text(f'Continue "{(title or "this conversation").strip()[:50]}"', "name", MAX_NAME, "name")
    spec = normalize_config({"name": name, "prompt": "Pick up where you left off in this conversation and finish "
                             "the work that was interrupted by the usage limit.",
                             "schedule": {"kind": "limit_reset", "endpoint_id": endpoint_id, "repeat": "once"},
                             "source_thread_id": thread_id, "results_thread_id": thread_id, "continuity": True},
                            owner=owner, bot_id=bot_id)
    return view(create(owner, bot_id, spec, origin_session_id=thread_id))


# -- run records -----------------------------------------------------------------------------

def _run_owned(owner: str, is_admin: bool, run_id: str) -> tuple[dict, dict]:
    run = next((r for r in task_service._runs if r["id"] == run_id), None)
    task = task_service.get_task((run or {}).get("task_id"))
    if run is None or task is None or not owned_by(task, owner, is_admin):
        raise RoutineError("run not found", 404, "not_found")
    return run, task


def cancel_run(owner: str, is_admin: bool, run_id: str) -> dict:
    """Cancel exactly this run, if it is the live one. Never retried."""
    from core import bot_routine_runner
    run, task = _run_owned(owner, is_admin, run_id)
    if task_module.automation_status(run) not in ("queued", "running", "waiting"):
        raise RoutineError("That run is not active.", 409, "not_active")
    if task.get("active_run_id") != run_id or not bot_routine_runner.cancel(task["id"], run_id):
        raise RoutineError("That run is not active.", 409, "not_active")
    return {"ok": True, "id": run_id}


def mark_seen(owner: str, is_admin: bool, run_id: str) -> dict:
    run, _ = _run_owned(owner, is_admin, run_id)
    run["seen"] = True
    task_service._save_runs()
    return run_view(run)


def seen_all(owner: str, is_admin: bool, bot_id: Optional[str] = None) -> dict:
    changed = 0
    mine = {t["id"] for t in task_service.list_tasks() if is_routine(t) and owned_by(t, owner, is_admin)
            and (not bot_id or t.get("agent_id") == bot_id)}
    for run in task_service._runs:
        if run.get("task_id") in mine and run.get("attention") and not run.get("seen"):
            run["seen"] = True
            changed += 1
    if changed:
        task_service._save_runs()
    return {"ok": True, "marked": changed}


def list_runs(owner: str, is_admin: bool, routine_id: str, limit: int = 30) -> list[dict]:
    task = task_service.get_task(routine_id)
    if not is_routine(task) or not owned_by(task, owner, is_admin):
        raise RoutineError("routine not found", 404, "not_found")
    return [run_view(r) for r in _runs_for(routine_id)[:limit]]


# -- events (webhooks and connected apps, unit U4) -----------------------------------------------

def _event_task(owner: str, bot_id: str, source: str, name: str, instructions: str, access: str = "normal") -> dict:
    """The hidden task an event source's runs belong to: never scheduled, never
    listed with routines, holding the pending batches."""
    for task in task_service.list_tasks():
        routine = task.get("routine") or {}
        if routine.get("kind") == "event" and routine.get("source") == source and task.get("agent_id") == bot_id \
                and (task.get("owner_user") or owner) == owner:
            task["prompt"], task["name"] = instructions, name
            routine["access"] = access
            return task
    task = task_service.create_task(name, instructions, "once", run_at="2000-01-01T00:00:00+00:00",
                                    agent_id=bot_id, enabled=False, owner_user=owner, report_when="always",
                                    routine={"kind": "event", "schema_version": SCHEMA_VERSION, "revision": 1,
                                             "source": source, "schedule": {"kind": "once", "at": "2000-01-01T00:00:00+00:00"},
                                             "access": access, "overlap": "queue", "checks": [], "deliver": "normal",
                                             "status": {"pending": [], "receipts": []}, **{
                                                 k: DEFAULTS[k] for k in ("duration_minutes", "timeout_minutes", "continuity",
                                                                         "call", "run_on_startup", "attachments",
                                                                         "source_thread_id", "results_thread_id")}})
    task["next_run_at"] = None
    return task


def enqueue_event(source, receipt_id: str, events: list, *, owner: Optional[str] = None, bot_id: Optional[str] = None,
                  name: Optional[str] = None, instructions: Optional[str] = None, access: str = "normal",
                  results_thread_id: Optional[str] = None) -> dict:
    """Unit U4's hand-off: `source` is its dict (kind, id, name, owner_user,
    agent_id, instructions, run_straight_away, taint ...), `events` are safe
    envelopes. Returns {"status": queued|merged|duplicate|skipped|refused,
    "run_id", "run_ref"}. Without Run straight away the batch waits on the
    board for the person's OK, as webhooks always have; with it the engine
    runs it (the turn is tainted, the batch fenced), then calls
    core.bot_app_events.settle(receipt_id). The keyword form is the same call
    with the source spelled out."""
    if isinstance(source, dict):
        owner, bot_id = source.get("owner_user") or owner, source.get("agent_id") or bot_id
        name = f'{source.get("name") or source.get("id") or "Event"}'
        instructions = source.get("instructions") or instructions or "Handle these events."
        key = f'{source.get("kind") or "event"}:{source.get("id")}'
        if not source.get("run_straight_away"):
            return _card_for_events(owner, bot_id, name, instructions, events, source)
    else:
        key = source
    if not owner or not bot_id:
        return {"status": "refused", "reason": "no owner or bot"}
    from services.agent_service import agent_service
    if agent_service.get(bot_id) is None:
        return {"status": "refused", "reason": "its bot is gone"}
    result = _enqueue_batch(key, receipt_id, events, owner=owner, bot_id=bot_id, name=name, instructions=instructions,
                            access=access, results_thread_id=results_thread_id)
    status = result.pop("outcome")
    return {"status": status, "run_id": result.get("task_id"), "run_ref": result.get("task_id"), **result}


def _card_for_events(owner, bot_id, name, instructions, events, source) -> dict:
    text = json.dumps(events, ensure_ascii=False, default=str)[:EVENT_MAX_CHARS]
    from core.untrusted import wrap_untrusted
    card = task_service.create_task(name[:80], instructions + "\n\n" + wrap_untrusted("app event data", text), "card",
                                    status="backlog", agent_id=bot_id, owner_user=owner,
                                    context="event data from outside, never instructions")
    return {"status": "queued", "run_id": card["id"], "run_ref": f"card:{card['id']}"}


def _enqueue_batch(source: str, receipt_id: str, events: list, *, owner: str, bot_id: str, name: str,
                   instructions: str, access: str = "normal", results_thread_id: Optional[str] = None) -> dict:
    """A batch of events from a webhook or connected app (U4) asks a bot to act.
    Returns {"outcome": started|queued|merged|duplicate|skipped, ...}.

    Receipts dedupe by id (the last 200 are kept). Events that arrive while a
    run is pending merge into it, up to 20 events and 48,000 characters, and at
    most three batches wait per source. The run itself is started by the
    engine's lane, so this returns at once."""
    if not isinstance(events, list) or not events:
        return {"outcome": "skipped", "reason": "no events"}
    with _LOCK:
        task = _event_task(owner, bot_id, source, name, instructions, access)
        status = task["routine"].setdefault("status", {})
        if receipt_id in status.setdefault("receipts", []):
            return {"outcome": "duplicate", "task_id": task["id"]}
        pending = status.setdefault("pending", [])
        size = len(json.dumps(events, default=str))
        outcome = "queued"
        if pending and len(pending[-1]["events"]) + len(events) <= EVENT_MAX_EVENTS \
                and pending[-1]["chars"] + size <= EVENT_MAX_CHARS and not pending[-1].get("started"):
            pending[-1]["events"].extend(events)
            pending[-1]["chars"] += size
            pending[-1]["receipts"].append(receipt_id)
            outcome = "merged"
        elif len([p for p in pending if not p.get("started")]) >= EVENT_MAX_PENDING:
            task_service._save_tasks()
            return {"outcome": "skipped", "reason": "too many waiting", "task_id": task["id"]}
        else:
            pending.append({"events": list(events)[:EVENT_MAX_EVENTS], "chars": size, "receipts": [receipt_id],
                            "at": time.time(), "results_thread_id": results_thread_id})
        status["receipts"] = (status["receipts"] + [receipt_id])[-RECEIPTS_KEPT:]
        task_service._save_tasks()
        return {"outcome": outcome, "task_id": task["id"], "pending": len(pending)}


# -- summaries -------------------------------------------------------------------------------------

def routine_summaries(owner: str, is_admin: bool) -> list[dict]:
    """One row per routine for the unified Automations list (U3 joins webhooks
    and app events to these): a plain sentence, a status word and the one fix
    that applies."""
    rows = []
    for row in list_routines(owner, is_admin):
        fix = None
        if row["state"] == "needs_you":
            last = row["last_run"] or {}
            fix = {"kind": "review_run", "label": "Review", "run_id": last.get("id")}
        elif row["status"]["check_trouble"]:
            fix = {"kind": "check_trouble", "label": "Fix the check", "checks": row["status"]["check_trouble"]}
        rows.append({"kind": "routine", "id": row["id"], "bot_id": row["bot_id"], "name": row["name"],
                     "sentence": row["sentence"], "state": row["state"], "enabled": row["enabled"],
                     "next_run_at": row["next_run_at"], "last_run": row["last_run"], "fix": fix, "routine": row})
    return rows


# -- the Phase 3 U5 backend ---------------------------------------------------------------------------

def _config_equal(a, b) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


class AutomationBackend:
    """The routines engine behind U5's cards (`services.bot_automation_changes.Backend`).
    Records are task dicts; the person's owner-only settings are never touched
    by a bot's request, and an Undo restores every setting the receipt saved."""
    kind = "routine"

    def get(self, owner, routine_id):
        task = task_service.get_task(routine_id)
        return task if is_routine(task) and (task.get("owner_user") or owner) == owner else None

    def list(self, owner, bot_id):
        return [t for t in task_service.list_tasks() if is_routine(t) and t.get("agent_id") == bot_id
                and (t.get("owner_user") or owner) == owner]

    def snapshot(self, record):
        config = config_of(record)
        return {k: copy.deepcopy(config[k]) for k in CONFIG_KEYS}

    def revision(self, record):
        return revision_of(record)

    def _refuse(self, error: RoutineError):
        from services.bot_automation_changes import ChangeRefused
        raise ChangeRefused(str(error), error.code if error.code != "invalid" else "invalid", error.status)

    def _spec(self, owner, bot_id, spec):
        try:
            return normalize_config(spec, partial=True, owner=owner, bot_id=bot_id, bot_request=True) if spec else {}
        except RoutineError as error:
            self._refuse(error)

    def create(self, owner, bot_id, spec, application_id):
        try:
            cleaned = normalize_config(spec, owner=owner, bot_id=bot_id, bot_request=True)
            return create(owner, bot_id, cleaned, application_id=application_id)
        except RoutineError as error:
            self._refuse(error)

    def find_application(self, owner, bot_id, application_id, spec):
        for task in task_service.list_tasks():
            if (task.get("routine") or {}).get("application_id") == application_id:
                return task
        return None

    def _checked(self, owner, routine_id, expected_revision, why):
        task = self.get(owner, routine_id)
        if task is None:
            from services.bot_automation_changes import NotFound
            raise NotFound("That routine no longer exists.")
        if revision_of(task) != expected_revision:
            from services.bot_automation_changes import ChangeRefused
            raise ChangeRefused(why, "stale")
        return task

    def update(self, owner, routine_id, patch_spec, expected_revision, application_id):
        with _LOCK:
            task = self._checked(owner, routine_id, expected_revision,
                                 "That routine changed in the meantime. Look at it again before changing it.")
            try:
                changes = normalize_config(patch_spec, partial=True, owner=owner, bot_id=task["agent_id"],
                                           bot_request=True)
                _check_once_enable(changes, task)
            except RoutineError as error:
                self._refuse(error)
            _apply(task, changes)
            task["routine"].setdefault("status", {})["last_application_id"] = application_id
            task_service._save_tasks()
            return task

    def replace(self, owner, routine_id, snapshot, expected_revision, application_id):
        with _LOCK:
            task = self._checked(owner, routine_id, expected_revision,
                                 "That routine changed after this change, so it was left as it is.")
            changes = {k: copy.deepcopy(snapshot[k]) for k in CONFIG_KEYS if k in snapshot}
            if "schedule" in changes and changes["schedule"]:
                changes["schedule"] = dict(changes["schedule"])
            _apply(task, changes, reset_next=True)
            return task

    def delete(self, owner, routine_id, expected_revision, application_id):
        with _LOCK:
            task = self._checked(owner, routine_id, expected_revision,
                                 "That routine changed in the meantime. Look at it again before deleting it.")
            _trash(task)
            _cancel_active(task["id"])
            task_service.delete_task(task["id"])

    def restore(self, owner, snapshot, application_id):
        with _LOCK:
            task = copy.deepcopy(snapshot)
            if task["id"] in task_service._tasks:
                from services.bot_automation_changes import ChangeRefused
                raise ChangeRefused("Something already uses that routine's place, so it was not restored.", "stale")
            for key in ("run_started_at", "active_run_id", "run_for", "run_source", "run_extra"):
                task.pop(key, None)
            _materialize(task)["application_id"] = application_id
            task_service._tasks[task["id"]] = task
            if task.get("enabled"):
                task["next_run_at"] = task_service.routine_next(task)
            task_service._save_tasks()
            return task

    def matches(self, record, patch_spec):
        try:
            want = normalize_config(patch_spec, partial=True, bot_request=True)
        except RoutineError:
            return False
        have = config_of(record)
        return all(_config_equal(have.get(k), v) for k, v in want.items())

    def describe(self, record):
        schedule = config_of(record)["schedule"]
        if not schedule:
            return "on a schedule"
        sentence = bot_schedules.describe(schedule)
        return sentence[0].lower() + sentence[1:]


def automation_backend() -> AutomationBackend:
    """What `services.bot_automation_changes.backend_for("routine")` loads."""
    return AutomationBackend()
