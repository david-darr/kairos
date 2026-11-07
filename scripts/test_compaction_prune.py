"""Cheaper compaction for local and API chats (Session Usage and Model Tracking, unit 6, 2026-11-07).

What these prove, with a scripted summariser and no model or network:
- the no-model prune alone can bring a chat back under the line: no summary is written, old tool results are
  replayed as one-line stubs, the stored transcript is unchanged, and the compaction is recorded on a run that
  names no model and costs nothing;
- the kept tail's tool results (the last exchange) stay whole;
- when the prune is not enough, a summary follows, recorded as prune+summary with tokens before and after;
- the Compact button records a manual summary.
"""
import asyncio
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from test_data_support import TestDataDirectory  # noqa: E402

_DATA = TestDataDirectory("kairos-compaction-prune-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import app as kairos  # noqa: E402,F401  (first, so the account layout settles before any store opens)
from core import session_manager_store as store, session_usage, settings as settings_store  # noqa: E402
from core.session_manager import session_manager, TOOL_STUB_OVER  # noqa: E402
from services import chat_service  # noqa: E402

WINDOW = 8192
ENDPOINT = {"id": "local", "name": "Local", "kind": "local", "model": "local-model", "num_ctx": WINDOW}
BIG = "Vendor sheet row. " * 170  # about 3,060 characters


class Scripted:
    calls = 0

    async def connect(self): pass
    async def disconnect(self): pass

    async def run_turn(self, prompt):
        Scripted.calls += 1
        return "SUMMARY: goals and decisions so far."


def rounds(n, content):
    return {"endpoint_id": "local", "messages": [
        {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{n}", "type": "function",
                                                               "function": {"name": "search_vault", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": f"c{n}", "content": content}]}


class Prune(unittest.TestCase):
    def setUp(self):
        Scripted.calls = 0
        chat_service._busy.clear()
        chat_service._brains.clear()
        settings_store.update_settings(auto_compact=True)
        self.sid = session_manager.create_session("prune")["id"]
        for p in (patch.object(chat_service, "_resolve_endpoint", return_value=ENDPOINT),
                  patch.object(chat_service, "_build_brain", side_effect=lambda *a, **k: Scripted())):
            p.start()
            self.addCleanup(p.stop)

    def fill(self, exchanges, result=BIG):
        for n in range(exchanges):
            session_manager.append_message(self.sid, "user", f"question {n}")
            time.sleep(0.002)
            session_manager.append_message(self.sid, "assistant", f"answer {n}", extra={"tool_rounds": rounds(n, result)})
            time.sleep(0.002)

    def reading(self, used):
        session_manager.set_context_state(self.sid, {"used_tokens": used, "capacity_tokens": WINDOW,
                                                     "percent": round(used * 100 / WINDOW, 1), "model": "local-model"})

    def compaction_runs(self):
        return [r for r in store.find_runs(session_id=self.sid, limit=50) if r.get("purpose") == "compact"]

    def test_prune_alone_clears_the_line_without_a_summary(self):
        self.fill(8)                       # eight old tool results, ~3,000 characters each
        stored_before = json.dumps(session_manager.get_session(self.sid)["messages"])
        self.reading(7100)                 # 86.7% of the window
        self.assertTrue(asyncio.run(chat_service._compact_if_nearly_full(self.sid)))
        self.assertEqual(Scripted.calls, 0, "no summary was written")
        self.assertEqual(json.dumps(session_manager.get_session(self.sid)["messages"]), stored_before, "nothing stored changed")
        sent = session_manager.effective_messages(self.sid)
        results = [m["tool_rounds"]["messages"][1]["content"] for m in sent if m.get("tool_rounds")]
        self.assertTrue(results[0].startswith("[Older tool result cleared to save context: search_vault"))
        # The kept tail (the last exchange) keeps its tool result whole.
        self.assertEqual(results[-1], BIG)
        run = self.compaction_runs()[0]
        record = json.loads(run["compaction"])
        self.assertEqual((record["trigger"], record["method"], record["tokens_before"]), ("auto", "prune", 7100))
        self.assertLess(record["tokens_after"] * 100 / WINDOW, chat_service.AUTO_COMPACT_PERCENT)
        self.assertIsNone(run["endpoint_id"])
        self.assertEqual((run["cost_usd"], run["cost_status"]), (0.0, "actual"))
        self.assertEqual(session_usage.for_session(self.sid, session_manager.get_session(self.sid))["compactions"], 1)

    def test_summary_follows_when_the_prune_is_not_enough(self):
        self.fill(8, result="short result")   # nothing over the stub size: the prune saves nothing
        session_manager.append_message(self.sid, "user", "x " * 3000)
        session_manager.append_message(self.sid, "assistant", "y " * 3000, extra={"tool_rounds": rounds(99, BIG)})
        self.reading(7600)
        self.assertTrue(asyncio.run(chat_service._compact_if_nearly_full(self.sid)))
        self.assertEqual(Scripted.calls, 1)
        record = json.loads(self.compaction_runs()[0]["compaction"])
        self.assertEqual((record["trigger"], record["method"], record["tokens_before"]), ("auto", "summary", 7600))
        self.assertTrue(record["tokens_after_estimated"])
        self.assertLess(record["tokens_after"], 7600)
        self.assertGreater(record["messages_folded"], 0)

    def test_prune_then_summary_is_recorded_as_both(self):
        self.fill(1)                       # the prune saves about 750 tokens: not enough on its own
        session_manager.append_message(self.sid, "user", "x " * 9000)
        session_manager.append_message(self.sid, "assistant", "y " * 9000)
        self.reading(8000)
        asyncio.run(chat_service._compact_if_nearly_full(self.sid))
        self.assertEqual(Scripted.calls, 1)
        record = json.loads(self.compaction_runs()[0]["compaction"])
        self.assertEqual(record["method"], "prune+summary")
        self.assertGreater(record["chars_pruned"], 0)

    def test_manual_compact_is_recorded(self):
        self.fill(8, result="short")
        asyncio.run(chat_service.compact_session(self.sid))
        record = json.loads(self.compaction_runs()[0]["compaction"])
        self.assertEqual((record["trigger"], record["method"]), ("manual", "summary"))

    def test_stub_threshold(self):
        self.assertEqual(TOOL_STUB_OVER, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
