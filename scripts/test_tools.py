"""One tool registry for every model (roadmap phase 2; spec: the vault note
"Tool Registry - Phase 2 (Build Spec)"). What these prove:

- every surface's tool list comes from core/tool_registry.py: Claude's MCP
  server and pre-approvals, the local/API function list, Codex's command
  line and the tools its prompt lists;
- Codex's calls go through POST /api/tools/{name} with the turn's own token,
  which works only from this computer, only for its own chat, only during
  its turn; who is asking is never taken from the request;
- a Codex tool call meets the person's hooks, and what changes is audited;
- the command line parses every flag shape and posts to the address given.
"""
import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix='tools-test-')
environment = Path(fixture.name)
os.environ["JARVIS_DATA_DIR"] = str(environment)

import httpx  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import addons
for ident in addons.IDS: addons.change(ident, "install")
from core import permissions, system_prompt, tool_access, tool_registry, tool_search  # noqa: E402
from core.codex_brain import CodexBrain  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import tool_routes  # noqa: E402
from services.hook_service import hook_service  # noqa: E402
from services.notes_service import notes_service  # noqa: E402

CLI_PATH = Path(__file__).resolve().parents[1] / "mcp_servers" / "hive_mind_cli.py"
# Claude's pre-approved JARVIS tools on 2026-10-05, when core/brain.py still
# listed them by hand, plus the explicitly reviewed additions below.
CLAUDE_APPROVED_BEFORE = {f"mcp__hive_mind__{name}" for name in (
    "search_sessions list_skills search_skills read_skill list_notes list_tasks list_upcoming_events list_specs "
    "list_tab_tasks read_tab_task complete_tab_task "
    "read_spec list_documents read_document list_contacts list_task_runs create_note update_note delete_note "
    "create_task update_task delete_task create_event update_event delete_event save_generated_image run_code "
    "browse save_generated_file google_drive google_sheets google_forms google_calendar agent_remember agent_ask "
    # Reviewed 2026-10-23: send_email asks through the broker itself, like google_*.
    "list_email_accounts send_email "
    # Helpers (roadmap phase 5, 2026-10-06): delegate and collect.
    "delegate helper_results computer "
    # Agent mentions (2026-10-08): hand work to a named agent from a chat.
    "hand_to_agent save_skill add_mcp_server forge_app_logs "
    # Reviewed 2026-10-15: own-topic reads (decb912); peer-scoped, capped
    # assignments and requester-owned question answers (5421f76).
    "agent_read_topic agent_assign agent_answer_assignment roblox_studio creative_tools roblox_style roblox_assets ui_design "
    # The Design canvas (2026-10-22): writes to Kairos's own design store, audited;
    # design_system_save still asks through the broker itself.
    "design_create design_outline design_read design_add_board design_edit design_boards design_tokens "
    "design_snapshot design_comments design_export design_system_save").split()}


def load_cli():
    import importlib.util
    spec = importlib.util.spec_from_file_location("hive_mind_cli_under_test", CLI_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def names(specs):
    return [s.name for s in specs]


class SurfaceTests(unittest.TestCase):
    def test_every_surface_lists_from_the_registry(self):
        local = ExternalBrain("http://fake", "m", None, is_admin=False).tools
        self.assertEqual([t["function"]["name"] for t in local], names(tool_registry.specs(tool_registry.OPENAI)))
        for admin, agent in ((False, False), (True, True)):
            prompt = system_prompt.for_codex("py", "cli.py", is_admin=admin, agent=agent)
            offered = names(tool_registry.specs(tool_registry.CODEX, admin, agent))
            for spec in tool_registry.specs(tool_registry.CODEX, True, True):
                self.assertEqual(f"\n  {spec.name}" in prompt, spec.name in offered, (spec.name, admin, agent))
        cli = load_cli()
        commands = cli.parser()._subparsers._group_actions[0].choices
        self.assertEqual(list(commands), names(tool_registry.specs(tool_registry.CODEX, True, True))
                         + [s["function"]["name"] for s in tool_search.bridge_schemas()])

    def test_codex_gets_claudes_tools_but_neither_file_tools_nor_the_sandbox(self):
        codex = set(names(tool_registry.specs(tool_registry.CODEX, True, True)))
        for name in ("run_shell", "read_vault_file", "write_repo_file", "run_code", "browse"):
            self.assertNotIn(name, codex)
        for name in ("create_note", "save_generated_file", "agent_remember", "google_drive", "search_sessions"):
            self.assertIn(name, codex)

    def test_claudes_pre_approvals_are_exactly_the_old_list(self):
        self.assertEqual(set(tool_registry.claude_preapproved(agent=True)), CLAUDE_APPROVED_BEFORE)
        self.assertNotIn("mcp__hive_mind__agent_ask", tool_registry.claude_preapproved(agent=False))
        for name in ("agent_configure_self", "agent_setup_undo"):
            self.assertNotIn(f"mcp__hive_mind__{name}", tool_registry.claude_preapproved(agent=True))

    def test_every_tool_says_what_it_does(self):
        for spec in tool_registry.specs(tool_registry.OPENAI, True, True) + tool_registry.specs(tool_registry.CLAUDE, True, True):
            self.assertIn(spec.effect, (tool_registry.READ, tool_registry.WRITE, tool_registry.EXEC, tool_registry.EXTERNAL))
            if spec.name.startswith(("list_", "read_", "search_")):
                self.assertEqual(spec.effect, tool_registry.READ, spec.name)
            if spec.name.startswith(("create_", "update_", "delete_")):
                self.assertEqual(spec.effect, tool_registry.WRITE, spec.name)


class RouteTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(tool_routes.router)
        self.local = TestClient(app, client=("127.0.0.1", 50000))
        self.remote = TestClient(app, client=("100.64.0.7", 50000))
        self.sid = session_manager.create_session("tools")["id"]
        self.other = session_manager.create_session("other chat")["id"]
        session_manager.append_message(self.other, "user", "the falcon codeword is umber")
        session_manager.append_message(self.sid, "user", f"the falcon codeword is umber, said in {self.sid}")
        for hook in hook_service.hooks():
            hook_service.delete(hook["id"])

    def call(self, token, name, client=None, **arguments):
        return (client or self.local).post(f"/api/tools/{name}", json={"arguments": arguments},
                                           headers={"X-JARVIS-Tool-Token": token})

    def test_a_turns_token_works_for_its_own_chat_only(self):
        token = tool_access.issue(self.sid, is_admin=False)
        found = self.call(token, "search_sessions", query="falcon codeword").json()["result"]
        self.assertIn("other chat", found)
        self.assertNotIn(f"said in {self.sid}", found, "its own chat is the one excluded, decided by the token")

    def test_a_forged_expired_revoked_or_remote_token_is_refused(self):
        token = tool_access.issue(self.sid, is_admin=True)
        self.assertEqual(self.call("made-up", "list_notes").status_code, 403)
        self.assertEqual(self.call(token, "list_notes", client=self.remote).status_code, 403)
        with patch("core.tool_access.time.time", return_value=time.time() + tool_access.TOKEN_LIFETIME_SECONDS + 1):
            self.assertEqual(self.call(token, "list_notes").status_code, 403)
        tool_access.revoke(token)
        self.assertEqual(self.call(token, "list_notes").status_code, 403)

    def test_admin_and_agent_come_from_the_token_never_the_request(self):
        plain = tool_access.issue(self.sid, is_admin=False)
        self.assertEqual(self.call(plain, "google_drive", action="list").json()["result"], "Unknown tool: google_drive")
        self.assertEqual(self.call(plain, "agent_remember", section="Notes", text="x").json()["result"],
                         "Unknown tool: agent_remember")
        response = self.local.post("/api/tools/google_drive", json={"arguments": {"action": "list"}, "is_admin": True},
                                   headers={"X-JARVIS-Tool-Token": plain})
        self.assertEqual(response.json()["result"], "Unknown tool: google_drive", "a claim in the body changes nothing")

    def test_a_hook_blocks_a_codex_tool_and_changes_are_audited(self):
        token = tool_access.issue(self.sid, is_admin=False, model="codex-model")
        before = len(notes_service.list_notes())
        script = environment / "block.py"
        script.write_text("import json, sys\njson.load(sys.stdin)\nsys.stderr.write('no notes from codex')\nsys.exit(2)\n")
        hook = hook_service.create("Guard", event="tool.before", action="command", tool_pattern="create_note",
                                   config={"command": f'"{sys.executable}" "{script}"'})
        blocked = self.call(token, "create_note", text="blocked one").json()["result"]
        if any("WinError 5" in entry.get("detail", "") for entry in hook_service.get(hook["id"])["log"]):
            self.skipTest("this sandbox cannot start the hook subprocess")
        self.assertEqual(blocked, "Not run: blocked by a hook: no notes from codex")
        self.assertEqual(len(notes_service.list_notes()), before)
        hook_service.delete(hook["id"])

        made = self.call(token, "create_note", text="from codex").json()["result"]
        self.assertTrue(made.startswith("Created note "), made)
        entry = permissions.audit()[-1]
        self.assertEqual((entry["decision"], entry["tool"], entry["effect"]), ("tool used", "create_note", "write"))
        self.assertEqual(entry["by"], f"codex chat:{self.sid}")
        audited = len(permissions.audit())
        self.call(token, "list_notes")
        self.assertEqual(len(permissions.audit()), audited, "a read is not audited")
        listed = self.call(token, "list_notes").json()["result"]
        note_id = made.split()[2].rstrip(":")
        self.assertIn(f"[{note_id}]", listed, "update and delete need the id, so the list shows it")

    def test_a_codex_file_comes_only_from_its_own_workspace(self):
        token = tool_access.issue(self.sid, is_admin=False)
        outside = environment / "secret.txt"
        outside.write_text("x")
        result = self.call(token, "save_generated_file", path=str(outside), description="x").json()["result"]
        self.assertTrue(result.startswith("Couldn't save that file"), result)

    def test_the_old_internal_token_is_gone(self):
        import core.auth
        import core.middleware
        self.assertFalse(hasattr(core.auth, "INTERNAL_TOOL_TOKEN"))
        self.assertFalse(hasattr(core.middleware, "_INTERNAL_TOOL_ROUTES"))


class SmallWindowTests(unittest.IsolatedAsyncioTestCase):
    """A small window shows only the core tools; the rest are found through
    the bridge and run exactly as before (2026-10-06, vault note "Local
    Model Fit (Build Spec)")."""
    CORE = {"ask_user", "search_sessions", "search_vault", "read_vault_file", "list_notes", "create_note", "update_note",
            "list_tasks", "list_tab_tasks", "read_tab_task", "complete_tab_task", "list_upcoming_events", "search_skills", "read_skill", "ui_design"}
    BRIDGE = {"kairos_tool_search", "kairos_tool_describe", "kairos_tool_call"}

    def brain(self, window, **kw):
        return ExternalBrain("http://fake", "m", None, session_id=self.sid, window=window, **kw)

    async def asyncSetUp(self):
        self.sid = session_manager.create_session("small window")["id"]
        for hook in hook_service.hooks():
            hook_service.delete(hook["id"])

    async def test_a_small_window_shows_the_core_tools_and_the_bridge(self):
        shown = lambda b: {t["function"]["name"] for t in b.tools}
        self.assertEqual(shown(self.brain(8192, is_admin=True)), self.CORE | self.BRIDGE)
        self.assertEqual(shown(self.brain(tool_registry.SMALL_WINDOW, is_admin=True)), self.CORE | self.BRIDGE)
        self.assertIn("agent_remember", shown(self.brain(8192, agent_id="a1")), "an agent keeps its own tools")
        for big in (None, tool_registry.SMALL_WINDOW + 1, 200000):
            full = self.brain(big, is_admin=True)
            # Less the Design canvas's editing tools, listed once a design is linked (design_gate).
            self.assertEqual(shown(full), {s.name for s in tool_registry.specs(tool_registry.OPENAI, True, session_id=self.sid)
                                           if tool_registry.design_gate(s, self.sid)}, big)
            self.assertNotIn("kairos_tool_search", shown(full))
            self.assertNotIn("only your most-used tools are listed", full._messages[0]["content"])
        small = self.brain(8192, is_admin=True)
        self.assertIn("only your most-used tools are listed", small._messages[0]["content"],
                      "a small window is told the rest are searchable")

    async def test_a_hidden_tool_is_found_and_runs_with_hooks_and_audit(self):
        brain = self.brain(8192)
        found = await brain._execute_tool("kairos_tool_search", {"query": "create task"})
        self.assertIn('"create_task"', found)
        described = json.loads(await brain._execute_tool("kairos_tool_describe", {"name": "create_task"}))
        self.assertIn("schedule_kind", described["parameters"]["properties"])
        made = await brain._execute_tool("kairos_tool_call", {"name": "create_task", "arguments": {
            "name": "Water the plants", "prompt": "remind me", "schedule_kind": "card"}})
        self.assertTrue(made.startswith("Created task "), made)
        self.assertEqual((permissions.audit()[-1]["tool"], permissions.audit()[-1]["decision"]), ("create_task", "tool used"))
        script = environment / "block_tasks.py"
        script.write_text("import json, sys\njson.load(sys.stdin)\nsys.stderr.write('no new tasks')\nsys.exit(2)\n")
        hook = hook_service.create("No tasks", event="tool.before", action="command", tool_pattern="create_task",
                                   config={"command": f'"{sys.executable}" "{script}"'})
        blocked = await brain._execute_tool("kairos_tool_call", {"name": "create_task", "arguments": {
            "name": "x", "prompt": "y", "schedule_kind": "card"}})
        if any("WinError 5" in entry.get("detail", "") for entry in hook_service.get(hook["id"])["log"]):
            self.skipTest("this sandbox cannot start the hook subprocess")
        self.assertEqual(blocked, "Not run: blocked by a hook: no new tasks", "hooks see the real tool behind the bridge")
        self.assertFalse(brain.turn_taint.tainted, "JARVIS's own tool list is not untrusted text")

    async def test_the_names_from_before_the_rename_still_run(self):
        # Chats from before the Kairos rename show the model calling
        # jarvis_tool_*; it may call them again (2026-10-15).
        brain = self.brain(8192)
        self.assertNotIn("jarvis_tool_search", {t["function"]["name"] for t in brain.tools})
        self.assertIn('"create_task"', await brain._execute_tool("jarvis_tool_search", {"query": "create task"}))
        made = await brain._execute_tool("jarvis_tool_call", {"name": "create_task", "arguments": {
            "name": "Old name", "prompt": "still works", "schedule_kind": "card"}})
        self.assertTrue(made.startswith("Created task "), made)

    async def test_the_list_never_changes_within_a_chat(self):
        brain = self.brain(8192)
        before = json.dumps(brain.tools)
        await brain._execute_tool("kairos_tool_search", {"query": "calendar"})
        await brain.connect()
        self.assertEqual(json.dumps(brain.tools), before, "the cached prompt stays the same")
        mcp = {"github__create_issue": {"server": "github", "name": "create_issue", "description": "Open an issue",
                                        "schema": {"type": "object"}, "config": {}}}
        with patch("core.integrations.list_mcp_servers_runtime", return_value={"github": {}}), \
             patch("core.mcp_client.discover", new=AsyncMock(return_value=mcp)):
            with_mcp = self.brain(8192)
            await with_mcp.connect()
        listed = [t["function"]["name"] for t in with_mcp.tools]
        self.assertEqual(listed.count("kairos_tool_search"), 1, "one bridge serves both")
        found = await with_mcp._execute_tool("kairos_tool_search", {"query": "create issue"})
        self.assertIn("github__create_issue", found)
        self.assertTrue(with_mcp.turn_taint.tainted, "a third-party tool's description is still untrusted")

    def test_the_chat_tells_the_brain_its_window(self):
        from services import chat_service
        local = {"id": "loc", "name": "Local", "kind": "local", "model": "m"}
        with patch("core.model_endpoints.resolve_runtime", return_value=("http://x", "m", None, 8192)):
            self.assertTrue(chat_service._build_brain(local, self.sid).small_window)
        with patch("core.model_endpoints.resolve_runtime", return_value=("http://x", "m", None, 16384)):
            self.assertTrue(chat_service._build_brain(local, self.sid).small_window)
        api = {"id": "api", "name": "API", "kind": "api", "model": "gpt-x"}
        with patch("core.model_endpoints.resolve_runtime", return_value=("http://x", "gpt-x", None, None)):
            with patch("core.model_catalog.context_capacity", return_value={"window": 400000, "effective": 380000}):
                self.assertFalse(chat_service._build_brain(api, self.sid).small_window)
            with patch("core.model_catalog.context_capacity", return_value=None):
                self.assertFalse(chat_service._build_brain(api, self.sid).small_window, "an unknown window keeps them all")

    def test_new_local_connections_default_to_16k_and_saved_ones_keep_theirs(self):
        from core import model_endpoints
        made = model_endpoints.create_endpoint("New local", base_url="http://localhost:11434", model="m", kind="local")
        self.assertEqual(made["num_ctx"], 16384)
        kept = model_endpoints.create_endpoint("Old local", base_url="http://localhost:11434", model="m", kind="local",
                                               num_ctx=4096)
        self.assertEqual(model_endpoints.get_endpoint(kept["id"])["num_ctx"], 4096)


class CliTests(unittest.TestCase):
    def test_unicode_output_survives_a_legacy_windows_code_page(self):
        child = (
            'import sys\n'
            'from mcp_servers import hive_mind_cli as cli\n'
            'assert sys.stdout.encoding.lower() == "cp1252"\n'
            'cli.call = lambda *args: "\\u2713 \\u2192"\n'
            'sys.argv = ["hive_mind_cli.py", "list_specs"]\n'
            'cli.main()\n'
        )
        result = subprocess.run([sys.executable, "-c", child], cwd=CLI_PATH.parent.parent,
                                env={**os.environ, "PYTHONIOENCODING": "cp1252"},
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertEqual(result.stdout.decode("utf-8").replace("\r\n", "\n"), "\u2713 \u2192\n")

        failure = child.replace('cli.call = lambda *args: "\\u2713 \\u2192"',
                                'cli.call = lambda *args: (_ for _ in ()).throw(RuntimeError("\\u2715"))')
        result = subprocess.run([sys.executable, "-c", failure], cwd=CLI_PATH.parent.parent,
                                env={**os.environ, "PYTHONIOENCODING": "cp1252"},
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.decode("utf-8").replace("\r\n", "\n"), "Error: \u2715\n")

    def test_every_flag_shape(self):
        cli = load_cli()
        parsed = cli.parser().parse_args(["create_task", "--name", "n", "--prompt", "p", "--schedule_kind", "card",
                                          "--depends_on", "a, b", "--interval_seconds", "60"])
        spec = next(s for s in tool_registry.specs(tool_registry.CODEX, True, True) if s.name == "create_task")
        self.assertEqual(cli.arguments(spec, parsed), {"name": "n", "prompt": "p", "schedule_kind": "card",
                                                       "depends_on": ["a", "b"], "interval_seconds": 60})
        parsed = cli.parser().parse_args(["search_sessions", "--query", "q", "--this_chat"])
        spec = next(s for s in tool_registry.specs(tool_registry.CODEX) if s.name == "search_sessions")
        self.assertEqual(cli.arguments(spec, parsed), {"query": "q", "this_chat": True}, "a flag alone means true")
        parsed = cli.parser().parse_args(["google_sheets", "--action", "update", "--values", "[[1, 2]]",
                                          "--args_json", '{"title": "T"}'])
        spec = next(s for s in tool_registry.specs(tool_registry.CODEX, True) if s.name == "google_sheets")
        self.assertEqual(cli.arguments(spec, parsed), {"action": "update", "values": [[1, 2]], "title": "T"})

    def test_json_file_arguments_preserve_multiline_luau_without_shell_escaping(self):
        cli = load_cli()
        path = environment / 'studio args.json'
        code = 'print("a quoted value")\nlocal value = [[line one\nline two]]\nreturn value'
        path.write_text(json.dumps({'datamodel_type':'Edit','code':code}),encoding='utf-8-sig')
        parsed = cli.parser().parse_args(['roblox_studio','--action','call','--name','execute_luau','--arguments_file',str(path)])
        spec = next(s for s in tool_registry.specs(tool_registry.CODEX,True) if s.name == 'roblox_studio')
        self.assertEqual(cli.arguments(spec,parsed)['arguments']['code'],code)
        path.write_text('[]',encoding='utf-8')
        with self.assertRaises(ValueError): cli.arguments(spec,parsed)

    def test_it_posts_to_the_address_it_was_given_with_its_token(self):
        cli = load_cli()
        seen = {}
        response = httpx.Response(200, json={"result": "Created note n1: x"}, request=httpx.Request("POST", "http://x"))

        def post(url, json, headers, timeout):
            seen.update(url=url, body=json, headers=headers)
            return response
        with patch.dict(os.environ, {"JARVIS_API_BASE": "http://127.0.0.1:8431/api", "JARVIS_TOOL_TOKEN": "turn-token"}), \
             patch.object(cli.httpx, "post", side_effect=post):
            self.assertEqual(cli.call("create_note", {"text": "x"}), "Created note n1: x")
        self.assertEqual(seen["url"], "http://127.0.0.1:8431/api/tools/create_note")
        self.assertEqual(seen["headers"], {"X-JARVIS-Tool-Token": "turn-token"})
        self.assertEqual(seen["body"], {"arguments": {"text": "x"}})

    def test_it_refuses_without_an_address_or_token(self):
        cli = load_cli()
        env = {k: v for k, v in os.environ.items() if k not in ("JARVIS_API_BASE", "JARVIS_TOOL_TOKEN")}
        with patch.dict(os.environ, env, clear=True), patch.object(cli.httpx, "post") as post:
            with self.assertRaises(RuntimeError):
                cli.call("list_notes", {})
        post.assert_not_called()


class CodexTurnTests(unittest.TestCase):
    def test_each_turn_gets_its_own_token_and_loses_it_after(self):
        sid = session_manager.create_session("codex")["id"]
        seen = {}

        class FakeProc:
            pid = 0
            returncode = 0

            def __init__(self):
                self.stdin = type("In", (), {"write": lambda _, data: None, "write_eof": lambda _: None})()
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'{"type":"turn.failed","error":{"message":"stop here"}}\n')
                self.stdout.feed_eof()
                self.stderr = asyncio.StreamReader()
                self.stderr.feed_eof()

            async def wait(self):
                return 0

        async def fake_exec(*args, **kwargs):
            seen.update(kwargs["env"])
            seen["grant"] = tool_access.resolve(kwargs["env"]["JARVIS_TOOL_TOKEN"])
            return FakeProc()

        async def run():
            with (patch("core.codex_brain.asyncio.create_subprocess_exec", new=fake_exec),
                  patch.object(CodexBrain, "_codex_path", return_value="codex"),
                  patch("core.codex_brain._kill_process_tree", new=AsyncMock(return_value=True))):
                with self.assertRaises(RuntimeError):
                    _ = [c async for c in CodexBrain(session_id=sid, agent_id="a1", integration_ids=["github"]).run_turn_stream("hi")]
        with patch.dict(os.environ, {"JARVIS_INTERNAL_TOKEN": "leftover"}):
            asyncio.run(run())
        grant = seen["grant"]
        self.assertEqual((grant.session_id, grant.is_admin, grant.agent_id), (sid, False, "a1"))
        self.assertIsNone(tool_access.resolve(seen["JARVIS_TOOL_TOKEN"]), "revoked when the turn ends")
        self.assertEqual(grant.integration_ids, ("github",))
        self.assertNotIn("JARVIS_CODEX_SESSION_ID", seen)
        self.assertNotIn("JARVIS_GOOGLE_CHAT_TOKEN", seen)


class CodexMCPTests(unittest.TestCase):
    """Backend-only integration access for Codex (2026-10-15)."""
    def setUp(self):
        app = FastAPI()
        app.include_router(tool_routes.router)
        self.client = TestClient(app, client=("127.0.0.1", 50000))
        self.sid = session_manager.create_session("codex MCP")["id"]
        self.config = {"type": "http", "url": "http://fake/github"}
        self.servers = {"github": self.config, "other": {"type": "http", "url": "http://fake/other"},
                        "REA": {"type": "stdio", "command": "never-run"}}
        self.tool = "mcp__github__create_issue"
        self.schema = {"type": "object", "properties": {"title": {"type": "string"}}}
        self.tokens = []
        self.runtime = self.enterContext(patch("core.integrations.list_mcp_servers_runtime",
            side_effect=lambda ids: {k: v for k, v in self.servers.items() if ids is None or k in ids}))
        self.refresh = self.enterContext(patch("core.mcp_oauth.refresh_due", new=AsyncMock()))

        async def discover(servers):
            return {f"mcp__{name}__create_issue": {"server": name, "name": "create_issue", "config": config,
                    "description": "Create an issue", "schema": self.schema} for name, config in servers.items()}
        self.discovery = self.enterContext(patch("core.mcp_client.discover", new=AsyncMock(side_effect=discover)))
        self.mcp_call = self.enterContext(patch("core.mcp_client.call_tool", new=AsyncMock(return_value="issue created")))
        self.decision = self.enterContext(patch("core.permissions.decide", new=AsyncMock(
            return_value=permissions.Decision("allow", "allowed"))))
        for hook in hook_service.hooks():
            hook_service.delete(hook["id"])

    def tearDown(self):
        for token in self.tokens:
            tool_access.revoke(token)

    def token(self, **kwargs):
        token = tool_access.issue(self.sid, False, integration_ids=["github", "REA"], **kwargs)
        self.tokens.append(token)
        return token

    def call(self, token, command, **arguments):
        return self.client.post(f"/api/tools/kairos_tool_{command}", json={"arguments": arguments},
                                headers={"X-JARVIS-Tool-Token": token})

    def result(self, token, command, **arguments):
        response = self.call(token, command, **arguments)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["result"]

    def test_search_describe_call_scope_permissions_hooks_and_cache(self):
        token = self.token()
        found = json.loads(self.result(token, "search", query="github issue"))
        self.assertEqual([t["name"] for t in found], [self.tool])
        grant = tool_access.resolve(token)
        self.assertTrue(grant.turn_taint.tainted)
        described = json.loads(self.result(token, "describe", name=self.tool))
        self.assertEqual(described["parameters"], self.schema)
        self.assertEqual(self.result(token, "call", name=self.tool, arguments={"title": "test"}), "issue created")
        self.decision.assert_awaited_once()
        self.assertEqual(self.decision.call_args.kwargs["surface"], f"chat:{self.sid}")
        self.assertEqual(self.decision.call_args.kwargs["tool"], self.tool)
        self.mcp_call.assert_awaited_once_with(self.config, "create_issue", {"title": "test"})
        self.assertIn(f"MCP result: {self.tool}", grant.turn_taint.sources)
        self.discovery.assert_awaited_once()
        self.assertNotIn("REA", self.discovery.call_args.args[0])
        self.assertEqual(self.result(token, "search", query="other"), "No matching tools.")
        self.assertIn("not available", self.result(token, "describe", name="mcp__other__create_issue"))
        self.assertIn("not available", self.result(token, "call", name="mcp__other__create_issue", arguments={}))
        self.assertIn("must be an object", self.result(token, "call", name=self.tool, arguments=[]))
        self.decision.return_value = permissions.Decision("deny", "person said no")
        self.assertEqual(self.result(token, "call", name=self.tool, arguments={}), "Not run: person said no")
        self.assertEqual(self.mcp_call.await_count, 1)
        seen = {}
        async def around(name, args, run, **ctx):
            seen.update(name=name, args=args, **ctx)
            return "Not run: blocked by a hook: test"
        with patch.object(hook_service, "around_tool", new=around):
            self.assertIn("blocked by a hook", self.result(token, "call", name=self.tool, arguments={"title": "hook"}))
        self.assertEqual((seen["name"], seen["args"], seen["session_id"]), (self.tool, {"title": "hook"}, self.sid))
        self.assertEqual(self.mcp_call.await_count, 1)
        tool_access.revoke(token)
        self.assertEqual(grant.mcp_catalog, {})

    def test_disabled_replaced_and_disabled_while_permission_pending(self):
        token = self.token()
        self.result(token, "search", query="github")
        self.servers.pop("github")
        self.assertIn("no longer enabled", self.result(token, "call", name=self.tool, arguments={}))
        self.decision.assert_not_awaited()
        self.servers["github"] = {**self.config, "url": "http://fake/replaced"}
        self.assertIn("no longer enabled", self.result(token, "call", name=self.tool, arguments={}))
        self.servers["github"] = self.config
        async def disable(**kwargs):
            self.servers.pop("github")
            return permissions.Decision("allow", "allowed")
        self.decision.side_effect = disable
        self.assertIn("no longer enabled", self.result(token, "call", name=self.tool, arguments={}))
        self.mcp_call.assert_not_awaited()

    def test_expired_and_revoked_tokens_cannot_use_any_bridge_command(self):
        token = self.token()
        self.result(token, "search", query="github")
        grant = tool_access.resolve(token)
        with patch("core.tool_access.time.time", return_value=time.time() + tool_access.TOKEN_LIFETIME_SECONDS + 1):
            for command in ("search", "describe", "call"):
                self.assertEqual(self.call(token, command, name=self.tool, query="github", arguments={}).status_code, 403)
        self.assertEqual(grant.mcp_catalog, {})
        token = self.token()
        tool_access.revoke(token)
        for command in ("search", "describe", "call"):
            self.assertEqual(self.call(token, command, name=self.tool, arguments={}).status_code, 403)

    def test_revocation_while_permission_pending_prevents_execution(self):
        token = self.token()
        async def revoke(**kwargs):
            tool_access.revoke(token)
            return permissions.Decision("allow", "allowed")
        self.decision.side_effect = revoke
        self.assertIn("expired", self.result(token, "call", name=self.tool, arguments={}))
        self.mcp_call.assert_not_awaited()

    def test_external_brain_uses_the_same_checks_and_error_text(self):
        async def run():
            brain = ExternalBrain("http://fake", "m", None, session_id=self.sid, integration_ids=["github"])
            await brain.connect()
            self.assertIn(self.tool, brain._mcp_tools)
            result = await brain._execute_tool(tool_search.CALL, {"name": self.tool, "arguments": {"title": "external"}})
            self.assertEqual(result, "issue created")
            self.assertIn(f"MCP result: {self.tool}", brain.turn_taint.sources)
            self.mcp_call.side_effect = RuntimeError("offline")
            self.assertEqual(await brain._call_mcp(self.tool, {}), "Tool error: offline")
            self.decision.return_value = permissions.Decision("deny", "person said no")
            self.assertEqual(await brain._call_mcp(self.tool, {}), "Not run: person said no")
            self.servers.pop("github")
            self.assertIn("no longer enabled", await brain._call_mcp(self.tool, {}))
        asyncio.run(run())

    def test_each_turn_discovers_its_own_catalog_and_uses_refreshed_headers(self):
        first = self.token()
        self.result(first, "search", query="github")
        self.servers["github"] = {**self.config, "headers": {"Authorization": "Bearer refreshed"}}
        self.assertEqual(self.result(first, "call", name=self.tool, arguments={}), "issue created")
        self.assertEqual(self.mcp_call.call_args.args[0]["headers"], {"Authorization": "Bearer refreshed"})
        second = self.token()
        self.result(second, "search", query="github")
        self.assertEqual(self.discovery.await_count, 2)

    def test_rea_and_read_only_are_refused(self):
        token = self.token()
        self.assertEqual(self.result(token, "search", query="REA"), "No matching tools.")
        self.assertEqual(self.result(token, "call", name="mcp__REA__investigate", arguments={}),
                         "Not run: REA is not available in Codex chats.")
        readonly = self.token(read_only=True)
        self.assertEqual(self.result(readonly, "call", name=self.tool, arguments={}),
                         "Not run: Forge Plan mode is read-only.")
        with patch("core.tool_registry.session_read_only", return_value=True):
            self.assertIn("read-only", self.result(token, "call", name=self.tool, arguments={}))
        self.decision.assert_not_awaited()
        self.mcp_call.assert_not_awaited()

    def test_prompt_addendum_is_conditional_and_cli_posts_nested_arguments(self):
        old = (system_prompt._codex_core("py", "cli.py") + system_prompt.UI_DESIGN_DISCIPLINE + system_prompt.DESIGN_CANVAS_LINE + system_prompt._computer_addendum(False, True))
        with patch("core.integrations.list_mcp_servers_runtime", return_value={}):
            self.assertEqual(system_prompt.for_codex("py", "cli.py"), old)
        self.assertEqual(system_prompt.for_codex("py", "cli.py", integration_ids=[]), old)
        prompt = system_prompt.for_codex("py", "cli.py", integration_ids=["github"])
        self.assertEqual(system_prompt.for_codex("py", "cli.py"), prompt)
        self.assertIn('& "py" "cli.py" kairos_tool_search --query', prompt)
        self.assertIn('kairos_tool_describe --name', prompt)
        self.assertIn('kairos_tool_call --name', prompt)
        cli = load_cli()
        for argv, expected in [(["kairos_tool_search", "--query", "issue", "--limit", "3"], {"query": "issue", "limit": 3}),
                               (["kairos_tool_describe", "--name", self.tool], {"name": self.tool}),
                               (["kairos_tool_call", "--name", self.tool, "--args_json", '{"title":"x"}'],
                                {"name": self.tool, "arguments": {"title": "x"}})]:
            with patch.object(sys, "argv", ["cli.py"] + argv), patch.object(cli, "call", return_value="ok") as call, patch("builtins.print"):
                cli.main()
            call.assert_called_once_with(argv[0], expected)


def tearDownModule():
    # Release the session store so the temp data folder can be removed;
    # Windows will not delete a database that is still open.
    from core import session_manager_store
    session_manager_store.close()
    fixture.cleanup()


if __name__ == "__main__":
    unittest.main()
