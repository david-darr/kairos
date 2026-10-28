"""Part 2, group g5, area A10: Library documents, the vault memory index and
vault task sync, against a throwaway data dir and vault (never a real one).

What this adds to test_vault_routes.py / test_chat.py (VaultMemoryTests):
- the Documents store end to end through its real routes: create, list,
  partial update, search, import, delete, 404s, Unicode, CRLF, a missing
  content file, path-shaped ids;
- the vault memory index: incremental refresh, rename/delete/edit, no
  duplicate rows after repeated searches, special characters in queries;
- Active Priorities sync: idempotent, no duplicates, identical lines;
- efficiency numbers (printed, with soft ceilings): cold/warm index and search
  over a 3,000-note vault, documents search, sync cost.

Tests named test_BUG_* assert the CORRECT behaviour and currently FAIL on
dev: they are the app bugs reported in groups/g5-report.md.

Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_g5_library_documents_memory.py
"""
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
_ROOT = Path(tempfile.mkdtemp(prefix="g5-lib-"))
VAULT = _ROOT / "vault"
VAULT.mkdir()
os.environ["JARVIS_DATA_DIR"] = str(_ROOT / "data")
os.environ["JARVIS_VAULT_DIR"] = str(VAULT)

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import middleware, vault_sync  # noqa: E402
from core.memory import vault as vault_index  # noqa: E402
from core.memory import vault_memory  # noqa: E402
from routes import document_routes  # noqa: E402
from services import documents_service  # noqa: E402
from services.notes_service import notes_service  # noqa: E402

BENCH = {}


def ms(start):
    return round((time.perf_counter() - start) * 1000, 1)


def p(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * q))]


class DocumentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.object(middleware, "get_current_user", lambda request: "admin"):
            pass
        app = FastAPI()
        app.include_router(document_routes.router)
        app.dependency_overrides[document_routes.require_user] = lambda: "admin"
        cls.client = TestClient(app)

    def setUp(self):
        for doc in self.client.get("/api/documents").json():
            self.client.delete(f"/api/documents/{doc['id']}")

    def make(self, title="Spec", content="body", **extra):
        response = self.client.post("/api/documents", json={"title": title, "content": content, **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_create_list_get_update_delete_round_trip(self):
        doc = self.make("Launch plan", "# Plan\n\nStep one.", tags=["a", "b"])
        self.assertEqual(self.client.get(f"/api/documents/{doc['id']}").json()["content"], "# Plan\n\nStep one.")
        listed = self.client.get("/api/documents").json()
        self.assertEqual([d["id"] for d in listed], [doc["id"]])
        self.assertNotIn("content", listed[0], "listing never reads bodies")
        # A title-only edit keeps the body; a body-only edit keeps the title and tags.
        self.client.patch(f"/api/documents/{doc['id']}", json={"title": "Launch plan v2"})
        got = self.client.get(f"/api/documents/{doc['id']}").json()
        self.assertEqual((got["title"], got["content"]), ("Launch plan v2", "# Plan\n\nStep one."))
        self.client.patch(f"/api/documents/{doc['id']}", json={"content": "new body"})
        got = self.client.get(f"/api/documents/{doc['id']}").json()
        self.assertEqual((got["title"], got["content"], got["tags"]), ("Launch plan v2", "new body", ["a", "b"]))
        self.assertGreater(got["updated_at"], got["created_at"])
        self.assertEqual(self.client.delete(f"/api/documents/{doc['id']}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/documents/{doc['id']}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/documents/{doc['id']}").json(), {"ok": True}, "delete twice is harmless")
        self.assertFalse(os.path.exists(documents_service._content_path(doc["id"])), "the body file is gone with it")
        self.assertEqual(self.client.patch("/api/documents/nope", json={"title": "x"}).status_code, 404)

    def test_list_is_newest_first_and_two_documents_never_share_an_id(self):
        a, b = self.make("A"), self.make("B")
        time.sleep(0.01)
        self.client.patch(f"/api/documents/{a['id']}", json={"content": "touched"})
        self.assertEqual([d["title"] for d in self.client.get("/api/documents").json()], ["A", "B"])
        self.assertNotEqual(a["id"], b["id"])

    def test_import_names_the_document_from_the_file_and_never_overwrites(self):
        first = self.client.post("/api/documents/import", json={"filename": "C:\\x\\Notes.md", "content": "one"}).json()
        second = self.client.post("/api/documents/import", json={"filename": "Notes.md", "content": "two"}).json()
        self.assertEqual((first["title"], second["title"]), ("Notes", "Notes"))
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(self.client.get(f"/api/documents/{first['id']}").json()["content"], "one")

    def test_unicode_and_large_bodies_survive(self):
        text = "café 日本語 \U0001F600 — “quotes”\nline two\n" * 2000
        doc = self.make("Ünïcode 日本", text)
        self.assertEqual(self.client.get(f"/api/documents/{doc['id']}").json()["content"], text)
        self.assertEqual(self.client.get("/api/documents/search", params={"q": "日本語"}).json()[0]["id"], doc["id"])

    def test_search_is_title_then_body_capped_and_snippets_are_bounded(self):
        for n in range(8):
            self.make(f"Filler {n}", "needle " + "x" * 5000)
        self.make("Needle title", "nothing")
        hits = self.client.get("/api/documents/search", params={"q": "NEEDLE"}).json()
        self.assertEqual(len(hits), 5, "at most 5 hits")
        self.assertTrue(all(len(h["snippet"]) <= 2 * documents_service.SNIPPET_RADIUS + 20 for h in hits))
        self.assertEqual(self.client.get("/api/documents/search", params={"q": "zzzz-none"}).json(), [])

    def test_path_shaped_ids_cannot_reach_other_files(self):
        secret = _ROOT / "data" / "secret.md"
        secret.parent.mkdir(parents=True, exist_ok=True)
        secret.write_text("TOP SECRET")
        for bad in ("..%2Fsecret", "..%5Csecret", "%2e%2e/secret"):
            self.assertEqual(self.client.get(f"/api/documents/{bad}").status_code, 404, bad)
            self.assertIn(self.client.delete(f"/api/documents/{bad}").status_code, (200, 404), bad)
        self.assertTrue(secret.exists())

    def test_BUG_crlf_text_keeps_its_line_count(self):
        """A Windows .md imported through Import from File (FileReader keeps
        the CRLFs) must read back with the same lines. On Windows the store
        writes in text mode, turning \\r\\n into \\r\\r\\n, which reads back as
        a blank line between every line."""
        raw = "# Title\r\n\r\nline a\r\nline b\r\n"
        doc = self.client.post("/api/documents/import", json={"filename": "w.md", "content": raw}).json()
        back = self.client.get(f"/api/documents/{doc['id']}").json()["content"]
        self.assertEqual(back.replace("\r\n", "\n"), raw.replace("\r\n", "\n"))

    def test_BUG_update_with_a_missing_body_file_does_not_half_save(self):
        """If the .md body is gone, a title-only PATCH raises FileNotFoundError
        (HTTP 500) AFTER the index already took the new title and timestamp."""
        doc = self.make("Keep", "body")
        os.remove(documents_service._content_path(doc["id"]))
        try:
            response = self.client.patch(f"/api/documents/{doc['id']}", json={"title": "Renamed"})
        except Exception as error:  # TestClient re-raises server errors
            response = None
            raised = error
        title = self.client.get(f"/api/documents/{doc['id']}").json()["title"]
        self.assertTrue(response is not None and response.status_code < 500 and title == "Renamed"
                        or (response is None and title == "Keep"),
                        f"PATCH {'raised ' + type(raised).__name__ if response is None else response.status_code}; "
                        f"title is now {title!r}")

    def test_save_is_last_writer_wins_documents_have_no_versions(self):
        """Documents carry no version/ETag: two editors overwrite each other
        silently. Recorded as a GAP, asserted as the current behaviour."""
        doc = self.make("Shared", "base")
        self.client.patch(f"/api/documents/{doc['id']}", json={"content": "editor one"})
        self.client.patch(f"/api/documents/{doc['id']}", json={"content": "editor two (stale)"})
        self.assertEqual(self.client.get(f"/api/documents/{doc['id']}").json()["content"], "editor two (stale)")
        self.assertNotIn("version", self.client.get(f"/api/documents/{doc['id']}").json())

    def test_efficiency_documents_list_vs_search(self):
        for n in range(300):
            self.make(f"Doc {n}", ("lorem ipsum " * 400) + (" target-word" if n == 299 else ""))
        listing = []
        for _ in range(15):
            t = time.perf_counter(); self.client.get("/api/documents"); listing.append(ms(t))
        search = []
        reads = {"n": 0}
        real = open

        def counting(path, *a, **k):
            if str(path).endswith(".md") and "documents" in str(path):
                reads["n"] += 1
            return real(path, *a, **k)
        for _ in range(15):
            t = time.perf_counter(); self.client.get("/api/documents/search", params={"q": "target-word"}); search.append(ms(t))
        with patch("builtins.open", counting):
            self.client.get("/api/documents/search", params={"q": "target-word"})
        BENCH["documents_300x4.8KB"] = {"list_p50_ms": p(listing, .5), "list_p95_ms": p(listing, .95),
                                       "search_p50_ms": p(search, .5), "search_p95_ms": p(search, .95),
                                       "files_read_per_search": reads["n"]}
        self.assertEqual(reads["n"], 300, "EFFICIENCY: a document search reads every body file (no index)")


def build_vault(count):
    for n in range(count):
        folder = VAULT / "Big" / f"f{n % 40}"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"Note {n}.md").write_text(
            f"---\nstatus: active\n---\n# Note {n}\n\n" + ("alpha beta gamma delta " * 60)
            + (f"\nunique-token-{n} links [[Note {(n + 1) % count}]]\n"), encoding="utf-8")


class VaultMemoryTests(unittest.TestCase):
    def setUp(self):
        shutil.rmtree(VAULT, ignore_errors=True)
        VAULT.mkdir()
        shutil.rmtree(vault_index.INDEX_DIR, ignore_errors=True)
        vault_index.VaultMemory._instances.clear()
        self.memory = vault_memory(str(VAULT))

    def paths(self, query, **kw):
        return [h["ref"] for h in self.memory.search(query, **kw)]

    def rows(self):
        conn = sqlite3.connect(self.memory.db_path)
        try:
            return (conn.execute("select count(*) from notes").fetchone()[0],
                    conn.execute("select count(*) from notes_fts").fetchone()[0])
        finally:
            conn.close()

    def test_index_follows_create_edit_rename_delete_without_duplicates(self):
        (VAULT / "A.md").write_text("zebra apple", encoding="utf-8")
        self.assertEqual(self.paths("zebra"), ["A.md"])
        for _ in range(3):
            self.memory.search("zebra")
        self.assertEqual(self.rows(), (1, 1), "repeat searches add no rows")
        time.sleep(0.02)
        (VAULT / "A.md").write_text("yak apple and more words", encoding="utf-8")
        self.assertEqual((self.paths("zebra"), self.paths("yak")), ([], ["A.md"]), "an edit replaces the old text")
        (VAULT / "A.md").rename(VAULT / "B.md")
        self.assertEqual((self.paths("yak"), self.rows()), (["B.md"], (1, 1)), "a rename moves it, no ghost")
        (VAULT / "B.md").unlink()
        self.assertEqual((self.paths("yak"), self.rows()), ([], (0, 0)))

    def test_special_characters_never_break_search_and_stay_in_the_vault(self):
        (VAULT / "Odd.md").write_text("price: $5 (sale) \"quoted\" C++ a-b *star* NEAR AND OR", encoding="utf-8")
        for query in ['"', "(", "C++", "a-b", "*star*", "NEAR", "AND OR NOT", "'; DROP TABLE notes;--", "日本", ""]:
            self.assertIsInstance(self.memory.search(query), list, query)
        self.assertEqual(self.rows(), (1, 1))
        with self.assertRaises(ValueError):
            self.memory.read("..\\..\\outside.md")
        with self.assertRaises(ValueError):
            self.memory.read("/etc/passwd")

    def test_hidden_and_non_markdown_are_not_indexed_and_bad_bytes_do_not_crash(self):
        (VAULT / ".obsidian").mkdir()
        (VAULT / ".obsidian" / "x.md").write_text("hiddenword", encoding="utf-8")
        (VAULT / "pic.png").write_bytes(b"\x89PNG hiddenword")
        (VAULT / "Latin.md").write_bytes("caf\xe9 visible".encode("latin-1"))
        self.assertEqual(self.paths("hiddenword"), [])
        self.assertEqual(self.paths("visible"), ["Latin.md"], "undecodable bytes do not stop indexing")

    def test_ranking_prefers_the_note_named_for_the_query_and_limit_is_honoured(self):
        (VAULT / "Roadmap Q4.md").write_text("short", encoding="utf-8")
        for n in range(10):
            (VAULT / f"Daily {n}.md").write_text("we mentioned roadmap q4 once", encoding="utf-8")
        self.assertEqual(self.paths("roadmap q4", limit=3)[0], "Roadmap Q4.md")
        self.assertEqual(len(self.paths("roadmap", limit=3)), 3)

    def test_efficiency_cold_and_warm_index_on_a_3000_note_vault(self):
        build_vault(3000)
        t = time.perf_counter(); first = self.memory.search("unique-token-2999"); cold = ms(t)
        self.assertEqual(first[0]["ref"].split("/")[-1], "Note 2999.md")
        warm = []
        for _ in range(15):
            t = time.perf_counter(); self.memory.search("unique-token-17"); warm.append(ms(t))
        (VAULT / "Big" / "f0" / "Note 0.md").write_text("changed-token", encoding="utf-8")
        t = time.perf_counter(); self.memory.search("changed-token"); one_edit = ms(t)
        for n in range(1, 31):
            (VAULT / "Big" / f"f{n % 40}" / f"Note {n}.md").write_text(f"batch-{n}", encoding="utf-8")
        t = time.perf_counter(); self.memory.search("batch-5"); batch30 = ms(t)
        BENCH["vault_index_3000_notes"] = {"cold_index_ms": cold, "warm_search_p50_ms": p(warm, .5),
                                           "warm_search_p95_ms": p(warm, .95), "one_edit_refresh_search_ms": one_edit,
                                           "30_edits_refresh_search_ms": batch30}
        self.assertEqual(self.rows(), (3000, 3000))

    def test_efficiency_a_warm_search_still_walks_and_stats_every_file(self):
        build_vault(500)
        self.memory.search("alpha")
        calls = {"stat": 0}
        real = os.stat

        def counting(*a, **k):
            calls["stat"] += 1
            return real(*a, **k)
        with patch.object(vault_index.os, "stat", counting):
            self.memory.search("alpha")
        BENCH["stat_calls_per_warm_search_500_notes"] = calls["stat"]
        self.assertGreaterEqual(calls["stat"], 500, "EFFICIENCY: refresh() stats every note before every search")


class PrioritiesSyncTests(unittest.TestCase):
    FILE = VAULT / "Active Priorities.md"

    def setUp(self):
        shutil.rmtree(VAULT, ignore_errors=True)
        VAULT.mkdir()
        for note in list(notes_service.list_notes()):
            if note.get("vault_source"):
                notes_service.delete_note(note["id"])

    def sources(self):
        return sorted((n["project"], n["text"], n["completed"]) for n in notes_service.list_notes() if n.get("vault_source"))

    def test_sync_is_idempotent_follows_edits_and_removes_deleted_items(self):
        self.FILE.write_text("## Now\n- [ ] ship it\n- [x] done thing\n## Later\n- [ ] dream\n", encoding="utf-8")
        first = vault_sync.sync_from_vault()
        self.assertEqual((first["imported"], first["updated"], first["removed"]), (3, 0, 0))
        second = vault_sync.sync_from_vault()
        self.assertEqual((second["imported"], second["updated"], second["removed"]), (0, 0, 0))
        self.FILE.write_text("## Now\n- [x] ship it\n## Later\n- [ ] dream\n", encoding="utf-8")
        third = vault_sync.sync_from_vault()
        # Batch 2 fix (checkbox no longer part of the key): ticking "ship it" updates that note
        # in place (1 update), and the removed line "done thing" is the single removal.
        self.assertEqual((third["imported"], third["removed"]), (0, 1))
        self.assertEqual(self.sources(), [("Later", "dream", False), ("Now", "ship it", True)])

    def test_BUG_checking_a_box_in_the_vault_keeps_the_note(self):
        """The `completed` update branch can never run: the checkbox is part of
        the line that identifies the note, so ticking a box in Obsidian deletes
        the app's note and creates a new one (new id; due date and other app
        edits are lost)."""
        self.FILE.write_text("## Now\n- [ ] ship it\n", encoding="utf-8")
        vault_sync.sync_from_vault()
        before = next(n["id"] for n in notes_service.list_notes() if n.get("vault_source"))
        self.FILE.write_text("## Now\n- [x] ship it\n", encoding="utf-8")
        vault_sync.sync_from_vault()
        after = [n["id"] for n in notes_service.list_notes() if n.get("vault_source")]
        self.assertEqual(after, [before])

    def test_missing_file_and_garbage_do_not_raise(self):
        self.assertIn(vault_sync.sync_from_vault()["files"], (0, 1), "an empty vault may be seeded with its priorities file")
        self.FILE.write_bytes(b"\xff\xfe\x00bad bytes\n- [ ] ok\n")
        vault_sync.sync_on_startup()

    def test_write_back_flips_only_its_checkbox_and_keeps_crlf(self):
        self.FILE.write_bytes(b"## Now\r\n- [ ] ship it\r\n- [ ] other\r\n")
        vault_sync.sync_from_vault()
        note = next(n for n in notes_service.list_notes() if n.get("vault_source") and n["text"] == "ship it")
        self.assertTrue(vault_sync.write_back_completion(note, True))
        self.assertEqual(self.FILE.read_bytes(), b"## Now\r\n- [x] ship it\r\n- [ ] other\r\n")
        self.FILE.write_bytes(b"## Now\r\n- [ ] reworded\r\n")
        note = next(n for n in notes_service.list_notes() if n.get("vault_source") and n["text"] == "ship it")
        self.assertFalse(vault_sync.write_back_completion(note, False), "a changed line is never guessed at")

    def test_BUG_the_same_line_under_two_headings_is_two_tasks(self):
        """Identical checkbox lines under different headings are keyed only by
        (file, line): one note is imported and each sync flips its project
        between the headings, reporting an update every time."""
        self.FILE.write_text("## Home\n- [ ] call dentist\n## Work\n- [ ] call dentist\n", encoding="utf-8")
        vault_sync.sync_from_vault()
        again = vault_sync.sync_from_vault()
        self.assertEqual(self.sources(), [("Home", "call dentist", False), ("Work", "call dentist", False)],
                         f"imported {self.sources()}; second sync updated {again['updated']}")

    def test_sync_list_notes_calls_stay_small_for_many_items(self):
        items = "\n".join(f"- [ ] task number {n}" for n in range(300))
        self.FILE.write_text("## Big\n" + items + "\n", encoding="utf-8")
        t = time.perf_counter(); vault_sync.sync_from_vault(); first = ms(t)
        calls = {"n": 0}
        real = notes_service.list_notes

        def counting(*a, **k):
            calls["n"] += 1
            return real(*a, **k)
        with patch.object(notes_service, "list_notes", counting):
            t = time.perf_counter(); vault_sync.sync_from_vault(); second = ms(t)
        BENCH["priorities_sync_300_items"] = {"first_sync_ms": first, "no_change_sync_ms": second, "list_notes_calls": calls["n"]}
        # Batch 2 fix: sync builds one index instead of calling list_notes() per item. Guard that
        # the call count stays small for 300 items (was >=300, O(n^2)).
        self.assertLessEqual(calls["n"], 5, f"list_notes() called {calls['n']} times for 300 items")


class RetrievalScopeTests(unittest.TestCase):
    """Chat retrieval through the real tool: relevant, citable, never the same chat."""

    def setUp(self):
        from core.session_manager import session_manager
        self.sm = session_manager

    def _chat(self, title, owner, text):
        sid = self.sm.create_session(title, owner_user=owner)["id"]
        self.sm.append_message(sid, "user", text)
        return sid

    def test_cross_chat_search_cites_and_excludes_the_current_chat(self):
        from core import tool_registry
        from core.turn_taint import TurnTaint
        import asyncio
        mine = self._chat("Mine", "admin", "zebrafish migration plan for quarter")
        other = self._chat("Other chat", "admin", "the zebrafish migration decision was approved")
        ctx = tool_registry.ToolContext(session_id=mine, is_admin=True, turn_taint=TurnTaint(), surface=tool_registry.OPENAI)
        out = asyncio.run(tool_registry.call("search_sessions", {"query": "zebrafish migration"}, ctx, tool_registry.OPENAI))
        out = out.text if hasattr(out, "text") else out
        self.assertIn("Other chat", out, "the hit names its chat")
        self.assertNotIn("[Mine", out, "the chat asking is never cited back to itself")
        self.assertRegex(out, r"\[Other chat, .*message \d+\]", "date and message number make it citable")

    def test_BUG_a_non_admin_chat_cannot_search_another_users_chats(self):
        """search_sessions has no owner filter: any chat's model can read
        snippets of every other user's private chats."""
        from core import tool_registry
        from core.turn_taint import TurnTaint
        import asyncio
        secret = self._chat("Alice private", "alice", "alice-only quokka salary negotiation notes")
        bob = self._chat("Bob chat", "bob", "hello")
        ctx = tool_registry.ToolContext(session_id=bob, is_admin=False, turn_taint=TurnTaint(), surface=tool_registry.OPENAI)
        out = asyncio.run(tool_registry.call("search_sessions", {"query": "quokka salary"}, ctx, tool_registry.OPENAI))
        out = out.text if hasattr(out, "text") else out
        self.assertNotIn("Alice private", out)
        self.assertTrue(secret)


def tearDownModule():
    from core import session_manager_store
    try:
        session_manager_store.close()
    except Exception:
        pass
    print("\nBENCH", BENCH)
    shutil.rmtree(_ROOT, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=1)
