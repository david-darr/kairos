"""Calendar: real events, plus a read-through view of Notes' due-dated items
(Notes stays the one source of truth for those — see JARVIS Plan's resolved
Notes/Calendar decision, 2026-08-31). External CalDAV/Google sync is real
Odysseus-scale integration work (OAuth, two-way writeback) — deliberately out
of this pass; this is the local event model + Notes-merge it would sync on
top of.
"""
import os
import time
import uuid
from copy import deepcopy
from typing import Optional

from core.atomic_io import read_json, write_json_atomic
from core.constants import DATA_DIR
from core import calendar_recurrence as repeats
from services.notes_service import notes_service

EVENTS_FILE = os.path.join(DATA_DIR, "calendar_events.json")


def _overlaps(ev_start: str, ev_end: str, start_iso: str, end_iso: str, *, end_exclusive=False, time_zone="UTC") -> bool:
    """Does an event intersect [start_iso, end_iso)?

    Timed events and exclusive all-day spans compare aware instants, using
    the series' zone for date-only boundaries. Older feed/deadline events
    keep their inclusive end-date semantics by extending a bare end date
    through its last instant.
    """
    if end_exclusive or ("T" in ev_start and "T" in ev_end):
        return repeats.stamp(ev_start, time_zone) < repeats.stamp(end_iso) and repeats.stamp(ev_end, time_zone) > repeats.stamp(start_iso)
    if len(ev_end) == 10:
        ev_end = ev_end + "T23:59:59.999999"
    return ev_start < end_iso and ev_end >= start_iso


class CalendarService:
    def __init__(self) -> None:
        self._events: dict = read_json(EVENTS_FILE, {})

    def _save(self) -> None:
        write_json_atomic(EVENTS_FILE, self._events)

    def create_event(self, title: str, start: str, end: str, all_day: bool = False, location: str = "", description: str = "",
                      sync_id: Optional[str] = None, external_uid: Optional[str] = None, completed: bool = False,
                      recurrence: Optional[dict] = None, time_zone: str = "UTC") -> dict:
        recurrence = repeats.normalize(recurrence, start, time_zone, all_day)
        if not all_day:
            start = repeats.stamp(start, time_zone).astimezone(repeats.zone(time_zone)).isoformat()
            end = repeats.stamp(end, time_zone).astimezone(repeats.zone(time_zone)).isoformat()
        if recurrence:
            repeats.boundaries(dict(start=start, end=end, all_day=all_day, time_zone=time_zone))
        event_id = uuid.uuid4().hex[:12]
        now = time.time()
        event = {
            "id": event_id,
            "title": title,
            "start": start,  # ISO 8601
            "end": end,
            "all_day": all_day,
            "location": location,
            "description": description,
            "created_at": now,
            "updated_at": now,
            # Set when this event came from a CalDAV integration sync
            # (David's ask 2026-08-31, see core/dav_client.py) rather than
            # being hand-created — lets replace_synced_events() clear and
            # re-insert just that integration's events on each re-sync
            # without touching manually created ones.
            "sync_id": sync_id,
            # The feed's own UID (from core/dav_client.py's parse_vevents) —
            # a synced event's real id changes on every re-sync (delete +
            # recreate), so this is the stable key replace_synced_events()
            # uses to carry a "completed" checkbox forward across re-syncs.
            "external_uid": external_uid,
            # Check off an event/note in Calendar (David's ask 2026-08-31) —
            # completed items stay visible (checked, struck through) rather
            # than being deleted, same "mark done, don't destroy" model
            # Notes already uses.
            "completed": completed,
            "recurrence": recurrence,
            "time_zone": time_zone,
            "end_exclusive": bool(all_day and not sync_id and len(end) == 10 and end > start),
        }
        self._events[event_id] = event
        self._save()
        return event

    def replace_synced_events(self, sync_id: str, events: list[dict]) -> int:
        """Clears every event previously synced from `sync_id`, inserts the
        freshly fetched set. Simplest-correct re-sync model for a one-way
        read sync with no stable diffing — matches core/dav_client.py's
        stated "no incremental sync" scope. Preserves a checked-off
        `completed` state across the wipe-and-recreate by matching on the
        feed's own UID, so re-syncing a CalDAV/iCal calendar doesn't
        silently un-check anything you'd already marked done."""
        completed_by_uid = {
            e["external_uid"]: True
            for e in self._events.values()
            if e.get("sync_id") == sync_id and e.get("external_uid") and e.get("completed")
        }
        for event_id, e in list(self._events.items()):
            if e.get("sync_id") == sync_id:
                del self._events[event_id]
        for e in events:
            uid = e.get("uid")
            self.create_event(
                e["title"], e["start"], e["end"], e.get("all_day", False),
                sync_id=sync_id, external_uid=uid, completed=completed_by_uid.get(uid, False),
            )
        self._save()
        return len(events)

    @staticmethod
    def _public(event: dict) -> dict:
        return {**deepcopy({k: v for k, v in event.items() if k != "_exceptions"}), "source": "calendar"}

    def _instance(self, event: dict, key: str, start: str, end: str) -> dict:
        override = event.get("_exceptions", {}).get(key, {})
        return {**self._public(event), "completed": False, "start": start, "end": end, "end_exclusive": bool(event["all_day"]),
                **{k: v for k, v in override.items() if not k.startswith("_") and k != "deleted"},
                "id": f"{event['id']}~{key}", "series_id": event["id"], "occurrence_date": key}

    def get_event(self, event_id: str, scope: str = "occurrence") -> dict:
        if event_id in self._events:
            return self._public(self._events[event_id])
        ident, sep, key = event_id.partition("~")
        event = self._events.get(ident)
        if event is None:
            raise KeyError(f"no such event: {event_id}")
        if sep:
            try:
                repeats.day(key)
            except ValueError:
                raise KeyError(f"no such occurrence: {event_id}") from None
        if not sep or scope == "series":
            return self._public(event)
        if not event.get("recurrence") or event.get("_exceptions", {}).get(key, {}).get("deleted"):
            raise KeyError(f"no such occurrence: {event_id}")
        for current, start, end in repeats.occurrences(event, key, key):
            if current == key:
                return self._instance(event, key, start, end)
        raise KeyError(f"no such occurrence: {event_id}")

    def update_event(self, event_id: str, scope: str = "occurrence", **fields) -> dict:
        current = self.get_event(event_id, scope)
        ident, sep, key = (event_id, "", "") if event_id in self._events else event_id.partition("~")
        event = self._events[ident]
        keys = ("title", "start", "end", "all_day", "location", "description", "completed", "time_zone", "recurrence")
        changes = {k: v for k, v in fields.items() if k in keys}
        candidate = {**current, **changes}
        if not candidate["all_day"] and any(k in changes for k in ("start", "end", "all_day", "time_zone")):
            changes["end_exclusive"] = False
            for boundary in ("start", "end"):
                candidate[boundary] = repeats.stamp(candidate[boundary], candidate.get("time_zone")).astimezone(repeats.zone(candidate.get("time_zone"))).isoformat()
                changes[boundary] = candidate[boundary]
        if candidate["all_day"] and any(k in changes for k in ("start", "end", "all_day")):
            changes["end_exclusive"] = len(candidate["end"]) == 10 and candidate["end"] > candidate["start"]
        if sep and scope == "occurrence":
            if "recurrence" in changes:
                raise ValueError("Change the repeat rule for all events in the series")
            if any(k in changes for k in ("start", "end", "all_day", "time_zone")):
                repeats.boundaries(candidate)
            override = event.setdefault("_exceptions", {}).setdefault(key, {})
            override.update(changes, updated_at=time.time())
            if changes.get("completed"):
                override["_snapshot"] = candidate
        else:
            if candidate.get("recurrence"):
                candidate["recurrence"] = repeats.normalize(candidate["recurrence"], candidate["start"], candidate.get("time_zone"), candidate["all_day"])
                repeats.boundaries(candidate)
                changes["recurrence"] = candidate["recurrence"]
            if any(candidate.get(k) != event.get(k) for k in ("recurrence", "start", "end", "all_day", "time_zone")):
                # Individually edited/completed instances must not disappear when
                # an anchor/rule changes. Keep still-valid exceptions in the
                # series; retain displaced ones as standalone events under their
                # original id, so Archive's Reopen/Edit/Delete keep working.
                remaining = {}
                for occurrence_key, override in event.get("_exceptions", {}).items():
                    valid = candidate.get("recurrence") and any(k == occurrence_key for k, _, _ in repeats.occurrences(candidate, occurrence_key, occurrence_key))
                    if valid:
                        remaining[occurrence_key] = override
                    elif not override.get("deleted"):
                        old_id = f"{ident}~{occurrence_key}"
                        try:
                            old = self.get_event(old_id)
                        except KeyError:
                            old = override.get("_snapshot")
                        if old:
                            detached = {**deepcopy(old), "recurrence": None, "detached_from": ident}
                            for name in ("series_id", "occurrence_date", "source"):
                                detached.pop(name, None)
                            self._events[old_id] = detached
                event["_exceptions"] = remaining
            event.update(changes)
        event["updated_at"] = time.time()
        self._save()
        return self.get_event(ident if scope == "series" else event_id, scope)

    def delete_event(self, event_id: str, scope: str = "occurrence") -> None:
        if event_id in self._events:
            del self._events[event_id]
            for key, event in list(self._events.items()):
                if event.get("detached_from") == event_id:
                    del self._events[key]
            self._save()
            return
        ident, sep, key = event_id.partition("~")
        if sep:
            try:
                repeats.day(key)
            except ValueError:
                raise KeyError(f"no such occurrence: {event_id}") from None
        if sep and scope == "occurrence":
            self.get_event(event_id)
            self._events[ident].setdefault("_exceptions", {}).setdefault(key, {}).update(deleted=True)
            self._save()
        elif ident in self._events:
            del self._events[ident]
            for key, event in list(self._events.items()):
                if event.get("detached_from") == ident:
                    del self._events[key]
            self._save()

    def _calendar_items(self, first: str, last: str, *, instants=False) -> list[dict]:
        items = []
        for event in self._events.values():
            if not event.get("recurrence"):
                items.append(self._public(event))
                continue
            seen = set()
            time_zone = repeats.zone(event.get("time_zone"))
            first_date = repeats.stamp(first).astimezone(time_zone).date().isoformat() if instants else first
            last_date = repeats.stamp(last).astimezone(time_zone).date().isoformat() if instants else last
            for key, start, end in repeats.occurrences(event, first_date, last_date):
                seen.add(key)
                if not event.get("_exceptions", {}).get(key, {}).get("deleted"):
                    items.append(self._instance(event, key, start, end))
            # A moved occurrence must also appear at its new date, even if its
            # original date lies outside the requested range.
            for key, override in event.get("_exceptions", {}).items():
                if key not in seen and "start" in override and not override.get("deleted"):
                    try:
                        items.append(self.get_event(f"{event['id']}~{key}"))
                    except KeyError:
                        pass
        return items

    def list_completed(self) -> list[dict]:
        """Archived (checked-off) calendar events, most recently completed
        first — David's ask 2026-08-31, an Archive view with a reopen
        action. Not date-range-limited on purpose: a completed event should
        stay findable in the archive regardless of when it was scheduled."""
        events = [self._public(e) for e in self._events.values() if e.get("completed") and not e.get("recurrence")]
        for event in self._events.values():
            for key, override in event.get("_exceptions", {}).items():
                if not override.get("completed") or override.get("deleted"):
                    continue
                try:
                    events.append(self.get_event(f"{event['id']}~{key}"))
                except KeyError:
                    if override.get("_snapshot"):
                        events.append({**override["_snapshot"], "updated_at": override["updated_at"]})
        return sorted(events, key=lambda e: e["updated_at"], reverse=True)

    def list_for_dates(self, first_date: str, last_date: str) -> list[dict]:
        """Events touching the inclusive local date span, both "YYYY-MM-DD".

        Day-granularity on purpose, and separate from list_range() rather than
        layered on it: list_range compares instants, and an instant range
        derived from a LOCAL day is offset from UTC midnight (4h for Eastern),
        so a bare-date all-day event for tomorrow lexically falls inside
        today's UTC-shifted window. Comparing dates to dates has no such
        boundary to get wrong, which is what a daily brief actually wants.
        """
        events = [
            {**e, "source": "calendar"}
            for e in self._calendar_items(first_date, last_date)
            if (e["start"][:10] <= last_date and (e["end"][:10] > first_date if e.get("all_day") and e.get("end_exclusive") else e["end"][:10] >= first_date))
        ]
        note_events = [
            {
                "id": n["id"], "title": n["text"], "start": n["due_date"], "end": n["due_date"],
                "all_day": True, "location": "", "description": "", "source": "note", "completed": False,
            }
            for n in notes_service.list_notes(include_completed=False)
            if n.get("due_date") and first_date <= str(n["due_date"])[:10] <= last_date
        ]
        return sorted(events + note_events, key=lambda e: str(e["start"]))

    def list_range(self, start_iso: str, end_iso: str) -> list[dict]:
        """Real events plus due-dated Notes in range, tagged by source so the
        UI can render/link them differently while Notes stays authoritative
        for the note-backed ones."""
        events = [
            {**e, "source": "calendar"}
            for e in self._calendar_items(start_iso, end_iso, instants=True)
            if _overlaps(e["start"], e["end"], start_iso, end_iso,
                end_exclusive=e.get("end_exclusive", False), time_zone=e.get("time_zone", "UTC"))
        ]
        note_events = [
            {
                "id": n["id"],
                "title": n["text"],
                "start": n["due_date"],
                "end": n["due_date"],
                "all_day": False,
                "location": "",
                "description": "",
                "source": "note",
                "completed": False,  # list_due_between already excludes completed notes
            }
            for n in notes_service.list_due_between(start_iso, end_iso)
        ]
        return sorted(events + note_events, key=lambda e: e["start"])


calendar_service = CalendarService()
