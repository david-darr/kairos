"""Bots redesign, Phase 3 unit U1: approval levels at each provider's door (2026-10-29).

Claude's pre-approval list and callbacks, the API-model brain, Codex's and Antigravity's refusal, Codex's
native approval requests, the desktop-only routes and the HTTP surface. Models are stand-ins; the broker,
bots and stores are real. Run: python scripts/test_bots_provider_approvals.py
"""
import json
import dataclasses
import os
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bots_approvals_harness import (ApprovalCase, agent_service, asyncio, bot_outbound, bot_policy, make_bot,  # noqa: E402
                                    make_thread, patch, permissions, session_manager, set_mode, tool_registry)

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_codex_transport, middleware  # noqa: E402
from core.brain import Brain  # noqa: E402
from core.codex_brain import CodexBrain  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from routes import bot_approval_routes, permission_routes  # noqa: E402

app = FastAPI()
app.include_router(permission_routes.router)
web = TestClient(app, client=("127.0.0.1", 50000))
SECRET = "desktop-secret-for-tests"


def context(use_id="use-1"):
    return types.SimpleNamespace(suggestions=[], title="x", description="", tool_use_id=use_id)


class Claude(ApprovalCase):
    def brain(self, bot, sid=None):
        return Brain(agent_id=bot, session_id=sid, is_admin=True)

    async def test_a_bots_changing_tools_are_never_pre_approved_so_the_sdk_cannot_skip_the_gate(self):
        bot = make_bot("Pre")
        _disabled, bot_allowed, _servers = self.brain(bot)._tool_config()
        _d, chat_allowed, _s = Brain(agent_id=None, session_id=None, is_admin=True)._tool_config()
        mutating = [t for t in chat_allowed if t.startswith("mcp__hive_mind__") and not tool_registry.read_tool(t)]
        self.assertTrue(mutating, "an ordinary chat pre-approves tools that change things")
        self.assertEqual([t for t in bot_allowed if t in mutating], [])
        self.assertTrue(all(tool_registry.read_tool(t) for t in bot_allowed))
        self.assertTrue(any(tool_registry.read_tool(t) for t in chat_allowed))

    async def test_can_use_tool_follows_the_level_and_passes_the_calls_identity(self):
        bot = make_bot("Callback")
        sid = make_thread(bot)
        brain = self.brain(bot, sid)
        allowed = await brain._permission("Bash", {"command": "ls"}, context())
        self.assertEqual(type(allowed).__name__, "PermissionResultAllow")
        set_mode(bot, "ask")
        permissions.open_channel(brain.surface)
        task = asyncio.create_task(brain._permission("Bash", {"command": "ls"}, context("use-2")))
        queue = permissions._channels[brain.surface]
        payload = await asyncio.wait_for(queue.get(), 5)
        permissions.answer(payload["id"], "reject", "local")
        self.assertEqual(type(await task).__name__, "PermissionResultDeny")

    async def test_a_hive_send_is_gated_and_its_allowance_settled_by_the_registry(self):
        bot = make_bot("Hook")
        agent_service.update(bot, outbound={"policy": "allow", "daily_cap": 1}, approval_mode="ask")
        sid = make_thread(bot)
        brain = self.brain(bot, sid)
        result = await brain._permission("mcp__hive_mind__send_email", {"to": "a"}, context("use-9"))
        self.assertEqual(type(result).__name__, "PermissionResultAllow")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 0)
        replies = iter(["Not sent: signed out", "Sent."])
        async def send(args, ctx):
            self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 1, "reserved before the send")
            return next(replies)
        ctx = tool_registry.ToolContext(agent_id=bot, session_id=sid, is_admin=True)
        with patch.dict(tool_registry._REGISTRY, {"send_email": dataclasses.replace(tool_registry._REGISTRY["send_email"], handler=send)}):
            self.assertEqual(await tool_registry.call("send_email", {"to": "a"}, ctx, tool_registry.CLAUDE), "Not sent: signed out")
            self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 0)
            self.assertEqual(await tool_registry.call("send_email", {"to": "a"}, ctx, tool_registry.CLAUDE), "Sent.")
        self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 1)

    async def test_the_grant_ceiling_is_asked_before_the_level_and_ordinary_chats_are_untouched(self):
        bot = make_bot("Ceil", tool_scope={"allow": [], "deny": ["native:Bash"]})
        sid = make_thread(bot)
        result = await self.brain(bot, sid)._permission("Bash", {"command": "ls"}, context())
        self.assertEqual(type(result).__name__, "PermissionResultDeny")
        chat = session_manager.create_session()
        session_manager.set_permission_mode(chat["id"], "auto")
        brain = Brain(agent_id=None, session_id=chat["id"], is_admin=True)
        self.assertEqual(type(await brain._permission("Bash", {"command": "ls"}, context())).__name__, "PermissionResultAllow")


class ApiModels(ApprovalCase):
    async def test_a_registry_call_goes_through_the_gate_and_the_handler_only_runs_when_allowed(self):
        bot = make_bot("Api")
        agent_service.update(bot, approval_mode="ask")
        sid = make_thread(bot)
        brain = ExternalBrain("http://x", "m", None, agent_id=bot, is_admin=True, session_id=sid)
        ran = []

        def handler(name):
            async def run(args, ctx):
                ran.append(name)
                return "done"
            return run
        with patch.dict(tool_registry._REGISTRY, {name: dataclasses.replace(tool_registry._REGISTRY[name], handler=handler(name))
                                                  for name in ("list_contacts", "agent_remember")}):
            self.assertEqual(await brain._call_registry("list_contacts", {}), "done", "reads go straight through")
            refused = await brain._call_registry("agent_remember", {"text": "x"})
            self.assertTrue(refused.startswith("Not run:"))
            self.assertEqual(ran, ["list_contacts"], "the handler never ran")
            set_mode(bot, "full")
            self.assertEqual(await brain._call_registry("agent_remember", {"text": "x"}), "done")

    async def test_an_allowance_unit_taken_by_an_api_call_is_settled_from_the_result(self):
        bot = make_bot("Api2")
        agent_service.update(bot, outbound={"policy": "allow", "daily_cap": 1}, approval_mode="ask")
        sid = make_thread(bot)
        brain = ExternalBrain("http://x", "m", None, agent_id=bot, is_admin=True, session_id=sid)
        replies = iter(["Not sent: no account", "Sent."])

        async def handler(args, ctx):
            return next(replies)
        with patch.dict(tool_registry._REGISTRY, {"send_email": dataclasses.replace(tool_registry._REGISTRY["send_email"], handler=handler)}):
            self.assertEqual(await brain._call_registry("send_email", {"to": "a"}), "Not sent: no account")
            self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 0)
            self.assertEqual(await brain._call_registry("send_email", {"to": "a"}), "Sent.")
            self.assertEqual(bot_outbound.usage("local", bot, 1)["used"], 1)


class Native(ApprovalCase):
    async def collect(self, brain):
        return [e async for e in brain.events("hello")]

    async def test_codex_below_full_is_refused_before_anything_runs_and_never_run_as_full(self):
        bot = make_bot("Codex")
        agent_service.update(bot, approval_mode="ask")
        sid = make_thread(bot)
        with patch.object(bot_policy, "provider_for", lambda *a, **k: "codex"):
            events = await self.collect(CodexBrain(agent_id=bot, session_id=sid, is_admin=True))
        text = "".join(e.data["text"] for e in events if e.kind.name == "TEXT")
        self.assertIn("cannot ask before it runs commands", text)
        self.assertIn("Full", text)
        self.assertEqual(events[-1].kind.name, "RESULT")

    async def test_antigravity_below_full_is_refused_and_names_itself(self):
        from core.antigravity_brain import AntigravityBrain
        bot = make_bot("Agy")
        agent_service.update(bot, approval_mode="edits")
        sid = make_thread(bot)
        events = await self.collect(AntigravityBrain(agent_id=bot, session_id=sid, is_admin=True))
        text = "".join(e.data["text"] for e in events if e.kind.name == "TEXT")
        self.assertIn("Antigravity", text)

    async def test_full_is_not_refused_and_a_read_and_draft_run_cannot_use_native_tools(self):
        bot = make_bot("Codex2")
        sid = make_thread(bot)
        self.assertIsNone(bot_policy.provider_refusal(bot, sid, "codex"))
        self.assertIsNone(bot_policy.provider_refusal(bot, sid, "claude"))
        self.with_run({"routine_id": "r", "run_id": "x", "bot_id": bot, "owner": "local", "access": "read-and-draft",
                       "unattended": True, "trigger": "schedule"})
        self.assertIn("read and draft", bot_policy.provider_refusal(bot, sid, "codex"))

    async def test_codex_runs_interactively_only_once_its_driver_is_ready(self):
        self.assertFalse(bot_codex_transport.available())
        ok, why = bot_policy.provider_support("codex", "ask")
        self.assertFalse(ok)
        with patch.object(bot_codex_transport, "DRIVER_READY", True):
            self.assertTrue(bot_policy.provider_support("codex", "ask")[0])
            self.assertTrue(bot_policy.provider_support("codex", "custom")[0])


class CodexApprovals(ApprovalCase):
    """Codex's own request for approval, answered by the real broker."""

    def request(self, method, **params):
        return {"jsonrpc": "2.0", "id": 7, "method": method,
                "params": {"threadId": "T", "turnId": "turn-1", "itemId": "item-1", "startedAtMs": 1, **params}}

    async def peer(self, bot, sid, **kw):
        sent = []

        async def write(text):
            sent.append(json.loads(text))
        bridge = bot_codex_transport.ApprovalBridge(bot_id=bot, session_id=sid, turn_id="turn-1", cwd=self.dir.name, **kw)
        return bot_codex_transport.Peer(bridge, write), sent

    async def test_a_command_request_asks_the_person_and_answers_codex_with_the_decision(self):
        bot = make_bot("CdxA")
        agent_service.update(bot, approval_mode="ask")
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        queue = permissions.open_channel(f"chat:{sid}")
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="make test", cwd=self.dir.name)))
        payload = await asyncio.wait_for(queue.get(), 5)
        self.assertEqual((payload["tool"], json.loads(payload["arguments"])["command"]), ("Bash", "make test"))
        permissions.answer(payload["id"], "once", "local")
        await peer.drain()
        self.assertEqual(sent[0]["result"], {"decision": "accept"})
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="rm -rf /")))
        payload = await asyncio.wait_for(queue.get(), 5)
        while "permission_closed" in payload:
            payload = await asyncio.wait_for(queue.get(), 5)
        permissions.answer(payload["id"], "reject", "local")
        await peer.drain()
        self.assertEqual(sent[1]["result"], {"decision": "decline"})

    async def test_a_file_change_request_follows_edits_and_full(self):
        from services.agent_service import AGENTS_DIR
        bot = make_bot("CdxB")
        agent_service.update(bot, approval_mode="edits")
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        await peer.feed(json.dumps(self.request(bot_codex_transport.FILE_CHANGE, grantRoot=os.path.join(AGENTS_DIR, bot))))
        await peer.drain()
        self.assertEqual(sent[0]["result"], {"decision": "accept"})

    async def test_full_accepts_without_asking(self):
        bot = make_bot("CdxC")
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="ls")))
        await peer.drain()
        self.assertEqual(sent[0]["result"], {"decision": "accept"})

    async def test_a_request_from_an_old_turn_or_a_closed_bridge_is_declined_without_asking(self):
        bot = make_bot("CdxD")
        agent_service.update(bot, approval_mode="ask")
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        stale = self.request(bot_codex_transport.COMMAND, command="ls")
        stale["params"]["turnId"] = "turn-0"
        await peer.feed(json.dumps(stale))
        await peer.drain()
        self.assertEqual(sent[0]["result"], {"decision": "decline"})
        peer.bridge.close()
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="ls")))
        await peer.drain()
        self.assertEqual(sent[1]["result"], {"decision": "cancel"})
        self.assertEqual(permissions._pending, {})

    async def test_a_downgrade_while_a_request_waits_cancels_it_and_codex_is_told_so(self):
        bot = make_bot("CdxE")
        agent_service.update(bot, approval_mode="edits")
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        queue = permissions.open_channel(f"chat:{sid}")
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="make")))
        await asyncio.wait_for(queue.get(), 5)
        with patch("services.chat_live.stop", lambda *a, **k: True):
            bot_policy.change_mode(bot, "ask", scope="bot")
        await peer.drain()
        self.assertEqual(sent[0]["result"]["decision"], "cancel", "the turn was stopped, so Codex is told to stop")

    async def test_the_grants_ceiling_still_refuses_and_unknown_methods_and_crashes_decline(self):
        bot = make_bot("CdxF", tool_scope={"allow": [], "deny": ["native:Bash"]})
        sid = make_thread(bot)
        peer, sent = await self.peer(bot, sid)
        await peer.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="ls")))
        await peer.feed(json.dumps(self.request("item/unknown/thing")))
        await peer.drain()
        by_id = {}
        for frame in sent:
            by_id.setdefault("result" if "result" in frame else "error", frame)
        self.assertEqual(by_id["result"]["result"], {"decision": "decline"})
        self.assertEqual(by_id["error"]["error"]["code"], bot_codex_transport.METHOD_NOT_FOUND)

        async def boom(**kw):
            raise RuntimeError("broker down")
        peer2, sent2 = await self.peer(bot, sid, decide=boom)
        await peer2.feed(json.dumps(self.request(bot_codex_transport.COMMAND, command="ls")))
        await peer2.drain()
        self.assertEqual(sent2[0]["result"], {"decision": "decline"}, "an error never accepts")

    async def test_notifications_are_passed_on_and_garbage_is_ignored(self):
        bot = make_bot("CdxG")
        peer, _ = await self.peer(bot, make_thread(bot))
        seen = []
        peer.on_notification = seen.append
        await peer.feed("not json")
        await peer.feed("[1]")
        await peer.feed(json.dumps({"jsonrpc": "2.0", "method": "turn/started", "params": {}}))
        self.assertEqual([m["method"] for m in seen], ["turn/started"])


class Routes(ApprovalCase):
    def setUp(self):
        super().setUp()
        self.secret = patch.object(bot_approval_routes, "DESKTOP_SECRET", SECRET)
        self.secret.start()
        self.bot = make_bot("Routes")
        self.sid = make_thread(self.bot)

    def tearDown(self):
        self.secret.stop()
        super().tearDown()

    def step(self, name, body, headers=None):
        return web.post(f"/api/internal/bots-approvals/{name}", json=body, headers=headers or {"X-Kairos-Desktop": SECRET})

    async def test_the_policy_view_names_levels_inheritance_and_the_revision(self):
        view = web.get(f"/api/bots-approvals/{self.bot}", params={"thread_id": self.sid}).json()
        self.assertEqual((view["mode"], view["inherited"], view["source"]), ("full", True, "bot"))
        self.assertEqual([item["mode"] for item in view["levels"]], ["ask", "edits", "auto", "full", "custom"])
        self.assertEqual(web.get("/api/bots-approvals/nope").status_code, 404)
        self.assertEqual(web.get(f"/api/bots-approvals/{self.bot}", params={"thread_id": "nope"}).status_code, 404)
        other = make_thread(make_bot("Other"))
        self.assertEqual(web.get(f"/api/bots-approvals/{self.bot}", params={"thread_id": other}).status_code, 404)

    async def test_lowering_works_over_http_and_raising_is_a_conflict_with_the_desktop_step_named(self):
        down = web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask", "scope": "bot"})
        self.assertEqual(down.status_code, 200, down.text)
        self.assertEqual(down.json()["mode"], "ask")
        up = web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "full", "scope": "bot"})
        self.assertEqual(up.status_code, 409)
        self.assertIn("desktop", up.json()["detail"])
        stale = web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask", "expected_revision": 99})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "bogus"}).status_code, 422)
        self.assertEqual(web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask", "extra": 1}).status_code, 422)
        self.assertEqual(web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask", "scope": "thread"}).status_code, 400)

    async def test_the_desktop_handshake_over_http_and_who_may_take_its_steps(self):
        web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask"})
        prepared = web.post(f"/api/bots-approvals/{self.bot}/elevate", json={"mode": "full"})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        body = {"request_id": prepared.json()["request_id"], "bot_id": self.bot, "mode": "full",
                "revision": prepared.json()["revision"]}
        # the page, a model's tool token, a wrong secret and a remote caller all fail
        self.assertEqual(web.post("/api/internal/bots-approvals/confirm", json=body).status_code, 404)
        self.assertEqual(self.step("confirm", body, {"X-Kairos-Desktop": "wrong"}).status_code, 404)
        self.assertEqual(self.step("confirm", body, {"X-Kairos-Desktop": SECRET, "X-JARVIS-Tool-Token": "t"}).status_code, 403)
        remote = TestClient(app, client=("10.1.1.1", 5))
        self.assertEqual(remote.post("/api/internal/bots-approvals/confirm", json=body,
                                     headers={"X-Kairos-Desktop": SECRET}).status_code, 403)
        self.assertEqual(self.step("commit", body).status_code, 400, "out of order")
        self.assertEqual(agent_service.get(self.bot)["approval_mode"], "ask")
        self.assertEqual(self.step("confirm", body).status_code, 200)
        self.assertEqual(self.step("activate", body).status_code, 200)
        done = self.step("commit", body)
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(agent_service.get(self.bot)["approval_mode"], "full")

    async def test_without_a_desktop_the_handshake_cannot_finish(self):
        with patch.object(bot_approval_routes, "DESKTOP_SECRET", None):
            self.assertEqual(self.step("confirm", {"request_id": "x"}, {"X-Kairos-Desktop": ""}).status_code, 404)

    async def test_revoke_drops_a_prepared_request(self):
        web.post(f"/api/bots-approvals/{self.bot}/mode", json={"mode": "ask"})
        prepared = web.post(f"/api/bots-approvals/{self.bot}/elevate", json={"mode": "edits"}).json()
        self.assertEqual(self.step("revoke", {"request_id": prepared["request_id"]}).json(), {"revoked": True})
        self.assertIsNone(bot_policy.elevation_phase(prepared["request_id"]))

    async def test_commands_are_only_remembered_for_a_live_request_of_that_bot(self):
        agent_service.update(self.bot, approval_mode="ask")
        cwd = os.path.abspath(self.dir.name)
        self.assertEqual(web.post(f"/api/bots-approvals/{self.bot}/commands", json={"request_id": "none"}).status_code, 404)
        task, payload = await self.asked(f"chat:{self.sid}", tool="Bash", arguments={"command": "make", "cwd": cwd},
                                         agent_id=self.bot, is_admin=True)
        other = make_bot("Rules other")
        self.assertEqual(web.post(f"/api/bots-approvals/{other}/commands", json={"request_id": payload["id"]}).status_code, 404)
        made = web.post(f"/api/bots-approvals/{self.bot}/commands", json={"request_id": payload["id"]})
        self.assertEqual(made.status_code, 200, made.text)
        rule = made.json()["rule"]
        listed = web.get(f"/api/bots-approvals/{self.bot}/commands").json()
        self.assertEqual([r["id"] for r in listed["rules"]], [rule["id"]])
        self.assertEqual(web.delete(f"/api/bots-approvals/{self.bot}/commands/{rule['id']}").status_code, 200)
        self.assertEqual(web.delete(f"/api/bots-approvals/{self.bot}/commands/{rule['id']}").status_code, 404)
        permissions.answer(payload["id"], "reject", "local")
        await task

    async def test_outbound_view_reports_policy_cap_used_and_reset(self):
        agent_service.update(self.bot, outbound={"policy": "allow", "daily_cap": 3}, approval_mode="ask")
        await self.decide(self.bot, self.sid, "send_email", {"to": "a"}, bot_context={"invocation_id": "o1"})
        view = web.get(f"/api/bots-approvals/{self.bot}/outbound").json()
        self.assertEqual((view["policy"], view["cap"], view["used"], view["remaining"]), ("allow", 3, 1, 2))
        self.assertGreater(view["resets_at"], 0)

    async def test_history_is_bounded_filtered_and_exports_csv(self):
        await self.decide(self.bot, self.sid, "Bash", {"command": "ls"})
        rows = web.get("/api/bot-decisions", params={"bot_id": self.bot}).json()
        self.assertEqual(rows["retention_days"], 180)
        self.assertEqual(rows["decisions"][0]["tool"], "Bash")
        self.assertEqual(web.get("/api/bot-decisions", params={"limit": 5000}).status_code, 422)
        csv = web.get("/api/bot-decisions.csv", params={"bot_id": self.bot})
        self.assertTrue(csv.headers["content-type"].startswith("text/csv"))
        self.assertTrue(csv.text.startswith("at,bot_id"))

    async def test_a_bots_answered_card_settles_through_the_permission_route(self):
        cards = self.fake_cards()
        agent_service.update(self.bot, approval_mode="ask")
        task, payload = await self.asked(f"chat:{self.sid}", tool="Bash", arguments={"command": "ls"},
                                         agent_id=self.bot, is_admin=True)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            answered = await client.post(f"/api/permissions/{payload['id']}/answer", json={"choice": "once"})
        self.assertEqual(answered.status_code, 200, answered.text)
        self.assertEqual((await task).behavior, "allow")
        self.assertIn((payload["id"], "allowed"), [(r, s) for r, s, _ in cards.settled])


if __name__ == "__main__":
    unittest.main(verbosity=1)
