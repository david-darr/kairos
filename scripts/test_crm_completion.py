"""Completion contracts: isolated CRM stores, synthetic turns, no model/network."""
import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, patch

from test_crm import CRMService, settings, tab_api, crm_scanner, message, item
from kairos_tabs.crm import completion
from core import tab_hooks, tab_folders, session_manager_store
from core.session_manager import session_manager


class CompletionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        settings.update_settings(enabled_tab_templates=["crm"])
        self.store = CRMService("completion-" + self._testMethodName + ".json")
        self.store.configure("alice", {"endpoint_id": "reader"})
        self.task = self.store.create_task("alice", {"title": "Send the revised proposal to Morgan"})
        self.turn = {"id": "run1", "session_id": "chat1", "at": time.time() + 1,
                     "message": "I sent the revised proposal to Morgan.", "reply": "Thanks for the update.", "actions": []}
        self.patch = patch.object(completion, "crm_service", self.store)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.model = AsyncMock(return_value=self.decision())
        for change in (patch.object(tab_api, "complete", self.model),
                       patch.object(tab_api, "model_context_size", return_value=8192),
                       patch.object(tab_api, "backlog_card", return_value=None),
                       patch.object(tab_api, "backlog_result", return_value=None)):
            change.start(); self.addCleanup(change.stop)

    def decision(self, **fields):
        return json.dumps({"completed": [{"task_id": self.task["id"], "actor": "user",
            "quote": self.turn["message"], "certain": True, "requires_action": False, **fields}]})

    async def run_check(self):
        await completion.check("alice", [self.task], self.turn)
        return self.store.task("alice", self.task["id"])

    async def test_manual_report_completes_with_audit_and_survives_restart(self):
        saved = await self.run_check()
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["completion"]["actor"], "user")
        self.assertEqual(saved["completion"]["session_id"], "chat1")
        self.assertEqual(CRMService(self.store.name).task("alice", self.task["id"])["status"], "done")
        self.assertIn("UNTRUSTED", self.model.call_args.args[2])

    async def test_assistant_action_requires_a_successful_recorded_action(self):
        self.turn["message"] = "Please send the revised proposal to Morgan."
        self.turn["reply"] = "I sent the revised proposal to Morgan."
        self.model.return_value = self.decision(actor="assistant", quote=self.turn["reply"], requires_action=True)
        self.assertEqual((await self.run_check())["status"], "active")
        self.turn["actions"] = [{"name": "send_email", "ok": False, "detail": "Delivery failed"}]
        self.assertEqual((await self.run_check())["status"], "active")
        self.turn["actions"] = [{"name": "send_email", "ok": True, "detail": "Message sent to Morgan"}]
        self.assertEqual((await self.run_check())["status"], "done")

    async def test_misattributed_assistant_quote_cannot_bypass_action_evidence(self):
        self.turn.update(message="Please send the proposal.", reply="I sent the revised proposal to Morgan.")
        self.model.return_value = self.decision(actor="user", quote=self.turn["reply"], requires_action=False)
        self.assertEqual((await self.run_check())["status"], "active")
        self.turn["actions"] = [{"name": "send_email", "ok": True, "detail": "Sent to Morgan"}]
        saved = await self.run_check()
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["completion"]["actor"], "assistant")

    async def test_text_deliverable_can_complete_without_a_tool(self):
        self.task = self.store.update_task("alice", self.task["id"], {"title": "Summarize the meeting"})
        self.turn["reply"] = "Meeting summary: Morgan approved the proposal; the team will send it Friday."
        self.model.return_value = self.decision(actor="assistant", quote=self.turn["reply"], requires_action=False)
        self.assertEqual((await self.run_check())["status"], "done")

    async def test_plans_negations_and_partial_work_remain_open(self):
        for text in ("I will send the revised proposal to Morgan.", "I have not sent the revised proposal to Morgan."):
            self.turn["message"] = text
            self.model.return_value = self.decision()
            self.assertEqual((await self.run_check())["status"], "active")
        for text in ("Please draft a proposal reply.", "I sent the cover note; the proposal still needs revisions."):
            self.turn["message"] = text
            self.model.return_value = '{"completed": []}'
            self.assertEqual((await self.run_check())["status"], "active")

    async def test_hallucinated_quotes_foreign_ids_uncertainty_and_string_booleans_rejected(self):
        foreign = self.store.create_task("bob", {"title": self.task["title"]})
        for fields in ({"quote": "invented"}, {"task_id": foreign["id"]}, {"certain": "true"}, {"certain": False}, {"requires_action": "false"}):
            self.model.return_value = self.decision(**fields)
            with self.assertRaises(ValueError):
                await self.run_check()
        self.assertEqual(self.store.task("bob", foreign["id"])["status"], "active")
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")

    async def test_edits_and_reopens_during_classification_are_not_overwritten(self):
        async def judge(*args, **kwargs):
            self.store.update_task("alice", self.task["id"], {"notes": "Changed scope"})
            return self.decision()
        self.model.side_effect = judge
        self.assertEqual((await self.run_check())["status"], "active")
        self.store.update_task("alice", self.task["id"], {"status": "done"})
        self.store.update_task("alice", self.task["id"], {"status": "active"})
        self.model.side_effect = None
        self.assertEqual((await self.run_check())["status"], "active")

    async def test_disabling_tab_during_classification_keeps_task_open(self):
        async def judge(*args, **kwargs):
            settings.update_settings(enabled_tab_templates=[])
            return self.decision()
        self.model.side_effect = judge
        self.assertEqual((await self.run_check())["status"], "active")

    async def test_receipts_are_owned_durable_deduplicated_and_retries_bounded(self):
        self.store.create_task("bob", {"title": self.task["title"]})
        self.assertTrue(self.store.queue_completion("alice", self.turn))
        self.assertFalse(self.store.queue_completion("alice", self.turn))
        restored = CRMService(self.store.name)
        self.assertEqual([t["id"] for t in restored.completion_queue()[0]["tasks"]], [self.task["id"]])
        self.model.side_effect = RuntimeError("provider unavailable")
        for _ in range(4):
            await completion.process()
        self.assertEqual(self.model.await_count, 3)
        self.assertEqual(self.store.completion_queue(), [])
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")

    async def test_done_assignment_closes_without_model_and_does_not_reclose_after_reopen(self):
        self.store.attach_card("alice", self.task["id"], "card1")
        self.store.configure("alice", {"endpoint_id": None})
        card = {"id": "card1", "status": "done", "comments": []}
        with patch.object(tab_api, "backlog_card", return_value=card):
            await completion.process()
            self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")
            self.store.update_task("alice", self.task["id"], {"status": "active"})
            await completion.process()
            self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")
        self.model.assert_not_awaited()

    async def test_new_manual_board_completion_after_a_crm_edit_is_honored(self):
        self.store.attach_card("alice", self.task["id"], "card1")
        self.store.update_task("alice", self.task["id"], {"status": "active", "notes": "Use the latest proposal"})
        card = {"id": "card1", "status": "done", "status_changed_at": time.time() + 1, "comments": []}
        with patch.object(tab_api, "backlog_card", return_value=card):
            await completion.process()
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")

    async def test_successful_assignment_output_is_checked_once_and_failed_cards_stay_open(self):
        self.store.attach_card("alice", self.task["id"], "card1")
        output = "I sent the revised proposal to Morgan."
        card = {"id": "card1", "status": "blocked", "comments": []}
        with patch.object(tab_api, "backlog_card", return_value=card):
            await completion.process()
            self.model.assert_not_awaited()
            card.update(status="review", comments=[{"kind": "result", "text": output, "at": self.turn["at"]}])
            self.model.return_value = self.decision(actor="assistant", quote=output, requires_action=True)
            with patch.object(tab_api, "backlog_result", return_value={"output": output, "actions": [{"name": "send_email", "ok": True, "detail": "Sent to Morgan"}]}):
                await completion.process()
            self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")
            await completion.process()
        self.assertEqual(self.model.await_count, 1)

    async def test_input_is_bounded_and_no_model_fallback_is_used(self):
        self.turn["reply"] = "a" * 100000
        prompt, _, reply = completion._input([self.task], self.turn, "reader")
        self.assertLess(len(prompt.encode()) + len(completion.SYSTEM.encode()), 8192 - 1500)
        self.assertLess(len(reply), 100000)
        self.assertIn('"context_incomplete": true', prompt)
        self.store.configure("alice", {"endpoint_id": None})
        with patch.object(completion, "start") as started:
            completion.capture("alice", self.turn)
            started.assert_not_called()

    async def test_explicit_source_completion_closes_but_ambiguous_confirmation_does_not(self):
        source = self.store.add_source("alice", "email", "mail", "Inbox")
        first = self.store.capture(source, message())
        self.store.apply("alice", first["id"], [item(review_reason=None)])
        task = next(t for t in self.store.tasks("alice") if t.get("source_id"))
        text = "The revised proposal has been sent."
        second = self.store.capture(source, message(external_id="new", body=text))
        self.store.apply("alice", second["id"], [item(match_task_id=task["id"], evidence=text, status="done", review_reason="Confirm the action")])
        self.assertEqual(self.store.task("alice", task["id"])["status"], "active")
        third = self.store.capture(source, message(external_id="newer", body=text))
        self.store.apply("alice", third["id"], [item(match_task_id=task["id"], evidence=text, status="done", review_reason=None)])
        saved = self.store.task("alice", task["id"])
        self.assertEqual(saved["status"], "done")
        self.assertEqual(saved["completion"]["message_id"], third["id"])
        self.assertIsNone(saved["proposal"])

    async def test_new_task_review_setting_does_not_block_clear_existing_task_completion(self):
        body = "The revised proposal has been sent."
        candidate = item(evidence=body, status="done", match_task_id=self.task["id"], due_date=None, deadline_text="")
        checked = crm_scanner.validate_output(json.dumps({"tasks": [candidate]}), message(body=body), body,
            [self.task], {**self.store.settings("alice"), "review_all": True})
        self.assertEqual(checked[0]["status"], "done")
        self.assertIsNone(checked[0]["review_reason"])

    async def test_unrelated_chat_does_not_spend_a_model_call_and_linked_done_has_context(self):
        unrelated = {**self.turn, "message": "Hello, how are you?", "reply": "Hello!"}
        self.assertFalse(self.store.queue_completion("alice", unrelated))
        self.store.set_work("alice", self.task["id"], chat_session_id="chat1")
        self.assertTrue(self.store.queue_completion("alice", {**unrelated, "message": "Done."}))

    async def test_a_delayed_old_turn_cannot_close_a_new_task(self):
        self.assertFalse(self.store.queue_completion("alice", {**self.turn, "at": self.task["created_at"] - 1}))

    async def test_completed_assignment_without_action_evidence_cannot_claim_a_send(self):
        self.store.attach_card("alice", self.task["id"], "card1")
        output = "I sent the revised proposal to Morgan."
        self.model.return_value = self.decision(actor="assistant", quote=output, requires_action=True)
        with patch.object(tab_api, "backlog_card", return_value={"id": "card1", "status": "review", "comments": [
                {"kind": "result", "text": output, "at": self.turn["at"]}]}):
            await completion.process()
        self.assertEqual(self.store.task("alice", self.task["id"])["status"], "active")

    async def test_successful_chat_receipt_runs_the_background_worker_end_to_end(self):
        session = {"id": "chat1", "owner_user": "alice", "messages": [{"run_id": "run1"}]}
        try:
            with patch("core.auth.auth_enabled", return_value=True), \
                 patch.object(session_manager_store, "get_run", return_value={"outcome": "finished", "ended_at": self.turn["at"]}), \
                 patch.object(session_manager_store, "run_events", return_value=[]):
                tab_hooks.emit_chat_turn(session, self.turn["message"], self.turn["reply"])
                for _ in range(100):
                    if self.store.task("alice", self.task["id"])["status"] == "done":
                        break
                    await asyncio.sleep(.02)
                self.assertEqual(self.store.task("alice", self.task["id"])["status"], "done")
                self.assertEqual(self.store.completion_queue(), [])
        finally:
            await completion.stop()


class ReceiptBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_successful_owned_runs_dispatch_to_declared_hooks(self):
        session = {"id": "chat", "owner_user": "alice", "messages": [{"run_id": "run"}]}
        dispatch = AsyncMock()
        with patch("core.auth.auth_enabled", return_value=True), \
             patch.object(session_manager_store, "get_run", return_value={"outcome": "finished", "ended_at": 123}) as run, \
             patch.object(session_manager_store, "run_events", return_value=[]), \
             patch.object(tab_folders, "_registered", {"crm": {"slug": "crm"}}), \
             patch.object(tab_hooks, "_declared", dispatch):
            tab_hooks.emit_chat_turn(session, "I finished it", "Acknowledged")
            await asyncio.sleep(.01)
            self.assertEqual(dispatch.await_args.args[:3], ({"slug": "crm"}, "on_chat_turn", "alice"))
            dispatch.reset_mock()
            run.return_value["outcome"] = "failed"
            tab_hooks.emit_chat_turn(session, "Do it", "Done")
            await asyncio.sleep(.01)
            dispatch.assert_not_awaited()
            run.return_value["outcome"] = "finished"
            session["owner_user"] = None
            tab_hooks.emit_chat_turn(session, "Done", "Done")
            await asyncio.sleep(.01)
            dispatch.assert_not_awaited()

    async def test_tab_chat_owner_binding_is_preserved_and_foreign_rebinding_refused(self):
        sid = session_manager.get_or_create_channel_session("crm:ownership-test", "Task", owner_user="alice")
        self.assertEqual(session_manager.get_session(sid)["owner_user"], "alice")
        self.assertEqual(session_manager.get_or_create_channel_session("crm:ownership-test", "Task", owner_user="alice"), sid)
        with self.assertRaises(ValueError):
            session_manager.get_or_create_channel_session("crm:ownership-test", "Task", owner_user="bob")


if __name__ == "__main__":
    unittest.main(verbosity=2)
