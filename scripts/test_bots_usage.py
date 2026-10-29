"""Isolated usage ledger, price and HTTP ownership checks. No provider calls."""
import asyncio
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_data_support import TestDataDirectory
_data = TestDataDirectory("kairos-bot-usage-")
os.environ["JARVIS_DATA_DIR"] = _data.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import runs, model_prices
from core.middleware import require_admin
from services import bot_usage
from routes.bot_usage_routes import router


def row(ident="one", **extra):
    return {"id": ident, "agent_id": "usage-bot", "model": "gpt-4.1-2025-04-14", "started_at": time.time() - 2,
            "ended_at": time.time(), "outcome": "finished", "input_tokens": 1000, "output_tokens": 100,
            "cache_read_tokens": 200, "cache_write_tokens": 0, "tool_calls": 3, **extra}


class UsageTests(unittest.TestCase):
    def setUp(self):
        bot_usage.drain()
        for file in bot_usage.ROOT.glob("*"):
            file.unlink()

    def test_prices_reported_estimated_unknown(self):
        tokens = dict(input=1000, output=100, cache_read=200, cache_write=0)
        value = model_prices.price("gpt-4.1-2025-04-14", tokens)
        self.assertAlmostEqual(value["cost_usd"], .0025)
        self.assertEqual(value["cost_source"], "estimated")
        self.assertEqual(model_prices.price("unlisted", tokens)["cost_usd"], None)
        self.assertEqual(model_prices.price("unlisted", tokens, 0)["cost_source"], "reported")
        self.assertEqual(model_prices.price("gpt-4.1-2025-04-14", {"input": None})["cost_usd"], None)

    def test_tally_keeps_numeric_model_call_and_record_observes(self):
        tally = runs.Tally()
        tally.add(runs.usage_event({"prompt_tokens": 1000, "completion_tokens": 100}))
        self.assertEqual(tally.timeline[0]["kind"], "model_call")
        context = runs.RunContext("chat", agent_id="usage-bot", model="unknown")
        runs.record(context, tally, "finished")
        self.assertEqual(next(bot_usage.rows())["run_id"], context.run_id)
        self.assertEqual(next(bot_usage.rows())["cost_usd"], None)

    def test_observation_never_breaks_record_and_is_off_loop(self):
        context = runs.RunContext("chat", agent_id="usage-bot")
        with patch("services.bot_usage.observe", side_effect=RuntimeError("disk full")):
            runs.record(context, runs.Tally(), "failed")
        async def enqueue():
            with patch("services.bot_usage._observe", return_value=None) as write:
                bot_usage.observe(row(), [], context)
                await asyncio.to_thread(bot_usage.drain)
                self.assertEqual(write.call_count, 1)
        asyncio.run(enqueue())
        with patch("services.bot_usage.ROOT", Path(_data.name) / "absent" / "bad"), patch("os.open", side_effect=OSError):
            self.assertIsNone(bot_usage.observe(row(), [], context))

    def test_summary_paging_dedup_and_range(self):
        for ident in ("one", "two", "one"):
            bot_usage.observe(row(ident), [], SimpleNamespace())
        self.assertEqual(bot_usage.summary()["totals"]["runs"], 2)
        self.assertAlmostEqual(bot_usage.summary()["totals"]["cost_usd"], .005)
        self.assertEqual(len(bot_usage.runs(limit=1)["rows"]), 1)
        with self.assertRaises(ValueError): bot_usage.bounds(0, 367 * 86400)
        with self.assertRaises(ValueError): bot_usage.bounds(float("nan"), time.time())
        with self.assertRaises(ValueError): bot_usage.summary(group_by="bogus")

    def test_admin_and_owner_filter_before_totals(self):
        bot_usage.observe(row(), [], SimpleNamespace())
        app = FastAPI()
        app.include_router(router)
        client = TestClient(app)
        with patch("core.middleware.auth_enabled", return_value=True):
            self.assertEqual(client.get("/api/bot-usage/summary").status_code, 401)
        with patch("core.middleware.get_current_user", return_value="member"), patch("core.middleware.auth_manager.is_admin", return_value=False):
            self.assertEqual(client.get("/api/bot-usage/summary").status_code, 403)
        app.dependency_overrides[require_admin] = lambda: "alice"
        with patch("services.agent_service.agent_service.get", return_value={"id": "usage-bot", "owner_user": "bob"}):
            self.assertEqual(client.get("/api/bot-usage/summary").json()["totals"]["runs"], 0)
        with patch("services.agent_service.agent_service.get", return_value={"id": "usage-bot", "owner_user": "alice"}):
            self.assertEqual(client.get("/api/bot-usage/summary").json()["totals"]["runs"], 1)
            self.assertEqual(client.get("/api/bot-usage/runs?limit=101").status_code, 422)
            self.assertEqual(client.get("/api/bot-usage/summary?from=bad").status_code, 400)

    def test_trace_allocation_group_folding_and_no_content(self):
        from services.bot_trace import spans, allocate
        items = [{"tokens": {"input": 100}}, {"tokens": {"output": 10}}, {"tokens": {"cache_read": 100}}]
        allocate(items, .12345)
        self.assertEqual(sum(s["cost_usd"] for s in items), .12345)
        self.assertGreater(items[0]["cost_usd"], items[1]["cost_usd"])
        timeline = [{"kind": "tool_finished", "name": "search", "at": 100 + i, "seconds": .2,
                     "detail": "secret tool output", "ok": True} for i in range(3)]
        built = spans({"run_id": "r", "at": 99, "cost_usd": .1}, timeline)
        self.assertEqual(built[0]["kind"], "tool_group")
        self.assertEqual(len(built[0]["children"]), 3)
        self.assertNotIn("secret", str(built))
        self.assertTrue(any(s.get("slowest") for s in built[0]["children"]))

    def test_child_runs_nest_and_foreign_children_are_hidden(self):
        from services import bot_trace
        from core import session_manager_store as store
        parent = runs.RunContext("chat", agent_id="usage-bot")
        child = runs.RunContext("task", agent_id="usage-bot", parent_run_id=parent.run_id)
        for context in (parent, child): runs.record(context, runs.Tally(), "finished")
        with patch("services.bot_usage.visible", return_value=True):
            tree = bot_trace.detail(parent.run_id, "alice")
            self.assertEqual(tree["children"][0]["id"], child.run_id)
        with patch("services.bot_usage.visible", side_effect=lambda r, u: r["run_id"] == parent.run_id):
            self.assertEqual(bot_trace.detail(parent.run_id, "alice")["children"], [])

    def test_csv_formula_guard(self):
        import csv, io
        bot_usage.observe(row(model=" =HYPERLINK(1)", endpoint_id="@formula"), [], SimpleNamespace())
        records = list(csv.DictReader(io.StringIO(bot_usage.csv_export())))
        self.assertTrue(records[0]["model"].startswith("'"))
        self.assertTrue(records[0]["endpoint_id"].startswith("'"))


if __name__ == "__main__": unittest.main()
