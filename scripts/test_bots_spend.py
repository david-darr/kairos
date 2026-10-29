"""Monthly spend cap and once-only alerts, with a local ledger and fake clock."""
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_data_support import TestDataDirectory
_data = TestDataDirectory("kairos-spend-")
os.environ["JARVIS_DATA_DIR"] = _data.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI
from fastapi.testclient import TestClient
from core.middleware import require_admin
from routes.bot_usage_routes import router
from services import bot_usage, bot_spend


class SpendTests(unittest.TestCase):
    def setUp(self):
        bot_usage.drain()
        for p in bot_usage.ROOT.glob("*"): p.unlink()
        self.now = datetime(2026, 10, 15, tzinfo=timezone.utc).timestamp()
        self.ctx = SimpleNamespace(reported_cost_usd=8)
        self.row = dict(id="spend-run", agent_id="spend-bot", started_at=self.now - 1, ended_at=self.now,
                        model="unknown", outcome="finished")

    def test_zero_and_null_cap(self):
        self.assertFalse(bot_spend.check("spend-bot", self.now)["capped"])
        bot_usage.update_settings(budget={"monthly_usd": 0, "warn_percent": 80})
        with self.assertRaises(bot_spend.SpendCap) as raised: bot_spend.check("spend-bot", self.now)
        self.assertEqual((raised.exception.status_code, raised.exception.code), (409, "spend_cap"))

    def test_warn_once_cap_once_and_month_rollover(self):
        bot_usage.observe(self.row, [], self.ctx)
        bot_usage.update_settings(budget={"monthly_usd": 10, "warn_percent": 80})
        with patch("services.agent_service.agent_service.get", return_value={"id": "spend-bot", "owner_user": "alice"}), \
             patch("services.bot_attention.target_for", return_value={"tab": "botsShell"}), \
             patch("core.bot_attention_store.publish") as publish:
            bot_spend.check("spend-bot", self.now)
            bot_spend.check("spend-bot", self.now)
            self.assertEqual(publish.call_count, 1)
            bot_usage.observe({**self.row, "id": "spend-two"}, [], SimpleNamespace(reported_cost_usd=2))
            for _ in range(2):
                with self.assertRaises(bot_spend.SpendCap): bot_spend.check("spend-bot", self.now)
            self.assertEqual(publish.call_count, 2)
            november = datetime(2026, 11, 2, tzinfo=timezone.utc).timestamp()
            self.assertFalse(bot_spend.check("spend-bot", november)["capped"])
            bot_usage.observe({**self.row, "id": "nov", "started_at": november - 1, "ended_at": november}, [], self.ctx)
            bot_spend.check("spend-bot", november)
            self.assertEqual(publish.call_count, 3)

    def test_budget_bounds_unknowns_and_override_endpoint(self):
        app = FastAPI(); app.include_router(router)
        app.dependency_overrides[require_admin] = lambda: "alice"
        client = TestClient(app)
        self.assertEqual(client.put("/api/bot-usage/budget", json={"monthly_usd": -1}).status_code, 422)
        self.assertEqual(client.put("/api/bot-usage/budget", json={"monthly_usd": 20, "extra": True}).status_code, 422)
        self.assertEqual(client.put("/api/bot-usage/budget", json={"monthly_usd": None}).status_code, 200)
        rates = dict(input=1, output=2, cache_read=.1, cache_write=1.25)
        self.assertEqual(client.put("/api/bot-usage/prices", json={"prices_override": {"new": rates}}).status_code, 200)
        value = bot_usage.observe({**self.row, "model": "new", "input_tokens": 1000, "output_tokens": 100}, [], SimpleNamespace())
        self.assertAlmostEqual(value["cost_usd"], .0012)


if __name__ == "__main__": unittest.main()
