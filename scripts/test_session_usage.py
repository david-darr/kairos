"""Per-chat usage meter (Session Usage and Model Tracking, unit 1, 2026-11-07).

What these prove, with fixture runs and no real model:
- the chat's runs give the sums (turns, input, output, cache read and write, cache hit, tool calls,
  compactions, helpers) and the last reply's time to first output and tok/s;
- a provider that reported no usage gives null, never 0, and the result says how many runs reported;
- a reply that arrived whole (Codex) has tok/s null ("n/a" in the meter);
- a fork counts only its own runs; a helper is counted by its chat, or by its parent run;
- the route answers the chat's owner only: another account gets 404, an admin included.
"""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from scripts.tab_test_support import TemporaryDirectory  # noqa: E402

_DATA = TemporaryDirectory(prefix="kairos-session-usage-", dir=tempfile.gettempdir())
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
os.environ["AUTH_ENABLED"] = "true"
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

from core import session_manager_store as store, session_usage  # noqa: E402

NOW = time.time()


def run(run_id, session_id, surface="chat", started=0.0, **fields):
    row = {"id": run_id, "parent_id": None, "surface": surface, "session_id": session_id, "agent_id": None,
           "task_id": None, "endpoint_id": "e1", "model": "m1", "started_at": NOW + started,
           "ended_at": NOW + started + 5, "outcome": "finished", "stop_confirmed": None, "tool_calls": 0,
           "total_tokens": None, "cache_read_tokens": None, "usage_complete": 1, "detail": "",
           "input_tokens": None, "output_tokens": None, "cache_write_tokens": None,
           "first_output_at": None, "last_output_at": None}
    row.update(fields)
    return row


class Summaries(unittest.TestCase):
    def test_sums_and_last_reply(self):
        rows = [
            run("a", "s1", started=0, input_tokens=1000, output_tokens=100, cache_read_tokens=800,
                cache_write_tokens=50, total_tokens=1100, tool_calls=2,
                first_output_at=NOW + 1.0, last_output_at=NOW + 3.0),
            run("b", "s1", started=10, input_tokens=3000, output_tokens=200, cache_read_tokens=2400,
                cache_write_tokens=0, total_tokens=3200, tool_calls=1,
                first_output_at=NOW + 10.5, last_output_at=NOW + 14.5),
        ]
        usage = session_usage.summarize({"compactions": [{"through_index": 4}]}, rows)
        self.assertEqual(usage["turns"], 2)
        self.assertEqual(usage["input_tokens"], 4000)
        self.assertEqual(usage["output_tokens"], 300)
        self.assertEqual(usage["cache_read_tokens"], 3200)
        self.assertEqual(usage["cache_write_tokens"], 50)
        self.assertEqual(usage["cache_hit_percent"], 80.0)
        self.assertEqual(usage["tool_calls"], 3)
        self.assertEqual(usage["compactions"], 1)
        self.assertEqual(usage["reported_runs"], 2)
        self.assertEqual(usage["last_reply"]["run_id"], "b")
        self.assertEqual(usage["last_reply"]["ttft_seconds"], 0.5)
        self.assertEqual(usage["last_reply"]["tokens_per_second"], 50.0)

    def test_no_usage_is_null_not_zero(self):
        usage = session_usage.summarize({}, [run("a", "s1"), run("b", "s1", started=5)])
        for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens",
                    "cache_hit_percent"):
            self.assertIsNone(usage[key], key)
        self.assertEqual(usage["reported_runs"], 0)
        self.assertEqual(usage["turns"], 2)
        self.assertIsNone(usage["last_reply"]["ttft_seconds"])
        self.assertIsNone(usage["last_reply"]["tokens_per_second"])

    def test_partial_usage_counts_only_what_reported(self):
        usage = session_usage.summarize({}, [run("a", "s1", output_tokens=40, input_tokens=400), run("b", "s1", started=5)])
        self.assertEqual(usage["output_tokens"], 40)
        self.assertEqual((usage["reported_runs"], usage["runs"]), (1, 2))
        # No cache split reported is not a 0% hit rate.
        self.assertIsNone(usage["cache_hit_percent"])

    def test_whole_piece_reply_has_no_rate(self):
        # Codex sends its reply in one piece: first and last output arrive together.
        usage = session_usage.summarize({}, [run("a", "s1", output_tokens=500, first_output_at=NOW + 4,
                                                last_output_at=NOW + 4)])
        self.assertIsNone(usage["last_reply"]["tokens_per_second"])
        self.assertEqual(usage["last_reply"]["ttft_seconds"], 4.0)

    def test_no_runs(self):
        usage = session_usage.summarize({}, [])
        self.assertEqual((usage["runs"], usage["turns"]), (0, 0))
        self.assertIsNone(usage["last_reply"])
        self.assertIsNone(usage["input_tokens"])
        self.assertIsNone(usage["last_compaction"])

    def test_compactions_are_counted_and_the_newest_is_shown(self):
        """Seamless compaction (2026-11-07): compaction never shows in the chat, so Chat details carries the
        record. A summary is counted from the chat's checkpoint; a prune and Claude Code's own compaction,
        which leave none, from their runs. An unreadable record is skipped, not guessed."""
        summary = '{"trigger": "auto", "method": "summary", "tokens_before": 7600, "tokens_after": 2100, "written_ahead": true}'
        rows = [run("t", "s1", started=0),
                run("p", "s1", purpose="compact", endpoint_id=None, started=10,
                    compaction='{"trigger": "auto", "method": "prune", "tokens_before": 7100, "tokens_after": 6000}'),
                run("s", "s1", purpose="compact", started=20, compaction=summary),
                run("c", "s1", purpose="compact", endpoint_id=None, started=30,
                    compaction='{"trigger": "cli", "method": "cli", "by": "Claude Code", "tokens_before": 151000}'),
                run("x", "s1", purpose="compact", started=40, compaction="not json")]
        usage = session_usage.summarize({"compactions": [{"through_index": 6}]}, rows)
        self.assertEqual(usage["compactions"], 3, "one checkpoint, one prune, one Claude Code compaction")
        self.assertEqual((usage["last_compaction"]["trigger"], usage["last_compaction"]["tokens_before"]), ("cli", 151000))
        self.assertEqual(usage["last_compaction"]["at"], NOW + 35)
        usage = session_usage.summarize({"compactions": [{"through_index": 6}]}, rows[:3])
        self.assertEqual(usage["last_compaction"]["written_ahead"], True)
        self.assertEqual(usage["side_purposes"], {"compact": 2})


class Store(unittest.TestCase):
    def test_fork_counts_only_its_own_runs_and_helpers_count(self):
        store.record_run(run("p1", "parent", input_tokens=100, output_tokens=10))
        store.record_run(run("p2", "parent", started=3, input_tokens=200, output_tokens=20))
        store.record_run(run("f1", "fork", started=6, input_tokens=50, output_tokens=5))
        # A helper the parent's turn started: one with the chat, one known only by its parent run.
        store.record_run(run("h1", "parent", surface="helper", started=1, parent_id="p1", output_tokens=7))
        store.record_run(run("h2", None, surface="helper", started=2, parent_id="p2", output_tokens=8))
        parent = session_usage.for_session("parent", {})
        fork = session_usage.for_session("fork", {})
        self.assertEqual(parent["turns"], 2)
        self.assertEqual(parent["helper_runs"], 2)
        self.assertEqual(parent["output_tokens"], 45)
        self.assertEqual(parent["parts"]["turns"]["output_tokens"], 30)
        self.assertEqual(parent["parts"]["helpers"]["output_tokens"], 15)
        self.assertEqual((fork["turns"], fork["helper_runs"], fork["output_tokens"]), (1, 0, 5))


class Route(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import app as kairos
        from core.auth import auth_manager
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        setup = TestClient(kairos.app)
        assert setup.post("/api/auth/setup", json={"username": "david", "password": "first-password-1"}).status_code == 200
        assert setup.post("/api/auth/users", json={"username": "bea", "password": "second-password-2",
                                                   "is_admin": False}).status_code == 200
        cls.clients = {}
        for name, password in (("david", "first-password-1"), ("bea", "second-password-2")):
            client = TestClient(kairos.app)
            assert client.post("/api/auth/login", json={"username": name, "password": password}).status_code == 200
            cls.clients[name] = client

    def _chat_with_run(self, who):
        from core import accounts
        from core.auth import auth_manager
        client = self.clients[who]
        chat = client.post("/api/sessions", json={"title": f"{who} chat"}).json()
        with accounts.as_account(auth_manager.account_id(who)):
            store.record_run(run(f"r-{chat['id']}", chat["id"], input_tokens=900, output_tokens=90))
        return chat["id"]

    def test_owner_reads_and_others_do_not(self):
        david_chat = self._chat_with_run("david")
        bea_chat = self._chat_with_run("bea")
        mine = self.clients["david"].get(f"/api/sessions/{david_chat}/usage")
        self.assertEqual(mine.status_code, 200, mine.text)
        self.assertEqual(mine.json()["input_tokens"], 900)
        self.assertEqual(mine.json()["source"], "runs")
        self.assertEqual(self.clients["bea"].get(f"/api/sessions/{bea_chat}/usage").json()["output_tokens"], 90)
        # Multi-account is locked: an admin cannot read another account's chats.
        self.assertEqual(self.clients["david"].get(f"/api/sessions/{bea_chat}/usage").status_code, 404)
        self.assertEqual(self.clients["bea"].get(f"/api/sessions/{david_chat}/usage").status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
