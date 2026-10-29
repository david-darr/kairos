import asyncio
import unittest
from unittest.mock import AsyncMock, patch
from test_bots_departments import TeamsCase, teams, HTTPException, agent_service
from core.session_manager import session_manager
from services import bot_incidents as incidents, bot_chat_service, bot_attention


class IncidentTests(TeamsCase):
    def setUp(self):
        super().setUp()
        incidents._path().unlink(missing_ok=True)
        self.owns_patch = patch.object(bot_attention, "owns", side_effect=lambda s, u: s.get("owner_user") == u)
        self.owns_patch.start()
        self.addCleanup(self.owns_patch.stop)
        self.notifications = patch.object(incidents, "_notify")
        self.notify = self.notifications.start()
        self.addCleanup(self.notifications.stop)

    def conversation(self, bot):
        s = session_manager.create_session("Failed job", owner_user="local")
        agent_service.make_agent_chat(s["id"], bot)
        session_manager.append_message(s["id"], "user", "Check totals")
        session_manager.append_message(s["id"], "assistant", "Provider failed", status="failed")
        return s["id"]

    def test_suppression_redaction_person_and_idempotence(self):
        bot, _ = self.team()
        sid = self.conversation(bot)
        with patch.object(incidents, "_dispatch", new=AsyncMock(return_value={"accepted": True})):
            first = asyncio.run(incidents.report(bot["id"], sid, "failed", "password=secret", event_id="evt"))
            second = asyncio.run(incidents.report(bot["id"], sid, "failed", "duplicate", event_id="evt"))
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(first["delivery"], "person")
        session_manager.set_thread(sid, opened_by="handoff")
        with patch.object(incidents, "_assigned", return_value=True):
            self.assertTrue(asyncio.run(incidents.report(bot["id"], sid))["suppressed"])
        with patch.object(incidents, "_session", return_value=(bot, {"id": sid, "quiet": True})):
            self.assertTrue(asyncio.run(incidents.report(bot["id"], sid))["suppressed"])

    def test_ledger_retry_two_mute_above_five_and_exclusions(self):
        bot, _ = self.team()
        sid = self.conversation(bot)
        with patch.object(incidents, "_dispatch", new=AsyncMock(return_value={"accepted": True})) as dispatch:
            rows = [asyncio.run(incidents.report(bot["id"], sid, "failed", "failed", event_id=str(n))) for n in range(6)]
            self.assertEqual(dispatch.await_count, 2)
        self.assertEqual(rows[-1]["delivery"], "muted")
        self.assertEqual(incidents._bucket(incidents._read(), sid)["retries"], 2)
        with self.assertRaises(HTTPException):
            asyncio.run(incidents.retry_thread(rows[0]["id"], user="local"))
        other = self.conversation(bot)
        row = asyncio.run(incidents.report(bot["id"], other, "stalled", "stuck"))
        with self.assertRaises(HTTPException):
            asyncio.run(incidents.retry_thread(row["id"], user="local"))

    def test_chief_notice_and_refused_start_row(self):
        chief, team = self.team()
        bot = self.bot("Worker", section="Research")
        teams.set_chief(team["id"], chief["id"])
        sid = self.conversation(bot)
        with patch.object(incidents, "_dispatch", new=AsyncMock(side_effect=ValueError("No provider"))):
            row = asyncio.run(incidents.report(bot["id"], sid, "stalled", "Failure details"))
        self.assertEqual(row["delivery"], "refused")
        messages = session_manager.get_session(row["chief_thread_id"])["messages"]
        self.assertTrue(any(m.get("kind") == "incident" for m in messages))
        self.assertTrue(any("could not reach" in m["content"] for m in messages))
        self.notify.assert_called()

    def test_retry_refuses_changed_busy_queued_and_last_retry(self):
        bot, _ = self.team()
        sid = self.conversation(bot)
        with patch.object(incidents, "retry_thread", new=AsyncMock(side_effect=HTTPException(409))):
            row = asyncio.run(incidents.report(bot["id"], sid, "failed", "Failure"))
        session_manager.append_message(sid, "user", "New instructions")
        with self.assertRaises(HTTPException):
            asyncio.run(incidents.retry_thread(row["id"], user="local"))
        with patch.object(bot_chat_service, "_reason", return_value="busy"), self.assertRaises(HTTPException):
            asyncio.run(incidents.retry_thread(row["id"], user="local"))
        with patch.object(bot_chat_service, "_reason", return_value="queued-ahead"), self.assertRaises(HTTPException):
            asyncio.run(incidents.retry_thread(row["id"], user="local"))

    def test_adapter_never_promotes_to_admin(self):
        bot, _ = self.team()
        sid = self.conversation(bot)
        from services import chat_service
        with patch.object(chat_service, "send_message", new=AsyncMock(return_value="Fixed")) as send:
            asyncio.run(incidents._dispatch(bot["id"], sid, "Try again", "safe-id", retry=True))
        self.assertIs(send.await_args.kwargs["is_admin"], False)
        self.assertTrue(send.await_args.kwargs["claimed"])
        self.assertFalse(chat_service.is_busy(sid))

    def test_escalations_off_and_corrupt_ledger_blocks(self):
        bot, _ = self.team()
        sid = self.conversation(bot)
        self.assertTrue(asyncio.run(incidents.report(bot["id"], sid, "needs-input"))["suppressed"])
        incidents._path().parent.mkdir(parents=True, exist_ok=True)
        incidents._path().write_text("broken", encoding="utf-8")
        with self.assertRaises(HTTPException):
            asyncio.run(incidents.report(bot["id"], sid))


if __name__ == "__main__":
    unittest.main()
