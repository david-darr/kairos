"""Bots Phase 2, unit U5: the MCP editor contract, probes, OAuth guards, held results and setup import (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 4.5 and 7 (U5).
Throwaway data folder, stand-in servers. Nothing is started and nothing leaves this computer.
Run: python scripts/test_bots_mcp_config.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-mcp-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_tool_results, integrations, mcp_client, mcp_oauth  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import bot_connections_routes  # noqa: E402
from services import bot_mcp_config, bot_setup_import  # noqa: E402
from services.bot_mcp_config import McpConfigError  # noqa: E402

app = FastAPI()
app.include_router(bot_connections_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)

SECRET = "sk-live-0123456789abcdef"


def clear():
    for item in integrations.list_integrations():
        integrations.delete_integration(item["id"])


def run(coroutine):
    return asyncio.run(coroutine)


class Editor(unittest.TestCase):
    def setUp(self):
        clear()

    def test_remote_local_and_sse_servers_validate_into_fields(self):
        remote = bot_mcp_config.clean({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp", "headers": {"X-Api-Key": SECRET}})
        self.assertEqual((remote["mcp_type"], remote["url"], remote["http_kind"]), ("http", "https://mcp.acme.test/mcp", "http"))
        sse = bot_mcp_config.clean({"name": "feed", "transport": "sse", "url": "https://mcp.acme.test/sse"})
        self.assertEqual(sse["http_kind"], "sse")
        local = bot_mcp_config.clean({"name": "tool", "transport": "stdio", "command": "npx", "args": ["-y", "pkg"], "env": {"TOKEN": SECRET}})
        self.assertEqual((local["mcp_type"], local["command"], local["args"]), ("stdio", "npx", ["-y", "pkg"]))
        loopback = bot_mcp_config.clean({"name": "dev", "transport": "http", "url": "http://127.0.0.1:9000/mcp"})
        self.assertEqual(loopback["url"], "http://127.0.0.1:9000/mcp")

    def test_refusals(self):
        bad = [
            ({"name": "Bad Name", "transport": "http", "url": "https://x.test"}, "name"),
            ({"name": "9lives", "transport": "http", "url": "https://x.test"}, "name"),
            ({"name": "x" * 33, "transport": "http", "url": "https://x.test"}, "name"),
            ({"name": "a", "transport": "http", "url": "http://remote.test/mcp"}, "https"),
            ({"name": "a", "transport": "http", "url": "https://user:pw@remote.test/mcp"}, "sign-in details"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "command": "npx"}, "no command"),
            ({"name": "a", "transport": "stdio", "command": "npx", "url": "https://x.test"}, "no address"),
            ({"name": "a", "transport": "stdio", "command": "npx\nrm -rf /"}, "one line"),
            ({"name": "a", "transport": "stdio", "command": "npx", "env": {"PATH": "/evil"}}, "cannot be set"),
            ({"name": "a", "transport": "stdio", "command": "npx", "env": {"NODE_OPTIONS": "--require x"}}, "cannot be set"),
            ({"name": "a", "transport": "stdio", "command": "npx", "env": {"bad name": "v"}}, "not valid"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "headers": {"Host": "evil"}}, "cannot be set"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "headers": {"X": "a\r\nInjected: 1"}}, "one line"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "call_timeout_minutes": 0}, "1 to 60"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "call_timeout_minutes": 61}, "1 to 60"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "result_budget": 2_000_001}, "0 to 2,000,000"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "result_budget": -1}, "0 to 2,000,000"),
            ({"name": "a", "transport": "http", "url": "https://x.test", "surprise": 1}, "Unknown fields"),
            ({"name": "a", "transport": "ftp", "url": "https://x.test"}, "Choose"),
        ]
        for body, word in bad:
            with self.assertRaises(McpConfigError, msg=str(body)) as raised:
                bot_mcp_config.clean(body)
            self.assertIn(word, str(raised.exception), str(body))

    def test_secret_slots_are_write_only_and_keep_replace_remove_work(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp",
                                    "headers": {"X-Api-Key": SECRET, "X-Team": "red"}, "call_timeout_minutes": 5, "result_budget": 4000})
        self.assertEqual((made["header_names"], made["call_timeout_minutes"], made["result_budget"]), (["X-Api-Key", "X-Team"], 5, 4000))
        self.assertNotIn(SECRET, json.dumps(made))
        self.assertNotIn(SECRET, (Path(_DATA.name) / "integrations.json").read_text(encoding="utf-8"), "stored encrypted")
        runtime = integrations.list_mcp_servers_runtime()["acme"]
        self.assertEqual(runtime["headers"], {"X-Api-Key": SECRET, "X-Team": "red"})
        # Keep one, replace one, add none: the marker true keeps the saved value.
        saved = bot_mcp_config.save({"name": "acme", "headers": {"X-Api-Key": True, "X-Team": "blue"}}, made["id"])
        self.assertEqual(integrations.list_mcp_servers_runtime()["acme"]["headers"], {"X-Api-Key": SECRET, "X-Team": "blue"})
        self.assertEqual(saved["header_names"], ["X-Api-Key", "X-Team"])
        # A name left out is removed.
        bot_mcp_config.save({"name": "acme", "headers": {"X-Api-Key": True}}, made["id"])
        self.assertEqual(integrations.list_mcp_servers_runtime()["acme"]["headers"], {"X-Api-Key": SECRET})
        # An edit that does not mention headers keeps them all.
        bot_mcp_config.save({"name": "acme", "result_budget": 0}, made["id"])
        self.assertEqual(integrations.list_mcp_servers_runtime()["acme"]["headers"], {"X-Api-Key": SECRET})
        # A keep marker for a name that has no saved value is refused.
        with self.assertRaises(McpConfigError):
            bot_mcp_config.save({"name": "acme", "headers": {"Never-Saved": True}}, made["id"])

    def test_a_key_in_the_address_is_refused_and_a_stream_server_gets_a_stream_transport(self):
        for url in ("https://x.test/mcp?api_key=abc", "https://x.test/mcp?token=abc", "https://x.test/mcp?Signature=1"):
            with self.assertRaises(McpConfigError, msg=url) as raised:
                bot_mcp_config.clean({"name": "a", "transport": "http", "url": url})
            self.assertIn("header", str(raised.exception))
        self.assertEqual(bot_mcp_config.clean({"name": "a", "transport": "http", "url": "https://x.test/mcp?page=2"})["url"], "https://x.test/mcp?page=2")
        made = bot_mcp_config.save({"name": "feed", "transport": "sse", "url": "https://x.test/sse", "headers": {"X-Key": SECRET}})
        self.assertEqual(made["http_kind"], "sse")
        config = integrations.list_mcp_servers_runtime()["feed"]
        self.assertEqual((config["type"], config["headers"]), ("sse", {"X-Key": SECRET}))
        target = mcp_client._target(config)
        self.assertEqual(type(target).__name__, "_AsyncGeneratorContextManager", "the SSE client is chosen for a stream server")

    def test_the_name_is_locked_on_edit_and_unique_on_add(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})
        with self.assertRaises(McpConfigError):
            bot_mcp_config.save({"name": "renamed"}, made["id"])
        with self.assertRaises(McpConfigError) as dup:
            bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://other.test/mcp"})
        self.assertEqual(dup.exception.status, 409)

    def test_twenty_servers_at_most(self):
        for n in range(20):
            bot_mcp_config.save({"name": f"s{n}", "transport": "http", "url": f"https://s{n}.test/mcp"})
        with self.assertRaises(McpConfigError) as over:
            bot_mcp_config.save({"name": "one-more", "transport": "http", "url": "https://more.test/mcp"})
        self.assertEqual(over.exception.status, 409)
        bot_mcp_config.save({"name": "s3", "result_budget": 10}, next(i["id"] for i in integrations.list_integrations() if i["name"] == "s3"))

    def test_local_environment_reaches_the_launcher_by_name_only(self):
        bot_mcp_config.save({"name": "tool", "transport": "stdio", "command": "npx", "args": ["pkg"], "env": {"ACME_TOKEN": SECRET}})
        config = integrations.list_mcp_servers_runtime()["tool"]
        self.assertEqual(config["env"]["ACME_TOKEN"], SECRET)
        self.assertEqual(config["env"][integrations.PASS_ENV], "ACME_TOKEN")
        self.assertEqual(config["args"][-2:], ["npx", "pkg"])

    def test_oauth_block_stores_a_registered_client_without_exposing_its_secret(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp",
                                    "oauth": {"client_id": "cid-123", "client_secret": SECRET, "scopes": "read write"}})
        self.assertEqual(made["auth"], "oauth")
        self.assertEqual(made["oauth_client"], {"client_id": "cid-123", "scopes": "read write", "has_secret": True})
        self.assertNotIn(SECRET, json.dumps(made))
        storage = mcp_oauth.ItemTokenStorage(made["id"], "http://127.0.0.1:8420/api/integrations/oauth/callback")
        info = run(storage.get_client_info())
        self.assertEqual((info.client_id, info.client_secret, info.scope), ("cid-123", SECRET, "read write"))
        kept = bot_mcp_config.save({"name": "acme", "oauth": {"client_id": "cid-123", "scopes": "read"}}, made["id"])
        self.assertTrue(kept["oauth_client"]["has_secret"], "the saved client secret is kept when none is sent")

    def test_a_bot_may_propose_a_server_but_it_is_only_ever_saved_off_without_secrets(self):
        proposed = bot_mcp_config.propose({"name": "idea", "transport": "http", "url": "https://mcp.idea.test/mcp", "enabled": True,
                                           "headers": {"X-Key": SECRET}, "env": {"A": "b"}})
        self.assertEqual((proposed["enabled"], proposed["header_names"], proposed["env_names"], proposed["origin"]), (False, [], [], "proposed"))
        self.assertNotIn("idea", integrations.list_mcp_servers_runtime(), "off means no model is offered it")

    def test_catalogue_servers_add_in_one_step_and_only_once(self):
        first = bot_mcp_config.add_from_catalog("linear")
        again = bot_mcp_config.add_from_catalog("linear")
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(first["auth"], "oauth")
        with self.assertRaises(McpConfigError):
            bot_mcp_config.add_from_catalog("not-a-server")

    def test_routes_return_names_only_and_switch_alone_needs_no_form(self):
        made = web.post("/api/bots/mcp", json={"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp", "headers": {"X-Api-Key": SECRET}})
        self.assertEqual(made.status_code, 200, made.text)
        self.assertNotIn(SECRET, made.text)
        item_id = made.json()["id"]
        self.assertNotIn(SECRET, web.get("/api/bots/mcp").text)
        off = web.patch(f"/api/bots/mcp/{item_id}", json={"enabled": False})
        self.assertEqual((off.status_code, off.json()["enabled"]), (200, False))
        self.assertEqual(web.post("/api/bots/mcp", json={"name": "Bad", "transport": "http", "url": "https://x.test"}).status_code, 400)
        self.assertEqual(web.post("/api/bots/mcp", json={"name": "x", "transport": "http", "url": "https://x.test", "nope": 1}).status_code, 422)
        self.assertEqual(web.patch("/api/bots/mcp/missing", json={"enabled": True}).status_code, 404)
        self.assertEqual(web.delete(f"/api/bots/mcp/{item_id}").status_code, 200)
        self.assertEqual(web.delete(f"/api/bots/mcp/{item_id}").status_code, 404)


class NothingRuns(unittest.TestCase):
    """A command is data. Validating, saving, importing and previewing never start it."""

    def setUp(self):
        clear()

    def test_saving_and_previewing_a_command_never_starts_a_process(self):
        trip = AssertionError("a process was started")
        with patch("subprocess.Popen", side_effect=trip), patch("subprocess.run", side_effect=trip), patch("os.system", side_effect=trip), \
                patch("asyncio.create_subprocess_exec", side_effect=trip), patch("asyncio.create_subprocess_shell", side_effect=trip), \
                patch("os.startfile", side_effect=trip, create=True):
            made = bot_mcp_config.save({"name": "danger", "transport": "stdio", "command": "calc.exe", "args": ["; rm -rf /", "$(whoami)", "`id`"]})
            self.assertEqual(made["command"], "calc.exe")
            bot_mcp_config.from_blob("x", {"command": "powershell", "args": ["-c", "bad"], "env": {"K": "v"}})
            bot_mcp_config.clean({"name": "other", "transport": "stdio", "command": "bash", "args": ["-c", "echo hi"]})
            with tempfile.TemporaryDirectory() as home:
                (Path(home) / ".cursor").mkdir()
                (Path(home) / ".cursor" / "mcp.json").write_text(json.dumps({"mcpServers": {"s": {"command": "evil", "args": ["--key=abc"]}}}))
                bot_setup_import.scan(home, include_skills=False)


class Probes(unittest.TestCase):
    def setUp(self):
        clear()

    def test_limits_are_8_seconds_local_and_30_remote_and_100_tools(self):
        seen = []

        async def fake(config, timeout=20):
            seen.append((config["type"], timeout))
            return [{"name": f"t{n}", "description": "", "schema": {}, "read_only": None} for n in range(150)]
        with patch.object(mcp_client, "list_tools", fake):
            local = run(mcp_client.probe({"type": "stdio", "command": "x", "args": []}))
            remote = run(mcp_client.probe({"type": "http", "url": "https://x.test"}))
        self.assertEqual(seen, [("stdio", 8), ("http", 30)])
        self.assertEqual((local["state"], local["tools"], len(local["tool_names"]), local["truncated"]), ("connected", 150, 100, True))
        self.assertEqual(remote["state"], "connected")

    def test_failures_are_classified(self):
        class Refused(Exception):
            def __init__(self, status):
                self.response = types.SimpleNamespace(status_code=status)
        cases = [(asyncio.TimeoutError(), "failed", "timeout"), (Refused(401), "auth_required", "auth"), (Refused(403), "failed", "keys"),
                 (ConnectionRefusedError("refused"), "failed", "unreachable"), (FileNotFoundError("npx"), "failed", "unreachable"),
                 (BaseExceptionGroup("x", [Refused(401)]), "auth_required", "auth")]
        for error, state, reason in cases:
            async def fake(config, timeout=20, error=error):
                raise error
            with patch.object(mcp_client, "list_tools", fake):
                found = run(mcp_client.probe({"type": "http", "url": "https://x.test"}))
            self.assertEqual((found["state"], found["reason"], found["tools"]), (state, reason, 0), repr(error))

    def test_a_saved_server_is_tested_and_its_health_and_pins_recorded(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})

        async def fake(config, timeout=20):
            return [{"name": "list_items", "description": "List", "schema": {}, "read_only": True}, {"name": "delete_item", "description": "Delete", "schema": {}, "read_only": None}]
        with patch.object(mcp_client, "list_tools", fake):
            result = run(bot_mcp_config.test(made["id"]))
        self.assertEqual((result["state"], result["tools"]), ("connected", 2))
        self.assertEqual(result["server"]["status"]["state"], "working")
        self.assertTrue(result["server"]["pinned"])
        raw = integrations.get_integration(made["id"])
        self.assertEqual(raw["tool_read_only"], {"list_items": True}, "the server's own read-only claim is kept apart from the catalog")
        self.assertEqual(set(raw["discovered_tools"]["list_items"]), {"description", "fingerprint"})

    def test_an_oauth_server_not_signed_in_says_so_and_a_disabled_one_is_not_started(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp", "oauth": {"client_id": "c"}})
        result = run(bot_mcp_config.test(made["id"]))
        self.assertEqual((result["state"], result["reason"]), ("auth_required", "auth"))
        bot_mcp_config.set_enabled(made["id"], False)
        with patch.object(mcp_client, "list_tools", side_effect=AssertionError("started")):
            self.assertEqual(run(bot_mcp_config.test(made["id"]))["reason"], "off")

    def test_an_error_never_repeats_a_configured_secret(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp", "headers": {"X-Key": SECRET}})

        async def fake(config, timeout=20):
            raise RuntimeError(f"bad request with header {SECRET}")
        with patch.object(mcp_client, "list_tools", fake):
            checked = run(mcp_client.check(made["id"]))
        self.assertNotIn(SECRET, json.dumps(checked))
        self.assertIn("[hidden]", checked["status"]["error"])


class OAuthGuards(unittest.TestCase):
    def setUp(self):
        clear()

    def test_only_https_or_this_computer(self):
        for url in ("https://auth.example.com/authorize", "http://127.0.0.1:8420/api/cb", "http://localhost:3000/cb", "http://[::1]:8420/cb"):
            self.assertEqual(mcp_oauth.secure_url(url, "x"), url)
        for url in ("http://auth.example.com/authorize", "ftp://x.test", "javascript:alert(1)", "https:///x", "http://127.0.0.1.evil.com/x", ""):
            with self.assertRaises(ValueError, msg=url):
                mcp_oauth.secure_url(url, "x")

    def test_signing_in_to_an_insecure_server_is_refused_before_any_request(self):
        item = integrations.create_mcp_server("plain", "http", url="http://remote.test/mcp")
        with self.assertRaises(ValueError) as raised:
            run(mcp_oauth.start_sign_in(item["id"], "http://127.0.0.1:8420/api/integrations/oauth/callback"))
        self.assertIn("https", str(raised.exception))

    def test_a_state_works_once_and_a_replay_or_guess_does_nothing(self):
        item = integrations.create_mcp_server("acme", "http", url="https://mcp.acme.test/mcp", auth="oauth")

        async def go():
            loop = asyncio.get_running_loop()
            sign_in = mcp_oauth._SignIn(item_id=item["id"], code=loop.create_future())
            sign_in.task = loop.create_task(asyncio.sleep(0))
            mcp_oauth._pending["state-abc"] = sign_in
            first = await mcp_oauth.finish_sign_in("state-abc", "the-code", None, None)
            replay = await mcp_oauth.finish_sign_in("state-abc", "the-code", None, None)
            guess = await mcp_oauth.finish_sign_in("state-abd", "the-code", None, None)
            empty = await mcp_oauth.finish_sign_in("", "the-code", None, None)
            return first, replay, guess, empty
        first, replay, guess, empty = run(go())
        self.assertTrue(first[0])
        self.assertFalse(replay[0] or guess[0] or empty[0])

    def test_the_provider_refusing_ends_the_flow_and_flows_last_five_minutes(self):
        self.assertEqual(mcp_oauth.SIGN_IN_TIMEOUT_SECONDS, 300)
        item = integrations.create_mcp_server("acme", "http", url="https://mcp.acme.test/mcp", auth="oauth")

        async def go():
            loop = asyncio.get_running_loop()
            sign_in = mcp_oauth._SignIn(item_id=item["id"], code=loop.create_future())
            sign_in.task = loop.create_task(asyncio.sleep(10))
            mcp_oauth._pending["s1"] = sign_in
            return await mcp_oauth.finish_sign_in("s1", None, None, "access_denied")
        ok, message = run(go())
        self.assertFalse(ok)
        self.assertEqual(mcp_oauth.status(item["id"])["error"], "the provider refused: access_denied")

    def test_provider_text_never_repeats_a_credential(self):
        text = mcp_oauth._describe(ValueError("token endpoint said access_token=eyJabc.def client_secret: s3cr3t code=AUTHCODE"))
        for leaked in ("eyJabc.def", "s3cr3t", "AUTHCODE"):
            self.assertNotIn(leaked, text)


class HeldResults(unittest.TestCase):
    def setUp(self):
        clear()
        bot_tool_results.reset_store()

    def test_short_results_pass_through_and_long_ones_are_held_with_an_id(self):
        store = bot_tool_results.ResultStore()
        self.assertEqual(bot_tool_results.trim(store, "o", "b", "t", "short", 100), "short")
        long = "x" * 500
        shown = bot_tool_results.trim(store, "o", "b", "t", long, 100)
        self.assertTrue(shown.startswith("x" * 100) and "r_" in shown and "query_tool_result" in shown)
        rid = shown.split("held as ")[1].split(" ")[0]
        self.assertEqual(store.get("o", "b", "t", rid), long)
        held_all = bot_tool_results.trim(store, "o", "b", "t", "tiny", 0)
        self.assertNotIn("tiny", held_all, "a budget of 0 holds every result")

    def test_a_result_belongs_to_owner_bot_and_thread(self):
        store = bot_tool_results.ResultStore()
        rid = store.put("david", "bot1", "thread1", json.dumps({"a": 1}))
        self.assertIsNotNone(store.get("david", "bot1", "thread1", rid))
        for other in (("eve", "bot1", "thread1"), ("david", "bot2", "thread1"), ("david", "bot1", "thread2")):
            self.assertIsNone(store.get(*other, rid), other)
            with self.assertRaises(KeyError):
                store.query(*other, rid, "a")
        self.assertIsNone(store.get("david", "bot1", "thread1", "r_" + "0" * 16))
        text = bot_tool_results.run_query_tool("eve", "bot1", "thread1", rid, "a")
        self.assertIn("No held result", text)

    def test_results_expire_after_24_hours(self):
        now = [1_000.0]
        store = bot_tool_results.ResultStore(clock=lambda: now[0])
        rid = store.put("o", "b", "t", "data")
        now[0] += 24 * 3600 - 1
        self.assertEqual(store.get("o", "b", "t", rid), "data")
        now[0] += 2
        self.assertIsNone(store.get("o", "b", "t", rid))
        self.assertEqual(store.usage()["results"], 0)

    def test_the_store_is_capped_and_evicts_the_oldest(self):
        store = bot_tool_results.ResultStore(limit=1000)
        first = store.put("o", "b", "t", "a" * 400)
        second = store.put("o", "b", "t", "b" * 400)
        third = store.put("o", "b", "t", "c" * 400)
        self.assertIsNone(store.get("o", "b", "t", first))
        self.assertIsNotNone(store.get("o", "b", "t", second))
        self.assertIsNotNone(store.get("o", "b", "t", third))
        with self.assertRaises(ValueError):
            store.put("o", "b", "t", "z" * 1001)

    def test_a_large_result_spills_to_disk_and_the_folder_is_cleared_at_start(self):
        root = os.path.join(_DATA.name, "spill")
        store = bot_tool_results.ResultStore(root)
        big = "y" * (bot_tool_results.SPILL_ABOVE + 10)
        rid = store.put("o", "b", "t", big)
        files = [p for p in Path(root).rglob("*.txt")]
        self.assertEqual(len(files), 1)
        self.assertEqual(store.get("o", "b", "t", rid), big)
        store.clear()
        self.assertEqual(list(Path(root).rglob("*.txt")), [])
        store.put("o", "b", "t", big)
        bot_tool_results.ResultStore(root)
        self.assertEqual(list(Path(root).rglob("*.txt")), [], "orphans from an earlier run are removed")

    def test_queries_are_bounded_and_fenced(self):
        store = bot_tool_results.ResultStore()
        items = [{"name": f"n{i}", "n": i, "tags": ["x"] if i % 2 else []} for i in range(200)]
        rid = store.put("o", "b", "t", json.dumps({"items": items, "meta": {"total": 200}}))
        got = store.query("o", "b", "t", rid, "items[?n > `197`].name")
        self.assertEqual(json.loads(got["text"]), ["n198", "n199"])
        self.assertEqual(json.loads(store.query("o", "b", "t", rid, "length(items)")["text"]), 200)
        self.assertEqual(store.query("o", "b", "t", rid, "sort_by(items, &n)[-1].name")["text"], "n199", "a string comes back as plain text")
        wide = store.query("o", "b", "t", rid, "items[*]", max_chars=10_000_000)
        self.assertTrue(wide["truncated"] and len(wide["text"]) <= bot_tool_results.MAX_QUERY_OUTPUT)
        for expression in ("", "a" * 501, "items[", "items[?]", "nosuchfunction(items)", "items[0:1:0]", "((((" * 30 + "a" + "))))" * 30):
            with self.assertRaises(bot_tool_results.QueryError, msg=expression[:40]):
                store.query("o", "b", "t", rid, expression)
        shared = bot_tool_results.store().put("o", "b", "t", json.dumps({"meta": {"total": 200}}))
        fenced = bot_tool_results.run_query_tool("o", "b", "t", shared, "meta")
        self.assertIn("untrusted", fenced.lower())
        self.assertIn("UNTRUSTED", fenced)

    def test_a_plain_text_result_can_be_queried_for_its_length(self):
        store = bot_tool_results.ResultStore()
        rid = store.put("o", "b", "t", "plain words")
        self.assertEqual(json.loads(store.query("o", "b", "t", rid, "length(@)")["text"]), 11)

    def test_an_expensive_query_is_stopped(self):
        store = bot_tool_results.ResultStore()
        rid = store.put("o", "b", "t", json.dumps({"rows": [list(range(500)) for _ in range(500)]}))
        with patch.object(bot_tool_results, "MAX_STEPS", 5_000), self.assertRaises(bot_tool_results.QueryError):
            store.query("o", "b", "t", rid, "rows[*][*][]", 100)

    def test_the_budget_setting_is_bounded(self):
        self.assertEqual(bot_tool_results.clean_budget(None), 8000)
        self.assertEqual(bot_tool_results.clean_budget(0), 0)
        for bad in (-1, 2_000_001, "5", True, 1.5):
            with self.assertRaises(ValueError, msg=str(bad)):
                bot_tool_results.clean_budget(bad)

    def test_call_and_hold_applies_the_servers_timeout_budget_and_redaction(self):
        made = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp", "headers": {"X-Key": SECRET},
                                    "result_budget": 50, "call_timeout_minutes": 2})
        seen = {}

        async def fake(config, tool, arguments, timeout=120):
            seen["timeout"] = timeout
            return f"key={SECRET} " + "z" * 400
        with patch.object(mcp_client, "call_tool", fake):
            text = run(mcp_client.call_and_hold("acme", {"type": "http"}, "list", {}, ("david", "bot1", "thread1")))
        self.assertEqual(seen["timeout"], 120)
        self.assertNotIn(SECRET, text)
        self.assertIn("r_", text)
        rid = text.split("held as ")[1].split(" ")[0]
        self.assertNotIn(SECRET, bot_tool_results.store().get("david", "bot1", "thread1", rid), "the held copy is redacted too")
        self.assertIsNone(bot_tool_results.store().get("david", "bot2", "thread1", rid))
        self.assertEqual(made["call_timeout_minutes"], 2)

    def test_a_call_that_outlasts_its_timeout_ends_with_a_plain_sentence(self):
        bot_mcp_config.save({"name": "slow", "transport": "http", "url": "https://mcp.slow.test/mcp", "call_timeout_minutes": 1})

        async def never(config, tool, arguments, timeout=120):
            await asyncio.sleep(5)
        original = integrations.mcp_options
        with patch.object(mcp_client, "call_tool", never), patch.object(integrations, "mcp_options", lambda name: {**original(name), "call_timeout_seconds": 0.05}):
            text = run(mcp_client.call_and_hold("slow", {"type": "http"}, "x", {}, ("o", "b", "t")))
        self.assertIn("did not answer", text)


class SetupImport(unittest.TestCase):
    def setUp(self):
        clear()
        self.home = tempfile.TemporaryDirectory(prefix="kairos-home-", ignore_cleanup_errors=True)
        self.addCleanup(self.home.cleanup)
        home = Path(self.home.name)
        (home / ".cursor").mkdir()
        (home / ".codex").mkdir()
        (home / ".claude.json").write_text(json.dumps({"mcpServers": {
            "Linear Remote": {"type": "http", "url": "https://mcp.linear.test/mcp?api_key=SECRETQUERY123", "headers": {"Authorization": "Bearer SECRETHEADER456"}},
            "local-tool": {"command": "npx", "args": ["-y", "pkg", "--api-key=SECRETARG789"], "env": {"TOKEN": "SECRETENV000"}}},
            "projects": {"/work": {"mcpServers": {"proj-server": {"url": "https://mcp.proj.test/mcp"}}}}}), encoding="utf-8")
        (home / ".cursor" / "mcp.json").write_text(json.dumps({"mcpServers": {"insecure": {"url": "http://remote.test/mcp"}}}), encoding="utf-8")
        (home / ".codex" / "config.toml").write_text('[mcp_servers.codex-docs]\ncommand = "uvx"\nargs = ["docs-server"]\n[mcp_servers.codex-docs.env]\nKEY = "SECRETTOML111"\n', encoding="utf-8")
        self.secrets = ("SECRETQUERY123", "SECRETHEADER456", "SECRETARG789", "SECRETENV000", "SECRETTOML111")

    def test_the_preview_lists_servers_and_never_a_secret_value(self):
        found = bot_setup_import.scan(self.home.name, include_skills=False)
        text = json.dumps(found)
        for secret in self.secrets:
            self.assertNotIn(secret, text)
        rows = {(r["tool"], r["name"]): r for r in found["mcp"]}
        self.assertEqual(rows[("Claude Code", "linear-remote")]["status"], "ready")
        self.assertIn("Authorization", rows[("Claude Code", "linear-remote")]["gaps"])
        self.assertIn("address value api_key", rows[("Claude Code", "linear-remote")]["gaps"])
        self.assertIn("--api-key", rows[("Claude Code", "local-tool")]["gaps"])
        self.assertEqual(rows[("Claude Code", "proj-server")]["status"], "ready", "a Claude Code project's servers are found")
        self.assertEqual(rows[("Cursor", "insecure")]["status"], "refused", "an http address to another host is refused")
        self.assertEqual(rows[("Codex", "codex-docs")]["gaps"], ["KEY"])
        self.assertEqual(found["skills"], [])
        self.assertFalse(found["skills_available"] and not found["skills_note"] == "")

    def test_applying_imports_servers_off_with_no_secrets(self):
        result = bot_setup_import.apply({"mcp": [{"tool": "Claude Code", "name": "linear-remote"}, {"tool": "Claude Code", "name": "local-tool"},
                                                 {"tool": "Cursor", "name": "insecure"}, {"tool": "Codex", "name": "gone"}]}, home=self.home.name)
        by_name = {r["name"]: r for r in result["mcp"]}
        self.assertEqual((by_name["linear-remote"]["status"], by_name["local-tool"]["status"]), ("imported", "imported"))
        self.assertEqual(by_name["insecure"]["status"], "refused")
        self.assertEqual(by_name["gone"]["status"], "missing")
        saved = {i["name"]: i for i in integrations.list_integrations() if i["kind"] == "mcp_server"}
        self.assertEqual(set(saved), {"linear-remote", "local-tool"})
        for record in saved.values():
            self.assertEqual((record["enabled"], record["header_names"], record["env_names"], record["origin"]), (False, [], [], "setup:Claude Code"))
        raw = (Path(_DATA.name) / "integrations.json").read_text(encoding="utf-8")
        for secret in self.secrets:
            self.assertNotIn(secret, raw)
        self.assertEqual(integrations.list_mcp_servers_runtime(), {}, "nothing imported is offered to a model")
        again = bot_setup_import.apply({"mcp": [{"tool": "Claude Code", "name": "linear-remote"}]}, home=self.home.name)
        self.assertEqual(again["mcp"][0]["status"], "exists")

    def test_nothing_runs_while_scanning_and_links_and_big_files_are_skipped(self):
        (Path(self.home.name) / ".mcp.json").write_text("{" + " " * (bot_setup_import.MAX_FILE + 10) + "}", encoding="utf-8")
        found = bot_setup_import.scan(self.home.name, include_skills=False)
        self.assertEqual(len(found["mcp"]), 5)
        slow = iter([0, 0, 0, 100, 100, 100, 100, 100, 100, 100])
        limited = bot_setup_import.scan(self.home.name, seconds=1, clock=lambda: next(slow, 100), include_skills=False)
        self.assertTrue(limited["limited"])

    def test_skills_are_scanned_and_applied_through_the_skill_unit_when_it_is_there(self):
        calls = []
        fake = types.ModuleType("services.bot_skill_import")
        fake.scan_setup_skills = lambda home=None, **kw: calls.append(("scan", str(home))) or {"skills": [{"tool": "Codex", "folder": "notes", "name": "notes", "status": "ready"}], "limited": False}
        fake.apply_setup_skills = lambda bot_id, selections, home=None: calls.append(("apply", bot_id, selections)) or {"results": [{"name": "notes", "status": "imported"}]}
        with patch.dict(sys.modules, {"services.bot_skill_import": fake}), patch("services.bot_skill_import", fake, create=True):
            found = bot_setup_import.scan(self.home.name)
            self.assertTrue(found["skills_available"])
            self.assertEqual(found["skills"][0]["folder"], "notes")
            result = bot_setup_import.apply({"skills": [{"tool": "Codex", "folder": "notes"}]}, home=self.home.name, bot_id="0123456789")
        self.assertEqual(result["skills"], [{"name": "notes", "status": "imported"}])
        self.assertEqual(calls[-1], ("apply", "0123456789", [{"tool": "Codex", "folder": "notes"}]))

    def test_without_the_skill_unit_the_rest_still_works(self):
        with patch.dict(sys.modules, {"services.bot_skill_import": None}):
            found = bot_setup_import.scan(self.home.name)
        self.assertFalse(found["skills_available"])
        self.assertIn("not available", found["skills_note"])
        with patch.dict(sys.modules, {"services.bot_skill_import": None}), self.assertRaises(McpConfigError) as raised:
            bot_setup_import.apply({"skills": [{"tool": "Codex", "folder": "x"}]}, home=self.home.name)
        self.assertEqual(raised.exception.status, 501)

    def test_nothing_chosen_is_refused(self):
        for body in ({}, {"mcp": []}, {"surprise": 1}, []):
            with self.assertRaises(McpConfigError):
                bot_setup_import.apply(body, home=self.home.name)


if __name__ == "__main__":
    unittest.main()
