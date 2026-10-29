"""Bots Phase 2, unit U5: the connected-app inventory, aliases, keys and resource settings (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 4.5 and 7 (U5).
Throwaway data folder, stand-in upstreams. Run: python scripts/test_bots_connections.py
"""
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-connections-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import integrations, settings as settings_store  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import bot_connections_routes  # noqa: E402
from services import bot_connection_catalog as catalog, bot_connections, bot_keys, bot_mcp_config  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.bot_app_adapters import AdapterError, EmailAdapter, GoogleAdapter, McpAdapter  # noqa: E402
from services.bot_connections import ConnectionError_  # noqa: E402

app = FastAPI()
app.include_router(bot_connections_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)

SECRET = "sk-test-0123456789abcdef0123"


def run(coroutine):
    return asyncio.run(coroutine)


class FakeGoogle:
    """The upstream Google module's surface the adapter uses."""
    class GoogleError(Exception):
        status = 400

    def __init__(self, accounts=(), configured=True):
        self.accounts, self.is_configured, self.disconnected, self.started = list(accounts), configured, [], []

    def status(self, user):
        return {"configured": self.is_configured, "accounts": [{"id": a, "email": a + "@mail.test", "default": i == 0, "error": None} for i, a in enumerate(self.accounts)]}

    def start_sign_in(self, redirect, owner, add, account_id):
        self.started.append((redirect, owner, add, account_id))
        return "https://accounts.google.test/o/oauth2/v2/auth?state=abc&client_id=x"

    def disconnect(self, account_id, owner):
        if account_id not in self.accounts:
            raise self.GoogleError("Unknown Google account")
        self.accounts.remove(account_id)
        self.disconnected.append(account_id)


class FakeEmail:
    def __init__(self, rows):
        self.rows = rows

    def list_accounts(self):
        return self.rows


class Base(unittest.TestCase):
    def setUp(self):
        for item in integrations.list_integrations():
            integrations.delete_integration(item["id"])
        roster = patch.dict(agent_service._agents, {}, clear=True)
        roster.start()
        self.addCleanup(roster.stop)
        for path in (Path(_DATA.name) / "bot-connections" / "aliases.json", Path(_DATA.name) / "bot-keys.json"):
            if path.exists():
                path.unlink()
        self.google, self.email = FakeGoogle(), FakeEmail([])

    def inventory(self, **kw):
        return bot_connections.inventory("david", google=GoogleAdapter(self.google), email=EmailAdapter(self.email), **kw)

    def app(self, app_id, **kw):
        return next(a for a in self.inventory(**kw)["apps"] if a["id"] == app_id)


class Inventory(Base):
    def test_every_kind_of_app_appears_with_a_state_and_a_category(self):
        server = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})
        found = self.inventory()
        ids = {a["id"] for a in found["apps"]}
        self.assertTrue({server["id"], "google", "email", "highlevel", "x", "whop", "catalog:linear"} <= ids)
        mine = next(a for a in found["apps"] if a["id"] == server["id"])
        self.assertEqual((mine["kind"], mine["state"], mine["category"]), ("mcp", "pending", "Other"))
        self.assertTrue(all(a["category"] in catalog.CATEGORIES for a in found["apps"]))
        self.assertEqual(self.app("catalog:linear")["category"], "Productivity")
        self.assertEqual(self.app("google")["state"], "available")

    def test_search_category_and_connected_filters(self):
        bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})
        self.assertEqual([a["label"] for a in self.inventory(query="linear")["apps"]], ["Linear"])
        self.assertTrue(all(a["category"] == "Finance" for a in self.inventory(category="Finance")["apps"]))
        self.assertTrue(all(a["kind"] == "mcp" for a in self.inventory(mcp_only=True)["apps"]))
        self.assertEqual([a["label"] for a in self.inventory(connected_only=True)["apps"]], ["acme"])

    def test_the_inventory_is_ordered_trouble_first(self):
        item = integrations.create_mcp_server("dead", "http", url="https://mcp.dead.test/mcp")
        integrations.record_check(item["id"], error="no answer")
        working = integrations.create_mcp_server("fine", "http", url="https://mcp.fine.test/mcp")
        integrations.record_check(working["id"], tools=[{"name": "list_x", "description": "", "schema": {}}])
        states = [a["state"] for a in self.inventory(connected_only=True)["apps"]]
        self.assertEqual(states, ["failed", "connected"])

    def test_google_and_mailbox_accounts_are_reused_with_aliases(self):
        self.google.accounts = ["work", "home"]
        self.email.rows = [{"id": "m1", "email": "me@mail.test", "owner": None}, {"id": "m2", "email": "other@mail.test", "owner": "someone-else"}]
        google, mail = self.app("google"), self.app("email")
        self.assertEqual((google["state"], [a["label"] for a in google["accounts"]]), ("connected", ["work@mail.test", "home@mail.test"]))
        self.assertEqual([a["id"] for a in mail["accounts"]], ["m1"], "another person's mailbox is not listed")
        with patch.object(bot_connections, "_app", lambda app_id, owner: self.app(app_id)):
            bot_connections.set_alias("google", "work", "Work Gmail")
            with self.assertRaises(ConnectionError_) as dup:
                bot_connections.set_alias("google", "home", "work gmail")
            self.assertEqual(dup.exception.status, 409)
            for bad in ("", "x" * 65, "bell\x07alias"):
                with self.assertRaises(ConnectionError_, msg=bad):
                    bot_connections.set_alias("google", "home", bad)
            with self.assertRaises(ConnectionError_) as missing:
                bot_connections.set_alias("google", "nope", "Nope")
            self.assertEqual(missing.exception.status, 404)
        self.assertEqual([a["alias"] for a in self.app("google")["accounts"]], ["Work Gmail", ""])

    def test_google_not_set_up_says_why(self):
        self.google.is_configured = False
        found = self.app("google")
        self.assertEqual(found["state"], "unavailable")
        self.assertIn("OAuth client", found["reason"])

    def test_a_broken_upstream_is_unavailable_not_silently_empty(self):
        class Broken(FakeGoogle):
            def status(self, user):
                raise RuntimeError("upstream is down")
        self.google = Broken()
        found = self.app("google")
        self.assertEqual((found["state"], found["accounts"]), ("unavailable", []))
        self.assertIn("upstream is down", found["reason"])

    def test_which_bots_use_an_app_and_which_have_it_limited(self):
        server = bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})
        everyone = agent_service.create("Scout")
        narrowed = agent_service.create("Archivist")
        agent_service.update(narrowed["id"], tool_scope={"allow": [], "deny": [f"mcp:{server['id']}:delete_item"]})
        none = agent_service.create("Quiet", integration_ids=[])
        off = agent_service.create("Locked")
        agent_service.update(off["id"], connector_scopes={server["id"]: "off"})
        found = self.app(server["id"])
        self.assertEqual({u["name"] for u in found["used_by"]}, {"Scout", "Archivist"})
        self.assertEqual(found["limited_for"], [narrowed["id"]])
        self.assertEqual([b["id"] for b in self.inventory()["bots_without_apps"]], [none["id"]])
        self.assertTrue(everyone and off)

    def test_native_cards_follow_the_saved_keys(self):
        self.assertEqual((self.app("highlevel")["state"], self.app("x")["state"]), ("available", "available"))
        bot_keys.set_slot("x", "x-bearer-token-0123456789")
        self.assertEqual(self.app("x")["state"], "connected")
        self.assertEqual(self.app("whop")["state"], "available")
        added = bot_mcp_config.save({"name": "whop", "transport": "http", "url": "https://mcp.whop.com/mcp", "enabled": False})
        self.assertEqual((self.app("whop")["state"], self.app("whop")["integration_id"]), ("added", added["id"]))


class Authorize(Base):
    def test_google_returns_a_bounded_link_and_a_second_account_needs_an_alias(self):
        self.google.accounts = ["work"]
        with self.assertRaises(ConnectionError_):
            run(bot_connections.authorize("google", "david", "http://127.0.0.1:8420/api", None, google=GoogleAdapter(self.google)))
        result = run(bot_connections.authorize("google", "david", "http://127.0.0.1:8420/api", "Home", google=GoogleAdapter(self.google)))
        self.assertTrue(result["url"].startswith("https://accounts.google.test/") and result["expires_in"] == 300)
        self.assertEqual(self.google.started[-1], ("http://127.0.0.1:8420/api/google/oauth/callback", "david", True, None))
        self.google.accounts.append("home")
        self.assertEqual([a["alias"] for a in self.app("google")["accounts"]], ["", "Home"], "the alias lands on the account that appeared")

    def test_a_link_that_is_not_https_or_too_long_or_carries_credentials_is_refused(self):
        for url in ("http://evil.test/o", "https://u:p@evil.test/o", "javascript:alert(1)", "https://x.test/" + "a" * 2100):
            class Odd(FakeGoogle):
                def start_sign_in(self, *a, **k):
                    return url
            with self.assertRaises(ConnectionError_, msg=url[:40]):
                run(bot_connections.authorize("google", "david", "http://127.0.0.1:8420/api", None, google=GoogleAdapter(Odd())))

    def test_google_without_a_client_id_is_a_409(self):
        self.google.is_configured = False
        with self.assertRaises(ConnectionError_) as raised:
            run(bot_connections.authorize("google", "david", "http://127.0.0.1:8420/api", None, google=GoogleAdapter(self.google)))
        self.assertEqual(raised.exception.status, 409)

    def test_a_catalogue_app_is_added_then_signed_in(self):
        class Oauth:
            def __init__(self):
                self.asked = []

            def status(self, item_id):
                return {"signed_in": False, "pending": False, "error": None}

            async def start_sign_in(self, item_id, redirect):
                self.asked.append((item_id, redirect))
                return {"url": "https://auth.linear.test/authorize?state=s1"}
        oauth = Oauth()
        result = run(bot_connections.authorize("catalog:linear", "david", "http://127.0.0.1:8420/api", mcp=McpAdapter(oauth=oauth)))
        self.assertEqual(result["url"], "https://auth.linear.test/authorize?state=s1")
        self.assertEqual(oauth.asked[0][1], "http://127.0.0.1:8420/api/integrations/oauth/callback")
        saved = [i for i in integrations.list_integrations() if i["kind"] == "mcp_server"]
        self.assertEqual([(s["name"], s["auth"]) for s in saved], [("linear", "oauth")])
        run(bot_connections.authorize("catalog:linear", "david", "http://127.0.0.1:8420/api", mcp=McpAdapter(oauth=oauth)))
        self.assertEqual(len([i for i in integrations.list_integrations() if i["kind"] == "mcp_server"]), 1, "adding twice makes one record")

    def test_an_app_that_needs_no_sign_in_says_so(self):
        item = integrations.create_mcp_server("open", "http", url="https://mcp.open.test/mcp")
        result = run(bot_connections.authorize(item["id"], "david", "http://127.0.0.1:8420/api"))
        self.assertEqual(result["added"], item["id"])

    def test_mailboxes_are_added_in_the_email_tab(self):
        with self.assertRaises(AdapterError) as raised:
            EmailAdapter(self.email).authorize("david", "http://127.0.0.1:8420/api")
        self.assertIn("Email tab", str(raised.exception))
        with self.assertRaises(ConnectionError_):
            bot_connections.disconnect("email", "m1", "david")

    def test_unknown_service_is_a_404(self):
        with self.assertRaises(ConnectionError_) as raised:
            run(bot_connections.authorize("nothing", "david", "http://127.0.0.1:8420/api"))
        self.assertEqual(raised.exception.status, 404)


class Disconnect(Base):
    def test_a_google_account_is_disconnected_and_its_alias_forgotten(self):
        self.google.accounts = ["work", "home"]
        with patch.object(bot_connections, "_app", lambda app_id, owner: self.app(app_id)):
            bot_connections.set_alias("google", "home", "Home")
        bot_connections.disconnect("google", "home", "david", google=GoogleAdapter(self.google))
        self.assertEqual(self.google.disconnected, ["home"])
        self.assertEqual(json.loads((Path(_DATA.name) / "bot-connections" / "aliases.json").read_text()), {})
        with self.assertRaises(ConnectionError_):
            bot_connections.disconnect("google", "ghost", "david", google=GoogleAdapter(self.google))

    def test_signing_out_of_an_mcp_server_keeps_its_record(self):
        item = integrations.create_mcp_server("acme", "http", url="https://mcp.acme.test/mcp", auth="oauth")
        signed = []
        oauth = types.SimpleNamespace(sign_out=lambda item_id: signed.append(item_id), status=lambda item_id: {"error": None})
        bot_connections.disconnect(item["id"], "server", "david", mcp=McpAdapter(oauth=oauth))
        self.assertEqual(signed, [item["id"]])
        self.assertIsNotNone(integrations.get_integration(item["id"]))


class Catalogue(Base):
    def test_effects_read_write_and_unknown(self):
        reads = ["search_emails", "list_events", "get_user", "readFile", "describe_table", "whoami", "gmail.read_email", "query_rows"]
        writes = ["send_email", "createDraft", "delete_issue", "update_record", "post_message", "list_and_archive", "run_query"]
        unknown = ["frobnicate", "sync_everything_now_x" if False else "do_thing", "magic"]
        for name in reads:
            self.assertEqual(catalog.effect_of(name), "read", name)
        for name in writes:
            self.assertEqual(catalog.effect_of(name), "write", name)
        for name in unknown:
            self.assertEqual(catalog.effect_of(name), "unknown", name)

    def test_the_servers_own_claim_wins_over_the_name(self):
        self.assertEqual(catalog.effect_of("delete_everything", True), "read")
        self.assertEqual(catalog.effect_of("list_things", False), "write")
        self.assertEqual(catalog.effect_of("magic", None), "unknown")

    def test_entries_for_the_grant_catalogue_use_integration_ids_and_classify_each_tool(self):
        item = integrations.create_mcp_server("acme", "http", url="https://mcp.acme.test/mcp")
        integrations.record_check(item["id"], tools=[{"name": "list_items", "description": "", "schema": {}, "read_only": True},
                                                     {"name": "delete_item", "description": "", "schema": {}},
                                                     {"name": "magic", "description": "", "schema": {}}])
        integrations.record_check(item["id"], tools=[{"name": "list_items", "description": "", "schema": {}, "read_only": True},
                                                     {"name": "delete_item", "description": "", "schema": {}},
                                                     {"name": "magic", "description": "changed", "schema": {}}])
        entry = next(e for e in bot_connections.catalogue_entries("david") if e["app_id"] == item["id"])
        tools = {t["name"]: t for t in entry["tools"]}
        self.assertEqual(tools["list_items"]["selector"], f"mcp:{item['id']}:list_items")
        self.assertEqual({n: t["effect"] for n, t in tools.items()}, {"list_items": "read", "delete_item": "write", "magic": "unknown"})
        self.assertTrue(tools["magic"]["held"] and not tools["delete_item"]["held"], "a changed tool is flagged held")


class Keys(Base):
    def test_a_key_is_write_only(self):
        saved = bot_keys.set_slot("github", "ghp_" + "a" * 36)
        self.assertEqual((saved["has_value"], saved["last4"]), (True, "a" * 4))
        self.assertNotIn("a" * 36, json.dumps(saved))
        self.assertNotIn("ghp_", (Path(_DATA.name) / "bot-keys.json").read_text(encoding="utf-8"), "stored encrypted")
        listed = json.dumps(bot_keys.list_slots())
        self.assertNotIn("a" * 36, listed)
        self.assertEqual(bot_keys.get_key("github"), "ghp_" + "a" * 36)
        self.assertFalse(bot_keys.clear_slot("github")["has_value"])
        self.assertIsNone(bot_keys.get_key("github"))

    def test_routes_never_return_the_value_and_the_shape_hint_is_a_warning_not_a_gate(self):
        put = web.put("/api/bots/keys/github", json={"value": SECRET})
        self.assertEqual(put.status_code, 200, put.text)
        self.assertNotIn(SECRET, put.text)
        self.assertIn("does not look like", put.json()["warning"])
        self.assertTrue(put.json()["has_value"])
        self.assertNotIn(SECRET, web.get("/api/bots/keys").text)
        self.assertNotIn(SECRET, web.get("/api/bots/keys/github").text)
        for bad in ("", "  ", "line\nbreak", "x" * 5000):
            self.assertIn(web.put("/api/bots/keys/github", json={"value": bad}).status_code, (400, 422), bad[:10])
        self.assertEqual(web.put("/api/bots/keys/nothing", json={"value": "abc"}).status_code, 404)
        self.assertEqual(web.put("/api/bots/keys/github", json={"value": "abc", "extra": 1}).status_code, 422)

    def test_groups_cover_the_page(self):
        groups = {row["group"] for row in bot_keys.list_slots()}
        self.assertTrue({"Servers", "Voice", "Computers", "Apps"} <= groups)
        self.assertEqual(bot_keys.GROUPS, ["AI", "Servers", "Voice", "Computers", "Apps", "Helpers"])
        self.assertTrue(any(r["group"] == "Helpers" for r in bot_keys.list_slots()))

    def test_a_test_returns_a_status_never_a_value_or_the_providers_reply(self):
        seen = []

        class Client:
            def __init__(self, status):
                self.status = status

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            async def request(self, method, url, headers=None, json=None):
                seen.append((method, url, dict(headers or {})))
                return types.SimpleNamespace(status_code=self.status, text=f"echo {SECRET}")
        bot_keys.set_slot("github", SECRET)
        ok = run(bot_keys.test_slot("github", client_factory=lambda: Client(200)))
        self.assertEqual((ok["ok"], ok["status"]), (True, "ok"))
        self.assertEqual(seen[0][:2], ("GET", "https://api.github.com/user"))
        self.assertEqual(seen[0][2]["Authorization"], f"Bearer {SECRET}", "the key goes to the provider only")
        refused = run(bot_keys.test_slot("github", client_factory=lambda: Client(401)))
        self.assertEqual(refused["status"], "refused")
        self.assertNotIn(SECRET, json.dumps([ok, refused]))

        class Down(Client):
            async def request(self, *a, **k):
                raise ConnectionError(f"could not reach with {SECRET}")
        down = run(bot_keys.test_slot("github", client_factory=lambda: Down(0)))
        self.assertEqual(down["status"], "unreachable")
        self.assertNotIn(SECRET, json.dumps(down))
        self.assertEqual(run(bot_keys.test_slot("exa", client_factory=lambda: Client(200)))["status"], "missing")
        typed = run(bot_keys.test_slot("exa", "typed-not-saved-key-1", client_factory=lambda: Client(200)))
        self.assertTrue(typed["ok"])
        self.assertFalse(bot_keys.get_slot("exa")["has_value"], "testing a typed key does not save it")

    def test_highlevel_needs_its_location_before_it_can_be_tested(self):
        bot_keys.set_slot("highlevel", "pit-" + "b" * 30)
        with self.assertRaises(bot_keys.KeyError_) as raised:
            run(bot_keys.test_slot("highlevel"))
        self.assertEqual(raised.exception.status, 409)
        saved = bot_keys.set_slot("highlevel-location", "loc_ABC123")
        self.assertEqual(saved["value"], "loc_ABC123", "a location id is not a secret")

    def test_the_test_route_for_a_model_connection_reports_in_the_same_shape(self):
        with patch("core.model_endpoints.get_endpoint", return_value={"id": "e1", "kind": "api"}), \
                patch("routes.model_routes.test_endpoint", return_value={"ok": True}):
            result = web.post("/api/bots/keys/model:e1/test", json={})
        self.assertEqual((result.status_code, result.json()["status"]), (200, "ok"))
        self.assertEqual(web.post("/api/bots/keys/model:missing/test", json={}).status_code, 404)


class ResourceSettings(Base):
    def setUp(self):
        super().setUp()
        folder = Path(_DATA.name) / "bot-resource-settings"
        if folder.exists():
            for f in folder.iterdir():
                f.unlink()
        settings_store.update_settings(helper_endpoint_id=None)

    def test_defaults_then_a_checked_change(self):
        first = bot_keys.resource_settings("david")
        self.assertEqual((first["tidy_time"], first["capture_quiet_minutes"], first["room_capture"], first["revision"]), ("03:00", 5, "off", 0))
        changed = bot_keys.update_resource_settings("david", {"tidy_time": "04:30", "capture_quiet_minutes": 10, "room_capture": "ask",
                                                              "timezone": "Europe/Paris", "skill_review": {"steps": 20}}, expected_revision=0)
        self.assertEqual((changed["tidy_time"], changed["capture_quiet_minutes"], changed["room_capture"], changed["revision"]), ("04:30", 10, "ask", 1))
        self.assertEqual(changed["skill_review"], {"enabled": True, "steps": 20})
        with self.assertRaises(bot_keys.KeyError_) as stale:
            bot_keys.update_resource_settings("david", {"tidy_time": "05:00"}, expected_revision=0)
        self.assertEqual(stale.exception.status, 409)

    def test_each_owner_has_their_own_document(self):
        bot_keys.update_resource_settings("david", {"tidy_time": "04:00"})
        self.assertEqual(bot_keys.resource_settings("eve")["tidy_time"], "03:00")
        self.assertEqual(len(list((Path(_DATA.name) / "bot-resource-settings").iterdir())), 1)

    def test_bounds(self):
        for patch_ in ({"tidy_time": "25:00"}, {"tidy_time": "3am"}, {"capture_quiet_minutes": 0}, {"capture_quiet_minutes": 61}, {"capture_quiet_minutes": True},
                       {"room_capture": "always"}, {"timezone": "Mars/Base"}, {"skill_review": {"steps": 2}}, {"skill_review": {"steps": 101}}, {"skill_review": {"x": 1}},
                       {"helper_model": "no-such-endpoint"}, {"surprise": 1}):
            with self.assertRaises(bot_keys.KeyError_, msg=str(patch_)):
                bot_keys.update_resource_settings("david", patch_)

    def test_the_helper_choice_writes_through_to_the_one_setting_helpers_read(self):
        with patch("core.model_endpoints.get_endpoint", return_value={"id": "local1", "kind": "local"}):
            changed = bot_keys.update_resource_settings("david", {"helper_model": "local1"})
        self.assertEqual((changed["helper_model"], settings_store.get_setting("helper_endpoint_id")), ("local1", "local1"))
        off = bot_keys.update_resource_settings("david", {"helper_model": "off"})
        self.assertEqual((off["helper_model"], settings_store.get_setting("helper_endpoint_id")), ("off", "off"))

    def test_routes(self):
        self.assertEqual(web.get("/api/bots/resource-settings").json()["revision"], 0)
        patched = web.patch("/api/bots/resource-settings", json={"tidy_time": "02:15", "expected_revision": 0})
        self.assertEqual((patched.status_code, patched.json()["tidy_time"]), (200, "02:15"))
        self.assertEqual(web.patch("/api/bots/resource-settings", json={"tidy_time": "02:20", "expected_revision": 0}).status_code, 409)
        self.assertEqual(web.patch("/api/bots/resource-settings", json={"tidy_time": "99:99"}).status_code, 400)
        self.assertEqual(web.patch("/api/bots/resource-settings", json={"unknown": 1}).status_code, 422)


class RoutesInventory(Base):
    def test_the_inventory_and_authorize_routes(self):
        bot_mcp_config.save({"name": "acme", "transport": "http", "url": "https://mcp.acme.test/mcp"})
        with patch("services.bot_connections.GoogleAdapter", lambda: GoogleAdapter(self.google)), patch("services.bot_connections.EmailAdapter", lambda: EmailAdapter(self.email)):
            listed = web.get("/api/bots/connections", params={"q": "acme"})
            self.assertEqual(listed.status_code, 200, listed.text)
            self.assertEqual([a["label"] for a in listed.json()["apps"]], ["acme"])
            self.assertEqual(web.get("/api/bots/connections", params={"q": "x" * 200}).status_code, 422)
            odd = web.post("/api/bots/connections/nothing/authorize", json={})
            self.assertEqual(odd.status_code, 404)
            self.assertEqual(web.post("/api/bots/connections/google/authorize", json={"surprise": 1}).status_code, 422)
        self.assertEqual(web.delete("/api/bots/connections/google/accounts/ghost").status_code in (404, 400, 409), True)


if __name__ == "__main__":
    unittest.main()
