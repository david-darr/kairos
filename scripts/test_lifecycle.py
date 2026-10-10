"""Reversible user tabs and automation schedules, with isolated fixture data."""
import asyncio
from copy import deepcopy
import importlib
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_tabs as fixtures
from services import task_service as tasks
from routes import task_routes
from core import task_scheduler


class UserTabLifecycleTests(unittest.TestCase):
    setUp = fixtures.TabTests.setUp
    clear_modules = fixtures.TabTests.clear_modules
    folder = fixtures.TabTests.folder
    legacy = fixtures.TabTests.legacy
    approve = fixtures.TabTests.approve
    status = fixtures.TabTests.status
    hook_folder = fixtures.TabTests.hook_folder

    def test_off_stops_hooks_and_on_restores_the_same_module_and_saved_data(self):
        self.hook_folder(source='''from . import service
events = []
async def start():
    events.append("start")
    service.answer += 1
async def stop(): events.append("stop")
def calendar_items(user, start, end):
    return [{"id": "fixture", "source": "tab", "source_label": "Fixture", "toggle_url": "/api/fixture/completed"}]
''')
        fixtures.tabs.mount_all(self.app)
        asyncio.run(fixtures.tab_hooks.reconcile())
        module = importlib.import_module("kairos_tabs.alpha.hooks")
        data = self.root / "data" / "tab-data" / "alpha" / "saved.json"
        data.parent.mkdir(parents=True)
        data.write_text('{"answer": 42}', encoding="utf-8")
        self.assertEqual(module.events, ["start"])
        self.assertEqual(self.client.get("/fixture/alpha").json(), {"answer": 43})
        self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": False}).raise_for_status()
        self.assertEqual(module.events, ["start", "stop"])
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("kairos_tabs.alpha.hooks")
        self.assertEqual(asyncio.run(fixtures.tab_hooks.calendar_items("fixture", "first", "last")), [])
        self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": True}).raise_for_status()
        self.assertIs(importlib.import_module("kairos_tabs.alpha.hooks"), module)
        self.assertEqual(module.events, ["start", "stop", "start"])
        self.assertEqual(self.client.get("/fixture/alpha").json(), {"answer": 44})
        self.assertEqual(len(asyncio.run(fixtures.tab_hooks.calendar_items("fixture", "first", "last"))), 1)
        self.assertEqual(data.read_text(encoding="utf-8"), '{"answer": 42}')

    def test_changed_approved_source_never_restores_suspended_modules(self):
        folder = self.folder()
        self.approve("alpha"); fixtures.tabs.mount_all(self.app)
        old = importlib.import_module("kairos_tabs.alpha.service")
        self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": False}).raise_for_status()
        (folder / "service.py").write_text("answer = 99\n", encoding="utf-8")
        self.approve("alpha")
        on = self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": True})
        self.assertEqual(on.status_code, 200)
        self.assertTrue(on.json()["restart_required"])
        self.assertIsNot(importlib.import_module("kairos_tabs.alpha.service"), old)
        self.assertEqual(self.client.get("/fixture/alpha").status_code, 409)

    def test_off_on_both_formats_preserves_approval_source_and_loaded_route(self):
        self.folder(); self.legacy()
        for slug, url, view in (("alpha", "/fixture/alpha", "/tab-files/alpha/view.js"), ("jobs", "/legacy/jobs", "/custom-views/jobs.js")):
            with self.subTest(slug=slug):
                self.approve(slug); fixtures.tabs.mount_all(self.app)
                before = self.status(slug)["fingerprint"]
                mounted = self.app.state.custom_tab_modules[slug]
                self.assertEqual(self.client.get(url).status_code, 200)
                off = self.client.post(f"/api/system/custom-tabs/{slug}/enabled", json={"enabled": False})
                self.assertEqual(off.status_code, 200, off.text)
                self.assertEqual(self.status(slug)["status"], "off")
                self.assertTrue(self.status(slug)["approved"])
                self.assertEqual(self.client.get(url).status_code, 409)
                self.assertEqual(self.client.get(view).status_code, 404)
                self.assertNotIn(slug, [m["id"] for m in fixtures.tabs.list_manifests()])
                on = self.client.post(f"/api/system/custom-tabs/{slug}/enabled", json={"enabled": True})
                self.assertEqual(on.status_code, 200, on.text)
                self.assertFalse(on.json()["restart_required"])
                self.assertEqual(self.status(slug)["fingerprint"], before)
                self.assertIs(self.app.state.custom_tab_modules[slug], mounted)
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_enabling_never_approves_changed_or_unapproved_source(self):
        folder = self.folder()
        self.approve("alpha"); fixtures.tabs.mount_all(self.app)
        self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": False}).raise_for_status()
        (folder / "service.py").write_text("answer = 99\n", encoding="utf-8")
        self.client.post("/api/system/custom-tabs/alpha/enabled", json={"enabled": True}).raise_for_status()
        self.assertEqual(self.status("alpha")["status"], "needs_approval")
        self.assertEqual(self.client.get("/fixture/alpha").status_code, 409)
        self.folder("beta")
        self.client.post("/api/system/custom-tabs/beta/enabled", json={"enabled": False}).raise_for_status()
        self.client.post("/api/system/custom-tabs/beta/enabled", json={"enabled": True}).raise_for_status()
        self.assertEqual(self.status("beta")["status"], "needs_approval")
        self.assertEqual(self.client.post("/api/system/custom-tabs/missing/enabled", json={"enabled": False}).status_code, 404)


class AutomationLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = fixtures.TemporaryDirectory(dir=fixtures._DATA.name)
        self.addCleanup(self.tmp.cleanup)
        for name, value in (("TASKS_FILE", str(Path(self.tmp.name) / "tasks.json")), ("TASK_RUNS_FILE", str(Path(self.tmp.name) / "runs.json"))):
            p = patch.object(tasks, name, value); p.start(); self.addCleanup(p.stop)
        self.service = tasks.TaskService()

    def test_interval_pause_resume_preserves_history_settings_and_active_run(self):
        task = self.service.create_task("Fixture", "Run", "interval", interval_seconds=60, deliver_to_channel="discord", endpoint_id="fixture")
        self.service._runs = [{"id": "run", "task_id": task["id"], "ran_at": 1, "output": "done", "error": None}]
        task["next_run_at"] = "2000-01-01T00:00:00+00:00"
        self.service.mark_started(task["id"])
        started = task["run_started_at"]
        self.service.update_task(task["id"], enabled=False)
        self.assertFalse(self.service.is_due(task["id"]))
        self.assertEqual(self.service.due_tasks(), [])
        self.assertEqual(task["run_started_at"], started)
        self.service.update_task(task["id"], enabled=True)
        self.assertGreater(datetime.fromisoformat(task["next_run_at"]), datetime.now(timezone.utc))
        self.assertEqual((task["deliver_to_channel"], task["endpoint_id"], self.service._runs[0]["id"]), ("discord", "fixture", "run"))

    def test_daily_resume_uses_future_slot_and_expired_once_cannot_enable(self):
        task = self.service.create_task("Daily", "Run", "daily", run_time="06:00")
        self.service.update_task(task["id"], enabled=False)
        task["next_run_at"] = "2000-01-01T06:00:00+00:00"
        self.service.update_task(task["id"], enabled=True)
        self.assertGreater(datetime.fromisoformat(task["next_run_at"]), datetime.now(timezone.utc))
        once = self.service.create_task("Once", "Run", "once", run_at="2000-01-01T00:00:00+00:00")
        self.service.update_task(once["id"], enabled=False)
        with self.assertRaises(ValueError):
            self.service.update_task(once["id"], enabled=True)
        self.assertFalse(once["enabled"])

    def test_builtin_disable_and_enable_reuses_same_task_and_history(self):
        task = self.service.create_task("Tidy", "Run", "interval", interval_seconds=60, builtin_action="tidy_chats", deliver_to_channel="discord")
        self.service._runs = [{"id": "history", "task_id": task["id"]}]
        self.service.update_task(task["id"], enabled=False)
        with patch.object(task_routes, "task_service", self.service):
            library = asyncio.run(task_routes.get_builtin_tasks("fixture"))
            builtin = next(b for b in library if b["action_id"] == "tidy_chats")
            self.assertFalse(builtin["enabled"])
            self.assertEqual(builtin["task_id"], task["id"])
            resumed = asyncio.run(task_routes.enable_builtin_task("tidy_chats", None, "fixture"))
        self.assertEqual(resumed["id"], task["id"])
        self.assertTrue(resumed["enabled"])
        self.assertEqual(resumed["deliver_to_channel"], "discord")
        self.assertEqual(self.service._runs[0]["id"], "history")

    def test_paused_task_and_history_survive_restart(self):
        task = self.service.create_task("Fixture", "Run", "interval", interval_seconds=60)
        self.service.record_run(task["id"], "Kept result")
        self.service.update_task(task["id"], enabled=False)
        stored = deepcopy(task)
        reloaded = tasks.TaskService()
        self.assertEqual(reloaded.get_task(task["id"]), stored)
        self.assertEqual(reloaded.list_runs(task["id"])[0]["output"], "Kept result")
        reloaded.update_task(task["id"], enabled=True)
        self.assertEqual(reloaded.list_runs(task["id"])[0]["output"], "Kept result")


class QueuedAutomationTests(unittest.IsolatedAsyncioTestCase):
    setUp = AutomationLifecycleTests.setUp

    def due(self, name):
        task = self.service.create_task(name, "Run", "interval", interval_seconds=60)
        task["next_run_at"] = "2000-01-01T00:00:00+00:00"
        return task

    async def test_off_task_in_the_schedulers_existing_due_snapshot_never_runs(self):
        first, queued = self.due("First"), self.due("Queued")
        async def run(task, source):
            self.service.update_task(queued["id"], enabled=False)
        with patch.object(task_scheduler, "task_service", self.service), \
             patch.object(task_scheduler, "_run_task", AsyncMock(side_effect=run)) as execute:
            await task_scheduler._run_due()
        self.assertEqual(execute.await_count, 1)
        self.assertEqual(execute.call_args.args[0]["id"], first["id"])
        self.assertNotIn("run_started_at", queued)
        self.assertEqual(queued["next_run_at"], "2000-01-01T00:00:00+00:00")

    async def test_scheduled_run_waiting_on_a_lock_rechecks_live_enabled_state(self):
        task = self.due("Queued")
        with patch.object(task_scheduler, "task_service", self.service), \
             patch.object(task_scheduler, "_run_task", AsyncMock()) as execute:
            lock = task_scheduler._lock(task["id"])
            await lock.acquire()
            queued = asyncio.create_task(task_scheduler.start_run(deepcopy(task), "schedule", wait=True))
            await asyncio.sleep(0)
            self.service.update_task(task["id"], enabled=False)
            lock.release()
            await queued
            execute.assert_not_awaited()
        self.assertNotIn("run_started_at", task)


if __name__ == "__main__":
    unittest.main()
