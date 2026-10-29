import unittest
from unittest.mock import patch
from test_bots_departments import TeamsCase, teams, HTTPException
from services import bot_team_memory as memory


class MemoryTests(TeamsCase):
    def add(self, team, **fields):
        return memory.propose(team["id"], {"kind": "term", "name": "Project", "detail": "A fact", **fields})

    def test_accept_stale_history_restore_and_undo(self):
        _, team = self.team()
        e = self.add(team)
        accepted = memory.action(team["id"], e["id"], "accept", e["revision"])
        with self.assertRaises(HTTPException):
            memory.action(team["id"], e["id"], "accept", e["revision"])
        undone = memory.action(team["id"], e["id"], "undo", accepted["revision"])
        self.assertEqual(undone["status"], "proposed")
        changed = memory.edit(team["id"], e["id"], {"detail": "Updated"}, undone["revision"])
        restored = memory.action(team["id"], e["id"], "restore", changed["revision"], restore_revision=e["revision"])
        self.assertEqual(restored["detail"], "A fact")
        for n in range(55):
            restored = memory.edit(team["id"], e["id"], {"detail": str(n)}, restored["revision"])
        self.assertEqual(len(restored["history"]), 50)

    def test_limits_prompt_order_bytes_and_fencing(self):
        _, team = self.team()
        for fields in ({"name": "x" * 121}, {"detail": "x" * 601}, {"aliases": ["a"] * 9}, {"kind": "other"}):
            with self.assertRaises(HTTPException):
                self.add(team, **fields)
        for n in range(12):
            e = self.add(team, name=f"Fact {n}", detail="é" * 590, pinned=n == 0)
            memory.action(team["id"], e["id"], "accept", e["revision"])
        block = memory.prompt(team["id"])
        self.assertLessEqual(len(block.encode()), 6000)
        self.assertIn("UNTRUSTED-", block)
        self.assertIn("Loaded 4 of 12", block)
        self.assertLess(block.index("Fact 0"), block.index("Fact 11"))
        self.assertEqual(len(memory.search(team["id"], "Fact")), 12)

    def test_corrupt_memory_or_journal_blocks_writes(self):
        _, team = self.team()
        e = self.add(team)
        memory._journal_path(team["id"]).write_text("broken", encoding="utf-8")
        with self.assertRaises(HTTPException):
            memory.action(team["id"], e["id"], "accept", e["revision"])
        memory._path(team["id"]).write_text("[]", encoding="utf-8")
        with self.assertRaises(HTTPException):
            self.add(team)

    def test_context_includes_team_instructions_and_chief_without_identity_edits(self):
        bot, team = self.team()
        teams.set_chief(team["id"], bot["id"])
        original = teams.instructions(team["id"])
        teams.put_instructions(team["id"], "Prefer primary sources", original["hash"])
        e = self.add(team)
        memory.action(team["id"], e["id"], "accept", e["revision"])
        block = "\n".join(teams.context_blocks(bot["id"]))
        self.assertIn("never tool authorization", block)
        self.assertIn("Chief of Staff", block)
        self.assertIn("Team memory", block)


if __name__ == "__main__":
    unittest.main()
