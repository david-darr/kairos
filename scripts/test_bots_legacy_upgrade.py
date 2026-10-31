"""An Agents 2.0 data folder becomes Bots without losing anything (2026-10-31).

scripts/fixtures/legacy-agents-v2/ was written by the v2.2.0 code itself: three agents (instructions only, a soul that
differs from its instructions, a soul only), peers, memory notes with a topic and an end date, two agent chats, a daily
and an interval routine plus a work card, two inbox items, a GitHub webhook and a pinned agent. The webhook's secret is
a placeholder. A copy is converted with today's code, then read back through the same services the app uses.
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "legacy-agents-v2"
_DATA = tempfile.TemporaryDirectory(prefix="kairos-legacy-agents-", ignore_cleanup_errors=True)
DATA = Path(_DATA.name) / "data"
shutil.copytree(FIXTURE, DATA)
os.environ["JARVIS_DATA_DIR"] = str(DATA)
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BEFORE = json.loads((FIXTURE / "agents.json").read_text(encoding="utf-8"))
RESEARCHER, WRITER, PLANNER = (next(i for i, a in BEFORE.items() if a["name"] == n) for n in ("Researcher", "Writer", "Planner"))

from core import bot_rooms_store  # noqa: E402
from services.agent_service import agent_service  # noqa: E402  the record upgrade and memory migration run here
from services import bot_attention, bot_routines  # noqa: E402
from core.session_manager import session_manager  # noqa: E402


def old_lines(path):
    return [ln.strip() for ln in (FIXTURE / "agents" / path).read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")]


def notebook(bot_id):
    root = DATA / "bot-workspaces" / bot_id
    return "\n".join(f.read_text(encoding="utf-8") for f in root.rglob("*.md")) if root.is_dir() else ""


class LegacyUpgrade(unittest.TestCase):
    def test_every_agent_keeps_its_identity_and_settings(self):
        for ident, old in BEFORE.items():
            new = agent_service.get(ident)
            self.assertIsNotNone(new, old["name"])
            for key in ("name", "role", "blurb", "color", "daily_run_cap", "keep_signed_in", "memory_upkeep", "peers", "endpoint_id", "avatar"):
                self.assertEqual(new.get(key), old.get(key), f"{old['name']} {key}")
            self.assertEqual(new["approval_mode"], "full", "the Bots default (decision 6)")
            self.assertNotIn("instructions", new, "one standing-instruction field")

    def test_standing_instructions_are_kept_and_what_the_model_saw_is_unchanged(self):
        # The old prompt used `soul or instructions` (v2.2.0 identity_block), so the soul field now carries exactly that.
        self.assertEqual(agent_service.get(RESEARCHER)["soul"], BEFORE[RESEARCHER]["instructions"])
        self.assertEqual(agent_service.get(WRITER)["soul"], BEFORE[WRITER]["soul"])
        self.assertEqual(agent_service.get(WRITER)["instructions_legacy"], BEFORE[WRITER]["instructions"], "unused old text is kept, not dropped")
        self.assertEqual(agent_service.get(PLANNER)["soul"], BEFORE[PLANNER]["soul"])
        self.assertTrue((DATA / "agents.json.pre-bots").exists(), "the old records are backed up before the first write")

    def test_every_memory_line_reaches_the_new_notebook(self):
        for ident in BEFORE:
            moved = notebook(ident)
            for path in [p.relative_to(FIXTURE / "agents").as_posix() for p in (FIXTURE / "agents" / ident).rglob("*.md") if p.name != "SOUL.md"]:
                for line in old_lines(path):
                    self.assertIn(line, moved, f"{path}: {line}")

    def test_agent_chats_stay_with_their_bots(self):
        old = sqlite3.connect(FIXTURE / "sessions.db")
        try:
            rows = old.execute("SELECT id, agent_id, message_count FROM sessions WHERE agent_id IS NOT NULL").fetchall()
        finally:
            old.close()
        self.assertEqual(len(rows), 2)
        for sid, agent, count in rows:
            session = session_manager.get_session(sid)
            self.assertEqual(session["agent_id"], agent)
            self.assertEqual(len(session["messages"]), count)

    def test_routines_inbox_webhook_and_pin_carry_over(self):
        user = bot_attention.legacy_owner()
        listed = bot_routines.list_routines(user, True)
        listed = listed.get("items", listed.get("routines", [])) if isinstance(listed, dict) else listed
        names = {r.get("name") for r in listed}
        self.assertTrue({"Morning digest", "Hourly inbox check"} <= names, names)
        tasks = json.loads((DATA / "tasks.json").read_text(encoding="utf-8"))
        self.assertIn("Draft the release notes", {t["name"] for t in (tasks.values() if isinstance(tasks, dict) else tasks)}, "the work card stays")
        self.assertEqual(sorted(i["title"] for i in agent_service.inbox(status=None)), ["Draft ready", "Which sources count?"])
        self.assertEqual(len(bot_attention.inbox(user)["rows"]), 2, "and both reach the Bots inbox")
        hooks = json.loads((DATA / "triggers.json").read_text(encoding="utf-8"))["triggers"]
        self.assertEqual([(t["name"], t["agent_id"]) for t in hooks.values()], [("GitHub pushes", RESEARCHER)])
        prefs = json.loads((DATA / "agent_conversations.json").read_text(encoding="utf-8"))
        self.assertTrue(prefs["local"][f"agent:{RESEARCHER}"]["pinned"])

    def test_a_second_start_changes_nothing(self):
        from services import bot_record
        records = json.loads((DATA / "agents.json").read_text(encoding="utf-8"))
        self.assertFalse(bot_record.pending(records), "the upgrade is idempotent")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        bot_rooms_store.close()
        _DATA.cleanup()
