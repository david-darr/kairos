"""Agent handoffs with isolated storage and stand-in models; no subprocesses."""
import asyncio
from contextlib import asynccontextmanager
import os
from pathlib import Path
import sys
import shutil
import uuid
import unittest
from unittest.mock import AsyncMock, patch

_ROOT = Path(__file__).resolve().parents[1]
(_ROOT / "data").mkdir(exist_ok=True)
_DATA = _ROOT / "data" / ("kairos-handoff-" + uuid.uuid4().hex)
_DATA.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(_DATA)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import chat_references, outbox, permissions, runs, task_scheduler, tool_registry
from core.session_manager import session_manager
from services import agent_handoff, chat_service
from services.agent_service import agent_service
from services.task_service import task_service


class FakeBrain:
    pending_reference_taint = False
    prompt = ""
    ask = False
    fail = False

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        self.prompt = prompt
        if self.fail:
            raise ValueError("Failed work")
        if self.ask:
            await tool_registry.call("agent_ask", {"question": "Which region?", "context": "Two choices"},
                                     tool_registry.ToolContext(agent_id=self.agent_id), tool_registry.CLAUDE)
        yield runs.text("Two remote roles found.")
        yield runs.result(False)


@asynccontextmanager
async def no_checkpoints(*args, **kwargs):
    yield


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.agent = agent_service.create("Scout", role="Watches postings")
        self.source = session_manager.create_session()["id"]
        self.other = session_manager.create_session()["id"]
        self.refs = [{"kind": "agent", "id": self.agent["id"], "label": "Scout"}]
        self.brain = FakeBrain()
        self.brain.agent_id = self.agent["id"]
        for target, name, value in [(task_scheduler, "_task_brain", lambda task: self.brain),
                                    (task_scheduler.file_checkpoints, "around_turn", no_checkpoints),
                                    (task_scheduler.events, "emit", None), (agent_service, "_announce", None),
                                    (task_scheduler.logger, "exception", None),
                                    (outbox, "kick", None)]:
            p = patch.object(target, name, side_effect=value)
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(agent_service.delete, self.agent["id"])
        self.addCleanup(task_service.delete_agent_work, self.agent["id"])

    def messages(self, session_id=None):
        return session_manager.get_session(session_id or self.source)["messages"]

    def card(self):
        return next(t for t in task_service.list_tasks() if t.get("agent_id") == self.agent["id"])

    def handoff(self):
        return asyncio.run(chat_service.send_message(self.source, "Find remote roles", is_admin=True, references=self.refs))

    def run_card(self):
        card = task_service.claim_next_card(card_id=self.card()["id"], eligible=task_scheduler.agent_may_run)
        self.assertIsNotNone(card)
        asyncio.run(task_scheduler.start_run(card))

    def test_reference_card_context_and_no_model_turn(self):
        for i in range(12):
            session_manager.append_message(self.source, "user", f"context {i}: " + "x" * 2000)
        with patch.object(chat_service, "_get_brain", new=AsyncMock(side_effect=AssertionError("Chat model ran"))), \
             patch.object(chat_service, "_compact_if_nearly_full", new=AsyncMock(side_effect=AssertionError("Compaction ran"))):
            reply = self.handoff()
        self.assertIn("Handed to Scout", reply)
        card = self.card()
        self.assertEqual((card["schedule_kind"], card["status"], card["reply_to"]), ("card", "ready", self.source))
        self.assertEqual(card["prompt"], "Find remote roles")
        self.assertIn("context 2:", card["context"])
        self.assertNotIn("context 1:", card["context"])
        self.assertIn("recent context from another conversation", card["context"])
        self.assertIn("<<<UNTRUSTED-", card["context"])
        self.assertLess(len(card["context"]), 13000)
        self.assertEqual(self.messages()[-1]["type"], "handoff")
        self.assertNotIn("handoff", [m.get("type") for m in session_manager.effective_messages(self.source)])

    def test_stream_handoff_is_typed_and_multiple_agents_deduplicated(self):
        async def send():
            return [event async for event in chat_service.stream_message(self.source, "Find roles", is_admin=True,
                                                                         references=self.refs * 2)]
        events = asyncio.run(send())
        self.assertEqual(len(events[0]["handoffs"]), 1)
        self.assertEqual(len([t for t in task_service.list_tasks() if t.get("agent_id") == self.agent["id"]]), 1)

    def test_multiple_mentions_keep_target_identity_in_an_agent_chat(self):
        other = agent_service.create("Archivist", role="Files notes")
        self.addCleanup(agent_service.delete, other["id"])
        self.addCleanup(task_service.delete_agent_work, other["id"])
        agent_service.make_agent_chat(self.source, other)
        refs = self.refs + [{"kind": "agent", "id": other["id"], "label": "Archivist"}]
        asyncio.run(chat_service.send_message(self.source, "Review this", is_admin=True, references=refs))
        cards = [t for t in task_service.list_tasks() if t.get("reply_to") == self.source]
        self.assertEqual({c["agent_id"] for c in cards}, {self.agent["id"], other["id"]})
        self.assertEqual(len(cards), 2)
        self.assertEqual(len([m for m in self.messages() if m.get("type") == "handoff"]), 2)
        saved = chat_references.metadata([{**self.refs[0], "label": "Spoofed name"}])
        self.assertEqual(saved[0]["label"], "Scout")


    def test_result_returns_to_correct_chat_and_is_tainted(self):
        self.handoff()
        self.run_card()
        message = self.messages()[-1]
        self.assertEqual((message["role"], message["agent_id"], message["agent_name"]),
                         ("assistant", self.agent["id"], "Scout"))
        self.assertEqual(message["content"], "Two remote roles found.")
        self.assertEqual(self.messages()[1]["handoff_status"], "done")
        self.assertEqual(self.messages(self.other), [])
        self.assertIn("<<<UNTRUSTED-", self.brain.prompt)
        self.assertEqual(self.brain.pending_reference_taint, "context from another conversation")
        self.assertTrue(session_manager.get_session(self.source)["untrusted_context"])
        agent_handoff.finished(self.card(), message["content"])
        self.assertEqual(len(self.messages()), 3)
        self.assertEqual(self.card()["status"], "review")

    def test_question_is_mirrored_and_existing_answer_path_requeues(self):
        self.handoff()
        self.brain.ask = True
        self.run_card()
        question = next(m for m in self.messages() if m.get("inbox_item_id"))
        item = agent_service.get_item(question["inbox_item_id"])
        self.assertEqual(question["question_status"], "open")
        self.assertEqual(item["card_id"], self.card()["id"])
        self.assertEqual(self.messages()[1]["handoff_status"], "needs_you")
        self.assertEqual(agent_service.answer_item(item["id"], "reply", "Europe"), "the card will run again")
        self.assertEqual(agent_service.get_item(item["id"])["answer"], "Europe")
        self.assertEqual(self.card()["status"], "ready")
        self.assertEqual(self.messages()[1]["handoff_status"], "queued")
        self.assertEqual(next(m for m in self.messages() if m.get("inbox_item_id"))["question_status"], "answered")

    def test_non_admin_cannot_search_mention_or_use_tool(self):
        with patch.object(chat_references.chat_files, "list_library", return_value=[]), \
             patch.object(chat_references.memory_tools, "search_vault", return_value=[]), \
             patch.object(chat_references.memory_tools, "search_sessions", return_value=[]):
            self.assertFalse(any(r["kind"] == "agent" for r in chat_references.search("Scout")))
            found = chat_references.search("postings", is_admin=True)
            self.assertEqual(found[0]["id"], self.agent["id"])
            self.assertIn("avatar", found[0])
        with self.assertRaises(ValueError):
            chat_references.resolve(self.source, self.refs)
        with self.assertRaises(ValueError):
            asyncio.run(chat_service.send_message(self.source, "Work", references=self.refs))
        self.assertEqual(self.messages(), [])
        reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Work"},
                           tool_registry.ToolContext(session_id=self.source), tool_registry.CLAUDE))
        self.assertEqual(reply, "Unknown tool: hand_to_agent")
        self.assertNotIn("hand_to_agent", [s.name for s in tool_registry.specs(tool_registry.CLAUDE)])

    def test_daily_cap_waits_ready_and_status_changes_on_claim(self):
        with patch.object(agent_service, "can_run", return_value=(False, "Scout reached its 12 runs for today")):
            self.assertIn("Scout is at today's limit", self.handoff())
            self.assertIsNone(task_service.claim_next_card(eligible=task_scheduler.agent_may_run))
            self.assertEqual(self.card()["status"], "ready")
        self.run_card()
        self.assertEqual(self.messages()[1]["handoff_status"], "done")

    def test_tool_after_untrusted_content_asks_first(self):
        from core import permissions
        from core.turn_taint import TurnTaint
        taint = TurnTaint()
        taint.mark("browse result")
        ctx = tool_registry.ToolContext(session_id=self.source, is_admin=True, turn_taint=taint)
        with patch.object(permissions, "decide", return_value=permissions.Decision("deny", "Rejected")) as decide:
            reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Find roles"}, ctx, tool_registry.CLAUDE))
        self.assertTrue(reply.startswith("Not run:"), reply)
        self.assertTrue(decide.call_args.kwargs["force_prompt"])
        self.assertIn("browse result", decide.call_args.kwargs["description"])
        self.assertEqual([m for m in self.messages() if m.get("type") == "handoff"], [], "nothing handed over")
        with patch.object(permissions, "decide", return_value=permissions.Decision("allow")):
            reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Find roles"}, ctx, tool_registry.CLAUDE))
        self.assertIn("Handed to Scout", reply)

    def test_tainted_handoff_is_not_answered_by_auto(self):
        """Regression, 2026-10-13. hand_to_agent has always asked the broker
        for a forced prompt once a turn has read untrusted content, so that
        injected text cannot put an agent to work unseen. But core/
        permissions.py honoured force_prompt for six named tools only, and
        hand_to_agent was not one of them, so Auto answered first and the gate
        never fired - on an admin's Auto chat and on an agent's own surface,
        which are exactly the two surfaces it was written for.

        This drives the REAL broker. The test above patches
        permissions.decide, which is why a defect inside decide() survived
        it."""
        from core.turn_taint import TurnTaint
        taint = TurnTaint()
        taint.mark("browse result")
        session_manager.set_permission_mode(self.source, "auto")
        self.assertEqual((session_manager.get_session(self.source) or {}).get("permission_mode"), "auto")

        # Auto chat: nobody is watching this surface in a test, so a forced
        # prompt can only deny. Before the fix, Auto allowed it outright.
        ctx = tool_registry.ToolContext(session_id=self.source, is_admin=True, turn_taint=taint)
        reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Find roles"},
                                               ctx, tool_registry.CLAUDE))
        self.assertTrue(reply.startswith("Not run:"), reply)
        self.assertEqual([m for m in self.messages() if m.get("type") == "handoff"], [], "nothing handed over")

        # An agent's own chat is an admin chat that agent_service starts in
        # Auto, so it is reachable and must not self-approve either. (A
        # background agent run on an "agent:" surface is not reachable at
        # all: hand_to_agent is admin_only, so it is never offered there.)
        agent_chat = session_manager.create_session()["id"]
        agent_service.make_agent_chat(agent_chat, self.agent)
        self.assertEqual((session_manager.get_session(agent_chat) or {}).get("permission_mode"), "auto")
        agent_ctx = tool_registry.ToolContext(session_id=agent_chat, agent_id=self.agent["id"],
                                              is_admin=True, turn_taint=taint)
        reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Find roles"},
                                               agent_ctx, tool_registry.CLAUDE))
        self.assertTrue(reply.startswith("Not run:"), reply)
        self.assertEqual([m for m in self.messages() if m.get("type") == "handoff"], [], "nothing handed over")

        # A clean turn still hands over with no prompt: the gate is for
        # tainted turns, not a tax on every handoff.
        clean = tool_registry.ToolContext(session_id=self.source, is_admin=True)
        reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": "Scout", "work": "Find roles"},
                                               clean, tool_registry.CLAUDE))
        self.assertIn("Handed to Scout", reply)

    def test_tool_by_name_and_id_uses_same_card_and_is_audited(self):
        for identifier in ("scout", self.agent["id"]):
            with patch.object(tool_registry, "_audit") as audit:
                reply = asyncio.run(tool_registry.call("hand_to_agent", {"agent": identifier, "work": "Find roles"},
                        tool_registry.ToolContext(session_id=self.source, is_admin=True), tool_registry.CLAUDE))
            self.assertIn("Handed to Scout", reply)
            audit.assert_called_once()
            self.assertEqual(audit.call_args.args[0].effect, tool_registry.WRITE)
            self.assertEqual(self.card()["reply_to"], self.source)


    def test_failure_retries_and_stopped_card_update_status(self):
        self.handoff()
        self.brain.fail = True
        self.run_card()
        self.assertEqual(self.messages()[1]["handoff_status"], "queued")
        self.run_card()
        self.run_card()
        self.assertEqual(self.messages()[1]["handoff_status"], "failed")
        self.assertFalse(any(m.get("handoff_message_id") for m in self.messages()))

    def test_stopped_card_status_and_answer_during_run(self):
        self.handoff()
        card = task_service.claim_next_card(card_id=self.card()["id"])
        self.assertEqual(self.messages()[1]["handoff_status"], "working")
        task_service.record_stopped(card["id"])
        self.assertEqual(self.messages()[1]["handoff_status"], "failed")
        task_service.set_card_status(card["id"], "ready")
        task_service.claim_next_card(card_id=card["id"])
        async def answer_early(brain, prompt, card, surface):
            item = agent_service.add_item(self.agent["id"], "question", "Where?")
            self.assertEqual(agent_service.answer_item(item["id"], "reply", "Europe"), "noted")
            return "Waiting for the next run"
        with patch.object(task_scheduler, "complete", side_effect=answer_early):
            asyncio.run(task_scheduler.start_run(card))
        self.assertEqual(card["status"], "ready")
        self.assertEqual(self.messages()[1]["handoff_status"], "queued")


class CoordinationTests(unittest.TestCase):
    """2026-10-14: keep the original handoff tests above unchanged."""

    def setUp(self):
        HandoffTests.setUp(self)
        self.peer = agent_service.create("Peer", peers=[self.agent["id"]])
        self.third = agent_service.create("Third")
        self.addCleanup(agent_service.delete, self.peer["id"])
        self.addCleanup(task_service.delete_agent_work, self.peer["id"])
        self.addCleanup(agent_service.delete, self.third["id"])
        self.addCleanup(task_service.delete_agent_work, self.third["id"])
        agent_service.update(self.agent["id"], peers=[self.peer["id"], self.third["id"]])
        agent_service.make_agent_chat(self.source, self.agent)

    messages = HandoffTests.messages

    def assignment(self, work="Check this", target="Peer", run="turn-1"):
        ctx = tool_registry.ToolContext(session_id=self.source, agent_id=self.agent["id"],
                                        assignment_run_id=run)
        return asyncio.run(tool_registry.call("agent_assign", {"agent": target, "work": work},
                                              ctx, tool_registry.CLAUDE))

    def assigned_cards(self):
        return [c for c in task_service.list_tasks() if (c.get("requester") or {}).get("kind") == "bot"
                and (c.get("requester") or {}).get("session_id") == self.source]

    def test_peer_assignment_result_and_one_admitted_resume(self):
        self.assertIn("Assigned to Peer", self.assignment())
        card = self.assigned_cards()[0]
        self.assertEqual(card["requester"]["agent_id"], self.agent["id"])
        self.assertIn("<<<UNTRUSTED-", card["prompt"])
        agent_handoff.close_batch(self.agent["id"], session_id=self.source)
        self.brain.agent_id = self.peer["id"]
        with patch.object(agent_handoff, "_resume", new_callable=AsyncMock) as resume:
            asyncio.run(task_scheduler.start_run(card))
            asyncio.run(agent_handoff.wake_batches())
            asyncio.run(agent_handoff.wake_batches())
            resume.assert_awaited_once()
        self.assertIn("<<<UNTRUSTED-", self.messages()[-1]["content"])
        self.assertTrue(card["batch_resumed_at"])
        self.assertEqual(self.messages()[0]["handoff_status"], "done")

    def test_peer_update_uses_the_existing_profile_route(self):
        from routes.agent_routes import AgentBody, update_agent
        saved = asyncio.run(update_agent(self.agent["id"], AgentBody(peers=[self.peer["id"]]), "david"))
        self.assertEqual(saved["peers"], [self.peer["id"]])
        saved = asyncio.run(update_agent(self.agent["id"], AgentBody(peers=[]), "david"))
        self.assertEqual(saved["peers"], [])
        self.assertIn("not on your Peers", self.assignment())

    def test_non_peers_empty_default_cycles_depth_and_cap(self):
        self.assertIn("not on your Peers", agent_handoff.assign(self.third["id"], self.agent["id"], "No", self.source,
                                                                  "empty"))
        agent_service.update(self.peer["id"], peers=[])
        self.assertIn("not on your Peers", agent_handoff.assign(self.peer["id"], self.agent["id"], "No", self.source,
                                                                  "empty2"))
        agent_service.update(self.peer["id"], peers=[self.agent["id"], self.third["id"]])
        first = self.assignment()
        self.assertIn("Assigned", first)
        origin = self.assigned_cards()[0]
        with agent_service.run(self.peer["id"], card_id=origin["id"]):
            self.assertIn("cycle", agent_handoff.assign(self.peer["id"], self.agent["id"], "Loop"))
            self.assertIn("Assigned", agent_handoff.assign(self.peer["id"], self.third["id"], "Continue"))
        second = next(c for c in task_service.list_tasks() if c.get("assignment_chain") ==
                      [self.agent["id"], self.peer["id"], self.third["id"]])
        agent_service.update(self.third["id"], peers=[self.agent["id"], self.peer["id"]])
        with agent_service.run(self.third["id"], card_id=second["id"]):
            self.assertIn("cycle", agent_handoff.assign(self.third["id"], self.agent["id"], "Long loop"))
        deep = dict(second, assignment_chain=[self.agent["id"], self.peer["id"], self.third["id"], "fourth"])
        task_service._tasks[second["id"]] = deep
        with agent_service.run(self.third["id"], card_id=second["id"]):
            self.assertIn("at most 3 hops", agent_handoff.assign(self.third["id"], self.peer["id"], "Too deep"))
        for i in range(agent_handoff.MAX_ASSIGNMENTS_PER_RUN - 1):
            self.assertIn("Assigned", self.assignment(f"Work {i}"))
        self.assertIn("at most 5", self.assignment("One too many"))

    def test_off_peer_queues_and_three_results_batch_with_ceiling(self):
        agent_service.update(self.peer["id"], enabled=False)
        self.assertIn("turned off", self.assignment())
        self.assertEqual(self.assigned_cards()[0]["status"], "ready")
        self.assertIsNone(task_service.next_card(eligible=task_scheduler.agent_may_run))
        agent_service.update(self.peer["id"], enabled=True)
        with patch.object(agent_service, "can_run", return_value=(False, "Peer reached its 12 runs for today")):
            self.assertIn("today's limit", self.assignment("Cap note"))
        self.assignment("Third result")
        cards = self.assigned_cards()
        agent_handoff.close_batch(self.agent["id"], session_id=self.source)
        for card in cards[:2]:
            task_service.claim_next_card(card_id=card["id"])
            task_service.finish_card(card["id"], card["name"] + " done")
            agent_handoff.finished(card, card["name"] + " done")
        with patch.object(agent_handoff, "_resume", new_callable=AsyncMock) as resume:
            asyncio.run(agent_handoff.wake_batches(now=cards[0]["requester"]["created_at"] + 10))
            resume.assert_not_awaited()
            asyncio.run(agent_handoff.wake_batches(now=cards[0]["requester"]["created_at"] +
                                                   agent_handoff.RESUME_CEILING_SECONDS + 1))
            resume.assert_awaited_once()
            self.assertIn("still outstanding", resume.call_args.args[1])
            for card in cards:
                self.assertIn(card["id"], resume.call_args.args[1])

    def test_three_settled_assignments_resume_once_with_every_result(self):
        for n in range(3):
            self.assignment(f"Check part {n}")
        cards = self.assigned_cards()
        agent_handoff.close_batch(self.agent["id"], session_id=self.source)
        with patch.object(agent_handoff, "_resume", new_callable=AsyncMock) as resume:
            for n, card in enumerate(cards):
                task_service.claim_next_card(card_id=card["id"])
                task_service.finish_card(card["id"], f"Result {n}")
                agent_handoff.finished(card, f"Result {n}")
            asyncio.run(agent_handoff.wake_batches())
            resume.assert_awaited_once()
            for n in range(3):
                self.assertIn(f"Result {n}", resume.call_args.args[1])

    def test_question_routes_to_bot_then_person_and_old_card(self):
        self.assignment()
        card = self.assigned_cards()[0]
        with agent_service.run(self.peer["id"], card_id=card["id"]):
            item = agent_service.add_item(self.peer["id"], "question", "Which region?")
        self.assertEqual(self.messages()[-1]["inbox_item_id"], item["id"])
        self.assertNotIn(item, agent_handoff.person_inbox(), "the asking bot receives it first")
        self.assertIn("<<<UNTRUSTED-", self.messages()[-1]["content"])
        with patch.object(agent_handoff, "_resume", new_callable=AsyncMock) as resume:
            asyncio.run(agent_handoff.wake_questions())
            resume.assert_awaited_once()
        self.assertIn("Escalated", agent_handoff.answer_question(self.agent["id"], item["id"], escalate=True))
        upward = next(i for i in agent_service.inbox(self.agent["id"]) if i.get("escalates_item_id") == item["id"])
        self.assertIn(upward, agent_handoff.person_inbox())
        agent_service.answer_item(upward["id"], "reply", "Europe")
        self.assertEqual(item["status"], "answered")
        self.assertIn("<<<UNTRUSTED-", item["answer"])
        with agent_service.run(self.peer["id"], card_id=card["id"]):
            direct = agent_service.add_item(self.peer["id"], "question", "Which format?")
        agent_handoff.answer_question(self.agent["id"], direct["id"], "PDF")
        self.assertEqual(direct["status"], "answered")
        self.assertIn("<<<UNTRUSTED-", direct["answer"])
        old = agent_handoff.hand_off(self.peer["id"], "Old work", self.other, [])
        legacy = task_service.get_task(old["card_id"])
        legacy.pop("requester")
        task_service._save_tasks()
        task_service.claim_next_card(card_id=legacy["id"])
        task_service.finish_card(legacy["id"], "Legacy result")
        agent_handoff.finished(legacy, "Legacy result")
        self.assertEqual(self.messages(self.other)[-1]["content"], "Legacy result")

    def test_coordinated_resume_uses_core_memory_only(self):
        self.assignment()
        req = self.assigned_cards()[0]["requester"]
        session_manager.set_model_endpoint(self.source, "configured")
        with patch.object(chat_service, "send_message", new_callable=AsyncMock) as send:
            async def inspect(*args, **kwargs):
                prompt = session_manager.get_session(self.source)["agent_prompt"]
                self.assertNotIn("Memory topics you may open", prompt)
                self.assertNotIn("recent statements in other threads", prompt)
            send.side_effect = inspect
            asyncio.run(agent_handoff._resume(req, "Results"))
        send.assert_awaited_once()

    def test_default_model_continues_without_a_chat_endpoint(self):
        self.assignment()
        req = self.assigned_cards()[0]["requester"]
        self.assertIsNone(session_manager.get_session(self.source)["model_endpoint_id"])
        asyncio.run(agent_handoff._resume(req, "Peer result"))
        self.assertEqual(self.messages()[-1]["content"], "Two remote roles found.")
        self.assertIn("Peer result", self.brain.prompt)
        self.assertNotIn("recent statements in other threads", self.brain.prompt)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        from core import session_manager_store
        session_manager_store.close()
        shutil.rmtree(_DATA)
