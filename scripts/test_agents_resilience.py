"""A07 gaps: no token-burning idle loop, and restart reconciliation never
duplicates an assignment (core/task_scheduler.py, core/swarm/store.py and
runtime.py). Models are stand-ins; nothing is spent.

Run: .venv/Scripts/python.exe -B -X utf8 scripts/test_agents_resilience.py
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import test_durable_work as durable  # noqa: E402  (sets the throwaway data folder)
import test_swarm as swarm  # noqa: E402
from core import task_scheduler  # noqa: E402
from core.swarm.models import Conflict  # noqa: E402
from core.swarm.runtime import SwarmRuntime  # noqa: E402
from services.task_service import task_service  # noqa: E402


class IdleSchedulerTests(durable.Base):
    """A scheduler with nothing due must not construct a model, send a prompt or spend a token."""

    def setUp(self):
        super().setUp()
        p = patch.object(task_scheduler, "_check_mcp_servers", lambda loop: None)
        p.start()
        self.addCleanup(p.stop)
        self.brains = 0
        real = task_scheduler._task_brain

        def counting(task):
            self.brains += 1
            return real(task)

        p = patch.object(task_scheduler, "_task_brain", counting)
        p.start()
        self.addCleanup(p.stop)

    async def settle(self, ticks=1):
        for _ in range(ticks):
            await task_scheduler._tick()
            for lane in task_scheduler._lanes.values():
                if lane is not None:
                    await lane

    def test_an_empty_scheduler_idles_without_a_model_call(self):
        asyncio.run(self.settle(25))
        self.assertEqual((self.brains, durable.SlowBrain.started, self.usage), (0, 0, []))

    def test_future_paused_and_waiting_work_costs_nothing_across_many_ticks(self):
        future = self.task("later", due_seconds_ago=None)           # next run an hour away
        paused = self.task("paused", due_seconds_ago=1)             # overdue, but switched off
        task_service.update_task(paused["id"], enabled=False)
        waiting = self.card("not ready")
        task_service.update_task(waiting["id"])                      # a card that is not ready
        task_service._tasks[waiting["id"]]["status"] = "backlog"
        asyncio.run(self.settle(25))
        self.assertEqual((self.brains, durable.SlowBrain.started, self.usage), (0, 0, []))
        for item in (future, paused, waiting):
            self.assertEqual(task_service.list_runs(item["id"]), [])

    def test_the_poll_interval_is_a_real_sleep_not_a_spin(self):
        self.assertGreaterEqual(task_scheduler.POLL_INTERVAL_SECONDS, 5)
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)
            if len(sleeps) >= 3:
                raise asyncio.CancelledError

        async def go():
            with patch.object(task_scheduler.asyncio, "sleep", fake_sleep):
                try:
                    await task_scheduler._poll_loop()
                except asyncio.CancelledError:
                    pass

        asyncio.run(go())
        self.assertEqual(sleeps, [task_scheduler.POLL_INTERVAL_SECONDS] * 3)
        self.assertEqual((self.brains, self.usage), (0, []))

    def test_pausing_stops_the_next_wakeup_and_resuming_never_floods(self):
        task = self.task("pausable", due_seconds_ago=1)
        task_service.update_task(task["id"], enabled=False)
        asyncio.run(self.settle(3))
        self.assertEqual(durable.SlowBrain.started, 0, "a paused routine must not wake")
        task_service.update_task(task["id"], enabled=True)
        asyncio.run(self.settle(3))
        self.assertEqual(durable.SlowBrain.started, 0, "resuming moves the schedule on; it does not run missed occurrences")
        self.assertGreater(task_service.get_task(task["id"])["next_run_at"], durable.ago(-3000))

    def test_one_due_task_runs_once_then_goes_quiet(self):
        task = self.task("once only", due_seconds_ago=1)
        asyncio.run(self.settle(10))
        self.assertEqual(durable.SlowBrain.started, 1)
        self.assertEqual(len(self.usage), 1)
        self.assertEqual(len(task_service.list_runs(task["id"])), 1)


class RestartReconciliationTests(swarm.Fixture, unittest.TestCase):
    def setUp(self):
        self.setup_store()
        self.own()

    def tearDown(self):
        self.teardown_store()

    def restart(self, name):
        """A crash: the old process's lease runs out and a new runtime takes over."""
        self.clock.now += 31
        self.generation = self.store.acquire_runtime(name)
        if self.store.get_system(self.system)["state"] == "pausing":
            self.store.finalize_pause(self.system)  # what the runtime's first poll does

    def attempts(self, task=None):
        return self.store.db.execute("SELECT COUNT(*) FROM attempts WHERE task_id=?", (task or self.task,)).fetchone()[0]

    def test_a_started_assignment_is_not_reissued_by_restart_and_resumes_as_exactly_one_new_attempt(self):
        first = self.claim()
        self.begin(first)
        self.restart("runtime-2")
        self.assertEqual(self.store.get_attempt(first)["state"], "unknown")
        self.assertEqual(self.store.get_task(self.task)["state"], "blocked")
        self.assertEqual(self.store.get_system(self.system)["state"], "paused")
        # Nothing may start the task again, however often it is asked.
        for _ in range(3):
            self.assertIsNone(self.store.reserve(self.task, "runtime-2", self.generation, 10))
        with self.assertRaises(Conflict):
            self.store.resume(self.system)
        self.assertEqual(self.attempts(), 1)
        # Evidence-backed reconciliation releases it; resume then allows exactly one retry.
        self.store.reconcile(first, evidence="checked the workspace", stopped=True, retry_checkpoint={"note": "safe"})
        self.store.resume(self.system)
        retry = self.store.reserve(self.task, "runtime-2", self.generation, 10)
        self.assertIsNotNone(retry)
        self.assertNotEqual(retry, first)
        self.assertIsNone(self.store.reserve(self.task, "runtime-2", self.generation, 10), "a second claim of the same task")
        self.assertEqual(self.attempts(), 2)
        self.assertEqual(self.store.db.execute(
            "SELECT COUNT(*) FROM attempts WHERE task_id=? AND state IN ('reserved','started')", (self.task,)).fetchone()[0], 1)

    def test_a_reserved_but_never_started_assignment_returns_to_ready_once(self):
        first = self.claim()
        self.restart("runtime-2")
        self.assertEqual(self.store.get_attempt(first)["state"], "cancelled")
        self.assertEqual(self.store.get_task(self.task)["state"], "ready")
        self.assertEqual(self.store.get_system(self.system)["state"], "paused")
        self.assertIsNone(self.store.reserve(self.task, "runtime-2", self.generation, 10), "a paused company dispatches nothing")
        self.store.resume(self.system)
        self.assertIsNotNone(self.store.reserve(self.task, "runtime-2", self.generation, 10))
        self.assertIsNone(self.store.reserve(self.task, "runtime-2", self.generation, 10))
        self.assertEqual(self.attempts(), 2)

    def test_repeated_restarts_recover_each_attempt_once_and_add_no_work(self):
        first = self.claim()
        self.begin(first)
        for index in range(3):
            self.restart(f"runtime-{index + 2}")
        events = self.store.db.execute("SELECT COUNT(*) FROM events WHERE kind='attempt.recovered' AND entity_id=?", (first,)).fetchone()
        self.assertEqual(events[0], 1)
        self.assertEqual(self.attempts(), 1)
        self.assertEqual(self.store.get_attempt(first)["state"], "unknown")

    def test_a_live_runtime_blocks_a_second_one_from_claiming_the_same_database(self):
        with self.assertRaises(Conflict):
            self.store.acquire_runtime("intruder")
        attempt = self.claim()
        self.assertEqual(self.store.get_attempt(attempt)["state"], "reserved", "the refused takeover recovered nothing")


class RuntimeRestartTests(swarm.Fixture, unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.setup_store()

    async def asyncTearDown(self):
        self.teardown_store()

    async def test_an_idle_runtime_polls_without_dispatching_or_recording_usage(self):
        worker = swarm.FakeWorker()
        runtime = SwarmRuntime(self.store, self.root / "handoffs", poll_interval=0.005)
        await runtime.start()
        before = self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        await asyncio.sleep(0.3)  # dozens of monitor ticks
        await runtime.close()
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM attempts").fetchone()[0], 0)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM usage").fetchone()[0], 0)
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM events").fetchone()[0], before, "idling writes no work events")
        self.assertIsNone(worker.assignment)

    async def test_a_restarted_runtime_will_not_run_an_interrupted_task_until_reconciled_then_runs_it_once(self):
        runtime = SwarmRuntime(self.store, self.root / "handoffs", poll_interval=0.01)
        await runtime.start()
        attempt = self.store.reserve(self.task, runtime.runtime_id, runtime.generation, 10)
        self.store.begin(attempt, runtime.runtime_id, runtime.generation)
        runtime._closing = True  # a crash: the monitor stops, the lease is never released
        runtime._monitor_task.cancel()
        self.clock.now += 31
        second = SwarmRuntime(self.store, self.root / "handoffs", poll_interval=0.01)
        await second.start()
        worker = swarm.FakeWorker()
        self.assertIsNone(await second.run_task(self.task, worker, max_units=10))
        self.assertIsNone(worker.assignment, "the interrupted task was handed to a worker again")
        self.store.reconcile(attempt, evidence="inspected", stopped=True, retry_checkpoint={"note": "safe"})
        self.store.resume(self.system)
        finished = swarm.FakeWorker([swarm.WorkerEvent(swarm.EventKind.RESULT, "result", {"result": {"artifact": "x"}, "usage_complete": True})])
        retry = await second.run_task(self.task, finished, max_units=10)
        self.assertIsNotNone(retry)
        self.assertNotEqual(retry, attempt)
        self.assertIsNotNone(finished.assignment)
        self.assertIsNone(await second.run_task(self.task, swarm.FakeWorker(), max_units=10), "a finished task is not run again")
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM attempts WHERE task_id=?", (self.task,)).fetchone()[0], 2)
        await second.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
