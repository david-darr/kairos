"""End to end, with stand-in models: one Content Studio cycle hands work Producer -> Researcher -> Evaluator and then
to the Publisher, every bot at Ask, through the real broker, the real hand-off code and the real card runs.

Before 2026-11-11 this took three prompts to start and the Researcher's topics were refused with nobody to ask.
Now the only prompt is the publish, it reaches the person (in the Publisher's work thread and their Inbox) instead
of being refused, and every delegated step is recorded under the person's own name. Run:
python scripts/test_bot_team_flow.py
"""
import asyncio
import dataclasses
import os
import sys
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.test_data_support import TestDataDirectory  # noqa: E402
fixture = TestDataDirectory(prefix="kairos-team-flow-")
os.environ["JARVIS_DATA_DIR"] = fixture.name

from core import bot_policy, outbox, permissions, runs, task_scheduler, tool_registry  # noqa: E402
from core import bot_content_studio_tools  # noqa: E402,F401
from core.session_manager import session_manager  # noqa: E402
from core.turn_taint import TurnTaint  # noqa: E402
from services import bot_attention, bot_departments  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.content_studio import team as studio_team  # noqa: E402
from services.task_service import task_service  # noqa: E402

OWNER = "david-darr"
DONE = []


class ScriptedBrain:
    """A stand-in model: on each run it makes the tool calls its script names, as the bot, then answers."""
    pending_reference_taint = False

    def __init__(self, agent_id, script):
        self.agent_id, self.script = agent_id, script

    async def connect(self): pass
    async def disconnect(self): pass

    async def events(self, prompt, stream=True):
        ctx = tool_registry.ToolContext(agent_id=self.agent_id, turn_taint=TurnTaint())
        for name, args in self.script:
            DONE.append((self.agent_id, name, await tool_registry.call(name, args, ctx, tool_registry.CLAUDE)))
        yield runs.text("Done.")
        yield runs.result(False)


@asynccontextmanager
async def no_checkpoints(*args, **kwargs):
    yield


def stub(name):
    """Keep the tool's registration (its effect and the gate in front of it); only its work is a stand-in."""
    spec = tool_registry._REGISTRY[name]

    async def handler(args, ctx):
        return f"ok {name}"
    return spec, dataclasses.replace(spec, handler=handler)


class TeamFlow(unittest.TestCase):
    def setUp(self):
        DONE.clear()
        self.user = bot_attention.legacy_owner()
        self.bots = {name: agent_service.create(name, approval_mode="ask")["id"]
                     for name in ("Producer", "Researcher", "Evaluator", "Publisher")}
        roles = {self.bots["Producer"]: "producer", self.bots["Researcher"]: "researcher",
                 self.bots["Evaluator"]: "evaluator", self.bots["Publisher"]: "publisher"}
        self.team = bot_departments.create("Content Studio", list(self.bots.values()), self.user)
        names = ("content_studio_watch", "content_studio_add_topic", "content_studio_pick_topic", "content_studio_publish_youtube")
        swaps = [stub(n) for n in names]
        for _, new in swaps:
            tool_registry._REGISTRY[new.name] = new
        self.addCleanup(lambda: [tool_registry._REGISTRY.__setitem__(old.name, old) for old, _ in swaps])
        self.scripts = {}
        self.cards_opened = []
        real_open = permissions._card_open

        def counting_open(request, outcome):
            self.cards_opened.append((request.tool, request.surface, outcome.bot_id, outcome.owner))
            return real_open(request, outcome)
        # A script runs once; a later run of the same bot (a coordinator's continuation once its hand-offs settle)
        # just answers.
        for target, name, value in [(task_scheduler, "_task_brain", lambda task: ScriptedBrain(task["agent_id"], self.scripts.pop(task["agent_id"], []))),
                                    (task_scheduler.file_checkpoints, "around_turn", no_checkpoints),
                                    (task_scheduler.events, "emit", None), (agent_service, "_announce", None),
                                    (outbox, "kick", None), (permissions, "_card_open", counting_open)]:
            p = patch.object(target, name, side_effect=value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(studio_team, "role_of", lambda store, bot_id: roles.get(bot_id))
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        bot_departments.delete(self.team["id"], self.user)
        for bot in self.bots.values():
            task_service.delete_agent_work(bot)
            agent_service.delete(bot)

    def card_for(self, bot):
        return next(t for t in task_service.list_tasks() if t.get("agent_id") == bot and t.get("status") == "ready")

    async def run_card(self, bot):
        card = task_service.claim_next_card(card_id=self.card_for(bot)["id"], eligible=task_scheduler.agent_may_run)
        self.assertIsNotNone(card)
        await asyncio.wait_for(task_scheduler.start_run(card), timeout=30)

    def test_one_cycle_needs_only_the_publish_ok(self):
        asyncio.run(self.cycle())

    async def cycle(self):
        p, r, e, pub = (self.bots[n] for n in ("Producer", "Researcher", "Evaluator", "Publisher"))
        thread = session_manager.create_session("Daily cycle", owner_user=OWNER)["id"]
        agent_service.make_agent_chat(thread, agent_service.get(p))
        window = permissions.open_channel(f"chat:{thread}")   # the person is watching the Producer's chat
        taint = TurnTaint()
        taint.mark("content studio pipeline")                  # as reading the record does in the real turn
        ctx = tool_registry.ToolContext(session_id=thread, agent_id=p, turn_taint=taint, assignment_run_id="turn-1")
        self.assertIn("ok", await tool_registry.call("content_studio_watch", {"notify": True}, ctx, tool_registry.CLAUDE))
        handed = await tool_registry.call("coordinate_bots", {"bot_ids": [r], "message": "Find two sourced topics, then ask the Evaluator to pick."},
                                          ctx, tool_registry.CLAUDE)
        self.assertIn("Assigned", handed)
        self.assertTrue(window.empty(), "starting the cycle asked the person")

        self.scripts[r] = [("content_studio_add_topic", {"niche_id": 1, "title": "Moon dust", "source": "https://example.com/a"}),
                           ("content_studio_add_topic", {"niche_id": 1, "title": "Deep sea", "source": "https://example.com/b"}),
                           ("coordinate_bots", {"bot_ids": [e], "message": "Pick one of the two topics for the channel."})]
        await self.run_card(r)
        self.scripts[e] = [("content_studio_pick_topic", {"channel_id": 1, "topic_id": 1, "reason": "Rising"})]
        await self.run_card(e)
        self.assertEqual(self.cards_opened, [], "a teammate's step asked the person")

        self.assertIn("Assigned", await tool_registry.call("coordinate_bots", {"bot_ids": [pub], "message": "Post the approved video."},
                                                           ctx, tool_registry.CLAUDE))
        self.scripts[pub] = [("content_studio_publish_youtube", {"post_id": 1})]

        async def person():
            for _ in range(500):
                waiting = [req for req in permissions._pending.values() if req.tool == "content_studio_publish_youtube"]
                if waiting:
                    self.assertTrue(permissions.answer(waiting[0].id, "once", OWNER))
                    return waiting[0].surface
                await asyncio.sleep(0.02)
            self.fail("the publish never reached the person")
        answering = asyncio.create_task(person())
        await self.run_card(pub)
        surface = await answering

        topics = [d for d in DONE if d[1] == "content_studio_add_topic"]
        self.assertEqual([d[2] for d in topics], ["ok content_studio_add_topic"] * 2)
        self.assertIn("ok content_studio_pick_topic", [d[2] for d in DONE if d[0] == e])
        self.assertIn("ok content_studio_publish_youtube", [d[2] for d in DONE if d[0] == pub])
        self.assertTrue(any(d[0] == r and d[1] == "coordinate_bots" and "Assigned" in d[2] for d in DONE))
        # Exactly one prompt, the publish, asked in the Publisher's work thread (a conversation the person owns).
        self.assertEqual([c[0] for c in self.cards_opened], ["content_studio_publish_youtube"])
        self.assertEqual(self.cards_opened[0][3], OWNER)
        work = session_manager.get_session(surface.removeprefix("chat:"))
        self.assertEqual((work["agent_id"], work["owner_user"]), (pub, OWNER))
        rows = [row for bot in (r, e, pub) for row in bot_policy.decisions(None, bot_id=bot)]
        self.assertTrue(rows)
        self.assertEqual({row["owner"] for row in rows}, {OWNER})
        self.assertFalse([row for row in rows if row["source"] in ("nobody-to-ask", "timeout")])
        self.assertEqual([row["tool"] for row in rows if row["source"] == "asked"], ["content_studio_publish_youtube"])
        self.assertTrue(all(row["source"] == "team" for row in rows if row["tool"] == "content_studio_add_topic"))


if __name__ == "__main__":
    unittest.main()
