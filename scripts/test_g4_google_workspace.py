"""A11 Google Workspace and Calendar gaps (Part 2, group g4): Drive/Sheets/Forms writes, error honesty,
calendar request counts, '#' ids, CalDAV/iCal source handling. Google's HTTP layer is mocked; no account, no network.

Tests named test_BUG_* assert the CORRECT behaviour and currently FAIL on dev; each is reported to David.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g4_google_workspace.py
"""
import asyncio
import json
import os
import sys
import time
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.tab_test_support import TemporaryDirectory
_DATA = TemporaryDirectory(prefix="g4-google-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import httpx
from fastapi import FastAPI
from core import dav_client, google_workspace as google
from core.middleware import require_admin, require_user
from routes import google_routes, calendar_routes
from services import calendar_service as cal_module

REAL_CLIENT = httpx.AsyncClient
SECRET = "super-secret-access-token"
CALS = [{"id": "me@example.com", "summary": "Mine", "primary": True, "accessRole": "owner", "timeZone": "America/New_York"},
        {"id": "en.usa#holiday@group.v.calendar.google.com", "summary": "Holidays", "accessRole": "reader"}]
EV = {"id": "e1", "summary": "Standup", "start": {"dateTime": "2026-10-28T09:00:00-04:00"}, "end": {"dateTime": "2026-10-28T09:30:00-04:00"}}


class Harness(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.data = {"client_id": "c.apps.googleusercontent.com", "refresh_token": "r", "granted_scopes": list(google.SCOPES)}
        self.requests = []
        self.fail = None  # callable(req) -> httpx.Response | None
        def save(d): self.data = deepcopy(d)
        for p in (patch.object(google, "_load", lambda: deepcopy(self.data)), patch.object(google, "_save", save),
                  patch.object(google, "_token", AsyncMock(return_value=SECRET)),
                  patch.object(google.httpx, "AsyncClient", lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(self.http), **kw))):
            p.start(); self.addCleanup(p.stop)
        google.invalidate_calendar()

    def http(self, req):
        self.requests.append(req)
        if self.fail:
            r = self.fail(req)
            if r is not None:
                return r
        path = req.url.path
        if path.endswith("/calendarList"):
            return httpx.Response(200, json={"items": CALS})
        if "/calendar/v3/calendars/" in path and req.method == "GET":
            return httpx.Response(200, json={"items": [EV]})
        if req.method == "DELETE":
            return httpx.Response(204)
        if "/files" in path and req.method == "GET" and "/revisions" not in path and "/permissions" not in path and req.url.params.get("alt") != "media":
            return httpx.Response(200, json={"id": "f1", "parents": ["old-parent"], "files": []})
        return httpx.Response(200, json={"id": "f1", "ok": True})

    def body(self, req):
        return json.loads(req.content) if req.content else None

    async def web(self, path, method="GET", body=None, **kw):
        app = FastAPI()
        app.include_router(google_routes.router); app.include_router(calendar_routes.router)
        app.dependency_overrides[require_admin] = lambda: "u"; app.dependency_overrides[require_user] = lambda: "u"
        async with REAL_CLIENT(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.request(method, path, json=body, **kw)


class DriveTests(Harness):
    async def act(self, **body):
        self.requests.clear()
        r = await self.web("/api/google/drive/action", "POST", body)
        return r

    async def test_every_drive_action_sends_the_right_google_request(self):
        r = await self.act(action="create_folder", name="Plans", parent="root1")
        self.assertEqual(r.status_code, 200)
        q = self.requests[-1]; self.assertEqual((q.method, q.url.path), ("POST", "/drive/v3/files"))
        self.assertEqual(self.body(q), {"name": "Plans", "mimeType": "application/vnd.google-apps.folder", "parents": ["root1"]})
        await self.act(action="rename", file_id="f1", name="New name")
        self.assertEqual((self.requests[-1].method, self.body(self.requests[-1])), ("PATCH", {"name": "New name"}))
        await self.act(action="move", file_id="f1", parent="dest")
        self.assertEqual([q.method for q in self.requests], ["GET", "PATCH"], "move reads the old parents first")
        mv = self.requests[-1].url.params
        self.assertEqual((mv["addParents"], mv["removeParents"]), ("dest", "old-parent"))
        await self.act(action="copy", file_id="f1", name="Copy of it", parent="dest")
        self.assertEqual((self.requests[-1].url.path.endswith("/f1/copy"), self.body(self.requests[-1])), (True, {"name": "Copy of it", "parents": ["dest"]}))
        for action, expect in (("trash", {"trashed": True}), ("restore", {"trashed": False}), ("star", {"starred": True}), ("unstar", {"starred": False})):
            await self.act(action=action, file_id="f1")
            self.assertEqual((self.requests[-1].method, self.body(self.requests[-1])), ("PATCH", expect), action)
        r = await self.act(action="delete", file_id="f1")
        self.assertEqual((self.requests[-1].method, r.json()), ("DELETE", {"deleted": True}))
        await self.act(action="permissions", file_id="f1"); self.assertTrue(self.requests[-1].url.path.endswith("/f1/permissions"))
        await self.act(action="revisions", file_id="f1"); self.assertTrue(self.requests[-1].url.path.endswith("/f1/revisions"))
        await self.act(action="share", file_id="f1", email="a@b.co", role="reader")
        q = self.requests[-1]; self.assertEqual(self.body(q), {"type": "user", "role": "reader", "emailAddress": "a@b.co"})
        self.assertEqual(q.url.params["sendNotificationEmail"], "true")
        await self.act(action="share", file_id="f1", permission_type="anyone", role="reader")
        self.assertEqual(self.requests[-1].url.params["sendNotificationEmail"], "false")
        await self.act(action="update_permission", file_id="f1", permission_id="p1", role="writer")
        self.assertEqual((self.requests[-1].method, self.body(self.requests[-1])), ("PATCH", {"role": "writer"}))
        r = await self.act(action="revoke", file_id="f1", permission_id="p1")
        self.assertEqual((self.requests[-1].method, r.json()), ("DELETE", {"revoked": True}))

    async def test_bad_input_is_refused_before_any_google_call(self):
        cases = [dict(action="rename", file_id="f1", name=""), dict(action="rename", file_id="f1", name="x" * 256),
                 dict(action="move", file_id="f1"), dict(action="share", file_id="f1", email="nope", role="reader"),
                 dict(action="share", file_id="f1", email="a@b.co", role="owner"), dict(action="share", file_id="f1", permission_type="domain", domain="bad domain!", role="reader"),
                 dict(action="update_permission", file_id="f1", permission_id="p", role="owner"),
                 dict(action="trash", file_id="../etc"), dict(action="trash", file_id="a/b"), dict(action="trash"), dict(action="explode", file_id="f1")]
        for body in cases:
            r = await self.act(**body)
            self.assertIn(r.status_code, (400, 422), body); self.assertEqual(self.requests, [], body)

    async def test_provider_permission_error_is_honest_and_never_carries_the_token(self):
        self.fail = lambda req: httpx.Response(403, json={"error": {"message": "The user does not have sufficient permissions for this file."}})
        r = await self.act(action="rename", file_id="f1", name="x")
        self.assertEqual(r.status_code, 403)
        self.assertIn("sufficient permissions", r.json()["detail"]); self.assertNotIn(SECRET, r.text)
        self.fail = lambda req: httpx.Response(500, text="<html>Internal error " + SECRET + "</html>")
        r = await self.act(action="trash", file_id="f1")
        self.assertEqual(r.status_code, 500)

    async def test_upload_is_multipart_bounded_and_download_exports_google_files(self):
        r = await self.web("/api/google/drive/upload", "POST", files={"file": ("a.txt", b"hello", "text/plain")}, data={"parent": "p1"})
        self.assertEqual(r.status_code, 200)
        q = self.requests[-1]
        self.assertEqual((q.url.host, q.url.params["uploadType"]), ("www.googleapis.com", "multipart"))
        self.assertIn(b'"parents": ["p1"]', q.content); self.assertIn(b"hello", q.content)
        self.requests.clear()
        r = await self.web("/api/google/drive/upload", "POST", files={"file": ("big.bin", b"x" * (google.MAX_DOWNLOAD + 1), "application/octet-stream")})
        self.assertEqual(r.status_code, 413); self.assertEqual(self.requests, [], "oversize upload never reaches Google")
        # A Google Sheet downloads as xlsx; a Google Form cannot be exported and says so.
        def info(req):
            if req.url.path.endswith("/export"):
                return httpx.Response(200, content=b"xlsxbytes", headers={"content-type": "application/octet-stream"})
            if req.url.path.endswith("/f1"):
                return httpx.Response(200, json={"id": "f1", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet"})
            if req.url.path.endswith("/f2"):
                return httpx.Response(200, json={"id": "f2", "name": "Survey", "mimeType": "application/vnd.google-apps.form"})
        self.fail = info
        r = await self.web("/api/google/drive/files/f1/download")
        self.assertEqual((r.status_code, r.content), (200, b"xlsxbytes"))
        self.assertIn("Budget.xlsx", r.headers["content-disposition"])
        self.assertEqual((await self.web("/api/google/drive/files/f2/download")).status_code, 400)

    async def test_search_paging_and_kind_filters_build_bounded_queries(self):
        self.fail = lambda req: httpx.Response(200, json={"files": [], "nextPageToken": "n2"})
        r = await self.web("/api/google/drive/files?q=it's%20here&kind=sheet&page_token=t1&parent=fold1")
        q = self.requests[-1].url.params
        self.assertEqual(r.json()["nextPageToken"], "n2")
        self.assertIn("name contains 'it\\'s here'", q["q"]); self.assertIn("'fold1' in parents", q["q"])
        self.assertIn("spreadsheet", q["q"]); self.assertEqual((q["pageToken"], q["pageSize"]), ("t1", "100"))
        self.assertEqual((await self.web("/api/google/drive/files?kind=bogus")).status_code, 400)
        self.assertEqual((await self.web("/api/google/drive/files?section=bogus")).status_code, 400)


class SheetsFormsTests(Harness):
    async def test_sheet_create_read_update_append_clear_batch(self):
        await self.web("/api/google/sheets/action", "POST", {"action": "create", "title": "Q4"})
        self.assertEqual(self.body(self.requests[-1]), {"properties": {"title": "Q4"}})
        await self.web("/api/google/sheets/f1?cell_range=Sheet1!A1:B2")
        self.assertTrue(self.requests[-1].url.path.endswith("/spreadsheets/f1/values/Sheet1!A1:B2"), self.requests[-1].url)
        await self.web("/api/google/sheets/action", "POST", {"action": "update", "file_id": "f1", "cell_range": "A1:B1", "values": [["a", 1]]})
        q = self.requests[-1]; self.assertEqual((q.method, q.url.params["valueInputOption"]), ("PUT", "USER_ENTERED"))
        self.assertEqual(self.body(q)["values"], [["a", 1]])
        await self.web("/api/google/sheets/action", "POST", {"action": "append", "file_id": "f1", "cell_range": "A1", "values": [["z"]]})
        self.assertTrue(self.requests[-1].url.path.endswith(":append"))
        await self.web("/api/google/sheets/action", "POST", {"action": "clear", "file_id": "f1", "cell_range": "A1:B2"})
        self.assertTrue(self.requests[-1].url.path.endswith(":clear"))
        await self.web("/api/google/sheets/action", "POST", {"action": "batch", "file_id": "f1", "requests": [{"addSheet": {}}]})
        self.assertTrue(self.requests[-1].url.path.endswith(":batchUpdate"))

    async def test_bad_ranges_and_limits_are_refused_or_reported_by_the_provider(self):
        self.requests.clear()
        for body in ({"action": "update", "file_id": "f1", "values": [["a"]]},
                     {"action": "update", "file_id": "f1", "cell_range": "A" * 301, "values": [["a"]]},
                     {"action": "update", "file_id": "f1", "cell_range": "A1", "values": [["a"]] * 1001},
                     {"action": "update", "file_id": "f1", "cell_range": "A1"},
                     {"action": "batch", "file_id": "f1", "requests": [{}] * 51},
                     {"action": "update", "file_id": "f1", "cell_range": "../../x", "values": [["a"]]},
                     {"action": "update", "file_id": "bad/id", "cell_range": "A1", "values": [["a"]]}):
            r = await self.web("/api/google/sheets/action", "POST", body)
            self.assertIn(r.status_code, (400, 422), body)
        self.assertEqual(self.requests, [], "nothing reached Google")
        self.fail = lambda req: httpx.Response(400, json={"error": {"message": "Unable to parse range: Nope!Z9"}})
        r = await self.web("/api/google/sheets/f1?cell_range=Nope!Z9")
        self.assertEqual(r.status_code, 400); self.assertIn("Unable to parse range", r.json()["detail"])
        self.fail = lambda req: httpx.Response(403, json={"error": {"message": "The caller does not have permission"}})
        r = await self.web("/api/google/sheets/action", "POST", {"action": "clear", "file_id": "f1", "cell_range": "A1"})
        self.assertEqual((r.status_code, "does not have permission" in r.json()["detail"]), (403, True))

    async def test_forms_create_read_responses_batch_publish(self):
        await self.web("/api/google/forms/action", "POST", {"action": "create", "title": "Poll"})
        self.assertEqual(self.body(self.requests[-1]), {"info": {"title": "Poll"}})
        await self.web("/api/google/forms/f1?responses=true&page_token=pg")
        self.assertTrue(self.requests[-1].url.path.endswith("/forms/f1/responses")); self.assertEqual(self.requests[-1].url.params["pageToken"], "pg")
        await self.web("/api/google/forms/action", "POST", {"action": "batch", "file_id": "f1", "requests": [{"createItem": {}}]})
        await self.web("/api/google/forms/action", "POST", {"action": "publish", "file_id": "f1", "published": True})
        self.assertTrue(self.body(self.requests[-1])["publishSettings"]["publishState"]["isPublished"])
        self.requests.clear()
        for body in ({"action": "create"}, {"action": "publish", "file_id": "f1"}, {"action": "batch", "file_id": "f1", "requests": [{}] * 51}):
            self.assertIn((await self.web("/api/google/forms/action", "POST", body)).status_code, (400, 422), body)
        self.assertEqual(self.requests, [])
        self.fail = lambda req: httpx.Response(403, json={"error": {"message": "Forms API has not been used in project"}})
        self.assertEqual((await self.web("/api/google/forms/f1")).status_code, 403)


class CalendarTests(Harness):
    async def test_hash_calendar_ids_reach_google_encoded_and_keep_their_own_write_permission(self):
        hid = "en.usa#holiday@group.v.calendar.google.com"
        listed = (await self.web("/api/google/calendar/calendars")).json()
        self.assertEqual({c["id"]: c["access_role"] for c in listed}, {"me@example.com": "owner", hid: "reader"})
        await self.web("/api/google/calendar/settings", "PATCH", {"calendar_ids": [hid, "me@example.com", hid]})
        self.assertEqual(self.data["accounts"][self.data["default_account"]]["calendar_ids"], [hid, "me@example.com"], "duplicates collapse")
        self.requests.clear()
        events = (await self.web("/api/google/calendar/events?start=2026-10-01T00:00:00Z&end=2026-11-01T00:00:00Z&calendar_ids=" + "en.usa%23holiday%40group.v.calendar.google.com")).json()
        self.assertEqual((events[0]["editable"], events[0]["calendar_id"]), (False, hid), "reader calendars are not editable in the UI")
        paths = [q.url.raw_path.decode() for q in self.requests if "/events" in q.url.path]
        self.assertTrue(all("%23" in p and "#" not in p for p in paths), paths)
        # Writing to a read-only calendar: Google's refusal is surfaced with its status, nothing is faked.
        self.fail = lambda req: httpx.Response(403, json={"error": {"message": "Forbidden"}}) if req.method == "POST" else None
        r = await self.web("/api/google/calendar/action", "POST", {"action": "create", "calendar_id": hid, "event": {
            "summary": "x", "start": {"dateTime": "2026-10-28T09:00:00", "timeZone": "America/New_York"}, "end": {"dateTime": "2026-10-28T10:00:00", "timeZone": "America/New_York"}}})
        self.assertEqual(r.status_code, 403)

    async def fetch_counts(self):
        await self.web("/api/google/status")  # migrates the legacy single account
        a, b = "2026-10-26T00:00:00-04:00", "2026-11-02T00:00:00-04:00"
        counts = []
        with google.use_account(google.resolve_calendar_account("u"), "u"):
            for end in (b, b, "2026-11-02T00:00:01-04:00"):
                self.requests.clear()
                await google.selected_calendar_events(a, end)
                counts.append([q.url.path.split("/")[-1] for q in self.requests])
        print(f"\n[bench] Google Calendar range with 2 selected calendars, calendar_ids unset: uncached={counts[0]} cached repeat={counts[1]} range shifted 1s={counts[2]}")
        return counts

    async def test_repeat_range_is_served_from_the_60_second_cache(self):
        counts = await self.fetch_counts()
        self.assertEqual(counts[0].count("events"), 2, "one events call per selected calendar")
        self.assertNotIn("events", counts[1], "a repeat inside 60s makes no events call")

    async def test_EFFICIENCY_calendar_list_is_read_once_per_fetch_and_not_on_cache_hits(self):
        counts = await self.fetch_counts()
        self.assertEqual(counts[0].count("calendarList"), 1, "selected_calendar_events and calendar_events each read calendarList")
        self.assertEqual(counts[1], [], "even a fully cached repeat still spends a calendarList request")

    async def test_all_day_timed_dst_and_boundary_writes(self):
        for ev, ok in (({"summary": "t", "start": {"date": "2026-11-01"}, "end": {"date": "2026-11-02"}}, True),
                       ({"summary": "t", "start": {"date": "2026-11-01"}, "end": {"date": "2026-11-01"}}, False),
                       ({"summary": "t", "start": {"dateTime": "2026-11-01T01:30:00", "timeZone": "America/New_York"}, "end": {"dateTime": "2026-11-01T02:30:00", "timeZone": "America/New_York"}}, True),
                       ({"summary": "t", "start": {"dateTime": "2026-11-01T10:00:00", "timeZone": "Mars/Base"}, "end": {"dateTime": "2026-11-01T11:00:00", "timeZone": "Mars/Base"}}, False),
                       ({"summary": "t", "start": {"date": "2026-02-30"}, "end": {"date": "2026-03-01"}}, False),
                       ({"summary": "t", "start": {"date": "2026-11-01"}, "end": {"dateTime": "2026-11-02T00:00:00Z"}}, False)):
            r = await self.web("/api/google/calendar/action", "POST", {"action": "create", "event": ev})
            self.assertEqual(r.status_code == 200, ok, ev)


class SyncedSourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory(dir=_DATA.name); self.addCleanup(self.tmp.cleanup)
        p = patch.object(cal_module, "EVENTS_FILE", str(Path(self.tmp.name) / "events.json")); p.start(); self.addCleanup(p.stop)
        p = patch.object(cal_module.notes_service, "list_notes", return_value=[]); p.start(); self.addCleanup(p.stop)
        self.cal = cal_module.CalendarService()

    ICS = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Lecture\r\nDTSTART;TZID=America/New_York:20261101T090000\r\nDTEND;TZID=America/New_York:20261101T100000\r\nEND:VEVENT\r\n"
           "BEGIN:VEVENT\r\nUID:a2\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")

    def test_feed_events_replace_in_place_and_keep_completion_across_resync(self):
        events = dav_client.parse_vevents(self.ICS)
        self.assertEqual([e["uid"] for e in events], ["a1", "a2"])
        self.assertEqual(self.cal.replace_synced_events("feed1", events), 2)
        eid = next(e["id"] for e in self.cal._events.values() if e["external_uid"] == "a2")
        self.cal.update_event(eid, completed=True)
        self.cal.replace_synced_events("feed1", events)
        self.assertEqual(len([e for e in self.cal._events.values() if e["sync_id"] == "feed1"]), 2, "no duplicates after a re-sync")
        self.assertTrue(next(e for e in self.cal._events.values() if e["external_uid"] == "a2")["completed"])
        self.cal.create_event("Mine", "2026-11-03T09:00:00Z", "2026-11-03T10:00:00Z")
        self.cal.replace_synced_events("feed1", [])
        self.assertEqual([e["title"] for e in self.cal._events.values()], ["Mine"], "an integration's removal never touches hand-made events")

    def test_BUG_feed_timezone_is_honoured(self):
        self.cal.replace_synced_events("feed1", dav_client.parse_vevents(self.ICS))
        lecture = next(e for e in self.cal._events.values() if e["title"] == "Lecture")
        from datetime import datetime
        instant = datetime.fromisoformat(lecture["start"])
        self.assertEqual(instant.astimezone(__import__("datetime").timezone.utc).hour, 14,
                         "09:00 America/New_York is 14:00Z; DTSTART;TZID is parsed without its zone and stored as UTC wall time")

    def test_BUG_one_day_all_day_feed_event_occupies_one_day(self):
        self.cal.replace_synced_events("feed1", dav_client.parse_vevents(self.ICS))
        nxt = [e for e in self.cal.list_for_dates("2026-11-02", "2026-11-02") if e["title"] == "Holiday"]
        self.assertEqual(nxt, [], "iCal DTEND for all-day events is exclusive; synced events keep an inclusive end so a 1-day holiday shows on 2 days")

    def test_resync_write_amplification(self):
        evs = [{"uid": f"u{i}", "title": f"E{i}", "start": "2026-11-01T09:00:00Z", "end": "2026-11-01T10:00:00Z", "all_day": False} for i in range(500)]
        saves = []
        real = self.cal._save
        self.cal._save = lambda: (saves.append(1), real())[1]
        t = time.perf_counter(); self.cal.replace_synced_events("feed1", evs); ms = (time.perf_counter() - t) * 1000
        print(f"\n[bench] iCal/CalDAV re-sync of 500 events: {len(saves)} full-file writes, {ms:.0f} ms")
        self.assertLessEqual(len(saves), 2, "create_event saves the whole file once per event")

    def test_failed_fetch_keeps_the_previous_events(self):
        from core import sync_engine, integrations
        self.cal.replace_synced_events("feed1", dav_client.parse_vevents(self.ICS))
        with patch.object(integrations, "get_integration", return_value={"id": "feed1", "kind": "ical_feed"}), \
             patch.object(integrations, "get_ical_credentials", return_value=("https://x/feed.ics", None, None)), \
             patch.object(dav_client, "sync_ical_feed", AsyncMock(side_effect=httpx.ConnectError("offline"))), \
             patch("services.calendar_service.calendar_service", self.cal):
            with self.assertRaises(httpx.ConnectError):
                asyncio.run(sync_engine.sync_integration("feed1"))
        self.assertEqual(len(self.cal._events), 2, "an offline sync is an error, not a wipe")


if __name__ == "__main__":
    unittest.main(verbosity=1)
