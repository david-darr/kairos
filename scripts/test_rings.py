"""Rings: a bot rings the person inside Kairos (services/rings.py), with fakes only: no network, no real push.
Run: python scripts/test_rings.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-rings-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from core import accounts, bot_attention_store, bot_outbound, mobile_activity as push, web_push  # noqa: E402
from core.auth import auth_manager  # noqa: E402
from services import agent_calls, bot_attention, mobile_notifications, phone_tools, rings  # noqa: E402

BOT = {"id": "bot-kip", "name": "Kip"}
OTHER_BOT = {"id": "bot-ada", "name": "Ada"}
USERS = {"acct1": "alice", "acct2": "bob"}
T0 = 1_800_000_000.0


def subscription(endpoint):
    key = ec.generate_private_key(ec.SECP256R1())
    return {"endpoint": endpoint, "keys": {"p256dh": web_push.b64(web_push.public_key(key)), "auth": web_push.b64(os.urandom(16))}}


class RingCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = []
        bots = {BOT["id"]: BOT, OTHER_BOT["id"]: OTHER_BOT}
        for patcher in (
                patch.object(auth_manager, "username_for_account", lambda account: USERS.get(account)),
                patch.object(auth_manager, "is_admin", lambda user: True),
                patch.object(rings, "_bot", lambda account, bot_id, owner: bots[bot_id]),
                patch.object(bot_attention, "target_for", lambda agent_id, user, source=None: {"tab": "botsShell", "agentId": agent_id}),
                patch.object(bot_outbound, "DB_FILE", os.path.join(_DATA.name, f"out-{uuid.uuid4().hex}.sqlite3")),
                patch.object(bot_attention_store, "DB_FILE", os.path.join(_DATA.name, f"att-{uuid.uuid4().hex}.sqlite3")),
                patch.object(push, "DB_FILE", os.path.join(_DATA.name, f"push-{uuid.uuid4().hex}.db"))):
            patcher.start()
            self.stack.append(patcher)
        bot_outbound.reset_for_test()
        for account in USERS:
            path = os.path.join(accounts.account_dir(account), "rings.json")
            if os.path.exists(path):
                os.remove(path)

    async def asyncTearDown(self):
        for patcher in reversed(self.stack):
            patcher.stop()

    def ring(self, account="acct1", bot="bot-kip", reason="The build finished.", inv=None, now=T0):
        return rings.create(account, bot, reason, inv or uuid.uuid4().hex, now=now)

    def feed(self, user):
        return bot_attention_store.notifications(user)

    def enroll(self, owner, endpoint):
        sub = subscription(endpoint)
        return push.enroll(owner, sub, "local")


class LifecycleTests(RingCase):
    async def test_ring_then_answer_opens_the_call_with_the_reason(self):
        made = self.ring()
        self.assertEqual(made["status"], "ringing")
        self.assertEqual(made["expires_at"], T0 + rings.RING_SECONDS)
        shown = rings.pending("acct1", "alice", now=T0 + 5)
        self.assertEqual([(r["id"], r["bot_name"], r["reason"], r["seconds_left"]) for r in shown], [(made["id"], "Kip", "The build finished.", 55)])
        went = rings.answer("acct1", "alice", made["id"], now=T0 + 6)
        self.assertEqual((went["agent_id"], went["reason"], went["target"]), ("bot-kip", "The build finished.", {"tab": "botsShell", "agentId": "bot-kip"}))
        self.assertEqual(rings.pending("acct1", "alice", now=T0 + 7), [])
        self.assertEqual(rings.outcome("acct1", made["id"]), "answered")
        self.assertEqual(self.feed("alice"), [])      # an answered call leaves no missed-call item
        # the call is opened with that reason, and only for this bot
        self.assertEqual(rings.claim_opening("acct1", "alice", made["id"], "bot-kip"), "The build finished.")
        with self.assertRaises(ValueError):
            rings.claim_opening("acct1", "alice", made["id"], "bot-ada")

    async def test_the_call_record_carries_the_opening_and_the_bot_speaks_it(self):
        made = self.ring()
        rings.answer("acct1", "alice", made["id"], now=T0 + 1)
        with patch.object(agent_calls.chat_live, "require_session", lambda parent, user: {"agent_id": "bot-kip"}), \
                patch.object(agent_calls.agent_service, "get", lambda ident: dict(BOT)), \
                patch.object(agent_calls, "Conversation", lambda endpoint, model: object()), \
                patch.object(agent_calls, "_save", lambda call: None), \
                patch.object(accounts, "effective_account", lambda: "acct1"):
            call = agent_calls._calls  # noqa: F841 - the module keeps calls by id
            view = agent_calls.start("p" * 12, "bot-kip", "e1", None, "alice", ring_id=made["id"])
            record = agent_calls._calls[view["id"]]
            self.assertEqual(record["opening"], "The build finished.")
            self.assertIn("The build finished.", agent_calls._context(record)[0]["content"])
            self.assertEqual(agent_calls.open_with_reason(record).__name__, "turn")
            with self.assertRaises(HTTPException):     # someone else's, or an unknown, ring opens nothing
                agent_calls.start("p" * 12, "bot-kip", "e1", None, "bob", ring_id=made["id"])
            record["opening"] = ""
            with self.assertRaises(HTTPException):
                agent_calls.open_with_reason(record)
            agent_calls._calls.pop(view["id"], None)

    async def test_decline_leaves_a_missed_call_item_and_tells_the_bot(self):
        made = self.ring()
        rings.decline("acct1", "alice", made["id"], now=T0 + 3)
        self.assertEqual(rings.outcome("acct1", made["id"]), "declined")
        rows = self.feed("alice")
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["kind"], rows[0]["title"], rows[0]["body"], rows[0]["agent_id"]),
                         ("missed-call", "Declined call from Kip", "The build finished.", "bot-kip"))
        self.assertEqual(rows[0]["call_back"], {"ring_id": made["id"]})
        with self.assertRaises(HTTPException):         # a second decline, or an answer after, is too late
            rings.decline("acct1", "alice", made["id"], now=T0 + 4)

    async def test_timeout_becomes_a_missed_call_that_can_be_called_back(self):
        made = self.ring()
        self.assertEqual(rings.pending("acct1", "alice", now=T0 + rings.RING_SECONDS + 1), [])
        self.assertEqual(rings.outcome("acct1", made["id"]), "missed")
        rows = self.feed("alice")
        self.assertEqual([(r["kind"], r["title"]) for r in rows], [("missed-call", "Missed call from Kip")])
        went = rings.answer("acct1", "alice", made["id"], now=T0 + 600)       # Call back
        self.assertTrue(went["callback"])
        self.assertEqual(rings.claim_opening("acct1", "alice", made["id"], "bot-kip"), "The build finished.")
        with self.assertRaises(HTTPException):
            rings.answer("acct1", "alice", made["id"], now=T0 + rings.MISSED_KEEP_SECONDS + 100)

    async def test_the_bots_tool_waits_and_reports_how_it_ended(self):
        async def answer_soon():
            await asyncio.sleep(0.2)
            rings.answer("acct1", "alice", rings.pending("acct1", "alice")[0]["id"])
        with patch.object(rings, "outcome", wraps=rings.outcome):
            task = asyncio.create_task(answer_soon())
            result = await rings.ring_user("acct1", "bot-kip", "Look at this", "inv-a")
            await task
        self.assertIn("answered", result)
        async def decline_soon():
            await asyncio.sleep(0.2)
            rings.decline("acct1", "alice", rings.pending("acct1", "alice")[0]["id"])
        with patch.object(rings, "COOLDOWN_SECONDS", 0):
            task = asyncio.create_task(decline_soon())
            result = await rings.ring_user("acct1", "bot-kip", "Look again", "inv-b")
            await task
        self.assertIn("declined", result)
        self.assertIn("missed-call note", result)


class SafetyTests(RingCase):
    async def test_a_ring_reaches_only_its_own_accounts_user(self):
        made = self.ring("acct1")
        self.assertEqual(rings.owner_of("acct1"), "alice")
        self.assertEqual(rings.pending("acct1", "bob", now=T0 + 1), [])          # another user never sees it
        self.assertEqual(rings.pending("acct2", "bob", now=T0 + 1), [])          # nor does their own account
        for act in (rings.answer, rings.decline):
            with self.assertRaises(HTTPException) as caught:
                act("acct1", "bob", made["id"], now=T0 + 1)
            self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(ValueError):
            rings.claim_opening("acct1", "bob", made["id"], "bot-kip")
        # there is no address argument at all
        schema = next(spec for spec in phone_tools.TOOLS if spec["name"] == "ring_me")["schema"]
        self.assertEqual(list(schema["properties"]), ["reason"])
        self.assertFalse(schema["additionalProperties"])

    async def test_a_ring_never_goes_to_another_users_devices(self):
        self.enroll("alice", "https://web.push.apple.com/alice")
        self.enroll("bob", "https://web.push.apple.com/bob")
        made = self.ring("acct1")
        with push.database() as db:
            rows = [dict(r) for r in db.execute("SELECT o.*, d.owner FROM outbox o JOIN devices d ON d.id=o.device_id WHERE o.kind='bot_call'")]
        self.assertEqual([r["owner"] for r in rows], ["alice"])
        self.assertEqual(rows[0]["run_id"], made["id"])

    async def test_limits_one_at_a_time_a_pause_and_a_daily_cap_per_bot_and_account(self):
        first = self.ring(inv="i1")
        with self.assertRaises(rings.RingRefused) as caught:
            self.ring(bot="bot-ada", inv="i2", now=T0 + 5)       # still ringing
        self.assertIn("already ringing", str(caught.exception))
        rings.decline("acct1", "alice", first["id"], now=T0 + 6)
        with self.assertRaises(rings.RingRefused) as caught:
            self.ring(inv="i3", now=T0 + 10)                     # the pause between rings
        self.assertIn("moment ago", str(caught.exception))
        now = T0
        for n in range(2, rings.CAPS["bot"] + 1):                # the bot's own cap: 3 a day
            now += rings.COOLDOWN_SECONDS + rings.RING_SECONDS + 5
            rings.decline("acct1", "alice", self.ring(inv=f"b{n}", now=now)["id"], now=now + 1)
        now += rings.COOLDOWN_SECONDS + rings.RING_SECONDS + 5
        with self.assertRaises(rings.RingRefused) as caught:
            self.ring(inv="over", now=now)
        self.assertIn("per bot", str(caught.exception))
        for n in range(3):                                       # another bot has its own, up to the account's
            now += rings.COOLDOWN_SECONDS + rings.RING_SECONDS + 5
            rings.decline("acct1", "alice", self.ring(bot="bot-ada", inv=f"a{n}", now=now)["id"], now=now + 1)
        now += rings.COOLDOWN_SECONDS + rings.RING_SECONDS + 5
        with self.assertRaises(rings.RingRefused) as caught:
            self.ring(bot="bot-ada", inv="account-over", now=now)
        self.assertIn("per account", str(caught.exception))
        self.ring("acct2", inv="other-account", now=now)         # accounts do not share a count

    async def test_a_retried_call_reuses_its_ring_and_a_refusal_costs_nothing(self):
        first = self.ring(inv="same")
        again = self.ring(inv="same", now=T0 + 2)
        self.assertEqual(first["id"], again["id"])
        with self.assertRaises(rings.RingRefused):
            rings.create("acct2", "bot-kip", "   ", "blank")
        self.assertEqual(bot_outbound.usage("acct2", "ring:account", rings.CAPS["account"])["used"], 0)

    async def test_the_reason_is_trimmed_to_one_short_line(self):
        made = self.ring(reason="x\n" * 400)
        self.assertLessEqual(len(made["reason"]), rings.MAX_REASON)
        self.assertNotIn("\n", made["reason"])


class PushTests(RingCase):
    async def test_push_payload_shape_and_a_fake_sender(self):
        device = self.enroll("alice", "https://web.push.apple.com/alice")
        made = self.ring("acct1", now=time.time())
        sent = []

        def handler(request):
            sent.append(request)
            return httpx.Response(201)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with patch.object(push, "config", lambda *a, **k: {"private": web_push.b64(os.urandom(32)), "public": "x", "subject": "mailto:t@example.com"}), \
                    patch.object(accounts, "account_for_user", lambda user: "acct1"), \
                    patch.object(web_push, "authorization", lambda *a: "vapid fake"), \
                    patch.object(web_push, "encrypt", lambda sub, body: body), \
                    patch.object(mobile_notifications.auth_manager, "notification_session_valid", lambda *a: True), \
                    patch.object(mobile_notifications, "_authorized_device", lambda item: True):
                await mobile_notifications.deliver_due(client)
        self.assertEqual(len(sent), 1)
        body = json.loads(sent[0].content)
        self.assertEqual(body, {"kind": "bot_call", "url": f"/?agent=bot-kip&ring={made['id']}", "tag": f"kairos-ring-{made['id']}",
                                "ring_id": made["id"], "body": "Kip is calling you.", "expires_at": made["expires_at"]})
        self.assertNotIn("build", json.dumps(body), "the lock screen says who, never why")
        self.assertEqual(sent[0].headers["Urgency"], "high")
        self.assertEqual(sent[0].headers["Authorization"], "vapid fake")
        self.assertTrue(int(sent[0].headers["TTL"]) <= rings.RING_SECONDS)

    async def test_a_ring_that_ended_is_not_pushed_and_the_pref_turns_it_off(self):
        device = self.enroll("alice", "https://web.push.apple.com/alice")
        made = self.ring("acct1")
        rings.decline("acct1", "alice", made["id"], now=T0 + 1)
        self.assertEqual(push.due(), [])                         # withdrawn when it ended
        other = self.enroll("alice", "https://web.push.apple.com/alice2")
        prefs = {"completed": True, "failed": True, "permission": True, "bot_needs_you": True, "bot_results": True, "bot_calls": False}
        push.change_device("alice", device, prefs)
        push.change_device("alice", other, prefs)
        self.ring("acct1", inv="second", now=T0 + 1000)
        with push.database() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM outbox WHERE kind='bot_call' AND status='pending'").fetchone()[0], 0)

    async def test_the_delivery_check_drops_a_ring_that_is_no_longer_ringing(self):
        self.enroll("alice", "https://web.push.apple.com/alice")
        made = self.ring("acct1", now=time.time() - 1000)       # long past its minute
        with push.database() as db:
            db.execute("UPDATE outbox SET expires=?", (T0 + 10 ** 9,))
        item = {"owner": "alice", "run_id": made["id"]}
        with patch.object(accounts, "account_for_user", lambda user: "acct1"):
            self.assertFalse(mobile_notifications._still_ringing(item))


class ToolTests(RingCase):
    def ctx(self, inv):
        from core import tool_registry
        return tool_registry.ToolContext(agent_id="bot-kip", owner_user="alice", invocation_id=inv)

    async def test_ring_me_is_registered_outbound_and_asks_like_other_sends(self):
        from core import bot_policy, tool_registry
        for name, args in (("ring_me", {"reason": "x"}), ("notify_me_by_call", {"message": "x"})):
            self.assertIn(name, tool_registry._REGISTRY)
            self.assertEqual(bot_policy.classify(name, args).kind, bot_policy.OUTBOUND)

    async def test_notify_me_by_call_rings_in_the_app_when_there_is_no_phone_connection(self):
        started = []

        async def fake_ring(account, bot_id, reason, ident, wait=True):
            started.append((account, bot_id, reason))
            return "They answered."
        with patch.object(accounts, "effective_account", lambda: "acct1"), \
                patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}), \
                patch.object(rings, "ring_user", fake_ring), \
                patch.object(phone_tools.phone_connection, "get", lambda account=None: None):
            result = await phone_tools.tool_call({"message": "Deploy is done"}, self.ctx("n1"))
        self.assertEqual(result, "They answered.")
        self.assertEqual(started, [("acct1", "bot-kip", "Deploy is done")])

    async def test_notify_me_by_call_prefers_a_working_phone_connection(self):
        placed = []

        async def fake_call(account, bot_id, message, ident):
            placed.append(message)
            return "Calling you now."
        record = {"enabled": True, "provider": "twilio", "public_url": "https://x"}
        with patch.object(accounts, "effective_account", lambda: "acct1"), \
                patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}), \
                patch.object(phone_tools.phone_calls, "call_user", fake_call), \
                patch.object(phone_tools.phone_connection, "get", lambda account=None: record), \
                patch.object(phone_tools.phone_connection, "calls_ready", lambda rec: True):
            result = await phone_tools.tool_call({"message": "Hello"}, self.ctx("n2"))
        self.assertEqual((result, placed), ("Calling you now.", ["Hello"]))

    async def test_ring_me_refusals_come_back_as_not_sent(self):
        with patch.object(accounts, "effective_account", lambda: "acct1"), \
                patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}):
            first = await asyncio.wait_for(phone_tools.tool_ring({"reason": ""}, self.ctx("r0")), 2)
        self.assertTrue(first.startswith("Not sent:"), first)


if __name__ == "__main__":
    unittest.main()
