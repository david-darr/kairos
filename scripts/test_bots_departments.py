"""Teams use real bot persistence and isolated system-temp data."""
import copy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_data_support import TestDataDirectory
DATA = TestDataDirectory("kairos-chief-")
os.environ["JARVIS_DATA_DIR"] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from core.middleware import require_admin
from services.agent_service import agent_service
from services import bot_departments as teams, bot_chief, bot_audience
from routes import bot_department_routes, bot_team_routes

app = FastAPI()
app.include_router(bot_department_routes.router)
app.include_router(bot_team_routes.router)
app.dependency_overrides[require_admin] = lambda: "local"
web = TestClient(app)


class TeamsCase(unittest.TestCase):
    def setUp(self):
        agent_service._agents.clear()
        agent_service._save()
        teams.registry_path().unlink(missing_ok=True)
        self.owner_patch = patch.object(teams, "owner", side_effect=lambda b: b.get("owner_user", "local"))
        self.owner_patch.start()
        self.addCleanup(self.owner_patch.stop)
        self.endpoint_patch = patch.object(agent_service, "chat_endpoint", return_value="test-endpoint")
        self.endpoint_patch.start()
        self.addCleanup(self.endpoint_patch.stop)

    def bot(self, name="Test bot", **fields):
        return agent_service.create(name, **fields)

    def team(self):
        bot = self.bot(section="Research")
        return bot, teams.team_of(bot["id"])


class DepartmentsTests(TeamsCase):
    def test_lazy_unique_and_rename_rewrites(self):
        a, team = self.team()
        b = self.bot("Second", section="research")
        self.assertEqual(len(teams.list("local")), 1)
        with self.assertRaises(HTTPException):
            teams.create("RESEARCH", [], "local")
        renamed = teams.rename(team["id"], "Discovery", team["revision"], "local")
        self.assertEqual((a["section"], b["section"], renamed["id"]), ("Discovery", "Discovery", team["id"]))
        with self.assertRaises(HTTPException):
            teams.rename(team["id"], "Old", team["revision"])

    def test_busy_and_atomic_rollback(self):
        a, team = self.team()
        b = self.bot("Second", section="Research")
        with patch.object(teams, "busy", return_value=True), self.assertRaises(HTTPException):
            teams.rename(team["id"], "Blocked")
        original = agent_service.mutate_bot
        def fail_second(ident, change):
            if ident == b["id"]:
                raise OSError("disk full")
            return original(ident, change)
        with patch.object(agent_service, "mutate_bot", side_effect=fail_second), self.assertRaises(OSError):
            teams.rename(team["id"], "Fail")
        self.assertEqual(a["section"], "Research")
        self.assertEqual(teams.get(team["id"])["name"], "Research")

    def test_chief_membership_movement_and_delete(self):
        a, team = self.team()
        b = self.bot("Second", section="Research")
        teams.set_chief(team["id"], a["id"], user="local")
        teams.set_chief(team["id"], b["id"], user="local")
        self.assertEqual(teams.get(team["id"])["chief_bot_id"], b["id"])
        agent_service.update(b["id"], section="Other")
        self.assertIsNone(teams.get(team["id"])["chief_bot_id"])
        teams.set_chief(team["id"], a["id"])
        teams.deleted(a["id"])
        self.assertIsNone(teams.get(team["id"])["chief_bot_id"])

    def test_instructions_hash_bytes_and_prune(self):
        a, team = self.team()
        original = teams.instructions(team["id"])
        saved = teams.put_instructions(team["id"], "Use sources", original["hash"])
        with self.assertRaises(HTTPException):
            teams.put_instructions(team["id"], "Changed", original["hash"])
        with self.assertRaises(HTTPException):
            teams.put_instructions(team["id"], "é" * 12001, saved["hash"])
        agent_service.update(a["id"], section="")
        teams.prune()
        self.assertEqual(teams.get(team["id"])["id"], team["id"])
        teams.put_instructions(team["id"], "", saved["hash"])
        teams.prune()
        with self.assertRaises(HTTPException):
            teams.get(team["id"])

    def test_corruption_blocks_and_owner_routes(self):
        _, team = self.team()
        self.assertEqual(web.get("/api/bot-departments").status_code, 200)
        self.assertEqual(web.post("/api/bot-departments", json={"name": "Extra", "owner": "foreign"}).status_code, 422)
        with self.assertRaises(HTTPException):
            teams.get(team["id"], "foreign")
        teams.registry_path().write_text("{broken", encoding="utf-8")
        self.assertEqual(web.post("/api/bot-departments", json={"name": "Extra"}).status_code, 503)
        self.assertEqual(teams.registry_path().read_text(), "{broken")

    def test_audience_and_map(self):
        a, team = self.team()
        self.assertEqual(bot_audience.audience("team", team["id"], owner="local"), [a["id"]])
        foreign = self.bot("Foreign")
        foreign["owner_user"] = "other"
        mapped = web.get("/api/bot-team/map").json()
        self.assertEqual([b["id"] for b in mapped["members"]], [a["id"]])


if __name__ == "__main__":
    unittest.main()
