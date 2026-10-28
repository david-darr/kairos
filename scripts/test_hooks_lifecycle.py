"""Hooks: create/edit/disable/delete, tool filters, order, block-on-failure,
limits and the real admin gate. test_hooks.py proves events, blocking, stdin,
timeouts, webhook signing and notes; this adds the lifecycle and the cases
that file leaves open.

    .venv\\Scripts\\python.exe scripts\\test_hooks_lifecycle.py
"""
import asyncio
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="g7-hooks-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient

from app import app
from core.auth import SESSION_COOKIE_NAME, auth_manager
from services import hook_service as hook_module
from services.hook_service import hook_service

logging.disable(logging.CRITICAL)
SCRIPTS = Path(_DATA.name) / "cmd"
SCRIPTS.mkdir()


def command(name, body):
    path = SCRIPTS / f"{name}.py"
    path.write_text("import json, os, sys, time\n" + body, encoding="utf-8")
    return f'"{sys.executable}" "{path}"'


TRACE = SCRIPTS / "trace.txt"
def tracer(label, exit_code=0, extra=""):
    return command(f"t_{label}", f'open(r"{TRACE}", "a").write("{label}\\n")\n{extra}\nsys.exit({exit_code})\n')


class Hooks(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}; auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        auth_manager.create_user("member", "member-password-1")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))

    @classmethod
    def tearDownClass(cls):
        from core import session_manager_store
        session_manager_store.close()

    async def asyncSetUp(self):
        for hook in hook_service.hooks():
            hook_service.delete(hook["id"])
        hook_service.set_paused(False)
        TRACE.unlink(missing_ok=True)
        self.sent = AsyncMock(return_value=True)
        patch("core.channels.registry.send_to_channel", self.sent).start()

    async def asyncTearDown(self):
        await hook_service.drain()
        patch.stopall()

    def create(self, **fields):
        made = self.admin.post("/api/hooks", json={"name": "A hook", **fields})
        self.assertEqual(made.status_code, 200, made.text)
        return made.json()

    def trace(self):
        return TRACE.read_text().split() if TRACE.exists() else []

    # -- the gate ------------------------------------------------------------------

    def test_every_hook_route_refuses_members_and_anonymous_callers_for_real(self):
        hook = self.create(event="chat.reply", action="channel", config={"channel_id": "conn:x"})
        for method, path, body in (("get", "", None), ("post", "", {"name": "x", "event": "chat.reply", "action": "channel", "config": {"channel_id": "c"}}),
                                   ("patch", f"/{hook['id']}", {"enabled": False}), ("delete", f"/{hook['id']}", None),
                                   ("post", f"/{hook['id']}/test", {}), ("post", "/pause", {"paused": True})):
            for who, c in (("member", self.member), ("anonymous", self.anon)):
                got = getattr(c, method)("/api/hooks" + path, **({} if body is None else {"json": body}))
                self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
        self.assertEqual(len(hook_service.hooks()), 1)
        self.assertTrue(hook_service.get(hook["id"])["enabled"])
        self.assertFalse(hook_service.paused)

    # -- create, edit, disable, delete -----------------------------------------------

    async def test_edit_disable_and_delete_change_what_fires(self):
        hook = self.create(event="task.finished", action="channel", config={"channel_id": "conn:a", "template": "A {task}"})
        hook_service.emit("task.finished", {"source": "task", "task": "one"})
        await hook_service.drain()
        self.assertEqual([c.args for c in self.sent.call_args_list], [("conn:a", "A one")])
        edited = self.admin.patch(f"/api/hooks/{hook['id']}", json={"config": {"channel_id": "conn:b", "template": "B {task}"}}).json()
        self.assertEqual(edited["config"]["channel_id"], "conn:b")
        self.sent.reset_mock()
        hook_service.emit("task.finished", {"source": "task", "task": "two"})
        await hook_service.drain()
        self.assertEqual([c.args for c in self.sent.call_args_list], [("conn:b", "B two")], "the edit applies to the next event, once")
        self.assertFalse(self.admin.patch(f"/api/hooks/{hook['id']}", json={"enabled": False}).json()["enabled"])
        self.sent.reset_mock()
        hook_service.emit("task.finished", {"source": "task", "task": "three"})
        await hook_service.drain()
        self.sent.assert_not_called()
        self.assertTrue(self.admin.patch(f"/api/hooks/{hook['id']}", json={"enabled": True}).json()["enabled"])
        self.assertEqual(self.admin.patch(f"/api/hooks/{hook['id']}", json={"event": "nope"}).status_code, 400)
        self.assertEqual(self.admin.patch(f"/api/hooks/{hook['id']}", json={"action": "command", "config": {}}).status_code, 400, "a bad edit changes nothing")
        self.assertEqual(hook_service.get(hook["id"])["action"], "channel")
        self.assertEqual(self.admin.delete(f"/api/hooks/{hook['id']}").json(), {"ok": True})
        self.assertEqual(self.admin.delete(f"/api/hooks/{hook['id']}").status_code, 404)
        self.assertEqual(self.admin.patch(f"/api/hooks/{hook['id']}", json={"enabled": True}).status_code, 404)
        self.assertEqual(self.admin.post(f"/api/hooks/{hook['id']}/test").status_code, 404)
        self.sent.reset_mock()
        hook_service.emit("task.finished", {"source": "task", "task": "four"})
        await hook_service.drain()
        self.sent.assert_not_called()

    async def test_the_webhook_secret_is_encrypted_never_shown_and_kept_on_edit(self):
        made = self.create(event="chat.reply", action="webhook", config={"url": "https://example.test/h", "secret": "hunter2-secret"})
        self.assertIs(made["config"]["secret"], True, "the API says a secret exists, not what it is")
        self.assertNotIn("hunter2-secret", Path(hook_module.HOOKS_FILE).read_text(encoding="utf-8"))
        self.assertNotIn("hunter2-secret", self.admin.get("/api/hooks").text)
        self.admin.patch(f"/api/hooks/{made['id']}", json={"config": {"url": "https://example.test/other"}})
        from core.secret_storage import decrypt
        self.assertEqual(decrypt(hook_service.get(made["id"])["config"]["secret"]), "hunter2-secret", "an edit without a secret keeps the saved one")
        self.admin.patch(f"/api/hooks/{made['id']}", json={"config": {"url": "https://example.test/other", "secret": "new-secret"}})
        self.assertEqual(decrypt(hook_service.get(made["id"])["config"]["secret"]), "new-secret")

    # -- tool filters, order, failure ------------------------------------------------------

    async def test_tool_patterns_select_which_tools_a_hook_sees(self):
        self.create(event="tool.before", action="command", tool_pattern="Bash|mcp__*", config={"command": tracer("p")})
        for tool in ("Bash", "mcp__x__y", "Read", "bash"):
            await hook_service.before_tool(tool, {"command": "ls"}, source="chat")
        self.assertEqual(self.trace(), ["p", "p"], "Bash and the mcp__ prefix match; Read and lowercase bash do not")

    async def test_hooks_run_in_order_and_the_first_block_stops_the_rest(self):
        self.create(name="one", event="tool.before", action="command", config={"command": tracer("one")})
        self.create(name="two", event="tool.before", action="command", config={"command": tracer("two", 2, 'sys.stderr.write("second says no")')})
        self.create(name="three", event="tool.before", action="command", config={"command": tracer("three")})
        reason = await hook_service.before_tool("Bash", {"command": "ls"}, source="chat")
        self.assertEqual(reason, "second says no")
        self.assertEqual(self.trace(), ["one", "two"], "created order; nothing runs after a block")

    async def test_a_hook_that_fails_lets_the_tool_run_unless_told_to_block(self):
        self.create(name="open", event="tool.before", action="command", config={"command": tracer("open", 1)})
        self.assertIsNone(await hook_service.before_tool("Bash", {}, source="chat"), "fails open by default")
        self.create(name="strict", event="tool.before", action="command", config={"command": tracer("strict", 1), "block_on_failure": True})
        reason = await hook_service.before_tool("Bash", {}, source="chat")
        self.assertIn("strict", reason)
        outcomes = [hook["log"][0]["outcome"] for hook in hook_service.hooks()]
        self.assertEqual(outcomes, ["failed", "failed"], "both failures are in the hook's log")

    async def test_a_blocking_hook_runs_the_tool_zero_times_and_a_clean_one_exactly_once(self):
        ran = []

        async def tool():
            ran.append(1)
            return "tool result"
        self.create(event="tool.before", action="command", config={"command": tracer("gate", 2, 'sys.stderr.write("no")')})
        self.assertEqual(await hook_service.around_tool("Bash", {}, tool, source="chat"), "Not run: blocked by a hook: no")
        self.assertEqual(ran, [])
        for h in hook_service.hooks():
            hook_service.delete(h["id"])
        self.create(event="tool.before", action="command", config={"command": tracer("before")})
        self.create(event="tool.after", action="channel", config={"channel_id": "conn:x", "template": "{tool}"})
        TRACE.unlink(missing_ok=True)
        self.assertEqual(await hook_service.around_tool("Bash", {}, tool, source="chat"), "tool result")
        await hook_service.drain()
        self.assertEqual((ran, self.trace(), self.sent.await_count), ([1], ["before"], 1), "one tool run, one before hook, one after notice")

    async def test_the_log_is_capped_and_a_test_event_reports_its_outcome(self):
        hook = self.create(event="task.finished", action="channel", config={"channel_id": "conn:x"})
        for n in range(hook_module.LOG_LENGTH + 20):
            hook_service.emit("task.finished", {"source": "task", "task": str(n)})
        await hook_service.drain()
        self.assertEqual(len(hook_service.get(hook["id"])["log"]), hook_module.LOG_LENGTH)
        result = self.admin.post(f"/api/hooks/{hook['id']}/test").json()
        self.assertEqual(result["outcome"], "ok")
        self.sent.return_value = False
        self.assertEqual(self.admin.post(f"/api/hooks/{hook['id']}/test").json()["outcome"], "failed", "an undelivered channel message is a failure, not silence")

    async def test_a_flood_is_bounded_instead_of_queuing_without_limit(self):
        hook = self.create(event="task.finished", action="channel", config={"channel_id": "conn:x"})
        gate = asyncio.Event()

        async def blocked(*args):
            await gate.wait()
            return True
        self.sent.side_effect = blocked
        for n in range(hook_module.MAX_IN_FLIGHT + 25):
            hook_service.emit("task.finished", {"source": "task", "task": str(n)})
        self.assertLessEqual(len(hook_service._in_flight), hook_module.MAX_IN_FLIGHT)
        self.assertEqual(hook_service.get(hook["id"])["log"][0]["outcome"], "skipped")
        gate.set()
        await hook_service.drain()

    async def test_paused_state_and_hooks_survive_a_restart(self):
        hook = self.create(event="chat.reply", action="channel", config={"channel_id": "conn:x"})
        self.admin.post("/api/hooks/pause", json={"paused": True})
        reloaded = hook_module.HookService()
        self.assertTrue(reloaded.paused)
        self.assertEqual([h["id"] for h in reloaded.hooks()], [hook["id"]])
        self.admin.post("/api/hooks/pause", json={"paused": False})


if __name__ == "__main__":
    unittest.main()
