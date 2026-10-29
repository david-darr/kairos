"""Bots Phase 2 unit U1: the protected journal, outside-edit observation, guarded Undo and crash recovery.

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.2, 4.1 and 7 (U1, Later U1-B).
Throwaway data folder, no models. Run: python scripts/test_bots_memory_journal.py
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-journal-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import bot_memory, bot_memory_journal as journal, bot_memory_store as store  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

ABSENT = store.ABSENT
SECRET = "ghp_" + "A1b2C3d4E5" * 4          # 40 characters: a GitHub token shape the redactor knows


class Crash(BaseException):
    """Not an Exception: nothing in the process cleans up, as when the process dies."""


class JournalCase(unittest.TestCase):
    def setUp(self):
        self.bot = agent_service.create("Scout")
        self.id = self.bot["id"]
        self.addCleanup(lambda: agent_service.get(self.id) and agent_service.delete(self.id))

    def root(self) -> Path:
        return store.workspace(self.id)

    def put(self, path, text, **kw):
        current = bot_memory.read_file(self.id, path, missing_ok=True)
        return bot_memory.write_text(self.id, path, text, current["hash"], **{"actor": "person", "source": "test", **kw})

    def text(self, path):
        return bot_memory.read_file(self.id, path)["text"]

    def hash(self, path):
        return bot_memory.read_file(self.id, path, missing_ok=True)["hash"]

    def rows(self, limit=200):
        return journal.rows(self.id, limit)

    def state_text(self):
        """Everything under this bot's protected state, as one string."""
        out = []
        for path in store.state_dir(self.id).rglob("*"):
            if path.is_file():
                out.append(path.read_bytes().decode("utf-8", errors="replace"))
        return "\n".join(out)


class RowTests(JournalCase):
    def test_a_row_records_who_what_and_the_hashes(self):
        before = self.hash("MEMORY.md")
        result = self.put("MEMORY.md", "# Notes\n- one\n", source="memory editor", thread_id="t1", run_id="r1")
        row = self.rows()[0]
        self.assertEqual(result["row"]["id"], row["id"])
        for key, value in (("actor", "person"), ("source", "memory editor"), ("thread_id", "t1"), ("run_id", "r1"),
                           ("path", "MEMORY.md"), ("operation", "edit"), ("before_hash", before), ("revertible", True)):
            self.assertEqual(row[key], value, key)
        self.assertEqual(row["after_hash"], self.hash("MEMORY.md"))
        self.assertEqual(row["counts"]["files"], 1)
        self.assertGreaterEqual(row["counts"]["added"], 1)
        self.assertIn("+- one", row["diff"])
        self.assertIsInstance(row["time"], float)
        created = self.put("memory/new.md", "x\n")["row"]
        self.assertEqual((created["operation"], created["before_hash"]), ("create", ABSENT))
        gone = bot_memory.delete_file(self.id, "memory/new.md", self.hash("memory/new.md"), actor="person", source="t")["row"]
        self.assertEqual((gone["operation"], gone["after_hash"]), ("delete", ABSENT))
        self.assertIsNone(self.put("MEMORY.md", self.text("MEMORY.md"))["row"], "an unchanged save journals nothing")

    def test_the_journal_lives_outside_every_model_writable_root(self):
        self.put("MEMORY.md", "x\n")
        state = store.state_dir(self.id)
        self.assertEqual(state.parent.name, "bot-memory-state")
        self.assertNotIn(store.workspace(self.id), state.parents)
        self.assertTrue((state / "journal.ndjson").exists())
        self.assertNotIn("journal.ndjson", [p.name for p in self.root().rglob("*")])

    def test_the_diff_is_capped_at_8000_characters(self):
        self.put("MEMORY.md", "".join(f"line {i} {'x' * 40}\n" for i in range(2000)))
        row = self.rows()[0]
        self.assertLessEqual(len(row["diff"]), journal.DIFF_CAP)
        self.assertLessEqual(len(row["files"][0]["diff"]), journal.DIFF_CAP)
        self.assertGreater(row["counts"]["added"], 1000, "counts are not capped")

    def test_reads_look_at_500_rows_and_the_api_returns_200(self):
        for index in range(520):
            journal.append_row(self.id, {"id": f"row{index:04d}", "time": float(index), "files": [], "actor": "test"})
        self.assertEqual(len(journal.rows(self.id, 1000)), 200)
        self.assertEqual(journal.rows(self.id, 1000)[0]["id"], "row0519")
        self.assertEqual(len(journal._tail_rows(self.id)), 500)
        self.assertFalse(journal.has_row(self.id, "row0010"), "older than the last 500 rows")
        self.assertTrue(journal.has_row(self.id, "row0519"))

    def test_reads_inspect_at_most_the_last_8_mib(self):
        path = store.state_dir(self.id) / "journal.ndjson"
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({"id": "x" * 10, "pad": "p" * 8000}) + "\n"
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"id": "ancient"}) + "\n")
            for _ in range(1200):                      # about 9.6 MB
                handle.write(line.replace("x" * 10, f"{_:010d}"))
        self.assertGreater(path.stat().st_size, 8 * 1024 * 1024)
        ids = [row["id"] for row in journal._tail_rows(self.id)]
        self.assertNotIn("ancient", ids)
        self.assertEqual(ids[-1], f"{1199:010d}")
        self.assertLessEqual(len(ids), 500)

    def test_a_snapshot_is_kept_for_the_newest_changes_only(self):
        with patch.object(journal, "KEEP_SNAPSHOTS", 3):
            for number in range(6):
                self.put("MEMORY.md", f"version {number}\n")
        folders = [p for p in (store.state_dir(self.id) / "snapshots").iterdir()]
        self.assertLessEqual(len(folders), 3)

    def test_daily_log_lines_are_redacted_once_per_run(self):
        self.assertTrue(bot_memory.append_log(self.id, "2026-10-29", f"Captured two notes; token {SECRET} was seen", "run-1"))
        self.assertFalse(bot_memory.append_log(self.id, "2026-10-29", "again", "run-1"))
        self.assertTrue(bot_memory.append_log(self.id, "2026-10-29", "second run", "run-2"))
        text = self.text("memory/log/2026-10-29.md")
        self.assertEqual(text.count("[run run-1]"), 1)
        self.assertNotIn(SECRET, text)
        self.assertIn("***", text)
        self.assertIn("[run run-2]", text)
        with self.assertRaises(store.PathRefused):
            bot_memory.append_log(self.id, "yesterday", "x", "run-3")


class SecretTests(JournalCase):
    def test_a_secret_never_reaches_the_journal_or_undo_material(self):
        self.put("MEMORY.md", f"## Notes\n- key is {SECRET}\n")
        self.assertNotIn(SECRET, self.state_text(), "not in the diff, the shadow copy or anywhere in the protected state")
        first = self.rows()[0]
        self.assertTrue(first["revertible"], "its old version held no secret")
        self.assertIn("***", first["diff"])
        self.put("MEMORY.md", "## Notes\n- the key was removed\n")
        second = self.rows()[0]
        self.assertFalse(second["revertible"], "the old version held a secret, so no copy of it was kept")
        self.assertIsNone(second["files"][0]["snapshot"])
        self.assertNotIn(SECRET, self.state_text())
        self.assertNotIn(SECRET, json.dumps(self.rows()))
        with self.assertRaisesRegex(store.StaleState, "hidden"):
            bot_memory.revert(self.id, second["id"])
        self.assertEqual(self.text("MEMORY.md"), "## Notes\n- the key was removed\n")

    def test_password_assignments_are_masked_too(self):
        self.put("MEMORY.md", "## Notes\n- password = hunter2hunter2\n")
        self.assertNotIn("hunter2hunter2", self.state_text())
        self.assertNotIn("hunter2hunter2", json.dumps(self.rows()))

    def test_an_outside_edit_holding_a_secret_is_not_revertible(self):
        self.put("MEMORY.md", "clean\n")
        bot_memory.begin_turn(self.id)
        (self.root() / "MEMORY.md").write_text(f"has {SECRET}\n", encoding="utf-8")
        bot_memory.begin_turn(self.id)
        (self.root() / "MEMORY.md").write_text("clean again\n", encoding="utf-8")
        row = bot_memory.begin_turn(self.id)["observed"]
        rows = {r["id"]: r for r in self.rows()}
        self.assertFalse(rows[row]["revertible"])
        self.assertNotIn(SECRET, self.state_text())


class ObservationTests(JournalCase):
    def test_edits_outside_kairos_are_credited_to_the_person_at_the_start_of_a_turn(self):
        self.put("MEMORY.md", "## Notes\n- original\n")
        self.assertIsNone(bot_memory.begin_turn(self.id)["observed"], "nothing changed")
        (self.root() / "MEMORY.md").write_bytes(b"## Notes\r\n- original\r\n- typed in Obsidian\r\n")
        (self.root() / "memory").mkdir(exist_ok=True)
        (self.root() / "memory" / "ideas.md").write_text("a new topic\n", encoding="utf-8")
        turn = bot_memory.begin_turn(self.id, thread_id="t9", run_id="r9")
        row = next(r for r in self.rows() if r["id"] == turn["observed"])
        self.assertEqual((row["actor"], row["source"], row["thread_id"], row["operation"]), ("person", "edit outside Kairos", "t9", "external-edit"))
        self.assertEqual(sorted(f["path"] for f in row["files"]), ["MEMORY.md", "memory/ideas.md"])
        self.assertIn("typed in Obsidian", row["diff"])
        self.assertTrue(row["revertible"])
        self.assertIsNone(bot_memory.begin_turn(self.id)["observed"], "seen once, never credited twice")

    def test_the_models_own_file_edits_are_journaled_at_the_end_including_after_a_cancel(self):
        self.put("MEMORY.md", "## Notes\n- original\n")
        turn = bot_memory.begin_turn(self.id, thread_id="t1", run_id="r1")
        (self.root() / "MEMORY.md").write_text("## Notes\n- original\n- the model wrote this\n", encoding="utf-8")
        row = bot_memory.end_turn(self.id, thread_id="t1", run_id="r1", status="cancelled")
        self.assertEqual((row["actor"], row["thread_id"], row["run_id"]), ("bot", "t1", "r1"))
        self.assertIn("cancelled", row["source"])
        self.assertIn("the model wrote this", row["diff"])
        self.assertIsNone(bot_memory.end_turn(self.id), "nothing more to journal")
        # a failed turn that created and removed files
        turn = bot_memory.begin_turn(self.id)
        (self.root() / "memory").mkdir(exist_ok=True)
        (self.root() / "memory" / "scratch.md").write_text("temp\n", encoding="utf-8")
        failed = bot_memory.end_turn(self.id, status="failed")
        self.assertEqual([f["operation"] for f in failed["files"]], ["create"])
        self.assertIn("failed", failed["source"])

    def test_our_own_changes_during_a_turn_are_not_credited_to_anyone_else(self):
        turn = bot_memory.begin_turn(self.id)
        agent_service.remember(self.id, "Notes", "learned during the turn")
        self.assertIsNone(bot_memory.end_turn(self.id))
        self.assertEqual([r["actor"] for r in self.rows()][:1], ["bot"])
        self.assertEqual(len([r for r in self.rows() if r["operation"] == "external-edit"]), 0)

    def test_files_that_are_not_notebook_shapes_are_ignored(self):
        bot_memory.begin_turn(self.id)
        (self.root() / "notes.txt").write_text("stray\n", encoding="utf-8")
        (self.root() / "memory").mkdir(exist_ok=True)
        (self.root() / "memory" / "Bad Name.md").write_text("stray\n", encoding="utf-8")
        self.assertIsNone(bot_memory.end_turn(self.id))
        self.assertNotIn("notes.txt", store.list_files(self.id))

    def test_an_outside_edit_can_be_undone_while_untouched(self):
        self.put("MEMORY.md", "## Notes\n- original\n")
        bot_memory.begin_turn(self.id)
        (self.root() / "MEMORY.md").write_text("replaced by hand\n", encoding="utf-8")
        row = self.rows()[0] if bot_memory.begin_turn(self.id)["observed"] is None else None
        observed = bot_memory.begin_turn(self.id)
        self.assertIsNone(observed["observed"])
        entry = [r for r in self.rows() if r["operation"] == "external-edit"][0]
        bot_memory.revert(self.id, entry["id"])
        self.assertEqual(self.text("MEMORY.md"), "## Notes\n- original\n")
        self.assertEqual(row, None)


class UndoTests(JournalCase):
    def test_undo_restores_exact_bytes_and_only_while_the_files_match(self):
        self.put("MEMORY.md", "one\n")
        row = self.put("MEMORY.md", "two\n")["row"]
        (self.root() / "MEMORY.md").write_bytes(b"two\r\nplus a hand edit\r\n")
        with self.assertRaisesRegex(store.StaleState, "changed") as caught:
            bot_memory.revert(self.id, row["id"])
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual((self.root() / "MEMORY.md").read_bytes(), b"two\r\nplus a hand edit\r\n")
        (self.root() / "MEMORY.md").write_bytes(b"two\n")
        result = bot_memory.revert(self.id, row["id"])
        self.assertEqual((self.root() / "MEMORY.md").read_bytes(), b"one\n")
        self.assertEqual(result["row"]["operation"], "revert")
        self.assertEqual(result["row"]["reverts"], row["id"])
        reverted = {r["id"]: r for r in self.rows()}[row["id"]]
        self.assertEqual(reverted["reverted_by"], result["row"]["id"])
        with self.assertRaisesRegex(store.StaleState, "already undone"):
            bot_memory.revert(self.id, row["id"])
        with self.assertRaises(store.NotFound):
            bot_memory.revert(self.id, "nonesuch")

    def test_undoing_a_creation_removes_the_file_and_undoing_a_delete_brings_it_back(self):
        created = self.put("memory/topic.md", "body\n")["row"]
        bot_memory.revert(self.id, created["id"])
        self.assertFalse((self.root() / "memory" / "topic.md").exists())
        self.put("memory/topic.md", "body\n")
        gone = bot_memory.delete_file(self.id, "memory/topic.md", self.hash("memory/topic.md"), actor="person", source="t")["row"]
        bot_memory.revert(self.id, gone["id"])
        self.assertEqual(self.text("memory/topic.md"), "body\n")

    def test_multi_file_undo_is_atomic(self):
        agent_service.write_memory(self.id, "## Notes\n- 2000-01-01: old thing\n")
        result = bot_memory.apply_transaction(self.id, [
            {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "## Notes\n"},
            {"path": "memory/archive.md", "expected_hash": ABSENT, "content": "- 2000-01-01: old thing\n"}],
            actor="upkeep", source="tidy")
        row = result["row"]
        self.assertEqual(row["counts"]["files"], 2)
        (self.root() / "memory" / "archive.md").write_bytes(b"- 2000-01-01: old thing\nplus hand text\n")
        with self.assertRaises(store.StaleState):
            bot_memory.revert(self.id, row["id"])
        self.assertEqual(self.text("MEMORY.md"), "## Notes\n", "the index was not put back while the archive refused")
        (self.root() / "memory" / "archive.md").write_bytes(b"- 2000-01-01: old thing\n")
        bot_memory.revert(self.id, row["id"])
        self.assertIn("old thing", self.text("MEMORY.md"))
        self.assertFalse((self.root() / "memory" / "archive.md").exists())

    def test_a_transaction_that_cannot_fully_apply_changes_nothing_and_keeps_no_row(self):
        self.put("MEMORY.md", "one\n")
        before_rows = len(self.rows())
        with self.assertRaises(store.StaleState):
            bot_memory.apply_transaction(self.id, [
                {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "two\n"},
                {"path": "memory/a.md", "expected_hash": "0" * 64, "content": "x\n"}], actor="person", source="t")
        with self.assertRaises(store.CapacityError):
            bot_memory.apply_transaction(self.id, [
                {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "two\n"},
                {"path": "memory/a.md", "expected_hash": ABSENT, "content": "x" * (65 * 1024)}], actor="person", source="t")
        with self.assertRaises(store.NotebookError):
            bot_memory.apply_transaction(self.id, [
                {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "two\n"},
                {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "three\n"}], actor="person", source="t")
        self.assertEqual(self.text("MEMORY.md"), "one\n")
        self.assertEqual(len(self.rows()), before_rows)

    def test_an_error_the_process_survives_rolls_every_file_back(self):
        self.put("MEMORY.md", "one\n")
        real = store.write_bytes
        calls = []

        def second_write_fails(bot_id, path, data):
            calls.append(path)
            if len(calls) == 2:
                raise OSError("disk full")
            return real(bot_id, path, data)

        before_rows = len(self.rows())
        with patch.object(store, "write_bytes", side_effect=second_write_fails):
            with self.assertRaises(OSError):
                bot_memory.apply_transaction(self.id, [
                    {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "two\n"},
                    {"path": "memory/a.md", "expected_hash": ABSENT, "content": "x\n"}], actor="person", source="t")
        self.assertEqual(self.text("MEMORY.md"), "one\n")
        self.assertFalse((self.root() / "memory" / "a.md").exists())
        self.assertIsNone(journal.read_manifest(self.id))
        self.assertEqual(len(self.rows()), before_rows)


class RecoveryTests(JournalCase):
    def crash_at(self, call_number):
        """Run a two-file transaction that dies (BaseException) at the Nth file write; returns what it was doing."""
        real = store.write_bytes
        calls = []

        def die(bot_id, path, data):
            calls.append(path)
            if len(calls) == call_number:
                raise Crash()
            return real(bot_id, path, data)

        self.put("MEMORY.md", "one\n")
        self.rows_before = len(self.rows())
        with patch.object(store, "write_bytes", side_effect=die):
            with self.assertRaises(Crash):
                bot_memory.apply_transaction(self.id, [
                    {"path": "MEMORY.md", "expected_hash": self.hash("MEMORY.md"), "content": "two\n"},
                    {"path": "memory/a.md", "expected_hash": ABSENT, "content": "x\n"}], actor="person", source="t")
        self.assertIsNotNone(journal.read_manifest(self.id), "the pass was written ahead")
        bot_memory.reset_caches()   # a restart

    def test_a_crash_before_any_file_is_written_completes_on_the_next_access(self):
        self.crash_at(1)
        self.assertEqual(self.text("MEMORY.md"), "two\n")
        self.assertEqual(self.text("memory/a.md"), "x\n")
        self.assertEqual(len(self.rows()), self.rows_before + 1)
        self.assertIsNone(journal.read_manifest(self.id))

    def test_a_crash_between_files_completes_and_journals_exactly_once(self):
        self.crash_at(2)
        self.assertEqual((self.text("MEMORY.md"), self.text("memory/a.md")), ("two\n", "x\n"))
        bot_memory.reset_caches()
        bot_memory.ensure_notebook(self.id)
        self.assertEqual(len(self.rows()), self.rows_before + 1, "replay is safe")
        row = self.rows()[0]
        bot_memory.revert(self.id, row["id"])
        self.assertEqual(self.text("MEMORY.md"), "one\n")
        self.assertFalse((self.root() / "memory" / "a.md").exists())

    def test_a_crash_after_the_files_but_before_the_row_adds_the_row(self):
        real = journal.append_row

        def die(bot_id, row):
            raise Crash()

        self.put("MEMORY.md", "one\n")
        before = len(self.rows())
        with patch.object(journal, "append_row", side_effect=die):
            with self.assertRaises(Crash):
                self.put("MEMORY.md", "two\n")
        bot_memory.reset_caches()
        self.assertEqual(self.text("MEMORY.md"), "two\n")
        self.assertEqual(len(self.rows()), before + 1)
        self.assertEqual(self.rows()[0]["summary"], "Edited MEMORY.md")

    def test_a_crash_during_undo_finishes_the_undo(self):
        self.put("MEMORY.md", "one\n")
        row = self.put("MEMORY.md", "two\n")["row"]
        real = store.write_bytes

        def die(bot_id, path, data):
            raise Crash()

        with patch.object(store, "write_bytes", side_effect=die):
            with self.assertRaises(Crash):
                bot_memory.revert(self.id, row["id"])
        bot_memory.reset_caches()
        self.assertEqual(self.text("MEMORY.md"), "one\n")
        reverted = {r["id"]: r for r in self.rows()}[row["id"]]
        self.assertTrue(reverted["reverted_by"])

    def test_a_person_edit_during_the_outage_is_not_overwritten(self):
        self.crash_at(1)   # recovery already ran in crash_at's reset? no: only reset; the next access recovers
        # Rebuild the situation: a second crash, then a hand edit before anyone looks.
        bot_memory.remove_bot(self.id)
        self.put("MEMORY.md", "one\n")
        real = store.write_bytes

        def die(bot_id, path, data):
            raise Crash()

        with patch.object(store, "write_bytes", side_effect=die):
            with self.assertRaises(Crash):
                self.put("MEMORY.md", "two\n")
        (self.root() / "MEMORY.md").write_text("typed meanwhile\n", encoding="utf-8")
        bot_memory.reset_caches()
        self.assertEqual(self.text("MEMORY.md"), "typed meanwhile\n")
        self.assertFalse(self.rows()[0]["revertible"])
        self.assertEqual(self.rows()[0]["recovery_conflicts"], ["MEMORY.md"])

    def test_an_unreadable_manifest_is_cleared_not_fatal(self):
        self.put("MEMORY.md", "one\n")
        (store.state_dir(self.id) / "txn.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.text("MEMORY.md"), "one\n")
        self.assertIsNone(journal.read_manifest(self.id))


class ConcurrencyTests(JournalCase):
    def test_two_writers_with_the_same_hash_cannot_both_win(self):
        self.put("MEMORY.md", "base\n")
        seen = self.hash("MEMORY.md")
        outcomes = []
        gate = threading.Barrier(2)

        def write(text):
            gate.wait()
            try:
                bot_memory.write_text(self.id, "MEMORY.md", text, seen, actor="person", source="t")
                outcomes.append("ok")
            except store.StaleState:
                outcomes.append("stale")

        threads = [threading.Thread(target=write, args=(f"writer {n}\n",)) for n in range(2)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(sorted(outcomes), ["ok", "stale"])

    def test_many_threads_adding_notes_lose_none(self):
        gate = threading.Barrier(8)
        errors = []

        def add(number):
            gate.wait()
            try:
                agent_service.remember(self.id, "Notes", f"note number {number}")
            except Exception as error:   # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=add, args=(n,)) for n in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(errors, [])
        text = agent_service.read_memory(self.id)
        for number in range(8):
            self.assertIn(f"note number {number}", text)
        self.assertEqual(len([r for r in self.rows() if r["actor"] == "bot"]), 8)

    def test_a_lock_is_never_held_while_a_caller_waits_on_something_else(self):
        # begin_turn and end_turn return before the model runs, so another thread's write goes straight through.
        turn = bot_memory.begin_turn(self.id)
        done = threading.Event()
        threading.Thread(target=lambda: (agent_service.remember(self.id, "Notes", "during the model call"), done.set())).start()
        self.assertTrue(done.wait(5))
        bot_memory.end_turn(self.id)


class MigrationRecoveryOfStateTests(JournalCase):
    def test_remove_bot_clears_workspace_and_state_and_is_repeatable(self):
        self.put("MEMORY.md", "x\n")
        bot_memory.remove_bot(self.id)
        self.assertFalse(self.root().exists())
        self.assertFalse(store.state_dir(self.id).exists())
        bot_memory.remove_bot(self.id)
        self.assertEqual(self.text("MEMORY.md") if self.put("MEMORY.md", "again\n") else "", "again\n")


if __name__ == "__main__":
    unittest.main()
