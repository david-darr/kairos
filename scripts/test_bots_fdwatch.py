"""Front-desk checks and the absent/merged Phase 3 adapter contract. No network."""
import asyncio
import os
import sys
import time
import types
import unittest
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-fdwatch-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

from core import front_desk_checks as checks, front_desk_watch_adapter as adapter
from services import front_desk_watch as watch, front_desk_brief as brief
from services import front_desk_ledger as ledger


class Harness(unittest.TestCase):
    def setUp(self):
        self.cards, self.notifications, self.routines, self.run_rows, self.created = {}, [], {}, [], []
        self.now = time.time()
        self.connected = {"mail": False, "calendar": False}
        self.fake = types.ModuleType("services.bot_routines")
        self.fake.create = self.create
        self.fake.get = lambda owner, ident: self.routines.get(ident)
        self.fake.run_now = lambda owner, ident: {"id": "manual-run", "routine_id": ident}
        self.fake.runs = lambda owner, since: [r for r in self.run_rows if checks.stamp(r.get("ended_at")) >= since]
        self.callbacks, self.sinks = {}, {}
        self.check_module = types.ModuleType("core.bot_routine_checks")
        self.check_module.register_check = lambda name, fn: self.callbacks.update({name: fn})
        self.check_module.register_sink = lambda name, fn: self.sinks.update({name: fn})
        for p in (
            patch.object(watch, "DIRECTORY", str(Path(_DATA.name) / uuid.uuid4().hex)),
            patch.object(watch, "bot_id", return_value="kip"), patch.object(watch, "main_thread_id", return_value="main"),
            patch.object(watch, "owner", return_value="david"), patch.object(watch, "connected", side_effect=lambda: self.connected),
            patch.object(adapter, "post_card", side_effect=self.post_card),
            patch.object(adapter, "notify", side_effect=lambda key, *args: self.notifications.append(key)),
            patch.object(brief, "_questions", return_value=[]), patch.object(checks, "calendar_rows", AsyncMock(return_value=[])),
            patch.object(brief, "email_row", side_effect=lambda r: {"from": "Alex <alex@example.com>", "subject": "Can we meet?", "message_id": "<m@x>"}),
        ):
            p.start()
            self.addCleanup(p.stop)
        # Swap only the two stand-in modules: patch.dict(sys.modules) would also drop
        # everything imported during the test, and bcrypt cannot be imported twice.
        for name, module in (("services.bot_routines", self.fake), ("core.bot_routine_checks", self.check_module)):
            previous = sys.modules.get(name)
            sys.modules[name] = module
            self.addCleanup(lambda n=name, p=previous: sys.modules.__setitem__(n, p) if p is not None else sys.modules.pop(n, None))
        watch.write("state", {"seeded_at": self.now - 86400})

    def post_card(self, kind, data, *, key, **kwargs):
        row = {"fd_kind": kind, "fd_data": deepcopy(data), "fd_key": key}
        self.cards[key] = row
        return row

    def create(self, owner, config, *, idempotency_key):
        if idempotency_key in self.routines:
            return self.routines[idempotency_key]
        self.assertEqual(owner, "david")
        row = {**config, "id": idempotency_key, "revision": 1}
        self.routines[row["id"]] = row
        self.created.append(row)
        return row

    def mail(self, n, **fields):
        return {"id": "m" + str(n), "uid": str(n + 1), "uidvalidity": "1", "account": "acct", "date": self.now - n,
                "subject": "Can you help?", "from": "alex@example.com", **fields}

    def run_async(self, awaitable):
        return asyncio.run(awaitable)


class Installation(Harness):
    def test_connected_only_once_pause_and_delete_never_recreate(self):
        self.assertIsNone(watch.ensure_watch())
        self.connected["mail"] = True
        made = watch.ensure_watch()
        watch.ensure_watch()
        self.assertEqual(len(self.created), 1)
        row = self.created[0]
        self.assertEqual(row["checks"], ["calendar", "mail", "runs"])
        self.assertEqual((row["access"], row["deliver"], row["overlap"]), ("read-and-draft", "brief", "skip"))
        self.assertAlmostEqual(checks.stamp(row["schedule"]["anchor_at"]) - self.now, 900, delta=3)
        self.assertEqual(watch.state()["edited"], False)
        row["enabled"] = False
        self.assertEqual(watch.state()["state"], "paused")
        watch.ensure_watch()
        row["name"] = "My watch"
        self.assertTrue(watch.state()["edited"])
        del self.routines[made["routine_id"]]
        self.assertEqual(watch.state()["state"], "off")
        watch.ensure_watch()
        self.assertEqual(len(self.created), 1)

    def test_creation_receipt_recovers_crash_before_stamp(self):
        self.connected["calendar"] = True
        original = watch.write
        with patch.object(watch, "write", side_effect=lambda name, value: (_ for _ in ()).throw(OSError("crash")) if name == "watch" else original(name, value)):
            with self.assertRaises(OSError): watch.ensure_watch()
        watch.ensure_watch()
        self.assertEqual(len(self.created), 1)

    def test_adapter_contract_and_missing_modules(self):
        self.assertTrue(adapter.available())
        adapter.register()
        self.assertEqual(set(self.callbacks), {"mail", "calendar", "runs"})
        self.assertEqual(set(self.sinks), {"brief"})
        self.assertEqual(adapter.create({"name": "watch"}, owner="david", key="key")["id"], "key")
        with patch.object(adapter, "_routines", side_effect=ModuleNotFoundError(name="services.bot_routines")):
            self.assertFalse(adapter.available())
            self.connected["mail"] = True
            self.assertIsNone(watch.ensure_watch())
            self.assertFalse(watch.state()["enabled"])

    def test_run_now_ten_minute_gate_and_settings_bounds(self):
        self.connected["calendar"] = True
        watch.ensure_watch()
        watch.run_now()
        with self.assertRaisesRegex(ValueError, "recently"): watch.run_now()
        watch.write("checks", {"last_run_at": time.time() - 300})
        with self.assertRaises(ValueError): watch.run_now()
        for invalid in ("24:00", "8:00", "08:60", "09:00\n"):
            with self.assertRaises(ValueError): watch.settings(morning_time=invalid)
        self.assertEqual(watch.settings(morning_time="09:25", morning_on=False)["time"], "09:25")


class MailChecks(Harness):
    def test_nothing_new_never_requests_a_model_or_posts_caption(self):
        with patch.object(checks, "read_mail", AsyncMock(return_value=[])):
            result = self.run_async(checks.check_mail(now=self.now))
        self.assertFalse(result["needs_model"])
        self.assertEqual(result["prompt"], "")
        delivered = self.run_async(checks.deliver(result))
        self.assertEqual(delivered["result"], "NOTHING NEW")
        self.assertEqual(self.cards, {})

    def test_window_batch_rules_and_metadata_only(self):
        mail = AsyncMock(return_value=[self.mail(n) for n in range(100)])
        with patch.object(checks, "read_mail", mail):
            result = self.run_async(checks.check_mail(now=self.now))
        self.assertEqual(mail.call_args.args[1], self.now - 43200)
        self.assertEqual(len(result["records"]), 20)
        self.assertTrue(result["needs_model"])
        self.assertTrue(result["tainted"])
        self.assertIn("UNTRUSTED-", result["prompt"])
        self.assertNotIn("Can you help", str(watch.read("checks")))
        for row in (self.mail(1, list_unsubscribe=True), self.mail(1, precedence="bulk"), self.mail(1, auto_submitted="auto-replied"), self.mail(1, subject="Accepted: Meeting")):
            self.assertEqual(checks.header_verdict(row), "can_wait")
        self.assertIsNone(checks.header_verdict(self.mail(1)))
        watch.write("checks", {"mail": {"cursor": self.now - 900000}})
        with patch.object(checks, "read_mail", AsyncMock(return_value=[])) as mail:
            self.run_async(checks.check_mail(now=self.now))
        self.assertEqual(mail.call_args.args[1], self.now - 86400)

    def test_rules_only_mail_does_not_request_model(self):
        with patch.object(checks, "read_mail", AsyncMock(return_value=[self.mail(1, list_unsubscribe=True)])):
            result = self.run_async(checks.check_mail(now=self.now))
        self.assertFalse(result["needs_model"])
        self.assertEqual(ledger.totals()["sorted"], 1)

    def test_failed_sort_is_safe_side_five_picks_backoff_and_no_lost_rest(self):
        with patch.object(checks, "read_mail", AsyncMock(return_value=[self.mail(n) for n in range(20)])):
            result = self.run_async(checks.check_mail(now=self.now))
        self.run_async(checks.deliver(result, "bad JSON", run_id="r1"))
        important = watch.read("brief")["important"]
        self.assertEqual(len(important), 5)
        self.assertTrue(all(r["reason"] == checks.SAFE_SIDE for r in important))
        self.assertEqual(len(watch.read("checks")["mail"]["judged"]), 5)
        self.assertEqual(watch.read("checks")["mail"]["pending"], {})
        self.assertGreater(watch.read("checks")["mail"]["backoff_until"], self.now)
        again = self.run_async(checks.check_mail(now=self.now + 1))
        self.assertTrue(again["deferred"])

    def test_parser_never_accepts_invented_ids_partial_results_or_six_picks(self):
        rows = [self.mail(n) for n in range(6)]
        valid = {"important": [{"id": r["id"], "verdict": "can_wait", "reason": "No action needed"} for r in rows]}
        self.assertIsNotNone(checks.parse_sort(valid, rows))
        for bad in ({"important": valid["important"][:-1]}, {"important": [{"id": "forged", "verdict": "needs_you", "reason": "Do it"}]},
                    {"important": [{**r, "verdict": "needs_you"} for r in valid["important"]]},
                    {"important": [{**r, "reason": "word " * 21} for r in valid["important"]]}):
            self.assertIsNone(checks.parse_sort(bad, rows))

    def test_late_delivery_cannot_commit_a_new_occurrences_lease(self):
        with patch.object(checks, "read_mail", AsyncMock(return_value=[self.mail(1)])):
            old = self.run_async(checks.check_mail(now=self.now - 20000))
            # Create a current lease manually: an old callback must not use it.
            old.update(records=[self.mail(1)], lease_at=self.now - 20000)
            data = watch.read("checks")
            data["mail"]["pending"] = {"m1": self.now}
            watch.write("checks", data)
        self.run_async(checks.deliver(old, failed=True))
        self.assertEqual(watch.read("brief")["important"], [])
        self.assertEqual(watch.read("checks")["mail"]["pending"], {"m1": self.now})


class CalendarChecks(Harness):
    def event(self, **fields):
        return {"id": "e1", "title": "Planning", "start": self.now + 14400, "end": self.now + 18000, "guests": 2,
                "meeting_url": "https://meet.example.com/room", **fields}

    def test_merge_keeps_most_guests_and_repeating_occurrences(self):
        rows = checks.merge_calendar([self.event(guests=0), self.event(guests=3), self.event(id="e2", start=self.now+86400, end=self.now+87000)])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["guests"], 3)
        a = self.event(series_id="series")
        b = self.event(series_id="series", start=self.now+86400, end=self.now+87000)
        self.assertEqual(len(checks.merge_calendar([a, b])), 2)

    def test_prep_reminder_short_and_changed_signature_notify_once(self):
        rows = checks.merge_calendar([self.event()])
        result = checks.calendar_plan(rows, self.now)
        self.assertEqual([d["kind"] for d in result["due"]], ["prep"])
        self.assertEqual(result["next_meeting_due"], self.now + 13800)
        for due in result["due"]:
            brief.post_meeting(due); brief.post_meeting(due)
        self.assertEqual(len(self.notifications), 1)
        self.assertEqual(ledger.totals()["prepped"], 1)
        late = checks.calendar_plan(checks.merge_calendar([self.event(start=self.now + 500, end=self.now + 4000)]), self.now)
        self.assertEqual([r["kind"] for r in late["due"]], ["prep", "reminder"])
        self.assertTrue(late["due"][0]["short"])
        changed = checks.calendar_plan(checks.merge_calendar([self.event(guests=4)]), self.now)
        self.assertEqual(len(changed["due"]), 1)

    def test_clashes_and_source_failure_backoff(self):
        now = datetime.now(timezone.utc).replace(hour=10, minute=0, second=0).timestamp()
        self.now = now
        rows = checks.merge_calendar([self.event(start=now+3600, end=now+7200), self.event(id="e2", title="Interview", start=now+4000, end=now+8000)])
        self.assertEqual(len(checks.calendar_plan(rows, now)["clashes"]), 1)
        for index in range(5): checks.failure("calendar", ValueError("token expired"), now)
        data = watch.read("checks")["calendar"]
        self.assertTrue(data["signed_out"])
        self.assertEqual(data["backoff_until"], now + 7200)
        self.assertTrue(self.run_async(checks.check_calendar(now=now))["deferred"])

    def test_other_runs_feed_brief_once_and_keep_watch_out(self):
        watch.write("watch", {"routine_id": "own"})
        self.run_rows = [{"id": "r1", "routine_id": "other", "ended_at": self.now, "status": "completed", "name": "Report"},
                         {"id": "r2", "routine_id": "own", "ended_at": self.now, "status": "failed"}]
        result = self.run_async(checks.check_runs(now=self.now))
        self.assertEqual([r["id"] for r in result["records"]], ["r1"])
        self.run_async(checks.deliver(result, run_id="r1"))
        self.run_async(checks.deliver(result, run_id="r1"))
        self.assertEqual(ledger.totals()["routines"], 1)


class TickTests(Harness):
    def test_tick_lifecycle_one_task_and_errors_do_not_stop_other_jobs(self):
        from core import front_desk_tick as tick
        async def exercise():
            with patch.object(tick, "tick", AsyncMock()) as job:
                first = tick.start()
                self.assertIs(tick.start(), first)
                await asyncio.sleep(.01)
                await tick.stop()
                self.assertTrue(first.done())
                self.assertEqual(job.await_count, 1)
            with patch.object(watch, "ensure_watch", side_effect=RuntimeError("offline")), patch.object(brief, "morning_due", AsyncMock()) as morning, patch.object(brief, "recap_due", AsyncMock()) as recap:
                with self.assertLogs(tick.logger, "ERROR"):
                    await tick.tick()
                self.assertEqual((morning.await_count, recap.await_count), (1, 1))
        self.run_async(exercise())


if __name__ == "__main__":
    unittest.main()
