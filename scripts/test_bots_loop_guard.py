"""Loop chips and optional actions are driven only by harness tool events."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.test_data_support import TestDataDirectory
fixture = TestDataDirectory(prefix="kairos-loop-")
os.environ["JARVIS_DATA_DIR"] = fixture.name
from core import bot_loop_guard as guard, runs


class LoopTests(unittest.TestCase):
    def setUp(self):
        guard._THREADS.clear()
        self.ctx = runs.RunContext("chat", session_id="thread", agent_id="bot", run_id="run")
        self.rows, self.actions = [], []
        self.settings = {"enabled": False, "steer_at": 5, "stop_at": None}

    def observe(self, item, waiting=False):
        return guard.observe(item, self.ctx, settings=self.settings, waiting=lambda c: waiting,
                             emit=lambda c, row: self.rows.append(row), act=lambda c, row: self.actions.append(row))

    def call(self, n, *, ok=False, name="Bash", output="same failure", waiting=False, args=None):
        self.observe(runs.tool_started(str(n), name, args or {"command": "build"}), waiting)
        self.observe(runs.tool_finished(str(n), ok, output), waiting)

    def test_chips_at_5_10_20_and_no_actions_by_default(self):
        for i in range(24): self.call(i)
        self.assertEqual([r["count"] for r in self.rows], [5, 10, 20])
        self.assertFalse(self.actions)

    def test_normalized_keys_cap_and_masked_preview(self):
        for i in range(4): self.call(i, args='{"b":2,"a":1}')
        self.call(4, args={"a": 1, "b": 2})
        self.assertEqual(self.rows[-1]["count"], 5)
        for i in range(300): self.call(i, args={"command": str(i)})
        self.assertEqual(len(guard._THREADS["thread"]["keys"]), 256)
        token = "sk-ant-" + "x" * 40
        for i in range(5): self.call(i, args={"command": "echo " + token})
        self.assertNotIn(token, self.rows[-1]["preview"])

    def test_steer_once_per_key_and_stop_only_when_set(self):
        self.settings["enabled"] = True
        for i in range(8): self.call(i)
        self.assertEqual([a["action"] for a in self.actions], ["steer"])
        self.settings["stop_at"] = 10
        for i in range(8, 15): self.call(i)
        self.assertEqual([a["action"] for a in self.actions], ["steer", "stop"])
        self.assertTrue(guard.is_guard_note(self.actions[0]["content"]))
        self.assertFalse(guard.is_guard_note("[Kairos loop guard]\nChange approach"))
        self.assertEqual(guard.observe("[Kairos loop guard]", self.ctx), [])

    def test_never_acts_while_waiting_on_person_or_computer(self):
        self.settings.update(enabled=True, steer_at=2, stop_at=3)
        for i in range(8): self.call(i, waiting=True)
        self.assertFalse(self.actions)
        self.assertTrue(self.rows)

    def test_only_consecutive_same_shell_failures_trigger(self):
        self.settings.update(enabled=True, steer_at=2)
        self.call(0)
        self.call(1, output="different failure")
        self.call(2, ok=True)
        self.call(3)
        self.assertFalse(self.actions)
        self.call(4)
        self.assertEqual(len(self.actions), 1)
        self.actions.clear()
        for i in range(8): self.call(i, name="read_file")
        self.assertFalse(self.actions)

    def test_observer_seam_cannot_break_run(self):
        seen = []
        remove = runs.observe_tool_events(lambda event, ctx: seen.append(event.kind))
        self.addCleanup(remove)
        with patch.object(guard, "_emit"), patch("services.bot_peers.state", return_value={"loop_guard": self.settings}):
            tally = runs.Tally()
            tally.add(runs.tool_started("one", "Read", "file"))
            tally.add(runs.tool_finished("one", True, "contents"))
        self.assertEqual(seen, [runs.EventKind.TOOL_STARTED, runs.EventKind.TOOL_FINISHED])
        self.assertEqual(tally.tool_calls, 1)


if __name__ == "__main__":
    unittest.main()
