"""Cost per run (Session Usage and Model Tracking, unit 4, 2026-11-07).

What these prove, with fixture price lists and no network:
- an unknown model costs "unknown", never $0; unreported tokens are "unknown" too;
- a subscription (Claude Code, Codex, Antigravity) or a local model is "included", never $0;
- cache read and write are priced separately from fresh input;
- a provider-reported cost is "actual";
- price sources win in order: the connection's own /models list, OpenRouter's list, the bundled snapshot,
  and each figure names its source and date;
- a run's cost is stored when it is recorded, so a later price change does not rewrite it;
- the public price lists are parsed from OpenRouter's format, read at most once a day, and only when an API
  connection exists (a fake client stands in for the network).
"""
import asyncio
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

_DATA = TestDataDirectory("kairos-run-cost-")
os.environ["JARVIS_DATA_DIR"] = _DATA.name

import app as kairos  # noqa: E402,F401  (first, so the account layout settles before any store opens)
from core import model_prices, price_feeds, run_cost, runs, session_manager_store as store, session_usage  # noqa: E402

price_feeds.CACHE_FILE = os.path.join(_DATA.name, "feeds.json")
TOKENS = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 600_000, "cache_write_tokens": 100_000}
OPENROUTER_REPLY = {"data": [
    {"id": "openai/gpt-9", "pricing": {"prompt": "0.000002", "completion": "0.000008", "input_cache_read": "0.0000005"}},
    {"id": "anthropic/claude-opus-5-5", "pricing": {"prompt": "0.000005", "completion": "0.000025"}},
    {"id": "free/model", "pricing": {"prompt": "0", "completion": "0"}},
    {"id": "router/auto", "pricing": {"prompt": "-1", "completion": "-1"}},
    {"id": "no-pricing"},
]}


class Statuses(unittest.TestCase):
    def setUp(self):
        self.feeds = {}

    def test_unknown_model_is_unknown_never_zero(self):
        found = run_cost.cost({"model": "mystery-1", **TOKENS}, "api", feeds=self.feeds)
        self.assertEqual((found["cost_usd"], found["cost_status"]), (None, "unknown"))

    def test_unreported_tokens_are_unknown(self):
        found = run_cost.cost({"model": "claude-opus-5-5", "input_tokens": None, "output_tokens": None}, "api",
                              feeds=self.feeds)
        self.assertEqual((found["cost_usd"], found["cost_status"], found["cost_source"]),
                         (None, "unknown", "tokens not reported"))

    def test_subscription_and_local_are_included(self):
        for kind in ("claude_cli", "codex_cli", "antigravity_cli", "local"):
            found = run_cost.cost({"model": "claude-opus-5-5", **TOKENS}, kind, feeds=self.feeds)
            self.assertEqual((found["cost_usd"], found["cost_status"]), (None, "included"), kind)

    def test_cache_read_and_write_priced_separately(self):
        # claude-opus-5-5 snapshot: input 4, output 20, cache read 0.20, cache write 5 (1.25x) per million.
        found = run_cost.cost({"model": "claude-opus-5-5", **TOKENS}, "api", feeds=self.feeds)
        expected = (300_000 * 4 + 600_000 * 0.20 + 100_000 * 5 + 100_000 * 20) / 1_000_000
        self.assertAlmostEqual(found["cost_usd"], expected)
        self.assertEqual(found["cost_status"], "estimated")
        self.assertEqual(found["priced_as_of"], "2026-10-06")
        self.assertIn("Bundled snapshot", found["cost_source"])

    def test_reported_cost_is_actual(self):
        found = run_cost.cost({"model": "x"}, "api", reported=0.0042, feeds=self.feeds)
        self.assertEqual((found["cost_usd"], found["cost_status"]), (0.0042, "actual"))

    def test_bot_price_list_keeps_its_contract(self):
        tokens = dict(input=1000, output=100, cache_read=200, cache_write=0)
        self.assertAlmostEqual(model_prices.price("gpt-4.1-2025-04-14", tokens)["cost_usd"], .0025)
        self.assertEqual(model_prices.price("gpt-4.1-2025-04-14", tokens)["priced_as_of"], "2025-08-07")
        self.assertIsNone(model_prices.price("unlisted", tokens)["cost_usd"])
        self.assertTrue(all(model in model_prices.SNAPSHOT_META for model in model_prices.LIST_PRICES))


class Sources(unittest.TestCase):
    def test_order_endpoint_then_openrouter_then_snapshot(self):
        day = time.mktime((2026, 11, 6, 12, 0, 0, 0, 0, -1))
        feeds = {"https://my.host/v1": {"fetched_at": day, "models": {"claude-opus-5-5": {"input": 1.0, "output": 2.0}}},
                 price_feeds.OPENROUTER: {"fetched_at": day, "models": price_feeds.parse_models(OPENROUTER_REPLY)}}
        own = run_cost.rates_for("claude-opus-5-5", "https://my.host/v1/", feeds)
        self.assertEqual((own["rates"]["input"], own["source"], own["as_of"]), (1.0, "the connection's own price list", "2026-11-06"))
        router = run_cost.rates_for("claude-opus-5-5", "https://api.anthropic.com/v1", feeds)
        self.assertEqual((router["rates"]["input"], router["source"]), (5.0, "OpenRouter's price list"))
        bundled = run_cost.rates_for("claude-opus-5-5", None, {})
        self.assertEqual(bundled["rates"]["input"], 4.0)
        self.assertEqual(run_cost.rates_for("anthropic/claude-opus-5-5", None, {})["rates"]["input"], 4.0)
        self.assertIsNone(run_cost.rates_for("unlisted", None, feeds))

    def test_parse_openrouter_format(self):
        found = price_feeds.parse_models(OPENROUTER_REPLY)
        self.assertEqual(found["openai/gpt-9"], {"input": 2.0, "output": 8.0, "cache_read": 0.5})
        self.assertEqual(found["free/model"], {"input": 0.0, "output": 0.0})
        self.assertNotIn("router/auto", found, "-1 is unknown, not free")
        self.assertNotIn("no-pricing", found)


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload, self.status = payload, status

    def raise_for_status(self):
        if self.status >= 400:
            raise RuntimeError(f"HTTP {self.status}")

    def json(self):
        return self.payload


class FakeClient:
    def __init__(self):
        self.urls = []

    async def get(self, url, headers=None):
        self.urls.append((url, (headers or {}).get("Authorization")))
        if url == price_feeds.OPENROUTER_URL:
            return FakeResponse(OPENROUTER_REPLY)
        return FakeResponse({"data": [{"id": "local-thing"}]})


class Feeds(unittest.TestCase):
    def setUp(self):
        if os.path.exists(price_feeds.cache_file()):
            os.remove(price_feeds.cache_file())

    def test_no_api_connection_means_no_request(self):
        client = FakeClient()
        self.assertEqual(asyncio.run(price_feeds.refresh(client, connections=[])), {})
        self.assertEqual(client.urls, [])

    def test_reads_once_a_day_and_sends_keys_only_to_their_own_server(self):
        client = FakeClient()
        connections = [{"base_url": "https://my.host/v1", "api_key": "sk-mine"}]
        result = asyncio.run(price_feeds.refresh(client, connections))
        self.assertEqual(result, {price_feeds.OPENROUTER: 3, "https://my.host/v1": 0})
        self.assertEqual(client.urls, [(price_feeds.OPENROUTER_URL, None), ("https://my.host/v1/models", "Bearer sk-mine")])
        asyncio.run(price_feeds.refresh(client, connections))
        self.assertEqual(len(client.urls), 2, "not read again within a day")
        later = time.time() + price_feeds.REFRESH_SECONDS + 1
        asyncio.run(price_feeds.refresh(client, connections, now=later))
        self.assertEqual(len(client.urls), 4)


class Recorded(unittest.TestCase):
    def setUp(self):
        if os.path.exists(price_feeds.cache_file()):
            os.remove(price_feeds.cache_file())  # no live list: the bundled snapshot prices it

    def test_cost_is_stored_at_record_time(self):
        endpoint = {"id": "api-x", "kind": "api", "base_url": "https://api.example/v1"}
        context = runs.RunContext("chat", session_id="chat-cost", endpoint_id="api-x", model="claude-opus-5-5")
        tally = runs.Tally()
        tally.add(runs.usage_event({"prompt_tokens": 1000, "completion_tokens": 100}))
        with patch("core.model_endpoints.get_endpoint", return_value=endpoint):
            runs.record(context, tally, "finished")
        stored = store.get_run(context.run_id)
        self.assertEqual(stored["cost_status"], "estimated")
        self.assertAlmostEqual(stored["cost_usd"], (1000 * 4 + 100 * 20) / 1_000_000)
        before = stored["cost_usd"]
        with patch.dict(model_prices.LIST_PRICES, {"claude-opus-5-5": {"input": 99.0, "output": 99.0}}):
            usage = session_usage.for_session("chat-cost", {})
        self.assertAlmostEqual(usage["cost"]["total_usd"], before, msg="a later price change does not rewrite history")
        self.assertTrue(usage["cost"]["complete"])

    def test_mixed_chat_summary(self):
        rows = [{"cost_usd": 0.5, "cost_status": "estimated", "cost_source": "x", "priced_as_of": "2026-10-06"},
                {"cost_usd": None, "cost_status": "unknown"}, {"cost_usd": None, "cost_status": None}]
        summary = run_cost.summarize(rows)
        self.assertEqual(summary["total_usd"], 0.5)
        self.assertEqual(summary["statuses"], {"estimated": 1, "unknown": 1, "not_recorded": 1})
        self.assertFalse(summary["complete"])
        self.assertIsNone(run_cost.summarize([{"cost_status": "included"}])["total_usd"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
