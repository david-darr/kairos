"""Daily sent-mail reconciliation using isolated stores; no real email or models."""
import copy
import json
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from test_crm import CRMService, settings, tab_api
from kairos_tabs.crm import daily


class DailyTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings.update_settings(enabled_tab_templates=["crm"])
        self.store = CRMService("daily-" + self._testMethodName + ".json")
        self.store.configure("alice", {"endpoint_id": "reader"})
        self.source = self.store.add_source("alice", "email", "mail", "Inbox")
        self.now = time.time()
        self.task = self.store.create_task("alice", {"title": "Send the revised proposal to John", "contact": "john@example.com"})
        with self.store.transaction():
            self.store._data["tasks"][self.task["id"]]["created_at"] = self.now - 3600
        self.task = self.store.task("alice", self.task["id"])
        self.message = {"sender": "me@example.com", "recipients": [{"name": "John", "email": "john@example.com"}],
                        "sent_at": datetime.fromtimestamp(self.now - 60, timezone.utc).isoformat(),
                        "subject": "Revised proposal", "body": "Here is the complete revised proposal: approved scope and price are below.",
                        "attachments": [], "account_id": "mail", "folder": "Sent", "external_id": "10:23",
                        "message_id": "<sent@example.com>", "url": "https://mail.google.com/mail/u/0/#all/123"}
        self.status = {"errors": [], "remaining": 0, "failed_ids": []}
        self.model = AsyncMock(side_effect=lambda *a, **k: self.decision())
        self.reader = MagicMock(side_effect=lambda *a: ([copy.deepcopy(self.message)], self.status))
        for change in (patch.object(daily, "crm_service", self.store),
                       patch.object(tab_api, "complete", self.model),
                       patch.object(tab_api, "model_context_size", return_value=32768),
                       patch.object(tab_api, "is_admin", return_value=True),
                       patch.object(tab_api, "email_accounts", return_value=[{"id": "mail", "email": "me@example.com"}]),
                       patch.object(tab_api, "email_sent_folder", return_value="Sent"),
                       patch.object(daily, "read_mailbox", self.reader)):
            change.start(); self.addCleanup(change.stop)

    def decision(self, **fields):
        return json.dumps({"completed": [{"task_id": self.task["id"], "quote": self.message["body"], "certain": True, **fields}]})

    async def check(self):
        return await daily.check_message("alice", [self.task], self.message, {self.source["id"]}, self.now)

    async def test_daily_detects_external_send_persists_evidence_and_runs_once_per_slot(self):
        await daily.run("alice", self.now)
        saved = self.store.task("alice", self.task["id"])
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["completion"]["kind"], "sent_email")
        self.assertEqual(saved["completion"]["url"], self.message["url"])
        self.assertEqual(saved["completion"]["message_id"], "<sent@example.com>")
        self.assertEqual(CRMService(self.store.name).daily_status("alice")["last_success"], self.now)
        await daily.run("alice", self.now + 60)
        self.reader.assert_called_once()
        self.assertIn("UNTRUSTED", self.model.call_args.args[2])

    async def test_next_day_and_missed_day_catchup(self):
        self.model.side_effect = None
        self.model.return_value = '{"completed": []}'
        await daily.run("alice", self.now)
        await daily.run("alice", self.now + 86400 * 3)
        self.assertEqual(self.reader.call_count, 2)

    async def test_failed_check_retries_hourly_and_does_not_mark_success(self):
        self.reader.side_effect = OSError("secret")
        await daily.run("alice", self.now)
        status = self.store.daily_status("alice")
        self.assertNotIn("last_success", status)
        self.assertNotIn("secret", status["error"])
        self.assertFalse(status["running"])
        await daily.run("alice", self.now + 60)
        self.assertEqual(self.reader.call_count, 1)
        await daily.run("alice", self.now + 3601)
        self.assertEqual(self.reader.call_count, 2)

    async def test_wrong_sender_and_wrong_recipient_stay_open(self):
        self.message["sender"] = "someone@example.com"
        await daily.run("alice", self.now)
        self.model.assert_not_awaited()
        self.message["recipients"][0]["email"] = "other@example.com"
        self.assertEqual(await self.check(), 0)
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")

    async def test_manual_name_only_task_matches_recipient_name(self):
        self.task = self.store.update_task("alice", self.task["id"], {"contact": ""})
        self.assertEqual(await self.check(), 1)

    async def test_draft_goal_and_non_send_goal_are_not_inferred_from_sending(self):
        for title in ("Draft an email to John", "Finish the revised proposal for John"):
            self.task = self.store.update_task("alice", self.task["id"], {"title": title})
            self.assertEqual(await self.check(), 0)
        self.model.assert_not_awaited()

    async def test_unrelated_partial_or_promised_work_stays_open(self):
        self.model.side_effect = None
        self.model.return_value = '{"completed": []}'
        self.message["body"] = "Thanks John, I will send the proposal tomorrow."
        self.assertEqual(await self.check(), 0)
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")

    async def test_old_mail_truncated_mail_and_reopen_cannot_close(self):
        original = self.message["sent_at"]
        self.message["sent_at"] = datetime.fromtimestamp(self.now - 7200, timezone.utc).isoformat()
        self.assertEqual(await self.check(), 0)
        self.message["sent_at"] = original
        self.message["truncated"] = True
        self.assertEqual(await self.check(), 0)
        self.message["truncated"] = False
        self.store.update_task("alice", self.task["id"], {"status": "done"})
        self.task = self.store.update_task("alice", self.task["id"], {"status": "active"})
        self.assertEqual(await self.check(), 0)

    async def test_edits_and_paused_source_during_model_are_preserved(self):
        async def judge(*a, **k):
            self.store.update_task("alice", self.task["id"], {"notes": "Scope changed"})
            return self.decision()
        self.model.side_effect = judge
        self.assertEqual(await self.check(), 0)
        self.task = self.store.task("alice", self.task["id"])
        async def pause(*a, **k):
            self.store.toggle_source("alice", self.source["id"], False)
            return self.decision()
        self.model.side_effect = pause
        self.assertEqual(await self.check(), 0)

    async def test_foreign_ids_hallucinated_quotes_and_uncertainty_rejected(self):
        self.model.side_effect = None
        foreign = self.store.create_task("bob", {"title": self.task["title"]})
        for fields in ({"task_id": foreign["id"]}, {"quote": "invented"}, {"certain": False}, {"certain": "true"}):
            self.model.return_value = self.decision(**fields)
            with self.assertRaises(ValueError):
                await self.check()
        self.assertEqual(self.store.task("bob", foreign["id"])["status"], "active")

    async def test_quoted_history_is_not_completion_evidence(self):
        self.message["body"] = "Thanks.\nOn Monday John wrote:\nHere is the complete revised proposal."
        self.model.side_effect = None
        self.model.return_value = self.decision(quote="Here is the complete revised proposal.")
        with self.assertRaises(ValueError):
            await self.check()

    async def test_disabled_missing_model_nonadmin_and_unselected_accounts_are_not_read(self):
        self.store.configure("alice", {"daily_completion": False})
        await daily.run("alice", self.now)
        self.store.configure("alice", {"daily_completion": True, "endpoint_id": None})
        await daily.run("alice", self.now)
        self.store.configure("alice", {"endpoint_id": "reader"})
        with patch.object(tab_api, "is_admin", return_value=False):
            await daily.run("alice", self.now)
        self.store.toggle_source("alice", self.source["id"], False)
        await daily.run("alice", self.now)
        self.reader.assert_not_called()

    async def test_incomplete_mailbox_coverage_is_visible(self):
        self.status["remaining"] = 5
        await daily.run("alice", self.now)
        status = self.store.daily_status("alice")
        self.assertIn("limit", status["error"])
        self.assertNotIn("last_success", status)

    async def test_foreign_source_and_oversize_context_are_rejected(self):
        self.task["source_id"] = "foreign-source"
        self.assertEqual(await self.check(), 0)
        self.task.pop("source_id")
        with patch.object(tab_api, "model_context_size", return_value=100):
            with self.assertRaises(ValueError):
                await self.check()

    async def test_connected_message_task_can_be_completed_by_selected_sent_mail(self):
        source = self.store.add_source("alice", "connector", "channel", "Work chat")
        with self.store.transaction():
            self.store._data["tasks"][self.task["id"]]["source_id"] = source["id"]
        await daily.run("alice", self.now)
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")

    async def test_multiple_required_recipients_cannot_be_satisfied_by_one(self):
        self.task = self.store.update_task("alice", self.task["id"], {"contact": "john@example.com, mary@example.com"})
        self.assertEqual(await self.check(), 0)
        self.model.assert_not_awaited()

    async def test_one_invalid_message_does_not_block_later_completion(self):
        self.reader.side_effect = None
        self.reader.return_value = ([copy.deepcopy(self.message), copy.deepcopy(self.message)], self.status)
        self.model.side_effect = ["invalid", self.decision()]
        await daily.run("alice", self.now)
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")
        self.assertIn("could not be verified", self.store.daily_status("alice")["error"])

    async def test_timezone_slot_runs_once_even_across_dst(self):
        self.store.configure("alice", {"timezone": "America/New_York"})
        self.model.side_effect = None
        self.model.return_value = '{"completed": []}'
        before = datetime(2026, 11, 1, 13, 59, tzinfo=timezone.utc).timestamp()
        # 08:59 EST catches up yesterday; 09:00 EST is today's new slot.
        await daily.run("alice", before - 3600)
        first = self.store.daily_status("alice")["slot"]
        await daily.run("alice", before + 61)
        self.assertGreater(self.store.daily_status("alice")["slot"], first)


class SentFolderTests(unittest.TestCase):
    def discover(self, rows):
        account = {"email": "me@example.com", "imap_host": "imap.test", "imap_port": 993, "password_encrypted": "opaque"}
        box = MagicMock()
        box.__enter__.return_value = box
        box.list.return_value = ("OK", rows)
        with patch("services.email_service.email_service.get_account", return_value=account), \
             patch.object(tab_api.imaplib, "IMAP4_SSL", return_value=box), \
             patch.object(tab_api.secret_storage, "decrypt", return_value="test"):
            result = tab_api.email_sent_folder("mail")
        box.select.assert_not_called()
        box.uid.assert_not_called()
        return result

    def test_special_use_localized_folder_and_existing_name_fallback(self):
        self.assertEqual(self.discover([b'(\\HasNoChildren \\Sent) "/" "&ZeVnLIqe-"']), "&ZeVnLIqe-")
        self.assertEqual(self.discover([b'(\\HasNoChildren) "/" "Sent Items"']), "Sent Items")

    def test_unknown_or_ambiguous_folders_are_not_guessed(self):
        for rows in ([b'(\\HasNoChildren) "/" "INBOX"'],
                     [b'() "/" "Sent"', b'() "/" "Sent Items"'],
                     [b'(\\Noselect \\Sent) "/" "Sent"']):
            with self.assertRaises(ValueError):
                self.discover(rows)


if __name__ == "__main__":
    unittest.main()
