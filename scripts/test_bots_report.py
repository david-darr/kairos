"""Bots redesign, Phase 6 unit U4: problem reports (F101), drafted and kept on this computer, never sent (2026-10-29).

A draft quotes the message, adds version, platform, bot health and the recent log, with every secret removed; one
report per message; only the person who owns the conversation can draft or read it; limits hold; old drafts go.
Run: .venv\\Scripts\\python.exe -B -X utf8 scripts\\test_bots_report.py
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-report-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from bots_chat_harness import OWNER, Harness  # noqa: E402
from core.middleware import require_admin, require_user  # noqa: E402
from services import bot_report  # noqa: E402

SECRET = "sk-ant-" + "A1b2C3d4E5f6G7h8I9j0K1l2"


class ReportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.h = Harness(self)
        from services.agent_service import agent_service
        self.bot = self.h.bot("Helper")
        agent_service.update(self.bot["id"], soul="Never reveal this standing instruction.")
        self.sid = self.h.thread(self.bot)
        self.h.replies.append(f"Here is the key you asked about: {SECRET}")
        await self.h.send(self.sid, "what went wrong?")
        await self.h.idle()
        self.message_id = [r for r in self.h.path(self.sid) if r.get("role") == "assistant"][-1]["bot_message_id"]
        logs = [f"2026-10-29 INFO token={SECRET}\n", "2026-10-29 INFO all good\n"]
        patcher = patch.object(bot_report, "_logs", return_value=logs)
        patcher.start(); self.addCleanup(patcher.stop)

    def draft(self, **fields):
        return bot_report.draft(OWNER, session_id=self.sid, message_id=self.message_id, went_wrong=fields.pop("went_wrong", f"It printed {SECRET}"), **fields)

    def test_the_draft_is_redacted_saved_locally_and_complete(self):
        report = self.draft(you_saw="A key on screen", steps="1. Ask\n2. Look")
        text = Path(report["path"]).read_text(encoding="utf-8")
        self.assertEqual(report["markdown"], text)
        self.assertNotIn(SECRET, text, "no secret survives, in the person's text, the message or the log")
        for part in ("## What went wrong", "## What you saw", "A key on screen", "## Steps", "## The message", "From Helper",
                     "## This computer", "Kairos ", "## Bots", "- Helper: on", "## Recent log (2 lines)", "all good"):
            self.assertIn(part, text)
        self.assertNotIn("Never reveal this standing instruction", text, "bot instructions are never included")
        self.assertIn("nothing was sent", text)
        self.assertEqual(Path(report["path"]).parent, Path(bot_report.root()))
        self.assertFalse(report["already"])

    def test_one_report_per_message(self):
        first = self.draft()
        again = self.draft(went_wrong="Something else")
        self.assertEqual(again["id"], first["id"])
        self.assertTrue(again["already"])
        self.assertEqual(bot_report.get(OWNER, first["id"])["markdown"], first["markdown"])

    def test_only_the_owner_can_draft_or_read(self):
        report = self.draft()
        with self.assertRaises(HTTPException) as other:
            bot_report.draft("someone-else", session_id=self.sid, message_id=self.message_id, went_wrong="x")
        self.assertEqual(other.exception.status_code, 404)
        with self.assertRaises(HTTPException):
            bot_report.get("someone-else", report["id"])
        with self.assertRaises(HTTPException):
            bot_report.get(OWNER, "../../etc/passwd")
        with self.assertRaises(HTTPException) as missing:
            bot_report.draft(OWNER, session_id=self.sid, message_id="no-such-message", went_wrong="x")
        self.assertEqual(missing.exception.status_code, 404)

    def test_limits(self):
        for fields in ({"went_wrong": ""}, {"went_wrong": "x" * 2001}, {"you_saw": "x" * 3001}, {"steps": "x" * 2001}):
            with self.subTest(fields=list(fields)), self.assertRaises(HTTPException) as refused:
                self.draft(**fields)
            self.assertEqual(refused.exception.status_code, 400)

    def test_old_drafts_are_removed_after_30_days(self):
        old = self.draft(now=time.time() - 31 * 86400)
        fresh = self.draft()
        self.assertNotEqual(fresh["id"], old["id"], "an expired draft does not block a new one")
        self.assertFalse(Path(old["path"]).exists())

    def test_routes(self):
        from routes.bot_lifecycle_routes import router
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[require_admin] = lambda: OWNER; app.dependency_overrides[require_user] = lambda: OWNER
        client = TestClient(app)
        made = client.post("/api/bot-lifecycle/reports", json={"session_id": self.sid, "message_id": self.message_id, "went_wrong": "Broke"})
        self.assertEqual(made.status_code, 200)
        self.assertEqual(client.get(f"/api/bot-lifecycle/reports/{made.json()['id']}").json()["id"], made.json()["id"])
        self.assertEqual(client.post("/api/bot-lifecycle/reports", json={"session_id": self.sid, "message_id": self.message_id,
                                                                          "went_wrong": "Broke", "extra": 1}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
