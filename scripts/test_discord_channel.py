"""Discord channel: bots, Normal/Open/Silent channel overrides, agent gating,
delivery targets and the admin routes, against a fake discord module.

Discord is the one registered channel with per-channel Normal/Open/Silent
overrides (the other platforms have a closed/open switch, see
test_connector_matrix.py). No Discord account, token or network is used; the
fake `discord` module records what the bot would send. MANUAL: a real bot
token logging in, a real server's channel IDs and DMs.

    .venv\\Scripts\\python.exe scripts\\test_discord_channel.py
"""
import asyncio
import logging
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import tempfile

_DATA = tempfile.TemporaryDirectory(prefix="g7-discord-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"

from fastapi.testclient import TestClient

from app import app
from core import discord_bots_store as bots
from core.auth import SESSION_COOKIE_NAME, auth_manager
from core.channels import discord_channel as dc, registry

logging.disable(logging.CRITICAL)
CHANNEL, OTHER, OWNER, STRANGER = "111", "222", "9001", "9002"


class FakeDiscord:
    """Just enough of discord.py for _build_client: Intents, Client, File."""
    class Intents:
        message_content = False

        @classmethod
        def default(cls):
            return cls()

    class File:
        def __init__(self, path):
            self.path = path

    class Client:
        def __init__(self, intents=None):
            self.handlers, self.user = {}, object()

        def event(self, fn):
            self.handlers[fn.__name__] = fn
            return fn


class Channel:
    def __init__(self, ident):
        self.id, self.sent = int(ident), []

    async def send(self, text=None, file=None):
        self.sent.append(text if file is None else file)

    def typing(self):
        outer = self

        class Context:
            async def __aenter__(self_inner): return outer
            async def __aexit__(self_inner, *a): return False
        return Context()


def message(channel, author, text="hello", reference=None):
    return SimpleNamespace(author=SimpleNamespace(id=int(author), __str__=lambda s: "person"), channel=Channel(channel),
                           content=text, attachments=[], reference=reference, id=1,
                           created_at=SimpleNamespace(isoformat=lambda: "2026-10-27T00:00:00"), jump_url="u")


class Truth(unittest.TestCase):
    def test_should_respond_modes(self):
        modes = {CHANNEL: "open", OTHER: "silent"}
        # (channel, author, allowed user) -> reply?
        self.assertTrue(dc._should_respond(CHANNEL, STRANGER, modes, OWNER), "open answers anyone")
        self.assertFalse(dc._should_respond(OTHER, OWNER, modes, OWNER), "silent never answers, even the owner")
        self.assertFalse(dc._should_respond(OTHER, STRANGER, modes, None), "silent beats the no-allow-list default")
        self.assertTrue(dc._should_respond("333", OWNER, modes, OWNER), "a normal channel answers the allowed user")
        self.assertFalse(dc._should_respond("333", STRANGER, modes, OWNER), "a normal channel ignores everyone else")
        self.assertTrue(dc._should_respond("333", STRANGER, modes, None), "with no allow list the bot is open")
        self.assertFalse(dc._should_respond(CHANNEL, OWNER, {CHANNEL: "silent"}, OWNER))

    def test_only_the_allowed_user_directs_agents_and_never_in_an_open_channel(self):
        modes = {CHANNEL: "open"}
        self.assertTrue(dc._may_direct_agents("333", OWNER, modes, OWNER))
        self.assertFalse(dc._may_direct_agents("333", STRANGER, modes, OWNER))
        self.assertFalse(dc._may_direct_agents(CHANNEL, OWNER, modes, OWNER), "an open channel never reaches agents")
        self.assertFalse(dc._may_direct_agents("333", OWNER, modes, None), "no allow list: nobody may direct agents")

    def test_replies_are_split_under_discords_2000_character_limit(self):
        pieces = dc._chunk_message("x" * 4500 + "\n" + "y" * 10)
        self.assertTrue(all(len(p) <= 2000 for p in pieces))
        self.assertEqual("".join(pieces).replace("\n", ""), "x" * 4500 + "y" * 10)


class Behavior(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])
        self.bot = bots.create_bot("Home", "token-value-123", OWNER, None)
        for ident, mode in ((CHANNEL, "open"), (OTHER, "silent")):
            bots.add_channel(self.bot["id"], ident, f"c{ident}", mode)
        self.record = bots.get_bot(self.bot["id"])
        self.turn = AsyncMock(return_value="bot reply")
        self.direct = AsyncMock(return_value="agent reply")
        for item in (patch("services.chat_service.send_message", self.turn),
                     patch("core.channels.agent_routing.direct", self.direct),
                     patch("core.tab_hooks.emit_message"),
                     patch("core.session_manager.SessionManager.get_or_create_channel_session", return_value="sid")):
            item.start(); self.addCleanup(item.stop)
        self.client = dc._build_client(FakeDiscord, bots.get_bot(self.bot["id"]))
        self.on_message = self.client.handlers["on_message"]

    async def send(self, channel, author, text="hello"):
        m = message(channel, author, text)
        await self.on_message(m)
        return m.channel.sent

    async def test_the_allowed_user_gets_a_reply_in_a_normal_channel_and_dm(self):
        self.assertEqual(await self.send("333", OWNER), ["bot reply"])
        self.assertEqual(self.turn.call_args.args[1], "hello")

    async def test_a_stranger_is_ignored_in_a_normal_channel(self):
        self.assertEqual(await self.send("333", STRANGER), [])
        self.assertFalse(self.turn.called)

    async def test_an_open_channel_answers_anyone_but_never_runs_agents(self):
        self.assertEqual(await self.send(CHANNEL, STRANGER), ["bot reply"])
        with patch("core.channels.agent_routing.match_agent", return_value=({"name": "Scout"}, "status")) as match:
            await self.send(CHANNEL, OWNER, "Scout, status")
            match.assert_not_called()
        self.assertFalse(self.direct.called)

    async def test_a_silent_channel_never_answers_even_the_owner(self):
        self.assertEqual(await self.send(OTHER, OWNER), [])
        self.assertFalse(self.turn.called or self.direct.called)

    async def test_the_owner_addressing_an_agent_reaches_it_in_a_normal_channel_only(self):
        with patch("core.channels.agent_routing.match_agent", return_value=({"name": "Scout"}, "status")):
            self.assertEqual(await self.send("333", OWNER, "Scout, status"), ["agent reply"])
            self.assertEqual(self.direct.call_count, 1)
            await self.send("333", STRANGER, "Scout, status")
            self.assertEqual(self.direct.call_count, 1, "a stranger cannot direct an agent")

    async def test_the_bots_own_messages_and_empty_ones_are_ignored(self):
        m = message("333", OWNER)
        m.author = self.client.user
        await self.on_message(m)
        self.assertEqual(await self.send("333", OWNER, "   "), [])
        self.assertFalse(self.turn.called)

    async def test_a_failing_turn_replies_with_an_error_not_silence(self):
        self.turn.side_effect = RuntimeError("model down")
        self.assertIn("Something went wrong", (await self.send("333", OWNER))[0])

    async def test_delivery_targets_follow_the_overrides_and_failures_return_false(self):
        ids = [c["id"] for c in registry.list_channels()]
        entry = bots.get_bot(self.bot["id"])["channels"][1]
        self.assertIn("discord", ids)
        self.assertIn(f"discord:{self.bot['id']}:{entry['id']}", ids, "a silent channel is still a delivery target")
        sent = Channel(OTHER)
        client = MagicMock()
        client.get_channel.return_value = sent
        with patch.dict(dc._clients, {self.bot["id"]: client}):
            self.assertTrue(await registry.send_to_channel(f"discord:{self.bot['id']}:{entry['id']}", "brief"))
            self.assertEqual(sent.sent, ["brief"])
            client.get_channel.side_effect = RuntimeError("gone")
            client.fetch_channel = AsyncMock(side_effect=RuntimeError("gone"))
            self.assertFalse(await registry.send_to_channel(f"discord:{self.bot['id']}:{entry['id']}", "brief"))
        self.assertFalse(await registry.send_to_channel(f"discord:{self.bot['id']}:{entry['id']}", "brief"), "no live client: False, not an exception")
        self.assertFalse(await registry.send_to_channel("discord:nope:nope", "x"))
        self.assertFalse(await registry.send_to_channel("unknown", "x"))
        self.assertFalse(await dc.send_direct_message("x"), "DM with no live client is False")
        direct_client = MagicMock()
        user = MagicMock(); user.send = AsyncMock()
        direct_client.fetch_user = AsyncMock(return_value=user)
        with patch.dict(dc._clients, {self.bot["id"]: direct_client}):
            self.assertTrue(await dc.send_direct_message("hi"))
        user.send.assert_awaited_once_with("hi")


class Store(unittest.TestCase):
    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])

    def test_token_is_encrypted_at_rest_and_never_listed(self):
        bot = bots.create_bot("Home", "super-secret-token", OWNER, None)
        raw = Path(bots.BOTS_FILE).read_text(encoding="utf-8")
        self.assertNotIn("super-secret-token", raw)
        self.assertNotIn("token", {k for k in bots.list_bots()[0] if k != "has_token"} - {"has_token"})
        self.assertTrue(bot["has_token"])
        self.assertEqual(bots.resolve_token(bot["id"]), "super-secret-token")
        bots.update_bot(bot["id"], token="")
        self.assertEqual(bots.resolve_token(bot["id"]), "super-secret-token", "a blank token keeps the saved one")

    def test_override_modes_are_validated_edited_and_removed(self):
        bot = bots.create_bot("Home", "t", OWNER, None)
        with self.assertRaises(ValueError):
            bots.add_channel(bot["id"], "111", "bad", "loud")
        entry = bots.add_channel(bot["id"], "111", "ops", "normal")["channels"][0]
        self.assertEqual(bots.update_channel(bot["id"], entry["id"], mode="silent")["channels"][0]["mode"], "silent")
        with self.assertRaises(ValueError):
            bots.update_channel(bot["id"], entry["id"], mode="loud")
        with self.assertRaises(KeyError):
            bots.update_channel(bot["id"], "missing", mode="open")
        self.assertEqual(bots.remove_channel(bot["id"], entry["id"])["channels"], [])
        with self.assertRaises(KeyError):
            bots.remove_channel(bot["id"], entry["id"])
        bots.delete_bot(bot["id"])
        self.assertEqual(bots.list_bots(), [])


class Routes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        auth_manager._users = {"users": {}}; auth_manager._sessions = {}
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        auth_manager.create_user("member", "member-password-1")
        cls.admin, cls.member, cls.anon = TestClient(app), TestClient(app), TestClient(app)
        cls.admin.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("boss"))
        cls.member.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session("member"))

    def setUp(self):
        for bot in bots.list_bots():
            bots.delete_bot(bot["id"])

    def test_every_route_is_admin_only_and_the_token_is_never_returned(self):
        with patch("core.channels.discord_channel.restart", new=AsyncMock()):
            made = self.admin.post("/api/settings/discord-bots", json={"name": "Home", "token": "tok-xyz", "allowed_user_id": OWNER})
            self.assertEqual(made.status_code, 200, made.text)
            self.assertNotIn("tok-xyz", made.text)
            bot_id = made.json()["id"]
            for method, path, body in (("get", "", None), ("post", "", {"name": "x", "token": "t"}), ("patch", f"/{bot_id}", {"name": "y"}),
                                       ("delete", f"/{bot_id}", None), ("post", f"/{bot_id}/channels", {"discord_channel_id": "1", "label": "a"}),
                                       ("patch", f"/{bot_id}/channels/x", {"mode": "open"}), ("delete", f"/{bot_id}/channels/x", None)):
                for who, c in (("member", self.member), ("anonymous", self.anon)):
                    got = getattr(c, method)("/api/settings/discord-bots" + path, **({} if body is None else {"json": body}))
                    self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
            self.assertEqual(len(bots.list_bots()), 1, "refused requests changed nothing")
            self.assertNotIn("tok-xyz", self.admin.get("/api/settings/discord-bots").text)

    def test_channel_ids_and_modes_are_validated_through_the_route(self):
        with patch("core.channels.discord_channel.restart", new=AsyncMock()) as restart:
            bot_id = self.admin.post("/api/settings/discord-bots", json={"name": "Home", "token": "t"}).json()["id"]
            url = f"/api/settings/discord-bots/{bot_id}/channels"
            self.assertEqual(self.admin.post(url, json={"discord_channel_id": "not-a-number", "label": "a"}).status_code, 400)
            self.assertEqual(self.admin.post(url, json={"discord_channel_id": "12", "label": "a", "mode": "loud"}).status_code, 400)
            good = self.admin.post(url, json={"discord_channel_id": "12", "label": "ops", "mode": "silent"})
            self.assertEqual(good.status_code, 200, good.text)
            self.assertEqual(good.json()["channels"][0]["mode"], "silent")
            entry = good.json()["channels"][0]["id"]
            self.assertEqual(self.admin.patch(f"{url}/{entry}", json={"mode": "open"}).json()["channels"][0]["mode"], "open")
            self.assertEqual(self.admin.delete(f"{url}/{entry}").status_code, 200)
            self.assertGreaterEqual(restart.await_count, 4, "every change restarts the bot so it applies at once")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        from core import session_manager_store
        session_manager_store.close()
