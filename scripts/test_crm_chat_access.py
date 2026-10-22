"""Ordinary model chats can find/read owned CRM requirements without writes."""
import asyncio
import json
import unittest
from unittest.mock import AsyncMock, patch

from test_crm import CRMService, settings, tab_api
from kairos_tabs.crm import hooks, work, completion
from core import tab_hooks, tool_registry, system_prompt
from core.session_manager import session_manager
from core import tool_access
from fastapi import FastAPI
from fastapi.testclient import TestClient
from routes import tool_routes


class ChatTaskAccessTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings.update_settings(enabled_tab_templates=["crm"])
        self.store = CRMService("chat-access-" + self._testMethodName + ".json")
        self.task = self.store.create_task("local", {
            "title": "Create a PDF about a soccer curriculum", "project": "Youth coaching",
            "notes": "Four weeks, ages 8–10. Two sixty-minute sessions per week."})
        self.other = self.store.create_task("bob", {"title": self.task["title"], "notes": "PRIVATE"})
        self.ctx = tool_registry.ToolContext()
        for change in (patch.object(hooks, "crm_service", self.store),
                       patch.object(work, "crm_service", self.store),
                       patch.object(completion, "crm_service", self.store),
                       patch("core.auth.auth_enabled", return_value=False)):
            change.start(); self.addCleanup(change.stop)

    async def call(self, name, args=None, ctx=None):
        return await tool_registry.call(name, args or {}, ctx or self.ctx, tool_registry.CODEX)

    async def test_ordinary_chat_finds_task_and_reads_actual_requirements_without_mutation(self):
        before = self.store.task("local", self.task["id"])
        found = await self.call("list_tab_tasks", {"query": "soccer curriculum"})
        self.assertIn(self.task["id"], found)
        self.assertNotIn(self.other["id"], found)
        detail = await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"]})
        self.assertIn("Four weeks, ages 8–10", detail)
        self.assertIn("UNTRUSTED", detail)
        self.assertEqual(self.store.task("local", self.task["id"]), before)

    async def test_foreign_task_and_disabled_tab_return_no_private_data(self):
        text = await self.call("read_tab_task", {"tab": "crm", "task_id": self.other["id"]})
        self.assertIn("not found", text)
        self.assertNotIn("PRIVATE", text)
        settings.update_settings(enabled_tab_templates=[])
        text = await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"]})
        self.assertNotIn("Four weeks", text)
        self.assertNotIn(self.task["id"], await self.call("list_tab_tasks"))

    async def test_auth_uses_real_chat_owner_not_admin_flag_or_model_arguments(self):
        with patch("core.auth.auth_enabled", return_value=True), \
             patch.object(session_manager, "get_session", return_value={"owner_user": "bob"}):
            ctx = tool_registry.ToolContext(session_id="bob-chat", is_admin=True)
            found = await self.call("list_tab_tasks", {"query": "soccer"}, ctx)
            self.assertIn(self.other["id"], found)
            self.assertNotIn(self.task["id"], found)
            detail = await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"], "owner": "local"}, ctx)
            self.assertIn("not found", detail)
            text = await self.call("list_tab_tasks", {}, tool_registry.ToolContext(is_admin=True))
            self.assertIn("authenticated owner", text)

    async def test_closed_tasks_are_not_listed_but_remain_readable_by_owner(self):
        self.store.update_task("local", self.task["id"], {"status": "done"})
        self.assertNotIn(self.task["id"], await self.call("list_tab_tasks"))
        self.assertIn("Status: done", await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"]}))

    async def test_search_by_project_and_contact_and_limit(self):
        self.assertIn(self.task["id"], await self.call("list_tab_tasks", {"query": "Youth coaching"}))
        for n in range(30):
            self.store.create_task("local", {"title": f"Other follow-up {n}"})
        self.assertEqual(len(await tab_hooks.task_items("local")), 20)

    async def test_tab_disabled_while_hook_runs_cannot_publish_records(self):
        async def disable(*args):
            settings.update_settings(enabled_tab_templates=[])
            return "PRIVATE"
        with patch.object(hooks, "task_context", disable):
            text = await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"]})
        self.assertNotIn("PRIVATE", text)

    async def test_task_chat_refreshes_edited_notes_and_names_the_builtin_crm(self):
        appended = []
        with patch.object(work.api, "chat_session", return_value="task-chat"), \
             patch.object(work.api, "append_chat_message", side_effect=lambda sid, role, text: appended.append(text)):
            work.open_chat("local", self.task["id"])
            work.open_chat("local", self.task["id"])
            self.assertEqual(len(appended), 1)
            self.assertIn("built-in Kairos CRM", appended[0])
            self.assertIn(self.task["id"], appended[0])
            self.store.update_task("local", self.task["id"], {"notes": "Six weeks instead, ages 10–12."})
            work.open_chat("local", self.task["id"])
            self.assertEqual(len(appended), 2)
            self.assertIn("Six weeks instead", appended[-1])

    async def test_pdf_completion_after_task_lookup_still_needs_file_action(self):
        self.store.configure("local", {"endpoint_id": "reader"})
        detail = await self.call("read_tab_task", {"tab": "crm", "task_id": self.task["id"]})
        self.assertIn("Four weeks", detail)
        turn = {"id": "pdf-run", "at": self.task["created_at"] + 1, "session_id": "ordinary-chat",
                "message": "Complete my soccer curriculum task.",
                "reply": "Created the soccer curriculum PDF: soccer-curriculum.pdf", "actions": []}
        raw = json.dumps({"completed": [{"task_id": self.task["id"], "actor": "assistant", "certain": True,
                           "quote": turn["reply"], "requires_action": True}]})
        with patch.object(tab_api, "complete", AsyncMock(return_value=raw)), \
             patch.object(tab_api, "model_context_size", return_value=16384):
            await completion.check("local", [self.task], turn)
            self.assertEqual(self.store.task("local", self.task["id"])["status"], "active")
            turn["actions"] = [{"name": "run_code", "ok": True, "detail": "Created soccer-curriculum.pdf with all eight sessions"}]
            await completion.check("local", [self.task], turn)
            self.assertEqual(self.store.task("local", self.task["id"])["status"], "done")

    def test_codex_cli_backend_route_uses_turn_token_and_can_read_task(self):
        app = FastAPI()
        app.include_router(tool_routes.router)
        client = TestClient(app, client=("127.0.0.1", 50000))
        session = session_manager.create_session("Soccer task lookup")
        token = tool_access.issue(session["id"], is_admin=False)
        try:
            found = client.post("/api/tools/list_tab_tasks", json={"arguments": {"query": "soccer"}},
                                headers={"X-JARVIS-Tool-Token": token})
            self.assertEqual(found.status_code, 200)
            self.assertIn(self.task["id"], found.json()["result"])
            detail = client.post("/api/tools/read_tab_task",
                json={"arguments": {"tab": "crm", "task_id": self.task["id"]}},
                headers={"X-JARVIS-Tool-Token": token})
            self.assertIn("Four weeks, ages 8–10", detail.json()["result"])
            tool_access.revoke(token)
            denied = client.post("/api/tools/list_tab_tasks", json={"arguments": {}},
                                 headers={"X-JARVIS-Tool-Token": token})
            self.assertEqual(denied.status_code, 403)
        finally:
            tool_access.revoke(token)

    def test_all_model_surfaces_and_codex_instructions_offer_the_tools(self):
        for surface in (tool_registry.CLAUDE, tool_registry.CODEX, tool_registry.OPENAI):
            names = {s.name for s in tool_registry.specs(surface, is_admin=False)}
            self.assertTrue({"list_tab_tasks", "read_tab_task"} <= names)
        cli = system_prompt.for_codex("python.exe", "hive_mind_cli.py")
        self.assertIn("list_tab_tasks", cli)
        self.assertIn("read_tab_task", cli)
        self.assertIn("built-in CRM", cli)


if __name__ == "__main__":
    unittest.main()
