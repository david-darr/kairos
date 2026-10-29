import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from test_bots_departments import TeamsCase, teams, HTTPException, agent_service
from core.session_manager import session_manager
from services import bot_setup as setup, bot_chat_service, bot_attention, chat_service


class SetupTests(TeamsCase):
    def setUp(self):
        super().setUp()
        setup._path().unlink(missing_ok=True)
        setup._cache.clear()

    def main(self, bot):
        session = session_manager.create_session("Setup", owner_user="local")
        agent_service.make_agent_chat(session["id"], bot)
        return session["id"]

    def test_constraints_and_fixed_fallback(self):
        bot = self.bot()
        self.assertEqual(setup.valid_choices(setup.FIXED), setup.FIXED)
        bad = ["A health treatment", "Use the API", "Send @some links", "Read 42 new pages", "Mixed сyrillic letters", "Only two"]
        self.assertEqual(setup.valid_choices(bad), [])
        result = setup.suggestions(bot["id"], "local")
        self.assertTrue(result["eligible"])
        self.assertEqual([r["key"] for r in result["choices"]], list("ABCDE"))

    def test_personalisation_and_deadline_fallback(self):
        bot = self.bot()
        async def run():
            generated = AsyncMock(return_value=setup.FIXED[:3])
            first = setup.suggestions(bot["id"], "local", generator=generated)
            self.assertTrue(first["pending"])
            await setup._tasks[bot["id"]]
            self.assertEqual(len(setup.suggestions(bot["id"], "local")["choices"]), 3)
            setup._cache.clear()
            bad = AsyncMock(return_value=["invalid"])
            setup.suggestions(bot["id"], "local", generator=bad)
            await setup._tasks[bot["id"]]
            self.assertEqual(len(setup.suggestions(bot["id"], "local")["choices"]), 5)
        asyncio.run(run())

    def test_eligibility_arm_pick_close_and_send_id(self):
        bot = self.bot()
        sid = self.main(bot)
        with patch.object(bot_attention, "require_thread", return_value=session_manager.get_session(sid)):
            armed = asyncio.run(setup.pick(bot["id"], sid, None, "local"))
            self.assertEqual(armed["state"], "armed")
            setup.close(bot["id"], "local")
            self.assertEqual(setup.request(bot["id"], "local")["state"], "closed")
            with patch.object(bot_chat_service, "send", new=AsyncMock(return_value={"accepted": True})) as send:
                sent = asyncio.run(setup.pick(bot["id"], sid, "Check reports", "local"))
                repeated = asyncio.run(setup.pick(bot["id"], sid, "Check reports", "local"))
            self.assertEqual(send.await_count, 1)
            self.assertEqual(sent["id"], repeated["id"])
        self.assertFalse(setup.eligible(bot["id"], "local"))
        another = self.bot("Preset", origin={"kind": "duplicate", "from_agent_id": bot["id"]})
        self.assertFalse(setup.eligible(another["id"], "local"))

    def test_setup_job_brief_restricted_and_chief_keeps_duties(self):
        bot, team = self.team()
        teams.set_chief(team["id"], bot["id"])
        sid = self.main(bot)
        index = session_manager.append_message(sid, "user", "/setup Check reports")
        with patch.object(chat_service, "_apply_attachments", side_effect=lambda sid, text, ids: text), patch.object(chat_service, "_apply_open_mic_discipline", side_effect=lambda sid, text: text):
            sent = chat_service._prepare_sent_text(sid, index, "/setup Check reports", [])
        self.assertIn("Check reports", sent)
        self.assertIn("Chief keeps its Chief duties", sent)
        self.assertIn("cannot change your peers", sent)
        self.assertEqual(session_manager.get_session(sid)["messages"][index]["content"], "/setup Check reports")


if __name__ == "__main__":
    unittest.main()
