"""Bots redesign, Phase 4 unit U2: goals in a room (2026-10-29).

The solo loop (services/bot_goal_runs.py) driven by a room step runner, with a
scripted model. Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_room_goals.py
"""
import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-room-goals-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import HTTPException  # noqa: E402

from bots_chat_harness import OWNER, Harness  # noqa: E402
from core import bot_rooms_store as store  # noqa: E402
from services import (bot_goal_runs as goals, bot_room_events as feed, bot_room_goals as room_goals,  # noqa: E402
                      bot_room_guard as guard, bot_room_turns as turns, bot_rooms as rooms)


def line(status="continue", instruction="next", detail="progress"):
    return f'<kairos-goal>{json.dumps({"status": status, "instruction": instruction, "detail": detail})}</kairos-goal>'


class GoalCase(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        feed.reset()
        guard.reset()
        turns.reset()
        goals._RUNS.clear()
        self.addCleanup(turns.reset)
        self.addCleanup(goals._RUNS.clear)
        self.a, self.b = self.h.bot("Lead"), self.h.bot("Helper")
        self.room = rooms.create(OWNER, "Goals", bot_ids=[self.a["id"], self.b["id"]], setup_done=True,
                                 default_responder={"kind": "member", "bot_id": self.a["id"]})
        self.addCleanup(store.delete_room, self.room["id"])
        self.thread = self.room["threads"][0]["id"]
        self.n = 0

    def goal(self, text="finish the report", thread=None):
        self.n += 1
        return turns.submit(self.room["id"], thread or self.thread, text, f"goal-send-{self.n:05d}", "goal", OWNER)

    async def finished(self, timeout=10.0, thread=None):
        deadline = time.monotonic() + timeout
        while True:
            run = goals._RUNS.get(f"room:{self.room['id']}:{thread or self.thread}")
            if run and run["status"] != "working" and not turns.thread_busy(self.room["id"], thread or self.thread):
                await asyncio.sleep(0.02)
                return run
            if time.monotonic() > deadline:
                raise AssertionError("goal did not finish: " + str(run and run["status"]))
            await asyncio.sleep(0.01)

    def rows(self, kind=None, role=None):
        return [m for m in store.messages(self.room["id"], limit=500) if (kind is None or m["kind"] == kind)
                and (role is None or m["role"] == role)]


class RoomGoalTests(GoalCase):
    async def test_a_goal_runs_steps_and_ends_done_with_the_control_line_hidden(self):
        queue, _ = feed.subscribe(OWNER)
        self.h.replies[:] = ["Drafted the outline. " + line("continue", "write the intro", "outline done"),
                             "Intro written. " + line("completed", "", "the report is finished")]
        self.goal()
        run = await self.finished()
        self.assertEqual((run["status"], run["turn"]), ("completed", 2))
        texts = [m["text"] for m in self.rows(role="bot")]
        self.assertEqual(texts, ["Drafted the outline.", "Intro written."])
        self.assertTrue(all("kairos-goal" not in m["text"] for m in store.messages(self.room["id"], limit=500)))
        frames = []
        while not queue.empty():
            frames.append(queue.get_nowait())
        shown = "".join(f["data"]["chunk"] for f in frames if f["type"] == "room.chunk")
        self.assertNotIn("kairos", shown)  # the control line is held back even when its tags split across chunks
        self.assertEqual(shown, "Drafted the outline. Intro written. ")
        goal_frames = [f["data"]["goal"] for f in frames if f["type"] == "room.goal"]
        self.assertEqual(goal_frames[0]["status"], "working")
        self.assertEqual(goal_frames[-1]["status"], "completed")
        digest = self.rows("goal")[-1]
        self.assertEqual(digest["meta"]["status"], "completed")
        self.assertIn("Done: 2 steps", digest["text"])
        self.assertEqual(store.threads(self.room["id"])[0]["goal"]["status"], "completed")
        self.assertFalse(room_goals.live(self.room["id"], self.thread))
        self.assertIn("Goal, step 2: write the intro", self.h.prompts[1])
        feed.unsubscribe(queue)

    async def test_thirteen_steps_is_the_cap(self):
        self.h.replies[:] = [f"step {n} " + line("continue", f"do part {n}") for n in range(1, 20)]
        self.goal()
        run = await self.finished(timeout=30)
        self.assertEqual((run["status"], run["turn"]), ("limit-reached", goals.MAX_STEPS))
        self.assertEqual(len(self.rows(role="bot")), 13)

    async def test_the_same_step_three_times_blocks_it(self):
        self.h.replies[:] = ["again " + line("continue", "same thing")] * 6
        self.goal()
        run = await self.finished()
        self.assertEqual(run["status"], "blocked")
        self.assertEqual(run["turn"], 3)

    async def test_a_missing_control_line_blocks_with_a_plain_reason(self):
        self.h.replies[:] = ["I did some work but forgot the line"]
        self.goal()
        run = await self.finished()
        self.assertEqual(run["status"], "blocked")
        self.assertIn("control line", run["detail"])

    async def test_one_live_goal_per_thread_and_a_second_thread_is_free(self):
        self.goal("first [hold]")
        await self.h.held(1)
        with self.assertRaises(HTTPException) as caught:
            self.goal("second")
        self.assertEqual(caught.exception.status_code, 409)
        other = rooms.create_thread(OWNER, self.room["id"], "Other")
        self.h.replies[:] = ["quick " + line("completed", "", "done")]
        self.goal("@Helper elsewhere", thread=other["id"])  # the lead is busy in the first thread, so a teammate takes it
        await self.finished(thread=other["id"])
        self.h.release()
        await self.finished()

    async def test_stop_ends_the_goal_and_the_running_step(self):
        self.goal("long goal [hold]")
        await self.h.held(1)
        self.assertTrue(room_goals.live(self.room["id"], self.thread))
        result = room_goals.stop(OWNER, self.room["id"], self.thread)
        self.assertEqual(result["outcome"], "stopping")
        run = await self.finished()
        self.assertEqual(run["status"], "stopped")
        self.assertEqual(room_goals.stop(OWNER, self.room["id"], self.thread)["outcome"], "already-stopped")

    async def test_person_stop_for_the_room_stops_the_goal(self):
        self.goal("long goal [hold]")
        await self.h.held(1)
        turns.stop(self.room["id"], OWNER)
        run = await self.finished()
        self.assertEqual(run["status"], "stopped")

    async def test_coordinator_is_the_mention_then_the_lead_then_the_first_member(self):
        infos = [{"bot_id": self.a["id"], "name": "Lead", "role": "", "held": False},
                 {"bot_id": self.b["id"], "name": "Helper", "role": "", "held": False}]
        room = store.get_room(self.room["id"])
        self.assertEqual(room_goals.coordinator_for(room, "@Helper take this", infos)["bot_id"], self.b["id"])
        self.assertEqual(room_goals.coordinator_for(room, "take this", infos)["bot_id"], self.a["id"])
        room = dict(room, default_responder={"kind": "mentions"})
        self.assertEqual(room_goals.coordinator_for(room, "take this", infos)["bot_id"], self.a["id"])
        infos[0]["held"] = True
        self.assertEqual(room_goals.coordinator_for(room, "take this", infos)["bot_id"], self.b["id"])
        infos[1]["held"] = True
        self.assertIsNone(room_goals.coordinator_for(room, "take this", infos))

    async def test_a_failed_step_is_retried_once_then_the_goal_fails(self):
        calls = []

        async def fake(room_id, thread_id, bot_id, **kwargs):
            calls.append(kwargs.get("extra_text"))
            return {"outcome": "provider_failed", "reply": "", "raw": "", "turn_id": f"t{len(calls)}"}
        from unittest.mock import patch
        with patch.object(turns, "run_member_turn", fake):
            self.goal()
            run = await self.finished()
        self.assertEqual((run["status"], len(calls)), ("failed", 2))

    async def test_failed_then_settled_carries_on(self):
        outcomes = [{"outcome": "provider_failed", "raw": "", "turn_id": "t1"},
                    {"outcome": "settled", "raw": "ok " + line("completed", "", "all done"), "turn_id": "t2"}]

        async def fake(room_id, thread_id, bot_id, **kwargs):
            return outcomes.pop(0)
        from unittest.mock import patch
        with patch.object(turns, "run_member_turn", fake):
            self.goal()
            run = await self.finished()
        self.assertEqual(run["status"], "completed")

    async def test_a_goal_that_cannot_start_says_so(self):
        for member in (self.a, self.b):
            from services import bot_room_holds as holds
            holds.hold(self.room["id"], member["id"], OWNER, interrupt=False)
        self.goal()
        for _ in range(100):
            if not turns.is_working(self.room["id"]):
                break
            await asyncio.sleep(0.02)
        self.assertTrue(any("on hold, so the goal could not start" in m["text"] for m in self.rows(role="system")))

    async def test_a_run_that_ends_without_an_outcome_is_marked_failed(self):
        class Silent:
            async def settle(self, run):
                raise asyncio.CancelledError()

            async def next_step(self, run, instruction):
                return True

            def cancel(self, run):
                pass
        run = goals.begin_custom(OWNER, "room:x:y", self.a["id"], "goal", Silent(), on_finish=lambda *a: None)
        await asyncio.gather(run["task"], return_exceptions=True)
        self.assertEqual(run["status"], "stopped")


class TeamGoalTests(GoalCase):
    def target(self, **extra):
        return {"kind": "room", "room_id": self.room["id"], "mode": "goal", **extra}

    async def test_a_room_target_is_validated_and_names_its_lead(self):
        clean = room_goals.validate_routine_target(OWNER, self.target())
        self.assertEqual((clean["lead_bot_id"], clean["mode"]), (self.a["id"], "goal"))  # the room's lead
        self.assertEqual(room_goals.validate_routine_target(OWNER, self.target(lead_bot_id=self.b["id"]))["lead_bot_id"], self.b["id"])
        for bad, status in ((self.target(kind="chat"), 422), (self.target(mode="text"), 422), (self.target(room_id="nope"), 404),
                            (self.target(lead_bot_id="outsider"), 422), ("room", 422)):
            with self.assertRaises(HTTPException) as caught:
                room_goals.validate_routine_target(OWNER, bad)
            self.assertEqual(caught.exception.status_code, status, bad)
        with self.assertRaises(HTTPException) as caught:
            room_goals.validate_routine_target("stranger", self.target())
        self.assertEqual(caught.exception.status_code, 404)

    async def test_the_lead_of_a_team_goal_cannot_be_removed_and_deleting_the_room_unlinks_it(self):
        room_goals.link_routine(OWNER, "routine-1", self.target())
        self.assertTrue(room_goals.lead_in_use(self.room["id"], self.a["id"]))
        self.assertFalse(room_goals.lead_in_use(self.room["id"], self.b["id"]))
        with self.assertRaises(HTTPException) as caught:
            rooms.update(OWNER, self.room["id"], {"member_ids": [self.b["id"]]})
        self.assertEqual(caught.exception.status_code, 409)
        rooms.update(OWNER, self.room["id"], {"member_ids": [self.a["id"]]})  # the helper may leave
        room_goals.unlink_routine("routine-1")
        rooms.update(OWNER, self.room["id"], {"member_ids": [self.b["id"]]})  # now the lead may too
        room_goals.link_routine(OWNER, "routine-2", self.target(lead_bot_id=self.b["id"]))
        self.assertEqual(room_goals.routine_ids_for_room(self.room["id"]), ["routine-2"])
        rooms.delete(OWNER, self.room["id"])
        self.assertEqual(store.routines_of_room(self.room["id"]), [])

    async def test_an_occurrence_runs_once_and_says_why_when_it_cannot(self):
        room_goals.link_routine(OWNER, "routine-3", self.target())
        self.h.replies[:] = ["Checked the numbers. " + line("completed", "", "all checked")]
        started = room_goals.start_routine(OWNER, "routine-3", "check the numbers", "2026-10-30T09:00")
        self.assertTrue(started["started"])
        run = await self.finished()
        self.assertEqual((run["status"], run["bot_id"]), ("completed", self.a["id"]))
        scheduled = [m for m in self.rows("goal") if m["meta"].get("scheduled") and m["role"] == "system"]
        self.assertEqual(scheduled[0]["text"], "Scheduled goal: check the numbers")
        again = room_goals.start_routine(OWNER, "routine-3", "check the numbers", "2026-10-30T09:00")
        self.assertEqual((again["started"], again["reason"]), (False, "This occurrence already ran."))
        self.assertEqual(room_goals.start_routine(OWNER, "missing", "x", "1")["started"], False)
        from services import bot_room_holds as holds
        holds.hold(self.room["id"], self.a["id"], OWNER, interrupt=False)
        self.assertEqual(room_goals.start_routine(OWNER, "routine-3", "x", "2")["reason"], "The lead is on hold.")
        holds.release(self.room["id"], self.a["id"], OWNER)
        self.h.replies[:] = ["more " + line("continue", "step", "going")] * 5
        self.assertTrue(room_goals.start_routine(OWNER, "routine-3", "keeps going [hold]", "3")["started"])
        await self.h.held(1)
        self.assertEqual(room_goals.start_routine(OWNER, "routine-3", "x", "4")["reason"], "A goal is already running in that room.")
        room_goals.stop(OWNER, self.room["id"], self.thread)
        self.h.release()
        await self.finished()

    async def test_a_scheduled_goal_that_ends_waiting_notifies_with_a_question(self):
        room_goals.link_routine(OWNER, "routine-4", self.target())
        self.h.replies[:] = ["Need a decision. " + line("needs-input", "", "which option?")]
        room_goals.start_routine(OWNER, "routine-4", "pick an option", "occ-1")
        await self.finished()
        event = [e for e in self.h.events if e["type"] == "bot.room_goal_finished"][-1]
        self.assertEqual((event["status"], event["notify"], event["scheduled"]), ("needs-input", "question", True))


if __name__ == "__main__":
    unittest.main()
