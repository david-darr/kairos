"""Bots redesign, Phase 0 unit U1: the load-time migration of agents.json (2026-10-28).

Spec: Kairos Projects/Agents Redesign/phase-0-design.md, section 2.3. Old-
format files go through AgentService() against a throwaway folder: nothing is
lost but the documented `instructions` merge, a second run changes and writes
nothing, and the .pre-bots copy is made once.
Run: python scripts/test_bots_migration.py
"""
import copy
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-migration-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import agent_service as agents_module, bot_record  # noqa: E402
from services.agent_service import AgentService, identity_block  # noqa: E402

LEGACY_COLOR, V2_AVATAR = "#b3a7f5", {"form": "pill", "color": "#FA70AB", "finish": "matte", "face": "smile",
                                      "accessory": "glasses"}
IDS = {name: f"{index:x}" * 10 for index, name in enumerate(("legacy", "v2", "only", "equal", "differ", "empty", "spaces"), 1)}


def old_record(name, **extra):
    return {"id": IDS[name], "name": name.title(), "role": f"{name} job", "created_at": 1000.0 + len(IDS[name]),
            "enabled": True, "daily_run_cap": 12, "deliver_to_channel": None, "integration_ids": None,
            "keep_signed_in": False, "memory_upkeep": False, "peers": [], "revision": 3, "blurb": "", **extra}


def old_file():
    return {
        IDS["legacy"]: old_record("legacy", color=LEGACY_COLOR, instructions="Legacy rules."),
        IDS["v2"]: old_record("v2", color="#d9b260", avatar=copy.deepcopy(V2_AVATAR), instructions="V2 rules."),
        IDS["only"]: old_record("only", color="#d9b260", instructions="Only instructions."),
        IDS["equal"]: old_record("equal", color="#d9b260", soul="Same text.", instructions="Same text."),
        IDS["differ"]: old_record("differ", color="#d9b260", soul="The soul it was given.", instructions="Older, different text."),
        IDS["empty"]: old_record("empty", color="#d9b260", instructions=""),
        IDS["spaces"]: old_record("spaces", color="#d9b260", soul="Spaced.", instructions="  Spaced.\n"),
    }


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="run-", dir=_DATA.name))
        self.file = self.root / "agents.json"
        for name, value in (("AGENTS_FILE", str(self.file)), ("AGENTS_DIR", str(self.root / "agents")),
                            ("INBOX_FILE", str(self.root / "agents" / "inbox.json"))):
            patcher = patch.object(agents_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.original = old_file()
        self.file.write_text(json.dumps(self.original, indent=2), encoding="utf-8")
        self.original_bytes = self.file.read_bytes()

    def load(self):
        return AgentService()

    def stored(self):
        return json.loads(self.file.read_text(encoding="utf-8"))

    def soul_file(self, name):
        return self.root / "agents" / IDS[name] / "SOUL.md"

    def test_nothing_is_lost_except_the_documented_merge(self):
        service = self.load()
        migrated = self.stored()
        self.assertEqual(set(migrated), set(self.original))
        for agent_id, before in self.original.items():
            after = migrated[agent_id]
            lost = set(before) - set(after) - {"instructions"}
            self.assertEqual(lost, set(), (before["name"], lost))
            for key in set(before) - {"instructions", "color", "avatar", "soul"}:
                self.assertEqual(after[key], before[key], (before["name"], key))
            for key, value in bot_record.new_defaults().items():
                self.assertEqual(after[key], value, (before["name"], key))
            self.assertNotIn("instructions", after)
            self.assertEqual(after["avatar"]["version"], 3)
        self.assertEqual(service.get(IDS["legacy"])["id"], IDS["legacy"])

    def test_legacy_colours_and_the_v2_face_still_migrate(self):
        self.load()
        migrated = self.stored()
        self.assertEqual(migrated[IDS["legacy"]]["color"], agents_module.COLORS[0])
        self.assertEqual(migrated[IDS["v2"]]["avatar_legacy"], V2_AVATAR, "the old face is kept beside the new one")
        self.assertEqual(migrated[IDS["v2"]]["avatar"]["acc"], "spectacles")
        self.assertEqual(migrated[IDS["v2"]]["avatar"]["character"], "ajar")
        self.assertEqual(migrated[IDS["v2"]]["color"], migrated[IDS["v2"]]["avatar"]["color"].lower())

    def test_standing_instructions_end_up_in_one_field(self):
        service = self.load()
        data = self.stored()
        # Instructions only: they become the soul and SOUL.md mirrors them.
        self.assertEqual(data[IDS["only"]]["soul"], "Only instructions.")
        self.assertEqual(self.soul_file("only").read_text(encoding="utf-8"), "Only instructions.")
        self.assertTrue(service.read_soul(IDS["only"])["in_sync"])
        self.assertEqual(data[IDS["legacy"]]["soul"], "Legacy rules.")
        self.assertEqual(data[IDS["v2"]]["soul"], "V2 rules.")
        # Equal: the duplicate is dropped.
        self.assertEqual(data[IDS["equal"]]["soul"], "Same text.")
        self.assertNotIn("instructions_legacy", data[IDS["equal"]])
        self.assertNotIn("instructions_legacy", data[IDS["spaces"]], "text equal but for whitespace is the same text")
        self.assertEqual(data[IDS["spaces"]]["soul"], "Spaced.")
        # Differing: the soul the model has been getting stays; the older text is kept, never injected.
        self.assertEqual(data[IDS["differ"]]["soul"], "The soul it was given.")
        self.assertEqual(data[IDS["differ"]]["instructions_legacy"], "Older, different text.")
        self.assertNotIn("Older, different text.", identity_block(data[IDS["differ"]], ""))
        # Both empty: just the key goes.
        self.assertNotIn("soul", data[IDS["empty"]])
        self.assertNotIn("instructions_legacy", data[IDS["empty"]])

    def test_the_prompt_every_bot_gets_is_unchanged_by_the_merge(self):
        self.load()
        migrated = self.stored()
        for agent_id, before in self.original.items():
            for options in ({}, {"team": True}):
                self.assertEqual(identity_block(migrated[agent_id], "", **options),
                                 identity_block(before, "", **options), before["name"])

    def test_a_second_run_changes_and_writes_nothing(self):
        self.load()
        first = self.file.read_bytes()
        with patch.object(agents_module, "write_json_atomic") as write:
            with patch.object(AgentService, "_write_soul_file") as mirror:
                again = self.load()
        write.assert_not_called()
        mirror.assert_not_called()
        self.assertEqual(self.file.read_bytes(), first)
        self.assertFalse(bot_record.pending(again._agents))
        third = self.load()
        self.assertEqual(self.file.read_bytes(), first)
        self.assertEqual(third._agents, again._agents)

    def test_the_whole_load_is_one_write(self):
        with patch.object(agents_module, "write_json_atomic") as write:
            self.load()
        self.assertEqual(write.call_count, 1, "colours, mascot and Bots upgrade share one write")

    def test_the_pre_bots_copy_is_made_once_before_the_first_write(self):
        backup = Path(str(self.file) + bot_record.BACKUP_SUFFIX)
        self.assertFalse(backup.exists())
        self.load()
        self.assertTrue(backup.exists())
        self.assertEqual(backup.read_bytes(), self.original_bytes, "the copy is the file as it was")
        # An old-format record arrives later (an older build wrote it): it is
        # upgraded, and the first copy is left alone.
        data = self.stored()
        late = old_record("only")
        late["id"], late["name"], late["instructions"] = "ab" * 5, "Late", "Late rules."
        data[late["id"]] = late
        self.file.write_text(json.dumps(data), encoding="utf-8")
        self.load()
        self.assertEqual(backup.read_bytes(), self.original_bytes)
        self.assertEqual(self.stored()[late["id"]]["soul"], "Late rules.")

    def test_an_already_upgraded_file_is_neither_rewritten_nor_backed_up(self):
        self.load()
        backup = Path(str(self.file) + bot_record.BACKUP_SUFFIX)
        backup.unlink()
        before = self.file.read_bytes()
        with patch.object(agents_module, "write_json_atomic") as write:
            self.load()
        write.assert_not_called()
        self.assertFalse(backup.exists())
        self.assertEqual(self.file.read_bytes(), before)

    def test_a_missing_or_empty_file_is_fine(self):
        self.file.unlink()
        self.assertEqual(self.load().list_agents(), [])
        self.assertFalse(Path(str(self.file) + bot_record.BACKUP_SUFFIX).exists())
        self.file.write_text("{}", encoding="utf-8")
        self.assertEqual(self.load().list_agents(), [])

    def test_a_record_with_a_hand_edited_value_keeps_it(self):
        data = self.original
        data[IDS["only"]]["peers"] = [IDS["legacy"]]
        data[IDS["only"]]["integration_ids"] = ["tool-1"]
        data[IDS["only"]]["setup_receipts"] = [{"id": "r1"}]
        data[IDS["only"]]["place"] = "browser"  # a field a newer build set before this file was copied
        self.file.write_text(json.dumps(data), encoding="utf-8")
        self.load()
        kept = self.stored()[IDS["only"]]
        self.assertEqual((kept["peers"], kept["integration_ids"], kept["setup_receipts"], kept["place"]),
                         ([IDS["legacy"]], ["tool-1"], [{"id": "r1"}], "browser"))

    def test_a_returning_instructions_key_is_folded_again_without_losing_the_older_text(self):
        service = self.load()
        service._agents[IDS["differ"]]["instructions"] = "Typed in an older build."
        self.assertTrue(bot_record.upgrade(service._agents[IDS["differ"]]))
        record = service._agents[IDS["differ"]]
        self.assertEqual(record["soul"], "The soul it was given.")
        self.assertEqual(record["instructions_legacy"],
                         "Older, different text.\n\n---\n\nTyped in an older build.")
        self.assertFalse(bot_record.upgrade(record))

    def test_an_unmirrorable_id_does_not_stop_startup(self):
        data = {"not-hex": old_record("only", id="not-hex", instructions="Rules.")}
        self.file.write_text(json.dumps(data), encoding="utf-8")
        service = self.load()
        self.assertEqual(service.get("not-hex")["soul"], "Rules.")


if __name__ == "__main__":
    unittest.main()
