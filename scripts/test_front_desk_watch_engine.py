"""Kip's day watch on the REAL routine engine (2026-11-05).

test_bots_fdwatch.py swaps the engine for a stand-in, which is how the watch
shipped without ever being made on a real profile: the adapter called routine
functions that did not exist. This suite uses services.bot_routines and the
real runner, with only the model, mail and the brief's outside edges faked.
Run: .venv/Scripts/python.exe -X utf8 scripts/test_front_desk_watch_engine.py
"""
import asyncio
import json
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import bots_routine_test_support as support  # noqa: F401  (sets the data folder first)
from bots_routine_test_support import FakeBrain, RoutineCase

from core import front_desk_checks as checks, front_desk_watch_adapter as adapter
from services import bot_routines, front_desk_brief as brief, front_desk_watch as watch
from services.task_service import task_service


class WatchOnTheEngine(RoutineCase):
    async def asyncSetUp(self):
        await super().asyncSetUp()
        adapter._registered = None
        adapter._pending.clear()
        self.now = time.time()
        self.inbox, self.posted, self.post_fails = [], [], False
        folder = str(Path(support.DATA.name) / ("fd-" + uuid.uuid4().hex))
        for p in (patch.object(watch, "DIRECTORY", folder),
                  patch.object(watch, "bot_id", return_value=self.bot["id"]),
                  patch.object(watch, "main_thread_id", return_value=None),
                  patch.object(watch, "owner", return_value="local"),
                  patch.object(watch, "connected", return_value={"mail": True, "calendar": False}),
                  patch.object(checks, "read_mail", AsyncMock(side_effect=lambda now, since: list(self.inbox))),
                  patch.object(checks, "calendar_rows", AsyncMock(return_value=[])),
                  patch.object(brief, "refresh", AsyncMock(return_value={"sections": [], "has_content": False})),
                  patch.object(adapter, "post_card", side_effect=self.post_card),
                  patch.object(adapter, "notify", lambda *a, **k: None)):
            p.start()
            self.addCleanup(p.stop)

    async def settle(self, task_id=None):
        # The first routine run of a cold process loads the chat stack and can pass the
        # shared six-second wait (seen 2026-11-05); give this suite up to a minute.
        for attempt in range(10):
            try:
                return await super().settle(task_id)
            except AssertionError:
                if attempt == 9:
                    raise

    def post_card(self, kind, data, *, key, **kwargs):
        if self.post_fails:
            raise KeyError("Front desk conversation not found")
        self.posted.append((kind, key, data))

    def mail(self, n, **fields):
        return {"id": f"mail:{n:024x}", "uid": str(n), "uidvalidity": "1", "account": "acct", "date": self.now - n,
                "subject": f"Question {n}", "from": f"person{n}@example.com", "body": f"Can you look at item {n}?", **fields}

    def made(self):
        stamp = watch.read("watch")
        return task_service.get_task(stamp["routine_id"]) if stamp.get("routine_id") else None

    async def test_the_watch_is_made_once_as_a_real_routine_and_reports_working(self):
        self.assertTrue(adapter.available())
        self.assertEqual(watch.state()["state"], "off")  # connected, not made yet: the bug David saw
        await asyncio.to_thread(watch.ensure_watch)
        await asyncio.to_thread(watch.ensure_watch)
        task = self.made()
        self.assertIsNotNone(task)
        config = bot_routines.config_of(task)
        self.assertEqual((config["checks"], config["access"], config["deliver"], config["overlap"]),
                         (["calendar", "mail", "runs"], "read-and-draft", "brief", "skip"))
        self.assertEqual(config["schedule"]["every_minutes"], 15)
        mine = [t for t in task_service.list_tasks() if t.get("agent_id") == self.bot["id"]]
        self.assertEqual(len(mine), 1, "made once")
        state = watch.state()
        self.assertEqual((state["state"], state["edited"]), ("working", False))
        self.assertTrue(state["next_at"])

    async def test_the_watch_says_once_that_it_started_and_retries_a_failed_card(self):
        self.post_fails = True
        await asyncio.to_thread(watch.ensure_watch)
        self.assertTrue(self.made(), "a card that fails never stops the watch")
        self.assertEqual(self.posted, [])
        self.assertFalse(watch.read("watch").get("announced"))
        self.post_fails = False
        await asyncio.to_thread(watch.ensure_watch)
        await asyncio.to_thread(watch.ensure_watch)
        self.assertEqual([(kind, key) for kind, key, _ in self.posted], [("watching", "front-desk:watching")])
        data = self.posted[0][2]
        self.assertEqual(data["routine_id"], watch.read("watch")["routine_id"])
        self.assertIn("never send", " ".join(data["lines"]))
        from services import front_desk_cards
        self.assertEqual(front_desk_cards.clean_data("watching", data)["routine_id"], data["routine_id"])

    async def test_mail_to_sort_runs_the_model_and_the_answer_reaches_the_brief(self):
        await asyncio.to_thread(watch.ensure_watch)
        task = self.made()
        self.inbox = [self.mail(1), self.mail(2)]
        FakeBrain.script = [json.dumps({"important": [
            {"id": "m1", "verdict": "needs_you", "reason": "Asks you a direct question"},
            {"id": "m2", "verdict": "can_wait", "reason": "Can wait"}]})]
        self.make_due(task["id"])
        await self.tick(task_id=task["id"])
        self.assertEqual(FakeBrain.started, 1)
        prompt = FakeBrain.prompts[0]
        self.assertLess(prompt.index("reply with JSON only"), prompt.index("UNTRUSTED"),
                        "the sort instructions are the owner's, outside the fence")
        self.assertIn('"id": "m1"', prompt)
        self.assertNotIn(self.mail(1)["id"], prompt, "real mail ids stay out of the model's view")
        important = watch.read("brief")["important"]
        self.assertEqual([(r["id"], r["reason"]) for r in important], [(self.mail(1)["id"], "Asks you a direct question")])
        self.assertEqual(watch.read("checks")["mail"]["pending"], {})

    async def test_a_fenced_reply_is_still_read(self):
        await asyncio.to_thread(watch.ensure_watch)
        task = self.made()
        self.inbox = [self.mail(3)]
        FakeBrain.script = ["```json\n" + json.dumps({"important": [
            {"id": "m1", "verdict": "needs_you", "reason": "Needs a reply"}]}) + "\n```"]
        self.make_due(task["id"])
        await self.tick(task_id=task["id"])
        self.assertEqual([r["reason"] for r in watch.read("brief")["important"]], ["Needs a reply"])

    async def test_nothing_to_sort_never_starts_the_model_but_updates_the_check(self):
        await asyncio.to_thread(watch.ensure_watch)
        task = self.made()
        self.inbox = [self.mail(4, list_unsubscribe=True)]  # header rules clear it
        self.make_due(task["id"])
        await self.tick(task_id=task["id"])
        self.assertEqual(FakeBrain.started, 0)
        self.assertTrue(watch.read("checks").get("last_check_at"))
        run = bot_routines.run_view(self.runs_of(task["id"])[0])
        self.assertEqual((run["status"], run["model_ran"]), ("completed", False))

    async def test_check_now_from_the_route_thread_runs_the_checks(self):
        await asyncio.to_thread(watch.ensure_watch)
        task = self.made()
        adapter.bind_loop(asyncio.get_running_loop())
        self.addCleanup(adapter.bind_loop, None)
        self.inbox = [self.mail(5)]
        FakeBrain.script = [json.dumps({"important": [{"id": "m1", "verdict": "can_wait", "reason": "Can wait"}]})]
        result = await asyncio.to_thread(watch.run_now)
        self.assertTrue(result["started"])
        await self.settle(task["id"])
        self.assertEqual(FakeBrain.started, 1, "a manual check ran the checks, then sorted")
        self.assertEqual(watch.read("checks")["mail"]["judged"][-1], self.mail(5)["id"])

    async def test_other_routines_runs_feed_the_runs_check(self):
        other = self.routine("Weekly report")
        FakeBrain.script = ["Report done."]
        await bot_routines.run_now("local", True, other["id"])
        await self.settle(other["id"])
        rows = adapter.runs(time.time() - 3600)
        self.assertIn(other["id"], [r["routine_id"] for r in rows])
        self.assertTrue(all(r["ended_at"] for r in rows))


if __name__ == "__main__":
    unittest.main()
