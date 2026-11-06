"""Content Studio Team package template (services/studio_team_package.py) against real stores and isolated data."""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from test_data_support import TestDataDirectory
ENV = TestDataDirectory("kairos-studio-team-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(ENV.name) / "vault")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import bot_rooms_store
from services import bot_package as pkg, bot_departments, bot_rooms, bot_usage, studio_team_package as team
from services.agent_service import agent_service
from services.task_service import task_service

ROOT = Path(__file__).resolve().parents[1]
NAMES = ["Producer", "Researcher", "Evaluator", "Script Writer", "Editor", "Publisher", "Executor"]
RULE_PHRASES = ("Never create an account", "archived from the rotation with its history kept", "Never delete",
                "waits for the person's OK", "AI-generated where the platform requires it (YouTube, TikTok)",
                "never like, comment on, follow", "keeps its source and its date", "pause that channel at once")


def clean():
    owner = None
    for bot in agent_service.list_agents():
        owner = bot_departments.owner(bot)
        break
    for room in bot_rooms.list_rooms(owner, include_archived=True) if owner is not None else []:
        bot_rooms.delete(owner, room["id"])
    for t in bot_departments.list(owner) if owner is not None else []:
        bot_departments.delete(t["id"], owner)
    for task in list(task_service.list_tasks()):
        task_service.delete_task(task["id"])
    for ident in list(agent_service._agents):
        agent_service.delete(ident)


class StudioTeamTests(unittest.TestCase):
    def setUp(self):
        clean()
        self.value = team.build()

    def tearDown(self):
        clean()
        bot_usage.update_settings(budget={"monthly_usd": None, "warn_percent": 80})

    def install(self):
        # A chief needs a model with tools; a fresh account has none, so give the lead one for the check.
        with patch.object(agent_service, "chat_endpoint", return_value={"id": "x"}, create=True):
            token = pkg.inspect(pkg.canonical(self.value))["token"]
            return pkg.import_(token)

    def bots(self):
        return {a["name"]: a for a in agent_service.list_agents()}

    def test_template_parses_and_is_shipped_in_the_templates_file(self):
        pkg.normalize(self.value)
        self.assertEqual([b["name"] for b in self.value["bots"]], NAMES)
        for path in ("static/data/bots-teams.json", "docs/demo/static/data/bots-teams.json"):
            rows = json.loads((ROOT / path).read_text(encoding="utf-8"))
            row = next(r for r in rows if r["id"] == team.TEAM_ID)
            self.assertEqual(row, team.template_entry(), f"{path} is stale: regenerate it from services/studio_team_package.py")
            pkg.normalize(row["package"])

    def test_import_makes_seven_bots_team_room_routines_cap_and_ask(self):
        result = self.install()
        self.assertEqual(sorted(r["name"] for r in result["created"]), sorted(NAMES))
        bots = self.bots()
        self.assertEqual(set(bots), set(NAMES))
        for name, bot in bots.items():
            self.assertEqual(bot["approval_mode"], "ask", name)
        owner = bot_departments.owner(bots["Producer"])
        teams = bot_departments.list(owner)
        self.assertEqual([t["name"] for t in teams], ["Content Studio"])
        self.assertEqual(len(bot_departments.members(teams[0]["id"])), 7)
        self.assertEqual(teams[0]["chief_bot_id"], bots["Producer"]["id"], "the Producer leads, not Kip")
        rooms = bot_rooms.list_rooms(owner, include_archived=True)
        self.assertEqual([r["name"] for r in rooms], ["Content Studio"])
        self.assertEqual(len(bot_rooms_store.members(rooms[0]["id"])), 7)
        tasks = task_service.list_tasks()
        self.assertEqual(sorted(t["name"] for t in tasks), ["Daily content cycle", "Daily metrics snapshot", "Weekly review and report"])
        self.assertTrue(all(not t.get("enabled") for t in tasks), "routines start paused")
        by_name = {t["name"]: t for t in tasks}
        self.assertEqual(by_name["Daily content cycle"]["agent_id"], bots["Producer"]["id"])
        self.assertEqual(by_name["Daily metrics snapshot"]["agent_id"], bots["Executor"]["id"])
        for t in tasks:
            self.assertIn("/api/content-studio/", t["prompt"])
        budget = bot_usage.settings()["budget"]
        self.assertEqual((budget["monthly_usd"], budget["warn_percent"]), (50, 80))

    def test_importing_twice_does_not_duplicate_or_overwrite(self):
        self.install()
        self.install()
        names = [a["name"] for a in agent_service.list_agents()]
        self.assertEqual(len(names), 14)
        self.assertEqual(len({n.casefold() for n in names}), 14, "the second set gets free names")
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 50, "the cap is set once, not stacked")

    def test_an_existing_lower_cap_stays_and_a_higher_one_comes_down(self):
        bot_usage.update_settings(budget={"monthly_usd": 20, "warn_percent": 80})
        self.install()
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 20)
        clean()
        bot_usage.update_settings(budget={"monthly_usd": 500, "warn_percent": 80})
        self.install()
        self.assertEqual(bot_usage.settings()["budget"]["monthly_usd"], 50)

    def test_a_failed_import_leaves_no_bots_routines_or_cap(self):
        original = pkg._sections["rooms"]

        def boom(data, mapping):
            raise ValueError("boom")
        pkg._sections["rooms"] = (original[0], boom)
        try:
            with self.assertRaises(ValueError):
                self.install()
        finally:
            pkg._sections["rooms"] = original
        self.assertEqual(agent_service.list_agents(), [])
        self.assertEqual(task_service.list_tasks(), [])

    def test_policy_never_raises_a_level_or_accepts_bad_data(self):
        from services import bot_package_policy as policy
        bot = agent_service.create("Solo", endpoint_id=None, approval_mode="ask")
        policy.import_policy({"approval": {"bot-1": "edits"}}, {"bot-1": bot["id"]})
        self.assertEqual(agent_service.get(bot["id"])["approval_mode"], "ask")
        for bad in ({"approval": {"bot-1": "full"}}, {"approval": {"x": "ask"}}, {"monthly_cap_usd": -1},
                    {"warn_percent": 0}, {"other": 1}, []):
            with self.assertRaises(ValueError):
                policy.import_policy(bad, {})

    def test_instructions_carry_the_roles_strategies_and_safety_rules(self):
        souls = {b["name"]: b["soul"] for b in self.value["bots"]}
        for name, soul in souls.items():
            for phrase in RULE_PHRASES:
                self.assertIn(phrase, soul, f"{name} is missing: {phrase}")
        self.assertIn("hook-first", souls["Script Writer"])
        self.assertIn("story-first", souls["Script Writer"])
        self.assertIn("trend-weighted", souls["Evaluator"])
        self.assertIn("track-record-weighted", souls["Evaluator"])
        self.assertIn("web search", souls["Researcher"])
        self.assertIn("motion video", souls["Editor"])
        self.assertIn("/api/content-studio/", souls["Producer"])
        self.assertIn("$50", souls["Producer"])
        self.assertIn("Inbox", souls["Producer"])
        self.assertIn("Never post anything the person has not approved", souls["Publisher"])
        self.assertIn("never retire anything yourself", souls["Executor"])
        self.assertIn("3 weeks and 10 posts", souls["Executor"])


if __name__ == "__main__":
    unittest.main()
