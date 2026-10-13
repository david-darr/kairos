"""Durable work, roadmap phase 4 (core/task_scheduler.py, services/
task_service.py, core/outbox.py; spec: the vault note "Durable Work - Phase 4
(Build Spec)").

What these prove: a scheduled run happens at most once, even across a crash;
one task never runs twice at once; only the schedule moves the schedule; a
long card holds up nothing; a run can be stopped and still counts what it
used; a channel message is retried, never sent twice by a restart, and
given up visibly.

Runs against a throwaway data folder; models and channels are stand-ins, so
nothing is spent or sent. Run: python scripts/test_durable_work.py
"""
import asyncio
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-durable-test-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import events, outbox, runs, session_manager_store as store, task_scheduler  # noqa: E402
from core.middleware import require_user  # noqa: E402
from routes import task_routes  # noqa: E402
from services import task_service as task_module  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402

app = FastAPI()
app.include_router(task_routes.router)
app.dependency_overrides[require_user] = lambda: "david"


async def started(count: int = 1) -> None:
    """Until the stand-in model has begun `count` runs."""
    for _ in range(500):
        if SlowBrain.started >= count:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the run never reached the model")


def ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


class SlowBrain:
    """A stand-in model: reports some usage, then waits for `gate` (when
    set) before replying. Counts its runs and how many overlap."""
    started = 0
    active = 0
    most_at_once = 0
    gate: "asyncio.Event | None" = None
    reply = "done"

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        cls = SlowBrain
        cls.started += 1
        cls.active += 1
        cls.most_at_once = max(cls.most_at_once, cls.active)
        try:
            yield runs.usage_event({"input_tokens": 100, "output_tokens": 20, "total_tokens": 120})
            if cls.gate is not None:
                await cls.gate.wait()
            else:
                await asyncio.sleep(0.01)
            yield runs.text(cls.reply)
            yield runs.result(True)
        finally:
            cls.active -= 1


class Base(unittest.TestCase):
    def setUp(self):
        SlowBrain.started = SlowBrain.active = SlowBrain.most_at_once = 0
        SlowBrain.gate = None
        SlowBrain.reply = "done"
        self.created = []
        self.sent = []
        self.send_ok = True

        async def send(channel, text):
            self.sent.append((channel, text))
            return self.send_ok if not callable(self.send_ok) else self.send_ok()

        for target, attribute, value in (
                (task_scheduler, "_task_brain", lambda task: SlowBrain()),
                (task_scheduler, "task_endpoint_id", lambda task: "ep-test"),
                ("core.channels.registry", "send_to_channel", send)):
            p = patch(f"{target}.{attribute}", value) if isinstance(target, str) else patch.object(target, attribute, value)
            p.start()
            self.addCleanup(p.stop)
        self.usage = []
        p = patch("core.token_usage.record_usage", side_effect=lambda ep, usage: self.usage.append((ep, usage)))
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self._clean)

    def _clean(self):
        for task_id in self.created:
            task_service.delete_task(task_id)
        with store.transaction() as conn:
            conn.execute("DELETE FROM deliveries")
        task_scheduler._lanes.update(schedule=None, card=None)

    def task(self, name, kind="interval", due_seconds_ago=1, **extra):
        fields = {"interval_seconds": 3600} if kind == "interval" else \
            {"run_at": ago(-3600)} if kind == "once" else {"run_time": "06:00"}
        task = task_service.create_task(name, f"do {name}", kind, **fields, **extra)
        self.created.append(task["id"])
        if due_seconds_ago is not None:
            task["next_run_at"] = ago(due_seconds_ago)
            task_service._save_tasks()
        return task

    def card(self, name, **extra):
        card = task_service.create_task(name, f"do {name}", "card", status="ready", **extra)
        self.created.append(card["id"])
        return card


class AtMostOnceTests(Base):
    def test_a_run_cut_off_by_a_crash_is_recorded_lost_and_not_run_again(self):
        task = self.task("brief", deliver_to_channel="discord")
        claimed = task_service.claim_occurrence(task["id"])  # the run starts, then JARVIS dies
        self.assertGreater(claimed["next_run_at"], ago(0), "the schedule moved on before any work")
        restarted = task_module.TaskService()  # the next start reads what was saved
        lost = restarted.recover_interrupted_runs()
        self.assertEqual([t["id"] for t in lost], [task["id"]])
        self.assertEqual(restarted.list_runs(task["id"])[0]["outcome"], "lost")
        self.assertEqual(restarted.due_tasks(), [], "the cut-off occurrence is not run again")
        self.assertEqual(restarted.recover_interrupted_runs(), [], "recorded once")
        with patch.object(task_scheduler, "task_service", restarted), patch.object(events, "emit") as emitted:
            task_scheduler._report_lost(lost[0])
        self.assertIn("cut off when Kairos closed", emitted.call_args.args[1])
        row = store.connection().execute("SELECT channel, text FROM deliveries").fetchone()
        self.assertEqual(row["channel"], "discord")
        self.assertIn("Run now", row["text"])

    def test_a_cut_off_run_from_before_claims_moves_its_schedule_on(self):
        task = self.task("old build run")
        stored = task_service.get_task(task["id"])
        stored["run_started_at"] = time.time() - 60  # stamped by a build without run_source
        task_service._save_tasks()
        restarted = task_module.TaskService()
        restarted.recover_interrupted_runs()
        self.assertEqual(restarted.due_tasks(), [], "it would otherwise run the same occurrence again")

    def test_a_duplicate_tick_runs_a_due_task_once(self):
        task = self.task("tick twice")

        async def go():
            await asyncio.gather(task_scheduler._run_due(), task_scheduler._run_due())

        asyncio.run(go())
        self.assertEqual(SlowBrain.started, 1)
        self.assertEqual(len(task_service.list_runs(task["id"])), 1)
        stored = task_service.get_task(task["id"])
        self.assertLess(stored["next_run_at"], ago(-3700), "moved on one interval, not two")


class OneRunAtATimeTests(Base):
    def test_a_second_run_now_is_refused_while_the_first_runs(self):
        task = self.task("busy", due_seconds_ago=None)

        async def go():
            SlowBrain.gate = asyncio.Event()
            first = asyncio.create_task(task_scheduler.start_run(task, "manual"))
            await started()
            second = await task_scheduler.start_run(task, "manual")
            SlowBrain.gate.set()
            return await first, second

        self.assertEqual(asyncio.run(go()), (True, False))
        self.assertEqual(SlowBrain.started, 1)

    def test_a_trigger_during_a_run_waits_then_runs_once(self):
        task = self.task("triggered", due_seconds_ago=None)

        async def go():
            SlowBrain.gate = asyncio.Event()
            first = asyncio.create_task(task_scheduler.start_run(task, "manual"))
            await started()
            second = asyncio.create_task(task_scheduler.start_run({**task, "prompt": "with the event"}, "trigger",
                                                                  wait=True))
            await asyncio.sleep(0.05)
            self.assertEqual(SlowBrain.started, 1, "the trigger's run waits its turn")
            SlowBrain.gate.set()
            await asyncio.gather(first, second)

        asyncio.run(go())
        self.assertEqual((SlowBrain.started, SlowBrain.most_at_once), (2, 1))
        self.assertEqual([r["source"] for r in task_service.list_runs(task["id"])], ["trigger", "manual"])

    def test_the_scheduler_skips_a_task_that_is_already_running(self):
        task = self.task("due while running")

        async def go():
            SlowBrain.gate = asyncio.Event()
            manual = asyncio.create_task(task_scheduler.start_run(task, "manual"))
            await started()
            await task_scheduler._run_due()
            SlowBrain.gate.set()
            await manual

        asyncio.run(go())
        self.assertEqual(SlowBrain.started, 1)
        self.assertGreater(task_service.get_task(task["id"])["next_run_at"], ago(0), "this occurrence is covered")
        history = task_service.list_runs(task["id"])
        self.assertEqual(len(history), 2)
        missed = next(r for r in history if r.get("missed_reason"))
        completed = next(r for r in history if not r.get("missed_reason"))
        self.assertIn("already running", missed["error"])
        self.assertEqual((completed["source"], completed["outcome"]), ("manual", "succeeded"))
        self.assertIsNotNone(completed["started_at"], "the skip did not consume the manual run's start")


class ScheduleTests(Base):
    def test_named_daily_times_keep_the_wall_clock_across_both_dst_boundaries(self):
        for zone_name, before, after in (
                ("America/New_York", "2026-03-07", "2026-03-08"),
                ("America/New_York", "2026-10-31", "2026-11-01"),
                ("Europe/Dublin", "2026-03-28", "2026-03-29"),
                ("Europe/Dublin", "2026-10-24", "2026-10-25")):
            with self.subTest(zone=zone_name, before=before):
                zone = ZoneInfo(zone_name)
                start = datetime.fromisoformat(before + "T05:00").replace(tzinfo=zone)
                with patch.object(task_module.time, "time", return_value=start.timestamp()):
                    task = self.task("zoned morning", kind="daily", due_seconds_ago=None, time_zone=zone_name)
                first = datetime.fromisoformat(task["next_run_at"])
                self.assertEqual(first.astimezone(zone).replace(tzinfo=None), datetime.fromisoformat(before + "T06:00"))
                with patch.object(task_module.time, "time", return_value=first.timestamp()):
                    self.assertTrue(task_service.is_due(task["id"]))
                    task_service.claim_occurrence(task["id"])
                    task_service.record_run(task["id"], "morning check")
                second = datetime.fromisoformat(task["next_run_at"])
                self.assertEqual(second.astimezone(zone).replace(tzinfo=None), datetime.fromisoformat(after + "T06:00"))
                self.assertIn((second - first).total_seconds(), (23 * 3600, 25 * 3600))
                with patch.object(task_module.time, "time", return_value=second.timestamp()):
                    self.assertIsNotNone(task_service.claim_occurrence(task["id"]))
                    task_service.record_run(task["id"], "check after the clock change")
                self.assertEqual(len(task_service.list_runs(task["id"])), 2)

    def test_task_routes_save_and_clear_optional_schedule_rules(self):
        with TestClient(app) as client:
            made = client.post("/api/tasks", json={
                "name": "Dublin mornings", "prompt": "check", "schedule_kind": "daily",
                "run_time": "06:00", "time_zone": "Europe/Dublin", "weekdays": [0, 1, 2, 3, 4],
            })
            self.assertEqual(made.status_code, 200)
            task = made.json()
            self.created.append(task["id"])
            self.assertEqual((task["time_zone"], task["weekdays"]), ("Europe/Dublin", [0, 1, 2, 3, 4]))
            changed = client.patch(f"/api/tasks/{task['id']}", json={"name": "Renamed"}).json()
            self.assertEqual(changed["next_run_at"], task["next_run_at"], "a name edit leaves the clock alone")
            cleared = client.patch(f"/api/tasks/{task['id']}", json={"time_zone": None, "weekdays": None})
            self.assertEqual(cleared.status_code, 200)
            self.assertNotIn("time_zone", cleared.json())
            self.assertNotIn("weekdays", cleared.json())

    def test_model_task_tools_create_update_and_clear_schedule_rules(self):
        from core import tool_registry
        from types import SimpleNamespace
        context = SimpleNamespace(agent_id=None)
        result = asyncio.run(tool_registry._create_task({
            "name": "Model's weekday check", "prompt": "check", "schedule_kind": "daily",
            "run_time": "06:00", "time_zone": "Europe/Dublin", "weekdays": [0, 1, 2, 3, 4],
        }, context))
        task_id = result.split()[2].rstrip(":")
        self.created.append(task_id)
        task = task_service.get_task(task_id)
        self.assertEqual(task["time_zone"], "Europe/Dublin")
        asyncio.run(tool_registry._update_task({"task_id": task_id, "time_zone": "America/New_York",
                                               "weekdays": [6]}, context))
        self.assertEqual((task["time_zone"], task["weekdays"]), ("America/New_York", [6]))
        asyncio.run(tool_registry._update_task({"task_id": task_id, "time_zone": None, "weekdays": None}, context))
        self.assertNotIn("time_zone", task)
        self.assertNotIn("weekdays", task)

    def test_a_spring_gap_shifts_forward_and_a_fall_fold_fires_only_once(self):
        cases = (
            ("America/New_York", "02:30", "2026-03-08T00:00:00+00:00", "2026-03-08T07:30:00+00:00"),
            ("America/New_York", "01:30", "2026-11-01T00:00:00+00:00", "2026-11-01T05:30:00+00:00"),
            ("Europe/Dublin", "01:30", "2026-03-29T00:00:00+00:00", "2026-03-29T01:30:00+00:00"),
            ("Europe/Dublin", "01:30", "2026-10-25T00:00:00+00:00", "2026-10-25T00:30:00+00:00"),
        )
        for zone, wall, now, expected in cases:
            with self.subTest(zone=zone, now=now):
                self.assertEqual(task_module._next_daily(wall, zone, now=datetime.fromisoformat(now)), expected)
        for zone, now in (("America/New_York", "2026-11-01T05:45:00+00:00"),
                          ("Europe/Dublin", "2026-10-25T00:45:00+00:00")):
            with self.subTest(zone=zone):
                # Between the two 01:30s: today's check already happened.
                next_time = task_module._next_daily("01:30", zone, now=datetime.fromisoformat(now))
                self.assertEqual(datetime.fromisoformat(next_time).astimezone(ZoneInfo(zone)).day,
                                 datetime.fromisoformat(now).day + 1)

    def test_weekdays_are_checked_in_the_schedule_zone_and_can_be_cleared(self):
        now = datetime.fromisoformat("2026-10-23T14:00:00+00:00")  # Friday after the check
        self.assertEqual(task_module._next_daily("06:00", "America/New_York", [0, 1, 2, 3, 4], now),
                         "2026-10-26T10:00:00+00:00")
        task = self.task("weekdays", kind="daily", due_seconds_ago=None, time_zone="America/New_York", weekdays=[4, 0, 0])
        self.assertEqual(task["weekdays"], [0, 4])
        with patch.object(task_module.time, "time", return_value=now.timestamp()):
            task_service.update_task(task["id"], weekdays=None)
        self.assertNotIn("weekdays", task)
        self.assertEqual(task["next_run_at"], "2026-10-24T10:00:00+00:00")

    def test_invalid_rules_are_rejected_without_changing_a_live_schedule(self):
        task = self.task("valid daily", kind="daily", due_seconds_ago=None)
        original = dict(task)
        for fields in ({"time_zone": "Mars/Olympus"}, {"time_zone": ""}, {"weekdays": []},
                       {"weekdays": [7]}, {"weekdays": [True]}, {"weekdays": "weekdays"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                task_service.update_task(task["id"], **fields)
            self.assertEqual(task, original)
        with self.assertRaises(ValueError):
            task_service.create_task("bad interval", "check", "interval", interval_seconds=-1)

    def test_intervals_stay_anchored_after_a_delayed_start_and_long_run(self):
        anchor = datetime.fromisoformat("2026-10-13T06:00:00+00:00")
        task = self.task("six hourly", due_seconds_ago=None)
        task.update(interval_seconds=6 * 3600, next_run_at=anchor.isoformat())
        with patch.object(task_module.time, "time", return_value=anchor.timestamp() + 20 * 60):
            task_service.claim_occurrence(task["id"])
        self.assertEqual(task["next_run_at"], "2026-10-13T12:00:00+00:00")
        with patch.object(task_module.time, "time", return_value=anchor.timestamp() + 2 * 3600):
            task_service.record_run(task["id"], "a long check finished")
        self.assertEqual(task["next_run_at"], "2026-10-13T12:00:00+00:00")

    def test_many_overdue_intervals_catch_up_once_inside_grace(self):
        anchor = datetime.fromisoformat("2026-10-13T00:00:00+00:00")
        task = self.task("hourly after downtime", due_seconds_ago=None)
        task["next_run_at"] = anchor.isoformat()
        with patch.object(task_module.time, "time", return_value=anchor.timestamp() + 10 * 3600 + 60):
            asyncio.run(task_scheduler._run_due())
            asyncio.run(task_scheduler._run_due())
        self.assertEqual(SlowBrain.started, 1)
        self.assertEqual(task["next_run_at"], "2026-10-13T11:00:00+00:00")
        history = task_service.list_runs(task["id"])
        self.assertEqual(sum(r["outcome"] == "succeeded" for r in history), 1)
        # One receipt per gap, not per slot: ten skipped occurrences fold into
        # a single record that still names all ten, so a long outage cannot
        # push the runs that did happen out of a capped history.
        receipts = [r for r in history if r.get("missed_reason")]
        self.assertEqual(len(receipts), 1)
        self.assertEqual(receipts[0]["missed_occurrences"], 10)
        self.assertEqual(len(receipts[0]["missed_at"]), 10)
        self.assertEqual(next(r for r in history if r["outcome"] == "succeeded")["scheduled_for"], anchor.isoformat())

    def test_weekend_downtime_leaves_receipts_then_one_future_run(self):
        task = self.task("closed weekend", due_seconds_ago=None)
        anchor = datetime.fromisoformat("2026-10-09T06:00:00+00:00")
        task["next_run_at"] = anchor.isoformat()
        task_service._save_tasks()
        restarted = task_module.TaskService()
        monday = datetime.fromisoformat("2026-10-12T06:20:00+00:00")
        with patch.object(task_scheduler, "task_service", restarted), \
                patch.object(task_module.time, "time", return_value=monday.timestamp()):
            asyncio.run(task_scheduler._run_due())
            asyncio.run(task_scheduler._run_due())
        history = restarted.list_runs(task["id"])
        self.assertEqual(len(history), 1, "a weekend of skipped slots is one receipt, not a full history")
        self.assertEqual(SlowBrain.started, 0)
        self.assertEqual(history[0]["outcome"], "lost")
        self.assertIn("app was not running", history[0]["missed_reason"])
        self.assertIsNone(history[0]["started_at"])
        self.assertEqual(history[0]["scheduled_for"], "2026-10-12T06:00:00+00:00")
        self.assertEqual(max(history[0]["missed_at"]), "2026-10-12T06:00:00+00:00")
        future = restarted.get_task(task["id"])["next_run_at"]
        self.assertEqual(future, "2026-10-12T07:00:00+00:00")
        with patch.object(task_scheduler, "task_service", restarted), \
                patch.object(task_module.time, "time", return_value=datetime.fromisoformat(future).timestamp()):
            asyncio.run(task_scheduler._run_due())
            asyncio.run(task_scheduler._run_due())
        self.assertEqual(SlowBrain.started, 1)
        history = restarted.list_runs(task["id"])
        # The one receipt for the outage, plus the run that followed it. The
        # point of folding them is that this run is still here to see.
        self.assertEqual(len(history), 2)
        self.assertEqual(sum(r["outcome"] == "succeeded" for r in history), 1)

    def test_grace_boundary_runs_but_anything_past_it_is_missed(self):
        now = datetime.fromisoformat("2026-10-13T18:00:00+00:00").timestamp()
        for behind, should_run in ((task_module.MISSED_GRACE_SECONDS, True),
                                   (task_module.MISSED_GRACE_SECONDS + 1, False)):
            with self.subTest(behind=behind):
                task = self.task("grace boundary", kind="once", due_seconds_ago=None)
                task["next_run_at"] = datetime.fromtimestamp(now - behind, timezone.utc).isoformat()
                with patch.object(task_module.time, "time", return_value=now):
                    claimed = task_service.claim_occurrence(task["id"])
                    if claimed:
                        task_service.record_run(task["id"], "ran")
                self.assertEqual(claimed is not None, should_run)
                self.assertFalse(task["enabled"])
                self.assertIsNone(task["next_run_at"])
                self.assertEqual(task_service.list_runs(task["id"])[0]["outcome"], "succeeded" if should_run else "lost")

    def test_daily_downtime_receipts_follow_weekday_rules(self):
        now = datetime.fromisoformat("2026-10-12T06:20:00+00:00").timestamp()
        for days, expected_dates in ((None, ["09", "10", "11", "12"]),
                                     ([0, 1, 2, 3, 4], ["09", "12"])):
            with self.subTest(weekdays=days):
                task = self.task("daily downtime", kind="daily", due_seconds_ago=None, time_zone="UTC", weekdays=days)
                task["next_run_at"] = "2026-10-09T06:00:00+00:00"
                with patch.object(task_module.time, "time", return_value=now):
                    self.assertIsNone(task_service.claim_occurrence(task["id"]))
                # The skipped days fold into one receipt but are all named on
                # it, so a weekday rule is still verifiable after an outage.
                receipts = [r for r in task_service.list_runs(task["id"]) if r.get("missed_reason")]
                self.assertEqual(len(receipts), 1)
                self.assertEqual(sorted(receipts[0]["missed_at"]),
                                 [f"2026-10-{day}T06:00:00+00:00" for day in expected_dates])
                self.assertEqual(task["next_run_at"], "2026-10-13T06:00:00+00:00")
                self.assertEqual(SlowBrain.started, 0)

    def test_legacy_daily_schedule_loads_without_a_rewrite_and_runs_as_before(self):
        now_local = datetime.now().astimezone().replace(hour=4, minute=0, second=0, microsecond=0)
        with patch.object(task_module.time, "time", return_value=now_local.timestamp()):
            task = self.task("legacy daily", kind="daily", due_seconds_ago=None)
        self.assertNotIn("time_zone", task)
        self.assertNotIn("weekdays", task)
        self.assertEqual(datetime.fromisoformat(task["next_run_at"]).astimezone().hour, 6)
        stored = Path(task_module.TASKS_FILE).read_bytes()
        restarted = task_module.TaskService()
        self.assertEqual(Path(task_module.TASKS_FILE).read_bytes(), stored)
        self.assertEqual(restarted.get_task(task["id"]), task)
        due = datetime.fromisoformat(task["next_run_at"]).timestamp()
        with patch.object(task_module.time, "time", return_value=due):
            self.assertIsNotNone(restarted.claim_occurrence(task["id"]))
            restarted.record_run(task["id"], "as before")
        self.assertEqual(restarted.list_runs(task["id"])[0]["outcome"], "succeeded")
        next_local = datetime.fromisoformat(restarted.get_task(task["id"])["next_run_at"]).astimezone()
        self.assertEqual((next_local.date(), next_local.hour), (now_local.date() + timedelta(days=1), 6))

    def test_run_now_leaves_the_schedule_alone(self):
        once = self.task("one-shot", kind="once", due_seconds_ago=None)
        interval = self.task("hourly", due_seconds_ago=-1800)
        before = {t["id"]: (t["enabled"], t["next_run_at"]) for t in (once, interval)}
        for task in (once, interval):
            asyncio.run(task_scheduler.start_run(task, "manual"))
        after = {t: (task_service.get_task(t)["enabled"], task_service.get_task(t)["next_run_at"]) for t in before}
        self.assertEqual(after, before, "a one-shot still runs at its time; an interval keeps its clock")

    def test_a_late_scheduled_run_says_so(self):
        late = self.task("missed while off", due_seconds_ago=3 * 3600)
        on_time = self.task("on time", due_seconds_ago=5)
        asyncio.run(task_scheduler._run_due())
        late_run = task_service.list_runs(late["id"])[0]
        self.assertAlmostEqual(late_run["late_seconds"], 3 * 3600, delta=30)
        self.assertEqual(late_run["source"], "schedule")
        self.assertIsNone(task_service.list_runs(on_time["id"])[0]["late_seconds"])
        self.assertEqual(SlowBrain.started, 2, "each missed task catches up once")


class LaneTests(Base):
    def test_a_long_card_does_not_hold_up_a_due_task(self):
        card = self.card("long card")
        task = self.task("six o'clock brief")

        async def go():
            gates = {}

            def brain_for(t):
                brain = SlowBrain()
                if t["id"] == card["id"]:
                    gates["card"] = asyncio.Event()

                    async def events(prompt, stream=True):
                        yield runs.usage_event({"input_tokens": 1, "output_tokens": 1})
                        await gates["card"].wait()
                        yield runs.text("card result")
                        yield runs.result(True)
                    brain.events = events
                return brain

            with patch.object(task_scheduler, "_task_brain", brain_for):
                await task_scheduler._tick()
                for _ in range(100):
                    if task_service.list_runs(task["id"]):
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(task_service.list_runs(task["id"]), "the brief ran while the card was still running")
                self.assertEqual(task_service.get_task(card["id"])["status"], "running")
                gates["card"].set()
                await task_scheduler._lanes["card"]

        asyncio.run(go())
        self.assertEqual(task_service.get_task(card["id"])["status"], "review")

    def test_a_card_past_its_lease_is_not_taken_as_lost_while_it_still_runs(self):
        card = self.card("very long card")

        async def go():
            SlowBrain.gate = asyncio.Event()
            claimed = task_service.claim_next_card()
            run = asyncio.create_task(task_scheduler.start_run(claimed, "schedule"))
            await started()
            task_service.get_task(card["id"])["claimed_until"] = time.time() - 1  # 30 minutes have passed
            await task_scheduler.dispatch_cards()
            self.assertEqual(task_service.get_task(card["id"])["status"], "running")
            SlowBrain.gate.set()
            await run

        asyncio.run(go())
        self.assertEqual(SlowBrain.started, 1, "never started a second time beside itself")
        stored = task_service.get_task(card["id"])
        self.assertEqual((stored["status"], stored["attempts"]), ("review", 1))
        self.assertEqual([r["outcome"] for r in task_service.list_runs(card["id"])], ["succeeded"],
                         "no false 'lost' run in its history")


class StopTests(Base):
    def test_stopping_a_card_blocks_it_and_counts_what_it_used(self):
        card = self.card("stop me")

        async def go():
            SlowBrain.gate = asyncio.Event()
            claimed = task_service.claim_next_card()
            run = asyncio.create_task(task_scheduler.start_run(claimed, "schedule"))
            await started()
            await asyncio.sleep(0.02)  # past the usage report
            self.assertTrue(task_scheduler.stop_run(card["id"]))
            await run

        asyncio.run(go())
        stored = task_service.get_task(card["id"])
        self.assertEqual((stored["status"], stored["comments"][-1]["text"]), ("blocked", task_module.STOPPED_NOTE))
        self.assertEqual(task_service.list_runs(card["id"])[0]["outcome"], "stopped")
        self.assertEqual([u.total_tokens for _, u in self.usage], [120], "the stopped run's usage is counted")
        self.assertIsNone(task_service.claim_next_card(), "a stopped card is not retried by itself")

    def test_stopping_a_scheduled_task_records_it_and_clears_the_running_mark(self):
        task = self.task("stop the brief", due_seconds_ago=None)

        async def go():
            SlowBrain.gate = asyncio.Event()
            run = asyncio.create_task(task_scheduler.start_run(task, "manual"))
            await started()
            self.assertTrue(task_service.get_task(task["id"]).get("run_started_at"))
            task_scheduler.stop_run(task["id"])
            await run

        asyncio.run(go())
        self.assertEqual(task_service.list_runs(task["id"])[0]["outcome"], "stopped")
        self.assertNotIn("run_started_at", task_service.get_task(task["id"]))

    def test_the_stop_and_retry_routes(self):
        web = TestClient(app)
        task = self.task("idle", due_seconds_ago=None)
        self.assertEqual(web.post(f"/api/tasks/{task['id']}/stop").status_code, 409, "not running")
        self.assertEqual(web.post("/api/tasks/nope/stop").status_code, 404)
        delivered = outbox.enqueue("route:1", "discord", "hi")
        asyncio.run(outbox.send_due())
        self.assertEqual(web.post(f"/api/tasks/deliveries/{delivered}/retry").status_code, 409, "it landed")
        self.assertEqual(web.post("/api/tasks/deliveries/nope/retry").status_code, 404)


class OutboxTests(Base):
    def row(self, delivery_id):
        return outbox.get(delivery_id)

    def test_a_failed_send_is_retried_then_lands(self):
        answers = iter([False, False, True])
        self.send_ok = lambda: next(answers)
        delivery = outbox.enqueue("t:1", "discord", "hello")
        now = time.time()
        asyncio.run(outbox.send_due(now))
        self.assertEqual((self.row(delivery)["status"], self.row(delivery)["attempts"]), ("pending", 1))
        asyncio.run(outbox.send_due(now + 30))
        self.assertEqual(self.row(delivery)["attempts"], 1, "not before its retry time (1 minute)")
        asyncio.run(outbox.send_due(now + 90))  # retry times run from when a send finished
        asyncio.run(outbox.send_due(now + 90 + 5 * 60 + 30))
        landed = self.row(delivery)
        self.assertEqual((landed["status"], landed["attempts"], landed["text"]), ("delivered", 3, ""))
        self.assertEqual(len(self.sent), 3)

    def test_a_send_that_keeps_failing_is_given_up_after_a_day_and_said(self):
        self.send_ok = False
        delivery = outbox.enqueue("t:2", "discord", "hello", label="Brief")
        with store.transaction() as conn:
            conn.execute("UPDATE deliveries SET created_at = created_at - ? WHERE id = ?",
                         (outbox.GIVE_UP_SECONDS, delivery))
        with patch.object(events, "emit") as emitted:
            asyncio.run(outbox.send_due())
        self.assertEqual(self.row(delivery)["status"], "failed")
        self.assertEqual(emitted.call_args.args[0], "delivery.failed")
        self.assertIn("Brief", emitted.call_args.args[1])
        self.send_ok = True
        outbox.retry(delivery)
        asyncio.run(outbox.send_due())
        self.assertEqual(self.row(delivery)["status"], "delivered", "a person can send it again")

    def test_a_message_cut_off_mid_send_is_unknown_and_never_resent(self):
        delivery = outbox.enqueue("t:3", "discord", "hello")
        with store.transaction() as conn:
            conn.execute("UPDATE deliveries SET status = 'sending' WHERE id = ?", (delivery,))
        self.assertEqual(outbox.recover(), 1)
        asyncio.run(outbox.send_due(time.time() + 10 * 86400))
        self.assertEqual((self.row(delivery)["status"], self.sent), ("unknown", []))

    def test_the_same_message_queued_twice_is_sent_once(self):
        first = outbox.enqueue("t:4", "discord", "hello")
        self.assertEqual(outbox.enqueue("t:4", "discord", "hello"), first)
        asyncio.run(outbox.send_due())
        self.assertEqual(len(self.sent), 1)

    def test_only_the_newest_finished_messages_are_kept(self):
        with patch.object(outbox, "KEEP_FINISHED", 2):
            ids = [outbox.enqueue(f"t:keep{i}", "discord", "x") for i in range(4)]
            for _ in ids:
                asyncio.run(outbox.send_due())
                time.sleep(0.01)
        kept = [d for d in ids if self.row(d)]
        self.assertEqual(len(kept), 2)

    def test_a_task_run_carries_its_delivery(self):
        task = self.task("delivered brief", due_seconds_ago=None, deliver_to_channel="discord")
        asyncio.run(task_scheduler.start_run(task, "manual"))
        asyncio.run(outbox.send_due())
        run = task_service.list_runs(task["id"])[0]
        self.assertEqual((run["delivery"]["status"], run["delivered"]), ("delivered", True))
        self.assertEqual(self.sent, [("discord", "**delivered brief**\ndone")])

    def test_agent_and_trigger_messages_go_through_the_outbox(self):
        agent = agent_service.create("Courier", deliver_to_channel="discord")
        self.addCleanup(agent_service.delete, agent["id"])
        item = agent_service.add_item(agent["id"], "report", "All quiet", "nothing new")
        agent_service.notify(item)
        from services.trigger_service import trigger_service
        trigger_service.notify({"id": "tr1", "name": "Stripe", "action": "card", "agent_id": None,
                                "deliver_to_channel": "discord", "prompt": "p"},
                               {"id": "pend1", "event_type": "charge", "summary": "a charge"})
        texts = [r["text"] for r in store.connection().execute("SELECT text FROM deliveries ORDER BY created_at")]
        self.assertEqual(len(texts), 2)
        self.assertIn("Courier", texts[0])
        self.assertIn("Stripe", texts[1])


class StoreTests(unittest.TestCase):
    def test_a_v4_store_is_copied_then_upgraded_with_the_outbox(self):
        folder = tempfile.mkdtemp(dir=_DATA.name)
        path = os.path.join(folder, "sessions.db")
        old = sqlite3.connect(path)
        old.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        old.execute("INSERT INTO meta VALUES ('schema_version', '4')")
        old.commit()
        old.close()
        store.close()
        try:
            with patch.object(store, "DB_FILE", path):
                conn = store.connection()
                self.assertTrue(conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'deliveries'").fetchone())
                self.assertEqual(conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0],
                                 str(store.SCHEMA_VERSION))
                self.assertTrue(os.path.exists(path + ".pre-v4"))
                store.close()
        finally:
            store.close()


def tearDownModule():
    store.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
