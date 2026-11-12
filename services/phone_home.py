"""Home at a glance for the Kairos iPhone app (GET /api/phone/home; specs/phone-api.md).

One small read for the top of the app's Home screen and for its widgets: how much of each model plan is
used, the next calendar event, how many things wait for the person and how many chats are working. Every
part is read as the signed-in account, through what the full pages already read; a part that cannot be
read is left empty rather than failing the whole answer, because a widget asks often and shows whatever
it gets.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

LOOK_AHEAD_DAYS = 14
CALENDAR_SECONDS = 6     # the next event may wait on Google; a widget must not
PROVIDER_NAMES = {"claude": "Claude", "codex": "Codex", "antigravity": "Antigravity"}


def iso(moment) -> str:
    """A unix time or aware datetime as ISO 8601 in UTC, to the second: 2026-11-12T08:10:00Z."""
    if not isinstance(moment, datetime):
        moment = datetime.fromtimestamp(float(moment), timezone.utc)
    return moment.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _usage() -> list:
    """Each connected plan's fullest window: {"provider", "percent", "resets_at"}."""
    from core import quota_usage
    rows = []
    overlay = await quota_usage.get_usage_overlay_async()
    for reading in overlay.get("providers") or []:
        windows = [w for w in reading.get("windows") or [] if isinstance(w.get("used_percent"), (int, float))]
        if not windows:
            continue
        fullest = max(windows, key=lambda w: w["used_percent"])
        name = str(reading.get("provider") or "")
        rows.append({"provider": PROVIDER_NAMES.get(name, name.capitalize()),
                     "percent": max(0, min(100, round(fullest["used_percent"]))),
                     "resets_at": iso(fullest["resets_at"]) if fullest.get("resets_at") else None})
    return rows


def _starts(event, now):
    """(sort key, starts_at text, all_day) for an event that has not ended, else None."""
    from core import calendar_recurrence as repeats
    start, end = str(event.get("start") or ""), str(event.get("end") or event.get("start") or "")
    zone = event.get("time_zone") or "UTC"
    if event.get("completed") or not start:
        return None
    try:
        if "T" not in start:
            # A whole day (or a note due that day): it counts until that day is over where the event lives.
            first = repeats.stamp(start[:10] + "T00:00:00", zone)
            last = repeats.stamp(end[:10] + "T00:00:00", zone) + (timedelta(0) if event.get("end_exclusive") else timedelta(days=1))
            return (first, start[:10], True) if last > now else None
        first, last = repeats.stamp(start, zone), repeats.stamp(end, zone)
    except (ValueError, TypeError):
        return None
    return (first, iso(first), bool(event.get("all_day"))) if max(first, last) > now else None


async def _next_event(user: str):
    """The soonest event that has not ended, from the same sources as the Calendar page."""
    from routes import calendar_routes
    now = datetime.now(timezone.utc)
    events = await asyncio.wait_for(
        calendar_routes.list_events(start=iso(now), end=iso(now + timedelta(days=LOOK_AHEAD_DAYS)), user=user), CALENDAR_SECONDS)
    found = [(key, event) for event in events for key in [_starts(event, now)] if key]
    if not found:
        return None
    (_, starts_at, all_day), event = min(found, key=lambda pair: pair[0][0])
    return {"title": " ".join(str(event.get("title") or "Event").split())[:200], "starts_at": starts_at, "all_day": all_day}


def _live_runs(user: str) -> dict:
    from services import chat_live
    return (chat_live.visible_packet(chat_live.snapshot(), user) or {}).get("runs") or {}


def _needs_you(user: str, runs: dict) -> int:
    """What waits on the person: the Bots inbox's needs-you rows (questions, approvals, reviews), plus model
    chats stopped on a permission prompt (a bot's own prompts are already rows in its inbox)."""
    from core.session_manager import session_manager
    from services import bot_attention
    count = int(bot_attention.inbox(user).get("count") or 0)
    for session_id, run in runs.items():
        if run.get("permission") and not (session_manager.get_session(session_id) or {}).get("agent_id"):
            count += 1
    return count


async def summary(user: str) -> dict:
    answer = {"usage": [], "next_event": None, "needs_you": 0, "running": 0}
    try:
        answer["usage"] = await _usage()
    except Exception:
        logger.exception("phone home: usage could not be read")
    try:
        answer["next_event"] = await _next_event(user)
    except asyncio.TimeoutError:
        logger.warning("phone home: the calendar took too long")
    except Exception:
        logger.exception("phone home: the next event could not be read")
    try:
        runs = _live_runs(user)
        answer["running"] = sum(1 for run in runs.values() if run.get("status") == "processing")
        answer["needs_you"] = _needs_you(user, runs)
    except Exception:
        logger.exception("phone home: live work could not be counted")
    return answer
