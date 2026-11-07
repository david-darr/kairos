"""Per-model speed and reliability from real runs (Session Usage and Model Tracking, unit 3, 2026-11-07).

What these prove, with fixture runs and scripted provider replies, no real model:
- fixture runs give the medians and p90 (first output, tok/s), failure and stop rates, failures by class;
- fewer than 5 runs is "not enough data": counts, but no medians;
- Claude Code and Codex rows say what their CLIs do not expose, never a zero;
- a failed run is recorded with its error class, and Kairos's own retries are counted;
- local/API tool calls are judged (clean, repaired, invalid JSON, unknown tool, missing arguments) and summed;
- the window and the Test ping are respected; each account reads only its own runs.
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

_DATA = TestDataDirectory("kairos-model-stats-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name
os.environ["AUTH_ENABLED"] = "true"
os.environ["JARVIS_VAULT_DIR"] = str(Path(_DATA.name) / "vault")
(Path(_DATA.name) / "vault").mkdir(parents=True, exist_ok=True)

import app as kairos  # noqa: E402,F401  (first, so the account layout settles before any store opens)
from core import model_stats, runs, session_manager_store as store  # noqa: E402
from core.providers import openai_compatible  # noqa: E402

NOW = time.time()
_n = 0


def row(endpoint="e1", model="m1", outcome="finished", ago=60, ttft=None, rate=None, **extra):
    global _n
    _n += 1
    started = NOW - ago
    fields = {"id": f"r{_n}", "surface": "chat", "endpoint_id": endpoint, "model": model, "started_at": started,
              "ended_at": started + 10, "outcome": outcome, "tool_calls": 0, "usage_complete": 1}
    if ttft is not None:
        fields["first_output_at"] = started + ttft
        if rate is not None:
            fields["output_tokens"] = int(rate * 4)
            fields["last_output_at"] = started + ttft + 4
    fields.update(extra)
    return fields


class Summaries(unittest.TestCase):
    def test_medians_p90_and_rates(self):
        rows = [row(ttft=t, rate=r) for t, r in ((0.5, 40), (0.6, 50), (0.7, 60), (0.8, 70), (2.0, 80))]
        rows += [row(outcome="failed", error_class="rate_limit"), row(outcome="failed", error_class="rate_limit"),
                 row(outcome="failed", error_class="overflow"), row(outcome="stopped")]
        stat = model_stats.summarize(rows, "api")
        self.assertEqual(stat["runs"], 9)
        self.assertTrue(stat["enough_data"])
        self.assertEqual(stat["ttft_median_s"], 0.7)
        self.assertEqual(stat["ttft_p90_s"], 2.0)
        self.assertEqual(stat["tokens_per_second_median"], 60.0)
        self.assertEqual((stat["failed"], stat["stopped"]), (3, 1))
        self.assertEqual(stat["failure_rate"], round(3 / 9, 3))
        self.assertEqual(stat["failures_by_class"], {"rate_limit": 2, "overflow": 1})
        self.assertEqual(stat["not_reported"], [])

    def test_fewer_than_five_is_not_enough_data(self):
        stat = model_stats.summarize([row(ttft=0.5, rate=40) for _ in range(4)], "local")
        self.assertFalse(stat["enough_data"])
        self.assertEqual(stat["runs"], 4)
        self.assertIsNone(stat["ttft_median_s"])
        self.assertIsNone(stat["tokens_per_second_median"])

    def test_cli_rows_say_what_they_do_not_report(self):
        # Codex sends each reply whole: first and last output together, so no rate, and says so.
        codex = model_stats.summarize([row(ttft=3.0) for _ in range(6)], "codex_cli")
        self.assertEqual(codex["ttft_median_s"], 3.0)
        self.assertIsNone(codex["tokens_per_second_median"])
        self.assertTrue(any("output speed" in n for n in codex["not_reported"]))
        self.assertIsNone(codex["tool_quality"])
        claude = model_stats.summarize([row(ttft=1.0, rate=50) for _ in range(5)], "claude_cli")
        self.assertTrue(any("tool-call quality" in n for n in claude["not_reported"]))

    def test_collect_groups_and_skips_test_pings(self):
        rows = [row(endpoint="a", model="x"), row(endpoint="a", model="y"), row(endpoint="b"),
                row(endpoint="a", purpose="model_test")]
        found = model_stats.collect(rows, {"a": "api", "b": "local"})
        self.assertEqual(found["endpoints"]["a"]["runs"], 2)
        self.assertEqual(found["endpoints"]["a"]["kind"], "api")
        self.assertEqual(sorted((m["endpoint_id"], m["model"]) for m in found["models"]),
                         [("a", "x"), ("a", "y"), ("b", "m1")])


class Recording(unittest.TestCase):
    def test_failed_run_gets_its_error_class_and_retries(self):
        context = runs.RunContext("chat", endpoint_id="e9")
        context.counters["retries"] = 2
        runs.record(context, runs.Tally(), "failed", detail="HTTPStatusError: Client error '429 Too Many Requests'")
        stored = store.get_run(context.run_id)
        self.assertEqual((stored["error_class"], stored["retries"]), ("rate_limit", 2))
        finished = runs.RunContext("chat", endpoint_id="e9")
        runs.record(finished, runs.Tally(), "finished")
        stored = store.get_run(finished.run_id)
        self.assertIsNone(stored["error_class"])
        self.assertIsNone(stored["retries"], "not counted is null, not 0")

    def test_error_classes(self):
        cases = {"rate_limit": "HTTPStatusError: Client error '429 Too Many Requests'",
                 "overload": "HTTPStatusError: Server error '529' overloaded_error",
                 "overflow": "BadRequest: This model's maximum context length is 8192 tokens",
                 "auth": "HTTPStatusError: Client error '401 Unauthorized'",
                 "network": "ConnectError: All connection attempts failed",
                 "other": "ValueError: something odd"}
        for expected, detail in cases.items():
            self.assertEqual(runs.error_class(detail), expected, detail)


TOOLS = [{"type": "function", "function": {"name": "read_note", "parameters": {"type": "object", "required": ["path"],
                                                                               "properties": {"path": {"type": "string"}}}}},
         {"type": "function", "function": {"name": "now", "parameters": {"type": "object", "properties": {}}}}]


class ToolQuality(unittest.TestCase):
    def test_call_quality(self):
        q = openai_compatible.call_quality
        self.assertEqual(q({"name": "read_note", "arguments": '{"path": "a.md"}'}, TOOLS), "clean")
        self.assertEqual(q({"name": "now", "arguments": ""}, TOOLS), "clean")
        self.assertEqual(q({"name": "read_note", "arguments": '{"path": '}, TOOLS), "invalid_json")
        self.assertEqual(q({"name": "delete_everything", "arguments": "{}"}, TOOLS), "unknown_tool")
        self.assertEqual(q({"name": "read_note", "arguments": "{}"}, TOOLS), "missing_arguments")
        self.assertEqual(q({"name": "read_note", "arguments": {"path": "a"}}, TOOLS, repaired=True), "repaired")

    def test_a_turn_records_its_counts(self):
        replies = [
            {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "1", "type": "function", "function": {"name": "read_note", "arguments": '{"path":"a"}'}},
                {"id": "2", "type": "function", "function": {"name": "read_note", "arguments": '{"path":'}},
                {"id": "3", "type": "function", "function": {"name": "nope", "arguments": "{}"}}]}}],
             "usage": {"prompt_tokens": 10, "completion_tokens": 2}},
            {"choices": [{"message": {"role": "assistant", "content": "done"}}],
             "usage": {"prompt_tokens": 12, "completion_tokens": 1}},
        ]

        async def post(client, base_url, api_key, body):
            return replies.pop(0)

        async def executor(name, args):
            return "ok"

        async def go():
            tally = runs.Tally()
            with patch.object(openai_compatible, "_post_chat", side_effect=post):
                async for item in openai_compatible.turn_events("http://x/v1", "m", None, [{"role": "user", "content": "hi"}],
                                                                tools=TOOLS, tool_executor=executor, stream=False):
                    tally.add(item)
            context = runs.RunContext("chat", endpoint_id="local-1", model_kind="local")
            runs.record(context, tally, "finished")
            return store.get_run(context.run_id)

        stored = asyncio.run(go())
        self.assertEqual(json.loads(stored["tool_quality"]), {"clean": 1, "invalid_json": 1, "unknown_tool": 1})
        stat = model_stats.summarize([stored], "local")
        self.assertEqual(stat["tool_quality"]["invalid_json"], 1)
        self.assertEqual(stat["tool_quality"]["missing_arguments"], 0)


class Window(unittest.TestCase):
    def test_window_and_accounts(self):
        from core import accounts
        from core.auth import auth_manager
        auth_manager._users = {"users": {}}
        auth_manager.create_user("ann", "first-password-1", is_admin=True)
        auth_manager.create_user("ben", "second-password-2", is_admin=False)
        with accounts.as_account(auth_manager.account_id("ann")):
            store.record_run(row(endpoint="ann-ep"))
            store.record_run(row(endpoint="ann-ep", ago=10 * 86400))
            seven = model_stats.stats(7)
            thirty = model_stats.stats(30)
        with accounts.as_account(auth_manager.account_id("ben")):
            store.record_run(row(endpoint="ben-ep"))
            ben = model_stats.stats(7)
        self.assertEqual(seven["endpoints"]["ann-ep"]["runs"], 1)
        self.assertEqual(thirty["endpoints"]["ann-ep"]["runs"], 2)
        self.assertNotIn("ben-ep", seven["endpoints"])
        self.assertEqual(set(ben["endpoints"]), {"ben-ep"}, "an account reads only its own runs")


class Routes(unittest.TestCase):
    def test_stats_route_bounds_and_quotas_carry_stats(self):
        from fastapi.testclient import TestClient
        from core import quota_usage
        from core.auth import auth_manager
        auth_manager._users = {"users": {}}
        auth_manager._sessions = {}
        client = TestClient(kairos.app)
        self.assertEqual(client.post("/api/auth/setup", json={"username": "cat", "password": "third-password-3"}).status_code, 200)
        client.post("/api/auth/login", json={"username": "cat", "password": "third-password-3"})
        self.assertEqual(client.get("/api/models/stats?days=0").status_code, 400)
        self.assertEqual(client.get("/api/models/stats?days=91").status_code, 400)
        body = client.get("/api/models/stats?days=30").json()
        self.assertEqual((body["days"], body["min_samples"], body["source"]), (30, 5, "runs"))

        async def overlay(**kwargs):
            return {"providers": [], "models": [{"id": "x1", "name": "X"}]}
        with patch.object(quota_usage, "get_usage_overlay_async", side_effect=overlay), \
             patch.object(model_stats, "stats", return_value={"endpoints": {"x1": {"runs": 7}}}):
            quotas = client.get("/api/models/quotas").json()
        self.assertEqual(quotas["models"][0]["stats"], {"runs": 7})


if __name__ == "__main__":
    unittest.main(verbosity=2)
