"""Front-desk tool contracts through the real registry and permission broker."""
import asyncio
import dataclasses
import json
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

import test_bots_fdbot as lifecycle
from core import front_desk_tools as tools, permissions, tool_registry as registry, task_scope
from core.session_manager import session_manager
from core.turn_taint import TurnTaint
from services import front_desk, front_desk_cards as cards
from services.agent_service import agent_service
from services.task_service import task_service

# The orchestrator adds the production register_all call in its owned registry.
if "fd_list_bots" not in registry._REGISTRY:
    tools.register_all(registry.register)
ARGS = {
    "fd_list_bots": {}, "fd_route": {"bot": "Writer", "task": "Write it", "constraints": "Short", "good_answer": "One paragraph"},
    "fd_find_chat": {"query": "Research"}, "fd_forge_projects": {},
    "fd_forge_propose": {"project": "p", "task": "Fix the test"}, "fd_start_task": {"ask": "Research birds"},
    "fd_add_tasks": {"items": [{"title": "Read notes"}]}, "fd_make": {"kind": "slides", "brief": "Bird slides"},
    "fd_suggest": {"title": "Read notes", "source": {"app": "mail", "ref": "m1"}},
    "fd_save_draft": {"to": "a@example.com", "subject": "Hello", "body": "Draft words"},
    "fd_chips": {"options": ["Tomorrow", "Next week"]},
}


class FrontDeskToolsCase(unittest.IsolatedAsyncioTestCase):
    clean_sessions = lifecycle.FrontDeskCase.clean_sessions

    def setUp(self):
        lifecycle.FrontDeskCase.setUp(self)
        self.bot = front_desk.ensure()
        self.sid = front_desk.main_thread_id()
        self.peer = agent_service.create("Writer")
        session_manager.append_message(self.sid, "user", "Help with this")
        self.ctx = registry.ToolContext(session_id=self.sid, agent_id=self.bot["id"], is_admin=True,
                                        turn_taint=TurnTaint(), assignment_run_id="turn1")
        self.suggestions = Mock(side_effect=lambda title, detail, source, origin, run_id=None:
                                {"id": "s" + str(self.suggestions.call_count), "title": title, "detail": detail})
        self.start = AsyncMock(return_value={"id": "task1"})
        self.draft = Mock(return_value={"id": "d1", "status": "draft"})
        for p in (patch.dict(sys.modules, {
                "services.front_desk_suggestions": types.SimpleNamespace(add=self.suggestions),
                "services.front_desk_tasks": types.SimpleNamespace(start=self.start),
                "services.front_desk_drafts": types.SimpleNamespace(save=self.draft)}),
                  patch("services.forge_projects.forge_projects.list", return_value=[{"id": "p", "name": "Project"}])):
            p.start()
            self.addCleanup(p.stop)

    async def call(self, name, args=None, ctx=None):
        return await registry.call(name, ARGS[name] if args is None else args, ctx or self.ctx, registry.OPENAI)

    async def test_every_tool_refuses_wrong_bot_and_no_agent(self):
        for spec in tools.TOOLS:
            with self.subTest(tool=spec["name"]):
                result = await self.call(spec["name"], ctx=dataclasses.replace(self.ctx, agent_id=self.peer["id"]))
                self.assertTrue(result.startswith("Not run:"), result)
                result = await self.call(spec["name"], ctx=dataclasses.replace(self.ctx, agent_id=None))
                self.assertTrue(result.startswith("Unknown tool:"), result)
        self.assertFalse(self.suggestions.called)
        self.assertFalse(self.start.called)
        self.assertFalse(self.draft.called)

    async def test_every_tool_clean_call_uses_real_broker(self):
        with patch.object(permissions, "decide", wraps=permissions.decide) as gate:
            for spec in tools.TOOLS:
                with self.subTest(tool=spec["name"]):
                    self.ctx.turn_taint.reset()
                    before = gate.call_count
                    result = await self.call(spec["name"])
                    self.assertFalse(result.startswith(("Not run:", "Tool error:", "Unknown tool:")), result)
                    # A changing tool passes the registry's outer gate (Phase 3) and its own check, which the
                    # outer approval covers, so the person is asked once; a read passes neither.
                    self.assertEqual(gate.call_count - before, 2 * int(spec["operation"] != "read"))
        self.assertTrue(self.start.called)
        self.assertTrue(self.draft.called)
        self.assertTrue(self.suggestions.called)

    async def test_denied_permission_performs_no_mutation(self):
        with patch.object(permissions, "decide", new=AsyncMock(return_value=permissions.Decision("deny", "No"))):
            before = len(session_manager.get_session(self.sid)["messages"])
            for spec in tools.TOOLS:
                if spec["operation"] != "read":
                    self.assertEqual(await self.call(spec["name"]), "Not run: No")
            self.assertEqual(len(session_manager.get_session(self.sid)["messages"]), before)
        self.assertFalse(self.start.called or self.suggestions.called or self.draft.called)

    async def test_tainted_routing_and_start_only_suggest(self):
        self.ctx.turn_taint.mark("mail")
        with patch("services.agent_handoff.assign") as assign, patch("services.forge_sessions.forge_sessions.create") as forge:
            for name in ("fd_route", "fd_start_task", "fd_make", "fd_forge_propose"):
                result = json.loads(await self.call(name))
                self.assertIn("suggestion", result)
            self.assertFalse(assign.called or forge.called or self.start.called)
        self.assertEqual(self.suggestions.call_count, 4)
        self.assertEqual(self.suggestions.call_args_list[0].args[0], "Hand this to Writer?")

    async def test_clean_route_reuses_real_handoff_and_result_back(self):
        result = await self.call("fd_route")
        self.assertIn("Assigned to Writer", result)
        assigned = next(c for c in task_service.list_tasks() if c.get("agent_id") == self.peer["id"])
        self.assertEqual(assigned["requester"]["session_id"], self.sid)
        self.assertEqual(assigned["assignment_chain"], [self.bot["id"], self.peer["id"]])
        self.assertIn("Constraints:\nShort", assigned["prompt"])
        self.assertIn("A good answer:\nOne paragraph", assigned["prompt"])
        self.assertIn("<<<UNTRUSTED-", assigned["prompt"])
        rows = session_manager.get_session(self.sid)["messages"]
        self.assertTrue(any(m.get("type") == "handoff" for m in rows))
        self.assertTrue(any(m.get("fd_kind") == "route" and m["fd_data"]["card_id"] == assigned["id"] for m in rows))
        from services import agent_handoff
        with patch.object(agent_handoff, "schedule_wake"):
            agent_handoff.finished(assigned, "Finished the paragraph")
        self.assertTrue(any("Finished the paragraph" in m.get("content", "") for m in session_manager.get_session(self.sid)["messages"]))

    async def test_exact_names_and_archive_refresh(self):
        self.assertIn("Tool error:", await self.call("fd_route", {"bot": "writer", "task": "Do it"}))
        self.assertIn("Tool error:", await self.call("fd_route", {"bot": "Kip", "task": "Do it"}))
        front_desk.sync_peers()
        agent_service.update(self.peer["id"], hidden=True)
        self.assertIn("Tool error:", await self.call("fd_route"))
        await self.call("fd_list_bots")
        self.assertNotIn(self.peer["id"], self.bot["peers"])

    async def test_watch_only_reads_suggestions_and_drafts(self):
        session_manager.set_agent(self.sid, self.bot["id"], "watch", unattended=True)
        for spec in tools.TOOLS:
            with self.subTest(tool=spec["name"]):
                result = await self.call(spec["name"])
                if spec["name"] in tools.WATCH_TOOLS:
                    self.assertFalse(result.startswith(("Not run:", "Tool error:")), result)
                else:
                    self.assertTrue(result.startswith("Not run: watch"), result)
        self.assertFalse(self.start.called)
        self.assertTrue(self.suggestions.called and self.draft.called)
        self.assertEqual(tools.operation_for("unknown_tool"), "opaque")
        self.assertEqual(await registry.call("unknown_tool", {}, self.ctx, registry.OPENAI), "Unknown tool: unknown_tool")

    async def test_trusted_task_scope_and_no_thread_are_conservative(self):
        with task_scope.bind({"id": "watch", "agent_id": self.bot["id"], "owner_user": "david"}):
            self.assertTrue((await self.call("fd_start_task")).startswith("Not run: watch"))
        ctx = dataclasses.replace(self.ctx, session_id=None)
        self.assertTrue((await self.call("fd_route", ctx=ctx)).startswith("Not run: watch"))

    async def test_registry_hook_closes_legacy_aliases_and_unknown_watch_tools(self):
        self.ctx.turn_taint.mark("mail")
        for name in ("agent_assign", "hand_to_agent", "create_task"):
            self.assertIn("Up next", tools.guard_call(name, self.ctx))
        self.assertIsNone(tools.guard_call("fd_route", self.ctx))  # handler converts it to a suggestion
        session_manager.set_agent(self.sid, self.bot["id"], "watch", unattended=True)
        for spec in registry._REGISTRY.values():
            refused = tools.guard_call(spec.name, self.ctx)
            if spec.effect != registry.READ and spec.name not in {"fd_suggest", "fd_save_draft"}:
                self.assertTrue(refused and refused.startswith("Not run:"), spec.name)
        self.assertIsNotNone(tools.guard_call("unknown_tool", self.ctx))
        self.assertIsNone(tools.guard_call("fd_suggest", self.ctx))
        self.assertIsNone(tools.guard_call("fd_save_draft", self.ctx))
        self.assertIsNone(tools.guard_call("list_notes", self.ctx))

    async def test_unknown_forge_and_no_session_creation(self):
        with patch("services.forge_sessions.forge_sessions.create") as create:
            self.assertIn("Choose one existing Forge project", await self.call("fd_forge_propose", {"project": "missing", "task": "Fix"}))
            self.assertIn("Forge card is ready", await self.call("fd_forge_propose"))
            self.assertFalse(create.called)

    async def test_find_chat_owner_caps_preview_and_taint(self):
        for i in range(8):
            session = session_manager.create_session(f"Research {i}", owner_user="david")
            session_manager.append_message(session["id"], "assistant", "x" * 200)
        foreign = session_manager.create_session("Research private", owner_user="other")
        output = await self.call("fd_find_chat")
        self.assertIn("<<<UNTRUSTED-", output)
        self.assertTrue(self.ctx.turn_taint.tainted)
        payload = json.loads(output.splitlines()[2])
        self.assertEqual(len(payload), 5)
        self.assertTrue(all(len(hit["preview"]) == 120 for hit in payload))
        self.assertNotIn(foreign["id"], output)
        self.assertNotIn("private", output)

    async def test_roster_read_does_not_block_person_requested_routing(self):
        await self.call("fd_list_bots")
        await self.call("fd_forge_projects")
        self.assertFalse(self.ctx.turn_taint.tainted)
        self.assertIn("Assigned", await self.call("fd_route"))

    async def test_task_recursion_refused_and_send_ids_stable(self):
        from core import session_manager_store
        session = session_manager.get_session(self.sid)
        session["thread"]["opened_by"] = "task"
        session["agent_unattended"] = True
        session_manager_store.save_session(session)
        for name in ("fd_start_task", "fd_make"):
            self.assertIn(tools.TASK_FRAME, await self.call(name))
        self.assertFalse(self.start.called)
        self.assertIsNone(tools.guard_call("fd_route", self.ctx))
        self.assertIn("Assigned", await self.call("fd_route"))
        session["thread"]["opened_by"] = "person"
        session["agent_unattended"] = False
        session_manager_store.save_session(session)
        await self.call("fd_start_task")
        first = self.start.call_args.kwargs["send_id"]
        await self.call("fd_start_task")
        self.assertEqual(first, self.start.call_args.kwargs["send_id"])

    async def test_chips_once_per_turn_first_day_and_pending(self):
        result = await self.call("fd_chips")
        self.assertIn("on screen", result)
        await self.call("fd_chips", {"options": ["Changed"]})
        rows = session_manager.get_session(self.sid)["messages"]
        chips = [m for m in rows if m.get("fd_kind") == "chips"]
        self.assertEqual(len(chips), 1)
        self.assertEqual(chips[0]["fd_data"]["options"], ARGS["fd_chips"]["options"])
        with patch.object(permissions, "pending_for", return_value=[{"id": "pending"}]):
            self.assertIn("waiting card", await self.call("fd_chips"))
        with patch.dict(sys.modules, {"services.bot_cards": types.SimpleNamespace(store=lambda: types.SimpleNamespace(
                list_cards=lambda owner, **kw: [{"status": "pending"}]))}):
            self.assertIn("waiting card", await self.call("fd_chips"))
        from core import session_manager_store
        session = session_manager.get_session(self.sid)
        with patch.object(session_manager, "get_session", return_value={**session, "messages": []}):
            self.assertIn("first day", await self.call("fd_chips"))

    async def test_bounds_reject_extra_identity_and_large_lists(self):
        for name, args in [("fd_route", {**ARGS["fd_route"], "owner": "other"}),
                           ("fd_find_chat", {"query": " "}), ("fd_start_task", {"ask": "x" * 4001}),
                           ("fd_start_task", {"ask": " " * 4001 + "x"}),
                           ("fd_add_tasks", {"items": [{"title": "task"}] * 9}),
                           ("fd_chips", {"options": ["1", "2", "3", "4", "5"]})]:
            with self.subTest(tool=name):
                self.assertTrue((await self.call(name, args)).startswith("Tool error:"))
        self.assertFalse(self.start.called or self.suggestions.called)


if __name__ == "__main__":
    unittest.main()
