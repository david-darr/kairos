"""A bot's report and its team's (services/bot_activity_report.py, routes/bot_activity_routes.py): recent runs with
plain steps, what it made, approvals with reasons, errors with their fix, tokens and spend, and links into the work.
Run: python scripts/test_bot_activity_report.py
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

DATA = tempfile.TemporaryDirectory(prefix="kairos-bot-report-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException  # noqa: E402
from core import bot_policy, runs  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import bot_activity_report as report, bot_attention, bot_departments  # noqa: E402
from services.agent_service import agent_service  # noqa: E402


def record_run(bot_id, session_id=None, outcome="finished", steps=(), detail="", tokens=1200):
    context = runs.RunContext("chat" if session_id else "card", session_id=session_id, agent_id=bot_id)
    tally = runs.Tally()
    for n, (name, args, ok, output) in enumerate(steps):
        tally.add(runs.tool_started(f"t{n}", name, args))
        tally.add(runs.tool_finished(f"t{n}", ok, output))
    tally.add(runs.event(runs.EventKind.USAGE, usage=runs.Usage(prompt_tokens=tokens - 200, output_tokens=200, total_tokens=tokens)))
    runs.record(context, tally, outcome, detail=detail)
    return context.run_id


class Reports(unittest.TestCase):
    def setUp(self):
        self.user = bot_attention.legacy_owner()
        self.bot = agent_service.create("Researcher", role="Finds trending topics")["id"]
        self.mate = agent_service.create("Evaluator", role="Picks topics")["id"]
        self.team = bot_departments.create("Content Studio", [self.bot, self.mate], self.user)
        self.thread = session_manager.create_session("Daily cycle")["id"]
        session_manager.set_agent(self.thread, self.bot, "")

    def tearDown(self):
        bot_departments.delete(self.team["id"], self.user)
        for bot in (self.bot, self.mate):
            agent_service.delete(bot)

    def test_a_bot_report_tells_the_story_in_plain_words(self):
        ok = record_run(self.bot, self.thread, steps=[
            ("WebSearch", {"query": "rising topics"}, True, "results"),
            ("WebSearch", {"query": "more"}, True, "results"),
            ("content_studio_add_topic", {"niche_id": 1, "title": "Moon dust facts", "source": "https://x"}, True, "{}"),
            ("content_studio_add_topic", {"niche_id": 1, "title": "Deep sea lights", "source": "https://y"}, True, "{}"),
            ("content_studio_add_topic", {"niche_id": 1, "title": "Rejected", "source": "https://z"}, False, "Not run: no niche")])
        record_run(self.bot, self.thread, outcome="failed", detail="RateLimitError: 429 Too Many Requests")
        bot_policy.record_decision(bot_id=self.bot, thread_id=self.thread, tool="content_studio_add_topic", op=None, mode="ask",
                                   outcome="allow", source="team", actor="policy", owner=self.user, unattended=False)
        bot_policy.record_decision(bot_id=self.bot, thread_id=self.thread, tool="content_studio_prepare_post", op=None, mode="ask",
                                   outcome="deny", source="asked", actor="owner", owner=self.user, unattended=False)
        bot_policy.record_decision(bot_id=self.bot, thread_id=None, tool="Write", op=None, mode="ask", outcome="deny",
                                   source="nobody-to-ask", actor="policy", owner="local", unattended=False)
        data = report.bot_report(self.user, self.bot)
        self.assertEqual((data["bot"]["name"], data["bot"]["team"]), ("Researcher", "Content Studio"))
        self.assertEqual((data["totals"]["runs"], data["totals"]["failed"]), (2, 1))
        self.assertGreaterEqual(data["totals"]["tokens"], 2400)
        run = next(r for r in data["runs"] if r["id"] == ok)
        self.assertEqual(run["steps"], ["Searched the web (2 times)", "Added a topic (3 times), 1 not done"])
        self.assertEqual(run["link"], {"tab": "botsShell", "agentId": self.bot, "sessionId": self.thread, "runId": ok})
        self.assertTrue(run["failed_steps"])
        topics = next(p for p in data["produced"] if p["key"] == "topics")
        self.assertEqual((topics["count"], topics["items"]), (2, ["Moon dust facts", "Deep sea lights"]))
        summary = data["approvals"]["summary"]
        self.assertEqual((summary["asked"], summary["denied"], summary["team"], summary["could_not_ask"]), (1, 1, 1, 1))
        lines = [row["text"] for row in data["approvals"]["recent"]]
        self.assertIn("Prepare post: you denied it.", lines)
        fixes = " ".join(e["fix"] for e in data["errors"])
        self.assertIn("limit", fixes)
        self.assertIn("Inbox", fixes)
        text = json.dumps(data)
        self.assertNotIn("https://x", text)        # arguments never appear, only the titles
        self.assertNotIn("â€”", text)

    def test_a_team_report_rolls_its_members_up(self):
        record_run(self.bot, self.thread, steps=[("content_studio_add_topic", {"title": "One"}, True, "{}")])
        record_run(self.mate, None, steps=[("content_studio_pick_topic", {"title": "One"}, True, "{}")])
        data = report.team_report(self.user, self.team["id"])
        self.assertEqual(data["team"]["name"], "Content Studio")
        self.assertEqual({m["name"] for m in data["members"]}, {"Researcher", "Evaluator"})
        self.assertEqual(data["totals"]["runs"], 2)
        self.assertTrue({"topics", "picks"} <= {p["key"] for p in data["produced"]})

    def test_someone_elses_bot_has_no_report(self):
        stranger = agent_service.create("Theirs")["id"]
        agent_service._agents[stranger]["owner_user"] = "someone-else"
        self.addCleanup(agent_service.delete, stranger)
        with self.assertRaises(HTTPException):
            report.bot_report(self.user, stranger)

    def test_old_rows_and_windows(self):
        self.assertEqual(report.bot_report(self.user, self.bot, days=500)["days"], report.MAX_DAYS)
        self.assertEqual(report.friendly("content_studio_record_metrics"), "Stored numbers")
        self.assertEqual(report.friendly("google_calendar_list"), "Google calendar list")


if __name__ == "__main__":
    unittest.main()
