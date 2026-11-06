"""Workbench phases, access, place enforcement and help, without Docker."""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-workbench-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import computer, settings, session_manager as sessions
from core.middleware import require_admin
from core.tool_registry import ToolContext
from routes import bot_workbench_routes as routes
from services import bot_workbench as workbench, bot_help, bot_record
from services.agent_service import agent_service

app = FastAPI()
app.include_router(routes.router)
app.dependency_overrides[require_admin] = lambda: "local"
web = TestClient(app)


class WorkbenchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot = agent_service.create("Workbench test")
        self.owner = "agent:" + self.bot["id"]
        self.manager = computer.ComputerManager()
        self.patch = patch.object(computer, "manager", self.manager)
        self.patch.start()
        self.session = sessions.session_manager.create_session("Workbench", owner_user="local")
        sessions.session_manager.set_agent(self.session["id"], self.bot["id"], "")
        settings.update_settings(computer_use={"enabled": True, "desktop": False})
        self.docker = patch.object(workbench, "docker_status", AsyncMock(return_value={"available": True, "reason": "", "image_ready": True, "desktop_image_ready": True}))
        self.docker.start()

    async def asyncTearDown(self):
        self.patch.stop()
        self.docker.stop()
        agent_service.delete(self.bot["id"])

    async def test_status_all_phases_never_starts(self):
        self.manager._start = AsyncMock(side_effect=AssertionError("status must not start"))
        async def phase(expected):
            result = await workbench.status(agent_service.get(self.bot["id"]), self.session["id"])
            self.assertEqual(result["phase"], expected)
            self.assertTrue(result["message"])
            self.assertTrue(result["action"])
            return result
        await phase("asleep")
        self.manager.starting.add(self.owner)
        await phase("starting")
        self.manager.starting.clear()
        c = computer.Computer(self.owner, None, "test")
        self.manager._computers[self.owner] = c
        await phase("ready")
        with patch("services.chat_live.is_processing", return_value=True):
            await phase("busy")
        self.manager.takeover(self.owner)
        await phase("taken")
        self.manager.hand_back(self.owner)
        agent_service.update(self.bot["id"], place="browser")
        await phase("browser_only")
        self.manager._computers.clear()
        self.manager.errors[self.owner] = "Try again"
        await phase("error")
        self.manager.errors.clear()
        self.manager._waiters.append(self.owner)
        result = await phase("starting")
        self.assertIn("position 1", result["message"])
        self.manager._waiters.clear()
        with patch.object(workbench, "docker_status", AsyncMock(return_value={"available": False, "reason": "Missing", "image_ready": False, "desktop_image_ready": False})):
            await phase("docker_missing")
        with patch.object(workbench, "docker_status", AsyncMock(return_value={"available": True, "reason": "", "image_ready": False, "desktop_image_ready": False})):
            await phase("image_needed")
        agent_service.update(self.bot["id"], place="off")
        await phase("off")
        self.manager._start.assert_not_awaited()

    async def test_thread_pin_off_and_browser(self):
        agent_service.update(self.bot["id"], place="computer")
        sessions.session_manager.set_thread(self.session["id"], place="off")
        self.assertEqual(workbench.effective_place(self.owner, self.session["id"])["effective"], "off")
        result = await self.manager.act(self.owner, "open", {"url": "https://example.com"}, ToolContext(agent_id=self.bot["id"], session_id=self.session["id"], is_admin=True))
        self.assertEqual(result["code"], "place_off")
        self.assertFalse(self.manager.running())
        sessions.session_manager.set_thread(self.session["id"], place="browser")
        self.manager.desktop = True
        with patch.object(computer.sandbox, "available", AsyncMock(return_value=(True, ""))), patch.object(computer.sandbox_egress, "ensure", AsyncMock()), patch.object(computer.computer_image, "ensure_image", AsyncMock(return_value="test")) as image:
            self.manager.process_factory = AsyncMock(side_effect=OSError("no process"))
            with self.assertRaises(computer.sandbox.SandboxUnavailable):
                await self.manager._get(self.owner, thread_id=self.session["id"])
            image.assert_awaited_once_with(desktop=False)
        agent_service.update(self.bot["id"], browser_enabled=False)
        self.assertEqual(workbench.effective_place(self.owner, self.session["id"])["effective"], "off")

    async def test_lease_stale_and_repeated_release(self):
        c = computer.Computer(self.owner, None, "test")
        self.manager._computers[self.owner] = c
        first = workbench.control(self.bot["id"], "take")["lease_id"]
        second = workbench.control(self.bot["id"], "take")["lease_id"]
        self.assertNotEqual(first, second)
        with self.assertRaisesRegex(ValueError, "Control changed"):
            workbench.control(self.bot["id"], "release", first)
        self.assertTrue(c.taken_over)
        workbench.control(self.bot["id"], "release", second)
        self.assertFalse(c.taken_over)
        with self.assertRaises(ValueError):
            workbench.control(self.bot["id"], "release", second)
        self.manager._computers.clear()

    async def test_help_supersede_settle_and_answer_scope(self):
        a = bot_help.raise_help(self.bot["id"], "Please sign in", "example.com", self.session["id"])
        b = bot_help.raise_help(self.bot["id"], "Please use this frame", thread_id=self.session["id"])
        with self.assertRaises(ValueError): bot_help.settle_help(self.bot["id"], a["id"], "done")
        with self.assertRaises(KeyError): bot_help.settle_help(self.bot["id"], "missing", "done")
        self.assertIsNone(bot_help.answer_in_chat(self.bot["id"], "other"))
        self.assertEqual(bot_help.answer_in_chat(self.bot["id"], self.session["id"])["outcome"], "answer_in_chat")
        with self.assertRaises(ValueError): bot_help.settle_help(self.bot["id"], b["id"], "cancel")
        item = bot_help.raise_help(self.bot["id"], "Help")
        self.assertEqual(bot_help.settle_help(self.bot["id"], item["id"], "cancel")["outcome"], "cancel")

    async def test_file_scope_sharing_and_hidden(self):
        from core import image_gen
        root = Path(_DATA.name) / "workspace"
        root.mkdir(exist_ok=True)
        (root / "local.txt").write_text("local")
        (root / ".secret").write_text("private")
        generated = Path(image_gen.generated_files_dir())
        generated.mkdir(parents=True, exist_ok=True)
        (generated / "report.txt").write_text("shared")
        session = {**self.session, "workspace_dir": str(root), "agent_id": self.bot["id"], "messages": [
            {"role": "assistant", "content": "[Report](/generated-files/report.txt)"}]}
        with patch.object(sessions.session_manager, "get_session", return_value=session):
            files = workbench.files(self.bot, self.session["id"])["recent"]
        self.assertTrue(next(f for f in files if f["name"] == "report.txt")["shared"])
        self.assertFalse(next(f for f in files if f["name"] == "local.txt")["shared"])
        self.assertNotIn(".secret", str(files))

    async def test_models_and_routes_validate_access(self):
        self.assertEqual(bot_record.new_defaults()["browser_profile"], "own")
        for key, value in (("browser_enabled", 1), ("browser_profile", "shared:../bad")):
            with self.assertRaises(ValueError): bot_record.clean_field(key, value)
        self.assertEqual(web.get("/api/bot-workbench/missing/status").status_code, 404)
        self.assertEqual(web.get(f"/api/bot-workbench/{self.bot['id']}/status?thread_id=foreign").status_code, 404)
        self.assertEqual(web.put("/api/bot-workbench/computers/settings", json={"max_running": 0, "idle_minutes": 5}).status_code, 422)
        self.assertEqual(web.post("/api/bot-workbench/profiles", json={"name": "Good", "owner": "forged"}).status_code, 422)
        self.assertEqual(web.post(f"/api/bot-workbench/{self.bot['id']}/computer/control", json={"action": "release", "lease_id": "stale"}).status_code, 404)
        self.assertEqual(web.post(f"/api/bot-workbench/{self.bot['id']}/help/missing/settle", json={"outcome": "done"}).status_code, 404)
        app.dependency_overrides.pop(require_admin)
        try:
            with patch("core.middleware.get_current_user", return_value=None):
                self.assertIn(web.get("/api/bot-workbench/profiles").status_code, (401, 403))
        finally: app.dependency_overrides[require_admin] = lambda: "local"


if __name__ == "__main__":
    unittest.main()
