"""Phase 5 U2: derived states, actual P1 admission, suggestion persistence."""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data_support import TestDataDirectory
_DATA = TestDataDirectory("kairos-fdwork-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]

from bots_chat_harness import Harness, OWNER
from core import bot_chat_store, session_manager_store
from core.atomic_io import write_json_atomic
from core.session_manager import session_manager
from services import front_desk_tasks as tasks, front_desk_work as work, front_desk_suggestions as suggestions
from services.agent_service import agent_service


class StateTests(unittest.TestCase):
    def setUp(self):
        self.now = time.time()
        self.task = {"id": "t", "created_at": self.now - 120, "thread_id": "s", "resolved_at": None}
        self.s = {"messages": [], "cards": [], "approvals": [], "questions": [], "queue": [],
                  "turn_count": 1, "processing": False, "dispatching": False, "runs": []}

    def message(self, text="Finished. Open the file.", **extra):
        self.s["messages"].append({"role": "assistant", "content": text, "ts": self.now - 30, **extra})

    def state(self):
        return work.project(self.task, snapshot=self.s, now=self.now)["state"]

    def test_lost_internal_turn(self):
        self.assertEqual(self.state(), "failed")
        self.assertIn("interrupted", work.project(self.task, snapshot=self.s, now=self.now)["next_step"])

    def test_every_needs_input_source_beats_working_resolved_and_failure(self):
        for key in ("cards", "approvals", "questions"):
            with self.subTest(key=key):
                self.s[key] = [{"id": "pending"}]
                self.s["processing"] = True
                self.task["resolved_at"] = self.now
                self.message("Failed", failure_kind="model_error")
                self.assertEqual(self.state(), "needs_input")
                self.s[key] = []

    def test_last_question_only_when_no_newer_words(self):
        self.message("Which day?", ts=self.now - 90)
        self.assertEqual(self.state(), "needs_input")
        self.s["messages"].append({"role": "user", "content": "Tuesday", "ts": self.now - 70})
        self.assertEqual(self.state(), "failed")
        self.message("Done.")
        self.assertEqual(self.state(), "ready_for_review")

    def test_working_sources(self):
        for key, value in (("processing", True), ("queue", [{"state": "pending"}]), ("dispatching", True)):
            with self.subTest(key=key):
                self.task["created_at"] = self.now - 10
                self.s[key] = value
                self.assertEqual(self.state(), "working")
                self.s[key] = [] if key == "queue" else False

    def test_grace_and_stale_dispatch(self):
        self.task["created_at"] = self.now - 59
        self.assertEqual(self.state(), "working")
        self.task["created_at"] = self.now - 61
        self.s["dispatching"] = True
        self.assertEqual(self.state(), "failed")

    def test_resolved_reverts_for_new_assistant_work(self):
        self.message()
        self.task["resolved_at"] = self.now - 20
        self.assertEqual(self.state(), "resolved")
        self.message("New result.", ts=self.now - 10)
        self.assertEqual(self.state(), "ready_for_review")

    def test_pending_stop_is_finished_never_failed(self):
        for outcome in ("stopped", "needs_input", "waiting"):
            self.s["turn"] = {"status": outcome, "started_at": self.now - 100}
            self.assertEqual(self.state(), "ready_for_review")
        self.s["cards"] = [{"id": "approval"}]
        self.assertEqual(self.state(), "needs_input")

    def test_failure_reasons_are_plain_and_next_step(self):
        self.message("Private provider error", failure_kind="rate_limited")
        row = work.project(self.task, snapshot=self.s, now=self.now)
        self.assertEqual(row["state"], "failed")
        self.assertNotIn("Private", row["next_step"])
        self.assertEqual(work.next_step("First. Next step?"), "Next step?")


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Kip test")
        agent_service._agents[self.bot["id"]]["builtin"] = "front_desk"
        self.bot = agent_service.get(self.bot["id"])
        self.main = self.h.thread(self.bot)
        write_json_atomic(os.path.join(tasks.DIRECTORY, "state.json"),
                          {"bot_id": self.bot["id"], "main_thread_id": self.main})
        tasks.write_rows("tasks", [])
        tasks.write_rows("suggestions", [])

    def start(self, ask="[reply:Ready to read.]", send_id="start-once"):
        task = tasks.start(ask, origin="asked", send_id=send_id)
        if task["thread_id"] not in self.h.threads:
            self.h.threads.append(task["thread_id"])
        return task

    async def test_start_creates_thread_and_one_real_turn(self):
        first = self.start()
        again = self.start()
        self.assertEqual(first, again)
        session = session_manager.get_session(first["thread_id"])
        self.assertEqual(session["owner_user"], OWNER)
        self.assertEqual(session["thread"]["opened_by"], "task")
        self.assertFalse(session["thread"]["main"])
        self.assertEqual(tasks.derive_state(first), "working")
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 1)
        self.assertEqual(tasks.derive_state(first), "ready_for_review")
        self.assertEqual(len(tasks.list_tasks(OWNER)), 1)
        self.assertEqual(tasks.list_tasks("someone-else"), [])
        with self.assertRaises(KeyError):
            tasks.get(first["id"], "someone-else")
        with self.assertRaises(bot_chat_store.Conflict):
            self.start("Different work")

    async def test_try_again_two_taps_one_turn_and_stale_generation(self):
        task = self.start("[fail]")
        await self.h.idle()
        row = work.project(task)
        self.assertEqual(row["state"], "failed")
        tasks.again(task["id"], user=OWNER, expected_turn_count=row["turn_count"])
        tasks.again(task["id"], user=OWNER, expected_turn_count=row["turn_count"])
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 2)
        tasks.again(task["id"], user=OWNER, expected_turn_count=row["turn_count"])
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 2)

    async def test_real_queue_uses_same_receipts_and_slots(self):
        agent_service._agents[self.bot["id"]]["thread_limit"] = 1
        one = self.start("[hold]", "task-first")
        await self.h.held()
        two = self.start("second", "task-second")
        self.assertEqual(tasks.derive_state(two), "working")
        self.assertEqual(len(self.h.queue(two["thread_id"])["items"]), 1)
        self.h.release()
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 2)
        self.assertEqual(tasks.derive_state(two), "ready_for_review")

    async def test_resolve_reopen_and_seven_day_fold(self):
        task = self.start()
        await self.h.idle()
        tasks.resolve(task["id"], user=OWNER)
        self.assertEqual(work.work(user=OWNER)["groups"]["resolved"], [])
        self.assertEqual(len(work.work(user=OWNER, resolved=True)["groups"]["resolved"]), 1)
        self.assertEqual(tasks.resolve(task["id"], user=OWNER, reopen=True)["state"], "ready_for_review")

    async def test_dedupe_hide_cap_and_start_two_taps(self):
        first = suggestions.add("Reply to Sam", "Ask for a date", {"app": "mail", "ref": "uid1"}, "check_in", "run-1")
        self.assertIsNone(suggestions.add(" reply   to sam ", "Again", None, "asked"))
        suggestions.hide(first["id"], user=OWNER)
        self.assertIsNone(suggestions.add("Reply to Sam", "Again", None, "asked"))
        with patch.object(suggestions.time, "time", return_value=time.time() + 14 * 86400 + 1):
            self.assertIsNotNone(suggestions.add("Reply to Sam", "Again", None, "asked"))
        for i in range(4):
            self.assertIsNotNone(suggestions.add(f"Idea {i}", "", None, "check_in", "run-1"))
        self.assertIsNone(suggestions.add("Sixth idea", "", None, "check_in", "run-1"))
        item = suggestions.list_suggestions(OWNER)[0]
        task = suggestions.start(item["id"], user=OWNER)
        self.h.threads.append(task["thread_id"])
        self.assertEqual(task["id"], suggestions.start(item["id"], user=OWNER)["id"])
        await self.h.idle()
        self.assertEqual(len(self.h.prompts), 1)
        with self.assertRaises(KeyError):
            suggestions.hide(first["id"], user="someone-else")

    async def test_report_is_branch_aware_and_resources_are_inert(self):
        task = self.start()
        await self.h.idle()
        session_manager.append_message(task["thread_id"], "user", "Revise the plan")
        session_manager.append_message(task["thread_id"], "assistant", "Revised. Read the plan.", extra={
            "resources": [{"kind": "mail", "id": "u1", "title": "<img>", "url": "javascript:alert(1)"}]})
        result = work.report(task["id"], user=OWNER)
        self.assertEqual(result["updates"][-1]["text"], "Revised.")
        self.assertEqual(result["resources"][0]["title"], "<img>")
        self.assertIsNone(result["resources"][0]["url"])
        self.assertEqual(sum(u["kind"] == "reply" for u in result["updates"]), 1)

    async def test_optional_card_adapter_contract(self):
        from types import SimpleNamespace
        rows = [{"id": "p", "status": "pending"}, {"id": "d", "status": "allowed"}]
        fake = SimpleNamespace(store=lambda: SimpleNamespace(list_cards=lambda owner, thread_id=None: rows))
        with patch.object(work, "optional_service", return_value=fake):
            self.assertEqual([c["id"] for c in work.pending_cards(self.main)], ["p"])
            self.assertEqual([c["id"] for c in work.decisions(self.main)], ["d"])


if __name__ == "__main__":
    unittest.main()
