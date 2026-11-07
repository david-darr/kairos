"""Side calls leave labelled runs (Session Usage and Model Tracking, unit 2, 2026-11-07).

What these prove, with scripted brains and providers, no real model:
- a compaction, an Open Mic summary, a chat Summary and the model Test button each leave one run labelled with
  its purpose, with the provider's usage when it reported one and null when it did not;
- a failed side call is recorded as failed;
- the chat's usage shows its own turns and its side calls separately, and the totals include both;
- side calls count on Home's per-model totals;
- an older (v9) store gains the v10 columns with its old rows left null.
(Chats have no model-made titles: a title is the first message's text, so there is no title call to record.)
"""
import asyncio
import os
import sqlite3
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from test_data_support import TestDataDirectory  # noqa: E402

_DATA = TestDataDirectory("kairos-side-runs-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import app as kairos  # noqa: E402  (first, so the account layout settles before any store opens)

from core import runs, session_manager_store as store, session_usage, token_usage  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import chat_service, chat_summary  # noqa: E402

ENDPOINT = {"id": "api-1", "name": "API", "kind": "api", "model": "side-model"}
USAGE = {"prompt_tokens": 1200, "completion_tokens": 80, "total_tokens": 1280,
         "prompt_tokens_details": {"cached_tokens": 1000}}


class Scripted:
    """A detached summary brain that reports the usage of its one call."""
    def __init__(self, usage=USAGE, fail=False):
        self.model, self.last_usage, self.fail = "side-model", None, fail
        self._usage = usage

    async def connect(self): pass
    async def disconnect(self): pass

    async def run_turn(self, prompt):
        if self.fail:
            raise RuntimeError("model exploded")
        self.last_usage = self._usage
        return "SUMMARY: goals and decisions so far."


def side_runs(session_id=None, purpose=None):
    rows = [r for r in store.find_runs(limit=500) if r.get("purpose")]
    return [r for r in rows if (session_id is None or r["session_id"] == session_id)
            and (purpose is None or r["purpose"] == purpose)]


class Base(unittest.TestCase):
    def setUp(self):
        chat_service._busy.clear()
        chat_service._brains.clear()
        self.sid = session_manager.create_session("side")["id"]
        p = patch.object(chat_service, "_resolve_endpoint", return_value=ENDPOINT)
        p.start()
        self.addCleanup(p.stop)

    def fill(self, count):
        for n in range(count):
            session_manager.append_message(self.sid, "user" if n % 2 == 0 else "assistant", f"message {n}")


class Compaction(Base):
    def test_compact_leaves_one_labelled_run_with_usage(self):
        self.fill(16)
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted()):
            asyncio.run(chat_service.compact_session(self.sid))
        found = side_runs(self.sid, "compact")
        self.assertEqual(len(found), 1)
        run = found[0]
        self.assertEqual((run["surface"], run["outcome"], run["endpoint_id"], run["model"]),
                         ("side", "finished", "api-1", "side-model"))
        self.assertEqual((run["input_tokens"], run["output_tokens"], run["cache_read_tokens"]), (1200, 80, 1000))

    def test_failed_side_call_is_recorded_failed(self):
        self.fill(16)
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted(fail=True)):
            with self.assertRaises(RuntimeError):
                asyncio.run(chat_service.compact_session(self.sid))
        run = side_runs(self.sid, "compact")[0]
        self.assertEqual(run["outcome"], "failed")
        self.assertIn("model exploded", run["detail"])
        self.assertIsNone(run["input_tokens"])

    def test_no_reported_usage_stays_null(self):
        self.fill(16)
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted(usage=None)):
            asyncio.run(chat_service.compact_session(self.sid))
        run = side_runs(self.sid, "compact")[0]
        self.assertIsNone(run["input_tokens"])
        self.assertIsNone(run["output_tokens"])
        self.assertEqual(run["outcome"], "finished")


class OpenMic(Base):
    def test_open_mic_summary_leaves_one_labelled_run(self):
        session_manager.set_open_mic(self.sid, True)
        self.fill(6)
        with patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted()):
            result = asyncio.run(chat_service.summarise_open_mic(self.sid))
        self.assertTrue(result["summarised"], result)
        self.assertEqual(len(side_runs(self.sid, "open_mic_summary")), 1)


class ChatSummary(Base):
    def test_api_summary_records_usage(self):
        async def fake_run_turn(*args, on_usage=None, **kwargs):
            on_usage(USAGE)
            return "A summary."
        with patch.object(chat_summary.model_endpoints, "resolve_runtime", return_value=("http://x/v1", "side-model", None, None)), \
             patch.object(chat_summary.openai_compatible, "run_turn", side_effect=fake_run_turn):
            text = asyncio.run(chat_summary._model_summary(ENDPOINT, None, "prompt", self.sid))
        self.assertEqual(text, "A summary.")
        run = side_runs(self.sid, "chat_summary")[0]
        self.assertEqual((run["input_tokens"], run["output_tokens"]), (1200, 80))
        # A reply that arrived whole has no output rate.
        self.assertIsNone(runs.tokens_per_second(run))


class ModelTest(unittest.TestCase):
    def test_test_button_leaves_a_model_test_run(self):
        from fastapi.testclient import TestClient
        from core import model_endpoints

        async def fake_run_turn(*args, on_usage=None, **kwargs):
            on_usage({"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6})
            return "pong"
        endpoint = {**ENDPOINT, "id": "api-test"}
        with patch.object(model_endpoints, "get_endpoint", return_value=endpoint), \
             patch.object(model_endpoints, "resolve_runtime", return_value=("http://x/v1", "side-model", None, None)), \
             patch("core.providers.openai_compatible.run_turn", side_effect=fake_run_turn):
            response = TestClient(kairos.app).post("/api/models/api-test/test")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        found = [r for r in side_runs(purpose="model_test") if r["endpoint_id"] == "api-test"]
        self.assertEqual(len(found), 1)
        self.assertIsNone(found[0]["session_id"])
        self.assertEqual(found[0]["input_tokens"], 5)


class Totals(Base):
    def test_meter_shows_turns_and_side_calls_apart_and_home_counts_side_calls(self):
        before = token_usage.get_usage_summary().get("api-1", {}).get("total_tokens", 0)
        now = time.time()
        store.record_run({"id": "turn-1", "surface": "chat", "session_id": self.sid, "started_at": now,
                          "ended_at": now + 1, "outcome": "finished", "tool_calls": 0, "usage_complete": 1,
                          "input_tokens": 500, "output_tokens": 50, "total_tokens": 550})
        with runs.SideRun("compact", session_id=self.sid, endpoint=ENDPOINT) as side:
            side.usage(USAGE)
            side.text("summary")
        usage = session_usage.for_session(self.sid, {})
        self.assertEqual((usage["turns"], usage["side_runs"]), (1, 1))
        self.assertEqual(usage["side_purposes"], {"compact": 1})
        self.assertEqual(usage["parts"]["turns"]["input_tokens"], 500)
        self.assertEqual(usage["parts"]["side"]["input_tokens"], 1200)
        self.assertEqual(usage["input_tokens"], 1700)
        after = token_usage.get_usage_summary()["api-1"]["total_tokens"]
        self.assertEqual(after - before, 1280)


class Upgrade(unittest.TestCase):
    def test_v9_store_gains_v10_columns(self):
        path = os.path.join(_DATA.name, "old-v9.db")
        # Build a real v9 database: today's schema without the v10 columns, stamped 9.
        conn = sqlite3.connect(path)
        schema = store._SCHEMA
        for name, kind in store.RUN_V10_COLUMNS:
            schema = schema.replace(f",\n    {name:<18} {kind}", "")
        schema = schema.replace(",\n    -- Schema v10 (2026-11-07): see RUN_V10_COLUMNS.", "")
        conn.executescript(schema)
        conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', '9')")
        conn.execute("INSERT INTO runs (id, surface, outcome) VALUES ('old', 'chat', 'finished')")
        conn.commit()
        columns = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
        self.assertNotIn("purpose", columns)
        conn.close()
        previous = store.DB_FILE
        store.DB_FILE = path
        try:
            row = store.get_run("old")
            self.assertIn("purpose", row)
            self.assertIsNone(row["purpose"])
            self.assertIsNone(row["cost_usd"])
            self.assertTrue(os.path.exists(path + ".pre-v9"))
        finally:
            store.close()
            store.DB_FILE = previous


if __name__ == "__main__":
    unittest.main(verbosity=2)
