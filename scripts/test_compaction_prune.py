"""Cheaper compaction for local and API chats (Session Usage and Model Tracking, unit 6, 2026-11-07), made
seamless the same day (David: "it just happens naturally", as in Claude Code).

What these prove, with a scripted summariser and no model or network:
- the no-model prune alone can bring a chat back under the line: no summary is written, old tool results are
  replayed as one-line stubs, the stored transcript is unchanged, and the compaction is recorded on a run that
  names no model and costs nothing;
- the kept tail's tool results (the last exchange) stay whole;
- when the prune is not enough, the summary is written in the background: the message that found the chat full
  does not wait for it, and the next one applies it with no model call, recorded as written ahead;
- a turn that ends over the line starts the summary between turns; one the prune alone will clear starts none;
- a chat so full the request would overflow waits for the summary, recorded as prune+summary;
- an automatic compaction adds nothing to the transcript; the Compact button still adds its notice;
- a summary written ahead is never applied to a chat whose folded part changed since.
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
    gate = None  # an asyncio.Event the summariser waits on, to stand in for a slow model

    async def connect(self): pass
    async def disconnect(self): pass

    async def run_turn(self, prompt):
        Scripted.calls += 1
        if Scripted.gate is not None:
            await Scripted.gate.wait()
        return "SUMMARY: goals and decisions so far."


def rounds(n, content):
    return {"endpoint_id": "local", "messages": [
        {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{n}", "type": "function",
                                                               "function": {"name": "search_vault", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": f"c{n}", "content": content}]}


class Prune(unittest.TestCase):
    def setUp(self):
        Scripted.calls = 0
        Scripted.gate = None
        chat_service._busy.clear()
        chat_service._brains.clear()
        chat_service._ahead.clear()
        self.addCleanup(chat_service._ahead.clear)
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

    def fill_without_prunable_results(self):
        self.fill(8, result="short result")   # nothing over the stub size: the prune saves nothing
        session_manager.append_message(self.sid, "user", "x " * 3000)
        session_manager.append_message(self.sid, "assistant", "y " * 3000, extra={"tool_rounds": rounds(99, BIG)})

    def summary_records(self):
        return [json.loads(r["compaction"]) for r in self.compaction_runs() if r.get("compaction")]

    def test_the_summary_is_written_in_the_background_and_the_message_does_not_wait(self):
        self.fill_without_prunable_results()
        shown = json.dumps(session_manager.get_session(self.sid)["messages"])
        self.reading(7600)                 # 92.8%: over the line, short of overflowing

        async def scenario():
            Scripted.gate = asyncio.Event()  # a slow summariser
            # The message that finds the chat full goes straight through.
            self.assertFalse(await asyncio.wait_for(chat_service._compact_if_nearly_full(self.sid), 2))
            job = chat_service._ahead[self.sid]
            self.assertFalse(job["task"].done(), "the summary is still being written")
            self.assertFalse(session_manager.get_session(self.sid).get("compactions"), "nothing applied yet")
            Scripted.gate.set()
            await job["task"]
            # The next message applies it, with no model call of its own.
            self.assertTrue(await asyncio.wait_for(chat_service._compact_if_nearly_full(self.sid), 2))
        asyncio.run(scenario())
        self.assertEqual(Scripted.calls, 1)
        session = session_manager.get_session(self.sid)
        self.assertEqual(len(session["compactions"]), 1)
        self.assertEqual(len(session["messages"]), 18, "no notice was added to the transcript")
        self.assertEqual([m["content"] for m in session["messages"]], [m["content"] for m in json.loads(shown)])
        [record] = self.summary_records()
        self.assertEqual((record["trigger"], record["method"], record["tokens_before"], record["written_ahead"]),
                         ("auto", "summary", 7600, True))
        self.assertTrue(record["tokens_after_estimated"])
        self.assertLess(record["tokens_after"], 7600)
        self.assertGreater(record["messages_folded"], 0)
        usage = session_usage.for_session(self.sid, session)
        self.assertEqual(usage["compactions"], 1)
        self.assertEqual((usage["last_compaction"]["trigger"], usage["last_compaction"]["written_ahead"]), ("auto", True))

    def test_a_turn_that_ends_over_the_line_starts_the_summary_between_turns(self):
        self.fill_without_prunable_results()
        self.reading(7600)

        async def scenario():
            chat_service.prepare_compaction_ahead(self.sid)   # what the end of a turn calls
            await chat_service._ahead[self.sid]["task"]
            self.assertEqual(Scripted.calls, 1)
            self.assertTrue(await chat_service._compact_if_nearly_full(self.sid))
        asyncio.run(scenario())
        self.assertEqual(Scripted.calls, 1, "the next message wrote nothing more")
        self.assertEqual(len(session_manager.get_session(self.sid)["compactions"]), 1)

    def test_no_summary_ahead_when_the_prune_alone_will_do(self):
        self.fill(8)
        self.reading(7100)

        async def scenario():
            chat_service.prepare_compaction_ahead(self.sid)
            self.assertNotIn(self.sid, chat_service._ahead)
        asyncio.run(scenario())
        self.assertEqual(Scripted.calls, 0)

    def test_a_chat_that_would_overflow_waits_for_the_summary_as_a_last_resort(self):
        self.fill(1)                       # the prune saves about 750 tokens: not enough on its own
        session_manager.append_message(self.sid, "user", "x " * 9000)
        session_manager.append_message(self.sid, "assistant", "y " * 9000)
        self.reading(8600)                 # still over 95% after the prune
        self.assertTrue(asyncio.run(chat_service._compact_if_nearly_full(self.sid)))
        self.assertEqual(Scripted.calls, 1)
        [record] = self.summary_records()
        self.assertEqual(record["method"], "prune+summary")
        self.assertGreater(record["chars_pruned"], 0)

    def test_a_prune_that_is_not_enough_is_recorded_and_the_summary_comes_later(self):
        self.fill(1)
        session_manager.append_message(self.sid, "user", "x " * 9000)
        session_manager.append_message(self.sid, "assistant", "y " * 9000)
        self.reading(8000)                 # about 88% after the prune: no wait

        async def scenario():
            self.assertTrue(await chat_service._compact_if_nearly_full(self.sid))
            self.assertEqual([r["method"] for r in self.summary_records()], ["prune"])
            await chat_service._ahead[self.sid]["task"]
            self.assertTrue(await chat_service._compact_if_nearly_full(self.sid))
        asyncio.run(scenario())
        self.assertEqual(sorted(r["method"] for r in self.summary_records()), ["prune", "summary"])

    def test_a_summary_written_ahead_is_dropped_when_the_chat_changed_under_it(self):
        self.fill_without_prunable_results()
        self.reading(7600)

        async def scenario():
            chat_service.prepare_compaction_ahead(self.sid)
            await chat_service._ahead[self.sid]["task"]
            session_manager.rewind(self.sid, 4)   # an edit cut the chat back inside the folded part
            for n in range(4):
                session_manager.append_message(self.sid, "user" if n % 2 == 0 else "assistant", "z " * 2500)
            self.reading(7600)
            self.assertFalse(await chat_service._compact_if_nearly_full(self.sid), "the stale summary is not applied")
            self.assertFalse(session_manager.get_session(self.sid).get("compactions"))
            await chat_service._ahead[self.sid]["task"]   # a fresh one, for what the chat now holds
        asyncio.run(scenario())
        self.assertEqual(Scripted.calls, 2)

    def test_manual_compact_is_recorded_and_still_shows_its_notice(self):
        self.fill(8, result="short")
        asyncio.run(chat_service.compact_session(self.sid))
        record = json.loads(self.compaction_runs()[0]["compaction"])
        self.assertEqual((record["trigger"], record["method"]), ("manual", "summary"))
        last = session_manager.get_session(self.sid)["messages"][-1]
        self.assertTrue(last["display_only"] and last["content"].startswith("**Conversation compacted**"),
                        "the person asked for it, so the chat says so")

    def test_claude_codes_own_compaction_is_recorded_quietly(self):
        class Claude:
            last_usage = None
            cli_compactions = [{"trigger": "auto", "pre_tokens": 151000}]
        chat_service._record_turn_telemetry(self.sid, {"id": "claude", "kind": "claude_cli", "name": "Claude"},
                                            Claude(), None)
        [record] = self.summary_records()
        self.assertEqual((record["trigger"], record["method"], record["tokens_before"]), ("cli", "cli", 151000))
        self.assertEqual(Claude.cli_compactions, [], "each one is recorded once")
        session = session_manager.get_session(self.sid)
        self.assertEqual(len(session["messages"]), 0, "nothing in the chat")
        usage = session_usage.for_session(self.sid, session)
        self.assertEqual((usage["compactions"], usage["last_compaction"]["trigger"]), (1, "cli"))

    def test_stub_threshold(self):
        self.assertEqual(TOOL_STUB_OVER, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
