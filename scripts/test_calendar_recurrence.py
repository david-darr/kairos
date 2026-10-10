"""Local recurring calendars and Google repeat writes, using isolated data only."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory
_DATA = TemporaryDirectory(prefix="calendar-repeat-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

from core import calendar_recurrence as repeats, google_workspace as google
from services import calendar_service as module
from routes import calendar_routes
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_user


class LocalCalendarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(dir=_DATA.name)
        self.addCleanup(self.tmp.cleanup)
        p = patch.object(module, "EVENTS_FILE", str(Path(self.tmp.name) / "events.json"))
        p.start(); self.addCleanup(p.stop)
        self.calendar = module.CalendarService()
        p = patch.object(module.notes_service, "list_due_between", return_value=[])
        p.start(); self.addCleanup(p.stop)
        p = patch.object(module.notes_service, "list_notes", return_value=[])
        p.start(); self.addCleanup(p.stop)

    def create(self, **changes):
        fields = dict(title="Weekly standup", start="2026-10-25T09:00:00", end="2026-10-25T09:30:00",
                      time_zone="America/New_York", recurrence={"frequency": "weekly", "interval": 1})
        fields.update(changes)
        return self.calendar.create_event(**fields)

    def listing(self, start="2026-10-01T00:00:00Z", end="2026-12-01T00:00:00Z"):
        return self.calendar.list_range(start, end)

    def test_weekly_wall_clock_survives_dst_and_filters_actual_instants(self):
        self.create()
        events = self.listing()
        self.assertEqual(events[0]["start"], "2026-10-25T09:00:00-04:00")
        self.assertEqual(events[1]["start"], "2026-11-01T09:00:00-05:00")
        self.assertEqual(len(self.listing("2026-11-01T13:55:00Z", "2026-11-01T14:15:00Z")), 1)
        self.assertEqual(self.listing("2026-11-01T09:00:00Z", "2026-11-01T09:30:00Z"), [])
        self.assertEqual(self.listing("2026-11-01T14:30:00Z", "2026-11-01T15:00:00Z"), [])

    def test_monthly_skips_missing_days_and_count_counts_real_events(self):
        self.create(start="2026-01-31T09:00:00", end="2026-01-31T09:30:00",
                    recurrence={"frequency": "monthly", "interval": 1, "count": 3})
        self.assertEqual([e["start"][:10] for e in self.listing("2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z")],
                         ["2026-01-31", "2026-03-31", "2026-05-31"])

    def test_nonexistent_dst_time_is_skipped_without_spending_count(self):
        self.create(start="2026-03-01T02:30:00", end="2026-03-01T02:45:00",
                    recurrence={"frequency": "weekly", "count": 3})
        self.assertEqual([e["start"][:10] for e in self.listing("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z")],
                         ["2026-03-01", "2026-03-15", "2026-03-22"])

    def test_interval_until_inclusive_and_stable_ids_across_restart(self):
        self.create(recurrence={"frequency": "daily", "interval": 2, "until": "2026-10-29"})
        before = self.listing()
        self.assertEqual([e["start"][:10] for e in before], ["2026-10-25", "2026-10-27", "2026-10-29"])
        self.assertEqual([e["id"] for e in before], [e["id"] for e in module.CalendarService().list_range("2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z")])

    def test_all_day_exclusive_end_and_legacy_feed_day_are_preserved(self):
        self.create(start="2026-10-25", end="2026-10-26", all_day=True,
                    recurrence={"frequency": "weekly", "count": 2})
        self.assertEqual(len(self.calendar.list_for_dates("2026-10-25", "2026-10-25")), 1)
        self.assertEqual(self.calendar.list_for_dates("2026-10-26", "2026-10-26"), [])
        self.assertEqual(self.listing("2026-10-26T04:00:00Z", "2026-10-27T04:00:00Z"), [])
        legacy = self.calendar.create_event("Deadline", "2026-10-26", "2026-10-26", all_day=True, sync_id="fixture")
        self.assertIn(legacy["id"], [e["id"] for e in self.calendar.list_for_dates("2026-10-26", "2026-10-26")])
        self.assertIn(legacy["id"], [e["id"] for e in self.listing("2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")])

    def test_complete_archive_reopen_and_delete_are_per_occurrence(self):
        master = self.create()
        occurrence, second = self.listing()[:2]
        self.calendar.update_event(occurrence["id"], completed=True)
        self.assertEqual([e["id"] for e in self.calendar.list_completed()], [occurrence["id"]])
        self.assertFalse(self.calendar.get_event(second["id"])["completed"])
        self.calendar.update_event(occurrence["id"], completed=False)
        self.assertEqual(self.calendar.list_completed(), [])
        self.calendar.delete_event(occurrence["id"])
        self.assertNotIn(occurrence["id"], [e["id"] for e in self.listing()])
        self.assertIn(second["id"], [e["id"] for e in self.listing()])
        self.assertIn(master["id"], self.calendar._events)
        self.calendar.delete_event(second["id"], scope="series")
        self.assertEqual(self.listing(), [])

    def test_all_day_occurrence_changed_to_timed_stays_in_date_listing(self):
        self.create(start="2026-10-25", end="2026-10-26", all_day=True,
                    recurrence={"frequency": "weekly", "count": 2})
        occurrence = self.listing()[0]
        edited = self.calendar.update_event(occurrence["id"], all_day=False,
            start="2026-10-25T09:00:00", end="2026-10-25T10:00:00")
        self.assertFalse(edited["end_exclusive"])
        self.assertEqual([e["id"] for e in self.calendar.list_for_dates("2026-10-25", "2026-10-25")], [occurrence["id"]])

    def test_moved_occurrence_appears_outside_its_original_range(self):
        master = self.create(recurrence={"frequency": "weekly", "count": 2})
        occurrence = self.listing()[0]
        self.calendar.update_event(occurrence["id"], start="2027-03-02T10:00:00", end="2027-03-02T11:00:00", title="Moved")
        self.assertNotIn(occurrence["id"], [e["id"] for e in self.listing()])
        moved = self.listing("2027-03-01T00:00:00Z", "2027-03-03T00:00:00Z")
        self.assertEqual([(e["id"], e["title"]) for e in moved], [(occurrence["id"], "Moved")])
        self.assertEqual(moved[0]["start"], "2027-03-02T10:00:00-05:00")
        self.calendar.update_event(master["id"], title="Series renamed")
        self.assertEqual(self.listing()[0]["title"], "Series renamed")

    def test_series_edit_and_repeat_removal_do_not_duplicate_masters(self):
        master = self.create()
        occurrence = self.listing()[1]
        fetched = self.calendar.get_event(occurrence["id"], "series")
        self.assertEqual(fetched["id"], master["id"])
        self.calendar.update_event(occurrence["id"], scope="series", recurrence={"frequency": "daily", "interval": 1, "count": 2})
        self.assertEqual(len(self.listing()), 2)
        self.calendar.update_event(master["id"], recurrence=None)
        self.assertEqual([e["id"] for e in self.listing()], [master["id"]])

    def test_bad_rules_and_missing_occurrence_refuse_without_writes(self):
        for rule in ({"frequency": "yearly"}, {"frequency": []}, {"frequency": {}}, {"frequency": "weekly", "interval": 0},
                     {"frequency": "weekly", "count": True}, {"frequency": "weekly", "count": 2, "until": "2027-01-01"},
                     {"frequency": "weekly", "until": "2026-01-01"}):
            with self.subTest(rule=rule), self.assertRaises(ValueError):
                self.create(recurrence=rule)
        self.assertEqual(self.calendar._events, {})
        with self.assertRaises(ValueError):
            self.create(time_zone="Invalid/Zone")
        self.create()
        with self.assertRaises(KeyError):
            self.calendar.get_event(next(iter(self.calendar._events)) + "~2026-10-26")

    def test_positive_offset_query_expands_in_series_zone(self):
        self.create(start="2026-01-02T01:00:00", end="2026-01-02T02:00:00", time_zone="Pacific/Kiritimati",
                    recurrence={"frequency": "daily", "count": 2})
        self.assertEqual(len(self.listing("2026-01-01T10:00:00Z", "2026-01-01T12:00:00Z")), 1)

    def test_displaced_exceptions_remain_editable_and_reopenable(self):
        master = self.create(recurrence={"frequency": "daily", "count": 3})
        occurrence = self.listing()[1]
        self.calendar.update_event(occurrence["id"], completed=True, title="Completed exception")
        moved = self.listing()[2]
        self.calendar.update_event(moved["id"], start="2027-01-01T09:00:00", end="2027-01-01T10:00:00")
        self.calendar.update_event(master["id"], recurrence=None)
        self.assertEqual(self.calendar.list_completed()[0]["id"], occurrence["id"])
        self.calendar.update_event(occurrence["id"], completed=False)
        self.assertEqual(self.calendar.list_completed(), [])
        self.assertFalse(self.calendar.get_event(occurrence["id"])["completed"])
        self.assertEqual(self.listing("2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z")[0]["id"], moved["id"])
        self.calendar.delete_event(occurrence["id"])
        with self.assertRaises(KeyError):
            self.calendar.get_event(occurrence["id"])
        self.calendar.delete_event(master["id"])
        self.assertEqual(self.listing("2027-01-01T00:00:00Z", "2027-01-02T00:00:00Z"), [])

    def test_past_event_cleanup_never_deletes_future_series(self):
        self.create(recurrence={"frequency": "weekly"})
        # This is precisely the tidy_calendar service contract: deleting range
        # items by their id can remove past occurrences, never their master.
        for event in self.listing("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"):
            self.calendar.delete_event(event["id"])
        self.assertGreater(len(self.listing("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z")), 0)

    def test_routes_validate_rules_and_allow_explicit_clearing(self):
        app = FastAPI(); app.include_router(calendar_routes.router)
        app.dependency_overrides[require_user] = lambda: "fixture"
        with patch.object(calendar_routes, "calendar_service", self.calendar), TestClient(app) as client:
            created = client.post("/api/calendar/events", json=dict(title="Repeated", start="2026-10-01", end="2026-10-02", all_day=True,
                recurrence={"frequency": "daily", "count": 2}))
            self.assertEqual(created.status_code, 200, created.text)
            cleared = client.patch("/api/calendar/events/" + created.json()["id"], json={"recurrence": None})
            self.assertEqual(cleared.status_code, 200, cleared.text)
            self.assertIsNone(cleared.json()["recurrence"])
            self.assertEqual(client.post("/api/calendar/events", json=dict(title="Bad", start="2026-10-01", end="2026-10-02", all_day=True,
                recurrence={"frequency": "daily", "count": 0})).status_code, 400)
            malformed = created.json()["id"] + "~not-a-date"
            for method in ("get", "delete", "patch"):
                self.assertEqual(getattr(client, method)("/api/calendar/events/" + malformed, **({"json": {"completed": True}} if method == "patch" else {})).status_code, 404)
            self.assertIn(created.json()["id"], self.calendar._events)


class GoogleRepeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeat_writes_rrule_and_keeps_iana_zone(self):
        fields = {"summary": "Weekly", "start": {"dateTime": "2026-10-25T09:00:00", "timeZone": "America/New_York"},
                  "end": {"dateTime": "2026-10-25T09:30:00", "timeZone": "America/New_York"},
                  "repeat": {"frequency": "weekly", "interval": 2, "count": 4}}
        with patch.object(google, "_calendar_access"), patch.object(google, "request", AsyncMock(return_value={"id": "series"})) as request:
            await google.calendar_action("create", event=fields)
            payload = request.call_args.kwargs["body"]
            self.assertEqual(payload["recurrence"], ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4"])
            self.assertEqual(payload["start"]["timeZone"], "America/New_York")
            self.assertEqual(payload["start"]["dateTime"], "2026-10-25T09:00:00-04:00")
            fields["repeat"] = None
            await google.calendar_action("update", event_id="series", event=fields)
            self.assertEqual(request.call_args.kwargs["body"]["recurrence"], [])
            del fields["repeat"]
            await google.calendar_action("update", event_id="series", event=fields)
            self.assertNotIn("recurrence", request.call_args.kwargs["body"])

    async def test_unsupported_remote_rule_is_marked_for_preservation(self):
        remote = {"id": "series", "start": {"dateTime": "2026-10-25T09:00:00-04:00", "timeZone": "America/New_York"},
                  "end": {"dateTime": "2026-10-25T10:00:00-04:00"}, "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]}
        mapped = google._map_calendar_event(remote, {"id": "primary", "access_role": "owner"})
        self.assertFalse(mapped["recurrence_supported"])
        self.assertEqual(mapped["recurrence_raw"], remote["recurrence"])
        self.assertEqual(mapped["time_zone"], "America/New_York")
        instance = google._map_calendar_event({**remote, "recurrence": [], "recurringEventId": "series"}, {"id": "primary"})
        self.assertEqual(instance["series_id"], "series")

    async def test_bad_google_repeat_never_calls_http(self):
        fields = {"summary": "Bad", "start": {"date": "2026-10-01"}, "end": {"date": "2026-10-02"}, "repeat": {"frequency": "daily", "interval": -1}}
        with patch.object(google, "_calendar_access"), patch.object(google, "request", AsyncMock()) as request:
            with self.assertRaises(google.GoogleError):
                await google.calendar_action("create", event=fields)
            request.assert_not_awaited()

    def test_google_until_roundtrip_and_custom_cutoff_preserved(self):
        rule = {"frequency": "daily", "interval": 1, "until": "2026-11-05"}
        lines = repeats.google_rule(rule, "2026-10-25T09:00:00", "America/New_York")
        self.assertEqual(lines, ["RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261106T045959Z"])
        self.assertEqual(repeats.parse_google_rule(lines, "2026-10-25T09:00:00", "America/New_York"), rule)
        self.assertFalse(repeats.parse_google_rule(["RRULE:FREQ=DAILY;UNTIL=20261106T040000Z"], "2026-10-25T09:00:00", "America/New_York"))
        for invalid in ([None], [1], ["invalid"], {"rule": "invalid"}):
            self.assertFalse(repeats.parse_google_rule(invalid, "2026-10-25T09:00:00"))


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        _DATA.cleanup()
