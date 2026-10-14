"""Agents, phase 1 (services/agent_service.py; spec: the vault note "Agents -
Phase 1 Persistent Agents (Build Spec)").

Runs against a throwaway data folder; models are stand-ins, so nothing is
spent. Run: python scripts/test_agents.py
"""
import asyncio
import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="jarvis-agents-test-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import permissions, runs, task_scheduler, tool_registry  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from routes import agent_routes  # noqa: E402
from services.agent_service import agent_service, is_silent  # noqa: E402
from services.task_service import task_service  # noqa: E402

app = FastAPI()
app.include_router(agent_routes.router)
app.dependency_overrides[require_user] = lambda: "david"
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app)


class FakeBrain:
    """Records what it was asked; replies from a script. A step may be a
    coroutine function, run inside the turn (to ask for a permission)."""
    script: list = []
    prompts: list = []

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        FakeBrain.prompts.append(prompt)
        step = FakeBrain.script.pop(0) if FakeBrain.script else "done"
        if callable(step):
            step = await step()
        if isinstance(step, Exception):
            raise step
        yield runs.text(step)
        yield runs.result(False)


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        FakeBrain.script, FakeBrain.prompts = [], []
        for target, kwargs in ((task_scheduler, {"attribute": "_task_brain", "side_effect": lambda task: FakeBrain()}),
                               (task_scheduler.events, {"attribute": "emit"}),
                               (agent_service, {"attribute": "_announce"})):
            p = patch.object(target, **kwargs)
            p.start()
            self.addCleanup(p.stop)
        self.agent = agent_service.create("Scout", role="Watches job postings", instructions="Be brief.")
        self.addCleanup(self._remove, self.agent["id"])

    @staticmethod
    def _remove(agent_id):
        if agent_service.get(agent_id):
            task_service.delete_agent_work(agent_id)
            for task in [t for t in task_service.list_tasks() if t.get("agent_id") == agent_id]:
                task_service.delete_task(task["id"])
            agent_service.delete(agent_id)

    def card(self, name="Find postings", status="ready", agent=None):
        return task_service.create_task(name, f"do {name}", "card", status=status,
                                        agent_id=(agent or self.agent)["id"])

    def goal(self, report_when=None):
        return task_service.create_task("Daily sweep", "check the boards", "interval", interval_seconds=3600,
                                        agent_id=self.agent["id"], report_when=report_when)

    def dispatch(self):
        return asyncio.run(task_scheduler.dispatch_cards())

    def run_goal(self, goal):
        asyncio.run(task_scheduler._run_task(task_service.get_task(goal["id"])))


class AnnouncementBatchTests(unittest.TestCase):
    def setUp(self):
        from core import outbox, session_manager_store as store
        self.outbox, self.store = outbox, store
        self.clock = [1000.0]
        self.sent = []
        self.events = []
        self.agent = agent_service.create("Batch Scout", deliver_to_channel="discord")
        self.addCleanup(agent_service.delete, self.agent["id"])
        self.addCleanup(self._clear_deliveries)
        p = patch.object(outbox.time, "time", side_effect=lambda: self.clock[0])
        p.start(); self.addCleanup(p.stop)
        p = patch("core.events.emit", side_effect=lambda *a, **k: self.events.append((a, k)))
        p.start(); self.addCleanup(p.stop)

        async def send(channel, text):
            self.sent.append((channel, text))
            return True

        p = patch("core.channels.registry.send_to_channel", side_effect=send)
        p.start(); self.addCleanup(p.stop)

    def _clear_deliveries(self):
        with self.store.transaction() as conn:
            conn.execute("DELETE FROM deliveries")

    def announce(self, agent, title, footer=""):
        agent_service._announce(agent["id"], "agent.review", "has a result ready for review", title,
                                f"Result for {title}", footer)

    def send_due(self):
        asyncio.run(self.outbox.send_due(now=self.clock[0]))

    def test_six_results_make_one_channel_message_and_six_live_events(self):
        for n in range(6):
            self.announce(self.agent, f"Card {n}")
            self.clock[0] += 1
        self.send_due()
        self.assertEqual(self.sent, [])
        self.clock[0] += 10
        self.send_due()
        self.assertEqual(len(self.sent), 1)
        self.assertEqual(self.sent[0][0], "discord")
        for n in range(6):
            self.assertIn(f"Card {n}", self.sent[0][1])
        self.assertEqual(len(self.events), 6)

    def test_one_result_keeps_the_old_message_exactly(self):
        self.announce(self.agent, "One card", "Reply 'approve'. [B-abcdef]")
        self.clock[0] += 10
        self.send_due()
        self.assertEqual(self.sent, [("discord", "**Batch Scout** has a result ready for review: One card\n"
                                                "Result for One card\n_Reply 'approve'. [B-abcdef]_")])

    def test_agents_have_separate_batches(self):
        other = agent_service.create("Second Scout", deliver_to_channel="discord")
        self.addCleanup(agent_service.delete, other["id"])
        self.announce(self.agent, "First")
        self.announce(other, "Second")
        self.clock[0] += 10
        self.send_due()
        self.assertEqual(len(self.sent), 2)
        self.assertFalse(any("First" in text and "Second" in text for _, text in self.sent))

    def test_one_agent_uses_separate_batches_for_two_channels(self):
        self.announce(self.agent, "Discord card")
        agent_service.update(self.agent["id"], deliver_to_channel="conn:other")
        self.announce(self.agent, "Other card")
        self.clock[0] += 10
        self.send_due()
        self.assertEqual({channel for channel, _ in self.sent}, {"discord", "conn:other"})

    def test_review_codes_survive_a_batch_and_select_the_right_item(self):
        from core.channels.agent_routing import answer_reply
        from services.agent_service import code_for
        cards = [task_service.create_task(f"Review {n}", "work", "card", status="ready",
                                          agent_id=self.agent["id"]) for n in range(2)]
        for card in cards:
            self.addCleanup(task_service.delete_task, card["id"])
            task_service.claim_next_card(card_id=card["id"])
            task_service.finish_card(card["id"], "result")
            agent_service.notify_review(self.agent["id"], card)
        self.clock[0] += 10
        self.send_due()
        text = self.sent[0][1]
        codes = [code_for(self.agent, card["id"]) for card in cards]
        self.assertTrue(all(code in text for code in codes))
        self.assertIn("Include the item's reply code", answer_reply(text, "approve"))
        self.assertIn("approved", answer_reply(text, f"approve {codes[1]}"))
        self.assertEqual(task_service.get_task(cards[1]["id"])["status"], "done")
        self.assertEqual(task_service.get_task(cards[0]["id"])["status"], "review")

    def test_held_batch_survives_a_process_exit(self):
        self.announce(self.agent, "Still held")
        self.assertEqual(self.sent, [])
        self.assertEqual(self.store.connection().execute(
            "SELECT COUNT(*) FROM deliveries WHERE status = 'pending'").fetchone()[0], 1)
        # A new process has no memory of _announce; the outbox row is enough.
        self.clock[0] += 10
        self.outbox.recover()
        self.send_due()
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Still held", self.sent[0][1])


    def test_a_steady_stream_does_not_hold_a_batch_open_for_ever(self):
        """Every new item pushed the quiet window out, so an agent working
        steadily through a board fell silent exactly when it had most to
        report: 40 results over five minutes sent nothing at all."""
        for n in range(40):
            self.announce(self.agent, f"Card {n}")
            self.clock[0] += 8  # inside the quiet window, so each one extends it
            self.send_due()
        self.assertTrue(self.sent, "a steady stream was never delivered")
        held = max(text.count("has a result ready for review") for _, text in self.sent)
        self.assertLessEqual(held, 9, "a batch grew past the maximum hold")

class RunTests(AgentTestCase):
    def test_the_daily_run_cap_holds_under_concurrent_card_and_goal_starts(self):
        agent_service.update(self.agent["id"], daily_run_cap=1)
        card, goal = self.card(), self.goal()
        goal["next_run_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()

        async def overlap():
            started, finish = asyncio.Event(), asyncio.Event()

            async def connect(brain):
                started.set()
                await finish.wait()

            with patch.object(FakeBrain, "connect", connect):
                workers = [asyncio.create_task(task_scheduler.dispatch_cards()),
                           asyncio.create_task(task_scheduler._run_due())]
                try:
                    await asyncio.wait_for(started.wait(), timeout=5)
                    # Hold before checkpoints/model output: both lanes reach
                    # admission with no completed record to count.
                    for _ in range(20):
                        await asyncio.sleep(0)
                    self.assertEqual(task_scheduler._task_brain.call_count, 1,
                                     "a cap of one must admit only one lane")
                    self.assertEqual(agent_service.runs_today(self.agent["id"]), 1)
                finally:
                    finish.set()
                    await asyncio.gather(*workers)

        asyncio.run(overlap())
        history = task_service.list_runs(card["id"]) + task_service.list_runs(goal["id"])
        self.assertEqual(sum(r["outcome"] == "succeeded" for r in history), 1)
        # A refused due goal now leaves a receipt; it still spends no slot
        # (Agents 2.0 phase 2-i, 2026-10-13).
        if task_service.get_task(card["id"])["status"] == "review":
            self.assertEqual(len(history), 2)
            self.assertIn("runs for today", task_service.list_runs(goal["id"])[0]["missed_reason"])
        else:
            self.assertEqual(len(history), 1)
        self.assertEqual(agent_service.runs_today(self.agent["id"]), 1)

    def test_webhook_goal_respects_off_and_cap_and_reports_the_reason(self):
        import httpx
        from routes import trigger_routes
        from services.trigger_service import trigger_service

        goal = self.goal()
        trigger, secret = trigger_service.create("Goal hook", preset="github", action="task",
                                                  task_id=goal["id"], auto_run=True)
        self.addCleanup(trigger_service.delete, trigger["id"])
        hook_app = FastAPI()
        hook_app.include_router(trigger_routes.router)
        body = json.dumps({"ref": "refs/heads/main"}).encode()
        signature = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        original_start = task_scheduler.start_in_background

        async def post(delivery):
            background = []

            def start(task, source):
                work = original_start(task, source)
                background.append(work)
                return work

            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=hook_app), base_url="http://test") as client:
                with patch.object(task_scheduler, "start_in_background", side_effect=start):
                    response = await client.post(f"/api/triggers/{trigger['id']}", content=body, headers={
                        "X-Hub-Signature-256": signature, "X-GitHub-Event": "push", "X-GitHub-Delivery": delivery})
                self.assertEqual(response.status_code, 202, response.text)
                self.assertEqual(len(background), 1, "the signed webhook reached the real background path")
                return await asyncio.gather(*background)

        for enabled, reason in ((False, "Scout is turned off"), (True, "Scout reached its 1 runs for today")):
            with self.subTest(reason=reason):
                agent_service.update(self.agent["id"], enabled=enabled, daily_run_cap=1)
                if enabled:
                    task_service.record_run(goal["id"], "already ran")
                emitted = task_scheduler.events.emit
                emitted.reset_mock()
                self.assertEqual(asyncio.run(post(str(enabled))), [False])
                self.assertEqual(FakeBrain.prompts, [])
                self.assertEqual(emitted.call_args.args[:2], ("task.refused", f"Not run: {reason}."))
                self.assertNotIn("run_started_at", goal, "refusal never claims the goal")
                self.assertEqual(agent_service._reservations, {})

    def _assert_run_releases_reservation(self, outcome):
        agent_service.update(self.agent["id"], daily_run_cap=2)
        goal = self.goal()

        async def run():
            started = asyncio.Event()

            async def step():
                self.assertEqual(agent_service.runs_today(self.agent["id"]), 1)
                started.set()
                if outcome == "cancelled":
                    await asyncio.Event().wait()
                if outcome == "failed":
                    raise ValueError("model crashed")
                return "done"

            FakeBrain.script = [step]
            work = asyncio.create_task(task_scheduler.start_run(goal))
            await asyncio.wait_for(started.wait(), timeout=10)
            if outcome == "cancelled":
                self.assertTrue(task_scheduler.stop_run(goal["id"]))
            await work
            self.assertEqual(agent_service._reservations, {})
            self.assertEqual(agent_service.runs_today(self.agent["id"]), 1, "history replaces the hold")
            self.assertTrue(agent_service.can_run(self.agent["id"])[0], "one slot remains")
            self.assertEqual(task_service.list_runs(goal["id"])[0]["outcome"],
                             "stopped" if outcome == "cancelled" else outcome)
            await task_scheduler.start_run(goal)
            self.assertEqual(agent_service.runs_today(self.agent["id"]), 2)
            self.assertEqual(agent_service._reservations, {})
            self.assertFalse(agent_service.can_run(self.agent["id"])[0], "the cap keeps its meaning")

        asyncio.run(run())
        self.assertEqual(len(FakeBrain.prompts), 2)

    def test_success_releases_the_reservation(self):
        self._assert_run_releases_reservation("succeeded")

    def test_failure_releases_the_reservation(self):
        self._assert_run_releases_reservation("failed")

    def test_cancellation_releases_the_reservation(self):
        self._assert_run_releases_reservation("cancelled")

    def test_context_releases_without_history_on_success_failure_and_cancellation(self):
        agent_service.update(self.agent["id"], daily_run_cap=1)
        from services.agent_service import AdmissionDenied

        async def run():
            for outcome in (None, ValueError("crashed"), asyncio.CancelledError()):
                with self.subTest(outcome=type(outcome).__name__):
                    try:
                        with agent_service.run(self.agent["id"]):
                            self.assertEqual(agent_service.runs_today(self.agent["id"]), 1)
                            with self.assertRaisesRegex(AdmissionDenied, "Scout reached its 1 runs"):
                                with agent_service.run(self.agent["id"]):
                                    self.fail("a second run was admitted")
                            if outcome:
                                raise outcome
                    except (ValueError, asyncio.CancelledError):
                        pass
                    self.assertEqual(agent_service._reservations, {})
                    self.assertTrue(agent_service.can_run(self.agent["id"])[0])

        asyncio.run(run())

    def test_restart_drops_holds_and_recovers_lost_work_into_history(self):
        from services.agent_service import AgentService
        from services.task_service import TaskService

        goal = self.goal()
        agent_service.update(self.agent["id"], daily_run_cap=2)
        with agent_service.run(self.agent["id"], task_id=goal["id"]):
            task_service.mark_started(goal["id"])
            restarted_agents, restarted_tasks = AgentService(), TaskService()
            self.assertEqual(restarted_agents._reservations, {}, "holds cannot survive a process restart")
            with patch("services.task_service.task_service", restarted_tasks):
                self.assertEqual(restarted_agents.runs_today(self.agent["id"]), 1,
                                 "the durable start covers the gap before recovery")
            self.assertEqual([t["id"] for t in restarted_tasks.recover_interrupted_runs()], [goal["id"]])
            with patch("services.task_service.task_service", restarted_tasks):
                self.assertEqual(restarted_agents.runs_today(self.agent["id"]), 1)
                self.assertTrue(restarted_agents.can_run(self.agent["id"])[0], "only the lost run counts")

    def test_restart_counts_a_lost_card_once_before_and_after_lease_recovery(self):
        from services.agent_service import AgentService
        from services.task_service import TaskService

        card = self.card()
        agent_service.update(self.agent["id"], daily_run_cap=2)
        with agent_service.run(self.agent["id"], card_id=card["id"]):
            task_service.claim_next_card(card_id=card["id"])
            restarted_agents, restarted_tasks = AgentService(), TaskService()
            with patch("services.task_service.task_service", restarted_tasks):
                self.assertEqual(restarted_agents.runs_today(self.agent["id"]), 1)
                self.assertEqual([t["id"] for t in restarted_tasks.reclaim_stale_cards(now=card["claimed_until"] + 1)],
                                 [card["id"]])
                self.assertEqual(restarted_agents.runs_today(self.agent["id"]), 1, "the lost record replaces its claim")
                self.assertTrue(restarted_agents.can_run(self.agent["id"])[0])

    def test_job_still_queues_with_an_informative_off_or_capped_message(self):
        from core.channels.agent_routing import _queue_job

        for enabled, reason in ((False, "turned off"), (True, "reached its 1 runs for today")):
            with self.subTest(enabled=enabled):
                agent_service.update(self.agent["id"], enabled=enabled, daily_run_cap=1)
                if enabled:
                    task_service.record_run(self.goal()["id"], "already ran")
                message = _queue_job(self.agent, "Find another board")
                self.assertIn("Queued for Scout", message)
                self.assertIn("It will start when it can", message)
                self.assertIn(reason, message)
                self.assertEqual(agent_service._reservations, {})
        self.assertEqual(sum(t.get("status") == "ready" for t in task_service.list_tasks()
                             if t.get("agent_id") == self.agent["id"]), 2)

    def test_manual_card_and_goal_surface_refusal_without_claiming_work(self):
        from fastapi import HTTPException
        from routes.task_routes import run_task_now

        card, goal = self.card(), self.goal()
        for enabled, reason in ((False, "Scout is turned off"), (True, "Scout reached its 1 runs for today")):
            agent_service.update(self.agent["id"], enabled=enabled, daily_run_cap=1)
            if enabled:
                task_service.record_run(goal["id"], "already ran")
            for work in (card, goal):
                with self.subTest(enabled=enabled, kind=work["schedule_kind"]):
                    with self.assertRaises(HTTPException) as caught:
                        asyncio.run(run_task_now(work["id"], user="david", _=None))
                    self.assertEqual(caught.exception.status_code, 409)
                    self.assertEqual(caught.exception.detail, f"Not run: {reason}.")
                    self.assertNotIn("run_started_at", work)
        self.assertEqual((card["status"], card["attempts"]), ("ready", 0))
        self.assertEqual(FakeBrain.prompts, [])

    def test_cancelling_the_starter_does_not_orphan_work_or_a_reservation(self):
        goal = self.goal()

        async def cancel():
            started = asyncio.Event()

            async def step():
                started.set()
                await asyncio.Event().wait()

            FakeBrain.script = [step]
            starter = asyncio.create_task(task_scheduler.start_run(goal))
            await asyncio.wait_for(started.wait(), timeout=10)
            starter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await starter
            self.assertEqual(agent_service._reservations, {})
            self.assertFalse(task_scheduler.run_in_progress(goal["id"]))
            self.assertEqual(task_service.list_runs(goal["id"])[0]["outcome"], "stopped")

        asyncio.run(cancel())

    def test_recorded_run_is_not_counted_twice_during_disconnect(self):
        agent_service.update(self.agent["id"], daily_run_cap=2)
        goal = self.goal()

        async def disconnect(brain):
            self.assertEqual(len(agent_service._reservations), 1, "hold lasts through disconnect")
            self.assertEqual(agent_service.runs_today(self.agent["id"]), 1, "record replaces the live count")
            self.assertTrue(agent_service.can_run(self.agent["id"])[0])

        with patch.object(FakeBrain, "disconnect", disconnect):
            asyncio.run(task_scheduler.start_run(goal))
        self.assertEqual(agent_service._reservations, {})

    def test_overlapping_card_and_goal_keep_their_own_questions(self):
        card, goal = self.card(), self.goal()

        async def overlap():
            card_started, goal_started, card_ended = asyncio.Event(), asyncio.Event(), asyncio.Event()

            async def run_card():
                with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
                    card_started.set()
                    await goal_started.wait()
                    question = agent_service.add_item(self.agent["id"], "question", "Card question")
                card_ended.set()
                return question, raised

            async def run_goal():
                await card_started.wait()
                with agent_service.run(self.agent["id"], task_id=goal["id"]) as raised:
                    goal_started.set()
                    question = agent_service.add_item(self.agent["id"], "question", "Goal question")
                    await card_ended.wait()
                return question, raised

            return await asyncio.wait_for(asyncio.gather(run_card(), run_goal()), timeout=5)

        (card_question, card_raised), (goal_question, goal_raised) = asyncio.run(overlap())
        for label, question, work, raised in (
            ("card", card_question, (card["id"], None), card_raised),
            ("goal", goal_question, (None, goal["id"]), goal_raised),
        ):
            with self.subTest(run=label, check="attribution"):
                self.assertEqual((question["card_id"], question["task_id"]), work)
            with self.subTest(run=label, check="own questions only"):
                self.assertEqual([item["id"] for item in raised], [question["id"]])

    def test_single_run_keeps_its_card_and_returns_only_questions(self):
        card = self.card()
        with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
            question = agent_service.add_item(self.agent["id"], "question", "Which board?")
            report = agent_service.add_item(self.agent["id"], "report", "Found a board")
            team_question = agent_service.add_item(self.agent["id"], "question", "Team question", team_id="team")
        self.assertEqual(raised, [question])
        for item in (question, report):
            self.assertEqual((item["card_id"], item["task_id"]), (card["id"], None))
        self.assertEqual((team_question["card_id"], team_question["task_id"]), (None, None))
        self.assertIsNone(agent_service._current.get())

    def test_empty_and_failed_runs_clean_up(self):
        card = self.card()
        with agent_service.run(self.agent["id"], card_id=card["id"]) as empty:
            pass
        self.assertEqual(empty, [])
        self.assertIsNone(agent_service._current.get())
        with self.assertRaisesRegex(ValueError, "run failed"):
            with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
                question = agent_service.add_item(self.agent["id"], "question", "Before failure")
                raise ValueError("run failed")
        self.assertEqual(raised, [question])
        self.assertIsNone(agent_service._current.get())
        outside = agent_service.add_item(self.agent["id"], "question", "After failure")
        self.assertEqual((outside["card_id"], outside["task_id"]), (None, None))

    def test_cancellation_cleans_up_the_run_context(self):
        card = self.card()

        async def cancel():
            started = asyncio.Event()
            questions = []

            async def work():
                try:
                    with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
                        questions.append(agent_service.add_item(self.agent["id"], "question", "Before stop"))
                        started.set()
                        await asyncio.Event().wait()
                finally:
                    self.assertIsNone(agent_service._current.get())
                    self.assertEqual(raised, questions)

            task = asyncio.create_task(work())
            await started.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(cancel())

    def test_nested_run_restores_the_outer_work_after_failure(self):
        card, goal = self.card(), self.goal()
        with agent_service.run(self.agent["id"], card_id=card["id"]) as card_raised:
            with self.assertRaisesRegex(ValueError, "inner failed"):
                with agent_service.run(self.agent["id"], task_id=goal["id"]) as goal_raised:
                    inner = agent_service.add_item(self.agent["id"], "question", "Inner")
                    raise ValueError("inner failed")
            outer = agent_service.add_item(self.agent["id"], "question", "Outer")
        self.assertEqual((inner["card_id"], inner["task_id"]), (None, goal["id"]))
        self.assertEqual((outer["card_id"], outer["task_id"]), (card["id"], None))
        self.assertEqual((card_raised, goal_raised), ([outer], [inner]))
        self.assertIsNone(agent_service._current.get())

    def test_unscoped_chat_and_other_agents_do_not_borrow_a_run(self):
        card = self.card()
        other = agent_service.create("Archivist")
        self.addCleanup(self._remove, other["id"])

        async def overlap():
            started, finish = asyncio.Event(), asyncio.Event()

            async def work():
                with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
                    stranger = agent_service.add_item(other["id"], "question", "Other agent")
                    started.set()
                    await finish.wait()
                return stranger, raised

            task = asyncio.create_task(work())
            await started.wait()
            chat_question = agent_service.add_item(self.agent["id"], "question", "Direct chat")
            chat_report = agent_service.add_item(self.agent["id"], "report", "Outside tool")
            finish.set()
            stranger, raised = await task
            self.assertEqual(raised, [])
            for item in (stranger, chat_question, chat_report):
                self.assertEqual((item["card_id"], item["task_id"]), (None, None))

        asyncio.run(overlap())

    def test_inherited_child_context_expires_with_its_run(self):
        card = self.card()

        async def run():
            finish = asyncio.Event()

            async def child():
                before = agent_service.add_item(self.agent["id"], "question", "During run")
                finish.set()
                await resume.wait()
                after = agent_service.add_item(self.agent["id"], "question", "After run")
                return before, after

            resume = asyncio.Event()
            with agent_service.run(self.agent["id"], card_id=card["id"]) as raised:
                task = asyncio.create_task(child())
                await finish.wait()
            resume.set()
            before, after = await task
            self.assertEqual(raised, [before])
            self.assertEqual((before["card_id"], before["task_id"]), (card["id"], None))
            self.assertEqual((after["card_id"], after["task_id"]), (None, None))

        asyncio.run(run())

    def test_scheduler_overlap_keeps_questions_and_goal_report_on_their_work(self):
        card, goal = self.card(), self.goal()

        async def overlap():
            card_started, goal_started, finish_card = asyncio.Event(), asyncio.Event(), asyncio.Event()

            async def card_step():
                card_started.set()
                await goal_started.wait()
                await tool_registry.call("agent_ask", {"question": "Card question"},
                                         tool_registry.ToolContext(agent_id=self.agent["id"]), tool_registry.OPENAI)
                await finish_card.wait()
                return "Card result"

            async def goal_step():
                goal_started.set()
                await tool_registry.call("agent_ask", {"question": "Goal question"},
                                         tool_registry.ToolContext(agent_id=self.agent["id"]), tool_registry.OPENAI)
                return "Goal report"

            FakeBrain.script = [card_step, goal_step]
            task = asyncio.create_task(task_scheduler.dispatch_cards())
            await card_started.wait()
            try:
                await task_scheduler._run_task(goal)
            finally:
                finish_card.set()
                await task

        asyncio.run(overlap())
        items = {i["title"]: i for i in agent_service.inbox(self.agent["id"])}
        self.assertEqual((items["Card question"]["card_id"], items["Card question"]["task_id"]), (card["id"], None))
        for title in ("Goal question", goal["name"]):
            self.assertEqual((items[title]["card_id"], items[title]["task_id"]), (None, goal["id"]))
        self.assertEqual(task_service.get_task(card["id"])["status"], "review")
        self.assertEqual(len(task_service.list_runs(goal["id"])), 1)

    def test_a_run_carries_the_agents_identity_and_memory(self):
        agent_service.remember(self.agent["id"], "Preferences", "remote roles only")
        self.card()
        self.dispatch()
        prompt = FakeBrain.prompts[0]
        for part in ("You are Scout", "Watches job postings", "Be brief.", "remote roles only", "do Find postings"):
            self.assertIn(part, prompt)
        self.assertIn("<agent_notes>", prompt, "notes are fenced as data")

    def test_a_turned_off_agent_neither_runs_cards_nor_goals(self):
        card = self.card()
        goal = self.goal()
        task_service._tasks[goal["id"]]["next_run_at"] = "2000-01-01T00:00:00+00:00"
        agent_service.update(self.agent["id"], enabled=False)
        self.assertIsNone(self.dispatch())
        self.assertEqual(task_service.get_task(card["id"])["status"], "ready", "held, not moved")
        self.assertFalse(task_scheduler.agent_may_run(task_service.get_task(goal["id"])))
        task_service.skip_occurrence(goal["id"])
        self.assertGreater(task_service.get_task(goal["id"])["next_run_at"], "2000-01-02", "moved on, not due every tick")
        self.assertEqual(FakeBrain.prompts, [])

    def test_the_daily_run_cap_stops_further_runs(self):
        agent_service.update(self.agent["id"], daily_run_cap=2)
        for i in range(3):
            self.card(f"job {i}")
        self.dispatch()
        self.dispatch()
        self.assertIsNone(self.dispatch(), "the third waits for tomorrow")
        self.assertEqual(len(FakeBrain.prompts), 2)
        self.assertIn("reached its 2 runs", agent_service.can_run(self.agent["id"])[1])

    def test_a_goal_is_quiet_unless_it_found_something(self):
        goal = self.goal()
        FakeBrain.script = ["[SILENT]", "Two new postings: A and B.", "I found nothing; I would normally say [SILENT] here."]
        self.run_goal(goal)
        self.assertEqual(agent_service.inbox(self.agent["id"]), [], "silence: no inbox item")
        self.run_goal(goal)
        self.run_goal(goal)
        reports = [i["body"] for i in agent_service.inbox(self.agent["id"])]
        self.assertEqual(len(reports), 2, "a real report, and a reply only quoting the marker")
        self.assertEqual(len(task_service.list_runs(goal["id"])), 3, "every check is in the history")
        self.assertIn("reply with exactly [SILENT]", FakeBrain.prompts[0])

    def test_an_always_goal_reports_even_when_quiet(self):
        goal = self.goal(report_when="always")
        FakeBrain.script = ["[SILENT]"]
        self.run_goal(goal)
        self.assertEqual(len(agent_service.inbox(self.agent["id"])), 1)

    def test_a_correction_becomes_memory_and_reaches_the_next_run(self):
        card = self.card("Draft summary")
        self.dispatch()
        task_service.set_card_status(card["id"], "ready", note="drop closed postings")
        self.assertIn("drop closed postings", agent_service.read_memory(self.agent["id"]).split("## Corrections")[1])
        self.dispatch()
        self.assertIn("drop closed postings", FakeBrain.prompts[1])


class SilenceTests(unittest.TestCase):
    def test_the_marker_only_counts_on_its_own(self):
        for quiet in ("[SILENT]", "  silent  ", "NO_REPLY.", "[SILENT] nothing changed", "Checked all boards.\n[SILENT]"):
            self.assertTrue(is_silent(quiet), quiet)
        for loud in ("", "Silent retry succeeded", "The site said [SILENT] mode is on, here is the list"):
            self.assertFalse(is_silent(loud), loud)


class AutoModeTests(AgentTestCase):
    """Agents always run in Auto (David, 2026-10-05), on every model: nothing
    an agent does waits for a person, every decision is audited, and nothing
    outside agents changes."""

    def ask(self, tool="send_email", target="hr@example.com"):
        async def step():
            decision = await permissions.decide(surface=f"agent:{self.agent['id']}", tool=tool,
                                                arguments={"to": target}, title="Send email")
            return f"{decision.behavior}: {decision.reason}"
        return step

    def test_an_agent_run_is_never_held_for_approval(self):
        card = self.card("Email HR")
        FakeBrain.script = [self.ask()]
        self.dispatch()
        self.assertTrue(task_service.get_task(card["id"])["comments"][-1]["text"].startswith("allow"))
        self.assertEqual(agent_service.inbox(self.agent["id"]), [], "nothing waits on the person")
        entry = permissions.audit()[-1]
        self.assertEqual((entry["source"], entry["surface"], entry["tool"]),
                         ("agent_auto", f"agent:{self.agent['id']}", "send_email"), "every decision is audited")

    def test_auto_covers_a_tainted_turn_but_nothing_outside_agents(self):
        tainted = asyncio.run(permissions.decide(surface=f"agent:{self.agent['id']}", tool="WebFetch",
                                                 arguments={"url": "https://example.com"}, force_prompt=True))
        self.assertEqual(tainted.behavior, "allow")
        task_run = asyncio.run(permissions.decide(surface="none", tool="send_email", arguments={"to": "x@example.com"}))
        self.assertEqual(task_run.behavior, "deny", "ordinary background tasks still cannot act unasked")

    def test_every_model_kind_runs_its_agent_in_auto(self):
        from core.brain import Brain
        from core.codex_brain import CodexBrain
        from core.external_brain import ExternalBrain
        from services import chat_service
        surface = f"agent:{self.agent['id']}"
        self.assertEqual(Brain(agent_id=self.agent["id"]).surface, surface, "Claude Code")
        self.assertEqual(ExternalBrain("http://x", "m", None, agent_id=self.agent["id"])._context().permission_surface,
                         surface, "API and local models")
        codex_endpoint = {"id": "codex", "kind": "codex_cli", "model": ""}
        codex = chat_service._build_brain(codex_endpoint, None, agent_id=self.agent["id"])
        self.assertIsInstance(codex, CodexBrain)
        agent_args = codex._build_args("codex")
        # Auto (nothing asks) inside Codex's own sandbox since roadmap phase 7
        # (2026-10-06, David); before that, approve-all with the sandbox off.
        self.assertIn('approval_policy="never"', agent_args, "Codex agents never ask")
        self.assertEqual(agent_args[agent_args.index("-s") + 1], "workspace-write", "and run sandboxed")
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", agent_args)
        plain = chat_service._build_brain(codex_endpoint, None)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", plain._build_args("codex"),
                         "an ordinary Codex task keeps its sandbox")

    def test_agent_chats_start_in_auto_and_agents_are_admin_only(self):
        from fastapi import HTTPException
        from core.session_manager import session_manager
        with patch("core.model_endpoints.list_endpoints", return_value=[{"id": "claude", "kind": "claude_cli"}]):
            session = web.post(f"/api/agents/{self.agent['id']}/chat").json()
        self.addCleanup(session_manager.delete_session, session["id"])
        self.assertEqual(session["permission_mode"], "auto")
        locked = FastAPI()
        locked.include_router(agent_routes.router)

        def not_admin():
            raise HTTPException(status_code=403, detail="admin only")
        locked.dependency_overrides[require_admin] = not_admin
        client = TestClient(locked)
        self.assertEqual(client.post("/api/agents", json={"name": "Rogue"}).status_code, 403)
        self.assertEqual(client.post(f"/api/agents/{self.agent['id']}/cards", json={"name": "x", "prompt": "y"}).status_code, 403)

    def test_only_an_admin_can_direct_an_agents_work_through_tasks(self):
        """Regression, 2026-10-13. /api/agents is admin-only because agents
        run in Auto, so whoever directs them approves everything they do. The
        generic /api/tasks routes took only require_user and never checked
        admin, and an agent's goals and cards carry no owner or admin_only, so
        a non-admin could run, stop, edit, re-status or delete an agent's work
        through them and have it self-approve."""
        from fastapi import HTTPException
        from routes import task_routes
        mine = task_service.create_task("Mine", "ordinary work", "card")
        agents = task_service.create_task("Theirs", "agent work", "card", agent_id=self.agent["id"])
        self.addCleanup(task_service.delete_task, mine["id"])
        self.addCleanup(task_service.delete_task, agents["id"])

        locked = FastAPI()
        locked.include_router(task_routes.router)
        locked.dependency_overrides[require_user] = lambda: "guest"
        client = TestClient(locked)

        def not_admin(request):
            raise HTTPException(status_code=403, detail="admin privileges required")

        # Patched at the guard's own boundary rather than through
        # dependency_overrides: the guard calls require_admin directly (a
        # FastAPI override only intercepts Depends), and this suite runs with
        # no accounts configured, where require_admin passes for everyone.
        # Who counts as an admin is covered by the auth tests; what is under
        # test here is that agent-owned work consults that check at all.
        with patch.object(task_routes, "require_admin", not_admin):
            for method, path, body in (
                ("post", f"/api/tasks/{agents['id']}/run", None),
                ("post", f"/api/tasks/{agents['id']}/stop", None),
                ("post", f"/api/tasks/{agents['id']}/status", {"status": "ready"}),
                ("patch", f"/api/tasks/{agents['id']}", {"name": "hijacked"}),
                ("delete", f"/api/tasks/{agents['id']}", None),
            ):
                response = getattr(client, method)(path, **({"json": body} if body else {}))
                self.assertEqual(response.status_code, 403, f"{method} {path} -> {response.status_code}")
        self.assertEqual(task_service.get_task(agents["id"])["name"], "Theirs", "nothing was changed")

        # An ordinary task is untouched by this: a non-admin still owns it.
        self.assertEqual(client.patch(f"/api/tasks/{mine['id']}", json={"name": "Renamed"}).status_code, 200)
        self.assertEqual(task_service.get_task(mine["id"])["name"], "Renamed")

    def test_a_question_waits_and_its_answer_comes_back(self):
        card = self.card("Pick a board")

        async def asking():
            return await tool_registry.call("agent_ask", {"question": "LinkedIn or Indeed?"},
                                            tool_registry.ToolContext(agent_id=self.agent["id"]), tool_registry.OPENAI)
        FakeBrain.script = [asking]
        self.dispatch()
        [item] = agent_service.inbox(self.agent["id"])
        self.assertEqual((item["kind"], item["card_id"]), ("question", card["id"]))
        self.assertEqual(web.post(f"/api/agents/inbox/{item['id']}/answer", json={"choice": "always"}).status_code, 400)
        web.post(f"/api/agents/inbox/{item['id']}/answer", json={"choice": "reply", "text": "Indeed"})
        self.assertEqual(task_service.get_task(card["id"])["status"], "ready", "the answer lets the card run again")
        self.dispatch()
        self.assertIn("Indeed", FakeBrain.prompts[-1])


class MemoryTests(AgentTestCase):
    def archive(self):
        return Path(agent_service._memory_path(self.agent["id"])).with_name("memory-archive.md")

    def fill(self, prefix):
        from services.agent_service import MEMORY_LIMIT
        memory = prefix + "Person's padding: "
        memory += "p" * (MEMORY_LIMIT - len(memory) - 1) + "\n"
        agent_service.write_memory(self.agent["id"], memory)
        return memory

    def test_full_memory_keeps_a_new_review_correction_and_archives_old_memory(self):
        from services.agent_service import MEMORY_LIMIT
        old = "- 2020-01-01: " + "x" * (MEMORY_LIMIT - len("## Notes\n- 2020-01-01: \n"))
        agent_service.write_memory(self.agent["id"], "## Notes\n" + old + "\n")
        card = self.card("Draft summary")
        task_service.set_card_status(card["id"], "review")
        task_service.set_card_status(card["id"], "ready", note="drop closed postings")
        memory = agent_service.read_memory(self.agent["id"])
        self.assertTrue('On "Draft summary": drop closed postings' in memory,
                        "review feedback was silently discarded from full memory")
        self.assertLessEqual(len(memory), MEMORY_LIMIT)
        archive = Path(agent_service._memory_path(self.agent["id"])).with_name("memory-archive.md").read_text(
            encoding="utf-8")
        self.assertIn(old, archive)

    def test_undated_person_text_and_headings_survive_pressure(self):
        personal = "My standing instructions\n\n## My own section\n- A note I typed myself\n"
        self.fill(personal + "## Notes\n- 2020-01-01: " + "x" * 150 + "\n")
        memory = agent_service.remember(self.agent["id"], "Corrections", "keep remote roles")
        self.assertTrue(memory.startswith(personal))
        self.assertIn("Person's padding: " + "p" * 100, memory)
        self.assertNotIn("My standing instructions", self.archive().read_text(encoding="utf-8"))

    def test_expired_entry_is_skipped_in_prompts_and_archived_before_live_older_entry(self):
        live = "- 2000-01-01: permanent older note"
        expired = "- 2020-01-01 (until 2021-01-01): expired contract rate " + "x" * 150
        original = self.fill("## Notes\n" + live + "\n" + expired + "\n")
        self.assertNotIn("expired contract rate", agent_service.run_prompt(self.agent, "work"))
        from services.agent_service import identity_block
        for surface in ({"chat": True}, {"team": True}):
            self.assertNotIn("expired contract rate", identity_block(self.agent, original, **surface))
        self.assertEqual(agent_service.read_memory(self.agent["id"]), original, "prompt filtering does not edit memory")
        memory = agent_service.remember(self.agent["id"], "Notes", "new correction")
        self.assertIn(live, memory)
        self.assertNotIn(expired, memory)
        archived = self.archive().read_text(encoding="utf-8")
        self.assertIn(expired, archived)
        self.assertNotIn(live, archived)

    def test_same_section_exact_repeat_is_archived_before_expired_or_old_entries(self):
        repeat = "the person prefers remote roles " + "r" * 100
        other = "- 2000-01-01: " + repeat
        expired = "- 2001-01-01 (until 2002-01-01): expired"
        repeated = "- 2020-01-01: " + repeat
        self.fill("## Notes\n" + other + "\n" + expired + "\n## Preferences\n" + repeated + "\n")
        memory = agent_service.remember(self.agent["id"], "Preferences", repeat)
        self.assertIn(other, memory, "a repeat in another section is not superseded")
        self.assertIn(expired, memory)
        self.assertNotIn(repeated, memory)
        self.assertIn(repeated, self.archive().read_text(encoding="utf-8"))

    def test_oldest_by_date_and_added_entry_survives_multiple_archivings(self):
        recent = "- 2020-01-01: recent " + "r" * 130
        oldest = "- 2000-01-01: oldest " + "o" * 130
        middle = "- 2010-01-01: middle " + "m" * 130
        self.fill("## Notes\n" + recent + "\n" + oldest + "\n" + middle + "\n")
        new = "- 1990-01-01: text that looks older " + "n" * 190
        memory = agent_service.remember(self.agent["id"], "Notes", new)
        self.assertIn(new, memory)
        self.assertIn(recent, memory)
        self.assertNotIn(oldest, memory)
        self.assertNotIn(middle, memory)
        archived = self.archive().read_text(encoding="utf-8")
        self.assertLess(archived.index(oldest), archived.index(middle))
        self.assertNotIn(new, archived)
        self.assertIn("## Archived " + datetime.now().strftime("%Y-%m-%d"), archived)
        agent_service.remember(self.agent["id"], "Notes", "second addition " + "s" * 130)
        self.assertTrue(self.archive().read_text(encoding="utf-8").startswith(archived), "archives are appended")

    def test_legacy_memory_reads_unchanged_and_appends_in_place(self):
        legacy = "# Scout's memory\n\n## Preferences\n- 2026-10-01: remote roles\n\n## Notes\nHandwritten note\n\n"
        agent_service.write_memory(self.agent["id"], legacy)
        self.assertEqual(agent_service.read_memory(self.agent["id"]), legacy)
        memory = agent_service.remember(self.agent["id"], "Preferences", "brief summaries")
        entry = f"- {datetime.now().strftime('%Y-%m-%d')}: brief summaries\n"
        self.assertEqual(memory, legacy.replace("\n\n## Notes", "\n" + entry + "\n## Notes"))
        self.assertFalse(self.archive().exists())

    def test_optional_expiry_and_malformed_expiry_stays_permanent(self):
        malformed = "## Notes\n- 2020-01-01 (until 2021-99-99): typo expiry\n" \
                    "- 2020-01-01 (until nonsense: broken expiry\n- not-a-date: person's note\n"
        agent_service.write_memory(self.agent["id"], malformed)
        ctx = tool_registry.ToolContext(agent_id=self.agent["id"])
        result = asyncio.run(tool_registry.call("agent_remember", {"section": "Notes", "text": "temporary note",
                                                                  "until": "2999-11-01"}, ctx, tool_registry.OPENAI))
        self.assertTrue(result.startswith("Noted"), result)
        self.assertIn("(until 2999-11-01): temporary note", agent_service.read_memory(self.agent["id"]))
        agent_service.remember(self.agent["id"], "Notes", "ends today", until=datetime.now().strftime("%Y-%m-%d"))
        prompt = agent_service.run_prompt(self.agent, "work")
        for text in ("typo expiry", "broken expiry", "person's note", "temporary note"):
            self.assertIn(text, prompt)
        self.assertNotIn("ends today", prompt)

    def test_impossible_additions_leave_files_untouched_and_card_records_failure(self):
        from services.agent_service import MEMORY_LIMIT
        original = self.fill("## Notes\n- 2020-01-01: small removable note\n")
        for text, error in (("x" * MEMORY_LIMIT, "exceeds"), ("x" * 100, "hand-written")):
            with self.subTest(error=error):
                with self.assertRaisesRegex(ValueError, error):
                    agent_service.remember(self.agent["id"], "Notes", text)
                self.assertEqual(agent_service.read_memory(self.agent["id"]), original)
                self.assertFalse(self.archive().exists())
                card = self.card("Oversized correction")
                task_service.set_card_status(card["id"], "review")
                task_service.set_card_status(card["id"], "ready", note=text)
                saved = task_service.get_task(card["id"])
                self.assertTrue(any(c["kind"] == "note" and "could not be saved to agent memory" in c["text"]
                                    for c in saved["comments"]))
                self.assertEqual([c["text"] for c in saved["comments"] if c["kind"] == "feedback"], [text])

    def test_archive_write_failure_does_not_remove_active_entries(self):
        original = self.fill("## Notes\n- 2020-01-01: " + "x" * 150 + "\n")
        self.archive().mkdir()  # Opening an archive directory must fail before active memory is replaced.
        with self.assertRaises(OSError):
            agent_service.remember(self.agent["id"], "Notes", "new correction")
        self.assertEqual(agent_service.read_memory(self.agent["id"]), original)

    def test_team_correction_failure_is_visible_on_the_task(self):
        import json
        from contextlib import closing
        from core.swarm.budget import BudgetLimit
        from core.swarm.store import SwarmStore
        from services.swarm_service import SwarmService
        from services.agent_service import MEMORY_LIMIT
        with tempfile.TemporaryDirectory(prefix="jarvis-memory-team-") as root, \
             closing(SwarmStore(Path(root) / "swarm.sqlite3")) as store:
            service = SwarmService(root)
            service.store = store
            limit = BudgetLimit(20000, 80, 0)
            pool = store.create_pool("test", limit)
            system, lead = store.create_system("david", "Team", "work", pool_id=pool,
                                                system_limit=limit, lead_limit=limit)
            with store.transaction() as db:
                db.execute("INSERT INTO agent_settings(agent_id,jarvis_agent_id) VALUES(?,?)", (lead, self.agent["id"]))
            run = store.create_run(system, "work", limit)
            task_id = store.create_task(system, run, lead, "work", command_id="task")
            with store.transaction() as db:
                db.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (json.dumps({"kept": "original"}), task_id))
                store._event(db, system, "task.revision_requested", task_id, {"note": "x" * MEMORY_LIMIT})
            service.sync_agents(system)
            checkpoint = json.loads(store.get_task(task_id)["checkpoint"])
            self.assertEqual(checkpoint["kept"], "original")
            self.assertIn("could not be saved to agent memory", checkpoint["memory_save_failures"][0])
            service.sync_agents(system)
            self.assertEqual(json.loads(store.get_task(task_id)["checkpoint"]), checkpoint, "recorded once")


class TopicAndRecallTests(AgentTestCase):
    def topic_file(self, name):
        return Path(agent_service._topic_path(self.agent["id"], name))

    def chat(self, title, statements=()):
        from core.session_manager import session_manager
        session = session_manager.create_session(title)
        session_manager.set_agent(session["id"], self.agent["id"], "agent")
        self.addCleanup(session_manager.delete_session, session["id"])
        for stamp, statement in statements:
            with patch("core.session_manager.time.time", return_value=stamp):
                session_manager.append_message(session["id"], "assistant", statement)
        return session

    def test_topic_index_is_description_only_and_read_is_deliberate(self):
        path = self.topic_file("hiring")
        path.parent.mkdir(parents=True)
        original = "Description: Interview process\n## Notes\nSecret interview detail\n"
        path.write_text(original, encoding="utf-8")
        from services.agent_service import identity_block
        prompt = identity_block(self.agent, agent_service.read_memory(self.agent["id"]), chat=True)
        self.assertIn("hiring: Interview process", prompt)
        self.assertNotIn("Secret interview detail", prompt)
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        ctx = tool_registry.ToolContext(agent_id=self.agent["id"])
        opened = asyncio.run(tool_registry.call("agent_read_topic", {"topic": "hiring"}, ctx, tool_registry.OPENAI))
        self.assertEqual(opened, original)
        missing = asyncio.run(tool_registry.call("agent_read_topic", {"topic": "missing"}, ctx, tool_registry.OPENAI))
        self.assertIn("hiring", missing)
        self.assertIn("No memory topic", missing)

    def test_hand_created_topic_without_description_and_topic_remember(self):
        path = self.topic_file("clients")
        path.parent.mkdir(parents=True)
        original = "# Hand edited\nUnchanged note\n"
        path.write_text(original, encoding="utf-8")
        self.assertIn(("clients", "No description provided"), agent_service.topic_index(self.agent["id"]))
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        ctx = tool_registry.ToolContext(agent_id=self.agent["id"])
        result = asyncio.run(tool_registry.call("agent_remember", {
            "section": "Notes", "text": "Client prefers email", "topic": "clients"}, ctx, tool_registry.OPENAI))
        self.assertIn("clients", result)
        self.assertIn("Client prefers email", agent_service.read_topic(self.agent["id"], "clients"))
        self.assertNotIn("Client prefers email", agent_service.read_memory(self.agent["id"]))
        self.assertTrue(agent_service.read_topic(self.agent["id"], "clients").startswith(original))

    def test_new_topic_can_advertise_its_subject(self):
        ctx = tool_registry.ToolContext(agent_id=self.agent["id"])
        asyncio.run(tool_registry.call("agent_remember", {
            "section": "Notes", "text": "Candidates need remote roles", "topic": "hiring",
            "description": "Hiring criteria"}, ctx, tool_registry.OPENAI))
        self.assertEqual(agent_service.topic_index(self.agent["id"]), [("hiring", "Hiring criteria")])
        self.assertIn("Candidates need remote roles", agent_service.read_topic(self.agent["id"], "hiring"))

    def test_topic_ceiling_archives_by_core_policy(self):
        from services.agent_service import TOPIC_MEMORY_LIMIT
        path = self.topic_file("hiring")
        path.parent.mkdir(parents=True)
        old = "- 2020-01-01: " + "x" * (TOPIC_MEMORY_LIMIT - len("## Notes\n- 2020-01-01: \n"))
        path.write_text("## Notes\n" + old + "\n", encoding="utf-8")
        memory = agent_service.remember(self.agent["id"], "Notes", "new detail", topic="hiring")
        self.assertIn("new detail", memory)
        self.assertLessEqual(len(memory), TOPIC_MEMORY_LIMIT)
        archive = path.parent.parent / "memory-hiring-archive.md"
        self.assertIn(old, archive.read_text(encoding="utf-8"))

    def test_recent_work_window_order_count_size_and_current_thread(self):
        from services.agent_service import RECENT_WORK_CHARS, identity_block
        now = 2_000_000_000.0
        current = self.chat("Current", [(now - 5, "current secret")])
        self.chat("Older", [(now - 48 * 3600 - 1, "outside window")])
        for i in range(12):
            self.chat(f"Thread {i}", [(now - 100 + i, f"statement {i} " + "z" * 500)])
        with patch("services.agent_service.time.time", return_value=now):
            brief = agent_service.recent_work(self.agent["id"], current["id"])
            prompt = identity_block(self.agent, agent_service.read_memory(self.agent["id"]),
                                    chat=True, session_id=current["id"])
        self.assertEqual(len(brief.splitlines()), 10)
        self.assertLessEqual(len(brief), RECENT_WORK_CHARS)
        self.assertLess(brief.index("statement 11"), brief.index("statement 10"))
        self.assertNotIn("statement 0", brief)
        self.assertNotIn("outside window", brief)
        self.assertNotIn("current secret", brief)
        self.assertIn(brief, prompt)

    def test_empty_recent_work_has_no_heading(self):
        from services.agent_service import identity_block
        prompt = identity_block(self.agent, agent_service.read_memory(self.agent["id"]), chat=True)
        self.assertNotIn("recent statements", prompt)

    def test_only_chat_recalls_extras_all_surfaces_keep_core_memory(self):
        from services.agent_service import identity_block
        now = 2_000_000_000.0
        path = self.topic_file("hiring")
        path.parent.mkdir(parents=True)
        path.write_text("Description: Hiring process\nprivate topic fact\n", encoding="utf-8")
        agent_service.remember(self.agent["id"], "Notes", "core standing fact")
        self.chat("Elsewhere", [(now - 10, "other thread statement")])
        memory = agent_service.read_memory(self.agent["id"])
        with patch("services.agent_service.time.time", return_value=now):
            prompts = {
                "scheduled": agent_service.run_prompt(self.agent, "scheduled work", goal={"name": "Daily", "report_when": "notable"}),
                "webhook": agent_service.run_prompt(self.agent, "webhook work"),
                "team": identity_block(self.agent, memory, team=True),
                "undeclared": identity_block(self.agent, memory),
                "chat": identity_block(self.agent, memory, chat=True),
            }
        for kind, prompt in prompts.items():
            self.assertIn("core standing fact", prompt, kind)
            self.assertNotIn("private topic fact", prompt, kind)
            if kind == "chat":
                self.assertIn("hiring: Hiring process", prompt)
                self.assertIn("other thread statement", prompt)
            else:
                self.assertNotIn("hiring: Hiring process", prompt, kind)
                self.assertNotIn("other thread statement", prompt, kind)

    def test_linked_teammate_can_open_a_named_topic_without_automatic_recall(self):
        from core.swarm.tools import ToolService
        path = self.topic_file("hiring")
        path.parent.mkdir(parents=True)
        path.write_text("Description: Hiring\nTeam detail\n", encoding="utf-8")
        team_tools = ToolService(None, is_lead=False, jarvis_agent_id=self.agent["id"])
        self.assertIn("read_memory", team_tools.definitions)
        self.assertIn("Team detail", team_tools.call("read_memory", {"topic": "hiring"}))
        self.assertIn("hiring", team_tools.call("read_memory", {"topic": "unknown"}))
        plain_tools = ToolService(None, is_lead=False)
        self.assertNotIn("read_memory", plain_tools.definitions)

    def test_agent_without_topic_directory_keeps_existing_prompt(self):
        from services.agent_service import identity_block
        self.assertFalse(self.topic_file("missing").parent.exists())
        memory = agent_service.read_memory(self.agent["id"])
        prompt = identity_block(self.agent, memory, chat=True)
        self.assertIn(memory.strip(), prompt)
        self.assertNotIn("Memory topics", prompt)


class ToolTests(AgentTestCase):

    def test_agent_tools_exist_only_for_agents(self):
        from core.external_brain import ExternalBrain
        plain = {s.name for s in tool_registry.specs(tool_registry.OPENAI)}
        claude = {s.name for s in tool_registry.specs(tool_registry.CLAUDE)}
        self.assertTrue({"agent_remember", "agent_read_topic", "agent_ask"}.isdisjoint(plain | claude))
        agent_tools = {s.name for s in tool_registry.specs(tool_registry.OPENAI, agent=True)}
        self.assertTrue({"agent_remember", "agent_read_topic", "agent_ask"} <= agent_tools)
        refused = asyncio.run(tool_registry.call("agent_remember", {"section": "Notes", "text": "x"},
                                                 tool_registry.ToolContext(session_id="s"), tool_registry.OPENAI))
        self.assertTrue(refused.startswith("Unknown tool"))
        refused_read = asyncio.run(tool_registry.call("agent_read_topic", {"topic": "hiring"},
                                                    tool_registry.ToolContext(session_id="s"), tool_registry.OPENAI))
        self.assertTrue(refused_read.startswith("Unknown tool"))
        names = {t["function"]["name"] for t in ExternalBrain("http://x", "m", None, agent_id=self.agent["id"]).tools}
        self.assertIn("agent_remember", names)
        self.assertNotIn("run_shell", names, "agents are never admin")

    def test_claude_agent_runs_pre_approve_only_their_own_agent_tools(self):
        """Found live: without pre-approval Claude sent agent_remember to the
        inbox as an approval request instead of running it."""
        from core.brain import Brain
        agent_run = Brain(agent_id=self.agent["id"])._tool_config()[1]
        self.assertTrue({"mcp__hive_mind__agent_remember", "mcp__hive_mind__agent_read_topic",
                         "mcp__hive_mind__agent_ask"} <= set(agent_run))
        self.assertTrue({"mcp__hive_mind__agent_remember", "mcp__hive_mind__agent_ask"}.isdisjoint(Brain()._tool_config()[1]))
        self.assertEqual(Brain(agent_id=self.agent["id"]).surface, f"agent:{self.agent['id']}")

    def test_remember_writes_to_the_named_section(self):
        ctx = tool_registry.ToolContext(agent_id=self.agent["id"])
        asyncio.run(tool_registry.call("agent_remember", {"section": "notes", "text": "Indeed has the most"}, ctx,
                                       tool_registry.OPENAI))
        memory = agent_service.read_memory(self.agent["id"])
        self.assertIn("Indeed has the most", memory.split("## Notes")[1])
        self.assertNotIn("Indeed has the most", memory.split("## Notes")[0])
        bad = asyncio.run(tool_registry.call("agent_remember", {"section": "Secrets", "text": "x"}, ctx, tool_registry.OPENAI))
        self.assertTrue(bad.startswith("Tool error"))

    def test_memory_is_capped_rather_than_silently_trimmed(self):
        with self.assertRaises(ValueError):
            agent_service.write_memory(self.agent["id"], "x" * 8001)
        agent_service.write_memory(self.agent["id"], "## Notes\n" + "y" * 7980)
        with self.assertRaises(ValueError):
            agent_service.remember(self.agent["id"], "Notes", "one more line that does not fit")

    def test_an_agent_chat_keeps_its_prompt_when_memory_changes(self):
        from core.session_manager import session_manager
        from services import chat_service
        with patch("core.model_endpoints.list_endpoints", return_value=[{"id": "api1", "kind": "api"}]), \
             patch("core.model_endpoints.get_endpoint", return_value={"id": "api1", "kind": "api", "model": "m"}):
            agent_service.update(self.agent["id"], endpoint_id="api1")
            session = web.post(f"/api/agents/{self.agent['id']}/chat").json()
        self.addCleanup(session_manager.delete_session, session["id"])
        self.assertEqual(session["agent_id"], self.agent["id"])
        endpoint = {"id": "api1", "kind": "api", "model": "m"}
        with patch("core.model_endpoints.resolve_runtime", return_value=("http://x", "m", None, None)):
            first = chat_service._build_brain(endpoint, session["id"])
            agent_service.remember(self.agent["id"], "Notes", "learned mid-chat")
            second = chat_service._build_brain(endpoint, session["id"])
        self.assertIn("talking with you directly", first._messages[0]["content"])
        self.assertEqual(first._messages[0]["content"], second._messages[0]["content"], "prompt cache stays valid")
        self.assertIn("agent_remember", {t["function"]["name"] for t in first.tools})
        self.assertEqual(first._context().permission_surface, f"chat:{session['id']}", "a chat can ask live")


class AgentChatListTests(AgentTestCase):
    """Chats with an agent live in the Agents tab: never in the Chats list,
    Library's files-by-chat or @ references, always in the agent's own list."""

    def make_chat(self):
        from core.session_manager import session_manager
        with patch("core.model_endpoints.list_endpoints", return_value=[{"id": "claude", "kind": "claude_cli"}]):
            session = web.post(f"/api/agents/{self.agent['id']}/chat").json()
        self.addCleanup(lambda: session_manager.get_session(session["id"]) and session_manager.delete_session(session["id"]))
        return session

    def test_agent_chats_stay_out_of_the_chats_list(self):
        from core.session_manager import session_manager
        plain = session_manager.create_session("Ordinary chat")
        self.addCleanup(session_manager.delete_session, plain["id"])
        agent_chat = self.make_chat()
        everyday = [s["id"] for s in session_manager.list_sessions()]
        self.assertIn(plain["id"], everyday)
        self.assertNotIn(agent_chat["id"], everyday)
        self.assertEqual([s["id"] for s in session_manager.list_sessions(agent_id=self.agent["id"])], [agent_chat["id"]])
        self.assertIn(agent_chat["id"], [s["id"] for s in session_manager.list_sessions(include_agents=True)])

    def test_the_sessions_route_filters_too(self):
        from routes import session_routes
        sessions_app = FastAPI()
        sessions_app.include_router(session_routes.router)
        sessions_app.dependency_overrides[require_user] = lambda: "david"
        client = TestClient(sessions_app)
        agent_chat = self.make_chat()
        self.assertNotIn(agent_chat["id"], [s["id"] for s in client.get("/api/sessions").json()])
        mine = client.get("/api/sessions", params={"agent_id": self.agent["id"]}).json()
        self.assertEqual([(s["id"], s["agent_id"]) for s in mine], [(agent_chat["id"], self.agent["id"])])

    def test_deleting_the_agent_moves_its_chats_to_chats(self):
        from core.session_manager import session_manager
        agent_chat = self.make_chat()
        web.delete(f"/api/agents/{self.agent['id']}")
        moved = session_manager.get_session(agent_chat["id"])
        self.assertIsNotNone(moved, "a conversation is never deleted with its agent")
        self.assertIsNone(moved["agent_id"])
        self.assertIn(agent_chat["id"], [s["id"] for s in session_manager.list_sessions()])

    def test_an_older_session_database_gains_the_agent_column(self):
        """Schema v2 had no agent_id column: the upgrade adds it and fills it
        from each session's document, so existing agent chats are found."""
        import json
        import sqlite3
        from core import session_manager_store as store
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.executescript(store._SCHEMA.replace(",\n    agent_id          TEXT", ""))
        self.assertNotIn("agent_id", {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")})
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '2')")
        conn.execute("INSERT INTO sessions (id, doc) VALUES ('a', ?), ('b', ?)",
                     (json.dumps({"id": "a", "agent_id": "x1"}), json.dumps({"id": "b"})))
        store._upgrade_schema(conn)
        self.assertEqual(dict(conn.execute("SELECT id, agent_id FROM sessions").fetchall()), {"a": "x1", "b": None})
        self.assertEqual(conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0],
                         str(store.SCHEMA_VERSION))


class DiscordAgentTests(AgentTestCase):
    """Phase 1b: the bot's own allowed user can talk to an agent, give it a
    job and answer its notifications from Discord; nobody else can, and
    every other message is handled as before. Real discord.Client handler,
    fake messages; nothing reaches Discord."""

    OWNER, STRANGER, CHANNEL = "111", "999", "555"

    def setUp(self):
        super().setUp()
        import discord
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from core.channels import discord_channel
        from services import chat_service
        self.discord, self.ns = discord, SimpleNamespace
        self.sent = []
        self.turn = AsyncMock(return_value="agent reply")
        p = patch.object(chat_service, "send_message", self.turn)
        p.start()
        self.addCleanup(p.stop)
        self.module = discord_channel

    def client(self, allowed=OWNER, mode=None):
        bot = {"id": "bot1", "name": "JARVIS", "allowed_user_id": allowed, "model_endpoint_id": None,
               "channels": [{"discord_channel_id": self.CHANNEL, "mode": mode}] if mode else []}
        return self.module._build_client(self.discord, bot)

    def message(self, text, author=OWNER, replying_to=None):
        sent = self.sent

        class Typing:
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False

        async def send(content=None, file=None):
            sent.append(content)

        channel = self.ns(id=int(self.CHANNEL), send=send, typing=lambda: Typing())
        reference = self.ns(resolved=replying_to, message_id=1) if replying_to is not None else None
        return self.ns(author=self.ns(id=int(author)), channel=channel, content=text, attachments=[], reference=reference)

    def say(self, client, *args, **kwargs):
        asyncio.run(client.on_message(self.message(*args, **kwargs)))

    def reviewed(self, name):
        """A card whose run has finished and waits for review."""
        card = self.card(name)
        self.dispatch()
        self.assertEqual(task_service.get_task(card["id"])["status"], "review")
        return card

    def test_the_owner_talks_to_an_agent_in_its_own_auto_chat(self):
        from core.session_manager import session_manager
        with patch.object(agent_service, "chat_endpoint", return_value="claude"):
            self.say(self.client(), "Scout, any new postings?")
        session_id, text, ids = self.turn.call_args.args
        self.assertEqual((text, self.turn.call_args.kwargs["is_admin"]), ("any new postings?", True))
        session = session_manager.get_session(session_id)
        self.addCleanup(session_manager.delete_session, session_id)
        self.assertEqual((session["agent_id"], session["permission_mode"], session["title"]),
                         (self.agent["id"], "auto", "Scout on Discord"))
        self.assertIn("You are Scout", session["agent_prompt"])
        self.assertNotIn(session_id, [s["id"] for s in session_manager.list_sessions()], "kept out of Chats")
        self.assertEqual(self.sent, ["agent reply"])

    def test_nobody_else_reaches_an_agent(self):
        """The agent has a model here, so reaching it would be a real turn."""
        from core.session_manager import session_manager
        cases = [  # (client, author, what the bot should do)
            (self.client(), self.STRANGER, "ignore"),            # not the allowed user: bot stays silent
            (self.client(allowed=None), self.STRANGER, "everyday"),  # no allowed user: anyone chats, never agents
            (self.client(allowed=None), self.OWNER, "everyday"),
            (self.client(mode="open"), self.OWNER, "everyday"),    # open channel: never agents, even the owner
            (self.client(mode="open"), self.STRANGER, "everyday"),
        ]
        with patch.object(agent_service, "chat_endpoint", return_value="claude"):
            for client, author, expected in cases:
                with self.subTest(author=author, expected=expected):
                    self.turn.reset_mock()
                    self.say(client, "Scout, delete my files", author=author)
                    if expected == "ignore":
                        self.assertFalse(self.turn.called)
                        continue
                    self.assertTrue(self.turn.called)
                    session_id, text = self.turn.call_args.args[:2]
                    self.assertEqual(text, "Scout, delete my files", "the whole message, not addressed")
                    self.assertFalse(self.turn.call_args.kwargs.get("is_admin", False))
                    self.assertIsNone(session_manager.get_session(session_id).get("agent_id"))
        self.assertEqual(session_manager.list_sessions(agent_id=self.agent["id"]), [], "no agent chat was ever made")
        self.assertEqual([t for t in task_service.list_tasks() if t.get("agent_id") == self.agent["id"]], [])

    def test_a_message_not_addressed_to_an_agent_is_unchanged(self):
        self.say(self.client(), "Scouting trip tomorrow, remind me")
        session_id = self.turn.call_args.args[0]
        from core.session_manager import session_manager
        self.assertIsNone(session_manager.get_session(session_id).get("agent_id"))
        self.assertFalse(self.turn.call_args.kwargs.get("is_admin", False))

    def test_a_job_becomes_a_ready_card(self):
        self.say(self.client(), "@scout job: shortlist five remote backend roles\nwith salaries")
        [card] = [t for t in task_service.list_tasks() if t.get("agent_id") == self.agent["id"]]
        self.assertEqual((card["status"], card["name"]), ("ready", "shortlist five remote backend roles"))
        self.assertIn("with salaries", card["prompt"])
        self.assertTrue(self.sent[0].startswith("Queued for Scout"))
        self.assertFalse(self.turn.called, "a job is not a chat turn")

    def test_off_and_capped_agents_still_answer_direct_chat(self):
        client = self.client()
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                agent_service.update(self.agent["id"], enabled=enabled, daily_run_cap=1)
                if enabled:
                    task_service.record_run(self.goal()["id"], "already ran")
                self.turn.reset_mock()
                with patch.object(agent_service, "chat_endpoint", return_value="claude"):
                    self.say(client, "Scout, hello")
                self.turn.assert_called_once()
                self.assertEqual(self.sent[-1], "agent reply")
                self.assertEqual(agent_service._reservations, {})

    def test_replying_to_a_question_answers_it(self):
        from services.agent_service import code_for
        card = self.reviewed("Pick a board")
        with agent_service.run(self.agent["id"], card_id=card["id"]):
            item = agent_service.add_item(self.agent["id"], "question", "LinkedIn or Indeed?")
        client = self.client()
        ours = self.ns(author=client.user, content=f"**Scout** has a question: LinkedIn or Indeed?\n_Reply to this message to answer. {code_for(self.agent, item['id'])}_")
        self.say(client, "Indeed", replying_to=ours)
        self.assertEqual(agent_service.get_item(item["id"])["answer"], "Indeed")
        self.assertEqual(task_service.get_task(card["id"])["status"], "ready")
        self.assertIn("the card will run again", self.sent[0])
        self.say(client, "LinkedIn", replying_to=ours)
        self.assertIn("already been answered", self.sent[1])
        self.assertFalse(self.turn.called)

    def test_replying_to_a_result_approves_it_or_sends_it_back(self):
        from services.agent_service import code_for
        client = self.client()
        first, second = self.reviewed("Draft A"), self.reviewed("Draft B")
        note = lambda card: self.ns(author=client.user, content=f"result\n_Reply 'approve'. {code_for(self.agent, card['id'])}_")
        self.say(client, "Approve!", replying_to=note(first))
        self.say(client, "Too long, keep it to five lines", replying_to=note(second))
        self.assertEqual(task_service.get_task(first["id"])["status"], "done")
        self.assertEqual(task_service.get_task(second["id"])["status"], "ready")
        self.assertIn("keep it to five lines", agent_service.read_memory(self.agent["id"]).split("## Corrections")[1])

    def test_a_reply_to_someone_elses_message_is_an_ordinary_message(self):
        stranger_message = self.ns(author=self.ns(id=42), content="[S-abcdef] not ours")
        self.say(self.client(), "thanks", replying_to=stranger_message)
        self.assertTrue(self.turn.called, "handled as an everyday message")

    def test_names_match_whole_and_longest_first(self):
        from core.channels.agent_routing import match_agent
        two = agent_service.create("Scout Two")
        self.addCleanup(self._remove, two["id"])
        self.assertEqual(match_agent("SCOUT: hi")[0]["id"], self.agent["id"])
        self.assertEqual(match_agent("Scout Two, hi")[0]["id"], two["id"])
        self.assertEqual(match_agent("  @scout")[1], "")
        self.assertIsNone(match_agent("Scouting is fun"))
        self.assertIsNone(match_agent("hey Scout"))


class DeleteTests(AgentTestCase):
    def test_deleting_an_agent_removes_pending_work_and_keeps_history(self):
        done = self.card("Finished job")
        self.dispatch()
        task_service.set_card_status(done["id"], "done")
        pending = self.card("Not started", status="backlog")
        goal = self.goal()
        self.assertEqual(web.delete(f"/api/agents/{self.agent['id']}").json()["removed_work"], 2)
        self.assertIsNone(task_service.get_task(pending["id"]))
        self.assertIsNone(task_service.get_task(goal["id"]))
        self.assertIsNotNone(task_service.get_task(done["id"]))
        self.assertEqual(len(task_service.list_runs(done["id"])), 1)
        self.assertIsNone(agent_service.get(self.agent["id"]))


class RouteTests(AgentTestCase):
    def test_goal_route_accepts_zone_and_weekday_rules(self):
        made = web.post(f"/api/agents/{self.agent['id']}/goals", json={
            "name": "Irish weekday morning", "prompt": "check", "schedule_kind": "daily",
            "run_time": "06:00", "time_zone": "Europe/Dublin", "weekdays": [0, 1, 2, 3, 4],
        })
        self.assertEqual(made.status_code, 200)
        self.assertEqual((made.json()["time_zone"], made.json()["weekdays"]), ("Europe/Dublin", [0, 1, 2, 3, 4]))

    def test_off_and_capped_checks_leave_receipts_on_the_agent_page_without_spending_runs(self):
        for reason in ("off", "capped"):
            with self.subTest(reason=reason):
                agent_service.update(self.agent["id"], enabled=True, daily_run_cap=100)
                goal = self.goal()
                goal["next_run_at"] = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
                count_before = agent_service.runs_today(self.agent["id"])
                if reason == "off":
                    agent_service.update(self.agent["id"], enabled=False)
                    expected = "turned off"
                else:
                    # A real completed check exhausts the cap; a receipt
                    # itself must never do that.
                    task_service.record_run(self.goal()["id"], "used a slot")
                    count_before = agent_service.runs_today(self.agent["id"])
                    agent_service.update(self.agent["id"], daily_run_cap=count_before)
                    expected = "runs for today"
                asyncio.run(task_scheduler._run_due())
                asyncio.run(task_scheduler._run_due())
                history = task_service.list_runs(goal["id"])
                self.assertEqual(len(history), 1)
                receipt = history[0]
                self.assertEqual(receipt["outcome"], "lost")
                self.assertIn(expected, receipt["missed_reason"])
                self.assertIn(expected, receipt["error"])
                self.assertIsNone(receipt["started_at"])
                self.assertIsNone(receipt["run_id"])
                self.assertEqual(agent_service.runs_today(self.agent["id"]), count_before)
                shown = web.get(f"/api/agents/{self.agent['id']}").json()["runs"]
                self.assertIn(receipt["id"], [r["id"] for r in shown])
                self.assertEqual(FakeBrain.prompts, [])

    def test_creating_and_listing(self):
        made = web.post("/api/agents", json={"name": "Archivist", "role": "Files things"}).json()
        self.addCleanup(self._remove, made["id"])
        self.assertEqual(web.post("/api/agents", json={"name": "archivist"}).status_code, 400, "names are unique")
        self.assertEqual(made["status"], "idle")
        self.assertIn("## Corrections", web.get(f"/api/agents/{made['id']}").json()["memory"])
        web.post(f"/api/agents/{made['id']}/cards", json={"name": "Sort notes", "prompt": "sort them"})
        listed = {a["name"]: a for a in web.get("/api/agents").json()}
        self.assertEqual(listed["Archivist"]["runs_today"], 0)
        self.assertEqual(web.post(f"/api/agents/{made['id']}/goals",
                                  json={"name": "x", "prompt": "y", "schedule_kind": "card"}).status_code, 400)
        self.assertEqual(web.get("/api/agents/inbox").json()["count"], 0)


class MemoryUpkeepTests(AgentTestCase):
    def setUp(self):
        super().setUp()
        from core.session_manager import session_manager
        self.session_manager = session_manager
        self.now = datetime.now().timestamp() + 1000
        session = session_manager.create_session("Quiet agent chat")
        session_manager.set_agent(session["id"], self.agent["id"], "agent")
        self.addCleanup(session_manager.delete_session, session["id"])
        self.session = session["id"]
        with patch("core.session_manager.time.time", return_value=self.now - 1000):
            session_manager.append_message(self.session, "user", "remember this")
        agent_service.update(self.agent["id"], memory_upkeep=True)

    def memory_file(self):
        return Path(agent_service._memory_path(self.agent["id"]))

    def put(self, text):
        self.memory_file().write_bytes(text.encode("utf-8"))

    def pass_once(self, topic=None):
        return agent_service.upkeep_memory(self.agent["id"], now=self.now, topic=topic)

    def test_quiet_window_and_active_chat(self):
        from services.agent_memory_upkeep import QUIET_SECONDS
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        self.assertIsNone(agent_service.upkeep_memory(self.agent["id"], now=self.now - 1000 + QUIET_SECONDS - 1))
        from services import chat_service
        with patch.object(chat_service, "is_busy", return_value=True):
            self.assertIsNone(self.pass_once())
        self.assertIsNotNone(agent_service.upkeep_memory(self.agent["id"], now=self.now - 1000 + QUIET_SECONDS))

    def test_admission_reservation_prevents_upkeep(self):
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        with agent_service.run(self.agent["id"]):
            self.assertIsNone(self.pass_once())
            self.assertIn("expired", agent_service.read_memory(self.agent["id"]))
        self.assertIsNotNone(self.pass_once())

    def test_noop_is_byte_identical_and_cached(self):
        original = b"## Notes\r\n  Person's note  \r\n- 2022-01-01: stable\r\n"
        self.memory_file().write_bytes(original)
        self.assertIsNone(self.pass_once())
        journal = Path(agent_service._memory_path(self.agent["id"])).with_name("memory-upkeep.json")
        first = journal.read_bytes()
        self.assertIsNone(self.pass_once())
        self.assertEqual(journal.read_bytes(), first)
        self.assertEqual(self.memory_file().read_bytes(), original)

    def test_merge_keeps_new_wording_and_earlier_date(self):
        self.put("## Notes\n- 2020-01-01: Likes remote roles.\n"
                 "- 2021-01-01: Remote roles preferred\n- 2022-01-01: newest fact\n")
        result = self.pass_once()
        self.assertEqual(result["changes"][0]["reason"], "near-duplicate")
        self.assertIn("- 2020-01-01: Remote roles preferred\n", self.memory_file().read_text())
        self.assertIn("- 2020-01-01: Likes remote roles.", self.memory_file().with_name("memory-archive.md").read_text())

    def test_correction_supersedes_earlier_note(self):
        self.put("## Preferences\n- 2020-01-01: onsite roles\n- 2020-02-01: concise replies\n"
                 "## Corrections\n- 2021-01-01: Use remote roles instead of onsite roles\n"
                 "## Notes\n- 2022-01-01: newest fact\n")
        self.assertIsNotNone(self.pass_once())
        self.assertNotIn("- 2020-01-01: onsite roles", self.memory_file().read_text())
        self.assertIn("Use remote roles instead of onsite roles", self.memory_file().read_text())

    def test_person_lines_sections_and_newest_are_protected(self):
        original = ("## Preferences\nPerson wrote this.\n- not-a-date: personal\n"
                    "## Notes\n- 2020-01-01 (until 2021-01-01): only entry\n"
                    "## Corrections\n- 2022-01-01 (until 2023-01-01): newest\n")
        self.put(original)
        self.assertIsNone(self.pass_once())
        self.assertEqual(self.memory_file().read_text(), original)

    def test_bounded_pass_and_all_removed_are_archived(self):
        lines = [f"- 2020-01-{i:02d} (until 2021-01-01): expired {i}\n" for i in range(1, 10)]
        self.put("## Notes\n" + "".join(lines) + "- 2022-01-01: newest\n")
        result = self.pass_once()
        self.assertLessEqual(len(result["changes"]), 2)
        archive = self.memory_file().with_name("memory-archive.md").read_text()
        for change in result["changes"]:
            self.assertIn(change["line"], archive)
        self.assertIn("newest", self.memory_file().read_text())

    def test_finished_project_is_archived_after_thirty_days(self):
        self.put("## Notes\n- 2020-01-01: Project Atlas uses an old board\n"
                 "- 2021-01-01: Project Atlas completed\n- 2022-01-01: newest fact\n")
        result = self.pass_once()
        self.assertEqual(result["changes"][0]["reason"], "finished project")
        self.assertIn("Project Atlas uses an old board", self.memory_file().with_name("memory-archive.md").read_text())
        self.assertIn("Project Atlas completed", self.memory_file().read_text())

    def test_journal_limit_blocks_new_pass_without_dropping_undo(self):
        from services import agent_memory_upkeep as upkeep
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        journal_path = upkeep._journal_path(agent_service, self.agent["id"])
        fake = {"id": "older", "status": "committed", "files": [], "changes": []}
        upkeep._save(journal_path, {"entries": [fake], "checked": {}})
        with patch.object(upkeep, "MAX_UNDOABLE", 1):
            self.assertIsNone(self.pass_once())
        self.assertEqual(upkeep.journal_entries(agent_service, self.agent["id"])[0]["id"], "older")
        self.assertIn("expired", self.memory_file().read_text())

    def test_undo_restores_hand_edited_bytes(self):
        original = (b"## Notes\r\nPerson's spacing    \r\n"
                    b"- 2020-01-01 (until 2021-01-01): expired  \r\n"
                    b"- 2022-01-01: newest\r\n")
        self.memory_file().write_bytes(original)
        result = self.pass_once()
        self.assertIsNotNone(result)
        self.assertTrue(agent_service.undo_memory_upkeep(self.agent["id"], result["id"])["undone"])
        self.assertEqual(self.memory_file().read_bytes(), original)
        self.assertFalse(self.memory_file().with_name("memory-archive.md").exists())

    def test_older_unrelated_topic_pass_can_be_undone(self):
        first = Path(agent_service._topic_path(self.agent["id"], "first"))
        second = Path(agent_service._topic_path(self.agent["id"], "second"))
        first.parent.mkdir(exist_ok=True)
        body = b"## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n"
        first.write_bytes(body); second.write_bytes(body)
        one = self.pass_once("first")
        two = self.pass_once("second")
        agent_service.undo_memory_upkeep(self.agent["id"], one["id"])
        self.assertEqual(first.read_bytes(), body)
        self.assertNotEqual(second.read_bytes(), body)
        self.assertEqual([e["id"] for e in agent_service.memory_upkeep_journal(self.agent["id"])
                          if e["status"] == "committed"], [two["id"]])

    def test_interrupted_pass_recovers_both_files(self):
        from services import agent_memory_upkeep as upkeep
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        original = self.memory_file().read_bytes()
        real_atomic = upkeep._atomic
        calls = []

        def cut_after_archive(path, data):
            calls.append(path.name)
            if path.name == "memory.md":
                raise RuntimeError("process exited")
            return real_atomic(path, data)

        with patch.object(upkeep, "_atomic", side_effect=cut_after_archive):
            with self.assertRaisesRegex(RuntimeError, "process exited"):
                self.pass_once()
        self.assertIn("memory-archive.md", calls)
        upkeep.recover(agent_service, self.agent["id"])
        self.assertEqual(self.memory_file().read_bytes(), original)
        self.assertFalse(self.memory_file().with_name("memory-archive.md").exists())

    def test_unsafe_undo_refuses_without_partial_change(self):
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        result = self.pass_once()
        self.memory_file().write_bytes(self.memory_file().read_bytes() + b"Personal addition\n")
        before = self.memory_file().read_bytes()
        archive = self.memory_file().with_name("memory-archive.md").read_bytes()
        with self.assertRaisesRegex(ValueError, "changed"):
            agent_service.undo_memory_upkeep(self.agent["id"], result["id"])
        self.assertEqual(self.memory_file().read_bytes(), before)
        self.assertEqual(self.memory_file().with_name("memory-archive.md").read_bytes(), archive)

    def test_opt_out(self):
        agent_service.update(self.agent["id"], memory_upkeep=False)
        self.put("## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        original = self.memory_file().read_bytes()
        self.assertIsNone(self.pass_once())
        self.assertEqual(self.memory_file().read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
