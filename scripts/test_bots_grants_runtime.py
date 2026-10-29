"""Bots redesign, Phase 2 unit U4: grants enforced at every provider's door (2026-10-29).

Drives the real broker, registry dispatch, the MCP bridge, the Codex token routes and Claude's hook and
permission callbacks. Models and servers are stand-ins. Run: python scripts/test_bots_grants_runtime.py
"""
import asyncio
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-grants-rt-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import (bot_tool_catalog as catalog, brain as brain_module, integrations, mcp_bridge, mcp_client,  # noqa: E402
                  permissions, settings, tool_access, tool_registry)
from core.brain import Brain  # noqa: E402
from core.codex_brain import CodexBrain  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from routes import tool_routes  # noqa: E402
from services import bot_grants  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(tool_routes.router)
local = TestClient(app, client=("127.0.0.1", 50000))

TOOLS = [{"name": "list_issues", "description": "List issues in a repository.", "schema": {"type": "object", "properties": {}}},
         {"name": "create_issue", "description": "Create an issue in a repository.", "schema": {"type": "object", "properties": {}}}]


def run(coro):
    return asyncio.run(coro)


def server(name="github"):
    item = integrations.create_mcp_server(name, "http", url=f"https://{name}.example/mcp")
    integrations.record_check(item["id"], tools=TOOLS)
    bot_grants.reset_cache()
    return item["id"]


def discovered(name="github"):
    """What mcp_client.discover returns for a server, keyed by function name."""
    config = {"type": "http", "url": f"https://{name}.example/mcp"}
    return {mcp_client.function_name(name, t["name"], set()): {"server": name, "config": config, **t} for t in TOOLS}


def make_bot(name, **extra):
    bot = agent_service.create(name, **extra)["id"]
    bot_grants.reset_cache()
    return bot


def ctx_for(bot, **extra):
    return tool_registry.ToolContext(session_id=None, is_admin=True, turn_taint=TurnTaint(), agent_id=bot, owner_user="local", **extra)


class Base(unittest.TestCase):
    def setUp(self):
        for item in integrations.list_integrations():
            integrations.delete_integration(item["id"])
        settings.update_settings(disabled_tools=[])
        bot_grants.reset_cache()


class Registry(Base):
    def test_tool_context_carries_an_invocation_id(self):
        self.assertIsNone(tool_registry.ToolContext().invocation_id)
        self.assertEqual(tool_registry.ToolContext(invocation_id="i1").invocation_id, "i1")

    def test_dispatch_refuses_a_denied_tool_and_leaves_other_chats_alone(self):
        bot = make_bot("Rt A", tool_scope={"allow": [], "deny": ["native:list_contacts"]})
        refused = run(tool_registry.dispatch("list_contacts", {}, ctx_for(bot), tool_registry.OPENAI))
        self.assertTrue(refused.startswith("Not allowed:"), refused)
        ordinary = tool_registry.ToolContext(session_id=None, is_admin=True, turn_taint=TurnTaint())
        self.assertFalse(str(run(tool_registry.dispatch("list_contacts", {}, ordinary, tool_registry.OPENAI))).startswith("Not allowed"))

    def test_revocation_applies_to_the_very_next_call(self):
        bot = make_bot("Rt B")
        context = ctx_for(bot)
        self.assertFalse(str(run(tool_registry.call("list_contacts", {}, context, tool_registry.CLAUDE))).startswith("Not allowed"))
        agent_service.update(bot, tool_scope={"allow": [], "deny": ["native:list_contacts"]})
        self.assertTrue(str(run(tool_registry.call("list_contacts", {}, context, tool_registry.CLAUDE))).startswith("Not allowed"))

    def test_tool_lists_leave_out_what_a_bot_may_not_use(self):
        bot = make_bot("Rt C", tool_scope={"allow": [], "deny": ["native:list_contacts"]})
        names = lambda tools: {t["function"]["name"] for t in tools}
        self.assertNotIn("list_contacts", names(tool_registry.openai_tools(True, agent=True, bot_id=bot)))
        self.assertIn("list_contacts", names(tool_registry.openai_tools(True, agent=True)))
        self.assertNotIn("mcp__hive_mind__list_contacts", tool_registry.claude_preapproved(agent=True, bot_id=bot))
        self.assertNotIn("list_contacts", tool_registry.deferred_tools(True, agent=True, bot_id=bot))

    def test_narrowing_list_hides_everything_else(self):
        bot = make_bot("Rt D", tool_scope={"allow": ["native:list_contacts"], "deny": []})
        shown = {t["function"]["name"] for t in tool_registry.openai_tools(True, agent=True, bot_id=bot)}
        self.assertIn("list_contacts", shown)
        self.assertNotIn("create_note", shown)
        self.assertIn("ask_user", shown, "the baseline stays")

    def test_a_missing_bot_fails_closed(self):
        refused = run(tool_registry.call("list_contacts", {}, ctx_for("ghost"), tool_registry.OPENAI))
        self.assertTrue(refused.startswith("Not allowed:"))


class Broker(Base):
    def test_ceiling_comes_before_auto_and_full(self):
        bot = make_bot("Br A", approval_mode="full", tool_scope={"allow": [], "deny": ["native:Bash"]})
        decision = run(permissions.decide(surface=f"agent:{bot}", tool="Bash", arguments={"command": "dir"}, is_admin=True))
        self.assertEqual(decision.behavior, "deny")
        self.assertIn("Access settings", decision.reason)
        allowed = run(permissions.decide(surface=f"agent:{bot}", tool="Read", arguments={"path": "x"}, is_admin=True))
        self.assertEqual(allowed.behavior, "allow", "Auto still answers what the ceiling allows")

    def test_a_chat_surface_resolves_its_bot_through_the_session(self):
        bot = make_bot("Br B", tool_scope={"allow": [], "deny": ["native:Bash"]})
        from core.session_manager import session_manager
        session = session_manager.create_session()
        session_manager.set_agent(session["id"], bot, "")
        decision = run(permissions.decide(surface=f"chat:{session['id']}", tool="Bash", arguments={"command": "dir"}, is_admin=True))
        self.assertEqual(decision.behavior, "deny")

    def test_non_bot_surfaces_are_untouched(self):
        decision = run(permissions.decide(surface="none", tool="Bash", arguments={"command": "dir"}, is_admin=True))
        self.assertNotIn("Access settings", decision.reason)

    def test_the_denial_is_audited(self):
        bot = make_bot("Br C", tool_scope={"allow": [], "deny": ["native:Bash"]})
        run(permissions.decide(surface=f"agent:{bot}", tool="Bash", arguments={}, is_admin=True))
        self.assertTrue(any(row.get("source") == "grant_ceiling" for row in permissions.audit()))


class Bridge(Base):
    def call(self, bot, function, args=None, found=None, decide=None):
        found = found or discovered()
        spec = found[function]
        patches = [patch.object(mcp_client, "call_tool", AsyncMock(return_value="done")),
                   patch.object(mcp_bridge.mcp_oauth, "refresh_due", AsyncMock())]
        if decide:
            patches.append(patch.object(permissions, "decide", decide))
        for p in patches:
            p.start()
        try:
            with patch.object(integrations, "list_mcp_servers_runtime", lambda ids=None: {spec["server"]: spec["config"]}):
                return run(mcp_bridge.call_tool(function, args or {}, spec, None, ctx_for(bot)))
        finally:
            for p in patches:
                p.stop()

    def test_allowed_and_denied_calls(self):
        sid = server()
        bot = make_bot("Bridge A", connector_scopes={sid: "read"})
        self.assertEqual(self.call(bot, "mcp__github__list_issues"), "done")
        refused = self.call(bot, "mcp__github__create_issue")
        self.assertTrue(refused.startswith("Not allowed:"), refused)

    def test_discovery_is_filtered_by_the_same_verdict(self):
        sid = server()
        bot = make_bot("Bridge B", connector_scopes={sid: "read"})
        with patch.object(mcp_bridge, "_discover", AsyncMock(return_value=(discovered(), None))):
            shown, _ = run(mcp_bridge.discover(None, ctx_for(bot)))
            everything, _ = run(mcp_bridge.discover(None))
        self.assertEqual(set(shown), {"mcp__github__list_issues"})
        self.assertEqual(len(everything), 2)

    def test_a_grant_revoked_while_the_person_decides(self):
        sid = server()
        bot = make_bot("Bridge C", connector_scopes={sid: "write"})

        async def decide(**kwargs):
            agent_service.update(bot, connector_scopes={sid: "off"})
            return permissions.Decision("allow", "ok")
        refused = self.call(bot, "mcp__github__create_issue", decide=decide)
        self.assertTrue(refused.startswith("Not allowed:"), refused)

    def test_the_broker_is_not_asked_when_the_ceiling_forbids(self):
        sid = server()
        bot = make_bot("Bridge D", connector_scopes={sid: "off"})
        asked = AsyncMock(return_value=permissions.Decision("allow", "ok"))
        refused = self.call(bot, "mcp__github__list_issues", decide=asked)
        self.assertTrue(refused.startswith("Not allowed:"))
        asked.assert_not_called()

    def test_two_servers_with_one_name_are_ambiguous_and_refused(self):
        server("twin")
        server("twin")
        bot = make_bot("Bridge E")
        refused = self.call(bot, "mcp__twin__list_issues", found=discovered("twin"))
        self.assertTrue(refused.startswith("Not allowed:"))

    def test_other_chats_have_no_grants(self):
        server()
        spec = discovered()["mcp__github__create_issue"]
        self.assertIsNone(bot_grants.mcp_refusal(tool_registry.ToolContext(), spec, "x", {}))


class Tokens(Base):
    def headers(self, bot, lifetime=None):
        token = (tool_access.issue_proxy(None, True, bot, None, None, lifetime) if lifetime else
                 tool_access.issue(None, True, bot, None))
        self.addCleanup(tool_access.revoke, token)
        return {"X-JARVIS-Tool-Token": token}, token

    def test_native_tool_routes_enforce_grants(self):
        bot = make_bot("Tok A", tool_scope={"allow": [], "deny": ["native:list_contacts"]})
        headers, _ = self.headers(bot)
        answer = local.post("/api/tools/list_contacts", json={"arguments": {}}, headers=headers).json()
        self.assertTrue(answer["result"].startswith("Not allowed:"))

    def test_search_and_describe_do_not_leak_blocked_tools(self):
        sid = server()
        bot = make_bot("Tok B", connector_scopes={sid: "read"})
        headers, token = self.headers(bot)
        with patch.object(mcp_bridge, "_discover", AsyncMock(return_value=(discovered(), None))):
            found = local.post("/api/tools/kairos_tool_search", json={"arguments": {"query": "issues"}}, headers=headers).json()["result"]
            self.assertIn("list_issues", found)
            self.assertNotIn("create_issue", found)
            described = local.post("/api/tools/kairos_tool_describe", json={"arguments": {"name": "mcp__github__create_issue"}}, headers=headers).json()["result"]
            self.assertIn("not available", described)
            called = local.post("/api/tools/kairos_tool_call", json={"arguments": {"name": "mcp__github__create_issue", "arguments": {}}}, headers=headers).json()["result"]
            self.assertIn("not available", called)
            # Revoking removes a tool that was already listed and cached for this turn.
            agent_service.update(bot, connector_scopes={sid: "off"})
            after = local.post("/api/tools/kairos_tool_search", json={"arguments": {"query": "issues"}}, headers=headers).json()["result"]
            self.assertNotIn("list_issues", after)

    def test_expired_and_unknown_tokens(self):
        self.assertEqual(local.post("/api/tools/_mcp/list", headers={"X-JARVIS-Tool-Token": "nope"}).status_code, 403)
        bot = make_bot("Tok C")
        headers, token = self.headers(bot)
        tool_access.revoke(token)
        self.assertEqual(local.post("/api/tools/_mcp/list", headers=headers).status_code, 403)
        self.assertEqual(local.post("/api/tools/_mcp/renew", headers=headers).status_code, 403)
        outside = TestClient(app, client=("10.0.0.5", 1))
        fresh, _ = self.headers(bot)
        self.assertEqual(outside.post("/api/tools/_mcp/list", headers=fresh).status_code, 403)

    def test_proxy_list_call_and_renew(self):
        sid = server()
        bot = make_bot("Tok D", connector_scopes={sid: "read"})
        headers, token = self.headers(bot, lifetime=300)
        with patch.object(mcp_bridge, "_discover", AsyncMock(return_value=(discovered(), None))), \
                patch.object(mcp_client, "call_tool", AsyncMock(return_value="ten issues")), \
                patch.object(mcp_bridge.mcp_oauth, "refresh_due", AsyncMock()), \
                patch.object(integrations, "list_mcp_servers_runtime", lambda ids=None: {"github": discovered()["mcp__github__list_issues"]["config"]}):
            listed = local.post("/api/tools/_mcp/list", headers=headers).json()
            self.assertEqual([t["name"] for t in listed["tools"]], ["github__list_issues"])
            self.assertLessEqual(listed["expires_in"], 300)
            ok = local.post("/api/tools/_mcp/call", json={"name": "github__list_issues", "arguments": {}}, headers=headers).json()
            self.assertEqual(ok["result"], "ten issues")
            blocked = local.post("/api/tools/_mcp/call", json={"name": "github__create_issue", "arguments": {}}, headers=headers).json()
            self.assertIn("not available", blocked["result"])
            renewed = local.post("/api/tools/_mcp/renew", headers=headers).json()
            self.addCleanup(tool_access.revoke, renewed["token"])
            self.assertNotEqual(renewed["token"], token)
            self.assertIsNotNone(tool_access.resolve(renewed["token"]))
            agent_service.update(bot, connector_scopes={sid: "off"})
            after = local.post("/api/tools/_mcp/list", headers={"X-JARVIS-Tool-Token": renewed["token"]}).json()
            self.assertEqual(after["tools"], [])

    def test_a_token_without_a_bot_cannot_use_the_proxy(self):
        token = tool_access.issue(None, True, None, None)
        self.addCleanup(tool_access.revoke, token)
        self.assertEqual(local.post("/api/tools/_mcp/list", headers={"X-JARVIS-Tool-Token": token}).status_code, 403)


class ClaudeProvider(Base):
    def brain(self, bot):
        return Brain(agent_id=bot, session_id=None, is_admin=True)

    def test_pre_approved_calls_are_judged_by_the_hook(self):
        bot = make_bot("Cl A", tool_scope={"allow": [], "deny": ["native:list_contacts", "native:Bash"]})
        brain = self.brain(bot)
        hook = lambda name: run(brain._hook_before_tool({"tool_name": name, "tool_input": {}}, "id", None))
        denied = hook("mcp__hive_mind__list_contacts")
        self.assertEqual(denied["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(hook("Bash")["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(hook("search_sessions"), {})
        self.assertEqual(hook("mcp__claude_ai_Canva__export-design")["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertEqual(hook("mcp__kairos_apps__github__list_issues"), {})

    def test_other_chats_are_not_judged(self):
        brain = Brain(agent_id=None, session_id=None, is_admin=True)
        self.assertEqual(run(brain._hook_before_tool({"tool_name": "mcp__claude_ai_Canva__export-design", "tool_input": {}}, "id", None)), {})

    def test_can_use_tool_refuses_before_asking(self):
        bot = make_bot("Cl B", tool_scope={"allow": [], "deny": ["native:Bash"]})
        brain = self.brain(bot)
        context = types.SimpleNamespace(suggestions=[], title="Bash", description="")
        with patch.object(permissions, "decide", AsyncMock(side_effect=AssertionError("must not ask"))):
            result = run(brain._permission("Bash", {"command": "dir"}, context))
        self.assertEqual(type(result).__name__, "PermissionResultDeny")

    def test_proxy_calls_pass_can_use_tool_because_the_bridge_asks(self):
        sid = server()
        bot = make_bot("Cl C", connector_scopes={sid: "read"})
        brain = self.brain(bot)
        context = types.SimpleNamespace(suggestions=[], title="x", description="")
        result = run(brain._permission("mcp__kairos_apps__github__list_issues", {}, context))
        self.assertEqual(type(result).__name__, "PermissionResultAllow")

    def test_a_bots_apps_reach_claude_only_through_the_proxy(self):
        sid = server()
        bot = make_bot("Cl D", tool_scope={"allow": [], "deny": ["native:Bash"]})
        brain = self.brain(bot)
        disabled, allowed, servers = brain._tool_config()
        self.assertEqual(list(servers), [catalog.PROXY_SERVER])
        self.assertNotIn("env", servers[catalog.PROXY_SERVER], "no token in the fingerprinted config")
        self.assertIn("Bash", disabled)
        self.assertFalse(any(name.startswith("mcp__claude_ai_Canva") for name in allowed))
        self.assertEqual(brain._fingerprint(*brain._tool_config()), brain._fingerprint(*brain._tool_config()))
        options = brain._options()
        proxy = options.mcp_servers[catalog.PROXY_SERVER]
        self.assertIn("JARVIS_TOOL_TOKEN", proxy["env"])
        self.assertNotIn(integrations._load()[sid]["url"], str(proxy))
        self.assertTrue(options.strict_mcp_config)
        self.assertIsNotNone(tool_access.resolve(proxy["env"]["JARVIS_TOOL_TOKEN"]))
        token = proxy["env"]["JARVIS_TOOL_TOKEN"]
        run(brain.disconnect())
        self.assertIsNone(tool_access.resolve(token), "the capability dies with the connection")

    def test_a_grant_change_changes_the_fingerprint_so_the_chat_reconnects(self):
        bot = make_bot("Cl E")
        brain = self.brain(bot)
        before = brain._fingerprint(*brain._tool_config())
        agent_service.update(bot, tool_scope={"allow": [], "deny": ["native:Bash"]})
        self.assertNotEqual(before, brain._fingerprint(*brain._tool_config()))

    def test_ordinary_chats_keep_their_direct_servers_and_baseline(self):
        server()
        disabled, allowed, servers = Brain(agent_id=None, session_id=None, is_admin=True)._tool_config()
        self.assertIn("github", servers)
        self.assertIn("mcp__claude_ai_Canva__export-design", allowed)


class OtherProviders(Base):
    def test_codex_refuses_a_native_limit_it_cannot_hold(self):
        bot = make_bot("Co A", tool_scope={"allow": [], "deny": ["native:Bash"]})

        async def collect():
            return [e async for e in CodexBrain(agent_id=bot, session_id=None, is_admin=True).events("hello")]
        events = run(collect())
        text = "".join(e.data["text"] for e in events if e.kind.name == "TEXT")
        self.assertIn("Claude or API model", text)
        self.assertEqual(events[-1].kind.name, "RESULT")

    def test_antigravity_names_itself(self):
        from core.antigravity_brain import AntigravityBrain
        bot = make_bot("Co B", tool_scope={"allow": [], "deny": ["native:Read"]})

        async def collect():
            return [e async for e in AntigravityBrain(agent_id=bot, session_id=None, is_admin=True).events("hello")]
        text = "".join(e.data["text"] for e in run(collect()) if e.kind.name == "TEXT")
        self.assertIn("Antigravity", text)

    def test_external_brain_lists_and_calls_only_what_is_granted(self):
        sid = server()
        bot = make_bot("Ex A", connector_scopes={sid: "read"}, tool_scope={"allow": [], "deny": ["native:list_contacts"]})
        with patch.object(mcp_bridge, "_discover", AsyncMock(return_value=(discovered(), None))):
            brain = ExternalBrain("http://x", "m", None, agent_id=bot, is_admin=True, session_id="s")
            run(brain.connect())
        self.assertEqual(set(brain._mcp_tools), {"mcp__github__list_issues"})
        self.assertNotIn("list_contacts", {t["function"]["name"] for t in brain.tools if t.get("type") == "function"})
        self.assertTrue(run(brain._run_tool("list_contacts", {})).startswith("Not allowed:"))


class GuardedRegistration(Base):
    def tearDown(self):
        for name in ("skill_stage", "skill_read", "skill_index", "skill_share", "schedule_routine", "manage_routine"):
            tool_registry._REGISTRY.pop(name, None)
        for module in ("services.bot_skills", "core.bot_automation_tools"):
            sys.modules.pop(module, None)

    def test_nothing_registers_without_the_modules(self):
        sys.modules["services.bot_skills"] = None   # an import raises ImportError
        sys.modules["core.bot_automation_tools"] = None
        self.assertEqual(tool_registry.register_resource_tools(), {"skills": [], "automation": []})

    def test_skill_tools_call_the_skill_service_with_a_trusted_scope(self):
        calls = []
        fake = types.ModuleType("services.bot_skills")
        fake.stage = lambda scope, name, md, **o: calls.append(("stage", scope, name, o)) or {"name": name, "id": "r1", "sha_prefix": "abc"}
        fake.read_reviewed = lambda scope, name, relative="SKILL.md", taint=None: f"text of {name}/{relative}"
        fake.prompt_index = lambda scope, taint=None: ""
        fake.share = lambda scope, name, **o: {"status": "pending"}
        sys.modules["services.bot_skills"] = fake
        sys.modules["core.bot_automation_tools"] = None
        self.assertEqual(sorted(tool_registry.register_skill_tools()), ["skill_index", "skill_read", "skill_share", "skill_stage"])
        self.assertEqual(tool_registry.register_skill_tools(), [], "safe twice")
        bot = make_bot("Reg A")
        context = tool_registry.ToolContext(session_id="chat-1", is_admin=True, turn_taint=TurnTaint(), agent_id=bot, owner_user="local")
        out = run(tool_registry.call("skill_stage", {"skill_name": "tidy-desk", "skill_md": "x", "agent_id": "someone-else"}, context, tool_registry.OPENAI))
        self.assertIn("Staged skill tidy-desk", out)
        kind, scope, name, options = calls[0]
        self.assertEqual((scope["agent_id"], scope["owner_user"]), (bot, "local"), "identity comes from the context, not arguments")
        self.assertEqual(options["actor"], "model")
        self.assertEqual(run(tool_registry.call("skill_read", {"name": "tidy-desk"}, context, tool_registry.OPENAI)), "text of tidy-desk/SKILL.md")
        self.assertIn("switched on", run(tool_registry.call("skill_index", {}, context, tool_registry.OPENAI)))
        self.assertIn("approve", run(tool_registry.call("skill_share", {"name": "tidy-desk"}, context, tool_registry.OPENAI)))
        self.assertEqual(run(tool_registry.call("skill_stage", {"skill_name": "a", "skill_md": "b"}, tool_registry.ToolContext(session_id="c"), tool_registry.OPENAI)),
                         "Unknown tool: skill_stage", "bots only")
        # Granting is still the ceiling: a bot that may not use it cannot stage.
        agent_service.update(bot, tool_scope={"allow": [], "deny": ["native:skill_stage"]})
        self.assertTrue(run(tool_registry.call("skill_stage", {"skill_name": "a", "skill_md": "b"}, context, tool_registry.OPENAI)).startswith("Not allowed"))

    def test_automation_tools_register_through_their_own_call(self):
        fake = types.ModuleType("core.bot_automation_tools")

        def register_tools():
            tool_registry.register("schedule_routine", "x", tool_registry._object(), agent_only=True, effect="write")(AsyncMock(return_value="ok"))
            return ["schedule_routine"]
        fake.register_tools = register_tools
        sys.modules["core.bot_automation_tools"] = fake
        sys.modules["services.bot_skills"] = None
        self.assertEqual(tool_registry.register_resource_tools()["automation"], ["schedule_routine"])
        self.assertIn("schedule_routine", tool_registry._REGISTRY)


if __name__ == "__main__":
    unittest.main()
