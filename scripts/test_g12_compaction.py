"""A20 compaction checks (Part 2, group g12). Actual service compactor, scripted summariser, no model or network calls.
Run: .venv/Scripts/python.exe -B -X utf8 scripts/test_g12_compaction.py

Tests named test_BUG_* assert the behaviour a person would expect and FAIL on the current code (each is a reported
finding); every other test is a passing characterisation or guard.
"""
import asyncio
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

fixture = tempfile.TemporaryDirectory(prefix="kairos-g12-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from core import memory_tools
from core.session_manager import session_manager
from services import chat_service

ENDPOINT = {"id": "local", "name": "Local", "kind": "local", "model": "local-model", "num_ctx": 8192}
NOTICE_HEAD = "**Conversation compacted**"
TOOL_FACT = "the-vendor-badge-number-is-7731"


class Scripted:
    """Stands in for the detached summary brain; records every prompt."""
    prompts: list[str] = []

    async def connect(self): pass
    async def disconnect(self): pass

    async def run_turn(self, prompt):
        Scripted.prompts.append(prompt)
        return f"SUMMARY-{len(Scripted.prompts)}: goals and decisions so far."


class CompactionBase(unittest.TestCase):
    def setUp(self):
        Scripted.prompts = []
        chat_service._busy.clear()
        chat_service._brains.clear()
        self.sid = session_manager.create_session("g12")["id"]
        for p in (patch.object(chat_service, "_resolve_endpoint", return_value=ENDPOINT),
                  patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted())):
            p.start()
            self.addCleanup(p.stop)

    def fill(self, count, tool_fact_at=None):
        start = len(session_manager.get_session(self.sid)["messages"])
        for i in range(count):
            n = start + i
            role = "user" if n % 2 == 0 else "assistant"
            extra = {}
            if tool_fact_at == n:
                extra = {"tool_rounds": {"endpoint_id": "local", "messages": [
                    {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function",
                        "function": {"name": "read_vault_file", "arguments": '{"path":"vendors.md"}'}}]},
                    {"role": "tool", "tool_call_id": "c1", "content": f"Vendor sheet: {TOOL_FACT}"}]}}
            session_manager.append_message(self.sid, role, f"plain message {n}", extra=extra or None)

    def compact(self):
        return asyncio.run(chat_service.compact_session(self.sid))

    def effective(self):
        return session_manager.effective_messages(self.sid)


class CompactionAssemblyTests(CompactionBase):
    def test_the_fold_keeps_raw_storage_and_swaps_effective_history(self):
        self.fill(16)
        out = self.compact()
        self.assertEqual(out["compacted_through"], 10)
        stored = session_manager.get_session(self.sid)["messages"]
        self.assertEqual(len([m for m in stored if m.get("archived")]), 10, "raw messages stay, flagged")
        self.assertEqual(stored[0]["content"], "plain message 0")

    def test_BUG_summary_appears_once_in_effective_history(self):
        self.fill(16)
        self.compact()
        text = "\n".join(m["content"] for m in self.effective())
        self.assertEqual(text.count("SUMMARY-1"), 1,
                         "the summary is sent twice: once as the checkpoint, once as the stored 'Conversation compacted' notice")

    def test_BUG_the_notice_is_not_part_of_what_a_model_is_sent(self):
        self.fill(16)
        self.compact()
        notices = [m for m in self.effective() if m["content"].startswith(NOTICE_HEAD)]
        self.assertEqual(notices, [], "a display-only notice is resent to the model on every later turn")

    def test_BUG_immediate_repeat_compaction_is_refused_before_calling_the_model(self):
        self.fill(16)
        self.compact()
        calls = len(Scripted.prompts)
        with self.assertRaises(HTTPException) as caught:
            self.compact()
        self.assertEqual(caught.exception.status_code, 400)
        self.assertEqual(len(Scripted.prompts), calls, "a second summariser call was paid with nothing new said")

    def test_BUG_repeat_compaction_does_not_advance_the_boundary_without_new_conversation(self):
        self.fill(16)
        first = self.compact()["compacted_through"]
        try:
            second = self.compact()["compacted_through"]
        except HTTPException:
            return
        self.assertEqual(second, first, "boundary moved from %d to %d with no new conversation" % (first, second))

    def test_BUG_second_summariser_input_does_not_repeat_the_prior_summary(self):
        self.fill(16)
        self.compact()
        self.fill(8)  # genuinely new conversation (enough that the folded range now covers the first notice)
        self.compact()
        second = Scripted.prompts[1]
        self.assertEqual(second.count("SUMMARY-1"), 1,
                         "prior summary is in the header and again inside the folded notice message")

    def test_summary_growth_over_five_compactions_is_bounded_by_the_scripted_summariser(self):
        self.fill(16)
        sizes = []
        for _ in range(5):
            self.compact()
            sizes.append(sum(len(m["content"]) for m in self.effective()))
            self.fill(8)
        # With a fixed-size summary the effective history must not grow compaction over compaction.
        self.assertLess(max(sizes) - min(sizes), 400, f"effective size per compaction: {sizes}")

    def test_BUG_manual_compact_then_next_message_does_not_compact_again_on_a_stale_meter(self):
        """The meter is only rewritten by a finished turn, so a manual Compact leaves the old percent in place."""
        self.fill(16)
        session_manager.set_context_state(self.sid, {"percent": 92, "capacity_tokens": 8192, "used_tokens": 7500})
        self.compact()
        calls = len(Scripted.prompts)
        with patch("core.settings.get_setting", return_value=True):
            asyncio.run(chat_service._compact_if_nearly_full(self.sid))
        self.assertEqual(len(Scripted.prompts), calls,
                         "auto-compaction ran again straight after a manual compaction because the meter was stale")

    def test_BUG_compaction_resets_the_stale_context_meter(self):
        self.fill(16)
        session_manager.set_context_state(self.sid, {"percent": 92, "capacity_tokens": 8192, "used_tokens": 7500})
        self.compact()
        state = (session_manager.get_session(self.sid) or {}).get("context_state") or {}
        self.assertNotEqual(state.get("percent"), 92, "the header meter still shows the pre-compaction fill")


class ToolEvidenceTests(CompactionBase):
    def test_BUG_tool_round_only_fact_reaches_the_summariser(self):
        self.fill(16, tool_fact_at=3)
        self.compact()
        self.assertIn(TOOL_FACT, Scripted.prompts[0], "evidence only in saved tool_rounds never reaches the summariser")

    def test_BUG_tool_round_only_fact_is_found_by_archive_search(self):
        self.fill(16, tool_fact_at=3)
        self.compact()
        hits = memory_tools.search_this_chat_archive(self.sid, "vendor badge number")
        self.assertTrue(hits, "the archive search covers message text only, not tool results")

    def test_raw_storage_still_holds_the_tool_fact(self):
        self.fill(16, tool_fact_at=3)
        self.compact()
        raw = session_manager.get_session(self.sid)["messages"][3]
        self.assertIn(TOOL_FACT, str(raw["tool_rounds"]))

    def test_plain_text_fact_in_the_folded_region_is_found_by_archive_search(self):
        self.fill(16)
        session_manager.append_message(self.sid, "user", "the launch codename is zephyr-lantern")
        self.fill(8)
        self.compact()
        hits = memory_tools.search_this_chat_archive(self.sid, "zephyr lantern codename")
        self.assertEqual(len(hits), 1)

    def test_BUG_after_a_second_compaction_archive_search_is_not_flooded_by_earlier_notices(self):
        self.fill(16)
        self.compact()
        self.fill(8)
        self.compact()
        hits = memory_tools.search_this_chat_archive(self.sid, "SUMMARY goals decisions")
        notices = [h for h in hits if NOTICE_HEAD in h["snippet"] or "SUMMARY-1" in h["snippet"]]
        self.assertEqual(notices, [], "summaries re-enter the 'exact earlier messages' archive as if they were quotes")


class AtomicityAndLineageTests(CompactionBase):
    def test_a_failing_summariser_leaves_the_session_untouched(self):
        self.fill(16)
        before = session_manager.get_session(self.sid)

        class Boom(Scripted):
            async def run_turn(self, prompt):
                raise RuntimeError("provider down")
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Boom()):
            with self.assertRaises(RuntimeError):
                self.compact()
        after = session_manager.get_session(self.sid)
        self.assertEqual(len(after["messages"]), len(before["messages"]))
        self.assertFalse(after.get("compactions"))
        self.assertFalse(any(m.get("archived") for m in after["messages"]))
        self.assertNotIn(self.sid, chat_service._busy, "the claim is released after a failure")

    def test_an_empty_summary_is_refused_and_changes_nothing(self):
        self.fill(16)

        class Empty(Scripted):
            async def run_turn(self, prompt):
                return "   "
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Empty()):
            with self.assertRaises(HTTPException) as caught:
                self.compact()
        self.assertEqual(caught.exception.status_code, 502)
        self.assertFalse(session_manager.get_session(self.sid).get("compactions"))

    def test_a_competing_write_path_is_refused_while_compaction_holds_the_chat(self):
        self.fill(16)
        seen = {}
        sid = self.sid

        class Slow(Scripted):
            async def run_turn(self, prompt):
                try:
                    chat_service.claim_session(sid)
                except HTTPException as e:
                    seen["status"] = e.status_code
                return "SUMMARY-X"
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Slow()):
            self.compact()
        self.assertEqual(seen.get("status"), 409)
        self.assertNotIn(self.sid, chat_service._busy)

    def test_fork_keeps_its_own_lineage_and_archive_without_leaking_the_source(self):
        self.fill(16)
        session_manager.append_message(self.sid, "user", "source-only secret marker alpha-91")
        self.fill(8)
        self.compact()
        stored = session_manager.get_session(self.sid)
        fork = session_manager.fork_session(self.sid, len(stored["messages"]) - 1)
        self.assertEqual(fork["compactions"][-1]["through_index"], stored["compactions"][-1]["through_index"])
        self.assertIsNone(fork.get("claude_session_id"))
        hits = memory_tools.search_this_chat_archive(fork["id"], "plain message 2")
        self.assertTrue(hits and all(h["index"] < fork["compactions"][-1]["through_index"] for h in hits))
        # Forking before the boundary drops the compaction it never reached.
        early = session_manager.fork_session(self.sid, 5)
        self.assertFalse(early.get("compactions"))
        self.assertFalse(any(m.get("archived") for m in early["messages"]))
        self.assertEqual(memory_tools.search_this_chat_archive(early["id"], "alpha-91"), [])

    def test_archive_search_is_scoped_to_this_chat(self):
        self.fill(16)
        other = session_manager.create_session("other")["id"]
        session_manager.append_message(other, "user", "plain message 2 but in another chat only: omega-77")
        self.compact()
        self.assertEqual(memory_tools.search_this_chat_archive(self.sid, "omega-77"), [])

    def test_credentials_are_scrubbed_before_the_summariser_but_stay_in_storage(self):
        secrets = ["sk-test-NOT-REAL-123456", "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234567890",
                   "ghp_" + "A1" * 18, "hunter2-pass"]
        self.fill(4)
        session_manager.append_message(self.sid, "user", f"my api key is {secrets[0]} and anthropic {secrets[1]}")
        session_manager.append_message(self.sid, "assistant", f"github {secrets[2]} password = {secrets[3]}")
        tool_secret = "ghp_" + "B2" * 18
        session_manager.append_message(self.sid, "assistant", "looked it up", extra={"tool_rounds": {"endpoint_id": "local", "messages": [
            {"role": "assistant", "content": None, "tool_calls": [{"id": "c9", "type": "function",
                "function": {"name": "read_vault_file", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c9", "content": "token: " + tool_secret}]}})
        self.fill(12)
        self.compact()
        for secret in secrets:
            self.assertNotIn(secret, Scripted.prompts[0])
        self.assertNotIn(tool_secret, Scripted.prompts[0])
        self.assertIn("[REDACTED]", Scripted.prompts[0])
        self.assertIn("plain message 0", Scripted.prompts[0])
        raw = session_manager.get_session(self.sid)["messages"][4]["content"]
        self.assertIn(secrets[0], raw, "stored history is never altered")

    def test_the_notice_is_stored_display_only_and_still_visible(self):
        self.fill(16)
        self.compact()
        stored = session_manager.get_session(self.sid)["messages"]
        self.assertTrue(stored[-1]["content"].startswith(NOTICE_HEAD))
        self.assertTrue(stored[-1].get("display_only"))

    def test_exclude_last_still_drops_the_current_user_message_after_a_compaction(self):
        self.fill(16)
        self.compact()
        session_manager.append_message(self.sid, "user", "the new question")
        history = session_manager.effective_messages(self.sid, exclude_last=True)
        self.assertNotIn("the new question", " ".join(m["content"] for m in history))
        self.assertIn("plain message 15", " ".join(m["content"] for m in history))

    def test_the_tool_line_is_clipped_to_one_line_per_round(self):
        self.fill(16, tool_fact_at=3)
        stored = session_manager.get_session(self.sid)["messages"]
        stored[3]["tool_rounds"]["messages"][1]["content"] = "Vendor sheet" + chr(10) + "x" * 5000
        self.compact()
        lines = [l for l in Scripted.prompts[0].split(chr(10)) if l.startswith("[tool read_vault_file returned:")]
        self.assertEqual(len(lines), 1)
        self.assertLess(len(lines[0]), 400)


class LegacyDataMigrationTests(CompactionBase):
    """Chats written before the compaction fix: notices unflagged, index without tool text."""

    def _legacy_chat(self):
        from core import session_manager_store as store
        self.fill(16, tool_fact_at=3)
        session_manager.compact_session(self.sid, 10, "OLD-SUMMARY goals")
        session_manager.append_message(self.sid, "assistant", NOTICE_HEAD + chr(10) * 2 + "OLD-SUMMARY goals")  # no display_only
        session_manager.append_message(self.sid, "assistant", NOTICE_HEAD + chr(10) * 2 + "my own words, not a summary")
        session_manager.append_message(self.sid, "user", NOTICE_HEAD + chr(10) * 2 + "OLD-SUMMARY goals")
        conn = store.connection()
        with conn:  # as an older build indexed it: message text only
            conn.execute("DELETE FROM messages_fts WHERE session_id = ? AND idx = 3", (self.sid,))
            conn.execute("INSERT INTO messages_fts (content, session_id, idx, role) VALUES (?, ?, 3, 'assistant')",
                         ("plain message 3", self.sid))
            conn.execute("DELETE FROM meta WHERE key IN (?, ?)", (store.NOTICE_MIGRATION_MARKER, store.TOOL_INDEX_MIGRATION_MARKER))
        return store, conn

    def test_legacy_notice_is_flagged_exactly_and_nothing_else(self):
        store, conn = self._legacy_chat()
        store._migrate_compaction_data(conn)
        self.assertEqual(conn.execute("SELECT count(*) FROM meta WHERE key = ?", (store.TOOL_INDEX_MIGRATION_MARKER,)).fetchone()[0], 0,
                         "tool-text indexing is not part of the connect-time migration")
        msgs = session_manager.get_session(self.sid)["messages"]
        self.assertEqual([i for i, m in enumerate(msgs) if m.get("display_only")], [16])
        self.assertEqual(len([m for m in self.effective() if m["content"].startswith(NOTICE_HEAD)]), 2)

    def test_migration_adds_tool_text_to_the_search_index_and_is_idempotent(self):
        store, conn = self._legacy_chat()
        self.assertEqual(memory_tools.search_this_chat_archive(self.sid, "vendor badge number"), [])
        store._migrate_compaction_data(conn)
        self.assertTrue(store.migrate_tool_text_index())
        self.assertTrue(memory_tools.search_this_chat_archive(self.sid, "vendor badge number"))
        before = conn.execute("SELECT count(*) FROM messages_fts WHERE session_id = ?", (self.sid,)).fetchone()[0]
        with conn:
            conn.execute("DELETE FROM meta WHERE key IN (?, ?)", (store.NOTICE_MIGRATION_MARKER, store.TOOL_INDEX_MIGRATION_MARKER))
        store._migrate_compaction_data(conn)  # re-run with the markers cleared: same result
        store.migrate_tool_text_index()
        self.assertEqual(before, conn.execute("SELECT count(*) FROM messages_fts WHERE session_id = ?", (self.sid,)).fetchone()[0])
        self.assertEqual(len(memory_tools.search_this_chat_archive(self.sid, "vendor badge number")), 1)
        self.assertEqual(conn.execute("SELECT count(*) FROM meta WHERE key IN (?, ?)",
                                      (store.NOTICE_MIGRATION_MARKER, store.TOOL_INDEX_MIGRATION_MARKER)).fetchone()[0], 2)


class BackgroundToolIndexTests(unittest.TestCase):
    """Step 2 (tool text into the search index) runs in batches off the startup path."""

    def setUp(self):
        from core import session_manager_store as store
        self.store = store
        self.ids = []
        for c in range(6):
            sid = session_manager.create_session(f"bg{c}")["id"]
            self.ids.append(sid)
            for n in range(12):
                extra = None
                if n % 3 == 1:
                    extra = {"tool_rounds": {"endpoint_id": "local", "messages": [
                        {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function",
                            "function": {"name": "read_vault_file", "arguments": "{}"}}]},
                        {"role": "tool", "tool_call_id": "c1", "content": f"zeta{c}x{n} fact"}]}}
                session_manager.append_message(sid, "assistant" if n % 2 else "user", f"plain {c} {n}", extra=extra)
        self.conn = store.connection()
        self.reset_legacy()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.store.stop_background_migration()
        self.conn.set_trace_callback(None)
        for sid in self.ids:
            session_manager.delete_session(sid)

    def reset_legacy(self):
        """As an older build indexed: message text only, tool-text marker cleared."""
        with self.conn:
            for r in self.conn.execute("SELECT session_id, idx, role, content FROM messages WHERE session_id IN (%s)"
                                       % ",".join("?" * len(self.ids)), self.ids).fetchall():
                self.conn.execute("DELETE FROM messages_fts WHERE session_id = ? AND idx = ?", (r[0], r[1]))
                self.conn.execute("INSERT INTO messages_fts (content, session_id, idx, role) VALUES (?, ?, ?, ?)",
                                  (r[3], r[0], r[1], r[2]))
        self.reset_marker_only()

    def reset_marker_only(self):
        with self.conn:
            self.conn.execute("DELETE FROM meta WHERE key = ?", (self.store.TOOL_INDEX_MIGRATION_MARKER,))

    def marker(self):
        return self.conn.execute("SELECT count(*) FROM meta WHERE key = ?",
                                 (self.store.TOOL_INDEX_MIGRATION_MARKER,)).fetchone()[0]

    def hits(self, word):
        return self.conn.execute("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?", (word,)).fetchone()[0]

    def fts_rows(self):
        return self.conn.execute("SELECT count(*) FROM messages_fts").fetchone()[0]

    def test_connect_time_migration_does_not_touch_tool_text(self):
        self.store._migrate_compaction_data(self.conn)
        self.assertEqual(self.hits("zeta0x1"), 0)
        self.assertEqual(self.marker(), 0)

    def test_no_per_row_full_fts_delete(self):
        statements = []
        self.conn.set_trace_callback(statements.append)
        try:
            self.assertTrue(self.store.migrate_tool_text_index(batch=7))
        finally:
            self.conn.set_trace_callback(None)
        deletes = [s for s in statements if "DELETE FROM messages_fts" in s]
        self.assertTrue(deletes)
        self.assertEqual([s for s in deletes if "rowid" not in s], [],
                         "every FTS delete must be by rowid (session_id/idx are unindexed)")

    def test_runs_in_batches_one_transaction_each(self):
        commits = []
        # The receipt-safe store composes writes with outermost savepoints.
        self.conn.set_trace_callback(lambda q: commits.append(q) if q.startswith("RELEASE write_") else None)
        try:
            self.store.migrate_tool_text_index(batch=5)
        finally:
            self.conn.set_trace_callback(None)
        self.assertGreaterEqual(len(commits), 4, "24 tool messages at 5 per batch is several transactions")

    def test_background_thread_completes_and_makes_tool_text_searchable(self):
        before = self.fts_rows()
        thread = self.store.start_background_migration()
        thread.join(30)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.hits("zeta3x4"), 1)
        self.assertEqual(self.hits("zeta0x2"), 0, "a message without tool rounds gained nothing")
        self.assertEqual(self.fts_rows(), before, "re-indexing replaces rows, never adds or drops them")
        self.assertEqual(self.marker(), 1)

    def test_second_run_changes_nothing(self):
        self.store.migrate_tool_text_index()
        snap = self.conn.execute("SELECT count(*), sum(length(content)), sum(rowid) FROM messages_fts").fetchone()[:]
        self.assertTrue(self.store.migrate_tool_text_index())  # marker set: returns at once
        self.reset_marker_only()
        self.assertTrue(self.store.migrate_tool_text_index())  # redone: same rows, same text
        self.assertEqual(snap, self.conn.execute(
            "SELECT count(*), sum(length(content)), sum(rowid) FROM messages_fts").fetchone()[:])
        self.assertEqual(self.hits("zeta1x1"), 1)

    def test_stopped_run_leaves_no_marker_and_a_later_run_finishes(self):
        stop = threading.Event()
        calls = []
        real = self.store._reindex_tool_message

        def stopping(*a, **k):
            calls.append(1)
            if len(calls) == 6:
                stop.set()
            return real(*a, **k)
        with patch.object(self.store, "_reindex_tool_message", side_effect=stopping):
            self.assertFalse(self.store.migrate_tool_text_index(stop, batch=3))
        self.assertEqual(self.marker(), 0)
        self.assertTrue(self.store.migrate_tool_text_index(batch=3))  # the restart: redoing done rows is harmless
        self.assertEqual(self.marker(), 1)
        for c in range(6):
            for n in (1, 4, 7, 10):
                self.assertEqual(self.hits(f"zeta{c}x{n}"), 1, (c, n))

    def test_message_written_during_the_run_is_indexed_exactly_once(self):
        sid = self.ids[0]
        real = self.store._reindex_tool_message
        state = {"done": False}

        def interleaved(*a, **k):
            if not state["done"]:
                state["done"] = True  # another request lands between two batches, while the lock is free
                session_manager.append_message(sid, "assistant", "late reply", extra={"tool_rounds": {
                    "endpoint_id": "local", "messages": [
                        {"role": "assistant", "content": None, "tool_calls": [
                            {"id": "c9", "type": "function", "function": {"name": "t", "arguments": "{}"}}]},
                        {"role": "tool", "tool_call_id": "c9", "content": "lateword fact"}]}})
            return real(*a, **k)
        with patch.object(self.store, "_reindex_tool_message", side_effect=interleaved):
            self.assertTrue(self.store.migrate_tool_text_index(batch=4))
        self.assertEqual(self.hits("lateword"), 1)
        for sid2 in self.ids:  # every message still has exactly one index row
            n_msgs = self.conn.execute("SELECT count(*) FROM messages WHERE session_id = ?", (sid2,)).fetchone()[0]
            n_fts = self.conn.execute("SELECT count(*) FROM messages_fts WHERE session_id = ?", (sid2,)).fetchone()[0]
            self.assertEqual(n_msgs, n_fts, sid2)

    def test_message_replaced_during_the_run_keeps_one_current_row(self):
        sid = self.ids[1]
        real = self.store._reindex_tool_message
        state = {"done": False}

        def interleaved(*a, **k):
            if not state["done"]:
                state["done"] = True
                msgs = session_manager.get_session(sid)["messages"]
                msgs[4]["content"] = "edited text"  # a rewrite re-derives every index row of the chat
                self.store.save_session({**session_manager.get_session(sid), "messages": msgs})
            return real(*a, **k)
        with patch.object(self.store, "_reindex_tool_message", side_effect=interleaved):
            self.assertTrue(self.store.migrate_tool_text_index(batch=4))
        self.assertEqual(self.hits("zeta1x4"), 1)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM messages_fts WHERE session_id = ? AND idx = 4",
                                           (sid,)).fetchone()[0], 1)

    def test_requests_interleave_while_the_thread_runs(self):
        thread = self.store.start_background_migration()
        deadline = time.time() + 10
        served = 0
        while True:
            self.assertTrue(self.store.session_exists(self.ids[0]))
            served += 1
            if not thread.is_alive() or time.time() > deadline:
                break
        thread.join(10)
        self.assertGreater(served, 0)

    def test_stop_ends_the_thread_and_leaves_none_behind(self):
        real = self.store._reindex_tool_message

        def slow(*a, **k):
            time.sleep(0.05)
            return real(*a, **k)
        with patch.object(self.store, "_reindex_tool_message", side_effect=slow):
            thread = self.store.start_background_migration()
            time.sleep(0.15)
            self.store.stop_background_migration()
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.marker(), 0)


class RedactionHelperTests(unittest.TestCase):
    def test_provider_keys_are_masked_and_ordinary_words_are_not(self):
        from core import logs
        for key in ("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234567890", "sk-proj-abc123def456ghi789jkl012",
                    "AIza" + "a" * 35, "ghp_" + "Z9" * 18, "xoxb-123456789012-abcdefghij", "xoxp-1234567890-abc"):
            self.assertNotIn(key, logs.redact("failed with " + key + " today"), key)
        for text in ("a task-force of skilled sk-learn-pipeline-transformer users", "the ask-anything box",
                     "gh_pages branch", "use skeleton-key-management-overview"):
            self.assertEqual(logs.redact(text), text)

    def test_key_value_passwords_are_scrubbed_only_for_model_text(self):
        from core import logs
        text = 'password = hunter2, api_key: "a b c", PASSWORD=x'
        out = logs.scrub_credentials(text)
        self.assertNotIn("hunter2", out)
        self.assertNotIn("a b c", out)
        self.assertEqual(logs.redact("password = hunter2"), "password = hunter2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
