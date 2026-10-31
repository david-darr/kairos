"""Teams and rooms in bot packages (services/bot_package_sections.py) against real stores and isolated data."""
import os
from pathlib import Path
import sys
import unittest

from test_data_support import TestDataDirectory
ENV = TestDataDirectory("kairos-package-sections-")
os.environ["JARVIS_DATA_DIR"] = ENV.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(ENV.name) / "vault")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import bot_rooms_store
from services import bot_package as pkg, bot_package_sections as sections, bot_departments, bot_rooms
from services.agent_service import agent_service


class PackageSectionTests(unittest.TestCase):
    def setUp(self):
        pkg.register_section("departments", sections.export_departments, sections.import_departments)
        pkg.register_section("rooms", sections.export_rooms, sections.import_rooms)
        self.ada = agent_service.create("Ada", endpoint_id=None)
        self.bo = agent_service.create("Bo", endpoint_id=None)
        self.cy = agent_service.create("Cy", endpoint_id=None)
        self.owner = bot_departments.owner(agent_service.get(self.ada["id"]))
        team = bot_departments.create("Research", [self.ada["id"], self.bo["id"]], self.owner)
        bot_departments.put_instructions(team["id"], "Cite every source.", bot_departments.instructions(team["id"], self.owner)["hash"], self.owner)
        bot_departments.create("Elsewhere", [self.cy["id"]], self.owner)
        self.room = bot_rooms.create(self.owner, "Launch", bot_ids=[self.ada["id"], self.bo["id"], self.cy["id"]], context="Q4",
                                     description="Ship it", bulletin="Short answers.", turn_timeout_minutes=7, setup_done=True,
                                     default_responder={"kind": "member", "bot_id": self.bo["id"]})
        bot_rooms.create(self.owner, "Unrelated", bot_ids=[self.cy["id"]], setup_done=True)

    def tearDown(self):
        for room in bot_rooms.list_rooms(self.owner, include_archived=True):
            bot_rooms.delete(self.owner, room["id"])
        for team in bot_departments.list(self.owner):
            bot_departments.delete(team["id"], self.owner)
        for ident in list(agent_service._agents):
            agent_service.delete(ident)

    def export(self):
        return pkg.export([self.ada["id"], self.bo["id"]], {"sections": ["departments", "rooms"]})

    def install(self, value):
        token = pkg.inspect(pkg.canonical(value))["token"]
        return pkg.import_(token)

    def test_export_carries_the_teams_and_rooms_of_the_chosen_bots_by_package_key(self):
        value = self.export()
        self.assertEqual(value["sections"]["departments"], {"teams": [
            {"name": "Research", "members": ["bot-1", "bot-2"], "chief": None, "instructions": "Cite every source."}]},
            "a team with none of the chosen bots stays out")
        rooms = value["sections"]["rooms"]["rooms"]
        self.assertEqual(len(rooms), 1, "a room with none of the chosen bots stays out")
        self.assertEqual(rooms[0], {"name": "Launch", "context": "Q4", "description": "Ship it", "bulletin": "Short answers.",
                                    "default_responder": {"kind": "member", "bot": "bot-2"}, "turn_timeout_minutes": 7,
                                    "members": ["bot-1", "bot-2"]}, "only the chosen bots come along; no ids, messages or folder")
        self.assertNotIn(self.ada["id"], str(value["sections"]), "bots are named by package key, never by id")
        pkg.normalize(value)  # the package still seals and validates

    def test_import_makes_new_teams_and_rooms_for_the_new_bots(self):
        result = self.install(self.export())
        new = {row["key"]: row["id"] for row in result["created"]}
        team = next(t for t in bot_departments.list(self.owner) if t["name"] == "Research 2")
        self.assertEqual(sorted(b["id"] for b in bot_departments.members(team["id"], self.owner)), sorted(new.values()),
                         "the new team holds the new bots, under a free name")
        self.assertEqual(bot_departments.instructions(team["id"], self.owner)["text"], "Cite every source.")
        room = next(r for r in bot_rooms.list_rooms(self.owner) if r["name"] == "Launch 2")
        self.assertEqual(sorted(m["bot_id"] for m in room["members"]), sorted(new.values()))
        self.assertEqual(room["default_responder"], {"kind": "member", "bot_id": new["bot-2"]})
        self.assertEqual((room["bulletin"], room["turn_timeout_minutes"], room["setup_state"]), ("Short answers.", 7, "done"))
        original = next(t for t in bot_departments.list(self.owner) if t["name"] == "Research")
        self.assertEqual(sorted(b["id"] for b in bot_departments.members(original["id"], self.owner)), sorted([self.ada["id"], self.bo["id"]]),
                         "the original team is untouched")

    def test_a_bad_section_rolls_back_everything_the_import_made(self):
        value = self.export()
        value["sections"]["rooms"]["rooms"][0]["default_responder"] = {"kind": "nobody"}
        value["manifest"]["sha256"] = pkg.digest(value)
        bots_before, teams_before = set(agent_service._agents), {t["id"] for t in bot_departments.list(self.owner)}
        rooms_before = {r["id"] for r in bot_rooms.list_rooms(self.owner, include_archived=True)}
        with self.assertRaises(Exception):
            self.install(value)
        self.assertEqual(set(agent_service._agents), bots_before, "the imported bots are removed")
        self.assertEqual({t["id"] for t in bot_departments.list(self.owner)}, teams_before, "the imported team is removed")
        self.assertEqual({r["id"] for r in bot_rooms.list_rooms(self.owner, include_archived=True)}, rooms_before)

    def test_section_data_is_checked_on_import(self):
        for bad in ({"teams": "Research"}, {"teams": [{"name": "", "members": []}]}, {"teams": [{"name": "X", "members": ["../etc"]}]},
                    {"teams": [{"name": "X", "members": [], "chief": 5}]}):
            with self.assertRaises(Exception):
                sections.import_departments(bad, {})
        for bad in ({"rooms": [{"name": "R", "members": [], "turn_timeout_minutes": "5"}]}, {"rooms": [None]}, {"rooms": [{"name": "R", "default_responder": "auto"}]}):
            with self.assertRaises(Exception):
                sections.import_rooms(bad, {})


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        bot_rooms_store.close()
        ENV.cleanup()
