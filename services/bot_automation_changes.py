"""Bots redesign, Phase 3 unit U5: bot-made automation changes with Undo (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 5.3 and 9.

A bot can add, edit, pause, resume and delete its own routines and webhook
triggers. Each change applies at once (approval level governs execution, not
automation edits) and leaves a receipt the person can review and undo.

How a change stays correct:
- Write-ahead receipt. The receipt (trusted actor, request fingerprint, before
  snapshot, target revision, application id) is stored as "pending" BEFORE the
  target is touched, and finished as "applied" after. A crash in between is
  reconciled from the application id: the change either landed (receipt
  finishes) or did not (receipt fails); it never applies twice.
- Fingerprint retries. The same request from the same invocation returns the
  existing receipt instead of applying again.
- Revision-checked Undo. Undo restores configuration only while the target is
  still at the revision the receipt recorded, so it can never erase a later
  edit. It never refunds finished work, retracts a sent message or erases run
  history. A failed inverse leaves the receipt available for another try. A
  second Undo of an undone change is a no-op.
- Deletion keeps a tombstone (the full snapshot, secrets sealed) during the
  seven-day Undo window.
- The owner and the bot always come from the trusted turn context passed in by
  core/bot_automation_tools.py, never from model arguments. A bot manages only
  its own automations. Webhook addresses and credentials never enter a card, a
  fingerprint, a model result or the log.

Targets sit behind small backends so the engine owners can supply theirs
(see `Backend` below): U2's routine engine (`services.bot_routines.automation_backend()`),
U4's event triggers (`services.bot_app_triggers.automation_backend()`).
Until they exist, TaskRoutineBackend and WebhookTriggerBackend work on today's
task and trigger services for the schedules those support.
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR

logger = logging.getLogger(__name__)

CHANGES_FILE = os.path.join(DATA_DIR, "bot_automation_changes.json")
VERSION = 1
UNDO_WINDOW_SECONDS = 7 * 24 * 3600
KEEP_SECONDS = 30 * 24 * 3600
MAX_RECEIPTS_PER_OWNER = 300
MAX_ROUTINES_PER_BOT = 20
MAX_TRIGGERS_PER_BOT = 10
MAX_CHANGES_PER_HOUR = 30
DUPLICATE_WINDOW_SECONDS = 120

MAX_NAME = 80
MAX_PROMPT = 8000
MAX_TEMPLATE = 4000
MAX_CRON = 256
ROUTINE_ACTIONS = ("create", "update", "pause", "resume", "delete")
TRIGGER_ACTIONS = ROUTINE_ACTIONS
KINDS = ("routine", "trigger")
REPORTS = ("notable", "always")
OVERLAPS = ("skip", "queue")
ACCESS = ("normal", "read-and-draft")
# What a bot may set on a routine. Attachments, source and result threads and
# startup runs belong to the person's editor, never a model's request.
ROUTINE_FIELDS = ("name", "instructions", "schedule", "report", "overlap", "access", "duration_minutes",
                  "timeout_minutes", "continuity", "call", "enabled")
OWNER_ONLY_FIELDS = ("attachments", "source_thread_id", "results_thread_id", "run_on_startup", "checks", "deliver")


class ChangeRefused(Exception):
    """A change that was not applied; the text says why, for the model."""

    def __init__(self, message: str, code: str = "refused", status: int = 409):
        super().__init__(message)
        self.code, self.status = code, status


class Unsupported(ChangeRefused):
    def __init__(self, message: str):
        super().__init__(message, "unsupported", 409)


class NotFound(ChangeRefused):
    def __init__(self, message: str = "No change with that id."):
        super().__init__(message, "not_found", 404)


@dataclass(frozen=True)
class ChangeContext:
    """Who is changing what, from the trusted turn, never from arguments."""
    owner: str
    bot_id: str
    thread_id: Optional[str] = None
    run_id: Optional[str] = None
    invocation_id: Optional[str] = None
    tainted: bool = False
    unattended: bool = False


# -- schedules ---------------------------------------------------------------------

_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_CRON_FIELD = re.compile(r"^[0-9A-Za-z*/,\-L?]+$")


def _zone(name):
    if name in (None, ""):
        return None
    try:
        ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        raise ChangeRefused(f"time_zone must be an IANA name such as America/New_York, not {name!r}.", "invalid", 400)
    return str(name)


def _weekdays(days):
    if days in (None, []):
        return None
    if not isinstance(days, list) or any(type(d) is not int or not 0 <= d <= 6 for d in days):
        raise ChangeRefused("weekdays is a list of numbers, Monday=0 through Sunday=6.", "invalid", 400)
    return sorted(set(days))


def _instant(text, zone_name) -> datetime:
    try:
        moment = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        raise ChangeRefused("at must be a date and time such as 2026-11-02T09:00:00-05:00.", "invalid", 400)
    if moment.tzinfo is None:
        zone = ZoneInfo(zone_name) if zone_name else None
        moment = moment.replace(tzinfo=zone) if zone else moment.astimezone()
    return moment.astimezone(timezone.utc)


def normalize_schedule(raw, now: float | None = None) -> dict:
    """The design's tagged union (section 4.2), validated. Full cron parsing
    belongs to the routine engine; this refuses what is plainly malformed."""
    if not isinstance(raw, dict) or not isinstance(raw.get("kind"), str):
        raise ChangeRefused("schedule needs a kind: once, daily, interval, cron or limit_reset.", "invalid", 400)
    kind = raw["kind"]
    now = now if now is not None else time.time()
    zone = _zone(raw.get("time_zone"))
    if kind == "once":
        if not raw.get("at"):
            raise ChangeRefused("A once schedule needs at.", "invalid", 400)
        moment = _instant(raw["at"], zone)
        if moment.timestamp() <= now:
            raise ChangeRefused("That time has already passed. Pick a time in the future.", "invalid", 400)
        return {"kind": "once", "at": moment.isoformat()}
    if kind == "daily":
        match = _HHMM.match(str(raw.get("time") or ""))
        if not match:
            raise ChangeRefused("A daily schedule needs time as HH:MM.", "invalid", 400)
        out = {"kind": "daily", "time": f"{int(match.group(1)):02d}:{match.group(2)}", "time_zone": zone}
        days = _weekdays(raw.get("weekdays"))
        if days:
            out["weekdays"] = days
        return out
    if kind == "interval":
        every = raw.get("every_minutes")
        if type(every) is not int or not 5 <= every <= 1440:
            raise ChangeRefused("every_minutes is a whole number from 5 to 1440.", "invalid", 400)
        out = {"kind": "interval", "every_minutes": every, "time_zone": zone}
        for key in ("anchor_at", "ends_at"):
            if raw.get(key):
                out[key] = _instant(raw[key], zone).isoformat()
        days = _weekdays(raw.get("weekdays"))
        if days:
            out["weekdays"] = days
        window = raw.get("window")
        if window is not None:
            if (not isinstance(window, dict) or not _HHMM.match(str(window.get("start") or ""))
                    or not _HHMM.match(str(window.get("end") or ""))):
                raise ChangeRefused("window is {start, end} as HH:MM.", "invalid", 400)
            start, end = (int(x) for x in window["start"].split(":")), (int(x) for x in window["end"].split(":"))
            minutes = [h * 60 + m for h, m in (start, end)]
            if minutes[1] <= minutes[0] or minutes[1] - minutes[0] < every:
                raise ChangeRefused("A window stays within one day and is at least one interval long. "
                                    "For an overnight window make two routines.", "invalid", 400)
            out["window"] = {"start": window["start"], "end": window["end"]}
        return out
    if kind == "cron":
        expression = " ".join(str(raw.get("expression") or "").split())
        fields = expression.split(" ")
        if not expression or len(expression) > MAX_CRON or len(fields) != 5 or not all(_CRON_FIELD.match(f) for f in fields):
            raise ChangeRefused("cron needs five fields (minute hour day month weekday) and nothing else.", "invalid", 400)
        if not zone:
            raise ChangeRefused("A cron schedule needs a named time_zone such as America/New_York.", "invalid", 400)
        return {"kind": "cron", "expression": expression, "time_zone": zone}
    if kind == "limit_reset":
        endpoint = raw.get("endpoint_id")
        repeat = raw.get("repeat", "once")
        if not isinstance(endpoint, str) or not endpoint.strip() or repeat not in ("once", "every_reset"):
            raise ChangeRefused("A limit_reset schedule needs endpoint_id and repeat (once or every_reset).", "invalid", 400)
        return {"kind": "limit_reset", "endpoint_id": endpoint.strip(), "repeat": repeat}
    raise ChangeRefused("schedule kind is once, daily, interval, cron or limit_reset.", "invalid", 400)


_DAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def describe_schedule(schedule: dict) -> str:
    """One plain sentence for the receipt line."""
    kind = schedule.get("kind")
    zone = f" ({schedule['time_zone']})" if schedule.get("time_zone") else ""
    days = schedule.get("weekdays")
    on = f" on {', '.join(_DAYS[d] for d in days)}" if days else ""
    if kind == "once":
        return f"once at {schedule['at'][:16].replace('T', ' ')} UTC"
    if kind == "daily":
        return f"every day{on} at {schedule['time']}{zone}" if not days else f"{on[1:]} at {schedule['time']}{zone}"
    if kind == "interval":
        every = schedule["every_minutes"]
        text = f"every {every} minutes" if every % 60 else (f"every {every // 60} hours" if every > 60 else "every hour")
        window = schedule.get("window")
        return text + on + (f" between {window['start']} and {window['end']}" if window else "") + zone
    if kind == "cron":
        return f"on the schedule {schedule['expression']}{zone}"
    if kind == "limit_reset":
        return "when the usage limit resets" + (" each time" if schedule.get("repeat") == "every_reset" else "")
    return "on a schedule"


def normalize_routine(raw, *, partial: bool = False) -> dict:
    """A bot's routine request, validated. Returns the normalized spec (only the
    keys given when `partial`)."""
    if not isinstance(raw, dict):
        raise ChangeRefused("The routine needs details.", "invalid", 400)
    owned = [k for k in OWNER_ONLY_FIELDS if k in raw]
    if owned:
        raise ChangeRefused(f"{', '.join(owned)} can only be set by the person, in the routine editor. "
                            "Leave it out and tell them what to add.", "owner_only", 400)
    unknown = [k for k in raw if k not in ROUTINE_FIELDS]
    if unknown:
        raise ChangeRefused(f"Unknown routine setting: {', '.join(sorted(unknown))}.", "invalid", 400)
    spec: dict = {}
    if "name" in raw or not partial:
        name = " ".join(str(raw.get("name") or "").split())
        if not name or len(name) > MAX_NAME:
            raise ChangeRefused(f"A routine needs a name of 1 to {MAX_NAME} characters.", "invalid", 400)
        spec["name"] = name
    if "instructions" in raw or not partial:
        prompt = str(raw.get("instructions") or "").strip()
        if not prompt or len(prompt) > MAX_PROMPT:
            raise ChangeRefused(f"A routine needs instructions of 1 to {MAX_PROMPT} characters.", "invalid", 400)
        spec["prompt"] = prompt
    if "schedule" in raw or not partial:
        spec["schedule"] = normalize_schedule(raw.get("schedule"))
    if raw.get("report") is not None or (not partial and "report" in raw):
        if raw.get("report") not in REPORTS:
            raise ChangeRefused("report is notable or always.", "invalid", 400)
        spec["report_when"] = raw["report"]
    if raw.get("overlap") is not None:
        if raw["overlap"] not in OVERLAPS:
            raise ChangeRefused("overlap is skip or queue.", "invalid", 400)
        spec["overlap"] = raw["overlap"]
    if raw.get("access") is not None:
        if raw["access"] not in ACCESS:
            raise ChangeRefused("access is normal or read-and-draft.", "invalid", 400)
        spec["access"] = raw["access"]
    for key in ("duration_minutes", "timeout_minutes"):
        if raw.get(key) is not None:
            if type(raw[key]) is not int or not 5 <= raw[key] <= 240:
                raise ChangeRefused(f"{key} is a whole number from 5 to 240.", "invalid", 400)
            spec[key] = raw[key]
    for key in ("continuity", "call", "enabled"):
        if raw.get(key) is not None:
            if not isinstance(raw[key], bool):
                raise ChangeRefused(f"{key} is true or false.", "invalid", 400)
            spec[key] = raw[key]
    if partial and not spec:
        raise ChangeRefused("Nothing to change: give at least one setting.", "invalid", 400)
    return spec


def normalize_trigger(raw, *, partial: bool = False) -> dict:
    if not isinstance(raw, dict):
        raise ChangeRefused("The trigger needs details.", "invalid", 400)
    allowed = ("name", "instructions", "title", "events", "conditions", "enabled", "source", "config")
    unknown = [k for k in raw if k not in allowed]
    if unknown:
        hint = (" Whether it runs straight away, its address and its secret are the person's to set."
                if any(k in unknown for k in ("auto_run", "run_straight_away", "secret", "address", "url")) else "")
        raise ChangeRefused(f"Unknown trigger setting: {', '.join(sorted(unknown))}.{hint}", "invalid", 400)
    spec: dict = {}
    if "config" in raw:
        config = raw["config"]
        if not isinstance(config, dict) or len(json.dumps(config)) > 2000:
            raise ChangeRefused("config is a small object of event-source settings.", "invalid", 400)
        spec["config"] = copy.deepcopy(config)
    if "name" in raw or not partial:
        name = " ".join(str(raw.get("name") or "").split())
        if not name or len(name) > MAX_NAME:
            raise ChangeRefused(f"A trigger needs a name of 1 to {MAX_NAME} characters.", "invalid", 400)
        spec["name"] = name
    if "instructions" in raw or not partial:
        text = str(raw.get("instructions") or "").strip()
        if not text or len(text) > MAX_TEMPLATE:
            raise ChangeRefused(f"A trigger needs instructions of 1 to {MAX_TEMPLATE} characters.", "invalid", 400)
        spec["prompt_template"] = text
    if "title" in raw:
        spec["title_template"] = str(raw.get("title") or "").strip()[:200]
    if "events" in raw:
        events = raw["events"]
        if not isinstance(events, list) or len(events) > 20 or any(not isinstance(e, str) or not e.strip() or len(e) > 100 for e in events):
            raise ChangeRefused("events is a list of up to 20 event names.", "invalid", 400)
        spec["events"] = [e.strip() for e in events]
    if "conditions" in raw:
        conditions = raw["conditions"]
        if (not isinstance(conditions, list) or len(conditions) > 10 or any(
                not isinstance(c, dict) or not str(c.get("path") or "").strip() or len(str(c.get("path"))) > 200
                for c in conditions)):
            raise ChangeRefused("conditions is a list of up to 10 {path, equals}.", "invalid", 400)
        spec["conditions"] = [{"path": str(c["path"]).strip(), "equals": str(c.get("equals", ""))[:200]} for c in conditions]
    if raw.get("enabled") is not None:
        if not isinstance(raw["enabled"], bool):
            raise ChangeRefused("enabled is true or false.", "invalid", 400)
        spec["enabled"] = raw["enabled"]
    if raw.get("source") not in (None, "webhook", "app"):
        raise ChangeRefused("source is webhook or app.", "invalid", 400)
    if partial and not spec:
        raise ChangeRefused("Nothing to change: give at least one setting.", "invalid", 400)
    return spec


# -- backends ----------------------------------------------------------------------

class Backend:
    """What a target engine supplies. Records are plain dicts; the engine owns
    their shape except for these keys: `id`, `agent_id` (the owning bot), `name`,
    `enabled`.

    get(owner, id) -> record | None
    list(owner, bot_id) -> [record]
    snapshot(record) -> dict            configuration only (no run status), JSON-safe
    revision(record) -> str             changes whenever configuration changes
    create(owner, bot_id, spec, application_id) -> record     idempotent on application_id
    update(owner, id, patch, expected_revision, application_id) -> record
    delete(owner, id, expected_revision, application_id) -> None
    restore(owner, snapshot, application_id) -> record        put a deleted record back
    replace(owner, id, snapshot, expected_revision, application_id) -> record   restore configuration
    find_application(owner, bot_id, application_id, spec) -> record | None      crash recovery for create
    matches(record, patch) -> bool      crash recovery for update
    describe(record) -> str             a plain sentence for the receipt
    """
    kind = ""


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()[:16]


ROUTINE_CONFIG_KEYS = ("name", "prompt", "enabled", "schedule_kind", "run_at", "interval_seconds", "run_time",
                       "time_zone", "weekdays", "report_when", "deliver_to_channel")


class TaskRoutineBackend(Backend):
    """Routines as today's bot goals (services/task_service.py): once, daily and
    interval schedules. Anything the routine engine adds (cron, windows, overlap,
    read-and-draft, calls) is refused clearly until that engine's backend exists."""
    kind = "routine"

    @staticmethod
    def _service():
        from services.task_service import task_service
        return task_service

    def get(self, owner, routine_id):
        task = self._service().get_task(routine_id)
        if task and task.get("schedule_kind") != "card" and task.get("agent_id") \
                and (task.get("owner_user") or owner) == owner:
            return task
        return None

    def list(self, owner, bot_id):
        return [t for t in self._service().list_tasks() if t.get("agent_id") == bot_id
                and t.get("schedule_kind") != "card" and (t.get("owner_user") or owner) == owner]

    def snapshot(self, record):
        return {k: copy.deepcopy(record[k]) for k in ROUTINE_CONFIG_KEYS if k in record}

    def revision(self, record):
        routine = record.get("routine") or {}
        if isinstance(routine.get("revision"), int):
            return f"r{routine['revision']}"
        return _digest(self.snapshot(record))

    @staticmethod
    def _fields(spec: dict) -> dict:
        extra = [k for k in ("overlap", "access", "duration_minutes", "timeout_minutes", "continuity", "call") if k in spec]
        if extra:
            raise Unsupported(f"{', '.join(extra)} needs the full routines engine, which is not available here. "
                              "Leave it out, or ask the person to set it in the routine editor.")
        out: dict = {}
        if "name" in spec:
            out["name"] = spec["name"]
        if "prompt" in spec:
            out["prompt"] = spec["prompt"]
        if "report_when" in spec:
            out["report_when"] = spec["report_when"]
        if "enabled" in spec:
            out["enabled"] = spec["enabled"]
        schedule = spec.get("schedule")
        if schedule:
            kind = schedule["kind"]
            if kind == "once":
                out.update(schedule_kind="once", run_at=schedule["at"], interval_seconds=None, run_time=None,
                           time_zone=None, weekdays=None)
            elif kind == "daily":
                out.update(schedule_kind="daily", run_time=schedule["time"], time_zone=schedule.get("time_zone"),
                           weekdays=schedule.get("weekdays"), interval_seconds=None, run_at=None)
            elif kind == "interval":
                if any(k in schedule for k in ("window", "weekdays", "ends_at", "anchor_at")):
                    raise Unsupported("Interval windows, weekday limits and anchors need the full routines engine.")
                out.update(schedule_kind="interval", interval_seconds=schedule["every_minutes"] * 60,
                           run_at=None, run_time=None, time_zone=None, weekdays=None)
            else:
                raise Unsupported(f"{kind} schedules need the full routines engine, which is not available here. "
                                  "Use once, daily or interval.")
        return out

    def create(self, owner, bot_id, spec, application_id):
        service = self._service()
        existing = self.find_application(owner, bot_id, application_id, spec)
        if existing:
            return existing
        fields = self._fields(spec)
        try:
            task = service.create_task(
                fields["name"], fields["prompt"], fields["schedule_kind"], run_at=fields.get("run_at"),
                interval_seconds=fields.get("interval_seconds"), run_time=fields.get("run_time"),
                agent_id=bot_id, report_when=fields.get("report_when"), time_zone=fields.get("time_zone"),
                weekdays=fields.get("weekdays"), owner_user=owner, enabled=spec.get("enabled", True))
        except ValueError as error:
            raise ChangeRefused(str(error), "invalid", 400)
        task["routine_application_id"] = application_id
        service._save_tasks()
        return task

    def find_application(self, owner, bot_id, application_id, spec):
        for task in self._service().list_tasks():
            if task.get("routine_application_id") == application_id:
                return task
        return None

    def update(self, owner, routine_id, patch, expected_revision, application_id):
        service = self._service()
        task = self.get(owner, routine_id)
        if task is None:
            raise NotFound("That routine no longer exists.")
        if self.revision(task) != expected_revision:
            raise ChangeRefused("That routine changed in the meantime. Look at it again before changing it.", "stale")
        fields = self._fields(patch)
        return self._write(service, task, fields)

    def replace(self, owner, routine_id, snapshot, expected_revision, application_id):
        service = self._service()
        task = self.get(owner, routine_id)
        if task is None:
            raise NotFound("That routine no longer exists.")
        if self.revision(task) != expected_revision:
            raise ChangeRefused("That routine changed after this change, so it was left as it is.", "stale")
        return self._write(service, task, dict(snapshot), exact=True)

    def _write(self, service, task, fields, exact=False):
        from services import task_service as module
        candidate = {**task, **fields}
        try:
            module._schedule_zone(candidate.get("time_zone"))
            candidate["weekdays"] = module._schedule_weekdays(candidate.get("weekdays"))
            if candidate["schedule_kind"] == "daily":
                module._parse_hhmm(candidate["run_time"])
            if candidate["schedule_kind"] == "once" and module._stamp_seconds(candidate.get("run_at")) is None:
                raise ValueError("run_at must be a date and time")
        except ValueError as error:
            raise ChangeRefused(str(error), "invalid", 400)
        if fields.get("enabled") is True and candidate["schedule_kind"] == "once":
            stamp = module._stamp_seconds(candidate.get("run_at"))
            if stamp is None or stamp <= time.time():
                raise ChangeRefused("This one-time routine has already run its time. Make a new one instead.", "invalid", 400)
        schedule_changed = any(k in fields for k in ("schedule_kind", "run_at", "interval_seconds", "run_time",
                                                       "time_zone", "weekdays"))
        for key, value in fields.items():
            if value is None and key in ("run_at", "interval_seconds", "run_time", "time_zone", "weekdays") and (
                    key not in task):
                continue
            task[key] = candidate["weekdays"] if key == "weekdays" else value
        if exact:
            for key in ROUTINE_CONFIG_KEYS:
                if key not in fields:
                    task.pop(key, None)
        if schedule_changed or fields.get("enabled") is True:
            task["next_run_at"] = self._next(module, task)
        service._save_tasks()
        return task

    @staticmethod
    def _next(module, task):
        kind = task["schedule_kind"]
        if kind == "daily":
            return module._next_daily(task["run_time"], task.get("time_zone"), task.get("weekdays"))
        if kind == "interval":
            return module._iso_in(task["interval_seconds"])
        if kind == "once":
            stamp = module._stamp_seconds(task.get("run_at"))
            if stamp is None or stamp <= time.time():
                task["enabled"] = False
            return task.get("run_at")
        return task.get("next_run_at")

    def delete(self, owner, routine_id, expected_revision, application_id):
        service = self._service()
        task = self.get(owner, routine_id)
        if task is None:
            raise NotFound("That routine no longer exists.")
        if self.revision(task) != expected_revision:
            raise ChangeRefused("That routine changed in the meantime. Look at it again before deleting it.", "stale")
        service.delete_task(routine_id)

    def restore(self, owner, snapshot, application_id):
        service = self._service()
        task = copy.deepcopy(snapshot)
        if task["id"] in service._tasks:
            raise ChangeRefused("Something already uses that routine's place, so it was not restored.", "stale")
        task["routine_application_id"] = application_id
        service._tasks[task["id"]] = task
        from services import task_service as module
        if task.get("enabled"):
            task["next_run_at"] = self._next(module, task)
        service._save_tasks()
        return task

    def matches(self, record, patch):
        want = self._fields(patch)
        snap = self.snapshot(record)
        return all(snap.get(k) == v for k, v in want.items())

    def describe(self, record):
        kind = record.get("schedule_kind")
        zone = f" ({record['time_zone']})" if record.get("time_zone") else ""
        if kind == "daily":
            days = record.get("weekdays")
            on = f" on {', '.join(_DAYS[d] for d in days)}" if days else ""
            return f"every day{on} at {record.get('run_time')}{zone}"
        if kind == "interval":
            minutes = (record.get("interval_seconds") or 0) // 60
            return f"every {minutes} minutes"
        if kind == "once":
            return f"once at {str(record.get('run_at'))[:16].replace('T', ' ')}"
        return "on a schedule"


TRIGGER_CONFIG_KEYS = ("name", "enabled", "events", "conditions", "title_template", "prompt_template", "action")


class WebhookTriggerBackend(Backend):
    """Webhook triggers (services/trigger_service.py). A trigger a bot makes
    creates board cards for that bot and waits for the person's OK; it can never
    set Run straight away, see its address or read its secret."""
    kind = "trigger"

    @staticmethod
    def _service():
        from services.trigger_service import trigger_service
        return trigger_service

    def get(self, owner, trigger_id):
        trigger = self._service().get(trigger_id)
        if trigger and (trigger.get("owner_user") or owner) == owner:
            return trigger
        return None

    def list(self, owner, bot_id):
        return [t for t in self._service().triggers() if t.get("agent_id") == bot_id
                and (t.get("owner_user") or owner) == owner]

    def snapshot(self, record):
        return {k: copy.deepcopy(record[k]) for k in TRIGGER_CONFIG_KEYS if k in record}

    def revision(self, record):
        return _digest(self.snapshot(record))

    def create(self, owner, bot_id, spec, application_id):
        service = self._service()
        existing = self.find_application(owner, bot_id, application_id, spec)
        if existing:
            return existing
        try:
            trigger, _secret = service.create(spec["name"], agent_id=bot_id, action="card", events=spec.get("events"),
                                              conditions=spec.get("conditions"), title_template=spec.get("title_template", ""),
                                              prompt_template=spec["prompt_template"], auto_run=False)
        except ValueError as error:
            raise ChangeRefused(str(error), "invalid", 400)
        # The secret is dropped here on purpose: the person copies the address
        # from Automations. It never reaches the model or the receipt.
        trigger["application_id"] = application_id
        trigger["owner_user"] = owner
        if spec.get("enabled") is False:
            trigger["enabled"] = False
        service._save()
        return trigger

    def find_application(self, owner, bot_id, application_id, spec):
        for trigger in self._service().triggers():
            if trigger.get("application_id") == application_id:
                return trigger
        return None

    def _check(self, owner, trigger_id, expected_revision, why):
        trigger = self.get(owner, trigger_id)
        if trigger is None:
            raise NotFound("That trigger no longer exists.")
        if self.revision(trigger) != expected_revision:
            raise ChangeRefused(why, "stale")
        return trigger

    def update(self, owner, trigger_id, patch, expected_revision, application_id):
        self._check(owner, trigger_id, expected_revision,
                    "That trigger changed in the meantime. Look at it again before changing it.")
        try:
            return self._service().update(trigger_id, **patch)
        except ValueError as error:
            raise ChangeRefused(str(error), "invalid", 400)

    def replace(self, owner, trigger_id, snapshot, expected_revision, application_id):
        self._check(owner, trigger_id, expected_revision, "That trigger changed after this change, so it was left as it is.")
        try:
            return self._service().update(trigger_id, **{k: v for k, v in snapshot.items() if k != "action"})
        except ValueError as error:
            raise ChangeRefused(str(error), "invalid", 400)

    def delete(self, owner, trigger_id, expected_revision, application_id):
        self._check(owner, trigger_id, expected_revision,
                    "That trigger changed in the meantime. Look at it again before deleting it.")
        self._service().delete(trigger_id)

    def restore(self, owner, snapshot, application_id):
        service = self._service()
        trigger = copy.deepcopy(snapshot)
        if trigger["id"] in service._triggers:
            raise ChangeRefused("Something already uses that trigger's place, so it was not restored.", "stale")
        trigger["application_id"] = application_id
        service._triggers[trigger["id"]] = trigger
        service._save()
        return trigger

    def matches(self, record, patch):
        snap = self.snapshot(record)
        return all(snap.get(k) == v for k, v in patch.items())

    def describe(self, record):
        events = record.get("events") or []
        return "for " + (", ".join(events[:3]) if events else "any event")


_backends: dict[str, Backend] = {}


def set_backend(kind: str, backend: Backend | None) -> None:
    """Install an engine's backend (or None to fall back). Tests use this too."""
    if backend is None:
        _backends.pop(kind, None)
    else:
        _backends[kind] = backend


def backend_for(kind: str, source: str = "webhook") -> Backend:
    if kind in _backends:
        return _backends[kind]
    module_name = {"routine": "services.bot_routines",
                   "trigger": "services.bot_app_triggers" if source == "app" else None}.get(kind)
    if module_name:
        try:
            module = __import__(module_name, fromlist=["automation_backend"])
            factory = getattr(module, "automation_backend", None)
            if callable(factory):
                return factory()
        except ImportError:
            pass
    if kind == "routine":
        return TaskRoutineBackend()
    if kind == "trigger" and source == "app":
        raise Unsupported("Connected-app events are not available here yet. A webhook trigger works.")
    if kind == "trigger":
        return WebhookTriggerBackend()
    raise ChangeRefused(f"Unknown automation kind {kind!r}.", "invalid", 400)


# -- the receipt store -------------------------------------------------------------

def _now() -> float:
    return time.time()


class ChangeStore:
    def __init__(self, path: str | None = None) -> None:
        self.path = path or CHANGES_FILE
        self._lock = threading.RLock()
        data = read_json(self.path, {})
        self._receipts: dict[str, dict] = {r["id"]: r for r in (data.get("receipts") or []) if isinstance(r, dict) and "id" in r}
        self._listeners = []

    def _save(self) -> None:
        cutoff = _now() - KEEP_SECONDS
        for receipt in self._receipts.values():
            if receipt.get("_full") and (receipt["state"] == "undone" or _now() >= receipt.get("undo_expires_at", 0)):
                receipt["_full"] = None  # the Undo window closed: drop the saved copy
        for rid in [i for i, r in self._receipts.items()
                    if r["state"] in ("undone", "failed") and (r.get("undone_at") or r.get("created_at") or 0) < cutoff]:
            del self._receipts[rid]
        write_json_atomic(self.path, {"version": VERSION, "receipts": list(self._receipts.values())})

    def add_listener(self, listener):
        self._listeners.append(listener)

    def _emit(self, event: str, receipt: dict) -> None:
        packet = {"type": "bot_automation_change", "event": event, "receipt": self.public(receipt)}
        for listener in list(self._listeners):
            try:
                listener(packet)
            except Exception:
                logger.exception("automation change listener failed")

    @staticmethod
    def public(receipt: dict) -> dict:
        shown = {k: copy.deepcopy(v) for k, v in receipt.items()
                 if not k.startswith("_") and k not in ("before", "after", "expected", "idem_key", "application_id",
                                                       "undo_application_id")}
        shown["undoable"] = (receipt["state"] == "applied" and receipt["action"] != "noop"
                             and _now() < receipt.get("undo_expires_at", 0))
        shown["undo_expired"] = receipt["state"] == "applied" and _now() >= receipt.get("undo_expires_at", 0)
        return shown

    # reading -------------------------------------------------------------------

    def get(self, receipt_id: str, owner: str) -> dict:
        with self._lock:
            receipt = self._receipts.get(receipt_id)
            if receipt is None or receipt["owner_user"] != owner:
                raise NotFound()
            return self.public(receipt)

    def list_receipts(self, owner: str, *, bot_id: str | None = None, thread_id: str | None = None,
                      limit: int = 50) -> list[dict]:
        with self._lock:
            found = [r for r in self._receipts.values() if r["owner_user"] == owner
                     and (bot_id is None or r["bot_id"] == bot_id) and (thread_id is None or r["thread_id"] == thread_id)
                     and r["state"] != "pending"]
            found.sort(key=lambda r: r["created_at"])
            return [self.public(r) for r in found[-max(1, min(limit, 200)):]]

    # applying ------------------------------------------------------------------

    def apply(self, ctx: ChangeContext, kind: str, action: str, request: dict | None = None,
              target_id: str | None = None, source: str = "webhook") -> dict:
        if kind not in KINDS:
            raise ChangeRefused("Unknown automation kind.", "invalid", 400)
        if action not in ROUTINE_ACTIONS:
            raise ChangeRefused(f"action is one of {', '.join(ROUTINE_ACTIONS)}.", "invalid", 400)
        if not ctx.owner or not ctx.bot_id:
            raise ChangeRefused("This needs a bot and a person from the conversation.", "no_context", 400)
        backend = backend_for(kind, source)
        request = request or {}
        # What the person's bot asked for, before anything is read or changed.
        if action == "create":
            spec = normalize_routine(request) if kind == "routine" else normalize_trigger(request)
            patch = None
        elif action in ("pause", "resume"):
            spec, patch = None, {"enabled": action == "resume"}
        elif action == "update":
            spec, patch = None, (normalize_routine(request, partial=True) if kind == "routine"
                                 else normalize_trigger(request, partial=True))
            patch.pop("source", None)
        else:
            spec, patch = None, None
        fingerprint = _digest({"owner": ctx.owner, "bot": ctx.bot_id, "kind": kind, "action": action,
                               "target": target_id, "spec": spec, "patch": patch})
        with self._lock:
            replay = self._replay(ctx, fingerprint)
            if replay is not None:
                return replay
            self._guard_rate(ctx)
            record = None
            if action == "create":
                limit = MAX_ROUTINES_PER_BOT if kind == "routine" else MAX_TRIGGERS_PER_BOT
                mine = backend.list(ctx.owner, ctx.bot_id)
                if len(mine) >= limit:
                    raise ChangeRefused(f"This bot already has {limit} {kind}s. Delete one first.", "limit")
                if any(r.get("name") == spec["name"] for r in mine):
                    raise ChangeRefused(f'A {kind} named "{spec["name"]}" already exists. Change that one instead.', "duplicate")
            else:
                record = backend.get(ctx.owner, target_id or "")
                if record is None or record.get("agent_id") != ctx.bot_id:
                    # Another bot's, another person's and missing all look the same.
                    raise ChangeRefused(f"No {kind} of yours has that id.", "not_found", 404)
                if action in ("pause", "resume") and bool(record.get("enabled")) == patch["enabled"]:
                    state = "running" if patch["enabled"] else "paused"
                    raise ChangeRefused(f'"{record.get("name")}" is already {state}.', "noop")
            before = backend.snapshot(record) if record is not None else None
            now = _now()
            # The tombstone, written ahead with the receipt: everything needed to
            # put a deleted target back during the Undo window (secrets stay sealed).
            tombstone = copy.deepcopy(record) if action == "delete" else None
            receipt = {
                "id": uuid.uuid4().hex[:16], "owner_user": ctx.owner, "bot_id": ctx.bot_id, "thread_id": ctx.thread_id,
                "run_id": ctx.run_id, "invocation_id": ctx.invocation_id, "kind": kind, "action": action,
                "target_id": target_id, "target_name": (record or {}).get("name") or (spec or {}).get("name"),
                "state": "pending", "fingerprint": fingerprint, "idem_key": self._idem(ctx, fingerprint),
                "application_id": uuid.uuid4().hex, "before": before, "expected": spec if action == "create" else patch,
                "target_revision": backend.revision(record) if record is not None else None, "after_revision": None,
                "source": source, "tainted": bool(ctx.tainted), "unattended": bool(ctx.unattended),
                "summary": "", "details": [], "created_at": now, "applied_at": None, "undone_at": None,
                "undo_expires_at": now + UNDO_WINDOW_SECONDS, "error": None, "last_undo_error": None,
                "_full": tombstone,
            }
            self._receipts[receipt["id"]] = receipt
            self._save()  # write ahead: from here a crash can be reconciled
            try:
                result = self._execute(backend, ctx, receipt, spec, patch)
            except ChangeRefused as refusal:
                receipt["state"] = "failed"
                receipt["error"] = str(refusal)
                self._save()
                raise
            except Exception as error:
                logger.exception("automation change failed")
                receipt["state"] = "failed"
                receipt["error"] = f"{type(error).__name__}: {error}"[:300]
                self._save()
                raise ChangeRefused(f"The change did not apply: {error}", "failed", 500)
            self._finish(backend, receipt, result)
            self._emit("applied", receipt)
            return self.public(receipt)

    @staticmethod
    def _idem(ctx: ChangeContext, fingerprint: str) -> str:
        scope = ctx.invocation_id or ctx.run_id
        return f"{ctx.owner}|{ctx.bot_id}|{scope}|{fingerprint}" if scope else f"{ctx.owner}|{ctx.bot_id}||{fingerprint}"

    def _replay(self, ctx: ChangeContext, fingerprint: str) -> dict | None:
        """The same request again (a retried call) returns its receipt."""
        key = self._idem(ctx, fingerprint)
        scoped = bool(ctx.invocation_id or ctx.run_id)
        for receipt in self._receipts.values():
            if receipt["idem_key"] != key or receipt["state"] not in ("applied", "pending"):
                continue
            if receipt["state"] == "pending":
                self.reconcile(receipt["id"])
                if receipt["state"] != "applied":
                    continue
            # Without an invocation, only a create is treated as a retry: every other
            # action is guarded by its own state check (already paused, stale revision).
            if scoped or (receipt["action"] == "create" and _now() - receipt["created_at"] < DUPLICATE_WINDOW_SECONDS):
                return {**self.public(receipt), "replayed": True}
        return None

    def _guard_rate(self, ctx: ChangeContext) -> None:
        cutoff = _now() - 3600
        recent = sum(1 for r in self._receipts.values()
                     if r["owner_user"] == ctx.owner and r["bot_id"] == ctx.bot_id and r["created_at"] > cutoff)
        if recent >= MAX_CHANGES_PER_HOUR:
            raise ChangeRefused("This bot has changed a lot of automations in the last hour. Ask the person before more.", "rate")

    def _execute(self, backend, ctx, receipt, spec, patch):
        action, target = receipt["action"], receipt["target_id"]
        app = receipt["application_id"]
        if action == "create":
            return backend.create(ctx.owner, ctx.bot_id, spec, app)
        if action == "delete":
            backend.delete(ctx.owner, target, receipt["target_revision"], app)
            return None
        return backend.update(ctx.owner, target, patch, receipt["target_revision"], app)

    def _finish(self, backend, receipt: dict, record) -> None:
        action = receipt["action"]
        if action == "delete":
            receipt["after_revision"] = None
        elif record is not None:
            receipt["target_id"] = record["id"]
            receipt["after_revision"] = backend.revision(record)
            receipt["target_name"] = record.get("name")
        receipt["details"] = self._details(backend, receipt, record)
        receipt["summary"] = self._summary(backend, receipt, record)
        receipt["state"] = "applied"
        receipt["applied_at"] = _now()
        self._save()

    @staticmethod
    def _summary(backend, receipt, record) -> str:
        name = receipt.get("target_name") or "it"
        noun = "routine" if receipt["kind"] == "routine" else "webhook trigger"
        when = f": {backend.describe(record)}" if record is not None and receipt["action"] in ("create",) else ""
        return {"create": f'Added {noun} "{name}"{when}.',
                "update": f'Changed {noun} "{name}".',
                "pause": f'Paused {noun} "{name}".',
                "resume": f'Resumed {noun} "{name}".',
                "delete": f'Deleted {noun} "{name}".'}[receipt["action"]]

    @staticmethod
    def _details(backend, receipt, record) -> list[dict]:
        from services.bot_cards import redact
        before = receipt.get("before") or {}
        after = backend.snapshot(record) if record is not None else {}
        rows = []
        keys = [k for k in dict.fromkeys([*before.keys(), *after.keys()])
                if k not in ("secret", "next_run_at") and before.get(k) != after.get(k)]
        if receipt["action"] == "create":
            keys = [k for k in after if k not in ("secret", "next_run_at")]
        if receipt["action"] == "delete":
            keys = [k for k in before if k not in ("secret",)]
        for key in keys[:12]:
            def show(value):
                if value is None or value == "":
                    return ""
                return redact(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False), 300)
            rows.append({"label": key.replace("_", " "), "before": "" if receipt["action"] == "create" else show(before.get(key)),
                         "after": "" if receipt["action"] == "delete" else show(after.get(key))})
        return rows

    # crash recovery -----------------------------------------------------------

    def reconcile(self, receipt_id: str | None = None) -> list[dict]:
        """Finish or fail every pending receipt by asking the target what landed.
        Safe to run at startup and whenever a receipt is looked up."""
        done = []
        with self._lock:
            for receipt in list(self._receipts.values()):
                if receipt["state"] != "pending" or (receipt_id and receipt["id"] != receipt_id):
                    continue
                backend = backend_for(receipt["kind"], receipt.get("source") or "webhook")
                owner, bot, action = receipt["owner_user"], receipt["bot_id"], receipt["action"]
                landed, record = False, None
                try:
                    if action == "create":
                        record = backend.find_application(owner, bot, receipt["application_id"], receipt["expected"])
                        landed = record is not None
                    elif action == "delete":
                        landed = backend.get(owner, receipt["target_id"]) is None
                    else:
                        record = backend.get(owner, receipt["target_id"])
                        landed = bool(record is not None and backend.revision(record) != receipt["target_revision"]
                                      and backend.matches(record, receipt["expected"]))
                except ChangeRefused:
                    landed = False
                if landed:
                    self._finish(backend, receipt, record)
                else:
                    receipt["state"] = "failed"
                    receipt["error"] = "Kairos stopped before this was applied. Nothing changed."
                    self._save()
                done.append(self.public(receipt))
        return done

    # undo ----------------------------------------------------------------------

    def undo(self, receipt_id: str, owner: str) -> dict:
        with self._lock:
            receipt = self._receipts.get(receipt_id)
            if receipt is None or receipt["owner_user"] != owner:
                raise NotFound()
            if receipt["state"] == "pending":
                self.reconcile(receipt_id)
            if receipt["state"] == "undone":
                return {**self.public(receipt), "already_undone": True}
            if receipt["state"] != "applied":
                raise ChangeRefused("That change was never applied, so there is nothing to undo.", "not_applied")
            if _now() >= receipt["undo_expires_at"]:
                raise ChangeRefused("The Undo window for this change has closed.", "expired")
            backend = backend_for(receipt["kind"], receipt.get("source") or "webhook")
            action, target = receipt["action"], receipt["target_id"]
            app = receipt.get("undo_application_id") or uuid.uuid4().hex
            receipt["undo_application_id"] = app
            self._save()
            try:
                if action == "create":
                    record = backend.get(receipt["owner_user"], target)
                    if record is None:
                        raise ChangeRefused("It was already deleted, so there is nothing left to undo.", "stale")
                    if backend.revision(record) != receipt["after_revision"]:
                        raise ChangeRefused("It was changed after this, so Undo left it alone. Delete it by hand if you want it gone.", "stale")
                    backend.delete(owner, target, receipt["after_revision"], app)
                elif action == "delete":
                    if backend.get(owner, target) is not None:
                        raise ChangeRefused("Something is already there, so Undo left it alone.", "stale")
                    backend.restore(owner, self._tombstone_snapshot(receipt), app)
                else:
                    record = backend.get(owner, target)
                    if record is None:
                        raise ChangeRefused("It was deleted after this, so there is nothing to restore.", "stale")
                    backend.replace(owner, target, receipt["before"], receipt["after_revision"], app)
            except ChangeRefused as refusal:
                receipt["last_undo_error"] = str(refusal)
                self._save()
                raise
            except Exception as error:
                logger.exception("automation undo failed")
                receipt["last_undo_error"] = f"{type(error).__name__}: {error}"[:300]
                self._save()
                raise ChangeRefused(f"Undo did not finish, and the receipt is still here to try again: {error}", "failed", 500)
            receipt["state"] = "undone"
            receipt["undone_at"] = _now()
            receipt["last_undo_error"] = None
            self._save()
            self._emit("undone", receipt)
            return self.public(receipt)

    @staticmethod
    def _tombstone_snapshot(receipt: dict) -> dict:
        snapshot = receipt.get("_full")
        if not snapshot:
            raise ChangeRefused("The saved copy for this change is gone, so it cannot be restored.", "expired")
        return snapshot


_store: ChangeStore | None = None
_store_lock = threading.Lock()


def store() -> ChangeStore:
    global _store
    with _store_lock:
        if _store is None:
            _store = ChangeStore()
            try:
                _store.reconcile()
            except Exception:
                logger.exception("automation change reconcile failed")
        return _store


def reset_for_test(path: str | None = None) -> ChangeStore:
    global _store
    with _store_lock:
        _store = ChangeStore(path)
        return _store
