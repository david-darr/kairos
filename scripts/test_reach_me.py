"""Reach me (Kairos 2.3.0 plan, item 3): where bots message and call the person, with fallback, quiet hours, a per-bot
choice, the daily caps and send policy, the one STOP across channels, Telegram voice messages and WhatsApp templates.

Every provider is a local mock (httpx.MockTransport standing in for api.telegram.org, graph.facebook.com, api.twilio.com,
a BlueBubbles and a signal-cli server); nothing is sent anywhere and nothing is signed into. The Telegram voice note is
packed by the real FFmpeg when it is installed (skipped otherwise).

    .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_reach_me.py
"""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qsl, urlencode

_DATA = tempfile.TemporaryDirectory(prefix="kairos-reach-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
import numpy as np  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from core import accounts, bot_outbound, outbox, phone_connection as connection, phone_providers, reach_me, reach_voice  # noqa: E402
from core.connectors import KINDS, hub, store  # noqa: E402
from core.connectors.base import Inbound  # noqa: E402
from core.connectors.platforms import webhooks  # noqa: E402
from services import phone_calls, phone_tools, reach_me as reach  # noqa: E402

A1, A2 = "acct1", "acct2"
BOT = {"id": "bot-kip", "name": "Kip", "voice_id": None}
ME_TG, ME_WA, ME_SMS, ME_SIG = "4242", "15557770001", "+15557770001", "+15557770009"
BASE = "https://kairos.example.net"


class FakeAPIs:
    """Every provider the channels talk to, answering like the real ones; records each request."""

    def __init__(self):
        self.requests = []
        self.fail = set()          # hosts that answer 500
        self.wa_closed = False     # Meta refuses free text: more than 24 hours since the person wrote
        self.transport = httpx.MockTransport(self.handle)

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append({"url": url, "body": request.content, "headers": dict(request.headers)})
        if request.url.host in self.fail:
            return httpx.Response(500, text="down")
        if "graph.facebook.com" in url:
            body = json.loads(request.content)
            if self.wa_closed and body.get("type") == "text":
                return httpx.Response(400, json={"error": {"code": 131047, "message": "Re-engagement message"}})
            return httpx.Response(200, json={"messages": [{"id": "wamid." + uuid.uuid4().hex[:6]}]})
        if url.endswith("Messages.json"):
            return httpx.Response(201, json={"sid": "SMfake"})
        return httpx.Response(200, json={"ok": True, "result": {}})

    def to(self, part):
        return [r for r in self.requests if part in r["url"]]


def connector(account, kind, name, values, allowed, open_=False):
    with accounts.as_account(account):
        return store.create(kind, name, values, KINDS[kind].fields, allowed, open_, None)


class ReachCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.api = FakeAPIs()
        self.old_transport = hub.transport
        hub.transport = self.api.transport
        phone_calls.TRANSPORT = self.api.transport
        self.pushed, self.feed = [], []
        self.stack = [
            patch.object(bot_outbound, "DB_FILE", os.path.join(_DATA.name, f"out-{uuid.uuid4().hex}.sqlite3")),
            patch.object(bot_outbound, "owner_zone", lambda owner: "UTC"),
            patch.object(reach, "_bot", lambda account, bot_id, strict=True: dict(BOT, id=bot_id)),
            patch.object(connection, "accounts_to_scan", lambda: [A1, A2]),
            patch("core.bot_attention_store.publish", lambda owner, source, row: self.feed.append((owner, row)) or row),
            patch("core.mobile_activity.enqueue_bot", lambda kind, agent, allowed: self.pushed.append((kind, agent))),
            patch("services.bot_attention.target_for", lambda *a, **k: None),
            patch.object(reach, "_app_reachable", lambda account: (self.app_ready, "test")),
        ]
        self.app_ready = False
        for item in self.stack:
            item.start()
        bot_outbound.reset_for_test()
        for record in list(store.list_records()):
            store.delete(record["id"])
        for account in (A1, A2):
            connection.delete(account)
            path = reach_me._file(account)
            if os.path.exists(path):
                os.remove(path)
        self.tg = connector(A1, "telegram", "My Telegram", {"bot_token": "123:abc", "default_chat_id": ME_TG}, [ME_TG])
        self.wa = connector(A1, "whatsapp", "My WhatsApp", {"phone_number_id": "PN1", "access_token": "wa-token", "app_secret": "wa-secret",
                                                            "verify_token": "v", "default_to": ME_WA}, [ME_WA])
        self.ctx_n = 0

    async def asyncTearDown(self):
        hub.transport = self.old_transport
        phone_calls.TRANSPORT = None
        for item in reversed(self.stack):
            item.stop()
        for record in list(store.list_records()):
            store.delete(record["id"])

    def order(self, account=A1, **patch_):
        reach_me.save(patch_, account)

    def inv(self):
        self.ctx_n += 1
        return f"inv-{self.ctx_n}-{uuid.uuid4().hex[:4]}"

    async def message(self, text="Your build finished.", account=A1, bot="bot-kip"):
        try:
            return await reach.message_me(account, bot, text, self.inv())
        except reach.ReachRefused as error:
            return f"Not sent: {error}"

    async def call(self, text="Build is broken.", account=A1):
        try:
            return await reach.call_me(account, "bot-kip", text, self.inv())
        except reach.ReachRefused as error:
            return f"Not sent: {error}"

    def outbox_rows(self, account=A1):
        from core import session_manager_store as sstore
        with accounts.as_account(account), sstore.transaction() as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM deliveries WHERE channel LIKE 'reach:%' ORDER BY created_at")]


class OrderAndFallback(ReachCase):
    async def test_the_first_way_that_takes_it_wins_and_skipped_ways_are_recorded_without_the_text(self):
        self.order(message=["telegram", "whatsapp", "sms"])
        self.api.fail.add("api.telegram.org")
        result = await self.message("Your build finished.")
        self.assertTrue(result.startswith("Sent to the person: WhatsApp"), result)
        self.assertIn("Skipped first: Telegram", result)
        sent = json.loads(self.api.to("graph.facebook.com")[-1]["body"])
        self.assertEqual((sent["to"], sent["type"], sent["text"]["body"]), (ME_WA, "text", "Your build finished."))
        log = reach_me.load(A1)["log"][-1]
        self.assertEqual((log["channel"], log["ok"], [t["channel"] for t in log["tried"]]), ("whatsapp", True, ["telegram"]))
        self.assertNotIn("Your build finished", json.dumps(reach_me.load(A1)), "the text is never kept in Reach me")
        self.assertEqual(self.outbox_rows()[-1]["status"], "delivered")

    async def test_telegram_first_signs_with_the_bots_name(self):
        self.order(message=["telegram", "whatsapp"])
        self.assertTrue((await self.message("Done.")).startswith("Sent to the person: Telegram"))
        body = json.loads(self.api.to("sendMessage")[-1]["body"])
        self.assertEqual((body["chat_id"], body["text"]), (ME_TG, "Kip: Done."))
        self.assertEqual(self.api.to("graph.facebook.com"), [])

    async def test_ways_not_set_up_are_skipped_and_nothing_set_up_is_refused_before_anything_is_spent(self):
        self.order(message=["signal", "imessage", "sms"])
        result = await self.message()
        self.assertTrue(result.startswith("Not sent: None of the ways"), result)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(bot_outbound.usage(A1, "phone:bot-kip:text", 10)["used"], 0)

    async def test_imessage_signal_and_sms_each_deliver(self):
        connector(A1, "bluebubbles", "Mac", {"server_url": "http://bb.local:1234", "password": "pw", "default_chat": "iMessage;-;+15557770001"}, ["+15557770001"])
        connector(A1, "signal", "Sig", {"api_url": "http://sig.local:8080", "number": "+15550001111", "default_recipient": ME_SIG}, [ME_SIG])
        connector(A1, "sms", "SMS", {"account_sid": "ACsms", "auth_token": "t", "from_number": "+15550003333", "public_url": BASE + "/x",
                                     "default_to": ME_SMS}, [ME_SMS])
        for channel, part in (("imessage", "bb.local"), ("signal", "sig.local"), ("sms", "Messages.json")):
            self.order(message=[channel])
            result = await self.message("Hi")
            self.assertTrue(result.startswith("Sent to the person"), (channel, result))
            self.assertIn(b"Kip: Hi", self.api.to(part)[-1]["body"].replace(b"%3A+", b": ").replace(b"+", b" "))

    async def test_when_every_way_fails_the_app_feed_keeps_it(self):
        self.order(message=["telegram", "app"])
        self.api.fail.add("api.telegram.org")
        result = await self.message("Look at this.")
        self.assertIn("In the Kairos app", result)
        self.assertIn("left in the app", result)
        self.assertEqual(self.feed[-1][1]["kind"], "message")
        self.assertEqual(self.feed[-1][1]["body"], "Look at this.")
        self.assertEqual(self.pushed, [("bot_results", "bot-kip")])

    async def test_the_app_first_when_someone_will_see_it(self):
        self.app_ready = True
        self.order(message=["app", "telegram"])
        self.assertTrue((await self.message()).startswith("Sent to the person: In the Kairos app"))
        self.assertEqual(self.api.requests, [])

    async def test_with_no_app_in_the_order_the_outbox_retries_the_whole_order_once_it_works(self):
        self.order(message=["telegram"])
        self.api.fail.add("api.telegram.org")
        result = await self.message("Later.")
        self.assertTrue(result.startswith("Not delivered yet"), result)
        row = self.outbox_rows()[-1]
        self.assertEqual((row["status"], row["channel"]), ("pending", "reach:bot-kip"))
        self.api.fail.clear()
        with accounts.as_account(A1):
            sent = await outbox.send_due(now=time.time() + 120)
        self.assertEqual(sent, 1)
        self.assertEqual(self.outbox_rows()[-1]["status"], "delivered")
        self.assertEqual(len([r for r in self.api.to("sendMessage") if r["body"] and b"Later." in r["body"]]), 2,
                         "one failed try, then one delivery: never a second copy")

    async def test_a_bot_can_use_its_own_order_or_never(self):
        self.order(message=["telegram", "whatsapp"], bots={"bot-kip": {"message": ["whatsapp"], "call": []}})
        self.assertTrue((await self.message()).startswith("Sent to the person: WhatsApp"))
        self.assertEqual(self.api.to("sendMessage"), [])
        self.assertIn("turned off calls from this bot", await self.call())
        self.order(bots={"bot-kip": {"message": []}})
        self.assertIn("turned off messages from this bot", await self.message())
        self.assertEqual(reach_me.order_for("other-bot", "message", A1), ["telegram", "whatsapp"])

    def test_orders_are_validated(self):
        for bad in ({"message": ["fax"]}, {"call": ["sms"]}, {"quiet": {"enabled": True, "start": "25:00", "end": "07:00"}},
                    {"quiet": {"enabled": True, "start": "07:00", "end": "07:00"}}, {"bots": {"../x": {"message": []}}}):
            with self.assertRaises(ValueError, msg=bad):
                reach_me.save(bad, A1)
        self.assertEqual(reach_me.save({"message": ["sms", "sms", "app"]}, A1)["message"], ["sms", "app"])


class CallOrder(ReachCase):
    async def test_a_provider_refusal_falls_to_the_next_way_and_a_limit_does_not(self):
        rang = []

        async def ring(account, bot_id, reason, ident, **_how):
            rang.append(reason)
            return "They answered."

        async def refused(account, bot_id, reason, ident):
            raise phone_calls.PhoneRefused("Placing the call failed (401)")

        async def limited(account, bot_id, reason, ident):
            raise phone_calls.PhoneLimit("Today's limit for calls to you (6 per account) is used up.")
        self.order(call=["phone", "app"])
        with patch.object(reach, "_phone_ready", lambda account: True), patch("services.rings.ring_user", ring):
            with patch.object(phone_calls, "call_user", refused):
                self.assertEqual(await self.call(), "They answered.")
            with patch.object(phone_calls, "call_user", limited):
                self.assertIn("limit", await self.call())
        self.assertEqual(len(rang), 1)
        self.assertEqual(reach_me.load(A1)["log"][-1]["channel"], "phone")

    async def test_nothing_set_up_says_why_for_each_way(self):
        self.order(call=["phone", "discord"])
        result = await self.call()
        self.assertTrue(result.startswith("Not sent: No way to call the person worked"), result)
        self.assertIn("Phone call:", result)
        self.assertIn("Discord voice channel:", result)


class NamedWay(ReachCase):
    """`via` (2026-11-11): the person named a way in their own words ("call me on Discord"). It goes first; their
    order follows only when it is not set up or fails, and the result says so. Same limits, quiet hours and STOP."""

    def discord(self, outcome="They joined #voice. The call is open now, so carry on there.", ready=True):
        from services import discord_voice as dv
        joined = []

        async def call_user(account, bot_id, reason, ident):
            joined.append(reason)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        def pick_bot(account):
            if not ready:
                raise dv.VoiceRefused("Voice in Discord is off. Choose a voice channel for the Discord bot in Settings, Channels.",
                                      unavailable=True)
            return {"id": "discord-bot"}
        return joined, [patch.object(dv, "call_user", call_user), patch.object(dv, "pick_bot", pick_bot)]

    async def named_call(self, via, ask=False):
        try:
            return await reach.call_me(A1, "bot-kip", "Your deploy failed.", self.inv(), ask=ask, via=via)
        except reach.ReachRefused as error:
            return f"Not sent: {error}"

    async def test_call_me_on_discord_goes_to_discord_first_whatever_the_order(self):
        self.order(call=["phone", "app", "discord"])
        joined, patches = self.discord()
        phoned = AsyncMock(return_value="phoned")
        with patches[0], patches[1], patch.object(reach, "_phone_ready", lambda account: True), \
                patch.object(phone_calls, "call_user", phoned):
            result = await self.named_call("discord")
        self.assertEqual(result, "They joined #voice. The call is open now, so carry on there.")
        self.assertEqual(joined, ["Your deploy failed."])
        phoned.assert_not_called()
        log = reach_me.load(A1)["log"][-1]
        self.assertEqual((log["channel"], log["via"], log["ok"]), ("discord", "discord", True))
        self.assertEqual(reach_me.load(A1)["call"], ["phone", "app", "discord"], "the person's order is not changed")

    async def test_discord_not_set_up_falls_to_their_order_and_says_so(self):
        self.order(call=["phone", "app", "discord"])
        joined, patches = self.discord(ready=False)
        with patches[0], patches[1], patch.object(reach, "_phone_ready", lambda account: True), \
                patch.object(phone_calls, "call_user", AsyncMock(return_value="Calling your phone now.")):
            result = await self.named_call("discord")
        self.assertEqual(joined, [], "nothing is spent on a way that is not set up")
        self.assertTrue(result.startswith("They asked for Discord voice channel, but it did not work (Voice in Discord is off"), result)
        self.assertIn("so it went by their Reach me order instead. Calling your phone now.", result)
        self.assertEqual(reach_me.load(A1)["log"][-1]["channel"], "phone")

    async def test_nobody_joining_discord_falls_to_their_order(self):
        from services import discord_voice as dv
        self.order(call=["app", "discord"])
        joined, patches = self.discord(outcome=dv.VoiceRefused("Nobody joined #voice within a minute.", missed=True))
        with patches[0], patches[1], patch("services.rings.ring_user", AsyncMock(return_value="They answered.")):
            result = await self.named_call("discord")
        self.assertIn("Nobody joined #voice within a minute", result)
        self.assertTrue(result.endswith("They answered."), result)

    async def test_a_limit_on_the_named_way_is_reported_not_worked_around(self):
        from services import discord_voice as dv
        self.order(call=["app", "discord"])
        joined, patches = self.discord(outcome=dv.VoiceRefused("Today's limit for voice calls to you (6 per account) is used up."))
        ring = AsyncMock(return_value="They answered.")
        with patches[0], patches[1], patch("services.rings.ring_user", ring):
            result = await self.named_call("discord")
        self.assertEqual(result, "Not sent: Today's limit for voice calls to you (6 per account) is used up.")
        ring.assert_not_called()

    async def test_a_way_that_cannot_take_a_call_falls_to_their_order(self):
        self.order(call=["app"])
        with patch("services.rings.ring_user", AsyncMock(return_value="They answered.")):
            result = await self.named_call("whatsapp")
        self.assertEqual(result, "They asked for WhatsApp, but that way cannot take a call from Kairos, so it went by their "
                                 "Reach me order instead. They answered.")

    async def test_ask_by_call_carries_the_named_way(self):
        self.order(call=["phone", "discord"])
        joined, patches = self.discord()
        with patches[0], patches[1]:
            placed = await self.named_call("discord", ask=True)
        self.assertEqual((placed["ok"], placed["channel"]), (True, "discord"))

    async def test_quiet_hours_a_turned_off_bot_stop_and_unknown_ways_still_hold(self):
        joined, patches = self.discord()
        with patches[0], patches[1]:
            self.assertIn("Unknown way to reach the person", await self.named_call("carrier pigeon"))
            self.order(call=["discord"], bots={"bot-kip": {"call": []}})
            self.assertIn("turned off calls from this bot", await self.named_call("discord"))
            self.order(bots={})
            QuietHours.window(self)
            self.assertIn("quiet hours", await self.named_call("discord"))
            self.order(quiet={"enabled": False})
            reach_me.pause("settings", "settings", A1)
            self.assertIn("paused", await self.named_call("discord"))
            reach_me.resume("settings", "settings", A1)
        self.assertEqual(joined, [])

    async def test_message_me_on_telegram_goes_there_first(self):
        self.order(message=["whatsapp", "telegram"])
        result = await reach.message_me(A1, "bot-kip", "Build done.", self.inv(), via="telegram")
        self.assertEqual(result, "Sent to the person: Telegram.")
        self.assertEqual(self.api.to("graph.facebook.com"), [])
        self.assertEqual(self.outbox_rows()[-1]["channel"], "reach:bot-kip@via:telegram")

    async def test_message_me_named_way_failing_falls_to_their_order_and_says_so(self):
        self.order(message=["whatsapp", "telegram"])
        self.api.fail.add("api.telegram.org")
        result = await reach.message_me(A1, "bot-kip", "Build done.", self.inv(), via="telegram")
        self.assertTrue(result.startswith("Sent to the person: WhatsApp. They asked for Telegram, but it did not work"), result)
        self.assertIn("so it went by their Reach me order instead.", result)

    async def test_text_me_on_my_phone_is_an_sms_and_a_retry_keeps_the_named_way(self):
        self.order(message=["telegram"])
        self.api.fail.add("api.telegram.org")
        result = await reach.message_me(A1, "bot-kip", "Later.", self.inv(), via="phone")
        self.assertTrue(result.startswith("Not delivered yet"), result)
        self.assertIn("SMS text", result)
        self.assertEqual(self.outbox_rows()[-1]["channel"], "reach:bot-kip@via:phone")
        self.api.fail.clear()
        with accounts.as_account(A1):
            self.assertEqual(await outbox.send_due(now=time.time() + 120), 1)
        self.assertEqual(reach_me.load(A1)["log"][-1]["via"], "sms")

    async def test_the_tools_take_via_and_stay_self_only(self):
        from core import bot_policy, tool_registry
        specs = {spec["name"]: spec for spec in phone_tools.TOOLS}
        for name in ("message_me", "ring_me", "ask_me_by_call", "notify_me_by_call"):
            via = specs[name]["schema"]["properties"]["via"]
            self.assertEqual(via["enum"], ["app", "discord", "phone", "telegram", "whatsapp", "imessage", "signal", "sms"], name)
            self.assertIn("Only when the person named a way", via["description"])
            self.assertNotIn("via", specs[name]["schema"]["required"])
            self.assertIn(name, bot_policy.SELF_ONLY_TOOLS)
            self.assertIn("via", tool_registry._REGISTRY[name].schema["properties"], name)
        self.assertNotIn("via", specs["notify_me_by_text"]["schema"]["properties"])
        called = []

        async def call_me(account, bot_id, text, ident, ask=False, via=None):
            called.append(via)
            return "rang"
        with accounts.as_account(A1), patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}), \
                patch.object(reach, "call_me", call_me):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", invocation_id="v1")
            await phone_tools.tool_ring({"reason": "r", "via": "discord"}, ctx)
            await phone_tools.tool_call({"message": "m"}, ctx)
        self.assertEqual(called, ["discord", None])
        agent = {"id": "bot-kip", "outbound": {"policy": "allow", "daily_cap": 2}}
        policy = SimpleNamespace(mode="edits", source="bot", reason="", revision=1)
        with patch.object(bot_policy, "_agent", lambda bot_id: agent), \
                patch.object(bot_policy, "effective_policy", lambda *a, **k: policy), \
                patch.object(bot_policy, "_owner_for", lambda *a: "alice"), \
                patch.object(bot_policy, "run_context", lambda *a: None):
            decision = bot_policy.authorize_operation(bot_id="bot-kip", tool="ring_me", arguments={"reason": "x", "via": "discord"},
                                                      invocation_id="via-1")
        self.assertEqual((decision.action, decision.source), ("allow", "self-only"))


class OneCallOrder(ReachCase):
    """"When a bot calls you" (the Discord bot page) and Settings > Reach me's call order are one setting (2026-11-11)."""

    async def test_the_discord_page_choice_is_the_first_way_in_reach_me_and_back(self):
        from routes import settings_routes as routes
        with accounts.as_account(A1):
            self.order(call=["phone", "app", "discord", "telegram"])
            saved = await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="discord"), user="u")
            self.assertEqual(saved["ring_preference"], "discord")
            self.assertEqual(reach_me.load(A1)["call"], ["discord", "phone", "app", "telegram"])
            self.order(call=["telegram", "app"])
            self.assertEqual((await routes.get_settings(user="u"))["ring_preference"], "telegram")
            self.order(call=[])
            self.assertIsNone((await routes.get_settings(user="u"))["ring_preference"], "calls off shows as off")
            await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="app"), user="u")
            self.assertEqual(reach_me.load(A1)["call"], ["app", "phone", "discord", "telegram"])
            with self.assertRaises(Exception):
                await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="carrier pigeon"), user="u")

    async def test_an_unsaved_reach_me_takes_the_old_choice_once_and_it_never_decides_again(self):
        from core import settings as settings_store
        from routes import settings_routes as routes
        with accounts.as_account(A1):
            self.assertFalse(os.path.exists(reach_me._file(A1)))
            settings_store.update_settings(ring_preference="discord")       # David's saved value, 2026-11-11 17:05
            try:
                self.assertEqual(reach_me.load(A1)["call"][0], "discord")
                self.assertEqual(json.loads(Path(reach_me._file(A1)).read_text())["call"][0], "discord", "written in once")
                settings_store.update_settings(ring_preference="phone")
                self.assertEqual(reach_me.first_call(A1), "discord", "the old setting no longer decides anything")
                self.assertEqual((await routes.get_settings(user="u"))["ring_preference"], "discord")
                await routes.set_ring_preference(routes.SetRingPreferenceRequest(preference="app"), user="u")
                self.assertEqual(settings_store.get_setting("ring_preference"), "phone", "the route writes Reach me only")
                self.assertEqual(reach_me.first_call(A1), "app")
            finally:
                settings_store.update_settings(ring_preference="app")

    def test_the_default_preference_writes_nothing(self):
        self.assertEqual(reach_me.load(A1)["call"], reach_me.DEFAULT_CALL)
        self.assertFalse(os.path.exists(reach_me._file(A1)))

    def test_the_tool_descriptions_say_the_same_thing_as_the_settings(self):
        text = " ".join(spec["description"] for spec in phone_tools.TOOLS if spec["name"] in ("ring_me", "notify_me_by_call", "ask_me_by_call"))
        self.assertIn("When a bot calls you", text)
        self.assertIn("first way in that same order", text)
        self.assertIn("pass it as via", text)


def sine_pcm(seconds=0.6, rate=24000):
    t = np.arange(int(seconds * rate)) / rate
    return (np.sin(2 * np.pi * 220 * t) * 0.3 * 32767).astype("<i2").tobytes()


@unittest.skipUnless(__import__("core.ffmpeg_tools", fromlist=["find"]).find(), "FFmpeg is not installed")
class TelegramVoice(ReachCase):
    def test_pcm_is_packed_as_ogg_opus(self):
        ogg = reach_voice.encode_ogg_opus(sine_pcm(), 24000)
        self.assertTrue(reach_voice.is_ogg_opus(ogg))
        self.assertEqual(ogg[:4], b"OggS")
        self.assertIn(b"OpusHead", ogg[:200])
        self.assertIn(b"OpusTags", ogg)
        self.assertFalse(reach_voice.is_ogg_opus(b"RIFF....WAVE"))

    async def test_call_me_on_telegram_sends_a_voice_message_in_the_bots_voice(self):
        spoken = []

        async def engine(text, voice_id=None):
            spoken.append(text)
            yield {"sample_rate": 24000}
            yield {"audio": sine_pcm(0.4)}
        self.order(call=["phone", "telegram"])
        with patch("services.bot_voice.audio_events", engine), \
                patch("core.call_voices.configuration", lambda: {"url": "kokoro://local", "protocol": "kokoro"}):
            result = await self.call("The deploy failed.")
        self.assertIn("Telegram voice message", result)
        self.assertEqual(" ".join(spoken), "This is Kip, an AI assistant from Kairos. The deploy failed.")
        request = self.api.to("sendVoice")[-1]
        self.assertIn(b"OggS", request["body"])
        self.assertIn(b'name="chat_id"', request["body"])
        self.assertIn(ME_TG.encode(), request["body"])
        self.assertIn(b"Kip: The deploy failed.", request["body"], "the text rides along as the caption")
        self.assertIn(b"audio/ogg", request["body"])
        self.assertEqual(bot_outbound.usage(A1, "phone:bot-kip:text", 10)["used"], 1, "a voice message counts as a message")

    async def test_no_voice_engine_falls_to_the_next_way(self):
        self.order(call=["telegram", "app"])
        with patch("core.call_voices.configuration", lambda: {"url": ""}), \
                patch("services.rings.ring_user", AsyncMock(return_value="rang")):
            self.assertEqual(await self.call(), "rang")
        self.assertEqual(self.api.to("sendVoice"), [])


class CapsAndPolicy(ReachCase):
    async def test_message_me_shares_the_daily_texts_to_you_limit_with_notify_me_by_text(self):
        connector(A1, "sms", "SMS", {"account_sid": "ACsms", "auth_token": "t", "from_number": "+15550003333", "public_url": BASE + "/x",
                                     "default_to": ME_SMS}, [ME_SMS])
        self.order(message=["telegram"])
        for _ in range(5):
            self.assertTrue((await self.message()).startswith("Sent"))
        for n in range(5):
            self.assertEqual(await phone_calls.text_user(A1, "bot-kip", "t", f"text-{n}"), "Text sent to your phone.")
        refused = await self.message()
        self.assertTrue(refused.startswith("Not sent: Today's limit for messages to you (10 per bot)"), refused)
        self.assertEqual(bot_outbound.outcome_for(refused), bot_outbound.RELEASED)
        other = await self.message(bot="bot-two")
        self.assertTrue(other.startswith("Sent"), "another bot has its own 10, inside the account's 30")

    def test_every_reach_tool_is_a_send_for_the_approval_levels(self):
        from core import bot_policy, tool_registry
        for name, args in (("message_me", {"message": "x"}), ("ring_me", {"reason": "x"}), ("notify_me_by_call", {"message": "x"}),
                           ("notify_me_by_text", {"message": "x"})):
            self.assertIn(name, tool_registry._REGISTRY)
            self.assertEqual(bot_policy.classify(name, args).kind, bot_policy.OUTBOUND, name)
        self.assertEqual(bot_outbound.outcome_for("Sent to the person: Telegram."), bot_outbound.COMMITTED)

    async def test_below_full_message_me_and_a_text_to_you_ask_nothing_and_spend_no_send_allowance(self):
        from core import bot_policy
        agent = {"id": "bot-kip", "outbound": {"policy": "allow", "daily_cap": 2}}
        policy = SimpleNamespace(mode="edits", source="bot", reason="", revision=1)
        with patch.object(bot_policy, "_agent", lambda bot_id: agent),                 patch.object(bot_policy, "effective_policy", lambda *a, **k: policy),                 patch.object(bot_policy, "_owner_for", lambda *a: "alice"),                 patch.object(bot_policy, "run_context", lambda *a: None):
            mine = [bot_policy.authorize_operation(bot_id="bot-kip", tool="message_me", arguments={"message": "x"},
                                                   invocation_id=f"m{n}") for n in range(5)]
            texts = [bot_policy.authorize_operation(bot_id="bot-kip", tool="notify_me_by_text", arguments={"message": "x"},
                                                    invocation_id=f"p{n}") for n in range(5)]
            others = [bot_policy.authorize_operation(bot_id="bot-kip", tool="send_email", arguments={},
                                                     invocation_id=f"e{n}").action for n in range(3)]
        self.assertEqual([(o.action, o.source) for o in mine], [("allow", "self-only")] * 5)
        self.assertEqual([(o.action, o.source, o.reservation) for o in texts], [("allow", "self-only", None)] * 5)
        self.assertEqual(others, ["allow", "allow", "ask"], "other sends still draw on the bot's send allowance, untouched by either")

    async def test_the_tool_runs_as_the_session_account_and_reports_plainly(self):
        from core import tool_registry
        self.order(message=["telegram"])
        with accounts.as_account(A1), patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}):
            ctx = tool_registry.ToolContext(agent_id="bot-kip", owner_user="local", invocation_id="tool-1")
            self.assertTrue((await phone_tools.tool_message({"message": "From the tool."}, ctx)).startswith("Sent to the person: Telegram"))
            again = await phone_tools.tool_message({"message": "From the tool."}, ctx)
        self.assertEqual(len([r for r in self.api.to("sendMessage") if b"From the tool." in r["body"]]), 1,
                         "a retried call with the same invocation is the same queued message")
        self.assertTrue(again.startswith("Already sent"), again)


class QuietHours(ReachCase):
    def window(self, account=A1, before=3600, after=3600):
        from datetime import datetime, timezone
        now = time.time()
        start = datetime.fromtimestamp(now - before, timezone.utc).strftime("%H:%M")
        end = datetime.fromtimestamp(now + after, timezone.utc).strftime("%H:%M")
        reach_me.save({"quiet": {"enabled": True, "start": start, "end": end}}, account)

    def test_the_window_spans_midnight(self):
        from datetime import datetime, timezone
        reach_me.save({"quiet": {"enabled": True, "start": "22:00", "end": "07:00"}}, A1)
        at = lambda h, m=0: datetime(2026, 11, 10, h, m, tzinfo=timezone.utc).timestamp()
        self.assertEqual(reach_me.quiet_until(A1, at(23)), datetime(2026, 11, 11, 7, 0, tzinfo=timezone.utc).timestamp())
        self.assertEqual(reach_me.quiet_until(A1, at(3)), datetime(2026, 11, 10, 7, 0, tzinfo=timezone.utc).timestamp())
        self.assertIsNone(reach_me.quiet_until(A1, at(7)))
        self.assertIsNone(reach_me.quiet_until(A1, at(12)))
        reach_me.save({"quiet": {"enabled": False, "start": "22:00", "end": "07:00"}}, A1)
        self.assertIsNone(reach_me.quiet_until(A1, at(23)))

    async def test_messages_wait_until_quiet_hours_end_and_calls_and_texts_are_refused(self):
        self.order(message=["telegram"], call=["app"])
        self.window()
        result = await self.message("Morning news.")
        self.assertTrue(result.startswith("Queued. It is the person's quiet hours"), result)
        self.assertEqual(self.api.requests, [])
        row = self.outbox_rows()[-1]
        self.assertGreater(row["next_try_at"], time.time() + 3000)
        with patch("services.rings.ring_user", AsyncMock(return_value="rang")) as ring:
            self.assertIn("quiet hours", await self.call())
            ring.assert_not_called()
        from core import tool_registry
        with accounts.as_account(A1), patch("core.tool_registry._bot_scope", lambda ctx: {"bot_id": "bot-kip"}):
            text = await phone_tools.tool_text({"message": "x"}, tool_registry.ToolContext(agent_id="bot-kip", invocation_id="q1"))
        self.assertIn("quiet hours", text)
        with accounts.as_account(A1):
            self.assertEqual(await outbox.send_due(now=time.time() + 60), 0, "still held")
            self.assertEqual(await outbox.send_due(now=row["next_try_at"] + 1), 1)
        self.assertEqual(json.loads(self.api.to("sendMessage")[-1]["body"])["text"], "Kip: Morning news.")


class Stop(ReachCase):
    async def receive(self, record, sender, text, conversation=None):
        adapter = hub.build(store.get_record(record["id"]))
        await hub.receive(adapter, Inbound(conversation=conversation or sender, sender=sender, text=text))

    async def assert_paused_everywhere(self):
        self.assertTrue(reach_me.paused(A1))
        self.order(message=["telegram"], call=["app"])
        before = len(self.api.requests)
        self.assertIn("paused all messages and calls", await self.message())
        self.assertIn("paused all messages and calls", await self.call())
        with self.assertRaises(phone_calls.PhoneRefused):
            await phone_calls.text_user(A1, "bot-kip", "x", "t-stop")
        from services import rings
        with self.assertRaises(rings.RingRefused):
            rings.create(A1, "bot-kip", "x", "r-stop")
        self.assertEqual(len(self.api.requests), before, "nothing was sent while paused")

    def confirmations(self):
        return [json.loads(r["body"])["text"] for r in self.api.to("sendMessage")]

    async def test_stop_and_start_on_telegram(self):
        await self.receive(self.tg, ME_TG, "STOP")
        self.assertEqual(self.confirmations(), [reach_me.STOPPED_REPLY])
        await self.assert_paused_everywhere()
        await self.receive(self.tg, ME_TG, "start")
        self.assertIsNone(reach_me.paused(A1))
        self.assertEqual(self.confirmations()[-1], reach_me.STARTED_REPLY)
        stops = reach_me.load(A1)["stops"]
        self.assertEqual([(s["action"], s["channel"]) for s in stops], [("stop", "telegram"), ("start", "telegram")])

    async def test_stop_on_whatsapp_signal_and_imessage(self):
        sig = connector(A1, "signal", "Sig", {"api_url": "http://sig.local:8080", "number": "+15550001111", "default_recipient": ME_SIG}, [ME_SIG])
        bb = connector(A1, "bluebubbles", "Mac", {"server_url": "http://bb.local:1234", "password": "pw", "default_chat": "iMessage;-;+15557770001"},
                       ["+15557770001"])
        for record, sender, conversation, word in ((self.wa, ME_WA, ME_WA, "Stop."), (sig, ME_SIG, ME_SIG, "unsubscribe"),
                                                   (bb, "+15557770001", "iMessage;-;+15557770001", "STOP ALL")):
            await self.receive(record, sender, word, conversation)
            self.assertTrue(reach_me.paused(A1), record["kind"])
            self.assertEqual(reach_me.paused(A1)["channel"], record["kind"])
            await self.receive(record, sender, "START", conversation)
            self.assertIsNone(reach_me.paused(A1), record["kind"])
        self.assertTrue(self.api.to("graph.facebook.com") and self.api.to("sig.local") and self.api.to("bb.local"), "each confirmed")

    async def test_stop_on_an_sms_connector_is_recorded_and_twilio_answers_it(self):
        sms = connector(A1, "sms", "SMS", {"account_sid": "ACsms", "auth_token": "t", "from_number": "+15550003333", "public_url": BASE + "/x",
                                           "default_to": ME_SMS}, [ME_SMS])
        await self.receive(sms, ME_SMS, "cancel")
        self.assertTrue(reach_me.paused(A1), "texts also take the carrier words")
        self.assertEqual(self.api.to("Messages.json"), [], "Twilio sends its own STOP reply")
        await self.receive(sms, ME_SMS, "UNSTOP")
        self.assertIsNone(reach_me.paused(A1))

    async def test_chat_words_that_only_look_like_stop_go_on_as_messages(self):
        handled = []
        with patch.object(hub, "_reply", AsyncMock(side_effect=lambda *a: handled.append(a[2]) or None)):
            for text in ("stop the build", "cancel", "please stop after this one", "end"):
                await self.receive(self.tg, ME_TG, text)
        self.assertIsNone(reach_me.paused(A1))
        self.assertEqual(handled, ["stop the build", "cancel", "please stop after this one", "end"])

    async def test_a_stranger_on_an_open_connector_cannot_pause_anyone(self):
        open_tg = connector(A1, "telegram", "Open", {"bot_token": "9:z", "default_chat_id": ME_TG}, [ME_TG], open_=True)
        with patch.object(hub, "_reply", AsyncMock(return_value=None)):
            await self.receive(open_tg, "999", "STOP")
        self.assertIsNone(reach_me.paused(A1))

    async def test_stop_on_discord(self):
        from core import discord_bots_store as bots
        from core.channels import discord_channel as dc
        with accounts.as_account(A1):
            bot = bots.create_bot("Home", "token-value-123", "9001", None)

        class Client:
            def __init__(self, intents=None):
                self.handlers, self.user = {}, object()

            def event(self, fn):
                self.handlers[fn.__name__] = fn
                return fn

        class Channel:
            id, sent = 333, []

            async def send(self, text=None, file=None):
                self.sent.append(text)
        fake = SimpleNamespace(Intents=SimpleNamespace(default=lambda: SimpleNamespace(message_content=False)), Client=Client,
                               File=lambda path: path)
        try:
            client = dc._build_client(fake, bots.get_bot(bot["id"]))
            for author, text in (("9002", "STOP"), ("9001", "STOP")):
                channel = Channel()
                message = SimpleNamespace(author=SimpleNamespace(id=int(author)), channel=channel, content=text, attachments=[],
                                          reference=None, id=1, created_at=SimpleNamespace(isoformat=lambda: "x"), jump_url="u")
                with patch("services.chat_service.send_message", AsyncMock(return_value="chat")), patch("core.tab_hooks.emit_message"), \
                        patch("core.session_manager.SessionManager.get_or_create_channel_session", return_value="sid"):
                    await client.handlers["on_message"](message)
                if author == "9002":
                    self.assertIsNone(reach_me.paused(A1), "only the bot's own allowed user")
            self.assertEqual(reach_me.paused(A1)["channel"], "discord")
            self.assertEqual(channel.sent, [reach_me.STOPPED_REPLY])
        finally:
            with accounts.as_account(A1):
                bots.delete_bot(bot["id"])

    def twilio_phone(self):
        connection.save({"provider": "twilio", "account_sid": "ACone", "auth_token": "tok-1", "number": "+15550001111",
                         "user_number": ME_SMS, "public_url": BASE, "require_pin": False}, account=A1)

    async def twilio_sms(self, sender, text, token="tok-1"):
        params = {"From": sender, "To": "+15550001111", "Body": text, "MessageSid": uuid.uuid4().hex}
        url = BASE + "/api/phone/twilio/sms"
        headers = {"X-Twilio-Signature": phone_providers.twilio_signature(token, url, params)}
        return await phone_calls.twilio_sms(headers, urlencode(params).encode())

    async def test_stop_texted_back_to_the_phone_connection(self):
        self.twilio_phone()
        self.assertEqual((await self.twilio_sms("+15559998888", "STOP"))[0], 200)
        self.assertIsNone(reach_me.paused(A1), "a stranger's STOP is ignored")
        self.assertEqual((await self.twilio_sms(ME_SMS, "STOP", token="forged"))[0], 403)
        self.assertIsNone(reach_me.paused(A1))
        self.assertEqual((await self.twilio_sms(ME_SMS, "Stop"))[0], 200)
        self.assertEqual(reach_me.paused(A1)["channel"], "sms")
        await self.assert_paused_everywhere()
        await self.twilio_sms(ME_SMS, "START")
        self.assertIsNone(reach_me.paused(A1))
        self.assertIn("sms", connection.webhook_paths(connection.get(A1)))

    async def test_stop_texted_back_through_telnyx(self):
        key = Ed25519PrivateKey.generate()
        public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
        connection.save({"provider": "telnyx", "api_key": "KEY", "public_key": public, "connection_id": "c1", "number": "+15550004444",
                         "user_number": ME_SMS, "public_url": BASE, "require_pin": False}, account=A1)

        def event(text, sender=ME_SMS):
            body = json.dumps({"data": {"event_type": "message.received", "payload": {
                "direction": "inbound", "text": text, "from": {"phone_number": sender}, "to": [{"phone_number": "+15550004444"}]}}}).encode()
            stamp = str(int(time.time()))
            return {"telnyx-timestamp": stamp, "telnyx-signature-ed25519": base64.b64encode(key.sign(stamp.encode() + b"|" + body)).decode()}, body
        self.assertEqual((await phone_calls.telnyx_event(*event("STOP")))[0], 200)
        self.assertEqual(reach_me.paused(A1)["channel"], "sms")
        await phone_calls.telnyx_event(*event("start"))
        self.assertIsNone(reach_me.paused(A1))
        await phone_calls.telnyx_event(*event("STOP", sender="+15559998888"))
        self.assertIsNone(reach_me.paused(A1))

    async def test_the_switch_in_settings_and_a_message_queued_before_stop(self):
        from routes import reach_me_routes as routes
        self.order(message=["telegram"])
        self.window_before = None
        from datetime import datetime, timezone
        now = time.time()
        reach_me.save({"quiet": {"enabled": True, "start": datetime.fromtimestamp(now - 60, timezone.utc).strftime("%H:%M"),
                                 "end": datetime.fromtimestamp(now + 3600, timezone.utc).strftime("%H:%M")}}, A1)
        self.assertTrue((await self.message("Held.")).startswith("Queued"))
        with accounts.as_account(A1):
            view = await routes.pause_reach_me(routes.PauseBody(paused=True), user="u")
            self.assertEqual(view["paused"]["by"], "settings")
            row = self.outbox_rows()[-1]
            await outbox.send_due(now=row["next_try_at"] + 1)
        self.assertEqual(self.api.to("sendMessage"), [], "a held message is dropped after STOP, not sent")
        self.assertEqual(self.outbox_rows()[-1]["status"], "delivered")
        self.assertIn("STOP", reach_me.load(A1)["log"][-1]["note"])
        with accounts.as_account(A1):
            self.assertIsNone((await routes.pause_reach_me(routes.PauseBody(paused=False), user="u"))["paused"])

    async def test_bot_channel_notifications_and_pushes_also_stop(self):
        from services import agent_service as svc, bot_push
        reach_me.pause("telegram", account=A1)
        queued = []
        with accounts.as_account(A1), patch.object(outbox, "enqueue_agent_batch", lambda *a: queued.append(a)), \
                patch.object(svc.agent_service, "get", lambda ident: {"id": ident, "name": "Kip", "deliver_to_channel": "conn:x"}), \
                patch("core.events.emit"):
            svc.agent_service._announce("bot-kip", "agent.inbox", "has a report", "T", "B")
        self.assertEqual(queued, [])
        pushes = []
        with accounts.as_account(A1), patch("core.mobile_activity.enqueue_bot", lambda *a: pushes.append(a)), \
                patch("services.bot_attention.ingest_event", lambda event: [{"kind": "question"}]):
            bot_push.on_event({"type": "agent.inbox", "agent_id": "bot-kip", "item_kind": "question"})
        self.assertEqual(pushes, [])


class WhatsAppTemplates(ReachCase):
    def adapter(self, **settings):
        if settings:
            with accounts.as_account(A1):
                store.update(self.wa["id"], KINDS["whatsapp"].fields, values=settings)
        return hub.build(store.get_record(self.wa["id"]))

    def last(self):
        return json.loads(self.api.to("graph.facebook.com")[-1]["body"])

    async def test_inside_the_window_it_is_free_text(self):
        adapter = self.adapter(template_name="kairos_update")
        adapter.note_inbound(ME_WA)
        self.assertEqual(await adapter.send(ME_WA, "Hi", bot_name="Kip"), "text")
        self.assertEqual(self.last()["type"], "text")

    async def test_outside_the_window_the_approved_template_goes_with_its_variables(self):
        adapter = self.adapter(template_name="kairos_update", template_language="en_GB")
        adapter.note_inbound(ME_WA, at=time.time() - 25 * 3600)
        self.assertEqual(await adapter.send(ME_WA, "Line one.\n\nLine\ttwo     spaced.", bot_name="Kip"), "template")
        body = self.last()
        self.assertEqual(body["type"], "template")
        self.assertEqual(body["template"]["name"], "kairos_update")
        self.assertEqual(body["template"]["language"], {"code": "en_GB"})
        self.assertEqual([p["text"] for p in body["template"]["components"][0]["parameters"]], ["Kip", "Line one. Line two spaced."])
        self.adapter(template_params="none")
        adapter = self.adapter()
        await adapter.send(ME_WA, "x")
        self.assertNotIn("components", self.last()["template"])

    async def test_an_unknown_window_tries_free_text_then_the_template_when_meta_refuses(self):
        adapter = self.adapter(template_name="kairos_update")
        self.api.wa_closed = True
        self.assertEqual(await adapter.send(ME_WA, "Hi", bot_name="Kip"), "template")
        self.assertEqual([json.loads(r["body"])["type"] for r in self.api.to("graph.facebook.com")], ["text", "template"])

    async def test_no_template_outside_the_window_falls_to_the_next_way_with_a_plain_reason(self):
        self.adapter().note_inbound(ME_WA, at=time.time() - 30 * 3600)
        self.order(message=["whatsapp", "telegram"])
        result = await self.message("Report ready.")
        self.assertTrue(result.startswith("Sent to the person: Telegram"), result)
        self.assertIn("free text only within 24 hours", result)
        self.assertEqual(self.api.to("graph.facebook.com"), [], "nothing Meta would refuse is sent")
        self.api.wa_closed = True
        self.adapter().note_inbound(ME_WA, at=None)
        path = self.adapter()._window_file()
        os.remove(path)
        result = await self.message("Second.")
        self.assertIn("free text only within 24 hours", result, "an unknown window that Meta refuses says the same")

    async def test_message_me_through_the_template_says_so(self):
        self.adapter(template_name="kairos_update").note_inbound(ME_WA, at=time.time() - 30 * 3600)
        self.order(message=["whatsapp"])
        self.assertIn("as your approved template", await self.message())

    async def test_an_incoming_message_opens_the_window(self):
        adapter = self.adapter()
        body = json.dumps({"entry": [{"changes": [{"value": {"messages": [{"from": ME_WA, "type": "image"}]}}]}]}).encode()
        signature = "sha256=" + hmac.new(b"wa-secret", body, hashlib.sha256).hexdigest()
        self.assertIsNone(adapter.window_open(ME_WA))
        self.assertEqual((await adapter.handle_webhook("POST", {"X-Hub-Signature-256": signature}, {}, body))[0], 200)
        self.assertTrue(adapter.window_open(ME_WA))
        self.assertFalse(adapter.window_open(ME_WA, now=time.time() + 24 * 3600))


class Accounts(ReachCase):
    async def test_each_account_has_its_own_reach_me_and_its_own_stop(self):
        reach_me.save({"message": ["telegram"], "quiet": {"enabled": True, "start": "01:00", "end": "02:00"}}, A1)
        self.assertEqual(reach_me.load(A2)["message"], list(reach_me.MESSAGE_CHANNELS))
        self.assertFalse(reach_me.load(A2)["quiet"]["enabled"])
        await Stop.receive(self, self.tg, ME_TG, "STOP")
        self.assertTrue(reach_me.paused(A1))
        self.assertIsNone(reach_me.paused(A2), "A1's STOP pauses only A1")
        with accounts.as_account(A2):
            channels = {c["id"]: c["ready"] for c in reach.message_status()}
        self.assertFalse(channels["telegram"], "A1's Telegram is not A2's")
        self.order(account=A2, message=["telegram", "app"])
        result = await self.message(account=A2)
        self.assertIn("In the Kairos app", result)
        self.assertEqual(self.api.to("sendMessage")[-1:], self.api.to("sendMessage")[-1:])
        self.assertFalse(any(b"Your build" in (r["body"] or b"") for r in self.api.to("api.telegram.org")),
                         "A2's message never went through A1's Telegram")

    def test_the_settings_file_lives_in_each_accounts_own_folder(self):
        reach_me.save({"message": ["sms"]}, A1)
        self.assertTrue(reach_me._file(A1).startswith(accounts.account_dir(A1)))
        self.assertNotEqual(reach_me._file(A1), reach_me._file(A2))


class Words(unittest.TestCase):
    def test_stop_and_start_words(self):
        for text in ("STOP", "stop", "Stop.", " stop! ", "STOP ALL", "stopall", "Unsubscribe"):
            self.assertEqual(reach_me.command_of(text), "stop", text)
        for text in ("cancel", "end", "quit", "opt out"):
            self.assertIsNone(reach_me.command_of(text), text)
            self.assertEqual(reach_me.command_of(text, sms=True), "stop", text)
        for text in ("START", "unstop", "Resume"):
            self.assertEqual(reach_me.command_of(text), "start", text)
        for text in ("", None, "yes", "stop it with the jokes", "don't stop"):
            self.assertIsNone(reach_me.command_of(text), text)


if __name__ == "__main__":
    unittest.main()
