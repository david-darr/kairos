"""Bots live-audit fixes (2026-11-02): what a real backend showed that the fixtures hid.

What these prove: a record with no owner belongs to the single local user, the only account,
or no one (core/auth.owner_or_default); a card saved before accounts were on still shows to
the only account and never to a second one (services/bot_cards); a Codex reading summed over
a turn's tool steps gets no percent past the window (core/token_usage.build_context_state); an inbox
item from a room member opens the room (services/bot_attention.target_for); a broken add-on
never ends a chat turn (services/chat_service._prepare_sent_text).
Run: python -B -X utf8 scripts/test_bots_live_fixes.py
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from test_data_support import TestDataDirectory

ENV = TestDataDirectory("kairos-live-fixes-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import auth  # noqa: E402
from core.auth import SINGLE_USER, owner_or_default  # noqa: E402
from core.token_usage import build_context_state  # noqa: E402
from services import bot_attention, bot_cards, chat_service  # noqa: E402


def accounts(on, users):
    """Patch the auth switch and the account list for one test."""
    return [patch.object(auth, "auth_enabled", return_value=on),
            patch.object(auth.auth_manager, "has_any_users", return_value=bool(users)),
            patch.object(auth.auth_manager, "sole_user", return_value=users[0] if len(users) == 1 else None)]


class Patched(unittest.TestCase):
    def use(self, patches):
        for item in patches:
            item.start()
            self.addCleanup(item.stop)


class OwnerTests(Patched):
    def test_a_named_owner_is_kept(self):
        self.use(accounts(True, ["david", "eve"]))
        self.assertEqual(owner_or_default("eve"), "eve")

    def test_accounts_off_means_the_single_local_user(self):
        self.use(accounts(False, ["david"]))
        self.assertEqual(owner_or_default(None), SINGLE_USER)

    def test_accounts_on_with_one_account_means_that_account(self):
        self.use(accounts(True, ["david"]))
        self.assertEqual(owner_or_default(""), "david")

    def test_accounts_on_with_several_means_no_one(self):
        self.use(accounts(True, ["david", "eve"]))
        self.assertIsNone(owner_or_default(None))

    def test_accounts_on_with_none_yet_means_the_single_local_user(self):
        self.use(accounts(True, []))
        self.assertEqual(owner_or_default(None), SINGLE_USER)


class CardOwnerTests(Patched):
    def test_an_old_card_shows_to_the_only_account(self):
        self.use(accounts(True, ["david"]))
        self.assertTrue(bot_cards._mine(SINGLE_USER, "david"))
        self.assertTrue(bot_cards._mine("david", "david"))

    def test_an_old_card_never_shows_once_there_are_two_accounts(self):
        self.use(accounts(True, ["david", "eve"]))
        self.assertFalse(bot_cards._mine(SINGLE_USER, "eve"))
        self.assertFalse(bot_cards._mine("david", "eve"))


class ContextTests(unittest.TestCase):
    WINDOW = {"effective": 258_400, "estimated": False, "source": "catalog"}

    def codex(self, used, summed):
        return {"total_tokens": used + 900, "input_tokens": used, "cached_input_tokens": 0, "output_tokens": 900, "input_summed": summed}

    def test_a_summed_reading_past_the_window_gets_no_percent(self):
        state = build_context_state(self.codex(707_646, True), self.WINDOW, "gpt")
        self.assertIsNone(state["percent"])
        self.assertEqual(state["measurement"], "summed")
        self.assertEqual(state["used_tokens"], 707_646)

    def test_other_readings_keep_their_percent(self):
        self.assertEqual(build_context_state(self.codex(129_200, True), self.WINDOW, "gpt")["percent"], 50.0)
        self.assertEqual(build_context_state(self.codex(707_646, False), self.WINDOW, "gpt")["percent"], 100.0)


class AttentionTests(unittest.TestCase):
    def test_a_room_members_question_opens_the_room(self):
        with patch("core.bot_rooms_store.room_for_seat", side_effect=lambda seat: ("room-1", "bot-1") if seat == "seat-1" else None), \
                patch.object(bot_attention, "_sessions", return_value=[]):
            self.assertEqual(bot_attention.target_for("bot-1", "david", {"session_id": "seat-1"}), {"tab": "botsRoom", "roomId": "room-1"})
            self.assertNotEqual((bot_attention.target_for("bot-1", "david", {"session_id": "chat-9"}) or {}).get("tab"), "botsRoom")


class AddonTests(unittest.TestCase):
    def test_a_broken_addon_never_ends_the_turn(self):
        def broken(name):
            raise FileNotFoundError("roblox_style.py is missing")
        with patch("core.addons.enabled", return_value=True), patch("core.addons.module", side_effect=broken), \
                patch.object(chat_service.session_manager, "get_session", return_value={}), \
                patch.object(chat_service.session_manager, "record_sent_text") as recorded, \
                patch.object(chat_service.session_manager, "record_image_attachments"), \
                self.assertLogs(chat_service.logger, "WARNING"):
            sent = chat_service._prepare_sent_text("chat-1", 0, "Hello", None)
        self.assertIn("Hello", sent)
        recorded.assert_called_once()


class NeedsYouTests(unittest.TestCase):
    # 2026-11-02: "Needs you" stayed after Mark done, and a bot waiting on an answer read as working.
    def test_marked_done_leaves_the_count(self):
        rows = [{"id": "item:a", "status": "open", "kind": "question", "bucket": "needs-you"},
                {"id": "item:b", "status": "open", "kind": "review", "bucket": "done"},
                {"id": "item:c", "status": "open", "kind": "report", "bucket": "news"}]
        with patch.object(bot_attention, "inbox", return_value={"rows": rows}):
            self.assertEqual([r["id"] for r in bot_attention.needs_you("david")["rows"]], ["item:a"])

    def summary(self, activity, inbox_items=(), done=()):
        from routes import agent_routes
        agent = {"id": "bot-1", "name": "Ada", "enabled": True}
        with patch("services.agent_handoff.person_inbox", return_value=list(inbox_items)), \
                patch("services.chat_live.agent_activity", return_value=activity), \
                patch.object(agent_routes, "_owned", return_value=[]), \
                patch.object(agent_routes.agent_service, "can_run", return_value=(True, "")), \
                patch.object(agent_routes.agent_service, "runs_today", return_value=0), \
                patch("core.bot_attention_store.inbox_preferences", return_value={key: {"done": True} for key in done}):
            return agent_routes._summary(agent, "david")

    def test_waiting_on_an_answer_is_needs_you_not_working(self):
        waiting = {"kind": "chat", "working": True, "waiting": True, "name": "Chat"}
        self.assertEqual(self.summary(waiting)["status"], "needs_you")
        self.assertEqual(self.summary({**waiting, "waiting": False})["status"], "working")
        self.assertEqual(self.summary(None)["status"], "idle")

    def test_a_bot_count_drops_what_was_marked_done(self):
        items = [{"id": "q1", "kind": "report"}, {"id": "q2", "kind": "report"}]
        self.assertEqual(self.summary(None, items)["needs_you"], 2)
        self.assertEqual(self.summary(None, items, done=["item:q1"])["needs_you"], 1)


class SetupCardTests(unittest.TestCase):
    def test_kip_never_gets_the_blank_bot_setup_card(self):
        from services import bot_setup
        with patch.object(bot_setup.bot_attention, "require_bot", return_value={"id": "kip", "builtin": "front_desk", "origin": {"kind": "blank"}}):
            self.assertFalse(bot_setup.eligible("kip", "david"))


if __name__ == "__main__":
    unittest.main()
