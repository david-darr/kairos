"""Context breakdown (Session Usage and Model Tracking, unit 5, 2026-11-07).

What these prove, with real local/API brains built offline and no model call:
- the parts (system prompt, tool definitions, memory and skills, conversation) sum exactly to the measured
  total, and each is marked an estimate;
- memory and skill tool results count as memory, other tool rounds as conversation;
- a non-admin chat's tool list, and so its tool part, is smaller than an admin's;
- a chat turn stores the parts with its context reading; a Claude Code or Codex brain stores none.
"""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from test_data_support import TestDataDirectory  # noqa: E402

_DATA = TestDataDirectory("kairos-context-breakdown-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import app as kairos  # noqa: E402,F401  (first, so the account layout settles before any store opens)
from core import context_breakdown  # noqa: E402
from core.external_brain import ExternalBrain  # noqa: E402
from core.session_manager import session_manager  # noqa: E402
from services import chat_service  # noqa: E402

ENDPOINT = {"id": "api-1", "name": "API", "kind": "api", "model": "m"}


def brain(is_admin=True, history=None):
    return ExternalBrain("http://127.0.0.1:9/v1", "m", None, history=history, session_id="s-breakdown", is_admin=is_admin)


def parts_by_key(parts):
    return {p["key"]: p["tokens"] for p in parts}


class Measure(unittest.TestCase):
    def test_parts_sum_to_the_measured_total(self):
        live = brain()
        live._messages.append({"role": "user", "content": "hello " * 400})
        for used in (1, 999, 12345, 48200):
            parts = context_breakdown.for_brain(live, used)
            self.assertEqual(sum(p["tokens"] for p in parts), used)
            self.assertTrue(all(p["estimated"] for p in parts))
        self.assertEqual([p["key"] for p in parts], ["system", "tools", "memory", "conversation"])

    def test_memory_tool_results_count_as_memory(self):
        messages = [
            {"role": "system", "content": "x" * 100},
            {"role": "user", "content": "y" * 100},
            {"role": "assistant", "content": None, "tool_calls": [
                {"id": "a", "type": "function", "function": {"name": "read_skill", "arguments": "{}"}},
                {"id": "b", "type": "function", "function": {"name": "create_note", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "a", "content": "s" * 300},
            {"role": "tool", "tool_call_id": "b", "content": "n" * 50},
        ]
        sizes = context_breakdown.measure(messages, [])
        self.assertEqual(sizes["memory"], 300)
        self.assertEqual(sizes["system"], 100)
        self.assertGreater(sizes["conversation"], 150)
        self.assertEqual(sizes["tools"], 2)  # "[]"

    def test_non_admin_tool_part_is_smaller(self):
        # With every tool listed (Settings: defer_tools off); deferred, both get the same short core list.
        from core import settings
        real = settings.get_setting
        with patch.object(settings, "get_setting", side_effect=lambda key, *a: False if key == "defer_tools" else real(key, *a)):
            admin, member = brain(is_admin=True), brain(is_admin=False)
        self.assertLess(len(member.tools), len(admin.tools))
        used = 30000
        self.assertLess(context_breakdown.measure(member._messages, member.tools)["tools"],
                        context_breakdown.measure(admin._messages, admin.tools)["tools"])
        self.assertEqual(sum(p["tokens"] for p in context_breakdown.for_brain(member, used)), used)

    def test_other_brains_have_no_parts(self):
        class Cli:
            model = "claude-x"
        self.assertIsNone(context_breakdown.for_brain(Cli(), 1000))
        self.assertIsNone(context_breakdown.for_brain(brain(), None))


class Stored(unittest.TestCase):
    def test_turn_stores_parts_with_the_reading(self):
        sid = session_manager.create_session("breakdown")["id"]
        live = brain()
        live.last_usage = {"prompt_tokens": 20000, "completion_tokens": 10}
        with patch("core.model_catalog.context_capacity", return_value={"effective": 100000, "estimated": False, "source": "t"}):
            chat_service._record_turn_telemetry(sid, ENDPOINT, live, None)
        state = session_manager.get_session(sid)["context_state"]
        self.assertEqual(state["used_tokens"], 20000)
        self.assertEqual(sum(p["tokens"] for p in state["parts"]), 20000)

        class Cli:
            model = "claude-x"
            last_usage = {"input_tokens": 500, "output_tokens": 10, "cache_read_input_tokens": 0}
        with patch("core.model_catalog.context_capacity", return_value=None):
            chat_service._record_turn_telemetry(sid, {**ENDPOINT, "kind": "claude_cli"}, Cli(), None)
        self.assertNotIn("parts", session_manager.get_session(sid)["context_state"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
