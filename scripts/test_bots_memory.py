"""Bots Phase 2 unit U1: the notebook's storage, entries, routes and the old memory methods as adapters.

Spec: Kairos Projects/Agents Redesign/phase-2-design.md, sections 3.1, 3.2, 5 and 7 (U1).
Throwaway data folder, no models. Run: python scripts/test_bots_memory.py
"""
import asyncio
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-memory-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import tool_registry  # noqa: E402
from core.auth import SESSION_COOKIE_NAME, auth_manager  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from routes import bot_memory_routes, bot_resources_routes  # noqa: E402
from services import bot_memory, bot_memory_entries as entries, bot_memory_journal as journal, bot_memory_store as store  # noqa: E402
from services.agent_service import agent_service  # noqa: E402
from services.task_service import task_service  # noqa: E402

app = FastAPI()
app.include_router(bot_memory_routes.router)
app.dependency_overrides[require_admin] = lambda: "david"
web = TestClient(app, client=("127.0.0.1", 50000))
ABSENT = store.ABSENT
TODAY = datetime.now().date()


def make_link(link: Path, target: Path) -> bool:
    """A symlink, or on Windows a junction (which needs no privilege). False when neither can be made."""
    try:
        os.symlink(target, link, target_is_directory=True)
        return True
    except (OSError, NotImplementedError):
        pass
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
        return result.returncode == 0
    return False


class NotebookCase(unittest.TestCase):
    def setUp(self):
        self.bot = agent_service.create("Scout", role="Watches job postings")
        self.id = self.bot["id"]
        self.addCleanup(lambda: agent_service.get(self.id) and agent_service.delete(self.id))

    def root(self) -> Path:
        return store.workspace(self.id)

    def put(self, path, text, actor="person", source="test"):
        current = bot_memory.read_file(self.id, path, missing_ok=True)
        return bot_memory.write_text(self.id, path, text, current["hash"], actor=actor, source=source)

    def index(self):
        return bot_memory.read_file(self.id, store.INDEX_NAME)


class PathTests(NotebookCase):
    def test_every_allowed_shape_and_nothing_else(self):
        for path in ("MEMORY.md", "memory/hiring.md", "memory/a_b-c9.md", "memory/log/2026-10-29.md", "memory/archive.md",
                     "skills/my-skill/SKILL.md", "skills/my-skill/references/notes_1.md"):
            self.assertEqual(store.classify(path).path, path)
        kinds = {"MEMORY.md": "index", "memory/hiring.md": "topic", "memory/log/2026-10-29.md": "log",
                 "memory/archive.md": "archive", "skills/x/SKILL.md": "skill", "skills/x/references/y.md": "reference"}
        for path, kind in kinds.items():
            self.assertEqual(store.classify(path).kind, kind)
        for bad in ("", "/MEMORY.md", "../MEMORY.md", "memory/../MEMORY.md", "C:/x.md", "memory\\hiring.md", "memory/hiring.md:stream",
                    "memory.md", "Memory.md", "memory/Archive.md", "memory/archive", "memory/log.md", "memory/log/2026-1-1.md",
                    "memory//hiring.md", "memory/hiring.md ", "memory/hiring.md.", "memory/con.md", "memory/a b.md", "memory/sub/x.md",
                    "skills/Bad_Name/SKILL.md", "skills/x/skill.md", "skills/x/references/y.txt", "other.md", "memory/.md",
                    "memory/" + "x" * 65 + ".md", "x" * 300, "MEMORY.md\x00", ".", "memory/./hiring.md"):
            with self.subTest(path=bad):
                with self.assertRaises(store.PathRefused):
                    store.classify(bad)
        with self.assertRaises(store.PathRefused):
            store.topic_path("archive")
        with self.assertRaises(store.PathRefused):
            store.topic_path("bad name")

    def test_a_case_alias_is_refused(self):
        self.put("memory/Hiring.md", "x\n")
        folder = self.root() / "memory"
        if not (folder / "hiring.md").exists():
            self.skipTest("this file system is case sensitive: no alias can exist")
        with self.assertRaises(store.PathRefused):
            bot_memory.read_file(self.id, "memory/hiring.md")
        with self.assertRaises(store.PathRefused):
            self.put("memory/hiring.md", "y\n")
        self.assertEqual(bot_memory.read_file(self.id, "memory/Hiring.md")["text"], "x\n")

    def test_a_link_or_junction_never_reaches_outside(self):
        outside = Path(tempfile.mkdtemp(prefix="kairos-outside-", dir=_DATA.name))
        (outside / "secret.md").write_text("outside\n", encoding="utf-8")
        self.put("MEMORY.md", "inside\n")
        if not make_link(self.root() / "memory", outside):
            self.skipTest("no symlink or junction can be made here")
        self.assertTrue(store.is_reparse(self.root() / "memory"))
        for action in (lambda: bot_memory.read_file(self.id, "memory/secret.md"),
                       lambda: self.put("memory/new.md", "x\n"),
                       lambda: bot_memory.read_file(self.id, "memory/archive.md")):
            with self.assertRaises(store.PathRefused):
                action()
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["secret.md"], "nothing was written outside")
        self.assertNotIn("memory/secret.md", store.list_files(self.id))
        self.assertEqual(self.index()["text"], "inside\n")

    def test_a_linked_workspace_is_refused(self):
        outside = Path(tempfile.mkdtemp(prefix="kairos-outside-", dir=_DATA.name))
        bot_memory.remove_bot(self.id)
        if not make_link(self.root(), outside):
            self.skipTest("no symlink or junction can be made here")
        with self.assertRaises(store.PathRefused):
            self.put("MEMORY.md", "x\n")
        self.assertEqual(list(outside.iterdir()), [])
        os.rmdir(self.root())

    def test_writes_are_atomic_and_leave_no_temporary_files(self):
        self.put("MEMORY.md", "one\n")
        with patch("os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                store.write_bytes(self.id, "MEMORY.md", b"two\n")
        self.assertEqual(self.index()["text"], "one\n")
        self.assertEqual([p.name for p in self.root().iterdir() if p.name.endswith(".tmp")], [])


class CapacityTests(NotebookCase):
    def test_prompt_clip_is_the_lower_of_200_lines_and_24576_bytes_and_never_splits_a_character(self):
        lines = "".join(f"line {i}\n" for i in range(300))
        clipped, info = store.clip_index(lines)
        self.assertEqual((info["loaded_lines"], info["stored_lines"], info["clipped"]), (200, 300, True))
        self.assertEqual(clipped.count("\n"), 200)
        wide = ("\u00e9" * 99 + "\n") * 150      # 200 bytes a line: the bytes arrive first
        clipped, info = store.clip_index(wide)
        self.assertLessEqual(len(clipped.encode("utf-8")), 24_576)
        self.assertLess(info["loaded_lines"], 150)
        self.assertEqual(info["stored_bytes"], len(wide.encode("utf-8")))
        clipped.encode("utf-8").decode("utf-8")
        cut, info = store.clip_index("\U0001F600" * 7000)   # one 28,000-byte line: cut on a character boundary
        self.assertEqual(len(cut.encode("utf-8")) % 4, 0)
        self.assertEqual(info["loaded_bytes"], len(cut.encode("utf-8")))
        small, info = store.clip_index("fits\n")
        self.assertEqual((small, info["clipped"]), ("fits\n", False))

    def test_overview_reports_loaded_versus_stored(self):
        self.put("MEMORY.md", "".join(f"- note {i}\n" for i in range(250)))
        capacity = bot_memory.overview(self.id)["index"]
        self.assertEqual((capacity["loaded_lines"], capacity["stored_lines"], capacity["clipped"]), (200, 250, True))
        self.assertEqual((capacity["line_limit"], capacity["byte_limit"]), (200, 24576))
        text, info = bot_memory.prompt_index(self.id)
        self.assertEqual(text.count("\n"), 200)

    def test_oversize_writes_are_413_and_nothing_is_truncated(self):
        before = self.index()["hash"]
        with self.assertRaises(store.CapacityError):
            self.put("MEMORY.md", "x" * (512 * 1024 + 1))
        with self.assertRaises(store.CapacityError):
            self.put("memory/big.md", "x" * (64 * 1024 + 1))
        self.assertEqual(self.index()["hash"], before)
        self.assertFalse((self.root() / "memory" / "big.md").exists())
        self.put("MEMORY.md", "x" * (512 * 1024))
        self.assertEqual(self.index()["bytes"], 512 * 1024)
        self.put("memory/log/2026-10-29.md", "y" * 100)
        with self.assertRaises(store.CapacityError):
            self.put("memory/archive.md", "z" * (512 * 1024 + 1))

    def test_a_non_utf8_file_is_refused_to_the_editor_not_rewritten(self):
        (self.root() / "memory").mkdir(parents=True, exist_ok=True)
        (self.root() / "memory" / "odd.md").write_bytes(b"caf\xe9\n")
        with self.assertRaises(store.NotebookError):
            bot_memory.read_file(self.id, "memory/odd.md")
        self.assertEqual((self.root() / "memory" / "odd.md").read_bytes(), b"caf\xe9\n")


class EntryTests(NotebookCase):
    def append(self, section, text, **kw):
        current = self.index()
        return bot_memory.apply_entry(self.id, "append", store.INDEX_NAME, current["hash"], section=section, body=text,
                                      actor="person", **kw)

    def entry_ids(self):
        return {e.text: e.eid for e in entries.parse(self.index()["text"]).entries}

    def test_both_grammars_parse_and_legacy_lines_are_not_rewritten(self):
        legacy = ("## Notes\n- 2026-10-01: old style\n- 2026-10-02 (until 2026-12-01): old with expiry\n"
                  "- not-a-date: personal\nPerson wrote this.\n")
        self.put("MEMORY.md", legacy)
        result = self.append("Notes", "new style \u00b7 with a dot", until="2999-01-01")
        text = self.index()["text"]
        self.assertTrue(text.startswith(legacy))
        self.assertIn(f"- {TODAY.isoformat()} \u00b7 from owner \u00b7 new style \u00b7 with a dot \u00b7 until 2999-01-01\n", text)
        parsed = {e.text: e for e in entries.parse(text).entries}
        self.assertTrue(parsed["old style"].legacy)
        self.assertEqual(parsed["old with expiry"].until, date(2026, 12, 1))
        fresh = parsed["new style \u00b7 with a dot"]
        self.assertEqual((fresh.source, fresh.until, fresh.legacy), ("owner", date(2999, 1, 1), False))
        self.assertNotIn("personal", parsed)
        self.assertTrue(result["changed"])

    def test_expiry_uses_the_local_date_and_today_is_expired(self):
        self.assertTrue(entries.parse(f"## N\n- 2020-01-01 (until {TODAY.isoformat()}): ends today\n").entries[0].expired(TODAY))
        tomorrow = (TODAY + timedelta(days=1)).isoformat()
        self.assertFalse(entries.parse(f"## N\n- 2020-01-01 \u00b7 from owner \u00b7 stays \u00b7 until {tomorrow}\n").entries[0].expired(TODAY))
        malformed = entries.parse("## N\n- 2020-01-01 (until 2021-99-99): typo expiry\n- 2020-01-01 (until nonsense: broken\n").entries
        self.assertEqual([e.until for e in malformed], [None, None])   # a typo in the expiry never hides a note
        noon = datetime(2030, 3, 4, 12).timestamp()
        self.assertEqual(entries.local_today(noon), date(2030, 3, 4))

    def test_the_four_actions(self):
        self.append("Preferences", "likes short replies")
        self.append("Preferences", "likes charts")
        ids = self.entry_ids()
        current = self.index()
        bot_memory.apply_entry(self.id, "replace", "MEMORY.md", current["hash"], body="likes long replies",
                               target=ids["likes short replies"], actor="person")
        text = self.index()["text"]
        self.assertIn("likes long replies", text)
        self.assertNotIn("likes short replies", text)
        ids = self.entry_ids()
        bot_memory.apply_entry(self.id, "supersede", "MEMORY.md", self.index()["hash"], body="likes diagrams",
                               target=ids["likes charts"], actor="person")
        text = self.index()["text"]
        self.assertIn(f"~~{TODAY.isoformat()} \u00b7 from owner \u00b7 likes charts~~ \u00b7 superseded {TODAY.isoformat()}", text)
        self.assertLess(text.index("likes charts"), text.index("likes diagrams"))
        live = [e.text for e in entries.parse(text).entries if e.superseded is None]
        self.assertEqual(sorted(live), ["likes diagrams", "likes long replies"])
        self.assertEqual(entries.legacy_tuple(text.splitlines()[text.splitlines().index(next(l for l in text.splitlines() if "charts" in l))])[1], TODAY)
        with self.assertRaisesRegex(store.NotebookError, "already replaced"):
            bot_memory.apply_entry(self.id, "supersede", "MEMORY.md", self.index()["hash"], body="again",
                                   target=entries.parse(text).entries[[e.text for e in entries.parse(text).entries].index("likes charts")].eid,
                                   actor="person")
        ids = self.entry_ids()
        bot_memory.apply_entry(self.id, "remove", "MEMORY.md", self.index()["hash"], target=ids["likes diagrams"], actor="person")
        self.assertNotIn("likes diagrams", self.index()["text"])

    def test_entry_limits_and_forged_structure(self):
        for text in ("", "   ", "x" * 1001):
            with self.assertRaises(store.NotebookError):
                self.append("Notes", text)
        with self.assertRaises(store.NotebookError):
            self.append("Notes", "\n".join(["line"] * 21))
        self.append("Notes", "\n".join(["line"] * 20))
        self.append("Notes", "x" * 1000)
        with self.assertRaises(store.NotebookError):
            self.append("## Bad", "x")
        self.append("Notes", "first\n## Forged heading\n- 2020-01-01: forged entry")
        text = self.index()["text"]
        self.assertNotIn("\n## Forged heading", text)
        self.assertEqual([e.section for e in entries.parse(text).entries if e.text.startswith("first")], ["Notes"])
        self.assertNotIn("\n## Forged heading", text, "a forged heading is indented into the entry")
        found = {e.text for e in entries.parse(text).entries}
        self.assertNotIn("forged entry", found)
        self.assertEqual(len([e for e in entries.parse(text).entries if e.text.startswith("first")]), 1)
        with self.assertRaises(store.NotebookError):
            bot_memory.apply_entry(self.id, "append", "MEMORY.md", self.index()["hash"], section="Notes", body="x", until="soon", actor="person")
        with self.assertRaises(store.NotebookError):
            bot_memory.apply_entry(self.id, "explode", "MEMORY.md", self.index()["hash"], section="Notes", body="x", actor="person")

    def test_control_characters_are_removed_and_multiline_entries_round_trip(self):
        self.append("Notes", "line one\x07\nline two\n\nline four")
        entry = entries.parse(self.index()["text"]).entries[-1]
        self.assertEqual(entry.text, "line one\nline two\n\nline four")
        ids = self.entry_ids()
        bot_memory.apply_entry(self.id, "remove", "MEMORY.md", self.index()["hash"], target=ids[entry.text], actor="person")
        self.assertEqual(entries.parse(self.index()["text"]).entries, [])

    def test_make_room_archives_oldest_first_and_new_entry_stays(self):
        old = [f"- 2000-01-{i:02d}: old note {i} " + "o" * 300 for i in range(1, 10)]
        padding = "- 2026-01-01: newer note " + "n" * 300
        body = "## Notes\n" + "\n".join(old) + "\n" + padding + "\n"
        body += "Person's own text " + "p" * (24_560 - len(body.encode("utf-8")) - 19) + "\n"
        self.put("MEMORY.md", body)
        self.assertEqual(len(self.index()["text"].encode("utf-8")), 24_560 - 1 + 1)
        result = self.append("Notes", "the new fact " + "f" * 100)
        text = self.index()["text"]
        self.assertIn("the new fact", text)
        self.assertGreaterEqual(result["displaced"], 1)
        self.assertNotIn("old note 1 ", text)
        self.assertIn("newer note", text)
        self.assertIn("Person's own text", text)
        archive = bot_memory.read_file(self.id, store.ARCHIVE_PATH)["text"]
        self.assertIn("old note 1 ", archive)
        self.assertIn(f"## Archived {TODAY.isoformat()}", archive)
        self.assertFalse(store.over_load_limits(text))
        self.assertEqual(bot_memory.apply_entry(self.id, "append", "MEMORY.md", self.index()["hash"], section="Notes", body="again", actor="person")["displaced"], 0)

    def test_safety_and_health_facts_are_never_moved_and_a_conflict_leaves_the_document_alone(self):
        health = "- 2000-01-01: Allergic to penicillin, carries an epipen " + "h" * 200
        safety = "- 2000-01-02: Safety word is pineapple " + "s" * 200
        body = "## Notes\n" + health + "\n" + safety + "\n"
        body += "- 2000-01-03: ordinary old note " + "x" * 100 + "\n"
        body += "Hand-written paragraph " + "p" * (24_576 - len(body.encode("utf-8")) - 24) + "\n"
        self.put("MEMORY.md", body)
        self.append("Notes", "a new fact")          # the ordinary old note goes, never the protected ones
        text = self.index()["text"]
        self.assertIn("Allergic to penicillin", text)
        self.assertIn("Safety word is pineapple", text)
        self.assertNotIn("ordinary old note", text)
        before = self.index()
        with self.assertRaises(store.CapacityConflict) as caught:
            self.append("Notes", "x" * 600)
        self.assertEqual(caught.exception.status, 409)
        self.assertIn("hand-written", str(caught.exception))
        self.assertEqual(self.index()["hash"], before["hash"], "the document is unchanged")
        self.assertFalse(entries.is_protected_text("likes jazz"))
        self.assertTrue(entries.is_protected_text("has a seizure disorder"))

    def test_stale_hash_is_409_with_current_and_nothing_is_written(self):
        self.put("MEMORY.md", "mine\n")
        stale = self.index()["hash"]
        self.put("MEMORY.md", "someone else\n")
        with self.assertRaises(store.StaleState) as caught:
            bot_memory.apply_entry(self.id, "append", "MEMORY.md", stale, section="Notes", body="x", actor="person")
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.current, {"MEMORY.md": self.index()["hash"]})
        self.assertEqual(self.index()["text"], "someone else\n")
        with self.assertRaises(store.NotebookError):   # a missing hash is not a pass
            bot_memory.apply_transaction(self.id, [{"path": "MEMORY.md", "content": "x"}], actor="person", source="t")
        with self.assertRaises(store.StaleState):       # "absent" only creates
            bot_memory.write_text(self.id, "MEMORY.md", "x", ABSENT, actor="person", source="t")


class AdapterTests(NotebookCase):
    def test_memory_methods_are_adapters_to_the_notebook(self):
        agent_service.write_memory(self.id, "# Scout\n\n## Notes\n- 2026-10-01: legacy line\n")
        self.assertEqual(Path(agent_service._memory_path(self.id)), self.root() / "MEMORY.md")
        self.assertEqual((self.root() / "MEMORY.md").read_text(encoding="utf-8"), agent_service.read_memory(self.id))
        agent_service.remember(self.id, "Notes", "from the tool")
        self.assertIn(f"- {TODAY.isoformat()} \u00b7 from agent \u00b7 from the tool\n", agent_service.read_memory(self.id))
        rows = journal.rows(self.id)
        self.assertEqual([r["actor"] for r in rows[:2]], ["bot", "person"])
        self.assertEqual(rows[0]["source"], "agent")
        agent_service.remember(self.id, "Notes", "topic fact", topic="hiring", description="Hiring criteria")
        self.assertEqual(agent_service.topic_index(self.id), [("hiring", "Hiring criteria")])
        self.assertTrue(agent_service.read_topic(self.id, "hiring").startswith("---\ntitle: hiring\ndescription: Hiring criteria\n---\n"))
        self.assertIn("topic fact", agent_service.read_topic(self.id, "hiring"))
        self.assertIn("No memory topic", agent_service.read_topic(self.id, "missing"))
        self.assertIn("Invalid memory topic", agent_service.read_topic(self.id, "../x"))
        self.assertIn("Invalid memory topic", agent_service.read_topic(self.id, "archive"))

    def test_soul_path_no_longer_depends_on_the_memory_path(self):
        soul = Path(agent_service._soul_path(self.id))
        self.assertEqual(soul, Path(_DATA.name) / "agents" / self.id / "SOUL.md")
        self.assertNotEqual(soul.parent, Path(agent_service._memory_path(self.id)).parent)
        with patch.object(agent_service, "_memory_path", side_effect=AssertionError("soul must not ask the memory path")):
            self.assertEqual(Path(agent_service._soul_path(self.id)), soul)
            agent_service.update(self.id, soul="Be brief.")
            self.assertEqual(soul.read_text(encoding="utf-8"), "Be brief.")
        with self.assertRaises(ValueError):
            agent_service._soul_path("not-an-id")

    def test_deleting_a_bot_removes_its_notebook_state_and_runs_hooks(self):
        agent_service.remember(self.id, "Notes", "something")
        seen = []
        agent_service.on_delete(seen.append)
        self.addCleanup(lambda: agent_service._delete_hooks.remove(seen.append))
        self.assertTrue(self.root().exists() and store.state_dir(self.id).exists())
        agent_service.delete(self.id)
        self.assertFalse(self.root().exists())
        self.assertFalse(store.state_dir(self.id).exists())
        self.assertFalse((Path(_DATA.name) / "agents" / self.id / "SOUL.md").exists())
        self.assertEqual(seen, [self.id])

    def test_configured_create_seeds_and_task_corrections_use_the_notebook_transaction(self):
        from services import bot_record
        result = bot_record.create_configured({"profile": {"name": "Seeded"}, "memory_seed": [{"section": "Preferences", "text": "short replies"}]},
                                              owner_user="david")
        made = result["agent"]
        bot_id = made["id"]
        self.addCleanup(lambda: agent_service.get(bot_id) and agent_service.delete(bot_id))
        self.assertIn("short replies", bot_memory.read_file(bot_id, "MEMORY.md")["text"])
        self.assertTrue(any(row["path"] == "MEMORY.md" for row in journal.rows(bot_id)))
        card = task_service.create_task("Draft summary", "do it", "card", status="ready", agent_id=self.id)
        task_service.set_card_status(card["id"], "review")
        task_service.set_card_status(card["id"], "ready", note="drop closed postings")
        self.assertIn('On "Draft summary": drop closed postings', bot_memory.read_file(self.id, "MEMORY.md")["text"])
        self.assertEqual(journal.rows(self.id)[0]["summary"].split(";")[0], "Added a note to Corrections")

    def test_the_tool_registry_remember_goes_through_the_notebook(self):
        ctx = tool_registry.ToolContext(agent_id=self.id)
        result = asyncio.run(tool_registry.call("agent_remember", {"section": "Notes", "text": "tool made"}, ctx, tool_registry.OPENAI))
        self.assertTrue(result.startswith("Noted"), result)
        self.assertIn("tool made", agent_service.read_memory(self.id))
        self.assertEqual(journal.rows(self.id)[0]["actor"], "bot")

    def test_prompt_surfaces_clip_the_index_and_skip_expired_and_superseded_notes(self):
        from services.agent_service import identity_block
        body = "## Notes\n" + "".join(f"- 2026-01-01: filler {i} " + "z" * 100 + "\n" for i in range(300))
        self.put("MEMORY.md", body + f"- 2020-01-01 \u00b7 from owner \u00b7 gone \u00b7 until {TODAY.isoformat()}\n"
                 f"- ~~2020-01-01 \u00b7 from owner \u00b7 struck~~ \u00b7 superseded {TODAY.isoformat()}\n")
        block = identity_block(self.bot, agent_service.read_memory(self.id), chat=True)
        self.assertLessEqual(len(block.encode("utf-8")), 24_576 + 4_000)
        self.assertNotIn("filler 299", block)
        self.assertIn("filler 0", block)
        small = "## Notes\n- 2026-01-01: keep\n" + f"- 2020-01-01 \u00b7 from owner \u00b7 gone \u00b7 until {TODAY.isoformat()}\n" \
                f"- ~~2020-01-01 \u00b7 from owner \u00b7 struck~~ \u00b7 superseded {TODAY.isoformat()}\n"
        block = identity_block(self.bot, small)
        self.assertIn("keep", block)
        self.assertNotIn("gone", block)
        self.assertNotIn("struck", block)


class RouteTests(NotebookCase):
    BASE = "/api/bots"

    def url(self, tail=""):
        return f"{self.BASE}/{self.id}/memory{tail}"

    def file(self, path):
        return web.get(self.url("/file"), params={"path": path})

    def test_overview_files_and_the_whole_cycle(self):
        data = web.get(self.url()).json()
        self.assertEqual((data["enabled"], data["index"]["exists"]), (True, True))
        self.assertEqual(data["index"]["hash"], bot_memory.read_file(self.id, "MEMORY.md")["hash"])
        self.assertIn("MEMORY.md", [f["path"] for f in data["files"]])
        created = web.put(self.url("/file"), params={"path": "memory/hiring.md"},
                          json={"text": "---\ntitle: Hiring\ndescription: Hiring criteria\n---\nremote only\n", "expected_hash": ABSENT})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["file"]["description"], "Hiring criteria")
        topic = [f for f in web.get(self.url()).json()["files"] if f["path"] == "memory/hiring.md"][0]
        self.assertEqual((topic["kind"], topic["title"]), ("topic", "Hiring"))
        edited = web.put(self.url("/file"), params={"path": "memory/hiring.md"},
                         json={"text": "changed\n", "expected_hash": topic["hash"]})
        self.assertEqual(edited.status_code, 200)
        stale = web.put(self.url("/file"), params={"path": "memory/hiring.md"}, json={"text": "again\n", "expected_hash": topic["hash"]})
        self.assertEqual(stale.status_code, 409)
        read = self.file("memory/hiring.md").json()
        self.assertEqual(read["text"], "changed\n")
        gone = web.delete(self.url("/file"), params={"path": "memory/hiring.md", "expected_hash": read["hash"]})
        self.assertEqual(gone.status_code, 200)
        self.assertEqual(self.file("memory/hiring.md").status_code, 404)
        self.assertEqual(web.delete(self.url("/file"), params={"path": "memory/hiring.md", "expected_hash": ABSENT}).status_code, 404)
        self.assertEqual(web.delete(self.url("/file"), params={"path": "memory/hiring.md", "expected_hash": read["hash"]}).status_code, 409)

    def test_refusals_use_the_standard_codes(self):
        index = self.file("MEMORY.md").json()
        self.assertEqual(web.delete(self.url("/file"), params={"path": "MEMORY.md", "expected_hash": index["hash"]}).status_code, 403)
        log = "memory/log/2026-10-29.md"
        bot_memory.append_log(self.id, "2026-10-29", "a run happened", "run1")
        self.assertEqual(self.file(log).status_code, 200)
        self.assertTrue(self.file(log).json()["read_only"])
        current = self.file(log).json()["hash"]
        self.assertEqual(web.put(self.url("/file"), params={"path": log}, json={"text": "x", "expected_hash": current}).status_code, 403)
        self.assertEqual(web.delete(self.url("/file"), params={"path": log, "expected_hash": current}).status_code, 403)
        for bad in ("../MEMORY.md", "memory/../MEMORY.md", "C:/Windows/win.ini", "memory/a.md:stream", "/etc/passwd", "skills/x/SKILL.md", "nope.md"):
            with self.subTest(path=bad):
                self.assertIn(self.file(bad).status_code, (400, 403))
        too_big = web.put(self.url("/file"), params={"path": "memory/big.md"}, json={"text": "x" * (65 * 1024), "expected_hash": ABSENT})
        self.assertEqual(too_big.status_code, 413)
        self.assertEqual(web.put(self.url("/file"), params={"path": "MEMORY.md"}, json={"text": "x", "expected_hash": "nonsense"}).status_code, 400)
        self.assertEqual(web.put(self.url("/file"), params={"path": "MEMORY.md"}, json={"text": "x", "expected_hash": ABSENT, "extra": 1}).status_code, 422)
        self.assertEqual(web.get(f"{self.BASE}/ffffffffff/memory").status_code, 404)
        self.assertEqual(web.get(f"{self.BASE}/not-an-id/memory").status_code, 404)

    def test_entries_journal_and_undo(self):
        index = web.get(self.url()).json()["index"]
        added = web.post(self.url("/entries"), json={"action": "append", "expected_hash": index["hash"], "section": "Preferences", "text": "likes maps"})
        self.assertEqual(added.status_code, 200, added.text)
        self.assertIn("likes maps", added.json()["file"]["text"])
        self.assertEqual(web.post(self.url("/entries"), json={"action": "append", "expected_hash": index["hash"], "text": "stale"}).status_code, 409)
        self.assertEqual(web.post(self.url("/entries"), json={"action": "append", "path": "memory/archive.md", "expected_hash": ABSENT, "text": "x"}).status_code, 400)
        rows = web.get(self.url("/journal")).json()["rows"]
        self.assertEqual((rows[0]["actor"], rows[0]["source"], rows[0]["operation"]), ("person", "owner", "edit"))
        self.assertIn("likes maps", rows[0]["diff"])
        self.assertTrue(rows[0]["revertible"])
        self.assertNotIn("snapshot", rows[0]["files"][0])
        undone = web.post(self.url(f"/journal/{rows[0]['id']}/revert"))
        self.assertEqual(undone.status_code, 200, undone.text)
        self.assertNotIn("likes maps", self.file("MEMORY.md").json()["text"])
        self.assertEqual(web.post(self.url(f"/journal/{rows[0]['id']}/revert")).status_code, 409, "undoing twice is refused")
        self.assertEqual(web.post(self.url("/journal/nothing/revert")).status_code, 404)
        self.assertEqual(web.get(self.url("/journal"), params={"limit": 500}).status_code, 422)

    def test_settings_tidy_and_open(self):
        self.assertEqual(web.patch(self.url("/settings"), json={"upkeep": True, "room_capture": True}).json()["upkeep"], True)
        self.assertTrue(agent_service.get(self.id)["memory_upkeep"])
        data = web.patch(self.url("/settings"), json={"enabled": False}).json()
        self.assertEqual((data["enabled"], data["room_capture"]), (False, True))
        self.assertEqual(web.get(self.url()).json()["enabled"], False)
        self.assertEqual(web.patch(self.url("/settings"), json={"enabled": "yes"}).status_code, 422)
        self.assertEqual(web.patch(self.url("/settings"), json={"nope": 1}).status_code, 422)
        web.patch(self.url("/settings"), json={"enabled": True, "upkeep": False})
        self.assertEqual(web.post(self.url("/tidy")).status_code, 409, "tidy needs upkeep on")
        web.patch(self.url("/settings"), json={"upkeep": True})
        agent_service.write_memory(self.id, f"## Notes\n- 2020-01-01 (until 2021-01-01): expired\n- 2022-01-01: newest\n")
        done = web.post(self.url("/tidy"))
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(len(done.json()["passes"]), 1)
        self.assertNotIn("expired", agent_service.read_memory(self.id))
        self.assertEqual(web.get(self.url("/upkeep")).json()["entries"][0]["status"], "committed")
        opened = []
        with patch.object(bot_memory_routes, "opener", lambda kind, folder: opened.append((kind, folder))):
            self.assertEqual(web.post(self.url("/open"), json={"target": "folder"}).status_code, 200)
            self.assertEqual(web.post(self.url("/open"), json={"target": "obsidian"}).status_code, 200)
            self.assertEqual(web.post(self.url("/open"), json={"target": "../.."}).status_code, 400)
            remote = TestClient(app, client=("203.0.113.9", 4000))
            self.assertEqual(remote.post(self.url("/open"), json={"target": "folder"}).status_code, 403)
        self.assertEqual(opened, [("folder", str(self.root())), ("obsidian", str(self.root()))])

    def test_opening_uses_fixed_arguments_and_no_shell(self):
        with patch.object(bot_memory_routes.sys, "platform", "linux"), patch.object(bot_memory_routes.subprocess, "Popen") as popen:
            bot_memory_routes._open_target("obsidian", "/tmp/x y")
        args, kwargs = popen.call_args
        self.assertEqual(args[0][0], "xdg-open")
        self.assertTrue(args[0][1].startswith("obsidian://open?path=%2Ftmp%2Fx%20y"))
        self.assertFalse(kwargs.get("shell"))

    def test_every_route_needs_an_admin(self):
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        auth_manager.create_user("bob", "bob-password-1")
        auth_manager.create_user("boss", "boss-password-1", is_admin=True)
        locked = FastAPI()
        locked.include_router(bot_memory_routes.router)

        def caller(user):
            client = TestClient(locked, client=("127.0.0.1", 5000))
            if user:
                client.cookies.set(SESSION_COOKIE_NAME, auth_manager.create_session(user))
            return client

        swept = 0
        for route in bot_memory_routes.router.routes:
            for method in route.methods - {"HEAD", "OPTIONS"}:
                path = route.path.replace("{bot_id}", self.id).replace("{change}", "abc")
                for who in ("bob", None):
                    got = caller(who).request(method, path, json=None if method == "GET" else {}, params={"path": "MEMORY.md", "expected_hash": ABSENT})
                    self.assertIn(got.status_code, (401, 403), f"{who} {method} {path} -> {got.status_code}")
                swept += 1
        self.assertEqual(swept, len([m for r in bot_memory_routes.router.routes for m in r.methods - {"HEAD", "OPTIONS"}]))
        self.assertGreaterEqual(swept, 11)
        self.assertEqual(caller("boss").get(self.url()).status_code, 200)

    def test_the_aggregate_router_mounts_the_notebook_routes_and_tolerates_missing_units(self):
        self.assertIn("bot_memory_routes", bot_resources_routes.included)
        full = FastAPI()
        full.include_router(bot_resources_routes.router)
        full.dependency_overrides[require_admin] = lambda: "david"
        self.assertIn("/api/bots/{bot_id}/memory", full.openapi()["paths"])
        self.assertEqual(TestClient(full).get(self.url()).status_code, 200)


if __name__ == "__main__":
    unittest.main()
