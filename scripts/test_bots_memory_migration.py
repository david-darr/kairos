"""Bots Phase 2 unit U1: migrating the old memory files into the notebook.

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, section 3.1 (migration) and section 9 (Windows paths).
Throwaway data folder, no models. Run: python scripts/test_bots_memory_migration.py
"""
import base64
import hashlib
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-migration-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import bot_memory, bot_memory_journal as journal, bot_memory_store as store  # noqa: E402
from services.agent_service import agent_service, identity_block  # noqa: E402

TODAY = datetime.now().date()


class Crash(BaseException):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class MigrationCase(unittest.TestCase):
    def setUp(self):
        self.bot = agent_service.create("Scout", role="Watches job postings", soul="Be brief.")
        self.id = self.bot["id"]
        self.addCleanup(lambda: agent_service.get(self.id) and agent_service.delete(self.id))
        # Put the bot back in its pre-notebook state: no workspace, no state, old files where the old code kept them.
        bot_memory.remove_bot(self.id)
        self.legacy = Path(_DATA.name) / "agents" / self.id
        self.legacy.mkdir(parents=True, exist_ok=True)

    def write_legacy(self, name, data):
        target = self.legacy / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data if isinstance(data, bytes) else data.encode("utf-8"))
        return target

    def migrated(self):
        bot_memory.reset_caches()
        bot_memory.ensure_notebook(self.id)
        return bot_memory.migration_state(self.id)

    def new(self, path):
        return store.read_bytes(self.id, path)


class CopyTests(MigrationCase):
    def test_index_topics_and_archives_are_copied_byte_for_byte_and_the_originals_stay(self):
        index = b"# Scout's memory\r\n\r\n## Preferences\r\n- 2026-10-01: remote roles\r\n\r\n## Notes\r\nHandwritten note \xc3\xa9\r\n"
        topic = b"Description: Interview process\n## Notes\n- 2026-09-01 (until 2999-01-01): panel on Fridays\n"
        archive = b"\n## Archived 2026-01-01\n\n### Notes\n- 2020-01-01: old\n"
        topic_archive = b"\n## Archived 2026-02-02\n\n### Notes\n- 2019-01-01: older topic note\n"
        self.write_legacy("memory.md", index)
        self.write_legacy("memory/hiring.md", topic)
        self.write_legacy("memory-archive.md", archive)
        self.write_legacy("memory-hiring-archive.md", topic_archive)
        soul = self.write_legacy("SOUL.md", "Be brief.")
        state = self.migrated()
        self.assertEqual(state["state"], "complete")
        self.assertEqual(self.new("MEMORY.md"), index, "line endings and bytes are preserved")
        self.assertEqual(self.new("memory/hiring.md"), topic)
        merged = self.new("memory/archive.md")
        self.assertTrue(merged.startswith(archive))
        self.assertIn(topic_archive, merged)
        self.assertIn(b"## Archived topic notes: hiring", merged)
        self.assertEqual(state["sources"]["memory.md"], {"sha256": digest(index), "dest": "MEMORY.md"})
        self.assertEqual(state["sources"]["memory/hiring.md"]["sha256"], digest(topic))
        self.assertEqual(state["sources"]["memory-archive.md, memory-hiring-archive.md"]["dest"], "memory/archive.md")
        self.assertTrue((self.legacy / "memory.md").exists() and (self.legacy / "memory/hiring.md").exists(), "kept as backups")
        self.assertEqual(soul.read_text(encoding="utf-8"), "Be brief.", "the soul is untouched and stays where it was")
        self.assertEqual(agent_service.topic_index(self.id), [("hiring", "Interview process")])
        self.assertEqual(agent_service.read_memory(self.id), index.decode("utf-8").replace("\r\n", "\n"))

    def test_it_runs_once_and_a_later_change_to_the_old_files_is_not_copied_again(self):
        self.write_legacy("memory.md", "## Notes\n- 2026-10-01: first\n")
        self.migrated()
        (self.legacy / "memory.md").write_text("changed in the backup\n", encoding="utf-8")
        agent_service.remember(self.id, "Notes", "a new note")
        self.migrated()
        self.assertNotIn("changed in the backup", agent_service.read_memory(self.id))
        self.assertIn("a new note", agent_service.read_memory(self.id))
        self.assertIn("first", agent_service.read_memory(self.id))

    def test_a_bot_with_no_old_files_completes_with_nothing_to_copy(self):
        for child in list(self.legacy.glob("memory*")):
            child.unlink()
        state = self.migrated()
        self.assertEqual((state["state"], state["sources"]), ("complete", {}))
        self.assertEqual(agent_service.read_memory(self.id), "")

    def test_a_new_bot_never_has_old_style_files(self):
        fresh = agent_service.create("Brand New", role="Does things")
        self.addCleanup(lambda: agent_service.get(fresh["id"]) and agent_service.delete(fresh["id"]))
        self.assertTrue((store.workspace(fresh["id"]) / "MEMORY.md").exists())
        self.assertFalse((Path(_DATA.name) / "agents" / fresh["id"] / "memory.md").exists())
        self.assertIn("Brand New's notes", agent_service.read_memory(fresh["id"]))
        self.assertEqual(bot_memory.migration_state(fresh["id"])["state"], "complete")

    def test_a_legacy_topic_named_like_a_fixed_file_is_renamed_not_lost(self):
        self.write_legacy("memory/archive.md", "Description: my own topic\nbody\n")
        self.write_legacy("memory/log.md", "log topic\n")
        self.migrated()
        self.assertEqual(self.new("memory/archive_topic.md"), b"Description: my own topic\nbody\n")
        self.assertEqual(self.new("memory/log_topic.md"), b"log topic\n")
        self.assertIsNone(self.new("memory/archive.md"))

    def test_a_different_file_already_in_the_notebook_is_kept(self):
        self.write_legacy("memory.md", "old index\n")
        store.write_bytes(self.id, "MEMORY.md", b"someone already wrote this\n")
        state = self.migrated()
        self.assertEqual(self.new("MEMORY.md"), b"someone already wrote this\n")
        self.assertEqual(state["kept_existing"], ["MEMORY.md"])
        self.assertTrue((self.legacy / "memory.md").exists())


class LegacySemanticsTests(MigrationCase):
    def test_legacy_expiry_still_hides_and_tidies_after_migration(self):
        self.write_legacy("memory.md", "## Notes\n- 2020-01-01 (until 2021-01-01): expired contract rate\n"
                                         "- 2020-01-02 (until 2999-01-01): still true\n"
                                         f"- 2020-01-03 (until {TODAY.isoformat()}): ends today\n- 2022-01-01: newest\n")
        self.migrated()
        block = identity_block(agent_service.get(self.id), agent_service.read_memory(self.id), chat=True)
        self.assertIn("still true", block)
        self.assertIn("newest", block)
        self.assertNotIn("expired contract rate", block)
        self.assertNotIn("ends today", block)
        text = agent_service.read_memory(self.id)
        self.assertIn("expired contract rate", text, "hiding is not editing")
        agent_service.update(self.id, memory_upkeep=True)
        from core.session_manager import session_manager
        session = session_manager.create_session("Quiet")
        session_manager.set_agent(session["id"], self.id, "agent")
        session_manager.append_message(session["id"], "user", "remember this")
        self.addCleanup(session_manager.delete_session, session["id"])
        result = agent_service.upkeep_memory(self.id, now=datetime.now().timestamp() + 10_000)
        self.assertTrue(result)
        self.assertIn("expired contract rate", bot_memory.read_file(self.id, "memory/archive.md")["text"])
        self.assertNotIn("expired contract rate", agent_service.read_memory(self.id))
        self.assertIn("still true", agent_service.read_memory(self.id))

    def test_legacy_lines_and_new_lines_live_in_one_document(self):
        self.write_legacy("memory.md", "## Preferences\n- 2026-10-01: remote roles\n")
        self.migrated()
        agent_service.remember(self.id, "Preferences", "short replies", until="2999-01-01")
        text = agent_service.read_memory(self.id)
        self.assertTrue(text.startswith("## Preferences\n- 2026-10-01: remote roles\n"))
        self.assertIn(f"- {TODAY.isoformat()} · from agent · short replies · until 2999-01-01\n", text)

    def test_the_soul_path_does_not_move_with_the_memory(self):
        self.write_legacy("SOUL.md", "Be brief.")
        before = agent_service._soul_path(self.id)
        self.migrated()
        self.assertEqual(agent_service._soul_path(self.id), before)
        self.assertEqual(agent_service.read_soul(self.id)["in_sync"], True)
        agent_service.update(self.id, soul="Be warm.")
        self.assertEqual(Path(before).read_text(encoding="utf-8"), "Be warm.")


class InterruptedTests(MigrationCase):
    def test_a_crash_between_files_resumes_without_copying_twice_or_losing_anything(self):
        index, topic_a, topic_b = b"## Notes\n- 2026-10-01: a\n", b"topic a\n", b"topic b\n"
        self.write_legacy("memory.md", index)
        self.write_legacy("memory/a.md", topic_a)
        self.write_legacy("memory/b.md", topic_b)
        real = store.write_bytes
        calls = []

        def die(bot_id, path, data):
            calls.append(path)
            if len(calls) == 2:
                raise Crash()
            return real(bot_id, path, data)

        bot_memory.reset_caches()
        with patch.object(store, "write_bytes", side_effect=die):
            with self.assertRaises(Crash):
                bot_memory.ensure_notebook(self.id)
        self.assertEqual(bot_memory.migration_state(self.id)["state"], "in-progress")
        self.assertEqual(self.new("MEMORY.md"), index)
        self.assertIsNone(self.new("memory/b.md"))
        written = []
        with patch.object(store, "write_bytes", side_effect=lambda b, p, d: (written.append(p), real(b, p, d))[1]):
            state = self.migrated()
        self.assertEqual(state["state"], "complete")
        self.assertNotIn("MEMORY.md", written, "a file that already matched is not written again")
        self.assertEqual((self.new("memory/a.md"), self.new("memory/b.md")), (topic_a, topic_b))

    def test_the_completion_marker_waits_for_every_destination_to_verify(self):
        self.write_legacy("memory.md", b"## Notes\n- 2026-10-01: a\n")
        real = store.read_bytes

        def wrong_after_write(bot_id, path):
            data = real(bot_id, path)
            return data + b"corrupted" if path == "MEMORY.md" and data is not None else data

        bot_memory.reset_caches()
        with patch.object(store, "read_bytes", side_effect=wrong_after_write):
            with self.assertRaises(store.NotebookError):
                bot_memory.ensure_notebook(self.id)
        self.assertNotEqual(bot_memory.migration_state(self.id)["state"], "complete")
        self.assertEqual(self.migrated()["state"], "complete")

    def test_a_pass_the_old_tidy_left_half_done_is_rolled_back_before_the_copy(self):
        before_index = b"## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n"
        after_index = b"## Notes\n- 2022-01-01: newest\n"
        archive_after = b"\n## Archived\n- expired\n"
        self.write_legacy("memory.md", after_index)       # the pass had replaced the index ...
        self.write_legacy("memory-archive.md", archive_after)   # ... and written the archive, then the process died
        journal_file = {"entries": [{"id": "p1", "status": "pending", "files": [
            {"name": "memory.md", "before": base64.b64encode(before_index).decode(), "after": base64.b64encode(after_index).decode()},
            {"name": "memory-archive.md", "before": None, "after": base64.b64encode(archive_after).decode()}]}], "checked": {}}
        self.write_legacy("memory-upkeep.json", json.dumps(journal_file))
        self.migrated()
        self.assertEqual(self.new("MEMORY.md"), before_index, "rolled back, as the old recovery did")
        self.assertIsNone(self.new("memory/archive.md"))
        self.assertTrue((self.legacy / "memory-upkeep.json").exists(), "the old journal stays as a backup")

    def test_one_bad_bot_does_not_stop_the_others(self):
        other = agent_service.create("Other")
        self.addCleanup(lambda: agent_service.get(other["id"]) and agent_service.delete(other["id"]))
        bot_memory.remove_bot(other["id"])
        (Path(_DATA.name) / "agents" / other["id"]).mkdir(parents=True, exist_ok=True)
        (Path(_DATA.name) / "agents" / other["id"] / "memory.md").write_bytes(b"other's notes\n")
        bot_memory.reset_caches()
        real = bot_memory._migrate

        def migrate(bot_id):
            if bot_id == self.id:
                raise RuntimeError("bad folder")
            return real(bot_id)

        with patch.object(bot_memory, "_migrate", side_effect=migrate), self.assertLogs("services.bot_memory", level="ERROR"):
            bot_memory.migrate_all([self.id, other["id"]])
        self.assertEqual(bot_memory.migration_state(other["id"])["state"], "complete")
        self.assertEqual(store.read_bytes(other["id"], "MEMORY.md"), b"other's notes\n")


class DeletionTests(MigrationCase):
    def test_deleting_a_bot_removes_the_old_files_too(self):
        self.write_legacy("memory.md", "x\n")
        self.write_legacy("memory/a.md", "y\n")
        self.write_legacy("memory-archive.md", "z\n")
        self.migrated()
        agent_service.delete(self.id)
        self.assertFalse(self.legacy.exists())
        self.assertFalse(store.workspace(self.id).exists())


if __name__ == "__main__":
    unittest.main()
