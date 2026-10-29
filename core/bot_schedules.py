"""Routine schedules: one parser, one DST resolver, one next-time rule (Bots
redesign, Phase 3 unit U2, 2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-3-design.md, sections 4.2 and 5.4.

Pure functions only: no files, no clock of their own, no model. The preview
the editor shows and the time the scheduler dispatches at both come from here,
so they can never disagree.

Schedules are a tagged union, the shape `services/bot_automation_changes.py`
already normalizes:

  once        {at}                          one RFC 3339 instant
  daily       {time, weekdays?, time_zone}  wall clock, Monday=0 .. Sunday=6
  interval    {every_minutes, anchor_at, weekdays?, window?, ends_at?, time_zone}
  cron        {expression, time_zone}       five fields, named zone required
  limit_reset {endpoint_id, repeat}         the account's reset time plus 60 s

Rules every kind shares:
- Times are stored and compared as UTC instants.
- A wall-clock time that does not exist (spring forward) moves forward by the
  gap, so 02:30 becomes 03:30 and that day's run still happens. A wall-clock
  time that happens twice (fall back) uses the first one, so nothing fires
  twice.
- Weekdays keep Kairos's convention, Monday=0 through Sunday=6. Cron's own
  numbering (Sunday is 0 or 7) is converted when the expression is parsed.
- An interval window is one day, end-exclusive. With a window the cadence
  restarts at the window's start each allowed day; without one the cadence is
  a plain grid from `anchor_at`. `ends_at` is the last moment a run may
  start; `anchor_at` is the first.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

KINDS = ("once", "daily", "interval", "cron", "limit_reset")
MAX_CRON_CHARS = 256
MIN_EVERY, MAX_EVERY = 5, 1440
LIMIT_RESET_DELAY_SECONDS = 60
# A cron that cannot fire within this many years is rejected as never running.
SEARCH_YEARS = 8
MAX_PREVIEW = 20
REPEATS = ("once", "every_reset")

_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_DOW = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
_DAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_DAY_SHORT = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
_HHMM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_PLAIN_ZONES = {
    "America/Los_Angeles": "Pacific time", "America/Denver": "Mountain time", "America/Chicago": "Central time",
    "America/New_York": "Eastern time", "UTC": "UTC", "Europe/London": "UK time",
}


class ScheduleError(ValueError):
    """A schedule that cannot be used. `field` names the part to fix."""

    def __init__(self, message: str, field: str = "schedule"):
        super().__init__(message)
        self.field = field
        self.message = message


# -- zones and the DST resolver --------------------------------------------------

def zone_of(name):
    """A named zone, or None for the machine's own."""
    if name in (None, ""):
        return None
    try:
        return ZoneInfo(str(name))
    except (ZoneInfoNotFoundError, ValueError, TypeError, OSError):
        raise ScheduleError(f"{name!r} is not a time zone name such as America/New_York.", "time_zone")


def resolve_wall(wall: datetime, zone) -> datetime:
    """A naive wall-clock time in `zone` as a UTC instant, by the DST rules in
    the module note. `zone` None means the machine's zone."""
    candidates = [wall.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc) for fold in (0, 1)]
    local = [(stamp, stamp.astimezone(zone).replace(tzinfo=None)) for stamp in candidates]
    valid = [stamp for stamp, roundtrip in local if roundtrip == wall]
    return min(valid) if valid else min(stamp for stamp, roundtrip in local if roundtrip > wall)


def _utc(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, timezone.utc)


def _local_date(moment: datetime, zone) -> date:
    return moment.astimezone(zone).date()


def parse_instant(text, zone_name=None) -> datetime:
    """An RFC 3339 time as a UTC instant. A time with no offset is read in the
    schedule's zone (or the machine's)."""
    try:
        moment = datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        raise ScheduleError("That is not a date and time such as 2026-11-02T09:00:00-05:00.", "at")
    if moment.tzinfo is None:
        moment = resolve_wall(moment, zone_of(zone_name))
    return moment.astimezone(timezone.utc)


def parse_hhmm(text) -> tuple[int, int]:
    match = _HHMM.match(str(text or "").strip())
    if not match:
        raise ScheduleError("A time is HH:MM, such as 09:30.", "time")
    return int(match.group(1)), int(match.group(2))


# -- cron --------------------------------------------------------------------------

@dataclass(frozen=True)
class Cron:
    expression: str
    minutes: tuple
    hours: tuple
    days: frozenset          # day of month, 1-31; the last day is handled by `last_day`
    last_day: bool
    months: frozenset
    weekdays: frozenset      # Kairos numbering, Monday=0
    days_star: bool
    weekdays_star: bool

    def day_matches(self, day: date) -> bool:
        if day.month not in self.months:
            return False
        in_month = day.day in self.days or (self.last_day and (day + timedelta(days=1)).month != day.month)
        in_week = day.weekday() in self.weekdays
        if self.days_star and self.weekdays_star:
            return True
        if self.days_star:
            return in_week
        if self.weekdays_star:
            return in_month
        return in_month or in_week  # both given: either one, as cron has always done


_FIELDS = (("minute", 0, 59), ("hour", 0, 23), ("day of month", 1, 31), ("month", 1, 12), ("day of week", 0, 7))


def _name_number(token: str, names: tuple, start: int) -> Optional[int]:
    lowered = token.lower()
    return names.index(lowered) + start if lowered in names else None


def _number(token: str, field: str, low: int, high: int, names=None, start=0) -> int:
    if names:
        named = _name_number(token, names, start)
        if named is not None:
            return named
    if not token.isdigit():
        raise ScheduleError(f"The {field} field has {token!r}, which is not a number or name.", field)
    value = int(token)
    if not low <= value <= high:
        raise ScheduleError(f"The {field} field allows {low} to {high}, not {value}.", field)
    return value


def _parse_field(text: str, field: str, low: int, high: int, names=None, start=0) -> tuple[set, bool, bool]:
    """(values, is_star, has_last) for one field."""
    if not text:
        raise ScheduleError(f"The {field} field is empty.", field)
    values: set = set()
    star = text.startswith("*")
    last = False
    for part in text.split(","):
        if not part:
            raise ScheduleError(f"The {field} field has an empty entry.", field)
        if part.upper() == "L":
            if field != "day of month":
                raise ScheduleError("L (the last day) works only in the day of month field.", field)
            last = True
            continue
        if any(ch in part for ch in "?#"):
            raise ScheduleError(f"The {field} field has {part!r}, which this schedule does not support.", field)
        body, _, step_text = part.partition("/")
        if "/" in part and (not step_text.isdigit() or int(step_text) < 1):
            raise ScheduleError(f"A step in the {field} field is a whole number of 1 or more.", field)
        step = int(step_text) if step_text else 1
        if body == "*":
            first, final = low, high
            if field == "day of week":
                final = 6
        elif "-" in body:
            a, _, b = body.partition("-")
            first, final = _number(a, field, low, high, names, start), _number(b, field, low, high, names, start)
            if first > final:
                raise ScheduleError(f"The range {body} in the {field} field runs backwards.", field)
        else:
            first = _number(body, field, low, high, names, start)
            final = high if step_text else first
            if field == "day of week" and step_text:
                final = 6
        values.update(range(first, final + 1, step))
    return values, star, last


def parse_cron(expression) -> Cron:
    text = " ".join(str(expression or "").split())
    if not text:
        raise ScheduleError("A cron schedule needs five fields: minute hour day month weekday.", "expression")
    if len(text) > MAX_CRON_CHARS:
        raise ScheduleError(f"A cron expression is at most {MAX_CRON_CHARS} characters.", "expression")
    if text.startswith("@"):
        raise ScheduleError("Shortcuts such as @daily are not supported. Write the five fields.", "expression")
    parts = text.split(" ")
    if len(parts) == 6:
        raise ScheduleError("Six fields means seconds, which are not supported. Use five: minute hour day month weekday.",
                            "expression")
    if len(parts) != 5:
        raise ScheduleError(f"A cron schedule needs five fields, and this has {len(parts)}.", "expression")
    minute, _, _ = _parse_field(parts[0], *_FIELDS[0])
    hour, _, _ = _parse_field(parts[1], *_FIELDS[1])
    days, days_star, last = _parse_field(parts[2], *_FIELDS[2])
    months, _, _ = _parse_field(parts[3], "month", 1, 12, _MONTHS, 1)
    dows, weekdays_star, _ = _parse_field(parts[4], "day of week", 0, 7, _DOW, 0)
    weekdays = frozenset(cron_weekday_to_kairos(d) for d in dows)
    return Cron(text, tuple(sorted(minute)), tuple(sorted(hour)), frozenset(days), last, frozenset(months),
                weekdays, days_star, weekdays_star)


def cron_weekday_to_kairos(number: int) -> int:
    """Cron counts Sunday as 0 (and 7); Kairos counts Monday as 0."""
    return (number - 1) % 7


def cron_after(cron: Cron, zone, after: datetime, count: int = 1, until: Optional[datetime] = None) -> list[datetime]:
    """The next `count` instants after `after` (UTC), in order."""
    out: list[datetime] = []
    day = _local_date(after, zone) - timedelta(days=1)
    horizon = day + timedelta(days=366 * SEARCH_YEARS)
    while day <= horizon and len(out) < count:
        if cron.day_matches(day):
            moments = sorted({resolve_wall(datetime(day.year, day.month, day.day, h, m), zone)
                              for h in cron.hours for m in cron.minutes})
            for moment in moments:
                if moment > after and (until is None or moment <= until):
                    out.append(moment)
                    if len(out) >= count:
                        break
        if until is not None and day > _local_date(until, zone) + timedelta(days=1):
            break
        day += timedelta(days=1)
    # A shifted nonexistent time can land on the next day's own run: drop repeats.
    unique: list[datetime] = []
    for moment in out:
        if not unique or moment != unique[-1]:
            unique.append(moment)
    return unique


# -- normalizing --------------------------------------------------------------------

def _weekdays(days):
    if days in (None, []):
        return None
    if not isinstance(days, (list, tuple, set)) or any(type(d) is not int or not 0 <= d <= 6 for d in days):
        raise ScheduleError("Weekdays are numbers from Monday=0 to Sunday=6.", "weekdays")
    return sorted(set(days))


def normalize(raw, now: Optional[float] = None) -> dict:
    """A schedule validated and put in one stored shape. Raises ScheduleError.
    A `once` time in the past is refused here; a stored one that has passed is
    simply done."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        raise ScheduleError("A schedule is once, daily, interval, cron or limit_reset.", "kind")
    kind = raw["kind"]
    now = time.time() if now is None else now
    zone_name = raw.get("time_zone") or None
    zone_of(zone_name)
    if kind == "once":
        if not raw.get("at"):
            raise ScheduleError("A one-time schedule needs a time.", "at")
        moment = parse_instant(raw["at"], zone_name)
        if moment.timestamp() <= now:
            raise ScheduleError("That time has already passed. Pick a time in the future.", "at")
        return {"kind": "once", "at": moment.isoformat()}
    if kind == "daily":
        hour, minute = parse_hhmm(raw.get("time"))
        out = {"kind": "daily", "time": f"{hour:02d}:{minute:02d}", "time_zone": zone_name}
        days = _weekdays(raw.get("weekdays"))
        if days:
            out["weekdays"] = days
        return out
    if kind == "interval":
        every = raw.get("every_minutes")
        if type(every) is not int or not MIN_EVERY <= every <= MAX_EVERY:
            raise ScheduleError(f"Repeat every {MIN_EVERY} to {MAX_EVERY} minutes.", "every_minutes")
        out = {"kind": "interval", "every_minutes": every, "time_zone": zone_name}
        anchor = parse_instant(raw["anchor_at"], zone_name) if raw.get("anchor_at") else _utc(now)
        out["anchor_at"] = anchor.isoformat()
        if raw.get("ends_at"):
            ends = parse_instant(raw["ends_at"], zone_name)
            if ends <= anchor:
                raise ScheduleError("The end must be after the first run.", "ends_at")
            out["ends_at"] = ends.isoformat()
        days = _weekdays(raw.get("weekdays"))
        if days:
            out["weekdays"] = days
        window = raw.get("window")
        if window is not None:
            if not isinstance(window, dict):
                raise ScheduleError("A window is a start and an end time.", "window")
            (sh, sm), (eh, em) = parse_hhmm(window.get("start")), parse_hhmm(window.get("end"))
            start, end = sh * 60 + sm, eh * 60 + em
            if end <= start:
                raise ScheduleError("A window stays within one day. For an overnight window make two routines.", "window")
            if end - start < every:
                raise ScheduleError("A window must be at least one repeat long.", "window")
            out["window"] = {"start": f"{sh:02d}:{sm:02d}", "end": f"{eh:02d}:{em:02d}"}
        return out
    if kind == "cron":
        cron = parse_cron(raw.get("expression"))
        if not zone_name:
            raise ScheduleError("A cron schedule needs a named time zone such as America/New_York.", "time_zone")
        if not cron_after(cron, zone_of(zone_name), _utc(now)):
            raise ScheduleError("That cron schedule never runs.", "expression")
        return {"kind": "cron", "expression": cron.expression, "time_zone": zone_name}
    endpoint = raw.get("endpoint_id")
    repeat = raw.get("repeat", "once")
    if not isinstance(endpoint, str) or not endpoint.strip() or len(endpoint) > 120:
        raise ScheduleError("A limit reset schedule names the account whose limit it follows.", "endpoint_id")
    if repeat not in REPEATS:
        raise ScheduleError("Repeat is once or every reset.", "repeat")
    return {"kind": "limit_reset", "endpoint_id": endpoint.strip(), "repeat": repeat}


# -- next times -----------------------------------------------------------------------

def _interval_next(schedule: dict, after: datetime, count: int) -> list[datetime]:
    every = timedelta(minutes=schedule["every_minutes"])
    zone = zone_of(schedule.get("time_zone"))
    anchor = datetime.fromisoformat(schedule["anchor_at"]).astimezone(timezone.utc)
    ends = datetime.fromisoformat(schedule["ends_at"]).astimezone(timezone.utc) if schedule.get("ends_at") else None
    days = schedule.get("weekdays")
    window = schedule.get("window")
    out: list[datetime] = []
    if not window:
        steps = int((after - anchor) / every) + 1 if after >= anchor else 0
        moment = anchor + steps * every
        guard = 0
        while len(out) < count and guard < 3000 * count:
            guard += 1
            if ends is not None and moment > ends:
                break
            if moment > after and (days is None or moment.astimezone(zone).weekday() in days):
                out.append(moment)
            moment += every
        return out
    (sh, sm), (eh, em) = parse_hhmm(window["start"]), parse_hhmm(window["end"])
    day = _local_date(max(after, anchor), zone) - timedelta(days=1)
    for _ in range(400):
        if ends is not None and day > _local_date(ends, zone) + timedelta(days=1):
            break
        if days is None or day.weekday() in days:
            start = resolve_wall(datetime(day.year, day.month, day.day, sh, sm), zone)
            end = resolve_wall(datetime(day.year, day.month, day.day, eh, em), zone)
            moment = start
            while moment < end and len(out) < count:
                if moment > after and moment >= anchor and (ends is None or moment <= ends):
                    out.append(moment)
                moment += every
        if len(out) >= count:
            break
        day += timedelta(days=1)
    return out


def next_times(schedule: dict, after_ts: float, count: int = 1, reset_at: Optional[float] = None) -> list[datetime]:
    """The next `count` run times (UTC) strictly after `after_ts`. For a limit
    reset schedule, `reset_at` is the account's known reset time (epoch
    seconds); with none known there is no next time."""
    after = _utc(after_ts)
    count = max(1, min(count, MAX_PREVIEW))
    kind = schedule["kind"]
    if kind == "once":
        moment = datetime.fromisoformat(schedule["at"]).astimezone(timezone.utc)
        return [moment] if moment > after else []
    if kind == "daily":
        hour, minute = parse_hhmm(schedule["time"])
        zone = zone_of(schedule.get("time_zone"))
        days = schedule.get("weekdays")
        out: list[datetime] = []
        day = _local_date(after, zone) - timedelta(days=1)
        for _ in range(count * 8 + 10):
            if days is None or day.weekday() in days:
                moment = resolve_wall(datetime(day.year, day.month, day.day, hour, minute), zone)
                if moment > after and (not out or moment > out[-1]):
                    out.append(moment)
                    if len(out) >= count:
                        break
            day += timedelta(days=1)
        return out
    if kind == "interval":
        return _interval_next(schedule, after, count)
    if kind == "cron":
        return cron_after(parse_cron(schedule["expression"]), zone_of(schedule.get("time_zone")), after, count)
    if kind == "limit_reset":
        if reset_at is None:
            return []
        moment = _utc(reset_at + LIMIT_RESET_DELAY_SECONDS)
        return [moment] if moment > after else []
    return []


def next_after(schedule: dict, after_ts: float, reset_at: Optional[float] = None) -> Optional[datetime]:
    found = next_times(schedule, after_ts, 1, reset_at)
    return found[0] if found else None


def occurrences_between(schedule: dict, start_ts: float, end_ts: float, limit: int = 200) -> list[datetime]:
    """Every run time after `start_ts` up to and including `end_ts`, at most
    `limit` (the earliest ones). For catch-up and the calendar."""
    out: list[datetime] = []
    cursor = start_ts
    end = _utc(end_ts)
    while len(out) < limit:
        batch = next_times(schedule, cursor, min(MAX_PREVIEW, limit - len(out)))
        batch = [m for m in batch if m <= end]
        if not batch:
            break
        out.extend(batch)
        cursor = batch[-1].timestamp()
        if len(batch) < MAX_PREVIEW and batch[-1] >= end:
            break
    return out


# -- plain sentences ---------------------------------------------------------------------

def _clock(text: str) -> str:
    hour, minute = parse_hhmm(text)
    suffix = "AM" if hour < 12 else "PM"
    shown = hour % 12 or 12
    return f"{shown} {suffix}" if minute == 0 else f"{shown}:{minute:02d} {suffix}"


def _days_phrase(days) -> str:
    if not days or len(days) == 7:
        return "day"
    days = sorted(days)
    if days == [0, 1, 2, 3, 4]:
        return "weekday"
    if days == [5, 6]:
        return "weekend day"
    return ", ".join(_DAY_NAMES[d] for d in days)


def _zone_phrase(name) -> str:
    return f" {_PLAIN_ZONES.get(name, f'({name})')}" if name else ""


def _every(minutes: int) -> str:
    if minutes % 1440 == 0:
        return "day" if minutes == 1440 else f"{minutes // 1440} days"
    if minutes % 60 == 0:
        return "hour" if minutes == 60 else f"{minutes // 60} hours"
    return f"{minutes} minutes"


def describe(schedule: dict) -> str:
    """One plain sentence, such as "Every weekday at 9 AM Pacific time"."""
    kind = schedule.get("kind")
    zone = _zone_phrase(schedule.get("time_zone"))
    if kind == "once":
        moment = datetime.fromisoformat(schedule["at"]).astimezone()
        return f"Once on {moment.strftime('%b %d').replace(' 0', ' ')} at {_clock(moment.strftime('%H:%M'))}"
    if kind == "daily":
        phrase = _days_phrase(schedule.get("weekdays"))
        return f"Every {phrase} at {_clock(schedule['time'])}{zone}"
    if kind == "interval":
        text = f"Every {_every(schedule['every_minutes'])}"
        days = schedule.get("weekdays")
        if days and len(days) < 7:
            text += f" on {', '.join(_DAY_SHORT[d] for d in sorted(days))}"
        window = schedule.get("window")
        if window:
            text += f" between {_clock(window['start'])} and {_clock(window['end'])}"
        return text + zone
    if kind == "cron":
        return _cron_sentence(schedule["expression"], schedule.get("time_zone"))
    if kind == "limit_reset":
        return "When the usage limit resets" + (", every time" if schedule.get("repeat") == "every_reset" else "")
    return "On a schedule"


def _cron_sentence(expression: str, zone_name) -> str:
    zone = _zone_phrase(zone_name)
    parts = expression.split(" ")
    minute, hour, dom, month, dow = parts
    plain_time = minute.isdigit() and hour.isdigit()
    if plain_time and dom == "*" and month == "*":
        clock = _clock(f"{int(hour)}:{int(minute):02d}")
        if dow == "*":
            return f"Every day at {clock}{zone}"
        if dow in ("1-5", "MON-FRI", "mon-fri"):
            return f"Every weekday at {clock}{zone}"
    if hour == "*" and dom == "*" and month == "*" and dow == "*" and minute.startswith("*/") and minute[2:].isdigit():
        return f"Every {minute[2:]} minutes{zone}"
    return f"On the schedule {expression}{zone}"


def preview(schedule: dict, now: Optional[float] = None, count: int = 3, reset_at: Optional[float] = None) -> dict:
    """What the editor shows: the sentence and the next few times."""
    now = time.time() if now is None else now
    return {"sentence": describe(schedule),
            "next": [m.isoformat() for m in next_times(schedule, now, count, reset_at)],
            "time_zone": schedule.get("time_zone")}


# -- the legacy fields the Tasks tab still reads ----------------------------------------

def legacy_fields(schedule: dict) -> dict:
    """The old task columns for a schedule, so the Tasks tab and anything that
    reads `schedule_kind` keep working. Cron and limit reset get their own kind."""
    kind = schedule["kind"]
    blank = {"run_at": None, "interval_seconds": None, "run_time": None}
    if kind == "once":
        return {**blank, "schedule_kind": "once", "run_at": schedule["at"]}
    if kind == "daily":
        return {**blank, "schedule_kind": "daily", "run_time": schedule["time"]}
    if kind == "interval":
        return {**blank, "schedule_kind": "interval", "interval_seconds": schedule["every_minutes"] * 60}
    return {**blank, "schedule_kind": kind}


def from_legacy(task: dict) -> Optional[dict]:
    """A schedule for an old goal that has no routine record yet (lazy
    translation: nothing is written until the person edits it)."""
    kind = task.get("schedule_kind")
    zone, days = task.get("time_zone"), task.get("weekdays")
    if kind == "once" and task.get("run_at"):
        return {"kind": "once", "at": datetime.fromisoformat(task["run_at"]).astimezone(timezone.utc).isoformat()}
    if kind == "daily" and task.get("run_time"):
        out = {"kind": "daily", "time": task["run_time"], "time_zone": zone}
        if days:
            out["weekdays"] = list(days)
        return out
    if kind == "interval" and task.get("interval_seconds"):
        anchor = task.get("next_run_at") or datetime.fromtimestamp(task.get("created_at") or time.time(), timezone.utc).isoformat()
        return {"kind": "interval", "every_minutes": max(1, int(task["interval_seconds"]) // 60), "anchor_at": anchor,
                "time_zone": zone}
    return None
