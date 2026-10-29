"""Bots redesign, Phase 2 unit U4: grant schema, selectors, effective reach and the Access route (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.3, 4.5 and 7 (U4).
Runs against a throwaway data folder. Run: python scripts/test_bots_grants.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-grants-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_tool_catalog as catalog, integrations, settings  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes import bot_access_routes  # noqa: E402
from services import bot_grants, bot_record, bot_resource_fields as fields  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

app = FastAPI()
app.include_router(bot_access_routes.router)
app.dependency_overrides[require_admin] = lambda: "local"
web = TestClient(app)

TOOLS = [{"name": "list_issues", "description": "List issues.", "schema": {}},
         {"name": "create_issue", "description": "Create an issue.", "schema": {}},
         {"name": "frobnicate", "description": "Does something.", "schema": {}}]


def server(name="github", tools=TOOLS):
    item = integrations.create_mcp_server(name, "http", url=f"https://{name}.example/mcp")
    integrations.record_check(item["id"], tools=tools)
    bot_grants.reset_cache()
    return item["id"]


def make_bot(name, **extra):
    bot = agent_service.create(name, **extra)
    bot_grants.reset_cache()
    return bot["id"]


def verdict(bot, tool, args=None, mcp=None):
    bot_grants.reset_cache()
    return bot_grants.verdict(bot_grants.Scope(bot, "local", True), tool, args or {}, mcp=mcp)


class Reset(unittest.TestCase):
    def setUp(self):
        for item in integrations.list_integrations():
            integrations.delete_integration(item["id"])
        settings.update_settings(disabled_tools=[])
        bot_grants.reset_cache()


class Fields(Reset):
    def test_defaults_and_validation(self):
        bot = agent_service.get(make_bot("Fields A"))
        self.assertIs(bot["memory_enabled"], True)
        self.assertIs(bot["helper_model"], True)
        self.assertIsNone(bot["connector_tools"])
        self.assertEqual(bot["grants_version"], 0)
        for bad in ("yes", 1):
            with self.assertRaises(ValueError):
                bot_record.clean_field("memory_enabled", bad)
        self.assertEqual(bot_record.clean_field("connector_tools", {}), {})
        self.assertIsNone(bot_record.clean_field("connector_tools", None))
        self.assertEqual(bot_record.clean_field("connector_tools", {"a": {"tools": ["x", "x"]}}), {"a": {"tools": ["x"]}})
        for bad in ({"a": {}}, {"a": {"tools": "all"}}, {"a b": {"tools": "*"}}, {"a": {"tools": "*", "extra": 1}},
                    {"a": {"tools": [1]}}, [], {f"a{i}": {"tools": "*"} for i in range(65)}):
            with self.assertRaises(ValueError, msg=str(bad)[:40]):
                bot_record.clean_field("connector_tools", bad)
        with self.assertRaises(ValueError):
            bot_record.clean_field("connector_tools", {f"a{i}": {"tools": [f"t{j}" for j in range(10)]} for i in range(51)})

    def test_grants_version_only_rises(self):
        record = {"grants_version": 1}
        self.assertEqual(bot_record.clean_field("grants_version", 2, record), 2)
        with self.assertRaises(ValueError):
            bot_record.clean_field("grants_version", 0, record)

    def test_editable_through_the_agent_service(self):
        bot_id = make_bot("Fields B")
        agent_service.update(bot_id, memory_enabled=False, helper_model=False, connector_tools={})
        bot = agent_service.get(bot_id)
        self.assertEqual((bot["memory_enabled"], bot["helper_model"], bot["connector_tools"]), (False, False, {}))

    def test_saved_defaults_carry_preferences_never_grants(self):
        self.assertEqual(bot_record.clean_defaults({"memory_enabled": False})["memory_enabled"], False)
        with self.assertRaises(ValueError):
            bot_record.clean_defaults({"connector_tools": {}})

    def test_resource_settings_document(self):
        merged = fields.clean_resource_settings({"tidy_time": "04:30", "skill_review": {"steps": 20}})
        self.assertEqual((merged["tidy_time"], merged["capture_quiet_minutes"], merged["skill_review"]),
                         ("04:30", 5, {"enabled": True, "steps": 20}))
        for bad in ({"tidy_time": "25:00"}, {"capture_quiet_minutes": 0}, {"skill_review": {"steps": 2}}, {"x": 1}):
            with self.assertRaises(ValueError):
                fields.clean_resource_settings(bad)


class Migration(Reset):
    def test_server_name_selectors_translate_once_and_off_survives(self):
        sid = server("github")
        record = {"tool_scope": {"allow": ["mcp:github:list_issues", "native:*"], "deny": ["mcp:github:*"]},
                  "connector_scopes": {"github": "off", "elsewhere": "read"}}
        servers = [{"id": sid, "name": "github"}]
        self.assertTrue(fields.translate_record(record, servers))
        self.assertEqual(record["tool_scope"]["deny"], [f"mcp:{sid}:*"])
        self.assertEqual(record["connector_scopes"], {sid: "off", "elsewhere": "read"})
        self.assertFalse(fields.translate_record(record, servers), "a second run changes nothing")

    def test_ambiguous_names_are_left_and_a_deny_still_blocks(self):
        a, b = server("dup"), server("dup2")
        servers = [{"id": a, "name": "dup"}, {"id": b, "name": "dup"}]
        record = {"tool_scope": {"allow": [], "deny": ["mcp:dup:create_issue"]}, "connector_scopes": {"dup": "off"}}
        self.assertFalse(fields.translate_record(record, servers))
        self.assertEqual(record["tool_scope"]["deny"], ["mcp:dup:create_issue"])
        self.assertEqual(record["connector_scopes"], {"dup": "off"})

    def test_upgrade_sets_version_for_explicit_grants_and_is_idempotent(self):
        record = {"id": "x", "connector_tools": {}, "grants_version": 0}
        self.assertTrue(bot_record.upgrade(record, servers=[]))
        self.assertEqual(record["grants_version"], 1)
        self.assertFalse(bot_record.upgrade(record, servers=[]))

    def test_an_off_scope_is_never_turned_into_permission(self):
        sid = server("gh3")
        bot_id = make_bot("Mig A", connector_scopes={"gh3": "off"})
        record = agent_service.get(bot_id)
        bot_record.upgrade(record, servers=[{"id": sid, "name": "gh3"}])
        self.assertEqual(record["connector_scopes"], {sid: "off"})
        v = verdict(bot_id, "x", mcp=(sid, "list_issues"))
        self.assertFalse(v.allowed)
        self.assertEqual(v.code, "app_off")
        # Even before the rewrite, the name still blocks.
        record["connector_scopes"] = {"gh3": "off"}
        self.assertFalse(verdict(bot_id, "x", mcp=(sid, "list_issues")).allowed)


class Catalogue(Reset):
    def test_effects_declared_then_named_then_unknown(self):
        sid = server()
        self.assertEqual(catalog.mcp_effect(sid, "list_issues"), ("read", "name"))
        self.assertEqual(catalog.mcp_effect(sid, "create_issue"), ("write", "name"))
        self.assertEqual(catalog.mcp_effect(sid, "frobnicate"), ("unknown", "unknown"))
        self.assertEqual(catalog.classify_name("search_and_replace"), "write")
        self.assertEqual(catalog.classify_name("getUserProfile"), "read")

    def test_held_and_unpinned_tools_are_not_in_the_catalogue(self):
        sid = server()
        integrations.record_check(sid, tools=[*TOOLS, {"name": "brand_new", "description": "x", "schema": {}}])
        names = {t["name"] for t in catalog.server_tools(sid)}
        self.assertNotIn("brand_new", names)
        self.assertIn("brand_new", catalog.held_names(sid))

    def test_unavailable_servers_say_why(self):
        sid = server()
        integrations.set_enabled(sid, False)
        cat = catalog.catalogue("local", True)
        row = next(r for r in cat["servers"] if r["id"] == sid)
        self.assertFalse(row["available"])
        self.assertIn("switched off", row["reason"])

    def test_selectors_and_families(self):
        self.assertTrue(catalog.selector_matches("native:Bash", "native", None, "run_shell"))
        self.assertTrue(catalog.selector_matches("native:*", "native", None, "anything"))
        self.assertFalse(catalog.selector_matches("native:Read", "native", None, "Write"))
        self.assertTrue(catalog.selector_matches("mcp:abc:*", "mcp", "abc", "x"))
        self.assertFalse(catalog.selector_matches("mcp:abc:x", "mcp", "abd", "x"))

    def test_proxy_names_fit_claude(self):
        taken = set()
        long = "t" * 100
        a = catalog.proxy_name("server", long, taken)
        taken.add(a)
        b = catalog.proxy_name("server", long, taken)
        self.assertNotEqual(a, b)
        self.assertLessEqual(len(catalog.PROXY_PREFIX + b), 64)

    def test_revision_follows_availability(self):
        sid = server()
        before = catalog.catalogue("local", True)["revision"]
        integrations.set_enabled(sid, False)
        self.assertNotEqual(before, catalog.catalogue("local", True)["revision"])


class NativeVerdicts(Reset):
    def test_default_bot_may_use_everything_available(self):
        bot = make_bot("Native A")
        self.assertTrue(verdict(bot, "search_sessions").allowed)
        self.assertTrue(verdict(bot, "mcp__hive_mind__search_sessions").allowed)
        self.assertTrue(verdict(bot, "Task").allowed)
        self.assertTrue(verdict(bot, "SomethingClaudeAdded").allowed)

    def test_deny_always_wins_over_allow(self):
        bot = make_bot("Native B", tool_scope={"allow": ["native:Bash", "native:Read"], "deny": ["native:Bash"]})
        self.assertFalse(verdict(bot, "Bash").allowed)
        self.assertFalse(verdict(bot, "run_shell").allowed, "the shell is one family")
        self.assertTrue(verdict(bot, "Read").allowed)
        self.assertFalse(verdict(bot, "Write").allowed, "a non-empty allow list narrows")
        self.assertTrue(verdict(bot, "AskUserQuestion").allowed, "the baseline stays")

    def test_empty_allow_means_all_and_mcp_only_allow_does_not_narrow_natives(self):
        sid = server()
        bot = make_bot("Native C", tool_scope={"allow": [f"mcp:{sid}:list_issues"], "deny": []})
        self.assertTrue(verdict(bot, "Write").allowed)

    def test_global_policy_and_admin_rights(self):
        bot = make_bot("Native D")
        settings.update_settings(disabled_tools=["Bash"])
        self.assertFalse(verdict(bot, "Bash").allowed)
        settings.update_settings(disabled_tools=[])
        bot_grants.reset_cache()
        v = bot_grants.verdict(bot_grants.Scope(bot, "someone", False), "Bash", {})
        self.assertFalse(v.allowed)
        self.assertEqual(v.code, "unavailable")

    def test_refusal_text_does_not_list_other_grants(self):
        bot = make_bot("Native E", tool_scope={"allow": [], "deny": ["native:Bash", "native:Write"]})
        text = verdict(bot, "Bash").reason
        self.assertNotIn("Write", text)
        self.assertIn("Access settings", text)

    def test_google_account_scope_and_read_actions(self):
        bot = make_bot("Native F", connector_scopes={"google": "read"})
        self.assertTrue(verdict(bot, "google_calendar", {"action": "list_events"}).allowed)
        v = verdict(bot, "google_calendar", {"action": "delete"})
        self.assertFalse(v.allowed)
        self.assertEqual(v.code, "read_only")
        agent_service.update(bot, connector_scopes={"google": "write"},
                             connector_tools={"google": {"tools": ["google_calendar"], "accounts": ["me@example.com"]}})
        self.assertTrue(verdict(bot, "google_calendar", {"action": "list", "account": "me@example.com"}).allowed)
        self.assertFalse(verdict(bot, "google_calendar", {"action": "list", "account": "other@example.com"}).allowed)
        self.assertFalse(verdict(bot, "google_calendar", {"action": "list"}).allowed)
        self.assertFalse(verdict(bot, "google_drive", {"action": "list"}).allowed, "a tool the grant does not name")


class McpVerdicts(Reset):
    def test_legacy_reading_allows_apps_without_a_scope(self):
        sid = server()
        bot = make_bot("Mcp A")
        self.assertTrue(verdict(bot, "x", mcp=(sid, "create_issue")).allowed)

    def test_integration_selection_and_rea_opt_in(self):
        a, b = server("one"), server("two")
        bot = make_bot("Mcp B", integration_ids=[a])
        self.assertTrue(verdict(bot, "x", mcp=(a, "list_issues")).allowed)
        self.assertFalse(verdict(bot, "x", mcp=(b, "list_issues")).allowed)

    def test_read_scope_allows_classified_reads_only(self):
        sid = server()
        bot = make_bot("Mcp C", connector_scopes={sid: "read"})
        self.assertTrue(verdict(bot, "x", mcp=(sid, "list_issues")).allowed)
        self.assertFalse(verdict(bot, "x", mcp=(sid, "create_issue")).allowed)
        unknown = verdict(bot, "x", mcp=(sid, "frobnicate"))
        self.assertFalse(unknown.allowed)
        self.assertIn("not known to be read-only", unknown.reason)

    def test_declared_effect_beats_the_name(self):
        sid = server()
        from unittest.mock import patch
        with patch.object(catalog, "declared_effect", lambda s, t: "read" if t == "frobnicate" else None):
            bot = make_bot("Mcp D", connector_scopes={sid: "read"})
            self.assertTrue(verdict(bot, "x", mcp=(sid, "frobnicate")).allowed)

    def test_explicit_grants_allow_only_what_they_name(self):
        sid = server()
        bot = make_bot("Mcp E", connector_scopes={sid: "write"}, connector_tools={sid: {"tools": ["list_issues"]}})
        self.assertTrue(verdict(bot, "x", mcp=(sid, "list_issues")).allowed)
        self.assertFalse(verdict(bot, "x", mcp=(sid, "create_issue")).allowed)

    def test_empty_record_grants_no_app_tools_and_missing_scope_fails_closed(self):
        sid = server()
        none = make_bot("Mcp F", connector_tools={})
        self.assertFalse(verdict(none, "x", mcp=(sid, "list_issues")).allowed)
        self.assertTrue(verdict(none, "search_sessions").allowed, "native tools are not app tools")
        no_scope = make_bot("Mcp G", connector_tools={sid: {"tools": "*"}})
        v = verdict(no_scope, "x", mcp=(sid, "list_issues"))
        self.assertFalse(v.allowed)
        self.assertEqual(v.code, "no_scope")

    def test_mcp_deny_wins_even_for_a_name_selector(self):
        sid = server("named")
        bot = make_bot("Mcp H", tool_scope={"allow": [], "deny": ["mcp:named:create_issue"]})
        self.assertFalse(verdict(bot, "x", mcp=(sid, "create_issue")).allowed)
        self.assertTrue(verdict(bot, "x", mcp=(sid, "list_issues")).allowed)

    def test_held_disabled_and_unknown_servers_are_refused(self):
        sid = server()
        bot = make_bot("Mcp I")
        integrations.record_check(sid, tools=[*TOOLS, {"name": "extra", "description": "x", "schema": {}}])
        self.assertEqual(verdict(bot, "x", mcp=(sid, "extra")).code, "held")
        integrations.set_enabled(sid, False)
        self.assertEqual(verdict(bot, "x", mcp=(sid, "list_issues")).code, "unavailable")
        self.assertFalse(verdict(bot, "x", mcp=("nope", "t")).allowed)

    def test_unrecognised_names_and_direct_mcp_are_refused(self):
        bot = make_bot("Mcp J")
        self.assertEqual(verdict(bot, "mcp__claude_ai_Canva__export-design").code, "unknown")
        self.assertEqual(verdict(bot, "").code, "unknown")
        self.assertTrue(verdict(bot, "mcp__kairos_apps__github__list_issues").allowed, "the bridge judges proxy tools")


class FailClosed(Reset):
    def test_missing_malformed_or_stale_scope(self):
        for scope in (None, 5, {}, {"agent_id": ""}, "ghost-bot", bot_grants.Scope("ghost-bot")):
            v = bot_grants.verdict(scope, "search_sessions", {})
            self.assertFalse(v.allowed, repr(scope))
            self.assertEqual(v.code, "scope")
        self.assertIsNone(bot_grants.ceiling_denial(None, "Bash", {}))

    def test_verdict_errors_fail_closed(self):
        from unittest.mock import patch
        bot = make_bot("Fail A")
        with patch.object(bot_grants, "_evaluate", side_effect=RuntimeError("boom")):
            self.assertFalse(bot_grants.verdict(bot, "search_sessions", {}).allowed)


class Revision(Reset):
    def test_monotonic_through_any_change(self):
        bot = make_bot("Rev A")
        first = bot_grants.revision(bot)
        self.assertEqual(bot_grants.revision(bot), first)
        agent_service.update(bot, tool_scope={"allow": [], "deny": ["native:Bash"]})
        second = bot_grants.revision(bot)
        self.assertGreater(second, first)
        server()
        self.assertGreater(bot_grants.revision(bot), second)

    def test_receipt_binds_call_arguments_and_dies_with_revocation(self):
        bot = make_bot("Rev B")
        sc = bot_grants.Scope(bot, "local", True)
        first = bot_grants.verdict(sc, "search_sessions", {"query": "a"}, call_id="c1")
        self.assertTrue(first.receipt)
        self.assertEqual(bot_grants.recheck(sc, "search_sessions", {"query": "a"}, call_id="c1").code, "receipt")
        self.assertNotEqual(bot_grants.recheck(sc, "search_sessions", {"query": "b"}, call_id="c1").code, "receipt")
        agent_service.update(bot, tool_scope={"allow": [], "deny": ["native:search_sessions"]})
        revoked = bot_grants.recheck(sc, "search_sessions", {"query": "a"}, call_id="c1")
        self.assertFalse(revoked.allowed)


class ProviderCapability(Reset):
    def test_codex_cannot_hold_a_shell_or_file_limit(self):
        bot = make_bot("Prov A", tool_scope={"allow": [], "deny": ["native:Bash"]})
        text = bot_grants.provider_refusal(bot, "codex")
        self.assertIn("Bash", text)
        self.assertIn("Claude or API model", text)
        self.assertIsNone(bot_grants.provider_refusal(bot, "claude"))
        self.assertIsNone(bot_grants.provider_refusal(bot, "openai"))
        self.assertIn("Antigravity", bot_grants.provider_refusal(bot, "antigravity"))

    def test_an_unrestricted_or_kairos_only_limit_is_fine_everywhere(self):
        plain = make_bot("Prov B")
        limited = make_bot("Prov C", tool_scope={"allow": [], "deny": ["native:send_email"]})
        for bot in (plain, limited):
            self.assertIsNone(bot_grants.provider_refusal(bot, "codex"))

    def test_narrowing_allow_list_counts(self):
        bot = make_bot("Prov D", tool_scope={"allow": ["native:create_note"], "deny": []})
        self.assertIsNotNone(bot_grants.provider_refusal(bot, "codex"))


class ClaudeNames(Reset):
    def test_disallowed_names_use_claudes_spelling(self):
        bot = make_bot("Names A", tool_scope={"allow": [], "deny": ["native:Bash", "native:create_note"]})
        names = bot_grants.claude_disallowed(bot_grants.Scope(bot, "local", True))
        self.assertIn("Bash", names)
        self.assertIn("mcp__hive_mind__create_note", names)
        self.assertNotIn("Read", names)


class AccessRoute(Reset):
    def test_get_explains_and_put_saves_with_revision_checks(self):
        sid = server()
        bot = make_bot("Route A")
        got = web.get(f"/api/bots/{bot}/access")
        self.assertEqual(got.status_code, 200)
        data = got.json()
        self.assertEqual(data["mode"], "legacy")
        self.assertTrue(any("Full" in line for line in data["explanation"]))
        github = next(a for a in data["apps"] if a["id"] == sid)
        self.assertTrue(all(t["state"] == "on" for t in github["tools"]))
        body = {"expected_revision": data["revision"], "connector_scopes": {sid: "read"},
                "connector_tools": {sid: {"tools": ["list_issues", "create_issue"]}},
                "tool_scope": {"allow": [], "deny": ["native:Bash"]}}
        saved = web.put(f"/api/bots/{bot}/access", json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        out = saved.json()
        self.assertEqual(out["mode"], "explicit")
        self.assertGreater(out["revision"], data["revision"])
        self.assertEqual(agent_service.get(bot)["grants_version"], 1)
        states = {t["name"]: t["state"] for t in next(a for a in out["apps"] if a["id"] == sid)["tools"]}
        self.assertEqual(states, {"list_issues": "on", "create_issue": "off", "frobnicate": "off"})
        # The stale revision is a 409.
        stale = web.put(f"/api/bots/{bot}/access", json=body)
        self.assertEqual(stale.status_code, 409)

    def test_partial_save_keeps_legacy_reading(self):
        bot = make_bot("Route B")
        rev = web.get(f"/api/bots/{bot}/access").json()["revision"]
        saved = web.put(f"/api/bots/{bot}/access", json={"expected_revision": rev, "tool_scope": {"allow": [], "deny": ["native:Bash"]}})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["mode"], "legacy")
        self.assertIsNone(agent_service.get(bot)["connector_tools"])

    def test_unavailable_tools_cannot_be_switched_on(self):
        sid = server()
        bot = make_bot("Route C")
        rev = web.get(f"/api/bots/{bot}/access").json()["revision"]
        body = {"expected_revision": rev, "connector_scopes": {sid: "write"}, "connector_tools": {sid: {"tools": ["not_a_tool"]}}}
        self.assertEqual(web.put(f"/api/bots/{bot}/access", json=body).status_code, 422)
        integrations.set_enabled(sid, False)
        bot_grants.reset_cache()
        rev = web.get(f"/api/bots/{bot}/access").json()["revision"]
        body = {"expected_revision": rev, "connector_scopes": {sid: "write"}, "connector_tools": {sid: {"tools": "*"}}}
        self.assertEqual(web.put(f"/api/bots/{bot}/access", json=body).status_code, 422)

    def test_a_tool_group_needs_an_explicit_scope(self):
        sid = server()
        bot = make_bot("Route D")
        rev = web.get(f"/api/bots/{bot}/access").json()["revision"]
        body = {"expected_revision": rev, "connector_tools": {sid: {"tools": "*"}}}
        self.assertEqual(web.put(f"/api/bots/{bot}/access", json=body).status_code, 400)

    def test_unknown_fields_bad_ids_and_missing_bots(self):
        bot = make_bot("Route E")
        self.assertEqual(web.put(f"/api/bots/{bot}/access", json={"expected_revision": 1, "approval_mode": "ask"}).status_code, 422)
        self.assertEqual(web.get("/api/bots/ghost/access").status_code, 404)

    def test_full_approval_cannot_widen(self):
        sid = server()
        bot = make_bot("Route F", approval_mode="full", connector_scopes={sid: "off"})
        self.assertEqual(agent_service.get(bot)["approval_mode"], "full")
        self.assertFalse(verdict(bot, "x", mcp=(sid, "list_issues")).allowed)


if __name__ == "__main__":
    unittest.main()
