"""Phase 1-3 host wiring against the merged services, without a model or network."""
import asyncio
import dataclasses
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory

DATA = TestDataDirectory("kairos-bots-integration-")
os.environ["JARVIS_DATA_DIR"] = DATA.name

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import bot_policy, permissions, tool_registry
from core.middleware import require_admin
from core.session_manager import session_manager
from core.turn_taint import TurnTaint
from routes import agent_routes, bot_resources_routes
from services import bot_automation_changes, bot_memory, bot_memory_recall, bot_routines
from services.agent_service import agent_service


class Integration(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.bot = agent_service.create("Integration " + os.urandom(4).hex())
        self.sid = session_manager.create_session(owner_user="local")["id"]
        session_manager.set_agent(self.sid, self.bot["id"], "Bot identity")
        self.ctx = tool_registry.ToolContext(agent_id=self.bot["id"], session_id=self.sid,
                                             owner_user="local", is_admin=True, turn_taint=TurnTaint())
        self.addCleanup(lambda: session_manager.get_session(self.sid) and session_manager.delete_session(self.sid))
        self.addCleanup(lambda: agent_service.get(self.bot["id"]) and agent_service.delete(self.bot["id"]))

    async def call(self, name, args):
        return await tool_registry.call(name, args, self.ctx, tool_registry.OPENAI)

    def test_router_aggregate_and_static_order(self):
        import app
        def flatten(routes):
            for route in routes:
                if hasattr(route, "original_router"):
                    yield from flatten(route.original_router.routes)
                elif hasattr(route, "methods"):
                    yield route
        paths = [(r.path, method) for r in flatten(app.app.routes) for method in r.methods]
        resources = list(flatten(bot_resources_routes.router.routes))
        for route in resources:
            for method in route.methods:
                self.assertEqual(paths.count((route.path, method)), 1, (method, route.path))
        ordered = [r.path for r in resources]
        self.assertLess(ordered.index("/api/bots/profile"), ordered.index("/api/bots/{bot_id}/memory"))
        for name in ("bot_card_routes", "bot_event_routes"):
            self.assertIn(name, bot_resources_routes.included)
        self.assertEqual(paths.count(("/api/bots-approvals/{bot_id}", "GET")), 1)
        self.assertEqual(paths.count(("/api/bot-routines", "GET")), 1)

    async def test_ask_reaches_one_gate_and_deny_never_runs_the_handler(self):
        bot_policy.change_mode(self.bot["id"], "ask", user="local")
        surface = self.ctx.permission_surface
        queue = permissions.open_channel(surface)
        self.addCleanup(permissions.close_channel, surface)
        handler = AsyncMock(return_value="Changed")
        spec = dataclasses.replace(tool_registry._REGISTRY["notebook_action"], handler=handler)
        with patch.dict(tool_registry._REGISTRY, {"notebook_action": spec}):
            work = asyncio.create_task(self.call("notebook_action", {"path": "MEMORY.md", "action": "append"}))
            request = await asyncio.wait_for(queue.get(), 2)
            self.assertTrue(permissions.answer(request["id"], "reject", "local"))
            self.assertTrue((await asyncio.wait_for(work, 2)).startswith("Not run:"))
            handler.assert_not_awaited()

    async def test_notebook_scope_and_memory_off_are_enforced(self):
        before = bot_memory.read_file(self.bot["id"], "MEMORY.md")
        result = await self.call("notebook_action", {"path": "MEMORY.md", "action": "append", "section": "Notes",
                                "body": "Integration note", "expected_hash": before["hash"], "bot_id": "foreign"})
        self.assertNotIn("Not run:", result)
        self.assertIn("Integration note", bot_memory.read_file(self.bot["id"], "MEMORY.md")["text"])
        agent_service.update(self.bot["id"], memory_enabled=False)
        self.assertTrue((await self.call("recall_search", {"q": "Integration"})).startswith("Not allowed:"))
        self.assertTrue((await self.call("agent_remember", {"section": "Notes", "text": "Blocked"})).startswith("Not allowed:"))

    async def test_real_routine_backend_and_undo(self):
        bot_automation_changes.set_backend("routine", None)
        text = await self.call("schedule_routine", {"name": "Integrated routine", "instructions": "Read my notes",
                               "schedule": {"kind": "cron", "expression": "0 9 * * 1", "time_zone": "UTC"}})
        self.assertTrue(text.startswith("Added routine"), text)
        rows = bot_routines.list_routines("local", True, self.bot["id"])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["schedule"]["kind"], "cron")
        self.assertEqual(bot_routines.routine_summaries("local", True)[0]["routine"]["revision"], rows[0]["revision"])
        receipt = bot_automation_changes.store().list_receipts("local", bot_id=self.bot["id"])[0]
        bot_automation_changes.store().undo(receipt["id"], "local")
        self.assertEqual(bot_routines.list_routines("local", True, self.bot["id"]), [])

    def test_resource_fields_survive_the_api(self):
        app = FastAPI()
        app.include_router(agent_routes.router)
        app.dependency_overrides[require_admin] = lambda: "local"
        with TestClient(app) as client:
            fields = {"memory_enabled": False, "helper_model": False, "connector_tools": {}, "grants_version": 1}
            response = client.patch(f"/api/agents/{self.bot['id']}", json=fields)
            self.assertEqual(response.status_code, 200, response.text)
            for name, value in fields.items():
                self.assertEqual(response.json()[name], value)


if __name__ == "__main__":
    unittest.main()
