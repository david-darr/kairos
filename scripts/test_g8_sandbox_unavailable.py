"""A06 (Part 2, g8): with Docker genuinely unreachable, every contained-execution entry says so and nothing runs on this computer.

Not mocked at the Docker layer: the real `docker` CLI is pointed at a dead
address (DOCKER_HOST) or removed from PATH, so the answers are what a person
without a running Docker would see. Every process the app tries to start is
recorded; the only executable allowed is `docker` itself.

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g8_sandbox_unavailable.py
"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
_DATA = tempfile.mkdtemp(prefix="g8-sandbox-off-")
os.environ["JARVIS_DATA_DIR"] = _DATA
os.environ["JARVIS_VAULT_DIR"] = os.path.join(_DATA, "vault")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import computer, sandbox, sandbox_browser, tool_registry  # noqa: E402
from routes import computer_routes  # noqa: E402


class Spawned:
    """Wraps asyncio.create_subprocess_exec so every launched program is recorded."""
    def __init__(self):
        self.programs = []
        self._real = asyncio.create_subprocess_exec

    async def __call__(self, program, *args, **kwargs):
        self.programs.append(os.path.basename(str(program)).lower().removesuffix(".exe"))
        return await self._real(program, *args, **kwargs)


class DockerDownTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"DOCKER_HOST": "tcp://127.0.0.1:9", "DOCKER_CONTEXT": ""})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.spawned = Spawned()
        patcher = patch("asyncio.create_subprocess_exec", new=self.spawned)
        patcher.start()
        self.addCleanup(patcher.stop)

    def assertOnlyDocker(self):
        self.assertTrue(self.spawned.programs, "the real docker CLI was never asked")
        self.assertEqual(set(self.spawned.programs), {"docker"}, self.spawned.programs)

    async def test_available_says_docker_is_not_running(self):
        ok, why = await sandbox.available()
        self.assertFalse(ok)
        self.assertIn("Docker is not running", why)
        self.assertOnlyDocker()

    async def test_run_raises_unavailable_and_starts_no_container(self):
        with self.assertRaises(sandbox.SandboxUnavailable):
            await sandbox.run("echo hi", files={"a.txt": "x"})
        self.assertEqual(set(self.spawned.programs), {"docker"})
        self.assertNotIn("sh", self.spawned.programs)

    async def test_run_code_tool_reports_it_and_says_nothing_ran_here(self):
        ctx = tool_registry.ToolContext(session_id="g8", is_admin=True)
        answer = await tool_registry.call("run_code", {"command": "echo hi"}, ctx, "openai")
        self.assertIn("sandbox is unavailable", answer)
        self.assertIn("Nothing was run on this computer", answer)
        self.assertOnlyDocker()

    async def test_run_code_with_internet_is_refused_before_asking(self):
        ctx = tool_registry.ToolContext(session_id="g8", is_admin=True)
        with patch("core.permissions.decide") as ask:
            answer = await tool_registry.call("run_code", {"command": "curl example.com", "internet": True}, ctx, "openai")
        ask.assert_not_called()
        self.assertIn("sandbox is unavailable", answer)

    async def test_browse_tool_reports_it(self):
        ctx = tool_registry.ToolContext(session_id="g8", is_admin=True)
        answer = await tool_registry.call("browse", {"url": "https://example.com/"}, ctx, "openai")
        self.assertIn("sandbox is unavailable", answer)
        self.assertEqual(set(self.spawned.programs), {"docker"})
        with self.assertRaises(sandbox.SandboxUnavailable):
            await sandbox_browser.browse("https://example.com/")

    async def test_computer_open_has_no_host_browser_fallback(self):
        ctx = tool_registry.ToolContext(session_id="g8", is_admin=True)
        with patch("core.settings.get_setting", return_value={"enabled": True}):
            answer = await tool_registry.call("computer", {"action": "open", "url": "https://example.com"}, ctx, "openai")
        self.assertIn("sandbox is unavailable", answer)
        self.assertIn("sandbox_unavailable", answer)
        self.assertOnlyDocker()
        self.assertEqual(computer.running(), [])
        for host_browser in ("chrome", "msedge", "firefox", "chromium", "playwright", "node"):
            self.assertNotIn(host_browser, self.spawned.programs)

    def test_status_route_states_the_reason_and_marks_images_not_ready(self):
        app = FastAPI()
        app.include_router(computer_routes.router)
        app.dependency_overrides[computer_routes.require_admin] = lambda: "boss"
        app.dependency_overrides[computer_routes.require_user] = lambda: "boss"
        with TestClient(app) as client:
            body = client.get("/api/computer/status").json()
        self.assertFalse(body["docker_available"])
        self.assertIn("Docker is not running", body["docker_reason"])
        self.assertFalse(body["image_ready"])
        self.assertFalse(body["desktop_image_ready"])


class DockerMissingTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_computer_without_the_docker_program_says_not_installed(self):
        with patch.dict(os.environ, {"PATH": ""}):
            ok, why = await sandbox.available()
            with self.assertRaises(sandbox.SandboxUnavailable) as caught:
                await sandbox.run("echo hi")
        self.assertFalse(ok)
        self.assertEqual(why, "Docker is not installed")
        self.assertIn("Docker is not installed", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
