"""Bots redesign, Phase 1 unit U1: solo goals ("Work until done") (2026-10-29).

Throwaway data folder, scripted model. The control line is private: held back
while streaming, stripped from the saved reply.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_goal_runs.py
"""
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-goals-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bots_chat_harness import OWNER, Harness  # noqa: E402
from services import bot_chat_service as service, bot_goal_runs as goals, chat_live  # noqa: E402


def line(status="continue", instruction="next", detail="progress"):
    import json
    return f'<kairos-goal>{json.dumps({"status": status, "instruction": instruction, "detail": detail})}</kairos-goal>'


class EnvelopeTests(unittest.TestCase):
    def test_tags_split_across_chunks_never_show(self):
        chunks = ["Working on it. <kai", "ros-goal>{\"status\": \"cont", "inue\"}</kairos", "-goal> after"]
        filt = goals.EnvelopeFilter()
        shown = "".join(filt.feed(c) for c in chunks) + filt.flush()
        self.assertEqual(shown, "Working on it.  after")

    def test_look_alike_text_is_released(self):
        filt = goals.EnvelopeFilter()
        shown = filt.feed("a < b and <kai") + filt.feed("ser> done") + filt.flush()
        self.assertEqual(shown, "a < b and <kaiser> done")

    def test_a_held_prefix_is_flushed_when_the_reply_ends(self):
        filt = goals.EnvelopeFilter()
        self.assertEqual(filt.feed("ends with <kairos"), "ends with ")
        self.assertEqual(filt.flush(), "<kairos")

    def test_an_unfinished_control_line_is_dropped(self):
        filt = goals.EnvelopeFilter()
        shown = filt.feed("text <kairos-goal>{\"status\":") + filt.flush()
        self.assertEqual(shown, "text ")

    def test_parse_takes_the_last_complete_line_and_validates_it(self):
        text = "Done.\n" + line("continue", "a") + "\nmore\n" + line("completed", "", "all good")
        visible, envelope = goals.parse(text)
        self.assertEqual(envelope["status"], "completed")
        self.assertNotIn("kairos-goal", visible)
        self.assertEqual(goals.parse("no line")[1], None)
        self.assertEqual(goals.parse("<kairos-goal>not json</kairos-goal>")[1], None)
        self.assertEqual(goals.parse('<kairos-goal>{"status": "weird"}</kairos-goal>')[1], None)
        self.assertEqual(goals.parse("half <kairos-goal>{")[0], "half")


class GoalCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        self.bot = self.h.bot("Goalie")
        self.sid = self.h.thread(self.bot)

    async def start(self, text="finish the report"):
        return await self.h.send(self.sid, text, mode="goal")

    def goal(self):
        return goals.current(self.sid)


class GoalRunTests(GoalCase):
    async def test_a_goal_runs_steps_until_completed_and_hides_its_control_lines(self):
        self.h.replies.extend(["Drafted it. " + line("continue", "polish the draft", "drafted"),
                               "Polished. " + line("completed", "", "finished")])
        await self.start()
        await self.h.idle()
        goal = self.goal()
        self.assertEqual((goal["status"], goal["turn"]), ("completed", 2))
        rows = self.h.path(self.sid)
        contents = [m["content"] for m in rows if m["role"] == "assistant" and not m.get("display_only")]
        self.assertEqual(contents, ["Drafted it.", "Polished."], "the saved text has no control line")
        step = [m for m in rows if m.get("goal_step")]
        self.assertEqual([m["content"] for m in step], ["polish the draft"])
        digest = rows[-1]
        self.assertEqual((digest["kind"], digest["digest"]["steps"], digest["digest"]["status"]), ("goal_digest", 2, "completed"))
        self.assertTrue(any(e["type"] == "bot.goal_finished" for e in self.h.events))
        self.assertIn("goal", self.h.prompts[0].lower())
        self.assertIn("kairos-goal", self.h.prompts[0], "the model was told how to end each reply")

    async def test_live_text_never_contains_the_control_line(self):
        packets = []
        queue, _ = chat_live.subscribe()
        self.addCleanup(chat_live.unsubscribe, queue)
        self.h.replies.append("Plain words. " + line("completed", "", "ok"))
        await self.start()
        await self.h.idle()
        while not queue.empty():
            packets.append(queue.get_nowait())
        streamed = "".join(p["chunk"] for p in packets if p.get("type") == "chunk")
        self.assertEqual(streamed, "Plain words. ")
        self.assertTrue(any(p.get("type") == "bot_goal" for p in packets), "progress frames went out")

    async def test_needs_input_and_blocked_end_the_goal_with_their_status(self):
        for status, expected in (("needs-input", "needs-input"), ("blocked", "blocked")):
            sid = self.h.thread(self.bot, status)
            self.h.replies.append("Question. " + line(status, "", "stuck"))
            await self.h.send(sid, "go", mode="goal")
            await self.h.idle()
            self.assertEqual(goals.current(sid)["status"], expected)

    async def test_a_missing_control_line_stops_with_a_recoverable_explanation(self):
        self.h.replies.append("I did something but forgot the line.")
        await self.start()
        await self.h.idle()
        goal = self.goal()
        self.assertEqual(goal["status"], "blocked")
        self.assertIn("Send a message", goal["detail"])
        await self.h.send(self.sid, "carry on [reply:fine]")
        await self.h.idle()
        self.assertEqual(self.h.path(self.sid)[-1]["content"], "fine", "the conversation still works")

    async def test_the_same_assignment_three_times_is_blocked(self):
        self.h.replies.extend(["a " + line("continue", "Do the thing")] * 6)
        await self.start()
        await self.h.idle()
        goal = self.goal()
        self.assertEqual(goal["status"], "blocked")
        self.assertEqual(goal["turn"], 3)
        self.assertIn("three times", goal["detail"])

    async def test_a_goal_is_capped_at_thirteen_steps(self):
        self.h.replies.extend(["step " + line("continue", f"different step {n}") for n in range(30)])
        await self.start()
        await self.h.idle(timeout=20)
        goal = self.goal()
        self.assertEqual((goal["status"], goal["turn"]), ("limit-reached", 13))
        self.assertEqual(len(self.h.prompts), 13)

    async def test_one_failed_step_is_retried_once_a_second_failure_fails_the_goal(self):
        self.h.replies.append("first " + line("continue", "[fail] second step"))
        await self.start()
        await self.h.idle()
        goal = self.goal()
        self.assertEqual((goal["status"], goal["turn"]), ("failed", 3), "the step was tried twice")
        self.assertEqual(len(self.h.prompts), 3)

    async def test_a_transient_failure_that_clears_on_retry_carries_on(self):
        self.h.replies.append("first " + line("continue", "[fail-once] second"))
        original = self.h.brain.events
        calls = {"n": 0}

        async def flaky(prompt, stream=True):
            if "[fail-once]" in prompt:
                calls["n"] += 1
                if calls["n"] == 1:
                    self.h.prompts.append(prompt)
                    raise RuntimeError("blip")
            async for item in original(prompt.replace("[fail-once]", ""), stream):
                yield item

        self.h.brain.events = flaky
        self.h.replies.append("second " + line("completed", "", "done"))
        await self.start()
        await self.h.idle()
        self.assertEqual(self.goal()["status"], "completed")

    async def test_stop_by_root_stops_the_goal_and_a_stale_root_does_nothing(self):
        await self.start("long job [hold]")
        await self.h.held()
        goal = self.goal()
        self.assertEqual(goals.stop(OWNER, self.sid, "old-root")["outcome"], "already-stopped")
        self.assertEqual(chat_live.current_turn(self.sid)["status"], "processing")
        self.assertEqual(goals.stop(OWNER, self.sid, goal["root_id"])["outcome"], "stopping")
        await self.h.idle()
        self.assertEqual(self.goal()["status"], "stopped")
        self.assertEqual(len([m for m in self.h.path(self.sid) if m.get("kind") == "stopped"]), 1)
        self.assertEqual(goals.stop(OWNER, self.sid, goal["root_id"])["outcome"], "already-stopped")
        self.assertEqual(len(self.h.prompts), 1, "no further step started")

    async def test_stopping_the_turn_stops_the_goal_too(self):
        first = await self.start("long job [hold]")
        await self.h.held()
        service.interrupt(OWNER, self.sid, first["turn_id"])
        await self.h.idle()
        self.assertEqual(self.goal()["status"], "stopped")

    async def test_a_goal_step_waits_for_the_thread_instead_of_being_lost(self):
        self.h.replies.extend(["a " + line("continue", "step two"), "b " + line("completed", "", "done")])
        await self.start()
        await self.h.idle()
        self.assertEqual(self.goal()["status"], "completed")
        self.assertEqual(self.h.queue(self.sid)["items"], [])

    async def test_a_person_message_during_a_goal_runs_between_steps(self):
        self.h.replies.extend(["a " + line("continue", "step two"), "person reply", "b " + line("completed", "", "done")])
        await self.start("work [hold]")
        await self.h.held()
        queued = await self.h.send(self.sid, "quick question")
        self.assertTrue(queued["queued"])
        self.h.release()
        await self.h.idle(timeout=10)
        texts = [c for r, c in self.h.texts(self.sid)]
        self.assertIn("quick question", texts)
        self.assertEqual(self.goal()["status"], "completed")

    async def test_progress_frames_are_throttled(self):
        queue, _ = chat_live.subscribe()
        self.addCleanup(chat_live.unsubscribe, queue)
        run = {"root_id": "r", "session_id": self.sid, "status": "working", "goal": "g", "turn": 1, "detail": "",
               "started_at": 0, "updated_at": 0, "current_turn_id": "t"}
        while not queue.empty():
            queue.get_nowait()
        for _ in range(20):
            goals._frame(run)
        frames = []
        while not queue.empty():
            frames.append(queue.get_nowait())
        self.assertEqual(len([f for f in frames if f.get("type") == "bot_goal"]), 1)
        goals._frame(run, force=True)
        self.assertFalse(queue.empty())

    async def test_detail_and_tail_are_redacted(self):
        run = {"root_id": "r", "session_id": self.sid, "status": "done", "goal": "g", "turn": 1,
               "detail": "used password=hunter2 to log in", "started_at": 0, "updated_at": 0, "current_turn_id": "t"}
        self.assertNotIn("hunter2", goals.public(run)["detail"])


if __name__ == "__main__":
    unittest.main()
