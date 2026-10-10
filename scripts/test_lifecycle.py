"""Reversible user tabs and automation schedules, with isolated fixture data."""
import asyncio
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import test_tabs as fixtures
from services import task_service as tasks
from routes import task_routes


class UserTabLifecycleTests(unittest.TestCase):
    setUp = fixtures.TabTests.setUp
    clear_modules = fixtures.TabTests.clear_modules
    folder = fixtures.TabTests.folder
    legacy = fixtures.TabTests.legacy
    approve = fixtures.TabTests.approve
    status = fixtures.TabTests.status

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


if __name__ == "__main__":
    unittest.main()
