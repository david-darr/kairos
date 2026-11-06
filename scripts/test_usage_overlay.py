"""Isolated quota normalization, stale-state and route checks.
Run: .venv/Scripts/python.exe scripts/test_usage_overlay.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# A throwaway data directory: this suite must never touch the real data/ folder.
from test_data_support import TestDataDirectory
_fixture = TestDataDirectory("jarvis-usage-overlay-test-")
os.environ["JARVIS_DATA_DIR"] = _fixture.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import FastAPI
from fastapi.testclient import TestClient
from core import quota_usage
from core import middleware
from core.middleware import require_admin
from routes import model_routes


class QuotaUsageTests(unittest.TestCase):
    def setUp(self):
        quota_usage._cache.clear()
        quota_usage._retry_after.clear()

    def test_claude_current_and_fallback_shapes(self):
        data = {"limits": [
            {"kind": "session", "percent": 23.4, "resets_at": "2026-09-23T00:00:00Z"},
            {"kind": "weekly_all", "percent": 51, "resets_at": "2026-09-27T00:00:00Z"},
        ], "five_hour": {"utilization": 99, "resets_at": "2026-09-23T00:00:00Z"}}
        windows = quota_usage.parse_claude_usage(data)
        self.assertEqual([w["name"] for w in windows], ["5-hour", "Weekly"])
        self.assertEqual(windows[0]["used_percent"], 23.4)
        self.assertIsInstance(windows[0]["resets_at"], float)
        self.assertEqual(quota_usage.parse_claude_usage({"five_hour": {"utilization": 8}})[0]["used_percent"], 8)

    def test_codex_bucket_and_timestamp(self):
        data = {"rateLimits": {"rateLimitsByLimitId": {"codex": {
            "primary": {"usedPercent": 10, "windowDurationMins": 300, "resetsAt": 1_800_000_000},
            "secondary": {"usedPercent": 40, "windowDurationMins": 10080, "resetsAt": 1_900_000_000},
        }}}}
        windows = quota_usage.parse_codex_limits(data)
        self.assertEqual([w["name"] for w in windows], ["5-hour", "Weekly"])
        self.assertEqual(windows[1]["resets_at"], 1_900_000_000)
        self.assertEqual(quota_usage.parse_codex_limits({"rateLimitsByLimitId": {
            "spark": {"primary": {"usedPercent": 99, "resetsAt": 1_800_000_000}}
        }}), [])

    def test_cache_stale_and_no_credentials_in_errors(self):
        quota_usage._provider("claude", lambda: [{"name": "5-hour", "used_percent": 20, "resets_at": None}])
        quota_usage._cache["claude"]["checked"] -= quota_usage.REFRESH_SECONDS + 1
        result = quota_usage._provider("claude", lambda: (_ for _ in ()).throw(RuntimeError("secret-token")))
        self.assertTrue(result["stale"])
        self.assertNotIn("secret-token", str(result))
        self.assertEqual(result["windows"][0]["used_percent"], 20)

    def test_every_connected_model_is_listed_and_cli_account_is_read_once(self):
        endpoints = [
            {"id": "a1", "name": "API", "kind": "api", "model": "gpt-5", "base_url": "https://api.openai.com/v1?key=sk-secret", "has_api_key": True},
            {"id": "l1", "name": "qwen3", "kind": "local", "model": "qwen3:8b", "base_url": "http://localhost:11434/v1", "has_api_key": False},
            {"id": "c1", "name": "Claude Opus", "kind": "claude_cli", "model": ""},
            {"id": "c2", "name": "Claude Sonnet", "kind": "claude_cli", "model": "sonnet"},
            {"id": "x1", "name": "Codex", "kind": "codex_cli", "model": ""},
            {"id": "g1", "name": "Antigravity", "kind": "antigravity_cli", "model": ""},
        ]
        readings = {
            "claude": {"provider": "claude", "status": "ok", "windows": [{"name": "5-hour", "used_percent": 34, "resets_at": None}]},
            "codex": {"provider": "codex", "status": "needs_sign_in", "windows": [], "stale": True, "note": quota_usage.NOTES["needs_sign_in"]},
            "antigravity": {"provider": "antigravity", "status": "no_quota", "windows": [], "note": quota_usage.NOTES["no_quota"]},
        }
        totals = {"a1": {"fresh_tokens": 100, "cache_read_tokens": 900, "unsplit_tokens": 23, "total_tokens": 1023},
                  "g1": {"fresh_tokens": 5000, "cache_read_tokens": 0, "unsplit_tokens": 0, "total_tokens": 5000}}
        recent = {"l1": {"today_tokens": 12000, "week_tokens": 40000}, "g1": {"today_tokens": 0, "week_tokens": 5000}}
        with patch.object(quota_usage.model_endpoints, "list_endpoints", return_value=endpoints), \
             patch.object(quota_usage.token_usage, "get_usage_summary", return_value=totals), \
             patch.object(quota_usage.token_usage, "get_recent_usage", return_value=recent), \
             patch.object(quota_usage, "_provider", side_effect=lambda name, reader, force=False: readings[name]) as provider:
            result = quota_usage.get_usage_overlay()
        self.assertEqual(provider.call_count, 3, "one read per account, not per endpoint")
        self.assertEqual([p["provider"] for p in result["providers"]], ["claude", "codex"], "a ring only where a quota exists")
        models = result["models"]
        self.assertEqual([m["id"] for m in models], ["c1", "c2", "x1", "g1", "l1", "a1"], "subscriptions, then local, then API")
        by_id = {m["id"]: m for m in models}
        self.assertEqual([by_id[i]["status"] for i in ("c1", "x1", "g1", "l1", "a1")],
                         ["connected", "needs_sign_in", "connected", "connected", "connected"])
        self.assertEqual(by_id["c2"]["quota"]["windows"][0]["used_percent"], 34)
        self.assertEqual([by_id[i]["mark"] for i in ("c1", "x1", "g1", "l1", "a1")], ["claude", "openai", "gemini", "qwen", "openai"])
        self.assertIsNone(by_id["l1"]["quota"])
        self.assertIsNone(by_id["l1"]["provider"])
        self.assertEqual(by_id["g1"]["recorded"], {"today_tokens": 0, "week_tokens": 5000, "total_tokens": 5000})
        self.assertEqual(by_id["l1"]["recorded"], {"today_tokens": 12000, "week_tokens": 40000, "total_tokens": 0})
        self.assertEqual(by_id["a1"]["recorded"]["total_tokens"], 123, "cache reads stay out of the spend")
        for model in models:
            self.assertFalse({"base_url", "has_api_key", "api_key", "api_key_encrypted"} & set(model))
        self.assertNotIn("sk-secret", str(result))

    def test_unreadable_quota_marks_the_model_unavailable(self):
        endpoints = [{"id": "c1", "name": "Claude", "kind": "claude_cli", "model": ""}]
        with patch.object(quota_usage.model_endpoints, "list_endpoints", return_value=endpoints), \
             patch.object(quota_usage.token_usage, "get_usage_summary", return_value={}), \
             patch.object(quota_usage.token_usage, "get_recent_usage", return_value={}), \
             patch.dict(quota_usage.READERS, {"claude": ("claude_cli", lambda: (_ for _ in ()).throw(RuntimeError("secret-token")))}):
            model = quota_usage.get_usage_overlay()["models"][0]
        self.assertEqual(model["status"], "unavailable")
        self.assertEqual(model["recorded"], {"today_tokens": 0, "week_tokens": 0, "total_tokens": 0})
        self.assertNotIn("secret-token", str(model))

    def test_antigravity_without_windows_is_cached_and_still_listed(self):
        calls = []
        def reader():
            calls.append(1)
            raise quota_usage.NoQuotaReported()
        first = quota_usage._provider("antigravity", reader)
        self.assertEqual((first["status"], first["windows"]), ("no_quota", []))
        quota_usage._provider("antigravity", reader)
        self.assertEqual(len(calls), 1, "a CLI without a quota report is not re-asked every poll")

    def test_daily_buckets_give_today_and_this_week(self):
        from datetime import date
        from core import token_usage
        folder = Path(_fixture.name)
        with patch.object(token_usage, "DAILY_FILE", str(folder / "daily.json")), \
             patch.object(token_usage, "USAGE_FILE", str(folder / "totals.json")):
            token_usage.write_json_atomic(token_usage.daily_file(), {
                "2026-10-18": {"l1": 7}, "2026-10-19": {"l1": 10}, "2026-10-21": {"l1": 5, "a1": 2}, "2026-10-22": "bad"})
            self.assertEqual(token_usage.get_recent_usage(date(2026, 10, 21)),
                             {"l1": {"today_tokens": 5, "week_tokens": 15}, "a1": {"today_tokens": 2, "week_tokens": 2}},
                             "the week starts Monday, as on Home; a Sunday before it is not counted")
            token_usage.write_json_atomic(token_usage.daily_file(), {"2000-01-01": {"l1": 99}})
            token_usage.record_usage("l1", {"input_tokens": 40, "output_tokens": 10, "cache_read_input_tokens": 100})
            self.assertEqual(token_usage.get_recent_usage()["l1"], {"today_tokens": 50, "week_tokens": 50}, "cache reads are not counted")
            self.assertNotIn("2000-01-01", token_usage.read_json(token_usage.daily_file(), {}), "old days are pruned")

    def test_each_failure_says_what_kind_it_was_without_leaking_text(self):
        def refused():
            raise quota_usage.SignInNeeded("token abc123 expired")
        def limited():
            raise quota_usage.RateLimited("429 from https://internal.example/?t=abc123")
        def broken():
            raise RuntimeError("secret-token in a traceback")
        for reader, status in ((refused, "needs_sign_in"), (limited, "rate_limited"), (broken, "unavailable")):
            with self.subTest(status=status):
                quota_usage._cache.clear(); quota_usage._retry_after.clear()
                result = quota_usage._provider("claude", reader)
                self.assertEqual(result["status"], status)
                self.assertEqual(result["note"], quota_usage.NOTES[status])
                self.assertNotIn("abc123", str(result)); self.assertNotIn("secret-token", str(result))

    def test_a_click_reads_now_but_not_twice_in_a_row(self):
        calls = []
        def reader():
            calls.append(1)
            return [{"name": "5-hour", "used_percent": len(calls) * 10, "resets_at": None}]
        quota_usage._provider("codex", reader)
        self.assertEqual(quota_usage._provider("codex", reader)["windows"][0]["used_percent"], 10, "cached, not re-read")
        with self.assertRaises(quota_usage.RefreshThrottled):
            quota_usage._provider("codex", reader, force=True)
        quota_usage._cache["codex"]["checked"] -= quota_usage.FORCED_REFRESH_SECONDS + 1
        self.assertEqual(quota_usage._provider("codex", reader, force=True)["windows"][0]["used_percent"], 20)
        self.assertEqual(len(calls), 2)

    def test_refresh_route_rejects_unknown_providers_and_throttles(self):
        app = FastAPI()
        app.include_router(model_routes.router)
        app.dependency_overrides[require_admin] = lambda: "admin"
        with TestClient(app) as client:
            self.assertEqual(client.post("/api/models/quotas/refresh", json={"provider": "cursor"}).status_code, 400)
            with patch.object(quota_usage, "get_usage_overlay_async", side_effect=quota_usage.RefreshThrottled("claude")):
                self.assertEqual(client.post("/api/models/quotas/refresh", json={"provider": "claude"}).status_code, 429)

    def test_route_requires_admin(self):
        app = FastAPI()
        app.include_router(model_routes.router)
        with TestClient(app) as client:
            with patch.object(middleware, "auth_enabled", return_value=True):
                self.assertEqual(client.get("/api/models/quotas").status_code, 401)
            app.dependency_overrides[require_admin] = lambda: "admin"
            with patch.object(quota_usage, "get_usage_overlay_async", return_value={"providers": [], "models": []}):
                self.assertEqual(client.get("/api/models/quotas").json(), {"providers": [], "models": []})

    def test_route_lists_every_endpoint_kind_without_secrets(self):
        from core import model_endpoints
        app = FastAPI()
        app.include_router(model_routes.router)
        app.dependency_overrides[require_admin] = lambda: "admin"
        endpoints = [model_endpoints.create_endpoint("Grok", "https://api.x.ai/v1", "grok-4", api_key="xai-secret-key", kind="api"),
                     model_endpoints.create_endpoint("qwen3", "http://localhost:11434/v1", "qwen3:8b", kind="local"),
                     model_endpoints.create_endpoint("Antigravity", kind="antigravity_cli"),
                     model_endpoints.create_endpoint("Codex", kind="codex_cli"),
                     model_endpoints.create_endpoint("Claude", kind="claude_cli")]
        self.addCleanup(lambda: [model_endpoints.delete_endpoint(e["id"]) for e in endpoints])
        def signed_out():
            raise quota_usage.SignInNeeded("token abc")
        def no_quota():
            raise quota_usage.NoQuotaReported()
        readers = {"claude": ("claude_cli", lambda: [{"name": "5-hour", "used_percent": 10, "resets_at": None}]),
                   "codex": ("codex_cli", signed_out), "antigravity": ("antigravity_cli", no_quota)}
        with TestClient(app) as client, patch.dict(quota_usage.READERS, readers):
            response = client.get("/api/models/quotas")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual([m["kind"] for m in body["models"]], ["claude_cli", "codex_cli", "antigravity_cli", "local", "api"])
        self.assertEqual([m["status"] for m in body["models"]], ["connected", "needs_sign_in", "connected", "connected", "connected"])
        self.assertEqual([m["mark"] for m in body["models"]], ["claude", "openai", "gemini", "qwen", "grok"])
        self.assertEqual([p["provider"] for p in body["providers"]], ["claude", "codex"])
        for secret in ("xai-secret-key", "api.x.ai", "localhost:11434", "token abc", "api_key"):
            self.assertNotIn(secret, response.text)


class ModelMarkTests(unittest.TestCase):
    """Each added model shows its provider's logo, or none: a wrong logo is
    worse than the generic icon."""

    def test_provider_is_recognised_from_kind_model_and_host(self):
        from core.model_marks import mark_for
        cases = {
            "claude": [{"kind": "claude_cli"}, {"kind": "api", "base_url": "https://openrouter.ai/api/v1", "model": "anthropic/claude-3.5-sonnet"}],
            "openai": [{"kind": "codex_cli"}, {"kind": "api", "base_url": "https://api.openai.com/v1", "model": "gpt-5"}],
            "grok": [{"kind": "api", "base_url": "https://api.x.ai/v1", "model": "grok-4"}],
            "perplexity": [{"kind": "api", "base_url": "https://api.perplexity.ai", "model": "sonar-pro"}],
            "deepseek": [{"kind": "api", "base_url": "https://api.deepseek.com", "model": "deepseek-chat"}],
            "gemini": [{"kind": "api", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-pro"}],
            "meta": [{"kind": "local", "base_url": "http://localhost:11434/v1", "model": "llama3.1:8b"}],
            "qwen": [{"kind": "local", "base_url": "http://localhost:11434/v1", "model": "Qwen 3.8"}],
            "ollama": [{"kind": "local", "base_url": "http://localhost:11434/v1", "model": "mystery-model"}],
            "openrouter": [{"kind": "api", "base_url": "https://openrouter.ai/api/v1", "model": "vendor/unknown"}],
        }
        for mark, endpoints in cases.items():
            for endpoint in endpoints:
                with self.subTest(endpoint=endpoint):
                    self.assertEqual(mark_for(endpoint), mark)

    def test_no_match_is_no_logo_not_a_wrong_one(self):
        from core.model_marks import mark_for
        for endpoint in ({"kind": "api", "base_url": "https://example.com/v1", "model": "graphite"},
                         {"kind": "api", "base_url": "https://evilx.ai.example.com", "model": "helper"},
                         {"kind": "api", "base_url": "not a url", "model": ""}):
            with self.subTest(endpoint=endpoint):
                self.assertIsNone(mark_for(endpoint))

    def test_every_mark_has_its_logo_file_and_the_files_are_inert(self):
        from core.model_marks import MARKS
        folder = Path(__file__).resolve().parents[1] / "static" / "img" / "model-marks"
        self.assertTrue((folder / "NOTICE.md").exists())
        for mark in MARKS:
            with self.subTest(mark=mark):
                svg = (folder / f"{mark}.svg").read_text(encoding="utf-8")
                self.assertIn('fill="currentColor"', svg)
                self.assertNotRegex(svg.lower(), r"<script|on[a-z]+=|href=")

    def test_the_model_list_carries_each_models_mark(self):
        app = FastAPI()
        app.include_router(model_routes.router)
        app.dependency_overrides[require_admin] = lambda: "admin"
        endpoints = [{"id": "a", "name": "Grok", "kind": "api", "base_url": "https://api.x.ai/v1", "model": "grok-4"},
                     {"id": "b", "name": "Mine", "kind": "api", "base_url": "https://example.com", "model": "x"}]
        with TestClient(app) as client, patch.object(model_routes.model_endpoints, "list_endpoints", return_value=endpoints):
            self.assertEqual([e["mark"] for e in client.get("/api/models").json()], ["grok", None])


if __name__ == "__main__":
    unittest.main()
