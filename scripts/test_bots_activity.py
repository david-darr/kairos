"""Bots Phase 1 unit U5: Activity, Inspector events, Today and Needs-you (2026-10-29).

Spec: Kairos Projects/Agents Redesign/phase-1-design.md, sections 3.4, 5.3 and 6.3.
Rows are real persisted runs and redacted runtime observations, never invented. Run:
python scripts/test_bots_activity.py
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory(prefix="kairos-bots-activity-", ignore_cleanup_errors=True)
os.environ["JARVIS_DATA_DIR"] = _DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from core import bot_attention_store as store  # noqa: E402
from core import session_manager_store as sessions  # noqa: E402
from core.middleware import require_admin  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from routes import bot_attention_routes  # noqa: E402
from services import bot_attention  # noqa: E402
from services.agent_service import agent_service  # noqa: E402

CURRENT = {"user": "david"}
app = FastAPI()
app.include_router(bot_attention_routes.router)
app.dependency_overrides[require_admin] = lambda: CURRENT["user"]
web = TestClient(app)
BASE = "/api/bot-attention"
SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"


class ActivityCase(unittest.TestCase):
    def setUp(self):
        CURRENT["user"] = "david"
        for patcher in (patch.dict(agent_service._agents, {}, clear=True), patch.object(agent_service, "_inbox", []),
                        patch("core.auth.auth_manager.is_admin", return_value=True)):
            patcher.start()
            self.addCleanup(patcher.stop)
        with store.database() as db:
            for table in ("receipts", "notifications", "inbox_state", "observations"):
                db.execute(f"DELETE FROM {table}")
        self.bot = agent_service.create("Scout")
        self.bot["owner_user"] = "david"
        self.session = self.thread("Main")

    def thread(self, title, owner="david", bot=None):
        sid = session_manager.create_session(title, owner_user=owner)["id"]
        session_manager.set_agent(sid, (bot or self.bot)["id"], "frozen")
        self.addCleanup(lambda: session_manager.get_session(sid) and session_manager.delete_session(sid))
        return sid

    def record(self, sid, outcome="completed", started=None, events=()):
        started = started or time.time() - 60
        run = {"id": f"run-{sid}-{started}", "surface": "chat", "session_id": sid, "agent_id": self.bot["id"], "model": "m",
               "started_at": started, "ended_at": started + 5, "outcome": outcome, "tool_calls": 1, "usage_complete": 0,
               "input_tokens": 120, "output_tokens": 30}
        sessions.record_run(run, [{"at": started + n, "kind": kind, "name": name, "ok": ok, "detail": detail, "seconds": 0.1}
                                  for n, (kind, name, ok, detail) in enumerate(events)])
        return run

    def runtime(self, sid=None, **fields):
        event = {"type": "bot.runtime", "ts": time.time(), "message": "m", "agent_id": self.bot["id"], "session_id": sid or self.session,
                 "data": {"type": "tool.started", "label": "Read file", **fields.pop("data", {})}, **fields}
        return bot_attention.ingest_event(event)


class ThreadEvents(ActivityCase):
    def test_persisted_run_timeline_is_labelled_as_a_kairos_observation(self):
        run = self.record(self.session, events=[("tool", "read_file", True, "notes.md"), ("tool", "run_command", False, "exit 1")])
        data = web.get(f"{BASE}/threads/{self.session}/events").json()
        self.assertEqual(data["total"], 2)
        self.assertEqual({e["source"] for e in data["entries"]}, {"kairos-run-timeline"})
        self.assertEqual({e["run_id"] for e in data["entries"]}, {run["id"]})
        self.assertEqual(data["runs"][0]["outcome"], "completed")
        self.assertEqual((data["runs"][0]["input_tokens"], data["runs"][0]["output_tokens"]), (120, 30))
        self.assertFalse([e for e in data["entries"] if "provider" in e["source"] or "native" in e["source"]])

    def test_runtime_observations_are_stored_once_and_ordered_newest_first(self):
        for n in range(3):
            self.runtime(event_id=f"e{n}", ts=time.time() + n, data={"label": f"Step {n}"})
        self.runtime(event_id="e1", data={"label": "Step 1 again"})
        entries = web.get(f"{BASE}/threads/{self.session}/events").json()["entries"]
        self.assertEqual([e["data"]["label"] for e in entries], ["Step 2", "Step 1", "Step 0"])
        self.assertTrue(all(e["source"] == "kairos-runtime" for e in entries))

    def test_event_redaction_on_the_way_in_and_out(self):
        self.runtime(event_id="r1", data={"label": f"Called with {SECRET}", "detail": "password = hunter2",
                                         "arguments": {"api_key": SECRET}, "token": SECRET})
        stored = json.dumps(store.observations("david")["entries"])
        self.assertNotIn(SECRET, stored)
        self.assertNotIn("hunter2", stored)
        self.assertNotIn("arguments", stored, "only an allowlist of fields is kept, never the raw payload")
        # A row stored by an older build is still scrubbed when read.
        store.observe("david", "legacy", self.bot["id"], self.session, time.time() + 5,
                      {"id": "legacy", "kind": "runtime", "at": time.time() + 5, "source": "kairos-runtime",
                       "data": {"label": f"Bearer abcdefgh12345678 and {SECRET}"}})
        body = web.get(f"{BASE}/threads/{self.session}/events").text
        self.assertNotIn(SECRET, body)
        self.assertNotIn("abcdefgh12345678", body)
        self.assertIn("[REDACTED]", body)

    def test_timeline_text_is_redacted_too(self):
        self.record(self.session, events=[("tool", "run_command", True, f"echo {SECRET}")])
        self.assertNotIn(SECRET, web.get(f"{BASE}/threads/{self.session}/events").text)

    def test_other_people_and_plain_chats_are_not_found(self):
        plain = session_manager.create_session("Plain chat", owner_user="david")["id"]
        self.addCleanup(session_manager.delete_session, plain)
        self.assertEqual(web.get(f"{BASE}/threads/{plain}/events").status_code, 404)
        self.assertEqual(web.get(f"{BASE}/threads/nope/events").status_code, 404)
        foreign = self.thread("Theirs", owner="sam")
        self.assertEqual(web.get(f"{BASE}/threads/{foreign}/events").status_code, 404)

    def test_limit_is_clamped(self):
        for n in range(5):
            self.runtime(event_id=f"c{n}", ts=time.time() + n)
        self.assertEqual(len(web.get(f"{BASE}/threads/{self.session}/events?limit=2").json()["entries"]), 2)
        self.assertEqual(web.get(f"{BASE}/threads/{self.session}/events?limit=99999").status_code, 200)

    def test_observation_store_keeps_a_bounded_tail(self):
        base = time.time() - 100
        with store.database() as db:  # bulk seed; the last 50 go through the real writer
            db.executemany("INSERT INTO observations(owner,id,bot,session,at,data) VALUES(?,?,?,?,?,?)",
                           [("david", f"o{n}", self.bot["id"], self.session, base + n * 0.01, json.dumps({"id": f"o{n}"})) for n in range(4000)])
        for n in range(4000, 4050):
            store.observe("david", f"o{n}", self.bot["id"], self.session, base + n * 0.01, {"id": f"o{n}", "at": base + n})
        listed = store.observations("david", session=self.session, limit=999)
        self.assertEqual((listed["total"], len(listed["entries"])), (4000, 400))
        store.observe("david", "ancient", self.bot["id"], self.session, time.time() - 40 * 86400, {"id": "ancient", "at": 0})
        self.assertNotIn("ancient", {e["id"] for e in store.observations("david", limit=400)["entries"]})


class BotActivity(ActivityCase):
    def test_activity_merges_threads_and_conversationless_observations(self):
        second = self.thread("Second")
        self.record(self.session, events=[("tool", "a", True, "one")])
        self.record(second, started=time.time() - 30, events=[("tool", "b", True, "two")])
        store.observe("david", "report1", self.bot["id"], None, time.time(), {"id": "report1", "kind": "runtime", "at": time.time(),
                                                                              "source": "kairos-runtime", "data": {"label": "Sent report"}})
        data = web.get(f"{BASE}/bots/{self.bot['id']}/activity").json()
        self.assertEqual(data["total"], 3)
        self.assertEqual(data["entries"][0]["id"], "report1", "newest first")
        targets = {e["id"]: e.get("target", {}).get("sessionId") for e in data["entries"]}
        self.assertEqual(sorted(t for t in targets.values() if t), sorted([self.session, second]))

    def test_activity_is_scoped_to_its_owner_and_bot(self):
        other = agent_service.create("Archivist")
        other["owner_user"] = "david"
        theirs = self.thread("Archivist chat", bot=other)
        self.record(theirs)
        self.record(self.session, events=[("tool", "mine", True, "x")])
        data = web.get(f"{BASE}/bots/{self.bot['id']}/activity").json()
        self.assertTrue(all(e.get("target", {}).get("sessionId") != theirs for e in data["entries"]))
        CURRENT["user"] = "sam"
        self.assertEqual(web.get(f"{BASE}/bots/{self.bot['id']}/activity").status_code, 404)
        self.assertEqual(web.get(f"{BASE}/bots/ghost/activity").status_code, 404)


class TodayReport(ActivityCase):
    def test_finished_runs_in_the_window_with_outcome_counts_and_targets(self):
        self.record(self.session, "completed", started=time.time() - 100)
        self.record(self.session, "failed", started=time.time() - 200)
        self.record(self.session, "completed", started=time.time() - 3 * 86400)
        data = web.get(f"{BASE}/today").json()
        self.assertEqual(len(data["finished"]), 2)
        self.assertEqual(data["counts"], {"completed": 1, "failed": 1})
        self.assertEqual(data["finished"][0]["target"]["sessionId"], self.session)
        wide = web.get(f"{BASE}/today", params={"since": time.time() - 5 * 86400}).json()
        self.assertEqual(len(wide["finished"]), 3)

    def test_needs_you_carries_open_questions_only(self):
        item = agent_service.add_item(self.bot["id"], "question", "Which slot?", "Pick")
        agent_service.add_item(self.bot["id"], "report", "Roundup", "Quiet")
        needs = web.get(f"{BASE}/needs-you").json()["rows"]
        self.assertEqual([r["id"] for r in needs], ["item:" + item["id"]])
        self.assertEqual([r["id"] for r in web.get(f"{BASE}/today").json()["needs_you"]], ["item:" + item["id"]])

    def test_another_persons_runs_never_appear(self):
        foreign = self.thread("Theirs", owner="sam")
        self.record(foreign)
        CURRENT["user"] = "david"
        self.assertEqual(web.get(f"{BASE}/today").json()["finished"], [])


if __name__ == "__main__":
    unittest.main()
