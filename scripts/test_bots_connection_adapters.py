"""Bots Phase 2, unit U5: app adapters, HighLevel's restricted CRM surface and X research (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, section 4.5 and 7 (U5).
Stand-in upstream services only; nothing leaves this computer. Run: python scripts/test_bots_connection_adapters.py
"""
import asyncio
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-adapters-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import bot_app_adapters, bot_highlevel, bot_keys, bot_x_research  # noqa: E402
from services.bot_app_adapters import AdapterError, GoogleAdapter  # noqa: E402

BOT = "0123456789"
TOKEN = "pit-0123456789abcdef0123456789abcdef"
LOCATION = "loc_ABC123"


def run(coroutine):
    return asyncio.run(coroutine)


class Upstream:
    """A client factory that records requests and answers from a script."""
    def __init__(self, status=200, body=None):
        self.status, self.body, self.requests = status, body if body is not None else {"ok": True}, []

    def __call__(self):
        outer = self

        class Client:
            async def __aenter__(self_):
                return self_

            async def __aexit__(self_, *a):
                return False

            async def request(self_, method, url, params=None, json=None, headers=None):
                outer.requests.append({"method": method, "url": url, "params": params, "json": json, "headers": dict(headers or {})})
                return types.SimpleNamespace(status_code=outer.status, json=lambda: outer.body)

            async def get(self_, url, params=None, headers=None):
                return await self_.request("GET", url, params=params, headers=headers)
        return Client()


class HighLevel(unittest.TestCase):
    def setUp(self):
        activity = Path(_DATA.name) / "bot-activity" / "highlevel.jsonl"
        if activity.exists():
            activity.unlink()
        self.limiter = bot_highlevel.Limiter(clock=lambda: self.now)
        self.now = 0.0

    def call(self, tool, args, upstream=None, **kw):
        upstream = upstream or Upstream()
        text = run(bot_highlevel.call(tool, args, bot_id=BOT, token=TOKEN, location=LOCATION, client_factory=upstream, limiter_=self.limiter, **kw))
        return text, upstream

    def test_twenty_tools_in_four_groups_of_five(self):
        tools = bot_highlevel.describe_tools()
        self.assertEqual(len(tools), 20)
        for group in ("contacts", "notes", "calendar", "pipelines"):
            self.assertEqual(sum(1 for t in tools if t["group"] == group), 5, group)
        self.assertEqual({t["effect"] for t in tools}, {"read", "write"})

    def test_a_read_builds_the_request_from_the_table_not_from_model_text(self):
        text, up = self.call("highlevel_search_contacts", {"query": "dana", "limit": 500})
        request = up.requests[0]
        self.assertEqual((request["method"], request["url"]), ("GET", "https://services.leadconnectorhq.com/contacts/"))
        self.assertEqual(request["params"], {"query": "dana", "limit": 50, "locationId": LOCATION})
        self.assertEqual(request["headers"]["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(request["headers"]["Version"], "2021-07-28")
        self.assertIn("UNTRUSTED", text, "results are fenced as untrusted data")
        self.assertNotIn(TOKEN, text)

    def test_ids_are_validated_so_a_path_cannot_be_smuggled_in(self):
        for bad in ("../messages", "a/b", "x" * 65, "", "a b", "id?x=1"):
            text, up = self.call("highlevel_get_contact", {"contact_id": bad})
            self.assertEqual(up.requests, [], bad)
            self.assertIn("needs a valid contact_id", text)

    def test_unknown_tools_and_unknown_arguments_are_refused(self):
        self.assertIn("not a HighLevel tool", self.call("highlevel_send_sms", {})[0])
        text, up = self.call("highlevel_get_contact", {"contact_id": "abc", "path": "/conversations/messages"})
        self.assertEqual(up.requests, [])
        self.assertIn("does not take", text)

    def test_nothing_that_messages_campaigns_workflows_or_payments_can_be_reached(self):
        for path in ("/conversations/messages", "/conversations/messages/outbound", "/campaigns/", "/workflows/abc/enroll", "/payments/orders",
                     "/invoices/", "/orders", "/transactions", "/subscriptions", "/emails/builder", "/sms", "/funnels/", "/contacts/abc/campaigns/xyz"):
            with self.assertRaises(bot_highlevel.HighLevelError, msg=path) as raised:
                bot_highlevel.guard_path(path)
            self.assertEqual(raised.exception.status, 403)
        for path in ("/contacts/", "/contacts/abc/notes", "/calendars/events/appointments", "/opportunities/search", "/opportunities/pipelines"):
            self.assertEqual(bot_highlevel.guard_path(path), path)
        for tool, spec in bot_highlevel.TOOLS.items():
            built = bot_highlevel._build(tool, {k: "abc" for k in bot_highlevel.ID_FIELDS}, LOCATION)
            self.assertEqual(built["effect"], spec["effect"], tool)

    def test_every_write_leaves_an_activity_row_and_a_read_does_not(self):
        self.call("highlevel_search_contacts", {"query": "x"})
        self.assertEqual(bot_highlevel.activity(), [])
        self.call("highlevel_add_contact_note", {"contact_id": "c1", "body": "Called back, wants a quote"})
        self.call("highlevel_update_contact", {"contact_id": "c2", "email": "new@x.test"}, Upstream(status=500))
        rows = bot_highlevel.activity()
        self.assertEqual([(r["tool"], r["ok"]) for r in rows], [("highlevel_update_contact", False), ("highlevel_add_contact_note", True)])
        self.assertEqual(rows[1]["bot_id"], BOT)
        self.assertNotIn("Called back", json.dumps(rows), "the note text is not copied into the activity log")
        self.assertNotIn(TOKEN, json.dumps(rows))

    def test_ninety_calls_in_ten_seconds_then_the_next_waits(self):
        for _ in range(90):
            self.assertNotIn("limited", self.call("highlevel_list_calendars", {})[0])
        text, up = self.call("highlevel_list_calendars", {})
        self.assertIn("limited to 90 every 10 seconds", text)
        self.assertEqual(up.requests, [], "a limited call is never sent")
        self.now += 10.0
        self.assertNotIn("limited", self.call("highlevel_list_calendars", {})[0])
        self.assertEqual(len(self.limiter._stamps), 1)

    def test_a_bots_tool_selection_and_the_connection_are_respected(self):
        text, up = self.call("highlevel_add_contact_note", {"contact_id": "c1", "body": "x"}, allowed_tools={"highlevel_get_contact"})
        self.assertIn("does not include", text)
        self.assertEqual(up.requests, [])
        missing = run(bot_highlevel.call("highlevel_list_calendars", {}, bot_id=BOT, token=None, location=None, client_factory=Upstream()))
        self.assertIn("not connected", missing)

    def test_failures_and_big_results_are_plain_and_bounded(self):
        text, _ = self.call("highlevel_get_contact", {"contact_id": "c1"}, Upstream(status=401))
        self.assertIn("did not complete", text)
        self.assertNotIn(TOKEN, text)
        big, _ = self.call("highlevel_search_contacts", {"query": "x"}, Upstream(body={"contacts": ["z" * 100] * 500}))
        self.assertIn("[cut at 8000", big)

        class Boom(Upstream):
            def __call__(self):
                raise ConnectionError(f"failed {TOKEN}")
        down, _ = self.call("highlevel_get_contact", {"contact_id": "c1"}, Boom())
        self.assertNotIn(TOKEN, down)

    def test_body_values_are_bounded(self):
        text, up = self.call("highlevel_add_contact_tags", {"contact_id": "c1", "tags": ["a"] * 21})
        self.assertEqual(up.requests, [])
        self.assertIn("not a usable value", text)
        text, up = self.call("highlevel_create_contact", {"firstName": "Ana", "tags": ["lead"]})
        self.assertEqual(up.requests[0]["json"], {"firstName": "Ana", "tags": ["lead"], "locationId": LOCATION})


class XResearch(unittest.TestCase):
    def setUp(self):
        self.limiter = bot_x_research._Limiter(clock=lambda: self.now)
        self.now = 0.0

    def call(self, tool, args, upstream=None, **kw):
        upstream = upstream or Upstream(body={"data": []})
        return run(bot_x_research.call(tool, args, token="x-bearer-secret-0123456789", client_factory=upstream, limiter_=self.limiter, **kw)), upstream

    def test_five_read_only_tools(self):
        tools = bot_x_research.describe_tools()
        self.assertEqual(len(tools), 5)
        self.assertEqual({t["effect"] for t in tools}, {"read"})

    def test_search_is_bounded_and_the_key_goes_only_to_the_provider(self):
        text, up = self.call("x_search_recent", {"query": "kairos app", "max_results": 1000})
        request = up.requests[0]
        self.assertEqual(request["url"], "https://api.x.com/2/tweets/search/recent")
        self.assertEqual(request["params"]["max_results"], 25)
        self.assertEqual(request["headers"]["Authorization"], "Bearer x-bearer-secret-0123456789")
        self.assertNotIn("x-bearer-secret", text)
        self.assertIn("UNTRUSTED", text)

    def test_arguments_are_validated(self):
        for tool, args in (("x_search_recent", {"query": ""}), ("x_search_recent", {"query": "a" * 513}), ("x_search_recent", {"query": "line\nbreak"}),
                           ("x_user", {"username": "no spaces"}), ("x_user", {"username": "x" * 16}), ("x_post", {"id": "12ab"}), ("x_post", {"id": "../x"}),
                           ("x_count_recent", {"query": "q", "granularity": "year"}), ("x_search_recent", {"query": "q", "path": "/x"}), ("x_delete", {})):
            text, up = self.call(tool, args)
            self.assertEqual(up.requests, [], (tool, args))
            self.assertNotIn("Traceback", text)

    def test_results_are_cut_to_bounds(self):
        posts = [{"id": str(i), "text": "t" * 5000} for i in range(100)]
        text, _ = self.call("x_search_recent", {"query": "q"}, Upstream(body={"data": posts}))
        payload = text.split(">>>\n", 1)[1].rsplit("\n<<<", 1)[0]
        self.assertLessEqual(len(payload), bot_x_research.MAX_RESULT + 80)
        self.assertIn("[cut at", payload)
        self.assertNotIn("t" * (bot_x_research.POST_CHARS + 1), payload, "each post is cut to 600 characters")
        self.assertLessEqual(payload.count('"id"'), bot_x_research.MAX_POSTS, "at most 25 posts")

    def test_a_profiles_posts_resolve_the_id_first_and_ask_for_original_posts_only(self):
        class Two(Upstream):
            def __call__(self):
                outer = self

                class Client:
                    async def __aenter__(self_):
                        return self_

                    async def __aexit__(self_, *a):
                        return False

                    async def get(self_, url, params=None, headers=None):
                        outer.requests.append({"url": url, "params": params})
                        body = {"data": {"id": "12345"}} if "/users/by/" in url else {"data": [{"id": "1", "text": "hi"}]}
                        return types.SimpleNamespace(status_code=200, json=lambda: body)
                return Client()
        up = Two()
        text, _ = self.call("x_user_posts", {"username": "@kairos", "max_results": 7}, up)
        self.assertEqual([r["url"] for r in up.requests], ["https://api.x.com/2/users/by/username/kairos", "https://api.x.com/2/users/12345/tweets"])
        self.assertEqual(up.requests[1]["params"]["exclude"], "retweets,replies")
        self.assertEqual(up.requests[1]["params"]["max_results"], 7)
        self.assertIn('"hi"', text)

    def test_limits_selection_and_missing_key(self):
        for _ in range(60):
            self.call("x_user", {"username": "kairos"})
        text, up = self.call("x_user", {"username": "kairos"})
        self.assertIn("limited to 60", text)
        self.assertEqual(up.requests, [])
        self.assertIn("does not include", self.call("x_user", {"username": "kairos"}, allowed_tools={"x_post"})[0])
        self.assertIn("not connected", run(bot_x_research.call("x_user", {"username": "kairos"}, token=None, client_factory=Upstream())))
        self.limiter = bot_x_research._Limiter(clock=lambda: self.now)
        text, _ = self.call("x_user", {"username": "kairos"}, Upstream(status=429))
        self.assertIn("limiting", text)


class Adapters(unittest.TestCase):
    def test_bounded_link(self):
        self.assertEqual(bot_app_adapters.bounded_link("https://a.test/x?y=1"), "https://a.test/x?y=1")
        for bad in (None, "", 5, "http://a.test/x", "https://u:p@a.test/x", "https://a.test/" + "x" * 2050):
            with self.assertRaises(AdapterError, msg=str(bad)[:30]):
                bot_app_adapters.bounded_link(bad)

    def test_google_reconnect_passes_the_account_and_never_adds(self):
        seen = []

        class G:
            class GoogleError(Exception):
                status = 400

            def status(self, user):
                return {"configured": True, "accounts": [{"id": "work", "email": "w@x.test", "default": True, "error": "expired"}]}

            def start_sign_in(self, redirect, owner, add, account_id):
                seen.append((add, account_id))
                return "https://accounts.google.test/auth?state=1"
        adapter = GoogleAdapter(G())
        self.assertEqual(adapter.accounts("david")[0]["status"], "error")
        adapter.authorize("david", "http://127.0.0.1:8420/api", None, "work")
        self.assertEqual(seen, [(False, "work")], "reconnecting an account does not add a new one")


if __name__ == "__main__":
    unittest.main()
